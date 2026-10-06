'use strict';
// Роли из «Мафии» — лестница по длине змеи (владелец 06.10). Общий файл: читают сервер и браузер.
// Последняя роль — «Дон Мафии»: всегда одна, у самой длинной змеи на всей карте (человек или бот).
(function (root) {
  const ROLES = [
    { name: 'Мирный',      icon: '🙂', color: '#8a93a8', min: 0 },
    { name: 'Проститутка', icon: '💋', color: '#ff5fc8', min: 150 },
    { name: 'Параноик',    icon: '👀', color: '#9b4dff', min: 300 },
    { name: 'Бомба',       icon: '💣', color: '#ff8a1f', min: 500 },
    { name: 'Доктор',      icon: '🩺', color: '#3ddc5a', min: 800 },
    { name: 'Шериф',       icon: '⭐', color: '#3d8bff', min: 1200 },
    { name: 'Комиссар',    icon: '🕵️', color: '#2fd3f5', min: 1700 },
    { name: 'Киллер',      icon: '🔪', color: '#c0c6d0', min: 2400 },
    { name: 'Мафия',       icon: '🔫', color: '#e8323c', min: 3300 },
    { name: 'Дон Мафии',   icon: '👑', color: '#ffd52e', min: Infinity },
  ];
  const DON = ROLES.length - 1;
  // Роль по длине. Повышаем сразу; понижаем, только если стал заметно меньше порога (×0.85), чтобы табличка не прыгала
  function rankFor(mass, prev) {
    let r = 0;
    for (let i = 0; i < DON; i++) if (mass >= ROLES[i].min) r = i;
    if (prev > r && prev < DON && mass >= ROLES[prev].min * 0.85) r = prev;
    return r;
  }
  const api = { ROLES, DON, rankFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Roles = api;
})(typeof window !== 'undefined' ? window : this);
