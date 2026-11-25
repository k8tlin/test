// Entry point for the home page.

import { api } from './api.js';
import { initSite, openBasket } from './site.js';
import { initShop } from './shop.js';
import { initLabel } from './label.js';
import { initFish } from './fish.js';
import { initCherries } from './cherries.js';
import { h, $, $$, clear, store, setFieldError, setLoading, reducedMotion, EMAIL_RE } from './ui.js';

function initFlash() {
  const p = new URLSearchParams(location.search);
  const kind = p.get('newsletter');
  const openIt = p.get('basket') === 'open';
  if (kind || openIt) {
    p.delete('newsletter'); p.delete('basket');
    const qs = p.toString();
    history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  }
  if (openIt) openBasket($('#basket-btn'));
  const messages = {
    confirmed: ['ok', 'You are on the list. Thank you for confirming your email address.'],
    unsubscribed: ['ok', 'You have been unsubscribed. We will not email you again.'],
    invalid: ['warn', 'That mailing-list link did not work. It may have expired or already been used. You can sign up again at the bottom of this page.']
  };
  if (!messages[kind]) return;
  const host = $('#flash');
  const note = h('div', { class: 'notice notice--' + messages[kind][0] + ' flash fade-in', role: 'status', tabindex: '-1' },
    h('p', { text: messages[kind][1] }),
    h('button', { class: 'btn btn--ghost', type: 'button', text: 'Dismiss', on: { click: () => { clear(host); $('#pc-input').focus(); } } }));
  host.appendChild(note);
}

function initNewsletter() {
  const form = $('#ml-form');
  if (!form) return;
  const email = $('#ml-email'), consent = $('#ml-consent'), status = $('#ml-status'), btn = $('#ml-submit'), text = $('#ml-consent-text');
  let ready = false;
  const loadConsent = () => {
    consent.disabled = true; btn.disabled = true;
    text.textContent = 'Loading the consent wording…';
    api.consentText().then((res) => {
      text.textContent = res.consent_text;
      consent.disabled = false; btn.disabled = false; ready = true;
    }).catch(() => {
      clear(text).append('We could not load the sign-up form. ', h('button', { class: 'linkbtn', type: 'button', text: 'Try again', on: { click: loadConsent } }));
    });
  };
  loadConsent();

  const checkEmail = () => {
    const v = email.value.trim();
    const msg = !v ? 'Enter your email address' : !EMAIL_RE.test(v) ? 'Enter an email address like name@example.com' : '';
    setFieldError(email, msg);
    return !msg;
  };
  const checkConsent = () => {
    const msg = consent.checked ? '' : 'Tick the box to confirm you want to receive our emails';
    setFieldError(consent, msg);
    return !msg;
  };
  email.addEventListener('blur', () => { if (email.value.trim()) checkEmail(); });
  consent.addEventListener('change', () => { if (consent.checked) setFieldError(consent, ''); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!ready || btn.classList.contains('is-loading')) return;
    status.textContent = ''; status.classList.remove('is-ok');
    const okEmail = checkEmail(), okConsent = checkConsent();
    if (!okEmail) { email.focus(); return; }
    if (!okConsent) { consent.focus(); return; }
    setLoading(btn, true, 'Joining…');
    try {
      const res = await api.subscribe({ email: email.value.trim(), consent: true, source: 'home' });
      status.textContent = res.message;
      status.classList.add('is-ok');
      email.value = ''; consent.checked = false;
    } catch (err) {
      if (err.fields && err.fields.email) setFieldError(email, err.fields.email);
      if (err.fields && err.fields.consent) setFieldError(consent, err.fields.consent);
      if (!err.fields || (!err.fields.email && !err.fields.consent)) status.textContent = err.message + (err.code === 'network' ? '' : '');
      if (err.fields && err.fields.email) email.focus();
    } finally {
      setLoading(btn, false);
    }
  });
}

function initFaq() {
  for (const btn of $$('.faq-q')) {
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') === 'true';
      for (const other of $$('.faq-q')) {
        const on = other === btn ? !open : false;
        other.setAttribute('aria-expanded', on ? 'true' : 'false');
        $('#' + other.getAttribute('aria-controls')).hidden = !on;
        $('.faq-sign', other).textContent = on ? '−' : '+';
      }
    });
  }
}

function initMotion() {
  const btn = $('#motion-btn');
  const fish = initFish($('#koi'), $('#hero'));
  if (reducedMotion()) { btn.hidden = true; return; }
  const apply = (off) => {
    document.documentElement.classList.toggle('motion-off', off);
    btn.setAttribute('aria-pressed', off ? 'true' : 'false');
    btn.textContent = off ? 'Play animation' : 'Pause animation';
    if (fish) fish.setPaused(off);
  };
  apply(store.get('os.motionOff', false) === true);
  btn.addEventListener('click', () => { const off = btn.getAttribute('aria-pressed') !== 'true'; store.set('os.motionOff', off); apply(off); });
}

function initReveal() {
  if (reducedMotion() || typeof IntersectionObserver !== 'function') return;
  document.documentElement.classList.add('js-rv');
  const io = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.04 });
  for (const n of $$('.rv')) io.observe(n);
  // Safety net: never leave content invisible (very tall viewports, printing, screenshots).
  setTimeout(() => { if (window.innerHeight > 1400) for (const n of $$('.rv')) n.classList.add('in'); }, 600);
  window.addEventListener('beforeprint', () => { for (const n of $$('.rv')) n.classList.add('in'); });
}

function initNav() {
  if (typeof IntersectionObserver !== 'function') return;
  const links = $$('.navl[data-sec]');
  const io = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) for (const l of links) { if (l.dataset.sec === e.target.id) l.setAttribute('aria-current', 'true'); else l.removeAttribute('aria-current'); }
  }, { rootMargin: '-40% 0px -55% 0px' });
  for (const id of ['beans', 'how', 'roasters', 'faq']) { const el = document.getElementById(id); if (el) io.observe(el); }
}

initSite();
initLabel();
initShop();
initFlash();
initNewsletter();
initFaq();
initMotion();
initCherries($('#cradle'));
initReveal();
initNav();
