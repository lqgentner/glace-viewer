/*
 * The page on a phone-sized viewport.
 *
 * Its own file because the panel's opening state is decided once, at boot, from
 * the media query — the same reason viewer-3d-restore.test.js stands apart.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { installBrowser, load, REPO, settle } from "./helpers/browser.js";

/* The collapsed state has to be reachable without running any JavaScript. The
 * module that decides it is deferred, so when this was `hidden` set from
 * app.js, a phone showed the full-height panel for a frame before it snapped
 * shut. Guarding the stylesheet rather than the DOM because that frame is the
 * bug, and no DOM assertion can see it. */
test("a narrow screen is collapsed by the stylesheet, before any script runs", () => {
  const css = fs.readFileSync(path.join(REPO, "style.css"), "utf8");
  const narrow = css.slice(css.indexOf("@media (max-width: 640px)"));
  const rule = narrow.slice(0, narrow.indexOf("#panel-body") + 200);

  assert.match(rule, /#panel:not\(\.expanded\) #panel-body \{[^}]*display: none/);
  assert.doesNotMatch(
    rule,
    /#panel\.collapsed #panel-body \{[^}]*display: none[^}]*\}\s*$/,
    "the default must not depend on a class only the script adds",
  );
});

/* On a viewport too short for the controls, whichever box scrolls decides
 * whether the collapse button can be reached at all. Stylesheet again, because
 * jsdom lays nothing out. */
test("the controls scroll under the header rather than taking it with them", () => {
  const css = fs.readFileSync(path.join(REPO, "style.css"), "utf8");
  const block = (selector) => {
    const start = css.indexOf(`\n${selector} {`);
    assert.notEqual(start, -1, `no rule for ${selector}`);
    return css.slice(start, css.indexOf("}", start));
  };

  assert.match(block("#panel-body"), /overflow-y: auto/);
  assert.doesNotMatch(block("#panel"), /overflow-y: auto/);
});

test("a narrow viewport opens with the panel collapsed", async () => {
  const page = installBrowser({
    narrow: true,
    files: { "data/inventories.json": path.join(REPO, "data", "inventories.json") },
  });
  const { el } = page;

  await load("js/app.js");
  await settle();

  assert.ok(el("panel").classList.contains("collapsed"), "the controls do not cover the map");
  assert.equal(el("panel-toggle").getAttribute("aria-expanded"), "false");
  assert.match(el("panel-toggle").getAttribute("aria-label"), /show/i);

  // The title bar is what is left, so the reader can still see what this is
  // and get the controls back. The heading is the wordmark, so what names the
  // page here is the image's alt text.
  assert.equal(el("title").querySelector("img").alt, "GLACE");

  el("panel-toggle").click();
  assert.ok(el("panel").classList.contains("expanded"), "and a tap brings them back");
  assert.match(el("panel-toggle").getAttribute("aria-label"), /hide/i);
});
