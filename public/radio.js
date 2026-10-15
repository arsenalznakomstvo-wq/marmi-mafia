'use strict';
// Марми Мафия — «рация» (владелец 15.10): вместо постоянного голосового чата LiveKit (там кончились бесплатные минуты).
// Телефон: нажал 🎙 — говоришь (до 10 с) — нажал ещё раз — сообщение слышат все в игре. Компьютер: держи V и говори.
// Голос идёт через сервер игры: 12 000 отсчётов в секунду, 8 бит (μ-закон) — одинаково играет на любом телефоне, без LiveKit.
// Наружу — те же имена, что у старого голосового чата (window.VoiceChat), чтобы игра показывала 🔊 у того, кто говорит.
window.VoiceChat = (() => {
  const RATE = 12000, MAX_S = 10, MIN_S = 0.4;
  const $ = id => document.getElementById(id);
  const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const ua = navigator.userAgent;
  const inApp = !!window.TelegramWebviewProxy || /Telegram|Instagram|FBAN|FBAV|FB_IAB|Line\//i.test(ua) || /; wv\)/.test(ua);
  const speaking = new Set();
  let key = '', inGame = false, ac = null, rec = null, sending = false, nextOk = 0, autoT = 0, tickT = 0;
  let mutedAll = false; // 15.10: отдельной кнопки нет — чужую рацию выключает общая кнопка звука (режим «тишина»)

  function audio() {
    if (!ac) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; ac = new AC(); }
    if (ac.state !== 'running') ac.resume().catch(() => {});
    return ac;
  }
  window.addEventListener('pointerdown', () => { if (ac) audio(); }, { passive: true }); // после касания звук рации точно разрешён

  // ===== Кнопки =====
  let btn, muteBtn, banner, tip;
  function build() {
    btn = document.createElement('button'); btn.id = 'radioBtn'; btn.innerHTML = '🎙<small></small>';
    btn.title = isTouch ? 'Рация: держите кнопку и говорите, отпустите — сообщение уйдёт' : 'Рация: держите V (или кнопку) и говорите';
    muteBtn = document.createElement('button'); muteBtn.id = 'radioMute'; muteBtn.title = 'Не слышать рацию';
    banner = document.createElement('div'); banner.id = 'radioBanner'; banner.className = 'hide';
    tip = document.createElement('div'); tip.id = 'radioTip'; tip.className = 'hide';
    for (const el of [btn, muteBtn, banner, tip]) document.body.appendChild(el);
    const stop = e => { e.preventDefault(); e.stopPropagation(); };
    // 15.10 (владелец): держишь кнопку — говоришь, отпустил — сообщение уходит само (и на телефоне, и мышкой)
    btn.addEventListener('pointerdown', e => { stop(e); try { btn.setPointerCapture(e.pointerId); } catch (e2) {} if (!rec) start(); });
    const release = e => { stop(e); if (rec) finish(true); };
    btn.addEventListener('pointerup', release); btn.addEventListener('pointercancel', release); btn.addEventListener('lostpointercapture', () => { if (rec) finish(true); });
    for (const ev of ['touchstart', 'touchend', 'click', 'contextmenu']) btn.addEventListener(ev, stop);
    muteBtn.addEventListener('pointerdown', e => { stop(e); mutedAll = !mutedAll; try { localStorage.setItem('mm_vc_mute', mutedAll ? '1' : '0'); } catch (e2) {} if (mutedAll) stopPlay(); render(); });
    for (const ev of ['pointerup', 'touchstart', 'touchend', 'click']) muteBtn.addEventListener(ev, stop);
    // компьютер: держишь V — говоришь, отпустил — отправилось
    window.addEventListener('keydown', e => { if (e.code !== 'KeyV' || e.repeat || !inGame || isTyping()) return; e.preventDefault(); if (!rec) start(); });
    window.addEventListener('keyup', e => { if (e.code !== 'KeyV' || !rec) return; finish(true); });
    render();
  }
  const isTyping = () => { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'); };
  function render() {
    if (!btn) return;
    const show = inGame && !!key;
    btn.classList.toggle('hide', !show); muteBtn.classList.toggle('hide', !show);
    btn.classList.toggle('rec', !!rec); btn.classList.toggle('wait', !rec && (sending || Date.now() < nextOk));
    const sm = btn.querySelector('small');
    sm.textContent = rec ? Math.min(MAX_S, Math.floor((performance.now() - rec.t0) / 1000)) + ' с' : sending ? '…' : Date.now() < nextOk ? Math.ceil((nextOk - Date.now()) / 1000) + '' : 'рация'; // 15.10 (владелец: «на телефоне нет подсказки, где рация») — подпись под кнопкой
    muteBtn.textContent = mutedAll ? '🔇' : '🔊';
  }
  let tipT = 0;
  function say(text, ms) { tip.textContent = text; tip.classList.remove('hide'); clearTimeout(tipT); tipT = setTimeout(() => tip.classList.add('hide'), ms || 4000); }

  // ===== Запись =====
  async function start() {
    if (rec || sending || !key) return;
    if (Date.now() < nextOk) { say('🎙 Следующее сообщение — через ' + Math.ceil((nextOk - Date.now()) / 1000) + ' с'); return; }
    if (inApp || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { say('🎙 Рация работает в браузере (Chrome / Safari) или в установленной игре', 6000); return; }
    const a = audio(); if (!a) { say('🎙 Этот браузер не умеет записывать звук'); return; }
    rec = { t0: performance.now(), chunks: [], rate: a.sampleRate, pending: true }; render();
    const my = rec;
    try { if (isIOS && navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch (e) {}
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (e) {
      rec = null; render(); iosBack();
      say(e && e.name === 'NotAllowedError'
        ? (isIOS ? '🎙 Микрофон запрещён: Настройки → Safari → Микрофон → Разрешить' : '🎙 Микрофон запрещён: нажмите 🔒 слева от адреса сайта → Микрофон → Разрешить')
        : '🎙 Микрофон не включился — он занят или не найден', 7000);
      return;
    }
    if (rec !== my) { stream.getTracks().forEach(t => t.stop()); iosBack(); return; } // успели отменить
    audio();
    const src = a.createMediaStreamSource(stream), proc = a.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = e => { if (rec === my) my.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
    src.connect(proc); proc.connect(a.destination); // выход молчит — нужен, чтобы запись шла
    Object.assign(my, { stream, src, proc, pending: false, t0: performance.now() });
    Sound && Sound.click && Sound.click();
    clearTimeout(autoT); autoT = setTimeout(() => { if (rec === my) finish(true); }, MAX_S * 1000);
    clearInterval(tickT); tickT = setInterval(render, 250);
  }
  function iosBack() { try { if (isIOS && navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {} }
  function finish(send) {
    const r = rec; if (!r) return;
    rec = null; clearTimeout(autoT); clearInterval(tickT);
    if (r.stream) { try { r.src.disconnect(); r.proc.disconnect(); } catch (e) {} r.stream.getTracks().forEach(t => t.stop()); }
    iosBack(); render();
    if (!send || r.pending) return;
    const n = r.chunks.reduce((s, c) => s + c.length, 0);
    if (n < r.rate * MIN_S) { say('🎙 Держите кнопку, пока говорите, — отпустите, когда скажете'); return; }
    upload(encode(r.chunks, r.rate));
  }
  // Сжатие: усредняем до 12 000 отсчётов в секунду и переводим в 8 бит по μ-закону (как в телефонной связи)
  function encode(chunks, rate) {
    const all = new Float32Array(chunks.reduce((s, c) => s + c.length, 0)); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
    const step = rate / RATE, n = Math.min(Math.floor(all.length / step), RATE * MAX_S), out = new Uint8Array(n);
    let peak = 0.05; for (let i = 0; i < all.length; i++) { const v = Math.abs(all[i]); if (v > peak) peak = v; }
    const gain = Math.min(4, 0.9 / peak); // тихий микрофон — чуть громче
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * step), b = Math.max(a + 1, Math.floor((i + 1) * step)); let s = 0; for (let j = a; j < b; j++) s += all[j];
      out[i] = muEnc(s / (b - a) * gain);
    }
    return out;
  }
  function muEnc(x) { x = Math.max(-1, Math.min(1, x)); const s = x < 0 ? 0x80 : 0; const m = Math.log1p(255 * Math.abs(x)) / Math.log1p(255); return (~(s | Math.round(m * 127))) & 0xff; }
  function muDec(u) { u = ~u & 0xff; const s = u & 0x80 ? -1 : 1, m = (u & 0x7f) / 127; return s * (Math.pow(256, m) - 1) / 255; }
  async function upload(bytes) {
    sending = true; render();
    try {
      const r = await fetch('/radio', { method: 'POST', headers: { 'x-rk': key, 'Content-Type': 'application/octet-stream' }, body: bytes });
      if (r.ok) { nextOk = Date.now() + 5000; say('🎙 Отправлено — вас слышат все в игре', 2500); }
      else if (r.status === 429) { nextOk = Date.now() + 5000; say('🎙 Не так часто — через пару секунд'); }
      else say('🎙 Не отправилось — попробуйте ещё раз');
    } catch (e) { say('🎙 Нет связи — не отправилось'); }
    sending = false; render();
    clearInterval(tickT); tickT = setInterval(() => { render(); if (Date.now() >= nextOk) { clearInterval(tickT); render(); } }, 500);
  }

  // ===== Проигрывание: по очереди, через обычный динамик (как звуки игры) =====
  const queue = []; let playing = null;
  function onRadio(m) {
    if (mutedAll || !inGameOrMenu() || (window.Sound && Sound.isOn && !Sound.isOn())) return; // звук игры выключен (🔇) — рацию тоже не играем
    queue.push(m); if (queue.length > 4) queue.shift();
    if (!playing) next();
  }
  const inGameOrMenu = () => !document.hidden;
  async function next() {
    const m = queue.shift(); if (!m) { playing = null; return; }
    playing = m;
    try {
      const a = audio(); if (!a) throw new Error('no audio');
      const r = await fetch('/radio/' + m.n, { cache: 'no-store' }); if (!r.ok) throw new Error('gone');
      const u = new Uint8Array(await r.arrayBuffer());
      const k = a.sampleRate / RATE, len = Math.floor(u.length * k), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
      const f = new Float32Array(u.length); for (let i = 0; i < u.length; i++) f[i] = muDec(u[i]);
      for (let i = 0; i < len; i++) { const x = i / k, j = Math.floor(x), t = x - j; d[i] = f[j] * (1 - t) + (f[Math.min(j + 1, f.length - 1)] || 0) * t; } // плавно до частоты динамика
      if (mutedAll) throw new Error('muted');
      const s = a.createBufferSource(), g = a.createGain(); g.gain.value = 1.4; s.buffer = buf; s.connect(g); g.connect(a.destination);
      playing.src = s;
      speaking.add(m.name || ''); banner.textContent = '🎙 ' + (m.name || 'Игрок'); banner.classList.remove('hide');
      await new Promise(res => { s.onended = res; s.start(); setTimeout(res, buf.duration * 1000 + 500); });
    } catch (e) {}
    speaking.delete(m.name || ''); banner.classList.add('hide');
    next();
  }
  function stopPlay() { queue.length = 0; if (playing && playing.src) try { playing.src.stop(); } catch (e) {} }

  // ===== Связь с игрой =====
  function init() { build(); }
  function tick(alive) { const g = !!alive; if (g !== inGame) { inGame = g; if (!g && rec) finish(true); render(); if (g && key) firstHint(); } }
  // первые 3 игры — подсказка, где рация и как ей пользоваться; кнопка мигает
  function firstHint() {
    let n = 0; try { n = Number(localStorage.getItem('mm_radio_hint') || 0); localStorage.setItem('mm_radio_hint', String(n + 1)); } catch (e) {}
    if (n >= 3) return;
    say(isTouch ? '🎙 Рация — кнопка справа: держите её и говорите, отпустите — услышат все в игре' : '🎙 Рация: держите V и говорите — услышат все в игре', 7000);
    btn.classList.add('hint'); setTimeout(() => btn.classList.remove('hint'), 7000);
  }
  function setKey(k) { key = k || ''; render(); }
  function askMic() {} // разрешение спрашиваем при первом нажатии 🎙
  function setRoom() { key = ''; render(); } // командная арена — рации нет
  return { init, tick, askMic, setRoom, setKey, onRadio, speaking, isSpeaking: name => speaking.has(name) };
})();
