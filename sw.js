// Service worker del Copiloto de Inversión — PWA offline.
// Estrategia:
//   · Shell estático (HTML/CSS/JS): cache-first (carga instantánea en repeticiones).
//   · Datos de mercado (history.json): network-first con fallback a caché
//     (para recoger la actualización nocturna, pero funcionar sin red).
//   · Todo lo demás same-origin: stale-while-revalidate.
// Sube CACHE_VERSION cuando cambie el shell para invalidar la caché antigua.

const CACHE_VERSION = 'copiloto-v4';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/ui/chart.js',
  './js/data/providers.js',
  './js/core/engine.js',
  './js/core/indicators.js',
  './js/core/brokers.js',
  './js/core/assets.js',
  './js/core/profile.js',
  './js/core/feedback.js',
  './js/core/store.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // addAll falla si algún recurso 404ea; toleramos fallos individuales
    await Promise.allSettled(SHELL.map(u => cache.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // APIs de mercado: nunca las tocamos

  // Datos de mercado: network-first (frescura) con fallback a caché (offline).
  if (url.pathname.endsWith('/data/history.json')) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        return (await cache.match(req)) || Response.error();
      }
    })());
    return;
  }

  // Resto same-origin: stale-while-revalidate.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req);
    const network = fetch(req).then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  })());
});
