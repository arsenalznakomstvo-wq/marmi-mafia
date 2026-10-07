'use strict';
// Марми Мафия — статистика для владельца: страница /stats?key=… (ключ — в переменной окружения STATS_KEY).
// Хранится в памяти: на бесплатном Render сервер засыпает без игроков и всё обнуляется.
const crypto = require('crypto');

const KEY = process.env.STATS_KEY || '';
const SALT = crypto.randomBytes(16).toString('hex'); // адреса не храним в открытом виде — только хеш с солью
const startedAt = Date.now();

// «Сегодня» — по ташкентскому времени (UTC+5)
const dayOf = t => new Date(t + 5 * 3600e3).toISOString().slice(0, 10);
const hourOf = t => new Date(t + 5 * 3600e3).getUTCHours();

let day = dayOf(Date.now());
let today = fresh();
function fresh() { return { visitors: new Set(), players: new Set(), games: 0, peakInGame: 0, peakOnline: 0, phone: new Set(), pc: new Set(), hours: new Array(24).fill(0) }; }
function roll() { const d = dayOf(Date.now()); if (d !== day) { day = d; today = fresh(); } }
// Владелец 07.10: посетители за день / 7 дней / 30 дней (уникальные отпечатки по дням; в памяти — при обновлении обнуляется)
const byDay = new Map(); // 'ГГГГ-ММ-ДД' -> Set(отпечаток)
function visits() {
  roll();
  const now = Date.now(), w = new Set(), m = new Set();
  for (const [d, set] of byDay) {
    const age = Math.round((Date.parse(day) - Date.parse(d)) / 864e5);
    if (age > 30) { byDay.delete(d); continue; }
    for (const id of set) { m.add(id); if (age < 7) w.add(id); }
  }
  void now;
  return [today.visitors.size, w.size, m.size];
}

function visitorId(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const ua = String(req.headers['user-agent'] || '');
  return { id: crypto.createHash('sha256').update(SALT + ip + ua).digest('hex').slice(0, 16), phone: /Mobi|Android|iPhone|iPad/i.test(ua) };
}

// Вызывается при подключении браузера
function onConnect(c, req) {
  roll();
  const v = visitorId(req);
  c.statId = v.id;
  today.visitors.add(v.id);
  let ds = byDay.get(day); if (!ds) { ds = new Set(); byDay.set(day, ds); } ds.add(v.id);
  (v.phone ? today.phone : today.pc).add(v.id);
}
// Вызывается, когда человек нажал «Играть»
function onJoin(c) {
  roll();
  today.games++;
  if (c.statId) today.players.add(c.statId);
}
// Вызывается раз в полсекунды с текущими цифрами
function sample(inGame, online) {
  roll();
  if (inGame > today.peakInGame) today.peakInGame = inGame;
  if (online > today.peakOnline) today.peakOnline = online;
  const h = hourOf(Date.now());
  if (inGame > today.hours[h]) today.hours[h] = inGame;
}

function fmtDur(ms) { const m = Math.floor(ms / 60000); return m < 60 ? m + ' мин' : Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин'; }

// Отдаёт страницу; возвращает true, если запрос был к /stats
function handle(req, res, url, live) {
  if (url !== '/stats') return false;
  const q = new URL(req.url, 'http://x').searchParams.get('key') || '';
  const ok = KEY && q.length === KEY.length && crypto.timingSafeEqual(Buffer.from(q), Buffer.from(KEY));
  if (!ok) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); return true; }
  roll();
  const now = Date.now(), h = hourOf(now);
  const bars = today.hours.map((v, i) => i > h ? '' : `<div class="b"><i style="height:${Math.min(100, v * 10)}%"></i><span>${v || ''}</span><em>${i}</em></div>`).join('');
  const L = live();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10"><title>Статистика · Марми Мафия</title><style>
body{margin:0;background:#161c22;color:#e8ecf1;font:15px/1.5 Arial,sans-serif;padding:16px}h1{font-size:20px;margin:0 0 12px;color:#5fd17a}
.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;max-width:760px}
.c{background:#1f2730;border-radius:12px;padding:12px}.c b{display:block;font-size:30px;color:#fff}.c small{color:#8a93a8}
.big b{color:#ffd54f}h2{font-size:15px;color:#8a93a8;margin:18px 0 6px}
.ch{display:flex;gap:3px;align-items:flex-end;height:120px;max-width:760px;background:#1f2730;border-radius:12px;padding:10px 10px 22px}
.b{flex:1;height:100%;position:relative;display:flex;flex-direction:column;justify-content:flex-end}.b i{display:block;background:#5fd17a;border-radius:3px 3px 0 0;min-height:1px}
.b span{position:absolute;top:-2px;left:0;right:0;text-align:center;font-size:10px;color:#fff}.b em{position:absolute;bottom:-18px;left:0;right:0;text-align:center;font-size:9px;color:#8a93a8;font-style:normal}
p{color:#8a93a8;font-size:12px;max-width:760px}</style></head><body>
<h1>🐍 Марми Мафия — статистика</h1>
<div class="g">
<div class="c big"><b>${L.inGame}</b><small>людей играют сейчас</small></div>
<div class="c"><b>${L.inMenu}</b><small>в меню сейчас</small></div>
<div class="c"><b>${L.bots}</b><small>ботов на карте</small></div>
</div>
<h2>Сегодня (${day})</h2>
<div class="g">
<div class="c"><b>${today.visitors.size}</b><small>разных людей открыли игру</small></div>
<div class="c"><b>${today.players.size}</b><small>из них начали играть</small></div>
<div class="c"><b>${today.games}</b><small>игр сыграно</small></div>
<div class="c"><b>${today.peakInGame}</b><small>максимум одновременно в игре</small></div>
<div class="c"><b>${today.phone.size} / ${today.pc.size}</b><small>с телефона / с компьютера</small></div>
</div>
<h2>Максимум игроков по часам (ташкентское время)</h2>
<div class="ch">${bars}</div>
<p>Сервер работает без перерыва ${fmtDur(now - startedAt)}. Бесплатный сервер засыпает через 15 минут без игроков — тогда цифры «сегодня» обнуляются.
Страница обновляется сама каждые 10 секунд.</p>
</body></html>`);
  return true;
}

module.exports = { onConnect, onJoin, sample, handle, visits, enabled: () => !!KEY };
