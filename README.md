# glace-viewer

Quick-look web viewer for **GLACE** — resolution-weighted Sentinel-1 coherence
and backscatter composites of the European Alps.

Almost everything on the map is a PMTiles archive read straight from object
storage over HTTP range requests: the GLACE rasters, the
[Protomaps](https://protomaps.com) basemap and the glacier inventory overlays.
The [Mapterhorn](https://mapterhorn.com) terrain is the one exception and comes
from a tile endpoint — see [Basemap and terrain](#basemap-and-terrain). The page
is plain HTML/CSS/JS with no build step or framework.

| | source |
| --- | --- |
| GLACE rasters | the [`glace-ch` store](https://source.coop/lqgentner/glace-ch) on Source Cooperative, repointable with `?tiles=<base-url>` |
| Basemap | Protomaps vector tiles from [Source Cooperative](https://source.coop/), or Esri World Imagery |
| Terrain | Mapterhorn global DEM, terrarium-encoded, from their `{z}/{x}/{y}` endpoint |
| Glacier inventories | built from `data/*.geojson` in this repo |

The rasters are produced by [deep-glacier-mapping](https://github.com/lqgentner/deep-glacier-mapping),
which also exports the inventory GeoJSON here. This repository holds only the
page and its overlays.

## Preview locally

Python tooling is managed by [uv](https://docs.astral.sh/uv/). The repository
pins both uv and Python and commits `uv.lock`; `--locked` makes every command
fail rather than silently changing that environment. The inventory archives are
build outputs, so build them first:

```bash
uv run --locked python scripts/build-tiles.py  # data/*.geojson -> data/*.pmtiles
uv run --locked python scripts/serve.py        # -> http://127.0.0.1:8000/
```

`build-tiles.py` needs tippecanoe on `PATH`, or `--tippecanoe /path/to/binary`.
It is a C++ program; build it from https://github.com/felt/tippecanoe.

`http.server` cannot serve PMTiles — it ignores `Range` and returns whole files —
which is why `serve.py` exists. It also sets caching per file type: the page
shell is sent `no-store`, since a stale `js/app.js` leaves the page silently
rendering the previous version, while the archives are cached normally.

The page reads the published store by default, so `http://127.0.0.1:8000/` shows
the real archives with nothing mounted locally — see [The published
store](#the-published-store).

To read a local build instead, `serve.py` mounts `./tiles` under `/tiles` and
`?tiles=` repoints the page at it:

```bash
ln -s ../deep-glacier-mapping/cache/stac-dataloader/pmtiles tiles
# -> http://127.0.0.1:8000/?tiles=tiles
```

`tiles` is gitignored (no trailing slash in the pattern — git sees a symlink as a
file, so `tiles/` would not match it).

Any bucket the page is pointed at has to allow anonymous reads **and** send CORS
headers with `ExposeHeaders` for `Content-Range`, `Content-Length`,
`Accept-Ranges` and `ETag`. Without those the browser fetches the bytes but
refuses to let the PMTiles client read the range metadata, which fails looking
like a corrupt archive rather than a permissions problem. The COG source reads
the same way, so the same rule covers both, and Source Cooperative serves both.

`--tiles-dir` mounts any directory that holds a `layers.json`, which is how the
COG comparison below is looked at:

```bash
uv run --locked python scripts/serve.py --tiles-dir \
    ../deep-glacier-mapping/cache/stac-store-refactor/cog-study
```

## The published store

The archives live in [`lqgentner/glace-ch`](https://source.coop/lqgentner/glace-ch)
on Source Cooperative, and `site-config.js` points the page there. It is the
**Switzerland-only rehearsal build** — the full store's layout and machinery over
one scope, published to exercise both before the Alps dataset arrives. What
changes when that lands is the extent and the number of years, not the layout or
the manifest.

```
{root}/
├── layers.json                     # the only file this page reads
├── catalog.json                    # STAC root: a tiles and a mosaics collection
└── 2024/
    ├── mosaics/coh12_vv.tif        # float32 LERC_ZSTD COG, WebMercatorQuad z13
    └── pmtiles/coh12_vv.pmtiles    # pre-styled RGBA, z5-z13
```

Every layer is published twice under one stem, which is what the [Tile
source](#tile-source-pmtiles-or-cog) control switches between. Because the COG
grid *is* the tile grid at z13, the file's own overview levels land on z12, z11
and below, so no level costs the browser a resampling step.

**The QA diagnostics are deliberately not on the map.** The manifest's
`polarization` axis carries seven values, not three: `VV`, `VH`, `RGB`, and the
four QA layers (`VV_QA_NUM`, `VV_QA_CQM` and their VH pair). A polarization, a
QA role and a channel recipe share one field, and the panel has a row for the
first three only. `js/rasters.js` drops the rest against the `POLARIZATIONS`
allowlist, and does it *silently* — they are correct layers this page has no
control for, not malformed ones, so warning about each would be noise. Of the 56
entries the store publishes, 24 reach the map.

**Nothing else in the store needs a product built for it.** The false colour is
either the archive the store published or the two mosaics it was rendered from,
stacked in the browser ([Tile source](#tile-source-pmtiles-or-cog)); the catalog
tile grid is read straight out of `tiles.parquet` ([The tile
grid](#the-tile-grid)). Neither needs a sidecar this repository has to keep in
step with the catalogue.

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
| `tests/manifest.test.js` | `layers.json` validation, MGRS/UTM parsing |
| `tests/ui.test.js` | status priority and keying, escaping in the credit popover |
| `tests/viewer.test.js` | the page end to end against a fake MapLibre |
| `tests/cog-source.test.js` | the PMTiles/COG switch, against a manifest that offers both |
| `tests/store-manifest.test.js` | the published store's own `layers.json`, one year of it verbatim |
| `tests/cog-rgb.test.js` | the `glace-rgb://` protocol and the false-colour row |
| `tests/tile-grid.test.js` | the tile grid, read from the stac-geoparquet index |
| `tests/viewer-degraded.test.js` | the page with no reachable `layers.json` |

The path and range cases are written to a socket by hand: `http.client` and
`curl` both normalise `a/../b` before sending it, which is the case under test.

`tests/helpers/browser.js` supplies a jsdom document and a fake MapLibre. The
fake is deliberately strict — adding a layer twice, naming a source that does
not exist, or setting a property on a layer that was never added all throw —
because MapLibre answers each of those with a console warning the page would
otherwise sail past.

`viewer.test.js` runs against `tests/fixtures/layers.json` rather than a real
build, so it covers the same ground in CI as it does locally. The fixture holds
one combination that exists in only one of its two years, which is what makes
the disabled-button and no-layer-for-this-year paths reachable. The one case
that reads the real `tiles/layers.json` skips itself when the directory is
absent.

`cog-source.test.js` has its own fixture, `layers-cog.json`, in which COH12 VV
carries a `cog` and nothing else does — the arrangement that makes both the
disabled COG button and the fall back to PMTiles reachable. It is a separate
file rather than another subtest because the modules hold state at module scope
and the map is a singleton, so a second manifest needs a second process.

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
`layers.json` 404s and the raster controls hide themselves. The basemap, the
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
| `rasters.js` | the `layers.json` manifest, layer selection, legend |
| `cog-rgb.js` | the `glace-rgb://` protocol: COG layers, one archive or two |
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

Anything that reaches the page from a manifest or a vector tile — a glacier
name, a citation, a licence link — is built as DOM nodes rather than as an HTML
string, so a value containing markup stays a value.

### The panel

Top to bottom: the raster controls (product, polarization, year, opacity, the
colour ramp and the description of what is selected), then the glacier
inventories, then **Map options** — basemap, hillshade, catalog tile grid and
basemap labels. The last two sections are collapsed by default, and the panel is
shorter without them.

"Map options" rather than "Additional layers" because not every control adds a
layer: the basemap labels toggle is a visibility switch on the basemap that is
already drawn.

The panel names products the way a reader would rather than the way the archives
are named — `COH12` reads as **Coherence**, `RTC` as **Backscatter** — while
`data-value` keeps the manifest's own spelling, so nothing downstream has to
translate back. A product with no entry in `PRODUCT_LABELS` falls back to its own
name rather than vanishing.

The polarization axis is **sorted rather than taken as declared**, so VV is the
left-hand button and the one the page opens on; the manifest currently declares
`["VH", "VV"]`. The opening selection is the head of each ordered axis with the
newest year, falling back to a combination that has an archive if that one does
not.

Under the ramp sits the description of the selected layer:

```
Composite Coherence
12-day baseline
Local resolution weighted median
2023-06-01 to 2023-09-30
```

The first two lines are per product — the qualifier gets its own line because at
this width it wraps anyway — and the third is how every GLACE layer is
composited.

The window comes from `start_date` and `end_date` on the manifest entry, as
`YYYY-MM-DD`, and the line is skipped when they are absent or malformed. Like
`cmap` it is descriptive rather than structural, so `validLayer()` does not
reject a layer for missing it. Upstream, the composite records the window as
`COMPOSITE_START_DATE` / `COMPOSITE_END_DATE` GeoTIFF tags; `build_overview`
carries them onto the 40 m overview (which is written from merged arrays, so
nothing survives unless it is passed through) and `build_pmtiles` reads them
into the manifest.

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
DOM ids, and the `fitBounds` padding, which is `#panel`'s width from `style.css`
and would drift from it the moment it became a knob. Control defaults live in
`index.html` (`value="100"` on opacity, `value="55"` on hillshade strength) and
are mirrored in the modules that own that state.

### Basemap and terrain

The vector basemap style is generated at runtime by `@protomaps/basemaps` (69 layers,
13 of them labels) rather than hand-written, so the flavor decides every colour.
`?flavor=` switches it (`grayscale`, `black`, `dark`, `light`, `white`) and
`?basemap=` points at a different archive. The default reads Protomaps' daily
planet build from Source Cooperative, which serves `Access-Control-Allow-Origin: *`
and honours range requests, so it works cross-origin with no setup. Protomaps
discourage hot-linking their own `maps.protomaps.com` builds; the Source
Cooperative mirror is the sanctioned free option, and for production you would
copy an extract to your own storage.

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

- **Copernicus** appears only when a GLACE raster is on screen, and names that
  layer's year, because every year is its own source;
- **Mapterhorn** appears when the hillshade is ticked *or* 3D is on, and goes
  away when both are off;
- **OpenStreetMap, Protomaps and MapLibre** are always shown, riding on the
  basemap source, which is always present.

Those last three share one string on purpose. MapLibre sorts attributions by
**string length** before joining them with `|`, so three separate entries would
be scattered through the line at lengths nobody controls, while one entry keeps
its own internal order. The same sort is why Mapterhorn prints ahead of
Copernicus: its string is shorter. Ordering the line by hand would mean
replacing the control rather than configuring it.

Per-layer credits are a separate thing — see the info marks in the panel, which
carry each inventory's citation and licence.

### Value ranges and colour maps

`DEFAULT_STYLES` in deep-glacier-mapping's `glacier_mapping/webmap.py` pins a
**fixed** range per (product, polarization), baked into the archives at build
time:

| layer | range | colour map |
| --- | --- | --- |
| COH12 VV | `[0.10, 0.80]` | `cmc.lipari` |
| COH12 VH | `[0.10, 0.60]` | `cmc.lipari` |
| RTC VV | `[-18.5, -5]` dB | `cmc.navia` |
| RTC VH | `[-26, -11]` dB | `cmc.navia` |

The ramps are Crameri's perceptually uniform scientific colour maps, supplied by
`cmcrameri`, which registers them with matplotlib under `cmc.*` when
`cmcrameri.cm` is imported. `--cmap` overrides both.

The legend records **17 colour stops** per layer. The page interpolates linearly
in sRGB between them, which at the previous nine stops drifted up to 8/255 from
the true ramp — visible as a tonal shift through lipari's warm midrange.
Seventeen keeps it under 4/255. Re-running a build with `--skip-existing`
rewrites `layers.json` with fresh legend colours without re-tiling anything.

Ranges are fixed on purpose: a per-layer percentile stretch would give every year
its own scale, so a real change in coherence between two years would show up as
no visible change at all. `--percentile-stretch` opts into per-layer scaling when
one layer's legibility matters more than comparability, and `--vmin` / `--vmax`
override the range outright.


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

### Tile source: PMTiles or COG

A layer can be published twice: as the pre-styled RGBA PMTiles archive the build
has always written, and as the float COG it was styled from. The panel grows a
**Tile source** control as soon as any entry offers both. Nothing else about the
page changes — the two answer the same product / polarization / year / opacity
controls, draw in the same slot under the hillshade, and carry the same
Copernicus credit.

**Finding the second href.** A manifest entry may name it as a `cog` beside its
`url`, and that always wins. The store writes no such key, so where it is absent
the page derives one from the archive href: `{year}/pmtiles/{stem}.pmtiles`
becomes `{year}/mosaics/{stem}.tif`, which is how the store publishes the pair.
The pattern is anchored to the whole href rather than substituted into it, so it
fails closed — a manifest laid out any other way yields no COG at all instead of
a `.tif` beside an archive that was never published. That is what keeps the
button dark for the false-colour layers, which have no COG by design, and for
the older flat manifests, which have none at all.

| | PMTiles | COG |
| --- | --- | --- |
| what is fetched | WEBP RGBA, ramp already applied | float32 LERC, range-read |
| who applies the ramp | the build, once | the browser, per tile |
| decode | native WEBP | @developmentseed/geotiff: Zstd, then LERC |
| ramp and stretch | baked in | applied per pixel by `setColorFunction` |
| units | converted before the bake | converted per pixel, from `units` |
| pixel values | gone | present |

The colour function is built from the same `colors`, `vmin` and `vmax` the legend
draws, so switching source changes how a pixel gets its colour and nothing else. That
is deliberate: it makes the switch a controlled comparison rather than two
different pictures. It also means the stretch has become a *runtime* value on the
COG path — nothing but a slider stands between it and an adjustable one.

**LERC decodes.** This was the question the whole comparison hung on, and both
readers tried here answer it: compression 34887 with Zstandard as its inner
codec, which is what every mosaic in the store is written with, decodes to real
float values in the browser.

**Nodata needs handling the fragment cannot do.** geotiff.js decodes LERC but
discards LERC's *validity mask*, so a nodata pixel arrives as a plain `0` rather
than as NaN — measured: a tile of either study archive lying wholly outside the
data comes back as 65 536 exact zeros. The protocol's own `#color:` renderer
tests `Number.isNaN(px)`, which never fires, and those zeros clamp to whichever
end of the ramp they fall outside: **white** for backscatter, where 0 dB is above
the stretch, and **near-black** for coherence, where 0 is below it. That is the
fringe around the edge of the data.

So `js/rasters.js` colours the tile itself, through `setColorFunction`, building
the same ramp the fragment would have carried and treating an exact zero as
absent. That test is measured, not assumed. Checked against the PMTiles alpha —
baked from the real validity mask at build time, so it is ground truth — over
every tile of both study archives at z11, z12 and z13:

| | pixels | exact zeros among them |
| --- | --- | --- |
| inside the data (168 tiles/layer) | 11 010 048 per layer | **0** |
| blank, would show as fringe | 2.6 M per layer | 2 (0.0001 %) |

No false positives at all across 22 million interior pixels, and essentially no
fringe. The smallest non-zero magnitude anywhere is 1.2e-5 dB, so the data does
come arbitrarily close to zero without landing on it. At the boundary the test
blanks a seam about a pixel wide — 121–390 px on a straddling tile — and it
never colours a pixel the mask calls blank. It errs toward erasing, not fringing.

**Since re-measured against the mask itself**, rather than against the PMTiles
alpha standing in for it. Decoding the published store's 2024 COH12 VV and
RTC VV mosaics with `lerc` directly gives both the pixels *and* the `mask` the
readers throw away, so the sentinel can be scored against the exact thing it
approximates — 234 tiles, at full resolution and at the third overview:

| | pixels | sentinel vs mask |
| --- | --- | --- |
| COH12 VV, z13 + overview 3 | 7.7 M | **0** erased, **0** missed |
| RTC VV, z13 + overview 3 | 7.7 M | **0** erased, **0** missed |

Every invalid pixel decodes to exactly `0` and never to NaN; no valid pixel is
exactly `0`, the closest being 0.0038. Over 15.3 million pixels the sentinel is
not an approximation of the mask — it is the same partition.

**This belongs in the viewer, not in the archives.** A NaN nodata is a correct
GeoTIFF, read properly by GDAL, rasterio and QGIS; what is broken is the browser
decoders, and the store should not carry a redundant validity band to paper over
it. `Lerc.decode()` *does* return the mask, as `mask` beside `pixels` — the
readers are what drop it. geotiff.js takes `pixels[0]` and leaves the rest, and
it is reachable in principle through geotiff's `addDecoder()`, except that the
protocol bundles its own copy of geotiff and exports no handle on it. So today
the knowledge has to live here.

**The stored value is not always the plotted one.** Every COG in the store is
*linear* — the backscatter mosaics say so in a `BACKSCATTER_CONVENTION=Power`
tag, and QA-CQM is a plain contributing-area ratio — while the stretch published
beside them is quoted in dB, the domain the layer is actually read in. The
PMTiles need nothing: the build converts before it bakes the ramp into RGBA. The
COG path has to convert per pixel, keyed on the manifest's `units`, or the two
sources draw different pictures.

It is not a nicety. Valid pixels of the 2024 RTC VV mosaic run **0.0038 to 24.8**
in linear power, against a published stretch of **−18.5 to −5**; read raw, every
one of them clamps to the top of the ramp and the whole layer draws as a single
flat block. Coherence has no units and is read as stored, which is why the fault
was invisible on the layer the page opens on.

Converting here rather than in the archive is the same decision as §7 of the
store plan: `10·log10` is the last step before the colour, not a change to what
was averaged. GDAL's internal overviews and MapLibre's resampling both average
the linear values, which is the domain in which averaging power is meaningful —
a mean taken in dB would be a different quantity.

Two integration details, both settled here:

- The reader is **ESM-only with bare specifiers and ships no UMD build**, so
  unlike the page's other libraries it cannot be a `<script>` tag. It is
  imported dynamically from esm.sh the first time a COG layer is drawn, with
  `?external=lerc` so that one dependency comes from the package's own file
  instead — see the import map in `index.html` for why that one has to move.
- The archives are given **absolute** URLs. `tilesBase` defaults to a relative
  `tiles`, and the protocol hands the string to the reader rather than letting
  the document resolve it.

#### False colour: two archives, one tile

The false-colour composite is the one layer that is not a single file. `cog://`
reads one GeoTIFF, so **js/cog-rgb.js** registers `glace-rgb://` beside it,
whose URL names a *recipe* — two archives, three stretches, a channel rule —
rather than an archive. On the PMTiles side nothing is special: the store
publishes `coh12_rgb.pmtiles` and the page reads it like any other. The two
therefore compare a rendering baked at build time against the same rendering
computed from the measurements, which is the same comparison the rest of this
section is about, one level up.

| channel | carries | stretch |
| --- | --- | --- |
| R | VV | the VV layer's own `vmin`/`vmax` |
| G | VH | the VH layer's own `vmin`/`vmax` |
| B | VV ÷ VH, or VV − VH in dB | measured here — see below |

The third channel is the ratio of the first two, written in whatever domain the
product is read in: a quotient for coherence, a difference for backscatter,
which in dB is the same thing. Its stretch is **this page's to choose** — the
manifest publishes a `vmin`/`vmax` per single-band layer, and the false-colour
entry's own pair describes only its red channel. Measured at native resolution
(§5 of the store plan is explicit that a decimated read averages SAR speckle
away and reports a range about three times too narrow) over 619 958 valid pixels
of the 2024 mosaics:

| | p2 | p50 | p98 | used |
| --- | ---: | ---: | ---: | --- |
| COH12 VV ÷ VH | 0.76 | 1.39 | 2.63 | 0.75 – 2.75 |
| RTC VV − VH (dB) | 3.50 | 6.73 | 11.03 | 3.5 – 11 |

**What makes it cheap is the canonical grid, not the reader.** Every mosaic of a
scope is written on the WebMercatorQuad grid at one zoom, so VV and VH share a
size, an origin, a blocking and an overview count — tile (x, y) of one covers
exactly the ground of tile (x, y) of the other. The grid also lines up with the
XYZ pyramid: on `glace-ch` the image origin sits 1 088 000 by 734 720 pixels
from the WebMercator origin at z13, and halving stays integral through all seven
overview levels. A tile is therefore an **integer window read** out of each file
and a per-pixel combine — never a reprojection, never a resample.

Whole pixels does not mean whole tiles. At z13 and z12 the origin lands on a
tile boundary and one XYZ tile is a copy of one source tile; from z11 down it
lands on a half or a quarter, and the window straddles a 2x2 block — four reads
per archive, eight for the pair.

**Which is why the decoded source tiles are cached.** Neighbouring XYZ tiles
straddle the *same* source tiles, so a viewport asks for each of them several
times over. Counted per archive over one 6x4 viewport:

| zoom | reads | distinct source tiles |
| --- | ---: | ---: |
| z13, z12 | 24 | 24 |
| z11 | 96 | 35 |
| z10 | 88 | 30 |
| z9 | 63 | 20 |
| z8 | 24 | 6 |

`js/cog-rgb.js` keeps a bounded LRU of them — the promise rather than the array,
so tiles wanted at the same moment share one read instead of racing. Measured
against the live store, a 24-tile viewport: **62 requests at z11** where the
uncached path would make 192, and **32 at z9** against 126. A 256x256 float tile
is 256 kB, so the 128-entry ceiling is about 32 MB: roughly one viewport of both
archives at the level that needs the most, with room to pan.

One consequence, stated because it is a real trade: the abort signal is **not**
passed down into those reads. A cached read is shared, and one consumer
cancelling it would fail every other tile waiting on the same source tile — so a
tile MapLibre gave up on still lands in the cache, where on these overlaps it is
usually wanted again within the same viewport. Abort still stops the work after
the read.

Switching layers is a separate question and needs nothing: MapLibre keeps a
hidden layer's source and its rendered tiles, and `js/rasters.js` only ever sets
`visibility: none` — no GLACE layer is removed once added. The open GeoTIFF
headers are kept per archive too.

Two consequences worth stating:

- The two archives agree on which pixels exist, to the pixel — 0 disagreements
  over the 15.3 million measured above — because both were warped from the same
  tile set onto the same grid. The intersection is not a compromise; it is the
  same footprint twice.
- Zoomed out past the COGs' coarsest overview the tile comes back blank, where
  the pre-styled archive still draws. The mosaics stop at z6 and the PMTiles go
  to z5, so the two sources differ by one level at the far end.

The reader is **@developmentseed/geotiff**, which decodes LERC and Zstd through
its own dependencies rather than through geotiff.js. It is ESM-only with bare
specifiers and ships no UMD build, so unlike the page's other libraries it
cannot be a `<script>` tag: it is imported dynamically from a CDN that resolves
the bare specifiers, the first time a false-colour layer is shown. A visit that
never selects one never fetches it. `cogReaderUrl` in `site-config.js` repoints
it — deliberately not a query parameter, since the URL is executed.

#### Which reader

The COG path went through `@geomatico/maplibre-cog-protocol`, which bundles
geotiff.js 3. It now goes through **@developmentseed/geotiff** (from
[developmentseed/deck.gl-raster](https://github.com/developmentseed/deck.gl-raster)),
built on `@cogeotiff/core` with `lerc` and `fzstd` as direct dependencies,
behind this page's own protocol. The measurements below are why.

The original hope was that a reader written for exactly this file type would
preserve LERC's validity mask and retire the zero sentinel. **It does not.** Its
LERC codec unwraps the Zstd layer, calls `lerc.decode()`, and returns
`{ layout: "band-separate", bands: result.pixels }` — discarding `result.mask`
in precisely the way geotiff.js discards it. Nothing else in the package reads a
mask back. The mask is one field away in *both*, so the real repair is a
three-line change to a codec, and this package's copy is the smaller target.

What did decide it was everything else: one reader instead of two for the same
file type, one decoded-tile cache that both the single-band and the false-colour
layers draw from, one place for the nodata sentinel and the dB conversion, and
**207 kB less script** on every visit — geomatico's UMD bundle was loaded
whether or not a COG was ever opened.

#### What it costs

Re-measured against the published store rather than localhost, which is what the
Source Cooperative publication was for. One 24-tile viewport over Aletsch,
COH12 VV 2024, cold each time, median of 5:

| zoom | source | requests | kB | ms |
| --- | --- | ---: | ---: | ---: |
| z9 | PMTiles | 15 | 135 | **405** |
| | COG, geotiff.js | 113 | 1262 | **986** |
| | COG, this reader | 21 | 415 | **177** |
| z11 | PMTiles | 21 | 354 | **137** |
| | COG, geotiff.js | 174 | 3934 | **929** |
| | COG, this reader | 36 | 1417 | **194** |
| z13 | PMTiles | 25 | 245 | **119** |
| | COG, geotiff.js | 78 | 1389 | **580** |
| | COG, this reader | 25 | 1450 | **201** |

z11 is the row to believe — it is the one where the extent fills the viewport.
Against PMTiles it reads **1.4× the time and 4.0× the bytes**; through geotiff.js
the same layer cost 6.8× the time and 11.1× the bytes. The old localhost figure
was "about 2× the time and 3–9× the bytes", and the reader turns out to have
been most of it.

Warm — the archive already open, which is what panning costs once a layer is on
screen — the gap holds: at z11, geotiff.js takes 156 requests, 3930 kB and
468 ms against this reader's 30, 1288 kB and 152 ms.

**Why the readers differ so much.** geotiff.js batches range reads into 64 kB
blocks, so a 26 kB tile drags a whole block behind it; that is the same effect
the localhost run saw as "3–9× the bytes", and over a real network it is paid in
latency as well. `@developmentseed/geotiff` reads tile data with exact ranges and
bypasses its own block cache for it. On top of that, this page caches decoded
source tiles, which below z12 is worth a further 2.7–4× (see above).

What is counted, since the two rows stop in different places: measured in Node
against the live bucket, the PMTiles row ends at the compressed tile bytes — the
browser decodes WEBP natively from there, around a millisecond a tile — and the
COG rows end at the RGBA array, before the browser encodes and uploads it. Both
omit their last step. geotiff.js was driven directly with no worker pool so that
both COG rows decode on one thread; geomatico's wrapper puts that decode in a
Web Worker, which moves it off the main thread but does not change a byte.

**Decoding runs on the main thread, and that is fine.** The reader can decode in
a pool of Web Workers, and this page did that briefly. It was measured and
removed. Over 40 full-resolution tiles:

| per tile | | a 24-tile viewport |
| --- | ---: | ---: |
| Zstd + LERC decode — what a worker moves | 0.36 ms | **9 ms** |
| colouring, per pixel — stays either way | 0.52 ms | **12 ms** |

A worker takes about 9 ms off a thread that is still doing 12 ms of colouring
and a PNG encode, for a whole viewport — under a frame at 60 Hz. Against that:
a same-origin worker file, a pool proved before use so that a dead worker cannot
leave every tile pending, two more settings, and a version coupling between the
import map and the worker, since workers do not inherit import maps and the
CDN's build of lerc cannot be used inside one. Not a trade worth making.

The decode is cheap because LERC is cheap. If a layer ever decodes slowly enough
to matter, repeating that measurement is the way to find out.

#### What it buys, and what it does not

The COG carries the float values, so the stretch, the colour map and a readable
pixel value all become runtime properties instead of build-time ones — and
`create_rgba_vrt`, `write_rgba`, `rio-pmtiles` and the legend plumbing stop being
needed to publish a viewable layer.

**Changing the stretch is free.** Measured with the stretch in the URL fragment,
where moving it means a new MapLibre source: `CogReader` caches the decoded
*values* under the archive URL and tile index, which the fragment is not part of,
so re-colouring the 24-tile z11 viewport measured above cost **0 bytes and
~125 ms** against the 842 ms and 2.4 MB of the first load. The page colours
through `setColorFunction` rather than the fragment, which does not change that
arithmetic — the values are decoded and cached either way. Whatever an adjustable
stretch would cost, it is not a refetch.

**It does not buy resolution.** Side by side the COG looks cleaner, which is
easy to misread as more detail; it is not. Horizontal autocorrelation of the same
tile from both archives agrees to within 0.02 at every lag from 1 to 8 px, at
z11, z12 and z13 — the same ground detail is behind both. What differs is that
the PMTiles archive has been through an 8-bit ramp and a lossy WEBP encode, so
smooth areas band and block; the COG evaluates the ramp on float values per
pixel. Runs of exactly-equal adjacent pixels are 1.56 px long in the PMTiles
COH12 tile against 1.06 in the COG's, which is that quantisation and nothing
else.

The blocky-looking hop the *data* still carries — 10 m composites → 40 m
EPSG:3035 → WebMercator, described under Resampling above — is upstream of both
and is not what this switch is about.

### The tile grid

**Catalog tile grid** in the map options draws the MGRS footprints the store is
built on, shaded by how much of each the glacier inventory covers. It used to be
a vector PMTiles archive built beside the rasters; the store does not publish
one, and does not need to. What it publishes is `tiles.parquet`, the
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

The tiler reprojects with **`bilinear`** by default. `--resampling` overrides.

At the maximum zoom the tiles oversample 40 m data onto a 26.5 m grid, so the
choice is between interpolating and replicating, not between sharp and blurry:

- `bilinear` is smooth, and carries roughly half the high-frequency content of
  the source.
- `nearest` preserves every measured value, but the 1.5× ratio makes some source
  pixels wider than others, which reads as blocky.

Bilinear looks better on this source. **Neither recovers detail the source does
not carry** — see the note below.

For the record, the tile codec is not the limiting factor: checked against a
PNG-lossless build of the same tile, WEBP at `--quality 80` reproduces its detail
and contrast almost exactly (mean |Laplacian| 9.49 vs 9.33, σ 46.7 vs 46.8) at
about a twelfth of the size. Nor is `--tile-size 256`; 512 px tiles simply
oversample further.

> **The real limit is the source, and fixing it is a larger change.** These tiles
> come from the 40 m EPSG:3035 overview mosaics, so the pixels are resampled
> twice: 10 m MGRS composites → 40 m EPSG:3035 → WebMercator. Tiling from the
> 10 m composites directly — on a grid aligned to the tile scheme, e.g. 1 arcsec —
> would remove the second hop and support a maximum zoom past z12 with real
> detail behind it. It means mosaicking per tile inside the tiler rather than
> reading one prepared overview, so it is a rework of `build_pmtiles`, not a flag.

One thing to know if you retune the ranges: **percentiles must be measured at native
resolution.** A decimated read averages SAR speckle away and reports a much
narrower distribution than the max-zoom tiles are drawn from — for RTC VV the
2–98 range narrows from ~14 dB to ~5 dB, and a stretch derived that way clipped
13.6 % of the scene to a single flat colour. `estimate_stretch` therefore samples
full-resolution windows rather than reading one decimated overview.


### What the viewer shows

Product (COH12 / RTC), polarization (VV / VH) and a year slider select one
raster layer; combinations with no archive are disabled rather than hidden.
Layer opacity, shaded relief, the basemap labels, the catalog tile grid and the
glacier inventories are independent of that choice and of each other. The map
position lives in the URL hash, so a view can be linked.

The rasters are *pre-styled RGBA* — the colour ramp is baked in at build time
and pixel values cannot be read back from the tiles. The legend reports the
stretch each layer was built with, which is the fixed range from the table above
unless the build opted into `--percentile-stretch`; either way it is recorded
per layer in `layers.json`. For quantitative work, go to the COGs the STAC items
point at — or, where a manifest names one, switch the layer to its COG source
and read the values in the browser (see below).

A **Tile source** control appears when the manifest offers a layer both ways.
It is the only control whose presence depends on what was published.
