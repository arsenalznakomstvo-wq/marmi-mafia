'use strict';
// Марми Мафия — клиент. Рисует то, что прислал сервер, и отправляет, куда повернуть.
// «Чёрный ящик» (владелец 11.10: в установленном приложении — только тёмный экран): любая ошибка на телефоне
// уходит на сервер (/clienterr), её видно на /errs — так можно понять, что ломается на чужом телефоне
(() => {
  const app = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone === true;
  let sent = 0;
  const report = (msg, where) => { if (sent++ > 5) return; try { navigator.sendBeacon('/clienterr', JSON.stringify({ msg: String(msg).slice(0, 300), where: String(where || '').slice(0, 120), app, w: innerWidth, h: innerHeight })); } catch (e) {} };
  window.addEventListener('error', e => report(e.message, (e.filename || '').split('/').pop() + ':' + e.lineno + ':' + e.colno));
  window.addEventListener('unhandledrejection', e => report('promise: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason), ''));
  window.__mmReport = report;
})();
(() => {
const TAU = Math.PI * 2;
let MAP_R = 5000, TICK_RATE = 30, SEG_D = 6, FCELL = 250;
const PROTO = 6;        // версия «языка» сервер↔браузер; должна совпадать с PROTO в server.js
let protoOk = false;
// Рисуем чуть позади сервера, с запасом под неровную доставку. Запас подстраивается сам:
// замеряем паузы между обновлениями и держим запас чуть больше обычной паузы (от 3 до 9 шагов = 100–300 мс).
let interpTicks = 4, interpWant = 4, lastArrive = 0;
const gaps = []; let gapsN = 0;

const $ = id => document.getElementById(id);
const canvas = $('game'), ctx = canvas.getContext('2d');
const mm = $('minimap'), mctx = mm.getContext('2d');
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
let W = 0, H = 0, DPR = 1;

// ===== Формулы (как на сервере) =====
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function angDiff(a, b) { let d = b - a; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; }
// Камера как в оригинале: отдаляется по мере роста числа сегментов (формула та же, что в server.js)
// Владелец 07.10: Дону и Киллеру (и Мафии — она старше Киллера) камера выше — видно больше карты
const ROLE_ZOOM = { 7: 0.85, 8: 0.85, 9: 0.72 }; // номера ролей: 7 Киллер, 8 Мафия, 9 Дон (см. public/roles.js)
// Владелец 07.10: в командной игре чем длиннее змея, тем выше камера (видно красоту карты): с 300 плавно до ×0,5 на 8000
let farView = false;
const teamZoom = mass => mass > 300 ? 1 - 0.5 * Math.min(1, Math.log(mass / 300) / Math.log(8000 / 300)) : 1;
function viewScale(w, h, r, role, mass, eye) {
  // Владелец 06.10: на телефоне камера ближе (как на компьютере) — раньше змейка на старте была 15 px и терялась
  const base = Math.max(clamp(Math.sqrt(w * h) / 750, 0.5, 1.6), Math.min(w, h) < 600 ? 1.05 : 0), sct = 2 + (r / 10 - 1) * 60; // 60 — как SC_DIV в server.js
  return base * (0.64285 + 0.514285714 / Math.max(1, (sct + 16) / 36)) / 1.157142857 * (ROLE_ZOOM[role] || 1) * (mass ? teamZoom(mass) : 1) * (eye ? window.Skins.EYE_ZOOM : 1); // eye — скин «Циклоп»: обзор на 30% больше
}

// ===== Цвета =====
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbToHex(r, g, b) { return '#' + ((1 << 24) | (clamp(r | 0, 0, 255) << 16) | (clamp(g | 0, 0, 255) << 8) | clamp(b | 0, 0, 255)).toString(16).slice(1); }
function shade(h, p) { const [r, g, b] = hexToRgb(h); return rgbToHex(r + p, g + p, b + p); }
function lerpColor(a, b, t) { const x = hexToRgb(a), y = hexToRgb(b); return rgbToHex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t); }
function rgba(h, a) { const [r, g, b] = hexToRgb(h); return `rgba(${r},${g},${b},${a})`; }
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return rgbToHex(f(0), f(8), f(4));
}
function c565(v) { const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31; return rgbToHex(r * 255 / 31, g * 255 / 63, b * 255 / 31); }

// ===== Спрайты: каждый шарик рисуется один раз, потом только копируется — быстро даже на телефоне =====
const SPR = 64, SR = 26;            // в спрайте 64×64 шар радиусом 26, остальное — место под свечение
const sprites = new Map();
// Владелец 11.10 («игра подвисает»): на телефоне яркость раньше давал CSS-фильтр на весь экран (#game) — телефон
// перекрашивал каждый кадр целиком ещё раз. Теперь яркость «запекается» один раз в каждую заготовку (шарики, еда, фон).
const BRIGHT = isTouch && 'filter' in CanvasRenderingContext2D.prototype ? 'brightness(1.15) saturate(1.05)' : '';
function brighten(c) {
  if (!BRIGHT) return c;
  const t = document.createElement('canvas'); t.width = c.width; t.height = c.height;
  const g = t.getContext('2d'); g.filter = BRIGHT; g.drawImage(c, 0, 0); return t;
}
function sprite(key, paint) {
  let s = sprites.get(key);
  if (!s) { s = document.createElement('canvas'); s.width = s.height = SPR; paint(s.getContext('2d')); s = brighten(s); sprites.set(key, s); }
  return s;
}
// Кружок тела как в slither.io: светлая середина, тёмный край. Кружки идут очень плотно —
// вместе они дают гладкую «трубку» со светлой полосой посередине.
function paintBall(g, col) {
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, SR);
  gr.addColorStop(0, shade(col, 38)); gr.addColorStop(0.5, shade(col, 16)); gr.addColorStop(0.82, col); gr.addColorStop(1, shade(col, -45));
  g.fillStyle = gr; g.beginPath(); g.arc(32, 32, SR, 0, TAU); g.fill();
}
const ball = col => sprite('b' + col, g => paintBall(g, col));
const ringBall = (col, v) => sprite('r' + col + v, g => {
  const gr = g.createRadialGradient(32, 32, 2, 32, 32, SR); gr.addColorStop(0, '#2a2a2a'); gr.addColorStop(1, '#0b0b0b');
  g.fillStyle = gr; g.beginPath(); g.arc(32, 32, SR, 0, TAU); g.fill();
  g.strokeStyle = col; g.lineWidth = 4; g.beginPath(); g.arc(32, 32, SR - 2, 0, TAU); g.stroke();
  if (v) { g.lineWidth = 3; g.beginPath(); g.arc(32, 32, SR * 0.4, 0, TAU); g.stroke(); }
});
const glowBall = col => sprite('g' + col, g => {
  g.shadowColor = col; g.shadowBlur = 8;
  const gr = g.createRadialGradient(32, 32, 1, 32, 32, SR); gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.35, shade(col, 50)); gr.addColorStop(1, col);
  g.fillStyle = gr; g.beginPath(); g.arc(32, 32, SR - 2, 0, TAU); g.fill();
});
const spaceBall = (c1, c2, v) => sprite('s' + c1 + c2 + v, g => {
  const gr = g.createRadialGradient(32, 32, 2, 32, 32, SR); gr.addColorStop(0, '#1d1d5a'); gr.addColorStop(1, '#06061a');
  g.fillStyle = gr; g.beginPath(); g.arc(32, 32, SR, 0, TAU); g.fill();
  g.fillStyle = c1;
  for (let i = 0; i < 4; i++) { const a = (v * 2.1 + i * 1.7) % TAU, d = SR * (0.25 + ((v + i) % 3) * 0.2); g.beginPath(); g.arc(32 + Math.cos(a) * d, 32 + Math.sin(a) * d, 2 + (i % 2), 0, TAU); g.fill(); }
  g.strokeStyle = c2; g.lineWidth = 2; g.beginPath(); g.arc(32, 32, SR - 1, 0, TAU); g.stroke();
});
const shadowSprite = () => sprite('shadow', g => {
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(0.6, 'rgba(0,0,0,0.3)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, SPR, SPR);
});
const haloSprite = col => sprite('h' + col, g => {
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, rgba(col, 0.85)); gr.addColorStop(0.5, rgba(col, 0.35)); gr.addColorStop(1, rgba(col, 0));
  g.fillStyle = gr; g.fillRect(0, 0, SPR, SPR);
});
const FOOD_CORE = 5; // радиус яркой точки еды в спрайте; вокруг — широкий слабый ореол
// На телефоне еда рисуется квадратом в 0,6 раза меньше (почти невидимый край ореола обрезан) — в 2,8 раза меньше закрашиваемых точек
const FOOD_K = isTouch ? 0.6 : 1;
const foodSprite = col => sprite('f' + col, g => {
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32), k = FOOD_K;
  gr.addColorStop(0, shade(col, 110)); gr.addColorStop(0.1 / k, shade(col, 50)); gr.addColorStop(0.16 / k, col);
  gr.addColorStop(0.24 / k, rgba(col, 0.16)); gr.addColorStop(Math.min(0.98, 0.55 / k), rgba(col, 0.045)); gr.addColorStop(1, rgba(col, 0));
  g.fillStyle = gr; g.fillRect(0, 0, SPR, SPR);
});

// Еда для низкого качества: яркая точка с узким ореолом
const foodDot = col => sprite('fd' + col, g => {
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, shade(col, 100)); gr.addColorStop(0.45, col); gr.addColorStop(0.62, rgba(col, 0.25)); gr.addColorStop(1, rgba(col, 0));
  g.fillStyle = gr; g.fillRect(0, 0, SPR, SPR);
});

const SKINS = window.Skins.SKINS;
function prepSkin(sk) {
  const def = SKINS[sk.id] || SKINS[1];
  const cols = window.Skins.skinCols(sk);
  const flag = cols.filter((c, i) => i === 0 || c !== cols[i - 1]); // полосы флага без повторов
  // unitK — ширина одной полосы в радиусах: у своей змейки, как в оригинале, одно нажатие = одно тонкое колечко
  return { id: sk.id, cols, style: def.style || 'ball', eyes: def.eyes || 'normal', badge: !!def.badge, flag, unitK: sk.id === 0 ? 0.45 : 1.4, once: !!sk.once, text: def.text || '', textColor: def.textColor || '', textStroke: def.textStroke || '', water: def.water || null, plain: !!def.plain, bag: !!def.bag };
}
// Цвет в точке узора u (дробное число полос от головы). Как в оригинале — чистые полосы,
// без смешивания цветов (смешивание давало грязные серо-зелёные переходы).
function bandColor(cols, u) {
  const n = cols.length, i = Math.floor(u);
  return cols[((i % n) + n) % n];
}
// Водный шарик: прозрачная середина, плотнее к краю (кромка-поверхность), блик сверху. Внахлёст даёт «толщу воды».
const waterBall = w => sprite('w' + w.kind, g => {
  const a = w.kind === 'ice' ? 0.14 : w.kind === 'soap' ? 0.03 : w.kind === 'ocean' ? 0.16 : w.kind === 'eye' ? 0.11 : 0.07; // шарики идут внахлёст ~5 слоёв — прозрачность складывается
  const gr = g.createRadialGradient(32 - 5, 32 - 6, 1, 32, 32, SR);
  gr.addColorStop(0, rgba(w.core, a)); gr.addColorStop(0.72, rgba(w.core, a * 1.4)); gr.addColorStop(0.92, rgba(w.rim, Math.min(1, a * 3.2))); gr.addColorStop(1, rgba(w.rim, 0.06));
  g.fillStyle = gr; g.beginPath(); g.arc(32, 32, SR, 0, TAU); g.fill();
});
function skinSprite(sk, u) {
  if (sk.once && u >= sk.cols.length) return ball('#151515'); // конструктор: незакрашенное тело — чёрное
  switch (sk.style) {
    case 'glow': return glowBall(bandColor(sk.cols, u));
    case 'space': return spaceBall(sk.cols[0], sk.cols[1], Math.floor(u) % 3);
    case 'skeleton': return ringBall(sk.cols[0], Math.floor(u) & 1);
    case 'water': return waterBall(sk.water);
    default: return ball(bandColor(sk.cols, u));
  }
}
const headColor = sk => sk.style === 'space' ? '#7a7aff' : sk.cols[0];

// Оранжевая сумка на плече (скин «Марми», владелец 11.10): ремешок через «плечо» (шею), сумка висит сбоку и слегка покачивается.
// Кожа с бликом, клапан, золотая застёжка, строчка по краю.
function drawShoulderBag(g, hx, hy, a, r, neck) {
  const [nx, ny, na] = neck, c = Math.cos(na), s = Math.sin(na), px = s, py = -c, sw = Math.sin(performance.now() * 0.003) * r * 0.08; // сумка — на левом боку (справа висит табличка роли)
  const bx = nx - c * r * 0.6 + px * r * 1.55 + px * sw, by = ny - s * r * 0.6 + py * r * 1.55 + py * sw; // центр сумки — сбоку, чуть позади шеи
  // ремешок: от другого бока шеи через спину к сумке
  g.strokeStyle = '#c45a0c'; g.lineWidth = Math.max(1.2, r * 0.13); g.lineCap = 'round';
  g.beginPath(); g.moveTo(nx + c * r * 0.25 - px * r * 0.9, ny + s * r * 0.25 - py * r * 0.9); g.quadraticCurveTo(nx + c * r * 0.4, ny + s * r * 0.4, bx + c * r * 0.4 - px * r * 0.45, by + s * r * 0.4 - py * r * 0.45); g.stroke();
  g.save(); g.translate(bx, by); g.rotate(na + Math.PI / 2 + sw * 0.02);
  // владелец 11.10: змея растёт — сумка тоже чуть подрастает относительно тела (до +40% у самой толстой)
  const bk = 1 + Math.min(0.4, Math.max(0, r - 10) / 125), W = r * 1.35 * bk, H = r * 1.0 * bk, rr = r * 0.22 * bk;
  g.fillStyle = 'rgba(0,0,0,0.25)'; g.beginPath(); g.ellipse(r * 0.08, H * 0.62, W * 0.5, H * 0.14, 0, 0, TAU); g.fill(); // тень
  const gr = g.createLinearGradient(0, -H / 2, 0, H / 2); gr.addColorStop(0, '#ffb35c'); gr.addColorStop(0.5, '#ff8a1f'); gr.addColorStop(1, '#c45a0c');
  g.fillStyle = gr; g.beginPath(); g.moveTo(-W / 2 + rr, -H / 2); g.lineTo(W / 2 - rr, -H / 2); g.quadraticCurveTo(W / 2, -H / 2, W / 2, -H / 2 + rr);
  g.lineTo(W / 2 * 0.92, H / 2 - rr); g.quadraticCurveTo(W / 2 * 0.92, H / 2, W / 2 * 0.92 - rr, H / 2); g.lineTo(-W / 2 * 0.92 + rr, H / 2); g.quadraticCurveTo(-W / 2 * 0.92, H / 2, -W / 2 * 0.92, H / 2 - rr);
  g.lineTo(-W / 2, -H / 2 + rr); g.quadraticCurveTo(-W / 2, -H / 2, -W / 2 + rr, -H / 2); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(120, 50, 5, 0.6)'; g.lineWidth = Math.max(0.6, r * 0.04); g.stroke();
  g.fillStyle = '#e8700f'; g.beginPath(); g.moveTo(-W / 2, -H / 2 + rr); g.lineTo(W / 2, -H / 2 + rr); g.lineTo(W * 0.32, H * 0.08); g.quadraticCurveTo(0, H * 0.2, -W * 0.32, H * 0.08); g.closePath(); g.fill(); // клапан
  g.setLineDash([r * 0.08, r * 0.07]); g.strokeStyle = 'rgba(255, 230, 190, 0.7)'; g.lineWidth = Math.max(0.5, r * 0.035);
  g.beginPath(); g.moveTo(-W * 0.42, -H / 2 + rr * 1.3); g.lineTo(W * 0.42, -H / 2 + rr * 1.3); g.stroke(); g.setLineDash([]); // строчка
  g.fillStyle = '#ffd52e'; g.strokeStyle = '#a77a00'; g.lineWidth = Math.max(0.5, r * 0.03);
  g.beginPath(); g.ellipse(0, H * 0.06, W * 0.09, H * 0.08, 0, 0, TAU); g.fill(); g.stroke(); // застёжка
  g.fillStyle = 'rgba(255,255,255,0.35)'; g.beginPath(); g.ellipse(-W * 0.25, H * 0.3, W * 0.12, H * 0.06, -0.3, 0, TAU); g.fill(); // блик
  g.restore();
}
// Глаза и значок на шее. neck = [x, y, угол] — точка чуть позади головы.
function drawHeadDecor(g, sk, hx, hy, a, look, r, neck) {
  if (sk.badge && neck && sk.flag.length) {
    // Табличка на спине, как в оригинале: квадрат с флагом и тонкая волнистая ниточка от неё к голове
    const bs = r * 1.3, n = sk.flag.length, nx = neck[0], ny = neck[1];
    const dx = hx - nx, dy = hy - ny, L = Math.hypot(dx, dy) || 1, qx = -dy / L, qy = dx / L;
    g.strokeStyle = shade(sk.cols[0], -55); g.lineWidth = Math.max(1, r * 0.09); g.lineCap = 'round';
    g.beginPath();
    for (let i = 0; i <= 16; i++) {
      const t = i / 16, w = Math.sin(t * Math.PI * 3) * r * 0.16;
      const x = nx + dx * t * 0.85 + qx * w, y = ny + dy * t * 0.85 + qy * w;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
    g.save(); g.translate(nx, ny); g.rotate(neck[2] + Math.PI / 4 * 0.35);
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(-bs / 2 + r * 0.1, -bs / 2 + r * 0.14, bs, bs);
    for (let i = 0; i < n; i++) { g.fillStyle = sk.flag[i]; g.fillRect(-bs / 2 + i * bs / n, -bs / 2, bs / n + 0.5, bs); }
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = Math.max(1, r * 0.05); g.strokeRect(-bs / 2, -bs / 2, bs, bs);
    g.restore();
  }
  const ca = Math.cos(a), sa = Math.sin(a), px = -sa, py = ca, cl = Math.cos(look), sl = Math.sin(look);
  if (sk.eyes === 'gold') sk = Object.assign({}, sk, { eyes: 'normal', goldEyes: true });
  if (sk.eyes === 'shades') sk = Object.assign({}, sk, { eyes: 'normal', shades: true });
  const eye = (ex, ey, er, iris) => {
    g.fillStyle = sk.goldEyes ? '#ffd52e' : '#ffffff'; g.beginPath(); g.arc(ex, ey, er, 0, TAU); g.fill();
    g.lineWidth = Math.max(1, r * 0.06); g.strokeStyle = 'rgba(0,0,0,0.4)'; g.stroke();
    const ox = ex + cl * er * 0.35, oy = ey + sl * er * 0.35;
    if (iris) { g.fillStyle = iris; g.beginPath(); g.arc(ox, oy, er * 0.58, 0, TAU); g.fill(); }
    g.fillStyle = '#111111'; g.beginPath(); g.arc(ox, oy, er * (iris ? 0.32 : 0.6), 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.85)'; g.beginPath(); g.arc(ox - er * 0.18, oy - er * 0.18, er * 0.16, 0, TAU); g.fill();
  };
  if (sk.bag && neck) drawShoulderBag(g, hx, hy, a, r, neck);
  if (sk.eyes === 'lady') { // женское лицо (владелец 11.10): миндалевидные глаза с длинными ресницами, румянец, губки
    for (const sgn of [-1, 1]) {
      const ex = hx + ca * r * 0.3 + px * sgn * r * 0.46, ey = hy + sa * r * 0.3 + py * sgn * r * 0.46, er = r * 0.38;
      g.save(); g.translate(ex, ey); g.rotate(a);
      g.fillStyle = '#ffffff'; g.beginPath(); g.ellipse(0, 0, er * 0.95, er * 0.78, 0, 0, TAU); g.fill(); // белок, чуть вытянут
      g.lineWidth = Math.max(1, r * 0.05); g.strokeStyle = 'rgba(0,0,0,0.35)'; g.stroke();
      const ox = Math.cos(look - a) * er * 0.3, oy = Math.sin(look - a) * er * 0.3;
      g.fillStyle = '#6b3a12'; g.beginPath(); g.arc(ox, oy, er * 0.55, 0, TAU); g.fill(); // карая радужка
      g.fillStyle = '#111'; g.beginPath(); g.arc(ox, oy, er * 0.3, 0, TAU); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.9)'; g.beginPath(); g.arc(ox - er * 0.15, oy - er * 0.18, er * 0.14, 0, TAU); g.fill();
      // ресницы: дуга с краю (сторона от середины головы) и 3 загнутых реснички
      g.strokeStyle = '#111'; g.lineCap = 'round'; g.lineWidth = Math.max(1.2, r * 0.08);
      g.beginPath(); g.ellipse(0, 0, er * 0.98, er * 0.82, 0, sgn > 0 ? 0.15 * Math.PI : 1.15 * Math.PI, sgn > 0 ? 0.85 * Math.PI : 1.85 * Math.PI); g.stroke();
      g.lineWidth = Math.max(1, r * 0.06);
      for (const t of [-0.5, 0, 0.5]) { const an = (sgn > 0 ? Math.PI / 2 : -Math.PI / 2) + t, x0 = Math.cos(an) * er * 0.82, y0 = Math.sin(an) * er * 0.72;
        g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo(x0 + Math.cos(an) * er * 0.3, y0 + Math.sin(an) * er * 0.3, x0 + Math.cos(an + t * 0.6) * er * 0.38 + er * 0.12, y0 + Math.sin(an) * er * 0.5); g.stroke(); }
      g.restore();
      g.fillStyle = 'rgba(255, 140, 60, 0.28)'; g.beginPath(); g.arc(hx - ca * r * 0.1 + px * sgn * r * 0.62, hy - sa * r * 0.1 + py * sgn * r * 0.62, r * 0.2, 0, TAU); g.fill(); // румянец
    }
    // очки «кошачий глаз» (владелец 11.10): тонкая золотисто-оранжевая оправа с приподнятыми уголками, линзы с лёгким тоном — глаза видно
    g.save(); g.translate(hx + ca * r * 0.3, hy + sa * r * 0.3); g.rotate(a);
    const lr = r * 0.44, gap = r * 0.47;
    for (const sgn of [-1, 1]) {
      const cy = sgn * gap;
      g.beginPath(); g.moveTo(-lr * 0.8, cy - sgn * lr * 0.05);
      g.quadraticCurveTo(-lr * 0.9, cy + sgn * lr * 1.05, lr * 0.1, cy + sgn * lr * 1.25); // внешний угол поднят — «кошачий»
      g.quadraticCurveTo(lr * 0.95, cy + sgn * lr * 0.9, lr * 0.75, cy - sgn * lr * 0.2);
      g.quadraticCurveTo(lr * 0.1, cy - sgn * lr * 0.75, -lr * 0.8, cy - sgn * lr * 0.05); g.closePath();
      const tint = g.createLinearGradient(-lr, 0, lr, 0); tint.addColorStop(0, 'rgba(120, 60, 20, 0.18)'); tint.addColorStop(1, 'rgba(255, 140, 40, 0.30)');
      g.fillStyle = tint; g.fill();
      g.lineWidth = Math.max(1.2, r * 0.09); g.strokeStyle = '#e07a10'; g.stroke();
      g.lineWidth = Math.max(0.6, r * 0.035); g.strokeStyle = '#ffd27a'; g.stroke(); // золотая кромка
      g.fillStyle = 'rgba(255,255,255,0.55)'; g.beginPath(); g.ellipse(lr * 0.25, cy - sgn * lr * 0.05 - lr * 0.15, lr * 0.22, lr * 0.07, -0.5, 0, TAU); g.fill(); // блик
      g.fillStyle = '#ffd52e'; g.beginPath(); g.arc(lr * 0.15, cy + sgn * lr * 1.2, Math.max(0.8, r * 0.06), 0, TAU); g.fill(); // стразик в уголке
    }
    g.strokeStyle = '#e07a10'; g.lineWidth = Math.max(1, r * 0.08); g.beginPath(); g.moveTo(lr * 0.2, -gap + lr * 0.55); g.quadraticCurveTo(lr * 0.55, 0, lr * 0.2, gap - lr * 0.55); g.stroke(); // перемычка
    g.restore();
    // губки впереди, поперёк морды
    g.save(); g.translate(hx + ca * r * 0.74, hy + sa * r * 0.74); g.rotate(a + Math.PI / 2);
    const lw = r * 0.32, lh = r * 0.14; // губки крупнее и ближе к глазам — видно на маленькой змее
    g.fillStyle = '#ff7a1a'; g.beginPath(); g.moveTo(-lw, 0); g.quadraticCurveTo(-lw * 0.5, -lh * 1.4, 0, -lh * 0.5); g.quadraticCurveTo(lw * 0.5, -lh * 1.4, lw, 0); g.quadraticCurveTo(0, lh * 1.6, -lw, 0); g.closePath(); g.fill();
    g.strokeStyle = '#b84f00'; g.lineWidth = Math.max(0.8, r * 0.03); g.beginPath(); g.moveTo(-lw * 0.9, 0); g.lineTo(lw * 0.9, 0); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.6)'; g.beginPath(); g.ellipse(-lw * 0.3, lh * 0.5, lw * 0.18, lh * 0.25, 0, 0, TAU); g.fill();
    g.restore();
  } else if (sk.eyes === 'eye') { // «Всевидящее око»: золотой треугольник с глазом, мягкое сияние
    const R2 = r * 1.05, cx = hx + ca * r * 0.12, cy = hy + sa * r * 0.12;
    g.save(); g.translate(cx, cy); g.rotate(a + Math.PI / 2);
    g.shadowColor = '#ffd52e'; g.shadowBlur = r * 0.8;
    g.beginPath(); g.moveTo(0, -R2); g.lineTo(R2 * 0.92, R2 * 0.62); g.lineTo(-R2 * 0.92, R2 * 0.62); g.closePath();
    g.fillStyle = 'rgba(40, 20, 70, 0.9)'; g.fill(); g.shadowBlur = 0;
    g.lineWidth = Math.max(1.2, r * 0.12); g.strokeStyle = '#ffd52e'; g.lineJoin = 'round'; g.stroke();
    g.restore();
    const ew = r * 0.52, eh = r * 0.3, ex = cx + ca * r * 0.06, ey = cy + sa * r * 0.06; // глаз-«миндаль» поперёк головы
    g.save(); g.translate(ex, ey); g.rotate(a + Math.PI / 2);
    g.beginPath(); g.moveTo(-ew, 0); g.quadraticCurveTo(0, -eh * 1.6, ew, 0); g.quadraticCurveTo(0, eh * 1.6, -ew, 0); g.closePath();
    g.fillStyle = '#fff8dc'; g.fill(); g.lineWidth = Math.max(1, r * 0.06); g.strokeStyle = '#ffd52e'; g.stroke();
    g.restore();
    const ox = ex + cl * r * 0.12, oy = ey + sl * r * 0.12;
    g.fillStyle = '#d99a00'; g.beginPath(); g.arc(ox, oy, r * 0.2, 0, TAU); g.fill();
    g.fillStyle = '#111111'; g.beginPath(); g.arc(ox, oy, r * 0.1, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.9)'; g.beginPath(); g.arc(ox - r * 0.05, oy - r * 0.05, r * 0.04, 0, TAU); g.fill();
  } else if (sk.eyes === 'cyclops') {
    eye(hx + ca * r * 0.15, hy + sa * r * 0.15, r * 0.66, '#2a7fff');
  } else if (sk.eyes === 'antenna') {
    // Как в оригинале: тонкие тёмные усики, на концах крупные глаза
    const bx = hx + ca * r * 0.75, by = hy + sa * r * 0.75; // усики растут из одной точки на носу — буквой «Y»
    for (const sgn of [-1, 1]) {
      const tx = hx + ca * r * 2.0 + px * sgn * r * 0.62, ty = hy + sa * r * 2.0 + py * sgn * r * 0.62;
      g.strokeStyle = shade(sk.cols[0], -45); g.lineWidth = Math.max(1.5, r * 0.12); g.lineCap = 'round';
      g.beginPath(); g.moveTo(bx, by); g.lineTo(tx, ty); g.stroke();
    }
    for (const sgn of [-1, 1]) eye(hx + ca * r * 2.0 + px * sgn * r * 0.62, hy + sa * r * 2.0 + py * sgn * r * 0.62, r * 0.42);
  } else {
    if (sk.shades) { // круглые очки-авиаторы в чёрной оправе (золото сливалось с оранжевым) (особый скин «Альмано»)
      g.save(); g.translate(hx + ca * r * 0.3, hy + sa * r * 0.3); g.rotate(a);
      const lr = r * 0.4, gap = r * 0.56; // радиус линзы и расстояние от центра
      g.strokeStyle = '#111111'; g.lineCap = 'round'; g.lineWidth = r * 0.1;
      for (const sgn of [-1, 1]) { // дужки по бокам головы
        g.beginPath(); g.moveTo(-lr * 0.2, sgn * (gap + lr * 0.85)); g.quadraticCurveTo(-r * 0.6, sgn * (gap + lr * 1.05), -r * 1.05, sgn * (gap + lr * 0.7)); g.stroke();
      }
      for (const sgn of [-1, 1]) {
        const cy = sgn * gap;
        const gr = g.createRadialGradient(-lr * 0.3, cy - lr * 0.3, lr * 0.1, 0, cy, lr);
        gr.addColorStop(0, '#3a3a44'); gr.addColorStop(1, '#050507');
        g.fillStyle = gr; g.beginPath(); g.ellipse(0, cy, lr * 0.92, lr, 0, 0, TAU); g.fill();
        g.lineWidth = r * 0.11; g.strokeStyle = '#111111'; g.stroke();
        g.fillStyle = 'rgba(255,255,255,0.6)'; g.beginPath(); g.ellipse(lr * 0.25, cy - lr * 0.35, lr * 0.28, lr * 0.13, -0.6, 0, TAU); g.fill(); // блик
      }
      g.strokeStyle = '#111111'; g.lineWidth = r * 0.1; g.lineCap = 'round';
      g.lineWidth = r * 0.13; g.beginPath(); g.moveTo(lr * 0.1, -gap + lr * 0.9); g.quadraticCurveTo(lr * 0.55, 0, lr * 0.1, gap - lr * 0.9); g.stroke(); // перемычка
      g.restore();
    } else
    for (const sgn of [-1, 1]) eye(hx + ca * r * 0.32 + px * sgn * r * 0.48, hy + sa * r * 0.32 + py * sgn * r * 0.48, r * 0.42);
  }
}

// ===== Фон: крупные тёмно-синие объёмные соты, как в оригинале =====
let bgPattern = null, bgTileURL = '', bgTileSize = '';
// Владелец 11.10: на телефоне — тёмно-графитовые соты, как в оригинальной slither.io (было синее); яркость +15% добавится при «запекании» (BRIGHT)
const BG = isTouch ? { floor: '#0f1012', top: '#303339', bot: '#202226' } : { floor: '#0b1018', top: '#1e2a3d', bot: '#141c2a' };
function makeBg() {
  // Владелец 06.10: соты чёткие — плитку рисуем в 4 раза детальнее и уменьшаем при заливке (раньше 50×87 точек растягивались)
  const s = 29, w = s * Math.sqrt(3), h = s * 3, K = 4;
  const c = document.createElement('canvas'); c.width = Math.round(w * K); c.height = Math.round(h * K);
  const g = c.getContext('2d');
  const kx = c.width / w, ky = c.height / h;
  g.scale(kx, ky);
  g.fillStyle = BG.floor; g.fillRect(0, 0, w, h);
  const hex = (cx, cy) => {
    const path = rr => { g.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); } g.closePath(); };
    path(s - 7); // широкие промежутки между сотами, как в оригинале
    const gr = g.createLinearGradient(cx, cy - s, cx, cy + s); gr.addColorStop(0, BG.top); gr.addColorStop(1, BG.bot);
    g.fillStyle = gr; g.fill();
    g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,0.04)'; g.stroke();
  };
  for (const [x, y] of [[0, 0], [w, 0], [w / 2, h / 2], [0, h], [w, h]]) hex(x, y);
  bgPattern = ctx.createPattern(brighten(c), 'repeat');
  if (bgPattern.setTransform) bgPattern.setTransform(new DOMMatrix().scaleSelf(1 / kx, 1 / ky));
  try { bgTileURL = c.toDataURL(); bgTileSize = `${w.toFixed(2)}px ${h.toFixed(2)}px`; } catch (e) {}
}

// ===== Фото владельца по всей игре (владелец 06.10): слайд-шоу в меню, постеры на карте, портрет Дона =====
// Владелец 07.10: убраны машина, PREMIUM, «11 uz», парень с роботом; остальные — в исходном качестве
// 07.10: +15 фото в стиле мафии (p14–p28)
const PHOTO_LIST = [2, 3, 5, 6, 7, 9, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28], PHOTO_DON = 7, PHOTO_CENTER = 2;
// Постер для карты: фото распаковывается и уменьшается В ФОНЕ (createImageBitmap), а не посреди кадра.
// Раньше телефон распаковывал фото 1280 px прямо в игре — экран замирал до 0,8 с у каждого постера.
const photoBmp = [];
function photo(i) {
  if (photoBmp[i] === undefined) {
    photoBmp[i] = null;
    const im = new Image(); im.src = (isTouch ? 'photos/m/p' : 'photos/p') + i + '.jpg'; // на телефоне — лёгкая копия (640 px)
    const H = isTouch ? 640 : 1100;
    im.decode().then(() => (window.createImageBitmap ? createImageBitmap(im, { resizeHeight: Math.min(H, im.naturalHeight), resizeQuality: 'medium' }) : im))
      .then(bmp => { photoBmp[i] = brighten(bmp); }).catch(() => {});
  }
  return photoBmp[i];
}
// Постеры на полу карты: в центре — фото в смокинге, остальные по кругу
const POSTERS = (() => {
  const list = [{ i: PHOTO_CENTER, x: 0, y: 0, h: 1300 }];
  const others = PHOTO_LIST.filter(i => i !== PHOTO_CENTER);
  // три кольца вокруг центра, чтобы постеры были по всей карте и не налезали друг на друга
  const rings = [1900, 2900, 4000], offs = [0.3, 0.6, 0.5]; // подобрано так, чтобы постеры не налезали друг на друга (с зазором)
  others.forEach((pi, k) => { const ring = k % 3, inRing = others.filter((_, j) => j % 3 === ring).length, a = Math.floor(k / 3) / inRing * TAU + offs[ring], d = rings[ring];
    list.push({ i: pi, x: Math.cos(a) * d, y: Math.sin(a) * d, h: 900 }); });
  return list;
})();
function drawPosters(view) {
  for (const p of POSTERS) {
    // фото грузим, только когда постер рядом (чтобы телефон не качал сразу все)
    const near = 1500, hh = p.h;
    if (p.x - hh > view.x1 + near || p.x + hh < view.x0 - near || p.y - hh > view.y1 + near || p.y + hh < view.y0 - near) continue;
    const im = photo(p.i); if (!im) continue;
    const h = p.h, w = h * im.width / im.height, x0 = p.x - w / 2, y0 = p.y - h / 2;
    if (x0 > view.x1 || x0 + w < view.x0 || y0 > view.y1 || y0 + h < view.y0) continue;
    ctx.save(); // как оригинал: без прозрачности
    ctx.drawImage(im, x0, y0, w, h);
    ctx.globalAlpha = 0.8; ctx.lineWidth = 10; ctx.strokeStyle = p.i === PHOTO_CENTER ? '#ffd52e' : 'rgba(255,255,255,0.35)';
    ctx.strokeRect(x0, y0, w, h);
    ctx.restore();
  }
}

// ===== Сеть =====
let ws = null, connected = false, myId = 0, alive = false, autoJoined = false;
const metas = new Map();     // id -> {name, sk, bot}
const snaps = [];            // последние снимки мира
const foods = new Map();     // id -> {x,y,r,col,ph}
const foodQueue = [];        // события еды ждут своего момента, чтобы совпасть с картинкой
const eatAnims = [];
const lastHeads = new Map(); // id -> {x,y} где голова нарисована сейчас
let tickOffset = null;       // сдвиг серверного времени относительно нашего
let lb = null, pingMs = 0;
let myMass = 0, shownMass = -1;
// ===== Командный режим (владелец 07.10): ?mode=team — арена «Мирные (белые) против Мафии (чёрно-оранжевые)», ?team=0/1 — сразу в команду друга =====
const QS = new URLSearchParams(location.search);
// Владелец 07.10: командная игра: выключалась 07.10 из-за лагов на бесплатном сервере, включена снова после перехода на Starter (0,5 CPU). Выключить: TEAM_ENABLED = false здесь и в server.js
const TEAM_ENABLED = true;
if (QS.get('mode') === 'team' && !TEAM_ENABLED) location.replace(location.pathname); // старая ссылка на команды — в обычную игру
const TEAM_MODE = TEAM_ENABLED && QS.get('mode') === 'team';
const TEAM_COL = ['#f2f2f2', '#ff8a1f'], TEAM_NAME = ['Мирные', 'Мафия'], TEAM_ICON = ['⚪', '🟠'];
const TEAM_PLATE = [['#f4f5f7', '#1a1d24', 'rgba(30,40,60,0.45)'], ['#1c1c1e', '#ff8a1f', '#ff8a1f']]; // фон, текст, рамка таблички
const orbs = new Map(); // светящиеся шары командного режима: id -> {x, y, px, py, t}
const rocketsFly = new Map(), booms = []; let bazooka = new Map(), myRockets = 0;
let bombIds = new Map(), myBomb = 0; const bombsFly = new Map(); // bombIds: id → сколько бомб едет рядом;
let knifeIds = new Set(), myKnife = false; const knivesFly = new Map(), knifeSparks = []; // кинжал Киллера (владелец 11.10) // бомба Бомбы (владелец 11.10): у кого едет рядом, брошенные // базука: ракеты в полёте, взрывы, у кого сколько выстрелов
const baseFireUntil = [0, 0]; // база сияет после доставки знамени
let havanaIds = new Set(); // кто довёз знамя — с сигарой «Гавана»
let BASES = null, BASE_R = 300, teamFlags = [], hotIds = new Set(), teamAlarms = [], finalMinute = false, lastBeat = -1;
let myTeam = -1, teamChoice = QS.get('team') === '0' ? 0 : QS.get('team') === '1' ? 1 : 'auto', teamTm = null, rejoinAfterRound = false;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws${TEAM_MODE ? '-team' : ''}`);
  ws.binaryType = 'arraybuffer';
  setStatus('Подключение к серверу…');
  ws.onopen = () => {
    connected = true; sendView();
  };
  ws.onclose = () => {
    connected = false; $('play').disabled = true;
    if (alive) { alive = false; myId = 0; showMenu(null); }
    snaps.length = 0; foods.clear(); foodQueue.length = 0; metas.clear(); tickOffset = null;
    setStatus('Связь потеряна, переподключаюсь…');
    setTimeout(connect, 1500);
  };
  ws.onerror = () => {};
  ws.onmessage = e => {
    try {
      if (typeof e.data === 'string') onJSON(JSON.parse(e.data));
      else if (protoOk) onState(e.data);
    } catch (err) { console.error('Ошибка разбора данных сервера', err); }
  };
}
function sendJSON(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function sendView() { sendJSON({ t: 'view', w: W, h: H }); }
function setStatus(s) { $('status').textContent = s; }

function onJSON(m) {
  switch (m.t) {
    case 'hello':
      MAP_R = m.mapR; TICK_RATE = m.tickRate; SEG_D = m.segD; FCELL = m.fcell;
      if (m.bases) { BASES = m.bases; BASE_R = m.baseR; }
      protoOk = m.proto === PROTO;
      if (protoOk) {
        $('play').disabled = false; setStatus(''); $('status').style.color = ''; // владелец 06.10: без лишних надписей
        // Ссылка вида ?name=Вася сразу пускает в игру
        const q = new URLSearchParams(location.search).get('name');
        if (q && !autoJoined) { autoJoined = true; $('nick').value = q.slice(0, 16); play(); }
      }
      if (!protoOk) { $('play').disabled = true; setStatus('⚠ Сервер устарел — закройте чёрное окно сервера и запустите start заново'); $('status').style.color = '#ff7070'; }
      break;
    case 'meta': for (const [id, name, skid, c1, c2, c3, bot, pat, role, team] of m.list) metas.set(id, { name, sk: prepSkin({ id: skid, c1, c2, c3, pat: pat || null }), bot, role: role || 0, team: team == null ? -1 : team }); break;
    case 'roundEnd': onRoundEnd(m); break;
    case 'orbs': { const now = performance.now(); for (const e of m.o) { let o = orbs.get(e[0]); if (e.length < 2) { orbs.delete(e[0]); continue; }
      if (!o) { o = { x: e[1], y: e[2], px: e[1], py: e[2], t: now }; orbs.set(e[0], o); } else { o.px = o.x; o.py = o.y; o.x = e[1]; o.y = e[2]; o.t = now; } }
      if (m.f) teamFlags = m.f; hotIds = new Set(m.h || []); havanaIds = new Set(m.c || []); bazooka = new Map(m.z || []);
      bombIds = new Map(m.b || []); knifeIds = new Set(m.kn || []);
      { const n = alive ? bazooka.get(myId) || 0 : 0, mb = alive ? bombIds.get(myId) || 0 : 0, mk = alive && knifeIds.has(myId); if (n !== myRockets || mb !== myBomb || mk !== myKnife) { myRockets = n; myBomb = mb; myKnife = mk; renderFireBtn(); } } teamAlarms = m.a || []; break; }
    case 'knife': knivesFly.set(m.id, { x: m.x, y: m.y, vx: m.vx * TICK_RATE / 1000, vy: m.vy * TICK_RATE / 1000, t0: performance.now(), life: m.life }); knifeIds.delete(m.o); if (m.o === myId) { myKnife = false; renderFireBtn(); } Sound.knifeThrow(nearVol(m.x, m.y)); break;
    case 'knifeHit': { const now = performance.now(); for (let i = 0; i < 18; i++) { const an = Math.random() * TAU, sp = 0.15 + Math.random() * 0.45; knifeSparks.push({ x: m.x, y: m.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp, t0: now }); } Sound.knifeHit(nearVol(m.x, m.y)); if (m.o === myId) shakeUntil = now + 250; break; }
    case 'knifeEnd': knivesFly.delete(m.id); break;
    case 'bomb': bombsFly.set(m.id, { x0: m.x0, y0: m.y0, x: m.x, y: m.y, t0: performance.now(), fly: m.fly, fuse: m.fuse }); { const left = (bombIds.get(m.o) || 1) - 1; if (left > 0) bombIds.set(m.o, left); else bombIds.delete(m.o); if (m.o === myId) { myBomb = left; renderFireBtn(); } } Sound.click(); break;
    case 'bombBoom': bombsFly.delete(m.id); booms.push({ x: m.x, y: m.y, t0: performance.now(), big: 1, mine: m.o === myId && m.hit > 0, parts: makeDebris() }); Sound.boom(nearVol(m.x, m.y));
      if (lastHeads.has(myId) && Math.hypot(lastHeads.get(myId).x - m.x, lastHeads.get(myId).y - m.y) < 900) shakeUntil = performance.now() + 500; break;
    case 'tmsg': bigToast(m.text); Sound.alert(); break;
    case 'final': finalMinute = true; break;
    case 'rocket': rocketsFly.set(m.id, { x: m.x, y: m.y, vx: m.vx * TICK_RATE / 1000, vy: m.vy * TICK_RATE / 1000, t0: performance.now(), life: m.life }); Sound.rocket(nearVol(m.x, m.y)); break;
    case 'boom': rocketsFly.delete(m.id); booms.push({ x: m.x, y: m.y, t0: performance.now(), big: m.hit, mine: m.o === myId, parts: m.hit ? makeDebris() : null }); if (!m.hit) Sound.boom(nearVol(m.x, m.y) * 0.4); /* промах — граната рвётся в конце полёта, тише */ if (m.hit) { Sound.boom(nearVol(m.x, m.y)); if (m.o === myId) shakeUntil = performance.now() + 450; } break;
    case 'portal': portalFx.push({ x: m.f[0], y: m.f[1], t0: performance.now() }, { x: m.d[0], y: m.d[1], t0: performance.now() + 120 }); Sound.portal(Math.max(nearVol(m.f[0], m.f[1]), nearVol(m.d[0], m.d[1]))); break;
    case 'docSave': docGhost.set(m.id, performance.now() + m.ms); break;
    case 'tmsgMe': bigToast(m.text); Sound.alert(); break;
    case 'baseFire': baseFireUntil[m.team] = performance.now() + 25000; break;
    case 'orbEat': toast('✨ Поймали светящийся шар! +' + m.v); Sound.kill(); break;
    case 'roundStart': finalMinute = false; $('roundBanner').classList.add('hide'); if (rejoinAfterRound) { rejoinAfterRound = false; play(); } break;
    case 'role': showPromo(m.r); break;
    case 'don': toast('👑 ' + m.name + ' — новый Дон Мафии!'); break;
    case 'spawn': myRockets = 0; myBomb = 0; myKnife = false; renderFireBtn(); if (TEAM_MODE) { myTeam = m.team; if (window.VoiceChat) VoiceChat.setRoom('TEAM' + m.team); }
      myId = m.id; alive = true; predStop(); hideMenu(); Sound.spawn(); dropNsfw(); wpPanelClose(); break;
    case 'dead': alive = false; myId = 0; predStop(); Sound.death(); setTimeout(() => showMenu(m), 1300); break;
    case 'kill': toast('Вы убили: ' + m.name); Sound.kill(); break;
    case 'lb': {
      const prevEv = evNow ? evNow[0] : null;
      lb = m; if (m.vis) visData = m.vis; if (m.mm) mmLines = m.mm; if (m.tm) { teamTm = m.tm; renderTeamBar(); } if (m.rec) { recData = m.rec; renderRecords(); }
      evNow = m.ev || null; evAt = performance.now();
      if (evNow && evNow[0] !== prevEv) toast(evNow[0] === 'night' ? '🌙 Ночь мафии! Видно только рядом с собой' : '✨ Золотая еда · смотри на миникарту', 'ev'); // владелец 07.10: мельче и красивым шрифтом
      renderEvent(); renderLb(); break;
    }
    case 'record': showRecord(m.kind); break;
    case 'pong': pingMs = Math.round(performance.now() - m.c); break;
  }
}
setInterval(() => sendJSON({ t: 'ping', c: performance.now() }), 2000);

function onState(buf) {
  const dv = new DataView(buf);
  let o = 1;
  const tick = dv.getUint32(o, true); o += 4;
  const vx = dv.getFloat32(o, true); o += 4;
  const vy = dv.getFloat32(o, true); o += 4;
  const ns = dv.getUint16(o, true); o += 2;
  const sn = new Map();
  for (let k = 0; k < ns; k++) {
    const id = dv.getUint16(o, true); o += 2;
    const flags = dv.getUint8(o++);
    const a = dv.getUint8(o++) / 256 * TAU - Math.PI;
    const mass = dv.getUint16(o, true); o += 2;
    const r = dv.getUint8(o++) / 4;
    const step = dv.getUint8(o++);
    const len = dv.getUint16(o, true); o += 2;
    const nr = dv.getUint16(o, true); o += 2;
    const idx = [], xs = [], ys = [], gap = [];
    let last = -1e9;
    for (let q = 0; q < nr; q++) {
      const start = dv.getUint16(o, true); o += 2;
      const cnt = dv.getUint16(o, true); o += 2;
      for (let j = 0; j < cnt; j++) {
        const i = start + j * step;
        gap.push(idx.length > 0 && i - last > step);
        idx.push(i); last = i;
        xs.push(dv.getInt16(o, true) / 4); o += 2;
        ys.push(dv.getInt16(o, true) / 4); o += 2;
      }
    }
    sn.set(id, { id, boost: flags & 1, a, mass, r, step, len, idx, xs, ys, gap });
  }
  const ev = { tick, add: [], rem: [], drop: [] };
  const nA = dv.getUint16(o, true); o += 2;
  for (let i = 0; i < nA; i++) {
    const id = dv.getUint32(o, true); o += 4;
    const x = dv.getInt16(o, true) / 4; o += 2;
    const y = dv.getInt16(o, true) / 4; o += 2;
    const r = dv.getUint8(o++) / 4;
    const col = c565(dv.getUint16(o, true)); o += 2;
    ev.add.push({ id, x, y, r, col, ph: Math.random() * TAU });
  }
  const nR = dv.getUint16(o, true); o += 2;
  for (let i = 0; i < nR; i++) { const id = dv.getUint32(o, true); o += 4; const eater = dv.getUint16(o, true); o += 2; ev.rem.push(id, eater); }
  const nD = dv.getUint16(o, true); o += 2;
  for (let i = 0; i < nD; i++) { ev.drop.push(dv.getUint16(o, true)); o += 2; }
  ev.dead = [];
  const nK = dv.getUint16(o, true); o += 2;
  for (let i = 0; i < nK; i++) { ev.dead.push(dv.getUint16(o, true)); o += 2; }
  foodQueue.push(ev);
  // Вкладка в фоне (переключились в Telegram) — кадры не рисуются, и события еды копились тысячами (30 в секунду);
  // при возврате они разом разбирались в одном кадре и игра замирала. Теперь очередь не длиннее 3 секунд.
  if (foodQueue.length > 90) applyFood(foodQueue[foodQueue.length - 90].tick);

  // Оцениваем «серверное время»: быстро догоняем, медленно отстаём — так рывки сети не дёргают картинку
  const est = tick - performance.now() / (1000 / TICK_RATE);
  if (tickOffset === null || est > tickOffset) tickOffset = est;
  else tickOffset += (est - tickOffset) * 0.02;
  const nowA = performance.now();
  if (lastArrive) {
    // Владелец 07.10: запас плавности больше — помним паузы связи за 10 с (а не 3), берём 98-й процент, +2 кадра, от 4 до 12 кадров
    gaps.push(nowA - lastArrive); if (gaps.length > 300) gaps.shift();
    if (gaps.length >= 20 && ++gapsN % 15 === 0) { // пересчёт раз в полсекунды, а не на каждое обновление
      const sorted = gaps.slice().sort((a, b) => a - b), p98 = sorted[Math.floor(sorted.length * 0.98)];
      interpWant = clamp(Math.ceil(p98 / (1000 / TICK_RATE)) + 2, 4, 12);
    }
  }
  netFrames++; if (lastArrive && nowA - lastArrive > 150) netJerks++;
  lastArrive = nowA;
  snaps.push({ tick, vx, vy, sn });
  while (snaps.length > 30) snaps.shift();
  const me = sn.get(myId);
  if (me) myMass = me.mass;
}

const fkey = (x, y) => ((Math.floor(x / FCELL) + 64) << 8) | (Math.floor(y / FCELL) + 64);
function applyFood(upTo) {
  while (foodQueue.length && foodQueue[0].tick <= upTo) {
    const ev = foodQueue.shift();
    for (const f of ev.add) foods.set(f.id, f);
    for (let i = 0; i < ev.rem.length; i += 2) {
      const f = foods.get(ev.rem[i]); if (!f) continue;
      foods.delete(f.id);
      if (ev.rem[i + 1] && !document.hidden) eatAnims.push({ f, eater: ev.rem[i + 1], t0: performance.now() });
      // звук поедания выключен (владелец 06.10)
    }
    if (ev.drop.length) {
      const dropSet = new Set(ev.drop);
      for (const f of foods.values()) if (dropSet.has(fkey(f.x, f.y))) foods.delete(f.id);
    }
    for (const id of ev.dead) { // змея погибла — её тело красиво тает
      const sn = lastDrawn.get(id);
      if (sn && !document.hidden) dying.push({ sn, meta: metas.get(id), t0: performance.now() });
    }
  }
}

// Плавная картинка: смешиваем два соседних снимка
function findIdx(arr, v) {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1, x = arr[m]; if (x === v) return m; if (x < v) lo = m + 1; else hi = m - 1; }
  return -1;
}
function interpolated(renderTick) {
  if (!snaps.length) return null;
  let A = snaps[0], B = snaps[0];
  if (renderTick >= snaps[snaps.length - 1].tick) { A = B = snaps[snaps.length - 1]; }
  else {
    for (let i = snaps.length - 1; i > 0; i--) {
      if (snaps[i - 1].tick <= renderTick) { A = snaps[i - 1]; B = snaps[i]; break; }
    }
  }
  const t = B.tick > A.tick ? clamp((renderTick - A.tick) / (B.tick - A.tick), 0, 1) : 1;
  const out = [];
  for (const b of B.sn.values()) {
    const a = A.sn.get(b.id);
    const n = b.idx.length, xs = new Array(n), ys = new Array(n);
    const jumped = a && a !== b && a.xs.length && b.xs.length && Math.abs(a.xs[0] - b.xs[0]) + Math.abs(a.ys[0] - b.ys[0]) > 300; // прошла потайным ходом
    if (a && a !== b && !jumped) {
      for (let j = 0; j < n; j++) {
        const k = findIdx(a.idx, b.idx[j]);
        if (k >= 0 && Math.abs(b.xs[j] - a.xs[k]) + Math.abs(b.ys[j] - a.ys[k]) < 200) { xs[j] = a.xs[k] + (b.xs[j] - a.xs[k]) * t; ys[j] = a.ys[k] + (b.ys[j] - a.ys[k]) * t; } // точка прошла нору — без пролёта
        else { xs[j] = b.xs[j]; ys[j] = b.ys[j]; }
      }
    } else { for (let j = 0; j < n; j++) { xs[j] = b.xs[j]; ys[j] = b.ys[j]; } }
    out.push({
      id: b.id, boost: b.boost, mass: b.mass, len: b.len, idx: b.idx, gap: b.gap, xs, ys,
      r: a ? a.r + (b.r - a.r) * t : b.r,
      a: a ? a.a + angDiff(a.a, b.a) * t : b.a,
    });
  }
  return { list: out, vx: A.vx + (B.vx - A.vx) * t, vy: A.vy + (B.vy - A.vy) * t };
}

// ===== Управление =====
let inAngle = 0, inBoost = false, mouseBoost = false, keyBoost = false, btnBoost = false;
let lastSentA = 99, lastSentB = null, lastSentT = 0;
// Направление считаем от головы змеи на экране (камера смотрит вперёд, голова не в центре)
function setAngleFrom(x, y) { const dx = x - (W / 2 - look.x * cam.s), dy = y - (H / 2 - look.y * cam.s); if (dx * dx + dy * dy > 64) inAngle = Math.atan2(dy, dx); }
function sendInput() {
  if (!alive || !ws || ws.readyState !== 1) return;
  inBoost = mouseBoost || keyBoost || btnBoost;
  const now = performance.now();
  if (now - lastSentT < 33) return;
  if (Math.abs(angDiff(lastSentA, inAngle)) < 0.008 && lastSentB === inBoost && now - lastSentT < 500) return;
  const q = Math.round((inAngle + Math.PI) / TAU * 65535) & 65535;
  ws.send(new Uint8Array([1, q & 255, q >> 8, inBoost ? 1 : 0]));
  lastSentA = inAngle; lastSentB = inBoost; lastSentT = now;
}
// Телефон: «джойстик» — владелец 07.10: первый палец в ЛЮБОМ месте становится джойстиком прямо под ним (левша, правша — неважно),
// второй палец в любом месте — ускорение, пока держите. «Палец» — змейка ползёт к месту касания, ⚡ слева.
// Выбор хранится под новым именем mm_ctrl2: у всех, у кого застрял режим «палец», снова джойстик.
// Владелец 11.10: управление на телефоне — всегда джойстик, автоматически. Кнопку «Управление» убрали, а у кого был сохранён
// режим «палец», вернуть джойстик было нечем — поэтому сохранённый выбор больше не читаем.
let ctrlMode = 'joy';
const JOY_R = 56;
const look = { x: 0, y: 0 }; // сдвиг камеры вперёд по ходу змеи
let steerId = null, joy = null, boostId = null;
const joyEl = $('joy'), knobEl = $('joyKnob'), bb = $('boostBtn');
function showJoy(x, y) { joyEl.style.left = x + 'px'; joyEl.style.top = y + 'px'; knobEl.style.transform = 'translate(-50%, -50%)'; joyEl.classList.remove('hide'); }
function moveJoy(x, y) {
  let dx = x - joy.x0, dy = y - joy.y0;
  const d = Math.hypot(dx, dy);
  if (d > 8) inAngle = Math.atan2(dy, dx);
  if (d > JOY_R) { dx *= JOY_R / d; dy *= JOY_R / d; }
  knobEl.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
}
const boostOn = id => { boostId = id; btnBoost = true; bb.classList.add('on'); };
const bbOff = () => { boostId = null; btnBoost = false; bb.classList.remove('on'); };
canvas.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'mouse' && alive && !document.fullscreenElement) goFullscreen();
  if (e.pointerType === 'mouse') { setAngleFrom(e.clientX, e.clientY); if (e.button === 2 && (myRockets > 0 || myBomb || myKnife)) { fire(); return; } if (e.button === 0 || e.button === 2) mouseBoost = true; return; } // правая кнопка: есть ракеты — выстрел
  if (ctrlMode === 'joy') {
    if (!joy) { joy = { id: e.pointerId, x0: e.clientX, y0: e.clientY }; showJoy(e.clientX, e.clientY); } // первый палец — джойстик под ним
    else if (boostId === null) boostOn(e.pointerId); // второй палец — ускорение
    return;
  }
  if (steerId === null) { steerId = e.pointerId; setAngleFrom(e.clientX, e.clientY); }
});
window.addEventListener('pointermove', e => {
  if (e.pointerType === 'mouse') setAngleFrom(e.clientX, e.clientY);
  else if (joy && e.pointerId === joy.id) moveJoy(e.clientX, e.clientY);
  else if (e.pointerId === steerId) setAngleFrom(e.clientX, e.clientY);
});
const endPointer = e => {
  if (e.pointerType === 'mouse') mouseBoost = false;
  if (e.pointerId === steerId) steerId = null;
  if (joy && e.pointerId === joy.id) { joy = null; joyEl.classList.add('hide'); }
  if (e.pointerId === boostId) bbOff();
};
window.addEventListener('pointerup', endPointer);
window.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', e => e.preventDefault());
// Клавиатура: стрелки / WASD — змейка ползёт в нажатую сторону (две клавиши — диагональ), пробел — ускорение
const KEY_DIR = { ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] };
const keysDown = new Set();
function keyAngle() {
  let x = 0, y = 0;
  for (const k of keysDown) { x += KEY_DIR[k][0]; y += KEY_DIR[k][1]; }
  if (x || y) inAngle = Math.atan2(y, x);
}
window.addEventListener('keydown', e => {
  if (!alive) return;
  if (e.code === 'Space') { keyBoost = true; e.preventDefault(); }
  else if (KEY_DIR[e.code]) { keysDown.add(e.code); keyAngle(); e.preventDefault(); }
});
window.addEventListener('keyup', e => {
  if (e.code === 'Space') keyBoost = false;
  else if (KEY_DIR[e.code]) { keysDown.delete(e.code); keyAngle(); }
});
window.addEventListener('blur', () => { mouseBoost = keyBoost = false; keysDown.clear(); bbOff(); });
// Кнопка ⚡ (в режиме «Палец» — настоящая кнопка; в режиме джойстика — подсказка, жмётся вся правая половина)
bb.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); boostOn(e.pointerId); bb.setPointerCapture(e.pointerId); });
bb.addEventListener('pointerup', bbOff); bb.addEventListener('pointercancel', bbOff); bb.addEventListener('lostpointercapture', bbOff);
function applyCtrlMode() {
  document.body.classList.toggle('ctrl-joy', ctrlMode === 'joy');
  const cb = $('ctrlBtn'); if (cb) cb.textContent = 'Управление: ' + (ctrlMode === 'joy' ? 'джойстик' : 'палец');
}

// ===== Мгновенный отклик своей змейки (предсказание, как в оригинале) =====
// Голова своей змейки считается прямо здесь по тем же формулам, что на сервере, — поворачивает сразу по пальцу/мышке.
// Сервер главный: с каждым его обновлением положение мягко подтягивается к настоящему; при большом расхождении — сразу встаёт на место.
// Тело тянется за головой по пройденному пути.
const MIN_BOOST = 12;
function turnRate(r) { const sc = r / 10, scang = 0.13 + 0.87 * Math.pow((7 - sc) / 6, 2); return 0.033 * ((1000 / TICK_RATE) / 8) * scang * 1.5; } // ×1.5 — как TURN_BOOST в server.js
function moveSpeed(r, boost) { return (boost ? 12 : 4.25 + 0.5 * (r / 10)) * 6 / 4.75; }
const pred = { on: false, x: 0, y: 0, a: 0, t: 0, trail: [] };
window.__mmHeading = () => pred.on ? ((pred.a * 180 / Math.PI) + 360) % 360 : NaN; // для проверки
window.__mmHeadScreen = () => ({ x: W / 2 - look.x * cam.s, y: H / 2 - look.y * cam.s }); // для проверки
function predStop() { pred.on = false; pred.trail.length = 0; }
function predStart(srv) {
  pred.on = true; pred.x = srv.xs[0]; pred.y = srv.ys[0]; pred.a = srv.a; pred.t = performance.now();
  pred.trail = [];
  for (let j = 0; j < srv.xs.length; j++) pred.trail.push([srv.xs[j], srv.ys[j]]);
}
// srv — своя змейка из самого свежего снимка сервера; возвращает змейку для рисования
const predStats = { frames: 0, snaps: 0, maxErr: 0, sumErr: 0 };
window.__mmPred = () => predStats; // для проверки расхождения с сервером
function predStep(srv) {
  const now = performance.now(), tickMs = 1000 / TICK_RATE;
  if (!pred.on) predStart(srv);
  const dt = Math.min(6, (now - pred.t) / tickMs); pred.t = now;
  const r = srv.r, boosting = inBoost && myMass >= MIN_BOOST;
  const tr = turnRate(r) * dt;
  pred.a += clamp(angDiff(pred.a, inAngle), -tr, tr);
  const spd = moveSpeed(r, boosting) * dt;
  pred.x += Math.cos(pred.a) * spd; pred.y += Math.sin(pred.a) * spd;
  // Где голова на сервере «сейчас»: свежий снимок + путь за время, пока он шёл к нам
  const lead = ((now - lastArrive) + pingMs) / tickMs;
  const sx = srv.xs[0] + Math.cos(srv.a) * moveSpeed(r, srv.boost) * lead;
  const sy = srv.ys[0] + Math.sin(srv.a) * moveSpeed(r, srv.boost) * lead;
  const ex = sx - pred.x, ey = sy - pred.y, err = Math.hypot(ex, ey);
  predStats.frames++; predStats.sumErr += err; if (err > predStats.maxErr) predStats.maxErr = err;
  if (err > 120) { predStats.snaps++; predStart(srv); pred.x = sx; pred.y = sy; }
  else { const k = Math.min(1, 0.06 * dt); pred.x += ex * k; pred.y += ey * k; }
  // След головы → тело нужной длины
  const tr0 = pred.trail[0];
  if (!tr0 || Math.hypot(pred.x - tr0[0], pred.y - tr0[1]) > 1.5) pred.trail.unshift([pred.x, pred.y]);
  else { tr0[0] = pred.x; tr0[1] = pred.y; }
  // Владелец 07.10 («змея проползла под другой»): по предсказанию рисуем только голову и шею — до места на следе, где сейчас
  // голова на сервере; дальше тело строго по данным сервера. Раньше всё тело шло по следу предсказания, и его ошибки
  // (замер при пинге 166 мс: в среднем 21, до 49 единиц вбок) оставались в теле — на экране оно пересекало чужих.
  const shx = srv.xs[0], shy = srv.ys[0];
  let D = 0, best = 1e9, accS = 0, cut = pred.trail.length;
  for (let j = 1; j < pred.trail.length; j++) {
    const [x0, y0] = pred.trail[j - 1], [x1, y1] = pred.trail[j];
    accS += Math.hypot(x1 - x0, y1 - y0);
    const d = Math.hypot(x1 - shx, y1 - shy); if (d < best) { best = d; D = accS; }
    if (accS > 900) { cut = j + 1; break; }
  }
  if (best > 150) D = 0; // след не совпадает с сервером (после перескока) — всё тело с сервера
  pred.D = pred.D == null ? D : pred.D + (D - pred.D) * 0.3; // сглаживаем, чтобы узор на теле не прыгал
  const Dk = Math.max(0, Math.min(srv.len - 1, Math.round(pred.D / SEG_D)));
  const idx = [0], xs = [pred.x], ys = [pred.y], gap = [false];
  // шея: точки следа через SEG_D до Dk, с плавной поправкой, чтобы последняя точка легла ровно на голову с сервера
  let acc = 0, nextAt = SEG_D, seg = 1;
  for (let j = 1; j < pred.trail.length && seg <= Dk; j++) {
    const [x0, y0] = pred.trail[j - 1], [x1, y1] = pred.trail[j];
    const L = Math.hypot(x1 - x0, y1 - y0);
    while (acc + L >= nextAt && seg <= Dk) { const f = L ? (nextAt - acc) / L : 0; idx.push(seg); xs.push(x0 + (x1 - x0) * f); ys.push(y0 + (y1 - y0) * f); gap.push(false); seg++; nextAt += SEG_D; }
    acc += L;
  }
  const last = xs.length - 1;
  if (last > 0) { const cx = shx - xs[last], cy = shy - ys[last]; for (let k = 1; k <= last; k++) { xs[k] += cx * k / last; ys[k] += cy * k / last; } }
  // тело: точки с сервера (без его головы), номера сдвинуты на длину шеи
  const off = last;
  for (let j = 1; j < srv.xs.length; j++) {
    const id = srv.idx[j] + off; if (id > srv.len - 1) break;
    idx.push(id); xs.push(srv.xs[j]); ys.push(srv.ys[j]); gap.push(srv.gap[j]);
  }
  pred.trail.length = Math.min(pred.trail.length, cut + 1);
  if (window.__mmTrailCheck) { // только для проверки: насколько нарисованное тело уходит вбок от настоящего (с сервера)
    let mx = 0, bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
    for (let j = 0; j < srv.xs.length; j++) { bx0 = Math.min(bx0, srv.xs[j]); bx1 = Math.max(bx1, srv.xs[j]); by0 = Math.min(by0, srv.ys[j]); by1 = Math.max(by1, srv.ys[j]); }
    for (let i = 40; i < xs.length; i += 5) {
      if (xs[i] < bx0 + 60 || xs[i] > bx1 - 60 || ys[i] < by0 + 60 || ys[i] > by1 - 60) continue; // сравниваем только там, где сервер прислал тело
      let best = 1e9; for (let j = 0; j < srv.xs.length; j++) { const d = Math.hypot(xs[i] - srv.xs[j], ys[i] - srv.ys[j]); if (d < best) best = d; }
      if (best < 1e8 && best > mx) mx = best;
    }
    const st = window.__mmTrailCheck; st.n++; if (mx > st.max) st.max = mx; st.sum += mx;
  }
  return { id: srv.id, boost: boosting, mass: srv.mass, len: srv.len, r, a: pred.a, idx, xs, ys, gap };
}

// ===== Роли: табличка на змее и поздравление =====
const ROLES = window.Roles.ROLES, DON = window.Roles.DON;
// Болтающаяся табличка на спине у всех ролей кроме Мирного (владелец 06.10). Висит на ниточке и качается:
// сильнее на поворотах и на ускорении (простой маятник на каждую змею).
const BACK_PLATE_MIN = 1; // владелец 06.10: табличка у всех ролей, кроме стартового «Мирного»
const SHORT = { 'Дон Мафии': 'ДОН' };
const swing = new Map(); // id → { ang, vel, lastA, t }
// ===== Быстрая отрисовка надписей (06.10, «игра подвисает»): текст рисуется ОДИН раз в маленькую картинку,
// дальше в каждом кадре только копируется — как шарики тела. Раньше текст табличек и надписей по телу
// заново растрировался каждый кадр у каждой змеи — это и тормозило телефоны.
const textCache = new Map();
const PX_PER_UNIT = () => Math.max(0.5, Math.round(cam.s * DPR * 4) / 4); // чёткость заготовки = масштабу экрана (с шагом 0.25)
function cacheCanvas(key, w, h, paint) {
  let c = textCache.get(key);
  if (!c) {
    if (textCache.size > 600) textCache.clear();
    c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
    paint(c.getContext('2d')); textCache.set(key, c);
  }
  return c;
}
// Табличка: фон в цвет змеи, рамка, 1–2 строки текста. Возвращает {img, w, h} в мировых единицах.
function plateSprite(ri, bodyCol, nick, s, team) {
  const R = ROLES[ri], k = PX_PER_UNIT(), sb = Math.round(s * 4) / 4, tm = team >= 0 ? team : -1;
  const key = 'pl|' + ri + '|' + nick + '|' + sb + '|' + k + '|' + tm;
  const label = tm >= 0 ? TEAM_NAME[tm].toUpperCase() : (R.icon ? R.icon + ' ' : '') + (SHORT[R.name] || R.name.toUpperCase());
  const fs = 11 * sb, fs2 = 10 * sb;
  const mctx = textMeasure; mctx.font = `bold ${fs}px Arial, sans-serif`;
  let w = mctx.measureText(label).width + 12 * sb;
  if (nick) { mctx.font = `bold ${fs2}px Arial, sans-serif`; w = Math.max(w, mctx.measureText(nick).width + 12 * sb); }
  const h = nick ? fs * 1.45 + fs2 * 1.35 : fs * 1.7, pad = 5 * sb;
  const img = cacheCanvas(key, (w + pad * 2) * k, (h + pad * 2) * k, g => {
    g.scale(k, k); g.translate(pad, pad);
    // Владелец 07.10: все таблички в одном стиле — светлая плашка, тонкая рамка, тёмный текст
    const bg = tm >= 0 ? TEAM_PLATE[tm][0] : '#f4f5f7', fg = tm >= 0 ? TEAM_PLATE[tm][1] : '#1a1d24', border = tm >= 0 ? TEAM_PLATE[tm][2] : 'rgba(30, 40, 60, 0.45)', rr = 4 * sb;
    g.beginPath(); g.moveTo(rr, 0); g.arcTo(w, 0, w, h, rr); g.arcTo(w, h, 0, h, rr); g.arcTo(0, h, 0, 0, rr); g.arcTo(0, 0, w, 0, rr); g.closePath();
    g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 4 * sb; g.shadowOffsetY = 1.5 * sb;
    g.fillStyle = bg; g.fill(); g.shadowBlur = 0; g.shadowOffsetY = 0;
    g.lineWidth = Math.max(1, 1.6 * sb); g.strokeStyle = border; g.stroke();
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    if (nick) {
      g.font = `bold ${fs}px Arial, sans-serif`; g.fillText(label, w / 2, fs * 0.82);
      g.font = `bold ${fs2}px Arial, sans-serif`; g.globalAlpha = 0.9; g.fillText(nick, w / 2, fs * 1.45 + fs2 * 0.6);
    } else { g.font = `bold ${fs}px Arial, sans-serif`; g.fillText(label, w / 2, h / 2 + 0.5); }
  });
  return { img, w: w + pad * 2, h: h + pad * 2, pad };
}
const textMeasure = document.createElement('canvas').getContext('2d');
// Одна буква надписи по телу (с обводкой)
function glyphSprite(ch, fs, fill, stroke) {
  const k = PX_PER_UNIT(), fb = Math.round(fs);
  const key = 'gl|' + ch + '|' + fb + '|' + fill + '|' + stroke + '|' + k;
  const size = fb * 1.6;
  return cacheCanvas(key, size * k, size * k, g => {
    g.scale(k, k); g.font = `bold ${fb}px Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round'; g.lineWidth = fb * 0.22; g.strokeStyle = stroke; g.fillStyle = fill;
    g.strokeText(ch, size / 2, size / 2); g.fillText(ch, size / 2, size / 2);
  });
}
// Нарисовать картинку в мире с поворотом без save/restore: прямо задаём матрицу (worldT — текущий масштаб и сдвиг кадра)
const worldT = { k: 1, tx: 0, ty: 0 };
function drawRotated(img, x, y, ang, w, h, ox, oy) {
  const c = Math.cos(ang) * worldT.k, s = Math.sin(ang) * worldT.k;
  ctx.setTransform(c, s, -s, c, worldT.tx + worldT.k * x, worldT.ty + worldT.k * y);
  ctx.drawImage(img, -ox, -oy, w, h);
}
function resetWorldT() { ctx.setTransform(worldT.k, 0, 0, worldT.k, worldT.tx, worldT.ty); }

function drawBackPlate(id, ri, x, y, heading, r, boost, time, bodyCol, nick, team) {
  const R = ROLES[ri]; if (!R) return;
  let st = swing.get(id);
  const now = performance.now();
  if (!st) { st = { ang: 0, vel: 0, lastA: heading, t: now }; swing.set(id, st); }
  const dt = Math.min(0.05, (now - st.t) / 1000); st.t = now;
  const turn = angDiff(st.lastA, heading); st.lastA = heading;
  // поворот толкает табличку в обратную сторону; пружина возвращает; ускорение — дрожь
  st.vel += (-turn * 9 - st.ang * 30 - st.vel * 3.2) * dt * 1;
  st.vel -= turn * 6;
  if (boost) st.vel += Math.sin(time * 0.05) * 0.6;
  st.ang = clamp(st.ang + st.vel * dt, -1.1, 1.1);
  const L = r * 0.85, s = Math.max(0.55, r / 14);                   // длина ниточки и масштаб таблички (владелец: средний размер)
  const hang = st.ang;                                                // качание вокруг точки крепления
  const px = x + Math.sin(hang) * L, py = y + Math.cos(hang) * L * 0.4 - r * 0.3;
  // ниточка
  ctx.strokeStyle = 'rgba(30,30,30,0.85)'; ctx.lineWidth = Math.max(1, 1.4 * s);
  ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo((x + px) / 2 + Math.sin(hang) * 4 * s, (y + py) / 2 - 3 * s, px, py); ctx.stroke();
  // табличка — готовая картинка, слегка наклонена по качанию
  const P = plateSprite(ri, bodyCol, nick, s, team);
  drawRotated(P.img, px, py, hang * 0.5, P.w, P.h, P.w / 2, P.pad);
  resetWorldT();
  // кружок-крепление на спине
  ctx.fillStyle = 'rgba(30,30,30,0.9)'; ctx.beginPath(); ctx.arc(x, y, Math.max(1.5, 2 * s), 0, TAU); ctx.fill();
}
setInterval(() => { if (swing.size > 300) swing.clear(); }, 10000);
// Дон и особые скины: надпись по всему телу, буквы идут вдоль изгибов и всегда читаются слева направо.
// SX/SY — точки тела от головы к хвосту (их уже разложил drawSnake).
function drawBodyText(cnt, r, text, time, view, startK, fillCol, strokeCol) {
  const unit = text + '  ★  ', fs = Math.max(8, r * 0.95), slot = fs * 0.74;
  let k = Math.min(cnt - 1, Math.max(3, Math.round(r * (startK != null ? 2.2 : 5.5) / Math.max(1, Math.hypot(SX[1] - SX[0], SY[1] - SY[0])))));
  const px = [], py = [], pa = [];
  let carry = slot;
  for (; k < cnt - 1; k++) {
    const dx = SX[k + 1] - SX[k], dy = SY[k + 1] - SY[k], L = Math.hypot(dx, dy);
    if (!L) continue;
    let t = carry;
    while (t <= L) { px.push(SX[k] + dx * t / L); py.push(SY[k] + dy * t / L); pa.push(Math.atan2(dy, dx)); t += slot; }
    carry = t - L;
  }
  const fill = fillCol || '#ffd52e', fillHi = fillCol ? (strokeCol === '#ffffff' ? fillCol : '#9b6bff') : '#fff7cc', stroke = strokeCol || 'rgba(40, 25, 0, 0.9)';
  const shine = (time * 0.0004) % 1, n = unit.length, gs = Math.round(fs) * 1.6;
  const m = r * 2, x0 = view.x0 - m, x1 = view.x1 + m, y0 = view.y0 - m, y1 = view.y1 + m;
  for (let c0 = 0; c0 < px.length; c0 += n) {
    if (c0 + n > px.length) break; // обрезок надписи в конце хвоста не рисуем
    const c1 = c0 + n - 1, flip = px[c1] - px[c0] < 0;
    for (let i = c0; i <= c1; i++) {
      const ch = unit[flip ? (n - 1 - (i - c0)) : (i - c0)];
      if (ch === ' ') continue;
      const x = px[i], y = py[i];
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const img = glyphSprite(ch, fs, ((i / px.length + shine) % 1) < 0.06 ? fillHi : fill, stroke);
      drawRotated(img, x, y, pa[i] + (flip ? Math.PI : 0), gs, gs, gs / 2, gs / 2);
    }
  }
  resetWorldT();
}

// Сигара Дона: из уголка рта, тлеющий кончик и дымок вверх
// Губы Проститутки (владелец 07.10): ровные нарисованные губы строго поперёк морды (значок 💋 стоял наискосок и разный на телефонах).
// Картинка рисуется один раз на размер и дальше копируется. В картинке: x — поперёк морды, y — вперёд (верхняя губа ближе к морде).
function lipsSprite(r) {
  const k = PX_PER_UNIT(), R = Math.max(6, Math.round(r / 2) * 2), W = R * 0.72, H = R * 0.42;
  const w = W * 2 + R * 0.2, top = H * 1.3 + R * 0.05, h = top + H * 1.5 + R * 0.05;
  const img = cacheCanvas('lp2|' + R + '|' + k, w * k, h * k, g => {
    g.scale(k, k); g.translate(w / 2, top);
    const gr = g.createLinearGradient(0, -H * 1.2, 0, H * 1.4); gr.addColorStop(0, '#ff4f8f'); gr.addColorStop(0.5, '#e8115b'); gr.addColorStop(1, '#a50d44');
    g.fillStyle = gr; g.strokeStyle = '#7a0a33'; g.lineWidth = Math.max(1, R * 0.05); g.lineJoin = 'round';
    g.beginPath(); // верхняя губа «бантиком»
    g.moveTo(-W, 0); g.bezierCurveTo(-W * 0.75, -H * 0.9, -W * 0.25, -H * 1.25, 0, -H * 0.62); g.bezierCurveTo(W * 0.25, -H * 1.25, W * 0.75, -H * 0.9, W, 0);
    g.quadraticCurveTo(0, H * 0.22, -W, 0); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); // нижняя губа
    g.moveTo(-W, 0); g.quadraticCurveTo(0, H * 0.22, W, 0); g.bezierCurveTo(W * 0.7, H * 1.5, -W * 0.7, H * 1.5, -W, 0); g.closePath(); g.fill(); g.stroke();
    g.strokeStyle = '#5c0726'; g.lineWidth = Math.max(1, R * 0.06); g.beginPath(); g.moveTo(-W * 0.95, 0); g.quadraticCurveTo(0, H * 0.22, W * 0.95, 0); g.stroke(); // линия рта
    g.fillStyle = 'rgba(255,255,255,0.6)'; g.beginPath(); g.ellipse(-W * 0.25, H * 0.75, W * 0.22, H * 0.14, 0, 0, TAU); g.fill(); // блики
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.beginPath(); g.ellipse(W * 0.35, -H * 0.6, W * 0.14, H * 0.1, 0, 0, TAU); g.fill();
  });
  return { img, w, h, top };
}
function drawLips(hx, hy, a, r) {
  const L = lipsSprite(r), sc = r / Math.max(6, Math.round(r / 2) * 2);
  drawRotated(L.img, hx + Math.cos(a) * r * 1.18, hy + Math.sin(a) * r * 1.18, a - Math.PI / 2, L.w * sc, L.h * sc, L.w * sc / 2, L.top * sc);
  resetWorldT();
}
function drawCigar(hx, hy, a, r, time) {
  const ca = Math.cos(a), sa = Math.sin(a), px = -sa, py = ca;
  const bx = hx + ca * r * 0.85 + px * r * 0.45, by = hy + sa * r * 0.85 + py * r * 0.45; // уголок рта
  const ang = a + 0.55, L = r * 1.5, W = r * 0.24;
  const tx = bx + Math.cos(ang) * L, ty = by + Math.sin(ang) * L;
  ctx.save(); ctx.translate(bx, by); ctx.rotate(ang);
  const g = ctx.createLinearGradient(0, -W, 0, W); g.addColorStop(0, '#9a6236'); g.addColorStop(0.5, '#6b3e1f'); g.addColorStop(1, '#3a200e');
  ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, -W * 0.85); ctx.lineTo(L, -W); ctx.lineTo(L, W); ctx.lineTo(0, W * 0.85); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#d4a017'; ctx.fillRect(L * 0.18, -W * 0.95, L * 0.12, W * 1.9); // золотое колечко
  ctx.fillStyle = '#9a9a9a'; ctx.fillRect(L - W * 0.5, -W, W * 0.5, W * 2); // пепел
  const glow = 0.6 + 0.4 * Math.sin(time * 0.006);
  ctx.fillStyle = `rgba(255, ${Math.round(90 + 60 * glow)}, 20, ${0.75 + 0.25 * glow})`; ctx.beginPath(); ctx.arc(L, 0, W * 0.75, 0, TAU); ctx.fill();
  ctx.restore();
  for (let k = 0; k < 5; k++) { // дым: колечки поднимаются вверх и тают
    const ph = ((time * 0.0005) + k / 5) % 1, rad = r * (0.18 + ph * 0.55);
    ctx.fillStyle = `rgba(200, 205, 215, ${0.32 * (1 - ph)})`;
    ctx.beginPath(); ctx.arc(tx + Math.sin(ph * 6 + k) * r * 0.3, ty - ph * r * 3.2, rad, 0, TAU); ctx.fill();
  }
}
// Дон: золотые линии по бокам тела и золотые искры, поднимающиеся от тела
const donSparks = [];
function drawDonTrim(id, cnt, r, view, time) {
  const m = r * 3;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#d4a73a'; ctx.lineWidth = Math.max(1.2, r * 0.1);
  for (const side of [-1, 1]) {
    ctx.beginPath(); let open = false;
    for (let k = 1; k < cnt - 1; k += 2) {
      const x = SX[k], y = SY[k];
      if (x < view.x0 - m || x > view.x1 + m || y < view.y0 - m || y > view.y1 + m) { open = false; continue; }
      const a = Math.atan2(SY[k - 1] - SY[k + 1], SX[k - 1] - SX[k + 1]), w = r * 0.8 * (k / cnt < 0.6 ? 1 : Math.max(0.15, 1 - (k / cnt - 0.6) / 0.4));
      const ox = x - Math.sin(a) * w * side, oy = y + Math.cos(a) * w * side;
      if (open) ctx.lineTo(ox, oy); else { ctx.moveTo(ox, oy); open = true; }
    }
    ctx.stroke();
  }
  if (Math.random() < 0.6 && cnt > 4) { const k = (Math.random() * cnt * 0.8) | 0; donSparks.push({ x: SX[k] + (Math.random() - 0.5) * r, y: SY[k], life: 1, r }); }
  ctx.globalCompositeOperation = 'lighter';
  for (let i = donSparks.length - 1; i >= 0; i--) {
    const s = donSparks[i]; s.y -= s.r * 0.04; s.life -= 0.015;
    if (s.life <= 0) { donSparks.splice(i, 1); continue; }
    ctx.fillStyle = `rgba(255,213,46,${s.life * 0.8})`; ctx.beginPath(); ctx.arc(s.x + Math.sin(time * 0.003 + i) * s.r * 0.2, s.y, s.r * (0.05 + s.life * 0.08), 0, TAU); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  if (donSparks.length > 300) donSparks.length = 300;
}
// Водные скины: бегущие волны-блики, пузырьки внутри; лёд — трещинки; мыльный пузырь — радужный перелив
function drawWaterFx(w, cnt, r, view, time) {
  const m = r * 2, vis = (x, y) => x > view.x0 - m && x < view.x1 + m && y > view.y0 - m && y < view.y1 + m;
  const sp = Math.max(1, Math.hypot(SX[1] - SX[0], SY[1] - SY[0])), every = Math.max(1, Math.round(r * 0.55 / sp));
  const hl = w.kind === 'ocean' ? '125, 227, 255' : '255, 255, 255';
  for (let k = 0; k < cnt - 1; k += every) {
    const x = SX[k], y = SY[k]; if (!vis(x, y)) continue;
    const a = Math.atan2(SY[k] - SY[k + 1], SX[k] - SX[k + 1]);
    if (w.kind === 'soap') { // радужный перелив
      const hue = (Math.round((k * 6 + time * 0.08) / 30) * 30) % 360;
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.18;
      const hs = r * 2.2; ctx.drawImage(haloSprite(hslToHex(hue, 90, 60)), x - hs / 2, y - hs / 2, hs, hs);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    }
    // волна: блик бежит от хвоста к голове
    const wave = Math.pow(Math.max(0, Math.sin(k * 0.09 + time * 0.006)), 6);
    if (wave > 0.05) {
      ctx.fillStyle = `rgba(${hl}, ${0.55 * wave})`;
      ctx.beginPath(); ctx.ellipse(x + Math.sin(a) * r * 0.35, y - Math.cos(a) * r * 0.35, r * 0.45, r * 0.13, a, 0, TAU); ctx.fill();
    }
  }
  if (w.kind === 'ice') { // трещинки — на одних и тех же местах тела
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = Math.max(1, r * 0.05);
    for (let k = every * 2; k < cnt - 1; k += every * 5) {
      const x = SX[k], y = SY[k]; if (!vis(x, y)) continue;
      const h = (k * 2654435761 >>> 0) / 4294967296, a = h * TAU;
      ctx.beginPath(); ctx.moveTo(x - Math.cos(a) * r * 0.5, y - Math.sin(a) * r * 0.5); ctx.lineTo(x + Math.cos(a + 0.6) * r * 0.1, y + Math.sin(a + 0.6) * r * 0.1);
      ctx.lineTo(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55); ctx.stroke();
    }
  } else { // пузырьки поднимаются внутри тела
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = Math.max(1, r * 0.04);
    for (let k = every; k < cnt - 1; k += every * 3) {
      const x = SX[k], y = SY[k]; if (!vis(x, y)) continue;
      const h = ((k * 2654435761) >>> 0) / 4294967296, ph = (time * 0.0004 + h) % 1;
      const bx = x + (h - 0.5) * r * 1.1, by = y + r * 0.6 - ph * r * 1.2, br = r * (0.06 + h * 0.08);
      ctx.globalAlpha = Math.sin(ph * Math.PI);
      ctx.beginPath(); ctx.arc(bx, by, br, 0, TAU); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}
let promoT = 0;
function showPromo(ri) {
  const R = ROLES[ri]; if (!R) return;
  const el = $('promo'), don = ri === DON;
  el.className = don ? 'don' : '';
  el.style.setProperty('--rc', R.color);
  el.innerHTML = don
    ? `<img class="pimg" src="photos/p${PHOTO_DON}.jpg" alt=""><div class="pi">👑</div><div class="pn">ДОН МАФИИ</div><div class="ps">Вы — самая большая змея на карте!</div>`
    : `<div class="pt">✨ НОВАЯ РОЛЬ ✨</div><div class="pn">${R.icon ? R.icon + ' ' : ''}${R.name.toUpperCase()}</div><div class="ps">${esc(myName())}, так держать!</div>`;
  void el.offsetWidth; el.classList.add('show');
  clearTimeout(promoT); promoT = setTimeout(() => el.classList.remove('show'), don ? 3500 : 2600);
  Sound.promo(don);
}

// ===== Облик роли поверх скина (владелец 06.10, вариант «б»): скин игрока остаётся, роль добавляет свои детали =====
// Стиль таблички на спине по роли: фон, цвет текста, рамка
const PLATE_STYLE = {
  'Проститутка': { bg: '#ff5fc8', fg: '#ffffff', border: '#ffd0f0' },
  'Параноик':    { bg: '#5b2fc8', fg: '#ffffff', border: '#c9a8ff' },
  'Бомба':       { bg: '#2a2a2a', fg: '#ff8a1f', border: '#ff8a1f' },
  'Доктор':      { bg: '#ffffff', fg: '#e8323c', border: '#e8323c' },
  'Шериф':       { bg: '#c8a04a', fg: '#3a2a0a', border: '#ffe08a' },
  'Комиссар':    { bg: '#1d2b44', fg: '#7de3ff', border: '#7de3ff' },
  'Киллер':      { bg: '#1a1a1a', fg: '#ff3b3b', border: '#9aa3ad' },
  'Мафия':       { bg: '#0d0d0d', fg: '#ffffff', border: '#e8323c' },
  'Дон Мафии':   { bg: '#ffd52e', fg: '#1a1a1a', border: '#fff3a0' },
};
const ROLE_SKIN = {
  'Доктор': ['#f4f6f8'],
  // Проститутка: розовое тело у ботов убрано (владелец 11.10: «убери розовых ботов») — узнаётся по губам и табличке
  'Мафия': ['#1e1e22'],
  'Киллер': ['#b4bcc6', '#b4bcc6', '#b4bcc6', '#141414'],
  'Шериф': ['#f2f2f2'], // белый (владелец 11.10: шахматную клетку убрали)
};
const roleFlash = new Map(); // id → { role, until } — вспышка при смене роли

function star(cx, cy, R, n = 5) {
  ctx.beginPath();
  for (let i = 0; i < n * 2; i++) { const rr = i % 2 ? R * 0.45 : R, a = -Math.PI / 2 + i * Math.PI / n; ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
  ctx.closePath();
}
function heart(cx, cy, R) {
  ctx.beginPath();
  ctx.moveTo(cx, cy + R * 0.9);
  ctx.bezierCurveTo(cx - R * 1.4, cy - R * 0.1, cx - R * 0.6, cy - R * 1.1, cx, cy - R * 0.35);
  ctx.bezierCurveTo(cx + R * 0.6, cy - R * 1.1, cx + R * 1.4, cy - R * 0.1, cx, cy + R * 0.9);
  ctx.closePath();
}
// Точки тела с равным шагом step (от шеи к хвосту): [x, y, угол]
function bodyMarks(cnt, step, startDist) {
  const out = []; let acc = 0, next = startDist;
  for (let k = 0; k < cnt - 1; k++) {
    const dx = SX[k + 1] - SX[k], dy = SY[k + 1] - SY[k], L = Math.hypot(dx, dy);
    while (next <= acc + L && L) { const f = (next - acc) / L; out.push([SX[k] + dx * f, SY[k] + dy * f, Math.atan2(dy, dx)]); next += step; }
    acc += L;
  }
  return out;
}
// Под телом (до шариков): свечение Дона, «костюм» Мафии
// Шахматная клетка поверх белого тела: два ряда чёрных квадратов вперемешку вдоль змеи
function drawChecker(cnt, r, view) {
  const m = r * 2, s = r * 0.92;
  ctx.fillStyle = '#141414';
  let k = 0;
  for (const [x, y, a] of bodyMarks(cnt, s, r * 0.9)) {
    k++;
    if (x < view.x0 - m || x > view.x1 + m || y < view.y0 - m || y > view.y1 + m) continue;
    const side = k % 2 ? 1 : -1, ox = -Math.sin(a) * side * s * 0.5, oy = Math.cos(a) * side * s * 0.5;
    ctx.save(); ctx.translate(x + ox, y + oy); ctx.rotate(a); ctx.fillRect(-s / 2, -s / 2, s, s); ctx.restore();
  }
  roundShade(ctx, cnt, r, view);
}
// Объём поверх клеток (владелец 07.10: «шахматную — более круглой»): края темнеют, посередине блик — как у шарика тела
const roundShadeSprite = () => sprite('rshade', g => {
  const gr = g.createRadialGradient(32 - 6, 32 - 7, 1, 32, 32, SR);
  gr.addColorStop(0, 'rgba(255,255,255,0.16)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.03)'); gr.addColorStop(0.72, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.32)');
  g.fillStyle = gr; g.beginPath(); g.arc(32, 32, SR, 0, TAU); g.fill();
});
function roundShade(g, cnt, r, view) {
  const img = roundShadeSprite(), size = r * 2 * SPR / (SR * 2), half = size / 2, step = Math.max(1, Math.round(r * 0.7 / Math.max(1, Math.hypot(SX[1] - SX[0], SY[1] - SY[0]))));
  for (let k = cnt - 1; k >= 0; k -= step) {
    const x = SX[k], y = SY[k];
    if (view && (x < view.x0 - size || x > view.x1 + size || y < view.y0 - size || y > view.y1 + size)) continue;
    g.drawImage(img, x - half, y - half, size, size);
  }
}
function drawRoleUnder(ri, cnt, r, time, view) {
  const name = (ROLES[ri] || {}).name;
  if (false && ri === DON) { // владелец 06.10: Дон — как было, без свечения
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.28 + 0.1 * Math.sin(time * 0.004);
    const halo = haloSprite('#ffd52e'), hs = r * 2 * 2.3 * SPR / (SR * 2) / 1.6;
    for (let k = 0; k < cnt; k += 3) { const x = SX[k], y = SY[k]; if (x < view.x0 - hs || x > view.x1 + hs || y < view.y0 - hs || y > view.y1 + hs) continue; ctx.drawImage(halo, x - hs / 2, y - hs / 2, hs, hs); }
    ctx.restore();
  }
  void name;
}
// Поверх тела: детали роли
function drawRoleOver(ri, cnt, r, time, view, boost) {
  const name = (ROLES[ri] || {}).name; if (!name || ri === 0) return;
  const m = r * 2, inView = (x, y) => x > view.x0 - m && x < view.x1 + m && y > view.y0 - m && y < view.y1 + m;
  const start = r * 6; // начинаем за табличкой на спине
  ctx.save();
  if (name === 'Доктор') { // белый Доктор с розовыми плюсами по всему телу (владелец 06.10)
    for (const [x, y, a] of bodyMarks(cnt, r * 2.4, r * 1.6)) {
      if (!inView(x, y)) continue;
      ctx.save(); ctx.translate(x, y); ctx.rotate(a); const L = r * 0.5, W = r * 0.15;
      ctx.fillStyle = '#ff5fa8'; ctx.fillRect(-L, -W, L * 2, W * 2); ctx.fillRect(-W, -L, W * 2, L * 2);
      ctx.restore();
    }
  } else if (ROLE_SKIN[name]) { /* цвет тела уже выделяет роль — без деталей */ } else if (name === 'Проститутка') {
    for (const [x, y] of bodyMarks(cnt, r * 3.2, start)) { if (!inView(x, y)) continue; const p = 1 + 0.12 * Math.sin(time * 0.008 + x * 0.05); ctx.fillStyle = 'rgba(255, 95, 200, 0.85)'; heart(x, y, r * 0.38 * p); ctx.fill(); }
  } else if (name === 'Параноик') {
    let i = 0;
    for (const [x, y] of bodyMarks(cnt, r * 4, start)) {
      i++; if (!inView(x, y)) continue;
      const er = r * 0.32, la = Math.atan2(cam.y - y, cam.x - x) + Math.sin(time * 0.003 + i) * 0.6; // косятся по сторонам
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, er, 0, TAU); ctx.fill();
      ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(x + Math.cos(la) * er * 0.4, y + Math.sin(la) * er * 0.4, er * 0.5, 0, TAU); ctx.fill();
    }
  } else if (name === 'Бомба') {
    const tx = SX[cnt - 1], ty = SY[cnt - 1], px = SX[Math.max(0, cnt - 4)], py = SY[Math.max(0, cnt - 4)], a = Math.atan2(ty - py, tx - px);
    if (inView(tx, ty)) {
      const fx = tx + Math.cos(a) * r * 1.4, fy = ty + Math.sin(a) * r * 1.4;
      ctx.strokeStyle = '#6b4a2a'; ctx.lineWidth = r * 0.18; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.quadraticCurveTo(tx + Math.cos(a + 0.6) * r, ty + Math.sin(a + 0.6) * r, fx, fy); ctx.stroke();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 6; i++) { const ang = time * 0.02 + i * 1.05, d = r * (0.25 + 0.35 * ((time * 0.01 + i) % 1)); ctx.fillStyle = i % 2 ? '#ffd52e' : '#ff6a00'; ctx.beginPath(); ctx.arc(fx + Math.cos(ang) * d, fy + Math.sin(ang) * d, r * 0.12, 0, TAU); ctx.fill(); }
      ctx.globalAlpha = 0.6 + 0.4 * Math.sin(time * 0.05); ctx.fillStyle = '#fff3a0'; ctx.beginPath(); ctx.arc(fx, fy, r * 0.22, 0, TAU); ctx.fill();
    }
  } else if (name === 'Доктор') {
    for (const [x, y, a] of bodyMarks(cnt, r * 3.4, start)) {
      if (!inView(x, y)) continue;
      ctx.save(); ctx.translate(x, y); ctx.rotate(a); const L = r * 0.42, W = r * 0.15;
      ctx.fillStyle = '#ffffff'; ctx.fillRect(-L, -W, L * 2, W * 2); ctx.fillRect(-W, -L, W * 2, L * 2);
      ctx.fillStyle = '#e8323c'; ctx.fillRect(-L * 0.7, -W * 0.55, L * 1.4, W * 1.1); ctx.fillRect(-W * 0.55, -L * 0.7, W * 1.1, L * 1.4);
      ctx.restore();
    }
  } else if (name === 'Шериф') {
    /* владелец 11.10: шахматная клетка у Шерифа убрана */
  } else if (name === 'Комиссар' || name === 'Киллер') {
    const col = name === 'Комиссар' ? 'rgba(15, 25, 45, 0.55)' : 'rgba(200, 20, 30, 0.75)';
    for (const [x, y, a] of bodyMarks(cnt, r * (name === 'Киллер' ? 2.2 : 2.8), start)) {
      if (!inView(x, y)) continue;
      ctx.save(); ctx.translate(x, y); ctx.rotate(a); ctx.fillStyle = col; ctx.fillRect(-r * 0.18, -r * 0.98, r * 0.36, r * 1.96); ctx.restore();
    }
    if (name === 'Киллер') { // стальная окантовка по краям тела
      ctx.strokeStyle = 'rgba(190, 200, 212, 0.75)'; ctx.lineWidth = r * 0.12;
      for (const sgn of [-1, 1]) { ctx.beginPath(); let first = true; for (const [x, y, a] of bodyMarks(cnt, r * 0.6, r * 1.2)) { const ox = x - Math.sin(a) * r * 0.92 * sgn, oy = y + Math.cos(a) * r * 0.92 * sgn; if (first) { ctx.moveTo(ox, oy); first = false; } else ctx.lineTo(ox, oy); } ctx.stroke(); }
    }
  } else if (name === 'Мафия') {
    // чёрный «костюм» в тонкую белую полоску
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(10, 10, 10, 0.62)'; ctx.lineWidth = r * 1.75;
    ctx.beginPath(); ctx.moveTo(SX[0], SY[0]); for (let k = 1; k < cnt; k += 2) ctx.lineTo(SX[k], SY[k]); ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)'; ctx.lineWidth = Math.max(1, r * 0.06);
    for (const off of [-0.5, 0, 0.5]) { ctx.beginPath(); let first = true; for (const [x, y, a] of bodyMarks(cnt, r * 0.6, r * 1.5)) { const ox = x - Math.sin(a) * r * off, oy = y + Math.cos(a) * r * off; if (first) { ctx.moveTo(ox, oy); first = false; } else ctx.lineTo(ox, oy); } ctx.stroke(); }
  }
  void boost;
  ctx.restore();
}
// Головной убор: шляпа у Комиссара и Мафии, корона у Дона
function drawRoleHat(ri, hx, hy, a, r, time) {
  const name = (ROLES[ri] || {}).name; if (!name) return;
  if (name !== 'Комиссар' && name !== 'Мафия') return; // Дон — без короны (как было)
  // за глазами, верх убора смотрит вперёд по ходу
  ctx.save(); ctx.translate(hx - Math.cos(a) * r * 1.15, hy - Math.sin(a) * r * 1.15); ctx.rotate(a + Math.PI / 2);
  if (ri === DON) {
    const w = r * 1.9, h = r * 1.15, b = r * 0.35;
    ctx.shadowColor = '#ffd52e'; ctx.shadowBlur = r * 0.6;
    ctx.fillStyle = '#ffd52e';
    ctx.beginPath(); ctx.moveTo(-w / 2, b); ctx.lineTo(-w / 2, b - h * 0.6); ctx.lineTo(-w / 4, b - h * 0.25); ctx.lineTo(0, b - h); ctx.lineTo(w / 4, b - h * 0.25); ctx.lineTo(w / 2, b - h * 0.6); ctx.lineTo(w / 2, b); ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0; ctx.strokeStyle = '#a77a00'; ctx.lineWidth = r * 0.07; ctx.stroke();
    for (const [x, c] of [[-w / 4, '#e8323c'], [0, '#3d6bff'], [w / 4, '#3ddc5a']]) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, b - h * 0.18, r * 0.1, 0, TAU); ctx.fill(); }
  } else { // фетровая шляпа
    const w = r * 1.7, col = name === 'Мафия' ? '#111111' : '#2b3a55';
    ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(0, 0, w / 2, r * 0.22, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-w * 0.3, 0); ctx.lineTo(-w * 0.26, -r * 0.75); ctx.quadraticCurveTo(0, -r * 0.95, w * 0.26, -r * 0.75); ctx.lineTo(w * 0.3, 0); ctx.closePath(); ctx.fill();
    ctx.fillStyle = name === 'Мафия' ? '#e8323c' : '#7de3ff'; ctx.fillRect(-w * 0.29, -r * 0.24, w * 0.58, r * 0.16);
  }
  ctx.restore();
}
// Вспышка по телу при смене роли
function drawRoleFlash(id, ri, cnt, r, view) {
  let f = roleFlash.get(id);
  if (!f) { roleFlash.set(id, { role: ri, until: 0 }); return; }
  if (f.role !== ri) { f.role = ri; f.until = performance.now() + 900; }
  const left = f.until - performance.now(); if (left <= 0) return;
  const k = left / 900, col = (ROLES[ri] || ROLES[0]).color, hs = r * 2 * 2.6 * SPR / (SR * 2) / 1.6;
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = k * 0.9;
  const halo = haloSprite(col);
  const front = Math.floor((1 - k) * cnt); // волна бежит от головы к хвосту
  for (let i = Math.max(0, front - 30); i < Math.min(cnt, front + 30); i += 2) { const x = SX[i], y = SY[i]; if (x < view.x0 - hs || x > view.x1 + hs || y < view.y0 - hs || y > view.y1 + hs) continue; ctx.drawImage(halo, x - hs / 2, y - hs / 2, hs, hs); }
  ctx.restore();
}
setInterval(() => { if (roleFlash.size > 400) roleFlash.clear(); }, 15000);

// ===== Отрисовка =====
const cam = { x: 0, y: 0, s: 0.8 };
const camLag = { x: 0, y: 0, tx: 0, ty: 0, has: false }; // плавный перелёт камеры после потайного хода
const SX = [], SY = [], SI = [];
const lastDrawn = new Map();   // id -> змейка, как она нарисована в прошлом кадре (для таяния при смерти)
const dying = [];              // тающие тела погибших змей
const DIE_MS = 700;
function drawSnake(sn, meta, isMe, time, view, fade) {
  let sk = meta ? meta.sk : prepSkin({ id: 1, c1: '#888888', c2: '#888888', c3: '#888888' });
  // Владелец 06.10: у некоторых ролей тело одного цвета (проще играть): Доктор белый, Проститутка розовая, Мафия чёрная, Киллер сталь в чёрную полоску
  // Владелец 07.10: у людей при смене роли змея остаётся как есть (меняется только табличка); роль красит только ботов
  const RS = meta && meta.bot && !fade && !meta.sk.text && ROLE_SKIN[(ROLES[meta.role || 0] || {}).name]; // особые скины (Альмано, Марми) роль не перекрашивает
  if (RS) sk = Object.assign({}, sk, { cols: RS, style: 'ball', unitK: 1.4 });
  // Владелец 07.10: Дон — особый облик «Чёрное золото» (у людей и ботов), вместо своего скина, пока он Дон
  const isDon = meta && !fade && meta.role === DON;
  if (isDon) sk = Object.assign({}, sk, { cols: ['#1a171e', '#26212c'], style: 'ball', unitK: 1.4, text: '', eyes: 'gold', badge: false });
  const n = sn.idx.length;
  if (!n) return;
  const ghostT = !fade && docGhost.get(sn.id); // Доктор только что спасся — зелёная вспышка у головы
  if (ghostT && ghostT < performance.now()) docGhost.delete(sn.id);
  const r = sn.r * (fade ? 1 + fade * 0.35 : 1); // тающее тело чуть разбухает
  // Кружки вдоль тела идут очень плотно — так тело выглядит гладкой трубкой
  const sp = Math.max(2, sn.r * (!hiQ || autoLow >= 2 || farView ? 0.6 : isTouch ? 0.42 : 0.28)); // farView — камера высоко (командная игра): издалека реже кружки не видны
  let cnt = 0;
  SX[0] = sn.xs[0]; SY[0] = sn.ys[0]; SI[0] = sn.idx[0]; cnt = 1;
  let rem = sp;
  for (let j = 1; j < n; j++) {
    const x0 = sn.xs[j - 1], y0 = sn.ys[j - 1], x1 = sn.xs[j], y1 = sn.ys[j];
    const dx = x1 - x0, dy = y1 - y0, L = Math.sqrt(dx * dx + dy * dy);
    if (sn.gap[j] || L > Math.max(90, sn.r * 4)) { SX[cnt] = x1; SY[cnt] = y1; SI[cnt] = sn.idx[j]; cnt++; rem = sp; continue; } // разрыв: часть тела у входа, часть у выхода норы
    const i0 = sn.idx[j - 1], i1 = sn.idx[j];
    let t = rem;
    while (t <= L) {
      const f = t / L;
      SX[cnt] = x0 + dx * f; SY[cnt] = y0 + dy * f; SI[cnt] = i0 + (i1 - i0) * f; cnt++;
      t += sp;
    }
    rem = t - L;
  }
  const size = r * 2 * SPR / (SR * 2), half = size / 2;
  const unit = sn.r * sk.unitK / SEG_D;  // длина одной полосы узора
  const vx0 = view.x0 - size, vx1 = view.x1 + size, vy0 = view.y0 - size, vy1 = view.y1 + size;
  const shadeStep = Math.max(1, Math.round(sn.r * 0.9 / sp));
  if (fade) ctx.globalAlpha = 1 - fade;

  if (hiQ && !isTouch && !fade) { // тень под телом: змейка будто лежит над полом (на телефоне не рисуем — экономим)
    const sh = shadowSprite(), ss = size * 1.35, so = r * 0.25;
    for (let k = cnt - 1; k >= 0; k -= shadeStep) {
      const x = SX[k], y = SY[k];
      if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue;
      ctx.drawImage(sh, x - ss / 2 + so, y - ss / 2 + so, ss, ss);
    }
  }
  const roleIdx = meta && meta.bot && !fade ? (meta.role || 0) : 0; // детали ролей (сердечки, звёзды, шляпы) — только у ботов
  if (!fade && sk.text && !sk.plain) { // особый скин: мягкое золотое сияние вокруг тела («Марми» — без него, только 2 цвета)
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.22 + 0.08 * Math.sin(time * 0.004);
    const halo = haloSprite('#ffc23a'), hs = r * 2 * 2.1 * SPR / (SR * 2) / 1.6;
    for (let k = 0; k < cnt; k += 3) { const x = SX[k], y = SY[k]; if (x < view.x0 - hs || x > view.x1 + hs || y < view.y0 - hs || y > view.y1 + hs) continue; ctx.drawImage(halo, x - hs / 2, y - hs / 2, hs, hs); }
    ctx.restore();
  }
  if (roleIdx && !sk.text) drawRoleUnder(roleIdx, cnt, r, time, view);
  if (sn.boost && !fade && !(TEAM_MODE && meta && meta.team === 1)) { // при ускорении тело светится и пульсирует (у Мафии в командах — без свечения, владелец 07.10)
    const hs = size * 2.2, hh = hs / 2;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.45 + 0.25 * Math.sin(time * 0.015);
    for (let k = cnt - 1; k >= 0; k -= shadeStep) {
      const x = SX[k], y = SY[k];
      if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue;
      ctx.drawImage(haloSprite(bandColor(sk.cols, SI[k] / unit)), x - hh, y - hh, hs, hs);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }
  for (let k = cnt - 1; k >= 0; k--) {
    const x = SX[k], y = SY[k];
    if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue;
    ctx.drawImage(skinSprite(sk, SI[k] / unit), x - half, y - half, size, size);
  }
  if (sk.water && !fade) drawWaterFx(sk.water, cnt, r, view, time);

  if (isDon) drawDonTrim(sn.id, cnt, sn.r, view, time);
  if (roleIdx && !sk.text && (autoLow < 2 || isMe)) drawRoleOver(roleIdx, cnt, r, time, view, sn.boost);
  if (sk.style === 'checker' && !fade) drawChecker(cnt, r, view); // скин «Шахматный»
  if (meta && !fade) drawRoleFlash(sn.id, roleIdx, cnt, r, view);
  if (sn.idx[0] === 0) { // голова на экране
    const hx = sn.xs[0], hy = sn.ys[0], a = sn.a;
    if (!fade) lastHeads.set(sn.id, { x: hx, y: hy });
    const nk = Math.min(cnt - 1, Math.round(sn.r * 2.6 / sp));
    let neck = null;
    if (nk > 1) neck = [SX[nk], SY[nk], Math.atan2(SY[nk - 1] - SY[nk + 1 < cnt ? nk + 1 : nk], SX[nk - 1] - SX[nk + 1 < cnt ? nk + 1 : nk])];
    drawHeadDecor(ctx, sk, hx, hy, a, isMe ? inAngle : a, r, neck);
    if (roleIdx) drawRoleHat(roleIdx, hx, hy, a, r, time);
    if (meta && !fade && !TEAM_MODE && meta.role === SHERIFF) { if (neck) drawSheriffBadge(neck, r); drawCoolShades(hx, hy, a, r); } // владелец 12.10: без шляпы — жетон и тёмные очки
    if (meta && !fade && !TEAM_MODE && ROLES[meta.role || 0] && ROLES[meta.role || 0].name === 'Проститутка') drawLips(hx, hy, a, r); // владелец 07.10: розовые губы спереди
    if (ghostT && ghostT > performance.now()) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.6; const hs = r * 6; ctx.drawImage(haloSprite('#3ddc5a'), hx - hs / 2, hy - hs / 2, hs, hs); ctx.restore(); }
    if (meta && !fade && (meta.role === DON || (TEAM_MODE && havanaIds.has(sn.id)))) drawCigar(hx, hy, a, r, time); // владелец 07.10: у Дона сигара; в командах — у того, кто довёз знамя
    if (!fade && bazooka.has(sn.id)) drawBazooka(hx, hy, a, r);
    if (!fade && bombIds.has(sn.id)) { drawCarriedBomb(hx, hy, a, r, time, 1); if (bombIds.get(sn.id) > 1) drawCarriedBomb(hx, hy, a, r, time + 400, -1); } // вторая бомба — с другого бока
    if (meta && !fade && !TEAM_MODE && meta.role === KILLER && neck) drawKillerBelt(neck, r, meta.bot || knifeIds.has(sn.id)); // ремень с кинжалом в ножнах
    if (TEAM_MODE && !fade && hotIds.has(sn.id)) { const fs = Math.max(18, r * 2.2) * (1 + 0.12 * Math.sin(time * 0.02)); ctx.font = `${fs}px Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('🔥', hx, hy - r - fs * 0.45); }
    if (meta && !fade && meta.role === DON) drawBodyText(cnt, sn.r, meta.bot ? 'ДОН МАФИИ' : meta.name.toUpperCase() + ' ★ ДОН', time, view); // надпись по всему телу Дона
    else if (!fade && sk.text) drawBodyText(cnt, sn.r, sk.text, time, view, 0.25, sk.textColor, sk.textStroke); // особый скин с надписью (Альмано, Марми)
    if (TEAM_MODE && meta && !fade && meta.team >= 0) { // командный режим: у всех табличка команды; у людей ниже — ник
      const bk = Math.min(cnt - 1, Math.round(sn.r * 4.2 / sp));
      const talkingP = !meta.bot && window.VoiceChat && VoiceChat.isSpeaking(meta.name);
      if (bk > 2) drawBackPlate(sn.id, 0, SX[bk], SY[bk], a, sn.r, sn.boost, time, '', meta.bot ? (TEAM_MODE ? '' : meta.name) : (talkingP ? '🔊 ' : '') + meta.name, meta.team);
    } else if (meta && !fade && (meta.role || 0) >= BACK_PLATE_MIN) { // табличка роли на спине у старших ролей
      const bk = Math.min(cnt - 1, Math.round(sn.r * 4.2 / sp));
      const talkingP = !meta.bot && window.VoiceChat && VoiceChat.isSpeaking(meta.name);
      if (bk > 2) drawBackPlate(sn.id, meta.role, SX[bk], SY[bk], a, sn.r, sn.boost, time, bandColor(sk.cols, 0), (talkingP ? '🔊 ' : '') + meta.name); // у ботов тоже ник (владелец 11.10)
    }
    // Имя — белое полупрозрачное под змейкой, как в оригинале
    if (meta && !fade) {
      // Владелец 06.10: ники только на табличке на спине; под головой ничего. У Мирного (без таблички) — лишь 🔊, когда говорит
      if (!meta.bot && (meta.role || 0) < BACK_PLATE_MIN && window.VoiceChat && VoiceChat.isSpeaking(meta.name)) {
        ctx.font = `${16 / cam.s}px Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText('🔊', hx, hy + r + 6 / cam.s);
      }
    }
  }
  if (fade) ctx.globalAlpha = 1;
}

// Строка замеров внизу экрана: кадры в секунду, пинг, запас плавности — чтобы видеть, что тормозит
let lowSecs = 0, autoLow = 0; // 1 — чёткость 1×, 2 — ещё и упрощённые змеи
let fpsCount = 0, fpsT = performance.now(), netFrames = 0, netJerks = 0, netT = performance.now(); // кадров от сервера за секунду; пауз между ними дольше 150 мс
setInterval(() => {
  const now = performance.now(), fps = Math.round(fpsCount * 1000 / (now - fpsT));
  // Авто-облегчение на телефоне: если кадров мало несколько секунд подряд — сначала снижаем чёткость, потом упрощаем змей
  if (isTouch && alive && hiQ) {
    if (fps < 40) lowSecs++; else lowSecs = 0;
    if (lowSecs >= 3 && autoLow < 2) { autoLow++; lowSecs = 0; resize(); }
  }
  fpsCount = 0; fpsT = now;
  // Владелец 07.10: надпись-замер во время игры — что тормозит: связь (пинг, кадры от сервера, рывки) или телефон (кадры экрана)
  { const secs = Math.max(1, (now - netT) / 1000), srv = Math.round(netFrames / secs), jerks = netJerks; netFrames = 0; netJerks = 0; netT = now; // делим на настоящее прошедшее время (вкладка могла уходить в фон)
    const bad = (v, b) => v ? ' style="color:#ff6b6b"' : '';
    $('netInfo').innerHTML = alive ? `<span${bad(pingMs > 150)}>📶 ${pingMs} мс</span> · <span${bad(srv < 26)}>сервер ${srv}/30</span>${jerks ? ` · <span style="color:#ff6b6b">рывки ${jerks}</span>` : ''} · <span${bad(fps < 40)}>экран ${fps} к/с</span>` : ''; }
  // Владелец 06.10: внизу только маленькая цифра без подписи — сколько живых людей сейчас в игре (боты не считаются)
  $('ping').textContent = lb && typeof lb.players === 'number' ? String(lb.players) : '';
  if (window.VoiceChat) VoiceChat.tick(alive, lb && typeof lb.online === 'number' ? lb.online : 0); // общий голос: когда на сайте есть кто-то ещё
  if (pnShowUntil > Date.now()) showPlayerNames(); else $('pnList').classList.add('hide');
  if (visShowUntil > Date.now()) showVisits(); else $('visList').classList.add('hide');
}, 1000);
// Нажатие на цифру внизу — на 5 секунд показать ники живых людей в игре
let pnShowUntil = 0, visData = null; // посетители [сегодня, 7 дней, 30 дней]
function showPlayerNames() {
  const list = (lb && lb.pn) || [], el = $('pnList');
  el.innerHTML = list.length ? list.map(([n, sc]) => `<div>${esc(n)} <span>${sc}</span></div>`).join('') : '<div>в игре никого</div>';
  el.classList.remove('hide');
}
$('ping').addEventListener('pointerdown', e => { e.stopPropagation(); visShowUntil = 0; $('visList').classList.add('hide'); pnShowUntil = Date.now() + 5000; showPlayerNames(); });
// Владелец 07.10: отдельная кнопка 👥 — сколько людей заходили в игру за день, неделю и месяц (на 5 секунд)
let visShowUntil = 0;
function showVisits() {
  const v = visData, el = $('visList');
  el.innerHTML = v ? `<div class="vh">Заходили в игру</div><div>Сегодня <b>${v[0]}</b></div><div>За неделю <b>${v[1]}</b></div><div>За месяц <b>${v[2]}</b></div>${v[3] != null ? `<div>📲 Установили <b>${v[3]}</b></div>` : ''}` : '<div>считаем…</div>';
  el.classList.remove('hide');
}
$('visBtn').addEventListener('pointerdown', e => { e.stopPropagation(); pnShowUntil = 0; $('pnList').classList.add('hide'); visShowUntil = Date.now() + 5000; showVisits(); });
function frame(time) {
  requestAnimationFrame(frame);
  fpsCount++;
  sendInput();
  const tickMs = 1000 / TICK_RATE;
  interpTicks += (interpWant - interpTicks) * (interpWant > interpTicks ? 0.06 : 0.01); // запас растёт быстро (после рывка), уменьшается медленно — картинка не дёргается
  const renderTick = tickOffset === null ? 0 : performance.now() / tickMs + tickOffset - interpTicks;
  applyFood(renderTick);
  const world = interpolated(renderTick);

  let me = null;
  // Своя змейка — по предсказанию (мгновенный отклик), остальные — по снимкам сервера
  const latestMe = alive && snaps.length ? snaps[snaps.length - 1].sn.get(myId) : null;
  if (world && alive && latestMe && latestMe.idx[0] === 0) me = predStep(latestMe);
  else if (pred.on && !alive) predStop();
  if (me && world) world.list = world.list.filter(s => s.id !== myId);
  Sound.boost(!!(me && me.boost));
  if (me) {
    // «Взгляд вперёд» (владелец 06.10): камера плавно сдвигается по ходу движения — впереди видно больше
    const L = Math.min(W, H) / 2 / cam.s * 0.22, tx = Math.cos(me.a) * L, ty = Math.sin(me.a) * L;
    look.x += (tx - look.x) * 0.04; look.y += (ty - look.y) * 0.04;
    // Владелец 11.10: камера не прыгает (потайной ход, появление) — плавно доплывает за ~0,5 с
    const nx = me.xs[0] + look.x, ny = me.ys[0] + look.y;
    if (camLag.has && Math.abs(nx - camLag.tx) + Math.abs(ny - camLag.ty) > 300) { camLag.x = cam.x - nx; camLag.y = cam.y - ny; } // голова перескочила — камера начинает с того места, где была
    camLag.tx = nx; camLag.ty = ny; camLag.has = true;
    camLag.x *= 0.9; camLag.y *= 0.9; if (Math.abs(camLag.x) + Math.abs(camLag.y) < 0.5) camLag.x = camLag.y = 0;
    cam.x = nx + camLag.x; cam.y = ny + camLag.y;
  } else if (world) { look.x *= 0.9; look.y *= 0.9; cam.x += (world.vx - cam.x) * 0.15; cam.y += (world.vy - cam.y) * 0.15; }
  const target = viewScale(W, H, me ? me.r : 10, me && metas.get(myId) ? metas.get(myId).role : 0, TEAM_MODE && me ? me.mass : 0, !!(me && metas.get(myId) && metas.get(myId).sk.id === window.Skins.EYE_ID));
  farView = TEAM_MODE && me && teamZoom(me.mass) < 0.8; // камера высоко — рисуем проще, чтобы телефон не тормозил
  cam.s += (target - cam.s) * 0.06;

  const s = cam.s;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = BG.floor; ctx.fillRect(0, 0, W, H);
  const shk = shakeUntil > performance.now() ? (shakeUntil - performance.now()) / 450 * 9 : 0; // тряска экрана после попадания из базуки
  const shx = shk ? (Math.random() - 0.5) * 2 * shk : 0, shy = shk ? (Math.random() - 0.5) * 2 * shk : 0;
  ctx.setTransform(DPR * s, 0, 0, DPR * s, DPR * (W / 2 - cam.x * s + shx), DPR * (H / 2 - cam.y * s + shy));
  worldT.k = DPR * s; worldT.tx = DPR * (W / 2 - cam.x * s + shx); worldT.ty = DPR * (H / 2 - cam.y * s + shy);
  const view = { x0: cam.x - W / 2 / s, x1: cam.x + W / 2 / s, y0: cam.y - H / 2 / s, y1: cam.y + H / 2 / s };

  // Фон и граница карты
  if (!bgPattern) makeBg();
  ctx.fillStyle = bgPattern; ctx.fillRect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0);
  ctx.beginPath(); ctx.rect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0); ctx.arc(0, 0, MAP_R, 0, TAU);
  ctx.fillStyle = 'rgba(90, 0, 10, 0.55)'; ctx.fill('evenodd');
  ctx.beginPath(); ctx.arc(0, 0, MAP_R, 0, TAU); ctx.lineWidth = 14; ctx.strokeStyle = 'rgba(255, 50, 70, 0.75)'; ctx.stroke();
  drawPosters(view);
  drawPortals(view, time);

  // Еда
  const tt = time * 0.003;
  for (const f of foods.values()) {
    if (f.x < view.x0 - 40 || f.x > view.x1 + 40 || f.y < view.y0 - 40 || f.y > view.y1 + 40) continue;
    const pulse = 1 + 0.12 * Math.sin(tt * 2 + f.ph);
    // Низкое качество: маленький ореол — в разы меньше закрашиваемых пикселей
    const hq = hiQ && !farView, sz = f.r * pulse * (hq ? SPR / FOOD_CORE * FOOD_K : 3.2), spr = hq ? foodSprite(f.col) : foodDot(f.col);
    ctx.drawImage(spr, f.x + Math.sin(tt + f.ph) * 1.5 - sz / 2, f.y + Math.cos(tt * 1.3 + f.ph) * 1.5 - sz / 2, sz, sz);
  }
  if (BASES) drawBases(view, time);
  // Светящиеся шары (командный режим): плавно между обновлениями, пульсирующее сияние
  if (orbs.size) {
    const nowO = performance.now();
    for (const o of orbs.values()) {
      const k = Math.min(1.5, (nowO - o.t) / 100), x = o.px + (o.x - o.px) * k, y = o.py + (o.y - o.py) * k;
      if (x < view.x0 - 120 || x > view.x1 + 120 || y < view.y0 - 120 || y > view.y1 + 120) continue;
      const p = 1 + 0.18 * Math.sin(time * 0.012 + o.x * 0.01), hs = 22 * 7 * p;
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(haloSprite('#7df9ff'), x - hs / 2, y - hs / 2, hs, hs);
      ctx.drawImage(haloSprite('#ffffff'), x - hs / 4, y - hs / 4, hs / 2, hs / 2);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(x, y, 22 * 0.55 * p, 0, TAU); ctx.fill();
    }
  }
  // Еда, которую засасывает в рот
  const now = performance.now();
  for (let i = eatAnims.length - 1; i >= 0; i--) {
    const e = eatAnims[i], k = (now - e.t0) / 180;
    const h = lastHeads.get(e.eater);
    if (k >= 1 || !h) { eatAnims.splice(i, 1); continue; }
    const x = e.f.x + (h.x - e.f.x) * k, y = e.f.y + (h.y - e.f.y) * k, sz = e.f.r * (1 - k) * SPR / FOOD_CORE * FOOD_K;
    ctx.drawImage(foodSprite(e.f.col), x - sz / 2, y - sz / 2, sz, sz);
  }

  // Тела погибших змей тают
  for (let i = dying.length - 1; i >= 0; i--) {
    const d = dying[i], k = (now - d.t0) / DIE_MS;
    if (k >= 1) { dying.splice(i, 1); continue; }
    drawSnake(d.sn, d.meta, false, time, view, k);
  }

  // Змейки: мелкие снизу, своя — поверх всех
  if (world) {
    lastHeads.clear(); lastDrawn.clear();
    const list = world.list.slice().sort((a, b) => a.mass - b.mass);
    for (const sn of list) { lastDrawn.set(sn.id, sn); if (sn !== me) drawSnake(sn, metas.get(sn.id), false, time, view); }
    if (me) drawSnake(me, metas.get(me.id), true, time, view);
  }
  if (BASES) drawFlags(time);
  if (bombsFly.size) drawFlyingBombs(time);
  if (knivesFly.size || knifeSparks.length) drawFlyingKnives(time);
  if (rocketsFly.size || booms.length || smoke.length) drawRockets(time);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (evNow && evNow[0] === 'night') drawNight(me);
  if (alive) { if (myMass !== shownMass) { shownMass = myMass; $('len').textContent = myMass; } drawMinimap(me); } // текст меняем только когда изменился
  renderEventArrow(me);
}

// Миникарта как в оригинале: змеи — серыми линиями (где их много, там гуще), живые игроки — жёлтыми, вы — белая точка
let mmLines = [];
// ===== События и рекорды (владелец 06.10) =====
let evNow = null, evAt = 0, recData = null, recHtml = '', winHtml = '';
function evLeft() { return evNow ? Math.max(0, evNow[1] - Math.floor((performance.now() - evAt) / 1000)) : 0; }
function renderEvent() {
  const el = $('evPill');
  if (!evNow) { el.classList.add('hide'); return; }
  const t = evLeft(), mmss = Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
  el.innerHTML = (evNow[0] === 'night' ? '🌙 Ночь мафии' : '🍅 Золотая еда') + ' · ' + mmss + (evNow[0] === 'gold' ? ' <span id="evArrow">➤</span>' : '');
  el.className = evNow[0];
}
setInterval(renderEvent, 1000);
// Стрелка в плашке показывает, куда ехать за золотой едой
function renderEventArrow(me) {
  const ar = document.getElementById('evArrow'); if (!ar || !evNow || evNow[0] !== 'gold') return;
  const fx = me ? me.xs[0] : cam.x, fy = me ? me.ys[0] : cam.y;
  ar.style.transform = `rotate(${Math.atan2(evNow[3] - fy, evNow[2] - fx)}rad)`;
}
// Ночь: всё затемнено, светлый круг только вокруг своей змеи; плавно темнеет в начале и светлеет в конце
function drawNight(me) {
  const total = 60, t = evLeft(), passed = total - t;
  const k = Math.min(1, passed / 3, t / 3); if (k <= 0) return;
  const cx = W / 2, cy = H / 2, R = 380 * cam.s * (me ? 1 + me.r / 60 : 1);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const g = ctx.createRadialGradient(cx, cy, R * 0.45, cx, cy, R);
  g.addColorStop(0, 'rgba(2, 4, 12, 0)'); g.addColorStop(1, `rgba(2, 4, 12, ${0.93 * k})`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
function renderRecords() {
  const el = $('records'); if (!recData) return;
  const row = (list, i) => list[i] ? `<div class="rr"><span>${i + 1}. ${esc(list[i][0])}</span><b>${list[i][1]}</b></div>` : '';
  const col = (title, list) => `<div class="rc"><div class="rt">${title}</div>${list.length ? list.map((_, i) => row(list, i)).join('') : '<div class="rr empty">пока пусто</div>'}</div>`;
  let html;
  if (TEAM_MODE) html = `<div class="rh">🏆 Рекорды команд</div><div class="rcols">${col('Сегодня', recData.day)}${col('Всех времён', recData.all)}</div>`;
  else { // владелец 11.10: топ-5 всех времён — карточки с фото колонкой справа (без фото — первая буква ника); внизу — только «Сегодня»
    // владелец 11.10: без медалей — только «ТОП N»
    const cards = recData.all.map(([n, sc, v], i) => `<div class="wcard wc${i + 1}" data-i="${i}"><div class="wimg">${v ? `<img src="/wp?n=${encodeURIComponent(n)}&v=${v}" alt="">` : `<span>${esc(([...n][0] || '?').toUpperCase())}</span>`}</div>`
      + `<i class="wmedal">ТОП ${i + 1}</i><div class="wcap"><b>${esc(n)}</b><span>${sc}</span></div></div>`).join('');
    const dots = recData.all.map((_, i) => `<button data-i="${i}" aria-label="Место ${i + 1}"></button>`).join('');
    const wHtml = cards ? `<div class="wtitle">🏆 Топ-5 всех времён</div><div class="deck">${cards}</div><div class="wdots">${dots}</div>` : '';
    if (wHtml !== winHtml) { $('winCards').innerHTML = wHtml; winHtml = wHtml; deckShow(Math.min(deckCur, recData.all.length - 1), true); } // раз в 5 с приходит то же самое — не перерисовываем, чтобы фото не мигали
    $('winCards').classList.toggle('hide', !cards);
    html = `<div class="rh">🏆 Рекорды дня</div><div class="rcols">${col('Сегодня', recData.day)}</div>`;
  }
  if (html !== recHtml) { el.innerHTML = html; recHtml = html; }
  el.classList.remove('hide');
}
// ===== Карусель карточек победителей (владелец 11.10): большая карточка впереди, следующие — веером за ней;
// каждые 4 с передняя улетает влево, выходит следующая. Нажатие — следующая, точки — выбрать место; мышь над колодой — пауза.
let deckCur = 0, deckHover = false;
function deckShow(next, instant) {
  const cards = [...document.querySelectorAll('#winCards .wcard')], n = cards.length; if (!n) return;
  const prev = deckCur; deckCur = ((next % n) + n) % n;
  cards.forEach((c, k) => {
    const pos = Math.min(3, (k - deckCur + n) % n);
    c.classList.remove('p0', 'p1', 'p2', 'p3', 'out');
    c.classList.add(!instant && k === prev && prev !== deckCur ? 'out' : 'p' + pos);
    if (c.classList.contains('out')) setTimeout(() => { if (!c.classList.contains('out')) return; c.classList.remove('out'); c.classList.add('p' + Math.min(3, (k - deckCur + n) % n)); }, 650);
  });
  document.querySelectorAll('#winCards .wdots button').forEach((b, k) => b.classList.toggle('on', k === deckCur));
}
setInterval(() => { if (!deckHover && document.body.classList.contains('in-menu') && !document.hidden) deckShow(deckCur + 1); }, 4000);
$('winCards').addEventListener('click', e => {
  const dot = e.target.closest('.wdots button');
  if (dot) deckShow(+dot.dataset.i); else if (e.target.closest('.deck')) deckShow(deckCur + 1);
});
$('winCards').addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') deckHover = true; });
$('winCards').addEventListener('pointerleave', () => { deckHover = false; });
function showRecord(kind) {
  const el = $('promo');
  el.className = 'don rec'; el.style.setProperty('--rc', '#ffd52e'); // rec — компактная табличка (владелец 11.10: «слишком большая»)
  el.innerHTML = `<div class="pi">🏆</div><div class="pn">${kind === 'all' ? 'РЕКОРД ВСЕХ ВРЕМЁН' : 'РЕКОРД ДНЯ'}</div><div class="ps">${esc(myName())}, вы — лучший${kind === 'all' ? ' за всё время' : ' сегодня'}!</div>`;
  void el.offsetWidth; el.classList.add('show');
  clearTimeout(promoT); promoT = setTimeout(() => el.classList.remove('show'), 3500);
  Sound.promo(true);
}

function drawMinimap(me) {
  const w = mm.width, c = w / 2, R = w / 2 - 3, k = w / 130;
  mctx.clearRect(0, 0, w, w);
  mctx.fillStyle = 'rgba(40, 46, 56, 0.55)'; mctx.beginPath(); mctx.arc(c, c, R, 0, TAU); mctx.fill();
  mctx.strokeStyle = 'rgba(255, 255, 255, 0.18)'; mctx.lineWidth = 1.5 * k; mctx.stroke();
  const P = v => c + (v / 127.5 - 1) * R;
  mctx.lineCap = 'round'; mctx.lineJoin = 'round';
  for (let pass = 0; pass < 2; pass++) { // сначала боты, поверх — люди
    for (const line of mmLines) {
      const human = (line[0] & 1) === 1, lt = (line[0] >> 1) - 1;
      if (human !== (pass === 1)) continue;
      // Командный режим: свои — цвет своей команды, соперники — красные
      mctx.strokeStyle = TEAM_MODE && lt >= 0 ? (lt === myTeam || myTeam < 0 ? TEAM_COL[lt] : (human ? '#ff6b6b' : 'rgba(255, 70, 70, 0.75)'))
        : human ? 'rgba(255, 213, 79, 0.9)' : 'rgba(200, 205, 215, 0.55)';
      if (TEAM_MODE && lt >= 0 && myTeam < 0) mctx.strokeStyle = TEAM_COL[lt];
      mctx.lineWidth = (human ? 1.8 : 1.1) * k;
      mctx.beginPath(); mctx.moveTo(P(line[1]), P(line[2]));
      if (line.length <= 5) mctx.lineTo(P(line[1]) + 0.5, P(line[2]) + 0.5);
      for (let i = 3; i < line.length; i += 2) mctx.lineTo(P(line[i]), P(line[i + 1]));
      mctx.stroke();
    }
  }
  if (me) {
    const x = c + me.xs[0] / MAP_R * R, y = c + me.ys[0] / MAP_R * R;
    mctx.fillStyle = '#ffffff'; mctx.beginPath(); mctx.arc(x, y, 3.2 * k, 0, TAU); mctx.fill();
  }
  if (BASES) { // базы — кольца цвета команды, знамёна — квадратики, тревога своих — мигающие красные круги
    BASES.forEach(([bx, by], t) => { mctx.strokeStyle = TEAM_COL[t]; mctx.lineWidth = 1.6 * k; mctx.beginPath(); mctx.arc(c + bx / MAP_R * R, c + by / MAP_R * R, Math.max(4 * k, BASE_R / MAP_R * R), 0, TAU); mctx.stroke(); });
    teamFlags.forEach((f, t) => { const s = 4.5 * k; mctx.fillStyle = TEAM_COL[t]; mctx.strokeStyle = '#000'; mctx.lineWidth = 1; mctx.fillRect(c + f[0] / MAP_R * R - s / 2, c + f[1] / MAP_R * R - s / 2, s, s); mctx.strokeRect(c + f[0] / MAP_R * R - s / 2, c + f[1] / MAP_R * R - s / 2, s, s); });
    if (teamAlarms.length && Math.floor(performance.now() / 300) % 2) for (const [ax, ay] of teamAlarms) { mctx.strokeStyle = '#ff2b2b'; mctx.lineWidth = 2 * k; mctx.beginPath(); mctx.arc(c + ax / MAP_R * R, c + ay / MAP_R * R, 5 * k, 0, TAU); mctx.stroke(); }
  }
  if (!TEAM_MODE) for (const pair of window.Portals.PORTALS) for (const [px, py] of pair) { // потайные ходы — оранжевые точки
    mctx.fillStyle = '#ff9a2e'; mctx.beginPath(); mctx.arc(c + px / MAP_R * R, c + py / MAP_R * R, 2.4 * k, 0, TAU); mctx.fill();
  }
  for (const o of orbs.values()) { // светящиеся шары на миникарте — голубые точки
    mctx.fillStyle = '#7df9ff'; mctx.beginPath(); mctx.arc(c + o.x / MAP_R * R, c + o.y / MAP_R * R, 2.6 * k, 0, TAU); mctx.fill();
  }
  if (evNow && evNow[0] === 'gold') { // золотая еда на миникарте — пульсирующая точка
    const gx = c + evNow[2] / MAP_R * R, gy = c + evNow[3] / MAP_R * R, p = 1 + 0.35 * Math.sin(performance.now() * 0.008);
    mctx.fillStyle = '#ffd52e'; mctx.shadowColor = '#ffd52e'; mctx.shadowBlur = 8 * k;
    mctx.beginPath(); mctx.arc(gx, gy, 4.5 * k * p, 0, TAU); mctx.fill(); mctx.shadowBlur = 0;
  }
}

// ===== Рейтинг: топ-10, как в slither.io — у каждой строки свой цвет =====
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const LB_COLORS = ['#ff9d9d', '#ffc09d', '#ffe39d', '#d4ff9d', '#9dffb4', '#9dffe8', '#9de2ff', '#9db8ff', '#c49dff', '#ff9de6'];
function renderLb() {
  if (!lb) return;
  let html = '';
  lb.top.forEach(([name, score, id, tm], i) => {
    const me = id === myId && alive;
    html += `<div class="row${me ? ' me' : ''}" style="color:${TEAM_MODE && tm >= 0 ? (tm ? '#ff8a1f' : '#ffffff') : LB_COLORS[i]}"><span class="p">#${i + 1}</span><span class="n">${esc(name)}</span><span class="s">${score}</span></div>`;
  });
  if (alive && lb.rank > 10) html += `<div class="row me sep"><span class="p">#${lb.rank}</span><span class="n">${esc(myName())}</span><span class="s">${lb.score}</span></div>`;
  $('lb-rows').innerHTML = html;
  $('rank').innerHTML = alive && lb.rank ? `Ваше место: <b>${lb.rank}</b> из ${lb.total}` : '';
}

// ===== Командный режим: счёт, таймер, конец раунда, меню =====
// Громкость выстрела/взрыва по расстоянию от своей змеи (владелец 11.10): рядом — во всю, далеко — тихо
function nearVol(x, y) { const h = lastHeads.get(myId) || { x: cam.x, y: cam.y }; return Math.max(0.12, Math.min(1, 1 - Math.hypot(x - h.x, y - h.y) / 2600)); }
const mmss = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
function renderTeamBar() {
  const b = $('teamBar');
  if (!TEAM_MODE || !teamTm) { b.classList.add('hide'); return; }
  const [a, c, left, h0, h1, pause] = teamTm;
  b.classList.remove('hide');
  const fin = !pause && left <= 60;
  if (fin && alive && left !== lastBeat) { lastBeat = left; Sound.beat(left <= 10); }
  b.innerHTML = `<span class="t0${myTeam === 0 ? ' me' : ''}">⚪ Мирные ${a}</span><span class="clk${fin ? ' fin' : ''}">⏱ ${pause ? 'перерыв' : mmss(left)}${fin ? ' ×2' : ''}</span><span class="t1${myTeam === 1 ? ' me' : ''}">${c} Мафия 🟠</span>`;
  b.title = `Людей: Мирные ${h0}, Мафия ${h1}`;
}
function onRoundEnd(m) {
  const wasAlive = alive;
  alive = false; myId = 0; predStop();
  const w = m.winner, mine = myTeam >= 0 && w === myTeam;
  const head = w < 0 ? '🤝 Ничья!' : `🏆 Победила ${TEAM_ICON[w]} ${TEAM_NAME[w]}!`;
  const best = m.best ? `<div class="sub">Лучший игрок: <b>${esc(m.best[0])}</b> ${m.best[2] >= 0 ? TEAM_ICON[m.best[2]] : ''} — длина ${m.best[1]}</div>` : '';
  $('roundBanner').innerHTML = `<div class="big">${head}</div>${myTeam >= 0 && w >= 0 ? `<div>${mine ? 'Ваша команда победила! 🎉' : 'Ваша команда проиграла'}</div>` : ''}`
    + `<div class="sc">⚪ ${m.scores[0]} : ${m.scores[1]} 🟠</div>${best}`
    + ((m.awards || []).length ? `<div class="aw">${m.awards.map(([ic, ti, nm, tm, v]) => `<div>${ic} ${ti}: <b>${esc(nm)}</b> ${tm >= 0 ? TEAM_ICON[tm] : ''} — ${v}</div>`).join('')}</div>` : '')
    + `<div class="sub" id="rbLeft">Новый раунд через ${m.pause} с</div>`;
  $('roundBanner').classList.remove('hide');
  let left = m.pause; const t = setInterval(() => { left--; const e = $('rbLeft'); if (!e || left <= 0) { clearInterval(t); return; } e.textContent = `Новый раунд через ${left} с`; }, 1000);
  if (wasAlive) { rejoinAfterRound = true; Sound.kill(); } // играл — после перерыва зайдёт в новый раунд сам
}
function setupModeMenu() {
  if (!TEAM_ENABLED) { $('modeRow').classList.add('hide'); return; } // командная игра выключена — кнопки нет
  $('modeBtn').textContent = TEAM_MODE ? '← Обычная игра' : '👥 Команда на команду';
  $('modeBtn').addEventListener('click', () => { location.href = location.pathname + (TEAM_MODE ? '' : '?mode=team'); });
  if (!TEAM_MODE) return;
  document.body.classList.add('team-mode');
  $('teamPick').classList.remove('hide'); $('inviteBtn').classList.remove('hide');
  const mark = () => { for (const b of document.querySelectorAll('#teamPick .tp')) b.classList.toggle('sel', String(teamChoice) === b.dataset.team); };
  for (const b of document.querySelectorAll('#teamPick .tp')) b.addEventListener('click', () => { teamChoice = b.dataset.team === 'auto' ? 'auto' : +b.dataset.team; mark(); Sound.click(); });
  mark();
  $('inviteBtn').addEventListener('click', async () => {
    const t = myTeam >= 0 ? myTeam : teamChoice === 'auto' ? null : teamChoice;
    const url = location.origin + location.pathname + '?mode=team' + (t === null ? '' : '&team=' + t);
    const text = t === null ? 'Заходи в Марми Мафию — команда на команду!' : `Заходи ко мне в команду ${TEAM_NAME[t]} в Марми Мафии!`;
    try { if (navigator.share) { await navigator.share({ title: 'Марми Мафия', text, url }); return; } } catch (e) { return; }
    try { await navigator.clipboard.writeText(url); toast('Ссылка скопирована — отправьте другу'); } catch (e) { prompt('Скопируйте ссылку:', url); }
  });
}
setupModeMenu();

// Командные новости (знамя украли, «в ударе», последняя минута) — крупная надпись сверху на 3 с
let bigT = 0;
function bigToast(text) { const e = $('bigToast'); e.textContent = text; e.classList.add('show'); clearTimeout(bigT); bigT = setTimeout(() => e.classList.remove('show'), 3000); }
// База команды: круг цвета команды на полу и надпись
function drawBases(view, time) {
  BASES.forEach(([x, y], t) => {
    if (x + BASE_R < view.x0 || x - BASE_R > view.x1 || y + BASE_R < view.y0 || y - BASE_R > view.y1) return;
    const fire = baseFireUntil[t] - performance.now();
    if (fire > 0) { // сияние: тёплый ореол и бегущие огни по краю
      const k = Math.min(1, fire / 4000), p = 0.5 + 0.5 * Math.sin(time * 0.01);
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = (0.25 + 0.2 * p) * k;
      const hs = BASE_R * 3.2; ctx.drawImage(haloSprite('#ffd52e'), x - hs / 2, y - hs / 2, hs, hs); ctx.drawImage(haloSprite(TEAM_COL[t]), x - hs / 3, y - hs / 3, hs / 1.5, hs / 1.5);
      ctx.globalAlpha = k;
      for (let i = 0; i < 24; i++) { const a = i / 24 * TAU + time * 0.0015, s = 26 + 10 * Math.sin(time * 0.012 + i); ctx.drawImage(haloSprite(i & 1 ? '#ffd52e' : TEAM_COL[t]), x + Math.cos(a) * BASE_R - s, y + Math.sin(a) * BASE_R - s, s * 2, s * 2); }
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 0.13; ctx.fillStyle = TEAM_COL[t]; ctx.beginPath(); ctx.arc(x, y, BASE_R, 0, TAU); ctx.fill();
    ctx.globalAlpha = 0.75; ctx.setLineDash([28, 18]); ctx.lineDashOffset = -time * 0.02; ctx.lineWidth = 8; ctx.strokeStyle = TEAM_COL[t]; ctx.stroke(); ctx.setLineDash([]);
    ctx.globalAlpha = 0.55; ctx.fillStyle = TEAM_COL[t]; ctx.font = 'bold 46px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('БАЗА ' + TEAM_NAME[t].toUpperCase(), x, y + BASE_R * 0.62); ctx.globalAlpha = 1;
  });
}
// Знамя: древко и развевающееся полотнище; у того, кто несёт, — над головой
function drawFlags(time) {
  teamFlags.forEach(([fx, fy, carrier], t) => {
    let x = fx, y = fy, sc = 1;
    if (carrier) { const h = lastHeads.get(carrier); if (h && Math.hypot(h.x - fx, h.y - fy) < 250) { x = h.x; y = h.y; } sc = 0.8; } // голова на экране — точно над ней
    const H = 90 * sc, W = 58 * sc, w = Math.sin(time * 0.008 + t) * 6 * sc;
    ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 5 * sc; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - H); ctx.stroke();
    ctx.fillStyle = TEAM_COL[t]; ctx.strokeStyle = t ? '#1c1c1e' : '#9aa0a8'; ctx.lineWidth = 2.5 * sc;
    ctx.beginPath(); ctx.moveTo(x, y - H); ctx.quadraticCurveTo(x + W / 2, y - H - 8 * sc + w, x + W, y - H + 4 * sc + w);
    ctx.lineTo(x + W, y - H + 34 * sc + w); ctx.quadraticCurveTo(x + W / 2, y - H + 26 * sc - w, x, y - H + 32 * sc); ctx.closePath(); ctx.fill(); ctx.stroke();
    if (!carrier) { ctx.globalAlpha = 0.35 + 0.25 * Math.sin(time * 0.006); ctx.strokeStyle = TEAM_COL[t]; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, 45, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1; }
  });
}

// ===== Базука (владелец 11.10: реалистичная, не мультяшная) — гранатомёт вроде РПГ-7 =====
// Рисуется один раз в заготовку (на каждый размер) и дальше только копируется с поворотом.
// В заготовке гранатомёт смотрит вправо (+x): сзади раструб, оливковая труба, деревянная накладка, прицел, рукоять, спереди граната.
function launcherSprite(r) {
  const k = PX_PER_UNIT(), R = Math.max(6, Math.round(r / 2) * 2), L = R * 3.4, T = R * 0.36, H = R * 1.25;
  const w = L, h = H * 2;
  const img = cacheCanvas('rpg|' + R + '|' + k, w * k, h * k, g => {
    g.scale(k, k); g.translate(0, H);
    const tube = (x0, x1, rr, c0, c1, c2) => { const gr = g.createLinearGradient(0, -rr, 0, rr); gr.addColorStop(0, c0); gr.addColorStop(0.35, c1); gr.addColorStop(1, c2); g.fillStyle = gr; g.fillRect(x0, -rr, x1 - x0, rr * 2); };
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.ellipse(L * 0.5, T * 1.6, L * 0.48, T * 0.8, 0, 0, TAU); g.fill(); // тень на полу
    // задний раструб
    const gr0 = g.createLinearGradient(0, -T * 1.6, 0, T * 1.6); gr0.addColorStop(0, '#5b5f62'); gr0.addColorStop(0.4, '#9aa0a4'); gr0.addColorStop(1, '#2a2c2e');
    g.fillStyle = gr0; g.beginPath(); g.moveTo(0, -T * 1.55); g.lineTo(L * 0.16, -T); g.lineTo(L * 0.16, T); g.lineTo(0, T * 1.55); g.closePath(); g.fill();
    g.fillStyle = '#111'; g.beginPath(); g.ellipse(0, 0, T * 0.35, T * 1.35, 0, 0, TAU); g.fill();
    tube(L * 0.16, L * 0.72, T, '#3c4231', '#7b8466', '#1e2219'); // труба — оливковый металл с бликом
    tube(L * 0.34, L * 0.56, T * 1.18, '#4d2f17', '#a8743f', '#3a2210'); // деревянная накладка
    g.strokeStyle = 'rgba(40, 20, 6, 0.55)'; g.lineWidth = Math.max(0.5, T * 0.08);
    for (let i = -2; i <= 2; i++) { g.beginPath(); g.moveTo(L * 0.34, i * T * 0.38); g.bezierCurveTo(L * 0.41, i * T * 0.38 + T * 0.12, L * 0.48, i * T * 0.38 - T * 0.1, L * 0.56, i * T * 0.38); g.stroke(); } // волокна дерева
    for (const x of [L * 0.33, L * 0.565, L * 0.7]) tube(x, x + L * 0.022, T * 1.22, '#2a2c2e', '#8d9296', '#1a1b1c'); // металлические хомуты
    g.fillStyle = '#1d1f1a'; g.fillRect(L * 0.6, -T * 1.75, L * 0.06, T * 0.62); g.fillRect(L * 0.585, -T * 1.25, L * 0.09, T * 0.28); // прицел
    g.fillStyle = '#26281f'; g.beginPath(); g.moveTo(L * 0.42, T); g.lineTo(L * 0.47, T); g.lineTo(L * 0.455, T * 1.9); g.lineTo(L * 0.4, T * 1.9); g.closePath(); g.fill(); // рукоять
    tube(L * 0.72, L * 0.79, T * 0.62, '#3a3d33', '#6b705e', '#20221c'); // шейка гранаты
    const gw = g.createLinearGradient(0, -T * 1.25, 0, T * 1.25); gw.addColorStop(0, '#3d4a2c'); gw.addColorStop(0.3, '#8b9a6a'); gw.addColorStop(1, '#1f2616');
    g.fillStyle = gw; g.beginPath(); g.moveTo(L * 0.79, -T * 0.62); g.quadraticCurveTo(L * 0.86, -T * 1.3, L * 0.92, -T * 0.9); g.lineTo(L, -T * 0.12); g.lineTo(L, T * 0.12); g.lineTo(L * 0.92, T * 0.9); g.quadraticCurveTo(L * 0.86, T * 1.3, L * 0.79, T * 0.62); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.45)'; g.lineWidth = Math.max(0.5, T * 0.07); g.stroke();
    g.fillStyle = '#c9a227'; g.fillRect(L * 0.83, -T * 1.08, L * 0.012, T * 2.16); // латунный поясок
  });
  return { img, w, h };
}
function drawBazooka(x, y, a, r) { // два гранатомёта по бокам головы, смотрят вперёд
  const S = launcherSprite(r), sc = r / Math.max(6, Math.round(r / 2) * 2), c = Math.cos(a), s = Math.sin(a), px = -s, py = c, off = r * 1.3;
  for (const side of [-1, 1]) {
    const bx = x + px * off * side - c * r * 1.6, by = y + py * off * side - s * r * 1.6;
    drawRotated(S.img, bx, by, a, S.w * sc, S.h * sc, 0, S.h * sc / 2);
  }
  resetWorldT();
}
// ===== Ножи Киллера (владелец 11.10, только для вида): два стальных ножа по бокам шеи — блестят, покачиваются,
// при ускорении разворачиваются вперёд, как для удара. На силу в игре не влияют. Заготовка рисуется один раз на размер.
const KILLER = ROLES.findIndex(x => x.name === 'Киллер');
function knifeSprite(r) {
  // Владелец 11.10: не ножи, а кинжалы — обоюдоострый клинок с ребром посередине (одна грань светлая, другая тёмная — как
  // настоящая сталь), стальная гарда с утолщениями, рукоять в кожаной обмотке, навершие. По металлу бежит блеск (drawKnives).
  const k = PX_PER_UNIT(), R = Math.max(6, Math.round(r / 2) * 2), L = R * 4.0, W = R * 1.0;
  return { img: cacheCanvas('dagger|' + R + '|' + k, L * k, W * k, g => {
    g.scale(k, k); g.translate(0, W / 2);
    const steel = (y0, y1, c) => { const gr = g.createLinearGradient(0, y0, 0, y1); c.forEach(([o, col]) => gr.addColorStop(o, col)); return gr; };
    // навершие — стальной шар с бликом
    g.fillStyle = steel(-W * 0.16, W * 0.16, [[0, '#f2f5f8'], [0.45, '#9aa2ab'], [1, '#3d434a']]);
    g.beginPath(); g.arc(L * 0.035, 0, W * 0.15, 0, TAU); g.fill();
    // рукоять: тёмная кожа с косой обмоткой
    g.fillStyle = steel(-W * 0.11, W * 0.11, [[0, '#5a3a22'], [0.5, '#2c1a0e'], [1, '#140b05']]);
    g.fillRect(L * 0.06, -W * 0.11, L * 0.2, W * 0.22);
    g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = Math.max(0.6, W * 0.035);
    for (let x = L * 0.07; x < L * 0.26; x += L * 0.028) { g.beginPath(); g.moveTo(x, -W * 0.11); g.lineTo(x + L * 0.02, W * 0.11); g.stroke(); }
    // гарда: стальная перекладина с утолщениями на концах
    g.fillStyle = steel(-W * 0.48, W * 0.48, [[0, '#ffffff'], [0.3, '#c9cfd6'], [0.65, '#7c848d'], [1, '#30353b']]);
    g.beginPath(); g.moveTo(L * 0.26, -W * 0.4); g.lineTo(L * 0.3, -W * 0.4); g.lineTo(L * 0.3, W * 0.4); g.lineTo(L * 0.26, W * 0.4); g.closePath(); g.fill();
    for (const sy of [-1, 1]) { g.beginPath(); g.arc(L * 0.28, sy * W * 0.42, W * 0.08, 0, TAU); g.fill(); }
    // клинок: верхняя грань светлая, нижняя тёмная, по середине — ребро
    const bx0 = L * 0.3, bw = W * 0.24;
    g.fillStyle = steel(-bw, 0, [[0, '#d6dce2'], [1, '#ffffff']]);
    g.beginPath(); g.moveTo(bx0, -bw); g.lineTo(L * 0.8, -bw * 0.8); g.lineTo(L, 0); g.lineTo(bx0, 0); g.closePath(); g.fill();
    g.fillStyle = steel(0, bw, [[0, '#8d959e'], [1, '#4a5058']]);
    g.beginPath(); g.moveTo(bx0, 0); g.lineTo(L, 0); g.lineTo(L * 0.8, bw * 0.8); g.lineTo(bx0, bw); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = Math.max(0.6, W * 0.025); g.beginPath(); g.moveTo(bx0, 0); g.lineTo(L * 0.98, 0); g.stroke(); // ребро
    g.strokeStyle = 'rgba(25, 30, 36, 0.7)'; g.lineWidth = Math.max(0.6, W * 0.03); // режущие кромки
    g.beginPath(); g.moveTo(bx0, -bw); g.lineTo(L * 0.8, -bw * 0.8); g.lineTo(L, 0); g.lineTo(L * 0.8, bw * 0.8); g.lineTo(bx0, bw); g.stroke();
  }), L, W };
}
// Владелец 11.10: кинжал не болтается — висит на ремне. Ремень опоясывает шею змеи (кожа, строчка, золотая пряжка),
// справа на ремне ножны вдоль тела, из них вперёд торчит рукоять. Метнул — на ремне остаются пустые ножны.
function drawKillerBelt(neck, r, hasKnife) {
  const [nx, ny, na] = neck, c = Math.cos(na), s = Math.sin(na), px = -s, py = c;
  ctx.save(); ctx.translate(nx, ny); ctx.rotate(na); // x — вперёд по ходу, y — поперёк (вправо)
  // ремень поперёк тела
  const bw = r * 0.42, bl = r * 1.08;
  const lg = ctx.createLinearGradient(-bw / 2, 0, bw / 2, 0); lg.addColorStop(0, '#2b1709'); lg.addColorStop(0.5, '#6b3f1d'); lg.addColorStop(1, '#2b1709');
  ctx.fillStyle = lg; ctx.fillRect(-bw / 2, -bl, bw, bl * 2);
  ctx.strokeStyle = 'rgba(230, 200, 150, 0.55)'; ctx.lineWidth = Math.max(0.6, r * 0.04); ctx.setLineDash([r * 0.12, r * 0.09]); // строчка
  ctx.beginPath(); ctx.moveTo(-bw * 0.32, -bl); ctx.lineTo(-bw * 0.32, bl); ctx.moveTo(bw * 0.32, -bl); ctx.lineTo(bw * 0.32, bl); ctx.stroke(); ctx.setLineDash([]);
  // золотая пряжка сверху (слева по ходу)
  const gb = ctx.createLinearGradient(0, -bl * 0.75, 0, -bl * 0.25); gb.addColorStop(0, '#fff1b0'); gb.addColorStop(0.5, '#d4a017'); gb.addColorStop(1, '#7a5a08');
  ctx.strokeStyle = gb; ctx.lineWidth = Math.max(1, r * 0.11); ctx.strokeRect(-bw * 0.62, bl * 0.3, bw * 1.24, bl * 0.42); // пряжка — справа, ножны — слева (справа их закрывала табличка)
  // Владелец 11.10: кинжал без ножен — открытый клинок вдоль тела острием назад, рукоять прижата к ремню кожаной петлёй
  if (hasKnife) {
    const S = knifeSprite(r), sc = r / Math.max(6, Math.round(r / 2) * 2) * 1.35, L = S.L * sc, W = S.W * sc, sy = -r * 1.15; // владелец 12.10: кинжал крупнее и заметнее
    ctx.save(); ctx.translate(L * 0.2, sy); ctx.rotate(Math.PI); ctx.drawImage(S.img, 0, -W / 2, L, W); ctx.restore(); // рукоять у ремня, клинок назад
    const lg2 = ctx.createLinearGradient(-bw / 2, 0, bw / 2, 0); lg2.addColorStop(0, '#2b1709'); lg2.addColorStop(0.5, '#7a4a22'); lg2.addColorStop(1, '#2b1709');
    ctx.fillStyle = lg2; ctx.fillRect(-bw * 0.45, sy - W * 0.3, bw * 0.9, W * 0.6); // петля ремня вокруг рукояти
    ctx.fillStyle = '#c9a227'; ctx.beginPath(); ctx.arc(0, sy, Math.max(1, r * 0.07), 0, TAU); ctx.fill(); // заклёпка
  }
  ctx.restore();
}
// ===== Потайные ходы (владелец 11.10): тёмная нора с оранжевым мерцающим краем и вихрем; вспышка, когда кто-то прошёл =====
const portalFx = [];
function drawPortals(view, time) {
  if (TEAM_MODE) return;
  const R = window.Portals.PORTAL_R, now = performance.now();
  for (const pair of window.Portals.PORTALS) for (const [x, y] of pair) {
    if (x < view.x0 - 120 || x > view.x1 + 120 || y < view.y0 - 120 || y > view.y1 + 120) continue;
    const pulse = 0.5 + 0.5 * Math.sin(time * 0.004 + x);
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.35 + 0.25 * pulse;
    const hs = R * 4.2; ctx.drawImage(haloSprite('#ff8a1f'), x - hs / 2, y - hs / 2, hs, hs);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    const g = ctx.createRadialGradient(x, y, 0, x, y, R); g.addColorStop(0, '#000000'); g.addColorStop(0.7, '#0a0604'); g.addColorStop(1, '#3a1a06');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = `rgba(255, ${150 + 60 * pulse | 0}, 40, 0.9)`; ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255, 170, 60, 0.55)'; // вихрь затягивает внутрь
    for (let i = 0; i < 3; i++) { const a0 = time * 0.003 + i * TAU / 3; ctx.beginPath(); ctx.arc(x, y, R * (0.35 + 0.18 * i), a0, a0 + 1.6); ctx.stroke(); }
  }
  for (let i = portalFx.length - 1; i >= 0; i--) { // вспышка-кольцо при проходе
    const f = portalFx[i], k = (now - f.t0) / 600; if (k >= 1) { portalFx.splice(i, 1); continue; } if (k < 0) continue;
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 1 - k;
    const hs = R * (2 + 5 * k); ctx.drawImage(haloSprite('#ffb040'), f.x - hs / 2, f.y - hs / 2, hs, hs);
    ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = '#ffd27a'; ctx.lineWidth = 4 * (1 - k); ctx.beginPath(); ctx.arc(f.x, f.y, R * (1 + 2.5 * k), 0, TAU); ctx.stroke(); ctx.globalAlpha = 1;
  }
}
// Летящий кинжал: вращается, за ним лёгкий след; при ударе — сноп искр
function drawFlyingKnives(time) {
  const now = performance.now(), S = knifeSprite(24), L = S.L * 1.2, W = S.W * 1.2; // крупнее, чтобы бросок было видно
  for (const [id, k] of knivesFly) {
    const dt = now - k.t0; if (dt > k.life + 300) { knivesFly.delete(id); continue; }
    const x = k.x + k.vx * dt, y = k.y + k.vy * dt, spin = dt * 0.03;
    ctx.globalCompositeOperation = 'lighter';
    for (let j = 1; j <= 3; j++) { ctx.globalAlpha = 0.18 / j; const hs = 34; ctx.drawImage(haloSprite('#dfe6ee'), x - k.vx * j * 22 - hs / 2, y - k.vy * j * 22 - hs / 2, hs, hs); }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    drawRotated(S.img, x, y, spin, L, W, L * 0.5, W / 2); resetWorldT();
  }
  ctx.globalCompositeOperation = 'lighter';
  for (let i = knifeSparks.length - 1; i >= 0; i--) {
    const p = knifeSparks[i], t = now - p.t0; if (t > 450) { knifeSparks.splice(i, 1); continue; }
    ctx.globalAlpha = 1 - t / 450; ctx.fillStyle = i % 3 ? '#fff4c2' : '#ffb347';
    ctx.beginPath(); ctx.arc(p.x + p.vx * t, p.y + p.vy * t, 3.2 * (1 - t / 450) + 0.8, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
}
// ===== Шляпа Шерифа (владелец 11.10: «кожаную, реальную»): ковбойская, вид сверху. Широкие поля загнуты по бокам,
// тулья с продольной вмятиной, кожа с потёртостями и строчкой по краю полей, плетёная лента с серебряной пряжкой.
// Рисуется один раз на размер в заготовку и дальше копируется с поворотом.
const SHERIFF = ROLES.findIndex(x => x.name === 'Шериф');
function sheriffHatSprite(r) {
  const k = PX_PER_UNIT(), R = Math.max(6, Math.round(r / 2) * 2), W = R * 2.5, H = R * 3.1; // x — вперёд по ходу, y — поперёк (поля шире змеи)
  return { img: cacheCanvas('shat|' + R + '|' + k, W * k, H * k, g => {
    g.scale(k, k); g.translate(W / 2, H / 2);
    const rx = W * 0.46, ry = H * 0.46;
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.beginPath(); g.ellipse(R * 0.1, R * 0.12, rx, ry * 0.95, 0, 0, TAU); g.fill(); // тень на змее
    // поля: кожа с тёплым переливом; бока (по y) загнуты вверх — светлее и с тенью у загиба
    const br = g.createRadialGradient(-R * 0.2, -R * 0.2, R * 0.2, 0, 0, rx); br.addColorStop(0, '#9a6234'); br.addColorStop(0.6, '#7a4622'); br.addColorStop(1, '#4e2a12');
    g.fillStyle = br; g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, TAU); g.fill();
    for (const sg of [-1, 1]) { // загнутые края полей
      const cg = g.createLinearGradient(0, sg * ry * 0.45, 0, sg * ry); cg.addColorStop(0, 'rgba(0,0,0,0.35)'); cg.addColorStop(0.5, 'rgba(255,220,170,0.18)'); cg.addColorStop(1, 'rgba(60,30,10,0.5)');
      g.fillStyle = cg; g.beginPath(); g.ellipse(0, sg * ry * 0.72, rx * 0.86, ry * 0.3, 0, 0, TAU); g.fill();
    }
    g.setLineDash([R * 0.14, R * 0.1]); g.strokeStyle = 'rgba(240, 210, 160, 0.55)'; g.lineWidth = Math.max(0.6, R * 0.05); // строчка по краю
    g.beginPath(); g.ellipse(0, 0, rx * 0.9, ry * 0.88, 0, 0, TAU); g.stroke(); g.setLineDash([]);
    g.strokeStyle = '#3a1e0b'; g.lineWidth = Math.max(0.8, R * 0.06); g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, TAU); g.stroke();
    // потёртости кожи
    g.fillStyle = 'rgba(30, 14, 4, 0.18)';
    for (const [x, y, w] of [[-0.55, 0.25, 0.18], [0.5, -0.3, 0.14], [0.2, 0.55, 0.12], [-0.3, -0.6, 0.1]]) { g.beginPath(); g.ellipse(x * rx, y * ry, w * R, w * R * 0.6, 0.6, 0, TAU); g.fill(); }
    // тулья: вытянута вдоль хода, с вмятиной посередине
    const cw = R * 0.72, ch = R * 0.56;
    const cr = g.createLinearGradient(0, -ch, 0, ch); cr.addColorStop(0, '#b07a46'); cr.addColorStop(0.45, '#8a5530'); cr.addColorStop(1, '#5a3216');
    g.fillStyle = cr; g.beginPath(); g.ellipse(0, 0, cw, ch, 0, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(40, 20, 6, 0.65)'; g.lineWidth = Math.max(0.8, R * 0.07); g.beginPath(); g.moveTo(-cw * 0.7, 0); g.quadraticCurveTo(0, ch * 0.12, cw * 0.75, 0); g.stroke(); // продольная вмятина
    g.strokeStyle = 'rgba(255, 225, 180, 0.35)'; g.lineWidth = Math.max(0.6, R * 0.04); g.beginPath(); g.moveTo(-cw * 0.65, -ch * 0.12); g.quadraticCurveTo(0, -ch * 0.02, cw * 0.7, -ch * 0.12); g.stroke(); // блик у вмятины
    for (const sg of [-1, 1]) { g.fillStyle = 'rgba(40, 20, 6, 0.35)'; g.beginPath(); g.ellipse(cw * 0.55, sg * ch * 0.42, cw * 0.18, ch * 0.16, 0, 0, TAU); g.fill(); } // защипы спереди
    // лента: тёмная плетёная полоса вокруг тульи + серебряная пряжка сбоку
    g.strokeStyle = '#2a170a'; g.lineWidth = Math.max(1, R * 0.16); g.beginPath(); g.ellipse(0, 0, cw * 0.98, ch * 0.98, 0, 0, TAU); g.stroke();
    g.setLineDash([R * 0.06, R * 0.06]); g.strokeStyle = 'rgba(180, 130, 80, 0.6)'; g.lineWidth = Math.max(0.6, R * 0.06); g.stroke(); g.setLineDash([]);
    const sv = g.createRadialGradient(-cw * 0.15, ch * 0.88, 0, -cw * 0.1, ch * 0.95, R * 0.2); sv.addColorStop(0, '#ffffff'); sv.addColorStop(0.5, '#c8ced6'); sv.addColorStop(1, '#6d747c');
    g.fillStyle = sv; g.beginPath(); g.arc(-cw * 0.1, ch * 0.95, R * 0.17, 0, TAU); g.fill(); g.strokeStyle = '#4a5058'; g.lineWidth = Math.max(0.5, R * 0.03); g.stroke();
  }), W, H };
}
// ===== Шериф (владелец 12.10): металлический жетон-звезда на груди и очень крутые тёмные очки =====
// Жетон: шестиконечная звезда с шариками на лучах, полированный металл (золото со стальным отливом), гравировка-кольцо, блик.
function badgeSprite(r) {
  const k = PX_PER_UNIT(), R = Math.max(6, Math.round(r / 2) * 2), S = R * 1.9;
  return { img: cacheCanvas('badge|' + R + '|' + k, S * k, S * k, g => {
    g.scale(k, k); g.translate(S / 2, S / 2);
    const ro = S * 0.42, ri = ro * 0.55;
    const star = () => { g.beginPath(); for (let i = 0; i < 12; i++) { const rr = i % 2 ? ri : ro, an = -Math.PI / 2 + i * Math.PI / 6; g.lineTo(Math.cos(an) * rr, Math.sin(an) * rr); } g.closePath(); };
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.save(); g.translate(S * 0.03, S * 0.04); star(); g.fill(); g.restore(); // тень
    const m = g.createLinearGradient(-ro, -ro, ro, ro); m.addColorStop(0, '#fff3c4'); m.addColorStop(0.3, '#e0b84a'); m.addColorStop(0.55, '#8c6a1c'); m.addColorStop(0.75, '#e6c560'); m.addColorStop(1, '#6e5214');
    g.fillStyle = m; star(); g.fill(); g.strokeStyle = '#4a3608'; g.lineWidth = Math.max(0.6, R * 0.05); g.stroke();
    for (let i = 0; i < 6; i++) { const an = -Math.PI / 2 + i * Math.PI / 3, bx = Math.cos(an) * ro, by = Math.sin(an) * ro; // шарики на лучах
      const bg = g.createRadialGradient(bx - R * 0.04, by - R * 0.04, 0, bx, by, R * 0.12); bg.addColorStop(0, '#fffbe6'); bg.addColorStop(1, '#a8801f'); g.fillStyle = bg; g.beginPath(); g.arc(bx, by, R * 0.11, 0, TAU); g.fill(); }
    const c = g.createRadialGradient(-R * 0.08, -R * 0.1, 0, 0, 0, ri * 0.8); c.addColorStop(0, '#f4f6f8'); c.addColorStop(0.6, '#aab2bb'); c.addColorStop(1, '#5f666e'); // стальной центр
    g.fillStyle = c; g.beginPath(); g.arc(0, 0, ri * 0.72, 0, TAU); g.fill(); g.strokeStyle = 'rgba(40,40,40,0.6)'; g.lineWidth = Math.max(0.5, R * 0.03); g.stroke();
    g.strokeStyle = 'rgba(60,60,60,0.55)'; g.setLineDash([R * 0.04, R * 0.05]); g.beginPath(); g.arc(0, 0, ri * 0.55, 0, TAU); g.stroke(); g.setLineDash([]); // гравировка
    g.fillStyle = 'rgba(255,255,255,0.7)'; g.beginPath(); g.ellipse(-ro * 0.3, -ro * 0.35, ro * 0.22, ro * 0.07, -0.7, 0, TAU); g.fill(); // блик
  }), S };
}
function drawSheriffBadge(neck, r) {
  const B = badgeSprite(r), sc = r / Math.max(6, Math.round(r / 2) * 2), S = B.S * sc; let [nx, ny, na] = neck;
  const t = performance.now() * 0.002, glint = 0.5 + 0.5 * Math.sin(t);
  const bx = nx + Math.sin(na) * r * 0.45, by = ny - Math.cos(na) * r * 0.45; nx = bx; ny = by; // на левом боку — справа висит табличка роли
  drawRotated(B.img, nx, ny, na + Math.PI / 2, S, S, S / 2, S / 2); resetWorldT(); // жетон на «груди», чуть позади головы
  ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.25 * glint; const hs = S * 0.9; ctx.drawImage(haloSprite('#fff1b0'), nx - hs / 2, ny - hs / 2, hs, hs); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
}
// Очень крутые тёмные очки: широкие «спортивные» линзы с зеркальным переливом (фиолетово-оранжевым), тонкая чёрная оправа, блик
function drawCoolShades(hx, hy, a, r) {
  // широкие тёмные «спортивные» линзы полностью закрывают глаза; зеркальный перелив фиолетовый → оранжевый
  ctx.save(); ctx.translate(hx + Math.cos(a) * r * 0.32, hy + Math.sin(a) * r * 0.32); ctx.rotate(a); // x — вперёд, y — поперёк
  const gap = r * 0.48, x0 = -r * 0.5, x1 = r * 0.52, h0 = r * 0.5;
  for (const sg of [-1, 1]) {
    const yIn = sg * (gap - h0 * 0.85), yOut = sg * (gap + h0 * 1.05);
    ctx.beginPath(); ctx.moveTo(x0, yIn); ctx.lineTo(x1, yIn); ctx.quadraticCurveTo(x1 + r * 0.06, (yIn + yOut) / 2, x1 - r * 0.05, yOut);
    ctx.quadraticCurveTo((x0 + x1) / 2, yOut + sg * r * 0.12, x0, yOut - sg * r * 0.05); ctx.quadraticCurveTo(x0 - r * 0.08, (yIn + yOut) / 2, x0, yIn); ctx.closePath();
    const lg = ctx.createLinearGradient(x0, yIn, x1, yOut); lg.addColorStop(0, '#08080c'); lg.addColorStop(0.45, '#1a1430'); lg.addColorStop(0.72, '#5a2d6e'); lg.addColorStop(0.9, '#d0702c'); lg.addColorStop(1, '#120e16');
    ctx.fillStyle = lg; ctx.fill(); ctx.strokeStyle = '#030304'; ctx.lineWidth = Math.max(1.2, r * 0.1); ctx.lineJoin = 'round'; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.beginPath(); ctx.ellipse(r * 0.12, sg * gap - sg * r * 0.12, r * 0.24, r * 0.06, -0.4 * sg, 0, TAU); ctx.fill(); // блик
  }
  ctx.strokeStyle = '#030304'; ctx.lineWidth = Math.max(1.4, r * 0.14); ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x1 - r * 0.05, -(gap - h0 * 0.85)); ctx.lineTo(x1 - r * 0.05, gap - h0 * 0.85); ctx.stroke(); // перемычка
  for (const sg of [-1, 1]) { ctx.beginPath(); ctx.moveTo(x0, sg * (gap + h0 * 0.6)); ctx.lineTo(-r * 1.05, sg * (gap + h0 * 0.4)); ctx.stroke(); } // дужки
  ctx.restore();
}
function drawSheriffHat(hx, hy, a, r) {
  const S = sheriffHatSprite(r), sc = r / Math.max(6, Math.round(r / 2) * 2), W = S.W * sc, H = S.H * sc;
  drawRotated(S.img, hx - Math.cos(a) * r * 1.05, hy - Math.sin(a) * r * 1.05, a, W, H, W / 2, H / 2); // позади глаз — глаза видно из-под полей
  resetWorldT();
}
// Граната в полёте: головная часть с хвостовыми перьями
function grenadeSprite() {
  const k = PX_PER_UNIT();
  return cacheCanvas('gren|' + k, 60 * k, 24 * k, g => {
    g.scale(k, k); g.translate(0, 12);
    g.fillStyle = '#2d3027'; g.beginPath(); g.moveTo(0, -9); g.lineTo(10, -3); g.lineTo(10, 3); g.lineTo(0, 9); g.closePath(); g.fill(); // перья
    const t = g.createLinearGradient(0, -3, 0, 3); t.addColorStop(0, '#4a4e44'); t.addColorStop(0.4, '#8c917f'); t.addColorStop(1, '#25271f'); g.fillStyle = t; g.fillRect(6, -3, 22, 6);
    const w = g.createLinearGradient(0, -9, 0, 9); w.addColorStop(0, '#3d4a2c'); w.addColorStop(0.3, '#8b9a6a'); w.addColorStop(1, '#1f2616');
    g.fillStyle = w; g.beginPath(); g.moveTo(28, -4); g.quadraticCurveTo(38, -10, 46, -6); g.lineTo(58, -1); g.lineTo(58, 1); g.lineTo(46, 6); g.quadraticCurveTo(38, 10, 28, 4); g.closePath(); g.fill();
    g.fillStyle = '#c9a227'; g.fillRect(40, -7.5, 1.6, 15);
  });
}
const smoke = []; // дымный след гранат: серые клубы медленно расплываются и тают
// ===== Бомба (владелец 11.10): чугунный шар с латунным горлышком и фитилём — как настоящая; едет справа от головы Бомбы =====
function bombSprite() {
  const k = PX_PER_UNIT();
  return cacheCanvas('bomb|' + k, 128 * k, 128 * k, g => {
    g.scale(k, k);
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.ellipse(70, 112, 40, 11, 0, 0, TAU); g.fill(); // тень
    const b = g.createRadialGradient(50, 58, 4, 64, 72, 44); b.addColorStop(0, '#6a7079'); b.addColorStop(0.25, '#353a41'); b.addColorStop(0.75, '#14161a'); b.addColorStop(1, '#050506');
    g.fillStyle = b; g.beginPath(); g.arc(64, 72, 40, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(120, 135, 150, 0.35)'; g.lineWidth = 2.5; g.beginPath(); g.arc(64, 72, 38, 0.15 * Math.PI, 0.65 * Math.PI); g.stroke(); // отражённый свет снизу
    g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 1.2; g.beginPath(); g.arc(64, 72, 34, 1.1 * Math.PI, 1.9 * Math.PI); g.stroke(); // литейный шов
    const hl = g.createRadialGradient(48, 54, 0, 48, 54, 14); hl.addColorStop(0, 'rgba(255,255,255,0.75)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = hl; g.beginPath(); g.ellipse(48, 54, 14, 10, -0.6, 0, TAU); g.fill(); // блик
    const c = g.createLinearGradient(52, 0, 76, 0); c.addColorStop(0, '#6b5320'); c.addColorStop(0.45, '#e2c26a'); c.addColorStop(1, '#5a4419');
    g.fillStyle = c; g.fillRect(53, 26, 22, 10); g.fillStyle = '#3d2e10'; g.fillRect(53, 26, 22, 2); g.fillRect(53, 34, 22, 2); // латунное горлышко
    g.fillStyle = '#4a3a14'; for (const x of [57, 64, 71]) { g.beginPath(); g.arc(x, 31, 1.3, 0, TAU); g.fill(); } // заклёпки
    g.strokeStyle = '#6b5232'; g.lineWidth = 3.2; g.lineCap = 'round'; g.beginPath(); g.moveTo(64, 26); g.bezierCurveTo(64, 14, 74, 12, 80, 6); g.stroke(); // фитиль
    g.strokeStyle = 'rgba(200, 170, 120, 0.6)'; g.lineWidth = 1; g.setLineDash([2, 2.5]); g.beginPath(); g.moveTo(64, 26); g.bezierCurveTo(64, 14, 74, 12, 80, 6); g.stroke(); g.setLineDash([]);
  });
}
// Искры горящего фитиля (кончик фитиля в заготовке — точка 80,6 из 128)
function fuseSparks(x, y, sz, time, hot) {
  ctx.globalCompositeOperation = 'lighter';
  const fl = 0.8 + 0.2 * Math.sin(time * 0.05), hs = sz * (hot ? 0.75 : 0.45) * fl;
  ctx.drawImage(haloSprite('#ffb030'), x - hs / 2, y - hs / 2, hs, hs);
  ctx.drawImage(haloSprite('#ffffff'), x - hs / 6, y - hs / 6, hs / 3, hs / 3);
  for (let i = 0; i < (hot ? 7 : 4); i++) {
    const ph = ((time * 0.004) + i * 0.37) % 1, an = i * 2.4 + time * 0.002, d = sz * 0.28 * ph;
    ctx.fillStyle = `rgba(255, ${200 - ph * 120 | 0}, 60, ${1 - ph})`; ctx.beginPath(); ctx.arc(x + Math.cos(an) * d, y + Math.sin(an) * d - ph * sz * 0.1, sz * 0.025 * (1 - ph) + 0.6, 0, TAU); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}
function drawCarriedBomb(hx, hy, a, r, time, sideSgn) {
  const px = -Math.sin(a) * (sideSgn || 1), py = Math.cos(a) * (sideSgn || 1), side = r * 1.9, sz = Math.max(26, r * 2.4);
  const bx = hx + px * side - Math.cos(a) * r * 0.4, by = hy + py * side - Math.sin(a) * r * 0.4 + Math.sin(time * 0.006) * r * 0.08; // слегка подпрыгивает
  ctx.strokeStyle = 'rgba(60, 45, 25, 0.8)'; ctx.lineWidth = Math.max(1, r * 0.08); // верёвочка к шее
  ctx.beginPath(); ctx.moveTo(hx - Math.cos(a) * r * 0.9 + px * r * 0.6, hy - Math.sin(a) * r * 0.9 + py * r * 0.6); ctx.quadraticCurveTo(bx - Math.cos(a) * r, by - Math.sin(a) * r + r * 0.3, bx, by - sz * 0.2); ctx.stroke();
  ctx.drawImage(bombSprite(), bx - sz / 2, by - sz / 2 - sz * 0.06, sz, sz);
  fuseSparks(bx - sz / 2 + sz * 80 / 128, by - sz / 2 - sz * 0.06 + sz * 6 / 128, sz, time, false);
}
function drawFlyingBombs(time) {
  const now = performance.now();
  for (const [id, b] of bombsFly) {
    const dt = now - b.t0; if (dt > b.fly + b.fuse + 600) { bombsFly.delete(id); continue; }
    const f = Math.min(1, dt / b.fly), x = b.x0 + (b.x - b.x0) * f, y = b.y0 + (b.y - b.y0) * f;
    const lift = Math.sin(f * Math.PI), sz = 46 * (1 + lift * 0.45); // летит по дуге: выше — крупнее, тень остаётся на полу
    if (f >= 1) { // лежит и вот-вот взорвётся: красный круг опасности (радиус взрыва) мигает всё чаще
      const left = 1 - Math.min(1, (dt - b.fly) / b.fuse), R = 170;
      ctx.globalAlpha = 0.18 + 0.22 * (1 - left) * (0.6 + 0.4 * Math.sin(time * 0.03));
      ctx.fillStyle = '#ff2b2b'; ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, TAU); ctx.fill();
      ctx.globalAlpha = 0.8; ctx.strokeStyle = '#ff4b3b'; ctx.lineWidth = 4; ctx.setLineDash([18, 12]); ctx.lineDashOffset = -time * 0.05;
      ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, TAU); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    } else { ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(x, y + 18, 20 * (1 - lift * 0.4), 7 * (1 - lift * 0.4), 0, 0, TAU); ctx.fill(); }
    const yy = y - lift * 70, spin = f < 1 ? dt * 0.012 : 0;
    drawRotated(bombSprite(), x, yy, spin, sz, sz, sz / 2, sz / 2); resetWorldT();
    if (f >= 1) fuseSparks(x - sz / 2 + sz * 80 / 128, yy - sz / 2 + sz * 6 / 128, sz, time, true);
  }
}
function drawRockets(time) {
  const now = performance.now();
  for (const [id, r] of rocketsFly) {
    const dt = now - r.t0; if (dt > r.life + 300) { rocketsFly.delete(id); continue; }
    const x = r.x + r.vx * dt, y = r.y + r.vy * dt, a = Math.atan2(r.vy, r.vx), c = Math.cos(a), s = Math.sin(a);
    if (smoke.length < 400) smoke.push({ x: x - c * 30, y: y - s * 30, t0: now, s: 10 + Math.random() * 6 }); // дым остаётся позади
    ctx.globalCompositeOperation = 'lighter'; // короткое пламя двигателя
    for (let k = 1; k <= 3; k++) { const hs = 26 - k * 5; ctx.globalAlpha = 0.65 - k * 0.15; ctx.drawImage(haloSprite(k < 2 ? '#fff1b0' : '#ff8a1f'), x - c * (24 + k * 7) - hs / 2, y - s * (24 + k * 7) - hs / 2, hs, hs); }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    drawRotated(grenadeSprite(), x, y, a, 60, 24, 34, 12); resetWorldT();
  }
  for (let i = smoke.length - 1; i >= 0; i--) { // дымный след: серые клубы растут и тают за 1,2 с
    const p = smoke[i], k = (now - p.t0) / 1200; if (k >= 1) { smoke.splice(i, 1); continue; }
    ctx.fillStyle = `rgba(150, 150, 155, ${0.32 * (1 - k)})`; ctx.beginPath(); ctx.arc(p.x, p.y - k * 10, p.s * (1 + k * 2.2), 0, TAU); ctx.fill();
  }
  for (let i = booms.length - 1; i >= 0; i--) { // взрыв: вспышка и расходящееся кольцо
    const b = booms[i], k = (now - b.t0) / (b.big ? 1100 : 400); if (k >= 1) { booms.splice(i, 1); continue; }
    if (b.big) { // попадание: белая вспышка, вторая волна, разлетающиеся горящие осколки
      const e = 1 - Math.pow(1 - k, 3);
      ctx.globalCompositeOperation = 'lighter';
      if (k < 0.25) { ctx.globalAlpha = 1 - k / 0.25; const F = 320 * (0.5 + k * 2); ctx.drawImage(haloSprite('#ffffff'), b.x - F, b.y - F, F * 2, F * 2); }
      for (const p of b.parts) {
        const px = b.x + p.vx * e, py = b.y + p.vy * e, s = p.s * (1 - k * 0.7);
        ctx.globalAlpha = 1 - k; ctx.drawImage(haloSprite(p.c), px - s, py - s, s * 2, s * 2);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = (1 - k) * 0.9; ctx.strokeStyle = '#ff5a1f'; ctx.lineWidth = 10 * (1 - k); ctx.beginPath(); ctx.arc(b.x, b.y, 60 + 380 * e, 0, TAU); ctx.stroke();
      if (b.mine) { const fs = 70 / Math.max(0.35, cam.s) * (k < 0.15 ? 0.6 + k / 0.15 * 0.4 : 1); ctx.globalAlpha = Math.min(1, (1 - k) * 1.6); ctx.font = `bold ${fs}px Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineWidth = fs * 0.12; ctx.strokeStyle = '#3a0a00'; ctx.strokeText('💥 ПОПАЛ!', b.x, b.y - 90 - 160 * e); ctx.fillStyle = '#ffd52e'; ctx.fillText('💥 ПОПАЛ!', b.x, b.y - 90 - 160 * e); } // надпись над целью — только у того, кто попал
      ctx.globalAlpha = 1;
    }
    const R = (b.big ? 170 : 80) * (0.3 + k);
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 1 - k;
    ctx.drawImage(haloSprite('#ff8a1f'), b.x - R, b.y - R, R * 2, R * 2); ctx.drawImage(haloSprite('#ffd52e'), b.x - R / 2, b.y - R / 2, R, R);
    ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = '#ffd52e'; ctx.lineWidth = 6 * (1 - k); ctx.beginPath(); ctx.arc(b.x, b.y, R * 0.8, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1;
  }
}
let shakeUntil = 0;
const docGhost = new Map(); // Доктор спасён: id -> до какого времени он «призрак»
function makeDebris() { const a = []; for (let i = 0; i < 26; i++) { const an = Math.random() * TAU, sp = 120 + Math.random() * 260; a.push({ vx: Math.cos(an) * sp, vy: Math.sin(an) * sp, s: 10 + Math.random() * 16, c: ['#ffd52e', '#ff8a1f', '#ff3b2b', '#ffffff'][i % 4] }); } return a; }
function fire() { if ((myRockets > 0 || myBomb || myKnife) && alive) { sendJSON({ t: 'fire' }); Sound.click(); } } // сначала ракеты базуки, потом бомба, потом кинжал
function renderFireBtn() { const b = $('fireBtn'); b.classList.toggle('hide', !((myRockets > 0 || myBomb || myKnife) && alive)); /* базука: в командах — за знамя, в обычной игре — у Дона; бомба — у Бомбы; кинжал — у Киллера */ b.innerHTML = myRockets > 0 ? '🚀<span>' + myRockets + '</span>' : myBomb ? '💣<span>' + myBomb + '</span>' : '🗡'; }
{
  const b = $('fireBtn');
  const stop = e => { e.stopPropagation(); }; // кнопка не должна включать ускорение/джойстик под собой
  b.addEventListener('pointerdown', e => { stop(e); e.preventDefault(); fire(); });
  for (const ev of ['touchstart', 'touchmove', 'touchend', 'mousedown', 'click']) b.addEventListener(ev, stop, { passive: false });
  window.addEventListener('keydown', e => { if ((e.code === 'KeyF') && !e.repeat && document.activeElement !== $('nick')) fire(); });
}

let toastT = 0;
function toast(text, cls) { const t = $('toast'); t.textContent = text; t.classList.toggle('ev', cls === 'ev'); t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800); }

// ===== Меню =====
function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
let skin = { id: 7, c1: '#ff3355', c2: '#33dd66', c3: '#3388ff' };
try { const s = JSON.parse(load('mm_skin2')); if (s && s.id >= 0 && s.id < SKINS.length && SKINS[s.id].style !== 'checker') skin = s; } catch (e) {} // шахматный убран — у кого был, станет обычный
const myName = () => ($('nick').value.trim() || 'Игрок').slice(0, 16);
const pickable = () => window.Skins.PICKABLE; // владелец 11.10: секретных скинов больше нет
$('nick').value = load('mm_nick') || '';

// Змейка для витрины: pts — опорные точки пути от головы к хвосту
function drawSkinPath(g, sk, pts, r) {
  const p = prepSkin(sk), size = r * 2 * SPR / (SR * 2), unit = r * p.unitK, sp = Math.max(1.5, r * 0.28);
  // Расставляем кружки вдоль пути плотно, как в игре
  const xs = [pts[0][0]], ys = [pts[0][1]], ds = [0];
  let rem = sp, dist = 0;
  for (let i = 1; i < pts.length; i++) {
    const x0 = pts[i - 1][0], y0 = pts[i - 1][1], dx = pts[i][0] - x0, dy = pts[i][1] - y0, L = Math.hypot(dx, dy);
    let t = rem;
    while (t <= L) { xs.push(x0 + dx * t / L); ys.push(y0 + dy * t / L); ds.push(dist + t); t += sp; }
    rem = t - L; dist += L;
  }
  const sh = shadowSprite(), ss = size * 1.35, st = Math.max(1, Math.round(r * 0.9 / sp));
  for (let i = xs.length - 1; i >= 0; i -= st) g.drawImage(sh, xs[i] - ss / 2 + r * 0.25, ys[i] - ss / 2 + r * 0.25, ss, ss);
  for (let i = xs.length - 1; i >= 0; i--) g.drawImage(skinSprite(p, ds[i] / unit), xs[i] - size / 2, ys[i] - size / 2, size, size);
  const a = Math.atan2(pts[0][1] - pts[1][1], pts[0][0] - pts[1][0]);
  const nk = Math.min(xs.length - 2, Math.round(r * 2.6 / sp));
  const neck = nk > 1 ? [xs[nk], ys[nk], Math.atan2(ys[nk - 1] - ys[nk + 1], xs[nk - 1] - xs[nk + 1])] : null;
  if (p.style === 'checker') { // шахматная клетка и на витрине
    const sq = r * 0.92; let acc = 0, next = r * 0.9, k = 0; g.fillStyle = '#141414';
    for (let i = 1; i < xs.length; i++) { const dx = xs[i] - xs[i - 1], dy = ys[i] - ys[i - 1], L = Math.hypot(dx, dy); const an = Math.atan2(dy, dx);
      while (next <= acc + L && L) { const f = (next - acc) / L, x = xs[i - 1] + dx * f, y = ys[i - 1] + dy * f, side = ++k % 2 ? 1 : -1;
        g.save(); g.translate(x - Math.sin(an) * side * sq * 0.5, y + Math.cos(an) * side * sq * 0.5); g.rotate(an); g.fillRect(-sq / 2, -sq / 2, sq, sq); g.restore(); next += sq; }
      acc += L; }
    const img = roundShadeSprite(), size = r * 2 * SPR / (SR * 2);
    for (let i = xs.length - 1; i >= 0; i -= 3) g.drawImage(img, xs[i] - size / 2, ys[i] - size / 2, size, size);
  }
  if (p.text) { // особый скин: золотая надпись вдоль тела и на витрине
    const unit = p.text + '  ★  ';
    let pathLen = 0; for (let i = 1; i < xs.length; i++) pathLen += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    const fs = Math.min(r * 0.95, (pathLen - r * 2.4) / (unit.length * 0.74)), slot = fs * 0.74; // надпись целиком помещается на витрине
    g.save(); g.font = `bold ${fs}px Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round'; g.lineWidth = fs * 0.22; g.strokeStyle = p.textStroke || 'rgba(40, 25, 0, 0.9)'; g.fillStyle = p.textColor || '#ffd52e';
    const P = []; let acc = 0, next = r * 2.2;
    for (let i = 1; i < xs.length; i++) { const L = Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]); while (next <= acc + L && L) { const f = (next - acc) / L; P.push([xs[i - 1] + (xs[i] - xs[i - 1]) * f, ys[i - 1] + (ys[i] - ys[i - 1]) * f, Math.atan2(ys[i] - ys[i - 1], xs[i] - xs[i - 1])]); next += slot; } acc += L; }
    const n = unit.length;
    for (let c0 = 0; c0 < P.length; c0 += n) {
      if (c0 + n > P.length) break;
      const c1 = c0 + n - 1, flip = P[c1][0] - P[c0][0] < 0;
      for (let i = c0; i <= c1; i++) { const ch = unit[flip ? n - 1 - (i - c0) : i - c0]; if (ch === ' ') continue;
        g.save(); g.translate(P[i][0], P[i][1]); g.rotate(P[i][2] + (flip ? Math.PI : 0)); g.strokeText(ch, 0, 0); g.fillText(ch, 0, 0); g.restore(); }
    }
    g.restore();
  }
  drawHeadDecor(g, p, pts[0][0], pts[0][1], a, a, r, neck);
}
// Значок внизу слева: свёрнутая змейка в выбранном скине (как фиолетовая змейка в оригинале)
function drawSkinIcon() {
  const cv = $('skinIcon'), g = cv.getContext('2d'), w = cv.width, h = cv.height;
  g.clearRect(0, 0, w, h);
  const pts = [];
  for (let i = 0; i < 46; i++) { const t = i / 45; pts.push([w * 0.72 - t * w * 0.5 + Math.sin(t * 7) * w * 0.12, h * 0.78 - t * h * 0.55]); }
  drawSkinPath(g, skin, pts, w * 0.085);
}
// Экран выбора скина: большая змейка извивается, стрелки листают
let skinAnim = 0;
function skinScreenFrame(t) {
  if ($('skinScreen').classList.contains('hide')) { skinAnim = 0; return; }
  skinAnim = requestAnimationFrame(skinScreenFrame);
  const cv = $('skinCanvas'), g = cv.getContext('2d');
  const w = cv.width, h = cv.height, r = h * 0.11;
  g.clearRect(0, 0, w, h);
  const pts = [], n = 40, len = w * 0.62;
  for (let i = 0; i < n; i++) { const f = i / (n - 1); pts.push([w * 0.81 - f * len, h / 2 + Math.sin(f * 4.2 - t * 0.003) * h * 0.16]); }
  drawSkinPath(g, skin, pts, r);
}
function openSkins() {
  Sound.click();
  if (!bgPattern) makeBg();
  if (bgTileURL) { $('skinScreen').style.backgroundImage = `url(${bgTileURL})`; $('skinScreen').style.backgroundSize = bgTileSize; }
  $('skinScreen').classList.remove('hide');
  sizeSkinCanvas(); updateSkinName();
  if (!skinAnim) skinAnim = requestAnimationFrame(skinScreenFrame);
}
function sizeSkinCanvas() {
  const cv = $('skinCanvas'), d = Math.min(2, window.devicePixelRatio || 1);
  // На низком экране (телефон лёжа) змейку делаем ниже, чтобы стрелки и кнопка помещались
  const w = Math.max(150, Math.min(W - 32 - (W < 600 ? 130 : 210), 620)), h = Math.round(Math.min(w * 0.4, H * 0.32));
  cv.style.width = w + 'px'; cv.style.height = h + 'px';
  cv.width = Math.round(w * d); cv.height = Math.round(h * d);
}
function updateSkinName() {
  $('skinName').textContent = SKINS[skin.id].name;
  const PK = pickable(), pos = PK.indexOf(skin.id);
  $('skinNum').textContent = skin.id === 0 ? (skin.pat && skin.pat.length ? 'собрана в конструкторе' : 'ещё не собрана — нажмите кнопку ниже') : (pos > 0 ? pos + ' из ' + (PK.length - 1) : '');
  $('customizer').classList.toggle('hide', skin.id !== 0);
}
function stepSkin(d) {
  Sound.click();
  // листаем только разрешённые скины (владелец 06.10)
  const PK = pickable();
  let pos = PK.indexOf(skin.id);
  if (pos < 0) { pos = 0; while (pos < PK.length - 1 && PK[pos + 1] < skin.id) pos++; if (d < 0) pos++; }
  skin.id = PK[(pos + d + PK.length) % PK.length];
  updateSkinName();
}
function saveSkin() { store('mm_skin2', JSON.stringify(skin)); drawSkinIcon(); }
$('skinBtn').addEventListener('click', openSkins);
$('prevSkin').addEventListener('click', () => stepSkin(-1));
$('nextSkin').addEventListener('click', () => stepSkin(1));
$('saveSkin').addEventListener('click', () => { Sound.click(); saveSkin(); $('skinScreen').classList.add('hide'); });
window.addEventListener('keydown', e => {
  if ($('skinScreen').classList.contains('hide')) return;
  if (e.key === 'ArrowLeft') stepSkin(-1);
  else if (e.key === 'ArrowRight') stepSkin(1);
  else if (e.key === 'Enter' || e.key === 'Escape') $('saveSkin').click();
});

// ===== Конструктор «Собрать змейку», как Build a Slither в оригинале =====
const PALETTE = window.Skins.PALETTE, MAX_PATTERN = window.Skins.MAX_PATTERN;
let build = Array.isArray(skin.pat) ? skin.pat.slice() : [];
let buildAnim = 0;
function buildPalette() {
  const box = $('palette'); box.innerHTML = '';
  for (const col of PALETTE) {
    const b = document.createElement('button');
    b.className = 'pball';
    b.style.background = `radial-gradient(circle at 38% 32%, ${shade(col, 70)} 0%, ${col} 45%, ${shade(col, -60)} 100%)`;
    b.addEventListener('click', () => {
      if (build.length >= MAX_PATTERN) { toastMenu('Не больше ' + MAX_PATTERN + ' колечек'); return; }
      Sound.eat(false); build.push(col);
      box.querySelectorAll('.pball').forEach(x => x.classList.remove('sel')); b.classList.add('sel');
    });
    box.appendChild(b);
  }
}
function toastMenu(t) { $('buildHint').textContent = t; setTimeout(() => { $('buildHint').textContent = 'Каждое нажатие красит одно колечко от головы. Нажмите цвет несколько раз — полоса станет толще'; }, 1500); }
function sizeBuildCanvas() {
  const cv = $('buildCanvas'), d = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(200, Math.min(W - 32, 560)), h = Math.round(Math.min(w * 0.3, H * 0.22));
  cv.style.width = w + 'px'; cv.style.height = h + 'px';
  cv.width = Math.round(w * d); cv.height = Math.round(h * d);
}
function buildFrame(t) {
  if ($('buildScreen').classList.contains('hide')) { buildAnim = 0; return; }
  buildAnim = requestAnimationFrame(buildFrame);
  const cv = $('buildCanvas'), g = cv.getContext('2d'), w = cv.width, h = cv.height, r = h * 0.15;
  g.clearRect(0, 0, w, h);
  const pts = [], n = 40, len = w * 0.72;
  for (let i = 0; i < n; i++) { const f = i / (n - 1); pts.push([w * 0.86 - f * len, h / 2 + Math.sin(f * 3.6 - t * 0.003) * h * 0.13]); }
  // Пока ничего не выбрано — чёрная змейка, как в оригинале
  drawSkinPath(g, { id: 0, pat: build.length ? build : ['#151515'], once: true }, pts, r);
}
function openBuilder() {
  Sound.click();
  if (!bgPattern) makeBg();
  if (bgTileURL) { $('buildScreen').style.backgroundImage = `url(${bgTileURL})`; $('buildScreen').style.backgroundSize = bgTileSize; }
  $('skinScreen').classList.add('hide');
  $('buildScreen').classList.remove('hide');
  sizeBuildCanvas();
  if (!buildAnim) buildAnim = requestAnimationFrame(buildFrame);
}
function closeBuilder() { $('buildScreen').classList.add('hide'); }
$('buildBtn').addEventListener('click', openBuilder);
$('toBuilder').addEventListener('click', openBuilder);
$('buildReset').addEventListener('click', () => { Sound.click(); build = []; $('palette').querySelectorAll('.pball').forEach(x => x.classList.remove('sel')); });
$('buildSave').addEventListener('click', () => {
  Sound.click();
  if (build.length) { skin.id = 0; skin.pat = build.slice(); saveSkin(); drawBuildIcon(); }
  closeBuilder();
});
window.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('buildScreen').classList.contains('hide')) closeBuilder(); });
// Значок: разноцветная змейка из своей цепочки (или радуга, пока своей нет)
function drawBuildIcon() {
  const cv = $('buildIcon'), g = cv.getContext('2d'), w = cv.width, h = cv.height;
  g.clearRect(0, 0, w, h);
  const pts = [];
  for (let i = 0; i < 46; i++) { const t = i / 45; pts.push([w * 0.25 + t * w * 0.5 + Math.sin(t * 6) * w * 0.1, h * 0.78 - t * h * 0.55]); }
  const pat = build.length ? build : ['#d03535', '#c9922f', '#d4b52a', '#2f9a3f', '#3049c2', '#8a4fd1'];
  drawSkinPath(g, { id: 0, pat }, pts, w * 0.085);
}
buildPalette();
drawBuildIcon();

// Качество: высокое — чёткая картинка и тени; низкое — для слабых телефонов
let hiQ = load('mm_hq') !== '0';
function showQuality() { $('qualityBtn').textContent = hiQ ? 'Высокое качество' : 'Низкое качество'; }
$('qualityBtn').addEventListener('click', () => { hiQ = !hiQ; store('mm_hq', hiQ ? '1' : '0'); Sound.click(); showQuality(); resize(); });

// Телефон: полный экран и горизонтальный поворот. Вопрос «Разрешить микрофон?» на Android выбивает из полного экрана —
// поэтому при первом касании в игре включаем его снова (браузер разрешает это только по касанию).
// Запущено с иконки на главном экране — браузерных панелей нет, полный экран не нужен (и нет сообщения Android)
const isApp = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone === true;
// Владелец 11.10: каждое включение полного экрана браузер сопровождает надписью «чтобы выйти… проведите сверху вниз»,
// убрать её сайт не может. Раньше полный экран включался заново на каждое касание — надпись выскакивала снова и снова.
// Теперь не больше двух раз за заход: «Играть» и один раз после вопроса про микрофон; вышел сам (провёл сверху вниз) — не возвращаем.
let fsLeft = 2, fsSince = 0;
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) fsSince = performance.now();
  else if (fsSince && performance.now() - fsSince > 4000) fsLeft = 0; // пробыл в полном экране и вышел — значит, сам захотел
});
function goFullscreen() {
  if (!isTouch || isApp) return;
  const d = document.documentElement, lock = () => { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); };
  if (document.fullscreenElement) { lock(); return; }
  if (fsLeft <= 0) return;
  fsLeft--;
  if (d.requestFullscreen) d.requestFullscreen({ navigationUI: 'hide' }).then(lock).catch(() => {});
}
function play() {
  if (!connected || !protoOk) return;
  Sound.init(); Sound.click();
  if (window.VoiceChat) VoiceChat.askMic(); // один раз спросить микрофон — нажатие «Играть» даёт браузеру право спросить
  goFullscreen();
  const name = myName();
  store('mm_nick', $('nick').value.trim());
  sendJSON({ t: 'join', name, skin, w: W, h: H, ...(TEAM_MODE ? { team: teamChoice } : {}) });
}
$('play').addEventListener('click', play);
$('nick').addEventListener('keydown', e => { if (e.key === 'Enter') play(); });

// Вариант оформления «Чёрное золото» (владелец 11.10): ?look=gold — включить и запомнить, ?look=classic — вернуть обычный.
// Чтобы включить всем: LOOK_DEFAULT = 'gold'.
const LOOK_DEFAULT = 'classic';
{ const q = new URLSearchParams(location.search).get('look'); if (q === 'gold' || q === 'classic') store('mm_look', q);
  if ((load('mm_look') || LOOK_DEFAULT) === 'gold') document.body.classList.add('look-gold'); }
// ===== Видео на заднем фоне меню (владелец 11.10). Вернуть фото по бокам: MENU_VIDEO = false =====
// Видео играет только в меню: «Играть» — пауза и выгрузка из памяти (игра не тормозит), снова меню — играет дальше.
const menuVid = $('menuVid'), mvCanvas = $('mvCanvas');
const MENU_VIDEO = !!menuVid; // старая страница из кэша без видео — просто без видео (раньше игра падала: ошибка с Xiaomi / Яндекс Браузера)
// Телефон: само видео спрятано (1 px), кадры рисуются на холст. Иначе Яндекс Браузер и браузеры Xiaomi/Samsung перехватывают
// видео и открывают его в своём плеере на весь экран — «на телефоне только видео открывается» (владелец 12.10).
const MV_CANVAS = MENU_VIDEO && isTouch && !!mvCanvas;
let mvRaf = 0;
function mvDraw() {
  mvRaf = requestAnimationFrame(mvDraw);
  if (menuVid.readyState < 2) return;
  const cw = mvCanvas.clientWidth, ch = mvCanvas.clientHeight; if (!cw || !ch) return;
  if (mvCanvas.width !== cw || mvCanvas.height !== ch) { mvCanvas.width = cw; mvCanvas.height = ch; }
  const g = mvCanvas.getContext('2d'), vw = menuVid.videoWidth, vh = menuVid.videoHeight;
  if (cw / ch > vw / vh) {
    // Владелец 12.10 («лиц не видно на телефоне»): телефон лёжа — видео целиком по высоте в центре (как на компьютере),
    // по бокам размытый фон (#mvBack); раньше видео растягивалось на всю ширину и от него оставались только руки с пистолетами
    const h = ch, w = vw * ch / vh, x = (cw - w) / 2; // владелец 12.10: девушки — посередине, название сверху, меню ниже
    g.clearRect(0, 0, cw, ch); g.drawImage(menuVid, x, 0, w, h);
    const f = Math.min(w * 0.12, 60); // мягкие края
    // мягкие края по бокам
    for (const [x0, dir] of [[x, 1], [x + w, -1]]) { const gr = g.createLinearGradient(x0, 0, x0 + dir * f, 0); gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalCompositeOperation = 'destination-out'; g.fillStyle = gr; g.fillRect(dir > 0 ? x0 : x0 - f, 0, f, ch); g.globalCompositeOperation = 'source-over'; }
  } else { // телефон стоя: на весь экран, лица сверху не обрезаем
    const k = Math.max(cw / vw, ch / vh), w = vw * k, h = vh * k;
    g.drawImage(menuVid, (cw - w) / 2, (ch - h) * 0.2, w, h);
  }
}
if (MENU_VIDEO) { document.body.classList.add('mvid'); if (MV_CANVAS) document.body.classList.add('mvcanvas'); menuVideo(true); }
// Шаги каблуков под видео (владелец 12.10): пока открыто меню с видео; звук включается после первого касания (так требуют браузеры).
// Две девушки идут не в ногу — шаги чуть вразнобой, громче/тише.
var stepT = 0, stepN = 0, userTapped = false; // var: menuVideo(true) вызывается выше по файлу, до этой строки
// Владелец 12.10: вместо придуманных шагов — звук из самого видео (photos/menu_audio.m4a), по кругу, пока открыто меню.
// Звук начинается после первого касания (так требуют браузеры).
// Владелец 12.10 («звук опаздывает»): звук теперь внутри самого видео (menu.mp4 со звуком) — всегда точно в такт картинке.
// Видео идёт без звука, пока не было касания (так требуют браузеры); после касания включаем звук самого видео.
function menuSteps(on) {
  const want = on && userTapped && document.body.classList.contains('in-menu') && Sound.isOn(); // до первого касания — без звука, иначе браузер не запустит видео
  if (MENU_VIDEO) { menuVid.muted = !want; menuVid.volume = 0.7; if (want && menuVid.paused) menuVid.play().catch(() => {}); }
  clearTimeout(stepT); return;
  const tick = () => {
    if (!document.body.classList.contains('in-menu') || document.hidden || menuVid.paused) { stepT = setTimeout(tick, 400); return; }
    const p = (menuVid.currentTime || 0) / (menuVid.duration || 8); // вторая половина ролика — «обратный ход», шаги тише
    Sound.heel((stepN % 2 ? 0.55 : 0.8) * (p > 0.5 ? 0.7 : 1)); stepN++;
    stepT = setTimeout(tick, stepN % 2 ? 230 : 330); // неровный ритм двух пар каблуков
  };
  stepT = setTimeout(tick, 300);
}
function menuVideo(on) {
  if (!MENU_VIDEO) return;
  menuSteps(on);
  if (on) {
    if (!menuVid.getAttribute('src')) menuVid.src = 'photos/menu.mp4';
    menuVid.play().catch(() => {});
    if (MV_CANVAS && !mvRaf) mvRaf = requestAnimationFrame(mvDraw);
  } else {
    cancelAnimationFrame(mvRaf); mvRaf = 0;
    menuVid.pause(); menuVid.removeAttribute('src'); menuVid.load(); // выгрузить — освободить память и видеочип для игры
  }
}
// Заставка (владелец 12.10: «название и ник закрывают лица»): при входе 6,5 с чистое видео на весь экран без кнопок,
// потом меню плавно появляется; касание или клавиша — меню сразу. Не мешаем, если человек пришёл по ссылке ?name= (сразу в игру).
if (MENU_VIDEO && !new URLSearchParams(location.search).get('name')) {
  document.body.classList.add('intro');
  const endIntro = e => { if (e && e.type) userTapped = true; Sound.init(); menuSteps(true); document.body.classList.remove('intro'); clearTimeout(introT); ['pointerdown', 'keydown'].forEach(ev => window.removeEventListener(ev, endIntro, true)); };
  const introT = setTimeout(endIntro, 6500); // владелец 12.10: 6–7 секунд
  ['pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, endIntro, true));
}
if (MENU_VIDEO) window.addEventListener('pointerdown', () => { userTapped = true; Sound.init(); if (document.body.classList.contains('in-menu')) menuSteps(true); }, true); // первое касание включает звук видео
if (MENU_VIDEO) ['webkitbeginfullscreen', 'enterpictureinpicture'].forEach(ev => menuVid.addEventListener(ev, () => { try { menuVid.webkitExitFullscreen && menuVid.webkitExitFullscreen(); } catch (e) {} }));
function hideMenu() {
  menuVideo(false);
  $('menu').classList.add('hide'); $('skinScreen').classList.add('hide'); $('hud').classList.remove('hide');
  document.body.classList.remove('in-menu');
  $('boostBtn').classList.toggle('hide', !isTouch || ctrlMode === 'joy'); // с джойстиком ускорение — вся правая половина, кнопка не нужна
  $('nick').blur();
  lastSentA = 99; renderLb();
}
function showMenu(m) {
  mouseBoost = keyBoost = btnBoost = false; bbOff();
  const r = $('result');
  if (m) {
    const who = m.killer ? `Вас съел: <b>${esc(m.killer)}</b>` : 'Вы врезались в край карты';
    r.innerHTML = `<div class="rlen">Ваша итоговая длина: <b>${m.score}</b><div class="sub">${who} · съедено змей: ${m.kills}</div></div>` // .rlen на телефоне скрыта (владелец 11.10)
      + (m.photo ? `<div class="wpOffer">🏆 Вы на ${m.photo.place}-м месте рекордов всех времён!</div>` : '');
    // Кнопка фото — внизу справа (владелец 11.10); видна, пока действует пропуск (30 мин)
    wpToken = m.photo ? m.photo.t : null;
    const b = $('wpBtn'); b.disabled = false; b.textContent = '📷 Загрузите своё фото'; b.classList.toggle('hide', !m.photo);
    // нейросеть больше НЕ грузим сама после смерти: игрок быстро жал «Играть снова», и она догружалась и прогревала
    // видеочип прямо в игре — сильные подвисания (владелец 11.10: «виснет сильно»). Теперь — только при открытии окошка фото.
    r.classList.remove('hide');
    $('play').textContent = 'Играть снова';
  }
  $('menu').classList.remove('hide'); $('hud').classList.add('hide');
  document.body.classList.add('in-menu');
  menuVideo(true);
}
// ===== Фото на карточку победителя (владелец 11.10): топ-5 рекордов всех времён ставят своё фото =====
// Фото сжимается прямо в телефоне до квадрата 320×320 (~25 КБ) и уходит на сервер с одноразовым пропуском из 'dead'.
let wpToken = null;
async function squareJpeg(file, S) {
  let img;
  try { img = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) { img = await new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = URL.createObjectURL(file); }); }
  const w = img.width, h = img.height, s = Math.min(w, h);
  const c = document.createElement('canvas'); c.width = c.height = S;
  c.getContext('2d').drawImage(img, (w - s) / 2, (h - s) / 2 * 0.6, s, s, 0, 0, S, S); // лицо обычно выше центра — квадрат берём чуть выше середины
  for (const q of [0.85, 0.7, 0.55]) { const b = await new Promise(ok => c.toBlob(ok, 'image/jpeg', q)); if (b && b.size < 110000) return b; }
  throw new Error('big');
}
// Проверка на обнажёнку (владелец 11.10) — нейросеть NSFWJS прямо в телефоне игрока, перед отправкой.
// На сервере её держать нельзя: ~350 МБ памяти и секунды процессора отняли бы их у игры (сервер 512 МБ).
// Файлы (~6 МБ) грузятся только по нажатию кнопки; после проверки сеть выгружается, чтобы не мешать игре.
const NSFW_REJECT = { Porn: 0.2, Hentai: 0.3, Sexy: 0.45 }; // «Откровенное» — бельё, купальник, голый торс
let nsfwLoading = null;
function loadNsfw() {
  if (!nsfwLoading) nsfwLoading = ['model.min.js', 'group1-shard1of1.min.js', 'nsfwjs.min.js'].reduce((p, f) => p.then(() => new Promise((ok, no) => {
    const s = document.createElement('script'); s.src = 'vendor/nsfw/' + f; s.onload = ok; s.onerror = no; document.head.appendChild(s);
  })), Promise.resolve()).catch(e => { nsfwLoading = null; throw e; });
  return nsfwLoading;
}
// Нейросеть готовим заранее — как только появилась кнопка фото (пока человек выбирает снимок, она уже загружена);
// выгружаем, когда начинается игра, чтобы не занимать память телефона (владелец 11.10: «фото чтобы сразу быстро»)
let nsfwModelP = null;
function warmNsfw() { if (!nsfwModelP) nsfwModelP = loadNsfw().then(() => window.nsfwjs.load('MobileNetV2')).catch(e => { nsfwModelP = null; throw e; }); return nsfwModelP; }
function dropNsfw() { const p = nsfwModelP; nsfwModelP = null; if (p) p.then(m => { try { m.model.dispose(); } catch (e) {} }).catch(() => {}); }
// «На фото есть лицо» (владелец 11.10: «всякий мусор не пропускай» — значки, машины, картинки). Лёгкая нейросеть (1,5 МБ),
// грузится только при открытии окошка фото. Смотрит исходное фото целиком, до обрезки.
let faceP = null;
function loadFace() {
  if (!faceP) faceP = new Promise((ok, no) => { if (window.faceapi) return ok(); const s = document.createElement('script'); s.src = 'vendor/face/face-api.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s); })
    .then(() => faceapi.nets.tinyFaceDetector.loadFromUri('vendor/face')).catch(e => { faceP = null; throw e; });
  return faceP;
}
async function photoHasFace(file) {
  await loadFace();
  const img = await createImageBitmap(file).catch(() => new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = URL.createObjectURL(file); }));
  const c = document.createElement('canvas'), k = Math.min(1, 640 / Math.max(img.width, img.height)); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const r = await faceapi.detectAllFaces(c, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.45 }));
  return r.length > 0;
}
async function photoIsClean(blob) {
  const model = await warmNsfw();
  {
    const img = await createImageBitmap(blob).catch(() => new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = URL.createObjectURL(blob); }));
    const c = document.createElement('canvas'); c.width = c.height = 224; c.getContext('2d').drawImage(img, 0, 0, 224, 224);
    const p = {}; for (const { className, probability } of await model.classify(c)) p[className] = probability;
    return !Object.keys(NSFW_REJECT).some(k => (p[k] || 0) >= NSFW_REJECT[k]);
  }
}
// ===== Окошко фото (владелец 11.10: системная галерея открывалась на пол-экрана — «нельзя ли компактно и удобно») =====
// «Сделать селфи» — камера прямо в игре небольшим квадратом; «Из галереи» — системный выбор, как раньше.
let camStream = null;
function camStop() { if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; } }
function wpPanelClose() { camStop(); $('wpPanel').classList.add('hide'); }
function wpPanelOpen() {
  warmNsfw().catch(() => {}); // человек сам решил загрузить фото — готовим проверку, пока он выбирает снимок
  $('wppPick').classList.remove('hide'); $('wppCam').classList.add('hide'); $('wppErr').textContent = '';
  // владелец 11.10: снова фото из галереи (главное) или селфи; мусор отсекает проверка «на фото есть лицо» (photoHasFace)
  $('wppSelfie').classList.toggle('hide', !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
  $('wpPanel').classList.remove('hide');
  loadFace().catch(() => {});
}
async function camStart() {
  $('wppPick').classList.add('hide'); $('wppCam').classList.remove('hide');
  $('wppShot').classList.add('hide'); $('wppVideo').classList.remove('hide');
  $('wppSnap').classList.remove('hide'); $('wppAgain').classList.add('hide'); $('wppOk').classList.add('hide'); $('wppErr').textContent = '';
  try {
    loadFace().catch(() => {});
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 640 } }, audio: false });
    $('wppVideo').srcObject = camStream; await $('wppVideo').play().catch(() => {});
  } catch (e) {
    $('wppErr').textContent = e && e.name === 'NotAllowedError' ? 'Камера запрещена — разрешите её в настройках сайта или выберите фото' : 'Камера не включилась — выберите фото из галереи';
    $('wppSnap').classList.add('hide');
  }
}
function camSnap() {
  const v = $('wppVideo'), c = $('wppShot'), w = v.videoWidth, h = v.videoHeight, s = Math.min(w, h); if (!s) return;
  c.width = c.height = 320; const g = c.getContext('2d');
  g.translate(320, 0); g.scale(-1, 1); // как в зеркале — так человек себя и видел
  g.drawImage(v, (w - s) / 2, (h - s) / 2, s, s, 0, 0, 320, 320);
  c.classList.remove('hide'); v.classList.add('hide');
  $('wppSnap').classList.add('hide'); $('wppAgain').classList.remove('hide'); $('wppOk').classList.remove('hide');
}
$('wpBtn').addEventListener('click', () => { Sound.click(); wpPanelOpen(); });
$('wppSelfie').addEventListener('click', () => { Sound.click(); camStart(); });
$('wppGallery').addEventListener('click', () => { Sound.click(); wpPanelClose(); $('wpFile').click(); });
$('wpFile').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) uploadPhoto(f); });
$('wppSnap').addEventListener('click', () => { Sound.click(); camSnap(); });
$('wppAgain').addEventListener('click', () => { Sound.click(); $('wppShot').classList.add('hide'); $('wppVideo').classList.remove('hide'); $('wppSnap').classList.remove('hide'); $('wppAgain').classList.add('hide'); $('wppOk').classList.add('hide'); });
$('wppOk').addEventListener('click', () => { Sound.click(); $('wppShot').toBlob(b => { wpPanelClose(); if (b) uploadPhoto(b); }, 'image/jpeg', 0.88); });
$('wppClose').addEventListener('click', () => { Sound.click(); wpPanelClose(); });
async function uploadPhoto(file) {
  const btn = $('wpBtn'); if (!file || !wpToken) return;
  btn.disabled = true; btn.textContent = '🔍 Проверяю фото…';
  try {
    let face; try { face = await photoHasFace(file); } catch (err) { throw new Error('check'); }
    if (!face) throw new Error('noface');
    const jpg = await squareJpeg(file, 320);
    let clean; try { clean = await photoIsClean(jpg); } catch (err) { throw new Error('check'); }
    if (!clean) throw new Error('nsfw');
    btn.textContent = '⏳ Загружаю фото…';
    const r = await fetch('/wp?t=' + wpToken, { method: 'POST', body: jpg, headers: { 'Content-Type': 'image/jpeg' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || String(r.status));
    if (recData) { const row = recData.all.find(x => x[0] === j.name); if (row) { row[2] = j.ver; renderRecords(); } }
    btn.textContent = '✅ Фото на карточке!';
    setTimeout(() => btn.classList.add('hide'), 2500);
  } catch (err) {
    const m = err.message;
    btn.disabled = m === 'expired' || m === 'not-top';
    btn.textContent = m === 'noface' ? '🙂 На фото не видно лица — загрузите своё фото' : m === 'nsfw' ? '🚫 Это фото нельзя — загрузите обычное фото' : m === 'check' ? '⚠ Не удалось проверить фото — попробуйте ещё раз'
      : m === 'expired' ? 'Время вышло — сыграйте ещё раз' : m === 'not-top' ? 'Вас уже обогнали в рекордах' : '⚠ Не получилось — выберите другое фото';
  }
}

const sb = $('soundBtn');
sb.textContent = Sound.icon();
sb.addEventListener('pointerdown', e => e.stopPropagation());
sb.addEventListener('click', () => { sb.textContent = Sound.cycle(); Sound.click(); if (typeof menuSteps === 'function') menuSteps(true); }); // звук видео меню тоже слушается кнопки

function showHelp() {
  $('help').innerHTML = !isTouch ? 'Мышка или стрелки (WASD) — направление. Левая кнопка мыши или пробел — ускорение. Голосовой чат включается сам; V — выключить свой микрофон.'
    : ctrlMode === 'joy' ? 'Первый палец в любом месте — джойстик. Второй палец в любом месте — ускорение, пока держите. Голосовой чат включается сам; 🎤 — выключить свой микрофон.'
    : 'Ведите пальцем — змейка ползёт за пальцем. Кнопка ⚡ — ускорение.';
}
if (isTouch) {
  $('ctrlBtn').classList.remove('hide');
  $('ctrlBtn').addEventListener('click', () => { ctrlMode = ctrlMode === 'joy' ? 'finger' : 'joy'; try { localStorage.setItem('mm_ctrl2', ctrlMode); } catch (e) {} Sound.click(); applyCtrlMode(); showHelp(); });
}
applyCtrlMode();
// showHelp(); — подсказку под кнопкой убрали (владелец 06.10)
if (window.VoiceChat) VoiceChat.init();
// владелец 07.10: вместо слайд-шоу — два фото по бокам меню (index.html)
// Владелец 11.10: открыли во встроенном браузере Telegram/Instagram — сначала экран с фото и «Открыть в браузере».
// В обычном браузере экрана нет — сразу игра. «Играть здесь» — остаться в Telegram (до закрытия вкладки больше не спрашиваем).
(() => {
  const ua = navigator.userAgent, isIOS = /iPhone|iPad|iPod/i.test(ua);
  const inApp = !!window.TelegramWebviewProxy || /Telegram|Instagram|FBAN|FBAV|FB_IAB|Line\//i.test(ua) || /; wv\)/.test(ua) || (isIOS && !/Safari\//.test(ua) && !navigator.standalone);
  let seen = false; try { seen = sessionStorage.getItem('mm_here') === '1'; } catch (e) {}
  if (!inApp || seen) return;
  $('landing').classList.remove('hide');
  const url = location.origin + '/';
  $('lOpen').addEventListener('click', () => {
    if (!isIOS) { location.href = 'intent://' + location.host + '/#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(url) + ';end'; return; }
    const ok = () => { $('lOpen').textContent = '✅ Ссылка скопирована'; $('lHint').innerHTML = 'Откройте <b>Safari</b> и вставьте ссылку в адресную строку'; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(ok, () => prompt('Скопируйте ссылку и откройте в Safari:', url)); else prompt('Скопируйте ссылку и откройте в Safari:', url);
  });
  $('lHere').addEventListener('click', () => { try { sessionStorage.setItem('mm_here', '1'); } catch (e) {} $('landing').classList.add('hide'); });
})();
// Владелец 11.10: считаем установки — один раз с телефона: Android сообщает сам (appinstalled), iPhone — первым запуском с иконки
function reportInstall() {
  if (load('mm_inst_sent')) return;
  let id = load('mm_dev'); if (!id) { id = Math.random().toString(36).slice(2, 12) + Date.now().toString(36); store('mm_dev', id); }
  fetch('/installed?id=' + id, { method: 'POST', keepalive: true }).then(r => { if (r.ok) store('mm_inst_sent', '1'); }).catch(() => {});
}
if (isApp) reportInstall();
window.addEventListener('appinstalled', reportInstall);
// «Установить на телефон»: Android — системное окно установки; iPhone — короткая подсказка «Поделиться → На экран Домой»
(() => {
  if (isApp || !isTouch) return;
  try { if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {}); } catch (e) {}
  const btn = $('installBtn'), ua = navigator.userAgent, isIOS = /iPhone|iPad|iPod/i.test(ua);
  // Владелец 11.10: кнопка видна на телефоне всегда (раньше — только когда телефон сам предлагал установку; если игра
  // уже стояла, кнопка пропадала и было непонятно почему). Во встроенном браузере Telegram её нет — там «Открыть в браузере».
  const inApp = !!window.TelegramWebviewProxy || /Telegram|Instagram|FBAN|FBAV|FB_IAB|Line\//i.test(ua) || /; wv\)/.test(ua) || (isIOS && !/Safari\//.test(ua) && !navigator.standalone);
  const tip = html => { const t = $('iosTip'); t.innerHTML = html; t.classList.remove('hide'); clearTimeout(tip.t); tip.t = setTimeout(() => t.classList.add('hide'), 8000); };
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; });
  window.addEventListener('appinstalled', () => { btn.classList.add('hide'); tip('✅ Готово! Иконка игры — на экране телефона'); });
  if (!inApp) btn.classList.remove('hide');
  btn.addEventListener('click', async () => {
    Sound.click();
    if (deferred) { deferred.prompt(); try { await deferred.userChoice; } catch (e) {} deferred = null; }
    else if (isIOS) tip('Нажмите <b>Поделиться ⬆</b> внизу экрана → <b>«На экран Домой»</b>');
    else {
      // Владелец 11.10: Samsung Internet / Яндекс и др. не сообщают сайту «можно установить» — раньше кнопка ошибочно писала
      // «уже установлена». Теперь: «уже установлена» — только если Chrome это подтвердил; иначе — где установка в меню этого браузера + «Открыть в Chrome»
      const samsung = /SamsungBrowser/i.test(ua), chrome = /Chrome\//.test(ua) && !/SamsungBrowser|YaBrowser|OPR\/|Edg|MiuiBrowser|HeyTap|UCBrowser/i.test(ua);
      let installed = false;
      if (chrome && navigator.getInstalledRelatedApps) try { installed = (await navigator.getInstalledRelatedApps()).length > 0; } catch (e) {}
      const toChrome = chrome ? '' : '<br><button id="tipChrome">Открыть в Chrome</button>';
      if (installed) tip('📲 Игра уже установлена — откройте её с иконки на экране.<br>Иконка не открывается? Удалите её в «Настройки → Приложения» и нажмите эту кнопку ещё раз');
      else if (samsung) tip('Нажмите <b>≡</b> внизу → <b>«Добавить страницу на»</b> → <b>«Главный экран»</b>' + toChrome);
      else if (chrome) tip('Нажмите <b>⋮</b> вверху справа → <b>«Установить приложение»</b> или <b>«Добавить на главный экран»</b>');
      else tip('Откройте меню браузера (<b>≡</b> или <b>⋮</b>) → <b>«Добавить на главный экран»</b>' + toChrome);
      const tc = $('tipChrome');
      if (tc) tc.addEventListener('click', () => { location.href = 'intent://' + location.host + '/#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(location.origin + '/') + ';end'; });
    }
  });
})();

function resize() {
  // На телефоне — легче (разница на глаз почти незаметна); «низкое качество» — ещё легче, для слабых телефонов
  DPR = hiQ ? Math.min(window.devicePixelRatio || 1, isTouch ? (autoLow ? 1 : 1.25) : 2) : (isTouch ? 0.8 : 1);
  W = innerWidth; H = innerHeight;
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ms = Math.min(140, Math.round(Math.min(W, H) * 0.27));
  mm.width = mm.height = ms * Math.min(2, window.devicePixelRatio || 1);
  if (!$('skinScreen').classList.contains('hide')) sizeSkinCanvas();
  sendView();
}
window.addEventListener('resize', resize);
showQuality();
resize();
drawSkinIcon();
if (location.hash === '#build') openBuilder();
if (location.hash.startsWith('#skins')) { const n = Number(location.hash.split('-')[1]); if (n >= 0 && n < SKINS.length) skin.id = n; openSkins(); }
if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawSkinIcon);
connect();
requestAnimationFrame(frame);
})();
