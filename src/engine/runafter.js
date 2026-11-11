// The run after a strong launcher (D6 in docs/physics_rework.md, Joey 2026-11-09): a
// marble shot out of it flies out of any turn it meets too soon, so the track leaving it
// runs straight with no turn and no drop hole for `noTurnCells` cells, better
// `preferNoTurnCells`, and preferably climbs within `preferClimbWithinCells`. The record
// says it (physics.runAfter); nothing here names a piece. Read on the drawn path, so the
// generator and the validator judge the same run.
import { DIM, byKey } from '../catalog/parts.js';

const TURN_DEG = 15;   // a heading change this big along the run is a turn
const CLIMB = 0.05;    // a rise this steep (dz per metre along) is a climb

export const runAfterOf = (post) => (post?.kind === 'station' && post.act === 'rest' ? byKey(post.fit.key)?.physics?.runAfter ?? null : null);

// Where each launch with a runAfter rule leaves its piece: { post, rule, at } with `at`
// the index of the last sample of its waiting leg (pNw), the launch point.
export function launches(posts, points) {
  const out = [];
  posts.forEach((post, i) => {
    const rule = runAfterOf(post);
    if (!rule) return;
    let at = -1;
    for (let n = 0; n < points.length; n++) if (points[n].piece === `p${i}w`) at = n;
    if (at >= 0) out.push({ post: i, rule, at });
  });
  return out;
}

// Walks the path from a launch: how far (m, in plan) until the first turn, the first drop
// hole and the first climb, looking no farther than `reach` m. Infinity if none.
export function runFrom(points, at, reach) {
  let s = 0, heading = null, turn = Infinity, drop = Infinity, climb = Infinity;
  for (let n = at + 1; n < points.length && s <= reach; n++) {
    const a = points[n - 1], b = points[n], d = Math.hypot(b.x - a.x, b.y - a.y);
    if (b.fall && drop === Infinity) drop = s;
    if (d > 1e-4) {
      const h = Math.atan2(b.y - a.y, b.x - a.x);
      heading ??= h;
      let dh = Math.abs(h - heading);
      if (dh > Math.PI) dh = 2 * Math.PI - dh;
      if (dh > (TURN_DEG * Math.PI) / 180 && turn === Infinity) turn = s;
      if ((b.z - a.z) / d > CLIMB && climb === Infinity) climb = s;
      s += d;
    }
  }
  return { turn, drop, climb, run: s };
}

// The rule on every launch in a path: problems (a turn or drop hole too near) and the
// preferences it meets. cells: lengths in cells.
export function runAfterCheck(posts, points) {
  const out = [];
  for (const { post, rule, at } of launches(posts, points)) {
    const cell = DIM.cell, reach = Math.max(rule.noTurnCells ?? 0, rule.preferNoTurnCells ?? 0, rule.preferClimbWithinCells ?? 0) * cell;
    const r = runFrom(points, at, reach), first = Math.min(r.turn, r.drop);
    out.push({
      post, code: byKey(posts[post].fit.key)?.code, rule,
      ok: !(first < (rule.noTurnCells ?? 0) * cell),
      preferred: !(first < (rule.preferNoTurnCells ?? 0) * cell),
      climbs: r.climb <= (rule.preferClimbWithinCells ?? 0) * cell,
      firstTurnCells: first / cell, what: r.drop <= r.turn ? 'drop hole' : 'turn',
    });
  }
  return out;
}

export const runAfterProblems = (posts, points) => runAfterCheck(posts, points).filter((r) => !r.ok)
  .map((r) => `the marble shot from ${r.code} meets a ${r.what} ${r.firstTurnCells.toFixed(1)} cells out: it flies out (no turn or drop hole within ${r.rule.noTurnCells})`);
