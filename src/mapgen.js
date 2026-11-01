'use strict';

/* UMD：Node 走 module.exports，浏览器挂到全局 MapGen */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MapGen = factory();
})(typeof self !== 'undefined' ? self : this, function () {

const W = 64;
const H = 40;

const WALL = '#';
const FLOOR = '.';
const STAIRS = '>';
const SECRET = 'S';

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const idx = (x, y) => y * W + x;
const inBounds = (x, y) => x >= 0 && y >= 0 && x < W && y < H;

function carveRect(tiles, x, y, w, h) {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (inBounds(x + i, y + j)) tiles[idx(x + i, y + j)] = FLOOR;
    }
  }
}

function carveCorridor(tiles, x1, y1, x2, y2, rng) {
  if (rng.chance(0.5)) {
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) tiles[idx(x, y1)] = FLOOR;
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) tiles[idx(x2, y)] = FLOOR;
  } else {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) tiles[idx(x1, y)] = FLOOR;
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) tiles[idx(x, y2)] = FLOOR;
  }
}

function overlaps(a, b, pad) {
  return (
    a.x - pad < b.x + b.w &&
    a.x + a.w + pad > b.x &&
    a.y - pad < b.y + b.h &&
    a.y + a.h + pad > b.y
  );
}

function carveRooms(rng, tiles) {
  const rooms = [];
  const maxRooms = 11;

  for (let attempt = 0; attempt < 120 && rooms.length < maxRooms; attempt++) {
    const w = rng.int(5, 10);
    const h = rng.int(4, 7);
    const x = rng.int(2, W - w - 3);
    const y = rng.int(2, H - h - 3);
    const room = { x, y, w, h, cx: Math.floor(x + w / 2), cy: Math.floor(y + h / 2) };
    if (rooms.some((r) => overlaps(room, r, 2))) continue;
    rooms.push(room);
    carveRect(tiles, x, y, w, h);
  }

  // 保证连通：按顺序连接，并补两条环线
  for (let i = 1; i < rooms.length; i++) {
    carveCorridor(tiles, rooms[i - 1].cx, rooms[i - 1].cy, rooms[i].cx, rooms[i].cy, rng);
  }
  for (let k = 0; k < 2 && rooms.length > 3; k++) {
    const a = rng.pick(rooms);
    const b = rng.pick(rooms);
    if (a !== b) carveCorridor(tiles, a.cx, a.cy, b.cx, b.cy, rng);
  }
  return rooms;
}

function carveCave(rng, tiles) {
  const cells = new Array(W * H).fill(WALL);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      cells[idx(x, y)] = rng.chance(0.45) ? WALL : FLOOR;
    }
  }
  for (let iter = 0; iter < 5; iter++) {
    const next = cells.slice();
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        let walls = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (!inBounds(nx, ny) || cells[idx(nx, ny)] === WALL) walls++;
          }
        }
        // 阈值保持 5：降到 4 会让洞穴直接坍缩成 90% 实心岩，这里改用撒石块来加密
        next[idx(x, y)] = walls >= 5 ? WALL : FLOOR;
      }
    }
    for (let i = 0; i < cells.length; i++) cells[i] = next[i];
  }

  // 只保留最大连通块
  const seen = new Uint8Array(W * H);
  let best = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const start = idx(x, y);
      if (cells[start] !== FLOOR || seen[start]) continue;
      const queue = [start];
      const region = [];
      seen[start] = 1;
      for (let head = 0; head < queue.length; head++) {
        const i = queue[head];
        region.push(i);
        const cx = i % W;
        const cy = (i - cx) / W;
        for (const [dx, dy] of DIRS) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!inBounds(nx, ny)) continue;
          const j = idx(nx, ny);
          if (cells[j] === FLOOR && !seen[j]) {
            seen[j] = 1;
            queue.push(j);
          }
        }
      }
      if (region.length > best.length) best = region;
    }
  }

  const keep = new Set(best);
  for (let i = 0; i < cells.length; i++) {
    tiles[i] = keep.has(i) ? FLOOR : WALL;
  }
  if (best.length < 120) return null;
  return best;
}

/** 从起点 BFS 出距离场，返回 { dist, farthest } */
function bfsFrom(tiles, sx, sy) {
  const dist = new Int32Array(W * H).fill(-1);
  const start = idx(sx, sy);
  dist[start] = 0;
  const queue = [start];
  let farthest = start;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const x = i % W;
    const y = (i - x) / W;
    if (dist[i] > dist[farthest]) farthest = i;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const j = idx(nx, ny);
      if (tiles[j] === WALL || tiles[j] === SECRET || dist[j] !== -1) continue;
      dist[j] = dist[i] + 1;
      queue.push(j);
    }
  }
  return { dist, farthest, visited: queue };
}

/**
 * 在已有区域外挖一个独立小房间，用一格墙做入口。
 * doorType 决定它是隐藏房（裂墙，需要砍开）还是商店（普通门口，直接走进去）。
 * @param {string} doorType FLOOR = 敞开；SECRET = 裂墙
 * @param {{from?:{x,y}, minDist?:number, avoid?:{x,y}, avoidDist?:number}} [opts]
 */
function addSideRoom(rng, tiles, doorType, opts) {
  const o = opts || {};
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  const farEnough = (x, y) => {
    if (o.from && Math.abs(x - o.from.x) + Math.abs(y - o.from.y) < (o.minDist || 0)) return false;
    if (o.avoid && Math.abs(x - o.avoid.x) + Math.abs(y - o.avoid.y) < (o.avoidDist || 0)) return false;
    return true;
  };

  for (const size of [3, 2, 1]) {
    const candidates = [];

    for (let y = 2; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        if (tiles[idx(x, y)] !== FLOOR) continue;
        if (!farEnough(x, y)) continue;

        for (const [dx, dy] of dirs) {
          const wx = x + dx;
          const wy = y + dy;
          if (tiles[idx(wx, wy)] !== WALL) continue;

          const half = Math.floor(size / 2);
          let x0;
          let y0;
          if (dx === 1) {
            x0 = x + 2;
            y0 = y - half;
          } else if (dx === -1) {
            x0 = x - 1 - size;
            y0 = y - half;
          } else if (dy === 1) {
            x0 = x - half;
            y0 = y + 2;
          } else {
            x0 = x - half;
            y0 = y - 1 - size;
          }

          if (x0 - 1 < 0 || y0 - 1 < 0 || x0 + size >= W || y0 + size >= H) continue;

          let solid = true;
          for (let j = -1; j <= size && solid; j++) {
            for (let i = -1; i <= size; i++) {
              if (tiles[idx(x0 + i, y0 + j)] !== WALL) {
                solid = false;
                break;
              }
            }
          }
          if (solid) candidates.push({ x0, y0, wx, wy, size });
        }
      }
    }

    if (!candidates.length) continue;
    const c = rng.pick(candidates);
    carveRect(tiles, c.x0, c.y0, c.size, c.size);
    tiles[idx(c.wx, c.wy)] = doorType;
    return {
      x: c.x0,
      y: c.y0,
      w: c.size,
      h: c.size,
      cx: c.x0 + (c.size >> 1),
      cy: c.y0 + (c.size >> 1),
      door: { x: c.wx, y: c.wy },
    };
  }
  return null;
}

/** 从起点洪水填充，标出主连通区域。裂墙算可穿过 —— 隐藏房是合法区域，不能当孤立碎片填掉 */
function markMainRegion(tiles, start) {
  const seen = new Uint8Array(W * H);
  const s = idx(start.x, start.y);
  if (tiles[s] === WALL) return seen;
  seen[s] = 1;
  const stack = [s];
  while (stack.length) {
    const i = stack.pop();
    const x = i % W;
    const y = (i - x) / W;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const j = idx(nx, ny);
      if (seen[j]) continue;
      if (tiles[j] === WALL) continue;
      seen[j] = 1;
      stack.push(j);
    }
  }
  return seen;
}

/**
 * 洞穴层常常是一大片空地。成片撒碎石群当掩体，撒完把被围死的零碎空地封成岩体 ——
 * 既压掉空旷感，又保证所有走得通的地方都连在一起（不会有怪被困在死角）。
 */
function sprinkleRocks(rng, tiles, start, stairs) {
  const snapshot = tiles.slice();

  // 裂墙及其周围一格必须留空，否则隐藏房的唯一入口会被堵死
  const forbidden = new Set();
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (tiles[idx(x, y)] !== SECRET) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          forbidden.add(idx(x + dx, y + dy));
        }
      }
    }
  }

  const centers = [];
  for (let y = 3; y < H - 3; y++) {
    for (let x = 3; x < W - 3; x++) {
      if (tiles[idx(x, y)] !== FLOOR) continue;
      if (forbidden.has(idx(x, y))) continue;
      if (Math.abs(x - start.x) + Math.abs(y - start.y) < 8) continue;
      if (Math.abs(x - stairs.x) + Math.abs(y - stairs.y) < 5) continue;
      let open = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (tiles[idx(x + dx, y + dy)] === FLOOR) open++;
        }
      }
      if (open >= 18) centers.push({ x, y });
    }
  }

  const wanted = Math.min(44, Math.floor(centers.length / 7));
  const chosen = rng.shuffle(centers).slice(0, wanted);
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  for (const c of chosen) {
    // 从一个中心点长出一片 4~9 格的碎石
    const cluster = [{ x: c.x, y: c.y }];
    const size = rng.int(4, 9);
    for (let guard = 0; guard < 30 && cluster.length < size; guard++) {
      const base = cluster[rng.int(0, cluster.length - 1)];
      const [dx, dy] = dirs[rng.int(0, 3)];
      const nx = base.x + dx;
      const ny = base.y + dy;
      if (nx < 2 || ny < 2 || nx >= W - 2 || ny >= H - 2) continue;
      if (tiles[idx(nx, ny)] !== FLOOR) continue;
      if (forbidden.has(idx(nx, ny))) continue;
      if (cluster.some((p) => p.x === nx && p.y === ny)) continue;
      cluster.push({ x: nx, y: ny });
    }
    for (const p of cluster) tiles[idx(p.x, p.y)] = WALL;
  }

  const main = markMainRegion(tiles, start);
  if (!main[idx(stairs.x, stairs.y)]) {
    // 楼梯被围死了，整层回退
    for (let i = 0; i < tiles.length; i++) tiles[i] = snapshot[i];
    return 0;
  }
  // 被围出来的零碎空地直接填实，避免敌人躲进去出不来
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] === FLOOR && !main[i]) tiles[i] = WALL;
  }
  return chosen.length;
}

/**
 * 生成一层。
 * @returns {{tiles:string[], rooms:Array, start:{x,y}, stairs:{x,y}, secret:object|null, isCave:boolean}}
 */
function generateFloor(rng, depth) {
  // 无尽地牢：每三层有一层是洞穴（2、5、8、11…），其余是石砌房间
  const isCave = (depth - 2) % 3 === 0;
  let tiles;
  let rooms = [];
  let start;
  let stairs;
  let caveRegion = null;

  for (let giveUp = 0; giveUp < 40; giveUp++) {
    tiles = new Array(W * H).fill(WALL);
    rooms = [];
    caveRegion = null;

    if (isCave) {
      caveRegion = carveCave(rng, tiles);
      if (!caveRegion) continue;
      const s = rng.pick(caveRegion);
      start = { x: s % W, y: Math.floor(s / W) };
    } else {
      rooms = carveRooms(rng, tiles);
      if (rooms.length < 5) continue;
      start = { x: rooms[0].cx, y: rooms[0].cy };
    }

    const { dist, farthest } = bfsFrom(tiles, start.x, start.y);
    if (dist[farthest] < 18) continue;

    stairs = { x: farthest % W, y: Math.floor(farthest / W) };
    tiles[idx(stairs.x, stairs.y)] = STAIRS;

    // 先撒石块再挖特殊房间：反过来的话，碎石可能切断通往裂墙的路径，
    // 隐藏房会被后面的「孤立区域填实」整个吞掉
    if (isCave) sprinkleRocks(rng, tiles, start, stairs);
    // 商店：敞开门口的房间，每层一间，逼玩家离开出生点去找
    const shop = addSideRoom(rng, tiles, FLOOR, { from: start, minDist: 9, avoid: stairs, avoidDist: 4 });
    // 隐藏房：每层 50% 概率，入口是裂墙
    const secret = rng.chance(0.5) ? addSideRoom(rng, tiles, SECRET) : null;
    return { tiles, rooms, start, stairs, secret, shop, isCave, w: W, h: H };
  }

  // 极端情况下的兜底：一个矩形房间
  tiles = new Array(W * H).fill(WALL);
  carveRect(tiles, 4, 4, 14, 10);
  start = { x: 6, y: 6 };
  stairs = { x: 16, y: 12 };
  tiles[idx(stairs.x, stairs.y)] = STAIRS;
  return { tiles, rooms: [], start, stairs, secret: null, shop: null, isCave: false, w: W, h: H };
}

return {
  W,
  H,
  WALL,
  FLOOR,
  STAIRS,
  SECRET,
  DIRS,
  idx,
  inBounds,
  generateFloor,
  bfsFrom,
};
});
