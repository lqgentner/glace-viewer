/*
 * Check the silhouette against an independent pinhole-camera model and verify the
 * CSS halo properties.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { installBrowser, load } from "./helpers/browser.js";

installBrowser();
const { globeDisc, installSky } = await load("js/sky.js");

const FOV = 0.6435011087932844; // MapLibre's fixed vertical field of view
const TILE = 512;
const rad = (deg) => (deg * Math.PI) / 180;

const rotX = ([x, y, z], a) => [x, y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
const rotY = ([x, y, z], a) => [x * Math.cos(a) + z * Math.sin(a), y, -x * Math.sin(a) + z * Math.cos(a)];
const rotZ = ([x, y, z], a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z];

/**
 * A globe seen through MapLibre's camera, composed as in the globe matrix of
 * vertical_perspective_transform.ts: the sphere's radius keeps the center pixel
 * the size of a mercator pixel, and the camera orbits the center at
 * `cameraToCenterDistance`, tilted by pitch and turned by bearing.
 */
function cameraMap({ lng = 8, lat = 46.5, zoom = 2, pitch = 0, bearing = 0, width = 1600, height = 1000 }) {
  const handlers = {};
  const map = {
    getCenter: () => ({ lng: map.view.lng, lat: map.view.lat }),
    getZoom: () => map.view.zoom,
    getPitch: () => map.view.pitch,
    getBearing: () => map.view.bearing,
    on: (event, fn) => (handlers[event] ??= []).push(fn),
    fire: (event) => (handlers[event] ?? []).forEach((fn) => fn()),
    set: (next) => Object.assign(map.view, next),
    view: { lng, lat, zoom, pitch, bearing },
    get radius() {
      return (TILE * 2 ** map.view.zoom) / (2 * Math.PI) / Math.cos(rad(map.view.lat));
    },
    distance: (0.5 * height) / Math.tan(FOV / 2),
    /** Camera-space coordinates of a point `scale` globe radii from the globe's center. */
    toCamera([plng, plat], scale = 1) {
      const { lng: clng, lat: clat, pitch: p, bearing: b } = map.view;
      let v = [Math.sin(rad(plng)) * Math.cos(rad(plat)), Math.sin(rad(plat)), Math.cos(rad(plng)) * Math.cos(rad(plat))];
      v = rotX(rotY(v, -rad(clng)), rad(clat)).map((c) => c * map.radius * scale);
      v[2] -= map.radius;
      v = rotX(rotZ(v, rad(b)), -rad(p));
      v[2] -= map.distance;
      return v;
    },
    project(lngLat) {
      const [x, y, z] = map.toCamera(lngLat);
      return { x: width / 2 + (map.distance * x) / -z, y: height / 2 - (map.distance * y) / -z };
    },
    /** The silhouette's screen extent, from every grid point that faces the camera. */
    outline() {
      const center = map.toCamera([0, 0], 0);
      const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      for (let plat = -90; plat <= 90; plat += 0.25) {
        for (let plng = -180; plng < 180; plng += 0.25) {
          const point = map.toCamera([plng, plat]);
          const facing = point.reduce((sum, c, i) => sum + (c - center[i]) * -c, 0);
          if (facing < 0) continue;
          const { x, y } = map.project([plng, plat]);
          box.minX = Math.min(box.minX, x);
          box.maxX = Math.max(box.maxX, x);
          box.minY = Math.min(box.minY, y);
          box.maxY = Math.max(box.maxY, y);
        }
      }
      return box;
    },
  };
  return map;
}

test("the disc is the globe's true silhouette, not the 90° great circle", () => {
  const map = cameraMap({ zoom: 2, width: 1600, height: 1000 });
  const disc = globeDisc(map, 1600, 1000);
  const R = map.radius;
  const f = map.distance;
  const silhouette = (f * R) / Math.sqrt((f + R) ** 2 - R ** 2);
  assert.ok(Math.abs(disc.rx - silhouette) < silhouette * 0.001, `r ${disc.rx} vs ${silhouette}`);
  assert.ok(Math.abs(disc.rx - disc.ry) < 0.5, "seen from above, the outline is a circle");
  assert.ok(Math.abs(disc.x - 800) < 0.5 && Math.abs(disc.y - 500) < 0.5, `centered at ${disc.x},${disc.y}`);
  // The naive sample, 90° from the center, would land inside the silhouette by
  // a visible margin at this zoom; the halo's bright rim would be hidden.
  assert.ok(silhouette / R < 0.9, "the perspective margin is what makes this test worth having");
});

test("a tilted or turned camera still gets the globe's outline", () => {
  for (const view of [
    { zoom: 2, pitch: 60 },
    { zoom: 3, pitch: 60 },
    { zoom: 2, pitch: 60, bearing: 90 },
    { zoom: 1.2, lat: 30, pitch: 60, bearing: -150 },
    { zoom: 3, lng: -40, lat: 20, pitch: 45, bearing: -30 },
    { zoom: 2.6, lng: 100, lat: -60, pitch: 30, bearing: 150 },
  ]) {
    const map = cameraMap(view);
    const disc = globeDisc(map, 1600, 1000);
    const box = map.outline();
    const near = (a, b) => Math.abs(a - b) < 1;
    const label = JSON.stringify(view);
    assert.ok(near(disc.x - disc.rx, box.minX) && near(disc.x + disc.rx, box.maxX), `${label}: x ${disc.x}±${disc.rx} vs ${box.minX}..${box.maxX}`);
    assert.ok(near(disc.y - disc.ry, box.minY) && near(disc.y + disc.ry, box.maxY), `${label}: y ${disc.y}±${disc.ry} vs ${box.minY}..${box.maxY}`);
  }
});

test("the sky is painted only while the globe leaves some viewport uncovered", () => {
  const map = cameraMap({ zoom: 10 });
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { value: 1600 });
  Object.defineProperty(element, "clientHeight", { value: 1000 });
  installSky(map, element);
  assert.equal(element.classList.contains("sky"), false, "a glacier fills the viewport");
  assert.equal(element.style.getPropertyValue("--globe-rx"), "", "nothing was written for nothing to paint");

  map.set({ zoom: 2 });
  map.fire("move");
  assert.equal(element.classList.contains("sky"), true, "the whole globe is on screen");
  assert.match(element.style.getPropertyValue("--globe-rx"), /^\d+(\.\d+)?px$/);
  assert.match(element.style.getPropertyValue("--globe-ry"), /^\d+(\.\d+)?px$/);
  const px = (name) => parseFloat(element.style.getPropertyValue(name));
  assert.ok(Math.abs(px("--globe-x") - 800) < 1e-6 && Math.abs(px("--globe-y") - 500) < 1e-6, "centered");
  assert.equal(element.style.getPropertyValue("--sky-x"), "", "no starfield, no parallax");

  map.set({ zoom: 10 });
  map.fire("move");
  assert.equal(element.classList.contains("sky"), false, "zoomed back into the surface");
});

test("the disc is measured again when the style switches projection", () => {
  const map = cameraMap({ zoom: 10 });
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { value: 1600 });
  Object.defineProperty(element, "clientHeight", { value: 1000 });
  installSky(map, element);
  map.set({ zoom: 2 });
  map.fire("projectiontransition");
  assert.equal(element.classList.contains("sky"), true, "measured without waiting for a move");
});

test("a corner outside the tilted outline still shows the sky", () => {
  // The outline is taller than wide here; the farthest corner lies within the
  // larger radius but outside the ellipse.
  const map = cameraMap({ zoom: 4.77, pitch: 30 });
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { value: 1600 });
  Object.defineProperty(element, "clientHeight", { value: 1000 });
  installSky(map, element);
  assert.equal(element.classList.contains("sky"), true);
});
