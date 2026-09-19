/*
 * Startup and control wiring. Handlers are attached immediately and await
 * styleReady before mutating the map.
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

/*
 * Match the CSS breakpoint. Crossing it resets the panel to the default for the new
 * viewport width.
 */
const NARROW_VIEWPORT = window.matchMedia("(max-width: 640px)");

function setPanelOpen(open) {
  // Set both classes to override the CSS default on either side of the breakpoint.
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
  // Load the independent inventory list immediately to avoid panel layout shifts.
  loadInventories();

  await loadRasters();
}

boot();
