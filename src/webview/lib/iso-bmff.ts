// Minimal ISOBMFF box walker, scoped to "find the colour box".
// Covers HEIC, HEIF, AVIF (still + first frame of sequences) — every
// container we render that uses the `nclx` colour signal.
//
// Path we walk: top-level → `meta` (FullBox: 4-byte version+flags header
// before children) → `iprp` → `ipco` → first `colr` box whose subtype
// is `nclx`. The nclx payload is 7 bytes:
//   colour_primaries:u16
//   transfer_characteristics:u16
//   matrix_coefficients:u16
//   full_range_flag — top bit of the next byte (rest reserved)
//
// We deliberately don't walk `ipma` to map properties to the primary
// item: in real-world phone HEIC/AVIF the primary's nclx is always the
// first `colr` in `ipco`, and getting that wrong would only surface as
// a slightly mislabelled colour space — not a bug worth a 200-line
// parser for.

export interface NclxColour {
  primaries: number;
  transfer: number;
  matrix: number;
  fullRange: boolean;
}

interface Box {
  type: string;
  payloadStart: number;
  payloadEnd: number;
}

function readType(u8: Uint8Array, p: number): string {
  return String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
}

// Iterate boxes in the half-open range [start, end). Bails on truncated
// or impossibly-sized boxes — better to return nothing than to misread
// later bytes as a box header.
function* walkBoxes(u8: Uint8Array, start: number, end: number): Iterable<Box> {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = readType(u8, p + 4);
    let headerSize = 8;
    if (size === 1) {
      // 64-bit largesize follows the type. We can't address >4GB ranges
      // anyway, so if the high word is non-zero just stop walking.
      if (p + 16 > end) return;
      const hi = dv.getUint32(p + 8);
      const lo = dv.getUint32(p + 12);
      if (hi !== 0) return;
      size = lo;
      headerSize = 16;
    } else if (size === 0) {
      // "Box extends to end of containing container."
      size = end - p;
    }
    if (size < headerSize || p + size > end) return;
    yield { type, payloadStart: p + headerSize, payloadEnd: p + size };
    p += size;
  }
}

function findBox(u8: Uint8Array, type: string, start: number, end: number): Box | null {
  for (const b of walkBoxes(u8, start, end)) {
    if (b.type === type) return b;
  }
  return null;
}

export function parseIsoBmffNclx(buf: ArrayBuffer | Uint8Array): NclxColour | null {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 16) return null;

  const meta = findBox(u8, 'meta', 0, u8.length);
  if (!meta) return null;
  // meta is a FullBox — 4 bytes of version+flags before children.
  const iprp = findBox(u8, 'iprp', meta.payloadStart + 4, meta.payloadEnd);
  if (!iprp) return null;
  const ipco = findBox(u8, 'ipco', iprp.payloadStart, iprp.payloadEnd);
  if (!ipco) return null;

  for (const b of walkBoxes(u8, ipco.payloadStart, ipco.payloadEnd)) {
    if (b.type !== 'colr') continue;
    if (b.payloadEnd - b.payloadStart < 11) continue; // 4 (subtype) + 7 (nclx)
    const sub = readType(u8, b.payloadStart);
    if (sub !== 'nclx') continue;
    const dv = new DataView(u8.buffer, u8.byteOffset + b.payloadStart + 4, 7);
    return {
      primaries: dv.getUint16(0),
      transfer: dv.getUint16(2),
      matrix: dv.getUint16(4),
      fullRange: (dv.getUint8(6) & 0x80) !== 0,
    };
  }
  return null;
}
