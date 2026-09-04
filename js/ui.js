/*
 * Shared browser-side furniture: safe DOM construction, the status line, the
 * per-layer attribution popover and the segmented control builder.
 *
 * Nothing here knows about the map. Everything that ends up on the page goes
 * through `h()` or `textContent`: inventory metadata, raster manifests and
 * vector-tile properties are all data the page does not author, and a glacier
 * name or a citation containing markup must not be able to become markup.
 */

export const el = (id) => document.getElementById(id);

/* ---------- safe DOM construction ---------- */

/* Minimal hyperscript. Children are appended as nodes or as text — never
 * parsed — so no caller can inject markup by accident. Known properties are set
 * on the element (`className`, `textContent`, `href`, …) and anything else
 * becomes an attribute. */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style") Object.assign(node.style, value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/* `href` is the one place where a string from a manifest is still interpreted
 * rather than displayed, and `javascript:` in an href executes on click. Only
 * the schemes a citation link can legitimately use are honoured; anything else
 * degrades to plain text rather than to a live link. */
const SAFE_URL_SCHEME = /^(?:https?:|mailto:)/i;

function externalLink(url, label) {
  const text = String(label ?? url ?? "");
  if (!SAFE_URL_SCHEME.test(String(url ?? ""))) return document.createTextNode(text);
  return h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, text);
}

/* ---------- status line ---------- */

/* Several independent things report into one status element: the raster
 * manifest, each inventory and the tile grid. They finish in whatever order the
 * network gives them, so a single shared string means one overlay loading
 * successfully can wipe an unrelated failure off the screen. Entries are keyed
 * by who wrote them instead, and the most important one is displayed: errors
 * outrank progress, and among equals the most recent wins. */
const STATUS_RANK = { info: 0, busy: 1, error: 2 };
const statusEntries = new Map();

export function setStatus(key, message, level = "busy") {
  // Re-inserting rather than overwriting keeps the map ordered oldest-first,
  // which is what makes "most recent among equals" fall out of the scan below.
  statusEntries.delete(key);
  if (message) statusEntries.set(key, { message, level });
  paintStatus();
}

export const clearStatus = (key) => setStatus(key, "");

function paintStatus() {
  let top = null;
  for (const entry of statusEntries.values()) {
    if (!top || STATUS_RANK[entry.level] >= STATUS_RANK[top.level]) top = entry;
  }
  const node = el("status");
  node.hidden = !top;
  node.textContent = top ? top.message : "";
}

/* ---------- segmented controls ---------- */

/* Each entry is either a bare value, which is also its own label — years,
 * polarizations — or a `{ value, label }` pair where the name on the button is
 * not the name in the manifest, as for the products. `data-value` always
 * carries the manifest's own spelling, so nothing downstream has to translate
 * back.
 *
 * A pair may also carry a `title`, for a row whose faces had to be shortened to
 * fit: three buttons across a 292px panel leave about eleven characters each,
 * and the full name goes on the tooltip rather than off the edge. */
export function buildSegmented(node, entries, onSelect) {
  node.replaceChildren(
    ...entries.map((entry) => {
      const pair = entry !== null && typeof entry === "object";
      const value = pair ? entry.value : entry;
      return h("button", {
        type: "button",
        role: "radio",
        textContent: String(pair ? entry.label : entry),
        title: pair ? entry.title : null,
        dataset: { value },
        onclick: () => onSelect(value),
      });
    }),
  );
}

/* ---------- collapsible sections ---------- */

/* The panel's section headers: a button that shows and hides the block below
 * it. Shared by the glacier inventories and the additional layers, so the two
 * cannot drift apart in behaviour the way two hand-rolled copies would.
 *
 * The markup carries the starting state — `aria-expanded` on the button, the
 * `hidden` attribute on the body and `up` on the chevron — so a section is
 * collapsed before any of this runs. */
export function collapsible(toggleId, bodyId) {
  const toggle = el(toggleId);
  const body = el(bodyId);
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!open));
    // `up` marks the collapsed state, here and on the panel's own toggle.
    toggle.querySelector(".chevron").classList.toggle("up", open);
    body.hidden = open;
  });
}

/* ---------- attribution popover ---------- */

/* Each third-party layer carries its own credit, reachable from an info mark
 * next to its toggle, rather than being folded into the map-wide attribution
 * control where a viewer cannot tell which layer it belongs to.
 *
 * The panel scrolls, so the popover is appended to the body and positioned
 * `fixed`: as an absolutely positioned child it would extend the panel's scroll
 * area rather than overflow it, and long citations would put a scrollbar on the
 * whole sidebar. Detached, it can also be wider than the panel. */

/* MapLibre's own attribution glyph, reused verbatim so the per-layer buttons
 * and the control in the corner of the map read as the same thing. It is a
 * constant, parsed once here, so no data path ever reaches an HTML parser. */
const INFO_ICON = document.createElement("template");
INFO_ICON.innerHTML =
  '<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" ' +
  'fill-rule="evenodd" aria-hidden="true"><path d="M4 10a6 6 0 1 0 12 0 6 6 0 1 0-12 0' +
  'm5-3a1 1 0 1 0 2 0 1 1 0 1 0-2 0m0 3a1 1 0 1 1 2 0v3a1 1 0 1 1-2 0"/></svg>';

const CREDIT_GAP_PX = 10;
const CREDIT_MARGIN_PX = 8;
const CREDIT_HIDE_DELAY_MS = 180;

let creditBox = null;
let creditTimer = null;

export function creditButton(title, credit) {
  const button = h(
    "button",
    {
      type: "button",
      class: "credit",
      title: `${title} — attribution and licence`,
      "aria-label": `${title}: attribution and licence`,
    },
    INFO_ICON.content.firstElementChild.cloneNode(true),
  );
  // Hover for pointers, focus for keyboards, click for touch — where hover
  // does not exist and the button would otherwise be dead.
  button.addEventListener("mouseenter", () => showCredit(button, title, credit));
  button.addEventListener("focus", () => showCredit(button, title, credit));
  button.addEventListener("mouseleave", scheduleHideCredit);
  button.addEventListener("blur", scheduleHideCredit);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    if (creditBox && creditBox.dataset.owner === title) hideCredit();
    else showCredit(button, title, credit);
  });
  return button;
}

function hideCredit() {
  clearTimeout(creditTimer);
  if (creditBox) {
    creditBox.remove();
    creditBox = null;
  }
}

/* A grace period, so the pointer can travel from the mark onto the box without
 * the box vanishing under it — the links inside have to stay reachable. */
function scheduleHideCredit() {
  clearTimeout(creditTimer);
  creditTimer = setTimeout(hideCredit, CREDIT_HIDE_DELAY_MS);
}

/* One line per fact, separated by breaks rather than wrapped in a list: the box
 * is narrow and the citation is the only part that wraps. */
function creditLines(title, credit) {
  const lines = [h("strong", { textContent: credit.title || title })];
  if (credit.citation) lines.push(h("span", { class: "cite", textContent: credit.citation }));
  if (credit.license) {
    lines.push(
      credit.license_url
        ? h("span", {}, "License: ", externalLink(credit.license_url, credit.license))
        : h("span", { textContent: `License: ${credit.license}` }),
    );
  }
  for (const link of credit.links || []) lines.push(externalLink(link.url, link.label));

  return lines.flatMap((line, i) => (i === 0 ? [line] : [h("br"), line]));
}

function showCredit(anchor, title, credit) {
  clearTimeout(creditTimer);
  if (creditBox && creditBox.dataset.owner === title) return;
  hideCredit();

  const box = h(
    "div",
    { class: "credit-popover", dataset: { owner: title } },
    creditLines(title, credit),
  );
  box.addEventListener("mouseenter", () => clearTimeout(creditTimer));
  box.addEventListener("mouseleave", scheduleHideCredit);
  document.body.append(box);

  // Measured after insertion: the height depends on how far the citation wraps.
  const mark = anchor.getBoundingClientRect();
  const { width, height } = box.getBoundingClientRect();
  const left = Math.min(
    Math.max(mark.left + mark.width / 2 - width / 2, CREDIT_MARGIN_PX),
    window.innerWidth - width - CREDIT_MARGIN_PX,
  );
  const above = mark.top - height - CREDIT_GAP_PX;
  const below = above < CREDIT_MARGIN_PX;
  box.classList.toggle("below", below);
  box.style.left = `${left}px`;
  box.style.top = `${below ? mark.bottom + CREDIT_GAP_PX : above}px`;
  // The caret tracks the mark even when the box was clamped to the viewport.
  box.style.setProperty("--caret-x", `${mark.left + mark.width / 2 - left}px`);

  creditBox = box;
}

// A scroll or resize moves the mark out from under the box.
window.addEventListener("resize", hideCredit);
document.addEventListener("scroll", hideCredit, true);
