const CACHE = 'shithead-v7';
const ASSETS = ['/', '/index.html', '/manifest.json', '/socket.io/socket.io.js'];

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
    // Never intercept API calls
    if (url.includes('/api/')) return;
    // Network first for everything — fallback to cache when server is sleeping
    e.respondWith(
        fetch(e.request).catch(() => caches.match(e.request))
    );
});
