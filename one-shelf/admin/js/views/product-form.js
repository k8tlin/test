import * as api from '../api.js'
import { h, loadInto, formatPence, penceToInput, parsePounds, parseWhole, statusBadge, field, input, select, busy, confirmDialog, announce, alertError, reportError, clearFieldErrors, showFieldErrors, showFormError, imagePicker, emptyState } from '../ui.js'
import { archiveDialog } from './products.js'

const FLAVOURS = [['acidity', 'Acidity'], ['sweetness', 'Sweetness'], ['body', 'Body'], ['fruit', 'Fruit'], ['floral', 'Floral'], ['roast', 'Roast']]
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

/** Mirrors the API's text rules so most mistakes are caught before sending. */
function checkText (errors, key, value, max, label, { required = false, singleLine = false } = {}) {
  if (required && value.length === 0) errors[key] = `${label} is required`
  else if (value.length > max) errors[key] = `${label} must be at most ${max} characters`
  else if (CONTROL.test(value)) errors[key] = `${label} contains characters that are not allowed`
  else if (singleLine && /[\r\n]/.test(value)) errors[key] = `${label} must be a single line`
}

export function productFormView (root, { params, query, navigate, setTitle, setDirtyCheck }) {
  const isNew = params[0] === 'new'
  const body = h('div')
  root.append(h('p', { class: 'back' }, h('a', { href: '#/products', text: '← All products' })), body)

  const load = async () => {
    const [roasters, product] = await Promise.all([
      api.get('/api/admin/roasters'),
      isNew ? null : api.get(`/api/admin/products/${params[0]}`)
    ])
    return { roasters: roasters.roasters, product: product ? product.product : null }
  }

  function render ({ roasters, product }) {
    const p = product || {}
    setTitle(isNew ? 'Add product' : `Edit ${p.name}`)
    if (roasters.length === 0) {
      body.replaceChildren(h('h1', { text: 'Add product', tabindex: '-1' }), emptyState('Add a roaster first: every coffee belongs to one.', h('a', { class: 'btn btn-primary', href: '#/roasters/new', text: 'Add roaster' })))
      return
    }
    const archived = p.status === 'archived'

    const c = {
      name: input({ value: p.name || '', maxlength: '100', required: true }),
      roaster_id: select([['', 'Choose a roaster'], ...roasters.map(r => [r.id, r.active ? r.name : `${r.name} (inactive)`])], p.roaster_id || query.get('roaster_id') || '', { required: true }),
      slug: input({ value: p.slug || '', maxlength: '80', spellcheck: 'false', autocapitalize: 'none' }),
      origin_country: input({ value: p.origin_country || '', maxlength: '60', required: true }),
      origin_region: input({ value: p.origin_region || '', maxlength: '80' }),
      process: input({ value: p.process || '', maxlength: '60' }),
      varietal: input({ value: p.varietal || '', maxlength: '80' }),
      altitude_m: input({ type: 'number', value: p.altitude_m ?? '', min: '0', max: '6000', step: '1', inputmode: 'numeric' }),
      roast_level: select([['', 'Choose a roast level'], [1, '1 · Lightest'], [2, '2 · Light'], [3, '3 · Medium'], [4, '4 · Dark'], [5, '5 · Darkest']], p.roast_level || '', { required: true }),
      brew: select([['', 'Choose a brew method'], ['espresso', 'Espresso'], ['filter', 'Filter'], ['both', 'Both']], p.brew || '', { required: true }),
      notes: [0, 1, 2].map(i => input({ value: (p.notes && p.notes[i]) || '', maxlength: '30', required: true })),
      flavour: Object.fromEntries(FLAVOURS.map(([key]) => [key, input({ type: 'number', value: p.flavour ? p.flavour[key] : '', min: '0', max: '10', step: '1', inputmode: 'numeric', required: true })])),
      weight_g: input({ type: 'number', value: p.weight_g ?? 250, min: '50', max: '5000', step: '1', inputmode: 'numeric', required: true }),
      price: input({ value: Number.isInteger(p.price_pence) ? penceToInput(p.price_pence) : '', inputmode: 'decimal', required: true, class: 'input-money' }),
      stock: input({ type: 'number', value: p.stock ?? 0, min: '0', max: '100000', step: '1', inputmode: 'numeric', required: true }),
      tint: input({ type: 'color', value: /^#[0-9a-fA-F]{6}$/.test(p.tint || '') ? p.tint : '#9A765F' }),
      status: archived
        ? select([['archived', 'Archived']], 'archived', { disabled: true })
        : select([['draft', 'Draft (hidden from the shop)'], ['active', 'Active (on sale in the shop)']], p.status || 'draft')
    }

    const tintValue = h('output', { class: 'colour-value', text: c.tint.value.toUpperCase() })
    c.tint.addEventListener('input', () => { tintValue.textContent = c.tint.value.toUpperCase() })

    const picker = imagePicker({
      label: 'Product photo',
      currentUrl: p.image_url || null,
      pendingNote: 'The photo is uploaded when you press "Create product".',
      onUpload: isNew
        ? null
        : async (file) => {
            const result = await api.upload(`/api/admin/products/${p.id}/image`, file)
            p.version = result.product.version
            p.image_url = result.product.image_url
            return result.product.image_url
          }
    })

    const form = h('form', { class: 'record-form', novalidate: true, 'aria-label': isNew ? 'Add product' : 'Edit product' },
      h('fieldset', null, h('legend', { text: 'The coffee' }),
        h('div', { class: 'grid' },
          field({ key: 'name', label: 'Name', control: c.name, hint: 'Up to 100 characters.' }),
          field({ key: 'roaster_id', label: 'Roaster', control: c.roaster_id }),
          field({ key: 'origin_country', label: 'Origin country', control: c.origin_country }),
          field({ key: 'origin_region', label: 'Origin region (optional)', control: c.origin_region }),
          field({ key: 'process', label: 'Process (optional)', control: c.process, hint: 'For example Washed or Natural.' }),
          field({ key: 'varietal', label: 'Varietal (optional)', control: c.varietal }),
          field({ key: 'altitude_m', label: 'Altitude in metres (optional)', control: c.altitude_m, hint: 'Whole number from 0 to 6000.' }),
          field({ key: 'slug', label: isNew ? 'Web address name (optional)' : 'Web address name', control: c.slug, hint: isNew ? 'Lowercase letters, numbers and hyphens. Leave empty to make it from the name.' : 'Lowercase letters, numbers and hyphens. Changing it breaks old links.' }))),

      h('fieldset', null, h('legend', { text: 'Taste' }),
        h('div', { class: 'grid' },
          field({ key: 'roast_level', label: 'Roast level', control: c.roast_level }),
          field({ key: 'brew', label: 'Best brewed as', control: c.brew })),
        h('div', { class: 'grid grid-3', role: 'group', 'aria-label': 'Three tasting notes' },
          c.notes.map((control, i) => field({ key: `notes.${i}`, label: `Tasting note ${i + 1}`, control, hint: i === 0 ? 'Exactly three, up to 30 characters each.' : null }))),
        h('div', { class: 'grid grid-6', role: 'group', 'aria-label': 'Flavour scores from 0 to 10' },
          FLAVOURS.map(([key, label]) => field({ key: `flavour.${key}`, label: `${label} (0 to 10)`, control: c.flavour[key] })))),

      h('fieldset', null, h('legend', { text: 'Selling' }),
        h('div', { class: 'grid' },
          field({ key: 'price_pence', label: 'Price in pounds (£)', control: c.price, hint: 'For example 12.50. Up to £1,000.00.' }),
          field({ key: 'weight_g', label: 'Bag weight in grams', control: c.weight_g, hint: 'From 50 to 5000.' }),
          field({ key: 'stock', label: 'Bags in stock', control: c.stock, hint: 'Whole number from 0 to 100000.' }),
          field({ key: 'status', label: 'Status', control: c.status, hint: archived ? 'This product is archived. Restore it to change its status.' : 'Only active products can be bought.' }))),

      h('fieldset', null, h('legend', { text: 'Look' }),
        h('div', { class: 'grid' },
          h('div', { class: 'colour-field' }, field({ key: 'tint', label: 'Tint colour', control: c.tint, hint: 'Used to draw the bag when there is no photo.' }), tintValue)),
        picker.element))

    const save = h('button', { type: 'submit', class: 'btn btn-primary', text: isNew ? 'Create product' : 'Save changes' })
    const footer = h('div', { class: 'form-actions' }, save, h('a', { class: 'btn', href: '#/products', text: 'Cancel' }))
    form.append(footer)

    const rawState = () => JSON.stringify([c.name.value, c.roaster_id.value, c.slug.value, c.origin_country.value, c.origin_region.value, c.process.value, c.varietal.value,
      c.altitude_m.value, c.roast_level.value, c.brew.value, c.notes.map(n => n.value), FLAVOURS.map(([k]) => c.flavour[k].value), c.weight_g.value, c.price.value, c.stock.value, c.tint.value.toLowerCase(), c.status.value])
    let savedState = rawState()
    let leaving = false
    setDirtyCheck(() => !leaving && form.isConnected && (rawState() !== savedState || (isNew && Boolean(picker.file))))

    function collect () {
      const errors = {}
      const values = {}
      const text = (key, control, max, label, options) => { values[key] = control.value.trim(); checkText(errors, key, values[key], max, label, options) }
      text('name', c.name, 100, 'Name', { required: true, singleLine: true })
      text('origin_country', c.origin_country, 60, 'Country', { required: true, singleLine: true })
      text('origin_region', c.origin_region, 80, 'Region')
      text('process', c.process, 60, 'Process')
      text('varietal', c.varietal, 80, 'Varietal')

      values.roaster_id = parseWhole(c.roaster_id.value)
      if (!values.roaster_id) errors.roaster_id = 'Choose a roaster'

      const slug = c.slug.value.trim().toLowerCase()
      if (slug) {
        if (slug.length > 80) errors.slug = 'Too long'
        else if (!SLUG.test(slug)) errors.slug = 'Use lowercase letters, numbers and hyphens only'
        else values.slug = slug
      } else if (!isNew) errors.slug = 'Required'

      if (c.altitude_m.value.trim() === '' && !c.altitude_m.validity.badInput) values.altitude_m = null
      else {
        values.altitude_m = parseWhole(c.altitude_m.value)
        if (values.altitude_m === null) errors.altitude_m = 'Enter metres as a whole number'
        else if (values.altitude_m > 6000) errors.altitude_m = 'Altitude looks too high'
      }

      values.roast_level = parseWhole(c.roast_level.value)
      if (!values.roast_level || values.roast_level > 5) errors.roast_level = 'Choose a roast level from 1 to 5'
      values.brew = c.brew.value
      if (!['espresso', 'filter', 'both'].includes(values.brew)) errors.brew = 'Choose espresso, filter or both'

      values.notes = c.notes.map((control, i) => {
        const note = control.value.trim()
        checkText(errors, `notes.${i}`, note, 30, 'Tasting note', { required: true, singleLine: true })
        return note
      })

      values.flavour = {}
      for (const [key] of FLAVOURS) {
        const score = parseWhole(c.flavour[key].value)
        if (score === null) errors[`flavour.${key}`] = 'Enter a whole number from 0 to 10'
        else if (score > 10) errors[`flavour.${key}`] = 'Maximum is 10'
        values.flavour[key] = score
      }

      values.weight_g = parseWhole(c.weight_g.value)
      if (values.weight_g === null) errors.weight_g = 'Enter the bag weight in grams'
      else if (values.weight_g < 50) errors.weight_g = 'Minimum is 50 g'
      else if (values.weight_g > 5000) errors.weight_g = 'Maximum is 5000 g'

      values.price_pence = parsePounds(c.price.value)
      if (values.price_pence === null) errors.price_pence = 'Enter a price in pounds and pence, like 12.50'
      else if (values.price_pence > 100000) errors.price_pence = 'Too large: the highest price allowed is £1,000.00'

      values.stock = parseWhole(c.stock.value)
      if (values.stock === null) errors.stock = 'Enter the stock as a whole number'
      else if (values.stock > 100000) errors.stock = 'Too large'

      values.tint = c.tint.value.toUpperCase()
      if (!archived) values.status = c.status.value
      return { values, errors }
    }

    async function confirmPrice (newPence) {
      if (isNew || !Number.isInteger(p.price_pence) || newPence === p.price_pence) return true
      if (Math.abs(newPence - p.price_pence) * 2 <= p.price_pence) return true
      return confirmDialog({
        title: 'Check the new price',
        body: [
          h('dl', { class: 'price-compare' },
            h('div', null, h('dt', { text: 'Saved price' }), h('dd', { id: 'price-old', text: formatPence(p.price_pence) })),
            h('div', null, h('dt', { text: 'New price' }), h('dd', { id: 'price-new', text: formatPence(newPence) }))),
          `That is ${newPence > p.price_pence ? 'an increase' : 'a cut'} of more than 50%. Customers will see the new price straight away. Is it right?`
        ],
        confirmLabel: `Yes, change to ${formatPence(newPence)}`,
        cancelLabel: 'Go back and check'
      })
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (save.disabled) return
      clearFieldErrors(form)
      const { values, errors } = collect()
      if (Object.keys(errors).length) {
        showFieldErrors(form, errors)
        return
      }
      if (!(await confirmPrice(values.price_pence))) { c.price.focus(); return }
      busy(save, isNew ? 'Creating…' : 'Saving…', async () => {
        try {
          if (isNew) {
            const created = (await api.post('/api/admin/products', values)).product
            leaving = true
            let uploadError = null
            if (picker.file) {
              save.textContent = 'Uploading photo…'
              try { await api.upload(`/api/admin/products/${created.id}/image`, picker.file) } catch (err) { uploadError = err }
            }
            navigate(`#/products/${created.id}`, { replace: true })
            if (uploadError && uploadError.code !== 'unauthorized') alertError(`${created.name} was created, but the photo was not saved: ${uploadError.message} Choose a photo below to try again.`)
            else announce(`${created.name} created as ${created.status === 'active' ? 'active: it is now in the shop' : 'a draft'}.`)
          } else {
            const result = await api.patch(`/api/admin/products/${p.id}`, { ...values, version: p.version })
            render({ roasters, product: result.product })
            announce('Changes saved.')
          }
        } catch (error) {
          if (error.code === 'stale_version' && !isNew) {
            try {
              const latest = (await api.get(`/api/admin/products/${p.id}`)).product
              Object.assign(p, latest)
              alertError(`Someone else changed this product while you were editing it (its saved price is now ${formatPence(latest.price_pence)}, stock ${latest.stock}, status ${latest.status}). Your edits are still in the form but have not been saved. Check them, then press Save again to apply them over the latest version.`)
            } catch (reloadError) { reportError(reloadError) }
          } else if (error.code === 'invalid_transition') alertError(error.message)
          else showFormError(form, error)
        }
      })
    })

    // ---- archive / restore -------------------------------------------------
    let lifecycle = null
    if (!isNew) {
      const button = archived
        ? h('button', { type: 'button', class: 'btn', text: 'Restore product' })
        : h('button', { type: 'button', class: 'btn btn-danger-outline', text: 'Archive product…' })
      button.addEventListener('click', async () => {
        if (rawState() !== savedState) { alertError('Save or undo your changes first, then try again.'); return }
        if (!archived && !(await archiveDialog(p))) return
        busy(button, archived ? 'Restoring…' : 'Archiving…', async () => {
          try {
            const result = await api.post(`/api/admin/products/${p.id}/${archived ? 'restore' : 'archive'}`, { version: p.version })
            render({ roasters, product: result.product })
            announce(archived ? 'Restored as a draft. Set the status to active and save to put it back in the shop.' : 'Archived. It is no longer in the shop.')
          } catch (error) {
            if (error.code === 'stale_version' || error.code === 'invalid_transition') {
              try {
                render({ roasters, product: (await api.get(`/api/admin/products/${p.id}`)).product })
                alertError(`${error.message} The product has been reloaded.`)
              } catch (reloadError) { reportError(reloadError) }
            } else reportError(error)
          }
        })
      })
      lifecycle = h('section', { class: 'panel panel-quiet', 'aria-labelledby': 'p-life' },
        h('h2', { id: 'p-life', text: archived ? 'Restore' : 'Archive' }),
        h('p', { class: 'section-note', text: archived ? 'Restoring brings the product back as a draft. Nothing is on sale until you set it to active.' : 'Archiving takes the product out of the shop but keeps it for old orders. You can restore it later.' }),
        button)
    }

    body.replaceChildren(
      h('div', { class: 'page-header' },
        h('h1', { text: isNew ? 'Add product' : `Edit ${p.name}`, tabindex: '-1' }),
        isNew ? null : h('p', { class: 'order-status', id: 'product-status' }, statusBadge(p.status))),
      isNew ? null : h('p', { class: 'section-note' }, h('a', { href: `#/activity?entity=product&entity_id=${p.id}`, text: 'Activity log for this product' })),
      form,
      lifecycle)
    savedState = rawState()
  }

  loadInto(body, load, render)
}
