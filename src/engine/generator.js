// Grows a track one verified move at a time. Every move comes from a behaviour in the
// piece library, every joint must mate by the records' ports, and a move survives only
// if the marble finishes it in every worst-case corner.
import { DIM, HEADINGS, TRACKS, LIB, byKey, names, left, right, back } from '../catalog/parts.js';
import { level, rotToMeet, rotFace, FACE, rotXY } from '../catalog/frame.js';
import { pileOf as pile, keyIn } from '../catalog/sets.js';
import { landing, trackPath, postPath, startPath, markStart, coveredCells, placements, fitsOf, placePost, placeSeg } from './geometry.js';
import { samplePath, verify, verifyStep, exitChance, simulate } from './physics.js';
import { Growing, checkAll } from './physical.js';
import { runAfterOf, runFrom } from './runafter.js';
import { floorRect } from './floor.js';
import { fitAt, fitCell, portAt, cellsOf, feetOf, tallOf, frameFor, originOf } from './fit.js';
import { leaves, enters } from './ports.js';
import { solidOf } from './validate.js';
import { tossSetup, speedThrough, fly, bestShot, CATCH } from './ballistic.js';
import { localSolid, V as VOX } from './solids.js';
import { blockTurns, dropInto } from './routes.js';
import { fun } from './fun.js';

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
  // over: plastic held up by something else reaching over this cell (an arm, a knob),
  // which may lie past the floor's edge but not in another stack.
  free(c, r, tall, over = false) {
    if (over && !this.inside(c, r)) return true;
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
// The floor cells a fitted piece's plastic covers (its model, solids.js), with the
// height it fills there: the record's port cells and any arm or hood the model reaches
// over a neighbour, so the cheap cell test leaves room the physical rules would ask for.
const COVER = new Map(), SIDE_TYPES = new Set(['track-end', 'port-hole', 'block-top-slot', 'block-side-slot']);
function coverOf(fit) {
  const id = `${fit.key}|${fit.rot}`;
  if (!COVER.has(id)) {
    const v = localSolid(fit.key).vox, n = new Map();
    // Plastic counts in a cell only well inside it: a lip or tab over its edge does not.
    for (let q = 0; q < v.length; q += 3) {
      const [x, y] = rotXY([(v[q] + 0.5) * VOX, (v[q + 1] + 0.5) * VOX], fit.rot), [c, r] = [Math.round(x), Math.round(y)];
      if (Math.max(Math.abs(x - c), Math.abs(y - r)) > 0.25) continue;
      const k = `${c},${r}`;
      n.set(k, (n.get(k) ?? 0) + 1);
    }
    // The cell a track or tongue lies in just past a joining port is the joint's, not the
    // piece's (a launcher's nose takes the track's tongue in its channel).
    const D = { E: [1, 0], S: [0, 1], W: [-1, 0], N: [0, -1] };
    for (const p of byKey(fit.key).ports) {
      const f = D[p.faces];
      if (!f || !SIDE_TYPES.has(p.type)) continue;
      const [x, y] = rotXY([p.at[0] + f[0] * 0.75, p.at[1] + f[1] * 0.75], fit.rot);
      n.delete(`${Math.round(x)},${Math.round(y)}`);
    }
    COVER.set(id, [...n].filter(([, c]) => c >= 12).map(([k]) => k.split(',').map(Number)));
  }
  const [oc, or] = originOf(fit), tall = tallOf(fit);
  return COVER.get(id).map(([x, y]) => [Math.round(oc + x), Math.round(or + y), tall, true]);
}
const withCover = (fit, cells) => {
  const seen = new Set(cells.map(([c, r]) => `${c},${r}`));
  return [...cells, ...coverOf(fit).filter(([c, r]) => !seen.has(`${c},${r}`))];
};
// The hand's throw from a launcher into a catcher's mouth, or null: the speed whose arc
// passes the mouth's middle when there is one, else the best of the hand's speeds.
// { v, t }: the speed and the time to the mouth, which the drawn arc follows.
// The throw depends only on the launcher's turn and where the hood stands from it, so
// each shape is flown once.
const THROWS = new Map();
function throwInto(launcher, hood) {
  const id = `${launcher.key} ${launcher.from} ${launcher.rot} ${hood.key} ${hood.rot} ${hood.at[0] - launcher.at[0]} ${hood.at[1] - launcher.at[1]} ${hood.base - launcher.base}`;
  if (!THROWS.has(id)) THROWS.set(id, flyInto(launcher, hood));
  return THROWS.get(id);
}
function flyInto(launcher, hood) {
  const set = tossSetup(launcher, hood, CATCH), top = set.speeds.at(-1), v = speedThrough(set.from, set.dir, set.cone.at);
  if (v && v <= top && set.speeds.length > 1) { const f = fly(set.from, set.dir, v, set.cone); if (f.hit) return { v, t: f.t }; }
  const best = bestShot(set.from, set.dir, set.speeds.filter((_, k) => k % 3 === 0), set.cone);
  return best?.hit ? { v: best.v, t: best.t } : null;
}
// Which marbles a ramp and its catcher need (D5): a piece that holds only a metal marble
// (metal) wants a pile of metal marbles only; one that keeps every marble until a metal
// one triggers it (trigger, a store) wants one metal marble in the run, dropped last.
const needs = (st, ct) => ({ metal: !!st.needsMetal || (!!ct.needsMetal && !ct.stores), trigger: !!ct.needsMetal && !!ct.stores });
// Shapes that failed on geometry alone (piece, ports, heading, height), which moving
// the same move to another cell cannot change: fitting is the same in every cell.
const MISFIT = new Set();
const allFree = (world, cells) => cells.every(([c, r, t, over]) => world.free(c, r, t, over));

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
    const top = TOPS.straight.find((k) => count(stock, k) > 0 && LIB.blocks[k].height === 1);
    if (!top) return null;
    stock[top]--;
    // The band ends on the side face of the block under the host (IMG_0960): that block is
    // turned 90 degrees, so the marble crosses it from the band's side to the far side.
    const sideH = side > 0 ? right(l.heading) : left(l.heading), out = back(sideH), reserve = [];
    const low = routedStack(stock, h - 1, { face: sideH, level: h - 1 }, { face: out, level: h - 1 });
    if (!low) return null;
    const lower = low.stack, stack = [...lower, top], turn = low.turn;
    // The band covers the footprint round the host's front corner: every cell of it but the host's own.
    for (let k = 0; k < sp.footprint[0]; k++) {
      const [c1, r1] = cellAt(l.c, l.r, l.heading, k);
      for (let s = 0; s < sp.footprint[1]; s++) if (k || s) reserve.push(cellAt(c1, r1, sideH, s));
    }
    if (!reserve.every(([c, r]) => world.free(c, r, h))) return null;
    return {
      post: { kind: 'spiral', piece: sp.key, c: l.c, r: l.r, h: h - 1, hIn: h, hOut: h - sp.drop, in: l.heading, out, tailFace: sideH, stack, rots: { [lower.length - 1]: turn }, spiralSide: side, spiralCells: reserve.map(keyOf) },
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
    const tall = tallOf(fit), cells = withCover(fit, cellsOf(fit).map(([c, r]) => [c, r, tall]));
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
    const { st, ct, gap } = opt, up = opt.up ? 1 : 0, shape = `jump ${st.key} ${st.from} ${ct.key} ${ct.from} ${gap} ${up} ${l.heading} ${h}`;
    if (MISFIT.has(shape)) return null;
    const miss = () => { MISFIT.add(shape); return null; };
    const ramp = fitAt(st.key, st.from, [l.c, l.r], l.heading, 0);
    ramp.base = h - portAt(ramp, st.from).level;
    if (!inRange(st, ramp.base)) return miss();
    const lip = portAt(ramp, st.to);
    if (lip.face !== l.heading) return miss();
    const cp = frameFor(ct.key).ports[ct.from];
    if (cp.faceList.length !== 1) return miss();
    const catchCell = cellAt(lip.c, lip.r, l.heading, gap + 1);
    const catcher = fitCell(ct.key, cp.cell, catchCell, rotToMeet(cp.faceList[0], l.heading), 0);
    const rise = byKey(st.key).ports.find((p) => p.id === st.to).at[2] - cp.z, cb = ramp.base + rise;
    // The catcher stands on whole blocks: level with the lip when its mouth is (within a
    // quarter slot), else on the stack nearest that height or (up) the one on its other
    // side, and the flights rule judges whether the arc reaches the mouth (a ring may stand over the lip's
    // height on equal stacks).
    const level = Math.abs(cb - Math.round(cb)) <= 0.26;
    if (level && up) return miss();
    catcher.base = !up ? Math.round(cb) : Math.round(cb) === Math.floor(cb) ? Math.ceil(cb) : Math.floor(cb);
    if (!inRange(ct, catcher.base)) return miss();
    const give = portAt(catcher, ct.to), take0 = portAt(catcher, ct.from);
    // The catch stands `gap` whole cells on, plus whatever the lip falls short of its
    // cell's edge (the T-Rex ramp's lip overhangs its base by a third of a cell, and the
    // mouth's catch is at the front of the feet); the flights rule judges the arc.
    if (Math.hypot(take0.x - lip.x, take0.y - lip.y) >= gap + 1) return miss();
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
      return { post, solid: [...cells, [give.c, give.r, top]], own: [...own, keyOf([give.c, give.r])], ...needs(st, ct) };
    }
    Object.assign(post, { c: give.c, r: give.r, h: give.level, hOut: give.level, out: give.face });
    return { post, solid: cells, own, ...needs(st, ct) };
  },
  toss(l, h, stock, opt, world) {
    const { st, ct, dir, face } = opt, fit = fitAt(st.key, st.from, [l.c, l.r], l.heading, 0);
    fit.base = h - portAt(fit, st.from).level;
    if (!inRange(st, fit.base)) return null;
    // A launcher whose record gives its aim (physics.aim, a vector in the record frame or
    // { vector }) throws only the way it leans, turned with the launcher.
    const aim = byKey(st.key)?.physics?.aim, [ax, ay] = (Array.isArray(aim) ? aim : aim?.vector) ?? [0, 0];
    if (Math.hypot(ax, ay) > 1e-6) {
      const face = Math.abs(ax) >= Math.abs(ay) ? (ax > 0 ? FACE.E : FACE.W) : (ay > 0 ? FACE.S : FACE.N);
      if (rotFace(face, fit.rot) !== dir) return null;
    }
    // The hood goes where the throw goes: a tower `reach` cells along the aim, as high as
    // the arc still enters the hood's mouth inside its catch cone (ballistic.js), and no
    // higher than the record's throw (its dropSlots).
    const tube = portAt(fit, st.to), apexZ = tube.z - st.drop, launcher = { ...fit, from: st.from, to: st.to };
    const fr = frameFor(ct.key), mouth = fr.ports[ct.from], throat = fr.ports[ct.to];
    const near = Math.round(Math.abs(mouth.x - throat.x));
    if (near < 1 || face === back(dir)) return null;
    let reach = 0, hb = 0, hood = null, shot = null;
    if (opt.reach) {
      // A layout as published (a VTech plan): the tower where the plan puts it, judged later.
      reach = opt.reach; hb = opt.tower; hood = fitCell(ct.key, throat.cell, cellAt(tube.c, tube.r, dir, reach), back(dir), hb);
    } else for (let z = Math.floor(apexZ - mouth.z); z >= 2 && !shot; z--) for (let k = near; k <= near + 2 && !shot; k++) {
      const f = fitCell(ct.key, throat.cell, cellAt(tube.c, tube.r, dir, k), back(dir), z), t = throwInto(launcher, { ...f, from: ct.from });
      if (t) { reach = k; hb = z; hood = f; shot = t; }
    }
    if (!hood) return null;
    const [tc, tr] = cellAt(tube.c, tube.r, dir, reach);
    const launcherCells = cellsOf(fit).map(([c, r]) => [c, r, tallOf(fit)]);
    const over = Array.from({ length: reach - 1 }, (_, k) => [...cellAt(tube.c, tube.r, dir, k + 1), hb + 2]);
    const cells = [...launcherCells.filter(([c, r]) => c !== tube.c || r !== tube.r), [tube.c, tube.r, hb + 2], ...over];
    if (!allFree(world, [...cells, [tc, tr, hb + 2]]) || !take(stock, ct.key) || !takeAll(stock, st.parts)) return null;
    // The hood lets the marble fall into the tower's top block, which must send it out `face`.
    const tower = routedStack(stock, hb, { catch: true }, { face, level: hb }), stands = tower && standOn(fit, stock);
    if (!tower || !stands) return null;
    const post = {
      kind: 'toss', piece: st.key, fit: { ...fit, from: st.from, to: st.to }, hood: { ...hood, from: ct.from, to: ct.to }, entry: { c: l.c, r: l.r },
      c: tc, r: tr, h: hb, hIn: h, hOut: hb, apexZ, throw: shot, in: l.heading, out: face, stack: tower.stack, rots: { [tower.stack.length - 1]: tower.turn }, stands, maxCatch: st.maxCatch,
    };
    return { post, solid: [...cells, [tc, tr, hb + 2]], own: [...cells, [tc, tr]].map(keyOf), metal: st.needsMetal };
  },
};

const ENDS = LIB.ends;
const RESTS = LIB.stations.filter((s) => s.kind === 'rest');

// Each way to finish here: a catching end piece clipped to a block, or a waiting piece.
export function endings(from, stock, world, rng, metalOk = true) {
  const top = from.hOut ?? from.h, outs = [];
  const moves = shuffle(Object.values(TRACKS).filter((t) => count(stock, t.key) > 0 && (metalOk || !t.metalOnly) && leaves(from, t.key)), rng);
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
  const cells = withCover(fit, cellsOf(fit).map(([c, r]) => [c, r, tallOf(fit)]));
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
  if ((built.metal && !state.metalOk) || (built.trigger && !state.metalAny)) return null;
  // The new stretch's path, labelled as the finished track labels it: the cell test, the
  // physics and the physical rules all read this one.
  const seg = { code: m.code, side: m.side, drop: m.drop }, pts = [], i = state.segs.length;
  trackPath(pts, from, post, seg, `t${i}`);
  postPath(pts, post, `p${i + 1}`);
  const home = post.entry ?? post, cells = coveredCells(pts);
  // What the post fills is judged by the validator's own rule, so the two always agree.
  const solid = [...solidOf(post), ...(built.solid ?? [])];
  if (!allFree(world, solid)) return null;
  const skip = new Set([keyOf([from.c, from.r]), keyOf([home.c, home.r]), keyOf([post.c, post.r]), ...solid.map(keyOf), ...(built.own ?? []), ...(from.spiralCells ?? [])]);
  if (!world.runFits(cells, skip)) return null;
  return { post, seg, pts, placed: { solid, cells }, metal: !!built.metal || !!built.trigger };
}

// Only the new piece is simulated, from the speeds the marble arrives with.
function stepSpeeds(state, r) {
  const from = state.posts[state.posts.length - 1], i = state.segs.length;
  let pts = r.pts;
  if (i === 0) {
    // The start piece's own leg first; the track then begins where it ends.
    const start = [];
    startPath(start, from);
    const a = start.at(-1), b = pts[0], same = a && b && Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-6;
    pts = [...start, ...(same ? pts.slice(1) : pts)].map((q) => ({ ...q }));
    markStart(pts, { posts: [from] });
  }
  const speeds = verifyStep(pts, i === 0 ? null : state.speeds);
  return speeds && { speeds, pts };
}

// The five physical rules on the new step (physical.js Growing): the track and post
// just built against everything already standing. Kept on success (the search undoes
// it when it backs up), taken back at once on a failure.
function physStep(state, r, pts) {
  const i = state.segs.length, placed = placeSeg([], r.seg, i);
  placePost(placed, r.post, i + 1);
  const lipSpeed = r.post.kind === 'jump' ? flightSpeed(pts, `p${i + 1}j`, i === 0 ? null : state.speeds) : null;
  const fails = state.phys.step({ posts: [...state.posts, r.post], segs: [...state.segs, r.seg], placed, points: pts, lipSpeed });
  if (!fails.length) return true;
  state.phys.undo();
  for (const f of fails) {
    const k = `solid:${f.rule}${stats.detail ? `: ${f.why.replace(/-?[\d.]+ mm/g, 'N mm')}` : ''}`;
    stats.reject[k] = (stats.reject[k] ?? 0) + 1;
  }
  return false;
}

// D6: the run after a strong launcher (runafter.js). The step's run from the last such
// launch must not turn or drop too soon; once the run is past the rule's reach, the zone
// closes. Returns { ok, launch } (the zone the next step is in, or null).
function runAfterStep(state, r, pts) {
  const i = state.segs.length, base = state.phys.path.length;
  let launch = state.launch;
  for (const [post, label] of [[i === 0 ? state.posts[0] : null, 'p0w'], [r.post, `p${i + 1}w`]]) {
    const rule = runAfterOf(post);
    if (!rule) continue;
    let k = -1;
    for (let n = 0; n < pts.length; n++) if (pts[n].piece === label) k = n;
    if (k >= 0) launch = { at: base + k, rule, run: 0 };
  }
  if (!launch) return { ok: true, launch: null };
  const { rule } = launch, reach = Math.max(rule.noTurnCells ?? 0, rule.preferNoTurnCells ?? 0, rule.preferClimbWithinCells ?? 0) * DIM.cell;
  const all = launch.at >= base ? pts.slice(launch.at - base) : [...state.phys.path.slice(launch.at), ...pts];
  const run = runFrom(all, 0, reach + DIM.cell), first = Math.min(run.turn, run.drop);
  if (first < (rule.noTurnCells ?? 0) * DIM.cell) return { ok: false };
  return { ok: true, launch: run.run > reach ? null : { ...launch, run: run.run, turned: first < Infinity, climbed: run.climb < Infinity } };
}

// Weighs a move by the zone it falls in: a turn inside the preferred straight run, or a
// move that is no climb while a climb is still wanted, weighs less.
function zoneBias(zone, m) {
  if (!zone) return 0;
  const cells = zone.run / DIM.cell, { rule } = zone, t = TRACKS[m.code];
  // Where this move would first turn or drop: on a curved track at once, else at the post.
  const curved = t.kind !== 'straight', post = (m.opt.turn !== undefined && m.opt.turn !== m.land.heading) || ['fall', 'spiral', 'toss'].includes(m.kind);
  const at = curved ? cells : post ? cells + t.ahead : m.kind === 'station' ? cells + t.ahead : Infinity;
  let w = 0;
  if (at < (rule.noTurnCells ?? 0)) { if (curved || post) return -Infinity; w -= 4; } // a station may still run straight
  else if (at < (rule.preferNoTurnCells ?? 0)) w -= 2.5;
  if (!zone.climbed && cells < (rule.preferClimbWithinCells ?? 0)) w += m.kind === 'jump' ? 3 : 0;
  return w;
}

// The marble's nominal speed as it leaves the lip into the flight labelled `label` in new
// points: the speed physics.js simulate flies, as the flights rule (physical.js) reads it.
function flightSpeed(pts, label, speeds) {
  const r = simulate(samplePath(pts), speeds ? { startSpeed: speeds[0] } : {}, speeds ? { ignoreStart: true } : {});
  return r.flights?.find((f) => f.piece === label)?.v ?? null;
}

const FEATURE = new Set(['station', 'jump', 'toss', 'fall', 'spiral']);
const THEMES = ['jump', 'spiral', 'rest', 'toss', 'fall', 'inline', 'carry'];
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
  // Plain straight crossings in a row are the dull part of a run (fun.js): one more weighs less.
  let plainRun = 0;
  for (let k = state.posts.length - 1; k > 0 && state.posts[k].kind === 'cross' && state.posts[k].in === state.posts[k].out; k--) plainRun++;
  const dull = plan.fun * 0.6 * Math.max(0, plainRun - 1);
  // The seed's theme (plan.theme): a kind of special move this track leans on until it has one.
  const themed = (m) => plan.theme && (m.kind === 'station' ? m.opt.st.kind : m.kind) === plan.theme && !state.posts.some((p) => !p.first && (p.act ?? p.kind) === plan.theme);
  const add = (m, w) => { const z = zoneBias(state.launch, m); if (z > -Infinity) out.push({ ...m, w: w + rng() * plan.noise + z + (themed(m) ? plan.themeW : 0) }); };
  // What the box still holds is the same for every track tried here, so it is asked once.
  // The builders take the parts again, so a move this lets through can still be refused.
  const stations = STATIONS.filter((st) => takeable(stock, st.parts)), tosses = TOSSES.filter((st) => takeable(stock, st.parts));
  const jumps = RAMPS.flatMap((st) => catchersFor(st).filter((ct) => takeable(stock, [...st.parts, ...ct.parts])).map((ct) => [st, ct]));
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
        add({ ...m, kind: 'cross', opt: {} }, base - dull);
        for (const turn of [right(land.heading), left(land.heading)]) add({ ...m, kind: 'cross', opt: { turn } }, base - 0.3 + room(land.c, land.r, turn) - room(land.c, land.r, land.heading));
      }
      if (!feature) continue;
      const bonus = (k) => plan.fresh * fresh(k) + plan.feature + plan.taste(k);
      for (const top of LIB.dropTops) if (count(stock, top.key) > 0 && h >= 2) for (const turn of [land.heading, right(land.heading), left(land.heading)]) {
        add({ ...m, kind: 'fall', opt: { top, turn } }, base + bonus(top.key) * 0.8 + room(land.c, land.r, turn) + plan.drop(here));
      }
      for (const sp of LIB.spirals) if (count(stock, sp.key) > 0 && h - sp.drop >= 1) for (const s of sp.side ? [sp.side] : [1, -1]) add({ ...m, kind: 'spiral', opt: { spiral: sp, side: s } }, base + bonus(sp.key) + plan.drop(here));
      for (const st of stations) {
        if (!inRange(st, h - inLevel(st))) continue;
        const restart = st.kind === 'carry' || st.kind === 'rest', faces = frameFor(st.key).ports[st.to].faceList.length > 1 ? [land.heading, right(land.heading), left(land.heading)] : [undefined];
        for (const face of faces) add({ ...m, kind: 'station', opt: { st, face } }, base + (st.kind === 'carry' ? plan.lift(h, bonus(st.key)) : bonus(st.key) + (restart ? plan.restart(h) : 0)));
      }
      for (const [st, ct] of jumps) {
        const cb = h - inLevel(st) + riseOf(st, ct), ups = Math.abs(cb - Math.round(cb)) <= 0.26 ? [0] : [0, 1];
        if (!inRange(st, h - inLevel(st))) continue;
        const turns = ct.out === 'drop' ? [undefined, right(land.heading), left(land.heading)] : [undefined];
        for (const up of ups) {
          if (!inRange(ct, !up ? Math.round(cb) : Math.round(cb) === Math.floor(cb) ? Math.ceil(cb) : Math.floor(cb))) continue;
          for (const gap of [0, 1, 2]) for (const turn of turns) add({ ...m, kind: 'jump', opt: { st, ct, gap, turn, up } }, base + bonus(st.key) + bonus(ct.key) - gap * 0.3);
        }
      }
      for (const st of tosses) {
        if (!inRange(st, h - inLevel(st))) continue;
        // The tower cannot send the marble back the way the toss came.
        for (const ct of catchersFor(st)) if (count(stock, ct.key) > 0) for (const dir of [land.heading, left(land.heading), right(land.heading)]) for (const face of [0, 1, 2, 3]) if (face !== back(dir)) {
          add({ ...m, kind: 'toss', opt: { st, ct, dir, face } }, base + plan.lift(h, bonus(st.key)));
        }
      }
    }
  }
  return out.sort((a, b) => b.w - a.w);
}

const RESTART_KINDS = new Set(['carry', 'rest', 'toss']);
function score(track, plan) {
  const parts = placements(track), keys = new Set(parts.map((p) => p.key));
  const kinds = new Set(track.posts.map((p) => p.act ?? p.kind));
  // A whole-pile run counts on a lift, launcher or lever starting the marble again mid-run.
  const again = track.posts.some((p) => !p.first && RESTART_KINDS.has(p.act ?? p.kind)) ? plan.restarted : 0;
  // And what a child would rather watch and build (fun.js): kinds of special piece, flights,
  // drops, height, a route that wanders, no long plain runs.
  // A whole-pile run wants three kinds of special move at least (a lift, a jump, a pass-through...).
  const moves = new Set(track.posts.filter((p) => !p.first && p.kind !== 'cross' && p.kind !== 'end').map((p) => p.act ?? p.kind));
  return Math.min(track.segs.length, plan.target) * 3 + parts.length * plan.perPart + keys.size * 2 + kinds.size * 5 + again
    + plan.varied * Math.min(moves.size, 3) + plan.fun * fun(track);
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

// The straight floor line the longest jump in the pile needs: the hand launcher that
// gives it its speed, the arriving track's cell, the ramp's and the catcher's cells along
// the jump, and the cell the catcher lets out to.
function jumpLine(stock) {
  const span = (key) => { const xs = frameFor(key).cells.map(([x]) => x); return Math.max(...xs) - Math.min(...xs) + 1; };
  const launcher = Math.max(0, ...RESTS.filter((st) => takeable(stock, st.parts)).map((st) => span(st.key)));
  let n = 0;
  for (const st of RAMPS) for (const ct of catchersFor(st)) {
    if (!takeable(stock, [...st.parts, ...ct.parts])) continue;
    n = Math.max(n, launcher + 1 + span(st.key) + span(ct.key) + 1);
  }
  return n;
}

// Places the start piece somewhere on the floor, facing a random way. A gravity start
// stands as high as the size asks; a hand launcher stands low, its push is its energy.
function startPost(st, stock, world, rng, height, high = false) {
  const fr = frameFor(st.key), out = fr.ports[st.to];
  if (out.faceList.length !== 1) return null;
  // A few random spots, the one with the longest open run ahead first.
  // A launcher whose run must go straight (physics.runAfter) only takes a spot with that
  // much floor ahead.
  const straight = (byKey(st.key)?.physics?.runAfter?.noTurnCells ?? 0) + 1;
  const all = [];
  for (let hd = 0; hd < 4; hd++) for (let c = 0; c < world.width; c++) for (let r = 0; r < world.depth; r++) all.push([hd, c, r]);
  const spots = shuffle(all, rng).slice(0, Math.max(40, all.length >> 1))
    .map(([hd, c, r]) => { let n = 0; while (n < 16 && world.inside(...cellAt(c, r, hd, n + 1))) n++; return { hd, c, r, n: n + rng() }; })
    .filter((x) => x.n >= straight)
    .sort((a, b) => b.n - a.n);
  for (const { hd, c, r } of spots) {
    const fit = fitCell(st.key, out.cell, [c, r], (hd - out.faceList[0] + 4) % 4, 0);
    const ready = st.kind === 'rest' ? jumpLevels(stock) : [];
    // A whole-pile run may also stand the hand launcher on a tall stack: the height is
    // more track to spend before the first lift, and the stack uses the pile's blocks.
    const pick = rng();
    const want = st.kind !== 'rest' || (high && pick < 0.5) ? height - portAt(fit, st.to).level
      : ready.length && pick < (high ? 0.75 : 0.5) ? ready[Math.floor(rng() * ready.length)] - portAt(fit, st.to).level : st.minBase + Math.floor(rng() * 3);
    fit.base = Math.max(st.minBase, Math.min(st.maxBase, want));
    const o = portAt(fit, st.to), inn = portAt(fit, st.from), tall = tallOf(fit), cells = withCover(fit, cellsOf(fit).map(([x, y]) => [x, y, tall]));
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
  { name: 'little', moves: 6, height: 5, spacing: 3, fresh: 1.2, deadlineMs: 1500, polish: 60 },
  { name: 'big', moves: 12, height: 7, spacing: 2, fresh: 2.2, deadlineMs: 2500, polish: 60 },
  // Super long aims at the whole pile: as many tracks as the box holds, every special piece it can fit.
  { name: 'super', moves: Infinity, height: 10, spacing: 1, fresh: 4, deadlineMs: 4500, whole: true },
]);

// Search counters; with detail, physical rejections are counted by their reason too.
export const stats = { attempts: 0, nodes: 0, reject: {}, detail: false, log: [] };
const NOISE = [1.2, 3, 6];

// Where a clip-on sits on its host: its own clip port on the host's clip port that names
// it, facing back at it. { c, r, y, rot }: the clip-on's record origin and turn.
function clipOn(key, fit) {
  const rec = byKey(key), mine = rec.ports.find((q) => q.type === 'clip'), host = byKey(fit.key);
  const theirs = host.ports.find((q) => q.type === 'clip' && (q.accepts ?? []).some((a) => a.includes(rec.code)));
  if (!mine || !theirs || FACE[mine.faces] === undefined || FACE[theirs.faces] === undefined) return null;
  const h = portAt(fit, theirs.id), rot = (back(h.face) - FACE[mine.faces] + 8) % 4;
  const [dx, dy] = rotXY([mine.at[0], mine.at[1]], rot);
  return { c: h.x - dx, r: h.y - dy, y: h.z - mine.at[2], rot };
}

// Hangs clip-on decorations on the pieces they belong to.
function decorate(track, stock) {
  for (const d of LIB.decor) {
    let n = count(stock, d.key);
    for (const p of track.posts) for (const fit of fitsOf(p)) {
      if (n <= 0 || !d.hosts.includes(byKey(fit.key)?.code)) continue;
      const at = clipOn(d.key, fit);
      if (!at) continue;
      (p.decor ??= []).push({ key: d.key, ...at });
      n--; stock[d.key]--;
    }
    for (const s of track.segs) {
      if (n <= 0 || !d.hosts.includes(byKey(s.code)?.code)) continue;
      (s.decor ??= []).push(d.key); n--; stock[d.key]--;
    }
  }
}

// marbles: the marble types in the pile ('plain', 'metal'; sets.js marbleTypes). Every
// route must work for each of them (D5 in docs/physics_rework.md). Without it, the pile
// is taken to hold both, as every boxed set with metal marbles does; metal: false says
// plain marbles only.
export function generate({ stock: given, size = 1, moves, seed = 1, startHeight, deadlineMs, attempts, metal = true, marbles }) {
  const types = marbles?.length ? [...new Set(marbles)] : metal ? ['plain', 'metal'] : ['plain'];
  const metalOk = types.every((m) => m === 'metal'), metalAny = types.includes('metal');
  const rng = mulberry(seed), spec = SIZES[size], deadlineSpan = deadlineMs ?? spec.deadlineMs, began = Date.now();
  // Time is up at the deadline, unless no track has been found yet: then one more span.
  // A fixed attempt count makes the search the same on a busy machine (tests); the app uses the clock.
  const late = attempts ? () => false : () => Date.now() > began + deadlineSpan * (best ? 1 : 2);
  const trackCount = Object.values(TRACKS).reduce((n, t) => n + count(given, t.key), 0);
  const target = moves ?? (spec.whole ? Math.max(8, Math.round(trackCount * 0.85)) : spec.moves);
  const top = startHeight ?? spec.height;
  // A whole-pile run tries the roomiest floor and the longest one that lays every plate.
  const rects = spec.whole ? [floorRect(given, 14, 'room'), floorRect(given, 14, 'long')] : [floorRect(given, 10)];
  // A jump whose ramp, catcher and the block past it need a longer straight line than the
  // floors above give (the T-Rex's ramp, body and the block past it: 10 cells; its own set's floors are 8 by 7 and 9 by 6) also
  // gets a floor that long from the same plates, so the search can lay it (with its
  // launcher in front: 13 cells for the T-Rex, its plates lay 14 by 4).
  const line = jumpLine(given);
  let lineRect = null;
  if (line && rects.every((r) => r.width < line)) { lineRect = floorRect(given, line, false, line); if (lineRect) rects.push(lineRect); }
  let { width, depth } = rects[0];
  const plan = {
    target, spacing: spec.spacing, fresh: spec.fresh, feature: spec.whole ? 1.5 : 0.6, freshTrack: spec.whole ? 0.8 : 0.3, perPart: spec.whole ? 2 : 0.1,
    goal: 1, noise: 1.2, restarted: spec.whole ? 40 : 0, varied: spec.whole ? 25 : 0, fun: spec.whole ? 0.5 : 1.5,
    pace(here, h, i) {
      const left = Math.max(2, (target - i) * 0.5), want = (here - this.goal) / left;
      return (here - h) > 0 ? Math.min(2.5, want * 1.6) - 0.4 : -Math.min(2, want * 0.8) + 0.2;
    },
    drop(here) { return here > this.goal + 1 ? 0.6 : -2; },
    restart(h) { return h <= 2 ? 6 : -1; },
    // Each seed has its own taste in special pieces (a fixed bonus per piece), so two seeds
    // of one size lead with different pieces instead of the same favourite shape.
    // A shorter run takes a theme from the seed, one of the special moves the pile can make,
    // so seeds of one size do not all come out as the same favourite shape.
    theme: spec.whole ? null : THEMES[seed % THEMES.length], themeW: 4,
    tastes: new Map(),
    taste(k) {
      if (!this.tastes.has(k)) this.tastes.set(k, mulberry([...k].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, (seed * 2654435761) >>> 0))() * (spec.whole ? 0 : 3));
      return this.tastes.get(k);
    },
    // A lift or lever that gains height is kept for the bottom: used high up it wastes the height it gives.
    lift(h, fresh) { return h <= 2 ? fresh + 6 : -3; },
  };
  let best = null;
  const finish = (state, stock, world) => {
    const from = state.posts[state.posts.length - 1], here = from.hOut ?? from.h;
    // Most of an end's worth is known before trying it: one more track, its stack, the
    // end piece and a new kind. Skip the ends when even the best of them cannot win.
    if (best && score(state, plan) + 3 + plan.perPart * (2 * here + 6) + 2 * 5 + 5 + plan.restarted + plan.fun * 2 <= best.score) return;
    const why = (stage) => { stats.reject[`end:${stage}`] = (stats.reject[`end:${stage}`] ?? 0) + 1; };
    const ends = endings(from, stock, world, rng, state.metalOk);
    for (const o of ends.slice(0, 24)) {
      const st = clone(stock);
      if (!take(st, o.t.key)) continue;
      const built = buildEnd(o, st, world);
      if (!built) { why('build'); continue; }
      const r = attach(state, { code: o.t.key, side: o.side, drop: o.drop }, built, world);
      if (!r) { why('fit'); continue; }
      const step = stepSpeeds(state, r);
      if (!step) { why('physics'); continue; }
      const track = { posts: [...state.posts, r.post], segs: [...state.segs, r.seg], marbles: types, marble: metalOk ? 'metal' : 'plain' };
      const s = score(track, plan);
      if (best && s <= best.score) return;
      if (!runAfterStep(state, r, step.pts).ok) { why('runAfter'); continue; }
      if (!physStep(state, r, step.pts)) { why('solid'); continue; }
      state.phys.undo();
      if (!verify(samplePath(buildPathOf(track))).ok) continue;
      // Posts are shared between search branches, so the kept track is a copy.
      const kept = JSON.parse(JSON.stringify(track));
      decorate(kept, st);
      // The whole track once more from scratch, clip-ons included: nothing else is kept.
      const last = checkAll(kept).failures;
      if (last.length) { why('final'); for (const f of last) { const k = `final:${f.rule}: ${f.why.replace(/-?[\d.]+ mm3?/g, 'N mm')}`; stats.reject[k] = (stats.reject[k] ?? 0) + 1; } continue; }
      best = { score: s, track: kept, width, depth };
      stats.log.push({ ms: Date.now() - began, attempt, nodes: stats.nodes, segs: track.segs.length, score: s });
      return;
    }
  };
  // A track long enough is not the end at once: the search looks on for a while (spec.polish
  // nodes) for a more fun one of that length (fun.js), then stops.
  let longAt = null;
  const satisfied = () => {
    if (!best || best.track.segs.length < Math.min(target, trackCount - 1)) return false;
    longAt ??= stats.nodes;
    return stats.nodes - longAt >= (spec.polish ?? 0);
  };

  let budget = 0;
  const dfs = (state, stock, world) => {
    if (budget-- <= 0 || late()) return;
    stats.nodes++;
    const i = state.segs.length;
    stats.depth = Math.max(stats.depth ?? 0, i);
    if (i >= 2) finish(state, stock, world);
    if (i >= target) return;
    const post = state.posts[state.posts.length - 1], here = post.hOut ?? post.h;
    const restarts = restartLevels(stock);
    plan.goal = restarts.length ? Math.max(1, Math.min(...restarts)) : 1;
    let explored = 0, restartTried = false;
    // A whole-pile run with no lift, launcher or lever restarting the marble yet tries one
    // such move at every node past its usual few (the moves that found no room were mostly
    // these, and the run counts on one).
    const wantRestart = plan.restarted > 0 && !state.posts.some((p) => !p.first && RESTART_KINDS.has(p.act ?? p.kind));
    const isRestart = (m) => m.kind === 'toss' || (m.kind === 'station' && (m.opt.st.kind === 'carry' || m.opt.st.kind === 'rest'));
    // Likewise a whole-pile run with fewer than three kinds of special move so far tries one
    // move of a kind it does not have yet (a jump, a pass-through, a spiral...) past its few.
    const kindOf = (m) => (m.kind === 'station' ? m.opt.st.kind : m.kind);
    const have = new Set(state.posts.filter((p) => !p.first && p.kind !== 'cross' && p.kind !== 'end').map((p) => p.act ?? p.kind));
    const wantKind = plan.varied > 0 && have.size < 3;
    let kindTried = false;
    const isNew = (m) => m.kind !== 'cross' && !have.has(kindOf(m));
    for (const m of candidates(state, stock, rng, world, plan)) {
      // Out of time or steps: stop here too, not only in the child, or every level
      // keeps physics-testing its remaining candidates on the way back up.
      if (budget <= 0 || late()) return;
      if (explored >= (i < 2 ? 2 : 3)) {
        const extra = (wantRestart && !restartTried && isRestart(m)) || (wantKind && !kindTried && isNew(m));
        if (!extra) {
          if ((!wantRestart || restartTried) && (!wantKind || kindTried)) break;
          continue;
        }
      }
      const st = clone(stock);
      if (!take(st, m.code)) continue;
      const why = (stage) => { const k = `${m.kind}${stats.detail && m.opt.st ? ` ${m.opt.st.key}` : ''}:${stage}`; stats.reject[k] = (stats.reject[k] ?? 0) + 1; };
      const built = BUILD[m.kind](m.land, m.h, st, m.opt, world);
      if (!built) { why('build'); continue; }
      const r = attach(state, m, built, world);
      if (!r) { why('fit'); continue; }
      const step = stepSpeeds(state, r);
      if (!step) { why('physics'); continue; }
      const zone = runAfterStep(state, r, step.pts);
      if (!zone.ok) { why('runAfter'); continue; }
      if (!physStep(state, r, step.pts)) { why('solid'); continue; }
      const { speeds } = step;
      why('ok');
      explored++;
      if (isRestart(m)) restartTried = true;
      if (isNew(m)) kindTried = true;
      const used = new Set(state.used);
      for (const p of placementsOfPost(r.post)) used.add(p);
      used.add(m.code);
      const next = {
        ...state, posts: [...state.posts, r.post], segs: [...state.segs, r.seg], speeds, used, metal: state.metal || r.metal || TRACKS[m.code].metalOnly, launch: zone.launch,
        lastFeature: FEATURE.has(r.post.kind) && !(r.post.kind === 'station' && r.post.act === 'inline' && false) ? i : state.lastFeature,
      };
      world.add(r.placed);
      dfs(next, st, world);
      world.remove(r.placed);
      state.phys.undo();
      if (satisfied()) return;
      void here;
    }
  };

  // Many short searches from fresh starts beat one long search stuck in a corner.
  let attempt = 0;
  while (attempts ? attempt < attempts : !late()) {
    stats.attempts++;
    stats.log.push({ ms: Date.now() - began, start: attempt, nodes: stats.nodes });
    // A whole-pile run tries a lift as the start last, so first it stays free to lift the marble again mid-run.
    const startsHere = STARTS.filter((s) => takeable(given, s.parts) && (metalOk || !s.needsMetal))
      .sort((a, b) => (spec.whole ? (a.kind === 'carry') - (b.kind === 'carry') : 0));
    if (!startsHere.length) break;
    // The first start piece listed (a gravity start if the pile has one) is tried most;
    // a whole-pile run takes every start and every floor in turn.
    const k = attempt++;
    // A whole-pile run takes every floor in turn; a shorter run with a second floor (a long
    // jump's line) takes the two in turn, starting by seed, and on the long one starts from
    // a hand launcher, which can give the jump its speed.
    const rect = spec.whole ? rects[Math.floor(k / startsHere.length) % rects.length] : rects[(k + seed) % rects.length];
    const launcher = rect === lineRect ? startsHere.find((s) => s.kind === 'rest') : null;
    const st = spec.whole ? startsHere[k % startsHere.length] : launcher ?? startsHere[k === 0 || rng() < 0.6 ? 0 : Math.floor(rng() * startsHere.length)];
    ({ width, depth } = rect);
    const stock = clone(given), world = new World(width, depth);
    // Later rounds of a whole-pile run shake the move order harder, so they dive somewhere new.
    if (spec.whole) plan.noise = NOISE[Math.floor(k / (startsHere.length * rects.length)) % NOISE.length];
    const made = startPost(st, stock, world, rng, Math.min(top, 10), spec.whole);
    if (!made) continue;
    world.add({ solid: [...solidOf(made.post), ...made.solid], cells: [] });
    budget = 80 + Math.min(target, 60) * 30;
    const used = new Set([made.post.piece, ...placementsOfPost(made.post)]);
    const phys = new Growing();
    if (phys.step({ posts: [made.post], segs: [], placed: placePost([], made.post, 0), points: [] }).length) continue;
    const state = { posts: [made.post], segs: [], used, metal: !!made.metal, metalOk, metalAny, phys };
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
