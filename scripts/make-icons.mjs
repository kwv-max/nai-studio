// Generates the PWA icons (PNG + SVG) with no dependencies: `node scripts/make-icons.mjs`.
// Design: indigo rounded square, a white open book, and a small spark.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG_TOP = [92, 108, 230];
const BG_BOTTOM = [58, 66, 168];
const WHITE = [255, 255, 255];
const SPARK = [255, 214, 102];

/** Shapes in a 0..1 coordinate space. `inset` shrinks the artwork for maskable icons. */
function shapes(inset) {
  const s = (v) => inset + v * (1 - inset * 2);
  return [
    // left page
    { poly: [[0.2, 0.34], [0.49, 0.4], [0.49, 0.76], [0.2, 0.7]].map(([x, y]) => [s(x), s(y)]), color: WHITE },
    // right page
    { poly: [[0.51, 0.4], [0.8, 0.34], [0.8, 0.7], [0.51, 0.76]].map(([x, y]) => [s(x), s(y)]), color: WHITE },
    // spark (4-point star)
    {
      poly: [[0.5, 0.12], [0.535, 0.215], [0.63, 0.25], [0.535, 0.285], [0.5, 0.38], [0.465, 0.285], [0.37, 0.25], [0.465, 0.215]].map(([x, y]) => [s(x), s(y)]),
      color: SPARK,
    },
  ];
}

function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function render(size, { rounded, inset }) {
  const SS = 4; // supersampling per axis
  const px = new Uint8Array(size * size * 4);
  const list = shapes(inset);
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (pxl + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (rounded && !inRoundRect(x, y, 0.22)) continue;
          const t = y;
          let c = BG_TOP.map((v, i) => v + (BG_BOTTOM[i] - v) * t);
          for (const sh of list) if (inPoly(x, y, sh.poly)) c = sh.color;
          r += c[0]; g += c[1]; b += c[2]; a += 255;
        }
      }
      const n = SS * SS;
      const o = (py * size + pxl) * 4;
      const cov = a / n / 255;
      px[o] = cov ? r / (n * cov) : 0;
      px[o + 1] = cov ? g / (n * cov) : 0;
      px[o + 2] = cov ? b / (n * cov) : 0;
      px[o + 3] = a / n;
    }
  }
  return png(size, size, px);
}

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function svg() {
  const pts = (poly) => poly.map(([x, y]) => `${(x * 512).toFixed(1)},${(y * 512).toFixed(1)}`).join(' ');
  const [l, r, spark] = shapes(0);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgb(${BG_TOP})"/><stop offset="1" stop-color="rgb(${BG_BOTTOM})"/></linearGradient></defs>
<rect width="512" height="512" rx="113" fill="url(#g)"/>
<polygon points="${pts(l.poly)}" fill="#fff"/><polygon points="${pts(r.poly)}" fill="#fff"/>
<polygon points="${pts(spark.poly)}" fill="rgb(${SPARK})"/>
</svg>
`;
}

const out = new URL('../public/', import.meta.url);
writeFileSync(new URL('icon.svg', out), svg());
writeFileSync(new URL('icon-192.png', out), render(192, { rounded: true, inset: 0 }));
writeFileSync(new URL('icon-512.png', out), render(512, { rounded: true, inset: 0 }));
writeFileSync(new URL('icon-maskable-512.png', out), render(512, { rounded: false, inset: 0.12 }));
writeFileSync(new URL('apple-touch-icon.png', out), render(180, { rounded: false, inset: 0.04 }));
console.log('icons written');
