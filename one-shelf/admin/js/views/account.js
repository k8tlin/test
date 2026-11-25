import * as api from '../api.js'
import { h, pageHeader, field, input, busy, announce, clearFieldErrors, showFieldErrors, showFormError, formatDateTime } from '../ui.js'

export function accountView (root, { session, setDirtyCheck }) {
  const current = input({ type: 'password', autocomplete: 'current-password', required: true })
  const next = input({ type: 'password', autocomplete: 'new-password', required: true, minlength: '12', maxlength: '200' })
  const again = input({ type: 'password', autocomplete: 'new-password', required: true, maxlength: '200' })
  const save = h('button', { type: 'submit', class: 'btn btn-primary', text: 'Change password' })
  const form = h('form', { class: 'narrow-form', novalidate: true, 'aria-labelledby': 'acc-password' },
    // Lets password managers attach the new password to the right account.
    h('input', { type: 'text', hidden: true, autocomplete: 'username', value: session.admin.email, readOnly: true }),
    field({ key: 'current_password', label: 'Current password', control: current }),
    field({ key: 'new_password', label: 'New password', control: next, hint: 'At least 12 characters. Common passwords, a single repeated character and your email address are refused.' }),
    field({ key: 'confirm_password', label: 'New password again', control: again }),
    h('div', { class: 'form-actions' }, save))

  setDirtyCheck(() => form.isConnected && Boolean(current.value || next.value || again.value))

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    clearFieldErrors(form)
    const errors = {}
    if (!current.value) errors.current_password = 'Enter your current password'
    if (!next.value) errors.new_password = 'Enter a new password'
    else if (next.value.length < 12) errors.new_password = 'Use at least 12 characters.'
    else if (next.value.length > 200) errors.new_password = 'Use at most 200 characters'
    if (!errors.new_password && again.value !== next.value) errors.confirm_password = 'The two new passwords do not match'
    if (Object.keys(errors).length) { showFieldErrors(form, errors); return }
    busy(save, 'Changing…', async () => {
      try {
        await api.changePassword(current.value, next.value)
        current.value = next.value = again.value = ''
        announce('Password changed. Any other devices signed in to this account have been signed out.')
      } catch (error) {
        showFormError(form, error)
      }
    })
  })

  root.append(
    pageHeader('Account'),
    h('section', { class: 'panel', 'aria-labelledby': 'acc-you' },
      h('h2', { id: 'acc-you', text: 'Signed in' }),
      h('dl', { class: 'details' },
        h('div', { class: 'detail-row' }, h('dt', { text: 'Email' }), h('dd', { id: 'account-email', text: session.admin.email })),
        h('div', { class: 'detail-row' }, h('dt', { text: 'Last sign-in' }), h('dd', { text: formatDateTime(session.admin.last_login_at) || 'Not recorded' })),
        session.session
          ? h('div', { class: 'detail-row' }, h('dt', { text: 'Session' }), h('dd', { text: `Ends after ${session.session.idle_timeout_minutes} minutes without activity, or ${session.session.absolute_timeout_hours} hours after sign-in.` }))
          : null),
      h('p', null, h('button', { type: 'button', class: 'btn', id: 'account-signout', text: 'Sign out', on: { click: () => document.getElementById('signout-button').click() } }))),
    h('section', { class: 'panel', 'aria-labelledby': 'acc-password' },
      h('h2', { id: 'acc-password', text: 'Change password' }),
      form))
}
