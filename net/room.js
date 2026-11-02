'use strict';

/**
 * 一个联机房间：服务器权威模拟。
 * 用 engine.js 跑唯一一份世界，客户端只上报输入、接收快照。
 * 这样反作弊天然成立，也不用处理两端状态分叉。
 */

const path = require('path');

// 引擎依赖这三个全局（浏览器里由 <script> 提前加载）
function loadEngine() {
  const root = path.join(__dirname, '..');
  global.RNG = require(path.join(root, 'src', 'rng.js')).RNG;
  global.MapGen = require(path.join(root, 'src', 'mapgen.js'));
  global.FOV = require(path.join(root, 'src', 'fov.js'));
  return require(path.join(root, 'public', 'engine.js'));
}

const Engine = loadEngine();

const TPS = 60;
const SNAP_HZ = 20;
const MAX_PLAYERS = 4;

function freshMeta() {
  return { crystals: 0, upgrades: { hp: 0, atk: 0 }, best: { floor: 0, kills: 0 }, runs: 0, wins: 0 };
}

class Room {
  constructor(onEmpty) {
    this.world = new Engine.World(freshMeta(), Date.now() % 100000);
    this.world.startRun(Date.now() % 100000);
    this.world.screen = 'playing';
    this.members = []; // { conn, player }
    this.mapDirty = true;
    this.snapTimer = 0;
    this.timer = null;
    this.onEmpty = onEmpty || (() => {});
    this.lastTick = Date.now();
    this.tickAcc = 0;
  }

  start() {
    if (this.timer) return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.step(), 1000 / TPS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get full() {
    return this.members.length >= MAX_PLAYERS;
  }

  join(conn, name) {
    const w = this.world;
    // 第一个人用现成的 0 号玩家，后面的人各自新增
    let player;
    if (this.members.length === 0) {
      player = w.player;
      player.name = name;
    } else {
      player = w.addPlayer(name);
    }
    player.id = this.members.length === 0 ? 0 : w.players.length - 1;
    player.input = { up: false, down: false, left: false, right: false, firing: false, aimX: player.x + 40, aimY: player.y };
    player.down = false;

    const member = { conn, player, id: this.members.length };
    this.members.push(member);
    conn.data.member = member;
    conn.data.room = this;

    conn.send({
      t: 'welcome',
      id: member.id,
      name: player.name,
      players: this.members.map((m) => m.player.name),
    });
    this.sendMap(conn);
    this.broadcast({ t: 'sys', msg: `${player.name} 加入了` });
    if (!this.timer) this.start();
    return member;
  }

  leave(conn) {
    const member = this.members.find((m) => m.conn === conn);
    if (!member) return;
    this.members = this.members.filter((m) => m !== member);
    const w = this.world;
    if (member.id !== 0) {
      // 不是房主：直接从世界摘掉
      w.removePlayer(member.player);
    } else {
      member.player.name = '';
      member.player.alive = false;
    }
    this.broadcast({ t: 'sys', msg: `${member.player.name || '有人'} 离开了` });
    if (!this.members.length) {
      this.stop();
      this.onEmpty(this);
    }
  }

  /** 收消息：输入与操作 */
  handle(conn, msg) {
    const member = this.members.find((m) => m.conn === conn);
    if (!member) return;
    const w = this.world;
    const p = member.player;

    if (msg.t === 'input') {
      p.input = {
        up: !!msg.up,
        down: !!msg.down,
        left: !!msg.left,
        right: !!msg.right,
        firing: !!msg.firing,
        aimX: Number(msg.aimX) || p.x,
        aimY: Number(msg.aimY) || p.y,
      };
      return;
    }

    if (msg.t === 'act') {
      switch (msg.a) {
        case 'potion':
          w.usePotion(p);
          break;
        case 'switch':
          w.switchWeapon(msg.i, p);
          break;
        case 'cycle':
          w.cycleWeapon(msg.i >= 0 ? 1 : -1, p);
          break;
        case 'pick':
          w.pickupWeaponNearby(p);
          break;
        case 'choose':
          w.resolveChoice(Number(msg.i));
          break;
        case 'skip':
          w.skipPending();
          break;
        case 'buy':
          w.buyShop(Number(msg.i), p);
          break;
        case 'closeShop':
          w.closeShop();
          break;
        case 'continue':
          w.continueRun();
          this.mapDirty = true;
          break;
        case 'retire':
          w.endRun();
          break;
        case 'restart':
          w.startRun();
          this.mapDirty = true;
          break;
        default:
          break;
      }
    }
  }

  step() {
    const now = Date.now();
    let dt = (now - this.lastTick) / 1000;
    this.lastTick = now;
    if (dt > 0.25) dt = 0.25;

    const w = this.world;
    const prevDepth = w.depth;

    const inputs = w.players.map((p) =>
      this.members.some((m) => m.player === p)
        ? p.input
        : { up: false, down: false, left: false, right: false, firing: false, aimX: p.x, aimY: p.y },
    );
    w.tick(dt, inputs);

    if (w.depth !== prevDepth || w.screen === 'title') this.mapDirty = true;

    // 事件转发（音效、飘字这些表现层的东西）
    const evs = w.drainEvents();
    if (evs.length) this.broadcast({ t: 'evt', list: evs });

    // 地图变更时补发一份
    if (this.mapDirty) {
      this.mapDirty = false;
      for (const m of this.members) this.sendMap(m.conn);
    }

    // 快照
    this.tickAcc += dt;
    if (this.tickAcc >= 1 / SNAP_HZ) {
      this.tickAcc = 0;
      this.broadcastSnapshot();
    }
  }

  sendMap(conn) {
    const w = this.world;
    let tiles = '';
    for (let i = 0; i < w.tiles.length; i++) tiles += w.tiles[i];
    conn.send({
      t: 'map',
      depth: w.depth,
      w: w.mapW,
      h: w.mapH,
      tiles,
      stairs: w.stairs,
      screen: w.screen,
      paused: w.paused,
    });
  }

  broadcastSnapshot() {
    const w = this.world;
    const snap = {
      t: 'snap',
      depth: w.depth,
      screen: w.screen,
      paused: w.paused,
      stairs: w.stairs,
      restPrompt: w.restPrompt,
      pending: w.pending,
      pendingSkip: w.pendingSkip || false,
      shop: w.shop ? { stock: w.shop.stock } : null,
      players: w.players.map((p, i) => ({
        i,
        name: p.name || (i === 0 ? '房主' : '队友'),
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
        hp: Math.round(p.hp),
        maxHp: p.maxHp,
        aim: Math.round(p.aim * 100) / 100,
        alive: p.alive,
        level: p.level,
        flash: p.hitFlash > 0,
        moving: p.moving,
      })),
      enemies: w.enemies
        .filter((e) => !e.dead)
        .map((e) => ({
          x: Math.round(e.x * 10) / 10,
          y: Math.round(e.y * 10) / 10,
          type: e.type,
          hp: Math.max(0, Math.round(e.hp)),
          maxHp: e.maxHp,
          flash: e.flash > 0,
          boss: !!e.boss,
        })),
      items: w.items.map((it) => ({ x: it.x, y: it.y, kind: it.kind, amount: it.amount })),
      projectiles: w.projectiles.map((pr) => ({
        x: Math.round(pr.x),
        y: Math.round(pr.y),
        vx: pr.vx,
        vy: pr.vy,
        r: pr.r,
        from: pr.from,
        splash: pr.splash || 0,
      })),
      slashes: w.slashes.map((s) => ({ x: s.x, y: s.y, aim: s.aim, reach: s.reach, arc: s.arc, weapon: s.weapon })),
      blasts: w.blasts.map((b) => ({ x: b.x, y: b.y, r: b.r })),
      log: w.log.slice(-5),
    };

    const body = JSON.stringify(snap);
    for (const m of this.members) {
      const me = w.players[m.id];
      // 自己那份额外带上背包与经验，做 HUD 用
      m.conn.send(
        body.slice(0, -1) +
          `,"me":${JSON.stringify({
            hp: Math.round(me.hp),
            maxHp: me.maxHp,
            atk: me.atk,
            def: me.def,
            crit: me.crit,
            ls: me.ls,
            cdScale: me.cdScale,
            gold: me.gold,
            potion: me.potion,
            revive: me.revive,
            level: me.level,
            xp: me.xp,
            xpNext: me.xpNext,
            weapons: me.weapons,
            weaponIndex: me.weaponIndex,
            weapon: me.weapon.id,
            alive: me.alive,
            pendingLevels: w.pendingLevels || 0,
          })}}`,
      );
      void m;
    }
  }

  broadcast(obj) {
    const body = JSON.stringify(obj);
    for (const m of this.members) m.conn.send(body);
  }
}

/** 房间池：v1 只有一个大厅，人满了开新房 */
const rooms = [];

function joinAny(conn, name) {
  let room = rooms.find((r) => !r.full && r.members.length > 0);
  if (!room) {
    room = new Room((r) => {
      const i = rooms.indexOf(r);
      if (i >= 0) rooms.splice(i, 1);
    });
    rooms.push(room);
  }
  return room.join(conn, name);
}

module.exports = { Room, joinAny, rooms, Engine };
