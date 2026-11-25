// Small DOM and interaction helpers shared by every page. No data ever goes through innerHTML.

const SVG_NS = 'http://www.w3.org/2000/svg';

function fill(el, props, kids) {
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'on') { for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn); }
      else if (k === 'vars') { for (const [name, val] of Object.entries(v)) if (val) el.style.setProperty(name, val); }
      else if (k === 'data') { for (const [name, val] of Object.entries(v)) el.dataset[name] = val; }
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === undefined || kid === null || kid === false) continue;
    el.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
  }
  return el;
}

export function h(tag, props, ...kids) { return fill(document.createElement(tag), props, kids); }
export function s(tag, props, ...kids) { return fill(document.createElementNS(SVG_NS, tag), props, kids); }
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function $(sel, root) { return (root || document).querySelector(sel); }
export function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
/** Formats an integer number of pence. Formatting only: no sums happen in the browser. */
export function money(pence) { return typeof pence === 'number' ? gbp.format(pence / 100) : ''; }

export function distShort(miles) { return miles == null ? '' : (miles < 0.95 ? 'under 1 mi' : 'about ' + miles.toFixed(1) + ' mi'); }
export function distLong(miles) { return miles == null ? '' : (miles < 0.95 ? 'under a mile away' : 'about ' + miles.toFixed(1) + ' miles away'); }

export function reducedMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }

export function debounce(fn, ms) {
  let t;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  },
  set(key, value) {
    try { if (value === null || value === undefined) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
  }
};

/* ---------- live announcements ---------- */
let liveEl;
export function announce(message) {
  if (!liveEl) {
    liveEl = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', id: 'live-region' });
    document.body.appendChild(liveEl);
  }
  liveEl.textContent = '';
  setTimeout(() => { liveEl.textContent = message; }, 40);
}

/* ---------- buttons ---------- */
/** Loading state: label changes, spinner shows, width is kept, and the button cannot be pressed twice. */
export function setLoading(btn, on, label) {
  if (on) {
    if (btn.classList.contains('is-loading')) return;
    btn.dataset.label = btn.textContent;
    btn.dataset.wasDisabled = btn.disabled ? '1' : '';
    btn.style.minWidth = btn.getBoundingClientRect().width + 'px';
    btn.classList.add('is-loading');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    if (label) btn.textContent = label;
  } else {
    if (!btn.classList.contains('is-loading')) return;
    btn.classList.remove('is-loading');
    btn.removeAttribute('aria-busy');
    btn.disabled = btn.dataset.wasDisabled === '1';
    btn.textContent = label || btn.dataset.label || btn.textContent;
    btn.style.minWidth = '';
  }
}

/** Brief success confirmation on a button, then back to its normal label. */
export function flashDone(btn, label, ms = 1800) {
  const old = btn.textContent;
  btn.classList.add('is-done');
  btn.textContent = label;
  setTimeout(() => { btn.classList.remove('is-done'); btn.textContent = old; }, ms);
}

/* ---------- form fields ---------- */
function errorNode(input) {
  const id = input.id + '-error';
  let node = document.getElementById(id);
  if (!node) {
    node = h('p', { class: 'field-error', id });
    const host = input.closest('.field, .check-wrap') || input.parentNode;
    host.appendChild(node);
  }
  return node;
}

export function setFieldError(input, message) {
  const node = errorNode(input);
  const ids = new Set((input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
  if (message) {
    node.textContent = message;
    input.setAttribute('aria-invalid', 'true');
    ids.add(node.id);
  } else {
    node.textContent = '';
    input.removeAttribute('aria-invalid');
    ids.delete(node.id);
  }
  if (ids.size) input.setAttribute('aria-describedby', Array.from(ids).join(' ')); else input.removeAttribute('aria-describedby');
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const POSTCODE_FULL_RE = /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$/;
export const POSTCODE_ANY_RE = /^[A-Za-z]{1,2}\d[A-Za-z\d]?(\s*\d[A-Za-z]{2})?$/;

/* ---------- modal dialogs (native <dialog>, with focus trap and focus return) ---------- */
function focusables(root) {
  return $$('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', root)
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
}

export function setupDialog(dialog, { onClose } = {}) {
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const list = focusables(dialog);
    if (!list.length) { e.preventDefault(); return; }
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  // A click on the dimmed area outside the panel closes it.
  dialog.addEventListener('mousedown', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    if (!document.querySelector('dialog[open]')) document.documentElement.classList.remove('modal-open');
    const opener = dialog._opener;
    dialog._opener = null;
    if (onClose) onClose();
    if (opener && document.contains(opener) && !document.querySelector('dialog[open]')) opener.focus({ preventScroll: true });
    else if (dialog._fallbackFocus && !document.querySelector('dialog[open]')) { const f = dialog._fallbackFocus(); if (f) f.focus({ preventScroll: true }); }
  });
}

export function openDialog(dialog, opener) {
  if (dialog.open) return;
  dialog._opener = opener || (document.activeElement !== document.body ? document.activeElement : null);
  document.documentElement.classList.add('modal-open');
  dialog.showModal();
}

export function closeIcon() {
  return s('svg', { 'aria-hidden': 'true', width: 16, height: 16, viewBox: '0 0 16 16' }, s('path', { d: 'M3 3l10 10M13 3L3 13' }));
}

export function errorState(message, onRetry) {
  return h('div', { class: 'state notice--error fade-in', role: 'alert' },
    h('p', { text: message }),
    onRetry ? h('button', { class: 'btn btn--ghost', type: 'button', text: 'Try again', on: { click: onRetry } }) : null);
}
