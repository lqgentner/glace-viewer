/*
 * Read one raster record per PMTiles archive. The year items enumerate archives
 * and supply acquisition dates; styles supply rendering metadata. Join on the
 * layer ID; see AGENTS.md for the catalog contract.
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
    if (parsed) found.push({ ...parsed, url: resolve(asset.href, itemUrl) });
  }
  return found;
}

/*
 * Index style assets by year and by the default role, when present.
 *
 * @param {object} collection  the mosaics collection
 * @returns {Map<number|string, string>}
 */
export function styleHrefs(collection) {
  const out = new Map();
  for (const [key, asset] of Object.entries(collection?.assets ?? {})) {
    if (!Array.isArray(asset?.roles) || !asset.roles.includes("style")) continue;
    if (!isNonEmptyString(asset.href)) continue;
    const year = /(\d{4})(?:\.json)?$/.exec(asset.href) ?? /(\d{4})$/.exec(key);
    if (year) out.set(Number(year[1]), asset.href);
    if (asset.roles.includes("default")) out.set("default", asset.href);
  }
  if (out.size === 0) throw new Error("the mosaics collection names no style asset");
  return out;
}

/*
 * Index portolan:legend metadata by layer ID and stem. Zoom limits come from the
 * style source.
 */
function legends(style) {
  const sources = style?.sources ?? {};
  const byId = new Map();
  const byStem = new Map();
  for (const layer of Array.isArray(style?.layers) ? style.layers : []) {
    const legend = layer?.metadata?.["portolan:legend"];
    // Ignore unrelated style layers.
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
      encoding: valueEncoding(source),
    };
    byId.set(layer.id, entry);
    if (!byStem.has(parsed.stem)) byStem.set(parsed.stem, entry);
  }
  return { byId, byStem };
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

/* RGB shares the polarization field but uses channel recipes instead of a ramp. */
export const FALSE_COLOUR = "RGB";

/*
 * Validate catalog input before handing it to MapLibre. One incomplete layer must
 * not discard the others.
 */
function drawable(layer) {
  if (!isFiniteNumber(layer.minZoom) || !isFiniteNumber(layer.maxZoom)) return false;
  if (layer.minZoom > layer.maxZoom) return false;

  /*
   * RGB channel metadata is descriptive: invalid channels omit legend numbers but
   * do not prevent rendering.
   */
  if (layer.polarization === FALSE_COLOUR) return true;

  return (
    isFiniteNumber(layer.vmin) &&
    isFiniteNumber(layer.vmax) &&

    layer.vmin < layer.vmax &&

    Array.isArray(layer.colors) &&
    layer.colors.length > 0 &&
    layer.colors.every(isNonEmptyString)
  );
}

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
 * @param {{item: object, url: string}[]} items  the year items, with the URLs
 *   they were read from for relative hrefs
 * @param {object|Map<number|string, object>} style  the MapLibre style the
 *   collection nominates, or one per year keyed as styleHrefs() keys them
 * @returns {object[]}
 */
export function storeLayers(items, style) {
  /* A single style document acts as the default for every year. */
  const styles = style instanceof Map ? style : new Map([["default", style]]);
  const drawn = new Map([...styles].map(([key, document]) => [key, legends(document)]));
  const fallback = drawn.get("default");
  const layers = [];
  const found = (Array.isArray(items) ? items : []).flatMap(({ item, url }) =>
    archives(item, url).map((archive) => ({ ...archive, ...acquisitionWindow(item) })),
  );
  for (const archive of found) {
    const own = drawn.get(archive.year);
    /* Fixed per-layer stretches allow fallback by stem across years. */
    const legend =
      own?.byId.get(archive.id) ??
      fallback?.byId.get(archive.id) ??
      own?.byStem.get(archive.stem) ??
      fallback?.byStem.get(archive.stem);
    if (legend === undefined) {
      console.warn("store: no style entry describes", archive.id);
      continue;
    }
    const layer = { ...legend, ...archive };
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
 * Fetch raster inventory, styles, and optional acquisition dates.
 *
 * @returns {Promise<object[]>}  one record per archive
 */
export async function readStore() {
  const collectionUrl = new URL(MOSAIC_COLLECTION_URL, location.href).href;
  const collection = await readJson(collectionUrl);

  /*
   * Fetch styles and items concurrently. Style failures are fatal; an item failure
   * omits that year. Deduplicate style hrefs because a year and default can name
   * the same file.
   */
  const hrefs = styleHrefs(collection);
  const unique = [...new Set(hrefs.values())];
  const requests = unique.map((href) => readJson(resolve(href, collectionUrl)));

  const items = (collection?.links ?? [])
    .filter((link) => link?.rel === "item" && isNonEmptyString(link.href))
    .map((link) => resolve(link.href, collectionUrl))
    .map((url) =>
      readJson(url).then(
        (item) => ({ item, url }),
        (error) => {
          console.warn("store: skipping an unreadable item", error.message);
          return null;
        },
      ),
    );
  const answered = await Promise.all([...requests, ...items]);
  const documents = new Map(unique.map((href, index) => [href, answered[index]]));
  const drawnAs = new Map([...hrefs].map(([key, href]) => [key, documents.get(href)]));

  return storeLayers(answered.slice(unique.length).filter(Boolean), drawnAs);
}
