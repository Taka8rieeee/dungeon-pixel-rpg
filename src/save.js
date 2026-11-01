'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SAVE_PATH = path.join(DATA_DIR, 'meta.json');
const BACKUP_PATH = path.join(DATA_DIR, 'meta.bak.json');

function defaultMeta() {
  return {
    crystals: 0,
    upgrades: { hp: 0, atk: 0 },
    best: { floor: 0, kills: 0 },
    runs: 0,
    wins: 0,
  };
}

function normalize(raw) {
  const base = defaultMeta();
  if (!raw || typeof raw !== 'object') return base;
  return {
    crystals: Math.max(0, Math.floor(Number(raw.crystals) || 0)),
    upgrades: {
      hp: clampLevel(raw.upgrades && raw.upgrades.hp),
      atk: clampLevel(raw.upgrades && raw.upgrades.atk),
    },
    best: {
      floor: Math.max(0, Math.floor(Number(raw.best && raw.best.floor) || 0)),
      kills: Math.max(0, Math.floor(Number(raw.best && raw.best.kills) || 0)),
    },
    runs: Math.max(0, Math.floor(Number(raw.runs) || 0)),
    wins: Math.max(0, Math.floor(Number(raw.wins) || 0)),
  };
}

function clampLevel(v) {
  const n = Math.floor(Number(v) || 0);
  return Math.max(0, Math.min(5, n));
}

function loadMeta() {
  try {
    const raw = JSON.parse(fs.readFileSync(SAVE_PATH, 'utf8'));
    return normalize(raw);
  } catch (err) {
    return defaultMeta();
  }
}

function saveMeta(meta) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const json = JSON.stringify(meta, null, 2);
  const tmp = SAVE_PATH + '.tmp';
  fs.writeFileSync(tmp, json, 'utf8');
  try {
    if (fs.existsSync(SAVE_PATH)) fs.copyFileSync(SAVE_PATH, BACKUP_PATH);
  } catch (err) {
    /* 备份失败不影响主存档 */
  }
  fs.renameSync(tmp, SAVE_PATH);
}

function resetMeta(meta) {
  Object.assign(meta, defaultMeta());
  saveMeta(meta);
  return meta;
}

module.exports = { defaultMeta, loadMeta, saveMeta, resetMeta, normalize };
