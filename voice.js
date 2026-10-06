'use strict';
// Марми Мафия — голосовой чат с друзьями через LiveKit.
// Сервер только выдаёт пропуск (подписанный токен) в комнату по коду приглашения; сам голос идёт через LiveKit.
// Ключи — в переменных окружения (Render → Environment), в коде их нет: проект открытый.
const crypto = require('crypto');

const URL_ = process.env.LIVEKIT_URL || '';
const KEY = process.env.LIVEKIT_API_KEY || '';
const SECRET = process.env.LIVEKIT_API_SECRET || '';
const enabled = () => !!(URL_ && KEY && SECRET);

const b64url = buf => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// Пропуск LiveKit — JWT, подписанный секретом (HS256). Разрешаем только микрофон и слушать других.
function makeToken(room, identity, name) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: KEY, sub: identity, name, nbf: now - 10, exp: now + 6 * 3600,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false, canPublishSources: ['microphone'] },
  };
  const body = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  return body + '.' + b64url(crypto.createHmac('sha256', SECRET).update(body).digest());
}

// Не больше 20 пропусков в минуту с одного адреса
const hits = new Map();
function tooMany(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now(), h = hits.get(ip) || [];
  const recent = h.filter(t => now - t < 60000);
  recent.push(now); hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > 20;
}

// GET /voice-token?room=КОД&name=ИМЯ → { url, token }; возвращает true, если запрос был к нему
function handle(req, res, url, cleanName) {
  if (url !== '/voice-token') return false;
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  if (!enabled()) { send(503, { error: 'voice-off' }); return true; }
  if (tooMany(req)) { send(429, { error: 'slow-down' }); return true; }
  const q = new URL(req.url, 'http://x').searchParams;
  const code = String(q.get('room') || '');
  if (!/^[A-Za-z0-9]{4,12}$/.test(code)) { send(400, { error: 'bad-room' }); return true; }
  const name = cleanName(q.get('name'));
  const identity = name + '#' + crypto.randomBytes(3).toString('hex');
  send(200, { url: URL_, token: makeToken('mm-' + code.toUpperCase(), identity, name) });
  return true;
}

module.exports = { handle, enabled, makeToken };
