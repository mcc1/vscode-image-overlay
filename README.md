# Image Overlay Preview

Preview images in VS Code with EXIF and file metadata shown as **unobtrusive
glass overlays in the four corners** — the image stays center stage, no sidebar
eating your horizontal space.

## Why

The built-in VS Code image preview only shows dimensions in the status bar.
Existing metadata extensions compress the image into a narrow column by
docking a sidebar panel. This extension keeps the image at full size and
shows metadata as small floating cards that land in the **emptiest corners**
of the image — auto-detected via corner luminance analysis.

## Features

- **Corner-aware placement.** Each corner of the image is sampled for visual
  complexity; denser info cards go to flatter areas.
- **Two semantic cards.** A *file* card (filename, format, size, dimensions,
  megapixels, aspect ratio) and a *capture* card (camera, lens, shutter, f/,
  ISO, date, GPS) — related info stays grouped.
- **Idle auto-fade.** After 2.5 s of no activity, overlays dim to 8% so you
  can just look at the image. Any mouse/keyboard activity brings them back
  instantly.
- **Corner-local fade.** When your cursor approaches a specific corner, only
  *that* corner dims (to 10%) — the others stay visible.
- **Expanded EXIF mode.** Press <kbd>E</kbd> to replace one corner with a
  full EXIF table (camera, lens, exposure, GPS, copyright, software…).
- **Fully hideable.** Press <kbd>I</kbd> to toggle all overlays off for a
  clean view.
- **Zoom & pan.** Scroll to zoom, drag to pan, <kbd>0</kbd> to reset,
  double-click to reset.

## Supported formats

Natively renderable: `PNG`, `JPG/JPEG`, `GIF`, `BMP`, `WebP`, `AVIF`, `ICO`.
EXIF parsing (via [`exifr`](https://github.com/MikeKovarik/exifr)) works on
JPEG / TIFF / HEIC / WebP. TIFF rendering is not yet supported — add a TIFF
decoder for v1.

## Keybindings

| Key                    | Action                                      |
| ---------------------- | ------------------------------------------- |
| <kbd>I</kbd>           | Toggle all overlays                         |
| <kbd>E</kbd>           | Toggle expanded EXIF panel                  |
| <kbd>0</kbd>           | Reset zoom / pan                            |
| <kbd>+</kbd> / <kbd>-</kbd> | Zoom in / out                         |
| <kbd>Ctrl+Shift+I</kbd> | Toggle overlay (works without focusing image) |
| scroll                 | Zoom                                        |
| drag                   | Pan                                         |
| double-click           | Reset zoom                                  |

## Settings

| Setting                             | Default | Description                                |
| ----------------------------------- | ------- | ------------------------------------------ |
| `imageOverlay.defaultVisible`       | `true`  | Show overlay by default when opening.      |
| `imageOverlay.autoContrast`         | `true`  | Adapt overlay contrast to local background. |
| `imageOverlay.showHintOnOpen`       | `true`  | Briefly show the keyboard-shortcut hint.   |

## Install (local / private)

```bash
git clone <this repo>
cd vscode-image-overlay
npm install
npm run build
npx vsce package
code --install-extension image-overlay-preview-0.0.1.vsix
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
