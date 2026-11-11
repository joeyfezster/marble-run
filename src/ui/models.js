// 3D models of the real Marble Rush pieces, drawn from VTech's parts drawings and
// Joey's close-up photos (reference/pieces, reference/photos). Each model sits on
// its own floor-level centre, y up, local x = the record's x (E) and local z = the
// record's y (S), so ports in data/pieces/*.json line up with the mesh. Sizes come
// from the floor cell (DIM.cell, about 45 mm) and one block height (DIM.slot).
// modelFor returns null only for flat printed plaques, which carry artwork, not shape.
import * as THREE from '../../vendor/three.module.min.js';
import { DIM } from '../catalog/parts.js';
import { spiralLocal } from '../engine/spiral.js';

const C = DIM.cell, S = DIM.slot, mm = (v) => v / 1000;
export const CUP_DEPTH = DIM.seatDrop * S;
export const CH_R = 0.0138;

// Block anatomy, shared by B-01..B-05 and every block-style foot.
const W = C * 0.94;                 // body width
const HR = S * 1.17 - 0.0004;       // rail top: rails rise 0.17 slot above the pitch
const SEAT = S * (1 - DIM.seatDrop); // lowest point of the cup
const WT = 0.0024;                  // wall thickness
const CA = W / 2 - 0.0034;          // half-width of the cup between the rails
const ARCH = 0.33 * S;              // arch radius in every face

export const plastic = (color, extra = {}) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.32, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.22, envMapIntensity: 0.6, ...extra });
const hex = (c) => new THREE.Color(c);
const DARK = 0x1d2126;

// Dark crease lines make each moulded piece read as its own part.
export function withEdges(mesh, angle = 32) {
  const c = new THREE.Color(mesh.material.color).multiplyScalar(0.5);
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, angle), new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.7 }));
  e.raycast = () => {}; e.userData.edge = true;
  mesh.add(e);
  return mesh;
}

const part = (g, geo, color, x = 0, y = 0, z = 0, extra) => {
  const mat = color?.isMaterial ? color : plastic(color, extra);
  const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
};
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (r1, r2, h, n = 24) => new THREE.CylinderGeometry(r1, r2, h, n);
const extrude = (shape, depth, bevel = 0.0006, curveSegments = 18, bevelSegments = 2) => new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments, curveSegments });
const shape = (pts) => { const s = new THREE.Shape(); pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y))); s.closePath(); return s; };
const rectPath = (x0, y0, x1, y1) => { const p = new THREE.Path(); p.moveTo(x0, y0); p.lineTo(x1, y0); p.lineTo(x1, y1); p.lineTo(x0, y1); p.closePath(); return p; };
const hole = (color = DARK) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: THREE.DoubleSide });
// A flat plan outline (x, z) given thickness upward from y0.
const slab = (pts, t, bevel = 0.0005) => { const g = extrude(shape(pts.map(([x, z]) => [x, -z])), t, bevel); g.rotateX(-Math.PI / 2); return g; };
const lathe = (pts, n = 40) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), n);

// ---------------------------------------------------------------- surfaces

// A moulded top surface as a height field over a rectangle; cells where cut(u, v)
// is true are left open (holes).
function heightField(x0, x1, z0, z1, n, m, fn, cut = () => false) {
  const pos = [], idx = [];
  for (let j = 0; j <= m; j++) for (let i = 0; i <= n; i++) {
    const u = x0 + ((x1 - x0) * i) / n, v = z0 + ((z1 - z0) * j) / m;
    pos.push(u, fn(u, v), v);
  }
  for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) {
    const u = x0 + ((x1 - x0) * (i + 0.5)) / n, v = z0 + ((z1 - z0) * (j + 0.5)) / m;
    if (cut(u, v)) continue;
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// Cross-section of a block cup: rails at HR, elliptical U down to SEAT.
const cupZ = (d) => { const t = Math.min(1, Math.abs(d) / CA); return SEAT + (HR - SEAT) * (1 - Math.sqrt(Math.max(0, 1 - t * t ** 1.6))); };

// One face wall: full width, low arch cut from its foot, top edge following the
// top surface along that face (so open cup ends show their U notch).
// Points along a straight stretch of the top edge are dropped: same outline, fewer faces.
function faceWall(topAt, arch = ARCH, w = W) {
  const s = new THREE.Shape(), n = 16;
  s.moveTo(-w / 2, 0); s.lineTo(-arch, 0); s.absarc(0, 0, arch, Math.PI, 0, true); s.lineTo(w / 2, 0);
  const top = [];
  for (let i = n; i >= 0; i--) { const u = -w / 2 + (w * i) / n; top.push([u, topAt(u)]); }
  top.forEach(([u, v], i) => {
    const a = top[i - 1], b = top[i + 1];
    if (a && b && Math.abs((v - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (u - a[0])) < 1e-12) return;
    s.lineTo(u, v);
  });
  s.closePath();
  return extrude(s, WT, 0.0003, 6, 1);
}

// Place a face-local geometry on face E, S, W or N of a body of width w.
function onFace(m, face, w = W, out = 0) {
  const h = w / 2;
  if (face === 'S') { m.position.z = h - WT + out; }
  if (face === 'N') { m.rotation.y = Math.PI; m.position.z = -h + WT - out; }
  if (face === 'E') { m.rotation.y = -Math.PI / 2; m.position.x = h - WT + out; }
  if (face === 'W') { m.rotation.y = Math.PI / 2; m.position.x = -h + WT - out; }
  return m;
}
// Face-local coordinate s maps to the top surface (u, v) along that face.
const faceUV = { S: (s) => [s, W / 2], N: (s) => [-s, -W / 2], E: (s) => [W / 2, -s], W: (s) => [-W / 2, s] };

// The rectangular tab loop under an open cup end; track feet hook into it.
function tabLoop(g, color, face) {
  const s = shape([[-0.011, 0], [0.011, 0], [0.011, 0.0085], [-0.011, 0.0085]]);
  s.holes.push(rectPath(-0.0078, 0.0022, 0.0078, 0.0063));
  const m = withEdges(part(g, extrude(s, 0.0034, 0.0004), color));
  m.position.y = S * 0.47;
  onFace(m, face, W, 0.0034);
  return m;
}

// Body of a block: four arched walls with a top surface, a shell seam, rail pegs.
function blockBody(g, color, top, { tabs = [], cut, pegs = true, grid = [72, 72] } = {}) {
  for (const f of ['E', 'S', 'W', 'N']) {
    const m = withEdges(part(g, faceWall((s) => top(...faceUV[f](s))), color), 40);
    onFace(m, f);
  }
  const surf = part(g, heightField(-W / 2 + 0.0008, W / 2 - 0.0008, -W / 2 + 0.0008, W / 2 - 0.0008, ...grid, top, cut), plastic(color, { side: THREE.DoubleSide }));
  surf.castShadow = true;
  // Seam where the upper shell meets the legs.
  for (const f of ['E', 'S', 'W', 'N']) { const b = part(g, box(W + 0.0012, 0.0016, 0.0012), color); b.position.y = S * 0.6; onFace(b, f, W, 0.0006); b.position.y = S * 0.6; }
  if (pegs) for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const u = (x * W) / 2 - x * 0.0028, v = (z * W) / 2 - z * 0.0028;
    part(g, cyl(0.0011, 0.0013, 0.003, 6), color, u, top(u, v) + 0.0012, v);
  }
  for (const f of tabs) tabLoop(g, color, f);
}

export function block(code, color) {
  const g = new THREE.Group();
  if (code === 'B-05') {
    // Corner turn (IMG_0951): a quarter-bowl channel sweeps from the W face round
    // the inner SW corner to the S face. The NE half is a flat high rim, the inner
    // corner a leg ridge that rises to a small peg. Tabs under both open faces.
    const ix = -W / 2, iz = W / 2, rc = W / 2;
    const top = (u, v) => cupZ(Math.hypot(u - ix, v - iz) - rc);
    blockBody(g, color, top, { tabs: ['W', 'S'], pegs: false, grid: [24, 24] });
    const post = withEdges(part(g, box(0.0062, HR - 0.004, 0.0062), color, ix + 0.0026, (HR - 0.004) / 2, iz - 0.0026));
    post.rotation.y = Math.PI / 4;
    part(g, cyl(0.0019, 0.0021, 0.0065, 10), color, ix + 0.0032, HR - 0.001, iz - 0.0032);
    for (const [x, z] of [[1, -1], [1, 1], [-1, -1]]) part(g, cyl(0.0012, 0.0014, 0.003, 10), color, (x * W) / 2 - x * 0.0028, HR + 0.001, (z * W) / 2 - z * 0.0028);
    return g;
  }
  if (code === 'B-02') {
    // One-mouth pocket: the cup runs in from the E face and ends in a rounded
    // back against a full-height W wall. One tab, under the mouth.
    const back = -W / 2 + CA + 0.002;
    const top = (u, v) => cupZ(u >= back ? v : Math.hypot(v, u - back));
    blockBody(g, color, top, { tabs: ['E'], grid: [16, 32] });
    return g;
  }
  const holeR = 0.0118;
  const cut = code === 'B-03' || code === 'B-04' ? (u, v) => u * u + v * v < holeR * holeR : undefined;
  // A straight cup only curves across (v), so without a hole one strip spans its length.
  blockBody(g, color, (u, v) => cupZ(v), { tabs: ['E', 'W'], cut, grid: cut ? [32, 32] : [1, 32] });
  if (cut) {
    // The marble-sized hole through the cup floor, with its short throat.
    const t = part(g, new THREE.CylinderGeometry(holeR, holeR, 0.008, 32, 1, true), plastic(color, { side: THREE.DoubleSide }), 0, SEAT - 0.004, 0);
    t.material.color.multiplyScalar(0.8);
    const r = part(g, new THREE.TorusGeometry(holeR, 0.0009, 6, 24), color, 0, SEAT + 0.0004, 0); r.rotation.x = Math.PI / 2;
  }
  return g;
}

// Feet of any block-style module: four legs with arches between them, height h.
function blockFeet(g, color, h = S * 0.5, w = W) {
  for (const f of ['E', 'S', 'W', 'N']) {
    const m = withEdges(part(g, faceWall(() => h, Math.min(ARCH, h * 0.86), w), color), 40);
    const hw = w / 2;
    if (f === 'S') m.position.z = hw - WT;
    if (f === 'N') { m.rotation.y = Math.PI; m.position.z = -hw + WT; }
    if (f === 'E') { m.rotation.y = -Math.PI / 2; m.position.x = hw - WT; }
    if (f === 'W') { m.rotation.y = Math.PI / 2; m.position.x = -hw + WT; }
  }
  part(g, box(w - 0.002, 0.002, w - 0.002), color, 0, h - 0.001, 0);
}

// ---------------------------------------------------------------- floor

export function plate(code, color) {
  // Jigsaw floor plate: each cell a flat tile with a raised square frame round a
  // window, four corner studs, and puzzle tabs on two edges (trex_plans_01, lp_plans_00).
  const g = new THREE.Group(), [w, d] = code === 'P-01' ? [4, 2] : [2, 1], c = C, t = 0.003;
  const tile = new THREE.Shape(); const e = c / 2 - 0.0004;
  tile.moveTo(-e, -e); tile.lineTo(e, -e); tile.lineTo(e, e); tile.lineTo(-e, e); tile.closePath();
  const h = 0.0105; tile.holes.push(rectPath(-h, -h, h, h));
  const tileG = extrude(tile, t, 0); tileG.rotateX(-Math.PI / 2);
  const frame = new THREE.Shape(), f = 0.0145; frame.moveTo(-f, -f); frame.lineTo(f, -f); frame.lineTo(f, f); frame.lineTo(-f, f); frame.closePath();
  frame.holes.push(rectPath(-h, -h, h, h));
  const frameG = extrude(frame, 0.0034, 0.0004, 18, 1); frameG.rotateX(-Math.PI / 2);
  const tab = new THREE.Shape(); tab.moveTo(-0.0035, 0); tab.lineTo(-0.0035, 0.003); tab.absarc(0, 0.0065, 0.0055, -Math.PI * 0.72, Math.PI * 1.72, false); tab.lineTo(0.0035, 0.003); tab.lineTo(0.0035, 0); tab.closePath();
  const tabG = extrude(tab, t, 0, 8); tabG.rotateX(-Math.PI / 2);
  for (let x = 0; x < w; x++) for (let y = 0; y < d; y++) {
    withEdges(part(g, tileG, color, x * c, -t, y * c), 50);
    withEdges(part(g, frameG, color, x * c, 0, y * c), 50);
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) part(g, cyl(0.0011, 0.0011, 0.0022, 6), color, x * c + sx * 0.0175, 0.0011, y * c + sz * 0.0175);
    if (x === w - 1) { const m = part(g, tabG, color, x * c + e, -t, y * c); m.rotation.y = -Math.PI / 2; m.position.y = 0; m.rotation.x = 0; }
    if (y === d - 1) { const m = part(g, tabG, color, x * c, -t, y * c + e); m.rotation.y = Math.PI; }
  }
  // Origin at the plate's centre, as in its record (scene.js poses plates there).
  for (const m of g.children) { m.position.x -= ((w - 1) * c) / 2; m.position.z -= ((d - 1) * c) / 2; }
  return g;
}

// ---------------------------------------------------------------- tracks

// Track cross-section, left lip to right lip, floor at v = 0: a shallow trough
// with a flat floor and low side walls (T-06 in IMG_0952/0953, curves on trex_plans_01).
function trackSection(hw, depth, outer = 1) {
  // Left lip, wall bending into a flat floor, right wall (taller on the outside of a curve).
  const pts = [], n = 4, f = hw * 0.72, r = hw - f;
  for (let i = 0; i <= n; i++) { const a = (Math.PI / 2) * (i / n); pts.push([-f - r * Math.cos(a) - 0.0006 * (1 - i / n), (depth - r) * (1 - i / n) + r * (1 - Math.sin(a))]); }
  for (let i = 1; i < 14; i++) pts.push([-f + (2 * f * i) / 14, 0]);
  const d2 = depth * outer;
  for (let i = n; i >= 0; i--) { const a = (Math.PI / 2) * (i / n); pts.push([f + r * Math.cos(a) + 0.0006 * (1 - i / n), (d2 - r) * (1 - i / n) + r * (1 - Math.sin(a))]); }
  return pts;
}

// A swept track along points {x, y, z} (record axes: y = S, z = up). Slot
// windows are real gaps in the floor. Options: width (half-width), depth, outerWall
// (factor for the outside wall on curves), slots (rows across, as fractions of the
// half-width), lap (extend ends), round (deep round U, for chutes and scoops).
// mirror puts the taller outer wall on the left, for a curve turning right.
export function channelGeo(points, { slots = true, lap = 0.006, width = CH_R, flat = false, depth, outer = 1, rows, round = false, slotLen = 0.07, closedEnd = false, mirror = false } = {}) {
  const hw = flat ? width : width * 0.92, dp = depth ?? (round ? hw * 0.95 : hw * 0.45);
  let inner = round
    ? Array.from({ length: 15 }, (_, i) => { const a = ((-96 + (192 * i) / 14) * Math.PI) / 180; return [Math.sin(a) * hw, (1 - Math.cos(a)) * dp * (Math.abs(a) > Math.PI / 2 ? 1 : 1)]; })
    : trackSection(hw, dp, outer);
  if (mirror) inner = inner.map(([u, v]) => [-u, v]).reverse();
  const T = 0.0018, outerRing = inner.map(([u, v]) => [u * (1 + T / hw), v - T]).reverse();
  const ring = [...inner, ...outerRing], m = ring.length, half = inner.length;
  const pts = points.filter((_, i) => i % 2 === 0 || i === points.length - 1).map((p) => new THREE.Vector3(p.x, p.z, p.y));
  if (pts.length > 2 && lap) {
    const a = pts[0].clone().sub(pts[1]).normalize(), b = pts.at(-1).clone().sub(pts.at(-2)).normalize();
    pts.unshift(pts[0].clone().addScaledVector(a, lap)); pts.push(pts.at(-1).clone().addScaledVector(b, lap));
  }
  const pos = [], idx = [], along = [];
  let run = 0;
  pts.forEach((p, i) => {
    run += i ? p.distanceTo(pts[i - 1]) : 0; along.push(run);
    const t = pts[Math.min(i + 1, pts.length - 1)].clone().sub(pts[Math.max(i - 1, 0)]).normalize();
    const side = new THREE.Vector3().crossVectors(t, new THREE.Vector3(0, 1, 0));
    if (side.lengthSq() < 1e-8) side.set(0, 0, 1); side.normalize();
    const up = new THREE.Vector3().crossVectors(side, t).normalize();
    ring.forEach(([u, v]) => pos.push(p.x + side.x * u + up.x * v, p.y + side.y * u + up.y * v, p.z + side.z * u + up.z * v));
  });
  const total = along.at(-1), count = Math.max(1, Math.round(total / slotLen)), span = (total - 0.03) / count;
  const slotRows = rows ?? [0];
  const inSlot = (d, u) => slots && total > 0.03 && d > 0.016 && d < total - 0.016 && ((d - 0.016) % span) < span * 0.8 && slotRows.some((r) => Math.abs(u / hw - r) < (slotRows.length > 1 ? 0.2 : 0.3));
  for (let i = 0; i < pts.length - 1; i++) {
    for (let j = 0; j < m; j++) {
      // Outer-shell face j lies under inner face m - 2 - j.
      const jj = j < half ? j : m - 2 - j, u = inner[Math.max(0, jj)][0];
      const isFloor = jj > 0 && jj < half - 1 && Math.abs(inner[jj][1]) < dp * 0.3 && Math.abs(inner[jj + 1][1]) < dp * 0.3;
      if (isFloor && inSlot(along[i], u)) continue;
      const a = i * m + j, b = i * m + ((j + 1) % m), c = (i + 1) * m + j, d = (i + 1) * m + ((j + 1) % m);
      idx.push(a, c, b, b, c, d);
    }
  }
  if (closedEnd) {
    const base = (pts.length - 1) * m, cIdx = pos.length / 3, p = pts.at(-1);
    pos.push(p.x, p.y + dp * 0.5, p.z);
    for (let j = 0; j < half - 1; j++) idx.push(base + j, base + j + 1, cIdx);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// Curved bands are wide, flat-floored, with a higher outer wall and two slot rows;
// straights are narrower with one row.
const CURVES = ['T-01', 'T-02', 'T-03', 'T-04', 'T-05'];
export const trackOpts = (code) => (CURVES.includes(code) ? { width: 0.0155, flat: true, outer: 1.5, rows: code === 'T-03' ? [0] : [-0.45, 0.45] } : { width: 0.0125, flat: true });

export function trackModel(points, color, opts) {
  return withEdges(new THREE.Mesh(channelGeo(points, opts), plastic(color, { side: THREE.DoubleSide })), 55);
}

// End tongue foot: the small hook under each track end that clips into a block's
// tab loop (trex_plans_01 T-06, T-07; lp_plans_04 T-06).
function endFeet(g, color, a, dirA, b, dirB) {
  for (const [p, d] of [[a, dirA], [b, dirB]]) {
    const f = part(g, box(0.003, 0.005, 0.009), color, p.x - d.x * 0.007, p.z - 0.0035, p.y - d.y * 0.007);
    f.rotation.y = -Math.atan2(d.y, d.x);
  }
}

const line = (n, f) => Array.from({ length: n + 1 }, (_, i) => f(i / n));
const arcPts = (R, a0, a1, n, z = () => 0) => line(n, (u) => { const a = a0 + (a1 - a0) * u; return { x: R * Math.cos(a), y: R * Math.sin(a), z: z(u) }; });

function soloTrack(code, color) {
  const g = new THREE.Group(), o = trackOpts(code);
  const add = (pts, opts = o) => { g.add(trackModel(pts, color, { lap: 0, ...opts })); return pts; };
  const feet = (pts) => {
    const a = pts[0], b = pts.at(-1), n = pts.length;
    const da = { x: pts[1].x - a.x, y: pts[1].y - a.y }, db = { x: b.x - pts[n - 2].x, y: b.y - pts[n - 2].y };
    const la = Math.hypot(da.x, da.y), lb = Math.hypot(db.x, db.y);
    endFeet(g, color, a, { x: -da.x / la, y: -da.y / la }, b, { x: db.x / lb, y: db.y / lb });
  };
  const ease = (u) => u * u * (3 - 2 * u);
  switch (code) {
    case 'T-06': feet(add(line(30, (u) => ({ x: u * mm(72), y: 0, z: 0 })), { ...o, slotLen: 0.06 })); break;
    case 'T-07': feet(add(line(40, (u) => ({ x: u * mm(116), y: 0, z: 0 })), { ...o, slotLen: 0.05 })); break;
    case 'T-08': feet(add(line(40, (u) => ({ x: u * mm(84), y: 0, z: -S * ease(u) })), { ...o, slotLen: 0.035 })); break;
    case 'T-15': {
      // Long rigid yellow chute, high walls, two ridges along the floor, no slots.
      const pts = add(line(40, (u) => ({ x: u * mm(150), y: 0, z: 0 })), { width: 0.0115, flat: true, depth: 0.011, slots: false });
      for (const s of [-1, 1]) part(g, box(mm(146), 0.0015, 0.0014), color, mm(75), 0.0008, s * 0.004);
      feet(pts); break;
    }
    case 'T-02': feet(add(arcPts(C, -Math.PI / 2, Math.PI / 2, 60))); break;
    case 'T-01': feet(add(arcPts(C * 1.5, -Math.PI / 2, Math.PI / 2, 70), { ...o, width: 0.0165 })); break;
    case 'T-05': feet(add(arcPts(C * 0.55, -Math.PI / 2, Math.PI / 2, 40), { ...o, width: 0.0145 })); break;
    case 'T-03': feet(add(arcPts(C * 0.75, -Math.PI / 2, 0, 24))); break;
    case 'T-04': feet(add(arcPts(C * 1.6, -Math.PI / 2, 0, 50))); break;
    default: return null;
  }
  return g;
}

function scoop(color) {
  // T-14: short banana-shaped chute: a tongue at the low end, then it bends up to a
  // closed rounded lip with no foot (trex_plans_01).
  const g = new THREE.Group(), pts = line(30, (u) => ({ x: u * mm(52), y: 0, z: mm(40) * u ** 2.2 }));
  g.add(trackModel(pts, color, { lap: 0, slots: false, width: 0.0125, round: true, depth: 0.011, closedEnd: true }));
  endFeet(g, color, pts[0], { x: -1, y: 0 }, pts[0], { x: -1, y: 0 });
  return g;
}

// The spiral band's look, shared by the library model and the game (scene.js).
export const SPIRAL_OPTS = Object.freeze({ width: 0.0165, flat: true, outer: 2.0, rows: [-0.3, 0.35], slotLen: 0.045, lap: 0 });

function spiral(color, footprint = [2, 2]) {
  // T-17 (IMG_0959-0961, the VTech icon): one wide grey band with a tall outer wall and
  // arc slots, about three quarters of a turn round the front corner of its host stack.
  // Its tongue leaves the host's cup end (record port "in", heading +x);
  // the band falls one slot and ends on the side face of the block under the host
  // (record x -0.5, y +0.5), heading back across it, with a clip into that face's tab.
  // Same curve as the game path.
  const g = new THREE.Group(), drop = S;
  // In the GLB's frame (tools/blender/engine_paths.mjs): the host's centre at the origin, the
  // band starting at the record's `in` height (1 slot) and ending one slot lower.
  const pts = spiralLocal(footprint).map((p) => ({ x: p.a * C, y: p.s * C, z: drop * (1 - p.f) }));
  g.add(trackModel(pts, color, { ...SPIRAL_OPTS, mirror: true }));
  const e = pts.at(-1), d = pts.at(-2), len = Math.hypot(e.x - d.x, e.y - d.y) || 1;
  endFeet(g, color, pts[0], { x: -1, y: 0 }, e, { x: (e.x - d.x) / len, y: (e.y - d.y) / len });
  return g;
}

// ---------------------------------------------------------------- special pieces

function funnel() {
  // M-14 (IMG_0957/0958, lp manual p5): tapered yellow box body on block feet, a
  // tall arched front opening with a dished bowl floor and a tab loop under its lip,
  // an orange slider gate through a slot at the top of the opening, a round collar,
  // and a clear trumpet funnel standing in it.
  const g = new THREE.Group(), Y = 0xf7bb12, foot = S * 0.45, bh = S * 1.25;
  blockFeet(g, Y, foot);
  const b = withEdges(part(g, cyl(W * 0.43 * Math.SQRT2, W * 0.5 * Math.SQRT2, bh, 4, 1), Y, 0, foot + bh / 2, 0, { flatShading: true }), 30); b.rotation.y = Math.PI / 4;
  // Front opening: dark arch with the bowl in it.
  const op = shape([[-0.012, 0], [0.012, 0], [0.012, 0.024]]); op.holes = []; void op;
  const arch = new THREE.Shape(); arch.moveTo(-0.0125, 0); arch.lineTo(0.0125, 0); arch.lineTo(0.0125, 0.022); arch.absarc(0, 0.022, 0.0125, 0, Math.PI, false); arch.closePath();
  const a = part(g, new THREE.ShapeGeometry(arch), hole(0x8a6a08), W * 0.5 + 0.0003, foot + 0.003, 0); a.rotation.y = Math.PI / 2;
  const bowl = part(g, new THREE.SphereGeometry(0.0125, 24, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), plastic(0xe0a20c, { side: THREE.DoubleSide }), W * 0.5 - 0.004, foot + 0.0135, 0);
  bowl.scale.y = 0.6;
  tabLoop(g, Y, 'E').position.y = foot - 0.002;
  part(g, box(0.02, 0.005, 0.024), 0xf07f1e, W * 0.5 + 0.004, foot + 0.039, 0);
  part(g, cyl(0.0145, 0.0155, 0.01, 32), Y, 0, foot + bh + 0.005, 0);
  const glass = new THREE.Mesh(lathe([[0.0125, 0], [0.0128, 0.03], [0.0145, 0.058], [0.022, 0.075], [0.034, 0.083], [0.036, 0.085]], 48), new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.05, transparent: true, opacity: 0.32, side: THREE.DoubleSide, clearcoat: 1, envMapIntensity: 1.6, depthWrite: false }));
  glass.position.y = foot + bh + 0.01; g.add(glass);
  const rim = part(g, new THREE.TorusGeometry(0.0355, 0.0012, 8, 48), new THREE.MeshPhysicalMaterial({ color: 0xdfe8ee, transparent: true, opacity: 0.6, roughness: 0.1 }), 0, foot + bh + 0.095, 0); rim.rotation.x = Math.PI / 2;
  return g;
}

function pusher() {
  // M-01 (IMG_0962-0964, lp manual p5, lp_plans_04): a tall yellow housing on block
  // feet, tapering toward the top. A big round-topped arch in each flank and a smaller
  // one in the front show a low dished bowl with a small hole. Over the front arch a
  // little hood with an arrow covers the plunger. On top, a long orange paddle lever
  // pivots in a bracket near the front; its tail rises behind the body, raised.
  const g = new THREE.Group(), Y = 0xf7bb12, O = 0xf07f1e, foot = S * 0.4, bh = S * 1.5;
  blockFeet(g, Y, foot);
  const bot = W * 0.5, top = W * 0.34, lean = Math.atan2(bot - top, bh);
  const wall = (archW, archH) => {
    const s = shape([[-bot, 0], [bot, 0], [top, bh], [-top, bh]]);
    if (archW) { const ar = new THREE.Path(); ar.moveTo(-archW, 0.002); ar.lineTo(archW, 0.002); ar.lineTo(archW, archH - archW); ar.absarc(0, archH - archW, archW, 0, Math.PI, false); ar.closePath(); s.holes.push(ar); }
    return extrude(s, WT, 0.0004);
  };
  const faces = { E: wall(0.0105, 0.03), S: wall(0.014, 0.04), N: wall(0.014, 0.04), W: wall(0, 0) };
  for (const [f, geo] of Object.entries(faces)) {
    const m = withEdges(part(g, geo, Y), 30);
    if (f === 'E') { m.rotation.set(0, -Math.PI / 2, 0); m.position.set(bot - WT, foot, 0); }
    if (f === 'W') { m.rotation.set(0, Math.PI / 2, 0); m.position.set(-bot + WT, foot, 0); }
    if (f === 'S') m.position.set(0, foot, bot - WT);
    if (f === 'N') { m.rotation.set(0, Math.PI, 0); m.position.set(0, foot, -bot + WT); }
    m.rotateX(-lean);
  }
  // Roof with the lever slot.
  part(g, box(top * 2, 0.003, top * 2), Y, 0, foot + bh, 0);
  part(g, box(top * 1.2, 0.0006, 0.007), DARK, -0.002, foot + bh + 0.0016, 0);
  // Bowl floor inside, with its small seat hole.
  part(g, lathe([[0.003, 0], [0.012, 0.002], [0.019, 0.008], [0.021, 0.012]], 32), plastic(0xe0a20c, { side: THREE.DoubleSide }), 0, foot + 0.002, 0);
  part(g, cyl(0.004, 0.004, 0.001, 16), DARK, 0, foot + 0.0026, 0);
  // Hood over the front arch, arrow on it, plunger face inside.
  const hood = withEdges(part(g, box(0.008, 0.007, 0.024), 0xffd23a, bot + 0.001, foot + 0.034, 0));
  hood.rotation.z = -0.25;
  part(g, box(0.0006, 0.004, 0.006), O, bot + 0.0052, foot + 0.035, 0).rotation.z = -0.25;
  part(g, box(0.004, 0.012, 0.018), 0xe6a50e, bot - 0.007, foot + 0.022, 0);
  // Lever: a long thick paddle, curving up toward its raised tail, pivot near the front;
  // a framed panel and two arrows moulded on top (IMG_0962/0963).
  const Lv = W * 1.75, wv = W * 0.55, yAt = (x) => 0.004 + 0.03 * ((W * 0.45 - x) / Lv) + 0.014 * ((W * 0.45 - x) / Lv) ** 2;
  const side = [];
  for (let i = 0; i <= 20; i++) { const x = W * 0.45 - (Lv * i) / 20; side.push([x, yAt(x)]); }
  for (let i = 20; i >= 0; i--) { const x = W * 0.45 - (Lv * i) / 20; side.push([x, yAt(x) - 0.0045]); }
  const lever = new THREE.Group(); lever.position.set(0, foot + bh, 0); g.add(lever);
  const lv = withEdges(part(lever, extrude(shape(side), wv, 0.0012), O), 35); lv.position.z = -wv / 2;
  const tilt = Math.atan(0.03 / Lv);
  const panel = part(lever, box(Lv * 0.55, 0.0012, wv * 0.6), 0xd96c12, W * 0.45 - Lv * 0.45, yAt(W * 0.45 - Lv * 0.45) + 0.0008, 0); panel.rotation.z = -tilt * 1.3;
  for (const f of [0.75, 0.88]) {
    const x = W * 0.45 - Lv * f, ar = part(lever, new THREE.ConeGeometry(0.0035, 0.006, 3), 0xb85410, x, yAt(x) + 0.0012, 0);
    ar.rotation.z = Math.PI / 2; ar.scale.y = 1; ar.rotation.x = -Math.PI / 2;
  }
  // Pivot bracket and pin.
  for (const s of [1, -1]) part(g, box(0.008, 0.012, 0.003), Y, W * 0.18, foot + bh + 0.004, s * 0.012);
  part(g, cyl(0.0024, 0.0024, 0.03, 12), 0xd9dde0, W * 0.18, foot + bh + 0.008, 0).rotation.x = Math.PI / 2;
  return g;
}

function launcher02() {
  // M-02 (uploads/M-02, lp manual p5, lp_plans_05): low dark-blue box two cells long. At
  // one end an open blue ring stands across the box with an orange tube rising out of
  // it, leaning back away from the button; at the other end an orange mushroom button
  // on a round collar.
  const g = new THREE.Group(), B = 0x1c3fb0, O = 0xf07f1e, h = S * 0.55;
  const body = shape([[-W / 2, 0], [W / 2, 0], [W / 2, h], [-W / 2, h]]);
  const bx = withEdges(part(g, extrude(body, C + W, 0.0015), B)); bx.position.z = -W / 2;
  // Ring at the tube end (z = 0 cell), open along x.
  const ring = new THREE.Shape(); ring.absarc(0, 0, 0.016, 0, Math.PI * 2, false);
  const rh = new THREE.Path(); rh.absarc(0, 0, 0.0115, 0, Math.PI * 2, true); ring.holes.push(rh);
  for (const s of [1, -1]) { const r = withEdges(part(g, extrude(ring, 0.006, 0.0006), B)); r.rotation.y = Math.PI / 2; r.position.set(s > 0 ? W * 0.3 : -W * 0.3 - 0.006, h + 0.012, 0); }
  part(g, new THREE.CylinderGeometry(0.0118, 0.0118, W * 0.6, 24, 1, true), plastic(B, { side: THREE.DoubleSide }), 0, h + 0.012, 0).rotation.z = Math.PI / 2;
  // Tube leaning back about 25 degrees, away from the button.
  const tube = new THREE.Group(); tube.position.set(0, h + 0.012, 0); tube.rotation.x = -0.44; g.add(tube);
  part(tube, new THREE.CylinderGeometry(0.0105, 0.0105, S * 1.25, 24, 1, true), plastic(O, { side: THREE.DoubleSide }), 0, S * 0.62, 0);
  part(tube, new THREE.TorusGeometry(0.0098, 0.0012, 8, 24), O, 0, S * 1.25, 0).rotation.x = Math.PI / 2;
  // Button end (z = +1 cell).
  part(g, cyl(0.012, 0.0135, 0.008, 24), B, 0, h + 0.004, C);
  part(g, cyl(0.009, 0.009, 0.014, 20), O, 0, h + 0.014, C);
  part(g, new THREE.SphereGeometry(0.0175, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), O, 0, h + 0.02, C).scale.y = 0.4;
  return g;
}

function hood() {
  // M-06 (lp manual p5, lp_plans_12): a yellow hollow hood. A narrow end sits on a
  // block; the curved roof flares wider and runs out over the launcher tube to a
  // broad open mouth. A row of slits on the roof, open underneath.
  // Flat vertical sides; the roof falls in a convex curve from the tall back over
  // the block to a low front edge well past it (lp manual p5, lp_plans_12).
  const g = new THREE.Group(), Y = 0xf7c600, L = C * 1.9, x0 = -W / 2, hb = S * 1.55, hf = S * 0.55, n = 20;
  const roofY = (u) => hf + (hb - hf) * Math.cos((u * Math.PI) / 2) ** 0.8;
  const side = [[x0, S * 0.45]];
  for (let i = 0; i <= n; i++) side.push([x0 + (L * i) / n, roofY(i / n)]);
  side.push([x0 + L, hf - S * 0.25], [x0 + W, S * 0.45]);
  const half = W * 0.56;
  for (const s of [1, -1]) { const m = withEdges(part(g, extrude(shape(side), 0.0025, 0.0004), Y), 30); m.position.z = s > 0 ? half - 0.0025 : -half; }
  const rp = line(n, (u) => new THREE.Vector3(x0 + L * u, roofY(u), 0)), pos = [], idx = [];
  rp.forEach((p) => { pos.push(p.x, p.y, -half, p.x, p.y, half); });
  for (let i = 0; i < n; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
  withEdges(part(g, geo, plastic(Y, { side: THREE.DoubleSide })), 20);
  part(g, box(0.0025, hb - S * 0.45, half * 2), Y, x0 + 0.0012, S * 0.45 + (hb - S * 0.45) / 2, 0);
  for (let i = 0; i < 4; i++) { const u = 0.25 + i * 0.16, sl = part(g, box(0.0016, 0.0012, 0.011), DARK, x0 + L * u, roofY(u) + 0.0009, -half * 0.45); sl.rotation.z = -0.5 * u; }
  blockFeet(g, Y, S * 0.45);
  return g;
}

function flagHolder() {
  // M-05 (uploads/M-05, lp manual p5, lp_plans_12): lime-green block-footed cup with a
  // round dished funnel, an entry notch over a tab loop on one face and a hole in the
  // middle, a small flap in the throat; on the back edge two hinge knuckles hold a thin
  // flagpole with a ball on top and a small pennant.
  const g = new THREE.Group(), G = 0x8fd13a, foot = S * 0.5, rim = foot + S * 0.4;
  blockFeet(g, G, foot);
  const top = (u, v) => { const r = Math.hypot(u, v); return Math.min(rim, foot + 0.004 + (rim - foot - 0.004) * Math.min(1, (r / (W * 0.5)) ** 1.6)); };
  for (const f of ['S', 'W', 'N']) { const m = withEdges(part(g, faceWall(() => rim - foot, 0.0001), G), 40); onFace(m, f); m.position.y = foot; }
  const fe = withEdges(part(g, faceWall((s) => (Math.abs(s) < 0.012 ? rim - foot - 0.012 : rim - foot), 0.0001), G), 40); onFace(fe, 'E'); fe.position.y = foot;
  part(g, heightField(-W / 2, W / 2, -W / 2, W / 2, 40, 40, top, (u, v) => u * u + v * v < 0.011 ** 2), plastic(G, { side: THREE.DoubleSide }));
  tabLoop(g, G, 'E').position.y = foot + 0.004;
  part(g, box(0.012, 0.002, 0.008), 0x6fb22a, 0.002, foot + 0.006, 0).rotation.z = 0.3;
  // Hinge on the W edge, pole standing up, pennant toward N.
  for (const s of [1, -1]) part(g, box(0.005, 0.006, 0.005), G, -W / 2 + 0.003, rim + 0.002, s * 0.008);
  part(g, cyl(0.0015, 0.0015, 0.022, 10), 0xd9dde0, -W / 2 + 0.003, rim + 0.003, 0).rotation.x = Math.PI / 2;
  const pole = new THREE.Group(); pole.position.set(-W / 2 + 0.003, rim + 0.003, 0); g.add(pole);
  part(pole, cyl(0.0022, 0.0022, S * 0.85, 10), G, 0, S * 0.43, 0);
  part(pole, new THREE.SphereGeometry(0.0042, 14, 10), G, 0, S * 0.87, 0);
  const pn = withEdges(part(pole, extrude(shape([[0, 0], [0.016, 0.002], [0.017, 0.013], [0, 0.015]]), 0.0015, 0.0003), 0x7cc236), 30);
  pn.rotation.y = Math.PI / 2; pn.position.set(0, S * 0.52, -0.002);
  return g;
}

function ramp(set) {
  // M-10: a smooth chute on a blue two-cell base like two fused blocks, carried on
  // posts, narrow and low at the entry, fanning wider and curving up to a jump lip
  // with a small round post at each lip corner. Launchpad green, T-Rex orange.
  const g = new THREE.Group(), trex = set === '5716', col = trex ? 0xf07f1e : 0x7ec62f, B = trex ? 0x1468b8 : 0x1c3fb0;
  // T-Rex (record frame, as its GLB): the base covers the two cells from the low port at
  // x 0, and the trough runs from there to the lip 2.35 cells on, at the lip's seat.
  const x0 = trex ? -mm(5) : -W / 2 - 0.004, L = trex ? C * 2.35 + mm(5) : C * 2.2, base = S * 0.62, bx = trex ? C / 2 : 0;
  for (let k = 0; k < 2; k++) { const f = new THREE.Group(); blockFeet(f, B, base); f.position.x = bx + C * k; g.add(f); }
  part(g, box(C + W, 0.004, W), B, bx + C / 2, base, 0);
  // Wide shallow trough, low tongue at the entry (x = -W/2), curving up along the
  // base. The far end is cut on a slant: the -z wall rises into a pointed fin with a
  // round hole; the +z wall ends lower in a curled lip resting on a post
  // (lp_plans_04 M-10 box, trex_plans_01 M-10, lp manual p5 M-11).
  const n = 30, pos = [], idx = [], cols = 14, rise = trex ? S * 1.18 - base - 0.006 : S * 0.95, hw = mm(16);
  const yAt = (u) => base + 0.006 + rise * u ** 2;
  for (let i = 0; i <= n; i++) {
    const u = i / n, x = x0 + u * L, y = yAt(u);
    for (let k = 0; k <= cols; k++) {
      const t = -1 + (2 * k) / cols, wall = mm(5) + (t < 0 ? mm(24) * Math.max(0, (u - 0.55) / 0.45) ** 1.5 : 0);
      pos.push(x, y + mm(5) * t * t + (Math.abs(t) > 0.85 ? wall * (Math.abs(t) - 0.85) / 0.15 : 0), t * hw);
    }
  }
  for (let i = 0; i < n; i++) for (let k = 0; k < cols; k++) { const a = i * (cols + 1) + k, b = a + 1, c = a + cols + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
  withEdges(part(g, geo, plastic(col, { side: THREE.DoubleSide })), 50);
  const xEnd = x0 + L, yEnd = yAt(1);
  part(g, new THREE.CircleGeometry(mm(3), 16), hole(), xEnd - mm(5), yEnd + mm(18), -hw - 0.0004).rotation.y = Math.PI;
  part(g, cyl(0.0024, 0.0024, yEnd - base, 10), col, xEnd - mm(10), base + (yEnd - base) / 2, hw * 0.8);
  part(g, cyl(0.0024, 0.0024, yAt(0.55) - base, 10), col, x0 + L * 0.55, base + (yAt(0.55) - base) / 2, -hw * 0.6);
  part(g, cyl(0.0024, 0.0024, yAt(0.55) - base, 10), col, x0 + L * 0.55, base + (yAt(0.55) - base) / 2, hw * 0.6);
  return g;
}

// Mirrors a finished group across its x = 0 plane in place: each part's transform is
// baked into its geometry and its triangles reversed so faces stay outward. The game
// batches models by baking matrices, so a negative scale would turn a model inside out.
function mirrorX(g) {
  g.updateMatrixWorld(true);
  const toG = new THREE.Matrix4().copy(g.matrixWorld).invert(), flip = new THREE.Matrix4().makeScale(-1, 1, 1);
  const items = [];
  g.traverse((o) => { if (o !== g && (o.isMesh || o.isLineSegments)) items.push([o, flip.clone().multiply(toG).multiply(o.matrixWorld)]); });
  for (const [o, m] of items) {
    const geo = o.geometry.clone().applyMatrix4(m);
    if (o.isMesh) {
      if (geo.index) { const a = geo.index.array; for (let k = 0; k < a.length; k += 3) [a[k + 1], a[k + 2]] = [a[k + 2], a[k + 1]]; }
      else for (const at of Object.values(geo.attributes)) {
        const n = at.itemSize, a = at.array;
        for (let k = 0; k < at.count; k += 3) for (let c = 0; c < n; c++) [a[(k + 1) * n + c], a[(k + 2) * n + c]] = [a[(k + 2) * n + c], a[(k + 1) * n + c]];
      }
    }
    o.geometry = geo;
    o.position.set(0, 0, 0); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1);
  }
  for (const [o] of items) if (o.isMesh) g.add(o);
  return g;
}

function ringRamp() {
  // M-11 (lp manual p5, lp_plans_05): the Launchpad ramp turned to face the jump, high
  // wide end toward the incoming marble, with an orange toothed ring standing across it
  // and a target disc hanging inside. In record axes, as the GLB: the ring at the high
  // end at x -1 (port ring, facing W, where the marble flies in), the trough falling to
  // the low end at x +1 (port low, E), the two-cell base centred on the origin. The
  // marble goes into the ring first, then down the slope (Joey 2026-11-09, image_06:
  // the old drawing had the ring at the low end's far side, so it read backwards).
  const g = ramp('5422'), O = 0xf07f1e, x = C * 1.41, y = S * 0.62 + 0.006 + S * 0.95 + 0.025;
  const ring = new THREE.Shape(); const n = 20, R = 0.034, r = 0.027;
  for (let i = 0; i <= n * 2; i++) { const a = (i / (n * 2)) * Math.PI * 2, rr = i % 2 ? R : R + 0.005; i ? ring.lineTo(rr * Math.cos(a), rr * Math.sin(a)) : ring.moveTo(rr, 0); }
  const hp = new THREE.Path(); hp.absarc(0, 0, r, 0, Math.PI * 2, true); ring.holes.push(hp);
  const m = withEdges(part(g, extrude(ring, 0.006, 0.0006), O)); m.rotation.y = Math.PI / 2; m.position.set(x, y, 0.003);
  const disc = part(g, cyl(0.022, 0.022, 0.003, 32), O, x, y - 0.002, 0); disc.rotation.z = Math.PI / 2;
  for (const [rr, c] of [[0.017, 0xffffff], [0.012, 0x3b8ee0], [0.007, 0xf7c600]]) { const t = part(g, cyl(rr, rr, 0.0034, 28), c, x, y - 0.002, 0); t.rotation.z = Math.PI / 2; }
  part(g, box(0.006, 0.03, 0.006), O, x, y - 0.034, 0);
  // ramp() builds the low end at -x with its base's first block at x 0: centre the base on
  // the origin, then mirror so the high end and ring sit at -x like the record.
  g.position.x = -C / 2;
  const out = new THREE.Group(); out.add(g);
  return mirrorX(out);
}

function paddles() {
  // M-12 (uploads/M-12, lp_plans_04): green three-cell chute with tall flat walls,
  // straight in plan: a steep drop from the high end, then a flat run-out. A bridge
  // across the walls at the bend carries an axle with four curved orange blades that
  // reach down into the channel.
  const g = new THREE.Group(), L = C * 3, G = 0x6fbb2f, bend = 0.5;
  const zAt = (u) => (u < bend ? -S * (1 - Math.cos((Math.PI * u) / bend)) / 2 : -S);
  const pts = line(60, (u) => ({ x: u * L, y: 0, z: zAt(u) }));
  g.add(trackModel(pts, G, { lap: 0, width: 0.0135, flat: true, depth: 0.016, rows: [0], slotLen: 0.05 }));
  const hx = L * bend, hz = -S + 0.03;
  for (const s of [1, -1]) part(g, box(0.006, 0.026, 0.004), G, hx, hz - 0.01, s * 0.016);
  part(g, box(0.008, 0.004, 0.036), G, hx, hz + 0.003, 0);
  const wheel = new THREE.Group(); wheel.position.set(hx, hz - 0.004, 0); g.add(wheel);
  part(wheel, cyl(0.006, 0.006, 0.02, 16), 0xf07f1e).rotation.x = Math.PI / 2;
  for (let k = 0; k < 4; k++) {
    const blade = new THREE.Shape(); blade.moveTo(0.004, -0.004); blade.quadraticCurveTo(0.02, -0.006, 0.03, 0.004); blade.lineTo(0.026, 0.008); blade.quadraticCurveTo(0.016, 0.002, 0.004, 0.004); blade.closePath();
    const b = withEdges(part(wheel, extrude(blade, 0.016, 0.0006), 0xf07f1e), 40); b.position.z = -0.008; b.rotation.z = (k * Math.PI) / 2;
  }
  wheel.userData.animate = (t) => { wheel.rotation.z = -t * 1.2; };
  return g;
}

function openTower(set) {
  // M-04 (uploads/M-04, trex_plans_01, lp manual p5): orange open-frame tower two slots
  // tall on arched block feet. Top tier: a dished cup with a U notch on every side and a
  // hole in the middle. Bottom tier: a cup with exits on two opposite sides (E, W).
  // T-Rex: a T-shaped flap on a pivot in the bottom tier tips the marble left, then
  // right; crown points on top. Launchpad: a fixed ridge splits marbles at random;
  // small corner pegs on top. Tier heights follow the record's ports (z 0.68 and 1.68).
  const g = new THREE.Group(), O = 0xf07f1e, trex = set !== '5422', H = S * 2;
  blockFeet(g, O, S * 0.36);
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    withEdges(part(g, box(0.007, H - S * 0.36, 0.007), O, (x * W) / 2 - x * 0.0035, S * 0.36 + (H - S * 0.36) / 2, (z * W) / 2 - z * 0.0035));
    if (trex) { const tip = part(g, new THREE.ConeGeometry(0.0045, 0.014, 4), O, (x * W) / 2 - x * 0.0035, H + 0.007, (z * W) / 2 - z * 0.0035); tip.rotation.y = Math.PI / 4; }
    else part(g, cyl(0.0014, 0.0016, 0.004, 10), O, (x * W) / 2 - x * 0.0035, H + 0.002, (z * W) / 2 - z * 0.0035);
  }
  // A tier: a dished plate at seat height y0 with low parapets; U notches on `open` faces.
  const tier = (y0, open, cut) => {
    // A two-way tier dips only across (v), so one strip spans it.
    const d = S * 0.16, fn = (u, v) => y0 + d * Math.min(1, (open.length === 4 ? Math.hypot(u, v) / (W / 2) : Math.abs(v) / (W / 2)) ** 2);
    part(g, heightField(-W / 2 + 0.002, W / 2 - 0.002, -W / 2 + 0.002, W / 2 - 0.002, open.length === 4 ? 36 : 1, 36, fn, cut), plastic(O, { side: THREE.DoubleSide }));
    for (const f of ['E', 'S', 'W', 'N']) {
      const isOpen = open.includes(f), ht = S * 0.3;
      const r = 0.0115, notch = (s) => (isOpen && Math.abs(s) < r ? ht - ht * 0.8 * Math.sqrt(1 - (s / r) ** 2) : ht);
      const m = withEdges(part(g, faceWall(notch, 0.0001), O), 40);
      onFace(m, f); m.position.y = y0 - S * 0.06;
    }
  };
  tier(S * 0.68, ['E', 'W']);
  tier(S * 1.68, ['E', 'S', 'W', 'N'], (u, v) => u * u + v * v < 0.0105 ** 2);
  // Top frame ring.
  for (const f of ['E', 'S', 'W', 'N']) { const b = part(g, box(W, 0.004, 0.005), O); onFace(b, f, W, -0.0025); b.position.y = H - 0.002; }
  if (trex) {
    // The pivoting T flap, tipped toward W (it flips each marble).
    const flap = new THREE.Group(); flap.position.set(0, S * 0.68 + 0.002, 0); g.add(flap);
    part(flap, box(0.003, 0.017, 0.012), 0xe8701a, 0, 0.0085, 0);
    part(flap, box(0.026, 0.003, 0.014), 0xe8701a, 0, 0.0175, 0);
    part(g, cyl(0.0016, 0.0016, W * 0.9, 8), 0xd9dde0, 0, S * 0.68 + 0.004, 0).rotation.x = Math.PI / 2;
    flap.rotation.z = 0.35;
    flap.userData.animate = (t) => { flap.rotation.z = Math.sin(t * 1.6) > 0 ? 0.35 : -0.35; };
  } else {
    // Fixed ridge across the bottom tier, N to S: a coin toss which side the marble rolls off.
    const r = part(g, new THREE.CylinderGeometry(0.0001, 0.008, 0.008, 3, 1), O, 0, S * 0.68 + 0.006, 0);
    r.scale.set(1, 1, 3.2); r.rotation.y = Math.PI / 2; r.rotation.x = 0;
  }
  return g;
}

function tray(color = 0xc98a3a) {
  // M-07 (pieces/IMG_0956, trex_plans_01, lp manual p5; Joey 2026-11-09 image_02): a flat
  // tray with LOW side walls and two long slots in its floor, lying between two blocks 3
  // cells apart: the record's ports at x -1 and +1 are the block faces. Its floor's underside
  // rests on the plate frames (3 mm up, the record's restHeightMm); at each end the floor
  // sweeps steeply up to the cup seat and a short U lip reaches 9 mm past the face, lying
  // ON the block's cup end; two small hooks hang in the gap at the face. Nothing goes into
  // the block or the floor.
  const g = new THREE.Group(), hw = mm(23), T = mm(2.2), base = mm(3), seat = S * (1 - 0.32), ramp = mm(20), lip = mm(9), uw = mm(25);
  const mat = plastic(color, { side: THREE.DoubleSide }), side = mm(11), top = seat + mm(9);
  const sm = (u) => u * u * (3 - 2 * u);
  const fy = (x) => base + T + (seat - base - T) * sm(Math.min(1, Math.max(0, Math.abs(x) - (C - ramp)) / ramp));
  const slot = (x, z) => Math.abs(z) < 0.0016 && ((x > -C * 0.68 && x < -C * 0.06) || (x > C * 0.06 && x < C * 0.68));
  withEdges(part(g, heightField(-C, C, -hw, hw, 80, 16, (x) => fy(x), slot), mat), 50);
  // Side walls: from the floor's underside, low in the middle, up past the seat at the ends.
  const prof = [];
  for (let k = 0; k <= 40; k++) { const x = -C + (2 * C * k) / 40; prof.push([x, fy(x) - T + 0.0003]); } // over the extrude's bevel
  prof.push([C, top], [C - ramp, base + T + side], [-C + ramp, base + T + side], [-C, top]);
  for (const s of [1, -1]) { const w = withEdges(part(g, extrude(shape(prof), T, 0.0003), color), 40); w.position.z = s > 0 ? hw - T : -hw; }
  // End walls at the faces with a U notch down to the seat; the lip on the cup end; hooks.
  const end = new THREE.Shape();
  end.moveTo(-hw, seat - T); end.lineTo(hw, seat - T); end.lineTo(hw, top); end.lineTo(uw / 2, top); end.lineTo(uw / 2, seat);
  end.lineTo(-uw / 2, seat); end.lineTo(-uw / 2, top); end.lineTo(-hw, top); end.closePath();
  for (const s of [1, -1]) {
    const e = withEdges(part(g, extrude(end, T, 0.0003), color), 40); e.rotation.y = Math.PI / 2; e.position.x = s > 0 ? C - T : -C;
    part(g, box(lip, T, uw + 2 * T), color, s * (C + lip / 2), seat - T / 2, 0);
    for (const z of [1, -1]) part(g, box(lip, mm(5), T), color, s * (C + lip / 2), seat + mm(2.5), z * (uw / 2 + T / 2));
    for (const z of [1, -1]) part(g, box(mm(1), mm(6), mm(3)), color, s * (C + mm(0.65)), seat - T - mm(3), z * mm(9));
  }
  return g;
}

function truck() {
  // M-28 (trex_plans_01, uploads/M-28): red launcher shaped like a little truck: a long
  // body, a white dome closing the cab in the middle, a rounded window in each side (the
  // two entries) at the muzzle's level, an open-topped channel at the front on the
  // plunger axis (the exit), a ribbed white knob out the back. White arched leg caps at
  // record x -1 and +1 stand on the tops of two stacks; the body rests on them (Joey
  // 2026-11-09: it sat in the air with its back feet over the empty middle cell).
  const g = new THREE.Group(), R = 0xe0262c, Wt = 0xf6f6f2, h0 = mm(20);
  // The muzzle channel and the side windows share one level: seat 0.68 slot over the stand tops.
  const seat = S * (1 - 0.32), ap = mm(25);
  const nose = withEdges(part(g, extrude(shape([[-C * 1.76, 0], [-C * 0.36, 0], [-C * 0.36, seat - h0 - mm(1)], [-C * 1.76, seat - h0 - mm(1)]]), W * 0.94, 0.002), R)); nose.position.set(0, h0, -W * 0.47);
  // The cab with the window tunnel through it, side to side: a round top over a square
  // bottom whose sill is the seat. The extrude's bevel closes a hole by its size, so the
  // cut is that much wider.
  const cabShape = shape([[-C * 0.36, 0], [C * 0.5, 0], [C * 0.5, seat - h0 + mm(49)], [C * 0.32, seat - h0 + mm(55)], [-C * 0.36, seat - h0 + mm(55)]]);
  const wr = ap / 2 + 0.003, wx = C * 0.05, wy = seat - h0 + ap / 2, win = new THREE.Path();
  win.moveTo(wx - wr, wy); win.lineTo(wx - wr, wy - wr); win.lineTo(wx + wr, wy - wr); win.lineTo(wx + wr, wy); win.absarc(wx, wy, wr, 0, Math.PI, false); cabShape.holes.push(win);
  const cab = withEdges(part(g, extrude(cabShape, W, 0.003), R)); cab.position.set(0, h0, -W / 2);
  const tail = withEdges(part(g, extrude(shape([[C * 0.5, 0], [C * 1.92, 0], [C * 1.92, seat - h0 + mm(26)], [C * 0.5, seat - h0 + mm(34)]]), W * 0.88, 0.002), R)); tail.position.set(0, h0, -W * 0.44);
  const chPts = line(10, (u) => ({ x: -C * 1.78 + u * C * 1.42, y: 0, z: seat + 0.001 }));
  g.add(trackModel(chPts, R, { lap: 0, width: W * 0.43, flat: true, slots: false, depth: mm(10) }));
  part(g, new THREE.SphereGeometry(mm(17), 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), Wt, C * 0.05, seat + mm(54), 0).scale.set(1.3, 0.8, 1);
  for (const z of [1, -1]) {
    part(g, new THREE.TorusGeometry(ap / 2 + 0.0014, 0.0014, 8, 24), R, C * 0.05, seat + ap / 2, z * (W / 2 + 0.004)).rotation.y = z < 0 ? Math.PI : 0;
  }
  const kz = seat + mm(12), k = part(g, cyl(mm(8.5), mm(8.5), mm(14), 20), 0xd9dbd6, C * 1.92 + mm(7), kz, 0); k.rotation.z = Math.PI / 2;
  for (let i = 0; i < 5; i++) part(g, new THREE.TorusGeometry(mm(8.8), 0.0008, 6, 20), 0xb9bbb6, C * 1.92 + mm(1.5 + i * 2.8), kz, 0).rotation.y = Math.PI / 2;
  // White arched leg caps, open underneath: the walls stand on the stack's top (y 0)
  // and the cap's roof carries the body at h0.
  for (const x of [-C, C]) {
    part(g, box(C * 0.9, mm(3), W * 0.98), Wt, x, h0 - mm(1.5), 0);
    for (const z of [1, -1]) part(g, box(C * 0.9, h0, mm(2.4)), Wt, x, h0 / 2, z * (W * 0.49 - mm(1.2)));
    for (const dx of [1, -1]) part(g, box(mm(2.4), h0, W * 0.98), Wt, x + dx * (C * 0.45 - mm(1.2)), h0 / 2, 0);
  }
  return g;
}

// M-56 drawn between two points in record axes (x E, y S, z up), the marble's lowest
// point at each end: the strip's underside rides a marble's diameter plus the record's
// hang lift (5 mm) above them, and a hoop at each end, axis along the travel and 30 mm
// open (the ports' apertureMm), rings the cup end so the marble passes through it.
export function hangingBeam(a, b, color = 0xf2a81d) {
  const g = new THREE.Group(), lift = mm(20 + 5), ri = mm(15), tube = mm(2);
  const pa = new THREE.Vector3(a.x, a.z + lift, a.y), pb = new THREE.Vector3(b.x, b.z + lift, b.y);
  const len = pa.distanceTo(pb) + mm(6), mid = pa.clone().add(pb).multiplyScalar(0.5), dir = pb.clone().sub(pa).normalize();
  const beam = new THREE.Group(); beam.position.copy(mid); g.add(beam);
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
  const amber = plastic(color, { transmission: 0.25, transparent: true, opacity: 0.85 });
  withEdges(part(beam, box(len, 0.003, mm(16)), amber, 0, mm(19), 0));
  withEdges(part(beam, box(len, mm(15), 0.003), amber, 0, mm(10), 0));
  part(beam, box(len, 0.002, mm(11)), amber, 0, mm(2.5), 0);
  part(beam, box(len * 0.97, 0.0018, mm(7)), 0x2a2d31, 0, mm(0.9), 0);
  // Hoops just outside each block face (2.5 mm into the gap), centred on the marble at
  // the cup seat, with the buckle from the hoop's top up to the beam.
  const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize();
  for (const [p, s] of [[a, 1], [b, -1]]) {
    const cx = p.x + flat.x * s * mm(2.5), cz = p.y + flat.z * s * mm(2.5), cy = p.z + mm(10);
    const ring = part(g, new THREE.TorusGeometry(ri + tube, tube, 10, 32), amber, cx, cy, cz);
    ring.rotation.y = Math.atan2(flat.x, flat.z);
    const top = p.z + lift + mm(20), bottom = cy + ri + 2 * tube;
    withEdges(part(g, box(mm(8), top - bottom, mm(16)), amber, cx, (top + bottom) / 2, cz)).rotation.y = -Math.atan2(flat.z, flat.x);
  }
  return g;
}

function bridge() {
  // M-56 (uploads/M-56, trex_plans_01, trex_plans_02): straight see-through amber beam
  // between blocks three cells apart, sloping down one slot; a black magnet strip
  // underneath, hoops at both ends. A metal marble is shown hanging under it.
  // Ends where the engine puts them (the GLB's frame): the block faces at x 0.5 and 2.5,
  // the marble's lowest point at the ports' heights, 0 and -1 slot.
  const g = hangingBeam({ x: C * 0.5, y: 0, z: 0 }, { x: C * 2.5, y: 0, z: -S });
  const m = part(g, new THREE.SphereGeometry(0.0095, 20, 14), new THREE.MeshPhysicalMaterial({ color: 0xc9ced3, metalness: 0.9, roughness: 0.2 }), C * 1.5, -S * 0.5 + mm(5) + 0.0095, 0);
  void m;
  return g;
}

function legPart(mirror) {
  // M-57 / M-59 (trex_plans_01 and its insets): a grey foot base with two arches,
  // orange ribbed toes at the front, and a rounded green thigh rising behind with a
  // hip buckle; M-59 has a ring hole in the hip.
  const g = new THREE.Group(), Gr = 0xa9adb2, G = 0x2fa34a, L = C * 1.9;
  const foot = new THREE.Group(); g.add(foot);
  for (const k of [0, 1]) { const f = new THREE.Group(); blockFeet(f, Gr, S * 0.38, W); f.position.x = C * (k - 0.5); foot.add(f); }
  part(g, box(L, 0.004, W), Gr, 0, S * 0.38, 0);
  for (let i = 0; i < 4; i++) {
    const t = withEdges(part(g, cyl(mm(5), mm(6), mm(26), 12), 0xf07f1e, C * 0.15 + i * mm(9), S * 0.38 + mm(6), 0), 40);
    t.rotation.x = Math.PI / 2; t.rotation.z = 0.25;
  }
  const th = new THREE.Shape(); th.moveTo(-mm(20), 0); th.lineTo(mm(18), 0); th.lineTo(mm(18), mm(55)); th.absarc(0, mm(55), mm(18), 0, Math.PI, false); th.lineTo(-mm(20), mm(30)); th.closePath();
  const thigh = withEdges(part(g, extrude(th, W * 0.8, 0.004), G), 35); thigh.position.set(-C * 0.35, S * 0.38, -W * 0.4);
  const hip = part(g, cyl(mm(10), mm(10), mm(6), 24), mirror ? 0xf6f6f2 : 0x247f3a, -C * 0.35, S * 0.38 + mm(55), -W * 0.4 - mm(3)); hip.rotation.x = Math.PI / 2;
  if (mirror) part(g, cyl(mm(6), mm(6), mm(7), 20), hole(), -C * 0.35, S * 0.38 + mm(55), -W * 0.4 - mm(3)).rotation.x = Math.PI / 2;
  return g;
}

function dinoBody() {
  // M-58 (trex_plans_01, trex_plans_02): T-Rex body without legs. Blocky head on a
  // hinge, open toothy mouth facing -x with a square hole on top, eyes; a barrel
  // body; a brown channel down the back between orange spikes; a long flat sawtooth
  // tail running to +x as the exit ramp.
  const g = new THREE.Group(), y = S * 2.6, G = 0x35b25a, D = 0x1f8a42, T = 0x2b9c4c;
  const torso = withEdges(part(g, cyl(C * 0.85, C * 0.95, C * 2.0, 8), G, C * 0.2, y, 0, { flatShading: true }), 25); torso.rotation.z = Math.PI / 2;
  const head = new THREE.Group(); head.position.set(-C * 0.9, y + S * 0.45, 0); g.add(head);
  withEdges(part(head, box(C * 1.9, S * 0.95, C * 1.55), G, -C * 0.65, S * 0.55, 0), 30);
  withEdges(part(head, box(C * 1.9, S * 0.35, C * 1.5), D, -C * 0.7, -S * 0.42, 0), 30);
  part(head, box(C * 0.7, 0.0015, C * 0.62), hole(0x114a24), -C * 0.45, S * 1.03, 0);
  part(head, box(0.002, S * 0.42, C * 1.25), hole(0x114a24), -C * 1.61, -S * 0.08, 0);
  for (let i = 0; i < 6; i++) for (const z of [1, -1]) { const t = part(head, new THREE.ConeGeometry(0.005, 0.012, 4), 0xf6f6f2, -C * (0.2 + i * 0.25), 0.004, (z * C) / 1.35); t.rotation.x = Math.PI; }
  for (let i = 0; i < 6; i++) for (const z of [1, -1]) part(head, new THREE.ConeGeometry(0.005, 0.012, 4), 0xf6f6f2, -C * (0.2 + i * 0.25), -S * 0.22, (z * C) / 1.35);
  for (const z of [1, -1]) { part(head, new THREE.SphereGeometry(0.008, 14, 10), 0xfff4a8, -C * 1.0, S * 0.75, (z * C) / 1.26); part(head, new THREE.SphereGeometry(0.0035, 10, 8), 0x101010, -C * 1.05, S * 0.76, (z * C) / 1.2); }
  // Back channel between spikes.
  const pts = line(16, (u) => ({ x: -C * 0.4 + u * C * 2.0, y: 0, z: y + C * 0.95 - u * S * 0.4 }));
  g.add(trackModel(pts, 0x7a4a2b, { lap: 0, width: 0.011, flat: true, slots: false }));
  for (let i = 0; i < 5; i++) for (const z of [1, -1]) part(g, new THREE.ConeGeometry(0.009, 0.02, 4), 0xf07f1e, -C * 0.25 + i * C * 0.42, y + C * 0.95 - i * S * 0.08, z * 0.019);
  // Tail: a flat sawtooth ramp.
  const tail = new THREE.Shape(); tail.moveTo(0, 0.016);
  for (let i = 0; i < 7; i++) { tail.lineTo(i * 0.024 + 0.012, 0.03 - i * 0.003); tail.lineTo((i + 1) * 0.024, 0.016 - i * 0.002); }
  tail.lineTo(0.18, -0.002); tail.lineTo(0, -0.02); tail.closePath();
  const tl = withEdges(part(g, extrude(tail, 0.014, 0.001), T)); tl.position.set(C * 1.1, y - S * 0.1, -0.007); tl.rotation.z = -0.32;
  // Belly panel: speaker grille and button.
  part(g, cyl(0.012, 0.012, 0.002, 20), 0xf7c600, C * 0.2, y - C * 0.6, C * 0.86).rotation.x = Math.PI / 2;
  // Hip sockets.
  for (const z of [1, -1]) part(g, cyl(mm(11), mm(11), mm(5), 20), D, C * 0.4, y - S * 0.2, z * C * 0.95).rotation.x = Math.PI / 2;
  return g;
}

function elevator() {
  // M-61 (pieces/IMG_0954/0955, trex_plans_01): black battery base on four short legs,
  // an orange tray at the front foot, a faceted orange tower, a black head on top with
  // a groove. Three yellow arms on axles out of the tower's front face, each with a
  // C scoop at both ends, turn like wheels, neighbours the opposite way. The lowest
  // arm's scoop dips into the tray and picks up a marble, half a turn carries it to
  // the top, where it rolls into the next arm's scoop, coming round at the bottom of
  // its own turn; the top arm tips it into the head. Each arm spans the gap between
  // its neighbours, so the scoops meet. userData.animate(t) turns them.
  const g = new THREE.Group(), O = 0xd2691e, Yc = 0xf7bb12, Bk = 0x2d3035, s = S, tw = C * 0.85, top = s * 6.9;
  withEdges(part(g, box(C * 1.95, s * 0.75, C * 1.0), Bk, C * 0.45, s * 0.45, 0));
  for (const x of [-0.42, 1.32]) for (const z of [0.38, -0.38]) part(g, box(0.008, s * 0.12, 0.008), Bk, C * x, s * 0.06, C * z);
  part(g, new THREE.SphereGeometry(0.014, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), Bk, -C * 0.05, s * 0.82, C * 0.22);
  part(g, box(0.006, 0.003, 0.012), 0x9aa0a6, C * 1.4, s * 0.5, C * 0.5 + 0.001);
  for (let i = 0; i < 4; i++) {
    const y0 = s * 0.82 + i * s * 1.52;
    withEdges(part(g, cyl(tw * 0.6, tw * 0.66, s * 1.36, 6), O, 0, y0 + s * 0.68, 0, { flatShading: true }), 25).rotation.y = Math.PI / 6;
    withEdges(part(g, cyl(tw * 0.69, tw * 0.69, s * 0.16, 6), 0xe07a28, 0, y0 + s * 1.44, 0, { flatShading: true }), 25).rotation.y = Math.PI / 6;
  }
  withEdges(part(g, box(C * 1.35, s * 0.55, C * 0.95), Bk, C * 0.2, top + s * 0.28, 0));
  for (const z of [1, -1]) part(g, new THREE.SphereGeometry(mm(11), 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), hole(0x15171a), C * 0.35, top + s * 0.57, z * mm(12));
  // Front tray: a scoop-shaped bowl, high at the front, sloping back to the tower foot.
  const trayM = part(g, lathe([[0.002, 0], [0.026, 0.003], [0.036, 0.012], [0.04, 0.024]], 32), plastic(0xf07f1e, { side: THREE.DoubleSide }), C * 1.0, s * 0.82, 0);
  trayM.scale.set(1, 1, 0.95);
  // Wheels: pivots spaced one arm length apart, from just above the tray to the head.
  const R = (top - s * 1.0) / 6, y0 = s * 1.0 + R, xa = tw * 0.62 + mm(7);
  const scoopCup = () => {
    const c = new THREE.Group();
    const sc = part(c, new THREE.CylinderGeometry(mm(13), mm(13), mm(24), 24, 1, true, 0, Math.PI * 1.3), plastic(Yc, { side: THREE.DoubleSide }));
    sc.rotation.z = Math.PI / 2; sc.rotation.x = -Math.PI * 0.15;
    for (const k of [1, -1]) part(c, new THREE.CircleGeometry(mm(13), 24, 0, Math.PI * 1.3), plastic(Yc, { side: THREE.DoubleSide }), k * mm(12), 0, 0).rotation.set(-Math.PI * 0.15, Math.PI / 2, Math.PI / 2);
    part(c, box(mm(1), mm(10), mm(8)), 0xe06a1a, mm(12.6), -mm(6), 0);
    return c;
  };
  const wheels = [];
  for (let i = 0; i < 3; i++) {
    const y = y0 + i * 2 * R, w = new THREE.Group(); w.position.set(xa, y, 0); g.add(w); wheels.push(w);
    withEdges(part(w, box(mm(6), mm(7), R * 2 - mm(16)), Yc));
    part(w, cyl(mm(5), mm(5), mm(8), 16), Yc).rotation.z = Math.PI / 2;
    for (const z of [1, -1]) { const c = scoopCup(); c.position.z = z * (R - mm(4)); if (z < 0) c.rotation.x = Math.PI; w.add(c); }
    part(g, cyl(mm(3.5), mm(3.5), xa - tw * 0.5, 12), 0xf07f1e, (xa + tw * 0.5) / 2, y, 0).rotation.z = Math.PI / 2;
  }
  // A demonstration marble the scoops carry up (the library shows it, the game hides it).
  const ball = part(g, new THREE.SphereGeometry(0.0095, 20, 14), plastic(0x3b8ee0, { roughness: 0.12, clearcoat: 1 }));
  ball.userData.demo = true;
  const T = 1.6; // seconds per half turn
  g.userData.animate = (t) => {
    const k = t / T, c = ((k % 4) + 4) % 4; // 0..0.5 tray, 0.5..3.5 three wheels, 3.5..4 head
    // Arm i's scoop that starts at the bottom when stage i begins: angle from +z.
    const ang = (i, kk) => -Math.PI / 2 + (i % 2 ? -1 : 1) * Math.PI * (kk - 0.5 - i);
    wheels.forEach((w, i) => { w.rotation.x = -ang(i, c); });
    if (c < 0.5) { const u = c / 0.5; ball.position.set(C * 1.25 - (C * 1.25 - xa) * u, s * 0.86 + 0.0095 + (y0 - R - s * 0.86) * u * u, 0); return; }
    if (c >= 3.5) { const u = (c - 3.5) / 0.5; ball.position.set(xa - (xa - C * 0.35) * u, top + s * 0.1 + 0.0095 * (1 - u), mm(12) * u); return; }
    const i = Math.floor(c - 0.5), a = ang(i, c);
    ball.position.set(xa, y0 + i * 2 * R + (R - mm(4)) * Math.sin(a) + 0.006, (R - mm(4)) * Math.cos(a));
  };
  g.userData.animate(0);
  return g;
}

function liftPole() {
  // M-60 (trex_plans_01, IMG_0960 background): brown knobbly pole with a spiral
  // groove on an L-shaped brown base two cells long; a flat cap on top with a sign
  // slot; a green slider clamp with grips and a cup that rides up the pole.
  const g = new THREE.Group(), h = S * 7.4, B = 0x7a4a2b;
  const base = new THREE.Group(); g.add(base);
  for (const k of [0, 1]) { const f = new THREE.Group(); blockFeet(f, B, S * 0.5); f.position.z = C * k; base.add(f); }
  part(g, box(W, 0.004, C + W), B, 0, S * 0.5, C / 2);
  withEdges(part(g, box(W, S * 0.5, W * 0.4), B, 0, S * 0.75, C + W * 0.3));
  part(g, cyl(mm(11), mm(12.5), h, 18), B, 0, S * 0.5 + h / 2, C, { flatShading: true });
  const curve = line(120, (u) => { const a = u * 26; return new THREE.Vector3(Math.cos(a) * mm(12), S * 0.5 + u * h, C + Math.sin(a) * mm(12)); });
  part(g, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(curve), 300, 0.0016, 6), 0x5a341c);
  withEdges(part(g, box(C * 1.1, S * 0.45, C * 0.95), 0x8a5230, 0, S * 0.5 + h + S * 0.2, C));
  part(g, box(C * 0.6, 0.002, 0.004), hole(0x3a2010), 0, S * 0.5 + h + S * 0.43, C);
  const cl = new THREE.Group(); cl.position.set(0, S * 4.6, C); g.add(cl);
  withEdges(part(cl, cyl(mm(19), mm(19), S * 0.5, 16), 0x6fbb2f));
  for (const s of [1, -1]) withEdges(part(cl, box(mm(10), S * 0.4, mm(12)), 0x5aa526, s * mm(22), 0, 0));
  const cup = part(cl, new THREE.SphereGeometry(mm(13), 18, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), plastic(0x6fbb2f, { side: THREE.DoubleSide }), 0, 0, -mm(28)); void cup;
  return g;
}

function rocket() {
  // M-13 (IMG_0952/0953, lp_plans_11): electronic rocket that stands on one block.
  // Egg-shaped red body, white nose dome with vents, white skirt with four fins,
  // red-and-white chequer low on the front, white round button high on the side with
  // a yellow slider below. Two round ports low on opposite sides (W and E), at a
  // block-cup height above its own foot, through which marbles pass.
  const g = new THREE.Group(), H = mm(205), R = mm(40);
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const x = c.getContext('2d'); x.fillStyle = '#d3161d'; x.fillRect(0, 0, 256, 128); x.fillStyle = '#fff';
  for (let i = 0; i < 16; i++) for (let j = 0; j < 4; j++) if ((i + j) % 2 && i > 3 && i < 12) x.fillRect(i * 16, 64 + j * 16, 16, 16);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const L = (pts, mat) => { const m = new THREE.Mesh(lathe(pts.map(([r, v]) => [r, v * H]), 48), mat); m.castShadow = true; g.add(m); return m; };
  L([[R * 0.62, 0.07], [R * 0.86, 0.14], [R * 0.97, 0.25], [R, 0.36]], new THREE.MeshPhysicalMaterial({ map: tex, roughness: 0.3, clearcoat: 0.7, side: THREE.DoubleSide }));
  L([[R, 0.36], [R * 1.0, 0.48], [R * 0.95, 0.6], [R * 0.84, 0.7]], plastic(0xd3161d, { side: THREE.DoubleSide }));
  L([[R * 0.84, 0.7], [R * 0.7, 0.8], [R * 0.48, 0.9], [R * 0.24, 0.97], [0.001, 1]], plastic(0xe6eaec, { side: THREE.DoubleSide }));
  L([[R * 0.6, 0], [R * 0.66, 0], [R * 0.68, 0.06], [R * 0.6, 0.075]], plastic(0xfafafa, { side: THREE.DoubleSide }));
  for (let i = 0; i < 4; i++) {
    const s = new THREE.Shape(); s.moveTo(0, 0); s.lineTo(mm(16), 0); s.quadraticCurveTo(mm(20), mm(22), mm(4), mm(48)); s.closePath();
    const holder = new THREE.Group(); holder.rotation.y = Math.PI / 4 + (i * Math.PI) / 2; g.add(holder);
    part(holder, extrude(s, mm(6), 0.001), 0xfafafa, R * 0.6, 0.002, -mm(3));
  }
  for (let i = 0; i < 3; i++) { const v = part(g, box(mm(12), mm(2), mm(3)), 0x8b9297, 0, H * (0.9 - i * 0.03), 0); v.position.z = R * 0.42 - i * mm(3); v.position.y = H * 0.9 - i * mm(4); v.rotation.x = -0.6; }
  const portY = S * 0.68;
  for (const sx of [1, -1]) {
    const port = new THREE.Mesh(new THREE.CircleGeometry(mm(12), 28), hole(0x5e070b));
    port.position.set(sx * R * 0.82, portY, 0); port.rotation.y = (sx * Math.PI) / 2; g.add(port);
    const rim = part(g, new THREE.TorusGeometry(mm(12), mm(1.6), 10, 28), 0xd3161d, sx * R * 0.8, portY, 0); rim.rotation.y = Math.PI / 2;
  }
  const btn = part(g, cyl(mm(13), mm(13), mm(6), 28), 0xf3f6f7, R * 0.45, H * 0.6, R * 0.88); btn.rotation.x = Math.PI / 2; btn.rotation.z = -0.45;
  part(g, new THREE.TorusGeometry(mm(14), mm(2), 10, 28), 0xd3161d, R * 0.45, H * 0.6, R * 0.86).rotation.y = 0.45;
  part(g, box(mm(8), mm(10), mm(4)), 0xf7c600, R * 0.5, H * 0.43, R * 0.86).rotation.y = 0.45;
  return g;
}

const MODELS = {
  'M-01': pusher, 'M-02': launcher02, 'M-05': flagHolder, 'M-06': hood, 'M-11': ringRamp, 'M-12': paddles, 'M-13': rocket, 'M-14': funnel,
  'M-28': truck, 'M-56': bridge, 'M-57': () => legPart(false), 'M-58': dinoBody, 'M-59': () => legPart(true), 'M-60': liftPole, 'M-61': elevator,
};

// ---------------------------------------------------------------- Blender models
// models/<name>.glb, built by tools/blender (docs/blender_models.md), in the record frame.
// Materials are colour slots: body takes the set colour, shade a darker body, hole and
// metal are fixed, c_rrggbb is that colour. Port empties (port_<id>) and the engine path
// the model was swept along (marble_path, record axes) come along as userData.
// A GLB with an animation (moving parts kept as their own nodes: scoop arms, a jaw, a
// flap) plays it by time through userData.animate, which the library and the game call.
const GLB = new Map(), CLIPS = new Map();

export async function loadModels(base = '') {
  try {
    const { GLTFLoader } = await import('../../vendor/GLTFLoader.js');
    const loader = new GLTFLoader();
    const names = await fetch(`${base}models/index.json`).then((r) => (r.ok ? r.json() : []));
    await Promise.all(names.map(async (name) => {
      try {
        const gl = await loader.loadAsync(`${base}models/${name}.glb`);
        GLB.set(name, gl.scene);
        if (gl.animations?.length) CLIPS.set(name, gl.animations);
      } catch (e) { console.warn(`model ${name}:`, e.message); }
    }));
  } catch (e) { console.warn('Blender models not loaded, using the code models:', e.message); }
  return [...GLB.keys()];
}

const glbName = (code, set) => (set && GLB.has(`${code}__${set}`) ? `${code}__${set}` : GLB.has(code) ? code : null);
export const isBlenderModel = (code, set = null) => glbName(code, set) !== null;

const slotMaterial = (name, color) => {
  if (name === 'body') return plastic(hex(color));
  if (name === 'shade') return plastic(hex(color).multiplyScalar(0.6));
  if (name === 'hole') return new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.9 });
  if (name === 'metal') return new THREE.MeshPhysicalMaterial({ color: 0xc9ced3, metalness: 0.9, roughness: 0.2 });
  // Clear plastic (the M-14 funnel): see-through, so the game draws it on its own.
  if (name === 'glass') return new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.05, transparent: true, opacity: 0.32, side: THREE.DoubleSide, clearcoat: 1, envMapIntensity: 1.6, depthWrite: false });
  if (/^c_[0-9a-f]{6}$/i.test(name)) return plastic(hex(`#${name.slice(2)}`));
  return plastic(hex(color));
};

function fromGlb(name, color) {
  const g = GLB.get(name).clone(), mats = new Map(), ports = {};
  g.traverse((o) => {
    if (o.isMesh) {
      const key = o.material.name;
      if (!mats.has(key)) mats.set(key, slotMaterial(key, color));
      o.material = mats.get(key); o.castShadow = o.receiveShadow = true;
      withEdges(o, 40);
    } else if (o.name.startsWith('port_')) ports[o.name.slice(5)] = o.position.clone();
  });
  // A paddle wheel (M-12) is its own node, origin on its axle (record y): it turns.
  const wheel = g.getObjectByName('paddles');
  if (wheel) wheel.userData.animate = (t) => { wheel.rotation.z = -t * 1.2; };
  const path = g.getObjectByName('marble_path')?.userData.points;
  g.userData.ports = ports;
  if (path) g.userData.path = Array.from({ length: path.length / 3 }, (_, i) => ({ x: path[3 * i], y: path[3 * i + 1], z: path[3 * i + 2] }));
  g.userData.blender = name;
  const clips = CLIPS.get(name);
  if (clips) {
    const mixer = new THREE.AnimationMixer(g), len = Math.max(...clips.map((c) => c.duration));
    for (const c of clips) mixer.clipAction(c).play();
    g.userData.animate = (t) => mixer.setTime(((t % len) + len) % len);
    g.userData.animate(0);
  }
  return g;
}

export function modelFor(code, color = '#999999', set = null) {
  const name = glbName(code, set);
  if (name) return fromGlb(name, color);
  if (code[0] === 'B') return block(code, hex(color));
  if (code[0] === 'P') return plate(code, hex(color));
  if (code === 'M-10') return ramp(set ?? '5422');
  if (code === 'M-04') return openTower(set);
  if (code === 'M-07') return tray(set === '5422' ? 0xf7c600 : hex(color).getHex() === 0x999999 ? 0xc98a3a : hex(color));
  if (MODELS[code]) return MODELS[code]();
  if (code === 'T-14') return scoop(hex(color));
  if (code === 'T-17') return spiral(hex(color));
  if (code[0] === 'T') return soloTrack(code, hex(color));
  return null;
}
