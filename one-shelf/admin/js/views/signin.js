import * as api from '../api.js'
import { h, field, input, busy } from '../ui.js'

export function signInView (root, { query, onSignedIn }) {
  const email = input({ type: 'email', name: 'email', autocomplete: 'username', required: true, inputmode: 'email', autocapitalize: 'none', spellcheck: 'false' })
  const password = input({ type: 'password', name: 'password', autocomplete: 'current-password', required: true })
  const error = h('p', { class: 'form-error', role: 'alert', id: 'signin-error', hidden: true })
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: 'Sign in' })

  const form = h('form', { class: 'signin-form', novalidate: true, 'aria-labelledby': 'signin-title' },
    query.get('reason') === 'expired'
      ? h('p', { class: 'notice', id: 'signin-notice', text: 'You have been signed out, usually because the session ran out. Sign in again to carry on where you were.' })
      : null,
    error,
    field({ key: 'email', label: 'Email address', control: email }),
    field({ key: 'password', label: 'Password', control: password }),
    submit)

  function showError (message) {
    error.textContent = message
    error.hidden = false
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    error.hidden = true
    if (!email.value.trim()) { showError('Enter your email address.'); email.focus(); return }
    if (!password.value) { showError('Enter your password.'); password.focus(); return }
    busy(submit, 'Signing in…', async () => {
      try {
        onSignedIn(await api.signIn(email.value.trim(), password.value))
      } catch (err) {
        showError(err.message) // the API's generic message, or the rate-limit wording
        password.value = ''
        password.focus()
      }
    })
  })

  root.append(h('div', { class: 'signin-card' },
    h('p', { class: 'signin-brand', text: 'One Shelf' }),
    h('h1', { id: 'signin-title', text: 'Sign in to admin', tabindex: '-1' }),
    form))
  email.focus()
}
