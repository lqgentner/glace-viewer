/*
 * The page on a phone-sized viewport.
 *
 * Its own file because the panel's opening state is decided once, at boot, from
 * the media query — the same reason viewer-3d-restore.test.js stands apart.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { installBrowser, load, REPO, settle } from "./helpers/browser.js";

test("a narrow viewport opens with the panel collapsed", async () => {
  const page = installBrowser({
    narrow: true,
    files: { "data/inventories.json": path.join(REPO, "data", "inventories.json") },
  });
  const { el } = page;

  await load("js/app.js");
  await settle();

  assert.equal(el("panel-body").hidden, true, "the controls do not cover the map");
  assert.equal(el("panel-toggle").getAttribute("aria-expanded"), "false");
  assert.match(el("panel-toggle").getAttribute("aria-label"), /show/i);

  // The title bar is what is left, so the reader can still see what this is
  // and get the controls back.
  assert.equal(el("title").textContent, "GLACE");

  el("panel-toggle").click();
  assert.equal(el("panel-body").hidden, false, "and a tap brings them back");
  assert.match(el("panel-toggle").getAttribute("aria-label"), /hide/i);
});
