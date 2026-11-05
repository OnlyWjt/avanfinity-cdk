# Long lists and conversations: bounded reading and recovery

Use the matching binary's `info`, `--help` and `schema`, or MCP `tools/list`, to
discover available commands and actions. Do not infer availability from a version
number alone. The legacy `scroll-capture` / `scroll_capture` is not the Mac
background collection API. Windows background sessions have no graphical scroll
backend: use observed native `scroll_into_view` where supported, or an explicitly
authorized foreground session. No automatic foreground fallback is allowed.

## Choose evidence before choosing an action

Use an available, verified business-specific interface for data it actually
exposes. Otherwise inspect a small native subtree first. Text example: read a
conversation row's name/summary and use advertised `select`. Image example:
inspect a diagram in a current window image and retain the original image.
Mixed example: use native rows to select a conversation, then collect screenshots
of text and image messages and record attachment gaps separately. No single
route is optimal for every app.

Run the basic setup check once and reuse it while the environment is unchanged.
`doctor` distinguishes caller and execution Host permissions. `doctor --deep`
ready means the tested environment checks passed, not that a particular business
window or provider works. A session `observe` adds `readability`: target identity,
image error/liveness, native-tree completeness and lease remaining. Mac observations
also report the native worker's current permission checks and stream status/last
confirmation timestamps when available. Unknown values stay unknown. Diagnose
only the layer that failed instead of repeating doctor for every list row.

## Recipe 1: discover a long list

1. Discover the window and open a background session. Start with
   `observe --session SESSION_FILE --compact`. Inspect title and region before
   acting. Prefer `--no-image` for later purely semantic reads.
2. `tree.nodes` retains names, values, actions, original refs and unknown fields.
   Empty structural rows are omitted except the scope root. If `next_offset` is
   present, call `read-tree --session SESSION_FILE --observation OBS_ID --offset N`.
   Keep the same filtering options while paging. This reads the **same snapshot**,
   avoiding another full provider traversal. `--all` includes structural rows.
3. Paging a partial tree does not finish native traversal. If
   `traversal_complete=false`, choose a recognizable list/row ref and call
   `observe --session SESSION_FILE --scope REF --compact --no-image`.
   Missing controls and unknown properties do not establish uniqueness. A ref
   identifies one observed object; inspect its context before using it.
4. Native node bounds and `read-tree --region X Y W H` use window-local logical
   units. `viewport_relation` is only a bounds intersection (`inside`,
   `intersects`, `outside`, `unknown`); `visibility=unknown` never claims provider
   visibility or absence of clipping. Retain unknown-bound rows for inspection.
5. Record discovered items using business identifiers when available; names alone
   may repeat. Save each row's summary/date and whether it was fully read. Use
   an advertised native select with a selected-state postcondition when possible:

```json
{"version":2,"action_id":"SESSION_ID:NEXT_SEQUENCE","observation_id":"OBS_ID","timeout_ms":5000,"actions":[{"op":"select","target":{"ref":"ROW_REF"},"expect":{"kind":"selected","target":{"ref":"ROW_REF"},"value":true}}]}
```

`verified` here proves selection only. Reobserve the content/title to prove the
intended conversation opened. For title checks, compare the returned `title` or
an identified title node; there is no invented `title_equals` postcondition.
6. Save this page before scrolling. Use a small collection or one observed scroll,
   then identify the overlapping rows. Track new items, duplicate identities and
   unreadable rows. A repeated viewport means no observed progress, not a proven
   end of the underlying list. Report discovered count, traversed region and
   unresolved items; never claim a complete inventory from a truncated tree.

Example failure: 200 rows with `traversal_complete=false` and one unreadable AX
field. Do not retry 200 whole-window reads. Scope an identifiable list/row,
collect its known summary, mark the missing field unknown and continue with
independently readable rows. A common permission failure applies to the entire
window; resolve it once instead of probing each row.

## Recipe 2: read a long conversation

1. Verify conversation title/participants and the currently displayed date or
   latest-message anchor. Establish the requested time lower bound. Do not assume
   the initial viewport is at the newest message.
2. Observe a current image, select the actual scrolling content rectangle, excluding
   fixed headers, input boxes and sidebars. Capture uses **that image's pixels**,
   unlike native node bounds. Test a modest v2 scroll amount if the app's direction
   or units are not yet known; observe its actual effect before collecting.
3. Collect with explicit limits. All capitalized placeholders below must come from
   this run; `--id` is a fresh caller-generated identifier (letters/digits/-_.):

```text
cuse capture --session SESSION_FILE --id CAPTURE_ID --observation OBS_ID --region X Y WIDTH HEIGHT --dy DY --max-pages 8 --timeout-ms 120000 --settle-ms 500
cuse capture-status --session SESSION_FILE --id CAPTURE_ID
```

MCP `capture` takes `{session,plan}` with `capture_id`, `observation_id`, `region`,
`dy`, `max_pages`, `timeout_ms`, `settle_ms`. `capture_status` takes
`{session,capture_id}`. The region is validated against the starting image.
Bounds: 1–32 pages, 1–300 seconds, 100–3000 ms between stability samples. The
existing native operation watchdog also bounds a stalled provider. Collection
blocks competing native reads/actions on the same session; status, read_tree,
renew, pause and stop remain available.

Each scroll is a normal ledger action. Its ID is saved to `manifest.jsonl` before
admission, and its result is saved before another scroll. The original PNG pages,
image timestamps, title, viewport, visual fingerprint and comparison evidence
are retained in a private directory. Copy that directory when retaining evidence
outside Cuse. Collections persist until explicitly removed, with a shared 256 MiB
storage quota; they are separate from short-lived observation images. Do not
publish private conversations, tokens or session files.

The collector requires two matching samples, separated by `settle_ms`, with at
most three observe-only settling attempts. It compares neighboring viewports
using a conservative gradient overlap heuristic. Blank/low-information,
ambiguous overlap, repetition, no progress or unsettled content stop collection.
The last inspected page is retained even when its overlap is unproven. This can
stop conservatively on sparse text or animation; it does not guarantee all lazy
images have loaded. Review saved pages and attachments yourself.

4. Read the saved pages in order. Record first/last message anchors, visible dates,
   duplicate boundary messages, and unread gaps. Track text coverage separately
   from images, files, audio and collapsed content. A screenshot of an attachment
   card does not prove the attachment was read. Keep originals; an optional reading
   composite must not replace the per-page evidence. No stitched-image output is
   currently provided.
5. Stop at the requested business lower bound only after examining dates/anchors.
   `coverage_complete` always remains false at the tool layer. `page_budget`,
   `no_progress` and `repeated_page` are stop reasons, not proof of business completion.
6. After interruption, read the original `capture_status` and `last_action_id`
   with `action-status` first. If the Host ended, use the saved journal; an
   `action_intent` without a result is uncertain. Discover/open a new session when
   necessary, take a fresh observation, reconcile it against the saved page and
   message/date anchor, choose a new viewport, then collect only the missing range
   with a **new** capture ID. Never carry refs, geometry or session files across
   Host epochs. Repeating an identical capture ID/plan within the same session
   returns the original progress/result; changing its plan is rejected.

Example success: three stable pages, two clear visual overlaps, expected title
throughout; review confirms messages down to the requested date, with two image
attachments still unexamined. Report the text range and those two attachment gaps.
Example failure: one saved page, scroll `dispatched`, then `capture_suspended`.
Keep the page and scroll ID. Query its receipt, diagnose capture, reobserve once
under changed conditions and reconcile the current viewport. Do not resend that
scroll. While waiting for the user, organize the saved page's messages and gaps.

## Recovery and stopping rules

| Signal | Next step / stop condition |
|---|---|
| `policy` set, including `background_only` / `foreground_disabled` | Policy overrides `code`, including `permission_denied`. The requested Cuse operation is unavailable. See topic `setup`. |
| Legacy `background_only:` message without policy fields | The same Cuse capability limit applies. `reason` alone does not override `code`. |
| `permission_denied` without a policy refusal | Follow the error context. For missing OS access, diagnose with `doctor`, use an authorized `doctor --fix`, then wait for the user to grant access. MCP ownership requires the owning connection. Caller permission alone is insufficient. |
| Partial/large tree | Page the cached compact view, then scope recognizable current refs for native expansion. Do not infer selector uniqueness from a filtered or partial view. |
| `dispatched` with no visible business change | Read state/title or a semantic postcondition. Investigate supported select/invoke; do not treat dispatch as success. |
| `result_unknown` or lost transport | Query the original action/capture ID and inspect actual state. Never change IDs merely to retry a write. |
| Screenshot unavailable | Inspect `readability.capture`, native status and last-confirmation time. Mac discards a failed stream; one later explicit observe rebuilds it. If it still fails, stop coordinate work. `window_prepare` only handles hidden/minimized state; already-visible is not stream recovery. |
| Unsupported scrollbar Value | Do not repeatedly set it. Use another advertised native action or an observed window-region scroll where the platform supports it. The reported WeCom failure is an app/environment observation, not a universal AX rule. |
| User takeover | Inspect state, then explicitly resume: background sessions require the target App in the background; Windows foreground sessions require the target window frontmost. |
| Geometry/title/root changes | Stop and keep partial evidence. Reobserve and select the intended context and region explicitly. |
| Low lease time | Explicit `session renew` before further work. Capture stops before starting an operation with under 12 seconds remaining. No implicit renewal or resumption. |
| Expired lease / Host restart | Discover current window, open a new session, reconcile saved business anchors. Old refs/tokens/geometry cannot be reused. |
| Repetition, blank, missing overlap or lazy content | Inspect saved evidence and content readiness; smaller step or changed region requires a new observation and new capture. Repetition does not prove the end. |
| Shared fault unchanged | Stop retrying that layer. Finish independent work such as indexing saved pages, deduplicating known messages and listing unread attachments. |

Batch only short, already-understood actions whose target and geometry remain
valid. Stop to observe after navigation, selection, scrolling, dialogs or an
uncertain effect. Multiple scrolls with only the final screenshot lose the middle;
they are not a reading workflow. The bundled `scripts/cuse_client.py` offers v2
`act`, `observe`, `capture`, `capture_status` and explicit `renew` helpers with
input checks and no automatic replay. Keep error reports and the journal path.

## Acceptance boundary

Automated regression uses deterministic image sequences and Host/worker fault
injection. Native acceptance must also exercise ordinary text, rapid updates and
mixed attachments, lazy loading, takeover, geometry/root changes, capture failure
and resumption in a new session. A fresh Agent should use only the bundled guide
to discover a list, read a continuous range and recover after an interruption;
record calls, ineffective retries, missing pages and duplicates. Syntax/link
checks alone do not establish that acceptance. Repository validation records must
say which of these were actually run; do not generalize one app's failure.
