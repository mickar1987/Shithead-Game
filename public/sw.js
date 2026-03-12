const CACHE = 'shithead-v6';
const STATIC_ASSETS = ['/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC_ASSETS)));
    self.skipWaiting(); // activate immediately
});

self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys =>
        Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ));
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    const url = e.request.url;
    // Never intercept API calls or socket.io
    if (url.includes('/api/') || url.includes('socket.io')) return;
    // Never cache HTML — always fetch fresh from network
    if (e.request.destination === 'document' || url.endsWith('/') || url.endsWith('.html')) {
        e.respondWith(fetch(e.request).catch(() => caches.match('/')));
        return;
    }
    // Static assets: cache first
    e.respondWith(
        caches.match(e.request).then(cached => cached || fetch(e.request))
    );
});
