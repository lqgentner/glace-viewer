/*
 * The panel on phones: a sheet docked to the bottom at two heights, compact (the
 * handle and the legend) and open. A drag writes --sheet-progress on the root,
 * and style.css turns it into the sheet's transform and places the map's
 * furniture above its edge. Nothing moves between input events but CSS
 * transitions.
 */

import { el, PHONE } from "./ui.js";

/** Movement in px before a gesture counts as vertical or horizontal. */
export const LOCK_PX = 8;
/** Release speed in px/ms past which the sheet follows the flick. */
export const FLICK = 0.5;

/* Release speed is measured over this many ms before the release. */
const VELOCITY_WINDOW_MS = 100;
/* A click this soon after a drag is the drag's own click. */
const DRAG_CLICK_MS = 300;

const PROPERTIES = ["--sheet-travel", "--sheet-progress", "--sheet-visible"];

/** The gesture's axis once it has moved LOCK_PX, before that null. */
export function lockAxis(dx, dy) {
  if (Math.hypot(dx, dy) < LOCK_PX) return null;
  return Math.abs(dy) > Math.abs(dx) ? "y" : "x";
}

/**
 * The height a released sheet settles at.
 *
 * @param {number} progress  0 compact, 1 open
 * @param {number} velocity  px/ms, positive upward
 */
export function snapTarget(progress, velocity) {
  if (velocity > FLICK) return "open";
  if (velocity < -FLICK) return "compact";
  return progress >= 0.5 ? "open" : "compact";
}

let isOpen = false;
/* The band above the pills, which the compact sheet shows, and the distance to open. */
let band = 0;
let travel = 0;
let visible = 0;
/* The touch or pointer moving the sheet: its start, axis and recent positions. */
let gesture = null;

function measure() {
  band = el("tabs").offsetTop;
  travel = Math.max(0, el("panel-shell").offsetHeight - band);
}

function show(progress) {
  visible = band + progress * travel;
  const style = document.documentElement.style;
  style.setProperty("--sheet-travel", `${travel}px`);
  style.setProperty("--sheet-progress", String(progress));
  style.setProperty("--sheet-visible", `${visible}px`);
}

/** Open or lower the sheet; on desktop only the handle's state changes. */
export function setSheetOpen(open) {
  isOpen = open;
  el("panel-shell").classList.toggle("expanded", open);
  const handle = el("sheet-handle");
  handle.setAttribute("aria-expanded", String(open));
  const action = open ? "Hide the controls" : "Show the controls";
  handle.title = action;
  handle.setAttribute("aria-label", action);
  if (!PHONE.matches) return;
  // The pills and the content sit below the compact sheet's edge.
  for (const id of ["tabs", "panel-body"]) el(id).toggleAttribute("inert", !open);
  measure();
  show(open ? 1 : 0);
}

/** On desktop the panel is always open and carries none of the sheet's state. */
function toWide() {
  gesture = null;
  el("panel-shell").classList.remove("dragging");
  for (const name of PROPERTIES) document.documentElement.style.removeProperty(name);
  for (const id of ["tabs", "panel-body"]) el(id).removeAttribute("inert");
  setSheetOpen(true);
}

/** On phones, the popup's padding that keeps it clear of the sheet's visible part. */
export function popupPadding() {
  return PHONE.matches ? { bottom: visible } : undefined;
}

const startsOnRange = (target) => target.closest?.('input[type="range"]') != null;

function begin(x, y, time) {
  measure();
  const from = isOpen ? 1 : 0;
  gesture = { x, y, axis: null, from, progress: from, samples: [] };
  track(y, time);
}

function track(y, time) {
  const { samples } = gesture;
  samples.push({ y, time });
  while (samples.length > 2 && time - samples[0].time > VELOCITY_WINDOW_MS) samples.shift();
}

function drag(y, time) {
  const offset = travel ? (gesture.y - y) / travel : 0;
  gesture.progress = Math.min(1, Math.max(0, gesture.from + offset));
  el("panel-shell").classList.add("dragging");
  show(gesture.progress);
  track(y, time);
}

/* Settle a drag, released at `time`, at the height its position and speed point to. */
function release(time) {
  const { samples, progress } = gesture;
  const last = samples.at(-1);
  const first = samples.find((sample) => time - sample.time <= VELOCITY_WINDOW_MS) ?? last;
  // Upward is positive; no time between samples reads as a flick. A finger held
  // still sends no moves, so after a pause only `last` is recent: no speed.
  const velocity = (first.y - last.y) / (last.time - first.time) || 0;
  gesture = null;
  el("panel-shell").classList.remove("dragging");
  setSheetOpen(snapTarget(progress, velocity) === "open");
}

/*
 * A drag on the band ends without the click that browsers may send at its
 * release. The next press starts a gesture of its own.
 */
function swallowNextClick() {
  const stop = () => {
    window.removeEventListener("click", swallow, { capture: true });
    window.removeEventListener("pointerdown", stop, { capture: true });
  };
  const swallow = (event) => {
    if (!el("panel-nav").contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    stop();
  };
  window.addEventListener("click", swallow, { capture: true });
  window.addEventListener("pointerdown", stop, { capture: true });
  setTimeout(stop, DRAG_CLICK_MS);
}

/*
 * The band and the compact sheet drag on pointer events. A gesture that never
 * locks is a tap and clicks as usual; on the compact sheet it clicks the handle.
 */
function wireBand(nav) {
  nav.addEventListener("pointerdown", (event) => {
    if (!PHONE.matches || !event.isPrimary || event.button !== 0) return;
    if (startsOnRange(event.target)) return;
    begin(event.clientX, event.clientY, event.timeStamp);
    gesture.pointerId = event.pointerId;
  });
  nav.addEventListener("pointermove", (event) => {
    if (gesture?.pointerId !== event.pointerId) return;
    if (!gesture.axis) {
      gesture.axis = lockAxis(event.clientX - gesture.x, event.clientY - gesture.y);
      if (gesture.axis !== "y") return;
      // Captured only once it is a drag: a captured tap would click the band, not its target.
      nav.setPointerCapture?.(event.pointerId);
    }
    if (gesture.axis === "y") drag(event.clientY, event.timeStamp);
  });
  const end = (event) => {
    if (gesture?.pointerId !== event.pointerId) return;
    if (gesture.axis !== "y") {
      gesture = null;
      return;
    }
    if (event.type === "pointerup") swallowNextClick();
    release(event.timeStamp);
  };
  nav.addEventListener("pointerup", end);
  nav.addEventListener("pointercancel", end);
}

/*
 * The content scrolls; scrolled to its top, a pull down moves the sheet. Touch
 * events, since only a cancelable touchmove can take the gesture from the scroller.
 */
function wireContent(body) {
  // A drag on the band belongs to its pointer, whatever other fingers do.
  const onBand = () => gesture?.pointerId !== undefined;
  body.addEventListener(
    "touchstart",
    (event) => {
      // A second finger leaves the gesture under way alone.
      if (event.touches.length > 1 || onBand()) return;
      gesture = null;
      if (!PHONE.matches || startsOnRange(event.target)) return;
      const [{ clientX, clientY }] = event.touches;
      begin(clientX, clientY, event.timeStamp);
    },
    { passive: true },
  );
  body.addEventListener(
    "touchmove",
    (event) => {
      if (!gesture || onBand() || event.touches.length > 1) return;
      const [{ clientX, clientY }] = event.touches;
      if (!gesture.axis) {
        const dy = clientY - gesture.y;
        gesture.axis = lockAxis(clientX - gesture.x, dy);
        if (!gesture.axis) return;
        // An uncancelable move means the browser is already scrolling.
        if (gesture.axis !== "y" || dy < 0 || body.scrollTop > 0 || !event.cancelable) {
          gesture = null;
          return;
        }
      }
      event.preventDefault();
      drag(clientY, event.timeStamp);
    },
    { passive: false },
  );
  const end = (event) => {
    if (onBand()) return;
    if (gesture?.axis === "y") release(event.timeStamp);
    gesture = null;
  };
  body.addEventListener("touchend", end);
  body.addEventListener("touchcancel", end);
}

export function initSheet() {
  el("sheet-handle").addEventListener("click", () => setSheetOpen(!isOpen));
  wireBand(el("panel-nav"));
  wireContent(el("panel-body"));

  // The band's height changes with the legend; the sheet's with the viewport.
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => {
      if (!PHONE.matches || gesture?.axis === "y") return;
      measure();
      show(isOpen ? 1 : 0);
    });
    observer.observe(el("panel-nav"));
    observer.observe(el("panel-shell"));
  }

  PHONE.addEventListener("change", (event) => {
    if (event.matches) setSheetOpen(false);
    else toWide();
  });
  if (PHONE.matches) setSheetOpen(false);
  else toWide();
}
