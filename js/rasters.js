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
 * A layer may exist as a second archive of the same measurement: the float COG
 * the PMTiles were styled from, named as a `cog` beside the `url` or derived
 * from it. The two are different renderings of one measurement, not two
 * datasets, so they share every control and are chosen between with one more
 * segmented button — see the tile-source note below.
 */

import { recipeTiles, setRecipe } from "./cog-rgb.js";
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
 * It is an allowlist as well as an order. The store names more in this one
 * field than the panel has a row for — the QA diagnostics (`VV_QA_NUM`,
 * `VV_QA_CQM`, …) — so a polarization, a QA role and a channel recipe all share
 * an axis. Those are well-formed layers this page has no control for yet, and
 * they are dropped in validateManifest() rather than left to validLayer(),
 * which would report each one as malformed over something that is not wrong
 * with it.
 *
 * `RGB` is not a polarization either, but it is a layer a reader picks from
 * this same row, so it sits at the end of it. */
const POLARIZATIONS = ["VV", "VH", "RGB"];

/* The false-colour composite of the two polarizations above.
 *
 * It reaches the map two ways, and that is the point of it being here. The
 * store publishes a pre-styled archive of it, and it can equally be computed
 * from the two single-band mosaics it was rendered from — one archive read by
 * the PMTiles source, two COGs stacked by ours. Same layer, same controls. */
const FALSE_COLOUR = "RGB";
const isFalseColour = (layer) => layer !== null && layer.polarization === FALSE_COLOUR;

/* What each channel carries, and over what range.
 *
 * Red and green are the two polarizations, and their stretches come from those
 * layers' own manifest entries, so they match what the single-band views show.
 * Blue is the ratio of the two, written the way the product is read: a quotient
 * for coherence, which is read linearly, and a difference for backscatter,
 * which is read in dB — where a difference of logs is the log of the quotient,
 * so it is one rule in two spellings.
 *
 * Blue's stretch is this page's to choose: the manifest publishes a vmin/vmax
 * per single-band layer, and the false-colour entry's own pair describes only
 * its red channel. Measured at native resolution — §5 of the store plan is
 * explicit that a decimated read averages SAR speckle away and reports a range
 * about three times too narrow — over 619 958 valid pixels of the 2024
 * mosaics:
 *
 *   COH12   VV ÷ VH    p2 0.76   p50 1.39   p98 2.63
 *   RTC     VV − VH    p2 3.50   p50 6.73   p98 11.03   (dB)
 *
 * A product with no entry here has no false colour, and its RGB button stays
 * dark rather than the page inventing a range for it. */
const FALSE_COLOUR_BLUE = {
  COH12: { label: "VV / VH", range: [0.75, 2.75] },
  RTC: { label: "VV − VH", range: [3.5, 11] },
};

/* The two ways one layer can reach the map.
 *
 *   pmtiles  pre-styled RGBA: the ramp and the stretch were applied by the
 *            build, the browser decodes WEBP and draws it.
 *   cog      the float GeoTIFF itself, range-read and coloured per tile in the
 *            browser — one archive through a ramp, or two combined into false
 *            colour. See js/cog-rgb.js.
 *
 * Both are given the same ramp and the same stretch, so the switch compares two
 * ways of arriving at a pixel and nothing else. The order is the preference
 * order: `pmtiles` is what a deployment has always published, so it is what the
 * page opens on when a layer offers both. */
const SOURCE_ORDER = ["pmtiles", "cog"];
const SOURCE_LABELS = { pmtiles: "PMTiles", cog: "COG" };

/* Crameri's scientific colour maps, which the manifest names as `cmc.<map>`.
 * The credit is per-layer because the map is. */
const COLOUR_MAP_CREDIT = {
  citation: "© Fabio Crameri",
  links: [{ label: "Scientific colour maps", url: "https://www.fabiocrameri.ch/colourmaps/" }],
};

const state = {
  manifest: null,
  /* `product|polarization|year` -> layer. Built once; the controls ask "does
   * this combination exist" on every keystroke of the year slider. */
  index: new Map(),
  product: null,
  pol: null,
  year: null,
  source: SOURCE_ORDER[0],
  opacity: 1,
  added: new Set(),
  activeKey: null,
};

/* The source is part of the id because both archives of one layer can be on the
 * map at once — added lazily, kept once added — and MapLibre ids are global. */
const layerId = (layer, source) => `glace-${source}-${layer.id}`;
const key = (product, pol, year) => `${product}|${pol}|${year}`;
const findLayer = (product, pol, year) => state.index.get(key(product, pol, year)) ?? null;

/* ---------- manifest ---------- */

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isNonEmptyString = (value) => typeof value === "string" && value !== "";

/* Whether the panel has a control that can reach this entry at all. One whose
 * polarization is missing or not a string is left to validLayer(), which reports
 * it; one that names a real layer this page does not present yet is dropped
 * without a word — see POLARIZATIONS. */
const presented = (layer) =>
  !isNonEmptyString(layer?.polarization) || POLARIZATIONS.includes(layer.polarization);

/* Where a layer's COG lives, or null if it has none.
 *
 * The store publishes each year's mosaics twice under one stem — the pre-styled
 * archive at `{year}/pmtiles/{stem}.pmtiles`, and the float COG it was styled
 * from at `{year}/mosaics/{stem}.tif` — so one href is derivable from the other.
 * That is what lets the switch work against a `layers.json` naming only the
 * first, which is what the store writes today. An explicit `cog` still wins, so
 * a manifest that grows one needs no change here.
 *
 * The pattern is anchored to the whole href rather than substituting a
 * substring, so it fails closed: a manifest laid out any other way yields no COG
 * at all, rather than a `.tif` beside an archive that was never published. That
 * is what keeps the button dark for the false-colour layers, which are
 * PMTiles-only by design, and for the flat pre-store manifests, which have no
 * COGs to offer. */
const PMTILES_HREF = /^(.*\/)pmtiles\/([^/]+)\.pmtiles$/;

function cogHref(layer) {
  if (isNonEmptyString(layer.cog)) return layer.cog;
  const at = isNonEmptyString(layer.url) ? PMTILES_HREF.exec(layer.url) : null;
  return at === null ? null : `${at[1]}mosaics/${at[2]}.tif`;
}

/* The recipe behind a false-colour layer, or null where it cannot be built.
 *
 * A false-colour entry names its own pre-styled archive and nothing else, so
 * the two files this page would stack are found the way a reader would find
 * them: the VV and VH layers of the same product and year. Every one of them
 * has to be there, with a COG, and the product has to have a blue stretch —
 * otherwise there is no recipe and the button stays dark.
 *
 * `index` is passed rather than read off `state` because validateManifest()
 * needs an answer before there is any state to read. */
function falseColourRecipe(layer, index) {
  const blue = FALSE_COLOUR_BLUE[layer.product];
  if (blue === undefined) return null;
  const red = index.get(key(layer.product, "VV", layer.year)) ?? null;
  const green = index.get(key(layer.product, "VH", layer.year)) ?? null;
  if (red === null || green === null) return null;
  const redCog = cogHref(red);
  const greenCog = cogHref(green);
  if (redCog === null || greenCog === null) return null;
  return {
    archives: [archiveUrl(redCog), archiveUrl(greenCog)],
    // Both polarizations of one product are read in the same domain, so the
    // red layer answers for all three channels.
    decibel: red.units === "dB",
    channels: {
      red: [red.vmin, red.vmax],
      green: [green.vmin, green.vmax],
      blue: blue.range,
    },
  };
}

/* Whether an entry carries the archives a source reads. `pmtiles` is required
 * of every layer by validLayer(); the COG side is not, and for a false-colour
 * layer it is two files rather than one, so the answer varies layer by layer
 * and the control has to be able to disable a button. */
const hasSource = (layer, source, index) => {
  if (layer === null) return false;
  if (source === "pmtiles") return true;
  return isFalseColour(layer)
    ? falseColourRecipe(layer, index) !== null
    : cogHref(layer) !== null;
};

/* A manifest that parses as JSON is not yet a manifest this page can draw. It
 * is fetched from wherever ?tiles= points, which is a genuine trust boundary,
 * and a structurally valid but incomplete entry would otherwise fail much later
 * as an undefined read somewhere inside MapLibre. Malformed entries are dropped
 * with a warning rather than taking the whole page down: one broken year should
 * not cost the other twenty.
 *
 * The COG is not among the requirements, named or derived. A layer draws from
 * its PMTiles archive whether or not one was published beside it, so its absence
 * costs the layer a button rather than its place on the map — the same reason
 * `cmap` and the acquisition dates are not required either. */
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

  /* The axes are display order as well as content, so polarization is sorted
   * rather than taken as declared. Every layer that got this far names one of
   * POLARIZATIONS, so this is a total order rather than a partial one. */
  const polRank = (pol) => POLARIZATIONS.indexOf(pol);

  /* Built here rather than by the caller because the sources axis below needs
   * to look a layer's siblings up while the manifest is still being validated. */
  const index = new Map(
    layers.map((layer) => [key(layer.product, layer.polarization, layer.year), layer]),
  );

  return {
    layers,
    index,
    products: axis(raw.products, "product"),
    polarizations: axis(raw.polarizations, "polarization").sort((a, b) => polRank(a) - polRank(b)),
    years: axis(raw.years, "year").sort((a, b) => a - b),
    /* Derived from the layers rather than declared, because unlike the other
     * three axes this one is not a naming decision the build makes — it is
     * simply which archives were published. A manifest nobody has built COGs
     * for reports one source, and the control never appears. */
    sources: SOURCE_ORDER.filter((source) =>
      layers.some((layer) => hasSource(layer, source, index)),
    ),
  };
}

/* ---------- map layers ---------- */

/* The archive URL, resolved against the page. `tilesBase` defaults to a relative
 * "tiles", and the protocol hands the string to geotiff.js rather than letting
 * the document resolve it, so it has to be absolute. */
const archiveUrl = (href) => new URL(`${TILES_BASE}/${href}`, location.href).href;

/* A single-band layer's recipe: one archive through the ramp the legend draws.
 *
 * The same three values the PMTiles build baked into its RGBA — the colour
 * stops, the stretch, and whether the layer is read in dB — so the two sources
 * differ in how a pixel gets its colour and in nothing else. That is what makes
 * the switch a controlled comparison rather than two pictures. */
function rampRecipe(layer) {
  const href = cogHref(layer);
  if (href === null) return null;
  return {
    archives: [archiveUrl(href)],
    decibel: layer.units === "dB",
    ramp: { range: [layer.vmin, layer.vmax], colors: layer.colors },
  };
}

/* The wording the Copernicus terms ask for. It is per-year because each year is
 * its own source, and MapLibre only credits a source a visible layer is using —
 * so the line names the year on screen and disappears when no GLACE layer is
 * shown. `layer.year` is interpolated into markup, which is safe only because
 * validLayer() has already required it to be a finite number. */
const copernicus = (layer) =>
  `<a href="https://www.copernicus.eu/">Contains modified Copernicus Sentinel data ${layer.year}</a>`;

function sourceSpec(layer, source) {
  /* Both COG layers go through the same protocol — one archive and a ramp, or
   * two and a channel recipe. The recipe is registered against the layer's own
   * id and the source names that id; see js/cog-rgb.js.
   *
   * Bounds and zoom range are declared from the manifest here, where the
   * PMTiles source could leave them to the archive header. A `tiles:` template
   * carries no TileJSON for MapLibre to read them out of, and having the
   * protocol answer for them would mean opening the archives before a tile is
   * wanted, which is exactly the work that should wait. */
  if (source === "cog") {
    const id = layerId(layer, source);
    setRecipe(id, isFalseColour(layer) ? falseColourRecipe(layer, state.index) : rampRecipe(layer));
    return {
      type: "raster",
      tiles: [recipeTiles(id)],
      tileSize: 256,
      minzoom: layer.min_zoom,
      maxzoom: layer.max_zoom,
      bounds: layer.bounds,
      attribution: copernicus(layer),
    };
  }
  return {
    type: "raster",
    url: `pmtiles://${TILES_BASE}/${layer.url}`,
    tileSize: 256,
    minzoom: layer.min_zoom,
    maxzoom: layer.max_zoom,
    bounds: layer.bounds,
    attribution: copernicus(layer),
  };
}

function ensureLayer(layer, source) {
  const id = layerId(layer, source);
  if (state.added.has(id)) return;
  map.addSource(id, sourceSpec(layer, source));
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

/* The panel updates immediately; the map catches up once the style is parsed.
 * Splitting it this way is what lets the controls respond during the seconds
 * the basemap takes to arrive instead of appearing to ignore the first click. */
function render() {
  const active = findLayer(state.product, state.pol, state.year);
  /* A layer with no COG beside it is still a layer: it draws from PMTiles and
   * disables the COG button, rather than the map going blank because the reader
   * left the switch somewhere the next year cannot follow. */
  const source = hasSource(active, state.source, state.index) ? state.source : SOURCE_ORDER[0];
  if (active) {
    updateLegend(active, source);
    clearStatus(STATUS_KEY);
  } else {
    el("layer-info").replaceChildren();
    setStatus(
      STATUS_KEY,
      `No ${productLabel(state.product)} ${state.pol} layer for ${state.year}`,
      "info",
    );
  }
  syncControls(source);
  showOnMap(active, source);
}

/* Only the previously shown layer is hidden rather than every added one: at
 * most one raster is ever visible, so there is nothing else to turn off.
 * Repeated calls settle in order, so the last selection wins. */
async function showOnMap(active, source) {
  await styleReady;
  const wanted = active ? layerId(active, source) : null;
  if (state.activeKey && state.activeKey !== wanted) {
    map.setLayoutProperty(state.activeKey, "visibility", "none");
    state.activeKey = null;
  }
  if (!active) return;
  ensureLayer(active, source);
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
function updateLegend(layer, source) {
  const falseColour = isFalseColour(layer);
  el("legend-bar").hidden = falseColour;
  el("legend-labels").hidden = falseColour;
  el("legend-channels").hidden = !falseColour;

  if (falseColour) {
    updateChannelLegend(layer, source);
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

/* The swatch is in the channel's own colour, because that is what the row is
 * naming — a pixel is as red as its VV is high.
 *
 * The ranges are shown only where this page set them. On the pre-styled archive
 * the build chose the stretch and did not publish what it chose, so printing
 * numbers there would be a guess dressed as a legend. */
function updateChannelLegend(layer, source) {
  const recipe = source === "cog" ? falseColourRecipe(layer, state.index) : null;
  const unit = unitSuffix(layer);
  const rows = [
    ["#e0524f", "VV", recipe?.channels.red],
    ["#4c9f4c", "VH", recipe?.channels.green],
    ["#5b8def", FALSE_COLOUR_BLUE[layer.product]?.label ?? "VV / VH", recipe?.channels.blue],
  ];
  el("legend-channels").replaceChildren(
    ...rows.flatMap(([colour, band, range]) => [
      h("span", { class: "swatch", style: { background: colour } }),
      h("span", { class: "band", textContent: band }),
      h("span", {
        textContent: range ? `${round(range[0], range[1] - range[0])} to ${round(range[1], range[1] - range[0])}${unit}` : "",
      }),
    ]),
  );
}

/* An ISO date as the manifest would carry it. Checked rather than trusted: the
 * manifest comes from wherever ?tiles= points, and a half-written date would
 * otherwise print as-is under the ramp. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (value) => isNonEmptyString(value) && ISO_DATE.test(value);

/* What sits under the colour ramp: what the layer is, how it was composited,
 * and the window it covers.
 *
 * The acquisition window is the one part the manifest may not carry. The
 * mosaics upstream record it as COMPOSITE_START_DATE / COMPOSITE_END_DATE
 * GeoTIFF tags, but the manifest writer does not copy them through yet, so the
 * line appears on its own once `start_date` and `end_date` are there and is
 * silently skipped until then. Descriptive rather than structural, like
 * `cmap` — the layer draws identically without it, so it is not something
 * validLayer() should reject a real data layer over. */
export function layerDetail(layer) {
  const lines = [...(PRODUCT_DETAIL[layer.product] ?? [`${productLabel(layer.product)} composite`])];
  lines.push(COMPOSITING_DETAIL);
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

/* A product/polarization combination only exists for some years; the buttons
 * that would leave the current year empty are disabled rather than hidden, so
 * the control does not reflow while scrubbing. The button that is currently
 * selected is never disabled — it describes the view, so it has to stay lit
 * even where moving *to* it would be impossible.
 *
 * `source` is the argument rather than `state.source` because the two can
 * differ: the reader's standing choice is remembered across layers, and a layer
 * with no COG beside it draws from PMTiles regardless. The control reports what
 * is on screen. */
function syncControls(source) {
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

  /* The source control disables on availability alone, with no exception for
   * the selection: unlike the axes above, an unavailable source is not what the
   * map is showing, so lighting its button would be a lie. */
  const shown = findLayer(state.product, state.pol, state.year);
  for (const button of el("source").children) {
    const value = button.dataset.value;
    button.setAttribute("aria-checked", String(source === value));
    button.disabled = !hasSource(shown, value, state.index);
  }
  el("year-value").textContent = state.year;
  el("year").value = state.manifest.years.indexOf(state.year);
}

function initControls(manifest) {
  const select = (field) => (value) => {
    state[field] = value;
    render();
  };
  buildSegmented(
    el("product"),
    manifest.products.map((product) => ({ value: product, label: productLabel(product) })),
    select("product"),
  );
  buildSegmented(el("pol"), manifest.polarizations, select("pol"));

  /* Only shown when there is a choice. One source is the normal case — a
   * deployment publishes PMTiles and nothing else — and a radio group with a
   * single button is furniture, not a control. */
  buildSegmented(
    el("source"),
    manifest.sources.map((source) => ({ value: source, label: SOURCE_LABELS[source] ?? source })),
    select("source"),
  );
  el("source-row").hidden = manifest.sources.length < 2;

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
   * so the page opens on the leftmost button of each control — VV included.
   * If that combination has no archive, fall back to one that does rather than
   * opening on an empty map. */
  state.product = manifest.products[0];
  state.pol = manifest.polarizations[0];
  state.year = manifest.years[manifest.years.length - 1];
  state.source = manifest.sources[0];
  if (!findLayer(state.product, state.pol, state.year)) {
    const fallback =
      manifest.layers.find(
        (layer) => layer.product === state.product && layer.polarization === state.pol,
      ) ?? manifest.layers[0];
    state.product = fallback.product;
    state.pol = fallback.polarization;
    state.year = fallback.year;
  }

  initControls(manifest);
  render();
  return manifest;
}
