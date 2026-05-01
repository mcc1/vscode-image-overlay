// PNG chunk reader, scoped to the two chunks we care about:
//   cICP — HDR / wide-gamut signal (same enums as HEIC/AVIF nclx).
//   iCCP — ICC profile name (latin-1, NUL-terminated). Used as a colour-space
//          label fallback so we don't have to bundle a zlib decoder.
// CRCs aren't validated; the labels we surface don't depend on byte integrity.

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

interface PngChunk {
  type: string;
  data: Uint8Array;
}

function* walkPngChunks(buf: ArrayBuffer | Uint8Array): Iterable<PngChunk> {
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
    if (dataEnd + 4 > u8.length) return;
    yield { type, data: u8.subarray(dataStart, dataEnd) };
    if (type === 'IEND') return;
    p = dataEnd + 4;
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
    return new TextDecoder('latin1').decode(c.data.subarray(0, end));
  }
  return null;
}
