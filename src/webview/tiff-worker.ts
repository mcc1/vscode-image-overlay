// TIFF/TIF decode worker. Small bundle (utif is ~30 KB) mirroring
// heic-worker.ts's persistent-worker shape (perf plan 方案 B): TIFF used to
// decode on the main thread via utif directly inside main.ts, blocking the
// UI on large files; moving it off-thread into a worker the main thread
// spawns once and keeps alive for the whole webview session avoids both
// that main-thread stall and repeated Worker-spawn overhead per file.
//
// Protocol:
//   in  → { id: number, buffer: ArrayBuffer }
//   out → { id: number, ok: true,  rgba: Uint8Array, width, height, hasAlpha }
//      or { id: number, ok: false, error: string }
// The worker never terminates itself and never lets one bad file poison
// later requests — every request is wrapped in its own try/catch and
// answered independently under its own id.

// utif is CJS but esbuild handles interop; the namespace import gives us
// the decode / decodeImage / toRGBA8 functions — same import main.ts used
// for its main-thread TIFF path. Unlike libheif, utif has no decoder
// object with native state to instantiate/reuse — decode/decodeImage/
// toRGBA8 are plain functions — so there's no analogous "reuse a decoder
// instance" question here. Going persistent still pays off by not
// respawning the worker (and re-running its module init) per file.
import * as UTIF from 'utif';

interface DecodeRequest {
  id: number;
  buffer: ArrayBuffer;
}
type DecodeResponse =
  | { id: number; ok: true; rgba: Uint8Array; width: number; height: number; hasAlpha: boolean }
  | { id: number; ok: false; error: string };

self.onmessage = (e: MessageEvent<DecodeRequest>) => {
  const { id, buffer } = e.data;
  try {
    const ifds = UTIF.decode(buffer);
    if (!ifds.length) throw new Error('no IFDs in TIFF');
    const ifd = ifds[0];
    UTIF.decodeImage(buffer, ifd);
    const rgba = UTIF.toRGBA8(ifd);
    const w = ifd.width;
    const h = ifd.height;

    // Runs off-thread, so a full scan costs nothing the UI would feel.
    let hasAlpha = false;
    for (let i = 3; i < rgba.length; i += 4) {
      if (rgba[i] < 255) { hasAlpha = true; break; }
    }

    const response: DecodeResponse = { id, ok: true, rgba, width: w, height: h, hasAlpha };
    (self as unknown as Worker).postMessage(response, [rgba.buffer]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const response: DecodeResponse = { id, ok: false, error: message };
    (self as unknown as Worker).postMessage(response);
  }
};
