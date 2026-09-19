/*
 * Deployment settings, resolved in order: defaults, site-config.js, query
 * parameters. Layout and paint constants stay in their owning modules.
 */

const DEFAULTS = {
  /* Catalog root for raster metadata and the tile-grid index. */
  tilesBase: "tiles",
  /* Generated inventory archives, served alongside the page. */
  inventoryBase: "data",

  /* Raster inventory and style links, relative to tilesBase. */
  mosaicCollection: "mosaics/collection.json",

  /* GeoParquet tile-grid index, relative to tilesBase. */
  gridIndex: "tiles/items.parquet",

  /*
   * Loaded on demand by the unused COG protocol. Keep ?external=lerc aligned with
   * the import map in index.html. Keep executable library URLs out of query
   * parameters.
   */
  cogReaderUrl: "https://esm.sh/@developmentseed/geotiff@0.7.0?external=lerc",

  /* Loaded on demand for the tile grid; also excluded from query overrides. */
  hyparquetUrl: "https://esm.sh/hyparquet@1.30.1",

  /* Protomaps hosted TileJSON. Manage the API key in the Protomaps dashboard. */
  basemapUrl: "https://api.protomaps.com/tiles/v4.json?key=54af1e244a8f1599",
  basemapFlavor: "dark",
  basemapAssets: "https://protomaps.github.io/basemaps-assets",

  /* Esri's XYZ endpoint uses a tile template rather than TileJSON. */
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

  /*
   * Opening view over Aletsch, overridden by the URL hash. minZoom limits how small
   * the globe can appear.
   */
  initialView: { center: [8.03, 46.51], zoom: 10, minZoom: 1, maxZoom: 14 },
};

/* Only viewing endpoints and flavor are query-configurable. */
const QUERY_PARAMS = {
  tilesBase: "tiles",
  basemapUrl: "basemap",
  basemapFlavor: "flavor",
};

const site = globalThis.GLACE_CONFIG ?? {};
for (const key of Object.keys(site)) {
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
