// Марми Мафия — минимальный service worker: нужен, чтобы телефон предлагал «Установить» игру как приложение.
// Ничего не кэширует — всегда берёт свежую версию с сервера, чтобы обновления игры доходили сразу.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => { if (e.request.mode === 'navigate') e.respondWith(fetch(e.request)); });
