'use strict';
// Марми Мафия — «рация» (владелец 15.10): вместо постоянного голосового чата LiveKit (там кончились бесплатные минуты).
// Телефон: нажал 🎙 — говоришь (до 10 с) — нажал ещё раз — сообщение слышат все в игре. Компьютер: держи V и говори.
// Голос идёт через сервер игры: 12 000 отсчётов в секунду, 8 бит (μ-закон) — одинаково играет на любом телефоне, без LiveKit.
// Наружу — те же имена, что у старого голосового чата (window.VoiceChat), чтобы игра показывала 🔊 у того, кто говорит.
// 15.10 (владелец: «чтобы сразу уходило»): ЖИВАЯ рация — пока держишь кнопку, голос уходит кусочками по 0,25 с через игровое
// соединение (двоичная посылка с меткой 0xA7), слушатели слышат примерно через 0,5 с. Передача — до 15 с, между передачами — 1 с.
window.VoiceChat = (() => {
  const RATE = 12000, MAX_S = 15, CHUNK_MS = 250;
  let sendBin = null, workletReady = null;
  // звуковой поток: копит ~85 мс и отдаёт кусок в игру
  const WORKLET = "class R extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(4096);this.n=0}process(i){const c=i[0]&&i[0][0];if(c){if(this.n+c.length>this.b.length){this.port.postMessage(this.b.slice(0,this.n));this.n=0}this.b.set(c,this.n);this.n+=c.length}return true}}registerProcessor('mm-rec',R)";
  const $ = id => document.getElementById(id);
  const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const ua = navigator.userAgent;
  const inApp = !!window.TelegramWebviewProxy || /Telegram|Instagram|FBAN|FBAV|FB_IAB|Line\//i.test(ua) || /; wv\)/.test(ua);
  const speaking = new Set();
  let key = '', inGame = false, ac = null, rec = null, nextOk = 0, autoT = 0, tickT = 0;
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
    btn.classList.toggle('rec', !!rec); btn.classList.toggle('wait', !rec && Date.now() < nextOk);
    const sm = btn.querySelector('small');
    sm.textContent = rec ? '🔴 ' + Math.min(MAX_S, Math.floor((performance.now() - rec.t0) / 1000)) + ' с' : 'рация'; // 15.10 (владелец: «на телефоне нет подсказки, где рация») — подпись под кнопкой
    muteBtn.textContent = mutedAll ? '🔇' : '🔊';
  }
  let tipT = 0;
  function say(text, ms) { tip.textContent = text; tip.classList.remove('hide'); clearTimeout(tipT); tipT = setTimeout(() => tip.classList.add('hide'), ms || 4000); }

  // ===== Запись =====
  async function start() {
    if (rec || !key) return;
    if (Date.now() < nextOk) return; // 1 с между передачами
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
    const src = a.createMediaStreamSource(stream);
    let proc = null;
    // 16.10 (критик): запись в отдельном звуковом потоке (AudioWorklet) — у говорящего не подтормаживает игра. Нет поддержки — как раньше
    try {
      if (a.audioWorklet && window.AudioWorkletNode) {
        if (!workletReady) workletReady = a.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
        await workletReady;
        if (rec !== my) { stream.getTracks().forEach(t => t.stop()); iosBack(); return; }
        proc = new AudioWorkletNode(a, 'mm-rec', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        proc.port.onmessage = e => { if (rec === my) my.chunks.push(e.data); };
      }
    } catch (e) { proc = null; workletReady = null; }
    if (!proc) {
      proc = a.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = e => { if (rec === my) my.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
    }
    Object.assign(my, { seq: 0, rem: new Float32Array(0), peak: 0.12 });
    my.iv = setInterval(() => flush(my, false), CHUNK_MS); // каждые 0,25 с — кусочек в эфир
    src.connect(proc); proc.connect(a.destination); // выход молчит — нужен, чтобы запись шла
    Object.assign(my, { stream, src, proc, pending: false, t0: performance.now() });
    Sound && Sound.click && Sound.click();
    clearTimeout(autoT); autoT = setTimeout(() => { if (rec === my) { finish(true); say('🎙 Не дольше 15 секунд за раз'); } }, MAX_S * 1000);
    clearInterval(tickT); tickT = setInterval(render, 250);
  }
  function iosBack() { try { if (isIOS && navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {} }
  function finish(send) {
    const r = rec; if (!r) return;
    rec = null; clearTimeout(autoT); clearInterval(tickT); clearInterval(r.iv);
    if (r.stream) { flush(r, true); try { r.src.disconnect(); r.proc.disconnect(); } catch (e) {} r.stream.getTracks().forEach(t => t.stop()); }
    iosBack();
    if (!r.pending) { nextOk = Date.now() + 1000; clearInterval(tickT); tickT = setInterval(() => { render(); if (Date.now() >= nextOk) { clearInterval(tickT); render(); } }, 300); }
    render();
  }
  // Кусочек в эфир: усредняем до 12 000 отсчётов в секунду, 8 бит по μ-закону; остаток копим до следующего раза
  function flush(r, end) {
    if (!r.stream) return;
    const ch = r.chunks; r.chunks = [];
    const tot = r.rem.length + ch.reduce((a, c) => a + c.length, 0), all = new Float32Array(tot); all.set(r.rem); let o = r.rem.length; for (const c of ch) { all.set(c, o); o += c.length; }
    const step = r.rate / RATE, n = Math.floor(all.length / step);
    for (let i = 0; i < all.length; i++) { const v = Math.abs(all[i]); if (v > r.peak) r.peak = v; }
    const gain = Math.max(1, Math.min(3, 0.8 / r.peak)); // тихий микрофон — чуть громче
    const out = new Uint8Array(4 + n);
    for (let i = 0; i < n; i++) { const a = Math.floor(i * step), b = Math.max(a + 1, Math.floor((i + 1) * step)); let sum = 0; for (let j = a; j < b; j++) sum += all[j]; out[4 + i] = muEnc(sum / (b - a) * gain); }
    r.rem = all.slice(Math.floor(n * step));
    // 16.10 (критик): кусок больше 4 КБ сервер считал нарушением и рвал связь — режем на части по 2000 отсчётов
    if (!sendBin) return;
    for (let p = 0; p < n || (p === 0 && end); p += 2000) {
      const m = Math.min(2000, n - p), last = p + 2000 >= n, pk = new Uint8Array(4 + Math.max(0, m));
      if (m > 0) pk.set(out.subarray(4 + p, 4 + p + m), 4);
      pk[0] = 0xA7; pk[1] = r.seq & 255; pk[2] = (r.seq >> 8) & 255; pk[3] = end && last ? 1 : 0; r.seq++;
      sendBin(pk);
      if (n === 0) break;
    }
  }
  function muEnc(x) { x = Math.max(-1, Math.min(1, x)); const s = x < 0 ? 0x80 : 0; const m = Math.log1p(255 * Math.abs(x)) / Math.log1p(255); return (~(s | Math.round(m * 127))) & 0xff; }
  function muDec(u) { u = ~u & 0xff; const s = u & 0x80 ? -1 : 1, m = (u & 0x7f) / 127; return s * (Math.pow(256, m) - 1) / 255; }
  // ===== Проигрывание: живой поток от каждого говорящего, с запасом 0,35 с (чтобы неровная связь не рвала звук) =====
  const streams = new Map(); // id говорящего -> { t (когда играть следующий кусок), name, last }
  function onRadio(m) { // старый вид (текстом): { t:'rv', id, name, end, d (base64) }
    let u = null; if (m.d) { const bin = atob(m.d); u = new Uint8Array(bin.length); for (let i = 0; i < u.length; i++) u[i] = bin.charCodeAt(i); }
    play(m.id, m.name, m.end, u);
  }
  function onRadioBin(buf) { // 16.10: [0xA7, id(2), конец(1), длина имени(1), имя, звук]
    const b = new Uint8Array(buf); if (b.length < 5) return;
    const id = b[1] | (b[2] << 8), end = b[3], nl = b[4];
    let name = ''; try { name = new TextDecoder().decode(b.subarray(5, 5 + nl)); } catch (e) {}
    play(id, name, end, b.subarray(5 + nl));
  }
  function busy() { if (rec) finish(false); say('🎙 Эфир занят — говорят двое, подождите пару секунд'); }
  function play(mid, mname, mend, u) {
    const m = { id: mid, name: mname, end: mend };
    if (mutedAll || document.hidden || (window.Sound && Sound.isOn && !Sound.isOn())) return; // звук игры выключен (🔇) — рацию тоже не играем
    const a = audio(); if (!a) return;
    let st = streams.get(m.id);
    if (!st) { st = { t: 0, name: m.name || 'Игрок', srcs: [] }; streams.set(m.id, st); speaking.add(st.name); showBanner(); }
    st.last = performance.now();
    if (u) {
      if (u.length) {
        const k = a.sampleRate / RATE, len = Math.floor(u.length * k), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
        const f = new Float32Array(u.length); for (let i = 0; i < u.length; i++) f[i] = muDec(u[i]);
        for (let i = 0; i < len; i++) { const x = i / k, j = Math.floor(x), t = x - j; d[i] = f[j] * (1 - t) + (f[Math.min(j + 1, f.length - 1)] || 0) * t; }
        const src = a.createBufferSource(), g = a.createGain(); g.gain.value = 1.4; src.buffer = buf; src.connect(g); g.connect(a.destination);
        if (st.t < a.currentTime + 0.03) st.t = a.currentTime + 0.35; // первый кусок или связь подвисла — небольшой запас
        src.start(st.t); st.t += buf.duration; st.srcs.push(src); if (st.srcs.length > 12) st.srcs.shift();
      }
    }
    if (m.end) { const left = Math.max(0, st.t - a.currentTime); setTimeout(() => endStream(m.id, st), left * 1000 + 200); }
  }
  function endStream(id, st) { if (streams.get(id) !== st) return; streams.delete(id); speaking.delete(st.name); showBanner(); }
  setInterval(() => { const now = performance.now(); for (const [id, st] of streams) if (now - st.last > 2500) endStream(id, st); }, 1000); // оборвалась связь — убираем надпись
  function showBanner() {
    const names = [...streams.values()].map(x => x.name);
    if (!names.length) { banner.classList.add('hide'); return; }
    banner.textContent = '🎙 ' + names.join(', '); banner.classList.remove('hide');
  }
  function stopPlay() { for (const st of streams.values()) for (const x of st.srcs) try { x.stop(); } catch (e) {} streams.clear(); speaking.clear(); showBanner(); }

  // ===== Связь с игрой =====
  function init() { build(); }
  function tick(alive) { const g = !!alive; if (g !== inGame) { inGame = g; if (!g && rec) finish(true); render(); if (g && key) firstHint(); } }
  // первые 3 игры — подсказка, где рация и как ей пользоваться; кнопка мигает
  function firstHint() {
    let n = 0; try { n = Number(localStorage.getItem('mm_radio_hint') || 0); localStorage.setItem('mm_radio_hint', String(n + 1)); } catch (e) {}
    if (n >= 3) return;
    say(isTouch ? '🎙 Рация — кнопка 🎙 внизу: держите её и говорите — вас сразу слышат все' : '🎙 Рация: держите V и говорите — услышат все в игре', 7000);
    btn.classList.add('hint'); setTimeout(() => btn.classList.remove('hint'), 7000);
  }
  function setKey(k) { key = k || ''; render(); }
  function setSender(f) { sendBin = f; }
  function askMic() {} // разрешение спрашиваем при первом нажатии 🎙
  function setRoom() { key = ''; render(); } // командная арена — рации нет
  return { init, tick, askMic, setRoom, setKey, setSender, onRadio, onRadioBin, busy, speaking, isSpeaking: name => speaking.has(name) };
})();
