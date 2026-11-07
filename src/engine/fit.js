// A "fit" is one record placed on the grid: which frame cell is pinned to which
// world cell, the quarter turns, and the height of what it stands on.
import { byKey } from '../catalog/parts.js';
import { frameOf, rotXY, rotFace, level, rotToMeet } from '../catalog/frame.js';

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
