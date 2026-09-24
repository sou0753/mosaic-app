'use strict';
// Change this version whenever publishing an app update.
const VERSION = '20260924-3.0.0';
const PREFIX = 'mosaic-app:' + self.registration.scope + ':';
const CACHE = PREFIX + VERSION;
const ASSETS = ['./', './index.html', './style.css', './app.js', './manifest.json',
  './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS.map(path => new Request(new URL(path, self.registration.scope), { cache: 'reload' })));
    // Adopt the old v1 worker once; later updates wait for explicit user action.
    const keys = await caches.keys();
    if (!keys.some(key => key.startsWith(PREFIX) && key !== CACHE)) await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)));
    // v1 used a shared origin-wide cache. Remove only entries belonging to this app.
    if (keys.includes('mosaic-v1')) {
      const legacy = await caches.open('mosaic-v1');
      const requests = await legacy.keys();
      await Promise.all(requests.filter(request => request.url.startsWith(self.registration.scope)).map(request => legacy.delete(request)));
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'GET_VERSION') event.ports[0]?.postMessage({ version: VERSION });
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || !url.href.startsWith(self.registration.scope)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(event.request, { ignoreSearch: true });
    if (cached) return cached;
    if (event.request.mode === 'navigate') {
      const shell = await cache.match(new URL('./index.html', self.registration.scope));
      if (shell) return shell;
    }
    return fetch(event.request);
  })());
});
