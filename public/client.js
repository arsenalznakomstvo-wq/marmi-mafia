'use strict';
// Марми Мафия — клиент. Рисует то, что прислал сервер, и отправляет, куда повернуть.
(() => {
const TAU = Math.PI * 2;
let MAP_R = 5000, TICK_RATE = 30, SEG_D = 6, FCELL = 250;
const PROTO = 6;        // версия «языка» сервер↔браузер; должна совпадать с PROTO в server.js
let protoOk = false;
// Рисуем чуть позади сервера, с запасом под неровную доставку. Запас подстраивается сам:
// замеряем паузы между обновлениями и держим запас чуть больше обычной паузы (от 3 до 9 шагов = 100–300 мс).
let interpTicks = 3, interpWant = 3, lastArrive = 0;
const gaps = [];

const $ = id => document.getElementById(id);
const canvas = $('game'), ctx = canvas.getContext('2d');
const mm = $('minimap'), mctx = mm.getContext('2d');
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
let W = 0, H = 0, DPR = 1;

// ===== Формулы (как на сервере) =====
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function angDiff(a, b) { let d = b - a; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; }
// Камера как в оригинале: отдаляется по мере роста числа сегментов (формула та же, что в server.js)
function viewScale(w, h, r) {
  // Владелец 06.10: на телефоне камера ближе (как на компьютере) — раньше змейка на старте была 15 px и терялась
  const base = Math.max(clamp(Math.sqrt(w * h) / 750, 0.5, 1.6), Math.min(w, h) < 600 ? 1.05 : 0), sct = 2 + (r / 10 - 1) * 60; // 60 — как SC_DIV в server.js
  return base * (0.64285 + 0.514285714 / Math.max(1, (sct + 16) / 36)) / 1.157142857;
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
function sprite(key, paint) {
  let s = sprites.get(key);
  if (!s) { s = document.createElement('canvas'); s.width = s.height = SPR; paint(s.getContext('2d')); sprites.set(key, s); }
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
const foodSprite = col => sprite('f' + col, g => {
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, shade(col, 110)); gr.addColorStop(0.1, shade(col, 50)); gr.addColorStop(0.16, col);
  gr.addColorStop(0.24, rgba(col, 0.16)); gr.addColorStop(0.55, rgba(col, 0.045)); gr.addColorStop(1, rgba(col, 0));
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
  return { id: sk.id, cols, style: def.style || 'ball', eyes: def.eyes || 'normal', badge: !!def.badge, flag, unitK: sk.id === 0 ? 0.45 : 1.4, once: !!sk.once, text: def.text || '', textColor: def.textColor || '', textStroke: def.textStroke || '' };
}
// Цвет в точке узора u (дробное число полос от головы). Как в оригинале — чистые полосы,
// без смешивания цветов (смешивание давало грязные серо-зелёные переходы).
function bandColor(cols, u) {
  const n = cols.length, i = Math.floor(u);
  return cols[((i % n) + n) % n];
}
function skinSprite(sk, u) {
  if (sk.once && u >= sk.cols.length) return ball('#151515'); // конструктор: незакрашенное тело — чёрное
  switch (sk.style) {
    case 'glow': return glowBall(bandColor(sk.cols, u));
    case 'space': return spaceBall(sk.cols[0], sk.cols[1], Math.floor(u) % 3);
    case 'skeleton': return ringBall(sk.cols[0], Math.floor(u) & 1);
    default: return ball(bandColor(sk.cols, u));
  }
}
const headColor = sk => sk.style === 'space' ? '#7a7aff' : sk.cols[0];

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
  if (sk.eyes === 'cyclops') {
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
function makeBg() {
  // Владелец 06.10: соты чёткие — плитку рисуем в 4 раза детальнее и уменьшаем при заливке (раньше 50×87 точек растягивались)
  const s = 29, w = s * Math.sqrt(3), h = s * 3, K = 4;
  const c = document.createElement('canvas'); c.width = Math.round(w * K); c.height = Math.round(h * K);
  const g = c.getContext('2d');
  const kx = c.width / w, ky = c.height / h;
  g.scale(kx, ky);
  g.fillStyle = '#0b1018'; g.fillRect(0, 0, w, h);
  const hex = (cx, cy) => {
    const path = rr => { g.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); } g.closePath(); };
    path(s - 7); // широкие промежутки между сотами, как в оригинале
    const gr = g.createLinearGradient(cx, cy - s, cx, cy + s); gr.addColorStop(0, '#1e2a3d'); gr.addColorStop(1, '#141c2a');
    g.fillStyle = gr; g.fill();
    g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,0.04)'; g.stroke();
  };
  for (const [x, y] of [[0, 0], [w, 0], [w / 2, h / 2], [0, h], [w, h]]) hex(x, y);
  bgPattern = ctx.createPattern(c, 'repeat');
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
      .then(bmp => { photoBmp[i] = bmp; }).catch(() => {});
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
let myMass = 0;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
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
      protoOk = m.proto === PROTO;
      if (protoOk) {
        $('play').disabled = false; setStatus(''); $('status').style.color = ''; // владелец 06.10: без лишних надписей
        // Ссылка вида ?name=Вася сразу пускает в игру
        const q = new URLSearchParams(location.search).get('name');
        if (q && !autoJoined) { autoJoined = true; $('nick').value = q.slice(0, 16); play(); }
      }
      if (!protoOk) { $('play').disabled = true; setStatus('⚠ Сервер устарел — закройте чёрное окно сервера и запустите start заново'); $('status').style.color = '#ff7070'; }
      break;
    case 'meta': for (const [id, name, skid, c1, c2, c3, bot, pat, role] of m.list) metas.set(id, { name, sk: prepSkin({ id: skid, c1, c2, c3, pat: pat || null }), bot, role: role || 0 }); break;
    case 'role': showPromo(m.r); break;
    case 'don': toast('👑 ' + m.name + ' — новый Дон Мафии!'); break;
    case 'spawn': myId = m.id; alive = true; predStop(); hideMenu(); Sound.spawn(); break;
    case 'dead': alive = false; myId = 0; predStop(); Sound.death(); setTimeout(() => showMenu(m), 1300); break;
    case 'kill': toast('Вы убили: ' + m.name); Sound.kill(); break;
    case 'lb': {
      const prevEv = evNow ? evNow[0] : null;
      lb = m; if (m.mm) mmLines = m.mm; if (m.rec) { recData = m.rec; renderRecords(); }
      evNow = m.ev || null; evAt = performance.now();
      if (evNow && evNow[0] !== prevEv) toast(evNow[0] === 'night' ? '🌙 Ночь мафии! Видно только рядом с собой' : '🍅 Золотая еда! Скорее туда — смотрите на миникарту');
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

  // Оцениваем «серверное время»: быстро догоняем, медленно отстаём — так рывки сети не дёргают картинку
  const est = tick - performance.now() / (1000 / TICK_RATE);
  if (tickOffset === null || est > tickOffset) tickOffset = est;
  else tickOffset += (est - tickOffset) * 0.02;
  const nowA = performance.now();
  if (lastArrive) {
    gaps.push(nowA - lastArrive); if (gaps.length > 90) gaps.shift();
    if (gaps.length >= 20) {
      const sorted = gaps.slice().sort((a, b) => a - b), p95 = sorted[Math.floor(sorted.length * 0.95)];
      interpWant = clamp(Math.ceil(p95 / (1000 / TICK_RATE)) + 1, 3, 9);
    }
  }
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
      if (ev.rem[i + 1]) eatAnims.push({ f, eater: ev.rem[i + 1], t0: performance.now() });
      // звук поедания выключен (владелец 06.10)
    }
    if (ev.drop.length) {
      const dropSet = new Set(ev.drop);
      for (const f of foods.values()) if (dropSet.has(fkey(f.x, f.y))) foods.delete(f.id);
    }
    for (const id of ev.dead) { // змея погибла — её тело красиво тает
      const sn = lastDrawn.get(id);
      if (sn) dying.push({ sn, meta: metas.get(id), t0: performance.now() });
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
    if (a && a !== b) {
      for (let j = 0; j < n; j++) {
        const k = findIdx(a.idx, b.idx[j]);
        if (k >= 0) { xs[j] = a.xs[k] + (b.xs[j] - a.xs[k]) * t; ys[j] = a.ys[k] + (b.ys[j] - a.ys[k]) * t; }
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
// Телефон: «джойстик» — левая половина экрана рулит (джойстик появляется под пальцем),
// правая половина — ускорение, пока держите палец. «Палец» — змейка ползёт к месту касания, ⚡ слева.
let ctrlMode = (() => { try { return localStorage.getItem('mm_ctrl') || 'joy'; } catch (e) { return 'joy'; } })();
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
  if (e.pointerType === 'mouse') { setAngleFrom(e.clientX, e.clientY); if (e.button === 0 || e.button === 2) mouseBoost = true; return; }
  if (ctrlMode === 'joy') {
    if (e.clientX < W / 2) { if (!joy) { joy = { id: e.pointerId, x0: e.clientX, y0: e.clientY }; showJoy(e.clientX, e.clientY); } }
    else if (boostId === null) boostOn(e.pointerId);
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
function turnRate(r) { const sc = r / 10, scang = 0.13 + 0.87 * Math.pow((7 - sc) / 6, 2); return 0.033 * ((1000 / TICK_RATE) / 8) * scang * 1.3; } // ×1.3 — как TURN_BOOST в server.js
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
  const lead = ((now - lastArrive) + pingMs / 2) / tickMs;
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
  const need = (srv.len - 1) * SEG_D;
  const idx = [0], xs = [pred.x], ys = [pred.y], gap = [false];
  let acc = 0, nextAt = SEG_D, seg = 1, cut = pred.trail.length;
  for (let j = 1; j < pred.trail.length && seg < srv.len; j++) {
    const [x0, y0] = pred.trail[j - 1], [x1, y1] = pred.trail[j];
    const L = Math.hypot(x1 - x0, y1 - y0);
    while (acc + L >= nextAt && seg < srv.len) {
      const f = L ? (nextAt - acc) / L : 0;
      idx.push(seg); xs.push(x0 + (x1 - x0) * f); ys.push(y0 + (y1 - y0) * f); gap.push(false);
      seg++; nextAt += SEG_D;
    }
    acc += L;
    if (acc > need + 300) { cut = j + 1; break; } // запас следа на случай, если змейка подросла
  }
  pred.trail.length = Math.min(pred.trail.length, cut + 1);
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
function plateSprite(ri, bodyCol, nick, s) {
  const R = ROLES[ri], k = PX_PER_UNIT(), sb = Math.round(s * 4) / 4;
  const key = 'pl|' + ri + '|' + nick + '|' + sb + '|' + k;
  const label = (R.icon ? R.icon + ' ' : '') + (SHORT[R.name] || R.name.toUpperCase());
  const fs = 11 * sb, fs2 = 10 * sb;
  const mctx = textMeasure; mctx.font = `bold ${fs}px Arial, sans-serif`;
  let w = mctx.measureText(label).width + 12 * sb;
  if (nick) { mctx.font = `bold ${fs2}px Arial, sans-serif`; w = Math.max(w, mctx.measureText(nick).width + 12 * sb); }
  const h = nick ? fs * 1.45 + fs2 * 1.35 : fs * 1.7, pad = 5 * sb;
  const img = cacheCanvas(key, (w + pad * 2) * k, (h + pad * 2) * k, g => {
    g.scale(k, k); g.translate(pad, pad);
    // Владелец 07.10: все таблички в одном стиле — светлая плашка, тонкая рамка, тёмный текст
    const bg = '#f4f5f7', fg = '#1a1d24', border = 'rgba(30, 40, 60, 0.45)', rr = 4 * sb;
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

function drawBackPlate(id, ri, x, y, heading, r, boost, time, bodyCol, nick) {
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
  const P = plateSprite(ri, bodyCol, nick, s);
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
  const fill = fillCol || '#ffd52e', fillHi = fillCol ? '#9b6bff' : '#fff7cc', stroke = strokeCol || 'rgba(40, 25, 0, 0.9)';
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
  'Проститутка': ['#ff5fc8'],
  'Мафия': ['#1e1e22'],
  'Киллер': ['#b4bcc6', '#b4bcc6', '#b4bcc6', '#141414'],
  'Шериф': ['#f2f2f2'], // белый + шахматная клетка поверх (владелец 07.10: вместо звёздочек)
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
    drawChecker(cnt, r, view);
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
  const r = sn.r * (fade ? 1 + fade * 0.35 : 1); // тающее тело чуть разбухает
  // Кружки вдоль тела идут очень плотно — так тело выглядит гладкой трубкой
  const sp = Math.max(2, sn.r * (!hiQ || autoLow >= 2 ? 0.6 : isTouch ? 0.42 : 0.28));
  let cnt = 0;
  SX[0] = sn.xs[0]; SY[0] = sn.ys[0]; SI[0] = sn.idx[0]; cnt = 1;
  let rem = sp;
  for (let j = 1; j < n; j++) {
    const x0 = sn.xs[j - 1], y0 = sn.ys[j - 1], x1 = sn.xs[j], y1 = sn.ys[j];
    if (sn.gap[j]) { SX[cnt] = x1; SY[cnt] = y1; SI[cnt] = sn.idx[j]; cnt++; rem = sp; continue; }
    const dx = x1 - x0, dy = y1 - y0, L = Math.sqrt(dx * dx + dy * dy);
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
  if (!fade && sk.text) { // особый скин: мягкое золотое сияние вокруг тела
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.22 + 0.08 * Math.sin(time * 0.004);
    const halo = haloSprite('#ffc23a'), hs = r * 2 * 2.1 * SPR / (SR * 2) / 1.6;
    for (let k = 0; k < cnt; k += 3) { const x = SX[k], y = SY[k]; if (x < view.x0 - hs || x > view.x1 + hs || y < view.y0 - hs || y > view.y1 + hs) continue; ctx.drawImage(halo, x - hs / 2, y - hs / 2, hs, hs); }
    ctx.restore();
  }
  if (roleIdx && !sk.text) drawRoleUnder(roleIdx, cnt, r, time, view);
  if (sn.boost && !fade) { // при ускорении тело светится и пульсирует
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
    if (meta && !fade && meta.role === DON) drawCigar(hx, hy, a, r, time); // владелец 07.10: у Дона сигара
    if (meta && !fade && meta.role === DON) drawBodyText(cnt, sn.r, meta.bot ? 'ДОН МАФИИ' : meta.name.toUpperCase() + ' ★ ДОН', time, view); // надпись по всему телу Дона
    else if (!fade && sk.text) drawBodyText(cnt, sn.r, sk.text, time, view, 0.25, sk.textColor, sk.textStroke); // особый скин с надписью (Альмано, Марми)
    if (meta && !fade && (meta.role || 0) >= BACK_PLATE_MIN) { // табличка роли на спине у старших ролей
      const bk = Math.min(cnt - 1, Math.round(sn.r * 4.2 / sp));
      const talkingP = !meta.bot && window.VoiceChat && VoiceChat.isSpeaking(meta.name);
      if (bk > 2) drawBackPlate(sn.id, meta.role, SX[bk], SY[bk], a, sn.r, sn.boost, time, bandColor(sk.cols, 0), meta.bot ? '' : (talkingP ? '🔊 ' : '') + meta.name);
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
let fpsCount = 0, fpsT = performance.now();
setInterval(() => {
  const now = performance.now(), fps = Math.round(fpsCount * 1000 / (now - fpsT));
  // Авто-облегчение на телефоне: если кадров мало несколько секунд подряд — сначала снижаем чёткость, потом упрощаем змей
  if (isTouch && alive && hiQ) {
    if (fps < 40) lowSecs++; else lowSecs = 0;
    if (lowSecs >= 3 && autoLow < 2) { autoLow++; lowSecs = 0; resize(); }
  }
  fpsCount = 0; fpsT = now;
  void fps;
  // Владелец 06.10: внизу только маленькая цифра без подписи — сколько живых людей сейчас в игре (боты не считаются)
  $('ping').textContent = lb && typeof lb.players === 'number' ? String(lb.players) : '';
  if (window.VoiceChat) VoiceChat.tick(alive, lb && typeof lb.online === 'number' ? lb.online : 0); // общий голос: когда на сайте есть кто-то ещё
  if (pnShowUntil > Date.now()) showPlayerNames(); else $('pnList').classList.add('hide');
}, 1000);
// Нажатие на цифру внизу — на 5 секунд показать ники живых людей в игре
let pnShowUntil = 0;
function showPlayerNames() {
  const list = (lb && lb.pn) || [], el = $('pnList');
  el.innerHTML = list.length ? list.map(([n, sc]) => `<div>${esc(n)} <span>${sc}</span></div>`).join('') : '<div>никого</div>';
  el.classList.remove('hide');
}
$('ping').addEventListener('pointerdown', e => { e.stopPropagation(); pnShowUntil = Date.now() + 5000; showPlayerNames(); });
function frame(time) {
  requestAnimationFrame(frame);
  fpsCount++;
  sendInput();
  const tickMs = 1000 / TICK_RATE;
  interpTicks += (interpWant - interpTicks) * 0.02; // меняем запас плавно, чтобы картинка не дёргалась
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
    cam.x = me.xs[0] + look.x; cam.y = me.ys[0] + look.y;
  } else if (world) { look.x *= 0.9; look.y *= 0.9; cam.x += (world.vx - cam.x) * 0.15; cam.y += (world.vy - cam.y) * 0.15; }
  const target = viewScale(W, H, me ? me.r : 10);
  cam.s += (target - cam.s) * 0.06;

  const s = cam.s;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#0b1018'; ctx.fillRect(0, 0, W, H);
  ctx.setTransform(DPR * s, 0, 0, DPR * s, DPR * (W / 2 - cam.x * s), DPR * (H / 2 - cam.y * s));
  worldT.k = DPR * s; worldT.tx = DPR * (W / 2 - cam.x * s); worldT.ty = DPR * (H / 2 - cam.y * s);
  const view = { x0: cam.x - W / 2 / s, x1: cam.x + W / 2 / s, y0: cam.y - H / 2 / s, y1: cam.y + H / 2 / s };

  // Фон и граница карты
  if (!bgPattern) makeBg();
  ctx.fillStyle = bgPattern; ctx.fillRect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0);
  ctx.beginPath(); ctx.rect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0); ctx.arc(0, 0, MAP_R, 0, TAU);
  ctx.fillStyle = 'rgba(90, 0, 10, 0.55)'; ctx.fill('evenodd');
  ctx.beginPath(); ctx.arc(0, 0, MAP_R, 0, TAU); ctx.lineWidth = 14; ctx.strokeStyle = 'rgba(255, 50, 70, 0.75)'; ctx.stroke();
  drawPosters(view);

  // Еда
  const tt = time * 0.003;
  for (const f of foods.values()) {
    if (f.x < view.x0 - 40 || f.x > view.x1 + 40 || f.y < view.y0 - 40 || f.y > view.y1 + 40) continue;
    const pulse = 1 + 0.12 * Math.sin(tt * 2 + f.ph);
    // Низкое качество: маленький ореол — в разы меньше закрашиваемых пикселей
    const sz = f.r * pulse * (hiQ ? SPR / FOOD_CORE : 3.2), spr = hiQ ? foodSprite(f.col) : foodDot(f.col);
    ctx.drawImage(spr, f.x + Math.sin(tt + f.ph) * 1.5 - sz / 2, f.y + Math.cos(tt * 1.3 + f.ph) * 1.5 - sz / 2, sz, sz);
  }
  // Еда, которую засасывает в рот
  const now = performance.now();
  for (let i = eatAnims.length - 1; i >= 0; i--) {
    const e = eatAnims[i], k = (now - e.t0) / 180;
    const h = lastHeads.get(e.eater);
    if (k >= 1 || !h) { eatAnims.splice(i, 1); continue; }
    const x = e.f.x + (h.x - e.f.x) * k, y = e.f.y + (h.y - e.f.y) * k, sz = e.f.r * (1 - k) * SPR / FOOD_CORE;
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

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (evNow && evNow[0] === 'night') drawNight(me);
  if (alive) { $('len').textContent = myMass; drawMinimap(me); }
  renderEventArrow(me);
}

// Миникарта как в оригинале: змеи — серыми линиями (где их много, там гуще), живые игроки — жёлтыми, вы — белая точка
let mmLines = [];
// ===== События и рекорды (владелец 06.10) =====
let evNow = null, evAt = 0, recData = null;
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
  el.innerHTML = `<div class="rh">🏆 Рекорды</div><div class="rcols">${col('Сегодня', recData.day)}${col('Всех времён', recData.all)}</div>`;
  el.classList.remove('hide');
}
function showRecord(kind) {
  const el = $('promo');
  el.className = 'don'; el.style.setProperty('--rc', '#ffd52e');
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
      const human = line[0] === 1;
      if (human !== (pass === 1)) continue;
      mctx.strokeStyle = human ? 'rgba(255, 213, 79, 0.9)' : 'rgba(200, 205, 215, 0.55)';
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
  lb.top.forEach(([name, score, id], i) => {
    const me = id === myId && alive;
    html += `<div class="row${me ? ' me' : ''}" style="color:${LB_COLORS[i]}"><span class="p">#${i + 1}</span><span class="n">${esc(name)}</span><span class="s">${score}</span></div>`;
  });
  if (alive && lb.rank > 10) html += `<div class="row me sep"><span class="p">#${lb.rank}</span><span class="n">${esc(myName())}</span><span class="s">${lb.score}</span></div>`;
  $('lb-rows').innerHTML = html;
  $('rank').innerHTML = alive && lb.rank ? `Ваше место: <b>${lb.rank}</b> из ${lb.total}` : '';
}

let toastT = 0;
function toast(text) { const t = $('toast'); t.textContent = text; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800); }

// ===== Меню =====
function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
let skin = { id: 7, c1: '#ff3355', c2: '#33dd66', c3: '#3388ff' };
try { const s = JSON.parse(load('mm_skin2')); if (s && s.id >= 0 && s.id < SKINS.length) skin = s; } catch (e) {}
const myName = () => ($('nick').value.trim() || 'Игрок').slice(0, 16);
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
  const PK = window.Skins.PICKABLE, pos = PK.indexOf(skin.id);
  $('skinNum').textContent = skin.id === 0 ? (skin.pat && skin.pat.length ? 'собрана в конструкторе' : 'ещё не собрана — нажмите кнопку ниже') : (pos > 0 ? pos + ' из ' + (PK.length - 1) : '');
  $('customizer').classList.toggle('hide', skin.id !== 0);
}
function stepSkin(d) {
  Sound.click();
  // листаем только разрешённые скины (владелец 06.10)
  const PK = window.Skins.PICKABLE;
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
function goFullscreen() {
  if (!isTouch || isApp) return;
  const d = document.documentElement, lock = () => { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); };
  if (document.fullscreenElement) { lock(); return; }
  if (d.requestFullscreen) d.requestFullscreen({ navigationUI: 'hide' }).then(lock).catch(() => {});
}
function play() {
  if (!connected || !protoOk) return;
  Sound.init(); Sound.click();
  if (window.VoiceChat) VoiceChat.askMic(); // один раз спросить микрофон — нажатие «Играть» даёт браузеру право спросить
  goFullscreen();
  const name = myName();
  store('mm_nick', $('nick').value.trim());
  sendJSON({ t: 'join', name, skin, w: W, h: H });
}
$('play').addEventListener('click', play);
$('nick').addEventListener('keydown', e => { if (e.key === 'Enter') play(); });

function hideMenu() {
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
    r.innerHTML = `Ваша итоговая длина: <b>${m.score}</b><div class="sub">${who} · съедено змей: ${m.kills}</div>`;
    r.classList.remove('hide');
    $('play').textContent = 'Играть снова';
  }
  $('menu').classList.remove('hide'); $('hud').classList.add('hide');
  document.body.classList.add('in-menu');
}
const sb = $('soundBtn');
sb.textContent = Sound.icon();
sb.addEventListener('pointerdown', e => e.stopPropagation());
sb.addEventListener('click', () => { sb.textContent = Sound.cycle(); Sound.click(); });

function showHelp() {
  $('help').innerHTML = !isTouch ? 'Мышка или стрелки (WASD) — направление. Левая кнопка мыши или пробел — ускорение. Голосовой чат включается сам; V — выключить свой микрофон.'
    : ctrlMode === 'joy' ? 'Левая половина экрана — джойстик. Держите палец на правой половине — ускорение. Голосовой чат включается сам; 🎤 — выключить свой микрофон.'
    : 'Ведите пальцем — змейка ползёт за пальцем. Кнопка ⚡ — ускорение.';
}
if (isTouch) {
  $('ctrlBtn').classList.remove('hide');
  $('ctrlBtn').addEventListener('click', () => { ctrlMode = ctrlMode === 'joy' ? 'finger' : 'joy'; try { localStorage.setItem('mm_ctrl', ctrlMode); } catch (e) {} Sound.click(); applyCtrlMode(); showHelp(); });
}
applyCtrlMode();
// showHelp(); — подсказку под кнопкой убрали (владелец 06.10)
if (window.VoiceChat) VoiceChat.init();
// владелец 07.10: вместо слайд-шоу — два фото по бокам меню (index.html)
// «Установить на телефон»: Android — системное окно установки; iPhone — короткая подсказка «Поделиться → На экран Домой»
(() => {
  if (isApp || !isTouch) return;
  try { if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {}); } catch (e) {}
  const btn = $('installBtn'), isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; btn.classList.remove('hide'); });
  window.addEventListener('appinstalled', () => btn.classList.add('hide'));
  if (isIOS) btn.classList.remove('hide');
  btn.addEventListener('click', async () => {
    Sound.click();
    if (deferred) { deferred.prompt(); try { await deferred.userChoice; } catch (e) {} deferred = null; btn.classList.add('hide'); }
    else if (isIOS) { const t = $('iosTip'); t.classList.remove('hide'); setTimeout(() => t.classList.add('hide'), 6000); }
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
