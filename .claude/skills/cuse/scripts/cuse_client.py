r"""Standard-library Cuse client. No shell interpolation and no automatic retries.

Prefer v2 observe/act/capture using a session opened by the current binary.
Keep returned reports and original action/capture IDs after uncertainty.
Legacy snapshot/run/background methods remain for compatible callers; global
run is Windows-only in current Mac-background-only builds.
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

    @staticmethod
    def _integer(value, low, high, name):
        if type(value) is not int or not low <= value <= high:
            raise ValueError(f'{name} must be an integer in {low}..{high}')
        return value

    def _session_call(self, command, session, *args, timeout=30, recovery=None):
        """No retry or implicit renew/resume. Errors retain the parsed response.
        On timeout the Host may still be working; query the original identifier.
        """
        session = str(Path(session).expanduser().resolve(strict=True))
        try:
            result = subprocess.run([self.binary, command, '--session', session, *args],
                                    capture_output=True, encoding='utf-8', timeout=timeout,
                                    creationflags=self.flags, check=False)
        except (subprocess.TimeoutExpired, KeyboardInterrupt) as exc:
            raise CuseError('Transport interrupted; query the original ID. Do not replay.',
                            {'outcome': 'unknown', 'recovery': recovery}) from exc
        return self._decode(result.stdout, result.stderr, result.returncode)

    def observe(self, session, *, scope=None, image=True, compact=True):
        args = []
        if not image:
            args.append('--no-image')
        if compact:
            args.append('--compact')
        if scope is not None:
            if not isinstance(scope, str) or not scope:
                raise ValueError('scope must be a current observed ref')
            args += ['--scope', scope]
        return self._session_call('observe', session, *args)

    def act(self, session, *, action_id, observation_id, actions, timeout_ms=5000):
        self._integer(timeout_ms, 100, 300000, 'timeout_ms')
        if not isinstance(action_id, str) or not action_id or not isinstance(observation_id, str) or not observation_id:
            raise ValueError('action_id and observation_id must come from this session')
        if not isinstance(actions, list) or not 1 <= len(actions) <= 256:
            raise ValueError('actions must contain 1..256 operations')
        plan = dict(version=2, action_id=action_id, observation_id=observation_id,
                    timeout_ms=timeout_ms, actions=actions)
        encoded = json.dumps(plan, ensure_ascii=False, allow_nan=False)
        if len(encoded.encode('utf-8')) > 2 * 1024 * 1024:
            raise ValueError('plan exceeds 2 MiB')
        # Static syntax/action validation remains the binary's single authority.
        check = subprocess.run([self.binary, 'act', '--dry-run', '--json', encoded],
                               capture_output=True, encoding='utf-8', timeout=10,
                               creationflags=self.flags, check=False)
        self._decode(check.stdout, check.stderr, check.returncode)
        return self._session_call('act', session, '--json', encoded, '--brief',
                                  timeout=timeout_ms / 1000 + 15,
                                  recovery={'command': 'action-status', 'action_id': action_id})

    def capture(self, session, *, capture_id, observation_id, region, dy,
                max_pages=8, timeout_ms=120000, settle_ms=500):
        if (not isinstance(capture_id, str) or not 1 <= len(capture_id) <= 128
                or not all(c.isascii() and (c.isalnum() or c in '-_.') for c in capture_id)):
            raise ValueError('capture_id must contain 1..128 ASCII letters/digits/-_.')
        if not isinstance(observation_id, str) or not 1 <= len(observation_id) <= 512:
            raise ValueError('observation_id must come from the current session')
        if not isinstance(region, (tuple, list)) or len(region) != 4:
            raise ValueError('region must be observed image-pixel XYWH')
        for i, v in enumerate(region):
            self._integer(v, 0 if i < 2 else 32, 2**32-1, 'region')
        if region[0] + region[2] > 2**32-1 or region[1] + region[3] > 2**32-1:
            raise ValueError('region overflows')
        self._integer(dy, -10000, 10000, 'dy')
        if not dy:
            raise ValueError('dy must be nonzero')
        self._integer(max_pages, 1, 32, 'max_pages')
        self._integer(timeout_ms, 1000, 300000, 'timeout_ms')
        self._integer(settle_ms, 100, 3000, 'settle_ms')
        return self._session_call('capture', session, '--id', capture_id,
            '--observation', observation_id, '--region', *map(str, region),
            '--dy', str(dy), '--max-pages', str(max_pages), '--timeout-ms', str(timeout_ms),
            '--settle-ms', str(settle_ms), timeout=timeout_ms / 1000 + 15,
            recovery={'command': 'capture-status', 'capture_id': capture_id})

    def capture_status(self, session, capture_id):
        return self._session_call('capture-status', session, '--id', capture_id)

    def renew(self, session, *, lease_secs=600):
        """Explicit opt-in only. Does not resume a paused session or replay work."""
        self._integer(lease_secs, 10, 1800, 'lease_secs')
        path = str(Path(session).expanduser().resolve(strict=True))
        result = subprocess.run([self.binary, 'session', 'renew', '--session', path,
                                 '--lease-secs', str(lease_secs)], capture_output=True,
                                encoding='utf-8', timeout=15,
                                creationflags=self.flags, check=False)
        return self._decode(result.stdout, result.stderr, result.returncode)
