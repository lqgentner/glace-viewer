/* Count an archive's codes over the view, and draw them as bars. */

import assert from "node:assert/strict";
import test from "node:test";

import { installBrowser, load } from "./helpers/browser.js";

installBrowser();
const { codeAt, codeRange, compositeCounts, histogramPath, viewCounts } = await load("js/histogram.js");
const { compositeLayers } = await load("js/composite.js");

/* value = code / 10 - 19.1 in the blue channel; code 0 in all three is nodata. */
const ENCODING = { encoding: "custom", redFactor: 0, greenFactor: 0, blueFactor: 0.1, baseShift: 19.1 };
/* The Alps, roughly. */
const HEADER = { minLon: 5, minLat: 43, maxLon: 17, maxLat: 49 };

/* Each test reads its own archive URL: js/archive.js keeps one reader per URL. */
let archives = 0;
function layer(tiles = new Map()) {
  const url = `https://x/${++archives}.pmtiles`;
  const requested = [];
  globalThis.pmtiles.PMTiles = class {
    constructor(source) { this.source = source; }
    async getHeader() { return HEADER; }
    async getZxy(z, x, y) {
      requested.push([z, x, y]);
      const data = tiles.get(`${z}/${x}/${y}`);
      return data ? { data: data.buffer } : undefined;
    }
  };
  return { record: { url, encoding: ENCODING, minZoom: 5, maxZoom: 13 }, requested };
}

/* Two-by-two tiles: grey codes, alpha 255 unless stated. */
const tile = (...pixels) =>
  new Uint8ClampedArray(pixels.flatMap(([code, alpha = 255]) => [code, code, code, alpha]));

/* The bounds of tile x, y at zoom z, or of the part from fractions [left, right). */
function tileBounds(z, x, y, [left, right] = [0, 1]) {
  const n = 2 ** z;
  const lon = (at) => (at / n) * 360 - 180;
  const lat = (at) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * at) / n))) * 180) / Math.PI;
  return [lon(x + left), lat(y + 1), lon(x + right), lat(y)];
}

const counted = (counts) =>
  Object.fromEntries([...counts.entries()].filter(([, count]) => count > 0));

test("codes in view are counted; nodata and transparent pixels are not", async () => {
  // Map zoom 7 draws zoom 8 tiles. Tile 8/134/90 lies in the Alps.
  const { record } = layer(new Map([["8/134/90", tile([10], [20], [0], [30, 0])]]));
  const counts = await viewCounts(record, tileBounds(8, 134, 90), 7);
  assert.equal(counts.length, 256);
  assert.deepEqual(counted(counts), { 10: 1, 20: 1 });
});

test("only the pixels in view count", async () => {
  const { record } = layer(new Map([["8/134/90", tile([10], [20], [40], [50])]]));
  const counts = await viewCounts(record, tileBounds(8, 134, 90, [0, 0.5]), 7);
  assert.deepEqual(counted(counts), { 10: 1, 40: 1 }, "the left column");
});

test("tiles are read at the drawn zoom, within the archive's zoom limits", async () => {
  const at = async (zoom, bounds = tileBounds(8, 134, 90)) => {
    const { record, requested } = layer();
    await viewCounts(record, bounds, zoom);
    return new Set(requested.map(([z]) => z));
  };
  assert.deepEqual(await at(7.4), new Set([8]), "rounded, one above the map");
  assert.deepEqual(await at(2), new Set([5]), "no coarser than the archive");
  assert.deepEqual(await at(15, tileBounds(13, 4300, 2900)), new Set([13]), "no finer");
});

test("a wide view is read at a coarser zoom", async () => {
  const { record, requested } = layer();
  await viewCounts(record, [9, 45, 11, 47], 12);
  assert.ok(requested.length <= 48, `${requested.length} tiles`);
  assert.equal(new Set(requested.map(([z]) => z)).size, 1);
  assert.ok(requested[0][0] < 13);
});

test("a view outside the archive reads nothing", async () => {
  const { record, requested } = layer();
  const counts = await viewCounts(record, [-80, 30, -70, 40], 7);
  assert.equal(requested.length, 0);
  assert.deepEqual(counted(counts), {});
});

test("an aborted read rejects", async () => {
  const { record } = layer();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => viewCounts(record, tileBounds(8, 134, 90), 7, controller.signal), {
    name: "AbortError",
  });
});

test("bars span three codes, with heights by the square root of the count", () => {
  const counts = new Float64Array(256);
  counts[4] = 100; // the bar of codes 4-6
  counts[7] = 25; // a quarter of the pixels, half the height
  assert.equal(histogramPath(counts, 64), "M3 64h3V0.00h-3ZM6 64h3V32.00h-3Z");
  assert.equal(histogramPath(new Float64Array(256), 64), "", "nothing counted, nothing drawn");
});

test("a code the codec never produces does not lower its bar", () => {
  // Lossy WebP skips about every seventh code: a bar's height averages the codes counted.
  const counts = new Float64Array(256);
  counts.fill(100, 1, 7);
  counts[2] = 0;
  assert.equal(histogramPath(counts, 64), "M0 64h3V0.00h-3ZM3 64h3V0.00h-3Z");
});

test("percentiles interpolate within a code, and the range spans the counted codes", () => {
  const counts = new Float64Array(256);
  counts[10] = 1;
  counts[20] = 2;
  counts[30] = 1;
  assert.equal(codeAt(counts, 0), 9.5, "the bottom of the lowest code");
  assert.equal(codeAt(counts, 0.5), 20, "half of 20's two pixels below the median");
  assert.equal(codeAt(counts, 1), 30.5);
  assert.deepEqual(codeRange(counts), [10, 30]);
  assert.equal(codeRange(new Float64Array(256)), null);
});

test("a composite counts its channels where both polarizations have data", async () => {
  // VV code 91 is -10 dB and VH code 32 is -15.9 dB: the ratio is 5.9 dB.
  const [vv, vh] = [layer().record, layer().record];
  const served = {
    [vv.url]: tile([91], [91], [91], [0]),
    [vh.url]: tile([32], [0], [32], [32]),
  };
  globalThis.pmtiles.PMTiles = class {
    constructor(source) { this.source = source; }
    async getHeader() { return HEADER; }
    async getZxy(z, x, y) {
      return `${z}/${x}/${y}` === "8/134/90" ? { data: served[this.source.getKey()].buffer } : undefined;
    }
  };
  const record = (over) => ({ product: "RTC", year: 2024, units: "dB", vmin: -20, vmax: 0, ...over });
  const [rgb] = compositeLayers([
    record({ ...vv, id: "vv", stem: "rtc_vv", polarization: "VV" }),
    record({ ...vh, id: "vh", stem: "rtc_vh", polarization: "VH" }),
  ]);
  const [red, green, blue] = await compositeCounts(rgb, tileBounds(8, 134, 90), 7);
  // Pixels 0 and 2 have both; 1 lacks VH, and 3 is VV nodata.
  assert.deepEqual(counted(red), { 91: 2 });
  assert.deepEqual(counted(green), { 32: 2 });
  // The ratio's axis is 0-15 dB in 255 codes, code c from (c - 1) / 17 to c / 17 dB.
  assert.deepEqual(counted(blue), { 101: 2 });
});
