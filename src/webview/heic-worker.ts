// HEIC/HEIF decode worker. Lives in its own bundle (~1.5 MB with libheif's
// embedded WASM) so the main viewer.js stays lean — this file is only
// fetched when the user actually opens a .heic / .heif image.
//
// Protocol:
//   in  → { buffer: ArrayBuffer }
//   out → { ok: true,  rgba: Uint8ClampedArray, width, height, hasAlpha }
//      or { ok: false, error: string }

// libheif-js exposes a CommonJS factory; cast through `unknown` to keep
// the call site honest. The wasm-bundle entry inlines the WASM as base64,
// so this single import pulls everything we need.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as libheifNs from 'libheif-js/wasm-bundle';

interface LibheifImage {
  get_width(): number;
  get_height(): number;
  display(
    out: { data: Uint8ClampedArray; width: number; height: number },
    cb: (display: { data: Uint8ClampedArray }) => void,
  ): void;
}
interface LibheifDecoder {
  decode(buffer: ArrayBuffer): LibheifImage[];
}
interface LibheifModule {
  HeifDecoder: new () => LibheifDecoder;
}

const libheif = libheifNs as unknown as LibheifModule;

self.onmessage = (e: MessageEvent<{ buffer: ArrayBuffer }>) => {
  try {
    const decoder = new libheif.HeifDecoder();
    const images = decoder.decode(e.data.buffer);
    if (!images || images.length === 0) {
      throw new Error('libheif: no images in file');
    }
    const image = images[0];
    const w = image.get_width();
    const h = image.get_height();
    const rgba = new Uint8ClampedArray(w * h * 4);
    image.display({ data: rgba, width: w, height: h }, (display) => {
      // Detect translucency once during decode — saves a separate pass on
      // the main thread later. HEIC is often opaque (camera output) so
      // this is usually trivially false.
      let hasAlpha = false;
      for (let i = 3; i < display.data.length; i += 4) {
        if (display.data[i] < 255) { hasAlpha = true; break; }
      }
      (self as unknown as Worker).postMessage(
        { ok: true, rgba: display.data, width: w, height: h, hasAlpha },
        [display.data.buffer],
      );
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    (self as unknown as Worker).postMessage({ ok: false, error: message });
  }
};
