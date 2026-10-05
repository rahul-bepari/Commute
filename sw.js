/* =========================================================================
   COMMUTE — sw.js
   Offline-first service worker. This app is meant to be used standing on
   the street with a rickshaw waiting, so everything needed for a fare
   estimate (app shell + bundled landmark/bus datasets) is cached on
   install and served cache-first afterwards.
   ========================================================================= */

const CACHE_NAME = 'commute-cache-v1';
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './icon.svg',
  './data/landmarks.json',
  './data/bus-routes.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

// Cache-first for everything the app needs, falling back to network and
// then updating the cache — this is what makes a re-estimate work with
// zero signal bars.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // Last resort for navigations while fully offline and uncached.
          if (event.request.mode === 'navigate') return caches.match('./index.html');
        });
    })
  );
});
