// Checks a finished track from scratch, trusting nothing the generator did. Every
// rule is a physical fact read from the piece records: ports mate, heights meet,
// stacks hold what stands on them, the marble suits every piece, nothing collides.
import { DIM, TRACKS, LIB, byKey, names, back } from '../catalog/parts.js';
import { level } from '../catalog/frame.js';
import { trackPath, postPath, coveredCells, standing, stackHeight, buildPath } from './geometry.js';
import { tossShot } from './ballistic.js';
import { runAfterProblems } from './runafter.js';
import { portAt, cellsOf, feetOf, tallOf, frameFor } from './fit.js';
import { leaves, enters } from './ports.js';
import { routeProblems } from './routes.js';
import { physicalProblems, RULES, checkAll, buildWorld } from './physical.js';
import { judge } from './judge.js';

// The five physical rules on the models' solids (physical.js) and judge() for any layout.
// validate() runs them by default; { physical: false } leaves them out.
export { RULES, checkAll, buildWorld, judge, physicalProblems };
export const { overlaps, support, joints, freePath, rests, flights } = RULES;

const block = (key) => LIB.blocks[key];

// True when a block in some turn opens on both the marble's in and out faces.
export function blockPasses(key, inHeading, outHeading) {
  const faces = block(key)?.faces ?? [], want = [back(inHeading), outHeading];
  return [0, 1, 2, 3].some((rot) => want.every((w) => faces.map((f) => (f + rot) % 4).includes(w)));
}
export const blockExits = (key, outHeading) => [0, 1, 2, 3].some((rot) => (block(key)?.faces ?? []).map((f) => (f + rot) % 4).includes(outHeading));

const stationOf = (key, from, to) => LIB.stations.find((s) => s.key === key && s.from === from && s.to === to);
const catcherOf = (key) => LIB.catchers.find((c) => c.key === key);
const sameCell = (a, b) => a && b && a.c === b.c && a.r === b.r;

function checkStands(fit, stands, say, i) {
  for (const [c, r] of feetOf(fit)) {
    const s = (stands ?? []).find((x) => x.c === c && x.r === r);
    if (!s) { say(`post ${i}: nothing holds the foot at ${c},${r}`); continue; }
    if (stackHeight(s.stack) !== fit.base) say(`post ${i}: the stack under ${c},${r} is the wrong height`);
    if (s.stack.some((k) => !block(k))) say(`post ${i}: only blocks can hold a piece up`);
  }
}

function checkFit(fit, from, to, post, i, say, rule) {
  const a = portAt(fit, from), b = to && portAt(fit, to);
  if (!a || (to && !b)) { say(`post ${i}: ${fit.key} has no such port`); return null; }
  if (fit.base < rule.minBase || fit.base > rule.maxBase) say(`post ${i}: ${fit.key} cannot stand ${fit.base} slots up`);
  return { a, b };
}

function checkPost(p, i, say) {
  const top = p.stack.at(-1), h = stackHeight(p.stack);
  switch (p.kind) {
    case 'cross':
      if (!TOPSOK(top, p) || !blockPasses(top, p.in, p.out)) say(`post ${i}: ${top} cannot carry a marble that way`);
      if (h !== p.h) say(`post ${i}: stack height does not match`);
      return;
    case 'fall': {
      const cIndex = p.stack.length - (p.fit ? 1 : 2), catcher = p.stack[cIndex];
      if (p.fit) {
        const rec = LIB.dropTops.find((d) => d.key === p.fit.key && !d.block);
        if (!rec) say(`post ${i}: nothing lets the marble fall in`);
        else if (p.hIn !== h + level(rec.port.at[2]) || p.fit.base !== h) say(`post ${i}: the drop-in piece sits at the wrong height`);
      } else if (!LIB.dropTops.some((d) => d.block && d.key === top)) say(`post ${i}: nothing lets the marble fall in`);
      else if (p.hIn !== h) say(`post ${i}: stack height does not match`);
      if (!block(catcher)?.catcher || !blockExits(catcher, p.out)) say(`post ${i}: ${catcher} has no way out`);
      if (p.hOut !== stackHeight(p.stack.slice(0, cIndex + 1))) say(`post ${i}: the marble leaves at the wrong height`);
      return;
    }
    case 'spiral': {
      const sp = LIB.spirals.find((s) => s.key === p.piece);
      if (!sp) say(`post ${i}: ${p.piece} is not a spiral`);
      else if (p.hIn - p.hOut !== sp.drop) say(`post ${i}: the spiral drops the wrong height`);
      if (h !== p.hIn || block(top)?.cross !== 'straight') say(`post ${i}: the spiral needs a plain stack as tall as its top`);
      const under = p.stack.at(-2);
      if (!under || stackHeight(p.stack.slice(0, -1)) !== p.hOut || !(blockPasses(under, back(p.tailFace ?? p.in), p.out) || (block(under)?.catcher && blockExits(under, p.out)))) say(`post ${i}: the block under the spiral cannot send the marble out that way`);
      if (p.out === back(p.in)) say(`post ${i}: the spiral would send the marble out under its own track`);
      return;
    }
    case 'station': {
      const st = stationOf(p.fit.key, p.fit.from, p.fit.to);
      if (!st || (st.kind !== p.act && !(p.first && st.start))) { say(`post ${i}: ${p.fit.key} does not work that way`); return; }
      const ends = checkFit(p.fit, p.fit.from, p.fit.to, p, i, say, st);
      if (!ends) return;
      if (!p.first && (ends.a.face !== back(p.in) || ends.a.level !== p.hIn || !sameCell(ends.a, p.entry))) say(`post ${i}: the track does not meet ${p.fit.key}'s inlet`);
      if (ends.b.face !== p.out || ends.b.level !== p.hOut || !sameCell(ends.b, p)) say(`post ${i}: the marble does not leave ${p.fit.key} where the next track starts`);
      checkStands(p.fit, p.stands, say, i);
      return;
    }
    case 'jump': {
      const ramp = stationOf(p.ramp.key, p.ramp.from, p.ramp.to), ct = catcherOf(p.catcher.key);
      if (!ramp || ramp.kind !== 'ramp' || !ct) { say(`post ${i}: not a ramp and a catcher`); return; }
      if (!ct.accepts.some((s) => s.includes(ramp.code))) say(`post ${i}: ${p.catcher.key} does not catch from ${p.ramp.key}`);
      const r = checkFit(p.ramp, p.ramp.from, p.ramp.to, p, i, say, ramp), c = checkFit(p.catcher, p.catcher.from, p.catcher.to, p, i, say, ct);
      if (!r || !c) return;
      if (r.a.face !== back(p.in) || r.a.level !== p.hIn || !sameCell(r.a, p.entry)) say(`post ${i}: the track does not meet the ramp`);
      // The catcher stands on whole blocks, within a slot of the lip's height; whether the
      // marble's arc reaches its mouth is the flights rule's (physical.js).
      if (Math.abs(r.b.z - c.a.z) > 1) say(`post ${i}: the catcher is more than a slot off the lip's height`);
      const dx = c.a.x - r.b.x, dy = c.a.y - r.b.y, [ax, ay] = [[1, 0], [0, 1], [-1, 0], [0, -1]][p.in];
      if (dx * ax + dy * ay < -0.01 || Math.abs(dx * ay - dy * ax) > 0.01) say(`post ${i}: the catcher is not in front of the lip`);
      if (p.drops) {
        if (!sameCell(c.b, p) || h !== c.b.level || h !== p.hOut || !blockPasses(top, p.out, p.out) && !blockExits(top, p.out)) say(`post ${i}: the block under the outlet is wrong`);
      } else if (c.b.face !== p.out || c.b.level !== p.hOut || !sameCell(c.b, p)) say(`post ${i}: the marble does not leave the catcher where the next track starts`);
      checkStands(p.ramp, p.stands, say, i); checkStands(p.catcher, p.stands, say, i);
      return;
    }
    case 'toss': {
      const st = stationOf(p.fit.key, p.fit.from, p.fit.to), ct = catcherOf(p.hood.key);
      if (!st || st.kind !== 'toss' || !ct || !ct.accepts.some((s) => s.includes(st.code))) { say(`post ${i}: nothing catches the throw`); return; }
      const ends = checkFit(p.fit, p.fit.from, p.fit.to, p, i, say, st);
      if (!ends) return;
      if (ends.a.face !== back(p.in) || ends.a.level !== p.hIn) say(`post ${i}: the track does not meet the launcher`);
      // The throw flies along the launcher's aim (ballistic.js); it must enter the hood's mouth.
      if (!tossShot({ ...p.fit, from: st.from, to: st.to }, { ...p.hood, from: p.hood.from }).hit) say(`post ${i}: the launcher is not aimed at the hood: the throw misses its mouth`);
      if (h !== p.hood.base || !block(top)?.catcher || !blockExits(top, p.out) || p.hOut !== h) say(`post ${i}: the tower under the catcher is wrong`);
      checkStands(p.fit, p.stands, say, i);
      return;
    }
    case 'end': {
      if (p.endCells) {
        const rec = byKey(p.fit.key), port = rec.ports.find((x) => x.id === p.fit.from);
        if (!LIB.ends.some((e) => e.key === p.fit.key)) say(`post ${i}: ${p.fit.key} is not an end piece`);
        if (h !== level(port.at[2]) || h !== p.h || !names(port.accepts, byKey(top), null)) say('the tray must clip to a block one slot up');
        if (!blockPasses(top, p.in, p.out)) say(`post ${i}: ${top} cannot carry a marble that way`);
        if (portAt(p.fit, p.fit.from).face !== back(p.out)) say(`post ${i}: the end piece faces the wrong way`);
        return;
      }
      const st = stationOf(p.fit.key, p.fit.from, p.fit.to);
      if (!st || st.kind !== 'rest') { say(`post ${i}: ${p.fit.key} cannot end a run`); return; }
      if (p.stack.length) say('a waiting piece takes a track at its inlet, not a block');
      const ends = checkFit(p.fit, p.fit.from, null, p, i, say, st);
      if (ends && (ends.a.face !== back(p.in) || ends.a.level !== p.hIn)) say(`post ${i}: the track does not meet ${p.fit.key}'s inlet`);
      checkStands(p.fit, p.stands, say, i);
      return;
    }
    default: say(`post ${i}: unknown kind ${p.kind}`);
  }
}

const TOPSOK = (top, p) => block(top)?.cross === (p.in === p.out ? 'straight' : 'corner');

// The marble types a run uses: the track's list, else its one marble.
export const marblesOf = (track) => (track.marbles?.length ? track.marbles : [track.marble ?? 'plain']);

// Pieces the run's marble must suit.
const metalPieces = (track) => [...track.segs.map((s) => s.code), ...track.posts.flatMap((p) => [p.fit, p.ramp, p.catcher, p.hood].filter(Boolean).map((f) => f.key))]
  .filter((k) => byKey(k)?.physics?.needsMetalMarble);

// physical: the five rules on the models' plastic (physical.js). runAfter: the run after
// a strong launcher (runafter.js), Joey's rule for every generated track; VTech's own
// published layouts are checked without it where they break it (tests/official.test.js).
export function validate(track, floorCells, { physical = true, runAfter = true } = {}) {
  const problems = [], say = (m) => problems.push(m);
  track.segs.forEach((seg, i) => {
    const from = track.posts[i], to = track.posts[i + 1];
    if (!TRACKS[seg.code]) { say(`unknown track ${seg.code}`); return; }
    if (!leaves(from, seg.code)) say(`${seg.code} cannot leave a ${from.act ?? from.kind}${from.piece ? ` (${from.piece})` : ''}`);
    if (!enters(to, seg.code)) say(`${seg.code} cannot enter a ${to.act ?? to.kind}${to.piece ? ` (${to.piece})` : ''}`);
    if (TRACKS[seg.code].drops[0] !== (from.hOut ?? from.h) - (to.hIn ?? to.h)) say(`${seg.code} joins the wrong heights`);
  });
  track.posts.forEach((p, i) => { if (i > 0 || p.kind !== 'station') checkPost(p, i, say); else checkPost({ ...p, first: true }, i, say); });
  if (track.posts.at(-1).kind !== 'end') say('the run has no end piece');
  // Every route must work for every marble the run uses (D5): a piece that holds only a
  // metal marble drops a plain one; a store keeps marbles until a metal one triggers it.
  const marbles = marblesOf(track);
  for (const k of new Set(metalPieces(track))) {
    const stores = byKey(k)?.physics?.energy === 'stores';
    if (stores ? !marbles.includes('metal') : marbles.some((m) => m !== 'metal')) say(`${stores ? 'a metal marble must trigger' : 'only a metal marble works'} ${byKey(k)?.code ?? k}`);
  }
  if (floorCells) for (const [c, r] of standing(track)) if (!floorCells.some(([x, y]) => x === c && y === r)) say(`nothing under ${c},${r}`);
  problems.push(...collisions(track));
  problems.push(...routeProblems(track));
  if (physical) problems.push(...physicalProblems(track));
  if (runAfter) problems.push(...runAfterProblems(track.posts, buildPath(track)));
  return [...new Set(problems)];
}

// What each post fills, from its own pieces.
export function solidOf(p) {
  const out = [], fits = [p.fit, p.ramp, p.catcher].filter(Boolean);
  const h = stackHeight(p.stack);
  if (p.stack.length) out.push([p.c, p.r, Math.max(h, p.hIn ?? 0) + (p.kind === 'fall' && p.fit ? 1 : 0)]);
  for (const f of fits) if (!(p.kind === 'fall' || p.kind === 'end' && p.endCells)) for (const [c, r] of cellsOf(f)) if (c !== p.c || r !== p.r || !p.stack.length) out.push([c, r, tallOf(f)]);
  if (p.kind === 'end' && p.endCells) for (const [c, r] of p.endCells) out.push([c, r, 1]);
  for (const k of p.spiralCells ?? []) { const [c, r] = k.split(',').map(Number); out.push([c, r, p.hIn]); }
  if (p.kind === 'jump') {
    const lip = portAt(p.ramp, p.ramp.to), take = portAt(p.catcher, p.catcher.from), [ax, ay] = [[1, 0], [0, 1], [-1, 0], [0, -1]][p.in];
    for (let k = 1; k < Math.round(Math.hypot(take.x - lip.x, take.y - lip.y)) + 1; k++) out.push([lip.c + ax * k, lip.r + ay * k, lip.level + 1]);
  }
  if (p.kind === 'toss') {
    const tube = portAt(p.fit, p.fit.to), [ax, ay] = [[1, 0], [0, 1], [-1, 0], [0, -1]][(p.hood.rot + 2) % 4];
    for (let k = 0; k < Math.abs(p.c - tube.c) + Math.abs(p.r - tube.r); k++) out.push([tube.c + ax * k, tube.r + ay * k, p.hOut + 2]);
  }
  return out;
}

// Replays the build into an empty grid.
export function collisions(track) {
  const out = [], tall = new Map(), runs = [], clear = 2 * DIM.slot, owner = new Map();
  track.posts.forEach((p, i) => {
    for (const [c, r, t] of solidOf(p)) {
      const k = `${c},${r}`;
      if (tall.has(k) && owner.get(k) !== i) out.push(`two things stand on ${k}`);
      tall.set(k, Math.max(t, tall.get(k) ?? 0)); owner.set(k, i);
    }
  });
  track.segs.forEach((seg, i) => {
    const from = track.posts[i], to = track.posts[i + 1], pts = [], home = to.entry ?? to;
    trackPath(pts, from, to, seg, 'x');
    postPath(pts, to, 'y');
    const own = new Set([`${from.c},${from.r}`, `${home.c},${home.r}`, `${to.c},${to.r}`, ...(from.spiralCells ?? []), ...solidOf(to).map(([c, r]) => `${c},${r}`)]);
    for (const e of coveredCells(pts)) {
      const key = `${e.c},${e.r}`;
      if (!own.has(key) && tall.has(key) && (tall.get(key) + 2) * DIM.slot > e.zMin) out.push(`a track hits something at ${key}`);
      for (const o of runs) if (o.c === e.c && o.r === e.r && o.seg < i - 1 && e.zMin - o.zMax < clear && o.zMin - e.zMax < clear && !own.has(key)) { out.push(`tracks cross at ${key}`); break; }
      runs.push({ ...e, seg: i });
    }
  });
  return [...new Set(out)];
}
