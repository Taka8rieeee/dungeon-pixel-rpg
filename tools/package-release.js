'use strict';

/**
 * 打包「解压即玩」的 Windows 便携版：
 *
 *   地牢像素RPG/
 *     启动游戏.bat        双击启动（内置 ASCII 内容，避免中文编码坑）
 *     说明.txt            玩家说明（UTF-8 BOM，记事本可读）
 *     node/node.exe       自带 Node 运行时，目标机器不需要装任何东西
 *     game/               游戏本体（server.js + public/ + src/）
 *
 * 用法：node tools/package-release.js
 * 产物：release/地牢像素RPG/（再手动压成 zip）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'release', '地牢像素RPG');

// 游戏本体需要的文件，其余（docs/tools/.git/data…）都不进包
const COPY_FILES = ['server.js', 'package.json', 'README.md'];
const COPY_DIRS = ['public', 'src'];

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
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  // 1. 游戏本体
  const game = path.join(OUT, 'game');
  fs.mkdirSync(game, { recursive: true });
  for (const f of COPY_FILES) fs.copyFileSync(path.join(ROOT, f), path.join(game, f));
  for (const d of COPY_DIRS) copyDir(path.join(ROOT, d), path.join(game, d));

  // 2. 自带 Node 运行时：直接复制当前正在用的 node.exe
  const nodeDir = path.join(OUT, 'node');
  fs.mkdirSync(nodeDir, { recursive: true });
  const nodeExe = process.execPath;
  fs.copyFileSync(nodeExe, path.join(nodeDir, 'node.exe'));
  console.log('  已复制 Node 运行时:', nodeExe);

  // 3. 启动脚本 —— 内容必须是纯 ASCII：bat 对 UTF-8 中文的支持不可靠
  //    行尾必须是 CRLF，否则某些 Windows 版本会解析出错
  const bat = [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0game"',
    '',
    'set "NODE_EXE=..\\node\\node.exe"',
    'if not exist "%NODE_EXE%" (',
    '  where node >nul 2>nul',
    '  if errorlevel 1 (',
    '    echo [ERROR] Node runtime not found.',
    '    echo The package should contain a "node" folder with node.exe inside.',
    '    pause',
    '    exit /b 1',
    '  )',
    '  set "NODE_EXE=node"',
    ')',
    '',
    'title Dungeon Pixel RPG',
    'echo ============================================',
    'echo   Dungeon Pixel RPG',
    'echo   The game will open in your browser.',
    'echo   Close this window to quit.',
    'echo ============================================',
    '"%NODE_EXE%" server.js',
    'pause',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(OUT, '启动游戏.bat'), bat, 'ascii');

  // 4. 说明（带 BOM，Windows 记事本才能正确识别 UTF-8）
  const readme = [
    '地牢像素 RPG —— 解压即玩版',
    '================================\n',
    '【怎么开始】',
    '1. 解压到任意文件夹（路径可以含中文，但别放在需要管理员权限的系统目录里）',
    '2. 双击「启动游戏.bat」，会弹出一个黑色窗口',
    '3. 浏览器会自动打开游戏页面；没弹的话手动打开浏览器，输入 localhost:4321',
    '   （端口被占用时会自动换成 4322、4323……以黑窗口里显示的地址为准）\n',
    '【怎么退出】',
    '直接关闭那个黑色窗口即可。\n',
    '【存档在哪】',
    'game\\data\\meta.json —— 删掉它就是重置进度；',
    '想把自己的进度带到别的电脑，把这个文件拷过去覆盖即可。\n',
    '【操作】',
    'WASD 移动 · 鼠标瞄准 · 左键攻击 · Q 喝药 · E 捡起地上的武器 ·',
    '1/2 切换武器 · 滚轮循环切换 · M 静音 · Esc 关闭商店/放弃全武器宝箱 ·',
    '详细规则见 game\\README.md\n',
    '【常见问题】',
    '- 双击没反应 / 一闪而过：右键「以管理员身份运行」试试，或把文件夹挪到桌面',
    '- 杀毒软件报警：包里自带了 Node.js 运行时（node\\node.exe），属正常现象',
    '- 想改端口：编辑启动脚本，在 server.js 那行前面加一行 set PORT=5000',
  ].join('\r\n');
  fs.writeFileSync(path.join(OUT, '说明.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(readme, 'utf8')]));

  // 统计体积
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
  console.log('下一步: 用 PowerShell 把它压成 zip 分发');
}

main();
