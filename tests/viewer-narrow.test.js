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

/* Every rule of the narrow media blocks, as one string. */
function narrowRules(css) {
  const blocks = [];
  for (let at = css.indexOf("@media (max-width: 640px) {"); at !== -1; ) {
    let depth = 0;
    let end = css.indexOf("{", at);
    do {
      if (css[end] === "{") depth += 1;
      if (css[end] === "}") depth -= 1;
      end += 1;
    } while (depth > 0);
    blocks.push(css.slice(at, end));
    at = css.indexOf("@media (max-width: 640px) {", end);
  }
  return blocks.join("\n");
}

/* The compact sheet has to be reachable without running any JavaScript. The
 * module that decides it is deferred, so a state set from a script would show
 * the open sheet for a frame before it slid shut. Guarding the stylesheet
 * rather than the DOM because that frame is the bug, and no DOM assertion can
 * see it. */
test("a narrow screen starts with the sheet compact, before any script runs", () => {
  const css = fs.readFileSync(path.join(REPO, "style.css"), "utf8");
  const narrow = narrowRules(css);
  const rule = (selector) => {
    const start = narrow.indexOf(`\n  ${selector} {`);
    assert.notEqual(start, -1, `no narrow rule for ${selector}`);
    return narrow.slice(start, narrow.indexOf("}", start));
  };

  assert.match(rule("#panel-shell"), /bottom: 0;/);
  assert.match(rule("#panel-shell"), /top: auto;/);
  assert.match(rule("#panel-shell:not(.expanded)"), /transform: translateY\([^;]*var\(--sheet-visible/);
  assert.doesNotMatch(
    narrow,
    /#panel:not\(\.expanded\)|\.collapsed/,
    "the compact sheet hides its content by translation, not by display",
  );

  // The band drags the sheet; the content scrolls until it is at its top.
  assert.match(rule("#panel-nav"), /touch-action: none/);
  assert.match(rule("#panel-body"), /touch-action: pan-y/);

  // The map's furniture rides the sheet's top edge.
  assert.match(
    narrow,
    /\.maplibregl-ctrl-bottom-left,\s*#map \.maplibregl-ctrl-bottom-right \{[^}]*bottom: var\(--sheet-visible/,
  );
  assert.match(rule("#notices"), /bottom: calc\(var\(--sheet-visible/);
  assert.match(
    narrow,
    /:is\(\.maplibregl-ctrl-scale, \.maplibregl-ctrl-attrib\) \{[^}]*opacity: calc\(1 - var\(--sheet-progress/,
    "the scale bar and the credit fade as the sheet opens",
  );
  assert.match(
    narrow,
    /body:has\(#panel-shell\.expanded:not\(\.dragging\)\) #map :is\([^)]*\) \{[^}]*visibility: hidden/,
    "and are hidden once it is open",
  );
});

/* On a viewport too short for the controls, whichever box scrolls decides
 * whether the handle can be reached at all. Stylesheet again, because
 * jsdom lays nothing out. */
test("the controls scroll under the band rather than taking it with them", () => {
  const css = fs.readFileSync(path.join(REPO, "style.css"), "utf8");
  const block = (selector) => {
    const start = css.indexOf(`\n${selector} {`);
    assert.notEqual(start, -1, `no rule for ${selector}`);
    return css.slice(start, css.indexOf("}", start));
  };

  assert.match(block("#panel-body"), /overflow-y: auto/);
  assert.doesNotMatch(block("#panel"), /overflow-y: auto/);
});

test("a narrow viewport opens with the sheet compact", async () => {
  const page = installBrowser({
    narrow: true,
    files: { "data/inventories.json": path.join(REPO, "data", "inventories.json") },
  });
  const { el } = page;

  await load("js/app.js");
  await settle();

  const expanded = () => el("panel-shell").classList.contains("expanded");
  assert.equal(expanded(), false, "the controls do not cover the map");
  assert.equal(el("sheet-handle").getAttribute("aria-expanded"), "false");
  assert.match(el("sheet-handle").getAttribute("aria-label"), /show/i);

  // The wordmark is what names the page, through the image's alt text.
  assert.equal(el("title").querySelector("img").alt, "GLACE");

  el("sheet-handle").click();
  assert.ok(expanded(), "and a tap brings them up");
  assert.equal(el("sheet-handle").getAttribute("aria-expanded"), "true");
  assert.match(el("sheet-handle").getAttribute("aria-label"), /hide/i);

  el("sheet-handle").click();
  assert.equal(expanded(), false, "and lowers them again");
});
