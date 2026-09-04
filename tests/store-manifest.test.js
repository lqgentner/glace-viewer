/*
 * The GLACE store's own `layers.json`, as published.
 *
 * `layers-store.json` is one year of it copied verbatim from
 * https://data.source.coop/lqgentner/glace-ch, so this file is where the page
 * meets the manifest the store actually writes rather than one written to suit
 * it. The load-bearing thing about that manifest, and it is not obvious from the
 * code alone: its `polarization` axis carries seven values, not two. A
 * polarization, a QA role and a channel recipe all share the one field, and the
 * panel splits it back into the two rows a reader chooses from.
 *
 * Its own file because the modules hold state at module scope and the map is a
 * singleton, so a second manifest needs a second process.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { captureWarnings, installBrowser, load, REPO, settle } from "./helpers/browser.js";

const FIXTURE = path.join(REPO, "tests", "fixtures", "layers-store.json");
const raw = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

const MANIFESTS = {
  "tiles/layers.json": FIXTURE,
  "data/inventories.json": path.join(REPO, "data", "inventories.json"),
};

const buttons = (el, id) => Object.fromEntries([...el(id).children].map((b) => [b.dataset.value, b]));

const page = installBrowser({ files: MANIFESTS });
const { el } = page;

/* Loading the page is what proves nothing is dropped: a warning here would mean
 * the page is calling a layer the store published correctly malformed. */
const warnings = await captureWarnings(async () => {
  await load("js/app.js");
  page.map.fire("style.load");
  await settle();
});

const pick = async (row, value) => {
  buttons(el, row)[value].click();
  await settle();
};

test("the store's manifest loads without complaint", () => {
  assert.deepEqual(warnings, [], "every entry is one the panel has a control for");
});

test("the seven-value polarization axis becomes two rows", () => {
  assert.equal(raw.polarizations.length, 7);
  assert.deepEqual(
    [...el("pol").children].map((b) => b.dataset.value),
    ["VV", "VH", "RGB"],
  );
  // The measurement is the absence of a suffix, so its value is the empty
  // string — `data-value` carries the manifest's own spelling throughout.
  assert.deepEqual(
    [...el("quantity").children].map((b) => b.dataset.value),
    ["", "QA_NUM", "QA_CQM"],
  );
  assert.equal(el("quantity-row").hidden, false, "there is more than one to choose from");

  // 14 entries in, and every one of them reachable: 2 products x (2 x 3 + RGB).
  assert.equal(raw.layers.length, 14);
  assert.deepEqual(
    [...el("product").children].map((b) => b.dataset.value),
    ["COH12", "RTC"],
  );
});

test("the page opens on the measurement, not on a QA raster", () => {
  const { map } = page;
  assert.equal(buttons(el, "quantity")[""].getAttribute("aria-checked"), "true");
  assert.ok(map.getLayer("glace-coh12_vv_2024")?.layout.visibility === "visible");
});

test("a QA raster is its own archive, drawn in the same slot", async () => {
  const { map } = page;
  await pick("quantity", "QA_NUM");

  assert.equal(
    map.getSource("glace-coh12_vv_qa_num_2024").url,
    "pmtiles://tiles/2024/pmtiles/coh12_vv_qa_num.pmtiles",
  );
  assert.equal(map.getLayer("glace-coh12_vv_qa_num_2024").layout.visibility, "visible");
  assert.equal(
    map.getLayer("glace-coh12_vv_2024").layout.visibility,
    "none",
    "the measurement is hidden rather than torn down",
  );
  assert.ok(map.indexOf("glace-coh12_vv_qa_num_2024") < map.indexOf("places"));
});

test("a QA raster brings its own ramp, stretch and colour-map credit", async () => {
  await pick("quantity", "QA_NUM");
  assert.equal(el("legend-min").textContent, "0.0");
  assert.equal(el("legend-max").textContent, "30.0");
  assert.deepEqual(
    [...el("layer-info").children].map((line) => line.textContent),
    ["Number of contributing observations", "2024-07-09 to 2024-10-05"],
  );

  await pick("quantity", "QA_CQM");
  // A diverging ramp, ±6 dB about the composite's own weighting.
  assert.equal(el("legend-min").textContent, "-6.0 dB");
  assert.equal(el("legend-max").textContent, "6.0 dB");
  assert.deepEqual(
    [...el("layer-info").children].map((line) => line.textContent),
    ["Composite quality map (higher is better)", "2024-07-09 to 2024-10-05"],
  );

  el("legend-credit").querySelector("button.credit").click();
  const popover = page.window.document.querySelector(".credit-popover");
  assert.match(popover.textContent, /Colormap: vik/, "the QA layer's own map, not the measurement's");
  el("legend-credit").querySelector("button.credit").click();
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
  assert.equal(page.map.getLayer("glace-coh12_rgb_2024").layout.visibility, "visible");
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
  assert.equal(page.map.getLayer("glace-coh12_vv_qa_num_2024").layout.visibility, "visible");
});

test("the false colour names its channels instead of showing a ramp", async () => {
  await pick("pol", "RGB");
  assert.equal(el("legend-bar").hidden, true, "there is no ramp to show");
  assert.equal(el("legend-channels").hidden, false);

  const cells = [...el("legend-channels").children].map((node) => node.textContent);
  assert.deepEqual(cells.filter(Boolean), ["VV", "VH", "VV / VH"]);
  // The store publishes no `channels` yet, so the build's three stretches are
  // nowhere the page can read them. It names the bands and stops.
  assert.ok(!cells.some((text) => text.includes("to")), "no numbers this page cannot vouch for");
  assert.equal(
    page.map.getSource("glace-coh12_rgb_2024").url,
    "pmtiles://tiles/2024/pmtiles/coh12_rgb.pmtiles",
    "the pre-styled archive the store publishes",
  );

  // Backscatter's third channel is a difference, because it is read in dB.
  await pick("product", "RTC");
  assert.ok(
    [...el("legend-channels").children].some((node) => node.textContent === "VV − VH"),
  );
});

test("going back to a single-band layer restores the ramp", async () => {
  await pick("product", "COH12");
  await pick("pol", "VV");
  assert.equal(el("legend-bar").hidden, false);
  assert.equal(el("legend-channels").hidden, true);
  assert.equal(el("legend-min").textContent, "0.10");
  assert.equal(el("legend-max").textContent, "0.80");
});

test("every combination the store published is reachable", async () => {
  const { map } = page;
  for (const product of ["COH12", "RTC"]) {
    await pick("product", product);
    for (const pol of ["VV", "VH"]) {
      await pick("pol", pol);
      for (const [quantity, suffix] of [["", ""], ["QA_NUM", "_qa_num"], ["QA_CQM", "_qa_cqm"]]) {
        await pick("quantity", quantity);
        const id = `glace-${product.toLowerCase()}_${pol.toLowerCase()}${suffix}_2024`;
        assert.equal(el("status").hidden, true, id);
        assert.equal(map.getLayer(id)?.layout.visibility, "visible", id);
      }
    }
  }
  // The twelve above, plus the two false-colour archives the tests before this
  // one selected: a layer is created once and kept, so this is every entry the
  // store published for the year and nothing besides.
  assert.equal(
    [...map.layers.keys()].filter((id) => id.startsWith("glace-")).length,
    raw.layers.length,
  );
});
