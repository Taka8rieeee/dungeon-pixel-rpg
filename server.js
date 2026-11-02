'use strict';

/**
 * 实时版服务器只做三件事：发静态文件、读写局外存档、留一个截图调试口。
 * 游戏逻辑全部在 public/engine.js 里，跑在浏览器中。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const { loadMeta, saveMeta, defaultMeta, normalize } = require('./src/save');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SRC_DIR = path.join(ROOT, 'src');
const DATA_DIR = path.join(ROOT, 'data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

let meta = loadMeta();

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 256) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, pathname) {
  try {
    if (req.method === 'GET' && pathname === '/api/meta') {
      return sendJson(res, 200, meta);
    }

    if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });

    const body = await readBody(req);

    if (pathname === '/api/meta') {
      Object.assign(meta, normalize(body));
      saveMeta(meta);
      return sendJson(res, 200, { ok: true, meta });
    }

    if (pathname === '/api/meta/reset') {
      Object.assign(meta, defaultMeta());
      saveMeta(meta);
      return sendJson(res, 200, { ok: true, meta });
    }

    // 开发调试：把浏览器 canvas 截图存到 data/shot.png
    if (pathname === '/api/debug/shot') {
      const m = /^data:image\/png;base64,(.+)$/.exec(String(body.data || ''));
      if (!m) return sendJson(res, 400, { error: '需要 PNG dataURL' });
      const buf = Buffer.from(m[1], 'base64');
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, 'shot.png'), buf);
      return sendJson(res, 200, { ok: true, bytes: buf.length });
    }

    return sendJson(res, 404, { error: '未知接口' });
  } catch (err) {
    return sendJson(res, 400, { error: err.message || '请求出错' });
  }
}

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let baseDir = PUBLIC_DIR;

  try {
    rel = decodeURIComponent(rel);
  } catch (err) {
    res.writeHead(400);
    return res.end('Bad Request');
  }

  // 浏览器要直接加载 src/ 下的 UMD 模块（地图生成、视野、随机数）
  if (rel.startsWith('/src/')) {
    baseDir = SRC_DIR;
    rel = rel.slice(4);
  }

  const filePath = path.normalize(path.join(baseDir, rel));
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url.pathname);
  } else {
    serveStatic(res, url.pathname);
  }
});

/* ---------------- 联机：WebSocket ---------------- */

const net = require('./net/ws');
let lobby = null;
try {
  lobby = require('./net/room');
} catch (err) {
  console.warn('联机模块加载失败（单机模式照常可用）：', err.message);
}

if (lobby) {
  net.attach(server, (conn) => {
    conn.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (err) {
        return;
      }
      const room = conn.data.room;
      if (msg.t === 'join') {
        if (room) return;
        const name = String(msg.name || '').slice(0, 8).trim() || '无名氏';
        lobby.joinAny(conn, name);
        return;
      }
      if (room) room.handle(conn, msg);
    });
    conn.on('close', () => {
      const room = conn.data.room;
      if (room) room.leave(conn);
    });
  }, { path: '/ws' });
}

function listen(port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 10) {
      listen(port + 1, attempt + 1);
    } else {
      console.error('启动失败：', err.message);
      process.exit(1);
    }
  });
  // 默认监听所有网卡：同一 Wi-Fi 下手机才能连进来；只想本机玩可设 HOST=127.0.0.1
  server.listen(port, process.env.HOST || '0.0.0.0', () => {
    // PORT=0 时由系统随机分配，以实际绑定的端口为准
    const actual = server.address().port;
    const url = `http://localhost:${actual}`;
    console.log('');
    console.log('  地牢像素 RPG（实时版）已启动');
    console.log(`  本机打开：${url}`);
    // 打印局域网地址，方便手机扫码/手输
    const os = require('os');
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const ni of nets[name] || []) {
        if (ni.family === 'IPv4' && !ni.internal) {
          console.log(`  局域网：http://${ni.address}:${actual}   （手机连同一个 Wi-Fi 用这个）`);
        }
      }
    }
    console.log('  按 Ctrl+C 停止');
    console.log('');
    if (process.platform === 'win32' && !process.env.NO_OPEN) {
      exec(`start "" "${url}"`);
    }
  });
}

const BASE_PORT = Number(process.env.PORT) || 4321;
listen(BASE_PORT);
