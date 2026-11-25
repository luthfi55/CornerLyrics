'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const OUTPUT_DIR = path.join(__dirname, '..', 'assets');

function insideRoundedRect(x, y, radius) {
  const left = 0.04;
  const right = 0.96;
  const top = 0.04;
  const bottom = 0.96;
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.max(left + radius, Math.min(x, right - radius));
  const cy = Math.max(top + radius, Math.min(y, bottom - radius));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function insideCapsule(x, y, ax, ay, bx, by, radius) {
  return distanceToSegment(x, y, ax, ay, bx, by) <= radius;
}

function insideCircle(x, y, cx, cy, radius) {
  return Math.hypot(x - cx, y - cy) <= radius;
}

function colorAt(x, y) {
  if (!insideRoundedRect(x, y, 0.22)) return [0, 0, 0, 0];

  const glow = Math.max(0, 1 - Math.hypot(x - 0.22, y - 0.16) / 0.85);
  const gradient = Math.min(1, Math.max(0, y));
  let color = [
    Math.round(17 + glow * 20 + gradient * 12),
    Math.round(21 + glow * 14 + gradient * 8),
    Math.round(34 + glow * 45 + gradient * 28),
    255,
  ];

  const white = [248, 250, 252, 255];
  const lavender = [167, 139, 250, 255];
  const violet = [109, 94, 252, 255];

  if (
    insideCapsule(x, y, 0.34, 0.32, 0.34, 0.65, 0.037) ||
    insideCapsule(x, y, 0.34, 0.32, 0.49, 0.40, 0.035) ||
    insideCircle(x, y, 0.29, 0.68, 0.092)
  ) {
    color = white;
  }

  if (insideCapsule(x, y, 0.56, 0.38, 0.82, 0.38, 0.035)) color = lavender;
  if (insideCapsule(x, y, 0.56, 0.51, 0.88, 0.51, 0.035)) color = white;
  if (insideCapsule(x, y, 0.56, 0.64, 0.74, 0.64, 0.035)) color = violet;

  return color;
}

function renderBitmap(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = 4;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = (x + (sx + 0.5) / samples) / size;
          const py = (y + (sy + 0.5) / samples) / size;
          const [r, g, b, a] = colorAt(px, py);
          red += r * a;
          green += g * a;
          blue += b * a;
          alpha += a;
        }
      }

      const count = samples * samples;
      const offset = (y * size + x) * 4;
      if (alpha > 0) {
        pixels[offset] = Math.round(red / alpha);
        pixels[offset + 1] = Math.round(green / alpha);
        pixels[offset + 2] = Math.round(blue / alpha);
        pixels[offset + 3] = Math.round(alpha / count);
      }
    }
  }

  return pixels;
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return result;
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * (size * 4 + 1);
    scanlines[rowOffset] = 0;
    pixels.copy(scanlines, rowOffset + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = header.length;
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    header[entry] = image.size >= 256 ? 0 : image.size;
    header[entry + 1] = image.size >= 256 ? 0 : image.size;
    header[entry + 2] = 0;
    header[entry + 3] = 0;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const images = SIZES.map((size) => ({ size, data: encodePng(size, renderBitmap(size)) }));
fs.writeFileSync(path.join(OUTPUT_DIR, 'icon.ico'), encodeIco(images));
fs.writeFileSync(path.join(OUTPUT_DIR, 'icon.png'), images[images.length - 1].data);
console.log(`Generated ${SIZES.length} icon sizes in ${OUTPUT_DIR}`);
