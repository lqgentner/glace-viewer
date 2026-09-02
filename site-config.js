/*
 * Per-deployment overrides for the viewer.
 *
 * A plain script rather than a module or a fetched JSON file, deliberately: it
 * is loaded before js/app.js and cannot fail asynchronously, so a deployment
 * can repoint the archives without adding another way for startup to break.
 * Everything here is optional — with the object left empty the page uses the
 * built-in defaults in js/config.js, which is what the GitHub Pages copy does.
 *
 * Precedence is defaults -> this file -> query parameters, so `?tiles=` still
 * wins over `tilesBase` below and a reader can point the page somewhere else
 * without a redeploy.
 *
 * Keys, with their defaults:
 *
 *   tilesBase        "tiles"        where layers.json and the raster archives live
 *   inventoryBase    "data"         where the inventory archives and index live
 *   gridArchive      "tile-grid.pmtiles"   catalog grid archive, under tilesBase
 *   gridSourceLayer  "grid"         layer name inside it (webmap.TILE_GRID_LAYER)
 *   basemapUrl       Protomaps' daily planet build on Source Cooperative
 *   basemapFlavor    "grayscale"    grayscale | black | dark | light | white
 *   basemapAssets    Protomaps' fonts and sprites endpoint
 *   worldImageryUrl  Esri World Imagery XYZ tile template
 *   terrainTilejson  Mapterhorn's global terrain
 *   terrainCredit    { title, citation, links } shown behind the hillshade's info mark
 *   initialView      { center: [lon, lat], zoom, maxZoom } before the #hash applies
 *
 * `initialView` and `terrainCredit` are merged key by key, so naming just
 * `zoom` keeps the default centre and maximum.
 */

window.GLACE_CONFIG = {
  // tilesBase: "https://data.source.coop/your-org/glace",
  // initialView: { center: [7.66, 45.98], zoom: 8 },
};
