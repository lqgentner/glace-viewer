/*
 * The page in a browser without WebGL2, which MapLibre 6 requires. The map is
 * built at module scope and everything depends on it, so the page cannot run,
 * but it says so instead of showing an empty frame. Its own file because the
 * map is a module singleton.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { installBrowser, load } from "./helpers/browser.js";

test("no WebGL2 is reported on the status line before the page gives up", async () => {
  const page = installBrowser({ webgl: false });

  await assert.rejects(load("js/app.js"), /WebGL2/);

  assert.equal(page.el("status").hidden, false);
  assert.match(page.el("status").textContent, /WebGL2/);
  assert.equal(page.map, undefined, "no map was built");
});
