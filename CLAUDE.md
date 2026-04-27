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
- `src/provider.ts` — `CustomReadonlyEditorProvider`; builds the webview HTML,
  sets CSP, wires `localResourceRoots` to the image's directory.
- `src/webview/main.ts` — runs in the webview. Responsibilities:
  - Load the image via `<img>`.
  - Parse EXIF/IPTC/XMP client-side with `exifr` (bundled into `dist/viewer.js`).
  - Render four corner overlays (TL filename/format, TR dimensions, BL camera/shot,
    BR date/GPS).
  - Sample corner luminance from a downsampled canvas to pick light/dark glass.
  - Handle zoom (wheel), pan (drag), keyboard (`i`/`e`/`0`/`+`/`-`).
- `media/viewer.css` — glass-style overlay styling; uses VS Code theme variables
  as the page background but keeps overlay colors fixed for image readability.
- `esbuild.mjs` — two entrypoints: extension (node/cjs, `vscode` external) and
  webview (browser/iife, bundles exifr).

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
resolve. `connect-src ${cspSource}` is required because `main.ts` does
`fetch(imageUri)` to get the bytes for `exifr.parse`. Don't loosen CSP further
without a reason.

## Format coverage
`<img>` in webview handles PNG/JPG/GIF/BMP/WebP/AVIF/ICO natively. TIFF is
registered but currently renders as broken — needs a decoder (e.g. `utif`) in a
future pass. EXIF parsing via exifr works on JPG/TIFF/HEIC/WebP regardless of
whether the `<img>` can render it.

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
