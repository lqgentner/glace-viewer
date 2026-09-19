/*
 * Raster selection and legends for records from js/store.js. Sources are created on
 * first display and retained for reuse. Rendering uses pre-styled PMTiles.
 */

import { addStacked, map, styleReady } from "./map.js";
import { FALSE_COLOUR, isFiniteNumber, isNonEmptyString, readStore } from "./store.js";
import { buildSegmented, clearStatus, creditButton, el, h, setStatus } from "./ui.js";

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

const CHANNEL_SWATCHES = ["#e0524f", "#4c9f4c", "#5b8def"];

/* Credit scientific color maps named cmc.<map> in the style. */
const COLOUR_MAP_CREDIT = {
  citation: "© Fabio Crameri",
  links: [{ label: "Scientific color maps", url: "https://www.fabiocrameri.ch/colourmaps/" }],
};

const state = {
  axes: null,
  product: null,
  pol: null,
  quantity: MEASUREMENT,
  year: null,
  opacity: 1,
  added: new Set(),
  activeKey: null,
};

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
  /*
   * Inherit attribution and bounds from PMTiles metadata. Zoom limits come from the
   * catalog style.
   */
  map.addSource(id, {
    type: "raster",
    url: `pmtiles://${layer.url}`,
    tileSize: 256,
    minzoom: layer.minZoom,
    maxzoom: layer.maxZoom,
  });
  addStacked("data", {
    id,
    type: "raster",
    source: id,
    layout: { visibility: "none" },
    paint: { "raster-opacity": state.opacity, "raster-resampling": "nearest" },
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
  map.setLayoutProperty(wanted, "visibility", "visible");
  map.setPaintProperty(wanted, "raster-opacity", state.opacity);
  state.activeKey = wanted;
}

const unitSuffix = (layer) =>
  typeof layer.units === "string" && layer.units ? ` ${layer.units}` : "";
const round = (value, span) => value.toFixed(Math.abs(span) < 5 ? 2 : 1);

function updateLegend(layer) {
  const falseColour = layer.polarization === FALSE_COLOUR;
  el("legend-bar").hidden = falseColour;
  el("legend-labels").hidden = falseColour;
  el("legend-channels").hidden = !falseColour;

  if (falseColour) {
    updateChannelLegend(layer);
  } else {
    el("legend-bar").style.background = `linear-gradient(to right, ${layer.colors.join(", ")})`;
    const unit = unitSuffix(layer);
    const span = layer.vmax - layer.vmin;
    el("legend-min").textContent = round(layer.vmin, span) + unit;
    el("legend-max").textContent = round(layer.vmax, span) + unit;
  }
  updateColourMapCredit(layer);
  el("layer-info").replaceChildren(...layerDetail(layer).map((line) => h("div", { textContent: line })));
}

function updateChannelLegend(layer) {
  const unit = unitSuffix(layer);
  el("legend-channels").replaceChildren(
    ...falseColourChannels(layer).flatMap(({ band, vmin, vmax }, at) => [
      h("span", { class: "swatch", style: { background: CHANNEL_SWATCHES[at] } }),
      h("span", { class: "band", textContent: band }),
      h("span", {
        textContent:
          vmin === undefined
            ? ""
            : `${round(vmin, vmax - vmin)} to ${round(vmax, vmax - vmin)}${unit}`,
      }),
    ]),
  );
}

/*
 * Validate the three {band, vmin, vmax} channel records. Invalid metadata omits
 * legend numbers without hiding the pre-styled layer.
 */
function validChannels(channels) {
  const usable =
    Array.isArray(channels) &&
    channels.length === 3 &&
    channels.every(
      (channel) =>
        channel !== null &&
        typeof channel === "object" &&
        isNonEmptyString(channel.band) &&
        isFiniteNumber(channel.vmin) &&
        isFiniteNumber(channel.vmax) &&
        channel.vmin < channel.vmax,
    );
  return usable ? channels : null;
}

/**
 * Use the style's published channel stretches. Without them, show band names and
 * the ratio (a difference in dB) but never infer ranges from sibling layers.
 *
 * @param {object} layer
 * @returns {{band: string, vmin?: number, vmax?: number}[]}
 */
export function falseColourChannels(layer) {
  const published = validChannels(layer.channels);
  if (published !== null) return published;
  return [{ band: "VV" }, { band: "VH" }, { band: layer.units === "dB" ? "VV − VH" : "VV / VH" }];
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

/*
 * Keep the credit button while its color map is unchanged so an open popover
 * survives renders.
 */
let shownColourMap = null;

function updateColourMapCredit(layer) {
  const cmap = isNonEmptyString(layer.cmap) ? layer.cmap.replace(/^cmc\./, "") : "";
  if (cmap === shownColourMap) return;
  shownColourMap = cmap;
  el("legend-credit").replaceChildren(
    ...(cmap
      ? [creditButton("Color map", { ...COLOUR_MAP_CREDIT, title: `Colormap: ${cmap}` })]
      : []),
  );
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
    axes = indexLayers(await readStore());
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
  render();
  return axes;
}
