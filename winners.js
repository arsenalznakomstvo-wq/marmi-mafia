'use strict';
// Марми Мафия — фото на карточках победителей (владелец 11.10). Игрок из топ-5 рекордов всех времён
// после игры может поставить своё фото на карточку в меню. Поставить фото может только тот, кто сам
// заработал место: сервер выдаёт ему одноразовый пропуск (на 30 минут), без пропуска фото не примется.
// Хранилище — тот же Upstash Redis, что у рекордов; без него фото живут в памяти до перезапуска сервера.
// Владелец может убрать неприличное фото: /wp-del?key=STATS_KEY&n=НИК
const crypto = require('crypto');

const URL_ = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const OWNER_KEY = process.env.STATS_KEY || '';
const enabled = () => !!(URL_ && TOKEN);
const PREFIX = 'mm:wp:';
const MAX_BYTES = 120 * 1024;   // браузер сам сжимает фото до 320×320 (~25 КБ), это с запасом

const photos = new Map();  // ник -> { buf, ver }
const invites = new Map(); // пропуск -> { name, exp }

async function redis(cmd) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error('upstash ' + r.status);
  return (await r.json()).result;
}
// При запуске подгружаем фото тех, кто сейчас в рекордах
async function load(names) {
  if (!enabled()) return;
  for (const name of names) {
    try {
      const v = await redis(['GET', PREFIX + name]);
      if (v) { const { b, ver } = JSON.parse(v); photos.set(name, { buf: Buffer.from(b, 'base64'), ver }); }
    } catch (e) { console.log('фото победителей: не удалось загрузить', name, e.message); }
  }
  if (photos.size) console.log('фото победителей загружены:', photos.size);
}
function save(name, buf) {
  const ver = Date.now() % 1e9;
  photos.set(name, { buf, ver });
  if (enabled()) redis(['SET', PREFIX + name, JSON.stringify({ b: buf.toString('base64'), ver })]).catch(e => console.log('фото победителей: не удалось сохранить', e.message));
  return ver;
}
function remove(name) {
  photos.delete(name);
  if (enabled()) redis(['DEL', PREFIX + name]).catch(() => {});
}
// Выпал из топ-5 — его фото больше нигде не показывается, удаляем
function prune(keep) {
  const k = new Set(keep);
  for (const name of [...photos.keys()]) if (!k.has(name)) remove(name);
}
const ver = name => (photos.get(name) || {}).ver || 0;
function invite(name) {
  const now = Date.now();
  for (const [t, v] of invites) if (v.exp < now) invites.delete(t);
  const t = crypto.randomBytes(12).toString('hex');
  invites.set(t, { name, exp: now + 30 * 60e3 });
  return t;
}

// Возвращает true, если запрос был к фото победителей. isTop(name) — ник всё ещё в топ-5
function handle(req, res, url, isTop) {
  if (url !== '/wp' && url !== '/wp-del') return false;
  const q = new URL(req.url, 'http://x').searchParams;
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  if (url === '/wp-del') {
    const key = q.get('key') || '';
    if (!OWNER_KEY || key.length !== OWNER_KEY.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(OWNER_KEY))) { send(404, { error: 'not-found' }); return true; }
    const name = q.get('n') || '';
    const had = photos.has(name); remove(name);
    send(200, { ok: true, removed: had ? name : null });
    return true;
  }
  if (req.method === 'GET') {
    const p = photos.get(q.get('n') || '');
    if (!p) { res.writeHead(404); res.end(); return true; }
    // ссылка содержит версию фото (&v=…), поэтому браузер может хранить его долго
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': p.buf.length, 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.end(p.buf);
    return true;
  }
  if (req.method !== 'POST') { send(405, { error: 'method' }); return true; }
  const inv = invites.get(q.get('t') || '');
  if (!inv || inv.exp < Date.now()) { req.resume(); send(403, { error: 'expired' }); return true; }
  if (!isTop(inv.name)) { req.resume(); send(403, { error: 'not-top' }); return true; }
  const chunks = []; let size = 0, tooBig = false;
  req.on('data', d => { size += d.length; if (size > MAX_BYTES) { tooBig = true; req.destroy(); } else chunks.push(d); });
  req.on('end', () => {
    if (tooBig) return;
    const buf = Buffer.concat(chunks);
    if (buf.length < 500 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) { send(400, { error: 'not-jpeg' }); return; } // только JPEG
    send(200, { ok: true, ver: save(inv.name, buf), name: inv.name });
  });
  return true;
}

module.exports = { load, prune, ver, has: name => photos.has(name), invite, handle };
