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
`js/config.js`. Keep MapLibre's CSS and JavaScript pins aligned.

`index.html` carries a Content-Security-Policy and Subresource Integrity, and
`page-assets.test.js` checks both offline. When changing a pin, update the
import map's `integrity` entry, or the stylesheet's `integrity` attribute, with
`curl -s URL | openssl dgst -sha384 -binary | openssl base64 -A`. The worker and
MapLibre's sibling chunk follow the main module's version. When editing either
inline script, replace its `sha256-` hash in the policy; the test prints the
failing script. hyparquet from esm.sh has no hash because esm.sh builds per
browser. A new script or data host needs a CSP entry. Module workers' imports
fall under `worker-src`, not `script-src`.

The head preloads the default `mosaics/collection.json` and every module that
`app.js` reaches. Keep the preload equal to `site-config.js`'s `tilesBase`, and
add a new `js/` module to the `modulepreload` list; the tests enforce both.

Use the supplied server, which implements byte ranges and disables caching for
page code and JSON. `sw.js` serves JSON stale-while-revalidate on the deployed
site, so a catalog change shows on the next visit. It is not registered on
`localhost` or `127.0.0.1`. To discard every client's cache, rename its `CACHE`. Open `localhost`, not `127.0.0.1`, for the configured
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
| `js/rasters.js` | Raster selection, source creation, panel axes, legend and scale editing |
| `js/composite.js` | False color composed from VV and VH archives via `glace-rgb://` |
| `js/archive.js` | Shared PMTiles readers, their byte cache, the `pmtiles://` protocol |
| `js/values.js` | Tile decoding for false-color composites and histograms |
| `js/histogram.js` | Archive codes or composite channels counted over the view, drawn as the scale editor's bars; the pixel under a click |
| `js/overlays.js` | Inventory controls, overlay lifecycle, grid layers, popups with the raster's value |
| `js/tile-grid.js` | GeoParquet index to deduplicated tile footprints |
| `js/ui.js` | DOM helpers, status messages, choices in the URL, segmented controls, popovers, pickers |
| `js/sky.js` | Globe silhouette measurements for CSS |
| `sw.js` | Service worker: stale-while-revalidate for JSON reads |
| `scripts/serve.py` | Development HTTP server and local catalog mount |
| `scripts/build-tiles.py` | Inventory GeoJSON to vector PMTiles |
| `scripts/colormaps.py` | Writes `js/colormaps.js` (`uv run`) |
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
tiles/items.parquet
```

`js/store.js` combines three inputs:

1. Items linked from the collection with `rel="item"` enumerate the archives:
   each PMTiles asset with the `visual` role is one. The layer ID, which is both
   the join key and the MapLibre layer ID, is derived as `glace-{stem}-{year}`
   from the asset key without its `_viz` suffix and the item ID's final year:
   `coh12_vv_qa_num_viz` in `alps-mosaic-2024` is `glace-coh12_vv_qa_num-2024`.
   Resolve asset hrefs against the item, so a store served through `?tiles=`
   reads its own archives. The item's `start_datetime` and `end_datetime` give
   the acquisition window, and the asset's `bands[0].unit` the units. The
   collection carries no archive links.
2. Collection assets with the `style` role decode the archives: each
   `color-relief` layer draws a `raster-dem` source with a custom encoding.
   Styles are indexed by year, with a `default` role for fallback. The join
   checks the year's exact ID, the default's exact ID, then the same stem in
   the year's and default styles. Enumerate from the items, never from a style:
   a style can name an archive a partial build never produced.
3. The collection's `renders[<stem>].rescale` gives each layer's default
   stretch.

The style's sources supply each archive's custom encoding, zoom limits and
credit; its ramp is not read. Default color maps and the false-color blue range
are viewer constants in `js/rasters.js` and `js/composite.js`, because they are
presentation, not data. Stretches are fixed per layer so years stay comparable.

Incomplete layers are skipped with a warning. A failed collection or nominated
style prevents raster startup; an unreadable item removes that year's layers.
If there are no drawable rasters, the raster controls hide and report the
problem. Inventories and basemap controls initialize independently.

PMTiles metadata supplies bounds and attribution through
`pmtiles.Protocol({ metadata: true })`. Do not override those on raster sources.
Remote stores need anonymous reads, CORS, and exposed range headers:
`Content-Range`, `Content-Length`, `Accept-Ranges`, and `ETag`. Missing headers
can look like an invalid archive.

### False color

`js/composite.js` derives one RGB record per product and year with VV and VH
data layers and serves it through `glace-rgb://`, decoding both archives' tiles
with `js/values.js`. Red and green default to the single-band default
stretches; blue's range and the span of its editor axis are viewer constants
per product. The scale editor changes all three: new limits reload the source's
tiles, one reload per tiles drawn, because MapLibre requests every tile again
without canceling the last. A pixel needs data in both archives. The protocol
returns an `ImageBitmap`, or an empty buffer that MapLibre draws transparent
where an archive has no tile; a failed read rejects and is not cached.

`js/archive.js` keeps one PMTiles reader per raster archive, registered with
the `pmtiles://` protocol before its source is added, over a byte cache bounded
across archives. MapLibre reloads a `raster-dem` source whenever a layer's
`visibility` changes (only `raster` sources are exempt), so switching layers
re-requests their tiles; the cache serves those, and composites reuse the bytes
MapLibre read. It hands out copies, keeps no failed reads, and lets an aborted
caller stop waiting without canceling a read others share. The composite source carries the style source's credit
because it has no TileJSON.

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
- The "Back to the Alps" button flies to the `overview` setting, whose label it
  shows. It appears over the map, with the status line in `#notices`, only while
  the view misses the collection's spatial extent or is zoomed out below the
  rasters.
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
component's failure. Write status text for readers, not developers: say what
failed and what still works or how to retry, and send the error's detail to the
console. `#status-live` announces the status line except progress.

Segmented rows are radio groups: arrow keys select the next choice that is not
`disabled`, and `rove()` makes the checked one the tab stop. Call it after
changing `aria-checked`. The year slider's `aria-valuetext` names the year.

The query string holds the panel's choices (`year`, `product`, `pol`, `layer`,
`opacity`, `cmap`, `range`, `base`) beside the deployment's `tiles`, `basemap`
and `flavor`; MapLibre keeps the camera in the hash. Writes are batched, because
browsers limit `history.replaceState`. A link is read once at startup and
honored only where the catalog has the layer and the limits pass the editor's
checks; otherwise the defaults stand.

A click, or Enter on the focused map for its center, opens one popup: the
selected layer's value on top, from the pixel MapLibre draws at that zoom (VV
and VH for false color), then the overlays under the pointer. A newer click wins
over a slower read. The archives are lossy, so the value is a guide, not data.
The popup has no close button: a click while it is open, a drag, a zoom, a tilt
or Escape closes it. The map shows the arrow cursor, and the move cursor while
pressed.

The panel's 640 px breakpoint must agree in `js/app.js` and `style.css`. CSS
provides the collapsed mobile state before scripts run. Preserve the panel's
clearance for map controls and the scale bar. Initial opacity and hillshade
strength in `index.html` must agree with their module defaults. Popovers live
outside the scrolling panel.

One layout serves mouse and touch. Popovers open on click only: a tap fires
`mouseenter` before its click, so opening on hover made the click close them.
Hover styles sit under `@media (hover: hover)`. The `(pointer: coarse)` block
at the end of `style.css` holds the touch sizes, mostly as invisible `::after`
tap areas that leave the layout alone. It also raises `--text-scale`, so write
every font size as a multiple of it and text grows uniformly on touch screens.
Below 640 px the status message sits above the scale bar, clear of the panel
toggle. The expanded attribution may cover the scale bar until MapLibre
collapses it on the first drag, which the OSMF attribution guidelines allow.

The legend only displays. Its Edit button's `::after` covers the whole legend,
so a click anywhere on it toggles `#scale-editor`, a non-modal `<dialog>`:
beside the panel, or in the panel's place below 640 px. The map stays live, and
the close button or Escape closes it. It holds one block per band from
`#band-template`: one for a value-encoded layer, three for false color, whose
ratio channel has a fixed axis of 255 steps. Each histogram counts the band in
the view at the zoom MapLibre draws, coarser past a tile budget sized to the
viewport, again after each `moveend`; a recount keeps the old bars until it is
ready, and the presets wait for it. Bars span three codes and average the codes
counted, because lossy WebP never produces about one code in seven. The open editor follows the selection
and closes when the selection has no layer. The axis spans codes 1-255, and the
limits are handles on it: a press moves the nearer one. A touch moves it only
once it travels across, or as a tap, so a vertical swipe scrolls the editor.
2–98%, Min/Max and Reset act on every band; the presets fit the limits to the
counts. Limits apply as they are typed or dragged, and render never overwrites
the field being typed in. A refused value flags its field and shows why below
the presets. Leaving a field shows what is drawn, which discards invalid text
and the reason. A color map applies on click and the dialog stays open; false
color has none. Choices are kept per layer stem, and Reset restores the default
limits only. Limits outside the archive's codes 1-255 are refused: below, the
ramp falls into the nodata stop; above, MapLibre's packed ramp wraps around.
The ratio's limits stay on its axis. Keep the dialog's fields at 16 px or more
on touch screens, or iOS zooms into them.

## Inventories and the tile grid

Commit inventory GeoJSON and metadata; build `data/*.pmtiles`, which are
ignored by git. `scripts/build-tiles.py` reads archive names, source-layer names,
and zoom limits from `data/inventories.json`. Update that index with an inventory
change and retain its citation and license. A wrong `source_layer` can produce
an empty overlay without an error. Force a full rebuild after a tippecanoe
upgrade; `--skip-existing` compares only source and index timestamps.

Inventories load on first activation. `LazyOverlay` runs one load at a time and
ends it showing the latest tick. It removes failed layers and sources, unticks the
control, and permits retry. Preserve that recovery path.
Popup properties can be absent: tippecanoe drops nulls, including missing names.
Respect `has_names` and the inventory's identifier fields.

### The tile grid

`tiles/items.parquet` supplies geometry, MGRS tile ID, and two glacier-fraction
columns. `js/tile-grid.js` imports hyparquet on demand and collapses repeated
(tile, year) rows to one feature per tile. It passes GeoJSON to MapLibre;
there is no separate grid archive to build. Column projection reduces decoding
work but does not guarantee a smaller download. The current reader handles
SNAPPY; a ZSTD index would require additional decompressor support.

## Tests and deployment

The JavaScript suites use jsdom and the strict fake MapLibre in
`tests/helpers/browser.js`. Duplicate layers, missing sources, and writes to
unadded layers throw. jsdom's dialogs skip the focusing steps, so the helper's
`show()` opens the dialog and focuses its `autofocus` element, and its `close()`
fires `close` at once where browsers queue it. These tests check
application behavior, not actual WebGL rendering or CDN availability; inspect
visual changes in a real browser too.

Modules hold state and the map is a singleton. Put scenarios needing a fresh
catalog, viewport, or initial camera in separate test files so `node --test`
isolates them. Tests use committed fixtures, never a developer's `./tiles`:
`store/` copies the glace-alps mosaics with item geometry removed, and
`two-years/` exercises missing combinations and style fallback.

Use the relevant suites when changing behavior:

| Change | Tests |
| --- | --- |
| Settings, catalog joins, selection and legends | `config`, `store`, `layers`, `store-catalog`, `store-local`, `legend`, `viewer`, `stale-state` |
| False color, tile decoding and caching | `composite`, `encoded`, `archive`, `histogram` |
| Overlay loading, retries, popups, the value under a click | `viewer`, `tile-grid`, `ui`, `stale-state`, `readout` |
| Choices in the URL | `url-state`, `url-state-invalid` |
| Startup failures, viewport, camera, labels | `viewer-degraded`, `viewer-no-webgl`, `viewer-narrow`, `viewer-3d-restore`, `viewer-light-flavor` |
| Globe calculations | `sky` |
| Static assets, dependency pins, CSP, integrity, preloads | `page-assets` |
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
