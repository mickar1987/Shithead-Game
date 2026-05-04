// v249 - Never cache HTML
const CACHE = 'basrhead-v5';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys =>
        Promise.all(keys.map(k => caches.delete(k)))
    ));
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    // Never intercept API or socket
    if (url.pathname.startsWith('/api/') || url.pathname.includes('socket.io')) return;
    // Always network for HTML
    if (url.pathname === '/' || url.pathname.endsWith('.html')) {
        e.respondWith(
            fetch(e.request, { cache: 'no-store' })
            .catch(() => new Response('Offline', { status: 503 }))
        );
        return;
    }
    // Icons/manifest: cache OK
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
