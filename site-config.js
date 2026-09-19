/*
 * Optional deployment overrides, loaded before app.js. Defaults and supported keys
 * live in js/config.js; ?tiles=, ?basemap=, and ?flavor= override this file.
 * initialView and terrainCredit merge by field. Library URLs are deployment-only
 * because they execute code.
 */

window.GLACE_CONFIG = {
  /* Catalog root; override with ?tiles= to inspect another store. */
  tilesBase: "https://data.source.coop/lqgentner/glace-ch",

  // Set the opening view when changing the catalog extent.
  // initialView: { center: [7.66, 45.98], zoom: 8 },
};
