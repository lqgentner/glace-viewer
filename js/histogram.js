/*
 * The scale editor's histograms: the codes of a value-encoded archive, or a
 * false-color composite's channels, counted over the current view; and the
 * pixel under a click. Tiles are those MapLibre draws at this zoom, so most
 * come from the shared readers' cache in js/archive.js.
 */

import { archive, unlessAborted } from "./archive.js";
import { channelValues } from "./composite.js";
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

/* MapLibre draws 256 px raster tiles one zoom above the map's, rounded. */
const drawnZoom = (zoom) => Math.round(zoom + 1);

/** The fractional tile extent of [west, south, east, north] at zoom z. */
function extent([west, south, east, north], z) {
  return { x0: tileX(west, z), x1: tileX(east, z), y0: tileY(north, z), y1: tileY(south, z) };
}

/* The pixel rectangle of tile x, y inside the view's extent, as [c0, c1, r0, r1]. */
function cropOf(size, x, y, view) {
  const px = (at, origin) => clamp(Math.round((at - origin) * size), 0, size);
  return [px(view.x0, x), px(view.x1, x), px(view.y0, y), px(view.y1, y)];
}

/* The code 1-255 under which `value` falls on an encoding's axis, clamped to its ends. */
const codeOf = (encoding, value) => clamp(Math.round((value + encoding.baseShift) / step(encoding)), 1, 255);

/*
 * Count each code 1-255 in one decoded tile, within the view's extent. Code 0
 * in all channels is nodata, and a lossy tile marks nodata with alpha 0.
 */
function countTile(counts, tile, x, y, view, encoding) {
  const { size, data } = tile;
  const [c0, c1, r0, r1] = cropOf(size, x, y, view);
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

/*
 * The tiles of archive `url` covering the view, at the zoom MapLibre draws or
 * coarser past `maxTiles`, with the view's fractional extent at that zoom.
 */
async function tilesInView(url, minZoom, maxZoom, bounds, zoom, signal, maxTiles) {
  const header = await unlessAborted(archive(url).getHeader(), signal);
  const area = [
    Math.max(bounds[0], header.minLon),
    Math.max(bounds[1], header.minLat),
    Math.min(bounds[2], header.maxLon),
    Math.min(bounds[3], header.maxLat),
  ];
  if (area[0] >= area[2] || area[1] >= area[3]) return { z: minZoom, view: null, tiles: [] };

  let z = clamp(drawnZoom(zoom), minZoom, maxZoom);
  let view = extent(area, z);
  const count = (v) => (Math.floor(v.x1) - Math.floor(v.x0) + 1) * (Math.floor(v.y1) - Math.floor(v.y0) + 1);
  while (z > minZoom && count(view) > maxTiles) view = extent(area, --z);

  const tiles = [];
  const last = 2 ** z - 1;
  for (let y = Math.floor(view.y0); y <= Math.min(last, Math.floor(view.y1)); y++) {
    for (let x = Math.floor(view.x0); x <= Math.min(last, Math.floor(view.x1)); x++) tiles.push({ x, y });
  }
  return { z, view, tiles };
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
  const { z, view, tiles } = await tilesInView(
    layer.url, layer.minZoom, layer.maxZoom, bounds, zoom, signal, maxTiles,
  );
  const counts = new Float64Array(256);
  const reads = tiles.map(({ x, y }) => tilePixels(layer.url, z, x, y, signal).then((tile) => tile && { tile, x, y }));
  for (const read of await unlessAborted(Promise.all(reads), signal)) {
    if (read) countTile(counts, read.tile, read.x, read.y, view, layer.encoding);
  }
  return counts;
}

/**
 * Count a false-color composite's channels in view, where both archives have
 * data as it is drawn. Each channel is counted over its encoding's axis: an
 * archive's codes, or the ratio's 255 steps, with values beyond its ends at
 * the ends.
 *
 * @param {object} record  a composite from js/composite.js
 * @returns {Promise<Float64Array[]>}  256 counts per channel
 */
export async function compositeCounts(record, bounds, zoom, signal, maxTiles = MAX_TILES) {
  const { vv, vh } = record.composite;
  const { z, view, tiles } = await tilesInView(
    vv.url, record.minZoom, record.maxZoom, bounds, zoom, signal, maxTiles,
  );
  const counts = record.channels.map(() => new Float64Array(256));
  const encodings = record.channels.map((channel) => channel.encoding);
  const reads = tiles.map(({ x, y }) =>
    Promise.all([tilePixels(vv.url, z, x, y, signal), tilePixels(vh.url, z, x, y, signal)]).then(
      ([a, b]) => a && b && a.size === b.size && { a, b, x, y },
    ),
  );
  const values = new Float64Array(3);
  for (const read of await unlessAborted(Promise.all(reads), signal)) {
    if (!read) continue;
    const { size } = read.a;
    const [c0, c1, r0, r1] = cropOf(size, read.x, read.y, view);
    for (let row = r0; row < r1; row++) {
      for (let col = c0; col < c1; col++) {
        if (!channelValues(record, read.a.data, read.b.data, (row * size + col) * 4, values)) continue;
        for (let at = 0; at < 3; at++) counts[at][codeOf(encodings[at], values[at])] += 1;
      }
    }
  }
  return counts;
}

/*
 * Codes per bar. Lossy WebP keeps about 220 of the 256 levels, so single codes
 * leave a gap about every seventh; a bar's height is the mean of the codes in
 * it that were counted, which a gap does not lower.
 */
const BAR = 3;

/**
 * An SVG path of one bar per BAR codes over a viewBox of 255 by `height`.
 * Heights follow the square root of the count: a log scale made thin tails
 * look as full as the peak. Empty when nothing was counted.
 */
export function histogramPath(counts, height) {
  const bars = [];
  for (let first = 1; first <= 255; first += BAR) {
    let sum = 0;
    let counted = 0;
    for (let code = first; code < first + BAR && code <= 255; code++) {
      sum += counts[code];
      if (counts[code] > 0) counted += 1;
    }
    bars.push(counted ? Math.sqrt(sum / counted) : 0);
  }
  const top = Math.max(...bars);
  if (top === 0) return "";
  let path = "";
  bars.forEach((bar, at) => {
    if (bar > 0) path += `M${at * BAR} ${height}h${BAR}V${(height - (bar / top) * height).toFixed(2)}h-${BAR}Z`;
  });
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

/**
 * The RGBA of the pixel under [lng, lat] in the archive's tile MapLibre draws
 * at `zoom`. Null where nothing is drawn: below the archive's zooms, or where
 * it has no tile.
 */
export async function pixelAt(url, minZoom, maxZoom, [lng, lat], zoom) {
  const wanted = drawnZoom(zoom);
  if (wanted < minZoom) return null;
  const z = Math.min(wanted, maxZoom);
  const fx = tileX(lng - 360 * Math.floor((lng + 180) / 360), z);
  const fy = tileY(lat, z);
  const x = Math.min(Math.floor(fx), 2 ** z - 1);
  const y = Math.min(Math.floor(fy), 2 ** z - 1);
  const tile = await tilePixels(url, z, x, y);
  if (!tile) return null;
  const pixel = (fraction) => Math.min(tile.size - 1, Math.floor(fraction * tile.size));
  const at = (pixel(fy - y) * tile.size + pixel(fx - x)) * 4;
  return tile.data.slice(at, at + 4);
}
