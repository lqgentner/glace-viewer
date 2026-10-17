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
import { pathToFileURL } from "node:url";
import vm from "node:vm";

import { JSDOM } from "jsdom";

import { REPO } from "./helpers/browser.js";

const page = () =>
  new JSDOM(fs.readFileSync(path.join(REPO, "index.html"), "utf8")).window.document;

const importMap = (document) =>
  JSON.parse(document.querySelector('script[type="importmap"]').textContent);

/* Every local src/href and import-map target, without a leading "./". Absolute
 * ones are other origins' to keep alive, such as the catalog. */
function localReferences() {
  const document = page();
  const values = [
    ...Object.values(importMap(document).imports),
    ...[...document.querySelectorAll("[src], [href]")].map(
      (el) => el.getAttribute("src") ?? el.getAttribute("href"),
    ),
  ];
  const local = values.filter((value) => value && !/^[a-z]+:|^\/\//i.test(value));
  return [...new Set(local.map((value) => value.replace(/^\.\//, "")))];
}

const libraries = () => localReferences().filter((ref) => ref.startsWith("node_modules/"));
const packageName = (ref) => /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(ref)[1];

test("every file the page references is in the repository", () => {
  const refs = localReferences();
  // A guard on the guard: a selector that matched nothing would pass silently.
  assert.ok(refs.includes("assets/glace-wordmark.svg"), "the wordmark is one of them");

  for (const ref of refs) {
    assert.ok(
      fs.existsSync(path.join(REPO, ref)),
      `index.html asks for ${ref}, which is missing; run pixi run --locked install`,
    );
  }
});

/* A browser ignores an address that is neither a URL nor starts with "/", "./"
 * or "../", and the bare name then fails to resolve. */
test("every import-map address is a relative URL", () => {
  for (const [name, address] of Object.entries(importMap(page()).imports)) {
    assert.match(address, /^\.\/node_modules\//, `${name} maps to ${address}`);
  }
});

/* Direct runtime dependencies, so Dependabot moves them and npm installs each
 * at the top of node_modules/, where the import map looks. */
test("every library the page loads is a runtime dependency in package.json", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  const names = [...new Set(libraries().map(packageName))].sort();
  assert.deepEqual(names, ["@protomaps/basemaps", "fflate", "maplibre-gl", "pmtiles"]);
  for (const name of names) {
    assert.ok(manifest.dependencies?.[name], `package.json does not depend on ${name}`);
  }
});

/* The jsdom suites use fakes, so a release that renames an export would pass
 * them and fail only in the browser. */
test("the libraries export what the viewer calls", async () => {
  const imports = importMap(page()).imports;
  const load = (name) => import(pathToFileURL(path.join(REPO, imports[name])).href);
  const source = fs
    .readdirSync(path.join(REPO, "js"))
    .map((name) => fs.readFileSync(path.join(REPO, "js", name), "utf8"))
    .join("\n");
  const used = (global) => [
    ...new Set([...source.matchAll(new RegExp(`\\b${global}\\.(\\w+)`, "g"))].map((m) => m[1])),
  ];

  const expected = {
    "maplibre-gl": used("maplibregl"),
    pmtiles: used("pmtiles"),
    "@protomaps/basemaps": used("basemaps"),
  };
  assert.ok(expected.pmtiles.includes("Protocol"), "the scan found the viewer's calls");
  for (const [name, members] of Object.entries(expected)) {
    const module = await load(name);
    for (const member of members) assert.ok(member in module, `${name} has no export ${member}`);
  }
});

/* BSD and MIT require the notice wherever the code is redistributed. */
test("every library the page loads has its license notice", () => {
  const notices = fs.readFileSync(path.join(REPO, "assets", "third-party-licenses.txt"), "utf8");
  for (const name of new Set(libraries().map(packageName))) {
    assert.ok(notices.includes(`==== ${name} ====`), `third-party-licenses.txt lacks ${name}`);
  }
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
    // stage-libraries.test.js checks what the script copies.
    if (root === "node_modules") continue;
    assert.match(stage, new RegExp(`\\b${root}\\b`), `deploy.yml never copies ${root}`);
  }
  assert.match(stage, /node scripts\/stage-libraries\.mjs _site/, "deploy.yml stages the libraries");
});

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

/* Same-origin code needs no integrity hash, and a CDN host in the policy would
 * let any package on that host run. */
test("the page loads its code and styles from its own origin", () => {
  const document = page();
  const code = [
    ...Object.values(importMap(document).imports),
    ...[...document.querySelectorAll('script[src], link[rel="modulepreload"], link[rel="stylesheet"]')].map(
      (el) => el.getAttribute("src") ?? el.getAttribute("href"),
    ),
  ];
  for (const url of code) assert.doesNotMatch(url, /^[a-z]+:|^\/\//i, `${url} is on another origin`);
  assert.equal(importMap(document).integrity, undefined, "same-origin modules need no integrity");

  const policy = document
    .querySelector('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute("content");
  for (const directive of ["script-src", "style-src", "worker-src"]) {
    const sources = policy.split(";").find((part) => part.trim().startsWith(directive));
    assert.doesNotMatch(sources, /https?:/, `${directive} still allows a remote host`);
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

/* Following a link out of the About dialog would replace the map. */
test("every link in the About dialog opens in a new tab", () => {
  const links = [...page().querySelectorAll("#about a[href]")];
  assert.ok(links.length > 0);
  for (const link of links) {
    assert.equal(link.getAttribute("target"), "_blank", link.getAttribute("href"));
    assert.match(link.getAttribute("rel") ?? "", /\bnoopener\b/, link.getAttribute("href"));
  }
});

test("the wordmark heads the panel's band, above the legend", () => {
  const doc = page();
  const title = doc.getElementById("title");
  assert.equal(title.parentElement, doc.getElementById("panel-nav"));
  assert.equal(title.nextElementSibling, doc.getElementById("legend"));
  assert.equal(doc.getElementById("subtitle"), null);
});

test("the scale editor scrolls below its header, on the sheet's one tint", () => {
  const doc = page();
  const body = doc.querySelector("#scale-editor .body");
  assert.ok(body.contains(doc.getElementById("bands")));
  assert.equal(body.previousElementSibling.tagName, "HEADER");
  const css = fs.readFileSync(path.join(REPO, "style.css"), "utf8");
  assert.match(css, /#scale-editor \.body \{[^}]*overflow: hidden auto/);
  assert.doesNotMatch(css, /#scale-editor header \{[^}]*background/);
});

test("the panel's band and body tint one glass pane separately", () => {
  const css = fs.readFileSync(path.join(REPO, "style.css"), "utf8");
  const start = css.indexOf("@supports (backdrop-filter");
  const block = css.slice(start, css.indexOf("\n}\n", start));
  assert.match(
    block,
    /#panel-nav \{[^}]*background: hsl\(var\(--glass-tint\) \/ var\(--glass-alpha-nav\)\)/,
  );
  assert.match(
    block,
    /#panel-body \{[^}]*background: hsl\(var\(--glass-tint\) \/ var\(--glass-alpha-body\)\)/,
  );
  assert.doesNotMatch(block, /#panel,[^{]*\{[^}]*--glass-alpha\b/);
  assert.doesNotMatch(block, /#panel \{[^}]*background: hsl/);
});

test("the stylesheet's phone blocks use js/ui.js's query, not the width alone", () => {
  const ui = fs.readFileSync(path.join(REPO, "js/ui.js"), "utf8");
  const [, query] = ui.match(/PHONE = window\.matchMedia\("([^"]+)"\)/);
  assert.match(query, /pointer: coarse/);
  const css = fs.readFileSync(path.join(REPO, "style.css"), "utf8");
  assert.ok(css.includes(`@media ${query} {`));
  assert.doesNotMatch(css, /@media \(max-width: 640px\)/);
});
