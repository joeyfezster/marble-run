// The plastic of every piece, as voxels in its record frame (x cells East, y cells South,
// z slots up), V cell by V slot each. Read from models/solids.json, which
// tools/solids/bake.mjs bakes from the Blender models (the physical truth, D1 in
// docs/physics_rework.md). A piece with no model falls back to a box from its record,
// flagged as a fallback. Names no piece: everything here is read from records and models.
//
// Nothing is carved out of it: the marble is judged against the models' triangles
// (collide.js), its own piece included. From the record (so a record fix needs no
// re-bake) come the mate zones, a box at each joining port (a tongue in a cup, a hook on a
// block) where another part's plastic may meet this one's by design.
import { DIM, byKey, TRACKS, LIB } from '../catalog/parts.js';
import { frameFor } from './fit.js';
import { seatOf, SIDE } from '../catalog/frame.js';

export const V = 0.125;
export const MARBLE_MM = 10; // marble radius, from the plain and metal marble records (20 mm across)

const inNode = typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined';

// ------------------------------------------------------------------ bit packing
const b64 = {
  enc: (bytes) => (globalThis.Buffer ? globalThis.Buffer.from(bytes).toString('base64') : btoa(String.fromCharCode(...bytes))),
  dec: (s) => (globalThis.Buffer ? new Uint8Array(globalThis.Buffer.from(s, 'base64')) : Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))),
};
export function encodeBits(cells, lo, n) {
  const bytes = new Uint8Array(Math.ceil((n[0] * n[1] * n[2]) / 8));
  for (const [i, j, k] of cells) { const b = ((k - lo[2]) * n[1] + (j - lo[1])) * n[0] + (i - lo[0]); bytes[b >> 3] |= 1 << (b & 7); }
  return b64.enc(bytes);
}
export function decodeBits(bits, lo, n) {
  const bytes = b64.dec(bits), out = [];
  for (let b = 0; b < n[0] * n[1] * n[2]; b++) if (bytes[b >> 3] & (1 << (b & 7))) {
    const i = b % n[0], j = Math.floor(b / n[0]) % n[1], k = Math.floor(b / (n[0] * n[1]));
    out.push(i + lo[0], j + lo[1], k + lo[2]);
  }
  return Int16Array.from(out);
}

// ------------------------------------------------------------------ loading
async function load(name) {
  try {
    if (inNode) {
      const { readFile } = await import('node:fs/promises');
      return JSON.parse(await readFile(new URL(`../../models/${name}`, import.meta.url), 'utf8'));
    }
    const r = await fetch(new URL(`../../models/${name}`, import.meta.url));
    return r.ok ? r.json() : null;
  } catch { return null; }
}
export const SOLIDS = await load('solids.json');
// How deep each pair of models goes into the other where the builders seat them (mm, mm3),
// measured by tools/seats.mjs (physical.js holds every pair to its seat).
export const SEATS = (await load('seats.json')) ?? { pairs: {} };

// ------------------------------------------------------------------ per-piece solid
const FACE_V = { E: [1, 0], S: [0, 1], W: [-1, 0], N: [0, -1] };
const MATING = new Set(['track-end', 'block-top-slot', 'block-side-slot', 'port-hole', 'clip', 'open-drop', 'open-catch']);
const isTrack = (rec) => !!rec && (!!TRACKS[rec.key] || LIB.spirals.some((sp) => sp.key === rec.key));

// A track's ends, from its model's stored marble path (metres): [x, y, z] (cells, cells,
// slots) and the unit way out of the piece in plan.
function endsOf(stored) {
  return [[stored[0], stored[1]], [stored.at(-1), stored.at(-2)]].map(([[px, py, pz], [qx, qy]]) => {
    const d = Math.hypot(px - qx, py - qy) || 1;
    return { e: [px / DIM.cell, py / DIM.cell, pz / DIM.slot], t: [(px - qx) / d, (py - qy) / d] };
  });
}
// The tongue past one end, measured on the model's voxels: how far it reaches past the
// end (cells), its half width (cells) and its bottom and top against the end's floor (slots).
function tongueOf(vox, { e, t }, maxAlong = 0.3) {
  let reach = 0, half = 0, lo = Infinity, hi = -Infinity;
  for (let q = 0; q < vox.length; q += 3) {
    const x = (vox[q] + 0.5) * V - e[0], y = (vox[q + 1] + 0.5) * V - e[1], z = (vox[q + 2] + 0.5) * V - e[2];
    // Past the end, within the room a tongue can take in a cup end (0.3 cell on, 0.4
    // across, half a slot up or down), so a band's own body beside its end is not counted.
    const along = x * t[0] + y * t[1], across = -x * t[1] + y * t[0];
    if (along < -V / 2 || along > maxAlong || Math.abs(across) > 0.4 || Math.abs(z) > 0.5) continue;
    reach = Math.max(reach, along); half = Math.max(half, Math.abs(across)); lo = Math.min(lo, z); hi = Math.max(hi, z);
  }
  // Voxel centres stand half a voxel inside the plastic's surface.
  return lo === Infinity ? null : { reach: reach + V / 2, half: half + V / 2, lo: lo - V / 2, hi: hi + V / 2 };
}
// What a piece's own plastic reaches past one of its side ports (a nose a track's end lies
// in, a lip resting on a cup end, a tab): measured as a tongue is, from the port outward.
const noseOf = (vox, at, fv) => tongueOf(vox, { e: at, t: fv })?.reach ?? 0;
// The longest nose of any piece that is not a track: how far a track's end may lie inside
// another piece's channel short of its own end.
let NOSE = null;
function noseMax() {
  if (NOSE !== null) return NOSE;
  NOSE = 0;
  for (const [key, m] of Object.entries(SOLIDS?.models ?? {})) {
    const rec = byKey(key);
    if (!rec || isTrack(rec)) continue;
    const vox = decodeBits(m.bits, m.lo, m.n);
    for (const p of rec.ports) {
      const fv = FACE_V[p.faces];
      if (fv && SIDE.has(p.type)) NOSE = Math.max(NOSE, noseOf(vox, [p.at[0], p.at[1], seatOf(p.at[2])], fv));
    }
  }
  return NOSE;
}

// What a piece's plastic rises over its stack top (a block's rails, a tower's crown
// points that hold the block above): slots, measured on its voxels.
function crownOf(vox, z) {
  let top = -Infinity;
  for (let q = 2; q < vox.length; q += 3) top = Math.max(top, (vox[q] + 1) * V);
  return Math.max(0, top - z);
}
// The tallest crown of any piece: how far the piece above may take one into its legs.
let CROWN = null;
function crownMax() {
  if (CROWN !== null) return CROWN;
  CROWN = 0;
  for (const [key, m] of Object.entries(SOLIDS?.models ?? {})) {
    const top = byKey(key)?.ports?.find((p) => p.type === 'stack-top');
    if (top) CROWN = Math.max(CROWN, crownOf(decodeBits(m.bits, m.lo, m.n), top.at[2]));
  }
  return CROWN;
}

// The largest tongue of any track model: what a cup or window must take.
let TONGUE = null;
function tongueMax() {
  if (TONGUE) return TONGUE;
  const all = [];
  for (const [key, m] of Object.entries(SOLIDS?.models ?? {})) {
    if (!isTrack(byKey(key)) || !(m.path?.length >= 2)) continue;
    const vox = decodeBits(m.bits, m.lo, m.n);
    for (const end of endsOf(m.path)) { const g = tongueOf(vox, end); if (g) all.push(g); }
  }
  // A drop facing a side whose own plastic lies on into the cup it hands the marble to
  // (the T-Rex's tail tip over the block under it) is a tongue too.
  for (const [key, m] of Object.entries(SOLIDS?.models ?? {})) {
    const rec = byKey(key);
    if (!rec || isTrack(rec)) continue;
    const vox = decodeBits(m.bits, m.lo, m.n);
    for (const p of rec.ports) { const g = tipOf(vox, p); if (g) all.push(g); }
  }
  TONGUE = all.length ? { reach: Math.max(...all.map((g) => g.reach)), half: Math.max(...all.map((g) => g.half)), lo: Math.min(...all.map((g) => g.lo)), hi: Math.max(...all.map((g) => g.hi)) } : { reach: 0.2, half: 0.3, lo: -0.2, hi: 0.3 };
  return TONGUE;
}

// A side-facing drop's tip: its own plastic from the port back into the piece, as far as
// the half cell a cup end spans, measured as a tongue is (null for any other port).
function tipOf(vox, p) {
  const fv = FACE_V[p.faces];
  if (p.type !== 'open-drop' || !fv) return null;
  const back = tongueOf(vox, { e: p.at, t: [-fv[0], -fv[1]] }, 0.5);
  // Only what lies at the cup's height (a third of a slot under the port and up) can be in it.
  return back && back.reach > V ? { ...back, reach: Math.min(0.5, back.reach), lo: Math.max(back.lo, -0.33) } : null;
}

// A piece's footprint in its record frame (cells): x and y bounds of its grid cells.
function footprintOf(key) {
  const fr = frameFor(key), [sx, sy] = fr.origin, cells = fr.cells.length ? fr.cells : [[sx, sy]];
  const xs = cells.map(([a]) => a - sx), ys = cells.map(([, b]) => b - sy);
  return { x: [Math.min(...xs) - 0.5, Math.max(...xs) + 0.5], y: [Math.min(...ys) - 0.5, Math.max(...ys) + 0.5] };
}
// A model's triangle corners in its record frame (cells, cells, slots), from the bake
// (metres in 0.05 mm steps, as collide.js reads them for the marble test).
function cornersOf(key) {
  const b = SOLIDS?.models?.[key]?.tris;
  if (!b) return null;
  const bytes = b64.dec(b.data), q = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1), out = new Float64Array(q.length);
  for (let i = 0; i < q.length; i += 3) { out[i] = q[i] * 5e-5 / DIM.cell; out[i + 1] = q[i + 1] * 5e-5 / DIM.cell; out[i + 2] = q[i + 2] * 5e-5 / DIM.slot; }
  return out;
}
const edgeOf = (foot, fv) => (fv[0] ? foot.x[fv[0] > 0 ? 1 : 0] : foot.y[fv[1] > 0 ? 1 : 0]);
// The tab loop under a cup end (a block-side-slot port), on the model's triangles: how far
// its plastic stands past the edge of the piece's footprint on that face (cells), its half
// width (cells), its bottom and top against the port's z (slots). Null when nothing
// stands past the edge there.
function tabOf(pts, p, foot) {
  const fv = FACE_V[p.faces];
  if (!pts || p.type !== 'block-side-slot' || !fv) return null;
  const edge = edgeOf(foot, fv);
  let reach = 0, half = 0, lo = Infinity, hi = -Infinity;
  for (let q = 0; q < pts.length; q += 3) {
    const along = fv[0] ? (pts[q] - edge) * fv[0] : (pts[q + 1] - edge) * fv[1], across = fv[0] ? pts[q + 1] - p.at[1] : pts[q] - p.at[0], z = pts[q + 2] - p.at[2];
    if (along <= 0 || Math.abs(across) > 0.5 || Math.abs(z) > 0.5) continue;
    reach = Math.max(reach, along); half = Math.max(half, Math.abs(across)); lo = Math.min(lo, z); hi = Math.max(hi, z);
  }
  return lo === Infinity ? null : { edge, reach, half, lo, hi };
}
// How far a piece's plastic stands short of its footprint's edge on one face, on the
// model's triangles (cells; negative when something stands past it).
function roomOf(pts, foot, fv) {
  const edge = edgeOf(foot, fv);
  let far = -Infinity;
  for (let q = 0; q < pts.length; q += 3) far = Math.max(far, fv[0] ? pts[q] * fv[0] : pts[q + 1] * fv[1]);
  return edge * (fv[0] || fv[1]) - far;
}

// Mate zones in record units, where another part's plastic may meet this one's by design,
// read from the models' geometry: at a track's end, the box its tongue fills (measured on
// its voxels), one voxel (the solids' resolution, V) larger all round; at a cup, window or
// track end of anything else, the box the largest tongue of any track fills when its end
// meets the port, and on over its own plastic past the port (a nose or lip), one voxel
// larger. A track's zone also reaches back from its end as far as the longest such nose.
// Two parts may share voxels only inside a zone of each
// whose ports face each other, or where one opens up or down (a catch, a drop). Stacked
// pieces interlock as far as the lower one's rails or crown rise over its stack top.
function mateZones(rec, vox, stored) {
  const out = [], track = isTrack(rec);
  const ends = track && stored?.length >= 2 ? endsOf(stored).map((end) => ({ ...end, g: tongueOf(vox, end) })) : null;
  for (const p of rec?.ports ?? []) {
    const fv = FACE_V[p.faces];
    // A leg's floor peg standing on blocks ("or two blocks of equal height") takes
    // their rails as a stacked block's legs do.
    if (p.type === 'stack-top' || p.type === 'stack-bottom' || p.type === 'floor-peg') {
      // Stacked pieces interlock: the legs of the one above take the rails or crown points
      // of the one below (as tall as measured on the lower piece's model).
      const [x, y, z] = p.at, [w, d] = rec.shape?.footprintCells ?? [1, 1];
      const up = p.type === 'stack-top' ? crownOf(vox, z) : crownMax();
      out.push({ port: p.id, at: p.at, face: null, stack: true, kind: 'stack', lo: [x - w / 2, y - d / 2, z - V], hi: [x + w / 2, y + d / 2, z + up + V] });
      continue;
    }
    if (!MATING.has(p.type)) continue;
    if (fv && ends) {
      // The end this port names: the one pointing its way, nearest it.
      const far = (n) => Math.hypot(n.e[0] - p.at[0], n.e[1] - p.at[1]) + (n.t[0] * fv[0] + n.t[1] * fv[1] < 0.5 ? 9 : 0);
      const n = ends.reduce((a, b) => (far(b) < far(a) ? b : a));
      if (!n.g) continue;
      out.push({ ...box(p.id, fv, [n.e[0], n.e[1], n.e[2]], [-(noseMax() + V), n.g.reach + V], n.g.half + V, [n.g.lo - V, n.g.hi + V]), kind: 'end' });
      continue;
    }
    // A side port's z names its track level; the joint sits at that level's seat.
    const z = fv && SIDE.has(p.type) && !track ? seatOf(p.at[2]) : p.at[2];
    if (fv) {
      const g = tongueMax(), nose = noseOf(vox, [p.at[0], p.at[1], z], fv), tip = tipOf(vox, p);
      // A drop's tip lies in the partner's cup: its zone is the tip itself.
      // A cup, window or port takes what lies in it: a track's tongue, a drop's tip or a
      // lip (a non-track piece's track end, such as the tray's), never another cup (kind 'port').
      if (tip) out.push({ ...box(p.id, fv, [p.at[0], p.at[1], z], [-(tip.reach + V), nose + V], tip.half + V, [tip.lo - V, tip.hi + V]), kind: 'tip' });
      else out.push({ ...box(p.id, fv, [p.at[0], p.at[1], z], [-(g.reach + V), nose + V], g.half + V, [g.lo - V, g.hi + V]), kind: p.type === 'track-end' ? 'lip' : 'port' });
    } else out.push({ port: p.id, at: [p.at[0], p.at[1], z], face: null, kind: 'catch', lo: [p.at[0] - 0.36, p.at[1] - 0.36, z - 0.45], hi: [p.at[0] + 0.36, p.at[1] + 0.36, z + 0.45] });
  }
  if (rec && !track) {
    // A tab loop rests against the face of the piece on the next cell (VTech's plans stand
    // a block's tab end against a neighbour's closed face: trex_plans_12 step 2-7). At the
    // solids' resolution the two share a voxel, so each tab gets a zone, the tab as
    // measured past the footprint, one voxel larger, and each face a flank zone one voxel
    // deep. A flank meets only a tab facing it, and only when the tab, measured on the
    // triangles, reaches no farther past its edge than the flank's plastic stands short of
    // it (physical.js `mated`): plastic that really overlaps is still found.
    const foot = footprintOf(rec.key), pts = cornersOf(rec.key);
    for (const p of rec.ports) {
      const g = tabOf(pts, p, foot), fv = FACE_V[p.faces];
      if (!g) continue;
      const at = fv[0] ? [g.edge, p.at[1], p.at[2]] : [p.at[0], g.edge, p.at[2]];
      out.push({ ...box(`${p.id}:tab`, fv, at, [0, g.reach + V], g.half + V, [g.lo - V, g.hi + V]), tab: g.reach });
    }
    let zlo = Infinity, zhi = -Infinity;
    for (let q = 2; q < vox.length; q += 3) { zlo = Math.min(zlo, vox[q] * V); zhi = Math.max(zhi, (vox[q] + 1) * V); }
    if (pts && zlo < zhi) for (const [face, fv] of Object.entries(FACE_V)) {
      const room = roomOf(pts, foot, fv), edge = edgeOf(foot, fv);
      if (!(room > 0)) continue;
      const mid = fv[0] ? [edge, (foot.y[0] + foot.y[1]) / 2, 0] : [(foot.x[0] + foot.x[1]) / 2, edge, 0];
      const half = fv[0] ? (foot.y[1] - foot.y[0]) / 2 : (foot.x[1] - foot.x[0]) / 2;
      out.push({ ...box(`flank${face}`, fv, mid, [-V, 0], half, [zlo, zhi]), flank: room });
    }
  }
  return out;
}
// An axis box at point o (cells, cells, slots) facing f: along f from a[0] to a[1] cells
// (negative into the piece... f points out of it), `half` cells across, z from dz[0] to dz[1].
function box(port, f, o, a, half, dz) {
  const xs = f[0] ? a.map((u) => o[0] + u * f[0]) : [o[0] - half, o[0] + half];
  const ys = f[1] ? a.map((u) => o[1] + u * f[1]) : [o[1] - half, o[1] + half];
  return { port, at: o, face: f, lo: [Math.min(...xs), Math.min(...ys), o[2] + dz[0]], hi: [Math.max(...xs), Math.max(...ys), o[2] + dz[1]] };
}

function boxOf(key, rec) {
  const fr = frameFor(key), [sx, sy] = fr.origin, cells = fr.cells.length ? fr.cells : [[sx, sy]];
  const xs = cells.map(([a]) => a - sx), ys = cells.map(([, b]) => b - sy), h = rec?.shape?.heightSlots ?? 1;
  const out = [];
  for (let i = Math.floor((Math.min(...xs) - 0.47) / V); (i + 0.5) * V < Math.max(...xs) + 0.47; i++)
    for (let j = Math.floor((Math.min(...ys) - 0.47) / V); (j + 0.5) * V < Math.max(...ys) + 0.47; j++)
      for (let k = 0; (k + 0.5) * V < h; k++) out.push(i, j, k);
  return Int16Array.from(out);
}


const cache = new Map();
// { key, source: 'glb' | 'box' | 'none', vox: Int16Array (i, j, k triples, local voxel
//   indices), zones, bottom (lowest k), path (a track's stored marble path) }
export function localSolid(key) {
  if (cache.has(key)) return cache.get(key);
  const rec = byKey(key), baked = SOLIDS?.models?.[key];
  let vox, source;
  if (baked) { vox = decodeBits(baked.bits, baked.lo, baked.n); source = 'glb'; }
  else if (rec) { vox = boxOf(key, rec); source = 'box'; }
  else { vox = new Int16Array(0); source = 'none'; }
  let bottom = Infinity;
  for (let q = 2; q < vox.length; q += 3) bottom = Math.min(bottom, vox[q]);
  const out = { key, source, vox, zones: mateZones(rec, vox, baked?.path), bottom, path: baked?.path ?? null };
  cache.set(key, out);
  return out;
}

// Which models are missing from the bake or baked from an older GLB (Node only).
export async function staleSolids() {
  if (!inNode) return [];
  const fs = await import('node:fs'), crypto = await import('node:crypto');
  const dir = new URL('../../models/', import.meta.url), out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.glb') && !/^marble_/.test(x))) {
    const name = f.slice(0, -4), sha = crypto.createHash('sha1').update(fs.readFileSync(new URL(f, dir))).digest('hex');
    if (SOLIDS?.models?.[name]?.sha !== sha) out.push(name);
  }
  return out;
}
