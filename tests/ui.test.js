/* Check status priority and safe external-text rendering in attribution popovers. */

import assert from "node:assert/strict";
import test from "node:test";

import { freshImport, installBrowser } from "./helpers/browser.js";

// ui.js imports nothing of its own, so a cache-busted import is a clean slate.
const loadUi = async () => {
  const page = installBrowser();
  return { page, ui: await freshImport("js/ui.js") };
};

test("status: one entry shows, and clears", async () => {
  const { page, ui } = await loadUi();
  assert.equal(page.el("status").hidden, true);

  ui.setStatus("rasters", "Loading layers…");
  assert.equal(page.el("status").textContent, "Loading layers…");
  assert.equal(page.el("status").hidden, false);

  ui.clearStatus("rasters");
  assert.equal(page.el("status").hidden, true);
  assert.equal(page.el("status").textContent, "");
});

test("status: a failure outranks progress whichever arrives first", async () => {
  for (const errorFirst of [true, false]) {
    const { page, ui } = await loadUi();
    const write = {
      error: () => ui.setStatus("grid", "Tile grid unavailable", "error"),
      busy: () => ui.setStatus("inv-sgi2023", "Loading Swiss Glacier Inventory 2023…"),
    };
    if (errorFirst) {
      write.error();
      write.busy();
    } else {
      write.busy();
      write.error();
    }
    assert.equal(page.el("status").textContent, "Tile grid unavailable", `errorFirst=${errorFirst}`);
  }
});

test("status: clearing one entry does not clear another", async () => {
  const { page, ui } = await loadUi();
  ui.setStatus("grid", "Tile grid unavailable", "error");
  ui.setStatus("inv-sgi2023", "Loading…");

  // This is the race the keys exist for: an unrelated success used to blank the
  // element and take the failure with it.
  ui.clearStatus("inv-sgi2023");
  assert.equal(page.el("status").textContent, "Tile grid unavailable");

  ui.clearStatus("grid");
  assert.equal(page.el("status").hidden, true);
});

test("status: among equals the most recent wins", async () => {
  const { page, ui } = await loadUi();
  ui.setStatus("a", "first");
  ui.setStatus("b", "second");
  assert.equal(page.el("status").textContent, "second");

  // Rewriting an existing key makes it the most recent, not the oldest.
  ui.setStatus("a", "first again");
  assert.equal(page.el("status").textContent, "first again");
});

async function popoverFor(credit) {
  const { page, ui } = await loadUi();
  const button = ui.creditButton("Fallback title", credit);
  page.window.document.body.append(button);
  button.click();
  return page.window.document.querySelector(".credit-popover");
}

test("credits: a citation is shown verbatim, not parsed", async () => {
  const box = await popoverFor({
    title: "Swiss Glacier Inventory 2023",
    citation: '<img src=x onerror="fail()"> Someone et al. (2026)',
  });
  assert.equal(box.querySelector("img"), null, "no element was parsed out of the citation");
  assert.ok(box.textContent.includes("<img src=x"));
  assert.ok(box.textContent.includes("Someone et al. (2026)"));
});

test("credits: only a link that can be followed becomes a link", async () => {
  const box = await popoverFor({
    title: "T",
    license: "CC BY 4.0",
    license_url: "javascript:fail()",
    links: [
      { label: "Dataset", url: "https://doi.org/10.5194/essd-12-1805-2020" },
      { label: "Contact", url: "mailto:someone@example.org" },
      { label: "Nope", url: "data:text/html,<script>fail()</script>" },
    ],
  });

  assert.equal(box.querySelector('a[href^="javascript"]'), null);
  assert.ok(box.textContent.includes("License: CC BY 4.0"), "it degrades to text, not nothing");
  assert.ok(box.querySelector('a[href="https://doi.org/10.5194/essd-12-1805-2020"]'));
  assert.ok(box.querySelector('a[href="mailto:someone@example.org"]'));
  assert.equal(box.querySelector('a[href^="data:"]'), null);
  assert.ok(box.textContent.includes("Nope"));
});

test("credits: absent fields are omitted, and the title falls back", async () => {
  const box = await popoverFor({});
  assert.equal(box.querySelector("strong").textContent, "Fallback title");
  assert.equal(box.querySelector("a"), null);
  assert.ok(!box.textContent.includes("License"));
});

test("credits: every external link opens safely", async () => {
  const box = await popoverFor({ title: "T", links: [{ label: "D", url: "https://example.org" }] });
  const link = box.querySelector("a");
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "noopener noreferrer");
});

/* A tap fires mouseenter and focus before its click; the click must not close
 * what they opened. */
test("popovers: a credit opens on a tap's click, not on hover or focus", async () => {
  const { page, ui } = await loadUi();
  const { document, Event } = page.window;
  const button = ui.creditButton("T", { title: "T" });
  document.body.append(button);
  const box = () => document.querySelector(".credit-popover");

  button.dispatchEvent(new Event("mouseenter"));
  button.focus();
  assert.equal(box(), null, "hover and focus leave it closed");
  button.click();
  assert.ok(box(), "the click opens it");
  button.click();
  assert.equal(box(), null, "a second click closes it");
});

test("popovers: Escape closes a credit, refocusing the button only from inside", async () => {
  const { page, ui } = await loadUi();
  const { document, KeyboardEvent } = page.window;
  const button = ui.creditButton("T", { title: "T", links: [{ label: "D", url: "https://example.org" }] });
  document.body.append(button);
  const escape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const box = () => document.querySelector(".credit-popover");

  // Focus elsewhere is left alone.
  button.click();
  document.activeElement.blur();
  escape();
  assert.equal(box(), null);
  assert.notEqual(document.activeElement, button);

  // Focus inside the box goes back to the button.
  button.click();
  box().querySelector("a").focus();
  escape();
  assert.equal(box(), null);
  assert.equal(document.activeElement, button);
});

test("pickers: the current choice is pressed and focused; picking closes and refocuses", async () => {
  const { page, ui } = await loadUi();
  const { document, Event } = page.window;
  const button = document.createElement("button");
  document.body.append(button);
  const picked = [];
  let current = "b";
  ui.attachPicker(
    button,
    () => ["a", "b", "c"].map((value) => ({ value, current: value === current, label: value })),
    (value) => picked.push(value),
    { className: "test-picker" },
  );
  const box = () => document.querySelector(".test-picker");
  const choice = (value) => box().querySelector(`[aria-label="${value}"]`);

  button.dispatchEvent(new Event("mouseenter"));
  assert.equal(box(), null, "click only, not hover");
  button.click();
  assert.equal(choice("b").getAttribute("aria-pressed"), "true");
  assert.ok(choice("a").classList.contains("choice"), "one look for every picker's choices");
  assert.equal(choice("a").getAttribute("aria-pressed"), "false");
  assert.equal(document.activeElement, choice("b"));

  choice("c").click();
  assert.deepEqual(picked, ["c"]);
  assert.equal(box(), null);
  assert.equal(document.activeElement, button, "focus goes back to the button");
  assert.equal(button.classList.contains("popover-open"), false);
});
