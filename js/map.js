/*
 * Map singleton, layer ordering, basemap, labels, and terrain. GLACE and inventory
 * layers use PMTiles; basemap and terrain use tile endpoints.
 */

import {
  BASEMAP_ASSETS,
  BASEMAP_FLAVOR,
  BASEMAP_URL,
  INITIAL_VIEW,
  OVERVIEW,
  TERRAIN_TILEJSON,
  WORLD_IMAGERY_URL,
} from "./config.js";
import { protocol } from "./archive.js";
import { compositeProtocol } from "./composite.js";
import { MapControls } from "./controls.js";
import { StatusControl } from "./status.js";
import { el, PHONE, setStatus } from "./ui.js";

/* Raster archives are read through the shared, cached readers of js/archive.js. */
maplibregl.addProtocol("pmtiles", protocol.tile);

/* False color composed from two value-encoded archives; see js/composite.js. */
maplibregl.addProtocol("glace-rgb", compositeProtocol);

/*
 * Increase label contrast over rasters through the flavor, retaining the
 * generator's narrow, unblurred halos. Water halos and POI colors keep their
 * defaults.
 */
const DARK_FLAVORS = new Set(["black", "dark"]);
const LABEL_FIELDS = [
  "roads_label_minor",
  "roads_label_major",
  "ocean_label",
  "subplace_label",
  "city_label",
  "state_label",
  "country_label",
  "address_label",
];
// A copy: namedFlavor() hands back the library's own object.
const flavor = { ...basemaps.namedFlavor(BASEMAP_FLAVOR) };
const [labelFace, labelHalo] = DARK_FLAVORS.has(BASEMAP_FLAVOR)
  ? ["#f8fafc", "#000000"]
  : ["#000000", "#ffffff"];
for (const field of LABEL_FIELDS) {
  flavor[field] = labelFace;
  if (`${field}_halo` in flavor) flavor[`${field}_halo`] = labelHalo;
}
const basemapLayers = basemaps.layers("protomaps", flavor, { lang: "en" });

/*
 * MapLibre's own atmosphere around the globe, per basemap: fainter over the
 * vector basemap, which its haze pales. The sky and fog stay clear, as with no
 * sky at all, so a tilted view close in shows the space behind the canvas.
 */
const ATMOSPHERE = { vector: 0.5, imagery: 0.8 };
const sky = (basemap) => ({
  "sky-color": "transparent",
  "horizon-color": "transparent",
  "fog-color": "transparent",
  "fog-ground-blend": 1,
  "atmosphere-blend": ATMOSPHERE[basemap] ?? ATMOSPHERE.vector,
});

const style = {
  version: 8,
  /* MapLibre interpolates from globe at z11 to Mercator at z12. */
  projection: { type: "globe" },
  /* The vector basemap shows until setBasemap() reads the URL. */
  sky: sky("vector"),
  glyphs: `${BASEMAP_ASSETS}/fonts/{fontstack}/{range}.pbf`,
  sprite: `${BASEMAP_ASSETS}/sprites/v4/${BASEMAP_FLAVOR}`,
  sources: {
    protomaps: {
      type: "vector",
      url: BASEMAP_URL,
      /* Keep these credits together: MapLibre sorts attribution strings by length. */
      attribution:
        '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>' +
        ' | <a href="https://protomaps.com">Protomaps</a>',
    },
  },
  layers: basemapLayers,
};

/*
 * Save non-label visibility so basemap swaps preserve data layers. Symbols remain
 * under the separate label toggle.
 */
const VECTOR_BASEMAP_LAYERS = new Map(
  style.layers
    .filter((layer) => layer.type !== "symbol")
    .map((layer) => [layer.id, layer.layout?.visibility ?? "visible"]),
);
const WORLD_IMAGERY_SOURCE = "world-imagery";
const WORLD_IMAGERY_LAYER = "world-imagery";

/* Report the missing WebGL2 context before dependent modules stop. */
function createMap() {
  try {
    return new maplibregl.Map({
      container: "map",
      style,
      center: INITIAL_VIEW.center,
      zoom: INITIAL_VIEW.zoom,
      minZoom: INITIAL_VIEW.minZoom,
      maxZoom: INITIAL_VIEW.maxZoom,
      // The view lives in the URL, so a hash overrides the opening view above.
      hash: true,
      attributionControl: false,
    });
  } catch (error) {
    setStatus(
      "map",
      "This browser cannot display the map: it needs WebGL2. " +
        "Try another browser, or turn on hardware acceleration.",
      "error",
    );
    throw error;
  }
}

export const map = createMap();

/* The scale bar and the credits, MapLibre's among them, in one line of text. */
map.addControl(new StatusControl(), "bottom-right");

map.on("error", (event) => {
  if (event.error) console.warn("maplibre:", event.error.message);
});

/*
 * Source creation needs a parsed style, not loaded tiles. Share style.load across
 * controls: load fires only once, while isStyleLoaded() can become false again as
 * tiles stream.
 */
export const styleReady = new Promise((resolve) => map.once("style.load", resolve));

/* ---------- layer ordering ---------- */

function firstSymbolLayer() {
  for (const layer of map.getStyle().layers) {
    if (layer.type === "symbol") return layer.id;
  }
  return undefined;
}

/*
 * Bottom to top: basemap, rasters, hillshade, overlays, labels. Insert by kind so
 * lazy creation and click order cannot change the stack.
 */
const STACK = ["data", "hillshade", "overlay"];

/* Layer ID -> kind. Stale entries are harmless: lookups only visit current layers. */
const layerKinds = new Map();

export function addStacked(kind, layer) {
  const above = STACK.slice(STACK.indexOf(kind) + 1);
  const before =
    map.getStyle().layers.find((other) => above.includes(layerKinds.get(other.id)))?.id ??
    firstSymbolLayer();
  map.addLayer(layer, before);
  layerKinds.set(layer.id, kind);
}

/* ---------- basemap ---------- */

function ensureWorldImagery() {
  if (!map.getSource(WORLD_IMAGERY_SOURCE)) {
    map.addSource(WORLD_IMAGERY_SOURCE, {
      type: "raster",
      tiles: [WORLD_IMAGERY_URL],
      tileSize: 256,
      maxzoom: 19,
      // The status line credits Esri and the imagery's sources in view.
    });
  }
  if (!map.getLayer(WORLD_IMAGERY_LAYER)) {
    /* Imagery stays below data, relief, overlays, and labels. */
    map.addLayer(
      {
        id: WORLD_IMAGERY_LAYER,
        type: "raster",
        source: WORLD_IMAGERY_SOURCE,
        layout: { visibility: "none" },
      },
      map.getStyle().layers[0]?.id,
    );
  }
}

export async function setBasemap(value) {
  await styleReady;
  const imagery = value === "imagery";
  if (imagery) ensureWorldImagery();
  for (const [id, visibility] of VECTOR_BASEMAP_LAYERS) {
    map.setLayoutProperty(id, "visibility", imagery ? "none" : visibility);
  }
  if (map.getLayer(WORLD_IMAGERY_LAYER)) {
    map.setLayoutProperty(WORLD_IMAGERY_LAYER, "visibility", imagery ? "visible" : "none");
  }
  map.setSky(sky(value));
}

/* ---------- basemap labels ---------- */

export async function toggleBasemapLabels(on) {
  await styleReady;
  for (const layer of map.getStyle().layers) {
    if (layer.type === "symbol" && layer.source === "protomaps") {
      map.setLayoutProperty(layer.id, "visibility", on ? "visible" : "none");
    }
  }
}

/* ---------- terrain ---------- */

/* Hillshade and 3D share one DEM source, created on first use. */
const TERRAIN_SOURCE = "terrain";

function ensureTerrainSource() {
  if (map.getSource(TERRAIN_SOURCE)) return;
  /* Inherit the DEM's TileJSON attribution; a source-level value would replace it. */
  map.addSource(TERRAIN_SOURCE, { type: "raster-dem", url: TERRAIN_TILEJSON });
}

/* ---------- hillshade ---------- */

const HILLSHADE_LAYER = "hillshade";

const hillshade = { on: false, strength: 0.6 };

/*
 * MapLibre has no blend modes or hillshade-opacity. Transparent highlights and
 * black shadows approximate multiply; strength controls shadow and accent alpha.
 */
function hillshadePaint(strength) {
  return {
    "hillshade-method": "igor",
    "hillshade-illumination-direction": 315,
    "hillshade-exaggeration": 0.5,
    "hillshade-highlight-color": "rgba(255, 255, 255, 0)",
    "hillshade-shadow-color": `rgba(0, 0, 0, ${strength.toFixed(3)})`,
    "hillshade-accent-color": `rgba(0, 0, 0, ${(strength * 0.5).toFixed(3)})`,
  };
}

function ensureHillshade() {
  if (map.getLayer(HILLSHADE_LAYER)) return;
  ensureTerrainSource();
  addStacked("hillshade", {
    id: HILLSHADE_LAYER,
    type: "hillshade",
    source: TERRAIN_SOURCE,
    layout: { visibility: "none" },
    paint: hillshadePaint(hillshade.strength),
  });
}

export async function setHillshade(on) {
  hillshade.on = on;
  await applyHillshade();
}

export async function setHillshadeStrength(strength) {
  hillshade.strength = strength;
  await applyHillshade();
}

async function applyHillshade() {
  await styleReady;
  // Do not create hillshade until first enabled.
  if (!hillshade.on && !map.getLayer(HILLSHADE_LAYER)) return;
  ensureHillshade();
  map.setLayoutProperty(HILLSHADE_LAYER, "visibility", hillshade.on ? "visible" : "none");
  for (const [property, value] of Object.entries(hillshadePaint(hillshade.strength))) {
    map.setPaintProperty(HILLSHADE_LAYER, property, value);
  }
}

/* ---------- 3D ---------- */

/* Match MapLibre's default maxPitch. */
const THREE_D_PITCH = 60;
const THREE_D_DURATION_MS = 600;
const TERRAIN_EXAGGERATION = 1;

const view = { threeD: false };

/*
 * Set tilt: false when restoring terrain from a pitched hash to preserve its
 * camera; north: true to face north as the camera levels.
 */
export async function setThreeD(on, { tilt = true, north = false } = {}) {
  view.threeD = on;
  controls.setThreeD(on);
  await styleReady;
  if (on) {
    ensureTerrainSource();
    map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: TERRAIN_EXAGGERATION });
  } else {
    // Retain the DEM source for hillshade and future terrain use.
    map.setTerrain(null);
  }
  // Enable the mesh before animating the camera.
  if (tilt) {
    map.easeTo({ pitch: on ? THREE_D_PITCH : 0, ...(north && { bearing: 0 }), duration: THREE_D_DURATION_MS });
  }
}

/*
 * A tilt by hand past this many degrees turns 3D on; one that ends below it
 * levels the map and turns 3D off.
 */
const TILT_3D = 5;
let tilts = 0;

/*
 * MapLibre marks a gesture's or a key's pitchend with its input event; the
 * page's own camera moves carry none. Act once the camera rests: an ease
 * started inside pitchend would be cut off by the bearing snap that follows a
 * gesture, and a touch tilt ends with a second pitchend after its glide. The
 * last tilt wins.
 */
map.on("pitchend", (event) => {
  if (!event?.originalEvent) return;
  const tilt = ++tilts;
  const atRest = () => {
    if (tilt !== tilts) return;
    if (map.isMoving()) map.once("moveend", () => setTimeout(atRest, 0));
    else followTilt(map.getPitch());
  };
  setTimeout(atRest, 0);
});

function followTilt(pitch) {
  if (pitch >= TILT_3D) {
    if (!view.threeD) setThreeD(true, { tilt: false });
    return;
  }
  if (view.threeD) setThreeD(false, { tilt: false });
  if (pitch > 0) map.easeTo({ pitch: 0, duration: THREE_D_DURATION_MS });
}

const controls = new MapControls({
  onThreeD: (on) => setThreeD(on),
  onNorth: () => setThreeD(false, { north: true }),
});

/*
 * Off the phone the controls stand in the bottom right corner, which MapLibre
 * stacks, so they ride above the status line as its credits wrap. On phones
 * that corner rides the sheet, so they stand in the top right.
 */
const placeControls = () => {
  if (controls.map) map.removeControl(controls);
  map.addControl(controls, PHONE.matches ? "top-right" : "bottom-right");
};
placeControls();
PHONE.addEventListener("change", placeControls);

/* ---------- home ---------- */

/* Below this zoom the GLACE rasters do not draw. */
const HOME_MIN_ZOOM = 4;
let dataBounds = null;

const home = el("home");
home.querySelector("span").textContent = OVERVIEW.label;
home.addEventListener("click", () =>
  map.flyTo({ center: OVERVIEW.center, zoom: OVERVIEW.zoom, bearing: 0 }),
);

/* Shown when zoomed out past the rasters or panned off the catalog's extent. */
function syncHome() {
  let away = map.getZoom() < HOME_MIN_ZOOM;
  if (!away && dataBounds) {
    const view = map.getBounds();
    const [west, south, east, north] = dataBounds;
    away =
      view.getEast() < west || view.getWest() > east || view.getNorth() < south || view.getSouth() > north;
  }
  home.hidden = !away;
}

/** The catalog's [west, south, east, north], once read. */
export function setDataBounds(bounds) {
  dataBounds = bounds;
  syncHome();
}

syncHome();
map.on("moveend", syncHome);

/* The hash saves pitch but not terrain. */
if (map.getPitch() > 0) setThreeD(true, { tilt: false });
