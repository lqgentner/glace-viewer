/*
 * The scale editor on a phone: docked above the keyboard, and back to the
 * legend on close. Its own file for a fresh narrow page.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { installBrowser, load, REPO, settle } from "./helpers/browser.js";

const fixture = (name) => path.join(REPO, "tests", "fixtures", "two-years", name);
const page = installBrowser({
  narrow: true,
  files: {
    "http://localhost/tiles/mosaics/collection.json": fixture("collection.json"),
    "http://localhost/tiles/mosaics/style.json": fixture("style.json"),
    "http://localhost/tiles/mosaics/2022/item.json": fixture("item-2022.json"),
    "http://localhost/tiles/mosaics/2023/item.json": fixture("item-2023.json"),
    "data/inventories.json": path.join(REPO, "data", "inventories.json"),
  },
});
const { el, window } = page;
const stub = (node, name, value) =>
  Object.defineProperty(node, name, { configurable: true, writable: true, value });
const viewport = Object.assign(new window.EventTarget(), { height: 500, offsetTop: 0 });
stub(window, "visualViewport", viewport);
stub(window, "innerHeight", 844);

await load("js/app.js");
page.map.fire("style.load");
await settle();

const editor = el("scale-editor");
const inset = () => window.document.documentElement.style.getPropertyValue("--keyboard-inset");

test("closing the editor leaves the sheet compact and focuses the legend's Edit button", async () => {
  el("legend-edit").click();
  assert.ok(editor.open);
  editor.querySelector(".close").click();
  assert.ok(!editor.open);
  assert.ok(!el("panel-shell").classList.contains("expanded"));
  assert.equal(window.document.activeElement, el("legend-edit"));
});

test("the editor rises above the keyboard and settles on close", async () => {
  el("legend-edit").click();
  editor.querySelector("input").focus();
  viewport.dispatchEvent(new window.Event("resize"));
  assert.equal(inset(), "344px");
  viewport.height = 800;
  viewport.dispatchEvent(new window.Event("scroll"));
  assert.equal(inset(), "44px");
  editor.close();
  assert.equal(inset(), "");
  viewport.height = 500;
  viewport.dispatchEvent(new window.Event("resize"));
  assert.equal(inset(), "", "a closed editor no longer listens");
});

test("the stylesheet docks the editor and clears the map's corners", () => {
  const css = fs.readFileSync(path.join(REPO, "style.css"), "utf8");
  const narrow = css.slice(css.lastIndexOf("@media (max-width: 640px)"));
  const block = (selector) => {
    const start = narrow.indexOf(`${selector} {`);
    assert.notEqual(start, -1, selector);
    return narrow.slice(start, narrow.indexOf("}", start));
  };
  const dock = block("#scale-editor");
  for (const rule of [
    "bottom: var(--keyboard-inset, 0px)",
    "top: auto",
    "left: 0",
    "right: 0",
    "max-height: 60dvh",
  ]) assert.ok(dock.includes(rule), rule);
  assert.match(block("body:has(#scale-editor[open]) #panel-shell"), /display: none/);
  assert.match(block("body:has(#scale-editor[open]) #map :is(.maplibregl-ctrl-scale, .maplibregl-ctrl-attrib)"), /visibility: hidden/);
  const notices = block("body:has(#scale-editor[open]) #notices");
  assert.match(notices, /top: calc\(.*env\(safe-area-inset-top\).*\)/);
  assert.match(notices, /bottom: auto/);
});

test("Escape returns focus to the legend's Edit button", () => {
  el("legend-edit").click();
  editor.querySelector("input").focus();
  editor.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.ok(!editor.open);
  assert.equal(window.document.activeElement, el("legend-edit"));
});

test("moving between fields leaves one pending reveal, and closing drops it", () => {
  const inputs = [...editor.querySelectorAll("input")];
  let scrolls = 0;
  for (const input of inputs) input.scrollIntoView = () => scrolls++;
  el("legend-edit").click();
  inputs[0].focus();
  inputs[1].focus();
  viewport.dispatchEvent(new window.Event("resize"));
  assert.equal(scrolls, 1);
  inputs[0].focus();
  editor.close();
  viewport.dispatchEvent(new window.Event("resize"));
  assert.equal(scrolls, 1);
});

test("a selection with no layer closes the editor without taking focus", async () => {
  // The fixture has no VH layer for RTC in 2022.
  for (const [group, value] of [["product", "RTC"], ["pol", "VH"]]) {
    el(group).querySelector(`[data-value="${value}"]`).click();
  }
  await settle();
  el("legend-edit").click();
  assert.ok(editor.open);
  el("year").focus();
  el("year").value = "0";
  el("year").dispatchEvent(new window.Event("input"));
  await settle();
  assert.ok(!editor.open);
  assert.equal(el("legend-edit").hidden, true);
  assert.equal(window.document.activeElement, el("year"));
});
