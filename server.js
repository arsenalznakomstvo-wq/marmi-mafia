'use strict';
// Марми Мафия — сервер. Ведёт одну общую карту: змейки игроков, боты, еда.
// Телефоны и компьютеры только рисуют картинку и присылают, куда повернуть.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer, WebSocket } = require('ws');
const { spawn } = require('child_process');
const { SKINS, MAX_PATTERN, skinCols } = require('./public/skins.js');
const stats = require('./stats.js');
const voice = require('./voice.js');
const records = require('./records.js');

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
const TARGET_SNAKES = 40;        // живые игроки + боты; зашёл человек — бот уступает место
const FOOD_TARGET = TEAM ? 4360 : 3490; // обычной еды на карте: в оригинале её немного, ~25 точек на экран; в командах +25% — своих не разбить, трупов меньше (владелец 07.10)
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
    if (s.bot) s.name = ROLES[r].name;                 // у ботов вместо имени — роль
    else if (s.client && r > prev && s.roleShown !== r) { // человек получил новую роль — табличка-поздравление
      s.roleShown = r;
      sendJSON(s.client, { t: 'role', r });
    }
  }
  // Новый Дон Мафии среди людей — объявляем всем
  if (top && top.id !== donId) {
    donId = top.id;
    if (!top.bot) for (const c of clients) if (c !== top.client) sendJSON(c, { t: 'don', name: top.name });
  }
}
// В рейтинге Дон — коротко «Ник Дон», чтобы не обрезалось (владелец 06.10)
const roleShort = r => r === DON ? 'Дон' : ROLES[r].name;
const displayName = s => TEAM ? s.name : s.bot ? roleShort(s.role || 0) : s.name + ' ' + roleShort(s.role || 0);
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
const TURN_BOOST = 1.3; // владелец 06.10: живые игроки манёвреннее на 30%, боты — как в оригинале (менять вместе с client.js)
function turnFor(r, bot) { const sc = r / 10, scang = 0.13 + 0.87 * Math.pow((7 - sc) / 6, 2); return 0.033 * (TICK_MS / 8) * scang * (bot ? 1 : TURN_BOOST); }
// Скорость: обычная 4,25 + 0,5·sc, ускорение 12 (единицы оригинала, пересчитаны в наши)
const SPEED_K = 6 / 4.75;
const speedFor = (r, boost) => (boost ? 12 : 4.25 + 0.5 * (r / 10)) * SPEED_K;
// Камера: в оригинале gsc = 0.64285 + 0.514285714 / max(1, (sct + 16)/36) — отдаляется по мере роста
// Владелец 07.10: Дону и Киллеру (и Мафии — она старше Киллера) камера выше — видно больше карты
const ROLE_ZOOM = { 7: 0.85, 8: 0.85, 9: 0.72 }; // номера ролей: 7 Киллер, 8 Мафия, 9 Дон (см. public/roles.js)
// Владелец 07.10: в командной игре чем длиннее змея, тем выше камера (видно красоту карты): с 300 плавно до ×0,5 на 8000
const teamZoom = mass => mass > 300 ? 1 - 0.5 * Math.min(1, Math.log(mass / 300) / Math.log(8000 / 300)) : 1;
function viewScale(w, h, r, role, mass) {
  // Владелец 06.10: на телефоне камера ближе (как на компьютере) — раньше змейка на старте была 15 px и терялась
  const base = Math.max(clamp(Math.sqrt(w * h) / 750, 0.5, 1.6), Math.min(w, h) < 600 ? 1.05 : 0), sct = 2 + (r / 10 - 1) * SC_DIV;
  return base * (0.64285 + 0.514285714 / Math.max(1, (sct + 16) / 36)) / 1.157142857 * (ROLE_ZOOM[role] || 1) * (mass ? teamZoom(mass) : 1);
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
const randColor = () => hslToHex(Math.random() * 360 | 0, 85, 55);
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
  const tr = turnFor(s.r, s.bot);
  s.a += clamp(angDiff(s.a, s.ta), -tr, tr);
  if (s.a > Math.PI) s.a -= TAU; else if (s.a < -Math.PI) s.a += TAU;
  s.boosting = s.boost && s.mass >= MIN_BOOST_MASS;
  const spd = speedFor(s.r, s.boosting);
  const xs = s.xs, ys = s.ys;
  xs[0] += Math.cos(s.a) * spd; ys[0] += Math.sin(s.a) * spd;
  if (s.boosting) {
    // Ускорение стоит длины: змейка худеет и роняет еду с хвоста, как в slither.io
    const cost = 0.15 + s.mass * 0.0008;
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
  for (let i = 1; i < n; i++) {
    const dx = xs[i] - xs[i - 1], dy = ys[i] - ys[i - 1];
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > SEG_D) { const k = SEG_D / d; xs[i] = xs[i - 1] + dx * k; ys[i] = ys[i - 1] + dy * k; }
  }
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
    if (!s.alive) continue;
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
        if (o === s || (TEAM && o.team === s.team)) continue; // в себя и в своих (командный режим) врезаться нельзя
        const dx = PX[p] - hx, dy = PY[p] - hy, rr = o.r + rs * 0.6;
        if (dx * dx + dy * dy < rr * rr) { killer = o; s.hitIdx = PIdx[p]; break outer; }
      }
    }
    if (killer) dead.push(s, killer);
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
  for (let i = 0; i < dead.length; i += 2) if (!spare.has(dead[i])) killSnake(dead[i], dead[i + 1]);
}

const deathStats = { botBody: 0, botWall: 0, player: 0 };
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
    c.snake = null;
    sendJSON(c, { t: 'dead', score: Math.floor(s.mass), kills: s.kills, killer: killer ? killer.name : null });
  }
}

function eat(s) {
  const hx = s.xs[0], hy = s.ys[0], reach = s.r * 1.25 + 10 + 18;
  const cx0 = Math.floor((hx - reach) / FCELL), cx1 = Math.floor((hx + reach) / FCELL);
  const cy0 = Math.floor((hy - reach) / FCELL), cy1 = Math.floor((hy + reach) / FCELL);
  for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
    const cell = fcells.get(((cx + 64) << 8) | (cy + 64)); if (!cell) continue;
    for (const f of cell) {
      const dx = f.x - hx, dy = f.y - hy, rr = s.r * 1.25 + 10 + f.r;
      if (dx * dx + dy * dy < rr * rr) { s.mass += finalMin ? f.v * 2 : f.v; removeFood(f, s.id); } // последняя минута командного раунда — еда ×2
    }
  }
}

// Место для появления: подальше от чужих тел и голов игроков
function findSpawn(awayFromPlayers, cx, cy, rad) { // cx, cy, rad — искать рядом с точкой (командный режим: у своей базы)
  let best = null, bestD = -1;
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
const BOT_SKIN_WEIGHTS = { 'Белый': 4, 'Серый': 4, 'Светло-серый': 3, 'Чёрно-оранжевый': 3, 'Чёрно-белый': 3,
  'Красный': 1, 'Жёлтый': 1, 'Зелёный': 1, 'Голубой': 1, 'Синий': 1, 'Фиолетовый': 1, 'Розовый': 1,
  'Бирюзовый': 1, 'Лаймовый': 1, 'Лавандовый': 1, 'Мятный': 1, 'Коралловый': 1, 'Песочный': 1, 'Небесный': 1, 'Сливовый': 1, 'Изумрудный': 1 };
const SOLID_SKINS = [];
SKINS.forEach((d, i) => { for (let k = 0; k < (BOT_SKIN_WEIGHTS[d.name] || 0); k++) SOLID_SKINS.push(i); });
function randomSkin() {
  // Владелец 06.10: боты почти всегда однотонные (глаза меньше устают); особые скины с надписью ботам не достаются
  let id;
  if (Math.random() < 0.9) id = SOLID_SKINS[Math.random() * SOLID_SKINS.length | 0];
  else do { id = 1 + (Math.random() * (SKINS.length - 1) | 0); } while (SKINS[id].text);
  return { id, c1: randColor(), c2: randColor(), c3: randColor() };
}

// ===== Боты =====
function makePersonality(s) {
  const roll = Math.random();
  let aggr;
  if (roll < 0.35) aggr = rand(0.75, 1);       // охотники: режут под голову
  else if (roll < 0.75) aggr = rand(0.4, 0.75); // обычные
  else aggr = rand(0.1, 0.35);                  // собиратели еды
  aggr *= 0.93;                                 // владелец 06.10: агрессивность −7%
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
  s.name = ROLES[s.role].name;
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
  let best = null, bestD = -1;
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
  n = String(n || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16);
  if (!n || n.toLowerCase() === BOT_NAME.toLowerCase()) n = 'Игрок';
  return n;
}
function cleanSkin(sk) {
  sk = sk || {};
  const id = clamp(Math.floor(Number(sk.id)), 0, SKINS.length - 1) || 0;
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
    const pos = process.env.TEST_SPAWN_CENTER ? { x: 0, y: 300 } : findSpawn(false); // TEST_SPAWN_CENTER — только для проверок
    if (TEAM && roundPause) return; // перерыв между раундами — браузер зайдёт сам через 10 с
    const team = TEAM ? (m.team === 0 || m.team === 1 ? m.team : teamWithFewer(true)) : null;
    if (TEAM && !process.env.TEST_SPAWN_CENTER) { const p = findSpawn(false, BASES[team][0], BASES[team][1], 1300); pos.x = p.x; pos.y = p.y; } // у своей базы
    const s = new Snake(pos.x, pos.y, START_MASS, false, cleanName(m.name), cleanSkin(m.skin));
    if (TEAM) { s.team = team; setTeamSkin(s); s.born = tick; c.rs = c.rs || { kills: 0, orbs: 0, caps: 0, life: 0 }; c.rs.name = s.name; c.rs.team = team; }
    if (TEAM && process.env.TEST_ORB_NEAR) { const o = orbs[0]; o.alive = true; o.x = s.xs[0] + Math.cos(s.a) * Number(process.env.TEST_ORB_NEAR); o.y = s.ys[0] + Math.sin(s.a) * Number(process.env.TEST_ORB_NEAR); } // только для проверок: шар на таком расстоянии перед новой змеёй
    s.client = c; c.snake = s; c.inA = s.a;
    if (TEAM && process.env.TEST_FLAG) { const f = flags[1 - s.team]; f.x = s.xs[0] + Math.cos(s.a) * 5; f.y = s.ys[0] + Math.sin(s.a) * 5; BASES[s.team] = [s.xs[0] + Math.cos(s.a) * 200, s.ys[0] + Math.sin(s.a) * 200];
      if (process.env.TEST_TARGET) { const pa = s.a + Math.PI / 2, bx = s.xs[0] + Math.cos(s.a) * 600 + Math.cos(pa) * 150, by = s.ys[0] + Math.sin(s.a) * 600 + Math.sin(pa) * 150; const b = new Snake(bx, by, 800, true, 'Мишень', randomSkin()); b.a = b.ta = pa; for (let i = 0; i < b.xs.length; i++) { b.xs[i] = bx - Math.cos(pa) * i * SEG_D; b.ys[i] = by - Math.sin(pa) * i * SEG_D; } b.team = 1 - s.team; setTeamSkin(b); snakes.set(b.id, b); } } // только для проверок: чужое знамя у головы, своя база рядом
    snakes.set(s.id, s);
    stats.onJoin(c);
    sendJSON(c, { t: 'spawn', id: s.id, ...(TEAM ? { team: s.team } : {}) });
  } else if (m.t === 'view') {
    c.w = clamp(Number(m.w) || 1280, 200, 3000); c.h = clamp(Number(m.h) || 720, 200, 3000);
  } else if (m.t === 'fire') {
    if (TEAM && c.snake && c.snake.alive) fireRocket(c.snake);
  } else if (m.t === 'ping') {
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
  const sc = viewScale(c.w, c.h, r, me && me.alive ? me.role : 0, TEAM && me && me.alive ? me.mass : 0);
  const hw = c.w / 2 / sc + 260, hh = c.h / 2 / sc + 260; // запас под «взгляд вперёд» камеры в браузере
  const x0 = vx - hw, x1 = vx + hw, y0 = vy - hh, y1 = vy + hh;

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
  const top = arr.slice(0, 10).map(s => [displayName(s), Math.floor(s.mass), s.id, s.team == null ? -1 : s.team]);
  const rank = new Map();
  arr.forEach((s, i) => rank.set(s, i + 1));
  // Миникарта как в оригинале: тело каждой змеи — короткая ломаная (до 30 точек, координаты 0..255).
  // Первое число — 1 у живого игрока, 0 у бота. Шлём раз в секунду: этого хватает, а трафик меньше.
  let mm = null;
  if (tick % TICK_RATE === 0) {
    mm = [];
    const q = v => Math.max(0, Math.min(255, Math.round((v / MAP_R + 1) * 127.5)));
    for (const s of arr) {
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
  const rec = tick % (TICK_RATE * 5) === 0 ? records.view() : null; // рекорды — раз в 5 с
  const tm = TEAM ? teamScores() : null;
  for (const c of clients) {
    const me = c.snake && c.snake.alive ? c.snake : null;
    sendJSON(c, { t: 'lb', ...(tm ? { tm } : {}), top, rank: me ? rank.get(me) : 0, score: me ? Math.floor(me.mass) : 0, total: arr.length, players, pn, online: clients.size, ...(mm ? { mm } : {}), ...(ev ? { ev } : {}), ...(rec ? { rec } : {}) });
  }
}

// ===== Шаг мира =====
// ===== События на карте (владелец 06.10): раз в 10 минут по очереди «Ночь мафии» и «Золотая еда» =====
const EVENT_EVERY = (Number(process.env.TEST_EVENT_EVERY) || 90) * TICK_RATE; // владелец 07.10: ночь раз в 3 минуты, золото между ночами; // TEST_EVENT_EVERY — только для проверок
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
  nextEventType = nextEventType === 'night' ? 'gold' : 'night'; // по очереди: ночь раз в 3 минуты
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
  if (!TEAM || roundPause) return;
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
          const o = PS[p]; if (!o.alive || o.team === r.team) continue;
          const dx = PX[p] - r.x, dy = PY[p] - r.y, rr = o.r + ROCKET_HIT;
          if (dx * dx + dy * dy < rr * rr) { hit = o; break; }
        }
      }
    }
    const out = Math.hypot(r.x, r.y) > MAP_R;
    if (hit || out || tick >= r.die) {
      rockets.splice(i, 1);
      for (const c of clients) sendJSON(c, { t: 'boom', id: r.id, x: Math.round(r.x), y: Math.round(r.y), hit: hit ? 1 : 0, o: r.owner.id });
      if (hit) { const killer = r.owner.alive ? r.owner : null; if (!hit.bot || (killer && !killer.bot)) teamMsg(`💥 ${r.owner.name} подбил базукой ${hit.name}!`); killSnake(hit, killer); }
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

function step() {
  tick++;
  runRound();
  for (const s of snakes.values()) if (s.bot) botThink(s); // каждый шаг — быстрее реагируют на опасность
  for (const s of snakes.values()) moveSnake(s);
  buildGrid();
  collisions();
  for (const s of snakes.values()) if (s.alive) eat(s);
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
function loop() {
  const now = performance.now();
  acc += now - lastT; lastT = now;
  // Владелец 07.10: к арене никто не подключён (ни в игре, ни в меню) — она стоит на паузе и не тратит процессор
  if (!clients.size && !process.env.TEST_NO_PAUSE) { acc = 0; paused = true; setTimeout(loop, 100); return; }
  if (paused) { paused = false; console.log('арена проснулась: подключился человек'); }
  let n = 0;
  while (acc >= TICK_MS && n < 4) {
    const t0 = performance.now();
    step();
    const dt = performance.now() - t0;
    if (dt > worstMs) worstMs = dt;
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
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json; charset=utf-8' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (stats.handle(req, res, url, liveCounts)) return;
  if (voice.handle(req, res, url, cleanName)) return;
  const file = path.normalize(path.join(PUBLIC, url === '/' ? 'index.html' : url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
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
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (teamProc) teamProc.kill(); process.exit(0); });
process.on('exit', () => { if (teamProc) teamProc.kill(); });
if (TEAM && process.send) process.on('disconnect', () => process.exit(0)); // основной процесс закрылся — арена тоже
wss.on('connection', (ws, req) => {
  if (clients.size >= MAX_CLIENTS) { ws.close(1013, 'full'); return; }
  const c = { ws, snake: null, w: 1280, h: 720, vx: rand(-1500, 1500), vy: rand(-1500, 1500), known: new Map(), cells: new Set(), msgs: 0, msgT: Date.now() };
  clients.add(c); c.ua = String(req.headers['user-agent'] || '');
  stats.onConnect(c, req);
  sendJSON(c, { t: 'lb', top: [], players: 0, online: clients.size, rec: records.view() });
  sendJSON(c, { t: 'hello', proto: PROTO, team: TEAM, ...(TEAM ? { bases: BASES, baseR: BASE_R } : {}), mapR: MAP_R, tickRate: TICK_RATE, segD: SEG_D, fcell: FCELL });
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
    if (m && typeof m === 'object') handleJSON(c, m);
  });
  ws.on('close', () => {
    clients.delete(c);
    if (c.snake && c.snake.alive) { c.snake.client = null; killSnake(c.snake, null); }
  });
  ws.on('error', () => {});
});

while (naturalFood < FOOD_TARGET) spawnNaturalFood();
cellEv.clear();
records.load();
// Рекорды командной арены живут в основном процессе: арена шлёт их при каждом изменении и получает обратно при запуске
let teamRecStore = null;
if (TEAM && process.send) {
  process.on('message', m => { if (m && m.t === 'recInit') records.restore(m.data); });
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

module.exports = { radiusFor, segsFor, viewScale };
