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
  let room = null, connecting = false, micOn = false, offline = false, lowSince = 0;
  // «Не слышать других» (кнопка 🔊) — запоминается на телефоне (владелец 11.10)
  let mutedAll = (() => { try { return localStorage.getItem('mm_vc_mute') === '1'; } catch (e) { return false; } })();
  // Открытый микрофон (владелец 06.10): разрешение спрашиваем при «Играть», дальше микрофон включён сам; 🎤 / V — выключить себя
  let micAllowed = false, wantMic = true;
  // Владелец 11.10 («микрофон на телефоне не включается»): запоминаем, почему не включился, и по нажатию 🎤 объясняем одной строкой
  let micErr = null;
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  // Встроенный браузер Telegram/Instagram/Facebook: микрофон там обычно не работает. Android — WebView («; wv)» в UA),
  // iPhone — встроенный просмотр без слова Safari в UA
  const ua = navigator.userAgent;
  // Владелец 13.10 («на Android динамик не включить»): по отчёту — Яндекс Браузер запретил микрофон. В браузере «откройте в браузере» не помогает —
  // пишем, где разрешить именно в этом браузере
  const browserName = /YaBrowser/.test(ua) ? 'Яндекс Браузер' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /MiuiBrowser/.test(ua) ? 'Mi Браузер' : /OPR\//.test(ua) ? 'Opera' : /Edg/.test(ua) ? 'Edge' : /Firefox/.test(ua) ? 'Firefox' : 'Chrome';
  const deniedText = () => isIOS ? '🎤 Микрофон запрещён. Разрешите: Настройки iPhone → Safari → Микрофон → Разрешить, потом обновите страницу'
    : '🎤 Микрофон запрещён. Разрешите: Настройки телефона → Приложения → ' + browserName + ' → Разрешения → Микрофон → Разрешить. Потом закройте и снова откройте игру';
  const inTelegram = !!window.TelegramWebviewProxy || /Telegram|Instagram|FBAN|FBAV|FB_IAB|Line\//i.test(ua) || /; wv\)/.test(ua) || (isIOS && !/Safari\//.test(ua) && !navigator.standalone); // иконка на экране «Домой» — не встроенный браузер

  function loadSdk() {
    if (window.LivekitClient) return Promise.resolve();
    return new Promise((ok, fail) => { const s = document.createElement('script'); s.src = SDK; s.onload = ok; s.onerror = () => fail(new Error('sdk')); document.head.appendChild(s); });
  }
  /* 15.10 (замер на телефоне владельца: подключение голоса подвешивало игру на 0,7–1,7 с в начале игры): подключение — по шагам,
     каждый в свободное время телефона; а библиотеку голоса прогреваем заранее, пока человек в меню */
  const idle = () => new Promise(r => window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 1500 }) : setTimeout(r, 50));
  let warmed = false;
  function warm() {
    if (warmed) return; warmed = true;
    idle().then(loadSdk).then(idle).then(() => { try { new window.LivekitClient.Room(); } catch (e) {} }).catch(() => { warmed = false; });
  }
  const myName = () => (($('nick') && $('nick').value.trim()) || 'Игрок').slice(0, 16);

  async function connect() {
    if (connecting || room || offline || !ROOM) return;
    connecting = true; const want = ROOM;
    try {
      await loadSdk(); await idle();
      const r = await fetch('/voice-token?room=' + ROOM + '&name=' + encodeURIComponent(myName()));
      if (r.status === 503) { offline = true; throw new Error('off'); }
      if (!r.ok) throw new Error('token');
      const { url, token } = await r.json();
      if (want !== ROOM) throw new Error('room-changed');
      await idle();
      const L = window.LivekitClient;
      const rm = new L.Room({ audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      rm.on(L.RoomEvent.TrackSubscribed, track => {
        if (track.kind !== 'audio') return;
        const el = track.attach(); el.style.display = 'none'; el.muted = mutedAll; document.body.appendChild(el); applyMute(); render();
      });
      rm.on(L.RoomEvent.TrackPublished, () => { applyMute(); render(); });
      for (const ev of ['TrackUnpublished', 'TrackMuted', 'TrackUnmuted']) if (L.RoomEvent[ev]) rm.on(L.RoomEvent[ev], render); // у кого включён микрофон — на панели
      rm.on(L.RoomEvent.TrackUnsubscribed, track => { track.detach().forEach(e => e.remove()); render(); });
      rm.on(L.RoomEvent.ActiveSpeakersChanged, sp => { speaking.clear(); for (const p of sp) speaking.add(p.name || ''); });
      rm.on(L.RoomEvent.ParticipantConnected, render);
      rm.on(L.RoomEvent.ParticipantDisconnected, render);
      rm.on(L.RoomEvent.Disconnected, () => { room = null; micOn = false; speaking.clear(); render(); });
      await idle();
      await rm.connect(url, token);
      room = rm; micOn = false;
      if (!mutedAll) try { await rm.startAudio(); } catch (e) {}
      applyMute();
      if (micAllowed && wantMic) setMic(true);
      setTimeout(() => vcReport('20s'), 20000);
    } catch (e) { room = null; }
    connecting = false; render();
  }
  async function disconnect() { const r = room; room = null; micOn = false; speaking.clear(); if (r) try { await r.disconnect(); } catch (e) {} render(); }

  // Владелец 13.10: «у друга на iPhone не было слышно». iPhone при включении микрофона переключает звук телефона
  // в режим «звонок» — звуки игры замирают, голоса становятся тихими. Заранее ставим режим «разговор» (Safari 17+)
  // и после включения микрофона будим звуки игры.
  function iosSession(on) { try { if (navigator.audioSession) navigator.audioSession.type = on ? 'play-and-record' : 'playback'; } catch (e) {} }
  function wake() { try { if (window.Sound) Sound.init(); } catch (e) {} if (room && !mutedAll) room.startAudio().catch(() => {}); }
  // Отчёт о голосе (виден на /errs): подключился ли, включён ли микрофон, играют ли чужие голоса
  let vcSent = 0;
  function vcReport(why) {
    if (vcSent++ >= 4) return;
    try {
      const au = [...document.querySelectorAll('audio')];
      const msg = 'vc ' + why + ' | ios:' + isIOS + ' room:' + !!room + ' mic:' + micOn + ' err:' + (micErr || '-') + ' others:' + (room ? room.remoteParticipants.size : 0)
        + ' audio:' + au.length + ' paused:' + au.filter(a => a.paused).length + ' canPlay:' + (room ? room.canPlaybackAudio : '-')
        + ' game:' + ((window.Sound && Sound.state && Sound.state()) || '-') + ' mute:' + mutedAll + ' app:' + !!(navigator.standalone || matchMedia('(display-mode: standalone)').matches);
      navigator.sendBeacon('/clienterr', JSON.stringify({ msg, where: 'voice', w: innerWidth, h: innerHeight }));
    } catch (e) {}
  }
  async function setMic(on) {
    if (!room) return;
    if (on && isIOS) iosSession(true);
    try { await room.localParticipant.setMicrophoneEnabled(on); micOn = on; if (on) { micAllowed = true; micErr = null; } }
    catch (e) { micOn = false; micErr = (e && e.name) || 'err'; }
    if (!mutedAll) try { await room.startAudio(); } catch (e) {}
    if (isIOS) setTimeout(wake, 300);
    applyMute();
    render();
    if (on && !micOn) vcReport('mic-fail');
  }
  // Владелец 06.10: сами по себе предупреждения не всплывают — подсказка появляется, только когда человек нажал 🎤, а микрофон не включился
  function toastMic(e) { micErr = (e && e.name) || 'nosupport'; }
  let tipT = 0, flip = () => {};
  function showTip() {
    // Владелец 13.10: «исправь надпись — чтобы включить микрофон, перейдите в браузер или установите игру на телефон»
    const t = (inTelegram || micErr === 'nosupport') ? '🎤 Чтобы включить микрофон, откройте игру в браузере или установите её на телефон'
      : micErr === 'NotAllowedError' ? deniedText()
      : micErr === 'NotReadableError' || micErr === 'AbortError' ? 'Микрофон занят другим приложением (звонок?) — закройте его и нажмите 🎤 ещё раз'
      : micErr === 'NotFoundError' ? 'На устройстве не найден микрофон'
      : 'Микрофон не включился — нажмите 🎤 ещё раз';
    const el = $('vcHint'), denied = micErr === 'NotAllowedError' && !inTelegram;
    // Владелец 13.10 («исправь всё»): запрет микрофона — подсказка висит 20 с, касание закрывает, кнопка «Проверить снова»
    el.innerHTML = ''; el.appendChild(document.createTextNode(t));
    if (denied) { const b = document.createElement('button'); b.className = 'vc-retry'; b.textContent = '🎤 Проверить снова'; b.addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); el.classList.add('hide'); flip(); }); el.appendChild(b); }
    el.classList.remove('hide');
    clearTimeout(tipT); tipT = setTimeout(() => el.classList.add('hide'), denied ? 20000 : 6000);
  }
  // Вызывается при нажатии «Играть» (это касание — браузер разрешает спросить микрофон). Спрашиваем один раз.
  async function askMic() {
    if (micAllowed || offline) return;
    if (isIOS) iosSession(true);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toastMic(); return; }
    try {
      const st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      st.getTracks().forEach(t => t.stop());
      micAllowed = true;
      if (room && wantMic) setMic(true);
    } catch (e) { toastMic(e); }
  }
  // Владелец 11.10: «отключаю — всё равно слышу». LiveKit при каждом startAudio() (а мы зовём его на каждое касание экрана,
  // чтобы звук заработал на телефоне) сам снимает muted со всех голосов. Теперь «не слышать» — по-настоящему:
  // сервер голоса перестаёт присылать нам чужие голоса (setEnabled(false)), плюс громкость 0 и muted как запас.
  function applyMute() {
    if (room) for (const p of room.remoteParticipants.values()) {
      try { p.setVolume(mutedAll ? 0 : 1); } catch (e) {}
      for (const pub of p.audioTrackPublications.values()) { try { pub.setEnabled(!mutedAll); } catch (e) {} }
    }
    document.querySelectorAll('audio').forEach(a => { a.muted = mutedAll; });
  }
  function setMutedAll(m) {
    mutedAll = m; try { localStorage.setItem('mm_vc_mute', m ? '1' : '0'); } catch (e) {}
    applyMute(); if (!m && room) room.startAudio().catch(() => {});
    render();
  }

  // Вызывается из игры раз в секунду. Голос держим, пока человек на странице и уже играл (в меню после смерти — тоже,
  // чтобы можно было сказать «кто меня съел?!»). Отключаемся, если на сайте больше никого нет или вкладка скрыта дольше минуты.
  let played = false, hiddenSince = 0;
  document.addEventListener('visibilitychange', () => { hiddenSince = document.hidden ? Date.now() : 0; });
  function tick(alive, online) {
    renderHelp();
    if (offline) return;
    if (alive) played = true;
    else if (!played && online >= 2 && ROOM) warm(); // в меню: прогрев, чтобы в игре подключение не подвешивало
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
      $('micHelpText').textContent = '🎤 Голосовой чат и установка — в браузере';
      const b = $('micOpen'); b.classList.remove('hide');
      if (!b.dataset.done) b.textContent = /Android/i.test(ua) ? 'Открыть в браузере' : 'Скопировать ссылку';
    } else if (denied) { $('micHelpText').textContent = deniedText(); $('micOpen').classList.add('hide'); }
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
    // Владелец 13.10: видно, сколько человек в голосе и у скольких включён микрофон — «не слышно» сразу понятно почему
    let mics = micOn ? 1 : 0;
    for (const p of room.remoteParticipants.values()) try { if (p.isMicrophoneEnabled) mics++; } catch (e) {}
    $('vcCount').textContent = '🎧 ' + n + ' · 🎤 ' + mics;
    $('vcCount').title = 'В голосовом чате: ' + n + ', говорить могут (микрофон включён): ' + mics;
  }

  function init() {
    // V (компьютер) и кнопка 🎤 — выключить/включить свой микрофон
    // Раньше при включении askMic и setMic спрашивали микрофон одновременно и мешали друг другу — теперь один запрос
    flip = async () => {
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
    $('vcHint').addEventListener('pointerdown', e => { e.stopPropagation(); if (!e.target.closest('.vc-retry')) $('vcHint').classList.add('hide'); }); // касание подсказки — закрыть
    $('vcMicBtn').addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); flip(); });
    $('vcMuteBtn').addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); setMutedAll(!mutedAll); });
    // Браузеры включают звук только после касания — на любом касании пробуем включить
    const unlock = () => { if (room && !mutedAll) room.startAudio().catch(() => {}); if (isIOS) try { if (window.Sound) Sound.init(); } catch (e) {} }; // выключил всех — касание не включает обратно
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
  window.__vc = () => ({ mutedAll, room: !!room, audios: [...document.querySelectorAll('audio')].map(a => a.muted), // для проверки
    pubs: room ? [...room.remoteParticipants.values()].flatMap(p => [...p.audioTrackPublications.values()].map(x => x.isEnabled)) : [] });
  return { init, tick, askMic, setRoom, speaking, isSpeaking: name => speaking.has(name) };
})();
