# Changelog

## 0.3.5 — TIFF/HEIC: worker decode, no transcode round-trip

The 0.3.3 perf work made PNG/JPG fast; this release does the heavy
formats.

- **HEIC browsing is near-instant.** ←/→ neighbors are pre-decoded into
  a bounded ImageBitmap cache (2 entries / 33 M pixels), and a swap that
  outruns the prefetch now rides the in-flight decode instead of
  decoding the same file twice.
- **TIFF decoding left the main thread.** Big TIFFs no longer freeze the
  UI while they decode (new lazy ~84 KB utif worker).
- **The PNG transcode round-trip is gone.** Decoded pixels draw straight
  onto a canvas instead of being re-encoded to PNG and re-decoded by
  `<img>` — that was seconds of pure waste on large files.
- **libheif's WASM instantiates once per viewer, not once per image**
  (persistent request-multiplexed workers). Workers spin up in parallel
  with the file read, self-terminate after 60 s idle so background tabs
  don't pin WASM heaps, and per-image decoder handles are freed — they
  would have leaked in a persistent worker.
- **TIFF/HEIC files are no longer read twice** (the doomed inline
  `<img src>` load is gone).
- **Mixed folders stay snappy.** Background pre-decoding only arms once
  you actually navigate inside a viewer (or opened a TIFF/HEIC
  directly), so Explorer-clicking JPGs that sit next to HEICs doesn't
  spin up background decode work.
- Live refresh (file overwritten on disk) invalidates the decoded
  cache, so navigating away and back can't show pre-edit pixels.

Expectation note: a single cold HEIC open is still bounded by the
libheif decode itself — the wins are everything around it (browsing,
UI responsiveness, repeated costs).

No new runtime dependencies. Tests stay at 74.

## 0.3.4 — EXIF accuracy, Windows live refresh, steadier slideshow

Ten verified findings from the 0.3.3 review, all fixed:

- **Fixed: spurious "Flash did not fire…" line on every non-flash
  photo.** The capture card matched flash strings against a phrase
  exifr never actually produces; it now recognizes the real translated
  strings. Test fixtures switched to real-world shapes so this can't
  silently regress.
- **Fixed: TIFF bit depth never displayed.** Real exifr reports TIFF
  `BitsPerSample` as an object (`{0:8,1:8,2:8}`), not a number — the
  file card now unwraps it and shows "8-bit RGB" as intended.
- **Fixed: live refresh was dead on Windows.** The file watcher passed
  a raw backslash path as a glob pattern, which never matches. It now
  watches the containing folder and filters events to the open file —
  overwriting an open image finally refreshes the view on Windows.
- **`imageOverlay.autoContrast` actually works now.** The setting
  existed but was never read. Off = fixed glass tint; alpha detection
  still runs so the RGB/RGBA line stays accurate.
- **Steadier slideshow.** The next tick is scheduled when the image
  actually finishes decoding (or fails), not when the swap starts — a
  short interval no longer races past slow-decoding images, and a
  broken file advances the show instead of stalling it.
- **No more stale color-mode flash during ←/→** — the previous image's
  RGB/RGBA no longer shows in the file card while the next one loads.
- **GPS map card survives expanded mode.** `E` now hides the BL/TR
  corners via CSS instead of tearing them down, so collapsing no longer
  rebuilds the map tiles.
- **GPS tooltip names your map provider** ("Open in Google Maps"), and
  the setting/README now say explicitly: the inline thumbnail always
  renders OpenStreetMap tiles — `gpsMapProvider` only picks where a
  click goes.
- **HDR detection survives odd ISOBMFF layouts.** Box size 0
  (extends-to-EOF) and 1 (64-bit size) no longer abort the container
  walk; parsing is overflow-guarded with new parser tests.
- Corner luminance sampling and alpha detection merged into a single
  downscaled pass before the first overlay paint; the CSP nonce now
  comes from crypto randomness instead of `Math.random`.

No new dependencies. Tests 66 → 74.

## 0.3.3 — Instant first paint, prefetched browsing

Perf release — opening and browsing got visibly faster, especially in
big folders — plus two correctness fixes found by the same review.

- **Opening no longer waits for the folder scan.** The provider used to
  stat every sibling image sequentially *before* building the webview,
  so in a folder with thousands of images the first pixel waited for
  all of them. The HTML now goes out right after a single stat of the
  opened file; siblings are enumerated with parallel stats and delivered
  to the webview afterwards over a ready/siblings handshake. In huge
  folders the `3 / 47` counter now pops in a beat after the image —
  that's the enumeration finishing, not the image.
- **←/→ and slideshow are near-instant.** The previous and next images
  are prefetched and pre-decoded (`Image()` + `decode()`) as soon as
  the current one settles, so stepping hits Chromium's decoded-image
  cache instead of starting from disk.
- **Smoother pan / zoom on high-polling-rate mice.** Wheel, drag-pan
  and the corner proximity fade used to do DOM writes plus a forced
  layout per input event (a 1000 Hz mouse ≈ 1000 layouts/s). They're
  now coalesced to one batch per animation frame, and overlay cards
  skip re-rendering when their content didn't change.
- **The metadata second-read is now bounded.** The color-space
  enrichment pass re-fetched the file with a Range header that the
  webview's service worker ignores — a 50 MB PNG got read (and
  allocated) in full a second time. It now stream-reads just the head
  (256 KB for PNG, 1 MB for ISOBMFF) and cancels the rest.
- **Fixed: fast ←/→ could paint the previous image's EXIF onto the
  next one.** EXIF parse results now commit through the same
  generation token the image swap uses, so a slow parse from image A
  can't land on image B.
- **Fixed: EXIF/XMP-derived strings rendered unescaped in the capture
  card** (white balance / flash / metering and the exposure line). A
  crafted image could inject markup into the webview — script execution
  was already blocked by CSP, but markup shouldn't render either. Same
  class of fix host-side: a filename containing `</script>` can no
  longer break out of the injected-context script block.

No new dependencies. Tests stay at 66; `viewer.js` grew ~1 KB.

## 0.3.2 — README catches up with 0.3.1

Doc-only release. README now mentions the cursor-centered zoom and the
pointer-capture pan that shipped in 0.3.1 — both were missed when 0.3.1
went out.

## 0.3.1 — Stickier pan, cursor-centered zoom

- **Fixed: image stuck following the cursor after releasing the mouse
  outside the webview / outside VS Code.** The drag handler used
  `mousedown`+`mouseup` on the iframe `window`, which silently misses
  the release event when it happens elsewhere. Switched to Pointer
  Events with `setPointerCapture` so the stage keeps receiving move/up
  no matter where the pointer ends up.
- **Fixed: native drag-and-drop ghost flickering during pan.** The
  browser was occasionally trying to start a "drag this image
  elsewhere" gesture on top of our pan. `<img draggable="false">` and
  `dragstart` preventDefault on the stage shut that down.
- **Scroll-wheel zoom is now cursor-centered.** Zooming keeps the
  image-space point under the pointer fixed, instead of growing /
  shrinking toward the stage centre. Keyboard zoom (`+` / `-`) still
  pivots on the stage centre — cursor pivot doesn't make sense there.

## 0.3.0 — Real wide-gamut / HDR detection

The file card no longer relies on EXIF's `ColorSpace` tag (which on
modern phones is almost always `Uncalibrated`) to label colour space.
A second enrichment pass after exifr reads each format's own colour
signal directly and folds it into the existing render path.

- **AVIF / HEIC / HEIF.** New `src/webview/lib/iso-bmff.ts` walks the
  ISOBMFF container down to the first `colr` box with `nclx` subtype,
  pulling out the `(primaries, transfer, matrix, full_range)` enum
  triple. Covered by 10 vitest cases over synthetic byte streams.
- **PNG.** New `src/webview/lib/png-chunks.ts` walks the chunk stream
  for `cICP` (HDR signal) and `iCCP` (ICC profile name fallback). 11
  vitest cases.
- **Friendly labels.** New `src/webview/lib/color-coding.ts` maps the
  ITU-T H.273 enums to the names users actually want to see —
  `Rec.2020 PQ`, `Rec.2020 HLG`, `Display P3`, `sRGB`, `Rec.709`. 12
  vitest cases.
- **HDR badge** now fires on AVIF / HEIC / PNG when transfer is PQ
  (16) or HLG (18), in addition to the existing UltraHDR / Apple HDR
  JPEG cases. The chip already existed; this just feeds it real data.
- **No new dependency.** The two parsers are ~120 lines combined and
  shipped in-tree under `lib/` — same pattern as the format helpers
  extracted in 0.2.6.

Test count: 43 → 86. Bundle (`viewer.js`) grew 366 KB → 372 KB.

## 0.2.7 — Fix swap-flash + smoother pan

- **Fixed: image flashed oversized during ←/→ swap (regression in 0.2.3).**
  `swapTo` clears `state.natural.w/h`, which makes `applyTransform` clear
  the inline width/height on `<img>` and fall back to CSS
  `max-width/max-height: 100%`. Those percentages don't bind unless the
  parent has a defined size — the flex-centered `#img-wrap` was
  content-sized, so tall images rendered at full natural height for one
  frame before `onImageReady` set explicit pixels. Fix: pin `#img-wrap`
  to `width: 100%; height: 100%`.
- **Smoother pan on overlay-heavy images.** `backdrop-filter` on the
  corner cards was being recomputed every frame as the sibling
  `#img-wrap`'s translate transform updated, causing visible stutter on
  large photos. Adding `will-change: transform` to `.overlay` promotes
  each card to its own composite layer so the blur can be cached.

## 0.2.6 — Tests + small EXIF caption fix

- **Tests.** Pure helpers extracted from `main.ts` into
  `src/webview/lib/format.ts` and covered by 43 vitest cases under
  `tests/`. `npm test` runs them; the release workflow now blocks
  shipping if a helper regresses (typecheck → test → package).
- Found a bug while writing the tests: `describeCaptureExtras` claimed
  to "only show WhiteBalance when non-Auto" but actually let any string
  through — so EXIF that wrote `WhiteBalance: "Auto"` showed up in the
  capture card. Now correctly hidden.
- No other behavior changes — this is groundwork for the v0.3.0
  ISOBMFF / cICP parsers (will land as new files under `lib/` with
  tests written first).

## 0.2.5 — Humanize ColorSpace=65535 in expanded EXIF

- Phones (Samsung HEIC especially) write `EXIF.ColorSpace = 65535`
  meaning "Uncalibrated" — the actual color profile lives in the HEIC
  `nclx` box. exifr doesn't translate this enum by default, so the
  expanded EXIF panel was showing a bare `65535`.
- The expanded panel now displays `sRGB` (1), `Adobe RGB` (2), or
  `Uncalibrated` (65535) instead of the raw integer. The file card was
  already skipping uncalibrated/unknown values, so it's unaffected.
- Reading the actual color space (and HDR transfer characteristics) out
  of the HEIC `nclx` box requires a small ISOBMFF box parser — coming
  in 0.3.0 alongside AVIF / PNG cICP HDR detection.

## 0.2.4 — Fix HEIC Worker spawn (same-origin policy)

- HEIC was still failing in 0.2.3 with "Failed to construct 'Worker':
  Script at 'https://...vscode-cdn.net/.../heic-worker.js' cannot be
  accessed from origin 'vscode-webview://...'". VS Code webview-resource
  URIs sit on a different origin from the webview document, and
  `new Worker(url)` enforces same-origin — so the worker spawn was
  failing before any of our code (or any CSP) got a chance to run.
- Fix: fetch the worker bundle as text, wrap it in a `Blob`, and spawn
  from the resulting blob URL. Blob URLs inherit the page origin, so
  same-origin passes. The blob URL is cached after first use so we
  don't re-fetch the 1.4 MB on every HEIC.

## 0.2.3 — Real fix for tile seams + visible decode errors

- Tile-seam fix in 0.2.2 was incomplete — wrapping `<img>` in a div
  doesn't prevent the GPU compositor from tiling the underlying bitmap
  when `transform: scale()` is applied to the wrapper. The seams still
  showed up during zoom transitions on big photos.
- Real fix: don't use `transform: scale()` for zoom at all. Set the
  `<img>`'s `width` / `height` in pixels directly. The browser
  rasterizes at the actual display size, no GPU compositor scale, no
  tiles, no seams. Pan still uses `transform: translate()` on the
  wrapper (translate doesn't tile).
- HEIC decode errors now surface the underlying error message in the
  TL card instead of a bare "HEIC decode failed". The `worker.onerror`
  handler also extracts message / filename / lineno from the
  `ErrorEvent` so cross-origin / WASM failures aren't swallowed.

## 0.2.2 — Fix 1px black lines on large scaled images

- Some users were seeing thin horizontal black lines bleeding through
  large photos that look fine in any other viewer. Root cause:
  Chromium's GPU compositor tiles `<img>` elements that exceed the
  max texture size, and tile boundaries become visible 1px seams at
  certain scale factors when the element is also being CSS-transformed.
- Fix: wrap `<img>` in a `#img-wrap` div and put the zoom/pan transform
  on the wrapper instead of the image. `<img>` stays at natural size
  on its own paint layer, so the compositor only rasterizes the smaller
  wrapper layer — no tile seams.

## 0.2.1 — Fix HEIC decode (CSP wasm-unsafe-eval)

- HEIC files were failing to decode in 0.2.0 with "HEIC decode failed"
  in the file card. Root cause: the CSP didn't allow WebAssembly
  compilation, so libheif's WASM never got past `WebAssembly.instantiate()`.
- Fix: add `'wasm-unsafe-eval'` to `script-src`. This is the modern,
  scope-limited directive (vs full `'unsafe-eval'`) and propagates to
  the HEIC worker through the parent webview's CSP.

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
