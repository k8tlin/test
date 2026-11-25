// "Read the label": roast curve with a slider, taste bars for three example coffees,
// nearest roasters, and the collect-or-delivery choice.

import { prefs } from './basket.js';
import { h, clear, $, $$, distShort } from './ui.js';
import { buildCurve, buildBars, roastCurve, roastName } from './bag.js';

const EXAMPLES = ['yirgacheffe-washed', 'guji-natural', 'gayo-wet-hulled'];
let examples = [], picked = 0;

function paintRoast() {
  const level = Number($('#demo-roast').value);
  const name = roastName(level);
  const c = roastCurve(level);
  const built = buildCurve(level, { label: 'Illustrative roast curve for a ' + name.toLowerCase() + ' roast. ' + c.stats.map((x) => x.k + ' ' + x.v).join(', ') });
  built.svg.classList.add('curve--thin');
  clear($('#demo-curve')).appendChild(built.svg);
  $('#demo-name').textContent = name;
  $('#demo-roast').setAttribute('aria-valuetext', name);
  $('#demo-line').textContent = 'First crack at ' + c.stats[1].v + ', dropped at ' + c.stats[2].v + '. ' + c.stats[3].v.replace(' of roast', '') + ' of the roast comes after first crack.';
}

function paintTaste() {
  const chips = clear($('#taste-chips'));
  const p = examples[picked];
  if (!p) { clear($('#taste-bars')); return; }
  examples.forEach((x, i) => chips.appendChild(h('button', { class: 'lchip', type: 'button', 'aria-pressed': i === picked ? 'true' : 'false', text: x.name, on: { click: () => { picked = i; paintTaste(); $$('.lchip', chips)[i].focus(); } } })));
  $('#taste-line').textContent = p.name + ' from ' + p.roaster.name + ': ' + p.notes.join(', ').toLowerCase() + '.';
  const host = $('#taste-bars');
  const fills = $$('.bar-fill', host);
  if (fills.length === 6) {
    // update in place so the bars slide rather than jump
    const fresh = buildBars(p.flavour);
    $$('.bar-fill', fresh).forEach((f, i) => fills[i].style.setProperty('--w', f.style.getPropertyValue('--w')));
    $$('.bar-val', fresh).forEach((v, i) => { $$('.bar-val', host)[i].textContent = v.textContent; });
  } else clear(host).appendChild(buildBars(p.flavour));
}

function paintNear(roasters, postcode) {
  const list = clear($('#near-list'));
  for (const r of roasters.slice(0, 4)) list.appendChild(h('li', null, h('span', { text: r.name }), h('span', { text: postcode && r.distance_miles != null ? distShort(r.distance_miles) : r.area })));
  $('#near-line').textContent = postcode ? 'Measured in a straight line from the middle of ' + postcode.label + '. Approximate.' : 'Enter your postcode at the top and this list turns into distances.';
}

function paintWay() {
  const way = prefs.fulfilment() || 'collect';
  for (const b of $$('#way-chips .lchip')) b.setAttribute('aria-pressed', b.dataset.way === way ? 'true' : 'false');
  $('#way-line').textContent = way === 'collect'
    ? 'Pick it up from the roastery counter. Collection is offered when your whole basket comes from one roastery.'
    : 'Have it brought to your door. The delivery fee is shown in your basket before you pay.';
}

export function initLabel() {
  if (!$('#how')) return;
  $('#demo-roast').addEventListener('input', paintRoast);
  paintRoast();
  for (const b of $$('#way-chips .lchip')) b.addEventListener('click', () => { prefs.setFulfilment(b.dataset.way); paintWay(); });
  paintWay();
  document.addEventListener('shop:data', (e) => {
    const { roasters, products, postcode } = e.detail;
    const found = EXAMPLES.map((slug) => products.find((p) => p.slug === slug)).filter(Boolean);
    examples = found.length === 3 ? found : products.slice(0, 3);
    if (picked >= examples.length) picked = 0;
    paintTaste();
    paintNear(roasters, postcode);
  });
}
