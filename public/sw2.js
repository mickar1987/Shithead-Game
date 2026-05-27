// v4.311 — cache app shell for offline support
const CACHE = 'basrhead-v4.311';
const PRECACHE = ['/index.html', '/socket.io/socket.io.js'];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE).then(c =>
            Promise.all(PRECACHE.map(url =>
                fetch(url).then(r => { if (r.ok) c.put(url, r); }).catch(() => {})
            ))
        )
    );
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    // Pass through: API calls, non-GET, cross-origin
    if (url.pathname.startsWith('/api/')) return;
    if (e.request.method !== 'GET') return;
    if (url.origin !== self.location.origin) return;
    // Pass through socket.io polling/WS (has query string like ?EIO=4)
    if (url.pathname.startsWith('/socket.io/') && url.search) return;

    // App shell (HTML): network-first, cache fallback when offline
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.endsWith('.html')) {
        e.respondWith(
            fetch(e.request, { cache: 'no-store' })
                .then(r => {
                    if (r.ok) caches.open(CACHE).then(c => c.put('/index.html', r.clone()));
                    return r;
                })
                .catch(() => caches.match('/index.html'))
        );
        return;
    }

    // socket.io.js: cache-first, refresh in background
    if (url.pathname === '/socket.io/socket.io.js') {
        e.respondWith(
            caches.match(e.request).then(cached => {
                const net = fetch(e.request).then(r => {
                    if (r.ok) caches.open(CACHE).then(c => c.put(e.request, r.clone()));
                    return r;
                }).catch(() => cached);
                return cached || net;
            })
        );
        return;
    }

    // Other static assets (icons, manifest): network with cache fallback
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
