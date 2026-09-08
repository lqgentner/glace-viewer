/*
 * GLACE quick-look viewer — startup and control wiring.
 *
 * The catalog is read from wherever `tilesBase` points — site-config.js on the
 * deployed page, or `?tiles=<base-url>` from the address bar.
 *
 * Every control is wired here, before anything has loaded, and every handler
 * that touches the map waits on `styleReady` rather than being attached late.
 * A box ticked while the basemap is still streaming therefore behaves exactly
 * like one ticked afterwards — which it did not, when the wiring itself waited
 * for the map.
 */

import { TERRAIN_CREDIT } from "./config.js";
import {
  map,
  setBasemap,
  setHillshade,
  setHillshadeStrength,
  toggleBasemapLabels,
} from "./map.js";
import { grid, loadInventories } from "./overlays.js";
import { loadRasters } from "./rasters.js";
import { buildSegmented, collapsible, creditButton, el } from "./ui.js";

/* The panel covers most of a phone screen, so on a narrow viewport it opens
 * collapsed to its title bar and the reader taps to open it. Wide viewports open
 * as before. Crossing the breakpoint — a rotation, usually — re-applies the
 * default for the new width rather than carrying over a choice made for a
 * different screen. The query matches the one in style.css. */
const NARROW_VIEWPORT = window.matchMedia("(max-width: 640px)");

function setPanelOpen(open) {
  // Both classes are always set, so the state is explicit on either side of the
  // breakpoint: style.css collapses a narrow panel until `expanded` appears,
  // and expands a wide one until `collapsed` does.
  el("panel").classList.toggle("expanded", open);
  el("panel").classList.toggle("collapsed", !open);
  const toggle = el("panel-toggle");
  toggle.setAttribute("aria-expanded", String(open));
  const action = open ? "Hide the controls" : "Show the controls";
  toggle.title = action;
  toggle.setAttribute("aria-label", action);
  // `up` marks the collapsed state, as it does on the inventories toggle.
  toggle.querySelector(".chevron").classList.toggle("up", !open);
}

function initControls() {
  el("panel-toggle").addEventListener("click", (event) => {
    setPanelOpen(event.currentTarget.getAttribute("aria-expanded") !== "true");
  });
  NARROW_VIEWPORT.addEventListener("change", (event) => setPanelOpen(!event.matches));
  setPanelOpen(!NARROW_VIEWPORT.matches);

  const basemapOptions = [
    { value: "vector", label: "Vector" },
    { value: "imagery", label: "World Imagery" },
  ];
  const selectBasemap = (value) => {
    for (const button of el("basemap-style").children) {
      button.setAttribute("aria-checked", String(button.dataset.value === value));
    }
    setBasemap(value);
  };
  buildSegmented(el("basemap-style"), basemapOptions, selectBasemap);
  selectBasemap("vector");

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
  collapsible("extras-toggle", "extras");
}

async function boot() {
  initControls();
  // The inventory list is independent of the map and the raster catalog, so it
  // is built at once: waiting for them made the panel jump as it grew.
  loadInventories();

  await loadRasters();
}

boot();
