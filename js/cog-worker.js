/*
 * The COG reader's decoder, off the main thread.
 *
 * Zstd and LERC are the two slowest things this page does per tile, and both
 * ran on the main thread, where they compete with the map for the same frames.
 * `@developmentseed/geotiff` can decode in a Web Worker instead — this is that
 * worker, and js/cog-rgb.js spawns it.
 *
 * It is a file in this repository rather than the reader's own
 * `defaultDecoderPool()` for two reasons, and both are about where code is
 * served from.
 *
 * **A worker has to be same-origin.** The reader's default pool does
 * `new Worker(new URL("./worker.js", import.meta.url))`, which resolves against
 * the CDN the module came from, and a cross-origin worker script is refused.
 * This file is served beside the page, so it is allowed to exist, and being a
 * module worker it may then import from a CDN that sends CORS.
 *
 * **A worker gets no import map.** The page resolves `lerc` to the package's
 * own file through the import map in index.html, because the CDN's build of it
 * rewrites `globalThis.process` to a Node polyfill that reports `versions.node`
 * — so lerc's emscripten loader decides it is running under Node and reaches
 * for `createRequire`. Import maps are per-document and workers do not inherit
 * them, so that fix is not available here. What is available is the reader's
 * own extension point: the decoder registry is exported, and the package
 * documents overriding a codec before importing the worker handler. So LERC is
 * registered here against the same untouched build of lerc the page uses, and
 * the CDN's copy is never reached.
 *
 * The URLs arrive on this worker's own query string rather than from
 * js/config.js: config resolves `site-config.js` and the page's query
 * parameters, neither of which exists in here.
 */

const params = new URLSearchParams(location.search);
const readerUrl = params.get("reader");
const workerUrl = params.get("worker");
const lercUrl = params.get("lerc");

/* TIFF compression codes, from @cogeotiff/core's `Compression`. Written out
 * rather than imported: three numbers are not worth another module in a worker
 * whose whole job is to be cheap to start. */
const LERC = 34887;
const DEFLATE = 32946;
const ZSTD = 50000;

/* LERC's own inner compression, from LercParameters[1] — the second word of the
 * tag GDAL writes beside a LERC_ZSTD or LERC_DEFLATE tile. */
const INNER = { 1: DEFLATE, 2: ZSTD };

const [{ DECODER_REGISTRY }, lerc] = await Promise.all([import(readerUrl), import(lercUrl)]);

let loaded = null;

/* The same shape as the codec it replaces: unwrap LERC's inner compression
 * through whichever decoder the registry already has for it, then hand the
 * result to lerc. `pixels` is taken and `mask` is dropped, exactly as the
 * original does — see the nodata note in js/rasters.js for why that is a
 * problem this page solves elsewhere rather than here. */
DECODER_REGISTRY.set(LERC, () => async (bytes, metadata) => {
  const inner = INNER[metadata.lercParameters?.[1] ?? 0];
  let input = bytes;
  if (inner !== undefined) {
    const decoder = await DECODER_REGISTRY.get(inner)();
    input = await decoder(bytes, metadata);
  }
  loaded ??= lerc.load();
  await loaded;
  return { layout: "band-separate", bands: lerc.decode(input).pixels };
});

/* Imported for its side effect: it adds the `message` listener that answers
 * decode jobs. Dynamic rather than static so that it runs *after* the override
 * above, which a hoisted `import` would not. */
await import(workerUrl);

/* Said once, when everything above has resolved. js/cog-rgb.js waits for this
 * before handing the worker to the pool: a module worker that fails to load
 * reports it asynchronously, and a pool built on a dead worker would leave
 * every tile pending for ever rather than falling back to the main thread. */
postMessage({ glaceWorkerReady: true });
