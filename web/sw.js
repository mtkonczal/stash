// Stash Service Worker
//
// Strategy: stale-while-revalidate for all static assets (same-origin and
// CDN). Serve from cache immediately so app launch never waits on the
// network, then refresh the cache in the background so the next launch
// picks up any deploy. Supabase API calls bypass the SW entirely.
//
// Bump CACHE_NAME on deploys that must take effect immediately.
const CACHE_NAME = 'stash-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/config.js',
  '/manifest.json',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/marked/marked.min.js',
  'https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js',
];

// Install
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch - stale-while-revalidate
self.addEventListener('fetch', (event) => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip API requests (let them go to network)
  if (event.request.url.includes('supabase.co')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      // Always kick off a background refresh
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, clone);
            });
          }
          return response;
        })
        .catch(() => cached); // Offline: fall back to cache if we have it

      // Cached copy wins the race; network result updates the cache for
      // next time. First-ever request has no cache, so wait for network.
      return cached || network;
    })
  );
});
