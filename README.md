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
  - **BL** — File: filename · dimensions · size · format · color mode ·
    color space · `HDR` chip · ©, plus a `3 / 47` position counter when
    there's more than one sibling.
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
- **Color space label** in the file card — pulled from the most
  trustworthy signal each format offers: PNG `cICP`, AVIF/HEIC `nclx`
  (codec-independent code points), then ICC profile description, then
  EXIF ColorSpace. So "Display P3" surfaces on iPhone HEICs that EXIF
  flags as `Uncalibrated`, and "Rec.2020 PQ" surfaces on Samsung HDR
  HEICs that don't carry ICC at all.
- **HDR badge** in the file card. Catches the four real-world HDR
  encodings: UltraHDR / Apple HDR JPEGs (XMP gain map), and HDR10 (PQ)
  / HLG on AVIF / HEIC / PNG (transfer enum 16 / 18 in the codec's own
  colour box).
- **Inline GPS map.** When the file has GPS coordinates, the TR card shows
  a small OSM static map; click to open the full map in your configured
  provider.
- **Auto-contrast.** Each corner samples its own background luminance to
  pick a light- or dark-friendly glass tint.
- **Fully hideable.** Press <kbd>I</kbd> to toggle all overlays off.
- **Zoom & pan.** Scroll to zoom (pivots on the cursor — the pixel under
  your pointer stays put), drag to pan, <kbd>0</kbd> or double-click to
  reset. Pointer capture means the pan keeps tracking even if you
  release the mouse outside the VS Code window.

## Supported formats

| Format | Renderer | Notes |
| --- | --- | --- |
| PNG / JPG / GIF / BMP / WebP / AVIF / ICO | `<img>` (native) | Whatever Chromium can decode shows up immediately. |
| SVG | `<img>` (native) | |
| TIFF / TIF | [`utif`](https://github.com/photopea/UTIF.js) (~30 KB) | Decoded client-side, blob-URL'd into `<img>`. First IFD only. |
| HEIC / HEIF | [`libheif-js`](https://github.com/catdad-experiments/libheif-js) Web Worker (~1.4 MB, lazy) | The decoder bundle is fetched only the first time a HEIC opens. |
| RAW (CR2/NEF/ARW/DNG…) | — | Out of scope; would need a per-vendor decoder. EXIF metadata still parses. |
| JPEG XL | — | Out of scope. |

EXIF / XMP / IPTC / ICC parsing (via
[`exifr`](https://github.com/MikeKovarik/exifr)) covers all of the above
that carry metadata. Wide-gamut and HDR signals on AVIF / HEIC / PNG
come from a small in-tree ISOBMFF + PNG-chunk walker (`src/webview/lib/`,
~120 lines, fully unit-tested) so we don't pay a parser dependency just
for `nclx` / `cICP`.

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
code --install-extension image-overlay-preview-0.2.0.vsix
```

### From source

```bash
git clone https://github.com/mcc1/vscode-image-overlay.git
cd vscode-image-overlay
npm install
npm run build
npx vsce package
code --install-extension image-overlay-preview-0.2.0.vsix
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
