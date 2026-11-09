// The scanner's real edge finder (Core in app/index.html) on drawn photos with known corners: square
// pages, A4 and receipts, at several angles, sizes and backgrounds. A page fully in view must be found
// to within 3% and the right way up; a page running out of the view must not be taken by itself.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');
const at = html.indexOf('<script id="core">');
const src = html.slice(at + 18, html.indexOf('</script>', at));
const m = { exports: {} }; new Function('module', src)(m); const Core = m.exports;
let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function inQuad(q, x, y) { let s = 0; for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]); if (c === 0) continue; const sg = c > 0 ? 1 : -1; if (!s) s = sg; else if (s !== sg) return false; } return true; }
// bilinear map unit square -> quad
function mapQ(q, u, v) { const x = (1 - u) * (1 - v) * q[0][0] + u * (1 - v) * q[1][0] + u * v * q[2][0] + (1 - u) * v * q[3][0];
  const y = (1 - u) * (1 - v) * q[0][1] + u * (1 - v) * q[1][1] + u * v * q[2][1] + (1 - u) * v * q[3][1]; return [x, y]; }
function render(W, H, quad, opt) {
  const S = 3, w = W * S, h = H * S, rgba = new Uint8ClampedArray(W * H * 4);
  const bg = opt.bg; // [r,g,b]
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let acc = [0, 0, 0];
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const X = x + (sx + 0.5) / S, Y = y + (sy + 0.5) / S;
      let c;
      if (inQuad(quad, X, Y)) {
        c = opt.paper.slice();
        // inverse map approx: solve u,v by iteration
        let u = 0.5, v = 0.5;
        for (let it = 0; it < 12; it++) { const p = mapQ(quad, u, v), pu = mapQ(quad, u + 1e-3, v), pv = mapQ(quad, u, v + 1e-3);
          const a = (pu[0] - p[0]) / 1e-3, b = (pv[0] - p[0]) / 1e-3, cc = (pu[1] - p[1]) / 1e-3, d = (pv[1] - p[1]) / 1e-3, det = a * d - b * cc;
          const ex = X - p[0], ey = Y - p[1]; u += (d * ex - b * ey) / det; v += (-cc * ex + a * ey) / det; }
        if (opt.content) { const k = opt.content(u, v); if (k) c = k; }
      } else c = bg.slice();
      acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
    }
    const n = (rnd() - 0.5) * opt.noise, sh = opt.shade ? opt.shade(x / W, y / H) : 1;
    for (let k = 0; k < 3; k++) rgba[(y * W + x) * 4 + k] = acc[k] / (S * S) * sh + n;
    rgba[(y * W + x) * 4 + 3] = 255;
  }
  return rgba;
}
const text = (u, v) => { // lines of print
  if (u > 0.08 && u < 0.92 && v > 0.06 && v < 0.94) { const row = (v * 30) % 1; if (row < 0.35 && ((u * 37 + Math.floor(v * 30) * 3.7) % 1) < 0.7) return [40, 40, 40]; } return null; };
const table = (u, v) => { // invoice: dark header band + grid
  if (v > 0.05 && v < 0.15 && u > 0.05 && u < 0.95) return [30, 30, 30];
  if (u > 0.05 && u < 0.95 && v > 0.25 && v < 0.85 && (Math.abs((v * 20) % 1) < 0.08 || Math.abs((u * 6) % 1) < 0.03)) return [50, 50, 50];
  return text(u, v); };
const logo = (u, v) => (u > 0.35 && u < 0.65 && v > 0.04 && v < 0.2) ? [200, 40, 40] : table(u, v);

function rectQuad(cx, cy, w, h, deg, persp) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  return pts.map(([x, y], i) => { const k = (i < 2 ? 1 - persp : 1 + persp); x *= k; return [cx + x * c - y * s, cy + x * s + y * c]; });
}

const W = 240, H = 320;
const bgs = { dark: [70, 55, 45], wood: [150, 110, 75], grey: [120, 120, 125], light: [185, 180, 172] };
const cases = [];
for (const shape of ['square', 'receipt', 'a4'])
  for (const bgn of Object.keys(bgs))
    for (const deg of [0, 20, 44, -15])
      for (const size of [0.55, 0.8])
       for (const content of shape === 'square' ? [text, table, logo] : [shape === 'receipt' ? text : logo]) {
        const dims = shape === 'square' ? [1, 1] : shape === 'receipt' ? [0.38, 1] : [0.71, 1];
        const base = Math.min(W, H) * size * (shape === 'square' ? 1 : 1.25);
        cases.push({ name: [shape, bgn, deg + 'deg', size, content.name].join(' '), quad: rectQuad(W / 2 + 4, H / 2 - 6, base * dims[0], base * dims[1], deg, 0.06),
          opt: { bg: bgs[bgn], paper: [235, 233, 228], noise: 10, content: content, shade: (x, y) => 0.92 + 0.12 * x } });
      }
function err(truth, got) {
  let best = Infinity, bestR = 0;
  for (let r = 0; r < 4; r++) { let d = 0; for (let i = 0; i < 4; i++) d = Math.max(d, Math.hypot(truth[i][0] - got[(i + r) % 4][0], truth[i][1] - got[(i + r) % 4][1])); if (d < best) { best = d; bestR = r; } }
  return { e: best / Math.hypot(W, H) * 100, rot: bestR };
}
const results = cases.map(c => {
  const rgba = render(W, H, c.quad, c.opt), d = Core.detect(Core.toGray(rgba, W, H), W, H, Core.neutral(rgba, W, H));
  const off = c.quad.some(p => p[0] < 1 || p[1] < 1 || p[0] > W - 1 || p[1] > H - 1);
  return { c, d, off };
});

test('pages fully in view: found to within 3% of the frame, right way up, not mistaken for off-screen', () => {
  const inView = results.filter(r => !r.off), bad = [];
  inView.forEach(({ c, d }) => {
    if (!d) return bad.push('not found: ' + c.name);
    const { e, rot } = err(c.quad, d.quad);
    if (e > 3) bad.push('corners off by ' + e.toFixed(1) + '%: ' + c.name);
    else if (rot) bad.push('sideways: ' + c.name);
    else if (d.touches) bad.push('said to run off-screen: ' + c.name);
  });
  assert.ok(inView.length >= 60, 'enough cases: ' + inView.length);
  assert.deepEqual(bad, []);
});

test('pages running out of the view are never taken by themselves (no clipped shapes)', () => {
  const off = results.filter(r => r.off), taken = off.filter(r => r.d && !r.d.touches).map(r => r.c.name);
  assert.ok(off.length >= 15, 'enough cases: ' + off.length);
  assert.deepEqual(taken, []);
});

test('the steady hold does not count while the page runs off-screen, except for long receipts', () => {
  const q = [[0, 10], [200, 10], [200, 300], [0, 300]], det = { quad: q, area: 0.6, touches: true };
  const t = new Core.Tracker({ need: 3, maxShift: 8, w: W, h: H });
  for (let i = 0; i < 6; i++) { const r = t.update(det, null); assert.equal(r.fire, false); assert.equal(r.offEdge, true); }
  const t2 = new Core.Tracker({ need: 3, maxShift: 8, w: W, h: H }); t2.allowEdge = true;
  let fired = false; for (let i = 0; i < 4; i++) fired = t2.update(det, null).fire || fired;
  assert.equal(fired, true);
});
