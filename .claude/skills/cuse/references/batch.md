Cuse sequential actions (version 1)

**macOS background-only policy:** legacy global input, foreground sessions,
focus, standalone window/UI mutations and caller-hiding captures are refused.
Use `open APP` (background launch), `window list`, `session open`, `observe`,
and `act`. Restore a bound window with `window_prepare`. The legacy mutation
examples below apply to Windows only; read-only queries remain available on Mac.

Use `cuse batch --file plan.json`; add `--dry-run` for JSON/file validation
without desktop initialization. It cannot validate live targets or backend key
support. Existing single-action commands remain available.

CLI batch/stroke and MCP run_actions reserve desktop
input for one bounded operation through Cuse Host. Any active Cuse window
session, including background sessions in different apps, conflicts and returns
`app_busy`; finish or stop those sessions before starting a foreground batch.
These one-shot operations expose Stop in the Host controls; they do not resume
a partially executed plan. This uses the real pointer and keyboard: it does not isolate you from the Agent.
For independent window input, use session mode=background when supported.

Example plan (replace display/window/coordinates with your observations):

```json
{
  "version": 1,
  "display": 2,
  "expect_window": "hwnd:1234",
  "timeout_ms": 60000,
  "screenshot": true,
  "actions": [
    {"op":"click", "at":[300,200]},
    {"op":"type", "text":"Hello", "method":"direct"},
    {"op":"key", "combo":"Tab"},
    {"op":"stroke", "points":[[300,400],[350,420],[400,400]], "duration_ms":600}
  ]
}
```

Top-level fields:
- `version`: required, 1.
- `actions`: required, 1..256 sequential actions. Unknown fields/operations fail.
- `display`: required for coordinate actions. Repeat the source screenshot display;
  Windows 0 is the virtual desktop. It stays fixed for this batch.
- `source`: optional, copy the entire `frame` object from a fresh screenshot.
  Recommended for coordinate batches: detects changed geometry between processes.
  It checks geometry, not visual content or physical-monitor identity.
- `expect_window`: optional Windows foreground selector, preferably a current ID.
  Checked before physical input; stroke rechecks during movement. Other commands
  can lose focus during an in-flight native call. This is not a desktop lock.
- `timeout_ms`: 100..300000, default 60000, cooperative action deadline.
- `cancel_file`: optional path. Creating it requests cancellation; an existing file
  cancels before actions. Cuse never removes it. Paths are relative to the plan.
- `screenshot`: default true; attempt one final screenshot even on failure. Set
  false for workflows verified through structured observations. Capture happens
  within the Host operation budget; a stalled capture/provider may end the worker
  and return an uncertain result instead of partial records.

Action fields (`op` plus the fields listed; no arbitrary code):

| op | Fields |
| --- | --- |
| click | `at:[x,y]`, optional `count:1..3` (1), `button:left/right/middle` (left) |
| move | `at:[x,y]` |
| stroke | `points:[[x,y],...]` (2..4096), `duration_ms:1..30000`; left button |
| type | exactly one of `text` or `file`; optional `method:auto/direct/clipboard/accessibility` |
| key | `combo`, e.g. `ctrl+a`, `Tab`, `win+shift+right` |
| scroll | `at:[x,y]`, `direction:up/down/left/right`, `amount:1..100` |
| screenshot | no fields; records an intermediate screenshot, then continues |
| focus | `window`; Verified native focus, also updates the foreground guard |
| pause | `ms:0..30000`; cancellable delay |
| wait | `condition`, optional `timeout_ms:100..30000` (3000) |
| ui_invoke | `target`; Windows UIA Invoke, exactly one ready match |
| ui_set_value | `target`, exactly one of `text` or `file`; replaces field value |

UI target: `{"window":"hwnd:...","automation_id":"id"}` or exact `name`,
or both (AND). Optional `depth:1..32` (12), `max_nodes:1..2000` (500).

Wait conditions:
- `{"kind":"window","window":"title or ID","state":"exists"}`.
  States: exists, gone, foreground, normal, minimized, maximized.
- `{"kind":"ui","target":{"window":"hwnd:...","automation_id":"submit"},"state":"enabled"}`.
  States: exists, gone, enabled. Window must already exist.

Waits poll locally; provider errors/partial trees remain errors, never false.
Batch execution is Windows-only; Mac may validate a batch with --dry-run but
cannot execute it. Use Mac sessions or background plans instead. Incomplete
native trees cannot prove absence or uniqueness.

Use IDs returned by `displays`; Windows display 0 selects the combined desktop.
Read topic `input` for typing methods and clipboard preservation.

JSON files accept UTF-8 with optional BOM (plan <=2 MiB, text <=1 MiB, no NUL).
Text file paths resolve relative to the plan directory and are read before input.
The materialized plan must also fit the private transport budget (under 2 MiB);
JSON escaping and multiple text files count toward that budget.
Coordinates use the full screenshot image, not UIA physical bounds or zoom pixels.
All coordinate vertices are checked against image bounds before batch input.
The OS can still reject a path through a gap between monitors mid-stroke.
Dense paths may run slower than duration_ms; it is pacing, not a hard real-time guarantee.

Output contains `ok`, `completed_actions`, `records`, `source`, `error`,
`screenshot` and `screenshot_error`. Each record has a zero-based `index` and
`status`: done, failed, or not_started. A done input means action_sent, not task
success. Failed mutations may report outcome unknown: some input may have landed.
Do not replay the batch automatically. Inspect the partial results and current UI.
Failure returns exit 1; clap argument errors return exit 2.

Use a small batch for an already-understood local sequence. End the batch when
the next step needs visual judgment; an intermediate screenshot does NOT pause
for the model to inspect it. Use separate batches and ordinary Python/JS if/for
for adaptive work. Never run parallel physical-input batches on the same desktop.

For standalone drawing: `cuse stroke --file points.json --display 2
--duration-ms 600 --expect-window <id> --screenshot`, where points.json is only
the array of points. For stale-source validation use batch with `source`.

Cooperative cancellation works during strokes, pauses and between wait polls or
actions. Host Stop, MCP cancellation/EOF, or the operation deadline can end a
stalled worker. Cuse attempts registered cleanup after worker exit; API attempts
are not proof of application receipt. If the connection is lost after dispatch,
expect result_unknown and inspect the actual UI before issuing new work. MCP
retains coordinate context after ordinary partial results and invalidates it
after uncertain transport failure; take a fresh screenshot then.
