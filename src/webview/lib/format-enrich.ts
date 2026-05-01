// Dispatch by file extension to the right colour-signal parser, and shape
// the result as keys we spread onto state.exif:
//   ProfileDescription — friendly colour-space label (consumed by
//                        describeColorSpace, which already prefers it).
//   __hdrFormat        — synthetic key picked up by detectHdr.

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
    // iCCP profile name is the only "Display P3" signal on iPhone/Android PNG screenshots.
    const name = findPngIccpName(buf);
    if (name) out.ProfileDescription = name;
    return out;
  }

  return out;
}
