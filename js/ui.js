/*
 * Map-independent DOM helpers, status messages, controls, and popovers. External
 * metadata must enter through nodes or textContent, never HTML interpolation.
 */

export const el = (id) => document.getElementById(id);

/* ---------- safe DOM construction ---------- */

/*
 * Append children as nodes or text. Set known DOM properties directly and other
 * keys as attributes.
 */
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

/*
 * Only allow citation URL schemes that cannot execute script; otherwise show plain
 * text.
 */
const SAFE_URL_SCHEME = /^(?:https?:|mailto:)/i;

function externalLink(url, label) {
  const text = String(label ?? url ?? "");
  if (!SAFE_URL_SCHEME.test(String(url ?? ""))) return document.createTextNode(text);
  return h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, text);
}

/* ---------- status line ---------- */

/*
 * Key status by component so one success cannot clear another failure. Errors
 * outrank progress; the newest entry wins ties.
 */
const STATUS_RANK = { info: 0, busy: 1, error: 2 };
const statusEntries = new Map();

export function setStatus(key, message, level = "busy") {
  // Reinsert to keep equal-priority entries ordered by recency.
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

/*
 * Accept values or {value, label, title} entries. data-value preserves the catalog
 * value when the display label differs.
 */
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

/* Initial state lives in markup: aria-expanded, hidden, and the chevron's up class. */
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

/* ---------- popovers ---------- */

/*
 * Attach the shared popover to body with fixed positioning so it can extend beyond
 * the scrolling panel without enlarging it.
 */

const POPOVER_GAP_PX = 10;
const POPOVER_MARGIN_PX = 8;
const POPOVER_HIDE_DELAY_MS = 180;

let popover = null;
let popoverAnchor = null;
let popoverTimer = null;
// Set while focus is handed back to a button, so its focus handler does not reopen the box.
let refocusing = false;

/**
 * Open `build()` in a popover over `button` on click, and on hover and focus
 * unless `hover` is false. An `autofocus` element inside takes the focus.
 *
 * @param {object} [options]
 * @param {string} [options.className]  Styles the box.
 * @param {number} [options.caretAt]    Where along the box the caret sits, 0-1.
 * @param {boolean} [options.hover]     Whether hover and focus open it too.
 */
export function attachPopover(button, build, options = {}) {
  const { className = "", caretAt = 0.5, hover = true } = options;
  const show = () => showPopover(button, build, className, caretAt, hover);
  // Support pointer hover, keyboard focus, and touch clicks.
  if (hover) {
    button.addEventListener("mouseenter", show);
    button.addEventListener("focus", () => refocusing || show());
    button.addEventListener("mouseleave", scheduleHidePopover);
    button.addEventListener("blur", scheduleHidePopover);
  }
  button.addEventListener("click", (event) => {
    event.preventDefault();
    if (popoverAnchor === button) hidePopover();
    else show();
  });
}

/* Optionally return focus from the closing popover to its trigger. */
export function hidePopover({ refocus = false } = {}) {
  clearTimeout(popoverTimer);
  const anchor = popoverAnchor;
  const focusInside = popover?.contains(document.activeElement);
  anchor?.classList.remove("popover-open");
  popover?.remove();
  popover = null;
  popoverAnchor = null;
  if (refocus && focusInside) {
    refocusing = true;
    anchor.focus();
    refocusing = false;
  }
}

/* Allow pointer travel from the trigger and keep the box open while hovered. */
function scheduleHidePopover() {
  clearTimeout(popoverTimer);
  popoverTimer = setTimeout(() => {
    if (!popover?.matches(":hover")) hidePopover();
  }, POPOVER_HIDE_DELAY_MS);
}

function showPopover(anchor, build, className, caretAt, hover) {
  clearTimeout(popoverTimer);
  if (popoverAnchor === anchor) return;
  hidePopover();

  const box = h("div", { class: `popover ${className}` }, build());
  if (hover) {
    box.addEventListener("mouseenter", () => clearTimeout(popoverTimer));
    box.addEventListener("mouseleave", scheduleHidePopover);
  }
  document.body.append(box);

  // Measured after insertion: the height depends on how far the content wraps.
  const mark = anchor.getBoundingClientRect();
  const { width, height } = box.getBoundingClientRect();
  const markX = mark.left + mark.width / 2;
  const left = Math.min(
    Math.max(markX - width * caretAt, POPOVER_MARGIN_PX),
    window.innerWidth - width - POPOVER_MARGIN_PX,
  );
  const above = mark.top - height - POPOVER_GAP_PX;
  const below = above < POPOVER_MARGIN_PX;
  box.classList.toggle("below", below);
  box.style.left = `${left}px`;
  box.style.top = `${below ? mark.bottom + POPOVER_GAP_PX : above}px`;
  // The caret tracks the mark even when the box was clamped to the viewport.
  box.style.setProperty("--caret-x", `${markX - left}px`);

  anchor.classList.add("popover-open");
  popover = box;
  popoverAnchor = anchor;
  box.querySelector("[autofocus]")?.focus();
}

// A scroll or resize moves the mark out from under the box.
window.addEventListener("resize", () => hidePopover());
document.addEventListener("scroll", () => hidePopover(), true);
// A press elsewhere closes it; one on its own button is that button's click.
document.addEventListener("pointerdown", (event) => {
  if (popover && !popover.contains(event.target) && !popoverAnchor.contains(event.target)) {
    hidePopover();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && popover) hidePopover({ refocus: true });
});

/* ---------- attribution popover ---------- */

/* Static MapLibre attribution glyph. No external text reaches this HTML parser. */
const INFO_ICON = document.createElement("template");
INFO_ICON.innerHTML =
  '<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" ' +
  'fill-rule="evenodd" aria-hidden="true"><path d="M4 10a6 6 0 1 0 12 0 6 6 0 1 0-12 0' +
  'm5-3a1 1 0 1 0 2 0 1 1 0 1 0-2 0m0 3a1 1 0 1 1 2 0v3a1 1 0 1 1-2 0"/></svg>';

export function creditButton(title, credit) {
  const button = h(
    "button",
    {
      type: "button",
      class: "credit",
      title: `${title} — attribution and license`,
      "aria-label": `${title}: attribution and license`,
    },
    INFO_ICON.content.firstElementChild.cloneNode(true),
  );
  attachPopover(button, () => creditLines(title, credit), { className: "credit-popover" });
  return button;
}

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
