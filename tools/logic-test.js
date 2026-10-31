'use strict';

/** 直接调用 Game 类的逻辑测试，不经过 HTTP。 */

const assert = require('assert');
const { Game } = require('../src/game');
const M = require('../src/mapgen');

function freshMeta() {
  return { crystals: 0, upgrades: { hp: 0, atk: 0 }, best: { floor: 0, kills: 0 }, runs: 0, wins: 0 };
}

function newGame(meta) {
  return new Game(meta || freshMeta(), () => {});
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

test('开局状态正常', () => {
  const g = newGame();
  g.startRun();
  assert.strictEqual(g.screen, 'playing');
  assert.strictEqual(g.depth, 1);
  assert.strictEqual(g.player.hp, g.player.maxHp);
  const s = g.getState();
  assert.strictEqual(s.tiles.length, s.mapW * s.mapH);
  assert.ok(s.enemies.length > 0);
});

test('局外升级会加初始属性', () => {
  const meta = freshMeta();
  meta.crystals = 15;
  meta.upgrades.hp = 2;
  meta.upgrades.atk = 3;
  const g = newGame(meta);
  g.startRun();
  assert.strictEqual(g.player.maxHp, 60 + 16);
  assert.strictEqual(g.player.atk, 8 + 6);
});

test('购买升级会扣晶石并增加等级', () => {
  const meta = freshMeta();
  meta.crystals = 100;
  const g = newGame(meta);
  g.upgradeMeta('hp');
  assert.strictEqual(meta.upgrades.hp, 1);
  assert.strictEqual(meta.crystals, 85);
  g.upgradeMeta('atk');
  assert.strictEqual(meta.upgrades.atk, 1);
  assert.strictEqual(meta.crystals, 70);
});

test('死亡时护符自动复活', () => {
  const g = newGame();
  g.startRun();
  g.player.revive = 1;
  g.player.hp = 1;
  g.handleDeath();
  assert.strictEqual(g.screen, 'playing');
  assert.strictEqual(g.player.revive, 0);
  assert.ok(g.player.hp > 1);
  assert.strictEqual(g.player.invuln, 3);
});

test('没有护符则死亡并记录层数', () => {
  const g = newGame();
  g.startRun();
  g.player.hp = 1;
  g.handleDeath();
  assert.strictEqual(g.screen, 'dead');
  assert.strictEqual(g.deathInfo.floor, 1);
});

test('升级后弹出三选一并能选择', () => {
  const g = newGame();
  g.startRun();
  g.player.xp = 900;
  const before = g.player.level;
  const target = g.enemies.find((e) => !e.boss);
  g.killEnemy(target);
  assert.ok(Array.isArray(g.pending), '应该有升级选项');
  assert.strictEqual(g.pending.length, 3);
  assert.ok(g.player.level > before, '等级应提升');
  let guard = 0;
  while (g.pending && guard++ < 30) g.resolveChoice(0);
  assert.strictEqual(g.pending, null);
});

test('攻击会消耗回合并造成伤害', () => {
  const g = newGame();
  g.startRun();
  const e = g.enemies.find((x) => !x.boss);
  // 把敌人挪到玩家右边一格
  e.x = g.player.x + 1;
  e.y = g.player.y;
  g.tiles[e.y * g.mapW + e.x] = M.FLOOR;
  const hpBefore = e.hp;
  g.tryAttack(1, 0);
  assert.ok(e.hp < hpBefore, '敌人应掉血');
  assert.ok(g.turn > 0);
});

test('打碎隐藏墙会变成地板', () => {
  const g = newGame();
  g.startRun();
  // 直接造一格裂墙
  let found = null;
  for (let y = 1; y < g.mapH - 1 && !found; y++) {
    for (let x = 1; x < g.mapW - 1; x++) {
      if (g.tiles[y * g.mapW + x] === M.SECRET) { found = { x, y }; break; }
    }
  }
  if (!found) return; // 测试局恰好没有隐藏房
  // 玩家站到裂墙旁边
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dy] of dirs) {
    const nx = found.x - dx;
    const ny = found.y - dy;
    if (g.isWalkable(nx, ny)) {
      g.player.x = nx;
      g.player.y = ny;
      g.tryAttack(dx, dy);
      break;
    }
  }
  assert.strictEqual(g.tileAt(found.x, found.y), M.FLOOR);
});

test('击败最终 Boss 通关并给晶石', () => {
  const meta = freshMeta();
  const g = newGame(meta);
  g.startRun();
  g.debugGoto(5);
  const boss = g.enemies.find((e) => e.type === 'overlord');
  assert.ok(boss, '第 5 层应有最终 Boss');

  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let placed = false;
  for (const [dx, dy] of dirs) {
    const nx = boss.x - dx;
    const ny = boss.y - dy;
    if (g.isWalkable(nx, ny)) {
      g.player.x = nx;
      g.player.y = ny;
      g.player.atk = 9999;
      g.player.crit = 0;
      g.tryAttack(dx, dy);
      placed = true;
      break;
    }
  }
  assert.ok(placed, '找不到可站的位置');
  assert.strictEqual(g.screen, 'won');
  assert.ok(meta.crystals >= 55, `晶石应 >= 55，实际 ${meta.crystals}`);
  assert.strictEqual(meta.wins, 1);
});

test('楼梯在层主死前锁定', () => {
  const g = newGame();
  g.startRun();
  assert.strictEqual(g.stairs.locked, true);
  const master = g.enemies.find((e) => e.type === 'master');
  g.player.atk = 9999;
  g.killEnemy(master);
  assert.strictEqual(g.stairs.locked, false);
});

test('每层 100 次生成全部连通', () => {
  const { RNG } = require('../src/rng');
  for (let depth = 1; depth <= 5; depth++) {
    for (let i = 0; i < 100; i++) {
      const f = M.generateFloor(new RNG(depth * 7919 + i), depth);
      const { dist } = M.bfsFrom(f.tiles, f.start.x, f.start.y);
      assert.ok(dist[f.stairs.y * f.w + f.stairs.x] >= 0, `深度 ${depth} 楼梯不可达`);
    }
  }
});

console.log('逻辑测试：');
let failed = 0;
for (const [mark, name] of results) {
  if (mark === '✘') failed++;
  console.log(`  ${mark} ${name}`);
}
console.log(failed === 0 ? '全部通过 ✔' : `${failed} 项失败 ✘`);
process.exit(failed === 0 ? 0 : 1);
