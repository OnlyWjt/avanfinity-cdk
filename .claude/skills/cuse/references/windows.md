# Native windows and semantic controls

**macOS background-only policy:** legacy global input, foreground sessions,
focus, standalone window/UI mutations and caller-hiding captures are refused.
Use `open APP` (background launch), `window list`, `session open`, `observe`,
and `act`. Restore a bound window with `window_prepare`. The legacy mutation
examples below apply to Windows only; read-only queries remain available on Mac.

Read-only queries work on both platforms. MCP exposes `window_list`;
Windows `run_actions` also supports window focus/waits and semantic UI actions.
Mac `background_snapshot` includes AX observations and `background_run` adds
background actions. Standalone minimize/restore/maximize and UI tree queries
remain CLI operations; do not invent corresponding MCP tools. For persistent
CLI/MCP window sessions, use `readme sessions`: the explicit Mac restoration
operation is `act` with `window_prepare`, not a standalone window-restore tool.
Standalone mutations conflict with an active Cuse window session.

## Application Management

### Native accessible controls

When `ui` appears in the selected binary's help, inspect a window's accessible
controls to avoid guessing coordinates. Obtain its current ID from `window list`:

```text
cuse ui snapshot <window-id>
cuse ui wait <window-id> --automation-id qa_submit --state enabled
cuse ui set-value <window-id> --automation-id qa_input --file input.txt
cuse ui invoke <window-id> --name "Save" --automation-id SaveButton
cuse ui wait <window-id> --name "Saved" --state exists
```

Use names/IDs actually returned by snapshot; examples above are placeholders.
Names and automation IDs match exactly and case-sensitively; when both are
provided they must both match. Snapshot returns localized roles, names, IDs,
enabled/offscreen flags, depth and bounds. Bounds are native desktop LTRB:
**physical pixels on Windows, logical points on macOS**, as declared by
`coordinate_space`; neither is the scaled screenshot coordinate space. Prefer
semantic operations; for coordinate input use a fresh screenshot's pixel space.

`set-value` **replaces** the existing field value, bypassing the clipboard.
`invoke` requires the Windows Invoke pattern; checkboxes, custom widgets and some editors
may need visual clicks/keyboard input instead. Mutations require one enabled, onscreen match.
Mac read-only node offscreen flags are not visibility proof: use bounds and an
image to assess visibility. Do not select the first of multiple matches. `action_sent`
means the provider accepted the call; returned identity/state was observed before
dispatch. Verify the resulting screen or accessible status before continuing.

`ui wait` observes `exists`, `gone`, or `enabled` (Windows also checks onscreen;
Mac checks enabled status). The
window must already exist; use `window wait` first for a newly opening dialog.
Traversal defaults to depth 12, 500 nodes, 3000 ms. Adjust `--depth`, `--max-nodes`
or `--timeout-ms` for larger trees. A truncated snapshot is partial evidence:
actions and waits reject incomplete trees rather than claim uniqueness/absence.
Provider errors also do not prove absence. Timeouts bound traversal/polling and
configure native provider timeouts, but an in-flight provider call can overrun
the budget. UI Automation does not cover every custom/canvas interface or bypass
elevation; use screenshot-driven controls when the needed structure is absent.

### Native window controls

```powershell
cuse window list
cuse window minimize MyAgents
cuse window restore MyAgents
cuse window maximize MyAgents
cuse window focus MyAgents
cuse window wait MyAgents --state minimized --timeout-ms 3000
```

`window list` returns JSON with `id`, `title`, `process`, `state`, `visible` and
`is_frontmost`. Prefer current IDs (Windows `hwnd:...`, Mac numeric ID); never
invent them. IDs last only for the current window lifetime. Windows prioritizes
an exact title over process matches and returns candidate IDs on ambiguity.
Mac accepts exact ID/title/process matches and refuses collisions with a count;
use `window list` to choose an ID. On either platform the MyAgents main window
and its companion window are distinct targets.

Actions wait for the requested OS state and return `verified: true` with the new
window report, or an error after `--timeout-ms` (default 3000). Restore returns
normal size on Windows. Explicit focus brings the window forward. Minimize
does not quit the app, so MyAgents can keep executing the current Session.
State verification does not mean animations, dialogs, or page loading are done;
take a fresh screenshot before the next visual action. These standalone mutations are Windows-only; Windows UIA
bounds are physical pixels. Mac restoration uses the session action
`window_prepare` without activation.

`window wait` observes `exists`, `gone`, `foreground` (default), `minimized`,
`maximized`, or `normal` without sending input. A `gone` result has `window: null`.
Use an exact dialog title to wait for a newly opened window, or a current window
ID to wait for an existing one. Ambiguous selectors fail immediately. Windows timeout includes the last observed
state; Mac returns a timeout error, possibly with the last observation error. These window waits do not inspect controls,
network loading, or document content. Use `ui wait` for exposed control states
and screenshots for other outcomes.

In a Windows foreground workflow, to clear MyAgents from the workspace,
list windows, minimize its main window ID,
and continue with the target app. MyAgents Ball is a separate window. Minimized
MyAgents continues running the Session; do not immediately focus it again as part
of a generic loop. Restore/focus it when returning the desktop to the user.

```bash
cuse open "TextEdit"  # Mac: background launch
cuse window list
cuse apps
```

On Mac, `open APP` accepts an app name, bundle ID or .app path and launches
without requesting activation. Then select a window and open a background
session. A frontmost target returns `user_takeover` or pauses the session.
Cuse refuses foreground mode and standalone window/UI mutations on Mac;
use session actions, including `window_prepare` for restoration.

On Windows, use the process name from `apps` (e.g. `msedge`, `Notepad`) or a
distinctive window title. `focus` checks the actual foreground window and errors
if no matching window exists or Windows refuses activation. `open notepad.exe`
launches through the Windows shell; opening a document can show an application
chooser if no file association is configured. In native Save dialogs, use
Windows paths with backslashes (e.g. `C:\work\notes.txt`).
