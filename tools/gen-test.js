'use strict';

/** 地图生成压力测试：每层生成 200 次，检查连通性与关键点。 */

const { RNG } = require('../src/rng');
const M = require('../src/mapgen');

const RUNS = Number(process.argv[2]) || 200;
let failures = 0;
const stats = {};

for (let depth = 1; depth <= 5; depth++) {
  let secretCount = 0;
  let minDist = Infinity;
  let maxDist = 0;
  let roomMin = Infinity;
  let roomMax = 0;

  for (let i = 0; i < RUNS; i++) {
    const rng = new RNG(depth * 100000 + i);
    const f = M.generateFloor(rng, depth);

    const startChar = f.tiles[f.start.y * f.w + f.start.x];
    const stairChar = f.tiles[f.stairs.y * f.w + f.stairs.x];

    if (startChar !== M.FLOOR) { console.error(`深度 ${depth} 起点不是地板: ${startChar}`); failures++; }
    if (stairChar !== M.STAIRS) { console.error(`深度 ${depth} 楼梯异常: ${stairChar}`); failures++; }

    const { dist } = M.bfsFrom(f.tiles, f.start.x, f.start.y);
    const d = dist[f.stairs.y * f.w + f.stairs.x];
    if (d < 0) { console.error(`深度 ${depth} 楼梯不可达`); failures++; }
    else { minDist = Math.min(minDist, d); maxDist = Math.max(maxDist, d); }

    // 楼梯不能被藏在墙里
    if (startChar === M.SECRET) { console.error(`深度 ${depth} 起点在隐藏墙`); failures++; }

    if (f.secret) {
      secretCount++;
      const cx = f.secret.cx;
      const cy = f.secret.cy;
      if (f.tiles[cy * f.w + cx] !== M.FLOOR) { console.error(`深度 ${depth} 隐藏房中心不是地板`); failures++; }
    }

    const floorTiles = f.tiles.filter((t) => t === M.FLOOR || t === M.STAIRS).length;
    if (floorTiles < 120) { console.error(`深度 ${depth} 可走区域过小: ${floorTiles}`); failures++; }

    roomMin = Math.min(roomMin, f.rooms.length);
    roomMax = Math.max(roomMax, f.rooms.length);
  }

  stats[depth] = {
    secret: `${secretCount}/${RUNS}`,
    stairsDist: `${minDist}–${maxDist}`,
    rooms: `${roomMin}–${roomMax}`,
  };
}

console.log('每层生成结果：');
for (const [depth, s] of Object.entries(stats)) {
  console.log(`  第 ${depth} 层：隐藏房 ${s.secret}，起点→楼梯 ${s.stairsDist}，房间数 ${s.rooms}`);
}
console.log(failures === 0 ? '全部通过 ✔' : `发现 ${failures} 个问题 ✘`);
process.exit(failures === 0 ? 0 : 1);
