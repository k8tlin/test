// Halftone goldfish swimming across the hero <canvas>, drawn from a 24-frame sprite sheet
// (6 columns, 368x240 cells, fish facing right, played ping-pong).

import { reducedMotion } from './ui.js';

const SHEET = '/assets/fish-sheet.webp';
const CW = 368, CH = 240, COLS = 6, NF = 24;

export function initFish(canvas, zone) {
  if (!canvas || !canvas.getContext) return null;
  const size = () => [canvas.clientWidth || 1200, canvas.clientHeight || 600];
  let [W, Hh] = size();
  const small = W < 640, mid = W < 940, sc = small ? 0.42 : mid ? 0.62 : 1;
  const sheet = new Image();
  let defs = [[360, 1], [300, -1], [250, 1], [210, -1], [170, 1], [140, -1], [280, 1], [190, -1], [120, 1], [230, -1], [150, 1], [105, -1]];
  if (small) defs = [defs[0], defs[2], defs[4], defs[5], defs[8]];
  else if (mid) defs = [defs[0], defs[1], defs[2], defs[3], defs[4], defs[5], defs[8]];
  const F = defs.map((d, n) => ({ L: d[0] * sc, x: W * ((n * 0.31 + 0.15) % 1), y: Hh * 0.5, th: 0, v: 26, base: 22 + (n % 3) * 9 + d[0] * 0.03, ph: n * 1.7, amp: 0.4, kick: 0.6 + n * 0.5, seed: n * 2.39 + 0.7, face: d[1], sx: d[1], fr: n * 5, veer: 0, lane: undefined }));
  F.sort((a, b) => a.L - b.L);
  const k = { F, mx: -9999, my: -9999, rip: [], t: 0, on: false, visible: false, paused: false, last: 0, still: reducedMotion() };

  function step(dt) {
    [W, Hh] = size();
    const top = W < 640 ? Math.max(0, Hh - 250) : W < 940 ? Math.max(0, Hh - 330) : 0;
    k.t += dt;
    for (let j = k.rip.length - 1; j >= 0; j--) { k.rip[j].t += dt; if (k.rip[j].t > 1.6) k.rip.splice(j, 1); }
    for (let n = 0; n < F.length; n++) {
      const f = F[n], dir = f.face;
      let fear = 0, away = 0;
      if (f.lane === undefined) { f.lane = top + (Hh - top) * (0.14 + 0.72 * ((n * 0.37 + 0.11) % 1)); f.veer = 0; f.y = f.lane; }
      // A fish never turns round: it cruises across, drifts on a slow meander, and re-enters from the far side.
      const dx = f.x - k.mx, dy = f.y - k.my, d = Math.sqrt(dx * dx + dy * dy);
      if (d < 200) { fear = 1 - d / 200; away = dy >= 0 ? 1 : -1; }
      for (const rp of k.rip) {
        if (rp.t < 0.4) {
          const ry = f.y - rp.y, rx = f.x - rp.x, rd = Math.sqrt(rx * rx + ry * ry);
          if (rd < 280) { fear = Math.max(fear, 1 - rd / 280); away = ry >= 0 ? 1 : -1; }
        }
      }
      for (let o = 0; o < F.length; o++) {
        if (o === n) continue;
        const g = F[o], sy = f.y - g.y, sx = f.x - g.x, need = (f.L + g.L) * 0.34;
        if (Math.abs(sx) < (f.L + g.L) * 0.55 && Math.abs(sy) < need) f.lane += (sy >= 0 ? 1 : -1) * 14 * dt;
      }
      f.lane = Math.max(top + f.L * 0.22, Math.min(Hh - f.L * 0.22, f.lane));
      const want = fear * away * 0.7 + Math.max(-0.35, Math.min(0.35, (f.lane - f.y) / 160)) + 0.12 * Math.sin(k.t * 0.23 + f.seed) + 0.05 * Math.sin(k.t * 0.61 + f.seed * 2);
      f.veer += (want - f.veer) * Math.min(1, dt * (0.9 + fear * 2.5));
      // burst and glide
      f.kick -= dt * (1 + fear * 3);
      if (f.kick <= 0) { f.kick = 1.7 + (Math.sin(k.t * 1.3 + f.seed * 7) + 1) * 1.0; f.v += f.base * (0.45 + fear * 3); f.amp = 1; }
      if (fear > 0.3 && f.amp < 0.6) { f.v += f.base * 2.2 * fear; f.amp = 1; }
      f.v += (f.base * 0.8 - f.v) * dt * 0.6; f.v = Math.min(f.v, 240);
      f.amp += (0.35 - f.amp) * dt * 0.8;
      f.ph += dt * (5.4 + f.amp * 1.6);
      f.th = f.veer; f.sx = dir; f.fr += dt * (7 + f.v * 0.11);
      f.x += dir * Math.cos(f.veer) * f.v * dt; f.y += Math.sin(f.veer) * f.v * dt;
      const edge = f.L * 0.75;
      if (dir > 0 && f.x > W + edge) { f.x = -edge; f.lane = top + (Hh - top) * (0.14 + 0.72 * ((k.t * 0.137 + n * 0.41) % 1)); f.y = f.lane; }
      else if (dir < 0 && f.x < -edge) { f.x = W + edge; f.lane = top + (Hh - top) * (0.14 + 0.72 * ((k.t * 0.173 + n * 0.29) % 1)); f.y = f.lane; }
    }
  }

  function draw() {
    [W, Hh] = size();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(Hh * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(Hh * dpr); }
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, Hh);
    for (const rp of k.rip) {
      const life = 1 - rp.t / 1.6;
      for (let ring = 0; ring < 2; ring++) {
        const rr = rp.t * 200 - ring * 30; if (rr < 6) continue;
        const cnt = Math.floor(rr * 0.7);
        c.fillStyle = ring ? 'rgba(42,59,232,.22)' : 'rgba(42,59,232,.4)';
        for (let i = 0; i < cnt; i++) { const an = i / cnt * 6.2832; c.beginPath(); c.arc(rp.x + Math.cos(an) * rr, rp.y + Math.sin(an) * rr * 0.6, 2.2 * life, 0, 6.2832); c.fill(); }
      }
    }
    if (!sheet.complete || !sheet.naturalWidth) return;
    for (const f of F) {
      const pp = Math.floor(f.fr) % (NF * 2 - 2), fi = pp < NF ? pp : (NF * 2 - 2 - pp), L = f.L, Hd = L * CH / CW;
      c.save();
      // On wide screens a fish fades to a faint ghost where it passes behind the text.
      c.globalAlpha = W >= 940 ? Math.max(0.16, Math.min(1, (f.x - W * 0.3) / (W * 0.14))) : 1;
      c.translate(f.x, f.y); c.scale(f.sx, 1); c.rotate(f.th);
      c.drawImage(sheet, (fi % COLS) * CW, Math.floor(fi / COLS) * CH, CW, CH, -L * 0.5, -Hd / 2, L, Hd);
      c.restore();
    }
  }

  function loop() {
    if (!k.on) return;
    const now = performance.now(), dt = Math.min(0.033, (now - k.last) / 1000); k.last = now;
    step(dt); draw();
    requestAnimationFrame(loop);
  }
  function sync() {
    const run = k.visible && !k.paused && !k.still && !document.hidden;
    if (run && !k.on) { k.on = true; k.last = performance.now(); loop(); }
    else if (!run) k.on = false;
  }

  sheet.onload = draw;
  sheet.src = SHEET;
  for (let w = 0; w < 120; w++) step(0.033);
  draw();
  window.addEventListener('resize', () => { if (!k.on) draw(); });

  if (!k.still) {
    if (typeof IntersectionObserver === 'function') {
      new IntersectionObserver((es) => { k.visible = es[0].isIntersecting; sync(); }, { threshold: 0.02 }).observe(canvas);
    } else { k.visible = true; sync(); }
    document.addEventListener('visibilitychange', sync);
    const xy = (e) => { const b = canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    zone.addEventListener('pointermove', (e) => { [k.mx, k.my] = xy(e); });
    zone.addEventListener('pointerleave', () => { k.mx = -9999; k.my = -9999; });
    zone.addEventListener('pointerdown', (e) => { if (k.on) { const q = xy(e); k.rip.push({ x: q[0], y: q[1], t: 0 }); } });
  }

  return { setPaused(p) { k.paused = !!p; sync(); }, still: k.still };
}
