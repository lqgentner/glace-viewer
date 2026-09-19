# Working on GLACE Viewer

Read [README.md](README.md) for the project scope and local startup. This file
records the contracts and cross-file dependencies to preserve when changing the
viewer. Detailed algorithms belong beside their implementations; avoid copying
catalog values, dependency versions, or benchmark results into this file.

Use US English for documentation, interface text, and comments. Preserve source
URLs and verbatim third-party citations.

## Development and validation

Work from the repository root. Use the environment in `pixi.toml` and
`pixi.lock`; it supplies Python, Node, and tippecanoe on Linux x86-64 and Apple
silicon. jsdom is a development dependency locked separately by npm.

```sh
pixi run --locked build-tiles  # required for local inventory overlays
pixi run --locked serve       # http://localhost:8000/
pixi run --locked test        # Python + npm ci + JavaScript tests
```

For focused checks, use `pixi run --locked test-py` or
`pixi run --locked test-js`. There is no compilation, bundling, or runtime npm
installation. Browser dependencies are pinned CDN imports in `index.html` and
`js/config.js`. Keep MapLibre's CSS and JavaScript pins aligned. The `lerc`
import-map entry and `cogReaderUrl` must be changed together; the comment in
`index.html` explains the loader constraint.

Use the supplied server, which implements byte ranges and disables caching for
page code and JSON. Open `localhost`, not `127.0.0.1`, for the configured
Protomaps API's local-development access. To inspect a local store:

```sh
pixi run --locked serve --tiles-dir /path/to/catalog-root
# Open http://localhost:8000/?tiles=tiles
```

`--tiles-dir` mounts a directory; it does not change the viewer configuration.
A gitignored `tiles` symlink to the catalog root also works. The root is above
`mosaics/` and `tiles/`, not the directory containing only PMTiles archives.

## Code map

| Location | Responsibility |
| --- | --- |
| `index.html`, `style.css` | Page structure, initial control values, responsive panel, sky appearance |
| `js/app.js` | Startup and control event wiring |
| `js/config.js`, `site-config.js` | Resolved settings and deployment overrides |
| `js/map.js` | Map singleton, style readiness, draw order, basemap, labels, terrain |
| `js/store.js` | Catalog/style/item reads and validation; one record per raster archive |
| `js/rasters.js` | Raster selection, source creation, panel axes, legends |
| `js/overlays.js` | Inventory controls, overlay lifecycle, grid layers, feature popups |
| `js/tile-grid.js` | GeoParquet index to deduplicated tile footprints |
| `js/ui.js` | DOM helpers, status messages, segmented controls, popovers |
| `js/sky.js` | Globe silhouette measurements for CSS |
| `js/cog-rgb.js` | Registered but unused COG rendering protocol |
| `scripts/serve.py` | Development HTTP server and local catalog mount |
| `scripts/build-tiles.py` | Inventory GeoJSON to vector PMTiles |
| `data/inventories.json` | Inventory build settings, display metadata, citations and licenses |

The inline module in `index.html` exposes `maplibregl`, `pmtiles`, and
`basemaps` as globals before application startup. The modules use those globals
so tests can substitute fakes. Preserve that setup when changing imports.

## Reading the catalog

`site-config.js` selects the store. Treat its extent, years, layer availability,
and legend values as data, not application constants.
The viewer reads the mosaics collection directly; it does not discover it by
walking `catalog.json`.

Relevant paths under the configured catalog root are:

```text
catalog.json
mosaics/collection.json
mosaics/styles/{year}.json
mosaics/{year}/item.json
mosaics/{year}/*_viz.pmtiles
mosaics/{year}/*.tif
tiles/items.parquet
```

`js/store.js` combines three inputs:

1. Collection links with `rel="pmtiles"` enumerate the archives. Their
   `pmtiles:layers` values are the join keys and MapLibre layer IDs, for example
   `glace-coh12_vv_qa_num-2024`. Resolve hrefs against the document containing them.
2. Collection assets with the `style` role describe the layers. Styles are
   indexed by year, with a `default` role for fallback. The join checks the
   year's exact ID, the default's exact ID, then the same stem in the year's
   and default styles. Enumerate from the collection, never from a style.
3. Linked items supply `start_datetime` and `end_datetime` for the acquisition
   window. The item ID's final year associates the dates with the layers.

`metadata.portolan:legend` supplies color stops, range, units, and RGB channel
recipes; style sources supply zoom limits. Do not maintain a second copy in the
viewer or infer RGB stretches from sibling layers. Fixed stretches allow
comparison across years. Changes to raster rendering belong in the upstream
store, since the viewer displays pre-styled RGBA archives.

Incomplete layers are skipped with a warning. A failed collection or nominated
style prevents raster startup; an unreadable item only removes its date line.
If there are no drawable rasters, the raster controls hide and report the
problem. Inventories and basemap controls initialize independently.

PMTiles metadata supplies bounds and attribution through
`pmtiles.Protocol({ metadata: true })`. Do not override those on raster sources.
Remote stores need anonymous reads, CORS, and exposed range headers:
`Content-Range`, `Content-Length`, `Accept-Ranges`, and `ETag`. Missing headers
can look like an invalid archive.

## Map lifecycle and rendering

- Wire controls before network loading completes. Map mutations await the
  shared `styleReady` promise from `style.load`. Do not wait for a new `load`
  event when tiles start streaming: that event fires only once.
- Add data layers through `addStacked()`. Bottom to top: basemap fills or
  imagery, GLACE rasters, hillshade, vector overlays, basemap labels. Lazy
  creation means click order must not determine draw order.
- Raster sources and layers are retained after first display, then hidden on
  selection changes. Basemap switching also changes visibility rather than
  replacing the entire style and discarding data layers.
- Hillshade and 3D share one lazily created DEM source. Keep hillshade neutral:
  transparent highlights and black shadows darken the raster without tinting
  its color map. The strength control changes shadow alpha.
- The 3D button names its next action and changes both terrain and pitch.
  Restore terrain for an incoming pitched URL hash without moving the camera.
  The initial view is used only without a hash; do not fit to catalog bounds.
- Adjust label colors through the Protomaps flavor before generating layers.
  Labels have their own visibility toggle, including over World Imagery.
- Keep the renderer credit on the attribution control. Source attribution
  replaces TileJSON attribution; it does not append to it. The combined
  OpenStreetMap/Protomaps string preserves their order when MapLibre sorts
  credits by length.

The globe projection transitions to Mercator at close zooms. `getProjection()`
reports the configured projection, so its type alone cannot determine whether
space is visible. `js/sky.js` samples the visible horizon using MapLibre's
camera defaults and writes CSS properties on movement. Keep this event-driven;
there is no animation loop. Changes to the camera's field of view or globe
scaling require revisiting the silhouette calculation and `sky.test.js`.

## Controls and external text

The catalog's polarization field encodes VV, VH, RGB, and QA suffixes.
`js/rasters.js` splits it into Polarization and Layer rows. Its allowlist drops
unsupported values silently; extending the store may therefore require extending
the panel. Product labels are presentation only; `data-value` retains the
catalog spelling.

Preserve the distinction between an unavailable combination and a missing
archive. RGB with QA uses `aria-disabled` but remains clickable: the other row
falls back through `GIVES_WAY`. A choice with no archive in the selected year
uses `disabled` and refuses the click. Product does not participate in that
fallback. Hide the Layer row when only one quantity is available.

Construct catalog text, inventory metadata, and vector-tile properties with
`h()`, DOM nodes, or `textContent`, never HTML interpolation. Citation URLs go
through the scheme check in `js/ui.js`. Status entries are keyed by component;
clear only the reporting component's entry so one success cannot hide another
component's failure.

The panel's 640 px breakpoint must agree in `js/app.js` and `style.css`. CSS
provides the collapsed mobile state before scripts run. Preserve the panel's
clearance for map controls and the scale bar. Initial opacity and hillshade
strength in `index.html` must agree with their module defaults. Popovers live
outside the scrolling panel; avoid replacing a color-map credit button while
its unchanged credit is being read.

## Inventories and the tile grid

Commit inventory GeoJSON and metadata; build `data/*.pmtiles`, which are
ignored by git. `scripts/build-tiles.py` reads archive names, source-layer names,
and zoom limits from `data/inventories.json`. Update that index with an inventory
change and retain its citation and license. A wrong `source_layer` can produce
an empty overlay without an error. Force a full rebuild after a tippecanoe
upgrade; `--skip-existing` compares only source and index timestamps.

Inventories load on first activation. `LazyOverlay` removes failed layers and
sources, unticks the control, and permits retry. Preserve that recovery path.
Popup properties can be absent: tippecanoe drops nulls, including missing names.
Respect `has_names` and the inventory's identifier fields.

### The tile grid

`tiles/items.parquet` supplies geometry, MGRS tile ID, and two glacier-fraction
columns. `js/tile-grid.js` imports hyparquet on demand and collapses repeated
(tile, year) rows to one feature per tile. It passes GeoJSON to MapLibre;
there is no separate grid archive to build. Column projection reduces decoding
work but does not guarantee a smaller download. The current reader handles
SNAPPY; a ZSTD index would require additional decompressor support.

### The COG reader

`glace-rgb://` is registered and tested, but no visible layer uses it. It assumes
COGs aligned to the WebMercatorQuad grid; the published ETRS89-LAEA mosaics do
not satisfy that assumption. Do not wire those COGs into it without addressing
the projection. The protocol handles linear-to-dB conversion and treats decoded
zero as nodata to compensate for the reader discarding LERC validity masks.
Those assumptions need validation against any replacement dataset.

## Tests and deployment

The JavaScript suites use jsdom and the strict fake MapLibre in
`tests/helpers/browser.js`. Duplicate layers, missing sources, and writes to
unadded layers throw. These tests check application behavior, not actual WebGL
rendering or CDN availability; inspect visual changes in a real browser too.

Modules hold state and the map is a singleton. Put scenarios needing a fresh
catalog, viewport, or initial camera in separate test files so `node --test`
isolates them. Tests use committed fixtures, never a developer's `./tiles`:
`store/` represents a published catalog with reduced item geometry, and
`two-years/` exercises missing combinations and style fallback.

Use the relevant suites when changing behavior:

| Change | Tests |
| --- | --- |
| Settings, catalog joins, selection and legends | `config`, `store`, `layers`, `store-catalog`, `viewer` |
| Overlay loading, retries, popups | `viewer`, `tile-grid`, `ui` |
| Startup failures, viewport, camera, labels | `viewer-degraded`, `viewer-no-webgl`, `viewer-narrow`, `viewer-3d-restore`, `viewer-light-flavor` |
| Globe or COG calculations | `sky`, `cog-rgb` |
| Static assets and dependency pins | `page-assets` |
| Server or inventory build | `test_serve.py`, `test_build_tiles.py` |

JavaScript names above refer to `tests/<name>.test.js`. Server traversal tests
send raw socket requests because HTTP clients normalize paths before sending.
Keep that coverage when changing `/tiles` containment or range handling.

GitHub Actions runs both suites on pull requests. On pushes to `main`, the
Pages workflow runs the same checks, builds inventory PMTiles, and stages the
page, settings, `js/`, `assets/`, archives, and inventory index. It excludes
GeoJSON. New runtime files must be included in that staging step. Keep asset
URLs relative so the site works under a Pages project subpath. Pages must use
**GitHub Actions** as its source; branch publishing skips tile generation.

`CLAUDE.md` points to this file; keep one set of contributor instructions.
