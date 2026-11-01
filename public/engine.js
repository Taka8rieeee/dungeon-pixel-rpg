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

  /**
   * 五把武器各有独立的战斗机制（trait），不是单纯改数值：
   *   combo    连击积攒，攒满后下一击爆发
   *   lunge    出手时向前突进
   *   pierce   箭矢能穿透
   *   knockback 击退并减速
   *   frenzy   连续命中越打越快
   */
  const WEAPONS = {
    starter: {
      id: 'starter',
      name: '旧木棒',
      kind: 'melee',
      mult: 0.7,
      cd: 0.45,
      reach: 20,
      arc: 1.0,
      trait: null,
      desc: '开局凑合用的破木棒，趁早换掉',
    },
    sword: {
      id: 'sword',
      name: '铁剑',
      kind: 'melee',
      mult: 1.0,
      cd: 0.3,
      reach: 24,
      arc: 1.7,
      trait: 'combo',
      desc: '均衡挥砍，连中三次后下一击爆发',
    },
    spear: {
      id: 'spear',
      name: '长矛',
      kind: 'melee',
      mult: 0.95,
      cd: 0.42,
      reach: 46,
      arc: 0.5,
      trait: 'lunge',
      lunge: 16,
      desc: '突刺时向前冲一小段，够得着远处',
    },
    bow: {
      id: 'bow',
      name: '短弓',
      kind: 'ranged',
      mult: 0.85,
      cd: 0.36,
      speed: 360,
      life: 0.85,
      pierce: 1,
      desc: '远程箭矢，能穿过一个敌人',
    },
    hammer: {
      id: 'hammer',
      name: '战锤',
      kind: 'melee',
      mult: 1.7,
      cd: 0.75,
      reach: 30,
      arc: 1.4,
      trait: 'knockback',
      knock: 22,
      slow: 1.4,
      desc: '慢速重击，击退并减速命中的敌人',
    },
    dagger: {
      id: 'dagger',
      name: '匕首',
      kind: 'melee',
      mult: 0.55,
      cd: 0.16,
      reach: 18,
      arc: 1.2,
      trait: 'frenzy',
      desc: '极快，连续命中会越打越快',
    },
  };

  /** 武器栏只有两格；开局只有一根破木棒，好武器得进去抢 */
  const WEAPON_SLOTS = 2;

  /** 宝箱里除了新武器，还能换到的增益 */
  const BUFFS = [
    { id: 'atk', name: '磨刀石', desc: '攻击力 +2', apply: (p) => { p.atk += 2; } },
    { id: 'vit', name: '护心镜', desc: '生命上限 +12，并立刻回复 12', apply: (p) => { p.maxHp += 12; p.hp += 12; } },
    { id: 'crit', name: '锋锐符文', desc: '暴击率 +8%', apply: (p) => { p.crit += 0.08; } },
    { id: 'swift', name: '轻身靴', desc: '移动速度 +8%', apply: (p) => { p.speed *= 1.08; } },
    { id: 'leech', name: '吸血之牙', desc: '吸血 +4%', apply: (p) => { p.ls += 0.04; } },
  ];

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
      this.pendingKind = '';
      this.pendingLevels = 0;
      this.t = 0;
      this.depth = 1;
      this.fovTimer = 0;
      this.flow = null;
      this.flowTimer = 0;
      this.calmTimer = 0;
      this.nextId = 1;
    }

    /* ---------------- 生命周期 ---------------- */

    startRun(seed) {
      // 传入 seed 可复现（测试用）；不传则每局随机
      this.rng = new RNG(seed !== undefined ? seed : (Date.now() ^ (Math.random() * 1e9)) >>> 0);
      this.meta.runs = (this.meta.runs || 0) + 1;
      this.screen = 'playing';
      this.paused = false;
      this.pending = null;
      this.pendingKind = '';
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
        weapons: ['starter'],
        weaponIndex: 0,
        weapon: WEAPONS.starter,
        combo: 0,
        frenzy: 0,
        frenzyTimer: 0,
        aim: 0,
        cd: 0,
        invuln: 0,
        hitFlash: 0,
        moving: false,
        regenPool: 0,
      };
      this.player.hp = this.player.maxHp;

      this.enterFloor(1);
      this.addLog('你只摸到一根旧木棒，往里走吧。');
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
      this.flow = null;
      this.flowTimer = 0;
      // 刚进新层给玩家一点喘息时间，避免落地即被围
      this.calmTimer = 2;

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

      // 可放置点：离出生点足够远，且必须和玩家处在同一连通区域。
      // 隐藏房只通过裂墙相连，BFS 到不了，敌人若生在里面会永远出不来。
      const reach = MapGen.bfsFrom(this.tiles, f.start.x, f.start.y).dist;
      const free = [];
      for (let y = 1; y < this.mapH - 1; y++) {
        for (let x = 1; x < this.mapW - 1; x++) {
          const i = y * this.mapW + x;
          if (this.tiles[i] !== MapGen.FLOOR) continue;
          if (reach[i] < 0) continue;
          if (x === f.start.x && y === f.start.y) continue;
          // 出生点周围留出安全区（8 格 ≈ 一个视野半径），开局不会一睁眼就被围
          if (dist2(x, y, f.start.x, f.start.y) < 64) continue;
          free.push({ x, y });
        }
      }
      const spots = this.rng.shuffle(free);

      const used = [];
      /** 取一个与已用点至少隔开 minGap 格的位置，敌人与掉落物都靠它分配 */
      const takeSpot = (minGap) => {
        for (let i = 0; i < spots.length; i++) {
          const s = spots[i];
          if (!s) continue;
          let ok = true;
          for (const u of used) {
            if (dist2(s.x, s.y, u.x, u.y) < minGap * minGap) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
          used.push(s);
          spots[i] = null;
          return s;
        }
        return null;
      };
      const at = (s) => ({ x: (s.x + 0.5) * TILE, y: (s.y + 0.5) * TILE });

      // 敌人：数量随层数上升，但彼此至少隔开 3 格，不会在一片空场里堆成一团
      const pool =
        depth <= 1
          ? ['slime', 'rat', 'rat', 'slime']
          : depth <= 2
            ? ['slime', 'rat', 'archer', 'slime', 'rat']
            : depth <= 4
              ? ['slime', 'rat', 'archer', 'brute', 'rat']
              : ['brute', 'archer', 'slime', 'brute'];
      const count = Math.min(22, 7 + depth * 3);
      for (let i = 0; i < count; i++) {
        const s = takeSpot(3);
        if (!s) break;
        const type = pool[Math.floor(this.rng.float() * pool.length)];
        const pos = at(s);
        this.spawnEnemy(type, pos.x, pos.y);
      }

      // 层主 / 最终 Boss 守在楼梯旁（先找一个真正站得下的位置，别塞进墙里）
      const bossType = depth === MAX_FLOOR ? 'overlord' : 'master';
      const sx = (f.stairs.x + 0.5) * TILE;
      const sy = (f.stairs.y + 0.5) * TILE;
      // 站在楼梯旁边而不是楼梯格上，并和其他怪保持距离
      const bossBody = Math.min(ENEMY_TYPES[bossType].r, 4);
      const bossSpot = this.findFreeSpot(sx, sy, 4, bossBody, true, this.enemies);
      const boss = this.spawnEnemy(bossType, bossSpot.x, bossSpot.y);
      // 层主不主动出击：守着楼梯，玩家靠近才应战，走远了就回原位
      boss.guard = true;
      boss.awake = false;

      // 物品：和敌人共用同一套取点逻辑，不会叠在一起
      const dropItem = (kind, amount) => {
        const s = takeSpot(2);
        if (!s) return;
        const pos = at(s);
        this.items.push({ id: this.nextId++, x: pos.x, y: pos.y, kind, amount });
      };
      const goldPiles = 5 + depth;
      for (let i = 0; i < goldPiles; i++) dropItem('gold', this.rng.int(4, 9) + depth * 2);
      dropItem('potion');
      dropItem('potion');
      dropItem('chest');
      if (this.rng.chance(depth >= 3 ? 0.16 : 0.08)) dropItem('revive');

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
    findFreeSpot(cx, cy, maxR, r, skipOrigin, avoid) {
      const usable = (x, y) => {
        if (this.blocked(x, y, r, r)) return false;
        if (avoid) {
          for (const o of avoid) {
            if (dist2(x, y, o.x, o.y) < (2 * TILE) * (2 * TILE)) return false;
          }
        }
        return true;
      };
      if (!skipOrigin && usable(cx, cy)) return { x: cx, y: cy };
      for (let ring = 1; ring <= maxR; ring++) {
        for (let dy = -ring; dy <= ring; dy++) {
          for (let dx = -ring; dx <= ring; dx++) {
            if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
            const x = cx + dx * TILE;
            const y = cy + dy * TILE;
            if (usable(x, y)) return { x, y };
          }
        }
      }
      return { x: cx, y: cy };
    }

    spawnEnemy(type, x, y) {
      const base = ENEMY_TYPES[type];
      const depth = this.depth;
      // 物理碰撞盒必须明显小于一格（16px），否则在走廊拐角处两个轴会同时被判为撞墙
      const bodyR = Math.min(base.r, 4);
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
        homeX: x,
        homeY: y,
        guard: false,
        lostTimer: 0,
        dirX: 0,
        dirY: 0,
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
      if (this.calmTimer > 0) this.calmTimer = Math.max(0, this.calmTimer - dt);

      this.updatePlayer(dt, input);

      this.flowTimer -= dt;
      if (this.flowTimer <= 0) {
        this.updateFlow();
        this.flowTimer = 0.22;
      }

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

      // 匕首的狂热脱手就衰减
      if (p.frenzyTimer > 0) {
        p.frenzyTimer -= dt;
        if (p.frenzyTimer <= 0) p.frenzy = 0;
      }

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
      // 匕首的狂热：命中越多出手越快
      const frenzyScale = w.trait === 'frenzy' ? 1 / (1 + p.frenzy) : 1;
      p.cd = w.cd * p.cdScale * frenzyScale;
      this.emit({ type: 'swing', weapon: w.id });

      let mult = w.mult;

      // 铁剑：攒满三次命中后，第四击爆发
      if (w.trait === 'combo' && p.combo >= 3) {
        mult *= 1.8;
        p.combo = 0;
        this.emit({ type: 'combo', x: p.x, y: p.y });
      }

      // 长矛：出手瞬间向前突进，够到更远的目标
      if (w.trait === 'lunge') {
        this.moveBody(p, Math.cos(p.aim) * w.lunge, Math.sin(p.aim) * w.lunge);
      }

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
          this.damageEnemy(e, mult, w);
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
          weapon: w.id,
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
          mult,
          from: 'player',
          r: 3,
          pierce: w.pierce || 0,
          hitIds: [],
          weapon: w,
        });
      }
    }

    /** 切换已拥有的武器 */
    switchWeapon(index) {
      const p = this.player;
      const i = Number(index);
      if (!Number.isInteger(i) || i < 0 || i >= p.weapons.length) return false;
      if (i === p.weaponIndex) return false;
      p.weaponIndex = i;
      p.weapon = WEAPONS[p.weapons[i]];
      p.combo = 0;
      p.frenzy = 0;
      p.frenzyTimer = 0;
      p.cd = Math.max(p.cd, 0.12); // 切枪有一点点硬直
      this.emit({ type: 'swap', weapon: p.weapon.id });
      return true;
    }

    /** 滚轮循环切换 */
    cycleWeapon(step) {
      const p = this.player;
      if (p.weapons.length < 2) return false;
      const n = p.weapons.length;
      const next = (p.weaponIndex + (step > 0 ? 1 : -1) + n) % n;
      return this.switchWeapon(next);
    }

    /**
     * 获得武器时按栏位规则处理：
     *   1. 手上只有旧木棒 → 直接换掉（木棒不占正式栏位）
     *   2. 还有空位 → 放入空位
     *   3. 两格都满 → 顶掉当前手持的那把，旧武器掉在地上，随时能捡回来
     */
    gainWeapon(id) {
      const p = this.player;
      const w = WEAPONS[id];
      if (!w || id === 'starter' || p.weapons.includes(id)) return false;

      if (p.weapons.length === 1 && p.weapons[0] === 'starter') {
        p.weapons = [id];
        p.weaponIndex = 0;
        p.weapon = w;
        p.cd = 0;
        this.addLog(`换下旧木棒，拿起「${w.name}」！`);
        this.emit({ type: 'swap', weapon: id });
        return true;
      }

      if (p.weapons.length < WEAPON_SLOTS) {
        p.weapons.push(id);
        this.switchWeapon(p.weapons.length - 1);
        this.addLog(`获得武器「${w.name}」。`);
        return true;
      }

      const dropIdx = Math.min(p.weaponIndex, p.weapons.length - 1);
      const dropId = p.weapons[dropIdx];
      p.weapons[dropIdx] = id;
      p.weapon = w;
      p.combo = 0;
      p.frenzy = 0;
      p.frenzyTimer = 0;
      p.cd = 0.2;
      this.dropWeapon(dropId, p.x, p.y);
      this.addLog(`丢下「${WEAPONS[dropId].name}」，换上「${w.name}」。`);
      this.emit({ type: 'swap', weapon: id });
      return true;
    }

    /** 把武器扔在地上（按 E 可以再捡回来） */
    dropWeapon(id, x, y) {
      if (!WEAPONS[id] || id === 'starter') return;
      const spot = this.findFreeSpot(x, y, 2, 2);
      this.items.push({ id: this.nextId++, x: spot.x, y: spot.y, kind: 'weapon', weaponId: id });
    }

    /** 捡起脚边掉落的武器 */
    pickupWeaponNearby() {
      const p = this.player;
      let best = null;
      let bestD = 30 * 30;
      for (const it of this.items) {
        if (it.kind !== 'weapon') continue;
        const d2 = dist2(it.x, it.y, p.x, p.y);
        if (d2 < bestD) {
          bestD = d2;
          best = it;
        }
      }
      if (!best) return false;
      this.takeGroundWeapon(best);
      return true;
    }

    takeGroundWeapon(item) {
      const p = this.player;
      const id = item.weaponId;
      const w = WEAPONS[id];
      if (!w) return;
      this.items = this.items.filter((it) => it.id !== item.id);

      if (p.weapons.includes(id)) {
        this.switchWeapon(p.weapons.indexOf(id));
        this.addLog(`重新拿起「${w.name}」。`);
        return;
      }

      const idx = Math.min(p.weaponIndex, p.weapons.length - 1);
      const dropId = p.weapons[idx];
      p.weapons[idx] = id;
      p.weaponIndex = idx;
      p.weapon = w;
      p.combo = 0;
      p.frenzy = 0;
      p.frenzyTimer = 0;
      p.cd = 0.2;

      // 换下来的那把留在原地；旧木棒不落地
      if (dropId !== 'starter') {
        this.items.push({ id: this.nextId++, x: item.x, y: item.y, kind: 'weapon', weaponId: dropId });
        this.addLog(`拾起「${w.name}」，放下「${WEAPONS[dropId].name}」。`);
      } else {
        this.addLog(`拾起「${w.name}」。`);
      }
      this.emit({ type: 'swap', weapon: id });
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

    damageEnemy(e, mult, weapon) {
      const p = this.player;
      const w = weapon || p.weapon;
      const crit = this.rng.chance(p.crit);
      const total = mult * (crit ? 1.5 + p.critDmg : 1);
      const dmg = Math.max(1, Math.round(p.atk * total - e.def * 0.5));
      e.hp -= dmg;
      e.flash = 0.14;
      e.awake = true;

      // 铁剑：命中累积连击层数
      if (w.trait === 'combo') p.combo = Math.min(3, (p.combo || 0) + 1);

      // 匕首：命中累积狂热，最多把攻速提到 2 倍出头
      if (w.trait === 'frenzy') {
        p.frenzy = Math.min(1.2, (p.frenzy || 0) + 0.1);
        p.frenzyTimer = 2;
      }

      // 战锤：把目标砸退并减速
      if (w.trait === 'knockback') {
        const ang = Math.atan2(e.y - p.y, e.x - p.x);
        this.moveBody(e, Math.cos(ang) * (w.knock || 20), Math.sin(ang) * (w.knock || 20));
        e.slowTimer = w.slow || 1.2;
      }

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
      this.pending = picks.map((u) => ({ kind: 'upgrade', id: u.id, name: u.name, desc: u.desc }));
      this.pendingKind = 'levelup';
      this.paused = true;
    }

    resolveChoice(index) {
      if (!this.pending) return;
      const pick = this.pending[index];
      if (!pick) return;
      const p = this.player;

      if (pick.kind === 'weapon') {
        this.gainWeapon(pick.id);
        this.emit({ type: 'upgrade', id: pick.id });
      } else if (pick.kind === 'buff') {
        const buff = BUFFS.find((b) => b.id === pick.id);
        if (buff) buff.apply(p);
        this.addLog(`获得「${pick.name}」：${pick.desc}`);
        this.emit({ type: 'upgrade', id: pick.id });
      } else {
        const up = UPGRADE_POOL.find((u) => u.id === pick.id);
        if (up) up.apply(p);
        this.addLog(`选择强化：${up.name} —— ${up.desc}`);
        this.emit({ type: 'upgrade', id: pick.id });
        this.pendingLevels--;
      }

      this.pending = null;
      const wasStarter = this.pendingKind === 'starter';
      this.pendingKind = '';

      if (!wasStarter && this.pendingLevels > 0) {
        this.rollChoices();
      } else {
        this.paused = false;
      }
    }

    /* ---------------- 敌人 ---------------- */

    /**
     * 从玩家所在格做一次 BFS，得到整层的「离玩家步数」距离场。
     * 敌人不在视线内时沿这个场下坡走，就能自动绕过拐角和墙，而不是贴着墙原地顶。
     */
    updateFlow() {
      const W = this.mapW;
      const H = this.mapH;
      const dist = new Int16Array(W * H).fill(-1);
      const pt = this.playerTile();
      if (pt.x < 0 || pt.y < 0 || pt.x >= W || pt.y >= H) {
        this.flow = dist;
        return;
      }
      const start = pt.y * W + pt.x;
      dist[start] = 0;
      const queue = [start];
      for (let head = 0; head < queue.length; head++) {
        const i = queue[head];
        const x = i % W;
        const y = (i - x) / W;
        for (const [dx, dy] of MapGen.DIRS) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (dist[j] !== -1 || this.isSolidTile(nx, ny)) continue;
          dist[j] = dist[i] + 1;
          queue.push(j);
        }
      }
      this.flow = dist;
    }

    /** 沿距离场往玩家方向下坡，返回单位方向向量 */
    flowDir(e) {
      const W = this.mapW;
      const tx = Math.floor(e.x / TILE);
      const ty = Math.floor(e.y / TILE);
      const fallback = () => {
        const dx = this.player.x - e.x;
        const dy = this.player.y - e.y;
        const d = Math.hypot(dx, dy) || 1;
        return { x: dx / d, y: dy / d };
      };
      if (!this.flow || tx < 0 || ty < 0 || tx >= W || ty >= this.mapH) return fallback();
      const cur = this.flow[ty * W + tx];
      if (cur < 0) return fallback();

      let bestX = -1;
      let bestY = -1;
      let bestD = cur;
      for (const [dx, dy] of MapGen.DIRS) {
        const nx = tx + dx;
        const ny = ty + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= this.mapH) continue;
        const v = this.flow[ny * W + nx];
        if (v < 0 || v >= bestD) continue;
        bestD = v;
        bestX = nx;
        bestY = ny;
      }
      if (bestX < 0) return fallback();

      const cx = (bestX + 0.5) * TILE;
      const cy = (bestY + 0.5) * TILE;
      const dx = cx - e.x;
      const dy = cy - e.y;
      const d = Math.hypot(dx, dy) || 1;
      return { x: dx / d, y: dy / d };
    }

    updateEnemies(dt) {
      const p = this.player;
      const alive = [];
      for (const e of this.enemies) {
        if (!e.dead) alive.push(e);
      }
      if (!alive.length) return;

      // 阶段一：决定每个敌人「想往哪走」
      for (const e of alive) {
        if (e.flash > 0) e.flash -= dt;
        if (e.cd > 0) e.cd -= dt;
        if (e.slowTimer > 0) e.slowTimer -= dt;

        const dx = p.x - e.x;
        const dy = p.y - e.y;
        const d = Math.hypot(dx, dy) || 1;

        // 索敌三层收敛：
        //   1. 进新层的前 2 秒是缓冲期，只有贴身的怪会动
        //   2. 远处的怪必须真的「看得见」玩家才会醒，隔墙不追
        //   3. 平时上限 200px，跟丢后重新睡下
        if (!e.awake) {
          const calm = this.calmTimer > 0;
          const notice = e.guard ? 165 : calm ? 95 : 200;
          const canSense = d < 110 || this.hasLine(e.x, e.y, p.x, p.y);
          if (d < notice && canSense) {
            e.awake = true;
          } else {
            e.dirX = 0;
            e.dirY = 0;
            continue;
          }
        } else if (!e.guard && d > 330) {
          // 跟丢了就重新睡下，别让它穿越大半个地图来追
          e.lostTimer += dt;
          if (e.lostTimer > 3.5) {
            e.awake = false;
            e.lostTimer = 0;
            e.dirX = 0;
            e.dirY = 0;
            continue;
          }
        } else {
          e.lostTimer = 0;
        }

        // 守楼梯的层主：只在「玩家也不在身边」时才回防，
        // 否则会当着玩家的面掉头往回走，看起来就像卡住了
        if (e.guard) {
          const homeDist = Math.hypot(e.x - e.homeX, e.y - e.homeY);
          if (homeDist > 96 && d > 260) {
            const bx = e.homeX - e.x;
            const by = e.homeY - e.y;
            const bl = Math.hypot(bx, by) || 1;
            e.dirX = bx / bl;
            e.dirY = by / bl;
            continue;
          }
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
        const clear = this.hasLine(e.x, e.y, p.x, p.y);

        if (e.ranged) {
          if (!clear && d > 90) {
            // 看不见玩家就先绕路，走到能射的位置
            const s = this.flowDir(e);
            e.dirX = s.x;
            e.dirY = s.y;
          } else if (d < e.prefer - 25) {
            e.dirX = -ux;
            e.dirY = -uy;
          } else if (d > e.prefer + 35) {
            e.dirX = ux;
            e.dirY = uy;
          } else {
            e.dirX = 0;
            e.dirY = 0;
          }
          if (d < 300 && e.cd <= 0 && clear) {
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
            // 一律走流场。直线只看几何不看碰撞盒宽度，贴着墙角时会出现
            // 「看得见玩家但擦不过去」的死角，沿着格子级路径走才稳。
            const s = this.flowDir(e);
            e.dirX = s.x;
            e.dirY = s.y;
          } else {
            e.dirX = 0;
            e.dirY = 0;
            if (e.cd <= 0) {
              e.cd = e.attackCd;
              this.hurtPlayer(e.atk, e);
            }
          }
        }
      }

      // 阶段二：按各自方向移动。分离不参与方向计算，保证前进永远不被同伴阻断。
      for (const e of alive) {
        let dx = e.dirX;
        let dy = e.dirY;

        // 卡住检测：醒来却原地不动时，侧向绕一步打破僵局（墙角、同伴堵门、流场抖动）
        const px = e.px === undefined ? e.x : e.px;
        const py = e.py === undefined ? e.y : e.py;
        const moved = Math.hypot(e.x - px, e.y - py);
        if (moved < 0.2 && (dx || dy)) {
          e.stuck = (e.stuck || 0) + dt;
        } else {
          e.stuck = 0;
          e.side = 0;
        }
        e.px = e.x;
        e.py = e.y;

        if (e.stuck > 0.8 && (dx || dy)) {
          // 卡住了：以期望方向为基准向两侧扫描，找第一个真的走得通的方向。
          // 单纯左右偏移在拐角处往往也是墙，必须实际探测。
          if (!e.side) e.side = this.rng.chance(0.5) ? 1 : -1;
          const base = Math.atan2(dy, dx);
          let found = null;
          for (let k = 1; k <= 2 && !found; k++) {
            for (let s = 0; s < 2 && !found; s++) {
              const a = base + (s === 0 ? 1 : -1) * e.side * k * (Math.PI / 4);
              const nx = Math.cos(a);
              const ny = Math.sin(a);
              if (!this.blocked(e.x + nx * 4, e.y + ny * 4, e.hw, e.hh)) found = { x: nx, y: ny };
            }
          }
          if (found) {
            dx = found.x;
            dy = found.y;
          }
        }

        const len = Math.hypot(dx, dy);
        if (len < 0.001) continue;
        const spd = e.slowTimer > 0 ? e.speed * 0.45 : e.speed;
        this.moveBody(e, (dx / len) * spd * dt, (dy / len) * spd * dt);
      }

      // 阶段三：移动之后再轻推重叠的同伴。推得开就分开，推不开也不影响已经走完的路。
      for (let i = 0; i < alive.length; i++) {
        const a = alive[i];
        for (let j = i + 1; j < alive.length; j++) {
          const b = alive[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const min = a.r + b.r;
          const d2 = dx * dx + dy * dy;
          if (d2 > min * min) continue;
          const d = Math.sqrt(d2);
          let nx;
          let ny;
          if (d < 0.001) {
            // 完全重合时没有方向可言，随机挑一个方向弹开
            const ang = this.rng.float() * Math.PI * 2;
            nx = Math.cos(ang);
            ny = Math.sin(ang);
          } else {
            nx = dx / d;
            ny = dy / d;
          }
          const push = (min - d) * 0.4;
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
              if (pr.hitIds && pr.hitIds.indexOf(e.id) !== -1) continue;
              if (dist2(pr.x, pr.y, e.x, e.y) < (e.r + pr.r) * (e.r + pr.r)) {
                hit = e;
                break;
              }
            }
            if (hit) {
              this.damageEnemy(hit, pr.mult, pr.weapon);
              if (pr.pierce > 0) {
                // 穿透箭：继续飞，但不再打同一个目标
                pr.pierce--;
                if (!pr.hitIds) pr.hitIds = [];
                pr.hitIds.push(hit.id);
              } else {
                consumed = true;
              }
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
        // 掉在地上的武器要按 E 主动捡，不自动拾取，避免来回换
        if (it.kind === 'weapon') {
          keep.push(it);
          continue;
        }
        if (dist2(it.x, it.y, p.x, p.y) >= 13 * 13) {
          keep.push(it);
          continue;
        }
        // 拾取失败（比如药水已满）就留在原地。绝不能在这里改 this.items：
        // 正在遍历的数组被 push 会让迭代器原地打转，数组无限增长到 Invalid array length
        if (!this.pickup(it)) keep.push(it);
      }
      this.items = keep;
    }

    pickup(item) {
      const p = this.player;
      if (item.kind === 'gold') {
        p.gold += item.amount;
        this.runStats.gold += item.amount;
        this.emit({ type: 'pickup', kind: 'gold', amount: item.amount, x: item.x, y: item.y });
        return true;
      }
      if (item.kind === 'potion') {
        if (p.potion >= POTION_CAP) return false;
        p.potion++;
        this.emit({ type: 'pickup', kind: 'potion', x: item.x, y: item.y });
        return true;
      }
      if (item.kind === 'revive') {
        if (p.revive > 0) {
          p.gold += 20;
          this.emit({ type: 'pickup', kind: 'gold', amount: 20, x: item.x, y: item.y });
        } else {
          p.revive = 1;
          this.emit({ type: 'pickup', kind: 'revive', x: item.x, y: item.y });
          this.addLog('获得「生命护符」：死亡时自动复活一次！');
        }
        return true;
      }
      if (item.kind === 'chest') {
        this.openChest(item);
        return true;
      }
      return true;
    }

    /** 宝箱：暂停游戏，从武器池和增益池里随机刷出最多三个选项 */
    openChest(item) {
      const p = this.player;
      // 旧木棒是开局垃圾，永远不该出现在宝箱选项里
      const freshWeapons = this.rng.shuffle(
        Object.keys(WEAPONS).filter((id) => id !== 'starter' && !p.weapons.includes(id)),
      );
      const buffPool = this.rng.shuffle(BUFFS.slice());

      // 每次开箱随机决定这一箱有几个武器、几个增益：
      //   20% 纯增益 / 42% 一武器 / 28% 两武器 / 10% 纯武器
      const roll = this.rng.float();
      let wantWeapons = roll < 0.2 ? 0 : roll < 0.62 ? 1 : roll < 0.9 ? 2 : 3;
      wantWeapons = Math.min(wantWeapons, freshWeapons.length);

      const full = p.weapons.length >= WEAPON_SLOTS;
      const rawStick = p.weapons.length === 1 && p.weapons[0] === 'starter';
      let note = '';
      if (full) note = `（顶替手上的${p.weapon.name}，旧武器会掉在地上）`;
      else if (rawStick) note = '（换掉旧木棒）';

      const options = [];
      let wi = 0;
      let bi = 0;

      for (; wi < wantWeapons; wi++) {
        const id = freshWeapons[wi];
        options.push({ kind: 'weapon', id, name: WEAPONS[id].name, desc: WEAPONS[id].desc + note });
      }
      // 剩余名额先用增益补满
      while (options.length < 3 && bi < buffPool.length) {
        const b = buffPool[bi++];
        options.push({ kind: 'buff', id: b.id, name: b.name, desc: b.desc });
      }
      // 增益不够（理论上不会）就用剩下的武器继续补
      while (options.length < 3 && wi < freshWeapons.length) {
        const id = freshWeapons[wi++];
        options.push({ kind: 'weapon', id, name: WEAPONS[id].name, desc: WEAPONS[id].desc + note });
      }

      this.pending = options;
      this.pendingKind = 'chest';
      this.paused = true;
      this.addLog('宝箱打开了，挑一样带走。');
      this.emit({ type: 'pickup', kind: 'chest', weapon: null, x: item.x, y: item.y });
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

  return {
    World,
    TILE,
    MAX_FLOOR,
    WEAPONS,
    WEAPON_SLOTS,
    BUFFS,
    ENEMY_TYPES,
    META_COST,
    META_MAX,
    POTION_CAP,
  };
});
