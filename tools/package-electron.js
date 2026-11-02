'use strict';

/**
 * 打包 Electron 桌面版：
 *
 *   地牢像素RPG-win/
 *     地牢像素RPG.exe      ← electron.exe 改名，双击直接弹游戏窗口
 *     *.dll / locales/ …   ← Electron 运行时
 *     resources/app/       ← main.js（窗口壳）+ 游戏本体
 *     说明.txt
 *
 * 用法：node tools/package-electron.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'release', '地牢像素RPG-win');
const DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const APP = path.join(OUT, 'resources', 'app');

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
  if (!fs.existsSync(path.join(DIST, 'electron.exe'))) {
    console.error('找不到 Electron 运行时，先执行: npm install electron');
    process.exit(1);
  }

  if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(APP, { recursive: true });

  // 1. Electron 运行时整体复制，主程序改成游戏名
  console.log('  复制 Electron 运行时…');
  copyDir(DIST, OUT);
  fs.renameSync(path.join(OUT, 'electron.exe'), path.join(OUT, '地牢像素RPG.exe'));

  // 2. 应用：窗口壳 + 游戏本体（零依赖，不需要 node_modules）
  console.log('  复制游戏本体…');
  fs.writeFileSync(
    path.join(APP, 'package.json'),
    JSON.stringify({ name: 'dungeon-pixel-rpg', version: '0.2.0', main: 'main.js' }, null, 2),
  );
  fs.copyFileSync(path.join(ROOT, 'electron', 'main.js'), path.join(APP, 'main.js'));
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(APP, 'server.js'));
  fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(APP, 'README.md'));
  copyDir(path.join(ROOT, 'public'), path.join(APP, 'public'));
  copyDir(path.join(ROOT, 'src'), path.join(APP, 'src'));
  copyDir(path.join(ROOT, 'net'), path.join(APP, 'net')); // 联机模块

  // 3. 说明（UTF-8 BOM）
  const readme = [
    '地牢像素 RPG —— 桌面版',
    '================================\n',
    '【怎么开始】',
    '双击「地牢像素RPG.exe」，会直接弹出一个独立游戏窗口。\n',
    '【怎么退出】',
    '关闭游戏窗口即可，服务器会一并退出。\n',
    '【存档在哪】',
    'resources\\app\\data\\meta.json —— 删掉它就是重置进度；',
    '想换电脑带上进度，把这个文件拷过去覆盖即可。\n',
    '【操作】',
    'WASD 移动 · 鼠标瞄准 · 左键攻击 · Q 喝药 · E 捡起地上的武器 ·',
    '1/2 切换武器 · 滚轮循环切换 · M 静音 · 详细规则见 resources\\app\\README.md\n',
    '【常见问题】',
    '- 第一次启动慢几秒属正常（要起本地服务器）',
    '- 杀毒软件报警：这是打包进来的 Electron 运行时，属正常现象',
    '- 游戏数据不上传任何服务器，全部保存在本机',
  ].join('\r\n');
  fs.writeFileSync(
    path.join(OUT, '说明.txt'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(readme, 'utf8')]),
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
  console.log(`\n打包完成: ${OUT}`);
  console.log(`共 ${files} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MB（未压缩）`);
  console.log('下一步: 用 PowerShell 压成 zip 分发');
}

main();
