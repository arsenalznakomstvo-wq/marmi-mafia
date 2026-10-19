'use strict';
// Марми Мафия — страница владельца /owner?key=… (владелец 17.10: «узнать, кто играл — вижу только я»).
// Кто сейчас в игре, список игр (ник, когда, сколько минут, длина, устройство) и итоги по игрокам за день / неделю / месяц.
// Хранятся только ник и тип устройства — без адресов и прочего личного. В коде лежит лишь отпечаток ключа (sha-256), сам ключ — у владельца.
const crypto = require('crypto');

const KEY_HASH = '48957d132cc274d481d04ec29a952d99ce65ffc121187c4ea6188f48b563d5e1';
const R_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, ''), R_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const LIST = 'mm:sessions', MAX = 3000, KEEP_MS = 30 * 864e5;
const games = []; // новые — первыми

async function redis(cmd) {
  const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + R_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error('upstash ' + r.status); return (await r.json()).result;
}
async function load() {
  if (!R_URL || !R_TOKEN) return;
  try { const arr = await redis(['LRANGE', LIST, '0', String(MAX - 1)]); for (const s of arr || []) try { games.push(JSON.parse(s)); } catch (e) {} } catch (e) {}
}
const devOf = ua => /iPhone|iPad|iPod/i.test(ua) ? 'iPhone' : /Android/i.test(ua) ? 'Android' : 'Компьютер';

// игра началась / закончилась (смерть или выход)
function start(s, c, app, tg) { s.sess = { n: s.name, t: Date.now(), d: devOf(c.ua || ''), a: tg ? 2 : app ? 1 : 0 }; } // a: 1 — установленная игра, 2 — через Telegram
function finish(s) {
  const q = s.sess; if (!q) return; s.sess = null;
  q.s = Math.round((Date.now() - q.t) / 1000); q.m = Math.round(Math.max(s.maxMass || 0, s.mass || 0)); q.k = s.kills || 0;
  if (q.s < 5) return; // случайный вход на пару секунд — не считаем
  games.unshift(q); if (games.length > MAX) games.length = MAX;
  if (R_URL && R_TOKEN) redis(['LPUSH', LIST, JSON.stringify(q)]).then(() => redis(['LTRIM', LIST, '0', String(MAX - 1)])).catch(() => {});
}

// ===== страница =====
const TZ = 5 * 3600e3; // Ташкент
const dayOf = t => new Date(t + TZ).toISOString().slice(0, 10);
const hm = t => new Date(t + TZ).toISOString().slice(11, 16);
const dm = t => { const d = new Date(t + TZ); return String(d.getUTCDate()).padStart(2, '0') + '.' + String(d.getUTCMonth() + 1).padStart(2, '0'); };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const dur = sec => sec < 60 ? sec + ' с' : sec < 3600 ? Math.round(sec / 60) + ' мин' : Math.floor(sec / 3600) + ' ч ' + Math.round(sec % 3600 / 60) + ' мин';
const devIcon = (d, a) => (d === 'iPhone' ? '🍏 iPhone' : d === 'Android' ? '🤖 Android' : '💻 Компьютер') + (a === 2 ? ' · Telegram' : a ? ' · приложение' : '');
const PERIODS = { today: 'Сегодня', yesterday: 'Вчера', week: '7 дней', month: '30 дней' };

function page(period, key, live) {
  const now = Date.now(), today = dayOf(now), yest = dayOf(now - 864e5);
  const inP = g => period === 'today' ? dayOf(g.t) === today : period === 'yesterday' ? dayOf(g.t) === yest : period === 'week' ? now - g.t < 7 * 864e5 : now - g.t < KEEP_MS;
  const list = games.filter(inP);
  const by = new Map();
  for (const g of list) {
    const p = by.get(g.n) || { n: g.n, games: 0, sec: 0, best: 0, last: 0, devs: new Set() };
    p.games++; p.sec += g.s; p.best = Math.max(p.best, g.m); p.last = Math.max(p.last, g.t + g.s * 1000); p.devs.add(devIcon(g.d, g.a)); by.set(g.n, p);
  }
  const players = [...by.values()].sort((a, b) => b.sec - a.sec);
  const tabs = Object.entries(PERIODS).map(([k, t]) => `<a class="${k === period ? 'on' : ''}" href="/owner?key=${encodeURIComponent(key)}&p=${k}">${t}</a>`).join('');
  const liveRows = live.length ? live.map(x => `<tr><td>${esc(x.n)}</td><td>${x.m}</td><td>${dur(Math.round((now - x.t) / 1000))}</td><td>${devIcon(x.d, x.a)}</td></tr>`).join('') : '<tr><td colspan="4" class="mute">Сейчас никого нет</td></tr>';
  const plRows = players.length ? players.map(p => `<tr><td>${esc(p.n)}</td><td>${p.games}</td><td>${dur(p.sec)}</td><td>${p.best}</td><td>${dm(p.last)} ${hm(p.last)}</td><td class="sm">${[...p.devs].join('<br>')}</td></tr>`).join('') : '<tr><td colspan="6" class="mute">За этот период игр нет</td></tr>';
  const gRows = list.slice(0, 500).map(g => `<tr><td>${dm(g.t)} ${hm(g.t)}</td><td>${esc(g.n)}</td><td>${dur(g.s)}</td><td>${g.m}</td><td>${g.k || 0}</td><td class="sm">${devIcon(g.d, g.a)}</td></tr>`).join('') || '<tr><td colspan="6" class="mute">За этот период игр нет</td></tr>';
  const totalSec = list.reduce((a, g) => a + g.s, 0);
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Кто играл — Марми Мафия</title><style>
:root{--bg:#0f1218;--card:#181d26;--line:#262d3a;--txt:#e8ecf1;--mute:#8a93a8;--acc:#ffd52e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:15px/1.4 Arial,sans-serif;padding:16px;max-width:980px;margin:0 auto}
h1{font-size:22px;margin:4px 0 12px}h2{font-size:17px;margin:22px 0 8px}.mute{color:var(--mute)}.sm{font-size:13px;color:var(--mute)}
.tabs{display:flex;gap:6px;flex-wrap:wrap}.tabs a{color:var(--txt);text-decoration:none;padding:7px 12px;border-radius:16px;background:var(--card);border:1px solid var(--line)}
.tabs a.on{background:var(--acc);color:#111;border-color:var(--acc);font-weight:bold}
.sum{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}.sum div{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px}.sum b{display:block;font-size:20px;color:var(--acc)}
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px}table{border-collapse:collapse;width:100%;min-width:520px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mute);font-weight:normal;font-size:13px;background:var(--card)}
tr:last-child td{border-bottom:none}</style></head><body>
<h1>👑 Кто играл</h1><div class="tabs">${tabs}</div>
<div class="sum"><div><b>${players.length}</b>игроков</div><div><b>${list.length}</b>игр</div><div><b>${dur(totalSec)}</b>всего в игре</div><div><b>${live.length}</b>сейчас в игре</div></div>
<h2>🟢 Сейчас в игре</h2><div class="wrap"><table><tr><th>Ник</th><th>Длина</th><th>Играет</th><th>Устройство</th></tr>${liveRows}</table></div>
<h2>👥 Игроки — ${PERIODS[period].toLowerCase()}</h2><div class="wrap"><table><tr><th>Ник</th><th>Игр</th><th>Всего в игре</th><th>Лучшая длина</th><th>Последний раз</th><th>Устройство</th></tr>${plRows}</table></div>
<h2>🕹 Все игры — ${PERIODS[period].toLowerCase()}</h2><div class="wrap"><table><tr><th>Когда</th><th>Ник</th><th>Сколько</th><th>Длина</th><th>Убил</th><th>Устройство</th></tr>${gRows}</table></div>
<p class="sm">Время — ташкентское. Хранятся последние 30 дней. Игры короче 5 секунд не считаются.</p></body></html>`;
}
function handle(req, res, url, liveFn) {
  if (url !== '/owner') return false;
  const q = new URL(req.url, 'http://x').searchParams, key = q.get('key') || '';
  if (crypto.createHash('sha256').update(key).digest('hex') !== KEY_HASH) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Нет доступа'); return true; }
  const period = PERIODS[q.get('p')] ? q.get('p') : 'today';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  res.end(page(period, key, liveFn()));
  return true;
}
module.exports = { load, start, finish, handle };
