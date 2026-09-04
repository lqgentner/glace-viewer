/*
 * The two pure functions behind the data the page cannot vouch for: the raster
 * manifest, fetched from wherever ?tiles= points, and the MGRS tile name that
 * arrives inside a vector tile.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { captureWarnings, installBrowser, load, REPO } from "./helpers/browser.js";

installBrowser();
const { falseColourChannels, layerDetail, validateManifest } = await load("js/rasters.js");
const { utmZone } = await load("js/overlays.js");

const layer = (overrides = {}) => ({
  id: "coh12_vv_2023",
  product: "COH12",
  polarization: "VV",
  year: 2023,
  url: "coh12_vv_2023.pmtiles",
  bounds: [4.2, 43.2, 16.9, 48.6],
  min_zoom: 5,
  max_zoom: 12,
  vmin: 0.1,
  vmax: 0.8,
  colors: ["#031326", "#fdf5da"],
  ...overrides,
});

test("the committed manifest is accepted whole", { skip: skipWithoutManifest() }, async () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO, "tiles", "layers.json"), "utf8"));
  const manifest = validateManifest(raw);
  assert.equal(manifest.layers.length, raw.layers.length);
  assert.deepEqual(manifest.products, raw.products);
  // The polarization axis is reordered rather than taken as declared, so that
  // the page opens on VV. The set has to match; the order deliberately need not.
  assert.deepEqual(manifest.polarizations, ["VV", "VH"]);
  assert.deepEqual([...manifest.polarizations].sort(), [...raw.polarizations].sort());
});

test("a manifest with nothing usable in it is refused", async () => {
  for (const raw of [null, {}, [], { layers: {} }, { layers: [] }]) {
    assert.throws(() => validateManifest(raw), /layers/, `for ${JSON.stringify(raw)}`);
  }
  await captureWarnings(() => {
    assert.throws(() => validateManifest({ layers: [{ id: "x" }] }), /no usable layers/);
  });
});

test("a malformed entry is dropped, not fatal", async () => {
  // One broken year should not cost the other twenty.
  let manifest;
  const warnings = await captureWarnings(() => {
    manifest = validateManifest({ layers: [layer(), { id: "broken" }, layer({ id: "b", year: 2024 })] });
  });
  assert.equal(manifest.layers.length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /skipping malformed entry/);
});

test("every structural field the page reads is checked", async () => {
  const broken = {
    "missing id": { id: undefined },
    "empty id": { id: "" },
    "missing url": { url: undefined },
    "missing product": { product: undefined },
    "missing polarization": { polarization: undefined },
    "year as a string": { year: "2023" },
    "non-finite vmin": { vmin: Number.NaN },
    "bounds too short": { bounds: [1, 2, 3] },
    "bounds not numbers": { bounds: [1, 2, 3, "4"] },
    "no colours": { colors: [] },
    "colours not strings": { colors: [1, 2] },
    "zoom as a string": { min_zoom: "5" },
    // A source with these inverted cannot draw, and a degenerate or backwards
    // stretch would render the ramp meaninglessly.
    "inverted zoom range": { min_zoom: 12, max_zoom: 5 },
    "inverted value range": { vmin: 0.8, vmax: 0.1 },
    "empty value range": { vmin: 0.5, vmax: 0.5 },
  };
  for (const [name, overrides] of Object.entries(broken)) {
    await captureWarnings(() => {
      assert.throws(
        () => validateManifest({ layers: [layer(overrides)] }),
        /no usable layers/,
        name,
      );
    });
  }
});

test("years are sorted so the slider runs forwards", () => {
  const layers = [2024, 2019, 2021].map((year) => layer({ id: `l${year}`, year }));
  assert.deepEqual(validateManifest({ layers }).years, [2019, 2021, 2024]);
  // Also when the manifest declared them out of order.
  assert.deepEqual(validateManifest({ layers, years: [2024, 2021, 2019] }).years, [2019, 2021, 2024]);
});

test("a declared axis naming something absent cannot make a dead button", () => {
  const manifest = validateManifest({
    layers: [layer()],
    products: ["COH12", "RTC"],
    polarizations: ["VV", "VH"],
  });
  assert.deepEqual(manifest.products, ["COH12"]);
  assert.deepEqual(manifest.polarizations, ["VV"]);
});

test("a declared axis that agrees with the layers keeps its order", () => {
  const layers = [layer(), layer({ id: "rtc", product: "RTC" })];
  // First-seen order would be COH12 then RTC; the manifest asked for the reverse.
  assert.deepEqual(validateManifest({ layers, products: ["RTC", "COH12"] }).products, [
    "RTC",
    "COH12",
  ]);
});

test("a missing axis is derived from the layers", () => {
  const layers = [layer(), layer({ id: "rtc", product: "RTC" })];
  assert.deepEqual(validateManifest({ layers }).products, ["COH12", "RTC"]);
  assert.deepEqual(validateManifest({ layers, products: "COH12" }).products, ["COH12", "RTC"]);
});

test("the polarization field is split into a polarization and a quantity", () => {
  // The store spells a QA raster as a suffix on the polarization, so one field
  // feeds two rows. The measurement is the absence of a suffix.
  const layers = [
    layer(),
    layer({ id: "num", polarization: "VV_QA_NUM" }),
    layer({ id: "cqm", polarization: "VH_QA_CQM" }),
  ];
  const manifest = validateManifest({ layers });
  assert.equal(manifest.layers.length, 3);
  assert.deepEqual(manifest.polarizations, ["VV", "VH"]);
  assert.deepEqual(manifest.quantities, ["", "QA_NUM", "QA_CQM"]);
});

test("the quantity axis follows what was published, in the panel's order", () => {
  // Declared order cannot reach it: the manifest names these inside the
  // polarization axis, mixed in with the polarizations themselves.
  assert.deepEqual(validateManifest({ layers: [layer()] }).quantities, [""]);
  assert.deepEqual(
    validateManifest({
      layers: [layer({ id: "cqm", polarization: "VV_QA_CQM" }), layer({ id: "num", polarization: "VV_QA_NUM" })],
      polarizations: ["VV_QA_CQM", "VV_QA_NUM"],
    }).quantities,
    ["QA_NUM", "QA_CQM"],
  );
});

test("a QA role the panel has no row for is dropped without a word", async () => {
  // Silently, unlike a malformed entry: it is a correct layer this page has no
  // control for, not a broken one. Same for a polarization off the allowlist.
  const warnings = await captureWarnings(() => {
    const manifest = validateManifest({
      layers: [layer(), layer({ id: "odd", polarization: "VV_QA_LIA" }), layer({ id: "hh", polarization: "HH" })],
    });
    assert.deepEqual(manifest.layers.map((entry) => entry.id), ["coh12_vv_2023"]);
  });
  assert.deepEqual(warnings, []);
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
    falseColourChannels(layer({ polarization: "RGB", units: "dB", channels })),
    channels,
  );
});

test("without them it names the bands and quotes no range", () => {
  // Which way the ratio is written follows the manifest's own `units`, not a
  // table keyed on the product: a difference in dB, a quotient otherwise.
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

/** The raster manifest is a local build artefact; skip rather than fail without it. */
function skipWithoutManifest() {
  return fs.existsSync(path.join(REPO, "tiles", "layers.json"))
    ? false
    : "tiles/layers.json is absent (build or symlink ./tiles first)";
}

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

test("the acquisition window is shown once the manifest carries it", () => {
  // Not in layers.json yet: the mosaics upstream record it as
  // COMPOSITE_START_DATE / COMPOSITE_END_DATE, but the manifest writer does not
  // copy the tags through. The line appears the moment it does.
  const dated = layer({ start_date: "2023-06-01", end_date: "2023-09-30" });
  assert.deepEqual(layerDetail(dated).at(-1), "2023-06-01 to 2023-09-30");
  assert.equal(validateManifest({ layers: [dated] }).layers.length, 1, "and is not required");
});

test("a half-written or malformed window is dropped, not rendered", () => {
  // The manifest comes from wherever ?tiles= points; the defect this guards
  // against is "undefined to 2023-09-30" printed under the ramp.
  for (const overrides of [
    { start_date: "2023-06-01" },
    { end_date: "2023-09-30" },
    { start_date: null, end_date: null },
    { start_date: "2023-6-1", end_date: "2023-09-30" },
    { start_date: 20230601, end_date: 20230930 },
    { start_date: "", end_date: "" },
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
