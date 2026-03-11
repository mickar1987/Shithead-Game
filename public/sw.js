// Unregister all caches — force fresh load every time
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
        .then(() => self.clients.claim())
    );
});
// No caching at all — network only
