'use strict';

/**
 * 实时引擎：全部游戏逻辑跑在浏览器里，服务器只提供静态文件与局外存档。
 * 坐标单位是像素（1 格 = 16px），地图 48x32 格 = 768x512 像素。
 * 依赖 UMD 模块：RNG / MapGen / FOV（由 src/ 直接加载）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const TILE = 16;
  const MAX_FLOOR = 5;
  const POTION_CAP = 3;

  const WEAPONS = {
    sword: { id: 'sword', name: '铁剑', kind: 'melee', mult: 1.0, cd: 0.3, reach: 24, arc: 1.7, desc: '近战挥砍，稳定' },
    spear: { id: 'spear', name: '长矛', kind: 'melee', mult: 0.9, cd: 0.38, reach: 40, arc: 0.75, desc: '长柄突刺，够远' },
    bow: { id: 'bow', name: '短弓', kind: 'ranged', mult: 0.85, cd: 0.36, reach: 0, arc: 0, speed: 360, life: 0.85, desc: '远程箭矢，可风筝' },
  };

  const ENEMY_TYPES = {
    slime: { name: '史莱姆', hp: 24, atk: 5, def: 0, speed: 56, r: 7, xp: 3, cd: 0.85 },
    rat: { name: '地鼠', hp: 13, atk: 4, def: 0, speed: 104, r: 6, xp: 2, cd: 0.55 },
    archer: { name: '邪术师', hp: 20, atk: 6, def: 0, speed: 62, r: 7, xp: 4, cd: 1.15, ranged: true, prefer: 130, projSpeed: 230 },
    brute: { name: '暴徒', hp: 52, atk: 10, def: 2, speed: 50, r: 9, xp: 7, cd: 1.2 },
    master: { name: '层主', hp: 150, atk: 11, def: 1, speed: 62, r: 11, xp: 20, cd: 0.8, boss: true },
    overlord: { name: '地牢之主', hp: 380, atk: 15, def: 4, speed: 66, r: 13, xp: 50, cd: 0.7, boss: true, final: true },
  };

  const UPGRADE_POOL = [
    { id: 'atk', name: '锋利', desc: '攻击力 +2', apply: (p) => { p.atk += 2; } },
    { id: 'hp', name: '坚韧', desc: '生命上限 +12，并回复 12', apply: (p) => { p.maxHp += 12; p.hp += 12; } },
    { id: 'speed', name: '迅捷', desc: '攻击冷却 -8%，移速 +4%', apply: (p) => { p.cdScale *= 0.92; p.speed *= 1.04; } },
    { id: 'crit', name: '致命', desc: '暴击率 +7%', apply: (p) => { p.crit += 0.07; } },
    { id: 'critdmg', name: '重击', desc: '暴击伤害 +25%', apply: (p) => { p.critDmg += 0.25; } },
    { id: 'ls', name: '汲取', desc: '吸血 +3%', apply: (p) => { p.ls += 0.03; } },
    { id: 'def', name: '护甲', desc: '防御 +1', apply: (p) => { p.def += 1; } },
    { id: 'range', name: '延伸', desc: '攻击距离 +1 格', apply: (p) => { p.rangeBonus += 1; } },
    { id: 'potion', name: '补给', desc: '获得 1 瓶药水（上限 3）', apply: (p) => { p.potion = Math.min(POTION_CAP, p.potion + 1); } },
    { id: 'regen', name: '再生', desc: '每秒回复 0.6 生命', apply: (p) => { p.regen += 0.6; } },
  ];

  const META_COST = [15, 25, 40, 60, 85];
  const META_MAX = 5;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const dist2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);

  function angleDelta(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d);
  }

  class World {
    constructor(meta, seed) {
      this.meta = meta || { crystals: 0, upgrades: { hp: 0, atk: 0 }, best: { floor: 0, kills: 0 }, runs: 0, wins: 0 };
      this.rng = new RNG(seed || ((Date.now() ^ (Math.random() * 1e9)) >>> 0));
      this.screen = 'title';
      this.events = [];
      this.log = [];
      this.paused = false;
      this.pending = null;
      this.pendingLevels = 0;
      this.t = 0;
      this.depth = 1;
      this.fovTimer = 0;
      this.nextId = 1;
    }

    /* ---------------- 生命周期 ---------------- */

    startRun() {
      this.rng = new RNG((Date.now() ^ (Math.random() * 1e9)) >>> 0);
      this.meta.runs = (this.meta.runs || 0) + 1;
      this.screen = 'playing';
      this.paused = false;
      this.pending = null;
      this.pendingLevels = 0;
      this.events = [];
      this.log = [];
      this.t = 0;
      this.runStats = { kills: 0, gold: 0, crystals: 0 };

      this.player = {
        x: 0,
        y: 0,
        hw: 5,
        hh: 5,
        hp: 60,
        maxHp: 60 + this.meta.upgrades.hp * 8,
        atk: 8 + this.meta.upgrades.atk * 2,
        def: 2,
        speed: 146,
        crit: 0.05,
        critDmg: 0,
        ls: 0,
        rangeBonus: 0,
        regen: 0,
        cdScale: 1,
        level: 1,
        xp: 0,
        xpNext: 16,
        gold: 0,
        potion: 1,
        revive: 0,
        weapon: WEAPONS.sword,
        aim: 0,
        cd: 0,
        invuln: 0,
        hitFlash: 0,
        moving: false,
        regenPool: 0,
      };
      this.player.hp = this.player.maxHp;

      this.enterFloor(1);
    }

    enterFloor(depth) {
      const f = MapGen.generateFloor(this.rng, depth);
      this.depth = depth;
      this.map = f;
      this.tiles = f.tiles;
      this.mapW = f.w;
      this.mapH = f.h;
      this.explored = new Uint8Array(this.mapW * this.mapH);
      this.visible = new Uint8Array(this.mapW * this.mapH);

      this.enemies = [];
      this.items = [];
      this.projectiles = [];
      this.slashes = [];
      this.bossSummoned = false;
      this.fovTimer = 0;

      const p = this.player;
      p.x = (f.start.x + 0.5) * TILE;
      p.y = (f.start.y + 0.5) * TILE;
      p.cd = 0;
      p.invuln = 1;
      p.hitFlash = 0;

      if (depth > 1) {
        const heal = Math.round(p.maxHp * 0.2);
        if (p.hp < p.maxHp) {
          const before = p.hp;
          p.hp = Math.min(p.maxHp, p.hp + heal);
          if (p.hp > before) this.addLog(`楼梯间的微光治愈了你（+${p.hp - before} 生命）。`);
        }
      }

      this.stairs = { x: (f.stairs.x + 0.5) * TILE, y: (f.stairs.y + 0.5) * TILE, locked: depth < MAX_FLOOR };
      this.stairsTile = f.stairs;

      // 可放置点：离出生点足够远的空地
      const free = [];
      for (let y = 1; y < this.mapH - 1; y++) {
        for (let x = 1; x < this.mapW - 1; x++) {
          if (this.tiles[y * this.mapW + x] !== MapGen.FLOOR) continue;
          if (x === f.start.x && y === f.start.y) continue;
          if (dist2(x, y, f.start.x, f.start.y) < 36) continue;
          free.push({ x, y });
        }
      }
      const spots = this.rng.shuffle(free);

      // 敌人：明快刷怪，数量随层数上升
      const pool =
        depth <= 1
          ? ['slime', 'rat', 'rat', 'slime']
          : depth <= 2
            ? ['slime', 'rat', 'archer', 'slime', 'rat']
            : depth <= 4
              ? ['slime', 'rat', 'archer', 'brute', 'rat', 'archer']
              : ['brute', 'archer', 'slime', 'archer', 'brute'];
      const count = Math.min(30, 9 + depth * 4);
      let cursor = 0;
      for (let i = 0; i < count && cursor < spots.length; i++, cursor++) {
        const type = pool[Math.floor(this.rng.float() * pool.length)];
        this.spawnEnemy(type, (spots[cursor].x + 0.5) * TILE, (spots[cursor].y + 0.5) * TILE);
      }

      // 层主 / 最终 Boss 守在楼梯旁（先找一个真正站得下的位置，别塞进墙里）
      const bossType = depth === MAX_FLOOR ? 'overlord' : 'master';
      const sx = (f.stairs.x + 0.5) * TILE;
      const sy = (f.stairs.y + 0.5) * TILE;
      const bossSpot = this.findFreeSpot(sx, sy, 4, Math.min(ENEMY_TYPES[bossType].r, 6));
      const boss = this.spawnEnemy(bossType, bossSpot.x, bossSpot.y);
      boss.awake = true;

      // 物品
      const itemSpots = spots.slice(cursor);
      let ic = 0;
      const goldPiles = 5 + depth;
      for (let i = 0; i < goldPiles && ic < itemSpots.length; i++, ic++) {
        this.items.push({
          id: this.nextId++,
          x: (itemSpots[ic].x + 0.5) * TILE,
          y: (itemSpots[ic].y + 0.5) * TILE,
          kind: 'gold',
          amount: this.rng.int(4, 9) + depth * 2,
        });
      }
      for (let i = 0; i < 2 && ic < itemSpots.length; i++, ic++) {
        this.items.push({ id: this.nextId++, x: (itemSpots[ic].x + 0.5) * TILE, y: (itemSpots[ic].y + 0.5) * TILE, kind: 'potion' });
      }
      if (ic < itemSpots.length) {
        this.items.push({ id: this.nextId++, x: (itemSpots[ic].x + 0.5) * TILE, y: (itemSpots[ic].y + 0.5) * TILE, kind: 'chest' });
        ic++;
      }
      if (ic < itemSpots.length && this.rng.chance(depth >= 3 ? 0.16 : 0.08)) {
        this.items.push({ id: this.nextId++, x: (itemSpots[ic].x + 0.5) * TILE, y: (itemSpots[ic].y + 0.5) * TILE, kind: 'revive' });
      }

      // 隐藏房奖励
      if (f.secret) {
        const s = f.secret;
        const put = (tx, ty, kind, amount) => {
          const px = (tx + 0.5) * TILE;
          const py = (ty + 0.5) * TILE;
          if (this.items.some((it) => Math.abs(it.x - px) < 4 && Math.abs(it.y - py) < 4)) return;
          this.items.push({ id: this.nextId++, x: px, y: py, kind, amount });
        };
        put(s.x, s.y, 'chest');
        put(s.x + s.w - 1, s.y, 'gold', 30 + depth * 10);
        put(s.x, s.y + s.h - 1, 'revive');
        this.addLog('这一层似乎藏着什么……（试试朝可疑的墙壁砍）');
      }

      this.addLog(`—— 第 ${depth} 层 · ${f.isCave ? '潮湿洞窟' : '石砌地牢'} ——`);
      this.updateFov();
    }

    /** 从指定点向外螺旋找第一个放得下实体（半径 r）的空地，找不到就返回原点 */
    findFreeSpot(cx, cy, maxR, r) {
      if (!this.blocked(cx, cy, r, r)) return { x: cx, y: cy };
      for (let ring = 1; ring <= maxR; ring++) {
        for (let dy = -ring; dy <= ring; dy++) {
          for (let dx = -ring; dx <= ring; dx++) {
            if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
            const x = cx + dx * TILE;
            const y = cy + dy * TILE;
            if (!this.blocked(x, y, r, r)) return { x, y };
          }
        }
      }
      return { x: cx, y: cy };
    }

    spawnEnemy(type, x, y) {
      const base = ENEMY_TYPES[type];
      const depth = this.depth;
      // 物理碰撞盒必须小于一格（16px），否则大块头永远过不了走廊
      const bodyR = Math.min(base.r, 6);
      // 出生点如果在墙里，实体永远移不出去，这里先挪到最近的空地
      if (this.blocked(x, y, bodyR, bodyR)) {
        const spot = this.findFreeSpot(x, y, 5, bodyR);
        x = spot.x;
        y = spot.y;
      }
      const hpScale = base.final ? 1.1 : 1 + 0.18 * (depth - 1);
      const atkScale = base.final ? 1.1 : 1 + 0.12 * (depth - 1);
      const e = {
        id: this.nextId++,
        type,
        name: base.name,
        x,
        y,
        hw: bodyR,
        hh: bodyR,
        r: base.r,
        maxHp: Math.round(base.hp * hpScale),
        hp: Math.round(base.hp * hpScale),
        atk: Math.round(base.atk * atkScale),
        def: base.def + (base.boss ? 0 : Math.floor(depth / 3)),
        speed: base.speed,
        xp: base.xp,
        ranged: !!base.ranged,
        prefer: base.prefer || 0,
        projSpeed: base.projSpeed || 0,
        boss: !!base.boss,
        final: !!base.final,
        attackCd: base.cd,
        cd: this.rng.float() * base.cd,
        awake: false,
        flash: 0,
        dead: false,
        vx: 0,
        vy: 0,
      };
      this.enemies.push(e);
      return e;
    }

    /* ---------------- 工具 ---------------- */

    addLog(msg) {
      this.log.push(msg);
      if (this.log.length > 40) this.log.shift();
    }

    emit(ev) {
      this.events.push(ev);
      if (this.events.length > 128) this.events.shift();
    }

    drainEvents() {
      if (!this.events.length) return [];
      const out = this.events;
      this.events = [];
      return out;
    }

    tileAt(tx, ty) {
      if (tx < 0 || ty < 0 || tx >= this.mapW || ty >= this.mapH) return MapGen.WALL;
      return this.tiles[ty * this.mapW + tx];
    }

    isSolidTile(tx, ty) {
      const t = this.tileAt(tx, ty);
      return t === MapGen.WALL || t === MapGen.SECRET;
    }

    /** AABB 与实心瓦片相交检测 */
    blocked(x, y, hw, hh) {
      const x0 = Math.floor((x - hw) / TILE);
      const x1 = Math.floor((x + hw - 0.001) / TILE);
      const y0 = Math.floor((y - hh) / TILE);
      const y1 = Math.floor((y + hh - 0.001) / TILE);
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          if (this.isSolidTile(tx, ty)) return true;
        }
      }
      return false;
    }

    /** 分轴移动，撞墙时该轴原地停下（可以贴着墙滑） */
    moveBody(b, dx, dy) {
      let blockedX = false;
      let blockedY = false;
      if (dx) {
        b.x += dx;
        if (this.blocked(b.x, b.y, b.hw, b.hh)) {
          b.x -= dx;
          blockedX = true;
        }
      }
      if (dy) {
        b.y += dy;
        if (this.blocked(b.x, b.y, b.hw, b.hh)) {
          b.y -= dy;
          blockedY = true;
        }
      }
      return { blockedX, blockedY };
    }

    /** 视线检测（用于远程敌人开火） */
    hasLine(x0, y0, x1, y1) {
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (TILE * 0.5));
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const tx = Math.floor((x0 + (x1 - x0) * t) / TILE);
        const ty = Math.floor((y0 + (y1 - y0) * t) / TILE);
        if (this.isSolidTile(tx, ty)) return false;
      }
      return true;
    }

    updateFov() {
      const pt = this.playerTile();
      this.visible = FOV.computeFov(
        pt.x,
        pt.y,
        8,
        (x, y) => this.isSolidTile(x, y),
        this.mapW,
        this.mapH,
      );
      for (let i = 0; i < this.visible.length; i++) {
        if (this.visible[i]) this.explored[i] = 1;
      }
    }

    playerTile() {
      return { x: Math.floor(this.player.x / TILE), y: Math.floor(this.player.y / TILE) };
    }

    /* ---------------- 主循环 ---------------- */

    tick(dt, input) {
      if (this.screen !== 'playing' || this.paused) return;
      dt = clamp(dt, 0, 0.05);
      this.t += dt;

      this.updatePlayer(dt, input);
      this.updateEnemies(dt);
      this.updateProjectiles(dt);
      this.updateItems();
      this.updateSlashes(dt);

      this.fovTimer -= dt;
      if (this.fovTimer <= 0) {
        this.updateFov();
        this.fovTimer = 0.09;
      }
    }

    updatePlayer(dt, input) {
      const p = this.player;

      let dx = 0;
      let dy = 0;
      if (input.left) dx -= 1;
      if (input.right) dx += 1;
      if (input.up) dy -= 1;
      if (input.down) dy += 1;
      p.moving = !!(dx || dy);
      if (p.moving) {
        const len = Math.hypot(dx, dy) || 1;
        this.moveBody(p, (dx / len) * p.speed * dt, (dy / len) * p.speed * dt);
      }

      p.aim = Math.atan2(input.aimY - p.y, input.aimX - p.x);

      if (p.cd > 0) p.cd -= dt;
      if (input.firing && p.cd <= 0) this.playerAttack();

      if (p.invuln > 0) p.invuln -= dt;
      if (p.hitFlash > 0) p.hitFlash -= dt;

      if (p.regen > 0) {
        p.regenPool += p.regen * dt;
        if (p.regenPool >= 1) {
          const gain = Math.floor(p.regenPool);
          p.regenPool -= gain;
          p.hp = Math.min(p.maxHp, p.hp + gain);
        }
      }

      // 站在解封的楼梯上自动下一层
      if (!this.stairs.locked && this.depth < MAX_FLOOR) {
        if (dist2(p.x, p.y, this.stairs.x, this.stairs.y) < 14 * 14) {
          this.emit({ type: 'stairs', depth: this.depth + 1 });
          this.enterFloor(this.depth + 1);
        }
      }
    }

    playerAttack() {
      const p = this.player;
      const w = p.weapon;
      p.cd = w.cd * p.cdScale;
      this.emit({ type: 'swing', weapon: w.id });

      if (w.kind === 'melee') {
        const reach = w.reach + p.rangeBonus * TILE;
        this.tryBreakSecret(reach);
        let hitAny = false;
        for (const e of this.enemies) {
          if (e.dead) continue;
          const d = Math.hypot(e.x - p.x, e.y - p.y);
          if (d > reach + e.r) continue;
          const ang = Math.atan2(e.y - p.y, e.x - p.x);
          if (angleDelta(ang, p.aim) > w.arc / 2) continue;
          this.damageEnemy(e, w.mult);
          hitAny = true;
        }
        this.slashes.push({
          x: p.x,
          y: p.y,
          aim: p.aim,
          reach,
          arc: w.arc,
          life: 0.13,
          max: 0.13,
        });
        if (!hitAny) this.emit({ type: 'whiff' });
      } else {
        const spread = this.rng.float() * 0.04 - 0.02;
        const a = p.aim + spread;
        this.projectiles.push({
          x: p.x + Math.cos(a) * 9,
          y: p.y + Math.sin(a) * 9,
          vx: Math.cos(a) * w.speed,
          vy: Math.sin(a) * w.speed,
          life: w.life,
          mult: w.mult,
          from: 'player',
          r: 3,
        });
      }
    }

    /** 把指定格子的裂墙打穿；不是裂墙就返回 false */
    breakWall(tx, ty) {
      if (this.tileAt(tx, ty) !== MapGen.SECRET) return false;
      this.tiles[ty * this.mapW + tx] = MapGen.FLOOR;
      this.addLog('墙壁裂开了，里面别有洞天！');
      this.emit({ type: 'secret', x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE });
      this.updateFov();
      return true;
    }

    /** 近战挥击时顺带把正前方的裂墙砍开 */
    tryBreakSecret(reach) {
      const p = this.player;
      for (let i = 1; i <= 2; i++) {
        const d = (reach + 8) * (i / 2);
        const tx = Math.floor((p.x + Math.cos(p.aim) * d) / TILE);
        const ty = Math.floor((p.y + Math.sin(p.aim) * d) / TILE);
        if (this.breakWall(tx, ty)) return true;
      }
      return false;
    }

    damageEnemy(e, mult) {
      const p = this.player;
      const crit = this.rng.chance(p.crit);
      const total = mult * (crit ? 1.5 + p.critDmg : 1);
      const dmg = Math.max(1, Math.round(p.atk * total - e.def * 0.5));
      e.hp -= dmg;
      e.flash = 0.14;
      e.awake = true;

      const heal = Math.floor(dmg * p.ls);
      if (heal > 0) p.hp = Math.min(p.maxHp, p.hp + heal);

      this.emit({ type: 'hit', x: e.x, y: e.y, dmg, crit, heal });
      if (e.hp <= 0) this.killEnemy(e);
    }

    killEnemy(e) {
      if (e.dead) return;
      e.dead = true;
      this.runStats.kills++;
      this.player.xp += e.xp;
      this.emit({ type: 'kill', x: e.x, y: e.y, name: e.name, boss: e.boss, final: e.final });

      if (e.boss) {
        const gain = e.final ? 25 : 4 + this.depth * 2;
        this.meta.crystals += gain;
        this.runStats.crystals += gain;
        this.addLog(`获得 ${gain} 晶石（局外货币）。`);
        this.emit({ type: 'bossDown', x: e.x, y: e.y });

        if (e.final) {
          this.win();
          return;
        }
        this.stairs.locked = false;
        this.addLog('楼梯的封印解除了。');
        const heal = Math.round(this.player.maxHp * 0.25);
        if (this.player.hp < this.player.maxHp) {
          const before = this.player.hp;
          this.player.hp = Math.min(this.player.maxHp, this.player.hp + heal);
          this.addLog(`层主的精华治愈了你（+${this.player.hp - before} 生命）。`);
        }
      }

      while (this.player.xp >= this.player.xpNext) {
        this.player.xp -= this.player.xpNext;
        this.player.level++;
        this.player.xpNext = Math.round(this.player.xpNext * 1.3) + 6;
        this.pendingLevels++;
        this.emit({ type: 'levelup', level: this.player.level });
      }
      if (this.pendingLevels > 0 && !this.pending) this.rollChoices();
    }

    rollChoices() {
      const picks = this.rng.shuffle(UPGRADE_POOL).slice(0, 3);
      this.pending = picks.map((u) => ({ id: u.id, name: u.name, desc: u.desc }));
      this.paused = true;
    }

    resolveChoice(index) {
      if (!this.pending) return;
      const pick = this.pending[index];
      if (!pick) return;
      const up = UPGRADE_POOL.find((u) => u.id === pick.id);
      if (up) up.apply(this.player);
      this.addLog(`选择强化：${up.name} —— ${up.desc}`);
      this.emit({ type: 'upgrade', id: pick.id });
      this.pendingLevels--;
      this.pending = null;
      if (this.pendingLevels > 0) {
        this.rollChoices();
      } else {
        this.paused = false;
      }
    }

    /* ---------------- 敌人 ---------------- */

    updateEnemies(dt) {
      const p = this.player;
      const alive = [];
      for (const e of this.enemies) {
        if (e.dead) continue;
        alive.push(e);

        if (e.flash > 0) e.flash -= dt;
        if (e.cd > 0) e.cd -= dt;

        const dx = p.x - e.x;
        const dy = p.y - e.y;
        const d = Math.hypot(dx, dy) || 1;

        if (!e.awake) {
          if (d < 240) e.awake = true;
          else continue;
        }

        if (e.final && !this.bossSummoned && e.hp < e.maxHp * 0.5) {
          this.bossSummoned = true;
          this.addLog('地牢之主发出咆哮，召唤了援军！');
          this.emit({ type: 'summon', x: e.x, y: e.y });
          for (let i = 0; i < 3; i++) {
            const a = (Math.PI * 2 * i) / 3 + this.rng.float();
            this.spawnEnemy('slime', e.x + Math.cos(a) * 28, e.y + Math.sin(a) * 28).awake = true;
          }
        }

        const ux = dx / d;
        const uy = dy / d;

        if (e.ranged) {
          if (d < e.prefer - 25) {
            this.moveBody(e, -ux * e.speed * dt, -uy * e.speed * dt);
          } else if (d > e.prefer + 35) {
            this.moveBody(e, ux * e.speed * dt, uy * e.speed * dt);
          }
          if (d < 300 && e.cd <= 0 && this.hasLine(e.x, e.y, p.x, p.y)) {
            e.cd = e.attackCd;
            const ang = Math.atan2(dy, dx);
            this.projectiles.push({
              x: e.x + Math.cos(ang) * 10,
              y: e.y + Math.sin(ang) * 10,
              vx: Math.cos(ang) * e.projSpeed,
              vy: Math.sin(ang) * e.projSpeed,
              life: 2.4,
              dmg: e.atk,
              from: 'enemy',
              r: 4,
            });
          }
        } else {
          const stopAt = e.r + p.hw + 1;
          if (d > stopAt) {
            this.moveBody(e, ux * e.speed * dt, uy * e.speed * dt);
          } else if (e.cd <= 0) {
            e.cd = e.attackCd;
            this.hurtPlayer(e.atk, e);
          }
        }
      }

      // 敌我分离，避免叠成一坨
      for (let i = 0; i < alive.length; i++) {
        const a = alive[i];
        for (let j = i + 1; j < alive.length; j++) {
          const b = alive[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const min = a.r + b.r;
          const d2 = dx * dx + dy * dy;
          if (d2 > min * min || d2 < 0.001) continue;
          const d = Math.sqrt(d2);
          const push = (min - d) * 0.5;
          const nx = dx / d;
          const ny = dy / d;
          this.moveBody(a, -nx * push, -ny * push);
          this.moveBody(b, nx * push, ny * push);
        }
      }
    }

    hurtPlayer(dmg, from) {
      const p = this.player;
      if (p.invuln > 0) return;
      const raw = dmg * (0.9 + this.rng.float() * 0.2);
      const real = Math.max(1, Math.round(raw - p.def * 0.5));
      p.hp -= real;
      p.invuln = 0.55;
      p.hitFlash = 0.3;
      this.emit({ type: 'playerHit', dmg: real, x: p.x, y: p.y, from: from ? from.type : 'unknown' });
      if (p.hp <= 0) this.handleDeath();
    }

    handleDeath() {
      const p = this.player;
      if (p.revive > 0) {
        p.revive--;
        p.hp = Math.ceil(p.maxHp * 0.5);
        p.invuln = 2;
        this.addLog('生命护符碎裂，你重新站了起来！');
        this.emit({ type: 'revive', x: p.x, y: p.y });
        return;
      }
      p.hp = 0;
      this.screen = 'dead';
      this.deathInfo = { floor: this.depth, kills: this.runStats.kills, gold: this.runStats.gold, crystals: this.runStats.crystals };
      this.meta.best.floor = Math.max(this.meta.best.floor || 0, this.depth);
      this.meta.best.kills = Math.max(this.meta.best.kills || 0, this.runStats.kills);
      this.emit({ type: 'dead' });
    }

    win() {
      const bonus = 30;
      this.meta.crystals += bonus;
      this.runStats.crystals += bonus;
      this.meta.wins = (this.meta.wins || 0) + 1;
      this.meta.best.floor = MAX_FLOOR;
      this.meta.best.kills = Math.max(this.meta.best.kills || 0, this.runStats.kills);
      this.screen = 'won';
      this.winInfo = {
        floor: this.depth,
        kills: this.runStats.kills,
        gold: this.runStats.gold,
        crystals: this.runStats.crystals,
        bonus,
      };
      this.emit({ type: 'win' });
    }

    /* ---------------- 投射物 / 拾取 / 刀光 ---------------- */

    updateProjectiles(dt) {
      const p = this.player;
      const keep = [];
      for (const pr of this.projectiles) {
        pr.life -= dt;
        if (pr.life <= 0) continue;

        // 分步推进：单帧位移可能超过一格，整段推进会让箭矢穿过薄墙和敌人
        const travel = Math.hypot(pr.vx, pr.vy) * dt;
        const steps = Math.max(1, Math.ceil(travel / 8));
        const dx = (pr.vx * dt) / steps;
        const dy = (pr.vy * dt) / steps;
        let consumed = false;

        for (let s = 0; s < steps && !consumed; s++) {
          pr.x += dx;
          pr.y += dy;

          const tx = Math.floor(pr.x / TILE);
          const ty = Math.floor(pr.y / TILE);
          const t = this.tileAt(tx, ty);

          if (t === MapGen.SECRET) {
            // 箭矢也能打穿裂墙；只有玩家的箭算数，敌人的弹丸不会替玩家开路
            if (pr.from === 'player') this.breakWall(tx, ty);
            this.emit({ type: 'impact', x: pr.x, y: pr.y });
            consumed = true;
            break;
          }
          if (t === MapGen.WALL) {
            this.emit({ type: 'impact', x: pr.x, y: pr.y });
            consumed = true;
            break;
          }

          if (pr.from === 'player') {
            let hit = null;
            for (const e of this.enemies) {
              if (e.dead) continue;
              if (dist2(pr.x, pr.y, e.x, e.y) < (e.r + pr.r) * (e.r + pr.r)) {
                hit = e;
                break;
              }
            }
            if (hit) {
              this.damageEnemy(hit, pr.mult);
              consumed = true;
            }
          } else if (p.invuln <= 0 && dist2(pr.x, pr.y, p.x, p.y) < (p.hw + pr.r) * (p.hw + pr.r)) {
            this.hurtPlayer(pr.dmg, { type: 'bolt' });
            consumed = true;
          }
        }

        if (!consumed) keep.push(pr);
      }
      this.projectiles = keep;
    }

    updateSlashes(dt) {
      const keep = [];
      for (const s of this.slashes) {
        s.life -= dt;
        if (s.life > 0) keep.push(s);
      }
      this.slashes = keep;
    }

    updateItems() {
      const p = this.player;
      const keep = [];
      for (const it of this.items) {
        if (dist2(it.x, it.y, p.x, p.y) < 13 * 13) {
          this.pickup(it);
        } else {
          keep.push(it);
        }
      }
      this.items = keep;
    }

    pickup(item) {
      const p = this.player;
      if (item.kind === 'gold') {
        p.gold += item.amount;
        this.runStats.gold += item.amount;
        this.emit({ type: 'pickup', kind: 'gold', amount: item.amount, x: item.x, y: item.y });
      } else if (item.kind === 'potion') {
        if (p.potion >= POTION_CAP) {
          this.items.push(item);
          return;
        }
        p.potion++;
        this.emit({ type: 'pickup', kind: 'potion', x: item.x, y: item.y });
      } else if (item.kind === 'revive') {
        if (p.revive > 0) {
          p.gold += 20;
          this.emit({ type: 'pickup', kind: 'gold', amount: 20, x: item.x, y: item.y });
        } else {
          p.revive = 1;
          this.emit({ type: 'pickup', kind: 'revive', x: item.x, y: item.y });
          this.addLog('获得「生命护符」：死亡时自动复活一次！');
        }
      } else if (item.kind === 'chest') {
        const options = Object.values(WEAPONS).filter((w) => w.id !== p.weapon.id);
        const w = this.rng.pick(options);
        p.weapon = w;
        this.addLog(`打开宝箱，换上「${w.name}」（${w.desc}）。`);
        this.emit({ type: 'pickup', kind: 'chest', weapon: w.id, x: item.x, y: item.y });
      }
    }

    usePotion() {
      const p = this.player;
      if (p.potion <= 0) {
        this.addLog('没有药水了。');
        return;
      }
      if (p.hp >= p.maxHp) {
        this.addLog('生命已满，先留着自己喝。');
        return;
      }
      p.potion--;
      const heal = Math.round(p.maxHp * 0.4);
      p.hp = Math.min(p.maxHp, p.hp + heal);
      this.addLog(`饮下药水，回复 ${heal} 点生命。`);
      this.emit({ type: 'heal', amount: heal, x: p.x, y: p.y });
    }

    /* ---------------- 局外养成 ---------------- */

    upgradeMeta(stat) {
      if (stat !== 'hp' && stat !== 'atk') return false;
      const lvl = this.meta.upgrades[stat] || 0;
      if (lvl >= META_MAX) return false;
      const cost = META_COST[lvl];
      if (this.meta.crystals < cost) return false;
      this.meta.crystals -= cost;
      this.meta.upgrades[stat] = lvl + 1;
      return true;
    }

    /* ---------------- 调试 ---------------- */

    debugGoto(depth) {
      if (this.screen !== 'playing') return;
      const d = clamp(Number(depth) || 1, 1, MAX_FLOOR);
      this.enterFloor(d);
    }
  }

  return { World, TILE, MAX_FLOOR, WEAPONS, ENEMY_TYPES, META_COST, META_MAX, POTION_CAP };
});
