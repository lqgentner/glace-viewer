/*
 * The scale editor's histogram: the codes of a value-encoded archive counted
 * over the current view. Tiles are those MapLibre draws at this zoom, so most
 * come from the shared readers' cache in js/archive.js.
 */

import { archive, unlessAborted } from "./archive.js";
import { step, tilePixels } from "./values.js";

/* The default budget of tiles, past which a coarser zoom is read. */
const MAX_TILES = 48;
const MAX_LAT = 85.0511287798;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/* Web Mercator position in tiles at zoom z. */
const tileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
function tileY(lat, z) {
  const phi = (clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * 2 ** z;
}

/** The fractional tile extent of [west, south, east, north] at zoom z. */
function extent([west, south, east, north], z) {
  return { x0: tileX(west, z), x1: tileX(east, z), y0: tileY(north, z), y1: tileY(south, z) };
}

/*
 * Count each code 1-255 in one decoded tile, within the view's extent. Code 0
 * in all channels is nodata, and a lossy tile marks nodata with alpha 0.
 */
function countTile(counts, tile, x, y, view, encoding) {
  const { size, data } = tile;
  const px = (at, origin) => clamp(Math.round((at - origin) * size), 0, size);
  const [c0, c1, r0, r1] = [px(view.x0, x), px(view.x1, x), px(view.y0, y), px(view.y1, y)];
  const { redFactor, greenFactor, blueFactor } = encoding;
  const scale = step(encoding);
  for (let row = r0; row < r1; row++) {
    for (let col = c0; col < c1; col++) {
      const at = (row * size + col) * 4;
      if (data[at + 3] === 0) continue;
      const code = Math.round(
        (data[at] * redFactor + data[at + 1] * greenFactor + data[at + 2] * blueFactor) / scale,
      );
      if (code >= 1 && code <= 255) counts[code] += 1;
    }
  }
}

/**
 * Count the archive's codes in view. Index 0 of the result is unused.
 *
 * @param {object} layer  a value-encoded record from js/store.js
 * @param {number[]} bounds  the view as [west, south, east, north]
 * @param {number} zoom  the map's zoom
 * @param {AbortSignal} [signal]
 * @param {number} [maxTiles]  read a coarser zoom past this many tiles; the
 *   caller sizes it to the tiles MapLibre draws, so most are cached
 * @returns {Promise<Float64Array>}  256 counts
 */
export async function viewCounts(layer, bounds, zoom, signal, maxTiles = MAX_TILES) {
  const header = await unlessAborted(archive(layer.url).getHeader(), signal);
  const area = [
    Math.max(bounds[0], header.minLon),
    Math.max(bounds[1], header.minLat),
    Math.min(bounds[2], header.maxLon),
    Math.min(bounds[3], header.maxLat),
  ];
  const counts = new Float64Array(256);
  if (area[0] >= area[2] || area[1] >= area[3]) return counts;

  // MapLibre draws 256 px raster-dem tiles one zoom above the map's, rounded.
  let z = clamp(Math.round(zoom + 1), layer.minZoom, layer.maxZoom);
  let view = extent(area, z);
  const tiles = (v) => (Math.floor(v.x1) - Math.floor(v.x0) + 1) * (Math.floor(v.y1) - Math.floor(v.y0) + 1);
  while (z > layer.minZoom && tiles(view) > maxTiles) view = extent(area, --z);

  const reads = [];
  const last = 2 ** z - 1;
  for (let y = Math.floor(view.y0); y <= Math.min(last, Math.floor(view.y1)); y++) {
    for (let x = Math.floor(view.x0); x <= Math.min(last, Math.floor(view.x1)); x++) {
      reads.push(tilePixels(layer.url, z, x, y, signal).then((tile) => tile && { tile, x, y }));
    }
  }
  for (const read of await unlessAborted(Promise.all(reads), signal)) {
    if (read) countTile(counts, read.tile, read.x, read.y, view, layer.encoding);
  }
  return counts;
}

/**
 * An SVG path of one bar per code over a viewBox of 255 by `height`. Heights
 * follow log(1 + count), so one dominant code leaves the rest readable. Empty
 * when nothing was counted.
 */
export function histogramPath(counts, height) {
  const top = Math.log1p(Math.max(...counts));
  if (top === 0) return "";
  let path = "";
  for (let code = 1; code <= 255; code++) {
    const bar = (Math.log1p(counts[code]) / top) * height;
    if (bar > 0) path += `M${code - 1} ${height}h1V${(height - bar).toFixed(2)}h-1Z`;
  }
  return path;
}

/*
 * Positions in code units, where code c covers c ± 0.5: the point below which
 * a share p of the counted pixels falls, interpolated within its code.
 */
export function codeAt(counts, p) {
  let total = 0;
  for (let code = 1; code <= 255; code++) total += counts[code];
  const target = total * p;
  let below = 0;
  for (let code = 1; code <= 255; code++) {
    const count = counts[code];
    if (count > 0 && below + count >= target) return code - 0.5 + (target - below) / count;
    below += count;
  }
  return 255.5;
}

/** The lowest and highest codes counted, or null when there are none. */
export function codeRange(counts) {
  let low = null;
  let high = null;
  for (let code = 1; code <= 255; code++) {
    if (counts[code] === 0) continue;
    low ??= code;
    high = code;
  }
  return low === null ? null : [low, high];
}
