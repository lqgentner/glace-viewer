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

/* The panel covers most of a phone screen, so on a narrow viewport it opens
 * collapsed to its title bar and the reader taps to open it. Wide viewports open
 * as before. Crossing the breakpoint — a rotation, usually — re-applies the
 * default for the new width rather than carrying over a choice made for a
 * different screen. The query matches the one in style.css. */
const NARROW_VIEWPORT = window.matchMedia("(max-width: 640px)");

function setPanelOpen(open) {
  el("panel-body").hidden = !open;
  const toggle = el("panel-toggle");
  toggle.setAttribute("aria-expanded", String(open));
  const action = open ? "Hide the controls" : "Show the controls";
  toggle.title = action;
  toggle.setAttribute("aria-label", action);
  // `up` marks the collapsed state, as it does on the inventories toggle.
  toggle.querySelector(".chevron").classList.toggle("up", !open);
}

function initControls() {
  el("panel-toggle").addEventListener("click", () => setPanelOpen(el("panel-body").hidden));
  NARROW_VIEWPORT.addEventListener("change", (event) => setPanelOpen(!event.matches));
  setPanelOpen(!NARROW_VIEWPORT.matches);

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
