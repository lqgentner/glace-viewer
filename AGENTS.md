# Working on GLACE Viewer

Read [README.md](README.md) for the project scope and local startup. This file
records the contracts and cross-file dependencies to preserve when changing the
viewer. Detailed algorithms belong beside their implementations; avoid copying
catalog values, dependency versions, or benchmark results into this file.

Use US English for documentation, interface text, and comments. Preserve source
URLs and verbatim third-party citations.

## Development and validation

Work from the repository root with the Node version in `.node-version`, after
`npm ci`. npm locks the page's libraries and the test dependencies. Building
the inventory overlays also needs tippecanoe on `PATH`; nothing else does.

```sh
npm run build-tiles  # required for local inventory overlays
npm run serve        # http://localhost:8000/
npm test             # node --test: every tests/*.test.js
```

Run `node --test tests/<name>.test.js` for a focused check. There is no
compilation or bundling, and no Python: `scripts/colormaps.py` declares its
dependencies for `uv run` and runs only when the color maps change. The page's
libraries are npm `dependencies`, loaded unchanged from `./node_modules/`
through the import map in `index.html`; `npm ci` puts them there. Dependabot
moves them with the test dependencies in one monthly PR. A library the page
loads must be a direct dependency, so npm installs it where the import map
looks, and needs its license in `assets/third-party-licenses.txt`. Import-map
addresses must start with `./`, or browsers ignore them.

`index.html` carries a Content-Security-Policy that allows only same-origin
scripts and styles, and `page-assets.test.js` checks it offline. When editing
either inline script, replace its `sha256-` hash in the policy; the test prints
the failing script. A new data host needs a CSP entry. Module workers' imports
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
npm run serve -- --tiles-dir /path/to/catalog-root
# Open http://localhost:8000/?tiles=tiles
```

`--tiles-dir` mounts a directory; it does not change the viewer configuration.
A gitignored `tiles` symlink to the catalog root also works. The root is above
`mosaics/` and `tiles/`, not the directory containing only PMTiles archives.

## Code map

| Location | Responsibility |
| --- | --- |
| `index.html`, `style.css` | Page structure, initial control values, responsive panel and sheet, the space behind the globe |
| `js/app.js` | Startup and control event wiring |
| `js/config.js`, `site-config.js` | Resolved settings and deployment overrides |
| `js/map.js` | Map singleton, style readiness, draw order, basemap, labels, terrain |
| `js/store.js` | Catalog/style/item reads and validation; one record per raster archive |
| `js/sheet.js` | The panel as a bottom sheet on phones: drag, snap, the properties CSS reads, popup padding |
| `js/rasters.js` | Raster selection, source creation, panel axes, legend and scale editing |
| `js/composite.js` | False color composed from VV and VH archives via `glace-rgb://` |
| `js/archive.js` | Shared PMTiles readers, their byte cache, the `pmtiles://` protocol |
| `js/values.js` | Tile decoding for false-color composites and histograms |
| `js/histogram.js` | Archive codes or composite channels counted over the view, drawn as the scale editor's bars; the pixel under a click |
| `js/overlays.js` | Inventory controls, overlay lifecycle, grid layers, popups with the raster's value |
| `js/ui.js` | DOM helpers, status messages, choices in the URL, segmented controls, popovers, pickers |
| `js/controls.js` | The map's controls: compass, 3D, zoom |
| `js/status.js` | The status line: scale bar and grouped credits, with the terrain and imagery sources in view |
| `sw.js` | Service worker: stale-while-revalidate for JSON reads |
| `scripts/serve.mjs` | Development HTTP server and local catalog mount |
| `scripts/stage-libraries.mjs` | Copies the import map's library directories into the Pages site |
| `scripts/build-tiles.mjs` | Inventory GeoJSON to vector PMTiles |
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
mosaics/styles/default.json
mosaics/{year}/item.json
mosaics/{year}/styles/default.json
mosaics/{year}/*_viz.pmtiles
tiles/grid.pmtiles
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
2. Styles decode the archives: each `color-relief` layer draws a `raster-dem`
   source with a custom encoding. Each item's asset with the `style` role is
   its year's style, resolved against the item; the collection's is the latest
   year's and the fallback for an item without one. Where a document has
   several, the one with the `default` role wins; never key on titles. The join
   checks the year's exact ID, the collection style's exact ID, then the same
   stem in the year's and the collection's styles. Enumerate from the items,
   never from a style: a style can name an archive a partial build never
   produced.
3. The collection's `renders[<stem>].rescale` gives each layer's default
   stretch.

The style's sources supply each archive's custom encoding, zoom limits and
credit; its ramp is not read. Default color maps and the false-color blue range
are viewer constants in `js/rasters.js` and `js/composite.js`, because they are
presentation, not data. Stretches are fixed per layer so years stay comparable.

Incomplete layers are skipped with a warning. A failed collection or
collection style prevents raster startup; an unreadable item or item style
removes that year's layers, since the collection's style credits another year.
While the catalog loads, `#raster-controls` is `aria-busy`: its markup holds
invisible placeholders the size of the default layer's controls under a loading
line, and the band's legend reads "Loading layers…", so the panel and the
compact sheet do not resize when the catalog arrives. Keep the placeholders
matched to the loaded controls. A year without the selected combination puts
"No <layer> for <year>" in the legend's place. With no drawable rasters, the
Layers tab hides, another is selected, the legend reads that the layers could
not load, and the status line reports the problem. Inventories and basemap
controls initialize independently.

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
caller stop waiting without canceling a read others share. Every pmtiles reader
the page makes, the rasters, the vector overlays and the coverage index, uses
`forgetfulCache()`: pmtiles' own cache keeps a failed header or directory read
for the reader's life, which would leave that part of the map blank, and this
one drops it so the next read asks again, as it does a failed header re-read
after an ETag mismatch. `archive-cache.test.js` checks that against the real
pmtiles, and fails once pmtiles forgets on its own. The composite source
carries the style source's credit because it has no TileJSON. The catalog's
archives, the rasters and the tile grid, read with `cache: "no-store"`: Chrome
lets one request per URL write a cache entry at a time, so parallel range reads
of one archive would queue, and the catalog host's responses are `no-cache`
anyway. After an ETag mismatch pmtiles would read with `cache: "reload"`, which
writes the cache, so `uncachedSource()` keeps its `mustReload` off. The
inventories and Mapterhorn's coverage index allow caching and keep it.

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
  A tilt by hand (a gesture or key, which carries `originalEvent`) past 10°
  turns 3D on where the camera rests; one ending below levels the map in 2D.
  The compass's arrows turn the map by 45°, and its needle faces north and
  leaves 3D. On phones the compass shows only while the map is turned, tilted
  or in 3D, and there are no zoom buttons. Restore terrain for an incoming
  URL hash pitched past 10° without moving the camera. The controls hold the
  3D state; `setThreeD()` changes it.
  The initial view is used only without a hash; do not fit to catalog bounds.
- The "Back to the Alps" button flies to the `overview` setting, whose label it
  shows. It appears over the map, with the status line in `#notices`, only while
  the view misses the collection's spatial extent or is zoomed out below the
  rasters.
- Adjust label colors through the Protomaps flavor before generating layers.
  Labels have their own visibility toggle, including over World Imagery.
- `js/status.js` credits each source a visible layer or the terrain draws,
  from its `attribution` once its metadata arrives, grouped by source ID:
  Layers, Glaciers (the inventories), Basemap, Imagery, Terrain, then MapLibre's credit,
  which depends on no source. Source attribution replaces TileJSON
  attribution; it does not append to it. An inventory's archive has no credit,
  so its source names the one in `inventories.json`. Attribution HTML is
  parsed in an inert template into text and web links, split at `|`.
- Terrain credits the TileJSON's `© Mapterhorn`, then the producers of the
  elevation sources in view, read after each move from Mapterhorn's coverage
  index (`terrainCoverage`, zooms 4 to 12, at most 16 tiles, coarser for a
  wide view). Past 15 sources, Mapterhorn's link stands alone.
- Imagery credits "Powered by Esri", as Esri asks of interactive maps, then
  the contributors in view from Esri's list (`worldImageryAttribution`),
  fetched once and filtered on each move at Esri's tile level, one deeper than
  MapLibre's zoom. Until it arrives, past 15 contributors, or with none in
  view, the service's own sources follow instead.

The globe projection transitions to Mercator at close zooms. MapLibre draws the
atmosphere around the globe from the style's `sky`, fainter over the vector
basemap than over imagery; `setBasemap()` switches it. Its sky and fog colors
stay transparent, so the space in `style.css` shows behind the canvas.

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
or Escape closes it. A click waits 250 ms for a second one, so a double-click
zooms without opening a popup. The map shows the arrow cursor, and the move cursor while
pressed.

The panel is a band over three tabs (Layers, Glaciers, Map) and an About
button. The band holds the wordmark, the legend and, on phones, the handle; it
stays visible when the content is hidden. Phones are `PHONE` in `js/ui.js`, a
coarse pointer at most 640 px wide, which `js/rasters.js` and `js/sheet.js`
share; `style.css` repeats the query and must agree, and `page-assets.test.js`
checks it. The width alone is not enough: a narrow desktop window keeps the
side panel, which suits a mouse, and its scale editor covers the panel.
Elsewhere the panel is always open and cannot be minimized. On phones the panel
docks to the bottom as a sheet with two heights, compact (the band) and open.
CSS provides the compact state before scripts run, so the page loads without a
flash of the open sheet. On the compact sheet the handle's tap area covers the
band, so a tap anywhere opens it, and Edit fades in only as the sheet opens.
`js/sheet.js` only writes `--sheet-progress`, `--sheet-travel` and
`--sheet-visible` on the root, toggles `inert` on the hidden tabs and content
and the `.expanded` and `.dragging` classes on `#panel-shell`, and sets the
handle's `aria-expanded` and label; CSS places the sheet and the map's
furniture from the properties. Leaving the phone layout
clears the properties, `inert` and `.dragging`. A vertical swipe on a range
input belongs to the input, and the content scrolls only while the sheet is
open. Initial opacity and hillshade strength in `index.html` must agree with
their module defaults. Popovers live outside the scrolling panel.

One layout serves mouse and touch. Popovers open on click only: a tap fires
`mouseenter` before its click, so opening on hover made the click close them.
Hover styles sit under `@media (hover: hover)`. The `(pointer: coarse)` block
at the end of `style.css` holds the touch sizes, mostly as invisible `::after`
tap areas that leave the layout alone. It also raises `--text-scale`, so write
every font size as a multiple of it and text grows uniformly on touch screens.
The status line holds the scale bar and the credits in the map's bottom right
corner, as wide as its text up to the window's. A line breaks only between
credits: each is an inline-block box with its comma, the group's label shares
the first, and the "|" hangs into the previous group's margin. `js/status.js`
writes its height to `--status-h`, which the panel and the scale editor end
above. The map's controls are added after it to the same corner, which
MapLibre stacks, so they ride above it; on phones they move to the top right,
because that corner rides the sheet. On phones the status line draws no
scale bar and folds the credits into an info button: open at load, folded on the
first drag of the map, as MapLibre's compact attribution does; the OSMF
attribution guidelines allow that. It rides the sheet's top edge and fades as
the sheet opens. `#notices` rides above it and moves to the top while the
scale editor is open. MapLibre anchors the value popup, so it
shifts sideways near an edge; on phones its `padding` is the sheet's visible
height, so near the sheet it opens upward.

The legend only displays. Its Edit button toggles `#scale-editor`, a non-modal
`<dialog>`: beside the panel, or docked to the bottom on phones, where it stays
above the keyboard and hides the status line. There it slides up as the panel's
sheet slides out, and back down as the sheet returns at the height it had. The
sheet stays laid out, hidden by `visibility`, so it keeps its measured height;
the editor keeps `flex-direction` while closed, because `display` lingers for
the exit slide. The map stays live, and the close button or Escape closes it.
It holds one block per band from `#band-template`: one for a value-encoded
layer, three for false color, whose ratio channel has a fixed axis of 255
steps. Each histogram counts the band in the view at the zoom MapLibre draws,
coarser past a tile budget sized to the viewport, again after each `moveend`; a
recount keeps the old bars until it is ready. The presets stay available
meanwhile, so they do not flicker; one pressed during a recount applies to the
new counts. Bars span three codes and average the codes counted, because lossy
WebP never produces about one code in seven. The open editor follows the
selection and closes when the selection has no layer. The axis spans codes
1-255, and the limits are handles on it: a press moves the nearer one. A touch
moves it only once it travels across, or as a tap, so a vertical swipe scrolls
the editor. 2–98%, Min/Max and Reset act on every band; the presets fit the
limits to the counts. Limits apply as they are typed or dragged, and render
never overwrites the field being typed in. A refused value flags its field and
shows why below the presets. Leaving a field shows what is drawn, which
discards invalid text and the reason. A color map applies on click and the
dialog stays open; false color has none. Choices are kept per layer stem, and
Reset restores the default limits only. Limits outside the archive's codes
1-255 are refused: below, the ramp falls into the nodata stop; above,
MapLibre's packed ramp wraps around. The ratio's limits stay on its axis. Keep
the dialog's fields at 16 px or more on touch screens, or iOS zooms into them.

## Inventories and the tile grid

Commit inventory GeoJSON and metadata; build `data/*.pmtiles`, which are
ignored by git. `scripts/build-tiles.mjs` reads archive names, source-layer names,
and zoom limits from `data/inventories.json`. Update that index with an inventory
change and retain its citation and license. A wrong `source_layer` can produce
an empty overlay without an error. The deploy workflow builds tippecanoe from
source at its `TIPPECANOE_VERSION`, which Dependabot does not move. Force a
full rebuild after a tippecanoe upgrade; `--skip-existing` compares only
source and index timestamps.

Inventories and the tile grid load on first activation. `LazyOverlay` adds the
source once and ends showing the latest tick; MapLibre fetches the tiles. It
removes failed layers and sources, unticks the control, and permits retry.
Preserve that recovery path. Unticked while loading, an overlay drops its
loading message, and a failure then goes only to the console.
Popup properties can be absent: tippecanoe drops nulls, including missing names.
Respect `has_names` and the inventory's identifier fields.

### The tile grid

The catalog publishes `tiles/grid.pmtiles`, one vector archive for all years,
under the catalog root; the viewer builds nothing for it. Its `mgrs` layer has
one polygon per MGRS tile with `mgrs_tile`, `glacier_fraction` and
`glacier_fraction_buffered`. `js/overlays.js` draws it through `pmtiles://` with
its own paint, not the catalog's `tiles/styles/grid.json`, and the popup reads
those property names.

## Tests and deployment

The JavaScript suites use jsdom and the strict fake MapLibre in
`tests/helpers/browser.js`. Duplicate layers, missing sources, and writes to
unadded layers throw. jsdom's dialogs skip the focusing steps, so the helper's
`show()` opens the dialog and focuses its `autofocus` element, and its `close()`
fires `close` at once where browsers queue it. These tests check
application behavior, not actual WebGL rendering; inspect visual changes in a
real browser too.

Modules hold state and the map is a singleton. Put scenarios needing a fresh
catalog, viewport, or initial camera in separate test files so `node --test`
isolates them. Tests use committed fixtures, never a developer's `./tiles`:
`store/` copies the glace-alps mosaics with item geometry removed, and
`two-years/` exercises missing combinations and style fallback.

Use the relevant suites when changing behavior:

| Change | Tests |
| --- | --- |
| Settings, catalog joins, selection and legends | `config`, `store`, `layers`, `store-catalog`, `store-local`, `legend`, `legend-narrow`, `viewer`, `stale-state` |
| False color, tile decoding and caching | `composite`, `encoded`, `archive`, `archive-cache`, `histogram` |
| Overlay loading, retries, popups, the value under a click | `viewer`, `tile-grid`, `ui`, `stale-state`, `readout`, `readout-narrow` |
| Choices in the URL | `url-state`, `url-state-invalid` |
| The sheet and tabs | `sheet`, `legend-narrow` |
| The compass, 3D, zoom and tilting | `controls`, `viewer`, `viewer-3d-restore` |
| Startup failures, viewport, camera, labels | `viewer-degraded`, `viewer-degraded-bare`, `viewer-no-webgl`, `viewer-narrow`, `viewer-3d-restore`, `viewer-light-flavor` |
| Static assets, libraries, CSP, preloads, staging | `page-assets`, `stage-libraries` |
| Server or inventory build | `serve`, `build-tiles` |

JavaScript names above refer to `tests/<name>.test.js`. Server traversal tests
send raw socket requests because HTTP clients normalize paths before sending.
Keep that coverage when changing `/tiles` containment or range handling.

GitHub Actions runs the tests on pull requests. On pushes to `main`, the
Pages workflow runs the same checks, builds inventory PMTiles, and stages the
page, settings, `js/`, `assets/`, archives, inventory index, and, through
`scripts/stage-libraries.mjs`, each import-map target's directory without
source maps or development builds. It excludes GeoJSON. New runtime files must
be included in that staging step. Keep asset URLs relative so the site works
under a Pages project subpath. Pages must use **GitHub Actions** as its source;
branch publishing skips tile generation.

`CLAUDE.md` points to this file; keep one set of contributor instructions.
