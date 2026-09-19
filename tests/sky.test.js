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

/**
 * A globe seen through MapLibre's camera at pitch 0: the sphere's radius keeps
 * the center pixel the size of a mercator pixel, the camera sits
 * `cameraToCenterDistance` above the surface, and `shift` moves every projected
 * point, standing in for what pitch does to the silhouette.
 */
function cameraMap({ lng = 8, lat = 46.5, zoom = 2, width = 1600, height = 1000, shift = [0, 0] }) {
  const R = (TILE * 2 ** zoom) / (2 * Math.PI) / Math.cos(rad(lat));
  const f = (0.5 * height) / Math.tan(FOV / 2);
  const handlers = {};
  const map = {
    getCenter: () => ({ lng: map.view.lng, lat: map.view.lat }),
    getZoom: () => map.view.zoom,
    on: (event, fn) => (handlers[event] ??= []).push(fn),
    fire: (event) => (handlers[event] ?? []).forEach((fn) => fn()),
    set: (next) => Object.assign(map.view, next),
    view: { lng, lat, zoom },
    project([plng, plat]) {
      const { lng: clng, lat: clat, zoom: z } = map.view;
      const Rz = (TILE * 2 ** z) / (2 * Math.PI) / Math.cos(rad(clat));
      // Unit-sphere coordinates of the point in a frame whose +z faces the camera.
      const dl = rad(plng - clng);
      const x = Math.cos(rad(plat)) * Math.sin(dl);
      const y = Math.cos(rad(clat)) * Math.sin(rad(plat)) - Math.sin(rad(clat)) * Math.cos(rad(plat)) * Math.cos(dl);
      const zc = Math.sin(rad(clat)) * Math.sin(rad(plat)) + Math.cos(rad(clat)) * Math.cos(rad(plat)) * Math.cos(dl);
      const depth = Rz + f - Rz * zc;
      return {
        x: width / 2 + (f * Rz * x) / depth + shift[0],
        y: height / 2 - (f * Rz * y) / depth + shift[1],
      };
    },
    /** The silhouette radius a pinhole camera at distance f + R sees of a sphere of radius R. */
    silhouette: (f * R) / Math.sqrt((f + R) ** 2 - R ** 2),
  };
  return map;
}

test("the disc is the globe's true silhouette, not the 90° great circle", () => {
  const map = cameraMap({ zoom: 2, width: 1600, height: 1000 });
  const disc = globeDisc(map, 1600, 1000);
  assert.ok(Math.abs(disc.r - map.silhouette) < map.silhouette * 0.001, `r ${disc.r} vs ${map.silhouette}`);
  assert.ok(Math.abs(disc.x - 800) < 0.5 && Math.abs(disc.y - 500) < 0.5, `centered at ${disc.x},${disc.y}`);
  // The naive sample, 90° from the center, would land inside the silhouette by
  // a visible margin at this zoom; the halo's bright rim would be hidden.
  const R = (TILE * 4) / (2 * Math.PI) / Math.cos(rad(46.5));
  assert.ok(map.silhouette / R < 0.9, "the perspective margin is what makes this test worth having");
});

test("the disc follows the silhouette when pitch moves it off center", () => {
  const map = cameraMap({ shift: [30, -70] });
  const disc = globeDisc(map, 1600, 1000);
  assert.ok(Math.abs(disc.x - 830) < 0.5 && Math.abs(disc.y - 430) < 0.5, `centered at ${disc.x},${disc.y}`);
});

test("the sky is painted only while the globe leaves some viewport uncovered", () => {
  const map = cameraMap({ zoom: 10 });
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { value: 1600 });
  Object.defineProperty(element, "clientHeight", { value: 1000 });
  installSky(map, element);
  assert.equal(element.classList.contains("sky"), false, "a glacier fills the viewport");
  assert.equal(element.style.getPropertyValue("--globe-r"), "", "nothing was written for nothing to paint");

  map.set({ zoom: 2 });
  map.fire("move");
  assert.equal(element.classList.contains("sky"), true, "the whole globe is on screen");
  assert.match(element.style.getPropertyValue("--globe-r"), /^\d+(\.\d+)?px$/);
  assert.equal(element.style.getPropertyValue("--globe-x"), "800px");
  assert.equal(element.style.getPropertyValue("--globe-y"), "500px");
  assert.equal(element.style.getPropertyValue("--sky-x"), "", "no starfield, no parallax");

  map.set({ zoom: 10 });
  map.fire("move");
  assert.equal(element.classList.contains("sky"), false, "zoomed back into the surface");
});

