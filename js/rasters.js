/*
 * Raster selection and legends for records from js/store.js. Sources are created on
 * first display and retained for reuse. Value-encoded archives are colored here,
 * with a color map and range the legend edits in place.
 */

import { addStacked, map, styleReady } from "./map.js";
import { archive } from "./archive.js";
import { FALSE_COLOUR, compositeLayers, compositeTiles } from "./composite.js";
import { isNonEmptyString, readStore } from "./store.js";
import { COLOR_MAPS } from "./colormaps.js";
import { attachPicker, buildSegmented, clearStatus, el, h, setStatus } from "./ui.js";
import { decodePixel, step } from "./values.js";

const STATUS_KEY = "rasters";

/* Display labels differ from catalog values; unknown products keep their names. */
const PRODUCT_LABELS = { COH12: "Coherence", RTC: "Backscatter" };
const productLabel = (product) => PRODUCT_LABELS[product] ?? product;

/* Split product and qualifier to fit the panel width. */
const PRODUCT_DETAIL = {
  COH12: ["Composite Coherence", "12-day baseline"],
  RTC: ["Composite Backscatter", "Radiometrically terrain corrected"],
};

const COMPOSITING_DETAIL = "Local resolution weighted median";

/*
 * Panel order and allowlist after removing QA suffixes. Unsupported polarizations
 * are omitted silently. RGB is a channel recipe presented in the same row.
 */
const POLARIZATIONS = ["VV", "VH", "RGB"];

/*
 * The catalog encodes quantities as polarization suffixes: none for data, QA_NUM
 * for count, QA_CQM for quality. title supplies the tooltip and QA description;
 * name supplies status text.
 */
const MEASUREMENT = "";
const QUANTITIES = [
  { value: MEASUREMENT, label: "Data", title: "The measurement itself" },
  {
    value: "QA_NUM",
    label: "QA: Count",
    title: "Number of contributing observations",
    name: "observation count",
  },
  {
    value: "QA_CQM",
    label: "QA: Quality",
    title: "Composite quality map (higher is better)",
    name: "composite quality map",
  },
];
const QUANTITY_ORDER = QUANTITIES.map((quantity) => quantity.value);
const quantityOf = (value) => QUANTITIES.find((quantity) => quantity.value === value);

/* Default color maps are the viewer's choice; the catalog's style ramp is not read. */
const PRODUCT_CMAP = { COH12: "cmc.lipari", RTC: "cmc.navia" };
const QA_CMAP = "cmc.glasgow";

export function defaultCmap(layer) {
  const { quantity } = splitPolarization(layer.polarization);
  if (quantity !== MEASUREMENT) return QA_CMAP;
  return PRODUCT_CMAP[layer.product] ?? "viridis";
}

const CHANNEL_SWATCHES = ["#e0524f", "#4c9f4c", "#5b8def"];

const state = {
  axes: null,
  product: null,
  pol: null,
  quantity: MEASUREMENT,
  year: null,
  opacity: 1,
  added: new Set(),
  activeKey: null,
  /* Color-map and limit choices by layer stem, so a year change keeps them. */
  custom: new Map(),
};

/* ---------- value-encoded layers ---------- */

const encoded = (layer) => Boolean(layer?.encoding);
const customOf = (layer) => state.custom.get(layer.stem) ?? {};
const cmapOf = (layer) => customOf(layer).cmap ?? defaultCmap(layer);
const colorsOf = (layer) => COLOR_MAPS[cmapOf(layer)];
const rangeOf = (layer) => ({
  vmin: customOf(layer).vmin ?? layer.vmin,
  vmax: customOf(layer).vmax ?? layer.vmax,
});
const shortName = (name) => name.replace(/^cmc\./, "");
const gradient = (colors) => `linear-gradient(to right, ${colors.join(", ")})`;

/* Record a choice, forgetting values equal to the defaults so reset means a change. */
function customize(layer, change) {
  const next = { ...customOf(layer), ...change };
  if (next.cmap === defaultCmap(layer)) delete next.cmap;
  if (next.vmin === layer.vmin) delete next.vmin;
  if (next.vmax === layer.vmax) delete next.vmax;
  if (Object.keys(next).length) state.custom.set(layer.stem, next);
  else state.custom.delete(layer.stem);
  render();
}

/*
 * A color-relief expression: transparent below the first valid code, the ramp
 * over vmin-vmax, clamped outside it. Code 1 is the lowest value; code 0, one
 * step below, is nodata.
 */
export function reliefColor(encoding, colors, vmin, vmax) {
  const scale = step(encoding);
  const edge = scale - encoding.baseShift - scale / 2;
  const stops = [
    [edge, "rgba(0, 0, 0, 0)"],
    [edge + scale / 100, colors[0]],
  ];
  colors.forEach((color, at) => {
    const position = vmin + ((vmax - vmin) * at) / Math.max(1, colors.length - 1);
    if (position > stops[stops.length - 1][0]) stops.push([position, color]);
  });
  return ["interpolate", ["linear"], ["elevation"], ...stops.flat()];
}

function applyRamp(layer) {
  if (!encoded(layer) || !state.added.has(layer.id)) return;
  const { vmin, vmax } = rangeOf(layer);
  map.setPaintProperty(
    layer.id,
    "color-relief-color",
    reliefColor(layer.encoding, colorsOf(layer), vmin, vmax),
  );
}

const opacityProperty = (layer) => (layer.composite ? "raster-opacity" : "color-relief-opacity");

const key = (product, polarization, year) => `${product}|${polarization}|${year}`;

/* ---------- the polarization field ---------- */

/*
 * Match only known QA suffixes; unknown ones remain in the polarization and fail
 * the allowlist.
 */
const QA_SUFFIX = /^(.+)_(QA_(?:NUM|CQM))$/;

function splitPolarization(value) {
  const at = QA_SUFFIX.exec(value);
  return at === null ? { pol: value, quantity: MEASUREMENT } : { pol: at[1], quantity: at[2] };
}

const joinPolarization = (pol, quantity) => (quantity === MEASUREMENT ? pol : `${pol}_${quantity}`);

const findLayer = (product, pol, quantity, year) =>
  state.axes.index.get(key(product, joinPolarization(pol, quantity), year)) ?? null;

/** The layer the controls currently describe, or null where none was published. */
const selected = () => findLayer(state.product, state.pol, state.quantity, state.year);

/** The layer the current selection would name with some of its axes moved. */
function layerFor(overrides) {
  const at = { product: state.product, pol: state.pol, quantity: state.quantity, ...overrides };
  return findLayer(at.product, at.pol, at.quantity, state.year);
}

/*
 * For RGB × QA, the clicked row wins and the other falls back to its first valid
 * value. Product never gives way: a missing archive must leave the selected year
 * unchanged.
 */
const GIVES_WAY = { pol: "quantity", quantity: "pol" };

/* Return the other row's fallback value, or undefined if no combination works. */
function fallbackFor(field, value) {
  const other = GIVES_WAY[field];
  if (other === undefined) return undefined;
  const axis = other === "pol" ? state.axes.polarizations : state.axes.quantities;
  return axis.find((candidate) => layerFor({ [field]: value, [other]: candidate }) !== null);
}

/* ---------- the axes ---------- */

/* Filter unsupported panel choices; store.js has already checked renderability. */
function presented(layer) {
  const { pol, quantity } = splitPolarization(layer.polarization);
  return POLARIZATIONS.includes(pol) && QUANTITY_ORDER.includes(quantity);
}

/**
 * Build axes from available layers: products in catalog order, years ascending,
 * polarizations and quantities in panel order.
 *
 * @param {object[]} layers  the records js/store.js read out of the catalog
 */
export function indexLayers(layers) {
  const usable = layers.filter(presented);
  if (!usable.length) throw new Error("no published layer has a control on this page");

  const split = usable.map((layer) => splitPolarization(layer.polarization));
  const polarizations = [...new Set(split.map((at) => at.pol))];
  const quantities = new Set(split.map((at) => at.quantity));

  return {
    layers: usable,

    index: new Map(
      usable.map((layer) => [key(layer.product, layer.polarization, layer.year), layer]),
    ),
    products: [...new Set(usable.map((layer) => layer.product))],
    polarizations: polarizations.sort((a, b) => POLARIZATIONS.indexOf(a) - POLARIZATIONS.indexOf(b)),
    quantities: QUANTITY_ORDER.filter((quantity) => quantities.has(quantity)),
    years: [...new Set(usable.map((layer) => layer.year))].sort((a, b) => a - b),
  };
}

/* ---------- map layers ---------- */

function ensureLayer(layer) {
  const id = layer.id;
  if (state.added.has(id)) return;
  /* A composite has no archive of its own, so its source names the credit. */
  if (layer.composite) {
    map.addSource(id, {
      type: "raster",
      tiles: [compositeTiles(id)],
      tileSize: 256,
      minzoom: layer.minZoom,
      maxzoom: layer.maxZoom,
      attribution: layer.attribution,
    });
    addStacked("data", {
      id,
      type: "raster",
      source: id,
      layout: { visibility: "none" },
      paint: { "raster-opacity": state.opacity, "raster-resampling": "nearest" },
    });
    state.added.add(id);
    return;
  }
  /*
   * Inherit attribution and bounds from PMTiles metadata. Zoom limits come from the
   * catalog style. Register the shared reader first, so reloads read from memory.
   */
  archive(layer.url);
  map.addSource(id, {
    type: "raster-dem",
    url: `pmtiles://${layer.url}`,
    tileSize: 256,
    minzoom: layer.minZoom,
    maxzoom: layer.maxZoom,
    ...layer.encoding,
  });
  const { vmin, vmax } = rangeOf(layer);
  addStacked("data", {
    id,
    type: "color-relief",
    source: id,
    layout: { visibility: "none" },
    paint: {
      "color-relief-opacity": state.opacity,
      resampling: "nearest",
      "color-relief-color": reliefColor(layer.encoding, colorsOf(layer), vmin, vmax),
    },
  });
  state.added.add(id);
}

/*
 * Report the first failure per raster source. Ignore canceled requests, which are
 * normal during panning.
 */
const reportedFailures = new Set();

map.on("error", (event) => {
  const source = event.sourceId;
  if (!source || !state.added.has(source) || reportedFailures.has(source)) return;
  if (event.error?.name === "AbortError") return;
  reportedFailures.add(source);
  setStatus(
    STATUS_KEY,
    `This layer could not be drawn — ${event.error?.message ?? "its tiles could not be read"}`,
    "error",
  );
});

function selectionName() {
  const quantity = quantityOf(state.quantity)?.name;
  const what = `${productLabel(state.product)} ${state.pol}`;
  return quantity ? `${what} ${quantity}` : `${what} layer`;
}

/* Update controls immediately; map rendering waits for the parsed style. */
function render() {
  const active = selected();
  if (active) {
    updateLegend(active);
    clearStatus(STATUS_KEY);
  } else {
    el("layer-info").replaceChildren();
    setStatus(STATUS_KEY, `No ${selectionName()} for ${state.year}`, "info");
  }
  syncControls();
  showOnMap(active);
}

/* Hide only the previous raster. Calls settle in order, so the last selection wins. */
async function showOnMap(active) {
  await styleReady;
  const wanted = active ? active.id : null;
  if (state.activeKey && state.activeKey !== wanted) {
    map.setLayoutProperty(state.activeKey, "visibility", "none");
    state.activeKey = null;
  }
  if (!active) return;
  ensureLayer(active);
  applyRamp(active);
  map.setLayoutProperty(wanted, "visibility", "visible");
  map.setPaintProperty(wanted, opacityProperty(active), state.opacity);
  state.activeKey = wanted;
}

const unitSuffix = (layer) =>
  typeof layer.units === "string" && layer.units ? ` ${layer.units}` : "";
const decimals = (span) => (Math.abs(span) < 5 ? 2 : 1);
const round = (value, span) => value.toFixed(decimals(span));

/* Show a limit unless it is being typed in; remember what was shown for Escape. */
function showLimit(input, text) {
  input.dataset.shown = text;
  input.size = Math.max(2, text.length);
  if (document.activeElement !== input) input.value = text;
}

function updateLegend(layer) {
  const falseColour = layer.polarization === FALSE_COLOUR;
  el("legend-bar").hidden = falseColour;
  el("legend-labels").hidden = falseColour;
  el("legend-channels").hidden = !falseColour;
  el("cmap").hidden = falseColour;

  if (falseColour) {
    el("range-reset").hidden = true;
    updateChannelLegend(layer);
  } else {
    const custom = customOf(layer);
    const { vmin, vmax } = rangeOf(layer);
    const span = vmax - vmin;
    el("legend-bar").style.background = gradient(colorsOf(layer));
    el("cmap").textContent = shortName(cmapOf(layer));
    showLimit(el("vmin"), round(vmin, span));
    showLimit(el("vmax"), round(vmax, span));
    el("vmin").classList.toggle("modified", "vmin" in custom);
    el("vmax").classList.toggle("modified", "vmax" in custom);
    for (const unit of el("legend-labels").querySelectorAll(".unit")) {
      unit.textContent = unitSuffix(layer);
    }
    el("range-reset").hidden = !("vmin" in custom || "vmax" in custom);
  }
  el("layer-info").replaceChildren(...layerDetail(layer).map((line) => h("div", { textContent: line })));
}

function updateChannelLegend(layer) {
  const unit = unitSuffix(layer);
  el("legend-channels").replaceChildren(
    ...layer.channels.flatMap(({ band, vmin, vmax }, at) => [
      h("span", { class: "swatch", style: { background: CHANNEL_SWATCHES[at] } }),
      h("span", { class: "band", textContent: band }),
      h("span", { textContent: `${round(vmin, vmax - vmin)} to ${round(vmax, vmax - vmin)}${unit}` }),
    ]),
  );
}

const isDate = (value) => isNonEmptyString(value) && /^\d{4}-\d{2}-\d{2}$/.test(value);

/*
 * Describe the product or QA quantity, followed by acquisition dates when
 * available.
 */
export function layerDetail(layer) {
  const { quantity } = splitPolarization(layer.polarization);
  const lines =
    quantity === MEASUREMENT
      ? [
          ...(PRODUCT_DETAIL[layer.product] ?? [`${productLabel(layer.product)} composite`]),
          COMPOSITING_DETAIL,
        ]
      : [quantityOf(quantity).title];
  if (isDate(layer.startDate) && isDate(layer.endDate)) {
    lines.push(`${layer.startDate} to ${layer.endDate}`);
  }
  return lines;
}

/* ---------- legend editing ---------- */

function initLegend() {
  attachPicker(
    el("cmap"),
    () => {
      const layer = selected();
      const current = layer ? cmapOf(layer) : null;
      return Object.keys(COLOR_MAPS).map((name) => ({
        value: name,
        current: name === current,
        label: shortName(name),
        class: "cmap-option",
        content: [
          h("span", { class: "ramp", style: { background: gradient(COLOR_MAPS[name]) } }),
          h("span", { textContent: shortName(name) }),
        ],
      }));
    },
    (name) => {
      const layer = selected();
      if (encoded(layer)) customize(layer, { cmap: name });
    },
    { className: "cmap-popover" },
  );

  for (const input of [el("vmin"), el("vmax")]) {
    const revert = () => {
      input.value = input.dataset.shown ?? "";
    };
    input.addEventListener("change", () => {
      const layer = selected();
      if (!encoded(layer)) return;
      const text = input.value.trim().replace(",", ".");
      const range = rangeOf(layer);
      // Round to the precision the legend shows, so what is shown is what is drawn.
      const other = input.id === "vmin" ? range.vmax : range.vmin;
      const value = Number(Number(text).toFixed(decimals(other - Number(text))));
      const next = input.id === "vmin" ? { ...range, vmin: value } : { ...range, vmax: value };
      /*
       * Keep limits within the codes the archive encodes: below code 1 the ramp
       * falls into the nodata stop, and above code 255 MapLibre's packed ramp
       * wraps around.
       */
      const half = step(layer.encoding) / 2;
      const lowest = decodePixel(layer.encoding, 1, 1, 1) - half;
      const highest = decodePixel(layer.encoding, 255, 255, 255) + half;
      const outside = next.vmin < lowest || next.vmax > highest;
      if (text === "" || !Number.isFinite(value) || next.vmin >= next.vmax || outside) {
        revert();
        return;
      }
      input.blur();
      customize(layer, { [input.id]: value });
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
      if (event.key === "Escape") {
        revert();
        input.blur();
      }
    });
  }

  /* Reset restores the default limits and keeps the chosen color map. */
  el("range-reset").addEventListener("click", () => {
    const layer = selected();
    if (encoded(layer)) customize(layer, { vmin: layer.vmin, vmax: layer.vmax });
  });
}

/* ---------- controls ---------- */

/*
 * Gray choices with a fallback remain clickable via aria-disabled; missing archives
 * use disabled. Keep the selected button active even when its year has no archive.
 */
function syncControls() {
  for (const [node, field] of [
    [el("product"), "product"],
    [el("quantity"), "quantity"],
    [el("pol"), "pol"],
  ]) {
    for (const button of node.children) {
      const value = button.dataset.value;
      const chosen = state[field] === value;
      const gray = !chosen && layerFor({ [field]: value }) === null;
      const reachable = gray && fallbackFor(field, value) !== undefined;
      button.setAttribute("aria-checked", String(chosen));
      button.disabled = gray && !reachable;
      if (reachable) button.setAttribute("aria-disabled", "true");
      else button.removeAttribute("aria-disabled");
    }
  }
  el("year-value").textContent = state.year;
  el("year").value = state.axes.years.indexOf(state.year);
}

function initControls(axes) {
  const select = (field) => (value) => {
    state[field] = value;

    if (selected() === null) {
      const fallback = fallbackFor(field, value);
      if (fallback !== undefined) state[GIVES_WAY[field]] = fallback;
    }
    render();
  };
  buildSegmented(
    el("product"),
    axes.products.map((product) => ({ value: product, label: productLabel(product) })),
    select("product"),
  );

  buildSegmented(
    el("quantity"),
    QUANTITIES.filter((quantity) => axes.quantities.includes(quantity.value)),
    select("quantity"),
  );
  el("quantity-row").hidden = axes.quantities.length < 2;

  buildSegmented(el("pol"), axes.polarizations, select("pol"));

  const years = axes.years;
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

/*
 * Hide unavailable raster controls while keeping the independent map and overlays
 * usable.
 */
function noRasters(reason) {
  el("raster-controls").hidden = true;
  el("layer-info").replaceChildren();
  setStatus(
    STATUS_KEY,
    `No GLACE layers: ${reason}. Basemap, terrain and inventories still work.`,
    "error",
  );
}

export async function loadRasters() {
  setStatus(STATUS_KEY, "Loading layers…");
  let axes;
  try {
    const layers = await readStore();
    axes = indexLayers([...layers, ...compositeLayers(layers)]);
  } catch (error) {
    noRasters(error.message);
    return null;
  }

  state.axes = axes;

  /*
   * Start with the first value of each panel axis, falling back to an existing
   * archive.
   */
  state.product = axes.products[0];
  state.pol = axes.polarizations[0];
  state.quantity = axes.quantities[0];
  state.year = axes.years[axes.years.length - 1];
  if (!selected()) {
    const wanted = joinPolarization(state.pol, state.quantity);
    const fallback =
      axes.layers.find(
        (layer) => layer.product === state.product && layer.polarization === wanted,
      ) ?? axes.layers[0];
    const { pol, quantity } = splitPolarization(fallback.polarization);
    state.product = fallback.product;
    state.pol = pol;
    state.quantity = quantity;
    state.year = fallback.year;
  }

  initControls(axes);
  initLegend();
  render();
  return axes;
}
