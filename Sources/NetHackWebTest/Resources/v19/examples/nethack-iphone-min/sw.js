const CACHE_NAME = 'nethack-v10-5-stable-1';

const CONTROL_CACHE = 'nethack-update-control';
const ACTIVE_CACHE_KEY = './__nethack_active_cache__';
const PREVIOUS_CACHE_KEY = './__nethack_previous_cache__';

const APP_FILES = [
  './',
  './index.html',
  './main.js',

  './ai/tf.min.js',
  './ai/model/model.json',
  './ai/model/group1-shard1of1.bin',

  '../../src/driver/index.js',
  '../../src/driver/NetHackWasmWorkerBridge.js',
  '../../src/driver/nethack.worker.js',
  '../../src/driver/InputResolver.js',
  '../../src/driver/NetHackMemory.js',
  '../../src/driver/NetHackFSManager.js',
  '../../src/driver/NetHackWasmDriver.js',

  '../../nethack.js',
  '../../nethack.wasm'
];

async function getActiveCacheName() {
  const control = await caches.open(CONTROL_CACHE);
  const response = await control.match(ACTIVE_CACHE_KEY);

  if (!response) {
    return CACHE_NAME;
  }

  const name = await response.text();

  if (!name) {
    return CACHE_NAME;
  }

  return name;
}

async function setActiveCacheName(name) {
  const control = await caches.open(CONTROL_CACHE);

  await control.put(
    ACTIVE_CACHE_KEY,
    new Response(name, {
      headers: {
        'Content-Type': 'text/plain'
      }
    })
  );
}

self.addEventListener('install', event => {
  console.log('[NetHack SW] install:', CACHE_NAME);

  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  console.log('[NetHack SW] activate:', CACHE_NAME);

  event.waitUntil(
    (async () => {
      const control = await caches.open(CONTROL_CACHE);
      const active = await control.match(ACTIVE_CACHE_KEY);

      // First use of the new switching mechanism.
      // Do not overwrite an existing selection.
      if (!active) {
        await setActiveCacheName(CACHE_NAME);
      }

      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', event => {
  const data = event.data;

  if (!data) {
    return;
  }

  if (data.type === 'GET_UPDATE_STATE') {
    event.waitUntil(
      (async () => {
        const control = await caches.open(CONTROL_CACHE);

        const activeResponse =
          await control.match(ACTIVE_CACHE_KEY);

        const previousResponse =
          await control.match(PREVIOUS_CACHE_KEY);

        const activeCache =
          activeResponse
            ? await activeResponse.text()
            : CACHE_NAME;

        const previousCache =
          previousResponse
            ? await previousResponse.text()
            : null;

        if (event.ports && event.ports[0]) {
          event.ports[0].postMessage({
            ok: true,
            swCache: CACHE_NAME,
            activeCache,
            previousCache
          });
        }
      })()
    );

    return;
  }

  if (data.type === 'ROLLBACK_CACHE') {
    event.waitUntil(
      (async () => {
        try {
          const control = await caches.open(CONTROL_CACHE);

          const previousResponse =
            await control.match(PREVIOUS_CACHE_KEY);

          if (!previousResponse) {
            throw new Error('Previous cache is not available');
          }

          const previousCacheName =
            await previousResponse.text();

          const activeResponse =
            await control.match(ACTIVE_CACHE_KEY);

          const currentCacheName =
            activeResponse
              ? await activeResponse.text()
              : CACHE_NAME;

          if (previousCacheName === currentCacheName) {
            throw new Error(
              'Previous cache is same as active cache'
            );
          }

          const names = await caches.keys();

          if (!names.includes(previousCacheName)) {
            throw new Error(
              'Previous cache does not exist: ' +
              previousCacheName
            );
          }

          await control.put(
            ACTIVE_CACHE_KEY,
            new Response(previousCacheName)
          );

          await control.put(
            PREVIOUS_CACHE_KEY,
            new Response(currentCacheName)
          );

          if (event.ports && event.ports[0]) {
            event.ports[0].postMessage({
              ok: true,
              cacheName: previousCacheName
            });
          }

        } catch (err) {
          if (event.ports && event.ports[0]) {
            event.ports[0].postMessage({
              ok: false,
              error: String(err)
            });
          }
        }
      })()
    );

    return;
  }

  if (data.type !== 'SET_ACTIVE_CACHE') {
    return;
  }

  const cacheName = data.cacheName;

  event.waitUntil(
    (async () => {
      try {
        const names = await caches.keys();

        if (!names.includes(cacheName)) {
          throw new Error(
            'Cache does not exist: ' + cacheName
          );
        }

        const control = await caches.open(CONTROL_CACHE);

        const activeResponse =
          await control.match(ACTIVE_CACHE_KEY);

        const oldCacheName =
          activeResponse
            ? await activeResponse.text()
            : CACHE_NAME;

        // Re-applying the currently active cache must not
        // destroy the previous-cache rollback point.
        if (oldCacheName !== cacheName) {
          await control.put(
            PREVIOUS_CACHE_KEY,
            new Response(oldCacheName)
          );

          await setActiveCacheName(cacheName);
        }

        if (event.ports && event.ports[0]) {
          event.ports[0].postMessage({
            ok: true,
            cacheName
          });
        }

      } catch (err) {
        if (event.ports && event.ports[0]) {
          event.ports[0].postMessage({
            ok: false,
            error: String(err)
          });
        }
      }
    })()
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    (async () => {
      const url = new URL(event.request.url);

      // Update downloads must bypass the currently active app cache.
      // downloadUpdate() adds ?update=<build>&t=<timestamp>.
      if (url.searchParams.has('update')) {
        return fetch(event.request, {
          cache: 'no-store'
        });
      }

      const activeCacheName =
        await getActiveCacheName();

      const cache =
        await caches.open(activeCacheName);

      const cached =
        await cache.match(event.request);

      if (cached) {
        return cached;
      }

      return fetch(event.request);
    })()
  );
});
ches.open(activeCacheName);

      const cached =
        await cache.match(event.request);

      if (cached) {
        return cached;
      }

      return fetch(event.request);
    })()
  );
});
