/*
 * A stand-in for @developmentseed/geotiff, so tests/cog-rgb.test.js can drive
 * the real protocol without a network or a wasm decoder.
 *
 * The geometry is the `glace-ch` store's, verbatim — the WebMercatorQuad z13
 * grid, 21504x12800 with seven overviews — because that is what the window
 * arithmetic under test is arithmetic about. Only the pixels are invented: a
 * band is filled with one value chosen by its URL, so a composited channel has
 * an arithmetic answer a test can state.
 */

const RESOLUTION = 19.109257071294063;
const ORIGIN_X = 753363.3507786989;
const ORIGIN_Y = 5997554.98736807;
const TILE = 256;

/** URL fragment -> the constant every pixel of that archive decodes to. */
export const VALUES = { coh12_vv: 0.5, coh12_vh: 0.25, rtc_vv: 0.05, rtc_vh: 0.0125 };

/** Tile indices asked for, newest last, so a test can count the reads. */
export const fetched = [];


class Level {
  constructor(url, step) {
    this.url = url;
    this.step = step;
    this.width = Math.ceil(21504 / 2 ** step);
    this.height = Math.ceil(12800 / 2 ** step);
    this.transform = [RESOLUTION * 2 ** step, 0, ORIGIN_X, 0, -RESOLUTION * 2 ** step, ORIGIN_Y];
  }

  get value() {
    const hit = Object.keys(VALUES).find((name) => this.url.includes(name));
    return hit === undefined ? 1 : VALUES[hit];
  }

  async fetchTile(x, y) {
    fetched.push(`${this.url.split("/").at(-1)}@${this.step}:${x},${y}`);
    const bands = [new Float32Array(TILE * TILE).fill(this.value)];
    /* One pixel of every tile is left absent, so the nodata path is exercised
     * by the same fixture that exercises the arithmetic. */
    bands[0][0] = 0;
    return { x, y, array: { bands, count: 1, width: TILE, height: TILE } };
  }
}

export class GeoTIFF extends Level {
  constructor(url) {
    super(url, 0);
    this.overviews = [1, 2, 3, 4, 5, 6, 7].map((step) => new Level(url, step));
  }

  static async fromUrl(url) {
    return new GeoTIFF(url);
  }
}
