// The marketplace: postcode, filters, search, sort, product grid, add-to-basket steppers, roaster cards.
// Filter, sort and postcode state lives in the URL query string so links and the back button work.

import { api } from './api.js';
import { basket, prefs, capFor, DEFAULT_GRIND, MAX_QTY } from './basket.js';
import { h, clear, $, $$, money, distShort, distLong, debounce, announce, setFieldError, setLoading, errorState, reducedMotion, POSTCODE_ANY_RE } from './ui.js';
import { buildBag, roastName } from './bag.js';
import { initProduct, openProduct, syncProductFromUrl } from './product.js';

const SORTS = ['roast', 'near', 'price_asc', 'price_desc'];
const ROASTS = [['', 'Any roast'], ['light', 'Light'], ['medium', 'Medium'], ['dark', 'Dark']];
const BREWS = [['', 'Any method', ''], ['espresso', 'Espresso', 'machine, moka pot'], ['filter', 'Filter', 'pour-over, cafetière']];
const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];

const state = { postcode: null, roaster: '', roast: '', brew: '', max: null, q: '', sort: null };
const data = { roasters: [], all: [], products: [], nearest: null, priceMin: 0, priceMax: 0, ready: false };
const ui = { fOpen: window.innerWidth >= 940, fCol: {}, sessionAdded: new Map() };
const wide = window.matchMedia('(min-width: 940px)');
let els = {}, gridSeq = 0, gridCtrl = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const effectiveSort = () => (state.sort === 'near' && !state.postcode ? 'roast' : state.sort || (state.postcode ? 'near' : 'roast'));
const anyFilter = () => !!(state.roaster || state.roast || state.brew || state.max !== null || state.q);
const filterSig = () => JSON.stringify([state.postcode && state.postcode.district, state.roaster, state.roast, state.brew, state.max, state.q, state.sort]);

/* ---------- URL ---------- */
function readUrl() {
  const p = new URLSearchParams(location.search);
  state.roaster = (p.get('roaster') || '').slice(0, 80);
  state.roast = ROASTS.some((r) => r[0] === p.get('roast')) ? p.get('roast') : '';
  state.brew = BREWS.some((b) => b[0] === p.get('brew')) ? p.get('brew') : '';
  const max = parseInt(p.get('max'), 10);
  state.max = Number.isFinite(max) && max > 0 ? max : null;
  state.q = (p.get('q') || '').slice(0, 60);
  state.sort = SORTS.includes(p.get('sort')) ? p.get('sort') : null;
  const pc = (p.get('postcode') || '').trim().toUpperCase().slice(0, 8);
  return pc && POSTCODE_ANY_RE.test(pc) ? pc : null;
}

function writeUrl(push) {
  const p = new URLSearchParams();
  if (state.postcode) p.set('postcode', state.postcode.district);
  if (state.roaster) p.set('roaster', state.roaster);
  if (state.roast) p.set('roast', state.roast);
  if (state.brew) p.set('brew', state.brew);
  if (state.max !== null) p.set('max', String(state.max));
  if (state.q) p.set('q', state.q);
  if (state.sort && state.sort !== (state.postcode ? 'near' : 'roast')) p.set('sort', state.sort);
  const product = new URLSearchParams(location.search).get('product');
  if (product) p.set('product', product);
  const qs = p.toString(), url = location.pathname + (qs ? '?' + qs : '') + (push ? '' : location.hash);
  if (url === location.pathname + location.search + (push ? '' : location.hash)) return;
  if (push) history.pushState(history.state && history.state.osProduct ? {} : history.state, '', url);
  else history.replaceState(history.state, '', url);
}

function change(patch, { push = true } = {}) {
  Object.assign(state, patch);
  writeUrl(push);
  paintControls();
  loadGrid();
}

/* ---------- data ---------- */
async function loadBase() {
  const pc = state.postcode && state.postcode.district;
  let roasters, products;
  try {
    [roasters, products] = await Promise.all([api.roasters(pc), api.products({ postcode: pc })]);
  } catch (err) {
    if (pc && err.status === 422) { setPostcode(null, { silent: true }); return loadBase(); }
    throw err;
  }
  if (pc && !roasters.postcode) { setPostcode(null, { silent: true }); }
  else if (roasters.postcode) { state.postcode = roasters.postcode; prefs.setPostcode(roasters.postcode); }
  data.roasters = roasters.roasters;
  data.all = products.products;
  data.nearest = state.postcode && data.roasters.length ? data.roasters[0] : null;
  const prices = data.all.map((p) => p.price_pence);
  data.priceMin = prices.length ? Math.floor(Math.min(...prices) / 50) * 50 : 0;
  data.priceMax = prices.length ? Math.ceil(Math.max(...prices) / 50) * 50 : 0;
  if (state.roaster && !data.roasters.some((r) => r.slug === state.roaster)) state.roaster = '';
  if (state.max !== null && state.max >= data.priceMax) state.max = null;
  data.ready = true;
  writeUrl(false);
  paintStatic();
  paintControls();
  document.dispatchEvent(new CustomEvent('shop:data', { detail: { roasters: data.roasters, products: data.all, postcode: state.postcode } }));
}

async function loadGrid() {
  const seq = ++gridSeq;
  if (gridCtrl) gridCtrl.abort();
  gridCtrl = new AbortController();
  const wrap = els.wrap;
  wrap.classList.add('is-swapping');
  wrap.setAttribute('aria-busy', 'true');
  const started = performance.now();
  try {
    const res = await api.products({
      postcode: state.postcode && state.postcode.district, roaster: state.roaster, roast: state.roast, brew: state.brew,
      max_price_pence: state.max, q: state.q, sort: effectiveSort()
    }, gridCtrl.signal);
    if (!reducedMotion()) await sleep(Math.max(0, 220 - (performance.now() - started)));
    if (seq !== gridSeq) return;
    data.products = res.products;
    renderGrid();
    paintCount(res.count);
  } catch (err) {
    if (err.name === 'AbortError' || seq !== gridSeq) return;
    clear(wrap).appendChild(errorState(err.message || 'We could not load the shelf.', () => loadGrid()));
    els.count.textContent = 'Shelf unavailable';
    els.scope.textContent = '';
  } finally {
    if (seq === gridSeq) { wrap.classList.remove('is-swapping'); wrap.setAttribute('aria-busy', 'false'); }
  }
}

/* ---------- grid ---------- */
function controlFor(p, host) {
  const hadFocus = host.contains(document.activeElement) ? document.activeElement.dataset.act : null;
  clear(host);
  const inLine = basket.qty(p.id, DEFAULT_GRIND);
  const n = Math.min(ui.sessionAdded.get(p.id) || 0, inLine);
  ui.sessionAdded.set(p.id, n);
  const stockCap = capFor(p);
  const canAdd = stockCap > 0 && inLine < MAX_QTY && basket.productQty(p.id) < stockCap && !(inLine === 0 && basket.isFull());
  const add = () => { if (!canAddNow(p)) return; ui.sessionAdded.set(p.id, (ui.sessionAdded.get(p.id) || 0) + 1); basket.add(p.id, DEFAULT_GRIND, 1); };
  const less = () => { ui.sessionAdded.set(p.id, Math.max(0, (ui.sessionAdded.get(p.id) || 0) - 1)); basket.add(p.id, DEFAULT_GRIND, -1); };
  let focusEl = null;
  if (!p.in_stock) {
    host.appendChild(h('button', { class: 'btn padd', type: 'button', disabled: true, text: 'Sold out' }));
  } else if (n > 0) {
    const minus = h('button', { type: 'button', 'aria-label': 'Remove one ' + p.name + ' from basket', data: { act: 'less' }, text: '−', on: { click: less } });
    const plus = h('button', { type: 'button', 'aria-label': 'Add another ' + p.name, data: { act: 'more' }, text: '+', disabled: !canAdd, on: { click: add } });
    if (!canAdd) plus.title = 'That is the most you can order of this coffee';
    host.appendChild(h('div', { class: 'stepper', role: 'group', 'aria-label': p.name + ': ' + n + ' added to basket' },
      minus, h('span', { class: 'stepper-n' }, h('span', { 'aria-hidden': 'true', text: '✓' }), h('span', { text: n + ' added' })), plus));
    if (hadFocus) focusEl = (hadFocus === 'less' || !canAdd) ? minus : plus;
  } else {
    const btn = h('button', { class: 'btn padd', type: 'button', 'aria-label': 'Add ' + p.name + ' ' + p.weight_g + 'g to basket', data: { act: 'add' }, text: 'Add', disabled: !canAdd, on: { click: add } });
    if (!canAdd && inLine > 0) btn.textContent = 'Maximum in basket';
    host.appendChild(btn);
    if (hadFocus) focusEl = btn;
  }
  if (focusEl) focusEl.focus({ preventScroll: true });
}

function canAddNow(p) {
  const inLine = basket.qty(p.id, DEFAULT_GRIND), cap = capFor(p);
  return cap > 0 && inLine < MAX_QTY && basket.productQty(p.id) < cap && !(inLine === 0 && basket.isFull());
}

function metaLine(p) {
  const parts = [roastName(p.roast_level) + ' roast', p.roaster.area];
  if (state.postcode && p.distance_miles != null) parts.push(distShort(p.distance_miles));
  return parts.join(' · ');
}

function card(p) {
  const near = data.nearest && p.roaster.slug === data.nearest.slug;
  const pic = p.image_url ? h('img', { src: p.image_url, alt: '', loading: 'lazy' }) : buildBag(p);
  const open = h('button', { class: 'pimg', type: 'button', 'aria-label': p.name + ' by ' + p.roaster.name + ', view details', data: { open: p.slug } },
    near ? h('span', { class: 'ptag', text: 'Nearest' }) : null,
    !p.in_stock ? h('span', { class: 'ptag ptag--out', text: 'Sold out' }) : null,
    pic);
  open.addEventListener('click', () => openProduct(p.slug, open));
  const host = h('div', { class: 'padd-host', data: { product: p.id } });
  controlFor(p, host);
  return h('li', { class: 'pcard' },
    h('article', { class: 'pcard-in' },
      open,
      h('div', { class: 'pbody' },
        h('span', { class: 'proaster', text: p.roaster.name }),
        h('h3', { class: 'pname', text: p.name }),
        h('span', { class: 'pnotes', text: p.notes.join(' · ') }),
        h('span', { class: 'pmeta', text: metaLine(p) })),
      h('div', { class: 'pfoot' },
        h('span', { class: 'pprice' }, money(p.price_pence) + ' ', h('small', { text: '/ ' + p.weight_g + 'g' }),
          p.in_stock && p.low_stock && p.stock_left != null ? h('span', { class: 'pstock', text: ' · only ' + p.stock_left + ' left' }) : null),
        host)));
}

function renderGrid() {
  const wrap = clear(els.wrap);
  if (!data.products.length) {
    wrap.appendChild(h('div', { class: 'state fade-in' },
      h('p', { text: anyFilter() ? 'No coffees match those filters.' : 'The shelf is empty at the moment. Please check back soon.' }),
      anyFilter() ? h('button', { class: 'btn btn--ghost', type: 'button', text: 'Clear filters', on: { click: clearFilters } }) : null));
    return;
  }
  wrap.appendChild(h('ul', { class: 'pgrid', id: 'pgrid' }, data.products.map(card)));
}

function repaintSteppers() {
  for (const host of $$('.padd-host', els.wrap)) {
    const p = data.products.find((x) => x.id === host.dataset.product);
    if (p) controlFor(p, host);
  }
}

/* ---------- results bar, chips, filters ---------- */
function roasterBySlug(slug) { return data.roasters.find((r) => r.slug === slug); }

function paintCount(count) {
  const r = state.roaster && roasterBySlug(state.roaster);
  els.count.textContent = plural(count, 'coffee', 'coffees');
  els.scope.textContent = (r ? 'sold by ' + r.name : 'from ' + plural(data.roasters.length, 'London roastery', 'London roasteries')) + (effectiveSort() === 'near' ? ', nearest first' : '');
}

function clearFilters() {
  change({ roaster: '', roast: '', brew: '', max: null, q: '' });
  els.q.value = '';
  announce('Filters cleared.');
}

function chipsList() {
  const out = [];
  const r = state.roaster && roasterBySlug(state.roaster);
  if (r) out.push({ label: r.name, aria: 'Remove roaster filter: ' + r.name, patch: { roaster: '' } });
  if (state.brew) out.push({ label: BREWS.find((b) => b[0] === state.brew)[1], aria: 'Remove brew filter', patch: { brew: '' } });
  if (state.roast) out.push({ label: ROASTS.find((x) => x[0] === state.roast)[1] + ' roast', aria: 'Remove roast filter', patch: { roast: '' } });
  if (state.max !== null) out.push({ label: 'Up to ' + money(state.max), aria: 'Remove price limit', patch: { max: null } });
  if (state.q) out.push({ label: '“' + state.q + '”', aria: 'Clear search', patch: { q: '' }, after: () => { els.q.value = ''; } });
  return out;
}

function frow(label, right, on, pick) {
  return h('li', null, h('button', { class: 'frow', type: 'button', 'aria-pressed': on ? 'true' : 'false', on: { click: pick } },
    h('span', { class: 'frow-label', text: label }), right ? h('span', { class: 'frow-right', text: right }) : null));
}

function fgroup(title, picked, rows) {
  const shut = !!ui.fCol[title];
  const id = 'fg-' + title.toLowerCase().replace(/\W+/g, '-');
  const head = h('button', { class: 'fk fhead', type: 'button', 'aria-expanded': shut ? 'false' : 'true', 'aria-controls': id, data: { fg: title } },
    h('span', null, title + ' ', shut && picked ? h('span', { class: 'fhead-picked', text: '· ' + picked }) : null),
    h('span', { class: 'fhead-sign', 'aria-hidden': 'true', text: shut ? '+' : '−' }));
  head.addEventListener('click', () => { ui.fCol[title] = !shut; paintFilters(); const again = $('[data-fg="' + title + '"]', els.lists); if (again) again.focus(); });
  return h('div', { class: 'fgroup', role: 'group', 'aria-label': title }, h('h3', { class: 'fgroup-h' }, head), h('ul', { id, hidden: shut }, shut ? [] : rows));
}

function paintFilters() {
  const pc = state.postcode;
  const r = state.roaster && roasterBySlug(state.roaster);
  const roasterRows = [frow('All roasters', String(data.all.length), !state.roaster, () => change({ roaster: '' }))]
    .concat(data.roasters.map((x) => frow(x.name, pc && x.distance_miles != null ? distShort(x.distance_miles) : x.postcode, state.roaster === x.slug, () => change({ roaster: state.roaster === x.slug ? '' : x.slug }))));
  const roastRows = ROASTS.map(([v, label]) => frow(label, '', state.roast === v, () => change({ roast: v })));
  const brewRows = BREWS.map(([v, label, hint]) => frow(label, hint, state.brew === v, () => change({ brew: v })));
  const active = document.activeElement && els.lists.contains(document.activeElement) ? document.activeElement : null;
  const path = active ? [active.closest('.fgroup') && active.closest('.fgroup').getAttribute('aria-label'), $$('.frow', active.closest('.fgroup')).indexOf(active)] : null;
  clear(els.lists).append(
    fgroup('Roaster', r && r.name, roasterRows),
    fgroup('Roast', state.roast && ROASTS.find((x) => x[0] === state.roast)[1], roastRows),
    fgroup('Brewed with', state.brew && BREWS.find((x) => x[0] === state.brew)[1], brewRows));
  if (path && path[1] >= 0) {
    const g = $('.fgroup[aria-label="' + path[0] + '"]', els.lists);
    const again = g && $$('.frow', g)[path[1]];
    if (again) again.focus({ preventScroll: true });
  }
}

function paintControls() {
  if (!data.ready) return;
  paintFilters();
  // price slider
  els.price.min = String(data.priceMin); els.price.max = String(data.priceMax);
  const v = state.max === null ? data.priceMax : Math.max(data.priceMin, Math.min(data.priceMax, state.max));
  els.price.value = String(v);
  els.priceVal.textContent = money(v);
  els.price.setAttribute('aria-valuetext', 'Up to ' + money(v));
  if (document.activeElement !== els.q) els.q.value = state.q;
  // sort
  const nearOpt = $('option[value="near"]', els.sort);
  nearOpt.disabled = !state.postcode;
  nearOpt.textContent = state.postcode ? 'Nearest first' : 'Nearest first (set a postcode)';
  els.sort.value = effectiveSort();
  // chips
  const chips = chipsList();
  clear(els.chips);
  els.chips.hidden = !chips.length;
  for (const c of chips) {
    els.chips.appendChild(h('li', null, h('button', { class: 'chipx', type: 'button', 'aria-label': c.aria, on: { click: () => { if (c.after) c.after(); change(c.patch); (els.clear.hidden ? els.sort : els.clear).focus(); } } },
      h('span', { text: c.label }), h('span', { 'aria-hidden': 'true', text: '×' }))));
  }
  els.clear.hidden = !anyFilter();
  els.openCount.textContent = chips.length ? chips.length + ' on' : '';
  // roaster cards
  for (const b of $$('.rcard', els.rcards)) b.setAttribute('aria-pressed', b.dataset.slug === state.roaster ? 'true' : 'false');
  const sel = state.roaster && roasterBySlug(state.roaster);
  clear(els.rsel);
  if (sel) els.rsel.append(h('b', { text: sel.name }), h('span', { class: 'muted', text: (sel.description ? sel.description + ' ' : '') + 'Their bags are on the shelf above.' }));
  paintPostcode();
}

function applyPanel() {
  const isWide = wide.matches;
  els.filters.hidden = isWide && !ui.fOpen;
  els.groups.hidden = !ui.fOpen;
  els.open.hidden = !(isWide && !ui.fOpen);
  els.toggle.setAttribute('aria-expanded', ui.fOpen ? 'true' : 'false');
  els.toggleSign.textContent = isWide ? 'Hide' : (ui.fOpen ? '−' : '+');
  els.market.classList.toggle('is-full', isWide && !ui.fOpen);
}

/* ---------- things painted once the catalogue is known ---------- */
function paintStatic() {
  const pc = state.postcode, counts = {};
  for (const p of data.all) counts[p.roaster.slug] = (counts[p.roaster.slug] || 0) + 1;
  $('#fact-roasters').textContent = String(data.roasters.length);
  $('#fact-coffees').textContent = String(data.all.length);
  $('#fact-near-v').textContent = data.nearest && data.nearest.distance_miles != null ? distShort(data.nearest.distance_miles) : 'London';
  $('#fact-near-k').textContent = data.nearest ? 'to your nearest roaster' : 'is where all of it is roasted';
  $('#roaster-count-word').textContent = WORDS[data.roasters.length] || String(data.roasters.length);
  $('#roaster-intro').textContent = pc ? 'Nearest to ' + pc.label + ' first. Distances are approximate.' : 'All roasting inside London. Choose one to see only their bags on the shelf.';

  clear(els.rcards);
  for (const r of data.roasters) {
    const n = counts[r.slug] || 0;
    const btn = h('button', { class: 'rcard', type: 'button', 'aria-pressed': 'false', data: { slug: r.slug } },
      h('span', { class: 'duo' }, r.image_url ? h('img', { src: r.image_url, alt: '', loading: 'lazy' }) : null),
      h('span', { class: 'rcard-text' },
        h('span', { class: 'rcard-name', text: r.name }),
        h('span', { class: 'rcard-meta', text: r.area + ' · ' + (pc && r.distance_miles != null ? distShort(r.distance_miles) : r.postcode) + ' · shop ' + plural(n, 'coffee', 'coffees') })));
    btn.addEventListener('click', () => {
      change({ roaster: state.roaster === r.slug ? '' : r.slug });
      els.market.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    });
    els.rcards.appendChild(btn);
  }

  const marq = clear($('#marq'));
  for (let pass = 0; pass < 2; pass++) for (const r of data.roasters) marq.appendChild(h('span', { text: r.name, 'aria-hidden': pass ? 'true' : null }));
}

/* ---------- postcode ---------- */
function paintPostcode() {
  const pc = state.postcode;
  els.chip.classList.toggle('is-set', !!pc);
  $('#pc-chip-code').textContent = pc ? pc.district : 'LDN';
  $('#pc-chip-text').textContent = pc ? (effectiveSort() === 'near' ? 'Nearest first' : 'Change postcode') : 'Set postcode';
  els.chip.setAttribute('aria-label', pc ? 'Postcode ' + pc.district + ', change postcode' : 'Set your postcode');
  els.pcClear.hidden = !pc;
  if (pc && !els.pcInput.value) els.pcInput.value = pc.district;
  if (pc && data.nearest && !els.pcStatus.textContent) els.pcStatus.textContent = 'Nearest to ' + pc.label + ': ' + data.nearest.name + ', ' + distLong(data.nearest.distance_miles) + '.';
  if (!pc) els.pcStatus.textContent = '';
}

function setPostcode(pc, { silent } = {}) {
  state.postcode = pc;
  prefs.setPostcode(pc);
  if (!silent) writeUrl(true);
}

async function submitPostcode(e) {
  e.preventDefault();
  const raw = els.pcInput.value.trim();
  if (!raw) { setFieldError(els.pcInput, 'Enter a London postcode, e.g. E8 4PH'); els.pcInput.focus(); return; }
  setLoading(els.pcSubmit, true, 'Finding…');
  try {
    const res = await api.postcode(raw);
    setFieldError(els.pcInput, '');
    state.sort = null; // nearest first becomes the default once a postcode is set
    setPostcode({ district: res.district, label: res.label });
    els.pcStatus.textContent = res.nearest_roaster
      ? 'Nearest to ' + res.label + ': ' + res.nearest_roaster.name + ', ' + distLong(res.nearest_roaster.distance_miles) + '.' + (res.approximate ? ' Measured from the middle of ' + res.label + '.' : '')
      : 'Showing the shelf for ' + res.label + '.';
    await loadBase();
    await loadGrid();
    setTimeout(() => els.market.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }), 400);
  } catch (err) {
    if (err.status === 422) {
      setFieldError(els.pcInput, err.code === 'postcode_not_london'
        ? 'Enter a London postcode, e.g. E8 4PH. One Shelf only covers London for now.'
        : 'Enter a London postcode, e.g. E8 4PH');
    } else {
      setFieldError(els.pcInput, err.message || 'We could not check that postcode. Please try again.');
    }
    els.pcInput.focus();
  } finally {
    setLoading(els.pcSubmit, false);
  }
}

async function clearPostcode() {
  state.sort = state.sort === 'near' ? null : state.sort;
  setPostcode(null);
  els.pcInput.value = '';
  setFieldError(els.pcInput, '');
  els.pcStatus.textContent = 'Postcode cleared.';
  els.pcInput.focus();
  try { await loadBase(); await loadGrid(); } catch (err) { showBaseError(err); }
  els.pcStatus.textContent = 'Postcode cleared.';
}

function showBaseError(err) {
  clear(els.wrap).appendChild(errorState((err && err.message) || 'We could not load the shelf.', start));
  els.wrap.classList.remove('is-swapping');
  els.wrap.setAttribute('aria-busy', 'false');
  els.count.textContent = 'Shelf unavailable';
}

async function start() {
  clear(els.wrap).appendChild(h('p', { class: 'state muted', role: 'status', text: 'Loading the shelf…' }));
  try {
    await loadBase();
  } catch (err) { showBaseError(err); return; }
  await loadGrid();
  syncProductFromUrl();
}

export function initShop() {
  els = {
    market: $('#market'), filters: $('#filters'), groups: $('#f-groups'), lists: $('#f-lists'), toggle: $('#f-toggle'), toggleSign: $('#f-toggle-sign'),
    open: $('#f-open'), openCount: $('#f-open-count'), q: $('#mk-q'), price: $('#mk-price'), priceVal: $('#mk-price-val'), sort: $('#mk-sort'),
    count: $('#r-count'), scope: $('#r-scope'), clear: $('#r-clear'), chips: $('#chips'), wrap: $('#grid-wrap'), rcards: $('#rcards'), rsel: $('#rsel'),
    chip: $('#pc-chip'), pcForm: $('#pc-form'), pcInput: $('#pc-input'), pcSubmit: $('#pc-submit'), pcStatus: $('#pc-status'), pcClear: $('#pc-clear')
  };

  const urlPc = readUrl();
  const stored = prefs.postcode();
  state.postcode = urlPc ? { district: urlPc, label: urlPc } : stored;

  initProduct({
    getProduct: (slug) => data.all.find((p) => p.slug === slug) || null,
    getPostcode: () => state.postcode
  });

  // filters panel
  applyPanel();
  wide.addEventListener('change', applyPanel);
  els.toggle.addEventListener('click', () => { ui.fOpen = !ui.fOpen; applyPanel(); if (wide.matches && !ui.fOpen) els.open.focus(); });
  els.open.addEventListener('click', () => { ui.fOpen = true; applyPanel(); els.toggle.focus(); });

  // search, price, sort
  const searchNow = debounce(() => change({ q: els.q.value.trim().slice(0, 60) }, { push: false }), 250);
  els.q.addEventListener('input', searchNow);
  els.q.addEventListener('search', searchNow);
  const priceNow = debounce(() => { const v = Number(els.price.value); change({ max: v >= data.priceMax ? null : v }, { push: false }); }, 250);
  els.price.addEventListener('input', () => { els.priceVal.textContent = money(Number(els.price.value)); els.price.setAttribute('aria-valuetext', 'Up to ' + money(Number(els.price.value))); priceNow(); });
  els.sort.addEventListener('change', () => change({ sort: els.sort.value }));
  els.clear.addEventListener('click', () => { clearFilters(); els.sort.focus(); });

  // postcode
  els.pcForm.addEventListener('submit', submitPostcode);
  els.pcInput.addEventListener('blur', () => {
    const v = els.pcInput.value.trim();
    if (v && !POSTCODE_ANY_RE.test(v)) setFieldError(els.pcInput, 'Enter a London postcode, e.g. E8 4PH');
    else if (els.pcInput.getAttribute('aria-invalid')) setFieldError(els.pcInput, '');
  });
  els.pcClear.addEventListener('click', clearPostcode);
  els.chip.addEventListener('click', (e) => {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
    els.pcInput.focus({ preventScroll: true });
    els.pcInput.select();
  });

  basket.subscribe(repaintSteppers);

  window.addEventListener('popstate', async () => {
    const before = filterSig();
    const urlPc2 = readUrl();
    const pcChanged = (urlPc2 || null) !== ((state.postcode && state.postcode.district) || null);
    if (pcChanged) {
      state.postcode = urlPc2 ? { district: urlPc2, label: urlPc2 } : null;
      prefs.setPostcode(state.postcode);
      els.pcInput.value = urlPc2 || '';
      els.pcStatus.textContent = '';
      try { await loadBase(); } catch (err) { showBaseError(err); return; }
    }
    if (pcChanged || before !== filterSig()) { paintControls(); await loadGrid(); }
    syncProductFromUrl();
  });

  start();
}
