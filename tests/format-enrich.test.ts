// enrichFromBytes is a thin dispatcher — the underlying parsers are
// covered by their own test files. We only verify the dispatch shape:
// HEIC nclx → both keys, PNG cICP→iCCP fallback chain, unknown ext is a no-op.

import { describe, it, expect } from 'vitest';
import { enrichFromBytes } from '../src/webview/lib/format-enrich.js';

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.length);
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

function makeHeic(primaries: number, transfer: number, matrix: number, fullRange: boolean): Uint8Array {
  const colr = new Uint8Array(11);
  colr.set([0x6e, 0x63, 0x6c, 0x78]);
  const dv = new DataView(colr.buffer);
  dv.setUint16(4, primaries); dv.setUint16(6, transfer); dv.setUint16(8, matrix);
  colr[10] = fullRange ? 0x80 : 0;
  const meta = box('meta', cat(new Uint8Array(4), box('iprp', box('ipco', box('colr', colr)))));
  return cat(box('ftyp', new Uint8Array(8)), meta);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  return out;
}

const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const IHDR = pngChunk('IHDR', new Uint8Array(13));
const IEND = pngChunk('IEND', new Uint8Array(0));

describe('enrichFromBytes', () => {
  it('HEIC with HDR10 nclx produces both ProfileDescription and __hdrFormat', () => {
    expect(enrichFromBytes(makeHeic(9, 16, 9, true), 'heic')).toEqual({
      ProfileDescription: 'Rec.2020 PQ',
      __hdrFormat: 'HDR10 (PQ)',
    });
  });

  it('PNG cICP wins over iCCP when both present', () => {
    const cicp = pngChunk('cICP', new Uint8Array([12, 13, 1, 0]));
    const iccp = pngChunk('iCCP', new Uint8Array([0x73, 0x52, 0x47, 0x42, 0])); // "sRGB\0"
    expect(enrichFromBytes(cat(PNG_SIG, IHDR, cicp, iccp, IEND), 'png')).toEqual({
      ProfileDescription: 'Display P3',
    });
  });

  it('PNG falls back to iCCP profile name when no cICP', () => {
    const name = 'Display P3';
    const data = new Uint8Array(name.length + 1);
    for (let i = 0; i < name.length; i++) data[i] = name.charCodeAt(i);
    expect(enrichFromBytes(cat(PNG_SIG, IHDR, pngChunk('iCCP', data), IEND), 'png')).toEqual({
      ProfileDescription: 'Display P3',
    });
  });

  it('returns {} for unsupported extensions and case-insensitive matches', () => {
    expect(enrichFromBytes(new Uint8Array(64), 'jpg')).toEqual({});
    expect(enrichFromBytes(makeHeic(12, 13, 1, false), 'AVIF')).toEqual({
      ProfileDescription: 'Display P3',
    });
  });
});
