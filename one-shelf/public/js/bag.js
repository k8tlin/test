// The CSS-drawn coffee bag, the roast curve, and flavour bars. Colours come from the API as #RRGGBB
// and are applied as CSS custom properties.

import { h, s } from './ui.js';

export const ROAST = ['', 'Light', 'Light-medium', 'Medium', 'Medium-dark', 'Dark'];
export const AXES = [['acidity', 'Acidity'], ['sweetness', 'Sweetness'], ['body', 'Body'], ['fruit', 'Fruit'], ['floral', 'Floral'], ['roast', 'Roast']];
const CUP = 'M8 11.5l2.2 15.2c.2 1.2 1 1.8 2.1 1.8h7.6c1.1 0 1.9-.6 2.1-1.8L24 11.5 M6.4 11.4c6.5-.5 13-.4 19.3.1 M8.3 8.2c5.2-.5 10.3-.5 15.5 0l.9 3 M9.2 17.2c4.6.5 9.2.5 13.7-.1 M9.8 22c4.2.4 8.3.4 12.4 0 M13 5.5c-.9-1.3.9-2.2 0-3.6 M17.5 5.8c-.9-1.3.9-2.2 0-3.6';

export function roastName(level) { return ROAST[Math.max(1, Math.min(5, Math.round(level)))] || ''; }

export function buildBag(product, { icon = false, foot } = {}) {
  const r = product.roaster || {};
  return h('span', { class: 'bag', 'aria-hidden': 'true', vars: { '--bag': r.bag_color, '--label': r.label_color, '--label-ink': r.label_ink, '--tint': product.tint } },
    h('span', { class: 'bag-seal' }),
    h('span', { class: 'bag-valve' }),
    h('span', { class: 'bag-label' },
      h('span', { class: 'bl-r', text: r.name || '' }),
      h('span', { class: 'bl-n', text: product.name }),
      h('span', { class: 'bl-t' }),
      h('span', { class: 'bl-m' + (icon ? ' has-icon' : ''), text: (product.notes || []).join(' · ') }),
      icon ? s('svg', { class: 'bl-d', viewBox: '0 0 32 32', 'aria-hidden': 'true' }, s('path', { d: CUP })) : null,
      h('span', { class: 'bl-w', text: foot || (product.weight_g + 'g') })));
}

function mmss(t) {
  let m = Math.floor(t), sec = Math.round((t - m) * 60);
  if (sec === 60) { m += 1; sec = 0; }
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

/** An illustrative bean-temperature curve for a roast level from 1 (light) to 5 (dark). */
export function roastCurve(L) {
  const total = 9 + L * 0.45, charge = 196 + L * 3, drop = 198 + L * 4.5, tp = 1.2, tpT = 92, k = 1.2;
  const T = (t) => (t < tp
    ? charge - (charge - tpT) * (1 - Math.pow(1 - t / tp, 2))
    : tpT + (drop - tpT) * (1 - Math.exp(-k * (t - tp) / (total - tp))) / (1 - Math.exp(-k)));
  const X = (t) => 14 + t / total * 272;
  const Y = (c) => 128 - (c - 70) / 165 * 112;
  let d = '', fc = total;
  for (let i = 0; i <= 80; i++) {
    const t = total * i / 80, c = T(t);
    d += (i ? ' L' : 'M') + X(t).toFixed(1) + ' ' + Y(c).toFixed(1);
    if (fc === total && t > tp && c >= 196) fc = t;
  }
  const dev = total - fc;
  return {
    d, fcX: X(fc), dropY: Y(drop),
    stats: [
      { k: 'Charge temperature', v: Math.round(charge) + '°C' },
      { k: 'First crack', v: mmss(fc) },
      { k: 'Drop', v: Math.round(drop) + '°C at ' + mmss(total) },
      { k: 'Development', v: Math.round(dev / total * 100) + '% of roast' }
    ]
  };
}

export function buildCurve(level, { label } = {}) {
  const c = roastCurve(level);
  const fc = c.fcX.toFixed(1);
  const svg = s('svg', { class: 'curve', role: 'img', viewBox: '0 0 300 140', 'aria-label': label || ('Illustrative bean temperature curve. ' + c.stats.map((x) => x.k + ' ' + x.v).join(', ')) },
    s('line', { class: 'curve-axis', x1: 14, y1: 128, x2: 286, y2: 128 }),
    s('rect', { class: 'curve-dev', x: fc, y: 14, width: (286 - c.fcX).toFixed(1), height: 114 }),
    s('line', { class: 'curve-fc', x1: fc, y1: 14, x2: fc, y2: 128 }),
    s('path', { class: 'curve-line', d: c.d }),
    s('circle', { class: 'curve-drop', cx: 286, cy: c.dropY.toFixed(1), r: 4 }),
    s('text', { class: 'curve-text', x: (c.fcX - 4).toFixed(1), y: 11, 'text-anchor': 'end' }, 'first crack'));
  return { svg, stats: c.stats };
}

export function buildBars(flavour, cls = '') {
  return h('div', { class: 'bars ' + cls }, AXES.map(([key, label]) => {
    const v = Math.max(0, Math.min(10, Number(flavour && flavour[key]) || 0));
    return h('div', { class: 'bar' },
      h('span', { class: 'bar-label', text: label }),
      h('span', { class: 'bar-track', 'aria-hidden': 'true' }, h('span', { class: 'bar-fill', vars: { '--w': v * 10 + '%' } })),
      h('span', { class: 'bar-val', text: v + '/10' }));
  }));
}
