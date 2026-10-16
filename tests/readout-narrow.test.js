/*
 * The value popup on a phone: low on the map it opens upward, clear of the
 * compact sheet. Its own file for a fresh narrow page.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { installBrowser, load, REPO, settle } from "./helpers/browser.js";

const fixture = (name) => path.join(REPO, "tests", "fixtures", "two-years", name);
const page = installBrowser({
  narrow: true,
  files: {
    "http://localhost/tiles/mosaics/collection.json": fixture("collection.json"),
    "http://localhost/tiles/mosaics/style.json": fixture("style.json"),
    "http://localhost/tiles/mosaics/2022/item.json": fixture("item-2022.json"),
    "http://localhost/tiles/mosaics/2023/item.json": fixture("item-2023.json"),
    "data/inventories.json": path.join(REPO, "data", "inventories.json"),
  },
});
const { el, popups, window } = page;

// The sheet is 500 px tall, 90 px of it showing; the viewport 844 px.
const stub = (node, name, value) =>
  Object.defineProperty(node, name, { configurable: true, writable: true, value });
stub(el("panel-shell"), "offsetHeight", 500);
stub(el("panel-nav"), "offsetHeight", 90);
stub(window, "innerHeight", 844);

/* Every tile reads code 101, so any click has a value to show. */
globalThis.pmtiles.PMTiles = class {
  constructor(source) { this.source = source; }
  async getHeader() { return { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 }; }
  async getZxy() {
    return { data: new Uint8ClampedArray(Array(4).fill([101, 101, 101, 255]).flat()).buffer };
  }
};

await load("js/app.js");
const { map } = page;
map.fire("style.load");
await settle();
map.zoom = 8;

/* A single click waits 250 ms for a second. */
const pause = () => new Promise((resolve) => setTimeout(resolve, 300));
async function clickAt(y) {
  page.window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  popups.length = 0;
  map.fire("click", { point: { x: 100, y }, lngLat: { lng: 8, lat: 46.5 } });
  await pause();
  await settle();
  assert.equal(popups.length, 1, "the click opened a popup");
  return popups[0].options.anchor;
}

test("a popup low on a phone's map opens upward, above the sheet", async () => {
  // Half of the 754 px the compact sheet leaves is 377.
  assert.equal(await clickAt(500), "bottom");
  assert.equal(await clickAt(200), undefined, "higher up, MapLibre chooses");
});
