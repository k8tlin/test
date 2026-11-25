// Entry point: session check, hash router, unsaved-changes guard, sign-out.
import * as api from './api.js'

// Tells boot-check.js that the app's code loaded and started.
window.__oneShelfAdminStarted = true
import { h, confirmDialog, clearMessages, announce, reportError, busy, errorState } from './ui.js'
import { signInView } from './views/signin.js'
import { dashboardView } from './views/dashboard.js'
import { ordersView } from './views/orders.js'
import { orderView } from './views/order.js'
import { productsView } from './views/products.js'
import { productFormView } from './views/product-form.js'
import { roastersView, roasterFormView } from './views/roasters.js'
import { zonesView } from './views/zones.js'
import { subscribersView } from './views/subscribers.js'
import { accountView } from './views/account.js'
import { activityView } from './views/activity.js'

const routes = [
  { pattern: /^\/$/, view: dashboardView, nav: 'dashboard', title: 'Dashboard' },
  { pattern: /^\/orders$/, view: ordersView, nav: 'orders', title: 'Orders' },
  { pattern: /^\/orders\/(\d+)$/, view: orderView, nav: 'orders', title: 'Order' },
  { pattern: /^\/products$/, view: productsView, nav: 'products', title: 'Products' },
  { pattern: /^\/products\/(new|\d+)$/, view: productFormView, nav: 'products', title: 'Product' },
  { pattern: /^\/roasters$/, view: roastersView, nav: 'roasters', title: 'Roasters' },
  { pattern: /^\/roasters\/(new|\d+)$/, view: roasterFormView, nav: 'roasters', title: 'Roaster' },
  { pattern: /^\/zones$/, view: zonesView, nav: 'zones', title: 'Delivery zones' },
  { pattern: /^\/subscribers$/, view: subscribersView, nav: 'subscribers', title: 'Subscribers' },
  { pattern: /^\/activity$/, view: activityView, nav: 'activity', title: 'Activity log' },
  { pattern: /^\/account$/, view: accountView, nav: 'account', title: 'Account' }
]

const main = document.getElementById('main')
const topbar = document.getElementById('topbar')
let session = null
let dirtyCheck = null // set by a form; returns true while it has unsaved changes
let currentHash = location.hash
let suppressNext = false
let firstRender = true

function parseHash (hash) {
  const text = (hash || '').replace(/^#/, '') || '/'
  const cut = text.indexOf('?')
  return {
    path: cut === -1 ? text : text.slice(0, cut),
    query: new URLSearchParams(cut === -1 ? '' : text.slice(cut + 1))
  }
}

function setSignedIn (me) {
  session = me
  document.body.classList.toggle('signed-out', !me)
  topbar.hidden = !me
  document.getElementById('who').textContent = me ? me.admin.email : ''
}

/** Go to a hash; re-render even when it is the hash we are already on. */
function navigate (hash, { replace = false } = {}) {
  if (location.hash === hash) { currentHash = hash; render(); return }
  if (replace) {
    history.replaceState(null, '', hash)
    currentHash = hash
    render()
  } else {
    location.hash = hash
  }
}

function goToSignIn (reason) {
  const { path } = parseHash(location.hash)
  dirtyCheck = null
  setSignedIn(null)
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close()
  if (path === '/signin') { render(); return }
  const next = location.hash.replace(/^#/, '') || '/'
  const params = new URLSearchParams()
  if (next !== '/') params.set('next', next)
  if (reason) params.set('reason', reason)
  const text = params.toString()
  navigate(`#/signin${text ? `?${text}` : ''}`, { replace: true })
}

api.onUnauthorized(() => goToSignIn('expired'))

function render () {
  const { path, query } = parseHash(location.hash)
  clearMessages()

  if (path === '/signin') {
    if (session) { navigate('#/', { replace: true }); return }
    document.title = 'Sign in · One Shelf admin'
    const root = h('div', { class: 'view view-signin' })
    main.replaceChildren(root)
    signInView(root, {
      query,
      onSignedIn (me) {
        setSignedIn(me)
        const next = query.get('next')
        navigate(next && next.startsWith('/') && !next.startsWith('/signin') ? `#${next}` : '#/', { replace: true })
      }
    })
    return
  }

  if (!session) { goToSignIn(); return }

  const route = routes.find(r => r.pattern.test(path))
  for (const link of document.querySelectorAll('#nav-list a')) {
    if (route && link.dataset.nav === route.nav) {
      link.setAttribute('aria-current', 'page')
      link.scrollIntoView({ block: 'nearest', inline: 'nearest' }) // the nav scrolls sideways on small screens
    }
    else link.removeAttribute('aria-current')
  }
  dirtyCheck = null
  const root = h('div', { class: 'view' })
  main.replaceChildren(root)
  if (!route) {
    document.title = 'Page not found · One Shelf admin'
    root.append(h('h1', { text: 'Page not found' }), errorState('There is no admin page at this address.'), h('p', null, h('a', { href: '#/', text: 'Go to the dashboard' })))
    return
  }
  document.title = `${route.title} · One Shelf admin`
  route.view(root, {
    params: route.pattern.exec(path).slice(1),
    query,
    session,
    navigate,
    setTitle (title) { document.title = `${title} · One Shelf admin` },
    setDirtyCheck (fn) { dirtyCheck = fn },
    updateSession (me) { setSignedIn(me) }
  })
  if (!firstRender) main.focus({ preventScroll: true })
  firstRender = false
  window.scrollTo(0, 0)
}

const leaveDialog = () => confirmDialog({
  title: 'Leave without saving?',
  body: 'You have changes on this page that have not been saved. If you leave now they will be lost.',
  confirmLabel: 'Leave without saving',
  cancelLabel: 'Stay on this page',
  danger: true
})

window.addEventListener('hashchange', async () => {
  if (suppressNext) { suppressNext = false; return }
  const target = location.hash
  if (dirtyCheck && dirtyCheck()) {
    suppressNext = true
    location.hash = currentHash // put the address back while we ask
    if (!(await leaveDialog())) return
    dirtyCheck = null
    location.hash = target
    return
  }
  currentHash = target
  render()
})

window.addEventListener('beforeunload', (event) => {
  if (dirtyCheck && dirtyCheck()) { event.preventDefault(); event.returnValue = '' }
})

const signOutButton = document.getElementById('signout-button')
signOutButton.addEventListener('click', async () => {
  if (dirtyCheck && dirtyCheck() && !(await leaveDialog())) return
  dirtyCheck = null
  await busy(signOutButton, 'Signing out…', async () => {
    try {
      await api.signOut()
    } catch (error) {
      if (error.code !== 'unauthorized') { reportError(error); return }
    }
    setSignedIn(null)
    navigate('#/signin', { replace: true })
    announce('You have signed out.')
  })
})

document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault() // the hash is the router's; move focus without changing it
  main.focus()
})

async function start () {
  try {
    setSignedIn(await api.loadSession())
  } catch (error) {
    main.replaceChildren(h('div', { class: 'view' }, h('h1', { text: 'One Shelf admin' }), errorState(error.message, start)))
    return
  }
  render()
}
start()
