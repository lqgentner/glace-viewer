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
    this.source = new pmtiles.FetchSource(url);
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
  if (reader === undefined) {
    reader = new pmtiles.PMTiles(new CachedSource(url));
    readers.set(url, reader);
    protocol.add(reader);
  }
  return reader;
}
