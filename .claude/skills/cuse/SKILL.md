---
name: cuse
description: |
  Computer Use（操作电脑／桌面控制）with the `cuse` CLI: screenshots, mouse,
  keyboard, displays, and application windows. Use for native desktop apps,
  system UI, or explicit Cuse testing when a Cuse CLI is available. If Cuse MCP
  tools are the supplied interface, use the Cuse MCP Skill. For browser tasks,
  prefer available dedicated browser tools or skills such as Playwright; use
  Cuse only when none can perform the interaction, or Cuse is requested.
---

# Cuse — native computer use

Use Cuse for native apps/system UI or explicit Cuse testing. For browser tasks,
prefer an available dedicated browser tool when it can perform the interaction.
Use the matching CLI; do not install or update tools during a task. A release
bundle has `scripts/cuse` beside this Skill (`scripts/cuse.exe` on Windows).
For a source checkout, use the supplied CLI path; its launcher is not present
in the source tree. Use the full path; `cuse` below is shorthand for it.

## Choose and complete the workflow

**macOS is background-only.** `--mode foreground`, legacy global input and focus
commands are refused by the executable, Host and worker. There is no override.
Do not use another tool, AppleScript or shell input injection to bypass a refusal.
If the target is not running, `cuse open APP` launches it in the background; then
list its windows. Opening an app does not prove its window is ready.

**Background window sessions** keep the user's pointer and foreground App free.
Use this for supported Mac native controls/graphics or Windows UIA controls:

1. `cuse window list` — select a current, unambiguous window ID.
   If it is already frontmost, background open will refuse `user_takeover`;
   wait for the user to switch to another App. Never switch Apps for them or
   try foreground commands to work around this refusal.
2. `cuse session open WINDOW_ID` — retain `result.session_file`. If the Mac
   window is hidden or minimized, read `readme sessions` first and add
   `--allow-restore` only when restoring it is authorized.
3. `cuse observe --session SESSION_FILE` — inspect image and native refs.
4. Read `cuse readme sessions` if needed; submit a plan with
   `cuse act --session SESSION_FILE --file plan.json` (or `--json 'JSON'`).
   Include the observed target, action ID and supported postcondition.
   `window_prepare` runs alone without `expect`.
   Query the receipt after uncertainty; never blindly replay.
   Use `act --brief` for a large control tree: it keeps action records and
   image metadata, then call `observe` when fresh element refs are needed.
5. Verify actual application state, then `cuse session stop --session SESSION_FILE`.

The user works in another App. Entering the target App pauses the session;
resume is explicit. Other windows of the same App share state and are not a
separate human/Agent workspace. Unsupported actions refuse; do not silently
focus the target or switch to global input.
In a large dialog, `traversal_complete:false` means selectors cannot prove
uniqueness. Use a fresh observed ref when the intended control is identifiable
from its available role/name/automation ID and context, and has the needed
action; Cuse rechecks that ref before acting. If the control is absent, observe
a known narrower subtree with `--scope REF`. Never guess a ref or treat a
partial selector as unique.

**Windows only: explicit foreground work** shares the physical desktop with the user:
`window focus WINDOW_ID` → `session open WINDOW_ID --mode foreground`, then
observe/act/stop as above. Coordinates still come from the session window image.

## Read only what you need

- `<command> --help`: command syntax; `cuse schema`: generated v2 action schema.
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
