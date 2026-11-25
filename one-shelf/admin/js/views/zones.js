import * as api from '../api.js'
import { h, loadInto, pageHeader, formatPence, penceToInput, parsePounds, table, emptyState, field, input, busy, confirmDialog, announce, reportError, clearFieldErrors, showFieldErrors, showFormError } from '../ui.js'

const KNOWN_AREAS = ['E', 'EC', 'N', 'NW', 'SE', 'SW', 'W', 'WC', 'TW']

function feeProblem (pence) {
  if (pence === null) return 'Enter a fee in pounds and pence, like 3.50'
  if (pence > 10000) return 'Too large: the highest fee allowed is £100.00'
  return null
}

export function zonesView (root) {
  const body = h('div')
  root.append(
    pageHeader('Delivery zones'),
    h('p', { class: 'section-note', text: 'A zone is the letters at the start of a postcode (E, SE, TW) with a delivery fee. Delivery is only offered where an active zone exists.' }),
    body)
  const load = () => api.get('/api/admin/delivery-zones').then(data => data.zones)
  const refresh = () => loadInto(body, load, render)

  function zoneRow (zone) {
    const fee = input({ value: penceToInput(zone.fee_pence), inputmode: 'decimal', class: 'input-money', 'aria-label': `Delivery fee in pounds for ${zone.postcode_prefix}` })
    const save = h('button', { type: 'submit', class: 'btn btn-small', text: 'Save fee', disabled: true, 'aria-label': `Save fee for ${zone.postcode_prefix}` })
    const error = h('p', { class: 'field-error', hidden: true })
    const feeForm = h('form', { class: 'stock-form', novalidate: true }, h('span', { class: 'money-prefix', 'aria-hidden': 'true', text: '£' }), fee, save, error)
    const setError = (message) => { error.textContent = message || ''; error.hidden = !message; if (message) fee.setAttribute('aria-invalid', 'true'); else fee.removeAttribute('aria-invalid') }
    fee.addEventListener('input', () => { save.disabled = parsePounds(fee.value) === zone.fee_pence; setError(null) })
    feeForm.addEventListener('submit', (event) => {
      event.preventDefault()
      const pence = parsePounds(fee.value)
      const problem = feeProblem(pence)
      if (problem) { setError(problem); fee.focus(); return }
      busy(save, 'Saving…', async () => {
        try {
          const result = await api.put(`/api/admin/delivery-zones/${encodeURIComponent(zone.postcode_prefix)}`, { fee_pence: pence, active: zone.active })
          Object.assign(zone, result.zone)
          fee.value = penceToInput(zone.fee_pence)
          announce(`Delivery to ${zone.postcode_prefix} now costs ${formatPence(zone.fee_pence)}.`)
        } catch (err) {
          if (err.fields && err.fields.fee_pence) setError(err.fields.fee_pence)
          else reportError(err)
        }
      }).then(() => { save.disabled = parsePounds(fee.value) === zone.fee_pence })
    })

    const toggle = h('input', { type: 'checkbox', class: 'switch', role: 'switch', id: `zone-active-${zone.postcode_prefix}`, checked: Boolean(zone.active) })
    const toggleText = h('span', { text: zone.active ? 'Delivering' : 'Off' })
    toggle.addEventListener('change', async () => {
      const turningOn = toggle.checked
      if (!turningOn) {
        const ok = await confirmDialog({
          title: `Stop delivering to ${zone.postcode_prefix} postcodes?`,
          body: [`Customers in ${zone.postcode_prefix} postcodes will no longer be offered delivery. They can still collect.`, 'You can switch it back on at any time.'],
          confirmLabel: 'Stop delivery',
          cancelLabel: 'Keep delivering',
          danger: true
        })
        if (!ok) { toggle.checked = true; return }
      }
      toggle.disabled = true
      toggleText.textContent = 'Saving…'
      try {
        const result = await api.put(`/api/admin/delivery-zones/${encodeURIComponent(zone.postcode_prefix)}`, { fee_pence: zone.fee_pence, active: turningOn })
        Object.assign(zone, result.zone)
        announce(zone.active ? `Delivery to ${zone.postcode_prefix} is switched on.` : `Delivery to ${zone.postcode_prefix} is switched off.`)
      } catch (err) {
        reportError(err)
      } finally {
        toggle.disabled = false
        toggle.checked = Boolean(zone.active)
        toggleText.textContent = zone.active ? 'Delivering' : 'Off'
      }
    })

    return h('tr', { data: { zone: zone.postcode_prefix } },
      h('th', { scope: 'row', text: zone.postcode_prefix }),
      h('td', null, feeForm),
      h('td', null, h('label', { class: 'switch-label', for: toggle.id }, toggle, h('span', { class: 'visually-hidden', text: `Deliver to ${zone.postcode_prefix} postcodes: ` }), toggleText)),
      h('td', null, h('a', { href: `#/activity?entity=delivery_zone&entity_id=${encodeURIComponent(zone.postcode_prefix)}`, text: 'History', 'aria-label': `History for zone ${zone.postcode_prefix}` })))
  }

  function render (zones) {
    const prefix = input({ maxlength: '2', autocapitalize: 'characters', class: 'input-short', required: true })
    const fee = input({ inputmode: 'decimal', class: 'input-money', required: true })
    const active = h('input', { type: 'checkbox', id: 'zone-new-active', checked: true })
    const add = h('button', { type: 'submit', class: 'btn btn-primary', text: 'Add zone' })
    const form = h('form', { class: 'inline-form', novalidate: true, 'aria-labelledby': 'zone-add' },
      field({ key: 'prefix', label: 'Postcode letters', control: prefix, hint: `One or two letters. London areas: ${KNOWN_AREAS.join(', ')}.` }),
      field({ key: 'fee_pence', label: 'Delivery fee in pounds (£)', control: fee, hint: 'For example 3.50. Up to £100.00.' }),
      h('div', { class: 'field field-check' }, active, h('label', { for: 'zone-new-active', text: 'Start delivering straight away' })),
      h('div', { class: 'filter-actions' }, add))
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      clearFieldErrors(form)
      const errors = {}
      const letters = prefix.value.trim().toUpperCase()
      if (!/^[A-Z]{1,2}$/.test(letters)) errors.prefix = 'Use the letters at the start of a postcode, like SE'
      else if (zones.some(zone => zone.postcode_prefix === letters)) errors.prefix = `There is already a zone for ${letters}. Change its fee in the table above.`
      const pence = parsePounds(fee.value)
      if (feeProblem(pence)) errors.fee_pence = feeProblem(pence)
      if (Object.keys(errors).length) { showFieldErrors(form, errors); return }
      busy(add, 'Adding…', async () => {
        try {
          await api.put(`/api/admin/delivery-zones/${encodeURIComponent(letters)}`, { fee_pence: pence, active: active.checked })
          await refresh()
          announce(`Zone ${letters} added with a ${formatPence(pence)} fee.`)
        } catch (err) { showFormError(form, err) }
      })
    })

    body.append(
      zones.length === 0
        ? emptyState('No delivery zones yet. Until you add one, customers can only collect.')
        : table('Delivery zones', ['Postcode letters', 'Delivery fee', 'Delivery', 'History'], zones.map(zoneRow)),
      h('section', { class: 'panel', 'aria-labelledby': 'zone-add' },
        h('h2', { id: 'zone-add', text: 'Add a zone' }), form))
  }
  refresh()
}
