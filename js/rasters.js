/*
 * Raster selection and legends for records from js/store.js. Sources are created on
 * first display and retained for reuse. Value-encoded archives are colored here,
 * with a color map and range set in the scale editor, which also sets false
 * color's three channel ranges.
 */

import { addStacked, map, styleReady } from "./map.js";
import { archive } from "./archive.js";
import { FALSE_COLOUR, compositeLayers, compositeTiles, restretch } from "./composite.js";
import { isNonEmptyString, readStore } from "./store.js";
import { COLOR_MAPS } from "./colormaps.js";
import { buildSegmented, clearStatus, el, h, setStatus } from "./ui.js";
import { decodePixel, step } from "./values.js";
import { codeAt, codeRange, compositeCounts, histogramPath, viewCounts } from "./histogram.js";

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
/* What each channel's limits stretch over, as the editor's bar under its histogram. */
const CHANNEL_RAMPS = [["#000", "#f00"], ["#000", "#0f0"], ["#000", "#00f"]];

const state = {
  axes: null,
  product: null,
  pol: null,
  quantity: MEASUREMENT,
  year: null,
  opacity: 1,
  added: new Set(),
  activeKey: null,
  /* Color-map and limit choices by layer stem, so a year change keeps them:
     { cmap, limits: [{ vmin, vmax }] } with one limits entry per band. */
  custom: new Map(),
};

/* ---------- value-encoded layers ---------- */

const encoded = (layer) => Boolean(layer?.encoding);
/* The scale editor edits a value-encoded layer, or false color's channels. */
const editable = (layer) => Boolean(layer?.encoding || layer?.composite);
/* The bands with limits: each has its encoding, default limits and units. */
const bandsOf = (layer) => layer.channels ?? [layer];
const customOf = (layer) => state.custom.get(layer.stem) ?? {};
const ownLimits = (layer, band) => customOf(layer).limits?.[band] ?? {};
const cmapOf = (layer) => customOf(layer).cmap ?? defaultCmap(layer);
const colorsOf = (layer) => COLOR_MAPS[cmapOf(layer)];
const rangeOf = (layer, band = 0) => ({
  vmin: ownLimits(layer, band).vmin ?? bandsOf(layer)[band].vmin,
  vmax: ownLimits(layer, band).vmax ?? bandsOf(layer)[band].vmax,
});
const stretchOf = (layer) => bandsOf(layer).map((_, band) => rangeOf(layer, band));
const shortName = (name) => name.replace(/^cmc\./, "");
const gradient = (colors) => `linear-gradient(to right, ${colors.join(", ")})`;

/*
 * Record a color map, or limits by band index, forgetting values equal to the
 * defaults so reset means a change.
 */
function customize(layer, { cmap, limits = {} }) {
  const custom = customOf(layer);
  const next = {};
  const chosen = cmap ?? custom.cmap;
  if (chosen !== undefined && chosen !== defaultCmap(layer)) next.cmap = chosen;
  const own = bandsOf(layer).map((band, at) => {
    const merged = { ...custom.limits?.[at], ...limits[at] };
    for (const which of ["vmin", "vmax"]) if (merged[which] === band[which]) delete merged[which];
    return merged;
  });
  if (own.some((limit) => Object.keys(limit).length)) next.limits = own;
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

/* Redraw what changed: a composite's channel limits, or an archive's ramp. */
function applyRamp(layer) {
  if (!state.added.has(layer.id)) return;
  if (layer.composite) {
    const stretch = stretchOf(layer);
    if (JSON.stringify(stretch) !== JSON.stringify(layer.stretch)) {
      restretch(layer, stretch, () => map.getSource(layer.id).setTiles([compositeTiles(layer.id)]));
    }
    return;
  }
  if (!encoded(layer)) return;
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
    restretch(layer, stretchOf(layer));
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
 * Keep the first failure per raster source, shown while its layer is selected.
 * Ignore canceled requests, which are normal during panning.
 */
const failures = new Map();

map.on("error", (event) => {
  const source = event.sourceId;
  if (!source || !state.added.has(source) || failures.has(source)) return;
  if (event.error?.name === "AbortError") return;
  failures.set(
    source,
    `This layer could not be drawn — ${event.error?.message ?? "its tiles could not be read"}`,
  );
  if (source === selected()?.id) setStatus(STATUS_KEY, failures.get(source), "error");
});

function selectionName() {
  const quantity = quantityOf(state.quantity)?.name;
  const what = `${productLabel(state.product)} ${state.pol}`;
  return quantity ? `${what} ${quantity}` : `${what} layer`;
}

/* Update controls immediately; map rendering waits for the parsed style. */
function render() {
  const active = selected();
  el("legend").hidden = !active;
  if (active) {
    updateLegend(active);
    const failure = failures.get(active.id);
    if (failure) setStatus(STATUS_KEY, failure, "error");
    else clearStatus(STATUS_KEY);
  } else {
    el("layer-info").replaceChildren();
    setStatus(STATUS_KEY, `No ${selectionName()} for ${state.year}`, "info");
  }
  syncControls();
  followSelection(active);
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

function updateLegend(layer) {
  const falseColour = layer.polarization === FALSE_COLOUR;
  el("legend-bar").hidden = falseColour;
  el("legend-labels").hidden = falseColour;
  el("legend-channels").hidden = !falseColour;
  el("cmap").hidden = falseColour;
  el("legend-edit").hidden = !editable(layer);

  if (falseColour) {
    updateChannelLegend(layer);
  } else {
    const own = ownLimits(layer, 0);
    const { vmin, vmax } = rangeOf(layer);
    const span = vmax - vmin;
    el("legend-bar").style.background = gradient(colorsOf(layer));
    el("cmap").textContent = shortName(cmapOf(layer));
    el("legend-min").textContent = round(vmin, span);
    el("legend-max").textContent = round(vmax, span);
    el("legend-min").classList.toggle("modified", "vmin" in own);
    el("legend-max").classList.toggle("modified", "vmax" in own);
    for (const unit of el("legend-labels").querySelectorAll(".unit")) {
      unit.textContent = unitSuffix(layer);
    }
  }
  if (el("scale-editor").open && editable(layer)) syncEditor(layer);
  el("layer-info").replaceChildren(...layerDetail(layer).map((line) => h("div", { textContent: line })));
}

function updateChannelLegend(layer) {
  el("legend-channels").replaceChildren(
    ...bandsOf(layer).flatMap((band, at) => {
      const { vmin, vmax } = rangeOf(layer, at);
      const own = ownLimits(layer, at);
      const limit = (which, value) =>
        h("span", { class: which in own ? "modified" : null, textContent: round(value, vmax - vmin) });
      return [
        h("span", { class: "swatch", style: { background: CHANNEL_SWATCHES[at] } }),
        h("span", { class: "band", textContent: band.band }),
        h("span", {}, limit("vmin", vmin), " to ", limit("vmax", vmax), unitSuffix(band)),
      ];
    }),
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

/* ---------- scale editor ---------- */

/*
 * The limits a band can take. For an archive, below code 1 the ramp falls into
 * the nodata stop, and above code 255 MapLibre's packed ramp wraps around. It
 * rounds a stop to the smallest factor, so the top allows less than half of
 * that, enough for floating-point error. A ratio channel takes its axis. The
 * refusal names bottom and top: an archive's codes 1 and 255.
 */
function limitsRange(band) {
  if (band.bounds) {
    const [low, high] = band.bounds;
    return { lowest: low, highest: high, bottom: low, top: high };
  }
  const { encoding } = band;
  const { redFactor, greenFactor, blueFactor } = encoding;
  const bottom = decodePixel(encoding, 1, 1, 1);
  const top = decodePixel(encoding, 255, 255, 255);
  return {
    lowest: bottom - step(encoding) / 2,
    highest: top + Math.min(redFactor, greenFactor, blueFactor) / 4,
    bottom,
    top,
  };
}

function rangeText(band) {
  const { bottom, top } = limitsRange(band);
  return `Enter a value between ${round(bottom, top - bottom)} and ${round(top, top - bottom)}${unitSuffix(band)}.`;
}

/*
 * Parse a typed limit, rounded to the precision the legend shows so what is shown
 * is what is drawn. Text, an inverted range, or a limit the band cannot take is
 * a problem, with the reason to show.
 *
 * @returns {{value: number}|{problem: string}}
 */
function parseLimit(layer, at, which, typed) {
  const band = bandsOf(layer)[at];
  const text = typed.trim().replace(",", ".");
  const range = rangeOf(layer, at);
  const other = which === "vmin" ? range.vmax : range.vmin;
  const value = Number(Number(text).toFixed(decimals(other - Number(text))));
  const next = { ...range, [which]: value };
  const { lowest, highest } = limitsRange(band);
  if (text === "" || !Number.isFinite(value)) return { problem: rangeText(band) };
  if (next.vmin >= next.vmax) return { problem: "Min must be below Max." };
  if (next.vmin < lowest || next.vmax > highest) return { problem: rangeText(band) };
  return { value };
}

/*
 * A histogram's axis runs over codes 1-255 at even width, from half a step
 * below code 1 to half a step above code 255. A ratio's encoding has 255 such
 * steps across its axis.
 */
const HISTOGRAM_HEIGHT = 64; // the viewBox of each histogram's SVG
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const fractionOf = (encoding, value) =>
  clamp(((value + encoding.baseShift) / step(encoding) - 0.5) / 255, 0, 1);
const valueAt = (encoding, fraction) => (fraction * 255 + 0.5) * step(encoding) - encoding.baseShift;
const percent = (fraction) => `${(fraction * 100).toFixed(3)}%`;

const bandNodes = () => [...el("bands").children];
const limitInputs = () => [...el("bands").querySelectorAll("input")];

/*
 * One block per band from #band-template: a histogram over the band's axis,
 * the ramp it draws and its limits, Min left and Max right. False color names
 * each channel.
 */
function buildBands(layer) {
  const template = el("band-template").content.firstElementChild;
  const nodes = bandsOf(layer).map((band, at) => {
    const node = template.cloneNode(true);
    node.dataset.band = at;
    for (const which of ["vmin", "vmax"]) {
      const input = node.querySelector(`input.${which}`);
      input.id = `${which}-${at}`;
      const name = which === "vmin" ? "Min" : "Max";
      input.setAttribute("aria-label", layer.composite ? `${band.band} ${name.toLowerCase()}` : name);
      initField(input, at, which);
    }
    const name = node.querySelector(".band-name");
    name.hidden = !layer.composite;
    if (layer.composite) {
      node.style.setProperty("--tint", CHANNEL_SWATCHES[at]);
      name.querySelector(".channel").textContent = "RGB"[at];
      name.querySelector(".name").textContent = band.band;
    }
    initHistogram(node.querySelector(".histogram"), at);
    return node;
  });
  el("bands").replaceChildren(...nodes);
  el("bands").classList.toggle("channels", Boolean(layer.composite));
}

/* The bands' names, so blocks are rebuilt only for a layer of another kind. */
const bandsKey = (layer) => bandsOf(layer).map((band) => band.band ?? "").join("|");

/* Fill the editor from the layer. A field being typed in is left alone unless forced. */
function syncEditor(layer, { force = false } = {}) {
  if (el("bands").dataset.key !== bandsKey(layer)) {
    buildBands(layer);
    el("bands").dataset.key = bandsKey(layer);
  }
  bandsOf(layer).forEach((band, at) => {
    const node = bandNodes()[at];
    const { vmin, vmax } = rangeOf(layer, at);
    for (const [which, value] of [["vmin", vmin], ["vmax", vmax]]) {
      const input = el(`${which}-${at}`);
      if (force || document.activeElement !== input) {
        input.value = round(value, vmax - vmin);
        input.removeAttribute("aria-invalid");
      }
      // iOS's decimal keypad has no minus sign.
      input.inputMode = limitsRange(band).bottom < 0 ? "text" : "decimal";
    }
    // Handles, shading and the ramp below sit where the limits fall on the axis.
    const low = fractionOf(band.encoding, vmin);
    const high = fractionOf(band.encoding, vmax);
    const chart = node.querySelector(".histogram");
    chart.style.setProperty("--low", percent(low));
    chart.style.setProperty("--high", percent(high));
    const colors = layer.composite ? CHANNEL_RAMPS[at] : colorsOf(layer);
    const stops = colors.map(
      (color, index) => `${color} ${percent(low + ((high - low) * index) / Math.max(1, colors.length - 1))}`,
    );
    node.querySelector(".band-bar").style.background = `linear-gradient(to right, ${stops.join(", ")})`;
    for (const unit of node.querySelectorAll(".unit")) unit.textContent = unitSuffix(band).trim();
  });
  // The reason a limit was refused stays only while its field is flagged. The live
  // region is emptied rather than hidden, so it exists when the next reason comes.
  const flagged = limitInputs().some((input) => input.getAttribute("aria-invalid") === "true");
  if (!flagged) el("limits-hint").textContent = "";
  // aria-disabled, not disabled: a focused button that turns unavailable keeps focus.
  el("range-reset").setAttribute("aria-disabled", String(!customOf(layer).limits));
  const counted = viewed?.layer === layer && viewed.counts.some((counts) => codeRange(counts) !== null);
  el("range-percentile").setAttribute("aria-disabled", String(!counted));
  el("range-extent").setAttribute("aria-disabled", String(!counted));
  el("cmap-section").hidden = Boolean(layer.composite);
  const current = cmapOf(layer);
  for (const option of el("cmap-options").children) {
    option.setAttribute("aria-pressed", String(option.dataset.value === current));
  }
}

/** The selected layer, where the editor can edit it. */
const editing = () => {
  const layer = selected();
  return editable(layer) ? layer : null;
};

/* The read in progress, aborted when the editor closes or reopens. */
let reading = null;
/* The layer the histograms show or are reading, and their counts once read. */
let shown = null;
let viewed = null;

/* A note over the charts; a chart is an image, so its label carries the note too. */
function note(layer, text) {
  bandNodes().forEach((node, at) => {
    node.querySelector(".note").textContent = text;
    const band = bandsOf(layer)[at].band;
    const label = `Histogram of ${band ?? "the values"} in view`;
    node.querySelector(".histogram").setAttribute("aria-label", text ? `${label}: ${text}` : label);
  });
}

const drawBars = (counts) =>
  bandNodes().forEach((node, at) =>
    node.querySelector(".bars").setAttribute("d", counts ? histogramPath(counts[at], HISTOGRAM_HEIGHT) : ""),
  );

/*
 * Count the values in view. A new layer starts blank; a recount of the same
 * one, after the map moves, keeps the old bars until the new ones are ready.
 * Either way the presets wait for the new counts.
 */
async function showHistogram(layer) {
  reading?.abort();
  const controller = (reading = new AbortController());
  viewed = null;
  syncEditor(layer);
  if (shown !== layer) {
    shown = layer;
    drawBars(null);
    note(layer, "Loading…");
  }
  try {
    const bounds = map.getBounds();
    // After panning across world copies, longitudes run past ±180.
    const shift = 360 * Math.round(map.getCenter().lng / 360);
    // Drawn tiles are at least 181 px wide (256 px at half a zoom down).
    const { clientWidth: width, clientHeight: height } = map.getContainer();
    const budget = Math.ceil(width / 181 + 1) * Math.ceil(height / 181 + 1);
    const view = [bounds.getWest() - shift, bounds.getSouth(), bounds.getEast() - shift, bounds.getNorth()];
    const counts = layer.composite
      ? await compositeCounts(layer, view, map.getZoom(), controller.signal, budget)
      : [await viewCounts(layer, view, map.getZoom(), controller.signal, budget)];
    drawBars(counts);
    note(layer, counts.some((band) => codeRange(band) !== null) ? "" : "No data in view");
    viewed = { layer, counts };
    syncEditor(layer);
  } catch {
    if (controller.signal.aborted) return;
    viewed = null;
    drawBars(null);
    note(layer, "The values in view could not be read");
    syncEditor(layer);
  }
}

/* The open editor follows the selection, and closes on a layer it cannot edit. */
function followSelection(layer) {
  const editor = el("scale-editor");
  if (!editor.open) return;
  if (!editable(layer)) {
    editor.close();
  } else if (shown !== layer) {
    syncEditor(layer, { force: true });
    showHistogram(layer);
  }
}

/*
 * Round to `digits`, then into the band's range on that grid, so a limit at
 * either end is drawn rather than refused.
 */
function onGrid(band, value, digits) {
  const unit = 10 ** -digits;
  const { lowest, highest } = limitsRange(band);
  const inside = clamp(value, Math.ceil(lowest / unit) * unit, Math.floor(highest / unit) * unit);
  return Number(inside.toFixed(digits));
}

/*
 * Limits from code positions, rounded as the fields show them and kept a shown
 * digit apart within what the band can take.
 */
function limitsAt(band, low, high) {
  const { encoding } = band;
  const scale = step(encoding);
  const [from, to] = [low * scale - encoding.baseShift, high * scale - encoding.baseShift];
  const digits = decimals(to - from);
  const unit = 10 ** -digits;
  const fit = (value) => onGrid(band, value, digits);
  let [vmin, vmax] = [fit(from), fit(to)];
  if (vmax <= vmin) {
    if (fit(vmin + unit) > vmin) vmax = fit(vmin + unit);
    else vmin = fit(vmax - unit);
  }
  return { vmin, vmax };
}

/* Fit every counted band's limits to the code positions `pick` finds in its counts. */
function fitBands(layer, pick) {
  if (viewed?.layer !== layer) return;
  const limits = {};
  bandsOf(layer).forEach((band, at) => {
    if (codeRange(viewed.counts[at]) !== null) limits[at] = limitsAt(band, ...pick(viewed.counts[at]));
  });
  customize(layer, { limits });
}

/*
 * Drag a band's limit across its histogram. A press moves the nearer handle
 * there and keeps it under the pointer until release; a limit stops one shown
 * digit short of the other. A touch may start a scroll of the editor instead,
 * so it moves the handle once it travels across, or on release as a tap.
 */
const ACROSS = 6; // px

function initHistogram(node, at) {
  let dragging = null;
  let touch = null;

  const fractionAt = (event) => {
    const box = node.getBoundingClientRect();
    return box.width > 0 ? clamp((event.clientX - box.left) / box.width, 0, 1) : null;
  };
  const follow = (layer, fraction) => {
    const band = bandsOf(layer)[at];
    const range = rangeOf(layer, at);
    const other = dragging === "vmin" ? range.vmax : range.vmin;
    const raw = valueAt(band.encoding, fraction);
    // The precision of the range this drag makes, as parseLimit rounds it.
    const digits = decimals(other - raw);
    const unit = 10 ** -digits;
    let value = onGrid(band, raw, digits);
    value = dragging === "vmin" ? Math.min(value, other - unit) : Math.max(value, other + unit);
    const { value: limit } = parseLimit(layer, at, dragging, value.toFixed(digits));
    if (limit !== undefined && limit !== range[dragging]) {
      customize(layer, { limits: { [at]: { [dragging]: limit } } });
    }
  };

  node.addEventListener("pointerdown", (event) => {
    const layer = editing();
    const fraction = fractionAt(event);
    if (!layer || fraction === null) return;
    event.preventDefault();
    // A field being typed in would not show the dragged value.
    if (document.activeElement?.matches("#bands input")) document.activeElement.blur();
    const { encoding } = bandsOf(layer)[at];
    const { vmin, vmax } = rangeOf(layer, at);
    const toLow = Math.abs(fraction - fractionOf(encoding, vmin));
    const toHigh = Math.abs(fraction - fractionOf(encoding, vmax));
    dragging = toLow <= toHigh ? "vmin" : "vmax";
    node.setPointerCapture?.(event.pointerId);
    node.classList.add("dragging");
    if (event.pointerType === "touch") touch = { x: event.clientX, y: event.clientY };
    else follow(layer, fraction);
  });
  node.addEventListener("pointermove", (event) => {
    const layer = editing();
    const fraction = fractionAt(event);
    if (!dragging || !layer || fraction === null) return;
    if (touch) {
      const across = Math.abs(event.clientX - touch.x);
      if (across < ACROSS || across < Math.abs(event.clientY - touch.y)) return;
      touch = null;
    }
    follow(layer, fraction);
  });
  const end = () => {
    dragging = null;
    touch = null;
    node.classList.remove("dragging");
  };
  node.addEventListener("pointerup", (event) => {
    const layer = editing();
    const fraction = fractionAt(event);
    if (touch && dragging && layer && fraction !== null) follow(layer, fraction);
    end();
  });
  // The browser cancels a touch it scrolls with.
  for (const type of ["pointercancel", "lostpointercapture"]) node.addEventListener(type, end);
}

/* A band's limit field: each valid value applies as it is typed; the rest are flagged. */
function initField(input, at, which) {
  input.addEventListener("input", () => {
    const layer = editing();
    if (!layer) return;
    const { value, problem } = parseLimit(layer, at, which, input.value);
    input.setAttribute("aria-invalid", String(problem !== undefined));
    el("limits-hint").textContent = problem ?? "";
    if (value !== undefined && value !== rangeOf(layer, at)[which]) {
      customize(layer, { limits: { [at]: { [which]: value } } });
    }
  });
  // Leaving the field shows what is drawn, which also discards invalid text.
  input.addEventListener("change", () => {
    const layer = editing();
    if (layer) syncEditor(layer, { force: true });
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") input.blur();
  });
}

function initLegend() {
  const editor = el("scale-editor");

  /*
   * Not modal: the map stays live behind the editor, which recounts the view
   * after each move. The edit button toggles it.
   */
  el("legend-edit").addEventListener("click", () => {
    const layer = editing();
    if (editor.open || !layer) {
      editor.close();
      return;
    }
    syncEditor(layer, { force: true });
    editor.show();
    el("legend-edit").setAttribute("aria-expanded", "true");
    showHistogram(layer);
  });
  editor.addEventListener("close", () => {
    reading?.abort();
    shown = null;
    viewed = null;
    el("legend-edit").setAttribute("aria-expanded", "false");
  });
  editor.querySelector(".close").addEventListener("click", () => editor.close());
  // A non-modal dialog has no close request of its own.
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Escape") editor.close();
  });
  map.on("moveend", () => {
    const layer = editing();
    if (editor.open && layer) showHistogram(layer);
  });

  el("cmap-options").replaceChildren(
    ...Object.keys(COLOR_MAPS).map((name) =>
      h(
        "button",
        {
          type: "button",
          class: "cmap-option",
          dataset: { value: name },
          onclick: () => {
            const layer = editing();
            if (layer && !layer.composite) customize(layer, { cmap: name });
          },
        },
        h("span", { class: "ramp", style: { background: gradient(COLOR_MAPS[name]) } }),
        h("span", { textContent: shortName(name) }),
      ),
    ),
  );

  /* Presets fit every band to the values in view, as the histograms counted them. */
  const unavailable = (id) => el(id).getAttribute("aria-disabled") === "true";
  el("range-percentile").addEventListener("click", () => {
    const layer = editing();
    if (layer && !unavailable("range-percentile")) {
      fitBands(layer, (counts) => [codeAt(counts, 0.02), codeAt(counts, 0.98)]);
    }
  });
  el("range-extent").addEventListener("click", () => {
    const layer = editing();
    if (layer && !unavailable("range-extent")) fitBands(layer, codeRange);
  });

  /* Reset restores every band's default limits and keeps the chosen color map. */
  el("range-reset").addEventListener("click", () => {
    const layer = editing();
    if (!layer || unavailable("range-reset")) return;
    customize(layer, { limits: bandsOf(layer).map(({ vmin, vmax }) => ({ vmin, vmax })) });
    syncEditor(layer, { force: true });
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
