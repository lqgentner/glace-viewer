/*
 * End-to-end smoke test of the page against a fake MapLibre.
 *
 * The modules hold state at module scope and the map is a singleton, so this is
 * one ordered scenario rather than independent cases: the page boots, controls
 * are used while the basemap is still streaming, the style arrives, and the
 * overlays are exercised from there. Subtests are awaited in order.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { captureWarnings, installBrowser, load, REPO, settle } from "./helpers/browser.js";

/* A committed fixture rather than tiles/layers.json, which is a local build
 * artefact and absent in CI. It carries two years and one combination that
 * exists in only one of them, so the disabled-button and no-layer-for-this-year
 * paths are reachable. The real manifest is checked in manifest.test.js. */
const MANIFESTS = {
  "tiles/layers.json": path.join(REPO, "tests", "fixtures", "layers.json"),
  "data/inventories.json": path.join(REPO, "data", "inventories.json"),
};

const glaceLayers = (map) => [...map.layers.keys()].filter((id) => id.startsWith("glace-"));
const visible = (map, id) => map.getLayer(id)?.layout?.visibility === "visible";

test("the viewer", async (t) => {
  const page = installBrowser({ files: MANIFESTS });
  const { el, change, input } = page;

  await load("js/app.js");
  const { map } = page;
  await settle();

  await t.test("controls answer before the style has loaded", async () => {
    assert.equal(map.getLayer("hillshade"), undefined, "terrain is not fetched up front");

    change(el("hillshade"), true);
    change(el("grid"), true);
    change(el("basemap"), false);
    await settle();

    // The panel updates at once; only the map waits.
    assert.equal(el("hillshade-strength-row").hidden, false);
    assert.ok(
      !map.calls.some((call) => call.startsWith("+")),
      `nothing added to the map yet, got: ${map.calls.join(", ")}`,
    );
  });

  await t.test("ticks made during loading are honoured when the style arrives", async () => {
    map.fire("style.load");
    await settle();
    map.settle();

    assert.ok(map.getLayer("hillshade"), "hillshade created from the early tick");
    assert.ok(visible(map, "hillshade"));
    assert.ok(map.getLayer("grid-fill") && map.getLayer("grid-line"), "grid created");
    assert.equal(map.getLayer("places").layout.visibility, "none", "basemap labels hidden");
    assert.equal(el("status").hidden, true, "loading messages cleared");
  });

  await t.test("only the selected raster is created", async () => {
    // The first layer decides product and polarization, the newest year wins.
    assert.deepEqual(glaceLayers(map), ["glace-coh12_vv_2023"]);
    assert.ok(visible(map, "glace-coh12_vv_2023"));
    assert.equal(el("year-value").textContent, "2023");
  });

  await t.test("data draws under the hillshade, and both under the labels", async () => {
    assert.ok(map.indexOf("glace-coh12_vv_2023") < map.indexOf("hillshade"));
    assert.ok(map.indexOf("hillshade") < map.indexOf("places"));
  });

  await t.test("the view is framed to the union of the archives", async () => {
    assert.ok(map.fitted, "fitBounds called when the URL carries no hash");
    // The union of both years' footprints, not either one alone.
    assert.deepEqual(map.fitted.bounds, [4.5, 43.5, 12.5, 48.5]);
    assert.equal(map.fitted.options.animate, false);
  });

  await t.test("changing product adds the new raster and hides the old", async () => {
    el("product").querySelector('[data-value="RTC"]').click();
    await settle();

    const added = glaceLayers(map);
    assert.equal(added.length, 2, "the previous layer is kept for instant scrubbing");
    assert.deepEqual(added.filter((id) => visible(map, id)), ["glace-rtc_vv_2023"]);
  });

  await t.test("opacity applies to the visible raster", async () => {
    input(el("opacity"), "40");
    await settle();
    assert.equal(map.getLayer("glace-rtc_vv_2023").paint["raster-opacity"], 0.4);
    assert.equal(el("opacity-value").textContent, "40%");
  });

  await t.test("a new layer inherits the current opacity", async () => {
    el("pol").querySelector('[data-value="VH"]').click();
    await settle();
    assert.equal(map.getLayer("glace-rtc_vh_2023").paint["raster-opacity"], 0.4);
  });

  await t.test("a year with no archive for this combination is reported", async () => {
    // RTC/VH exists only in 2023; scrubbing back must say so rather than throw.
    input(el("year"), "0");
    await settle();

    assert.equal(el("year-value").textContent, "2022");
    assert.equal(el("status").textContent, "No RTC VH layer for 2022");
    assert.equal(el("layer-info").textContent, "");
    assert.equal(
      glaceLayers(map).filter((id) => visible(map, id)).length,
      0,
      "the previous layer is hidden rather than left showing the wrong year",
    );
  });

  await t.test("a product that does have that year stays selectable", async () => {
    const button = (node, value) => el(node).querySelector(`[data-value="${value}"]`);
    assert.equal(button("product", "COH12").disabled, false, "COH12 VH 2022 exists");
    assert.equal(button("pol", "VH").disabled, false, "the current choice is never disabled");

    button("product", "COH12").click();
    await settle();
    assert.deepEqual(glaceLayers(map).filter((id) => visible(map, id)), ["glace-coh12_vh_2022"]);
    assert.equal(el("status").hidden, true, "the message clears once a layer exists again");
  });

  await t.test("the strength slider drives the shadow alpha", async () => {
    input(el("hillshade-strength"), "20");
    await settle();
    assert.equal(map.getLayer("hillshade").paint["hillshade-shadow-color"], "rgba(0, 0, 0, 0.200)");
    assert.equal(el("hillshade-strength-value").textContent, "20%");
  });

  await t.test("the shading is neutral, so the colour ramp keeps its hue", async () => {
    // A hue of its own would shift the colour map underneath it — a brown
    // shadow over cmc.lipari is no longer cmc.lipari.
    const grey = /^(#(?:0{6}|F{6})|rgba\((\d+), \2, \2, [\d.]+\))$/i;
    for (const property of ["shadow", "highlight", "accent"]) {
      const colour = map.getLayer("hillshade").paint[`hillshade-${property}-color`];
      assert.match(colour, grey, `${property} is off-grey: ${colour}`);
    }
  });

  await t.test("3D tilts the camera and drapes the map over the shared DEM", async () => {
    const threeD = page.control(".maplibregl-ctrl-3d");
    assert.equal(threeD.textContent, "3D", "the button names what the next press does");
    assert.equal(map.getTerrain(), null);

    threeD.click();
    await settle();
    assert.deepEqual(map.getTerrain(), { source: "terrain", exaggeration: 1 });
    assert.equal(map.pitch, 60, "enabling 3D slants the view");
    assert.equal(threeD.textContent, "2D");
    assert.equal(threeD.getAttribute("aria-pressed"), "true");

    threeD.click();
    await settle();
    assert.equal(map.getTerrain(), null);
    assert.equal(map.pitch, 0, "disabling reverts to the overhead view");
    assert.equal(threeD.textContent, "3D");
    assert.ok(map.getSource("terrain"), "the DEM stays for the hillshade");
  });

  await t.test("unticking the hillshade hides it rather than tearing it down", async () => {
    change(el("hillshade"), false);
    await settle();
    assert.equal(map.getLayer("hillshade").layout.visibility, "none");
    assert.ok(map.getSource("terrain"), "the terrain source is kept for the next tick");
  });

  await t.test("the inventory list is built from the index", async () => {
    assert.equal(el("inventories").children.length, 3);
    assert.equal(el("inventories-section").hidden, false);
    assert.ok(el("inv-sgi2023"), "each row is keyed by inventory id");
  });

  await t.test("an inventory loads on first tick", async () => {
    change(el("inv-sgi2023"), true);
    await settle();
    assert.ok(map.getSource("inv-sgi2023"));
    assert.ok(map.getLayer("inv-line-sgi2023-casing") && map.getLayer("inv-line-sgi2023"));

    assert.ok(el("status").textContent.includes("Swiss Glacier Inventory 2023"));
    map.settle();
    assert.equal(el("status").hidden, true, "the message clears when the source loads");
  });

  await t.test("a popup reports every overlay under the pointer", async () => {
    map.hits = [
      { layer: { id: "inv-line-sgi2023" }, properties: { name: "Aletschgletscher", year: 2023 } },
      { layer: { id: "grid-fill" }, properties: { tile: "32TMS", glacier_fraction: 0.42 } },
    ];
    map.fire("click", { point: { x: 10, y: 10 }, lngLat: [8, 46] });

    assert.equal(page.popups.length, 1);
    const text = page.popups.at(-1).content.textContent;
    assert.ok(text.includes("Aletschgletscher"));
    assert.ok(text.includes("32TMS"));
    assert.ok(text.includes("32N"), "the UTM zone is read off the tile name");
    assert.ok(text.includes("42.0 %"));
  });

  await t.test("markup in a feature property stays text", async () => {
    map.hits = [
      {
        layer: { id: "inv-line-sgi2023" },
        properties: { name: '<img src=x onerror="fail()">', year: 2023 },
      },
    ];
    map.fire("click", { point: { x: 10, y: 10 }, lngLat: [8, 46] });

    const { content } = page.popups.at(-1);
    const wrapper = page.window.document.createElement("div");
    wrapper.append(content);
    assert.equal(wrapper.querySelector("img"), null, "no element was parsed out of the value");
    assert.ok(wrapper.textContent.includes("<img src=x"), "the value is shown verbatim");
  });

  await t.test("a failed overlay rolls back so re-ticking retries", async () => {
    change(el("inv-sgi2016"), true);
    await settle();
    assert.ok(map.getSource("inv-sgi2016"));

    await captureWarnings(async () => {
      map.fire("error", { sourceId: "inv-sgi2016", error: new Error("HTTP 404") });
      await settle();
    });

    assert.equal(map.getSource("inv-sgi2016"), undefined);
    assert.equal(map.getLayer("inv-line-sgi2016"), undefined);
    assert.equal(el("inv-sgi2016").checked, false, "the box is unticked");
    assert.ok(el("status").textContent.includes("HTTP 404"));

    change(el("inv-sgi2016"), true);
    await settle();
    assert.ok(map.getSource("inv-sgi2016"), "the second attempt is a fresh load");
  });

  await t.test("a failure is not cleared by an unrelated success", async () => {
    // Both write to one status element; the keys are what keep them apart. The
    // previous subtest left sgi2016 loading again, so it is still being watched.
    change(el("inv-pauletal2020"), true);
    await settle();
    assert.match(el("status").textContent, /Loading Alpine Glacier Inventory/);

    await captureWarnings(async () => {
      map.fire("error", { sourceId: "inv-sgi2016", error: new Error("HTTP 500") });
      await settle();
    });
    assert.match(el("status").textContent, /HTTP 500/, "a failure outranks another's progress");

    map.settle();
    await settle();
    assert.match(
      el("status").textContent,
      /HTTP 500/,
      "the other inventory finishing must not wipe the failure",
    );
  });
});
