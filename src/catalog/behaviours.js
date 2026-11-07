// Sorts every record into what it can do on a track, from its ports, marble paths,
// role, stacking and physics fields alone. A new record with familiar fields gets a
// familiar behaviour with no code change. Nothing here names a piece or a set.
import { PIECES, ASSEMBLIES, partsOf } from './records.js';
import { FOOT, SIDE, DIRS, facesOf, frameOf } from './frame.js';

export const LOSSY_KEEP = 0.85; // share of speed kept through a piece whose energy is "loses", estimate

const portOf = (r, id) => r.ports.find((p) => p.id === id);
const hasFoot = (r) => r.ports.some((p) => FOOT.has(p.type));
const travel = (p) => !!p && ['track-end', 'port-hole'].includes(p.type) && facesOf(p).length > 0;

export const isBlock = (r) => r.ports.some((p) => p.type === 'stack-top') && r.ports.some((p) => p.type === 'stack-bottom')
  && !!r.stacking?.canHoldStackAbove && (r.shape?.footprintCells ?? [1, 1]).every((v) => v === 1);

// Feet that accept a floor may stand on it; feet that only take floor pegs must.
function feetRule(r) {
  const feet = r.ports.filter((p) => FOOT.has(p.type)), words = feet.flatMap((p) => p.accepts ?? []).join(' | ');
  const minBase = /floor/.test(words) ? 0 : 1;
  const maxBase = feet.every((p) => p.type === 'floor-peg') && !/block|stack/.test(words) ? 0 : Infinity;
  return { minBase, maxBase };
}

const maxCatch = (r) => r.physics?.maxCatchSpeed
  ?? (Math.max(...(r.shape?.footprintCells ?? [1])) >= 2 && r.physics?.surface === 'open U' ? 1.9 : 1.3);

const TRACK_SHAPES = new Set(['straight', 'quarter-turn', 'half-turn', 'S-drop']);

function trackOf(r) {
  if (hasFoot(r) || isBlock(r) || r.role === 'end') return null;
  const m = r.marblePaths?.[0];
  if (!m || m.from === m.to || !TRACK_SHAPES.has(m.shape)) return null;
  const a = portOf(r, m.from), b = portOf(r, m.to);
  if (!a || !b || ![a, b].every((p) => SIDE.has(p.type) || p.type === 'clip')) return null;
  const dx = Math.abs(b.at[0] - a.at[0]), dy = Math.abs(b.at[1] - a.at[1]);
  const turn = { 'quarter-turn': 1, 'half-turn': 2 }[m.shape] ?? 0;
  const ahead = turn === 2 ? 0 : Math.round(dx);
  const side = turn === 2 ? Math.round(Math.max(dx, dy)) : turn === 1 ? Math.round(dy) : 0;
  // A tight corner keeps a fast marble in with its wall, as a steep bank would.
  const bankDeg = turn ? r.physics?.bankDeg ?? (turn === 1 && ahead - 0.5 <= 0.5 ? 45 : 28) : 0;
  return {
    key: r.key, code: r.code, kind: ['straight', 'arc', 'uturn'][turn], turn, ahead, side, drops: [m.dropSlots], from: a.id, to: b.id,
    bankDeg, metalOnly: !!r.physics?.needsMetalMarble, keep: r.physics?.energy === 'loses' ? LOSSY_KEEP : 1,
    name: r.names?.spoken ?? r.names?.family ?? r.code,
  };
}

function blockOf(r) {
  if (!isBlock(r)) return null;
  const cups = r.ports.filter((p) => p.type === 'block-top-slot'), isCup = (id) => cups.some((p) => p.id === id);
  const paths = r.marblePaths ?? [];
  const across = paths.find((m) => m.from !== m.to && isCup(m.from) && isCup(m.to));
  const cross = r.stacking?.marbleCrossesTop && across ? { straight: 'straight', 'quarter-turn': 'corner' }[across.shape] ?? null : null;
  return {
    key: r.key, code: r.code, height: r.shape?.heightSlots ?? 1, faces: cups.flatMap(facesOf), cross,
    riser: !!r.stacking?.usableAsHeightOnly && cross !== 'corner',
    hole: paths.some((m) => isCup(m.from) && portOf(r, m.to)?.type === 'open-drop'),
    catcher: paths.some((m) => portOf(r, m.from)?.type === 'open-catch' && isCup(m.to)),
  };
}

// Pieces that sit on a stack and let a rolling marble fall into it.
function dropTopOf(r, block) {
  if (block) return block.hole ? { key: r.key, code: r.code, block: true, height: block.height } : null;
  if (!hasFoot(r) || r.stacking?.canHoldStackAbove) return null;
  const m = (r.marblePaths ?? []).find((x) => travel(portOf(r, x.from)) && portOf(r, x.to)?.type === 'open-drop' && x.dropSlots > 0);
  if (!m || /adds/.test(r.physics?.energy ?? '')) return null;
  return { key: r.key, code: r.code, block: false, height: Math.ceil(r.shape?.heightSlots ?? 1), from: m.from, port: portOf(r, m.from) };
}

// Pieces with feet that a marble passes through: by gravity, by motor, by hand.
function stationsOf(r) {
  if (!hasFoot(r)) return [];
  const energy = r.physics?.energy ?? 'none', paths = r.marblePaths ?? [];
  const lifts = paths.filter((m) => m.shape === 'carried' && m.dropSlots < 0);
  const base = {
    key: r.key, code: r.code, parts: partsOf(r), energy, needsMetal: !!r.physics?.needsMetalMarble, maxCatch: maxCatch(r),
    frame: frameOf(r), ...feetRule(r),
  };
  // Two ways out of one inlet: the record's exitRule says how the piece chooses.
  const rule = r.physics?.exitRule ?? null;
  if (rule) base.exitRule = rule;
  const out = [];
  for (const m of lifts.length ? lifts : paths) {
    const a = portOf(r, m.from), b = portOf(r, m.to);
    if (!a || !b || m.from === m.to) continue;
    const st = { ...base, from: a.id, to: b.id, drop: m.dropSlots };
    if (lifts.length) {
      if (travel(a)) out.push({ ...st, kind: 'carry' });
      else if (a.type === 'open-catch') out.push({ ...st, kind: 'carry', start: true });
    } else if (travel(a) && travel(b)) {
      out.push({ ...st, kind: energy === 'adds-by-hand' ? 'rest' : energy === 'adds-by-motor' ? 'carry' : 'inline' });
    } else if (travel(a) && b.type === 'open-drop') {
      if (m.dropSlots < 0 && /adds/.test(energy)) out.push({ ...st, kind: 'toss' });
      else if (m.dropSlots <= 0 && !/adds/.test(energy)) out.push({ ...st, kind: 'ramp' });
    } else if (a.type === 'open-catch' && travel(b) && r.role === 'start') out.push({ ...st, kind: 'start' });
  }
  return out;
}

// Pieces that catch a marble flying from another piece. Which flyers they take is in
// their catch port's accepts.
function catcherOf(r) {
  if (!hasFoot(r) || isBlock(r)) return null;
  for (const m of r.marblePaths ?? []) {
    const a = portOf(r, m.from), b = portOf(r, m.to);
    if (a?.type !== 'open-catch' || !b) continue;
    const out = travel(b) ? 'side' : b.type === 'open-drop' ? 'drop' : null;
    if (!out) continue;
    return {
      key: r.key, code: r.code, parts: partsOf(r), frame: frameOf(r), from: a.id, to: b.id, out, accepts: a.accepts ?? [],
      stores: r.physics?.energy === 'stores', needsMetal: !!r.physics?.needsMetalMarble, ...feetRule(r),
    };
  }
  return null;
}

// Tracks with no feet that hang from a block and drop the marble into the block below.
function spiralOf(r) {
  if (hasFoot(r)) return null;
  const m = r.marblePaths?.[0];
  if (m?.shape !== 'spiral' || !travel(portOf(r, m.from)) || portOf(r, m.to)?.type !== 'open-drop') return null;
  // The side the band lies on, right (+1) or left (-1) of the marble coming in, from where
  // the record puts its other ports. A band winds one way, so it cannot be mirrored.
  const a = portOf(r, m.from), [rx, ry] = DIRS[(facesOf(a)[0] + 3) % 4];
  const lean = r.ports.filter((p) => p !== a).reduce((n, p) => n + (p.at[0] - a.at[0]) * rx + (p.at[1] - a.at[1]) * ry, 0);
  return { key: r.key, code: r.code, drop: m.dropSlots, footprint: r.shape?.footprintCells ?? [2, 2], from: m.from, side: Math.sign(Math.round(lean * 100)) || null };
}

// Where a run may finish: a piece the marble only goes into.
function endOf(r, blocks) {
  if (r.role !== 'end' || isBlock(r)) return null;
  const ins = r.ports.filter((p) => travel(p) && p.flow === 'in');
  if (!ins.length || r.ports.some((p) => travel(p) && p.flow === 'out')) return null;
  const port = ins[0], clips = blocks.filter((b) => (port.accepts ?? []).some((s) => s.includes(b.code)));
  return { key: r.key, code: r.code, parts: [r.key], frame: frameOf(r), port: port.id, clip: clips.map((b) => b.key), maxCatch: maxCatch(r) };
}

function decorOf(r) {
  if (r.role !== 'decor' || (r.marblePaths ?? []).length) return null;
  const words = r.ports.filter((p) => p.type === 'clip').flatMap((p) => p.accepts ?? []);
  const hosts = [...new Set(PIECES.filter((x) => x.key !== r.key && words.some((s) => s.includes(x.code))).map((x) => x.code))];
  return hosts.length ? { key: r.key, code: r.code, hosts } : null;
}

const floorOf = (r) => (r.role === 'floor' && r.shape?.footprintCells ? { key: r.key, code: r.code, w: r.shape.footprintCells[0], d: r.shape.footprintCells[1] } : null);

const blocks = PIECES.map(blockOf).filter(Boolean);
const blockByKey = new Map(blocks.map((b) => [b.key, b]));

export const LIB = Object.freeze({
  tracks: Object.fromEntries(PIECES.map(trackOf).filter(Boolean).map((t) => [t.key, t])),
  blocks: Object.fromEntries(blocks.map((b) => [b.key, b])),
  dropTops: PIECES.map((r) => dropTopOf(r, blockByKey.get(r.key))).filter(Boolean),
  stations: [...PIECES, ...ASSEMBLIES].flatMap(stationsOf),
  catchers: [...PIECES, ...ASSEMBLIES].map(catcherOf).filter(Boolean),
  spirals: PIECES.map(spiralOf).filter(Boolean),
  ends: PIECES.map((r) => endOf(r, blocks)).filter(Boolean),
  decor: PIECES.map(decorOf).filter(Boolean),
  floors: PIECES.map(floorOf).filter(Boolean),
});

// Port mating. Each side's accepts must name the other piece, by code or by kind.
export function names(accepts, rec, port) {
  return (accepts ?? []).some((s) => s.includes(rec.code) || /another piece/.test(s)
    || (/track|tongue/.test(s) && !!LIB.tracks[rec.key] && port?.type !== 'clip')
    || (/block/.test(s) && isBlock(rec)));
}

export const mates = (ra, pa, rb, pb) => !!pa && !!pb && names(pa.accepts, rb, pb) && names(pb.accepts, ra, pa);

// A block mates on a face through any of its slots there.
export const blockPortsOn = (rec, face, rot = 0) => rec.ports.filter((p) => SIDE.has(p.type) && facesOf(p).some((f) => (f + rot) % 4 === face));
