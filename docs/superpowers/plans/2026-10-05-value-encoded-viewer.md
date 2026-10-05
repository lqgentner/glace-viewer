# Value-Encoded Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the viewer read the value-encoded glace-catalog, compose false color on demand, and give the legend and inventory colors one quiet inline-edit look, while dropping the pre-styled and COG code paths.

**Architecture:** The store reads only standard fields: STAC items (archives, dates, band units), the collection's STAC `renders` (default stretches), and the MapLibre style's `raster-dem` sources (decoding, zooms, credit). The viewer owns presentation: default color maps and the false-color blue range are constants. Single-band layers draw as `color-relief`; false color is a `raster` source fed by a `glace-rgb://` protocol that decodes the VV and VH PMTiles tiles and combines them.

**Tech Stack:** Plain ES modules, MapLibre GL 6 (`color-relief`, `raster-dem` custom encoding), pmtiles 4, jsdom + `node --test`, pixi.

**Spec:** The "Design" section below, agreed in conversation on 2026-10-05. There is no separate spec file.

## Design

### Catalog contract (replaces `metadata.portolan:legend`)

| Value | Source |
|---|---|
| Archives, layer ID, acquisition dates | Year items, `visual` PMTiles assets (unchanged) |
| Units | Item asset `bands[0].unit`, empty when absent |
| Decoding factors, zoom limits, credit | The style source of each `color-relief` layer: `raster-dem`, `encoding: "custom"`, `minzoom`, `maxzoom`, `attribution` |
| Default stretch | Collection `renders[<stem>].rescale[0]` |
| Default color map | Viewer constant: COH12 `cmc.lipari`, RTC `cmc.grayC`, any QA `cmc.glasgow`, unknown product `viridis` |

The style's own ramp (its `color-relief-color` stops) is ignored. A layer without encoding, zooms, or a valid `rescale` is skipped with a warning. Style lookup order (year ID, default ID, year stem, default stem) is unchanged.

### False color

For each product and year that has both a VV and a VH data layer, `js/composite.js` derives one record (`polarization: "RGB"`, ID `glace-{product}_rgb-{year}`). Red is VV over the VV layer's default stretch, green is VH over the VH layer's default stretch, and blue is VV − VH when the units are dB, otherwise VV / VH, over a viewer constant: COH12 `[0.8, 2.6]`, RTC `[3.5, 10.5]`. These are the ranges of the catalog's last RGB archives. A pixel is drawn only where both archives have data. The protocol returns an `ImageBitmap`, or an empty buffer (drawn transparent) where an archive has no tile; a failed read rejects. False color is not editable in the legend and has no cursor readout. The RGB × QA fallback (`GIVES_WAY`) stays, since there is no RGB QA layer.

### Legend

```
Scale  lipari                    ↺
[████████████████████████████████]
 0.10                         0.75
```

- `#cmap` is a button showing the short color-map name. It opens a popover (`attachPopover`, `hover: false`) listing the 11 maps with gradient previews, and the current one is pressed.
- `#vmin` and `#vmax` are `inputmode="decimal"` text inputs, followed by a `.unit` span. Enter or blur applies the value, Escape reverts it, and an empty, non-numeric, or inverted range reverts it, as does a minimum below the archive's code 1, where the ramp would fall into the nodata stop. A comma is accepted as the decimal separator. Render never overwrites an input that has focus.
- Hovering over `#legend`, or focus inside it, shows a `--border` box around every `.editable`. Hovering over one control, focusing it, or opening its popover makes its box `--accent`. On `@media (hover: none)` the `--border` box is always shown. Changed values use `--accent-ink`.
- Custom choices are stored per stem (`state.custom: Map<stem, {cmap?, vmin?, vmax?}>`), so they survive a year change and stay separate between products. `↺` is shown only when the selected stem has a custom entry, and clears it.
- The color-map credit button and `COLOUR_MAP_CREDIT` are removed. The Crameri MIT notice and citation go in `js/colormaps.js` and the README.
- Color maps, in panel order: `cmc.batlow`, `cmc.lipari`, `cmc.lajolla`, `cmc.imola`, `cmc.glasgow`, `cmc.devon`, `cmc.oslo`, `cmc.grayC`, `viridis`, `magma`, `cividis`. Each has 32 stops sampled at `i / 31`.

### Inventory swatch

The pencil pseudo-elements are removed. The swatch gets the same 1 px, 4 px-radius box: `--border` while the row is hovered, and `--accent` on swatch hover, keyboard focus, or with its popover open.

### Removals

`js/cog-rgb.js`, its test and fake reader, the `lerc` import-map entry, `cogReaderUrl`, the pre-styled `raster` path, `portolan:legend` parsing, published RGB channel validation (`validChannels`, `falseColourChannels`), and the `#recolor` row.

## Global Constraints

- US English in code, comments, and interface text. Preserve source URLs and verbatim citations.
- No build step, bundler, or runtime npm install. Browser dependencies stay pinned CDN imports.
- External text enters the DOM only through `h()`, DOM nodes, or `textContent`.
- Add map layers only through `addStacked()`. Retain sources and layers after first display and toggle visibility.
- Do not set `bounds` on `pmtiles://` sources. The composite `raster` source sets `attribution` from the style source because it has no TileJSON.
- Initial control values in `index.html` must agree with module defaults.
- Every commit leaves `pixi run --locked test` green.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work on branch `feature/encoded-pmtiles`. Do not merge to `main`.

## Review Focus

1. **Typing in a limit while something else re-renders** (opacity slider, map readout, year change): the text being typed must survive. Pinned in Task 4, step 1 ("render never overwrites a focused limit").
2. **A composite tile where only one polarization has data, or where one archive has no tile**: transparent pixels or a blank tile, never black. Pinned in Task 3, step 1.
3. **A transient tile fetch failure**: it must fail that tile, not cache a blank success, and be retried next time. Pinned in Task 3, step 1 ("a failed tile read fails the tile and is retried next time"). A slow read must not block an aborted tile either ("an aborted tile stops waiting…").
4. **A European decimal comma** (`0,2`): accepted as 0.2. Pinned in Task 4, step 1.
5. **False-color credit**: the composite source still credits the data. Pinned in Task 3, step 1, in `store-catalog.test.js`.

---

### Task 1: Remove the COG reader

**Files:**
- Delete: `js/cog-rgb.js`, `tests/cog-rgb.test.js`, `tests/fixtures/fake-geotiff.mjs`
- Modify: `js/map.js:14,21-22`, `js/config.js:18-23,87`, `index.html:157-169`, `tests/config.test.js:81-95`, `tests/helpers/browser.js:333-336` (comment only), `AGENTS.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `js/config.js` no longer exports `COG_READER_URL`. The canvas stubs in `tests/helpers/browser.js` stay, because Task 3 uses them.

- [ ] **Step 1: Update the config test first**

In `tests/config.test.js`, the test "deployment-only settings are not reachable from the address bar": remove `&cogReaderUrl=http://evil` from the query string, change the comment to `// The reader URL is imported and executed, so it matters most here.`, and delete the line `assert.match(config.COG_READER_URL, /^https:\/\/esm\.sh\//);`. Add:

```js
  assert.equal("COG_READER_URL" in config, false, "the COG reader is gone");
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pixi run --locked node --test tests/config.test.js`
Expected: FAIL on "the COG reader is gone".

- [ ] **Step 3: Remove the code**

```sh
git rm js/cog-rgb.js tests/cog-rgb.test.js tests/fixtures/fake-geotiff.mjs
```

- `js/map.js`: delete `import { cogRgbProtocol } from "./cog-rgb.js";`, plus the comment `/* Registered but unused; ... */` and `maplibregl.addProtocol("glace-rgb", cogRgbProtocol);`.
- `js/config.js`: delete the `cogReaderUrl` default and its comment block. Change the `hyparquetUrl` comment to `/* Loaded on demand for the tile grid. Keep executable library URLs out of query parameters. */`. Delete `export const COG_READER_URL = settings.cogReaderUrl;`.
- `index.html`: delete the `"lerc": ...` import-map line (and the trailing comma on the line before). Change the comment above the import map to:

```html
    <!-- Parse the import map before loading modules. MapLibre loads sibling chunks
         and a worker; PMTiles needs the bare fflate mapping. -->
```

- `tests/helpers/browser.js`: in the canvas stub comment, replace `js/cog-rgb.js` with `js/composite.js`.
- `AGENTS.md`: delete the sentence "The `lerc` import-map entry and `cogReaderUrl` must be changed together; the comment in `index.html` explains the loader constraint." Delete the `js/cog-rgb.js` code-map row, the `mosaics/{year}/*.tif` path line, and the whole "### The COG reader" subsection. In the tests table, change "Globe or COG calculations | `sky`, `cog-rgb`" to "Globe calculations | `sky`".

- [ ] **Step 4: Verify that nothing still references it**

Run: `grep -rn -i -E "cog|lerc|geotiff" js index.html AGENTS.md tests/*.js tests/helpers`
Expected: no output. (README line 36 points readers to the catalog's COG assets and stays.)

Run: `pixi run --locked test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A js index.html tests AGENTS.md
git commit -m "Remove the unused COG reader

The viewer settles on PMTiles; the glace-rgb protocol over COGs, its LERC
loader pin and its fake reader go.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Read the value-encoded catalog

**Files:**
- Modify: `js/store.js` (replace `legends()`, `drawable()`, `storeLayers()` signature, `archives()`, `readStore()`, remove `FALSE_COLOUR`)
- Modify: `js/rasters.js` (default color maps, drop the pre-styled branch in `ensureLayer`, local `FALSE_COLOUR`)
- Modify: `AGENTS.md` ("Reading the catalog")
- Rewrite fixtures: `tests/fixtures/store/*`, `tests/fixtures/two-years/*` (generated, see step 1)
- Test: `tests/store.test.js`, `tests/store-local.test.js`, `tests/store-catalog.test.js`, `tests/viewer.test.js`, `tests/encoded.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `storeLayers(items, style, collection) -> Layer[]`, where `Layer = { id, stem, product, polarization, year, url, units: string, minZoom, maxZoom, encoding, attribution?: string, vmin, vmax, startDate?, endDate? }`
  - `stretches(collection) -> Map<stem, {vmin, vmax}>` (exported from `js/store.js`)
  - `defaultCmap(layer) -> string` (exported from `js/rasters.js`)

- [ ] **Step 1: Convert the fixtures**

Save this as `$SCRATCH/convert-fixtures.py`, using the session scratchpad, so it is not committed. Run it from the repository root with `python3 $SCRATCH/convert-fixtures.py`. It keeps each fixture's layer IDs, source keys, URLs, and layout, swaps in the catalog's `raster-dem` source and `color-relief` paint for that stem, drops RGB, adds `renders` and band units, and sets the credit year to the layer's year.

```python
"""Convert the viewer fixtures to the value-encoded catalog format (one-off)."""
import json, pathlib, re

CAT = pathlib.Path("../glace-catalog/catalog/mosaics")
FIX = pathlib.Path("tests/fixtures")
LAYER = re.compile(r"^glace-(.+)-(\d{4})$")
YEAR = re.compile(r"\b(?:19|20)\d{2}\b")

catalog_style = json.loads((CAT / "styles/default.json").read_text())
catalog = json.loads((CAT / "collection.json").read_text())
by_stem = {LAYER.match(l["id"])[1]: l for l in catalog_style["layers"]}

def load(path): return json.loads(path.read_text())
def save(path, doc): path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")

def convert_style(path):
    doc = load(path)
    sources, layers = {}, []
    for layer in doc["layers"]:
        at = LAYER.match(layer["id"])
        if not at or at[1] not in by_stem:
            continue  # drops the RGB archives
        stem, year = at[1], at[2]
        ours = by_stem[stem]
        source = dict(catalog_style["sources"][ours["source"]])
        source["url"] = doc["sources"][layer["source"]]["url"]
        source["attribution"] = YEAR.sub(year, source["attribution"])
        sources[layer["source"]] = source
        new = {"id": layer["id"], "type": "color-relief", "source": layer["source"]}
        if "layout" in layer:
            new["layout"] = layer["layout"]
        # The viewer ignores the style's ramp; keep a two-stop stand-in so the
        # fixture stays a valid style without copying every color.
        new["paint"] = {"color-relief-color": ["interpolate", ["linear"], ["elevation"], 0, "#000000", 1, "#ffffff"]}
        layers.append(new)
    doc["metadata"] = catalog_style["metadata"]
    doc["sources"], doc["layers"] = sources, layers
    save(path, doc)
    return {LAYER.match(l["id"])[1] for l in layers}

def convert_item(path):
    doc = load(path)
    doc["assets"] = {k: v for k, v in doc["assets"].items() if "_rgb" not in k}
    for key, asset in doc["assets"].items():
        if key.endswith("_viz") and key in catalog["item_assets"]:
            asset["bands"] = catalog["item_assets"][key]["bands"]
    save(path, doc)

def convert_collection(path, stems):
    doc = load(path)
    doc["renders"] = {k: v for k, v in catalog["renders"].items() if k in stems}
    save(path, doc)

for name in ("store", "two-years"):
    folder = FIX / name
    stems = set()
    for style in sorted(folder.glob("style*.json")):
        stems |= convert_style(style)
    for item in sorted(folder.glob("item-*.json")):
        convert_item(item)
    convert_collection(folder / "collection.json", stems)
```

Then check the output: `git diff --stat tests/fixtures`. Every `style*.json` should now have only `color-relief` layers with `raster-dem` sources, and `grep -c '"_rgb' tests/fixtures/*/*.json` should print 0 for each file.

- [ ] **Step 2: Rewrite the store unit tests**

In `tests/store.test.js`:

- Change the `layers` helper to pass the collection:

```js
const layers = (over = {}) =>
  storeLayers(
    over.items ?? [{ item: over.item ?? item, url: ITEM_URL }],
    over.style ?? style,
    over.collection ?? collection,
  );
```

- "every archive the store publishes becomes a layer": expect `12` (two products × VV, VH × measurement, QA-NUM, QA-CQM) and update the comment.
- "a layer nothing describes is dropped with a warning" (line 122) and "an asset this page cannot name a layer from…" (line 137): `14` → `12`.
- Replace "the ramp, the stretch and the zooms come from the style" with:

```js
test("decoding and zooms come from the style, stretches from renders, units from the item", () => {
  const found = byId(layers());
  const vv = found.get("glace-coh12_vv-2024");
  assert.equal(vv.encoding.encoding, "custom");
  assert.deepEqual([vv.minZoom, vv.maxZoom], [5, 13]);
  assert.deepEqual([vv.vmin, vv.vmax], [0.1, 0.75]);
  assert.equal(vv.units, "", "coherence has no unit");
  assert.match(vv.attribution, /Copernicus Sentinel data 2024/);
  assert.equal("colors" in vv, false, "the style's ramp is not read");

  const rtc = found.get("glace-rtc_vv-2024");
  assert.deepEqual([rtc.vmin, rtc.vmax], [-14.5, -4.5]);
  assert.equal(rtc.units, "dB");

  const num = found.get("glace-rtc_vv_qa_num-2024");
  assert.deepEqual([num.vmin, num.vmax], [0, 80]);
});

test("a stretch is read only from a finite, increasing rescale", () => {
  const ranges = stretches({
    renders: {
      good: { rescale: [[0, 1]] },
      inverted: { rescale: [[1, 0]] },
      text: { rescale: [["0", "1"]] },
      missing: {},
    },
  });
  assert.deepEqual([...ranges.keys()], ["good"]);
  assert.deepEqual(ranges.get("good"), { vmin: 0, vmax: 1 });
});

test("a layer without a rescale is dropped with a warning", async () => {
  const { coh12_vv: _, ...renders } = collection.renders;
  const warnings = await captureWarnings(async () => {
    const found = byId(layers({ collection: { ...collection, renders } }));
    assert.equal(found.has("glace-coh12_vv-2024"), false);
    assert.ok(found.has("glace-coh12_vh-2024"));
  });
  assert.ok(warnings.some((line) => /glace-coh12_vv-2024/.test(line)));
});

test("a source without the custom encoding is dropped, not drawn as color", async () => {
  const broken = structuredClone(style);
  broken.sources["src-coh12_vv"].encoding = "terrarium";
  const warnings = await captureWarnings(async () => {
    assert.equal(byId(layers({ style: broken })).has("glace-coh12_vv-2024"), false);
  });
  assert.ok(warnings.some((line) => /glace-coh12_vv-2024/.test(line)));
});
```

- Add `stretches` to the destructured import from `js/store.js`.
- Delete "the false color carries three channels and no ramp" and "one colorless stop is passed over rather than costing the layer its ramp".
- In "a layer the style describes incompletely is dropped, not drawn", "a source with no zooms costs its layer…", "a year the style does not describe falls back…", and "a year with its own style is drawn from that style…": these build modified styles. Replace any edits to `metadata["portolan:legend"]` with edits to the source (for example, delete `minzoom`) or to `collection.renders`, keeping the behavior each test names. Where a test checked fallback through legend values (`cmap`, `colors`), check `minZoom`, `maxZoom`, and `attribution` instead.
- "the three documents are read end to end": `readStore()` now also reads `renders` from the collection it already fetches. Change `56, "four years of fourteen archives"` to `48, "four years of twelve archives"`. Replace `assert.equal(layer.cmap, "cmc.grayC");` with `assert.deepEqual([layer.units, layer.vmin, layer.vmax], ["dB", -14.5, -4.5]);`.

In `tests/encoded.test.js`, change the header comment to `/* Check the decoding of value-encoded archives. */`.

- [ ] **Step 3: Run the store tests and watch them fail**

Run: `pixi run --locked node --test tests/store.test.js`
Expected: FAIL (`stretches` is not exported, and layers are dropped for lacking `portolan:legend`).

- [ ] **Step 4: Rewrite the store**

In `js/store.js`, replace `legends()` with:

```js
/*
 * Index the style's color-relief layers by layer ID and stem. Each draws a
 * raster-dem source whose custom encoding decodes the archive; the source also
 * supplies zoom limits and the credit line. The style's ramp is not read: the
 * viewer chooses color maps, and stretches come from the collection's renders.
 */
function sources(style) {
  const declared = style?.sources ?? {};
  const byId = new Map();
  const byStem = new Map();
  for (const layer of Array.isArray(style?.layers) ? style.layers : []) {
    if (layer?.type !== "color-relief") continue;
    const parsed = parseLayerId(layer.id);
    if (parsed === null) continue;
    const source = declared[layer.source] ?? {};
    const entry = {
      minZoom: source.minzoom,
      maxZoom: source.maxzoom,
      encoding: valueEncoding(source),
      attribution: isNonEmptyString(source.attribution) ? source.attribution : undefined,
    };
    byId.set(layer.id, entry);
    if (!byStem.has(parsed.stem)) byStem.set(parsed.stem, entry);
  }
  return { byId, byStem };
}

/**
 * Default stretches by stem from the collection's STAC renders, whose keys are
 * the layer stems.
 *
 * @param {object} collection  the mosaics collection
 * @returns {Map<string, {vmin: number, vmax: number}>}
 */
export function stretches(collection) {
  const out = new Map();
  for (const [stem, render] of Object.entries(collection?.renders ?? {})) {
    const range = Array.isArray(render?.rescale) ? render.rescale[0] : null;
    if (!Array.isArray(range) || range.length !== 2) continue;
    const [vmin, vmax] = range;
    if (isFiniteNumber(vmin) && isFiniteNumber(vmax) && vmin < vmax) out.set(stem, { vmin, vmax });
  }
  return out;
}
```

In `archives()`, record the units:

```js
    const band = Array.isArray(asset.bands) ? asset.bands[0] : null;
    if (parsed) {
      found.push({
        ...parsed,
        url: resolve(asset.href, itemUrl),
        units: isNonEmptyString(band?.unit) ? band.unit : "",
      });
    }
```

Replace `drawable()` with:

```js
/*
 * Validate catalog input before handing it to MapLibre. One incomplete layer must
 * not discard the others.
 */
const drawable = (layer) =>
  isFiniteNumber(layer.minZoom) &&
  isFiniteNumber(layer.maxZoom) &&
  layer.minZoom <= layer.maxZoom &&
  layer.encoding !== null &&
  isFiniteNumber(layer.vmin) &&
  isFiniteNumber(layer.vmax) &&
  layer.vmin < layer.vmax;
```

Change `storeLayers`:

```js
/**
 * Join catalog documents without network access.
 *
 * @param {{item: object, url: string}[]} items  the year items, with the URLs
 *   they were read from for relative hrefs
 * @param {object|Map<number|string, object>} style  the MapLibre style the
 *   collection nominates, or one per year keyed as styleHrefs() keys them
 * @param {object} collection  the mosaics collection, for its renders
 * @returns {object[]}
 */
export function storeLayers(items, style, collection) {
  const styles = style instanceof Map ? style : new Map([["default", style]]);
  const drawn = new Map([...styles].map(([key, document]) => [key, sources(document)]));
  const fallback = drawn.get("default");
  const ranges = stretches(collection);
  // ... unchanged enumeration of `found` ...
  for (const archive of found) {
    const own = drawn.get(archive.year);
    /* Encodings are fixed per layer, so fallback by stem across years is safe. */
    const source =
      own?.byId.get(archive.id) ??
      fallback?.byId.get(archive.id) ??
      own?.byStem.get(archive.stem) ??
      fallback?.byStem.get(archive.stem);
    if (source === undefined) {
      console.warn("store: no style entry describes", archive.id);
      continue;
    }
    const layer = { ...source, ...ranges.get(archive.stem), ...archive };
    if (!drawable(layer)) {
      console.warn("store: skipping a layer the catalog describes incompletely", archive.id);
      continue;
    }
    layers.push(layer);
  }
  // ... unchanged ...
}
```

In `readStore()`, change the last line to `return storeLayers(answered.slice(unique.length).filter(Boolean), drawnAs, collection);`. Delete `FALSE_COLOUR` and its comment from `store.js`. Change the file header to:

```js
/*
 * Read one raster record per PMTiles archive. The year items enumerate archives
 * and supply dates and units; styles supply decoding; the collection's renders
 * supply default stretches. Join on the layer ID; see AGENTS.md.
 */
```

- [ ] **Step 5: Run the store tests**

Run: `pixi run --locked node --test tests/store.test.js tests/store-local.test.js tests/encoded.test.js`
Expected: PASS. If `store-local.test.js` builds its own style, give it the same source-based shape.

- [ ] **Step 6: Default color maps in the viewer**

In `js/rasters.js`:

- Change the import to `import { isFiniteNumber, isNonEmptyString, readStore } from "./store.js";` and add a local `const FALSE_COLOUR = "RGB";` with the comment `/* RGB shares the polarization field but uses channel recipes instead of a ramp. */`.
- After `quantityOf`, add:

```js
/* Default color maps are the viewer's choice; the catalog's style ramp is not read. */
const PRODUCT_CMAP = { COH12: "cmc.lipari", RTC: "cmc.grayC" };
const QA_CMAP = "cmc.glasgow";

export function defaultCmap(layer) {
  const { quantity } = splitPolarization(layer.polarization);
  if (quantity !== MEASUREMENT) return QA_CMAP;
  return PRODUCT_CMAP[layer.product] ?? "viridis";
}
```

  (`splitPolarization` is a function declaration, so it is hoisted.)
- `colorsOf`: `const colorsOf = (layer) => COLOR_MAPS[state.cmap ?? defaultCmap(layer)];`
- `rangeOf`: `const rangeOf = (layer) => state.ranges.get(layer.stem) ?? { vmin: layer.vmin, vmax: layer.vmax };`
- `ensureLayer`: delete the non-encoded `raster` branch, so the encoded block becomes the whole body after the `state.added` check.
- `opacityProperty`: leave it as is. Task 3 rewrites it.
- `updateColourMapCredit`: `const name = state.cmap ?? defaultCmap(layer);`
- `initRecolor`: change the first option's text from `"As published"` to `"Default"`.

- [ ] **Step 7: Update the page tests**

- `tests/viewer.test.js`: where the test asserts a GLACE source (not world imagery), expect `source.type === "raster-dem"`. Replace `paint["raster-opacity"]` with `paint["color-relief-opacity"]` at lines 304 and 311.
- `tests/store-catalog.test.js`:
  - "the seven-value polarization field becomes two rows": rename it to "the six-value polarization field becomes two rows". Change `fields.size` 7 → 6, the polarization row to `["VV", "VH"]` (Task 3 restores RGB), and `archives.length` 56 → 48, with the comment `// 12 archives per year, 2 products x 2 x 3, over four published years.`
  - "a QA raster brings its own ramp, stretch and color-map credit": expect `legend-min`/`legend-max` `"0.0"`/`"80.0"` for QA_NUM, and `"-2.5 dB"`/`"8.0 dB"` for COH12 QA_CQM. The credit still reads `Colormap: glasgow`.
  - Delete "the false color and the QA rasters gray each other, but stay reachable", "and the other way round: a QA button pressed on false color resets it", "the false color names its channels and the stretch each was baked with", and "going back to a single-band layer restores the ramp". Task 3 brings back adapted versions.
  - "every archive the store published is reachable": the closing comment becomes `// The twelve above: a layer is created once and kept, so this is every archive the item lists for the year the page sits on.` The count assertion is unchanged for now. Task 3 changes it.
  - Update the file header: remove "and RGB" from the panel-choices sentence, and replace "copied from https://data.source.coop/lqgentner/glace-ch" with "converted from glace-catalog's value-encoded catalog".
- Run `grep -n -E "portolan:legend|\.cmap\b|\.colors\b|14\b|56\b" tests/*.test.js` and resolve each remaining hit that refers to the old catalog before moving on.

- [ ] **Step 8: Update AGENTS.md**

In "Reading the catalog": point 2 now describes `color-relief` layers with `raster-dem` custom-encoded sources (decoding, zooms, credit). Replace the paragraph that starts "`metadata.portolan:legend` supplies color stops…" with:

> The style's sources supply each archive's custom encoding, zoom limits and credit; its ramp is not read. Default stretches come from the collection's `renders[<stem>].rescale`, units from the item asset's `bands[0].unit`. Default color maps and the false-color blue range are viewer constants in `js/rasters.js` and `js/composite.js`, because they are presentation, not data. Stretches are fixed per layer so years stay comparable.

Delete "Changes to raster rendering belong in the upstream store, since the viewer displays pre-styled RGBA archives." In "Tests and deployment", change the `store/` fixture description to "represents the value-encoded catalog converted from glace-catalog, with reduced item geometry and no archive links".

- [ ] **Step 9: Run everything**

Run: `pixi run --locked test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add -A js tests AGENTS.md
git commit -m "Read the value-encoded catalog

Styles supply each archive's custom encoding, zooms and credit; the
collection's renders supply default stretches and the item bands supply
units. The viewer picks default color maps itself. The pre-styled raster
path and portolan:legend parsing go, and the fixtures are converted from
glace-catalog's value-encoded catalog.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Compose false color on demand

**Files:**
- Create: `js/composite.js`, `tests/composite.test.js`
- Modify: `js/values.js` (export `tilePixels`, retry failures, larger cache), `js/map.js` (register the protocol), `js/rasters.js` (records, source, opacity, channel legend; remove `validChannels`/`falseColourChannels`), `tests/helpers/browser.js` (image decode stubs), `tests/layers.test.js`, `tests/store-catalog.test.js`, `AGENTS.md`

**Interfaces:**
- Consumes: `Layer` records from Task 2 (`url`, `encoding`, `units`, `vmin`, `vmax`, `minZoom`, `maxZoom`, `attribution`), plus `decodePixel(encoding, r, g, b)` from `js/values.js`.
- Produces:
  - `FALSE_COLOUR = "RGB"`
  - `compositeLayers(layers) -> Composite[]`, where `Composite = { id, stem, product, polarization: "RGB", year, units, minZoom, maxZoom, attribution, startDate, endDate, channels: [{band, vmin, vmax}×3], composite: {vv: Layer, vh: Layer, decibel: boolean} }`
  - `compositeTiles(id) -> "glace-rgb://{id}/{z}/{x}/{y}"`
  - `compositePixels(vvTile, vhTile, record) -> Uint8ClampedArray`, where tiles are `{size, data: Uint8ClampedArray}` RGBA
  - `compositeProtocol(params, abortController) -> Promise<{data: ImageBitmap | ArrayBuffer(0)}>` (rejects on a failed read or abort)
  - `tilePixels(url, z, x, y) -> Promise<{size, data}|null>` (now exported from `values.js`; `null` only for an absent tile, rejects uncached on failure)

- [ ] **Step 1: Write the failing tests**

In `tests/helpers/browser.js`, replace the canvas stub (the `ImageData` and `OffscreenCanvas` classes and their comment) with stubs for what `js/values.js` and `js/composite.js` now use. A fake archive "encodes" a tile as raw RGBA bytes, so decoding hands the same pixels back, and a composed bitmap carries its pixels where a test can read them:

```js
  /* Enough of the image APIs for js/values.js and js/composite.js. A fake
   * archive's tile bytes are raw RGBA, so decoding hands them straight back,
   * and a composed bitmap keeps its pixels where a test can assert on them. */
  globalThis.ImageData = class {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  };
  globalThis.createImageBitmap = async (source) => {
    const data =
      source instanceof globalThis.ImageData
        ? source.data
        : new Uint8ClampedArray(await source.arrayBuffer());
    const size = Math.sqrt(data.length / 4);
    return { width: size, height: size, data, close() {} };
  };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      Object.assign(this, { width, height });
    }
    getContext() {
      return {
        drawImage: (bitmap) => { this.data = bitmap.data; },
        getImageData: () => ({ data: this.data }),
      };
    }
  };
```

(Task 1 already renamed this comment's module reference. This replaces the block wholesale.)

Create `tests/composite.test.js`:

```js
/* Check false-color records, pixel composition and the glace-rgb protocol. */

import assert from "node:assert/strict";
import test from "node:test";

import { installBrowser, load } from "./helpers/browser.js";

installBrowser();
const { compositeLayers, compositePixels, compositeProtocol, compositeTiles } = await load(
  "js/composite.js",
);

/* value = code / 10 - 19.1 in the blue channel; code 0 in all three is nodata. */
const ENCODING = { encoding: "custom", redFactor: 0, greenFactor: 0, blueFactor: 0.1, baseShift: 19.1 };
const record = (over) => ({
  product: "RTC", year: 2024, units: "dB", encoding: ENCODING, minZoom: 5, maxZoom: 13,
  attribution: "Credit 2024", url: `https://x/${over.polarization}.pmtiles`, ...over,
});
/* Stretches chosen so no expected channel lands on a rounding half. */
const VV = record({ id: "glace-rtc_vv-2024", stem: "rtc_vv", polarization: "VV", vmin: -16, vmax: -5 });
const VH = record({ id: "glace-rtc_vh-2024", stem: "rtc_vh", polarization: "VH", vmin: -22, vmax: -11 });

test("one composite per product and year with both polarizations", () => {
  const qa = record({ id: "glace-rtc_vv_qa_num-2024", stem: "rtc_vv_qa_num", polarization: "VV_QA_NUM", vmin: 0, vmax: 80 });
  const lonely = record({ id: "glace-rtc_vv-2023", stem: "rtc_vv", polarization: "VV", year: 2023, vmin: -16, vmax: -5 });
  const [rgb, ...rest] = compositeLayers([VV, VH, qa, lonely]);
  assert.equal(rest.length, 0, "no VH in 2023, and QA never composes");
  assert.equal(rgb.id, "glace-rtc_rgb-2024");
  assert.equal(rgb.polarization, "RGB");
  assert.equal(rgb.attribution, "Credit 2024");
  assert.deepEqual(rgb.channels, [
    { band: "VV", vmin: -16, vmax: -5 },
    { band: "VH", vmin: -22, vmax: -11 },
    { band: "VV − VH", vmin: 3.5, vmax: 10.5 },
  ]);
});

test("coherence composes a quotient over its own blue range", () => {
  const cvv = record({ id: "glace-coh12_vv-2024", stem: "coh12_vv", product: "COH12", polarization: "VV", units: "", vmin: 0.1, vmax: 0.75 });
  const cvh = record({ id: "glace-coh12_vh-2024", stem: "coh12_vh", product: "COH12", polarization: "VH", units: "", vmin: 0.1, vmax: 0.55 });
  const [rgb] = compositeLayers([cvv, cvh]);
  assert.deepEqual(rgb.channels[2], { band: "VV / VH", vmin: 0.8, vmax: 2.6 });
  assert.equal(rgb.composite.decibel, false);
});

test("an unknown product has no blue range and composes nothing", () => {
  const xvv = record({ id: "glace-x_vv-2024", stem: "x_vv", product: "X", polarization: "VV", vmin: 0, vmax: 1 });
  const xvh = record({ id: "glace-x_vh-2024", stem: "x_vh", product: "X", polarization: "VH", vmin: 0, vmax: 1 });
  assert.deepEqual(compositeLayers([xvv, xvh]), []);
});

/* Two-pixel tiles: grey codes, alpha 255 unless stated. */
const tile = (...pixels) => ({
  size: 2,
  data: new Uint8ClampedArray(pixels.flatMap(([code, alpha = 255]) => [code, code, code, alpha])),
});

test("each channel is stretched, and a pixel needs both polarizations", () => {
  const [rgb] = compositeLayers([VV, VH]);
  // VV code 91 -> -10 dB, VH code 31 -> -16 dB, ratio 6 dB.
  const out = compositePixels(
    tile([91], [91], [0], [91, 0]),
    tile([31], [0], [31], [31]),
    rgb,
  );
  const px = (at) => [...out.slice(at * 4, at * 4 + 4)];
  // 6/11, 6/11 and 2.5/7 of 255.
  assert.deepEqual(px(0), [139, 139, 91, 255]);
  assert.deepEqual(px(1), [0, 0, 0, 0], "VH nodata: transparent, not black");
  assert.deepEqual(px(2), [0, 0, 0, 0], "VV nodata");
  assert.deepEqual(px(3), [0, 0, 0, 0], "VV transparent in a lossy tile");
});

test("the protocol composes a named tile and blanks one an archive lacks", async () => {
  const [rgb] = compositeLayers([VV, VH]);
  const served = new Map([
    ["https://x/VV.pmtiles|13/1/2", tile([91], [91], [91], [91]).data],
    ["https://x/VH.pmtiles|13/1/2", tile([31], [31], [31], [31]).data],
  ]);
  globalThis.pmtiles.PMTiles = class {
    constructor(url) { this.url = url; }
    async getZxy(z, x, y) {
      const data = served.get(`${this.url}|${z}/${x}/${y}`);
      return data ? { data: data.buffer } : undefined;
    }
  };
  assert.equal(compositeTiles(rgb.id), "glace-rgb://glace-rtc_rgb-2024/{z}/{x}/{y}");

  const drawn = await compositeProtocol({ url: "glace-rgb://glace-rtc_rgb-2024/13/1/2" });
  assert.equal(drawn.data.width, 2, "a bitmap MapLibre takes as is");
  assert.equal(drawn.data.data[3], 255);

  const absent = await compositeProtocol({ url: "glace-rgb://glace-rtc_rgb-2024/13/9/9" });
  assert.equal(absent.data.byteLength, 0, "outside the archive: an empty, transparent tile");

  await assert.rejects(() => compositeProtocol({ url: "glace-rgb://nope/13/1/2" }), /no false-color composite/);
});

test("a failed tile read fails the tile and is retried next time", async () => {
  // Fresh archive URLs: js/values.js keeps one PMTiles reader per URL.
  compositeLayers([
    { ...VV, url: "https://retry/VV.pmtiles" },
    { ...VH, url: "https://retry/VH.pmtiles" },
  ]);
  let failing = true;
  globalThis.pmtiles.PMTiles = class {
    async getZxy() {
      if (failing) throw new Error("network");
      return { data: tile([91], [91], [91], [91]).data.buffer };
    }
  };
  const url = "glace-rgb://glace-rtc_rgb-2024/12/3/4";
  await assert.rejects(() => compositeProtocol({ url }), /network/, "not a blank success");
  failing = false;
  const second = await compositeProtocol({ url });
  assert.equal(second.data.data[3], 255, "the failure was not cached");
});

test("an aborted tile stops waiting without canceling the shared reads", async () => {
  compositeLayers([
    { ...VV, url: "https://slow/VV.pmtiles" },
    { ...VH, url: "https://slow/VH.pmtiles" },
  ]);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.pmtiles.PMTiles = class {
    async getZxy() {
      await gate;
      return { data: tile([91], [91], [91], [91]).data.buffer };
    }
  };
  const url = "glace-rgb://glace-rtc_rgb-2024/11/5/6";
  const controller = new AbortController();
  const aborted = compositeProtocol({ url }, controller);
  const other = compositeProtocol({ url }, new AbortController());
  controller.abort();
  await assert.rejects(aborted, { name: "AbortError" }, "rejects before the reads finish");
  release();
  assert.equal((await other).data.data[3], 255, "the other consumer still gets its tile");

  const early = new AbortController();
  early.abort();
  await assert.rejects(() => compositeProtocol({ url }, early), { name: "AbortError" });
});
```

In `tests/viewer.test.js:130`, the two-year fixture now composes false color: change it to `assert.deepEqual(faces("pol"), ["VV", "VH", "RGB"], "VV is the left-hand button");`.

In `tests/store-catalog.test.js`:
- In "the six-value polarization field becomes two rows", change the polarization row back to `["VV", "VH", "RGB"]`.
- In "every archive the store published is reachable", count archives apart from composites, which earlier tests created:

```js
  // The twelve above: a layer is created once and kept, so this is every archive
  // the item lists for the year the page sits on. Composites have no archive.
  assert.equal(
    [...map.layers.keys()].filter((id) => id.startsWith("glace-") && !id.includes("_rgb-")).length,
    archives.filter(({ year }) => year === 2024).length,
  );
```

- Add these, before "every archive the store published is reachable":

```js
test("false color and the QA rasters gray each other, but stay reachable", async () => {
  await pick("pol", "VV");
  await pick("quantity", "QA_NUM");
  const rgb = buttons(el, "pol").RGB;
  assert.equal(rgb.getAttribute("aria-disabled"), "true");
  assert.equal(rgb.disabled, false);
  await pick("pol", "RGB");
  assert.equal(buttons(el, "quantity")[""].getAttribute("aria-checked"), "true", "QA gave way");
  await pick("quantity", "QA_NUM");
  assert.equal(buttons(el, "pol").VV.getAttribute("aria-checked"), "true", "RGB gave way");
});

test("false color is a composed raster that names its channels and credits the data", async () => {
  await pick("quantity", "");
  await pick("pol", "RGB");
  const source = page.map.getSource("glace-coh12_rgb-2024");
  assert.equal(source.type, "raster");
  assert.deepEqual(source.tiles, ["glace-rgb://glace-coh12_rgb-2024/{z}/{x}/{y}"]);
  assert.match(source.attribution, /Copernicus Sentinel data 2024/);
  assert.equal(page.map.getLayer("glace-coh12_rgb-2024").paint["raster-opacity"], 1);
  assert.equal(el("legend-channels").hidden, false);
  assert.equal(el("legend-bar").hidden, true);
  assert.deepEqual(
    [...el("legend-channels").children].map((node) => node.textContent).filter(Boolean),
    ["VV", "0.10 to 0.75", "VH", "0.10 to 0.55", "VV / VH", "0.80 to 2.60"],
  );
  await pick("pol", "VV");
  assert.equal(el("legend-bar").hidden, false, "a single-band layer restores the ramp");
});
```

In `tests/layers.test.js`, delete "a false color reports the channels the build published", "without them it names the bands and quotes no range", and "a channel list the page cannot vouch for is dropped, not printed". Remove `falseColourChannels` from its import. In "both rows are ordered by the panel…", the RGB fixture record stays as is, since `indexLayers` still orders RGB.

- [ ] **Step 2: Run them and watch them fail**

Run: `pixi run --locked node --test tests/composite.test.js tests/store-catalog.test.js`
Expected: FAIL (`js/composite.js` does not exist, and there is no RGB button).

- [ ] **Step 3: Export and harden the tile cache in `js/values.js`**

```js
const MAX_TILES = 128;
```

Export `tilePixels`. Keep `null` for a tile the archive lacks, and evict and rethrow a failed read so that it fails the request and is retried next time:

```js
/**
 * The decoded RGBA of one archive tile, shared between consumers.
 *
 * @returns {Promise<{size: number, data: Uint8ClampedArray}|null>}  null where
 *   the archive has no tile; rejects, uncached, when the read or decode fails
 */
export function tilePixels(url, z, x, y) {
  const key = `${url}|${z}/${x}/${y}`;
  const cached = tiles.get(key);
  if (cached) {
    // Move to the back of the insertion order: least recently used goes first.
    tiles.delete(key);
    tiles.set(key, cached);
    return cached;
  }
  const pending = archive(url)
    .getZxy(z, x, y)
    .then((response) => (response?.data ? decodeTile(response.data) : null))
    .catch((error) => {
      // Not cached: panning back over this tile should retry it.
      tiles.delete(key);
      throw error;
    });
  tiles.set(key, pending);
  if (tiles.size > MAX_TILES) tiles.delete(tiles.keys().next().value);
  return pending;
}
```

Change the header comment to say the cache serves both the readout and false-color composites.

The cursor readout in `js/rasters.js` (inside `initRecolor`) must now handle a rejected read, and it must not write a value for a layer that is no longer selected. Replace its `try … finally` body with:

```js
    try {
      const value = await valueAt(layer, lng, lat);
      // The selection may have moved on while the tile was read.
      if (selected() !== layer) return;
      const decimals = Math.max(0, Math.ceil(-Math.log10(step(layer.encoding))));
      el("readout-value").textContent =
        value === null || value === undefined
          ? "no data"
          : `${value.toFixed(decimals)}${unitSuffix(layer)}`;
    } catch {
      if (selected() === layer) el("readout-value").textContent = "–";
    } finally {
      busy = false;
      if (pending !== null) lookup();
    }
```

In `render()`, reset the readout when the selection changes. Add the following before `syncControls();`:

```js
  if (active?.id !== state.activeKey) el("readout-value").textContent = "–";
```

- [ ] **Step 4: Create `js/composite.js`**

```js
/*
 * False color composed on demand from the VV and VH archives of one product and
 * year: red VV, green VH, blue their ratio (VV − VH in dB, VV / VH otherwise).
 * Red and green use the single-band default stretches; blue's range is the
 * viewer's own, from the catalog's last RGB archives. Served to a raster source
 * through the glace-rgb:// protocol registered in js/map.js.
 */

import { decodePixel, tilePixels } from "./values.js";

/* RGB shares the polarization field but has channels instead of a ramp. */
export const FALSE_COLOUR = "RGB";

/* Blue-channel ranges by product. */
const RATIO_RANGE = { COH12: [0.8, 2.6], RTC: [3.5, 10.5] };

const composites = new Map();

export const compositeTiles = (id) => `glace-rgb://${id}/{z}/{x}/{y}`;

/**
 * One false-color record per product and year with a VV and a VH data layer.
 *
 * @param {object[]} layers  records from js/store.js
 * @returns {object[]}
 */
export function compositeLayers(layers) {
  const out = [];
  for (const vv of layers) {
    if (vv.polarization !== "VV" || !(vv.product in RATIO_RANGE)) continue;
    const vh = layers.find(
      (layer) => layer.product === vv.product && layer.year === vv.year && layer.polarization === "VH",
    );
    if (vh === undefined) continue;
    const decibel = vv.units === "dB";
    const [low, high] = RATIO_RANGE[vv.product];
    const stem = `${vv.product.toLowerCase()}_rgb`;
    const record = {
      id: `glace-${stem}-${vv.year}`,
      stem,
      product: vv.product,
      polarization: FALSE_COLOUR,
      year: vv.year,
      units: vv.units,
      minZoom: Math.max(vv.minZoom, vh.minZoom),
      maxZoom: Math.min(vv.maxZoom, vh.maxZoom),
      attribution: vv.attribution,
      startDate: vv.startDate,
      endDate: vv.endDate,
      channels: [
        { band: "VV", vmin: vv.vmin, vmax: vv.vmax },
        { band: "VH", vmin: vh.vmin, vmax: vh.vmax },
        { band: decibel ? "VV − VH" : "VV / VH", vmin: low, vmax: high },
      ],
      composite: { vv, vh, decibel },
    };
    composites.set(record.id, record);
    out.push(record);
  }
  return out;
}

const scale = (value, { vmin, vmax }) =>
  Math.max(0, Math.min(255, Math.round((255 * (value - vmin)) / (vmax - vmin))));

/**
 * Compose two decoded RGBA code tiles of equal size. A pixel is drawn only
 * where both archives have data; a lossy tile marks nodata with alpha 0.
 */
export function compositePixels(vvTile, vhTile, record) {
  const { vv, vh, decibel } = record.composite;
  const [red, green, blue] = record.channels;
  const a = vvTile.data;
  const b = vhTile.data;
  const out = new Uint8ClampedArray(a.length);
  for (let at = 0; at < a.length; at += 4) {
    if (a[at + 3] === 0 || b[at + 3] === 0) continue;
    const co = decodePixel(vv.encoding, a[at], a[at + 1], a[at + 2]);
    const cross = decodePixel(vh.encoding, b[at], b[at + 1], b[at + 2]);
    if (co === null || cross === null) continue;
    const ratio = decibel ? co - cross : co / cross;
    if (!Number.isFinite(ratio)) continue;
    out[at] = scale(co, red);
    out[at + 1] = scale(cross, green);
    out[at + 2] = scale(ratio, blue);
    out[at + 3] = 255;
  }
  return out;
}

const aborted = () => new DOMException("tile aborted", "AbortError");

/*
 * Stop waiting when this request is aborted, without canceling the shared
 * cached reads another tile may still need.
 */
function unlessAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const abort = () => reject(aborted());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

const TILE_URL = /^glace-rgb:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/;

/**
 * The MapLibre protocol handler. Returns a bitmap MapLibre uploads as is, or an
 * empty buffer, which it draws transparent, where either archive has no tile.
 */
export async function compositeProtocol(params, abortController) {
  const signal = abortController?.signal;
  if (signal?.aborted) throw aborted();
  const at = TILE_URL.exec(params.url);
  if (at === null) throw new Error(`not a glace-rgb tile URL: ${params.url}`);
  const record = composites.get(at[1]);
  if (record === undefined) throw new Error(`no false-color composite named ${at[1]}`);
  const [z, x, y] = at.slice(2).map(Number);
  const { vv, vh } = record.composite;
  const [a, b] = await unlessAborted(
    Promise.all([tilePixels(vv.url, z, x, y), tilePixels(vh.url, z, x, y)]),
    signal,
  );
  if (a === null || b === null || a.size !== b.size) return { data: new ArrayBuffer(0) };
  const pixels = new ImageData(compositePixels(a, b, record), a.size, a.size);
  return { data: await createImageBitmap(pixels) };
}
```

- [ ] **Step 5: Register the protocol**

In `js/map.js`, add `import { compositeProtocol } from "./composite.js";` and, after the pmtiles protocol:

```js
/* False color composed from two value-encoded archives; see js/composite.js. */
maplibregl.addProtocol("glace-rgb", compositeProtocol);
```

- [ ] **Step 6: Wire composites into `js/rasters.js`**

- Imports: `import { FALSE_COLOUR, compositeLayers, compositeTiles } from "./composite.js";`. Delete the local `FALSE_COLOUR`. Drop `isFiniteNumber` from the `./store.js` import once `validChannels` is gone.
- `const opacityProperty = (layer) => (layer.composite ? "raster-opacity" : "color-relief-opacity");`
- At the top of `ensureLayer`, after the `state.added` check:

```js
  /* A composite has no archive of its own, so its source names the credit. */
  if (layer.composite) {
    map.addSource(id, {
      type: "raster",
      tiles: [compositeTiles(id)],
      tileSize: 256,
      minzoom: layer.minZoom,
      maxzoom: layer.maxZoom,
      attribution: layer.attribution,
    });
    addStacked("data", {
      id,
      type: "raster",
      source: id,
      layout: { visibility: "none" },
      paint: { "raster-opacity": state.opacity, "raster-resampling": "nearest" },
    });
    state.added.add(id);
    return;
  }
```

- `updateChannelLegend`: iterate `layer.channels` directly instead of `falseColourChannels(layer)`, and always print the range: `` `${round(vmin, vmax - vmin)} to ${round(vmax, vmax - vmin)}${unit}` ``.
- Delete `validChannels` and `falseColourChannels`, with their comments.
- `loadRasters`: `const layers = await readStore(); axes = indexLayers([...layers, ...compositeLayers(layers)]);` inside the existing `try`.

- [ ] **Step 7: Update AGENTS.md**

- Code map: add the row `| js/composite.js | False color composed from VV and VH archives via glace-rgb:// |`, and change the `js/rasters.js` row to "Raster selection, source creation, panel axes, legend editing".
- After the "Reading the catalog" section, add:

> ### False color
>
> `js/composite.js` derives one RGB record per product and year with VV and VH data layers and serves it through `glace-rgb://`, decoding both archives' tiles with `js/values.js`. Red and green reuse the single-band default stretches; blue's range is a viewer constant per product. A pixel needs data in both archives. The composite source carries the style source's credit because it has no TileJSON.

- In the "Controls and external text" paragraph about RGB with QA, keep the `GIVES_WAY` description (RGB has no QA counterpart).

- [ ] **Step 8: Run everything**

Run: `pixi run --locked test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A js tests AGENTS.md
git commit -m "Compose false color from the VV and VH archives

A glace-rgb protocol decodes both value-encoded tiles and stretches VV,
VH and their ratio into an ImageBitmap, so false color no longer needs
archives of its own. Failed tile reads fail the tile and are retried
rather than cached as blank, an aborted tile stops waiting at once, and
the readout ignores answers for a layer no longer selected.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Inline-editable legend and the curated color maps

**Files:**
- Create: `scripts/colormaps.py`, `tests/legend.test.js`
- Regenerate: `js/colormaps.js`
- Modify: `index.html:74-92` (legend markup), `style.css` (legend and `.editable`), `js/rasters.js` (state, legend, `initLegend` replacing `initRecolor`, credit removal), `tests/viewer.test.js` (credit subtest), `tests/store-catalog.test.js` (QA credit lines), `README.md`, `AGENTS.md`

**Interfaces:**
- Consumes: `defaultCmap(layer)` (Task 2), `attachPopover(button, build, {className, hover})` and `hidePopover({refocus})` from `js/ui.js`, and `COLOR_MAPS` keys.
- Produces: DOM IDs `cmap` (button), `range-reset`, `vmin`, `vmax` (inputs), `.unit` spans inside `#legend-labels`, and the popover class `cmap-popover` with `.cmap-option` buttons.

- [ ] **Step 1: Write the failing legend tests**

Create `tests/legend.test.js`:

```js
/*
 * The inline-editable legend against the two-year fixture: color-map choice,
 * limits, reset, and per-layer memory. A separate process gives it a fresh map.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { installBrowser, load, REPO, settle } from "./helpers/browser.js";

const fixture = (name) => path.join(REPO, "tests", "fixtures", "two-years", name);
const page = installBrowser({
  files: {
    "http://localhost/tiles/mosaics/collection.json": fixture("collection.json"),
    "http://localhost/tiles/mosaics/style.json": fixture("style.json"),
    "http://localhost/tiles/mosaics/2022/item.json": fixture("item-2022.json"),
    "http://localhost/tiles/mosaics/2023/item.json": fixture("item-2023.json"),
    "data/inventories.json": path.join(REPO, "data", "inventories.json"),
  },
});
const { el, window } = page;
await load("js/app.js");
// The harness exposes the map the modules built, so read it after loading them.
const { map } = page;
map.fire("style.load");
await settle();
const { COLOR_MAPS } = await load("js/colormaps.js");

const ID = "glace-coh12_vv-2023";
/* Positions and colors of a color-relief ramp, past the two nodata stops. */
const ramp = (id) => {
  const stops = map.getLayer(id).paint["color-relief-color"].slice(3);
  return { first: stops[4], firstColor: stops[5], last: stops.at(-2) };
};
const change = async (input, value) => {
  input.value = value;
  input.dispatchEvent(new window.Event("change"));
  await settle();
};
const pick = async (row, value) => {
  [...el(row).children].find((b) => b.dataset.value === value).click();
  await settle();
};

test("the scale names its default color map and shows plain limits", () => {
  assert.equal(el("cmap").textContent, "lipari");
  assert.equal(el("vmin").value, "0.10");
  assert.equal(el("vmax").value, "0.75");
  assert.equal(el("range-reset").hidden, true);
  assert.equal(el("legend-credit"), null, "the credit button is gone");
  assert.equal(el("recolor"), null, "and so is the old recolor row");
});

test("the color-map popover lists the curated maps and recolors the layer", async () => {
  el("cmap").click();
  const options = [...window.document.querySelectorAll(".cmap-popover .cmap-option")];
  assert.equal(options.length, 11);
  assert.deepEqual(
    options.filter((o) => o.getAttribute("aria-pressed") === "true").map((o) => o.textContent),
    ["lipari"],
  );
  options.find((o) => o.textContent === "batlow").click();
  await settle();
  assert.equal(window.document.querySelector(".cmap-popover"), null, "picking closes it");
  assert.equal(el("cmap").textContent, "batlow");
  assert.ok(el("cmap").classList.contains("modified"));
  assert.equal(ramp(ID).firstColor, COLOR_MAPS["cmc.batlow"][0]);
  assert.equal(el("range-reset").hidden, false);
});

test("limits apply on change, accept a comma, and revert when invalid", async () => {
  await change(el("vmin"), "0,2");
  assert.equal(ramp(ID).first, 0.2);
  assert.equal(el("vmin").value, "0.20");
  assert.ok(el("vmin").classList.contains("modified"));
  assert.equal(el("vmax").classList.contains("modified"), false, "the untouched limit is not");

  await change(el("vmax"), "0.1");
  assert.equal(el("vmax").value, "0.75", "an inverted range reverts");
  assert.equal(ramp(ID).last, 0.75);

  await change(el("vmin"), "abc");
  assert.equal(el("vmin").value, "0.20", "so does text");

  await change(el("vmin"), "-1");
  assert.equal(el("vmin").value, "0.20", "and a limit below what the archive encodes");
});

test("Escape reverts a limit being typed", async () => {
  el("vmin").focus();
  el("vmin").value = "0.5";
  el("vmin").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  await settle();
  assert.equal(el("vmin").value, "0.20");
});

test("render never overwrites a focused limit", async () => {
  el("vmax").focus();
  el("vmax").value = "0.6";
  el("opacity").value = "50";
  el("opacity").dispatchEvent(new window.Event("input"));
  await settle();
  assert.equal(el("vmax").value, "0.6");
  el("vmax").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  el("vmax").blur();
});

test("choices belong to their layer: kept across years, separate per product", async () => {
  el("year").value = "0";
  el("year").dispatchEvent(new window.Event("input"));
  await settle();
  assert.equal(el("cmap").textContent, "batlow", "2022 keeps the coherence choice");
  assert.equal(el("vmin").value, "0.20");

  await pick("product", "RTC");
  assert.equal(el("cmap").textContent, "grayC", "backscatter keeps its own default");
  assert.equal(el("range-reset").hidden, true);

  await pick("product", "COH12");
  el("range-reset").click();
  await settle();
  assert.equal(el("cmap").textContent, "lipari");
  assert.equal(el("vmin").value, "0.10");
  assert.equal(el("range-reset").hidden, true);
});

test("false color shows channels and nothing to edit", async () => {
  await pick("pol", "RGB");
  assert.equal(el("cmap").hidden, true);
  assert.equal(el("legend-labels").hidden, true);
  assert.equal(el("range-reset").hidden, true);
  assert.equal(el("readout").hidden, true);
  await pick("pol", "VV");
  assert.equal(el("cmap").hidden, false);
});
```

In `tests/viewer.test.js`, replace the subtest "the scale carries the color map's credit" with:

```js
  await t.test("the scale names its color map instead of crediting it", async () => {
    assert.equal(el("cmap").textContent, "lipari");
    assert.equal(el("legend-credit"), null);
  });
```

In `tests/store-catalog.test.js`, rename "a QA raster brings its own ramp, stretch and color-map credit" to "a QA raster brings its own color map and stretch". Change the legend assertions to read `el("vmin").value`/`el("vmax").value` plus the `.unit` text, and replace the credit lines with `assert.equal(el("cmap").textContent, "glasgow");`. For QA_NUM: `"0.0"`, `"80.0"`, unit `""`. For COH12 QA_CQM: `"-2.5"`, `"8.0"`, unit `" dB"` (`round()` gives one decimal for a span ≥ 5).

- [ ] **Step 2: Run them and watch them fail**

Run: `pixi run --locked node --test tests/legend.test.js tests/viewer.test.js`
Expected: FAIL (there is no `#cmap` button, and `#legend-credit` still exists).

- [ ] **Step 3: Generate the color maps**

Create `scripts/colormaps.py`:

```python
# /// script
# requires-python = ">=3.11"
# dependencies = ["matplotlib", "cmcrameri"]
# ///
"""Write js/colormaps.js: the viewer's color maps, 32 stops each.

Run: uv run scripts/colormaps.py > js/colormaps.js
"""

import json

import cmcrameri.cm  # noqa: F401  (registers the cmc.* maps)
from matplotlib import colormaps
from matplotlib.colors import to_hex

NAMES = [
    "cmc.batlow", "cmc.lipari", "cmc.lajolla", "cmc.imola", "cmc.glasgow",
    "cmc.devon", "cmc.oslo", "cmc.grayC", "viridis", "magma", "cividis",
]
STOPS = 32

HEADER = """/*
 * Sequential, perceptually uniform color maps for value-encoded layers, in panel
 * order, 32 stops each. Written by scripts/colormaps.py; do not edit by hand.
 *
 * cmc.* maps: Scientific colour maps, Fabio Crameri, MIT License.
 * Crameri, F. (2018). Scientific colour maps. Zenodo.
 * https://doi.org/10.5281/zenodo.1243862
 * viridis, magma, cividis: matplotlib, CC0.
 */
"""

print(HEADER)
print("export const COLOR_MAPS = {")
for name in NAMES:
    stops = [to_hex(colormaps[name](i / (STOPS - 1))) for i in range(STOPS)]
    print(f"  {json.dumps(name)}: {json.dumps(stops)},")
print("};")
```

Before running it, open the Zenodo record (https://doi.org/10.5281/zenodo.1243862) and confirm the license line. If the record gives a copyright year, write `Copyright (c) <year> Fabio Crameri, MIT License` verbatim.

Run: `uv run scripts/colormaps.py > js/colormaps.js && head -12 js/colormaps.js && grep -c '": \[' js/colormaps.js`
Expected: the header, then `11`.

- [ ] **Step 4: New legend markup**

Replace the `<section id="legend">…</section>` block in `index.html` with:

```html
            <section id="legend" class="control">
              <div class="control-head">
                <label for="cmap">Scale</label>
                <!-- Value-encoded layers: color map, limits and reset are edited in place. -->
                <button type="button" id="cmap" class="editable" title="Color map"></button>
                <button type="button" id="range-reset" title="Reset color map and range"
                        aria-label="Reset color map and range" hidden>↺</button>
              </div>
              <div id="legend-bar"></div>
              <div id="legend-labels">
                <span class="limit"><input id="vmin" class="editable" inputmode="decimal"
                  autocomplete="off" spellcheck="false" aria-label="Minimum" /><span class="unit"></span></span>
                <span class="limit"><input id="vmax" class="editable" inputmode="decimal"
                  autocomplete="off" spellcheck="false" aria-label="Maximum" /><span class="unit"></span></span>
              </div>
              <!-- False-color channel legend, shown in place of the color ramp. -->
              <div id="legend-channels" hidden></div>
              <div id="readout" hidden>Cursor <output id="readout-value">–</output></div>
            </section>
```

- [ ] **Step 5: Styles**

In `style.css`, delete the `#recolor` rules (keep the `#readout` rules) and add, after `#legend-labels`:

```css
/* The scale's name sits right after its label; reset is pushed to the end. */
#legend .control-head > label { flex: none; }
#range-reset {
  margin-left: auto;
  padding: 0 2px;
  font: inherit;
  font-size: 13px;
  line-height: 1;
  color: var(--muted);
  background: none;
  border: 0;
  cursor: pointer;
}
#range-reset:hover { color: var(--accent); }
#legend-labels .limit { display: inline-flex; align-items: baseline; }

/*
 * Editable values read as plain text until the legend is hovered or focused,
 * then show a quiet box; the control under the pointer or focus gets the accent.
 * Without hover (touch) the quiet box stays. Every rule is scoped to #legend so
 * the state rules, which come later, win on order at equal specificity.
 */
#legend .editable {
  margin: 0 -4px;
  padding: 0 3px;
  font: inherit;
  color: inherit;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
}
#legend .control-head .editable { font-size: 11px; color: var(--text); }
#legend input.editable { min-width: 0; cursor: text; font-variant-numeric: tabular-nums; }
#vmax { text-align: right; }
#legend:hover .editable,
#legend:focus-within .editable { border-color: var(--border); }
#legend:hover .editable:hover,
#legend .editable:focus-visible,
#legend .editable.popover-open { border-color: var(--accent); outline: none; }
#legend .editable.modified,
#legend .control-head .editable.modified { color: var(--accent-ink); }
@media (hover: none) {
  #legend .editable { border-color: var(--border); }
}

.cmap-popover { padding: 6px; }
.cmap-popover .cmap-option {
  display: grid;
  grid-template-columns: 72px auto;
  gap: 8px;
  align-items: center;
  width: 100%;
  padding: 3px 6px;
  font: inherit;
  font-size: 12px;
  color: var(--text);
  text-align: left;
  background: none;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
}
.cmap-popover .cmap-option:hover { border-color: var(--border); }
.cmap-popover .cmap-option[aria-pressed="true"] { border-color: var(--accent); }
.cmap-popover .ramp { height: 10px; border-radius: 3px; border: 1px solid var(--border); }
```

- [ ] **Step 6: Legend logic in `js/rasters.js`**

- Imports: add `attachPopover, hidePopover` to the `./ui.js` import, drop `creditButton` if nothing else uses it in this file, and import `decodePixel` alongside `step` and `valueAt` from `./values.js`.
- State: replace `cmap: null` and `ranges: new Map()` (and their comments) with:

```js
  /* Color-map and limit choices by layer stem, so a year change keeps them. */
  custom: new Map(),
```

- Replace `colorsOf` and `rangeOf`, and add helpers:

```js
const customOf = (layer) => state.custom.get(layer.stem) ?? {};
const cmapOf = (layer) => customOf(layer).cmap ?? defaultCmap(layer);
const colorsOf = (layer) => COLOR_MAPS[cmapOf(layer)];
const rangeOf = (layer) => ({
  vmin: customOf(layer).vmin ?? layer.vmin,
  vmax: customOf(layer).vmax ?? layer.vmax,
});
const shortName = (name) => name.replace(/^cmc\./, "");
const gradient = (colors) => `linear-gradient(to right, ${colors.join(", ")})`;

/* Record a choice, forgetting values equal to the defaults so reset means a change. */
function customize(layer, change) {
  const next = { ...customOf(layer), ...change };
  if (next.cmap === defaultCmap(layer)) delete next.cmap;
  if (next.vmin === layer.vmin) delete next.vmin;
  if (next.vmax === layer.vmax) delete next.vmax;
  if (Object.keys(next).length) state.custom.set(layer.stem, next);
  else state.custom.delete(layer.stem);
  render();
}
```

- Replace `updateLegend` with:

```js
/* Show a limit unless it is being typed in; remember what was shown for Escape. */
function showLimit(input, text) {
  input.dataset.shown = text;
  input.size = Math.max(2, text.length);
  if (document.activeElement !== input) input.value = text;
}

function updateLegend(layer) {
  const falseColour = layer.polarization === FALSE_COLOUR;
  el("legend-bar").hidden = falseColour;
  el("legend-labels").hidden = falseColour;
  el("legend-channels").hidden = !falseColour;
  el("cmap").hidden = falseColour;
  el("readout").hidden = falseColour;

  if (falseColour) {
    el("range-reset").hidden = true;
    updateChannelLegend(layer);
  } else {
    const custom = customOf(layer);
    const { vmin, vmax } = rangeOf(layer);
    const span = vmax - vmin;
    el("legend-bar").style.background = gradient(colorsOf(layer));
    el("cmap").textContent = shortName(cmapOf(layer));
    el("cmap").classList.toggle("modified", "cmap" in custom);
    showLimit(el("vmin"), round(vmin, span));
    showLimit(el("vmax"), round(vmax, span));
    el("vmin").classList.toggle("modified", "vmin" in custom);
    el("vmax").classList.toggle("modified", "vmax" in custom);
    for (const unit of el("legend-labels").querySelectorAll(".unit")) {
      unit.textContent = unitSuffix(layer);
    }
    el("range-reset").hidden = !state.custom.has(layer.stem);
  }
  el("layer-info").replaceChildren(...layerDetail(layer).map((line) => h("div", { textContent: line })));
}
```

- Delete `COLOUR_MAP_CREDIT`, `shownColourMap`, `updateColourMapCredit`, and `syncRecolor`.
- Replace the recoloring half of `initRecolor` (everything before the readout lookup) and rename the function `initLegend`:

```js
function initLegend() {
  attachPopover(
    el("cmap"),
    () => {
      const layer = selected();
      const current = layer ? cmapOf(layer) : null;
      return Object.keys(COLOR_MAPS).map((name) =>
        h(
          "button",
          {
            type: "button",
            class: "cmap-option",
            "aria-pressed": String(name === current),
            autofocus: name === current,
            onclick: () => {
              hidePopover({ refocus: true });
              if (layer) customize(layer, { cmap: name });
            },
          },
          h("span", { class: "ramp", style: { background: gradient(COLOR_MAPS[name]) } }),
          h("span", { textContent: shortName(name) }),
        ),
      );
    },
    { className: "cmap-popover", hover: false },
  );

  for (const input of [el("vmin"), el("vmax")]) {
    const revert = () => {
      input.value = input.dataset.shown ?? "";
    };
    input.addEventListener("change", () => {
      const layer = selected();
      if (!encoded(layer)) return;
      const text = input.value.trim().replace(",", ".");
      const value = Number(text);
      const range = rangeOf(layer);
      const next = input.id === "vmin" ? { ...range, vmin: value } : { ...range, vmax: value };
      // Below code 1 the ramp would fall into the nodata stop and lose its colors.
      const lowest = decodePixel(layer.encoding, 1, 1, 1) - step(layer.encoding) / 2;
      if (text === "" || !Number.isFinite(value) || next.vmin >= next.vmax || next.vmin < lowest) {
        revert();
        return;
      }
      input.blur();
      customize(layer, { [input.id]: value });
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
      if (event.key === "Escape") {
        revert();
        input.blur();
      }
    });
  }

  el("range-reset").addEventListener("click", () => {
    const layer = selected();
    if (layer) state.custom.delete(layer.stem);
    render();
  });

  // ... the readout lookup and mousemove handler as Task 3 left them ...
}
```

- In `loadRasters`, call `initLegend()` instead of `initRecolor()`.
- In the readout's `lookup`, leave the `encoded(layer)` guard as it is. Composites have no `encoding`, so they are skipped.

- [ ] **Step 7: README and AGENTS.md**

In `README.md`, replace "The displayed rasters have their colors baked in. For numerical analysis, use the COG assets linked from the STAC items in the browser above." with:

```markdown
The archives carry quantized values, colored in the browser: you can change
the color map and its range, and read the value under the cursor. They are
lossy 8-bit WebP, so for numerical analysis use the COG assets linked from the
STAC items in the browser above.
```

Append to `README.md`:

```markdown
## Third-party color maps

The `cmc.*` color maps in `js/colormaps.js` are Fabio Crameri's Scientific
colour maps, MIT License: Crameri, F. (2018). Scientific colour maps. Zenodo.
https://doi.org/10.5281/zenodo.1243862. viridis, magma and cividis come from
matplotlib (CC0). Regenerate the file with `uv run scripts/colormaps.py > js/colormaps.js`.
```

In `AGENTS.md`:
- Add the code-map row `| scripts/colormaps.py | Writes js/colormaps.js |`.
- In "Controls and external text", delete "avoid replacing a color-map credit button while its unchanged credit is being read" and add:

> The legend edits value-encoded layers in place: the color-map button opens a popover, the limits are inputs that render never overwrites while focused, and choices are kept per layer stem. False color is not editable.

- [ ] **Step 8: Run everything**

Run: `pixi run --locked test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A index.html style.css js scripts tests README.md AGENTS.md
git commit -m "Edit the scale in place, with a curated set of color maps

The color-map name follows the SCALE label and opens a popover with
gradient previews; the limits are inputs that look like text until the
legend is hovered. Choices are kept per layer, and reset appears only
after a change. Eleven sequential maps replace the recolor row, and the
Crameri credit moves into the source and README.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The inventory swatch takes the same box

**Files:**
- Modify: `style.css` (the `.inventory .swatch` block and its pencil rules), `tests/viewer.test.js:426,440` (assertion messages only)

**Interfaces:**
- Consumes: the `.popover-open` class set by `attachPopover`.
- Produces: nothing new.

- [ ] **Step 1: Update the test wording**

In `tests/viewer.test.js`, the subtest "the swatch picks an outline color…": change the messages `"the disc stays while open"` to `"the box stays while open"` and `"and drops the disc"` to `"and drops the box"`. The assertions on `popover-open` stay. CSS is not exercised by jsdom, so this task is checked visually in step 4.

- [ ] **Step 2: Replace the pencil with the box**

In `style.css`, replace everything from `/* Padding enlarges the hit target around the color bar. */` through the `…popover-open::after { opacity: 1; }` rule with:

```css
/* Padding enlarges the hit target around the color bar; the border is the edit box. */
.inventory .swatch {
  width: 20px;
  height: 19px;
  padding: 7px 2px;
  background-clip: content-box;
  border: 1px solid transparent;
  border-radius: 4px;
  flex: none;
  cursor: pointer;
}
.inventory:hover .swatch { border-color: var(--border); }
.inventory .swatch:hover,
.inventory .swatch:focus-visible,
.inventory .swatch.popover-open { border-color: var(--accent); outline: none; }
@media (hover: none) {
  .inventory .swatch { border-color: var(--border); }
}
```

- [ ] **Step 3: Run the tests**

Run: `pixi run --locked test`
Expected: PASS.

- [ ] **Step 4: Check it in a browser**

Run: `pixi run --locked build-tiles && pixi run --locked serve --tiles-dir <encoded catalog root>`, then open `http://localhost:8000/?tiles=tiles`. Check:
- Hovering over the legend shows quiet boxes around the name and both limits. Hovering over one gives it the accent.
- The color-map popover shows gradients and picking one recolors the map. Limits apply on Enter, revert on Escape, and an inverted range reverts.
- RGB draws for both products, with no black where only one polarization has data.
- The inventory swatch box matches the legend boxes.
- With touch emulation in the browser devtools, the quiet boxes are always visible.

- [ ] **Step 5: Commit**

```bash
git add style.css tests/viewer.test.js
git commit -m "Give the inventory color the legend's edit box

The pencil disc goes; the swatch shows the same quiet box on row hover
and the accent on its own hover, focus or open palette.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After the tasks

- [ ] Run `pixi run --locked test` once more and the browser check from Task 5, step 4.
- [ ] Ask Codex for a whole-branch review (`git diff main...feature/encoded-pmtiles`), focused on soundness and on further simplification or removal.
- [ ] Do not merge. The branch waits for the value-encoded Alps-wide release on Source Cooperative.
