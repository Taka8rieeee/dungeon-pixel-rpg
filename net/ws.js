'use strict';

/**
 * 极简 WebSocket 服务端（RFC6455），只用 Node 内置模块。
 * 只实现游戏用得到的部分：文本帧、分片、ping/pong、close。
 * 这样联机不需要引入任何第三方依赖，和项目「零依赖」的基调一致。
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = {
  CONT: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

class WSConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragOp = 0;
    this.closed = false;
    this.alive = true;
    this.data = {}; // 业务侧挂数据的口袋

    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    socket.setNoDelay(true);
  }

  onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    // 一个 TCP 包里可能有多帧，循环解析
    for (;;) {
      const frame = this.readFrame();
      if (!frame) return;
      this.handleFrame(frame);
    }
  }

  readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;

    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const big = b.readBigUInt64BE(off);
      if (big > 1024n * 1024n) {
        this.close(1009, '消息过大');
        return null;
      }
      len = Number(big);
      off += 8;
    }

    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.slice(off, off + 4);
      off += 4;
    }
    if (b.length < off + len) return null;

    let payload = b.slice(off, off + len);
    if (mask) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    this.buf = b.slice(off + len);
    return { fin, opcode, payload };
  }

  handleFrame({ fin, opcode, payload }) {
    if (opcode === OP.PING) {
      this.sendFrame(OP.PONG, payload);
      return;
    }
    if (opcode === OP.PONG) {
      this.alive = true;
      return;
    }
    if (opcode === OP.CLOSE) {
      this.close(1000, '');
      return;
    }

    // 分片：第一条记录 opcode，后续都是 CONT
    if (opcode !== OP.CONT) {
      this.fragments = [payload];
      this.fragOp = opcode;
    } else {
      this.fragments.push(payload);
    }
    if (!fin) return;

    const full = Buffer.concat(this.fragments);
    this.fragments = [];
    if (this.fragOp === OP.TEXT || this.fragOp === OP.BINARY) {
      this.emit('message', full.toString('utf8'));
    }
  }

  sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (err) {
      this.finish();
    }
  }

  send(obj) {
    this.sendFrame(OP.TEXT, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8'));
  }

  ping() {
    this.alive = false;
    this.sendFrame(OP.PING, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.sendFrame(OP.CLOSE, body);
    this.finish();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.end();
    } catch (err) {
      /* ignore */
    }
    this.emit('close');
  }
}

/**
 * 把一个 http server 的 upgrade 请求接管成 WebSocket 连接。
 * onConnection(conn, req) 由调用方处理业务。
 */
function attach(server, onConnection, options = {}) {
  const path = options.path || '/ws';

  server.on('upgrade', (req, socket) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (err) {
      /* ignore */
    }
    if (pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (!key || upgrade !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const conn = new WSConnection(socket, req);
    onConnection(conn, req);
  });
}

module.exports = { attach, WSConnection };
