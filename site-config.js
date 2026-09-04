/*
 * Per-deployment overrides for the viewer.
 *
 * A plain script rather than a module or a fetched JSON file, deliberately: it
 * is loaded before js/app.js and cannot fail asynchronously, so a deployment
 * can repoint the archives without adding another way for startup to break.
 * Everything here is optional, and everything left out falls back to the
 * built-in defaults in js/config.js. This copy is the GitHub Pages deployment
 * as well as the template, so it names the one thing that is not a sensible
 * built-in default: the bucket the archives are actually published to.
 *
 * Precedence is defaults -> this file -> query parameters, so `?tiles=` still
 * wins over `tilesBase` below and a reader can point the page somewhere else
 * without a redeploy.
 *
 * Keys, with their defaults:
 *
 *   tilesBase        "tiles"        where layers.json and the raster archives live
 *   inventoryBase    "data"         where the inventory archives and index live
 *   gridIndex        "tiles.parquet"  the catalog grid's item index, under tilesBase
 *   cogReaderUrl     @developmentseed/geotiff on esm.sh, for js/cog-rgb.js
 *   hyparquetUrl     hyparquet on esm.sh, for the tile grid
 *   basemapUrl       Protomaps' hosted API, as a TileJSON URL with an API key
 *   basemapFlavor    "dark"         grayscale | black | dark | light | white
 *   basemapAssets    Protomaps' fonts and sprites endpoint
 *   worldImageryUrl  Esri World Imagery XYZ tile template
 *   terrainTilejson  Mapterhorn's global terrain
 *   terrainCredit    { title, citation, links } shown behind the hillshade's info mark
 *   initialView      { center: [lon, lat], zoom, maxZoom } before the #hash applies
 *
 * `initialView` and `terrainCredit` are merged key by key, so naming just
 * `zoom` keeps the default centre and maximum.
 *
 * The two library URLs are imported and executed, so unlike the endpoints above
 * they are not reachable from the address bar. Repoint them to pin a version or
 * to serve the libraries from your own origin; leave them alone otherwise.
 */

window.GLACE_CONFIG = {
  /* The GLACE store on Source Cooperative, read straight from object storage:
   * it allows anonymous reads and sends CORS `*` with the exposed range headers
   * both the PMTiles and the COG client need.
   *
   * This is `glace-ch`, the Switzerland-only rehearsal build — the layout and
   * the machinery of the full store over one scope, published to be exercised
   * before the Alps dataset arrives. Each year is there twice: pre-styled
   * PMTiles under `{year}/pmtiles/`, which is what this page draws, and the
   * float COGs they were styled from under `{year}/mosaics/`, which the STAC
   * items point at for quantitative work.
   *
   * `?tiles=` still wins over this, which is how a local build or the next store
   * gets looked at without a redeploy. */
  tilesBase: "https://data.source.coop/lqgentner/glace-ch",

  // The manifest's own bounds frame the map on arrival, so the view below is
  // only what shows before it loads, and what is left if it never does.
  // initialView: { center: [7.66, 45.98], zoom: 8 },
};
