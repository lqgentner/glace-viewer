/*
 * The catalog tile grid, read out of the store's own item index.
 *
 * The store publishes no grid archive; `tiles/items.parquet`, the
 * stac-geoparquet mirror of every tile Item, already carries each footprint and
 * both glacier fractions, so the grid is read from that and cannot disagree
 * with the catalogue it describes.
 *
 * hyparquet reads it, imported on demand the first time the box is ticked. The
 * store's index is SNAPPY, which hyparquet decodes on its own; a ZSTD index
 * would need `hyparquet-compressors` beside it and fails loudly here. Only four
 * columns are read, which is what makes the decode 5 ms rather than 290 — the
 * fetch itself is the whole file either way. Measurements and the reasoning
 * are under "The tile grid" in AGENTS.md.
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
 * as the catalog's fields rather than being trusted. */
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
