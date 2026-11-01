'use strict';

/**
 * 生成安卓启动图标：把玩家精灵按 mipmap 各档尺寸放大。
 * 用法：node tools/gen-icon.js [android 工程目录]
 */

const fs = require('fs');
const path = require('path');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let n = 0; n < buf.length; n++) c = CRC_TABLE[(c ^ buf[n]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlibDeflate(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function zlibDeflate(raw) {
  const zlib = require('zlib');
  return zlib.deflateSync(raw, { level: 9 });
}

/* 与 gen-assets.js 相同的玩家美术与调色板 */
const PALETTE = { f: 0x0b0b12, h: 0xa8b6d8, s: 0x5b7cfa, b: 0x35447e, a: 0x7f9cff };
const ART = [
  '................',
  '.....ffff.......',
  '....fhhhhf......',
  '....fhsshf......',
  '....fhsshf......',
  '....ffhhff......',
  '...fbbbbbbf.....',
  '..fbbbbbbbbf....',
  '..fbbaaabbbf....',
  '..fbbaaabbbf....',
  '...fbbbbbbf.....',
  '....fbbbbf......',
  '....fb..bf......',
  '....fb..bf......',
  '...ff....ff.....',
  '................',
];

/** 画一个 size×size 的图标：深色圆底 + 居中的像素小人 */
function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const put = (x, y, color, alpha = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    rgba[i] = (color >> 16) & 0xff;
    rgba[i + 1] = (color >> 8) & 0xff;
    rgba[i + 2] = color & 0xff;
    rgba[i + 3] = alpha;
  };

  // 背景：深蓝黑圆
  const c = size / 2;
  const r = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      if (d <= r) put(x, y, 0x141622);
      else if (d <= r + 1) put(x, y, 0x2a2a3a);
    }
  }

  // 玩家精灵：16 格内容缩放到圆内 78%
  const s = Math.floor((size * 0.78) / 16);
  const ox = Math.round((size - 16 * s) / 2);
  const oy = Math.round((size - 16 * s) / 2);
  ART.forEach((row, ay) => {
    for (let ax = 0; ax < row.length; ax++) {
      const ch = row[ax];
      if (ch === '.' || ch === ' ') continue;
      const color = PALETTE[ch];
      if (color === undefined) continue;
      for (let py = 0; py < s; py++) for (let px = 0; px < s; px++) put(ox + ax * s + px, oy + ay * s + py, color);
    }
  });
  return encodePNG(size, rgba);
}

function main() {
  const proj = process.argv[2] || path.join(__dirname, '..', 'android');
  const res = path.join(proj, 'app', 'src', 'main', 'res');
  const sizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [dpi, size] of Object.entries(sizes)) {
    const dir = path.join(res, `mipmap-${dpi}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), renderIcon(size));
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), renderIcon(size));
    console.log(`  mipmap-${dpi}: ${size}px`);
  }
  console.log('图标已写入', res);
}

main();
