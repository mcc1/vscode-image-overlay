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
