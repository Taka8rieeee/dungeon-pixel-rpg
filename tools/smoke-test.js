'use strict';

/**
 * 冒烟测试 / 简易 AI 试玩。
 * 用法：node tools/smoke-test.js [最大回合] [端口] [随机种子]
 */

const MAX_TURNS = Number(process.argv[2]) || 3000;
const port = Number(process.argv[3]) || 4321;
const base = `http://localhost:${port}`;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (data.error) throw new Error(`${path}: ${data.error}`);
  return data;
}

function walkable(ch) {
  return ch === '.' || ch === '>';
}

function bfs(s, sx, sy) {
  const w = s.mapW;
  const h = s.mapH;
  const dist = new Int16Array(w * h).fill(-1);
  const start = sy * w + sx;
  if (!walkable(s.tiles[start])) return dist;
  dist[start] = 0;
  const q = [start];
  for (let head = 0; head < q.length; head++) {
    const i = q[head];
    const x = i % w;
    const y = (i - x) / w;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (dist[j] !== -1 || !walkable(s.tiles[j])) continue;
      dist[j] = dist[i] + 1;
      q.push(j);
    }
  }
  return dist;
}

function stepToward(s, dist, tx, ty) {
  const w = s.mapW;
  const cur = dist[s.player.y * w + s.player.x];
  if (cur < 0) return null;
  let best = null;
  let bestD = cur;
  for (const [dx, dy] of DIRS) {
    const nx = s.player.x + dx;
    const ny = s.player.y + dy;
    if (nx < 0 || ny < 0 || nx >= s.mapW || ny >= s.mapH) continue;
    const j = ny * w + nx;
    if (dist[j] < 0 || dist[j] >= bestD) continue;
    if (s.enemies.some((e) => e.x === nx && e.y === ny)) continue;
    bestD = dist[j];
    best = { dx, dy };
  }
  return best;
}

function visible(s, x, y) {
  return s.visible[y * s.mapW + x] === '1';
}

function chooseAction(s) {
  const p = s.player;

  if (p.hp / p.maxHp < 0.55 && p.potion > 0) return { type: 'potion' };

  const adjacent = s.enemies.find(
    (e) => visible(s, e.x, e.y) && Math.abs(e.x - p.x) + Math.abs(e.y - p.y) === 1,
  );
  if (adjacent) {
    return { type: 'attack', dx: Math.sign(adjacent.x - p.x), dy: Math.sign(adjacent.y - p.y) };
  }

  const visibleEnemies = s.enemies.filter((e) => visible(s, e.x, e.y));
  let target = null;
  if (visibleEnemies.length) {
    const dist = bfs(s, p.x, p.y);
    let best = Infinity;
    for (const e of visibleEnemies) {
      const d = dist[e.y * s.mapW + e.x];
      if (d >= 0 && d < best) {
        best = d;
        target = { x: e.x, y: e.y };
      }
    }
  }

  if (!target) {
    if (!s.stairs.locked) target = { x: s.stairs.x, y: s.stairs.y };
    else {
      const dist = bfs(s, p.x, p.y);
      let best = Infinity;
      for (const it of s.items) {
        if (!visible(s, it.x, it.y)) continue;
        const d = dist[it.y * s.mapW + it.x];
        if (d >= 0 && d < best) {
          best = d;
          target = { x: it.x, y: it.y };
        }
      }
    }
  }

  if (!target) {
    // 探索：走向最近的可达未探索格
    const dist = bfs(s, s.player.x, s.player.y);
    let best = Infinity;
    for (let y = 1; y < s.mapH - 1; y++) {
      for (let x = 1; x < s.mapW - 1; x++) {
        const i = y * s.mapW + x;
        if (s.explored[i] !== '0') continue;
        if (!walkable(s.tiles[i])) continue;
        if (dist[i] < 0 || dist[i] >= best) continue;
        best = dist[i];
        target = { x, y };
      }
    }
  }

  if (!target && s.stairs.locked) target = { x: s.stairs.x, y: s.stairs.y };

  if (!target) {
    const [dx, dy] = DIRS[Math.floor(Math.random() * 4)];
    return { type: 'move', dx, dy };
  }

  const dist = bfs(s, target.x, target.y);
  const step = stepToward(s, dist, target.x, target.y);
  if (step) return { type: 'move', dx: step.dx, dy: step.dy };
  return { type: 'wait' };
}

function validate(s) {
  if (!s.player) return;
  const p = s.player;
  const problems = [];
  if (p.hp < 0) problems.push('生命为负');
  if (p.hp > p.maxHp) problems.push('生命超过上限');
  if (s.tiles.length !== s.mapW * s.mapH) problems.push('地图长度不符');
  if (s.enemies.some((e) => e.x < 0 || e.y < 0 || e.x >= s.mapW || e.y >= s.mapH)) problems.push('敌人越界');
  if (s.visible[s.player.y * s.mapW + s.player.x] !== '1') problems.push('玩家所在格不可见');
  if (problems.length) throw new Error('状态异常: ' + problems.join(' / '));
}

(async () => {
  let s = await post('/api/start');
  validate(s);
  const log = [];
  let guard = 0;
  let potions = 0;

  while (s.screen === 'playing' && guard++ < MAX_TURNS) {
    if (s.pending) {
      s = await post('/api/choose', { index: 0 });
      continue;
    }
    const action = chooseAction(s);
    if (action.type === 'potion') potions++;
    const before = { depth: s.depth, logLen: s.log.length };
    s = await post('/api/action', { action });
    validate(s);
    if (s.depth !== before.depth) log.push(`到达第 ${s.depth} 层（回合 ${s.turn}，生命 ${s.player.hp}/${s.player.maxHp}）`);
    if (s.screen === 'dead' || s.screen === 'won') break;
  }

  console.log('==== AI 试玩结果 ====');
  console.log(`结果: ${s.screen}  回合: ${s.turn}  层数: ${s.depth}`);
  console.log(`生命 ${s.player.hp}/${s.player.maxHp}  等级 ${s.player.level}  攻击 ${s.player.atk}  武器 ${s.player.weapon.name}`);
  console.log(`击杀 ${s.runStats ? s.runStats.kills : '?'}  金币 ${s.player.gold}  晶石 ${s.meta.crystals}  喝药 ${potions}`);
  log.forEach((l) => console.log('  ' + l));
  console.log('最后日志:');
  (s.log || []).slice(-6).forEach((l) => console.log('  ' + l));
})().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
