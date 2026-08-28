/*
 * The GLACE raster layers: the manifest, the controls that select one of them,
 * and the legend that describes it.
 *
 * `layers.json` (written by scripts/stac/build-pmtiles.py) holds one entry per
 * (product, polarization, year). Only the entry currently on screen has a
 * MapLibre source, and only the entries that have been on screen keep one, so
 * scrubbing through years stays instant without asking for archive metadata
 * nobody looked at.
 */

import { LAYER_MANIFEST_URL, TILES_BASE } from "./config.js";
import { dataInsertPoint, map, styleReady } from "./map.js";
import { buildSegmented, clearStatus, el, setStatus } from "./ui.js";

const STATUS_KEY = "rasters";

const state = {
  manifest: null,
  /* `product|polarization|year` -> layer. Built once; the controls ask "does
   * this combination exist" on every keystroke of the year slider. */
  index: new Map(),
  product: null,
  pol: null,
  year: null,
  opacity: 1,
  added: new Set(),
  activeId: null,
};

const layerId = (layer) => `glace-${layer.id}`;
const key = (product, pol, year) => `${product}|${pol}|${year}`;
const findLayer = (product, pol, year) => state.index.get(key(product, pol, year)) ?? null;

/* ---------- manifest ---------- */

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isNonEmptyString = (value) => typeof value === "string" && value !== "";

/* A manifest that parses as JSON is not yet a manifest this page can draw. It
 * is fetched from wherever ?tiles= points, which is a genuine trust boundary,
 * and a structurally valid but incomplete entry would otherwise fail much later
 * as an undefined read somewhere inside MapLibre. Malformed entries are dropped
 * with a warning rather than taking the whole page down: one broken year should
 * not cost the other twenty. */
function validLayer(layer) {
  return (
    layer !== null &&
    typeof layer === "object" &&
    isNonEmptyString(layer.id) &&
    isNonEmptyString(layer.product) &&
    isNonEmptyString(layer.polarization) &&
    isNonEmptyString(layer.url) &&
    isFiniteNumber(layer.year) &&
    isFiniteNumber(layer.min_zoom) &&
    isFiniteNumber(layer.max_zoom) &&
    isFiniteNumber(layer.vmin) &&
    isFiniteNumber(layer.vmax) &&
    // A source whose zooms are inverted cannot draw, and a stretch whose ends
    // are equal or backwards would render the ramp meaninglessly.
    layer.min_zoom <= layer.max_zoom &&
    layer.vmin < layer.vmax &&
    Array.isArray(layer.bounds) &&
    layer.bounds.length === 4 &&
    layer.bounds.every(isFiniteNumber) &&
    Array.isArray(layer.colors) &&
    layer.colors.length > 0 &&
    layer.colors.every(isNonEmptyString)
  );
}

export function validateManifest(raw) {
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw.layers)) {
    throw new Error("no layers array");
  }
  const layers = raw.layers.filter((layer) => {
    if (validLayer(layer)) return true;
    console.warn("layers.json: skipping malformed entry", layer);
    return false;
  });
  if (!layers.length) throw new Error("the manifest holds no usable layers");

  /* The manifest also names the products, polarizations and years, which is
   * what orders the controls. Those lists are honoured where they agree with
   * the layers and derived from the layers where they do not, so a manifest
   * that lists a product it has no archive for cannot produce a dead button. */
  const present = (field) => new Set(layers.map((layer) => layer[field]));
  const axis = (declared, field) => {
    const have = present(field);
    const kept = Array.isArray(declared) ? declared.filter((value) => have.has(value)) : [];
    return kept.length === have.size ? kept : [...have];
  };

  return {
    layers,
    products: axis(raw.products, "product"),
    polarizations: axis(raw.polarizations, "polarization"),
    years: axis(raw.years, "year").sort((a, b) => a - b),
  };
}

/* ---------- map layers ---------- */

function ensureLayer(layer) {
  if (state.added.has(layer.id)) return;
  map.addSource(layerId(layer), {
    type: "raster",
    url: `pmtiles://${TILES_BASE}/${layer.url}`,
    tileSize: 256,
    minzoom: layer.min_zoom,
    maxzoom: layer.max_zoom,
    bounds: layer.bounds,
    /* The wording the Copernicus terms ask for. It is per-year because each
     * year is its own source, and MapLibre only credits a source a visible
     * layer is using — so the line names the year on screen and disappears
     * when no GLACE layer is shown. `layer.year` is interpolated into markup,
     * which is safe only because validLayer() has already required it to be a
     * finite number. */
    attribution: `<a href="https://www.copernicus.eu/">Contains modified Copernicus Sentinel data ${layer.year}</a>`,
  });
  map.addLayer(
    {
      id: layerId(layer),
      type: "raster",
      source: layerId(layer),
      layout: { visibility: "none" },
      paint: { "raster-opacity": state.opacity, "raster-resampling": "nearest" },
    },
    dataInsertPoint(),
  );
  state.added.add(layer.id);
}

/* The panel updates immediately; the map catches up once the style is parsed.
 * Splitting it this way is what lets the controls respond during the seconds
 * the basemap takes to arrive instead of appearing to ignore the first click. */
function render() {
  const active = findLayer(state.product, state.pol, state.year);
  if (active) {
    updateLegend(active);
    clearStatus(STATUS_KEY);
  } else {
    el("layer-info").textContent = "";
    setStatus(STATUS_KEY, `No ${state.product} ${state.pol} layer for ${state.year}`, "info");
  }
  syncControls();
  showOnMap(active);
}

/* Only the previously shown layer is hidden rather than every added one: at
 * most one raster is ever visible, so there is nothing else to turn off.
 * Repeated calls settle in order, so the last selection wins. */
async function showOnMap(active) {
  await styleReady;
  if (state.activeId && state.activeId !== active?.id) {
    map.setLayoutProperty(`glace-${state.activeId}`, "visibility", "none");
    state.activeId = null;
  }
  if (!active) return;
  ensureLayer(active);
  map.setLayoutProperty(layerId(active), "visibility", "visible");
  map.setPaintProperty(layerId(active), "raster-opacity", state.opacity);
  state.activeId = active.id;
}

function updateLegend(layer) {
  el("legend-bar").style.background = `linear-gradient(to right, ${layer.colors.join(", ")})`;
  const unit = typeof layer.units === "string" && layer.units ? ` ${layer.units}` : "";
  const digits = Math.abs(layer.vmax - layer.vmin) < 5 ? 2 : 1;
  el("legend-min").textContent = layer.vmin.toFixed(digits) + unit;
  el("legend-max").textContent = layer.vmax.toFixed(digits) + unit;
  el("layer-info").textContent = legendDetail(layer);
}

/* The line under the legend, from whichever fields the manifest actually
 * carries. `size_bytes` and `cmap` are descriptive rather than structural — the
 * layer draws identically without them — so a manifest that omits one loses a
 * fragment of this line instead of losing the layer. Validating them as
 * required would cost a real data layer over a caption. */
export function legendDetail(layer) {
  const parts = [
    `${layer.product} ${layer.polarization} ${layer.year}`,
    `z${layer.min_zoom}–${layer.max_zoom}`,
  ];
  if (isFiniteNumber(layer.size_bytes) && layer.size_bytes >= 0) {
    parts.push(`${(layer.size_bytes / 1e6).toFixed(1)} MB`);
  }
  if (isNonEmptyString(layer.cmap)) parts.push(layer.cmap);
  return parts.join(" · ");
}

/* ---------- controls ---------- */

/* A product/polarization combination only exists for some years; the buttons
 * that would leave the current year empty are disabled rather than hidden, so
 * the control does not reflow while scrubbing. */
function syncControls() {
  for (const [node, field] of [
    [el("product"), "product"],
    [el("pol"), "pol"],
  ]) {
    for (const button of node.children) {
      const value = button.dataset.value;
      const exists =
        field === "product"
          ? findLayer(value, state.pol, state.year)
          : findLayer(state.product, value, state.year);
      button.setAttribute("aria-checked", String(state[field] === value));
      button.disabled = !exists && state[field] !== value;
    }
  }
  el("year-value").textContent = state.year;
  el("year").value = state.manifest.years.indexOf(state.year);
}

function initControls(manifest) {
  const select = (field) => (value) => {
    state[field] = value;
    render();
  };
  buildSegmented(el("product"), manifest.products, select("product"));
  buildSegmented(el("pol"), manifest.polarizations, select("pol"));

  const years = manifest.years;
  const slider = el("year");
  slider.min = 0;
  slider.max = Math.max(0, years.length - 1);
  slider.disabled = years.length < 2;
  slider.addEventListener("input", () => {
    state.year = years[Number(slider.value)];
    render();
  });
  el("year-ticks").replaceChildren(
    ...(years.length > 1 ? [years[0], years[years.length - 1]] : years).map((year) => {
      const span = document.createElement("span");
      span.textContent = year;
      return span;
    }),
  );

  el("opacity").addEventListener("input", (event) => {
    state.opacity = Number(event.target.value) / 100;
    el("opacity-value").textContent = `${event.target.value}%`;
    render();
  });
}

/* ---------- boot ---------- */

/* The rasters are the only part of the page that needs object storage. When the
 * manifest cannot be reached or cannot be understood, hide the controls that
 * describe a raster layer and say so once, rather than leaving dead sliders
 * behind an error message. */
function noRasters(reason) {
  el("raster-controls").hidden = true;
  el("layer-info").textContent = "";
  setStatus(
    STATUS_KEY,
    `No GLACE layers: ${reason}. Basemap, terrain and inventories still work.`,
    "error",
  );
}

export async function loadRasters() {
  setStatus(STATUS_KEY, "Loading layers…");
  let manifest;
  try {
    const response = await fetch(LAYER_MANIFEST_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    manifest = validateManifest(await response.json());
  } catch (error) {
    noRasters(`${LAYER_MANIFEST_URL} — ${error.message}`);
    return null;
  }

  state.manifest = manifest;
  state.index = new Map(
    manifest.layers.map((layer) => [key(layer.product, layer.polarization, layer.year), layer]),
  );

  const first = manifest.layers[0];
  state.product = first.product;
  state.pol = first.polarization;
  state.year = manifest.years[manifest.years.length - 1];
  if (!findLayer(state.product, state.pol, state.year)) state.year = first.year;

  initControls(manifest);
  render();
  return manifest;
}

/* The union of every archive's footprint — what to frame when the page is
 * opened without a #hash naming a view. */
export function manifestBounds(manifest) {
  return manifest.layers.reduce(
    (acc, layer) => [
      Math.min(acc[0], layer.bounds[0]), Math.min(acc[1], layer.bounds[1]),
      Math.max(acc[2], layer.bounds[2]), Math.max(acc[3], layer.bounds[3]),
    ],
    [180, 90, -180, -90],
  );
}
