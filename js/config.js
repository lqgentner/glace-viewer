/*
 * Deployment endpoints and defaults, and the one place they are resolved.
 *
 * Three layers, in increasing precedence: the built-in defaults below, the
 * optional `site-config.js` a deployment can drop in beside index.html, and the
 * query parameters a reader can set from the address bar. `site-config.js` is a
 * plain script rather than another fetched JSON file so that overriding an
 * endpoint cannot introduce an asynchronous startup failure — it is either
 * there before the modules run or it is not.
 *
 * Only things a different deployment might reasonably point elsewhere live
 * here. Paint expressions, layout constants, the click radius and DOM ids stay
 * in the modules that use them; they are code, not configuration. So does the
 * fit padding, which is derived from `#panel`'s width in style.css and would
 * drift from it the moment it became a knob.
 */

const DEFAULTS = {
  tilesBase: "tiles",
  /* The inventory archives are build outputs committed beside the page, so by
   * default they are served from the same origin as index.html. */
  inventoryBase: "data",

  gridArchive: "tile-grid.pmtiles",
  // Layer name inside the archive, set by webmap.TILE_GRID_LAYER. A vector
  // layer whose `source-layer` does not match renders nothing and says nothing,
  // so it travels with the archive name rather than living apart from it.
  gridSourceLayer: "grid",

  /* Protomaps' free daily basemap build, mirrored on Source Cooperative.
   * Serves CORS `*` and honours range requests, so it can be read cross-origin. */
  basemapUrl: "https://data.source.coop/protomaps/openstreetmap/v4.pmtiles",
  basemapFlavor: "dark",
  basemapAssets: "https://protomaps.github.io/basemaps-assets",

  /* Mapterhorn global terrain, terrarium-encoded, 512 px WEBP tiles. */
  terrainTilejson: "https://tiles.mapterhorn.com/tilejson.json",
  terrainCredit: {
    title: "Mapterhorn Terrain Tiles",
    citation: "© Mapterhorn",
    links: [
      { label: "Attribution", url: "https://mapterhorn.com/attribution/" },
      { label: "Data Access", url: "https://mapterhorn.com/data-access/" },
    ],
  },

  /* Where the map opens when the URL carries no #hash naming a view. */
  initialView: { center: [10.4, 46.5], zoom: 6.2, maxZoom: 14 },
};

/* The subset a reader is expected to switch by hand, and the parameter name for
 * each. Anything not listed here is a deployment decision rather than a viewing
 * one, and is not reachable from the address bar. */
const QUERY_PARAMS = {
  tilesBase: "tiles",
  basemapUrl: "basemap",
  basemapFlavor: "flavor",
};

const site = globalThis.GLACE_CONFIG ?? {};
for (const key of Object.keys(site)) {
  // Almost always a typo: a misspelled key would otherwise be silently ignored
  // and the deployment would look like it had no effect.
  if (!(key in DEFAULTS)) console.warn(`site-config.js: unknown setting '${key}'`);
}

const settings = {
  ...DEFAULTS,
  ...site,
  // Merged a key deeper, so naming one field of either does not drop the rest.
  initialView: { ...DEFAULTS.initialView, ...site.initialView },
  terrainCredit: { ...DEFAULTS.terrainCredit, ...site.terrainCredit },
};

const params = new URLSearchParams(location.search);
for (const [key, param] of Object.entries(QUERY_PARAMS)) {
  const value = params.get(param);
  if (value) settings[key] = value;
}

export const TILES_BASE = String(settings.tilesBase).replace(/\/$/, "");
export const LAYER_MANIFEST_URL = `${TILES_BASE}/layers.json`;

export const INVENTORY_BASE = String(settings.inventoryBase).replace(/\/$/, "");
export const INVENTORY_INDEX_URL = `${INVENTORY_BASE}/inventories.json`;

export const GRID_ARCHIVE_URL = `${TILES_BASE}/${settings.gridArchive}`;
export const GRID_SOURCE_LAYER = settings.gridSourceLayer;

export const BASEMAP_URL = settings.basemapUrl;
export const BASEMAP_FLAVOR = settings.basemapFlavor;
export const BASEMAP_ASSETS = settings.basemapAssets;

export const TERRAIN_TILEJSON = settings.terrainTilejson;
export const TERRAIN_CREDIT = settings.terrainCredit;

export const INITIAL_VIEW = settings.initialView;
