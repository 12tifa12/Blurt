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

// Network first so updates show up right away. But a sleeping server can take a minute to answer, so after
// a few seconds the saved copy is shown instead (the fresh one is still saved for next time).
const NETWORK_WAIT_MS = 3000;
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  const fresh = fetch(req).then(res => {
    if ((res.ok || res.type === 'opaque') && !/(text|code)=/.test(url.search)) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
    }
    return res;
  });
  e.respondWith((async () => {
    const saved = await caches.match(req, { ignoreSearch: true });
    if (!saved) return fresh.catch(() => caches.match('/'));
    const late = new Promise(resolve => setTimeout(() => resolve(saved), NETWORK_WAIT_MS));
    return Promise.race([fresh.catch(() => saved), late]);
  })());
  e.waitUntil(fresh.catch(() => {}));
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
