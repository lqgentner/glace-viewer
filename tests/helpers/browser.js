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

/* The basemap style @protomaps/basemaps would generate, reduced to the shape
 * the page actually depends on: some non-symbol layers, then the labels that
 * everything else has to stay underneath. */
export const BASEMAP_LAYERS = [
  { id: "earth", type: "background", source: "protomaps" },
  { id: "water", type: "fill", source: "protomaps" },
  { id: "places", type: "symbol", source: "protomaps" },
  { id: "roads_label", type: "symbol", source: "protomaps" },
];

/* The page never exports its map — it is a module singleton created at import
 * time — so the fake records each instance and the harness hands the test the
 * one the modules are actually using. */
let created = [];

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
    for (const layer of options.style.layers) {
      this.layers.set(layer.id, structuredClone(layer));
      this.order.push(layer.id);
    }
  }

  addControl() {}

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

  queryRenderedFeatures() {
    return this.hits;
  }

  fitBounds(bounds, options) {
    this.calls.push("fitBounds");
    this.fitted = { bounds, options };
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
 * Install a DOM and the three globals the page expects from its script tags.
 *
 * @param {object} [options]
 * @param {string} [options.search]  query string, e.g. "?flavor=dark"
 * @param {object} [options.site]    the object site-config.js would set
 * @param {Record<string, string>} [options.files]  URL -> path for fetch()
 */
export function installBrowser({ search = "", site, files = {} } = {}) {
  created = [];
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

  const popups = [];
  globalThis.maplibregl = {
    addProtocol() {},
    Map: FakeMap,
    NavigationControl: class {},
    ScaleControl: class {},
    AttributionControl: class {},
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
  globalThis.basemaps = {
    namedFlavor: () => ({}),
    layers: () => structuredClone(BASEMAP_LAYERS),
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
