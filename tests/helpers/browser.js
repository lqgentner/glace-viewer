/*
 * A DOM and a fake MapLibre, so the viewer's modules can be exercised without a
 * browser or a network.
 *
 * The fakes are deliberately strict rather than permissive: adding a layer
 * twice, adding one whose source does not exist, or setting a property on a
 * layer that was never added all throw, because each of those is a real bug the
 * page would otherwise hide behind a console warning.
 */

import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

export const REPO = path.join(import.meta.dirname, "..", "..");

/* The flavors @protomaps/basemaps ships, reduced to the label fields the page
 * overrides: the generator reads its label paint from these, so what the page
 * hands it is what the layers get. */
export const FLAVORS = {
  dark: {
    city_label: "#7a7a7a",
    city_label_halo: "#212121",
    roads_label_major: "#666666",
    roads_label_major_halo: "#1f1f1f",
  },
  light: {
    city_label: "#5c5c5c",
    city_label_halo: "#ffffff",
    roads_label_major: "#666666",
    roads_label_major_halo: "#ffffff",
  },
};

/* The basemap style @protomaps/basemaps would generate, reduced to the shape
 * the page actually depends on: some non-symbol layers, then the labels that
 * everything else has to stay underneath. Label paint comes from the flavor,
 * with the generator's fixed 1 px halo. */
export const basemapLayers = (flavor) => [
  { id: "earth", type: "background", source: "protomaps" },
  { id: "water", type: "fill", source: "protomaps" },
  {
    id: "places",
    type: "symbol",
    source: "protomaps",
    layout: { "text-field": ["get", "name"] },
    paint: {
      "text-color": flavor.city_label,
      "text-halo-color": flavor.city_label_halo,
      "text-halo-width": 1,
    },
  },
  {
    id: "roads_label",
    type: "symbol",
    source: "protomaps",
    layout: { "text-field": ["get", "name"] },
    paint: {
      "text-color": flavor.roads_label_major,
      "text-halo-color": flavor.roads_label_major_halo,
      "text-halo-width": 1,
    },
  },
];

/* The page never exports its map — it is a module singleton created at import
 * time — so the fake records each instance and the harness hands the test the
 * one the modules are actually using. */
let created = [];
/* What the #hash would have restored. Module-level because the page never
 * passes a pitch to the constructor — the real map reads it from the URL. */
let initialPitch = 0;

class FakeMap {
  constructor(options) {
    created.push(this);
    this.options = options;
    this.sources = new Map(Object.entries(options.style.sources ?? {}));
    this.layers = new Map();
    this.order = [];
    this.handlers = {};
    this.hits = [];
    this.calls = [];
    this.controlNodes = [];
    this.controls = [];
    this.terrain = null;
    this.pitch = initialPitch;
    this.center = { lng: options.center[0], lat: options.center[1] };
    this.zoom = options.zoom;
    for (const layer of options.style.layers) {
      this.layers.set(layer.id, structuredClone(layer));
      this.order.push(layer.id);
    }
  }

  /* Custom controls are built rather than ignored: the 3D button is DOM the
   * page owns, so a test has to be able to press it. MapLibre's own controls
   * are stubs with no `onAdd` and contribute nothing. */
  addControl(control) {
    // Deliberately not recorded in `calls`: that log is what the tests read to
    // assert nothing has been added to the *map* yet, and controls are attached
    // at construction time rather than in response to anything a reader did.
    // `controls` is separate, and holds what each was constructed with.
    this.controls.push(control);
    if (typeof control.onAdd === "function") this.controlNodes.push(control.onAdd(this));
  }

  setTerrain(spec) {
    if (spec && !this.sources.has(spec.source)) {
      throw new Error(`terrain names missing source '${spec.source}'`);
    }
    this.terrain = spec ?? null;
    this.calls.push(spec ? "+terrain" : "-terrain");
  }

  getTerrain() {
    return this.terrain;
  }

  getPitch() {
    return this.pitch;
  }

  getCenter() {
    return this.center;
  }

  getZoom() {
    return this.zoom;
  }

  getContainer() {
    return window.document.getElementById(this.options.container);
  }

  /* A plate carrée about the centre, scaled like the mercator equator: no
   * globe, no perspective, but enough to tell a whole earth from a glacier —
   * which is all js/sky.js asks of it. */
  project([lng, lat]) {
    const element = this.getContainer();
    const scale = (512 * 2 ** this.zoom) / 360;
    return {
      x: element.clientWidth / 2 + (lng - this.center.lng) * scale,
      y: element.clientHeight / 2 - (lat - this.center.lat) * scale,
    };
  }

  easeTo(options) {
    if (options.pitch !== undefined) this.pitch = options.pitch;
    this.calls.push(`easeTo pitch=${this.pitch}`);
  }

  on(event, fn) {
    (this.handlers[event] ??= []).push(fn);
  }

  off(event, fn) {
    this.handlers[event] = (this.handlers[event] ?? []).filter((f) => f !== fn);
  }

  once(event, fn) {
    const wrapped = (e) => {
      this.off(event, wrapped);
      fn(e);
    };
    this.on(event, wrapped);
  }

  fire(event, payload = {}) {
    for (const fn of [...(this.handlers[event] ?? [])]) fn(payload);
  }

  getStyle() {
    return { layers: this.order.map((id) => this.layers.get(id)) };
  }

  getLayer(id) {
    return this.layers.get(id);
  }

  getSource(id) {
    return this.sources.get(id);
  }

  addSource(id, spec) {
    if (this.sources.has(id)) throw new Error(`source '${id}' added twice`);
    this.sources.set(id, spec);
    this.calls.push(`+source ${id}`);
  }

  removeSource(id) {
    this.sources.delete(id);
    this.calls.push(`-source ${id}`);
  }

  addLayer(layer, before) {
    if (this.layers.has(layer.id)) throw new Error(`layer '${layer.id}' added twice`);
    if (layer.source && !this.sources.has(layer.source)) {
      throw new Error(`layer '${layer.id}' names missing source '${layer.source}'`);
    }
    this.layers.set(layer.id, structuredClone(layer));
    const at = before ? this.order.indexOf(before) : -1;
    if (at === -1) this.order.push(layer.id);
    else this.order.splice(at, 0, layer.id);
    this.calls.push(`+layer ${layer.id}`);
  }

  removeLayer(id) {
    this.layers.delete(id);
    this.order = this.order.filter((other) => other !== id);
    this.calls.push(`-layer ${id}`);
  }

  setLayoutProperty(id, key, value) {
    const layer = this.layers.get(id);
    if (!layer) throw new Error(`setLayoutProperty on missing layer '${id}'`);
    (layer.layout ??= {})[key] = value;
  }

  setPaintProperty(id, key, value) {
    const layer = this.layers.get(id);
    if (!layer) throw new Error(`setPaintProperty on missing layer '${id}'`);
    (layer.paint ??= {})[key] = value;
  }

  // Every lazy source in these tests is answered from disk or not at all, so
  // "has it finished" is only ever asked after the test fires `sourcedata`.
  isSourceLoaded() {
    return true;
  }

  // Only hits on the layers asked for, as MapLibre does, so a test cannot pass
  // on a layer the page never made clickable.
  queryRenderedFeatures(_geometry, { layers } = {}) {
    return layers ? this.hits.filter((hit) => layers.includes(hit.layer.id)) : this.hits;
  }

  /** Index of a layer in draw order; -1 when it does not exist. */
  indexOf(id) {
    return this.order.indexOf(id);
  }

  /** Report every lazily added source as loaded, as its first tiles landing would. */
  settle() {
    for (const id of this.sources.keys()) this.fire("sourcedata", { sourceId: id });
  }
}

/**
 * Install a DOM and the three globals index.html sets before the modules run.
 *
 * @param {object} [options]
 * @param {string} [options.search]  query string, e.g. "?flavor=dark"
 * @param {object} [options.site]    the object site-config.js would set
 * @param {Record<string, string>} [options.files]  URL -> path for fetch()
 * @param {number} [options.pitch]   the pitch a #hash would have restored
 * @param {boolean} [options.narrow] whether the viewport is phone-sized
 * @param {boolean} [options.webgl]  whether the browser can draw at all
 */
export function installBrowser({
  search = "",
  site,
  files = {},
  pitch = 0,
  narrow = false,
  webgl = true,
} = {}) {
  created = [];
  initialPitch = pitch;
  const dom = new JSDOM(fs.readFileSync(path.join(REPO, "index.html"), "utf8"), {
    url: `http://localhost/${search}`,
    runScripts: "outside-only",
  });
  const { window } = dom;

  for (const name of ["window", "document", "location", "HTMLElement", "Node", "Event"]) {
    Object.defineProperty(globalThis, name, {
      value: window[name],
      configurable: true,
      writable: true,
    });
  }

  if (site === undefined) delete globalThis.GLACE_CONFIG;
  else globalThis.GLACE_CONFIG = site;

  /* jsdom has no matchMedia, and the page asks for one at boot to decide
   * whether the panel starts collapsed. The page only ever asks the one
   * question — is this viewport narrow — so the stub answers every query the
   * same way rather than parsing them. */
  const mediaListeners = new Set();
  let narrowViewport = narrow;
  window.matchMedia = (media) => ({
    media,
    get matches() {
      return narrowViewport;
    },
    addEventListener: (_event, fn) => mediaListeners.add(fn),
    removeEventListener: (_event, fn) => mediaListeners.delete(fn),
  });

  const popups = [];
  /* MapLibre 6 throws from the constructor when there is no WebGL2 context. */
  class NoGpuMap {
    constructor() {
      throw new Error("Failed to initialize WebGL2");
    }
  }
  globalThis.maplibregl = {
    addProtocol() {},
    Map: webgl ? FakeMap : NoGpuMap,
    NavigationControl: class {},
    ScaleControl: class {
      constructor(options = {}) {
        this.options = options;
      }
    },
    AttributionControl: class {
      constructor(options = {}) {
        this.options = options;
      }
    },
    Popup: class {
      setLngLat() {
        return this;
      }
      setDOMContent(content) {
        this.content = content;
        return this;
      }
      addTo() {
        popups.push(this);
        return this;
      }
    },
  };
  globalThis.pmtiles = { Protocol: class { tile() {} } };
  /* Enough of the canvas for js/cog-rgb.js to turn its RGBA into tile bytes.
   * The real one encodes a PNG; this hands the raw pixels straight back, which
   * is both simpler and more useful — a test can assert on a channel value
   * instead of decoding an image to find it. */
  globalThis.ImageData = class {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      Object.assign(this, { width, height });
    }
    getContext() {
      return { putImageData: (image) => { this.image = image; } };
    }
    async convertToBlob() {
      const { image } = this;
      return { arrayBuffer: async () => image.data.buffer };
    }
  };
  globalThis.basemaps = {
    namedFlavor: (name) => ({ ...FLAVORS[name] }),
    layers: (_name, flavor) => basemapLayers(flavor),
  };

  globalThis.fetch = async (url) =>
    files[url]
      ? { ok: true, json: async () => JSON.parse(fs.readFileSync(files[url], "utf8")) }
      : { ok: false, status: 404, json: async () => ({}) };

  return {
    window,
    popups,
    /** The map the modules built, once something has imported js/map.js. */
    get map() {
      return created.at(-1);
    },
    el: (id) => window.document.getElementById(id),
    /** Cross the CSS breakpoint, as a rotation would. */
    setNarrow(value) {
      narrowViewport = value;
      for (const fn of mediaListeners) fn({ matches: value });
    },
    /** An element inside one of the custom map controls, by CSS selector. */
    control(selector) {
      for (const node of created.at(-1).controlNodes) {
        const found = node.matches(selector) ? node : node.querySelector(selector);
        if (found) return found;
      }
      return null;
    },
    /** Tick or untick a checkbox the way a click would. */
    change(node, checked) {
      node.checked = checked;
      node.dispatchEvent(new window.Event("change"));
    },
    /** Move a slider the way a drag would. */
    input(node, value) {
      node.value = value;
      node.dispatchEvent(new window.Event("input"));
    },
  };
}

/** Let every already-resolved promise chain run to completion. */
export async function settle(turns = 6) {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Import a module fresh, past the ESM cache, so module-level state is reset.
 *
 * Only safe for a module with no relative imports of its own: the cache-busting
 * query does not travel down a `./sibling.js` specifier, so a module graph
 * imported this way would be spliced across two copies of itself. Anything with
 * imports belongs in its own test file, which `node --test` already runs in its
 * own process.
 */
let generation = 0;
export function freshImport(specifier) {
  generation += 1;
  return import(`${path.join(REPO, specifier)}?${generation}`);
}

/** Import a module by repo-relative path, sharing one module graph per file. */
export function load(specifier) {
  return import(path.join(REPO, specifier));
}

/** Collect console.warn output for the duration of `fn`. */
export async function captureWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}
