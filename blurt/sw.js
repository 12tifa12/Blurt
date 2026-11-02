// Blurt service worker: lets the app open offline, and handles taps on reminder notifications.
const CACHE = 'blurt-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first so updates show up right away; the cache is only the offline fallback
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(req).then(res => {
    if ((res.ok || res.type === 'opaque') && !url.search.includes('text=')) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('/'))));
});

// The app keeps its data in the page, so the buttons are passed to an open window, or open one
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const id = (e.notification.data || {}).id, act = e.action || 'open';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) {
      wins[0].postMessage({ act, id });
      if (act === 'open') return wins[0].focus();
      return;
    }
    return self.clients.openWindow(act === 'open' ? '/' : `/?act=${act}&id=${encodeURIComponent(id)}`);
  })());
});
