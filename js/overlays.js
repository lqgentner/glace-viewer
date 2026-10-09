/*
 * Lazy inventory PMTiles and catalog-grid overlays. Failed loads remove their
 * layers and source so the control can retry.
 */

import { INVENTORY_BASE, INVENTORY_INDEX_URL } from "./config.js";
import { addStacked, map, styleReady } from "./map.js";
import { isNonEmptyString } from "./store.js";
import { valuesAt } from "./rasters.js";
import { loadTileGrid } from "./tile-grid.js";
import { attachPicker, clearStatus, creditButton, el, h, setStatus } from "./ui.js";

/* ---------- the shared lazy-source lifecycle ---------- */

class LazyOverlay {
  /**
   * @param {object} spec
   * @param {string} spec.sourceId    MapLibre source id, also the status key.
   * @param {string[]} spec.layerIds  Layers to add, remove and toggle together.
   * @param {string} spec.label       Shown while the archive is loading.
   * @param {() => void} spec.add     Adds the source and the layers.
   * @param {string} spec.failure     Message for a failed load; the error goes to the console.
   * @param {() => HTMLInputElement} spec.checkbox    The box to untick on failure.
   */
  constructor(spec) {
    Object.assign(this, spec);
    this.loaded = false;
    this.loading = false;
    this.wanted = false;
  }

  /*
   * Wait for the style before creating or toggling layers. One load runs at a time
   * and ends showing the latest choice.
   */
  async setEnabled(on) {
    this.wanted = on;
    await styleReady;
    if (this.loaded) {
      this.show();
      return;
    }
    if (!on || this.loading) return;
    this.loading = true;
    setStatus(this.sourceId, `Loading ${this.label}…`);
    /*
     * The grid reads its data here; PMTiles sources load through MapLibre. Both
     * paths share rollback handling.
     */
    try {
      await this.add();
    } catch (error) {
      this.fail(error);
      return;
    } finally {
      this.loading = false;
    }
    this.loaded = true;
    this.show();
    this.watch();
  }

  show() {
    const visibility = this.wanted ? "visible" : "none";
    for (const id of this.layerIds) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visibility);
    }
  }

  /* Remove failed state so the next activation can retry. */
  fail(error) {
    console.warn(`${this.sourceId}:`, error?.message ?? "load failed");
    this.remove();
    const box = this.checkbox();
    if (box) box.checked = false;
    setStatus(this.sourceId, this.failure, "error");
  }

  remove() {
    for (const id of this.layerIds) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(this.sourceId)) map.removeSource(this.sourceId);
    this.loaded = false;
  }

  /* Watch initial source loading only; remove listeners after success or failure. */
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

/* Built from committed GeoJSON by scripts/build-tiles.py. */
const inventories = new Map();

/* Drop index entries missing the fields needed to create an overlay. */
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
    failure: `Error loading ${entry.title}. Tick it again to retry.`,
    add() {
      map.addSource(this.sourceId, {
        type: "vector",
        url: `pmtiles://${INVENTORY_BASE}/${entry.url}`,
      });
      /*
       * Unfilled outlines preserve the raster beneath; dark casing improves
       * contrast. source-layer must match the tippecanoe layer name.
       */
      addStacked("overlay", {
        id: `${lineId}-casing`,
        type: "line",
        source: this.sourceId,
        "source-layer": sourceLayer,
        paint: {
          "line-color": "#000",
          "line-width": ["interpolate", ["linear"], ["zoom"], 6, 2.4, 10, 3.6, 14, 5.2],
        },
      });
      addStacked("overlay", {
        id: lineId,
        type: "line",
        source: this.sourceId,
        "source-layer": sourceLayer,
        paint: {
          "line-color": entry.color,
          "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 10, 1, 14, 1.6],
        },
      });
    },
  });
}

/* ColorBrewer Set1, named for screen readers: the index's defaults are its first five. */
const OUTLINE_COLORS = {
  "#e41a1c": "Red",
  "#377eb8": "Blue",
  "#4daf4a": "Green",
  "#984ea3": "Purple",
  "#ff7f00": "Orange",
  "#ffff33": "Yellow",
  "#a65628": "Brown",
  "#f781bf": "Pink",
  "#999999": "Gray",
};

/* Update loaded outlines immediately; unloaded layers read entry.color on creation. */
function colorPicker(entry) {
  const lineId = `inv-line-${entry.id}`;
  const swatch = h("button", {
    type: "button",
    class: "swatch",
    "aria-label": `${entry.title}: outline color`,
    style: { backgroundColor: entry.color },
  });
  attachPicker(
    swatch,
    () =>
      Object.entries(OUTLINE_COLORS).map(([color, name]) => ({
        value: color,
        current: color === entry.color,
        label: name,
        class: "chip",
        style: { backgroundColor: color },
      })),
    (color) => {
      entry.color = color;
      swatch.style.backgroundColor = color;
      if (map.getLayer(lineId)) map.setPaintProperty(lineId, "line-color", color);
    },
    { className: "palette-popover", caretAt: 1 / 3 },
  );
  return swatch;
}

export async function loadInventories() {
  let index;
  try {
    const response = await fetch(INVENTORY_INDEX_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    index = validateInventoryIndex(await response.json());
  } catch {
    // Overlays are optional; the page works without them.
    el("inventories-section").hidden = true;
    return;
  }

  const node = el("inventories");
  node.replaceChildren();
  for (const entry of index) {
    const overlay = inventoryOverlay(entry);
    inventories.set(entry.id, { entry, overlay });

    const box = h("input", { type: "checkbox", id: `inv-${entry.id}` });
    box.addEventListener("change", () => overlay.setEnabled(box.checked));

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
        colorPicker(entry),
        label,
        creditButton(entry.title, entry),
      ),
    );
  }
  el("inventories-section").hidden = index.length === 0;
}

/* ---------- catalog tile grid ---------- */

const GRID_LAYER = "grid-fill";

export const grid = new LazyOverlay({
  sourceId: "grid",
  layerIds: [GRID_LAYER, "grid-line"],
  label: "tile grid",
  checkbox: () => el("grid"),
  failure: "Error loading the tile grid. Tick it again to retry.",
  async add() {
    /* The decoded footprints are small enough to supply as one GeoJSON source. */
    map.addSource(this.sourceId, { type: "geojson", data: await loadTileGrid() });
    addStacked("overlay", {
      id: GRID_LAYER,
      type: "fill",
      source: this.sourceId,
      paint: {
        // Shade by glacier fraction in neutral white for contrast with raster colors.
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

/* Query a box around the pointer to make thin and overlapping outlines clickable. */
const CLICK_RADIUS_PX = 8;

/* Query all overlays together to combine overlapping features in one popup. */
function clickableLayers() {
  const layers = [...inventories.values()]
    .filter(({ entry, overlay }) => overlay.loaded && el(`inv-${entry.id}`)?.checked)
    .map(({ entry }) => `inv-line-${entry.id}`);
  if (grid.loaded && el("grid")?.checked) layers.push(GRID_LAYER);
  return layers.filter((id) => map.getLayer(id));
}

/* Omit missing fields and build nodes so vector-tile properties remain text. */
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

  return popupSection(entry.title, [
    entry.has_names === false ? null : ["Glacier name", props.name || "No name provided"],
    ["Glacier number", props.glacier_nr],
    ["RGI ID", props.rgi_id],
    ["Acquisition year", props.year],
  ].filter(Boolean));
}

/* MGRS starts with the UTM zone and latitude band. Bands C–M are south, N–X north. */
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

    ["Glacier fraction, 250 m buffer", percent(props.glacier_fraction_buffered)],
  ]);
}

/* The overlays' sections at a point, inventories first and the grid after. */
function featureSections({ x, y }) {
  const layers = clickableLayers();
  if (!layers.length) return [];
  const hits = map.queryRenderedFeatures(
    [
      [x - CLICK_RADIUS_PX, y - CLICK_RADIUS_PX],
      [x + CLICK_RADIUS_PX, y + CLICK_RADIUS_PX],
    ],
    { layers },
  );

  // Deduplicate hits per layer.
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
  return sections;
}

/* The latest inspection, so a slow read cannot open a popup over a newer one. */
let inspections = 0;
let popup = null;

/* One popup: the raster's values on top, then the overlays under the point. */
async function inspect(point, lngLat) {
  const inspection = ++inspections;
  const sections = featureSections(point);
  const values = await valuesAt([lngLat.lng, lngLat.lat]).catch(() => null);
  if (inspection !== inspections) return;
  if (values) sections.unshift(popupSection(values.heading, values.fields));
  if (!sections.length) return;

  const content = document.createDocumentFragment();
  sections.forEach((section, i) => {
    if (i > 0) content.append(document.createElement("hr"));
    content.append(...section);
  });
  closePopup();
  popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false })
    .setLngLat(lngLat)
    .setDOMContent(content)
    .addTo(map);
}

/* No close button: a click elsewhere, a drag, a zoom, a tilt or Escape closes the popup. */
function closePopup() {
  if (!popup) return false;
  popup.remove();
  popup = null;
  return true;
}

/*
 * A click waits this long for a second one, which makes it a double-click zoom
 * that opens nothing. Closing does not wait.
 */
const DOUBLE_CLICK_MS = 250;
let lastClick = -Infinity;
let pendingClick = null;

map.on("click", (event) => {
  const now = performance.now();
  const double = now - lastClick < DOUBLE_CLICK_MS;
  lastClick = now;
  clearTimeout(pendingClick);
  pendingClick = null;
  if (double || closePopup()) return;
  pendingClick = setTimeout(() => {
    pendingClick = null;
    inspect(event.point, event.lngLat);
  }, DOUBLE_CLICK_MS);
});
// Tilting covers the 3D button, which eases the pitch.
for (const event of ["dragstart", "zoomstart", "pitchstart"]) map.on(event, closePopup);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePopup();
});

/* Enter on the focused map inspects its center, for keyboards. */
map.getCanvasContainer().addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const { clientWidth, clientHeight } = map.getContainer();
  inspect({ x: clientWidth / 2, y: clientHeight / 2 }, map.getCenter());
});
