/*
 * False colour from two archives: the `glace-rgb://` protocol, and the panel
 * row that reaches it.
 *
 * The reader is swapped for `fixtures/fake-geotiff.mjs` through the
 * `cogReaderUrl` setting, which is the same seam a deployment would use to pin
 * a different CDN. That keeps the network and the wasm decoders out of the
 * tests while leaving the parts worth testing — which resolution level answers
 * a zoom, which window is read out of it, and what the three channels come to —
 * running for real.
 *
 * Its own file for the reason cog-source.test.js is: the modules hold state at
 * module scope and the map is a singleton, so a second manifest needs a second
 * process.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { installBrowser, load, REPO, settle } from "./helpers/browser.js";

const FIXTURE = path.join(REPO, "tests", "fixtures", "layers-store.json");
const raw = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const READER = new URL("./fixtures/fake-geotiff.mjs", import.meta.url).href;

const page = installBrowser({
  files: {
    "tiles/layers.json": FIXTURE,
    "data/inventories.json": path.join(REPO, "data", "inventories.json"),
  },
  site: { tilesBase: "tiles", cogReaderUrl: READER },
});
const { el } = page;

await load("js/app.js");
const { map } = page;
map.fire("style.load");
await settle();

const { cogRgbProtocol } = await load("js/cog-rgb.js");
const fake = await import(READER);

const buttons = (id) => Object.fromEntries([...el(id).children].map((b) => [b.dataset.value, b]));
const pick = async (pol, source) => {
  buttons("pol")[pol].click();
  buttons("source")[source].click();
  await settle();
};

/* Ask the protocol for one tile and hand back its pixels. The canvas stub in
 * the harness returns the raw RGBA rather than an encoded PNG. */
async function tile(url) {
  const { data } = await cogRgbProtocol({ url }, new AbortController());
  return new Uint8ClampedArray(data);
}
const pixel = (rgba, at) => [...rgba.slice(at * 4, at * 4 + 4)];

test("the false-colour row is offered, and reaches both sources", async () => {
  assert.ok(buttons("pol").RGB, "RGB sits in the polarization row");

  await pick("RGB", "pmtiles");
  assert.equal(
    map.getSource("glace-pmtiles-coh12_rgb_2024").url,
    "pmtiles://tiles/2024/pmtiles/coh12_rgb.pmtiles",
    "the pre-styled archive the store publishes",
  );

  await pick("RGB", "cog");
  const source = map.getSource("glace-cog-coh12_rgb_2024");
  assert.deepEqual(
    source.tiles,
    ["glace-rgb://glace-cog-coh12_rgb_2024/{z}/{x}/{y}"],
    "and the two mosaics it was rendered from, stacked",
  );
  // A `tiles:` template carries no TileJSON, so these have to be declared.
  assert.deepEqual(source.bounds, raw.layers[0].bounds);
  assert.equal(source.maxzoom, 13);
});

test("a tile is the two archives combined, channel by channel", async () => {
  await pick("RGB", "cog");
  fake.fetched.length = 0;

  // A z13 tile well inside the Swiss extent: the image origin is 1 088 000 by
  // 734 720 z13 pixels from the WebMercator origin, i.e. tile 4250, 2870.
  const rgba = await tile("glace-rgb://glace-cog-coh12_rgb_2024/13/4270/2880");

  assert.deepEqual(
    fake.fetched,
    ["coh12_vv.tif@0:20,10", "coh12_vh.tif@0:20,10"],
    "one tile from each archive, at the same index, from the full-resolution level",
  );

  /* VV 0.5 over a 0.10–0.80 stretch, VH 0.25 over 0.10–0.60, and the blue
   * channel their quotient, 2.0, over 0.75–2.75. */
  const channel = (value, [low, high]) => Math.round((255 * (value - low)) / (high - low));
  assert.deepEqual(pixel(rgba, 1), [
    channel(0.5, [0.1, 0.8]),
    channel(0.25, [0.1, 0.6]),
    channel(2.0, [0.75, 2.75]),
    255,
  ]);

  // The fixture blanks pixel 0 of every tile, as the archives blank nodata.
  assert.deepEqual(pixel(rgba, 0), [0, 0, 0, 0], "absent in either archive is absent in the tile");
});

test("backscatter is combined in dB, where its stretch lives", async () => {
  buttons("product").RTC.click();
  await pick("RGB", "cog");
  const rgba = await tile("glace-rgb://glace-cog-rtc_rgb_2024/13/4270/2880");

  /* The archives store linear power. 0.05 and 0.0125 are −13 dB and −19.03 dB,
   * and the blue channel is their difference — the log of the quotient. */
  const channel = (value, [low, high]) => Math.round((255 * (value - low)) / (high - low));
  const vv = 10 * Math.log10(0.05);
  const vh = 10 * Math.log10(0.0125);
  assert.deepEqual(pixel(rgba, 1), [
    channel(vv, [-18.5, -5]),
    channel(vh, [-26, -11]),
    channel(vv - vh, [3.5, 11]),
    255,
  ]);
  buttons("product").COH12.click();
  await settle();
});

test("a coarser zoom reads the matching overview, and an offset one straddles tiles", async () => {
  await pick("RGB", "cog");

  fake.fetched.length = 0;
  await tile("glace-rgb://glace-cog-coh12_rgb_2024/12/2135/1440");
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
  await tile("glace-rgb://glace-cog-coh12_rgb_2024/11/1067/720");
  const perArchive = fake.fetched.filter((entry) => entry.startsWith("coh12_vv"));
  assert.deepEqual(
    perArchive.map((entry) => entry.split("@")[1]),
    ["2:4,2", "2:5,2", "2:4,3", "2:5,3"],
    "four source tiles per archive, so eight reads for the pair",
  );
});

test("a tile outside the archives is blank rather than missing", async () => {
  await pick("RGB", "cog");
  // Far west of the Swiss extent, but a legal tile at that zoom.
  const rgba = await tile("glace-rgb://glace-cog-coh12_rgb_2024/13/10/2880");
  assert.equal(rgba.length, 256 * 256 * 4);
  assert.ok([...rgba].every((channel) => channel === 0), "fully transparent");
});

test("zoomed out past the coarsest overview, the tile is blank not an error", async () => {
  await pick("RGB", "cog");
  // The fixture stops at overview 7, which is z6; z4 is below anything it has.
  const rgba = await tile("glace-rgb://glace-cog-coh12_rgb_2024/4/8/5");
  assert.ok([...rgba].every((channel) => channel === 0));
});

test("an unknown recipe is refused rather than drawn wrong", async () => {
  await assert.rejects(
    () => tile("glace-rgb://not-a-layer/13/4270/2880"),
    /no false-colour recipe/,
  );
});

test("the legend names the channels instead of showing a ramp", async () => {
  await pick("RGB", "cog");
  assert.equal(el("legend-bar").hidden, true, "there is no ramp to show");
  assert.equal(el("legend-channels").hidden, false);

  const cells = [...el("legend-channels").children].map((node) => node.textContent);
  assert.deepEqual(cells.filter((text) => text !== "" && !text.includes("to")), ["VV", "VH", "VV ÷ VH"]);
  assert.ok(cells.includes("0.75 to 2.75"), "and the range this page chose for the quotient");

  /* On the pre-styled archive the build chose the stretch and never published
   * it, so the legend names the channels and stops there. */
  await pick("RGB", "pmtiles");
  const published = [...el("legend-channels").children].map((node) => node.textContent);
  assert.ok(published.includes("VV ÷ VH"));
  assert.ok(!published.some((text) => text.includes("to")), "no numbers this page cannot vouch for");
});

test("going back to a single-band layer restores the ramp", async () => {
  await pick("VV", "cog");
  assert.equal(el("legend-bar").hidden, false);
  assert.equal(el("legend-channels").hidden, true);
  assert.equal(el("legend-min").textContent, "0.10");
  assert.equal(el("legend-max").textContent, "0.80");
});

test("a source that cannot load its tiles says so", async () => {
  await pick("RGB", "cog");
  const source = "glace-cog-coh12_rgb_2024";

  // A cancelled tile is not a failure: panning away from one is the normal case.
  map.fire("error", { sourceId: source, error: Object.assign(new Error("aborted"), { name: "AbortError" }) });
  await settle();
  assert.ok(!/could not be drawn/.test(el("status").textContent));

  map.fire("error", { sourceId: source, error: new Error("Failed to fetch") });
  await settle();
  assert.match(el("status").textContent, /could not be drawn/);
  assert.match(el("status").textContent, /Failed to fetch/);

  // One broken layer is one message, however many of its tiles fail.
  el("status").textContent = "";
  map.fire("error", { sourceId: source, error: new Error("Failed to fetch") });
  await settle();
  assert.equal(el("status").textContent, "");
});

test("a source tile decoded once is not decoded again", async () => {
  await pick("RGB", "cog");

  fake.fetched.length = 0;
  await tile("glace-rgb://glace-cog-coh12_rgb_2024/13/4271/2881");
  assert.equal(fake.fetched.length, 2, "one tile from each archive");

  fake.fetched.length = 0;
  await tile("glace-rgb://glace-cog-coh12_rgb_2024/13/4271/2881");
  assert.deepEqual(fake.fetched, [], "served from the decoded-tile cache");
});

test("neighbouring tiles share the source tiles they straddle", async () => {
  await pick("RGB", "cog");

  /* At z11 the window is not tile aligned, so tile x reads source columns
   * {4,5} and tile x+1 reads {5,6} — the shared column is what the cache is
   * for. Rows 2 and 3 are shared by both, so the second tile needs two new
   * source tiles per archive rather than four. */
  fake.fetched.length = 0;
  await tile("glace-rgb://glace-cog-coh12_rgb_2024/11/1075/728");
  const first = fake.fetched.filter((entry) => entry.startsWith("coh12_vv"));
  assert.equal(first.length, 4);

  fake.fetched.length = 0;
  await tile("glace-rgb://glace-cog-coh12_rgb_2024/11/1076/728");
  const second = fake.fetched.filter((entry) => entry.startsWith("coh12_vv"));
  assert.equal(second.length, 2, "half of what an uncached read would cost");
  assert.ok(
    second.every((entry) => !first.includes(entry)),
    "and only the tiles the first read did not already have",
  );
});

const entryOf = (id) => raw.layers.find((layer) => layer.id === id);

/* The colour a value lands on, computed independently of the module: a
 * piecewise-linear walk over the manifest's stops, clamped at both ends. */
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
  await pick("VV", "cog");
  const layer = entryOf("coh12_vv_2024");
  const rgba = await tile("glace-rgb://glace-cog-coh12_vv_2024/13/4270/2880");

  // The fixture decodes this archive as a constant 0.5, against a 0.10-0.80
  // stretch — the same three values the PMTiles build baked into its RGBA.
  assert.deepEqual(
    pixel(rgba, 1),
    [...rampAt(layer.colors, [layer.vmin, layer.vmax], 0.5), 255],
  );
  assert.deepEqual(pixel(rgba, 0), [0, 0, 0, 0], "and an absent pixel stays absent");
});

test("backscatter is converted to dB before the ramp, not after", async () => {
  buttons("product").RTC.click();
  await pick("VV", "cog");
  const layer = entryOf("rtc_vv_2024");
  const rgba = await tile("glace-rgb://glace-cog-rtc_vv_2024/13/4270/2880");

  /* The archives store linear power; the stretch is published in dB. The
   * fixture's 0.05 is −13.01 dB, which sits inside −18.5..−5. */
  const decibel = 10 * Math.log10(0.05);
  assert.deepEqual(
    pixel(rgba, 1),
    [...rampAt(layer.colors, [layer.vmin, layer.vmax], decibel), 255],
  );

  // The regression this guards: read raw, 0.05 is above the stretch and every
  // valid pixel would clamp to the ramp's ceiling.
  assert.notDeepEqual(
    pixel(rgba, 1),
    [...rampAt(layer.colors, [layer.vmin, layer.vmax], 1e9), 255],
    "a flat block is what not converting looks like",
  );
  buttons("product").COH12.click();
  await settle();
});

test("decoding is handed to the reader's pool, built once and shared", async () => {
  await pick("VV", "cog");
  await tile("glace-rgb://glace-cog-coh12_vv_2024/13/4272/2882");

  assert.equal(fake.pools.length, 1, "one pool for every layer and every tile");
  assert.ok(fake.lastPool, "and it reaches the read");
  assert.equal(fake.lastPool, fake.pools[0]);
  /* jsdom has no `Worker`, so the page asks for a pool with none rather than
   * spawning one it cannot prove — the reader then decodes inline, which is
   * what this path did before workers existed. */
  assert.deepEqual(fake.pools[0].options, {});
});
