# Bottom-Sheet Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the collapsible top panel with a tabbed panel whose band carries the legend, docked to the bottom as a two-height sheet on phones and always open at the top left on desktop.

**Architecture:** One panel structure for every width: a navigation band (handle, legend, tab pills) over a scrolling tab area that ends with an About button. CSS places it as today's 292 px card on desktop and as a bottom sheet below 640 px; a new `js/sheet.js` drives the sheet with pointer and touch events, one CSS transform and three custom properties that also place the map furniture. The wordmark leaves the panel and floats over the map.

**Tech Stack:** Vanilla ES modules, CSS, MapLibre GL controls, `node --test` with jsdom 30 (has `PointerEvent` and `TouchEvent`, no `setPointerCapture`, no `visualViewport`, no layout).

**Spec:** `docs/superpowers/specs/2026-10-16-bottom-sheet-navigation-design.md`

## Global Constraints

- Read AGENTS.md first; its contracts hold unless this plan changes them.
- Breakpoint `(max-width: 640px)`: one `matchMedia` object exported from `js/ui.js` as `NARROW_VIEWPORT`, and the same query in every `style.css` media rule.
- No new dependencies, no animation loop: the sheet moves only from input events and CSS transitions.
- Every font size is `calc(<px> * var(--text-scale))`; touch sizes go in the `(pointer: coarse)` block; hover styles under `@media (hover: hover)`.
- Text from the catalog goes through `h()` or `textContent`.
- A new `js/` module joins the `modulepreload` list in `index.html`; an edited inline script gets its CSP hash replaced (`page-assets.test.js` prints the right one).
- Interface text in US English. Labels fixed by the spec: pills "Layers", "Inventories", "Map"; button "About this map"; handle "Show the controls" / "Hide the controls".
- Run `pixi run --locked test` before every commit; it must pass.
- jsdom does no layout: anything about placement is asserted on `style.css` text, as `viewer-narrow.test.js` already does, and checked in a real browser in Task 7.

## Review Focus

1. A vertical swipe that starts on the year or opacity slider in the open sheet: the slider keeps it, the sheet does not move (test in Task 5).
2. A tap on a pill or the legend with a few pixels of jitter still clicks; a drag that started on a pill does not also select it (test in Task 5).
3. Crossing the breakpoint while the sheet is open or mid-drag: desktop gets no leftover inline transform or custom properties, phones restart compact (test in Task 5).
4. A keyboard user on a phone with the sheet compact cannot Tab into the hidden tab content (test in Task 5).
5. The catalog fails to load: the band shows its one-line message, the Layers pill hides and another tab is selected, and the page still works (test in Task 3).

---

### Task 1: Scale bar and credit corners

**Files:**
- Modify: `js/ui.js` (export `NARROW_VIEWPORT`), `js/app.js:36` (import it instead of its own), `js/map.js:111-121`
- Modify: `tests/helpers/browser.js:94-101` (record positions, add `removeControl`)
- Test: `tests/viewer.test.js`, `tests/viewer-narrow.test.js`

**Interfaces:**
- Produces: `export const NARROW_VIEWPORT = window.matchMedia("(max-width: 640px)")` in `js/ui.js`, used by Tasks 3, 5, 6. FakeMap gains `positions: Map<control, string>` and `removeControl(control)`.

- [ ] **Step 1: Teach the fake map positions.** In `addControl(control, position)` set `this.positions.set(control, position)` and push to `controls`; add `removeControl(control)` that deletes it from both.
- [ ] **Step 2: Write the failing tests.** In `viewer.test.js` (wide):

```js
await t.test("the scale bar sits above the expanded credit at the bottom right", () => {
  const isA = (cls) => (c) => c instanceof globalThis.maplibregl[cls];
  const scale = map.controls.find(isA("ScaleControl"));
  const credit = map.controls.find(isA("AttributionControl"));
  assert.equal(map.positions.get(scale), "bottom-right");
  assert.ok(map.controls.indexOf(scale) > map.controls.indexOf(credit), "added later, so drawn above");
  assert.equal(credit.options.compact, undefined, "MapLibre collapses it only on narrow maps");
});
```

In `viewer-narrow.test.js`: the scale bar's position is `"bottom-left"`; after `page.setNarrow(false)` it is `"bottom-right"` and later in `controls` than the credit; after `page.setNarrow(true)` it is `"bottom-left"` again.

- [ ] **Step 3: Run** `node --test tests/viewer.test.js tests/viewer-narrow.test.js`. Expected: the new assertions FAIL.
- [ ] **Step 4: Implement `placeScaleBar(narrow: boolean): void` in `js/map.js`.** Keep one `ScaleControl`; remove it if added and add it again at `narrow ? "bottom-left" : "bottom-right"`. Add the credit first, then call `placeScaleBar(NARROW_VIEWPORT.matches)` and subscribe to `NARROW_VIEWPORT` changes. Drop `compact: true`. In `style.css`, shrink the bottom margin of a `.maplibregl-ctrl-scale` in the bottom-right corner to 6 px so it pairs with the credit.
- [ ] **Step 5: Run** `pixi run --locked test`. Expected: PASS.
- [ ] **Step 6: Commit** `git commit -m "Put the scale bar above the expanded credit on desktop"`.

---

### Task 2: The floating wordmark

**Files:**
- Modify: `assets/glace-wordmark.svg`, `index.html:68-90` (move `<h1 id="title">` out of `#panel`, delete `#subtitle`), `style.css:161-230` (header rules)
- Test: `tests/page-assets.test.js`, `tests/viewer-narrow.test.js`

**Interfaces:**
- Produces: `<h1 id="title">` as a direct child of `<body>`, after `#map`, holding the same `<img alt="GLACE">`. No element `#subtitle`.

- [ ] **Step 1: Write the failing tests** in `page-assets.test.js`:

```js
test("the wordmark has a uniform, semi-transparent outline, not a glow", () => {
  const svg = fs.readFileSync(path.join(REPO, "assets/glace-wordmark.svg"), "utf8");
  assert.match(svg, /stroke="#fff"/);
  assert.match(svg, /stroke-opacity="0\.6"/);
  assert.match(svg, /paint-order="stroke"/);
  assert.match(svg, /stroke-linejoin="round"/);
  const css = fs.readFileSync(path.join(REPO, "style.css"), "utf8");
  assert.doesNotMatch(css, /#title[^{]*\{[^}]*drop-shadow/);
});

test("the wordmark floats over the map and lets drags through", () => {
  const doc = page();
  assert.equal(doc.getElementById("title").parentElement, doc.body);
  assert.equal(doc.getElementById("subtitle"), null);
  const css = fs.readFileSync(path.join(REPO, "style.css"), "utf8");
  assert.match(css, /#title \{[^}]*pointer-events: none/);
});
```

In `viewer-narrow.test.js`, delete the `#subtitle` click assertions.

- [ ] **Step 2: Run** `node --test tests/page-assets.test.js tests/viewer-narrow.test.js`. Expected: FAIL.
- [ ] **Step 3: Outline the SVG.** On the single `<path>`, add `stroke="#fff" stroke-opacity="0.6" stroke-width="70" stroke-linejoin="round" paint-order="stroke"`. That is 1.5 px outside the glyphs at the 18 px glyph height used below (418.9 units ÷ 18 px × 3 px). Pad the viewBox to `-40 -40 2153.7 498.9` and set the `<img>` to `width="2154" height="499"`.
- [ ] **Step 4: Place it.** `#title`: `position: absolute; margin: 0; z-index: 1; pointer-events: none`; `img` height `calc(18px * 498.9 / 418.9)`, so the glyphs stay 18 px. Desktop: `left: 12px; bottom: 12px`. Narrow: `left: 12px; top: calc(12px + env(safe-area-inset-top)); bottom: auto`. Remove the rules for `#panel h1` and `#subtitle`, and the `.header-text` wrapper.
- [ ] **Step 5: Run** `pixi run --locked test`. Expected: PASS.
- [ ] **Step 6: Commit** `git commit -m "Float the outlined wordmark over the map and drop the subtitle"`.

---

### Task 3: Band, legend and tabs

The panel's new structure, working on desktop. Phones keep today's top card,
opened by the handle, until Task 5.

**Files:**
- Modify: `index.html:70-190` (panel markup), `style.css` (panel, legend, pills, About button; delete the `<details>` and chevron rules), `js/ui.js` (tabs, `rove`), `js/app.js` (wiring), `js/rasters.js:328-351, 422-476, 1075-1125`, `js/overlays.js:221, 251`
- Test: `tests/ui.test.js`, `tests/legend.test.js`, `tests/store-catalog.test.js`, `tests/stale-state.test.js`, `tests/viewer-degraded.test.js`, `tests/viewer.test.js`, `tests/viewer-narrow.test.js`

**Interfaces:**
- Consumes: `NARROW_VIEWPORT` (Task 1).
- Produces the markup that Tasks 4–6 style and drive:

```html
<aside id="panel">
  <div id="panel-nav">
    <button type="button" id="sheet-handle" aria-controls="panel-body" aria-expanded="false"></button>
    <section id="legend" aria-busy="true">
      <div class="control-head">
        <span id="selection-summary">Loading layers…</span>
        <span id="cmap" class="visually-hidden"></span>
        <button type="button" id="legend-edit" …>Edit</button>
      </div>
      <div id="legend-slot">  <!-- one fixed height: ramp+labels, channel row, or note -->
        <div id="legend-bar"></div><div id="legend-labels">…</div>
        <div id="legend-channels" hidden></div>
        <p id="legend-note" hidden></p>
      </div>
    </section>
    <div id="tabs" role="tablist" aria-label="Controls">
      <button type="button" role="tab" id="tab-layers" aria-controls="raster-controls" aria-selected="true">Layers</button>
      <button type="button" role="tab" id="tab-inventories" aria-controls="inventories-section" aria-selected="false">Inventories</button>
      <button type="button" role="tab" id="tab-map" aria-controls="extras" aria-selected="false">Map</button>
    </div>
  </div>
  <div id="panel-body">
    <div id="raster-controls" role="tabpanel" aria-labelledby="tab-layers" aria-busy="true">…</div>
    <section id="inventories-section" role="tabpanel" aria-labelledby="tab-inventories" hidden>…</section>
    <section id="extras" role="tabpanel" aria-labelledby="tab-map" hidden>…</section>
    <button type="button" id="about-open" aria-haspopup="dialog" aria-controls="about">About this map</button>
  </div>
</aside>
```

- In `js/ui.js`: `buildTabs(list: HTMLElement): void` wires clicks and arrow keys; `selectTab(tab: HTMLElement): void` sets `aria-selected`, shows its panel, hides the others and calls `rove(list)`; `hideTab(tab: HTMLElement, hidden: boolean): void` hides a pill and, if it was selected, selects the first visible one. `rove()` also treats `aria-selected="true"` as checked and skips `hidden` buttons.
- `#legend-note` holds the band's one-line messages; `#legend` is never hidden any more.

- [ ] **Step 1: Write the failing tests.**
  - `ui.test.js`: build three tabs; clicking the second selects it, shows its panel and hides the others; ArrowRight from the last selects the first; `hideTab` on the selected tab selects the first visible one; the selected tab has `tabIndex` 0 and the others −1.
  - `viewer.test.js`: at startup `tab-layers` is selected and `inventories-section` and `extras` are hidden; clicking `tab-map` shows `extras`; there are no `<details>` elements in `#panel`; `#about-open` is the last child of `#panel-body` and opens `#about`.
  - `stale-state.test.js`, "a missing combination…": for a year without the archive, `el("legend").hidden` is `false`, `legend-bar` is hidden, `legend-note` reads `No Coherence VH layer for 2022` (whatever `selectionName()` gives for the fixture), `legend-edit` is hidden, and `el("status").hidden` is `true`. When the layer returns, the note hides and the bar shows.
  - `store-catalog.test.js` and `legend.test.js`, false color: `legend-channels` shows one row per channel, with swatch, channel letter and band name visible. The `.range` cells stay in the DOM inside `.visually-hidden`, so the existing `cells[…]` and `.modified` assertions keep passing. `#cmap` keeps its text and has class `visually-hidden`.
  - `viewer-degraded.test.js`, failed catalog: `tab-layers` is hidden, the selected tab is `tab-inventories`, `legend-note` reads `The GLACE layers could not be loaded.`, the status line still shows the existing error, and `inventories-section` is visible. If the inventory index also fails, `tab-map` is selected.
  - `viewer-narrow.test.js`: swap `panel-toggle` for `sheet-handle` (same labels and `aria-expanded`); drop the `#about-open`-in-header and collapsed-header click assertions.
- [ ] **Step 2: Run** `pixi run --locked test-js`. Expected: the new assertions FAIL.
- [ ] **Step 3: Rewrite the panel markup as above.**
  - Move `#legend` from `#raster-controls` into `#panel-nav`, keeping its `&nbsp;` placeholders, and put `#selection-summary` in its head as the title.
  - Delete the `<header>`, both `<details>`/`<summary>` pairs, `#inventories-rule`, the chevrons and the `<hr>`.
  - The handle is empty: its look comes from CSS, and `setPanelOpen` sets its label.
- [ ] **Step 4: Implement the tab helpers in `js/ui.js`** with the signatures above.
- [ ] **Step 5: Wire `js/app.js`.**
  - `buildTabs(el("tabs"))`.
  - `setPanelOpen` now targets `#sheet-handle` and no longer touches a chevron. Drop the collapsed-header click handler.
  - Keep the `NARROW_VIEWPORT` reset (Task 5 replaces it).
- [ ] **Step 6: Update `js/rasters.js`.**
  - `render()` stops hiding `#legend`. With no layer it shows `#legend-note` with `` `No ${selectionName()} for ${state.year}` ``, hides the bar, labels, channels and Edit, and clears `STATUS_KEY` instead of setting the info status.
  - `updateLegend()` hides the note.
  - `updateChannelLegend()` wraps each `.range` cell in a `.visually-hidden` span.
  - `noRasters()`: instead of hiding `#raster-controls` and `#selection-summary`, call `hideTab(el("tab-layers"), true)`, show the note `The GLACE layers could not be loaded.`, hide the bar and labels, and keep the status error.
  - `loadRasters()` removes `aria-busy` from `#legend` as well as `#raster-controls`.
- [ ] **Step 7: Update `js/overlays.js`.** Where it set `inventories-section.hidden`, call `hideTab(el("tab-inventories"), …)` with the same condition.
- [ ] **Step 8: Style it.**
  - Pills: `flex: none`, sized to their label plus 14 px side padding, `justify-content: space-between` across the band. Only `[aria-selected="true"]` gets the 1 px accent outline (`--accent`) and full-strength text; the others are `--muted` text with no border.
  - `#legend-slot` gets a `min-height` equal to the ramp plus its labels, so the band keeps its height in every state.
  - `#legend-channels` becomes one flex row.
  - `#about-open` is a full-width outlined button.
  - The desktop panel has no `.collapsed` state any more. Remove `#panel.collapsed …` and the `#panel-toggle` rules, but keep the narrow `#panel:not(.expanded) #panel-body { display: none }` default until Task 5.
- [ ] **Step 9: Run** `pixi run --locked test`. Expected: PASS. Open `http://localhost:8000/` at desktop width (`pixi run --locked serve`) and check all three tabs, the legend and About.
- [ ] **Step 10: Commit** `git commit -m "Put the legend in the panel's band and split the controls into tabs"`.

---

### Task 4: One glass, two tints

**Files:**
- Modify: `style.css` (`#panel`, `#panel-nav`, `#panel-body`, the `@supports (backdrop-filter…)` block)
- Test: `tests/page-assets.test.js`

- [ ] **Step 1: Write the failing test.** Inside the `@supports (backdrop-filter…)` block, `#panel-nav` and `#panel-body` each set `background: hsl(var(--glass-tint) / var(--glass-alpha-nav|--glass-alpha-body))`, and `#panel` sets no tint of its own there.
- [ ] **Step 2: Run** `node --test tests/page-assets.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Add `--glass-alpha-nav: 0.42` and `--glass-alpha-body: 0.82` beside `--glass-alpha`.
  - `#panel` keeps its border and radius, but its glass background becomes `transparent`.
  - Move the padding from `#panel` into the two regions, and separate them with a `rgba(255, 255, 255, 0.08)` hairline.
  - The opaque fallback outside `@supports`: `#panel-nav` `#1c2331`, `#panel-body` `var(--panel)`.
- [ ] **Step 4: Run** `pixi run --locked test`. Expected: PASS. In a browser, check the pill and summary text over the brightest coherence color map and over World Imagery snow; raise `--glass-alpha-nav` until both stay legible.
- [ ] **Step 5: Commit** `git commit -m "Tint the panel's band lighter than its controls over one glass"`.

---

### Task 5: The phone sheet

**Files:**
- Create: `js/sheet.js`, `tests/sheet.test.js`
- Modify: `style.css` (the `max-width: 640px` block, `#notices`, map corners), `js/app.js` (replace `setPanelOpen` and the reset with `initSheet`), `js/overlays.js:394` (popup anchor), `index.html` (`modulepreload`)
- Test: `tests/sheet.test.js`, `tests/viewer-narrow.test.js`, `tests/page-assets.test.js`

**Interfaces:**
- Consumes: `NARROW_VIEWPORT`; markup from Task 3.
- Produces, in `js/sheet.js`:
  - `export const LOCK_PX = 8;` (movement before a gesture is classified) and `export const FLICK = 0.5;` (px/ms).
  - `export function lockAxis(dx: number, dy: number): "x" | "y" | null`: `null` until `Math.hypot(dx, dy) >= LOCK_PX`; then `"y"` if `|dy| > |dx|`, else `"x"`.
  - `export function snapTarget(progress: number, velocity: number): "open" | "compact"`: `progress` is 0 for compact and 1 for open; `velocity` is px/ms, positive upward. Past `±FLICK` it follows the flick, otherwise `progress >= 0.5` means open.
  - `export function initSheet(): void`: wires everything below; a no-op on desktop except for listening to the breakpoint.
  - `export function setSheetOpen(open: boolean): void`: also used by Task 6.
  - `export function popupAnchor(y: number): "bottom" | undefined`: on a narrow viewport, `"bottom"` when the click's map y is below half the map left visible above the sheet (`(innerHeight - visible) / 2`), so the popup opens upward and not under the sheet. Otherwise `undefined`, which lets MapLibre choose.
- The sheet's state classes, `.expanded` and `.dragging`, move to `#panel-shell`, which holds the glass and the transform.
- Custom properties on `document.documentElement` (narrow only, removed on desktop):
  - `--sheet-travel`: px between the two heights.
  - `--sheet-progress`: 0–1.
  - `--sheet-visible`: px of sheet above the bottom edge.

- [ ] **Step 1: Write the failing pure tests** in `sheet.test.js`. `lockAxis(3, 4)` is `null`, `lockAxis(2, 9)` is `"y"` and `lockAxis(9, 2)` is `"x"`. `snapTarget(0.3, 0)` is `"compact"`, `snapTarget(0.6, 0)` is `"open"`, `snapTarget(0.2, 0.8)` is `"open"` and `snapTarget(0.9, -0.8)` is `"compact"`.
- [ ] **Step 2: Write the failing behavior tests** in `sheet.test.js`. Use `installBrowser({ narrow: true })`, then `load("js/app.js")`. Stub `offsetHeight` on `#panel-shell` (500) and `#panel-nav` (90) with `Object.defineProperty`. Send `PointerEvent`s with `pointerType: "touch"` and `TouchEvent`s where noted.
  - Starts compact: `#panel-shell` lacks `.expanded`, `#sheet-handle` has `aria-expanded="false"`, `#panel-body` is `inert`, and `--sheet-visible` is `90px`.
  - Clicking the handle opens it: `.expanded` is set, `#panel-body` is not `inert`, `--sheet-progress` is `1` and the handle's label reads "Hide the controls". A second click closes it.
  - A drag on `#panel-nav` from y=400 to y=200 with no pause opens the sheet. Mid-drag, `--sheet-progress` lies strictly between 0 and 1.
  - A drag that starts on `#tab-map` and travels 40 px does not select `tab-map` (Review Focus 2). A pointerdown and pointerup 3 px apart on `#tab-map` selects it.
  - Open sheet, a pointerdown on `#year` then a 60 px vertical move: the sheet stays open and `--sheet-progress` stays 1 (Review Focus 1).
  - Open sheet with `#panel-body.scrollTop = 0`: a `touchmove` 120 px down from inside `#panel-body` closes the sheet. With `scrollTop = 50`, the same gesture leaves it open.
  - Open sheet, then `page.setNarrow(false)`: `#panel-shell` has no inline `transform`, the root has no `--sheet-*` properties, and `#panel-body` is not `inert`. `page.setNarrow(true)` brings it back compact (Review Focus 3).
  - Compact: `#panel-body` has `inert` (Review Focus 4).
  - `popupAnchor`: with `innerHeight` 844 and the sheet compact (visible 90 px), `popupAnchor(500)` is `"bottom"` and `popupAnchor(200)` is `undefined`. After `setNarrow(false)`, `popupAnchor(800)` is `undefined`.
- [ ] **Step 3: Write the failing stylesheet tests** in `viewer-narrow.test.js`, replacing the old "collapsed by the stylesheet" test. In the `max-width: 640px` block, `#panel-shell` has `bottom: 0` and `top: auto`, and `#panel-shell:not(.expanded)` translates by `var(--sheet-visible`, so the page starts compact before any script runs. `#panel-nav` has `touch-action: none` and `#panel-body` has `touch-action: pan-y`. The bottom map corners and `#notices` use `var(--sheet-visible`. The scale bar and credit use `opacity: calc(1 - var(--sheet-progress`. Add `js/sheet.js` to the `modulepreload` list.
- [ ] **Step 4: Run** `pixi run --locked test-js`. Expected: FAIL.
- [ ] **Step 5: Implement `js/sheet.js`.** Behavior to get right:
  - **Measuring.** `travel = panel.offsetHeight - nav.offsetHeight`, re-measured with a `ResizeObserver` on `#panel-nav` where one exists (none in jsdom).
  - **The band and the compact sheet.** Pointer events. On `pointerdown`, record the start and time and call `setPointerCapture?.()`. Classify with `lockAxis`. On `"y"`, drag: write `--sheet-progress` from the offset and add `.dragging`, which disables the transition. On `pointerup`, apply `snapTarget` and, if the gesture was a drag, swallow the next `click` in the capture phase. A gesture that never locks is a tap and clicks normally, which is how a tap on the legend opens the editor. A gesture that starts on an `input[type="range"]` never drags.
  - **The tab content.** `touchstart`/`touchmove` with `{ passive: false }`. Only when `scrollTop <= 0`, the gesture locks to `"y"` moving down, and it didn't start on a range input: `preventDefault()` and drag the sheet as above. `touchend` snaps.
  - **`setSheetOpen(open)`.** Toggles `.expanded` on `#panel-shell`, the handle's `aria-expanded` and label, `inert` on `#panel-body`, and `--sheet-progress` (0 or 1). `--sheet-visible` becomes `nav + progress × travel` px.
  - **The breakpoint.** On a change to wide, remove the inline style, the root properties, `inert` and `.dragging`. On a change to narrow, `setSheetOpen(false)`.
- [ ] **Step 6: Style the sheet** in the `max-width: 640px` block.
  - `#panel-shell`: `top: auto; left: 0; right: 0; bottom: 0; width: auto; height: 66dvh; max-height: none`, with radius only on the top corners and `padding-bottom: env(safe-area-inset-bottom)`.
  - The transform lives on `#panel-shell`, so the glass moves with the panel: `translateY(calc(var(--sheet-travel, 0px) * (1 - var(--sheet-progress, 0))))`, with a 220 ms ease-out `transition: transform`. `#panel` is `height: 100%`.
  - Before scripts run, `#panel-shell:not(.expanded)` translates by `calc(66dvh - var(--sheet-visible, 92px))`, so it starts compact. Set the 92 px default to the band's loaded height as measured in a browser.
  - `#panel-shell.dragging` has `transition: none`. Under `@media (prefers-reduced-motion: reduce)`, use `transition: none` too.
  - The handle is a 36×4 px bar centered at the top of the band, with a 44 px-tall `::after` tap area.
  - `.maplibregl-ctrl-bottom-left` and `.maplibregl-ctrl-bottom-right` get `bottom: var(--sheet-visible, 92px)`, and `#notices` gets `bottom: calc(var(--sheet-visible, 92px) + 12px)`. The scale bar and credit get `opacity: calc(1 - var(--sheet-progress, 0))`, plus `visibility: hidden` under `body:has(#panel-shell.expanded:not(.dragging))`.
  - Remove the old narrow rules for `#panel-shell` (`right: 64px`, `max-height: 46%`) and for the collapsed summary.
- [ ] **Step 7: Wire it up.** In `js/app.js`, replace `setPanelOpen`, its handle listener and the `NARROW_VIEWPORT` reset with `initSheet()`. In `js/overlays.js`'s `inspect()`, pass `anchor: popupAnchor(point.y)` to the `Popup`.
- [ ] **Step 8: Run** `pixi run --locked test`. Expected: PASS. In the browser's device mode at 390×844, swipe the sheet up and down, flick it, drag the year slider sideways, and scroll the Layers tab, then pull it down from the top.
- [ ] **Step 9: Commit** `git commit -m "Dock the panel to the bottom on phones as a two-height sheet"`.

---

### Task 6: The phone scale editor

**Files:**
- Modify: `style.css:1227-1240` (the narrow scale-editor rules), `js/rasters.js:914-945` (`initLegend`)
- Test: `tests/legend.test.js` or a new `tests/legend-narrow.test.js` (a fresh narrow page needs its own file)

**Interfaces:**
- Consumes: `NARROW_VIEWPORT`; `setSheetOpen` (Task 5).
- Produces: a root custom property `--keyboard-inset` (px), set while the editor is open on a narrow viewport.

- [ ] **Step 1: Write the failing tests** in `tests/legend-narrow.test.js` (`installBrowser({ narrow: true })`).
  - Open the editor from the compact sheet; close it with its close button. The sheet is still compact, and focus returns to `#legend-edit`.
  - Stub `window.visualViewport` as an `EventTarget` with `height: 500` and `offsetTop: 0`, and `window.innerHeight` as 844. Open the editor, focus a limit input and dispatch `resize`: `--keyboard-inset` is `344px`. Close the editor: the property is removed.
  - Stylesheet: in the narrow block, `#scale-editor` has `bottom: var(--keyboard-inset, 0px)`, `top: auto`, `left: 0`, `right: 0` and `max-height: 60dvh`. `body:has(#scale-editor[open])` hides `#panel-shell`, hides the scale bar and credit, and gives `#notices` `top: calc(…env(safe-area-inset-top)…)` with `bottom: auto`.
- [ ] **Step 2: Run** `node --test tests/legend-narrow.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement the keyboard handling in `js/rasters.js`.** On editor `show`, if `NARROW_VIEWPORT.matches` and `window.visualViewport` exists, listen to its `resize` and `scroll`. Set `--keyboard-inset` to `Math.max(0, innerHeight - (vv.height + vv.offsetTop))` px. On `focusin` of a limit input, call `scrollIntoView({ block: "nearest" })` after the next resize. Stop listening and remove the property on `close`.
- [ ] **Step 4: Style it.**
  - The editor is docked to the bottom: full width, radius only on the top corners, the band styling on its header, no handle, and `padding-bottom: env(safe-area-inset-bottom)`.
  - Its content scrolls past `60dvh`.
  - `#notices` moves below the wordmark: `top: calc(12px + env(safe-area-inset-top) + 32px)`.
- [ ] **Step 5: Run** `pixi run --locked test`. Expected: PASS.
- [ ] **Step 6: Commit** `git commit -m "Dock the scale editor above the keyboard on phones"`.

---

### Task 7: Contributor notes and a device check

**Files:**
- Modify: `AGENTS.md`, `.gitignore`

- [ ] **Step 1: Update AGENTS.md** to describe what changed:
  - **The panel:** the band, tabs and About button; the sheet's two heights; no minimizing on desktop.
  - **The collapsed header** paragraph becomes the compact sheet.
  - **Loading:** the placeholder now lives in the band's legend.
  - **Empty states:** the per-year message and the no-raster message.
  - **The scale editor** docks to the bottom on phones, above the keyboard.
  - **`#notices`** rides the sheet, and moves to the top while editing.
  - **The attribution:** expanded on desktop, collapsed on narrow maps, faded under the open sheet.
  - **The scale bar's** corner at each breakpoint.
  - **The wordmark's** outline.
  - **The code map:** add `js/sheet.js`.
  - **The test table:** add `sheet`, `legend-narrow`.
- [ ] **Step 2: Add `.superpowers/`** to `.gitignore`.
- [ ] **Step 3: Run** `pixi run --locked test`. Expected: PASS.
- [ ] **Step 4: Device check, and report the results.** On an iPhone in Safari and a mid-range Android phone in Chrome, check each of these:
  - The page loads compact with no flash of the open sheet.
  - A swipe up and a swipe down work.
  - The tab content scrolls only when the sheet is open.
  - The year slider never moves the sheet.
  - The scale bar and credit ride the sheet and fade out.
  - Typing a limit keeps the field above the keyboard.
  - Dragging stays smooth over the blurred glass.
  - Rotating to landscape gives the desktop layout.
  - A tap just above the sheet opens its popup upward, in full view.
- [ ] **Step 5: Commit** `git commit -m "Describe the bottom sheet and tabbed panel in the contributor notes"`.
