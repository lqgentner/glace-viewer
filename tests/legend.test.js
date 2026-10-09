/*
 * The legend and its scale editor against the two-year fixture: color-map
 * choice, limits, reset, and per-layer memory. A separate process gives it a
 * fresh map.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { installBrowser, load, REPO, settle } from "./helpers/browser.js";

const fixture = (name) => path.join(REPO, "tests", "fixtures", "two-years", name);
const page = installBrowser({
  files: {
    "http://localhost/tiles/mosaics/collection.json": fixture("collection.json"),
    "http://localhost/tiles/mosaics/style.json": fixture("style.json"),
    "http://localhost/tiles/mosaics/2022/item.json": fixture("item-2022.json"),
    "http://localhost/tiles/mosaics/2023/item.json": fixture("item-2023.json"),
    "data/inventories.json": path.join(REPO, "data", "inventories.json"),
  },
});
const { el, window } = page;
await load("js/app.js");
// The harness exposes the map the modules built, so read it after loading them.
const { map } = page;
map.fire("style.load");
await settle();
const { COLOR_MAPS } = await load("js/colormaps.js");
const { archive } = await load("js/archive.js");

const ID = "glace-coh12_vv-2023";
/* Positions and colors of a color-relief ramp, past the two nodata stops. */
const ramp = (id) => {
  const stops = map.getLayer(id).paint["color-relief-color"].slice(3);
  return { first: stops[4], firstColor: stops[5], last: stops.at(-2) };
};
const editor = el("scale-editor");
/* Type into a limit, as each keystroke would, then leave the field. */
const type = async (input, value, { leave = true } = {}) => {
  input.focus();
  input.value = value;
  input.dispatchEvent(new window.Event("input"));
  if (leave) {
    input.blur();
    input.dispatchEvent(new window.Event("change"));
  }
  await settle();
};
const option = (name) => el("cmap-options").querySelector(`[data-value="${name}"]`);
const legend = () => [el("legend-min").textContent, el("legend-max").textContent];
/* Unavailable buttons stay focusable: aria-disabled, not disabled. */
const off = (id) => el(id).getAttribute("aria-disabled") === "true";
const pick = async (row, value) => {
  [...el(row).children].find((b) => b.dataset.value === value).click();
  await settle();
};

test("the legend shows its color map and limits as text, with one edit button", () => {
  assert.equal(el("cmap").textContent, "lipari");
  assert.deepEqual(legend(), ["0.10", "0.75"]);
  assert.equal(el("legend-edit").hidden, false);
  assert.equal(el("legend").querySelector("input"), null, "nothing is edited in place");
  assert.equal(editor.open, false);
  assert.equal(el("legend-credit"), null, "the credit button is gone");
  assert.equal(el("readout"), null, "and the cursor readout");
});

test("the edit button opens the editor on the layer's limits and color map", async () => {
  el("legend-edit").click();
  assert.equal(editor.open, true);
  assert.equal(el("vmin").value, "0.10");
  assert.equal(el("vmax").value, "0.75");
  assert.equal(el("limits-hint").textContent, "", "no reason to show until a limit is refused");
  assert.equal(off("range-reset"), true, "nothing to reset yet");
  assert.equal(el("cmap-options").children.length, 12);
  assert.deepEqual(
    [...el("cmap-options").children].filter((o) => o.getAttribute("aria-pressed") === "true").map((o) => o.textContent),
    ["lipari"],
  );
  // Focus starts on the close button, so a phone does not raise its keyboard on opening.
  assert.equal(window.document.activeElement, editor.querySelector(".close"));
});

test("a color map applies at once and the editor stays open", async () => {
  option("cmc.batlow").click();
  await settle();
  assert.equal(editor.open, true);
  assert.equal(option("cmc.batlow").getAttribute("aria-pressed"), "true");
  assert.equal(option("cmc.lipari").getAttribute("aria-pressed"), "false");
  assert.equal(el("cmap").textContent, "batlow");
  assert.equal(ramp(ID).firstColor, COLOR_MAPS["cmc.batlow"][0]);
  assert.equal(off("range-reset"), true, "reset is for the limits only");
});

test("limits apply as they are typed, accept a comma, and refuse what cannot be drawn", async () => {
  await type(el("vmin"), "0,2", { leave: false });
  assert.equal(ramp(ID).first, 0.2, "applied before the field is left");
  assert.equal(el("vmin").getAttribute("aria-invalid"), "false");
  el("vmin").blur();
  el("vmin").dispatchEvent(new window.Event("change"));
  await settle();
  assert.equal(el("vmin").value, "0.20");
  assert.deepEqual(legend(), ["0.20", "0.75"]);
  assert.ok(el("legend-min").classList.contains("modified"));
  assert.equal(el("legend-max").classList.contains("modified"), false, "the untouched limit is not");
  assert.equal(off("range-reset"), false);

  await type(el("vmax"), "0.1", { leave: false });
  assert.equal(el("vmax").getAttribute("aria-invalid"), "true", "an inverted range is flagged");
  assert.equal(el("limits-hint").textContent, "Min must be below Max.");
  assert.equal(ramp(ID).last, 0.75, "and not drawn");
  el("vmax").blur();
  el("vmax").dispatchEvent(new window.Event("change"));
  await settle();
  assert.equal(el("vmax").value, "0.75", "leaving the field restores what is drawn");
  assert.equal(el("vmax").hasAttribute("aria-invalid"), false);
  assert.equal(el("limits-hint").textContent, "", "and clears the reason");

  await type(el("vmin"), "abc", { leave: false });
  assert.equal(el("limits-hint").textContent, "Enter a value between 0.00 and 1.00.");
  await type(el("vmin"), "0.2", { leave: false });
  assert.equal(el("limits-hint").textContent, "", "a valid value clears it at once");
  await type(el("vmin"), "abc");
  assert.equal(el("vmin").value, "0.20", "so does text");

  await type(el("vmin"), "0.204");
  assert.equal(el("vmin").value, "0.20", "rounded to the precision shown");
  assert.equal(ramp(ID).first, 0.2, "and applied as shown");

  await type(el("vmin"), "-1", { leave: false });
  assert.match(el("limits-hint").textContent, /^Enter a value between 0\.00 and 1\.00\.$/);
  await type(el("vmin"), "-1");
  assert.equal(el("vmin").value, "0.20", "and a limit below what the archive encodes");

  await type(el("vmax"), "1.5");
  assert.equal(el("vmax").value, "0.75", "or above it");
  assert.equal(ramp(ID).last, 0.75);
});

test("render never overwrites the limit being typed", async () => {
  // Each valid keystroke re-renders the editor; the focused field keeps its text.
  await type(el("vmax"), "0.6", { leave: false });
  assert.equal(ramp(ID).last, 0.6);
  assert.equal(el("vmax").value, "0.6", "not yet reformatted to 0.60");
  el("vmax").blur();
  el("vmax").dispatchEvent(new window.Event("change"));
  await settle();
  assert.equal(el("vmax").value, "0.60", "until it is left");

  el("range-reset").click();
  await settle();
  assert.deepEqual([el("vmin").value, el("vmax").value], ["0.10", "0.75"]);
});

test("the close button, Escape and the edit button close the editor", async () => {
  editor.querySelector(".close").click();
  assert.equal(editor.open, false);
  assert.equal(el("legend-edit").getAttribute("aria-expanded"), "false");
  el("legend-edit").click();
  assert.equal(el("legend-edit").getAttribute("aria-expanded"), "true");
  el("vmin").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(editor.open, false, "Escape closes it");
  el("legend-edit").click();
  assert.equal(editor.open, true);
  el("legend-edit").click();
  assert.equal(editor.open, false, "the edit button toggles it");
});

/*
 * Coherence codes: value = (code - 1) / 254. The axis runs from half a code
 * below 1 to half above 255, so a chart 255 px wide puts code c at c - 0.5.
 */
const at = (value) => value * 254 + 0.5;
const position = (value) => `${((at(value) / 255) * 100).toFixed(3)}%`;
const press = (type, clientX) =>
  el("histogram").dispatchEvent(new window.MouseEvent(type, { clientX, bubbles: true }));
const drag = async (from, to) => {
  press("pointerdown", from);
  press("pointermove", to);
  press("pointerup", to);
  await settle();
};

test("the histogram counts the view and its handles drag the limits", async () => {
  el("histogram").getBoundingClientRect = () => ({ left: 0, width: 255 });
  el("legend-edit").click();
  await settle();
  assert.equal(el("histogram-note").textContent, "No data in view", "the fake archive has no tiles");
  assert.equal(el("histogram").style.getPropertyValue("--low"), position(0.1));

  // A press moves the nearer handle, which then follows the pointer.
  await drag(at(0.2), at(0.3));
  assert.equal(ramp(ID).first, 0.3);
  assert.equal(el("vmin").value, "0.30");
  assert.deepEqual(legend(), ["0.30", "0.75"]);
  assert.equal(el("histogram").style.getPropertyValue("--low"), position(0.3));

  await drag(at(0.7), 400);
  assert.equal(el("vmax").value, "1.00", "past the end: the top of the drawable range");
  await drag(at(0.3), 400);
  assert.equal(el("vmin").value, "0.99", "and the minimum stops a digit short of the maximum");

  el("range-reset").click();
  await settle();
  assert.deepEqual(legend(), ["0.10", "0.75"]);
  editor.close();
});

test("2–98% and Min/Max set both limits from the values in view", async () => {
  el("legend-edit").click();
  await settle();
  assert.equal(off("range-percentile"), true, "nothing counted, nothing to fit");
  assert.equal(off("range-extent"), true);
  editor.close();

  // One z5 tile in view, holding codes 101-200 once each.
  const lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - y / 16))) * 180) / Math.PI;
  const { getBounds } = map;
  const zoom = map.zoom;
  map.getBounds = () => ({ getWest: () => 0, getEast: () => 11.25, getSouth: () => lat(12), getNorth: () => lat(11) });
  map.zoom = 4;
  const codes = new Uint8ClampedArray(Array.from({ length: 100 }, (_, at) => [101 + at, 101 + at, 101 + at, 255]).flat());
  const reader = archive(map.getSource(ID).url.replace("pmtiles://", ""));
  const { getZxy } = reader;
  reader.getZxy = async (z) => (z === 5 ? { data: codes.slice().buffer } : undefined);
  try {
    el("legend-edit").click();
    await settle();
    assert.equal(el("histogram-note").textContent, "");
    assert.match(el("histogram-bars").getAttribute("d"), /^M100 64h1V0\.00h-1Z/, "the first bar is code 101");
    assert.equal(off("range-percentile"), false);

    // Code c is (c - 1) / 254: 2% falls at 102.5, 98% at 198.5.
    el("range-percentile").click();
    await settle();
    assert.deepEqual([el("vmin").value, el("vmax").value], ["0.40", "0.78"]);
    assert.equal(ramp(ID).first, 0.4);
    el("range-extent").click();
    await settle();
    assert.deepEqual([el("vmin").value, el("vmax").value], ["0.39", "0.78"], "codes 101 and 200");
    assert.deepEqual(legend(), ["0.39", "0.78"]);
    el("range-reset").click();
    await settle();
  } finally {
    Object.assign(map, { getBounds, zoom });
    reader.getZxy = getZxy;
    editor.close();
  }
});

test("the open editor recounts after the map moves and follows the selection", async () => {
  const lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - y / 16))) * 180) / Math.PI;
  const { getBounds } = map;
  const zoom = map.zoom;
  map.getBounds = () => ({ getWest: () => 0, getEast: () => 11.25, getSouth: () => lat(12), getNorth: () => lat(11) });
  map.zoom = 4;
  let code = 101;
  const reader = archive(map.getSource(ID).url.replace("pmtiles://", ""));
  const { getZxy } = reader;
  reader.getZxy = async (z) =>
    z === 5 ? { data: new Uint8ClampedArray(400).fill(code).buffer } : undefined;
  const firstBar = () => el("histogram-bars").getAttribute("d").split("h")[0];
  try {
    el("legend-edit").click();
    await settle();
    assert.equal(firstBar(), "M100 64", "code 101");

    code = 151;
    map.fire("moveend");
    assert.equal(firstBar(), "M100 64", "the old bars stay until the recount is ready");
    await settle();
    assert.equal(firstBar(), "M150 64", "code 151");

    // A recount that resolves after a newer one never replaces its bars.
    const pending = [];
    reader.getZxy = (z) =>
      z === 5 ? new Promise((resolve) => pending.push(resolve)) : Promise.resolve(undefined);
    const resolveWith = (value, at) => pending.splice(0, at).forEach((resolve) => resolve(value));
    map.fire("moveend");
    await settle();
    const older = pending.length;
    map.fire("moveend");
    await settle();
    const tileOf = (value) => ({ data: new Uint8ClampedArray(400).fill(value).buffer });
    const newer = pending.splice(older);
    newer.forEach((resolve) => resolve(tileOf(201)));
    await settle();
    assert.equal(firstBar(), "M200 64", "the newer recount");
    resolveWith(tileOf(51), older);
    await settle();
    assert.equal(firstBar(), "M200 64", "the older one was aborted");
    reader.getZxy = async (z) =>
      z === 5 ? { data: new Uint8ClampedArray(400).fill(code).buffer } : undefined;

    // 2022 has its own archive, which the fake leaves empty.
    el("year").value = "0";
    el("year").dispatchEvent(new window.Event("input"));
    await settle();
    assert.equal(editor.open, true, "a new year keeps the editor open");
    assert.equal(el("histogram-note").textContent, "No data in view", "and reads its own archive");

    await pick("pol", "RGB");
    assert.equal(editor.open, false, "false color has nothing to edit");
    await pick("pol", "VV");
    el("year").value = "1";
    el("year").dispatchEvent(new window.Event("input"));
    await settle();
  } finally {
    Object.assign(map, { getBounds, zoom });
    reader.getZxy = getZxy;
    editor.close();
  }
});

test("choices belong to their layer: kept across years, separate per product", async () => {
  el("legend-edit").click();
  await type(el("vmin"), "0.2");
  editor.close();

  el("year").value = "0";
  el("year").dispatchEvent(new window.Event("input"));
  await settle();
  assert.equal(el("cmap").textContent, "batlow", "2022 keeps the coherence choice");
  assert.deepEqual(legend(), ["0.20", "0.75"]);

  await pick("product", "RTC");
  assert.equal(el("cmap").textContent, "navia", "backscatter keeps its own default");
  assert.equal(el("legend-min").classList.contains("modified"), false);

  await pick("product", "COH12");
  el("legend-edit").click();
  el("range-reset").click();
  await settle();
  assert.equal(el("vmin").value, "0.10", "reset restores the limits");
  assert.deepEqual(legend(), ["0.10", "0.75"]);
  assert.equal(ramp("glace-coh12_vv-2022").first, 0.1);
  assert.equal(el("cmap").textContent, "batlow", "and keeps the color map");
  assert.equal(off("range-reset"), true);
  editor.close();
});

test("false color shows channels and nothing to edit", async () => {
  await pick("pol", "RGB");
  assert.equal(el("cmap").hidden, true);
  assert.equal(el("legend-labels").hidden, true);
  assert.equal(el("legend-edit").hidden, true);
  await pick("pol", "VV");
  assert.equal(el("legend-edit").hidden, false);
});

test("a drag that widens the range past five units still reaches the end", async () => {
  await pick("product", "RTC");
  el("legend-edit").click();
  assert.equal(el("vmin").inputMode, "text", "negative limits need a minus key on iOS");
  await type(el("vmin"), "-12");
  await type(el("vmax"), "-9"); // two decimals for a span of 3
  // RTC VV code c is about c × 0.118 - 25.1 dB: -12 sits near x 110. The drag
  // ends at the bottom, -25.06, with one decimal: -25.1 would be refused.
  el("histogram").getBoundingClientRect = () => ({ left: 0, width: 255 });
  await drag(105, -10);
  assert.equal(el("vmin").value, "-25.0", "the bottom, rounded inside what can be drawn");
  assert.equal(ramp("glace-rtc_vv-2022").first, -25);
  el("range-reset").click();
  await settle();
  editor.close();
  await pick("product", "COH12");
  el("legend-edit").click();
  assert.equal(el("vmin").inputMode, "decimal", "coherence is never negative");
  editor.close();
});

test("a maximum above the top code is refused, since MapLibre would wrap it", async () => {
  await pick("product", "RTC");
  el("legend-edit").click();
  await type(el("vmax"), "6", { leave: false });
  assert.match(el("limits-hint").textContent, /and 5\.0 dB\.$/, "the hint names the top");
  await type(el("vmax"), "5");
  assert.equal(ramp("glace-rtc_vv-2022").last, 5, "code 255 is 5, which is fine");
  await type(el("vmin"), "1"); // a narrow range shows two decimals
  await type(el("vmax"), "5.04");
  assert.equal(el("vmax").value, "5.00", "but MapLibre cannot pack 5.04");
  assert.equal(ramp("glace-rtc_vv-2022").last, 5);
  el("range-reset").click();
  await settle();
  editor.close();
});
