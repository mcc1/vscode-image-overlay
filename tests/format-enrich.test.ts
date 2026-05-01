import { describe, it, expect } from 'vitest';
import { enrichFromBytes } from '../src/webview/lib/format-enrich.js';

// --- Helpers (mirrored from iso-bmff / png-chunks tests, kept local so
// each test file stands alone) ---

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

function nclxColr(p: number, t: number, m: number, fr: boolean): Uint8Array {
  const payload = new Uint8Array(11);
  payload[0] = 'n'.charCodeAt(0); payload[1] = 'c'.charCodeAt(0);
  payload[2] = 'l'.charCodeAt(0); payload[3] = 'x'.charCodeAt(0);
  const dv = new DataView(payload.buffer);
  dv.setUint16(4, p); dv.setUint16(6, t); dv.setUint16(8, m);
  payload[10] = fr ? 0x80 : 0;
  return box('colr', payload);
}

function makeIsoFile(colr: Uint8Array): Uint8Array {
  const meta = box('meta', cat(new Uint8Array(4), box('iprp', box('ipco', colr))));
  return cat(box('ftyp', new Uint8Array(8)), meta);
}

const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  return out;
}

const IHDR = pngChunk('IHDR', new Uint8Array(13));
const IEND = pngChunk('IEND', new Uint8Array(0));

// --- Tests ---

describe('enrichFromBytes — HEIC/AVIF/HEIF', () => {
  it('produces Display P3 ProfileDescription with no HDR for (12, 13, 1)', () => {
    const file = makeIsoFile(nclxColr(12, 13, 1, false));
    expect(enrichFromBytes(file, 'avif')).toEqual({
      ProfileDescription: 'Display P3',
    });
  });

  it('produces Rec.2020 PQ + HDR10 (PQ) for (9, 16, 9)', () => {
    const file = makeIsoFile(nclxColr(9, 16, 9, true));
    expect(enrichFromBytes(file, 'heic')).toEqual({
      ProfileDescription: 'Rec.2020 PQ',
      __hdrFormat: 'HDR10 (PQ)',
    });
  });

  it('produces Rec.2020 HLG + HLG for (9, 18, 9)', () => {
    const file = makeIsoFile(nclxColr(9, 18, 9, false));
    expect(enrichFromBytes(file, 'heif')).toEqual({
      ProfileDescription: 'Rec.2020 HLG',
      __hdrFormat: 'HLG',
    });
  });

  it('returns empty object for HEIC with no nclx', () => {
    expect(enrichFromBytes(new Uint8Array(8), 'heic')).toEqual({});
  });
});

describe('enrichFromBytes — PNG', () => {
  it('reads cICP and prefers it over iCCP', () => {
    const cicp = pngChunk('cICP', new Uint8Array([9, 16, 9, 1]));
    // Throw an iCCP in too — cICP wins.
    const iccpName = 'sRGB IEC61966-2.1';
    const iccpData = new Uint8Array(iccpName.length + 1 + 1);
    for (let i = 0; i < iccpName.length; i++) iccpData[i] = iccpName.charCodeAt(i);
    const iccp = pngChunk('iCCP', iccpData);
    const file = cat(PNG_SIG, IHDR, cicp, iccp, IEND);
    expect(enrichFromBytes(file, 'png')).toEqual({
      ProfileDescription: 'Rec.2020 PQ',
      __hdrFormat: 'HDR10 (PQ)',
    });
  });

  it('falls back to iCCP profile name when no cICP present', () => {
    const name = 'Display P3';
    const data = new Uint8Array(name.length + 1 + 1);
    for (let i = 0; i < name.length; i++) data[i] = name.charCodeAt(i);
    const iccp = pngChunk('iCCP', data);
    const file = cat(PNG_SIG, IHDR, iccp, IEND);
    expect(enrichFromBytes(file, 'png')).toEqual({
      ProfileDescription: 'Display P3',
    });
  });

  it('returns empty for PNG with neither cICP nor iCCP', () => {
    const file = cat(PNG_SIG, IHDR, IEND);
    expect(enrichFromBytes(file, 'png')).toEqual({});
  });
});

describe('enrichFromBytes — unsupported extensions', () => {
  it('returns empty for jpg/jpeg/etc', () => {
    expect(enrichFromBytes(new Uint8Array(64), 'jpg')).toEqual({});
    expect(enrichFromBytes(new Uint8Array(64), 'webp')).toEqual({});
    expect(enrichFromBytes(new Uint8Array(64), 'tiff')).toEqual({});
  });

  it('is case-insensitive on the extension', () => {
    const file = makeIsoFile(nclxColr(12, 13, 1, false));
    expect(enrichFromBytes(file, 'AVIF')).toEqual({
      ProfileDescription: 'Display P3',
    });
  });
});
