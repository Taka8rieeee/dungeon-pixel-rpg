'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const { Game } = require('./src/game');
const { loadMeta, saveMeta, resetMeta, defaultMeta } = require('./src/save');

const PUBLIC_DIR = path.join(__dirname, 'public');
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
const game = new Game(meta, () => saveMeta(meta));

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
      if (size > 1024 * 1024) {
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
    if (req.method === 'GET' && pathname === '/api/state') {
      return sendJson(res, 200, game.getState());
    }

    if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });

    const body = await readBody(req);

    if (pathname === '/api/start') {
      game.startRun();
      return sendJson(res, 200, game.getState());
    }

    if (pathname === '/api/action') {
      return sendJson(res, 200, game.handle(body.action));
    }

    if (pathname === '/api/choose') {
      if (game.pending) game.resolveChoice(Number(body.index) || 0);
      return sendJson(res, 200, game.getState());
    }

    if (pathname === '/api/upgrade') {
      return sendJson(res, 200, game.upgradeMeta(String(body.stat || '')));
    }

    if (pathname === '/api/reset') {
      Object.assign(meta, defaultMeta());
      saveMeta(meta);
      game.meta = meta;
      return sendJson(res, 200, game.getState());
    }

    if (pathname === '/api/debug/goto') {
      return sendJson(res, 200, game.debugGoto(body.depth));
    }

    // 开发调试：把浏览器 canvas 截图存到 data/shot.png，方便无头环境下检查画面
    if (pathname === '/api/debug/shot') {
      const m = /^data:image\/png;base64,(.+)$/.exec(String(body.data || ''));
      if (!m) return sendJson(res, 400, { error: '需要 PNG dataURL' });
      const buf = Buffer.from(m[1], 'base64');
      fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, 'data', 'shot.png'), buf);
      return sendJson(res, 200, { ok: true, bytes: buf.length });
    }

    return sendJson(res, 404, { error: '未知接口' });
  } catch (err) {
    return sendJson(res, 400, { error: err.message || '请求出错' });
  }
}

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  try {
    rel = decodeURIComponent(rel);
  } catch (err) {
    res.writeHead(400);
    return res.end('Bad Request');
  }

  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
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

function listen(port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 10) {
      listen(port + 1, attempt + 1);
    } else {
      console.error('启动失败：', err.message);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log('');
    console.log('  地牢像素 RPG 已启动');
    console.log(`  浏览器打开：${url}`);
    console.log('  按 Ctrl+C 停止');
    console.log('');
    if (process.platform === 'win32' && !process.env.NO_OPEN) {
      exec(`start "" "${url}"`);
    }
  });
}

const BASE_PORT = Number(process.env.PORT) || 4321;
listen(BASE_PORT);
