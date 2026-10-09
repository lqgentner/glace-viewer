/*
 * State that outlives what it describes: a raster failure the panel forgets, a
 * legend for a layer that is not drawn, presets fitted to the view the map has
 * left, and a grid untick made while the grid is still loading. A separate
 * process gives it a fresh map and a grid that has never loaded.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { installBrowser, load, REPO, settle } from "./helpers/browser.js";

/* A hyparquet stand-in whose read waits for the test to release it. */
const gate = [];
globalThis.releaseGrid = () => gate.splice(0).forEach((resolve) => resolve());
const SLOW_HYPARQUET = `data:text/javascript,${encodeURIComponent(`
  export const asyncBufferFromUrl = async ({ url }) => ({ url });
  export async function parquetReadObjects() {
    await new Promise((resolve) => globalThis.gridGate(resolve));
    return [{
      "glace:mgrs_tile": "32TLR48",
      geometry: { type: "Polygon", coordinates: [[[7, 46], [7.1, 46], [7.1, 46.1], [7, 46]]] },
    }];
  }
`)}`;
globalThis.gridGate = (resolve) => gate.push(resolve);

const fixture = (name) => path.join(REPO, "tests", "fixtures", "two-years", name);
const page = installBrowser({
  files: {
    "http://localhost/tiles/mosaics/collection.json": fixture("collection.json"),
    "http://localhost/tiles/mosaics/style.json": fixture("style.json"),
    "http://localhost/tiles/mosaics/2022/item.json": fixture("item-2022.json"),
    "http://localhost/tiles/mosaics/2023/item.json": fixture("item-2023.json"),
    "data/inventories.json": path.join(REPO, "data", "inventories.json"),
  },
  site: { hyparquetUrl: SLOW_HYPARQUET },
});
const { el, change, input } = page;
await load("js/app.js");
const { map } = page;
map.fire("style.load");
await settle();
const { archive } = await load("js/archive.js");

const ID = "glace-coh12_vv-2023";
const off = (id) => el(id).getAttribute("aria-disabled") === "true";
const pick = async (row, value) => {
  el(row).querySelector(`[data-value="${value}"]`).click();
  await settle();
};

test("a raster failure stays reported when the opacity changes", async () => {
  map.fire("error", { sourceId: ID, error: new Error("HTTP 403") });
  assert.match(el("status").textContent, /could not be drawn — HTTP 403/);

  input(el("opacity"), "80");
  await settle();
  assert.match(el("status").textContent, /HTTP 403/, "nothing has recovered");

  map.fire("error", { sourceId: ID, error: new Error("HTTP 403") });
  input(el("opacity"), "100");
  await settle();

  await pick("pol", "VH");
  assert.equal(el("status").hidden, true, "another layer has no failure to report");
  await pick("pol", "VV");
  assert.match(el("status").textContent, /HTTP 403/, "the failed one still does");
});

test("presets wait for the recount after the map moves", async () => {
  // One z5 tile in view, as in legend.test.js.
  const lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - y / 16))) * 180) / Math.PI;
  const { getBounds } = map;
  const zoom = map.zoom;
  map.getBounds = () => ({ getWest: () => 0, getEast: () => 11.25, getSouth: () => lat(12), getNorth: () => lat(11) });
  map.zoom = 4;
  const tileOf = (code) => ({ data: new Uint8ClampedArray(400).fill(code).buffer });
  const reader = archive(map.getSource(ID).url.replace("pmtiles://", ""));
  const { getZxy } = reader;
  reader.getZxy = async (z) => (z === 5 ? tileOf(101) : undefined);
  try {
    el("legend-edit").click();
    await settle();
    assert.equal(off("range-extent"), false, "the first view is counted");

    // The map moves to where every value is code 201; the recount is pending.
    const pending = [];
    reader.getZxy = (z) => (z === 5 ? new Promise((resolve) => pending.push(resolve)) : Promise.resolve(undefined));
    map.fire("moveend");
    await settle();
    assert.ok(pending.length > 0, "the recount is waiting on its tile");

    el("range-extent").click();
    await settle();
    // Code 101 is 0.39; code 201 is 0.79.
    assert.notEqual(el("vmin-0").value, "0.39", "Min/Max did not fit the view the map left");
    assert.equal(off("range-extent"), true, "it waits for the recount");

    pending.splice(0).forEach((resolve) => resolve(tileOf(201)));
    await settle();
    assert.equal(off("range-extent"), false);
    el("range-extent").click();
    await settle();
    assert.equal(el("vmin-0").value, "0.79", "and then fits the view in front of it");
  } finally {
    Object.assign(map, { getBounds, zoom });
    reader.getZxy = getZxy;
    el("range-reset").click();
    el("scale-editor").close();
    await settle();
  }
});

test("a missing combination does not keep the previous layer's legend", async () => {
  await pick("product", "RTC");
  await pick("pol", "VH");
  input(el("year"), "0");
  await settle();
  assert.equal(el("status").textContent, "No Backscatter VH layer for 2022");
  assert.equal(el("legend").hidden, true, "no legend for a layer that is not drawn");
  input(el("year"), "1");
  await settle();
  assert.equal(el("legend").hidden, false, "and it returns with the layer");
  await pick("product", "COH12");
  await pick("pol", "VV");
});

test("unticking the grid while it loads keeps it off", async () => {
  change(el("grid"), true);
  await settle();
  assert.equal(gate.length, 1, "the index read is pending");
  change(el("grid"), false);
  await settle();

  globalThis.releaseGrid();
  await settle();
  // A layer without a visibility is drawn.
  const layer = map.getLayer("grid-fill");
  assert.ok(!layer || layer.layout?.visibility === "none", "the grid is not drawn with its box unticked");
});

test("ticking the grid off and on while it loads leaves it on", async () => {
  // Start again from an unloaded grid.
  const { grid } = await load("js/overlays.js");
  grid.remove();
  change(el("grid"), false);

  change(el("grid"), true);
  await settle();
  change(el("grid"), false);
  await settle();
  change(el("grid"), true);
  await settle();

  globalThis.releaseGrid();
  await settle();
  assert.equal(el("grid").checked, true, `the box stays ticked; status: ${el("status").textContent}`);
  assert.equal(map.getLayer("grid-fill")?.layout?.visibility, "visible", "and the grid is drawn");
  assert.doesNotMatch(el("status").textContent, /Tile grid unavailable/);
});
