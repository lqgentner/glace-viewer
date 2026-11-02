/*
 * The status line, a map control in the bottom right corner: a compact scale
 * bar and the credits of what the map draws, grouped by kind, in one line of
 * text. Terrain and imagery credit the sources in view. Phones fold the credits
 * into an info button and draw no scale bar.
 */

import { TERRAIN_COVERAGE, WORLD_IMAGERY_ATTRIBUTION } from "./config.js";
import { PHONE, h } from "./ui.js";

const EARTH_CIRCUMFERENCE = 40075016.686;
const TILE_SIZE = 512;
const MAX_LAT = 85.05;
const WEB = /^https?:\/\//i;

/* Esri asks for "Powered by Esri" on interactive maps, then the data's sources: its copyrightText without "Esri". */
const ESRI = { text: "Powered by Esri", href: "https://www.esri.com" };
const ESRI_SOURCES = { text: "Vantor, Earthstar Geographics, and the GIS User Community", href: null };
/* Mapterhorn's TileJSON credit, until the TileJSON arrives. */
const MAPTERHORN = { text: "© Mapterhorn", href: "https://mapterhorn.com/attribution" };
/* The renderer draws whatever loaded, so its credit depends on no source. */
const MAPLIBRE = { text: "MapLibre", href: "https://maplibre.org" };

/* Mapterhorn's coverage index holds zooms 4 to 12. */
const COVERAGE_ZOOMS = { min: 4, max: 12 };
/* A view needing more index tiles is looked up at a coarser zoom. */
const MAX_COVERAGE_TILES = 16;
/* Past this many sources in view, "© Mapterhorn" alone links to the full list, as Mapterhorn's own example does. */
const MAX_TERRAIN_SOURCES = 15;
/* Past this many contributors in view, Esri's fixed sources stand in. */
const MAX_IMAGERY_CONTRIBUTORS = 15;

/* The credit groups in reading order. */
const GROUPS = ["Layers", "Inventories", "Basemap", "Imagery", "Terrain"];
const BASEMAP_SOURCE = "protomaps";
const IMAGERY_SOURCE = "world-imagery";
const TERRAIN_SOURCE = "terrain";

/* Each source's group, by the IDs js/map.js and js/overlays.js give them; every other source is a GLACE layer. */
function groupOf(id) {
  if (id === BASEMAP_SOURCE) return "Basemap";
  if (id === IMAGERY_SOURCE) return "Imagery";
  if (id === TERRAIN_SOURCE) return "Terrain";
  return id.startsWith("inv-") ? "Inventories" : "Layers";
}

/** Ground meters per screen pixel at a latitude in degrees (clamped to the map's) and a zoom level. */
export function metersPerPixel(lat, zoom) {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  return (EARTH_CIRCUMFERENCE * Math.cos((clamped * Math.PI) / 180)) / (TILE_SIZE * 2 ** zoom);
}

/** The longest 1, 2 or 5 times a power of ten that fits in maxPx pixels, or null without a usable scale. */
export function scaleBar(mpp, maxPx = 80) {
  if (!Number.isFinite(mpp) || mpp <= 0) return null;
  const maxMeters = mpp * maxPx;
  const power = 10 ** Math.floor(Math.log10(maxMeters));
  const meters = [5, 2, 1].map((step) => step * power).find((length) => length <= maxMeters);
  const label = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
  return { px: Math.round(meters / mpp), label };
}

/* Elements whose text is not a credit. */
const SKIPPED = new Set(["SCRIPT", "STYLE", "TEMPLATE"]);

/**
 * A source's attribution HTML as credits `{ text, href }`: each link, and each
 * run of text between links and "|". Only web links keep their address. The
 * HTML is parsed into an inert template: nothing in it runs or loads.
 */
export function creditItems(html) {
  if (typeof html !== "string" || !html.trim()) return [];
  const template = document.createElement("template");
  template.innerHTML = html;
  const items = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        for (const part of child.textContent.split("|")) {
          const text = part.trim();
          if (text) items.push({ text, href: null });
        }
      } else if (child.nodeName === "A") {
        const text = child.textContent.trim();
        if (text) items.push({ text, href: WEB.test(child.getAttribute("href") ?? "") ? child.href : null });
      } else if (!SKIPPED.has(child.nodeName)) {
        walk(child);
      }
    }
  };
  walk(template.content);
  return items;
}

/**
 * The coverage-index tiles over a view's bounds, at the deepest zoom up to the
 * map's that needs at most MAX_COVERAGE_TILES, or none below the index's zooms.
 */
export function coverageTiles({ west, south, east, north }, zoom) {
  const latY = (lat, n) => {
    const r = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
    return Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n)));
  };
  for (let z = Math.min(Math.floor(zoom), COVERAGE_ZOOMS.max); z >= COVERAGE_ZOOMS.min; z--) {
    const n = 2 ** z;
    const [x0, x1] = [west, east].map((lon) => Math.floor(((lon + 180) / 360) * n));
    const [y0, y1] = [latY(north, n), latY(south, n)];
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_COVERAGE_TILES) continue;
    const tiles = [];
    /* A view across the antimeridian runs past ±180°; its tiles wrap around. */
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push({ z, x: ((x % n) + n) % n, y });
    return tiles;
  }
  return [];
}

/**
 * The producers of the elevation sources in a set of coverage-index entries,
 * finest data first and each producer once, as credits. Null when there are
 * none or too many to list.
 */
export function terrainProducers(sources) {
  const entries = Object.values(sources).sort((a, b) => a.resolution - b.resolution);
  if (!entries.length || entries.length > MAX_TERRAIN_SOURCES) return null;
  const seen = new Set();
  return entries
    .filter(({ producer_short: name }) => name && !seen.has(name) && seen.add(name))
    .map(({ producer_short: name, website }) => ({ text: `© ${name}`, href: WEB.test(website ?? "") ? website : null }));
}

/**
 * The contributors in Esri's World Imagery list whose coverage meets a view's
 * bounds at Esri's tile `level`, best score first, as credits. Null when there
 * are none or too many to list. Each coverage bbox is
 * [minLat, minLon, maxLat, maxLon].
 */
export function imageryContributors(contributors, { west, south, east, north }, level) {
  const meets = ({ bbox: [minLat, minLon, maxLat, maxLon], zoomMin, zoomMax }) =>
    level >= zoomMin &&
    level <= zoomMax &&
    minLat <= north &&
    maxLat >= south &&
    /* A view across the antimeridian runs past ±180°; its far side wraps around. */
    [-360, 0, 360].some((shift) => minLon + shift <= east && maxLon + shift >= west);
  const found = (contributors ?? []).flatMap(({ attribution, coverageAreas }) => {
    const scores = (coverageAreas ?? []).filter(meets).map(({ score }) => score);
    return attribution && scores.length ? [{ text: attribution, score: Math.max(...scores) }] : [];
  });
  if (!found.length || found.length > MAX_IMAGERY_CONTRIBUTORS) return null;
  return found.sort((a, b) => b.score - a.score).map(({ text }) => ({ text, href: null }));
}

/**
 * The credits for `sources`, the `{ id, attribution }` the map draws, as groups
 * `{ label, items }` in reading order, then MapLibre's without a label. Imagery
 * credits Esri, then `contributors` or Esri's fixed sources; terrain credits
 * Mapterhorn, then `producers`. Within a group each credit shows once.
 */
export function credits(sources, { producers = null, contributors = null } = {}) {
  const items = new Map(GROUPS.map((label) => [label, []]));
  for (const { id, attribution } of sources) {
    const label = groupOf(id);
    const own = creditItems(attribution);
    if (label === "Imagery") items.get(label).push(ESRI, ...(contributors ?? [ESRI_SOURCES]));
    else if (label === "Terrain") items.get(label).push(...(own.length ? own : [MAPTERHORN]), ...(producers ?? []));
    else items.get(label).push(...own);
  }
  const groups = [...items]
    .map(([label, list]) => ({ label, items: list.filter((c, i) => list.findIndex((d) => d.text === c.text) === i) }))
    .filter(({ items: list }) => list.length);
  return [...groups, { label: null, items: [MAPLIBRE] }];
}

/* The sources a visible layer or the terrain draws, with their attribution once their metadata has arrived. */
function shownSources(map) {
  const ids = new Set();
  for (const layer of map.getStyle()?.layers ?? []) {
    if (layer.source && layer.layout?.visibility !== "none") ids.add(layer.source);
  }
  const terrain = map.getTerrain()?.source;
  if (terrain) ids.add(terrain);
  return [...ids].map((id) => ({ id, attribution: map.getSource(id)?.attribution }));
}

let coverage = null;

/** The producers behind the terrain in view, or null when the index has no answer. */
async function lookUpProducers(bounds, zoom) {
  const tiles = coverageTiles(bounds, zoom);
  if (!tiles.length) return null;
  coverage ??= new pmtiles.PMTiles(TERRAIN_COVERAGE);
  const decoder = new TextDecoder();
  const found = await Promise.all(
    tiles.map(async ({ z, x, y }) => {
      const tile = await coverage.getZxy(z, x, y);
      return tile ? JSON.parse(decoder.decode(tile.data)) : {};
    }),
  );
  return terrainProducers(Object.assign({}, ...found));
}

/**
 * The status line as a MapLibre control. The credits redraw when the style, a
 * source's metadata or the terrain changes, as MapLibre's own attribution
 * does. With terrain drawn, each move looks up the elevation sources in view;
 * until an answer arrives, the credits keep the last one, and a failed lookup
 * leaves Mapterhorn alone. With imagery drawn, the credits name Esri's
 * contributors in view, from Esri's list, read once; until it arrives, or when
 * it fails, Esri's fixed sources stand, and the next move reads it again.
 */
export class StatusControl {
  onAdd(map) {
    const list = h("span", { class: "credits" });
    const scaleLabel = h("span", { class: "scale-label" });
    const scaleLine = h("span", { class: "scale-bar" });
    const scale = h("span", { class: "scale", "aria-hidden": "true" }, scaleLabel, scaleLine);
    /*
     * One set of nodes for both layouts; style.css decides how they show. A
     * phone hides the scale bar and folds the credits into the info button:
     * they show at load and fold on the first drag of the map, as MapLibre's
     * compact attribution does, and the button unfolds them again in place.
     */
    const info = h("button", { type: "button", class: "credits-button", "aria-label": "Credits", "aria-expanded": "true" });
    const box = h("div", { class: "credits-box open" }, info, list);
    this.container = h("div", { class: "maplibregl-ctrl status-line" }, scale, box);

    const view = () => {
      const bounds = map.getBounds();
      return { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() };
    };
    let producers = null;
    let asked = 0;
    let terrainShown = false;
    let contributors = null;
    let reading = false;
    let drawn = "";

    /* A no-break space keeps "©" on the line of the name it belongs to. */
    const item = ({ text: raw, href }) => {
      const text = raw.replaceAll("© ", "©\u00a0");
      return href ? h("a", { href, target: "_blank", rel: "noopener" }, text) : h("span", {}, text);
    };
    /* MapLibre draws Esri's 256 px tiles one level deeper than its own zoom. */
    const imageryInView = () =>
      contributors && imageryContributors(contributors, view(), Math.round(map.getZoom()) + 1);
    const draw = (sources = shownSources(map)) => {
      const groups = credits(sources, { producers, contributors: imageryInView() });
      const key = JSON.stringify(groups);
      if (key === drawn) return;
      drawn = key;
      list.replaceChildren(
        ...groups.map(({ label, items }) =>
          h(
            "span",
            { class: "credit-group" },
            label ? h("span", { class: "credit-label" }, `${label}:`) : null,
            ...items.flatMap((entry, i) => (i ? [", ", item(entry)] : [item(entry)])),
          ),
        ),
      );
    };

    /* Only the latest lookup draws, so a slow answer for an old view never replaces a newer one. */
    const lookUpTerrain = () => {
      const ask = ++asked;
      lookUpProducers(view(), map.getZoom())
        .catch(() => null)
        .then((found) => {
          if (ask !== asked) return;
          producers = found;
          draw();
        });
    };
    const readContributors = () => {
      if (contributors || reading) return;
      reading = true;
      fetch(WORLD_IMAGERY_ATTRIBUTION)
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          contributors = Array.isArray(data?.contributors) ? data.contributors : null;
        })
        .catch(() => {})
        .finally(() => {
          reading = false;
          draw();
        });
    };
    /* Start the lookups a newly drawn terrain or imagery needs, then draw. */
    const update = (moved = false) => {
      const sources = shownSources(map);
      const ids = new Set(sources.map(({ id }) => id));
      if (!ids.has(TERRAIN_SOURCE)) {
        asked += 1;
        producers = null;
      } else if (moved || !terrainShown) {
        lookUpTerrain();
      }
      terrainShown = ids.has(TERRAIN_SOURCE);
      if (ids.has(IMAGERY_SOURCE)) readContributors();
      draw(sources);
    };

    const drawScale = () => {
      const bar = scaleBar(metersPerPixel(map.getCenter().lat, map.getZoom()));
      scale.hidden = !bar;
      if (!bar) return;
      scaleLine.style.width = `${bar.px}px`;
      scaleLabel.textContent = bar.label;
    };

    const setOpen = (open) => {
      box.classList.toggle("open", open);
      info.setAttribute("aria-expanded", String(open));
    };
    info.addEventListener("click", () => setOpen(!box.classList.contains("open")));
    box.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !PHONE.matches || !box.classList.contains("open")) return;
      setOpen(false);
      info.focus();
    });
    map.once("dragstart", () => setOpen(false));

    /* MapLibre's attribution listens for the same: tile loads fire sourcedata too, and change no credit. */
    this.handlers = {
      styledata: () => update(),
      sourcedata: (event) => {
        if (event.sourceDataType === "metadata" || event.sourceDataType === "visibility") update();
      },
      terrain: () => update(),
      moveend: () => update(true),
      move: drawScale,
    };
    for (const [event, fn] of Object.entries(this.handlers)) map.on(event, fn);
    this.map = map;
    update();
    drawScale();
    return this.container;
  }

  onRemove() {
    for (const [event, fn] of Object.entries(this.handlers)) this.map.off(event, fn);
    this.container.remove();
  }
}
