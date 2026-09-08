/*
 * The GLACE raster layers: the controls that select one of them, and the legend
 * that describes it.
 *
 * The layers are read out of the catalog by js/store.js, one record per
 * archive. Only the record on screen has a MapLibre source, and only records
 * that have been on screen keep one, so scrubbing through years stays instant.
 * Every layer is drawn from its pre-styled PMTiles archive; the COG reader in
 * js/cog-rgb.js is wired up but unused — see "The COG reader" in AGENTS.md.
 */

import { addStacked, map, styleReady } from "./map.js";
import { FALSE_COLOUR, isFiniteNumber, isNonEmptyString, readStore } from "./store.js";
import { buildSegmented, clearStatus, creditButton, el, h, setStatus } from "./ui.js";

const STATUS_KEY = "rasters";

/* The catalog names products the way the archives are named; the panel names
 * them the way a reader would. `data-value` keeps the catalog's spelling, so
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
 * the one to open on, so it belongs on the left whatever order the catalog
 * lists them in.
 *
 * It is an allowlist as well as an order. The `polarization` field carries more
 * than a polarization — see QUANTITIES below — so this list is matched against
 * what is left once the QA suffix has been taken off. Anything else (an HH/HV
 * build, a QA role this page has no row for) is dropped in indexLayers(), and
 * silently: such a layer is correct and merely unpresentable here.
 *
 * `RGB` is not a polarization either, but it is a layer a reader picks from
 * this same row, so it sits at the end of it. */
const POLARIZATIONS = ["VV", "VH", "RGB"];

/* The quantity a layer carries, which the catalog spells as a suffix on the
 * polarization: `VV` is the measurement itself, `VV_QA_NUM` and `VV_QA_CQM` the
 * two QA rasters the store publishes beside it. So the field names a
 * polarization, a QA role and a channel recipe all at once, and the panel
 * splits it back into the two rows a reader chooses from.
 *
 * The measurement is the *absence* of a suffix, which is why its value is the
 * empty string — `data-value` carries the catalog's own spelling here as
 * everywhere else, and its spelling for a measurement is nothing.
 *
 * The button faces are short because the row is three wide in a 292px panel;
 * the full names are on the buttons' own tooltips and under the colour ramp.
 * `title` is the button's tooltip and, for a QA raster, the one-line
 * description under the ramp; `name` is how it reads inside the status line. */
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

/* The swatch colour of each channel, red green blue, because that is what the
 * legend row is naming — a pixel is as red as its VV is high. */
const CHANNEL_SWATCHES = ["#e0524f", "#4c9f4c", "#5b8def"];

/* Crameri's scientific colour maps, which the style names as `cmc.<map>`.
 * The credit is per-layer because the map is. */
const COLOUR_MAP_CREDIT = {
  citation: "© Fabio Crameri",
  links: [{ label: "Scientific colour maps", url: "https://www.fabiocrameri.ch/colourmaps/" }],
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
  state.axes.index.get(key(product, joinPolarization(pol, quantity), year)) ?? null;

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
  const axis = other === "pol" ? state.axes.polarizations : state.axes.quantities;
  return axis.find((candidate) => layerFor({ [field]: value, [other]: candidate }) !== null);
}

/* ---------- the axes ---------- */

/* Whether the panel has a control that can reach this layer at all. A layer that
 * names a real archive this page does not present — another polarization,
 * another QA role — is dropped without a word: it is correct and merely
 * unpresentable here, so warning about each would be noise. Whether it can be
 * *drawn* is js/store.js's question, and answered before this one. */
function presented(layer) {
  const { pol, quantity } = splitPolarization(layer.polarization);
  return POLARIZATIONS.includes(pol) && QUANTITY_ORDER.includes(quantity);
}

/**
 * The layers the store published, arranged into the axes the panel offers.
 *
 * Every axis is derived from the layers themselves rather than declared
 * anywhere, so no control can be built for a combination that has no archive
 * behind it. Product and year keep the order the catalog listed them in — sorted
 * for the year, which is a number and a slider; the other two are ordered by the
 * lists above, so VV is the left-hand polarization and the measurement the
 * left-hand quantity whatever order the catalog used.
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
    /* `product|polarization|year` -> layer: the controls ask "does this
     * combination exist" on every keystroke of the year slider. */
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
  // The catalog's own style layer id, so the page's id and the catalog's cannot drift.
  const id = layer.id;
  if (state.added.has(id)) return;
  /* Neither `attribution` nor `bounds`: the archive carries both in its own
   * header, `pmtiles.Protocol({metadata: true})` puts them in the TileJSON, and
   * a spec that named either would override the archive rather than add to it.
   * The credit stays conditional and stays per year for the same reason as
   * before — each year is its own archive, and MapLibre credits a source only
   * while a visible layer uses it. The zooms are declared, since the style is
   * where the catalog states them. */
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
  const quantity = quantityOf(state.quantity)?.name;
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

/* A ramp and its two ends, or three channels and what each one carries. Only
 * one of the two is ever shown, so the other is hidden rather than left holding
 * whatever the last layer put there. */
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

/* Three `{band, vmin, vmax}`, red green blue, or null where the style does not
 * carry them. Checked rather than trusted, like everything else that reaches the
 * page from the catalog — and descriptive rather than structural, so
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
 * band in each slot and the stretch it was given — published in the style under
 * `metadata.portolan:legend`, the same block the build reads. So the legend
 * reports what the tiles were actually made with. This page holds no stretch of
 * its own and no table keyed on the product: those numbers belong to whatever
 * rendered the archive, and a second copy here is a second copy to get wrong.
 *
 * The store publishes them today. Where a store does not, the bands can still be
 * named but their ranges cannot: red and green are the two polarizations and
 * blue is their ratio, written as a difference wherever the layer is read in dB
 * and a quotient otherwise — one rule in two spellings, read off the layer's own
 * `units` rather than assumed per product. The ranges are left blank, because
 * printing numbers the archive was not necessarily built with is a guess dressed
 * as a legend.
 *
 * @param {object} layer
 * @returns {{band: string, vmin?: number, vmax?: number}[]}
 */
export function falseColourChannels(layer) {
  const published = validChannels(layer.channels);
  if (published !== null) return published;
  return [{ band: "VV" }, { band: "VH" }, { band: layer.units === "dB" ? "VV − VH" : "VV / VH" }];
}

/* An ISO date as js/store.js reads it off the year's STAC item. */
const isDate = (value) => isNonEmptyString(value) && /^\d{4}-\d{2}-\d{2}$/.test(value);

/* What sits under the colour ramp: what the layer is and the window it covers.
 *
 * A measurement names its product and how it was composited; a QA raster names
 * itself in one line instead — its `title` from QUANTITIES.
 *
 * The acquisition window is the one part that comes from a document of its own —
 * the year's STAC item — so the line appears once js/store.js could read that
 * item and is silently skipped when it could not. Descriptive rather than
 * structural, like `cmap`: the layer draws identically without it. */
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
  el("year").value = state.axes.years.indexOf(state.year);
}

function initControls(axes) {
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
    axes.products.map((product) => ({ value: product, label: productLabel(product) })),
    select("product"),
  );

  /* Only shown when there is a choice: a store published before the QA
   * rasters offers one quantity, and a radio group with a single button is
   * furniture, not a control. */
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

/* The rasters are the only part of the page that needs object storage. When the
 * catalog cannot be reached or cannot be understood, hide the controls that
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
  let axes;
  try {
    axes = indexLayers(await readStore());
  } catch (error) {
    noRasters(error.message);
    return null;
  }

  state.axes = axes;

  /* The head of each axis rather than whatever the first layer happens to be,
   * so the page opens on the leftmost button of each control — the measurement
   * and VV included. If that combination has no archive, fall back to one that
   * does rather than opening on an empty map. */
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
