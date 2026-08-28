# glace-viewer

Quick-look web viewer for **GLACE** — resolution-weighted Sentinel-1 coherence
and backscatter composites of the European Alps.

Everything on the map is a PMTiles archive read straight from object storage
over HTTP range requests: the GLACE rasters, the [Protomaps](https://protomaps.com)
basemap, the [Mapterhorn](https://mapterhorn.com) terrain and the glacier
inventory overlays. There is no tile server anywhere in the stack, and the page
is plain HTML/CSS/JS with no build step or framework.

| | source |
| --- | --- |
| GLACE rasters | object storage, via `?tiles=<base-url>` (default `./tiles`) |
| Basemap | Protomaps `grayscale`, from the free [Source Cooperative](https://source.coop/) mirror |
| Terrain | Mapterhorn global DEM, terrarium-encoded |
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

`.github/workflows/test.yml` runs both on every push and pull request. Neither
suite builds anything: the Python side is stdlib only, and the JavaScript side
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
| `map.js` | the map, layer ordering, basemap labels, hillshade |
| `rasters.js` | the `layers.json` manifest, layer selection, legend |
| `overlays.js` | glacier inventories, catalog tile grid, popups |
| `ui.js` | status line, attribution popovers, safe DOM helpers |
| `app.js` | control wiring and startup |

Nothing on the map is created until something asks for it: a raster source
appears the first time its year is selected, the terrain the first time the
hillshade is ticked, an inventory the first time its box is. Every control is
wired before anything has loaded and every handler that touches the map awaits
`style.load`, so a box ticked while the basemap is still streaming is honoured
when the style arrives rather than dropped.

Anything that reaches the page from a manifest or a vector tile — a glacier
name, a citation, a licence link — is built as DOM nodes rather than as an HTML
string, so a value containing markup stays a value.

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

The Mapterhorn hillshade is optional (checkbox) and sits above the data but below
the labels. **MapLibre has no layer blend modes**, so a literal `multiply` is not
available; the equivalent for shaded relief is a hillshade with fully transparent
highlights and black shadows — lit slopes leave the data untouched and shaded
slopes darken it, which is what multiplying by a shading layer does. There is no
`hillshade-opacity` property either, so the strength slider drives the alpha of
the shadow and accent colours.


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
