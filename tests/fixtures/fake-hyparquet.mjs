/*
 * A stand-in for hyparquet, so the tile grid can be exercised without a network
 * or a parquet decoder.
 *
 * The rows are shaped like the store's `tiles.parquet`: one per (tile, year),
 * with the geometry already decoded from WKB — which is what hyparquet does for
 * a geoparquet file, and the reason js/tile-grid.js has no binary parsing in
 * it. Two tiles across two years, so the collapse to one feature per footprint
 * is what the test is watching.
 */

/** Every URL opened and every column list asked for, so a test can assert on
 *  what was read as well as on what came back. */
export const reads = [];

/** Set by a test to make the next read fail, as an unreadable index would. */
export let failure = null;
export const failWith = (error) => { failure = error; };

export async function asyncBufferFromUrl({ url }) {
  reads.push(url);
  return { url };
}

const tile = (name, year, lon, fraction, buffered) => ({
  "glace:mgrs_tile": name,
  "glace:glacier_fraction": fraction,
  "glace:glacier_fraction_buffered": buffered,
  geometry: {
    type: "Polygon",
    coordinates: [[[lon, 46], [lon + 0.1, 46], [lon + 0.1, 46.1], [lon, 46.1], [lon, 46]]],
  },
  datetime: `${year}-08-23T00:00:00.000Z`,
});

export async function parquetReadObjects({ columns }) {
  if (failure !== null) {
    const thrown = failure;
    failure = null;
    throw thrown;
  }
  reads.push(columns.join(","));
  return [
    tile("32TLR48", 2023, 7.0, 0.456, 0.932),
    tile("32TMS12", 2023, 7.2, 0.101, 0.402),
    tile("32TLR48", 2024, 7.0, 0.456, 0.932),
    tile("32TMS12", 2024, 7.2, 0.101, 0.402),
    // Neither of these should reach the map.
    { "glace:mgrs_tile": "", geometry: null },
    { "glace:mgrs_tile": "32TXX99", geometry: { type: "Point", coordinates: [7, 46] } },
  ];
}
