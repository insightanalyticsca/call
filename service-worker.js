/* Service worker for Семейная связь (static GitHub Pages edition) */
const CACHE = 'call-static-v55';

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

// Handle notification clicks — focus the app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ('focus' in client) return client.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow('/');
      })
  );
});

// Allow the page to trigger notifications via postMessage to SW
// (needed for iOS Safari PWA where window.Notification doesn't work)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const { title, body, icon, tag } = event.data;
    self.registration.showNotification(title, {
      body: body || '',
      icon: icon || 'icon.svg',
      badge: 'icon.svg',
      tag: tag || title,
      requireInteraction: false,
      data: { url: '/' }
    }).catch(() => {});
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return;
  if (req.headers.get('range')) return;

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
