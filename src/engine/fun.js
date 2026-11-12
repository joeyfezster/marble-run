// How much fun a finished track is to build and to watch, for a 4-year-old and his dad:
// one small number from what the track does, never from which piece is which (names no
// piece). The search prefers more of it (generator.js score); tests/fun.test.js holds the
// distribution across seeds. Every part is capped, so no one trick buys the whole score.
//
//   special   3 a kind of special piece (launcher, jump ramp, catcher, hood, lift, spiral,
//             rocket, drop-in top: any record placed by a move that is not a plain
//             crossing, the start or the end), up to 6 kinds
//   moves     2 a kind of special move (jump, toss, fall, spiral, lift, pass-through,
//             launcher), up to 5
//   flights   2 a marble in the air (a jump or a toss), up to 3
//   drops     1 a drop down a stack or a spiral, up to 4
//   restart   4 a lift or launcher sends the marble on again mid-run
//   height    0.5 a slot of the highest point, up to 8 slots; 0.5 a level the marble
//             runs on, up to 6
//   wander    0.5 a cell of the route's narrower side (a route in one line is 1 wide),
//             up to 6; 0.25 a turn, up to 12
//   boring    -1.5 each plain straight crossing in a row past the second
import { fitsOf } from './geometry.js';
import { byKey } from '../catalog/parts.js';

export const FUN = Object.freeze({
  special: [3, 6], moves: [2, 5], flights: [2, 3], drops: [1, 4], restart: 4,
  height: [0.5, 8], levels: [0.5, 6], wander: [0.5, 6], turns: [0.25, 12], boring: [1.5, 2],
});
const RESTARTS = new Set(['carry', 'rest', 'toss']);
const codeOf = (key) => byKey(key)?.code ?? key;
const capped = ([w, cap], n) => w * Math.min(n, cap);

// The parts of the score, each a count before its weight.
export function funParts(track) {
  const posts = track.posts, special = new Set(), moves = new Set(), levels = new Set();
  let flights = 0, drops = 0, restart = false, top = 0, turns = 0, run = 0, boring = 0;
  const cs = [], rs = [];
  posts.forEach((p, i) => {
    for (const h of [p.hIn, p.h, p.hOut]) if (Number.isFinite(h)) top = Math.max(top, h);
    if (Number.isFinite(p.hOut ?? p.h)) levels.add(p.hOut ?? p.h);
    for (const at of [p.entry, p]) if (at && Number.isFinite(at.c)) { cs.push(at.c); rs.push(at.r); }
    if (i > 0 && p.in !== undefined && p.out !== undefined && p.in !== p.out) turns++;
    const plain = p.kind === 'cross' && p.in === p.out;
    run = plain ? run + 1 : 0;
    if (plain && run > FUN.boring[1]) boring++;
    if (p.first || p.kind === 'cross' || p.kind === 'end') return;
    moves.add(p.act ?? p.kind);
    for (const f of fitsOf(p)) special.add(codeOf(f.key));
    if (p.piece) special.add(codeOf(p.piece));
    if (p.kind === 'jump' || p.kind === 'toss') flights++;
    if (p.kind === 'fall' || p.kind === 'spiral') drops++;
    if (RESTARTS.has(p.act ?? p.kind)) restart = true;
  });
  const span = (xs) => (xs.length ? Math.max(...xs) - Math.min(...xs) + 1 : 0);
  return { special: special.size, moves: moves.size, flights, drops, restart, height: top, levels: levels.size, wander: Math.min(span(cs), span(rs)), turns, boring };
}

export function fun(track) {
  const n = funParts(track);
  return capped(FUN.special, n.special) + capped(FUN.moves, n.moves) + capped(FUN.flights, n.flights) + capped(FUN.drops, n.drops)
    + (n.restart ? FUN.restart : 0) + capped(FUN.height, n.height) + capped(FUN.levels, n.levels) + capped(FUN.wander, n.wander)
    + capped(FUN.turns, n.turns) - FUN.boring[0] * n.boring;
}

// What a track looks like at a glance, for telling two tracks of one size apart: its moves
// in order, with the special pieces they use and the turns between them.
export const signature = (track) => track.posts.map((p) => {
  if (p.kind === 'cross') return p.in === p.out ? 's' : 't';
  return `${p.act ?? p.kind}:${[...new Set([...fitsOf(p).map((f) => codeOf(f.key)), ...(p.piece ? [codeOf(p.piece)] : [])])].sort().join('+')}`;
}).join(' ');
