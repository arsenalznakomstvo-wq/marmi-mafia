'use strict';
// Марми Мафия — общий голосовой чат для всех, кто в игре, как в Counter-Strike (владелец 06.10).
// Нажал «Играть» — слышишь всех и говоришь (открытый микрофон). Выключить себя: V или кнопка 🎤.
// Чтобы не тратить бесплатные минуты LiveKit: подключаемся, только если человек уже играл и на сайте есть ещё кто-то.
window.VoiceChat = (() => {
  const SDK = 'https://cdn.jsdelivr.net/npm/livekit-client@2.22.3/dist/livekit-client.umd.js';
  const ROOM = 'GLOBAL';
  const $ = id => document.getElementById(id);
  const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  const speaking = new Set();
  let room = null, connecting = false, micOn = false, mutedAll = false, offline = false, lowSince = 0;
  // Открытый микрофон (владелец 06.10): разрешение спрашиваем при «Играть», дальше микрофон включён сам; 🎤 / V — выключить себя
  let micAllowed = false, wantMic = true;

  function loadSdk() {
    if (window.LivekitClient) return Promise.resolve();
    return new Promise((ok, fail) => { const s = document.createElement('script'); s.src = SDK; s.onload = ok; s.onerror = () => fail(new Error('sdk')); document.head.appendChild(s); });
  }
  const myName = () => (($('nick') && $('nick').value.trim()) || 'Игрок').slice(0, 16);

  async function connect() {
    if (connecting || room || offline) return;
    connecting = true;
    try {
      await loadSdk();
      const r = await fetch('/voice-token?room=' + ROOM + '&name=' + encodeURIComponent(myName()));
      if (r.status === 503) { offline = true; throw new Error('off'); }
      if (!r.ok) throw new Error('token');
      const { url, token } = await r.json();
      const L = window.LivekitClient;
      const rm = new L.Room({ audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      rm.on(L.RoomEvent.TrackSubscribed, track => {
        if (track.kind !== 'audio') return;
        const el = track.attach(); el.style.display = 'none'; el.muted = mutedAll; document.body.appendChild(el); render();
      });
      rm.on(L.RoomEvent.TrackUnsubscribed, track => { track.detach().forEach(e => e.remove()); render(); });
      rm.on(L.RoomEvent.ActiveSpeakersChanged, sp => { speaking.clear(); for (const p of sp) speaking.add(p.name || ''); });
      rm.on(L.RoomEvent.ParticipantConnected, render);
      rm.on(L.RoomEvent.ParticipantDisconnected, render);
      rm.on(L.RoomEvent.Disconnected, () => { room = null; micOn = false; speaking.clear(); render(); });
      await rm.connect(url, token);
      room = rm; micOn = false;
      try { await rm.startAudio(); } catch (e) {}
      if (micAllowed && wantMic) setMic(true);
    } catch (e) { room = null; }
    connecting = false; render();
  }
  async function disconnect() { const r = room; room = null; micOn = false; speaking.clear(); if (r) try { await r.disconnect(); } catch (e) {} render(); }

  async function setMic(on) {
    if (!room) return;
    try { await room.localParticipant.setMicrophoneEnabled(on); micOn = on; if (on) micAllowed = true; }
    catch (e) { micOn = false; toastMic(e); }
    try { await room.startAudio(); } catch (e) {}
    render();
  }
  // Владелец 06.10: никаких предупреждений про микрофон — если не разрешён, человек просто слушает, кнопка показывает «🔇 Выкл»
  function toastMic() {}
  // Вызывается при нажатии «Играть» (это касание — браузер разрешает спросить микрофон). Спрашиваем один раз.
  async function askMic() {
    if (micAllowed || offline) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toastMic(); return; }
    try {
      const st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      st.getTracks().forEach(t => t.stop());
      micAllowed = true;
      if (room && wantMic) setMic(true);
    } catch (e) { toastMic(e); }
  }
  function setMutedAll(m) { mutedAll = m; document.querySelectorAll('audio').forEach(a => { a.muted = m; }); render(); }

  // Вызывается из игры раз в секунду. Голос держим, пока человек на странице и уже играл (в меню после смерти — тоже,
  // чтобы можно было сказать «кто меня съел?!»). Отключаемся, если на сайте больше никого нет или вкладка скрыта дольше минуты.
  let played = false, hiddenSince = 0;
  document.addEventListener('visibilitychange', () => { hiddenSince = document.hidden ? Date.now() : 0; });
  function tick(alive, online) {
    if (offline) return;
    if (alive) played = true;
    const hiddenLong = hiddenSince && Date.now() - hiddenSince > 60000;
    const want = played && online >= 2 && !hiddenLong;
    if (want) { lowSince = 0; if (!room) connect(); }
    else if (room) {
      if (hiddenLong) disconnect();
      else { if (!lowSince) lowSince = Date.now(); if (Date.now() - lowSince > 15000) disconnect(); } // остался один — ждём 15 с, вдруг кто-то зайдёт
    }
  }

  function render() {
    const on = !!room;
    $('vcBar').classList.toggle('hide', !on);
    if (!on) return;
    const n = room.remoteParticipants.size + 1;
    $('vcMicBtn').textContent = micOn ? (isTouch ? '🎤 Вкл' : '🎤 Вкл (V)') : (isTouch ? '🔇 Выкл' : '🔇 Выкл (V)');
    $('vcMicBtn').classList.toggle('on', micOn);
    $('vcMuteBtn').textContent = mutedAll ? '🔇' : '🔊';
    $('vcCount').textContent = '🎧 ' + n;
  }

  function init() {
    // V (компьютер) и кнопка 🎤 — выключить/включить свой микрофон
    const flip = () => { wantMic = !micOn; if (wantMic && !micAllowed) askMic(); setMic(wantMic); };
    window.addEventListener('keydown', e => {
      if (e.code !== 'KeyV' || e.repeat || !room || document.activeElement === $('nick')) return;
      flip();
    });
    $('vcMicBtn').addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); flip(); });
    $('vcMuteBtn').addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); setMutedAll(!mutedAll); });
    // Браузеры включают звук только после касания — на любом касании пробуем включить
    const unlock = () => { if (room) room.startAudio().catch(() => {}); };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
    render();
    // Библиотеку голоса грузим заранее, пока человек в меню: на слабом телефоне её разбор занимает 1–2 с,
    // и если делать это посреди игры — экран замирает (замерено 06.10: кадр 2 с при подключении голоса).
    const pre = () => { if (!offline) loadSdk().catch(() => {}); };
    if ('requestIdleCallback' in window) requestIdleCallback(pre, { timeout: 4000 }); else setTimeout(pre, 2500);
  }

  return { init, tick, askMic, speaking, isSpeaking: name => speaking.has(name) };
})();
