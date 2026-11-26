const CACHE_NAME = 'nexo-shell-__NEXO_BUILD_ID__';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const shellResponse = await fetch('./', { cache: 'no-store' });
    if (!shellResponse.ok) throw new Error('Não foi possível carregar a versão atual do Nexo.');
    const shellText = await shellResponse.clone().text();
    await cache.put('./', shellResponse);
    const assets = [...shellText.matchAll(/(?:src|href)="([^"]+\.(?:js|css|svg))"/g)].map((match) => match[1]);
    await cache.addAll(['./manifest.webmanifest', './icon.svg', ...assets]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const hadOlderNexoCache = keys.some((key) => key.startsWith('nexo-') && key !== CACHE_NAME);
    await Promise.all(keys
      .filter((key) => key.startsWith('nexo-') && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();

    // Older Nexo service workers kept serving the old index.html from cache.
    // Reload already-open tabs once the replacement worker takes control.
    if (hadOlderNexoCache) {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      await Promise.all(windows.map(async (client) => {
        try { await client.navigate(client.url); } catch { /* A tab may have closed. */ }
      }));
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    if (request.mode === 'navigate') {
      try {
        const response = await fetch(request, { cache: 'no-store' });
        if (response.ok) await cache.put('./', response.clone());
        return response;
      } catch {
        return (await cache.match('./')) || Response.error();
      }
    }

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
