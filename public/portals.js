'use strict';
// Потайные ходы (владелец 11.10): пары нор на карте. Заполз головой в одну — выползаешь из другой, в обе стороны.
// Общий файл: читают сервер и браузер. Координаты — точки на постерах, которые отметил владелец.
(function (root) {
  const PORTALS = [
    // постер «девушка за роялем» (p27): у плеча слева ⇄ у клавиш внизу справа
    [[3449, -1469], [3878, -1136]],
  ];
  const PORTAL_R = 20;   // радиус норы (владелец 11.10: ещё меньше — было 46, потом 30)
  const api = { PORTALS, PORTAL_R };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Portals = api;
})(typeof window !== 'undefined' ? window : this);
