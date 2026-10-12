/*
 * Stage the libraries into a temporary site and walk the import graph as a
 * browser resolves it: bare names only through the import map, relative ones
 * beside their importer. Node's own resolution would find any package in
 * node_modules and hide a missing mapping.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { init, parse } from "es-module-lexer";

import { importMap, stageLibraries } from "../scripts/stage-libraries.mjs";
import { REPO } from "./helpers/browser.js";

const site = fs.mkdtempSync(path.join(os.tmpdir(), "glace-site-"));
after(() => fs.rmSync(site, { recursive: true, force: true }));
stageLibraries(site);
const staged = (ref) => path.join(site, ref);

test("the staged libraries hold every module the import map reaches", async () => {
  await init;
  const imports = importMap();
  const queue = Object.values(imports).map(staged);
  const seen = new Set();
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const from = path.relative(site, file);
    assert.ok(fs.existsSync(file), `${from} is imported but not staged`);
    // es-module-lexer 3 names the import "specifier"; import.meta and computed import() have none.
    for (const { specifier } of parse(fs.readFileSync(file, "utf8"))[0]) {
      if (typeof specifier !== "string") continue;
      if (/^\.{1,2}\//.test(specifier)) queue.push(path.resolve(path.dirname(file), specifier));
      else assert.ok(specifier in imports, `${from} imports ${specifier}, which the import map lacks`);
    }
  }
  assert.ok(seen.size > Object.keys(imports).length, "the walk followed relative imports");
});

/* MapLibre builds its worker URL from its own module's URL. */
test("MapLibre's worker is staged beside its module", () => {
  const dir = path.dirname(staged(importMap()["maplibre-gl"]));
  assert.ok(fs.existsSync(path.join(dir, "maplibre-gl-worker.mjs")));
});

test("the page's stylesheet and preloads from node_modules are staged", () => {
  const html = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
  const refs = [...html.matchAll(/href="(node_modules\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 2, "MapLibre's stylesheet and fflate's preload");
  for (const ref of refs) assert.ok(fs.existsSync(staged(ref)), `${ref} is not staged`);
});

test("source maps, development builds and type declarations stay out", () => {
  const files = fs.readdirSync(site, { recursive: true });
  assert.deepEqual(files.filter((file) => /\.map$|-dev\.mjs$|\.d\.m?ts$/.test(file)), []);
});
