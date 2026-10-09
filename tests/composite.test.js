/* Check false-color records, pixel composition and the glace-rgb protocol. */

import assert from "node:assert/strict";
import test from "node:test";

import { installBrowser, load } from "./helpers/browser.js";

installBrowser();
const { compositeLayers, compositePixels, compositeProtocol, compositeTiles, restretch } = await load(
  "js/composite.js",
);

/* value = code / 10 - 19.1 in the blue channel; code 0 in all three is nodata. */
const ENCODING = { encoding: "custom", redFactor: 0, greenFactor: 0, blueFactor: 0.1, baseShift: 19.1 };
const record = (over) => ({
  product: "RTC", year: 2024, units: "dB", encoding: ENCODING, minZoom: 5, maxZoom: 13,
  attribution: "Credit 2024", url: `https://x/${over.polarization}.pmtiles`, ...over,
});
/* Stretches chosen so no expected channel lands on a rounding half. */
const VV = record({ id: "glace-rtc_vv-2024", stem: "rtc_vv", polarization: "VV", vmin: -16, vmax: -5 });
const VH = record({ id: "glace-rtc_vh-2024", stem: "rtc_vh", polarization: "VH", vmin: -22, vmax: -11 });

test("one composite per product and year with both polarizations", () => {
  const qa = record({ id: "glace-rtc_vv_qa_num-2024", stem: "rtc_vv_qa_num", polarization: "VV_QA_NUM", vmin: 0, vmax: 80 });
  const lonely = record({ id: "glace-rtc_vv-2023", stem: "rtc_vv", polarization: "VV", year: 2023, vmin: -16, vmax: -5 });
  const [rgb, ...rest] = compositeLayers([VV, VH, qa, lonely]);
  assert.equal(rest.length, 0, "no VH in 2023, and QA never composes");
  assert.equal(rgb.id, "glace-rtc_rgb-2024");
  assert.equal(rgb.polarization, "RGB");
  assert.equal(rgb.attribution, "Credit 2024");
  assert.deepEqual(
    rgb.channels.map(({ band, vmin, vmax, units }) => ({ band, vmin, vmax, units })),
    [
      { band: "VV", vmin: -16, vmax: -5, units: "dB" },
      { band: "VH", vmin: -22, vmax: -11, units: "dB" },
      { band: "VV − VH", vmin: 3.5, vmax: 10.5, units: "dB" },
    ],
  );
  assert.equal(rgb.channels[0].encoding, ENCODING, "the polarizations keep their archives' axes");
  // The ratio's axis splits its bounds into 255 codes, centered half a code in.
  const { bounds, encoding } = rgb.channels[2];
  assert.deepEqual(bounds, [0, 15]);
  const center = (code) => code * encoding.redFactor - encoding.baseShift;
  assert.ok(Math.abs(center(1) - 15 / 510) < 1e-12);
  assert.ok(Math.abs(center(255) - (15 - 15 / 510)) < 1e-12);
});

test("coherence composes a quotient over its own blue range", () => {
  const cvv = record({ id: "glace-coh12_vv-2024", stem: "coh12_vv", product: "COH12", polarization: "VV", units: "", vmin: 0.1, vmax: 0.75 });
  const cvh = record({ id: "glace-coh12_vh-2024", stem: "coh12_vh", product: "COH12", polarization: "VH", units: "", vmin: 0.1, vmax: 0.55 });
  const [rgb] = compositeLayers([cvv, cvh]);
  const { band, vmin, vmax, units, bounds } = rgb.channels[2];
  assert.deepEqual({ band, vmin, vmax, units, bounds }, { band: "VV / VH", vmin: 0.8, vmax: 2.6, units: "", bounds: [0.5, 3] });
  assert.equal(rgb.composite.decibel, false);
});

test("an unknown product has no blue range and composes nothing", () => {
  const xvv = record({ id: "glace-x_vv-2024", stem: "x_vv", product: "X", polarization: "VV", vmin: 0, vmax: 1 });
  const xvh = record({ id: "glace-x_vh-2024", stem: "x_vh", product: "X", polarization: "VH", vmin: 0, vmax: 1 });
  assert.deepEqual(compositeLayers([xvv, xvh]), []);
});

/* A pmtiles reader whose tiles come from `getZxy(url, z, x, y)`. */
const reader = (getZxy) =>
  class {
    constructor(source) { this.source = source; }
    getZxy(z, x, y) { return getZxy(this.source.getKey(), z, x, y); }
  };

/* Two-pixel tiles: grey codes, alpha 255 unless stated. */
const tile = (...pixels) => ({
  size: 2,
  data: new Uint8ClampedArray(pixels.flatMap(([code, alpha = 255]) => [code, code, code, alpha])),
});

test("each channel is stretched, and a pixel needs both polarizations", () => {
  const [rgb] = compositeLayers([VV, VH]);
  // VV code 91 -> -10 dB, VH code 31 -> -16 dB, ratio 6 dB.
  const out = compositePixels(
    tile([91], [91], [0], [91, 0]),
    tile([31], [0], [31], [31]),
    rgb,
  );
  const px = (at) => [...out.slice(at * 4, at * 4 + 4)];
  // 6/11, 6/11 and 2.5/7 of 255.
  assert.deepEqual(px(0), [139, 139, 91, 255]);
  assert.deepEqual(px(1), [0, 0, 0, 0], "VH nodata: transparent, not black");
  assert.deepEqual(px(2), [0, 0, 0, 0], "VV nodata");
  assert.deepEqual(px(3), [0, 0, 0, 0], "VV transparent in a lossy tile");
});

test("new limits restretch the channels", () => {
  const [rgb] = compositeLayers([VV, VH]);
  // VV -10 dB, VH -16 dB, ratio 6 dB, as above.
  const pixel = () => [...compositePixels(tile([91]), tile([31]), rgb).slice(0, 3)];
  assert.deepEqual(pixel(), [139, 139, 91]);
  restretch(rgb, [{ vmin: -10, vmax: 0 }, { vmin: -16, vmax: -14 }, { vmin: 6, vmax: 8 }]);
  assert.deepEqual(pixel(), [0, 0, 0], "each at its new bottom");
});

test("redraws wait a gap after the last, and for the tiles being drawn", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const [rgb] = compositeLayers([
    { ...VV, url: "https://redraw/VV.pmtiles" },
    { ...VH, url: "https://redraw/VH.pmtiles" },
  ]);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.pmtiles.PMTiles = reader(async () => {
    await gate;
    return { data: tile([91]).data.buffer };
  });
  const reloads = [];
  const limits = (vmin) => [{ vmin, vmax: 0 }, { vmin: -22, vmax: -11 }, { vmin: 3.5, vmax: 10.5 }];
  const change = (vmin) => restretch(rgb, limits(vmin), () => reloads.push(vmin));

  change(-16);
  assert.deepEqual(reloads, [-16], "the first at once");
  change(-15);
  assert.deepEqual(reloads, [-16], "the next waits for the gap");
  t.mock.timers.tick(100);
  assert.deepEqual(reloads, [-16, -15]);

  t.mock.timers.tick(100);
  const drawing = compositeProtocol({ url: "glace-rgb://glace-rtc_rgb-2024/10/1/1" });
  change(-14);
  change(-13);
  t.mock.timers.tick(100);
  assert.deepEqual(reloads, [-16, -15], "and for the tile being drawn");
  release();
  await drawing;
  t.mock.timers.tick(100);
  assert.deepEqual(reloads, [-16, -15, -13], "then only the latest limits are drawn");
  assert.equal(rgb.stretch[0].vmin, -13);
});

test("a tile that never settles holds a redraw back for ten gaps only", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const [rgb] = compositeLayers([VV, VH]);
  const reloads = [];
  rgb.drawing = 1; // a read that never settles
  restretch(rgb, rgb.channels, () => reloads.push("redrawn"));
  for (let gap = 1; gap < 10; gap++) t.mock.timers.tick(100);
  assert.deepEqual(reloads, []);
  t.mock.timers.tick(100);
  assert.deepEqual(reloads, ["redrawn"]);
  rgb.drawing = 0;
});

test("the protocol composes a named tile and blanks one an archive lacks", async () => {
  const [rgb] = compositeLayers([VV, VH]);
  const served = new Map([
    ["https://x/VV.pmtiles|13/1/2", tile([91], [91], [91], [91]).data],
    ["https://x/VH.pmtiles|13/1/2", tile([31], [31], [31], [31]).data],
  ]);
  globalThis.pmtiles.PMTiles = reader(async (url, z, x, y) => {
    const data = served.get(`${url}|${z}/${x}/${y}`);
    return data ? { data: data.buffer } : undefined;
  });
  assert.equal(compositeTiles(rgb.id), "glace-rgb://glace-rtc_rgb-2024/{z}/{x}/{y}");

  const drawn = await compositeProtocol({ url: "glace-rgb://glace-rtc_rgb-2024/13/1/2" });
  assert.equal(drawn.data.width, 2, "a bitmap MapLibre takes as is");
  assert.equal(drawn.data.data[3], 255);

  const absent = await compositeProtocol({ url: "glace-rgb://glace-rtc_rgb-2024/13/9/9" });
  assert.equal(absent.data.byteLength, 0, "outside the archive: an empty, transparent tile");

  await assert.rejects(() => compositeProtocol({ url: "glace-rgb://nope/13/1/2" }), /no false-color composite/);
});

test("a failed tile read fails the tile and is retried next time", async () => {
  // Fresh archive URLs: js/archive.js keeps one reader per URL.
  compositeLayers([
    { ...VV, url: "https://retry/VV.pmtiles" },
    { ...VH, url: "https://retry/VH.pmtiles" },
  ]);
  let failing = true;
  globalThis.pmtiles.PMTiles = reader(async () => {
    if (failing) throw new Error("network");
    return { data: tile([91], [91], [91], [91]).data.buffer };
  });
  const url = "glace-rgb://glace-rtc_rgb-2024/12/3/4";
  await assert.rejects(() => compositeProtocol({ url }), /network/, "not a blank success");
  failing = false;
  const second = await compositeProtocol({ url });
  assert.equal(second.data.data[3], 255, "the failure was not cached");
});

test("an aborted tile stops waiting without canceling the shared reads", async () => {
  compositeLayers([
    { ...VV, url: "https://slow/VV.pmtiles" },
    { ...VH, url: "https://slow/VH.pmtiles" },
  ]);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.pmtiles.PMTiles = reader(async () => {
    await gate;
    return { data: tile([91], [91], [91], [91]).data.buffer };
  });
  const url = "glace-rgb://glace-rtc_rgb-2024/11/5/6";
  const controller = new AbortController();
  const aborted = compositeProtocol({ url }, controller);
  const other = compositeProtocol({ url }, new AbortController());
  controller.abort();
  await assert.rejects(aborted, { name: "AbortError" }, "rejects before the reads finish");
  release();
  assert.equal((await other).data.data[3], 255, "the other consumer still gets its tile");

  const early = new AbortController();
  early.abort();
  await assert.rejects(() => compositeProtocol({ url }, early), { name: "AbortError" });
});
