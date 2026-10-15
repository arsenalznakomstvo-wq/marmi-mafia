'use strict';
// Марми Мафия — сервер. Ведёт одну общую карту: змейки игроков, боты, еда.
// Телефоны и компьютеры только рисуют картинку и присылают, куда повернуть.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer, WebSocket } = require('ws');
const { spawn } = require('child_process');
const { SKINS, MAX_PATTERN, skinCols, EYE_ID, EYE_ZOOM, TEETH_ID, TEETH_MAX, NINJA_ID } = require('./public/skins.js');
const stats = require('./stats.js');
const voice = require('./voice.js');
const records = require('./records.js');
const winners = require('./winners.js');
// Рекорды для браузера: у топ-5 всех времён третьим числом — версия фото на карточке (0 — фото нет)
const recView = () => { const v = records.view(); if (!TEAM) v.all = v.all.map(([n, s]) => [n, s, winners.ver(n)]); return v; };

// ===== Настройки =====
const PORT = Number(process.env.PORT) || 7777; // 8080 занят сайтом бота недвижимости
// ===== Командный режим (владелец 07.10): отдельная арена «Мирные (белые) против Мафии (чёрно-оранжевые)» — этот же файл, запущенный с TEAM_MODE=1 =====
const TEAM = process.env.TEAM_MODE === '1';
// Владелец 07.10: командная игра: выключалась 07.10 из-за лагов на бесплатном сервере, включена снова после перехода на Starter (0,5 CPU). Выключить: TEAM_ENABLED = false здесь и в public/client.js
const TEAM_ENABLED = true;
const TEAM_NAMES = ['Мирные', 'Мафия'], TEAM_BOT_NAMES = ['Мирный', 'Мафиози'];
// Владелец 07.10: вся команда одного цвета — Мирные белые, Мафия чёрно-оранжевая (свой скин в командах не действует)
const TEAM_SKIN_NAMES = ['Белый', 'Чёрно-оранжевый'];
const ROUND_SEC = Number(process.env.TEST_ROUND) || 600, ROUND_PAUSE_SEC = 10; // раунд 10 минут, пауза 10 с
const TICK_RATE = 30;            // шагов мира в секунду
const TICK_MS = 1000 / TICK_RATE;
const MAP_R = 5000;              // радиус круглой карты
const TARGET_SNAKES = 35;        // живые игроки + боты; зашёл человек — бот уступает место (владелец 13.10: было 40)
const FOOD_TARGET = TEAM ? 3924 : 3141; // владелец 14.10: мелкой еды на 10% меньше (было 4360 / 3490) — легче для телефонов // обычной еды на карте: в оригинале её немного, ~25 точек на экран; в командах +25% — своих не разбить, трупов меньше (владелец 07.10)
const SEG_D = 6;                 // расстояние между точками тела
const BASE_SPEED = 6;            // за шаг мира (у змейки на старте; дальше см. speedFor)
const BOOST_SPEED = 12 * 6 / 4.75; // ускорение как в оригинале: 12 против 4,75
const START_MASS = Number(process.env.TEST_START_MASS) || 10; // в оригинале змейка стартует с длины 10 (TEST_START_MASS — только для проверок)
const MIN_BOOST_MASS = 12;       // меньше — ускоряться нельзя
const MAX_R = 60;              // 10·sc при sc=6
const DROP_LIFE = 90 * TICK_RATE; // еда от погибших/ускорения исчезает через 90 с
const GRID = 80;                 // клетка сетки столкновений
const FCELL = 250;               // клетка еды (по ним игроку досылается еда)
const MAX_CLIENTS = 150;
const BOT_NAME = 'Bot';
// Роли из «Мафии» по длине — для всех: людей и ботов (владелец 06.10). Дон Мафии — самая длинная змея на карте.
const { ROLES, DON, rankFor } = require('./public/roles.js');
const { PORTALS, PORTAL_R } = require('./public/portals.js');
let donId = 0;
function updateRoles() {
  if (TEAM) return; // в командном режиме ролей нет
  let top = null;
  for (const s of snakes.values()) if (s.alive && (!top || s.mass > top.mass)) top = s;
  for (const s of snakes.values()) {
    if (!s.alive) continue;
    const prev = s.role || 0;
    const r = s === top ? DON : rankFor(s.mass, prev === DON ? rankFor(s.mass, 0) : prev);
    s.role = r;
    // владелец 11.10: у ботов живой ник (s.name), роль — рядом, как у людей
    if (s.client && r > prev && s.roleShown !== r) { // человек получил новую роль — табличка-поздравление
      s.roleShown = r;
      sendJSON(s.client, { t: 'role', r });
    }
    // Владелец 11.10: человек стал Киллером — у него кинжал, метнуть можно один раз за жизнь
    if (!s.bot && s.client && r === KILLER_ROLE && !s.knifeGiven) {
      s.knifeGiven = true; s.knife = 2; // владелец 13.10: два кинжала
      sendJSON(s.client, { t: 'tmsgMe', text: '🗡 Вы Киллер! 2 кинжала — каждый разрубит две змеи: кнопка 🗡' + (isTouchUA(s.client) ? '' : ', правая кнопка мыши или F') });
    }
    // Владелец 14.10: человек стал Параноиком — 1 кинжал и 1 электрошокер
    if (!s.bot && s.client && r === PARANOID_ROLE && !s.paraGiven) {
      s.paraGiven = true; s.knife = (s.knife || 0) + 1; s.shock = 2; // владелец 14.10: шокера два
      sendJSON(s.client, { t: 'tmsgMe', text: '👀 Вы Параноик! 🗡 кинжал и ⚡ 2 шокера — ' + (isTouchUA(s.client) ? 'кнопка справа' : 'F или правая кнопка мыши') + ': сначала кинжал, потом шокер' });
    }
    // Владелец 13.10: человек стал Шерифом — 2 броска значка: значок разрубает змею пополам
    if (!s.bot && s.client && r === SHERIFF_ROLE && !s.badgeGiven) {
      s.badgeGiven = true; s.badge = 2;
      sendJSON(s.client, { t: 'tmsgMe', text: '⭐ Вы Шериф! 2 броска значка — разрубает змею пополам: кнопка ⭐' + (isTouchUA(s.client) ? '' : ' или F') });
    }
    // Владелец 11.10: человек стал Бомбой — рядом с ним едет настоящая бомба, бросить её можно один раз за жизнь
    if (!s.bot && s.client && r === BOMB_ROLE && !s.bombGiven) {
      s.bombGiven = true; s.bomb = 2; // владелец 11.10: две бомбы
      sendJSON(s.client, { t: 'tmsgMe', text: '💣 Вы Бомба! Две бомбы едут рядом — бросайте в соперников: кнопка 💣' + (isTouchUA(s.client) ? '' : ', правая кнопка мыши или F') });
    }
  }
  // Новый Дон Мафии среди людей — объявляем всем
  if (top && top.id !== donId) {
    donId = top.id;
    if (!top.bot) for (const c of clients) if (c !== top.client) sendJSON(c, { t: 'don', name: top.name });
    // Владелец 07.10: человек стал Доном — 4 выстрела из базуки (один раз за жизнь змеи)
    if (!top.bot && !top.donGun) {
      top.donGun = true; top.rockets = (top.rockets || 0) + 2; // владелец 11.10: всего 2 выстрела (было 4), один раз за жизнь
      if (top.client) sendJSON(top.client, { t: 'tmsgMe', text: '👑 Вы Дон Мафии! У вас базука: 2 ракеты — 🚀' + (isTouchUA(top.client) ? '' : ', правая кнопка мыши или F') });
    }
  }
}
// В рейтинге Дон — коротко «Ник Дон», чтобы не обрезалось (владелец 06.10)
const PARANOID_ROLE = ROLES.findIndex(r => r.name === 'Параноик'), BOMB_ROLE = ROLES.findIndex(r => r.name === 'Бомба'), KILLER_ROLE = ROLES.findIndex(r => r.name === 'Киллер'), SHERIFF_ROLE = ROLES.findIndex(r => r.name === 'Шериф');
const roleShort = r => r === DON ? 'Дон' : ROLES[r].name;
const displayName = s => TEAM ? s.name : s.name + ' ' + roleShort(s.role || 0);
// Живые ники ботов (владелец 11.10: «рейтинг и карта скучные — Киллер, Киллер, Мафия»). На карте ники не повторяются.
const BOT_NICKS = ['Волк', 'Тень', 'Снайпер', 'Бродяга', 'Лиса', 'Призрак', 'Гром', 'Барс', 'Кобра', 'Шторм', 'Ворон', 'Беркут', 'Скорпион', 'Пантера',
  'Шрам', 'Туман', 'Фантом', 'Сокол', 'Ястреб', 'Медведь', 'Шакал', 'Кит', 'Буря', 'Хищник', 'Монах', 'Граф', 'Борода', 'Малыш', 'Шустрый', 'Тихий',
  'Кот', 'Ёж', 'Удав', 'Капитан', 'Пират', 'Самурай', 'Ниндзя', 'Викинг', 'Барон', 'Бандит', 'Лис', 'Филин', 'Дракон', 'Охотник', 'Странник',
  'Kira_07', 'Shadow', 'NightFox', 'Toxic', 'Pro100', 'lucky777', 'xXsnakeXx', 'Ghost', 'Venom', 'Raven', 'Blaze', 'Viper', 'Storm_X', 'DarkWolf',
  'Neo', 'Zed', 'Kaito', 'Rex', 'Sly', 'Max_99', 'Nova', 'Hunter', 'Joker', 'Bishop', 'Ronin', 'Spike', 'Frost', 'Hydra', 'Echo', 'Ace', 'Duke',
  'Lucky', 'Mamba', 'Zeus', 'Odin', 'Kaiser', 'Bandit', 'Sniper_X', 'Tiger', 'Panda_77', 'K1ller', 'Snake_Boss', 'Lord', 'Mr_Black', 'Smoky'];
function botNick() {
  const used = new Set(); for (const s of snakes.values()) if (s.alive) used.add(s.name);
  const free = BOT_NICKS.filter(n => !used.has(n));
  const pool = free.length ? free : BOT_NICKS;
  return pool[Math.random() * pool.length | 0];
}
const GIANT_MASS = 500;          // боты длиннее этого — осторожные гиганты
const BOT_HUNT_BOTS = 1.0;       // доля охот бота на других ботов: подобрано замером, чтобы разбивалось ~50 ботов в минуту
const TAU = Math.PI * 2;
const PROTO = 6;                 // версия «языка» сервер↔браузер; менять вместе с PROTO в client.js

// ===== Формулы (одинаковые на сервере и в браузере) =====
const rand = (a, b) => Math.random() * (b - a) + a;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function angDiff(a, b) { let d = b - a; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; }
// ===== Рост, толщина, скорость, поворот и камера — формулы из кода оригинальной slither.io =====
// Длина (очки) = (fpsls[sct] + fam/fmlts[sct] − 1)·15 − 5, где sct — число сегментов тела.
// Толщина sc = min(6, 1 + (sct − 2)/106): змейка долго тонкая и длинная, толстеет медленно.
// В оригинале тело 29·sc шириной, сегменты через 42; у нас радиус 10·sc, значит сегмент = 42·(20/29) ≈ 29 = 4,83 точки по SEG_D.
const MSCPS = 430;                       // максимум сегментов (живой сервер оригинала присылает 430)
const FMLTS = [], FPSLS = [];
for (let i = 0; i <= MSCPS; i++) {
  FMLTS.push(i >= MSCPS ? FMLTS[i - 1] : Math.pow(1 - i / MSCPS, 2.25));
  FPSLS.push(i === 0 ? 0 : FPSLS[i - 1] + 1 / FMLTS[i - 1]);
}
function sctFor(m) {                     // дробное число сегментов по длине-очкам
  const target = (Math.max(m, 0) + 5) / 15 + 1;
  let lo = 0, hi = MSCPS;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (FPSLS[mid] <= target) lo = mid; else hi = mid - 1; }
  return lo + Math.min(1, (target - FPSLS[lo]) * FMLTS[lo]);
}
// Владелец: длинная змейка должна понемногу толстеть — в оригинале делитель 106, у нас 60 (толстеет ~в 1,8 раза быстрее)
const SC_DIV = 60;
const scFor = m => Math.min(6, 1 + (sctFor(m) - 2) / SC_DIV);
function radiusFor(m) { return 10 * scFor(m); }
// Толщина по настоящему числу точек тела (обратное к segsFor): растёт вместе с телом, а не скачком при поедании
function radiusForPoints(n) { const sct = (n - 1) * SEG_D / 29; return 10 * Math.min(6, 1 + Math.max(0, sct - 2) / SC_DIV); }
// Владелец 06.10: без резкого стопа — как в оригинале, тело растёт всё медленнее до 430 сегментов (≈2080 точек)
function segsFor(m) { return Math.max(8, Math.round(1 + sctFor(m) * 29 / SEG_D)); }
// Поворот: mamu·scang (за кадр оригинала 8 мс) → за наш шаг 33 мс; толстые разворачиваются шире
const TURN_BOOST = 1.5; // владелец 06.10: живые игроки манёвреннее ботов (было 1,3; 07.10 — ещё +15% → 1,5), боты — как в оригинале (менять вместе с client.js)
function turnFor(r, bot) { const sc = r / 10, scang = 0.13 + 0.87 * Math.pow((7 - sc) / 6, 2); return 0.033 * (TICK_MS / 8) * scang * (bot ? 1 : TURN_BOOST); }
// Скорость: обычная 4,25 + 0,5·sc, ускорение 12 (единицы оригинала, пересчитаны в наши)
const SPEED_K = 6 / 4.75;
const speedFor = (r, boost) => (boost ? 12 : 4.25 + 0.5 * (r / 10)) * SPEED_K;
// Камера: в оригинале gsc = 0.64285 + 0.514285714 / max(1, (sct + 16)/36) — отдаляется по мере роста
// Владелец 07.10: Дону и Киллеру (и Мафии — она старше Киллера) камера выше — видно больше карты
const ROLE_ZOOM = { 7: 0.85, 8: 0.85, 9: 0.72 }; // номера ролей: 7 Киллер, 8 Мафия, 9 Дон (см. public/roles.js)
// Владелец 07.10: в командной игре чем длиннее змея, тем выше камера (видно красоту карты): с 300 плавно до ×0,5 на 8000
const teamZoom = mass => mass > 300 ? 1 - 0.5 * Math.min(1, Math.log(mass / 300) / Math.log(8000 / 300)) : 1;
function viewScale(w, h, r, role, mass, eye) {
  // Владелец 06.10: на телефоне камера ближе (как на компьютере) — раньше змейка на старте была 15 px и терялась
  const base = Math.max(clamp(Math.sqrt(w * h) / 750, 0.5, 1.6), Math.min(w, h) < 600 ? 1.05 : 0), sct = 2 + (r / 10 - 1) * SC_DIV;
  return base * (0.64285 + 0.514285714 / Math.max(1, (sct + 16) / 36)) / 1.157142857 * (ROLE_ZOOM[role] || 1) * (mass ? teamZoom(mass) : 1) * (eye ? EYE_ZOOM : 1);
}
// Еда как в оригинале (замерено на живой игре, 42 поедания): шарик размера sz даёт 0,048·sz² очков длины.
// Обычная еда — размеры 3…9 вперемешку; от погибших — ~2 шарика размера ~13–14 на сегмент; от ускорения — размер ~5.
const FOOD_K = 0.024; // владелец: расти вдвое медленнее, чем в оригинале (там 0,048)
const valueOfSize = sz => FOOD_K * sz * sz;
const sizeOfValue = v => Math.sqrt(Math.max(v, 0) / FOOD_K);
function foodRadius(v) { return Math.min(14, sizeOfValue(v) * 0.5); } // на экране размер шарика ∝ sz
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return '#' + [f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('');
}
function hexTo565(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (((n >> 16) & 255) >> 3) << 11 | (((n >> 8) & 255) >> 2) << 5 | ((n & 255) >> 3);
}
// Владелец 11.10 («подвисает»): 24 оттенка вместо 360 — каждый новый цвет еды телефон готовит отдельной картинкой, сотни цветов давали рывки
const randColor = () => hslToHex((Math.random() * 24 | 0) * 15, 85, 55);
const HEX_RE = /^#[0-9a-f]{6}$/i;

// ===== Мир =====
let tick = 0;
const diedThisTick = [];
const snakes = new Map();   // id -> Snake
let nextSnakeId = 0;
function newSnakeId() {
  for (;;) { nextSnakeId = nextSnakeId >= 65000 ? 1 : nextSnakeId + 1; if (!snakes.has(nextSnakeId)) return nextSnakeId; }
}

class Snake {
  constructor(x, y, mass, bot, name, skin) {
    this.id = newSnakeId();
    this.bot = bot; this.name = name; this.skin = skin;
    this.mass = mass; this.a = Math.atan2(-y, -x) + rand(-0.6, 0.6); this.ta = this.a; // появляется головой к центру, а не в стену
    this.boost = false; this.boosting = false; this.boostAcc = 0;
    this.alive = true; this.kills = 0; this.client = null;
    this.r = radiusFor(mass);
    this.dropCols = [...new Set(skinCols(skin))].map(hexTo565);
    const n = segsFor(mass);
    this.xs = []; this.ys = [];
    for (let i = 0; i < n; i++) { this.xs.push(x - Math.cos(this.a) * i * SEG_D); this.ys.push(y - Math.sin(this.a) * i * SEG_D); }
    this.bbox();
    if (bot) this.ai = makePersonality(this);
  }
  bbox() {
    const xs = this.xs, ys = this.ys;
    let x0 = xs[0], x1 = x0, y0 = ys[0], y1 = y0;
    for (let i = 1; i < xs.length; i++) {
      const x = xs[i], y = ys[i];
      if (x < x0) x0 = x; else if (x > x1) x1 = x;
      if (y < y0) y0 = y; else if (y > y1) y1 = y;
    }
    this.minX = x0; this.maxX = x1; this.minY = y0; this.maxY = y1;
  }
  dropColor(j) { return this.dropCols[j % this.dropCols.length]; }
}

function moveSnake(s) {
  const stun = s.stunUntil > tick, turbo = s.turboUntil > tick; // предметы (владелец 14.10): ⚡ шокер, 🚀 ускоритель
  const tr = stun ? 0 : turnFor(s.r, s.bot);
  s.a += clamp(angDiff(s.a, s.ta), -tr, tr);
  if (s.a > Math.PI) s.a -= TAU; else if (s.a < -Math.PI) s.a += TAU;
  s.boosting = turbo || (s.boost && s.mass >= MIN_BOOST_MASS);
  const spd = speedFor(s.r, s.boosting) * (stun ? 0.35 : 1);
  const xs = s.xs, ys = s.ys;
  xs[0] += Math.cos(s.a) * spd; ys[0] += Math.sin(s.a) * spd;
  if (s.boosting && !turbo) {
    // Ускорение стоит длины: змейка худеет и роняет еду с хвоста, как в slither.io
    const cost = (0.15 + s.mass * 0.0008) * 0.7 * 0.8; // владелец 07.10: при ускорении теряет на 30% меньше; 14.10: ещё на 20% меньше
    s.mass -= cost; s.boostAcc += cost;
    if (s.boostAcc >= 1.2) {
      const t = xs.length - 1;
      addFood(xs[t] + rand(-4, 4), ys[t] + rand(-4, 4), s.boostAcc * 0.85, s.dropColor(tick), true); // шарик ~размера 5, как в оригинале
      s.boostAcc = 0;
    }
  }
  // Как в оригинале: съеденное копится, а тело растёт постепенно — не больше одной точки
  // на каждые SEG_D пройденного пути. Толщина считается по настоящему числу точек, поэтому тоже растёт плавно.
  // Растём вдвое плавнее: одна точка на каждые 2·SEG_D пути (копим дробную часть)
  const target = segsFor(s.mass);
  s.growAcc = (s.growAcc || 0) + spd / (2 * SEG_D);
  let n = xs.length;
  while (s.growAcc >= 1 && n < target) { xs.push(xs[n - 1]); ys.push(ys[n - 1]); n++; s.growAcc -= 1; }
  if (n >= target) s.growAcc = Math.min(s.growAcc, 1);
  const step = Math.max(1, Math.ceil(spd / SEG_D));
  if (n > target) { n = Math.max(target, n - step); xs.length = n; ys.length = n; }
  s.r = radiusForPoints(n);
  // Тоннель (владелец 11.10: «плавно заползала»): точки 0..T.k-1 уже вылезли у выхода B, остальные ещё ползут к входу A.
  // Первая невылезшая точка тянется не к соседу у B, а к его «отражению» у A — так тело втягивается в нору,
  // а перейдя плоскость норы, точка переносится к выходу. Когда втянулся хвост — тоннель закончен.
  const T = s.tun, ox = T ? T.bx - T.ax : 0, oy = T ? T.by - T.ay : 0;
  // Владелец 11.10: хвост честно заползает в нору, «как поезд по рельсам». Часть тела, что ещё до норы (точки T.k…),
  // каждый шаг сдвигается по своему же следу к норе A ровно на столько, на сколько проползла голова (spd);
  // точка, дошедшая до норы, появляется у выхода B. Сколько вошло — столько вышло: тело не рвётся и не застревает,
  // куда бы ни повернула голова.
  const bEnd = T ? T.k : n;
  for (let i = 1; i < bEnd; i++) {
    const dx = xs[i] - xs[i - 1], dy = ys[i] - ys[i - 1];
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > SEG_D) { const k = SEG_D / d; xs[i] = xs[i - 1] + dx * k; ys[i] = ys[i - 1] + dy * k; }
  }
  if (T && T.k < n) {
    const m = n - T.k, PX = [T.ax], PY = [T.ay], PL = [0];            // след: нора A → первая точка до норы → … → хвост
    for (let j = 0; j < m; j++) { const x = xs[T.k + j], y = ys[T.k + j]; PL.push(PL[PL.length - 1] + Math.hypot(x - PX[PX.length - 1], y - PY[PY.length - 1])); PX.push(x); PY.push(y); }
    let seg = 0, moved = 0;
    for (let j = 0; j < m; j++) {
      const sNew = PL[j + 1] - spd;
      if (sNew <= 0) { moved++; continue; }                            // дошла до норы
      while (seg < PL.length - 2 && PL[seg + 1] < sNew) seg++;
      const f = (sNew - PL[seg]) / ((PL[seg + 1] - PL[seg]) || 1);
      xs[T.k + j] = PX[seg] + (PX[seg + 1] - PX[seg]) * f; ys[T.k + j] = PY[seg] + (PY[seg + 1] - PY[seg]) * f;
    }
    for (let j = 0; j < moved; j++) { xs[T.k + j] = T.bx; ys[T.k + j] = T.by; } // вынырнули у выхода — дальше их ведёт тело у выхода
    T.k += moved;
  }
  // Владелец 11.10 («глюк с дыркой»): после тоннеля снова нырять можно, только когда хвост отполз от выхода — иначе длинная змея
  // замыкалась «кольцом» через обе норы и казалось, что из норы выходят два тела
  if (T && T.k >= n) { s.tun = null; s.portalCd = Math.max(s.portalCd || 0, tick + n); }
  s.bbox();
}

// ===== Еда =====
const foods = new Map();      // id -> food
const fcells = new Map();     // клетка -> Set(food)
const cellEv = new Map();     // клетка -> события этого шага {add:[], rem:[]}
const drops = [];             // еда, которая со временем исчезает
let foodSeq = 0, naturalFood = 0;
const fkey = (x, y) => ((Math.floor(x / FCELL) + 64) << 8) | (Math.floor(y / FCELL) + 64);
function cellEvents(k) { let e = cellEv.get(k); if (!e) { e = { add: [], rem: [] }; cellEv.set(k, e); } return e; }

function addFood(x, y, v, col, drop) {
  const lim = MAP_R - 30, d = Math.hypot(x, y);
  if (d > lim) { x *= lim / d; y *= lim / d; }
  foodSeq = foodSeq >= 4e9 ? 1 : foodSeq + 1;
  const f = { id: foodSeq, x, y, v, r: foodRadius(v), c: col, k: fkey(x, y), drop: !!drop, die: drop ? tick + DROP_LIFE : 0 };
  foods.set(f.id, f);
  let cell = fcells.get(f.k); if (!cell) { cell = new Set(); fcells.set(f.k, cell); }
  cell.add(f);
  cellEvents(f.k).add.push(f);
  if (drop) drops.push(f); else naturalFood++;
  return f;
}
function removeFood(f, eaterId) {
  if (!foods.delete(f.id)) return;
  const cell = fcells.get(f.k);
  cell.delete(f); if (!cell.size) fcells.delete(f.k);
  cellEvents(f.k).rem.push(f.id, eaterId);
  if (!f.drop) naturalFood--;
}
function spawnNaturalFood() {
  const a = rand(0, TAU), d = Math.sqrt(Math.random()) * (MAP_R - 60);
  const x = Math.cos(a) * d, y = Math.sin(a) * d;
  // Как в оригинале: мелкая разноцветная еда, местами густые «полянки»
  const n = 1; // в оригинале еда рассыпана поодиночке, без «полянок»
  for (let i = 0; i < n; i++) {
    const v = valueOfSize(3 + Math.random() * 6); // размер 3…9, как в оригинале
    const sx = n > 1 ? rand(-70, 70) : 0, sy = n > 1 ? rand(-70, 70) : 0;
    addFood(x + sx, y + sy, v, hexTo565(randColor()), false);
  }
}
function maintainFood() {
  for (let i = 0; i < 40 && naturalFood < FOOD_TARGET; i++) spawnNaturalFood();
  if (tick % 15 === 0) {
    let w = 0;
    for (let i = 0; i < drops.length; i++) {
      const f = drops[i];
      if (!foods.has(f.id)) continue;
      if (f.die <= tick) { removeFood(f, 0); continue; }
      drops[w++] = f;
    }
    drops.length = w;
  }
}

// ===== Сетка столкновений (пересобирается каждый шаг) =====
const grid = new Map();
const PX = [], PY = [], PS = [], PIdx = [];
let pN = 0;
const gkey = (cx, cy) => ((cx + 128) << 9) | (cy + 128);
function gridPush(s, i) {
  const x = s.xs[i], y = s.ys[i];
  const k = gkey(Math.floor(x / GRID), Math.floor(y / GRID));
  let c = grid.get(k); if (!c) { c = []; grid.set(k, c); }
  c.push(pN); PX[pN] = x; PY[pN] = y; PS[pN] = s; PIdx[pN] = i; pN++;
}
function buildGrid() {
  grid.clear(); pN = 0;
  for (const s of snakes.values()) {
    if (!s.alive) continue;
    const step = Math.max(1, Math.floor(s.r * 0.7 / SEG_D)), len = s.xs.length;
    for (let i = 0; i < len; i += step) gridPush(s, i);
    if ((len - 1) % step) gridPush(s, len - 1);
  }
}

function collisions() {
  const dead = [];
  for (const s of snakes.values()) {
    if (!s.alive || s.ghostUntil > tick) continue; // Доктор после спасения 2 с проходит сквозь всё
    if (process.env.TEST_GOD && !s.bot) continue; // только для проверок: игрок неуязвим (замеры скорости)
    const hx = s.xs[0], hy = s.ys[0], rs = s.r;
    const lim = MAP_R - rs * 0.3;
    if (hx * hx + hy * hy > lim * lim) { dead.push(s, null); continue; }
    const reach = rs + MAX_R;
    const cx0 = Math.floor((hx - reach) / GRID), cx1 = Math.floor((hx + reach) / GRID);
    const cy0 = Math.floor((hy - reach) / GRID), cy1 = Math.floor((hy + reach) / GRID);
    let killer = null;
    outer:
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const c = grid.get(gkey(cx, cy)); if (!c) continue;
      for (let j = 0; j < c.length; j++) {
        const p = c[j], o = PS[p];
        if (o === s || (TEAM && o.team === s.team) || o.invisUntil > tick) continue; // в себя и в своих (командный режим) врезаться нельзя; владелец 14.10: о невидимку (👻) не разбиваются — она для побега, не для засады
        const dx = PX[p] - hx, dy = PY[p] - hy, rr = o.r + rs * 0.6;
        if (dx * dx + dy * dy < rr * rr) { killer = o; s.hitIdx = PIdx[p]; break outer; }
      }
    }
    if (killer) {
      // Подрезка (владелец 11.10): змея обогнала и резко повернула поперёк — её голова задевает голову или шею соперника.
      // Раньше погибала она («чья голова коснулась — тот и разбился»), а должна та, что сзади въехала в подрезавшую.
      // Голова s впереди головы o по ходу o и не лоб в лоб — значит, o сама въехала в s: погибает o.
      // Людям запас 25: чужие змеи у них на экране чуть отстают от сервера, человек видит себя чуть дальше впереди.
      const o = killer;
      // Владелец 14.10 («я впереди, подрезаю — а погибаю сам»): человек видит соперника с опозданием (пинг + запас плавности,
      // до 0,4 с). Решаем по тому, где голова соперника была у него НА ЭКРАНЕ: берём её положение lagMs назад
      const L = s.bot || !s.client ? 0 : Math.min(15, Math.round((s.client.lagMs || 0) / TICK_MS)), oh = o.hh || [];
      const pk = oh.length - 2 - L * 2, px = L && pk >= 0 ? oh[pk] : o.xs[0], py = L && pk >= 0 ? oh[pk + 1] : o.ys[0];
      const lagGap = Math.hypot(o.xs[0] - px, o.ys[0] - py); // на сколько соперник на самом деле уже уполз вперёд
      if (s.hitIdx * SEG_D <= o.r * 2.5 + (s.bot ? 0 : 25 + lagGap)) {
        const ca = Math.cos(o.a), sa = Math.sin(o.a);
        const ahead = (hx - px) * ca + (hy - py) * sa, sameWay = Math.cos(s.a) * ca + Math.sin(s.a) * sa;
        if (ahead > (s.bot ? 0 : -25) && sameWay > -0.3) { if (!(o.ghostUntil > tick)) { o.hitIdx = 0; dead.push(o, s); } continue; } // Доктор-призрак не гибнет — тогда обе живы
      }
      dead.push(s, killer);
    }
  }
  // Две змеи задели друг друга одновременно — погибает только одна (владелец 06.10; замер: 8 из 52 смертей были «оба»).
  // Кто въехал головой в тело — тот и разбился. Если обе задели головы: погибает та, что ехала прямо на соперника
  // (подрезавшая поперёк остаётся жить); если поровну — медленная, затем меньшая.
  const spare = new Set();
  for (let i = 0; i < dead.length; i += 2) {
    const a = dead[i], b = dead[i + 1];
    if (!b || spare.has(a) || spare.has(b)) continue;
    let j = -1;
    for (let k = 0; k < dead.length; k += 2) if (dead[k] === b && dead[k + 1] === a) { j = k; break; }
    if (j < 0) continue;
    let loser;
    if (a.hitIdx > 2 && b.hitIdx > 2) continue; // обе въехали друг другу В ТЕЛО — разбиваются обе, иначе одна «проезжала насквозь»
    if ((a.hitIdx > 2) !== (b.hitIdx > 2)) loser = a.hitIdx > 2 ? a : b;
    else {
      const dx = b.xs[0] - a.xs[0], dy = b.ys[0] - a.ys[0], d = Math.hypot(dx, dy) || 1;
      const aimA = (Math.cos(a.a) * dx + Math.sin(a.a) * dy) / d, aimB = -(Math.cos(b.a) * dx + Math.sin(b.a) * dy) / d;
      if (Math.abs(aimA - aimB) > 0.15) loser = aimA > aimB ? a : b;
      else if (a.boosting !== b.boosting) loser = a.boosting ? b : a;
      else loser = a.mass < b.mass ? a : b;
    }
    spare.add(loser === a ? b : a);
  }
  const done = new Set(); // после подрезки одна змея может попасть в список дважды — Доктор не должен «спастись» и тут же погибнуть
  for (let i = 0; i < dead.length; i += 2) {
    const v = dead[i]; if (done.has(v)) continue; done.add(v);
    if (!spare.has(v) && !docSave(v) && !lizardSave(v, dead[i + 1])) killSnake(v, dead[i + 1]);
  }
}

const deathStats = { botBody: 0, botWall: 0, player: 0 };
// Владелец 07.10: Доктор один раз за жизнь не умирает — отскакивает: сразу разворачивается назад (у края — к центру).
// Сквозь змей НЕ проходит (владелец: «не должен пересекаться»): неуязвим лишь 0,4 с — столько, чтобы вытащить голову обратно
const DOCTOR = ROLES.findIndex(r => r.name === 'Доктор'), GHOST_TICKS = Math.round(0.4 * TICK_RATE);
function docSave(s) {
  if (TEAM || s.docUsed || (s.role || 0) !== DOCTOR || !s.alive) return false;
  s.docUsed = true; s.ghostUntil = tick + GHOST_TICKS;
  const hx = s.xs[0], hy = s.ys[0];
  if (hx * hx + hy * hy > (MAP_R - 300) * (MAP_R - 300)) s.a = s.ta = Math.atan2(-hy, -hx); // у края — к центру
  else { s.a += Math.PI; if (s.a > Math.PI) s.a -= TAU; s.ta = s.a; } // врезался в змею — разворот назад, прочь от неё
  for (const c of clients) sendJSON(c, { t: 'docSave', id: s.id, ms: 1000 });
  if (s.client) sendJSON(s.client, { t: 'tmsgMe', text: '🩺 Доктор спас вас — отскок! Второго раза не будет' });
  return true;
}
// Владелец 13.10: Зубастик — «хвост ящерицы». Один раз за жизнь, врезавшись в чужую змею (не в стену), не погибает:
// отбрасывает половину хвоста (он рассыпается едой), разворачивается и 0,7 с неуязвим, чтобы уползти
const LIZ_GHOST = Math.round(0.7 * TICK_RATE);
function lizardSave(s, killer) {
  if (TEAM || !killer || s.lizUsed || s.skin.id !== TEETH_ID || !s.alive || s.tun) return false;
  s.lizUsed = true; s.ghostUntil = tick + LIZ_GHOST;
  const xs = s.xs, ys = s.ys, n = xs.length, keep = Math.max(8, Math.ceil(n / 2)), drop = s.mass * 0.5;
  s.mass -= drop;
  const m = n - keep, cnt = clamp(Math.round(m / 3), 3, 200), v = drop * 0.8 / cnt; // хвост — едой (чуть меньше, чем потерял)
  for (let j = 0; j < cnt; j++) { const i = Math.min(n - 1, keep + Math.floor(j * m / cnt)); addFood(xs[i] + rand(-4, 4), ys[i] + rand(-4, 4), v, s.dropColor(j), true); }
  xs.length = keep; ys.length = keep; s.r = radiusForPoints(keep); s.bbox();
  s.a += Math.PI; if (s.a > Math.PI) s.a -= TAU; s.ta = s.a; // прочь от того, во что врезался
  for (const c of clients) sendJSON(c, { t: 'docSave', id: s.id, ms: 700 }); // мерцание «призрака», как у Доктора
  if (s.client) sendJSON(s.client, { t: 'tmsgMe', text: '🦎 Хвост ящерицы! Вы отбросили хвост и спаслись. Второго раза не будет' });
  return true;
}
function killSnake(s, killer) {
  if (!s.alive) return;
  if (!s.bot) records.report(s.name, s.mass);
  if (!s.bot) deathStats.player++; else if (killer) deathStats.botBody++; else deathStats.botWall++;
  s.alive = false;
  snakes.delete(s.id);
  diedThisTick.push(s.id);  // браузеры покажут, как тело тает
  // Труп рассыпается крупной светящейся едой — за неё и дерутся
  // Как в оригинале: погибшая змея рассыпается ~2 шариками на сегмент и отдаёт едой почти всю свою длину
  const len = s.xs.length, total = s.mass * 0.5; // вдвое меньше, чем в оригинале — расти медленнее
  const n = clamp(Math.round(sctFor(s.mass) * 2), 3, 600), v = total / n;
  for (let j = 0; j < n; j++) {
    const i = Math.floor(j * len / n), sp = s.r * 0.6;
    addFood(s.xs[i] + rand(-sp, sp), s.ys[i] + rand(-sp, sp), v, s.dropColor(j), true);
  }
  if (killer && killer.alive) {
    killer.kills++;
    if (TEAM && killer.team != null && killer.team !== s.team) {
      teamKills[killer.team]++;
      if (killer.client && killer.client.rs) killer.client.rs.kills++;
      killer.streak = (killer.streak || 0) + 1;
      if (s.hot) { // остановил того, кто «в ударе» — награда двойная
        teamKills[killer.team]++; killer.mass += 200;
        if (!killer.bot || !s.bot) teamMsg(`💥 ${killer.name} остановил ${s.name}! Двойная награда`);
      }
      if (killer.streak === 3) { killer.hot = true; if (!killer.bot) teamMsg(`🔥 ${killer.name} В УДАРЕ! Кто съест — двойная награда`); }
    }
    if (killer.client) sendJSON(killer.client, { t: 'kill', name: s.name });
  }
  const c = s.client;
  if (TEAM && c && c.rs) { c.rs.life = Math.max(c.rs.life, Math.round((tick - (s.born || tick)) / TICK_RATE)); addAlarm(s.team, s.xs[0], s.ys[0]); }
  if (c) {
    c.snake = null; c.diedAt = Date.now();
    // В топ-5 рекордов всех времён — пропуск, чтобы поставить своё фото на карточку победителя (владелец 11.10)
    const place = TEAM ? 0 : records.placeAll(s.name);
    const photo = place ? { t: winners.invite(s.name), place, has: winners.has(s.name) } : null;
    sendJSON(c, { t: 'dead', score: Math.floor(s.mass), kills: s.kills, killer: killer ? killer.name : null, ...(photo ? { photo } : {}) });
  }
}

function eat(s) {
  const mg = s.magnetUntil > tick; // 🧲 магнит (владелец 14.10): еда летит в пасть с 300 единиц
  const hx = s.xs[0], hy = s.ys[0], reach = mg ? 300 : s.r * 1.25 + 10 + 18;
  const cx0 = Math.floor((hx - reach) / FCELL), cx1 = Math.floor((hx + reach) / FCELL);
  const cy0 = Math.floor((hy - reach) / FCELL), cy1 = Math.floor((hy + reach) / FCELL);
  for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
    const cell = fcells.get(((cx + 64) << 8) | (cy + 64)); if (!cell) continue;
    for (const f of cell) {
      const dx = f.x - hx, dy = f.y - hy, rr = mg ? 300 : s.r * 1.25 + 10 + f.r;
      if (dx * dx + dy * dy < rr * rr) { s.mass += finalMin ? f.v * 2 : f.v; removeFood(f, s.id); } // последняя минута командного раунда — еда ×2
    }
  }
}

// Место для появления: подальше от чужих тел и голов игроков
function findSpawn(awayFromPlayers, cx, cy, rad) { // cx, cy, rad — искать рядом с точкой (командный режим: у своей базы)
  let best = null, bestD = -Infinity; // -Infinity: место найдётся всегда, даже если все 30 проб попали в чужие тела
  for (let t = 0; t < 30; t++) {
    const a = rand(0, TAU), d = Math.sqrt(Math.random()) * (cx != null ? rad : MAP_R - 700);
    const x = (cx != null ? cx : 0) + Math.cos(a) * d, y = (cy != null ? cy : 0) + Math.sin(a) * d;
    let md = 400;
    const cx0 = Math.floor((x - 400) / GRID), cx1 = Math.floor((x + 400) / GRID);
    const cy0 = Math.floor((y - 400) / GRID), cy1 = Math.floor((y + 400) / GRID);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const c = grid.get(gkey(cx, cy)); if (!c) continue;
      for (const p of c) { const dd = Math.hypot(PX[p] - x, PY[p] - y) - PS[p].r; if (dd < md) md = dd; }
    }
    if (awayFromPlayers) {
      for (const s of snakes.values()) {
        if (s.bot) continue;
        if (Math.hypot(s.xs[0] - x, s.ys[0] - y) < 700) md = Math.min(md, 0);
      }
    }
    if (md >= 400) return { x, y };
    if (md > bestD) { bestD = md; best = { x, y }; }
  }
  return best;
}

// Скины ботов (владелец 07.10): без оранжевых; чаще белые, серые, чёрно-оранжевые и чёрно-белые (имя × вес)
// Владелец 11.10: без розовых и синих; больше чёрно-оранжевых и белых, плюс Циклоп
// Владелец 11.10 (ещё раз): больше разных спокойных скинов, в том числе чёрных — каждый понемногу, чтобы змеи не повторялись
const BOT_SKIN_WEIGHTS = { 'Белый': 3, 'Серый': 2, 'Светло-серый': 2, 'Чёрно-оранжевый': 4, 'Чёрно-белый': 2, 'Циклоп': 2, 'Бразилия': 2, 'Россия': 2, 'Розовый': 2, // владелец 14.10: Бразилия вместо Чёрного, + Россия, розовые вместо «Конфеты»
 
  'Графит': 2, 'Антрацит': 2, 'Матовый чёрный': 2, 'Чёрно-золотой': 2, 'Чёрно-красный': 2, 'Чёрно-серый': 2, 'Мокрый асфальт': 2,
  'Пепельный': 2, 'Слоновая кость': 2, 'Хаки': 2, 'Тёмно-зелёный': 2, 'Бордовый': 2, 'Горчичный': 2, 'Бело-серый': 2, 'Серо-оранжевый': 2, 'Бело-оранжевый': 2, 'Сталь': 2, 'Космос': 6, 'Аметист': 4,
  'Красный': 1, 'Жёлтый': 1, 'Зелёный': 3, 'Фиолетовый': 1,
  'Бирюзовый': 1, 'Лаймовый': 1, 'Мятный': 1, 'Коралловый': 1, 'Сливовый': 1, 'Изумрудный': 1 /* владелец 14.10: коричневые убраны, + Аметист, больше Космоса */ };
const SOLID_SKINS = [], BOT_NO_COLORS = /Розовый блеск|Син|Голуб|Небесн|Лаванд|Конфета|Океан|Глубина/; // владелец 14.10: розовые боты вернулись (один чистый розовый) // Космос вернули ботам (владелец 11.10)
SKINS.forEach((d, i) => { for (let k = 0; k < (BOT_SKIN_WEIGHTS[d.name] || 0); k++) SOLID_SKINS.push(i); });
function randomSkin() {
  // Владелец 06.10: боты почти всегда однотонные (глаза меньше устают); особые скины с надписью ботам не достаются
  let id;
  if (Math.random() < 0.95) id = SOLID_SKINS[Math.random() * SOLID_SKINS.length | 0]; // почти всегда спокойные
  else do { id = 1 + (Math.random() * (SKINS.length - 1) | 0); } while (SKINS[id].text || SKINS[id].style === 'checker' || SKINS[id].eyes === 'teeth' || SKINS[id].eyes === 'ninja' || BOT_NO_COLORS.test(SKINS[id].name)); // Зубастик — только у людей // шахматный, розовые, синие — убраны (владелец 11.10)
  return { id, c1: randColor(), c2: randColor(), c3: randColor() };
}

// ===== Боты =====
function makePersonality(s) {
  const roll = Math.random();
  let aggr;
  if (roll < 0.35) aggr = rand(0.75, 1);       // охотники: режут под голову
  else if (roll < 0.75) aggr = rand(0.4, 0.75); // обычные
  else aggr = rand(0.1, 0.35);                  // собиратели еды
  aggr *= 0.93 * 0.92;                          // владелец 06.10: агрессивность −7%; 14.10: ещё −8%
  return {
    aggr, greed: rand(0.4, 1), boostLove: rand(0.5, 1),
    prey: null, preyT: 0, cool: 0, side: Math.random() < 0.5 ? -1 : 1,
    wanderA: s.a, boostT: 0,
  };
}

function spawnBot() {
  const roll = Math.random();
  // Как в оригинале, на карте всегда есть гиганты: примерно каждый седьмой бот появляется сразу большим
  const mass = roll < 0.45 ? rand(12, 60) : roll < 0.75 ? rand(60, 300) : roll < 0.86 ? rand(300, 1000) : rand(1500, 4000);
  const pos = findSpawn(true);
  const s = new Snake(pos.x, pos.y, mass, true, BOT_NAME, randomSkin());
  s.role = rankFor(s.mass, 0);
  s.name = botNick();
  if (TEAM) { s.team = teamWithFewer(false); s.name = TEAM_BOT_NAMES[s.team]; s.role = 0; setTeamSkin(s); }
  snakes.set(s.id, s);
}

function setTeamSkin(s) {
  const id = SKINS.findIndex(d => d.name === TEAM_SKIN_NAMES[s.team]);
  s.skin = { id, c1: '#ffffff', c2: '#ffffff', c3: '#ffffff' };
  s.dropCols = [...new Set(skinCols(s.skin))].map(hexTo565);
}
// Команда, где меньше змей (onlyHumans — считать только людей; при равенстве — по всем змеям)
function teamWithFewer(onlyHumans) {
  const h = [0, 0], all = [0, 0];
  for (const s of snakes.values()) { if (s.team == null) continue; all[s.team]++; if (!s.bot) h[s.team]++; }
  if (onlyHumans && h[0] !== h[1]) return h[0] < h[1] ? 0 : 1;
  return all[0] === all[1] ? (Math.random() < 0.5 ? 0 : 1) : all[0] < all[1] ? 0 : 1;
}
function maintainBots() {
  if (TEAM && roundPause) return;
  let players = 0, bots = 0;
  for (const s of snakes.values()) { if (s.bot) bots++; else players++; }
  // Погибший человек обычно жмёт «Играть снова» через пару секунд — 8 с держим его место, иначе на каждую смерть
  // появлялся новый бот, а уходят боты медленно (замер: 35 людей — 10 ботов вместо 5)
  const nowMs = Date.now();
  for (const c of clients) if (!c.snake && c.diedAt && nowMs - c.diedAt < 8000) players++;
  // Ботов ровно столько, чтобы всего было TARGET_SNAKES
  for (let i = 0; i < 2 && players + bots < TARGET_SNAKES; i++) { spawnBot(); bots++; }
  // Владелец 07.10: пришли новые люди — лишние боты исчезают по одному (раз в 1,5 с), подальше от людей, чтобы не пропадали на глазах
  if (players + bots > TARGET_SNAKES && bots > 0 && tick >= nextBotLeave) { nextBotLeave = tick + Math.round(TICK_RATE * 1.5); removeOneBot(); }
}
let nextBotLeave = 0;
function removeOneBot() {
  let from = -1; // командный режим: убираем бота из команды, где змей больше
  if (TEAM) { const n = [0, 0]; for (const s of snakes.values()) if (s.team != null) n[s.team]++; from = n[0] === n[1] ? -1 : n[0] > n[1] ? 0 : 1; }
  const heads = []; for (const s of snakes.values()) if (!s.bot && s.alive) heads.push(s);
  let best = null, bestD = -Infinity; // раньше крупный бот рядом с людьми мог не уйти никогда (d уходило ниже -1)
  for (const b of snakes.values()) {
    if (!b.bot || !b.alive || (from >= 0 && b.team !== from)) continue;
    let d = 1e12; for (const h of heads) d = Math.min(d, (b.xs[0] - h.xs[0]) ** 2 + (b.ys[0] - h.ys[0]) ** 2);
    d -= b.mass * 400; // при равном расстоянии уходит бот поменьше
    if (d > bestD) { bestD = d; best = b; }
  }
  if (!best) return;
  best.alive = false; snakes.delete(best.id); diedThisTick.push(best.id); // тело тихо тает, еды не оставляет
}

const OBX = [], OBY = [], OBR = [];
let obN = 0;
function gatherObstacles(b, hx, hy, R, ignore) {
  obN = 0;
  const cx0 = Math.floor((hx - R) / GRID), cx1 = Math.floor((hx + R) / GRID);
  const cy0 = Math.floor((hy - R) / GRID), cy1 = Math.floor((hy + R) / GRID);
  for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
    const c = grid.get(gkey(cx, cy)); if (!c) continue;
    for (let j = 0; j < c.length; j++) {
      const p = c[j], o = PS[p];
      if (o === b || !o.alive || (TEAM && o.team === b.team)) continue;
      // Голову жертвы тоже боимся: раньше охотники отключали этот страх и сами врезались в неё (33 из 123 смертей)
      const dx = PX[p] - hx, dy = PY[p] - hy, rr = R + o.r;
      if (dx * dx + dy * dy > rr * rr) continue;
      OBX[obN] = PX[p]; OBY[obN] = PY[p]; OBR[obN] = o.r; obN++;
    }
  }
  // Куда чужие головы приедут через миг — туда тоже не лезем
  for (const o of snakes.values()) {
    if (o === b || !o.alive || (TEAM && o.team === b.team)) continue;
    const ox = o.xs[0], oy = o.ys[0];
    if (Math.abs(ox - hx) > R || Math.abs(oy - hy) > R) continue;
    const sp = speedFor(o.r, o.boosting);
    for (const t of [3, 7, 12]) { OBX[obN] = ox + Math.cos(o.a) * sp * t; OBY[obN] = oy + Math.sin(o.a) * sp * t; OBR[obN] = o.r * 1.4; obN++; }
  }
}

function clearance(hx, hy, th, L, myR) {
  const dx = Math.cos(th), dy = Math.sin(th);
  let best = L;
  for (let i = 0; i < obN; i++) {
    const vx = OBX[i] - hx, vy = OBY[i] - hy;
    const t = vx * dx + vy * dy;
    if (t < -5 || t > best + OBR[i] + myR) continue;
    const perp = Math.abs(vx * dy - vy * dx), rr = OBR[i] + myR + 8;
    if (perp < rr) { const hit = t - Math.sqrt(rr * rr - perp * perp); if (hit < best) best = hit < 0 ? 0 : hit; }
  }
  // Граница карты
  const Rb = MAP_R - myR - 40, hd = hx * dx + hy * dy, c = hx * hx + hy * hy - Rb * Rb;
  const disc = hd * hd - c;
  if (disc >= 0) { const t = -hd + Math.sqrt(disc); if (t < best) best = t < 0 ? 0 : t; }
  return best;
}

const cellCache = new Map();
function cellInfo(k) {
  let ci = cellCache.get(k);
  if (ci && ci.t === tick) return ci;
  const cell = fcells.get(k);
  let val = 0, sx = 0, sy = 0;
  if (cell) for (const f of cell) { val += f.v; sx += f.x * f.v; sy += f.y * f.v; }
  ci = { t: tick, val, x: val ? sx / val : 0, y: val ? sy / val : 0, cell };
  cellCache.set(k, ci);
  return ci;
}

function bestFood(b, hx, hy) {
  const R = 650;
  const cx0 = Math.floor((hx - R) / FCELL), cx1 = Math.floor((hx + R) / FCELL);
  const cy0 = Math.floor((hy - R) / FCELL), cy1 = Math.floor((hy + R) / FCELL);
  let best = null, bs = 0;
  for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
    const ci = cellInfo(((cx + 64) << 8) | (cy + 64));
    if (!ci.val) continue;
    const d = Math.hypot(ci.x - hx, ci.y - hy);
    if (d > R) continue;
    const turn = Math.abs(angDiff(b.a, Math.atan2(ci.y - hy, ci.x - hx)));
    const sc = Math.pow(ci.val, 1.15) / (d + 60) / (1 + turn * 0.5);
    if (sc > bs) { bs = sc; best = ci; }
  }
  if (!best) return null;
  let tx = best.x, ty = best.y;
  if (best.val < 10) { // мелочь — едем к ближайшей крошке, а не в «центр» клетки
    let md = Infinity;
    for (const f of best.cell) { const d = (f.x - hx) ** 2 + (f.y - hy) ** 2; if (d < md) { md = d; tx = f.x; ty = f.y; } }
  }
  return { x: tx, y: ty, val: best.val, d: Math.hypot(tx - hx, ty - hy) };
}

function findPrey(b, hx, hy) {
  let best = null, bs = 0;
  for (const o of snakes.values()) {
    if (o === b || !o.alive || (TEAM && o.team === b.team)) continue;
    if (smokes.length && inSmoke(o.xs[0], o.ys[0])) continue; // в дыму Ниндзя — не видно
    if (o.invisUntil > tick) continue; // 👻 невидимку боты не видят
    const dx = o.xs[0] - hx, dy = o.ys[0] - hy, d = Math.hypot(dx, dy);
    if (d > 550 + b.r * 4) continue;
    const ahead = -(Math.cos(o.a) * dx + Math.sin(o.a) * dy); // я впереди него (+) или сзади (−)
    if (ahead < -60) continue;
    if (o.mass > b.mass * 4 && b.ai.aggr < 0.8) continue;   // на гигантов бросаются только самые дерзкие
    if (b.mass > GIANT_MASS && o.bot) continue;              // гиганты на ботов не охотятся — берегут себя
    // Ботов друг на друга натравливаем реже, чем на людей — иначе боты в основном гибнут от своих же охотников
    const sc = (Math.sqrt(o.mass) + 5) / (d + 80) * (o.bot ? 1 : 1.15);
    if (sc > bs) { bs = sc; best = o; }
  }
  if (best && best.bot && Math.random() > BOT_HUNT_BOTS) return null; // как часто боты охотятся на ботов
  return best;
}

const OFFS = [0, 0.2, -0.2, 0.4, -0.4, 0.65, -0.65, 0.95, -0.95, 1.3, -1.3, 1.75, -1.75, 2.3, -2.3, Math.PI];
const SIM_T = 18; // шагов вперёд (~0,6 с)
// Сколько шагов бот проживёт, если будет поворачивать к углу th (SIM_T+1 — путь свободен)
function survive(b, hx, hy, th, boost) {
  const r = b.r, tr = turnFor(r, true), spd = speedFor(r, boost), rb = MAP_R - r - 30;
  // Охотник рискует (подрезает впритык); гигант осторожен (большой запас); остальные — обычный запас
  const margin = b.mass > GIANT_MASS ? 22 : b.ai && b.ai.prey ? 2 : 12;
  let x = hx, y = hy, a = b.a;
  for (let k = 1; k <= SIM_T; k++) {
    a += clamp(angDiff(a, th), -tr, tr);
    x += Math.cos(a) * spd; y += Math.sin(a) * spd;
    if (x * x + y * y > rb * rb) return k;
    if (k <= 6 || (k & 1) === 0) {
      for (let i = 0; i < obN; i++) {
        const dx = OBX[i] - x, dy = OBY[i] - y, rr = OBR[i] + r + margin;
        if (dx * dx + dy * dy < rr * rr) return k;
      }
    }
  }
  return SIM_T + 1;
}

function botThink(b) {
  const ai = b.ai, hx = b.xs[0], hy = b.ys[0], r = b.r;
  let desired = b.a, boost = false, ignore = null;
  if (ai.cool > 0) ai.cool -= 1;
  if (ai.boostT > 0) ai.boostT -= 1;

  if (ai.prey && (!ai.prey.alive || ai.preyT <= 0 || b.mass < MIN_BOOST_MASS + 3)) { ai.prey = null; ai.cool = 20; }
  if (!ai.prey && ai.cool <= 0 && b.mass > MIN_BOOST_MASS + 5 && Math.random() < ai.aggr * 0.6) {
    ai.prey = findPrey(b, hx, hy);
    if (ai.prey) { ai.preyT = Math.round(rand(90, 210)); ai.side = Math.random() < 0.5 ? -1 : 1; }
    else ai.cool = 10;
  }
  // Владелец 07.10: поиск еды — 15 раз в секунду (через шаг; половина ботов на чётном шаге, половина на нечётном), между поисками — та же цель
  if ((tick + b.id) % 2 === 0 || !ai.pileT) { ai.pile = bestFood(b, hx, hy); ai.pileT = 1; }
  const pile = ai.pile;
  if (pile) pile.d = Math.hypot(pile.x - hx, pile.y - hy);
  const dc = Math.hypot(hx, hy);

  if (dc > MAP_R - 350 - r * 3) {
    desired = Math.atan2(-hy, -hx) + ai.side * 0.5;
  } else if (ai.prey && !(pile && pile.val > 30 && ai.greed > ai.aggr)) {
    const o = ai.prey; ignore = o; ai.preyT -= 1;
    const ox = o.xs[0], oy = o.ys[0], dx = ox - hx, dy = oy - hy, dist = Math.hypot(dx, dy);
    if (b.mass > o.mass * 4 && dist < 200 + r * 6) {
      // Большой бот обвивает мелкую змейку кольцом
      desired = Math.atan2(dy, dx) + ai.side * (Math.PI / 2 - 0.35);
    } else {
      // Обгоняем и лезем прямо под голову: целимся в точку перед ней, потом пересекаем её путь
      const lead = 50 + o.r * 2 + dist * 0.35;
      const tx = ox + Math.cos(o.a) * lead, ty = oy + Math.sin(o.a) * lead;
      const dT = Math.hypot(tx - hx, ty - hy);
      const mySide = Math.sign(Math.cos(o.a) * (hy - oy) - Math.sin(o.a) * (hx - ox)) || 1;
      desired = dT < 40 + r * 2 ? o.a - mySide * Math.PI / 2 : Math.atan2(ty - hy, tx - hx);
      boost = dist < 420 && b.mass > MIN_BOOST_MASS + 3;
    }
  } else if (pile) {
    desired = Math.atan2(pile.y - hy, pile.x - hx);
    // Крупная еда (труп) — несёмся наперегонки
    if (pile.val > 12 && pile.d > 90 && b.mass > 25 && Math.random() < ai.boostLove * ai.greed) ai.boostT = 12;
    boost = ai.boostT > 0 && pile.d > 60;
  } else {
    ai.wanderA += rand(-0.3, 0.3);
    desired = ai.wanderA;
  }

  // Инстинкт самосохранения: для каждого направления «проигрываем в уме» путь на ~0,6 с вперёд
  // с настоящим радиусом поворота и скоростью и берём ближайшее к желаемому, где не врежемся.
  const spdNow = speedFor(r, boost);
  gatherObstacles(b, hx, hy, SIM_T * speedFor(r, true) + r * 2 + 60, ignore);
  let bestA = desired, bestS = -1, ok = false;
  for (let i = 0; i < OFFS.length; i++) {
    const th = desired + OFFS[i], sv = survive(b, hx, hy, th, boost);
    if (sv > SIM_T) { bestA = th; ok = true; break; }
    if (sv > bestS) { bestS = sv; bestA = th; }
  }
  if (!ok) {
    // Всюду тесно: пробуем вырваться ускорением, если есть чем
    boost = false;
    if (b.mass > MIN_BOOST_MASS + 4) {
      for (let i = 0; i < OFFS.length; i++) {
        const th = desired + OFFS[i], sv = survive(b, hx, hy, th, true);
        if (sv > bestS + 2) { bestS = sv; bestA = th; boost = true; }
      }
    }
  } else if (boost && survive(b, hx, hy, bestA, true) <= SIM_T) boost = false;
  void spdNow;
  b.ta = bestA;
  b.boost = boost;
  if (!ai.prey) ai.wanderA = bestA;
}

// ===== Игроки =====
const clients = new Set();

function sendJSON(c, obj) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); }

function cleanName(n) {
  // владелец 11.10: в нике только буквы, цифры, пробел и _ - . (ник «🏍» попал в топ — на карточке вместо фото был значок)
  n = String(n || '').normalize('NFC').replace(/[^\p{L}\p{N} _.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (!/\p{L}/u.test(n)) n = ''; // хотя бы одна буква
  if (!n || n.toLowerCase() === BOT_NAME.toLowerCase()) n = 'Игрок';
  return n;
}
function cleanSkin(sk) {
  sk = sk || {};
  let id = clamp(Math.floor(Number(sk.id)), 0, SKINS.length - 1) || 0;
  const col = (v, d) => (HEX_RE.test(v) ? v.toLowerCase() : d);
  const pat = Array.isArray(sk.pat) ? sk.pat.filter(v => typeof v === 'string' && HEX_RE.test(v)).slice(0, MAX_PATTERN).map(v => v.toLowerCase()) : [];
  const out = { id, c1: col(sk.c1, '#ff3355'), c2: col(sk.c2, '#33dd66'), c3: col(sk.c3, '#3388ff') };
  if (id === 0 && pat.length) out.pat = pat; // своя змейка из конструктора
  return out;
}

function handleJSON(c, m) {
  if (m.t === 'join') {
    if (c.snake && c.snake.alive) return;
    c.w = clamp(Number(m.w) || 1280, 200, 3000); c.h = clamp(Number(m.h) || 720, 200, 3000);
    const pos = process.env.TEST_SPAWN_AT ? { x: +process.env.TEST_SPAWN_AT.split(',')[0], y: +process.env.TEST_SPAWN_AT.split(',')[1] } : process.env.TEST_SPAWN_CENTER ? { x: 0, y: 300 } : findSpawn(false); // TEST_SPAWN_AT / TEST_SPAWN_CENTER — только для проверок
    if (TEAM && roundPause) return; // перерыв между раундами — браузер зайдёт сам через 10 с
    const team = TEAM ? (m.team === 0 || m.team === 1 ? m.team : teamWithFewer(true)) : null;
    if (TEAM && !process.env.TEST_SPAWN_CENTER) { const p = findSpawn(false, BASES[team][0], BASES[team][1], 1300); pos.x = p.x; pos.y = p.y; } // у своей базы
    const s = new Snake(pos.x, pos.y, START_MASS, false, cleanName(m.name), cleanSkin(m.skin));
    if (TEAM) { s.team = team; setTeamSkin(s); s.born = tick; c.rs = c.rs || { kills: 0, orbs: 0, caps: 0, life: 0 }; c.rs.name = s.name; c.rs.team = team; }
    if (process.env.TEST_ORB_NEAR) { const o = orbs[0]; o.alive = true; o.x = s.xs[0] + Math.cos(s.a) * Number(process.env.TEST_ORB_NEAR); o.y = s.ys[0] + Math.sin(s.a) * Number(process.env.TEST_ORB_NEAR); } // только для проверок: шар на таком расстоянии перед новой змеёй
    if (process.env.TEST_SPAWN_AT && process.env.TEST_SPAWN_AT.split(',')[2]) { const an = +process.env.TEST_SPAWN_AT.split(',')[2]; s.a = s.ta = an; for (let i = 0; i < s.xs.length; i++) { s.xs[i] = pos.x - Math.cos(an) * i * SEG_D; s.ys[i] = pos.y - Math.sin(an) * i * SEG_D; } s.bbox(); } // только для проверок: куда смотрит
    s.client = c; c.snake = s; c.inA = s.a;
    if (TEAM && process.env.TEST_FLAG) { const f = flags[1 - s.team]; f.x = s.xs[0] + Math.cos(s.a) * 5; f.y = s.ys[0] + Math.sin(s.a) * 5; BASES[s.team] = [s.xs[0] + Math.cos(s.a) * 200, s.ys[0] + Math.sin(s.a) * 200];
      if (process.env.TEST_TARGET) { const pa = s.a + Math.PI / 2, bx = s.xs[0] + Math.cos(s.a) * 600 + Math.cos(pa) * 150, by = s.ys[0] + Math.sin(s.a) * 600 + Math.sin(pa) * 150; const b = new Snake(bx, by, 800, true, 'Мишень', randomSkin()); b.a = b.ta = pa; for (let i = 0; i < b.xs.length; i++) { b.xs[i] = bx - Math.cos(pa) * i * SEG_D; b.ys[i] = by - Math.sin(pa) * i * SEG_D; } b.team = 1 - s.team; setTeamSkin(b); snakes.set(b.id, b); } } // только для проверок: чужое знамя у головы, своя база рядом
    if (process.env.TEST_HOST) { const hx = s.xs[0] + Math.cos(s.a) * 8, hy = s.ys[0] + Math.sin(s.a) * 8, h = new Snake(hx, hy, 1200, true, 'Хозяин', randomSkin()); h.a = h.ta = s.a; h.ai = null; const n = h.xs.length; for (let i = 0; i < n; i++) { h.xs[i] = hx + Math.cos(s.a) * (n - 1 - i) * SEG_D; h.ys[i] = hy + Math.sin(s.a) * (n - 1 - i) * SEG_D; } h.bbox(); h.botThinkOff = true; snakes.set(h.id, h); } // только для проверок Зубастика: хвост большой змеи прямо перед носом
    if (process.env.TEST_ITEM) { items.push({ id: ++itemSeq, type: process.env.TEST_ITEM, x: s.xs[0] + Math.cos(s.a) * 20, y: s.ys[0] + Math.sin(s.a) * 20 }); itemsDirty = true; } // только для проверок: предмет перед носом
    if (process.env.TEST_WEAPONS) { s.bomb = 2; s.rockets = 2; s.knife = process.env.TEST_WEAPONS === 'knife' ? 2 : 0; s.badge = process.env.TEST_WEAPONS === 'badge' ? 2 : 0; if (s.knife || s.badge) { s.rockets = 0; s.bomb = 0; } } // только для проверок: оружие сразу
    snakes.set(s.id, s);
    stats.onJoin(c);
    sendJSON(c, { t: 'spawn', id: s.id, ...(TEAM ? { team: s.team } : {}) });
    if (!TEAM && s.skin.id === NINJA_ID) { s.smoke = 2; sendJSON(c, { t: 'tmsgMe', text: '🥷 2 дымовые шашки — 💨' + (isTouchUA(c) ? '' : ' или F') }); } // владелец 13.10: две шашки; надпись короче — мешала
    if (!TEAM && s.skin.id === TEETH_ID) sendJSON(c, { t: 'tmsgMe', text: '🦎 Вы Зубастик! Один раз за жизнь, врезавшись в змею, спасётесь — отбросите хвост, как ящерица' });
  } else if (m.t === 'view') {
    c.w = clamp(Number(m.w) || 1280, 200, 3000); c.h = clamp(Number(m.h) || 720, 200, 3000);
  } else if (m.t === 'fire') {
    if (c.snake && c.snake.alive) { if (c.snake.item) useItem(c.snake); else if (c.snake.rockets) fireRocket(c.snake); else if (c.snake.bomb) throwBomb(c.snake); else if (c.snake.knife) throwKnife(c.snake); else if (c.snake.badge) throwKnife(c.snake, true); else if (c.snake.shock) { c.snake.shock--; doShock(c.snake); } else if (c.snake.smoke) throwSmoke(c.snake); }
  } else if (m.t === 'ping') {
    c.lagMs = clamp(Number(m.l) || 0, 0, 400); // владелец 14.10: насколько игрок видит чужих змей «в прошлом» (не больше 0,4 с)
    sendJSON(c, { t: 'pong', c: m.c });
  }
}

// ===== Отправка состояния =====
const OUT = Buffer.allocUnsafe(1 << 21);
const OUT_SAFE = OUT.length - 70000;

function sendState(c) {
  // Не копим очередь: если телефон не успел принять прошлое обновление — пропускаем этот кадр,
  // иначе он получает мир «из прошлого» и задержка растёт (так и было: пинг 281 мс при Wi-Fi 4 мс)
  if (c.ws.readyState !== 1 || c.ws.bufferedAmount > 12000) return;
  const me = c.snake;
  let vx, vy, r = 10;
  if (me && me.alive) { vx = me.xs[0]; vy = me.ys[0]; r = me.r; c.vx = vx; c.vy = vy; }
  else { vx = c.vx; vy = c.vy; }
  const sc = viewScale(c.w, c.h, r, me && me.alive ? me.role : 0, TEAM && me && me.alive ? me.mass : 0, me && me.alive && me.skin.id === EYE_ID);
  const hw = c.w / 2 / sc + 260, hh = c.h / 2 / sc + 260; // запас под «взгляд вперёд» камеры в браузере
  let x0 = vx - hw, x1 = vx + hw, y0 = vy - hh, y1 = vy + hh;
  // Своя змея в тоннеле: камера плавно переплывает от входа к выходу — шлём картинку вокруг обеих нор
  if (me && me.alive && me.tun) { const T = me.tun; x0 = Math.min(x0, T.ax - hw); x1 = Math.max(x1, T.ax + hw); y0 = Math.min(y0, T.ay - hh); y1 = Math.max(y1, T.ay + hh); }

  let o = 0, metas = null;
  OUT[o++] = 1;
  OUT.writeUInt32LE(tick, o); o += 4;
  OUT.writeFloatLE(vx, o); o += 4;
  OUT.writeFloatLE(vy, o); o += 4;
  const nsPos = o; o += 2;
  let ns = 0;
  for (const t of snakes.values()) {
    if (!t.alive) continue;
    const m = t.r + 4;
    if (t.maxX + m < x0 || t.minX - m > x1 || t.maxY + m < y0 || t.minY - m > y1) continue;
    if (o > OUT_SAFE) break;
    const start = o;
    const step = Math.max(2, Math.floor(t.r * 0.6 / SEG_D)), xs = t.xs, ys = t.ys, len = xs.length;
    OUT.writeUInt16LE(t.id, o); o += 2;
    OUT[o++] = t.boosting ? 1 : 0;
    OUT[o++] = Math.round((t.a + Math.PI) / TAU * 256) & 255;
    OUT.writeUInt16LE(Math.min(65535, Math.floor(t.mass)), o); o += 2;
    OUT[o++] = Math.min(255, Math.round(t.r * 4));
    OUT[o++] = step;
    OUT.writeUInt16LE(len, o); o += 2;
    const nrPos = o; o += 2;
    let nr = 0, open = false, cntPos = 0, cnt = 0;
    const emit = i => {
      const x = xs[i], y = ys[i];
      if (x > x0 - m && x < x1 + m && y > y0 - m && y < y1 + m) {
        if (!open) { open = true; OUT.writeUInt16LE(i, o); o += 2; cntPos = o; o += 2; cnt = 0; nr++; }
        OUT.writeInt16LE(Math.round(x * 4), o); o += 2;
        OUT.writeInt16LE(Math.round(y * 4), o); o += 2;
        cnt++;
      } else if (open) { OUT.writeUInt16LE(cnt, cntPos); open = false; }
    };
    for (let i = 0; i < len; i += step) emit(i);
    if (open) { OUT.writeUInt16LE(cnt, cntPos); open = false; }
    if ((len - 1) % step) { emit(len - 1); if (open) { OUT.writeUInt16LE(cnt, cntPos); open = false; } }
    if (!nr) { o = start; continue; }
    OUT.writeUInt16LE(nr, nrPos);
    ns++;
    const kn = c.known.get(t.id);
    if (!kn || kn.s !== t || kn.name !== t.name || kn.role !== (t.role || 0)) { // новая змея или сменилась роль
      (metas || (metas = [])).push([t.id, t.name, t.skin.id, t.skin.c1, t.skin.c2, t.skin.c3, t.bot ? 1 : 0, t.skin.pat || 0, t.role || 0, t.team == null ? -1 : t.team]);
      c.known.set(t.id, { s: t, name: t.name, role: t.role || 0 });
    }
  }
  OUT.writeUInt16LE(ns, nsPos);

  // Еда: целиком для новых клеток обзора, для старых — только изменения
  const fx0 = Math.floor((x0 - 100) / FCELL), fx1 = Math.floor((x1 + 100) / FCELL);
  const fy0 = Math.floor((y0 - 100) / FCELL), fy1 = Math.floor((y1 + 100) / FCELL);
  const want = new Set(), adds = [], rems = [];
  for (let cx = fx0; cx <= fx1; cx++) for (let cy = fy0; cy <= fy1; cy++) {
    const k = ((cx + 64) << 8) | (cy + 64);
    want.add(k);
    if (!c.cells.has(k)) { const cell = fcells.get(k); if (cell) for (const f of cell) adds.push(f); }
    else { const e = cellEv.get(k); if (e) { for (const f of e.add) adds.push(f); for (const v of e.rem) rems.push(v); } }
  }
  const dropCells = [];
  for (const k of c.cells) if (!want.has(k)) dropCells.push(k);
  c.cells = want;

  let nAdd = Math.min(adds.length, Math.floor((OUT.length - o - 40000) / 11));
  OUT.writeUInt16LE(nAdd, o); o += 2;
  for (let i = 0; i < nAdd; i++) {
    const f = adds[i];
    OUT.writeUInt32LE(f.id, o); o += 4;
    OUT.writeInt16LE(Math.round(f.x * 4), o); o += 2;
    OUT.writeInt16LE(Math.round(f.y * 4), o); o += 2;
    OUT[o++] = Math.round(f.r * 4);
    OUT.writeUInt16LE(f.c, o); o += 2;
  }
  const nRem = rems.length / 2;
  OUT.writeUInt16LE(nRem, o); o += 2;
  for (let i = 0; i < rems.length; i += 2) {
    OUT.writeUInt32LE(rems[i], o); o += 4;
    OUT.writeUInt16LE(rems[i + 1], o); o += 2;
  }
  OUT.writeUInt16LE(dropCells.length, o); o += 2;
  for (const k of dropCells) { OUT.writeUInt16LE(k, o); o += 2; }
  OUT.writeUInt16LE(diedThisTick.length, o); o += 2;
  for (const id of diedThisTick) { OUT.writeUInt16LE(id, o); o += 2; }

  if (metas) sendJSON(c, { t: 'meta', list: metas });
  c.ws.send(Buffer.from(OUT.subarray(0, o)));
}

function liveCounts() {
  let inGame = 0, bots = 0;
  for (const s of snakes.values()) { if (s.bot) bots++; else inGame++; }
  return { inGame, inMenu: Math.max(0, clients.size - inGame), bots };
}
function sendLeaderboard() {
  { const L = liveCounts(); stats.sample(L.inGame, clients.size); }
  const arr = [];
  for (const s of snakes.values()) if (s.alive) arr.push(s);
  arr.sort((a, b) => b.mass - a.mass);
  const top = arr.slice(0, 10).map(s => [displayName(s), Math.floor(s.mass), s.id, s.team == null ? -1 : s.team, s.name, s.role || 0]); // + ник и роль отдельно — в рейтинге разными цветами (владелец 13.10)
  const rank = new Map();
  arr.forEach((s, i) => rank.set(s, i + 1));
  // Миникарта как в оригинале: тело каждой змеи — короткая ломаная (до 30 точек, координаты 0..255).
  // Первое число — 1 у живого игрока, 0 у бота. Шлём раз в секунду: этого хватает, а трафик меньше.
  let mm = null;
  if (tick % TICK_RATE === 0) {
    mm = [];
    const q = v => Math.max(0, Math.min(255, Math.round((v / MAP_R + 1) * 127.5)));
    for (const s of arr) {
      if (smokes.length && inSmoke(s.xs[0], s.ys[0])) continue; // в дыму Ниндзя — на миникарте не видно
      if (s.invisUntil > tick) continue; // 👻 невидимки на миникарте нет
      const len = s.xs.length, step = Math.max(Math.round(150 / SEG_D), Math.ceil(len / 30));
      const line = [(s.bot ? 0 : 1) | (s.team == null ? 0 : (s.team + 1) << 1)];
      for (let i = 0; i < len; i += step) line.push(q(s.xs[i]), q(s.ys[i]));
      line.push(q(s.xs[len - 1]), q(s.ys[len - 1]));
      mm.push(line);
    }
  }
  const players = arr.reduce((n, s) => n + (s.bot ? 0 : 1), 0);
  const pn = arr.filter(s => !s.bot).map(s => [s.name, Math.floor(s.mass)]); // ники живых людей — по нажатию на цифру внизу
  const ev = event ? [event.type, Math.ceil((event.until - tick) / TICK_RATE), Math.round(event.x), Math.round(event.y)] : null;
  const rec = tick % (TICK_RATE * 5) === 0 ? recView() : null; // рекорды — раз в 5 с
  const vis = rec ? (TEAM ? teamVis : stats.visits()) : null; // посетители за день/неделю/месяц — раз в 5 с
  const tm = TEAM ? teamScores() : null;
  for (const c of clients) {
    const me = c.snake && c.snake.alive ? c.snake : null;
    sendJSON(c, { t: 'lb', ...(tm ? { tm } : {}), top, rank: me ? rank.get(me) : 0, score: me ? Math.floor(me.mass) : 0, total: arr.length, players, pn, online: clients.size, ...(mm ? { mm } : {}), ...(ev ? { ev } : {}), ...(rec ? { rec } : {}), ...(vis ? { vis } : {}) });
  }
}

// ===== Шаг мира =====
// ===== События на карте (владелец 06.10): раз в 10 минут по очереди «Ночь мафии» и «Золотая еда» =====
const EVENT_EVERY = (Number(process.env.TEST_EVENT_EVERY) || 180) * TICK_RATE; // владелец 07.10: «Ночь мафии» убрана (слишком часто), осталась золотая еда раз в 3 минуты; TEST_EVENT_EVERY — только для проверок
const NIGHT_LEN = 60 * TICK_RATE, GOLD_LEN = 45 * TICK_RATE;
let event = null, nextEventAt = Math.round(EVENT_EVERY / 2), nextEventType = process.env.TEST_EVENT_FIRST || 'gold'; // TEST_EVENT_FIRST — только для проверок
function runEvents() {
  if (TEAM) return; // в командном режиме событий нет
  if (event && tick >= event.until) event = null;
  if (event || tick < nextEventAt) return;
  let players = 0; for (const s of snakes.values()) if (!s.bot) players++;
  if (!players) { nextEventAt = tick + Math.min(30 * TICK_RATE, Math.round(EVENT_EVERY / 4)); return; } // никого нет — ждём людей
  if (nextEventType === 'night') {
    event = { type: 'night', until: tick + NIGHT_LEN, x: 0, y: 0 };
  } else {
    const a = rand(0, TAU), d = Math.sqrt(Math.random()) * (MAP_R - 900);
    const x = Math.cos(a) * d, y = Math.sin(a) * d;
    for (let i = 0; i < 140; i++) { // россыпь крупной золотой еды
      const ra = rand(0, TAU), rd = Math.sqrt(Math.random()) * 320;
      addFood(x + Math.cos(ra) * rd, y + Math.sin(ra) * rd, valueOfSize(rand(11, 16)), hexTo565('#ffd52e'), true);
    }
    event = { type: 'gold', until: tick + GOLD_LEN, x, y };
  }
  nextEventType = 'gold'; // владелец 07.10: ночи больше нет — только золотая еда
  nextEventAt = tick + EVENT_EVERY;
}
// ===== Светящиеся шары (командный режим, владелец 07.10): убегают от змей, догнал — змея сразу заметно длиннее =====
const ORB_N = 7, ORB_BASE_N = 4, // 4 шара всегда, ещё 3 — только в последнюю минуту раунда
   ORB_R = 22, ORB_VALUE = 150, ORB_FLEE = 9, ORB_WANDER = 2, ORB_SEE = 450, ORB_RESPAWN = 8 * TICK_RATE;
const orbs = [];
function placeOrb(o) {
  const a = rand(0, TAU), d = Math.sqrt(Math.random()) * (MAP_R - 800);
  o.x = Math.cos(a) * d; o.y = Math.sin(a) * d; o.a = rand(0, TAU); o.alive = true; o.back = 0;
}
for (let i = 0; i < ORB_N; i++) { const o = { i }; placeOrb(o); orbs.push(o); }
function stepOrbs() {
  if (TEAM && roundPause) return; // владелец 07.10: светящиеся шары и в обычной игре
  for (const o of orbs) {
    if (o.i >= ORB_BASE_N && !finalMin) { o.alive = false; continue; }
    if (!o.alive) { if (tick >= o.back) placeOrb(o); continue; }
    // ближайшая голова: от неё убегаем (быстрее обычной змеи, медленнее ускорения — догнать можно только с ускорением)
    let near = null, nd = ORB_SEE * ORB_SEE;
    for (const s of snakes.values()) {
      if (!s.alive) continue;
      const dx = o.x - s.xs[0], dy = o.y - s.ys[0], d = dx * dx + dy * dy, rr = ORB_R + s.r;
      if (d < rr * rr) { // поймали
        s.mass += ORB_VALUE; o.alive = false; o.back = tick + ORB_RESPAWN;
        if (s.client && s.client.rs) s.client.rs.orbs++;
        if (s.client) sendJSON(s.client, { t: 'orbEat', v: ORB_VALUE });
        break;
      }
      if (d < nd) { nd = d; near = s; }
    }
    if (!o.alive) continue;
    let sp = ORB_WANDER;
    if (near) { o.a = Math.atan2(o.y - near.ys[0], o.x - near.xs[0]) + Math.sin(tick * 0.15 + o.i) * 0.5; sp = ORB_FLEE; } // убегает зигзагом
    else o.a += rand(-0.15, 0.15);
    const dc = Math.hypot(o.x, o.y);
    if (dc > MAP_R - 300) { // у края разворачивается к центру, чтобы не застрять
      const toC = Math.atan2(-o.y, -o.x);
      o.a = toC + clamp(angDiffS(toC, o.a), -1.2, 1.2);
    }
    o.x += Math.cos(o.a) * sp; o.y += Math.sin(o.a) * sp;
  }
  if (!TEAM) { // обычная игра: шары, базука Дона и бомба Бомбы (без знамён и тревог)
    stepRockets(); stepBombs(); stepKnives();
    if (tick % 3 === 0) {
      const m = { t: 'orbs', o: orbs.map(o => o.alive ? [o.i, Math.round(o.x), Math.round(o.y)] : [o.i]) };
      for (const s of snakes.values()) if (s.alive && s.rockets) (m.z || (m.z = [])).push([s.id, s.rockets]);
      for (const s of snakes.values()) if (s.alive && s.bomb) (m.b || (m.b = [])).push([s.id, s.bomb]); // у кого бомбы едут рядом и сколько
      for (const s of snakes.values()) if (s.alive && s.knife) (m.kn || (m.kn = [])).push([s.id, s.knife]); // у кого сколько кинжалов
      for (const s of snakes.values()) if (s.alive && s.badge) (m.bd || (m.bd = [])).push([s.id, s.badge]);
      for (const s of snakes.values()) if (s.alive && s.shock) (m.sh || (m.sh = [])).push([s.id, s.shock]); // шокер Параноика // у какого Шерифа сколько бросков значка
      for (const s of snakes.values()) if (s.alive && s.smoke) (m.sm || (m.sm = [])).push([s.id, s.smoke]); // у какого Ниндзя сколько шашек
      for (const s of snakes.values()) if (s.alive) { // действующие предметы: оглушён, невидим, магнит, ускоритель
        if (s.stunUntil > tick) (m.st || (m.st = [])).push(s.id);
        if (s.invisUntil > tick) (m.iv || (m.iv = [])).push(s.id);
        if (s.magnetUntil > tick) (m.mg || (m.mg = [])).push(s.id);
        if (s.turboUntil > tick) (m.tb || (m.tb = [])).push(s.id);
        if (s.item) (m.pk || (m.pk = [])).push([s.id, ITEM_TYPES.indexOf(s.item)]); // предмет на поясе (владелец 14.10)
      }
      if (itemsDirty || tick % (TICK_RATE * 2) < 3) { m.it = items.map(i => [i.id, ITEM_TYPES.indexOf(i.type), Math.round(i.x), Math.round(i.y)]); itemsDirty = false; } // предметы на карте — при изменении и раз в 2 с
      const msg = JSON.stringify(m); for (const c of clients) if (c.ws.readyState === 1) c.ws.send(msg);
    }
    return;
  }
  stepFlags();
  stepRockets();
  if (tick % 10 === 0) checkAlarms();
  if (tick % 3 === 0) { // 10 раз в секунду: шары, флаги, кто «в ударе»; тревоги — только своей команде
    const base = { t: 'orbs', o: orbs.map(o => o.alive ? [o.i, Math.round(o.x), Math.round(o.y)] : [o.i]),
      f: flags.map(f => [Math.round(f.x), Math.round(f.y), f.carrier ? f.carrier.id : 0, f.home ? 1 : 0]), h: [] };
    for (const s of snakes.values()) if (s.alive) { if (s.hot) base.h.push(s.id); if (s.havana) (base.c || (base.c = [])).push(s.id); if (s.rockets) (base.z || (base.z = [])).push([s.id, s.rockets]); }
    const msgs = [0, 1].map(t => { const a = alarms.filter(x => x.team === t && x.until > tick).map(x => [Math.round(x.x), Math.round(x.y)]); return JSON.stringify(a.length ? { ...base, a } : base); });
    const plain = JSON.stringify(base);
    for (const c of clients) if (c.ws.readyState === 1) { const t = c.snake ? c.snake.team : c.rs ? c.rs.team : -1; c.ws.send(t === 0 || t === 1 ? msgs[t] : plain); }
  }
}
// ===== Флаги (владелец 07.10): у каждой команды база со знаменем. Украл чужое знамя и довёз до своей базы — +2000 команде =====
const BASES = [[-3200, 0], [3200, 0]], BASE_R = 300, FLAG_R = 45, FLAG_POINTS = 2000, FLAG_BACK_SEC = 30;
const TEAM_GEN = ['Мирных', 'Мафии'];
const flags = BASES.map(([x, y]) => ({ x, y, home: true, carrier: null, dropT: 0 }));
let teamCaps = [0, 0];
function flagHome(f, t) { f.x = BASES[t][0]; f.y = BASES[t][1]; f.home = true; f.carrier = null; }
// База вспыхивает (владелец 07.10): сотни маленьких красных шаров по всей базе, лежат 90 с — собирай и расти
function baseFire(team, total) {
  const [bx, by] = BASES[team], n = 450, v = total / n, col = hexTo565('#ff2b2b');
  for (let i = 0; i < n; i++) { const a = rand(0, TAU), d = Math.sqrt(Math.random()) * BASE_R * 1.15; addFood(bx + Math.cos(a) * d, by + Math.sin(a) * d, v, col, true); }
  for (const c of clients) sendJSON(c, { t: 'baseFire', team });
}
function teamMsg(text) { for (const c of clients) sendJSON(c, { t: 'tmsg', text }); }
function stepFlags() {
  for (let t = 0; t < 2; t++) {
    const f = flags[t];
    if (f.carrier) {
      const k = f.carrier;
      if (!k.alive) { f.carrier = null; f.dropT = tick; teamMsg(`🚩 Знамя ${TEAM_GEN[t]} упало! Свои — верните его, чужие — подхватите`); continue; }
      f.x = k.xs[0]; f.y = k.ys[0];
      const b = BASES[k.team];
      if (Math.hypot(f.x - b[0], f.y - b[1]) < BASE_R) {
        teamCaps[k.team]++; if (k.client && k.client.rs) k.client.rs.caps++;
        // Владелец 07.10: довёз знамя — вся база вспыхивает огнями (еды на «вырасти в 5 раз»), собирай и расти; плюс сигара «Гавана»
        k.havana = true; k.caps = (k.caps || 0) + 1;
        const add = k.caps === 1 ? 2 : k.caps === 2 ? 4 : 5; // владелец 07.10: за 1-е знамя 2 ракеты, за 2-е ещё 4, дальше по 5
        k.rockets = (k.rockets || 0) + add;
        if (k.client) sendJSON(k.client, { t: 'tmsgMe', text: `🚀 +${add} ракет${add === 2 || add === 4 ? 'ы' : ''} в базуку (всего ${k.rockets})! Жмите 🚀` + (isTouchUA(k.client) ? '' : ', правую кнопку мыши или F') });
        baseFire(k.team, Math.min(20000, Math.max(k.mass * 4, 1000)));
        teamMsg(`🏁 ${k.name} довёз знамя ${TEAM_GEN[t]}! +${FLAG_POINTS} команде — база ${TEAM_GEN[k.team]} засияла огнями, собирайте! 🚬`);
        flagHome(f, t);
      }
      continue;
    }
    if (!f.home && tick - f.dropT > FLAG_BACK_SEC * TICK_RATE) { flagHome(f, t); teamMsg(`🚩 Знамя ${TEAM_GEN[t]} вернулось на базу`); continue; }
    for (const s of snakes.values()) {
      if (!s.alive || s.bot) continue; // знамёнами играют люди
      const dx = s.xs[0] - f.x, dy = s.ys[0] - f.y, rr = FLAG_R + s.r;
      if (dx * dx + dy * dy > rr * rr) continue;
      if (s.team !== t) { f.carrier = s; f.home = false; teamMsg(`🚩 ${s.name} украл знамя ${TEAM_GEN[t]}! Догоните его!`); break; }
      if (!f.home) { flagHome(f, t); teamMsg(`🚩 ${s.name} вернул знамя ${TEAM_GEN[t]} на базу`); break; }
    }
  }
}
// ===== Тревога своим: на нашего человека напал соперник (чужая голова рядом) — свои видят мигающую точку на миникарте =====
const alarms = [];
function addAlarm(team, x, y) {
  for (const a of alarms) if (a.team === team && Math.hypot(a.x - x, a.y - y) < 400) { a.x = x; a.y = y; a.until = tick + 3 * TICK_RATE; return; }
  alarms.push({ team, x, y, until: tick + 3 * TICK_RATE });
}
function checkAlarms() {
  for (let i = alarms.length - 1; i >= 0; i--) if (alarms[i].until <= tick) alarms.splice(i, 1);
  for (const s of snakes.values()) {
    if (s.bot || !s.alive) continue;
    for (const o of snakes.values()) {
      if (!o.alive || o.team === s.team) continue;
      const dx = o.xs[0] - s.xs[0], dy = o.ys[0] - s.ys[0];
      if (dx * dx + dy * dy < 350 * 350) { addAlarm(s.team, s.xs[0], s.ys[0]); break; }
    }
  }
}
// ===== Базука (владелец 07.10): довёз знамя — выстрел; две ракеты летят вперёд с боков головы; попала в соперника — он погибает =====
const ROCKET_SP = 32, ROCKET_LIFE = Math.round(1.3 * TICK_RATE), ROCKET_HIT = 14;
const rockets = []; let rocketSeq = 0;
const isTouchUA = c => /Android|iPhone|iPad|Mobile/i.test(c.ua || '');
function fireRocket(s) {
  if (!s.rockets) return;
  s.rockets--;
  const px = -Math.sin(s.a), py = Math.cos(s.a), off = s.r * 1.6;
  s.rSide = -(s.rSide || 1); // владелец 07.10: одна ракета за выстрел, по очереди из левой и правой трубы
  for (const side of [s.rSide]) {
    const r = { id: ++rocketSeq, owner: s, team: s.team, x: s.xs[0] + px * off * side, y: s.ys[0] + py * off * side, vx: Math.cos(s.a) * ROCKET_SP, vy: Math.sin(s.a) * ROCKET_SP, die: tick + ROCKET_LIFE };
    rockets.push(r);
    for (const c of clients) sendJSON(c, { t: 'rocket', id: r.id, x: Math.round(r.x), y: Math.round(r.y), vx: r.vx, vy: r.vy, life: ROCKET_LIFE * TICK_MS, o: s.id });
  }
}
function stepRockets() {
  for (let i = rockets.length - 1; i >= 0; i--) {
    const r = rockets[i];
    let hit = null;
    // летим по 4 подшага, чтобы не проскочить тонкую змею
    for (let k = 0; k < 4 && !hit; k++) {
      r.x += r.vx / 4; r.y += r.vy / 4;
      const cx = Math.floor(r.x / GRID), cy = Math.floor(r.y / GRID);
      for (let gx = cx - 1; gx <= cx + 1 && !hit; gx++) for (let gy = cy - 1; gy <= cy + 1 && !hit; gy++) {
        const cell = grid.get(gkey(gx, gy)); if (!cell) continue;
        for (const p of cell) {
          const o = PS[p]; if (!o.alive || o === r.owner || (TEAM && o.team === r.team)) continue;
          const dx = PX[p] - r.x, dy = PY[p] - r.y, rr = o.r + ROCKET_HIT;
          if (dx * dx + dy * dy < rr * rr) { hit = o; break; }
        }
      }
    }
    const out = Math.hypot(r.x, r.y) > MAP_R;
    if (hit || out || tick >= r.die) {
      rockets.splice(i, 1);
      for (const c of clients) sendJSON(c, { t: 'boom', id: r.id, x: Math.round(r.x), y: Math.round(r.y), hit: hit ? 1 : 0, o: r.owner.id });
      if (hit && !docSave(hit)) { const killer = r.owner.alive ? r.owner : null; if (!hit.bot || (killer && !killer.bot)) teamMsg(`💥 ${r.owner.name} подбил базукой ${hit.name}!`); killSnake(hit, killer); }
    }
  }
}
// ===== Бомба (владелец 11.10): летит вперёд ~0,6 с по дуге, падает, фитиль догорает 0,9 с — взрыв.
// Все чужие змеи, чья голова в радиусе взрыва, погибают (Доктор отскакивает, как обычно). Бросивший не страдает.
const BOMB_FLY = Math.round(0.6 * TICK_RATE), BOMB_FUSE = Math.round(0.9 * TICK_RATE), BOMB_DIST = 430, BOMB_R = 170;
const bombs = []; let bombSeq = 0;
function throwBomb(s) {
  if (!s.bomb) return;
  s.bomb--;
  launchBomb(s);
}
function launchBomb(s, fromItem) {
  const px = -Math.sin(s.a), py = Math.cos(s.a), side = s.r * 1.9;
  const x0 = s.xs[0] + px * side, y0 = s.ys[0] + py * side; // бомба едет справа от головы — оттуда и летит
  let tx = x0 + Math.cos(s.a) * BOMB_DIST, ty = y0 + Math.sin(s.a) * BOMB_DIST;
  const d = Math.hypot(tx, ty), lim = MAP_R - 60; if (d > lim) { tx *= lim / d; ty *= lim / d; }
  const b = { id: ++bombSeq, owner: s, x: tx, y: ty, boomAt: tick + BOMB_FLY + BOMB_FUSE };
  bombs.push(b);
  const msg = JSON.stringify({ t: 'bomb', id: b.id, x0: Math.round(x0), y0: Math.round(y0), x: Math.round(tx), y: Math.round(ty), fly: BOMB_FLY * TICK_MS, fuse: BOMB_FUSE * TICK_MS, o: s.id, ...(fromItem ? { it: 1 } : {}) });
  for (const c of clients) if (c.ws.readyState === 1) c.ws.send(msg);
}
function stepBombs() {
  for (let i = bombs.length - 1; i >= 0; i--) {
    const b = bombs[i]; if (tick < b.boomAt) continue;
    bombs.splice(i, 1);
    const hit = [];
    for (const o of snakes.values()) {
      if (!o.alive || o === b.owner) continue;
      const rr = BOMB_R + o.r, dx = o.xs[0] - b.x, dy = o.ys[0] - b.y;
      if (dx * dx + dy * dy < rr * rr) { hit.push(o); continue; }
      // Владелец 11.10: голова цела, а тело задето — змея жива, но кусок, попавший в круг, отлетает светящейся едой
      const xs = o.xs, ys = o.ys, inR = BOMB_R + o.r * 0.5, pts = [];
      for (let i = 1; i < xs.length; i++) { const ex = xs[i] - b.x, ey = ys[i] - b.y; if (ex * ex + ey * ey < inR * inR) pts.push(i); }
      if (!pts.length) continue;
      const loss = Math.min(o.mass - START_MASS, o.mass * pts.length / xs.length); // доля тела в круге = доля длины
      if (loss <= 0) continue;
      o.mass -= loss; // тело укоротится с хвоста плавно (moveSnake), еда — там, где был взрыв
      const n = clamp(Math.round(pts.length / 2), 2, 60), v = loss * 0.6 / n;
      for (let j = 0; j < n; j++) { const i = pts[Math.floor(j * pts.length / n)], sp = o.r * 0.8; addFood(xs[i] + rand(-sp, sp), ys[i] + rand(-sp, sp), v, o.dropColor(j), true); }
      if (o.client) sendJSON(o.client, { t: 'tmsgMe', text: `💣 Взрывом оторвало кусок: −${Math.round(loss)}` });
      if (b.owner.client && !b.owner.bot) sendJSON(b.owner.client, { t: 'tmsgMe', text: `💣 Оторвали кусок у ${o.name}: −${Math.round(loss)}` });
    }
    const msg = JSON.stringify({ t: 'bombBoom', id: b.id, x: Math.round(b.x), y: Math.round(b.y), r: BOMB_R, hit: hit.length, o: b.owner.id });
    for (const c of clients) if (c.ws.readyState === 1) c.ws.send(msg);
    const killer = b.owner.alive ? b.owner : null;
    for (const o of hit) if (!docSave(o)) { if (!o.bot || (killer && !killer.bot)) teamMsg(`💣 ${b.owner.name} взорвал ${o.name}!`); killSnake(o, killer); }
  }
}
// ===== Кинжал Киллера (владелец 11.10): летит вперёд, вращаясь; задел тело — разрубает змею пополам (всё от удара до хвоста
// рассыпается едой, передняя часть живёт дальше), летит дальше и разрубает вторую. Попал в голову — змея погибает.
const KNIFE_SP = 28, KNIFE_LIFE = Math.round(1.1 * TICK_RATE), KNIFE_MAX = 2;
const knives = []; let knifeSeq = 0;
function throwKnife(s, badge, fromItem) { // badge — значок Шерифа (владелец 13.10): летит как кинжал, первую змею разрубает пополам; fromItem — кинжал-предмет
  if (!fromItem) {
    if (badge ? !s.badge : !s.knife) return;
    if (badge) s.badge--; else s.knife--;
  }
  const px = -Math.sin(s.a), py = Math.cos(s.a), off = s.r * 1.4; // кинжал висит справа от головы — оттуда и летит
  const k = { id: ++knifeSeq, owner: s, x: s.xs[0] + px * off, y: s.ys[0] + py * off, vx: Math.cos(s.a) * KNIFE_SP, vy: Math.sin(s.a) * KNIFE_SP, die: tick + KNIFE_LIFE, hits: new Set(), badge: !!badge, max: badge ? 1 : KNIFE_MAX };
  knives.push(k);
  const msg = JSON.stringify({ t: 'knife', id: k.id, x: Math.round(k.x), y: Math.round(k.y), vx: k.vx, vy: k.vy, life: KNIFE_LIFE * TICK_MS, o: s.id, ...(badge ? { kind: 'badge' } : {}), ...(fromItem ? { it: 1 } : {}) });
  for (const c of clients) if (c.ws.readyState === 1) c.ws.send(msg);
}
// Разрубить змею o в точке тела idx: хвост от idx — в еду, змея короче. Слишком близко к голове — гибель.
function chopSnake(o, idx, killer, badge) {
  const xs = o.xs, ys = o.ys, len = xs.length;
  if (idx <= 4 || len - idx < 2) { if (!docSave(o)) killSnake(o, killer && killer.alive ? killer : null); return; }
  const loss = Math.min(o.mass - START_MASS, o.mass * (len - idx) / len);
  if (loss > 0) {
    o.mass -= loss;
    const pts = len - idx, n = clamp(Math.round(pts / 2), 3, 150), v = loss * 0.6 / n;
    for (let j = 0; j < n; j++) { const i = idx + Math.floor(j * pts / n), sp = o.r * 0.6; addFood(xs[i] + rand(-sp, sp), ys[i] + rand(-sp, sp), v, o.dropColor(j), true); }
  }
  xs.length = idx; ys.length = idx; o.bbox(); // отрубленный хвост исчезает сразу
  if (o.tun && o.tun.k >= idx) o.tun = null;
  if (o.client) sendJSON(o.client, { t: 'tmsgMe', text: badge ? `⭐ Шериф разрубил вас пополам: −${Math.round(loss)}` : `🗡 Кинжал разрубил вас: −${Math.round(loss)}` });
  if (killer && killer.client) sendJSON(killer.client, { t: 'tmsgMe', text: (badge ? '⭐ Пополам: ' : '🗡 Разрубили ') + `${o.name}: −${Math.round(loss)}` });
}
function stepKnives() {
  for (let i = knives.length - 1; i >= 0; i--) {
    const k = knives[i];
    for (let sub = 0; sub < 4 && k.hits.size < k.max; sub++) {
      k.x += k.vx / 4; k.y += k.vy / 4;
      const cx = Math.floor(k.x / GRID), cy = Math.floor(k.y / GRID);
      let hit = null, hitIdx = 0;
      for (let gx = cx - 1; gx <= cx + 1 && !hit; gx++) for (let gy = cy - 1; gy <= cy + 1 && !hit; gy++) {
        const cell = grid.get(gkey(gx, gy)); if (!cell) continue;
        for (const p of cell) {
          const o = PS[p]; if (!o.alive || o === k.owner || k.hits.has(o) || o.ghostUntil > tick) continue;
          const dx = PX[p] - k.x, dy = PY[p] - k.y, rr = o.r + 10;
          if (dx * dx + dy * dy < rr * rr) { hit = o; hitIdx = PIdx[p]; break; }
        }
      }
      if (hit) {
        k.hits.add(hit);
        const msg = JSON.stringify({ t: 'knifeHit', id: k.id, x: Math.round(k.x), y: Math.round(k.y), o: k.owner.id });
        for (const c of clients) if (c.ws.readyState === 1) c.ws.send(msg);
        if (k.badge) chopSnake(hit, Math.max(5, Math.floor(hit.xs.length / 2)), k.owner, true); else chopSnake(hit, hitIdx, k.owner); // значок — ровно пополам
      }
    }
    if (k.hits.size >= k.max || tick >= k.die || Math.hypot(k.x, k.y) > MAP_R) {
      knives.splice(i, 1);
      const msg = JSON.stringify({ t: 'knifeEnd', id: k.id, x: Math.round(k.x), y: Math.round(k.y) });
      for (const c of clients) if (c.ws.readyState === 1) c.ws.send(msg);
    }
  }
}
function angDiffS(a, b) { let d = b - a; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; }

// Рекорды: раз в 2 секунды сообщаем длину живых людей
function reportRecords() {
  for (const s of snakes.values()) {
    if (s.bot || !s.alive) continue;
    const hit = records.report(s.name, s.mass);
    if (hit && s.client && s.recShown !== hit) { s.recShown = hit; sendJSON(s.client, { t: 'record', kind: hit }); }
  }
}

// ===== Раунды командного режима =====
let teamKills = [0, 0], roundEndTick = ROUND_SEC * TICK_RATE, roundPause = false, finalMin = false;
// Счёт команды = длина всех живых змей команды + 300 за каждое убийство соперника
function teamScores() {
  const sc = [teamKills[0] * 300 + teamCaps[0] * FLAG_POINTS, teamKills[1] * 300 + teamCaps[1] * FLAG_POINTS], hum = [0, 0];
  for (const s of snakes.values()) if (s.alive && s.team != null) { sc[s.team] += Math.floor(s.mass); if (!s.bot) hum[s.team]++; }
  return [sc[0], sc[1], Math.max(0, Math.ceil((roundEndTick - tick) / TICK_RATE)), hum[0], hum[1], roundPause ? 1 : 0];
}
function runRound() {
  if (!TEAM) return;
  const fm = !roundPause && roundEndTick - tick <= 60 * TICK_RATE;
  if (fm && !finalMin) { teamMsg('⏰ Последняя минута! Еда ×2, шаров больше — всё решится сейчас'); for (const c of clients) sendJSON(c, { t: 'final' }); }
  finalMin = fm;
  if (tick < roundEndTick) return;
  if (!roundPause) { // раунд закончился: объявляем победителя и очищаем карту
    const [a, b] = teamScores();
    let best = null; for (const s of snakes.values()) if (s.alive && (!best || s.mass > best.mass)) best = s;
    // Итоги раунда: награды людям
    const rs = [];
    for (const c of clients) if (c.rs) { if (c.snake && c.snake.alive) c.rs.life = Math.max(c.rs.life, Math.round((tick - (c.snake.born || tick)) / TICK_RATE)); rs.push(c.rs); }
    const award = (key, icon, title, unit) => { let w = null; for (const r of rs) if (r[key] > 0 && (!w || r[key] > w[key])) w = r; return w ? [icon, title, w.name, w.team, w[key] + unit] : null; };
    const awards = [award('kills', '🗡', 'Больше всех убил', ''), award('caps', '🏁', 'Довёз знамя', ' раз'), award('orbs', '✨', 'Ловец шаров', ''), award('life', '⏱', 'Дольше всех прожил', ' с')].filter(Boolean);
    const msg = { t: 'roundEnd', winner: a === b ? -1 : a > b ? 0 : 1, scores: [a, b], best: best ? [best.name, Math.floor(best.mass), best.team] : null, pause: ROUND_PAUSE_SEC, awards };
    for (const c of clients) { sendJSON(c, msg); if (c.snake) { c.snake.client = null; c.snake = null; } c.cells = new Set(); c.rs = null; }
    for (const s of [...snakes.values()]) { s.alive = false; snakes.delete(s.id); diedThisTick.push(s.id); }
    for (const f of drops) removeFood(f, 0); // останки змей убираем, обычная еда остаётся
    drops.length = 0; teamKills = [0, 0]; teamCaps = [0, 0]; alarms.length = 0; finalMin = false; rockets.length = 0;
    flags.forEach(flagHome);
    roundPause = true; roundEndTick = tick + ROUND_PAUSE_SEC * TICK_RATE;
  } else { // перерыв прошёл — новый раунд
    roundPause = false; roundEndTick = tick + ROUND_SEC * TICK_RATE;
    for (const c of clients) sendJSON(c, { t: 'roundStart' });
  }
}

// ===== Потайные ходы (владелец 11.10): голова в норе — вся змея переносится к другой норе и ползёт дальше в ту же сторону.
// После прохода 2 с ход не срабатывает (иначе сразу обратно), на выходе 0,4 с неуязвимости — вдруг там кто-то ползёт.
// ===== Ниндзя (владелец 13.10): одна дымовая шашка на жизнь — 4 с густого дыма вокруг; в дыму никого не видно =====
// Владелец 13.10: облако чуть меньше (260 → 200); шашку кидают вперёд — дым там, где упала (как бомба)
const SMOKE_MS = 4000, SMOKE_R = 200, SMOKE_DIST = 400, SMOKE_FLY = Math.round(0.55 * TICK_RATE), smokes = []; // { x, y, from, until }
function inSmoke(x, y) { for (const m of smokes) if (m.from <= tick && m.until > tick && (x - m.x) ** 2 + (y - m.y) ** 2 < SMOKE_R * SMOKE_R) return true; return false; }
function throwSmoke(s, fromItem) {
  if (!fromItem) {
    if (!s.smoke) return;
    s.smoke--;
  }
  const x0 = s.xs[0], y0 = s.ys[0];
  let x = x0 + Math.cos(s.a) * SMOKE_DIST, y = y0 + Math.sin(s.a) * SMOKE_DIST;
  const d = Math.hypot(x, y), lim = MAP_R - 80; if (d > lim) { x *= lim / d; y *= lim / d; }
  smokes.push({ x, y, from: tick + SMOKE_FLY, until: tick + SMOKE_FLY + Math.round(SMOKE_MS / TICK_MS) });
  const msg = JSON.stringify({ t: 'smoke', x0: Math.round(x0), y0: Math.round(y0), x: Math.round(x), y: Math.round(y), fly: SMOKE_FLY * TICK_MS, r: SMOKE_R, ms: SMOKE_MS, o: s.id, ...(fromItem ? { it: 1 } : {}) });
  for (const c of clients) if (c.ws.readyState === 1) c.ws.send(msg);
}
// ===== Предметы на карте (владелец 14.10): подполз головой — подобрал в «карман» (один), кнопкой — использовал =====
// Подбирают только люди. Подобранный предмет через 6 с появляется в другом месте карты.
const ITEM_TYPES = ['grenade', 'dagger', 'shock', 'magnet', 'smoke', 'invis', 'turbo'];
const ITEM_N = 14, ITEM_R = 26, ITEM_RESPAWN = 6 * TICK_RATE, STUN_T = 2 * TICK_RATE;
const items = [], itemWait = []; let itemSeq = 0, itemsDirty = true;
function placeItem() {
  for (let k = 0; k < 40; k++) {
    const a = rand(0, TAU), d = Math.sqrt(Math.random()) * 4300, x = Math.cos(a) * d, y = Math.sin(a) * d;
    if (PORTALS.some(pr => pr.some(([px, py]) => Math.hypot(px - x, py - y) < 160))) continue; // не на норах
    items.push({ id: ++itemSeq, type: ITEM_TYPES[Math.random() * ITEM_TYPES.length | 0], x, y }); itemsDirty = true; return;
  }
}
function stepItems() {
  if (TEAM) return;
  for (let k = 0; k < 3 && items.length + itemWait.length < ITEM_N; k++) placeItem();
  for (let i = itemWait.length - 1; i >= 0; i--) if (itemWait[i] <= tick) { itemWait.splice(i, 1); placeItem(); }
  for (const s of snakes.values()) {
    if (s.bot || !s.alive || !s.client) continue;
    const hx = s.xs[0], hy = s.ys[0], rr = s.r + ITEM_R;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if ((it.x - hx) ** 2 + (it.y - hy) ** 2 > rr * rr) continue;
      items.splice(i, 1); itemWait.push(tick + ITEM_RESPAWN); itemsDirty = true;
      s.item = it.type; s.itemN = it.type === 'shock' ? 2 : 1; sendJSON(s.client, { t: 'item', type: it.type, n: s.itemN }); // шокер — на 2 удара (владелец 14.10)
    }
  }
}
function useItem(s) {
  const t = s.item; if (!t) return;
  if (--s.itemN > 0) { if (s.client) sendJSON(s.client, { t: 'item', type: t, n: s.itemN, left: 1 }); } // ещё есть заряд
  else { s.item = null; if (s.client) sendJSON(s.client, { t: 'item', type: null, used: t }); }
  if (t === 'grenade') launchBomb(s, true);
  else if (t === 'dagger') throwKnife(s, false, true);
  else if (t === 'smoke') throwSmoke(s, true);
  else if (t === 'magnet') s.magnetUntil = tick + 5 * TICK_RATE;
  else if (t === 'invis') s.invisUntil = tick + 4 * TICK_RATE;
  else if (t === 'turbo') s.turboUntil = tick + 4 * TICK_RATE;
  else if (t === 'shock') doShock(s);
}
function doShock(s) { // ⚡ ближайшая змея впереди (до 520) 2 с почти стоит и не может повернуть (предмет и Параноик)
    const hx = s.xs[0], hy = s.ys[0], ca = Math.cos(s.a), sa = Math.sin(s.a);
    let best = null, bd = 520 * 520;
    for (const o of snakes.values()) {
      if (o === s || !o.alive) continue;
      const dx = o.xs[0] - hx, dy = o.ys[0] - hy, d = dx * dx + dy * dy;
      if (d < bd && (dx * ca + dy * sa) > Math.sqrt(d) * 0.25) { bd = d; best = o; }
    }
    const x = best ? best.xs[0] : hx + ca * 300, y = best ? best.ys[0] : hy + sa * 300;
    if (best) { best.stunUntil = tick + STUN_T; if (best.client) sendJSON(best.client, { t: 'tmsgMe', text: '⚡ Вас ударили шокером! 2 секунды не повернуть' }); }
    const msg = JSON.stringify({ t: 'shock', x0: Math.round(hx), y0: Math.round(hy), x: Math.round(x), y: Math.round(y), hit: best ? best.id : 0 });
    for (const c of clients) if (c.ws.readyState === 1) c.ws.send(msg);
}
const PORTAL_CD = 2 * TICK_RATE, PORTAL_GHOST = Math.round(0.4 * TICK_RATE);
// Владелец 11.10 («глюк, особенно когда большой червяк лазит»): нора узкая — пролезают только змеи потоньше (длина примерно до 1000).
// Длинное тело долго тянулось через нору, делало петли и «кольца»; большие теперь просто проползают мимо.
const PORTAL_MAX_R = 12; // владелец 11.10: только очень маленькие змеи — длина примерно до 200 (было до ~1000, потом ~500)
function stepPortals() {
  if (TEAM) return;
  for (const s of snakes.values()) {
    if (!s.alive || s.portalCd > tick || s.tun) continue; // пока хвост ещё в тоннеле — в другую нору нельзя
    const hx = s.xs[0], hy = s.ys[0];
    if (s.r > PORTAL_MAX_R) { // толстая — не пролезает; человеку подсказка (не чаще раза в 10 с)
      if (s.client && !(s.portalHint > tick)) for (const pair of PORTALS) for (const [px, py] of pair)
        if ((hx - px) ** 2 + (hy - py) ** 2 < (PORTAL_R + s.r) ** 2) { s.portalHint = tick + 10 * TICK_RATE; sendJSON(s.client, { t: 'tmsgMe', text: '🕳 Нора узкая — толстой змее не пролезть' }); }
      continue;
    }
    hop: for (const pair of PORTALS) for (let e = 0; e < 2; e++) {
      const [px, py] = pair[e], rr = PORTAL_R + s.r * 0.4;
      if ((hx - px) ** 2 + (hy - py) ** 2 > rr * rr) continue;
      const [qx, qy] = pair[1 - e];
      // Голова ныряет в нору и показывается из другой (с тем же сдвигом), тело втягивается следом по точкам (moveSnake)
      s.xs[0] += qx - px; s.ys[0] += qy - py;
      s.tun = { ax: px, ay: py, bx: qx, by: qy, k: 1, ux: Math.cos(s.a), uy: Math.sin(s.a) };
      s.bbox(); s.portalCd = tick + PORTAL_CD; s.ghostUntil = tick + PORTAL_GHOST;
      const msg = JSON.stringify({ t: 'portal', id: s.id, f: [px, py], d: [qx, qy] });
      for (const c of clients) if (c.ws.readyState === 1) c.ws.send(msg);
      break hop;
    }
  }
}
function step() {
  tick++;
  runRound();
  for (const s of snakes.values()) if (s.bot && !s.botThinkOff) botThink(s); // каждый шаг — быстрее реагируют на опасность
  for (const s of snakes.values()) moveSnake(s);
  for (const s of snakes.values()) { const h = s.hh || (s.hh = []); h.push(s.xs[0], s.ys[0]); if (h.length > 32) h.splice(0, 2); } // где была голова последние 0,5 с (честная подрезка)
  stepPortals();
  if (smokes.length) for (let i = smokes.length; i--;) if (smokes[i].until <= tick) smokes.splice(i, 1);
  buildGrid();
  collisions();
  for (const s of snakes.values()) if (s.alive) eat(s);
  stepItems();
  maintainFood();
  maintainBots();
  if (tick % 15 === 0) updateRoles(); // 2 раза в секунду
  for (const c of clients) sendState(c);
  cellEv.clear();
  diedThisTick.length = 0;
  if (tick % (TICK_RATE / 2) === 0) sendLeaderboard(); // рейтинг и миникарта — 2 раза в секунду
  runEvents();
  stepOrbs();
  if (tick % (TICK_RATE * 2) === 0) reportRecords();
}

let lastT = performance.now(), acc = 0, slowTicks = 0, worstMs = 0, sumMs = 0, nSteps = 0, paused = false;
// Замер «замираний» сервера (владелец 11.10: «немножко виснет»): самая долгая пауза между запусками цикла и сколько
// было пауз дольше 100 мс — за текущую и прошлую минуту; смотреть на /perf. Отличает зависание сервера от задержек интернета.
const perf = { gapMax: 0, gaps100: 0, stepMax: 0, prev: null, lastLoop: 0 };
setInterval(() => { perf.prev = { gapMax: Math.round(perf.gapMax), gaps100: perf.gaps100, stepMax: +perf.stepMax.toFixed(1), at: new Date().toISOString().slice(11, 19) }; perf.gapMax = 0; perf.gaps100 = 0; perf.stepMax = 0; }, 60000);
function loop() {
  const now = performance.now();
  if (perf.lastLoop && clients.size) { const g = now - perf.lastLoop; if (g > perf.gapMax) perf.gapMax = g; if (g > 100) perf.gaps100++; }
  perf.lastLoop = now;
  acc += now - lastT; lastT = now;
  // Владелец 07.10: к арене никто не подключён (ни в игре, ни в меню) — она стоит на паузе и не тратит процессор
  if (!clients.size && !process.env.TEST_NO_PAUSE) { acc = 0; paused = true; setTimeout(loop, 100); return; }
  if (paused) { paused = false; console.log('арена проснулась: подключился человек'); }
  let n = 0;
  while (acc >= TICK_MS && n < 4) {
    const t0 = performance.now();
    try { step(); } catch (e) { console.error('ошибка в шаге мира (игра продолжается):', e); cellEv.clear(); diedThisTick.length = 0; }
    const dt = performance.now() - t0;
    if (dt > worstMs) worstMs = dt;
    if (dt > perf.stepMax) perf.stepMax = dt;
    sumMs += dt; nSteps++;
    if (dt > TICK_MS) slowTicks++;
    acc -= TICK_MS; n++;
  }
  if (n >= 4) acc = 0; // сервер не успевает — не копим долг
  setTimeout(loop, Math.max(1, TICK_MS - acc - 1));
}

// Раз в минуту — короткий отчёт в окно сервера
setInterval(() => {
  let players = 0, bots = 0;
  for (const s of snakes.values()) { if (s.bot) bots++; else players++; }
  console.log(`[${new Date().toLocaleTimeString('ru-RU')}] онлайн ${clients.size}, в игре ${players}, ботов ${bots}, еды ${foods.size}, ${TEAM ? '[команды] ' : ''}шаг в среднем ${(sumMs / Math.max(1, nSteps)).toFixed(2)} мс, худший ${worstMs.toFixed(1)} мс, медленных шагов ${slowTicks}, боты разбились: о тела ${deathStats.botBody}, о край ${deathStats.botWall}, больших (>1000): ${[...snakes.values()].filter(s => s.mass > 1000).length}`);
  deathStats.botBody = deathStats.botWall = deathStats.player = 0;
  worstMs = 0; slowTicks = 0; sumMs = 0; nSteps = 0;
}, Number(process.env.TEST_REPORT_SEC || 60) * 1000);

// ===== HTTP + WebSocket =====
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.webp': 'image/webp', '.json': 'application/json', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json; charset=utf-8' };

const clientErrs = [], clientPerf = [];
const server = http.createServer((req, res) => {
  // Кривая ссылка (%E0%A4%A — так стучатся роботы-сканеры) раньше роняла весь сервер и выкидывала всех из игры
  let url; try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch { res.writeHead(400); res.end(); return; }
  if (url === '/install' || url === '/install.html') { res.writeHead(302, { Location: '/' }); res.end(); return; } // владелец 11.10: отдельную страницу установки убрали — ссылка сразу открывает игру
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  // «Чёрный ящик» телефонов (владелец 11.10): ошибки браузеров игроков — последние 50, без личных данных (только текст ошибки, модель браузера)
  if (url === '/clienterr' && req.method === 'POST') {
    let body = ''; req.on('data', d => { if (body.length < 2000) body += d; });
    req.on('end', () => { try { const m = JSON.parse(body); clientErrs.unshift({ t: new Date().toISOString().slice(0, 19).replace('T', ' '), ...m, ua: String(req.headers['user-agent'] || '').slice(0, 160) }); clientErrs.length = Math.min(clientErrs.length, 50); } catch {} res.writeHead(204); res.end(); });
    return;
  }
  if (url === '/perf') { const m = process.memoryUsage(); res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ now: { gapMax: Math.round(perf.gapMax), gaps100: perf.gaps100, stepMax: +perf.stepMax.toFixed(1) }, prevMinute: perf.prev, clients: clients.size, snakes: snakes.size, foods: foods.size, memMB: Math.round(m.rss / 1e6), heapMB: Math.round(m.heapUsed / 1e6), uptimeMin: Math.round(process.uptime() / 60) })); return; }
  // «Чёрный ящик скорости» (12.10): телефоны раз в 20 с присылают замеры игры — видно на /perfc
  if (url.startsWith('/rtt')) { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return; } /* 15.10: замер связи из фонового потока игры */
  if (url === '/perfc' && req.method === 'POST') {
    let body = ''; req.on('data', d => { if (body.length < 3000) body += d; });
    req.on('end', () => { try { const m = JSON.parse(body); clientPerf.unshift({ t: new Date().toISOString().slice(11, 19), ...m, ua: String(req.headers['user-agent'] || '').replace(/^Mozilla\/5\.0 /, '').slice(0, 110) }); clientPerf.length = Math.min(clientPerf.length, 60); } catch {} res.writeHead(204); res.end(); });
    return;
  }
  if (url === '/perfc') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(clientPerf, null, 1)); return; }
  if (url === '/errs') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(clientErrs, null, 1)); return; }
  if (stats.handle(req, res, url, liveCounts)) return;
  if (voice.handle(req, res, url, cleanName)) return;
  if (!TEAM && winners.handle(req, res, url, n => records.placeAll(n) > 0)) return;
  // Владелец 13.10: ссылку открыли в Telegram / Instagram — сразу лёгкая страница «Открыть в Chrome» (без видео и меню, ничего лишнего не качается).
  // Остальные случаи (iPhone без явной метки в User-Agent) ловит скрипт в начале index.html.
  const UA_ = req.headers['user-agent'] || '', otherAndroid = /Android/i.test(UA_) && !(/Chrome\/\d/.test(UA_) && !/YaBrowser|SamsungBrowser|MiuiBrowser|OPR\/|Opera|Edg|HeyTap|UCBrowser|HuaweiBrowser|VivoBrowser|OppoBrowser|Firefox/i.test(UA_)); // владелец 13.10: Android, но не Chrome — тоже сразу «Открыть в Chrome»
  if ((url === '/' || url === '/index.html') && (otherAndroid || /Telegram|Instagram|FBAN|FBAV|FB_IAB|Line\/|; wv\)/i.test(UA_) || /^android-app:\/\/(org\.telegram|org\.thunderdog|com\.instagram|com\.facebook|com\.whatsapp)/.test(req.headers.referer || ''))) { // referer — «встроенный Chrome» Telegram (Custom Tabs)
    const qs = (req.url.split('?')[1] || '');
    if (!/(^|&)(here|app)=1/.test(qs)) { res.writeHead(302, { Location: '/gate.html' + (qs ? '?' + qs : ''), 'Cache-Control': 'no-store' }); res.end(); return; }
  }
  const file = path.normalize(path.join(PUBLIC, url === '/' ? 'index.html' : url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  if (file.endsWith('.mp4')) { // видео меню (владелец 11.10): отдаём кусками по запросу Range — так требует Safari на iPhone
    fs.stat(file, (err, st) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || ''), size = st.size;
      const start = m && m[1] ? +m[1] : 0, end = m && m[2] ? Math.min(+m[2], size - 1) : size - 1;
      if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
      res.writeHead(m ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'public, max-age=86400', ...(m ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
      fs.createReadStream(file, { start, end }).pipe(res);
    });
    return;
  }
  // Владелец 13.10: «фото медленно грузится». Раньше телефон каждый заход качал все фото заново.
  // Теперь у файла есть «отпечаток» (размер+время): не изменился — сервер отвечает «бери из памяти» (304), без скачивания.
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const tag = '"' + st.size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36) + '"';
    const img = /\.(jpe?g|png|webp|gif|m4a)$/i.test(file);
    const hdr = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'ETag': tag, 'Cache-Control': img ? 'public, max-age=3600' : 'no-cache' };
    if (req.headers['if-none-match'] === tag) { res.writeHead(304, hdr); res.end(); return; }
    fs.readFile(file, (err2, data) => {
      if (err2) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, hdr); res.end(data);
    });
  });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
// Командная арена — отдельный процесс (этот же файл с TEAM_MODE=1). Запускается, когда кто-то зашёл в «Команды»,
// и выключается через 3 минуты без игроков — обычная игра от неё не тормозит.
const TEAM_PORT = Number(process.env.TEAM_PORT) || PORT + 1;
let teamProc = null, teamReady = null, teamConns = 0, teamIdleT = null;
function ensureTeamArena() {
  if (teamReady) return teamReady;
  teamProc = spawn(process.execPath, [__filename], { env: { ...process.env, TEAM_MODE: '1', PORT: String(TEAM_PORT) }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  teamProc.on('exit', () => { teamProc = null; teamReady = null; });
  teamProc.on('message', m => { if (m && m.t === 'rec') teamRecStore = m.data; });
  const visT = setInterval(() => { if (teamProc && teamProc.connected) teamProc.send({ t: 'vis', v: stats.visits() }); else clearInterval(visT); }, 5000);
  if (teamRecStore) teamProc.send({ t: 'recInit', data: teamRecStore });
  teamReady = new Promise((ok, fail) => {
    let n = 0;
    const t = setInterval(() => {
      http.get(`http://127.0.0.1:${TEAM_PORT}/health`, r => { r.resume(); if (r.statusCode === 200) { clearInterval(t); ok(); } })
        .on('error', () => { if (++n > 150) { clearInterval(t); teamReady = null; fail(new Error('team arena did not start')); } });
    }, 100);
  });
  return teamReady;
}
const teamWss = TEAM ? null : new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  const p = (req.url || '').split('?')[0];
  if (p === '/ws') wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  else if (p === '/ws-team' && teamWss && TEAM_ENABLED) teamWss.handleUpgrade(req, socket, head, ws => teamWss.emit('connection', ws, req));
  else socket.destroy();
});
if (teamWss) teamWss.on('connection', (ws, req) => {
  stats.onConnect({}, req); // посетитель командной игры — тоже посетитель сайта
  teamConns++; clearTimeout(teamIdleT);
  const queue = []; let up = null, closed = false;
  ws.on('message', (d, bin) => { if (up && up.readyState === 1) up.send(d, { binary: bin }); else if (queue.length < 50) queue.push([d, bin]); });
  const done = () => {
    if (closed) return; closed = true; teamConns--;
    try { ws.close(); } catch {} try { if (up) up.close(); } catch {}
    if (teamConns <= 0) { teamConns = 0; teamIdleT = setTimeout(() => { if (!teamConns && teamProc) teamProc.kill(); }, 180000); }
  };
  ws.on('close', done); ws.on('error', done);
  ensureTeamArena().then(() => {
    if (closed) return;
    up = new WebSocket(`ws://127.0.0.1:${TEAM_PORT}/ws`, { perMessageDeflate: false, headers: { 'x-forwarded-for': String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || ''), 'user-agent': String(req.headers['user-agent'] || '') } });
    up.on('open', () => { for (const [d, b] of queue) up.send(d, { binary: b }); queue.length = 0; });
    up.on('message', (d, bin) => { if (ws.readyState === 1 && !(bin && ws.bufferedAmount > 12000)) ws.send(d, { binary: bin }); }); // медленный телефон — пропускаем кадр, не копим
    up.on('close', done); up.on('error', done);
  }).catch(done);
});
if (process.env.TEST_EXIT_SEC) setTimeout(() => process.exit(0), Number(process.env.TEST_EXIT_SEC) * 1000); // только для замеров (--cpu-prof пишет файл при выходе)
// Последняя страховка: случайная ошибка пишется в журнал, а игра продолжается — раньше любая ошибка выкидывала всех игроков
process.on('uncaughtException', e => console.error('непойманная ошибка (сервер продолжает работу):', e));
// Владелец 13.10: перед перезапуском (новая версия на Render) предупреждаем игроков — их игра сама вернётся, когда сервер поднимется
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  if (teamProc) teamProc.kill();
  try { const msg = JSON.stringify({ t: 'restart' }); for (const c of clients) if (c.ws.readyState === 1) c.ws.send(msg); } catch {}
  setTimeout(() => process.exit(0), 700);
});
process.on('exit', () => { if (teamProc) teamProc.kill(); });
if (TEAM && process.send) process.on('disconnect', () => process.exit(0)); // основной процесс закрылся — арена тоже
// Аудит 14.10: не больше 10 подключений с одного адреса — иначе один человек мог занять все 150 мест сервера
const perIp = new Map(), MAX_PER_IP = 10; // 10 — несколько человек в одной Wi-Fi
const ipOf = req => String(req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress || '');
wss.on('connection', (ws, req) => {
  if (clients.size >= MAX_CLIENTS) { ws.close(1013, 'full'); return; }
  const ip = ipOf(req), nIp = (perIp.get(ip) || 0) + 1;
  if (nIp > MAX_PER_IP) { ws.close(1013, 'too-many'); return; }
  perIp.set(ip, nIp); ws.on('close', () => { const k = (perIp.get(ip) || 1) - 1; if (k > 0) perIp.set(ip, k); else perIp.delete(ip); });
  const c = { ws, snake: null, w: 1280, h: 720, vx: rand(-1500, 1500), vy: rand(-1500, 1500), known: new Map(), cells: new Set(), msgs: 0, msgT: Date.now() };
  clients.add(c); c.ua = String(req.headers['user-agent'] || '');
  stats.onConnect(c, req);
  sendJSON(c, { t: 'lb', top: [], players: 0, online: clients.size, rec: recView() });
  sendJSON(c, { t: 'hello', proto: PROTO, team: TEAM, ...(TEAM ? { bases: BASES, baseR: BASE_R } : {}), mapR: MAP_R, tickRate: TICK_RATE, segD: SEG_D, fcell: FCELL });
  if (process.env.TEST_STALL) { // только для проверок: каждые 3 с данные «застревают» на TEST_STALL мс, потом приходят пачкой — как плохой интернет
    const ST = Number(process.env.TEST_STALL), send0 = ws.send.bind(ws), q = []; let holdUntil = 0;
    const iv = setInterval(() => { holdUntil = Date.now() + ST; setTimeout(() => { while (q.length) { const [d, o] = q.shift(); if (ws.readyState === 1) send0(d, o); } }, ST); }, Number(process.env.TEST_STALL_EVERY) || 3000);
    ws.on('close', () => clearInterval(iv));
    ws.send = (d, o) => { if (Date.now() < holdUntil || q.length) q.push([d, o]); else send0(d, o); };
  }
  if (process.env.TEST_LAG) { // только для проверок: искусственная задержка связи в каждую сторону (мс), как у далёкого игрока
    const LAG = Number(process.env.TEST_LAG), send0 = ws.send.bind(ws), on0 = ws.on.bind(ws);
    ws.send = (d, o) => setTimeout(() => { if (ws.readyState === 1) send0(d, o); }, LAG);
    ws.on = (ev, fn) => on0(ev, ev === 'message' ? (d, b) => setTimeout(() => fn(d, b), LAG) : fn);
  }
  ws.on('message', (data, isBinary) => {
    const now = Date.now();
    if (now - c.msgT > 1000) { c.msgT = now; c.msgs = 0; }
    if (++c.msgs > 150) { ws.close(1008, 'flood'); return; }
    if (isBinary) {
      if (data.length === 4 && data[0] === 1 && c.snake && c.snake.alive) {
        c.snake.ta = (data[1] | (data[2] << 8)) / 65535 * TAU - Math.PI;
        c.snake.boost = data[3] === 1;
      }
      return;
    }
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m && typeof m === 'object') try { handleJSON(c, m); } catch (e) { console.error('ошибка в сообщении игрока:', e); }
  });
  ws.on('close', () => {
    clients.delete(c);
    if (c.snake && c.snake.alive) { c.snake.client = null; killSnake(c.snake, null); }
  });
  ws.on('error', () => {});
});

while (naturalFood < FOOD_TARGET) spawnNaturalFood();
cellEv.clear();
if (process.env.TEST_SEED_RECORDS) for (const [n, sc] of [['BBB', 12061], ['Двойник', 11694], ['Bekhruz', 11105], ['Я сам в шоке', 9852], ['альмано', 9609]]) records.report(n, sc); // только для проверок
records.load().then(() => { if (!TEAM) winners.load(records.allNames()); });
// Фото тех, кто выпал из топ-5, больше нигде не видно — убираем (раз в 30 с)
if (!TEAM) setInterval(() => winners.prune(records.allNames()), 30000);
// Рекорды командной арены живут в основном процессе: арена шлёт их при каждом изменении и получает обратно при запуске
let teamRecStore = null, teamVis = null;
if (TEAM && process.send) {
  process.on('message', m => { if (m && m.t === 'recInit') records.restore(m.data); if (m && m.t === 'vis') teamVis = m.v; });
  let recT = null;
  records.setOnChange(() => { if (!recT) recT = setTimeout(() => { recT = null; try { process.send({ t: 'rec', data: records.dump() }); } catch {} }, 2000); });
}
server.listen(PORT, () => {
  console.log(TEAM ? `Командная арена запущена (порт ${PORT})` : `Марми Мафия запущена: http://localhost:${PORT}`);
  if (TEAM) { loop(); return; }
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`  с телефона в той же Wi-Fi: http://${a.address}:${PORT}`);
  }
  loop();
});

module.exports = { radiusFor, segsFor, viewScale, _test: { useItem: (s, t) => { s.item = t; useItem(s); }, snakes, Snake, buildGrid, collisions, SEG_D, bombs, throwBomb, stepBombs, foods, stepPortals, PORTALS, moveSnake, knives, throwKnife, stepKnives, getTick: () => tick } }; // _test — для проверок подрезки
