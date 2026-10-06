'use strict';
// Скины: узор из цветных полос вдоль тела, как в slither.io. Общий файл — читают и сервер, и браузер.
// cols — цвета полос по очереди от головы; style: ball (обычный), glow (светится), space, skeleton;
// eyes: обычные / cyclops (один большой глаз) / antenna (глаза на усиках); badge — значок-флаг на шее.
(function (root) {
  const SKINS = [
    { name: 'Своя змейка', cols: null },                           // 0 — собрана в конструкторе
    { name: 'Красный', cols: ['#e8323c'] },
    { name: 'Оранжевый', cols: ['#ff8a1f'] },
    { name: 'Жёлтый', cols: ['#ffd52e'] },
    { name: 'Зелёный', cols: ['#3ddc5a'] },
    { name: 'Голубой', cols: ['#2fd3f5'] },
    { name: 'Синий', cols: ['#3d6bff'] },
    { name: 'Фиолетовый', cols: ['#9b4dff'] },
    { name: 'Розовый', cols: ['#ff5fc8'] },
    { name: 'Белый', cols: ['#eeeeee'] },
    { name: 'Чёрный', cols: ['#3a3a3a'] },
    { name: 'Красно-белый', cols: ['#e8323c', '#e8323c', '#ffffff', '#ffffff'] },
    { name: 'Сине-жёлтый', cols: ['#3d6bff', '#3d6bff', '#ffd52e', '#ffd52e'] },
    { name: 'Зелёно-фиолетовый', cols: ['#3ddc5a', '#3ddc5a', '#9b4dff', '#9b4dff'] },
    { name: 'Арбуз', cols: ['#ff4a5a', '#ff4a5a', '#ff4a5a', '#f5f5c0', '#2fb34a', '#1d7a30'] },
    { name: 'Пчела', cols: ['#ffd52e', '#ffd52e', '#222222', '#222222'] },
    { name: 'Тигр', cols: ['#ff8a1f', '#ff8a1f', '#ff8a1f', '#1e1e1e'] },
    { name: 'Зебра', cols: ['#f2f2f2', '#f2f2f2', '#1e1e1e', '#1e1e1e'] },
    { name: 'Конфета', cols: ['#ff5fc8', '#ffffff'] },
    { name: 'Мята', cols: ['#7dffc4', '#ffffff'] },
    { name: 'Лава', cols: ['#ff3b1f', '#ff8a1f', '#ffd52e', '#ff8a1f'] },
    { name: 'Океан', cols: ['#0c5bd6', '#2fa7f5', '#7de3ff', '#2fa7f5'] },
    { name: 'Лес', cols: ['#1f7a3a', '#3ddc5a', '#a6f06a', '#3ddc5a'] },
    { name: 'Закат', cols: ['#ff5f6d', '#ff8a5f', '#ffc371', '#ff8a5f'] },
    { name: 'Радуга', cols: ['#ff3b3b', '#ff9a1f', '#ffe32e', '#3ddc5a', '#2fd3f5', '#3d6bff', '#9b4dff'] },
    { name: 'Золото', cols: ['#ffd700', '#ffb300', '#fff3a0', '#ffb300'] },
    { name: 'Неон зелёный', cols: ['#39ff14'], style: 'glow' },
    { name: 'Неон розовый', cols: ['#ff2fd0'], style: 'glow' },
    { name: 'Неон голубой', cols: ['#22e5ff'], style: 'glow' },
    { name: 'Космос', cols: ['#ffffff', '#7a7aff'], style: 'space' },
    { name: 'Скелет', cols: ['#e8e8e8'], style: 'skeleton' },
    { name: 'Узбекистан', cols: ['#0099b5', '#0099b5', '#ce1126', '#ffffff', '#ffffff', '#ce1126', '#1eb53a', '#1eb53a'], badge: true },
    { name: 'Россия', cols: ['#ffffff', '#ffffff', '#0039a6', '#0039a6', '#d52b1e', '#d52b1e'], badge: true },
    { name: 'Казахстан', cols: ['#00afca', '#00afca', '#00afca', '#fec50c'], badge: true },
    { name: 'Кыргызстан', cols: ['#e8112d', '#e8112d', '#ffef00'], badge: true },
    { name: 'Таджикистан', cols: ['#cc0000', '#cc0000', '#ffffff', '#ffffff', '#006600', '#006600'], badge: true },
    { name: 'Турция', cols: ['#e30a17', '#e30a17', '#ffffff'], badge: true },
    { name: 'Украина', cols: ['#0057b7', '#0057b7', '#ffd700', '#ffd700'], badge: true },
    { name: 'Германия', cols: ['#1a1a1a', '#1a1a1a', '#dd0000', '#dd0000', '#ffce00', '#ffce00'], badge: true },
    { name: 'США', cols: ['#b22234', '#ffffff', '#b22234', '#ffffff', '#3c3b6e', '#3c3b6e'], badge: true },
    { name: 'Бразилия', cols: ['#009c3b', '#009c3b', '#ffdf00', '#ffdf00', '#002776'], badge: true },
    { name: 'Циклоп', cols: ['#2fb34a', '#2fb34a', '#1f8f3a', '#1f8f3a'], eyes: 'cyclops' },
    { name: 'Улитка', cols: ['#d0393f', '#d0393f', '#d0393f', '#a92c33'], eyes: 'antenna' },
    { name: 'Пришелец', cols: ['#6ef05a', '#6ef05a', '#6ef05a', '#3fc248'], eyes: 'antenna' },
    { name: 'Глазастик', cols: ['#ff5fc8', '#ff5fc8', '#c23fa0', '#c23fa0'], eyes: 'cyclops' },
    { name: 'Фиолетово-оранжевый', cols: ['#5b2fc8', '#5b2fc8', '#ff6a00', '#ff6a00'] },
    { name: 'Розовый блеск', cols: ['#f06bd8', '#c94fc0'] },
    { name: 'Альмано', cols: ['#ffab3d', '#ff9a26', '#ffab3d', '#ff8c14'], text: 'АЛЬМАНО ★ КРЕАТОР', textColor: '#3a1066', textStroke: 'rgba(255,255,255,0.95)', eyes: 'shades' }, // особый оранжевый скин (владелец 06.10)
    { name: 'Марми', cols: ['#0d3b22', '#145c33', '#08261a', '#145c33'], text: 'МАРМИ', eyes: 'gold' },          // особый скин (владелец 06.10)
    // Спокойные однотонные (владелец 06.10: глаза меньше устают; в основном для ботов). Добавлять только в конец — номера скинов хранятся у игроков
    { name: 'Бирюзовый', cols: ['#2bb3a3'] },
    { name: 'Лаймовый', cols: ['#9bd43a'] },
    { name: 'Персиковый', cols: ['#ffab7a'] },
    { name: 'Лавандовый', cols: ['#a58be0'] },
    { name: 'Мятный', cols: ['#6fdcb0'] },
    { name: 'Коралловый', cols: ['#f06b5b'] },
    { name: 'Песочный', cols: ['#d9b77a'] },
    { name: 'Небесный', cols: ['#6bb6f0'] },
    { name: 'Сливовый', cols: ['#8a3f8f'] },
    { name: 'Изумрудный', cols: ['#1f9e5a'] },
    // 07.10: больше светлых/серых и двухцветных для ботов; шахматный — у Шерифа и в выборе скинов
    { name: 'Серый', cols: ['#8a8f98'] },
    { name: 'Светло-серый', cols: ['#c4c8ce'] },
    { name: 'Чёрно-оранжевый', cols: ['#1c1c1e', '#1c1c1e', '#ff8a1f', '#ff8a1f'] },
    { name: 'Чёрно-белый', cols: ['#1c1c1e', '#1c1c1e', '#f2f2f2', '#f2f2f2'] },
    { name: 'Шахматный', cols: ['#f2f2f2'], style: 'checker' },
  ];
  // Палитра конструктора «Собрать змейку» — 40 шариков, как в оригинале
  const PALETTE = [
    '#c0282d', '#9a9a9a', '#16208c', '#a8191e', '#a3a12a', '#8a5a2b', '#a2338f', '#1f7a2e', '#5a6fd6', '#5c2a8f',
    '#2b33c8', '#8a4fd1', '#d4b52a', '#2a3fd0', '#3049c2', '#4a1f9a', '#d2560f', '#3fa6c4', '#8c8f7a', '#2f9a3f',
    '#16c75a', '#c8383a', '#b52ac0', '#d6d6d6', '#6d7cd6', '#444444', '#c9922f', '#1f6b55', '#4f5fd0', '#7a83d6',
    '#3a46c8', '#9a63c9', '#6d73c2', '#4fa3a8', '#4fc25a', '#b5b545', '#c97a3f', '#c97a7a', '#d03535', '#f2f2f2',
  ];
  const MAX_PATTERN = 60;   // в оригинале одно нажатие = одно тонкое колечко, поэтому колечек много
  // Цвета полос для скина: у «Своей змейки» — цепочка из конструктора
  function skinCols(sk) {
    const def = SKINS[sk.id] || SKINS[1];
    if (def.cols) return def.cols;
    if (Array.isArray(sk.pat) && sk.pat.length) return sk.pat;
    return [sk.c1 || '#888888', sk.c1 || '#888888', sk.c2 || '#888888', sk.c2 || '#888888', sk.c3 || '#888888', sk.c3 || '#888888'];
  }
  // Владелец 06.10: в выборе скинов игрокам — только эти (остальные скрыты, но не удалены: их номера хранятся у игроков и нужны ботам)
  const SHOWN = ['Своя змейка', 'Космос', 'Скелет', 'Пришелец', 'Альмано', 'Марми', 'Лаймовый', 'Сливовый', 'Белый', 'Синий', 'Чёрный',
    'Пчела', 'Конфета', 'Шахматный', 'Россия', 'Таджикистан', 'Германия', 'Бразилия', 'Циклоп', 'Улитка'];
  const PICKABLE = SKINS.map((d, i) => (SHOWN.includes(d.name) ? i : -1)).filter(i => i >= 0);
  const api = { SKINS, PALETTE, MAX_PATTERN, skinCols, PICKABLE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Skins = api;
})(typeof window !== 'undefined' ? window : this);
