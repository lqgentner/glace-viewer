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

/* ---------- choices in the URL ---------- */

/*
 * The panel's choices live in the query string, beside the deployment
 * parameters; MapLibre keeps the camera in the hash. Writes are batched because
 * browsers limit how often history.replaceState may run.
 */
const URL_DELAY_MS = 300;
const pendingParams = new Map();
let urlTimer = null;

export const urlParam = (name) => new URLSearchParams(location.search).get(name);

/** Set query parameters soon; null removes one. */
export function setUrlParams(params) {
  for (const [name, value] of Object.entries(params)) pendingParams.set(name, value);
  urlTimer ??= setTimeout(() => {
    urlTimer = null;
    const url = new URL(location.href);
    for (const [name, value] of pendingParams) {
      if (value === null || value === undefined) url.searchParams.delete(name);
      else url.searchParams.set(name, String(value));
    }
    pendingParams.clear();
    history.replaceState(history.state, "", url);
  }, URL_DELAY_MS);
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
  el("status-live").textContent = top && top.level !== "busy" ? top.message : "";
}

/* ---------- segmented controls ---------- */

/*
 * Accept values or {value, label, title} entries. data-value preserves the catalog
 * value when the display label differs. As a radio group, the arrow keys select
 * the next choice that is not disabled, and Tab stops at the checked one.
 */
export function buildSegmented(node, entries, onSelect) {
  node.onkeydown = (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const choices = [...node.children].filter((button) => !button.disabled);
    const at = choices.indexOf(document.activeElement);
    const next = choices[(at + step + choices.length) % choices.length];
    next.click();
    next.focus();
  };
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
  rove(node);
}

/** Make the checked choice, or else the first enabled one, the group's tab stop. */
export function rove(node) {
  const buttons = [...node.children];
  const stop =
    buttons.find((button) => button.getAttribute("aria-checked") === "true") ??
    buttons.find((button) => !button.disabled);
  for (const button of buttons) button.tabIndex = button === stop ? 0 : -1;
}

/* ---------- popovers ---------- */

/*
 * Attach the shared popover to body with fixed positioning so it can extend beyond
 * the scrolling panel without enlarging it.
 */

const POPOVER_GAP_PX = 10;
const POPOVER_MARGIN_PX = 8;

let popover = null;
let popoverAnchor = null;

/**
 * Open `build()` in a popover over `button` on click; a second click closes it.
 * Hover does not open it, so a tap behaves as a click does. An `autofocus`
 * element inside takes the focus.
 *
 * @param {object} [options]
 * @param {string} [options.className]  Styles the box.
 * @param {number} [options.caretAt]    Where along the box the caret sits, 0-1.
 */
export function attachPopover(button, build, options = {}) {
  const { className = "", caretAt = 0.5 } = options;
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "popover");
  button.addEventListener("click", (event) => {
    event.preventDefault();
    if (popoverAnchor === button) hidePopover();
    else showPopover(button, build, className, caretAt);
  });
}

/* Optionally return focus from the closing popover to its trigger. */
export function hidePopover({ refocus = false } = {}) {
  const anchor = popoverAnchor;
  const focusInside = popover?.contains(document.activeElement);
  anchor?.classList.remove("popover-open");
  anchor?.setAttribute("aria-expanded", "false");
  popover?.remove();
  popover = null;
  popoverAnchor = null;
  if (refocus && focusInside) anchor.focus();
}

function showPopover(anchor, build, className, caretAt) {
  hidePopover();

  const box = h(
    "div",
    {
      id: "popover",
      class: `popover ${className}`,
      role: "dialog",
      "aria-label": anchor.getAttribute("aria-label"),
      tabIndex: -1,
    },
    build(),
  );
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
  anchor.setAttribute("aria-expanded", "true");
  popover = box;
  popoverAnchor = anchor;
  // Into the box, so Tab reaches its links and Escape returns.
  (box.querySelector("[autofocus]") ?? box.querySelector("a[href]") ?? box).focus();
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

/* ---------- pickers ---------- */

/**
 * A popover of choices, shared by the color-map and outline-color
 * pickers, styled by the .choice rules. The current choice is pressed and takes
 * the focus; picking one closes the popover and returns focus to the button
 * before `onPick` runs.
 *
 * @param {() => {value: *, current: boolean, label: string, class?: string,
 *                 style?: object, content?: Node[]}[]} choices
 * @param {(value: *) => void} onPick
 * @param {{className?: string, caretAt?: number}} [options]  as for attachPopover
 */
export function attachPicker(button, choices, onPick, { className = "", caretAt } = {}) {
  const build = () =>
    choices().map((choice) =>
      h(
        "button",
        {
          type: "button",
          class: choice.class ? `choice ${choice.class}` : "choice",
          style: choice.style,
          "aria-label": choice.label,
          "aria-pressed": String(choice.current),
          dataset: { value: String(choice.value) },
          autofocus: choice.current,
          onclick: () => {
            hidePopover({ refocus: true });
            onPick(choice.value);
          },
        },
        ...(choice.content ?? []),
      ),
    );
  attachPopover(button, build, { className, caretAt });
}

/* ---------- attribution popover ---------- */

/* Static MapLibre attribution glyph. No external text reaches this HTML parser. */
const INFO_ICON = document.createElement("template");
INFO_ICON.innerHTML =
  '<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" ' +
  'fill-rule="evenodd" aria-hidden="true"><path d="M4 10a6 6 0 1 0 12 0 6 6 0 1 0-12 0' +
  'm5-3a1 1 0 1 0 2 0 1 1 0 1 0-2 0m0 3a1 1 0 1 1 2 0v3a1 1 0 1 1-2 0"/></svg>';

export function creditButton(title, credit, about = "attribution and license") {
  const button = h(
    "button",
    {
      type: "button",
      class: "credit",
      title: `${title} — ${about}`,
      "aria-label": `${title}: ${about}`,
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
