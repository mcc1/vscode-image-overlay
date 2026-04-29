# Image Overlay Preview

[![VS Code Marketplace](https://vsmarketplacebadges.dev/version-short/mcc.image-overlay-preview.svg?label=VS%20Code%20Marketplace&color=007ACC)](https://marketplace.visualstudio.com/items?itemName=mcc.image-overlay-preview)
[![Installs](https://vsmarketplacebadges.dev/installs-short/mcc.image-overlay-preview.svg)](https://marketplace.visualstudio.com/items?itemName=mcc.image-overlay-preview)
[![Rating](https://vsmarketplacebadges.dev/rating-star/mcc.image-overlay-preview.svg)](https://marketplace.visualstudio.com/items?itemName=mcc.image-overlay-preview&ssr=false#review-details)
[![GitHub Release](https://img.shields.io/github/v/release/mcc1/vscode-image-overlay?include_prereleases&sort=semver&label=github&color=success)](https://github.com/mcc1/vscode-image-overlay/releases)
[![License: MIT](https://img.shields.io/github/license/mcc1/vscode-image-overlay?label=license&color=lightgrey)](LICENSE)

Preview images in VS Code with EXIF and file metadata shown as **unobtrusive
glass overlays in the four corners** — the image stays center stage, no sidebar
eating your horizontal space.

## Why

The built-in VS Code image preview only shows dimensions in the status bar.
Existing metadata extensions compress the image into a narrow column by
docking a sidebar panel. This extension keeps the image at full size and
shows metadata as small floating cards anchored in fixed corners.

## Features

- **Fixed-slot layout.** Each kind of info has a dedicated corner so your
  eye learns where to look — no per-image shuffling:
  - **TL** — Capture: camera · lens · focal · f/ · shutter · ISO · date.
    (Replaced by the full sectioned EXIF table when expanded with <kbd>E</kbd>.)
  - **BL** — File: filename · dimensions · size · format · color mode · ©,
    plus a `3 / 47` position counter when there's more than one sibling.
  - **TR** — GPS: inline OpenStreetMap thumbnail (clickable) or coords.
  - **BR** — Zoom % pill. While slideshow is playing it grows to
    `▶ 1.5s · 100%`; the optional histogram panel parks just above it.
- **Browse the folder.** <kbd>←</kbd> / <kbd>→</kbd> step through sibling
  images in the same folder. Sort by filename / mtime / ctime / size,
  ascending or descending — only supported formats are listed.
- **Slideshow.** <kbd>Space</kbd> plays / pauses. <kbd>[</kbd> slows down,
  <kbd>]</kbd> speeds up (clamped 0.5–30 s). The BR pill shows the current
  interval.
- **Idle auto-fade.** After 2.5 s of no activity, overlays dim so you can
  just look at the image. Any input brings them back instantly.
- **Bounding-box-aware cursor fade.** When the cursor is near (or inside) a
  specific overlay's actual rectangle, only *that* card dims — even after
  the panel grows in expanded mode.
- **Expanded EXIF mode.** Press <kbd>E</kbd> to replace the TL card with a
  sectioned full EXIF table (description / camera & lens / exposure /
  date & time / GPS / image / authoring).
- **RGBA histogram** (opt-in). Press <kbd>H</kbd> to drop a 320×120 panel
  above the BR zoom pill. Every pixel is counted in a Web Worker (zero-
  copy buffer transfer) so even 100+ MP images don't block the UI.
  Additive R/G/B curves with sqrt scaling so 0/255 spikes don't flatten
  the rest; alpha curve is overlaid only when the image actually has
  translucency. **Off by default**, and the toggle persists across images
  for the duration of the VS Code session — only reloading VS Code resets
  it.
- **Inline GPS map.** When the file has GPS coordinates, the TR card shows
  a small OSM static map; click to open the full map in your configured
  provider.
- **Auto-contrast.** Each corner samples its own background luminance to
  pick a light- or dark-friendly glass tint.
- **Fully hideable.** Press <kbd>I</kbd> to toggle all overlays off.
- **Zoom & pan.** Scroll to zoom, drag to pan, <kbd>0</kbd> or double-click
  to reset.

## Supported formats

Natively renderable: `PNG`, `JPG/JPEG`, `GIF`, `BMP`, `WebP`, `AVIF`, `ICO`.
EXIF parsing (via [`exifr`](https://github.com/MikeKovarik/exifr)) works on
JPEG / TIFF / HEIC / WebP. TIFF rendering is not yet supported — pixel data
needs a decoder; metadata works.

## Keybindings

| Key | Action |
| --- | --- |
| <kbd>I</kbd> | Toggle all overlays |
| <kbd>E</kbd> | Toggle expanded EXIF panel |
| <kbd>H</kbd> | Toggle RGBA histogram (full-pixel scan) |
| <kbd>0</kbd> / double-click | Reset zoom / pan |
| <kbd>+</kbd> / <kbd>-</kbd> | Zoom in / out |
| <kbd>←</kbd> / <kbd>→</kbd> | Previous / next image in folder |
| <kbd>Space</kbd> | Slideshow play / pause |
| <kbd>[</kbd> / <kbd>]</kbd> | Slideshow slower / faster |
| scroll | Zoom |
| drag | Pan |
| <kbd>Ctrl+Shift+I</kbd> | Toggle overlay (works without focusing image) |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `imageOverlay.defaultVisible` | `true` | Show overlay by default when opening. |
| `imageOverlay.autoContrast` | `true` | Adapt overlay contrast to local background. |
| `imageOverlay.showHintOnOpen` | `true` | Briefly show the keyboard-shortcut hint. |
| `imageOverlay.gpsMapProvider` | `openstreetmap` | `openstreetmap` / `google` / `apple` / `none`. |
| `imageOverlay.browseSortBy` | `filename` | Sort sibling images by `filename` / `mtime` / `ctime` / `size`. |
| `imageOverlay.browseSortOrder` | `asc` | `asc` or `desc`. |
| `imageOverlay.browseLoop` | `false` | Wrap around at the first / last image (also applies to slideshow). |
| `imageOverlay.slideshowIntervalMs` | `3000` | Default slideshow interval in milliseconds. |

## Install

### From GitHub releases (prebuilt)

Grab the latest `.vsix` from the
[releases page](https://github.com/mcc1/vscode-image-overlay/releases)
and run:

```bash
code --install-extension image-overlay-preview-0.1.1.vsix
```

### From source

```bash
git clone https://github.com/mcc1/vscode-image-overlay.git
cd vscode-image-overlay
npm install
npm run build
npx vsce package
code --install-extension image-overlay-preview-0.1.1.vsix
```

## Development

```bash
npm install
npm run watch   # rebuilds on change
```

Then in VS Code, press <kbd>F5</kbd> to launch an Extension Development
Host. See `.vscode/launch.json`.

## License

MIT.
