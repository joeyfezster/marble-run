// The routes a marble may take through a piece, read from its record's marblePaths and
// ports alone, and the route a finished track sends it on through each piece. Shared by
// the generator (to choose a block and its turn) and the validator (to judge). A block
// used only as height carries no marble and is not listed. Nothing here names a piece.
import { LIB, byKey, names } from '../catalog/parts.js';
import { SIDE, facesOf, level, back } from '../catalog/frame.js';
import { stackHeight, blockTurn, buildPath, postZ, cellCentre, edge } from './geometry.js';
import { portAt } from './fit.js';

const LETTER = ['E', 'S', 'W', 'N'];
const portOf = (rec, id) => rec.ports.find((p) => p.id === id);
const FIXED = new Set(['carried', 'fall', 'flight', 'spiral']);

// Every way through a record: each marblePath as written, and backwards too when it is
// level, runs between two side ports and both ends let a marble pass both ways.
export function routesOf(rec) {
  const out = [];
  for (const m of rec.marblePaths ?? []) {
    const a = portOf(rec, m.from), b = portOf(rec, m.to);
    if (!a || !b) continue;
    out.push({ from: a, to: b, path: m });
    if (m.from !== m.to && !m.dropSlots && !FIXED.has(m.shape) && SIDE.has(a.type) && SIDE.has(b.type) && a.flow === 'both' && b.flow === 'both') {
      out.push({ from: b, to: a, path: m, reversed: true });
    }
  }
  return out;
}

const flowsIn = (p) => p.flow === 'in' || p.flow === 'both';
const flowsOut = (p) => p.flow === 'out' || p.flow === 'both';

// How the marble meets a piece: through a side face at a level, falling in from above
// (catch), placed by hand (start), leaving by an open drop (drop) or staying (end).
// A side face is the world face the marble passes, so it enters face back(heading).
function portMeets(port, end, faces, lvl, entering) {
  if (end.port && port.id !== end.port) return false;
  if (!(entering ? flowsIn(port) : flowsOut(port))) return false;
  if (end.catch) return port.type === 'open-catch';
  if (end.drop) return port.type === 'open-drop';
  if (end.face === undefined) return true;
  if (!SIDE.has(port.type) || !faces(port).includes(end.face)) return false;
  const at = lvl(port);
  return end.level === undefined || at === undefined || at === end.level;
}

// The record's route that matches this entry and exit, or null. `faces(port)` and
// `lvl(port)` give a port's world faces and level as the piece is placed.
export function matchRoute(rec, enter, leave, faces, lvl) {
  return routesOf(rec).find((r) => portMeets(r.from, enter, faces, lvl, true) && (leave.stay || portMeets(r.to, leave, faces, lvl, false))) ?? null;
}

// A block's ports as placed: turned `rot` quarter turns, standing `base` slots up.
export const blockFaces = (rot) => (port) => facesOf(port).map((f) => (f + rot) % 4);
export const blockLevel = (base) => (port) => base + level(port.at[2]);

// The quarter turns under which block `key` has a route from `enter` to `leave`.
export function blockTurns(key, enter, leave, base = 0) {
  const rec = byKey(key);
  if (!rec) return [];
  return [0, 1, 2, 3].filter((rot) => matchRoute(rec, enter, leave, blockFaces(rot), blockLevel(base)));
}

const fitFaces = (fit) => (port) => { const f = portAt(fit, port.id)?.face; return f === null || f === undefined ? [] : [f]; };
const fitLevel = (fit) => (port) => portAt(fit, port.id).level;

const say = (end) => end.catch ? 'falling in from above' : end.drop ? 'out through its drop' : end.stay ? 'staying' : end.hand ? 'by hand'
  : `${end.face === undefined ? 'its' : `the ${LETTER[end.face]}`} side${end.level === undefined ? '' : ` at level ${end.level}`}`;
const list = (rec) => (rec.marblePaths ?? []).map((m) => `${m.from}->${m.to}`).join(', ') || 'none';

// How a marble leaving an open drop meets the block under it: a drop that faces a side
// (a tail tip) rolls it on into that block's cup heading that way; one that faces down
// lets it fall in from above.
export function dropInto(fit, portId, lvl) {
  const f = portAt(fit, portId)?.face;
  return f === null || f === undefined ? { catch: true } : { face: back(f), level: lvl };
}

// The route the track sends the marble on through every piece that carries it, post by
// post, in the order it meets them. `hand` marks the start piece's inlet.
export function traversals(track) {
  const out = [];
  track.posts.forEach((p, i) => {
    const blockAt = (k, enter, leave) => {
      const key = p.stack[k];
      out.push({ i, key, block: true, k, cell: [p.c, p.r], rot: blockTurn(p, k), base: stackHeight(p.stack.slice(0, k)), enter, leave });
    };
    const fitOf = (fit, enter, leave) => out.push({ i, key: fit.key, fit, cell: [portAt(fit, fit.from).c, portAt(fit, fit.from).r], enter, leave });
    const top = p.stack.length - 1, side = (face, lvl) => ({ face, level: lvl });
    switch (p.kind) {
      case 'cross':
        blockAt(top, side(back(p.in), p.h), side(p.out, p.h)); return;
      case 'fall': {
        const c = p.stack.length - (p.fit ? 1 : 2);
        if (p.fit) fitOf(p.fit, { ...side(back(p.in), p.hIn), port: p.fit.from }, { drop: true });
        else blockAt(top, side(back(p.in), p.hIn), { drop: true });
        if (c >= 0) blockAt(c, { catch: true }, side(p.out, p.hOut));
        return;
      }
      case 'spiral':
        blockAt(top, side(back(p.in), p.hIn), side(p.in, p.hIn));
        out.push({ i, key: p.piece, spiral: true, rot: p.in, cell: [p.c, p.r], enter: { face: back(p.in), level: p.hIn }, leave: { drop: true } });
        // The band's end hands the marble into the block under the host through the side
        // face it lies on (IMG_0960), and the marble crosses it to the far face.
        if (top >= 1) blockAt(top - 1, side(p.tailFace, p.hOut), side(p.out, p.hOut));
        return;
      case 'station':
        fitOf(p.fit, p.first ? { port: p.fit.from, hand: true } : { ...side(back(p.in), p.hIn), port: p.fit.from }, { ...side(p.out, p.hOut), port: p.fit.to });
        return;
      case 'jump':
        fitOf(p.ramp, { ...side(back(p.in), p.hIn), port: p.ramp.from }, { drop: true, port: p.ramp.to });
        fitOf(p.catcher, { catch: true, port: p.catcher.from }, p.drops ? { drop: true } : { ...side(p.out, p.hOut), port: p.catcher.to });
        if (p.drops) blockAt(top, dropInto(p.catcher, p.catcher.to, p.hOut), side(p.out, p.hOut));
        return;
      case 'toss':
        fitOf(p.fit, { ...side(back(p.in), p.hIn), port: p.fit.from }, { drop: true, port: p.fit.to });
        fitOf(p.hood, { catch: true, port: p.hood.from }, { drop: true });
        blockAt(top, { catch: true }, side(p.out, p.hOut));
        return;
      case 'end':
        if (p.endCells) {
          blockAt(top, side(back(p.in), p.h), side(p.out, p.h));
          fitOf(p.fit, { face: back(p.out), port: p.fit.from }, { stay: true });
        } else fitOf(p.fit, { ...side(back(p.in), p.hIn), port: p.fit.from }, { stay: true });
        return;
      default:
    }
  });
  return out;
}

// The record route each traversal uses, or a problem naming the piece and the route.
export function routeProblems(track, pts = buildPath(track)) {
  const problems = [], trav = traversals(track);
  const routes = trav.map((t) => {
    const rec = byKey(t.key);
    if (!rec) { problems.push(`post ${t.i}: ${t.key} has no record`); return null; }
    const enter = t.enter.hand ? { port: t.enter.port } : t.enter;
    const faces = t.block || t.spiral ? blockFaces(t.rot) : fitFaces(t.fit);
    const lvl = t.block ? blockLevel(t.base) : t.spiral ? () => undefined : fitLevel(t.fit);
    const r = matchRoute(rec, enter, t.leave, faces, lvl);
    if (!r) {
      problems.push(`post ${t.i}: ${rec.code} cannot take the marble in ${say(t.enter)} and out ${say(t.leave)} (its record allows ${list(rec)})`);
      return null;
    }
    // A marble rolling over a block from one side to another crosses its top.
    if (t.block && t.enter.face !== undefined && t.leave.face !== undefined && t.enter.face !== t.leave.face && !rec.stacking?.marbleCrossesTop) {
      problems.push(`post ${t.i}: a marble cannot cross the top of ${rec.code}`);
    }
    return r;
  });
  // Each drop must land in what catches it: one of the two ports names the other piece.
  trav.forEach((t, n) => {
    const r = routes[n], nx = trav[n + 1], rn = routes[n + 1];
    if (!r || !nx || !rn || nx.i !== t.i || r.to.type !== 'open-drop') return;
    const a = byKey(t.key), b = byKey(nx.key);
    if (!names(r.to.accepts, b, rn.from) && !names(rn.from.accepts, a, r.to)) problems.push(`post ${t.i}: ${a.code} drops the marble where ${b.code} does not take it`);
  });
  // A block the marble does not pass through is plain height, which its record must allow.
  const carrying = new Set(trav.filter((t) => t.block).map((t) => `${t.i}:${t.k}`));
  track.posts.forEach((p, i) => {
    const stacks = [...p.stack.map((key, k) => (carrying.has(`${i}:${k}`) ? null : key)), ...(p.stands ?? []).flatMap((s) => s.stack)];
    for (const key of stacks) if (key && byKey(key) && !byKey(key).stacking?.usableAsHeightOnly) problems.push(`post ${i}: ${byKey(key).code} cannot be used only as height`);
  });
  // A spiral band winds one way only: it lies on the side its record puts it.
  track.posts.forEach((p, i) => {
    const sp = p.kind === 'spiral' && LIB.spirals.find((x) => x.key === p.piece);
    if (sp?.side && p.spiralSide !== sp.side) problems.push(`post ${i}: ${sp.code} winds only to the ${sp.side > 0 ? 'right' : 'left'}, it cannot hang on the other side`);
  });
  problems.push(...pathProblems(pts, trav, routes));
  return problems;
}

// The marble path the physics runs and the 3D view draws must pass each block through
// the faces its route uses, at their heights, entering before it leaves.
const TOL_XY = 0.06, TOL_Z = 0.12;
function pathProblems(pts, trav, routes) {
  const out = [], cell = cellCentre(1, 0).x, slot = postZ(1) - postZ(0);
  const range = new Map();
  pts.forEach((p, n) => {
    const m = /^p(\d+)/.exec(p.piece ?? '');
    if (!m) return;
    const k = Number(m[1]), r = range.get(k) ?? [n, n];
    range.set(k, [Math.min(r[0], n), Math.max(r[1], n)]);
  });
  const near = (p, x, y, z) => Math.hypot(p.x - x, p.y - y) <= TOL_XY * cell && Math.abs(p.z - z) <= TOL_Z * slot;
  trav.forEach((t, n) => {
    if (!routes[n] || !t.block) return;
    const [lo, hi] = range.get(t.i) ?? [0, -1], from = Math.max(0, lo - 1);
    const post = { c: t.cell[0], r: t.cell[1] }, mid = cellCentre(post.c, post.r);
    const find = (end, start) => {
      for (let k = start; k <= hi; k++) {
        const p = pts[k];
        const inColumn = Math.hypot(p.x - mid.x, p.y - mid.y) <= 0.5 * cell;
        // Falling in: above the level it leaves at. Dropping out: below the level it came in at.
        if (end.catch) { if (inColumn && p.z > postZ(t.leave.level) + 0.25 * slot) return k; continue; }
        if (end.drop) { if (inColumn && p.z < postZ(t.enter.level) - 0.25 * slot) return k; continue; }
        const e = edge(post, end.face);
        if (near(p, e.x, e.y, postZ(end.level))) return k;
      }
      return -1;
    };
    const a = find(t.enter, from), b = a < 0 ? -1 : find(t.leave, a + 1);
    if (a < 0 || b < 0) out.push(`post ${t.i}: the marble path does not run ${t.key}'s route ${routes[n].from.id}->${routes[n].to.id} (in ${say(t.enter)}, out ${say(t.leave)})`);
  });
  return out;
}

