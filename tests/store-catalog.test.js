/*
 * The page against the GLACE store's own catalog, as published.
 *
 * `tests/fixtures/store/` is copied from
 * https://data.source.coop/lqgentner/glace-ch — one year of the mosaics
 * collection, the MapLibre style it nominates, and that year's item, verbatim
 * but for the item's geometry, which is half a megabyte of outline the page
 * never reads. So this file is where the page meets the catalog the store
 * actually writes rather than one written to suit it.
 *
 * Two things are load-bearing and neither is obvious from the code alone. The
 * archive inventory is a set of `rel: "pmtiles"` links on the collection, while
 * everything about how one is *drawn* lives in the style beside it. And the
 * `polarization` half of each layer id carries seven values, not two: a
 * polarization, a QA role and a channel recipe share the one field, which the
 * panel splits back into the two rows a reader chooses from.
 *
 * Its own file because the modules hold state at module scope and the map is a
 * singleton, so a second catalog needs a second process.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { captureWarnings, installBrowser, load, REPO, settle } from "./helpers/browser.js";

const FIXTURES = path.join(REPO, "tests", "fixtures", "store");
const collection = JSON.parse(fs.readFileSync(path.join(FIXTURES, "collection.json"), "utf8"));

/* Where each document is looked for. The style and the item are reached through
 * the collection's own asset and links, so these URLs are the catalog's to
 * decide rather than this page's. */
const CATALOG = {
  "http://localhost/tiles/mosaics/collection.json": path.join(FIXTURES, "collection.json"),
  "http://localhost/tiles/mosaics/styles/default.json": path.join(FIXTURES, "style.json"),
  "http://localhost/tiles/mosaics/2024/item.json": path.join(FIXTURES, "item-2024.json"),
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

const archives = collection.links.filter((link) => link.rel === "pmtiles");

test("the store's catalog loads without complaint", () => {
  assert.deepEqual(warnings, [], "every archive is one the panel has a control for");
});

test("the seven-value polarization field becomes two rows", () => {
  const fields = new Set(
    archives.map((link) => /^glace-[a-z0-9]+_(.+)-\d{4}$/.exec(link["pmtiles:layers"][0])[1]),
  );
  assert.equal(fields.size, 7);

  assert.deepEqual(
    [...el("pol").children].map((b) => b.dataset.value),
    ["VV", "VH", "RGB"],
  );
  // The measurement is the absence of a suffix, so its value is the empty
  // string — `data-value` carries the catalog's own spelling throughout.
  assert.deepEqual(
    [...el("quantity").children].map((b) => b.dataset.value),
    ["", "QA_NUM", "QA_CQM"],
  );
  assert.equal(el("quantity-row").hidden, false, "there is more than one to choose from");

  // 14 archives in, and every one of them reachable: 2 products x (2 x 3 + RGB).
  assert.equal(archives.length, 14);
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

test("a source names the archive the collection linked, and declares no bounds", () => {
  const source = page.map.getSource("glace-coh12_vv-2024");
  assert.equal(
    source.url,
    "pmtiles://https://data.source.coop/lqgentner/glace-ch/mosaics/pmtiles/2024/coh12_vv.pmtiles",
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
    "pmtiles://https://data.source.coop/lqgentner/glace-ch/mosaics/pmtiles/2024/coh12_vv_qa_num.pmtiles",
  );
  assert.equal(map.getLayer("glace-coh12_vv_qa_num-2024").layout.visibility, "visible");
  assert.equal(
    map.getLayer("glace-coh12_vv-2024").layout.visibility,
    "none",
    "the measurement is hidden rather than torn down",
  );
  assert.ok(map.indexOf("glace-coh12_vv_qa_num-2024") < map.indexOf("places"));
});

test("a QA raster brings its own ramp, stretch and colour-map credit", async () => {
  await pick("quantity", "QA_NUM");
  // 0-70 rather than the observed 26-30 of recent years, and shared by both
  // products: 2021 reaches 58 because S1B was still flying, and one ceiling for
  // every year and both products is what keeps the difference legible.
  assert.equal(el("legend-min").textContent, "0.0");
  assert.equal(el("legend-max").textContent, "70.0");
  assert.deepEqual(
    [...el("layer-info").children].map((line) => line.textContent),
    ["Number of contributing observations", "2024-07-09 to 2024-10-07"],
  );

  await pick("quantity", "QA_CQM");
  // A sequential ramp over ±3 dB: CQM is a composite quality indicator where
  // higher is better, not a quantity with a meaningful middle.
  assert.equal(el("legend-min").textContent, "-3.0 dB");
  assert.equal(el("legend-max").textContent, "3.0 dB");
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

test("the false colour and the QA rasters grey each other, but stay reachable", async () => {
  // The store publishes no RGB QA raster and no QA false colour. The button
  // still says so by going grey, but the click is accepted rather than refused:
  // whichever of the two is pressed wins, and the other row follows it.
  await pick("quantity", "QA_CQM");
  const rgb = buttons(el, "pol").RGB;
  assert.equal(rgb.getAttribute("aria-disabled"), "true", "greyed…");
  assert.equal(rgb.disabled, false, "…but live");
  assert.equal(buttons(el, "pol").VH.hasAttribute("aria-disabled"), false, "VH has a QA raster");

  await pick("pol", "RGB");
  assert.equal(buttons(el, "pol").RGB.getAttribute("aria-checked"), "true", "the click won");
  assert.equal(
    buttons(el, "quantity")[""].getAttribute("aria-checked"),
    "true",
    "and the quantity fell back to the measurement",
  );
  assert.equal(page.map.getLayer("glace-coh12_rgb-2024").layout.visibility, "visible");
});

test("and the other way round: a QA button pressed on false colour resets it", async () => {
  await pick("pol", "RGB");
  const count = buttons(el, "quantity").QA_NUM;
  assert.equal(count.getAttribute("aria-disabled"), "true");
  assert.equal(count.disabled, false);

  await pick("quantity", "QA_NUM");
  assert.equal(buttons(el, "quantity").QA_NUM.getAttribute("aria-checked"), "true");
  assert.equal(
    buttons(el, "pol").VV.getAttribute("aria-checked"),
    "true",
    "VV is the leftmost polarization that has one",
  );
  assert.equal(page.map.getLayer("glace-coh12_vv_qa_num-2024").layout.visibility, "visible");
});

test("the false colour names its channels and the stretch each was baked with", async () => {
  await pick("pol", "RGB");
  assert.equal(el("legend-bar").hidden, true, "there is no ramp to show");
  assert.equal(el("legend-channels").hidden, false);

  const cells = [...el("legend-channels").children].map((node) => node.textContent);
  // The build's own record of what went into each channel, published in the
  // style. This page holds no stretch of its own, so it is the only way numbers
  // reach that legend.
  assert.deepEqual(cells.filter(Boolean), [
    "COH12 VV",
    "0.10 to 0.80",
    "COH12 VH",
    "0.10 to 0.60",
    "VV / VH",
    "0.80 to 2.50",
  ]);
  assert.equal(
    page.map.getSource("glace-coh12_rgb-2024").url,
    "pmtiles://https://data.source.coop/lqgentner/glace-ch/mosaics/pmtiles/2024/coh12_rgb.pmtiles",
    "the pre-styled archive the store publishes",
  );

  // Backscatter's third channel is a difference, because it is read in dB.
  await pick("product", "RTC");
  assert.ok([...el("legend-channels").children].some((node) => node.textContent === "VV − VH"));
});

test("going back to a single-band layer restores the ramp", async () => {
  await pick("product", "COH12");
  await pick("pol", "VV");
  assert.equal(el("legend-bar").hidden, false);
  assert.equal(el("legend-channels").hidden, true);
  assert.equal(el("legend-min").textContent, "0.10");
  assert.equal(el("legend-max").textContent, "0.80");
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
  // The twelve above, plus the two false-colour archives the tests before this
  // one selected: a layer is created once and kept, so this is every archive the
  // collection links for the year and nothing besides.
  assert.equal(
    [...map.layers.keys()].filter((id) => id.startsWith("glace-")).length,
    archives.length,
  );
});
