/*
 * Exercise the page against fixtures converted from glace-catalog's
 * value-encoded catalog, with item geometry reduced and the collection's
 * archive links removed, as the catalog no longer writes them. Cover item/style
 * joins and the polarization and QA panel choices. A separate process isolates
 * the map singleton.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { captureWarnings, installBrowser, load, REPO, settle } from "./helpers/browser.js";

const FIXTURES = path.join(REPO, "tests", "fixtures", "store");

/* Where each document is looked for. The style and the item are reached through
 * the collection's own asset and links, so these URLs are the catalog's to
 * decide rather than this page's. */
const YEARS = [2021, 2022, 2023, 2024];
const items = new Map(
  YEARS.map((year) => [
    year,
    JSON.parse(fs.readFileSync(path.join(FIXTURES, `item-${year}.json`), "utf8")),
  ]),
);
const CATALOG = {
  "http://localhost/tiles/mosaics/collection.json": path.join(FIXTURES, "collection.json"),
  ...Object.fromEntries(
    YEARS.flatMap((year) => [
      [`http://localhost/tiles/mosaics/styles/${year}.json`, path.join(FIXTURES, `style-${year}.json`)],
      [`http://localhost/tiles/mosaics/${year}/item.json`, path.join(FIXTURES, `item-${year}.json`)],
    ]),
  ),
  "data/inventories.json": path.join(REPO, "data", "inventories.json"),
};

const buttons = (el, id) => Object.fromEntries([...el(id).children].map((b) => [b.dataset.value, b]));

const page = installBrowser({ files: CATALOG });
const { el } = page;

/* Loading the page is what proves nothing is dropped: a warning here would mean
 * the page is calling a layer the store published correctly unusable. */
const warnings = await captureWarnings(async () => {
  await load("js/app.js");
  page.map.fire("style.load");
  await settle();
});

const pick = async (row, value) => {
  buttons(el, row)[value].click();
  await settle();
};

/* Visual asset keys, such as coh12_vv_qa_num_viz, by year. */
const archives = [...items].flatMap(([year, item]) =>
  Object.entries(item.assets)
    .filter(([, asset]) => asset.roles.includes("visual"))
    .map(([key]) => ({ key, year })),
);

test("the store's catalog loads without complaint", () => {
  assert.deepEqual(warnings, [], "every archive is one the panel has a control for");
});

test("the six-value polarization field becomes two rows", () => {
  const fields = new Set(
    archives.map(({ key }) => /^[a-z0-9]+_(.+)_viz$/.exec(key)[1]),
  );
  assert.equal(fields.size, 6);

  assert.deepEqual(
    [...el("pol").children].map((b) => b.dataset.value),
    ["VV", "VH"],
  );
  // The measurement is the absence of a suffix, so its value is the empty
  // string — `data-value` carries the catalog's own spelling throughout.
  assert.deepEqual(
    [...el("quantity").children].map((b) => b.dataset.value),
    ["", "QA_NUM", "QA_CQM"],
  );
  assert.equal(el("quantity-row").hidden, false, "there is more than one to choose from");

  // 12 archives per year, 2 products x 2 x 3, over four published years.
  assert.equal(archives.length, 48);
  assert.deepEqual(
    [...el("product").children].map((b) => b.dataset.value),
    ["COH12", "RTC"],
  );
});

test("the page opens on the measurement, not on a QA raster", () => {
  const { map } = page;
  assert.equal(buttons(el, "quantity")[""].getAttribute("aria-checked"), "true");
  assert.equal(map.getLayer("glace-coh12_vv-2024")?.layout.visibility, "visible");
});

test("a source names the archive the item lists, and declares no bounds", () => {
  const source = page.map.getSource("glace-coh12_vv-2024");
  assert.equal(
    source.url,
    "pmtiles://http://localhost/tiles/mosaics/2024/coh12_vv_viz.pmtiles",
  );
  assert.deepEqual([source.minzoom, source.maxzoom], [5, 13], "the zooms the style states");
  // Both of these are in the archive's own header, and a spec that named either
  // would override it rather than add to it.
  assert.equal(source.bounds, undefined);
  assert.equal(source.attribution, undefined);
});

test("a QA raster is its own archive, drawn in the same slot", async () => {
  const { map } = page;
  await pick("quantity", "QA_NUM");

  assert.equal(
    map.getSource("glace-coh12_vv_qa_num-2024").url,
    "pmtiles://http://localhost/tiles/mosaics/2024/coh12_vv_qa_num_viz.pmtiles",
  );
  assert.equal(map.getLayer("glace-coh12_vv_qa_num-2024").layout.visibility, "visible");
  assert.equal(
    map.getLayer("glace-coh12_vv-2024").layout.visibility,
    "none",
    "the measurement is hidden rather than torn down",
  );
  assert.ok(map.indexOf("glace-coh12_vv_qa_num-2024") < map.indexOf("places"));
});

test("a QA raster brings its own ramp, stretch and color-map credit", async () => {
  await pick("quantity", "QA_NUM");
  // 0-80 rather than the observed 26-30 of recent years, and shared by both
  // products: 2021 reaches 58 because S1B was still flying, 2026 flies three
  // satellites, and one ceiling for every year and both products is what keeps
  // the difference legible.
  assert.equal(el("legend-min").textContent, "0.0");
  assert.equal(el("legend-max").textContent, "80.0");
  assert.deepEqual(
    [...el("layer-info").children].map((line) => line.textContent),
    ["Number of contributing observations", "2024-07-09 to 2024-10-07"],
  );

  await pick("quantity", "QA_CQM");
  // A sequential ramp over the measured one-sided range: CQM is a composite
  // quality indicator where higher is better, and 0 dB is not a meaningful middle.
  assert.equal(el("legend-min").textContent, "-2.5 dB");
  assert.equal(el("legend-max").textContent, "8.0 dB");
  assert.deepEqual(
    [...el("layer-info").children].map((line) => line.textContent),
    ["Composite quality map (higher is better)", "2024-07-09 to 2024-10-07"],
  );

  el("legend-credit").querySelector("button.credit").click();
  const popover = page.window.document.querySelector(".credit-popover");
  assert.match(popover.textContent, /Colormap: glasgow/, "the QA layer's own map");
  el("legend-credit").querySelector("button.credit").click();
});

test("the acquisition window comes from the year's STAC item", () => {
  // The only thing read out of a third document, and the one field of it the
  // panel shows.
  const item = JSON.parse(fs.readFileSync(path.join(FIXTURES, "item-2024.json"), "utf8"));
  assert.equal(item.properties.start_datetime, "2024-07-09T00:00:00Z");
  assert.equal(item.properties.end_datetime, "2024-10-07T00:00:00Z");
});

test("every archive the store published is reachable", async () => {
  const { map } = page;
  for (const product of ["COH12", "RTC"]) {
    await pick("product", product);
    for (const pol of ["VV", "VH"]) {
      await pick("pol", pol);
      for (const [quantity, suffix] of [["", ""], ["QA_NUM", "_qa_num"], ["QA_CQM", "_qa_cqm"]]) {
        await pick("quantity", quantity);
        const id = `glace-${product.toLowerCase()}_${pol.toLowerCase()}${suffix}-2024`;
        assert.equal(el("status").hidden, true, id);
        assert.equal(map.getLayer(id)?.layout.visibility, "visible", id);
      }
    }
  }
  // The twelve above: a layer is created once and kept, so this is every archive
  // the item lists for the year the page sits on.
  assert.equal(
    [...map.layers.keys()].filter((id) => id.startsWith("glace-")).length,
    archives.filter(({ year }) => year === 2024).length,
  );
});
