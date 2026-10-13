'use strict';
// Марми Мафия — звуки. Всё синтезируется в браузере (Web Audio), файлов нет.
window.Sound = (() => {
  let ac = null, master, sfx, music, noiseBuf = null;
  // 2 — звук и музыка, 1 — только звуки, 0 — тишина
  let mode = 2;
  try { const v = localStorage.getItem('mm_sound'); if (v !== null) mode = Number(v); } catch (e) {}

  function init() {
    if (ac) { if (ac.state !== 'running') ac.resume().catch(() => {}); return; } // iPhone после микрофона ставит 'interrupted', не 'suspended'
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    master = ac.createGain(); master.gain.value = 0.75;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 4;
    master.connect(comp); comp.connect(ac.destination);
    sfx = ac.createGain();
    const soft = ac.createBiquadFilter(); soft.type = 'lowpass'; soft.frequency.value = 3800;
    sfx.connect(soft); soft.connect(master);
    music = ac.createGain(); music.connect(master);
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    applyMode();
    startMusic();
  }
  function applyMode() {
    if (!ac) return;
    const t = ac.currentTime;
    sfx.gain.setTargetAtTime(mode >= 1 ? 1 : 0, t, 0.05);
    if (wpn) wpn.gain.setTargetAtTime(mode >= 1 ? 1 : 0, t, 0.05);
    if (ambGain) ambGain.gain.setTargetAtTime(mode >= 1 ? AMB_VOL : 0, t, 0.1);
    music.gain.setTargetAtTime(mode >= 2 ? 1 : 0, t, 0.3);
  }
  const ok = () => ac && mode >= 1 && ac.state === 'running';

  function tone(freq, dur, type, vol, when, glideTo, dest) {
    const t = (when || ac.currentTime);
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest || sfx);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, vol, f0, f1, q, when) {
    const t = when || ac.currentTime;
    const src = ac.createBufferSource(); src.buffer = noiseBuf;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = q || 1.2;
    bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp); bp.connect(g); g.connect(sfx);
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.02);
  }

  // Еда: мягкий «чпок», серия подряд поднимается по пентатонике
  const PENTA = [0, 2, 4, 7, 9, 12, 14, 16];
  let lastEat = 0, combo = 0;
  function eat(big) {
    if (!ok()) return;
    const now = ac.currentTime;
    if (now - lastEat < 0.06) return;
    combo = now - lastEat < 0.45 ? Math.min(combo + 1, PENTA.length - 1) : 0;
    lastEat = now;
    const f = 440 * Math.pow(2, PENTA[combo] / 12);
    if (big) {
      tone(f, 0.16, 'sine', 0.06, now, f * 1.4);
      tone(f * 2, 0.1, 'sine', 0.018, now + 0.02);
    } else {
      tone(f * 1.2, 0.07, 'sine', 0.035, now, f * 0.85);
    }
  }

  // Ускорение: «вжух» при нажатии и тихий гул, пока держите
  let hum = null;
  function boost(on) {
    if (!ac) return;
    if (on && !hum && ok()) {
      noise(0.35, 0.08, 300, 1500, 1.2); // громче (владелец 07.10)
      const src = ac.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 2;
      const g = ac.createGain(); g.gain.value = 0.0001;
      g.gain.setTargetAtTime(0.045, ac.currentTime, 0.1);
      const lfo = ac.createOscillator(), lg = ac.createGain();
      lfo.frequency.value = 6; lg.gain.value = 90; lfo.connect(lg); lg.connect(lp.frequency); lfo.start();
      src.connect(lp); lp.connect(g); g.connect(sfx); src.start();
      hum = { src, g, lfo };
    } else if (!on && hum) {
      const h = hum; hum = null;
      h.g.gain.setTargetAtTime(0.0001, ac.currentTime, 0.06);
      setTimeout(() => { try { h.src.stop(); h.lfo.stop(); } catch (e) {} }, 300);
    }
  }

  function kill() {
    if (!ok()) return;
    const t = ac.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      tone(f, 0.3, 'sine', 0.06, t + i * 0.07);
      tone(f * 2, 0.2, 'sine', 0.012, t + i * 0.07);
    });
  }
  function death() {
    if (!ok()) return;
    boost(false);
    const t = ac.currentTime;
    // «Шмяк» — как помидор вдребезги (владелец 06.10): глухой влажный удар + чавкающий всплеск + брызги
    const thud = ac.createOscillator(), tg = ac.createGain();
    thud.type = 'sine'; thud.frequency.setValueAtTime(160, t); thud.frequency.exponentialRampToValueAtTime(45, t + 0.18);
    tg.gain.setValueAtTime(0.0001, t); tg.gain.exponentialRampToValueAtTime(0.32, t + 0.006); tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    thud.connect(tg); tg.connect(sfx); thud.start(t); thud.stop(t + 0.25);
    splat(t, 0.16, 0.22, 2600, 400, 1.6);           // мокрый всплеск
    splat(t + 0.02, 0.09, 0.12, 5200, 1800, 2.5);   // чавк
    for (let i = 0; i < 7; i++) {                   // брызги-капли
      const d = 0.05 + Math.random() * 0.28;
      splat(t + d, 0.03 + Math.random() * 0.04, 0.03 + Math.random() * 0.04, 3000 + Math.random() * 3000, 900, 4);
    }
  }
  // Короткий отфильтрованный шум с быстрым спадом — основа «мокрых» звуков
  function splat(t, dur, vol, f0, f1, q) {
    const src = ac.createBufferSource(); src.buffer = noiseBuf;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = q;
    bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp); bp.connect(g); g.connect(sfx);
    src.start(t, Math.random() * 0.8); src.stop(t + dur + 0.02);
  }
  // Новая роль: короткий подъём нот; Дон — фанфары
  function promo(don) {
    if (!ok()) return;
    const t = ac.currentTime, notes = don ? [392, 523.25, 659.25, 783.99, 1046.5, 1318.5] : [523.25, 659.25, 783.99];
    notes.forEach((f, i) => { tone(f, don ? 0.4 : 0.28, 'triangle', don ? 0.07 : 0.05, t + i * (don ? 0.09 : 0.07)); tone(f * 2, 0.2, 'sine', 0.015, t + i * 0.08); });
    if (don) [523.25, 659.25, 783.99].forEach(f => tone(f, 1.2, 'sine', 0.04, t + notes.length * 0.09));
  }
  function click() { if (ok()) tone(660, 0.05, 'sine', 0.035, 0, 880); }
  function spawn() {
    if (!ok()) return;
    const t = ac.currentTime;
    [392, 523.25, 659.25].forEach((f, i) => tone(f, 0.3, 'sine', 0.045, t + i * 0.07));
  }

  // Фоновая музыка: спокойный «космический» пэд + редкие ноты с эхом
  const CHORDS = [[57, 60, 64, 67], [53, 57, 60, 64], [48, 52, 55, 59], [55, 59, 62, 64]]; // Am7 Fmaj7 Cmaj7 G6
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  let musicTimer = null, nextBar = 0, bar = 0, echo = null;
  function startMusic() {
    if (musicTimer) return;
    const d = ac.createDelay(1.5); d.delayTime.value = 0.42;
    const fb = ac.createGain(); fb.gain.value = 0.38;
    const wet = ac.createGain(); wet.gain.value = 0.5;
    d.connect(fb); fb.connect(d); d.connect(wet); wet.connect(music);
    echo = d;
    nextBar = ac.currentTime + 0.3;
    musicTimer = setInterval(scheduleMusic, 250);
  }
  function scheduleMusic() {
    if (!ac || ac.state !== 'running') return;
    while (nextBar < ac.currentTime + 1) {
      const chord = CHORDS[bar % CHORDS.length], len = 5;
      for (const n of chord) pad(mtof(n - 12), nextBar, len);
      pad(mtof(chord[0] - 24), nextBar, len, 0.02);
      for (let i = 0; i < 4; i++) {
        if (Math.random() < 0.4) {
          const n = chord[(Math.random() * chord.length) | 0] + (Math.random() < 0.5 ? 12 : 0);
          pluck(mtof(n), nextBar + i * 1 + (Math.random() < 0.3 ? 0.5 : 0));
        }
      }
      nextBar += len; bar++;
    }
  }
  function pad(f, t, len, vol) {
    const o = ac.createOscillator(), o2 = ac.createOscillator(), lp = ac.createBiquadFilter(), g = ac.createGain();
    o.type = 'triangle'; o2.type = 'sine';
    o.frequency.value = f; o2.frequency.value = f * 1.003;
    lp.type = 'lowpass'; lp.frequency.value = 900;
    const v = vol || 0.014;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(v, t + 1.2);
    g.gain.setValueAtTime(v, t + len - 1);
    g.gain.linearRampToValueAtTime(0.0001, t + len + 0.6);
    o.connect(lp); o2.connect(lp); lp.connect(g); g.connect(music);
    o.start(t); o2.start(t); o.stop(t + len + 0.7); o2.stop(t + len + 0.7);
  }
  function pluck(f, t) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.018, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(g); g.connect(music); g.connect(echo);
    o.start(t); o.stop(t + 1);
  }

  // Кнопка: 🔊 звук и музыка → 🔉 только звуки → 🔇 тишина
  const ICONS = ['🔇', '🔉', '🔊'];
  function cycle() {
    mode = mode === 2 ? 1 : mode === 1 ? 0 : 2;
    try { localStorage.setItem('mm_sound', String(mode)); } catch (e) {}
    init(); applyMode();
    if (mode === 0) boost(false);
    return ICONS[mode];
  }
  const icon = () => ICONS[mode];

  document.addEventListener('visibilitychange', () => {
    if (!ac) return;
    if (document.hidden) { boost(false); ac.suspend(); } else ac.resume();
  });
  // Браузеры разрешают звук только после первого касания/клика
  const unlock = () => init();
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);

  // Последняя минута командного раунда: глухой удар «сердца» раз в секунду (strong — последние 10 с)
  function beat(strong) { if (!ok()) return; tone(strong ? 70 : 58, 0.18, 'sine', strong ? 0.16 : 0.1); tone(strong ? 70 : 58, 0.16, 'sine', strong ? 0.12 : 0.07, ac.currentTime + 0.2); }
  // Тревога/событие команды: короткий двойной сигнал
  function alert() { if (!ok()) return; tone(880, 0.09, 'square', 0.035); tone(660, 0.12, 'square', 0.035, ac.currentTime + 0.11); }
  // ===== Оружие как настоящее (владелец 11.10) =====
  // Звук оружия идёт мимо смягчающего фильтра звуков (иначе хлопок глухой) — в свою громкость и короткое «эхо местности».
  let wpn = null;
  function weaponBus() {
    if (wpn) return wpn;
    wpn = ac.createGain(); wpn.gain.value = 1;
    const dl = ac.createDelay(1), fb = ac.createGain(), lp = ac.createBiquadFilter(), wet = ac.createGain();
    dl.delayTime.value = 0.13; fb.gain.value = 0.32; lp.type = 'lowpass'; lp.frequency.value = 1400; wet.gain.value = 0.35;
    wpn.connect(dl); dl.connect(lp); lp.connect(fb); fb.connect(dl); lp.connect(wet); // отражения затухают и глохнут, как эхо
    wpn.connect(master); wet.connect(master);
    if (mode < 1) wpn.gain.value = 0;
    return wpn;
  }
  // Шум с фильтром и огибающей: тип фильтра, частота от/до, атака, длительность
  function nz(type, f0, f1, q, vol, att, dur, when, dest) {
    const t = when || ac.currentTime, src = ac.createBufferSource(); src.buffer = noiseBuf; src.loop = dur > 0.9;
    const f = ac.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + att); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(dest); src.start(t, Math.random() * 0.4); src.stop(t + dur + 0.05);
    return g;
  }
  function thump(f0, f1, vol, dur, when, dest) {
    const t = when || ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + 0.02);
  }
  // Выстрел гранатомёта: хлопок + удар отдачи, затем рёв двигателя гранаты, удаляется и затихает. v — громкость по расстоянию (0..1)
  function rocket(v) {
    if (!ok()) return; v = v == null ? 1 : v;
    const d = weaponBus(), t = ac.currentTime;
    nz('highpass', 900, 600, 0.7, 0.55 * v, 0.003, 0.12, t, d);      // резкий хлопок
    nz('lowpass', 600, 120, 0.8, 0.5 * v, 0.004, 0.35, t, d);        // удар отдачи
    thump(85, 38, 0.45 * v, 0.3, t, d);
    const motor = nz('bandpass', 1900, 520, 1.6, 0.16 * v, 0.06, 1.3, t + 0.03, d); // реактивный рёв: «фшшшш…» вниз по тону
    void motor;
    nz('bandpass', 3800, 1400, 3, 0.05 * v, 0.05, 0.9, t + 0.03, d); // свист сопла
  }
  // Взрыв: треск, тяжёлый низкий гул, рокот с хрустом обломков
  function boom(v) {
    if (!ok()) return; v = v == null ? 1 : v;
    const d = weaponBus(), t = ac.currentTime;
    nz('highpass', 1500, 700, 0.6, 0.6 * v, 0.002, 0.09, t, d);      // треск детонации
    nz('lowpass', 1600, 110, 0.7, 0.75 * v, 0.008, 1.7, t, d);       // тело взрыва
    thump(62, 26, 0.7 * v, 0.9, t, d);                               // удар в грудь
    nz('lowpass', 260, 60, 0.9, 0.35 * v, 0.25, 2.4, t + 0.05, d);   // долгий рокот
    for (let i = 0; i < 9; i++) nz('bandpass', 2000 + Math.random() * 2500, 900, 4, (0.05 + Math.random() * 0.06) * v, 0.002, 0.05, t + 0.15 + Math.random() * 0.9, d); // обломки
  }
  // Потайной ход: «вжух» — шум уходит вниз и тут же поднимается (провалился и вынырнул)
  function portal(v) {
    if (!ok()) return; v = v == null ? 1 : v;
    const t = ac.currentTime;
    nz('bandpass', 2400, 300, 2.5, 0.22 * v, 0.03, 0.28, t, sfx);
    nz('bandpass', 300, 2600, 2.5, 0.2 * v, 0.12, 0.32, t + 0.22, sfx);
    tone(520, 0.4, 'sine', 0.05 * v, t + 0.2, 1040);
  }
  // Кинжал: свист броска и сочный «чвак» удара по телу
  function knifeThrow(v) { if (!ok()) return; v = v == null ? 1 : v; const t = ac.currentTime; nz('bandpass', 3200, 1200, 4, 0.12 * v, 0.02, 0.35, t, sfx); nz('bandpass', 5200, 2600, 6, 0.05 * v, 0.02, 0.25, t + 0.05, sfx); }
  function knifeHit(v) { if (!ok()) return; v = v == null ? 1 : v; const d = weaponBus(), t = ac.currentTime; nz('highpass', 2600, 1800, 1.5, 0.35 * v, 0.002, 0.07, t, d); nz('lowpass', 900, 200, 1, 0.3 * v, 0.004, 0.22, t, d); thump(140, 70, 0.25 * v, 0.15, t, d); }
  // Стук каблука по паркету (владелец 12.10, видео в меню): короткий звонкий щелчок + глухой удар доски + лёгкое эхо зала
  function heel(v) {
    if (!ok()) return; v = v == null ? 1 : v;
    const d = weaponBus(), t = ac.currentTime;
    nz('highpass', 3800, 2600, 1.2, 0.16 * v, 0.001, 0.035, t, d);   // щелчок набойки
    nz('bandpass', 1200, 700, 2.5, 0.12 * v, 0.002, 0.06, t, d);     // каблук
    thump(180, 90, 0.10 * v, 0.07, t, d);                            // доска
  }
  // Звук из видео меню (владелец 12.10: «сделай свой звук как на видео») — по кругу, пока открыто меню; кнопка 🔊 выключает
  const AMB_VOL = 0.7;
  let amb = null, ambBuf = null, ambGain = null, ambWant = false, ambLoading = null;
  async function ambient(on, url) {
    ambWant = on;
    if (!on) { if (amb) { const a0 = amb, g0 = ambGain; amb = null; try { g0.gain.setTargetAtTime(0, ac.currentTime, 0.15); setTimeout(() => { try { a0.stop(); } catch (e) {} }, 600); } catch (e) {} } return; }
    if (!ac || amb) return;
    try {
      if (!ambBuf) { if (!ambLoading) ambLoading = fetch(url).then(r => r.arrayBuffer()).then(b => new Promise((ok, no) => ac.decodeAudioData(b, ok, no))); ambBuf = await ambLoading; }
    } catch (e) { ambLoading = null; return; }
    if (!ambWant || amb) return;
    ambGain = ac.createGain(); ambGain.gain.value = 0; ambGain.connect(master);
    amb = ac.createBufferSource(); amb.buffer = ambBuf; amb.loop = true; amb.connect(ambGain); amb.start();
    ambGain.gain.setTargetAtTime(mode >= 1 ? AMB_VOL : 0, ac.currentTime, 0.3); // плавно нарастает
  }
  const isOn = () => mode >= 1;
  const state = () => ac ? ac.state : 'none';
  return { init, state, eat, boost, kill, death, click, spawn, cycle, icon, promo, beat, alert, rocket, boom, portal, knifeThrow, knifeHit, heel, ambient, isOn };
})();
