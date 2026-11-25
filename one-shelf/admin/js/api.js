// All talk with the server goes through here: cookie session, CSRF header,
// one retry on a stale CSRF token, and a single place that reacts to 401.

export class ApiError extends Error {
  constructor (status, code, message, fields, retryAfter) {
    super(message)
    this.status = status
    this.code = code
    this.fields = fields || null
    this.retryAfter = retryAfter || null
  }
}

let csrfToken = null // kept in memory only, as the API contract requires
let unauthorizedHandler = () => {}

export function onUnauthorized (fn) { unauthorizedHandler = fn }

function rateLimitMessage (seconds) {
  if (!seconds || !Number.isFinite(seconds)) return 'Too many attempts. Try again later.'
  if (seconds < 90) return 'Too many attempts. Try again later, in about a minute.'
  return `Too many attempts. Try again later, in about ${Math.ceil(seconds / 60)} minutes.`
}

async function raw (method, path, body, isForm) {
  const headers = { accept: 'application/json' }
  const options = { method, credentials: 'same-origin', headers, cache: 'no-store' }
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken
  if (isForm) {
    options.body = body // the browser sets the multipart boundary itself
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  let response
  try {
    response = await fetch(path, options)
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection and try again.')
  }
  let data = null
  const type = response.headers.get('content-type') || ''
  if (type.includes('application/json')) {
    try { data = await response.json() } catch { data = null }
  } else if (response.ok) {
    data = await response.blob()
  }
  if (response.ok) return data
  const err = (data && data.error) || {}
  const retryAfter = Number(response.headers.get('retry-after')) || null
  if (response.status === 429) {
    throw new ApiError(429, 'rate_limited', rateLimitMessage(retryAfter), null, retryAfter)
  }
  throw new ApiError(response.status, err.code || 'error',
    err.message || 'Something went wrong on the server. Please try again.', err.fields, retryAfter)
}

async function request (method, path, body, isForm = false) {
  try {
    return await raw(method, path, body, isForm)
  } catch (error) {
    if (error.status === 403 && error.code === 'csrf_invalid') {
      // Documented recovery: fetch a new token and retry once.
      const me = await raw('GET', '/api/admin/me')
      csrfToken = me.csrf_token
      return await raw(method, path, body, isForm).catch(handleAuth)
    }
    return handleAuth(error)
  }
}

function handleAuth (error) {
  if (error.status === 401 && error.code !== 'invalid_credentials') {
    csrfToken = null
    error.code = 'unauthorized'
    unauthorizedHandler()
  }
  throw error
}

export const get = (path) => request('GET', path)
export const post = (path, body) => request('POST', path, body)
export const patch = (path, body) => request('PATCH', path, body)
export const put = (path, body) => request('PUT', path, body)
export const upload = (path, file) => {
  const form = new FormData()
  form.append('image', file)
  return request('POST', path, form, true)
}

/** Who am I? Also the documented way to obtain the CSRF token. Null when signed out. */
export async function loadSession () {
  try {
    const me = await raw('GET', '/api/admin/me')
    csrfToken = me.csrf_token
    return me
  } catch (error) {
    if (error.status === 401) { csrfToken = null; return null }
    throw error
  }
}

export async function signIn (email, password) {
  const result = await raw('POST', '/api/admin/login', { email, password })
  csrfToken = result.csrf_token
  // Refresh the token for the new session before anything else is sent.
  const me = await loadSession()
  return me || result
}

export async function signOut () {
  try { await request('POST', '/api/admin/logout') } finally { csrfToken = null }
}

export async function changePassword (currentPassword, newPassword) {
  const result = await request('POST', '/api/admin/password', { current_password: currentPassword, new_password: newPassword })
  csrfToken = result.csrf_token // the session was replaced
  return result
}

export function query (params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value)
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}
