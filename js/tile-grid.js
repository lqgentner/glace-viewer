/*
 * The catalog tile grid, read out of the store's own item index.
 *
 * The grid used to be a vector PMTiles archive built alongside the rasters.
 * The store does not publish one — what it publishes is `tiles.parquet`, the
 * stac-geoparquet mirror of every tile Item, which already carries the
 * footprint and the glacier fractions the overlay draws. Reading that directly
 * means the grid needs no product of its own: one fewer thing to build, and one
 * fewer thing that can be stale with respect to the catalogue it describes.
 *
 * hyparquet is what reads it. Like the COG reader it is ESM-only and imported
 * on demand — the grid is off until a reader ticks the box, so nothing is
 * fetched for a page that never asks. Unlike the COG reader it needs no
 * companion codec package: the store's index is SNAPPY, which hyparquet decodes
 * on its own. A store written with ZSTD pages would need
 * `hyparquet-compressors` alongside, and would fail loudly here rather than
 * quietly — the overlay reports what it could not read.
 *
 * Only four columns are read of the ~200 the index carries. Parquet is
 * column-major, so that is four small byte ranges — measured at 9 kB of the
 * 200 kB of column data — and it cuts the decode from ~290 ms to ~5 ms.
 *
 * It does not save the *fetch*, and it is worth being exact about why: this
 * index's footer is ~121 kB, because ~200 columns of STAC metadata carry that
 * much schema and statistics, and hyparquet reads generously to find it rather
 * than pay a second round trip. So the 321 kB file comes down whole whatever
 * the projection asks for. The ratio moves the other way on a larger store,
 * where the data dwarfs the footer.
 *
 * Either way it is paid once, when the box is first ticked. The archive this
 * replaced fetched tiles per viewport for as long as the overlay was on.
 */

import { GRID_INDEX_URL, HYPARQUET_URL } from "./config.js";

/* The footprint, the name, and the two fractions. `bbox` is deliberately not
 * among them — it is the same information as the geometry, and MapLibre wants
 * the geometry. */
const COLUMNS = [
  "geometry",
  "glace:mgrs_tile",
  "glace:glacier_fraction",
  "glace:glacier_fraction_buffered",
];

/* hyparquet reads the geoparquet metadata and hands geometry back already
 * decoded from WKB, so there is no binary parsing here to get wrong. */
const isPolygon = (geometry) =>
  geometry !== null &&
  typeof geometry === "object" &&
  (geometry.type === "Polygon" || geometry.type === "MultiPolygon") &&
  Array.isArray(geometry.coordinates);

/* A number the paint expression can interpolate over, or null. The index is
 * fetched from wherever ?tiles= points, so its columns get the same treatment
 * as the raster manifest's fields rather than being trusted. */
const fraction = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * The grid as GeoJSON, one feature per MGRS tile.
 *
 * The index holds one Item per (tile, year), so a four-year store repeats every
 * footprint four times; the grid is a footprint, so the repeats collapse. The
 * property names are the ones the old archive used, which is why the paint
 * expressions and the popup did not have to change with the source.
 *
 * @returns {Promise<{type: "FeatureCollection", features: object[]}>}
 */
export async function loadTileGrid() {
  const { asyncBufferFromUrl, parquetReadObjects } = await import(HYPARQUET_URL);
  const file = await asyncBufferFromUrl({ url: GRID_INDEX_URL });
  const rows = await parquetReadObjects({ file, columns: COLUMNS });

  const seen = new Set();
  const features = [];
  for (const row of rows) {
    const tile = row["glace:mgrs_tile"];
    if (typeof tile !== "string" || tile === "" || seen.has(tile)) continue;
    if (!isPolygon(row.geometry)) continue;
    seen.add(tile);
    features.push({
      type: "Feature",
      geometry: row.geometry,
      properties: {
        tile,
        glacier_fraction: fraction(row["glace:glacier_fraction"]),
        glacier_fraction_buffered: fraction(row["glace:glacier_fraction_buffered"]),
      },
    });
  }
  // An index that parses but describes no tile is a failure worth reporting,
  // not an empty grid drawn over the map with nothing in it.
  if (features.length === 0) throw new Error("no tile footprints in the index");
  return { type: "FeatureCollection", features };
}
