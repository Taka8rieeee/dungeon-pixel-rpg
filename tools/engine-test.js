'use strict';

/**
 * 实时引擎测试：直接在 Node 里驱动 public/engine.js，不启动服务器。
 * engine.js 是 UMD，但它依赖 RNG / MapGen / FOV 三个全局，先注入再 require。
 */

global.RNG = require('../src/rng').RNG;
global.MapGen = require('../src/mapgen');
global.FOV = require('../src/fov');

const assert = require('assert');
const Engine = require('../public/engine.js');

const TILE = Engine.TILE;

function freshMeta() {
  return { crystals: 0, upgrades: { hp: 0, atk: 0 }, best: { floor: 0, kills: 0 }, runs: 0, wins: 0 };
}

function idle(over) {
  return Object.assign(
    { up: false, down: false, left: false, right: false, firing: false, aimX: 0, aimY: 0 },
    over || {},
  );
}

/** 把玩家周围 5x5 格清成地板，避免测试被墙挡住 */
function clearAround(w, radius = 2) {
  const pt = w.playerTile();
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const tx = pt.x + dx;
      const ty = pt.y + dy;
      if (tx < 1 || ty < 1 || tx >= w.mapW - 1 || ty >= w.mapH - 1) continue;
      w.tiles[ty * w.mapW + tx] = MapGen.FLOOR;
    }
  }
}

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(['✔', name]);
  } catch (err) {
    results.push(['✘', name + ' — ' + err.message]);
  }
}

function newWorld(seed) {
  const w = new Engine.World(freshMeta(), seed || 20261101);
  w.startRun(seed || 20261101);
  // 跳过开局的武器三选一，否则游戏处于暂停态，tick 不会推进
  if (w.pending) w.resolveChoice(0);
  return w;
}

test('开局状态正常', () => {
  const w = newWorld();
  assert.strictEqual(w.screen, 'playing');
  assert.strictEqual(w.depth, 1);
  assert.strictEqual(w.player.hp, w.player.maxHp);
  assert.ok(w.player.x > 0 && w.player.y > 0, '玩家应有像素坐标');
  assert.ok(w.enemies.length >= 8, `第 1 层敌人应 >= 8，实际 ${w.enemies.length}`);
  assert.strictEqual(w.stairs.locked, true);
  assert.ok(w.tiles.length === w.mapW * w.mapH);
});

test('玩家出生点不在墙里', () => {
  const w = newWorld(777);
  const p = w.player;
  assert.ok(!w.blocked(p.x, p.y, p.hw, p.hh), '出生点被墙卡住');
});

test('按方向键会移动，且不会穿墙', () => {
  const w = newWorld(88);
  clearAround(w);
  const p = w.player;
  const x0 = p.x;
  const y0 = p.y;
  for (let i = 0; i < 10; i++) {
    w.tick(0.03, idle({ right: true }));
    assert.ok(!w.blocked(p.x, p.y, p.hw, p.hh), '移动后卡进墙里');
  }
  assert.ok(p.x > x0, `向右应位移，实际 ${x0} -> ${p.x}`);
  assert.strictEqual(p.y, y0, '横向移动不应改变 y');
});

test('撞墙时停在墙前而不是穿过去', () => {
  const w = newWorld(99);
  clearAround(w);
  const p = w.player;
  const pt = w.playerTile();
  // 右边一格砌成墙，并把玩家挪到格子左侧，留出可走的距离
  w.tiles[pt.y * w.mapW + (pt.x + 1)] = MapGen.WALL;
  p.x = pt.x * TILE + 2;
  const x0 = p.x;
  for (let i = 0; i < 40; i++) w.tick(0.03, idle({ right: true }));
  const wallLeft = (pt.x + 1) * TILE;
  assert.ok(p.x + p.hw <= wallLeft + 0.01, `穿墙了：${p.x + p.hw} > ${wallLeft}`);
  assert.ok(p.x > x0, `应该先走到墙边，实际 ${x0} -> ${p.x}`);
});

test('鼠标方向攻击能命中敌人', () => {
  const w = newWorld(1234);
  clearAround(w, 3);
  const p = w.player;
  const e = w.enemies.find((x) => !x.boss);
  e.x = p.x + 20;
  e.y = p.y;
  e.awake = true;
  const hp0 = e.hp;
  w.tick(0.02, idle({ firing: true, aimX: e.x, aimY: e.y }));
  assert.ok(e.hp < hp0, `敌人应掉血，实际 ${hp0} -> ${e.hp}`);
  assert.ok(p.cd > 0, '攻击后应进入冷却');
});

test('背对敌人不会命中', () => {
  const w = newWorld(4321);
  clearAround(w, 3);
  const p = w.player;
  const e = w.enemies.find((x) => !x.boss);
  e.x = p.x + 20;
  e.y = p.y;
  const hp0 = e.hp;
  w.tick(0.02, idle({ firing: true, aimX: p.x - 100, aimY: p.y }));
  assert.strictEqual(e.hp, hp0, '背对时不应命中');
});

test('攻击冷却生效，连点不会每帧出手', () => {
  const w = newWorld(555);
  clearAround(w, 2);
  const p = w.player;
  p.cd = 0.3;
  const before = p.cd;
  w.tick(0.02, idle({ firing: true, aimX: p.x + 50, aimY: p.y }));
  assert.ok(p.cd < before, '冷却应递减');
  assert.ok(p.cd > 0.2, '冷却未走完不应清零');
});

test('打空血会移除敌人并给经验', () => {
  const w = newWorld(2024);
  clearAround(w, 3);
  const p = w.player;
  const e = w.enemies.find((x) => !x.boss);
  e.x = p.x + 18;
  e.y = p.y;
  e.hp = 1;
  const xp0 = p.xp;
  w.tick(0.02, idle({ firing: true, aimX: e.x, aimY: e.y }));
  assert.ok(e.dead, '敌人应标记死亡');
  assert.ok(p.xp > xp0, '应获得经验');
  assert.ok(w.runStats.kills >= 1);
});

test('敌人贴身会造成伤害并触发无敌帧', () => {
  const w = newWorld(31337);
  clearAround(w, 3);
  const p = w.player;
  p.invuln = 0;
  const e = w.enemies.find((x) => !x.boss);
  e.x = p.x + 6;
  e.y = p.y;
  e.awake = true;
  e.cd = 0;
  const hp0 = p.hp;
  w.tick(0.02, idle());
  assert.ok(p.hp < hp0, `玩家应掉血，实际 ${hp0} -> ${p.hp}`);
  assert.ok(p.invuln > 0, '应进入无敌帧');
});

test('远程敌人会发射弹丸', () => {
  const w = newWorld(606);
  clearAround(w, 4);
  const p = w.player;
  const e = w.enemies.find((x) => x.ranged);
  if (!e) return; // 第 1 层可能没有远程怪
  e.x = p.x + 90;
  e.y = p.y;
  e.awake = true;
  e.cd = 0;
  const n0 = w.projectiles.length;
  w.tick(0.02, idle());
  assert.ok(w.projectiles.length > n0, '应生成弹丸');
});

test('层主死前楼梯锁定，死后解锁', () => {
  const w = newWorld(707);
  assert.strictEqual(w.stairs.locked, true);
  const boss = w.enemies.find((e) => e.boss);
  assert.ok(boss, '第 1 层应有层主');
  w.damageEnemy(boss, 999);
  assert.strictEqual(w.stairs.locked, false);
  assert.ok(w.meta.crystals > 0, '应获得晶石');
});

test('升级会暂停并弹出三选一', () => {
  const w = newWorld(808);
  const p = w.player;
  p.xp = p.xpNext;
  const e = w.enemies.find((x) => !x.boss);
  w.damageEnemy(e, 999);
  assert.ok(w.pending, '应弹出三选一');
  assert.strictEqual(w.pending.length, 3);
  assert.strictEqual(w.paused, true);
  w.resolveChoice(0);
  assert.strictEqual(w.pending, null);
  assert.strictEqual(w.paused, false);
});

test('踩到解封的楼梯会自动下一层', () => {
  const w = newWorld(909);
  w.stairs.locked = false;
  w.player.x = w.stairs.x;
  w.player.y = w.stairs.y;
  w.tick(0.02, idle());
  assert.strictEqual(w.depth, 2);
  assert.ok(w.enemies.length > 0);
});

test('无尽模式：第 5 层的深渊领主杀掉后只是开楼梯，不会通关', () => {
  const w = newWorld(1010);
  w.debugGoto(5);
  const boss = w.enemies.find((e) => e.boss);
  assert.ok(boss, '第 5 层应有层主');
  assert.strictEqual(boss.type, 'overlord', '第 5 层应是深渊领主');
  assert.strictEqual(w.stairs.locked, true, '楼梯一开始是锁的');
  w.damageEnemy(boss, 999);
  assert.strictEqual(w.screen, 'playing', '不应进入胜利结算');
  assert.strictEqual(w.stairs.locked, false, '杀掉层主应解锁楼梯');
});

test('地牢没有层数上限：深层依然能生成并正常游玩', () => {
  const w = newWorld(1020);
  for (const d of [6, 12, 25, 40]) {
    w.debugGoto(d);
    assert.strictEqual(w.depth, d);
    assert.ok(w.enemies.length > 0, `第 ${d} 层没有敌人`);
    assert.ok(w.items.length > 0, `第 ${d} 层没有物品`);
    const boss = w.enemies.find((e) => e.boss);
    assert.ok(boss, `第 ${d} 层没有层主`);
    assert.strictEqual(w.stairs.locked, true);
  }
});

test('每 3 层出现一次「继续 / 收手」岔路', () => {
  const w = newWorld(1030);
  // 手动把层数对齐到 3 层，再踩楼梯
  w.debugGoto(3);
  w.stairs.locked = false;
  w.player.x = w.stairs.x;
  w.player.y = w.stairs.y;
  w.tick(0.02, idle());
  assert.ok(w.restPrompt, '第 3 层下楼应弹出岔路');
  assert.strictEqual(w.restPrompt.next, 4);
  assert.strictEqual(w.paused, true, '岔路应暂停游戏');
  assert.strictEqual(w.depth, 3, '还没真正下去');

  assert.strictEqual(w.continueRun(), true);
  assert.strictEqual(w.depth, 4, '选择继续后应进入第 4 层');
  assert.strictEqual(w.restPrompt, null);
  assert.strictEqual(w.paused, false);

  // 第 4 层下楼不该问（下一次是第 7 层）
  w.stairs.locked = false;
  w.player.x = w.stairs.x;
  w.player.y = w.stairs.y;
  w.tick(0.02, idle());
  assert.strictEqual(w.restPrompt, null, '第 4 → 5 层不该弹岔路');
  assert.strictEqual(w.depth, 5);
});

test('岔路选「收手」会回到标题并记录最深层', () => {
  const w = newWorld(1040);
  w.debugGoto(3);
  w.stairs.locked = false;
  w.player.x = w.stairs.x;
  w.player.y = w.stairs.y;
  w.tick(0.02, idle());
  assert.ok(w.restPrompt);

  assert.strictEqual(w.endRun(), true);
  assert.strictEqual(w.screen, 'title');
  assert.strictEqual(w.restPrompt, null);
  assert.strictEqual(w.meta.best.floor, 3, '应记录最深到第 3 层');
});

test('怪物数值随层数小幅上升，深渊领主每 5 层出现', () => {
  const w = newWorld(1050);
  w.player.weapons = ['starter'];
  w.player.weapon = Engine.WEAPONS.starter;
  w.threat = 0; // 钉死威胁倍率，单独看层数成长

  const ratAt = (d) => {
    w.debugGoto(d);
    // 深层刷怪池随机，直接造一只同类对比
    return w.spawnEnemy('rat', w.player.x, w.player.y + 40);
  };

  const a = ratAt(1);
  const b = ratAt(11);
  assert.ok(b.maxHp > a.maxHp, `第 11 层的怪应比第 1 层硬（${b.maxHp} vs ${a.maxHp}）`);
  assert.ok(b.atk > a.atk, '第 11 层的怪应比第 1 层疼');
  assert.ok(b.maxHp < a.maxHp * 3, `第 11 层血量涨幅应是小幅（${b.maxHp} vs ${a.maxHp}）`);

  assert.strictEqual(w.enemies.find((e) => e.boss).type, 'master', '第 11 层是普通层主');
  w.debugGoto(15);
  assert.strictEqual(w.enemies.find((e) => e.boss).type, 'overlord', '第 15 层应是深渊领主');
});

test('玩家 DPS 越高，同层怪物血量越高', () => {
  const w = newWorld(1060);
  w.player.weapons = ['sword'];
  w.player.weapon = Engine.WEAPONS.sword;

  const hpAt = (depth) => {
    w.debugGoto(depth); // 内部会按当前面板重算 threat
    const e = w.spawnEnemy('slime', w.player.x, w.player.y + 40);
    e.dead = true; // 只是取样，别留在场上
    return e.maxHp;
  };

  w.player.atk = 8;
  w.player.crit = 0.0;
  const weak = w.threatMul();
  const weakHp = hpAt(10);

  w.player.atk = 40;
  w.player.crit = 0.5;
  const strong = w.threatMul();
  const strongHp = hpAt(10);

  assert.ok(strong > weak, `DPS 高时威胁倍率应更大（${strong.toFixed(2)} vs ${weak.toFixed(2)}）`);
  assert.ok(strongHp > weakHp, `同一层，强玩家的怪物应更硬（${strongHp} vs ${weakHp}）`);
  assert.ok(strong <= Engine.SCALING.dpsMax + 1e-6, '威胁倍率应有上限');
  assert.ok(strongHp < weakHp * 4, '跟随幅度不应失控');
});

test('新怪物都能生成并带出各自的行为参数', () => {
  const w = newWorld(1070);
  w.threat = 1;
  w.debugGoto(12);

  for (const [type, check] of [
    ['wraith', (e) => e.dodge > 0],
    ['golem', (e) => e.knockPlayer > 0],
    ['bomber', (e) => e.splash > 0 && e.ranged],
  ]) {
    assert.ok(Engine.ENEMY_TYPES[type], `缺少怪物定义 ${type}`);
    const e = w.spawnEnemy(type, w.player.x, w.player.y + 40);
    assert.ok(check(e), `${type} 的行为参数没有传下去`);
    e.dead = true;
  }

  // 深层刷怪池里真的会出现新怪
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    w.debugGoto(12 + (i % 4));
    for (const e of w.enemies) if (!e.boss) seen.add(e.type);
  }
  const fresh = ['wraith', 'golem', 'bomber'].filter((t) => seen.has(t));
  assert.ok(fresh.length >= 2, `第 12~15 层应刷出新怪，实际只见到 ${[...seen].join(',')}`);
});

test('掷弹手的炸弹会范围爆炸并伤到玩家', () => {
  const w = newWorld(1080);
  w.threat = 1;
  w.debugGoto(9);
  w.enemies = [];
  const b = w.spawnEnemy('bomber', w.player.x + 60, w.player.y);
  b.awake = true;
  b.cd = 0;
  w.player.invuln = 0;
  const hp0 = w.player.hp;

  // 手动抛一颗落在玩家身上的炸弹
  w.projectiles.push({
    x: w.player.x + 6,
    y: w.player.y,
    vx: -20,
    vy: 0,
    life: 2,
    dmg: 10,
    from: 'enemy',
    r: 5,
    splash: 30,
  });
  for (let i = 0; i < 6; i++) w.tick(0.016, idle());
  assert.ok(w.blasts.length > 0 || w.player.hp < hp0, '炸弹应产生爆炸');
  assert.ok(w.player.hp < hp0, `爆炸应伤到玩家（${hp0} → ${w.player.hp}）`);
});

test('被击倒会进入死亡结算', () => {
  const w = newWorld(1111);
  w.player.hp = 1;
  w.player.invuln = 0;
  w.player.revive = 0;
  w.hurtPlayer(999, { type: 'test' });
  assert.strictEqual(w.screen, 'dead');
  assert.strictEqual(w.deathInfo.floor, 1);
});

test('护符会挡住一次死亡', () => {
  const w = newWorld(1212);
  w.player.revive = 1;
  w.player.hp = 1;
  w.player.invuln = 0;
  w.hurtPlayer(999, { type: 'test' });
  assert.strictEqual(w.screen, 'playing');
  assert.strictEqual(w.player.revive, 0);
  assert.ok(w.player.hp > 0);
});

test('每层生成的地图都能从出生点走到楼梯', () => {
  for (let depth = 1; depth <= 5; depth++) {
    for (let i = 0; i < 40; i++) {
      const rng = new RNG(depth * 7919 + i);
      const f = MapGen.generateFloor(rng, depth);
      const { dist } = MapGen.bfsFrom(f.tiles, f.start.x, f.start.y);
      assert.ok(dist[f.stairs.y * f.w + f.stairs.x] >= 0, `深度 ${depth} 第 ${i} 张楼梯不可达`);
    }
  }
});

test('层主与所有敌人都不会生成在墙里', () => {
  for (let seed = 1; seed <= 25; seed++) {
    for (let depth = 1; depth <= 5; depth++) {
      const w = new Engine.World(freshMeta(), seed * 131 + depth);
      w.startRun();
      w.debugGoto(depth);
      for (const e of w.enemies) {
        assert.ok(
          !w.blocked(e.x, e.y, e.hw, e.hh),
          `深度 ${depth} seed ${seed} 的${e.name}(${e.type})卡在墙里 (${e.x.toFixed(1)},${e.y.toFixed(1)})`,
        );
      }
      const boss = w.enemies.find((e) => e.boss);
      assert.ok(boss, `深度 ${depth} 没有层主`);
      assert.ok(!w.blocked(boss.x, boss.y, boss.hw, boss.hh), `深度 ${depth} seed ${seed} 层主卡在墙里`);
    }
  }
});

test('暂停状态不会与选项脱钩（自愈前置条件）', () => {
  const w = newWorld(4242);
  w.paused = true;
  w.pending = null;
  w.pendingLevels = 0;
  // 模拟 client 的自愈逻辑
  if (w.paused && !w.pending) {
    w.paused = false;
    w.pendingLevels = 0;
  }
  assert.strictEqual(w.paused, false);
});

test('层主会主动接近玩家', () => {
  const w = newWorld(777);
  clearAround(w, 5);
  const p = w.player;
  const boss = w.enemies.find((e) => e.boss);
  boss.x = p.x + 64;
  boss.y = p.y;
  boss.awake = true;
  boss.cd = 5;
  const d0 = Math.abs(boss.x - p.x);
  for (let i = 0; i < 40; i++) w.tick(0.016, idle());
  const d1 = Math.abs(boss.x - p.x);
  assert.ok(d1 < d0, `层主没靠近：${d0.toFixed(1)} -> ${d1.toFixed(1)}`);
});

test('远程箭矢能打破隐藏墙', () => {
  let w = null;
  let wall = null;
  for (let seed = 1; seed <= 40 && !wall; seed++) {
    const cand = newWorld(seed * 977);
    for (let y = 1; y < cand.mapH - 1 && !wall; y++) {
      for (let x = 1; x < cand.mapW - 1; x++) {
        if (cand.tiles[y * cand.mapW + x] === MapGen.SECRET) {
          wall = { x, y };
          w = cand;
          break;
        }
      }
    }
  }
  assert.ok(wall, '40 张图里一个隐藏房都没找到');

  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let stand = null;
  for (const [dx, dy] of dirs) {
    const sx = wall.x - dx;
    const sy = wall.y - dy;
    if (w.tileAt(sx, sy) === MapGen.FLOOR) {
      stand = { x: sx, y: sy };
      break;
    }
  }
  assert.ok(stand, '裂墙周围没有可站的格子');

  const p = w.player;
  p.x = (stand.x + 0.5) * TILE;
  p.y = (stand.y + 0.5) * TILE;
  p.weapon = Engine.WEAPONS.bow;
  p.invuln = 99;

  const aimX = (wall.x + 0.5) * TILE;
  const aimY = (wall.y + 0.5) * TILE;

  for (let i = 0; i < 30 && w.tileAt(wall.x, wall.y) === MapGen.SECRET; i++) {
    p.cd = 0;
    w.tick(0.016, idle({ firing: true, aimX, aimY }));
  }
  assert.strictEqual(w.tileAt(wall.x, wall.y), MapGen.FLOOR, '箭矢没能打破裂墙');
});

test('近战也能打破隐藏墙', () => {
  let w = null;
  let wall = null;
  for (let seed = 1; seed <= 40 && !wall; seed++) {
    const cand = newWorld(seed * 613);
    for (let y = 1; y < cand.mapH - 1 && !wall; y++) {
      for (let x = 1; x < cand.mapW - 1; x++) {
        if (cand.tiles[y * cand.mapW + x] === MapGen.SECRET) {
          wall = { x, y };
          w = cand;
          break;
        }
      }
    }
  }
  assert.ok(wall, '40 张图里一个隐藏房都没找到');

  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let stand = null;
  for (const [dx, dy] of dirs) {
    const sx = wall.x - dx;
    const sy = wall.y - dy;
    if (w.tileAt(sx, sy) === MapGen.FLOOR) {
      stand = { x: sx, y: sy };
      break;
    }
  }
  assert.ok(stand, '裂墙周围没有可站的格子');

  const p = w.player;
  p.x = (stand.x + 0.5) * TILE;
  p.y = (stand.y + 0.5) * TILE;
  p.weapon = Engine.WEAPONS.sword;
  p.invuln = 99;
  p.cd = 0;
  w.tick(0.016, idle({ firing: true, aimX: (wall.x + 0.5) * TILE, aimY: (wall.y + 0.5) * TILE }));
  assert.strictEqual(w.tileAt(wall.x, wall.y), MapGen.FLOOR, '近战没能打破裂墙');
});

test('高速箭矢不会穿过墙壁', () => {
  const w = newWorld(2718);
  clearAround(w, 2);
  const p = w.player;
  const pt = w.playerTile();
  // 右边两格都砌成墙
  w.tiles[pt.y * w.mapW + (pt.x + 1)] = MapGen.WALL;
  w.tiles[pt.y * w.mapW + (pt.x + 2)] = MapGen.WALL;
  p.weapon = Engine.WEAPONS.bow;
  p.invuln = 99;
  p.cd = 0;
  // 用最大步长（50ms）发射并推进，检查有没有漏过墙
  for (let i = 0; i < 6; i++) {
    w.tick(0.05, idle({ firing: i === 0, aimX: (pt.x + 1.5) * TILE, aimY: (pt.y + 0.5) * TILE }));
    for (const pr of w.projectiles) {
      const tx = Math.floor(pr.x / TILE);
      const ty = Math.floor(pr.y / TILE);
      assert.ok(!w.isSolidTile(tx, ty), `箭矢陷在墙里 (${pr.x.toFixed(1)},${pr.y.toFixed(1)})`);
    }
  }
});

test('药水已满时踩在药水上不会让物品数组暴涨（曾导致 Invalid array length）', () => {
  const w = newWorld(5150);
  clearAround(w, 2);
  const p = w.player;
  p.potion = Engine.POTION_CAP;
  p.invuln = 99;
  // 在玩家脚下放一瓶药水：每帧都会尝试拾取，但背包已满
  w.items.push({ id: 999999, x: p.x, y: p.y, kind: 'potion' });
  const n0 = w.items.length;
  for (let i = 0; i < 120; i++) {
    w.tick(0.016, idle());
    assert.ok(w.items.length <= n0 + 1, `物品数组暴涨到 ${w.items.length}`);
  }
  assert.ok(
    w.items.some((it) => it.kind === 'potion'),
    '药水满时应该留在原地',
  );
});

test('敌人能沿流场绕过 L 形拐角', () => {
  const w = newWorld(1);
  const W = w.mapW;
  for (let i = 0; i < w.tiles.length; i++) w.tiles[i] = MapGen.WALL;
  // 挖一个 L 形走廊：横向 (5..15, y=5)，纵向 (x=15, y=5..15)
  for (let x = 5; x <= 15; x++) w.tiles[5 * W + x] = MapGen.FLOOR;
  for (let y = 5; y <= 15; y++) w.tiles[y * W + 15] = MapGen.FLOOR;

  const p = w.player;
  p.x = 15.5 * TILE;
  p.y = 15.5 * TILE;
  p.invuln = 9999;

  const e = w.enemies[0];
  e.x = 5.5 * TILE;
  e.y = 5.5 * TILE;
  e.awake = true;
  e.speed = 220;
  w.enemies = [e];

  const d0 = Math.hypot(e.x - p.x, e.y - p.y);
  for (let i = 0; i < 400; i++) w.tick(0.016, idle());
  const d1 = Math.hypot(e.x - p.x, e.y - p.y);
  assert.ok(d1 < d0 - 120, `没绕过拐角：${d0.toFixed(0)} -> ${d1.toFixed(0)}`);
});

test('两只敌人挤在单格走廊里不会互相顶死', () => {
  const w = newWorld(2);
  const W = w.mapW;
  for (let i = 0; i < w.tiles.length; i++) w.tiles[i] = MapGen.WALL;
  const lane = 8;
  for (let x = 3; x <= 22; x++) w.tiles[lane * W + x] = MapGen.FLOOR;

  const p = w.player;
  p.x = 21.5 * TILE;
  p.y = (lane + 0.5) * TILE;
  p.invuln = 9999;

  const e1 = w.enemies[0];
  const e2 = w.enemies[1];
  e1.x = 4.5 * TILE;
  e1.y = (lane + 0.5) * TILE;
  e2.x = 6.5 * TILE;
  e2.y = (lane + 0.5) * TILE;
  e1.awake = e2.awake = true;
  e1.speed = e2.speed = 90;
  w.enemies = [e1, e2];

  const d0 = Math.hypot(e1.x - p.x, e1.y - p.y);
  for (let i = 0; i < 400; i++) w.tick(0.016, idle());
  const d1 = Math.hypot(e1.x - p.x, e1.y - p.y);
  assert.ok(d1 < d0 - 100, `前面的敌人被同伙顶住了：${d0.toFixed(0)} -> ${d1.toFixed(0)}`);
});

test('真实地图上清醒的敌人绝大多数都能摸到玩家', () => {
  let frozen = 0;
  let awake = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const w = new Engine.World(freshMeta(), seed * 101);
    w.startRun(seed * 101);
    if (w.pending) w.resolveChoice(0);
    w.player.invuln = 999999;
    const list = w.enemies.slice();
    for (let i = 0; i < 500; i++) w.tick(0.016, idle({ aimX: w.player.x, aimY: w.player.y }));
    const snap = list.map((e) => ({ x: e.x, y: e.y }));
    for (let i = 0; i < 60; i++) w.tick(0.016, idle({ aimX: w.player.x, aimY: w.player.y }));
    list.forEach((e, i) => {
      if (!e.awake || e.dead) return;
      awake++;
      const moved = Math.hypot(e.x - snap[i].x, e.y - snap[i].y);
      const d = Math.hypot(e.x - w.player.x, e.y - w.player.y);
      if (e.ranged && d < 220) return; // 远程怪主动保持距离
      if (moved < 2.5 && d > 45) frozen++;
    });
  }
  const ratio = awake ? frozen / awake : 0;
  assert.ok(ratio < 0.06, `${frozen}/${awake} 只敌人卡住不动（${(ratio * 100).toFixed(1)}%），应低于 6%`);
});

test('玩家就在旁边时层主不会掉头回防', () => {
  const w = newWorld(999);
  const W = w.mapW;
  for (let x = 2; x < 40; x++) w.tiles[10 * W + x] = MapGen.FLOOR;
  const boss = w.enemies.find((e) => e.guard);
  assert.ok(boss, '应有层主');
  // 让层主离「家」很远，但玩家就在旁边
  boss.homeX = 3 * TILE;
  boss.homeY = 10.5 * TILE;
  boss.x = 20 * TILE;
  boss.y = 10.5 * TILE;
  boss.awake = true;
  boss.lostTimer = 0;
  w.player.x = 22 * TILE;
  w.player.y = 10.5 * TILE;
  w.enemies = [boss];
  w.updateFlow();

  const d0 = Math.abs(boss.x - w.player.x);
  for (let i = 0; i < 40; i++) w.tick(0.016, idle({ aimX: w.player.x, aimY: w.player.y }));
  const d1 = Math.abs(boss.x - w.player.x);
  assert.ok(d1 < d0, `层主反而远离了玩家：${d0.toFixed(0)} -> ${d1.toFixed(0)}`);
});

test('玩家远离且层主离岗时会回防', () => {
  const w = newWorld(998);
  const W = w.mapW;
  for (let x = 2; x < 45; x++) w.tiles[10 * W + x] = MapGen.FLOOR;
  const boss = w.enemies.find((e) => e.guard);
  boss.homeX = 4 * TILE;
  boss.homeY = 10.5 * TILE;
  boss.x = 16 * TILE;
  boss.y = 10.5 * TILE;
  boss.awake = true;
  boss.lostTimer = 0;
  w.player.x = 41 * TILE;
  w.player.y = 10.5 * TILE;
  w.enemies = [boss];
  w.updateFlow();

  const x0 = boss.x;
  for (let i = 0; i < 40; i++) w.tick(0.016, idle({ aimX: w.player.x, aimY: w.player.y }));
  assert.ok(boss.x < x0 - 5, `层主没有回防，x ${x0.toFixed(0)} -> ${boss.x.toFixed(0)}`);
});

test('五把武器都能命中并造成伤害', () => {
  for (const id of Object.keys(Engine.WEAPONS)) {
    const w = newWorld(4000 + id.length);
    clearAround(w, 3);
    const p = w.player;
    p.weapons = [id];
    p.weaponIndex = 0;
    p.weapon = Engine.WEAPONS[id];
    p.crit = 0;
    const e = w.enemies.find((x) => !x.boss);
    e.x = p.x + 16;
    e.y = p.y;
    e.hp = 99999;
    e.awake = true;
    const hp0 = e.hp;
    for (let i = 0; i < 15; i++) {
      p.cd = 0;
      w.tick(0.016, idle({ firing: true, aimX: e.x, aimY: e.y }));
    }
    assert.ok(e.hp < hp0, `${id} 没有造成伤害`);
  }
});

test('铁剑连中三次后第四击爆发', () => {
  const w = newWorld(6000);
  clearAround(w, 3);
  const p = w.player;
  p.weapons = ['sword'];
  p.weaponIndex = 0;
  p.weapon = Engine.WEAPONS.sword;
  p.crit = 0;
  p.atk = 10;
  const e = w.enemies.find((x) => !x.boss);
  e.x = p.x + 16;
  e.y = p.y;
  e.hp = 99999;
  e.awake = true;
  e.def = 0;

  const hits = [];
  for (let i = 0; i < 4; i++) {
    const before = e.hp;
    p.cd = 0;
    w.tick(0.016, idle({ firing: true, aimX: e.x, aimY: e.y }));
    hits.push(before - e.hp);
  }
  assert.ok(hits[3] > hits[0] * 1.3, `第四击没有爆发，四击伤害 ${hits.join(' / ')}`);
});

test('战锤会把敌人击退', () => {
  const w = newWorld(6100);
  clearAround(w, 4);
  const p = w.player;
  p.weapons = ['hammer'];
  p.weaponIndex = 0;
  p.weapon = Engine.WEAPONS.hammer;
  p.crit = 0;
  const e = w.enemies.find((x) => !x.boss);
  e.x = p.x + 18;
  e.y = p.y;
  e.hp = 99999;
  e.awake = true;
  const x0 = e.x;
  p.cd = 0;
  w.tick(0.016, idle({ firing: true, aimX: e.x, aimY: e.y }));
  assert.ok(e.x > x0 + 4, `敌人没有被击退：${x0.toFixed(0)} -> ${e.x.toFixed(0)}`);
  assert.ok(e.slowTimer > 0, '敌人应被减速');
});

test('宝箱内容在武器与增益之间随机', () => {
  let weaponOnly = 0;
  let buffOnly = 0;
  let mixed = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const w = newWorld(9000 + seed);
    w.openChest({ x: w.player.x, y: w.player.y });
    assert.ok(w.pending, '应弹出选择');
    assert.strictEqual(w.paused, true);
    assert.strictEqual(w.pendingKind, 'chest');
    assert.ok(w.pending.length >= 2 && w.pending.length <= 3, `选项数量应在 2~3，实际 ${w.pending.length}`);
    assert.ok(!w.pending.some((o) => o.id === 'starter'), '旧木棒不该出现在宝箱里');

    const hasW = w.pending.some((o) => o.kind === 'weapon');
    const hasB = w.pending.some((o) => o.kind === 'buff');
    if (hasW && hasB) mixed++;
    else if (hasW) weaponOnly++;
    else buffOnly++;
  }
  assert.ok(mixed > 0, '应出现过武器+增益混合的宝箱');
  assert.ok(buffOnly > 0, '应出现过纯增益的宝箱');
  assert.ok(weaponOnly + mixed > buffOnly, '武器仍应是宝箱的主要产出');
});

test('宝箱选武器会入库', () => {
  let w = null;
  for (let seed = 1; seed <= 40; seed++) {
    const cand = newWorld(9100 + seed);
    cand.openChest({ x: cand.player.x, y: cand.player.y });
    if (cand.pending.some((o) => o.kind === 'weapon')) {
      w = cand;
      break;
    }
  }
  assert.ok(w, '40 个宝箱里一个武器都没刷出来');
  const idx = w.pending.findIndex((o) => o.kind === 'weapon');
  const wantId = w.pending[idx].id;
  w.resolveChoice(idx);
  assert.ok(w.player.weapons.includes(wantId), '新武器应在武器栏里');
  assert.strictEqual(w.player.weapon.id, wantId, '应自动装备新武器');
  assert.strictEqual(w.paused, false);
});

test('开局只有一根旧木棒，不弹选择', () => {
  const w = new Engine.World(freshMeta(), 8000);
  w.startRun(8000);
  assert.strictEqual(w.paused, false);
  assert.strictEqual(w.pending, null);
  assert.deepStrictEqual(w.player.weapons, ['starter']);
  assert.strictEqual(w.player.weapon.id, 'starter');
  const s = Engine.WEAPONS.starter;
  const sw = Engine.WEAPONS.sword;
  assert.ok(s.mult < sw.mult, '初始武器伤害应更低');
  assert.ok(s.reach < sw.reach, '初始武器范围应更小');
});

test('拿到第一把武器会直接换掉旧木棒', () => {
  const w = newWorld(8200);
  assert.deepStrictEqual(w.player.weapons, ['starter']);
  w.gainWeapon('sword');
  assert.deepStrictEqual(w.player.weapons, ['sword'], '木棒应被替换而不是并列');
  assert.strictEqual(w.player.weapon.id, 'sword');
});

test('武器栏两格满了会顶掉手持武器，旧武器掉在地上', () => {
  const w = newWorld(8300);
  w.gainWeapon('sword');
  w.gainWeapon('bow');
  assert.strictEqual(w.player.weapons.length, 2);
  assert.strictEqual(w.player.weapon.id, 'bow');

  w.gainWeapon('hammer');
  assert.strictEqual(w.player.weapons.length, 2, '栏位不能超过两格');
  assert.ok(w.player.weapons.includes('hammer'));
  const dropped = w.items.filter((it) => it.kind === 'weapon');
  assert.strictEqual(dropped.length, 1, '旧武器应掉在地上');
  assert.strictEqual(dropped[0].weaponId, 'bow', '掉的应该是被顶替的那把');
});

test('地上的武器可以按 E 捡回来', () => {
  const w = newWorld(8400);
  w.gainWeapon('sword');
  w.gainWeapon('bow');
  w.gainWeapon('hammer');
  const ground = w.items.find((it) => it.kind === 'weapon');
  assert.ok(ground, '应有掉落武器');
  w.player.x = ground.x;
  w.player.y = ground.y;
  const ok = w.pickupWeaponNearby();
  assert.strictEqual(ok, true);
  assert.ok(w.player.weapons.includes(ground.weaponId), '应捡起掉落的武器');
  assert.ok(!w.items.some((it) => it.id === ground.id), '地上的那把应消失');
});

test('地上的武器不会被自动拾取', () => {
  const w = newWorld(8500);
  w.gainWeapon('sword');
  w.gainWeapon('bow');
  w.gainWeapon('hammer');
  const ground = w.items.find((it) => it.kind === 'weapon');
  w.player.x = ground.x;
  w.player.y = ground.y;
  for (let i = 0; i < 30; i++) w.tick(0.016, idle());
  assert.ok(w.items.some((it) => it.id === ground.id), '走过去不应该自动捡起武器');
});

test('可以在已拥有的武器间切换', () => {
  const w = newWorld(8100);
  w.player.weapons = ['sword'];
  w.player.weaponIndex = 0;
  w.player.weapon = Engine.WEAPONS.sword;
  w.gainWeapon('bow');
  assert.strictEqual(w.player.weapons.length, 2);
  w.switchWeapon(0);
  assert.strictEqual(w.player.weapon.id, w.player.weapons[0]);
  w.cycleWeapon(1);
  assert.strictEqual(w.player.weaponIndex, 1);
  assert.strictEqual(w.switchWeapon(9), false, '越界不应切换');
});

test('纯武器宝箱才有「都不想要」，混合与纯增益没有', () => {
  let skipped = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const w = newWorld(9200 + seed);
    w.openChest({ x: w.player.x, y: w.player.y });
    const allWeapon = w.pending.every((o) => o.kind === 'weapon');
    assert.strictEqual(w.pendingSkip, allWeapon, `种子 ${seed} 的按钮显示条件不对`);
    if (allWeapon) skipped++;
  }
  assert.ok(skipped > 0, '应出现过纯武器宝箱');
});

/** 找一个会刷出「三把武器」的宝箱，返回 { w, chest } */
function findWeaponOnlyChest(from) {
  for (let seed = from; seed < from + 400; seed++) {
    const w = newWorld(seed);
    const chest = { id: seed, x: w.player.x, y: w.player.y, kind: 'chest' };
    w.items.push(chest);
    w.openChest(chest);
    if (w.pendingSkip) return { w, chest };
  }
  return null;
}

test('「都不想要」关掉界面，但箱子留在原地', () => {
  const found = findWeaponOnlyChest(9500);
  assert.ok(found, '没找到纯武器宝箱');
  const { w, chest } = found;
  assert.strictEqual(w.skipPending(), true);
  assert.strictEqual(w.pending, null, '界面应关闭');
  assert.strictEqual(w.pendingKind, '');
  assert.strictEqual(w.paused, false, '应解除暂停');
  assert.ok(w.items.includes(chest), '箱子应留在原地');
});

test('选了东西之后箱子才消失', () => {
  const w = newWorld(9700);
  const chest = { id: 9992, x: w.player.x, y: w.player.y, kind: 'chest' };
  w.items.push(chest);
  w.openChest(chest);
  assert.ok(w.items.includes(chest), '还没选时箱子不该消失');
  w.resolveChoice(0);
  assert.ok(!w.items.includes(chest), '选完后箱子应被拿走');
});

test('站在被跳过的箱子上不会反复弹窗，走开再回来才重新开', () => {
  const found = findWeaponOnlyChest(9900);
  assert.ok(found, '没找到纯武器宝箱');
  const { w, chest } = found;
  assert.strictEqual(w.skipPending(), true);

  // 原地站 2 秒：不能每帧都弹
  for (let i = 0; i < 120; i++) w.tick(0.016, idle());
  assert.strictEqual(w.pending, null, '站在箱子上不该反复弹窗');

  // 走开一段再回来，应该能重新打开
  w.player.x += 40;
  w.tick(0.016, idle());
  w.player.x -= 40;
  w.tick(0.016, idle());
  assert.ok(w.pending, '走开再回来应能重新打开');
  assert.strictEqual(w.pendingChest, chest, '重新打开的应是同一个箱子');
});

test('每层都有商店，货架与价格符合定价', () => {
  let reviveListed = 0;
  const prices = { item: new Set(), revive: new Set() };
  for (let seed = 1; seed <= 40; seed++) {
    const w = newWorld(11000 + seed);
    const shop = w.items.find((i) => i.kind === 'shop');
    assert.ok(shop, `种子 ${seed} 的第 1 层没有商店`);
    assert.ok(shop.stock.length >= 4 && shop.stock.length <= 5, `货架件数异常：${shop.stock.length}`);
    assert.ok(shop.stock.some((s) => s.kind === 'weapon'), '货架应至少有一把武器');
    for (const s of shop.stock) {
      const kind = s.kind === 'revive' ? 'revive' : 'item';
      const base = Engine.shopBasePrice(1, kind);
      assert.strictEqual(s.price % Engine.SHOP_PRICE.step, 0, `${s.name} 价格应是 ${Engine.SHOP_PRICE.step} 的倍数`);
      assert.ok(
        s.price >= base * 0.84 && s.price <= base * 1.16,
        `${s.name} 价格 ${s.price} 偏离第 1 层基准 ${base} 太多`,
      );
      assert.strictEqual(s.sold, false);
      prices[kind].add(s.price);
    }
    if (shop.stock.some((s) => s.kind === 'revive')) reviveListed++;
  }
  assert.ok(reviveListed > 8 && reviveListed < 32, `护符上架率应在 50% 上下，实际 ${reviveListed}/40`);
  assert.ok(prices.item.size > 1, '武器/增益价格应有浮动，不该是固定一个数');
  assert.ok(prices.revive.size > 1, '护符价格应有浮动');
});

test('价格随层数小幅上升，武器与增益始终比护符便宜', () => {
  for (let d = 1; d <= 5; d++) {
    const rv = Engine.shopBasePrice(d, 'revive');
    const it = Engine.shopBasePrice(d, 'item');
    assert.ok(it < rv, `第 ${d} 层：武器/增益应比护符便宜`);
    assert.ok(
      Math.abs(it / rv - 0.75) < 0.02,
      `第 ${d} 层：武器与增益应约为护符的 75%，实际 ${((it / rv) * 100).toFixed(1)}%`,
    );
    if (d > 1) {
      const prev = Engine.shopBasePrice(d - 1, 'revive');
      assert.ok(rv > prev, `第 ${d} 层护符基准价应高于第 ${d - 1} 层`);
      assert.ok(rv - prev <= prev * 0.15, `每层涨幅应是小幅（≤15%），实际 +${((rv / prev - 1) * 100).toFixed(1)}%`);
    }
  }
  // 浮动后仍不能出现「武器比护符贵」的倒挂
  const swing = Engine.SHOP_PRICE.swing;
  for (let d = 1; d <= 5; d++) {
    const itemMax = Engine.shopBasePrice(d, 'item') * (1 + swing);
    const reviveMin = Engine.shopBasePrice(d, 'revive') * (1 - swing);
    assert.ok(itemMax < reviveMin, `第 ${d} 层浮动后可能出现武器比护符贵`);
  }
});

test('同一层的不同商店价格不完全一样', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 25; seed++) {
    const w = newWorld(16000 + seed);
    const shop = w.items.find((i) => i.kind === 'shop');
    for (const s of shop.stock) seen.add(`${s.kind}:${s.price}`);
  }
  const itemPrices = new Set([...seen].filter((k) => k.startsWith('weapon') || k.startsWith('buff')).map((k) => k.split(':')[1]));
  assert.ok(itemPrices.size >= 3, `同一层的武器/增益价格应有多种，实际 ${itemPrices.size} 种`);
});

test('商店可以买护符、买卖扣钱、钱不够买不了', () => {
  let found = null;
  for (let seed = 1; seed <= 60 && !found; seed++) {
    const w = newWorld(12000 + seed);
    const shop = w.items.find((i) => i.kind === 'shop');
    if (shop && shop.stock.some((s) => s.kind === 'revive')) found = { w, shop };
  }
  assert.ok(found, '没找到上架护符的商店');
  const { w, shop } = found;

  w.openShop(shop);
  assert.ok(w.shop, '应打开商店');
  assert.strictEqual(w.paused, true);

  const ri = w.shop.stock.findIndex((s) => s.kind === 'revive');
  const price = w.shop.stock[ri].price;

  w.player.gold = price - 1;
  assert.strictEqual(w.buyShop(ri), false, '钱不够不该成交');
  assert.strictEqual(w.player.gold, price - 1, '失败不应扣钱');

  w.player.gold = price + 30;
  assert.strictEqual(w.buyShop(ri), true);
  assert.strictEqual(w.player.gold, 30, '应扣掉护符的价格');
  assert.strictEqual(w.player.revive, 1);
  assert.strictEqual(w.buyShop(ri), false, '同一件不能重复买');
  assert.strictEqual(w.player.gold, 30, '重复购买不应再扣钱');

  w.closeShop();
  assert.strictEqual(w.paused, false);
  assert.strictEqual(w.shop, null);
});

test('商店买的增益与武器会真的生效', () => {
  let found = null;
  for (let seed = 1; seed <= 60 && !found; seed++) {
    const w = newWorld(13000 + seed);
    const shop = w.items.find((i) => i.kind === 'shop');
    if (shop && shop.stock.some((s) => s.kind === 'buff')) found = { w, shop };
  }
  const { w, shop } = found;
  w.openShop(shop);
  const bi = w.shop.stock.findIndex((s) => s.kind === 'buff');
  const buffId = w.shop.stock[bi].id;
  const before = w.player.atk + w.player.maxHp + w.player.crit * 100 + w.player.speed + w.player.ls * 100;
  w.player.gold = 500;
  assert.strictEqual(w.buyShop(bi), true);
  const after = w.player.atk + w.player.maxHp + w.player.crit * 100 + w.player.speed + w.player.ls * 100;
  assert.notStrictEqual(after, before, `增益 ${buffId} 买完没有任何变化`);

  const wi = w.shop.stock.findIndex((s) => s.kind === 'weapon' && !s.sold);
  if (wi >= 0) {
    const wid = w.shop.stock[wi].id;
    assert.strictEqual(w.buyShop(wi), true);
    assert.ok(w.player.weapons.includes(wid), '买到的新武器应在武器栏里');
  }
});

test('站在商店上不会反复弹窗，走开再回来能重新进', () => {
  const w = newWorld(14000);
  clearAround(w, 3);
  const shop = { id: 7001, x: w.player.x, y: w.player.y, kind: 'shop', stock: w.rollShopStock() };
  w.items.push(shop);

  w.tick(0.016, idle());
  assert.ok(w.shop, '踩到商店应该打开');
  w.closeShop();

  for (let i = 0; i < 60; i++) w.tick(0.016, idle());
  assert.strictEqual(w.shop, null, '站在原地不该反复弹商店');

  w.player.x += 40;
  w.tick(0.016, idle());
  w.player.x -= 40;
  w.tick(0.016, idle());
  assert.ok(w.shop, '走开再回来应能重新进店');
});

test('隐藏房里的复活护符只有约 10%', () => {
  let secretFloors = 0;
  let withRevive = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const w = newWorld(15000 + seed);
    const f = w.map;
    if (!f.secret) continue;
    secretFloors++;
    const s = f.secret;
    // 隐藏房左下角是护符的固定刷新点
    const px = (s.x + 0.5) * TILE;
    const py = (s.y + s.h - 1 + 0.5) * TILE;
    const hit = w.items.some(
      (it) => it.kind === 'revive' && Math.abs(it.x - px) < 4 && Math.abs(it.y - py) < 4,
    );
    if (hit) withRevive++;
  }
  assert.ok(secretFloors > 120, `隐藏房样本太少：${secretFloors}`);
  const rate = withRevive / secretFloors;
  assert.ok(rate > 0.04 && rate < 0.18, `隐藏房护符刷新率应在 10% 左右，实际 ${(rate * 100).toFixed(1)}%（${withRevive}/${secretFloors}）`);
});

test('击杀怪物会掉金币', () => {
  const w = newWorld(17000);
  const before = w.items.filter((i) => i.kind === 'gold').length;
  const e = w.spawnEnemy('slime', w.player.x, w.player.y + 40);
  w.killEnemy(e);
  const after = w.items.filter((i) => i.kind === 'gold').length;
  assert.strictEqual(after, before + 1, '尸体上应多出一堆金币');
  const dropped = w.items[w.items.length - 1];
  assert.ok(dropped.amount >= 1, '掉落金额应至少为 1');
  assert.ok(Math.abs(dropped.x - e.x) < 1 && Math.abs(dropped.y - e.y) < 1, '应掉在尸体位置');
});

test('地面金币比击杀掉落少：金币主要靠杀怪', () => {
  let ground = 0;
  let kill = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const w = newWorld(17100 + seed);
    ground += w.items.filter((i) => i.kind === 'gold').reduce((a, b) => a + b.amount, 0);
    const before = w.items.filter((i) => i.kind === 'gold').reduce((a, b) => a + b.amount, 0);
    for (const e of w.enemies.slice()) w.killEnemy(e);
    kill += w.items.filter((i) => i.kind === 'gold').reduce((a, b) => a + b.amount, 0) - before;
  }
  assert.ok(ground < kill, `击杀掉落应是主要来源（地面 ${ground} vs 击杀 ${kill}）`);
});

test('疾风之石：攻击速度增益会缩短冷却', () => {
  const aspd = Engine.BUFFS.find((b) => b.id === 'aspd');
  assert.ok(aspd, 'BUFFS 里应存在攻速增益');
  assert.ok(/攻击速度/.test(aspd.desc), '描述里应写明是攻速');

  const w = newWorld(17200);
  const before = w.player.cdScale;
  aspd.apply(w.player);
  assert.ok(w.player.cdScale < before, '应用后冷却应缩短');
  assert.ok(before / w.player.cdScale < 1.15, `单件攻速加成不应过高（${(before / w.player.cdScale).toFixed(3)}x）`);
});

console.log('实时引擎测试：');
let failed = 0;
for (const [mark, name] of results) {
  if (mark === '✘') failed++;
  console.log(`  ${mark} ${name}`);
}
console.log(failed === 0 ? '全部通过 ✔' : `${failed} 项失败 ✘`);
process.exit(failed === 0 ? 0 : 1);
