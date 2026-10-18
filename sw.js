/*
 * Stale-while-revalidate for JSON: the catalog collection, items and styles, the
 * inventory index, and basemap TileJSON and sprite indexes. Source Coop sends
 * no-cache, so without this every visit repeats the requests that precede the
 * first raster tile. A catalog change shows on the visit after it is published.
 * Everything else, including PMTiles range reads, goes to the network untouched.
 */

const CACHE = "glace-json-v1";
/* Bounds the cache when ?tiles= visits several stores; oldest entries go first. */
const MAX_ENTRIES = 200;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || !new URL(request.url).pathname.endsWith(".json")) return;
  event.respondWith(staleWhileRevalidate(event));
});

async function staleWhileRevalidate(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request);
  const fresh = fetch(event.request).then(async (response) => {
    // Opaque responses hide their status, so only readable successes are kept.
    if (response.ok && response.type !== "opaque") {
      await cache.put(event.request, response.clone());
      await trim(cache);
    }
    return response;
  });
  if (!cached) return fresh;
  event.waitUntil(fresh.catch(() => {}));
  return cached;
}

async function trim(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, -MAX_ENTRIES).map((key) => cache.delete(key)));
}
