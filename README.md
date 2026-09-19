<p align="center">
  <br />
  <img src="https://data.source.coop/lqgentner/glace-ch/_assets/glace-wordmark.svg" alt="GLACE" width="350">
  <br />
</p>

<h1 align="center">GLACE Viewer</h1>

<p align="center">
  A web map for GLACE Alps built with MapLibre GL JS
  <br />
  Sentinel-1 interferometric coherence and backscatter composites of the European Alps
  <br />
  <br />
  <a href="https://lqgentner.github.io/glace-viewer">🗺️ Web map</a>
  ·
  <a href="https://source.coop/lqgentner/glace-ch">💾 Dataset on Source Coop</a>
  ·
  <a href="https://browser.portolan-sdi.org/#/external/data.source.coop/lqgentner/glace-ch/catalog.json">🧭 Portolan/STAC browser</a>
  ·
  <a href="https://github.com/lqgentner/glace-production">⚙️ Production pipeline</a>
</p>

## About

GLACE Viewer is a web map for exploring annual Sentinel-1 coherence and
backscatter composites. It provides a visual overview of the data, with glacier
outlines and terrain for context.

You can choose among the available years, VV or VH polarization, false color,
and quality layers. The map also offers adjustable raster opacity, vector or
satellite basemaps, hillshade, 3D terrain, glacier inventories, and
the catalog's tile grid. Available raster choices come from the catalog.

The displayed rasters have their colors baked in. For numerical analysis,
use the COG assets linked from the STAC items in the browser above.

## Run locally

Install [pixi](https://pixi.sh), then run these commands from the repository root.
First, build the glacier inventory tiles from the committed GeoJSON:

```sh
pixi run --locked build-tiles
```

Then, serve the website:

```sh
pixi run --locked serve
```

Open **http://localhost:8000/**. Use `localhost`: the configured basemap's
local-development access does not work with `127.0.0.1`. The viewer reads GLACE
rasters from Source Cooperative by default; you do not need a local copy.

To view a local catalog, mount its root and select it in the URL:

```sh
pixi run --locked serve --tiles-dir /path/to/catalog-root
```

Then open **http://localhost:8000/?tiles=tiles**. The directory should contain
`mosaics/collection.json`; pointing at the archive directory alone is not enough.

## Repository

The page uses HTML, CSS, and native JavaScript modules with MapLibre GL JS.
There is no frontend build step or application server. Raster and inventory
PMTiles are read through HTTP range requests; the supplied development server
supports those requests.

- `index.html`, `style.css`, `js/`: the viewer.
- `site-config.js`: deployment settings, including the catalog URL.
- `data/`: glacier inventory GeoJSON and its metadata; PMTiles are generated.
- `scripts/`, `tests/`: local serving, tile generation, and checks.

Run the tests with `pixi run --locked test`. GitHub Actions tests changes and
publishes the site to GitHub Pages on pushes to `main`. See [AGENTS.md](AGENTS.md)
for architecture, data contracts, and maintenance guidance.

## Data and credits

The map uses [Protomaps](https://protomaps.com/) with
[OpenStreetMap](https://www.openstreetmap.org/about) data or
[Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9)
for its basemap, and [Mapterhorn](https://mapterhorn.com/) for terrain.
Glacier outlines come from the
[Swiss Glacier Inventories 2016 and 2023](https://www.glamos.ch/en/downloads),
[Austrian Glacier Inventory 5](https://doi.org/10.1594/PANGAEA.991106),
[Paul et al.'s Alpine Glacier Inventory](https://doi.org/10.1594/PANGAEA.909133),
and [Randolph Glacier Inventory 7.0](https://doi.org/10.5067/f6jmovy5navz) (Alps).

Source credits appear on the map. Inventory citations and licenses are available
beside each toggle and in [data/inventories.json](data/inventories.json).

The viewer code is [MIT licensed](LICENSE). The glacier inventories, basemaps,
and elevation data come from third parties and have their own licenses.
Their attribution is displayed in GLACE Viewer.
