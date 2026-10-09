/*
 * Check that page assets exist, dependency pins agree, the CSP and integrity
 * hashes cover the page, preloads stay complete, and deployment stages the
 * runtime files.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import { JSDOM } from "jsdom";

import { REPO } from "./helpers/browser.js";

/* Every local src/href on the page. The absolute ones are the CDN libraries,
 * which are somebody else's to keep alive. */
function localReferences() {
  const dom = new JSDOM(fs.readFileSync(path.join(REPO, "index.html"), "utf8"));
  const refs = new Set();
  for (const el of dom.window.document.querySelectorAll("[src], [href]")) {
    const value = el.getAttribute("src") ?? el.getAttribute("href");
    if (value && !/^[a-z]+:|^\/\//i.test(value)) refs.add(value);
  }
  return [...refs];
}

test("every file the page references is in the repository", () => {
  const refs = localReferences();
  // A guard on the guard: a selector that matched nothing would pass silently.
  assert.ok(refs.includes("assets/glace-wordmark.svg"), "the wordmark is one of them");

  for (const ref of refs) {
    assert.ok(fs.existsSync(path.join(REPO, ref)), `index.html asks for ${ref}, which is missing`);
  }
});

/* The stylesheet is a <link> and the script an import-map entry, so the two
 * pins of one library are in different syntaxes and would drift silently. */
test("every pin of maplibre-gl on the page names one version", () => {
  const html = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
  const versions = new Set([...html.matchAll(/maplibre-gl@([^/]+)\//g)].map((m) => m[1]));
  assert.equal(versions.size, 1, `index.html pins maplibre-gl at ${[...versions].join(" and ")}`);
});

test("the manifest's icons resolve, relative to the manifest itself", () => {
  const rel = "assets/site.webmanifest";
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf8"));
  const dir = path.dirname(path.join(REPO, rel));

  assert.ok(manifest.icons.length > 0);
  for (const icon of manifest.icons) {
    assert.doesNotMatch(icon.src, /^\//, `${icon.src} is absolute, so it misses a project site`);
    assert.ok(fs.existsSync(path.join(dir, icon.src)), `the manifest names ${icon.src}`);
  }
});

test("the deploy stages every directory the page reads from", () => {
  const workflow = fs.readFileSync(path.join(REPO, ".github", "workflows", "deploy.yml"), "utf8");
  const stage = workflow.slice(workflow.indexOf("Stage the site"), workflow.indexOf("upload-pages"));

  for (const ref of localReferences()) {
    const root = ref.split("/")[0];
    assert.match(stage, new RegExp(`\\b${root}\\b`), `deploy.yml never copies ${root}`);
  }
});

const page = () =>
  new JSDOM(fs.readFileSync(path.join(REPO, "index.html"), "utf8")).window.document;

/* An edited inline script no longer matches its hash, and the browser skips it. */
test("the content security policy allows each inline script by hash", () => {
  const document = page();
  const policy = document
    .querySelector('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute("content");
  const scriptSrc = policy.split(";").find((part) => part.trim().startsWith("script-src"));
  const inline = [...document.querySelectorAll("script:not([src])")];
  assert.equal(inline.length, 2, "the import map and the globals module");
  for (const script of inline) {
    const hash = crypto.createHash("sha256").update(script.textContent).digest("base64");
    assert.ok(scriptSrc.includes(`'sha256-${hash}'`), `CSP lacks the hash of:\n${script.textContent}`);
  }
});

test("every CDN file the page loads carries an integrity hash", () => {
  const document = page();
  const map = JSON.parse(document.querySelector('script[type="importmap"]').textContent);
  const cdn = [
    ...Object.values(map.imports),
    ...[...document.querySelectorAll('link[rel="modulepreload"]')]
      .map((link) => link.getAttribute("href"))
      .filter((href) => /^https:/.test(href)),
  ];
  for (const url of cdn) {
    assert.match(map.integrity[url] ?? "", /^sha384-/, `the import map has no integrity for ${url}`);
  }
  for (const link of document.querySelectorAll('link[rel="stylesheet"][href^="https:"]')) {
    assert.match(link.getAttribute("integrity") ?? "", /^sha384-/, link.getAttribute("href"));
    assert.equal(link.getAttribute("crossorigin"), "anonymous");
  }
});

/* app.js is fetched as a script; the modules below it would otherwise wait for
 * their importers, one level at a time. */
test("every module app.js imports is preloaded", () => {
  const preloaded = new Set(
    [...page().querySelectorAll('link[rel="modulepreload"]')].map((link) => link.getAttribute("href")),
  );
  const modules = fs
    .readdirSync(path.join(REPO, "js"))
    .filter((name) => name.endsWith(".js") && name !== "app.js")
    .map((name) => `js/${name}`);
  for (const module of modules) assert.ok(preloaded.has(module), `index.html does not preload ${module}`);
});

test("the preloaded collection is the one config.js reads by default", () => {
  const site = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(REPO, "site-config.js"), "utf8"), site);
  const config = fs.readFileSync(path.join(REPO, "js", "config.js"), "utf8");
  const collection = /mosaicCollection: "([^"]+)"/.exec(config)[1];
  const preload = page().querySelector('link[rel="preload"][as="fetch"]');

  assert.equal(preload.getAttribute("href"), `${site.window.GLACE_CONFIG.tilesBase}/${collection}`);
  // fetch() reads without credentials across origins; a preload must match to be used.
  assert.equal(preload.getAttribute("crossorigin"), "");
});

test("the deploy stages the service worker app.js registers", () => {
  const app = fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8");
  assert.match(app, /register\("sw\.js"\)/);
  assert.ok(fs.existsSync(path.join(REPO, "sw.js")));
  const workflow = fs.readFileSync(path.join(REPO, ".github", "workflows", "deploy.yml"), "utf8");
  assert.match(workflow, /cp [^\n]*\bsw\.js\b[^\n]* _site\//);
});

test("the scale editor's fields are 16px on touch screens, so iOS does not zoom", () => {
  const css = fs.readFileSync(path.join(REPO, "style.css"), "utf8");
  const coarse = css.slice(css.lastIndexOf("@media (pointer: coarse)"));
  assert.match(coarse, /#scale-editor input \{ font-size: 16px; \}/);
  // Nothing after the touch block may shrink them again.
  assert.equal(coarse.match(/#scale-editor input/g).length, 1);
});
