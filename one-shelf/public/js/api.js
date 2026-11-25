// Thin wrapper around the One Shelf API. Every failure becomes an ApiError.

export class ApiError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields || {};
  }
}

const NETWORK_MESSAGE = 'We could not reach the shop. Check your connection and try again.';

async function request(method, path, { params, body, signal } = {}) {
  let url = path;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += '?' + s;
  }
  const init = { method, headers: { Accept: 'application/json' }, signal };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', NETWORK_MESSAGE);
  }
  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = null;
  }
  if (!res.ok) {
    const e = (data && data.error) || {};
    let message = e.message || 'Something went wrong on our side. Please try again.';
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after'));
      message = wait > 0
        ? 'Too many requests. Please wait ' + (wait > 90 ? Math.ceil(wait / 60) + ' minutes' : wait + ' seconds') + ' and try again.'
        : 'Too many requests. Please wait a moment and try again.';
    }
    throw new ApiError(res.status, e.code || 'error', message, e.fields);
  }
  return data;
}

export const api = {
  get: (path, params, signal) => request('GET', path, { params, signal }),
  post: (path, body) => request('POST', path, { body }),
  config: () => request('GET', '/api/config'),
  roasters: (postcode) => request('GET', '/api/roasters', { params: { postcode } }),
  products: (params, signal) => request('GET', '/api/products', { params, signal }),
  product: (slug, postcode) => request('GET', '/api/products/' + encodeURIComponent(slug), { params: { postcode } }),
  postcode: (value) => request('GET', '/api/postcode/' + encodeURIComponent(value)),
  quote: (body) => request('POST', '/api/basket/quote', { body }),
  checkout: (body) => request('POST', '/api/checkout', { body }),
  order: (ref, token) => request('GET', '/api/orders/' + encodeURIComponent(ref), { params: { token } }),
  consentText: () => request('GET', '/api/subscribe/consent-text'),
  subscribe: (body) => request('POST', '/api/subscribe', { body })
};
