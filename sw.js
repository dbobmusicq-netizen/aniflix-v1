/**
 * AnimeDrift - Enterprise Hybrid Offline & Edge Synchronizer
 * Version: 41.0.0 Production Service Worker Engine
 * Host: https://animedrift.vercel.app
 *
 * Upgrades:
 * - Version Bump to v41.0.0 (pairs with HTML, CSS, and JS manifests).
 * - Automatic Stale Query Rewrite: Catches older hardcoded calls (e.g., ?v=32.0.0)
 *   from core-engine.js and streaming-ui.js at network level, rewriting them to v41.0.0.
 * - Non-Disruptive Update Protocol: Listens for SKIP_WAITING from the interactive UI HUD.
 * - Unrestricted Search Bot & Crawler Pass-Through (Zero SEO penalization).
 * - Multi-Tier Cache Layer (Static Shell, Dynamic Responses, Image CDN Engine).
 * - Strict Stream, Range & WebRTC Bypass (NxSha, Filmu, PeerJS, HLS/DASH Chunks).
 * - FIFO Cache Pruner & Automated Stale Cache Eviction.
 * - Bi-directional Push Notification & Background Watch Sync Bridge.
 */

const VERSION = '43.1.1';
const STATIC_CACHE = `animedrift-static-v${VERSION}`;
const DYNAMIC_CACHE = `animedrift-dynamic-v${VERSION}`;
const IMAGE_CACHE = `animedrift-images-v${VERSION}`;

const MAX_IMAGE_ENTRIES = 100;
const MAX_DYNAMIC_ENTRIES = 80;
const NETWORK_TIMEOUT_MS = 4500;

// Immutable App Shell Assets
const IMMUTABLE_APP_SHELL = [
  '/',
  '/index.html',
  `/theme-base.css?v=${VERSION}`,
  `/components-modal.css?v=${VERSION}`,
  `/p2p.css?v=${VERSION}`,
  `/webapp.css?v=${VERSION}`,
  `/mobile.css?v=${VERSION}`,
  `/core-engine.js?v=${VERSION}`,
  `/streaming-ui.js?v=${VERSION}`,
  `/dash-player.js?v=${VERSION}`,
  `/adblock-engine.js?v=${VERSION}`,
  `/p2p.js?v=${VERSION}`,
  `/webapp.js?v=${VERSION}`,
  `/secure.js?v=${VERSION}`,
  `/manifest.json?v=${VERSION}`,
  '/favicon.ico',
  '/favicon-16x16.png',
  '/favicon-32x32.png',
  '/apple-touch-icon.png',
  '/android-chrome-192x192.png',
  '/android-chrome-512x512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/shaka-player/4.7.11/shaka-player.compiled.js',
  'https://cdn.jsdelivr.net/npm/dexie@3.2.4/dist/dexie.min.js',
  'https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js'
];

// Domains and signatures that MUST bypass Service Worker caching completely
const BYPASS_DOMAINS = [
  'nxsha.space',
  'nxsha.site',
  'filmu.in',
  'filmu.stream',
  'vidcore.org',
  'vidcore.net',
  'vidfast.vc',
  'vidfast.io',
  'vidsrc.me',
  'vidsrc.sbs',
  'primesrc.me',
  'primesrc.xyz',
  'multiembed.mov',
  '2embed.cc',
  'peerjs.com',
  'speedracelight.com'
];

const STREAM_EXTENSIONS = [
  '.m3u8',
  '.mpd',
  '.ts',
  '.m4s',
  '.aac',
  '.vtt',
  '.key'
];

const SEARCH_BOT_SIGNATURES = [
  'googlebot',
  'bingbot',
  'yandex',
  'duckduckbot',
  'slurp',
  'baiduspider',
  'facebot',
  'facebookexternalhit',
  'twitterbot',
  'linkedinbot',
  'applebot'
];

/**
 * Cache Pruning Utility (FIFO Eviction)
 */
async function trimCache(cacheName, maxItems) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxItems) {
      await cache.delete(keys[0]);
      await trimCache(cacheName, maxItems);
    }
  } catch (err) {
    console.warn(`[SW Trim] Error pruning ${cacheName}:`, err);
  }
}

/**
 * Fetch Promise with Timeout
 */
function fetchWithTimeout(request, timeoutMs = NETWORK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[SW Timeout] Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    fetch(request)
      .then((response) => {
        clearTimeout(timer);
        resolve(response);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

// ===============================================================
// 1. LIFECYCLE: INSTALL
// ===============================================================
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(async (cache) => {
      const results = await Promise.allSettled(
        IMMUTABLE_APP_SHELL.map(async (asset) => {
          try {
            const res = await fetch(asset, { cache: 'reload' });
            if (res.ok || res.type === 'opaque') {
              return await cache.put(asset, res);
            }
          } catch (err) {
            console.warn(`[SW Install] Non-critical asset skipped: ${asset}`);
          }
        })
      );
      return results;
    })
  );
  // Does NOT call self.skipWaiting() automatically here, allowing the interactive HUD in index.html to prompt the user.
});

// ===============================================================
// 2. LIFECYCLE: ACTIVATE (Evict Old Cache Partitions)
// ===============================================================
self.addEventListener('activate', (event) => {
  const activeCaches = [STATIC_CACHE, DYNAMIC_CACHE, IMAGE_CACHE];
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (!activeCaches.includes(key)) {
            console.info(`[SW Activate] Purging outdated cache partition: ${key}`);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// ===============================================================
// 3. FETCH STRATEGY ENGINE & RUNTIME REWRITER
// ===============================================================
self.addEventListener('fetch', (event) => {
  let request = event.request;
  const url = new URL(request.url);
  const userAgent = (request.headers.get('user-agent') || '').toLowerCase();

  // 1. Search Engine Crawler Pass-Through (Zero SW interception for SEO)
  if (SEARCH_BOT_SIGNATURES.some((bot) => userAgent.includes(bot))) {
    return;
  }

  // 2. Hard Bypass Criteria (Media streams, range requests, WebSockets, PeerJS)
  if (
    request.method !== 'GET' ||
    url.protocol.startsWith('ws') ||
    url.protocol.startsWith('chrome-extension') ||
    request.headers.has('range') ||
    url.pathname.includes('/peerjs') ||
    STREAM_EXTENSIONS.some((ext) => url.pathname.toLowerCase().endsWith(ext)) ||
    BYPASS_DOMAINS.some((domain) => url.hostname.toLowerCase().includes(domain))
  ) {
    return;
  }

  // 3. Dynamic Query-String Normalizer for CSS & JS
  // Catches any hardcoded ?v=32.0.0 requests coming from core-engine.js or streaming-ui.js and upgrades them to v41.0.0
  if (
    (url.pathname.endsWith('.css') || url.pathname.endsWith('.js')) &&
    url.origin === location.origin &&
    url.searchParams.has('v') &&
    url.searchParams.get('v') !== VERSION
  ) {
    url.searchParams.set('v', VERSION);
    request = new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
      mode: request.mode,
      credentials: request.credentials,
      redirect: request.redirect
    });
  }

  // 4. Image Strategy: Cache-First with Fallback
  if (
    request.destination === 'image' ||
    url.hostname.includes('image.tmdb.org') ||
    url.hostname.includes('anilistcdn') ||
    url.hostname.includes('cdn.myanimelist.net')
  ) {
    event.respondWith(
      caches.open(IMAGE_CACHE).then(async (cache) => {
        const cachedResponse = await cache.match(request, { ignoreSearch: true });
        if (cachedResponse) return cachedResponse;

        try {
          const networkResponse = await fetch(request);
          if (networkResponse.status === 200 || networkResponse.type === 'opaque') {
            cache.put(request, networkResponse.clone());
            trimCache(IMAGE_CACHE, MAX_IMAGE_ENTRIES);
          }
          return networkResponse;
        } catch (err) {
          return new Response(
            '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450" fill="%230e0e16"><rect width="100%" height="100%" fill="%230e0e16"/><text x="50%" y="50%" fill="%235e5e7a" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="700">AnimeDrift Offline</text></svg>',
            { headers: { 'Content-Type': 'image/svg+xml' } }
          );
        }
      })
    );
    return;
  }

  // 5. App Shell Strategy: Stale-While-Revalidate with Query-Agnostic Match
  if (
    request.destination === 'style' ||
    request.destination === 'script' ||
    request.destination === 'font' ||
    url.origin === location.origin
  ) {
    event.respondWith(
      caches.match(request, { ignoreSearch: true }).then((cachedResponse) => {
        const fetchPromise = fetch(request)
          .then(async (networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const cache = await caches.open(STATIC_CACHE);
              cache.put(request, networkResponse.clone());
            }
            return networkResponse;
          })
          .catch(() => {
            if (request.mode === 'navigate') {
              return caches.match('/index.html', { ignoreSearch: true });
            }
          });

        return cachedResponse || fetchPromise;
      })
    );
    return;
  }

  // 6. Network-First with Dynamic Cache Fallback
  event.respondWith(
    fetchWithTimeout(request, NETWORK_TIMEOUT_MS)
      .then(async (networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const cache = await caches.open(DYNAMIC_CACHE);
          cache.put(request, networkResponse.clone());
          trimCache(DYNAMIC_CACHE, MAX_DYNAMIC_ENTRIES);
        }
        return networkResponse;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;

        if (request.mode === 'navigate') {
          const indexShell = await caches.match('/index.html', { ignoreSearch: true });
          if (indexShell) return indexShell;
        }

        return new Response(
          JSON.stringify({
            error: 'Network connection unavailable. Offline mode engaged.',
            offline: true
          }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      })
  );
});

// ===============================================================
// 4. PUSH NOTIFICATIONS & ENGAGEMENT
// ===============================================================
self.addEventListener('push', (event) => {
  let payload = {
    title: 'AnimeDrift',
    body: 'New simulcast episode streaming now or watch party active!',
    icon: '/android-chrome-192x192.png',
    badge: '/favicon-32x32.png',
    data: { url: '/' }
  };

  if (event.data) {
    try {
      payload = Object.assign(payload, event.data.json());
    } catch (e) {
      payload.body = event.data.text();
    }
  }

  const notificationOptions = {
    body: payload.body,
    icon: payload.icon || '/android-chrome-192x192.png',
    badge: payload.badge || '/favicon-32x32.png',
    vibrate: [100, 50, 100, 50, 150],
    data: payload.data || { url: '/' },
    actions: payload.actions || [
      { action: 'open', title: 'Watch Now' },
      { action: 'dismiss', title: 'Dismiss' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(payload.title, notificationOptions)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url || '/';
  const action = event.action;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(targetUrl) && 'focus' in client) {
          if (action === 'play' || action === 'open') {
            client.postMessage({
              type: 'NOTIFICATION_ACTION_PLAY',
              animeId: event.notification.data?.animeId,
              episode: event.notification.data?.episode || 1,
              season: event.notification.data?.season || 1
            });
          }
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

// ===============================================================
// 5. BACKGROUND SYNC
// ===============================================================
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-watch-progress') {
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
        windowClients.forEach((client) => {
          client.postMessage({ type: 'SYNC_COMPLETE' });
        });
      })
    );
  }
});

// ===============================================================
// 6. CONTROL PROTOCOL & SKIP_WAITING DISPATCHER
// ===============================================================
self.addEventListener('message', (event) => {
  if (event.data) {
    if (event.data.type === 'SKIP_WAITING') {
      self.skipWaiting();
    }
    if (event.data.type === 'CLEAR_OLD_CACHES') {
      caches.keys().then((keys) => {
        keys.forEach((key) => {
          if (!key.includes(VERSION)) caches.delete(key);
        });
      });
    }
  }
});
