// Shellie Reader's service worker: keeps the site's own files so it opens without a connection.
// The page itself: the network first, the kept copy when that fails. Files under /assets/ are named after their
// content: the kept copy first. Requests to /api/ are never touched: what was sent is kept, still encrypted, by the
// page itself (IndexedDB).

// Change the name to throw away everything kept by an earlier worker.
const CACHE = 'shellie-reader-v1';
const PAGE = '/';
const EXTRAS = [
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/apple-touch-icon.png',
];

/** The hashed files a page loads. */
const assetsOf = (html) =>
  [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);

/** Keeps a page and the files it names, and drops the hashed files of an earlier build. */
async function keepPage(response) {
  const cache = await caches.open(CACHE);
  const wanted = assetsOf(await response.clone().text());
  await cache.put(PAGE, response);
  await Promise.all(
    wanted.map(async (url) => {
      if (!(await cache.match(url))) await cache.add(url);
    }),
  );
  for (const request of await cache.keys()) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/assets/') && !wanted.includes(pathname))
      await cache.delete(request);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await keepPage(await fetch(PAGE, { cache: 'no-store' }));
      const cache = await caches.open(CACHE);
      // An icon that is missing must not stop the worker.
      await Promise.all(EXTRAS.map((url) => cache.add(url).catch(() => {})));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name !== CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

async function page(event) {
  const { request } = event;
  try {
    const response = await fetch(request);
    // Kept after the answer went out: a slow file must not hold the page up.
    if (response.ok)
      event.waitUntil(keepPage(response.clone()).catch(() => {}));
    return response;
  } catch (err) {
    const kept = await caches.match(PAGE);
    if (kept) return kept;
    throw err;
  }
}

async function keptFirst(request) {
  const kept = await caches.match(request);
  if (kept) return kept;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  try {
    return await fetch(request);
  } catch (err) {
    const kept = await caches.match(request);
    if (kept) return kept;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') return;
  if (request.mode === 'navigate') event.respondWith(page(event));
  else if (url.pathname.startsWith('/assets/'))
    event.respondWith(keptFirst(request));
  else if (EXTRAS.includes(url.pathname))
    event.respondWith(networkFirst(request));
});
