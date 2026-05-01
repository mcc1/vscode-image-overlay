// Friendly labels for ITU-T H.273 enums shared by HEIC/AVIF nclx and PNG cICP.
// Only (primaries, transfer) drive the label — matrix is carried for symmetry
// with the source triple but doesn't change the user-visible string.

export function describeColourTriple(t: { primaries: number; transfer: number }): string {
  const { primaries: p, transfer: tr } = t;
  if (p === 9 && tr === 16) return 'Rec.2020 PQ';
  if (p === 9 && tr === 18) return 'Rec.2020 HLG';
  if (p === 12 && tr === 13) return 'Display P3';
  if (p === 1 && tr === 13) return 'sRGB';
  if (p === 1 && tr === 1) return 'Rec.709';
  if (p === 9) return 'Rec.2020';
  if (p === 12) return 'P3';
  if (p === 1) return 'Rec.709';
  return '';
}

// transfer 16 = PQ (HDR10), 18 = HLG. Empty string when not HDR.
export function describeHdrFromTransfer(transfer: number): string {
  if (transfer === 16) return 'HDR10 (PQ)';
  if (transfer === 18) return 'HLG';
  return '';
}
