/*
 * A link the catalog cannot honor opens on the defaults instead. A separate
 * process gives it its own URL.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { installBrowser, load, REPO, settle } from "./helpers/browser.js";

const fixture = (name) => path.join(REPO, "tests", "fixtures", "two-years", name);
const page = installBrowser({
  // RTC VH has no 2022 archive; the range is inverted and the opacity out of range.
  search: "?year=2022&product=rtc&pol=vh&opacity=150&cmap=evil&range=0.7_0.2&base=other",
  files: {
    "http://localhost/tiles/mosaics/collection.json": fixture("collection.json"),
    "http://localhost/tiles/mosaics/style.json": fixture("style.json"),
    "http://localhost/tiles/mosaics/2022/item.json": fixture("item-2022.json"),
    "http://localhost/tiles/mosaics/2023/item.json": fixture("item-2023.json"),
    "data/inventories.json": path.join(REPO, "data", "inventories.json"),
  },
});
const { el } = page;
await load("js/app.js");
page.map.fire("style.load");
await settle();

test("a link to nothing the catalog has opens on the defaults", () => {
  const checked = (row) => el(row).querySelector('[aria-checked="true"]').dataset.value;
  assert.deepEqual([checked("product"), checked("pol"), el("year-value").textContent], ["COH12", "VV", "2023"]);
  assert.equal(el("opacity").value, "100");
  assert.equal(el("cmap").textContent, "lipari");
  assert.deepEqual([el("legend-min").textContent, el("legend-max").textContent], ["0.10", "0.75"]);
  assert.equal(checked("basemap-style"), "vector");
  assert.equal(el("status").hidden, true, "and reports nothing missing");
});
