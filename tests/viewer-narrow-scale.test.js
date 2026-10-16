/*
 * The scale bar's corner on a phone and across the breakpoint.
 *
 * Its own file: modules hold state and the map is a singleton, so it needs a
 * fresh page apart from viewer-narrow.test.js.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { installBrowser, load, REPO, settle } from "./helpers/browser.js";

test("the scale bar follows the breakpoint between the corners", async () => {
  const page = installBrowser({
    narrow: true,
    files: { "data/inventories.json": path.join(REPO, "data", "inventories.json") },
  });
  await load("js/app.js");
  await settle();
  const { map } = page;
  const isA = (cls) => (c) => c instanceof globalThis.maplibregl[cls];
  const scale = () => map.controls.find(isA("ScaleControl"));
  const credit = () => map.controls.find(isA("AttributionControl"));

  assert.equal(map.positions.get(scale()), "bottom-left");

  page.setNarrow(false);
  assert.equal(map.positions.get(scale()), "bottom-right");
  assert.ok(map.controls.indexOf(scale()) > map.controls.indexOf(credit()));
  assert.equal(map.controls.filter(isA("ScaleControl")).length, 1);

  page.setNarrow(true);
  assert.equal(map.positions.get(scale()), "bottom-left");
});
