// Grows a track one verified move at a time. Every move comes from a behaviour in the
// piece library, every joint must mate by the records' ports, and a move survives only
// if the marble finishes it in every worst-case corner.
import { DIM, HEADINGS, TRACKS, LIB, byKey, names, left, right, back } from '../catalog/parts.js';
import { level, rotToMeet, rotFace } from '../catalog/frame.js';
import { pileOf as pile, keyIn } from '../catalog/sets.js';
import { landing, trackPath, postPath, startPath, markStart, coveredCells, placements, fitsOf } from './geometry.js';
import { samplePath, verify, verifyStep, exitChance } from './physics.js';
import { floorRect } from './floor.js';
import { fitAt, fitCell, portAt, cellsOf, feetOf, tallOf, frameFor } from './fit.js';
import { leaves, enters } from './ports.js';
import { solidOf } from './validate.js';
import { blockTurns, dropInto } from './routes.js';

export function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const shuffle = (xs, rng) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const CLEAR_SLOTS = 2; // headroom a marble needs under a crossing track

export class World {
  constructor(width, depth) { this.width = width; this.depth = depth; this.solid = new Map(); this.runs = []; }
  inside(c, r) { return c >= 0 && r >= 0 && c < this.width && r < this.depth; }
  // A new stack may not stand in or poke up through anything.
  free(c, r, tall) {
    if (!this.inside(c, r) || this.solid.has(`${c},${r}`)) return false;
    return this.runs.every((e) => e.c !== c || e.r !== r || e.zMin > (tall + CLEAR_SLOTS) * DIM.slot);
  }
  runFits(cells, skip) {
    return cells.every((e) => {
      if (!this.inside(e.c, e.r)) return false;
      const key = `${e.c},${e.r}`;
      if (skip.has(key)) return true;
      const tall = this.solid.get(key);
      if (tall !== undefined && (tall + CLEAR_SLOTS) * DIM.slot > e.zMin) return false;
      return this.runs.every((o) => o.c !== e.c || o.r !== e.r
        || e.zMin - o.zMax >= CLEAR_SLOTS * DIM.slot || o.zMin - e.zMax >= CLEAR_SLOTS * DIM.slot);
    });
  }
  add(placed) { for (const [c, r, tall] of placed.solid) this.solid.set(`${c},${r}`, tall); this.runs.push(...placed.cells); }
  remove(placed) { for (const [c, r] of placed.solid) this.solid.delete(`${c},${r}`); this.runs.length -= placed.cells.length; }
}

const clone = (o) => ({ ...o });
const count = (stock, k) => stock[k] ?? 0;
const take = (stock, k) => { if (!(stock[k] > 0)) return false; stock[k]--; return true; };
const takeAll = (stock, keys) => {
  const need = {};
  for (const k of keys) need[k] = (need[k] ?? 0) + 1;
  if (Object.entries(need).some(([k, n]) => count(stock, k) < n)) return false;
  for (const k of keys) stock[k]--;
  return true;
};

const BLOCKS = Object.values(LIB.blocks);
const RISERS = BLOCKS.filter((b) => b.riser);
const TOPS = { straight: BLOCKS.filter((b) => b.cross === 'straight').map((b) => b.key), corner: BLOCKS.filter((b) => b.cross === 'corner').map((b) => b.key) };

// Plain height, built bottom up. A tall riser goes in once when it fits, so the
// odd towers in the box get used too; the rest comes from the most plentiful block.
function takeRisers(stock, n) {
  const out = [];
  let left = n;
  const tall = RISERS.filter((b) => b.height > 1 && b.height <= left && count(stock, b.key) > 0).sort((a, b) => count(stock, b.key) - count(stock, a.key))[0];
  if (tall && left >= tall.height + 1) { stock[tall.key]--; out.push(tall.key); left -= tall.height; }
  while (left > 0) {
    const b = RISERS.filter((x) => x.height <= left && count(stock, x.key) > 0).sort((a, c) => count(stock, c.key) - count(stock, a.key) || a.height - c.height)[0];
    if (!b) return null;
    stock[b.key]--; out.push(b.key); left -= b.height;
  }
  return out;
}

const cellAt = (c, r, h, k = 1) => [c + HEADINGS[h][0] * k, r + HEADINGS[h][1] * k];
const keyOf = ([c, r]) => `${c},${r}`;

// A stack h slots high whose top block's record has a route from `enter` to `leave`,
// with the turn that lines that route up. Blocks below it are plain height.
function routedStack(stock, h, enter, leave, allowed) {
  for (const b of BLOCKS) {
    if (count(stock, b.key) <= 0 || h < b.height || (allowed && !allowed.includes(b.key))) continue;
    const turns = blockTurns(b.key, enter, leave, h - b.height);
    if (!turns.length) continue;
    const s = { ...stock };
    s[b.key]--;
    const risers = takeRisers(s, h - b.height);
    if (!risers) continue;
    Object.assign(stock, s);
    return { stack: [...risers, b.key], turn: turns[0] };
  }
  return null;
}

// Stacks under each foot cell of a fitted piece, base slots high.
function standOn(fit, stock) {
  const stands = [];
  for (const [c, r] of feetOf(fit)) {
    const stack = fit.base > 0 ? takeRisers(stock, fit.base) : [];
    if (!stack) return null;
    stands.push({ c, r, stack });
  }
  return stands;
}

const inRange = (st, base) => base >= st.minBase && base <= st.maxBase;
const allFree = (world, cells) => cells.every(([c, r, t]) => world.free(c, r, t));

// Each builder makes the post for a landing, or null if the box or floor says no.
// It returns the post, the cells it fills, and the cells its own marble path may cross.
export const BUILD = {
  cross(l, h, stock, opt) {
    const out = opt.turn ?? l.heading, got = h >= 1 && routedStack(stock, h, { face: back(l.heading), level: h }, { face: out, level: h });
    if (!got) return null;
    return { post: { kind: 'cross', c: l.c, r: l.r, h, in: l.heading, out, stack: got.stack }, solid: [[l.c, l.r, h]] };
  },
  fall(l, h, stock, opt, world) {
    const top = opt.top, topLevel = top.block ? top.height : level(top.port.at[2]);
    if (h - topLevel < 1) return null;
    if (!take(stock, top.key)) return null;
    // The marble falls into the block under the drop-in top, which must catch it and send it out.
    const low = routedStack(stock, h - topLevel, { catch: true }, { face: opt.turn, level: h - topLevel });
    if (!low) return null;
    const stack = [...low.stack, ...(top.block ? [top.key] : [])];
    const post = { kind: 'fall', c: l.c, r: l.r, h: h - topLevel, hIn: h, hOut: h - topLevel, in: l.heading, out: opt.turn, stack, rots: { [low.stack.length - 1]: low.turn } };
    if (!top.block) post.fit = { ...fitAt(top.key, top.from, [l.c, l.r], l.heading, h - topLevel), from: top.from };
    void world;
    return { post, solid: [[l.c, l.r, h + (top.block ? 0 : 1)]] };
  },
  spiral(l, h, stock, opt, world) {
    const sp = opt.spiral, side = opt.side;
    if (h - sp.drop < 1 || !take(stock, sp.key)) return null;
    // The tail drops into the block below the host. A straight block there would send the
    // marble out under the track it came in on, so it is a corner block turning it away
    // from the spiral (the record's adjacent-face rule).
    const top = TOPS.straight.find((k) => count(stock, k) > 0 && LIB.blocks[k].height === 1);
    if (!top) return null;
    stock[top]--;
    const sideH = side > 0 ? right(l.heading) : left(l.heading), reserve = [], out = side > 0 ? left(l.heading) : right(l.heading);
    // The tail comes back into the block under the host through the face the band hangs
    // on, so that block needs a route by its record from that face to the way out.
    const low = routedStack(stock, h - 1, { face: l.heading, level: h - 1 }, { face: out, level: h - 1 });
    if (!low) return null;
    const lower = low.stack, stack = [...lower, top], turn = low.turn;
    for (let k = 1; k <= sp.footprint[0]; k++) {
      const [c1, r1] = cellAt(l.c, l.r, l.heading, k);
      for (let s = 0; s < sp.footprint[1]; s++) reserve.push(cellAt(c1, r1, sideH, s));
    }
    if (!reserve.every(([c, r]) => world.free(c, r, h))) return null;
    return {
      post: { kind: 'spiral', piece: sp.key, c: l.c, r: l.r, h: h - 1, hIn: h, hOut: h - sp.drop, in: l.heading, out, stack, rots: { [lower.length - 1]: turn }, spiralSide: side, spiralCells: reserve.map(keyOf) },
      solid: [[l.c, l.r, h], ...reserve.map(([c, r]) => [c, r, h])], own: reserve.map(keyOf),
    };
  },
  station(l, h, stock, opt, world) {
    const st = opt.st, fit = fitAt(st.key, st.from, [l.c, l.r], l.heading, 0);
    fit.base = h - portAt(fit, st.from).level;
    if (!inRange(st, fit.base)) return null;
    if (opt.face !== undefined) fit.faces = { ...fit.faces, [st.to]: opt.face };
    const o = portAt(fit, st.to);
    if (o.face === null || (o.face === back(l.heading) && o.c === l.c && o.r === l.r && st.kind !== 'carry' && st.kind !== 'rest')) return null;
    const tall = tallOf(fit), cells = cellsOf(fit).map(([c, r]) => [c, r, tall]);
    if (!allFree(world, cells) || !takeAll(stock, st.parts)) return null;
    const stands = standOn(fit, stock);
    if (!stands) return null;
    const post = {
      kind: 'station', act: st.kind, piece: st.key, fit: { ...fit, from: st.from, to: st.to }, entry: { c: l.c, r: l.r },
      c: o.c, r: o.r, h: o.level, hIn: h, hOut: o.level, in: l.heading, out: o.face, stack: [], stands, maxCatch: st.maxCatch,
    };
    return { post, solid: cells, own: cells.map(keyOf), metal: st.needsMetal };
  },
  jump(l, h, stock, opt, world) {
    const { st, ct, gap } = opt, ramp = fitAt(st.key, st.from, [l.c, l.r], l.heading, 0);
    ramp.base = h - portAt(ramp, st.from).level;
    if (!inRange(st, ramp.base)) return null;
    const lip = portAt(ramp, st.to);
    if (lip.face !== l.heading) return null;
    const cp = frameFor(ct.key).ports[ct.from];
    if (cp.faceList.length !== 1) return null;
    const catchCell = cellAt(lip.c, lip.r, l.heading, gap + 1);
    const catcher = fitCell(ct.key, cp.cell, catchCell, rotToMeet(cp.faceList[0], l.heading), 0);
    const rise = byKey(st.key).ports.find((p) => p.id === st.to).at[2] - cp.z, cb = ramp.base + rise;
    if (Math.abs(cb - Math.round(cb)) > 0.26) return null;
    catcher.base = Math.round(cb);
    if (!inRange(ct, catcher.base)) return null;
    const give = portAt(catcher, ct.to), take0 = portAt(catcher, ct.from);
    if (Math.hypot(take0.x - lip.x, take0.y - lip.y) > gap + 0.01) return null;
    const flyTall = lip.level + 1;
    const cells = [
      ...cellsOf(ramp).map(([c, r]) => [c, r, tallOf(ramp)]),
      ...Array.from({ length: gap }, (_, k) => [...cellAt(lip.c, lip.r, l.heading, k + 1), flyTall]),
      ...cellsOf(catcher).filter(([c, r]) => ct.out !== 'drop' || c !== give.c || r !== give.r).map(([c, r]) => [c, r, tallOf(catcher)]),
    ];
    if (!allFree(world, cells) || !takeAll(stock, [...st.parts, ...ct.parts])) return null;
    const stands = [...(standOn(ramp, stock) ?? [null]), ...(standOn(catcher, stock) ?? [null])];
    if (stands.includes(null)) return null;
    const post = {
      kind: 'jump', piece: st.key, ramp: { ...ramp, from: st.from, to: st.to }, catcher: { ...catcher, from: ct.from, to: ct.to }, entry: { c: l.c, r: l.r },
      hIn: h, in: l.heading, stack: [], stands, stores: ct.stores, gap,
    };
    const own = cells.map(keyOf);
    if (ct.out === 'drop') {
      const top = give.level, out = opt.turn ?? l.heading;
      const got = routedStack(stock, top, dropInto(post.catcher, ct.to, top), { face: out, level: top });
      if (!got || !world.free(give.c, give.r, top)) return null;
      Object.assign(post, { c: give.c, r: give.r, h: top, hOut: top, out, stack: got.stack, rots: { [got.stack.length - 1]: got.turn }, drops: true });
      return { post, solid: [...cells, [give.c, give.r, top]], own: [...own, keyOf([give.c, give.r])], metal: st.needsMetal || ct.needsMetal };
    }
    Object.assign(post, { c: give.c, r: give.r, h: give.level, hOut: give.level, out: give.face });
    return { post, solid: cells, own, metal: st.needsMetal || ct.needsMetal };
  },
  toss(l, h, stock, opt, world) {
    const { st, ct, dir, face } = opt, fit = fitAt(st.key, st.from, [l.c, l.r], l.heading, 0);
    fit.base = h - portAt(fit, st.from).level;
    if (!inRange(st, fit.base)) return null;
    const tube = portAt(fit, st.to), apexZ = tube.z - st.drop;
    const fr = frameFor(ct.key), mouth = fr.ports[ct.from], throat = fr.ports[ct.to];
    const reach = Math.round(Math.abs(mouth.x - throat.x)), hb = Math.round(apexZ - mouth.z);
    if (reach < 1 || hb < 2 || face === back(dir)) return null;
    const [tc, tr] = cellAt(tube.c, tube.r, dir, reach);
    const hood = fitCell(ct.key, throat.cell, [tc, tr], back(dir), hb);
    const launcherCells = cellsOf(fit).map(([c, r]) => [c, r, tallOf(fit)]);
    const over = Array.from({ length: reach - 1 }, (_, k) => [...cellAt(tube.c, tube.r, dir, k + 1), hb + 2]);
    const cells = [...launcherCells.filter(([c, r]) => c !== tube.c || r !== tube.r), [tube.c, tube.r, hb + 2], ...over];
    if (!allFree(world, [...cells, [tc, tr, hb + 2]]) || !take(stock, ct.key) || !takeAll(stock, st.parts)) return null;
    // The hood lets the marble fall into the tower's top block, which must send it out `face`.
    const tower = routedStack(stock, hb, { catch: true }, { face, level: hb }), stands = tower && standOn(fit, stock);
    if (!tower || !stands) return null;
    const post = {
      kind: 'toss', piece: st.key, fit: { ...fit, from: st.from, to: st.to }, hood: { ...hood, from: ct.from, to: ct.to }, entry: { c: l.c, r: l.r },
      c: tc, r: tr, h: hb, hIn: h, hOut: hb, apexZ, in: l.heading, out: face, stack: tower.stack, rots: { [tower.stack.length - 1]: tower.turn }, stands, maxCatch: st.maxCatch,
    };
    return { post, solid: [...cells, [tc, tr, hb + 2]], own: [...cells, [tc, tr]].map(keyOf), metal: st.needsMetal };
  },
};

const ENDS = LIB.ends;
const RESTS = LIB.stations.filter((s) => s.kind === 'rest');

// Each way to finish here: a catching end piece clipped to a block, or a waiting piece.
export function endings(from, stock, world, rng) {
  const top = from.hOut ?? from.h, outs = [];
  const moves = shuffle(Object.values(TRACKS).filter((t) => count(stock, t.key) > 0 && leaves(from, t.key)), rng);
  const trays = ENDS.filter((e) => e.clip.length && takeable(stock, e.parts));
  for (const t of moves) for (const side of t.kind === 'straight' ? [1] : [1, -1]) for (const drop of t.drops) {
    const h = top - drop, l = landing(from, from.out, t.key, side);
    if (!world.free(l.c, l.r, 0)) continue;
    for (const e of trays) {
      const fr = frameFor(e.key), p = fr.ports[e.port];
      if (h !== level(p.z)) continue;
      outs.push({ t, side, drop, l, h, end: e });
    }
    if (!trays.length) for (const st of RESTS) if (takeable(stock, st.parts)) outs.push({ t, side, drop, l, h, rest: st });
  }
  return outs;
}

const takeable = (stock, keys) => takeAll({ ...stock }, keys);

function buildEnd(o, stock, world) {
  const { l, h } = o;
  if (o.end) {
    const e = o.end, got = routedStack(stock, h, { face: back(l.heading), level: h }, { face: l.heading, level: h }, e.clip), stack = got?.stack;
    if (!stack || !takeAll(stock, e.parts)) return null;
    const [c1, r1] = cellAt(l.c, l.r, l.heading);
    const fit = fitAt(e.key, e.port, [c1, r1], l.heading, 0), endCells = cellsOf(fit);
    if (!endCells.every(([c, r]) => world.free(c, r, 1))) return null;
    const post = { kind: 'end', piece: e.key, c: l.c, r: l.r, h, in: l.heading, out: l.heading, stack, fit: { ...fit, from: e.port }, endCells, floorCells: endCells, maxCatch: e.maxCatch };
    return { post, solid: [[l.c, l.r, h], ...endCells.map(([c, r]) => [c, r, 1])], own: endCells.map(keyOf) };
  }
  const st = o.rest, fit = fitAt(st.key, st.from, [l.c, l.r], l.heading, 0);
  fit.base = h - portAt(fit, st.from).level;
  if (!inRange(st, fit.base)) return null;
  const cells = cellsOf(fit).map(([c, r]) => [c, r, tallOf(fit)]);
  if (!allFree(world, cells) || !takeAll(stock, st.parts)) return null;
  const stands = standOn(fit, stock);
  if (!stands) return null;
  const post = { kind: 'end', act: 'rest', piece: st.key, entry: { c: l.c, r: l.r }, c: l.c, r: l.r, h, hIn: h, in: l.heading, out: portAt(fit, st.to).face, stack: [], stands, fit: { ...fit, from: st.from, to: st.to }, maxCatch: st.maxCatch };
  return { post, solid: cells, own: cells.map(keyOf), metal: st.needsMetal };
}

// Puts a built post after the last one, if the joint mates and the path fits the room.
function attach(state, m, built, world) {
  const from = state.posts[state.posts.length - 1], { post } = built;
  if (!enters(post, m.code)) return null;
  if (built.metal && !state.metalOk) return null;
  const seg = { code: m.code, side: m.side, drop: m.drop }, pts = [];
  trackPath(pts, from, post, seg, 'x');
  postPath(pts, post, 'y');
  const home = post.entry ?? post, cells = coveredCells(pts);
  // What the post fills is judged by the validator's own rule, so the two always agree.
  const solid = solidOf(post);
  if (!allFree(world, solid)) return null;
  const skip = new Set([keyOf([from.c, from.r]), keyOf([home.c, home.r]), keyOf([post.c, post.r]), ...solid.map(keyOf), ...(built.own ?? []), ...(from.spiralCells ?? [])]);
  if (!world.runFits(cells, skip)) return null;
  return { post, seg, placed: { solid, cells }, metal: !!built.metal };
}

// Only the new piece is simulated, from the speeds the marble arrives with.
function stepSpeeds(state, r) {
  const pts = [], from = state.posts[state.posts.length - 1], i = state.segs.length;
  if (i === 0) startPath(pts, from);
  trackPath(pts, from, r.post, r.seg, `t${i}`);
  postPath(pts, r.post, `p${i + 1}`);
  if (i === 0) markStart(pts, { posts: [from] });
  return verifyStep(pts, i === 0 ? null : state.speeds);
}

const FEATURE = new Set(['station', 'jump', 'toss', 'fall', 'spiral']);
// A random splitter is never on a generated route: half the marbles would leave it the other way.
const STATIONS = LIB.stations.filter((s) => !s.start && ['inline', 'rest', 'carry'].includes(s.kind) && exitChance(byKey(s.key)) >= 1);
const RAMPS = LIB.stations.filter((s) => s.kind === 'ramp');
const TOSSES = LIB.stations.filter((s) => s.kind === 'toss');
const inLevel = (st) => level(frameFor(st.key).ports[st.from].z);
const riseOf = (st, ct) => frameFor(st.key).ports[st.to].z - frameFor(ct.key).ports[ct.from].z;
const catchersFor = (st) => LIB.catchers.filter((c) => c.accepts.some((s) => s.includes(st.code)));
const restartLevels = (stock) => [...STATIONS.filter((s) => s.kind === 'carry' || s.kind === 'rest'), ...TOSSES]
  .filter((s) => takeable(stock, s.parts)).map((s) => inLevel(s) + s.minBase);

// Every legal next step, weighed. Pieces not used yet in this run weigh most.
function candidates(state, stock, rng, world, plan) {
  const out = [], post = state.posts[state.posts.length - 1], here = post.hOut ?? post.h, i = state.segs.length;
  const used = state.used, fresh = (k) => (used.has(k) ? 0 : 1);
  const feature = i - (state.lastFeature ?? -9) >= plan.spacing;
  const add = (m, w) => out.push({ ...m, w: w + rng() * 1.2 });
  for (const t of Object.values(TRACKS)) {
    if (count(stock, t.key) <= 0 || (t.metalOnly && !state.metalOk) || !leaves(post, t.key)) continue;
    for (const side of t.kind === 'straight' ? [1] : [1, -1]) for (const drop of t.drops) {
      const h = here - drop;
      if (h < 0) continue;
      const land = landing(post, post.out, t.key, side);
      if (!world.free(land.c, land.r, 0)) continue;
      const room = (c, r, hd) => { let n = 0; for (let k = 1; k <= 4; k++) { const [x, y] = cellAt(c, r, hd, k); if (!world.free(x, y, 0)) break; n++; } return n < 1 ? -4 : n * 0.15; };
      const pace = plan.pace(here, h, i), base = pace + fresh(t.key) * plan.freshTrack + room(land.c, land.r, land.heading);
      const m = { code: t.key, side, drop, h, land };
      if (h >= 1) {
        add({ ...m, kind: 'cross', opt: {} }, base);
        for (const turn of [right(land.heading), left(land.heading)]) add({ ...m, kind: 'cross', opt: { turn } }, base - 0.3 + room(land.c, land.r, turn) - room(land.c, land.r, land.heading));
      }
      if (!feature) continue;
      const bonus = (k) => plan.fresh * fresh(k) + plan.feature;
      for (const top of LIB.dropTops) if (count(stock, top.key) > 0 && h >= 2) for (const turn of [land.heading, right(land.heading), left(land.heading)]) {
        add({ ...m, kind: 'fall', opt: { top, turn } }, base + bonus(top.key) * 0.8 + room(land.c, land.r, turn) + plan.drop(here));
      }
      for (const sp of LIB.spirals) if (count(stock, sp.key) > 0 && h - sp.drop >= 1) for (const s of sp.side ? [sp.side] : [1, -1]) add({ ...m, kind: 'spiral', opt: { spiral: sp, side: s } }, base + bonus(sp.key) + plan.drop(here));
      for (const st of STATIONS) {
        if (!takeable(stock, st.parts) || !inRange(st, h - inLevel(st))) continue;
        const restart = st.kind === 'carry' || st.kind === 'rest', faces = frameFor(st.key).ports[st.to].faceList.length > 1 ? [land.heading, right(land.heading), left(land.heading)] : [undefined];
        for (const face of faces) add({ ...m, kind: 'station', opt: { st, face } }, base + bonus(st.key) + (restart ? plan.restart(here, h) : 0));
      }
      for (const st of RAMPS) {
        if (!takeable(stock, st.parts) || !inRange(st, h - inLevel(st))) continue;
        for (const ct of catchersFor(st)) {
          if (!inRange(ct, Math.round(h - inLevel(st) + riseOf(st, ct))) || !takeable(stock, [...st.parts, ...ct.parts])) continue;
          const turns = ct.out === 'drop' ? [undefined, right(land.heading), left(land.heading)] : [undefined];
          for (const gap of [0, 1, 2]) for (const turn of turns) add({ ...m, kind: 'jump', opt: { st, ct, gap, turn } }, base + bonus(st.key) + bonus(ct.key) - gap * 0.3);
        }
      }
      for (const st of TOSSES) {
        if (!takeable(stock, st.parts) || !inRange(st, h - inLevel(st))) continue;
        for (const ct of catchersFor(st)) if (count(stock, ct.key) > 0) for (const dir of [land.heading, left(land.heading), right(land.heading)]) for (const face of [0, 1, 2, 3]) {
          add({ ...m, kind: 'toss', opt: { st, ct, dir, face } }, base + bonus(st.key) + plan.restart(here, h));
        }
      }
    }
  }
  return out.sort((a, b) => b.w - a.w);
}

function score(track, plan) {
  const parts = placements(track), keys = new Set(parts.map((p) => p.key));
  const kinds = new Set(track.posts.map((p) => p.act ?? p.kind));
  return Math.min(track.segs.length, plan.target) * 3 + parts.length * plan.perPart + keys.size * 2 + kinds.size * 5;
}

// Levels a marble must arrive at for each ramp and catcher pair in the pile to fit:
// a hand launcher can start there and fire straight into the jump.
function jumpLevels(stock) {
  const out = [];
  for (const st of RAMPS) for (const ct of catchersFor(st)) {
    if (!takeable(stock, [...st.parts, ...ct.parts])) continue;
    out.push(inLevel(st) + Math.max(st.minBase, Math.ceil(ct.minBase - riseOf(st, ct))));
  }
  return out;
}

// Places the start piece somewhere on the floor, facing a random way. A gravity start
// stands as high as the size asks; a hand launcher stands low, its push is its energy.
function startPost(st, stock, world, rng, height) {
  const fr = frameFor(st.key), out = fr.ports[st.to];
  if (out.faceList.length !== 1) return null;
  // A few random spots, the one with the longest open run ahead first.
  const spots = Array.from({ length: 40 }, () => [Math.floor(rng() * 4), Math.floor(rng() * world.width), Math.floor(rng() * world.depth)])
    .map(([hd, c, r]) => { let n = 0; while (n < 16 && world.inside(...cellAt(c, r, hd, n + 1))) n++; return { hd, c, r, n: n + rng() }; })
    .sort((a, b) => b.n - a.n);
  for (const { hd, c, r } of spots) {
    const fit = fitCell(st.key, out.cell, [c, r], (hd - out.faceList[0] + 4) % 4, 0);
    const ready = st.kind === 'rest' ? jumpLevels(stock) : [];
    const want = st.kind !== 'rest' ? height - portAt(fit, st.to).level
      : ready.length && rng() < 0.5 ? ready[Math.floor(rng() * ready.length)] - portAt(fit, st.to).level : st.minBase + Math.floor(rng() * 3);
    fit.base = Math.max(st.minBase, Math.min(st.maxBase, want));
    const o = portAt(fit, st.to), inn = portAt(fit, st.from), tall = tallOf(fit), cells = cellsOf(fit).map(([x, y]) => [x, y, tall]);
    if (!allFree(world, cells)) continue;
    const s = { ...stock };
    if (!takeAll(s, st.parts)) return null;
    const stands = standOn(fit, s);
    if (!stands) continue;
    for (const k of Object.keys(s)) stock[k] = s[k];
    const post = {
      kind: 'station', act: st.kind, piece: st.key, first: true, fit: { ...fit, from: st.from, to: st.to },
      entry: { c: inn.c, r: inn.r }, c: o.c, r: o.r, h: o.level, hOut: o.level, hIn: o.level, in: o.face, out: o.face, stack: [], stands,
    };
    return { post, solid: cells, metal: st.needsMetal };
  }
  return null;
}

const STARTS = [
  ...LIB.stations.filter((s) => s.kind === 'start'),
  ...LIB.stations.filter((s) => s.kind === 'carry' && s.start),
  ...RESTS,
];

export const SIZES = Object.freeze([
  { name: 'little', moves: 6, height: 5, spacing: 3, fresh: 1.2, deadlineMs: 1500 },
  { name: 'big', moves: 12, height: 7, spacing: 2, fresh: 2.2, deadlineMs: 2500 },
  // Super long aims at the whole pile: as many tracks as the box holds, every special piece it can fit.
  { name: 'super', moves: Infinity, height: 8, spacing: 1, fresh: 4, deadlineMs: 4500, whole: true },
]);

export const stats = { attempts: 0, nodes: 0, reject: {} };

// Hangs clip-on decorations on the pieces they belong to.
function decorate(track, stock) {
  for (const d of LIB.decor) {
    let n = count(stock, d.key);
    for (const p of track.posts) for (const fit of fitsOf(p)) {
      if (n <= 0 || !d.hosts.includes(byKey(fit.key)?.code)) continue;
      (p.decor ??= []).push({ key: d.key, c: portAt(fit, fit.from)?.c ?? p.c, r: portAt(fit, fit.from)?.r ?? p.r, y: tallOf(fit), rot: fit.rot });
      n--; stock[d.key]--;
    }
    for (const s of track.segs) {
      if (n <= 0 || !d.hosts.includes(byKey(s.code)?.code)) continue;
      (s.decor ??= []).push(d.key); n--; stock[d.key]--;
    }
  }
}

export function generate({ stock: given, size = 1, moves, seed = 1, startHeight, deadlineMs, metal = true }) {
  const rng = mulberry(seed), spec = SIZES[size], deadlineSpan = deadlineMs ?? spec.deadlineMs, began = Date.now();
  // Time is up at the deadline, unless no track has been found yet: then one more span.
  const late = () => Date.now() > began + deadlineSpan * (best ? 1 : 2);
  const trackCount = Object.values(TRACKS).reduce((n, t) => n + count(given, t.key), 0);
  const target = moves ?? (spec.whole ? Math.max(8, Math.round(trackCount * 0.85)) : spec.moves);
  const top = startHeight ?? spec.height;
  // A whole-pile run tries both the roomiest floor and the longest one, keeping the better track.
  const rects = spec.whole ? [floorRect(given, 14, 'room'), floorRect(given, 14, 'long')] : [floorRect(given, 10)];
  let { width, depth } = rects[0];
  const plan = {
    target, spacing: spec.spacing, fresh: spec.fresh, feature: spec.whole ? 1.5 : 0.6, freshTrack: spec.whole ? 0.8 : 0.3, perPart: spec.whole ? 0.6 : 0.1,
    goal: 1,
    pace(here, h, i) {
      const left = Math.max(2, (target - i) * 0.5), want = (here - this.goal) / left;
      return (here - h) > 0 ? Math.min(2.5, want * 1.6) - 0.4 : -Math.min(2, want * 0.8) + 0.2;
    },
    drop(here) { return here > this.goal + 1 ? 0.6 : -2; },
    restart(here, h) { return h <= 2 ? 6 : -1; },
  };
  let best = null;
  const finish = (state, stock, world) => {
    const from = state.posts[state.posts.length - 1];
    const why = (stage) => { stats.reject[`end:${stage}`] = (stats.reject[`end:${stage}`] ?? 0) + 1; };
    for (const o of endings(from, stock, world, rng).slice(0, 24)) {
      const st = clone(stock);
      if (!take(st, o.t.key)) continue;
      const built = buildEnd(o, st, world);
      if (!built) { why('build'); continue; }
      const r = attach(state, { code: o.t.key, side: o.side, drop: o.drop }, built, world);
      if (!r) { why('fit'); continue; }
      if (!stepSpeeds(state, r)) { why('physics'); continue; }
      const track = { posts: [...state.posts, r.post], segs: [...state.segs, r.seg], marble: state.metal || r.metal || o.t.metalOnly ? 'metal' : 'plain' };
      const s = score(track, plan);
      if (best && s <= best.score) return;
      if (!verify(samplePath(buildPathOf(track))).ok) continue;
      // Posts are shared between search branches, so the kept track is a copy.
      const kept = JSON.parse(JSON.stringify(track));
      decorate(kept, st);
      best = { score: s, track: kept, width, depth };
      return;
    }
  };
  const satisfied = () => best && best.track.segs.length >= Math.min(target, trackCount - 1);

  let budget = 0;
  const dfs = (state, stock, world) => {
    if (budget-- <= 0 || late()) return;
    stats.nodes++;
    const i = state.segs.length;
    if (i >= 2) finish(state, stock, world);
    if (i >= target) return;
    const post = state.posts[state.posts.length - 1], here = post.hOut ?? post.h;
    const restarts = restartLevels(stock);
    plan.goal = restarts.length ? Math.max(1, Math.min(...restarts)) : 1;
    let explored = 0;
    for (const m of candidates(state, stock, rng, world, plan)) {
      if (explored >= (i < 2 ? 2 : 3)) break;
      const st = clone(stock);
      if (!take(st, m.code)) continue;
      const why = (stage) => { const k = `${m.kind}:${stage}`; stats.reject[k] = (stats.reject[k] ?? 0) + 1; };
      const built = BUILD[m.kind](m.land, m.h, st, m.opt, world);
      if (!built) { why('build'); continue; }
      const r = attach(state, m, built, world);
      if (!r) { why('fit'); continue; }
      const speeds = stepSpeeds(state, r);
      if (!speeds) { why('physics'); continue; }
      why('ok');
      explored++;
      const used = new Set(state.used);
      for (const p of placementsOfPost(r.post)) used.add(p);
      used.add(m.code);
      const next = {
        ...state, posts: [...state.posts, r.post], segs: [...state.segs, r.seg], speeds, used, metal: state.metal || r.metal || TRACKS[m.code].metalOnly,
        lastFeature: FEATURE.has(r.post.kind) && !(r.post.kind === 'station' && r.post.act === 'inline' && false) ? i : state.lastFeature,
      };
      world.add(r.placed);
      dfs(next, st, world);
      world.remove(r.placed);
      if (satisfied()) return;
      void here;
    }
  };

  // Many short searches from fresh starts beat one long search stuck in a corner.
  let attempt = 0;
  while (!late()) {
    stats.attempts++;
    const startsHere = STARTS.filter((s) => takeable(given, s.parts) && (metal || !s.needsMetal));
    if (!startsHere.length) break;
    // The first start piece listed (a gravity start if the pile has one) is tried most;
    // a whole-pile run takes every start and every floor in turn.
    const k = attempt++;
    const st = spec.whole ? startsHere[k % startsHere.length] : startsHere[k === 0 || rng() < 0.6 ? 0 : Math.floor(rng() * startsHere.length)];
    ({ width, depth } = rects[Math.floor(k / startsHere.length) % rects.length]);
    const stock = clone(given), world = new World(width, depth);
    const made = startPost(st, stock, world, rng, Math.min(top, 8));
    if (!made) continue;
    world.add({ solid: solidOf(made.post), cells: [] });
    budget = 80 + Math.min(target, 60) * 30;
    const used = new Set([made.post.piece, ...placementsOfPost(made.post)]);
    const state = { posts: [made.post], segs: [], used, metal: !!made.metal, metalOk: metal };
    dfs(state, stock, world);
    if (satisfied() && !spec.whole) break;
  }
  return best;
}

const placementsOfPost = (post) => [post.piece, ...post.stack, ...fitsOf(post).map((f) => f.key)].filter(Boolean);
const buildPathOf = (track) => { const pts = []; startPath(pts, track.posts[0]); track.segs.forEach((seg, i) => { trackPath(pts, track.posts[i], track.posts[i + 1], seg, `t${i}`); postPath(pts, track.posts[i + 1], `p${i + 1}`); }); markStart(pts, track); return pts; };

export function partsUsed(track) {
  const n = {};
  for (const p of placements(track)) n[p.key] = (n[p.key] ?? 0) + 1;
  return n;
}

// One pile of parts from every chosen set, as Josh plays with them.
export const pileOf = pile;

// Hands each used part to a real set, alternating so the colours mix. A part whose
// mould differs by set only comes from a set with that mould.
export function colourPieces(track, sets) {
  const remaining = sets.map((s) => ({ ...s.parts }));
  let turn = 0;
  return placements(track).map((p) => {
    for (let i = 0; i < sets.length; i++) {
      const k = (turn + i) % sets.length;
      if (!(remaining[k][p.code] > 0) || keyIn(p.code, sets[k].id) !== p.key) continue;
      remaining[k][p.code]--; turn = k + 1;
      return { ...p, set: sets[k].id, color: sets[k].colors?.[p.code] ?? null };
    }
    return { ...p, set: null, color: null };
  });
}

void rotFace; void names;
