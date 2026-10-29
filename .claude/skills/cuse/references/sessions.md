# Sessions: observe → act → verify → stop

A session controls one App across calls. macOS permits background control only;
the user works in another App. If the target is frontmost, opening refuses
`user_takeover`; entering it later pauses the session. Wait for the user to leave
that App and explicitly resume. Do not focus another App, request foreground
mode, use legacy input or bypass a refusal through shell/other tools.
`cuse open APP` launches a Mac app in the background; list windows afterwards.

Windows also supports explicit foreground mode: focus the selected window,
then open with `--mode foreground`. This shares physical input; leaving that App
pauses work. Background failures never change modes.

## Start and observe

`window list` → `session open WINDOW_ID` → `observe --session SESSION_FILE`.
Use the exact current window ID and retain `result.session_file`. Open also
returns `result.status.session_id` and `next_sequence`. The file is a private
credential; keep its contents out of reports. Sessions expire after 10 minutes
unless renewed; `--lease-secs` accepts 10..1800. Finish with `session stop`.

Observation supplies `result.id`, native `tree.nodes` with opaque refs, and an
optional `image.file` to inspect with your image reader. `--no-image` skips
capture; `--scope REF` expands a known subtree. Choose observed refs for repeated
labels. Missing optional values are unknown, not empty/false. A missing image
or tree has its own error; use the remaining valid component.
Large native dialogs may return `traversal_complete:false`. A whole-dialog
selector cannot prove uniqueness then, even if it finds one matching row. If
the intended control has a fresh observed ref, is identifiable from its
available role, name or automation ID, and has the needed action, use that ref:
Cuse validates its native identity and ancestry again at mutation time. If the
control is missing, observe a known narrower subtree with `--scope REF`; do not
infer uniqueness from a partial tree.

## Submit a plan

Use `act --session SESSION_FILE --file plan.json` or `--json 'JSON'`.
For a long native tree, add `--brief` to keep action state, every record,
evidence, error and a small `observation_summary` without printing the whole
follow-up tree. `action-status --brief` works the same way. Call `observe`
before the next ref-based action; `observation_summary` is not a control tree.
This template needs IDs and a ref from your current session/observation:

```json
{"version":2,"action_id":"SESSION_ID:SEQUENCE","observation_id":"OBSERVATION_ID","timeout_ms":5000,"actions":[{"op":"set_value","target":{"ref":"REF"},"text":"Hello 世界 🧪","expect":{"kind":"value_equals","target":{"ref":"REF"},"value":"Hello 世界 🧪"}}]}
```

Use status.next_sequence. `act --dry-run --file plan.json` checks syntax/bounds
without desktop access; it cannot prove refs, native support or effects.
Plans stop at the first failure. Limits: 256 actions, 300 seconds, 2 MiB JSON;
text is at most 64 KiB without NUL.

Choose supported actions from the observed node: invoke, set_value, toggle,
select, expand, set_range_value, scroll_into_view, select_text, replace_text.
For exact arguments, request only what you need:

- `schema --action toggle --condition checked`: action with that expect variant.
- `schema --action replace_text`: one action with all allowed expect variants.
- `schema --condition window_closed`: one condition for expect or wait.
- `schema`: full plan schema for integrations.

Conditions include value_equals, exists, gone, checked (on/off/mixed), selected,
expanded, range_equals, window_closed. `wait` takes a condition; input actions may
include `expect`. Closure requires an ID from a recent actual observation;
hidden/minimized is not closed. Verify saved content separately.

For select_text/replace_text, before/after match immediate exact context;
occurrence is one-based **among context-matching occurrences**. Replacement
uses the native selection, without a whole-document rewrite fallback. Protected
fields do not expose values and do not support selection verification.
In a rich-text editor, selection and a formatting control's checked state are
separate facts from the selected characters' actual style. A dispatched keyboard
shortcut or a verified toolbar toggle can leave the text unchanged. When the
task asks for formatting, inspect the observed window image, use the intended
formatting control only while the exact selection remains current, then verify
the selected text's style in the document or saved file. Do not count the
control state alone as a formatted-document result.

Mac background supports directed click/move/scroll/drag/type/key; Windows
background uses supported UIA controls. Graphical Windows work needs explicit
foreground mode. Coordinates are pixels in the current returned window image;
node bounds are logical layout coordinates, so prefer refs for native controls.
Type/key use the target's existing focused control. Observe/select it first.
For Mac `move`, `dispatched` means the directed event was sent; it does not prove
the app ran a hover handler. Safari/WebKit can accept background clicks and text
while ignoring a directed `mousemove`. Observe the resulting menu, tooltip or
business state before continuing. Use an explicit click/invoke only when that
is the intended action; it is not a substitute for a requested pure hover.

For a Mac window hidden/minimized after opening, explicitly authorize restoration
with a plan containing only `{"op":"window_prepare"}` (no `expect`). Read its
transition receipt, then observe again before input. It does not authorize
activation, a Space switch, or automatic re-hiding. `--allow-restore` applies only
at session open. Use the last valid observation ID: some hidden third-party apps
temporarily remove their AX window, so a new `observe --no-image` can fail before
restoration. If there is no valid observation, stop and open a new Mac session
with `--allow-restore` only if authorized. Windows currently refuses restoration
of hidden/minimized windows; verified UIA semantic work may still be possible.

## Verify and recover

`verified` proves only the recorded state/postcondition; `dispatched` proves
dispatch; `result_unknown` means it may have happened. An image error can follow
a successful write. Query `action-status --session FILE --id SESSION_ID:SEQUENCE`
and inspect current state before deciding another action. Same ID plus identical
plan returns its receipt; changing the plan under that ID refuses.

Pause/Stop cannot undo queued input. Pause acknowledgement proves cancellation
receipt, not native quiescence. Check status.in_flight_effects_possible and the
action receipt. input_cleanup counts release attempts, not application receipt.
Use `session status`, `observe`, then explicit `session resume` when appropriate;
resume never replays. Stale refs require a fresh observation. After a stopped,
locked or restarted session, inspect actual state before starting a new one.

After opening/closing a dialog, observe again: interaction_root identifies the
current dialog and old refs/coordinates expire. An opening action may return
unknown after the dialog appeared; continue there instead of reopening it.
An unproven window transition requires explicit target selection.

## Read further only when needed

`readme session-details`: delta reconstruction, selectors, action semantics,
image freshness/storage, restoration, dialog boundaries, recovery error codes,
and human Pause/Stop controls. Use `--allow-restore` only when restoring a
hidden/minimized Mac target is authorized; it never authorizes activation.

MCP: first read computer_use_readme, then session_open returns result.session;
pass it to observe/act/control tools. act receives {session,plan}. Tool schemas
supply arguments and observations include native image content. Disconnect ends
that connection's sessions; cancellation targets the pending request only.
