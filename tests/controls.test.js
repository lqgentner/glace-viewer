/* The map's controls: the compass, 3D and zoom, and where they stand. */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { installBrowser, load, REPO, settle } from "./helpers/browser.js";

const page = installBrowser({ files: { "data/inventories.json": path.join(REPO, "data", "inventories.json") } });
await load("js/app.js");
const { map } = page;
map.fire("style.load");
await settle();

const click = (selector) => page.control(selector).click();
const compass = () => page.control(".compass");

test("off the phone the controls stand above the status line, in the bottom right", () => {
  const controls = map.controls.find((c) => c.container?.classList.contains("map-controls"));
  assert.equal(map.positions.get(controls), "bottom-right");
  assert.ok(map.controls.indexOf(controls) > map.controls.findIndex((c) => c.container?.classList.contains("status-line")),
    "added after the status line, so MapLibre stacks them above it");
});

test("the arrows turn the map 45° at a time, and quick clicks add up", () => {
  const eased = [];
  let moving = false;
  map.easeTo = (options) => eased.push(options.bearing);
  map.isMoving = () => moving;
  click(".compass-left");
  moving = true;
  click(".compass-left");
  click(".compass-right");
  assert.deepEqual(eased, [45, 90, 45]);
  moving = false;
  map.fire("moveend");
  delete map.easeTo;
  delete map.isMoving;
});

test("the needle follows the camera and is idle only facing north, flat and in 2D", () => {
  map.getBearing = () => 30;
  map.fire("move");
  assert.equal(page.control(".compass-needle").style.transform, "rotateX(0deg) rotateZ(-30deg)");
  assert.equal(compass().hasAttribute("data-idle"), false);
  map.getBearing = () => 0;
  map.fire("move");
  assert.equal(compass().hasAttribute("data-idle"), true);
  delete map.getBearing;
});

test("the needle faces north and leaves 3D", async () => {
  click(".three-d");
  await settle();
  assert.ok(map.getTerrain());
  assert.equal(compass().hasAttribute("data-idle"), false, "3D shows the phone's compass");
  const eased = [];
  const ease = map.easeTo;
  map.easeTo = (options) => {
    eased.push(options);
    ease.call(map, options);
  };
  click(".compass-north");
  await settle();
  map.easeTo = ease;
  assert.equal(map.getTerrain(), null);
  assert.equal(page.control(".three-d").textContent, "3D");
  assert.deepEqual(eased.map(({ pitch, bearing }) => ({ pitch, bearing })), [{ pitch: 0, bearing: 0 }]);
});

test("the zoom buttons zoom the map", () => {
  const calls = [];
  map.zoomIn = () => calls.push("in");
  map.zoomOut = () => calls.push("out");
  click(".zoom-in");
  click(".zoom-out");
  assert.deepEqual(calls, ["in", "out"]);
});

test("on phones the controls move to the top right, clear of the sheet", () => {
  const controls = map.controls.find((c) => c.container?.classList.contains("map-controls"));
  page.setNarrow(true);
  assert.equal(map.positions.get(controls), "top-right");
  page.setNarrow(false);
  assert.equal(map.positions.get(controls), "bottom-right");
});

const rest = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a tilt by hand turns 3D on, and one that ends nearly flat levels the map in 2D", async () => {
  map.pitch = 7;
  map.fire("pitchend", { originalEvent: {} });
  await rest();
  await settle();
  assert.equal(map.getTerrain(), null, "the drift of a right-drag that turns the map stays in 2D");
  assert.equal(map.pitch, 0);

  map.pitch = 40;
  map.fire("pitchend", {});
  await rest();
  assert.equal(map.getTerrain(), null, "the page's own moves are not heard");

  map.fire("pitchend", { originalEvent: {} });
  await rest();
  await settle();
  assert.ok(map.getTerrain(), "3D after the tilt");
  assert.equal(map.pitch, 40, "the camera stays where the reader put it");
  assert.equal(page.control(".three-d").textContent, "2D");

  map.pitch = 3;
  map.fire("pitchend", { originalEvent: {} });
  await rest();
  await settle();
  assert.equal(map.getTerrain(), null);
  assert.equal(map.pitch, 0, "levelled");
  assert.equal(page.control(".three-d").textContent, "3D");
});
