// The five physical rules (D2 in docs/physics_rework.md), judged on the plastic of the
// Blender models (solids.js), never on cell heights or port names:
//   overlaps  no two parts' plastic shares space, except declared mate zones
//   support   every part rests on the floor or on a part under it, and does not tip
//   joints    every track end meets its partner port within a few mm (one height
//             convention: a port's z is the floor the marble rolls on)
//   freePath  the marble (20 mm) along the drawn path is never inside plastic, its own
//             piece's included: exact sphere against the models' triangles (collide.js)
//   flights   a launched marble flies a ballistic arc from the outlet into a catch cone
// Each rule takes a world from buildWorld() and returns a list of failures in one shape
// (see failure()), so the validator, the generator and judge() read the same answers.
// Names no piece: everything comes from the records, the placements and the models.
import { DIM, byKey, LIB } from '../catalog/parts.js';
import { rotXY, seatOf, onLevel, FACE } from '../catalog/frame.js';
import { placements as placementsOf, buildPath, edge, stackHeight } from './geometry.js';
import { portAt } from './fit.js';
import { fitPath } from '../ui/pathfit.js';
import { localSolid, V, MARBLE_MM, SEATS } from './solids.js';
import { samplePath, simulate, flightCentres } from './physics.js';
import { aimOf, turnVec, unit, coneOf as coneAt, bestShot, tossShot, CATCH } from './ballistic.js';
import { trianglesOf, nearestTri, nearestScan, nearestBelow, insideOf, centreAt } from './collide.js';
import { lipCentre } from './centre.js';

export const TOL = Object.freeze({
  overlapVoxels: 4,        // shared voxels (each about 5.6 mm a side) outside contact and mate zones before two parts collide
  contactLayers: 2,        // voxel layers above the higher part's bottom where resting parts may touch
  supportGapLayers: 1,     // a part still rests on what is this many voxel layers under it
  tipMarginCells: 0.1,     // the part's centre may sit this far outside what holds it
  jointPlanMm: 3,
  jointHeightMm: 3,
  // Rolling contact: the marble rests ON the channel floor, its centre a radius over the
  // drawn path, and a track's drawn leg lies within pathFitM (1.5 mm) of its model's own
  // marble path; so up to 1.5 mm of the marble may meet plastic. Deeper is a ghost marble.
  contactMm: 1.5,
  catchRadiusMm: CATCH.catchRadiusMm,         // open-catch mouth radius when the record gives none (vertical mouth)
  sideCatchRadiusMm: CATCH.sideCatchRadiusMm, // the same for a mouth facing a side (a ring)
  catchHalfAngleDeg: CATCH.catchHalfAngleDeg, // how far from the mouth's axis a marble may arrive
  pathFitM: 0.0015,        // a track model is laid on the drawn path when it fits this close
  // Two parts' plastic may go into each other on the models' triangles only as deep as that
  // pair goes in where the builders seat it (models/seats.json, measured by tools/seats.mjs), and
  // this much more: the bake's 0.05 mm steps and the 2 mm spacing of the points measured.
  seatSkinMm: 0.5,
  // and share no more volume than that seat (on a 2 mm grid) by this share and this much.
  // A seat's volume recurs exactly where the builders repeat a joint (a straight track's tongue in a plain block's cup:
  // the same count in most of its fixture instances, never more); the margin is for a pose the 72
  // measured tracks did not show. A part 3 mm farther in adds 10% or more (tests/overlap.test.js).
  seatVolumeShare: 0.03,
  seatVolumeMm3: 20,
});

const CELL = DIM.cell, SLOT = DIM.slot, R = MARBLE_MM / 1000;
const mm = (m) => Math.round(m * 10000) / 10;

// ------------------------------------------------------------------ voxel keys
// A voxel (i, j, k) as one number. Near the floor (cells -4 to 20 across, slots -2 to 14
// up) the numbers run densely, so a grid there is a flat array; anything farther gets a
// number past the dense block. Within a block, k + 1 is the key + 1.
const NX = 192, NY = 192, NZ = 128, OX = 32, OY = 32, OZ = 16, NYZ = NY * NZ, DENSE = NX * NYZ;
const FX = 2048 * 8192, FY = 2048;
const inDense = (i, j, k) => i >= -OX && i < NX - OX && j >= -OY && j < NY - OY && k >= -OZ && k < NZ - OZ;
const keyOf = (i, j, k) => (inDense(i, j, k) ? (i + OX) * NYZ + (j + OY) * NZ + (k + OZ) : DENSE + (i + 4096) * FX + (j + 4096) * FY + (k + 512));
const unkey = (key) => {
  if (key < DENSE) return [Math.floor(key / NYZ) - OX, Math.floor(key / NZ) % NY - OY, (key % NZ) - OZ];
  const f = key - DENSE;
  return [Math.floor(f / FX) - 4096, Math.floor(f / FY) % 8192 - 4096, (f % FY) - 512];
};

// The growing world's voxel owners: a flat array over the dense block (0 empty, n + 1
// owner n, -(m + 1) the m-th list of several owners) and a Map past it. get() answers as
// a Map of owner or owner list would.
let SHARED = null;
class DenseGrid {
  constructor() { this.a = SHARED ??= new Int32Array(DENSE); this.a.fill(0); this.multi = []; this.free = []; this.far = new Map(); }
  get(key) {
    if (key >= DENSE) return this.far.get(key);
    const v = this.a[key];
    return v === 0 ? undefined : v > 0 ? v - 1 : this.multi[-v - 1];
  }
  has(key) { return key >= DENSE ? this.far.has(key) : this.a[key] !== 0; }
  add(key, at) {
    if (key >= DENSE) { const o = this.far.get(key); if (o === undefined) this.far.set(key, at); else if (Array.isArray(o)) o.push(at); else this.far.set(key, [o, at]); return; }
    const v = this.a[key];
    if (v === 0) this.a[key] = at + 1;
    else if (v > 0) { const m = this.free.length ? this.free.pop() : this.multi.length; this.multi[m] = [v - 1, at]; this.a[key] = -(m + 1); }
    else this.multi[-v - 1].push(at);
  }
  remove(key, at) {
    if (key >= DENSE) { const o = this.far.get(key); if (o === at) this.far.delete(key); else if (Array.isArray(o)) { const r = o.filter((x) => x !== at); this.far.set(key, r.length === 1 ? r[0] : r); } return; }
    const v = this.a[key];
    if (v === at + 1) { this.a[key] = 0; return; }
    if (v >= 0) return;
    const m = -v - 1, r = this.multi[m].filter((x) => x !== at);
    if (r.length === 1) { this.a[key] = r[0] + 1; this.multi[m] = null; this.free.push(m); } else this.multi[m] = r;
  }
}
const centre = (i, j, k) => ({ x: (i + 0.5) * V * CELL, y: (j + 0.5) * V * CELL, z: (k + 0.5) * V * SLOT });

// One failure, shaped for a UI to point at the spot.
// at: world metres (x East, y South, z up, the engine's axes); cell: the floor cell and slot height.
export function failure(rule, kind, why, at, extra = {}) {
  const spot = at ? { x: at.x, y: at.y, z: at.z } : null;
  return { rule, kind, why, at: spot, cell: spot ? { c: Math.round(spot.x / CELL), r: Math.round(spot.y / CELL), slot: Math.round((spot.z / SLOT) * 100) / 100 } : null, s: null, ...extra };
}
const tag = (p) => p && { index: p.index, key: p.key, code: p.code, group: p.group, ...(p.seg !== undefined ? { seg: p.seg } : {}), label: p.label };

// ------------------------------------------------------------------ the world
// input: a track ({ posts, segs, marble }), or { track }, or { placements, path } for a
// layout built by hand (path: the marble centreline samples, as buildPath gives them).
export function buildWorld(input, tol = TOL) {
  const track = input?.posts ? input : input?.track ?? null;
  const placed = input?.placements ?? placementsOf(track);
  const path = input?.path ?? buildPath(track);
  const parts = [], grid = new Map(), bins = new Map();
  // Distance along the path, and the samples of each labelled leg.
  const s = new Float64Array(path.length), legs = new Map();
  path.forEach((q, i) => {
    if (i) s[i] = s[i - 1] + Math.hypot(q.x - path[i - 1].x, q.y - path[i - 1].y, q.z - path[i - 1].z);
    (legs.get(q.piece) ?? legs.set(q.piece, []).get(q.piece)).push(q);
  });
  placed.forEach((p, index) => {
    if ((p.c === null || p.c === undefined) && p.seg === undefined) return; // a clip-on riding a track
    const part = makePart(p, index, legs, tol);
    part.at = parts.length;
    gridAdd(grid, part, part.at);
    binAdd(bins, part, part.at);
    parts.push(part);
  });
  return { track, placed, path, s, legs, parts, grid, bins, tol, marble: input?.marble ?? track?.marble ?? 'plain' };
}

// One placement's plastic as voxel keys in the world, with its mate zones and the route
// carved through it. A track or spiral is laid where its model's own marble path fits
// the drawn leg (legs: label -> samples); anything else stands at its grid placement.
// A piece at a grid placement is the same plastic every time the search puts it there,
// so its voxels, zones and route are worked out once per placement.
const PLACED = new Map(), POSED = new Map();
// The middle of a part's voxels in plan (voxel units), for the tipping check.
function middleOf(keys) {
  let cx = 0, cy = 0;
  for (const key of keys) { const [i, j] = unkey(key); cx += i + 0.5; cy += j + 0.5; }
  return [cx / keys.length, cy / keys.length];
}
export function makePart(p, index, legs, tol = TOL) {
  let sig;
  if (p.seg !== undefined || p.spiral) {
    // A track is the same plastic wherever the same drawn leg puts it.
    const pts = legs.get(p.seg !== undefined ? `t${p.seg}` : p.spiral) ?? [];
    if (pts.length < 2) return makeOne(p, index, legs, tol);
    // Every sample, exactly: two legs alike to the last digit are the same plastic.
    sig = `${p.key}|${pts.map((q) => `${q.x},${q.y},${q.z}`).join('|')}`;
  } else if (p.c === null || p.c === undefined) return makeOne(p, index, legs, tol);
  else sig = `${p.key}|${p.rot ?? 0}|${p.c}|${p.r}|${p.y ?? 0}`;
  let base = PLACED.get(sig);
  if (!base) {
    if (PLACED.size > 50000) PLACED.clear();
    const one = makeOne(p, 0, legs, tol);
    base = { one, source: one.source, solid: one.solid, pose: one.pose, zones: one.zones, keys: one.keys, under: one.under, lo: one.lo, hi: one.hi, tri: one.tri };
    PLACED.set(sig, base);
  }
  const part = { ...p, index, label: labelOf(p), source: base.source, solid: base.solid, pose: base.pose, zones: base.zones, keys: base.keys, under: base.under, lo: base.lo, hi: base.hi, tri: base.tri, middle: base.middle ??= middleOf(base.keys) };
  Object.defineProperty(part, 'set', { get: () => base.one.set, enumerable: false });
  return part;
}

function makeOne(p, index, legs, tol) {
  const sol = localSolid(p.key), part = { ...p, index, label: labelOf(p), source: sol.source, solid: sol };
  const keys = [];
  let place;
  if (p.seg !== undefined || p.spiral) {
    const pts = legs.get(p.seg !== undefined ? `t${p.seg}` : p.spiral) ?? [];
    const local = sol.path?.map(([x, y, z]) => ({ x, y, z }));
    const f = local && pts.length >= 2 ? fitPath(local, pts, tol.pathFitM) : null;
    if (f) {
      const turn = ([x, y]) => { for (let q = 0; q < f.r; q++) [x, y] = [-y, x]; return [x, y]; };
      place = (x, y, z) => { const [a, b] = turn([x * CELL, y * CELL * f.m]); return [(a + f.t.x) / CELL, (b + f.t.y) / CELL, (z * SLOT + f.t.z) / SLOT]; };
      part.pose = { fitted: true, ...f };
      part.tri = posedTris(p.key, (X, Y, Z) => { let a = X - f.t.x, b = Y - f.t.y; for (let q = 0; q < (4 - f.r) % 4; q++) [a, b] = [-b, a]; return [a, b * f.m, Z - f.t.z]; },
        (x, y, z) => { let a = x, b = y * f.m; for (let q = 0; q < f.r; q++) [a, b] = [-b, a]; return [a + f.t.x, b + f.t.y, z + f.t.z]; });
      // The model's voxel centres turned once per pose (metres); each placement only shifts
      // them, and a shift keeps them apart, so every key is new. A pose seen before (the
      // same track from the same post) is the same plastic: worked out once.
      const sig = `${p.key}|${f.r}|${f.m}|${f.t.x}|${f.t.y}|${f.t.z}`, seen = POSED.get(sig);
      if (seen) Object.assign(part, seen);
      else {
        const turned = turnedVox(sol, f.r, f.m), sx = V * CELL, sz = V * SLOT, out = new Float64Array(turned.length / 3), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let q = 0; q < turned.length; q += 3) {
          const i = Math.floor((turned[q] + f.t.x) / sx), j = Math.floor((turned[q + 1] + f.t.y) / sx), k = Math.floor((turned[q + 2] + f.t.z) / sz);
          out[q / 3] = keyOf(i, j, k);
          if (i < lo[0]) lo[0] = i; if (i > hi[0]) hi[0] = i; if (j < lo[1]) lo[1] = j; if (j > hi[1]) hi[1] = j; if (k < lo[2]) lo[2] = k; if (k > hi[2]) hi[2] = k;
        }
        if (POSED.size > 50000) POSED.clear();
        const all = new Set(out), posed = { keys: out, lo, hi, under: out.filter((k) => !all.has(k - 1)) };
        POSED.set(sig, posed);
        Object.assign(part, posed);
      }
      part.fittedKeys = true;
    } else {
      // No model pose lies on the drawn path: sweep a channel floor under it instead.
      part.pose = { fitted: false };
      part.source = 'swept';
      for (const q of pts) for (let u = -11; u <= 11; u += 3) {
        const t = tangent(pts, q), x = q.x - t.y * u / 1000, y = q.y + t.x * u / 1000, z = q.z - 0.0015;
        keys.push(keyOf(Math.floor(x / CELL / V), Math.floor(y / CELL / V), Math.floor(z / SLOT / V)));
      }
    }
  } else {
    place = (x, y, z) => { const [a, b] = rotXY([x, y], p.rot ?? 0); return [a + p.c, b + p.r, z + (p.y ?? 0)]; };
    part.pose = { c: p.c, r: p.r, y: p.y, rot: p.rot ?? 0 };
    const rot = p.rot ?? 0, y0 = (p.y ?? 0) * SLOT;
    part.tri = posedTris(p.key, (X, Y, Z) => { const [a, b] = rotXY([X / CELL - p.c, Y / CELL - p.r], (4 - rot) % 4); return [a * CELL, b * CELL, Z - y0]; },
      (x, y, z) => { const [a, b] = rotXY([x / CELL, y / CELL], rot); return [(a + p.c) * CELL, (b + p.r) * CELL, z + y0]; });
  }
  let fast = null;
  if (place) {
    const grid = p.seg === undefined && !p.spiral && onGrid(p), r = grid && rotatedVox(sol, p.rot ?? 0);
    // Moved by whole voxels and staying inside the dense block: one offset for every key.
    if (r && r.dense && inDense(r.lo[0] + grid[0], r.lo[1] + grid[1], r.lo[2] + grid[2]) && inDense(r.hi[0] + grid[0], r.hi[1] + grid[1], r.hi[2] + grid[2])) fast = { r, off: grid };
    else if (!part.fittedKeys) {
      const v = sol.vox;
      for (let q = 0; q < v.length; q += 3) {
        const [x, y, z] = place((v[q] + 0.5) * V, (v[q + 1] + 0.5) * V, (v[q + 2] + 0.5) * V);
        keys.push(keyOf(Math.floor(x / V), Math.floor(y / V), Math.floor(z / V)));
      }
    }
    part.zones = sol.zones.map((zn) => {
      const a = place(...zn.lo), b = place(...zn.hi);
      let face = null;
      if (zn.face) { const o = place(...zn.at), q = place(zn.at[0] + zn.face[0], zn.at[1] + zn.face[1], zn.at[2]); face = [q[0] - o[0], q[1] - o[1]]; }
      return { port: zn.port, face, tab: zn.tab, flank: zn.flank, stack: zn.stack, kind: zn.kind, lo: a.map((u, d) => Math.min(u, b[d])), hi: a.map((u, d) => Math.max(u, b[d])) };
    });
  } else {
    // A swept channel joins its neighbours where the drawn leg starts and ends, as a
    // track's tongue would: a mate zone at each end, reaching into its own run.
    const pts = p.seg !== undefined ? legs.get(`t${p.seg}`) ?? [] : [];
    part.zones = pts.length >= 2 ? [[pts[0], pts[1]], [pts.at(-1), pts.at(-2)]].map(([e, n]) => {
      const d = Math.hypot(e.x - n.x, e.y - n.y) || 1, f = [(e.x - n.x) / d, (e.y - n.y) / d];
      const ex = e.x / CELL + f[0] * 0.5, ey = e.y / CELL + f[1] * 0.5, ez = e.z / SLOT;
      const a = [ex - f[0] * 0.85 - Math.abs(f[1]) * 0.47, ey - f[1] * 0.85 - Math.abs(f[0]) * 0.47], b = [ex + f[0] * 0.33 + Math.abs(f[1]) * 0.47, ey + f[1] * 0.33 + Math.abs(f[0]) * 0.47];
      return { port: 'end', face: f, lo: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), ez - 0.55], hi: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), ez + 0.45] };
    }) : [];
  }
  if (fast) {
    // Every voxel moved by one key offset: the turned voxels, their bounds and underside
    // are the piece's own, worked out once.
    const { r, off: [ox, oy, oz] } = fast, off = ox * NYZ + oy * NZ + oz;
    part.keys = r.keys.map((k) => k + off);
    part.under = r.under.map((k) => k + off);
    part.lo = [r.lo[0] + ox, r.lo[1] + oy, r.lo[2] + oz]; part.hi = [r.hi[0] + ox, r.hi[1] + oy, r.hi[2] + oz];
  } else if (!part.fittedKeys) {
    part.keys = Float64Array.from(new Set(keys));
    part.lo = [Infinity, Infinity, Infinity]; part.hi = [-Infinity, -Infinity, -Infinity];
    for (const key of part.keys) {
      const c = unkey(key);
      for (let d = 0; d < 3; d++) { part.lo[d] = Math.min(part.lo[d], c[d]); part.hi[d] = Math.max(part.hi[d], c[d]); }
    }
  }
  let set = null;
  Object.defineProperty(part, 'set', { get: () => (set ??= new Set(part.keys)), enumerable: false });
  part.under ??= part.keys.filter((k) => !part.set.has(k - 1)); // k - 1: the voxel under it
  return part;
}

// A grid placement on whole voxels (cells and slots in eighths) moves every voxel by one
// key offset, so its turned voxels are worked out once per piece and turn.
const onGrid = (p) => {
  const u = [p.c, p.r, p.y ?? 0].map((x) => x / V);
  return u.every((x) => Math.abs(x - Math.round(x)) < 1e-9) ? u.map(Math.round) : false;
};
const TURNED = new Map();
function turnedVox(sol, r, m) {
  const id = `${sol.key}|${r}|${m}`;
  if (TURNED.has(id)) return TURNED.get(id);
  const v = sol.vox, out = new Float64Array(v.length);
  for (let q = 0; q < v.length; q += 3) {
    let x = (v[q] + 0.5) * V * CELL, y = (v[q + 1] + 0.5) * V * CELL * m;
    for (let k = 0; k < r; k++) [x, y] = [-y, x];
    out[q] = x; out[q + 1] = y; out[q + 2] = (v[q + 2] + 0.5) * V * SLOT;
  }
  TURNED.set(id, out);
  return out;
}
const ROTATED = new Map();
function rotatedVox(sol, rot) {
  const id = `${sol.key}|${rot}`;
  if (ROTATED.has(id)) return ROTATED.get(id);
  const v = sol.vox, keys = new Float64Array(v.length / 3), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let q = 0; q < v.length; q += 3) {
    const [x, y] = rotXY([(v[q] + 0.5) * V, (v[q + 1] + 0.5) * V], rot), c = [Math.floor(x / V), Math.floor(y / V), v[q + 2]];
    keys[q / 3] = keyOf(...c);
    for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], c[d]); hi[d] = Math.max(hi[d], c[d]); }
  }
  const all = new Set(keys), dense = inDense(...lo) && inDense(...hi), out = { keys, lo, hi, dense, under: keys.filter((k) => !all.has(k - 1)) };
  ROTATED.set(id, out);
  return out;
}

// A part's triangles as the marble meets them: the model (collide.js), the world-to-local
// transform of this placement, and the world bounds (metres). null without a model.
function posedTris(key, toLocal, toWorld) {
  const m = trianglesOf(key);
  if (!m) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const x of [m.lo[0], m.hi[0]]) for (const y of [m.lo[1], m.hi[1]]) for (const z of [m.lo[2], m.hi[2]]) {
    const w = toWorld(x, y, z);
    for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], w[d]); hi[d] = Math.max(hi[d], w[d]); }
  }
  return { m, toLocal, toWorld, lo, hi };
}
let reachSlack = TOL.contactMm / 1000 - 1e-4;
// How far (mm) a marble centred at c (world metres) is inside part p's plastic, or null
// when it is clear. own: the marble is the one this part carries, so its moving parts
// (paddles it pushes, scoops that carry it, a flap it tips) move for it.
function depthIn(p, c, own) {
  const t = p.tri;
  if (!t || c[0] < t.lo[0] - R || c[0] > t.hi[0] + R || c[1] < t.lo[1] - R || c[1] > t.hi[1] + R || c[2] < t.lo[2] - R || c[2] > t.hi[2] + R) return null;
  // Only plastic nearer than the marble's radius less the contact allowed can fail it.
  const [x, y, z] = t.toLocal(c[0], c[1], c[2]), near = nearestTri(t.m, x, y, z, R - reachSlack, !own);
  return near ? { mm: (R - near.d) * 1000, mover: near.mover } : null;
}
// How far two parts' plastic goes into each other, on the models' triangles: a 2 mm grid
// (1 mm cost 20 to 50 ms a pair, too slow for the app's check; 2 mm still tells a part 3 mm
// farther in: a tongue in its cup 200 to 480 mm3, the tray 512 to 1384, tests/overlap.test.js)
// over the box where their triangles meet, each point tested inside both solids
// (collide.js insideOf, ray parity). { mm3 (the volume both fill), mm (the overlap's
// thickness: the deepest shared point's distance to the nearer of the two surfaces), at
// (world m, that point), into (B), points } or null when they share no plastic. The
// volume is the measure that grows with every millimetre one part goes into the other.
export function solidDepth(A, B, step = 0.002) {
  const a = A.tri, b = B.tri;
  if (!a || !b) return null;
  const lo = [0, 1, 2].map((d) => Math.max(a.lo[d], b.lo[d])), hi = [0, 1, 2].map((d) => Math.min(a.hi[d], b.hi[d]));
  if (lo.some((u, d) => u > hi[d])) return null;
  let n = 0, best = -1, at = null;
  // Plastic lies only in voxels its part fills (the bake fills every voxel its surface
  // passes through and those between), so a point outside a voxel both fill is skipped.
  const As = A.set, Bs = B.set, sx = V * CELL, sz = V * SLOT;
  for (let x = lo[0] + step / 2; x < hi[0]; x += step) for (let y = lo[1] + step / 2; y < hi[1]; y += step) for (let z = lo[2] + step / 2; z < hi[2]; z += step) {
    const key = keyOf(Math.floor(x / sx), Math.floor(y / sx), Math.floor(z / sz));
    if (!As.has(key) || !Bs.has(key)) continue;
    const p = a.toLocal(x, y, z);
    if (!insideOf(a.m, p[0], p[1], p[2])) continue;
    const q = b.toLocal(x, y, z);
    if (!insideOf(b.m, q[0], q[1], q[2])) continue;
    n++;
    // Only a point deeper than the deepest so far changes the answer: plastic of either
    // part nearer than that settles it is not, without the full search.
    if (best >= 0.01 || (best > 0 && (nearestScan(a.m, p[0], p[1], p[2], best) || nearestScan(b.m, q[0], q[1], q[2], best)))) continue;
    const ra = nearestTri(a.m, p[0], p[1], p[2], 0.01), rb = nearestTri(b.m, q[0], q[1], q[2], 0.01), d = Math.min(ra ? ra.d : 0.01, rb ? rb.d : 0.01);
    if (d > best) { best = d; at = [x, y, z]; }
  }
  if (!n) return null;
  return { mm: Math.round(best * 10000) / 10, at: { x: at[0], y: at[1], z: at[2] }, into: B, points: n, mm3: Math.round(n * (step * 1000) ** 3) };
}
// The volume (mm3) inside both parts, on a 1 mm grid over the box where their triangles meet.
export function solidVolume(A, B, step = 0.001, within = null, withinHi = null) {
  const a = A.tri, b = B.tri;
  if (!a || !b) return 0;
  const lo = [0, 1, 2].map((d) => Math.max(a.lo[d], b.lo[d], within?.[d] ?? -Infinity)), hi = [0, 1, 2].map((d) => Math.min(a.hi[d], b.hi[d], withinHi?.[d] ?? Infinity));
  let n = 0;
  for (let x = lo[0] + step / 2; x < hi[0]; x += step) for (let y = lo[1] + step / 2; y < hi[1]; y += step) for (let z = lo[2] + step / 2; z < hi[2]; z += step) {
    const p = a.toLocal(x, y, z);
    if (!insideOf(a.m, p[0], p[1], p[2])) continue;
    const q = b.toLocal(x, y, z);
    if (insideOf(b.m, q[0], q[1], q[2])) n++;
  }
  return Math.round(n * (step * 1000) ** 3);
}

// Floor cells (whole cells, world) to the parts whose triangles reach them, for the marble test.
const binKey = (i, j) => (i + 4096) * 8192 + (j + 4096);
function binAdd(bins, p, at) {
  const t = p.tri;
  if (!t) return;
  for (let i = Math.floor((t.lo[0] - R) / CELL); i <= Math.floor((t.hi[0] + R) / CELL); i++) for (let j = Math.floor((t.lo[1] - R) / CELL); j <= Math.floor((t.hi[1] + R) / CELL); j++) {
    const k = binKey(i, j);
    (bins.get(k) ?? bins.set(k, []).get(k)).push(at);
  }
}
function binRemove(bins, p, at) {
  const t = p.tri;
  if (!t) return;
  for (let i = Math.floor((t.lo[0] - R) / CELL); i <= Math.floor((t.hi[0] + R) / CELL); i++) for (let j = Math.floor((t.lo[1] - R) / CELL); j <= Math.floor((t.hi[1] + R) / CELL); j++) {
    const k = binKey(i, j), l = bins.get(k), n = l?.lastIndexOf(at) ?? -1;
    if (n >= 0) l.splice(n, 1);
  }
}
const binOf = (c) => binKey(Math.floor(c[0] / CELL), Math.floor(c[1] / CELL));

function gridAdd(grid, part, at) {
  if (grid.add) { for (const key of part.keys) grid.add(key, at); return; }
  for (const key of part.keys) {
    const o = grid.get(key);
    if (o === undefined) grid.set(key, at); else if (Array.isArray(o)) o.push(at); else grid.set(key, [o, at]);
  }
}
function gridRemove(grid, part, at) {
  if (grid.remove) { for (const key of part.keys) grid.remove(key, at); return; }
  for (const key of part.keys) {
    const o = grid.get(key);
    if (o === at) grid.delete(key);
    else if (Array.isArray(o)) { const r = o.filter((x) => x !== at); grid.set(key, r.length === 1 ? r[0] : r); }
  }
}

function tangent(pts, q) {
  const i = pts.indexOf(q), a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
  return { x: dx / d, y: dy / d };
}

const labelOf = (p) => `${p.code}${p.seg !== undefined ? ` (track ${p.seg + 1})` : ` (step ${p.group + 1})`}`;
const inBox = (zn, x, y, z) => x >= zn.lo[0] && x <= zn.hi[0] && y >= zn.lo[1] && y <= zn.hi[1] && z >= zn.lo[2] && z <= zn.hi[2];
// A shared voxel two parts may both fill: inside a mate zone of each (solids.js, measured
// on the models: a track's tongue, the cup or window it lies in), the two ports facing
// each other, or one opening up or down (a catch, a drop); or legs over the rails or
// crown of the piece they stand on (stack zones, which meet only each other); or a tab
// loop against the face of the piece on the next cell (a flank zone meets only a tab zone
// facing it whose tab, on the triangles, fits the room the flank leaves; solids.js).
const facing = (za, zb) => za.face[0] * zb.face[0] + za.face[1] * zb.face[1] < -0.5;
// Two cups (kind 'port') never mate: a cup takes a tongue, a tip or a lip, not another cup.
const pairs = (za, zb) => (za.flank || zb.flank
  ? (za.flank ? zb.tab <= za.flank : za.tab <= zb.flank) && facing(za, zb)
  : !za.tab && !zb.tab && !!za.stack === !!zb.stack && !(za.kind === 'port' && zb.kind === 'port') && (!za.face || !zb.face || facing(za, zb)));
const mated = (A, B, [i, j, k]) => {
  // The parts of one assembly clip together as the toy is sold (data/assemblies/).
  if (A.assembly && A.assembly === B.assembly) return true;
  const x = (i + 0.5) * V, y = (j + 0.5) * V, z = (k + 0.5) * V;
  // Stack zones (legs over rails or crown points) meet only stack zones.
  return A.zones.some((za) => inBox(za, x, y, z) && B.zones.some((zb) => inBox(zb, x, y, z) && pairs(za, zb)));
};
const ownersOf = (w, key) => { const o = w.grid.get(key); return o === undefined ? [] : Array.isArray(o) ? o : [o]; };
const boxesMeet = (a, b) => [0, 1, 2].every((d) => a.lo[d] <= b.hi[d] && b.lo[d] <= a.hi[d]);

// Where the marble path first comes near a part (metres along the path), for ordering.
function firstTouch(w, part) {
  const label = part.seg !== undefined ? `t${part.seg}` : `p${part.group}`;
  const i = w.path.findIndex((q) => q.piece === label || q.piece?.startsWith(label) && !/\d/.test(q.piece[label.length] ?? ''));
  return i < 0 ? null : w.s[i];
}

// How deep the pair goes into each other on the triangles, worked out once per pair of
// models in the same relative pose (blocks in stacks and tongues in cups recur endlessly).
const DEPTHS = new Map();
const poseOf = (p) => (p.pose?.fitted ? [p.pose.t.x, p.pose.t.y, p.pose.t.z, p.pose.r, p.pose.m] : [(p.c ?? 0) * CELL, (p.r ?? 0) * CELL, (p.y ?? 0) * SLOT, p.rot ?? 0, 1]);
function depthOf(A, B) {
  const [P, Q] = A.key < B.key || (A.key === B.key && A.index < B.index) ? [A, B] : [B, A], a = poseOf(P), b = poseOf(Q);
  const sig = `${P.key}|${a[3]}|${a[4]}|${Q.key}|${b[3]}|${b[4]}|${[0, 1, 2].map((d) => Math.round((a[d] - b[d]) * 1e5)).join(',')}`;
  let d = DEPTHS.get(sig);
  if (d === undefined) {
    if (DEPTHS.size > 200000) DEPTHS.clear();
    const r = solidDepth(P, Q);
    d = r ? { mm: r.mm, mm3: r.mm3, into: r.into === P ? 0 : 1, off: [r.at.x - a[0], r.at.y - a[1], r.at.z - a[2]] } : null;
    DEPTHS.set(sig, d);
  }
  return d && { mm: d.mm, mm3: d.mm3, into: d.into ? Q : P, at: { x: a[0] + d.off[0], y: a[1] + d.off[1], z: a[2] + d.off[2] } };
}
// The pair's measured seat (models/seats.json), mm: how deep the two go in where the builders seat them.
// Two blocks on different cells have no seat: they stand tab to face with 0.2 mm to spare
// (round 3), so only blocks stacked in one cell take the block-on-block seat.
export const seatOfPair = (A, B) => (A.block && B.block && (A.c !== B.c || A.r !== B.r) ? null : SEATS.pairs?.[[A.key, B.key].sort().join('|')] ?? null);
export const seatDepthOf = (A, B) => seatOfPair(A, B)?.mm ?? 0;
const seatsOn = () => !(globalThis.MARBLE_SEATS_OFF || (typeof process !== 'undefined' && process.env?.MARBLE_SEATS_OFF));
// Plastic deeper into plastic than the pair's seat: hard material through hard material.
function tooDeep(A, B, tol) {
  if (!seatsOn() || !A.tri || !B.tri || !boxesMeet(A.tri, B.tri)) return null;
  const d = depthOf(A, B);
  if (!d) return null;
  const s = seatOfPair(A, B), seat = s?.mm ?? 0, seatMm3 = s?.mm3 ?? 0;
  const vol = seatMm3 * (1 + tol.seatVolumeShare) + tol.seatVolumeMm3;
  if (d.mm <= seat + tol.seatSkinMm && d.mm3 <= vol) return null;
  const into = d.into, other = into === A ? B : A;
  return failure('overlap', 'overlap', `${other.code} goes ${d.mm} mm into ${into.code} (${d.mm3} mm3${s ? `; they seat ${seat} mm, ${seatMm3} mm3` : ''}): hard plastic through hard plastic`, d.at,
    { part: tag(A), other: tag(B), data: { depthMm: d.mm, volumeMm3: d.mm3, seatMm: seat, seatMm3, into: into.code, samePost: A.group === B.group } });
}

// The verdict on two parts sharing voxels (n outside contact and mate zones, any at all):
// where both have the models' triangles, the triangles decide (tooDeep), since 5.6 mm
// voxels both miss millimetres and see touching faces as shared; only plastic sharing a
// quarter of the smaller part's voxels (two parts in one place, where every corner lies
// on the other's surface and no depth shows) fails on the voxels alone. Without triangles
// (a box or a swept channel) the voxels decide. A failure, 'voxels', or null.
// The growing world (the search) asks the same: on the voxels alone, a step whose pair the
// triangles fail passed, and every track grown from it failed checkAll at the end (a
// both-sets start spent its whole budget under one such step). A pair in a pose seen
// before is cached (depthOf), and the depth search skips points that cannot be deeper.
function judgePair(A, B, n, any, smaller, tol, triangles = true) {
  if (!any) return null;
  // The parts of one assembly clip together as the toy is sold (data/assemblies/).
  if (A.assembly && A.assembly === B.assembly) return null;
  if (triangles && A.tri && B.tri && seatsOn()) return n >= Math.max(tol.overlapVoxels, 0.25 * smaller) ? 'voxels' : tooDeep(A, B, tol);
  return n >= tol.overlapVoxels ? 'voxels' : null;
}

// ------------------------------------------------------------------ rule (a): plastic never shares space
export function overlaps(w) {
  const out = [], { tol } = w;
  for (let a = 0; a < w.parts.length; a++) for (let b = a + 1; b < w.parts.length; b++) {
    const A = w.parts[a], B = w.parts[b];
    if (!boxesMeet(A, B)) continue;
    const [small, big] = A.set.size < B.set.size ? [A, B] : [B, A];
    const top = Math.max(A.lo[2], B.lo[2]) + tol.contactLayers;
    let n = 0, sx = 0, sy = 0, sz = 0, any = 0;
    for (const key of small.set) {
      if (!big.set.has(key)) continue;
      any++;
      const c = unkey(key);
      if (c[2] < top || mated(A, B, c)) continue;
      n++; const p = centre(...c); sx += p.x; sy += p.y; sz += p.z;
    }
    const verdict = judgePair(A, B, n, any, small.set.size, tol);
    if (verdict === 'voxels') out.push(failure('overlap', 'overlap', `${A.code} and ${B.code} are in the same space: hard plastic through hard plastic`, { x: sx / n, y: sy / n, z: sz / n },
      { part: tag(A), other: tag(B), data: { voxels: n, volumeMm3: Math.round(n * (V * CELL * 1000) ** 2 * V * SLOT * 1000), samePost: A.group === B.group } }));
    else if (verdict) out.push(verdict);
  }
  return out;
}

// ------------------------------------------------------------------ rule (b): gravity
export function support(w) {
  const { tol } = w, n = w.parts.length, holders = Array.from({ length: n }, () => new Set()), onFloor = new Array(n).fill(false), contacts = Array.from({ length: n }, () => []);
  const owners = (key) => ownersOf(w, key);
  const below = new Array(n).fill(false), sunk = Array.from({ length: n }, () => new Set());
  w.parts.forEach((p, a) => {
    for (const key of p.set) {
      const [i, j, k] = unkey(key);
      if (p.set.has(keyOf(i, j, k - 1))) continue; // not an underside voxel
      if (k < 0) { below[a] = true; continue; }   // under the floor: nothing stands there
      if (k === 0) { onFloor[a] = true; contacts[a].push([i, j]); continue; }
      for (let d = 0; d <= tol.supportGapLayers + 1; d++) {
        const g = keyOf(i, j, k - d);
        if (!w.grid.has(g)) continue;
        const by = owners(g).filter((o) => o !== a && w.parts[o].lo[2] <= k);
        if (!by.length) continue;
        by.forEach((o) => holders[a].add(o)); contacts[a].push([i, j]);
        // The part's feet (its lowest layer) rest on what holds them: that plastic ends
        // within the contact layers over them, or goes on only where the two interlock
        // (a mate zone of each, such as rails or crown points under legs). Plastic going
        // on higher means the part is sunk into it.
        if (k === p.lo[2]) for (const o of by) {
          const up = [i, j, k + tol.contactLayers + 1], q = w.parts[o];
          // A stacking piece's body ends at its stack top; above it only rails or crown
          // points rise, which the piece above takes between its legs.
          const top = byKey(q.key)?.ports?.find((x) => x.type === 'stack-top'), body = top && q.c !== null && q.c !== undefined ? ((q.y ?? 0) + top.at[2]) / V : null;
          const inside = body !== null ? up[2] + 0.5 <= body : !mated(p, q, up);
          if (d === 0 && owners(keyOf(...up)).includes(o) && inside) sunk[a].add(o);
        }
        break;
      }
    }
    // A clip-on hangs on its host: any touch holds it.
    if (p.decor) for (const key of p.set) {
      const [i, j, k] = unkey(key);
      for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const g = keyOf(i + di, j + dj, k + dk);
        if (w.grid.has(g)) owners(g).filter((o) => o !== a).forEach((o) => holders[a].add(o));
      }
    }
  });
  // Grounded: on the floor, or held by something grounded.
  const grounded = onFloor.slice();
  for (let changed = true; changed;) {
    changed = false;
    for (let a = 0; a < n; a++) if (!grounded[a] && [...holders[a]].some((o) => grounded[o])) { grounded[a] = changed = true; }
  }
  const out = [];
  w.parts.forEach((p, a) => {
    const c = unkey([...p.set][0] ?? keyOf(0, 0, 0)), low = p.lo[2];
    if (below[a]) {
      out.push(failure('support', 'unsupported', `${p.code} is below the floor: plastic cannot go through the floor`, centre(p.lo[0], p.lo[1], low), { part: tag(p), data: { belowMm: mm(-low * V * SLOT) } }));
      return;
    }
    if (sunk[a].size && !p.decor) {
      const on = [...sunk[a]].map((o) => w.parts[o].code);
      out.push(failure('support', 'unsupported', `${p.code} is sunk into ${on.join(' and ')}: it would rest on top of it`, centre(p.lo[0], p.lo[1], low), { part: tag(p), other: tag(w.parts[[...sunk[a]][0]]), data: { on } }));
      return;
    }
    if (!holders[a].size && !onFloor[a]) {
      // How far it would fall: the gap under its lowest voxels to the next plastic or the floor.
      let gap = Infinity, spot = null;
      for (const key of p.set) {
        const [i, j, k] = unkey(key);
        if (k !== low) continue;
        let d = 1;
        while (k - d >= 0 && !w.grid.has(keyOf(i, j, k - d)) && d < 400) d++;
        if (d < gap) { gap = d; spot = centre(i, j, k); }
      }
      out.push(failure('support', 'unsupported', `${p.code} floats: nothing holds it up, it would fall about ${mm((gap - 1) * V * SLOT)} mm`, spot ?? centre(...c), { part: tag(p), data: { gapMm: mm((gap - 1) * V * SLOT) } }));
      return;
    }
    if (!grounded[a]) {
      out.push(failure('support', 'unsupported', `${p.code} rests only on pieces that are not held up`, centre(p.lo[0], p.lo[1], low), { part: tag(p), data: { on: [...holders[a]].map((o) => w.parts[o].code) } }));
      return;
    }
    if (p.decor || p.seg !== undefined || p.spiral) return; // tracks and clip-ons hang between their ends
    // Tipping: the part's middle must lie over what holds it.
    let cx = 0, cy = 0;
    for (const key of p.set) { const [i, j] = unkey(key); cx += i + 0.5; cy += j + 0.5; }
    cx /= p.set.size; cy /= p.set.size;
    const xs = contacts[a].map(([i]) => i), ys = contacts[a].map(([, j]) => j), m = tol.tipMarginCells / V;
    if (cx < Math.min(...xs) - m || cx > Math.max(...xs) + 1 + m || cy < Math.min(...ys) - m || cy > Math.max(...ys) + 1 + m) {
      out.push(failure('support', 'tips', `${p.code} would tip over: its middle is not over what holds it`, { x: cx * V * CELL, y: cy * V * CELL, z: low * V * SLOT }, { part: tag(p) }));
    }
  });
  return out;
}

// ------------------------------------------------------------------ rule (c): joints meet in space
const blockAt = (stack, k) => {
  const key = stack[k], rec = byKey(key), cups = (rec?.ports ?? []).filter((q) => q.type === 'block-top-slot');
  const z = cups.length ? seatOf(Math.max(...cups.map((q) => q.at[2]))) : seatOf(rec?.shape?.heightSlots ?? 1);
  return { key, code: rec?.code ?? key, z: stackHeight(stack.slice(0, k)) + z, recZ: z };
};
// The port a track meets on a post: { code, port, x, y (cells), z (slots), recZ } or null.
function anchorOf(post, side) {
  // The marble meets a side port on the seat of the track level its z names (frame.js).
  const fitPort = (fit, id) => { const a = portAt(fit, id); return a && { code: byKey(fit.key)?.code ?? fit.key, port: `${fit.key}.${id}`, x: a.x, y: a.y, z: fit.base + seatOf(a.port.z), recZ: a.port.z }; };
  const face = side === 'out' ? post.out : post.in;
  const cupEdge = (stack, k, cell = post) => {
    const b = blockAt(stack, k), e = edge(cell, face, side === 'out' ? 1 : -1);
    return { code: b.code, port: `${b.key} cup`, x: e.x / CELL, y: e.y / CELL, z: b.z, recZ: b.recZ };
  };
  if (side === 'out') switch (post.kind) {
    case 'station': return fitPort(post.fit, post.fit.to);
    case 'jump': return post.drops ? cupEdge(post.stack, post.stack.length - 1) : fitPort(post.catcher, post.catcher.to);
    case 'fall': return cupEdge(post.stack, post.stack.length - (post.fit ? 1 : 2));
    case 'spiral': return cupEdge(post.stack, post.stack.length - 2);
    case 'end': return null;
    default: return post.stack.length ? cupEdge(post.stack, post.stack.length - 1) : null;
  }
  switch (post.kind) {
    case 'station': return post.first ? null : fitPort(post.fit, post.fit.from);
    case 'jump': return fitPort(post.ramp, post.ramp.from);
    case 'toss': return fitPort(post.fit, post.fit.from);
    case 'fall': return post.fit?.from ? fitPort(post.fit, post.fit.from) : cupEdge(post.stack, post.stack.length - 1);
    case 'end': return post.fit && !post.endCells ? fitPort(post.fit, post.fit.from) : cupEdge(post.stack, post.stack.length - 1);
    default: return post.stack.length ? cupEdge(post.stack, post.stack.length - 1) : null;
  }
}

// A port whose z names no track level (neither a seat nor a level, frame.js onLevel).
const snapOf = (recZ) => (onLevel(recZ) ? null : `port z ${recZ} names no track level`);

export function joints(w) {
  const out = [], { tol, track } = w;
  if (!track) return out;
  const all = [];
  track.segs.forEach((seg, i) => {
    const leg = w.legs.get(`t${i}`);
    if (!leg?.length) return;
    const first = w.path.indexOf(leg[0]), before = first > 0 ? w.path[first - 1] : leg[0];
    out.push(...jointsOfSeg(seg, i, track.posts[i], track.posts[i + 1], before, leg, tol, (pt) => w.s[Math.max(0, w.path.indexOf(pt))], w.parts.find((p) => p.seg === i), all));
  });
  w.jointTable = all;
  return out;
}

// Track i's two ends against the ports they meet: its start (the sample before its leg)
// on post `from`'s outlet, its end on post `to`'s inlet. sOf(pt): metres along the path.
function jointsOfSeg(seg, i, from, to, before, leg, tol, sOf, part, table) {
  const out = [], end = leg.at(-1);
  for (const [side, post, pt] of [['out', from, before], ['in', to, end]]) {
    const a = anchorOf(post, side);
    if (!a) continue;
    const dPlan = Math.hypot(pt.x - a.x * CELL, pt.y - a.y * CELL), dz = pt.z - a.z * SLOT, snap = snapOf(a.recZ);
    const j = { seg: i, track: seg.code, side, post: side === 'out' ? i : i + 1, piece: a.code, port: a.port, planMm: mm(dPlan), heightMm: mm(dz), convention: snap };
    table?.push(j);
    if (dPlan * 1000 <= tol.jointPlanMm && Math.abs(dz) * 1000 <= tol.jointHeightMm && !snap) continue;
    const where = dz > 0 ? 'above' : 'below';
    out.push(failure('joint', 'joint-gap', `${seg.code} ${side === 'out' ? 'starts' : 'ends'} ${Math.abs(mm(dz))} mm ${where} ${a.port}${dPlan * 1000 > tol.jointPlanMm ? ` and ${mm(dPlan)} mm beside it` : ''}${snap ? ` (${snap})` : ''}`,
      { x: pt.x, y: pt.y, z: pt.z }, { s: sOf(pt), part: tag(part) ?? { code: seg.code, seg: i }, data: j }));
  }
  return out;
}

// ------------------------------------------------------------------ rule (d): no ghost marbles
// The marble (MARBLE_MM radius) at every sample of the drawn path but a jump's flight,
// against the triangles of every part near it. Every part it is inside is reported, once
// per leg of the path, at its deepest.
export function freePath(w) {
  const worst = new Map(), { tol } = w;
  w.path.forEach((q, n) => {
    if (q.flight) return; // a jump's flight is rule (e)'s
    const c = centreAt(w.path, n, R);
    for (const a of w.bins.get(binOf(c)) ?? []) {
      const p = w.parts[a], own = carrierOf(q.piece, p), d = depthIn(p, c, own);
      if (!d || d.mm <= tol.contactMm) continue;
      const id = `${p.index}|${q.piece}`, prev = worst.get(id);
      if (prev && prev.data.depthMm >= d.mm) continue;
      worst.set(id, ghost(p, q, c, own, d, w.s[n]));
    }
  });
  return [...worst.values()].sort((a, b) => (a.s ?? 0) - (b.s ?? 0));
}
const ghost = (p, q, c, own, d, s) => failure('plastic', 'hit-plastic', `the marble runs through the plastic of ${p.code}${own ? ', the piece carrying it' : ''}: no room for it there`, { x: c[0], y: c[1], z: c[2] },
  { s, part: tag(p), pathPiece: q.piece, data: { own, depthMm: Math.round(d.mm * 10) / 10, mover: d.mover } });
const carrierOf = (label, p) => {
  const m = /^([tp])(\d+)/.exec(label ?? '');
  return !!m && (m[1] === 't' ? p.seg === Number(m[2]) : p.group === Number(m[2]) && p.seg === undefined);
};

// ------------------------------------------------------------------ rule (f): the marble rests on plastic
// Along every rolling stretch (not a flight, a fall, a throw, a carry or a hang) the marble
// touches something under it: the nearest plastic below its centre (collide.js
// nearestBelow), or the floor the plates make (z 0), is within the contact allowed of its
// sphere. A drawn route that floats over the plastic is a marble rolling on air.
export const rolling = (q) => !q.flight && !q.fall && !q.air && !q.hang && q.hold === undefined;
const REST_REACH = 0.03; // m from the marble's centre: farther plastic counts as none
// The gap (m) from the marble centred at c down to the nearest plastic under it. With
// `enough`, it stops at the first plastic within that gap (all the rule needs to know) and
// looks farther only when there is none.
function gapUnder(parts, w, c, near, enough = Infinity) {
  if (enough < Infinity) {
    const g = gapWithin(parts, w, c, near, Math.min(REST_REACH, R + enough + 1e-4));
    if (g <= enough) return g;
  }
  return gapWithin(parts, w, c, near, REST_REACH);
}
function gapWithin(parts, w, c, near, reach) {
  let best = c[2] - R; // the floor plates' top
  const ci = Math.floor(c[0] / CELL), cj = Math.floor(c[1] / CELL), seen = new Set();
  for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) for (const a of w.bins.get(binKey(i, j)) ?? []) {
    if (seen.has(a)) continue;
    seen.add(a);
    const t = parts[a].tri;
    if (!t || c[0] < t.lo[0] - reach || c[0] > t.hi[0] + reach || c[1] < t.lo[1] - reach || c[1] > t.hi[1] + reach || c[2] < t.lo[2] || c[2] > t.hi[2] + reach) continue;
    const [x, y, z] = t.toLocal(c[0], c[1], c[2]), d = nearestBelow(t.m, x, y, z, Math.min(reach, best + R));
    if (d !== null && d - R < best) { best = d - R; if (near) near.part = parts[a]; }
  }
  // A part with no model (a box from its record, a swept channel) holds the marble where its
  // voxels stand under it: the gap to the top of the highest such voxel.
  const vi = Math.floor(c[0] / (V * CELL)), vj = Math.floor(c[1] / (V * CELL)), base = c[2] - R;
  for (let k = Math.floor(base / (V * SLOT)); k >= -1 && base - (k + 1) * V * SLOT < best; k--) {
    const o = w.grid.get(keyOf(vi, vj, k)), list = o === undefined ? [] : Array.isArray(o) ? o : [o], hold = list.find((a) => !parts[a].tri);
    if (hold === undefined) continue;
    best = Math.max(0, base - (k + 1) * V * SLOT);
    if (near) near.part = parts[hold];
    break;
  }
  return best;
}
const floats = (q, c, gap, s, n, part) => failure('rests', 'fell', `the marble rolls on nothing on ${q.piece}: the nearest plastic under it${part ? ` (${part.code})` : ''} is ${gap >= REST_REACH - R ? `over ${mm(REST_REACH - R)}` : mm(gap)} mm below it`, { x: c[0], y: c[1], z: c[2] },
  { s, pathPiece: q.piece, part: tag(part), data: { gapMm: mm(gap), samples: n } });
export function rests(w) {
  return restFailures(w.path, (n) => { const near = {}, c = centreAt(w.path, n, R); return { c, gap: gapUnder(w.parts, w, c, near, w.tol.contactMm / 1000), part: near.part }; }, w.tol, (n) => w.s[n],
    (label) => w.parts.some((p) => !p.tri && carrierOf(label, p)));
}
// The rolling samples of path whose marble rests on nothing (gapOf(n): { c, gap (m), part }),
// worst per leg. A marble rolling into a drop leaves the floor at the drop's edge and is
// falling from there, while the drawn floor line runs on to where the drop is drawn (the
// middle of a hole): unsupported rolling samples running straight into a fall, over no more
// than a marble's radius in plan, are that start of the fall. from: the first sample to judge.
function restFailures(path, gapOf, tol, sOf, modelless = null) {
  const from = 0;
  const worst = new Map();
  let run = [];
  const flush = (next) => {
    if (!run.length) return;
    const a = path[run[0].n], b = path[run.at(-1).n], intoFall = !!next?.fall && Math.hypot(b.x - a.x, b.y - a.y) <= R;
    if (!intoFall) for (const { n, g } of run) {
      const q = path[n], prev = worst.get(q.piece);
      if (prev) { prev.data.samples++; if (prev.data.gapMm >= mm(g.gap)) continue; }
      worst.set(q.piece, floats(q, g.c, g.gap, sOf(n), (prev?.data.samples ?? 0) + 1, g.part));
    }
    run = [];
  };
  for (let n = from; n < path.length; n++) {
    const q = path[n];
    if (!rolling(q)) { flush(q); continue; }
    const g = gapOf(n);
    // A piece with no Blender model (a box from its record, a swept channel) has no floor
    // to measure: the marble on its own route is taken to rest on it.
    if (g.gap * 1000 > tol.contactMm && !(modelless && modelless(q.piece))) run.push({ n, g }); else flush(q);
  }
  flush(null);
  return [...worst.values()].sort((a, b) => (a.s ?? 0) - (b.s ?? 0));
}

// ------------------------------------------------------------------ rule (e): no magic flights
// The arc and the catch cones live in ballistic.js, shared with the generator and the
// drawn path; this rule flies every launch again from the records.
const coneOf = (fit, id, tol) => coneAt(fit, id, tol);

// Each launched flight's speed as it leaves the lip, from one nominal run of the physics
// over the whole path (physics.js simulate): the speed the app's animated run flies too.
function flightSpeeds(w) {
  const r = simulate(samplePath(w.path)), out = new Map();
  for (const f of r.flights ?? []) out.set(f.piece, f.v);
  return out;
}

export function flights(w) {
  const out = [], { tol, track } = w;
  if (!track) return out;
  w.flightTable = [];
  let speeds = null;
  track.posts.forEach((post, i) => {
    if (post.kind !== 'jump' && post.kind !== 'toss') return;
    const leg = w.legs.get(post.kind === 'jump' ? `p${i}r` : `p${i}l`) ?? [];
    const idx = w.path.indexOf(post.kind === 'jump' ? leg.at(-1) : leg[0]);
    if (post.kind === 'jump') speeds ??= flightSpeeds(w);
    const fl = w.legs.get(`p${i}j`) ?? [], after = fl.length ? w.path.indexOf(fl.at(-1)) + 1 : -1;
    out.push(...flightOf(post, i, w.legs, tol, post.kind === 'jump' ? speeds.get(`p${i}j`) ?? null : null, {
      s: idx >= 0 ? w.s[idx] : null, part: (code) => tag(w.parts.find((p) => p.group === i && p.code === code)), table: w.flightTable,
      next: after > 0 && after < w.path.length ? centreAt(w.path, after, R) : null,
      plastic: (c, label) => deepestAt(w.parts, w.bins.get(binOf(c)) ?? [], c, label, tol),
    }));
  });
  return out;
}
// The deepest plastic (mm past the contact allowed) a marble centred at c meets among
// parts listed by index: { p, d } or null. label: the path leg it is on (its own piece's
// moving parts move for it).
function deepestAt(parts, list, c, label, tol) {
  let worst = null;
  for (const a of list) {
    const p = parts[a], own = carrierOf(label, p), d = depthIn(p, c, own);
    if (d && d.mm > tol.contactMm && (!worst || d.mm > worst.d.mm)) worst = { p, d, own };
  }
  return worst;
}

// The flight of post i, a jump or a toss: from its outlet along its aim (or the ramp's
// slope, at speed m/s, the speed it leaves the lip with) into its catcher's cone, and for a
// jump the marble along that arc and on into the catcher's mouth (ctx.next, the first
// centre past the drawn flight) against the plastic (ctx.plastic). Failures, and a row in
// ctx.table whose centres are the marble's centres along the flight.
function flightOf(post, i, legs, tol, speed, ctx = {}) {
  let from, cone, dir, speeds, lp, what;
  if (post.kind === 'jump') {
    const leg = legs.get(`p${i}r`) ?? [];
    const aim = aimOf(byKey(post.ramp.key));
    const a = leg.at(-1), b = leg.at(-2) ?? leg[0], c = leg.at(-4) ?? leg[0];
    dir = aim ? unit(turnVec(aim.v, post.ramp.rot)) : a && c ? unit([a.x - c.x, a.y - c.y, a.z - c.z]) : [1, 0, 0];
    const v = aim?.speed ?? speed;
    speeds = v ? [v] : [];
    // It leaves the lip with its centre a radius off the ramp's floor (centre.js).
    if (a && b) from = lipCentre(a, b, R);
    else { const lip = portAt(post.ramp, post.ramp.to); from = { x: lip.x * CELL, y: lip.y * CELL, z: lip.z * SLOT + R }; }
    cone = coneOf(post.catcher, post.catcher.from, tol); lp = post.ramp; what = 'jump';
  } else {
    // A hand sets the speed: any speed from gentle to hard counts, unless the record gives one.
    ({ from, dir, speeds, cone } = tossShot(post.fit, post.hood, tol)); lp = post.fit; what = 'toss';
  }
  const best = speeds.length ? bestShot(from, dir, speeds, cone) : null, code = byKey(lp.key)?.code;
  const row = { post: i, what, from: `${lp.key}.${lp.to}`, into: cone.port, speed: best?.v ?? null, missMm: best && Number.isFinite(best.offset) ? mm(best.offset) : null, angleDeg: best?.angleDeg ?? null, ok: !!best?.hit };
  if (best?.hit) {
    const arc = flightCentres({ from, dir }, best.v, best.t).map((q) => q.c);
    if (what === 'jump' && ctx.next) {
      // On from where it crosses the mouth to where the catcher's route takes it.
      const e = arc.at(-1), n = Math.ceil(Math.hypot(ctx.next[0] - e[0], ctx.next[1] - e[1], ctx.next[2] - e[2]) / 0.0025);
      for (let k = 1; k <= n; k++) arc.push(e.map((u, d) => u + ((ctx.next[d] - u) * k) / n));
    }
    row.centres = arc;
  }
  ctx.table?.push(row);
  const out = [];
  if (row.ok && what === 'jump' && ctx.plastic) {
    // The flight through the air is free of plastic, its own pieces' included (their
    // moving parts, such as the T-Rex's jaw, move for the marble they carry).
    let worst = null;
    for (const c of row.centres) { const h = ctx.plastic(c, `p${i}j`); if (h && (!worst || h.d.mm > worst.h.d.mm)) worst = { h, c }; }
    if (worst) {
      const { h: { p, d, own }, c } = worst;
      out.push(failure('flight', 'hit-plastic', `the marble flies from ${code} through the plastic of ${p.code}${own ? ', the piece catching it' : ''}`, { x: c[0], y: c[1], z: c[2] },
        { s: ctx.s ?? null, part: tag(p), data: { ...row, own, depthMm: Math.round(d.mm * 10) / 10, mover: d.mover, centres: undefined } }));
    }
  }
  if (row.ok) return out;
  const why = !speeds.length ? `the marble is too slow to leave ${code}`
    : !Number.isFinite(best.offset) ? `the marble flies from ${code} and never reaches ${cone.port}`
      : `the marble flies from ${code} and misses ${cone.port} by ${row.missMm} mm${best.angleDeg > Math.acos(cone.cos) * 180 / Math.PI ? `, arriving ${Math.round(best.angleDeg)} degrees off its mouth` : ''}`;
  return [failure('flight', speeds.length ? 'left-track' : 'stuck', why, best?.at ?? from, { s: ctx.s ?? null, part: ctx.part?.(code) ?? { code, group: i }, data: { ...row, arc: best?.arc?.filter((_, k) => k % 10 === 0).map((p) => [p.x, p.y, p.z]) } })];
}


// ------------------------------------------------------------------ a world that grows
// The generator's view of the same five rules (D2): it adds one post and the track into
// it at a time, voxels and path samples, and asks only what the new pieces change. Old
// pieces passed when they were added, so a step is judged by the new plastic against
// everything (overlaps, support, a new path through old plastic, old path through new
// plastic), the new track's two joints and the new post's flight. undo() takes a step
// back, last in first out, as the search backs up. The validator still judges the whole
// track from scratch with checkAll(); this only finds the bad steps early.
export class Growing {
  constructor(tol = TOL) {
    this.tol = tol; this.parts = []; this.grid = new DenseGrid(); this.path = []; this.steps = [];
    this.bins = new Map();  // floor cell -> parts whose triangles reach it
    this.pbins = new Map(); // floor cell -> path samples whose marble is in it
  }

  // posts: the track so far with the new post last (and segs with the new track last, if
  // any); placed: the new parts (geometry.js placePost / placeSeg); points: the new path
  // samples, labelled; lipSpeed: the marble's speed at a new jump's lip (m/s).
  // Returns the failures; the step stays added either way until undo().
  step({ posts, segs, placed, points, lipSpeed }) {
    const legs = new Map();
    for (const q of points) (legs.get(q.piece) ?? legs.set(q.piece, []).get(q.piece)).push(q);
    const first = this.parts.length, fails = [];
    const added = placed.filter((p) => !((p.c === null || p.c === undefined) && p.seg === undefined)).map((p, k) => makePart(p, first + k, legs, this.tol));
    for (const part of added) {
      part.at = this.parts.length;
      fails.push(...this.overlapsOf(part));
      gridAdd(this.grid, part, part.at);
      binAdd(this.bins, part, part.at);
      this.parts.push(part);
    }
    fails.push(...this.supportOf(added));
    fails.push(...this.pathFailures(points, added));
    const i = segs.length - 1;
    if (i >= 0) {
      const leg = legs.get(`t${i}`), k = leg ? points.indexOf(leg[0]) : -1, before = k > 0 ? points[k - 1] : this.path.at(-1) ?? leg?.[0];
      if (leg?.length) fails.push(...jointsOfSeg(segs[i], i, posts[i], posts[i + 1], before, leg, this.tol, () => null, added.find((p) => p.seg === i)));
    }
    const post = posts.at(-1);
    if (post.kind === 'jump' || post.kind === 'toss') {
      const n = posts.length - 1, fl = legs.get(`p${n}j`) ?? [], after = fl.length ? points.indexOf(fl.at(-1)) + 1 : -1;
      fails.push(...flightOf(post, n, legs, this.tol, lipSpeed, {
        next: after > 0 && after < points.length ? centreAt(points, after, R) : null,
        plastic: (c, label) => deepestAt(this.parts, this.bins.get(binOf(c)) ?? [], c, label, this.tol),
      }));
    }
    const base = this.path.length;
    this.path.push(...points);
    this.index(points, base);
    this.steps.push({ first, base });
    return fails;
  }

  undo() {
    const { first, base } = this.steps.pop();
    while (this.parts.length > first) { const p = this.parts.pop(); gridRemove(this.grid, p, p.at); binRemove(this.bins, p, p.at); }
    for (let n = this.path.length - 1; n >= base; n--) {
      const c = this.path[n].centre;
      if (!c) continue;
      const k = binOf(c), list = this.pbins.get(k);
      list.pop();
      if (!list.length) this.pbins.delete(k);
    }
    this.path.length = base;
  }

  // New plastic against everything already there (and the new parts before it).
  overlapsOf(A) {
    const out = [], { tol } = this, shared = new Map();
    for (const key of A.keys) {
      const o = this.grid.get(key);
      if (o === undefined) continue;
      for (const b of Array.isArray(o) ? o : [o]) (shared.get(b) ?? shared.set(b, []).get(b)).push(key);
    }
    for (const [b, keys] of shared) {
      const B = this.parts[b], top = Math.max(A.lo[2], B.lo[2]) + tol.contactLayers;
      let n = 0, sx = 0, sy = 0, sz = 0;
      for (const key of keys) {
        const c = unkey(key);
        if (c[2] < top || mated(A, B, c)) continue;
        n++; const p = centre(...c); sx += p.x; sy += p.y; sz += p.z;
      }
      const verdict = judgePair(B, A, n, keys.length, Math.min(A.set.size, B.set.size), tol);
      if (verdict === 'voxels') out.push(failure('overlap', 'overlap', `${B.code} and ${A.code} are in the same space: hard plastic through hard plastic`, { x: sx / n, y: sy / n, z: sz / n }, { part: tag(B), other: tag(A), data: { voxels: n } }));
      else if (verdict) out.push(verdict);
    }
    return out;
  }

  // Each new part on the floor or on something held up; old parts are held up already.
  supportOf(added) {
    const { tol } = this, fresh = new Set(added.map((p) => p.at)), held = new Map(), out = [];
    // A block set straight on the block under it in the same stack rests on it: the
    // search builds stacks that way, and checkAll() judges the whole track afterwards.
    const below = new Map(added.filter((p) => p.block).map((p) => [`${p.group}|${p.c}|${p.r}|${(p.y ?? 0) + (LIB.blocks[p.key]?.height ?? 1)}`, p]));
    for (const p of added) {
      const under = p.block && below.get(`${p.group}|${p.c}|${p.r}|${p.y ?? 0}`);
      if (under) { held.set(p.at, { p, floor: false, holders: new Set([under.at]), contacts: [], stacked: true }); continue; }
      const holders = new Set(), contacts = [];
      let floor = false, sunkFloor = false;
      for (const key of p.under) {
        const [i, j, k] = unkey(key);
        if (k < 0) { sunkFloor = true; continue; } // under the floor: nothing stands there
        if (k === 0) { floor = true; contacts.push([i, j]); continue; }
        for (let d = 0; d <= tol.supportGapLayers + 1; d++) {
          const g = this.grid.get(keyOf(i, j, k - d));
          if (g === undefined) continue;
          const by = (Array.isArray(g) ? g : [g]).filter((o) => o !== p.at && this.parts[o].lo[2] <= k);
          if (by.length) { by.forEach((o) => holders.add(o)); contacts.push([i, j]); break; }
        }
      }
      if (p.decor) for (const key of p.set) {
        const [i, j, k] = unkey(key);
        for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const g = this.grid.get(keyOf(i + di, j + dj, k + dk));
          if (g !== undefined) (Array.isArray(g) ? g : [g]).filter((o) => o !== p.at).forEach((o) => holders.add(o));
        }
      }
      held.set(p.at, { p, floor, holders, contacts, sunkFloor });
    }
    const grounded = new Set();
    for (let changed = true; changed;) {
      changed = false;
      for (const [at, h] of held) if (!grounded.has(at) && (h.floor || [...h.holders].some((o) => !fresh.has(o) || grounded.has(o)))) { grounded.add(at); changed = true; }
    }
    for (const [at, { p, holders, floor, contacts, stacked, sunkFloor }] of held) {
      if (sunkFloor) { out.push(failure('support', 'unsupported', `${p.code} is below the floor: plastic cannot go through the floor`, centre(p.lo[0], p.lo[1], p.lo[2]), { part: tag(p) })); continue; }
      if (stacked && grounded.has(at)) continue;
      if (!grounded.has(at)) {
        out.push(failure('support', 'unsupported', `${p.code} ${holders.size || floor ? 'rests only on pieces that are not held up' : 'floats: nothing holds it up'}`, centre(p.lo[0], p.lo[1], p.lo[2]), { part: tag(p) }));
        continue;
      }
      if (p.decor || p.seg !== undefined || p.spiral) continue;
      if (tips(p, contacts, tol)) out.push(failure('support', 'tips', `${p.code} would tip over: its middle is not over what holds it`, centre(p.lo[0], p.lo[1], p.lo[2]), { part: tag(p) }));
    }
    return out;
  }

  // New samples through any plastic; old samples through the new plastic. Every part a
  // sample is inside is reported, once per part and leg, at its deepest.
  pathFailures(points, added) {
    const worst = new Map(), { tol } = this;
    const hit = (q, c, p) => {
      const own = carrierOf(q.piece, p), d = depthIn(p, c, own);
      if (!d || d.mm <= tol.contactMm) return;
      const id = `${p.at}|${q.piece}`, prev = worst.get(id);
      if (!prev || prev.data.depthMm < d.mm) worst.set(id, ghost(p, q, c, own, d, null));
    };
    // The marble's centre at each new sample, its neighbours taken across the step's start.
    const ctx = [this.path.at(-1) ?? points[0], ...points];
    points.forEach((q, k) => { q.centre = q.flight ? null : centreAt(ctx, k + 1, R); });
    for (const q of points) {
      if (!q.centre) continue;
      for (const a of this.bins.get(binOf(q.centre)) ?? []) hit(q, q.centre, this.parts[a]);
    }
    // Rolling, the marble rests on the plastic standing so far (rule f).
    restFailures(points, (n) => { const near = {}; return { c: points[n].centre, gap: gapUnder(this.parts, this, points[n].centre, near, tol.contactMm / 1000), part: near.part }; }, tol, () => null,
      (label) => this.parts.some((p) => !p.tri && carrierOf(label, p)))
      .forEach((f) => worst.set(`rests|${f.pathPiece}`, f));
    for (const p of added) {
      const t = p.tri;
      if (!t) continue;
      for (let i = Math.floor((t.lo[0] - R) / CELL); i <= Math.floor((t.hi[0] + R) / CELL); i++) for (let j = Math.floor((t.lo[1] - R) / CELL); j <= Math.floor((t.hi[1] + R) / CELL); j++) {
        for (const n of this.pbins.get(binKey(i, j)) ?? []) hit(this.path[n], this.path[n].centre, p);
      }
    }
    return [...worst.values()];
  }

  // Files each new sample's marble under its floor cell, for later plastic to meet.
  index(points, base) {
    points.forEach((q, k) => {
      if (!q.centre) return;
      const key = binOf(q.centre);
      (this.pbins.get(key) ?? this.pbins.set(key, []).get(key)).push(base + k);
    });
  }
}

// The part's middle must lie over what holds it.
function tips(p, contacts, tol) {
  const [cx, cy] = p.middle ?? middleOf(p.keys);
  const xs = contacts.map(([i]) => i), ys = contacts.map(([, j]) => j), m = tol.tipMarginCells / V;
  return cx < Math.min(...xs) - m || cx > Math.max(...xs) + 1 + m || cy < Math.min(...ys) - m || cy > Math.max(...ys) + 1 + m;
}

// ------------------------------------------------------------------ all five
export const RULES = Object.freeze({ overlaps, support, joints, freePath, rests, flights });

export function checkAll(input, tol = TOL) {
  const w = input?.parts && input?.grid ? input : buildWorld(input, tol);
  const byRule = {};
  for (const [name, rule] of Object.entries(RULES)) byRule[name] = rule(w);
  for (const list of Object.values(byRule)) for (const f of list) if (f.s === null && f.part) f.s = firstTouch(w, w.parts.find((p) => p.index === f.part.index) ?? f.part);
  return { world: w, byRule, failures: Object.values(byRule).flat() };
}

// The physical problems of a track as plain sentences, for validate().
export const physicalProblems = (track, tol) => checkAll(track, tol).failures.map((f) => `${f.rule}: ${f.why}`);
