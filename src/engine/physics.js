// Path-constrained rolling-marble physics.
// The marble follows a sampled 3D centerline. Rolling inertia, rolling
// resistance, curve scrub and joint losses are modelled explicitly, so the
// energy budget along the track is the output, not an assumption.

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

export function simulate(path, overrides = {}, opts = {}) {
  const p = { ...NOMINAL, ...overrides };
  const dt = opts.dt ?? 0.002, tMax = opts.tMax ?? 90;
  const record = opts.record ?? false, every = opts.every ?? 8;
  const capture = (p.wallCaptureDeg * Math.PI) / 180;
  const { s, sinT, cosT, kH, kV, points, n } = path;
  const scaled = (pt, value) => (pt.source === 'hand' ? value * (p.handScale ?? 1) : value);
  let pos = 0, v = scaled(points[0], (opts.ignoreStart ? null : points[0].start) ?? p.startSpeed), t = 0, i = 0, peak = 0, vMax = 0, lastPiece = points[0].piece;
  const sources = [];
  let minMarginSpeed = Infinity, air = 0;
  const trace = record ? [] : null;
  const fail = (kind, why) => ({
    ok: false, kind, why, at: pos, piece: points[i].piece, t, v, vMax, trace,
    length: path.length, minSpeed: minMarginSpeed,
  });
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
      const reach = pt.flight.into ? gap * 0.5 : gap * 0.8, limit = gap + 0.07; // the ring's flared lip catches short shots, estimate
      if (range < reach) return fail('stuck', 'falls short of the gap');
      if (range > limit && !pt.flight.into) return fail('too-fast', 'flies past the ring');
      if (record) {
        const a = pt, far = points[Math.min(n - 1, indexAt(path, pos + gap, i))];
        for (let u = 0.05; u <= 1; u += 0.05) {
          trace.push({ t: t + u * air, s: pos + u * gap, v, x: a.x + (far.x - a.x) * u, y: a.y + (far.y - a.y) * u, z: a.z + vz * u * air - (G / 2) * (u * air) ** 2, ke: 0.5 * p.inertiaFactor * v * v, pe: G * a.z, piece: pt.piece });
        }
      }
      t += air; pos += gap + 1e-4; v *= 0.85; i = indexAt(path, pos, i);
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
    pos += v * dt;
    t += dt;
    if (pos > peak) peak = pos;
    if (v > vMax) vMax = v;
    if (peak > 0.02 && !pt.hold && v < minMarginSpeed) minMarginSpeed = v;
    if (v <= 0 && pt.caught) break;                      // resting inside the end piece is the goal
    if (v <= 0) return fail('stuck', 'runs out of energy');
    if (pos < 0) return fail('stuck', 'rolled back to the start');
    if (record && (Math.round(t / dt) % every === 0)) {
      const j = indexAt(path, pos, i), b = points[Math.min(n - 1, j + 1)], a0 = points[j];
      const f = (pos - s[j]) / ((s[Math.min(n - 1, j + 1)] - s[j]) || 1e-9);
      const lerp = (k) => a0[k] + (b[k] - a0[k]) * Math.min(1, Math.max(0, f));
      const z = lerp('z');
      trace.push({ t, s: pos, v, x: lerp('x'), y: lerp('y'), z, ke: 0.5 * p.inertiaFactor * v * v, pe: G * z, piece: a0.piece });
    }
  }
  if (t >= tMax) return fail('stuck', 'never finished');
  const lastPoint = points[n - 1];
  if (lastPoint.maxSpeed && v > lastPoint.maxSpeed) return fail('too-fast', 'bounces out of the end piece');
  return { ok: true, t, vMax, minSpeed: minMarginSpeed, endSpeed: v, length: path.length, trace, sources };
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
