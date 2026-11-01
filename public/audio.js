'use strict';

/**
 * 零素材音效：全部用 WebAudio 的振荡器与噪声实时合成，不加载任何音频文件。
 * 浏览器要求用户先有一次交互才允许出声，所以 AudioContext 延迟到首次按键/点击时创建。
 * 任何音效异常都必须被吞掉，绝不能影响游戏本身。
 */
const Sound = (() => {
  let actx = null;
  let out = null;
  let muted = false;
  const lastAt = Object.create(null);

  function ensure() {
    if (muted) return null;
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      actx = new AC();
      const comp = actx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 12;
      comp.ratio.value = 8;
      comp.attack.value = 0.003;
      comp.release.value = 0.12;
      out = actx.createGain();
      out.gain.value = 0.32;
      out.connect(comp);
      comp.connect(actx.destination);
    }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }

  /** 单音：从 from 滑到 to，指数包络 */
  function tone(o) {
    const ac = ensure();
    if (!ac) return;
    const t0 = ac.currentTime + (o.delay || 0);
    const dur = o.dur || 0.12;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = o.wave || 'square';
    osc.frequency.setValueAtTime(o.from, t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t0 + dur);
    const peak = o.gain === undefined ? 0.28 : o.gain;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + (o.attack || 0.006));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(out);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  /** 噪声：默认带通扫频，用来做挥砍、碎裂、打击这类“空气感” */
  function noise(o) {
    const ac = ensure();
    if (!ac) return;
    const t0 = ac.currentTime + (o.delay || 0);
    const dur = o.dur || 0.1;
    const len = Math.max(1, Math.floor(ac.sampleRate * dur));
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    const decay = o.decay || 1.6;
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    const src = ac.createBufferSource();
    src.buffer = buf;
    const flt = ac.createBiquadFilter();
    flt.type = o.filter || 'bandpass';
    flt.frequency.setValueAtTime(o.from || 1400, t0);
    if (o.to) flt.frequency.exponentialRampToValueAtTime(Math.max(60, o.to), t0 + dur);
    flt.Q.value = o.q === undefined ? 1.2 : o.q;
    const g = ac.createGain();
    g.gain.setValueAtTime(o.gain === undefined ? 0.26 : o.gain, t0);
    g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    src.connect(flt);
    flt.connect(g);
    g.connect(out);
    src.start(t0);
    src.stop(t0 + dur + 0.03);
  }

  const RECIPES = {
    swing() {
      noise({ from: 2600, to: 700, dur: 0.085, gain: 0.15, q: 0.9 });
    },
    hit() {
      noise({ from: 1100, to: 280, dur: 0.09, gain: 0.28, filter: 'lowpass', decay: 2.2 });
      tone({ from: 170, to: 110, dur: 0.07, gain: 0.16, wave: 'square' });
    },
    crit() {
      noise({ from: 3200, to: 700, dur: 0.14, gain: 0.3, q: 0.8, decay: 1.8 });
      tone({ from: 420, to: 980, dur: 0.13, gain: 0.2, wave: 'sawtooth' });
      tone({ from: 880, to: 1320, dur: 0.1, gain: 0.1, wave: 'square', delay: 0.03 });
    },
    hurt() {
      tone({ from: 240, to: 80, dur: 0.2, gain: 0.24, wave: 'sawtooth' });
      noise({ from: 700, to: 160, dur: 0.16, gain: 0.14, filter: 'lowpass', decay: 2 });
    },
    kill() {
      noise({ from: 900, to: 120, dur: 0.22, gain: 0.26, filter: 'lowpass', decay: 2.6 });
      tone({ from: 150, to: 55, dur: 0.24, gain: 0.18, wave: 'triangle' });
    },
    pickupGold() {
      tone({ from: 990, dur: 0.07, gain: 0.15, wave: 'sine' });
      tone({ from: 1480, dur: 0.1, gain: 0.12, wave: 'sine', delay: 0.05 });
    },
    pickupPotion() {
      tone({ from: 620, to: 940, dur: 0.12, gain: 0.15, wave: 'sine' });
    },
    pickupChest() {
      [523, 659, 784].forEach((f, i) => tone({ from: f, dur: 0.1, gain: 0.13, wave: 'triangle', delay: i * 0.06 }));
    },
    pickupRevive() {
      [440, 554, 659].forEach((f, i) => tone({ from: f, dur: 0.28, gain: 0.12, wave: 'sine', delay: i * 0.05 }));
    },
    buy() {
      noise({ from: 2400, to: 900, dur: 0.06, gain: 0.1, filter: 'highpass' });
      tone({ from: 1180, dur: 0.07, gain: 0.13, wave: 'sine' });
      tone({ from: 784, dur: 0.14, gain: 0.1, wave: 'triangle', delay: 0.06 });
    },
    levelup() {
      [523, 659, 784, 1047].forEach((f, i) => tone({ from: f, dur: 0.16, gain: 0.14, wave: 'triangle', delay: i * 0.075 }));
    },
    heal() {
      tone({ from: 330, to: 660, dur: 0.26, gain: 0.14, wave: 'sine' });
      tone({ from: 495, to: 990, dur: 0.22, gain: 0.06, wave: 'sine', delay: 0.04 });
    },
    stairs() {
      tone({ from: 330, to: 150, dur: 0.34, gain: 0.15, wave: 'triangle' });
      noise({ from: 500, to: 180, dur: 0.28, gain: 0.09, filter: 'lowpass' });
    },
    secret() {
      noise({ from: 1800, to: 300, dur: 0.28, gain: 0.24, filter: 'lowpass', decay: 2.4 });
      tone({ from: 120, to: 60, dur: 0.3, gain: 0.15, wave: 'triangle' });
    },
    summon() {
      tone({ from: 90, to: 38, dur: 0.6, gain: 0.22, wave: 'sawtooth' });
      noise({ from: 400, to: 90, dur: 0.5, gain: 0.12, filter: 'lowpass', decay: 1.4 });
    },
    revive() {
      [262, 330, 392, 523].forEach((f, i) => tone({ from: f, dur: 0.5, gain: 0.11, wave: 'sine', delay: i * 0.06 }));
    },
    win() {
      [523, 659, 784, 1047].forEach((f, i) => tone({ from: f, dur: 0.5, gain: 0.13, wave: 'triangle', delay: i * 0.11 }));
      tone({ from: 1568, dur: 0.7, gain: 0.07, wave: 'sine', delay: 0.44 });
    },
    dead() {
      tone({ from: 300, to: 70, dur: 0.7, gain: 0.2, wave: 'sawtooth' });
      tone({ from: 150, to: 60, dur: 0.9, gain: 0.11, wave: 'triangle', delay: 0.08 });
    },
    upgrade() {
      tone({ from: 660, dur: 0.1, gain: 0.13, wave: 'triangle' });
      tone({ from: 990, dur: 0.18, gain: 0.12, wave: 'triangle', delay: 0.07 });
    },
    swap() {
      tone({ from: 520, to: 780, dur: 0.09, gain: 0.12, wave: 'triangle' });
    },
    bossDown() {
      noise({ from: 1600, to: 120, dur: 0.5, gain: 0.3, filter: 'lowpass', decay: 2.2 });
      [392, 523, 659].forEach((f, i) => tone({ from: f, dur: 0.45, gain: 0.12, wave: 'triangle', delay: 0.1 + i * 0.08 }));
    },
  };

  const PICKUP = {
    gold: 'pickupGold',
    potion: 'pickupPotion',
    chest: 'pickupChest',
    revive: 'pickupRevive',
  };

  /** 同名音效 35ms 内只响一次，防止连按时的爆音 */
  function play(name) {
    const recipe = RECIPES[name];
    if (!recipe) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (lastAt[name] && now - lastAt[name] < 35) return;
    lastAt[name] = now;
    try {
      recipe();
    } catch (err) {
      /* 静默失败 */
    }
  }

  return {
    play,
    unlock() {
      try {
        ensure();
      } catch (err) {
        /* 静默失败 */
      }
    },
    playPickup(kind) {
      play(PICKUP[kind] || 'pickupGold');
    },
    toggle() {
      muted = !muted;
      if (actx) {
        if (muted) actx.suspend();
        else actx.resume();
      }
      return !muted;
    },
    get muted() {
      return muted;
    },
  };
})();
