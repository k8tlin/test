import * as api from '../api.js'
import { h, loadInto, pageHeader, statusBadge, table, emptyState, field, input, busy, confirmDialog, announce, alertError, reportError, clearFieldErrors, showFieldErrors, showFormError, imagePicker } from '../ui.js'
import { thumb } from './products.js'

const HEX = /^#[0-9a-fA-F]{6}$/
const UK_POSTCODE = /^[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}$/
const UK_OUTWARD = /^[A-Z]{1,2}[0-9][A-Z0-9]?$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

function deactivateDialog (roaster) {
  const count = roaster.active_products
  return confirmDialog({
    title: `Deactivate ${roaster.name}?`,
    body: [
      Number.isInteger(count)
        ? `${roaster.name} and ${count === 1 ? 'its 1 active coffee' : `all ${count} of its active coffees`} will disappear from the shop straight away.`
        : `${roaster.name} and all of its coffees will disappear from the shop straight away.`,
      'Nothing is deleted. You can reactivate the roaster later and its coffees come back.'
    ],
    confirmLabel: 'Deactivate roaster',
    cancelLabel: 'Keep roaster active',
    danger: true
  })
}
function reactivateDialog (roaster) {
  return confirmDialog({
    title: `Reactivate ${roaster.name}?`,
    body: `${roaster.name} and its active coffees will be back in the shop straight away.`,
    confirmLabel: 'Reactivate roaster',
    cancelLabel: 'Leave inactive'
  })
}

async function toggleActive (roaster, button, onDone, onConflict) {
  const deactivating = roaster.active
  if (!(await (deactivating ? deactivateDialog(roaster) : reactivateDialog(roaster)))) return
  await busy(button, deactivating ? 'Deactivating…' : 'Reactivating…', async () => {
    try {
      const result = await api.post(`/api/admin/roasters/${roaster.id}/${deactivating ? 'deactivate' : 'reactivate'}`, { version: roaster.version })
      await onDone(result.roaster)
      announce(deactivating ? `${roaster.name} deactivated. It is no longer in the shop.` : `${roaster.name} reactivated. It is back in the shop.`)
    } catch (error) {
      if (error.code === 'stale_version') {
        await onConflict()
        alertError(`${error.message} The latest version has been loaded.`)
      } else reportError(error)
    }
  })
}

export function roastersView (root) {
  const body = h('div')
  root.append(pageHeader('Roasters', h('a', { class: 'btn btn-primary', href: '#/roasters/new', text: 'Add roaster' })), body)
  const load = () => api.get('/api/admin/roasters').then(data => data.roasters)
  const refresh = () => loadInto(body, load, render)

  function render (roasters) {
    if (roasters.length === 0) {
      body.append(emptyState('No roasters yet. Add the first one, then add its coffees.', h('a', { class: 'btn btn-primary', href: '#/roasters/new', text: 'Add roaster' })))
      return
    }
    body.append(
      h('p', { class: 'result-count', text: `${roasters.length} ${roasters.length === 1 ? 'roaster' : 'roasters'}` }),
      table('Roasters', [{ label: 'Image', class: 'cell-thumb' }, 'Name', 'Area', 'Collection', { label: 'Active coffees', class: 'num' }, 'Status', 'Actions'],
        roasters.map((roaster) => {
          const toggle = h('button', { type: 'button', class: roaster.active ? 'btn btn-small btn-danger-outline' : 'btn btn-small', text: roaster.active ? 'Deactivate' : 'Reactivate', 'aria-label': `${roaster.active ? 'Deactivate' : 'Reactivate'} ${roaster.name}` })
          toggle.addEventListener('click', () => toggleActive(roaster, toggle, refresh, refresh))
          return h('tr', { data: { roasterId: String(roaster.id) } },
            h('td', { class: 'cell-thumb' }, thumb(roaster, 'roaster')),
            h('th', { scope: 'row' }, h('a', { href: `#/roasters/${roaster.id}`, text: roaster.name })),
            h('td', null, h('span', { class: 'cell-main', text: roaster.area }), h('span', { class: 'cell-sub', text: roaster.postcode })),
            h('td', null, roaster.collection_enabled ? h('span', { class: 'cell-main', text: 'Yes' }) : 'No', roaster.collection_enabled && roaster.collection_hours ? h('span', { class: 'cell-sub', text: roaster.collection_hours }) : null),
            h('td', { class: 'num' }, h('a', { href: `#/products?roaster_id=${roaster.id}&status=active`, text: String(roaster.active_products ?? 0), 'aria-label': `${roaster.active_products ?? 0} active coffees from ${roaster.name}` })),
            h('td', null, statusBadge(roaster.active ? 'active' : 'inactive')),
            h('td', { class: 'cell-actions' }, h('a', { class: 'btn btn-small', href: `#/roasters/${roaster.id}`, text: 'Edit', 'aria-label': `Edit ${roaster.name}` }), toggle))
        })))
  }
  refresh()
}

export function roasterFormView (root, { params, navigate, setTitle, setDirtyCheck }) {
  const isNew = params[0] === 'new'
  const body = h('div')
  root.append(h('p', { class: 'back' }, h('a', { href: '#/roasters', text: '← All roasters' })), body)
  const load = () => isNew ? Promise.resolve(null) : api.get(`/api/admin/roasters/${params[0]}`).then(data => data.roaster)

  function render (roaster) {
    const r = roaster || { collection_enabled: true }
    setTitle(isNew ? 'Add roaster' : `Edit ${r.name}`)
    const colour = (value, fallback) => input({ type: 'color', value: HEX.test(value || '') ? value : fallback })
    const c = {
      name: input({ value: r.name || '', maxlength: '80', required: true }),
      slug: input({ value: r.slug || '', maxlength: '80', spellcheck: 'false', autocapitalize: 'none' }),
      area: input({ value: r.area || '', maxlength: '60', required: true }),
      postcode: input({ value: r.postcode || '', maxlength: '10', required: true, autocapitalize: 'characters', class: 'input-short' }),
      lat: input({ value: r.lat ?? '', inputmode: 'decimal', required: true }),
      lon: input({ value: r.lon ?? '', inputmode: 'decimal', required: true }),
      description: h('textarea', { rows: '4', maxlength: '400' }),
      bag_color: colour(r.bag_color, '#F4F1EA'),
      label_color: colour(r.label_color, '#FFFFFF'),
      label_ink: colour(r.label_ink, '#111114'),
      collection_enabled: h('input', { type: 'checkbox', id: 'collection-enabled', checked: Boolean(r.collection_enabled) }),
      collection_hours: input({ value: r.collection_hours || '', maxlength: '120' })
    }
    c.description.value = r.description || ''

    // Live preview: a small bag drawn from the three colours.
    const swatchName = h('span', { class: 'bag-label-name', text: r.name || 'Roaster name' })
    const swatch = h('div', { class: 'bag-preview', id: 'bag-preview', role: 'img', 'aria-label': 'Preview of the bag and label colours' },
      h('div', { class: 'bag-label' }, swatchName, h('span', { class: 'bag-label-sub', text: '250 g' })))
    const values = h('p', { class: 'hint', id: 'colour-values' })
    const paint = () => {
      swatch.style.setProperty('--bag', c.bag_color.value)
      swatch.style.setProperty('--label', c.label_color.value)
      swatch.style.setProperty('--ink', c.label_ink.value)
      swatchName.textContent = c.name.value.trim() || 'Roaster name'
      values.textContent = `Bag ${c.bag_color.value.toUpperCase()} · label ${c.label_color.value.toUpperCase()} · ink ${c.label_ink.value.toUpperCase()}`
    }
    for (const control of [c.bag_color, c.label_color, c.label_ink, c.name]) control.addEventListener('input', paint)
    paint()

    const picker = imagePicker({
      label: 'Roaster photo',
      currentUrl: r.image_url || null,
      pendingNote: 'The photo is uploaded when you press "Create roaster".',
      onUpload: isNew
        ? null
        : async (file) => {
            const result = await api.upload(`/api/admin/roasters/${r.id}/image`, file)
            r.version = result.roaster.version
            r.image_url = result.roaster.image_url
            return result.roaster.image_url
          }
    })

    const save = h('button', { type: 'submit', class: 'btn btn-primary', text: isNew ? 'Create roaster' : 'Save changes' })
    const form = h('form', { class: 'record-form', novalidate: true, 'aria-label': isNew ? 'Add roaster' : 'Edit roaster' },
      h('fieldset', null, h('legend', { text: 'The roaster' }),
        h('div', { class: 'grid' },
          field({ key: 'name', label: 'Name', control: c.name, hint: 'Up to 80 characters.' }),
          field({ key: 'area', label: 'Area', control: c.area, hint: 'For example Hackney.' }),
          field({ key: 'postcode', label: 'Postcode', control: c.postcode, hint: 'A district such as E8, or a full postcode such as E8 4PH.' }),
          field({ key: 'slug', label: isNew ? 'Web address name (optional)' : 'Web address name', control: c.slug, hint: 'Lowercase letters, numbers and hyphens.' }),
          field({ key: 'lat', label: 'Latitude', control: c.lat, hint: 'Between 49 and 61, for example 51.537.' }),
          field({ key: 'lon', label: 'Longitude', control: c.lon, hint: 'Between -9 and 3, for example -0.061.' }),
          field({ key: 'description', label: 'Description (optional)', control: c.description, hint: 'Up to 400 characters. Shown to customers.', wide: true }))),
      h('fieldset', null, h('legend', { text: 'Collection' }),
        h('div', { class: 'field field-check', data: { field: 'collection_enabled' } }, c.collection_enabled, h('label', { for: 'collection-enabled', text: 'Customers can collect orders from this roastery' })),
        h('div', { class: 'grid' }, field({ key: 'collection_hours', label: 'Collection hours (optional)', control: c.collection_hours, hint: 'For example Mon to Fri 9am to 4pm.' }))),
      h('fieldset', null, h('legend', { text: 'Bag colours' }),
        h('div', { class: 'colour-row' },
          h('div', { class: 'colour-inputs' },
            field({ key: 'bag_color', label: 'Bag colour', control: c.bag_color }),
            field({ key: 'label_color', label: 'Label colour', control: c.label_color }),
            field({ key: 'label_ink', label: 'Label ink (text) colour', control: c.label_ink })),
          h('div', { class: 'colour-preview' }, swatch, values))),
      h('fieldset', null, h('legend', { text: 'Photo' }), picker.element),
      h('div', { class: 'form-actions' }, save, h('a', { class: 'btn', href: '#/roasters', text: 'Cancel' })))

    const rawState = () => JSON.stringify([c.name.value, c.slug.value, c.area.value, c.postcode.value, c.lat.value, c.lon.value, c.description.value,
      c.bag_color.value, c.label_color.value, c.label_ink.value, c.collection_enabled.checked, c.collection_hours.value])
    let savedState = rawState()
    let leaving = false
    setDirtyCheck(() => !leaving && form.isConnected && (rawState() !== savedState || (isNew && Boolean(picker.file))))

    function collect () {
      const errors = {}
      const out = {}
      const text = (key, control, max, label, required) => {
        out[key] = control.value.trim()
        if (required && !out[key]) errors[key] = `${label} is required`
        else if (out[key].length > max) errors[key] = `${label} must be at most ${max} characters`
        else if (CONTROL.test(out[key])) errors[key] = `${label} contains characters that are not allowed`
      }
      text('name', c.name, 80, 'Name', true)
      text('area', c.area, 60, 'Area', true)
      text('description', c.description, 400, 'Description', false)
      text('collection_hours', c.collection_hours, 120, 'Collection hours', false)
      out.postcode = c.postcode.value.trim().toUpperCase()
      if (!out.postcode) errors.postcode = 'Enter a postcode'
      else if (!UK_POSTCODE.test(out.postcode) && !UK_OUTWARD.test(out.postcode.replace(/\s+/g, ''))) errors.postcode = 'Enter a UK postcode, like E8 or E8 4PH'
      const number = (key, control, min, max, missing) => {
        const raw = control.value.trim()
        if (!/^-?\d{1,3}(\.\d{1,10})?$/.test(raw)) { errors[key] = missing; return }
        out[key] = Number(raw)
        if (out[key] < min || out[key] > max) errors[key] = 'That is not in the UK'
      }
      number('lat', c.lat, 49, 61, 'Enter a latitude, like 51.537')
      number('lon', c.lon, -9, 3, 'Enter a longitude, like -0.061')
      const slug = c.slug.value.trim().toLowerCase()
      if (slug) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) errors.slug = 'Use lowercase letters, numbers and hyphens only'
        else out.slug = slug
      } else if (!isNew) errors.slug = 'Required'
      out.bag_color = c.bag_color.value.toUpperCase()
      out.label_color = c.label_color.value.toUpperCase()
      out.label_ink = c.label_ink.value.toUpperCase()
      out.collection_enabled = c.collection_enabled.checked
      return { values: out, errors }
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      clearFieldErrors(form)
      const { values: payload, errors } = collect()
      if (Object.keys(errors).length) {
        showFieldErrors(form, errors)
        return
      }
      busy(save, isNew ? 'Creating…' : 'Saving…', async () => {
        try {
          if (isNew) {
            const created = (await api.post('/api/admin/roasters', payload)).roaster
            leaving = true
            let uploadError = null
            if (picker.file) {
              save.textContent = 'Uploading photo…'
              try { await api.upload(`/api/admin/roasters/${created.id}/image`, picker.file) } catch (err) { uploadError = err }
            }
            navigate(`#/roasters/${created.id}`, { replace: true })
            if (uploadError && uploadError.code !== 'unauthorized') alertError(`${created.name} was created, but the photo was not saved: ${uploadError.message} Choose a photo below to try again.`)
            else announce(`${created.name} created.`)
          } else {
            const result = await api.patch(`/api/admin/roasters/${r.id}`, { ...payload, version: r.version })
            render(result.roaster)
            announce('Changes saved.')
          }
        } catch (error) {
          if (error.code === 'stale_version' && !isNew) {
            try {
              Object.assign(r, (await api.get(`/api/admin/roasters/${r.id}`)).roaster)
              alertError('Someone else changed this roaster while you were editing it. Your edits are still in the form but have not been saved. Check them, then press Save again to apply them over the latest version.')
            } catch (reloadError) { reportError(reloadError) }
          } else showFormError(form, error)
        }
      })
    })

    let lifecycle = null
    if (!isNew) {
      const button = h('button', { type: 'button', class: r.active ? 'btn btn-danger-outline' : 'btn', text: r.active ? 'Deactivate roaster…' : 'Reactivate roaster…' })
      const reload = async () => render(await load())
      button.addEventListener('click', () => {
        if (rawState() !== savedState) { alertError('Save or undo your changes first, then try again.'); return }
        toggleActive(r, button, async (updated) => render(updated), reload)
      })
      lifecycle = h('section', { class: 'panel panel-quiet', 'aria-labelledby': 'r-life' },
        h('h2', { id: 'r-life', text: r.active ? 'Deactivate' : 'Reactivate' }),
        h('p', { class: 'section-note', text: r.active ? 'Deactivating hides the roaster and all its coffees from the shop. Nothing is deleted.' : 'This roaster is inactive: it and its coffees are hidden from the shop.' }),
        button)
    }

    body.replaceChildren(
      h('div', { class: 'page-header' },
        h('h1', { text: isNew ? 'Add roaster' : `Edit ${r.name}`, tabindex: '-1' }),
        isNew ? null : h('p', { class: 'order-status', id: 'roaster-status' }, statusBadge(r.active ? 'active' : 'inactive'))),
      isNew
        ? null
        : h('p', { class: 'section-note' },
          h('a', { href: `#/products?roaster_id=${r.id}`, text: 'Coffees from this roaster' }), ' · ',
          h('a', { href: `#/activity?entity=roaster&entity_id=${r.id}`, text: 'Activity log for this roaster' })),
      form,
      lifecycle)
    savedState = rawState()
  }

  loadInto(body, load, render)
}
