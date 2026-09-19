/*
 * Ordered page scenario against fake MapLibre. Await subtests because modules share
 * state: boot, interact before style readiness, then exercise overlays.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { captureWarnings, installBrowser, load, REPO, settle } from "./helpers/browser.js";

/*
 * The two-year fixture has missing combinations and a style for only the newer
 * year, exercising disabled controls and older-year fallback. store-catalog.test.js
 * covers the published catalog fixture.
 */
const CATALOG = {
  "http://localhost/tiles/mosaics/collection.json": path.join(REPO, "tests", "fixtures", "two-years", "collection.json"),
  "http://localhost/tiles/mosaics/style.json": path.join(REPO, "tests", "fixtures", "two-years", "style.json"),
  "data/inventories.json": path.join(REPO, "data", "inventories.json"),
};

const glaceLayers = (map) => [...map.layers.keys()].filter((id) => id.startsWith("glace-"));
const visible = (map, id) => map.getLayer(id)?.layout?.visibility === "visible";

test("the viewer", async (t) => {
  const page = installBrowser({
    files: CATALOG,
    // The tile grid imports its parquet reader; this is the same seam a
    // deployment would use to pin a different CDN. See tile-grid.test.js.
    site: { hyparquetUrl: new URL("./fixtures/fake-hyparquet.mjs", import.meta.url).href },
  });
  const { el, change, input } = page;

  await load("js/app.js");
  const { map } = page;
  await settle();

  await t.test("a wide viewport opens with the panel expanded", async () => {
    const collapsed = () => el("panel").classList.contains("collapsed");
    assert.equal(collapsed(), false);
    assert.equal(el("panel").classList.contains("expanded"), true);
    assert.equal(el("panel-toggle").getAttribute("aria-expanded"), "true");

    el("panel-toggle").click();
    assert.equal(collapsed(), true, "and can still be collapsed by hand");
    assert.equal(el("panel").classList.contains("expanded"), false);
    assert.equal(el("panel-toggle").getAttribute("aria-expanded"), "false");
    // `up` marks the collapsed state here as it does on the inventories toggle.
    assert.ok(el("panel-toggle").querySelector(".chevron").classList.contains("up"));

    el("panel-toggle").click();
    assert.equal(collapsed(), false);
  });

  await t.test("rotating onto a narrow screen collapses it again", async () => {
    page.setNarrow(true);
    assert.ok(el("panel").classList.contains("collapsed"), "the new width's default wins");
    page.setNarrow(false);
    assert.ok(el("panel").classList.contains("expanded"));
  });

  await t.test("the style asks for a globe that flattens as you zoom in", async () => {
    // The bare `globe` type is a zoom interpolation, not a permanent globe:
    // MapLibre expands it to vertical-perspective at z11 and mercator at z12.
    assert.deepEqual(map.options.style.projection, { type: "globe" });
    assert.ok(map.options.zoom < 11, "the opening view is inside the round part");
  });

  await t.test("the sky comes out once the globe no longer fills the viewport", async () => {
    // jsdom lays nothing out, so the map's box is given a size by hand.
    Object.defineProperty(el("map"), "clientWidth", { value: 1600, configurable: true });
    Object.defineProperty(el("map"), "clientHeight", { value: 1000, configurable: true });
    map.zoom = 1;
    map.fire("move");
    assert.ok(el("map").classList.contains("sky"), "the halo and stars are painted");
    map.zoom = 10;
    map.fire("move");
    assert.equal(el("map").classList.contains("sky"), false, "and not over a glacier");
  });

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
    // The head of each axis decides product and polarization; newest year wins.
    assert.deepEqual(glaceLayers(map), ["glace-coh12_vv-2023"]);
    assert.ok(visible(map, "glace-coh12_vv-2023"));
    assert.equal(el("year-value").textContent, "2023");
  });

  await t.test("the panel opens on VV, and names the products in words", async () => {
    const faces = (id) => [...el(id).children].map((b) => b.textContent);
    assert.deepEqual(faces("product"), ["Coherence", "Backscatter"]);
    // The catalog's own spelling stays on the button, so nothing downstream has
    // to translate back.
    assert.deepEqual(
      [...el("product").children].map((b) => b.dataset.value),
      ["COH12", "RTC"],
    );

    assert.deepEqual(faces("pol"), ["VV", "VH"], "VV is the left-hand button");
    const checked = (id) =>
      [...el(id).children].find((b) => b.getAttribute("aria-checked") === "true");
    assert.equal(checked("pol").dataset.value, "VV", "and the one selected");
    assert.equal(checked("product").dataset.value, "COH12");
  });

  await t.test("a catalog with no QA rasters shows no quantity row", async () => {
    // The fixture publishes none, as any build before them does. One button is
    // not a choice, so the row hides itself rather than standing there inert.
    assert.equal(el("quantity-row").hidden, true);
    assert.deepEqual([...el("quantity").children].map((b) => b.dataset.value), [""]);
  });

  await t.test("the description sits under the ramp and says what the layer is", async () => {
    assert.deepEqual(
      [...el("layer-info").children].map((line) => line.textContent),
      ["Composite Coherence", "12-day baseline", "Local resolution weighted median"],
    );
    // Under the color ramp rather than in a footer: it describes what the
    // controls above it just selected.
    assert.ok(el("raster-controls").contains(el("layer-info")));
    assert.ok(
      el("legend").compareDocumentPosition(el("layer-info")) &
        page.window.Node.DOCUMENT_POSITION_FOLLOWING,
      "and after the legend, not before it",
    );
  });

  await t.test("the scale carries the color map's credit", async () => {
    const credit = el("legend-credit").querySelector("button.credit");
    assert.ok(credit, "an info mark beside the SCALE heading");

    credit.click();
    const popover = page.window.document.querySelector(".credit-popover");
    assert.match(popover.textContent, /Colormap: lipari/, "cmc. prefix stripped");
    assert.match(popover.textContent, /Fabio Crameri/);
    assert.equal(
      popover.querySelector("a").href,
      "https://www.fabiocrameri.ch/colourmaps/",
    );
    credit.click();
  });

  await t.test("the additional layers start collapsed", async () => {
    assert.equal(el("extras").hidden, true);
    assert.equal(el("extras-toggle").getAttribute("aria-expanded"), "false");
    // The toggles moved inside it, and still work from there.
    assert.ok(el("extras").contains(el("hillshade-row")));
    assert.ok(el("extras").contains(el("grid")));
    assert.ok(el("extras").contains(el("basemap")));
    assert.ok(el("extras").contains(el("basemap-style")));

    el("extras-toggle").click();
    assert.equal(el("extras").hidden, false);
    assert.equal(el("extras-toggle").getAttribute("aria-expanded"), "true");
  });

  await t.test("the dark flavor's labels are lifted through the flavor, not patched after", async () => {
    // The generator reads label colors from the flavor it is handed, so the
    // override reaches every text layer with the generator's own 1 px halo —
    // a wider, blurred one drew a gray ring around small labels.
    for (const id of ["places", "roads_label"]) {
      const { paint } = map.getLayer(id);
      assert.equal(paint["text-color"], "#f8fafc", `${id} face`);
      assert.equal(paint["text-halo-color"], "#000000", `${id} halo`);
      assert.equal(paint["text-halo-width"], 1, `${id} keeps the generator's halo width`);
      assert.equal(paint["text-halo-blur"], undefined, `${id} is not blurred`);
    }
  });

  await t.test("World Imagery replaces the vector fills but keeps labels independent", async () => {
    const buttons = [...el("basemap-style").children];
    assert.deepEqual(
      buttons.map((button) => button.textContent),
      ["Vector", "World Imagery"],
    );
    assert.equal(buttons[0].getAttribute("aria-checked"), "true");
    assert.equal(map.getSource("world-imagery"), undefined, "imagery is lazy");

    buttons[1].click();
    await settle();
    const source = map.getSource("world-imagery");
    assert.deepEqual(source.tiles, [
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    ]);
    assert.equal(source.type, "raster");
    assert.match(source.attribution, /^© Esri, Maxar/, "worded like the credits it sits beside");
    assert.doesNotMatch(source.attribution, /maplibre\.org/, "the renderer is not Esri's to credit");
    assert.ok(visible(map, "world-imagery"));
    assert.equal(map.getLayer("earth").layout.visibility, "none");
    assert.equal(map.getLayer("water").layout.visibility, "none");
    assert.equal(map.getLayer("places").layout.visibility, "none", "the label toggle still wins");
    assert.ok(map.indexOf("world-imagery") < map.indexOf("glace-coh12_vv-2023"));

    change(el("basemap"), true);
    await settle();
    assert.equal(map.getLayer("places").layout.visibility, "visible", "labels overlay imagery");

    assert.equal(map.getLayer("places").paint["text-halo-width"], 1, "labels are not repainted over imagery");

    buttons[0].click();
    await settle();
    assert.equal(map.getLayer("world-imagery").layout.visibility, "none");
    assert.equal(map.getLayer("earth").layout.visibility, "visible");
    assert.equal(map.getLayer("water").layout.visibility, "visible");
  });

  await t.test("each layer credits the source it is actually drawing", async () => {
    /* Two sources declare none of their own — the GLACE archives and the DEM —
     * because each publishes its credit and a spec-level string would override
     * it. The fake map does no fetching, so what is assertable is that the page
     * leaves the field alone, and that the credit still appears conditionally:
     * MapLibre keys that on the source, not on where the string came from. */
    assert.equal(map.getSource("glace-coh12_vv-2023").attribution, undefined);
    assert.equal(map.getSource("terrain").attribution, undefined);
    assert.equal(map.getSource("terrain").url, "https://tiles.mapterhorn.com/tilejson.json");
    assert.match(
      el("hillshade-row").querySelector("button.credit").getAttribute("aria-label"),
      /Mapterhorn/,
      "and the panel credits the DEM from configuration either way",
    );

    // These two ride in one string so the length sort cannot scatter them.
    const basemap = map.getSource("protomaps").attribution;
    assert.match(basemap, /openstreetmap\.org\/copyright.*OpenStreetMap contributors/);
    assert.ok(
      basemap.indexOf("OpenStreetMap") < basemap.indexOf("Protomaps"),
      "OpenStreetMap, then Protomaps",
    );
  });

  await t.test("the renderer is credited by the control, not by a basemap", async () => {
    /* A source is handed its attribution only once its TileJSON resolves, so
     * every credit riding on one is conditional on that request — which is why
     * the renderer's cannot. It is drawing whether the basemap loaded, failed,
     * or was swapped for the imagery. */
    const attribution = map.controls.find(
      (control) => control instanceof globalThis.maplibregl.AttributionControl,
    );
    assert.match(attribution.options.customAttribution, /maplibre\.org/);

    for (const id of ["protomaps", "world-imagery"]) {
      assert.doesNotMatch(map.getSource(id).attribution, /maplibre\.org/, `${id} does not repeat it`);
    }
  });

  await t.test("data draws under the hillshade, and both under the labels", async () => {
    assert.ok(map.indexOf("glace-coh12_vv-2023") < map.indexOf("hillshade"));
    assert.ok(map.indexOf("hillshade") < map.indexOf("places"));
    // The grid was ticked before the style loaded, so it was created before the
    // hillshade; it still has to end up above it and below the labels.
    assert.ok(map.indexOf("hillshade") < map.indexOf("grid-fill"), "overlays sit above relief");
    assert.ok(map.indexOf("grid-line") < map.indexOf("places"), "and under the basemap labels");
  });

  await t.test("the view opens on the configured default rather than the data's own bounds", async () => {
    assert.deepEqual(map.options.center, [8.03, 46.51]);
    assert.equal(map.options.zoom, 10);
    assert.equal(map.options.minZoom, 1, "and cannot zoom out past a whole earth");
  });

  await t.test("changing product adds the new raster and hides the old", async () => {
    el("product").querySelector('[data-value="RTC"]').click();
    await settle();

    const added = glaceLayers(map);
    assert.equal(added.length, 2, "the previous layer is kept for instant scrubbing");
    assert.deepEqual(added.filter((id) => visible(map, id)), ["glace-rtc_vv-2023"]);
  });

  await t.test("opacity applies to the visible raster", async () => {
    input(el("opacity"), "40");
    await settle();
    assert.equal(map.getLayer("glace-rtc_vv-2023").paint["raster-opacity"], 0.4);
    assert.equal(el("opacity-value").textContent, "40%");
  });

  await t.test("a new layer inherits the current opacity", async () => {
    el("pol").querySelector('[data-value="VH"]').click();
    await settle();
    assert.equal(map.getLayer("glace-rtc_vh-2023").paint["raster-opacity"], 0.4);
  });

  await t.test("a year with no archive for this combination is reported", async () => {
    // RTC/VH exists only in 2023; scrubbing back must say so rather than throw.
    input(el("year"), "0");
    await settle();

    assert.equal(el("year-value").textContent, "2022");
    assert.equal(el("status").textContent, "No Backscatter VH layer for 2022");
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
    assert.deepEqual(glaceLayers(map).filter((id) => visible(map, id)), ["glace-coh12_vh-2022"]);
    assert.equal(el("status").hidden, true, "the message clears once a layer exists again");

    /* And now RTC is the one with nothing for this year. That is a gap in the
     * data rather than a combination that cannot exist, so the click is refused
     * outright — there is no other row to move that would rescue it, and moving
     * the year is the reader's call. */
    assert.equal(button("product", "RTC").disabled, true, "RTC VH 2022 was never built");
    assert.equal(button("product", "RTC").hasAttribute("aria-disabled"), false);
  });

  await t.test("the strength slider drives the shadow alpha", async () => {
    input(el("hillshade-strength"), "20");
    await settle();
    assert.equal(map.getLayer("hillshade").paint["hillshade-shadow-color"], "rgba(0, 0, 0, 0.200)");
    assert.equal(el("hillshade-strength-value").textContent, "20%");
  });

  await t.test("the shading is neutral, so the color ramp keeps its hue", async () => {
    // A hue of its own would shift the color map underneath it — a brown
    // shadow over cmc.lipari is no longer cmc.lipari.
    const gray = /^(#(?:0{6}|F{6})|rgba\((\d+), \2, \2, [\d.]+\))$/i;
    for (const property of ["shadow", "highlight", "accent"]) {
      const color = map.getLayer("hillshade").paint[`hillshade-${property}-color`];
      assert.match(color, gray, `${property} is off-gray: ${color}`);
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
    assert.equal(el("inventories").children.length, 5);
    assert.equal(el("inventories-section").hidden, false);
    assert.ok(el("inv-sgi2023"), "each row is keyed by inventory id");
  });

  await t.test("an inventory loads on first tick", async () => {
    change(el("inv-sgi2023"), true);
    await settle();
    assert.ok(map.getSource("inv-sgi2023"));
    assert.ok(map.getLayer("inv-line-sgi2023-casing") && map.getLayer("inv-line-sgi2023"));
    // Added last of all, and still under the labels rather than on top of them.
    assert.ok(map.indexOf("inv-line-sgi2023") < map.indexOf("places"));
    assert.ok(map.indexOf("inv-line-sgi2023-casing") < map.indexOf("inv-line-sgi2023"));
    assert.ok(map.indexOf("hillshade") < map.indexOf("inv-line-sgi2023-casing"));

    assert.ok(el("status").textContent.includes("Swiss Glacier Inventory 2023"));
    map.settle();
    assert.equal(el("status").hidden, true, "the message clears when the source loads");
  });

  await t.test("the swatch picks an outline color, now or for when the layer is added", async () => {
    const swatch = (id) => el(`inv-${id}`).parentElement.querySelector(".swatch");
    const palette = () => page.window.document.querySelector(".palette-popover");
    const chip = (color) => palette().querySelector(`[aria-label="${color}"]`);

    assert.equal(palette(), null);
    swatch("sgi2023").dispatchEvent(new page.window.Event("mouseenter"));
    swatch("sgi2023").dispatchEvent(new page.window.Event("focus"));
    assert.equal(palette(), null, "only a click opens it");

    swatch("sgi2023").click();
    // In the body, like the credit popover, so it can reach past the panel.
    assert.equal(palette().parentElement, page.window.document.body);
    assert.equal(palette().children.length, 9);
    assert.ok(swatch("sgi2023").classList.contains("popover-open"), "the disc stays while open");
    assert.equal(page.window.document.activeElement, chip("#ff7f00"), "focus lands on the current color");
    swatch("sgi2023").click();
    assert.equal(palette(), null, "a second click closes it");

    swatch("sgi2023").click();
    page.window.document.body.dispatchEvent(new page.window.Event("pointerdown", { bubbles: true }));
    assert.equal(palette(), null, "a press elsewhere closes it");

    swatch("sgi2023").click();
    const escape = new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    page.window.document.dispatchEvent(escape);
    assert.equal(palette(), null, "Escape closes it");
    assert.equal(page.window.document.activeElement, swatch("sgi2023"), "and hands focus back");
    assert.equal(swatch("sgi2023").classList.contains("popover-open"), false, "and drops the disc");

    swatch("sgi2023").click();
    palette().dispatchEvent(new page.window.Event("mouseleave"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(palette(), "the pointer leaving does not close a click-opened box");
    swatch("sgi2023").click();

    swatch("sgi2023").click();

    chip("#ffff33").click();
    assert.equal(map.getLayer("inv-line-sgi2023").paint["line-color"], "#ffff33");
    assert.equal(palette(), null, "a pick closes the box");
    assert.equal(page.window.document.activeElement, swatch("sgi2023"), "and focus stays in the panel");
    assert.equal(swatch("sgi2023").classList.contains("popover-open"), false);
    swatch("sgi2023").click();
    assert.equal(chip("#ffff33").getAttribute("aria-pressed"), "true");

    // Not added yet: the pick is what the layer is created with.
    swatch("agi5").click();
    assert.equal(page.window.document.querySelectorAll(".popover").length, 1, "one popover at a time");
    chip("#999999").click();
    assert.equal(map.getLayer("inv-line-agi5"), undefined);
    change(el("inv-agi5"), true);
    await settle();
    assert.equal(map.getLayer("inv-line-agi5").paint["line-color"], "#999999");
    change(el("inv-agi5"), false);
    await settle();
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

  await t.test("an inventory is described by its name and whichever identifier it carries", async () => {
    for (const id of ["rgi7", "pauletal2020"]) change(el(`inv-${id}`), true);
    await settle();
    map.hits = [
      {
        layer: { id: "inv-line-rgi7" },
        properties: { name: "Grosser Aletschgletscher", rgi_id: "RGI2000-v7.0-G-11-01450", year: 2003 },
      },
      { layer: { id: "inv-line-pauletal2020" }, properties: { glacier_nr: 1234, year: 2015 } },
    ];
    map.fire("click", { point: { x: 10, y: 10 }, lngLat: [8, 46] });

    const text = page.popups.at(-1).content.textContent;
    assert.ok(text.includes("Grosser Aletschgletscher"));
    assert.ok(text.includes("RGI ID: RGI2000-v7.0-G-11-01450"));
    assert.ok(text.includes("Glacier number: 1234"));
    assert.equal(text.match(/Glacier name/g).length, 1, "an inventory without names says nothing of one");
  });
});
