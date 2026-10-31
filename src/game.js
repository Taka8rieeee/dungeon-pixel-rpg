'use strict';

const { RNG } = require('./rng');
const { computeFov } = require('./fov');
const M = require('./mapgen');

const VIEW_RADIUS = 8;
const MAX_FLOOR = 5;
const POTION_CAP = 3;

const WEAPONS = {
  sword: { id: 'sword', name: '铁剑', mult: 1.0, range: 1, ranged: false, desc: '近战 1 格，稳定' },
  spear: { id: 'spear', name: '长矛', mult: 0.95, range: 2, ranged: false, desc: '近战 2 格，安全' },
  bow: { id: 'bow', name: '短弓', mult: 0.9, range: 6, ranged: true, desc: '远程 6 格，可风筝' },
};

const ENEMY_BASE = {
  slime: { name: '史莱姆', hp: 14, atk: 4, def: 0, speed: 78, xp: 4 },
  rat: { name: '地鼠', hp: 8, atk: 3, def: 0, speed: 145, xp: 3 },
  archer: { name: '邪术师', hp: 12, atk: 5, def: 0, speed: 100, xp: 5, ranged: true },
  brute: { name: '暴徒', hp: 30, atk: 9, def: 2, speed: 68, xp: 8 },
  master: { name: '层主', hp: 44, atk: 6, def: 1, speed: 84, xp: 25, boss: true },
  overlord: { name: '地牢之主', hp: 110, atk: 12, def: 4, speed: 90, xp: 60, boss: true, final: true },
};

const UPGRADE_POOL = [
  { id: 'atk', name: '锋利', desc: '攻击 +2', apply: (g) => { g.player.atk += 2; } },
  { id: 'hp', name: '坚韧', desc: '生命上限 +10，并立刻回复 10', apply: (g) => { g.player.maxHp += 10; g.player.hp += 10; } },
  { id: 'speed', name: '迅捷', desc: '行动速度 +10%（移动与攻击都更快）', apply: (g) => { g.player.speed += 10; } },
  { id: 'crit', name: '致命', desc: '暴击率 +7%', apply: (g) => { g.player.crit += 0.07; } },
  { id: 'critdmg', name: '重击', desc: '暴击伤害 +25%', apply: (g) => { g.player.critDmg += 0.25; } },
  { id: 'ls', name: '汲取', desc: '吸血 +3%', apply: (g) => { g.player.ls += 0.03; } },
  { id: 'def', name: '护甲', desc: '防御 +1', apply: (g) => { g.player.def += 1; } },
  { id: 'range', name: '延伸', desc: '攻击距离 +1', apply: (g) => { g.player.rangeBonus += 1; } },
  { id: 'potion', name: '补给', desc: '获得 1 瓶药水（上限 3）', apply: (g) => { g.player.potion = Math.min(POTION_CAP, g.player.potion + 1); } },
  { id: 'regen', name: '再生', desc: '每 6 个你的回合回复 1 点生命', apply: (g) => { g.player.regen += 1; } },
];

const META_COST = [15, 25, 40, 60, 85];
const META_MAX = 5;

class Game {
  constructor(meta, persist) {
    this.meta = meta;
    this.persist = persist || (() => {});
    this.screen = 'title';
    this.log = [];
    this.pending = null;
    this.pendingLevels = 0;
    this.rng = new RNG(Date.now() >>> 0);
    this.depth = 1;
    this.turn = 0;
    this.bossSummoned = false;
    this.events = [];
  }

  /* ---------------- 生命周期 ---------------- */

  startRun() {
    this.rng = new RNG((Date.now() ^ (Math.random() * 1e9)) >>> 0);
    this.meta.runs = (this.meta.runs || 0) + 1;
    this.turn = 0;
    this.pending = null;
    this.pendingLevels = 0;
    this.log = [];
    this.events = [];
    this.runStats = { kills: 0, gold: 0, crystals: 0, startedAt: Date.now() };

    this.player = {
      x: 0,
      y: 0,
      hp: 60,
      maxHp: 60 + this.meta.upgrades.hp * 8,
      atk: 8 + this.meta.upgrades.atk * 2,
      def: 2,
      speed: 100,
      crit: 0.05,
      critDmg: 0,
      ls: 0,
      rangeBonus: 0,
      regen: 0,
      level: 1,
      xp: 0,
      xpNext: 14,
      gold: 0,
      potion: 1,
      revive: 0,
      weapon: WEAPONS.sword,
      next: 0,
      invuln: 0,
      regenCounter: 0,
    };
    this.player.hp = this.player.maxHp;

    this.screen = 'playing';
    this.enterFloor(1);
  }

  enterFloor(depth) {
    const f = M.generateFloor(this.rng, depth);
    this.depth = depth;
    if (depth > 1) {
      const heal = Math.round(this.player.maxHp * 0.2);
      if (this.player.hp < this.player.maxHp) {
        const before = this.player.hp;
        this.player.hp = Math.min(this.player.maxHp, this.player.hp + heal);
        if (this.player.hp > before) this.addLog(`楼梯间的微光治愈了你（+${this.player.hp - before} 生命）。`);
      }
    }
    this.mapW = f.w;
    this.mapH = f.h;
    this.tiles = f.tiles;
    this.explored = new Uint8Array(this.mapW * this.mapH);
    this.visible = new Uint8Array(this.mapW * this.mapH);
    this.enemies = [];
    this.items = [];
    this.bossSummoned = false;
    this.nextId = 1;

    this.player.x = f.start.x;
    this.player.y = f.start.y;
    this.player.next = 0;

    this.stairs = { x: f.stairs.x, y: f.stairs.y, locked: depth < MAX_FLOOR };

    const { dist } = M.bfsFrom(this.tiles, f.start.x, f.start.y);
    const free = [];
    for (let y = 1; y < this.mapH - 1; y++) {
      for (let x = 1; x < this.mapW - 1; x++) {
        const t = this.tiles[M.idx(x, y)];
        if (t !== M.FLOOR) continue;
        if (x === f.start.x && y === f.start.y) continue;
        if (dist[M.idx(x, y)] < 6) continue;
        free.push({ x, y });
      }
    }

    // 敌人
    const pool = depth <= 1 ? ['slime', 'rat', 'rat', 'slime'] : depth <= 2 ? ['slime', 'rat', 'archer', 'slime'] : depth <= 4 ? ['slime', 'rat', 'archer', 'brute', 'archer'] : ['brute', 'archer', 'slime', 'archer'];
    const count = Math.min(16, 5 + depth * 2);
    const spots = this.rng.shuffle(free);
    for (let i = 0; i < count && i < spots.length; i++) {
      this.spawnEnemy(pool[Math.floor(this.rng.float() * pool.length)], spots[i].x, spots[i].y);
    }

    // 层主 / 最终 Boss
    const bossType = depth === MAX_FLOOR ? 'overlord' : 'master';
    const nearStairs = this.findNear(f.stairs.x, f.stairs.y, 2, (x, y) => this.tiles[M.idx(x, y)] === M.FLOOR && !this.enemyAt(x, y));
    const bossSpot = nearStairs || { x: f.stairs.x, y: f.stairs.y };
    const boss = this.spawnEnemy(bossType, bossSpot.x, bossSpot.y);
    boss.awake = true;

    // 物品
    const itemSpots = this.rng.shuffle(free.filter((s) => !this.enemyAt(s.x, s.y)));
    let cursor = 0;
    const goldPiles = 4 + depth;
    for (let i = 0; i < goldPiles && cursor < itemSpots.length; i++, cursor++) {
      this.items.push({ id: this.nextId++, x: itemSpots[cursor].x, y: itemSpots[cursor].y, kind: 'gold', amount: this.rng.int(4, 9) + depth * 2 });
    }
    for (let i = 0; i < 2 && cursor < itemSpots.length; i++, cursor++) {
      this.items.push({ id: this.nextId++, x: itemSpots[cursor].x, y: itemSpots[cursor].y, kind: 'potion' });
    }
    if (cursor < itemSpots.length) {
      this.items.push({ id: this.nextId++, x: itemSpots[cursor].x, y: itemSpots[cursor].y, kind: 'chest' });
      cursor++;
    }
    if (cursor < itemSpots.length && this.rng.chance(depth >= 3 ? 0.16 : 0.07)) {
      this.items.push({ id: this.nextId++, x: itemSpots[cursor].x, y: itemSpots[cursor].y, kind: 'revive' });
    }

    // 隐藏房奖励
    if (f.secret) {
      const sx = f.secret.x;
      const sy = f.secret.y;
      const sw = f.secret.w;
      const sh = f.secret.h;
      const spots = [
        { x: sx, y: sy, kind: 'chest' },
        { x: sx + sw - 1, y: sy, kind: 'gold', amount: 30 + depth * 10 },
        { x: sx, y: sy + sh - 1, kind: 'revive' },
      ];
      const used = new Set();
      for (const spot of spots) {
        const key = spot.x + ',' + spot.y;
        if (used.has(key)) continue;
        used.add(key);
        if (this.items.some((it) => it.x === spot.x && it.y === spot.y)) continue;
        this.items.push({ id: this.nextId++, x: spot.x, y: spot.y, kind: spot.kind, amount: spot.amount });
      }
      this.addLog('这一层似乎藏着什么……（试试攻击可疑的墙壁）');
    }

    this.addLog(`—— 第 ${depth} 层 · ${f.isCave ? '潮湿洞窟' : '石砌地牢'} ——`);
    this.updateFov();
  }

  spawnEnemy(type, x, y) {
    const depth = this.depth;
    const base = ENEMY_BASE[type];
    const hpScale = base.final ? 1.1 : 1 + 0.22 * (depth - 1);
    const atkScale = base.final ? 1.1 : 1 + 0.14 * (depth - 1);
    const e = {
      id: this.nextId++,
      type,
      name: base.name,
      x,
      y,
      maxHp: Math.round(base.hp * hpScale),
      hp: Math.round(base.hp * hpScale),
      atk: Math.round(base.atk * atkScale),
      def: base.def + (base.boss ? 0 : Math.floor(depth / 3)),
      speed: base.speed,
      xp: base.xp,
      ranged: !!base.ranged,
      boss: !!base.boss,
      final: !!base.final,
      awake: false,
      next: 0,
      hitFlash: 0,
    };
    this.enemies.push(e);
    return e;
  }

  /* ---------------- 查询 ---------------- */

  tileAt(x, y) {
    if (x < 0 || y < 0 || x >= this.mapW || y >= this.mapH) return M.WALL;
    return this.tiles[y * this.mapW + x];
  }

  enemyAt(x, y) {
    return this.enemies.find((e) => e.hp > 0 && e.x === x && e.y === y) || null;
  }

  isWalkable(x, y) {
    const t = this.tileAt(x, y);
    return t === M.FLOOR || t === M.STAIRS;
  }

  isOpaque(x, y) {
    const t = this.tileAt(x, y);
    return t === M.WALL || t === M.SECRET;
  }

  findNear(cx, cy, radius, test) {
    for (let r = 0; r <= radius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (x < 1 || y < 1 || x >= this.mapW - 1 || y >= this.mapH - 1) continue;
          if (test(x, y)) return { x, y };
        }
      }
    }
    return null;
  }

  hasLine(x0, y0, x1, y1) {
    let dx = Math.abs(x1 - x0);
    let dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    let guard = 0;
    while (guard++ < 200) {
      if (x === x1 && y === y1) return true;
      if (!(x === x0 && y === y0) && this.isOpaque(x, y)) return false;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }
    return false;
  }

  updateFov() {
    this.visible = computeFov(
      this.player.x,
      this.player.y,
      VIEW_RADIUS,
      (x, y) => this.isOpaque(x, y),
      this.mapW,
      this.mapH,
    );
    for (let i = 0; i < this.visible.length; i++) {
      if (this.visible[i]) this.explored[i] = 1;
    }
  }

  addLog(msg) {
    this.log.push(msg);
    if (this.log.length > 40) this.log.shift();
  }

  /**
   * 表现层事件：与游戏逻辑无关，只描述“刚刚发生了什么”，供前端播放音效/飘字/震屏。
   * 每次请求取走一次即弃，不参与存档，也不影响回合结算。
   */
  emit(ev) {
    this.events.push(ev);
    if (this.events.length > 64) this.events.shift();
  }

  drainEvents() {
    if (!this.events || !this.events.length) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  /* ---------------- 主要动作 ---------------- */

  handle(action) {
    if (!action || typeof action !== 'object') return this.getState();
    if (this.screen !== 'playing') return this.getState();

    if (this.pending) {
      if (action.type === 'choose') this.resolveChoice(action.index);
      return this.getState();
    }

    switch (action.type) {
      case 'move':
        this.tryMove(action.dx, action.dy);
        break;
      case 'attack':
        this.tryAttack(action.dx, action.dy);
        break;
      case 'wait':
        this.endPlayerTurn(0.7);
        break;
      case 'potion':
        this.usePotion();
        break;
      default:
        break;
    }
    return this.getState();
  }

  tryMove(dx, dy) {
    if (!dx && !dy) return;
    const nx = this.player.x + dx;
    const ny = this.player.y + dy;

    if (this.enemyAt(nx, ny)) {
      this.tryAttack(dx, dy);
      return;
    }
    if (!this.isWalkable(nx, ny)) {
      if (this.tileAt(nx, ny) === M.SECRET) this.tryAttack(dx, dy);
      return;
    }

    this.player.x = nx;
    this.player.y = ny;
    this.pickupAt(nx, ny);

    if (this.tileAt(nx, ny) === M.STAIRS) {
      if (this.stairs.locked) {
        this.addLog('楼梯被层主的结界封印着。');
      } else if (this.depth >= MAX_FLOOR) {
        this.addLog('这里没有向下的路了。');
      } else {
        this.emit({ type: 'stairs', depth: this.depth + 1 });
        this.endPlayerTurn(1);
        this.enterFloor(this.depth + 1);
        return;
      }
    }

    this.endPlayerTurn(1);
  }

  tryAttack(dx, dy) {
    if (!dx && !dy) return;
    this.emit({ type: 'swing', dx, dy });
    const weapon = this.player.weapon;
    const maxRange = weapon.range + this.player.rangeBonus;
    let target = null;
    let hitX = 0;
    let hitY = 0;

    for (let step = 1; step <= maxRange; step++) {
      const x = this.player.x + dx * step;
      const y = this.player.y + dy * step;
      const t = this.tileAt(x, y);
      if (t === M.WALL) break;
      if (t === M.SECRET && step === 1) {
        this.tiles[y * this.mapW + x] = M.FLOOR;
        this.addLog('墙壁裂开了，里面别有洞天！');
        this.emit({ type: 'secret', x, y });
        this.updateFov();
        this.endPlayerTurn(1);
        return;
      }
      const e = this.enemyAt(x, y);
      if (e) {
        target = e;
        hitX = x;
        hitY = y;
        break;
      }
    }

    if (target) {
      const crit = this.rng.chance(this.player.crit);
      const mult = weapon.mult * (crit ? 1.5 + this.player.critDmg : 1);
      const dmg = Math.max(1, Math.round(this.player.atk * mult - target.def * 0.5));
      target.hp -= dmg;
      target.awake = true;
      target.hitFlash = 2;
      const heal = Math.floor(dmg * this.player.ls);
      if (heal > 0) {
        this.player.hp = Math.min(this.player.maxHp, this.player.hp + heal);
      }
      this.addLog(`${crit ? '暴击！' : ''}你对${target.name}造成 ${dmg} 伤害${heal ? `（吸血 +${heal}）` : ''}`);
      this.emit({ type: 'hit', x: hitX, y: hitY, dmg, crit, heal });
      if (target.hp <= 0) this.killEnemy(target);
    }

    this.endPlayerTurn(1);
  }

  usePotion() {
    if (this.player.potion <= 0) {
      this.addLog('没有药水了。');
      return;
    }
    if (this.player.hp >= this.player.maxHp) {
      this.addLog('生命已满，先留着自己喝。');
      return;
    }
    this.player.potion--;
    const heal = Math.round(this.player.maxHp * 0.4);
    this.player.hp = Math.min(this.player.maxHp, this.player.hp + heal);
    this.addLog(`饮下药水，回复 ${heal} 点生命。`);
    this.emit({ type: 'heal', amount: heal, x: this.player.x, y: this.player.y });
    this.endPlayerTurn(1);
  }

  pickupAt(x, y) {
    const item = this.items.find((it) => it.x === x && it.y === y);
    if (!item) return;
    this.items = this.items.filter((it) => it.id !== item.id);

    if (item.kind === 'gold') {
      this.player.gold += item.amount;
      this.runStats.gold += item.amount;
      this.addLog(`拾取 ${item.amount} 金币。`);
      this.emit({ type: 'pickup', kind: 'gold', amount: item.amount, x, y });
    } else if (item.kind === 'potion') {
      if (this.player.potion >= POTION_CAP) {
        this.addLog('药水已满，留在原地。');
        this.items.push(item);
        return;
      }
      this.player.potion++;
      this.addLog('获得 1 瓶药水。');
      this.emit({ type: 'pickup', kind: 'potion', x, y });
    } else if (item.kind === 'revive') {
      if (this.player.revive > 0) {
        this.player.gold += 20;
        this.addLog('多余的生命护符化作 20 金币。');
        this.emit({ type: 'pickup', kind: 'gold', amount: 20, x, y });
      } else {
        this.player.revive = 1;
        this.addLog('获得「生命护符」：死亡时自动复活一次！');
        this.emit({ type: 'pickup', kind: 'revive', x, y });
      }
    } else if (item.kind === 'chest') {
      const options = Object.values(WEAPONS).filter((w) => w.id !== this.player.weapon.id);
      const w = this.rng.pick(options);
      this.player.weapon = w;
      this.addLog(`打开宝箱，换上「${w.name}」（${w.desc}）。`);
      this.emit({ type: 'pickup', kind: 'chest', weapon: w.id, x, y });
    }
  }

  killEnemy(e) {
    this.enemies = this.enemies.filter((x) => x.id !== e.id);
    this.runStats.kills++;
    this.addLog(`${e.name}被击败了。`);
    this.emit({ type: 'kill', x: e.x, y: e.y, name: e.name, boss: !!e.boss, final: !!e.final });
    this.player.xp += e.xp;

    if (e.boss) {
      const gain = e.final ? 25 : 4 + this.depth * 2;
      this.meta.crystals += gain;
      this.runStats.crystals += gain;
      this.addLog(`获得 ${gain} 晶石（局外货币）。`);
      this.persist();
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
      this.player.xpNext = Math.round(this.player.xpNext * 1.32) + 4;
      this.pendingLevels++;
      this.addLog(`升级！现在是 ${this.player.level} 级。`);
      this.emit({ type: 'levelup', level: this.player.level, x: this.player.x, y: this.player.y });
    }
    if (!this.pending && this.pendingLevels > 0) this.rollChoices();
  }

  rollChoices() {
    const picks = this.rng.shuffle(UPGRADE_POOL).slice(0, 3);
    this.pending = picks.map((u) => ({ id: u.id, name: u.name, desc: u.desc }));
  }

  resolveChoice(index) {
    if (!this.pending) return;
    const pick = this.pending[index];
    if (!pick) return;
    const upgrade = UPGRADE_POOL.find((u) => u.id === pick.id);
    if (upgrade) upgrade.apply(this);
    this.addLog(`选择强化：${upgrade.name} —— ${upgrade.desc}`);
    this.emit({ type: 'upgrade', id: upgrade.id, name: upgrade.name });
    this.pendingLevels--;
    this.pending = null;
    if (this.pendingLevels > 0) {
      this.rollChoices();
    } else {
      this.endPlayerTurn(0.2);
    }
  }

  endPlayerTurn(cost = 1) {
    if (this.screen !== 'playing') return;
    this.turn++;
    if (this.player.invuln > 0) this.player.invuln--;
    if (this.player.regen > 0) {
      this.player.regenCounter += 1;
      if (this.player.regenCounter >= 6) {
        this.player.regenCounter = 0;
        this.player.hp = Math.min(this.player.maxHp, this.player.hp + this.player.regen);
      }
    }
    this.player.next += (1000 / this.player.speed) * cost;
    this.updateFov();
    if (this.pending) return;
    this.resolveAi();
  }

  resolveAi() {
    if (this.screen !== 'playing') return;
    const dist = this.computeDistField();
    let guard = 0;
    while (guard++ < 500) {
      const alive = this.enemies.filter((e) => e.hp > 0);
      if (!alive.length) break;
      alive.sort((a, b) => a.next - b.next);
      const e = alive[0];
      if (e.next > this.player.next) break;
      this.enemyTurn(e, dist);
      e.next += 1000 / e.speed;
      if (this.screen !== 'playing') break;
    }
  }

  computeDistField() {
    const dist = new Int32Array(this.mapW * this.mapH).fill(-1);
    const start = this.player.y * this.mapW + this.player.x;
    dist[start] = 0;
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      const x = i % this.mapW;
      const y = (i - x) / this.mapW;
      for (const [dx, dy] of M.DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!this.isWalkable(nx, ny)) continue;
        const j = ny * this.mapW + nx;
        if (dist[j] !== -1) continue;
        dist[j] = dist[i] + 1;
        queue.push(j);
      }
    }
    return dist;
  }

  enemyTurn(e, dist) {
    if (e.hp <= 0) return;
    const p = this.player;
    const d = dist[e.y * this.mapW + e.x];

    if (!e.awake) {
      if (d >= 0 && d <= 9) e.awake = true;
      else return;
    }

    if (e.final && !this.bossSummoned && e.hp < e.maxHp * 0.5) {
      this.bossSummoned = true;
      this.addLog('地牢之主发出咆哮，召唤了援军！');
      this.emit({ type: 'summon', x: e.x, y: e.y });
      const spots = M.DIRS.map(([dx, dy]) => ({ x: e.x + dx, y: e.y + dy }))
        .filter((s) => this.isWalkable(s.x, s.y) && !this.enemyAt(s.x, s.y) && !(s.x === p.x && s.y === p.y));
      spots.slice(0, 3).forEach((s) => this.spawnEnemy('slime', s.x, s.y));
    }

    if (e.ranged && d <= 7 && this.hasLine(e.x, e.y, p.x, p.y)) {
      this.enemyAttack(e, true);
      return;
    }
    if (d === 1) {
      this.enemyAttack(e, false);
      return;
    }
    if (d < 0) return;

    let best = null;
    let bestD = d;
    for (const [dx, dy] of M.DIRS) {
      const nx = e.x + dx;
      const ny = e.y + dy;
      if (!this.isWalkable(nx, ny)) continue;
      if (this.enemyAt(nx, ny)) continue;
      if (nx === p.x && ny === p.y) continue;
      const nd = dist[ny * this.mapW + nx];
      if (nd >= 0 && nd < bestD) {
        bestD = nd;
        best = { x: nx, y: ny };
      }
    }
    if (best) {
      e.x = best.x;
      e.y = best.y;
    }
  }

  enemyAttack(e, ranged) {
    if (this.player.invuln > 0) {
      this.addLog(`${e.name}的攻击被护盾挡下了。`);
      return;
    }
    const raw = e.atk * (0.9 + this.rng.float() * 0.2);
    const dmg = Math.max(1, Math.round(raw - this.player.def * 0.5));
    this.player.hp -= dmg;
    this.addLog(`${e.name}${ranged ? '射出暗影弹' : '攻击'}，你受到 ${dmg} 伤害。`);
    this.emit({ type: 'playerHit', dmg, ranged, from: e.type, x: this.player.x, y: this.player.y });
    if (this.player.hp <= 0) this.handleDeath();
  }

  handleDeath() {
    if (this.player.revive > 0) {
      this.player.revive--;
      this.player.hp = Math.ceil(this.player.maxHp * 0.5);
      this.player.invuln = 3;
      this.addLog('生命护符碎裂，你重新站了起来！（3 回合无敌）');
      this.emit({ type: 'revive', x: this.player.x, y: this.player.y });
      return;
    }
    this.player.hp = 0;
    this.screen = 'dead';
    this.emit({ type: 'dead' });
    this.deathInfo = {
      floor: this.depth,
      kills: this.runStats.kills,
      gold: this.runStats.gold,
      crystals: this.runStats.crystals,
    };
    this.meta.best.floor = Math.max(this.meta.best.floor || 0, this.depth);
    this.meta.best.kills = Math.max(this.meta.best.kills || 0, this.runStats.kills);
    this.persist();
  }

  win() {
    const bonus = 30;
    this.meta.crystals += bonus;
    this.runStats.crystals += bonus;
    this.meta.wins = (this.meta.wins || 0) + 1;
    this.screen = 'won';
    this.emit({ type: 'win' });
    this.winInfo = {
      floor: this.depth,
      kills: this.runStats.kills,
      gold: this.runStats.gold,
      crystals: this.runStats.crystals,
      bonus,
    };
    this.meta.best.floor = MAX_FLOOR;
    this.meta.best.kills = Math.max(this.meta.best.kills || 0, this.runStats.kills);
    this.persist();
  }

  /* ---------------- 局外养成 ---------------- */

  upgradeMeta(stat) {
    if (stat !== 'hp' && stat !== 'atk') return this.getState();
    const lvl = this.meta.upgrades[stat] || 0;
    if (lvl >= META_MAX) return this.getState();
    const cost = META_COST[lvl];
    if (this.meta.crystals < cost) return this.getState();
    this.meta.crystals -= cost;
    this.meta.upgrades[stat] = lvl + 1;
    this.persist();
    return this.getState();
  }

  /* ---------------- 调试 ---------------- */

  debugGoto(depth) {
    if (this.screen !== 'playing') return this.getState();
    const d = Math.max(1, Math.min(MAX_FLOOR, Number(depth) || 1));
    this.enterFloor(d);
    return this.getState();
  }

  /* ---------------- 序列化 ---------------- */

  getState() {
    const state = {
      screen: this.screen,
      depth: this.depth,
      maxFloor: MAX_FLOOR,
      turn: this.turn,
      meta: this.meta,
      metaCost: META_COST,
      metaMax: META_MAX,
      log: this.log.slice(-8),
      pending: this.pending,
      mapW: this.mapW,
      mapH: this.mapH,
      stairs: this.stairs,
      deathInfo: this.deathInfo || null,
      winInfo: this.winInfo || null,
      lastItem: null,
      events: this.drainEvents(),
    };

    if (this.tiles) {
      state.tiles = this.tiles.join('');
      state.visible = Array.from(this.visible).join('');
      state.explored = Array.from(this.explored).join('');
    }

    if (this.player) {
      const p = this.player;
      state.player = {
        x: p.x,
        y: p.y,
        hp: Math.max(0, p.hp),
        maxHp: p.maxHp,
        atk: p.atk,
        def: p.def,
        speed: p.speed,
        crit: p.crit,
        critDmg: p.critDmg,
        ls: p.ls,
        rangeBonus: p.rangeBonus,
        level: p.level,
        xp: p.xp,
        xpNext: p.xpNext,
        gold: p.gold,
        potion: p.potion,
        potionCap: POTION_CAP,
        revive: p.revive,
        weapon: p.weapon,
        regen: p.regen,
        invuln: p.invuln,
      };
    }

    if (this.enemies) {
      state.enemies = this.enemies
        .filter((e) => e.hp > 0)
        .map((e) => ({
          id: e.id,
          x: e.x,
          y: e.y,
          type: e.type,
          name: e.name,
          hp: e.hp,
          maxHp: e.maxHp,
          boss: e.boss,
          flash: e.hitFlash > 0,
        }));
      this.enemies.forEach((e) => { if (e.hitFlash > 0) e.hitFlash--; });
    }

    if (this.items) {
      state.items = this.items.map((it) => ({ id: it.id, x: it.x, y: it.y, kind: it.kind }));
    }

    return state;
  }
}

module.exports = { Game, WEAPONS, ENEMY_BASE, MAX_FLOOR, META_COST, META_MAX };
