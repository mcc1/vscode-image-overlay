// Generates media/icon.png — a minimal 128×128 icon showing
// an image canvas with four corner overlay cards.
// Standalone: uses only Node built-ins (zlib, buffer, fs).

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const W = 128, H = 128;
const data = Buffer.alloc(W * H * 4);

function inRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const rx = x < left + radius ? left + radius - x : x > right - radius ? x - (right - radius) : 0;
  const ry = y < top + radius ? top + radius - y : y > bottom - radius ? y - (bottom - radius) : 0;
  return Math.sqrt(rx * rx + ry * ry) <= radius;
}

const CARD_W = 34, CARD_H = 20, PAD = 12, CARD_R = 4, CANVAS_R = 18;
const cards = [
  { x: PAD, y: PAD },
  { x: W - PAD - CARD_W, y: PAD },
  { x: PAD, y: H - PAD - CARD_H },
  { x: W - PAD - CARD_W, y: H - PAD - CARD_H },
];

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (!inRoundedRect(x, y, 0, 0, W - 1, H - 1, CANVAS_R)) {
      data[i + 3] = 0;
      continue;
    }

    // Gradient background (dark blue-grey)
    const t = y / H;
    const bgR = Math.round(28 + (18 - 28) * t);
    const bgG = Math.round(30 + (22 - 30) * t);
    const bgB = Math.round(38 + (30 - 38) * t);

    let r = bgR, g = bgG, b = bgB, a = 255;

    for (const c of cards) {
      if (inRoundedRect(x, y, c.x, c.y, c.x + CARD_W - 1, c.y + CARD_H - 1, CARD_R)) {
        // Frosted glass card
        r = 235; g = 236; b = 240; a = 255;
        break;
      }
    }

    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
  }
}

// PNG framing
const rowLen = 1 + W * 4;
const raw = Buffer.alloc(rowLen * H);
for (let y = 0; y < H; y++) {
  raw[y * rowLen] = 0; // filter: None
  data.copy(raw, y * rowLen + 1, y * W * 4, (y + 1) * W * 4);
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, body])), 0);
  return Buffer.concat([len, typeBuf, body, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type: RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = 'media/icon.png';
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
