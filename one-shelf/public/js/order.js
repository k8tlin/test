// Order confirmation and status page: /order.html?ref=OS-XXXXXXX&token=...

import { api } from './api.js';
import { basket } from './basket.js';
import { initSite } from './site.js';
import { h, clear, $, money, errorState } from './ui.js';

const root = $('#order-root');
const PAID_ISH = ['paid', 'preparing', 'ready_for_collection', 'out_for_delivery', 'completed'];
let polls = 0, pollTimer = null;

const STATUS = {
  pending_payment: ['wait', 'Waiting for payment', 'Your order is waiting for payment'],
  paid: ['ok', 'Paid', 'Thank you. Your order is confirmed'],
  preparing: ['ok', 'Being packed', 'Your order is being packed'],
  ready_for_collection: ['ok', 'Ready to collect', 'Your order is ready to collect'],
  out_for_delivery: ['ok', 'Out for delivery', 'Your order is on its way'],
  completed: ['ok', 'Completed', 'Your order is complete'],
  cancelled: ['bad', 'Cancelled', 'This order was cancelled'],
  refunded: ['bad', 'Refunded', 'This order was refunded'],
  expired: ['bad', 'Expired', 'This order was not paid in time']
};

function params() {
  const p = new URLSearchParams(location.search);
  let ref = (p.get('ref') || '').trim().toUpperCase(), token = (p.get('token') || '').trim();
  if (!token || !ref) {
    try {
      const last = JSON.parse(sessionStorage.getItem('os.lastOrder'));
      if (last && (!ref || last.ref === ref)) { ref = last.ref; token = token || last.token; }
    } catch (e) { /* ignore */ }
  }
  return { ref, token };
}

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function nextSteps(o) {
  const r = o.collection && o.collection.roaster;
  const place = r ? r.name + ', ' + r.area + ' ' + r.postcode : 'the roastery';
  const keep = 'Keep the link to this page. It is how you check on your order, and no email has been sent.';
  const collect = o.fulfilment === 'collect';
  switch (o.status) {
    case 'pending_payment': return ['Complete your payment to confirm the order.', 'The coffee is held for you until ' + (when(o.expires_at) || 'the payment window closes') + '. After that the order expires and nothing is charged.'];
    case 'paid': return collect
      ? ['The roaster has your order and will pack it.', 'Wait until this page says “Ready to collect” before you set off.', 'Then collect it from ' + place + (r && r.collection_hours ? ' (' + r.collection_hours + ').' : '.'), 'Bring your order reference, ' + o.ref + '.', keep]
      : ['The roaster has your order and will pack it.', 'This page will say “Out for delivery” when it leaves the roastery.', 'It will be delivered to the address below.', keep];
    case 'preparing': return collect
      ? ['Your coffee is being packed.', 'Wait until this page says “Ready to collect” before you set off.', 'Collection is from ' + place + (r && r.collection_hours ? ' (' + r.collection_hours + ').' : '.'), keep]
      : ['Your coffee is being packed.', 'This page will say “Out for delivery” when it leaves the roastery.', keep];
    case 'ready_for_collection': return ['Collect your order from ' + place + '.', r && r.collection_hours ? 'Collection hours: ' + r.collection_hours + '.' : null, 'Bring your order reference, ' + o.ref + '.'].filter(Boolean);
    case 'out_for_delivery': return ['Your order has left the roastery and is on its way to the address below.', 'If you left delivery notes, the courier has them.'];
    case 'completed': return [collect ? 'This order has been collected.' : 'This order has been delivered.', 'Enjoy the coffee.'];
    case 'cancelled': return ['This order will not be sent or held for collection.', o.paid_at ? 'If you paid, see the contact page to ask about a refund.' : 'You have not been charged.', 'Your basket is as you left it if you would like to try again.'];
    case 'refunded': return ['This order has been refunded. Refunds can take a few days to reach your account.'];
    case 'expired': return ['Payment was not completed within the time limit, so the coffee went back on the shelf.', 'You have not been charged.', 'Your basket is as you left it if you would like to try again.'];
    default: return [];
  }
}

function tracker(o) {
  if (!PAID_ISH.includes(o.status) && o.status !== 'pending_payment') return null;
  const collect = o.fulfilment === 'collect';
  const steps = [['paid', 'Order paid'], ['preparing', 'Being packed'], collect ? ['ready_for_collection', 'Ready to collect'] : ['out_for_delivery', 'Out for delivery'], ['completed', collect ? 'Collected' : 'Delivered']];
  const at = steps.findIndex((s) => s[0] === o.status);
  return h('ol', { class: 'track', 'aria-label': 'Order progress' }, steps.map(([key, label], i) => {
    const cls = i < at || o.status === 'completed' ? 'is-done' : i === at ? 'is-now' : '';
    const word = cls === 'is-done' ? 'Done' : cls === 'is-now' ? 'Now' : 'Not yet';
    return h('li', { class: cls }, h('span', { class: 'dot', 'aria-hidden': 'true', text: cls === 'is-done' ? '✓' : cls === 'is-now' ? '●' : '' }), h('span', null, label + ' ', h('small', { text: '(' + word.toLowerCase() + ')' })));
  }));
}

function render(o) {
  const st = STATUS[o.status] || ['wait', o.status, 'Your order'];
  document.title = 'Order ' + o.ref + ' | One Shelf';
  const collect = o.fulfilment === 'collect';
  const r = o.collection && o.collection.roaster;
  const d = o.delivery;

  const items = o.items.map((l) => h('li', { class: 'sum-line' },
    h('span', { class: 'swatch', 'aria-hidden': 'true' }),
    h('div', { class: 'bline-info' },
      h('span', { class: 'bline-name', text: l.name }),
      h('span', { class: 'bline-meta', text: l.roaster_name + ' · ' + l.grind }),
      h('span', { class: 'bline-meta', text: l.quantity + ' × ' + money(l.unit_price_pence) })),
    h('span', { class: 'amount', text: money(l.line_total_pence) })));

  const where = collect
    ? h('section', { class: 'block' }, h('h2', { text: 'Collection' }),
      r ? h('dl', { class: 'kv' },
        h('dt', { text: 'Roastery' }), h('dd', { text: r.name }),
        h('dt', { text: 'Where' }), h('dd', { text: r.area + ', ' + r.postcode }),
        r.collection_hours ? h('dt', { text: 'Hours' }) : null, r.collection_hours ? h('dd', { text: r.collection_hours }) : null) : h('p', { text: 'Collect from the roastery.' }))
    : h('section', { class: 'block' }, h('h2', { text: 'Delivery' }),
      d ? h('dl', { class: 'kv' },
        h('dt', { text: 'Address' }), h('dd', { text: [d.address_line1, d.address_line2, d.city, d.postcode].filter(Boolean).join(', ') }),
        d.delivery_notes ? h('dt', { text: 'Notes' }) : null, d.delivery_notes ? h('dd', { text: d.delivery_notes }) : null) : null);

  const actions = [];
  if (o.status === 'pending_payment' && o.payment_url) {
    let href = null;
    try { const u = new URL(o.payment_url, location.origin); if (u.protocol === 'https:' || u.protocol === 'http:') href = u.href; } catch (e) { href = null; }
    if (href) actions.push(h('a', { class: 'btn btn--primary btn--big', href, text: 'Complete payment' }));
  }
  if (['cancelled', 'expired'].includes(o.status) && !basket.isEmpty()) actions.push(h('a', { class: 'btn btn--primary', href: '/checkout.html', text: 'Try checkout again' }));
  actions.push(h('a', { class: 'btn btn--ghost', href: '/#market', text: 'Back to the shop' }));

  clear(root).append(
    h('div', { class: 'order-head' },
      h('span', { class: 'badge badge--' + st[0], id: 'order-status', data: { status: o.status } }, st[0] === 'ok' ? h('span', { 'aria-hidden': 'true', text: '✓' }) : null, 'Status: ' + st[1]),
      h('h1', { class: 'h-display', id: 'order-title', tabindex: '-1', text: st[2] }),
      h('p', { class: 'order-ref' }, 'Order reference ', h('b', { class: 'tnum', id: 'order-ref', text: o.ref }), ' · placed ' + when(o.created_at)),
      o.payment_mode === 'demo' ? h('p', { class: 'small muted', text: 'This is a demo order: no money was taken and no coffee will be sent.' }) : null,
      o.status === 'pending_payment' ? h('p', { class: 'small', role: 'status', id: 'order-poll', text: polls < 20 ? 'Checking for your payment…' : 'We have not seen a payment yet. If you have paid, refresh this page in a minute.' }) : null),
    h('div', { class: 'order-grid' },
      h('div', { class: 'order-col' },
        h('section', { class: 'block' }, h('h2', { text: 'What happens next' }), h('ul', { class: 'next' }, nextSteps(o).map((t) => h('li', { text: t }))), tracker(o)),
        where,
        h('div', { class: 'actions' }, actions)),
      h('div', { class: 'order-col' },
        h('section', { class: 'summary', 'aria-label': 'Order summary' },
          h('h2', { text: 'Your order' }),
          h('ul', { class: 'sum-lines' }, items),
          h('dl', { class: 'totals' },
            h('div', null, h('dt', { text: 'Subtotal' }), h('dd', { text: money(o.subtotal_pence) })),
            h('div', null, h('dt', { text: collect ? 'Collection' : 'Delivery' }), h('dd', { text: collect ? 'Free' : money(o.delivery_fee_pence) })),
            h('div', { class: 'grand' }, h('dt', { text: PAID_ISH.includes(o.status) ? 'Total paid' : 'Total' }), h('dd', { id: 'order-total', text: money(o.total_pence) })))),
        h('section', { class: 'block' }, h('h2', { text: 'Your details' }),
          h('dl', { class: 'kv' },
            h('dt', { text: 'Name' }), h('dd', { text: o.customer.name }),
            h('dt', { text: 'Email' }), h('dd', { text: o.customer.email }),
            h('dt', { text: 'Phone' }), h('dd', { text: o.customer.phone }))))));
  root.setAttribute('aria-busy', 'false');
}

function notFound() {
  document.title = 'Order not found | One Shelf';
  clear(root).append(h('div', { class: 'state fade-in' },
    h('h1', { class: 'h-display', text: 'We could not find that order' }),
    h('p', { class: 'muted', text: 'The link may be incomplete or mistyped. Order pages only open with the full link you were sent to after paying, which includes a private key.' }),
    h('p', { class: 'muted', text: 'If you have just paid, go back to the tab you paid in. Otherwise the contact page explains how to reach us.' }),
    h('div', { class: 'actions' }, h('a', { class: 'btn btn--primary', href: '/#market', text: 'Back to the shop' }), h('a', { class: 'btn btn--ghost', href: '/contact.html', text: 'Contact' }))));
  root.setAttribute('aria-busy', 'false');
}

function settle(o) {
  if (!PAID_ISH.includes(o.status)) return;
  try {
    const pending = JSON.parse(localStorage.getItem('os.pendingOrder'));
    if (pending && pending.ref === o.ref) {
      basket.clear();
      localStorage.removeItem('os.pendingOrder');
      sessionStorage.removeItem('os.checkout.form');
    }
  } catch (e) { /* ignore */ }
}

async function load(first) {
  const { ref, token } = params();
  if (!ref || !token) { notFound(); return; }
  try {
    const { order } = await api.order(ref, token);
    settle(order);
    render(order);
    clearTimeout(pollTimer);
    if (order.status === 'pending_payment' && polls < 20) { polls++; pollTimer = setTimeout(() => load(false), 3000); }
  } catch (err) {
    if (err.status === 404) { notFound(); return; }
    if (!first) { pollTimer = setTimeout(() => load(false), 5000); return; }
    clear(root).append(errorState(err.message || 'We could not load your order.', () => load(true)));
    root.setAttribute('aria-busy', 'false');
  }
}

initSite();
load(true);
