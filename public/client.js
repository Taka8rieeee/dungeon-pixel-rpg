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

let atlas = null;
let atlasImg = null;
let state = null;
let busy = false;
let lastOverlayKey = '';

const floaters = [];
let shake = 0;
let hurtFlash = 0;
let lastTime = 0;

/* ---------------- 启动 ---------------- */

function fit() {
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

  atlas = await fetch('/assets/atlas.json').then((r) => r.json());
  atlasImg = new Image();
  await new Promise((resolve, reject) => {
    atlasImg.onload = () => resolve();
    atlasImg.onerror = () => reject(new Error('图集加载失败'));
    atlasImg.src = '/assets/atlas.png';
    if (atlasImg.complete && atlasImg.naturalWidth > 0) resolve();
  });

  const initial = await fetch('/api/state').then((r) => r.json());
  setState(initial);
  requestAnimationFrame(loop);
}

function loop(now) {
  const dt = lastTime ? Math.min(0.05, (now - lastTime) / 1000) : 0.016;
  lastTime = now;
  updateFx(dt);
  draw();
  requestAnimationFrame(loop);
}

/* ---------------- 网络 ---------------- */

async function post(path, body) {
  if (busy) return null;
  busy = true;
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json();
    if (data && data.screen) setState(data);
    return data;
  } catch (err) {
    console.error(err);
    return null;
  } finally {
    busy = false;
  }
}

function setState(next) {
  state = next;
  if (next && Array.isArray(next.events) && next.events.length) consumeEvents(next.events);
  updateHud();
  updateOverlay();
  draw();
}

/* ---------------- 表现层：音效 / 飘字 / 震屏 ---------------- */

function consumeEvents(events) {
  for (const ev of events) handleEvent(ev);
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'swing':
      Sound.play('swing');
      break;
    case 'hit':
      Sound.play(ev.crit ? 'crit' : 'hit');
      addFloater(
        ev.x,
        ev.y,
        ev.crit ? `${ev.dmg}!` : String(ev.dmg),
        ev.crit ? '#ffd45e' : '#f4f4f8',
        ev.crit ? 16 : 11,
      );
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
      addFloater(ev.x, ev.y, `Lv.${ev.level}`, '#8fd4ff', 14);
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
    case 'summon':
      Sound.play('summon');
      kick(6);
      break;
    case 'revive':
      Sound.play('revive');
      addFloater(ev.x, ev.y, '复活', '#ffd45e', 16);
      break;
    case 'upgrade':
      Sound.play('upgrade');
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
    wx: wx + (Math.random() - 0.5) * 0.24,
    wy,
    text,
    color,
    size: size || 11,
    life: 0.95,
    max: 0.95,
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

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

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
  ctx.fillStyle = '#08080c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!state || !state.tiles || state.screen === 'title') return;
  if (!atlasImg) return;

  const p = state.player;
  const mapW = state.mapW;
  const mapH = state.mapH;
  const camX = Math.round(clamp(p.x - VIEW_W / 2 + 0.5, 0, Math.max(0, mapW - VIEW_W)));
  const camY = Math.round(clamp(p.y - VIEW_H / 2 + 0.5, 0, Math.max(0, mapH - VIEW_H)));

  ctx.save();
  if (shake > 0.4) {
    ctx.translate((Math.random() - 0.5) * shake * 1.6, (Math.random() - 0.5) * shake * 1.6);
  }

  // 地形
  for (let vy = 0; vy < VIEW_H; vy++) {
    for (let vx = 0; vx < VIEW_W; vx++) {
      const mx = camX + vx;
      const my = camY + vy;
      if (mx < 0 || my < 0 || mx >= mapW || my >= mapH) continue;
      const i = my * mapW + mx;
      const explored = state.explored[i] === '1';
      if (!explored) continue;

      const visible = state.visible[i] === '1';
      const t = state.tiles[i];
      const sx = vx * TILE;
      const sy = vy * TILE;

      if (t === '#') sprite('wall', sx, sy);
      else if (t === 'S') {
        sprite('wall', sx, sy);
        if (visible) sprite('crack', sx, sy);
      } else if (t === '>') sprite('stairs', sx, sy);
      else sprite('floor_' + (['a', 'b', 'c'][(mx * 7 + my * 13) % 3]), sx, sy);

      if (!visible) {
        ctx.fillStyle = 'rgba(4,4,8,0.75)';
        ctx.fillRect(sx, sy, TILE, TILE);
      } else {
        const dist = Math.max(Math.abs(mx - p.x), Math.abs(my - p.y));
        const a = Math.min(0.2, Math.max(0, (dist - 5) * 0.028));
        if (a > 0) {
          ctx.fillStyle = `rgba(4,4,10,${a.toFixed(3)})`;
          ctx.fillRect(sx, sy, TILE, TILE);
        }
      }
    }
  }

  const itemVisible = (x, y) => {
    if (x < 0 || y < 0 || x >= mapW || y >= mapH) return false;
    return state.visible[y * mapW + x] === '1';
  };

  // 玩家周围的暖光
  const glowX = (p.x - camX) * TILE + TILE / 2;
  const glowY = (p.y - camY) * TILE + TILE / 2;
  const glow = ctx.createRadialGradient(glowX, glowY, 6, glowX, glowY, 96);
  glow.addColorStop(0, 'rgba(255,208,140,0.09)');
  glow.addColorStop(1, 'rgba(255,208,140,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 物品
  for (const it of state.items || []) {
    if (!itemVisible(it.x, it.y)) continue;
    sprite(ITEM_SPRITE[it.kind] || 'chest', (it.x - camX) * TILE, (it.y - camY) * TILE);
  }

  // 敌人
  for (const e of state.enemies || []) {
    if (!itemVisible(e.x, e.y)) continue;
    const ex = (e.x - camX) * TILE;
    const ey = (e.y - camY) * TILE;
    sprite(ENEMY_SPRITE[e.type] || 'slime', ex, ey, e.flash ? 0.55 : 1);
    if (e.boss) {
      const ratio = Math.max(0, e.hp / e.maxHp);
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(ex + 1, ey - 4, TILE - 2, 3);
      ctx.fillStyle = '#e0455f';
      ctx.fillRect(ex + 1, ey - 4, (TILE - 2) * ratio, 3);
    }
  }

  // 玩家
  sprite('player', (p.x - camX) * TILE, (p.y - camY) * TILE);

  // 无敌护盾提示
  if (p.invuln > 0) {
    ctx.strokeStyle = 'rgba(120,190,255,0.8)';
    ctx.lineWidth = 1;
    const px = (p.x - camX) * TILE + 1;
    const py = (p.y - camY) * TILE + 1;
    ctx.strokeRect(px, py, TILE - 2, TILE - 2);
  }

  ctx.restore();

  drawFloaters(camX, camY);
  drawHurtFlash();
}

function drawFloaters(camX, camY) {
  if (!floaters.length) return;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const f of floaters) {
    const sx = (f.wx - camX) * TILE + TILE / 2;
    const t = 1 - f.life / f.max;
    const sy = (f.wy - camY) * TILE + TILE / 2 - 4 - t * 18;
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
  ctx.fillStyle = `rgba(196,32,52,${(0.2 * hurtFlash).toFixed(3)})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

/* ---------------- HUD ---------------- */

function updateHud() {
  if (!state) return;

  if (state.screen === 'title' || !state.player) {
    hudFloor.textContent = '准备出发';
    hpFill.style.width = '100%';
    hpText.textContent = '—';
    weaponLabel.textContent = '铁剑';
    potionLabel.textContent = '药水 ×1';
    goldLabel.textContent = '金币 0';
    crystalLabel.textContent = '晶石 ' + (state.meta ? state.meta.crystals : 0);
    logEl.innerHTML = '';
    statsEl.textContent = '';
    return;
  }

  const p = state.player;
  hudFloor.textContent = `第 ${state.depth} 层 / ${state.maxFloor}`;
  const ratio = clamp(p.hp / p.maxHp, 0, 1);
  hpFill.style.width = (ratio * 100).toFixed(1) + '%';
  hpText.textContent = `${p.hp} / ${p.maxHp}`;
  weaponLabel.textContent = p.weapon.name;
  potionLabel.textContent = `药水 ×${p.potion}`;
  goldLabel.textContent = `金币 ${p.gold}`;
  crystalLabel.textContent = `晶石 ${state.meta.crystals}`;

  const lines = (state.log || []).slice(-5);
  logEl.innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('');

  const crit = Math.round(p.crit * 100);
  const ls = Math.round(p.ls * 100);
  const extra = p.revive > 0 ? '  ·  护符 ×1' : '';
  statsEl.textContent =
    `攻 ${p.atk}  防 ${p.def}  暴 ${crit}%  吸血 ${ls}%  攻速 ${p.speed}%` +
    `\nLv ${p.level}  XP ${p.xp}/${p.xpNext}${extra}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 覆盖层 ---------------- */

function updateOverlay() {
  if (!state) return;

  let key = state.screen;
  if (state.meta) key += `:${state.meta.crystals}:${state.meta.upgrades.hp}:${state.meta.upgrades.atk}`;
  if (state.pending) key = 'choice:' + state.pending.map((c) => c.id).join(',');

  if (key === lastOverlayKey) return;
  lastOverlayKey = key;

  if (state.pending) {
    overlayInner.innerHTML = choiceHtml();
    overlay.classList.remove('hidden');
    return;
  }
  if (state.screen === 'title') {
    overlayInner.innerHTML = titleHtml();
    overlay.classList.remove('hidden');
    return;
  }
  if (state.screen === 'dead') {
    overlayInner.innerHTML = deadHtml();
    overlay.classList.remove('hidden');
    return;
  }
  if (state.screen === 'won') {
    overlayInner.innerHTML = winHtml();
    overlay.classList.remove('hidden');
    return;
  }
  overlay.classList.add('hidden');
}

function upgradeCard(stat, title, effect) {
  const lv = (state.meta.upgrades && state.meta.upgrades[stat]) || 0;
  const maxed = lv >= state.metaMax;
  const cost = state.metaCost[lv];
  const afford = state.meta.crystals >= cost;
  return `
    <button class="card" data-act="upgrade" data-stat="${stat}" ${maxed || !afford ? 'disabled' : ''}>
      <span class="card-name">${title}</span>
      <span class="card-lv">Lv ${lv} / ${state.metaMax}</span>
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
  const meta = state.meta;
  return `
    <div class="panel">
      <h1>地牢像素 RPG</h1>
      <p class="sub">零依赖 · 离线 · 随机地牢 · 局内肉鸽</p>
      <div class="crystal-big">晶石 <b>${meta.crystals}</b></div>
      ${upgradePanel()}
      <button class="start" data-act="start">开始冒险</button>
      <p class="hint">
        WASD 移动 · 方向键攻击 · Q 喝药 · 空格原地等待<br>
        已冒险 ${meta.runs} 次 · 通关 ${meta.wins} 次 · 最深第 ${meta.best.floor} 层
      </p>
    </div>`;
}

function choiceHtml() {
  return `
    <div class="choices">
      ${state.pending
        .map(
          (c, i) => `
        <button class="choice" data-act="choose" data-index="${i}">
          <span class="key">${i + 1}</span>
          <span class="name">${escapeHtml(c.name)}</span>
          <span class="desc">${escapeHtml(c.desc)}</span>
        </button>`,
        )
        .join('')}
    </div>`;
}

function deadHtml() {
  const d = state.deathInfo || { floor: 1, kills: 0, crystals: 0 };
  return `
    <div class="panel">
      <h2>你倒下了</h2>
      <p class="results">
        抵达第 <b>${d.floor}</b> 层 · 击杀 <b>${d.kills}</b><br>
        本局获得晶石 <span class="big-num">${d.crystals}</span>
      </p>
      <div class="crystal-big">持有晶石 <b>${state.meta.crystals}</b></div>
      ${upgradePanel()}
      <button class="start restart" data-act="start">再来一局（Enter）</button>
      <p class="hint">历史最深第 ${state.meta.best.floor} 层 · 最多击杀 ${state.meta.best.kills}</p>
    </div>`;
}

function winHtml() {
  const w = state.winInfo || { crystals: 0 };
  return `
    <div class="panel">
      <h2 style="color:#ffd45e">通关！</h2>
      <p class="results">
        你击败了地牢之主。<br>
        本局获得晶石 <span class="big-num">${w.crystals}</span>
      </p>
      <div class="crystal-big">持有晶石 <b>${state.meta.crystals}</b></div>
      ${upgradePanel()}
      <button class="start restart" data-act="start">再来一局（Enter）</button>
    </div>`;
}

overlay.addEventListener('click', (ev) => {
  Sound.unlock();
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'start') post('/api/start');
  else if (act === 'upgrade') post('/api/upgrade', { stat: btn.dataset.stat });
  else if (act === 'choose') post('/api/choose', { index: Number(btn.dataset.index) });
});

/* ---------------- 输入 ---------------- */

const MOVE_KEYS = {
  w: [0, -1],
  a: [-1, 0],
  s: [0, 1],
  d: [1, 0],
};

const ATTACK_KEYS = {
  ArrowUp: [0, -1],
  ArrowLeft: [-1, 0],
  ArrowDown: [0, 1],
  ArrowRight: [1, 0],
};

document.addEventListener('keydown', (ev) => {
  if (ev.isComposing) return;
  if (ev.key.startsWith('Arrow') || ev.key === ' ') ev.preventDefault();
  Sound.unlock();
  if (!state) return;

  if (state.pending) {
    if (ev.key >= '1' && ev.key <= '3') {
      post('/api/choose', { index: Number(ev.key) - 1 });
    }
    return;
  }

  if (state.screen !== 'playing') {
    if (ev.key === 'Enter' || ev.key === ' ') post('/api/start');
    return;
  }

  if (ev.repeat) return;
  const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;

  if (MOVE_KEYS[k]) {
    post('/api/action', { action: { type: 'move', dx: MOVE_KEYS[k][0], dy: MOVE_KEYS[k][1] } });
  } else if (ATTACK_KEYS[ev.key]) {
    post('/api/action', { action: { type: 'attack', dx: ATTACK_KEYS[ev.key][0], dy: ATTACK_KEYS[ev.key][1] } });
  } else if (k === 'q') {
    post('/api/action', { action: { type: 'potion' } });
  } else if (k === 'm') {
    Sound.toggle();
  } else if (ev.key === ' ') {
    post('/api/action', { action: { type: 'wait' } });
  }
});

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = '<pre style="color:#f88;padding:2em">加载失败，请查看控制台。\n' + escapeHtml(err && err.message) + '</pre>';
});
