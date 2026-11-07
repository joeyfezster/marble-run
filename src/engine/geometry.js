// Turns a track description into world-space marble paths and a parts list.
// Every shape here comes from a behaviour (cross a block, fall, spiral, pass through
// a station, wait for a hand, be carried, fly, end), never from a piece's name.
import { DIM, HEADINGS, TRACKS, LIB, byKey, left, right, back } from '../catalog/parts.js';
import { energyOf, sourceOf, FALL_EXIT, SPIRAL_EXIT } from './physics.js';
import { portAt, originOf, frameFor, placeIn } from './fit.js';
import { spiralLocal } from './spiral.js';

const STEP = 0.0025; // m between path samples

export const cellCentre = (c, r) => ({ x: c * DIM.cell, y: r * DIM.cell });
export const postZ = (h) => (h - DIM.seatDrop) * DIM.slot;
const at = (x, y) => ({ x: x * DIM.cell, y: y * DIM.cell });

// Where a track lands, in grid terms. side: +1 right of heading, -1 left.
export function landing(post, heading, code, side) {
  const t = TRACKS[code];
  const [ax, ay] = HEADINGS[heading];
  const sideH = side > 0 ? right(heading) : left(heading);
  const [sx, sy] = HEADINGS[sideH];
  const c = post.c + ax * t.ahead + sx * t.side;
  const r = post.r + ay * t.ahead + sy * t.side;
  let nh = heading;
  if (t.kind === 'arc') nh = sideH;
  if (t.kind === 'uturn') nh = back(heading);
  return { c, r, heading: nh };
}

const ease = (u) => (1 - Math.cos(Math.PI * u)) / 2;

function sameSpot(out, a, z) {
  const p = out[out.length - 1];
  return Math.hypot(p.x - a.x, p.y - a.y, p.z - z) < 1e-6;
}

function pushLine(out, a, b, zA, zB, piece, extra = {}, shape = (u) => u) {
  const len = Math.hypot(b.x - a.x, b.y - a.y, zB - zA) || 1e-6;
  const n = Math.max(2, Math.ceil(len / STEP));
  for (let i = out.length && sameSpot(out, a, zA) ? 1 : 0; i <= n; i++) {
    const u = i / n;
    out.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: zA + (zB - zA) * shape(u), piece, ...extra });
  }
}

// A vertical run: the tiny sideways step keeps the samples distinct.
const pushRise = (out, m, zA, zB, piece, extra) => pushLine(out, m, { x: m.x, y: m.y + 1e-4 }, zA, zB, piece, extra);

function pushArc(out, from, heading, sideH, radius, sweep, zA, zB, piece, extra) {
  const [ax, ay] = HEADINGS[heading], [sx, sy] = HEADINGS[sideH];
  const cx = from.x + sx * radius, cy = from.y + sy * radius;
  const n = Math.max(6, Math.ceil((radius * sweep) / STEP));
  for (let i = 1; i <= n; i++) {
    const u = i / n, a = u * sweep;
    out.push({
      x: cx - sx * radius * Math.cos(a) + ax * radius * Math.sin(a),
      y: cy - sy * radius * Math.cos(a) + ay * radius * Math.sin(a),
      z: zA + (zB - zA) * ease(u), piece, ...extra,
    });
  }
}

export const edge = (p, h, sign = 1) => {
  const m = cellCentre(p.c, p.r), [ax, ay] = HEADINGS[h];
  return { x: m.x + sign * ax * DIM.cell / 2, y: m.y + sign * ay * DIM.cell / 2 };
};

const entry = (post) => post.entry ?? post;
const tail = (out) => out[out.length - 1];

export function trackPath(out, from, to, seg, piece) {
  const t = TRACKS[seg.code], a = edge(from, from.out), zA = postZ(from.hOut ?? from.h), zB = postZ(to.hIn ?? to.h);
  const extra = t.keep !== 1 ? { keep: t.keep } : {};
  if (t.kind === 'straight') {
    pushLine(out, a, edge(entry(to), to.in, -1), zA, zB, piece, extra, ease);
    return;
  }
  const bank = ((t.bankDeg ?? 0) * Math.PI) / 180;
  const sideH = seg.side > 0 ? right(from.out) : left(from.out);
  const radius = t.kind === 'arc' ? (t.ahead - 0.5) * DIM.cell : (t.side * DIM.cell) / 2;
  if (!out.length) out.push({ ...a, z: zA, piece, bank, ...extra });
  pushArc(out, a, from.out, sideH, radius, t.kind === 'arc' ? Math.PI / 2 : Math.PI, zA, zB, piece, { bank, ...extra });
}

function spiralPath(out, post, piece) {
  // The band lies beside the host over the cells its record's footprint covers, ahead of
  // the block and to one side; the tail comes back into the block under the host.
  const [ax, ay] = HEADINGS[post.in], [sx, sy] = HEADINGS[post.spiralSide > 0 ? right(post.in) : left(post.in)];
  const sp = LIB.spirals.find((s) => s.key === post.piece) ?? { footprint: [2, 2] };
  const m = cellCentre(post.c, post.r), z = postZ(post.hIn), zEnd = postZ(post.hOut);
  for (const p of spiralLocal(sp.footprint).slice(1)) {
    out.push({ x: m.x + (p.a * ax + p.s * sx) * DIM.cell, y: m.y + (p.a * ay + p.s * sy) * DIM.cell, z: z + (zEnd - z) * p.f, piece, ...(p.part === 'band' ? { bank: 0.6 } : {}) });
  }
}

// Crossing a block top: straight over, or round the tall back wall of a corner block.
function crossPath(out, post, piece, z) {
  if (post.in === post.out) { pushLine(out, edge(post, post.in, -1), edge(post, post.out), z, z, piece); return; }
  const a = edge(post, post.in, -1);
  if (!out.length) out.push({ ...a, z, piece });
  pushArc(out, a, post.in, post.out === right(post.in) ? right(post.in) : left(post.in), DIM.cell / 2, Math.PI / 2, z, z, piece, { bank: 0.8 });
}

function stationPath(out, post, piece) {
  const rec = byKey(post.fit.key), inn = entry(post), zIn = postZ(post.hIn), zOut = postZ(post.hOut);
  const mIn = cellCentre(inn.c, inn.r), mOut = cellCentre(post.c, post.r);
  pushLine(out, edge(inn, post.in, -1), mIn, zIn, zIn, piece);
  if (post.act === 'rest') {
    const w = { rest: { maxIn: post.maxCatch, launch: energyOf(rec, 'launch') }, source: sourceOf(rec) };
    pushLine(out, mIn, mOut, zIn, zOut, `${piece}w`, w);
    pushLine(out, mOut, edge(post, post.out), zOut, zOut, `${piece}w`, w);
    return;
  }
  if (post.act === 'carry') {
    pushRise(out, mIn, zIn, zOut, `${piece}l`, { hold: energyOf(rec, 'carry'), source: sourceOf(rec), smooth: true });
    pushLine(out, { x: mIn.x, y: mIn.y + 1e-4 }, edge(post, post.out), zOut, zOut, `${piece}x`, { boost: energyOf(rec, 'exit') });
    return;
  }
  pushLine(out, mIn, mOut, zIn, (zIn + zOut) / 2, piece, {}, ease);
  pushLine(out, mOut, edge(post, post.out), (zIn + zOut) / 2, zOut, piece, {}, ease);
}

function jumpPath(out, post, piece) {
  const ramp = post.ramp, catcher = post.catcher, inn = entry(post);
  const low = portAt(ramp, ramp.from), lip = portAt(ramp, ramp.to), take = portAt(catcher, catcher.from), give = portAt(catcher, catcher.to);
  const zIn = postZ(post.hIn), zLip = zIn + (lip.z - low.z) * DIM.slot, gap = Math.max(0.5, Math.hypot(take.x - lip.x, take.y - lip.y)) * DIM.cell;
  const stores = !!post.stores;
  pushLine(out, edge(inn, post.in, -1), at(lip.x, lip.y), zIn, zLip, `${piece}r`, {});
  pushLine(out, at(lip.x, lip.y), at(take.x, take.y), zLip, zLip, `${piece}j`, { flight: { gap, into: stores } });
  if (post.drops) {
    // The catcher drops the marble onto the block under its outlet, which sends it on.
    const zTop = postZ(post.hOut), m = cellCentre(post.c, post.r);
    const extra = stores ? { hold: energyOf(byKey(catcher.key), 'hold'), source: sourceOf(byKey(catcher.key)), smooth: true } : {};
    if (give.face !== null && give.face !== undefined) {
      // An outlet facing a side (a tail tip) rolls the marble into that block's cup end
      // heading that way; the block's own route carries it on.
      const x = stores ? {} : { cap: FALL_EXIT }, a = edge(post, give.face, -1);
      pushLine(out, at(take.x, take.y), a, zLip, zTop, `${piece}m`, extra);
      if (post.out === give.face) pushLine(out, a, edge(post, post.out), zTop, zTop, `${piece}x`, x);
      else pushArc(out, a, give.face, post.out, DIM.cell / 2, Math.PI / 2, zTop, zTop, `${piece}x`, { bank: 0.8, ...x });
      return;
    }
    pushLine(out, at(take.x, take.y), at(give.x, give.y), zLip, zTop, `${piece}m`, extra);
    pushLine(out, at(give.x, give.y), m, zTop, zTop, `${piece}x`, stores ? {} : { cap: FALL_EXIT });
    pushLine(out, m, edge(post, post.out), zTop, zTop, `${piece}x`, stores ? {} : { cap: FALL_EXIT });
    return;
  }
  pushLine(out, at(take.x, take.y), edge(post, post.out), zLip, postZ(post.hOut), `${piece}d`, {}, ease);
}

function tossPath(out, post, piece) {
  // Rolls into the launcher and waits; a hand fires it up into the catcher on the tower,
  // which drops it into the block it stands on; it leaves by that block's mouth.
  const rec = byKey(post.fit.key), inn = entry(post), zIn = postZ(post.hIn), m = cellCentre(inn.c, inn.r);
  const apex = post.apexZ * DIM.slot, zTop = postZ(post.hOut), tower = cellCentre(post.c, post.r);
  pushLine(out, edge(inn, post.in, -1), m, zIn, zIn, piece);
  pushRise(out, m, zIn, apex, `${piece}l`, { rest: { maxIn: post.maxCatch, launch: energyOf(rec, 'carry') }, hold: energyOf(rec, 'carry'), source: sourceOf(rec), smooth: true });
  pushLine(out, { x: m.x, y: m.y + 1e-4 }, tower, apex, apex, `${piece}h`, { hold: energyOf(rec, 'carry'), smooth: true });
  pushRise(out, tower, apex, zTop, `${piece}f`, { fall: true, smooth: true });
  pushLine(out, { x: tower.x, y: tower.y + 1e-4 }, edge(post, post.out), zTop, zTop, `${piece}x`, { cap: FALL_EXIT });
}

function trayPath(out, post, z, piece) {
  const a = edge(post, post.out), [ax, ay] = HEADINGS[post.out], cells = post.endCells?.length ?? 2;
  const extra = { caught: true, maxSpeed: post.maxCatch }, low = z - DIM.slot * 0.55;
  const mid = { x: a.x + ax * DIM.cell * 0.6, y: a.y + ay * DIM.cell * 0.6 }, far = { x: a.x + ax * DIM.cell * cells * 0.95, y: a.y + ay * DIM.cell * cells * 0.95 };
  pushLine(out, a, mid, z, low, piece, extra, ease);
  pushLine(out, mid, far, low, low, piece, extra);
}

export function postPath(out, post, piece) {
  const z = postZ(post.h), m = cellCentre(post.c, post.r);
  switch (post.kind) {
    case 'station': stationPath(out, post, piece); return;
    case 'jump': jumpPath(out, post, piece); return;
    case 'toss': tossPath(out, post, piece); return;
    case 'fall': {
      // Rolls in over the drop-in top, falls inside the stack, leaves through the catcher's mouth.
      const zTop = postZ(post.hIn), zLow = postZ(post.hOut);
      pushLine(out, edge(post, post.in, -1), m, zTop, zTop, piece);
      pushRise(out, m, zTop, zLow, `${piece}f`, { fall: true, smooth: true });
      pushLine(out, { x: m.x, y: m.y + 1e-4 }, edge(post, post.out), zLow, zLow, `${piece}x`, { cap: FALL_EXIT });
      return;
    }
    case 'spiral': {
      const zTop = postZ(post.hIn), zLow = postZ(post.hOut);
      pushLine(out, edge(post, post.in, -1), edge(post, post.in), zTop, zTop, piece);
      spiralPath(out, post, `${piece}s`);
      // Into the block under the host through the face the spiral hangs on, out its mouth.
      pushLine(out, tail(out), m, zLow, zLow, `${piece}x`, { cap: SPIRAL_EXIT });
      pushLine(out, m, edge(post, post.out), zLow, zLow, `${piece}x`, { cap: SPIRAL_EXIT });
      return;
    }
    case 'end': {
      if (post.fit && !post.endCells) {
        // A waiting piece used as the finish: the marble rolls in and stays.
        const zIn = postZ(post.hIn ?? post.h), inn = entry(post);
        pushLine(out, edge(inn, post.in, -1), cellCentre(inn.c, inn.r), zIn, zIn, `${piece}e`, { caught: true, maxSpeed: post.maxCatch });
        return;
      }
      crossPath(out, post, piece, z);
      trayPath(out, post, z, `${piece}e`);
      return;
    }
    default: crossPath(out, post, piece, z);
  }
}

// The leg a start piece adds before the first track: a hand launcher sends the marble out.
export function startPath(out, post) {
  if (post.kind === 'station' && post.act === 'rest') {
    const rec = byKey(post.fit.key), m = cellCentre(entry(post).c, entry(post).r), zOut = postZ(post.hOut);
    pushLine(out, m, cellCentre(post.c, post.r), zOut, zOut, 'p0w', { source: sourceOf(rec) });
    pushLine(out, cellCentre(post.c, post.r), edge(post, post.out), zOut, zOut, 'p0w', { source: sourceOf(rec) });
  }
}

// Full centerline. The marble is released at the start piece.
export function buildPath(track) {
  const out = [];
  startPath(out, track.posts[0]);
  track.segs.forEach((seg, i) => {
    trackPath(out, track.posts[i], track.posts[i + 1], seg, `t${i}`);
    postPath(out, track.posts[i + 1], `p${i + 1}`);
  });
  markStart(out, track);
  return out;
}

// The speed a marble leaves its start piece with, from the start piece's energy.
export function startSpeed(post) {
  const rec = post.fit ? byKey(post.fit.key) : null;
  if (post.act === 'rest') return energyOf(rec, 'launch');
  if (post.act === 'carry') return energyOf(rec, 'exit');
  return energyOf(rec, 'release');
}

export function markStart(points, track) {
  if (!points.length) return;
  points[0].start = startSpeed(track.posts[0]);
  if (track.posts[0].act === 'rest') points[0].source = sourceOf(byKey(track.posts[0].fit.key));
}

// Which floor cells a run passes over, including the channel's width.
export function coveredCells(points) {
  const seen = new Map(), half = 0.02;
  const mark = (x, y, z) => {
    const c = Math.round(x / DIM.cell), r = Math.round(y / DIM.cell), key = `${c},${r}`;
    const e = seen.get(key) ?? { c, r, zMin: z, zMax: z };
    e.zMin = Math.min(e.zMin, z); e.zMax = Math.max(e.zMax, z);
    seen.set(key, e);
  };
  // The first and last samples sit exactly on a cell edge and belong to neither cell.
  points.forEach((p, i) => {
    if (i === 0 || i === points.length - 1) return;
    const q = points[Math.min(i + 1, points.length - 1)], o = points[Math.max(i - 1, 0)];
    const dx = q.x - o.x, dy = q.y - o.y, d = Math.hypot(dx, dy) || 1;
    mark(p.x, p.y, p.z);
    if (i % 3 === 0 && d > 1e-5) { mark(p.x - (dy / d) * half, p.y + (dx / d) * half, p.z); mark(p.x + (dy / d) * half, p.y - (dx / d) * half, p.z); }
  });
  return [...seen.values()];
}

// Every fitted record in a post: the station, ramp, catcher, hood or end piece.
export const fitsOf = (p) => [p.fit, p.ramp, p.catcher, p.hood].filter(Boolean);

// Every physical part in the build, with where it stands. Generator, guide and
// 3D view all read this one list, so they cannot disagree. c, r and rot give the
// record's own origin and turn, so a model built in record coordinates sits right.
export function placements(track) {
  const out = [];
  const put = (group, key, c, r, y, rot, extra = {}) => {
    const rec = byKey(key);
    out.push({ group, key, code: rec?.code ?? key, c, r, y, rot, block: !!LIB.blocks[key], ...extra });
  };
  track.posts.forEach((p, i) => {
    p.stack.forEach((key, k) => put(i, key, p.c, p.r, heightBelow(p.stack, k), blockTurn(p, k), { top: k === p.stack.length - 1 }));
    (p.stands ?? []).forEach((s) => s.stack.forEach((key, k) => put(i, key, s.c, s.r, heightBelow(s.stack, k), p.in ?? 0)));
    for (const fit of fitsOf(p)) {
      const rec = byKey(fit.key), [oc, or] = originOf(fit);
      if (rec.parts) {
        const [sx, sy] = frameFor(fit.key).origin;
        for (const part of rec.parts) {
          const [c, r] = placeIn(fit, [part.at[0] + sx, part.at[1] + sy]);
          put(i, part.key, c, r, fit.base + (part.at[2] ?? 0), (fit.rot + (part.rot ?? 0)) % 4);
        }
      } else put(i, fit.key, oc, or, fit.base, fit.rot, p.kind === 'spiral' ? {} : {});
    }
    if (p.kind === 'spiral') put(i, p.piece, p.c, p.r, heightBelow(p.stack, p.stack.length - 1), p.in, { spiral: `p${i}s`, spiralSide: p.spiralSide });
    for (const d of p.decor ?? []) put(i, d.key, d.c, d.r, d.y, d.rot ?? 0, { decor: true });
  });
  track.segs.forEach((s, i) => {
    put(i + 1, s.code, null, null, null, null, { seg: i });
    for (const d of s.decor ?? []) put(i + 1, d, null, null, null, null, { decor: true, onSeg: i });
  });
  return out;
}

const heightBelow = (stack, k) => stack.slice(0, k).reduce((n, key) => n + (LIB.blocks[key]?.height ?? 1), 0);
export const stackHeight = (stack) => heightBelow(stack, stack.length);

// The quarter turn a post's k-th block is drawn with. The validator reads the same
// turn, so the route it checks is the route the 3D view shows.
export function blockTurn(p, k) {
  if (p.rots?.[k] !== undefined) return p.rots[k];
  const turn = k === p.stack.length - 1 && (p.kind === 'cross' || p.kind === 'end' || p.drops) ? topTurn(p) : null;
  return turn ?? p.in ?? 0;
}

// A corner block's cups open on two faces; turn it to the marble's path.
function topTurn(p) {
  const b = LIB.blocks[p.stack.at(-1)];
  if (!b || b.faces.length < 2) return null;
  const want = p.drops ? [p.out] : [back(p.in), p.out];
  const rot = [0, 1, 2, 3].find((r) => want.every((w) => b.faces.map((f) => (f + r) % 4).includes(w)));
  return rot ?? null;
}

// Every floor cell something stands on.
export function standing(track) {
  const cells = [];
  const add = ([c, r]) => cells.push([Math.round(c), Math.round(r)]);
  for (const p of track.posts) {
    if (p.stack.length) add([p.c, p.r]);
    for (const s of p.stands ?? []) add([s.c, s.r]);
    for (const c of p.floorCells ?? []) add(c);
  }
  return [...new Map(cells.map((c) => [c.join(), c])).values()];
}
