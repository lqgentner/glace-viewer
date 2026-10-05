/*
 * Inspect a local copy of a store, as `serve --tiles-dir` with ?tiles=tiles does
 * for a build not yet published. Archives resolve against the item they were
 * read from, so the page draws the copy's own archives rather than the
 * configured public root's. A separate process isolates the configuration.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { installBrowser, load, REPO, settle } from "./helpers/browser.js";

const FIXTURES = path.join(REPO, "tests", "fixtures", "store");
/* The years the collection links an item for. */
const YEARS = JSON.parse(fs.readFileSync(path.join(FIXTURES, "collection.json"), "utf8"))
  .links.filter((link) => link.rel === "item")
  .map((link) => Number(/\d{4}/.exec(link.href)[0]));

const page = installBrowser({
  search: "?tiles=tiles",
  site: { tilesBase: "https://data.source.coop/giuz/glace-alps" },
  files: {
    "http://localhost/tiles/mosaics/collection.json": path.join(FIXTURES, "collection.json"),
    ...Object.fromEntries(
      YEARS.flatMap((year) => [
        [`http://localhost/tiles/mosaics/styles/${year}.json`, path.join(FIXTURES, `style-${year}.json`)],
        [`http://localhost/tiles/mosaics/${year}/item.json`, path.join(FIXTURES, `item-${year}.json`)],
      ]),
    ),
    "data/inventories.json": path.join(REPO, "data", "inventories.json"),
  },
});

await load("js/app.js");
page.map.fire("style.load");
await settle();

test("a local copy draws its own archives", () => {
  assert.equal(
    page.map.getSource("glace-coh12_vv-2025").url,
    "pmtiles://http://localhost/tiles/mosaics/2025/coh12_vv_viz.pmtiles",
  );
});
