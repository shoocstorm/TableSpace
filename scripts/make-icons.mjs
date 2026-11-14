// Draws the PWA icons (the same three bars as public/icon.svg) as PNGs, with
// no image library: run `bun scripts/make-icons.mjs` after changing the icon.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};

const BG = [7, 11, 20];
const CYAN = [34, 211, 238];
const VIOLET = [167, 139, 250];
const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));

/** `pad` is the share of the icon left empty around the bars (maskable icons need more). */
function png(size, pad, rounded) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const inRound = (x, y, x0, y0, x1, y1, r) => {
    if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
    const cx = x < x0 + r ? x0 + r : x >= x1 - r ? x1 - r : x;
    const cy = y < y0 + r ? y0 + r : y >= y1 - r ? y1 - r : y;
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const x0 = size * pad;
  const x1 = size * (1 - pad);
  const h = (size * (1 - 2 * pad)) / 4;
  const gap = h / 2;
  const bars = [
    [CYAN, 1],
    [CYAN, 0.55],
    [VIOLET, 0.8],
  ];
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      let color = BG;
      let alpha = !rounded || inRound(x, y, 0, 0, size, size, size * 0.22) ? 255 : 0;
      bars.forEach(([c, a], i) => {
        const y0 = size * pad + i * (h + gap);
        if (inRound(x, y, x0, y0, x1, y0 + h, h * 0.28)) color = mix(BG, c, a);
      });
      raw.set([...color, alpha], row + 1 + x * 4);
    }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

writeFileSync('public/icon-192.png', png(192, 0.22, true));
writeFileSync('public/icon-512.png', png(512, 0.22, true));
writeFileSync('public/icon-maskable-512.png', png(512, 0.3, false));
writeFileSync('public/apple-touch-icon.png', png(180, 0.24, false));
console.log('[make-icons] wrote public/icon-*.png and apple-touch-icon.png');
