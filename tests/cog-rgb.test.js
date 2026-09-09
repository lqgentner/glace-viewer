/*
 * The `glace-rgb://` protocol: a float COG read and coloured in the browser,
 * one archive through a ramp or two combined into false colour.
 *
 * Nothing on the page produces such a source any more — the tile-source switch
 * was retired in favour of the pre-styled PMTiles archives — so this drives the
 * protocol directly, through the same `setRecipe` + `recipeTiles` pair a source
 * spec would use. That is deliberate: the reader is kept so the question can be
 * reopened, and kept code that nothing exercises is how it stops working
 * quietly.
 *
 * The recipes below are written out rather than derived, but their numbers are
 * the published store's: the stretches and colour stops come from
 * `fixtures/store/style-2024.json`, the MapLibre style the catalog publishes.
 *
 * The reader is swapped for `fixtures/fake-geotiff.mjs` through the
 * `cogReaderUrl` setting, which is the same seam a deployment would use to pin
 * a different CDN. That keeps the network and the wasm decoders out of the
 * tests while leaving the parts worth testing — which resolution level answers
 * a zoom, which window is read out of it, and what the three channels come to —
 * running for real.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { installBrowser, load, REPO } from "./helpers/browser.js";

const style = JSON.parse(
  fs.readFileSync(path.join(REPO, "tests", "fixtures", "store", "style-2024.json"), "utf8"),
);
const legendOf = (stem) =>
  style.layers.find((layer) => layer.id === `glace-${stem}-2024`).metadata["portolan:legend"];
const stretch = (stem) => [legendOf(stem).vmin, legendOf(stem).vmax];
const colors = (stem) => legendOf(stem).stops.map((stop) => stop.color);

const READER = new URL("./fixtures/fake-geotiff.mjs", import.meta.url).href;
installBrowser({ site: { cogReaderUrl: READER } });

const { cogRgbProtocol, recipeTiles, setRecipe } = await load("js/cog-rgb.js");
const fake = await import(READER);

/* Absolute, as a source spec would build them: the protocol hands the string to
 * the reader rather than letting the document resolve it. Each year's mosaics
 * are the assets of that year's STAC item, at `mosaics/{year}/{stem}.tif`. */
const mosaic = (stem) =>
  `https://data.source.coop/lqgentner/glace-ch/mosaics/2024/${stem}.tif`;

/* Blue's stretch is the page's own rather than the style's: a single-band
 * layer's vmin/vmax describe that band only. Measured at native resolution over
 * 619 958 valid pixels of the 2024 mosaics — see AGENTS.md. */
setRecipe("coh12-rgb", {
  archives: [mosaic("coh12_vv"), mosaic("coh12_vh")],
  decibel: false,
  channels: { red: stretch("coh12_vv"), green: stretch("coh12_vh"), blue: [0.75, 2.75] },
});
setRecipe("rtc-rgb", {
  archives: [mosaic("rtc_vv"), mosaic("rtc_vh")],
  decibel: true,
  channels: { red: stretch("rtc_vv"), green: stretch("rtc_vh"), blue: [3.5, 11] },
});
setRecipe("coh12-vv", {
  archives: [mosaic("coh12_vv")],
  decibel: false,
  ramp: { range: stretch("coh12_vv"), colors: colors("coh12_vv") },
});
setRecipe("rtc-vv", {
  archives: [mosaic("rtc_vv")],
  decibel: true,
  ramp: { range: stretch("rtc_vv"), colors: colors("rtc_vv") },
});

/* Ask the protocol for one tile and hand back its pixels. The canvas stub in
 * the harness returns the raw RGBA rather than an encoded PNG. */
async function tile(url) {
  const { data } = await cogRgbProtocol({ url }, new AbortController());
  return new Uint8ClampedArray(data);
}
const pixel = (rgba, at) => [...rgba.slice(at * 4, at * 4 + 4)];
const channel = (value, [low, high]) => Math.round((255 * (value - low)) / (high - low));

test("a recipe is reached by naming it in a tile template", () => {
  // What a raster source would carry in `tiles:`, which is all the wiring a
  // control would need to put these layers back on the map.
  assert.equal(recipeTiles("coh12-rgb"), "glace-rgb://coh12-rgb/{z}/{x}/{y}");
});

test("a tile is the two archives combined, channel by channel", async () => {
  fake.fetched.length = 0;

  // A z13 tile well inside the Swiss extent: the image origin is 1 088 000 by
  // 734 720 z13 pixels from the WebMercator origin, i.e. tile 4250, 2870.
  const rgba = await tile("glace-rgb://coh12-rgb/13/4270/2880");

  assert.deepEqual(
    fake.fetched,
    ["coh12_vv.tif@0:20,10", "coh12_vh.tif@0:20,10"],
    "one tile from each archive, at the same index, from the full-resolution level",
  );

  /* VV 0.5 over the style's 0.10–0.75 stretch, VH 0.25 over 0.10–0.55, and the
   * blue channel their quotient, 2.0, over 0.75–2.75. */
  assert.deepEqual(pixel(rgba, 1), [
    channel(0.5, [0.1, 0.75]),
    channel(0.25, [0.1, 0.55]),
    channel(2.0, [0.75, 2.75]),
    255,
  ]);

  // The fixture blanks pixel 0 of every tile, as the archives blank nodata.
  assert.deepEqual(pixel(rgba, 0), [0, 0, 0, 0], "absent in either archive is absent in the tile");
});

test("backscatter is combined in dB, where its stretch lives", async () => {
  const rgba = await tile("glace-rgb://rtc-rgb/13/4270/2880");

  /* The archives store linear power. 0.05 and 0.0125 are −13 dB and −19.03 dB,
   * and the blue channel is their difference — the log of the quotient. */
  const vv = 10 * Math.log10(0.05);
  const vh = 10 * Math.log10(0.0125);
  assert.deepEqual(pixel(rgba, 1), [
    channel(vv, [-16.5, -4]),
    channel(vh, [-23.5, -11]),
    channel(vv - vh, [3.5, 11]),
    255,
  ]);
});

test("a coarser zoom reads the matching overview, and an offset one straddles tiles", async () => {
  fake.fetched.length = 0;
  await tile("glace-rgb://coh12-rgb/12/2135/1440");
  assert.deepEqual(
    fake.fetched.map((entry) => entry.split("@")[1]),
    ["1:10,5", "1:10,5"],
    "z12 is the first overview, and its grid is still tile aligned",
  );

  /* At z11 the image origin lands on a half tile in both axes — 272 000 and
   * 183 680 pixels, i.e. 1062.5 and 717.5 tiles — so one XYZ tile is a window
   * across a 2x2 block rather than a copy of one source tile. Still a copy
   * rather than a resample: the offset is a whole number of pixels. */
  fake.fetched.length = 0;
  await tile("glace-rgb://coh12-rgb/11/1067/720");
  const perArchive = fake.fetched.filter((entry) => entry.startsWith("coh12_vv"));
  assert.deepEqual(
    perArchive.map((entry) => entry.split("@")[1]),
    ["2:4,2", "2:5,2", "2:4,3", "2:5,3"],
    "four source tiles per archive, so eight reads for the pair",
  );
});

test("a tile outside the archives is blank rather than missing", async () => {
  // Far west of the Swiss extent, but a legal tile at that zoom.
  const rgba = await tile("glace-rgb://coh12-rgb/13/10/2880");
  assert.equal(rgba.length, 256 * 256 * 4);
  assert.ok([...rgba].every((band) => band === 0), "fully transparent");
});

test("zoomed out past the coarsest overview, the tile is blank not an error", async () => {
  // The fixture stops at overview 7, which is z6; z4 is below anything it has.
  const rgba = await tile("glace-rgb://coh12-rgb/4/8/5");
  assert.ok([...rgba].every((band) => band === 0));
});

test("an unknown recipe is refused rather than drawn wrong", async () => {
  await assert.rejects(() => tile("glace-rgb://not-a-layer/13/4270/2880"), /no false-colour recipe/);
});

test("a source tile decoded once is not decoded again", async () => {
  fake.fetched.length = 0;
  await tile("glace-rgb://coh12-rgb/13/4271/2881");
  assert.equal(fake.fetched.length, 2, "one tile from each archive");

  fake.fetched.length = 0;
  await tile("glace-rgb://coh12-rgb/13/4271/2881");
  assert.deepEqual(fake.fetched, [], "served from the decoded-tile cache");
});

test("neighbouring tiles share the source tiles they straddle", async () => {
  /* At z11 the window is not tile aligned, so tile x reads source columns
   * {4,5} and tile x+1 reads {5,6} — the shared column is what the cache is
   * for. Rows 2 and 3 are shared by both, so the second tile needs two new
   * source tiles per archive rather than four. */
  fake.fetched.length = 0;
  await tile("glace-rgb://coh12-rgb/11/1075/728");
  const first = fake.fetched.filter((entry) => entry.startsWith("coh12_vv"));
  assert.equal(first.length, 4);

  fake.fetched.length = 0;
  await tile("glace-rgb://coh12-rgb/11/1076/728");
  const second = fake.fetched.filter((entry) => entry.startsWith("coh12_vv"));
  assert.equal(second.length, 2, "half of what an uncached read would cost");
  assert.ok(
    second.every((entry) => !first.includes(entry)),
    "and only the tiles the first read did not already have",
  );
});

/* The colour a value lands on, computed independently of the module: a
 * piecewise-linear walk over the style's stops, clamped at both ends. */
function rampAt(colors, [low, high], value) {
  const stops = colors.map((hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)));
  const last = stops.length - 1;
  const place = Math.max(0, Math.min(1, (value - low) / (high - low))) * last;
  const first = Math.floor(place);
  const next = Math.min(first + 1, last);
  const between = place - first;
  return [0, 1, 2].map((band) =>
    Math.round(stops[first][band] + (stops[next][band] - stops[first][band]) * between),
  );
}

test("a single-band layer is drawn through the ramp the legend shows", async () => {
  const rgba = await tile("glace-rgb://coh12-vv/13/4270/2880");

  // The fixture decodes this archive as a constant 0.5, against a 0.10-0.80
  // stretch — the same three values the PMTiles build baked into its RGBA.
  assert.deepEqual(pixel(rgba, 1), [...rampAt(colors("coh12_vv"), stretch("coh12_vv"), 0.5), 255]);
  assert.deepEqual(pixel(rgba, 0), [0, 0, 0, 0], "and an absent pixel stays absent");
});

test("backscatter is converted to dB before the ramp, not after", async () => {
  const rgba = await tile("glace-rgb://rtc-vv/13/4270/2880");

  /* The archives store linear power; the stretch is published in dB. The
   * fixture's 0.05 is −13.01 dB, which sits inside −18.5..−5. */
  const decibel = 10 * Math.log10(0.05);
  assert.deepEqual(pixel(rgba, 1), [...rampAt(colors("rtc_vv"), stretch("rtc_vv"), decibel), 255]);

  // The regression this guards: read raw, 0.05 is above the stretch and every
  // valid pixel would clamp to the ramp's ceiling.
  assert.notDeepEqual(
    pixel(rgba, 1),
    [...rampAt(colors("rtc_vv"), stretch("rtc_vv"), 1e9), 255],
    "a flat block is what not converting looks like",
  );
});
