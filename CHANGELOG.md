# Changelog

## 0.2.0 — HEIC, HDR badge, color space label

- **HEIC / HEIF rendering** via [`libheif-js`](https://github.com/catdad-experiments/libheif-js)
  in a dedicated Web Worker. Built as its own ~1.4 MB esbuild bundle
  (`dist/heic-worker.js`) so the main viewer stays lean — the decoder
  is only fetched the first time you actually open a HEIC. Decode runs
  off-thread and the RGBA pixels come back as a Transferable (zero-copy),
  so even Samsung S26U / iPhone 50 MP shots don't block the UI.
- **Color space label** in the file card. Uses the ICC profile
  description (most reliable for "Display P3" / "Adobe RGB" / etc.)
  with a fallback to the EXIF ColorSpace tag. Apple devices in
  particular tag JPEGs as ColorSpace=Uncalibrated and put the actual
  P3 in the ICC profile, so this needed `icc: true` in the exifr call.
- **HDR badge** in the file card when the image is a UltraHDR / Apple
  HDR JPEG (XMP `hdrgm:Version` or `apple:HDREncoding`). AVIF / HEIC
  HDR signalled in the `nclx` box and PNG `cICP` chunks aren't detected
  yet — they'd need raw box parsers we don't have.
- CSP relaxed to `worker-src ${cspSource} blob:` so the HEIC worker can
  load from the extension dist directory. Histogram's blob worker keeps
  working under the same rule.

## 0.1.4 — More format support: SVG and TIFF rendering

- **SVG** — added to the custom-editor selector. `<img>` already renders
  SVG natively in the webview, so this is purely a registration change.
- **TIFF rendering** — the editor used to register `.tif` / `.tiff` for
  metadata only (Chromium can't decode TIFF in `<img>`). Now decoded
  client-side via [`utif`](https://github.com/photopea/UTIF.js): fetch
  bytes → decode IFD → toRGBA8 → canvas → PNG blob URL → `<img>.src`.
  Everything downstream (corner luminance, EXIF parse, histogram) keeps
  reading from the live `<img>`, so all existing features just work.
- Decode failures now show "TIFF decode failed" in the TL card instead
  of the generic "failed to load preview".
- Bundle size: `viewer.js` grows from ~89 KB to ~175 KB minified (utif
  + pako). Loaded eagerly — TIFF support is opt-in via filename only,
  no lazy-loading complexity worth adding for ~86 KB.

## 0.1.3 — Performance: lighter EXIF parse, fully off-thread histogram

- **EXIF parse no longer pre-fetches the whole file.** Hands the URL
  directly to `exifr` so it issues HTTP Range requests and only pulls
  the few segments it actually needs. A 100 MB image now reads ~64 KB
  instead of allocating 100 MB on the main thread.
- **Histogram canvas extraction moved off-thread.** When
  `createImageBitmap` + `OffscreenCanvas` are available (modern
  Chromium, so VS Code webview), the bitmap is transferred zero-copy
  into the worker, which does `drawImage` + `getImageData` + counting
  entirely off-thread. The previous version still ran the giant
  `drawImage` / `getImageData` on the main thread before handing the
  buffer to the worker — that step alone could stall a 24 MP scan for
  100–300 ms.
- Falls back gracefully through three tiers if the off-thread path
  isn't available: bitmap → main-thread buffer + worker → chunked
  main-thread scan.

No functional changes for users on top of 0.1.2 — these are pure
perf improvements that show up most on very large images.

## 0.1.2 — Tooling & docs

- README: live VS Code Marketplace / Installs / Rating / GitHub Release /
  License badges (using the actively-maintained `vsmarketplacebadges.dev`
  service since shields.io retired its `visual-studio-marketplace/*`
  endpoints).
- README: install instructions split into "from releases (prebuilt
  vsix)" vs "from source".
- Tooling: tag-driven GitHub Actions release workflow, plus
  `npm run release [patch|minor|major]` helper that drives the whole
  flow end-to-end — bump → push tag → poll & watch CI → download the
  built vsix → open marketplace dashboard for the manual upload step.
- Docs: CLAUDE.md refreshed to match current architecture (fixed-slot
  layout, host-scoped UI flags, inline-blob histogram worker) and now
  documents the release process for future agents / contributors.

No runtime behaviour changes vs 0.1.1.

## 0.1.1 — RGBA histogram

- Press `H` to toggle a floating RGBA histogram panel, parked just above
  the BR zoom indicator.
- **Full-pixel scan, off-thread.** The pixel buffer is transferred (zero-
  copy) to a Web Worker so even 100+ MP images don't block the UI. Falls
  back to a chunked main-thread scan if the Worker can't spawn.
- Sqrt scale + masked-extreme-bins normalization so single 0/255 spikes
  (icons, screenshots) don't flatten the rest of the curve.
- Alpha curve overlays the RGB curves only when the image actually has
  translucency.
- **Session-scoped state lives in the extension host**, so opening a
  different image from Explorer (which spawns a fresh webview) keeps the
  histogram on. Resets only when VS Code reloads.
- Auto re-scan when navigating to a new image while toggled on. The
  previous histogram stays visible during the scan instead of flashing
  empty; stale scans from superseded images are discarded via a
  generation token.

## 0.1.0 — Browse & slideshow

- **Browse siblings** in the same folder with `←` / `→`. Sort criteria
  (`filename` / `mtime` / `ctime` / `size`) and direction (`asc` / `desc`)
  are configurable; only supported image formats are listed.
- **Slideshow** with `Space` to play/pause; `[` slows down, `]` speeds up
  (clamped 0.5–30 s). Default interval and wrap-around behavior are
  configurable.
- BL file card gets a position counter (`3 / 47`) when there's more than
  one image in the folder.
- BR zoom indicator gains an inline play indicator (`▶ 1.5s · 100%`) when
  slideshow is running.
- Image-swap logic uses a generation token so rapid ←/→ presses don't race.

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
