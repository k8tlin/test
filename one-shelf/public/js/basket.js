// The basket lives in localStorage as [{ product_id, quantity, grind }]. Prices only ever come from the server quote.

import { api } from './api.js';
import { store } from './ui.js';

const KEY = 'os.basket.v1';
const WAY_KEY = 'os.fulfilment';
const PC_KEY = 'os.postcode';
export const DEFAULT_GRIND = 'Whole bean';
export const MAX_QTY = 12;
const MAX_LINES = 20;

const listeners = new Set();

function clean(lines) {
  if (!Array.isArray(lines)) return [];
  const out = [];
  for (const l of lines) {
    if (!l || typeof l.product_id !== 'string') continue;
    const quantity = Math.max(0, Math.min(MAX_QTY, Math.floor(Number(l.quantity) || 0)));
    if (!quantity) continue;
    const grind = typeof l.grind === 'string' && l.grind ? l.grind : DEFAULT_GRIND;
    const same = out.find((o) => o.product_id === l.product_id && o.grind === grind);
    if (same) same.quantity = Math.min(MAX_QTY, same.quantity + quantity);
    else if (out.length < MAX_LINES) out.push({ product_id: l.product_id, quantity, grind });
  }
  return out;
}

let lines = clean(store.get(KEY, []));

function save(next, source = 'user') {
  lines = clean(next);
  store.set(KEY, lines);
  for (const fn of listeners) fn(lines, source);
}

window.addEventListener('storage', (e) => {
  if (e.key === KEY) { lines = clean(store.get(KEY, [])); for (const fn of listeners) fn(lines, 'storage'); }
});

export const basket = {
  lines: () => lines.map((l) => ({ ...l })),
  count: () => lines.reduce((n, l) => n + l.quantity, 0),
  isEmpty: () => lines.length === 0,
  qty: (productId, grind = DEFAULT_GRIND) => {
    const l = lines.find((x) => x.product_id === productId && x.grind === grind);
    return l ? l.quantity : 0;
  },
  /** Total of one product across all grinds (stock is shared between grinds). */
  productQty: (productId) => lines.filter((x) => x.product_id === productId).reduce((n, l) => n + l.quantity, 0),
  /** Sets one line's quantity (0 removes it). Returns the quantity actually stored. */
  set(productId, grind, quantity) {
    const q = Math.max(0, Math.min(MAX_QTY, Math.floor(quantity)));
    const next = lines.map((l) => ({ ...l }));
    const i = next.findIndex((x) => x.product_id === productId && x.grind === grind);
    if (i >= 0) { if (q) next[i].quantity = q; else next.splice(i, 1); }
    else if (q) {
      if (next.length >= MAX_LINES) return 0;
      next.push({ product_id: productId, quantity: q, grind });
    }
    save(next);
    return q;
  },
  add(productId, grind, by) { return this.set(productId, grind, this.qty(productId, grind) + by); },
  replace(next, source) { save(next, source); },
  clear() { save([]); },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  isFull: () => lines.length >= MAX_LINES
};

/** How many of a product one basket line may hold: 12, or the stock left when the API tells us (5 or fewer). */
export function capFor(product) {
  if (!product || product.in_stock === false) return 0;
  return typeof product.stock_left === 'number' ? Math.min(MAX_QTY, product.stock_left) : MAX_QTY;
}

export const prefs = {
  fulfilment: () => (store.get(WAY_KEY, null) === 'delivery' ? 'delivery' : store.get(WAY_KEY, null) === 'collect' ? 'collect' : null),
  setFulfilment: (v) => store.set(WAY_KEY, v),
  postcode: () => {
    const p = store.get(PC_KEY, null);
    return p && typeof p.district === 'string' ? p : null;
  },
  setPostcode: (p) => store.set(PC_KEY, p ? { district: p.district, label: p.label || p.district } : null)
};

let quoteSeq = 0;
/**
 * Prices the stored basket. If the server changed it (sold out, quantity reduced), the stored
 * basket is replaced with what the server returned. Resolves to null if a newer quote superseded this one.
 */
export async function quoteBasket({ fulfilment, postcode } = {}) {
  const seq = ++quoteSeq;
  const items = basket.lines();
  if (!items.length) return { empty: true, lines: [], problems: [] };
  const body = { items, fulfilment: fulfilment || 'collect' };
  if (postcode) body.postcode = postcode;
  const q = await api.quote(body);
  if (seq !== quoteSeq) return null;
  const returned = q.lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity, grind: l.grind }));
  if (q.problems.length || JSON.stringify(returned) !== JSON.stringify(items)) {
    basket.replace(returned, 'quote'); // listeners can tell this apart from a change the customer made
  }
  return q;
}
