'use strict';
// Марми Мафия — рекорды дня и всех времён (владелец 06.10). Считаются только живые игроки.
// Хранилище — Upstash Redis по REST (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN в настройках Render).
// Без этих настроек рекорды живут в памяти и пропадают, когда бесплатный сервер засыпает.
const URL_ = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const enabled = () => !!(URL_ && TOKEN);
const TOP = 5;
// Командная арена (TEAM_MODE=1) ведёт свои рекорды отдельно (владелец 07.10)
const KEY = process.env.TEAM_MODE === '1' ? 'mm:trec' : 'mm:rec';

const dayOf = t => new Date(t + 5 * 3600e3).toISOString().slice(0, 10); // ташкентская дата
let day = dayOf(Date.now());
let today = [], allTime = [];   // [{ name, score, at }] по убыванию, один лучший результат на ник
let dirty = false;

async function redis(cmd) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error('upstash ' + r.status);
  return (await r.json()).result;
}
async function load() {
  if (!enabled()) return;
  try {
    const [a, d] = await Promise.all([redis(['GET', KEY + ':all']), redis(['GET', KEY + ':day:' + day])]);
    if (a) allTime = JSON.parse(a);
    if (d) today = JSON.parse(d);
    console.log('рекорды загружены: всех времён', allTime.length, ', сегодня', today.length);
  } catch (e) { console.log('рекорды: не удалось загрузить', e.message); }
}
async function save() {
  if (!enabled() || !dirty) return;
  dirty = false;
  try {
    await redis(['SET', KEY + ':all', JSON.stringify(allTime)]);
    await redis(['SET', KEY + ':day:' + day, JSON.stringify(today), 'EX', String(3 * 86400)]);
  } catch (e) { dirty = true; console.log('рекорды: не удалось сохранить', e.message); }
}
setInterval(save, 10000);

function put(list, name, score) {
  const i = list.findIndex(r => r.name === name);
  if (i >= 0) { if (list[i].score >= score) return false; list.splice(i, 1); }
  list.push({ name, score, at: Date.now() });
  list.sort((a, b) => b.score - a.score);
  const kept = list.indexOf(list.find(r => r.name === name)) < TOP;
  list.length = Math.min(list.length, TOP);
  return kept;
}
// Сообщить длину живого игрока. Возвращает 'all' / 'day' / null — какой рекорд он только что побил (первое место).
function report(name, score) {
  const d = dayOf(Date.now());
  if (d !== day) { day = d; today = []; }
  score = Math.floor(score);
  if (score < 50) return null;
  const wasDay = today[0] ? today[0].score : 0, wasAll = allTime[0] ? allTime[0].score : 0;
  const ch1 = put(today, name, score), ch2 = put(allTime, name, score);
  if (ch1 || ch2) { dirty = true; if (onChange) onChange(); }
  if (score < 500) return null; // поздравляем только с заметным рекордом
  if (score > wasAll && allTime[0] && allTime[0].name === name && wasAll > 0) return 'all';
  if (score > wasDay && today[0] && today[0].name === name && wasDay > 0) return 'day';
  return null;
}
const view = () => ({ day: today.map(r => [r.name, r.score]), all: allTime.map(r => [r.name, r.score]), saved: enabled() });

// Командная арена — отдельный процесс, который засыпает без игроков: рекорды хранит основной процесс (dump/restore)
let onChange = null;
const dump = () => ({ day, today, allTime });
function restore(d) {
  if (!d) return;
  if (d.day === day) for (const r of d.today || []) put(today, r.name, r.score);
  for (const r of d.allTime || []) put(allTime, r.name, r.score);
}
module.exports = { load, report, view, enabled, dump, restore, setOnChange: f => { onChange = f; } };
