/*
 * The panel's choices in the query string: a shared link opens on them, and
 * changes write them back. A separate process gives it its own URL.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { installBrowser, load, REPO, settle } from "./helpers/browser.js";

const fixture = (name) => path.join(REPO, "tests", "fixtures", "two-years", name);
const page = installBrowser({
  search: "?tiles=tiles&year=2022&product=rtc&pol=vv&opacity=40&range=-20_0&base=imagery",
  files: {
    "http://localhost/tiles/mosaics/collection.json": fixture("collection.json"),
    "http://localhost/tiles/mosaics/style.json": fixture("style.json"),
    "http://localhost/tiles/mosaics/2022/item.json": fixture("item-2022.json"),
    "http://localhost/tiles/mosaics/2023/item.json": fixture("item-2023.json"),
    "data/inventories.json": path.join(REPO, "data", "inventories.json"),
  },
});
const { el } = page;
await load("js/app.js");
const { map } = page;
map.fire("style.load");
await settle();

const ID = "glace-rtc_vv-2022";
/* Writes are batched for 300 ms. */
const written = async () => {
  await new Promise((resolve) => setTimeout(resolve, 350));
  return Object.fromEntries(new URLSearchParams(page.window.location.search));
};
const checked = (row) => el(row).querySelector('[aria-checked="true"]').dataset.value;

test("a link opens on its year, layer, opacity, limits and basemap", async () => {
  assert.equal(map.getLayer(ID).layout.visibility, "visible");
  assert.deepEqual([checked("product"), checked("pol"), el("year-value").textContent], ["RTC", "VV", "2022"]);
  assert.equal(el("opacity").value, "40");
  assert.equal(el("opacity-value").textContent, "40%");
  assert.equal(map.getLayer(ID).paint["color-relief-opacity"], 0.4);
  assert.deepEqual([el("legend-min").textContent, el("legend-max").textContent], ["-20.0", "0.0"]);
  assert.equal(checked("basemap-style"), "imagery");
});

test("changes are written back, beside the deployment's own parameters", async () => {
  el("product").querySelector('[data-value="COH12"]').click();
  await settle();
  assert.deepEqual(await written(), {
    tiles: "tiles",
    year: "2022",
    product: "coh12",
    pol: "vv",
    opacity: "40",
    base: "imagery",
  }, "limits belong to the layer they were set on");

  el("product").querySelector('[data-value="RTC"]').click();
  el("basemap-style").querySelector('[data-value="vector"]').click();
  await settle();
  const params = await written();
  assert.equal(params.range, "-20_0", "and return with it");
  assert.equal(params.base, undefined);
});
