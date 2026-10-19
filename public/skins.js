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
    { name: 'Циклоп', cols: ['#2fb34a', '#2fb34a', '#1f8f3a', '#1f8f3a'], eyes: 'cyclops' }, // владелец 11.10: видит на 30% больше — для всех, кто выберет (надпись на теле убрана)
    { name: 'Улитка', cols: ['#d0393f', '#d0393f', '#d0393f', '#a92c33'], eyes: 'antenna' },
    { name: 'Пришелец', cols: ['#6ef05a', '#6ef05a', '#6ef05a', '#3fc248'], eyes: 'antenna' },
    { name: 'Глазастик', cols: ['#ff5fc8', '#ff5fc8', '#c23fa0', '#c23fa0'], eyes: 'cyclops' },
    { name: 'Фиолетово-оранжевый', cols: ['#5b2fc8', '#5b2fc8', '#ff6a00', '#ff6a00'] },
    { name: 'Розовый блеск', cols: ['#f06bd8', '#c94fc0'] },
    { name: 'Альмано', cols: ['#ffab3d', '#ff9a26', '#ffab3d', '#ff8c14'], text: 'АЛЬМАНО ★ КРЕАТОР', textColor: '#3a1066', textStroke: 'rgba(255,255,255,0.95)', eyes: 'shades' }, // особый оранжевый скин (владелец 06.10)
    { name: 'Марми', cols: ['#ffffff'], text: 'МАРМИ МАФИЯ', textColor: '#ff8a1f', textStroke: '#ffffff', plain: true, eyes: 'lady', bag: true }, // владелец 11.10: белая змея, оранжевая надпись, женское лицо, оранжевая сумка на плече          // особый скин (владелец 06.10)
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
    // 07.10: водные скины — полупрозрачное тело, волны-блики, пузырьки (kind задаёт вариант)
    { name: 'Вода', cols: ['#3fb7ff'], style: 'water', water: { core: '#1a7fd1', rim: '#9fe3ff', kind: 'water' } },
    { name: 'Глубина', cols: ['#0b3d7a'], style: 'water', water: { core: '#062a5c', rim: '#2fd3f5', kind: 'ocean' } },
    { name: 'Лёд', cols: ['#dff6ff'], style: 'water', water: { core: '#bfe9ff', rim: '#ffffff', kind: 'ice' } },
    { name: 'Мыльный пузырь', cols: ['#ffffff'], style: 'water', water: { core: '#e8f4ff', rim: '#ffffff', kind: 'soap' } },
    // Владелец 11.10: прозрачное сиреневое «стекло» с золотистой кромкой — без надписей и без глаза-треугольника (бывшее «Всевидящее око», на том же месте списка)
    { name: 'Аметист', cols: ['#8a5cff'], style: 'water', water: { core: '#8a5cff', rim: '#ffd27a', kind: 'eye' } },
    // Владелец 11.10: больше спокойных разных скинов для ботов (и чёрных), чтобы змеи не были одинаковыми и глаза не уставали
    { name: 'Графит', cols: ['#2b2d31'] },
    { name: 'Антрацит', cols: ['#1b1d22', '#1b1d22', '#2a2d34', '#2a2d34'] },
    { name: 'Матовый чёрный', cols: ['#111214'] },
    { name: 'Чёрно-золотой', cols: ['#161616', '#161616', '#161616', '#c9a227'] },
    { name: 'Чёрно-красный', cols: ['#151515', '#151515', '#151515', '#a3222c'] },
    { name: 'Чёрно-серый', cols: ['#151515', '#151515', '#6d737a', '#6d737a'] },
    { name: 'Мокрый асфальт', cols: ['#464b53'] },
    { name: 'Пепельный', cols: ['#9aa0a6'] },
    { name: 'Слоновая кость', cols: ['#efe8d6'] },
    { name: 'Бежевый', cols: ['#d9c7a3'] },
    { name: 'Шоколад', cols: ['#5a3a24'] },
    { name: 'Кофе с молоком', cols: ['#8a6446', '#8a6446', '#cfb08e', '#cfb08e'] },
    { name: 'Хаки', cols: ['#6b7350'] },
    { name: 'Тёмно-зелёный', cols: ['#24533a'] },
    { name: 'Бордовый', cols: ['#6e1f2a'] },
    { name: 'Медный', cols: ['#a8643a'] },
    { name: 'Горчичный', cols: ['#c4a03a'] },
    { name: 'Терракота', cols: ['#b5583c'] },
    { name: 'Бело-серый', cols: ['#eeeeee', '#eeeeee', '#9aa0a6', '#9aa0a6'] },
    { name: 'Серо-оранжевый', cols: ['#4f545b', '#4f545b', '#4f545b', '#ff8a1f'] },
    { name: 'Бело-оранжевый', cols: ['#f2f2f2', '#f2f2f2', '#f2f2f2', '#ff8a1f'] },
    { name: 'Сталь', cols: ['#7d8792', '#7d8792', '#a9b2bc', '#a9b2bc'] },
    { name: 'Хамелеон', cols: ['#3fbf5f', '#2aa198', '#d6c23a', '#e07a2a'], eyes: 'chameleon', style: 'chameleon' }, // владелец 19.10: вместо Зубастика — переливается, глаза-«башенки»; маскировка: без ускорения 1,5 с — сливается с полом
    { name: 'Ниндзя', cols: ['#141418', '#eeeeee'], eyes: 'ninja' }, // владелец 14.10: чёрный и белый через раз, красная повязка, одна дымовая шашка на жизнь
    // Владелец 11.10: секретный скин владельца — видит на 30% больше всех; включается только тайной ссылкой с кодом (?eye=…)
    { name: 'Йеменский хамелеон', cols: ['#3fa548', '#3fa548', '#3fa548', '#e8c43a', '#3fa548', '#3fa548', '#3fa548', '#2ab3a6'], eyes: 'yemen', side: true }, // владелец 19.10: высокий шлем на голове, зелёное тело с жёлтыми и бирюзовыми поперечными полосами, светлая полоса по боку
    // 20.10 (владелец: «ещё живых, как хамелеон — выберу потом»): пока скрытые, в выборе скинов только по ссылке ?preview=1
    { name: 'Каракатица', cols: ['#7a4a6e'], style: 'fx', fx: 'cuttle', preview: true, water: { core: '#6b3f5e', rim: '#e8b6d8', kind: 'cuttle' }, hot: { core: '#c8121e', rim: '#ff9a9a', kind: 'cuttlehot' } },
    { name: 'Медуза', cols: ['#d58cff'], style: 'fx', fx: 'jelly', preview: true, water: { core: '#b65cff', rim: '#ffc8f5', kind: 'jelly' }, hot: { core: '#1fc8ff', rim: '#d2f8ff', kind: 'jellyhot' } },
    { name: 'Лава', cols: ['#4a0e05'], style: 'fx', fx: 'lava', preview: true, solidCol: '#4a0e05', hotCol: '#ff9a1a' },
    { name: 'Светлячок', cols: ['#20263a'], style: 'fx', fx: 'firefly', preview: true, water: { core: '#1c2236', rim: '#56628a', kind: 'firefly' }, hot: { core: '#2a2a14', rim: '#ffe14a', kind: 'fireflyhot' } },
    { name: 'Хрустальная', cols: ['#e8f4ff'], style: 'fx', fx: 'crystal', preview: true, water: { core: '#dff0ff', rim: '#ffffff', kind: 'crystal' }, hot: { core: '#f2e8ff', rim: '#ffffff', kind: 'crystalhot' } },
    { name: 'Ледяной дракон', cols: ['#9fdcff'], style: 'fx', fx: 'frost', preview: true, water: { core: '#8fd2ff', rim: '#ffffff', kind: 'frost' }, hot: { core: '#e8f8ff', rim: '#ffffff', kind: 'frosthot' } },
  ];
  const EYE_ID = SKINS.findIndex(d => d.name === 'Циклоп'); // скин с обзором на 30% больше (владелец 11.10: «Всевидящее око» убрано, возможность — Циклопу)
  const EYE_ZOOM = 1 / 1.3; // обзор на 30% больше
  const CHAM_ID = SKINS.findIndex(d => d.name === 'Хамелеон');
  const NINJA_ID = SKINS.findIndex(d => d.name === 'Ниндзя');
  // Палитра конструктора «Собрать змейку» — 40 шариков, как в оригинале
  const PALETTE = [
    '#c0282d', '#9a9a9a', '#16208c', '#a8191e', '#a3a12a', '#8a5a2b', '#a2338f', '#1f7a2e', '#5a6fd6', '#5c2a8f',
    '#2b33c8', '#8a4fd1', '#d4b52a', '#2a3fd0', '#3049c2', '#4a1f9a', '#d2560f', '#3fa6c4', '#8c8f7a', '#2f9a3f',
    '#16c75a', '#c8383a', '#b52ac0', '#d6d6d6', '#6d7cd6', '#444444', '#c9922f', '#1f6b55', '#4f5fd0', '#7a83d6',
    '#3a46c8', '#9a63c9', '#6d73c2', '#4fa3a8', '#4fc25a', '#b5b545', '#c97a3f', '#c97a7a', '#d03535', '#f2f2f2',
    '#ffb35c', // владелец 11.10: чисто светло-оранжевый
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
    'Пчела', 'Конфета', 'Вода', 'Глубина', 'Лёд', 'Мыльный пузырь', 'Аметист', 'Россия', 'Таджикистан', 'Германия', 'Бразилия', 'Циклоп', 'Улитка', 'Хамелеон', 'Йеменский хамелеон', 'Ниндзя'];
  const PICKABLE = SKINS.map((d, i) => (SHOWN.includes(d.name) ? i : -1)).filter(i => i >= 0);
  const api = { SKINS, PALETTE, MAX_PATTERN, skinCols, PICKABLE, EYE_ID, EYE_ZOOM, CHAM_ID, NINJA_ID };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Skins = api;
})(typeof window !== 'undefined' ? window : this);
