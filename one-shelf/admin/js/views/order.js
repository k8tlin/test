import * as api from '../api.js'
import { h, loadInto, formatPence, statusBadge, statusLabel, table, timeEl, busy, confirmDialog, announce, alertError, reportError, clearFieldErrors, showFormError, field } from '../ui.js'
import { orderEventText, actorLabel } from '../audit-format.js'

// The documented transition table. The server's allowed_transitions wins when present.
function localTransitions (order) {
  const next = order.fulfilment === 'collect' ? 'ready_for_collection' : 'out_for_delivery'
  return ({
    pending_payment: ['cancelled'],
    paid: ['preparing', 'cancelled', 'refunded'],
    preparing: [next, 'cancelled', 'refunded'],
    ready_for_collection: ['completed', 'cancelled', 'refunded'],
    out_for_delivery: ['completed', 'cancelled', 'refunded'],
    completed: ['refunded'],
    cancelled: order.paid_at ? ['refunded'] : [],
    refunded: [],
    expired: []
  })[order.status] || []
}

const ACTIONS = {
  preparing: { label: 'Start preparing', busy: 'Saving…', done: 'Order is now being prepared.' },
  ready_for_collection: { label: 'Mark ready for collection', busy: 'Saving…', done: 'Order marked ready for collection.' },
  out_for_delivery: { label: 'Mark out for delivery', busy: 'Saving…', done: 'Order marked out for delivery.' },
  completed: { label: 'Mark completed', busy: 'Saving…', done: 'Order completed.' },
  cancelled: { label: 'Cancel order…', busy: 'Cancelling…', done: 'Order cancelled. Stock is back on the shelf.', danger: true },
  refunded: { label: 'Mark as refunded…', busy: 'Saving…', done: 'Order marked as refunded.', danger: true }
}

const NOTHING_LEFT = {
  refunded: 'This order has been refunded. Nothing more can be done to it.',
  expired: 'This order was never paid and has expired. Nothing more can be done to it.',
  cancelled: 'This order was cancelled before it was paid. Nothing more can be done to it.'
}

function confirmFor (order, target) {
  const units = order.items.reduce((sum, item) => sum + item.quantity, 0)
  const unitText = `${units} ${units === 1 ? 'item' : 'items'}`
  const total = formatPence(order.total_pence)
  if (target === 'cancelled') {
    const paid = order.status !== 'pending_payment'
    return confirmDialog({
      title: `Cancel order ${order.ref}?`,
      body: [
        `Stock for ${unitText} will be returned to the shelf. This cannot be undone.`,
        paid
          ? `Cancelling does not refund the customer. Refund ${total} at the payment provider, then mark the order as refunded.`
          : 'The customer has not paid, so there is nothing to refund.'
      ],
      confirmLabel: 'Cancel this order',
      cancelLabel: 'Keep order',
      danger: true
    })
  }
  return confirmDialog({
    title: `Mark order ${order.ref} as refunded?`,
    body: [
      `This records that ${total} has been returned to the customer. This cannot be undone.`,
      'It does not move any money: make the refund at the payment provider first.',
      order.status === 'cancelled'
        ? 'Stock was already returned to the shelf when the order was cancelled.'
        : `Stock for ${unitText} will not be returned to the shelf. To put the coffee back on sale, cancel the order first and then mark it refunded.`
    ],
    confirmLabel: 'Mark as refunded',
    cancelLabel: 'Go back',
    danger: true
  })
}

const row = (label, value) => h('div', { class: 'detail-row' }, h('dt', { text: label }), h('dd', null, value))

export function orderView (root, { params, setTitle, setDirtyCheck }) {
  const id = params[0]
  const body = h('div')
  root.append(h('p', { class: 'back' }, h('a', { href: '#/orders', text: '← All orders' })), body)

  const load = () => api.get(`/api/admin/orders/${id}`).then(data => data.order)

  async function reloadAfterConflict (error) {
    try {
      render(await load())
      alertError(error.code === 'stale_version'
        ? 'Someone else changed this order while you had it open. It has been reloaded with the latest details: check it, then try again.'
        : `${error.message} The order has been reloaded with its current status.`)
    } catch (reloadError) {
      reportError(reloadError)
    }
  }

  function render (order) {
    setTitle(`Order ${order.ref}`)
    const transitions = Array.isArray(order.allowed_transitions) ? order.allowed_transitions : localTransitions(order)

    // ---- status actions: only what the API allows from here ----------------
    const actionButtons = transitions.filter(target => ACTIONS[target]).map((target) => {
      const action = ACTIONS[target]
      const button = h('button', { type: 'button', class: action.danger ? 'btn btn-danger-outline' : 'btn btn-primary', text: action.label, data: { transition: target } })
      button.addEventListener('click', async () => {
        if (action.danger && !(await confirmFor(order, target))) return
        busy(button, action.busy, async () => {
          for (const other of actions.querySelectorAll('button')) if (other !== button) other.disabled = true
          try {
            const result = await api.post(`/api/admin/orders/${order.id}/status`, { status: target, version: order.version })
            render(result.order)
            announce(action.done)
          } catch (error) {
            for (const other of actions.querySelectorAll('button')) other.disabled = false
            if (error.code === 'stale_version' || error.code === 'invalid_transition') await reloadAfterConflict(error)
            else if (error.status === 422) alertError(error.message)
            else reportError(error)
          }
        })
      })
      return button
    })
    const actions = h('div', { class: 'action-row', id: 'status-actions' }, actionButtons)

    // ---- notes ------------------------------------------------------------
    const notes = h('textarea', { rows: '5', maxlength: '2000' })
    notes.value = order.admin_notes || ''
    const saveNotes = h('button', { type: 'submit', class: 'btn', text: 'Save notes' })
    const notesForm = h('form', { class: 'notes-form', novalidate: true },
      field({ key: 'admin_notes', label: 'Internal notes', control: notes, hint: 'Only admins see these. Up to 2000 characters.' }),
      saveNotes)
    notesForm.addEventListener('submit', (event) => {
      event.preventDefault()
      clearFieldErrors(notesForm)
      busy(saveNotes, 'Saving…', async () => {
        try {
          const result = await api.post(`/api/admin/orders/${order.id}/notes`, { admin_notes: notes.value, version: order.version })
          render(result.order)
          announce('Notes saved.')
        } catch (error) {
          if (error.code === 'stale_version') {
            const typed = notes.value
            await reloadAfterConflict(error)
            const fresh = body.querySelector('textarea')
            if (fresh) fresh.value = typed // keep what was typed so it can be saved again
          } else showFormError(notesForm, error)
        }
      })
    })
    setDirtyCheck(() => notes.isConnected && notes.value !== (order.admin_notes || ''))

    // ---- fulfilment -------------------------------------------------------
    let fulfilment
    if (order.fulfilment === 'collect') {
      const roaster = order.collection_roaster
      fulfilment = h('dl', { class: 'details' },
        row('Method', 'Collection from the roastery'),
        row('Collect from', roaster ? h('a', { href: `#/roasters/${roaster.id}`, text: `${roaster.name}, ${roaster.area}` }) : 'Roaster not recorded'))
    } else {
      const address = h('address', null,
        [order.address_line1, order.address_line2, order.city, order.postcode].filter(Boolean).map(line => h('span', { class: 'address-line', text: line })))
      fulfilment = h('dl', { class: 'details' },
        row('Method', 'Local delivery'),
        row('Deliver to', address),
        row('Delivery notes', order.delivery_notes ? h('span', { class: 'pre', text: order.delivery_notes }) : 'None'))
    }

    // ---- timeline ---------------------------------------------------------
    const events = (order.audit || []).map(entry => h('li', null,
      h('span', { class: 'timeline-what', text: orderEventText(entry) }),
      h('span', { class: 'timeline-meta' }, timeEl(entry.created_at), ' · ', actorLabel(entry))))
    events.push(h('li', null,
      h('span', { class: 'timeline-what', text: 'Order placed' }),
      h('span', { class: 'timeline-meta' }, timeEl(order.created_at), ' · Customer')))

    body.replaceChildren(
      h('div', { class: 'page-header' },
        h('h1', { tabindex: '-1' }, 'Order ', h('span', { class: 'ref', text: order.ref })),
        h('p', { class: 'order-status', id: 'order-status' }, statusBadge(order.status))),
      h('p', { class: 'section-note' }, 'Placed ', timeEl(order.created_at), order.paid_at ? [' · paid ', timeEl(order.paid_at)] : null),

      h('div', { class: 'order-grid' },
        h('div', { class: 'order-main' },
          h('section', { class: 'panel', 'aria-labelledby': 'o-next' },
            h('h2', { id: 'o-next', text: 'Next step' }),
            actionButtons.length
              ? [h('p', { class: 'section-note', text: `This order is ${statusLabel(order.status).toLowerCase()}. Choose what happens next.` }), actions]
              : h('p', { class: 'section-note', id: 'no-actions', text: NOTHING_LEFT[order.status] || 'There is nothing more to do with this order.' })),

          h('section', { 'aria-labelledby': 'o-items' },
            h('h2', { id: 'o-items', text: 'Items' }),
            table('Items in this order', ['Coffee', 'Roaster', 'Grind', { label: 'Qty', class: 'num' }, { label: 'Unit price', class: 'num' }, { label: 'Line total', class: 'num' }],
              order.items.map(item => h('tr', null,
                h('th', { scope: 'row' }, item.product_id ? h('a', { href: `#/products/${item.product_id}`, text: item.name }) : item.name),
                h('td', { text: item.roaster_name }),
                h('td', { text: item.grind }),
                h('td', { class: 'num', text: String(item.quantity) }),
                h('td', { class: 'num', text: formatPence(item.unit_price_pence) }),
                h('td', { class: 'num', text: formatPence(item.line_total_pence) })))),
            h('dl', { class: 'totals' },
              row('Subtotal', formatPence(order.subtotal_pence)),
              row(order.fulfilment === 'delivery' ? 'Delivery' : 'Collection', formatPence(order.delivery_fee_pence)),
              h('div', { class: 'detail-row total-row' }, h('dt', { text: 'Total' }), h('dd', { id: 'order-total', text: formatPence(order.total_pence) })))),

          h('section', { 'aria-labelledby': 'o-timeline' },
            h('h2', { id: 'o-timeline', text: 'Timeline' }),
            h('ol', { class: 'timeline', reversed: true }, events),
            h('p', null, h('a', { href: `#/activity?entity=order&entity_id=${order.id}`, text: 'Full activity log for this order' })))),

        h('div', { class: 'order-side' },
          h('section', { class: 'panel', 'aria-labelledby': 'o-customer' },
            h('h2', { id: 'o-customer', text: 'Customer' }),
            h('dl', { class: 'details' },
              row('Name', order.customer_name),
              row('Email', h('a', { href: `mailto:${order.email}`, text: order.email })),
              row('Phone', order.phone ? h('a', { href: `tel:${String(order.phone).replace(/[^\d+]/g, '')}`, text: order.phone }) : 'Not given'))),
          h('section', { class: 'panel', 'aria-labelledby': 'o-fulfilment' },
            h('h2', { id: 'o-fulfilment', text: 'Fulfilment' }), fulfilment),
          h('section', { class: 'panel', 'aria-labelledby': 'o-payment' },
            h('h2', { id: 'o-payment', text: 'Payment' }),
            h('dl', { class: 'details' },
              row('Provider', order.payment_provider === 'demo' ? 'Demo (no money taken)' : (order.payment_provider || 'Not recorded')),
              row('Reference', order.payment_ref ? h('span', { class: 'ref', text: order.payment_ref }) : 'None yet'),
              row('Paid', order.paid_at ? timeEl(order.paid_at) : 'Not paid'))),
          h('section', { class: 'panel', 'aria-labelledby': 'o-notes' },
            h('h2', { id: 'o-notes', text: 'Notes' }), notesForm))))
  }

  loadInto(body, load, render)
}
