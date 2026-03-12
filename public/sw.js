const CACHE = 'shithead-v6';
const ASSETS = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
    self.skipWaiting();
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
    // Network first for everything else
    e.respondWith(
        fetch(e.request).catch(() => caches.match(e.request))
    );
});
