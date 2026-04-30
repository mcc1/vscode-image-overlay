# Image Overlay Preview — VS Code Extension

## What this is
A VS Code extension that replaces the built-in image preview with a webview that
displays EXIF / metadata as **unobtrusive glass overlays in the four corners**
of the image, instead of a sidebar panel that eats horizontal space.

Core differentiator vs existing extensions (Image Details, Image Metadata
Viewer, etc.): **image stays center stage, info is peripheral**. Sidebar-based
competitors compress the image; corner overlays don't.

## Architecture
- `src/extension.ts` — activation, registers the custom editor and commands.
- `src/provider.ts` — `CustomReadonlyEditorProvider`. Builds the webview HTML,
  sets CSP, wires `localResourceRoots`, enumerates sibling images in the
  current folder (sorted per settings), and holds **session-scoped UI flags**
  (e.g. `histogramOn`) that need to survive a single-webview lifetime — the
  webview pushes back via `postMessage({ type: 'histogramToggle', value })`
  so the next image opened from Explorer inherits the state.
- `src/webview/main.ts` — runs in the webview. Responsibilities:
  - Load the image via `<img>`.
  - Parse EXIF/IPTC/XMP client-side with `exifr` (bundled into `dist/viewer.js`).
  - Render the **fixed-slot** overlay layout (TL capture / BL file / TR GPS /
    BR zoom). Slot assignment is no longer driven by emptiness ranking.
  - Sample corner luminance from a downsampled canvas to pick light/dark glass.
  - Browse siblings (`←`/`→`), slideshow (`Space` / `[` / `]`), zoom & pan,
    and a Web-Worker-based RGBA histogram (`H`).
  - Bounding-box-aware cursor-near fade — measures the rect of each overlay
    so the expanded EXIF panel's larger footprint is handled correctly.
- `media/viewer.css` — glass-style overlay styling; uses VS Code theme variables
  as the page background but keeps overlay colors fixed for image readability.
- `src/webview/heic-worker.ts` — separate Web Worker for HEIC/HEIF decode.
  Bundles `libheif-js/wasm-bundle` (~1.4 MB with WASM as base64). Lives in
  its own esbuild entry so `dist/heic-worker.js` is fetched only when the
  user actually opens a `.heic` / `.heif` file. Main thread spawns it via
  `new Worker(ctx.heicWorkerUri)`, transfers the file's ArrayBuffer in,
  receives RGBA pixels back via Transferable.
- `media/viewer.css` — glass-style overlay styling; uses VS Code theme variables
  as the page background but keeps overlay colors fixed for image readability.
- `esbuild.mjs` — three entrypoints: extension (node/cjs, `vscode` external),
  webview (browser/iife, bundles exifr + utif), and the HEIC worker (browser/
  iife, bundles libheif-js). The histogram worker is **not** a separate
  entrypoint — its source is a string inlined in main.ts and loaded via
  `Blob` URL.
- `.github/workflows/release.yml` — tag-driven CI that builds the vsix and
  attaches it to a GitHub release. See **Release process** below.

## Build
```
npm install
npm run build         # one-shot
npm run watch         # dev
npm run typecheck     # tsc --noEmit
```
Outputs to `dist/extension.js` and `dist/viewer.js`.

## Debugging
Open the project in VS Code, press F5 — launches an Extension Development Host.
Open any image file; the custom editor is `priority: default` so it replaces
the built-in preview. Use "Reopen With…" to switch back for comparison.

## CSP notes
Webview CSP is strict: `default-src 'none'`. The script nonce is generated per
resolve. Pieces that needed explicit allowance:
- `connect-src ${cspSource}` — `main.ts` does `fetch(imageUri)` to get the
  bytes for `exifr.parse` and TIFF/HEIC decode pipelines.
- `img-src https://*.tile.openstreetmap.org` — inline GPS map thumbnails.
- `script-src 'nonce-X' blob: 'wasm-unsafe-eval'` — `blob:` because both
  workers (histogram and HEIC) load from blob URLs;
  `'wasm-unsafe-eval'` for the HEIC worker, which
  `WebAssembly.instantiate()`s libheif's WASM blob.
- `worker-src blob:` is sufficient. We don't actually load workers from
  cspSource: webview-resource URIs are on a different origin
  (`https://*.vscode-cdn.net`) than the webview itself
  (`vscode-webview://...`), and `new Worker(url)` enforces same-origin.
  So the HEIC worker bundle is fetched as text and re-wrapped in a Blob
  before `new Worker(blobUrl)` — same trick the histogram worker uses
  with its inlined source string.

Don't loosen CSP further without a reason.

## Release process
**Marketplace (`vsce publish`) is NOT automated** — the publisher account
sits on a tenant whose Azure DevOps PAT issuance was blocked
(`AADSTS5000225`, "tenant blocked due to inactivity"). All publishes go
through the manual web upload at
`https://marketplace.visualstudio.com/manage/publishers/mcc`.

**GitHub side IS automated** via `.github/workflows/release.yml`. There's
a one-shot helper that drives the whole flow end-to-end:

```bash
# 0. Edit CHANGELOG.md and add a "## 0.1.2 — title" section. The workflow
#    extracts this section as the GitHub release body, so the heading
#    format must match: `^## <version> ` (space after the version).
# 1. Then:
npm run release            # patch bump
npm run release -- minor   # or minor / major
```

`scripts/release.mjs` does:
1. `npm version <bump>` — bumps package.json + creates the git tag.
2. `git push --follow-tags` — fires the workflow.
3. Polls `gh run list` until the matching CI run appears, then
   `gh run watch` to completion.
4. `gh release download <tag> --pattern "*.vsix" -D dist-release/` — pulls
   the freshly-built vsix back to the local machine (CI runs on Ubuntu,
   so the artifact has to come back over the wire).
5. Opens the marketplace publisher dashboard in the default browser; the
   user drags the vsix in to push live.

If you'd rather drive each step manually:

```bash
npm version patch
git push --follow-tags
# ...wait for CI...
gh release download "v$(node -p 'require(`./package.json`).version')" \
    --pattern "*.vsix" -D dist-release
```

Pushing the tag fires the `Release` workflow:
1. Sanity-checks `package.json` version equals the tag (`v0.1.2` ↔ `0.1.2`).
2. `npm ci` → `npm run typecheck` → `npm run package`.
3. Slices `CHANGELOG.md` between `## <ver>` and the next `## ` heading.
4. Creates / updates the GitHub release with the vsix attached and the
   sliced section as release notes.

`workflow_dispatch` is also wired up so a release can be re-built against
an existing tag without retagging — useful when the workflow itself needs
fixing or the vsix needs replacing.

**After the workflow finishes**, grab the vsix from the GitHub release and
drag it into the marketplace publisher dashboard to push live.

If the Azure tenant ever gets unblocked (or someone makes a PAT via a
different MS account), the `vsce publish -p $VSCE_PAT` step can be added
to the workflow and the manual upload step disappears.

## Format coverage

| Format | Renderer | Where in code |
| --- | --- | --- |
| PNG / JPG / GIF / BMP / WebP / AVIF / ICO / SVG | `<img>` native | `loadImageInto` non-decoder branch |
| TIFF / TIF | `utif` (~30 KB, eagerly bundled into viewer.js) | `decodeTiffToBlobUrl` in main.ts |
| HEIC / HEIF | `libheif-js` Web Worker (~1.4 MB, lazy chunk) | `decodeHeicToBlobUrl` + heic-worker.ts |

Decoded images go through the same blob-URL → `<img>.src` path so the rest
of the viewer (corner luminance, EXIF parse, histogram) doesn't care which
decoder produced the pixels. EXIF parsing via exifr works on
JPG / TIFF / HEIC / WebP regardless of whether the `<img>` could render it
without help.

### HDR / color space surfacing
- ICC profile parse is enabled (`icc: true` in the exifr call) so the
  file card can show "Display P3" / "Adobe RGB" / etc. Falls back to EXIF
  ColorSpace tag when no ICC profile is present.
- HDR detection only catches what exifr can read out of XMP today —
  UltraHDR's `hdrgm:Version` and Apple HDR's `apple:HDREncoding`. AVIF /
  HEIC HDR (signalled in the `nclx` colour box) and PNG `cICP` chunks
  would need raw byte parsers we haven't written.

## Design decisions worth preserving
- **No sidebar.** That's the whole pitch. Don't add a sidebar panel even for
  "expanded" mode — use a larger corner card or a full-screen modal instead.
- **Auto-contrast per corner.** Each overlay samples its own background region,
  not the image average. A bright sky corner and a dark ground corner on the
  same image should get different treatments.
- **EXIF parsing happens in the webview**, not the extension host. Keeps the
  host light and avoids passing arraybuffers across the postMessage boundary.
- **Readonly editor.** Metadata editing (strip EXIF, etc.) is out of scope for
  v0 — Image Details already does that and we're differentiating on viewing
  ergonomics, not editing.

## What's deliberately NOT here
- No gallery / folder browsing view (vscode-infra's Image Viewer covers that).
- No gutter / hover previews (kisstkondoros covers that).
- No metadata editing or EXIF stripping.
- No AI / ComfyUI workflow parsing.

## Competitive context (as of 2026-04)
| Extension | Display | Installs | Gap we fill |
|---|---|---|---|
| Image Details | Right sidebar | 349 | Eats horizontal space, old-school UI |
| Image Metadata Viewer | Separate HTML page | 1.2k | Table-dump UX, not inline |
| Image Metadata Inspector | Output panel text | 738 | Plain text dump |
| Image Viewer (vscode-infra) | Thumbnail grid | 88k | No metadata at all |
| Built-in VS Code preview | None | — | Only status-bar dimensions |
