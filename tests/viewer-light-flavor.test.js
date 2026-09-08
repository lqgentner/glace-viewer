/*
 * The page on a light flavor, `?flavor=light`.
 *
 * Its own file because the flavor is read once, at import time, and the map is
 * a module singleton — the same reason viewer-3d-restore.test.js stands apart.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { installBrowser, load, REPO, settle } from "./helpers/browser.js";

test("a light flavor's labels are pulled to black, the inverse of the dark treatment", async () => {
  const page = installBrowser({
    search: "?flavor=light",
    files: { "data/inventories.json": path.join(REPO, "data", "inventories.json") },
  });

  await load("js/app.js");
  const { map } = page;
  await settle();

  for (const id of ["places", "roads_label"]) {
    const { paint } = map.getLayer(id);
    assert.equal(paint["text-color"], "#000000", `${id} face`);
    assert.equal(paint["text-halo-color"], "#ffffff", `${id} halo`);
    assert.equal(paint["text-halo-width"], 1, `${id} keeps the generator's halo width`);
  }
});
