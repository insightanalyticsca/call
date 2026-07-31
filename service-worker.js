/* Service worker for Семейная связь (static GitHub Pages edition) */
const CACHE = 'call-static-v47';

self.addEventListener('install', (event) => {
  const base = self.registration ? self.registration.scope : './';
  const assets = [
    base,
    new URL('index.html', base).href,
    new URL('styles.css', base).href,
    new URL('app.js', base).href,
    new URL('manifest.webmanifest', base).href,
    new URL('icon.svg', base).href
  ];
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(assets.map((a) => cache.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache cross-origin (PeerJS broker, STUN, Font Awesome CDN, etc.)
  if (url.origin !== self.location.origin) return;

  // Bypass range requests (large media playback from IndexedDB object URLs)
  if (req.headers.get('range')) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req).then((res) => {
        // Cache same-origin successful responses
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, clone)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
