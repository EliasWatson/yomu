// Cache-first for the big, immutable dictionary files so they survive across sessions.
const C = 'yomu-dict-v1';
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || !(u.pathname.startsWith('/dict/') || u.pathname.startsWith('/vendor/'))) return;
  e.respondWith(caches.open(C).then(async c => (await c.match(e.request)) || fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; })));
});
