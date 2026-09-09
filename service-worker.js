/* Service worker for Семейная связь (static GitHub Pages edition) */
const CACHE = 'call-static-lk12';

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

  // Never cache cross-origin (LiveKit, GitHub API, Font Awesome CDN, etc.)
  if (url.origin !== self.location.origin) return;

  // Bypass range requests (large media playback)
  if (req.headers.get('range')) return;

  // ============================================================
  // NETWORK-FIRST for navigation requests (HTML pages).
  // This ensures users always get the latest HTML on first reload,
  // not a stale cached version referencing old JS versions.
  // Previous cache-first strategy required TWO reloads to see updates.
  // ============================================================
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match(base)))
    );
    return;
  }

  // CACHE-FIRST for static assets (CSS, JS, images) with background update.
  // Versioned query strings (?v=...) ensure new versions are treated as
  // new resources, so the cache never serves stale JS/CSS.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req).then((res) => {
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
