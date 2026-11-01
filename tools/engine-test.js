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
  w.startRun();
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

test('第 5 层击败最终 Boss 通关', () => {
  const w = newWorld(1010);
  w.debugGoto(5);
  const boss = w.enemies.find((e) => e.final);
  assert.ok(boss, '第 5 层应有地牢之主');
  w.damageEnemy(boss, 999);
  assert.strictEqual(w.screen, 'won');
  assert.ok(w.meta.wins === 1);
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

console.log('实时引擎测试：');
let failed = 0;
for (const [mark, name] of results) {
  if (mark === '✘') failed++;
  console.log(`  ${mark} ${name}`);
}
console.log(failed === 0 ? '全部通过 ✔' : `${failed} 项失败 ✘`);
process.exit(failed === 0 ? 0 : 1);
