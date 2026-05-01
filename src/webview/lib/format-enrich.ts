// Format-aware enrichment: given the raw bytes of a HEIC/AVIF/PNG file,
// pull out colour-space and HDR signals that exifr can't surface today,
// and shape them so the existing render path picks them up unchanged.
//
// Output shape: a Record we can spread onto `state.exif`. Two keys:
//   - `ProfileDescription` — friendly colour-space label. Populated whether
//      we got the signal from nclx (HEIC/AVIF/PNG cICP) or from a PNG
//      iCCP profile name. `describeColorSpace` already prefers this key,
//      so the file card "just works".
//   - `__hdrFormat` — synthetic key picked up by `detectHdr` (extended in
//      format.ts). Set only when transfer is PQ (16) or HLG (18).

import { parseIsoBmffNclx } from './iso-bmff.js';
import { findPngCicp, findPngIccpName } from './png-chunks.js';
import { describeColourTriple, describeHdrFromTransfer } from './color-coding.js';

export function enrichFromBytes(
  buf: ArrayBuffer | Uint8Array,
  ext: string,
): Record<string, unknown> {
  const e = ext.toLowerCase();
  const out: Record<string, unknown> = {};

  if (e === 'heic' || e === 'heif' || e === 'avif') {
    const nclx = parseIsoBmffNclx(buf);
    if (!nclx) return out;
    const label = describeColourTriple(nclx);
    if (label) out.ProfileDescription = label;
    const hdr = describeHdrFromTransfer(nclx.transfer);
    if (hdr) out.__hdrFormat = hdr;
    return out;
  }

  if (e === 'png') {
    const cicp = findPngCicp(buf);
    if (cicp) {
      const label = describeColourTriple(cicp);
      if (label) out.ProfileDescription = label;
      const hdr = describeHdrFromTransfer(cicp.transfer);
      if (hdr) out.__hdrFormat = hdr;
      return out;
    }
    // No cICP — fall back to iCCP profile name, which on real-world iPhone
    // / Android PNG screenshots is the only signal of "Display P3".
    const name = findPngIccpName(buf);
    if (name) out.ProfileDescription = name;
    return out;
  }

  return out;
}
