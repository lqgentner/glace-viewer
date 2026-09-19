/* Check collection/style/item joins and validation of catalog input. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { captureWarnings, installBrowser, load, REPO } from "./helpers/browser.js";

installBrowser();
const { readStore, storeLayers, styleHrefs } = await load("js/store.js");

const read = (...where) =>
  JSON.parse(fs.readFileSync(path.join(REPO, "tests", "fixtures", ...where), "utf8"));
const COLLECTION_URL = "https://tiles.example/glace/mosaics/collection.json";

/* The published collection lists four years; the unit cases below reason about
 * one, so the base is its 2024 slice: that year's links and that year's style,
 * which is the one the collection marks as the default. */
const published = read("store", "collection.json");
const collection = {
  ...published,
  assets: Object.fromEntries(
    Object.entries(published.assets).filter(([key]) => !key.startsWith("style-") || key === "style-2024"),
  ),
  links: published.links.filter((link) => link.rel !== "pmtiles" || link.href.includes("/2024/")),
};
const style = read("store", "style-2024.json");

const layers = (over = {}) =>
  storeLayers(
    over.collection ?? collection,
    COLLECTION_URL,
    over.style ?? style,
    over.windows ?? new Map(),
  );

const byId = (list) => new Map(list.map((layer) => [layer.id, layer]));

test("every archive the store publishes becomes a layer", () => {
  const found = layers();
  // Two products x (VV, VH) x (measurement, QA-NUM, QA-CQM), plus one false
  // color each: fourteen, and the collection lists exactly that many.
  assert.equal(found.length, 14);
  assert.equal(collection.links.filter((link) => link.rel === "pmtiles").length, 14);
});

test("the style layer id is split into the axes the panel spends it on", () => {
  const layer = byId(layers()).get("glace-coh12_vv_qa_num-2024");
  assert.equal(layer.product, "COH12");
  // One field carrying a polarization and a QA role, as the panel expects it.
  assert.equal(layer.polarization, "VV_QA_NUM");
  assert.equal(layer.year, 2024);
});

test("the archive URL comes from the link, resolved against the collection", () => {
  const layer = byId(layers()).get("glace-coh12_vv-2024");
  assert.equal(
    layer.url,
    "https://data.source.coop/lqgentner/glace-ch/mosaics/2024/coh12_vv_viz.pmtiles",
  );
});

test("the ramp, the stretch and the zooms come from the style", () => {
  const found = byId(layers());
  const vv = found.get("glace-coh12_vv-2024");
  assert.equal(vv.cmap, "cmc.lipari");
  assert.deepEqual([vv.vmin, vv.vmax], [0.1, 0.75]);
  assert.equal(vv.units, "");
  assert.equal(vv.colors.length, 17, "seventeen stops, as the store records them");
  assert.deepEqual([vv.minZoom, vv.maxZoom], [5, 13]);

  const cqm = found.get("glace-rtc_vv_qa_cqm-2024");
  assert.equal(cqm.cmap, "cmc.glasgow", "a sequential ramp: higher is better");
  assert.deepEqual([cqm.vmin, cqm.vmax], [-4, 8]);
  assert.equal(cqm.units, "dB");

  const num = found.get("glace-rtc_vv_qa_num-2024");
  // Shared by both products on purpose, so that RTC seeing more acquisitions
  // than COH12 is visible rather than flattened by a per-product ceiling.
  assert.deepEqual([num.vmin, num.vmax], [0, 90]);
  assert.deepEqual([byId(layers()).get("glace-coh12_vv_qa_num-2024").vmin, num.vmin], [0, 0]);
});

test("the false color carries three channels and no ramp", () => {
  const rgb = byId(layers()).get("glace-coh12_rgb-2024");
  assert.deepEqual(rgb.colors, [], "nothing to interpolate between");
  assert.equal(rgb.channels.length, 3);
  assert.deepEqual(rgb.channels[0], { band: "VV", vmin: 0.1, vmax: 0.75 });
  assert.equal(rgb.channels[2].band, "VV / VH", "a quotient, since coherence is not read in dB");
});

test("no layer declares bounds — the archive's own header carries them", () => {
  for (const layer of layers()) {
    assert.equal(layer.bounds, undefined, layer.id);
  }
});

test("the acquisition window is attached by year", () => {
  const windows = new Map([[2024, { startDate: "2024-07-09", endDate: "2024-10-07" }]]);
  const layer = byId(layers({ windows })).get("glace-coh12_vh-2024");
  assert.equal(layer.startDate, "2024-07-09");
  assert.equal(layer.endDate, "2024-10-07");

  // A year whose item could not be read simply loses the line under its ramp.
  assert.equal(byId(layers()).get("glace-coh12_vh-2024").startDate, undefined);
});

test("a year the style does not describe falls back to the same layer's stops", async () => {
  /* The style is documented as carrying the most recent year only, while the
   * collection lists every year. The stretch and the ramp are fixed per layer
   * rather than per year — deliberately, so a real change between two years
   * reads as a change — so an older year is drawn with the same constants. */
  const older = structuredClone(collection);
  for (const link of older.links.filter((link) => link.rel === "pmtiles")) {
    link.href = link.href.replace("/2024/", "/2021/");
    link["pmtiles:layers"] = link["pmtiles:layers"].map((id) => id.replace("-2024", "-2021"));
  }
  const warnings = await captureWarnings(() => {
    const found = byId(layers({ collection: older }));
    const layer = found.get("glace-coh12_vv-2021");
    assert.equal(layer.year, 2021);
    assert.equal(layer.cmap, "cmc.lipari");
    assert.deepEqual([layer.vmin, layer.vmax], [0.1, 0.75]);
    assert.match(layer.url, /\/2021\//, "and its own archive");
  });
  assert.deepEqual(warnings, [], "an older year is expected, not a complaint");
});

test("a layer nothing describes is dropped with a warning", async () => {
  const extra = structuredClone(collection);
  extra.links.push({
    rel: "pmtiles",
    href: "https://tiles.example/glace/mosaics/2024/hh_viz.pmtiles",
    "pmtiles:layers": ["glace-coh12_hh-2024"],
  });
  const warnings = await captureWarnings(() => {
    assert.equal(layers({ collection: extra }).length, 14);
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no style entry describes glace-coh12_hh-2024/);
});

test("a link this page cannot name a layer from is passed over in silence", async () => {
  const odd = structuredClone(collection);
  odd.links.push(
    { rel: "pmtiles", href: "https://tiles.example/x.pmtiles" },
    { rel: "pmtiles", href: "https://tiles.example/y.pmtiles", "pmtiles:layers": ["something-else"] },
  );
  const warnings = await captureWarnings(() => {
    assert.equal(layers({ collection: odd }).length, 14);
  });
  assert.deepEqual(warnings, [], "neither names an archive of this catalog's");
});

test("a layer the style describes incompletely is dropped, not drawn", async () => {
  const cases = {
    "no stretch": { vmin: undefined },
    "an inverted stretch": { vmin: 0.9, vmax: 0.1 },
    "a stretch with no width": { vmin: 0.5, vmax: 0.5 },
    "a stretch that is not a number": { vmax: "0.8" },
    "no stops at all": { stops: [] },
    "stops that carry no colors": { stops: [{ value: 0.1 }, { value: 0.8 }] },
  };
  for (const [what, override] of Object.entries(cases)) {
    const broken = structuredClone(style);
    const layer = broken.layers.find((layer) => layer.id === "glace-coh12_vv-2024");
    Object.assign(layer.metadata["portolan:legend"], override);
    const warnings = await captureWarnings(() => {
      const found = layers({ style: broken });
      assert.equal(found.length, 13, what);
      assert.equal(byId(found).get("glace-coh12_vv-2024"), undefined, what);
    });
    assert.match(warnings[0] ?? "", /describes incompletely/, what);
  }
});

test("one colorless stop is passed over rather than costing the layer its ramp", () => {
  const patched = structuredClone(style);
  const legend = patched.layers.find((layer) => layer.id === "glace-coh12_vv-2024")
    .metadata["portolan:legend"];
  delete legend.stops[3].color;
  assert.equal(byId(layers({ style: patched })).get("glace-coh12_vv-2024").colors.length, 16);
});

test("a source with no zooms costs its layer, since a raster source needs them", async () => {
  const broken = structuredClone(style);
  delete broken.sources["src-rtc_vh"].maxzoom;
  await captureWarnings(() => {
    assert.equal(byId(layers({ style: broken })).get("glace-rtc_vh-2024"), undefined);
  });
});

test("a catalog with nothing drawable in it is refused rather than half-drawn", async () => {
  await captureWarnings(() => {
    assert.throws(() => layers({ style: { version: 8, sources: {}, layers: [] } }), /no drawable/);
    assert.throws(() => storeLayers({}, COLLECTION_URL, style), /no drawable/);
    assert.throws(() => storeLayers(null, COLLECTION_URL, null), /no drawable/);
  });
});

test("the three documents are read end to end", async () => {
  /* The one case that exercises the reads themselves: which URL each document is
   * looked for at, that the style is found through the collection's own asset
   * rather than by a path this page knows, and that the year's item becomes the
   * window under the ramp. */
  const at = (file) => path.join(REPO, "tests", "fixtures", "store", file);
  installBrowser({
    files: {
      "http://localhost/tiles/mosaics/collection.json": at("collection.json"),
      ...Object.fromEntries(
        [2021, 2022, 2023, 2024].flatMap((year) => [
          [`http://localhost/tiles/mosaics/styles/${year}.json`, at(`style-${year}.json`)],
          [`http://localhost/tiles/mosaics/${year}/item.json`, at(`item-${year}.json`)],
        ]),
      ),
    },
  });

  const found = byId(await readStore());
  assert.equal(found.size, 56, "four years of fourteen archives");
  const layer = found.get("glace-rtc_vv-2024");
  assert.equal(layer.cmap, "cmc.grayC");
  assert.deepEqual(
    [layer.startDate, layer.endDate],
    ["2024-07-09", "2024-10-07"],
    "read off the year's own STAC item",
  );
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

test("the style assets are read by the year each one describes", () => {
  const perYear = structuredClone(collection);
  perYear.assets = {
    "style-2023": { href: "./styles/2023.json", roles: ["style"] },
    "style-2024": { href: "./styles/2024.json", roles: ["style", "default"] },
  };
  assert.deepEqual(
    [...styleHrefs(perYear)],
    [
      [2023, "./styles/2023.json"],
      [2024, "./styles/2024.json"],
      ["default", "./styles/2024.json"],
    ],
  );
});

test("a year with its own style is drawn from that style, not from the default", async () => {
  /* One style per published year is what the store writes, and the years differ
   * only in the year they name — except where a range was re-derived, and then
   * the older year must keep the constants its own archive was baked with. */
  const at = (file) => path.join(REPO, "tests", "fixtures", "store", file);
  const perYear = structuredClone(collection);
  perYear.assets = {
    "style-2023": { href: "./styles/2023.json", roles: ["style"] },
    "style-2024": { href: "./styles/2024.json", roles: ["style", "default"] },
  };
  perYear.links = [
    ...collection.links.filter((link) => link.rel !== "item"),
    ...collection.links
      .filter((link) => link.rel === "pmtiles")
      .map((link) => ({
        ...link,
        href: link.href.replace("/2024/", "/2023/"),
        "pmtiles:layers": link["pmtiles:layers"].map((id) => id.replace("-2024", "-2023")),
      })),
  ];
  const older = structuredClone(style);
  older.layers = older.layers.map((layer) => ({ ...layer, id: layer.id.replace("-2024", "-2023") }));
  older.layers.find((layer) => layer.id === "glace-coh12_vv-2023").metadata[
    "portolan:legend"
  ].vmax = 0.5;

  const files = {
    "http://localhost/tiles/mosaics/collection.json": at("collection-per-year.json"),
    "http://localhost/tiles/mosaics/styles/2023.json": at("tmp-style-2023.json"),
    "http://localhost/tiles/mosaics/styles/2024.json": at("style-2024.json"),
  };
  fs.writeFileSync(at("collection-per-year.json"), JSON.stringify(perYear));
  fs.writeFileSync(at("tmp-style-2023.json"), JSON.stringify(older));
  try {
    installBrowser({ files });
    const found = byId(await readStore());
    assert.equal(found.size, 28, "both years of every archive reach the map");
    assert.equal(found.get("glace-coh12_vv-2023").vmax, 0.5, "from its own year's style");
    assert.equal(found.get("glace-coh12_vv-2024").vmax, 0.75);
  } finally {
    fs.rmSync(at("collection-per-year.json"));
    fs.rmSync(at("tmp-style-2023.json"));
  }
});
