// Friendly labels for ITU-T H.273 colour enums (the same triple appears
// in HEIC/AVIF nclx boxes and PNG cICP chunks). The matrix coefficient is
// kept in the input shape because callers carry it around, but it almost
// never affects the human-readable label — only primaries + transfer do.
//
// References:
//  - H.273 Table 2 (colour primaries): 1=BT.709, 9=BT.2020, 12=Display P3
//  - H.273 Table 3 (transfer):         1=BT.709, 13=sRGB/IEC 61966-2-1,
//                                      16=SMPTE ST 2084 (PQ), 18=ARIB STD-B67 (HLG)

export interface ColourTriple {
  primaries: number;
  transfer: number;
  matrix: number;
}

// Map common (primaries, transfer) pairs to the labels users expect to see
// in the file card. Ordered so HDR variants are matched before SDR ones.
export function describeColourTriple(t: { primaries: number; transfer: number }): string {
  const { primaries: p, transfer: tr } = t;
  if (p === 9 && tr === 16) return 'Rec.2020 PQ';
  if (p === 9 && tr === 18) return 'Rec.2020 HLG';
  if (p === 12 && tr === 13) return 'Display P3';
  if (p === 1 && tr === 13) return 'sRGB';
  if (p === 1 && tr === 1) return 'Rec.709';
  // Fallback: name the gamut alone when transfer doesn't match a known combo.
  if (p === 1) return 'Rec.709';
  if (p === 9) return 'Rec.2020';
  if (p === 12) return 'P3';
  return '';
}

// 16=PQ (HDR10), 18=HLG. These are the only transfer values that actually
// signal HDR in real-world AVIF/HEIC/PNG files we expect to see.
export function isHdrTransfer(transfer: number): boolean {
  return transfer === 16 || transfer === 18;
}

// Specific HDR system label. Empty string when the transfer isn't HDR.
export function describeHdrFromTransfer(transfer: number): string {
  if (transfer === 16) return 'HDR10 (PQ)';
  if (transfer === 18) return 'HLG';
  return '';
}
