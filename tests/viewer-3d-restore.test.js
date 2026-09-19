/*
 * Restore terrain from a pitched hash. A separate test process provides a fresh map
 * singleton.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { installBrowser, load, REPO, settle } from "./helpers/browser.js";

test("a pitched #hash comes back in 3D", async () => {
  const page = installBrowser({
    pitch: 55,
    files: { "data/inventories.json": path.join(REPO, "data", "inventories.json") },
  });

  await load("js/app.js");
  const { map } = page;
  await settle();
  map.fire("style.load");
  await settle();

  assert.deepEqual(map.getTerrain(), { source: "terrain", exaggeration: 1 });
  assert.equal(
    map.pitch,
    55,
    "the shared view is kept as it was, not rounded off to the button's own 60°",
  );
  assert.equal(page.control(".maplibregl-ctrl-3d").textContent, "2D");

  // Nothing ticked the hillshade, so the 3D path is what created the DEM.
  assert.ok(map.getSource("terrain"));
  assert.equal(map.getLayer("hillshade"), undefined);
});
