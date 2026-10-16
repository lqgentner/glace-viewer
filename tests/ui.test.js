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

test("status: failures and notes are announced, progress is not", async () => {
  const { page, ui } = await loadUi();
  const live = page.el("status-live");
  assert.equal(live.getAttribute("role"), "status");
  ui.setStatus("rasters", "Loading layers…");
  assert.equal(live.textContent, "", "progress is shown but not spoken");
  ui.setStatus("grid", "Error loading the tile grid.", "error");
  assert.equal(live.textContent, "Error loading the tile grid.");
  ui.clearStatus("grid");
  ui.clearStatus("rasters");
  assert.equal(live.textContent, "");
});

test("segmented: arrow keys select the next choice, and Tab stops at the checked one", async () => {
  const { page, ui } = await loadUi();
  const { document, KeyboardEvent } = page.window;
  const group = document.createElement("div");
  document.body.append(group);
  const chosen = [];
  const select = (value) => {
    chosen.push(value);
    for (const button of group.children) button.setAttribute("aria-checked", String(button.dataset.value === value));
    ui.rove(group);
  };
  ui.buildSegmented(group, ["A", "B", "C"], select);
  select("A");
  group.children[1].disabled = true;
  const stops = () => [...group.children].map((button) => button.tabIndex);
  assert.deepEqual(stops(), [0, -1, -1]);

  const press = (key) => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  group.children[0].focus();
  press("ArrowRight");
  assert.deepEqual(chosen.at(-1), "C", "past the disabled choice");
  assert.equal(document.activeElement, group.children[2]);
  assert.deepEqual(stops(), [-1, -1, 0]);
  press("ArrowRight");
  assert.equal(chosen.at(-1), "A", "and round");
  press("ArrowUp");
  assert.equal(chosen.at(-1), "C");
});

test("popovers: the button says whether its popover is open, and focus moves in", async () => {
  const { page, ui } = await loadUi();
  const { document } = page.window;
  const button = ui.creditButton("T", { title: "T", links: [{ label: "D", url: "https://example.org" }] });
  document.body.append(button);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  button.click();
  const box = document.getElementById(button.getAttribute("aria-controls"));
  assert.ok(box.classList.contains("credit-popover"));
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(box.getAttribute("role"), "dialog");
  assert.equal(box.getAttribute("aria-label"), "T: attribution and license");
  assert.equal(document.activeElement, box.querySelector("a"), "to its first link");
  button.click();
  assert.equal(button.getAttribute("aria-expanded"), "false");
});

test("tabs: a click or the arrow keys select a tab and show only its panel", async () => {
  const { page, ui } = await loadUi();
  const { document, KeyboardEvent } = page.window;
  const list = document.createElement("div");
  const panels = ["a", "b", "c"].map((id, at) => {
    const tab = document.createElement("button");
    tab.id = `tab-${id}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", `panel-${id}`);
    tab.setAttribute("aria-selected", String(at === 0));
    list.append(tab);
    const panel = document.createElement("section");
    panel.id = `panel-${id}`;
    panel.hidden = at !== 0;
    return panel;
  });
  const body = document.createElement("div");
  body.append(...panels);
  document.body.append(list, body);
  // jsdom does not scroll; a writable scrollTop stands in.
  Object.defineProperty(body, "scrollTop", { configurable: true, writable: true, value: 0 });
  ui.buildTabs(list);
  const tabs = [...list.children];
  const selected = () => tabs.filter((tab) => tab.getAttribute("aria-selected") === "true");
  const shown = () => panels.filter((panel) => !panel.hidden);
  const stops = () => tabs.map((tab) => tab.tabIndex);
  assert.deepEqual(stops(), [0, -1, -1], "Tab stops at the selected tab");

  body.scrollTop = 120;
  tabs[1].click();
  assert.deepEqual(selected(), [tabs[1]]);
  assert.deepEqual(shown(), [panels[1]], "its panel shows, the others hide");
  assert.deepEqual(stops(), [-1, 0, -1]);
  assert.equal(body.scrollTop, 0, "the new panel shows from its top");
  body.scrollTop = 50;
  tabs[1].click();
  assert.equal(body.scrollTop, 50, "the selected tab again keeps the scroll");

  tabs[2].click();
  tabs[2].focus();
  tabs[2].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  assert.deepEqual(selected(), [tabs[0]], "from the last round to the first");
  assert.deepEqual(shown(), [panels[0]]);
  assert.equal(document.activeElement, tabs[0]);

  ui.hideTab(tabs[0], true);
  assert.equal(tabs[0].hidden, true);
  assert.deepEqual(selected(), [tabs[1]], "hiding the selected tab selects the first visible one");
  assert.deepEqual(shown(), [panels[1]]);
  assert.deepEqual(stops(), [-1, 0, -1]);
  tabs[1].focus();
  tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  assert.deepEqual(selected(), [tabs[2]], "the arrow keys skip a hidden tab");

  tabs[2].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  assert.deepEqual(selected(), [tabs[1]], "Home selects the first visible tab");
  assert.equal(document.activeElement, tabs[1]);
  ui.hideTab(tabs[0], false);
  tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  assert.deepEqual(selected(), [tabs[2]], "End selects the last tab");
  assert.equal(document.activeElement, tabs[2]);
  ui.hideTab(tabs[2], true);
  tabs[0].focus();
  tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  assert.deepEqual(selected(), [tabs[1]], "and skips a hidden one");
});
