// A "fit" is one record placed on the grid: which frame cell is pinned to which
// world cell, the quarter turns, and the height of what it stands on.
import { byKey, DIM } from '../catalog/parts.js';
import { frameOf, rotXY, rotFace, level, rotToMeet, seatOf, SIDE, DIRS, facesOf } from '../catalog/frame.js';

const frames = new Map();
export function frameFor(key) {
  if (!frames.has(key)) frames.set(key, frameOf(byKey(key)));
  return frames.get(key);
}

// Pins port `portId` of record `key` to world cell `cell`, opening toward a marble
// that arrives with `heading`. A port that may face any way keeps the piece unturned.
export function fitAt(key, portId, cell, heading, base) {
  const p = frameFor(key).ports[portId];
  const rot = p.faceList.length === 1 ? rotToMeet(p.faceList[0], heading) : 0;
  return { key, anchor: p.cell, at: cell, rot, base, faces: p.faceList.length === 1 ? undefined : { [portId]: (heading + 2) % 4 } };
}

// Pins a cell of the frame with a fixed turn.
export const fitCell = (key, anchor, cell, rot, base) => ({ key, anchor, at: cell, rot, base });

const place = (fit, [x, y]) => {
  const [a, b] = rotXY([x - fit.anchor[0], y - fit.anchor[1]], fit.rot);
  return [fit.at[0] + a, fit.at[1] + b];
};

export function portAt(fit, id) {
  const p = frameFor(fit.key).ports[id];
  if (!p) return null;
  const [x, y] = place(fit, [p.x, p.y]), [c, r] = place(fit, p.cell);
  const face = fit.faces?.[id] ?? (p.faceList.length === 1 ? rotFace(p.faceList[0], fit.rot) : null);
  return { id, x, y, c, r, z: fit.base + p.z, level: fit.base + level(p.z), face, port: p };
}

export const cellsOf = (fit) => frameFor(fit.key).cells.map((c) => place(fit, c));
export const feetOf = (fit) => frameFor(fit.key).feet.map((c) => place(fit, c));
export const originOf = (fit) => place(fit, frameFor(fit.key).origin);
export const tallOf = (fit) => fit.base + frameFor(fit.key).tall;
export const placeIn = place;

// The marble's route through a record from port `from` to port `to`, as the record says
// it runs: in through the first port, round the corner where the two ports' axes cross
// for a quarter turn (a window into a chamber, then out along the plunger), straight
// otherwise; a fall rolls in over its drop and then drops. Record frame: [x, y] cells,
// z slots, on the floor the marble rolls on (a side port's seat, frame.js). The drawn
// path and the channel carved free in the model's solid (solids.js) both follow it.
const LIFT_IN = 0.55;
const MARBLE_R = 0.01; // m, the marble records' radius (solids.js MARBLE_MM)
const DIM_SLOT = DIM.slot, DIM_CELL = DIM.cell;
export function routeLine(rec, from, to) {
  const port = (id) => rec.ports.find((p) => p.id === id), a = port(from), b = port(to);
  if (!a || !b) return [];
  const all = rec.marblePaths ?? [], m = all.find((x) => x.from === from && x.to === to) ?? all.find((x) => x.from === to && x.to === from);
  const zOf = (p) => (SIDE.has(p.type) && facesOf(p).length ? seatOf(p.at[2]) : p.at[2]);
  const A = [a.at[0], a.at[1], zOf(a)], B = [b.at[0], b.at[1], zOf(b)];
  // A record that gives its route's inner points (`via`, record frame, on the floor under
  // the marble's centre; read from the model, see docs/piece_schema.md) is drawn through
  // them: in through A, then each point, then out through B. Written from `from` to `to`;
  // a path run backwards takes them in reverse.
  if (Array.isArray(m?.via) && m.via.length) {
    const via = m.from === from ? m.via : [...m.via].reverse();
    return [A, ...via.map((p) => [...p]), B];
  }
  // A funnel that winds the marble down into its hole (a spiral into an open drop) is
  // drawn as a fall through the hole; its flap swings out of the way.
  if (m?.shape === 'fall' || (m?.shape === 'spiral' && b.type === 'open-drop' && rec.ports.some((p) => p.type === 'stack-bottom'))) {
    const side = (p) => SIDE.has(p.type) && facesOf(p).length > 0;
    if (!side(b)) return [A, [B[0], B[1], A[2]], B];          // rolls over the drop, falls through it
    if (!side(a)) return [A, [A[0], A[1], B[2]], B];          // falls from the catch, rolls out
    return [A, [0, 0, A[2]], [0, 0, B[2]], B];                // a hub: drops at its middle, the record's origin
  }
  const fa = facesOf(a), fb = facesOf(b);
  if (m?.shape === 'carried' && fb.length === 1) {
    // A lift: rolls in to the lift half a cell inside its outlet (past the tongue of the
    // track leaving it), is carried up there, and rolls out of the outlet.
    const [dx, dy] = DIRS[fb[0]], px = B[0] - dx * LIFT_IN, py = B[1] - dy * LIFT_IN;
    return [A, [px, py, A[2]], [px, py, B[2]], B];
  }
  if (m?.shape === 'flight' && b.type === 'open-drop' && b.faces === 'up' && fa.length === 1) {
    // A launcher: the marble waits on its inlet's axis under the outlet, then goes up and
    // out of it (a tube); the throw beyond is ballistic.js's.
    // The outlet port names where the tube stands; a tube that leans (physics.aim) rises
    // along the aim from the waiting marble's centre, so its top lies that far over.
    const wait = DIRS[fa[0]][0] !== 0 ? [B[0], A[1]] : [A[0], B[1]];
    const v = Array.isArray(rec.physics?.aim) ? rec.physics.aim : rec.physics?.aim?.vector, h = v ? Math.hypot(v[0], v[1]) : 0;
    const off = h > 1e-6 && v[2] > 0 ? ((B[2] - A[2]) * DIM_SLOT - MARBLE_R) * (h / v[2]) / DIM_CELL : 0;
    const top = h > 1e-6 ? [wait[0] + (v[0] / h) * off, wait[1] + (v[1] / h) * off, B[2]] : B;
    return [A, [wait[0], wait[1], A[2]], top];
  }
  if (m?.shape === 'quarter-turn' && fa.length === 1 && fb.length === 1 && (fa[0] + fb[0]) % 2 === 1) {
    // a's axis runs along its face direction, b's along its own: they cross at the corner.
    const corner = DIRS[fa[0]][0] === 0 ? [A[0], B[1]] : [B[0], A[1]];
    return [A, [corner[0], corner[1], (A[2] + B[2]) / 2], B];
  }
  return [A, B];
}

// A record-frame point [x, y, z] of a fitted piece in the world: [c, r] cells, z slots.
export function worldOf(fit, [x, y, z]) {
  const [sx, sy] = frameFor(fit.key).origin, [c, r] = place(fit, [x + sx, y + sy]);
  return [c, r, fit.base + z];
}
