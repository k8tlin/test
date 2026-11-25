// Two pixel-mosaic coffee cherries on stems that swing and knock together on hover or click.

import { h, s, reducedMotion } from './ui.js';

function leafPix() {
  let a = 41;
  const rnd = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
  const out = ['', '', '', ''], G = 4, ang = -0.62, ca = Math.cos(ang), sa = Math.sin(ang), Ln = 104;
  for (let y = 0; y < 84; y += G) for (let x = 0; x < 120; x += G) {
    const dx = x + 2 - 4, dy = y + 2 - 78, u = (dx * ca + dy * sa) / Ln, w = -dx * sa + dy * ca;
    if (u < 0.02 || u > 1) continue;
    const half = 19 * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.82)), 0.85) + 0.6, e = Math.abs(w) / half;
    if (e > 1) continue;
    if (u > 0.8 && rnd() < (u - 0.8) * 2.6) continue;
    if (e > 0.82 && rnd() < 0.3) continue;
    const vein = Math.abs(w) < 1.8 || Math.abs(((u * 7) % 1) - Math.abs(w) / half * 0.9) < 0.09;
    const tone = vein ? 3 : (w < 0 ? (e > 0.6 ? 1 : 2) : (e > 0.55 ? 0 : 1));
    out[tone] += 'M' + x + ' ' + y + 'h3.3v3.3h-3.3z';
  }
  return out;
}

function cherryPix(seed, ripe) {
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = ['', '', '', '', '', ''], G = 4, R = 53, C = 55, lx = -0.46, ly = -0.56, lz = 0.69;
  for (let y = -14; y <= 124; y += G) for (let x = -14; x <= 124; x += G) {
    const nx = (x + G / 2 - C) / R, ny = (y + G / 2 - C) / R, d2 = nx * nx + ny * ny, d = Math.sqrt(d2);
    const trail = Math.max(0, nx * 0.6 + ny * 0.8);
    let tone, sz = G - 0.7;
    if (d > 1) {
      const far = (d - 1) / (0.16 + trail * 0.42);
      if (far > 1 || rnd() < 0.45 + far * 0.55) continue;
      tone = rnd() < 0.5 ? 0 : 1; sz = G - 0.7 - far * 1.6;
    } else {
      if (d > 0.86 && rnd() < (d - 0.86) * 3.2 * (0.35 + trail)) continue;
      const nz = Math.sqrt(1 - d2), lum = Math.max(0, nx * lx + ny * ly + nz * lz) * ripe + (rnd() - 0.5) * 0.09;
      const hx = lx, hy = ly, hz = lz + 1, hl = Math.sqrt(hx * hx + hy * hy + hz * hz), sp = Math.pow(Math.max(0, (nx * hx + ny * hy + nz * hz) / hl), 38);
      const dim = Math.sqrt(nx * nx * 6 + (ny + 0.93) * (ny + 0.93) * 30);
      tone = sp > 0.5 ? 5 : lum > 0.84 ? 4 : lum > 0.62 ? 3 : lum > 0.4 ? 2 : lum > 0.2 ? 1 : 0;
      if (dim < 0.5) tone = 0; else if (dim < 0.8) tone = Math.min(tone, 1);
    }
    out[tone] += 'M' + x + ' ' + y + 'h' + sz.toFixed(1) + 'v' + sz.toFixed(1) + 'h-' + sz.toFixed(1) + 'z';
  }
  return out;
}

const LEAF = ['#2E6B2A', '#4F9A34', '#8CCB45', '#D4F07A'];
const TONES = ['#5E0A18', '#A80E1B', '#D8261F', '#F4522F', '#FF8A5C', '#FFE3DA'];
const T0 = 0.226;

export function initCherries(root) {
  if (!root) return;
  const paths = (list, fills) => list.map((d, i) => s('path', { d, fill: fills[i] }));
  const arm = (cls, stemD, stroke, pix) => h('span', { class: 'arm ' + cls },
    s('svg', { class: 'stem', viewBox: '0 0 30 200', 'aria-hidden': 'true' }, s('path', { d: stemD, fill: 'none', stroke, 'stroke-width': 3.4, 'stroke-linecap': 'round' })),
    s('svg', { class: 'chp', viewBox: '-17 -17 144 144', 'aria-hidden': 'true' }, paths(pix, TONES)));
  const arm1 = arm('arm1', 'M15 1C3 58 25 132 15 199', '#9CC243', cherryPix(7, 1.06));
  const arm2 = arm('arm2', 'M15 1C27 58 5 132 15 199', '#86AD38', cherryPix(23, 0.94));
  const drops = Array.from({ length: 18 }, () => h('i', { class: 'drop' }));
  root.append(
    s('svg', { class: 'leaf', viewBox: '0 0 120 84', 'aria-hidden': 'true' }, paths(leafPix(), LEAF)),
    h('span', { class: 'twig' }), arm1, arm2, h('span', { 'aria-hidden': 'true' }, drops));

  const p = { a: [-T0, T0], w: [0, 0], drops: [], run: false, last: 0 };
  const arms = [arm1, arm2];

  function knock(side, power) {
    if (reducedMotion()) return;
    if (side === 0) p.w[0] -= power; else p.w[1] += power;
    if (!p.run) { p.run = true; p.last = performance.now(); step(); }
  }

  function step() {
    const L = 245, K = 30;
    if (!p.run || !document.contains(root)) { p.run = false; return; }
    const now = performance.now(), dt = Math.min(0.032, (now - p.last) / 1000); p.last = now;
    for (let n = 0; n < 2; n++) { p.w[n] += -K * Math.sin(p.a[n]) * dt; p.w[n] *= (1 - 0.55 * dt); p.a[n] += p.w[n] * dt; p.a[n] = Math.max(-1.25, Math.min(1.25, p.a[n])); }
    if (p.a[1] - p.a[0] < 2 * T0) {
      const rel = p.w[0] - p.w[1], mid = (p.a[0] + p.a[1]) / 2; p.a[0] = mid - T0; p.a[1] = mid + T0;
      if (rel > 0.25) {
        const t = p.w[0]; p.w[0] = p.w[1] * 0.88; p.w[1] = t * 0.88;
        if (rel > 0.7) {
          const cx = 170 + L * Math.sin(mid), cy = 18 + L * Math.cos(mid), cnt = Math.min(drops.length, Math.round(5 + rel * 4)), kk = Math.min(1.6, 0.5 + rel * 0.3);
          p.drops = [];
          for (let i = 0; i < cnt; i++) { const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.6, sp = (140 + Math.random() * 260) * kk; p.drops.push({ x: cx, y: cy - 20 + Math.random() * 40, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 40, life: 1, s: 0.45 + Math.random() * 0.9 }); }
        }
      } else if (rel > 0) { const av = (p.w[0] + p.w[1]) / 2; p.w[0] = av; p.w[1] = av; }
    }
    arms[0].style.transform = 'rotate(' + (-p.a[0]).toFixed(4) + 'rad)';
    arms[1].style.transform = 'rotate(' + (-p.a[1]).toFixed(4) + 'rad)';
    let alive = 0;
    for (let j = 0; j < drops.length; j++) {
      const dr = p.drops[j], el = drops[j];
      if (!dr || dr.life <= 0) { el.style.opacity = '0'; continue; }
      dr.vy += 900 * dt; dr.x += dr.vx * dt; dr.y += dr.vy * dt; dr.life -= dt * 1.15; alive++;
      el.style.opacity = Math.max(0, Math.min(1, dr.life * 1.6)).toFixed(2);
      el.style.transform = 'translate(' + dr.x.toFixed(1) + 'px,' + dr.y.toFixed(1) + 'px) scale(' + dr.s.toFixed(2) + ',' + (dr.s * (1 + Math.min(0.6, Math.abs(dr.vy) / 900))).toFixed(2) + ')';
    }
    const e = Math.abs(p.a[0] + T0) + Math.abs(p.a[1] - T0) + Math.abs(p.w[0]) + Math.abs(p.w[1]);
    if (e < 0.004 && !alive) { p.run = false; p.a = [-T0, T0]; p.w = [0, 0]; arms[0].style.transform = ''; arms[1].style.transform = ''; return; }
    requestAnimationFrame(step);
  }

  arm1.addEventListener('mouseenter', () => knock(0, 2.2));
  arm2.addEventListener('mouseenter', () => knock(1, 2.2));
  root.addEventListener('click', () => { knock(0, 2.6); knock(1, 2.6); });
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) { knock(0, 3.2); io.disconnect(); } }, { threshold: 0.6 });
    io.observe(root);
  }
}
