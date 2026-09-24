/* Daliz service worker. Generated into /sw.js by the build (precache list + version injected).
 *
 * - Precaches the app shell (HTML, JS, CSS, icons, manifest).
 * - Navigations: network first, falling back to the cached shell when offline.
 * - Static assets: cache first.
 * - NEVER caches /api/* — authenticated, tenant-scoped data only lives in the app's own
 *   IndexedDB offline layer, which is keyed per tenant and user.
 * - A new version waits until the user chooses "Reload" (SKIP_WAITING message).
 */
const VERSION = self.__VERSION__;
const PRECACHE = self.__PRECACHE__;
const SHELL_CACHE = `daliz-shell-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => undefined),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('daliz-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // never cached here

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => {
        const shell = await caches.match('/index.html', { cacheName: SHELL_CACHE });
        return shell || Response.error();
      }),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || PRECACHE.includes(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok && res.type === 'basic') {
              const copy = res.clone();
              caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});

function safeLink(link) {
  return typeof link === 'string' && link.startsWith('/') && !link.startsWith('//') && !link.startsWith('/\\') ? link : '/';
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Daliz', body: event.data ? event.data.text() : '' };
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Daliz';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-96.png',
      data: { link: safeLink(data.link) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = safeLink(event.notification.data && event.notification.data.link);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          await client.focus();
          client.postMessage({ type: 'NAVIGATE', link });
          return;
        }
      }
      await self.clients.openWindow(link);
    })(),
  );
});
