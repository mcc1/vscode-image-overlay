import { describe, it, expect } from 'vitest';
import { parseIsoBmffNclx } from '../src/webview/lib/iso-bmff.js';

// Builds a regular box: [size:u32 BE][type:4 ASCII][payload bytes].
function box(type: string, payload: Uint8Array): Uint8Array {
  const size = 8 + payload.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

// Concatenate Uint8Arrays.
function cat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// Helper: build a `colr` box with `nclx` subtype + four enums.
function nclxColr(primaries: number, transfer: number, matrix: number, fullRange: boolean): Uint8Array {
  const payload = new Uint8Array(11);
  payload[0] = 'n'.charCodeAt(0);
  payload[1] = 'c'.charCodeAt(0);
  payload[2] = 'l'.charCodeAt(0);
  payload[3] = 'x'.charCodeAt(0);
  const dv = new DataView(payload.buffer);
  dv.setUint16(4, primaries);
  dv.setUint16(6, transfer);
  dv.setUint16(8, matrix);
  payload[10] = fullRange ? 0x80 : 0x00;
  return box('colr', payload);
}

// FullBox-prefixed meta: 4 bytes of version+flags then children.
function metaBox(...children: Uint8Array[]): Uint8Array {
  const payload = cat(new Uint8Array(4), ...children);
  return box('meta', payload);
}

// Convenience: a complete file with nclx wrapped in iprp/ipco/meta and
// preceded by a stub `ftyp` box (real files always have one).
function makeFile(colr: Uint8Array, prefix: Uint8Array[] = []): Uint8Array {
  const ftyp = box('ftyp', new Uint8Array(8)); // four-char major brand + minor version, zeroed
  const ipco = box('ipco', cat(...prefix, colr));
  const iprp = box('iprp', ipco);
  const meta = metaBox(iprp);
  return cat(ftyp, meta);
}

describe('parseIsoBmffNclx', () => {
  it('extracts Rec.2020 PQ HDR10 enum triple', () => {
    const file = makeFile(nclxColr(9, 16, 9, true));
    expect(parseIsoBmffNclx(file)).toEqual({
      primaries: 9, transfer: 16, matrix: 9, fullRange: true,
    });
  });

  it('extracts Rec.2020 HLG enum triple', () => {
    const file = makeFile(nclxColr(9, 18, 9, false));
    expect(parseIsoBmffNclx(file)).toEqual({
      primaries: 9, transfer: 18, matrix: 9, fullRange: false,
    });
  });

  it('extracts Display P3 enum triple', () => {
    const file = makeFile(nclxColr(12, 13, 1, false));
    expect(parseIsoBmffNclx(file)).toEqual({
      primaries: 12, transfer: 13, matrix: 1, fullRange: false,
    });
  });

  it('skips a colr-rICC box and finds the nclx that follows', () => {
    // iCC profile colr boxes use subtype "rICC" — must be skipped.
    const ricc = box('colr', cat(
      new Uint8Array([0x72, 0x49, 0x43, 0x43]), // 'rICC'
      new Uint8Array([0x00, 0x00, 0x00, 0x00]), // dummy ICC payload
    ));
    const file = makeFile(nclxColr(1, 13, 1, false), [ricc]);
    expect(parseIsoBmffNclx(file)).toEqual({
      primaries: 1, transfer: 13, matrix: 1, fullRange: false,
    });
  });

  it('returns null when no meta box exists', () => {
    const ftyp = box('ftyp', new Uint8Array(8));
    const mdat = box('mdat', new Uint8Array(16));
    expect(parseIsoBmffNclx(cat(ftyp, mdat))).toBeNull();
  });

  it('returns null when meta has no iprp/ipco/colr', () => {
    const meta = metaBox(box('hdlr', new Uint8Array(20)));
    expect(parseIsoBmffNclx(cat(box('ftyp', new Uint8Array(8)), meta))).toBeNull();
  });

  it('returns null when colr is present but only rICC subtype', () => {
    const ricc = box('colr', cat(
      new Uint8Array([0x72, 0x49, 0x43, 0x43]),
      new Uint8Array(8),
    ));
    const ipco = box('ipco', ricc);
    const iprp = box('iprp', ipco);
    const meta = metaBox(iprp);
    expect(parseIsoBmffNclx(cat(box('ftyp', new Uint8Array(8)), meta))).toBeNull();
  });

  it('handles a 64-bit largesize box header', () => {
    // size==1 means the next 8 bytes are the actual u64 size. Build a
    // ftyp using the largesize form so the parser has to skip past it
    // before finding meta.
    const innerPayload = new Uint8Array(8);
    const largeSize = 16 + innerPayload.length; // 8 (size+type) + 8 (largesize) + payload
    const ftypLarge = new Uint8Array(largeSize);
    const dv = new DataView(ftypLarge.buffer);
    dv.setUint32(0, 1); // size=1 → largesize follows
    ftypLarge.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
    dv.setUint32(8, 0);             // largesize hi
    dv.setUint32(12, largeSize);    // largesize lo
    ftypLarge.set(innerPayload, 16);

    const meta = metaBox(box('iprp', box('ipco', nclxColr(1, 13, 1, false))));
    expect(parseIsoBmffNclx(cat(ftypLarge, meta))).toEqual({
      primaries: 1, transfer: 13, matrix: 1, fullRange: false,
    });
  });

  it('ignores truncated input gracefully', () => {
    expect(parseIsoBmffNclx(new Uint8Array(8))).toBeNull();
    expect(parseIsoBmffNclx(new Uint8Array(0))).toBeNull();
  });

  it('accepts both ArrayBuffer and Uint8Array', () => {
    const file = makeFile(nclxColr(9, 16, 9, true));
    expect(parseIsoBmffNclx(file.buffer)).toEqual({
      primaries: 9, transfer: 16, matrix: 9, fullRange: true,
    });
    expect(parseIsoBmffNclx(file)).toEqual({
      primaries: 9, transfer: 16, matrix: 9, fullRange: true,
    });
  });
});
