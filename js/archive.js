/*
 * One shared PMTiles reader per raster archive, registered with MapLibre's
 * pmtiles:// protocol and backed by a byte cache. MapLibre reloads a raster-dem
 * source whenever a layer's visibility changes, and false-color composites read
 * the same VV and VH tiles; both are then served from memory.
 */

/* Upper bound on cached bytes across all archives. */
const MAX_BYTES = 64 * 1024 * 1024;

/* Expose each archive's TileJSON metadata, including attribution. */
export const protocol = new pmtiles.Protocol({ metadata: true });

/*
 * A catalog archive's source, read past the HTTP cache. Every tile is a range
 * request to the same URL, and Chrome lets one request per URL write a cache
 * entry at a time, so a view's tiles would queue behind that lock. The catalog
 * host marks its responses no-cache, so the cache could at best revalidate a
 * read. pmtiles sets this flag itself only for Chrome on Windows; the lock is
 * not Windows-only. After an ETag mismatch pmtiles reads with cache: "reload".
 */
export function uncachedSource(url) {
  const source = new pmtiles.FetchSource(url);
  source.chromeWindowsNoCache = true;
  return source;
}

/**
 * Register a fresh reader of a vector archive with the protocol, past the HTTP
 * cache with `noStore`. Fresh on every call: a reader keeps a failed header
 * read, so a retry needs a new one.
 */
export function registerVector(url, { noStore = false } = {}) {
  protocol.add(new pmtiles.PMTiles(noStore ? uncachedSource(url) : url));
}

const aborted = () => new DOMException("aborted", "AbortError");

/**
 * Stop waiting when `signal` aborts, without canceling a read other callers
 * still share.
 */
export function unlessAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const abort = () => reject(aborted());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/* Byte ranges by archive and offset, least recently used first. */
const ranges = new Map();
let cachedBytes = 0;

function evict() {
  for (const [key, entry] of ranges) {
    if (cachedBytes <= MAX_BYTES) break;
    ranges.delete(key);
    cachedBytes -= entry.size;
  }
}

/* A pmtiles source that keeps what it reads; failures are not kept, and call `onFailure`. */
class CachedSource {
  constructor(url, onFailure) {
    this.source = uncachedSource(url);
    this.onFailure = onFailure;
  }

  getKey() {
    return this.source.getKey();
  }

  forget() {
    const prefix = `${this.getKey()}|`;
    for (const [key, entry] of ranges) {
      if (!key.startsWith(prefix)) continue;
      ranges.delete(key);
      cachedBytes -= entry.size;
    }
  }

  getBytes(offset, length, signal, etag) {
    const key = `${this.getKey()}|${offset}|${length}`;
    let entry = ranges.get(key);
    if (entry) {
      ranges.delete(key);
      ranges.set(key, entry);
    } else {
      entry = { size: 0, read: this.source.getBytes(offset, length, undefined, etag) };
      ranges.set(key, entry);
      entry.read.then(
        (response) => {
          if (ranges.get(key) !== entry) return;
          entry.size = response.data.byteLength;
          cachedBytes += entry.size;
          evict();
        },
        (error) => {
          if (ranges.get(key) === entry) ranges.delete(key);
          // The archive changed: PMTiles rereads its header, so drop the old one.
          if (error instanceof pmtiles.EtagMismatch) this.forget();
          this.onFailure();
        },
      );
    }
    // A copy, so a consumer that transfers its buffer leaves the cache intact.
    return unlessAborted(entry.read, signal).then((response) => ({
      ...response,
      data: response.data.slice(0),
    }));
  }
}

const readers = new Map();

/*
 * A reader keeps a failed header or directory read for good, which would
 * leave its part of the map blank, so a failed read replaces the reader. The
 * new one reads what the old one had from the byte cache.
 */
function register(url) {
  const reader = new pmtiles.PMTiles(
    new CachedSource(url, () => {
      if (readers.get(url) === reader) register(url);
    }),
  );
  readers.set(url, reader);
  protocol.add(reader);
  return reader;
}

/** The shared reader of one archive, registered with the protocol on first use. */
export function archive(url) {
  return readers.get(url) ?? register(url);
}
