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
const { legendDetail, validateManifest } = await load("js/rasters.js");
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
  assert.deepEqual(manifest.polarizations, raw.polarizations);
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

test("descriptive fields are optional, and cost only their own fragment", () => {
  // size_bytes and cmap are captions: the layer draws identically without them,
  // so a manifest that omits one must not lose the layer.
  const bare = layer({ size_bytes: undefined, cmap: undefined });
  assert.equal(validateManifest({ layers: [bare] }).layers.length, 1);
  assert.equal(legendDetail(bare), "COH12 VV 2023 · z5–12");
});

test("a descriptive field that is present but unusable is dropped, not rendered", () => {
  // The defect this replaces rendered "NaN MB · undefined" into the panel.
  for (const overrides of [
    { size_bytes: undefined, cmap: undefined },
    { size_bytes: null, cmap: null },
    { size_bytes: "63916106", cmap: 42 },
    { size_bytes: Number.NaN, cmap: "" },
    { size_bytes: -1, cmap: undefined },
  ]) {
    const detail = legendDetail(layer(overrides));
    assert.doesNotMatch(detail, /NaN|undefined|null/, JSON.stringify(overrides));
  }
});

test("the legend line reads as one caption when everything is present", () => {
  assert.equal(
    legendDetail(layer({ size_bytes: 63_916_106, cmap: "cmc.lipari" })),
    "COH12 VV 2023 · z5–12 · 63.9 MB · cmc.lipari",
  );
  // A zero-byte archive is a real number, not a missing one.
  assert.match(legendDetail(layer({ size_bytes: 0 })), /0\.0 MB/);
});
