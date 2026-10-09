/*
 * The value under a click: read from the pixel MapLibre draws, shown at the top
 * of the popup, VV and VH for false color. A separate process gives it a fresh
 * map and archive readers that serve the test's tiles.
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

/* Every reader serves `tileFor(url, z, x, y)`, set by each test. */
let tileFor = () => undefined;
const requested = [];
globalThis.pmtiles.PMTiles = class {
  constructor(source) { this.source = source; }
  async getHeader() { return { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 }; }
  getZxy(z, x, y) {
    requested.push([z, x, y]);
    return tileFor(this.source.getKey(), z, x, y);
  }
};

const { el, popups, window } = page;
await load("js/app.js");
const { map } = page;
map.fire("style.load");
await settle();

/* Two-by-two tiles of grey codes, top left, top right, bottom left, bottom right. */
const tile = (...codes) => ({
  data: new Uint8ClampedArray(codes.flatMap((code) => (code === null ? [0, 0, 0, 0] : [code, code, code, 255]))).buffer,
});
/* The [lng, lat] at fractions fx, fy across tile z/x/y. */
function inside(z, x, y, fx, fy) {
  const n = 2 ** z;
  const lng = ((x + fx) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + fy)) / n))) * 180) / Math.PI;
  return { lng, lat };
}
const escape = () =>
  page.window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
/* A single click waits 250 ms for a second; past that it is a click of its own. */
const pause = () => new Promise((resolve) => setTimeout(resolve, 300));
const fireClick = (lngLat) => map.fire("click", { point: { x: 10, y: 10 }, lngLat });
/* A click with no popup open, which a click with one open would only close. */
async function click(lngLat) {
  escape();
  popups.length = 0;
  fireClick(lngLat);
  await pause();
  await settle();
}
const shown = () => popups.map((popup) => popup.content.textContent);

// Map zoom 8 draws zoom 9 tiles; tile 9/267/180 lies in the Alps.
map.zoom = 8;
const AT = [9, 267, 180];

test("a click shows the drawn pixel's value at the top of the popup", async () => {
  requested.length = 0;
  // Coherence code c is (c - 1) / 254.
  tileFor = () => tile(11, 51, 101, 201);
  await click(inside(...AT, 0.25, 0.75));
  assert.deepEqual(requested.at(-1), AT, "the tile MapLibre draws at this zoom");
  assert.deepEqual(shown(), ["Coherence 2023VV: 0.39"], "bottom left, code 101");

  await click(inside(...AT, 0.75, 0.25));
  assert.deepEqual(shown(), ["Coherence 2023VV: 0.20"], "top right, code 51");
});

test("nothing drawn, nothing shown", async () => {
  tileFor = () => tile(null, null, null, null);
  await click(inside(...AT, 0.25, 0.25));
  assert.deepEqual(shown(), [], "nodata");

  tileFor = () => undefined;
  await click(inside(...AT, 0.25, 0.25));
  assert.deepEqual(shown(), [], "no tile");

  tileFor = () => tile(101, 101, 101, 101);
  map.zoom = 3;
  await click(inside(...AT, 0.25, 0.25));
  assert.deepEqual(shown(), [], "zoomed out past the archive's tiles");
  map.zoom = 8;
});

test("false color shows both polarizations", async () => {
  el("pol").querySelector('[data-value="RGB"]').click();
  await settle();
  tileFor = (url) => (url.includes("_vh") ? tile(51, 51, 51, 51) : tile(101, 101, 101, 101));
  await click(inside(...AT, 0.5, 0.5));
  assert.deepEqual(shown(), ["Coherence 2023VV: 0.39VH: 0.20"]);
  el("pol").querySelector('[data-value="VV"]').click();
  await settle();
});

test("a slow read never opens a popup over a newer click", async () => {
  const pending = [];
  tileFor = () => new Promise((resolve) => pending.push(resolve));
  popups.length = 0;
  fireClick(inside(...AT, 0.25, 0.25));
  await pause();
  tileFor = () => tile(201, 201, 201, 201);
  fireClick(inside(...AT, 0.25, 0.25));
  await pause();
  pending.forEach((resolve) => resolve(tile(101, 101, 101, 101)));
  await settle();
  assert.deepEqual(shown(), ["Coherence 2023VV: 0.79"]);
});

test("Enter on the focused map inspects its center", async () => {
  tileFor = () => tile(101, 101, 101, 101);
  popups.length = 0;
  el("map").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter" }));
  await settle();
  assert.deepEqual(shown(), ["Coherence 2023VV: 0.39"]);
});

test("a click elsewhere, a drag, a zoom, a tilt or Escape closes the popup", async () => {
  tileFor = () => tile(101, 101, 101, 101);
  await click(inside(...AT, 0.25, 0.25));
  const [first] = popups;
  assert.equal(first.options.closeButton, false, "there is no close button");

  fireClick(inside(...AT, 0.75, 0.75));
  assert.equal(first.removed, true, "a click elsewhere closes it at once");
  await pause();
  assert.equal(popups.length, 1, "and opens no other");

  fireClick(inside(...AT, 0.75, 0.75));
  await pause();
  await settle();
  assert.equal(popups.length, 2, "the next click opens one again");
  map.fire("dragstart");
  assert.equal(popups[1].removed, true, "a drag closes it");

  for (const event of ["zoomstart", "pitchstart"]) {
    await click(inside(...AT, 0.25, 0.25));
    map.fire(event);
    assert.equal(popups[0].removed, true, `and so does ${event}`);
  }

  await click(inside(...AT, 0.25, 0.25));
  escape();
  assert.equal(popups[0].removed, true, "and so does Escape");
});

test("a double click zooms and opens no popup", async () => {
  tileFor = () => tile(101, 101, 101, 101);
  escape();
  popups.length = 0;
  fireClick(inside(...AT, 0.25, 0.25));
  fireClick(inside(...AT, 0.25, 0.25));
  await pause();
  await settle();
  assert.deepEqual(shown(), []);

  // With a popup open, its first click closes it and its second opens none.
  await click(inside(...AT, 0.25, 0.25));
  fireClick(inside(...AT, 0.25, 0.25));
  fireClick(inside(...AT, 0.25, 0.25));
  await pause();
  await settle();
  assert.equal(popups.length, 1);
  assert.equal(popups[0].removed, true);
});
