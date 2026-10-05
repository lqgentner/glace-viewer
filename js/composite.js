/*
 * False color composed on demand from the VV and VH archives of one product and
 * year: red VV, green VH, blue their ratio (VV − VH in dB, VV / VH otherwise).
 * Red and green use the single-band default stretches; blue's range is the
 * viewer's own. Served to a raster source through the glace-rgb:// protocol
 * registered in js/map.js.
 */

import { unlessAborted } from "./archive.js";
import { decodePixel, tilePixels } from "./values.js";

/* RGB shares the polarization field but has channels instead of a ramp. */
export const FALSE_COLOUR = "RGB";

/* Blue-channel ranges by product. */
const RATIO_RANGE = { COH12: [0.8, 2.6], RTC: [3.5, 10.5] };

const composites = new Map();

export const compositeTiles = (id) => `glace-rgb://${id}/{z}/{x}/{y}`;

/**
 * One false-color record per product and year with a VV and a VH data layer.
 *
 * @param {object[]} layers  records from js/store.js
 * @returns {object[]}
 */
export function compositeLayers(layers) {
  const out = [];
  for (const vv of layers) {
    if (vv.polarization !== "VV" || !(vv.product in RATIO_RANGE)) continue;
    const vh = layers.find(
      (layer) => layer.product === vv.product && layer.year === vv.year && layer.polarization === "VH",
    );
    if (vh === undefined) continue;
    const decibel = vv.units === "dB";
    const [low, high] = RATIO_RANGE[vv.product];
    const stem = `${vv.product.toLowerCase()}_rgb`;
    const record = {
      id: `glace-${stem}-${vv.year}`,
      stem,
      product: vv.product,
      polarization: FALSE_COLOUR,
      year: vv.year,
      units: vv.units,
      minZoom: Math.max(vv.minZoom, vh.minZoom),
      maxZoom: Math.min(vv.maxZoom, vh.maxZoom),
      attribution: vv.attribution,
      startDate: vv.startDate,
      endDate: vv.endDate,
      channels: [
        { band: "VV", vmin: vv.vmin, vmax: vv.vmax },
        { band: "VH", vmin: vh.vmin, vmax: vh.vmax },
        { band: decibel ? "VV − VH" : "VV / VH", vmin: low, vmax: high },
      ],
      composite: { vv, vh, decibel },
    };
    composites.set(record.id, record);
    out.push(record);
  }
  return out;
}

const scale = (value, { vmin, vmax }) =>
  Math.max(0, Math.min(255, Math.round((255 * (value - vmin)) / (vmax - vmin))));

/**
 * Compose two decoded RGBA code tiles of equal size. A pixel is drawn only
 * where both archives have data; a lossy tile marks nodata with alpha 0.
 */
export function compositePixels(vvTile, vhTile, record) {
  const { vv, vh, decibel } = record.composite;
  const [red, green, blue] = record.channels;
  const a = vvTile.data;
  const b = vhTile.data;
  const out = new Uint8ClampedArray(a.length);
  for (let at = 0; at < a.length; at += 4) {
    if (a[at + 3] === 0 || b[at + 3] === 0) continue;
    const co = decodePixel(vv.encoding, a[at], a[at + 1], a[at + 2]);
    const cross = decodePixel(vh.encoding, b[at], b[at + 1], b[at + 2]);
    if (co === null || cross === null) continue;
    const ratio = decibel ? co - cross : co / cross;
    if (!Number.isFinite(ratio)) continue;
    out[at] = scale(co, red);
    out[at + 1] = scale(cross, green);
    out[at + 2] = scale(ratio, blue);
    out[at + 3] = 255;
  }
  return out;
}

const TILE_URL = /^glace-rgb:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/;

/**
 * The MapLibre protocol handler. Returns a bitmap MapLibre uploads as is, or an
 * empty buffer, which it draws transparent, where either archive has no tile.
 */
export async function compositeProtocol(params, abortController) {
  const signal = abortController?.signal;
  signal?.throwIfAborted();
  const at = TILE_URL.exec(params.url);
  if (at === null) throw new Error(`not a glace-rgb tile URL: ${params.url}`);
  const record = composites.get(at[1]);
  if (record === undefined) throw new Error(`no false-color composite named ${at[1]}`);
  const [z, x, y] = at.slice(2).map(Number);
  const { vv, vh } = record.composite;
  const [a, b] = await unlessAborted(
    Promise.all([tilePixels(vv.url, z, x, y), tilePixels(vh.url, z, x, y)]),
    signal,
  );
  if (a === null || b === null || a.size !== b.size) return { data: new ArrayBuffer(0) };
  const pixels = new ImageData(compositePixels(a, b, record), a.size, a.size);
  return { data: await createImageBitmap(pixels) };
}
