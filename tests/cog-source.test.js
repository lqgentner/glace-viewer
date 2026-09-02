/*
 * The tile-source switch: one layer, two archives.
 *
 * A layer may be published twice — as the pre-styled PMTiles the build has
 * always written, and as the float COG it was styled from. The page reads
 * either, and the two have to be interchangeable: same ramp, same stretch, same
 * place in the draw order, neither torn down when the other is shown.
 *
 * Its own file rather than a subtest of viewer.test.js because the modules hold
 * state at module scope and the map is a singleton — a second manifest needs a
 * second process, which `node --test` gives each file.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { installBrowser, load, REPO, settle } from "./helpers/browser.js";

/* COH12 VV carries a COG in both years; nothing else does. That is what makes
 * the disabled button and the fall back to PMTiles reachable. */
const FIXTURE = path.join(REPO, "tests", "fixtures", "layers-cog.json");
const MANIFESTS = {
  "tiles/layers.json": FIXTURE,
  "data/inventories.json": path.join(REPO, "data", "inventories.json"),
};

const glaceLayers = (map) => [...map.layers.keys()].filter((id) => id.startsWith("glace-"));
const visible = (map, id) => map.getLayer(id)?.layout?.visibility === "visible";
const buttons = (el, id) => Object.fromEntries([...el(id).children].map((b) => [b.dataset.value, b]));

test("the tile-source switch", async (t) => {
  const page = installBrowser({
  files: MANIFESTS,
  // The COG path reads through js/cog-rgb.js; see cog-rgb.test.js for the seam.
  site: { cogReaderUrl: new URL("./fixtures/fake-geotiff.mjs", import.meta.url).href },
});
  const { el } = page;

  await load("js/app.js");
  const { map } = page;
  map.fire("style.load");
  await settle();

  await t.test("the switch appears, and the page opens on PMTiles", () => {
    assert.equal(el("source-row").hidden, false);
    assert.deepEqual(
      [...el("source").children].map((b) => b.textContent),
      ["PMTiles", "COG"],
    );
    // PMTiles first because that is what a deployment has always published;
    // opening on the newer path would change what an existing link shows.
    assert.deepEqual(glaceLayers(map), ["glace-pmtiles-coh12_vv_2023"]);
    assert.equal(buttons(el, "source").pmtiles.getAttribute("aria-checked"), "true");
  });

  await t.test("switching to the COG adds it beside the archive it replaces", async () => {
    buttons(el, "source").cog.click();
    await settle();

    assert.ok(visible(map, "glace-cog-coh12_vv_2023"));
    assert.equal(visible(map, "glace-pmtiles-coh12_vv_2023"), false, "hidden, not removed");
    assert.ok(map.getSource("glace-pmtiles-coh12_vv_2023"), "so switching back is instant");
  });

  await t.test("the COG source names a recipe rather than an archive", () => {
    /* Both COG layers — one archive through a ramp, two combined into false
     * colour — go through this page's own protocol, so the source carries a
     * tile template naming the recipe rather than a URL naming a file. What
     * the recipe resolves to is cog-rgb.test.js's subject. */
    assert.deepEqual(
      map.getSource("glace-cog-coh12_vv_2023").tiles,
      ["glace-rgb://glace-cog-coh12_vv_2023/{z}/{x}/{y}"],
    );
  });

  await t.test("a layer published only as PMTiles disables the button", async () => {
    buttons(el, "pol").VH.click();
    await settle();

    const source = buttons(el, "source");
    assert.equal(source.cog.disabled, true, "COG has nothing to read for this layer");
    assert.ok(visible(map, "glace-pmtiles-coh12_vh_2023"), "and the layer still draws");
    assert.equal(
      map.getLayer("glace-cog-coh12_vh_2023"),
      undefined,
      "no COG layer is created for an archive that does not exist",
    );
  });

  await t.test("coming back to a layer that has one honours the switch again", async () => {
    buttons(el, "pol").VV.click();
    await settle();

    assert.equal(buttons(el, "source").cog.disabled, false);
    assert.ok(visible(map, "glace-cog-coh12_vv_2023"), "the choice was remembered, not reset");
  });

  await t.test("the COG draws in the data slot, under the basemap labels", () => {
    assert.ok(map.indexOf("glace-cog-coh12_vv_2023") < map.indexOf("places"));
  });
});
