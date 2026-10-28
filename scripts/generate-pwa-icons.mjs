import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "public", "icons");

const NAVY = [11, 61, 92, 255];
const GOLD = [201, 162, 39, 255];
const WHITE = [255, 255, 255, 255];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const name = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const start = y * (width * 4 + 1);
    raw[start] = 0;
    rgba.copy(raw, start + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function sdRoundRect(px, py, cx, cy, hw, hh, radius) {
  const dx = Math.abs(px - cx) - (hw - radius);
  const dy = Math.abs(py - cy) - (hh - radius);
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - radius;
}

function blend(buf, width, x, y, color, alpha) {
  if (alpha <= 0 || x < 0 || y < 0 || x >= width) return;
  const height = buf.length / (width * 4);
  if (y >= height) return;
  const i = (y * width + x) * 4;
  const dstA = buf[i + 3] / 255;
  const outA = alpha + dstA * (1 - alpha);
  if (outA <= 0) return;
  buf[i] = Math.round((color[0] * alpha + buf[i] * dstA * (1 - alpha)) / outA);
  buf[i + 1] = Math.round((color[1] * alpha + buf[i + 1] * dstA * (1 - alpha)) / outA);
  buf[i + 2] = Math.round((color[2] * alpha + buf[i + 2] * dstA * (1 - alpha)) / outA);
  buf[i + 3] = Math.round(outA * 255);
}

function fillRoundRect(buf, width, cx, cy, hw, hh, radius, color) {
  const height = buf.length / (width * 4);
  const x0 = Math.max(0, Math.floor(cx - hw - 1));
  const x1 = Math.min(width - 1, Math.ceil(cx + hw + 1));
  const y0 = Math.max(0, Math.floor(cy - hh - 1));
  const y1 = Math.min(height - 1, Math.ceil(cy + hh + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const sd = sdRoundRect(x + 0.5, y + 0.5, cx, cy, hw, hh, radius);
      const alpha = Math.max(0, Math.min(1, 0.5 - sd));
      if (alpha > 0) blend(buf, width, x, y, color, alpha);
    }
  }
}

function fillCircle(buf, width, cx, cy, radius, color) {
  fillRoundRect(buf, width, cx, cy, radius, radius, radius, color);
}

/** 海軍藍底、金色留言氣泡。重要圖形放喺中間，方便 maskable 裁切。 */
function drawIcon(size, options) {
  const transparent = options && options.transparent;
  const glyph = options && options.glyph;
  const buf = Buffer.alloc(size * size * 4, 0);
  if (!transparent) {
    for (let i = 0; i < size * size; i++) {
      buf[i * 4] = NAVY[0];
      buf[i * 4 + 1] = NAVY[1];
      buf[i * 4 + 2] = NAVY[2];
      buf[i * 4 + 3] = 255;
    }
  }
  const bubble = glyph ? WHITE : GOLD;
  const line = glyph ? NAVY : WHITE;
  const cx = size / 2;
  const cy = size * 0.48;
  const hw = size * 0.25;
  const hh = size * 0.17;
  const radius = size * 0.07;
  fillRoundRect(buf, size, cx, cy, hw, hh, radius, bubble);
  fillCircle(buf, size, cx - hw * 0.55, cy + hh * 0.85, size * 0.055, bubble);
  fillRoundRect(buf, size, cx, cy - size * 0.035, size * 0.15, size * 0.016, size * 0.016, line);
  fillRoundRect(buf, size, cx - size * 0.025, cy + size * 0.035, size * 0.11, size * 0.016, size * 0.016, line);
  return encodePng(size, size, buf);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "icon-192.png"), drawIcon(192));
fs.writeFileSync(path.join(outDir, "icon-512.png"), drawIcon(512));
fs.writeFileSync(path.join(outDir, "apple-touch-icon.png"), drawIcon(180));
fs.writeFileSync(path.join(outDir, "badge-96.png"), drawIcon(96, { transparent: true, glyph: true }));
console.log(`已寫入 ${outDir}`);
