# Foreground input methods

**macOS background-only policy:** legacy global input, foreground sessions,
focus, standalone window/UI mutations and caller-hiding captures are refused.
Use `open APP` (background launch), `window list`, `session open`, `observe`,
and `act`. Restore a bound window with `window_prepare`. The legacy mutation
examples below apply to Windows only; read-only queries remain available on Mac.

These legacy input commands use the shared foreground desktop on Windows. For Mac
background input, read `cuse readme sessions`; it never uses clipboard paste.
MCP equivalents: `left_click/right_click/double_click/triple_click`, `mouse_move`,
`left_click_drag`, `scroll`, `type`, `key`, `scroll_capture`. CLI `drag` accepts
endpoints; MCP left_click_drag accepts optional `start_coordinate`; without it, the drag
starts at the current pointer. Use tool schemas.

Standalone foreground commands (click, move, drag, type, key, scroll,
scroll-capture, focus/open and window/UI mutations) reserve desktop input for
the call. They conflict with any active Cuse window session, including background
sessions in other apps. Use that session's `act` workflow, or stop it before
switching to standalone input. Each call is bounded (normally 60 seconds;
scroll-capture 120 seconds; window/UI timeout plus 5 seconds; MCP pointer tools
keep the 5-second plus 250 ms budget described below), offers Stop, and
ends on caller exit. No automatic retry follows interrupted or uncertain input.
Text files are read as UTF-8, up to 1 MiB; the materialized request must also fit
the private control budget. A large escaped payload can be refused before input.

## Mouse

```bash
cuse click 500 300
cuse click 500 300 -b right
cuse click 500 300 -c 2
cuse click 500 300 --screenshot
cuse move 500 300
cuse drag 400 400 --from-x 200 --from-y 200
cuse scroll 500 300 -d down -a 5
cuse scroll 500 300 -d up -a 30 -m accessibility
cuse cursor
```

When an action uses `--screenshot`, stdout is JSON containing the action and a
nested screenshot report. Read `screenshot.file` for the verification image.

## Keyboard

```bash
cuse type "Hello, world!"
cuse type --file input.txt --method clipboard
cuse type "Hello" --method accessibility
cuse key "ctrl+c"
cuse key "Return"
cuse key "down" -r 5
cuse key "page_up"
cuse key "Return" --accessibility
```

`auto` sends ordinary text directly and normally pastes multiline text through
the clipboard. If clipboard text cannot be saved, auto uses direct input instead.
`direct` avoids the clipboard. `clipboard` pastes and restores prior text only
while native ownership and the payload still match Cuse's write. On Windows,
`accessibility` typing also uses clipboard paste; it is not UI Automation or a
way around elevation.
The Windows key accessibility path uses the same input events as ordinary keys.
If typing appears ineffective, verify focus and the field's current content
before selecting another method; do not blindly repeat the payload.

On Windows PowerShell, prefer `type --file <UTF-8-file>` for multiline text,
quotes, emoji, or shell metacharacters. UTF-8 BOM files are supported. This avoids
shell argument re-parsing; file contents are typed literally. Clipboard methods
restore prior Unicode text including whitespace, but do not back up rich-text,
image or file formats. Explicit clipboard/accessibility typing fails before
writing if prior text cannot be read; use `direct` when clipboard preservation
matters. On Windows an ownership marker distinguishes a new normal copy even if
it contains the same text; Windows-generated format conversions keep the marker.
Clipboard managers that clone private formats are not covered by this guarantee.
The 500 ms paste delay is a heuristic for asynchronous readers;
check the actual field before continuing. A restore failure returns
`result_unknown` on both standalone and Host-managed paste paths, because input
may already have been delivered; do not retry it blindly.

Cuse shares one clipboard cleanup path across clipboard and
accessibility typing. Saved text plus paste text, JSON-escaped, must fit a
256 KiB cleanup record; otherwise Cuse refuses before writing (use `direct`).
For foreground input and batches, restoration facts stay in memory on the private pipe.
After a worker exits, Host attempts restoration only with confirmed native
ownership. If death interrupts ownership acquisition, Cuse leaves the clipboard
untouched and reports unconfirmed cleanup rather than guessing from matching
text. A restoration failure returns `result_unknown`, even if paste was sent.
Session cleanup distinguishes `held_inputs` from `pending_clipboard_restores`.
No cleanup mechanism guarantees recovery after simultaneous Host/worker or OS
failure; a clipboard restore also cannot retract an already queued paste.

## Legacy MCP held pointer

Prefer one bounded `stroke` / `run_actions` when the path is already known.
For adaptive foreground dragging, the MCP connection may use
`left_mouse_down` → one or more `mouse_move` → `left_mouse_up`. These tools
share one Host worker and reserve the physical desktop, including against Cuse
background sessions in other apps. They use the user's real pointer.

The hold expires after 30 seconds without a pointer call and at 120 seconds
from opening regardless of activity; a native call has a 5-second budget plus
250 ms scheduling allowance. The user can Stop from Cuse's task menu. EOF,
owner loss, Stop, admitted-operation failure or expiry ends the sequence and
attempts release. These limits are not proof that an app accepted a release.
Read-only observation and waits remain available; hiding the caller or another
mutation is refused until release. Observation/wait calls do not renew the hold.

Always send `left_mouse_up` when finished, including after a bad parameter.
A duplicate down is rejected and ends the existing sequence with cleanup.
Up without an owned press sends no input. After
expiry/Stop/uncertain failure, a continuation is rejected and the connection
forgets the ended sequence; inspect the UI before a fresh explicit press. Cuse
never converts a failed drag continuation into a new drag or ordinary move.
These are legacy semantics only; v2 `act` still releases all inputs per request.

## Scroll Capture

```bash
cuse scroll-capture -d up -p 10 -m accessibility
```

Use this for long documents, chat histories, or scrollable lists. It captures
multiple pages in one command. Read each returned file path. Before running it,
make sure the target scroll area already has keyboard focus; in CLI mode there
is no coordinate argument for the pre-click.
