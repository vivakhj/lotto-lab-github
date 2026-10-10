/* App shell offline cache. Draw data always uses network first. */
const CACHE = 'lotto-lab-shell-v1';
const SCOPE = new URL('./', self.location.href);
const ASSETS = ['index.html', 'styles.css', 'app.js', 'lotto-core.js', 'data/lotto-data.js', 'data/lotto.json', 'manifest.webmanifest', 'assets/icon.svg', 'assets/icon-192.png', 'assets/icon-512.png'].map(p => new URL(p, SCOPE).href);
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('lotto-lab-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  const path = url.pathname.slice(SCOPE.pathname.length);
  if (!ASSETS.includes(url.href) && path !== '') return;
  event.respondWith((async () => {
    const key = path === '' ? new URL('index.html', SCOPE).href : event.request;
    const cache = await caches.open(CACHE);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 9000);
    try {
      const response = await fetch(event.request, { cache: 'no-store', signal: controller.signal });
      if (response.ok) { await cache.put(key, response.clone()); return response; }
      const previous = await cache.match(key);
      return previous || response;
    } catch (error) {
      const previous = await cache.match(key);
      if (previous) return previous;
      throw error;
    } finally { clearTimeout(timer); }
  })());
});
