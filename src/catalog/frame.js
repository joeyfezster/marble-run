// Puts any record on the floor grid: every port gets a cell, a facing and a height,
// and the whole piece can be turned and moved so a chosen port meets a chosen cell.
// Pure arithmetic on record fields; no piece is named here.

export const DIRS = Object.freeze([[1, 0], [0, 1], [-1, 0], [0, -1]]); // E S W N, (col,row)
export const FACE = Object.freeze({ E: 0, S: 1, W: 2, N: 3 });
export const FOOT = new Set(['stack-bottom', 'floor-peg']);
export const SIDE = new Set(['track-end', 'port-hole', 'block-top-slot', 'block-side-slot']);
export const SEAT = 0.32; // a cup seat sits this far under the top of what carries it, in slots

export const left = (h) => (h + 3) % 4;
export const right = (h) => (h + 1) % 4;
export const back = (h) => (h + 2) % 4;

// "any of N E S W" means the piece can be turned to use any face.
export function facesOf(port) {
  const f = port?.faces ?? '';
  if (/^any/.test(f)) return [0, 1, 2, 3];
  return FACE[f] === undefined ? [] : [FACE[f]];
}

export const level = (z) => Math.round(z + SEAT);
export const rotFace = (f, rot) => (f + rot) % 4;

export function rotXY([x, y], rot) {
  let a = x, b = y;
  for (let i = 0; i < ((rot % 4) + 4) % 4; i++) [a, b] = [-b, a];
  return [a + 0, b + 0];
}

const onEdge = (v) => Math.abs(v - Math.round(v)) > 0.4;
const span = (v) => (onEdge(v) ? [Math.floor(v), Math.ceil(v)] : [Math.round(v) + 0]);

// Shifts the record so its cells sit on whole numbers, then gives each port its cell.
export function frameOf(rec) {
  const marble = new Set((rec.marblePaths ?? []).flatMap((m) => [m.from, m.to]));
  const ref = rec.ports.find((p) => marble.has(p.id) && facesOf(p).length === 1)
    ?? rec.ports.find((p) => FOOT.has(p.type)) ?? { at: [0, 0, 0] };
  const f = facesOf(ref);
  const cx = ref.at[0] - (f.length === 1 ? DIRS[f[0]][0] * 0.5 : 0);
  const cy = ref.at[1] - (f.length === 1 ? DIRS[f[0]][1] * 0.5 : 0);
  const sx = Math.round(cx) - cx, sy = Math.round(cy) - cy;
  const ports = {};
  for (const p of rec.ports) {
    const x = p.at[0] + sx, y = p.at[1] + sy, fs = facesOf(p);
    let cells;
    if (!FOOT.has(p.type) && fs.length === 1) {
      const [dx, dy] = DIRS[fs[0]];
      cells = [[Math.round(x - dx * 0.25) + 0, Math.round(y - dy * 0.25) + 0]];
    } else cells = span(x).flatMap((a) => span(y).map((b) => [a, b]));
    ports[p.id] = { ...p, x, y, z: p.at[2], faceList: fs, cell: cells[0], cells };
  }
  const solidPorts = Object.values(ports).filter((p) => p.type !== 'clip');
  const all = solidPorts.flatMap((p) => p.cells);
  const xs = all.map(([a]) => a), ys = all.map(([, b]) => b);
  const cells = [];
  if (all.length) for (let a = Math.min(...xs); a <= Math.max(...xs); a++) for (let b = Math.min(...ys); b <= Math.max(...ys); b++) cells.push([a, b]);
  const feet = Object.values(ports).filter((p) => FOOT.has(p.type)).flatMap((p) => p.cells);
  return { origin: [sx, sy], ports, cells, feet: dedupe(feet), tall: Math.ceil(rec.shape?.heightSlots ?? 1) };
}

const dedupe = (cells) => [...new Map(cells.map((c) => [c.join(), c])).values()];

// Turns and moves a frame so that frame cell `anchor` lands on world cell `at`.
export function placeFrame(frame, anchor, at, rot) {
  const map = ([x, y]) => { const [a, b] = rotXY([x - anchor[0], y - anchor[1]], rot); return [at[0] + a, at[1] + b]; };
  const [ox, oy] = rotXY([frame.origin[0] - anchor[0], frame.origin[1] - anchor[1]], rot);
  return { map, origin: [at[0] + ox, at[1] + oy], rot };
}

// The turn that makes a port on `face` open toward the marble arriving with `heading`.
export const rotToMeet = (face, heading) => (back(heading) - face + 8) % 4;
