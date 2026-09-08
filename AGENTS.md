# AGENTS.md

Implementation notes for glace-viewer: how the page is built, how to run it
locally, and the reasoning behind specific decisions. See [`README.md`](README.md)
for a human-facing overview.

## Preview locally

Python tooling is managed by [uv](https://docs.astral.sh/uv/). The repository
pins both uv and Python and commits `uv.lock`; `--locked` makes every command
fail rather than silently changing that environment. The inventory archives are
build outputs, so build them first:

```bash
uv run --locked python scripts/build-tiles.py  # data/*.geojson -> data/*.pmtiles
uv run --locked python scripts/serve.py        # -> http://localhost:8000/
```

`build-tiles.py` needs tippecanoe on `PATH`, or `--tippecanoe /path/to/binary`.
It is a C++ program; build it from https://github.com/felt/tippecanoe.

`http.server` cannot serve PMTiles — it ignores `Range` and returns whole files —
which is why `serve.py` exists. It also sets caching per file type: the page
shell is sent `no-store`, since a stale `js/app.js` leaves the page silently
rendering the previous version, while the archives are cached normally.

Open it as **`localhost`, not `127.0.0.1`**, even though `serve.py` binds the
latter by default — the basemap reads Protomaps' hosted API (see [Basemap and
terrain](#basemap-and-terrain)), and its CORS exemption for local development
matches the `localhost` hostname exactly, not the loopback IP: an origin of
`http://127.0.0.1:8000` gets no `Access-Control-Allow-Origin` header back at
all, and the basemap fails to load with no more specific error than that.
`serve.py` prints the URL as `localhost` for this reason.

The page reads the published store by default, so `http://localhost:8000/` shows
the real archives with nothing mounted locally — see [The published
store](#the-published-store).

To read a local build instead, `serve.py` mounts `./tiles` under `/tiles` and
`?tiles=` repoints the page at it:

```bash
ln -s <your glace-catalog build>/glace-store/2024/pmtiles tiles
# -> http://localhost:8000/?tiles=tiles
```

`tiles` is gitignored (no trailing slash in the pattern — git sees a symlink as a
file, so `tiles/` would not match it).

Any bucket the page is pointed at has to allow anonymous reads **and** send CORS
headers with `ExposeHeaders` for `Content-Range`, `Content-Length`,
`Accept-Ranges` and `ETag`. Without those the browser fetches the bytes but
refuses to let the PMTiles client read the range metadata, which fails looking
like a corrupt archive rather than a permissions problem. A COG read in the
browser needs the same headers, so the one rule covers both, and Source
Cooperative serves both.

`--tiles-dir` mounts any directory that holds a catalog — a `mosaics/` beside a
`tiles/` — which is how a build that is not the published store is looked at:

```bash
uv run --locked python scripts/serve.py --tiles-dir <a local build>
```

## Reading the catalog

**There is no `layers.json` any more.** The store retired it (glace-catalog
M-26): its writer is deleted, and every field it carried has a standard home
instead. `js/store.js` reads those homes and hands `js/rasters.js` one record per
archive — the shape the manifest used to arrive as. Three documents, each
answering one question:

| document | what it answers |
| --- | --- |
| `mosaics/collection.json` | which archives exist — one `rel: "pmtiles"` link each — and where the style and the per-year items are |
| the style it nominates | how each is drawn: ramp, stretch, unit, zooms |
| each year's `item.json` | the acquisition window under the ramp |

**The inventory comes from the collection, not from the style**, even though the
style declares sources of its own. The style asset describes itself as carrying
"every published web-map layer **of the most recent year**"; the collection lists
every archive of every year. Enumerating from the style would silently lose every
year but the newest the moment a second one is published.

The two are joined on **`pmtiles:layers`**, the style layer id each link names —
`glace-coh12_vv_qa_num-2024`, which carries the archive's stem and its year, and
which the page then uses as its own MapLibre layer id so the two cannot drift.
Where the style has no entry for a year, the layer falls back to the same stem in
whatever year it does describe: the stretch and the ramp are fixed per layer
rather than per year, deliberately, so [a real change between two years reads as
a change](#value-ranges-and-colour-maps).

**Bounds are declared nowhere.** They are in each archive's PMTiles header, and
`pmtiles.Protocol({metadata: true})` puts them in the TileJSON, so a source that
names none inherits the archive's — in a read the source was making anyway. The
same is true of the attribution, which is why neither is in the source spec.

`metadata.portolan:legend` is the store's **source of truth** for how a layer is
drawn — the build reads the same block to bake the archives — so this page keeps
no copy of a stretch, a ramp or a channel recipe. That includes the false
colour's three `{band, vmin, vmax}` entries, which the store publishes now
(P-18); `falseColourChannels()` already expected exactly that shape.

**The per-year attribution is read, never composed.** The style's sources carry
`University of Zurich, Contains modified Copernicus Sentinel data {year}`, and
each archive's header carries the same string; the page declares none and lets
MapLibre take the archive's. Recorded so a third copy is not re-added here.

## The published store

The archives live in [`lqgentner/glace-ch`](https://source.coop/lqgentner/glace-ch)
on Source Cooperative, and `site-config.js` points the page there. It is the
**Switzerland-only rehearsal build** — the full store's layout and machinery over
one scope, published to exercise both before the Alps dataset arrives. What
changes when that lands is the extent and the number of years, not the layout.

```
{root}/
├── catalog.json                        # STAC root: a tiles and a mosaics collection
├── tiles/
│   ├── collection.json
│   └── items.parquet                   # the grid's index — see The tile grid
└── mosaics/
    ├── collection.json                 # the rel="pmtiles" links this page enumerates
    ├── styles/default.json             # how each layer is drawn
    ├── 2024/
    │   ├── item.json                   # the year, its window and its COG assets
    │   └── coh12_vv.tif                # float32 LERC_ZSTD COG, ETRS89-LAEA 40 m
    └── pmtiles/2024/coh12_vv.pmtiles   # pre-styled RGBA, WebMercator z5-z13
```

Every layer is published twice under one stem. The page reads the `pmtiles/`
side of that pair for everything; the year directory beside it is what
[the COG reader](#the-cog-reader) would read if it were ever switched on.

**One field carries three different things.** The polarization half of a layer id
holds seven values, not three: `VV`, `VH`, `RGB`, and the four QA rasters
(`VV_QA_NUM`, `VV_QA_CQM` and their VH pair). So a polarization, a QA role and a
channel recipe share one field, and `js/rasters.js` splits it back into the two
rows a reader chooses from — the polarization, and the [quantity](#the-panel).
The split is a regex anchored to the two roles that exist, so an unrecognised
suffix stays part of the polarization and is dropped by the `POLARIZATIONS`
allowlist rather than becoming a fourth button nothing can draw. That drop is
*silent* — such a layer is correct and merely unpresentable here, not malformed,
so warning about each would be noise. All fourteen archives the store publishes
today reach the map.

**Nothing else in the store needs a product built for it.** The false colour is
the archive the store published, read like any other; the catalog tile grid is
read straight out of `tiles/items.parquet` ([The tile grid](#the-tile-grid)).
Neither needs a sidecar this repository has to keep in step with the catalogue.

## Tests

```bash
uv run --locked python -m unittest discover -s tests  # the two scripts
npm ci && npm test                                    # the page
```

`.github/workflows/test.yml` runs both on every pull request, and the deploy
workflow calls it before staging the site — so a red suite cannot reach Pages.
Both Python jobs install the pinned uv, select Python from `.python-version`,
and refuse a stale `uv.lock`. Neither suite builds anything: the Python side is
stdlib only, and the JavaScript side needs `jsdom` and nothing else.
**`node_modules` is development-only** — the page has no runtime dependencies
and nothing is ever bundled.

| file | covers |
| --- | --- |
| `tests/test_serve.py` | range boundaries, suffix and invalid ranges, `/tiles` containment, cache headers |
| `tests/test_build_tiles.py` | inventory index validation |
| `tests/config.test.js` | the defaults -> `site-config.js` -> query precedence chain |
| `tests/store.test.js` | the catalog read: the collection/style join, per-layer validation, MGRS/UTM parsing |
| `tests/layers.test.js` | the layers arranged into the panel's axes, the legend's own text |
| `tests/ui.test.js` | status priority and keying, escaping in the credit popover |
| `tests/viewer.test.js` | the page end to end against a fake MapLibre |
| `tests/store-catalog.test.js` | the published store's own catalog, one year of it verbatim — the polarization split, the QA rasters, the false-colour legend |
| `tests/cog-rgb.test.js` | the `glace-rgb://` protocol, driven directly |
| `tests/tile-grid.test.js` | the tile grid, read from the stac-geoparquet index |
| `tests/viewer-degraded.test.js` | the page with no reachable catalog |
| `tests/page-assets.test.js` | every local `src`/`href` in `index.html` exists, and `deploy.yml` stages the directory it is in |

The path and range cases are written to a socket by hand: `http.client` and
`curl` both normalise `a/../b` before sending it, which is the case under test.

`tests/helpers/browser.js` supplies a jsdom document and a fake MapLibre. The
fake is deliberately strict — adding a layer twice, naming a source that does
not exist, or setting a property on a layer that was never added all throw —
because MapLibre answers each of those with a console warning the page would
otherwise sail past.

**No test reads `./tiles`.** `viewer.test.js` runs against
`tests/fixtures/two-years/` and `store-catalog.test.js` against one year of the
published catalog verbatim, so both cover the same ground in CI as they do
locally, and mounting a local build changes no result. The first fixture holds
one combination built for only one of its two years, which is what makes the
disabled-button and no-layer-for-this-year paths reachable — and its style
describes only the newer year, as the store's does, so the fallback that draws an
older year through the same constants is exercised by every run.

The store fixture is verbatim but for the item's geometry, which is half a
megabyte of outline the page never reads.

`store-catalog.test.js` runs the page against a second catalog, and is a
separate file rather than another subtest for that reason: the modules hold
state at module scope and the map is a singleton, so a second catalog needs a
second process, which `node --test` gives each file.

`cog-rgb.test.js` no longer goes through the panel — nothing there produces a
`glace-rgb://` source, since [no layer uses one](#the-cog-reader) — so it drives the
protocol directly, through the same `setRecipe` + `recipeTiles` pair a source
spec would use. The recipes are written out rather than derived, but their
numbers come from the store fixture, so a stretch or a colour ramp changing
upstream is still visible here. Keeping it is the point: kept code that nothing
exercises is how it stops working quietly.

## Deploy

`.github/workflows/deploy.yml` publishes to GitHub Pages on every push to
`main`. It builds tippecanoe from source (pinned by `TIPPECANOE_VERSION`, cached
between runs), runs the tile builder through `uv run --locked`, converts
`data/*.geojson` to archives, and uploads only the archives — never the GeoJSON
they came from, which would double what a visitor could download for nothing.

Set **Settings -> Pages -> Source** to **GitHub Actions**, not "Deploy from a
branch". The branch option publishes the repository as-is, which serves the
committed `data/*.geojson` and none of the `.pmtiles` the page actually loads —
the site comes up with every overlay 404ing.

Until the GLACE archives are published, the deployed page has no `tiles/`, so
the mosaics collection 404s and the raster controls hide themselves. The basemap, the
terrain hillshade and the three inventories all still work; point `?tiles=` at
object storage to get the rest.

## Glacier inventory overlays

Three inventories ship with the page, each toggled independently and fetched only
when first enabled:

| id | inventory | features |
| --- | --- | --- |
| `sgi2016` | Swiss Glacier Inventory 2016 (2013–2018) | 1,400 |
| `sgi2023` | Swiss Glacier Inventory 2023 (2021–2024) | 1,299 |
| `pauletal2020` | Alpine Glacier Inventory (2015–2017) | 4,395 |

They are third-party datasets, redistributed here in simplified form purely so
the map has something to compare the imagery against. Each carries its own
attribution, citation and licence in `data/inventories.json`, shown behind the
info mark beside its toggle in the panel. All three are CC BY 4.0. The MIT
licence in this repository covers the viewer code, not the inventory data.

Each feature keeps `name` and `year` (plus `glacier_nr` for Paul et al., which
ships no names); coordinates are simplified to 10 m in EPSG:3035 and rounded to
five decimals. Note that tippecanoe drops null properties, so an unnamed feature
has no `name` key at all rather than a null one — the viewer's fallback covers
both.

`inventories.json` records the `source_layer` each archive is built with (the
inventory id), which the viewer passes to MapLibre as `source-layer`. A vector
layer whose `source-layer` does not match renders nothing and reports no error.

To regenerate the GeoJSON, run `scripts/stac/export-inventories.py` in
deep-glacier-mapping — it needs that repository's dataset classes.


### Why vector PMTiles and not GeoJSON

Building all three with tippecanoe (`-Z4 -z14`, one layer per archive) against
shipping them as gzipped GeoJSON:

| | on disk | initial view (z6, whole Alps) | z8, whole Alps |
| --- | --- | --- | --- |
| GeoJSON, gzipped | 2.5 MB | 2.5 MB (all of it) | 2.5 MB |
| vector PMTiles | 8.8 MB | **0.14 MB** | 0.43 MB |

So it is not a storage saving — the opposite. The pyramid stores each geometry at
eleven zoom levels, and even with tiles gzipped internally the archives come to
3.5x the gzipped GeoJSON. Lowering the maximum zoom is the lever if that matters:
z12 costs 4.8 MB and z13 6.4 MB, against 8.8 MB at z14.

What it buys is transfer and latency. The opening view pulls **141 kB instead of
2.5 MB**, and nothing is parsed up front, so an overlay appears as its first
tiles land rather than after the whole inventory has been fetched. That
responsiveness is why the overlays ship this way.

It is also why the GeoJSON is what gets committed and the archives are built.
Measured over two commits, with 5 % of features re-mapped between them:

| committed as | first commit | second commit adds |
| --- | --- | --- |
| GeoJSON | 2,544 kB | **144 kB** |
| PMTiles | 8,300 kB | 7,228 kB |

Git zlib-compresses text on the way in and then deltas it against the previous
version, so the 95 % of untouched features cost almost nothing. A gzipped archive
avalanches on any change and stores a whole fresh copy — 50x more per update, and
`git diff` can say nothing about it beyond "binary files differ".


## Design notes

### Page structure

No build step and no framework: `index.html`, `style.css` and native ES modules
under `js/`, loaded straight by the browser.

| module | owns |
| --- | --- |
| `config.js` | resolves the settings below into archive locations and endpoints |
| `map.js` | the map, layer ordering, basemap labels, hillshade, 3D terrain |
| `store.js` | the published catalog: the collection, its style and its items -> one record per archive |
| `rasters.js` | layer selection, the panel's axes, legend |
| `cog-rgb.js` | the `glace-rgb://` protocol: COG layers, one archive or two — [unused by the page](#the-cog-reader), still wired up |
| `tile-grid.js` | the catalog grid, read from the store's geoparquet index |
| `overlays.js` | glacier inventories, catalog tile grid, popups |
| `ui.js` | status line, attribution popovers, safe DOM helpers |
| `app.js` | control wiring and startup |

Nothing on the map is created until something asks for it: a raster source
appears the first time its year is selected, the DEM the first time either the
hillshade or 3D is switched on, an inventory the first time its box is ticked. Every control is
wired before anything has loaded and every handler that touches the map awaits
`style.load`, so a box ticked while the basemap is still streaming is honoured
when the style arrives rather than dropped.

Anything that reaches the page from the catalog or a vector tile — a glacier
name, a citation, a licence link — is built as DOM nodes rather than as an HTML
string, so a value containing markup stays a value.

### Wordmark and icons

`assets/` holds the brand files, and the deploy stages the whole directory. Every
path to them is relative — the icon links, and the manifest's `start_url`,
`scope` and icon `src`s — because a Pages project site is served from a subpath.

**The wordmark's glyphs are outlines, not text.** The file it came from set
`font-family: Coiny` on a `<text>` element, and an `<img>` renders in an isolated
document that loads none of the page's fonts, so that version came back in
whatever the browser fell back to. To redraw it after a wordmark change, take
[Coiny](https://fonts.google.com/specimen/Coiny) (SIL OFL 1.1) and run the glyphs
through a `fontTools` `SVGPathPen`. Two things the file depends on: the `viewBox`
is cropped to the ink, so the CSS height is cap height and there is no invisible
padding to align around; and the gradient is `userSpaceOnUse`, so its
`gradientTransform` moves with any change to that `viewBox` origin.

The PNG wordmark that shipped beside it is **not kept** — it is opaque white with
no alpha, so on the dark panel it would draw its own white box.

| kept | read by |
| --- | --- |
| `favicon.ico` | every desktop tab — it carries 16, 32 and 48 px in the one file |
| `apple-touch-icon.png` | iOS home screen, at 180 px |
| `site.webmanifest` + `icon-192.png`, `icon-512.png` | Android add-to-home-screen, and nothing else |

`favicon-16x16.png` and `favicon-32x32.png` came from the generator too and are
**dropped**: the `.ico` carries both sizes already. The manifest is what earns
the two large icons their place — without it nothing fetches them — and the
generator's copy needed its empty `name`, absolute paths and white theme colours
replaced. `serve.py` maps `.webmanifest`, which `mimetypes` does not.

### The panel

Top to bottom: the raster controls (product, quantity, polarization, year,
opacity, the colour ramp and the description of what is selected), then the
glacier inventories, then **Map options** — basemap, hillshade, catalog tile grid
and basemap labels. The last two sections are collapsed by default, and the panel
is shorter without them.

"Map options" rather than "Additional layers" because not every control adds a
layer: the basemap labels toggle is a visibility switch on the basemap that is
already drawn.

The panel names products the way a reader would rather than the way the archives
are named — `COH12` reads as **Coherence**, `RTC` as **Backscatter** — while
`data-value` keeps the catalog's own spelling, so nothing downstream has to
translate back. A product with no entry in `PRODUCT_LABELS` falls back to its own
name rather than vanishing.

The polarization axis is **derived from the layers and sorted**, not taken as
declared: the field the catalog spells them in mixes polarizations, QA roles
and the channel recipe into one field (see [The published
store](#the-published-store)), and the panel spends that field on two rows. So
VV is the left-hand button and the one the page opens on whatever order the file
used. The opening selection is the head of each ordered axis with the newest
year, falling back to a combination that has an archive if that one does not.

**Layer** is the second of those two rows: the measurement itself, or one of the
two QA rasters the store publishes beside it. It is `quantity` in the code and
in the DOM ids, which is what it selects — the label is the reader's word for it,
not the axis's name.

| button | layer id | what it is |
| --- | --- | --- |
| Data | no suffix | the coherence or backscatter composite |
| QA: Count | `_QA_NUM` | the number of observations contributing to each pixel |
| QA: Quality | `_QA_CQM` | the composite quality map, on a sequential −3…3 dB ramp, where higher is better |

What either quantity *is* is deep-glacier-mapping's to define and document; this
page only has to name it and say which way is better.

The faces are short because the row is three wide in a 292px panel, which leaves
about eleven characters a button — `Measurement` alone overruns it. The full
names ride on the buttons' tooltips and, at length, under the ramp. The row
**hides itself when the catalog carries only one quantity**, as every build
before the QA rasters does; one button is not a choice.

**The false colour and the QA rasters exclude each other**, and the two rows
resolve it between them. There is no `RGB_QA_NUM` and no QA false colour in the
store, so each choice greys the other's buttons — but the click is still
accepted. The clicked button always wins, and the row that cannot follow falls
back to the leftmost of its values that can: press RGB while a QA raster is
shown and **Layer** returns to Data; press a QA button while the false colour is
shown and the polarization returns to VV.

So grey means two things, told apart by whether the click is refused:

| | marked | click |
| --- | --- | --- |
| a combination that cannot exist | `aria-disabled` | accepted; the other row moves |
| a year with no archive for this one | `disabled` | refused |

The second has nothing to move — the only thing that would rescue it is a
different year, and that is the reader's call, not the panel's. `GIVES_WAY` in
`js/rasters.js` is the whole rule, and it deliberately has no entry for the
product row for exactly this reason.

Under the ramp sits the description of the selected layer:

```
Composite Coherence                 Composite quality map (higher is better)
12-day baseline                     2024-07-09 to 2024-10-07
Local resolution weighted median
2023-06-01 to 2023-09-30
```

For a measurement the first two lines are per product — the qualifier gets its
own line because at this width it wraps anyway — and the third is how every GLACE
layer is composited. A QA raster is **one line and its window**: neither is a
composite of the measurement, so neither takes the compositing line, and the
name plus which way is better is all the panel has to say.

The window comes from the year's STAC item, as the date halves of its
`start_datetime` and `end_datetime`, and the line is skipped when the item could
not be read. Like `cmap` it is descriptive rather than structural, so a year
whose item 404s loses the line and keeps its layers. Upstream, the composite records the window as
`COMPOSITE_START_DATE` / `COMPOSITE_END_DATE` GeoTIFF tags; `build_overview`
carries them onto the 40 m mosaic (which is written from merged arrays, so
nothing survives unless it is passed through), and the mosaic's STAC item
publishes them as `start_datetime` / `end_datetime` — which is where
`js/store.js` reads them.

### The false-colour legend

The false colour has no ramp: three channels, each carrying a different
measurement. The legend names them and, where it can, the stretch each was baked
with.

**Those numbers are the build's, and this page holds no copy.** The style
carries them under `metadata.portolan:legend` as `type: "channels"` — three
objects in red, green, blue order:

```json
"channels": [
  { "band": "RTC VV", "vmin": -18.5, "vmax": -5 },
  { "band": "RTC VH", "vmin": -26, "vmax": -11 },
  { "band": "VV − VH", "vmin": 4, "vmax": 14 }
]
```

Validated like everything else that arrives from the catalog, and descriptive
rather than structural: an unusable one costs the layer its numbers and not its
place on the map, and is dropped silently, since nothing is wrong with the layer.
It is also why a false-colour layer is the one that may reach the map with no
stretch and no stops at all — [`js/store.js`](#reading-the-catalog) requires a
ramp of every other layer and none of this one.

**Where a store publishes no such key** the legend names the bands and quotes no
range. Red and green are the two polarizations; blue is their ratio, written as a
difference wherever the layer is read in dB and a quotient otherwise — read off
the layer's own `units` rather than from a table keyed on the product, so there
is no per-product constant here to fall out of step.

What is *not* done is inference, and the reason is worth keeping now that it is
moot. Red and green could be lifted from the sibling VV and VH entries, whose
stretches are equal to the build's — checked against the published style, both
products. But that is a convention nothing enforces, and blue is recoverable from
nothing at all. Nor is there anything in the archive to fall back on — measured,
a PMTiles metadata block holds `name`, `type`, `description`, `writer`,
`attribution` and `tileSize`, for the single-band layers as much as the false
colour. The legend's numbers have always come from beside the tiles, never from
them.

The `SCALE` heading carries an info mark with the colour map's credit, rebuilt
only when the map actually changes — the button owns a hover popover, and
replacing it under the pointer would drop the box being read.

### Small screens

Below 640px the panel is capped at 46% of the viewport, which still leaves it
covering most of a phone. So on a narrow viewport it opens **collapsed to its
title bar** and a tap on the chevron opens it; wide viewports open expanded, and
can be collapsed by hand. Crossing the breakpoint — a rotation, usually —
re-applies the default for the new width rather than carrying over a choice made
for a different screen.

It also stops 52px short of the right edge rather than running the full width. A
MapLibre control group is 29px wide inside a 10px margin, so a panel reaching the
edge sits on top of the zoom buttons and the 3D toggle.

At the bottom it stops **52px** short rather than the 12px it keeps at the top,
which is the room the **scale bar** needs in the corner underneath: a MapLibre
control's 10px margin plus the ~20px the bar is. Left symmetric, a viewport short
enough for the panel to fill hands it the whole left edge and the scale sits
behind it — a short desktop window as much as a phone. The 40px is only ever
taken from a panel that had more height than it could fill, so the alternative —
moving the scale to the bottom-right, above the attribution — buys nothing and
crowds that corner. `js/map.js` and this cap have to agree.

**The header does not scroll.** `#panel` is a flex column that clips, and
`#panel-body` is what has `overflow-y: auto` — so the wordmark and the collapse
button stay put however long the controls run. When the panel itself scrolled,
a viewport short enough to overflow it carried the collapse button off the top,
and there was then no way to get the map back.

**The scrollbar lives in the panel's padding, and is always reserved.** A
scrollbar takes its width out of the scroll container's content box, so the
controls reflowed narrower the moment there was anything to scroll — and back
again when there was not. The fix is to move the horizontal padding off `#panel`
and onto `#panel-body`: negative margins stretch the body across the panel's
full inner width, `padding-left: 16px` puts the controls back where they were,
and `scrollbar-gutter: stable` reserves the matching 16px on the right whether
or not the bar is showing. The content column is 258px either way.

It stays a **native** scrollbar, so the OS keeps its sizing, click-and-drag and
reduced-motion behaviour, which a div-and-JS reimplementation gives up. It is
styled twice, because no one declaration reaches both engines: Blink and WebKit
stop honouring `::-webkit-scrollbar` the moment either standard property is set,
so `@supports selector(::-webkit-scrollbar)` splits them. Firefox takes
`scrollbar-width: thin` with `scrollbar-color`, where the gutter is whatever
`thin` is (~11px) and `padding-right: 5px` makes up the rest of the 16. Blink and
WebKit take the pseudo-elements, which are the only way to set the **gutter's own
width** — 16px of it carrying a 6px thumb, which is what centres the bar in the
padding rather than leaving it against the border. Either way the column comes
out at 258px.

**A scroll container clips at its padding box, not its content box**, which is
what the body's left padding is for beyond symmetry: it gives the checkboxes'
focus rings somewhere to be drawn. The same rule is why the sliders were briefly
cut off — `input[type="range"]` carries a UA `margin: 2px` that sits outside its
`width: 100%`, and the overhang was invisible only while `#panel`'s own padding
was absorbing it. It is reset now, as the checkbox's already was.

**The collapsed state is a class on `#panel`, not `hidden` on the body**, and the
narrow default is a stylesheet rule rather than something the script applies.
`js/app.js` is a deferred module, so it runs after layout: setting `hidden` from
there showed the full-height panel for a frame before it snapped shut. CSS
collapses a narrow panel until `expanded` appears and expands a wide one until
`collapsed` does, and the script sets both classes explicitly so the state is
unambiguous on either side of the breakpoint. A test in
`tests/viewer-narrow.test.js` guards the stylesheet, since no DOM assertion can
see the frame that was the bug.

The breakpoint lives in two places that have to agree: the media query in
`style.css` and the `matchMedia` call in `js/app.js`. The collapse itself is the
same idiom as the glacier inventories section — a button carrying
`aria-expanded` and `aria-controls`, and one chevron glyph rotated by an `up`
class that marks the collapsed state.

### Configuration

Settings resolve in three layers, each overriding the one before:

1. the built-in defaults in `js/config.js`;
2. `site-config.js`, an optional file beside `index.html` that a deployment
   owns — the committed copy is an empty template;
3. the query parameters `?tiles=`, `?basemap=` and `?flavor=`.

```js
// site-config.js
window.GLACE_CONFIG = {
  tilesBase: "https://data.source.coop/your-org/glace",
  initialView: { center: [7.66, 45.98], zoom: 8 },
};
```

`site-config.js` is a plain script rather than another fetched JSON file on
purpose: repointing the archives must not introduce a second way for startup to
fail asynchronously. It is either loaded before the modules run or it is not.
`initialView` and `terrainCredit` merge key by key, so naming just `zoom` keeps
the default centre; an unrecognised key warns to the console rather than being
silently ignored. Only the three settings above are reachable from the address
bar — the rest are deployment decisions, not viewing ones.

What is deliberately *not* configurable: paint expressions, the click radius,
and DOM ids. Control defaults live in `index.html` (`value="100"` on opacity,
`value="55"` on hillshade strength) and are mirrored in the modules that own
that state.

The page always opens on `initialView` when the URL carries no `#hash` — it is
not re-framed to the data's own bounds once the catalog loads. A deployment
whose archives sit somewhere else should set `initialView` to match, the same
way this repository's own default points at the Aletsch Glacier
(`center: [8.03, 46.51], zoom: 10`) rather than the union of the whole store.

### Basemap and terrain

The vector basemap style is generated at runtime by `@protomaps/basemaps` (69 layers,
13 of them labels) rather than hand-written, so the flavor decides every colour.
`?flavor=` switches it (`grayscale`, `black`, `dark`, `light`, `white`) and
`?basemap=` points at a different tile endpoint. The default reads Protomaps'
[hosted API](https://protomaps.com/api) — a TileJSON document at
`api.protomaps.com/tiles/v4.json?key=…`, handed to MapLibre's vector source the
same way `TERRAIN_TILEJSON` is below, rather than a `pmtiles://` archive URL —
which is faster than the Source Cooperative mirror this replaced (edge-served,
not a range-read object) but ties the deployment to the API key baked into
`basemapUrl` in `js/config.js`. Rotate or scope that key from the Protomaps
dashboard rather than in code. Sprites and glyphs still come from the free
`basemaps-assets` GitHub mirror (`basemapAssets`), since the API does not serve
those.

The **Basemap** control replaces the vector fills with Esri World Imagery, read
directly from its 256 px XYZ endpoint. It is created lazily, so it costs no
request until selected; switching back restores the generated vector style
without rebuilding the map or discarding any data layers.

Data layers are inserted below the basemap's first symbol layer, so labels stay
readable on either background. The "Basemap labels" checkbox hides just those
symbol layers and is independent of the background choice.

### Draw order

Bottom to top: vector basemap fills or World Imagery, GLACE rasters, hillshade, vector overlays (glacier
inventories, catalog tile grid), basemap labels.

Everything above the basemap is created lazily, the first time its control is
switched on, so the layers arrive in whatever order the reader clicks. "Whichever
was added last ends up on top" is therefore not a stacking rule: shaded relief
has to sit over the data whether the box was ticked before or after a year was
chosen, and glacier outlines have to sit over the relief. So each layer declares
its kind to `addStacked()` in `js/map.js` and is inserted before the lowest layer
already present that must stay above it, falling through to the basemap's first
symbol layer — which is what keeps the labels on top of all of it.

The Mapterhorn terrain is the only layer that is *not* a PMTiles archive, which
is deliberate. Mapterhorn publishes PMTiles as well, but the split does not suit
a web map: `planet.pmtiles` stops at z12 while the viewer opens to z14, and
everything above z12 lives in one archive per z6 tile (the Alps ones are several
hundred GB each), so a PMTiles hillshade needs a custom protocol that routes by
zoom across archives — which is what [Mapterhorn's own PMTiles example](https://github.com/mapterhorn/mapterhorn/blob/main/website/examples/pmtiles/example.html)
does. Worse, their download server answers range requests uncached
(`cf-cache-status: DYNAMIC`, no `Cache-Control`), while `tiles.mapterhorn.com`
is edge-cached for a week and measurably faster. The endpoint is the path they
maintain for live map serving; the archives are for bulk extracts.

One `raster-dem` source feeds both the shaded relief and the 3D mesh, so
whichever is switched on first pays for the tilejson and the tiles and the other
rides along.

The hillshade is optional (checkbox) and sits above the data but below the
labels. **MapLibre has no layer blend modes**, so a literal `multiply` is not
available; the equivalent for shaded relief is a hillshade with fully transparent
highlights and black shadows — lit slopes leave the data untouched and shaded
slopes darken it, which is what multiplying by a shading layer does. There is no
`hillshade-opacity` property either, so the strength slider drives the alpha of
the shadow and accent colours.

Every colour in that paint is neutral. Shading in a hue of its own would shift
the colour map underneath it — a warm shadow over `cmc.lipari` is no longer
`cmc.lipari` — so the relief moves lightness only and leaves the ramp's hue
where the build put it. A test asserts it rather than trusting the constants.

### 3D

The **3D** button sits under the navigation control, top right, and reads as
what the next press does — `3D` while the map is flat, `2D` once it is tilted.
It is not MapLibre's `TerrainControl`, which draws a mountain glyph and only
flips `setTerrain`; this one carries a text label and moves the camera too,
easing to 60° on and back to 0° off, so the button reads as a view mode rather
than a data toggle. 60° is MapLibre's default `maxPitch`, so the slant needs no
raised limit on the map.

The hillshade is left alone when 3D comes on. Shaded relief over terrain is the
normal pairing — [MapLibre's own 3D terrain example](https://maplibre.org/maplibre-gl-js/docs/examples/3d-terrain)
runs both off one DEM — and unticking a box the reader ticked would be a
surprise worth avoiding; the strength slider is there if the combination reads
too dark.

Pitch is part of the `#hash`, so a link copied while tilted comes back tilted.
Terrain is not, so the page switches it back on at startup when the incoming
pitch is non-zero — without moving the camera, since easing to 60° would round
every shared link off to the same view.


### Globe

The style sets `projection: { type: "globe" }`, which MapLibre 5 expands into a
zoom interpolation rather than a permanent globe: `vertical-perspective` at z11,
`mercator` from z12, blended between. So the earth is round while the whole arc
is in view and flat by the time anyone is reading a glacier. The page opens
around z6, inside the round part.

It costs the 3D button nothing — the shaders carry combined `GLOBE`/`TERRAIN3D`
paths, so terrain renders under either projection. Two MapLibre features are not
supported on a globe: fog matrices, which this style does not use, and easing
around a point, which downgrades zoom-toward-the-cursor to zoom-toward-the-centre
while the globe is on screen.

### Attribution

The line in the bottom-right corner is MapLibre's own `AttributionControl`, fed
from the `attribution` field of each source. That is what makes it conditional
for free: MapLibre credits a source only while a visible layer is using it, or —
for the DEM — while it is carrying the terrain. So

- **Copernicus** appears only when a GLACE raster is on screen, worded by the
  archive itself and per year, because every year is its own archive;
- **Mapterhorn** appears when the hillshade is ticked *or* 3D is on, and goes
  away when both are off;
- **OpenStreetMap and Protomaps** ride on the basemap source, and are replaced by
  **Esri** when World Imagery is showing;
- **MapLibre** is always shown, and is the one credit that hangs off no source at
  all.

Those first two share one string on purpose. MapLibre sorts attributions by
**string length** before joining them with `|`, so two separate entries would be
scattered through the line at lengths nobody controls, while one entry keeps its
own internal order. The same sort is why Mapterhorn prints ahead of Copernicus:
its string is shorter. Ordering the line by hand would mean replacing the control
rather than configuring it.

**The renderer's credit is `customAttribution` on the control**, not a field on a
basemap source. It used to ride in both basemap sources' strings, on the reasoning
that one basemap or the other is always present — but a source is handed its
`attribution` only when its **TileJSON resolves**, so every credit riding on one
is conditional on that request succeeding. A blocked basemap request therefore
took the renderer's credit down with the basemap's, which is not what it is
conditional on: MapLibre is drawing either way. On the control it is unconditional
by construction. Being the shortest entry, it now sorts to the front of the line.

#### Where each string comes from

A source given a `url:` inherits its attribution from the TileJSON at the other
end unless the spec names one: MapLibre resolves it as
`pick(extend(tileJSON, options), [… "attribution" …])`, so **the spec wins**.
Declaring one here overrides the publisher rather than adding to them, which is
why only two are declared.

Note where that expression sits: the spec's own string is applied *inside* the
TileJSON resolution, so a source whose TileJSON never loads gets no attribution
even though the page declared one. That is why the basemap's two credits both
vanish together when Protomaps' API is unreachable — opening the page on
`127.0.0.1` rather than `localhost` does it, see [Preview
locally](#preview-locally) — and why the renderer's credit does not ride there.

| source | declared here | why |
| --- | --- | --- |
| GLACE archives | **no** | each archive carries its own, and `pmtiles.Protocol({metadata: true})` is what puts it in the TileJSON — one 167 B read per archive. Still per year, since each year is its own archive |
| Mapterhorn DEM | **no** | its TileJSON already carries `© Mapterhorn` with the same link |
| Protomaps basemap | yes | its TileJSON credits **OpenStreetMap only**, and the spec replaces rather than appends, so Protomaps has to be declared alongside it — which is also what keeps their order |
| World Imagery | yes | a `tiles:` template, so there is no TileJSON to inherit from |

The cost is that a publisher can stop crediting itself and nothing here would
notice. For the DEM that is covered: `terrainCredit` repeats the same credit
behind the info mark beside the hillshade toggle, out of configuration.

Per-layer credits are a separate thing — see the info marks in the panel, which
carry each inventory's citation and licence.

### Value ranges and colour maps

The stretch and ramp of every layer are **baked into its archive** at build time
and published in the catalog's MapLibre style,
`mosaics/styles/default.json`, under each layer's
`metadata.portolan:legend`. That file is the catalog's single source of truth:
the build reads it to make its lookup tables, and this page reads it to draw the
legend rather than keeping a copy — see [Reading the
catalog](#reading-the-catalog).

| layer | range | colour map |
| --- | --- | --- |
| COH12 VV | `[0.10, 0.80]` | `cmc.lipari` |
| COH12 VH | `[0.10, 0.60]` | `cmc.lipari` |
| RTC VV | `[-18.5, -5]` dB | `cmc.grayC` |
| RTC VH | `[-26, -11]` dB | `cmc.grayC` |
| QA-NUM, all four | `[0, 70]` | `cmc.turku` |
| QA-CQM, all four | `[-3, 3]` dB | `cmc.glasgow` |
| false colour | three channels, see the legend section | — |

The ramps are Crameri's perceptually uniform scientific colour maps, registered
with matplotlib under `cmc.*`. A neutral ramp for backscatter leaves hue for the
quantities that use it.

**Ranges are fixed per layer on purpose.** A per-year percentile stretch would
give every year its own scale, so a real change in coherence between two years
would show up as no visible change at all. That is also why QA-NUM spans 0–70
rather than the observed 26–30 of recent years: 2021 reaches 58, because S1B was
still flying, and one ceiling for every year and both products is what keeps the
difference legible.

The legend records **17 colour stops** per layer. The page interpolates linearly
in sRGB between them, which at nine stops drifted up to 8/255 from the true ramp
— visible as a tonal shift through lipari's warm midrange. Seventeen keeps it
under 4/255.

### Missing tiles

A raster PMTiles archive stores no tile where the image is blank, and the
archives are sparse: their bounds are one rectangle over a sparse set of MGRS
tiles, so a good fraction of the tiles inside that rectangle do not exist. In
the Alps build, 12 of 36 sampled z11 tiles are absent; in the Aletsch study
block, 5 of the 25 z11 tiles covering it.

`pmtiles.Protocol` answers for those with `data: null`, and MapLibre's
`RasterTileSource.loadTile` sets `tile.state = 'loaded'` only inside
`if (response && response.data)` — with no else. A missing tile is therefore
left in `loading` for ever: never drawn, never retried, and the coarser parent
stays magnified in its place. It reads as patches near the edge of the data that
never sharpen however far you zoom in, and it also means `map.on('idle')` can
never fire while such a tile is on screen.

`js/map.js` wraps the protocol and answers a missing raster tile with a single
transparent pixel instead, which says what the absence means and lets MapLibre
finish the tile. Vector archives are passed through untouched — for those the
protocol already returns an empty buffer rather than null, so the tile grid was
never affected. `errorOnMissingTile` does not help here: the protocol consults
it only for vector tiles.

### The COG reader

**Nothing on the page reads a COG.** `js/cog-rgb.js` and its `glace-rgb://`
protocol are registered in `js/map.js` and exercised by `tests/cog-rgb.test.js`,
but no source uses them: every layer is drawn from its pre-styled PMTiles
archive. The reader is kept because it is the only path by which this page could
read a pixel *value*, and reopening the question is a source spec away — register
a recipe with `setRecipe(id, …)` and hand `recipeTiles(id)` to a raster source's
`tiles`.

**Its premise does not hold against the mosaics the catalog publishes.** What
made it cheap is a source on the same WebMercatorQuad grid as the XYZ tiles, so
that a tile is an integer window read out of each file and a per-pixel combine,
never a reprojection. The published mosaics are ETRS89-LAEA 40 m (M-24), which is
the right CRS for what they are for — analysis and area statistics — and no
oversight to correct. The catalog ships **no COG for web display at all**; the
PMTiles archives are that product.

**It is kept anyway, deliberately.** The reader is the path by which this page
would draw web-mercator COGs should they ever replace the pre-styled archives,
and it costs the page almost nothing to keep: one 15 kB module parsed at startup,
one entry in MapLibre's protocol map, and no network at all — both
`@developmentseed/geotiff` and `lerc` are dynamic imports on first use, and
nothing asks. Retiring it would be a `git revert` away from returning either way;
the tests below are what keep it from rotting in the meantime.

Two things it is worth knowing about it:

- **The reader is `@developmentseed/geotiff`**, not geotiff.js. It is ESM-only
  with bare specifiers and no UMD build, so it cannot be a `<script>` tag; it is
  imported from a CDN on first use, pinned in `js/config.js`. geotiff.js batches
  range reads into 64 kB blocks, which on these files costs several times the
  bytes for the same tile.
- **LERC's validity mask is discarded by every reader tried**, so a nodata pixel
  arrives as a plain `0` rather than NaN. `js/cog-rgb.js` therefore treats an
  exact zero as absent. That is measured, not assumed: decoding the 2024 COH12 VV
  and RTC VV mosaics with `lerc` directly gives both the pixels and the mask, and
  over 15.3 million pixels the sentinel is not an approximation of the mask — it
  is the same partition, with no valid pixel landing on exactly zero (the closest
  is 0.0038). This belongs here rather than in the archives: a NaN nodata is a
  correct GeoTIFF, and the store should not carry a redundant validity band to
  work around a browser decoder.

**The stored value is not the plotted one.** Every COG in the store is linear,
while the stretches are quoted in dB, so the COG path has to convert per pixel
or the two sources draw different pictures. Read raw, the 2024 RTC VV mosaic runs
0.0038 to 24.8 in linear power against a published stretch of −18.5 to −5, and
the whole layer draws as one flat block.

### The tile grid

**Catalog tile grid** in the map options draws the MGRS footprints the store is
built on, shaded by how much of each the glacier inventory covers. It used to be
a vector PMTiles archive built beside the rasters; the store does not publish
one, and does not need to. What it publishes is `tiles/items.parquet`, the
stac-geoparquet mirror of every tile Item, which already carries the footprint
and both glacier fractions.

**js/tile-grid.js** reads it with [hyparquet](https://github.com/hyparam/hyparquet),
which needs no server: parquet is column-major, so four columns of the ~200 the
index carries are four small byte ranges. hyparquet also reads the geoparquet
metadata and hands geometry back already decoded from WKB, so there is no binary
parsing here to get wrong.

The index holds one Item per (tile, year) — 572 rows over four years — and a
footprint is a footprint, so the repeats collapse to **143 features**, which is
exactly the perimeter the scope claims. Measured against the live store: 549 ms
end to end. The properties keep the names the old archive used, so the paint
expressions and the popup did not change with the source.

#### What it costs

Measured against the live store, cold, five runs:

| | |
| --- | --- |
| total | **~230-420 ms**, 6 requests, 330 kB |
| decoding the four columns | **5 ms** (all ~200 columns: 293 ms) |
| the four column chunks | **9 kB** of the 200 kB of column data |
| the footer | **321 kB** — the whole file |

**The parsing is not the cost.** Decoding is 5 ms of it; the rest is one fetch.
Projecting four columns is still what makes that 5 ms rather than 293 ms, and it
does fetch exactly the 9 kB of column data it needs — but it does not save the
file. This index's footer is ~121 kB, because ~200 columns of STAC metadata
carry that much schema and statistics, and hyparquet reads generously to locate
it rather than pay a second round trip. Asking it to read a smaller footer first
was measured and changes nothing: the request comes back as the whole 321 kB
either way. On the Alps store, where the data dwarfs the footer, the projection
will save bytes as well as time.

**Nothing recurs.** It is paid once, when the box is first ticked, and the
result is handed to MapLibre as a GeoJSON source — so panning and zooming
afterwards cost nothing, where the archive this replaced fetched tiles per
viewport for as long as the overlay was on. Over a session it is the cheaper of
the two, and 143 polygons is nothing for MapLibre to draw.

Two things this settles beyond the grid itself:

- **No sidecar to keep in step.** The grid cannot disagree with the catalogue,
  because it *is* the catalogue.
- **The index is now reachable from the page**, which is what any later
  filtering — by glacier fraction, by year, by UTM zone — would be built on. The
  columns are there; only the controls are not.

The store's index is SNAPPY, which hyparquet decodes on its own, so there is no
companion codec package. One written with ZSTD pages would need
`hyparquet-compressors` beside it, and fails loudly rather than quietly: the
overlay unticks itself and reports what it could not read.

### Resampling

The archives are tiled from the composites with **`average`**, and the tiler
warps straight from the 10 m UTM composites onto the WebMercatorQuad grid at
z13. That is one resampling, not two.

It used to be two. The tiles came from a 40 m EPSG:3035 overview, so pixels went
10 m UTM → 40 m EPSG:3035 → WebMercator, and this file carried a long note
arguing that removing the second hop was a rework rather than a flag. **It was
done.** The catalog now writes its display product on the tile grid directly, at
which point the warp at maximum zoom is the identity and every level below it is
a clean 2× decimation — which is why the kernel is `average` rather than the
`bilinear` an oversampled source needed.

For the record, the tile codec is not the limiting factor: against a
PNG-lossless build of the same tile, WEBP at quality 80 reproduces its detail and
contrast almost exactly (mean |Laplacian| 9.49 vs 9.33, σ 46.7 vs 46.8) at about
a twelfth of the size.

One thing to know if the ranges are ever retuned: **percentiles must be measured
at native resolution.** A decimated read averages SAR speckle away and reports a
much narrower distribution than the max-zoom tiles are drawn from — for RTC VV
the 2–98 range narrows from ~14 dB to ~5 dB, and a stretch derived that way
clipped 13.6 % of the scene to a single flat colour.

### What the viewer shows

Product (COH12 / RTC), quantity (the measurement, or one of the two QA rasters),
polarization (VV / VH / false colour) and a year slider select one raster layer;
combinations with no archive are disabled rather than hidden. Layer opacity,
shaded relief, the basemap labels, the catalog tile grid and the glacier
inventories are independent of that choice and of each other. The map position
lives in the URL hash, so a view can be linked.

The rasters are *pre-styled RGBA* — the colour ramp is baked in at build time
and pixel values cannot be read back from the tiles. The legend reports the
stretch each layer was built with, which is the fixed range from the table
above. For quantitative work, go to the COGs the STAC items point at.

The **Layer** row is the one control whose presence depends on what was
published: it appears only where a QA raster is published beside the
measurement.
