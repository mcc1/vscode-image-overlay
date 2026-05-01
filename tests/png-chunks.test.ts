import { describe, it, expect } from 'vitest';
import {
  walkPngChunks, findPngCicp, findPngIccpName,
} from '../src/webview/lib/png-chunks.js';

const SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  // CRC is intentionally left as zero — walker doesn't validate.
  return out;
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

const IHDR = chunk('IHDR', new Uint8Array(13));
const IEND = chunk('IEND', new Uint8Array(0));

describe('walkPngChunks', () => {
  it('iterates IHDR through IEND on a valid PNG', () => {
    const file = cat(SIG, IHDR, IEND);
    const types = [...walkPngChunks(file)].map((c) => c.type);
    expect(types).toEqual(['IHDR', 'IEND']);
  });

  it('emits no chunks when signature is wrong', () => {
    const bad = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, ...IHDR, ...IEND]);
    expect([...walkPngChunks(bad)]).toEqual([]);
  });

  it('stops cleanly on truncated chunk header', () => {
    const file = cat(SIG, IHDR.subarray(0, 5));
    expect([...walkPngChunks(file)]).toEqual([]);
  });

  it('stops at IEND even if there are trailing bytes', () => {
    const file = cat(SIG, IHDR, IEND, new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    const types = [...walkPngChunks(file)].map((c) => c.type);
    expect(types).toEqual(['IHDR', 'IEND']);
  });
});

describe('findPngCicp', () => {
  it('finds cICP with HDR10 enum', () => {
    const cicp = chunk('cICP', new Uint8Array([9, 16, 9, 1]));
    expect(findPngCicp(cat(SIG, IHDR, cicp, IEND))).toEqual({
      primaries: 9, transfer: 16, matrix: 9, fullRange: true,
    });
  });

  it('reads fullRange=false correctly', () => {
    const cicp = chunk('cICP', new Uint8Array([1, 13, 1, 0]));
    expect(findPngCicp(cat(SIG, IHDR, cicp, IEND))).toEqual({
      primaries: 1, transfer: 13, matrix: 1, fullRange: false,
    });
  });

  it('returns null when cICP is absent', () => {
    expect(findPngCicp(cat(SIG, IHDR, IEND))).toBeNull();
  });

  it('returns null when cICP has fewer than 4 bytes', () => {
    const short = chunk('cICP', new Uint8Array([1, 13]));
    expect(findPngCicp(cat(SIG, IHDR, short, IEND))).toBeNull();
  });
});

describe('findPngIccpName', () => {
  it('reads a null-terminated profile name', () => {
    const name = 'Display P3';
    const payload = new Uint8Array(name.length + 1 + 1 + 4);
    for (let i = 0; i < name.length; i++) payload[i] = name.charCodeAt(i);
    payload[name.length] = 0;       // null terminator
    payload[name.length + 1] = 0;   // compression method
    // Bytes after the compression method are the deflate-compressed profile;
    // we don't care about them, just want to confirm parsing stops at NUL.
    const iccp = chunk('iCCP', payload);
    expect(findPngIccpName(cat(SIG, IHDR, iccp, IEND))).toBe('Display P3');
  });

  it('returns null when iCCP is absent', () => {
    expect(findPngIccpName(cat(SIG, IHDR, IEND))).toBeNull();
  });

  it('returns null when iCCP starts with NUL (empty name)', () => {
    const iccp = chunk('iCCP', new Uint8Array([0, 0, 0, 0]));
    expect(findPngIccpName(cat(SIG, IHDR, iccp, IEND))).toBeNull();
  });
});
