/* Check item/style joins and validation of catalog input. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { captureWarnings, installBrowser, load, REPO } from "./helpers/browser.js";

installBrowser();
const { catalogBounds, readStore, storeLayers, stretches, styleHref } = await load("js/store.js");

const read = (...where) =>
  JSON.parse(fs.readFileSync(path.join(REPO, "tests", "fixtures", ...where), "utf8"));
const ITEM_URL = "https://tiles.example/glace/mosaics/2025/item.json";

/* The published collection lists several years; the unit cases below reason
 * about one, so the base is its 2025 item and that year's style. */
const collection = read("store", "collection.json");
const YEARS = collection.links
  .filter((link) => link.rel === "item")
  .map((link) => Number(/\d{4}/.exec(link.href)[0]));
const item = read("store", "item-2025.json");
const style = read("store", "style-2025.json");

const layers = (over = {}) =>
  storeLayers(
    over.items ?? [{ item: over.item ?? item, url: ITEM_URL, style: over.style ?? style }],
    over.fallback ?? style,
    over.collection ?? collection,
  );

const byId = (list) => new Map(list.map((layer) => [layer.id, layer]));

test("every archive the store publishes becomes a layer", () => {
  const found = layers();
  // Two products x (VV, VH) x (measurement, QA-NUM, QA-CQM): twelve, and the
  // item lists exactly that many.
  assert.equal(found.length, 12);
  const visual = Object.values(item.assets).filter((asset) => asset.roles.includes("visual"));
  assert.equal(visual.length, 12);
});

test("the style layer id is split into the axes the panel spends it on", () => {
  const layer = byId(layers()).get("glace-coh12_vv_qa_num-2025");
  assert.equal(layer.product, "COH12");
  // One field carrying a polarization and a QA role, as the panel expects it.
  assert.equal(layer.polarization, "VV_QA_NUM");
  assert.equal(layer.year, 2025);
});

test("the archive URL comes from the asset, resolved against the item", () => {
  const layer = byId(layers()).get("glace-coh12_vv-2025");
  assert.equal(layer.url, "https://tiles.example/glace/mosaics/2025/coh12_vv_viz.pmtiles");
});

test("decoding and zooms come from the style, stretches from renders, units from the item", () => {
  const found = byId(layers());
  const vv = found.get("glace-coh12_vv-2025");
  assert.equal(vv.encoding.encoding, "custom");
  assert.deepEqual([vv.minZoom, vv.maxZoom], [5, 13]);
  assert.deepEqual([vv.vmin, vv.vmax], [0.1, 0.75]);
  assert.equal(vv.units, "", "coherence has no unit");
  assert.match(vv.attribution, /Copernicus Sentinel data 2025/);
  assert.equal("colors" in vv, false, "the style's ramp is not read");

  const rtc = found.get("glace-rtc_vv-2025");
  assert.deepEqual([rtc.vmin, rtc.vmax], [-14.5, -4.5]);
  assert.equal(rtc.units, "dB");

  const num = found.get("glace-rtc_vv_qa_num-2025");
  assert.deepEqual([num.vmin, num.vmax], [0, 80]);
});

test("a stretch is read only from a finite, increasing rescale", () => {
  const ranges = stretches({
    renders: {
      good: { rescale: [[0, 1]] },
      inverted: { rescale: [[1, 0]] },
      text: { rescale: [["0", "1"]] },
      missing: {},
    },
  });
  assert.deepEqual([...ranges.keys()], ["good"]);
  assert.deepEqual(ranges.get("good"), { vmin: 0, vmax: 1 });
});

test("a layer without a rescale is dropped with a warning", async () => {
  const { coh12_vv: _, ...renders } = collection.renders;
  const warnings = await captureWarnings(async () => {
    const found = byId(layers({ collection: { ...collection, renders } }));
    assert.equal(found.has("glace-coh12_vv-2025"), false);
    assert.ok(found.has("glace-coh12_vh-2025"));
  });
  assert.ok(warnings.some((line) => /glace-coh12_vv-2025/.test(line)));
});

test("a source without the custom encoding is dropped, not drawn as color", async () => {
  const broken = structuredClone(style);
  broken.sources["src-coh12_vv"].encoding = "terrarium";
  const warnings = await captureWarnings(async () => {
    assert.equal(byId(layers({ style: broken })).has("glace-coh12_vv-2025"), false);
  });
  assert.ok(warnings.some((line) => /glace-coh12_vv-2025/.test(line)));
});

test("no layer declares bounds — the archive's own header carries them", () => {
  for (const layer of layers()) {
    assert.equal(layer.bounds, undefined, layer.id);
  }
});

test("the acquisition window comes from the archive's item", () => {
  const layer = byId(layers()).get("glace-coh12_vh-2025");
  assert.equal(layer.startDate, "2025-06-24");
  assert.equal(layer.endDate, "2025-09-22");

  // An item without dates loses only the line under its ramp.
  const undated = structuredClone(item);
  delete undated.properties.start_datetime;
  assert.equal(byId(layers({ item: undated })).get("glace-coh12_vh-2025").startDate, undefined);
});

test("a year without its own style falls back to the same layer's source", async () => {
  /* The collection's style carries the most recent year only. Encodings and
   * stretches are fixed per layer rather than per year — deliberately, so a
   * real change between two years reads as a change — so an older year is
   * decoded and drawn with the same constants. */
  const older = { ...structuredClone(item), id: "alps-mosaic-2021" };
  const warnings = await captureWarnings(() => {
    const found = byId(layers({ items: [{ item: older, url: ITEM_URL.replace("2025", "2021") }] }));
    const layer = found.get("glace-coh12_vv-2021");
    assert.equal(layer.year, 2021);
    assert.equal(layer.encoding.encoding, "custom");
    assert.deepEqual([layer.minZoom, layer.maxZoom], [5, 13]);
    assert.deepEqual([layer.vmin, layer.vmax], [0.1, 0.75]);
    assert.match(layer.url, /\/2021\//, "and its own archive");
  });
  assert.deepEqual(warnings, [], "an older year is expected, not a complaint");
});

test("a layer nothing describes is dropped with a warning", async () => {
  const extra = structuredClone(item);
  extra.assets.coh12_hh_viz = {
    href: "coh12_hh_viz.pmtiles",
    type: "application/vnd.pmtiles",
    roles: ["visual"],
  };
  const warnings = await captureWarnings(() => {
    assert.equal(layers({ item: extra }).length, 12);
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no style entry describes glace-coh12_hh-2025/);
});

test("an asset this page cannot name a layer from is passed over in silence", async () => {
  const pmtiles = { type: "application/vnd.pmtiles", roles: ["visual"] };
  const odd = structuredClone(item);
  Object.assign(odd.assets, {
    overview: { ...pmtiles, href: "overview.pmtiles" },
    other_viz: { ...pmtiles, href: "other_viz.pmtiles" },
    preview: { href: "preview.png", type: "image/png", roles: ["visual"] },
  });
  const warnings = await captureWarnings(() => {
    assert.equal(layers({ item: odd }).length, 12);
    assert.throws(() => layers({ item: { ...item, id: "alps-mosaic" } }), /no drawable/);
  });
  assert.equal(warnings.length, 0, "none names an archive of this catalog's");
});

test("a layer the catalog describes incompletely is dropped, not drawn", async () => {
  const sourceCases = {
    "no encoding": (source) => delete source.encoding,
    "a factor that is not a number": (source) => (source.redFactor = "1"),
    "zooms the wrong way round": (source) => Object.assign(source, { minzoom: 13, maxzoom: 5 }),
  };
  const renderCases = {
    "no rescale": (render) => delete render.rescale,
    "an inverted rescale": (render) => (render.rescale = [[0.9, 0.1]]),
    "a rescale with no width": (render) => (render.rescale = [[0.5, 0.5]]),
    "a rescale that is not a number": (render) => (render.rescale = [[0.1, "0.8"]]),
  };
  const run = async (what, over) => {
    const warnings = await captureWarnings(() => {
      const found = layers(over);
      assert.equal(found.length, 11, what);
      assert.equal(byId(found).get("glace-coh12_vv-2025"), undefined, what);
    });
    assert.match(warnings[0] ?? "", /describes incompletely/, what);
  };
  for (const [what, breakIt] of Object.entries(sourceCases)) {
    const broken = structuredClone(style);
    breakIt(broken.sources["src-coh12_vv"]);
    await run(what, { style: broken });
  }
  for (const [what, breakIt] of Object.entries(renderCases)) {
    const broken = structuredClone(collection);
    breakIt(broken.renders.coh12_vv);
    await run(what, { collection: broken });
  }
});

test("a source with no zooms costs its layer, since a raster source needs them", async () => {
  const broken = structuredClone(style);
  delete broken.sources["src-rtc_vh"].maxzoom;
  await captureWarnings(() => {
    assert.equal(byId(layers({ style: broken })).get("glace-rtc_vh-2025"), undefined);
  });
});

test("a catalog with nothing drawable in it is refused rather than half-drawn", async () => {
  await captureWarnings(() => {
    const empty = { version: 8, sources: {}, layers: [] };
    assert.throws(() => layers({ style: empty, fallback: empty }), /no drawable/);
    assert.throws(() => storeLayers([], style), /no drawable/);
    assert.throws(() => storeLayers(null, null), /no drawable/);
  });
});

test("the three documents are read end to end", async () => {
  /* The one case that exercises the reads themselves: which URL each document is
   * looked for at, that each style is found through its document's own asset
   * rather than by a path this page knows, and that the year's item supplies
   * its archives, its style and the window under the ramp. */
  const at = (file) => path.join(REPO, "tests", "fixtures", "store", file);
  installBrowser({
    files: {
      "http://localhost/tiles/mosaics/collection.json": at("collection.json"),
      "http://localhost/tiles/mosaics/styles/default.json": at("style-default.json"),
      ...Object.fromEntries(
        YEARS.flatMap((year) => [
          [`http://localhost/tiles/mosaics/${year}/styles/default.json`, at(`style-${year}.json`)],
          [`http://localhost/tiles/mosaics/${year}/item.json`, at(`item-${year}.json`)],
        ]),
      ),
    },
  });

  const { layers, bounds } = await readStore();
  const found = byId(layers);
  assert.equal(found.size, YEARS.length * 12, "twelve archives a year");
  assert.deepEqual(bounds, [4.7461, 43.3891, 16.6113, 48.4], "the collection's extent");
  const layer = found.get("glace-rtc_vv-2025");
  assert.deepEqual([layer.units, layer.vmin, layer.vmax], ["dB", -14.5, -4.5]);
  assert.equal(layer.url, "http://localhost/tiles/mosaics/2025/rtc_vv_viz.pmtiles");
  assert.deepEqual(
    [layer.startDate, layer.endDate],
    ["2025-06-24", "2025-09-22"],
    "read off the year's own STAC item",
  );
  assert.match(
    found.get("glace-rtc_vv-2015").attribution,
    /Copernicus Sentinel data 2015/,
    "from the year's own style, not the collection's",
  );
});

test("a year whose item cannot be read loses its archives, with a warning", async () => {
  const at = (file) => path.join(REPO, "tests", "fixtures", "store", file);
  installBrowser({
    files: {
      "http://localhost/tiles/mosaics/collection.json": at("collection.json"),
      "http://localhost/tiles/mosaics/styles/default.json": at("style-default.json"),
      ...Object.fromEntries(
        YEARS.map((year) => [
          `http://localhost/tiles/mosaics/${year}/styles/default.json`,
          at(`style-${year}.json`),
        ]),
      ),
      // Only the 2025 item answers.
      "http://localhost/tiles/mosaics/2025/item.json": at("item-2025.json"),
    },
  });
  let found;
  const warnings = await captureWarnings(async () => {
    ({ layers: found } = await readStore());
  });
  assert.deepEqual(new Set(found.map((layer) => layer.year)), new Set([2025]));
  assert.equal(warnings.length, YEARS.length - 1);
  assert.match(warnings[0], /cannot be read .*2015\/item\.json — HTTP 404/);
});

test("a year whose style cannot be read loses its archives, with a warning", async () => {
  /* Falling back to the collection's style would credit the wrong year. */
  const at = (file) => path.join(REPO, "tests", "fixtures", "store", file);
  installBrowser({
    files: {
      "http://localhost/tiles/mosaics/collection.json": at("collection.json"),
      "http://localhost/tiles/mosaics/styles/default.json": at("style-default.json"),
      ...Object.fromEntries(
        YEARS.flatMap((year) => [
          [`http://localhost/tiles/mosaics/${year}/item.json`, at(`item-${year}.json`)],
          // Every style but 2015's answers.
          ...(year === 2015
            ? []
            : [[`http://localhost/tiles/mosaics/${year}/styles/default.json`, at(`style-${year}.json`)]]),
        ]),
      ),
    },
  });
  let found;
  const warnings = await captureWarnings(async () => {
    ({ layers: found } = await readStore());
  });
  assert.equal(new Set(found.map((layer) => layer.year)).has(2015), false);
  assert.equal(found.length, (YEARS.length - 1) * 12);
  assert.deepEqual(warnings.length, 1);
  assert.match(warnings[0], /cannot be read .*2015\/styles\/default\.json — HTTP 404/);
});

test("a catalog that cannot be reached names the document that failed", async () => {
  installBrowser({ files: {} });
  await assert.rejects(readStore(), /collection\.json — HTTP 404/);
});

test("a collection that nominates no style says so", async () => {
  // Distinct from "nothing drawable": there is no second place to look, so the
  // reader is told which document is missing rather than which came out empty.
  const bare = path.join(REPO, "tests", "fixtures", "store", "collection-no-style.json");
  const collectionWithoutStyle = structuredClone(collection);
  delete collectionWithoutStyle.assets;
  fs.writeFileSync(bare, JSON.stringify(collectionWithoutStyle));
  installBrowser({ files: { "http://localhost/tiles/mosaics/collection.json": bare } });
  try {
    await assert.rejects(readStore(), /names no style asset/);
  } finally {
    fs.rmSync(bare);
  }
});

test("a document's style is the asset with the style role, the default first", () => {
  assert.equal(styleHref(item), "./styles/default.json");
  assert.equal(styleHref(collection), "./styles/default.json");
  const assets = {
    other: { href: "./other.json", roles: ["style"] },
    named: { href: "./named.json", title: "Any title", roles: ["style", "default"] },
    thumbnail: { href: "./thumbnail.webp", roles: ["thumbnail"] },
  };
  assert.equal(styleHref({ assets }), "./named.json");
  delete assets.named;
  assert.equal(styleHref({ assets }), "./other.json");
  assert.equal(styleHref({ assets: { thumbnail: assets.thumbnail } }), null);
  assert.equal(styleHref(null), null);
});

test("a year with its own style is drawn from that style, not from the default", () => {
  /* One style per published year is what the store writes, and the years differ
   * only in the year they name — except where a source changed, and then the
   * older year must keep the source its own archive was written for. */
  const older = structuredClone(style);
  older.layers = older.layers.map((layer) => ({ ...layer, id: layer.id.replace("-2025", "-2023") }));
  older.sources["src-coh12_vv"].maxzoom = 12;
  const found = byId(
    layers({
      items: [
        { item: read("store", "item-2023.json"), url: ITEM_URL.replace("2025", "2023"), style: older },
        { item, url: ITEM_URL, style },
      ],
    }),
  );
  assert.equal(found.size, 24, "both years of every archive reach the map");
  assert.equal(found.get("glace-coh12_vv-2023").maxZoom, 12, "from its own year's style");
  assert.equal(found.get("glace-coh12_vv-2025").maxZoom, 13);
});

test("an extent the page cannot use is no extent", () => {
  const extent = (bbox) => ({ extent: { spatial: { bbox: [bbox] } } });
  assert.deepEqual(catalogBounds(extent([5, 44, 12, 48])), [5, 44, 12, 48]);
  assert.equal(catalogBounds(extent([12, 44, 5, 48])), null, "west past east");
  assert.equal(catalogBounds(extent([5, 44, 12])), null);
  assert.equal(catalogBounds(extent([5, "44", 12, 48])), null);
  assert.equal(catalogBounds({}), null);
  assert.equal(catalogBounds(null), null);
});
