// A launched marble in free flight: the launcher's aim from its record, the catch cone at
// a catcher's open-catch port, and the ballistic arc between them. Shared by the
// generator (which places a catcher where the arc goes), the drawn path (which draws the
// arc) and the flights rule (which flies it again and trusts neither). Names no piece.
import { DIM, byKey } from '../catalog/parts.js';
import { rotXY, FACE } from '../catalog/frame.js';
import { portAt, routeLine, worldOf } from './fit.js';
import { G, NOMINAL } from './physics.js';

const CELL = DIM.cell, SLOT = DIM.slot, R = NOMINAL.marbleRadius;
export const UP = Object.freeze([0, 0, 1]);
// A catch cone when the record gives none: a mouth facing down or up 16 mm across its
// middle, one facing a side (a ring) 22 mm, either taking a marble within 45 degrees.
export const CATCH = Object.freeze({ catchRadiusMm: 16, sideCatchRadiusMm: 22, catchHalfAngleDeg: 45 });
// A hand sets a hand launcher's speed: any speed from gentle to hard, unless the record gives one.
export const HAND_SPEEDS = Object.freeze(Array.from({ length: 60 }, (_, k) => 0.3 + k * 0.05));

// A record's launch aim, record frame: physics.aim as [x, y, z], or { vector | dir | direction }, optional speed.
export function aimOf(rec) {
  const a = rec?.physics?.aim;
  if (!a) return null;
  const v = Array.isArray(a) ? a : a.vector ?? a.dir ?? a.direction;
  return Array.isArray(v) && v.length === 3 ? { v, speed: a.speed ?? a.speedMs ?? rec.physics.launchSpeed ?? null } : null;
}
export const turnVec = ([x, y, z], rot) => { const [a, b] = rotXY([x, y], rot); return [a, b, z]; };
export const unit = (v) => { const d = Math.hypot(...v) || 1; return v.map((u) => u / d); };

// The catch cone at an open-catch port, world: { at (m), axis (unit, the way a marble
// travels into it), radius (m), cos (of the half angle) }. From the port's `catch` field
// when the record has one ({ radiusMm, halfAngleDeg, axis }), else a cone on its face.
export function coneOf(fit, id, tol = CATCH) {
  const a = portAt(fit, id), p = a.port, c = p.catch ?? {};
  let axis;
  if (Array.isArray(c.axis)) axis = turnVec(c.axis, fit.rot);
  else if (p.faces === 'down') axis = [0, 0, 1];
  else if (FACE[p.faces] !== undefined) { const [dx, dy] = [[1, 0], [0, 1], [-1, 0], [0, -1]][(FACE[p.faces] + fit.rot) % 4]; axis = [-dx, -dy, 0]; }
  else axis = [0, 0, -1];
  const side = axis[2] === 0;
  return { port: `${fit.key}.${id}`, at: { x: a.x * CELL, y: a.y * CELL, z: a.z * SLOT + (side ? R : 0) }, axis: unit(axis),
    radius: (c.radiusMm ?? (side ? tol.sideCatchRadiusMm : tol.catchRadiusMm)) / 1000, cos: Math.cos(((c.halfAngleDeg ?? tol.catchHalfAngleDeg) * Math.PI) / 180) };
}

// Flies a marble from p0 (m) along dir at speed v; where it crosses the cone's mouth plane
// moving inward. { hit, offset (m), angleDeg, at, t, arc }. The crossing is solved exactly
// (the height along the axis is a quadratic in time); arc samples the flight every dt.
export function fly(p0, dir, v, cone, dt = 0.005, withArc = true) {
  const ax = cone.axis, A = (p0.x - cone.at.x) * ax[0] + (p0.y - cone.at.y) * ax[1] + (p0.z - cone.at.z) * ax[2];
  const B = v * (dir[0] * ax[0] + dir[1] * ax[1] + dir[2] * ax[2]), C = -(G / 2) * ax[2];
  const at = (t) => ({ x: p0.x + dir[0] * v * t, y: p0.y + dir[1] * v * t, z: p0.z + dir[2] * v * t - (G / 2) * t * t });
  // Where it ends if it misses: down 0.3 m under the lower of the start and the mouth, or 2 s.
  const floor = Math.min(p0.z, cone.at.z) - 0.3, vz = v * dir[2];
  const tEnd = Math.min(2, (vz + Math.sqrt(vz * vz + 2 * G * (p0.z - floor))) / G);
  let t = null;
  if (A < 0) {
    const roots = Math.abs(C) < 1e-12 ? (B > 0 ? [-A / B] : []) : (() => { const d = B * B - 4 * C * A; if (d < 0) return []; const q = Math.sqrt(d); return [(-B - q) / (2 * C), (-B + q) / (2 * C)].sort((a, b) => a - b); })();
    t = roots.find((r) => r > 0 && r <= tEnd && B + 2 * C * r >= 0) ?? null;
  }
  const arc = [];
  if (withArc) for (let u = dt; u < (t ?? tEnd); u += dt) arc.push(at(u));
  if (t === null) return { hit: false, offset: Infinity, angleDeg: null, at: arc.at(-1) ?? p0, t: null, arc };
  const p = at(t), vel = [dir[0] * v, dir[1] * v, dir[2] * v - G * t], cosA = (vel[0] * ax[0] + vel[1] * ax[1] + vel[2] * ax[2]) / Math.hypot(...vel);
  const d = [p.x - cone.at.x, p.y - cone.at.y, p.z - cone.at.z], along = d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2];
  const off = Math.hypot(d[0] - along * ax[0], d[1] - along * ax[1], d[2] - along * ax[2]);
  arc.push(p);
  return { hit: off <= cone.radius && cosA >= cone.cos, offset: off, angleDeg: (Math.acos(Math.max(-1, Math.min(1, cosA))) * 180) / Math.PI, at: p, t, arc };
}

// Of several speeds, the one whose arc goes into the cone nearest its middle; else the
// nearest miss. { ...fly, v }.
export function bestShot(from, dir, speeds, cone) {
  let best = null;
  for (const v of speeds) {
    const f = fly(from, dir, v, cone, 0.005, false);
    if (!best || (f.hit && !best.hit) || (f.hit === best.hit && f.offset < best.offset)) best = { ...f, v };
  }
  return best && { ...fly(from, dir, best.v, cone), v: best.v };
}

// A hand launcher's throw into a catcher: the launcher's fit (with .to, its outlet) and
// the catcher's (with .from, its open-catch). { from, dir, speeds, cone, ...bestShot }.
export function tossShot(fit, hood, tol = CATCH) {
  const set = tossSetup(fit, hood, tol);
  return { ...set, ...bestShot(set.from, set.dir, set.speeds, set.cone) };
}
// The same without flying: where the throw starts, its direction, the speeds a hand
// may give it and the cone it must enter.
export function tossSetup(fit, hood, tol = CATCH) {
  // The throw starts at the tube's top, where the launcher's route (fit.js routeLine) ends.
  const rec = byKey(fit.key), aim = aimOf(rec), [tx, ty, tz] = worldOf(fit, routeLine(rec, fit.from, fit.to).at(-1)), tube = { x: tx, y: ty, z: tz };
  const dir = aim ? unit(turnVec(aim.v, fit.rot)) : [...UP];
  // No harder than the record's throw: a climb of -dropSlots slots at the top of the arc.
  const climb = -((rec.marblePaths ?? []).find((m) => m.from === fit.from && m.to === fit.to)?.dropSlots ?? -Infinity) * SLOT;
  const speeds = aim?.speed ? [aim.speed] : HAND_SPEEDS.filter((v) => !(climb > 0) || v * dir[2] <= Math.sqrt(2 * G * climb));
  // The marble leaves the tube with its centre a radius over the outlet port (its floor there).
  return { from: { x: tube.x * CELL, y: tube.y * CELL, z: tube.z * SLOT + R }, dir, speeds, cone: coneOf(hood, hood.from, tol) };
}

// The arc from p0 to the point `at` it reaches at time t, sampled every `step` metres.
export function arcPoints(p0, dir, v, t, step = 0.0025) {
  const out = [], len = v * t, n = Math.max(4, Math.ceil(len / step));
  for (let k = 0; k <= n; k++) {
    const u = (t * k) / n;
    out.push({ x: p0.x + dir[0] * v * u, y: p0.y + dir[1] * v * u, z: p0.z + dir[2] * v * u - (G / 2) * u * u });
  }
  return out;
}

// The launch speed at angle `dir` that carries a marble from p0 through point q, or null.
export function speedThrough(p0, dir, q) {
  const h = Math.hypot(dir[0], dir[1]), d = Math.hypot(q.x - p0.x, q.y - p0.y), dz = q.z - p0.z;
  if (h < 1e-6 || d < 1e-6) return null;
  const tan = dir[2] / h, cos2 = h * h, den = 2 * cos2 * (d * tan - dz);
  return den > 0 ? Math.sqrt((G * d * d) / den) : null;
}
