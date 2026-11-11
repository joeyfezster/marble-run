// Turns a track description into world-space marble paths and a parts list.
// Every shape here comes from a behaviour (cross a block, fall, spiral, pass through
// a station, wait for a hand, be carried, fly, end), never from a piece's name.
import { DIM, HEADINGS, TRACKS, LIB, byKey, left, right, back } from '../catalog/parts.js';
import { energyOf, sourceOf, FALL_EXIT, SPIRAL_EXIT, NOMINAL } from './physics.js';
import { portAt, originOf, frameFor, placeIn, routeLine, worldOf } from './fit.js';
import { spiralLocal } from './spiral.js';
import { lipCentre } from './centre.js';
import { tossSetup, bestShot, arcPoints, coneOf, speedThrough, unit, aimOf, turnVec } from './ballistic.js';

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
  // A marble hanging under a piece (a magnet strip) is not on a floor: its centre is
  // drawn a radius over the path, straight up.
  const extra = { ...(t.keep !== 1 ? { keep: t.keep } : {}), ...(byKey(seg.code)?.physics?.marbleHangs ? { hang: true } : {}) };
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

export function spiralPath(out, post, piece) {
  // The band wraps round the host's front corner over the cells its record's footprint
  // covers (ahead, ahead and to the side, beside); it ends on the side face of the block
  // under the host, which it hands the marble into.
  const [ax, ay] = HEADINGS[post.in], [sx, sy] = HEADINGS[post.spiralSide > 0 ? right(post.in) : left(post.in)];
  const sp = LIB.spirals.find((s) => s.key === post.piece) ?? { footprint: [2, 2] };
  const m = cellCentre(post.c, post.r), z = postZ(post.hIn), zEnd = postZ(post.hOut);
  for (const p of spiralLocal(sp.footprint).slice(1)) {
    out.push({ x: m.x + (p.a * ax + p.s * sx) * DIM.cell, y: m.y + (p.a * ay + p.s * sy) * DIM.cell, z: z + (zEnd - z) * p.f, piece, ...(p.part === 'band' ? { bank: 0.6 } : {}) });
  }
}

// A track's tongue lies this far into the cup it rests in, straight on past the face
// (about 5 mm past the block face on the track photos; tools/blender/track_kit.py
// TONGUE, the models are built with it). A marble arriving on it rolls straight
// along it before a corner bowl can turn it, and leaves along the next track's tongue.
export const TONGUE_M = 0.006;

// Round a corner bowl from the face at `a` (heading inH) to the face heading outH:
// straight along the arriving tongue, a quarter turn, straight along the leaving tongue.
function cornerPath(out, a, inH, outH, zA, zB, piece, extra = {}) {
  const [ax, ay] = HEADINGS[inH], [bx, by] = HEADINGS[outH], r = DIM.cell / 2 - TONGUE_M;
  const p = { x: a.x + ax * TONGUE_M, y: a.y + ay * TONGUE_M };
  if (!out.length) out.push({ ...a, z: zA, piece, ...extra });
  pushLine(out, a, p, zA, zA, piece, extra);
  pushArc(out, p, inH, outH, r, Math.PI / 2, zA, zB, piece, { bank: 0.8, ...extra });
  const q = tail(out);
  pushLine(out, q, { x: q.x + bx * TONGUE_M, y: q.y + by * TONGUE_M }, zB, zB, piece, extra);
}

// Crossing a block top: straight over, or round the tall back wall of a corner block.
function crossPath(out, post, piece, z) {
  if (post.in === post.out) { pushLine(out, edge(post, post.in, -1), edge(post, post.out), z, z, piece); return; }
  cornerPath(out, edge(post, post.in, -1), post.in, post.out, z, z, piece);
}

// A record-frame route point of a fitted piece, in world metres.
const worldPt = (fit, p) => { const [c, r, z] = worldOf(fit, p); return { x: c * DIM.cell, y: r * DIM.cell, z: z * DIM.slot }; };
const pushPoly = (out, pts, piece, extra = {}, shape) => { for (let k = 1; k < pts.length; k++) pushLine(out, pts[k - 1], pts[k], pts[k - 1].z, pts[k].z, piece, extra, shape); };
// Where a waiting piece holds the marble: the low point of its route inside the piece
// (the corner of a chamber on the plunger axis, a seat in a bowl), else its inlet.
const waitAt = (line) => {
  let k = line.length > 2 ? 1 : 0;
  for (let n = 2; n < line.length - 1; n++) if (line[n].z < line[k].z - 1e-9) k = n;
  return k;
};

// Through a station along its record's own route (fit.js routeLine): in through its
// inlet, round its corner, out of its outlet. A waiting piece holds the marble at the
// route's corner (a chamber on the plunger axis) until a hand sends it on; a lift
// carries it up from where it rolls in; a hub drops it at its middle.
function stationPath(out, post, piece) {
  const rec = byKey(post.fit.key), fit = post.fit, inn = entry(post), zIn = postZ(post.hIn), zOut = postZ(post.hOut);
  const mIn = cellCentre(inn.c, inn.r);
  const line = routeLine(rec, fit.from, fit.to).map((p) => worldPt(fit, p));
  if (post.act === 'carry') {
    // Along the record's lift route: in, up, and out of the outlet.
    if (line.length === 4) {
      const [a, low, high, b] = line;
      pushLine(out, a, low, a.z, a.z, piece);
      pushRise(out, low, low.z, high.z, `${piece}l`, { hold: energyOf(rec, 'carry'), source: sourceOf(rec), smooth: true });
      pushLine(out, { x: high.x, y: high.y + 1e-4 }, b, high.z, b.z, `${piece}x`, { boost: energyOf(rec, 'exit') });
      return;
    }
    if (line.length > 4) {
      // A route the record draws point by point (via): rolls in to the first, is carried
      // through the rest to the last, and rolls out of the outlet.
      const a = line[0], b = line.at(-1), high = line.at(-2);
      pushLine(out, a, line[1], a.z, line[1].z, piece);
      pushPoly(out, line.slice(1, -1), `${piece}l`, { hold: energyOf(rec, 'carry'), source: sourceOf(rec), smooth: true });
      pushLine(out, high, b, high.z, b.z, `${piece}x`, { boost: energyOf(rec, 'exit') });
      return;
    }
    pushLine(out, edge(inn, post.in, -1), mIn, zIn, zIn, piece);
    pushRise(out, mIn, zIn, zOut, `${piece}l`, { hold: energyOf(rec, 'carry'), source: sourceOf(rec), smooth: true });
    pushLine(out, { x: mIn.x, y: mIn.y + 1e-4 }, edge(post, post.out), zOut, zOut, `${piece}x`, { boost: energyOf(rec, 'exit') });
    return;
  }
  if (post.act === 'rest') {
    const w = { rest: { maxIn: post.maxCatch, launch: energyOf(rec, 'launch') }, source: sourceOf(rec) }, k = waitAt(line);
    if (k) pushPoly(out, line.slice(0, k + 1), piece);
    else pushLine(out, line[0], line[0], line[0].z, line[0].z, piece);
    pushPoly(out, line.slice(k), `${piece}w`, w);
    return;
  }
  const m = (rec.marblePaths ?? []).find((x) => x.from === fit.from && x.to === fit.to);
  if (m?.shape === 'fall' && line.length === 4) {
    // In over the hub, down inside it at its middle, out of its mouth.
    const [a, top, , b] = line;
    pushLine(out, a, top, a.z, a.z, piece);
    pushRise(out, top, a.z, b.z, `${piece}f`, { fall: true, smooth: true });
    pushLine(out, { x: top.x, y: top.y + 1e-4 }, b, b.z, b.z, `${piece}x`, { cap: FALL_EXIT });
    return;
  }
  if (m?.shape === 'fall' && line.length > 4) {
    // A fall the record draws point by point (via): in to the first, down through the
    // rest to the last, out of the mouth.
    const a = line[0], b = line.at(-1), low = line.at(-2);
    pushLine(out, a, line[1], a.z, line[1].z, piece);
    pushPoly(out, line.slice(1, -1), `${piece}f`, { fall: true, smooth: true });
    pushLine(out, low, b, low.z, b.z, `${piece}x`, { cap: FALL_EXIT });
    return;
  }
  if (m?.via) pushRoute(out, line, piece);
  else pushPoly(out, line, piece, {}, ease);
}

// A route's points in order, a vertical or steep stretch (more than three times as tall
// as long, where centre.js stops reading a floor) marked as a fall (a marble dropping off a
// ring's disc onto the ramp below, into a funnel's hole); the first `airTo` + 1 stretches
// in the air (a marble flying on through a ring, the record's marblePaths `airTo`).
function pushRoute(out, pts, piece, extra = {}, airTo = -1) {
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k], h = Math.hypot(b.x - a.x, b.y - a.y), air = k - 1 <= airTo ? { air: true } : {};
    if (h < 1e-6) pushRise(out, a, a.z, b.z, piece, { ...extra, fall: true, smooth: true });
    else if (Math.abs(b.z - a.z) > 3 * h) pushLine(out, a, b, a.z, b.z, piece, { ...extra, fall: true, smooth: true });
    else pushLine(out, a, b, a.z, b.z, piece, { ...extra, ...air });
  }
}
const airToOf = (rec, from, to) => (rec.marblePaths ?? []).find((m) => m.from === from && m.to === to)?.airTo ?? -1;

// Up the ramp along its record's route (the trough floor, read from the model), off the
// lip in a ballistic arc into the catcher's mouth, and on along the catcher's route. The
// arc drawn is the one that enters the mouth's middle; the flights rule (physical.js)
// flies the marble again at the speed it really has at the lip.
function jumpPath(out, post, piece) {
  const ramp = post.ramp, catcher = post.catcher, inn = entry(post);
  const lip = portAt(ramp, ramp.to), take = portAt(catcher, catcher.from), give = portAt(catcher, catcher.to);
  const gap = Math.max(0.5, Math.hypot(take.x - lip.x, take.y - lip.y)) * DIM.cell;
  const stores = !!post.stores;
  const up = routeLine(byKey(ramp.key), ramp.from, ramp.to).map((p) => worldPt(ramp, p));
  up[0] = { ...edge(inn, post.in, -1), z: up[0].z };
  pushPoly(out, up, `${piece}r`);
  const a = up.at(-1), b = up.at(-2), aim = aimOf(byKey(ramp.key));
  const dir = aim ? unit(turnVec(aim.v, ramp.rot)) : unit([a.x - b.x, a.y - b.y, a.z - b.z]);
  // The marble leaves the lip with its centre a radius off the ramp's floor (centre.js).
  const R = NOMINAL.marbleRadius, from = lipCentre(a, b, R), cone = coneOf(catcher, catcher.from), v = speedThrough(from, dir, cone.at);
  const h = Math.hypot(dir[0], dir[1]), flight = { flight: { gap, into: stores, from, dir, cone } };
  if (v && h > 1e-6) {
    const t = Math.hypot(cone.at.x - from.x, cone.at.y - from.y) / (v * h);
    for (const q of arcPoints(from, dir, v, t).slice(1)) out.push({ ...q, z: q.z - R, piece: `${piece}j`, ...flight });
  } else pushLine(out, a, { x: cone.at.x, y: cone.at.y }, a.z, cone.at.z - R, `${piece}j`, flight);
  const zLip = tail(out).z;
  if (post.drops) {
    // The catcher drops the marble onto the block under its outlet, which sends it on.
    const zTop = postZ(post.hOut), m = cellCentre(post.c, post.r);
    const extra = stores ? { hold: energyOf(byKey(catcher.key), 'hold'), source: sourceOf(byKey(catcher.key)), smooth: true } : {};
    if (give.face !== null && give.face !== undefined) {
      // An outlet facing a side (a tail tip) rolls the marble into that block's cup end
      // heading that way; the block's own route carries it on. Inside the catcher the
      // marble follows the record's route when it draws one (via: the T-Rex's floor).
      const x = stores ? {} : { cap: FALL_EXIT }, a = edge(post, give.face, -1);
      const inside = routeLine(byKey(catcher.key), catcher.from, catcher.to).map((p) => worldPt(catcher, p));
      if (inside.length > 2) {
        pushRoute(out, [tail(out), ...inside.slice(1, -1)], `${piece}m`, extra);
        pushLine(out, tail(out), a, tail(out).z, zTop, `${piece}m`, extra);
      } else pushLine(out, at(take.x, take.y), a, zLip, zTop, `${piece}m`, extra);
      if (post.out === give.face) pushLine(out, a, edge(post, post.out), zTop, zTop, `${piece}x`, x);
      else cornerPath(out, a, give.face, post.out, zTop, zTop, `${piece}x`, x);
      return;
    }
    pushLine(out, at(take.x, take.y), at(give.x, give.y), zLip, zTop, `${piece}m`, extra);
    pushLine(out, at(give.x, give.y), m, zTop, zTop, `${piece}x`, stores ? {} : { cap: FALL_EXIT });
    pushLine(out, m, edge(post, post.out), zTop, zTop, `${piece}x`, stores ? {} : { cap: FALL_EXIT });
    return;
  }
  // Into the catcher and down its route (ring, off the disc onto the ramp, down and out).
  const down = routeLine(byKey(catcher.key), catcher.from, catcher.to).map((p) => worldPt(catcher, p));
  down[0] = tail(out);
  down[down.length - 1] = { ...edge(post, post.out), z: down.at(-1).z };
  pushRoute(out, down, `${piece}d`, {}, airToOf(byKey(catcher.key), catcher.from, catcher.to));
}

function tossPath(out, post, piece) {
  // Rolls into the launcher and waits under its tube; a hand fires it up the tube and on
  // along the tube's aim in a ballistic arc (ballistic.js), into the hood's mouth from
  // below; off the hood's roof it drops through the throat into the tower's top block
  // and leaves by that block's mouth.
  const rec = byKey(post.fit.key), fit = post.fit, carry = energyOf(rec, 'carry'), zTop = postZ(post.hOut), tower = cellCentre(post.c, post.r);
  // It waits on the inlet's axis under the tube's foot, and the tube runs from there to
  // its top (the outlet port); the path is the floor under the marble's centre.
  const [a, wait] = routeLine(rec, fit.from, fit.to).map((p) => worldPt(fit, p));
  const held = { hold: carry, smooth: true }, R = NOMINAL.marbleRadius;
  pushLine(out, a, wait, a.z, a.z, piece);
  const set = tossSetup(fit, post.hood), shot = post.throw ?? bestShot(set.from, set.dir, set.speeds, set.cone);
  pushLine(out, wait, set.from, wait.z, set.from.z - R, `${piece}l`, { rest: { maxIn: post.maxCatch, launch: carry }, source: sourceOf(rec), ...held });
  const arc = shot?.t ? arcPoints(set.from, set.dir, shot.v, shot.t) : [set.from, set.cone.at];
  // In the air: the marble's centre is a radius over each sample, not off a floor.
  for (const q of arc.slice(1)) out.push({ ...q, z: q.z - R, piece: `${piece}l`, air: true, ...held });
  const hood = routeLine(byKey(post.hood.key), post.hood.from, post.hood.to).map((p) => worldPt(post.hood, p));
  pushPoly(out, [tail(out), ...hood.slice(1)], `${piece}h`, held);
  const throat = tail(out);
  pushRise(out, throat, throat.z, zTop, `${piece}f`, { fall: true, smooth: true });
  pushLine(out, { x: tower.x, y: tower.y + 1e-4 }, edge(post, post.out), zTop, zTop, `${piece}x`, { cap: FALL_EXIT });
}

// Off the block's cup, over the tray's lip and down onto its floor, then rolling to rest a
// little past its middle, clear of the far wall's curve: along the tray record's route
// (its `via`, the floor measured on the model) when it draws one, else eased down 0.55
// slot under the cup seat.
function trayPath(out, post, z, piece) {
  const a = edge(post, post.out), [ax, ay] = HEADINGS[post.out], cells = post.endCells?.length ?? 2;
  const extra = { caught: true, maxSpeed: post.maxCatch }, low = z - DIM.slot * 0.55;
  const fit = post.fit, rec = fit && byKey(fit.key), to = rec && (rec.marblePaths ?? []).find((m) => m.from === fit.from && m.via)?.to;
  if (to) {
    // In over the lip and down the wall to the floor, as far as the last point the record gives.
    const line = routeLine(rec, fit.from, to).map((p) => worldPt(fit, p)).slice(0, -1);
    pushPoly(out, [{ ...a, z }, ...line.slice(1)], piece, extra);
    return;
  }
  const mid = { x: a.x + ax * DIM.cell * 0.6, y: a.y + ay * DIM.cell * 0.6 }, far = { x: a.x + ax * DIM.cell * (cells / 2 + 0.3), y: a.y + ay * DIM.cell * (cells / 2 + 0.3) };
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
      const zTop = postZ(post.hIn), zLow = postZ(post.hOut), rec = post.fit && byKey(post.fit.key);
      const mp = rec && (rec.marblePaths ?? []).find((x) => x.from === post.fit.from && (!post.fit.to || x.to === post.fit.to));
      if (mp?.via) {
        // A drop-in piece whose record draws the floor to its hole (via): along it, then
        // down the hole from its last point.
        const line = routeLine(rec, post.fit.from, mp.to).map((p) => worldPt(post.fit, p)).slice(0, -1), low = tail(line);
        pushRoute(out, line, piece);
        pushRise(out, low, low.z, zLow, `${piece}f`, { fall: true, smooth: true });
        pushLine(out, { x: low.x, y: low.y + 1e-4 }, edge(post, post.out), zLow, zLow, `${piece}x`, { cap: FALL_EXIT });
        return;
      }
      pushLine(out, edge(post, post.in, -1), m, zTop, zTop, piece);
      pushRise(out, m, zTop, zLow, `${piece}f`, { fall: true, smooth: true });
      pushLine(out, { x: m.x, y: m.y + 1e-4 }, edge(post, post.out), zLow, zLow, `${piece}x`, { cap: FALL_EXIT });
      return;
    }
    case 'spiral': {
      const zTop = postZ(post.hIn), zLow = postZ(post.hOut);
      pushLine(out, edge(post, post.in, -1), edge(post, post.in), zTop, zTop, piece);
      spiralPath(out, post, `${piece}s`);
      // Across the block under the host, turned 90 degrees: in through the side face the
      // band ends on, out through the opposite face.
      pushLine(out, tail(out), m, zLow, zLow, `${piece}x`, { cap: SPIRAL_EXIT });
      pushLine(out, m, edge(post, post.out), zLow, zLow, `${piece}x`, { cap: SPIRAL_EXIT });
      return;
    }
    case 'end': {
      if (post.fit && !post.endCells) {
        // A waiting piece used as the finish: the marble rolls in along its route to where
        // the piece holds it, and stays.
        const zIn = postZ(post.hIn ?? post.h), inn = entry(post), rec = byKey(post.fit.key);
        const to = (rec.marblePaths ?? []).find((m) => m.from === post.fit.from)?.to;
        const line = to ? routeLine(rec, post.fit.from, to).map((p) => worldPt(post.fit, p)) : [];
        if (line.length > 2) pushPoly(out, line.slice(0, waitAt(line) + 1), `${piece}e`, { caught: true, maxSpeed: post.maxCatch });
        else pushLine(out, edge(inn, post.in, -1), cellCentre(inn.c, inn.r), zIn, zIn, `${piece}e`, { caught: true, maxSpeed: post.maxCatch });
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
    // The marble waits at the route's corner and is sent out of the outlet.
    const rec = byKey(post.fit.key), line = routeLine(rec, post.fit.from, post.fit.to).map((p) => worldPt(post.fit, p));
    pushPoly(out, line.slice(waitAt(line)), 'p0w', { source: sourceOf(rec) });
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
  track.posts.forEach((p, i) => placePost(out, p, i));
  track.segs.forEach((s, i) => placeSeg(out, s, i));
  return out;
}

const putIn = (out) => (group, key, c, r, y, rot, extra = {}) => {
  const rec = byKey(key);
  out.push({ group, key, code: rec?.code ?? key, c, r, y, rot, block: !!LIB.blocks[key], ...extra });
};
// The parts of post i (its stacks, stands, fitted pieces, spiral and clip-ons), in the
// order placements() lists them; the generator adds them one post at a time.
export function placePost(out, p, i) {
  const put = putIn(out);
  p.stack.forEach((key, k) => put(i, key, p.c, p.r, heightBelow(p.stack, k), blockTurn(p, k), { top: k === p.stack.length - 1 }));
  (p.stands ?? []).forEach((s) => s.stack.forEach((key, k) => put(i, key, s.c, s.r, heightBelow(s.stack, k), standTurn(p, s))));
  for (const fit of fitsOf(p)) {
    const rec = byKey(fit.key), [oc, or] = originOf(fit);
    if (rec.parts) {
      const [sx, sy] = frameFor(fit.key).origin;
      for (const part of rec.parts) {
        const [c, r] = placeIn(fit, [part.at[0] + sx, part.at[1] + sy]);
        put(i, part.key, c, r, fit.base + (part.at[2] ?? 0), (fit.rot + (part.rot ?? 0)) % 4, { assembly: `${i}:${fit.key}` });
      }
    } else put(i, fit.key, oc, or, fit.base, fit.rot);
  }
  if (p.kind === 'spiral') put(i, p.piece, p.c, p.r, heightBelow(p.stack, p.stack.length - 1), p.in, { spiral: `p${i}s`, spiralSide: p.spiralSide });
  for (const d of p.decor ?? []) put(i, d.key, d.c, d.r, d.y, d.rot ?? 0, { decor: true });
  return out;
}
// Track i, which runs into post i + 1, and the clip-ons riding it.
export function placeSeg(out, s, i) {
  const put = putIn(out);
  put(i + 1, s.code, null, null, null, null, { seg: i });
  for (const d of s.decor ?? []) put(i + 1, d, null, null, null, null, { decor: true, onSeg: i });
  return out;
}

// A stand's blocks carry no marble, so they are turned with their cup ends (and the tab
// loops under them, 2.1 mm past the cell's edge) away from a neighbouring stand or the
// post's own stack: two tab ends facing on neighbouring cells would collide, a tab against
// a closed face fits (VTech's trex_plans_12 step 2-7; docs/physics_rework.md, round 3).
export function standTurn(p, s) {
  const cells = [...(p.stands ?? []).filter((o) => o !== s), ...(p.stack?.length ? [p] : [])];
  const alongX = cells.some((o) => o.r === s.r && Math.abs(o.c - s.c) === 1), alongY = cells.some((o) => o.c === s.c && Math.abs(o.r - s.r) === 1);
  const base = p.in ?? 0;
  if (alongX && !alongY) return base % 2 === 1 ? base : (base + 1) % 4;
  if (alongY && !alongX) return base % 2 === 0 ? base : (base + 1) % 4;
  return base;
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
