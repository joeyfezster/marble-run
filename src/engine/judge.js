// judge(): for any layout, generated or built by a child, walks one marble and says
// whether it gets to the end, or the first place and reason it does not (D3 in
// docs/physics_rework.md). Built for builder mode: every failure carries the spot (world
// metres and the floor cell and slot), the part to point at, and plain words.
//
// Order: a build that cannot stand fails before any marble rolls (unsupported pieces,
// plastic through plastic, in build order); then the marble's walk, by distance along
// its path (joint gaps, plastic in its way, missed flights, the wrong marble, energy).
import { byKey } from '../catalog/parts.js';
import { checkAll, failure, TOL } from './physical.js';
import { samplePath, simulate } from './physics.js';

const LEFT = /flies out|jumps off|flies past|bounces out/;
const KIND = (why) => (LEFT.test(why) ? 'left-track' : /falls short/.test(why) ? 'fell' : 'stuck');

function pointAtS(w, s) {
  let i = 0;
  while (i < w.path.length - 1 && w.s[i + 1] <= s) i++;
  return { i, q: w.path[i] };
}

// input: a track, { track }, or { placements, path } (see physical.buildWorld).
// marble: 'plain' or 'metal' (defaults to the track's).
// Returns { ok, marble, first, failures, timing } where first and each failure is
// { rule, kind, why, at: {x, y, z} m, cell: {c, r, slot}, s (m along the path, or null
//   for a build fault), part: {index, key, code, group, seg?, label}, other?, data }.
// kind is one of: unsupported, tips, overlap, joint-gap, hit-plastic, left-track, fell, stuck.
export function judge(input, marble, tol = TOL) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { world: w, byRule } = checkAll(input, tol);
  marble = marble ?? w.marble ?? 'plain';
  const walk = [...byRule.joints, ...byRule.freePath, ...byRule.rests, ...byRule.flights];
  // The wrong marble: a piece that only holds a metal marble drops a plain one.
  // A store (a magnet trigger) keeps a plain marble until a metal one in the same run
  // fires it, so it drops nothing when the run has a metal marble too.
  const runHasMetal = (w.track?.marbles ?? []).includes('metal');
  if (marble !== 'metal') {
    const i = w.path.findIndex((q) => {
      const p = partOfLeg(w, q.piece), ph = p && byKey(p.key)?.physics;
      return ph?.needsMetalMarble && !(ph.energy === 'stores' && runHasMetal);
    });
    if (i >= 0) {
      const p = partOfLeg(w, w.path[i].piece);
      walk.push(failure('marble', 'fell', `a ${marble} marble falls off ${p.code}: it only holds a metal marble`, w.path[i], { s: w.s[i], part: tagOf(p), pathPiece: w.path[i].piece }));
    }
  }
  // Energy: the marble must roll every piece and arrive (nominal pieces, one run).
  if (w.path.length > 1) {
    const r = simulate(samplePath(w.path));
    if (!r.ok) {
      const { i, q } = pointAtS(w, r.at);
      walk.push(failure('energy', KIND(r.why), `the marble ${r.why}`, q, { s: w.s[i], part: tagOf(partOfLeg(w, q.piece)), pathPiece: q.piece, data: { speed: r.v } }));
    }
  }
  const build = [...byRule.support, ...byRule.overlaps].sort((a, b) => (a.part?.group ?? 0) - (b.part?.group ?? 0));
  walk.sort((a, b) => (a.s ?? Infinity) - (b.s ?? Infinity));
  const failures = [...build, ...walk];
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return { ok: failures.length === 0, marble, first: failures[0] ?? null, failures, timing: { ms } };
}

const tagOf = (p) => p && { index: p.index, key: p.key, code: p.code, group: p.group, ...(p.seg !== undefined ? { seg: p.seg } : {}), label: p.label };

// The part carrying the marble on a path leg: tN is track N, pN (and pNw, pNl...) is post N's piece.
function partOfLeg(w, label) {
  const m = /^([tp])(\d+)/.exec(label ?? '');
  if (!m) return null;
  const n = Number(m[2]);
  if (m[1] === 't') return w.parts.find((p) => p.seg === n) ?? null;
  const mine = w.parts.filter((p) => p.group === n && p.seg === undefined && !p.block && !p.decor);
  return mine[0] ?? w.parts.find((p) => p.group === n && p.seg === undefined && p.top) ?? null;
}
