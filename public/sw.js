// REVA service worker: offline app shell. API calls are never cached.
const CACHE = 'reva-shell-v1';
const SHELL = ['/', '/index.html', '/app.css', '/app.js', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  // network-first for extension files, cache-first for the shell
  if (url.pathname.startsWith('/extensions/')) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached ?? fetch(event.request).catch(() => caches.match('/index.html'))),
  );
});
