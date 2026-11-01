'use strict';

/**
 * Electron 壳：双击 exe 弹出一个独立桌面窗口跑游戏。
 * 结构：本文件 fork 同目录的 server.js（随机端口），窗口加载它。
 * 游戏本体一份代码（public/ + src/），浏览器版和桌面版共用。
 */

const { app, BrowserWindow, Menu } = require('electron');
const { fork } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');

// 脱离控制台运行时 stdout 会被吞，关键事件落一份文件日志方便排查
const LOG = path.join(__dirname, 'data', 'shell.log');
function log(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch (err) { /* 忽略 */ }
}

let serverProc = null;
let win = null;

log('进程启动');

/** 启动本地服务器并等它真正可连，返回实际端口 */
function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = fork(path.join(__dirname, 'server.js'), [], {
      cwd: __dirname,
      // 注意：不要碰 ELECTRON_RUN_AS_NODE —— fork 会自动把它设成 1，
      // 让子进程以纯 Node 模式跑 server.js；手动覆盖会让子进程又变成一个 GUI 实例
      // stdio 必须显式带 ipc（fork 依赖它），管道用于解析服务器实际监听的端口
      env: { ...process.env, NO_OPEN: '1', PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    let port = 0;
    serverProc.stdout.on('data', (chunk) => {
      const m = /http:\/\/localhost:(\d+)/.exec(String(chunk));
      if (m) port = Number(m[1]);
      process.stdout.write(chunk);
    });
    serverProc.stderr.on('data', (chunk) => process.stderr.write(chunk));
    serverProc.on('exit', (code) => {
      if (!win) {
        console.error(`server 提前退出（code ${code}）`);
        app.quit();
      }
    });

    const t0 = Date.now();
    const probe = () => {
      if (!port) {
        if (Date.now() - t0 > 15000) return reject(new Error('server 启动超时'));
        return setTimeout(probe, 120);
      }
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => {
        s.end();
        resolve(port);
      });
      s.once('error', () => setTimeout(probe, 150));
    };
    probe();
  });
}

async function createWindow() {
  const port = await startServer();

  win = new BrowserWindow({
    width: 1040,
    height: 660,
    useContentSize: true,
    minWidth: 640,
    minHeight: 400,
    title: '地牢像素 RPG',
    backgroundColor: '#0b0b12',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 无地址栏的独立窗口
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => win.show());

  win.webContents.on('did-finish-load', () => log('页面加载完成'));
  win.webContents.on('did-fail-load', (_e, code, desc) => log(`页面加载失败: ${code} ${desc}`));
  win.webContents.on('render-process-gone', (_e, details) => log(`渲染进程崩溃: ${details.reason}`));
  app.on('child-process-gone', (_e, details) => log(`子进程退出: ${details.type} ${details.reason}`));
  // 点了站内链接（比如 target=_blank）也在本窗口开
  win.webContents.setWindowOpenHandler(({ url }) => {
    win.loadURL(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    win = null;
  });

  await win.loadURL(`http://localhost:${port}`);
  log(`窗口已打开: http://localhost:${port}`);
}

app.whenReady().then(createWindow).catch((err) => {
  log(`启动失败: ${err.stack || err.message}`);
  app.quit();
});

app.on('window-all-closed', () => {
  log('所有窗口已关闭，退出');
  if (serverProc) serverProc.kill();
  app.quit();
});
