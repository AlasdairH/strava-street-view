/*
 * Renders the extension icons: a Strava-orange rounded square with a white map
 * pin. Kept as a script so the PNGs can be regenerated from the shapes rather
 * than hand-edited. Run with: node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;

const ORANGE = [0xfc, 0x52, 0x00];
const WHITE = [0xff, 0xff, 0xff];

/* ---------------------------------------------------------------- *
 * Shapes, expressed in a 0..1 unit square
 * ---------------------------------------------------------------- */

const CORNER = 0.22;
const HEAD = { x: 0.5, y: 0.42, outer: 0.185, inner: 0.078 };
const TIP = { y: 0.815, halfWidth: 0.133, shoulderY: 0.5 };

const inRoundedSquare = (x, y) => {
  const dx = Math.max(CORNER - x, 0, x - (1 - CORNER));
  const dy = Math.max(CORNER - y, 0, y - (1 - CORNER));
  return dx * dx + dy * dy <= CORNER * CORNER;
};

const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

// The pin's tail: a triangle from the widest point of the head down to the tip.
const inTail = (x, y) => {
  if (y < TIP.shoulderY || y > TIP.y) return false;
  const t = (y - TIP.shoulderY) / (TIP.y - TIP.shoulderY);
  const halfWidth = TIP.halfWidth * (1 - t);
  return Math.abs(x - HEAD.x) <= halfWidth;
};

/** Returns [r, g, b, a] for a point, or null where the icon is transparent. */
function sample(x, y) {
  if (!inRoundedSquare(x, y)) return null;

  const inHead = inCircle(x, y, HEAD.x, HEAD.y, HEAD.outer);
  const inHole = inCircle(x, y, HEAD.x, HEAD.y, HEAD.inner);
  const isPin = (inHead && !inHole) || inTail(x, y);

  return isPin ? WHITE : ORANGE;
}

/* ---------------------------------------------------------------- *
 * Rasterise
 * ---------------------------------------------------------------- */

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SUPERSAMPLE);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;

      // Supersample: the average of the sub-samples gives the coverage, which
      // becomes alpha, and the average of the covered ones gives the colour.
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px * SUPERSAMPLE + sx + 0.5) * step;
          const y = (py * SUPERSAMPLE + sy + 0.5) * step;
          const colour = sample(x, y);
          if (!colour) continue;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          hits++;
        }
      }

      const total = SUPERSAMPLE * SUPERSAMPLE;
      const offset = (py * size + px) * 4;
      if (hits === 0) continue;
      pixels[offset] = Math.round(r / hits);
      pixels[offset + 1] = Math.round(g / hits);
      pixels[offset + 2] = Math.round(b / hits);
      pixels[offset + 3] = Math.round((hits / total) * 255);
    }
  }

  return pixels;
}

/* ---------------------------------------------------------------- *
 * Minimal PNG writer (8-bit RGBA, no interlacing)
 * ---------------------------------------------------------------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(pixels, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // Each scanline is prefixed with its filter type; 0 means "none".
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, encodePng(render(size), size));
  console.log(`wrote ${file}`);
}
