# glace-viewer

Quick-look web viewer for **GLACE** — resolution-weighted Sentinel-1 coherence
and backscatter composites of the European Alps.

The composites are produced by [deep-glacier-mapping](https://github.com/lqgentner/deep-glacier-mapping),
which also exports the glacier inventory data shown here; they are published as
a STAC catalog by [glace-catalog](https://github.com/lqgentner/glace-catalog),
which is what this page reads. This repository holds only the viewer page and
its overlays.

## Technology

Plain HTML/CSS/JS — no build step, no framework. The GLACE rasters and the
glacier inventory overlays are [PMTiles](https://protomaps.com/docs/pmtiles)
archives read straight from object storage over HTTP range requests. The
[Protomaps](https://protomaps.com) basemap and the [Mapterhorn](https://mapterhorn.com)
terrain are instead served as TileJSON tile endpoints. Rendering is
[MapLibre GL JS](https://maplibre.org/).

## Sources & attribution

| | source |
| --- | --- |
| GLACE rasters | the [`glace-ch` store](https://source.coop/lqgentner/glace-ch) on Source Cooperative — derived from Copernicus Sentinel-1 data |
| Basemap | [Protomaps](https://protomaps.com) vector tiles (OpenStreetMap data) via their [hosted API](https://protomaps.com/api), or Esri World Imagery |
| Terrain | [Mapterhorn](https://mapterhorn.com) global DEM |
| Glacier inventories | Swiss Glacier Inventory 2016 & 2023, and the Paul et al. 2020 Alpine Glacier Inventory |

Basemap, terrain and raster credits appear live in the map's attribution
control as the layers that use them are switched on. The glacier inventories
are third-party datasets (all CC BY 4.0) redistributed here in simplified
form — each carries its own citation and licence behind the info mark next to
its toggle in the panel. The MIT licence in this repository covers the viewer
code only, not the inventory data — see [`LICENSE`](LICENSE).

## Development

See [`AGENTS.md`](AGENTS.md) for running the viewer locally, the published
store layout, tests and deployment.
