---
name: cuse
description: |
  Control desktop apps with the bundled CLI at its absolute path; macOS supports background windows only.
  For browser tasks, use only when Cuse is requested or no browser tool can perform the interaction.
---

# Cuse — native computer use

Use the interface the user requests. Otherwise, prefer connected Cuse MCP tools
and the `cuse-mcp` Skill; use this CLI workflow when those tools are unavailable.
For browser work, prefer a dedicated browser tool unless Cuse is requested or
that tool cannot perform the interaction.

Use the host-supplied absolute executable path, or resolve `scripts/cuse` relative
to this Skill's package root (`scripts/cuse.exe` on Windows). Quote the path;
see [setup](references/setup.md) for shell examples. Do not run bare `cuse` or
search PATH. If the entry is missing or incompatible, report the bundle problem
and stop; do not install, update or substitute another copy during a task.

**macOS is background-only.** Cuse refuses foreground sessions, global input,
focus and caller-hiding capture. A frontmost target returns `user_takeover`;
entering it pauses the session. `open APP` launches in the background.
`policy: "background_only"` is a Cuse capability limit, not missing OS access.
Read `readme setup` for error details.

Commands below are arguments to the absolute executable path above.

1. `info`, then `window list` — check identity and choose an unambiguous window ID.
2. `session open WINDOW_ID` — retain `result.session_file`.
3. `observe --session SESSION_FILE` — inspect the image and native refs.
4. Read `readme sessions`, then `act --session SESSION_FILE --file plan.json`.
5. Verify the application state, then `session stop --session SESSION_FILE`.

After an uncertain action, query `action-status --session SESSION_FILE --id ACTION_ID`
and inspect the application; never blindly replay. Keep each session on its original
interface for recovery and stop. Dispatch alone does not prove success.

## Background sessions

For a hidden or minimized Mac target, read `readme sessions` before opening it;
add `--allow-restore` only when restoration is authorized. That topic also covers
`window_prepare`, postconditions and action receipts. Use `act --brief` for a large
control tree, then `observe` when fresh refs are needed.

The user works in another App. Entering the target App pauses the session;
resume is explicit. Other windows of the same App share state and are not a
separate human/Agent workspace. Cuse returns errors for unsupported actions.
In a large dialog, `traversal_complete:false` means selectors cannot prove
uniqueness. Use a fresh observed ref when the intended control is identifiable
from its available role/name/automation ID and context, and has the needed
action; Cuse rechecks that ref before acting. If the control is absent, observe
a known narrower subtree with `--scope REF`. Never guess a ref or treat a
partial selector as unique.

**Windows only: explicit foreground work** shares the physical desktop with the user:
`window focus WINDOW_ID` → `session open WINDOW_ID --mode foreground`, then
observe/act/stop as above. The session pauses when that window loses focus;
resume requires it to be frontmost. Coordinates come from the session image.

## Read only what you need

- `<command> --help`: command syntax; `schema`: generated v2 action schema.
- `readme sessions`: minimal plan, result strength and recovery.
- `readme session-details`: advanced observation, native action and lifecycle contracts.
- `readme windows`: window controls and standalone native UI queries.
- `readme observation` / `input`: legacy full-desktop image and guarded input rules.
- `readme batch`: bounded foreground batches and continuous strokes.
- `readme background`: compatibility contract for existing version 1 Mac plans.
- `readme setup`: permissions and diagnostics (`doctor --deep`).

A successful dispatch is not task success. Prefer native value/selection readback
and explicit postconditions. A failed screenshot can follow a successful write;
inspect the receipt and application before doing anything again.
In Mac background mode, a `move` receipt may not produce Safari/WebKit hover.
Check the resulting menu, tooltip or business state before relying on it.

## Long lists and conversations

Choose a verified business interface when it exposes the needed data. For desktop
reading, inspect a small native list/row first; use current images for visual or
mixed content. Run setup checks once and reuse them until relevant conditions
change. Environment readiness does not prove the target window is readable.

Read the `reading` manual topic before a long traversal. Start with compact
observation and page its saved rows with `read-tree` (MCP: `read_tree`); scope a
recognizable current ref when the native tree itself is incomplete. Bounds
intersection is not proof of visibility. Prefer advertised native selection with
a selected-state postcondition, then verify the opened content/title.

When the current binary/schema exposes `capture`, use its explicit page/time
budget and a region selected from the current image. It saves original pages and
a journal, checking stability, overlap and repetition before advancing. Query
`capture-status` (MCP: `capture_status`) after uncertainty. Saved image overlap
never proves a message/date range complete: record business anchors and attachment
gaps separately. Pause, takeover, changed context or failed capture preserves
partial results. Recover from saved anchors with a fresh observation; never replay
an uncertain scroll. Check the executable's help/schema for available commands.
