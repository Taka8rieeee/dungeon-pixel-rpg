'use strict';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

const TILE = 16;
const VIEW_W = canvas.width / TILE;
const VIEW_H = canvas.height / TILE;

const stage = document.getElementById('stage');
const overlay = document.getElementById('overlay');
const overlayInner = document.getElementById('overlayInner');
const hudFloor = document.getElementById('floorLabel');
const hpFill = document.getElementById('hpFill');
const hpText = document.getElementById('hpText');
const weaponLabel = document.getElementById('weaponLabel');
const potionLabel = document.getElementById('potionLabel');
const goldLabel = document.getElementById('goldLabel');
const crystalLabel = document.getElementById('crystalLabel');
const logEl = document.getElementById('log');
const statsEl = document.getElementById('stats');
const minimap = document.getElementById('minimap');
const mctx = minimap.getContext('2d');

let atlas = null;
let atlasImg = null;
let world = null;
let lastOverlayKey = '';
let lastTime = 0;
let saveTimer = 0;
let mmTimer = 0;
const MM_SCALE = 2;

const keys = { up: false, down: false, left: false, right: false };
const mouse = { sx: canvas.width / 2, sy: canvas.height / 2, wx: 0, wy: 0, down: false };
const cam = { x: 0, y: 0 };

const floaters = [];
let shake = 0;
let hurtFlash = 0;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------------- 启动 ---------------- */

function fit() {
  if (document.body.classList.contains('touch')) {
    // 触屏设备用小数缩放铺满屏幕（整数缩放在手机上会留大片黑边）
    const s = Math.min(
      (window.innerWidth - 6) / canvas.width,
      (window.innerHeight - 6) / canvas.height,
    );
    stage.style.width = canvas.width * s + 'px';
    stage.style.height = canvas.height * s + 'px';
    stage.style.setProperty('--s', String(s));
    return;
  }
  const scale = Math.max(
    1,
    Math.min(
      Math.floor((window.innerWidth - 32) / canvas.width),
      Math.floor((window.innerHeight - 32) / canvas.height),
    ),
  );
  stage.style.width = canvas.width * scale + 'px';
  stage.style.height = canvas.height * scale + 'px';
  stage.style.setProperty('--s', String(scale));
}

async function boot() {
  fit();
  window.addEventListener('resize', fit);
  setupTouch();

  atlas = await fetch('/assets/atlas.json').then((r) => r.json());
  atlasImg = new Image();
  await new Promise((resolve, reject) => {
    atlasImg.onload = () => resolve();
    atlasImg.onerror = () => reject(new Error('图集加载失败'));
    atlasImg.src = '/assets/atlas.png';
    if (atlasImg.complete && atlasImg.naturalWidth > 0) resolve();
  });

  const meta = await loadMeta();
  world = new Engine.World(meta);
  requestAnimationFrame(loop);
}

/** 手机版没有本地服务器接口，存档降级到 localStorage */
const IS_NATIVE_APP = !!window.Capacitor;
const META_KEY = 'dungeon-pixel-rpg-meta';
const FALLBACK_META = { crystals: 0, upgrades: { hp: 0, atk: 0 }, best: { floor: 0, kills: 0 }, runs: 0, wins: 0 };

async function loadMeta() {
  if (IS_NATIVE_APP) {
    try {
      return JSON.parse(localStorage.getItem(META_KEY) || 'null') || { ...FALLBACK_META };
    } catch (err) {
      return { ...FALLBACK_META };
    }
  }
  return fetch('/api/meta').then((r) => r.json());
}

let reportedError = '';

function reportError(err) {
  console.error(err);
  const text = (err && (err.stack || err.message)) || String(err);
  if (reportedError === text) return;
  reportedError = text;
  const box = document.getElementById('crash');
  if (box) {
    box.textContent = '运行出错（已记录到控制台，游戏会继续尝试运行）\n' + (err && err.message);
    box.classList.remove('hidden');
  }
}

function loop(now) {
  const dt = lastTime ? Math.min(0.05, (now - lastTime) / 1000) : 0.016;
  lastTime = now;

  try {
    if (world) {
      // 自愈：升级暂停却没弹出选项时，强制恢复，避免永久卡住
      if (world.paused && !world.pending && !world.shop && !world.restPrompt) {
        world.paused = false;
        world.pendingLevels = 0;
      }
      if (NET.on) {
        // 联机：世界由服务器模拟，本地只上报输入 + 自己算视野
        netSendInput(dt);
        NET.fovTimer -= dt;
        if (NET.fovTimer <= 0 && world.player && world.tiles) {
          NET.fovTimer = 0.1;
          world.updateFov();
        }
      } else if (world.screen === 'playing' && !world.paused) {
        world.tick(dt, buildInput());
      }
      const evs = world.drainEvents();
      if (evs.length) consumeEvents(evs);
      if (world.screen !== 'playing') {
        saveTimer -= dt;
        if (saveTimer <= 0) {
          saveTimer = 3;
          persistMeta();
        }
      }
    }

    updateFx(dt);
    updateCamera(dt);
    draw();
    updateHud();
    updateOverlay();

    // 小地图不用每帧重画，0.15 秒一次足够跟手
    mmTimer -= dt;
    if (mmTimer <= 0) {
      mmTimer = 0.15;
      drawMinimap();
    }
  } catch (err) {
    reportError(err);
  }

  requestAnimationFrame(loop);
}

/* ---------------- 输入 ---------------- */

const KEY_MAP = {
  w: 'up',
  a: 'left',
  s: 'down',
  d: 'right',
  arrowup: 'up',
  arrowleft: 'left',
  arrowdown: 'down',
  arrowright: 'right',
};

document.addEventListener('keydown', (ev) => {
  if (ev.isComposing) return;
  Sound.unlock();
  const k = ev.key.toLowerCase();
  if (k.startsWith('arrow') || k === ' ') ev.preventDefault();

  if (world && world.restPrompt) {
    if (k === 'enter' || k === ' ' || k === 'y') {
      if (!netAct('continue')) world.continueRun();
    } else if (k === 'escape' || k === 'n') {
      if (!netAct('retire')) world.endRun();
    }
    return;
  }

  if (world && world.shop) {
    if (k === 'escape') {
      if (!netAct('closeShop')) world.closeShop();
      return;
    }
    if (k >= '1' && k <= '9') {
      if (!netAct('buy', { i: Number(k) - 1 })) world.buyShop(Number(k) - 1);
    }
    return;
  }

  if (world && world.pending) {
    if (k === 'escape') {
      if (!netAct('skip')) world.skipPending();
      return;
    }
    if (k >= '1' && k <= '9') {
      if (!netAct('choose', { i: Number(k) - 1 })) world.resolveChoice(Number(k) - 1);
    }
    return;
  }

  if (world && world.screen !== 'playing') {
    if (k === 'enter' || k === ' ') startRun();
    return;
  }

  if (KEY_MAP[k]) {
    keys[KEY_MAP[k]] = true;
    return;
  }
  if (k >= '1' && k <= '9') {
    if (!netAct('switch', { i: Number(k) - 1 })) world.switchWeapon(Number(k) - 1);
    return;
  }
  if (k === 'q') {
    if (!netAct('potion')) world.usePotion();
  } else if (k === 'e') {
    if (!netAct('pick')) world.pickupWeaponNearby();
  } else if (k === 'm') Sound.toggle();
});

canvas.addEventListener(
  'wheel',
  (ev) => {
    if (!world || world.screen !== 'playing' || world.pending) return;
    ev.preventDefault();
    const step = ev.deltaY > 0 ? 1 : -1;
    if (!netAct('cycle', { i: step })) world.cycleWeapon(step);
  },
  { passive: false },
);

document.addEventListener('keyup', (ev) => {
  const k = ev.key.toLowerCase();
  if (KEY_MAP[k]) keys[KEY_MAP[k]] = false;
});

function pointerPos(ev) {
  const rect = canvas.getBoundingClientRect();
  return {
    sx: ((ev.clientX - rect.left) / rect.width) * canvas.width,
    sy: ((ev.clientY - rect.top) / rect.height) * canvas.height,
  };
}

canvas.addEventListener('mousemove', (ev) => {
  const p = pointerPos(ev);
  mouse.sx = p.sx;
  mouse.sy = p.sy;
});

canvas.addEventListener('mousedown', (ev) => {
  if (ev.button === 0) {
    mouse.down = true;
    Sound.unlock();
  }
});

window.addEventListener('mouseup', (ev) => {
  if (ev.button === 0) mouse.down = false;
});

canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

window.addEventListener('blur', () => {
  keys.up = keys.down = keys.left = keys.right = false;
  mouse.down = false;
});

function buildInput() {
  mouse.wx = cam.x + mouse.sx;
  mouse.wy = cam.y + mouse.sy;
  let up = keys.up;
  let down = keys.down;
  let left = keys.left;
  let right = keys.right;
  let firing = mouse.down;
  let aimX = mouse.wx;
  let aimY = mouse.wy;

  // 触屏：左摇杆给 8 方向布尔，右摇杆接管瞄准与开火
  const mv = touchInput.move;
  if (Math.hypot(mv.dx, mv.dy) > 0.26) {
    if (mv.dy < -0.42) up = true;
    if (mv.dy > 0.42) down = true;
    if (mv.dx < -0.42) left = true;
    if (mv.dx > 0.42) right = true;
  }
  if (touchInput.aimActive) {
    aimX = touchInput.aimX;
    aimY = touchInput.aimY;
    firing = Math.hypot(touchInput.aim.dx, touchInput.aim.dy) > 0.34;
  }

  return { up, down, left, right, firing, aimX, aimY };
}

/* ---------------- 触屏：双摇杆 + 功能按钮 ---------------- */

const touchInput = {
  move: { id: null, dx: 0, dy: 0 },
  aim: { id: null, dx: 0, dy: 0 },
  aimActive: false, // 一旦摸过瞄准摇杆就接管瞄准，不再用鼠标位置
  aimX: 0,
  aimY: 0,
};

function setupTouch() {
  const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  if (!coarse && !('ontouchstart' in window)) return;
  document.body.classList.add('touch');

  const makeStick = (cls) => {
    const base = document.createElement('div');
    base.className = 'stick ' + cls;
    const nub = document.createElement('div');
    nub.className = 'nub';
    base.appendChild(nub);
    stage.appendChild(base);
    return { base, nub };
  };
  const moveStick = makeStick('stick-move');
  const aimStick = makeStick('stick-aim');

  const R = 44; // 摇杆最大行程（CSS 像素）

  const bindStick = (stick, state, isAim) => {
    let cx = 0;
    let cy = 0;
    const apply = (t) => {
      let dx = t.clientX - cx;
      let dy = t.clientY - cy;
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, d / R);
      dx = (dx / d) * k;
      dy = (dy / d) * k;
      state.dx = dx;
      state.dy = dy;
      stick.nub.style.transform = `translate(${(dx * R).toFixed(1)}px, ${(dy * R).toFixed(1)}px)`;
      if (isAim && k > 0.3) {
        touchInput.aimActive = true;
        touchInput.aimX = world.player.x + dx * 150;
        touchInput.aimY = world.player.y + dy * 150;
      }
    };
    stick.base.addEventListener(
      'touchstart',
      (ev) => {
        ev.preventDefault();
        Sound.unlock();
        const t = ev.changedTouches[0];
        state.id = t.identifier;
        const r = stick.base.getBoundingClientRect();
        cx = r.left + r.width / 2;
        cy = r.top + r.height / 2;
        apply(t);
      },
      { passive: false },
    );
    stick.base.addEventListener(
      'touchmove',
      (ev) => {
        ev.preventDefault();
        for (const t of ev.changedTouches) if (t.identifier === state.id) apply(t);
      },
      { passive: false },
    );
    const end = (ev) => {
      for (const t of ev.changedTouches) {
        if (t.identifier !== state.id) continue;
        state.id = null;
        state.dx = 0;
        state.dy = 0;
        stick.nub.style.transform = 'translate(0, 0)';
      }
    };
    stick.base.addEventListener('touchend', end);
    stick.base.addEventListener('touchcancel', end);
  };

  bindStick(moveStick, touchInput.move, false);
  bindStick(aimStick, touchInput.aim, true);

  const mkBtn = (label, fn) => {
    const b = document.createElement('button');
    b.className = 'touch-btn';
    b.textContent = label;
    b.addEventListener(
      'touchstart',
      (ev) => {
        ev.preventDefault();
        Sound.unlock();
        if (world && world.screen === 'playing' && !world.paused) fn();
      },
      { passive: false },
    );
    stage.appendChild(b);
    return b;
  };

  // 功能按钮绕右摇杆外侧排成弧线（正上 / 左上 / 正左）。
  // 偏移不写死：按摇杆与按钮的实际渲染尺寸计算，任何屏幕都刚好贴着外圈。
  const btns = [
    mkBtn('药', () => world.usePotion()),
    mkBtn('换', () => world.cycleWeapon(1)),
    mkBtn('捡', () => world.pickupWeaponNearby()),
  ];
  const placeButtons = () => {
    const r = aimStick.base.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const gap = 14; // 与摇杆边缘的间隙（圆边到圆边）
    const br = btns[0].getBoundingClientRect().width / 2;
    const dist = r.width / 2 + br + gap;
    const angles = [90, 135, 180]; // 度：正上 / 左上 / 正左
    btns.forEach((b, i) => {
      const a = (angles[i] * Math.PI) / 180;
      const bx = cx + Math.cos(a) * dist;
      const by = cy - Math.sin(a) * dist;
      b.style.left = `${(bx - br).toFixed(1)}px`;
      b.style.top = `${(by - br).toFixed(1)}px`;
      b.style.right = 'auto';
      b.style.bottom = 'auto';
    });
  };
  placeButtons();
  window.addEventListener('resize', placeButtons);
  window.addEventListener('orientationchange', () => setTimeout(placeButtons, 120));
}

/* ---------------- 相机 ---------------- */

function updateCamera(dt) {
  if (!world || !world.map || !world.player) return;
  const p = world.player;
  const maxX = Math.max(0, world.mapW * TILE - canvas.width);
  const maxY = Math.max(0, world.mapH * TILE - canvas.height);
  const tx = clamp(p.x - canvas.width / 2, 0, maxX);
  const ty = clamp(p.y - canvas.height / 2, 0, maxY);
  const k = Math.min(1, dt * 14);
  cam.x += (tx - cam.x) * k;
  cam.y += (ty - cam.y) * k;
}

/* ---------------- 表现层 ---------------- */

function consumeEvents(events) {
  for (const ev of events) handleEvent(ev);
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'swing':
      Sound.play('swing');
      break;
    case 'whiff':
      break;
    case 'hit':
      Sound.play(ev.crit ? 'crit' : 'hit');
      addFloater(ev.x, ev.y, ev.crit ? `${ev.dmg}!` : String(ev.dmg), ev.crit ? '#ffd45e' : '#f4f4f8', ev.crit ? 16 : 11);
      if (ev.crit) kick(7);
      break;
    case 'kill':
      Sound.play(ev.boss || ev.final ? 'bossDown' : 'kill');
      break;
    case 'playerHit':
      Sound.play('hurt');
      addFloater(ev.x, ev.y, `-${ev.dmg}`, '#ff6b6b', 14);
      kick(Math.min(9, 3 + ev.dmg * 0.25));
      hurtFlash = 1;
      break;
    case 'heal':
      Sound.play('heal');
      addFloater(ev.x, ev.y, `+${ev.amount}`, '#7ee08a', 13);
      break;
    case 'levelup':
      Sound.play('levelup');
      addFloater(world.player.x, world.player.y, `Lv.${ev.level}`, '#8fd4ff', 14);
      break;
    case 'buy':
      Sound.play('buy');
      addFloater(world.player.x, world.player.y, `-${ev.price}`, '#ffd45e', 12);
      break;
    case 'pickup':
      Sound.playPickup(ev.kind);
      if (ev.kind === 'gold') addFloater(ev.x, ev.y, `+${ev.amount}`, '#ffd45e', 11);
      else if (ev.kind === 'potion') addFloater(ev.x, ev.y, '药水', '#8fd4ff', 11);
      else if (ev.kind === 'revive') addFloater(ev.x, ev.y, '护符', '#ff9ad5', 12);
      else if (ev.kind === 'chest') addFloater(ev.x, ev.y, '换武器', '#c9a7ff', 11);
      break;
    case 'stairs':
      Sound.play('stairs');
      break;
    case 'secret':
      Sound.play('secret');
      addFloater(ev.x, ev.y, '裂墙！', '#c9a7ff', 12);
      kick(5);
      break;
    case 'impact':
      Sound.play('hit');
      break;
    case 'summon':
      Sound.play('summon');
      kick(6);
      break;
    case 'bossDown':
      Sound.play('bossDown');
      kick(8);
      break;
    case 'boom':
      Sound.play('boom');
      addFloater(ev.x, ev.y, '轰！', '#ffb15e', 13);
      kick(8);
      break;
    case 'evade':
      addFloater(ev.x, ev.y, '闪', '#9be7ff', 10);
      break;
    case 'revive':
      Sound.play('revive');
      addFloater(ev.x, ev.y, '复活', '#ffd45e', 16);
      break;
    case 'upgrade':
      Sound.play('upgrade');
      break;
    case 'swap':
      Sound.play('swap');
      break;
    case 'combo':
      Sound.play('crit');
      addFloater(ev.x, ev.y, '爆发', '#ffd45e', 15);
      kick(6);
      break;
    case 'win':
      Sound.play('win');
      break;
    case 'dead':
      Sound.play('dead');
      kick(8);
      break;
    default:
      break;
  }
}

function addFloater(wx, wy, text, color, size) {
  if (typeof wx !== 'number' || typeof wy !== 'number') return;
  floaters.push({
    wx: wx + (Math.random() - 0.5) * 6,
    wy,
    text,
    color,
    size: size || 11,
    life: 0.9,
    max: 0.9,
  });
  if (floaters.length > 40) floaters.shift();
}

function kick(power) {
  shake = Math.max(shake, power);
}

function updateFx(dt) {
  if (shake > 0) shake = Math.max(0, shake - dt * 55);
  if (hurtFlash > 0) hurtFlash = Math.max(0, hurtFlash - dt * 2.6);
  for (let i = floaters.length - 1; i >= 0; i--) {
    floaters[i].life -= dt;
    if (floaters[i].life <= 0) floaters.splice(i, 1);
  }
}

/* ---------------- 绘制 ---------------- */

function sprite(name, sx, sy, alpha = 1) {
  const frame = atlas && atlas.frames[name];
  if (!frame) return;
  if (alpha !== 1) ctx.globalAlpha = alpha;
  ctx.drawImage(atlasImg, frame[0] * TILE, frame[1] * TILE, TILE, TILE, sx, sy, TILE, TILE);
  if (alpha !== 1) ctx.globalAlpha = 1;
}

const ENEMY_SPRITE = {
  slime: 'slime',
  rat: 'rat',
  archer: 'archer',
  brute: 'brute',
  wraith: 'wraith',
  golem: 'golem',
  bomber: 'bomber',
  master: 'boss',
  overlord: 'boss',
};

const ITEM_SPRITE = {
  gold: 'gold',
  potion: 'potion',
  chest: 'chest',
  revive: 'heart',
};

function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#08080c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!world || world.screen === 'title' || !world.tiles || !atlasImg) return;
  // 联机刚收到地图、还没收到第一帧快照时还没有玩家实体，这一帧直接跳过
  if (!world.player) return;

  const w = world;
  const p = w.player;

  ctx.save();
  if (shake > 0.4) {
    ctx.translate((Math.random() - 0.5) * shake * 1.6, (Math.random() - 0.5) * shake * 1.6);
  }

  const baseX = Math.floor(cam.x / TILE);
  const baseY = Math.floor(cam.y / TILE);
  const offX = -(cam.x - baseX * TILE);
  const offY = -(cam.y - baseY * TILE);

  for (let vy = 0; vy <= VIEW_H; vy++) {
    for (let vx = 0; vx <= VIEW_W; vx++) {
      const tx = baseX + vx;
      const ty = baseY + vy;
      if (tx < 0 || ty < 0 || tx >= w.mapW || ty >= w.mapH) continue;
      const i = ty * w.mapW + tx;
      if (!w.explored[i]) continue;

      const vis = w.visible[i] === 1;
      const t = w.tiles[i];
      const sx = vx * TILE + offX;
      const sy = vy * TILE + offY;

      if (t === '#') sprite('wall', sx, sy);
      else if (t === 'S') {
        sprite('wall', sx, sy);
        if (vis) sprite('crack', sx, sy);
      } else if (t === '>') sprite('stairs', sx, sy);
      else sprite('floor_' + (['a', 'b', 'c'][(tx * 7 + ty * 13) % 3]), sx, sy);

      // 探索过的地形永久照亮：只跳过未探索的格子，不再压暗影
    }
  }

  const visibleAt = (x, y) => {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= w.mapW || ty >= w.mapH) return false;
    return w.visible[ty * w.mapW + tx] === 1;
  };

  const glowX = p.x - cam.x;
  const glowY = p.y - cam.y;
  const glow = ctx.createRadialGradient(glowX, glowY, 8, glowX, glowY, 110);
  glow.addColorStop(0, 'rgba(255,208,140,0.09)');
  glow.addColorStop(1, 'rgba(255,208,140,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const it of w.items) {
    if (!visibleAt(it.x, it.y)) continue;
    const ix = it.x - cam.x - TILE / 2;
    const iy = it.y - cam.y - TILE / 2;

    if (it.kind === 'weapon') {
      // 地上的武器：宝箱图标 + 蓝色标记 + 名字首字，和普通宝箱区分开
      sprite('chest', ix, iy);
      ctx.fillStyle = 'rgba(120,200,255,0.9)';
      ctx.fillRect(ix + 2, iy + TILE - 3, TILE - 4, 2);
      const wn = Engine.WEAPONS[it.weaponId] ? Engine.WEAPONS[it.weaponId].name : '?';
      ctx.font = 'bold 9px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(wn.slice(0, 1), ix + TILE / 2, iy - 4);
      ctx.fillStyle = '#8fd4ff';
      ctx.fillText(wn.slice(0, 1), ix + TILE / 2, iy - 4);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      continue;
    }

    if (it.kind === 'shop') {
      // 商店柜台：宝箱图标 + 金色底边 + 「商」字，和普通宝箱一眼分清
      sprite('chest', ix, iy);
      ctx.fillStyle = 'rgba(255,206,84,0.95)';
      ctx.fillRect(ix + 1, iy + TILE - 3, TILE - 2, 2);
      ctx.font = 'bold 9px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText('商', ix + TILE / 2, iy - 4);
      ctx.fillStyle = '#ffd45e';
      ctx.fillText('商', ix + TILE / 2, iy - 4);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      continue;
    }

    sprite(ITEM_SPRITE[it.kind] || 'chest', ix, iy);
  }

  for (const e of w.enemies) {
    if (e.dead || !visibleAt(e.x, e.y)) continue;
    const ex = e.x - cam.x - TILE / 2;
    const ey = e.y - cam.y - TILE / 2;
    sprite(ENEMY_SPRITE[e.type] || 'slime', ex, ey, e.flash > 0 ? 0.5 : 1);
    if (e.boss) {
      const ratio = Math.max(0, e.hp / e.maxHp);
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(ex + 1, ey - 5, TILE - 2, 3);
      ctx.fillStyle = '#e0455f';
      ctx.fillRect(ex + 1, ey - 5, (TILE - 2) * ratio, 3);
    }
  }

  for (const pr of w.projectiles) {
    const sx = pr.x - cam.x;
    const sy = pr.y - cam.y;
    if (pr.from === 'player') {
      const n = Math.hypot(pr.vx, pr.vy) || 1;
      ctx.strokeStyle = '#ffe9b0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx - (pr.vx / n) * 7, sy - (pr.vy / n) * 7);
      ctx.stroke();
    } else if (pr.splash) {
      // 炸弹：黑色圆球外面一圈跳动的火花，和邪术师的紫色暗影弹区分开
      ctx.fillStyle = '#1c2026';
      ctx.beginPath();
      ctx.arc(sx, sy, pr.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(255,159,60,${0.6 + 0.4 * Math.sin(world.t * 22)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx, sy, pr.r + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = '#b06bff';
      ctx.beginPath();
      ctx.arc(sx, sy, pr.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (const s of w.slashes) {
    const alpha = Math.max(0, s.life / s.max) * 0.5;
    const sx = s.x - cam.x;
    const sy = s.y - cam.y;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.arc(sx, sy, s.reach, s.aim - s.arc / 2, s.aim + s.arc / 2);
    ctx.closePath();
    ctx.fillStyle = `rgba(255,244,214,${alpha.toFixed(3)})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(255,255,255,${(alpha * 0.9).toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 炸弹爆炸：向外扩开的橙色火环
  for (const b of w.blasts || []) {
    const k = 1 - b.life / b.max;
    const rad = b.r * (0.45 + 0.55 * k);
    const alpha = Math.max(0, 1 - k) * 0.7;
    ctx.beginPath();
    ctx.arc(b.x - cam.x, b.y - cam.y, rad, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,160,60,${(alpha * 0.45).toFixed(3)})`;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(255,214,120,${alpha.toFixed(3)})`;
    ctx.stroke();
  }

  if (p) {
    const psx = p.x - cam.x - TILE / 2;
    const psy = p.y - cam.y - TILE / 2;
    if (p.invuln > 0 && Math.floor(w.t * 20) % 2 === 0) ctx.globalAlpha = 0.5;
    sprite('player', psx, psy);
    ctx.globalAlpha = 1;

    ctx.strokeStyle = 'rgba(255,220,160,0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.x - cam.x + Math.cos(p.aim) * 6, p.y - cam.y + Math.sin(p.aim) * 6);
    ctx.lineTo(p.x - cam.x + Math.cos(p.aim) * 13, p.y - cam.y + Math.sin(p.aim) * 13);
    ctx.stroke();

    if (p.invuln > 0) {
      ctx.strokeStyle = 'rgba(120,190,255,0.7)';
      ctx.lineWidth = 1;
      ctx.strokeRect(psx + 1, psy + 1, TILE - 2, TILE - 2);
    }
  }

  // 联机：队友用同一张贴图，加名字标签区分
  if (NET.on && w.players && w.players.length > 1) {
    for (const mate of w.players) {
      if (!mate || mate === p || !mate.alive) continue;
      const mx = mate.x - cam.x - TILE / 2;
      const my = mate.y - cam.y - TILE / 2;
      ctx.globalAlpha = mate.hitFlash > 0 ? 0.5 : 0.92;
      sprite('player', mx, my);
      ctx.globalAlpha = 1;
      ctx.font = '8px "Microsoft YaHei", monospace';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(mate.name || '队友', mx + TILE / 2, my - 3);
      ctx.fillStyle = '#9fe8ff';
      ctx.fillText(mate.name || '队友', mx + TILE / 2, my - 3);
      ctx.textAlign = 'left';
    }
  }

  ctx.restore();

  drawFloaters();
  drawHurtFlash();
  drawCrosshair();
  drawWeaponHint();
}

/** 脚下有掉落的武器时，给个「按 E 拾取」的提示 */
function drawWeaponHint() {
  const w = world;
  if (!w || w.screen !== 'playing' || !w.player) return;
  const p = w.player;
  let near = null;
  for (const it of w.items) {
    if (it.kind !== 'weapon') continue;
    if (Math.hypot(it.x - p.x, it.y - p.y) < 30) {
      near = it;
      break;
    }
  }
  if (!near) return;

  const name = Engine.WEAPONS[near.weaponId] ? Engine.WEAPONS[near.weaponId].name : '武器';
  const text = `E  拾起「${name}」`;
  ctx.font = 'bold 11px ui-monospace, Consolas, monospace';
  const boxW = ctx.measureText(text).width + 22;
  const bx = canvas.width / 2 - boxW / 2;
  const by = canvas.height - 46;
  ctx.fillStyle = 'rgba(8,10,16,0.8)';
  ctx.fillRect(bx, by, boxW, 20);
  ctx.strokeStyle = 'rgba(120,200,255,0.55)';
  ctx.lineWidth = 1;
  ctx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, 19);
  ctx.fillStyle = '#b8e2ff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, by + 11);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawFloaters() {
  if (!floaters.length) return;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const f of floaters) {
    const sx = f.wx - cam.x;
    const t = 1 - f.life / f.max;
    const sy = f.wy - cam.y - 6 - t * 18;
    const alpha = f.life > f.max * 0.65 ? 1 : f.life / (f.max * 0.65);
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.font = `bold ${f.size}px ui-monospace, Consolas, monospace`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(f.text, sx, sy);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, sx, sy);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawHurtFlash() {
  if (hurtFlash <= 0) return;
  ctx.fillStyle = `rgba(196,32,52,${(0.15 * hurtFlash).toFixed(3)})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawCrosshair() {
  if (!world || world.screen !== 'playing') return;
  ctx.strokeStyle = 'rgba(255,240,200,0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(mouse.sx - 5, mouse.sy);
  ctx.lineTo(mouse.sx + 5, mouse.sy);
  ctx.moveTo(mouse.sx, mouse.sy - 5);
  ctx.lineTo(mouse.sx, mouse.sy + 5);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(mouse.sx, mouse.sy, 9, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,240,200,0.25)';
  ctx.stroke();
}

/* ---------------- HUD ---------------- */

function updateHud() {
  if (!world) return;

  if (world.screen === 'title' || !world.player) {
    hudFloor.textContent = '准备出发';
    hpFill.style.width = '100%';
    hpText.textContent = '—';
    weaponLabel.textContent = '铁剑';
    potionLabel.textContent = '药水 ×1';
    goldLabel.textContent = '金币 0';
    crystalLabel.textContent = '晶石 ' + (world.meta ? world.meta.crystals : 0);
    logEl.innerHTML = '';
    statsEl.textContent = '';
    return;
  }

  const p = world.player;
  hudFloor.textContent = `第 ${world.depth} 层`;
  const ratio = clamp(p.hp / p.maxHp, 0, 1);
  hpFill.style.width = (ratio * 100).toFixed(1) + '%';
  hpText.textContent = `${Math.max(0, Math.round(p.hp))} / ${p.maxHp}`;
  weaponLabel.textContent = `${p.weapon.name} ${p.weaponIndex + 1}/${p.weapons.length}`;
  potionLabel.textContent = `药水 ×${p.potion}`;
  goldLabel.textContent = `金币 ${p.gold}`;
  crystalLabel.textContent = `晶石 ${world.meta.crystals}`;

  const lines = (world.log || []).slice(-5);
  logEl.innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('');

  const crit = Math.round(p.crit * 100);
  const ls = Math.round(p.ls * 100);
  const aspd = (1 / Math.max(0.05, p.cdScale)).toFixed(2);
  const extra = p.revive > 0 ? '  护符 ×1' : '';
  const wlist = p.weapons.map((id) => Engine.WEAPONS[id].name).join(' · ');
  statsEl.textContent =
    `攻 ${p.atk}  防 ${p.def}  暴 ${crit}%  速 ${aspd}x  吸血 ${ls}%${extra}` +
    `\nLv ${p.level}  XP ${p.xp}/${p.xpNext}  敌人 ${world.enemies.filter((e) => !e.dead).length}` +
    `\n${wlist}`;
}

/* ---------------- 小地图 ---------------- */

/** 把已探索的地形画进右上角的小地图；楼梯、商店、视野内的敌人也标出来 */
function drawMinimap() {
  if (!world || !world.tiles || world.screen === 'title') {
    minimap.width = 0;
    return;
  }
  const w = world.mapW;
  const h = world.mapH;
  const pw = w * MM_SCALE;
  const ph = h * MM_SCALE;
  if (minimap.width !== pw || minimap.height !== ph) {
    minimap.width = pw;
    minimap.height = ph;
  }

  mctx.fillStyle = 'rgba(6, 7, 12, 0.85)';
  mctx.fillRect(0, 0, pw, ph);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!world.explored[i]) continue;
      const t = world.tiles[i];
      let color = '#252b3d'; // 地板
      if (t === '#') color = '#454a5e'; // 墙
      else if (t === 'S') color = '#7a6aa8'; // 未开的裂墙
      else if (t === '>') color = '#ffd45e'; // 楼梯
      mctx.fillStyle = color;
      mctx.fillRect(x * MM_SCALE, y * MM_SCALE, MM_SCALE, MM_SCALE);
    }
  }

  // 商店与宝箱这类重要物品，探索到就常亮
  for (const it of world.items) {
    const tx = Math.floor(it.x / 16);
    const ty = Math.floor(it.y / 16);
    if (!world.explored[ty * w + tx]) continue;
    if (it.kind === 'shop') mctx.fillStyle = '#ffd45e';
    else if (it.kind === 'chest') mctx.fillStyle = '#c9a7ff';
    else continue;
    mctx.fillRect(tx * MM_SCALE - 1, ty * MM_SCALE - 1, MM_SCALE + 2, MM_SCALE + 2);
  }

  // 只标当前视野内的敌人，不然等于开全图挂
  const vis = (x, y) => {
    const tx = Math.floor(x / 16);
    const ty = Math.floor(y / 16);
    if (tx < 0 || ty < 0 || tx >= w || ty >= h) return false;
    return world.visible[ty * w + tx] === 1;
  };
  mctx.fillStyle = '#ff5a5a';
  for (const e of world.enemies) {
    if (e.dead) continue;
    if (!vis(e.x, e.y)) continue;
    mctx.fillRect(Math.floor(e.x / 16) * MM_SCALE - 1, Math.floor(e.y / 16) * MM_SCALE - 1, MM_SCALE + 2, MM_SCALE + 2);
  }

  // 玩家
  const p = world.player;
  if (!p) return;
  mctx.fillStyle = '#ffffff';
  mctx.fillRect(Math.floor(p.x / 16) * MM_SCALE - 1, Math.floor(p.y / 16) * MM_SCALE - 1, MM_SCALE + 2, MM_SCALE + 2);
}

/** 联机：输名字后连服务器 */
function startNet() {
  if (!world) return;
  const name = (prompt('你的名字（最多 8 个字）', '勇者') || '').trim().slice(0, 8);
  if (!name) return;
  connectNet(name);
  world.addLog('正在连接服务器…');
  lastOverlayKey = '';
}

/* ---------------- 联机 ---------------- */

const NET = {
  on: false,
  ws: null,
  id: 0,
  name: '',
  me: null,
  sendTimer: 0,
  fovTimer: 0,
};

function netLog(msg) {
  if (!world) return;
  world.addLog(msg);
}

function connectNet(name) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws`;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    alert('联机连接失败：' + err.message);
    return;
  }
  NET.ws = ws;
  NET.name = name;

  ws.onopen = () => {
    ws.send(JSON.stringify({ t: 'join', name }));
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (err) {
      return;
    }
    handleNet(msg);
  };

  ws.onclose = () => {
    NET.on = false;
    NET.ws = null;
    if (world) {
      world.paused = true;
      world.screen = 'title';
      netLog('与服务器断开连接。');
    }
    lastOverlayKey = '';
  };

  ws.onerror = () => {
    netLog('联机出错，请检查服务器是否在运行。');
  };
}

function handleNet(msg) {
  if (msg.t === 'welcome') {
    NET.id = msg.id;
    NET.on = true;
    if (world) {
      world.screen = 'playing';
      world.paused = false;
      netLog(`已加入房间（${msg.name}）。`);
    }
    lastOverlayKey = '';
    return;
  }
  if (msg.t === 'map') {
    applyNetMap(msg);
    lastOverlayKey = '';
    return;
  }
  if (msg.t === 'snap') {
    applyNetSnap(msg);
    return;
  }
  if (msg.t === 'evt') {
    consumeEvents(msg.list || []);
    return;
  }
  if (msg.t === 'sys') {
    netLog(msg.msg);
  }
}

/** 服务器发来的整层地图 */
function applyNetMap(msg) {
  const w = world;
  w.mapW = msg.w;
  w.mapH = msg.h;
  w.tiles = msg.tiles.split('');
  w.map = { tiles: w.tiles, w: msg.w, h: msg.h };
  w.explored = new Uint8Array(w.mapW * w.mapH);
  w.visible = new Uint8Array(w.mapW * w.mapH);
  w.depth = msg.depth;
  w.stairs = msg.stairs;
  w.enemies = [];
  w.items = [];
  w.projectiles = [];
  w.slashes = [];
  w.blasts = [];
  // 快照还没到之前保留本地那个 player 对象，避免渲染层拿到 undefined
  const keepPlayer = w.player;
  w.players = keepPlayer ? [keepPlayer] : [];
  w.player = keepPlayer;
  w.paused = false;
  w.screen = 'playing';
  floaters.length = 0;
}

/** 每帧的世界快照 */
function applyNetSnap(msg) {
  const w = world;
  w.depth = msg.depth;
  w.screen = msg.screen;
  w.paused = msg.paused;
  w.stairs = msg.stairs;
  w.restPrompt = msg.restPrompt;
  w.pending = msg.pending;
  w.pendingKind = msg.pending ? 'levelup' : null;
  w.pendingSkip = msg.pendingSkip;
  w.shop = msg.shop;

  // 玩家：按索引复用对象，避免每帧新建
  msg.players.forEach((sp, i) => {
    let p = w.players[i];
    if (!p) {
      p = w.makePlayer();
      w.players[i] = p;
    }
    p.x = sp.x;
    p.y = sp.y;
    p.hp = sp.hp;
    p.maxHp = sp.maxHp;
    p.aim = sp.aim;
    p.alive = sp.alive;
    p.name = sp.name;
    p.level = sp.level;
    p.hitFlash = sp.flash ? 0.2 : 0;
    p.moving = sp.moving;
    p.invuln = 0;
  });
  w.players.length = msg.players.length;
  w.player = w.players[NET.id] || w.players[0];
  NET.me = msg.me || null;
  if (msg.me && w.player) {
    const keep = { x: w.player.x, y: w.player.y, aim: w.player.aim, name: w.player.name };
    Object.assign(w.player, msg.me, keep);
    w.player.weapon = Engine.WEAPONS[msg.me.weapon] || w.player.weapon;
  }

  w.enemies = msg.enemies.map((e, i) => ({
    id: i,
    x: e.x,
    y: e.y,
    type: e.type,
    hp: e.hp,
    maxHp: e.maxHp,
    flash: e.flash ? 0.2 : 0,
    boss: e.boss,
    dead: false,
    r: 6,
  }));

  w.items = msg.items.map((it, i) => ({ id: i, x: it.x, y: it.y, kind: it.kind, amount: it.amount }));
  w.projectiles = msg.projectiles;
  w.slashes = msg.slashes.map((s) => ({ ...s, life: 0.13, max: 0.13 }));
  w.blasts = msg.blasts.map((b) => ({ ...b, life: 0.3, max: 0.3 }));
  if (msg.log && msg.log.length) w.log = msg.log;
}

/** 联机时把输入按 20Hz 发给服务器 */
function netSendInput(dt) {
  if (!NET.on || !NET.ws || NET.ws.readyState !== 1) return;
  NET.sendTimer -= dt;
  if (NET.sendTimer > 0) return;
  NET.sendTimer = 0.05;
  const input = buildInput();
  NET.ws.send(
    JSON.stringify({
      t: 'input',
      up: input.up,
      down: input.down,
      left: input.left,
      right: input.right,
      firing: input.firing,
      aimX: Math.round(input.aimX),
      aimY: Math.round(input.aimY),
    }),
  );
}

/** 联机操作统一走服务器 */
function netAct(a, extra) {
  if (!NET.on || !NET.ws || NET.ws.readyState !== 1) return false;
  NET.ws.send(JSON.stringify({ t: 'act', a, ...(extra || {}) }));
  return true;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 覆盖层 ---------------- */

function updateOverlay() {
  if (!world) return;

  // 每到第 3 层问一次：继续深入还是收手
  if (world.restPrompt) {
    const rk = 'rest:' + world.restPrompt.next;
    if (rk !== lastOverlayKey) {
      lastOverlayKey = rk;
      overlayInner.innerHTML = restHtml();
    }
    overlay.classList.remove('hidden');
    return;
  }

  // 商店：可以连续购买，所以不靠「选一个就关」，单独一条显示线
  if (world.shop) {
    const gold = world.player.gold;
    const sk = 'shop:' + world.shop.stock.map((s) => (s.sold ? '1' : '0')).join('') + ':' + gold;
    if (sk !== lastOverlayKey) {
      lastOverlayKey = sk;
      overlayInner.innerHTML = shopHtml();
    }
    overlay.classList.remove('hidden');
    return;
  }

  // 升级选择优先，且每次都确保遮罩处于可见状态（不能靠 key 缓存决定是否显示）
  if (world.pending) {
    const ck = 'choice:' + world.pendingKind + ':' + (world.pendingSkip ? 'skip:' : '') + world.pending.map((c) => c.id).join(',');
    if (ck !== lastOverlayKey) {
      lastOverlayKey = ck;
      overlayInner.innerHTML = choiceHtml();
    }
    overlay.classList.remove('hidden');
    return;
  }

  let key = world.screen;
  if (world.meta) key += `:${world.meta.crystals}:${world.meta.upgrades.hp}:${world.meta.upgrades.atk}`;

  if (key === lastOverlayKey) return;
  lastOverlayKey = key;
  if (world.screen === 'title') {
    overlayInner.innerHTML = titleHtml();
    overlay.classList.remove('hidden');
    return;
  }
  if (world.screen === 'dead') {
    overlayInner.innerHTML = deadHtml();
    overlay.classList.remove('hidden');
    return;
  }
  overlay.classList.add('hidden');
}

function upgradeCard(stat, title, effect) {
  const meta = world.meta;
  const lv = (meta.upgrades && meta.upgrades[stat]) || 0;
  const maxed = lv >= Engine.META_MAX;
  const cost = Engine.META_COST[lv];
  const afford = meta.crystals >= cost;
  return `
    <button class="card" data-act="upgrade" data-stat="${stat}" ${maxed || !afford ? 'disabled' : ''}>
      <span class="card-name">${title}</span>
      <span class="card-lv">Lv ${lv} / ${Engine.META_MAX}</span>
      <span class="card-desc">${effect}</span>
      <span class="card-cost">${maxed ? '已满级' : cost + ' 晶石'}</span>
    </button>`;
}

function upgradePanel() {
  return `
    <div class="upgrades">
      ${upgradeCard('hp', '生命上限', '每级 +8 初始生命')}
      ${upgradeCard('atk', '攻击力', '每级 +2 初始攻击')}
    </div>`;
}

function titleHtml() {
  const meta = world.meta;
  return `
    <div class="panel">
      <h1>地牢像素 RPG</h1>
      <p class="sub">零依赖 · 离线 · 实时动作 · 随机地牢</p>
      <div class="crystal-big">晶石 <b>${meta.crystals}</b></div>
      ${upgradePanel()}
      <div class="rest-actions">
        <button class="start" data-act="start">单机冒险</button>
        <button class="start ghost" data-act="net">联机同屏</button>
      </div>
      <p class="hint">
        WASD 移动 · 鼠标瞄准 · 按住左键攻击 · Q 喝药 · M 静音<br>
        已冒险 ${meta.runs} 次 · 最深抵达第 ${meta.best.floor || 0} 层<br>
        联机：最多 4 人进同一座地牢，共享地图与掉落
      </p>
    </div>`;
}

function choiceHtml() {
  const kind = world.pendingKind;
  const title =
    kind === 'starter' ? '选择开局武器' : kind === 'chest' ? '宝箱：带走一样' : '升级！三选一';
  const sub =
    kind === 'chest'
      ? world.pendingSkip
        ? '全是武器。都不想要的话就留着，箱子不会消失'
        : '武器或增益，只能带走一样'
      : '';
  return `
    <div class="choice-panel">
      <div class="choice-title">${title}</div>
      ${sub ? `<div class="choice-sub">${sub}</div>` : ''}
      <div class="choices">
        ${world.pending
          .map(
            (c, i) => `
          <button class="choice" data-act="choose" data-index="${i}">
            <span class="key">${i + 1}</span>
            <span class="name">${escapeHtml(c.name)}</span>
            <span class="desc">${escapeHtml(c.desc)}</span>
          </button>`,
          )
          .join('')}
      </div>
      ${
        world.pendingSkip
          ? `<button class="choice-skip" data-act="skip">都不想要（Esc）</button>
             <div class="choice-hint">关掉界面，箱子留在原地，走开再回来还能开</div>`
          : ''
      }
    </div>`;
}

function shopHtml() {
  const p = world.player;
  const stock = world.shop.stock;
  const rows = stock
    .map((it, i) => {
      const owned = it.kind === 'weapon' && p.weapons.includes(it.id);
      const soldOut = it.sold || owned;
      const afford = p.gold >= it.price;
      const price = soldOut ? '已售出' : `${it.price} 金币`;
      const cls = soldOut ? 'sold' : afford ? '' : 'poor';
      return `
        <button class="shop-row ${cls}" data-act="buy" data-index="${i}" ${soldOut || !afford ? 'disabled' : ''}>
          <span class="key">${i + 1}</span>
          <span class="shop-main">
            <span class="shop-name">${escapeHtml(it.name)}</span>
            <span class="shop-desc">${escapeHtml(it.desc)}</span>
          </span>
          <span class="shop-price">${price}</span>
        </button>`;
    })
    .join('');

  return `
    <div class="choice-panel">
      <div class="choice-title">商店</div>
      <div class="shop-gold">金币 <b>${p.gold}</b>${p.revive > 0 ? ' · 已持有生命护符' : ''}</div>
      <div class="shop-list">${rows}</div>
      <button class="choice-skip" data-act="leave">离开（Esc）</button>
      <div class="choice-hint">买完可以继续挑，走出门口就关门</div>
    </div>`;
}

function deadHtml() {
  const d = world.deathInfo || { floor: 1, kills: 0, crystals: 0 };
  return `
    <div class="panel">
      <h2>你倒下了</h2>
      <p class="results">
        抵达第 <b>${d.floor}</b> 层 · 击杀 <b>${d.kills}</b><br>
        本局获得晶石 <span class="big-num">${d.crystals}</span>
      </p>
      <div class="crystal-big">持有晶石 <b>${world.meta.crystals}</b></div>
      ${upgradePanel()}
      <button class="start restart" data-act="start">再来一局（Enter）</button>
      <p class="hint">历史最深第 ${world.meta.best.floor} 层 · 最多击杀 ${world.meta.best.kills}</p>
    </div>`;
}

function restHtml() {
  const r = world.restPrompt;
  const s = world.runStats || { kills: 0, gold: 0, crystals: 0 };
  return `
    <div class="panel">
      <h2>第 ${r.reached} 层已清</h2>
      <p class="results">
        楼梯下面还是黑的，看不到底。<br>
        现在收手，晶石带走；再往下，就没有回头路了。
      </p>
      <p class="results">
        本局：击杀 <b>${s.kills}</b> · 金币 <b>${s.gold}</b> · 晶石 <span class="big-num">${s.crystals}</span>
      </p>
      <div class="rest-actions">
        <button class="start" data-act="continue">继续深入（Enter）</button>
        <button class="start ghost" data-act="retire">就此收手（Esc）</button>
      </div>
      <p class="hint">历史最深第 ${world.meta.best.floor || 0} 层</p>
    </div>`;
}

overlay.addEventListener('click', (ev) => {
  Sound.unlock();
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'start') startRun();
  else if (act === 'net') startNet();
  else if (act === 'upgrade') buyUpgrade(btn.dataset.stat);
  else if (act === 'choose') {
    if (!netAct('choose', { i: Number(btn.dataset.index) })) world.resolveChoice(Number(btn.dataset.index));
  }
  else if (act === 'skip') {
    if (!netAct('skip')) world.skipPending();
  }
  else if (act === 'buy') {
    if (!netAct('buy', { i: Number(btn.dataset.index) })) world.buyShop(Number(btn.dataset.index));
  }
  else if (act === 'continue') world.continueRun();
  else if (act === 'retire') world.endRun();
  else if (act === 'leave') world.closeShop();
});

/* ---------------- 流程 ---------------- */

function startRun() {
  lastOverlayKey = '';
  world.startRun();
  const p = world.player;
  cam.x = clamp(p.x - canvas.width / 2, 0, Math.max(0, world.mapW * TILE - canvas.width));
  cam.y = clamp(p.y - canvas.height / 2, 0, Math.max(0, world.mapH * TILE - canvas.height));
  floaters.length = 0;
  shake = 0;
  hurtFlash = 0;
}

async function buyUpgrade(stat) {
  if (!world.upgradeMeta(stat)) return;
  lastOverlayKey = '';
  await persistMeta();
}

async function persistMeta() {
  if (!world) return;
  if (IS_NATIVE_APP) {
    try {
      localStorage.setItem(META_KEY, JSON.stringify(world.meta));
    } catch (err) {
      /* 存满就算了 */
    }
    return;
  }
  try {
    await fetch('/api/meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(world.meta),
    });
  } catch (err) {
    /* 存档失败不影响游戏 */
  }
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML =
    '<pre style="color:#f88;padding:2em">加载失败，请查看控制台。\n' + escapeHtml(err && err.message) + '</pre>';
});
