/*
 * Deployment endpoints and defaults.
 *
 * Only things a different deployment might reasonably point elsewhere live
 * here: the archive locations, the basemap build and the terrain service. Query
 * parameters override the ones a reader is expected to switch by hand, which is
 * how the GitHub Pages copy of this page reads archives from object storage
 * instead of the local ./tiles directory.
 *
 * Paint expressions, layout constants and DOM ids deliberately stay in the
 * modules that use them; they are code, not configuration.
 */

const params = new URLSearchParams(location.search);

export const TILES_BASE = (params.get("tiles") || "tiles").replace(/\/$/, "");
export const LAYER_MANIFEST_URL = `${TILES_BASE}/layers.json`;

/* The inventory archives are build outputs committed beside the page, so they
 * are always served from the same origin as index.html. */
export const INVENTORY_BASE = "data";
export const INVENTORY_INDEX_URL = `${INVENTORY_BASE}/inventories.json`;

/* Protomaps' free daily basemap build, mirrored on Source Cooperative.
 * Serves CORS `*` and honours range requests, so it can be read cross-origin. */
export const BASEMAP_URL =
  params.get("basemap") ||
  "https://data.source.coop/protomaps/openstreetmap/v4.pmtiles";
export const BASEMAP_FLAVOR = params.get("flavor") || "grayscale";
export const BASEMAP_ASSETS = "https://protomaps.github.io/basemaps-assets";

/* Mapterhorn global terrain, terrarium-encoded, 512 px WEBP tiles. */
export const TERRAIN_TILEJSON = "https://tiles.mapterhorn.com/tilejson.json";
export const TERRAIN_CREDIT = {
  title: "Mapterhorn Terrain Tiles",
  citation: "© Mapterhorn",
  links: [
    { label: "Attribution", url: "https://mapterhorn.com/attribution/" },
    { label: "Data Access", url: "https://mapterhorn.com/data-access/" },
  ],
};
