# Bundle location and permissions

## Use the matching executable

A complete Cuse Skill bundle contains `package.json`, `SKILL.md`, references and
`scripts/cuse` (macOS launcher) or `scripts/cuse.exe` (Windows x64). The Mac
launcher executes the adjacent signed `Cuse.app/Contents/MacOS/cuse` Universal
executable; retain the entire App bundle. Metadata records
the entrypoint relative to the package root. Keep the directory structure intact.

Use the matching binary's absolute path. When MyAgents projects the Skill into a
runtime-specific directory, it must supply the executable's stable absolute path
or preserve the package's relative files. Resolve `scripts/cuse` from the package
root, not the working directory; on Windows use `scripts/cuse.exe`. If the host
supplies neither a usable entry nor the complete package, report it and stop.
Never guess an app resource directory, search PATH or use another installation.

Replace the example path with that absolute entry. Keep the quotes, including for
paths with spaces. PowerShell also needs `&` to call a quoted path:

```bash
"/absolute/path/to/cuse/scripts/cuse" info
```

```powershell
& 'C:\absolute\path\to\cuse\scripts\cuse.exe' info
```

The manuals show arguments such as `window list` or `readme sessions`; append
them to the same quoted absolute entry in each call. No PATH entry or persistent
shell variable is needed. Use `--help` and `schema` to discover supported commands.

MyAgents distributes a complete bundle with its client. Its build pipeline consumes
the public bundle feed; the running Agent does not check feeds or update binaries.
For standalone use, obtain and replace the whole platform Skill ZIP. A missing
binary or platform mismatch is an incomplete/wrong bundle: report it for repair;
do not run an installer or silently substitute another version. Windows users need
no Python to call the CLI; the optional Python client requires Python separately.

When explicitly developing/testing Cuse from source, use repository `dist/cuse`
or `dist/cuse.exe` after the native build. This is the development exception, not
a packaged-user installation path. `readme` comes from that binary's compile-time
Skill; a local development version number alone does not prove feature identity.
For Mac badge accessibility, launch behavior and permission acceptance, use the
complete locally built `Cuse.app`, just as a packaged user does. A bare development
binary can exercise CLI/session behavior but lacks the App launch context needed
for the badge's accessibility tree; it is not full native presentation acceptance.

`info` returns version, source_commit, source_dirty, target, local protocol
version, build_id and compiled backends without accessing the desktop. Unknown
source identity is null, not a clean release. build_id is a compatibility
fingerprint, not an artifact hash or signature. Compare signed bytes with the
package manifest when checking a release. Compiled backends still require runtime
permissions and target support; observe a target to discover native actions.

The independent MCP bundle uses root `cuse-mcp` with the same relative executable
path and metadata `args: ["mcp"]`. Its server exposes detailed references through
`computer_use_readme`; it does not require a separate CLI Skill installation.

## Policy refusals and recovery

Read errors in this order, for both CLI and MCP:

1. A non-null `policy` overrides `code` and permission hints for recovery.
   `policy: "background_only"`, `reason: "foreground_disabled"` means Mac Cuse
   refused foreground control, global input, focus or caller-hiding capture.
   This is a Cuse capability limit, not missing OS access; `doctor --fix` cannot
   enable it. A frontmost target returns `user_takeover` or pauses the session.
   For an unknown policy, stop the affected Cuse operation and report it.
2. Without `policy`, a legacy `background_only:` message identifies the same Cuse
   capability limit. `reason` alone does not override `code`.
3. Otherwise follow `code` and the error context. For `permission_denied`, use
   `doctor` only when the error identifies missing OS access. An MCP session
   ownership error requires the owning connection, not new OS permissions.

Policy metadata does not erase earlier effects. If a result may have been sent,
query its original action ID and inspect the application before further input.

## Permissions

Pass `doctor`, `doctor --deep` or `doctor --fix` to the same absolute entry.

`doctor` returns JSON permission/display/desktop checks and the same build identity.
Top-level `ok: true` and exit code 0 mean the diagnostic report was produced;
check `ready` for baseline readiness. `checks.desktop.status` distinguishes
`interactive`, `locked`, and `unavailable`. Permissions can remain granted while
locked. Wait for the user's interactive desktop; do not try to unlock it or infer
that re-granting permissions fixes a lock. `ready: true` still does not prove a
particular App/control supports your task: observe the target.
`--deep` also tests display capture; unavailable/locked desktop or missing capture
permission produces per-display failures without capturing. Failed/empty displays
or failed deep probes make `ready` false. Mac needs Screen Recording and Accessibility for desktop automation;
the packaged App's `--fix` asks its native Host to show missing permission prompts
and opens the relevant settings. The user must grant access, then rerun `doctor`.
Follow the OS indication
of which host/process needs permission, and restart that host if required.
The packaged Mac Host starts the exact adjacent App in the background through
Launch Services. Its permissions may differ from those of the terminal or Agent
that called the CLI. For a packaged app, `checks.execution` reports the actual
Host worker's Accessibility and Screen Recording preflight. `ready` requires
both the caller checks and those execution checks. A Host transport or build
error reports `unavailable` and keeps `ready` false. Grant permission to the
process named by macOS; a successful caller-side check does not grant access to
the Host worker.
A missing binary is a packaging problem, not a desktop permission problem.
