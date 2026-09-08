/*
 * The pure functions behind the data the page cannot vouch for: the layers the
 * catalog published, arranged into the axes the panel offers, and the MGRS tile
 * name that arrives inside a vector tile.
 *
 * Whether a layer can be *drawn* is js/store.js's question — see store.test.js.
 * What is asked here is whether the panel has a control that reaches it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { captureWarnings, installBrowser, load } from "./helpers/browser.js";

installBrowser();
const { falseColourChannels, indexLayers, layerDetail } = await load("js/rasters.js");
const { utmZone } = await load("js/overlays.js");

/* One record as js/store.js hands it over. */
const layer = (overrides = {}) => ({
  id: "glace-coh12_vv-2023",
  product: "COH12",
  polarization: "VV",
  year: 2023,
  url: "https://tiles.example/glace/mosaics/pmtiles/2023/coh12_vv.pmtiles",
  minZoom: 5,
  maxZoom: 12,
  cmap: "cmc.lipari",
  vmin: 0.1,
  vmax: 0.8,
  units: "",
  colors: ["#031326", "#fdf5da"],
  ...overrides,
});

test("a catalog with nothing this panel can reach is refused", () => {
  // Not a complaint about the layers: they may be perfectly good ones this page
  // has no row for. But a panel with no reachable layer is no panel.
  assert.throws(() => indexLayers([]), /no published layer/);
  assert.throws(() => indexLayers([layer({ polarization: "HH" })]), /no published layer/);
});

test("years are sorted so the slider runs forwards", () => {
  const layers = [2024, 2019, 2021].map((year) => layer({ id: `l${year}`, year }));
  assert.deepEqual(indexLayers(layers).years, [2019, 2021, 2024]);
});

test("products keep the order the catalog listed them in", () => {
  const layers = [layer({ id: "rtc", product: "RTC" }), layer()];
  assert.deepEqual(indexLayers(layers).products, ["RTC", "COH12"]);
});

test("every axis is derived, so no control can name a missing archive", () => {
  const axes = indexLayers([layer()]);
  assert.deepEqual(axes.products, ["COH12"]);
  assert.deepEqual(axes.polarizations, ["VV"]);
  assert.deepEqual(axes.years, [2023]);
});

test("the polarization field is split into a polarization and a quantity", () => {
  // The catalog spells a QA raster as a suffix on the polarization, so one field
  // feeds two rows. The measurement is the absence of a suffix.
  const axes = indexLayers([
    layer(),
    layer({ id: "num", polarization: "VV_QA_NUM" }),
    layer({ id: "cqm", polarization: "VH_QA_CQM" }),
  ]);
  assert.equal(axes.layers.length, 3);
  assert.deepEqual(axes.polarizations, ["VV", "VH"]);
  assert.deepEqual(axes.quantities, ["", "QA_NUM", "QA_CQM"]);
});

test("both rows are ordered by the panel, not by the catalog", () => {
  // VV is the button to open on, and the measurement the quantity to open on,
  // whatever order the archives were listed in.
  const axes = indexLayers([
    layer({ id: "rgb", polarization: "RGB", colors: [] }),
    layer({ id: "cqm", polarization: "VH_QA_CQM" }),
    layer({ id: "vh", polarization: "VH" }),
    layer({ id: "num", polarization: "VV_QA_NUM" }),
    layer(),
  ]);
  assert.deepEqual(axes.polarizations, ["VV", "VH", "RGB"]);
  assert.deepEqual(axes.quantities, ["", "QA_NUM", "QA_CQM"]);
});

test("a QA role the panel has no row for is dropped without a word", async () => {
  // Silently: it is a correct layer this page has no control for, not a broken
  // one. Same for a polarization off the allowlist.
  const warnings = await captureWarnings(() => {
    const axes = indexLayers([
      layer(),
      layer({ id: "odd", polarization: "VV_QA_LIA" }),
      layer({ id: "hh", polarization: "HH" }),
    ]);
    assert.deepEqual(axes.layers.map((entry) => entry.id), ["glace-coh12_vv-2023"]);
  });
  assert.deepEqual(warnings, []);
});

test("a layer is found by product, polarization and year together", () => {
  const axes = indexLayers([layer(), layer({ id: "b", year: 2022 })]);
  assert.equal(axes.index.get("COH12|VV|2022").id, "b");
  assert.equal(axes.index.get("COH12|VV|2021"), undefined);
});

test("a false colour reports the channels the build published", () => {
  // The one record of what was baked into the archive. The page holds no
  // stretch of its own, so this is the only way numbers reach that legend.
  const channels = [
    { band: "VV", vmin: -18.5, vmax: -5 },
    { band: "VH", vmin: -26, vmax: -11 },
    { band: "VV − VH", vmin: 4, vmax: 14 },
  ];
  assert.deepEqual(
    falseColourChannels(layer({ polarization: "RGB", colors: [], units: "dB", channels })),
    channels,
  );
});

test("without them it names the bands and quotes no range", () => {
  // Which way the ratio is written follows the layer's own `units`, not a table
  // keyed on the product: a difference in dB, a quotient otherwise.
  assert.deepEqual(falseColourChannels(layer({ polarization: "RGB" })), [
    { band: "VV" },
    { band: "VH" },
    { band: "VV / VH" },
  ]);
  assert.deepEqual(falseColourChannels(layer({ polarization: "RGB", units: "dB" })).at(-1), {
    band: "VV − VH",
  });
});

test("a channel list the page cannot vouch for is dropped, not printed", () => {
  const good = { band: "VV", vmin: 0.1, vmax: 0.8 };
  for (const channels of [
    undefined,
    null,
    "VV,VH",
    [],
    [good, good],
    [good, good, good, good],
    [good, good, { band: "B", vmin: 1 }],
    [good, good, { band: "B", vmin: 2, vmax: 1 }],
    [good, good, { band: "B", vmin: 1, vmax: 1 }],
    [good, good, { band: "", vmin: 1, vmax: 2 }],
    [good, good, { band: "B", vmin: "1", vmax: 2 }],
    [good, good, null],
  ]) {
    const shown = falseColourChannels(layer({ polarization: "RGB", channels }));
    assert.deepEqual(
      shown.map((channel) => channel.vmin),
      [undefined, undefined, undefined],
      `for ${JSON.stringify(channels)}`,
    );
  }
});

test("UTM zone is read off an MGRS tile name", () => {
  assert.equal(utmZone("32TMS12"), "32N");
  assert.equal(utmZone("31TFJ68"), "31N");
  assert.equal(utmZone("1CAA00"), "1S", "a one-digit zone");
  assert.equal(utmZone("60XWK11"), "60N", "the last zone and band");
  assert.equal(utmZone("19FCV11"), "19S", "bands C-M are the southern hemisphere");
  assert.equal(utmZone("32NLS00"), "32N", "N is the first northern band");
  assert.equal(utmZone("32MLS00"), "32S", "M is the last southern one");
});

test("UTM zone declines rather than guessing", () => {
  // I and O are not MGRS bands: they are excluded to avoid 1/0 confusion.
  for (const tile of [null, undefined, "", "abc", "32ILS", "32OLS", "TMS12", "032TMS"]) {
    assert.equal(utmZone(tile), null, `for ${JSON.stringify(tile)}`);
  }
});

test("the description says what the product is and how it was composited", () => {
  assert.deepEqual(layerDetail(layer()), [
    "Composite Coherence",
    "12-day baseline",
    "Local resolution weighted median",
  ]);
  assert.deepEqual(layerDetail(layer({ product: "RTC" })), [
    "Composite Backscatter",
    "Radiometrically terrain corrected",
    "Local resolution weighted median",
  ]);
});

test("the acquisition window is shown once the year's item carries one", () => {
  const dated = layer({ startDate: "2023-06-01", endDate: "2023-09-30" });
  assert.deepEqual(layerDetail(dated).at(-1), "2023-06-01 to 2023-09-30");
  assert.equal(indexLayers([dated]).layers.length, 1, "and is not required");
});

test("a half-written or malformed window is dropped, not rendered", () => {
  // The catalog comes from wherever ?tiles= points; the defect this guards
  // against is "undefined to 2023-09-30" printed under the ramp.
  for (const overrides of [
    { startDate: "2023-06-01" },
    { endDate: "2023-09-30" },
    { startDate: null, endDate: null },
    { startDate: "2023-6-1", endDate: "2023-09-30" },
    { startDate: 20230601, endDate: 20230930 },
    { startDate: "", endDate: "" },
  ]) {
    const detail = layerDetail(layer(overrides));
    assert.equal(detail.length, 3, JSON.stringify(overrides));
    assert.doesNotMatch(detail.join(" "), /NaN|undefined|null|to /, JSON.stringify(overrides));
  }
});

test("a QA raster describes itself rather than the product it sits beside", () => {
  // One line each, and no compositing line: neither is a composite of the
  // measurement.
  assert.deepEqual(layerDetail(layer({ polarization: "VV_QA_NUM" })), [
    "Number of contributing observations",
  ]);
  assert.deepEqual(layerDetail(layer({ polarization: "VH_QA_CQM", product: "RTC" })), [
    "Composite quality map (higher is better)",
  ]);
});

test("an unknown product still describes itself rather than going blank", () => {
  assert.deepEqual(layerDetail(layer({ product: "COH6" })), [
    "COH6 composite",
    "Local resolution weighted median",
  ]);
});
