/*
 * The page with neither the catalog nor the inventory index: only the Map tab is
 * left. Its own file because the map is a module singleton.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { captureWarnings, installBrowser, load, settle } from "./helpers/browser.js";

test("without the catalog and the inventory index, the Map tab is selected", async () => {
  // Nothing is served, so both reads answer 404.
  const { el } = installBrowser();

  const warnings = await captureWarnings(async () => {
    await load("js/app.js");
    await settle();
  });
  assert.ok(warnings.some((line) => line.startsWith("rasters:")), "the console says why");

  assert.equal(el("tab-layers").hidden, true);
  assert.equal(el("tab-inventories").hidden, true);
  assert.equal(el("tabs").querySelector('[aria-selected="true"]'), el("tab-map"));
  assert.equal(el("extras").hidden, false);
  assert.equal(el("inventories-section").hidden, true);
});
