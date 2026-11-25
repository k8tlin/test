// Shared by every page: demo-mode banner, header basket count, and the basket drawer.

import { api } from './api.js';
import { basket, prefs, quoteBasket, MAX_QTY } from './basket.js';
import { h, clear, $, money, announce, setupDialog, openDialog, closeIcon, errorState, debounce } from './ui.js';

let configPromise;
export function getConfig() {
  if (!configPromise) configPromise = api.config().catch((err) => { configPromise = null; throw err; });
  return configPromise;
}

function initDemoBanner() {
  getConfig().then((cfg) => {
    if (cfg.payment_mode !== 'demo' || $('.demo-banner')) return;
    const banner = h('p', { class: 'demo-banner', role: 'note', text: 'Demo mode: no real payments are taken.' });
    const header = $('.site-header');
    if (header) header.prepend(banner); else document.body.prepend(banner);
    document.documentElement.classList.add('has-demo-banner');
  }).catch(() => { /* the banner is informational; pages still work without /api/config */ });
}

function initCount() {
  const el = $('#basket-count');
  if (!el) return;
  let last = null;
  const paint = () => {
    const n = basket.count();
    el.textContent = String(n);
    const btn = el.closest('button, a');
    if (btn) btn.setAttribute('aria-label', 'Basket, ' + n + (n === 1 ? ' item' : ' items'));
    if (last !== null && last !== n) announce(n === 0 ? 'Basket is empty.' : 'Basket: ' + n + (n === 1 ? ' item.' : ' items.'));
    last = n;
  };
  paint();
  basket.subscribe(paint);
}

/* ---------- basket drawer ---------- */
let drawer, bodyEl, footEl, msgEl, lastQuote = null, shownProblems = [], pendingFocus = null;

function lineKey(l) { return l.product_id + '|' + l.grind; }

function buildDrawer() {
  bodyEl = h('div', { class: 'drawer-body' });
  footEl = h('div', { class: 'drawer-foot' });
  msgEl = h('div', { class: 'drawer-msgs', 'aria-live': 'polite' });
  drawer = h('dialog', { class: 'drawer', id: 'basket-drawer', 'aria-labelledby': 'basket-title' },
    h('div', { class: 'drawer-head' },
      h('h2', { class: 'drawer-title', id: 'basket-title', text: 'Basket' }),
      h('button', { class: 'btn btn--quiet btn--icon dlg-close', type: 'button', 'aria-label': 'Close basket', on: { click: () => drawer.close() } }, closeIcon())),
    msgEl, bodyEl, footEl);
  document.body.appendChild(drawer);
  setupDialog(drawer, { onClose: () => { shownProblems = []; } });
  drawer._fallbackFocus = () => $('#basket-btn');
}

function changeQty(line, to, action) {
  shownProblems = [];
  pendingFocus = lineKey(line) + ':' + action;
  basket.set(line.product_id, line.grind, to);
}

function renderProblems() {
  clear(msgEl);
  if (!shownProblems.length) return;
  msgEl.appendChild(h('div', { class: 'notice notice--warn fade-in' },
    h('div', null,
      h('h3', { text: 'Your basket was updated' }),
      h('ul', null, shownProblems.map((p) => h('li', { text: p.message }))))));
}

function renderLine(l) {
  const key = lineKey(l);
  const problem = shownProblems.find((p) => p.product_id === l.product_id && p.code === 'quantity_reduced');
  const pic = l.image_url
    ? h('img', { class: 'thumb', src: l.image_url, alt: '', width: 34, height: 34 })
    : h('span', { class: 'swatch', 'aria-hidden': 'true', vars: { '--bag': l.bag_color } });
  return h('li', { class: 'bline', data: { key } },
    pic,
    h('div', { class: 'bline-info' },
      h('span', { class: 'bline-name', text: l.name }),
      h('span', { class: 'bline-meta', text: l.roaster.name + ' · ' + l.weight_g + 'g · ' + l.grind }),
      h('span', { class: 'bline-total', text: money(l.line_total_pence) + (l.quantity > 1 ? ' (' + money(l.unit_price_pence) + ' each)' : '') }),
      problem ? h('span', { class: 'field-error', text: problem.message }) : null),
    h('div', { class: 'bline-ctl' },
      h('div', { class: 'qty', role: 'group', 'aria-label': 'Quantity of ' + l.name },
        h('button', { type: 'button', 'aria-label': 'Remove one ' + l.name, data: { focus: key + ':less' }, text: '−', on: { click: () => changeQty(l, l.quantity - 1, l.quantity - 1 > 0 ? 'less' : 'gone') } }),
        h('span', { class: 'qty-n', text: String(l.quantity) }),
        h('button', { type: 'button', 'aria-label': 'Add one ' + l.name, data: { focus: key + ':more' }, text: '+', disabled: l.quantity >= MAX_QTY, on: { click: () => changeQty(l, l.quantity + 1, 'more') } })),
      h('button', { class: 'linkbtn small', type: 'button', 'aria-label': 'Remove ' + l.name + ' from basket', text: 'Remove', on: { click: () => changeQty(l, 0, 'gone') } })));
}

function wayOption(value, title, sub, on, off) {
  const input = h('input', { type: 'radio', name: 'drawer-way', value, checked: on, disabled: off });
  input.checked = on;
  input.addEventListener('change', () => { prefs.setFulfilment(value); refresh(); });
  return h('label', { class: 'way' + (on ? ' is-on' : '') + (off ? ' is-off' : '') }, input, h('b', { text: title }), h('small', { text: sub }));
}

export function chooseFulfilment(q) {
  const want = prefs.fulfilment();
  const canCollect = q.collection.allowed, canDeliver = q.delivery.available !== false;
  if (want === 'collect' && canCollect) return 'collect';
  if (want === 'delivery' && canDeliver) return 'delivery';
  if (canCollect && want !== 'delivery') return 'collect';
  return canDeliver ? 'delivery' : (canCollect ? 'collect' : 'delivery');
}

function renderQuote(q) {
  clear(bodyEl); clear(footEl);
  renderProblems();
  if (!q || q.empty || !q.lines.length) {
    bodyEl.appendChild(h('div', { class: 'state fade-in' },
      h('p', { class: 'muted', text: 'Your basket is empty. Pick a bag from the shelf and it lands here.' }),
      h('a', { class: 'btn btn--primary', href: '/#market', text: 'Browse the shelf', on: { click: () => drawer.close() } })));
    return;
  }
  bodyEl.appendChild(h('ul', { class: 'blist', 'aria-label': 'Items in your basket' }, q.lines.map(renderLine)));

  const canCollect = q.collection.allowed, canDeliver = q.delivery.available !== false;
  const collectSub = canCollect ? 'From ' + q.collection.roaster.name : 'Not available';
  const deliverSub = canDeliver ? (q.delivery.fee_pence != null ? (q.delivery.estimated ? 'From ' : '') + money(q.delivery.fee_pence) : 'To your door') : 'Not available';
  const ways = h('fieldset', { class: 'ways-set' },
    h('legend', { class: 'sr-only', text: 'How to get it' }),
    h('div', { class: 'ways' },
      wayOption('collect', 'Collect', collectSub, q.fulfilment === 'collect', !canCollect),
      wayOption('delivery', 'Local delivery', deliverSub, q.fulfilment === 'delivery', !canDeliver)));
  footEl.appendChild(ways);
  if (!canCollect && q.collection.reason) footEl.appendChild(h('p', { class: 'small muted', id: 'drawer-collect-reason', text: q.collection.reason }));
  if (canCollect && q.fulfilment === 'collect' && q.collection.roaster) {
    const r = q.collection.roaster;
    footEl.appendChild(h('p', { class: 'small muted', text: 'Collect from ' + r.name + ', ' + r.area + ' ' + r.postcode + (r.collection_hours ? '. ' + r.collection_hours + '.' : '.') }));
  }
  if (!canDeliver && q.delivery.reason) footEl.appendChild(h('p', { class: 'small muted', text: q.delivery.reason }));

  const rows = [h('div', null, h('dt', { text: 'Subtotal' }), h('dd', { text: money(q.subtotal_pence) }))];
  if (q.fulfilment === 'delivery') rows.push(h('div', null, h('dt', { text: q.delivery.estimated ? 'Delivery (estimate)' : 'Delivery' }), h('dd', { text: money(q.delivery_fee_pence) })));
  rows.push(h('div', { class: 'grand' }, h('dt', { text: 'Total' }), h('dd', { text: money(q.total_pence) })));
  footEl.appendChild(h('dl', { class: 'totals' }, rows));

  if (q.can_checkout) footEl.appendChild(h('a', { class: 'btn btn--primary btn--big btn--block', href: '/checkout.html', text: 'Checkout' }));
  else {
    footEl.appendChild(h('button', { class: 'btn btn--primary btn--big btn--block', type: 'button', disabled: true, text: 'Checkout' }));
    footEl.appendChild(h('p', { class: 'small', role: 'status', text: 'Checkout is not possible for this basket yet. ' + ((q.fulfilment === 'delivery' ? q.delivery.reason : q.collection.reason) || '') }));
  }

  if (pendingFocus) {
    const key = pendingFocus; pendingFocus = null;
    let el = drawer.querySelector('[data-focus="' + CSS.escape(key) + '"]');
    if (el && el.disabled) el = el.parentNode.querySelector('button:not([disabled])');
    (el || drawer.querySelector('.dlg-close')).focus();
  }
}

async function refreshNow() {
  if (!drawer || !drawer.open) return;
  if (basket.isEmpty()) { lastQuote = null; renderQuote(null); return; }
  bodyEl.classList.add('is-busy'); footEl.classList.add('is-busy');
  try {
    const pc = prefs.postcode();
    let fulfilment = lastQuote ? chooseFulfilment(lastQuote) : (prefs.fulfilment() || 'collect');
    let q = await quoteBasket({ fulfilment, postcode: pc && pc.district });
    if (q === null) return;
    if (!q.empty && chooseFulfilment(q) !== q.fulfilment && q.lines.length) {
      fulfilment = chooseFulfilment(q);
      const q2 = await quoteBasket({ fulfilment, postcode: pc && pc.district });
      if (q2 === null) return;
      q2.problems = q.problems.concat(q2.problems);
      q = q2;
    }
    if (q.problems && q.problems.length) shownProblems = q.problems;
    lastQuote = q.empty ? null : q;
    renderQuote(q);
  } catch (err) {
    clear(bodyEl); clear(footEl);
    bodyEl.appendChild(errorState(err.message || 'We could not price your basket.', refreshNow));
  } finally {
    bodyEl.classList.remove('is-busy'); footEl.classList.remove('is-busy');
  }
}
const refresh = debounce(refreshNow, 120);

export function openBasket(opener) {
  if (!drawer) return;
  if (!drawer.open) {
    clear(bodyEl); clear(footEl); clear(msgEl);
    bodyEl.appendChild(h('p', { class: 'muted', role: 'status', text: basket.isEmpty() ? '' : 'Pricing your basket…' }));
    openDialog(drawer, opener);
  }
  refreshNow();
}

function initDrawer() {
  const btn = $('#basket-btn');
  if (!btn || btn.tagName !== 'BUTTON') return;
  buildDrawer();
  btn.addEventListener('click', () => openBasket(btn));
  basket.subscribe((lines, source) => { if (source !== 'quote' && drawer.open) refresh(); });
}

export function initSite() {
  initDemoBanner();
  initCount();
  initDrawer();
}
