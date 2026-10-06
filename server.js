'use strict';
// Марми Мафия — сервер. Ведёт одну общую карту: змейки игроков, боты, еда.
// Телефоны и компьютеры только рисуют картинку и присылают, куда повернуть.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { SKINS, MAX_PATTERN, skinCols } = require('./public/skins.js');
const stats = require('./stats.js');
const voice = require('./voice.js');
const records = require('./records.js');

// ===== Настройки =====
const PORT = Number(process.env.PORT) || 7777; // 8080 занят сайтом бота недвижимости
const TICK_RATE = 30;            // шагов мира в секунду
const TICK_MS = 1000 / TICK_RATE;
const MAP_R = 5000;              // радиус круглой карты
const TARGET_SNAKES = 40;        // живые игроки + боты; зашёл человек — бот уступает место
const FOOD_TARGET = 3490;        // обычной еды на карте: в оригинале её немного, ~25 точек на экран
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
const displayName = s => s.bot ? roleShort(s.role || 0) : s.name + ' ' + roleShort(s.role || 0);
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
function viewScale(w, h, r, role) {
  // Владелец 06.10: на телефоне камера ближе (как на компьютере) — раньше змейка на старте была 15 px и терялась
  const base = Math.max(clamp(Math.sqrt(w * h) / 750, 0.5, 1.6), Math.min(w, h) < 600 ? 1.05 : 0), sct = 2 + (r / 10 - 1) * SC_DIV;
  return base * (0.64285 + 0.514285714 / Math.max(1, (sct + 16) / 36)) / 1.157142857 * (ROLE_ZOOM[role] || 1);
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
        if (o === s) continue;           // в себя врезаться нельзя, как в slither.io
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
    if (killer.client) sendJSON(killer.client, { t: 'kill', name: s.name });
  }
  const c = s.client;
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
      if (dx * dx + dy * dy < rr * rr) { s.mass += f.v; removeFood(f, s.id); }
    }
  }
}

// Место для появления: подальше от чужих тел и голов игроков
function findSpawn(awayFromPlayers) {
  let best = null, bestD = -1;
  for (let t = 0; t < 30; t++) {
    const a = rand(0, TAU), d = Math.sqrt(Math.random()) * (MAP_R - 700);
    const x = Math.cos(a) * d, y = Math.sin(a) * d;
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
  snakes.set(s.id, s);
}

function maintainBots() {
  let players = 0, bots = 0;
  for (const s of snakes.values()) { if (s.bot) bots++; else players++; }
  // Ботов ровно столько, чтобы всего было TARGET_SNAKES; люди вытесняют ботов по мере их гибели
  for (let i = 0; i < 2 && players + bots < TARGET_SNAKES; i++) { spawnBot(); bots++; }
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
      if (o === b || !o.alive) continue;
      // Голову жертвы тоже боимся: раньше охотники отключали этот страх и сами врезались в неё (33 из 123 смертей)
      const dx = PX[p] - hx, dy = PY[p] - hy, rr = R + o.r;
      if (dx * dx + dy * dy > rr * rr) continue;
      OBX[obN] = PX[p]; OBY[obN] = PY[p]; OBR[obN] = o.r; obN++;
    }
  }
  // Куда чужие головы приедут через миг — туда тоже не лезем
  for (const o of snakes.values()) {
    if (o === b || !o.alive) continue;
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
    if (o === b || !o.alive) continue;
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
  const pile = bestFood(b, hx, hy);
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
    const s = new Snake(pos.x, pos.y, START_MASS, false, cleanName(m.name), cleanSkin(m.skin));
    s.client = c; c.snake = s; c.inA = s.a;
    snakes.set(s.id, s);
    stats.onJoin(c);
    sendJSON(c, { t: 'spawn', id: s.id });
  } else if (m.t === 'view') {
    c.w = clamp(Number(m.w) || 1280, 200, 3000); c.h = clamp(Number(m.h) || 720, 200, 3000);
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
  const sc = viewScale(c.w, c.h, r, me && me.alive ? me.role : 0);
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
      (metas || (metas = [])).push([t.id, t.name, t.skin.id, t.skin.c1, t.skin.c2, t.skin.c3, t.bot ? 1 : 0, t.skin.pat || 0, t.role || 0]);
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
  const top = arr.slice(0, 10).map(s => [displayName(s), Math.floor(s.mass), s.id]);
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
      const line = [s.bot ? 0 : 1];
      for (let i = 0; i < len; i += step) line.push(q(s.xs[i]), q(s.ys[i]));
      line.push(q(s.xs[len - 1]), q(s.ys[len - 1]));
      mm.push(line);
    }
  }
  const players = arr.reduce((n, s) => n + (s.bot ? 0 : 1), 0);
  const pn = arr.filter(s => !s.bot).map(s => [s.name, Math.floor(s.mass)]); // ники живых людей — по нажатию на цифру внизу
  const ev = event ? [event.type, Math.ceil((event.until - tick) / TICK_RATE), Math.round(event.x), Math.round(event.y)] : null;
  const rec = tick % (TICK_RATE * 5) === 0 ? records.view() : null; // рекорды — раз в 5 с
  for (const c of clients) {
    const me = c.snake && c.snake.alive ? c.snake : null;
    sendJSON(c, { t: 'lb', top, rank: me ? rank.get(me) : 0, score: me ? Math.floor(me.mass) : 0, total: arr.length, players, pn, online: clients.size, ...(mm ? { mm } : {}), ...(ev ? { ev } : {}), ...(rec ? { rec } : {}) });
  }
}

// ===== Шаг мира =====
// ===== События на карте (владелец 06.10): раз в 10 минут по очереди «Ночь мафии» и «Золотая еда» =====
const EVENT_EVERY = (Number(process.env.TEST_EVENT_EVERY) || 600) * TICK_RATE; // TEST_EVENT_EVERY — только для проверок
const NIGHT_LEN = 60 * TICK_RATE, GOLD_LEN = 45 * TICK_RATE;
let event = null, nextEventAt = Math.round(EVENT_EVERY / 2), nextEventType = process.env.TEST_EVENT_FIRST || 'gold'; // TEST_EVENT_FIRST — только для проверок
function runEvents() {
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
  nextEventType = nextEventType === 'night' ? 'gold' : 'night';
  nextEventAt = tick + EVENT_EVERY;
}
// Рекорды: раз в 2 секунды сообщаем длину живых людей
function reportRecords() {
  for (const s of snakes.values()) {
    if (s.bot || !s.alive) continue;
    const hit = records.report(s.name, s.mass);
    if (hit && s.client && s.recShown !== hit) { s.recShown = hit; sendJSON(s.client, { t: 'record', kind: hit }); }
  }
}

function step() {
  tick++;
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
  if (tick % (TICK_RATE * 2) === 0) reportRecords();
}

let lastT = performance.now(), acc = 0, slowTicks = 0, worstMs = 0;
function loop() {
  const now = performance.now();
  acc += now - lastT; lastT = now;
  let n = 0;
  while (acc >= TICK_MS && n < 4) {
    const t0 = performance.now();
    step();
    const dt = performance.now() - t0;
    if (dt > worstMs) worstMs = dt;
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
  console.log(`[${new Date().toLocaleTimeString('ru-RU')}] онлайн ${clients.size}, в игре ${players}, ботов ${bots}, еды ${foods.size}, худший шаг ${worstMs.toFixed(1)} мс, медленных шагов ${slowTicks}, боты разбились: о тела ${deathStats.botBody}, о край ${deathStats.botWall}, больших (>1000): ${[...snakes.values()].filter(s => s.mass > 1000).length}`);
  deathStats.botBody = deathStats.botWall = deathStats.player = 0;
  worstMs = 0; slowTicks = 0;
}, 60000);

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

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096, perMessageDeflate: false });
wss.on('connection', (ws, req) => {
  if (clients.size >= MAX_CLIENTS) { ws.close(1013, 'full'); return; }
  const c = { ws, snake: null, w: 1280, h: 720, vx: rand(-1500, 1500), vy: rand(-1500, 1500), known: new Map(), cells: new Set(), msgs: 0, msgT: Date.now() };
  clients.add(c);
  stats.onConnect(c, req);
  sendJSON(c, { t: 'lb', top: [], players: 0, online: clients.size, rec: records.view() });
  sendJSON(c, { t: 'hello', proto: PROTO, mapR: MAP_R, tickRate: TICK_RATE, segD: SEG_D, fcell: FCELL });
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
server.listen(PORT, () => {
  console.log(`Марми Мафия запущена: http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`  с телефона в той же Wi-Fi: http://${a.address}:${PORT}`);
  }
  loop();
});

module.exports = { radiusFor, segsFor, viewScale };
