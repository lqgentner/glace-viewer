# AGENTS.md

Working notes for glace-viewer: how to run and test it, and the decisions that
cannot be read off the code. How each mechanism works is documented where it
lives, in the module headers and comments. [`README.md`](README.md) is the
human-facing overview.

## Layout

No build step and no framework: `index.html`, `style.css` and native ES modules
under `js/`, loaded straight by the browser. `.pixi` and `node_modules` are
dev-only.

| module | owns |
| --- | --- |
| `js/config.js` | settings: defaults → `site-config.js` → `?tiles=`, `?basemap=`, `?flavor=` |
| `js/map.js` | the map, draw order (`addStacked`), basemap swap, labels, hillshade, 3D, the missing-tile workaround |
| `js/store.js` | the STAC catalog → one record per PMTiles archive |
| `js/rasters.js` | raster controls, the panel's axes, legend |
| `js/cog-rgb.js` | the `glace-rgb://` COG protocol — wired up, unused |
| `js/tile-grid.js` | the catalog tile grid, from the store's geoparquet index |
| `js/overlays.js` | glacier inventories, tile grid overlay, popups |
| `js/sky.js` | the globe's silhouette on screen, for the halo `style.css` paints |
| `js/ui.js` | status line, credit popovers, safe DOM helpers, segmented controls |
| `js/app.js` | control wiring and startup |
| `scripts/serve.py` | dev server with `Range` support and per-type caching |
| `pixi.toml` | the toolchain (Python, Node, tippecanoe) and the tasks that run it |
| `scripts/build-tiles.py` | `data/*.geojson` → `data/*.pmtiles` via tippecanoe |

Anything that reaches the page from the catalog or a vector tile is built as DOM
nodes, never as an HTML string.

## Preview locally

Every tool comes through [pixi](https://pixi.sh): Python, Node and tippecanoe
from conda-forge, pinned together in `pixi.lock`. jsdom is the exception
(conda-forge stops at jsdom 14 and pixi cannot lock npm packages), so
`package.json` stays and `npm ci` runs as a task inside the environment. The
tasks are in `pixi.toml`; `--locked` fails rather than drifting.

```bash
pixi run build-tiles                    # data/*.geojson -> data/*.pmtiles
pixi run serve                          # -> http://localhost:8000/
```

- **Open `localhost`, not `127.0.0.1`.** The basemap reads Protomaps' hosted
  API, whose CORS exemption for local development matches the `localhost`
  hostname exactly. On the loopback IP the basemap fails with no useful error.
- `http.server` cannot serve PMTiles (no `Range`), hence `serve.py`. It sends
  the page shell `no-store` so a stale `js/app.js` never renders silently.
- The page reads the published store by default (`site-config.js`). To read a
  build: `ln -s <store root> tiles` and open `?tiles=tiles`, or `pixi run
  serve --tiles-dir <dir>`. Either way it is the catalog root that is served: the
  archives sit in `mosaics/{year}/` beside the COGs, so there is no separate
  directory of them to point at. `tiles` is gitignored without a trailing slash
  because it is usually a symlink, which git sees as a file.
- Any bucket the page reads must allow anonymous reads and send CORS
  `ExposeHeaders` for `Content-Range`, `Content-Length`, `Accept-Ranges` and
  `ETag`. Without them a PMTiles read fails looking like a corrupt archive,
  not a permissions problem. Source Cooperative does this.

## Tests

```bash
pixi run --locked test      # both suites: test-py (the scripts), test-js (the page)
```

Both run on every pull request (`.github/workflows/test.yml`), and the deploy
workflow calls that workflow before staging, so a red suite cannot reach Pages.

| file | covers |
| --- | --- |
| `tests/test_serve.py` | range boundaries, `/tiles` containment, cache headers |
| `tests/test_build_tiles.py` | inventory index validation |
| `tests/config.test.js` | the settings precedence chain |
| `tests/store.test.js` | the collection/style join, per-layer validation |
| `tests/layers.test.js` | the panel's axes, the legend text, MGRS/UTM parsing |
| `tests/ui.test.js` | status priority, escaping in the credit popover |
| `tests/viewer.test.js` | the page end to end against a fake MapLibre, fixture `two-years/` |
| `tests/store-catalog.test.js` | the page against one year of the published catalog, verbatim |
| `tests/cog-rgb.test.js` | the `glace-rgb://` protocol, driven directly |
| `tests/tile-grid.test.js` | the tile grid from a fake parquet reader |
| `tests/sky.test.js` | the silhouette against an independent camera model, the sky's gate |
| `tests/viewer-degraded.test.js` | no reachable catalog |
| `tests/viewer-narrow.test.js` | phone viewport; guards the stylesheet, not the DOM |
| `tests/viewer-3d-restore.test.js` | a pitched `#hash` comes back in 3D |
| `tests/viewer-light-flavor.test.js` | `?flavor=light` gets black labels |
| `tests/page-assets.test.js` | every local `src`/`href` exists and is staged by `deploy.yml` |

Things to know when adding tests:

- The modules hold state at module scope and the map is a singleton, so a
  scenario that needs a different catalog, viewport or pitch goes in its own
  file — `node --test` gives each file its own process.
- `tests/helpers/browser.js` fakes MapLibre **strictly**: adding a layer twice,
  naming a missing source, or setting a property on an unadded layer throws.
  Real MapLibre only warns, and the page would sail past it.
- No test reads `./tiles`; both catalogs are committed fixtures.
  `tests/fixtures/store/` is the published catalog verbatim minus the item's
  half-megabyte geometry. `two-years/` has one combination built for one year
  only and a style describing only the newer year, which is what makes the
  disabled-button and older-year fallback paths reachable.
- The range and path cases in `test_serve.py` write raw bytes to a socket:
  `http.client` and `curl` normalise `a/../b` before sending, which is the case
  under test.
- `cog-rgb.test.js` exists to keep unused code from rotting; its recipe numbers
  come from the store fixture's style.

## Deploy

`.github/workflows/deploy.yml` publishes to GitHub Pages on every push to
`main`: installs the pixi environment (tippecanoe included, cached on
`pixi.lock`), builds the inventory archives, and uploads the archives but never
the GeoJSON.

- **Settings → Pages → Source must be "GitHub Actions"**, not "Deploy from a
  branch". The branch option serves the committed GeoJSON and none of the
  `.pmtiles` the page loads, so every overlay 404s.
- `site-config.js` points the deployed page at the published store. If that
  store is unreachable the raster controls hide themselves; basemap, terrain
  and inventories still work.
- Every path to `assets/` is relative because a Pages project site lives on a
  subpath.
- The stable actions float on a major; `setup-pixi` is pinned to a release
  while pixi is pre-1.0. Dependabot (`.github/dependabot.yml`) moves both
  monthly, jsdom with them. `pixi.lock` is refreshed by hand
  with `pixi update`; pixi itself is unpinned in CI, `requires-pixi` in
  `pixi.toml` being the floor.

## The published store

The archives live in [`lqgentner/glace-ch`](https://source.coop/lqgentner/glace-ch)
on Source Cooperative. It is the **Switzerland-only rehearsal build** of the
full store's layout; the Alps dataset will change extent and year count, not
layout.

```
{root}/
├── catalog.json
├── tiles/
│   ├── collection.json
│   └── items.parquet                   # the grid's index, stac-geoparquet
└── mosaics/
    ├── collection.json                 # rel="pmtiles" links: the inventory this page reads
    ├── styles/2024.json                # how each layer is drawn, one style per year
    └── 2024/
        ├── item.json
        ├── coh12_vv.tif                # float32 LERC_ZSTD COG, ETRS89-LAEA 40 m
        └── coh12_vv_viz.pmtiles        # pre-styled RGBA, WebMercator z5-z13
```

Every layer is published twice in one directory, the rendering under a `_viz`
stem and registered on its item with the `visual` role; the page draws only the
`_viz` side. The catalog ships **no COG for web display** — the archives are
that product — and needs no sidecar from this repository.

### Reading the catalog

`layers.json` is gone (glace-catalog M-26); `js/store.js` reads the mosaics
collection (which archives exist), the styles it nominates (how each is drawn)
and each year's item (the acquisition window). Decisions the code relies on:

- **Enumerate archives from the collection, not the styles.** The collection is
  the inventory; a style describes one year.
- **One style per published year** (glace-catalog M-35), registered as
  `style-{year}` with the href `./styles/{year}.json`; the latest year's asset
  also carries the `default` role. The page reads every one of them and draws a
  layer from the style of its own year.
- The join key is `pmtiles:layers`, the style layer id (`glace-coh12_vv_qa_num-2024`),
  which the page also uses as its MapLibre layer id. A year the collection
  publishes no style for falls back to the same stem in the default style:
  stretch and ramp are fixed per layer, deliberately (see
  [Value ranges](#value-ranges-and-colour-maps)).
- `metadata.portolan:legend` is the source of truth for ramp, stretch, unit and
  the false colour's three `{band, vmin, vmax}` channels. This page keeps no
  copy of any of them.
- Bounds and attribution are declared nowhere here. Both are in each archive's
  PMTiles header, and `pmtiles.Protocol({metadata: true})` puts them in the
  TileJSON. The attribution reads `University of Zurich, Contains modified
  Copernicus Sentinel data {year}`.
- The acquisition window comes from the item's `start_datetime`/`end_datetime`,
  which upstream carries from the composite's `COMPOSITE_START_DATE` /
  `COMPOSITE_END_DATE` GeoTIFF tags through `build_overview`. Descriptive only:
  a year whose item 404s loses the line and keeps its layers.

**One field carries three things.** The polarization half of a layer id holds
seven values (`VV`, `VH`, `RGB`, and `VV_QA_NUM`, `VV_QA_CQM` plus their VH
pair): a polarization, a QA role and a channel recipe. `js/rasters.js` splits
it into the Polarization and Layer rows. An unrecognised value is dropped
**silently** by the `POLARIZATIONS` allowlist — such a layer is correct, merely
unpresentable here. All fourteen archives the store publishes today reach the
map; `store-catalog.test.js` asserts it.

## Configuration

Three layers, each overriding the last: defaults in `js/config.js`,
`site-config.js`, then the query parameters `?tiles=`, `?basemap=`, `?flavor=`.
Only those three are reachable from the address bar; the library URLs are
executed, so they are deployment decisions.

- `site-config.js` is a plain script, not fetched JSON, so repointing the
  archives cannot add a second asynchronous way for startup to fail. The
  committed copy is the live deployment and names only `tilesBase`.
- Deliberately not configurable: paint expressions, click radius, DOM ids.
  Control defaults live in `index.html` (`value="100"` opacity, `value="55"`
  hillshade) and are mirrored in the owning modules.
- The page always opens on `initialView` (Aletsch, `#10/46.51/8.03`) when the
  URL has no `#hash`; it is never re-framed to the data's bounds. A deployment
  with archives elsewhere sets `initialView`.

## Glacier inventory overlays

Three third-party inventories ship simplified (10 m in EPSG:3035, five
decimals), each fetched only when first ticked. All are CC BY 4.0; each
carries attribution, citation and licence in `data/inventories.json`, shown
behind the info mark beside its toggle. The MIT licence covers the viewer code,
not this data.

| id | inventory | features |
| --- | --- | --- |
| `sgi2016` | Swiss Glacier Inventory 2016 (2013–2018) | 1,400 |
| `sgi2023` | Swiss Glacier Inventory 2023 (2021–2024) | 1,299 |
| `pauletal2020` | Alpine Glacier Inventory (2015–2017), no names, has `glacier_nr` | 4,395 |

- Regenerate the GeoJSON with `scripts/stac/export-inventories.py` in
  deep-glacier-mapping; it needs that repository's dataset classes.
- tippecanoe drops null properties, so an unnamed feature has no `name` key at
  all. `inventories.json` records each archive's `source_layer`; a mismatched
  `source-layer` renders nothing and reports no error.
- **GeoJSON is committed, PMTiles is built**, and the archives are vector
  tiles rather than shipped GeoJSON. Measured (tippecanoe `-Z4 -z14`):

| | on disk | z6 view | z8 view | second commit, 5 % re-mapped |
| --- | --- | --- | --- | --- |
| gzipped GeoJSON | 2.5 MB | 2.5 MB | 2.5 MB | +144 kB |
| vector PMTiles | 8.8 MB | 0.14 MB | 0.43 MB | +7.2 MB |

  So tiles cost 3.5× the storage but the opening view pulls 141 kB instead of
  2.5 MB and draws as tiles land; git deltas text and cannot delta a gzipped
  archive. Lowering max zoom is the lever if size matters (z12: 4.8 MB).

## Design decisions

Reasons that are not in the code, or that look like bugs until you know them.

### Basemap and terrain

- The basemap is `@protomaps/basemaps` generated at runtime (69 layers, 13 of
  them labels) over Protomaps' **hosted API**, a TileJSON URL with an API key
  baked into `basemapUrl` in `js/config.js`. Faster than the Source Cooperative
  mirror it replaced. Rotate or scope the key in the Protomaps dashboard, not in
  code. Sprites and glyphs come from the free `basemaps-assets` GitHub mirror.
- Every label face is pushed to the flavor's extreme — white over black on
  the dark flavors, black over white on the light ones — set **in the flavor
  object** before the style is generated, not patched onto the layers after:
  the generator's halo is 1 px and unblurred, and the 2 px blurred halo the
  page used to apply drew a grey ring around small labels. The flavor has no
  halo field for water labels (they keep the water colour) or countries, and
  POIs keep their kind colours. Labels are not repainted over World Imagery.
- World Imagery is Esri's XYZ endpoint, created lazily; switching back restores
  the vector style without rebuilding the map.
- The terrain is Mapterhorn's **zxy endpoint, not its PMTiles**: `planet.pmtiles`
  stops at z12, higher zooms live in one archive per z6 tile (hundreds of GB
  each), and their download server answers ranges uncached, while
  `tiles.mapterhorn.com` is edge-cached for a week. One `raster-dem` source
  feeds both hillshade and 3D.
- Hillshade colours are neutral on purpose: a hued shadow over `cmc.lipari` is
  no longer `cmc.lipari`. MapLibre has no blend modes or `hillshade-opacity`;
  transparent highlights plus black shadows is the multiply equivalent, and the
  strength slider drives the shadow alpha. A test asserts the neutrality.
- Draw order, bottom to top: basemap fills or imagery, GLACE rasters, hillshade,
  vector overlays, basemap labels. Layers are created lazily in click order, so
  `addStacked()` in `js/map.js` places each by kind rather than by arrival.

### 3D and globe

- The 3D button is not MapLibre's `TerrainControl`: it carries a text label
  (`3D`/`2D`, naming the next press) and eases the camera to 60°, MapLibre's
  default `maxPitch`. The hillshade is left alone when 3D comes on.
- Pitch is in the `#hash`, terrain is not, so startup re-enables terrain when
  the incoming pitch is non-zero, without moving the camera.
- `projection: globe` in MapLibre 5 is a zoom interpolation (globe to z11,
  mercator from z12). Costs: no fog matrices (unused) and zoom-around-cursor
  degrades to zoom-around-centre while the globe shows.

### The sky

Once the globe no longer fills the viewport the page paints a halo at the limb
over deep space. It began as Leonel Dias's
[Canvas 2D technique](https://leoneljdias.github.io/posts/globe-atmosphere-halo-comets/)
(also GeoLibre's atmosphere plugin); what remains of it is the idea of finding
the disc by projecting points around the limb, credited in `js/sky.js`. The
canvases, the gradient and the blend are gone, and its starfield with parallax
and its comets were built and taken out again: decoration, and a flat sky does
not turn the way a real one does behind an orbiting camera.

- It is `#map`'s CSS background: MapLibre clears to transparent and draws the
  basemap's `background` layer on the globe alone, so the element behind shows
  around the disc. `js/sky.js` writes the disc as custom properties on `move`;
  `style.css` draws. The comets were the only reason for the original's 60 Hz
  loop, so there is none, and the `sky` class is on only while a corner of the
  viewport lies outside the disc — a pan over a glacier writes nothing.
- **Do not gate on `map.getProjection().type === "globe"`** as the plugin
  does: in MapLibre 5 that is the stylesheet's spec, `globe` at z13 as at z1.
- The limb is sampled at the visible horizon, not 90° from the centre; the
  header of `js/sky.js` says why, and `sky.test.js` checks it against an
  independent pinhole camera. The field of view and globe scaling it assumes
  are MapLibre's fixed defaults; the page never calls `setFov`.
- The globe's radius is `512·2^z / 2π / cos(lat)` px, a third larger over
  Switzerland than at the equator. On 1920×1080 the corners clear the disc
  below about z3 and the whole globe shows below about z2, so most visits
  never see the sky and it must cost them nothing. `minZoom: 1` in
  `initialView` stops the globe short of a marble.
- The halo is one colour with an exponential opacity falloff, after Google
  Maps' globe, rather than the article's bright rim and tail, which banded.

### Attribution

MapLibre's `AttributionControl` credits a source only while a visible layer
uses it, which is what makes the line conditional for free. Non-obvious parts:

- MapLibre **sorts attributions by string length** before joining them, so
  OpenStreetMap and Protomaps ride in one string to keep their order.
- A source's `attribution` in the spec **replaces** the TileJSON's rather than
  adding to it, and is applied only once the TileJSON resolves. So the GLACE
  archives and the DEM declare none (their publishers word their own); the
  basemap declares both credits (Protomaps' TileJSON names only OSM); World
  Imagery declares one (no TileJSON). The renderer's credit is
  `customAttribution` on the control, so a blocked basemap cannot take it down.
- `terrainCredit` in configuration repeats the DEM credit behind the panel's
  info mark, so a publisher dropping its own credit would still be caught.

### Value ranges and colour maps

Stretch and ramp are baked into each archive at build time and published in
the style; this page draws the legend from the same block.

| layer | range | colour map |
| --- | --- | --- |
| COH12 VV / VH | `[0.10, 0.75]` / `[0.10, 0.55]` | `cmc.lipari` |
| RTC VV / VH | `[-16.5, -4]` / `[-23.5, -11]` dB | `cmc.grayC` |
| QA-NUM, all four | `[0, 90]` | `cmc.glasgow` |
| QA-CQM | `[-3, 10]` dB COH12, `[-4, 8]` dB RTC, higher is better | `cmc.glasgow` |
| false colour | three channels from `portolan:legend` | — |

- **Ranges are fixed per layer on purpose.** A per-year percentile stretch
  would hide a real change between years. Every range was remeasured on the
  warped 2021–2024 display mosaics on 2026-09-09 (2–98 %, averaged over the
  years). QA-NUM spans 0–90 rather than the observed 26–30 because 2021
  reaches 58 with S1B still flying and 2026 flies three satellites. QA-CQM is
  one-sided and keeps its measured range: 0 dB is not a meaningful middle.
- 17 stops per ramp: at nine, linear sRGB interpolation drifted up to 8/255
  through lipari's midrange; seventeen keeps it under 4/255.
- The false colour's legend numbers come only from the published channels;
  where absent, the bands are named and no range is quoted. Red/green are never
  inferred from the sibling VV/VH entries (a convention nothing enforces) and
  blue is recoverable from nothing. PMTiles metadata holds no stretch either.
- The rasters are pre-styled RGBA, so pixel values cannot be read back; for
  quantitative work use the COGs the STAC items point at.

### Resampling

The archives are tiled from the 10 m UTM composites straight onto the
WebMercatorQuad grid at z13 with `average`: one resampling, and every lower
level a clean 2× decimation. Earlier builds went through a 40 m EPSG:3035
overview first, which is why the kernel used to be `bilinear`. If the ranges
are ever retuned, **measure percentiles at native resolution**: a decimated
read averages speckle away (RTC VV's 2–98 range narrows from ~14 dB to ~5 dB)
and a stretch derived that way clipped 13.6 % of the scene flat. WEBP q80 is
not the limiting factor (mean |Laplacian| 9.49 vs 9.33 for lossless PNG at a
twelfth of the size).

### Missing tiles

The archives are sparse: bounds are one rectangle over scattered MGRS tiles,
and 12 of 36 sampled z11 tiles in the Alps build have no tile. `pmtiles.Protocol`
answers `data: null`, and MapLibre's `RasterTileSource.loadTile` only marks a
tile loaded inside `if (response && response.data)`, so a missing tile stays
`loading` forever — never drawn, parent left magnified, `idle` never fires.
`js/map.js` wraps the protocol and answers a missing raster tile with one
transparent pixel. Vector tiles already return an empty buffer.
`errorOnMissingTile` does not help; it only applies to vector tiles.

### The COG reader

`js/cog-rgb.js` is registered and tested but **nothing on the page uses it**.
Its premise is a web-mercator COG on the XYZ grid; the published mosaics are
ETRS89-LAEA 40 m, the right CRS for analysis and not an oversight, and the
catalog ships no web-display COG. It is kept because it is the only path by
which this page could read a pixel value, and it costs one 15 kB module and no
network. Facts it depends on:

- Reader is `@developmentseed/geotiff` (ESM-only, from a CDN pinned in
  `js/config.js`), not geotiff.js, whose 64 kB read batching costs several
  times the bytes per tile. `lerc` resolves through the import map in
  `index.html`; see the comment there for why it must not come from esm.sh.
- **Every browser reader discards LERC's validity mask**, so a nodata pixel
  decodes as `0`. Measured over 15.3 million pixels of the 2024 COH12 VV and
  RTC VV mosaics, zero is exactly the mask (closest valid value 0.0038). This
  belongs here, not in the store: a NaN nodata is a correct GeoTIFF.
- The COGs are linear while the stretches are in dB; the reader converts per
  pixel or the layer draws as one flat block.

### The tile grid

The grid is read from `tiles/items.parquet` with
[hyparquet](https://github.com/hyparam/hyparquet), four columns of ~200. One
Item per (tile, year) collapses to 143 footprints. Measured cold against the
live store: ~230–420 ms, 6 requests, 330 kB — the footer is ~121 kB and
hyparquet fetches the whole 321 kB file regardless of projection; the
projection buys the decode time (5 ms vs 293 ms), not the bytes. Paid once per
session and handed to MapLibre as GeoJSON. The index is SNAPPY, which hyparquet
decodes alone; a ZSTD index would need `hyparquet-compressors` and fails loudly.
The index being reachable from the page is what any future filtering by
fraction, year or zone would build on.

### The panel

- Products are labelled as a reader would say them (`COH12` → Coherence,
  `RTC` → Backscatter); `data-value` keeps the catalog's spelling. Rows are
  ordered by the panel, not the catalog, so VV is left and the page opens on it.
- The **Layer** row (`quantity` in code) offers Data, QA: Count, QA: Quality and
  **hides itself when the catalog carries one quantity**. Faces are short
  because three buttons share 292 px. What either QA raster *is* is
  deep-glacier-mapping's to define.
- Grey means two things: `aria-disabled` marks a combination that cannot exist
  (false colour × QA), and the click is accepted with the other row giving way;
  `disabled` marks a year with no archive, and the click is refused. `GIVES_WAY`
  in `js/rasters.js` is the whole rule and deliberately excludes the product row.
- The colour-map credit button is rebuilt only when the map changes, because
  replacing it under the pointer drops the popover being read.
- **Small screens**: below 640 px the panel opens collapsed to its title bar,
  by a stylesheet rule rather than the script, because `js/app.js` is deferred
  and a script-applied collapse showed a full panel for one frame.
  `viewer-narrow.test.js` guards the CSS. The breakpoint lives in both
  `style.css` and `js/app.js` and must agree. The panel stops 52 px short of
  the right edge (MapLibre controls) and the bottom (scale bar; `js/map.js`
  and the CSS cap must agree). Header fixed, `#panel-body` scrolls, native
  scrollbar styled twice for Firefox and Blink/WebKit — the reasoning is in
  `style.css`.

### Wordmark and icons

- `assets/glace-wordmark.svg` carries its glyphs as **outlines**, because an
  `<img>` loads no page fonts. To redraw after a wordmark change, take
  [Coiny](https://fonts.google.com/specimen/Coiny) (SIL OFL 1.1) through a
  `fontTools` `SVGPathPen`. Its `viewBox` is cropped to the ink (CSS height is
  cap height) and its gradient is `userSpaceOnUse`, so `gradientTransform`
  moves with any `viewBox` origin change.
- Kept: `favicon.ico` (16/32/48 in one), `apple-touch-icon.png`,
  `site.webmanifest` + `icon-192/512.png` (Android only). Dropped from the
  generator's output: the PNG favicons (redundant with the `.ico`) and the
  opaque-white PNG wordmark. `serve.py` maps `.webmanifest`, which `mimetypes`
  lacks.
