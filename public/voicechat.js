'use strict';
// Марми Мафия — общий голосовой чат для всех, кто в игре, как в Counter-Strike (владелец 06.10).
// Нажал «Играть» — слышишь всех и говоришь (открытый микрофон). Выключить себя: V или кнопка 🎤.
// Чтобы не тратить бесплатные минуты LiveKit: подключаемся, только если человек уже играл и на сайте есть ещё кто-то.
window.VoiceChat = (() => {
  const SDK = 'https://cdn.jsdelivr.net/npm/livekit-client@2.22.3/dist/livekit-client.umd.js';
  let ROOM = new URLSearchParams(location.search).get('mode') === 'team' ? null : 'GLOBAL'; // в командах — комната своей команды (setRoom)
  const $ = id => document.getElementById(id);
  const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  const speaking = new Set();
  let room = null, connecting = false, micOn = false, mutedAll = false, offline = false, lowSince = 0;
  // Открытый микрофон (владелец 06.10): разрешение спрашиваем при «Играть», дальше микрофон включён сам; 🎤 / V — выключить себя
  let micAllowed = false, wantMic = true;
  // Владелец 11.10 («микрофон на телефоне не включается»): запоминаем, почему не включился, и по нажатию 🎤 объясняем одной строкой
  let micErr = null;
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  // Встроенный браузер Telegram/Instagram/Facebook: микрофон там обычно не работает. Android — WebView («; wv)» в UA),
  // iPhone — встроенный просмотр без слова Safari в UA
  const ua = navigator.userAgent;
  const inTelegram = !!window.TelegramWebviewProxy || /Telegram|Instagram|FBAN|FBAV|FB_IAB|Line\//i.test(ua) || /; wv\)/.test(ua) || (isIOS && !/Safari\//.test(ua) && !navigator.standalone); // иконка на экране «Домой» — не встроенный браузер

  function loadSdk() {
    if (window.LivekitClient) return Promise.resolve();
    return new Promise((ok, fail) => { const s = document.createElement('script'); s.src = SDK; s.onload = ok; s.onerror = () => fail(new Error('sdk')); document.head.appendChild(s); });
  }
  const myName = () => (($('nick') && $('nick').value.trim()) || 'Игрок').slice(0, 16);

  async function connect() {
    if (connecting || room || offline || !ROOM) return;
    connecting = true; const want = ROOM;
    try {
      await loadSdk();
      const r = await fetch('/voice-token?room=' + ROOM + '&name=' + encodeURIComponent(myName()));
      if (r.status === 503) { offline = true; throw new Error('off'); }
      if (!r.ok) throw new Error('token');
      const { url, token } = await r.json();
      if (want !== ROOM) throw new Error('room-changed');
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
    try { await room.localParticipant.setMicrophoneEnabled(on); micOn = on; if (on) { micAllowed = true; micErr = null; } }
    catch (e) { micOn = false; micErr = (e && e.name) || 'err'; }
    try { await room.startAudio(); } catch (e) {}
    render();
  }
  // Владелец 06.10: сами по себе предупреждения не всплывают — подсказка появляется, только когда человек нажал 🎤, а микрофон не включился
  function toastMic(e) { micErr = (e && e.name) || 'nosupport'; }
  let tipT = 0;
  function showTip() {
    const t = (inTelegram || micErr === 'nosupport') ? 'Микрофон работает только в браузере — откройте игру в Chrome или Safari'
      : micErr === 'NotAllowedError' ? (isIOS ? 'Микрофон запрещён: Настройки → Safari → Микрофон → Разрешить, затем обновите страницу'
        : 'Микрофон запрещён: нажмите 🔒 слева от адреса сайта → Разрешения → Микрофон')
      : micErr === 'NotReadableError' || micErr === 'AbortError' ? 'Микрофон занят другим приложением (звонок?) — закройте его и нажмите 🎤 ещё раз'
      : micErr === 'NotFoundError' ? 'На устройстве не найден микрофон'
      : 'Микрофон не включился — нажмите 🎤 ещё раз';
    const el = $('vcHint'); el.textContent = t; el.classList.remove('hide');
    clearTimeout(tipT); tipT = setTimeout(() => el.classList.add('hide'), 6000);
  }
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
    renderHelp();
    if (offline) return;
    if (alive) played = true;
    const hiddenLong = hiddenSince && Date.now() - hiddenSince > 60000;
    const want = played && online >= 2 && !hiddenLong && !!ROOM;
    if (want) { lowSince = 0; if (!room) connect(); }
    else if (room) {
      if (hiddenLong) disconnect();
      else { if (!lowSince) lowSince = Date.now(); if (Date.now() - lowSince > 15000) disconnect(); } // остался один — ждём 15 с, вдруг кто-то зайдёт
    }
  }

  // Владелец 11.10: короткая строка в меню (под «Играть») для тех, у кого микрофон не работает:
  // во встроенном браузере — «откройте в браузере» с кнопкой; в обычном, но запрещён — где разрешить
  function renderHelp() {
    const el = $('micHelp'); if (!el) return;
    const inMenu = document.body.classList.contains('in-menu');
    const app = inTelegram || micErr === 'nosupport', denied = !app && micErr === 'NotAllowedError';
    el.classList.toggle('hide', !inMenu || offline || !(app || denied));
    if (app) {
      $('micHelpText').textContent = '🎤 Микрофон работает только в браузере';
      const b = $('micOpen'); b.classList.remove('hide');
      if (!b.dataset.done) b.textContent = /Android/i.test(ua) ? 'Открыть в браузере' : 'Скопировать ссылку';
    } else if (denied) { $('micHelpText').textContent = '🎤 Микрофон запрещён — разрешите его в настройках сайта'; $('micOpen').classList.add('hide'); }
  }
  function openInBrowser() {
    const url = location.origin + location.pathname, b = $('micOpen');
    if (/Android/i.test(ua)) { // Android: сразу в Chrome; если Chrome нет — откроется обычная ссылка
      location.href = 'intent://' + location.host + location.pathname + '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(url) + ';end';
      return;
    }
    const done = () => { b.dataset.done = '1'; b.textContent = '✅ Скопировано — вставьте в Safari'; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, () => prompt('Скопируйте ссылку и откройте в Safari:', url));
    else prompt('Скопируйте ссылку и откройте в Safari:', url);
  }
  function render() {
    renderHelp();
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
    // Раньше при включении askMic и setMic спрашивали микрофон одновременно и мешали друг другу — теперь один запрос
    const flip = async () => {
      wantMic = !micOn;
      if (wantMic && (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)) { micErr = 'nosupport'; showTip(); return; }
      await setMic(wantMic);
      if (wantMic && !micOn) showTip();
    };
    window.addEventListener('keydown', e => {
      if (e.code !== 'KeyV' || e.repeat || !room || document.activeElement === $('nick')) return;
      flip();
    });
    $('micOpen').addEventListener('click', openInBrowser);
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

  // Командный режим: голос только внутри своей команды; сменилась команда — переподключимся в новую комнату
  function setRoom(r) { if (r === ROOM) return; ROOM = r; if (room) disconnect(); }
  return { init, tick, askMic, setRoom, speaking, isSpeaking: name => speaking.has(name) };
})();
