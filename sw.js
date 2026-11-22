const CACHE_PREFIX = 'glyphflow-shell-';
const CACHE_NAME = CACHE_PREFIX + 'v1';
const APP_SCOPE = self.registration.scope;
const APP_SHELL = [
  new URL('./', APP_SCOPE).href,
  new URL('index.html', APP_SCOPE).href,
  new URL('manifest.webmanifest', APP_SCOPE).href,
  new URL('icons/glyphflow.svg', APP_SCOPE).href
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(APP_SCOPE)) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(new URL('index.html', APP_SCOPE).href, response.clone());
        return response;
      } catch {
        return (await cache.match(new URL('index.html', APP_SCOPE).href)) ||
          (await cache.match(new URL('./', APP_SCOPE).href)) ||
          Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch {
      return Response.error();
    }
  })());
});
