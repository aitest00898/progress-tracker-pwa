const CACHE = 'progress-tracker-v12';
const INDEX_URL = './index.html';
const ROOT_URL = './';
const STATIC_SHELL = [
  './manifest.webmanifest',
  './manifest.en.webmanifest',
  './favicon.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable.png',
  './apple-touch-icon.png',
];

function scoped(path) {
  return new URL(path, self.registration.scope).toString();
}

function documentAssets(html) {
  const paths = [];
  const pattern = /(?:src|href)=["'](\.\/assets\/[^"']+)["']/g;
  for (const match of html.matchAll(pattern)) paths.push(scoped(match[1]));
  return [...new Set(paths)];
}

async function cacheDocument(response) {
  const html = await response.clone().text();
  const cache = await caches.open(CACHE);
  const assets = documentAssets(html);
  await Promise.all(assets.map(async (url) => {
    const assetResponse = await fetch(url, { cache: 'no-store' });
    if (!assetResponse.ok) throw new Error(`App asset unavailable: ${url}`);
    const headers = new Headers(assetResponse.headers);
    if (url.endsWith('.js')) headers.set('Content-Type', 'text/javascript; charset=utf-8');
    if (url.endsWith('.css')) headers.set('Content-Type', 'text/css; charset=utf-8');
    const normalized = new Response(await assetResponse.arrayBuffer(), {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers,
    });
    await cache.put(url, normalized);
  }));
  const documentHeaders = new Headers(response.headers);
  documentHeaders.set('Content-Type', 'text/html; charset=utf-8');
  const documentResponse = new Response(await response.clone().arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers: documentHeaders,
  });
  await cache.put(scoped(INDEX_URL), documentResponse.clone());
  await cache.put(scoped(ROOT_URL), documentResponse);
}

async function fetchAndCacheDocument(request = scoped(INDEX_URL)) {
  const response = await fetch(request, { cache: 'no-store' });
  if (!response.ok) throw new Error('App document unavailable');
  await cacheDocument(response);
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(STATIC_SHELL.map(scoped));
    await fetchAndCacheDocument();
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetchAndCacheDocument(event.request);
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match(scoped(INDEX_URL))) ?? (await cache.match(scoped(ROOT_URL)));
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok) await cache.put(event.request, response.clone());
    return response;
  })());
});
