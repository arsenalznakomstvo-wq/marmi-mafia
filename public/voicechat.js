'use strict';
// Марми Мафия — голосовой чат с друзьями. Комната по коду приглашения: кто открыл ссылку-приглашение, тот слышит всех своих.
// Голос идёт через LiveKit; библиотека грузится только когда человек сам включил голос.
window.VoiceChat = (() => {
  const SDK = 'https://cdn.jsdelivr.net/npm/livekit-client@2.22.3/dist/livekit-client.umd.js';
  const $ = id => document.getElementById(id);
  const speaking = new Set();       // имена тех, кто сейчас говорит
  let room = null, code = null, micOn = true, connecting = false;
  const invited = (() => { const v = new URLSearchParams(location.search).get('voice'); return v && /^[A-Za-z0-9]{4,12}$/.test(v) ? v.toUpperCase() : null; })();

  function loadSdk() {
    if (window.LivekitClient) return Promise.resolve();
    return new Promise((ok, fail) => { const s = document.createElement('script'); s.src = SDK; s.onload = ok; s.onerror = () => fail(new Error('sdk')); document.head.appendChild(s); });
  }
  function newCode() { const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let c = ''; for (let i = 0; i < 6; i++) c += A[Math.random() * A.length | 0]; return c; }
  const myName = () => (($('nick') && $('nick').value.trim()) || 'Игрок').slice(0, 16);
  const inviteLink = () => location.origin + '/?voice=' + code;

  function status(t, bad) { const el = $('vcStatus'); el.textContent = t || ''; el.style.color = bad ? '#ff7070' : ''; }

  async function join(c) {
    if (connecting || room) return;
    connecting = true; code = c; status('Подключаюсь к голосу…');
    try {
      await loadSdk();
      const r = await fetch('/voice-token?room=' + encodeURIComponent(code) + '&name=' + encodeURIComponent(myName()));
      if (r.status === 503) throw new Error('off');
      if (!r.ok) throw new Error('token');
      const { url, token } = await r.json();
      const L = window.LivekitClient;
      const rm = new L.Room({ audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      rm.on(L.RoomEvent.TrackSubscribed, track => {
        render();
        if (track.kind !== 'audio') return;
        const el = track.attach(); el.style.display = 'none'; document.body.appendChild(el);
      });
      rm.on(L.RoomEvent.TrackUnsubscribed, track => track.detach().forEach(e => e.remove()));
      rm.on(L.RoomEvent.ActiveSpeakersChanged, sp => { speaking.clear(); for (const p of sp) speaking.add(p.name || ''); render(); });
      rm.on(L.RoomEvent.ParticipantConnected, render);
      rm.on(L.RoomEvent.ParticipantDisconnected, render);
      rm.on(L.RoomEvent.AudioPlaybackStatusChanged, render);
      rm.on(L.RoomEvent.TrackMuted, render);
      rm.on(L.RoomEvent.TrackUnmuted, render);
      rm.on(L.RoomEvent.TrackPublished, render);
      rm.on(L.RoomEvent.TrackUnpublished, render);
      rm.on(L.RoomEvent.Disconnected, () => { room = null; speaking.clear(); render(); status('Голос отключён'); });
      await rm.connect(url, token);
      room = rm;
      try { await rm.localParticipant.setMicrophoneEnabled(true); micOn = true; }
      catch (e) { micOn = false; status('Микрофон не разрешён — вы только слушаете. Разрешите микрофон в настройках браузера.', true); }
      try { await rm.startAudio(); } catch (e) {}
      try { history.replaceState(null, '', '/?voice=' + code); } catch (e) {}
      if (micOn) status('');
    } catch (e) {
      room = null;
      status(e.message === 'off' ? 'Голосовой чат пока не настроен на сервере' : 'Не удалось подключиться к голосу. Проверьте интернет и попробуйте ещё раз.', true);
    }
    connecting = false; render();
  }
  async function leave() { if (room) await room.disconnect(); room = null; speaking.clear(); render(); status(''); }
  async function toggleMic() {
    if (!room) return;
    try { micOn = !micOn; await room.localParticipant.setMicrophoneEnabled(micOn); } catch (e) { micOn = false; status('Микрофон не разрешён в браузере', true); }
    try { await room.startAudio(); } catch (e) {}
    render();
  }

  function people() {
    if (!room) return [];
    const list = [{ name: myName() + ' (вы)', key: room.localParticipant.name, mic: micOn }];
    for (const p of room.remoteParticipants.values()) list.push({ name: p.name || '?', key: p.name, mic: p.isMicrophoneEnabled });
    return list;
  }
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function render() {
    const on = !!room;
    $('vcJoin').classList.toggle('hide', on);
    $('vcIn').classList.toggle('hide', !on);
    $('vcInviteNote').classList.toggle('hide', on || !invited);
    $('vcJoin').textContent = invited ? 'Войти в голосовой чат' : 'Создать голосовую комнату';
    if (on) {
      $('vcLink').value = inviteLink();
      $('vcPeople').innerHTML = people().map(p => `<div class="${speaking.has(p.key) ? 'talk' : ''}">${speaking.has(p.key) ? '🔊' : p.mic ? '🎤' : '🔇'} ${esc(p.name)}</div>`).join('');
      $('vcMic').textContent = micOn ? '🎤 Микрофон включён' : '🔇 Микрофон выключен';
    }
    const pill = $('vcPill');
    pill.classList.toggle('hide', !on);
    if (on) pill.textContent = (micOn ? '🎤 ' : '🔇 ') + (room.remoteParticipants.size + 1);
    $('voiceBtn').textContent = on ? '🎧 Голос: ' + (room.remoteParticipants.size + 1) : '🎤 Голос с друзьями';
  }

  function open() { $('vcPanel').classList.remove('hide'); render(); }
  function close() { $('vcPanel').classList.add('hide'); }

  function init() {
    $('voiceBtn').addEventListener('click', open);
    $('vcClose').addEventListener('click', close);
    $('vcJoin').addEventListener('click', () => join(invited || newCode()));
    $('vcLeave').addEventListener('click', leave);
    $('vcMic').addEventListener('click', toggleMic);
    $('vcCopy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(inviteLink()); status('Ссылка скопирована — отправьте её друзьям'); }
      catch (e) { $('vcLink').select(); status('Выделите ссылку и скопируйте'); }
    });
    $('vcShare').addEventListener('click', async () => {
      const text = 'Залетай в Марми Мафию — поиграем и поговорим голосом! ' + inviteLink();
      if (navigator.share) { try { await navigator.share({ title: 'Марми Мафия', text, url: inviteLink() }); } catch (e) {} }
      else location.href = 'https://t.me/share/url?url=' + encodeURIComponent(inviteLink()) + '&text=' + encodeURIComponent('Залетай в Марми Мафию — поиграем и поговорим голосом!');
    });
    const pill = $('vcPill');
    pill.addEventListener('pointerdown', e => { e.stopPropagation(); toggleMic(); });
    if (invited) { $('voiceBtn').classList.add('invite'); }
    render();
  }

  return { init, speaking, isSpeaking: name => speaking.has(name), invited };
})();
