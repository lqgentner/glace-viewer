/*
 * The value popup on a phone: MapLibre keeps it clear of the sheet's visible
 * part and anchors it near an edge. Its own file for a fresh narrow page.
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

// The sheet is 500 px tall, 90 px of it showing.
const stub = (node, name, value) =>
  Object.defineProperty(node, name, { configurable: true, writable: true, value });
stub(el("panel-shell"), "offsetHeight", 500);
stub(el("panel-nav"), "offsetHeight", 90);

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
async function clickAt(x, y) {
  page.window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  popups.length = 0;
  map.fire("click", { point: { x, y }, lngLat: { lng: 8, lat: 46.5 } });
  await pause();
  await settle();
  assert.equal(popups.length, 1, "the click opened a popup");
  return popups[0].options;
}

test("a phone's popup keeps clear of the sheet and MapLibre anchors it", async () => {
  for (const [x, y] of [[100, 700], [100, 200], [4, 700], [386, 300]]) {
    const options = await clickAt(x, y);
    assert.equal(options.anchor, undefined, `MapLibre anchors the popup at ${x}, ${y}`);
    assert.deepEqual(options.padding, { bottom: 90 }, "the compact sheet's 90 px are padding");
  }
});
