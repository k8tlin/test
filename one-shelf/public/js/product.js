// Product detail dialog. Deep-linkable with ?product=<slug>.

import { api } from './api.js';
import { basket, capFor, DEFAULT_GRIND, MAX_QTY } from './basket.js';
import { h, clear, $, money, distShort, setupDialog, openDialog, closeIcon, errorState } from './ui.js';
import { buildBag, buildCurve, buildBars, roastName } from './bag.js';
import { getConfig, openBasket } from './site.js';

let dialog, hooks = {}, current = null, closingFromPop = false;

function urlSlug() { return new URLSearchParams(location.search).get('product'); }

function setUrl(slug) {
  const p = new URLSearchParams(location.search);
  if (slug) {
    if (p.get('product') === slug) return;
    p.set('product', slug);
    history.pushState({ osProduct: true }, '', location.pathname + '?' + p.toString());
  } else {
    if (!p.has('product')) return;
    if (history.state && history.state.osProduct) { history.back(); return; }
    p.delete('product');
    const qs = p.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  }
}

function build() {
  dialog = h('dialog', { class: 'sheet', id: 'product-dialog', 'aria-labelledby': 'product-title' });
  document.body.appendChild(dialog);
  setupDialog(dialog, {
    onClose: () => {
      current = null;
      if (closingFromPop) closingFromPop = false; else setUrl(null);
    }
  });
}

function closeBtn() {
  return h('button', { class: 'btn btn--quiet btn--icon dlg-close', type: 'button', 'aria-label': 'Close', on: { click: () => dialog.close() } }, closeIcon());
}

function render(p, grinds) {
  const r = p.roaster;
  const pc = hooks.getPostcode && hooks.getPostcode();
  const where = r.area + ' ' + r.postcode + (pc && p.distance_miles != null ? ' · ' + distShort(p.distance_miles) + ' from ' + pc.label : '');
  const notes = p.notes.map((n) => n.toLowerCase());
  const summary = 'A ' + roastName(p.roast_level).toLowerCase() + ' roast from ' + [p.origin_region, p.origin_country].filter(Boolean).join(', ') +
    (notes.length ? ', tasting of ' + (notes.length > 1 ? notes.slice(0, -1).join(', ') + ' and ' + notes[notes.length - 1] : notes[0]) : '') + '.';
  const curve = buildCurve(p.roast_level);

  const state = { grind: DEFAULT_GRIND, qty: 1 };
  const stockCap = capFor(p);
  const room = () => Math.max(0, Math.min(MAX_QTY - basket.qty(p.id, state.grind), stockCap - basket.productQty(p.id)));

  const qtyN = h('span', { class: 'qty-n', 'aria-live': 'polite', text: '1' });
  const less = h('button', { type: 'button', 'aria-label': 'Decrease quantity', text: '−' });
  const more = h('button', { type: 'button', 'aria-label': 'Increase quantity', text: '+' });
  const addBtn = h('button', { class: 'btn btn--primary btn--big', type: 'button', id: 'product-add', text: 'Add to basket' });
  const note = h('p', { class: 'small', id: 'product-note', role: 'status' });
  const paint = () => {
    const max = room();
    if (state.qty > max) state.qty = Math.max(1, max);
    qtyN.textContent = String(state.qty);
    less.disabled = state.qty <= 1;
    more.disabled = state.qty >= max;
    addBtn.disabled = max < 1 || !p.in_stock;
    addBtn.textContent = !p.in_stock ? 'Sold out' : 'Add to basket';
    note.textContent = !p.in_stock ? 'This coffee is sold out at the moment.'
      : max < 1 ? 'You already have the most you can order of this coffee in your basket.'
        : (p.low_stock && p.stock_left != null ? 'Only ' + p.stock_left + ' left.' : '');
  };
  less.addEventListener('click', () => { state.qty = Math.max(1, state.qty - 1); paint(); });
  more.addEventListener('click', () => { state.qty = Math.min(room(), state.qty + 1); paint(); });
  addBtn.addEventListener('click', () => {
    if (room() < 1) return;
    basket.add(p.id, state.grind, state.qty);
    const opener = dialog._opener;
    dialog.close();
    openBasket(opener && document.contains(opener) ? opener : $('#basket-btn'));
  });

  const pills = (grinds && grinds.length ? grinds : [DEFAULT_GRIND]).map((g, i) => {
    const input = h('input', { type: 'radio', name: 'grind', value: g, id: 'grind-' + i });
    input.checked = g === state.grind;
    input.addEventListener('change', () => { state.grind = g; paint(); });
    return h('label', { class: 'pill', for: 'grind-' + i }, input, h('span', { text: g }));
  });

  const facts = [
    ['Origin', p.origin_country], ['Region', p.origin_region], ['Process', p.process], ['Varietal', p.varietal],
    ['Altitude', p.altitude_m ? p.altitude_m.toLocaleString('en-GB') + ' masl' : ''],
    ['Best for', p.brew === 'both' ? 'Espresso and filter' : p.brew === 'espresso' ? 'Espresso' : 'Filter'],
    ['Roasted in', r.area + ', London'], ['Sold by', r.name]
  ].filter((f) => f[1]);

  const art = p.image_url
    ? h('div', { class: 'sheet-bag sheet-bag--photo' }, h('img', { src: p.image_url, alt: p.name + ' by ' + r.name }))
    : h('div', { class: 'sheet-bag', 'aria-hidden': 'true' }, buildBag(p, { icon: true }));

  clear(dialog).append(
    h('div', { class: 'sheet-art' },
      art,
      h('div', { class: 'sheet-roast' },
        h('div', { class: 'sheet-roast-head' }, h('h3', { text: 'Roast profile' }), h('span', { class: 'small muted', text: roastName(p.roast_level) })),
        curve.svg,
        h('dl', { class: 'stat-grid' }, curve.stats.map((x) => h('div', null, h('dt', { text: x.k }), h('dd', { text: x.v })))),
        h('p', { class: 'small muted', text: 'An illustration of a typical ' + roastName(p.roast_level).toLowerCase() + ' roast, not a log of this batch.' }))),
    h('div', { class: 'sheet-info' },
      h('div', { class: 'sheet-top' },
        h('div', null, h('span', { class: 'sheet-where', text: r.name + ' · ' + where }), h('h2', { class: 'sheet-name', id: 'product-title', text: p.name })),
        closeBtn()),
      h('p', { class: 'sheet-summary', text: summary }),
      h('div', { class: 'sheet-flav', vars: { '--tint': p.tint } }, h('h3', { text: 'Flavour profile' }), buildBars(p.flavour, 'bars--fat')),
      h('dl', { class: 'fact-grid' }, facts.map(([k, v]) => h('div', null, h('dt', { text: k }), h('dd', { text: v })))),
      h('div', { class: 'sheet-buy' },
        h('fieldset', { class: 'grinds' }, h('legend', { text: 'Grind' }), h('div', { class: 'pills' }, pills)),
        h('p', { class: 'sheet-price' }, h('b', { text: money(p.price_pence) }), h('span', { class: 'muted small', text: 'per ' + p.weight_g + 'g bag' })),
        h('div', { class: 'buy-row' },
          h('div', { class: 'qty qty--big', role: 'group', 'aria-label': 'Quantity' }, less, qtyN, more),
          addBtn),
        note)));
  paint();
}

async function show(slug, opener) {
  if (!dialog) build();
  current = slug;
  let p = hooks.getProduct ? hooks.getProduct(slug) : null;
  dialog._fallbackFocus = () => document.querySelector('[data-open="' + CSS.escape(slug) + '"]') || $('#mk-sort');
  if (!p) {
    clear(dialog).append(h('div', { class: 'sheet-info' }, h('div', { class: 'sheet-top' }, h('h2', { class: 'sheet-name', id: 'product-title', text: 'Loading…' }), closeBtn())));
    openDialog(dialog, opener);
  }
  let grinds = [];
  try {
    const pc = hooks.getPostcode && hooks.getPostcode();
    const [cfg, fetched] = await Promise.all([getConfig().catch(() => ({ grinds: [] })), p ? null : api.product(slug, pc && pc.district)]);
    grinds = cfg.grinds || [];
    if (fetched) p = fetched.product;
  } catch (err) {
    if (current !== slug) return;
    const missing = err.status === 404;
    clear(dialog).append(h('div', { class: 'sheet-info' },
      h('div', { class: 'sheet-top' }, h('h2', { class: 'sheet-name', id: 'product-title', text: missing ? 'Coffee not found' : 'Something went wrong' }), closeBtn()),
      missing
        ? h('div', { class: 'state' }, h('p', { text: 'That coffee is not on the shelf any more.' }), h('button', { class: 'btn btn--ghost', type: 'button', text: 'Back to the shelf', on: { click: () => dialog.close() } }))
        : errorState(err.message, () => show(slug, null))));
    openDialog(dialog, opener);
    return;
  }
  if (current !== slug) return;
  render(p, grinds);
  openDialog(dialog, opener);
  dialog.scrollTop = 0;
}

export function initProduct(h2) { hooks = h2 || {}; }

export function openProduct(slug, opener) {
  setUrl(slug);
  return show(slug, opener);
}

/** Makes the dialog match the URL (used on first load and when the back button is pressed). */
export function syncProductFromUrl() {
  const slug = urlSlug();
  if (slug && current !== slug) show(slug.slice(0, 120), null);
  else if (!slug && dialog && dialog.open) { closingFromPop = true; dialog.close(); }
}
