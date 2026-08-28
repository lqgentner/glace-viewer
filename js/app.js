/*
 * GLACE quick-look viewer — startup and control wiring.
 *
 * The tile directory defaults to ./tiles and can be pointed anywhere with
 * ?tiles=<base-url>, which is how a GitHub Pages copy of this page reads
 * archives hosted on object storage.
 *
 * Every control is wired here, before anything has loaded, and every handler
 * that touches the map waits on `styleReady` rather than being attached late.
 * A box ticked while the basemap is still streaming therefore behaves exactly
 * like one ticked afterwards — which it did not, when the wiring itself waited
 * for the map.
 */

import { TERRAIN_CREDIT } from "./config.js";
import { map, setHillshade, setHillshadeStrength, toggleBasemapLabels } from "./map.js";
import { grid, loadInventories } from "./overlays.js";
import { loadRasters, manifestBounds } from "./rasters.js";
import { creditButton, el } from "./ui.js";

function initControls() {
  el("hillshade-row").append(creditButton(TERRAIN_CREDIT.title, TERRAIN_CREDIT));
  el("hillshade").addEventListener("change", (event) => {
    el("hillshade-strength-row").hidden = !event.target.checked;
    setHillshade(event.target.checked);
  });
  el("hillshade-strength").addEventListener("input", (event) => {
    el("hillshade-strength-value").textContent = `${event.target.value}%`;
    setHillshadeStrength(Number(event.target.value) / 100);
  });

  el("basemap").addEventListener("change", (event) => toggleBasemapLabels(event.target.checked));
  el("grid").addEventListener("change", (event) => grid.setEnabled(event.target.checked));
}

async function boot() {
  initControls();
  // The inventory list is independent of the map and the raster manifest, so it
  // is built at once: waiting for them made the panel jump as it grew.
  loadInventories();

  const manifest = await loadRasters();
  // Frame the data the first time the page is opened without a #hash.
  if (manifest && !location.hash) {
    map.fitBounds(manifestBounds(manifest), {
      padding: { top: 40, bottom: 40, left: 324, right: 40 },
      animate: false,
    });
  }
}

boot();
