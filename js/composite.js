/*
 * False color composed on demand from the VV and VH archives of one product and
 * year: red VV, green VH, blue their ratio (VV − VH in dB, VV / VH otherwise).
 * Red and green default to the single-band stretches; blue's range is the
 * viewer's own. The scale editor sets all three. Served to a raster source
 * through the glace-rgb:// protocol registered in js/map.js.
 */

import { unlessAborted } from "./archive.js";
import { decodePixel, tilePixels } from "./values.js";

/* RGB shares the polarization field but has channels instead of a ramp. */
export const FALSE_COLOUR = "RGB";

/* Blue-channel ranges by product, and the span of the editor's axis for it. */
const RATIO_RANGE = { COH12: [0.8, 2.6], RTC: [3.5, 10.5] };
const RATIO_AXIS = { COH12: [0.5, 3], RTC: [0, 15] };

/*
 * An encoding that splits [low, high] into 255 codes, so the editor's axis and
 * histogram treat the ratio as they treat an archive's values.
 */
function axisEncoding([low, high]) {
  const width = (high - low) / 255;
  return { encoding: "custom", redFactor: width, greenFactor: 0, blueFactor: 0, baseShift: width / 2 - low };
}

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
        { band: "VV", vmin: vv.vmin, vmax: vv.vmax, units: vv.units, encoding: vv.encoding },
        { band: "VH", vmin: vh.vmin, vmax: vh.vmax, units: vh.units, encoding: vh.encoding },
        {
          band: decibel ? "VV − VH" : "VV / VH",
          vmin: low,
          vmax: high,
          units: decibel ? vv.units : "",
          encoding: axisEncoding(RATIO_AXIS[vv.product]),
          bounds: RATIO_AXIS[vv.product],
        },
      ],
      /* The limits drawn, one { vmin, vmax } per channel, and their redraws; see restretch(). */
      stretch: null,
      reload: null,
      cooling: false,
      drawing: 0,
      waited: 0,
      composite: { vv, vh, decibel },
    };
    composites.set(record.id, record);
    out.push(record);
  }
  return out;
}

/*
 * Write the three channel values of pixel `at` in two decoded RGBA tiles into
 * `out`. False unless both archives have data there; a lossy tile marks nodata
 * with alpha 0. Callers reuse `out` across a tile's pixels.
 */
export function channelValues(record, a, b, at, out) {
  if (a[at + 3] === 0 || b[at + 3] === 0) return false;
  const { vv, vh, decibel } = record.composite;
  const co = decodePixel(vv.encoding, a[at], a[at + 1], a[at + 2]);
  const cross = decodePixel(vh.encoding, b[at], b[at + 1], b[at + 2]);
  if (co === null || cross === null) return false;
  const ratio = decibel ? co - cross : co / cross;
  if (!Number.isFinite(ratio)) return false;
  out[0] = co;
  out[1] = cross;
  out[2] = ratio;
  return true;
}

const scale = (value, { vmin, vmax }) =>
  Math.max(0, Math.min(255, Math.round((255 * (value - vmin)) / (vmax - vmin))));

/** Compose two decoded RGBA code tiles of equal size, each channel stretched. */
export function compositePixels(vvTile, vhTile, record) {
  const limits = record.stretch ?? record.channels;
  const a = vvTile.data;
  const b = vhTile.data;
  const out = new Uint8ClampedArray(a.length);
  const values = new Float64Array(3);
  for (let at = 0; at < a.length; at += 4) {
    if (!channelValues(record, a, b, at, values)) continue;
    for (let channel = 0; channel < 3; channel++) out[at + channel] = scale(values[channel], limits[channel]);
    out[at + 3] = 255;
  }
  return out;
}

/*
 * A reload makes MapLibre request every tile again without canceling the
 * requests it has out, so new limits wait for the tiles being drawn and for a
 * short gap after the last reload. The latest limits are the ones drawn. A
 * tile that never settles holds them back for at most STALL gaps.
 */
const REDRAW_GAP = 100;
const STALL = 10;

/**
 * Draw a composite with new channel limits.
 *
 * @param {object} record  a composite from compositeLayers()
 * @param {{vmin: number, vmax: number}[]} stretch  one per channel
 * @param {Function} [reload]  makes the map request the tiles again; omitted
 *   before the source is added
 */
export function restretch(record, stretch, reload) {
  record.stretch = stretch;
  record.reload = reload ?? null;
  redraw(record);
}

function redraw(record) {
  if (!record.reload || record.cooling) return;
  if (record.drawing > 0 && record.waited < STALL) {
    cool(record);
    return;
  }
  const reload = record.reload;
  record.reload = null;
  record.waited = 0;
  cool(record);
  reload();
}

/* A gap, after which a waiting redraw is tried again. */
function cool(record) {
  record.cooling = true;
  setTimeout(() => {
    record.cooling = false;
    if (record.reload && record.drawing > 0) record.waited += 1;
    redraw(record);
  }, REDRAW_GAP);
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
  record.drawing += 1;
  try {
    const [a, b] = await unlessAborted(
      Promise.all([tilePixels(vv.url, z, x, y), tilePixels(vh.url, z, x, y)]),
      signal,
    );
    if (a === null || b === null || a.size !== b.size) return { data: new ArrayBuffer(0) };
    const pixels = new ImageData(compositePixels(a, b, record), a.size, a.size);
    return { data: await createImageBitmap(pixels) };
  } finally {
    record.drawing -= 1;
    redraw(record);
  }
}
