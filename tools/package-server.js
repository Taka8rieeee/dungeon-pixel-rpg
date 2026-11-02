'use strict';

/**
 * 打包服务端部署包（零依赖，解压即跑）：
 *   release/DungeonPixelRPG-server/
 *     server.js  package.json
 *     src/  public/  net/
 *     docs/deploy.md
 *     start.sh / start.bat
 *
 * 用法：node tools/package-server.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'release', 'DungeonPixelRPG-server'); // 英文目录名：Linux 解压中文名会乱码

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  for (const f of ['server.js', 'package.json', 'README.md']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
  }
  for (const d of ['src', 'public', 'net', 'docs']) copyDir(path.join(ROOT, d), path.join(OUT, d));

  fs.writeFileSync(
    path.join(OUT, 'start.sh'),
    [
      '#!/usr/bin/env bash',
      '# 一键启动（Linux / macOS）。PORT=8080 bash start.sh 可换端口',
      'set -e',
      'cd "$(dirname "$0")"',
      'export PORT="${PORT:-8080}"',
      'export NO_OPEN=1',
      'echo "启动中：http://localhost:${PORT}"',
      'exec node server.js',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  fs.writeFileSync(
    path.join(OUT, 'start.bat'),
    ['@echo off', 'cd /d "%~dp0"', 'set NO_OPEN=1', 'node server.js', 'pause', ''].join('\r\n'),
    'ascii',
  );

  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else {
        files++;
        bytes += fs.statSync(p).size;
      }
    }
  };
  walk(OUT);
  console.log(`打包完成: ${OUT}`);
  console.log(`共 ${files} 个文件，${(bytes / 1024).toFixed(0)} KB`);
}

main();
