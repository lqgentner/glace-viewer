/*
 * The phone sheet: how a gesture is classified, and the sheet's two heights on
 * a narrow page. Its own file because the sheet's state lives in its module and
 * the map is a singleton.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { captureWarnings, installBrowser, load, REPO, settle } from "./helpers/browser.js";

const page = installBrowser({
  narrow: true,
  files: { "data/inventories.json": path.join(REPO, "data", "inventories.json") },
});
const { el, window } = page;

// jsdom lays nothing out: the sheet is 500 px tall and its pills 90 px from its top.
const stub = (node, name, value) =>
  Object.defineProperty(node, name, { configurable: true, writable: true, value });
stub(el("panel-shell"), "offsetHeight", 500);
stub(el("tabs"), "offsetTop", 90);
stub(el("panel-body"), "scrollTop", 0);

// The catalog is not served; only the sheet matters here.
await captureWarnings(async () => {
  await load("js/app.js");
  await settle();
});
const { FLICK, LOCK_PX, lockAxis, popupPadding, snapTarget } = await load("js/sheet.js");

const root = () => window.document.documentElement.style;
const progress = () => Number(root().getPropertyValue("--sheet-progress"));
const isOpen = () => el("panel-shell").classList.contains("expanded");
const inert = () => el("panel-body").hasAttribute("inert");

/* jsdom stamps events with the clock; `time` sets the stamp, in ms. */
const stamp = (event, time) =>
  time === undefined ? event : Object.defineProperty(event, "timeStamp", { value: time });

function pointer(target, type, y, { x = 100, time } = {}) {
  const event = new window.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerType: "touch",
    pointerId: 1,
    isPrimary: true,
    clientX: x,
    clientY: y,
  });
  target.dispatchEvent(stamp(event, time));
  return event;
}

function touch(target, type, y, { fingers = 1, cancelable = true } = {}) {
  const touches = Array.from({ length: fingers }, (_, i) => ({ clientX: 100 + 40 * i, clientY: y }));
  const event = new window.TouchEvent(type, { bubbles: true, cancelable, touches });
  target.dispatchEvent(event);
  return event;
}

const click = (target) => {
  const event = new window.MouseEvent("click", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};

/* A tap as browsers send it: a press, a release and a click. */
function tap(target) {
  pointer(target, "pointerdown", 300);
  pointer(target, "pointerup", 300);
  return click(target);
}

/* A pointer drag through `ys`, then the click a browser may send after it. */
function swipe(target, ys) {
  pointer(target, "pointerdown", ys[0]);
  for (const y of ys.slice(1)) pointer(target, "pointermove", y);
  pointer(target, "pointerup", ys.at(-1));
  click(target);
}

/* Settled at one of the two heights, not stranded mid-drag. */
function settled() {
  assert.equal(el("panel-shell").classList.contains("dragging"), false);
  assert.ok([0, 1].includes(progress()), `progress ${progress()}`);
}

function open() {
  if (!isOpen()) tap(el("sheet-handle"));
  assert.ok(isOpen());
}

test("a gesture is classified once it has moved", () => {
  assert.equal(LOCK_PX, 8);
  assert.equal(FLICK, 0.5);
  assert.equal(lockAxis(3, 4), null, "5 px is still a tap");
  assert.equal(lockAxis(2, 9), "y");
  assert.equal(lockAxis(9, 2), "x");
});

test("release snaps to the nearer height unless it was flicked", () => {
  assert.equal(snapTarget(0.3, 0), "compact");
  assert.equal(snapTarget(0.6, 0), "open");
  assert.equal(snapTarget(0.2, 0.8), "open");
  assert.equal(snapTarget(0.9, -0.8), "compact");
});

test("the sheet starts compact, its content out of reach", () => {
  assert.equal(isOpen(), false);
  assert.equal(el("sheet-handle").getAttribute("aria-expanded"), "false");
  assert.equal(el("sheet-handle").getAttribute("aria-label"), "Show the controls");
  assert.ok(inert(), "Tab cannot reach the hidden tab content");
  assert.equal(root().getPropertyValue("--sheet-visible"), "90px");
  assert.equal(root().getPropertyValue("--sheet-travel"), "410px");
  assert.equal(progress(), 0);
});

test("popups keep clear of the sheet's visible part", () => {
  assert.deepEqual(popupPadding(), { bottom: 90 });
  el("sheet-handle").click();
  assert.deepEqual(popupPadding(), { bottom: 500 }, "the open sheet shows all of itself");
  el("sheet-handle").click();
});

test("the handle opens and closes the sheet", () => {
  el("sheet-handle").click();
  assert.ok(isOpen());
  assert.equal(inert(), false);
  assert.equal(progress(), 1);
  assert.equal(root().getPropertyValue("--sheet-visible"), "500px");
  assert.equal(el("sheet-handle").getAttribute("aria-expanded"), "true");
  assert.equal(el("sheet-handle").getAttribute("aria-label"), "Hide the controls");

  el("sheet-handle").click();
  assert.equal(isOpen(), false);
  assert.ok(inert());
  assert.equal(progress(), 0);
});

test("a swipe up the band opens the sheet", () => {
  const nav = el("panel-nav");
  pointer(nav, "pointerdown", 400);
  pointer(nav, "pointermove", 300);
  assert.ok(progress() > 0 && progress() < 1, `the sheet follows the finger (${progress()})`);
  assert.ok(el("panel-shell").classList.contains("dragging"), "without a transition");
  pointer(nav, "pointermove", 200);
  pointer(nav, "pointerup", 200);

  assert.ok(isOpen());
  assert.equal(progress(), 1);
  assert.equal(el("panel-shell").classList.contains("dragging"), false);
});

test("a drag held still before release settles by position, not by its last speed", () => {
  assert.equal(isOpen(), true);
  tap(el("sheet-handle"));
  const nav = el("panel-nav");
  pointer(nav, "pointerdown", 400, { time: 1000 });
  pointer(nav, "pointermove", 380, { time: 1010 });
  pointer(nav, "pointermove", 300, { time: 1050 });
  // Two px/ms upward, then held for 450 ms: a quarter of the way is not a flick.
  pointer(nav, "pointerup", 300, { time: 1500 });
  assert.equal(isOpen(), false);
  assert.equal(progress(), 0);
});

test("a cancelled band drag settles, and swallows no later click", () => {
  const nav = el("panel-nav");
  pointer(nav, "pointerdown", 400);
  pointer(nav, "pointermove", 200);
  pointer(nav, "pointercancel", 200);
  assert.ok(isOpen(), "the flick it was");
  settled();
  assert.equal(click(el("tab-map")).defaultPrevented, false);
  tap(el("tab-inventories"));
});

test("a drag swallows only the band's click", () => {
  open();
  const nav = el("panel-nav");
  pointer(nav, "pointerdown", 300);
  pointer(nav, "pointermove", 380);
  pointer(nav, "pointerup", 380);
  assert.equal(click(el("map")).defaultPrevented, false, "a click elsewhere is the user's");
  assert.equal(click(nav).defaultPrevented, true, "the band's is the drag's");
});

test("a drag that starts on a pill does not select it; a tap with jitter does", () => {
  open();
  const selected = () => el("tab-map").getAttribute("aria-selected") === "true";
  assert.equal(selected(), false);

  swipe(el("tab-map"), [300, 320, 340]);
  assert.equal(selected(), false, "the drag swallowed its click");

  open();
  swipe(el("tab-map"), [300, 303]);
  assert.ok(selected(), "3 px is a tap");
  assert.ok(isOpen(), "and leaves the sheet where it was");
});

test("another tab shows its content from the top", () => {
  open();
  const body = el("panel-body");
  body.scrollTop = 200;
  el("tab-inventories").click();
  assert.equal(body.scrollTop, 0);
  el("tab-map").click();
});

test("a pull down that starts on a slider leaves the open sheet alone", () => {
  open();
  const year = el("year");
  touch(year, "touchstart", 300);
  const move = touch(year, "touchmove", 360);
  touch(year, "touchend", 360);

  assert.ok(isOpen());
  assert.equal(progress(), 1);
  assert.equal(move.defaultPrevented, false, "the slider keeps the gesture");
});

test("pulling the content down from its top closes the sheet", () => {
  open();
  const body = el("panel-body");
  const inside = el("extras");

  body.scrollTop = 50;
  touch(inside, "touchstart", 300);
  let move = touch(inside, "touchmove", 420);
  touch(inside, "touchend", 420);
  assert.ok(isOpen(), "scrolled down, the pull scrolls the content");
  assert.equal(move.defaultPrevented, false);

  body.scrollTop = 0;
  touch(inside, "touchstart", 300);
  move = touch(inside, "touchmove", 420);
  touch(inside, "touchend", 420);
  assert.equal(move.defaultPrevented, true, "the sheet takes the gesture from the scroller");
  assert.equal(isOpen(), false);

  open();
  touch(inside, "touchstart", 300);
  move = touch(inside, "touchmove", 180);
  touch(inside, "touchend", 180);
  assert.ok(isOpen(), "pushed up, the content scrolls");
  assert.equal(move.defaultPrevented, false);
});

test("a pull the browser already scrolls stays a scroll", () => {
  open();
  const inside = el("extras");
  touch(inside, "touchstart", 300);
  const move = touch(inside, "touchmove", 420, { cancelable: false });
  touch(inside, "touchend", 420);
  assert.ok(isOpen());
  assert.equal(progress(), 1);
  assert.equal(move.defaultPrevented, false);
});

test("a second finger does not strand a drag mid-height", () => {
  open();
  const nav = el("panel-nav");
  const inside = el("extras");
  pointer(nav, "pointerdown", 300);
  pointer(nav, "pointermove", 340);
  touch(inside, "touchstart", 500, { fingers: 2 });
  touch(inside, "touchend", 500);
  pointer(nav, "pointerup", 340);
  settled();

  // A mouse drag on the band and a touch on the content.
  open();
  pointer(nav, "pointerdown", 300);
  pointer(nav, "pointermove", 340);
  touch(inside, "touchstart", 500);
  touch(inside, "touchend", 500);
  assert.ok(el("panel-shell").classList.contains("dragging"), "the band's drag goes on");
  pointer(nav, "pointerup", 340);
  settled();

  open();
  touch(inside, "touchstart", 300);
  touch(inside, "touchmove", 340);
  touch(inside, "touchstart", 340, { fingers: 2 });
  touch(inside, "touchmove", 360, { fingers: 2 });
  touch(inside, "touchend", 360);
  settled();
});

test("crossing the breakpoint mid-drag leaves nothing behind", () => {
  open();
  const nav = el("panel-nav");
  pointer(nav, "pointerdown", 200);
  pointer(nav, "pointermove", 260);

  page.setNarrow(false);
  const shell = el("panel-shell");
  assert.equal(shell.style.length, 0, "the shell has no inline style");
  assert.equal(shell.classList.contains("dragging"), false);
  for (const name of ["--sheet-travel", "--sheet-progress", "--sheet-visible"]) {
    assert.equal(root().getPropertyValue(name), "", `${name} is gone on desktop`);
  }
  assert.equal(inert(), false);
  assert.equal(el("tabs").hasAttribute("inert"), false);
  assert.equal(popupPadding(), undefined, "desktop popups need no padding");

  pointer(nav, "pointerup", 300);
  assert.equal(root().getPropertyValue("--sheet-progress"), "", "the stale gesture is dropped");

  page.setNarrow(true);
  assert.equal(isOpen(), false, "phones restart compact");
  assert.ok(inert());
  assert.equal(root().getPropertyValue("--sheet-visible"), "90px");
});
