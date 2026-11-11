// Turns a finished track into steps a parent and a four-year-old can follow.
import { TRACKS, COLOR_WORDS, LIB, spokenName, byKey } from '../catalog/parts.js';
import { standing, placements } from '../engine/geometry.js';
import { tile } from '../engine/floor.js';

const word = (hex) => COLOR_WORDS[hex] ?? '';
// Every floor plate in the chosen sets, whatever plates the floor records describe.
const plateList = (sets) => sets.flatMap((s) => LIB.floors.flatMap((f) => Array(s.parts[f.code] ?? 0).fill({ code: f.code, color: s.colors?.[f.code] ?? '#3b3d42', set: s.id })));

// Covers what the build stands on with real plates: a neat margin if they stretch that far.
export function layFloor(track, sets, world) {
  const cells = standing(track), list = plateList(sets), cs = cells.map(([c]) => c), rs = cells.map(([, r]) => r);
  const tryPad = (pad) => {
    const c0 = Math.min(...cs) - pad, c1 = Math.max(...cs) + pad, r0 = Math.min(...rs) - pad;
    let r1 = Math.max(...rs) + pad;
    if ((r1 - r0 + 1) % 2) r1++;
    const f = tile(c0, c1, r0, r1, list);
    return { ...f, bounds: { c0, c1, r0, r1 } };
  };
  const stands = (f) => cells.every(([c, r]) => f.cells.some(([x, y]) => x === c && y === r));
  const best = [1, 0].map(tryPad).find(stands);
  if (best) return best;
  const f = tile(0, world.width - 1, 0, world.depth - 1, list);
  return { ...f, bounds: { c0: 0, c1: world.width - 1, r0: 0, r1: world.depth - 1 } };
}

const countWords = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const n = (x) => countWords[x] ?? String(x);
const nameOf = (p) => (p.seg !== undefined ? TRACKS[p.key]?.name ?? spokenName(p.key) : spokenName(p.key)).replace(/^the /, '');

export function makeSteps(track, placed, floor) {
  const counts = {};
  floor.plates.forEach((p) => { const k = `${p.code}|${p.color}`; counts[k] = (counts[k] ?? 0) + 1; });
  const floorItems = Object.entries(counts).map(([k, count]) => { const [code, color] = k.split('|'); return { code, color, count }; });
  const steps = [{ kind: 'floor', stage: 0, items: floorItems, line: 'Snap the floor together, like a puzzle.', cells: floor.cells }];
  for (const g of [...new Set(placed.map((p) => p.group))].sort((a, b) => a - b)) {
    const here = placed.filter((p) => p.group === g), blocks = here.filter((p) => p.block), others = here.filter((p) => !p.block);
    const line = [];
    if (blocks.length) line.push(`Stack ${n(blocks.length)} ${blocks.length === 1 ? 'block' : 'blocks'}.`);
    for (const p of others) {
      line.push(`Add the ${p.seg !== undefined ? `${word(p.color)} ` : ''}${nameOf(p)}.`);
      // A flap that flips each marble is set by hand, so the first marble goes the right way.
      if (byKey(p.key)?.physics?.exitRule === 'alternate') line.push('Push its flap down on the side away from the next track.');
    }
    const items = [...others.map((p) => ({ code: p.code, color: p.color ?? '#9aa3ad', set: p.set, count: 1 })), ...blocks.slice().reverse().map((p) => ({ code: p.code, color: p.color, set: p.set, count: 1 }))];
    const at = here.find((p) => p.c !== null && p.seg === undefined);
    steps.push({ kind: 'run', stage: g + 2, post: g, items, line: line.join(' '), cell: at ? [Math.round(at.c), Math.round(at.r)] : null });
  }
  const start = byKey(track.posts[0].piece), marbles = marbleTypesOf(track);
  steps.push({ kind: 'done', items: marbles.map((t) => ({ code: `marble_${t}`, color: t === 'metal' ? '#c9ccd2' : '#e0262c', set: null, count: 1 })), marbles, line: marbleLine(track, marbles, (start.names?.spoken ?? 'start').replace(/^the /, '')) });
  return steps;
}

const marbleTypesOf = (track) => (track.marbles?.length ? track.marbles : [track.marble ?? 'plain']);
const marbleWord = (type) => spokenName(`marble_${type}`).replace(/^the /, '');
// Which marbles to use, in words a four-year-old understands spoken aloud (D5). With both
// kinds, the plain ones go first and a magnet marble last: a magnet trigger on the run
// (the T-Rex) keeps the plain ones until a magnet marble wakes it up.
function marbleLine(track, marbles, startName) {
  const [only] = marbles;
  if (marbles.length === 1) return `You did it! Put a ${marbleWord(only)} in the ${startName} and let go!`;
  const store = placements(track).map((p) => byKey(p.key)).find((r) => r?.physics?.needsMetalMarble && r.physics.energy === 'stores');
  const wake = store ? ` It wakes up the ${(store.names?.spoken ?? store.code).replace(/^the /, '')}!` : '';
  return `You did it! Put a ${marbleWord('plain')} in the ${startName} and let go. Then send a shiny ${marbleWord('metal')}, last.${wake}`;
}

export const cellName = (c, r, b) => `${String.fromCharCode(65 + r - b.r0)}${c - b.c0 + 1}`;
