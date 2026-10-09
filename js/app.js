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
import { buildSegmented, creditButton, el, rove, setUrlParams, urlParam } from "./ui.js";

/* What the tile grid shows, in its info popover. */
const GRID_INFO = {
  citation:
    "The catalog's tiling grid: the 10 km squares of the Military Grid Reference System " +
    "(MGRS). The brighter a square, the more of it is covered by Randolph Glacier " +
    "Inventory 7.0 outlines.",
  links: [
    {
      label: "Military Grid Reference System (Wikipedia)",
      url: "https://en.wikipedia.org/wiki/Military_Grid_Reference_System",
    },
  ],
};

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
  // `up` marks the collapsed state.
  toggle.querySelector(".chevron").classList.toggle("up", !open);
}

/*
 * The about dialog. closedby="any" closes it on a click outside; browsers without
 * that attribute get the same from a click on the dialog box's backdrop area.
 */
function initAbout() {
  const about = el("about");
  el("about-open").addEventListener("click", () => about.showModal());
  about.querySelector(".close").addEventListener("click", () => about.close());
  if (!("closedBy" in about)) {
    about.addEventListener("click", (event) => {
      if (event.target !== about) return;
      const box = about.getBoundingClientRect();
      const inside =
        box.left <= event.clientX &&
        event.clientX <= box.right &&
        box.top <= event.clientY &&
        event.clientY <= box.bottom;
      if (!inside) about.close();
    });
  }
}

/* Replace the about text's fixed "since 2015" with the catalog's year range. */
function showAboutYears(years) {
  if (years.length < 2) return;
  el("about-years").textContent = `from ${years[0]} to ${years[years.length - 1]}`;
}

function initControls() {
  initAbout();
  el("panel-toggle").addEventListener("click", (event) => {
    setPanelOpen(event.currentTarget.getAttribute("aria-expanded") !== "true");
  });
  NARROW_VIEWPORT.addEventListener("change", (event) => setPanelOpen(!event.matches));
  setPanelOpen(!NARROW_VIEWPORT.matches);

  const basemapOptions = [
    { value: "vector", label: "Vector" },
    { value: "imagery", label: "Imagery" },
  ];
  const selectBasemap = (value) => {
    for (const button of el("basemap-style").children) {
      button.setAttribute("aria-checked", String(button.dataset.value === value));
    }
    rove(el("basemap-style"));
    setBasemap(value);
    setUrlParams({ base: value === "imagery" ? value : null });
  };
  buildSegmented(el("basemap-style"), basemapOptions, selectBasemap);
  selectBasemap(urlParam("base") === "imagery" ? "imagery" : "vector");

  el("hillshade-row").append(creditButton(TERRAIN_CREDIT.title, TERRAIN_CREDIT));
  el("grid-row").append(creditButton("Catalog tile grid", GRID_INFO, "what it shows"));
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

/*
 * Repeat visits read JSON from sw.js's cache while it revalidates. Skip localhost,
 * where the development server keeps JSON fresh.
 */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || ["localhost", "127.0.0.1"].includes(location.hostname)) {
    return;
  }
  navigator.serviceWorker
    .register("sw.js")
    .catch((error) => console.warn("service worker:", error.message));
}

async function boot() {
  initControls();
  registerServiceWorker();
  // Load the independent inventory list immediately to avoid panel layout shifts.
  loadInventories();

  const axes = await loadRasters();
  if (axes) showAboutYears(axes.years);
}

boot();
