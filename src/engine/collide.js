// The marble against the models' real triangles: the exact sphere-against-triangle test
// the no-ghost rule (physical.js freePath) runs, on the same plastic tests/oracle.js
// judges from the GLBs directly. Each model's triangles are baked into models/solids.json
// (tools/solids/bake.mjs, record frame, metres, 0.05 mm steps) with its mesh nodes; a
// node other than the body is a moving part. Nothing is carved: the marble's own piece is
// plastic like any other. Names no piece.
import { SOLIDS } from './solids.js';

export const MARBLE_M = 0.010;  // marble radius, from the marble records (20 mm across)
export const QUANT_M = 0.00005; // the bake stores coordinates in 0.05 mm steps
const H = 0.008;                // grid cell of a model's triangle index, metres

const b64 = (s) => (globalThis.Buffer ? new Uint8Array(globalThis.Buffer.from(s, 'base64')) : Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0)));

// Closest distance from p = [x, y, z] to triangle n of t (9 numbers each), Ericson 5.1.5.
export function pointTriDist(px, py, pz, t, o) {
  const ax = t[o], ay = t[o + 1], az = t[o + 2], bx = t[o + 3], by = t[o + 4], bz = t[o + 5], cx = t[o + 6], cy = t[o + 7], cz = t[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return Math.hypot(apx, apy, apz);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return Math.hypot(bpx, bpy, bpz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return Math.hypot(apx - v * abx, apy - v * aby, apz - v * abz); }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return Math.hypot(cpx, cpy, cpz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return Math.hypot(apx - w * acx, apy - w * acy, apz - w * acz); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return Math.hypot(bpx - w * (cx - bx), bpy - w * (cy - by), bpz - w * (cz - bz)); }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return Math.hypot(apx - abx * v - acx * w, apy - aby * v - acy * w, apz - abz * v - acz * w);
}

// A model's triangles, record frame, metres: { key, tris (Float64Array, 9 per triangle),
// mover (Uint8Array, 1 for a moving part), lo, hi, cells (Map of grid cell to triangle
// indices) } or null when the bake has none.
const MODELS = new Map();
export function trianglesOf(key) {
  if (MODELS.has(key)) return MODELS.get(key);
  const b = SOLIDS?.models?.[key]?.tris;
  if (!b) { MODELS.set(key, null); return null; }
  const bytes = b64(b.data), q = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  const n = q.length / 9, tris = new Float64Array(q.length), mover = new Uint8Array(n);
  for (let i = 0; i < q.length; i++) tris[i] = q[i] * QUANT_M;
  for (const [name, start, count] of b.nodes) if (name !== b.body) mover.fill(1, start, start + count);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], box = new Float64Array(n * 6);
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const x0 = Math.min(tris[o], tris[o + 3], tris[o + 6]), x1 = Math.max(tris[o], tris[o + 3], tris[o + 6]);
    const y0 = Math.min(tris[o + 1], tris[o + 4], tris[o + 7]), y1 = Math.max(tris[o + 1], tris[o + 4], tris[o + 7]);
    const z0 = Math.min(tris[o + 2], tris[o + 5], tris[o + 8]), z1 = Math.max(tris[o + 2], tris[o + 5], tris[o + 8]);
    box.set([x0, y0, z0, x1, y1, z1], t * 6);
    lo[0] = Math.min(lo[0], x0); lo[1] = Math.min(lo[1], y0); lo[2] = Math.min(lo[2], z0);
    hi[0] = Math.max(hi[0], x1); hi[1] = Math.max(hi[1], y1); hi[2] = Math.max(hi[2], z1);
  }
  // A dense grid over the model's bounds, each cell listing the triangles whose boxes
  // reach it (start offsets into one flat list).
  const g0 = lo.map((u) => Math.floor(u / H)), dim = hi.map((u, d) => Math.floor(u / H) - g0[d] + 1), count = new Int32Array(dim[0] * dim[1] * dim[2] + 1);
  const each = (t, f) => {
    const b = t * 6;
    for (let i = Math.floor(box[b] / H) - g0[0]; i <= Math.floor(box[b + 3] / H) - g0[0]; i++) for (let j = Math.floor(box[b + 1] / H) - g0[1]; j <= Math.floor(box[b + 4] / H) - g0[1]; j++)
      for (let k = Math.floor(box[b + 2] / H) - g0[2]; k <= Math.floor(box[b + 5] / H) - g0[2]; k++) f((i * dim[1] + j) * dim[2] + k);
  };
  for (let t = 0; t < n; t++) each(t, (c) => count[c + 1]++);
  for (let c = 1; c < count.length; c++) count[c] += count[c - 1];
  const fill = count.slice(), list = new Int32Array(count.at(-1));
  for (let t = 0; t < n; t++) each(t, (c) => { list[fill[c]++] = t; });
  const m = { key, tris, mover, box, lo, hi, g0, dim, start: count, list, stamp: new Uint32Array(n), tick: 0 };
  MODELS.set(key, m);
  return m;
}

// The nearest plastic of model m to local point (x, y, z) within reach (metres):
// { d, mover } or null. withMovers false leaves the moving parts out.
// Most points the marble passes are well clear of plastic, and the same pieces stand in
// the same poses again and again, so each 2 mm cell of a model remembers how near its
// plastic comes to the cell's middle: a point in a cell whose plastic is farther than
// reach plus the cell's half diagonal cannot have any within reach (an exact bound).
const LB_CELL = 0.002, LB_HALF = Math.sqrt(3) * LB_CELL / 2;
export function nearestTri(m, x, y, z, reach, withMovers = true) {
  const ci = Math.floor(x / LB_CELL), cj = Math.floor(y / LB_CELL), ck = Math.floor(z / LB_CELL);
  const cache = (m.lb ??= new Map()), id = `${withMovers ? 1 : 0}|${reach}|${ci}|${cj}|${ck}`;
  let near = cache.get(id);
  if (near === undefined) {
    const r = scan(m, (ci + 0.5) * LB_CELL, (cj + 0.5) * LB_CELL, (ck + 0.5) * LB_CELL, reach + LB_HALF, withMovers);
    near = r ? r.d : Infinity;
    if (cache.size > 2e6) cache.clear();
    cache.set(id, near);
  }
  if (near - LB_HALF >= reach) return null;
  return scan(m, x, y, z, reach, withMovers);
}
function scan(m, x, y, z, reach, withMovers) {
  let best = reach, mv = 0;
  const tick = ++m.tick;
  if (tick === 0xffffffff) { m.stamp.fill(0); m.tick = 1; }
  const { g0, dim, start, list } = m;
  const i0 = Math.max(0, Math.floor((x - reach) / H) - g0[0]), i1 = Math.min(dim[0] - 1, Math.floor((x + reach) / H) - g0[0]);
  const j0 = Math.max(0, Math.floor((y - reach) / H) - g0[1]), j1 = Math.min(dim[1] - 1, Math.floor((y + reach) / H) - g0[1]);
  const k0 = Math.max(0, Math.floor((z - reach) / H) - g0[2]), k1 = Math.min(dim[2] - 1, Math.floor((z + reach) / H) - g0[2]);
  for (let i = i0; i <= i1; i++)
    for (let j = j0; j <= j1; j++)
      for (let k = k0; k <= k1; k++) {
        const c = (i * dim[1] + j) * dim[2] + k;
        for (let n = start[c]; n < start[c + 1]; n++) {
          const t = list[n];
          if (m.stamp[t] === m.tick) continue;
          m.stamp[t] = m.tick;
          if (!withMovers && m.mover[t]) continue;
          // The triangle's box first: nothing in it can be nearer than the box.
          const b = t * 6, ex = Math.max(m.box[b] - x, 0, x - m.box[b + 3]), ey = Math.max(m.box[b + 1] - y, 0, y - m.box[b + 4]), ez = Math.max(m.box[b + 2] - z, 0, z - m.box[b + 5]);
          if (ex * ex + ey * ey + ez * ez >= best * best) continue;
          const d = pointTriDist(x, y, z, m.tris, t * 9);
          if (d < best) { best = d; mv = m.mover[t]; }
        }
      }
  return best < reach ? { d: best, mover: !!mv } : null;
}

// The closest point of triangle o of t to p (Ericson 5.1.5), as [x, y, z].
export function closestOnTri(px, py, pz, t, o) {
  const ax = t[o], ay = t[o + 1], az = t[o + 2], bx = t[o + 3], by = t[o + 4], bz = t[o + 5], cx = t[o + 6], cy = t[o + 7], cz = t[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return [ax, ay, az];
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return [bx, by, bz];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [ax + v * abx, ay + v * aby, az + v * abz]; }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return [cx, cy, cz];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [ax + w * acx, ay + w * acy, az + w * acz]; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return [bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz)]; }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return [ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w];
}

// The nearest plastic of model m UNDER a marble centred at local (x, y, z): the least
// distance to a triangle whose closest point lies below the centre, at least `cosMin` of
// the way straight down (0.3: within about 72 degrees of the vertical, so the walls of a
// channel or a 57 degree slope hold the marble, a wall beside it does not), within reach.
// Moving parts count: a scoop or a flap holds the marble it carries. Distance or null.
export function nearestBelow(m, x, y, z, reach, cosMin = 0.3) {
  let best = reach;
  const tick = ++m.tick;
  if (tick === 0xffffffff) { m.stamp.fill(0); m.tick = 1; }
  const { g0, dim, start, list } = m;
  const i0 = Math.max(0, Math.floor((x - reach) / H) - g0[0]), i1 = Math.min(dim[0] - 1, Math.floor((x + reach) / H) - g0[0]);
  const j0 = Math.max(0, Math.floor((y - reach) / H) - g0[1]), j1 = Math.min(dim[1] - 1, Math.floor((y + reach) / H) - g0[1]);
  const k0 = Math.max(0, Math.floor((z - reach) / H) - g0[2]), k1 = Math.min(dim[2] - 1, Math.floor(z / H) - g0[2]);
  for (let i = i0; i <= i1; i++)
    for (let j = j0; j <= j1; j++)
      for (let k = k0; k <= k1; k++) {
        const c = (i * dim[1] + j) * dim[2] + k;
        for (let n = start[c]; n < start[c + 1]; n++) {
          const t = list[n];
          if (m.stamp[t] === m.tick) continue;
          m.stamp[t] = m.tick;
          const b = t * 6;
          if (m.box[b + 2] > z) continue; // nothing of it is under the centre
          const ex = Math.max(m.box[b] - x, 0, x - m.box[b + 3]), ey = Math.max(m.box[b + 1] - y, 0, y - m.box[b + 4]), ez = Math.max(m.box[b + 2] - z, 0, z - m.box[b + 5]);
          if (ex * ex + ey * ey + ez * ez >= best * best) continue;
          const [qx, qy, qz] = closestOnTri(x, y, z, m.tris, t * 9), d = Math.hypot(x - qx, y - qy, z - qz);
          if (d < best && z - qz >= cosMin * d) best = d;
        }
      }
  return best < reach ? best : null;
}

// Whether local point (x, y, z) is inside model m's solid: ray parity along three skew
// directions, majority (the models are closed meshes). Each direction's triangles are
// binned once on a 4 mm grid across it. Moving parts count as plastic unless withMovers is false.
const RAYS = [[0.267, 0.534, 0.802], [-0.577, 0.211, 0.789], [0.802, -0.267, 0.534]].map((d) => { const l = Math.hypot(...d); return d.map((u) => u / l); });
const RAY_BIN = 0.004;
const rayBasis = RAYS.map((D) => {
  const t = Math.abs(D[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], U = [D[1] * t[2] - D[2] * t[1], D[2] * t[0] - D[0] * t[2], D[0] * t[1] - D[1] * t[0]], l = Math.hypot(...U), u = U.map((x) => x / l);
  return [u, [D[1] * u[2] - D[2] * u[1], D[2] * u[0] - D[0] * u[2], D[0] * u[1] - D[1] * u[0]]];
});
function rayBins(m) {
  if (m.rays) return m.rays;
  const T = m.tris, n = T.length / 9;
  m.rays = rayBasis.map(([U, W]) => {
    const map = new Map();
    for (let t = 0; t < n; t++) {
      let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
      for (let k = 0; k < 9; k += 3) { const o = t * 9 + k, u = T[o] * U[0] + T[o + 1] * U[1] + T[o + 2] * U[2], w = T[o] * W[0] + T[o + 1] * W[1] + T[o + 2] * W[2]; u0 = Math.min(u0, u); u1 = Math.max(u1, u); w0 = Math.min(w0, w); w1 = Math.max(w1, w); }
      for (let i = Math.floor(u0 / RAY_BIN); i <= Math.floor(u1 / RAY_BIN); i++) for (let j = Math.floor(w0 / RAY_BIN); j <= Math.floor(w1 / RAY_BIN); j++) { const k = i * 100003 + j; (map.get(k) ?? map.set(k, []).get(k)).push(t); }
    }
    return map;
  });
  return m.rays;
}
export function insideOf(m, x, y, z, withMovers = true) {
  if (x < m.lo[0] || x > m.hi[0] || y < m.lo[1] || y > m.hi[1] || z < m.lo[2] || z > m.hi[2]) return false;
  const bins = rayBins(m), T = m.tris;
  let odd = 0;
  for (let a = 0; a < RAYS.length; a++) {
    const D = RAYS[a], [U, W] = rayBasis[a];
    let cnt = 0;
    for (const t of bins[a].get(Math.floor((x * U[0] + y * U[1] + z * U[2]) / RAY_BIN) * 100003 + Math.floor((x * W[0] + y * W[1] + z * W[2]) / RAY_BIN)) ?? []) {
      if (!withMovers && m.mover[t]) continue;
      const o = t * 9, ax = T[o], ay = T[o + 1], az = T[o + 2], e1 = [T[o + 3] - ax, T[o + 4] - ay, T[o + 5] - az], e2 = [T[o + 6] - ax, T[o + 7] - ay, T[o + 8] - az];
      const h = [D[1] * e2[2] - D[2] * e2[1], D[2] * e2[0] - D[0] * e2[2], D[0] * e2[1] - D[1] * e2[0]], det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
      if (Math.abs(det) < 1e-18) continue;
      const f = 1 / det, s = [x - ax, y - ay, z - az], u = f * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]);
      if (u < 0 || u > 1) continue;
      const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]], v = f * (D[0] * q[0] + D[1] * q[1] + D[2] * q[2]);
      if (v < 0 || u + v > 1) continue;
      if (f * (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) > 1e-9) cnt++;
    }
    odd += cnt & 1;
  }
  return odd >= 2;
}

// The marble's centre over a path sample lives in centre.js (pure arithmetic, shared with
// the physics that records the run the app animates).
export { centreAt } from './centre.js';
