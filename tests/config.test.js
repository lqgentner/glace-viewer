/*
 * The settings chain: built-in defaults, then site-config.js, then the query
 * parameters. Each case imports js/config.js fresh, because it resolves the
 * chain once at module load.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { captureWarnings, freshImport, installBrowser, REPO } from "./helpers/browser.js";

const load = async (options) => {
  installBrowser(options);
  return freshImport("js/config.js");
};

test("built-in defaults", async () => {
  const config = await load();
  assert.equal(config.TILES_BASE, "tiles");
  assert.equal(config.LAYER_MANIFEST_URL, "tiles/layers.json");
  assert.equal(config.INVENTORY_INDEX_URL, "data/inventories.json");
  assert.equal(config.GRID_ARCHIVE_URL, "tiles/tile-grid.pmtiles");
  assert.equal(config.GRID_SOURCE_LAYER, "grid");
  assert.equal(config.BASEMAP_FLAVOR, "dark");
  assert.match(config.WORLD_IMAGERY_URL, /World_Imagery\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}/);
  assert.deepEqual(config.INITIAL_VIEW, { center: [10.4, 46.5], zoom: 6.2, maxZoom: 14 });
});

test("the committed empty template changes nothing", async () => {
  const withTemplate = await load({ site: {} });
  const bare = await load();
  assert.equal(withTemplate.TILES_BASE, bare.TILES_BASE);
  assert.equal(withTemplate.BASEMAP_FLAVOR, bare.BASEMAP_FLAVOR);
  assert.deepEqual(withTemplate.INITIAL_VIEW, bare.INITIAL_VIEW);
});

test("site config repoints the archives, and everything derived follows", async () => {
  const config = await load({
    site: {
      tilesBase: "https://s3.example/glace/",
      gridArchive: "grid-v2.pmtiles",
      worldImageryUrl: "https://imagery.example/{z}/{x}/{y}.jpg",
    },
  });
  // The trailing slash is trimmed, so the joins below cannot double it.
  assert.equal(config.TILES_BASE, "https://s3.example/glace");
  assert.equal(config.LAYER_MANIFEST_URL, "https://s3.example/glace/layers.json");
  assert.equal(config.GRID_ARCHIVE_URL, "https://s3.example/glace/grid-v2.pmtiles");
  assert.equal(config.WORLD_IMAGERY_URL, "https://imagery.example/{z}/{x}/{y}.jpg");
});

test("a partial nested override keeps the rest of the object", async () => {
  const view = await load({ site: { initialView: { zoom: 8 } } });
  assert.equal(view.INITIAL_VIEW.zoom, 8);
  assert.deepEqual(view.INITIAL_VIEW.center, [10.4, 46.5]);
  assert.equal(view.INITIAL_VIEW.maxZoom, 14);

  const credit = await load({ site: { terrainCredit: { citation: "© Someone" } } });
  assert.equal(credit.TERRAIN_CREDIT.citation, "© Someone");
  assert.equal(credit.TERRAIN_CREDIT.title, "Mapterhorn Terrain Tiles");
  assert.equal(credit.TERRAIN_CREDIT.links.length, 2);
});

test("query parameters win over site config", async () => {
  const config = await load({
    search: "?tiles=https://other.example/x&basemap=https://other.example/b.pmtiles&flavor=dark",
    site: { tilesBase: "https://s3.example/glace", basemapFlavor: "light" },
  });
  assert.equal(config.TILES_BASE, "https://other.example/x");
  assert.equal(config.BASEMAP_URL, "https://other.example/b.pmtiles");
  assert.equal(config.BASEMAP_FLAVOR, "dark");
});

test("an empty query parameter does not blank a setting", async () => {
  const config = await load({ search: "?tiles=", site: { tilesBase: "https://s3.example/glace" } });
  assert.equal(config.TILES_BASE, "https://s3.example/glace");
});

test("deployment-only settings are not reachable from the address bar", async () => {
  const config = await load({
    search: "?gridSourceLayer=nope&inventoryBase=/etc&initialView=x&terrainTilejson=http://evil",
  });
  assert.equal(config.GRID_SOURCE_LAYER, "grid");
  assert.equal(config.INVENTORY_BASE, "data");
  assert.equal(config.TERRAIN_TILEJSON, "https://tiles.mapterhorn.com/tilejson.json");
  assert.deepEqual(config.INITIAL_VIEW, { center: [10.4, 46.5], zoom: 6.2, maxZoom: 14 });
});

test("a misspelled setting warns instead of silently doing nothing", async () => {
  const warnings = await captureWarnings(() => load({ site: { tileBase: "oops" } }));
  assert.ok(warnings.some((line) => line.includes("tileBase")));
});

test("the committed site-config.js parses and sets no overrides", async () => {
  // The template ships enabled but empty; a stray uncommented key here would
  // change every deployment that does not replace the file.
  const { window } = installBrowser();
  const source = fs.readFileSync(path.join(REPO, "site-config.js"), "utf8");
  new Function("window", source)(window);
  assert.deepEqual(window.GLACE_CONFIG, {});
});
