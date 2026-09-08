/*
 * The catalog tile grid, read from the store's stac-geoparquet item index.
 *
 * hyparquet is swapped for `fixtures/fake-hyparquet.mjs` through the
 * `hyparquetUrl` setting — the same seam a deployment would use to pin a
 * different CDN — so the reading and the network stay out of it and what runs
 * is the part this repository owns: which columns are asked for, how one Item
 * per (tile, year) becomes one footprint per tile, and what the overlay does
 * when the index cannot be read.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { installBrowser, load, REPO, settle } from "./helpers/browser.js";

const READER = new URL("./fixtures/fake-hyparquet.mjs", import.meta.url).href;

const page = installBrowser({
  files: {
    "data/inventories.json": path.join(REPO, "data", "inventories.json"),
  },
  site: { hyparquetUrl: READER },
});
const { el, change } = page;

await load("js/app.js");
const { map } = page;
map.fire("style.load");
await settle();

const { loadTileGrid } = await load("js/tile-grid.js");
const fake = await import(READER);

test("only the columns the overlay draws are read", async () => {
  fake.reads.length = 0;
  await loadTileGrid();
  assert.deepEqual(fake.reads, [
    "tiles/tiles/items.parquet",
    "geometry,glace:mgrs_tile,glace:glacier_fraction,glace:glacier_fraction_buffered",
  ]);
});

test("one Item per year becomes one footprint per tile", async () => {
  const grid = await loadTileGrid();
  assert.equal(grid.type, "FeatureCollection");
  // Four usable rows over two years, and two rows that describe no footprint.
  assert.deepEqual(
    grid.features.map((feature) => feature.properties.tile),
    ["32TLR48", "32TMS12"],
  );
  assert.equal(grid.features[0].geometry.type, "Polygon");
});

test("the properties keep the names the paint and the popup use", async () => {
  const [first] = (await loadTileGrid()).features;
  assert.deepEqual(first.properties, {
    tile: "32TLR48",
    glacier_fraction: 0.456,
    glacier_fraction_buffered: 0.932,
  });
});

test("a row that describes no polygon is dropped rather than drawn", async () => {
  const grid = await loadTileGrid();
  // The fixture holds an unnamed row with no geometry and a named Point.
  assert.equal(grid.features.length, 2);
  assert.ok(grid.features.every((feature) => feature.geometry.type === "Polygon"));
});

test("the overlay draws it, and the source is data rather than a URL", async () => {
  change(el("grid"), true);
  await settle();

  assert.ok(map.getLayer("grid-fill") && map.getLayer("grid-line"));
  const source = map.getSource("grid");
  assert.equal(source.type, "geojson");
  assert.equal(source.data.features.length, 2, "already read, not left to MapLibre to fetch");
  // A GeoJSON source has no source-layer, and naming one would draw nothing.
  assert.equal(map.getLayer("grid-fill")["source-layer"], undefined);
});

test("the grid sits above the relief and under the basemap labels", () => {
  assert.ok(map.indexOf("hillshade") < map.indexOf("grid-fill"));
  assert.ok(map.indexOf("grid-line") < map.indexOf("places"));
});

test("an unreadable index unticks the box and says which file", async () => {
  change(el("grid"), false);
  await settle();
  map.removeLayer("grid-fill");
  map.removeLayer("grid-line");
  map.removeSource("grid");
  const { grid } = await load("js/overlays.js");
  grid.loaded = false;

  fake.failWith(new Error("unsupported codec ZSTD"));
  change(el("grid"), true);
  await settle();

  assert.equal(el("grid").checked, false, "re-ticking is a fresh attempt, not a no-op");
  assert.match(el("status").textContent, /Tile grid unavailable/);
  assert.match(el("status").textContent, /items\.parquet/);
  assert.match(el("status").textContent, /unsupported codec ZSTD/);
  assert.equal(map.getLayer("grid-fill"), undefined, "nothing half-added is left behind");
});
