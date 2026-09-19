/*
 * Unused glace-rgb:// protocol for coloring COG tiles in the browser. Recipes name
 * one archive for a ramp or two for RGB. Requires matching WebMercatorQuad grids
 * and pixel-aligned overviews; it does no reprojection or resampling. The published
 * ETRS89-LAEA mosaics do not meet that contract. The reader is imported on demand.
 */

import { COG_READER_URL } from "./config.js";

/* Half the WebMercator span, which is also the coordinate of its origin. */
const HALF_SPAN = 20037508.342789244;
const TILE = 256;

/* Register recipes before adding a source using glace-rgb://<recipe>/{z}/{x}/{y}. */
const recipes = new Map();

export const recipeTiles = (id) => `glace-rgb://${id}/{z}/{x}/{y}`;

/**
 * Register archive URLs, value domain, and ramp or channel stretches.
 *
 * @param {string} id
 * @param {{archives: string[], decibel: boolean,
 *          ramp?: {range: [number, number], colors: string[]},
 *          channels?: {red: [number, number], green: [number, number], blue: [number, number]}}} recipe
 */
export function setRecipe(id, recipe) {
  recipes.set(id, recipe);
}

/* Cache the import promise so concurrent tile requests share it. */
let readerModule = null;
const reader = () => (readerModule ??= import(COG_READER_URL));

/* Share archive handles across tiles and recipes. */
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

/*
 * Bounded LRU cache of decoded-tile promises, keyed by archive, level, and tile.
 * Neighboring XYZ windows can overlap source tiles; caching the promise shares
 * concurrent reads. The limit holds about 32 MB of float data.
 */
const MAX_CACHED_TILES = 128;
const decoded = new Map();

/* Fetch individual source tiles so overlapping windows can share them. */
function sourceTile(level, levelKey, tx, ty) {
  const key = `${levelKey}:${tx},${ty}`;
  const hit = decoded.get(key);
  if (hit !== undefined) {
    decoded.delete(key);
    decoded.set(key, hit);
    return hit;
  }
  const pending = level.fetchTile(tx, ty).then(
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

/*
 * Derive native zoom from pixel size (256·2^z pixels across WebMercator). Overviews
 * run finest to coarsest and exclude the full-resolution image. Return null outside
 * the available zoom range.
 */
function levelFor(tiff, z) {
  const native = Math.round(Math.log2((2 * HALF_SPAN) / (TILE * tiff.transform[0])));
  const step = native - z;
  if (step < 0) return null;
  const level = step === 0 ? tiff : (tiff.overviews[step - 1] ?? null);
  // Include the overview step in the cache key.
  return level === null ? null : { level, step };
}

/*
 * Copy a pixel-aligned XYZ window, which may straddle four source tiles. Pixels
 * outside the image remain zero (nodata).
 */
async function readWindow(level, levelKey, x, y) {
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
    wanted.map(([tx, ty]) => sourceTile(level, levelKey, tx, ty)),
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

/* MapLibre protocols return encoded image bytes. */
async function encode(rgba) {
  const canvas = new OffscreenCanvas(TILE, TILE);
  canvas.getContext("2d").putImageData(new ImageData(rgba, TILE, TILE), 0, 0);
  return (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer();
}

/*
 * Return a cached transparent image for missing coverage so MapLibre marks the tile
 * loaded.
 */
let blank = null;
const blankTile = async () => (blank ??= await encode(new Uint8ClampedArray(TILE * TILE * 4)));

const channel = (value, [low, high]) =>
  Math.max(0, Math.min(255, Math.round((255 * (value - low)) / (high - low))));

/* Interpolate published color stops and clamp values to the stretch endpoints. */
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

/* Convert linear power to dB when the recipe uses dB stretches. */
const read = (stored, decibel) => (decibel ? 10 * Math.log10(stored) : stored);

/*
 * The reader discards LERC's validity mask and decodes invalid pixels as zero. This
 * assumes valid pixels are nonzero; recheck for replacement datasets.
 */
const absent = (value) => value === 0 || !Number.isFinite(value);

/* One archive through a color ramp. */
function compositeRamp([values], recipe) {
  const rgba = new Uint8ClampedArray(TILE * TILE * 4);
  const paint = rampScale(recipe.ramp);
  for (let at = 0; at < TILE * TILE; at++) {
    const stored = values[at];
    if (absent(stored)) continue;
    const value = read(stored, recipe.decibel);
    // Skip values outside the logarithm's domain.
    if (!Number.isFinite(value)) continue;
    paint(value, rgba, at * 4);
  }
  return rgba;
}

/*
 * Render only where both archives have data. The blue channel is their ratio:
 * division for linear values, subtraction for dB.
 */
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
  if (recipe === undefined) throw new Error(`no false-color recipe named ${at[1]}`);
  const [z, x, y] = [Number(at[2]), Number(at[3]), Number(at[4])];

  const tiffs = await Promise.all(recipe.archives.map(archive));
  const levels = tiffs.map((tiff) => levelFor(tiff, z));
  // Return a blank tile outside the COG's available zoom levels.
  if (levels.some((level) => level === null)) return { data: await blankTile() };

  /*
   * Do not pass abort signals into shared cached reads: canceling one consumer
   * would fail others. Check for cancellation after the reads instead.
   */
  const values = await Promise.all(
    levels.map(({ level, step }, at) => readWindow(level, `${recipe.archives[at]}@${step}`, x, y)),
  );
  if (abortController?.signal?.aborted) throw new DOMException("tile aborted", "AbortError");
  return { data: await encode(composite(values, recipe)) };
}
