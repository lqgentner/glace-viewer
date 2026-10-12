# Serve Browser Libraries from npm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load MapLibre, PMTiles, fflate, Protomaps basemaps and hyparquet from the page's own origin, installed from the npm lockfile, so Dependabot's monthly npm PR moves them and needs no hand edits.

**Architecture:** The libraries become npm `dependencies`. The import map points at `./node_modules/...`, which the development server already serves from the repository root. A small Node script copies each import-map target's directory into `_site/` for Pages, and its test walks the staged import graph the way a browser resolves it. No bundler or build step: the page still loads the files npm installed, unchanged. Same-origin code needs no Subresource Integrity, and the CSP loses its CDN hosts.

**Tech Stack:** Plain ES modules with an import map, npm lockfile (v3), pixi tasks, Python `http.server` dev server, GitHub Actions Pages deploy, `node --test` with jsdom, es-module-lexer 3 (tests only).

**Spec:** Option 3 ("Vendor from npm") from the 2026-10-12 discussion, revised after Codex's review (option a); the design is restated below so this plan stands alone.

### Design

- **Versions:** this change keeps today's versions, so it is behavior-neutral: maplibre-gl 6.12.0, pmtiles 4.5.0, fflate 0.8.3, @protomaps/basemaps 5.7.2, hyparquet 1.30.1. `package.json` takes caret ranges; the lockfile pins exact versions; Dependabot bumps them afterward.
- **fflate is a direct dependency.** pmtiles imports it by bare name, which the import map resolves to `./node_modules/fflate/...`. Declaring it keeps that path at the top level instead of relying on npm hoisting a transitive package.
- **hyparquet:** its default `hyparquetUrl` becomes the bare specifier `hyparquet`, resolved by the import map. A relative path would resolve against `js/tile-grid.js`, not the page. Tests keep injecting fakes through `hyparquetUrl`.
- **Paths carry no version,** so a Dependabot PR changes only `package.json` and `package-lock.json`, and CI tests the new version as is.
- **Staging:** `scripts/stage-libraries.mjs` reads the import map from `index.html` and copies each target's whole directory, without source maps, `-dev` builds or type declarations. MapLibre's worker and chunks sit beside its module, so they come along. Adding a library means an import-map entry and `npm install`; the script needs no edit.
- **Licenses:** `assets/third-party-licenses.txt`, committed and linked from the About dialog, carries the five licenses. pmtiles and basemaps ship none in their npm packages.
- **Accepted risk:** version skew after a deploy. Library paths are unversioned, and Pages sends `max-age=600`. A browser that keeps one MapLibre file from the old release and fetches its sibling from the new one can fail until reload. A page load fetches siblings together, so they normally expire together; versioned paths would need a deploy-time rewrite of `index.html`, which this project avoids.
- **Not affected:** the service worker (`sw.js`), which caches only `.json`.

## Global Constraints

- US English in docs, comments and interface text; keep comments concise, and delete a stale comment rather than rewrite it at length.
- No compilation, bundling or minification step. The browser loads the files npm installed, unchanged.
- Asset URLs stay relative, so the site works under a Pages project subpath.
- Import-map addresses must start with `./`; a browser ignores an address such as `node_modules/x.js`.
- Any edit to an inline `<script>` in `index.html` requires replacing its `sha256-` hash in the CSP.
- Run everything through pixi: `pixi run --locked test`, `pixi run --locked test-js`, `pixi run --locked test-py`. pixi supports Linux and macOS, so local commands avoid GNU-only tools.
- Commit on the current branch (`glace-alps`); no feature branch. Commit messages are one imperative sentence, as in `git log`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A bare import-map address.** `"pmtiles": "node_modules/..."` without `./` is silently dropped by browsers, and the map then fails to start. Pinned by "every import-map address is a relative URL" (Task 1).
2. **A Dependabot bump that renames or drops an export the viewer calls** (`pmtiles.Protocol`, `basemaps.namedFlavor`, hyparquet's `parquetReadObjects`, `maplibregl.addProtocol`). The jsdom tests use fakes and would stay green. Pinned by "the libraries export what the viewer calls" (Task 1).
3. **A bump that moves a file or adds an import the browser cannot resolve:** MapLibre dropping a chunk, or a library importing a new bare name that Node finds in `node_modules` but the import map lacks. Pinned by the staged import-graph walk in `tests/stage-libraries.test.js` (Task 1).
4. **A new library without a license notice.** Pinned by "every library the page loads has its license notice" (Task 1).
5. **What only a browser shows:** MapLibre's worker under the tightened CSP, the tile grid loading hyparquet's 27 modules, and GitHub Pages serving a directory named `node_modules`. Task 1 Step 12 and Task 4 check them in a real browser and on the deployed site.

---

### Task 1: Serve the libraries from `node_modules/`, locally and on Pages

**Files:**
- Modify: `package.json`, `package-lock.json` (via npm)
- Modify: `index.html:6-10` (CSP and its comment), `index.html:28-30` (stylesheet), `index.html:32-51` (import map), `index.html:53-57` (preloads), `index.html:334-346` (About's "Built with" list)
- Create: `assets/third-party-licenses.txt`
- Modify: `js/config.js:18-19`
- Modify: `pixi.toml` (header comment, `install` comment, `serve` task)
- Create: `scripts/stage-libraries.mjs`
- Modify: `.github/workflows/deploy.yml` (build job)
- Test: `tests/page-assets.test.js`, `tests/config.test.js:90`
- Create: `tests/stage-libraries.test.js`

**Interfaces:**
- Produces: import-map names `maplibre-gl`, `pmtiles`, `fflate`, `@protomaps/basemaps`, `hyparquet`, each mapped to `./node_modules/<package>/<file>`.
- Produces: `HYPARQUET_URL` defaults to `"hyparquet"`.
- Produces: `scripts/stage-libraries.mjs` exports `importMap()` → `Record<string, string>` (the import map's `imports`, read from `index.html`) and `stageLibraries(siteDir: string)` → `void`, which throws if a source is missing. CLI: `node scripts/stage-libraries.mjs <site-dir>`.
- Produces: in `tests/page-assets.test.js`, the helpers `page()`, `importMap(document)`, `localReferences()` (paths without a leading `./`), and `libraries()` (the `node_modules/` subset).

- [ ] **Step 1: Write the failing tests in `tests/page-assets.test.js`**

Add `import { pathToFileURL } from "node:url";` to the imports.

Replace the current `localReferences()` function (lines 17-28) with the block below, and delete the later definition of `page` (the `const page = () => ...` above the CSP test), since it moves up here:

```js
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
```

In "every file the page references is in the repository", change the failure message to:

```js
    assert.ok(
      fs.existsSync(path.join(REPO, ref)),
      `index.html asks for ${ref}, which is missing; run pixi run --locked install`,
    );
```

Replace the test "every pin of maplibre-gl on the page names one version" with:

```js
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
  assert.deepEqual(names, ["@protomaps/basemaps", "fflate", "hyparquet", "maplibre-gl", "pmtiles"]);
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
    hyparquet: ["asyncBufferFromUrl", "parquetReadObjects"],
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
```

Replace the test "every CDN file the page loads carries an integrity hash" with:

```js
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
```

In "the deploy stages every directory the page reads from", skip the libraries inside the loop and require the staging script after it:

```js
  for (const ref of localReferences()) {
    const root = ref.split("/")[0];
    // stage-libraries.test.js checks what the script copies.
    if (root === "node_modules") continue;
    assert.match(stage, new RegExp(`\\b${root}\\b`), `deploy.yml never copies ${root}`);
  }
  assert.match(stage, /node scripts\/stage-libraries\.mjs _site/, "deploy.yml stages the libraries");
```

- [ ] **Step 2: Write the failing config test and the staging test**

In `tests/config.test.js:90`, replace

```js
  assert.match(config.HYPARQUET_URL, /^https:\/\/esm\.sh\//);
```

with

```js
  assert.equal(config.HYPARQUET_URL, "hyparquet", "the import map resolves the reader");
```

Create `tests/stage-libraries.test.js`:

```js
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pixi run --locked test-js 2>&1 | grep -E '^✖|^ℹ (pass|fail)|ERR_MODULE_NOT_FOUND'`
Expected:
- `stage-libraries.test.js` fails to load, because the script and es-module-lexer don't exist yet.
- page-assets failures: "every import-map address is a relative URL", "every library the page loads is a runtime dependency", "the libraries export what the viewer calls", "every library the page loads has its license notice", "the page loads its code and styles from its own origin", "the deploy stages every directory the page reads from".
- config's "deployment-only settings…" fails.
- Nothing else fails.

- [ ] **Step 4: Install the libraries at today's versions**

```sh
pixi run --locked npm install maplibre-gl@6.12.0 pmtiles@4.5.0 fflate@0.8.3 @protomaps/basemaps@5.7.2 hyparquet@1.30.1
pixi run --locked npm install --save-dev es-module-lexer@^3.0.3
pixi run --locked npm ls fflate
```

Expected:
- `package.json` gains a `dependencies` block with the five libraries in `^` ranges.
- `devDependencies` holds `jsdom` and `es-module-lexer`.
- `npm ls` shows a single `fflate@0.8.3`, the top-level one, with pmtiles' entry marked `deduped`.

- [ ] **Step 5: Point the page at `node_modules/`**

In `index.html`, replace the stylesheet link (lines 28-30) with:

```html
    <link rel="stylesheet" href="node_modules/maplibre-gl/dist/maplibre-gl.css" />
```

Replace the comment and import map (lines 32-51) with:

```html
    <!-- Parse the import map before any module fetch. npm installs the libraries,
         and scripts/stage-libraries.mjs copies each target's directory for Pages.
         PMTiles needs the bare fflate mapping; tile-grid.js imports hyparquet on
         demand. -->
    <script type="importmap">
      {
        "imports": {
          "maplibre-gl": "./node_modules/maplibre-gl/dist/maplibre-gl.mjs",
          "pmtiles": "./node_modules/pmtiles/dist/esm/index.js",
          "fflate": "./node_modules/fflate/esm/browser.js",
          "@protomaps/basemaps": "./node_modules/@protomaps/basemaps/dist/esm/index.js",
          "hyparquet": "./node_modules/hyparquet/src/index.js"
        }
      }
    </script>
```

Replace the two CDN preloads (lines 56-57) with the one below. Drop MapLibre's shared chunk: 6.14 empties it, and its path would only drift.

```html
    <link rel="modulepreload" href="node_modules/fflate/esm/browser.js" />
```

In the About dialog, after the closing `</ul>` of the "Built with" list, add:

```html
          <p>Their licenses are in
            <a href="assets/third-party-licenses.txt">third-party-licenses.txt</a>.</p>
```

- [ ] **Step 6: Tighten the CSP and rehash the import map**

Print the inline scripts' hashes:

```sh
pixi run --locked node --input-type=module -e "
import { JSDOM } from 'jsdom'; import fs from 'node:fs'; import crypto from 'node:crypto';
const doc = new JSDOM(fs.readFileSync('index.html', 'utf8')).window.document;
for (const s of doc.querySelectorAll('script:not([src])'))
  console.log(s.type, crypto.createHash('sha256').update(s.textContent).digest('base64'));"
```

Expected: two lines, `importmap <hash>` and `module <hash>`. The globals module is unchanged, so its hash is one of the two already in the policy.

Replace the CSP comment and meta (lines 6-10) with the following, substituting the printed hashes for `IMPORTMAP_HASH` and `GLOBALS_HASH`:

```html
    <!-- Hashes allow the two inline scripts below; page-assets.test.js checks them.
         MapLibre may run its worker from a blob, and stores may live on any HTTPS host. -->
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'self'; script-src 'self' 'sha256-IMPORTMAP_HASH' 'sha256-GLOBALS_HASH'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' https: data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'" />
```

- [ ] **Step 7: Default hyparquet to the import map**

In `js/config.js`, replace lines 18-19 with:

```js
  /* Loaded on demand for the tile grid, through the import map. Keep executable library URLs out of query parameters. */
  hyparquetUrl: "hyparquet",
```

- [ ] **Step 8: Write the license notices**

`node_modules` holds three of the five license texts; pmtiles and basemaps keep theirs only in their repositories.

```sh
section() { printf '\n==== %s ====\n\n' "$1"; cat; }
{
  echo "Licenses of the libraries this site serves from node_modules/."
  section maplibre-gl < node_modules/maplibre-gl/LICENSE.txt
  curl -fsS https://raw.githubusercontent.com/protomaps/PMTiles/main/LICENSE | section pmtiles
  section fflate < node_modules/fflate/LICENSE
  curl -fsS https://raw.githubusercontent.com/protomaps/basemaps/main/LICENSE.md | section @protomaps/basemaps
  section hyparquet < node_modules/hyparquet/LICENSE
} > assets/third-party-licenses.txt
grep -c '^==== ' assets/third-party-licenses.txt
```

Expected: `5`. Skim the file: each section opens with its copyright line.

- [ ] **Step 9: Write the staging script**

Create `scripts/stage-libraries.mjs`:

```js
/*
 * Copy what the import map in index.html loads from node_modules/ into a site
 * directory. Each target's whole directory goes, so files a library fetches
 * beside its module come along; source maps, development builds and type
 * declarations stay behind.
 *
 * Usage: node scripts/stage-libraries.mjs <site-dir>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = /\.map$|-dev\.mjs$|\.d\.m?ts$/;

/** The import map's imports, read from index.html. */
export function importMap() {
  const html = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
  return JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]).imports;
}

/** Copy every import-map target's directory under siteDir, keeping its path. */
export function stageLibraries(siteDir) {
  const dirs = new Set();
  for (const [name, target] of Object.entries(importMap())) {
    if (!target.startsWith("./node_modules/")) throw new Error(`${name} maps outside node_modules: ${target}`);
    dirs.add(path.dirname(target));
  }
  for (const dir of dirs) {
    fs.cpSync(path.join(REPO, dir), path.join(siteDir, dir), {
      recursive: true,
      filter: (source) => !SKIP.test(source),
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error("Usage: node scripts/stage-libraries.mjs <site-dir>");
    process.exit(2);
  }
  stageLibraries(path.resolve(process.argv[2]));
}
```

`fs.cpSync` throws when a source directory is missing, so a deploy without `npm ci` fails instead of publishing a page without its libraries.

- [ ] **Step 10: Install and stage in the deploy, and serve after installing**

In `.github/workflows/deploy.yml`, after the "Build vector tiles" step, add:

```yaml
      - name: Install the page's libraries
        run: pixi run --locked install
```

In the "Stage the site" step, change the comment above it to

```yaml
      # Publish the runtime files, generated archives and the page's libraries,
      # excluding source GeoJSON.
```

and add this line after `cp data/*.pmtiles data/inventories.json _site/data/`:

```yaml
          pixi run --locked node scripts/stage-libraries.mjs _site
```

In `pixi.toml`:
- Change the header comment's first line to `# Python, Node, and tippecanoe are locked by pixi; the page's libraries and jsdom by npm.`
- Change the comment above `install` to `# The page's libraries and the test dependencies, from package-lock.json.`
- Replace `serve = "python scripts/serve.py"` with:

```toml
serve = { cmd = "python scripts/serve.py", depends-on = ["install"] }
```

`npm ci` runs on every `serve`; it takes a few seconds and always repairs a damaged `node_modules/`. Extra arguments such as `--tiles-dir` still reach `serve.py`.

- [ ] **Step 11: Run the tests to verify they pass, then rehearse the staging**

Run: `pixi run --locked test`
Expected: all Python and JavaScript tests pass.

Rehearse the deploy's library staging. `_site/` is gitignored; remove it afterward:

```sh
pixi run --locked node scripts/stage-libraries.mjs _site && find _site -type f | sort && du -sh _site
rm -rf _site
```

Expected: the files under `_site/node_modules/` total about 1.7 MB of `.mjs`, `.js` and `.css`, with no `.map`, `-dev.mjs` or `.d.ts`.

- [ ] **Step 12: Check the page in a browser**

Run `pixi run --locked serve` and open `http://localhost:8000/` with the developer tools open. Expected:
- The map, basemap and default raster draw, and the console shows no CSP violation.
- The Network tab shows MapLibre's module and worker, pmtiles, fflate and basemaps from `localhost:8000/node_modules/…`, and nothing from unpkg.com or esm.sh.
- Ticking the tile-grid overlay loads `node_modules/hyparquet/src/*.js` and draws the footprints.
- Toggling 3D and hillshade works.
- The About dialog's license link opens the notices.

- [ ] **Step 13: Commit**

```sh
git add package.json package-lock.json index.html assets/third-party-licenses.txt js/config.js pixi.toml \
  scripts/stage-libraries.mjs .github/workflows/deploy.yml \
  tests/page-assets.test.js tests/config.test.js tests/stage-libraries.test.js
git commit -m "Serve MapLibre, PMTiles, basemaps and hyparquet from npm on the page's own origin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Reload library modules in development

`scripts/serve.py` sends `no-store` for `.js` and `.css` but not `.mjs`, so after a Dependabot bump the browser can keep running the old MapLibre.

**Files:**
- Modify: `scripts/serve.py:25-26`
- Test: `tests/test_serve.py` (`setUpClass` and the cache tests)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `NO_STORE_SUFFIXES` includes `".mjs"`.

- [ ] **Step 1: Write the failing test**

In `tests/test_serve.py` `setUpClass`, after the `app.js` line, add:

```python
        (cls.web_dir / "js" / "lib.mjs").write_bytes(b"export {};")
```

After `test_the_page_shell_is_never_stored`, add:

```python
    def test_library_modules_are_never_stored(self) -> None:
        # MapLibre ships .mjs; a stale copy keeps running after npm moves it.
        response = self.get("/js/lib.mjs")
        self.assertIn("no-store", response.headers["cache-control"])
        self.assertEqual(response.headers["content-type"], "text/javascript")
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pixi run --locked python -m unittest tests.test_serve -v 2>&1 | tail -8`
Expected: `test_library_modules_are_never_stored ... ERROR` with `KeyError: 'cache-control'` (a missing header raises, so unittest reports an error, not a failure).

- [ ] **Step 3: Implement**

In `scripts/serve.py`, replace

```python
NO_STORE_SUFFIXES = frozenset({"", ".html", ".js", ".css", ".json"})
```

with

```python
NO_STORE_SUFFIXES = frozenset({"", ".html", ".js", ".mjs", ".css", ".json"})
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pixi run --locked test-py`
Expected: all Python tests pass.

- [ ] **Step 5: Commit**

```sh
git add scripts/serve.py tests/test_serve.py
git commit -m "Reload .mjs library modules on every development page load

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Update the contributor notes and config comments

**Files:**
- Modify: `AGENTS.md` (the development section, code map, test table, deployment paragraph, test note)
- Modify: `.gitignore` (the `node_modules/` comment)
- Modify: `.github/dependabot.yml:1-4`

**Interfaces:** none.

- [ ] **Step 1: Edit `AGENTS.md`**

Replace `jsdom is a development dependency locked separately by npm.` (line 15) with
`npm locks the page's libraries and the test dependencies.`

Replace the two paragraphs from `For focused checks` through `fall under \`worker-src\`, not \`script-src\`.` (lines 23-35) with:

```markdown
For focused checks, use `pixi run --locked test-py` or
`pixi run --locked test-js`. There is no compilation or bundling. The page's
libraries are npm `dependencies`, loaded unchanged from `./node_modules/`
through the import map in `index.html`; `pixi run --locked install`, which
`serve` and `test-js` run first, puts them there. Dependabot moves them with
the test dependencies in one monthly PR. A library the page loads must be a
direct dependency, so npm installs it where the import map looks, and needs
its license in `assets/third-party-licenses.txt`. Import-map addresses must
start with `./`, or browsers ignore them.

`index.html` carries a Content-Security-Policy that allows only same-origin
scripts and styles, and `page-assets.test.js` checks it offline. When editing
either inline script, replace its `sha256-` hash in the policy; the test prints
the failing script. A new data host needs a CSP entry. Module workers' imports
fall under `worker-src`, not `script-src`.
```

In the code map, after the `scripts/serve.py` row, add:

```markdown
| `scripts/stage-libraries.mjs` | Copies the import map's library directories into the Pages site |
```

In the test table, replace the row `| Static assets, dependency pins, CSP, integrity, preloads | \`page-assets\` |` with

```markdown
| Static assets, libraries, CSP, preloads, staging | `page-assets`, `stage-libraries` |
```

Replace `application behavior, not actual WebGL rendering or CDN availability; inspect` with
`application behavior, not actual WebGL rendering; inspect`.

In the deployment paragraph, replace `page, settings, \`js/\`, \`assets/\`, archives, and inventory index. It excludes
GeoJSON.` with `page, settings, \`js/\`, \`assets/\`, archives, inventory index, and, through \`scripts/stage-libraries.mjs\`, each import-map target's directory without source maps or development builds. It excludes GeoJSON.` Re-wrap the paragraph to the file's line width.

- [ ] **Step 2: Edit `.gitignore`**

Replace

```
# Dev-only: the page loads js/ directly and has no runtime dependencies.
# `.pixi/` is the environment pixi.lock describes; `node_modules/` is jsdom for
# `npm test` and nothing else.
```

with

```
# `.pixi/` is the environment pixi.lock describes; `node_modules/` holds the
# page's libraries, which the deploy copies, and the test dependencies.
```

- [ ] **Step 3: Edit `.github/dependabot.yml`**

Replace the first line `# Moves the action versions in the workflows, and jsdom in package-lock.json,` with
`# Moves the action versions in the workflows, and the npm packages (the page's libraries and test tools),`. Keep the rest of the comment.

- [ ] **Step 4: Check that no stale reference remains**

Run: `grep -rn -i -E 'unpkg|esm\.sh|integrity|cdn' AGENTS.md README.md index.html js .github .gitignore pixi.toml`
Expected: no matches, apart from URLs that are data (catalog, basemap, terrain) or the About dialog's project links. Fix any leftover.

Run: `pixi run --locked test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```sh
git add AGENTS.md .gitignore .github/dependabot.yml
git commit -m "Describe the npm-installed libraries in the contributor notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Verify the deployed site and Dependabot

This happens after the branch reaches `main`, which deploys Pages.

- [ ] **Step 1: Watch the deploy**

Run: `gh run watch $(gh run list --workflow deploy.yml --limit 1 --json databaseId -q '.[0].databaseId')`
Expected: success; the "Stage the site" log ends with the `du -sh _site` size.

- [ ] **Step 2: Check the live page**

Open the Pages URL with the developer tools open. Expected: the same checks as Task 1 Step 12, with `node_modules/…` served from the Pages origin (status 200, `text/javascript`), no CSP violation, and the worker running.

- [ ] **Step 3: Confirm Dependabot sees the libraries**

On GitHub, open Insights → Dependency graph → Dependabot, choose the npm `package.json` entry, and select "Check for updates". Expected: the check lists the five libraries. Once releases clear the 7-day cooldown (maplibre-gl 6.14.0 from 2026-10-11 qualifies on 2026-10-18), a grouped PR bumps them and CI tests the new versions without hand edits.
