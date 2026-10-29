# Foreground observation and coordinates

**macOS background-only policy:** legacy global input, foreground sessions,
focus, standalone window/UI mutations and caller-hiding captures are refused.
Use `open APP` (background launch), `window list`, `session open`, `observe`,
and `act`. Restore a bound window with `window_prepare`. The legacy mutation
examples below apply to Windows only; read-only queries remain available on Mac.

Applies to desktop screenshot/zoom and foreground input. For current Mac window sessions,
read `cuse readme sessions`; use the returned window image pixels.
MCP equivalents: `display_list`, `screenshot`, `zoom`, `cursor_position`.

## Screenshot JSON Report

```bash
cuse screenshot
cuse screenshot --display 2
cuse screenshot -o /tmp/current.jpg
cuse screenshot --inline-base64
```

Default stdout is JSON:

```json
{
  "ok": true,
  "file": "/tmp/cuse-screenshots/screen-123.jpg",
  "display": {
    "id": 2,
    "native_id": 69731840,
    "capture_index": 2,
    "logical_size": { "width": 1920, "height": 1080 },
    "physical_size": { "width": 3840, "height": 2160 },
    "is_default_screenshot_target": true
  },
  "image": {
    "raw_physical_size": { "width": 3840, "height": 2160 },
    "output_size": { "width": 1430, "height": 804 },
    "downsampled": true
  },
  "coordinate_space": {
    "click_input": "screenshot_image_pixels",
    "origin": "top_left",
    "image_to_display_scale": { "x": 1.3427, "y": 1.3433 }
  },
  "selection": {
    "resolved_display_id": 2,
    "reason": "frontmost_app_display"
  }
}
```

Read the screenshot image from `file`. Do not treat the command output itself as
the image. Use the JSON metadata to understand which display was captured and
whether the image was downsampled.

### Coordinate System

Click, move, scroll, and drag coordinates are in the latest full screenshot's
output JPEG pixel space:

- origin: top-left `(0, 0)`
- x grows right, y grows down
- use `image.output_size` as the coordinate bounds
- click the visual center of controls, not edges

Do not use display logical size or physical resolution as click coordinates.

On macOS, Retina backing pixels are reported separately from display logical
points. `displays[].physical_size` matches screenshot `frame.raw_width/raw_height`;
input is converted to global logical points, including negative display origins.
Display 0 is unsupported on macOS. Use an ID actually returned by `displays`.

CLI processes do not retain the previous screenshot. Coordinate commands rebuild
the mapping from the current display and the same resize policy. When using an
explicit screenshot display, repeat it on the action:
`cuse click 500 300 --display 2`. Move, drag, scroll and cursor also accept
`--display`. Take a fresh screenshot after changing display layout or resolution.

On Windows, positive display IDs select individual monitors; use IDs returned by
`displays`, not an assumed ordering. **Display 0 selects the entire virtual desktop.**
This differs from older Windows builds where display 1 meant the combined desktop.
Default captures follow the target-selection report; in CLI mode they normally
follow the foreground window's monitor. Explicitly repeat `--display <id>` on
coordinate actions, especially when clicking another screen will change focus.

For a drag across monitors, first take `screenshot --display 0`, then pass
`drag ... --display 0` with both endpoints from that overview. Use individual
monitor screenshots for reading small text. UIA bounds remain native desktop
coordinates, including monitor offsets; do not paste them into screenshot clicks.

Windows input space uses DPI-aware physical pixels; `scale_factor: 1` does not
mean Windows Settings is set to 100%. After connecting/disconnecting a monitor,
changing resolution/scaling/arrangement, refresh `displays` and screenshot. IDs
are current Windows device numbers, not permanent physical-screen identities.
Persisted coordinate metadata is checked against current geometry and fails with
`display_layout_changed` when stale. CLI invocations cannot remember the image
used in a previous invocation, so a new screenshot is still necessary after changes.

## Displays

```bash
cuse displays
cuse displays --text
```

`cuse displays` returns a JSON state snapshot:

- `displays[].id` is the ID to pass to `--display`; Windows adds 0 for the combined desktop
- `native_id` is platform diagnostic data only
- `default_screenshot_target` explains what no-argument `screenshot` will capture
- `frontmost_app.display_id` helps diagnose multi-monitor issues

No-argument `screenshot` resolves in this order:

1. last focused app display, when available in a persistent session
2. current frontmost app display
3. primary display

## Temporarily excluding the caller (Windows MCP)

`set_caller_app` registers a name only. `hide_caller=true` on screenshot, zoom or
scroll_capture temporarily hides that caller for this one operation and restores
it afterwards. This is a foreground mutation: it reserves desktop input and
conflicts with active Cuse window sessions and held-pointer sequences. Ordinary
screenshots with `hide_caller=false` remain read-only.

On Mac, caller-hiding is refused; observe the controlled window instead.
On Windows, use a current unique window selector. Ambiguous targets and unknown visibility refuse rather than
hide a guessed window. An already hidden/minimized caller is left as it is.
Stop/disconnect attempts restoration of the original OS identity; a replacement
process is never chosen by name. Restoration failure returns `result_unknown`;
inspect the original caller before continuing. Visibility has no ownership
counter, so concurrent human changes to the same hidden state cannot be
perfectly distinguished. For background work prefer the controlled-window image,
which does not require hiding the caller.
