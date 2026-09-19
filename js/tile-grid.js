/*
 * Read tile footprints from the catalog's GeoParquet index on demand. The reader
 * supports SNAPPY; ZSTD would need hyparquet-compressors. Column projection reduces
 * decode work but may still fetch the whole file.
 */

import { GRID_INDEX_URL, HYPARQUET_URL } from "./config.js";

const COLUMNS = [
  "geometry",
  "glace:mgrs_tile",
  "glace:glacier_fraction",
  "glace:glacier_fraction_buffered",
];

/* hyparquet decodes WKB geometry from the GeoParquet metadata. */
const isPolygon = (geometry) =>
  geometry !== null &&
  typeof geometry === "object" &&
  (geometry.type === "Polygon" || geometry.type === "MultiPolygon") &&
  Array.isArray(geometry.coordinates);

/*
 * Validate fractions from the configurable catalog before using them in paint
 * expressions.
 */
const fraction = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Return GeoJSON with one feature per MGRS tile, deduplicating yearly items.
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

  if (features.length === 0) throw new Error("no tile footprints in the index");
  return { type: "FeatureCollection", features };
}
