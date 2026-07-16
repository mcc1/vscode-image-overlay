// HEIC/HEIF decode worker. Lives in its own bundle (~1.5 MB with libheif's
// embedded WASM) so the main viewer.js stays lean — this file is only
// fetched when the user actually opens a .heic / .heif image.
//
// Persistent multi-request worker (perf plan 方案 B): the main thread spawns
// this worker ONCE per webview session and keeps it alive across images
// instead of terminate()-ing it per file. WASM instantiation (the `import`
// below) is the ~100-400ms we're now paying exactly once instead of once
// per HEIC. Requests are multiplexed over the single worker using an `id`
// the caller assigns and we echo back on the response.
//
// Protocol:
//   in  → { id: number, buffer: ArrayBuffer }
//   out → { id: number, ok: true,  rgba: Uint8ClampedArray, width, height, hasAlpha }
//      or { id: number, ok: false, error: string }
// The worker never terminates itself and never lets one bad file poison
// later requests — every request is wrapped in its own try/catch and
// answered independently under its own id.

// libheif-js exposes a CommonJS factory; cast through `unknown` to keep
// the call site honest. The wasm-bundle entry inlines the WASM as base64,
// so this single import pulls everything we need. This is also where the
// expensive WASM instantiation happens — it runs once, when this worker
// script is first evaluated (i.e. when the persistent worker is created),
// not per file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as libheifNs from 'libheif-js/wasm-bundle';

interface LibheifImage {
  get_width(): number;
  get_height(): number;
  // Releases the native heif_image_handle backing this JS wrapper. Cheap
  // (it's metadata, not decoded pixels — display() already frees the
  // decoded pixel buffer itself once copied out) but still a WASM-heap
  // resource, so it needs releasing per request now that the worker isn't
  // thrown away (and its whole WASM heap along with it) after one file.
  free(): void;
  display(
    out: { data: Uint8ClampedArray; width: number; height: number },
    // libheif-js passes null here when the pixel-plane decode itself fails
    // (container parsed fine, bitstream didn't) — a rarer corruption mode
    // than decode() returning no images at all, but one we still need to
    // turn into an {ok:false} response instead of throwing inside the
    // setTimeout callback display() schedules internally (which is not
    // covered by onmessage's try/catch since it runs later, async).
    cb: (display: { data: Uint8ClampedArray } | null) => void,
  ): void;
}
interface LibheifDecoder {
  decode(buffer: ArrayBuffer): LibheifImage[];
}
interface LibheifModule {
  HeifDecoder: new () => LibheifDecoder;
}

const libheif = libheifNs as unknown as LibheifModule;

interface DecodeRequest {
  id: number;
  buffer: ArrayBuffer;
}
type DecodeResponse =
  | { id: number; ok: true; rgba: Uint8ClampedArray; width: number; height: number; hasAlpha: boolean }
  | { id: number; ok: false; error: string };

// Lazily created on the first request, then reused for every request after
// that — reuse, not a fresh instance per file, is the point of going
// persistent. This is safe because HeifDecoder.decode() manages its own
// native heif_context lifetime: reading libheif-js's own source (the
// minified `Yj.prototype.decode` in libheif-bundle.js) shows it frees the
// PREVIOUS context before allocating a new one on every call —
// `this.decoder && heif_context_free(this.decoder)` runs, then
// `this.decoder = heif_context_alloc()` — so calling .decode() repeatedly
// on one instance is the library's own intended reuse pattern, not
// something we're bending it into. What does NOT get cleaned up
// automatically is the per-image heif_image_handle objects decode()
// returns (see the free() calls below) — those are lightweight, but with
// no worker.terminate() to reclaim them for free anymore, an unfreed
// handle per file would otherwise accumulate for the life of the webview
// session.
let decoder: LibheifDecoder | null = null;
function getDecoder(): LibheifDecoder {
  if (!decoder) decoder = new libheif.HeifDecoder();
  return decoder;
}

// The id of the request currently being processed, or null between requests.
// libheif's display() runs the real pixel decode from an INTERNAL setTimeout,
// so a throw there lands after onmessage has returned — outside its try/catch —
// and would otherwise crash the whole persistent worker. The global 'error'
// handler below turns such a throw into an {ok:false} for this id instead.
// Single-threaded, strictly-sequential request processing keeps it unambiguous.
let currentId: number | null = null;

self.addEventListener('error', (ev: ErrorEvent) => {
  // Swallow the uncaught error so it doesn't propagate to the main thread's
  // Worker.onerror (which tears this persistent worker down) and fail only the
  // in-flight request — the worker stays alive to serve the next id.
  ev.preventDefault();
  const id = currentId;
  currentId = null;
  if (id != null) respondError(id, ev.message || 'libheif: deferred decode crashed');
});

self.onmessage = (e: MessageEvent<DecodeRequest>) => {
  const { id, buffer } = e.data;
  currentId = id;
  // Held so a SYNC throw before display()'s callback takes ownership (a corrupt
  // file can throw in get_width / display() itself) frees the primary handle
  // instead of leaking it. Once display() is scheduled without throwing, its
  // callback owns freeing and nulls this so the finally below won't re-free.
  let image: LibheifImage | null = null;
  let scheduled = false;
  try {
    const images = getDecoder().decode(buffer);
    if (!images || images.length === 0) {
      throw new Error('libheif: no images in file');
    }
    const primary = images[0];
    image = primary;
    // We only ever render images[0] (same selection as before). Release
    // every other top-level image's handle immediately instead of letting
    // it sit unreferenced-but-unfreed in the WASM heap.
    for (let i = 1; i < images.length; i++) images[i].free();

    const w = primary.get_width();
    const h = primary.get_height();
    const rgba = new Uint8ClampedArray(w * h * 4);
    primary.display({ data: rgba, width: w, height: h }, (display) => {
      try {
        if (!display) {
          respondError(id, 'libheif: display() decode failed');
          return;
        }
        // Detect translucency once during decode — saves a separate pass on
        // the main thread later. HEIC is often opaque (camera output) so
        // this is usually trivially false.
        let hasAlpha = false;
        for (let i = 3; i < display.data.length; i += 4) {
          if (display.data[i] < 255) { hasAlpha = true; break; }
        }
        const response: DecodeResponse = { id, ok: true, rgba: display.data, width: w, height: h, hasAlpha };
        (self as unknown as Worker).postMessage(response, [display.data.buffer]);
      } finally {
        // Free the primary handle on every callback branch, and null the outer
        // ref so the onmessage finally can't double-free it under any ordering.
        primary.free();
        image = null;
        if (currentId === id) currentId = null;
      }
    });
    // display() returned without throwing — its callback now owns freeing the
    // handle and clearing currentId.
    scheduled = true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    respondError(id, message);
  } finally {
    // Sync-throw path only: display()'s callback will never run, so free the
    // primary handle here and release currentId. When scheduled, both are the
    // callback's (or, on a deferred crash, the global 'error' guard's) job.
    if (!scheduled) {
      if (image) image.free();
      if (currentId === id) currentId = null;
    }
  }
};

function respondError(id: number, error: string): void {
  const response: DecodeResponse = { id, ok: false, error };
  (self as unknown as Worker).postMessage(response);
}
