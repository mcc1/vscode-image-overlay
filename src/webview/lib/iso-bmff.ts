// Find the first `colr nclx` box in a HEIC/HEIF/AVIF file.
// Two-pass: a structured walk down meta/iprp/ipco for HEIF stills, then a
// byte-pattern scan as a fallback for files (Samsung HDR HEIC, iPhone Live
// Photos, AVIF sequences) that nest the box deep inside moov/trak/.../hvc1.
// We don't walk ipma to map properties to the primary item — the primary's
// nclx is always the first one we find on real-world phone captures.

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

function* walkBoxes(u8: Uint8Array, start: number, end: number): Iterable<Box> {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = start;
  while (p + 8 <= end) {
    const size32 = dv.getUint32(p);
    const type = readType(u8, p + 4);
    let headerSize = 8;
    let boxSize: number;
    if (size32 === 0) {
      // ISOBMFF: size 0 means "this box extends to the end of the
      // enclosing structure" (a trailing top-level mdat whose length
      // wasn't known at write time). Consume the rest of the slice; the
      // while loop then ends naturally on the next check.
      boxSize = end - p;
    } else if (size32 === 1) {
      // ISOBMFF: size 1 means the real size is a 64-bit "largesize" in
      // the 8 bytes right after the type, so the header is 16 bytes.
      if (p + 16 > end) return;
      const hi = dv.getUint32(p + 8);
      const lo = dv.getUint32(p + 12);
      const largesize = hi * 0x100000000 + lo;
      if (!Number.isSafeInteger(largesize) || largesize < 16 || largesize > end - p) return;
      headerSize = 16;
      boxSize = largesize;
    } else if (size32 < 8 || p + size32 > end) {
      // Genuinely malformed: below the minimum box header size, or
      // claims more bytes than remain in this slice.
      return;
    } else {
      boxSize = size32;
    }
    yield { type, payloadStart: p + headerSize, payloadEnd: p + boxSize };
    p += boxSize;
  }
}

function findBox(u8: Uint8Array, type: string, start: number, end: number): Box | null {
  for (const b of walkBoxes(u8, start, end)) {
    if (b.type === type) return b;
  }
  return null;
}

function readNclxAt(u8: Uint8Array, off: number): NclxColour {
  const dv = new DataView(u8.buffer, u8.byteOffset + off, 7);
  return {
    primaries: dv.getUint16(0),
    transfer: dv.getUint16(2),
    matrix: dv.getUint16(4),
    fullRange: (dv.getUint8(6) & 0x80) !== 0,
  };
}

// Fallback: scan for the literal byte sequence 'colrnclx' preceded by a
// sane 4-byte size. Used when the structured walk misses (boxes nested
// inside moov/trak/.../hvc1). 1/2^64 collision rate on random codec bytes.
function scanForNclx(u8: Uint8Array): NclxColour | null {
  for (let i = 4; i + 15 <= u8.length; i++) {
    if (u8[i] !== 0x63 || u8[i + 1] !== 0x6f ||
        u8[i + 2] !== 0x6c || u8[i + 3] !== 0x72) continue;
    if (u8[i + 4] !== 0x6e || u8[i + 5] !== 0x63 ||
        u8[i + 6] !== 0x6c || u8[i + 7] !== 0x78) continue;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const size = dv.getUint32(i - 4);
    if (size < 19 || size > 256) continue;
    return readNclxAt(u8, i + 8);
  }
  return null;
}

export function parseIsoBmffNclx(buf: ArrayBuffer | Uint8Array): NclxColour | null {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 16) return null;

  const meta = findBox(u8, 'meta', 0, u8.length);
  if (meta) {
    // meta is a FullBox — 4 bytes of version+flags before children.
    const iprp = findBox(u8, 'iprp', meta.payloadStart + 4, meta.payloadEnd);
    if (iprp) {
      const ipco = findBox(u8, 'ipco', iprp.payloadStart, iprp.payloadEnd);
      if (ipco) {
        for (const b of walkBoxes(u8, ipco.payloadStart, ipco.payloadEnd)) {
          if (b.type !== 'colr') continue;
          if (b.payloadEnd - b.payloadStart < 11) continue;
          if (readType(u8, b.payloadStart) !== 'nclx') continue;
          return readNclxAt(u8, b.payloadStart + 4);
        }
      }
    }
  }

  return scanForNclx(u8);
}
