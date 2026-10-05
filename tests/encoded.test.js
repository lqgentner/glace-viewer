/* Check the decoding of value-encoded archives. */

import assert from "node:assert/strict";
import test from "node:test";

import { installBrowser, load } from "./helpers/browser.js";

installBrowser();
const { valueEncoding } = await load("js/store.js");
const { decodePixel, step, tilePixel } = await load("js/values.js");

/* rtc_vv as glace-catalog encodes it: -30 to 12 dB over codes 1-255. */
const scale = 42 / 254;
const total = 65536 + 256 + 1;
const SOURCE = {
  type: "raster-dem",
  encoding: "custom",
  redFactor: (scale * 65536) / total,
  greenFactor: (scale * 256) / total,
  blueFactor: scale / total,
  baseShift: 30 + scale,
};

test("a raster-dem source with custom factors declares an encoding", () => {
  const encoding = valueEncoding(SOURCE);
  assert.equal(encoding.encoding, "custom");
  assert.equal(encoding.baseShift, SOURCE.baseShift);
  assert.equal(valueEncoding({ ...SOURCE, type: "raster" }), null);
  assert.equal(valueEncoding({ ...SOURCE, encoding: "terrarium" }), null);
  assert.equal(valueEncoding({ ...SOURCE, blueFactor: "1" }), null);
});

test("a grey pixel decodes to its code times the step", () => {
  const encoding = valueEncoding(SOURCE);
  assert.ok(Math.abs(step(encoding) - scale) < 1e-12);
  assert.ok(Math.abs(decodePixel(encoding, 1, 1, 1) - -30) < 1e-9);
  assert.ok(Math.abs(decodePixel(encoding, 255, 255, 255) - 12) < 1e-9);
  assert.equal(decodePixel(encoding, 0, 0, 0), null);
});

test("a point maps to its tile and pixel", () => {
  // Aletsch at z13.
  const { x, y, px, py } = tilePixel(8.03, 46.51, 13);
  assert.equal(x, Math.floor(((8.03 + 180) / 360) * 8192));
  assert.ok(y > 2800 && y < 2950);
  assert.ok(px >= 0 && px < 256 && py >= 0 && py < 256);
});
