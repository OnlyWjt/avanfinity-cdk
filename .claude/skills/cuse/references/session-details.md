# Session reference: observations, actions and recovery

Use a session to control one application's window across CLI calls or MCP tools.
The user works in another App; entering the controlled App pauses automation.
A session lasts 10 minutes unless renewed; `--lease-secs` accepts 10..1800.
Stop ends the lease. Resume never repeats the cancelled action.

## CLI

```sh
cuse window list
cuse session open WINDOW_ID
cuse observe --session SESSION_FILE
```

Replace WINDOW_ID with the returned current ID. Open returns
`result.session_file` and `result.status` (session_id, next_sequence, state).
Pass that private file to subsequent commands; do not copy its bearer token
into a report. Observation returns `result.id`, `.target`, `.bounds`,
`.geometry_revision`, `.tree.nodes` and optional `.image.file`.
Read the image using your image-reading tool. For semantic-only work use
`observe --no-image`; `--scope ELEMENT_REF` expands one known subtree.

On Mac, opening a hidden/minimized target refuses with `target_transition_required`.
When restoration is authorized, use `session open WINDOW_ID --allow-restore`.
The returned status records visibility changes in `transitions`. Restoration
does not authorize foreground activation and applies only while opening.
If a live Mac session later loses its renderable state, explicitly send a plan
containing only `{"op":"window_prepare"}` without `expect`, using the last valid
observation ID. A fresh `observe --no-image` may work for minimized windows, but
some hidden third-party apps temporarily remove their AX window and cannot be
observed until restored. If no valid observation remains, stop and open a new
session with `--allow-restore` only when authorized. The action prepares the
current proven interaction window, never an arbitrary named window. An attached
sheet is eligible only while its native identity remains available; a hidden
modal whose identity disappeared is refused. Its receipt reports before/after
states and whether a transition was dispatched; already-visible state is a
verified no-op. Any transition invalidates old refs/images. Observe a new image before
further input. This action leaves the restored window visible: it does not
silently re-hide/minimize afterwards or bypass user-takeover pause. It uses the
normal action ID/receipt contract; uncertain results must not be replayed.
Windows `window_prepare` can verify an already visible, nonminimized window;
it refuses hidden/minimized restoration until a nonactivating path is verified.
UIA semantic-only tasks may remain available without changing visibility.

Window titles and diagnostic messages are display text and may end with
`[truncated]` when unusually large. An over-budget interaction_root.role is empty
and listed in interaction_root.unknown_fields; it is not a proven empty role.
Target identity, selector fields and value readback are never truncated into a
usable match. Oversized node facts are omitted and marked unknown instead.

Each node has an opaque `ref`, optional `parent_ref`, role, name, automation_id,
value, enabled state and supported native actions. Absent optional fields mean
unknown/unavailable; absent parent_ref is a root, absent actions is an empty list.
`unknown_fields` calls out failed or budget-limited reads. Never equate a missing
value/name with an empty string or a failed tree read with an absent control.
Use an observed ref for duplicate labels. A selector combines exact role/name/
automation_id and optional within_ref. Never guess a ref or a window ID.

For repeated observation, `--baseline OBSERVATION_ID` (MCP `baseline`) returns
`tree.delta` when smaller. It names `base_observation_id`, `ref_prefix`,
`node_count`, and changed `updates[{index,node}]`. Reconstruct the tree by copying
that baseline's rows, replacing the old observation-ID prefix in **ref and
parent_ref only** with ref_prefix, applying updates by zero-based index, then
truncating to node_count. These are presentation rows, not persistent native
element IDs. `unchanged:true` means the serialized tree did not change; it does
not prove the image or business state is unchanged. The current observation ID
and freshly rebased refs address the current native snapshot. Omitting baseline
always returns full nodes. Expired refs, a changed scope/geometry/modal root, or
an incomplete tree return full nodes and `baseline_fallback`; continue from that
new snapshot. Three recent baselines are retained, including action observations.

Submit an action plan using `act --session SESSION_FILE --file plan.json`.
For a short call, `--json 'JSON'` accepts the same plan without a file.
`act --dry-run --file plan.json` validates the plan without a session or desktop
access. It checks syntax and bounds, not current refs, capabilities or effects.
The following is a template: substitute the current IDs before execution.

```json
{
  "version": 2,
  "action_id": "SESSION_ID:1",
  "observation_id": "OBSERVATION_ID",
  "timeout_ms": 5000,
  "actions": [{
    "op": "set_value",
    "target": {"ref": "ELEMENT_REF"},
    "text": "Hello world 🧪",
    "expect": {
      "kind": "value_equals",
      "target": {"ref": "ELEMENT_REF"},
      "value": "Hello world 🧪"
    }
  }]
}
```

Use the session's next_sequence, not always 1. For exact arguments of one action,
use `cuse schema --action replace_text` (substitute the needed action).
`cuse schema` prints the full plan schema only when needed for integration.
Actions are bounded to 256, total budget to 300 seconds and JSON to
2 MiB. Text is at most 64 KiB with no NUL. Plan actions stop at the first failure;
subsequent records are `not_started`.

## Actions and result strength

- `invoke {target}` dispatches a native control action. Add an `expect` or observe
  again to prove the application outcome; dispatch alone does not prove a click.
- `set_value {target,text}` replaces a writable value and checks readback.
  Reactive editors may need real input events even when the native value is
  writable; verify dependent UI or saved content, not only the field value.
  Protected fields accept supported writes without exposing their value; the
  receipt stays `dispatched`. Do not request text selection or value readback there.
- `toggle {target,checked}` requests a checkbox state; already-correct state is
  verified without a click. At most one native toggle is sent. If a tri-state
  control lands on `mixed`, observe before deciding another action.
- `select {target}` selects a native item; readback proves that item is selected.
  The native provider determines whether other items remain selected.
- `expand {target,expanded}` expands or collapses a control and checks its state.
- `set_range_value {target,value}` sets a numeric control within its reported
  `state.range` and checks the exact readback. Out-of-range values refuse.
- `scroll_into_view {target}` dispatches a supported native scroll operation;
  observe again to verify visibility.
- `select_text {target,text,occurrence?,before?,after?}` selects exact text. Optional
  before/after must match the text immediately beside the selection, including
  whitespace and line endings. If several matches remain, choose one-based
  occurrence **among the context matches**. Cuse handles native character units.
- `replace_text {target,text,replacement,occurrence?,before?,after?}` replaces only the native text
  selection where supported. Unsupported rich-text writes refuse; Cuse does not
  rewrite the entire document as a fallback. On Windows the current candidate
  supports Unicode native Edit/RichEdit controls with proven HWND ownership and
  a TextPattern selection; other providers refuse rather than pasting globally.
- Formatting is a separate application behavior. A `checked` postcondition on
  a Bold toolbar control proves its control state, not that the selected text
  became bold. Some rich-text apps accept a directed shortcut or AX toggle but
  leave the text's font unchanged. Keep the exact selection, use the observed
  image position for a directed toolbar click when appropriate, and check the
  actual document style or saved rich-text file before reporting success.
- Mac directed input: `click {at,button?,count?}` (button: left/right/middle;
  count: 1..3), `move {at}`, `scroll {at,dx,dy}`,
  `drag {from,to,duration_ms}`, `type {text}`, `key {combo}`. Type/key use the
  target App's existing focused control; first observe and select the intended
  field. Windows background graphical input refuses; use supported UIA patterns
  or the explicit Windows foreground workflow. Mac never permits foreground mode.
- `wait {condition}` reads until a condition is true or the action budget expires.
  Conditions: `value_equals {target,value}`, `exists {target}`, `gone {target}`,
  `checked {target,value}` (value: `on`, `off`, `mixed`),
  `selected {target,value}` / `expanded {target,value}` (boolean), and
  `range_equals {target,value}` (exact number). The same condition can be an
  action's `expect`. Unknown/unavailable state is an error, never false evidence.
- `window_closed {window_native_id}` verifies that a window from a recent session
  observation no longer exists. Use `interaction_root.window_native_id` from the
  dialog observation as an `expect` on its Save/Cancel action, or in a `wait`.
  Hidden/minimized windows do not count as closed. Up to 32 observed window IDs
  are remembered. Arbitrary IDs refuse; observing a closed main window may fail
  even after its closure condition was verified. Verify saved content separately.

`verified` proves only the reported value, selection or postcondition.
`dispatched` means input/action delivery. `result_unknown` means it may have
happened. Records and error include the known effects; never infer business
success from a transport response.

Coordinates in v2 actions are pixels in the returned screenshot, top-left origin.
Cuse converts them using that observation's image mapping. Do not calculate a
Retina scale or pass full-desktop coordinates. Node bounds remain local logical
XYWH for semantic layout; prefer their refs for actions. Old version 1 WindowFrame
plans retain their original local-coordinate contract.

An observation can be partial: `image_error` or `tree_error` explains a missing
component. A failed tree has no nodes and `traversal_complete:false`. Without a
live image, coordinate actions refuse; semantic refs can still be used. Without
a tree, inspect the live image and use only the available graphical actions.
`state` exposes known checked/selected/expanded/range values. `unknown_fields`
may include actions/state when the observation's optional-read budget runs out;
expand a smaller scope rather than inferring that a capability is absent.

For a persistent Mac stream, `frame_status:unchanged` means the OS confirmed an
unchanged image after this observation began. `timestamp_ms` is the original
native frame time; `validated_at_ms` is the newer confirmation time. Suspended,
blank or stopped streams never return an old image as current.

Session images live in a private directory. Current observation references pin
their files; unreferenced images are cleaned after 24 hours or earlier when the
200 MiB quota is needed. They are temporary, so copy images you intend to retain.
If active references occupy the quota, `image_error:resource_limit` accompanies
the available tree; use `--no-image` or finish old sessions instead of retrying
capture indefinitely. Stop remains available during image encoding or cleanup.

## Dialogs and continuing a task

On Mac, an attached sheet/popover with a proven native parent becomes the
`interaction_root`. The session's `target` remains its original window;
`interaction_root` supplies the current window ID, parent, bounds and revision.
Observe after opening or dismissing a dialog. Old refs and image coordinates
expire on this transition, including main-window refs after returning from a
sheet. Use the new tree and image to name/save/cancel, then observe the parent
and continue. Session status and the window badge follow the current root.

An attached macOS `AXMenu` can also become the current root. A proven separate
menu surface supplies its own image and coordinates; otherwise use the menu
tree's current item refs with `invoke`. Open a child submenu with an explicit
image click or native `invoke`, then take a new observation. Do not assume a
menu-image `move` opened it; some AppKit menus ignore directed pointer motion.
Prefer invoking a named item when its AX action is available.
In macOS background mode, a single left click at a menu-image point uses native `AXPress` when
the complete live tree proves exactly one enabled item at that point; its
`backend` is `macos_ax_menu_image_hit`. If the hit cannot be proved, the action
refuses and asks for a native item ref. `dispatched` still only proves the action
was sent, so observe or check the business state before declaring success.
A menu that closes during input invalidates
old refs and pixels. Observe before deciding whether another action is needed;
never replay an uncertain click automatically.

An unrelated window or unproven/cross-process dialog is not automatically
authorized. `target_transition_required` may include `error.candidates` with
`selector`, `pid`, and a display-only `title`. These are bounded discovery hints,
not an exhaustive inventory or a control grant. Inspect current `window list`,
then explicitly choose the intended target; stop your old same-App session before
opening another. Open and observe establish the new target's current identity.
Candidates never authorize automatic cross-App continuation. If metadata is
unavailable, candidates may be absent. Do not keep clicking the blocked parent.
Opening a system dialog may return `result_unknown` even when the dialog has
appeared. Read the returned observation or observe again; if the intended dialog
exists, continue there without replaying the opening action. Verify the saved
file or application outcome separately from a dispatched Save button.

## Recovery and control

`policy` takes priority over `code` and permission hints. When it is
`background_only`, `reason: "foreground_disabled"` means Cuse does not support
the operation on Mac; permission prompts cannot enable it. For an unknown policy,
stop the affected Cuse operation and report it.
Without policy metadata, a legacy `background_only:` message has the same meaning;
otherwise use the error context. Topic `setup` distinguishes OS access from
MCP ownership failures. `reason` alone does not override `code`.

Compatibility: local protocol v2 keeps `code: "permission_denied"`. Changing that
code requires a new local protocol version, passing policy-first recovery tests
for all supported clients, and a compatible path for clients that still use v2.
Elapsed time or a Cuse release number alone does not end this transition.

```sh
cuse session status --session SESSION_FILE
cuse action-status --session SESSION_FILE --id SESSION_ID:SEQUENCE
cuse session pause --session SESSION_FILE
cuse observe --session SESSION_FILE --no-image
cuse session resume --session SESSION_FILE
cuse session renew --session SESSION_FILE
cuse session stop --session SESSION_FILE
```

Stop/status use an independent control path even if a native provider is blocked.
Pause waits for cancellation receipt; already admitted native input can still
have effects. Check `in_flight_effects_possible` and the action receipt before
continuing. An unresponsive cancellation channel terminates the session instead
of reporting a normal pause. `input_cleanup` reports remaining known held inputs,
release attempts/failures, and whether emergency cleanup finished. These counts
prove release API attempts, not application receipt. Do not retry an uncertain
business action merely because input cleanup finished.
Stop cannot withdraw messages already queued in the target App.

- Same action_id and identical parameters returns the known receipt, without
  executing again. Different parameters with the same ID refuse.
- On transport loss, query the same ID. Do not invent a new ID as a retry.
- `stale_observation` / `stale_ref`: observe again and decide a new action from
  current state. Three recent native observations are retained; older refs expire.
- `app_busy`: another operation or session owns the App. Query your session status.
- `user_takeover` / paused: background sessions require the target App in the
  background; Windows foreground sessions require the target window frontmost.
  Inspect current state, then explicitly resume.
- `host_unavailable`: no request was sent; retry status to learn whether this
  session is still alive. A connection failure does not prove a restart.
- `host_restarted` / ended: old actions are not replayed. Observe actual application
  state and open a new session only when you intend to continue.
- `screen_locked` / `desktop_unavailable`: sessions stop. Continue only after the
  user's interactive desktop is available, with a new session and observation.
- Capture and tree timestamps may differ. Inspect image_tree_skew_ms; do not treat
  them as an atomic view of a changing UI.

## MCP

Call `computer_use_readme {}` first. Then `session_open` returns `result.session`;
pass that object as `session` to `observe`, `act`, `action_status` and
`session_status/renew/pause/resume/stop`. The generated tool schema gives exact
arguments. `act` receives `{session,plan}`. MCP includes native image content in
addition to the same JSON result. This connection owns its sessions and closes
them on disconnect; it cannot stop another connection's sessions.
MCP cancellation is scoped to the pending JSON-RPC request ID. Cancelling an
action records or interrupts that exact plan; cancelling a completed request
does not stop a later action. Cancellation never promises to undo delivered input.

## Windows-only explicit foreground mode

macOS refuses foreground sessions, legacy global input and focus commands at the
Host and worker boundaries. No command-line or environment override is provided.
`open APP` launches in the background. A frontmost target returns `user_takeover`
or pauses the session.

`cuse session open WINDOW --mode foreground` reserves both the App and physical desktop input. First focus the intended window explicitly with `cuse window focus WINDOW`; opening a foreground session does not activate it for you. The badge/status identifies Foreground. Mouse and keyboard actions use the user's system input, so human parallel work is for background sessions only. Leaving that App pauses the session; switching to another window of the same App is rejected before the next physical input. Ref-based semantic actions still use UIA. Coordinates remain pixels in the returned window image.

On Windows, to change modes, stop the old session, then explicitly open a new one. Background failures never enable foreground input. Windows graphical actions use foreground; supported UIA controls can remain in background.

## Human controls and task labels

Add `--label "Edit draft"` when opening a session (MCP: `label`). Labels are limited to 128 characters, with no control characters. The Cuse menu-bar item on macOS or notification-area icon on Windows lists active tasks, target window titles and modes, with Pause/Resume and Stop. It remains available when the target's own badge is off screen, hidden or covered. Windows may place the icon in the notification-area overflow. The icon is transient while sessions are active; it is not a system screen-sharing indicator.
