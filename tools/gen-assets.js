'use strict';
/**
 * 生成 public/assets/atlas.png 与 atlas.json。
 * 只用 Node 内置模块（zlib 负责压缩），不依赖任何第三方包。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TILE = 16;
const COLS = 8;

/* ---------------- PNG 编码 ---------------- */

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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 画布 ---------------- */

class Sheet {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.buf = Buffer.alloc(w * h * 4);
  }

  set(x, y, hex, a = 255) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.buf[i] = (hex >> 16) & 255;
    this.buf[i + 1] = (hex >> 8) & 255;
    this.buf[i + 2] = hex & 255;
    this.buf[i + 3] = a;
  }

  rect(x, y, w, h, hex, a = 255) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, hex, a);
  }

  toPNG() {
    return encodePNG(this.w, this.h, this.buf);
  }
}

/* ---------------- 字符画精灵 ---------------- */

const PALETTES = {
  player: { f: 0x0b0b12, h: 0xa8b6d8, s: 0x5b7cfa, b: 0x35447e, a: 0x7f9cff },
  slime: { f: 0x14401f, g: 0x3fbf6a, l: 0x93f0b0 },
  rat: { f: 0x2a1a10, b: 0xb0784a, r: 0xff6b6b },
  archer: { f: 0x140f22, p: 0x8b5cf6, s: 0xd8c7ff, d: 0xd8b06a },
  brute: { f: 0x2a0c0c, r: 0xd94a4a, e: 0xffd45e },
  wraith: { f: 0x06222b, c: 0x5fd8f0, w: 0xe6ffff, e: 0x0b1a20 },
  golem: { f: 0x1a1a20, s: 0x8a8a96, d: 0x565662, e: 0xffb14a },
  bomber: { f: 0x140f22, p: 0x8b5cf6, w: 0xd8c7ff, e: 0xff5a3c, o: 0xff9f3c },
  boss: { f: 0x2a1c05, g: 0xe0a020, w: 0xffd98a, e: 0xff3b3b, a: 0x8a5a10 },
  gold: { f: 0x3a2a05, y: 0xffd45e, o: 0xff9f3c },
  potion: { f: 0x2a0c12, w: 0xd8d8e8, r: 0xe04a5a, h: 0xffb3bd },
  chest: { f: 0x2a1a08, o: 0xb07a2a, b: 0x7a4a16, y: 0xffd45e },
  heart: { f: 0x2a0810, r: 0xe0455f },
};

const ART = {
  player: [
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
  ],
  slime: [
    '................',
    '................',
    '................',
    '......ffff......',
    '....ffggggff....',
    '...fggggggggf...',
    '..fggllggggggf..',
    '..fgllllgggggf..',
    '..fggggggggggf..',
    '..fggggggggggf..',
    '...fggggggggf...',
    '....fggggggf....',
    '......ffff......',
    '................',
    '................',
    '................',
  ],
  rat: [
    '................',
    '................',
    '................',
    '................',
    '....ff....ff....',
    '...fbbf..fbbf...',
    '...fbbbbbbbbf...',
    '..fbbbbbbbbbbf..',
    '..fbbrbbbbbrbf..',
    '..fbbbbbbbbbbf..',
    '...fbbbbbbbbf...',
    '....fbbbbbbf....',
    '.....fb..bf.....',
    '................',
    '................',
    '................',
  ],
  archer: [
    '................',
    '......ffff......',
    '.....fppppf.....',
    '.....fpsspf.....',
    '.....fpsspf.....',
    '.....fppppf.....',
    '....fppppppf....',
    '...fppppppppf...',
    '..dfppppppppfd..',
    '..dfppppppppfd..',
    '...fppppppppf...',
    '....fppppppf....',
    '....fp....pf....',
    '....fp....pf....',
    '...dd......dd...',
    '................',
  ],
  brute: [
    '................',
    '....ffffffff....',
    '...frrrrrrrrf...',
    '..frrrrrrrrrrf..',
    '..frreeeerrrrf..',
    '..frreeeerrrrf..',
    '..frrrrrrrrrrf..',
    '.frrrrrrrrrrrrf.',
    '.frrrrrrrrrrrrf.',
    '.frrrrrrrrrrrrf.',
    '..frrrrrrrrrrf..',
    '..frrrrrrrrrrf..',
    '...frrrrrrrrf...',
    '....frr..rrf....',
    '....frr..rrf....',
    '................',
  ],
  wraith: [
    '................',
    '......ffff......',
    '.....fccccf.....',
    '....fccccccf....',
    '....fcwwwwcf....',
    '....fcweewcf....',
    '....fcwwwwcf....',
    '....fccccccf....',
    '...fccccccccf...',
    '...fccccccccf...',
    '..fccccccccccf..',
    '..fccccccccccf..',
    '..fcfcfcfcfcf...',
    '...f.f.f.f.f....',
    '................',
    '................',
  ],
  golem: [
    '................',
    '....ffffff......',
    '...fssssssf.....',
    '..fssssssssf....',
    '..fseesseesf....',
    '..fssssssssf....',
    '.fdssssssssdf...',
    'fdssssssssssdf..',
    'fdssssssssssdf..',
    '.fdssssssssdf...',
    '..fdssssssdf....',
    '..fdssssssdf....',
    '..fdd....ddf....',
    '..fdd....ddf....',
    '..fff....fff....',
    '................',
  ],
  bomber: [
    '................',
    '......ffff......',
    '.....foooof.....',
    '....fpoooopf....',
    '....fpweewpf....',
    '....fpwwwwpf....',
    '...fppppppppf...',
    '..fppppppppppf..',
    '..fppppppppppf..',
    '..fppppppppppf..',
    '..fppppppppppf..',
    '...fppppppppf...',
    '....fp....pf....',
    '....fp....pf....',
    '...fff....fff...',
    '................',
  ],
  boss: [
    '................',
    '.....ffffff.....',
    '....fggggggf....',
    '...fgwwwwwwgf...',
    '...fgweewwegf...',
    '...fgwwwwwwgf...',
    '....fggggggf....',
    '..ffggggggggff..',
    '.fggggggggggggf.',
    '.fgggaaaaaagggf.',
    '.fgggaaaaaagggf.',
    '.fggggggggggggf.',
    '..fggggggggggf..',
    '...fggggggggf...',
    '....fgg..ggf....',
    '...fggg..gggf...',
  ],
  gold: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '......ffff......',
    '.....fyyyyf.....',
    '....fyyyyyyf....',
    '...fyyyyyyyyf...',
    '...fyoyyyyoyf...',
    '...fyyyyyyyyf...',
    '....fyyyyyyf....',
    '......ffff......',
    '................',
    '................',
    '................',
  ],
  potion: [
    '................',
    '................',
    '......ffff......',
    '.....fwrrwf.....',
    '....fwrrrrwf....',
    '....fwrhhrwf....',
    '....fwrhhrwf....',
    '....fwrrrrwf....',
    '....fwrrrrwf....',
    '.....fwrrwf.....',
    '......ffff......',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  chest: [
    '................',
    '................',
    '..ffffffffffff..',
    '..fobbbbbbbbof..',
    '..fobbbbbbbbof..',
    '..fobbbbbbbbof..',
    '..ffffffffffff..',
    '..fobbbyybbbof..',
    '..fobbbyybbbof..',
    '..fobbbbbbbbof..',
    '..fobbbbbbbbof..',
    '..ffffffffffff..',
    '................',
    '................',
    '................',
    '................',
  ],
  heart: [
    '................',
    '..ffff....ffff..',
    '.frrrrf..frrrrf.',
    'frrrrrrffrrrrrrf',
    'frrrrrrrrrrrrrrf',
    'frrrrrrrrrrrrrrf',
    '.frrrrrrrrrrrrf.',
    '..frrrrrrrrrrf..',
    '...frrrrrrrrf...',
    '....frrrrrrf....',
    '.....frrrrf.....',
    '......frrf......',
    '.......ff.......',
    '................',
    '................',
    '................',
  ],
};

/* ---------------- 瓦片绘制 ---------------- */

function hash2(x, y, s) {
  let h = x * 374761393 + y * 668265263 + s * 1442695041;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function drawFloor(sheet, ox, oy, seed) {
  const base = 0x343441;
  const dark = 0x2c2c37;
  const light = 0x40404d;
  sheet.rect(ox, oy, TILE, TILE, base);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const n = hash2(x, y, seed);
      if (n > 0.93) sheet.set(ox + x, oy + y, light);
      else if (n < 0.07) sheet.set(ox + x, oy + y, dark);
    }
  }
  // 砖缝
  sheet.rect(ox, oy + 7, TILE, 1, 0x33333f);
  sheet.rect(ox + (seed % 2 ? 4 : 11), oy + 8, 1, 7, 0x33333f);
  sheet.rect(ox, oy, TILE, 1, 0x3f3f4d);
}

function drawWall(sheet, ox, oy) {
  const base = 0x52526a;
  sheet.rect(ox, oy, TILE, TILE, base);
  sheet.rect(ox, oy, TILE, 2, 0x6c6c88); // 顶部高光
  sheet.rect(ox, oy + TILE - 3, TILE, 3, 0x2e2e3c); // 底部阴影
  sheet.rect(ox, oy + 6, TILE, 1, 0x3d3d50);
  sheet.rect(ox, oy + 11, TILE, 1, 0x3d3d50);
  sheet.rect(ox + 5, oy + 2, 1, 4, 0x3d3d50);
  sheet.rect(ox + 12, oy + 2, 1, 4, 0x3d3d50);
  sheet.rect(ox + 2, oy + 7, 1, 4, 0x3d3d50);
  sheet.rect(ox + 9, oy + 7, 1, 4, 0x3d3d50);
  sheet.rect(ox + 6, oy + 12, 1, 4, 0x3d3d50);
  sheet.rect(ox + 13, oy + 12, 1, 4, 0x3d3d50);
}

function drawStairs(sheet, ox, oy) {
  sheet.rect(ox, oy, TILE, TILE, 0x1a1a22);
  for (let band = 0; band < 4; band++) {
    const y = oy + 1 + band * 4;
    const off = band * 2;
    sheet.rect(ox + off, y, TILE - off, 3, 0x8a8a9c);
    sheet.rect(ox + off, y, TILE - off, 1, 0xb8b8c8);
    sheet.rect(ox + off, y + 2, TILE - off, 1, 0x55556a);
  }
}

function drawCrack(sheet, ox, oy) {
  const pts = [
    [4, 2], [5, 3], [5, 4], [6, 5], [6, 6], [7, 7], [7, 8],
    [8, 8], [8, 9], [9, 10], [9, 11], [10, 12], [11, 12], [11, 13],
  ];
  for (const [x, y] of pts) sheet.set(ox + x, oy + y, 0x101018, 190);
}

/* ---------------- 组装 ---------------- */

function drawArt(sheet, ox, oy, rows, palette) {
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.' || ch === ' ') continue;
      const color = palette[ch];
      if (color === undefined) throw new Error(`未知调色板字符: ${ch}`);
      sheet.set(ox + x, oy + y, color);
    }
  });
}

function main() {
  const names = [
    'floor_a', 'floor_b', 'floor_c', 'wall', 'stairs', 'player', 'slime', 'rat',
    'archer', 'brute', 'boss', 'gold', 'potion', 'chest', 'heart', 'crack',
    'wraith', 'golem', 'bomber',
  ];
  const rows = Math.ceil(names.length / COLS);
  const sheet = new Sheet(COLS * TILE, rows * TILE);
  const frames = {};

  names.forEach((name, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const ox = col * TILE;
    const oy = row * TILE;
    frames[name] = [col, row];

    if (name.startsWith('floor_')) drawFloor(sheet, ox, oy, 1 + i * 7);
    else if (name === 'wall') drawWall(sheet, ox, oy);
    else if (name === 'stairs') drawStairs(sheet, ox, oy);
    else if (name === 'crack') drawCrack(sheet, ox, oy);
    else {
      const art = ART[name];
      if (!art) throw new Error('缺少美术: ' + name);
      if (art.length !== 16) throw new Error(`${name} 行数应为 16，实际 ${art.length}`);
      art.forEach((r, idx) => {
        if (r.length !== 16) throw new Error(`${name} 第 ${idx} 行宽度应为 16，实际 ${r.length}: "${r}"`);
      });
      drawArt(sheet, ox, oy, art, PALETTES[name]);
    }
  });

  const outDir = path.join(__dirname, '..', 'public', 'assets');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'atlas.png'), sheet.toPNG());
  fs.writeFileSync(
    path.join(outDir, 'atlas.json'),
    JSON.stringify({ tile: TILE, cols: COLS, rows, frames }, null, 2),
  );
  console.log(`已生成图集：${names.length} 帧 → public/assets/atlas.png`);
}

main();
