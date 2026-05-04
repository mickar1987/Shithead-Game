const CACHE = 'basrhead-v4';
const ASSETS = ['/manifest.json', '/icon-192.png', '/icon-512.png'];

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
    if (url.includes('/api/') || url.includes('socket.io')) return;
    // NEVER cache HTML — always fetch from network
    if (url.endsWith('/') || url.includes('index.html') ||
        url.split('?')[0].split('/').pop().indexOf('.') === -1) {
        e.respondWith(fetch(e.request.clone(), {cache: 'no-store'}).catch(() => caches.match(e.request)));
        return;
    }
    // Network first for everything else
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
