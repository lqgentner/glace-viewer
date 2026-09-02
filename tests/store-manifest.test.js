/*
 * The GLACE store's own `layers.json`, as published.
 *
 * `layers-store.json` is one year of it copied verbatim from
 * https://data.source.coop/lqgentner/glace-ch, so this file is where the page
 * meets the manifest the store actually writes rather than one written to suit
 * it. Two things about that manifest are load-bearing and neither is obvious
 * from the code alone:
 *
 *   - Its `polarization` axis carries seven values, not two. A polarization, a
 *     QA role and a channel recipe share the field, and the panel presents only
 *     the plain polarizations.
 *   - It names no COG. The archives are published in pairs under one stem, so
 *     the page derives the second href from the first.
 *
 * Its own file for the same reason cog-source.test.js is: the modules hold state
 * at module scope and the map is a singleton, so a second manifest needs a
 * second process.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { captureWarnings, installBrowser, load, REPO, settle } from "./helpers/browser.js";

const FIXTURE = path.join(REPO, "tests", "fixtures", "layers-store.json");
const raw = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

const MANIFESTS = {
  "tiles/layers.json": FIXTURE,
  "data/inventories.json": path.join(REPO, "data", "inventories.json"),
};

const buttons = (el, id) => Object.fromEntries([...el(id).children].map((b) => [b.dataset.value, b]));

const page = installBrowser({ files: MANIFESTS });
const { el } = page;

/* Loading the page is what proves the drop is silent: a warning here would mean
 * the page is calling a layer the store published correctly malformed. */
const warnings = await captureWarnings(async () => {
  await load("js/app.js");
  page.map.fire("style.load");
  await settle();
});

test("the store's manifest loads without complaint", () => {
  assert.deepEqual(warnings, [], "the QA and false-colour entries are skipped, not reported");
});

test("only the polarizations the panel has a row for are presented", () => {
  // Seven in the file. The two polarizations and the false-colour composite are
  // shown; the four QA diagnostics are layers this page has no control for yet.
  assert.equal(raw.polarizations.length, 7);
  assert.deepEqual(
    [...el("pol").children].map((b) => b.dataset.value),
    ["VV", "VH", "RGB"],
  );
  // 14 entries in, 6 out: two products by three rows.
  assert.equal(raw.layers.length, 14);
  assert.deepEqual(
    [...el("product").children].map((b) => b.dataset.value),
    ["COH12", "RTC"],
  );
});

test("the COG is found beside the archive, though the manifest never names it", () => {
  const { map } = page;
  const entry = raw.layers.find((layer) => layer.id === "coh12_vv_2024");
  assert.equal(entry.cog, undefined, "the store writes no `cog` key");
  assert.equal(entry.url, "2024/pmtiles/coh12_vv.pmtiles");

  // The switch is offered at all, which it would not be if nothing had a COG.
  assert.equal(el("source-row").hidden, false);

  buttons(el, "source").cog.click();
  return settle().then(() => {
    assert.deepEqual(
      map.getSource("glace-cog-coh12_vv_2024").tiles,
      ["glace-rgb://glace-cog-coh12_vv_2024/{z}/{x}/{y}"],
      "the source names a recipe; the recipe names 2024/mosaics/coh12_vv.tif",
    );
  });
});

test("every single-band layer of this year offers both sources", async () => {
  const { map } = page;
  for (const product of ["COH12", "RTC"]) {
    for (const pol of ["VV", "VH"]) {
      buttons(el, "product")[product].click();
      buttons(el, "pol")[pol].click();
      await settle();
      const source = buttons(el, "source");
      assert.equal(source.cog.disabled, false, `${product} ${pol}`);
      assert.ok(
        map.getSource(`glace-cog-${product.toLowerCase()}_${pol.toLowerCase()}_2024`),
        `${product} ${pol} reads its COG`,
      );
    }
  }
});
