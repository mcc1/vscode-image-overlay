# Changelog

## 0.0.1 — Initial release

- Custom editor for `PNG / JPG / GIF / BMP / WebP / AVIF / ICO` (and TIFF metadata).
- Four-corner glass overlays with fixed slot layout:
  - **TL** — Capture: camera, lens, focal · f/ · shutter · ISO, date.
  - **BL** — File: filename, dimensions, size, format, color mode, copyright.
  - **TR** — GPS: inline OpenStreetMap thumbnail (clickable) or coord text.
  - **BR** — Zoom % indicator pill.
- **Idle auto-fade**: overlays dim after 2.5 s of no input.
- **Cursor-near fade**: bounding-box-aware — only the overlay you're approaching dims.
- **Expanded EXIF panel** (`E`): full sectioned table replaces the TL slot.
- **Auto-contrast** per corner via luminance sampling.
- Zoom (scroll / `+` / `-`), pan (drag), reset (`0` or double-click), toggle (`I`).
- Configurable GPS map provider: OpenStreetMap / Google Maps / Apple Maps / off.
