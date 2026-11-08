/*
 * The inventory index validation in scripts/build-tiles.mjs. The index supplies
 * the layer name and the zoom range tippecanoe is given, so a missing or
 * mistyped field must stop the run before any archive is rebuilt.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { validate } from "../scripts/build-tiles.mjs";

const entry = (overrides = {}) => ({
  id: "sgi2023",
  url: "sgi2023.pmtiles",
  source_layer: "sgi2023",
  min_zoom: 4,
  max_zoom: 14,
  ...overrides,
});

test("accepts the committed index", () => {
  const index = JSON.parse(fs.readFileSync(new URL("../data/inventories.json", import.meta.url), "utf8"));
  assert.deepEqual(validate(index), index.inventories);
});

test("accepts an empty list", () => {
  assert.deepEqual(validate({ inventories: [] }), []);
});

test("rejects a missing array", () => {
  for (const index of [{}, { inventories: {} }, { inventories: null }, [], null]) {
    assert.throws(() => validate(index), /inventories/, JSON.stringify(index));
  }
});

test("rejects a non-object entry", () => {
  assert.throws(() => validate({ inventories: ["sgi2023"] }), /entry 0/);
});

test("names the entry and the missing field", () => {
  for (const field of ["id", "url", "source_layer", "min_zoom", "max_zoom"]) {
    const broken = entry();
    delete broken[field];
    assert.throws(
      () => validate({ inventories: [broken] }),
      (error) => error.message.includes(field) && (field === "id" || error.message.includes("sgi2023")),
      field,
    );
  }
});

test("rejects a mistyped field", () => {
  for (const [field, value] of [["min_zoom", "4"], ["max_zoom", 14.5], ["source_layer", 3], ["min_zoom", true]]) {
    assert.throws(() => validate({ inventories: [entry({ [field]: value })] }), new RegExp(field), field);
  }
});

test("rejects an inverted zoom range", () => {
  assert.throws(() => validate({ inventories: [entry({ min_zoom: 14, max_zoom: 4 })] }), /min_zoom is above max_zoom/);
});

test("rejects a url that is not a PMTiles archive", () => {
  /* The GeoJSON beside it would be the archive itself, which tippecanoe --force deletes. */
  for (const url of ["agi5", "agi5.geojson"]) {
    assert.throws(() => validate({ inventories: [entry({ url })] }), /\.pmtiles/, url);
  }
});

test("checks every entry before returning", () => {
  /* Nothing is built until the whole index is known to be sound. */
  assert.throws(() => validate({ inventories: [entry(), entry({ id: "second", url: null })] }), /second/);
});
