# macOS background window plans

Cuse controls supported Mac apps in the background without focus, global input
or clipboard paste. Unsupported Cuse operations return errors.
Different windows of the same app share keyboard focus and app state;
user activation of that app stops the run.

1. `cuse window list` (MCP: `window_list`) finds window IDs without activation.
2. `cuse background snapshot WINDOW_ID` (MCP: `background_snapshot`) returns
   `observation` with image `.file`, `.frame`, `.image_size`, plus a bounded `.ui`
   tree. Read the image and tree; copy the **entire fresh observation.frame**.
3. `cuse background run --file plan.json` (MCP: `background_run {"plan":...}`)
   runs one bounded plan, holds an app-scoped OS lock, stops on first failure,
   and returns partial records and the last successful observation.

Example (replace FRAME with the returned object, not a guessed ID):

```json
{
  "version": 1,
  "frame": "FRAME",
  "preview": true,
  "timeout_ms": 60000,
  "actions": [
    {"op":"set_value","automation_id":"editor-id","text":"Hello 世界"},
    {"op":"invoke","name":"Save"},
    {"op":"snapshot"}
  ]
}
```

The placeholder string above is intentionally not executable. `frame` must be
an object with `window_id`, `pid`, `process_started`, and `bounds` from capture.
`--dry-run` validates without sending input. Relative file paths resolve beside
the plan; MCP relative paths resolve against the server's cwd.

## Plan and result contract

Required: `version:1`, a fresh `frame` object, and `actions` (1..256). Optional:
`preview:true`, `timeout_ms:60000` (100..300000), `cancel_file`, `pause_file`.
Plan JSON is at most 2 MiB; the normalized plan including text-file contents must fit the 2 MiB control frame (16 KiB reserved for framing). Each text is at most 64 KiB, without NUL. Dry-run checks this before opening a session. Unknown fields
and malformed actions refuse before native input. `--dry-run` is static validation;
it cannot prove permissions, app event acceptance, live identity or key support.

Output: `ok`, `process_id`, `mode`, `elapsed_ms`, `completed`, `records`,
`observation`, `error`. Each attempted action has zero-based `index`, `ok`, and
`result` or `error`; unattempted actions are omitted. `completed` counts successful
actions, not business outcomes. `observation` is the last successful capture
(or null) and can predate an uncertain mutation. CLI failure exits 1; MCP failure
sets isError. Inspect current app state before continuing; do not replay a plan.

## Actions

| op | Fields | Meaning |
|---|---|---|
| snapshot | none | Capture bounded AX tree and window image |
| invoke | name and/or automation_id | Fresh unique AXPress control; prefer over coordinates |
| set_value | name and/or automation_id, exactly one text/file | Replace writable AXValue, verify readback; no clipboard |
| wait | name and/or automation_id, required state (exists/enabled/gone), required timeout_ms (100..30000) | Unique exists/enabled/gone condition; truncated tree refuses |
| click | required at; button (default left), count (default 1, range 1..3) | Directed click at local logical point |
| move | at | Directed pointer move; physical cursor stays put. Verify the hover effect separately, especially in Safari/WebKit. |
| scroll | at, dx, dy | Pixel deltas: positive dy up, negative down; max magnitude 10000 |
| drag | from, to, duration_ms | Directed left-button path; duration 1..30000, cooperative cleanup |
| type | text | Unicode event delivery to target's existing focused window/control |
| key | combo | Directed key/shortcut; special keys, digits, punctuation aliases and ANSI key positions |
| pause | ms | Bounded delay, at most 30000 ms, remains cancellable |

For example, waiting for a known control to become enabled uses the selector
fields directly on the action (there is no nested `selector` object):

```json
{"op":"wait","automation_id":"save-button","state":"enabled","timeout_ms":3000}
```

All other action fields in the table are required; selectors require at least
one of `name` / `automation_id`. `name` and `automation_id` are exact, combined when both supplied. Missing or
ambiguous controls are not clicked. AX `set_value` replaces text; it is not a
keystroke stream. Verify application behavior (including web change/submit events).

**Coordinates are window-local logical points**, origin top-left including title
bar. If identifying points in the image, convert x * frame.bounds[2]/image_size[0]
and y * frame.bounds[3]/image_size[1]. AX bounds use desktop logical points in
[left, top, right, bottom]; subtract frame.bounds[0:2] for local coordinates.
Neither is the existing full-desktop screenshot coordinate space.

## Human controls and concurrency

Preview defaults on: a nonactivating native panel shows target captures and a blue
virtual pointer. Pause toggles this run; Stop or closing the panel cancels it. It
closes when the run ends. `preview:false` avoids intermediate image captures;
explicit snapshot actions and the final image remain available.

A caller may supply `cancel_file` and `pause_file`. Creating cancel_file cancels;
creating pause_file pauses, removing it resumes. Timeouts continue while paused.
The Python client uses cooperative cancellation on interruption before forced kill.

The app lock spans one plan, including waits and pauses. Same-app Cuse plans/UI
mutations refuse `app_busy`; different apps can run in parallel. Locks release on
process exit. There is no cross-turn reservation or persisted accessibility index.
User activation of the target app stops the run (`user_takeover`), even while
paused; changed geometry/process/window returns `stale_window`. Capture a new
frame and inspect completed actions before deciding how to continue.

## Honest boundaries

- `action_sent` is delivery, not proof the target handled input. Observe the result.
  Some inactive controls reject first mouse; custom canvas/apps may ignore events.
- Background typing requires the captured window to remain the app's focused
  window. Prefer AX set_value when possible. Cmd+C/V/X and system switching
  shortcuts are rejected; there is no background clipboard fallback.
- Hidden/minimized/off-current-desktop windows are explicitly unsupported here.
  Use v2 window_prepare for supported restoration. Focusing and unlocking the Mac are unavailable.
- App-scoped locks coordinate Cuse, not humans or other automation tools. A target
  app may itself activate another app/modal; background mode is not a VM/session.
- Cancellation is cooperative between native calls. Hard kill can lose the final
  report and a pending button release; do not treat transport loss as success.
- Windows retains existing foreground/window/UI workflows; background commands
  return platform_unsupported. Do not feed Mac frames to desktop batch commands.

## Application compatibility

- Native AppKit controls: prefer `invoke` and `set_value`. Directed mouse events
  require the control to accept inactive clicks; delivery alone is not acceptance.
- TextEdit: native typing can invoke autocorrection and suggestion panels. If a
  suggestion blocks further editing, inspect it and explicitly send `key: escape`.
  Use AX `set_value` for exact replacement, then verify the application value.
- Chrome: normal inactive webpage coordinate clicks can be ignored. Prefer AX
  controls; webpage AX exposure and refresh also depend on Chrome's renderer.
  Fully covered windows can update the DOM while retaining a stale AX value.
  `ui_result_unverified` means the write **may already have happened**; never retry
  it blindly. A fresh Cuse process does not repair a browser-side stale AX mirror.
- For an agent-owned Chrome instance, a separate profile launched with
  `--force-renderer-accessibility --disable-backgrounding-occluded-windows`
  passed background AX replacement, button invocation, and directed scrolling.
  The latter is a Chromium testing switch, not a portable production guarantee.
  Do not restart the user's browser or change their profile to enable this mode.
  Prefer a dedicated browser skill for web workflows when available.

The preview updates its image after actions and moves its virtual pointer during
input. It is not a video stream or a second macOS desktop. It does not prevent
applications from throttling rendering when covered. See
`MACOS_BACKGROUND_REPORT.md` in the source repository for tested configurations.

### Legacy plan lifetime

`background run` and MCP `background_run` now execute in a short Host session. The Host owns the App lease and window badge; the optional preview remains available. Each call ends the short session after the plan returns or fails. Stop, timeout, client exit and MCP cancellation/EOF stop its worker; already queued application effects cannot be rolled back. A plan is never replayed automatically. Paths in a CLI plan are relative to that plan file; MCP paths are relative to the MCP launch directory. Text files are read before dispatch, so the Host does not reinterpret them. Re-capture after a stale frame, inspect partial results after failure, and use v2 sessions when you need a continuing workflow.

Host errors preserve `code`, `mutation_dispatched`, `retry_read_allowed` and `replay_write_allowed` in both CLI and MCP. `stale_target` (Host/native binding) and `stale_window` (legacy frame checks) both require a fresh capture; neither allows replay of an uncertain write.
