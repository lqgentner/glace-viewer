/*
 * Vector overlays: the glacier inventories and the catalog tile grid.
 *
 * Both are read by range request from object storage — the inventories as
 * vector PMTiles, the grid out of the store's stac-geoparquet item index — and
 * both share one lifecycle: nothing is created until the box is first ticked,
 * and a failure rolls the layers back so re-ticking is a fresh attempt rather
 * than a no-op. `LazyOverlay` is that lifecycle; the two differ in which layers
 * they add, what they say when they cannot be reached, and whether they hand
 * MapLibre a source that loads itself or one this page has already read.
 */

import { GRID_INDEX_URL, INVENTORY_BASE, INVENTORY_INDEX_URL } from "./config.js";
import { addStacked, map, styleReady } from "./map.js";
import { isNonEmptyString } from "./store.js";
import { loadTileGrid } from "./tile-grid.js";
import { clearStatus, collapsible, creditButton, el, h, setStatus } from "./ui.js";

/* ---------- the shared lazy-source lifecycle ---------- */

class LazyOverlay {
  /**
   * @param {object} spec
   * @param {string} spec.sourceId    MapLibre source id, also the status key.
   * @param {string[]} spec.layerIds  Layers to add, remove and toggle together.
   * @param {string} spec.label       Shown while the archive is loading.
   * @param {() => void} spec.add     Adds the source and the layers.
   * @param {(error?: Error) => string} spec.failure  Message for a failed load.
   * @param {() => HTMLInputElement} spec.checkbox    The box to untick on failure.
   */
  constructor(spec) {
    Object.assign(this, spec);
    this.loaded = false;
  }

  /* Awaiting the style is what makes a box ticked while the basemap is still
   * loading behave the same as one ticked afterwards: the click is honoured
   * when the style arrives instead of being dropped. Repeated toggles settle in
   * call order, so the last one wins. */
  async setEnabled(on) {
    await styleReady;
    if (this.loaded) {
      const visibility = on ? "visible" : "none";
      for (const id of this.layerIds) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visibility);
      }
      return;
    }
    if (!on) return;
    setStatus(this.sourceId, `Loading ${this.label}…`);
    /* `add` may be asynchronous — the grid reads and parses its index before it
     * has anything to give MapLibre, where an archive-backed overlay hands over
     * a URL and lets the source load itself. Both failure paths land in the
     * same place: roll back, untick, and say so. */
    try {
      await this.add();
    } catch (error) {
      this.fail(error);
      return;
    }
    this.loaded = true;
    this.watch();
  }

  /* Roll back, so re-ticking the box is a fresh attempt rather than a no-op. */
  fail(error) {
    this.remove();
    const box = this.checkbox();
    if (box) box.checked = false;
    setStatus(this.sourceId, this.failure(error), "error");
  }

  remove() {
    for (const id of this.layerIds) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(this.sourceId)) map.removeSource(this.sourceId);
    this.loaded = false;
  }

  /* Because the source loads itself, success and failure arrive as map events
   * rather than as the resolution of a fetch. Both are one-shot: the listeners
   * take themselves off again so later tile activity on the source is ignored. */
  watch() {
    const stop = () => {
      map.off("sourcedata", onData);
      map.off("error", onError);
    };
    const onData = (event) => {
      if (event.sourceId !== this.sourceId || !map.isSourceLoaded(this.sourceId)) return;
      stop();
      clearStatus(this.sourceId);
    };
    const onError = (event) => {
      if (event.sourceId !== this.sourceId) return;
      stop();
      this.fail(event.error);
    };
    map.on("sourcedata", onData);
    map.on("error", onError);
  }
}

/* ---------- glacier inventories ---------- */

/* Each inventory is a vector archive built from the committed GeoJSON by
 * scripts/build-tiles.py, so the browser pulls only the tiles the view covers
 * and the outlines draw as the first tiles land. */
const inventories = new Map();

/* The index is fetched, so it gets the same treatment as the raster catalog:
 * an entry missing the fields the overlay is built from is dropped rather than
 * allowed to fail later inside MapLibre. */
function validateInventoryIndex(raw) {
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw.inventories)) return [];
  return raw.inventories.filter((entry) => {
    const ok =
      entry !== null &&
      typeof entry === "object" &&
      isNonEmptyString(entry.id) &&
      isNonEmptyString(entry.title) &&
      isNonEmptyString(entry.url) &&
      isNonEmptyString(entry.color);
    if (!ok) console.warn("inventories.json: skipping malformed entry", entry);
    return ok;
  });
}

function inventoryOverlay(entry) {
  const lineId = `inv-line-${entry.id}`;
  const sourceLayer = entry.source_layer || entry.id;
  return new LazyOverlay({
    sourceId: `inv-${entry.id}`,
    layerIds: [`${lineId}-casing`, lineId],
    label: entry.title,
    checkbox: () => el(`inv-${entry.id}`),
    failure: (error) => `${entry.title} unavailable (${error?.message ?? "load failed"})`,
    add() {
      map.addSource(this.sourceId, {
        type: "vector",
        url: `pmtiles://${INVENTORY_BASE}/${entry.url}`,
      });
      /* Outlines only — a fill would hide the imagery the outline is there to
       * be compared against. The dark casing keeps them legible over both the
       * pale and the dark end of the colour ramps. `source-layer` must match
       * the layer name tippecanoe was given. */
      addStacked("overlay", {
        id: `${lineId}-casing`,
        type: "line",
        source: this.sourceId,
        "source-layer": sourceLayer,
        paint: {
          "line-color": "rgba(0,0,0,0.55)",
          "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1.8, 10, 3, 14, 4.4],
          "line-opacity": 0.8,
        },
      });
      addStacked("overlay", {
        id: lineId,
        type: "line",
        source: this.sourceId,
        "source-layer": sourceLayer,
        paint: {
          "line-color": entry.color,
          "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.6, 10, 1.2, 14, 2],
        },
      });
    },
  });
}

export async function loadInventories() {
  let index;
  try {
    const response = await fetch(INVENTORY_INDEX_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    index = validateInventoryIndex(await response.json());
  } catch {
    // Overlays are optional; the page works without them.
    return;
  }

  const node = el("inventories");
  node.replaceChildren();
  for (const entry of index) {
    const overlay = inventoryOverlay(entry);
    inventories.set(entry.id, { entry, overlay });

    const box = h("input", { type: "checkbox", id: `inv-${entry.id}` });
    box.addEventListener("change", () => overlay.setEnabled(box.checked));
    // No forced break: the name wraps on its own where the panel is narrow, and
    // the span follows it inline so the row never runs to three lines.
    const label = h(
      "label",
      { htmlFor: box.id },
      `${entry.title} `,
      entry.span ? h("span", { class: "span", textContent: `(${entry.span})` }) : null,
    );
    node.append(
      h(
        "div",
        { class: "inventory" },
        box,
        h("span", { class: "swatch", style: { background: entry.color } }),
        label,
        creditButton(entry.title, entry),
      ),
    );
  }
  el("inventories-section").hidden = index.length === 0;

  collapsible("inventories-toggle", "inventories");
}

/* ---------- catalog tile grid ---------- */

const GRID_LAYER = "grid-fill";

export const grid = new LazyOverlay({
  sourceId: "grid",
  layerIds: [GRID_LAYER, "grid-line"],
  label: "tile grid",
  checkbox: () => el("grid"),
  failure: (error) =>
    `Tile grid unavailable — ${GRID_INDEX_URL}${error?.message ? ` (${error.message})` : ""}`,
  async add() {
    /* GeoJSON rather than a tiled source: this is 143 footprints over
     * Switzerland and ~2 200 over the Alps, which is a small enough document to
     * hand over whole, and it arrives already parsed. */
    map.addSource(this.sourceId, { type: "geojson", data: await loadTileGrid() });
    addStacked("overlay", {
      id: GRID_LAYER,
      type: "fill",
      source: this.sourceId,
      paint: {
        // Shade each MGRS tile by how much of it the inventory calls glacier.
        // White rather than the panel's blue: the data ramps run through blue at
        // one end and grey-white at the other, and only white keeps the grid
        // legible over both without being mistaken for the data itself.
        "fill-color": [
          "interpolate",
          ["linear"],
          ["coalesce", ["get", "glacier_fraction"], 0],
          0, "rgba(255,255,255,0.04)",
          0.25, "rgba(255,255,255,0.30)",
        ],
      },
    });
    addStacked("overlay", {
      id: "grid-line",
      type: "line",
      source: this.sourceId,
      paint: { "line-color": "#ffffff", "line-width": 0.6, "line-opacity": 0.7 },
    });
  },
});

/* ---------- popups ---------- */

/* A one-pixel outline is nearly impossible to hit, so clicks are resolved
 * against a box around the pointer rather than the rendered line itself. This
 * also lets several overlapping inventories answer one click. */
const CLICK_RADIUS_PX = 8;

/* One handler for every clickable overlay: querying them together means a
 * single click reports everything under it in one popup rather than racing two
 * handlers to open competing ones. */
function clickableLayers() {
  const layers = [...inventories.values()]
    .filter(({ entry, overlay }) => overlay.loaded && el(`inv-${entry.id}`)?.checked)
    .map(({ entry }) => `inv-line-${entry.id}`);
  if (grid.loaded && el("grid")?.checked) layers.push(GRID_LAYER);
  return layers.filter((id) => map.getLayer(id));
}

/* Every popup section reads the same way: a muted uppercase heading styled like
 * the panel's own field labels, then `label: value` lines. Fields whose value is
 * missing are dropped rather than shown empty.
 *
 * Built as nodes, not as an HTML string: the values are vector-tile properties,
 * and a glacier name containing markup must stay a glacier name. */
function popupSection(heading, fields) {
  const nodes = [h("div", { class: "pop-head", textContent: heading })];
  for (const [label, value] of fields) {
    if (value === null || value === undefined || value === "") continue;
    nodes.push(h("div", {}, h("span", { class: "pk", textContent: `${label}:` }), ` ${value}`));
  }
  return nodes;
}

const percent = (value) =>
  value === null || value === undefined ? null : `${(Number(value) * 100).toFixed(1)} %`;

function inventoryRow(feature) {
  const id = feature.layer.id.replace("inv-line-", "");
  const { entry } = inventories.get(id);
  const props = feature.properties;
  // Paul et al. ships no names but does carry its own glacier number, so each
  // inventory is described by whichever identifier it actually has.
  const identity =
    props.glacier_nr === undefined
      ? ["Glacier name", props.name || "No name provided"]
      : ["Glacier number", props.glacier_nr];
  return popupSection(entry.title, [identity, ["Acquisition year", props.year]]);
}

/* The tile name is a UTM zone, a latitude band and the 100 km square, e.g.
 * 31TFJ68 — so the zone the tile is projected in can be read straight off it.
 * Bands C-M are the southern hemisphere, N-X the northern. */
export function utmZone(tile) {
  const match = /^(\d{1,2})([C-HJ-NP-X])/.exec(tile || "");
  if (!match) return null;
  return `${Number(match[1])}${match[2] >= "N" ? "N" : "S"}`;
}

function gridRow(feature) {
  const props = feature.properties;
  return popupSection("MGRS tile", [
    ["Tile identifier", props.tile],
    ["UTM zone", utmZone(props.tile)],
    ["Glacier fraction", percent(props.glacier_fraction)],
    // What the sampler actually weights on, so it is worth showing beside the
    // plain fraction rather than only in the catalogue.
    ["Glacier fraction, 250 m buffer", percent(props.glacier_fraction_buffered)],
  ]);
}

map.on("click", (event) => {
  const layers = clickableLayers();
  if (!layers.length) return;

  const { x, y } = event.point;
  const hits = map.queryRenderedFeatures(
    [
      [x - CLICK_RADIUS_PX, y - CLICK_RADIUS_PX],
      [x + CLICK_RADIUS_PX, y + CLICK_RADIUS_PX],
    ],
    { layers },
  );
  if (!hits.length) return;

  // A box this size often clips the same outline more than once; keep the first
  // hit per layer, and let the tile grid trail the inventories as context.
  const seen = new Set();
  const sections = [];
  let gridSection = null;
  for (const hit of hits) {
    if (seen.has(hit.layer.id)) continue;
    seen.add(hit.layer.id);
    if (hit.layer.id === GRID_LAYER) gridSection = gridRow(hit);
    else sections.push(inventoryRow(hit));
  }
  if (gridSection) sections.push(gridSection);

  const content = document.createDocumentFragment();
  sections.forEach((section, i) => {
    if (i > 0) content.append(document.createElement("hr"));
    content.append(...section);
  });
  new maplibregl.Popup().setLngLat(event.lngLat).setDOMContent(content).addTo(map);
});
