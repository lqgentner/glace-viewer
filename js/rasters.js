/*
 * The GLACE raster layers: the manifest, the controls that select one of them,
 * and the legend that describes it.
 *
 * `layers.json` (written by the store's finalize-catalog step) holds one entry
 * per (product, polarization, year). Only the entry currently on screen has a
 * MapLibre source, and only the entries that have been on screen keep one, so
 * scrubbing through years stays instant without asking for archive metadata
 * nobody looked at.
 *
 * Every layer is drawn from its pre-styled PMTiles archive. The store publishes
 * the float COG each one was styled from as well, and this page used to offer a
 * switch between the two; that comparison is finished and the switch is retired
 * — see "Tile source" in AGENTS.md for what it measured. The reader itself is
 * still in the tree, wired to its protocol, so the question can be reopened
 * without rebuilding it: js/cog-rgb.js.
 */

import { LAYER_MANIFEST_URL, TILES_BASE } from "./config.js";
import { addStacked, map, styleReady } from "./map.js";
import { buildSegmented, clearStatus, creditButton, el, h, setStatus } from "./ui.js";

const STATUS_KEY = "rasters";

/* The manifest names products the way the archives are named; the panel names
 * them the way a reader would. `data-value` keeps the manifest's spelling, so
 * only the button face changes. A product with no entry here falls back to its
 * own name rather than vanishing. */
const PRODUCT_LABELS = { COH12: "Coherence", RTC: "Backscatter" };
const productLabel = (product) => PRODUCT_LABELS[product] ?? product;

/* What the selected product is, and the qualifier that goes with it. Two lines
 * rather than one joined by a separator: at the panel's width the qualifier
 * wraps anyway, so it may as well break where it means to. */
const PRODUCT_DETAIL = {
  COH12: ["Composite Coherence", "12-day baseline"],
  RTC: ["Composite Backscatter", "Radiometrically terrain corrected"],
};

/* How every GLACE layer is composited, which is the same for all of them. */
const COMPOSITING_DETAIL = "Local resolution weighted median";

/* The polarizations this page presents, in the order it presents them: VV is
 * the one to open on, so it belongs on the left whatever order the manifest
 * declares.
 *
 * It is an allowlist as well as an order. The manifest's `polarization` field
 * carries more than a polarization — see QUANTITIES below — so this list is
 * matched against what is left once the QA suffix has been taken off. Anything
 * else (an HH/HV build, a QA role this page has no row for) is dropped in
 * validateManifest() rather than left to validLayer(), which would report each
 * one as malformed over something that is not wrong with it.
 *
 * `RGB` is not a polarization either, but it is a layer a reader picks from
 * this same row, so it sits at the end of it. */
const POLARIZATIONS = ["VV", "VH", "RGB"];

/* The quantity a layer carries, which the manifest spells as a suffix on the
 * polarization: `VV` is the measurement itself, `VV_QA_NUM` and `VV_QA_CQM` the
 * two QA rasters the store publishes beside it. So the field names a
 * polarization, a QA role and a channel recipe all at once, and the panel
 * splits it back into the two rows a reader chooses from.
 *
 * The measurement is the *absence* of a suffix, which is why its value is the
 * empty string — `data-value` carries the manifest's own spelling here as
 * everywhere else, and the manifest's spelling for a measurement is nothing.
 *
 * The button faces are short because the row is three wide in a 292px panel;
 * the full names are on the buttons' own tooltips and under the colour ramp. */
const MEASUREMENT = "";
const QUANTITIES = [
  { value: MEASUREMENT, label: "Data", title: "The measurement itself" },
  { value: "QA_NUM", label: "QA: Count", title: "Number of contributing observations" },
  { value: "QA_CQM", label: "QA: Quality", title: "Composite quality map" },
];
const QUANTITY_ORDER = QUANTITIES.map((quantity) => quantity.value);

/* What each QA raster is, for the description under the ramp — where there is
 * room for the name that did not fit on a button. One line each: neither is a
 * composite of the measurement, so neither takes the compositing line, and
 * which way is better is the only thing the panel has to say about reading the
 * ramp. */
const QUANTITY_DETAIL = {
  QA_NUM: ["Number of contributing observations"],
  QA_CQM: ["Composite quality map (higher is better)"],
};

/* The same two, as they read inside a sentence — the status line when the
 * selected combination has no archive for the year on screen. */
const QUANTITY_NAMES = { QA_NUM: "observation count", QA_CQM: "composite quality map" };

/* The false-colour composite of the two polarizations, published pre-styled by
 * the store and read like any other archive. It has no QA raster of its own, so
 * selecting it disables both QA buttons and vice versa — the same rule that
 * disables any other combination nothing was published for. */
const FALSE_COLOUR = "RGB";
const isFalseColour = (layer) => layer !== null && layer.polarization === FALSE_COLOUR;

/* The swatch colour of each channel, red green blue, because that is what the
 * legend row is naming — a pixel is as red as its VV is high. */
const CHANNEL_SWATCHES = ["#e0524f", "#4c9f4c", "#5b8def"];

/* Crameri's scientific colour maps, which the manifest names as `cmc.<map>`.
 * The credit is per-layer because the map is. */
const COLOUR_MAP_CREDIT = {
  citation: "© Fabio Crameri",
  links: [{ label: "Scientific colour maps", url: "https://www.fabiocrameri.ch/colourmaps/" }],
};

const state = {
  manifest: null,
  /* `product|polarization|year` -> layer, keyed on the manifest's own composite
   * polarization. Built once; the controls ask "does this combination exist" on
   * every keystroke of the year slider. */
  index: new Map(),
  product: null,
  pol: null,
  quantity: MEASUREMENT,
  year: null,
  opacity: 1,
  added: new Set(),
  activeKey: null,
};

const layerId = (layer) => `glace-${layer.id}`;
const key = (product, polarization, year) => `${product}|${polarization}|${year}`;

/* ---------- the polarization field ---------- */

/* `VV_QA_NUM` is the QA-NUM raster of VV; `VV` is VV itself. Anchored to the
 * whole value and to the two roles that exist, so an unrecognised suffix stays
 * part of the polarization and is dropped by the allowlist rather than becoming
 * a fourth button nothing can draw. */
const QA_SUFFIX = /^(.+)_(QA_(?:NUM|CQM))$/;

function splitPolarization(value) {
  const at = QA_SUFFIX.exec(value);
  return at === null ? { pol: value, quantity: MEASUREMENT } : { pol: at[1], quantity: at[2] };
}

const joinPolarization = (pol, quantity) => (quantity === MEASUREMENT ? pol : `${pol}_${quantity}`);

const findLayer = (product, pol, quantity, year) =>
  state.index.get(key(product, joinPolarization(pol, quantity), year)) ?? null;

/** The layer the controls currently describe, or null where none was published. */
const selected = () => findLayer(state.product, state.pol, state.quantity, state.year);

/** The layer the current selection would name with some of its axes moved. */
function layerFor(overrides) {
  const at = { product: state.product, pol: state.pol, quantity: state.quantity, ...overrides };
  return findLayer(at.product, at.pol, at.quantity, state.year);
}

/* Which row moves out of the way when a click lands on a combination nothing
 * was published for.
 *
 * The clicked button always wins — pressing RGB shows RGB — so it is the *other*
 * row that gives, and it falls back to the leftmost of its values that can
 * follow: VV for a polarization, the measurement for a quantity. The store has
 * exactly one such pairing, the false colour crossed with a QA raster, and it is
 * mutual: there is no RGB QA layer and no QA false colour, so whichever of the
 * two is clicked sends the other back to its head.
 *
 * Product is deliberately absent. A product button goes dark when the year on
 * screen has no archive for it, which is a gap in the data rather than a
 * combination that cannot exist, and the honest answer there is to refuse the
 * click and leave the year where the reader put it. */
const GIVES_WAY = { pol: "quantity", quantity: "pol" };

/* What the other row would have to become for a click on (field, value) to land
 * on a layer, or undefined if nothing rescues it. Also the test for whether such
 * a button is offered at all — see syncControls(). */
function fallbackFor(field, value) {
  const other = GIVES_WAY[field];
  if (other === undefined) return undefined;
  const axis = other === "pol" ? state.manifest.polarizations : state.manifest.quantities;
  return axis.find((candidate) => layerFor({ [field]: value, [other]: candidate }) !== null);
}

/* ---------- manifest ---------- */

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isNonEmptyString = (value) => typeof value === "string" && value !== "";

/* Whether the panel has a control that can reach this entry at all. One whose
 * polarization is missing or not a string is left to validLayer(), which reports
 * it; one that names a real layer this page does not present — another
 * polarization, another QA role — is dropped without a word. */
function presented(layer) {
  if (!isNonEmptyString(layer?.polarization)) return true;
  const { pol, quantity } = splitPolarization(layer.polarization);
  return POLARIZATIONS.includes(pol) && QUANTITY_ORDER.includes(quantity);
}

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
    layer.colors.every(isNonEmptyString) &&
    // A ramp is how a single-band layer is drawn, so one is required of it. A
    // false-colour layer has three channels and no ramp at all, and the store
    // publishes it with `colors` empty.
    (layer.colors.length > 0 || isFalseColour(layer))
  );
}

export function validateManifest(raw) {
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw.layers)) {
    throw new Error("no layers array");
  }
  const layers = raw.layers.filter((layer) => {
    // Silent, unlike the warning below: this is not a complaint about the entry.
    if (!presented(layer)) return false;
    if (validLayer(layer)) return true;
    console.warn("layers.json: skipping malformed entry", layer);
    return false;
  });
  if (!layers.length) throw new Error("the manifest holds no usable layers");

  /* The manifest also names the products and the years, which is what orders
   * those controls. Those lists are honoured where they agree with the layers
   * and derived from the layers where they do not, so a manifest that lists a
   * product it has no archive for cannot produce a dead button. */
  const present = (field) => new Set(layers.map((layer) => layer[field]));
  const axis = (declared, field) => {
    const have = present(field);
    const kept = Array.isArray(declared) ? declared.filter((value) => have.has(value)) : [];
    return kept.length === have.size ? kept : [...have];
  };

  /* The polarization axis is the one the manifest cannot declare usefully: its
   * own list mixes polarizations, QA roles and the channel recipe into one
   * field, and the panel spends them on two rows. Both are derived from the
   * layers and ordered by the lists above, so VV is the left-hand button and
   * the measurement the left-hand quantity whatever order the file used. */
  const split = layers.map((layer) => splitPolarization(layer.polarization));
  const polarizations = [...new Set(split.map((at) => at.pol))];
  const quantities = new Set(split.map((at) => at.quantity));

  return {
    layers,
    index: new Map(
      layers.map((layer) => [key(layer.product, layer.polarization, layer.year), layer]),
    ),
    products: axis(raw.products, "product"),
    polarizations: polarizations.sort((a, b) => POLARIZATIONS.indexOf(a) - POLARIZATIONS.indexOf(b)),
    quantities: QUANTITY_ORDER.filter((quantity) => quantities.has(quantity)),
    years: axis(raw.years, "year").sort((a, b) => a - b),
  };
}

/* ---------- map layers ---------- */

/* The wording the Copernicus terms ask for. It is per-year because each year is
 * its own source, and MapLibre only credits a source a visible layer is using —
 * so the line names the year on screen and disappears when no GLACE layer is
 * shown. `layer.year` is interpolated into markup, which is safe only because
 * validLayer() has already required it to be a finite number. */
const copernicus = (layer) =>
  `<a href="https://www.copernicus.eu/">Contains modified Copernicus Sentinel data ${layer.year}</a>`;

function ensureLayer(layer) {
  const id = layerId(layer);
  if (state.added.has(id)) return;
  map.addSource(id, {
    type: "raster",
    url: `pmtiles://${TILES_BASE}/${layer.url}`,
    tileSize: 256,
    minzoom: layer.min_zoom,
    maxzoom: layer.max_zoom,
    bounds: layer.bounds,
    attribution: copernicus(layer),
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

/* A raster source that cannot load says nothing on its own. MapLibre fires an
 * `error` event, the tile is never drawn, and the map just stays empty — which
 * is exactly how a broken tile protocol looks from the outside, and why one
 * went unnoticed until someone said the layer was missing.
 *
 * Only this page's own sources are reported, and only the first failure of
 * each: a viewport failing twenty tiles is one broken layer, not twenty
 * problems. A tile MapLibre cancelled is not a failure at all — panning away
 * from a tile in flight is the normal case. */
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

/* What the controls currently name, as it reads inside a sentence. */
function selectionName() {
  const quantity = QUANTITY_NAMES[state.quantity];
  const what = `${productLabel(state.product)} ${state.pol}`;
  return quantity ? `${what} ${quantity}` : `${what} layer`;
}

/* The panel updates immediately; the map catches up once the style is parsed.
 * Splitting it this way is what lets the controls respond during the seconds
 * the basemap takes to arrive instead of appearing to ignore the first click. */
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

/* Only the previously shown layer is hidden rather than every added one: at
 * most one raster is ever visible, so there is nothing else to turn off.
 * Repeated calls settle in order, so the last selection wins. */
async function showOnMap(active) {
  await styleReady;
  const wanted = active ? layerId(active) : null;
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

/* A ramp and its two ends, or three channels and what each one carries. Only
 * one of the two is ever shown, so the other is hidden rather than left holding
 * whatever the last layer put there. */
function updateLegend(layer) {
  const falseColour = isFalseColour(layer);
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

/* Three `{band, vmin, vmax}`, red green blue, or null where the manifest does
 * not carry them. Checked rather than trusted, like everything else that
 * reaches the page from a manifest — and descriptive rather than structural, so
 * an unusable one costs the layer its numbers and not its place on the map. It
 * is dropped silently for the same reason a half-written date is: nothing is
 * wrong with the layer. */
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
 * What each channel of a false-colour layer carries, and over what range.
 *
 * `channels` is the build's own record of what it baked into the archive — the
 * band in each slot and the stretch it was given — so where the manifest
 * publishes it, the legend reports what the tiles were actually made with. This
 * page holds no stretch of its own and no table keyed on the product: those
 * numbers belong to whatever rendered the archive, and a second copy here is a
 * second copy to get wrong.
 *
 * Where it is absent the bands can still be named but their ranges cannot.
 * Red and green are the two polarizations and blue is their ratio, written as a
 * difference wherever the layer is read in dB and a quotient otherwise — one
 * rule in two spellings, read off the manifest's own `units` rather than
 * assumed per product. The ranges are left blank: printing numbers the archive
 * was not necessarily built with is a guess dressed as a legend.
 *
 * @param {object} layer
 * @returns {{band: string, vmin?: number, vmax?: number}[]}
 */
export function falseColourChannels(layer) {
  const published = validChannels(layer.channels);
  if (published !== null) return published;
  return [{ band: "VV" }, { band: "VH" }, { band: layer.units === "dB" ? "VV − VH" : "VV / VH" }];
}

/* An ISO date as the manifest would carry it. Checked rather than trusted: the
 * manifest comes from wherever ?tiles= points, and a half-written date would
 * otherwise print as-is under the ramp. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (value) => isNonEmptyString(value) && ISO_DATE.test(value);

/* What sits under the colour ramp: what the layer is and the window it covers.
 *
 * A measurement names its product and how it was composited; a QA raster names
 * itself in one line instead — see QUANTITY_DETAIL.
 *
 * The acquisition window is the one part the manifest may not carry, so the
 * line appears on its own once `start_date` and `end_date` are there and is
 * silently skipped until then. Descriptive rather than structural, like
 * `cmap` — the layer draws identically without it, so it is not something
 * validLayer() should reject a real data layer over. */
export function layerDetail(layer) {
  const { quantity } = splitPolarization(layer.polarization);
  const lines =
    quantity === MEASUREMENT
      ? [
          ...(PRODUCT_DETAIL[layer.product] ?? [`${productLabel(layer.product)} composite`]),
          COMPOSITING_DETAIL,
        ]
      : [...QUANTITY_DETAIL[quantity]];
  if (isDate(layer.start_date) && isDate(layer.end_date)) {
    lines.push(`${layer.start_date} to ${layer.end_date}`);
  }
  return lines;
}

/* Rebuilt only when the colour map changes rather than on every render: the
 * button owns a hover popover, and replacing it under the pointer would drop
 * the box the reader is reading. */
let shownColourMap = null;

function updateColourMapCredit(layer) {
  const cmap = isNonEmptyString(layer.cmap) ? layer.cmap.replace(/^cmc\./, "") : "";
  if (cmap === shownColourMap) return;
  shownColourMap = cmap;
  el("legend-credit").replaceChildren(
    ...(cmap
      ? [creditButton("Colour map", { ...COLOUR_MAP_CREDIT, title: `Colormap: ${cmap}` })]
      : []),
  );
}

/* ---------- controls ---------- */

/* A combination only exists for some years, and some do not exist at all — the
 * false colour has no QA raster, and a QA raster has no false colour. Either
 * way the button goes grey rather than disappearing, so the control does not
 * reflow while scrubbing. The button that is currently selected is never greyed
 * — it describes the view, so it has to stay lit even where moving *to* it
 * would be impossible.
 *
 * Grey means two different things, and the difference is whether the click is
 * accepted. A combination that cannot exist is still *reachable*: pressing it
 * moves the row that gives way (see GIVES_WAY) and shows what the button names,
 * so it carries `aria-disabled` and stays live. A combination the year simply
 * has no archive for is refused outright, with `disabled`, since there is
 * nothing to move. */
function syncControls() {
  for (const [node, field] of [
    [el("product"), "product"],
    [el("quantity"), "quantity"],
    [el("pol"), "pol"],
  ]) {
    for (const button of node.children) {
      const value = button.dataset.value;
      const chosen = state[field] === value;
      const grey = !chosen && layerFor({ [field]: value }) === null;
      const reachable = grey && fallbackFor(field, value) !== undefined;
      button.setAttribute("aria-checked", String(chosen));
      button.disabled = grey && !reachable;
      if (reachable) button.setAttribute("aria-disabled", "true");
      else button.removeAttribute("aria-disabled");
    }
  }
  el("year-value").textContent = state.year;
  el("year").value = state.manifest.years.indexOf(state.year);
}

function initControls(manifest) {
  const select = (field) => (value) => {
    state[field] = value;
    // The click won; if nothing was published for what it now names, the other
    // row follows it rather than the map going empty.
    if (selected() === null) {
      const fallback = fallbackFor(field, value);
      if (fallback !== undefined) state[GIVES_WAY[field]] = fallback;
    }
    render();
  };
  buildSegmented(
    el("product"),
    manifest.products.map((product) => ({ value: product, label: productLabel(product) })),
    select("product"),
  );

  /* Only shown when there is a choice: a manifest published before the QA
   * rasters offers one quantity, and a radio group with a single button is
   * furniture, not a control. */
  buildSegmented(
    el("quantity"),
    QUANTITIES.filter((quantity) => manifest.quantities.includes(quantity.value)),
    select("quantity"),
  );
  el("quantity-row").hidden = manifest.quantities.length < 2;

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
  el("layer-info").replaceChildren();
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
  state.index = manifest.index;

  /* The head of each axis rather than whatever the first layer happens to be,
   * so the page opens on the leftmost button of each control — the measurement
   * and VV included. If that combination has no archive, fall back to one that
   * does rather than opening on an empty map. */
  state.product = manifest.products[0];
  state.pol = manifest.polarizations[0];
  state.quantity = manifest.quantities[0];
  state.year = manifest.years[manifest.years.length - 1];
  if (!selected()) {
    const wanted = joinPolarization(state.pol, state.quantity);
    const fallback =
      manifest.layers.find(
        (layer) => layer.product === state.product && layer.polarization === wanted,
      ) ?? manifest.layers[0];
    const { pol, quantity } = splitPolarization(fallback.polarization);
    state.product = fallback.product;
    state.pol = pol;
    state.quantity = quantity;
    state.year = fallback.year;
  }

  initControls(manifest);
  render();
  return manifest;
}
