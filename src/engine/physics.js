// Path-constrained rolling-marble physics.
// The marble follows a sampled 3D centerline. Rolling inertia, rolling
// resistance, curve scrub and joint losses are modelled explicitly, so the
// energy budget along the track is the output, not an assumption.

import { centreAt } from './centre.js';

export const G = 9.81;

export const NOMINAL = Object.freeze({
  marbleRadius: 0.01,       // m, from the plain marble record, estimated
  inertiaFactor: 1.5,       // >1.4 because a marble in a channel rolls on two lines
  rollingResistance: 0.012, // dimensionless, plastic on plastic
  curveScrub: 0.05,         // fraction of centripetal load lost as wall scrub
  jointKeep: 0.98,          // speed kept crossing a joint between pieces, estimate
  wallCaptureDeg: 55,       // tilt in a channel before the marble climbs out
  startSpeed: 0.05,         // m/s, a gentle release
  maxHop: 0.06,             // m of air a channel can still catch, estimate
});

// What each kind of energy does to a marble, from a record's physics.energy. A record
// may override any of these with an optional physics field: carrySpeed, exitSpeed,
// launchSpeed, holdSpeed, releaseSpeed. All speeds m/s, estimates.
export const ENERGY = Object.freeze({
  'adds-by-motor': { source: 'motor', carry: 0.14, exit: 0.28 },
  'adds-by-hand': { source: 'hand', carry: 0.25, exit: 0.2, launch: 1.4 },
  stores: { source: 'magnet trigger', hold: 0.42 },
  none: { release: 0.3 },
  loses: { release: 0.3 },
});
export const FALL_EXIT = 0.42;   // m/s: a marble dropped into a cup leaves its mouth at most this fast
export const SPIRAL_EXIT = 0.5;  // m/s: the same for a spiral's tail
export const energyOf = (rec, what) => rec?.physics?.[`${what}Speed`] ?? ENERGY[rec?.physics?.energy ?? 'none']?.[what] ?? ENERGY.none[what];
export const sourceOf = (rec) => ENERGY[rec?.physics?.energy]?.source ?? null;

// A piece with two ways out picks one by its physics.exitRule. "alternate" (a flap
// that flips each time) can be set by hand before the run, so the way out is known;
// "random" is a coin toss, so a generated track cannot count on either way.
export const EXIT_RULES = Object.freeze({ alternate: { chance: 1, setByHand: true }, random: { chance: 0.5, setByHand: false } });
export const exitChance = (rec) => EXIT_RULES[rec?.physics?.exitRule]?.chance ?? 1;
// The way out a run of marbles takes: alternate flips each marble, random tosses a coin.
export function exitFor(rec, marble, first = 0, rand = Math.random) {
  const rule = rec?.physics?.exitRule;
  if (rule === 'alternate') return (first + marble) % 2;
  if (rule === 'random') return rand() < 0.5 ? 0 : 1;
  return first;
}

// Worst-case corners: every track must finish in all of them.
export const CORNERS = Object.freeze([
  { name: 'nominal' },
  { name: 'draggy', rollingResistance: 0.02, curveScrub: 0.09, jointKeep: 0.96 },
  { name: 'slick', rollingResistance: 0.007, curveScrub: 0.03, jointKeep: 0.99 },
  { name: 'heavy-magic', inertiaFactor: 1.45, rollingResistance: 0.01, jointKeep: 0.985, handScale: 1.15 },
  { name: 'weak-push', handScale: 0.85 },
]);

export function samplePath(points) {
  // points: [{x,y,z,piece,joint?,bank?,boost?,hold?}], z up, metres.
  const n = points.length;
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const a = points[i - 1], b = points[i];
    s[i] = s[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  const sinT = new Float64Array(n), cosT = new Float64Array(n);
  const kH = new Float64Array(n), kV = new Float64Array(n);
  const win = 2;
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - win)], b = points[Math.min(n - 1, i + win)];
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const d = Math.hypot(dx, dy, dz) || 1e-9;
    sinT[i] = dz / d;
    cosT[i] = Math.sqrt(Math.max(0, 1 - sinT[i] ** 2));
  }
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - win), i1 = Math.min(n - 1, i + win);
    const a = points[i0], m = points[i], b = points[i1];
    const hA = Math.atan2(m.y - a.y, m.x - a.x), hB = Math.atan2(b.y - m.y, b.x - m.x);
    let dH = hB - hA;
    while (dH > Math.PI) dH -= 2 * Math.PI;
    while (dH < -Math.PI) dH += 2 * Math.PI;
    const ds = (s[i1] - s[i0]) / 2 || 1e-9;
    const planar = Math.hypot(m.x - a.x, m.y - a.y) > 1e-5 && Math.hypot(b.x - m.x, b.y - m.y) > 1e-5;
    kH[i] = planar ? Math.abs(dH) / ds : 0;
    const slopeA = Math.asin(sinT[i0]), slopeB = Math.asin(sinT[i1]);
    kV[i] = (slopeB - slopeA) / (2 * ds);   // >0 valley, <0 crest
  }
  return { points, n, s, sinT, cosT, kH, kV, length: s[n - 1] };
}

function indexAt(path, pos, hint) {
  let i = hint;
  const { s, n } = path;
  while (i < n - 2 && s[i + 1] <= pos) i++;
  while (i > 0 && s[i] > pos) i--;
  return i;
}

// A marble leaving flight.from along flight.dir at v m/s, against the catcher's mouth
// (flight.cone: at, axis, radius, cos), as ballistic.js fly() does: { miss, t } where miss
// is null when it enters the mouth, 'stuck' when it arrives low or never reaches it,
// 'too-fast' when it arrives high, and t the time it crosses the mouth's plane.
function catchMiss({ from, dir, cone }, v) {
  const ax = cone.axis, plane = (p) => (p[0] - cone.at.x) * ax[0] + (p[1] - cone.at.y) * ax[1] + (p[2] - cone.at.z) * ax[2];
  let prev = [from.x, from.y, from.z];
  for (let t = 0.001; t < 2; t += 0.001) {
    const p = [from.x + dir[0] * v * t, from.y + dir[1] * v * t, from.z + dir[2] * v * t - (G / 2) * t * t];
    if (plane(prev) < 0 && plane(p) >= 0) {
      // The crossing between the last two steps, on the straight between them.
      const a = plane(prev), b = plane(p), tc = t - 0.001 * (b / (b - a || 1));
      const vel = [dir[0] * v, dir[1] * v, dir[2] * v - G * t], cosA = (vel[0] * ax[0] + vel[1] * ax[1] + vel[2] * ax[2]) / Math.hypot(...vel);
      const d = [p[0] - cone.at.x, p[1] - cone.at.y, p[2] - cone.at.z], along = d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2];
      if (Math.hypot(d[0] - along * ax[0], d[1] - along * ax[1], d[2] - along * ax[2]) <= cone.radius && cosA >= cone.cos) return { miss: null, t: tc };
      return { miss: p[2] < cone.at.z ? 'stuck' : 'too-fast', t: tc };
    }
    if (p[2] < Math.min(from.z, cone.at.z) - 0.3) break;
    prev = p;
  }
  return { miss: 'stuck', t: null };
}

// The marble's centre in a launched flight (flight.from along flight.dir at v m/s) from the
// lip to where it crosses the catcher's mouth at time tc, sampled every dt: the arc the
// flights rule (physical.js) flies and judges, and the one the app shows.
export function flightCentres({ from, dir }, v, tc, dt = 0.005) {
  const out = [], at = (u) => [from.x + dir[0] * v * u, from.y + dir[1] * v * u, from.z + dir[2] * v * u - (G / 2) * u * u];
  for (let u = 0; u < tc; u += dt) out.push({ u, c: at(u) });
  out.push({ u: tc, c: at(tc) });
  return out;
}
// The time a marble at v m/s takes from flight.from to its catcher's mouth, or null when it misses.
export const flightTime = (flight, v) => { const r = catchMiss(flight, v); return r.miss ? null : r.t; };

// Where a recorded run (simulate(..., { record: true }).trace) has the marble at time t:
// its centre, between the two records around t. Records are the marble at every drawn
// path sample (its centre as the rules check it, centre.js centreAt) and along every
// flight's arc, so between records the marble moves on the checked path.
export function traceAt(trace, t, hint = 0) {
  let i = Math.max(0, Math.min(hint, trace.length - 1));
  while (i < trace.length - 1 && trace[i + 1].t <= t) i++;
  while (i > 0 && trace[i].t > t) i--;
  const a = trace[i], b = trace[Math.min(i + 1, trace.length - 1)], f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
  return { i, piece: a.piece, at: [a.c[0] + (b.c[0] - a.c[0]) * f, a.c[1] + (b.c[1] - a.c[1]) * f, a.c[2] + (b.c[2] - a.c[2]) * f] };
}

export function simulate(path, overrides = {}, opts = {}) {
  const p = { ...NOMINAL, ...overrides };
  const dt = opts.dt ?? 0.002, tMax = opts.tMax ?? 90;
  const record = opts.record ?? false;
  const capture = (p.wallCaptureDeg * Math.PI) / 180;
  const { s, sinT, cosT, kH, kV, points, n } = path;
  const scaled = (pt, value) => (pt.source === 'hand' ? value * (p.handScale ?? 1) : value);
  let pos = 0, v = scaled(points[0], (opts.ignoreStart ? null : points[0].start) ?? p.startSpeed), t = 0, i = 0, peak = 0, vMax = 0, lastPiece = points[0].piece;
  const sources = [];
  let minMarginSpeed = Infinity, air = 0;
  const trace = record ? [] : null;
  // Every launched flight the marble takes: its first sample and the speed it leaves the
  // lip with (the flights rule, physical.js, flies that speed).
  const flights = [];
  // The run the app animates: the marble at every drawn path sample as it passes it (its
  // centre where the rules check it), and along every flight's arc.
  const centres = record ? (path.centres ??= points.map((_, k) => centreAt(points, k, p.marbleRadius))) : null;
  let next = 0;
  const rec = (k, tk, vk) => { const q = points[k]; trace.push({ t: tk, s: s[k], v: vk, x: q.x, y: q.y, z: q.z, c: centres[k], ke: 0.5 * p.inertiaFactor * vk * vk, pe: G * q.z, piece: q.piece }); };
  const passed = (pos0, pos1, t1, v0, v1) => {
    for (; next < n && s[next] <= pos1 + 1e-12; next++) {
      if (points[next].flight) continue;
      const f = pos1 > pos0 ? Math.max(0, (s[next] - pos0) / (pos1 - pos0)) : 1;
      rec(next, t1 - dt * (1 - f), v0 + (v1 - v0) * f);
    }
  };
  const fail = (kind, why) => ({
    ok: false, kind, why, at: pos, piece: points[i].piece, t, v, vMax, trace, flights,
    length: path.length, minSpeed: minMarginSpeed,
  });
  if (record) passed(0, 0, 0, v, v);
  while (t < tMax) {
    i = indexAt(path, pos, i);
    const pt = points[i];
    if (pos >= path.length - 1e-4) break;
    if (pt.piece !== lastPiece) {
      if (pt.rest) {
        // The marble waits here until a hand sends it on. It must arrive, and be caught.
        if (v > pt.rest.maxIn) return fail('too-fast', 'bounces out of a waiting piece');
        v = scaled(pt, pt.rest.launch);
      } else if (pt.boost) v = pt.boost;                 // the piece sets the exit speed
      else if (!pt.smooth) v *= p.jointKeep;
      if (pt.keep) v *= pt.keep;                         // a piece that slows the marble, such as paddles
      lastPiece = pt.piece;
    }
    if (pt.source && !sources.includes(pt.source)) sources.push(pt.source);
    if (pt.hold) { v = pt.hold; }                        // powered or hand-driven section
    if (pt.cap && v > pt.cap) v = pt.cap;                // a fall or tail ends in a cup and loses speed
    if (pt.flight) {
      const sin = Math.max(0.02, sinT[Math.max(0, i - 3)]), cos = Math.sqrt(1 - sin * sin);
      const vx = v * cos, vz = v * sin, air = (2 * vz) / G, range = vx * air, gap = pt.flight.gap;
      let k = i;
      while (k < n - 1 && points[k + 1].flight) k++;
      flights.push({ index: i, v, piece: pt.piece });
      let flown = air;
      if (pt.flight.cone) {
        // The drawn flight knows where it leaves the lip, its direction and the catcher's
        // mouth (ballistic.js): the marble at this speed must fly into that mouth.
        const { miss, t: tc } = catchMiss(pt.flight, v);
        if (miss) return fail(miss, miss === 'stuck' ? 'falls short of the catcher' : 'flies over the catcher');
        flown = tc;
        if (record) for (const { u, c } of flightCentres(pt.flight, v, tc)) trace.push({ t: t + u, s: pos, v, x: c[0], y: c[1], z: c[2] - p.marbleRadius, c, ke: 0.5 * p.inertiaFactor * v * v, pe: G * (c[2] - p.marbleRadius), piece: pt.piece, flight: true });
      } else {
        const reach = pt.flight.into ? gap * 0.5 : gap * 0.8, limit = gap + 0.07; // the ring's flared lip catches short shots, estimate
        if (range < reach) return fail('stuck', 'falls short of the gap');
        if (range > limit && !pt.flight.into) return fail('too-fast', 'flies past the ring');
        // No catcher's mouth drawn: the drawn samples, spread over the time in the air.
        if (record) for (let q = i; q <= k; q++) rec(q, t + (air * (q - i + 1)) / (k - i + 2), v);
      }
      if (record) next = Math.max(next, k + 1);
      // On past the drawn flight (an arc, longer than the gap) to where it lands.
      t += flown; pos = Math.max(pos + gap, s[k]) + 1e-4; v *= 0.85; i = indexAt(path, pos, i);
      continue;
    }
    const speed2 = v * v;
    const lateral = speed2 * kH[i];
    // Only curved pieces carry a bank, so straights next to a curve are not judged as curves.
    const tilt = pt.bank === undefined ? 0 : Math.atan2(lateral, G) - pt.bank;
    if (!pt.hold && tilt > capture) return fail('too-fast', 'flies out of the curve');
    const normal = G * cosT[i] + speed2 * kV[i];
    air = normal < 0 && !pt.hold && !pt.fall ? air + v * dt : 0;
    if (air > p.maxHop) return fail('too-fast', 'jumps off the track');
    const resist = p.rollingResistance * Math.max(0, normal)
      + p.curveScrub * lateral;
    let a = (-G * sinT[i] - Math.sign(v || 1) * resist) / p.inertiaFactor;
    if (pt.hold) a = 0;
    if (pt.fall) a = G;                                  // free fall inside a stack
    v += a * dt;
    const pos0 = pos, v0 = v - a * dt;
    pos += v * dt;
    t += dt;
    if (record) passed(pos0, pos, t, v0, v);
    if (pos > peak) peak = pos;
    if (v > vMax) vMax = v;
    if (peak > 0.02 && !pt.hold && v < minMarginSpeed) minMarginSpeed = v;
    if (v <= 0 && pt.caught) { next = n; break; }       // resting inside the end piece is the goal
    if (v <= 0) return fail('stuck', 'runs out of energy');
    if (pos < 0) return fail('stuck', 'rolled back to the start');
  }
  if (t >= tMax) return fail('stuck', 'never finished');
  const lastPoint = points[n - 1];
  if (lastPoint.maxSpeed && v > lastPoint.maxSpeed) return fail('too-fast', 'bounces out of the end piece');
  if (record) for (; next < n; next++) if (!points[next].flight) rec(next, t, v); // the last samples, passed in the final step
  return { ok: true, t, vMax, minSpeed: minMarginSpeed, endSpeed: v, length: path.length, trace, sources, flights };
}

// Worst-case judgement: every corner must finish.
export function verify(path, corners = CORNERS) {
  const results = corners.map((c) => ({ corner: c.name, ...simulate(path, c) }));
  const failures = results.filter((r) => !r.ok);
  return { ok: failures.length === 0, results, failures };
}

// Runs one new stretch of track from the speeds the marble already has in each
// corner. Returns the exit speeds, or null if any corner fails.
export function verifyStep(points, speeds, corners = CORNERS) {
  const path = samplePath(points), out = [];
  for (let k = 0; k < corners.length; k++) {
    const r = simulate(path, speeds ? { ...corners[k], startSpeed: speeds[k] } : corners[k], speeds ? { ignoreStart: true } : {});
    if (!r.ok) return null;
    out.push(r.endSpeed);
  }
  return out;
}
