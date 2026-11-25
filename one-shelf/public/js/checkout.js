// Checkout page: fulfilment choice, customer details, address, terms, order summary from the server quote.

import { api } from './api.js';
import { basket, prefs, quoteBasket } from './basket.js';
import { initSite, getConfig, chooseFulfilment } from './site.js';
import { h, clear, $, $$, money, setFieldError, setLoading, errorState, announce, EMAIL_RE, POSTCODE_FULL_RE } from './ui.js';

const FORM_KEY = 'os.checkout.form';
const root = $('#co-root');
let quote = null, way = null, els = {}, demo = false, submitting = false, pcDebounce;

const FIELD_IDS = {
  'customer.name': 'co-name', 'customer.email': 'co-email', 'customer.phone': 'co-phone',
  'address.line1': 'co-line1', 'address.line2': 'co-line2', 'address.city': 'co-city', 'address.postcode': 'co-postcode',
  'address': 'co-line1', 'delivery_notes': 'co-notes', 'accept_terms': 'co-terms', 'fulfilment': 'co-way-collect'
};

const RULES = {
  'co-name': (v) => (!v ? 'Enter your full name' : v.length > 100 ? 'Your name must be 100 characters or fewer' : ''),
  'co-email': (v) => (!v ? 'Enter your email address' : !EMAIL_RE.test(v) || v.length > 254 ? 'Enter an email address like name@example.com' : ''),
  'co-phone': (v) => { const d = v.replace(/\D/g, ''); return !v ? 'Enter a phone number, in case there is a problem with your order' : (d.length < 7 || d.length > 20 || /[^\d\s+\-()]/.test(v)) ? 'Enter a phone number, like 020 7946 0958' : ''; },
  'co-line1': (v) => (!v ? 'Enter the first line of your address' : v.length > 120 ? 'Address line 1 must be 120 characters or fewer' : ''),
  'co-line2': (v) => (v.length > 120 ? 'Address line 2 must be 120 characters or fewer' : ''),
  'co-city': (v) => (!v ? 'Enter your town or city' : v.length > 60 ? 'Town or city must be 60 characters or fewer' : ''),
  'co-postcode': (v) => (!v ? 'Enter your full postcode, e.g. E8 4PH' : !POSTCODE_FULL_RE.test(v) ? 'Enter a full London postcode, e.g. E8 4PH' : ''),
  'co-notes': (v) => (v.length > 500 ? 'Delivery notes must be 500 characters or fewer' : '')
};
const DELIVERY_ONLY = ['co-line1', 'co-line2', 'co-city', 'co-postcode', 'co-notes'];

function saved() { try { return JSON.parse(sessionStorage.getItem(FORM_KEY)) || {}; } catch (e) { return {}; } }
function saveForm() {
  const out = {};
  for (const id of Object.keys(RULES)) { const el = $('#' + id); if (el) out[id] = el.value; }
  try { sessionStorage.setItem(FORM_KEY, JSON.stringify(out)); } catch (e) { /* ignore */ }
}

function field(id, label, attrs = {}, { hint, optional, tag = 'input' } = {}) {
  const input = h(tag, { id, name: id.replace('co-', ''), class: tag === 'textarea' ? 'textarea' : 'input', ...attrs });
  const hintId = hint ? id + '-hint' : null;
  if (hintId) input.setAttribute('aria-describedby', hintId);
  if (!optional) input.required = true;
  const old = saved()[id];
  if (typeof old === 'string') input.value = old;
  input.addEventListener('blur', () => { validateField(id); saveForm(); });
  return h('div', { class: 'field' },
    h('label', { for: id }, label, optional ? h('span', { class: 'muted', text: ' (optional)' }) : null),
    input,
    hint ? h('span', { class: 'hint', id: hintId, text: hint }) : null,
    h('p', { class: 'field-error', id: id + '-error' }));
}

function validateField(id) {
  const el = $('#' + id);
  if (!el) return '';
  if (DELIVERY_ONLY.includes(id) && way !== 'delivery') { setFieldError(el, ''); return ''; }
  const msg = RULES[id](el.value.trim());
  setFieldError(el, msg);
  return msg;
}

function showSummaryErrors(list, title) {
  const host = clear(els.errors);
  if (!list.length) return;
  const box = h('div', { class: 'err-summary', role: 'alert', tabindex: '-1', id: 'co-error-summary' },
    h('h2', { text: title || 'There is a problem' }),
    h('ul', null, list.map((e) => h('li', null, e.id
      ? h('a', { href: '#' + e.id, text: e.message, on: { click: (ev) => { ev.preventDefault(); const t = $('#' + e.id); if (t) { t.focus(); t.scrollIntoView({ block: 'center' }); } } } })
      : h('span', { text: e.message })))));
  host.appendChild(box);
  box.focus();
  box.scrollIntoView({ block: 'start', behavior: 'auto' });
}

function notice(kind, title, messages) {
  const host = clear(els.notice);
  if (!title) return;
  const box = h('div', { class: 'notice notice--' + kind + ' fade-in', role: 'alert', tabindex: '-1' },
    h('div', null, h('h2', { text: title }), messages && messages.length ? h('ul', null, messages.map((m) => h('li', { text: m }))) : null));
  host.appendChild(box);
  box.focus();
  box.scrollIntoView({ block: 'center', behavior: 'auto' });
}

/* ---------- quote-driven parts ---------- */
function paintWays() {
  const q = quote;
  const canCollect = q.collection.allowed, canDeliver = q.delivery.available !== false;
  const opt = (value, title, sub, off) => {
    const input = h('input', { type: 'radio', name: 'fulfilment', value, id: 'co-way-' + value, disabled: off, 'aria-describedby': 'co-way-note' });
    input.checked = way === value;
    input.addEventListener('change', () => { way = value; prefs.setFulfilment(value); requote(); });
    return h('label', { class: 'way' + (way === value ? ' is-on' : '') + (off ? ' is-off' : ''), for: 'co-way-' + value }, input, h('b', { text: title }), h('small', { text: sub }));
  };
  const r = q.collection.roaster;
  clear(els.ways).append(
    opt('collect', 'Collect from the roastery', canCollect ? r.name + ', ' + r.area + ' · free' : 'Not available for this basket', !canCollect),
    opt('delivery', 'Local delivery', canDeliver ? (q.delivery.fee_pence != null ? (q.delivery.estimated ? 'From ' : '') + money(q.delivery.fee_pence) : 'To your door') : 'Not available', !canDeliver));
  const notes = [];
  if (!canCollect && q.collection.reason) notes.push(q.collection.reason);
  if (canCollect && way === 'collect' && r.collection_hours) notes.push('Collection hours at ' + r.name + ': ' + r.collection_hours + '.');
  if (!canDeliver && q.delivery.reason) notes.push(q.delivery.reason);
  clear(els.wayNote).append(...notes.map((n) => h('p', { text: n })));
  els.addr.hidden = way !== 'delivery';
  const pcHint = $('#co-postcode-hint');
  if (pcHint) pcHint.textContent = q.delivery.available === true ? 'We deliver to this postcode.' : 'We deliver to London postcodes. ' + (q.delivery.available === null ? 'Enter yours to confirm.' : '');
}

function paintSummary() {
  const q = quote;
  const lines = q.lines.map((l) => h('li', { class: 'sum-line' },
    l.image_url ? h('img', { class: 'thumb', src: l.image_url, alt: '', width: 34, height: 34 }) : h('span', { class: 'swatch', 'aria-hidden': 'true', vars: { '--bag': l.bag_color } }),
    h('div', { class: 'bline-info' },
      h('span', { class: 'bline-name', text: l.name }),
      h('span', { class: 'bline-meta', text: l.roaster.name + ' · ' + l.weight_g + 'g · ' + l.grind }),
      h('span', { class: 'bline-meta', text: l.quantity + ' × ' + money(l.unit_price_pence) })),
    h('span', { class: 'amount', text: money(l.line_total_pence) })));
  const rows = [h('div', null, h('dt', { text: 'Subtotal' }), h('dd', { text: money(q.subtotal_pence) }))];
  rows.push(h('div', null, h('dt', { text: q.fulfilment === 'delivery' ? (q.delivery.estimated ? 'Delivery (estimate)' : 'Delivery') : 'Collection' }), h('dd', { text: q.fulfilment === 'delivery' ? money(q.delivery_fee_pence) : 'Free' })));
  rows.push(h('div', { class: 'grand' }, h('dt', { text: 'Total to pay' }), h('dd', { id: 'co-total', text: money(q.total_pence) })));
  clear(els.summary).append(
    h('h2', { text: 'Your order' }),
    h('ul', { class: 'sum-lines' }, lines),
    h('dl', { class: 'totals' }, rows),
    h('a', { class: 'linkbtn small', href: '/?basket=open', text: 'Edit basket' }));
  els.pay.disabled = !q.can_checkout || submitting;
  els.payNote.textContent = q.can_checkout ? '' : 'You cannot pay yet. ' + ((way === 'delivery' ? q.delivery.reason : q.collection.reason) || 'Check your basket and how you want to get it.');
}

function quotePostcode() {
  const el = $('#co-postcode');
  const v = el ? el.value.trim() : '';
  if (way === 'delivery' && POSTCODE_FULL_RE.test(v)) return v;
  const pc = prefs.postcode();
  return pc ? pc.district : undefined;
}

async function requote({ keepProblems } = {}) {
  if (basket.isEmpty()) { renderEmpty(); return null; }
  els.summary.classList.add('is-busy');
  try {
    let q = await quoteBasket({ fulfilment: way || prefs.fulfilment() || 'collect', postcode: quotePostcode() });
    if (q === null) return null;
    if (q.empty || !q.lines.length) { renderEmpty(q.problems); return null; }
    let switched = null;
    const best = way && ((way === 'collect' && q.collection.allowed) || (way === 'delivery' && q.delivery.available !== false)) ? way : chooseFulfilment(q);
    if (best !== q.fulfilment) {
      if (way && way !== best) switched = way;
      way = best;
      const again = await quoteBasket({ fulfilment: way, postcode: quotePostcode() });
      if (again === null) return null;
      again.problems = q.problems.concat(again.problems);
      q = again;
    }
    way = q.fulfilment;
    quote = q;
    paintWays(); paintSummary();
    const msgs = q.problems.map((p) => p.message);
    if (switched === 'collect') msgs.push('Collection is no longer possible, so we switched you to local delivery. ' + (q.collection.reason || ''));
    if (switched === 'delivery') msgs.push('Delivery is not available, so we switched you to collection. ' + (q.delivery.reason || ''));
    if (msgs.length && !keepProblems) notice('warn', 'Your order changed. Please check it before paying.', msgs);
    return q;
  } catch (err) {
    els.pay.disabled = true;
    clear(els.summary).append(h('h2', { text: 'Your order' }), errorState(err.message || 'We could not price your basket.', () => requote()));
    return null;
  } finally {
    els.summary.classList.remove('is-busy');
  }
}

function renderEmpty(problems) {
  clear(root).append(h('div', { class: 'state fade-in' },
    problems && problems.length ? h('div', { class: 'notice notice--warn' }, h('ul', null, problems.map((p) => h('li', { text: p.message })))) : null,
    h('h2', { class: 'serif', text: 'Your basket is empty' }),
    h('p', { class: 'muted', text: 'Add a bag from the shelf and come back to check out.' }),
    h('a', { class: 'btn btn--primary', href: '/#market', text: 'Back to the shop' })));
  root.setAttribute('aria-busy', 'false');
}

/* ---------- submit ---------- */
function body() {
  const v = (id) => $('#' + id).value.trim();
  const out = {
    items: basket.lines(), fulfilment: way,
    customer: { name: v('co-name'), email: v('co-email'), phone: v('co-phone') },
    accept_terms: $('#co-terms').checked === true
  };
  if (way === 'delivery') {
    out.address = { line1: v('co-line1'), city: v('co-city'), postcode: v('co-postcode').toUpperCase() };
    if (v('co-line2')) out.address.line2 = v('co-line2');
    if (v('co-notes')) out.delivery_notes = v('co-notes');
  }
  return out;
}

async function submit(e) {
  e.preventDefault();
  if (submitting) return;
  clear(els.notice);
  const errors = [];
  for (const id of Object.keys(RULES)) { const msg = validateField(id); if (msg) errors.push({ id, message: msg }); }
  const terms = $('#co-terms');
  const termsMsg = terms.checked ? '' : 'Tick the box to accept the terms of sale';
  setFieldError(terms, termsMsg);
  if (termsMsg) errors.push({ id: 'co-terms', message: termsMsg });
  if (!quote || !quote.can_checkout) errors.push({ id: 'co-way-' + (way || 'collect'), message: 'Choose how you want to get your order. ' + (els.payNote.textContent || '') });
  showSummaryErrors(errors);
  if (errors.length) return;

  submitting = true;
  setLoading(els.pay, true, 'Placing order…');
  let leaving = false;
  try {
    const sent = body();
    const res = await api.checkout(sent);
    try {
      sessionStorage.setItem('os.lastOrder', JSON.stringify({ ref: res.order_ref, token: res.access_token }));
      localStorage.setItem('os.pendingOrder', JSON.stringify({ ref: res.order_ref }));
    } catch (err) { /* storage unavailable: the redirect still carries ref and token */ }
    const target = new URL(res.payment_url, location.origin);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('Unexpected payment address');
    leaving = true;
    els.pay.textContent = 'Taking you to payment…';
    announce('Order placed. Taking you to payment.');
    location.assign(target.href);
  } catch (err) {
    if (err.status === 422 && err.fields) {
      const list = [];
      for (const [key, message] of Object.entries(err.fields)) {
        const id = FIELD_IDS[key];
        const el = id && $('#' + id);
        if (el && key !== 'fulfilment' && key !== 'address') setFieldError(el, message);
        list.push({ id: el ? id : (key.startsWith('items') ? 'co-summary' : null), message });
      }
      showSummaryErrors(list.length ? list : [{ id: null, message: err.message }]);
    } else if (err.status === 409) {
      const extra = Object.values(err.fields || {});
      await requote({ keepProblems: true });
      const fromQuote = quote ? quote.problems.map((p) => p.message) : [];
      const all = Array.from(new Set(extra.concat(fromQuote)));
      notice('warn', err.message || 'Your basket changed.', all.concat(['We have refreshed your order below. Please check it, then pay when you are happy.']));
    } else {
      notice('error', err.message || 'Something went wrong. You have not been charged.', [err.status === 503 || err.code === 'network' ? 'Nothing was charged. Your details are still filled in, so you can try again.' : 'Your details are still filled in, so you can try again.']);
    }
  } finally {
    if (!leaving) {
      submitting = false;
      setLoading(els.pay, false);
      els.pay.disabled = !(quote && quote.can_checkout);
    }
  }
}

function build() {
  els.errors = h('div', { id: 'co-errors' });
  els.notice = h('div', { id: 'co-notice' });
  els.ways = h('div', { class: 'ways' });
  els.wayNote = h('div', { class: 'small muted', id: 'co-way-note' });
  els.summary = h('aside', { class: 'summary', id: 'co-summary', 'aria-label': 'Order summary', tabindex: '-1' }, h('h2', { text: 'Your order' }), h('p', { class: 'muted', role: 'status', text: 'Pricing your basket…' }));
  els.pay = h('button', { class: 'btn btn--primary btn--big', type: 'submit', id: 'co-pay', text: 'Place order and pay', disabled: true });
  els.payNote = h('p', { class: 'small', id: 'co-pay-note', role: 'status' });

  const pcField = field('co-postcode', 'Postcode', { autocomplete: 'postal-code', autocapitalize: 'characters', spellcheck: 'false', inputmode: 'text', maxlength: 10 }, { hint: 'We deliver to London postcodes.' });
  els.addr = h('fieldset', { class: 'fs', id: 'co-address', hidden: true },
    h('legend', { text: 'Delivery address' }),
    field('co-line1', 'Address line 1', { autocomplete: 'address-line1', maxlength: 120 }),
    field('co-line2', 'Address line 2', { autocomplete: 'address-line2', maxlength: 120 }, { optional: true }),
    h('div', { class: 'fs-row' },
      field('co-city', 'Town or city', { autocomplete: 'address-level2', maxlength: 60 }),
      pcField),
    field('co-notes', 'Delivery notes', { maxlength: 500, rows: 3 }, { optional: true, tag: 'textarea', hint: 'For example, where to leave it if you are out.' }));
  const pcInput = $('#co-postcode', els.addr);
  pcInput.addEventListener('input', () => { clearTimeout(pcDebounce); pcDebounce = setTimeout(() => { if (POSTCODE_FULL_RE.test(pcInput.value.trim())) requote(); }, 500); });
  pcInput.addEventListener('blur', () => { clearTimeout(pcDebounce); if (POSTCODE_FULL_RE.test(pcInput.value.trim())) requote(); });

  const terms = h('input', { type: 'checkbox', id: 'co-terms', name: 'accept_terms', required: true });
  terms.addEventListener('change', () => { if (terms.checked) setFieldError(terms, ''); });

  const form = h('form', { class: 'co-form', id: 'co-form', novalidate: true },
    h('fieldset', { class: 'fs' }, h('legend', { text: 'How would you like to get it?' }), els.ways, els.wayNote),
    h('fieldset', { class: 'fs' },
      h('legend', { text: 'Your details' }),
      field('co-name', 'Full name', { autocomplete: 'name', maxlength: 100 }),
      h('div', { class: 'fs-row' },
        field('co-email', 'Email address', { type: 'email', autocomplete: 'email', inputmode: 'email', spellcheck: 'false', autocapitalize: 'none', maxlength: 254 }),
        field('co-phone', 'Phone number', { type: 'tel', autocomplete: 'tel', inputmode: 'tel', maxlength: 26 }, { hint: 'Only used if there is a problem with your order.' }))),
    els.addr,
    h('div', { class: 'pay-row' },
      h('div', { class: 'check-wrap terms' },
        h('label', { class: 'check', for: 'co-terms' }, terms,
          h('span', null, 'I have read and accept the ', h('a', { href: '/terms.html', target: '_blank', rel: 'noopener', text: 'terms of sale (opens in a new tab)' }), '.')),
        h('p', { class: 'field-error', id: 'co-terms-error' })),
      demo ? h('p', { class: 'notice notice--ok small', id: 'co-demo', text: 'Demo shop: no money is taken. The next page lets you pretend to pay.' }) : null,
      els.pay, els.payNote));
  form.addEventListener('submit', submit);

  clear(root).append(h('div', { class: 'co-top' }, els.errors, els.notice), h('div', { class: 'co-grid' }, form, els.summary));
  root.setAttribute('aria-busy', 'false');
}

async function start() {
  initSite();
  if (basket.isEmpty()) { renderEmpty(); return; }
  try { demo = (await getConfig()).payment_mode === 'demo'; } catch (err) { demo = false; }
  build();
  await requote();
}

start();
