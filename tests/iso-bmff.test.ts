import { describe, it, expect } from 'vitest';
import { parseIsoBmffNclx } from '../src/webview/lib/iso-bmff.js';

function box(type: string, payload: Uint8Array): Uint8Array {
  const size = 8 + payload.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function nclxColr(primaries: number, transfer: number, matrix: number, fullRange: boolean): Uint8Array {
  const payload = new Uint8Array(11);
  payload.set([0x6e, 0x63, 0x6c, 0x78]); // 'nclx'
  const dv = new DataView(payload.buffer);
  dv.setUint16(4, primaries);
  dv.setUint16(6, transfer);
  dv.setUint16(8, matrix);
  payload[10] = fullRange ? 0x80 : 0x00;
  return box('colr', payload);
}

// meta is a FullBox: 4-byte version+flags then children.
function metaBox(...children: Uint8Array[]): Uint8Array {
  return box('meta', cat(new Uint8Array(4), ...children));
}

function makeFile(colr: Uint8Array, prefix: Uint8Array[] = []): Uint8Array {
  const ipco = box('ipco', cat(...prefix, colr));
  return cat(box('ftyp', new Uint8Array(8)), metaBox(box('iprp', ipco)));
}

// A bare 8-byte box header with an arbitrary (possibly special: 0 or 1,
// or just huge) size field — box() above always writes a normal size,
// so the size-0 / size-1 / oversized conventions need a raw builder.
function rawHeader(type: string, sizeField: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setUint32(0, sizeField);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  return out;
}

// A size==1 box: 4-byte size marker (1), 4-byte type, then the explicit
// 64-bit largesize as (hi, lo) 32-bit halves — matches how walkBoxes
// reads it and avoids float-precision loss when a test wants a largesize
// that deliberately overflows Number.MAX_SAFE_INTEGER. No payload: the
// largesize always describes exactly this 16-byte header.
function box64(type: string, hi: number, lo: number): Uint8Array {
  const out = new Uint8Array(16);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 1);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  dv.setUint32(8, hi);
  dv.setUint32(12, lo);
  return out;
}

describe('parseIsoBmffNclx', () => {
  it('extracts the four real-world enum triples', () => {
    expect(parseIsoBmffNclx(makeFile(nclxColr(9, 16, 9, true)))).toEqual({
      primaries: 9, transfer: 16, matrix: 9, fullRange: true,
    });
    expect(parseIsoBmffNclx(makeFile(nclxColr(9, 18, 9, false)))).toEqual({
      primaries: 9, transfer: 18, matrix: 9, fullRange: false,
    });
    expect(parseIsoBmffNclx(makeFile(nclxColr(12, 13, 1, false)))).toEqual({
      primaries: 12, transfer: 13, matrix: 1, fullRange: false,
    });
  });

  it('skips colr-rICC and finds the nclx that follows', () => {
    const ricc = box('colr', cat(new Uint8Array([0x72, 0x49, 0x43, 0x43]), new Uint8Array(4)));
    expect(parseIsoBmffNclx(makeFile(nclxColr(1, 13, 1, false), [ricc]))).toEqual({
      primaries: 1, transfer: 13, matrix: 1, fullRange: false,
    });
  });

  it('returns null when no nclx anywhere', () => {
    const ftyp = box('ftyp', new Uint8Array(8));
    expect(parseIsoBmffNclx(cat(ftyp, box('mdat', new Uint8Array(16))))).toBeNull();
    expect(parseIsoBmffNclx(cat(ftyp, metaBox(box('hdlr', new Uint8Array(20)))))).toBeNull();
  });

  it('falls back to byte-pattern scan when colr lives outside meta/iprp/ipco', () => {
    // Samsung HDR multi-frame HEIC nests colr deep under moov/trak/.../hvc1;
    // we don't walk that path. Synthesize the equivalent: a colr-nclx box
    // sitting at top level with no meta around it.
    const file = cat(
      box('ftyp', new Uint8Array(8)),
      box('mdat', new Uint8Array(64)),
      nclxColr(9, 16, 9, true),
    );
    expect(parseIsoBmffNclx(file)).toEqual({
      primaries: 9, transfer: 16, matrix: 9, fullRange: true,
    });
  });

  it('ignores truncated input gracefully', () => {
    expect(parseIsoBmffNclx(new Uint8Array(8))).toBeNull();
    expect(parseIsoBmffNclx(new Uint8Array(0))).toBeNull();
  });

  it('accepts both ArrayBuffer and Uint8Array', () => {
    const file = makeFile(nclxColr(9, 16, 9, true));
    const expected = { primaries: 9, transfer: 16, matrix: 9, fullRange: true };
    expect(parseIsoBmffNclx(file.buffer)).toEqual(expected);
    expect(parseIsoBmffNclx(file)).toEqual(expected);
  });
});

// 2026-07-16 review: walkBoxes used to `return` (abort the whole walk)
// the instant it saw a box size of 0 or 1, instead of handling either
// per the ISOBMFF spec. Size 0 ("extends to end of enclosing structure")
// and size 1 ("real size is a 64-bit largesize in the next 8 bytes") are
// both legitimate on real-world files.
describe('parseIsoBmffNclx — size-0 / size-1 / oversized box sizes', () => {
  it('processes a trailing size-0 (extends-to-EOF) box without throwing, and still recovers via the byte-scan fallback', () => {
    // Per spec, size 0 means "this box owns every remaining byte" —
    // nothing declared after it (including meta) is structurally
    // reachable any more, so the properly-nested meta/iprp/ipco/colr
    // that follows can only come back via the module's documented
    // byte-pattern fallback. What this guards against: the walker
    // throwing, hanging, or reading out of bounds while processing the
    // size-0 header itself.
    const file = cat(
      box('ftyp', new Uint8Array(8)),
      rawHeader('mdat', 0),
      metaBox(box('iprp', box('ipco', nclxColr(9, 16, 9, true)))),
    );
    expect(() => parseIsoBmffNclx(file)).not.toThrow();
    expect(parseIsoBmffNclx(file)).toEqual({ primaries: 9, transfer: 16, matrix: 9, fullRange: true });
  });

  it('a lone size-0 box mid-walk yields no false match and does not throw', () => {
    const ipco = box('ipco', rawHeader('free', 0));
    const file = cat(box('ftyp', new Uint8Array(8)), metaBox(box('iprp', ipco)));
    expect(() => parseIsoBmffNclx(file)).not.toThrow();
    expect(parseIsoBmffNclx(file)).toBeNull();
  });

  it('walks past a valid size-1 (64-bit largesize) box to reach the meta that follows', () => {
    // A decoy nclx sits unstructured at the top level with different
    // values. If the walker still aborted on the size-1 box (the old
    // bug — size 1 was treated as "< 8", an instant walk-abort), meta
    // would never be reached, parseIsoBmffNclx would fall through to
    // the byte-scan fallback, and the decoy (earlier in the buffer)
    // is what would come back. Getting the REAL values below proves
    // the structured walk survived the size-1 box and found meta
    // directly.
    const decoy = nclxColr(1, 1, 1, false);
    const real = metaBox(box('iprp', box('ipco', nclxColr(9, 16, 9, true))));
    const file = cat(box('ftyp', new Uint8Array(8)), decoy, box64('free', 0, 16), real);
    expect(parseIsoBmffNclx(file)).toEqual({ primaries: 9, transfer: 16, matrix: 9, fullRange: true });
  });

  it('stops safely (no throw, no OOB) when a size-1 largesize exceeds the buffer or overflows Number.MAX_SAFE_INTEGER', () => {
    const exceedsBuffer = cat(box('ftyp', new Uint8Array(8)), box64('free', 0, 999_999_999));
    expect(() => parseIsoBmffNclx(exceedsBuffer)).not.toThrow();
    expect(parseIsoBmffNclx(exceedsBuffer)).toBeNull();

    // hi=0xFFFFFFFF alone pushes largesize (hi*2**32+lo) far past
    // Number.MAX_SAFE_INTEGER.
    const unsafeInteger = cat(box('ftyp', new Uint8Array(8)), box64('free', 0xffffffff, 0));
    expect(() => parseIsoBmffNclx(unsafeInteger)).not.toThrow();
    expect(parseIsoBmffNclx(unsafeInteger)).toBeNull();
  });

  it('stops safely (no throw, no OOB) on an oversized plain 32-bit size field', () => {
    const file = cat(box('ftyp', new Uint8Array(8)), rawHeader('free', 0xfffffff0));
    expect(() => parseIsoBmffNclx(file)).not.toThrow();
    expect(parseIsoBmffNclx(file)).toBeNull();
  });
});
