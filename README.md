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
| GLACE rasters | object storage, via `?tiles=<base-url>` (default `./tiles`) |
| Basemap | Protomaps `grayscale`, from the free [Source Cooperative](https://source.coop/) mirror |
| Terrain | Mapterhorn global DEM, terrarium-encoded, from their `{z}/{x}/{y}` endpoint |
| Glacier inventories | built from `data/*.geojson` in this repo |

The rasters are produced by [deep-glacier-mapping](https://github.com/lqgentner/deep-glacier-mapping),
which also exports the inventory GeoJSON here. This repository holds only the
page and its overlays.

## Preview locally

The inventory archives are build outputs, so build them first:

```bash
python scripts/build-tiles.py          # data/*.geojson -> data/*.pmtiles
python scripts/serve.py                # -> http://127.0.0.1:8000/
```

`build-tiles.py` needs tippecanoe on `PATH`, or `--tippecanoe /path/to/binary`.
It is a C++ program; build it from https://github.com/felt/tippecanoe.

`http.server` cannot serve PMTiles — it ignores `Range` and returns whole files —
which is why `serve.py` exists. It also sets caching per file type: the page
shell is sent `no-store`, since a stale `js/app.js` leaves the page silently
rendering the previous version, while the archives are cached normally.

To see the GLACE rasters, `serve.py` mounts `./tiles` under `/tiles`. Until the
archives are published, point that at a local build in deep-glacier-mapping:

```bash
ln -s ../deep-glacier-mapping/cache/stac-dataloader/pmtiles tiles
```

`tiles` is gitignored (no trailing slash in the pattern — git sees a symlink as a
file, so `tiles/` would not match it). Once the archives are on object storage,
skip the symlink and point the page at them instead:

```
http://127.0.0.1:8000/?tiles=https://data.source.coop/<org>/glace
```

That needs the bucket to allow anonymous reads **and** to send CORS headers with
`ExposeHeaders` for `Content-Range`, `Content-Length`, `Accept-Ranges` and
`ETag`. Without those the browser fetches the bytes but refuses to let the
PMTiles client read the range metadata, which fails looking like a corrupt
archive rather than a permissions problem.

## Tests

```bash
python -m unittest discover -s tests   # the two scripts
npm install && npm test                # the page
```

`.github/workflows/test.yml` runs both on every pull request, and the deploy
workflow calls it before staging the site — so a red suite cannot reach Pages.
Neither suite builds anything: the Python side is stdlib only, and the JavaScript side
needs `jsdom` and nothing else. **`node_modules` is development-only** — the
page has no runtime dependencies and nothing is ever bundled.

| file | covers |
| --- | --- |
| `tests/test_serve.py` | range boundaries, suffix and invalid ranges, `/tiles` containment, cache headers |
| `tests/test_build_tiles.py` | inventory index validation |
| `tests/config.test.js` | the defaults -> `site-config.js` -> query precedence chain |
| `tests/manifest.test.js` | `layers.json` validation, MGRS/UTM parsing |
| `tests/ui.test.js` | status priority and keying, escaping in the credit popover |
| `tests/viewer.test.js` | the page end to end against a fake MapLibre |
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

## Deploy

`.github/workflows/deploy.yml` publishes to GitHub Pages on every push to
`main`. It builds tippecanoe from source (pinned by `TIPPECANOE_VERSION`, cached
between runs), converts `data/*.geojson` to archives, and uploads only the
archives — never the GeoJSON they came from, which would double what a visitor
could download for nothing.

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
inventories, then **Map options** — hillshade, catalog tile grid, basemap
labels. The last two are collapsed by default; between them they are seven
controls that are off on arrival, and the panel is shorter without them.

"Map options" rather than "Additional layers" because only two of the three are
layers: the basemap labels toggle is a visibility switch on the basemap that is
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

The basemap style is generated at runtime by `@protomaps/basemaps` (69 layers,
13 of them labels) rather than hand-written, so the flavor decides every colour.
`?flavor=` switches it (`grayscale`, `black`, `dark`, `light`, `white`) and
`?basemap=` points at a different archive. The default reads Protomaps' daily
planet build from Source Cooperative, which serves `Access-Control-Allow-Origin: *`
and honours range requests, so it works cross-origin with no setup. Protomaps
discourage hot-linking their own `maps.protomaps.com` builds; the Source
Cooperative mirror is the sanctioned free option, and for production you would
copy an extract to your own storage.

Data layers are inserted below the basemap's first symbol layer, so labels stay
readable on top of the imagery. The "Basemap labels" checkbox hides just those
symbol layers.

### Draw order

Bottom to top: basemap fills, GLACE rasters, hillshade, vector overlays (glacier
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
point at.
