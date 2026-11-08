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
 * not Windows-only. After an ETag mismatch pmtiles sets mustReload for good, to
 * read with cache: "reload", which writes the cache and so takes the lock;
 * no-store already reads past the cache, so the flag stays off.
 */
export function uncachedSource(url) {
  const source = new pmtiles.FetchSource(url);
  source.chromeWindowsNoCache = true;
  Object.defineProperty(source, "mustReload", { get: () => false, set() {} });
  return source;
}

/*
 * pmtiles' SharedPromiseCache keeps the promise of each header and directory
 * read, a rejected one too, for the life of its reader: one network blip on an
 * archive's first read would fail every later read until a reload. This one
 * forgets a failed read, so the next read asks the archive again.
 */
class ForgetfulCache extends pmtiles.SharedPromiseCache {
  getHeader(source) {
    return this.#forgetOnFailure(() => super.getHeader(source));
  }

  getDirectory(source, offset, length, header, signal) {
    return this.#forgetOnFailure(() => super.getDirectory(source, offset, length, header, signal));
  }

  /*
   * After an ETag mismatch pmtiles drops the header and reads it again, and
   * keeps that read to share with other callers; a failed one would be
   * returned on every later mismatch, and the stale header never dropped.
   */
  invalidate(source) {
    const key = source.getKey();
    const done = super.invalidate(source);
    const pending = this.invalidations.get(key);
    pending?.catch(() => {
      if (this.invalidations.get(key) === pending) this.invalidations.delete(key);
    });
    return done;
  }

  /*
   * A miss adds its entry before the read's first await, as the newest in the
   * map; a hit adds none. If the read fails and the entry is still the same
   * one, it goes.
   */
  #forgetOnFailure(read) {
    const size = this.cache.size;
    const promise = read();
    if (this.cache.size > size) {
      let key;
      for (const newest of this.cache.keys()) key = newest;
      const entry = this.cache.get(key);
      promise.catch(() => {
        if (this.cache.get(key) === entry) this.cache.delete(key);
      });
    }
    return promise;
  }
}

/** A pmtiles cache that forgets a failed header or directory read. */
export const forgetfulCache = () => new ForgetfulCache();

const vectors = new Map();

/**
 * Register the reader of a vector archive with the protocol, past the HTTP
 * cache with `noStore`. A retry keeps the reader: its cache forgot the failure.
 */
export function registerVector(url, { noStore = false } = {}) {
  let reader = vectors.get(url);
  if (!reader) {
    reader = new pmtiles.PMTiles(noStore ? uncachedSource(url) : url, forgetfulCache());
    vectors.set(url, reader);
  }
  protocol.add(reader);
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

/* A pmtiles source that keeps what it reads; failures are not kept. */
class CachedSource {
  constructor(url) {
    this.source = uncachedSource(url);
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

/** The shared reader of one archive, registered with the protocol on first use. */
export function archive(url) {
  let reader = readers.get(url);
  if (!reader) {
    reader = new pmtiles.PMTiles(new CachedSource(url), forgetfulCache());
    readers.set(url, reader);
    protocol.add(reader);
  }
  return reader;
}
