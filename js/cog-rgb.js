/*
 * The COG layers, behind a MapLibre protocol of our own.
 *
 * `glace-rgb://` serves both of them: a single-band mosaic through a colour
 * ramp, and the false-colour composite of two. Its URL names a *recipe* rather
 * than an archive, which is what lets one tile be read from two files — the
 * thing a one-URL-is-one-GeoTIFF protocol cannot do, and the reason this module
 * exists at all. Having the single-band layers come through it too is what
 * gives them one reader, one decoded-tile cache and one colour path instead of
 * two of each.
 *
 * What makes it cheap is the store's canonical grid. Every mosaic of a scope is
 * written on the WebMercatorQuad grid at one zoom, so VV and VH share a size,
 * an origin, a blocking and an overview count: tile (x, y) of one covers
 * exactly the ground of tile (x, y) of the other. The grid also lines up with
 * the XYZ pyramid — measured on `glace-ch`, the image origin sits 1 088 000 by
 * 734 720 pixels from the WebMercator origin at z13, and halving stays integral
 * through all seven overview levels. So a tile here is an integer window read
 * out of each file and a per-pixel combine: never a reprojection, never a
 * resample, never an interpolation.
 *
 * The reader is @developmentseed/geotiff, which decodes LERC and Zstd through
 * its own direct dependencies rather than through geotiff.js. It is ESM-only
 * with bare specifiers and ships no UMD build, so unlike the page's other
 * libraries it cannot be a `<script>` tag; it is imported dynamically, from a
 * CDN that resolves the bare specifiers, the first time a false-colour layer is
 * actually shown. A deployment that never selects one never fetches it.
 */

import { COG_READER_URL, COG_WORKER_URL, LERC_URL } from "./config.js";

/* Half the WebMercator span, which is also the coordinate of its origin. */
const HALF_SPAN = 20037508.342789244;
const TILE = 256;

/* `glace-rgb://<recipe>/{z}/{x}/{y}`. The recipe is a key into the map below
 * rather than anything encoded in the URL: a tile needs two archives, three
 * stretches and a channel rule, which do not belong in a hostname. Same shape
 * as the single-band path's `setColorFunction` registry, and registered the
 * same way — before the source that reads it exists. */
const recipes = new Map();

export const recipeTiles = (id) => `glace-rgb://${id}/{z}/{x}/{y}`;

/**
 * A recipe names the archives a tile is read from, whether their values are
 * read in dB, and how those values become a colour: a `ramp` over one archive,
 * or `channels` over two.
 *
 * @param {string} id
 * @param {{archives: string[], decibel: boolean,
 *          ramp?: {range: [number, number], colors: string[]},
 *          channels?: {red: [number, number], green: [number, number], blue: [number, number]}}} recipe
 */
export function setRecipe(id, recipe) {
  recipes.set(id, recipe);
}

/* Imported once, on the first tile of the first false-colour layer. Held as the
 * promise rather than the module so that concurrent first tiles — which is the
 * normal case, a viewport asks for a dozen at once — share one fetch. */
let readerModule = null;
const reader = () => (readerModule ??= import(COG_READER_URL));

/* One entry per archive, so the two files behind a recipe are opened once and
 * their headers are not re-read for every tile. Keyed on the URL, so the VV of
 * one year is shared by every recipe naming it. */
const archives = new Map();

function archive(url) {
  if (!archives.has(url)) {
    archives.set(
      url,
      reader().then(({ GeoTIFF }) => GeoTIFF.fromUrl(url)),
    );
  }
  return archives.get(url);
}

/* Decoding, moved off the main thread.
 *
 * Zstd and then LERC are the slowest things this page does per tile, and on the
 * main thread they compete with the map for the same frames. The reader can
 * decode in workers instead, given a pool; js/cog-worker.js is the worker, and
 * the note at the top of it says why it is a file here rather than the
 * reader's own default.
 *
 * The workers are started and *proved* before the pool is built. A module
 * worker reports a failed load asynchronously, so a pool handed a dead worker
 * would leave every tile pending for ever — strictly worse than not having one.
 * Each worker therefore has to say it is ready, within a timeout, or it is
 * dropped; if none answer, the pool is built without workers and the reader
 * decodes inline exactly as it did before. */
const WORKER_LIMIT = 4;
const WORKER_TIMEOUT = 10_000;

function spawnWorker(source) {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(source, { type: "module" });
    } catch {
      resolve(null);
      return;
    }
    const settle = (ready) => {
      clearTimeout(timer);
      worker.removeEventListener("message", onReady);
      worker.removeEventListener("error", onFailure);
      if (ready) resolve(worker);
      else {
        worker.terminate();
        resolve(null);
      }
    };
    const onReady = (event) => {
      if (event.data?.glaceWorkerReady) settle(true);
    };
    const onFailure = () => settle(false);
    const timer = setTimeout(() => settle(false), WORKER_TIMEOUT);
    worker.addEventListener("message", onReady);
    worker.addEventListener("error", onFailure);
  });
}

/* Built once, on the first tile, and shared by every layer after it. */
let decoderPool = null;

function pool() {
  decoderPool ??= (async () => {
    const { DecoderPool } = await reader();
    // A reader with no pool to offer decodes inline, which is the old behaviour
    // and a perfectly good one. The test harness's stand-in is such a reader.
    if (typeof DecoderPool !== "function") return null;
    if (typeof Worker !== "function") return new DecoderPool();

    const source = new URL("./cog-worker.js", import.meta.url);
    source.searchParams.set("reader", COG_READER_URL);
    source.searchParams.set("worker", COG_WORKER_URL);
    source.searchParams.set("lerc", LERC_URL);

    const size = Math.min(WORKER_LIMIT, navigator?.hardwareConcurrency ?? 2);
    const started = await Promise.all(Array.from({ length: size }, () => spawnWorker(source)));
    const live = started.filter((worker) => worker !== null);
    if (live.length === 0) {
      console.warn("cog-worker.js did not start; decoding on the main thread");
      return new DecoderPool();
    }
    return new DecoderPool({ size: live.length, createWorker: () => live.pop() });
  })();
  return decoderPool;
}

/* Decoded source tiles, keyed by archive, level and tile index.
 *
 * This is not about switching layers — MapLibre keeps a hidden layer's source
 * and its rendered tiles, so coming back to one is already cheap. It is about
 * the *same* viewport. Below z12 the image origin lands on a half or a quarter
 * tile, so neighbouring XYZ tiles straddle the same source tiles, and one 6x4
 * viewport asks for each of them several times over. Measured, per archive:
 *
 *   z13  24 reads -> 24 distinct     z10  88 reads -> 30 distinct
 *   z12  24 reads -> 24 distinct      z9  63 reads -> 20 distinct
 *   z11  96 reads -> 35 distinct      z8  24 reads ->  6 distinct
 *
 * The promise is cached rather than the array it resolves to, so tiles asked
 * for at the same moment — which is exactly what a viewport does — share one
 * read instead of racing each other to make the same request.
 *
 * Bounded, because a session panning across a continent would otherwise keep
 * every tile it ever touched: a 256x256 float tile is 256 kB, so the ceiling
 * below is about 32 MB — roughly one viewport of both archives at the level
 * that needs the most, with room to pan. A Map iterates in insertion order, so
 * deleting the first key evicts the least recently used as long as a hit
 * reinserts. */
const MAX_CACHED_TILES = 128;
const decoded = new Map();

/* `fetchTile` rather than the reader's `fetchTiles`, so that each tile is
 * cached and shared on its own. The batch call is documented as parallel today
 * and only *may* coalesce byte ranges later; when it does, this is the place to
 * reconsider. */
function sourceTile(level, levelKey, tx, ty, decoders) {
  const key = `${levelKey}:${tx},${ty}`;
  const hit = decoded.get(key);
  if (hit !== undefined) {
    decoded.delete(key);
    decoded.set(key, hit);
    return hit;
  }
  const pending = level.fetchTile(tx, ty, decoders === null ? undefined : { pool: decoders }).then(
    (tile) => tile.array,
    (error) => {
      // A failure is not cached: panning back over this tile should retry it.
      decoded.delete(key);
      throw error;
    },
  );
  decoded.set(key, pending);
  while (decoded.size > MAX_CACHED_TILES) decoded.delete(decoded.keys().next().value);
  return pending;
}

/* Which resolution level answers this zoom.
 *
 * The file says what its own full-resolution zoom is: a WebMercatorQuad level
 * spans 256·2^z pixels across the whole projection, so the pixel size fixes z.
 * Reading it off the transform rather than hard-coding 13 is what lets the same
 * code serve a store built on a different zoom.
 *
 * `overviews` is finest-to-coarsest and excludes the full-resolution image, so
 * one step down is `overviews[0]`. Null means the file cannot answer: zoomed in
 * past its native level, or out past its coarsest overview. */
function levelFor(tiff, z) {
  const native = Math.round(Math.log2((2 * HALF_SPAN) / (TILE * tiff.transform[0])));
  const step = native - z;
  if (step < 0) return null;
  const level = step === 0 ? tiff : (tiff.overviews[step - 1] ?? null);
  // The step travels with the level because it names the level in the cache
  // key, where the archive's URL alone would not tell two zooms apart.
  return level === null ? null : { level, step };
}

/* One XYZ tile's values, read out of `level`.
 *
 * The window is in the level's own pixel space, offset from the XYZ grid by a
 * whole number of pixels (see the note at the top), so this is a copy rather
 * than a sampling. It can straddle up to four source tiles: at the levels where
 * the origin lands on a half or quarter tile boundary the window is not tile
 * aligned even though it is pixel aligned.
 *
 * Pixels the window does not reach — outside the image, or in a tile the
 * archive does not store — stay 0, which is what the archives already encode
 * absent data as. */
async function readWindow(level, levelKey, x, y, decoders) {
  const resolution = level.transform[0];
  const originX = Math.round((level.transform[2] + HALF_SPAN) / resolution);
  const originY = Math.round((HALF_SPAN - level.transform[5]) / resolution);
  const left = x * TILE - originX;
  const top = y * TILE - originY;

  const out = new Float32Array(TILE * TILE);
  const offImage =
    left + TILE <= 0 || top + TILE <= 0 || left >= level.width || top >= level.height;
  if (offImage) return out;

  const firstX = Math.floor(Math.max(0, left) / TILE);
  const lastX = Math.floor(Math.min(level.width - 1, left + TILE - 1) / TILE);
  const firstY = Math.floor(Math.max(0, top) / TILE);
  const lastY = Math.floor(Math.min(level.height - 1, top + TILE - 1) / TILE);

  const wanted = [];
  for (let ty = firstY; ty <= lastY; ty++) {
    for (let tx = firstX; tx <= lastX; tx++) wanted.push([tx, ty]);
  }
  const arrays = await Promise.all(
    wanted.map(([tx, ty]) => sourceTile(level, levelKey, tx, ty, decoders)),
  );

  for (const [at, [tx, ty]] of wanted.entries()) {
    const array = arrays[at];
    const band = array.bands[0];
    for (let row = 0; row < array.height; row++) {
      const withinY = ty * TILE + row - top;
      if (withinY < 0 || withinY >= TILE) continue;
      for (let column = 0; column < array.width; column++) {
        const withinX = tx * TILE + column - left;
        if (withinX < 0 || withinX >= TILE) continue;
        out[withinY * TILE + withinX] = band[row * array.width + column];
      }
    }
  }
  return out;
}

/* MapLibre wants encoded image bytes back from a protocol, the same as the
 * PMTiles path hands it WEBP. OffscreenCanvas is what turns the RGBA into
 * them without a library. */
async function encode(rgba) {
  const canvas = new OffscreenCanvas(TILE, TILE);
  canvas.getContext("2d").putImageData(new ImageData(rgba, TILE, TILE), 0, 0);
  return (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer();
}

/* Encoded once: a level the archives cannot answer, and a tile that lies wholly
 * outside them, both come back as this rather than as nothing. Answering with a
 * blank tile is what lets MapLibre mark the tile loaded — the same reason the
 * PMTiles protocol is wrapped in js/map.js. */
let blank = null;
const blankTile = async () => (blank ??= await encode(new Uint8ClampedArray(TILE * TILE * 4)));

const channel = (value, [low, high]) =>
  Math.max(0, Math.min(255, Math.round((255 * (value - low)) / (high - low))));

/* A piecewise-linear ramp over the manifest's colour stops.
 *
 * The stops are a colour map already sampled — seventeen of them for the
 * store's layers — so interpolating between them reproduces the map closely
 * enough that the two sources draw the same picture, which is the point of
 * being able to switch between them. Values outside the stretch clamp to its
 * ends, as the ramp baked into the PMTiles does. */
function rampScale({ colors, range: [low, high] }) {
  const stops = colors.map((hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)));
  const last = stops.length - 1;
  return (value, rgba, at) => {
    const place = Math.max(0, Math.min(1, (value - low) / (high - low))) * last;
    const first = Math.floor(place);
    const next = Math.min(first + 1, last);
    const between = place - first;
    for (let band = 0; band < 3; band++) {
      rgba[at + band] = stops[first][band] + (stops[next][band] - stops[first][band]) * between;
    }
    rgba[at + 3] = 255;
  };
}

/* The value as it is read, which is not always the value as it is stored.
 *
 * Every COG in the store is linear — `BACKSCATTER_CONVENTION=Power` on the
 * backscatter mosaics, a plain ratio on QA-CQM — while the stretches published
 * beside them are quoted in dB. The PMTiles were converted before their ramp
 * was baked in, so converting here is what makes the two sources agree. */
const read = (stored, decibel) => (decibel ? 10 * Math.log10(stored) : stored);

/* An exact zero is absent data. The reasoning, and the measurement behind it,
 * is in js/rasters.js: every browser reader drops LERC's validity mask, and a
 * zero is what an invalid pixel decodes to. */
const absent = (value) => value === 0 || !Number.isFinite(value);

/* One archive through a colour ramp. */
function compositeRamp([values], recipe) {
  const rgba = new Uint8ClampedArray(TILE * TILE * 4);
  const paint = rampScale(recipe.ramp);
  for (let at = 0; at < TILE * TILE; at++) {
    const stored = values[at];
    if (absent(stored)) continue;
    const value = read(stored, recipe.decibel);
    // A negative power has no dB. Absent is the honest answer, not a colour.
    if (!Number.isFinite(value)) continue;
    paint(value, rgba, at * 4);
  }
  return rgba;
}

/* Two archives combined into one false-colour tile.
 *
 * A pixel is drawn only where both files have data. They agree on that to the
 * pixel — measured across 15.3 million pixels of the store, 0 disagreements —
 * because both were warped from the same tile set onto the same grid, so the
 * intersection is not a compromise, it is the same footprint twice.
 *
 * The third channel is the ratio of the two, expressed in whatever domain the
 * product is read in: a quotient for coherence, which is read linearly, and a
 * difference for backscatter, which is read in dB — where a difference of logs
 * *is* the log of the quotient. One rule, two spellings. */
function compositeChannels([vv, vh], recipe) {
  const rgba = new Uint8ClampedArray(TILE * TILE * 4);
  const { red: redRange, green: greenRange, blue: blueRange } = recipe.channels;
  for (let at = 0; at < TILE * TILE; at++) {
    if (absent(vv[at]) || absent(vh[at])) continue;
    const red = read(vv[at], recipe.decibel);
    const green = read(vh[at], recipe.decibel);
    if (!Number.isFinite(red) || !Number.isFinite(green)) continue;
    const blue = recipe.decibel ? red - green : vv[at] / vh[at];

    rgba[at * 4] = channel(red, redRange);
    rgba[at * 4 + 1] = channel(green, greenRange);
    rgba[at * 4 + 2] = channel(blue, blueRange);
    rgba[at * 4 + 3] = 255;
  }
  return rgba;
}

const composite = (values, recipe) =>
  recipe.ramp ? compositeRamp(values, recipe) : compositeChannels(values, recipe);

const TILE_URL = /^glace-rgb:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/;

/** The MapLibre protocol handler. Registered in js/map.js. */
export async function cogRgbProtocol(params, abortController) {
  const at = TILE_URL.exec(params.url);
  if (at === null) throw new Error(`not a glace-rgb tile URL: ${params.url}`);
  const recipe = recipes.get(at[1]);
  if (recipe === undefined) throw new Error(`no false-colour recipe named ${at[1]}`);
  const [z, x, y] = [Number(at[2]), Number(at[3]), Number(at[4])];

  const tiffs = await Promise.all(recipe.archives.map(archive));
  const levels = tiffs.map((tiff) => levelFor(tiff, z));
  // Coarser than the archives carry. The pre-styled archives go further out
  // than the COGs' overviews do, so this is reachable by zooming out.
  if (levels.some((level) => level === null)) return { data: await blankTile() };

  /* The abort signal is deliberately not passed down into the reads. A cached
   * read is shared, and one consumer cancelling it would fail every other tile
   * waiting on the same source tile. Letting the bytes land instead costs one
   * request that was already in flight and leaves it in the cache, which on
   * these overlaps is usually wanted again within the same viewport. What abort
   * still does is stop the work after them. */
  const decoders = await pool();
  const values = await Promise.all(
    levels.map(({ level, step }, at) =>
      readWindow(level, `${recipe.archives[at]}@${step}`, x, y, decoders),
    ),
  );
  if (abortController?.signal?.aborted) throw new DOMException("tile aborted", "AbortError");
  return { data: await encode(composite(values, recipe)) };
}
