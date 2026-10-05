/*
 * The inline-editable legend against the two-year fixture: color-map choice,
 * limits, reset, and per-layer memory. A separate process gives it a fresh map.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { installBrowser, load, REPO, settle } from "./helpers/browser.js";

const fixture = (name) => path.join(REPO, "tests", "fixtures", "two-years", name);
const page = installBrowser({
  files: {
    "http://localhost/tiles/mosaics/collection.json": fixture("collection.json"),
    "http://localhost/tiles/mosaics/style.json": fixture("style.json"),
    "http://localhost/tiles/mosaics/2022/item.json": fixture("item-2022.json"),
    "http://localhost/tiles/mosaics/2023/item.json": fixture("item-2023.json"),
    "data/inventories.json": path.join(REPO, "data", "inventories.json"),
  },
});
const { el, window } = page;
await load("js/app.js");
// The harness exposes the map the modules built, so read it after loading them.
const { map } = page;
map.fire("style.load");
await settle();
const { COLOR_MAPS } = await load("js/colormaps.js");

const ID = "glace-coh12_vv-2023";
/* Positions and colors of a color-relief ramp, past the two nodata stops. */
const ramp = (id) => {
  const stops = map.getLayer(id).paint["color-relief-color"].slice(3);
  return { first: stops[4], firstColor: stops[5], last: stops.at(-2) };
};
const change = async (input, value) => {
  input.value = value;
  input.dispatchEvent(new window.Event("change"));
  await settle();
};
const pick = async (row, value) => {
  [...el(row).children].find((b) => b.dataset.value === value).click();
  await settle();
};

test("the scale names its default color map and shows plain limits", () => {
  assert.equal(el("cmap").textContent, "lipari");
  assert.equal(el("vmin").value, "0.10");
  assert.equal(el("vmax").value, "0.75");
  assert.equal(el("range-reset").hidden, true);
  assert.equal(el("legend-credit"), null, "the credit button is gone");
  assert.equal(el("recolor"), null, "and so is the old recolor row");
});

test("the color-map popover lists the curated maps and recolors the layer", async () => {
  el("cmap").click();
  const options = [...window.document.querySelectorAll(".cmap-popover .cmap-option")];
  assert.equal(options.length, 11);
  assert.deepEqual(
    options.filter((o) => o.getAttribute("aria-pressed") === "true").map((o) => o.textContent),
    ["lipari"],
  );
  options.find((o) => o.textContent === "batlow").click();
  await settle();
  assert.equal(window.document.querySelector(".cmap-popover"), null, "picking closes it");
  assert.equal(el("cmap").textContent, "batlow");
  assert.ok(el("cmap").classList.contains("modified"));
  assert.equal(ramp(ID).firstColor, COLOR_MAPS["cmc.batlow"][0]);
  assert.equal(el("range-reset").hidden, false);
});

test("limits apply on change, accept a comma, and revert when invalid", async () => {
  await change(el("vmin"), "0,2");
  assert.equal(ramp(ID).first, 0.2);
  assert.equal(el("vmin").value, "0.20");
  assert.ok(el("vmin").classList.contains("modified"));
  assert.equal(el("vmax").classList.contains("modified"), false, "the untouched limit is not");

  await change(el("vmax"), "0.1");
  assert.equal(el("vmax").value, "0.75", "an inverted range reverts");
  assert.equal(ramp(ID).last, 0.75);

  await change(el("vmin"), "abc");
  assert.equal(el("vmin").value, "0.20", "so does text");

  await change(el("vmin"), "-1");
  assert.equal(el("vmin").value, "0.20", "and a limit below what the archive encodes");

  await change(el("vmax"), "1.5");
  assert.equal(el("vmax").value, "0.75", "or above it");
  assert.equal(ramp(ID).last, 0.75);
});

test("Escape reverts a limit being typed", async () => {
  el("vmin").focus();
  el("vmin").value = "0.5";
  el("vmin").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  await settle();
  assert.equal(el("vmin").value, "0.20");
});

test("render never overwrites a focused limit", async () => {
  el("vmax").focus();
  el("vmax").value = "0.6";
  el("opacity").value = "50";
  el("opacity").dispatchEvent(new window.Event("input"));
  await settle();
  assert.equal(el("vmax").value, "0.6");
  el("vmax").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  el("vmax").blur();
});

test("choices belong to their layer: kept across years, separate per product", async () => {
  el("year").value = "0";
  el("year").dispatchEvent(new window.Event("input"));
  await settle();
  assert.equal(el("cmap").textContent, "batlow", "2022 keeps the coherence choice");
  assert.equal(el("vmin").value, "0.20");

  await pick("product", "RTC");
  assert.equal(el("cmap").textContent, "grayC", "backscatter keeps its own default");
  assert.equal(el("range-reset").hidden, true);

  await pick("product", "COH12");
  el("range-reset").click();
  await settle();
  assert.equal(el("cmap").textContent, "lipari");
  assert.equal(el("vmin").value, "0.10");
  assert.equal(el("range-reset").hidden, true);
});

test("false color shows channels and nothing to edit", async () => {
  await pick("pol", "RGB");
  assert.equal(el("cmap").hidden, true);
  assert.equal(el("legend-labels").hidden, true);
  assert.equal(el("range-reset").hidden, true);
  assert.equal(el("readout").hidden, true);
  await pick("pol", "VV");
  assert.equal(el("cmap").hidden, false);
});
