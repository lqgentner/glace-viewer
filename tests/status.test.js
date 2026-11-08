/*
 * The status line: the scale bar and the credits of what the map draws, grouped
 * by kind. Terrain and imagery credit the sources in view.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { installBrowser, load, REPO, settle } from "./helpers/browser.js";

const page = installBrowser();
const { window } = page;
const { StatusControl, creditItems, coverageTiles, imageryContributors, metersPerPixel, scaleBar, terrainProducers } =
  await load("js/status.js");
const { PHONE } = await load("js/ui.js");

const BASEMAP_CREDIT =
  '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>' +
  ' | <a href="https://protomaps.com">Protomaps</a>';
const GLACE_CREDIT = "University of Zurich, Contains modified Copernicus Sentinel data 2026";
const MAPTERHORN_CREDIT = "<a href='https://mapterhorn.com/attribution'>© Mapterhorn</a>";

/* Esri's contributor list: each bbox is [minLat, minLon, maxLat, maxLon]. */
const area = (bbox, zoomMin = 12, zoomMax = 23, score = 100) => ({ bbox, zoomMin, zoomMax, score });
const CONTRIBUTORS = [
  { attribution: "Earthstar Geographics", coverageAreas: [area([-84.94, -179.66, 84.94, 179.66], 0, 13, 50)] },
  { attribution: "©swisstopo, ©Planet", coverageAreas: [area([46.39, 7.36, 46.41, 7.4]), area([46.3, 7.8, 46.6, 8.2])] },
  { attribution: "Vantor", coverageAreas: [area([40, 0, 50, 20], 14, 23, 80)] },
  { attribution: "Land Tirol", coverageAreas: [area([46.75, 10.09, 47.6, 11.14])] },
  { attribution: "Chukotka", coverageAreas: [area([64, -179.9, 70, -170])] },
];

/* Mapterhorn's coverage index: each tile asked for is recorded, and `answer` gives its sources. */
const asked = [];
let answer = () => ({});
globalThis.pmtiles.PMTiles = class {
  constructor(source) {
    this.source = source;
  }
  async getZxy(z, x, y) {
    asked.push({ url: this.source.getKey(), noStore: this.source.chromeWindowsNoCache, z, x, y });
    const sources = await answer({ z, x, y });
    return sources && { data: new TextEncoder().encode(JSON.stringify(sources)) };
  }
};
const producer = (name, resolution, website = `https://${name.toLowerCase()}.example/`) => ({
  producer_short: name,
  resolution,
  website,
});

/* A map drawing the vector basemap, with a hidden GLACE layer, imagery and hillshade to switch on. */
function mount({ zoom = 11 } = {}) {
  const map = new globalThis.maplibregl.Map({
    container: "map",
    center: [8.03, 46.5],
    zoom,
    style: {
      sources: {
        protomaps: { type: "vector", attribution: BASEMAP_CREDIT },
        "glace-coh12_vv-2023": { type: "raster-dem" },
        "inv-agi5": { type: "vector", attribution: "Hartig et al., 2026" },
        "world-imagery": { type: "raster" },
        terrain: { type: "raster-dem" },
      },
      layers: [
        { id: "world-imagery", type: "raster", source: "world-imagery", layout: { visibility: "none" } },
        { id: "earth", type: "fill", source: "protomaps" },
        { id: "glace-coh12_vv-2023", type: "color-relief", source: "glace-coh12_vv-2023", layout: { visibility: "none" } },
        { id: "hillshade", type: "hillshade", source: "terrain", layout: { visibility: "none" } },
        { id: "inv-line-agi5", type: "line", source: "inv-agi5", layout: { visibility: "none" } },
        { id: "places", type: "symbol", source: "protomaps" },
      ],
    },
  });
  const node = new StatusControl().onAdd(map);
  const show = (id, on = true) => {
    map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    map.fire("styledata", { dataType: "style" });
  };
  const groups = () =>
    [...node.querySelectorAll(".credit-group")].map((group) => {
      const label = group.querySelector(".credit-label")?.textContent;
      const text = [...group.childNodes].filter((n) => !n.classList?.contains("credit-label")).map((n) => n.textContent).join("");
      /* Read with plain spaces; the no-break space after "©" has its own test. */
      return (label ? `${label} ${text}` : text).replaceAll("\u00a0", " ");
    });
  const group = (label) => groups().find((g) => g.startsWith(`${label}:`));
  return { map, node, show, groups, group };
}

test("scale bar picks a round length", () => {
  assert.deepEqual(scaleBar(metersPerPixel(46.48, 11)), { px: 76, label: "2 km" });
  assert.deepEqual(scaleBar(0.5), { px: 40, label: "20 m" });
  assert.equal(scaleBar(100).label, "5 km");
  assert.equal(scaleBar(Number.NaN), null);
  assert.ok(Math.abs(metersPerPixel(0, 0) - 78271.517) < 0.01);
});

test("a source's credit HTML becomes text and web links, split where it says |", () => {
  assert.deepEqual(creditItems(BASEMAP_CREDIT), [
    { text: "© OpenStreetMap contributors", href: "https://www.openstreetmap.org/copyright" },
    { text: "Protomaps", href: "https://protomaps.com/" },
  ]);
  assert.deepEqual(creditItems(GLACE_CREDIT), [{ text: GLACE_CREDIT, href: null }]);
  assert.deepEqual(creditItems('<a href="javascript:alert(1)">Evil</a><script>alert(2)</script><img src=x onerror=alert(3)>'), [
    { text: "Evil", href: null },
  ]);
  assert.deepEqual(creditItems(undefined), []);
  assert.deepEqual(creditItems(""), []);
});

test("the credits name what the map draws, in groups, and MapLibre last", () => {
  const { show, groups } = mount();
  assert.deepEqual(groups(), [
    "Basemap: © OpenStreetMap contributors, Protomaps",
    "MapLibre",
  ]);
  show("glace-coh12_vv-2023");
  show("inv-line-agi5");
  assert.deepEqual(groups(), [
    "Inventories: Hartig et al., 2026",
    "Basemap: © OpenStreetMap contributors, Protomaps",
    "MapLibre",
  ], "an archive whose metadata has not arrived credits nothing yet");
  show("inv-line-agi5", false);
  assert.deepEqual(groups(), ["Basemap: © OpenStreetMap contributors, Protomaps", "MapLibre"]);
});

test("each group's name ends in a colon", () => {
  const { node } = mount();
  assert.equal(node.querySelector(".credit-label").textContent, "Basemap:");
});

test("a source's credit shows once its metadata arrives", () => {
  const { map, show, groups, node } = mount();
  show("glace-coh12_vv-2023");
  map.getSource("glace-coh12_vv-2023").attribution = GLACE_CREDIT;
  map.fire("sourcedata", { sourceId: "glace-coh12_vv-2023", sourceDataType: "metadata" });
  assert.deepEqual(groups()[0], `Layers: ${GLACE_CREDIT}`);
  const links = [...node.querySelectorAll("a")];
  const maplibre = links.find((a) => a.textContent === "MapLibre");
  assert.equal(maplibre.href, "https://maplibre.org/");
  assert.equal(maplibre.target, "_blank");
  assert.equal(maplibre.rel, "noopener");
});

test("the contributors in view are those whose areas meet the view at its zoom, best score first", () => {
  const aletsch = { west: 7.9, south: 46.4, east: 8.1, north: 46.6 };
  const names = (view, level) => imageryContributors(CONTRIBUTORS, view, level)?.map((c) => c.text) ?? null;
  assert.deepEqual(names(aletsch, 12), ["©swisstopo, ©Planet", "Earthstar Geographics"]);
  assert.deepEqual(names(aletsch, 15), ["©swisstopo, ©Planet", "Vantor"]);
  assert.deepEqual(names({ west: -180, south: -85, east: 180, north: 85 }, 3), ["Earthstar Geographics"]);
  /* A view across the antimeridian runs past 180°; its far side wraps around. */
  assert.deepEqual(names({ west: 179, south: 65, east: 181, north: 66 }, 16), ["Chukotka"]);
  assert.equal(names({ west: 0, south: -60, east: 1, north: -59 }, 16), null, "no contributor: the fixed sources stand");
  const many = Array.from({ length: 16 }, (_, i) => ({ attribution: `C${i}`, coverageAreas: [area([46, 7, 47, 9])] }));
  assert.equal(imageryContributors(many, aletsch, 15), null, "past 15 contributors, the fixed sources stand");
  assert.equal(imageryContributors(undefined, aletsch, 15), null);
});

test("on imagery, Powered by Esri leads, then Esri's contributors in view, read from Esri once", async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => ({ contributors: CONTRIBUTORS }) };
  };
  const { map, show, group, node } = mount();
  await settle();
  assert.deepEqual(urls, [], "no request without imagery");

  show("world-imagery");
  assert.equal(group("Imagery"), "Imagery: Powered by Esri, Vantor, Earthstar Geographics, and the GIS User Community");
  assert.equal([...node.querySelectorAll("a")].find((a) => a.textContent === "Powered by Esri").href, "https://www.esri.com/");
  await settle();
  /* MapLibre's zoom 11 draws Esri's 256 px tiles of level 12. */
  assert.equal(group("Imagery"), "Imagery: Powered by Esri, ©swisstopo, ©Planet, Earthstar Geographics");

  map.zoom = 14;
  map.fire("moveend");
  assert.equal(group("Imagery"), "Imagery: Powered by Esri, ©swisstopo, ©Planet, Vantor");
  assert.deepEqual(urls, ["https://static.arcgis.com/attribution/World_Imagery"]);
});

test("a failed read of Esri's contributors keeps the fixed sources and is tried again on the next move", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error("offline");
    return { ok: true, status: 200, json: async () => ({ contributors: CONTRIBUTORS }) };
  };
  const { map, show, group } = mount();
  show("world-imagery");
  await settle();
  assert.equal(group("Imagery"), "Imagery: Powered by Esri, Vantor, Earthstar Geographics, and the GIS User Community");
  map.fire("moveend");
  await settle();
  assert.equal(calls, 2);
  assert.equal(group("Imagery"), "Imagery: Powered by Esri, ©swisstopo, ©Planet, Earthstar Geographics");
});

test("the coverage tiles are the index's tiles over the view, at most 16, at zooms 4 to 12", () => {
  const aletsch = { west: 7.9, south: 46.4, east: 8.1, north: 46.6 };
  assert.deepEqual(coverageTiles(aletsch, 9.7), [
    { z: 9, x: 267, y: 180 },
    { z: 9, x: 267, y: 181 },
  ]);
  assert.ok(coverageTiles(aletsch, 15).every(({ z }) => z === 12));
  const alps = coverageTiles({ west: 5, south: 43, east: 16, north: 48 }, 11);
  assert.ok(alps.length <= 16 && alps[0].z < 11);
  assert.deepEqual(coverageTiles(aletsch, 3.9), []);
  const xs = coverageTiles({ west: 179, south: 60, east: 181, north: 61 }, 6).map(({ x }) => x);
  assert.deepEqual([...new Set(xs)], [63, 0]);
});

test("the producers are listed finest first and once each, linked only to web pages", () => {
  assert.deepEqual(
    terrainProducers({
      glo30: producer("Copernicus", 30),
      swissalti3d: producer("swisstopo", 0.5),
      swisssurface: producer("swisstopo", 0.5),
      odd: producer("Odd", 2, "javascript:alert(1)"),
    }),
    [
      { text: "© swisstopo", href: "https://swisstopo.example/" },
      { text: "© Odd", href: null },
      { text: "© Copernicus", href: "https://copernicus.example/" },
    ],
  );
  assert.equal(terrainProducers({}), null);
  const many = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`s${i}`, producer(`P${i}`, i)]));
  assert.equal(terrainProducers(many), null, "past 15 sources, Mapterhorn's own page lists them");
});

test("with hillshade or 3D, the terrain credits Mapterhorn, then the elevation sources in view, latest answer only", async () => {
  const { map, show, groups } = mount();
  const terrain = () => groups().find((g) => g.startsWith("Terrain"));
  asked.length = 0;
  answer = () => ({ swissalti3d: producer("swisstopo", 0.5), glo30: producer("Copernicus", 30) });
  await settle();
  assert.equal(terrain(), undefined);
  assert.equal(asked.length, 0, "no lookup without terrain");

  show("hillshade");
  assert.equal(terrain(), "Terrain: © Mapterhorn", "before its TileJSON arrives");
  map.getSource("terrain").attribution = MAPTERHORN_CREDIT;
  map.fire("sourcedata", { sourceId: "terrain", sourceDataType: "metadata" });
  await settle();
  assert.equal(terrain(), "Terrain: © Mapterhorn, © swisstopo, © Copernicus");
  assert.ok(asked.length > 0 && asked.every(({ url, noStore, z }) => url === "https://download.mapterhorn.com/coverage-index.pmtiles" && noStore && z === 11));

  /* A slow answer for one view arrives after the answer for the next. */
  let release;
  const slow = new Promise((resolve) => (release = resolve));
  answer = () => slow.then(() => ({ old: producer("Old", 1) }));
  map.fire("moveend");
  answer = () => ({ usgs: producer("USGS", 10) });
  map.fire("moveend");
  await settle();
  release();
  await settle();
  assert.equal(terrain(), "Terrain: © Mapterhorn, © USGS");

  answer = () => Promise.reject(new Error("offline"));
  map.fire("moveend");
  await settle();
  assert.equal(terrain(), "Terrain: © Mapterhorn");

  show("hillshade", false);
  assert.equal(terrain(), undefined);
  answer = () => ({ usgs: producer("USGS", 10) });
  map.setTerrain({ source: "terrain" });
  map.fire("terrain");
  await settle();
  assert.equal(terrain(), "Terrain: © Mapterhorn, © USGS", "3D draws the terrain without the hillshade");
});

test("a copyright sign stays on the line of the name it belongs to", async () => {
  const { show, node } = mount();
  answer = () => ({ usgs: producer("USGS", 10) });
  show("hillshade");
  await settle();
  const signs = [...node.querySelectorAll(".credit-group > :not(.credit-label)")].map((n) => n.textContent).filter((t) => t.includes("©"));
  assert.ok(signs.length >= 3, "the basemap's and the terrain's");
  for (const text of signs) assert.doesNotMatch(text, /© /, `"${text}" breaks after ©`);
  for (const text of signs) assert.match(text, /©\u00a0/);
});

test("the scale bar follows the camera", () => {
  const { map, node } = mount();
  assert.equal(node.querySelector(".scale-label").textContent, "2 km");
  assert.equal(node.querySelector(".scale-bar").style.width, "76px");
  map.zoom = 6;
  map.fire("move");
  assert.equal(node.querySelector(".scale-label").textContent, "50 km");
});

test("the info button folds the credits away on the first drag and unfolds them", () => {
  const { map, node } = mount();
  const box = node.querySelector(".credits-box");
  const button = node.querySelector("button.credits-button");
  assert.equal(button.getAttribute("aria-label"), "Credits");
  assert.ok(box.classList.contains("open"), "open at load");
  assert.equal(button.getAttribute("aria-expanded"), "true");
  map.fire("dragstart");
  assert.ok(!box.classList.contains("open"));
  assert.equal(button.getAttribute("aria-expanded"), "false");
  map.fire("dragstart");
  button.click();
  assert.ok(box.classList.contains("open"), "a later drag leaves it open");
  page.setNarrow(true);
  try {
    assert.ok(PHONE.matches);
    box.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.ok(!box.classList.contains("open"), "Escape folds it on a phone");
  } finally {
    page.setNarrow(false);
  }
});

test("phones show no scale bar, and fold the credits into the info button", () => {
  const css = fs.readFileSync(path.join(REPO, "style.css"), "utf8");
  const phone = css.slice(css.indexOf("@media (pointer: coarse) and (max-width: 640px)"));
  assert.match(phone, /\.status-line \.scale\s*\{[^}]*display:\s*none/);
  assert.match(phone, /\.credits-box:not\(\.open\) \.credits\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.credits-button\s*\{[^}]*display:\s*none/, "desktop shows the credits without the button");
});

test("off the phone the scale and the credits sit in two columns, top-aligned, and the phone keeps its layout", () => {
  const css = fs.readFileSync(path.join(REPO, "style.css"), "utf8");
  const columns = /\n@media not all and \(pointer: coarse\) and \(max-width: 640px\) \{\n  #map \.status-line \{\s*display:\s*flex;\s*align-items:\s*flex-start;\s*\}[^@]*?\n\}\n/.exec(css);
  assert.ok(columns, "a rule for every layout but the phone's lays out the status line as a row, top-aligned");
  assert.match(columns[0], /\.status-line \.scale\s*\{\s*flex:\s*none;\s*\}/, "the scale keeps its width");
  assert.match(columns[0], /\.status-line \.credits-box\s*\{\s*min-width:\s*0;\s*\}/, "the credits column narrows and wraps");
  const rest = css.slice(0, columns.index) + css.slice(columns.index + columns[0].length);
  assert.doesNotMatch(rest, /\.status-line\s*\{[^}]*display:\s*(inline-)?flex/, "nowhere else, so the phone's box lays out as before");
  assert.doesNotMatch(rest, /\.status-line \.scale\s*\{[^}]*vertical-align/, "no inline alignment left over");
  assert.doesNotMatch(rest, /(^|\n)\.credits-box\s*\{\s*display:\s*inline;/, "the credits are a column, not inline text");
});

test("no space separates the credit groups, so the credits wrap inside a group, not between groups", () => {
  const { node } = mount();
  const list = node.querySelector(".credits");
  assert.ok(list.children.length > 1);
  assert.equal(list.childNodes.length, list.children.length, "no text nodes between the groups");
  assert.deepEqual([...node.children], [node.querySelector(".scale"), node.querySelector(".credits-box")], "the scale, then the credits column");
});

test("the status line's text is all white and regular weight", () => {
  const css = fs.readFileSync(path.join(REPO, "style.css"), "utf8");
  const rules = [...css.matchAll(/([^{}]*\.(?:credit-label|credit-group|status-line)[^{}]*)\{([^}]*)\}/g)];
  assert.ok(rules.length > 0);
  for (const [, selector, body] of rules) {
    assert.doesNotMatch(body, /font-weight/, `${selector.trim()} sets no weight`);
    assert.doesNotMatch(body, /var\(--muted\)/, `${selector.trim()} is not muted`);
  }
  assert.match(css, /\.status-line \.scale-bar\s*\{[^}]*border: 1px solid var\(--text\)/, "the scale bar matches the text");
});
