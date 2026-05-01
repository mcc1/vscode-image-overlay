// Minimal PNG chunk walker. PNG layout:
//   8-byte signature: 89 50 4E 47 0D 0A 1A 0A
//   Then a sequence of chunks until IEND:
//     [length:u32 BE][type:4 ASCII][data:length bytes][crc:u32]
//
// We only care about a few chunks:
//   cICP — codec-independent code points (HDR signal: same enums as nclx).
//          Payload is 4 bytes: primaries:u8, transfer:u8, matrix:u8,
//          fullRange:u8 (0 or 1). When present, this is the authoritative
//          colour signal for the PNG, beating any iCCP profile.
//   iCCP — embedded ICC profile. We extract only the human-readable
//          profile name (latin-1, null-terminated) — that's enough to
//          show "Display P3" / "Adobe RGB" without a zlib decoder.
//
// CRC validation is skipped: a tampered CRC doesn't change the visual
// label we'd surface, and decoders typically render anyway.

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export interface PngChunk {
  type: string;
  data: Uint8Array;
}

export function* walkPngChunks(buf: ArrayBuffer | Uint8Array): Iterable<PngChunk> {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 8) return;
  for (let i = 0; i < 8; i++) if (u8[i] !== PNG_SIGNATURE[i]) return;

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 8;
  while (p + 12 <= u8.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    const dataStart = p + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > u8.length) return; // truncated
    yield { type, data: u8.subarray(dataStart, dataEnd) };
    if (type === 'IEND') return;
    p = dataEnd + 4; // skip CRC
  }
}

export interface PngCicp {
  primaries: number;
  transfer: number;
  matrix: number;
  fullRange: boolean;
}

export function findPngCicp(buf: ArrayBuffer | Uint8Array): PngCicp | null {
  for (const c of walkPngChunks(buf)) {
    if (c.type !== 'cICP') continue;
    if (c.data.length < 4) return null;
    return {
      primaries: c.data[0],
      transfer: c.data[1],
      matrix: c.data[2],
      fullRange: c.data[3] === 1,
    };
  }
  return null;
}

export function findPngIccpName(buf: ArrayBuffer | Uint8Array): string | null {
  for (const c of walkPngChunks(buf)) {
    if (c.type !== 'iCCP') continue;
    let end = 0;
    while (end < c.data.length && c.data[end] !== 0) end++;
    if (end === 0 || end >= c.data.length) return null;
    // Latin-1 — TextDecoder('latin1') is widely supported.
    return new TextDecoder('latin1').decode(c.data.subarray(0, end));
  }
  return null;
}
