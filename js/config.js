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
  /* The root of the published STAC catalog: the page reads the mosaics
   * collection under it for the raster layers, and the tiles collection's item
   * index for the catalog grid. It was a directory of PMTiles beside a
   * `layers.json` until the store retired that manifest; nothing about the
   * archives moved, but where the page learns of them did — see js/store.js. */
  tilesBase: "tiles",
  /* The inventory archives are build outputs committed beside the page, so by
   * default they are served from the same origin as index.html. */
  inventoryBase: "data",

  /* The mosaics collection, which is where the raster layers are enumerated and
   * which points at the MapLibre style that describes how each is drawn.
   * Relative to tilesBase, like everything else the store publishes. */
  mosaicCollection: "mosaics/collection.json",

  /* The catalog tile grid is read from the store's stac-geoparquet item index
   * rather than from an archive built for it — see js/tile-grid.js. Relative to
   * tilesBase, like everything else the store publishes. */
  gridIndex: "tiles/items.parquet",

  /* The COG reader behind js/cog-rgb.js, imported the first time a
   * `glace-rgb://` tile is asked for — which nothing on the page does today,
   * the tile-source switch having been retired in favour of the pre-styled
   * archives. It is ESM-only with bare specifiers and ships no UMD build, so
   * unlike the page's other libraries it cannot be a <script> tag — the CDN is
   * what resolves its dependencies. Deliberately absent from
   * QUERY_PARAMS below: this URL is executed, so it is a deployment decision
   * and must not be settable from the address bar.
   *
   * `?external=lerc` leaves `import("lerc")` bare for the import map in
   * index.html to resolve — see the comment there for why it must not come from
   * this CDN. Change the two together. */
  cogReaderUrl: "https://esm.sh/@developmentseed/geotiff@0.7.0?external=lerc",


  /* The parquet reader behind the tile grid, on the same terms and imported the
   * same way. Also absent from QUERY_PARAMS, and for the same reason. */
  hyparquetUrl: "https://esm.sh/hyparquet@1.29.2",

  /* Protomaps' hosted API: a TileJSON document, read the same way as the
   * Mapterhorn terrain below rather than as a PMTiles archive. Faster than the
   * Source Cooperative mirror this replaced, since it is served from
   * Protomaps' own edge rather than object storage, at the cost of the API key
   * baked into the URL below (from https://protomaps.com/api). */
  basemapUrl: "https://api.protomaps.com/tiles/v4.json?key=54af1e244a8f1599",
  basemapFlavor: "dark",
  basemapAssets: "https://protomaps.github.io/basemaps-assets",

  /* Esri's cached World Imagery service. Kept as a template rather than a
   * TileJSON document because MapLibre can read ArcGIS' XYZ endpoint directly. */
  worldImageryUrl:
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",

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

  /* Where the map opens when the URL carries no #hash naming a view. Centred
   * on the Aletsch Glacier, matching #10/46.51/8.03. */
  initialView: { center: [8.03, 46.51], zoom: 10, maxZoom: 14 },
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
export const MOSAIC_COLLECTION_URL = `${TILES_BASE}/${settings.mosaicCollection}`;

export const INVENTORY_BASE = String(settings.inventoryBase).replace(/\/$/, "");
export const INVENTORY_INDEX_URL = `${INVENTORY_BASE}/inventories.json`;

export const COG_READER_URL = settings.cogReaderUrl;
export const HYPARQUET_URL = settings.hyparquetUrl;

export const GRID_INDEX_URL = `${TILES_BASE}/${settings.gridIndex}`;

export const BASEMAP_URL = settings.basemapUrl;
export const BASEMAP_FLAVOR = settings.basemapFlavor;
export const BASEMAP_ASSETS = settings.basemapAssets;
export const WORLD_IMAGERY_URL = settings.worldImageryUrl;

export const TERRAIN_TILEJSON = settings.terrainTilejson;
export const TERRAIN_CREDIT = settings.terrainCredit;

export const INITIAL_VIEW = settings.initialView;
