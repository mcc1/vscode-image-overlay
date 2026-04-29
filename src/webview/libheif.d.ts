// Minimal ambient declaration for libheif-js/wasm-bundle. The package
// ships no types (no @types either) and we only touch the HeifDecoder
// surface — declare just that shape so TypeScript stops complaining.
declare module 'libheif-js/wasm-bundle' {
  export class HeifDecoder {
    decode(buffer: ArrayBuffer): HeifImage[];
  }
  export interface HeifImage {
    get_width(): number;
    get_height(): number;
    display(
      out: { data: Uint8ClampedArray; width: number; height: number },
      cb: (display: { data: Uint8ClampedArray }) => void,
    ): void;
  }
}
