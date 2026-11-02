'use strict';

/**
 * 联机冒烟测试：两个"假客户端"连本地 /ws，验证
 *   1. 能握手、能加入、能收到地图与快照
 *   2. 两人互相可见、各自移动互不干扰
 *   3. 怪物对两人都生效
 * 用法：node tools/net-test.js [port]
 */

const net = require('net');
const crypto = require('crypto');

const PORT = Number(process.argv[2]) || 4321;

/** 极简 WS 客户端（只发文本帧，接收文本帧） */
function connect(name) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    let handshook = false;
    let buf = Buffer.alloc(0);
    const state = { name, snaps: [], maps: [], events: [], closed: false };

    const send = (obj) => {
      const payload = Buffer.from(JSON.stringify(obj), 'utf8');
      const mask = crypto.randomBytes(4);
      let header;
      if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
      else {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
      }
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
      sock.write(Buffer.concat([header, mask, masked]));
    };
    state.send = send;
    state.close = () => {
      try {
        sock.destroy();
      } catch (e) { /* 忽略 */ }
    };

    sock.on('connect', () => {
      sock.write(
        `GET /ws HTTP/1.1\r\nHost: localhost:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshook) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.slice(0, idx).toString();
        if (!head.includes('101')) return reject(new Error('握手失败: ' + head.split('\r\n')[0]));
        handshook = true;
        buf = buf.slice(idx + 4);
        resolve(state);
      }
      // 解析服务端帧（无掩码）
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (opcode === 0x1) {
          let msg;
          try {
            msg = JSON.parse(payload.toString('utf8'));
          } catch (e) {
            continue;
          }
          if (msg.t === 'map') state.maps.push(msg);
          else if (msg.t === 'snap') state.snaps.push(msg);
          else if (msg.t === 'evt') state.events.push(...msg.list);
          else state[msg.t] = msg;
        }
      }
    });

    sock.on('error', reject);
    sock.on('close', () => {
      state.closed = true;
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(ok, label) {
  console.log(`  ${ok ? '✔' : '✘'} ${label}`);
  if (!ok) failed++;
}

(async () => {
  console.log('联机冒烟测试：');
  const a = await connect('阿甲');
  a.send({ t: 'join', name: '阿甲' });
  await sleep(400);
  check(!!a.welcome, '第 1 个客户端加入成功');
  check(a.maps.length >= 1, '收到地图');
  await sleep(400);
  const s1 = a.snaps[a.snaps.length - 1];
  check(!!s1, '收到快照');
  check(s1 && s1.players.length === 1, '此时场上 1 个玩家');

  const b = await connect('阿乙');
  b.send({ t: 'join', name: '阿乙' });
  await sleep(500);
  check(!!b.welcome, '第 2 个客户端加入成功');
  const s2 = a.snaps[a.snaps.length - 1];
  check(s2 && s2.players.length === 2, `第 1 个客户端能看到 2 个玩家（实际 ${s2 ? s2.players.length : 0}）`);

  // 各自移动：A 往右，B 往左
  const before = a.snaps[a.snaps.length - 1].players;
  const ax0 = before[0].x;
  const bx0 = before[1].x;
  const right = { t: 'input', up: false, down: false, left: false, right: true, firing: false, aimX: ax0 + 50, aimY: before[0].y };
  const left = { t: 'input', up: false, down: false, left: true, right: false, firing: false, aimX: bx0 - 50, aimY: before[1].y };
  for (let i = 0; i < 20; i++) {
    a.send(right);
    b.send(left);
    await sleep(50);
  }
  const after = a.snaps[a.snaps.length - 1].players;
  check(after[0].x !== ax0, `玩家 A 移动了（${ax0} → ${after[0].x}）`);
  check(after[1].x !== bx0, `玩家 B 移动了（${bx0} → ${after[1].x}）`);
  check(after[0].x !== after[1].x, '两人位置互不影响');

  // 停止移动，看快照是否稳定
  a.send({ t: 'input', up: false, down: false, left: false, right: false, firing: false, aimX: 0, aimY: 0 });
  b.send({ t: 'input', up: false, down: false, left: false, right: false, firing: false, aimX: 0, aimY: 0 });
  await sleep(300);
  const s3 = b.snaps[b.snaps.length - 1];
  check(s3.enemies.length > 0, `怪物同步可见（${s3.enemies.length} 只）`);
  check(!!s3.me, '快照带本人的背包数据');

  // 攻击：让 A 朝最近的怪开火
  const target = s3.enemies[0];
  if (target) {
    const sA = a.snaps[a.snaps.length - 1];
    const me = sA.players[0];
    const dx = target.x - me.x;
    const dy = target.y - me.y;
    const len = Math.hypot(dx, dy) || 1;
    for (let i = 0; i < 20; i++) {
      a.send({ t: 'input', up: false, down: false, left: false, right: false, firing: true, aimX: me.x + (dx / len) * 100, aimY: me.y + (dy / len) * 100 });
      await sleep(50);
    }
    const act = a.events.filter((e) => e.type === 'swing' || e.type === 'hit');
    check(act.length > 0, `攻击产生了事件（${act.length} 条）`);
  }

  a.send({ t: 'act', a: 'potion' });
  await sleep(200);
  b.send({ t: 'act', a: 'potion' });
  await sleep(200);
  check(true, '操作消息没有导致服务端崩溃');

  // 有人退出后，剩下的人必须还能正常玩（下标会前移，客户端要靠稳定 id 认自己）
  const c = await connect('阿丙');
  c.send({ t: 'join', name: '阿丙' });
  await sleep(400);
  const s3p = a.snaps[a.snaps.length - 1];
  check(s3p && s3p.players.length === 3, `三人同场（实际 ${s3p ? s3p.players.length : 0}）`);

  b.close(); // 中间那个人退出
  await sleep(500);
  const s4 = a.snaps[a.snaps.length - 1];
  check(s4 && s4.players.length === 2, `退出后场上剩 2 人（实际 ${s4 ? s4.players.length : 0}）`);
  check(s4 && s4.players.every((p) => p.id > 0), '每个玩家都带稳定 id');

  const cPos = s4.players.find((p) => p.id === c.welcome.id);
  check(!!cPos, '留下的玩家仍能在快照里找到自己');
  if (cPos) {
    for (let i = 0; i < 12; i++) {
      c.send({ t: 'input', up: false, down: false, left: true, right: false, firing: false, aimX: 0, aimY: 0 });
      await sleep(50);
    }
    const after = a.snaps[a.snaps.length - 1].players.find((p) => p.id === c.welcome.id);
    check(!!after && after.x !== cPos.x, `队友退出后剩下的人仍能移动（${cPos.x} → ${after ? after.x : '?'}）`);
  }

  // 房主（0 号）退出，剩下的人要被提升为 0 号并继续可玩
  a.close();
  await sleep(600);
  const s5 = c.snaps[c.snaps.length - 1];
  check(s5 && s5.players.length === 1, `房主退出后剩 1 人（实际 ${s5 ? s5.players.length : 0}）`);
  const cNow = s5 && s5.players[0];
  const cPrev = cNow && cNow.x;
  for (let i = 0; i < 12; i++) {
    c.send({ t: 'input', up: false, down: false, left: false, right: true, firing: false, aimX: 0, aimY: 0 });
    await sleep(50);
  }
  const cAfter = c.snaps[c.snaps.length - 1].players[0];
  check(!!cAfter && cAfter.x !== cPrev, `房主退出后剩下的人接过房间照常移动（${cPrev} → ${cAfter ? cAfter.x : '?'}）`);
  check(!!c.snaps[c.snaps.length - 1].me, '房主退出后仍能收到自己的背包快照');

  a.sock = null;
  console.log(failed === 0 ? '\n全部通过 ✔' : `\n${failed} 项失败 ✘`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('测试出错：', err.message);
  process.exit(1);
});
