/*
 * The map's controls, one MapLibre control: the compass, the 3D button and the
 * zoom buttons, top to bottom. The compass is a needle that points north, with
 * an arrow either side that turns the map; a click on the needle faces north
 * and leaves 3D. style.css makes it a capsule off the phone and, on phones, a
 * round button under 3D that shows only while the map is turned, tilted or in
 * 3D. Phones have no zoom buttons: they pinch.
 */

import { h } from "./ui.js";

/* How far one click on an arrow turns the map, in degrees. */
const ROTATE_STEP = 45;
/* A bearing or pitch closer to 0 than this, in degrees, counts as none. */
const LEVEL = 0.5;

const SVG = "http://www.w3.org/2000/svg";
function svg(tag, attributes, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

/*
 * The arrows in the capsule's 54 x 40 px box. Each arc shares the center of
 * the capsule's round end, 7 px in from its edge; each head is isosceles, its
 * base along the radius where the stroke ends.
 */
const ARROWS = [
  { d: "M13.25 8.89 A13 13 0 0 0 9.1 27.08", head: "6.08 29.04 12.37 32.11 12.12 25.12" },
  { d: "M40.75 8.89 A13 13 0 0 1 44.9 27.08", head: "47.92 29.04 41.63 32.11 41.88 25.12" },
];

export class MapControls {
  /**
   * @param onThreeD  called with the 3D state the button asks for
   * @param onNorth   called by the needle: face north, level and leave 3D
   */
  constructor({ onThreeD, onNorth }) {
    const button = (className, label, action, ...children) => {
      const node = h("button", { type: "button", class: className, "aria-label": label, title: label }, ...children);
      node.addEventListener("click", action);
      return node;
    };
    this.needle = svg(
      "svg",
      { class: "compass-needle", width: 28, height: 28, viewBox: "0 0 28 28", "aria-hidden": "true" },
      svg("polygon", { class: "needle-north", points: "14,0 18.7,14 9.3,14" }),
      svg("polygon", { class: "needle-south", points: "9.3,14 18.7,14 14,28" }),
    );
    const arrows = svg(
      "svg",
      { class: "compass-arrows", width: 54, height: 40, viewBox: "0 0 54 40", "aria-hidden": "true" },
      ...ARROWS.flatMap(({ d, head }) => [
        svg("path", { class: "compass-arc", d }),
        svg("polygon", { class: "compass-head", points: head }),
      ]),
    );
    this.compass = h(
      "div",
      { class: "compass map-surface", role: "group", "aria-label": "Map direction" },
      button("compass-turn compass-left", "Rotate left", () => this.rotate(ROTATE_STEP)),
      button("compass-north", "Face north", () => onNorth(), this.needle),
      button("compass-turn compass-right", "Rotate right", () => this.rotate(-ROTATE_STEP)),
      arrows,
    );
    this.threeDButton = button("three-d", "3D terrain", () => onThreeD(!this.threeD), "3D");
    /* The glass is the group's, so the button's own background stays clear for hover. */
    const threeDGroup = h("div", { class: "three-d-group map-surface" }, this.threeDButton);
    this.zoom = h(
      "div",
      { class: "zoom map-surface", role: "group", "aria-label": "Zoom" },
      /* Set in 3D's font, not MapLibre's icons. */
      button("zoom-in", "Zoom in", () => this.map?.zoomIn(), "+"),
      button("zoom-out", "Zoom out", () => this.map?.zoomOut(), "\u2212"),
    );
    this.container = h("div", { class: "maplibregl-ctrl map-controls" }, this.compass, threeDGroup, this.zoom);
    /* The bearing the arrows' last turn eases to, while it runs. */
    this.turnTo = null;
    /* Whether 3D is on: the one record of it, which js/map.js's setThreeD() keeps. */
    this.threeD = false;
    this.setThreeD(false);
    this.onMove = () => this.sync();
    this.onMoveEnd = () => {
      if (!this.map.isMoving()) this.turnTo = null;
    };
  }

  onAdd(map) {
    this.map = map;
    map.on("move", this.onMove);
    map.on("moveend", this.onMoveEnd);
    this.sync();
    return this.container;
  }

  onRemove() {
    this.map.off("move", this.onMove);
    this.map.off("moveend", this.onMoveEnd);
    this.container.remove();
    this.map = null;
  }

  /** Turn the map; positive is counter-clockwise. Quick clicks add up to whole steps. */
  rotate(degrees) {
    if (!this.map) return;
    const from = this.turnTo !== null && this.map.isMoving() ? this.turnTo : this.map.getBearing();
    this.turnTo = from + degrees;
    this.map.easeTo({ bearing: this.turnTo });
  }

  /** The 3D button is a toggle: it reads "3D" and stays pressed while 3D is on. */
  setThreeD(on) {
    this.threeD = on;
    this.threeDButton.setAttribute("aria-pressed", String(on));
    this.sync();
  }

  /* The map's own easing animates the needle. */
  sync() {
    if (!this.map) return;
    const bearing = this.map.getBearing();
    const pitch = this.map.getPitch();
    this.needle.style.transform = `rotateX(${pitch}deg) rotateZ(${-bearing}deg)`;
    this.compass.toggleAttribute("data-idle", Math.abs(bearing) < LEVEL && pitch < LEVEL && !this.threeD);
  }
}
