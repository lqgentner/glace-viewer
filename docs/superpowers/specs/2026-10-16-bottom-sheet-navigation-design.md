# Bottom-sheet navigation and a tabbed panel

Date: 2026-10-16. Status: design, awaiting approval.

Mockups from the design conversation (v14 is the final one) are in
`.superpowers/brainstorm/401402-1792160532/content/`, which is not committed:
`scale-right.html` shows every state below. They are illustrations; where they
and this text differ, this text wins.

## Why

On phones the control panel sits at the top of the screen, out of thumb reach,
and opens through a small chevron. Collapsed, it shows the wordmark, a
subtitle and a one-line summary, but no legend, so a phone user looks at a
colored raster with no scale unless they open the panel. On desktop the panel
is a long list of three stacked sections, two of them collapsible.

The owner wants the controls at the bottom on phones, like the sheets in
Google Maps and the swisstopo app, and wants the legend promoted to the most
prominent, always-visible element on every layout.

## Goals

- On phones, a sheet docked to the bottom with two heights, opened and closed
  by swiping or by a tap on its handle.
- The legend, headed by the selection summary, visible on every view: compact
  sheet, open sheet on every tab, and desktop.
- The panel's three sections become three tabs ("pills"): Layers,
  Inventories, Map. The same structure on phones and desktop.
- Less chrome: no subtitle, no chevron, no wordmark inside the panel.

## Non-goals

- No change to what the controls do, the catalog joins, URL state, overlays,
  popups or the scale editor's internals.
- No change to the desktop scale editor's placement or the About dialog's
  content.
- Landscape phones (wider than 640 px) keep the desktop layout, as now.

## Anti-goals

- A sheet whose drag fights the controls inside it: a horizontal drag on the
  year or opacity slider, or on a scale-editor handle, must never move the
  sheet.
- Content that jumps: the sheet must not change height when the catalog
  arrives, or when switching tabs on a phone.
- A sheet usable only by swiping. Keyboard and screen-reader users must be
  able to open and close it.
- Drag polish that needs an animation loop or a gesture library. Pointer
  events, a CSS transform and one custom property are the budget.

## The design

### Shared structure (all widths)

The panel becomes two stacked regions over one frosted-glass pane:

1. **Navigation band**: on phones the drag handle; then the legend; then the
   pill row. A light tint.
2. **Tab content**: the active tab's controls, scrolling, followed by one
   "About this map" button. A denser tint.

**Glass.** Keep today's single blurred pane behind the panel
(`#panel-glass`). `#panel` stops painting the tint; the band paints
`hsl(var(--glass-tint) / <low alpha>)` and the content
`hsl(var(--glass-tint) / <high alpha>)`. Mockup values were 0.42 and 0.82;
tune them against the brightest color map. Without `backdrop-filter`, the
band and content get two opaque colors, the band slightly lighter.

**Legend in the band.** Its title line is today's selection summary
("2024 · Coherence VV") with the Edit affordance at its right; below it the
ramp and its two limits with units. The color-map name is dropped from the
legend; it shows only in the scale editor. False color shows one row naming
the three channels ("R VV · G VH · B VV/VH") with their swatches; the
per-channel limits move to the scale editor. A click anywhere on the legend
opens the scale editor, as today. `#selection-summary` and the Scale section
in the Layers controls cease to exist as separate elements.

**Pills.** A tab row: Layers, Inventories, Map ("Map options" is renamed
"Map"). Each pill is as wide as its label plus padding; the row spreads them
across the band. Only the active pill has an outline; the others are plain
text. Layers is active at startup. Inventories is hidden when the inventory
index is unreadable or empty, as its section is today.

- Layers: year, product, polarization, layer, opacity, layer description.
- Inventories: today's inventory list.
- Map: basemap, labels, terrain shading and its strength, catalog tile grid.

**About.** The header's About button goes. One "About this map" button ends
the scrolling content, after whichever tab is open. It opens the existing
About dialog.

**Wordmark.** Leaves the panel and floats over the map with no surface behind
it: top left on phones, bottom left on desktop. It is not interactive and
passes pointer events through to the map. It is still the page's `<h1>` with
alt text "GLACE". It gets a uniform white outline at 60% opacity, 1.5 px at
the displayed size, drawn as an SVG stroke behind the fill
(`paint-order="stroke"`, round joins), with the viewBox padded so the stroke
is not clipped. Not a blurred `drop-shadow` glow: the owner rejected that.

**Removed.** The subtitle, the chevron toggle, and the collapsible
`<details>` sections.

### Phones (max-width 640 px)

**Compact.** The sheet shows only the handle and the legend (about 80 px in
the mockup). Nothing in it scrolls, so a vertical swipe anywhere on it opens
the sheet. A tap on the legend opens the scale editor; a tap on the handle
opens the sheet.

**Open.** About two thirds of the viewport height (`dvh`), the same height on
every tab. The band (handle, legend, pills) drags the sheet; the content
scrolls. When the content is scrolled to its top, pulling down moves the
sheet, as in Google Maps. Release snaps to the nearer height, or follows a
clear flick.

**Direction lock.** A gesture is classified after a small movement: vertical
ones may move the sheet, horizontal ones never do. Gestures that start on a
range input or a scale-editor handle never move the sheet.

**Handle.** A real button with `aria-expanded` and `aria-controls`, labeled
"Show the controls"/"Hide the controls", with a fingertip-sized tap area. It
toggles the sheet.

**Map furniture rides the sheet.** The sheet moves with a CSS transform
driven by one custom property, updated on every frame of a drag. The same
property places the scale bar (bottom left), the credit (bottom right) and
`#notices` (status line and "Back to the Alps") just above the sheet's top
edge. The scale bar and the credit fade out as the sheet opens, interpolated
with the drag, and are hidden while it is open. The owner judged this within
the OpenStreetMap attribution guidelines' allowance for minimizing the credit
after interaction. `#notices` stays visible above the open sheet.

**Default state.** The page loads compact, decided by the stylesheet before
any script runs (today's guarantee, tested in `viewer-narrow.test.js`).
Crossing the breakpoint resets to the new width's default, as now.

**Safe areas.** The sheet pads by `env(safe-area-inset-bottom)`; the
wordmark clears `env(safe-area-inset-top)`.

**Scale editor.** Its own bottom sheet, replacing the main sheet while open
(as it replaces the panel today). Same band styling: title and close button.
When a limit field has focus and the on-screen keyboard is up, the editor
sits directly above the keyboard (via `visualViewport`) and the histogram and
the focused field stay visible; the presets and color maps may need a scroll.
Closed by its close button or Escape, as now. Its height follows its content
up to today's cap of 60 dvh, and its content scrolls beyond that. While it is
open, the scale bar and the credit are hidden, as over the open main sheet,
and `#notices` moves to the top of the screen, below the wordmark, so the
status line and "Back to the Alps" never cover the histogram. The custom
property that moves the furniture therefore has one driver, the main sheet.

### Desktop (wider than 640 px)

Today's 292 px panel at the top left, always open: no chevron, no handle, not
draggable. Same band, legend, pills and About button. Its height fits the
active tab, up to today's `max-height: calc(100% - 52px)`; the tab content
scrolls inside. The wordmark sits in the bottom-left strip that clearance
leaves. The scale bar moves to the bottom right, directly above the credit.
The credit stays expanded on desktop: drop `compact: true` from the
`AttributionControl` in `js/map.js`, so MapLibre collapses it only on maps
640 px wide or less, which matches the breakpoint. MapLibre stacks a bottom
corner newest on top, so the scale bar must be added after the credit, with
a smaller gap between them. The scale editor stays beside the panel.

## Constraints from the codebase (AGENTS.md)

- The 640 px breakpoint must agree between `js/app.js` and `style.css`.
- While the catalog loads, `#raster-controls` is `aria-busy` with invisible
  placeholders the size of the loaded controls. The legend's placeholder now
  lives in the band and must hold the compact sheet's loaded height, so
  nothing resizes when the catalog arrives.
- With no drawable rasters the controls and summary hide today. The band's
  legend must then show a one-line message in its place, so the compact sheet
  is not an empty handle; the Layers pill hides.
- When the selection has no archive for the chosen year, `render()` today
  hides `#legend` and posts "No … for {year}" to the status line. Instead, the
  legend's title line stays and that message fills the ramp's slot at the same
  height, so the compact sheet does not shrink; the status line no longer
  repeats it. The band reserves one fixed-height slot that holds the ramp
  with its limits, the false-color channel row, or this message.
- Popovers live outside the scrolling content.
- Font sizes are multiples of `--text-scale`; touch sizes go in the
  `(pointer: coarse)` block; hover styles under `@media (hover: hover)`.
- Pills are a tab list (`role="tablist"`, `tab`, `tabpanel`), keyboard-operable
  with arrow keys; reuse `rove()` from `js/ui.js`.
- A new `js/` module must join the `modulepreload` list; an edited inline
  script needs its CSP hash replaced. `page-assets.test.js` checks both.
- New runtime files (the outlined wordmark) must be staged by the Pages
  workflow.
- The map stays live under both sheets; the 250 ms click delay, popups and
  Escape handling are unchanged. A popup opened by a tap just above the sheet
  must stay visible, not open under the sheet.
- Inspect visual changes in a real browser: jsdom lays nothing out. Gestures
  need a check on iOS Safari (bottom address bar, keyboard) and a mid-range
  Android phone (repaint cost of the moving blurred pane).

## Decided by the owner

Two heights on phones; swipe from compact; scroll only when open; pills for
the three sections on every width; legend with the summary in the band on
every view; no color-map name in the legend; no subtitle; no chevron
anywhere and no minimizing on desktop; wordmark floating top left on phones
and bottom left on desktop, with a 1.5 px, 60% white outline; About as a
button at the end of every tab; one glass with two tint strengths; the scale
editor as its own sheet that keeps the focused field visible; scale bar and
credit ride the sheet and hide when open; on desktop, the scale bar above an
always-expanded credit at the bottom right; on phones, the scale bar bottom
left.

## Calls made in the design conversation, open to the owner's veto

- The handle is the button that opens and closes the sheet.
- Pulling down at the top of the scrolled content closes the sheet.
- Every tab opens the phone sheet to the same height.
- The desktop panel's height follows the active tab.
- The scale editor sheet has no handle and is not draggable.
- The active tab is not stored in the URL and resets to Layers on load.
- `#notices` stays visible above the open sheet.
- While the phone scale editor is open, the scale bar and credit hide and
  `#notices` moves to the top of the screen.
- A year without an archive for the selection shows its message in the
  legend's ramp slot instead of the status line.

## Left to the builder

- Snap thresholds, flick velocity, animation duration and easing; honor
  `prefers-reduced-motion`.
- Whether the sheet logic lives in `js/app.js` or a new module.
- How the scale bar changes corner at the breakpoint (moving its element or
  re-adding the control).
- Whether to set `map.setPadding` so fly-to targets center in the visible
  map.
- Whether the outlined wordmark replaces `assets/glace-wordmark.svg` or is a
  second file (the README links the hosted copy, not this one).
- The tint alphas, within the contrast check above.
- Updating AGENTS.md: the panel, the collapsed header, the scale editor's
  phone placement, `#notices`, the attribution note, and the code map.
- Tests: rewrite `viewer-narrow.test.js` for the sheet; update tests that use
  `#panel-toggle`, `#selection-summary`, `#subtitle`, `#about-open`, the
  `<details>` toggles or the color-map name in the legend (`viewer`,
  `legend`, `store-catalog`, `url-state-invalid`, `viewer-degraded`). Gesture
  logic should be testable as pointer-event sequences against fake sizes.
