/*
 * Where the raster layers come from: the published catalog, read directly.
 *
 * There used to be a `layers.json` beside the archives — one entry per (product,
 * polarization, year), carrying the URL, the zooms, the stretch and the ramp.
 * The store retired it: every field it held now has a standard home, and a
 * sidecar that restates them is a copy to fall out of step with. So this module
 * reads those homes instead, and hands js/rasters.js the same shape the manifest
 * used to arrive as.
 *
 * Three reads, and each answers exactly one question:
 *
 *   mosaics/collection.json   which archives exist — one `rel: "pmtiles"` link
 *                             each — and where the style and the per-year items
 *                             are
 *   the style it points at    how each layer is drawn: the ramp, the stretch,
 *                             the unit, the zooms. It is the same file the build
 *                             reads to bake the archives, so it cannot disagree
 *                             with them
 *   each year's item.json     the acquisition window under the ramp
 *
 * **Why the archives are enumerated from the collection and not from the style,**
 * which lists sources of its own: the style is documented as carrying "every
 * published web-map layer of the most recent year". The collection lists every
 * archive of every year. Reading the inventory from the style would therefore
 * lose every year but the newest the moment a second one is published.
 *
 * The two are joined on `pmtiles:layers`, the style layer id each link names —
 * `glace-coh12_vv-2024`, which carries the archive's stem and its year. Where
 * the style has no entry for that year, the layer falls back to the entry for
 * the same stem in whatever year the style does describe: the stretch and the
 * ramp are fixed per layer rather than per year, deliberately and by the store's
 * own documentation, so that a real change between two years is visible as a
 * change rather than absorbed into a rescaled colour bar.
 *
 * Bounds are the one thing nothing here declares. The PMTiles header already
 * carries them, and `pmtiles.Protocol` puts them in the TileJSON it answers
 * with, so a source that names no bounds of its own inherits the archive's —
 * for free, in a read the source was making anyway.
 */

import { MOSAIC_COLLECTION_URL } from "./config.js";

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isNonEmptyString = (value) => typeof value === "string" && value !== "";

async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} — HTTP ${response.status}`);
  return response.json();
}

/* Hrefs in a STAC document are relative to the document that carries them.
 * Resolved against the collection's own URL rather than against `tilesBase`, so
 * a store that lays its files out differently is still followed correctly. */
const resolve = (href, base) => new URL(href, base).href;

/* The style layer id an archive link names, split into what the page needs from
 * it: `glace-coh12_vv_qa_num-2024` is the QA-NUM archive of COH12 VV for 2024.
 *
 * The stem is then split once more, on its first underscore, into the product
 * and everything after it — which is the composite polarization field the panel
 * spends on two rows (see js/rasters.js). Both halves are upper-cased, since the
 * archives are named in lower case and the panel names them as the catalog's own
 * prose does. */
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

/* Every archive the collection publishes, as {id, url}. `pmtiles:layers` is the
 * join key and the identity both; a link without one names nothing this page can
 * describe, and there is no second way to guess at it. */
function archives(collection, collectionUrl) {
  const links = Array.isArray(collection?.links) ? collection.links : [];
  const found = [];
  for (const link of links) {
    if (link?.rel !== "pmtiles" || !isNonEmptyString(link.href)) continue;
    const ids = Array.isArray(link["pmtiles:layers"]) ? link["pmtiles:layers"] : [];
    for (const id of ids) {
      const parsed = parseLayerId(id);
      if (parsed !== null) found.push({ ...parsed, url: resolve(link.href, collectionUrl) });
    }
  }
  return found;
}

/* The style the collection nominates: the asset with the `style` role. Its
 * `default` companion is what a catalog with several styles marks as the one to
 * open with, so it is preferred where both exist. */
function styleHref(collection) {
  const assets = Object.values(collection?.assets ?? {}).filter(
    (asset) =>
      Array.isArray(asset?.roles) && asset.roles.includes("style") && isNonEmptyString(asset.href),
  );
  const chosen = assets.find((asset) => asset.roles.includes("default")) ?? assets[0];
  if (chosen === undefined) throw new Error("the mosaics collection names no style asset");
  return chosen.href;
}

/* How one layer is drawn, keyed by style layer id and, as a fallback, by stem.
 *
 * `metadata.portolan:legend` is the store's source of truth for the ramp and the
 * range baked into the archive — the build reads the same block — so everything
 * descriptive is taken from it verbatim and nothing is kept here. The source
 * beside it carries the zooms. */
function legends(style) {
  const sources = style?.sources ?? {};
  const byId = new Map();
  const byStem = new Map();
  for (const layer of Array.isArray(style?.layers) ? style.layers : []) {
    const legend = layer?.metadata?.["portolan:legend"];
    // A style may carry layers that are not GLACE rasters at all. Only the ones
    // that describe themselves as one are of any interest here.
    if (legend === null || typeof legend !== "object") continue;
    const parsed = parseLayerId(layer.id);
    if (parsed === null) continue;
    const source = sources[layer.source] ?? {};
    const entry = {
      cmap: legend.cmap,
      vmin: legend.vmin,
      vmax: legend.vmax,
      units: typeof legend.unit === "string" ? legend.unit : "",
      colors: (Array.isArray(legend.stops) ? legend.stops : [])
        .map((stop) => stop?.color)
        .filter(isNonEmptyString),
      channels: legend.channels ?? null,
      minZoom: source.minzoom,
      maxZoom: source.maxzoom,
    };
    byId.set(layer.id, entry);
    if (!byStem.has(parsed.stem)) byStem.set(parsed.stem, entry);
  }
  return { byId, byStem };
}

/* The polarization value the false colour is published under. It is not a
 * polarization at all — it is a channel recipe sharing the field — and it is the
 * one layer with no ramp, so both this module and the panel have to know it. */
export const FALSE_COLOUR = "RGB";

/* A layer the page can actually draw. The catalog is fetched from wherever
 * `?tiles=` points, which is a genuine trust boundary, so what is read out of it
 * is checked rather than trusted: an entry that is structurally valid but
 * incomplete would otherwise fail much later as an undefined read inside
 * MapLibre. One unusable layer is dropped with a warning rather than taking the
 * page down with it. */
function drawable(layer) {
  // A raster source with no zooms cannot draw whatever else it carries.
  if (!isFiniteNumber(layer.minZoom) || !isFiniteNumber(layer.maxZoom)) return false;
  if (layer.minZoom > layer.maxZoom) return false;

  /* The false colour has three channels and neither a ramp nor one stretch —
   * each channel carries its own. Those are checked where the legend is drawn
   * and cost the layer only its numbers, since the archive is pre-styled and
   * draws with or without them. */
  if (layer.polarization === FALSE_COLOUR) return true;

  return (
    isFiniteNumber(layer.vmin) &&
    isFiniteNumber(layer.vmax) &&
    // A stretch whose ends are equal or backwards renders the ramp meaninglessly.
    layer.vmin < layer.vmax &&
    // A ramp is how a single-band layer is drawn, so one is required of it.
    Array.isArray(layer.colors) &&
    layer.colors.length > 0 &&
    layer.colors.every(isNonEmptyString)
  );
}

/* An acquisition window, as `YYYY-MM-DD` pair, or nothing. Descriptive rather
 * than structural — the layer draws identically without it — so a year whose
 * item is unreadable simply loses the line under its ramp. */
const ISO_DATETIME = /^(\d{4}-\d{2}-\d{2})T/;

function acquisitionWindow(item) {
  const start = ISO_DATETIME.exec(item?.properties?.start_datetime ?? "");
  const end = ISO_DATETIME.exec(item?.properties?.end_datetime ?? "");
  return start && end ? { startDate: start[1], endDate: end[1] } : {};
}

/**
 * The layers of the store, from its three documents.
 *
 * Pure, so the join can be exercised without a network: the reads are in
 * readStore() below.
 *
 * @param {object} collection  the mosaics collection
 * @param {string} collectionUrl  where it was read from, for relative hrefs
 * @param {object} style  the MapLibre style it nominates
 * @param {Map<number, object>} windows  year -> {startDate, endDate}
 * @returns {object[]}
 */
export function storeLayers(collection, collectionUrl, style, windows = new Map()) {
  const { byId, byStem } = legends(style);
  const layers = [];
  for (const archive of archives(collection, collectionUrl)) {
    const legend = byId.get(archive.id) ?? byStem.get(archive.stem);
    if (legend === undefined) {
      console.warn("store: no style entry describes", archive.id);
      continue;
    }
    const layer = { ...archive, ...legend, ...(windows.get(archive.year) ?? {}) };
    if (!drawable(layer)) {
      console.warn("store: skipping a layer the style describes incompletely", archive.id);
      continue;
    }
    layers.push(layer);
  }
  if (!layers.length) throw new Error("the catalog publishes no drawable layers");
  return layers;
}

/**
 * Read the published store: its archives, how each is drawn, and when each year
 * was acquired.
 *
 * @returns {Promise<object[]>}  one record per archive
 */
export async function readStore() {
  /* Absolute from here down, so that every href in the catalog resolves against
   * the document that carried it rather than against the page. */
  const collectionUrl = new URL(MOSAIC_COLLECTION_URL, location.href).href;
  const collection = await readJson(collectionUrl);

  /* The style and every year's item are independent of each other, so they go
   * out together rather than one after the next. A year whose item does not
   * answer costs that year its date line and nothing else, which is why these
   * are settled rather than awaited. */
  const style = readJson(resolve(styleHref(collection), collectionUrl));

  const items = (collection?.links ?? [])
    .filter((link) => link?.rel === "item" && isNonEmptyString(link.href))
    .map((link) => readJson(resolve(link.href, collectionUrl)).catch(() => null));
  const [drawnAs, ...settled] = await Promise.all([style, ...items]);

  const windows = new Map();
  for (const item of settled) {
    // The item names its own year, the way the archives do: `ch-mosaic-2024`.
    const year = /(\d{4})$/.exec(item?.id ?? "");
    const dates = acquisitionWindow(item);
    if (year && dates.startDate) windows.set(Number(year[1]), dates);
  }

  return storeLayers(collection, collectionUrl, drawnAs, windows);
}
