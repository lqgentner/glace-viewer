/*
 * Read one raster record per PMTiles archive. The year items enumerate archives
 * and supply dates, units and their year's style, which supplies decoding; the
 * collection's style is the fallback, and its renders supply default stretches.
 * Join on the layer ID; see AGENTS.md.
 */

import { MOSAIC_COLLECTION_URL } from "./config.js";

export const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
export const isNonEmptyString = (value) => typeof value === "string" && value !== "";

async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} — HTTP ${response.status}`);
  return response.json();
}

/* Resolve STAC hrefs against the containing document. */
const resolve = (href, base) => new URL(href, base).href;

/*
 * Example: glace-coh12_vv_qa_num-2024 -> product COH12, polarization VV_QA_NUM,
 * year 2024. The panel splits the QA suffix later.
 */
const LAYER_ID = /^glace-([a-z0-9]+)_([a-z0-9_]+)-(\d{4})$/;

function parseLayerId(id) {
  const at = LAYER_ID.exec(id);
  if (at === null) return null;
  return {
    id,
    stem: `${at[1]}_${at[2]}`,
    product: at[1].toUpperCase(),
    polarization: at[2].toUpperCase(),
    year: Number(at[3]),
  };
}

/*
 * Enumerate an item's archives: its visual PMTiles assets. The asset key
 * coh12_vv_viz in item alps-mosaic-2023 is layer glace-coh12_vv-2023.
 */
function archives(item, itemUrl) {
  const year = /(\d{4})$/.exec(item?.id ?? "");
  if (year === null) return [];
  const found = [];
  for (const [key, asset] of Object.entries(item?.assets ?? {})) {
    if (!Array.isArray(asset?.roles) || !asset.roles.includes("visual")) continue;
    if (asset.type !== "application/vnd.pmtiles" || !isNonEmptyString(asset.href)) continue;
    const stem = /^(.+)_viz$/.exec(key);
    const parsed = stem && parseLayerId(`glace-${stem[1]}-${year[1]}`);
    const band = Array.isArray(asset.bands) ? asset.bands[0] : null;
    if (parsed) {
      found.push({
        ...parsed,
        url: resolve(asset.href, itemUrl),
        units: isNonEmptyString(band?.unit) ? band.unit : "",
      });
    }
  }
  return found;
}

/**
 * The href of a STAC document's style asset, preferring one with the default
 * role. An item's describes its year; the collection's is the fallback.
 *
 * @param {object} document  a mosaic item or the mosaics collection
 * @returns {string|null}
 */
export function styleHref(document) {
  let found = null;
  for (const asset of Object.values(document?.assets ?? {})) {
    if (!Array.isArray(asset?.roles) || !asset.roles.includes("style")) continue;
    if (!isNonEmptyString(asset.href)) continue;
    if (asset.roles.includes("default")) return asset.href;
    found ??= asset.href;
  }
  return found;
}

/*
 * Index the style's color-relief layers by layer ID and stem. Each draws a
 * raster-dem source whose custom encoding decodes the archive; the source also
 * supplies zoom limits and the credit line. The style's ramp is not read: the
 * viewer chooses color maps, and stretches come from the collection's renders.
 */
function sources(style) {
  const declared = style?.sources ?? {};
  const byId = new Map();
  const byStem = new Map();
  for (const layer of Array.isArray(style?.layers) ? style.layers : []) {
    if (layer?.type !== "color-relief") continue;
    const parsed = parseLayerId(layer.id);
    if (parsed === null) continue;
    const source = declared[layer.source] ?? {};
    const entry = {
      minZoom: source.minzoom,
      maxZoom: source.maxzoom,
      encoding: valueEncoding(source),
      attribution: isNonEmptyString(source.attribution) ? source.attribution : undefined,
    };
    byId.set(layer.id, entry);
    if (!byStem.has(parsed.stem)) byStem.set(parsed.stem, entry);
  }
  return { byId, byStem };
}

/**
 * Default stretches by stem from the collection's STAC renders, whose keys are
 * the layer stems.
 *
 * @param {object} collection  the mosaics collection
 * @returns {Map<string, {vmin: number, vmax: number}>}
 */
export function stretches(collection) {
  const out = new Map();
  for (const [stem, render] of Object.entries(collection?.renders ?? {})) {
    const range = Array.isArray(render?.rescale) ? render.rescale[0] : null;
    if (!Array.isArray(range) || range.length !== 2) continue;
    const [vmin, vmax] = range;
    if (isFiniteNumber(vmin) && isFiniteNumber(vmax) && vmin < vmax) out.set(stem, { vmin, vmax });
  }
  return out;
}

/*
 * A value-encoded archive is a raster-dem source with MapLibre's custom
 * encoding: value = R * redFactor + G * greenFactor + B * blueFactor - baseShift.
 * The style declares the four numbers; nothing else about the archive is assumed.
 */
const ENCODING_FACTORS = ["redFactor", "greenFactor", "blueFactor", "baseShift"];

export function valueEncoding(source) {
  if (source?.type !== "raster-dem" || source.encoding !== "custom") return null;
  if (!ENCODING_FACTORS.every((name) => isFiniteNumber(source[name]))) return null;
  return Object.fromEntries([
    ["encoding", "custom"],
    ...ENCODING_FACTORS.map((name) => [name, source[name]]),
  ]);
}

/*
 * Validate catalog input before handing it to MapLibre. One incomplete layer must
 * not discard the others.
 */
const drawable = (layer) =>
  isFiniteNumber(layer.minZoom) &&
  isFiniteNumber(layer.maxZoom) &&
  layer.minZoom <= layer.maxZoom &&
  layer.encoding !== null &&
  isFiniteNumber(layer.vmin) &&
  isFiniteNumber(layer.vmax) &&
  layer.vmin < layer.vmax;

/* Optional acquisition dates, formatted as YYYY-MM-DD. */
const ISO_DATETIME = /^(\d{4}-\d{2}-\d{2})T/;

function acquisitionWindow(item) {
  const start = ISO_DATETIME.exec(item?.properties?.start_datetime ?? "");
  const end = ISO_DATETIME.exec(item?.properties?.end_datetime ?? "");
  return start && end ? { startDate: start[1], endDate: end[1] } : {};
}

/**
 * Join catalog documents without network access.
 *
 * @param {{item: object, url: string, style?: object}[]} items  the year items,
 *   with the URLs they were read from for relative hrefs and their own styles
 * @param {object} style  the MapLibre style the collection nominates, for items
 *   without one
 * @param {object} collection  the mosaics collection, for its renders
 * @returns {object[]}
 */
export function storeLayers(items, style, collection) {
  const fallback = sources(style);
  const ranges = stretches(collection);
  const layers = [];
  const found = (Array.isArray(items) ? items : []).flatMap(({ item, url, style: own }) => {
    const drawn = sources(own);
    return archives(item, url).map((archive) => ({ ...archive, ...acquisitionWindow(item), drawn }));
  });
  for (const { drawn: own, ...archive } of found) {
    /* Encodings are fixed per layer, so fallback by stem across years is safe. */
    const source =
      own.byId.get(archive.id) ??
      fallback.byId.get(archive.id) ??
      own.byStem.get(archive.stem) ??
      fallback.byStem.get(archive.stem);
    if (source === undefined) {
      console.warn("store: no style entry describes", archive.id);
      continue;
    }
    const layer = { ...source, ...ranges.get(archive.stem), ...archive };
    if (!drawable(layer)) {
      console.warn("store: skipping a layer the catalog describes incompletely", archive.id);
      continue;
    }
    layers.push(layer);
  }
  if (!layers.length) throw new Error("the catalog publishes no drawable layers");
  return layers;
}

/** The collection's [west, south, east, north], or null without a valid one. */
export function catalogBounds(collection) {
  const bbox = collection?.extent?.spatial?.bbox?.[0];
  const valid =
    Array.isArray(bbox) &&
    bbox.length === 4 &&
    bbox.every(isFiniteNumber) &&
    bbox[0] < bbox[2] &&
    bbox[1] < bbox[3];
  return valid ? bbox : null;
}

/*
 * Read a year's item and the style it lists. Either failing omits the year;
 * an item without a style is drawn from the collection's.
 */
async function readYear(url) {
  try {
    const item = await readJson(url);
    const href = styleHref(item);
    const style = href === null ? undefined : await readJson(resolve(href, url));
    return { item, url, style };
  } catch (error) {
    console.warn("store: skipping a year that cannot be read", error.message);
    return null;
  }
}

/**
 * Fetch raster inventory, styles, and optional acquisition dates.
 *
 * @returns {Promise<{layers: object[], bounds: number[]|null}>}  one record per
 *   archive, and the catalog's extent
 */
export async function readStore() {
  const collectionUrl = new URL(MOSAIC_COLLECTION_URL, location.href).href;
  const collection = await readJson(collectionUrl);

  /* The collection's style failing is fatal; it is read beside the years. */
  const href = styleHref(collection);
  if (href === null) throw new Error("the mosaics collection names no style asset");
  const years = (collection?.links ?? [])
    .filter((link) => link?.rel === "item" && isNonEmptyString(link.href))
    .map((link) => readYear(resolve(link.href, collectionUrl)));
  const [style, ...items] = await Promise.all([readJson(resolve(href, collectionUrl)), ...years]);

  return {
    layers: storeLayers(items.filter(Boolean), style, collection),
    bounds: catalogBounds(collection),
  };
}
