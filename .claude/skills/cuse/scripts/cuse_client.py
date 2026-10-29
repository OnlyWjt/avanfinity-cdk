r"""Standard-library Cuse client. No shell interpolation and no automatic retries.

from cuse_client import Cuse, CuseError
cuse = Cuse(r'C:\work\MyAgents-Cuse\dist\cuse.exe')
shot = cuse.snapshot(display=2)
report = cuse.run([{'op': 'move', 'at': [200, 200]}],
                  display=2, source=shot['frame'])
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile


class CuseError(RuntimeError):
    """Inspect report.records before deciding what to do; never replay blindly."""
    def __init__(self, message, report=None):
        super().__init__(message)
        self.report = report


class Cuse:
    def __init__(self, binary):
        self.binary = str(Path(binary).expanduser().resolve(strict=True))
        self.flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0

    @staticmethod
    def _decode(output, error, code):
        try:
            report = json.loads(output)
        except (json.JSONDecodeError, UnicodeError) as exc:
            raise CuseError(f'No valid result (exit {code}); outcome unknown. {error}') from exc
        if not isinstance(report, dict):
            raise CuseError('Unexpected result; outcome unknown.')
        if code or report.get('ok') is False:
            detail = report.get('error')
            message = detail.get('message') if isinstance(detail, dict) else None
            raise CuseError(message or f'Cuse exit {code}; inspect partial report.', report)
        return report

    def snapshot(self, display=None):
        args = [self.binary, 'screenshot']
        if display is not None:
            args += ['--display', str(display)]
        try:
            result = subprocess.run(args, capture_output=True, encoding='utf-8',
                                    timeout=30, creationflags=self.flags, check=False)
        except subprocess.TimeoutExpired as exc:
            raise CuseError('Screenshot timed out') from exc
        return self._decode(result.stdout, result.stderr, result.returncode)

    def window_snapshot(self, window):
        try:
            result = subprocess.run([self.binary, 'background', 'snapshot', str(window)],
                                    capture_output=True, encoding='utf-8', timeout=30,
                                    creationflags=self.flags, check=False)
        except subprocess.TimeoutExpired as exc:
            raise CuseError('Window snapshot timed out') from exc
        return self._decode(result.stdout, result.stderr, result.returncode)

    def background(self, actions, *, frame, **options):
        """Mac: bounded background plan. Coordinates are window-local logical points.
        Use a fresh window_snapshot()['observation']['frame']; no implicit focus.
        """
        return self._run_plan(actions, background=True, frame=frame, **options)

    def run(self, actions, **options):
        return self._run_plan(actions, background=False, **options)

    def _run_plan(self, actions, *, background, **options):
        """Run one batch. Options match batch JSON. Relative text/cancel paths
        resolve from the caller's cwd, before the temporary plan is created.
        Native/provider calls may exceed the cooperative timeout. Transport loss
        or hard termination raises CuseError with no report (unknown outcome).
        """
        plan = json.loads(json.dumps(dict(version=1, actions=actions, **options),
                                     ensure_ascii=False, allow_nan=False))
        for action in plan['actions']:
            if action.get('op') in ('type', 'ui_set_value', 'set_value') and action.get('file') is not None:
                action['file'] = str(Path(action['file']).resolve())
        if plan.get('pause_file'):
            plan['pause_file'] = str(Path(plan['pause_file']).resolve())
        with tempfile.TemporaryDirectory(prefix='cuse-plan-') as directory:
            folder = Path(directory)
            cancel = Path(plan['cancel_file']).resolve() if plan.get('cancel_file') else folder/'cancel'
            plan['cancel_file'] = str(cancel)
            path = folder/'plan.json'
            path.write_text(json.dumps(plan, ensure_ascii=False, allow_nan=False), encoding='utf-8')
            command = [self.binary, 'background', 'run'] if background else [self.binary, 'batch']
            process = subprocess.Popen([*command, '--file', str(path)],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       encoding='utf-8', creationflags=self.flags)
            try:
                output, error = process.communicate(timeout=plan.get('timeout_ms', 60000)/1000 + 30)
            except (subprocess.TimeoutExpired, KeyboardInterrupt) as exc:
                # Request cleanup before resorting to process termination.
                try:
                    cancel.touch(exist_ok=True)
                    output, error = process.communicate(timeout=10)
                except (OSError, subprocess.TimeoutExpired, KeyboardInterrupt):
                    process.kill()
                    process.communicate()
                    raise CuseError('Transport interrupted; forced stop, outcome and input cleanup unknown.') from exc
                if isinstance(exc, KeyboardInterrupt):
                    try:
                        report = json.loads(output)
                    except json.JSONDecodeError:
                        report = None
                    raise CuseError('Cancelled by caller; inspect partial results.', report) from exc
            return self._decode(output, error, process.returncode)
