/*
 * The catalog's tile grid: one vector PMTiles archive under the catalog root,
 * drawn through the pmtiles:// protocol like the inventories.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { captureWarnings, installBrowser, load, REPO, settle } from "./helpers/browser.js";

const page = installBrowser({
  files: {
    "data/inventories.json": path.join(REPO, "data", "inventories.json"),
  },
});
const { el, change } = page;

await load("js/app.js");
const { map } = page;
map.fire("style.load");
await settle();

test("the overlay reads the catalog's grid archive and its mgrs layer", async () => {
  change(el("grid"), true);
  await settle();

  const source = map.getSource("grid");
  assert.equal(source.type, "vector");
  assert.equal(source.url, "pmtiles://tiles/tiles/grid.pmtiles", "under the catalog root");
  // A wrong source-layer draws nothing and reports no error.
  for (const id of ["grid-fill", "grid-line"]) assert.equal(map.getLayer(id)["source-layer"], "mgrs");
  map.settle();
  await settle();
  assert.doesNotMatch(el("status").textContent, /tile grid/, "nothing left to report once it loads");
});

test("the grid sits above the relief and under the basemap labels", () => {
  assert.ok(map.indexOf("hillshade") < map.indexOf("grid-fill"));
  assert.ok(map.indexOf("grid-line") < map.indexOf("places"));
});

test("ticking it off and on again keeps the one source", async () => {
  change(el("grid"), false);
  await settle();
  assert.equal(map.getLayer("grid-fill").layout.visibility, "none");
  change(el("grid"), true);
  await settle();
  assert.equal(map.getLayer("grid-fill").layout.visibility, "visible");
});

test("an unreadable archive unticks the box and logs why", async () => {
  const { grid } = await load("js/overlays.js");
  grid.remove();
  change(el("grid"), false);
  change(el("grid"), true);
  await settle();

  const warnings = await captureWarnings(async () => {
    map.fire("error", { sourceId: "grid", error: new Error("HTTP 404") });
    await settle();
  });

  assert.equal(el("grid").checked, false, "re-ticking is a fresh attempt, not a no-op");
  assert.equal(el("status").textContent, "Error loading the tile grid. Tick it again to retry.");
  assert.ok(warnings.some((line) => line.includes("HTTP 404")), "the detail goes to the console");
  assert.equal(map.getLayer("grid-fill"), undefined, "nothing half-added is left behind");
  assert.equal(map.getSource("grid"), undefined);

  change(el("grid"), true);
  await settle();
  assert.ok(map.getSource("grid"), "the second attempt is a fresh load");
});
