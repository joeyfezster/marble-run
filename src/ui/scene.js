// The 3D twin: every part is a real mesh placed where the plans would put it.
import * as THREE from '../../vendor/three.module.min.js';
import { OrbitControls } from '../../vendor/OrbitControls.js';
import { RoomEnvironment } from '../../vendor/RoomEnvironment.js';
import { DIM, TRACKS, spokenName, byKey } from '../catalog/parts.js';
import { fitPath } from './pathfit.js';
import { marbleAt } from './marbleat.js';
import { modelFor, trackModel, trackOpts, plastic, SPIRAL_OPTS, hangingBeam } from './models.js';

const SKY = 0xd3edfb, MARBLE = 0.01, MARBLE_GAP = 0.9; // s between one marble and the next

// A marble of one type: the Blender model when it loaded, else a plain red marble with a
// white stripe or a shiny metal one.
function makeMarble(type) {
  const glb = modelFor(`marble_${type}`, type === 'metal' ? '#c9ccd2' : '#e0262c');
  let g = null;
  if (glb) {
    // Rolled about its middle, wherever the model's origin sits.
    glb.position.sub(new THREE.Box3().setFromObject(glb).getCenter(new THREE.Vector3()));
    g = new THREE.Group(); g.add(glb);
  }
  const m = g ?? new THREE.Mesh(new THREE.SphereGeometry(MARBLE, 32, 24), type === 'metal'
    ? new THREE.MeshPhysicalMaterial({ color: 0xc9ccd2, metalness: 0.9, roughness: 0.18 })
    : plastic(0xe0262c, { roughness: 0.12, clearcoat: 1 }));
  if (!g) m.add(new THREE.Mesh(new THREE.TorusGeometry(MARBLE * 1.0, 0.0016, 8, 32), new THREE.MeshStandardMaterial({ color: type === 'metal' ? 0x2a6fd6 : 0xffffff })));
  m.traverse((o) => { o.castShadow = true; });
  m.visible = false;
  return m;
}

// ---------------------------------------------------------------- batching
// A long track is thousands of small meshes. Every part that never moves is copied
// into a few big meshes, one per kind of material, with each part's colour in its
// vertices; edge lines go into one line batch. Parts are sorted by build step, so
// a step is one index range: the steps before it draw from a faded copy, the step
// itself from the solid one, later steps not at all. Moving parts (anything an
// animate() call turns), see-through parts and textured parts stay ordinary meshes.

const MAT_PROPS = ['side', 'flatShading', 'roughness', 'metalness', 'clearcoat', 'clearcoatRoughness', 'envMapIntensity', 'transmission'];
const batchable = (m) => (m.isMeshPhysicalMaterial || m.isMeshStandardMaterial) && !m.map && !m.transparent && !m.vertexColors;
// Every solid part casts a shadow (setStage turns it on), so only receiving splits a batch.
const matKey = (m, mesh) => [m.type, ...MAT_PROPS.map((k) => m[k]), true, mesh.receiveShadow].join('|');
const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };

// Splits a freshly built model into batchable parts (geometry, matrix relative to the
// model, material) and a live remainder left in the model itself.
function splitModel(obj) {
  obj.updateMatrixWorld(true);
  const pose = (o) => [o.position.clone(), o.quaternion.clone(), o.scale.clone(), o.visible];
  const live = new Set();
  obj.traverse((a) => {
    if (!a.userData.animate) return;
    const was = new Map();
    a.traverse((o) => was.set(o, pose(o)));
    for (const t of [0.37, 1.9, 3.3, 5.1]) {
      a.userData.animate(t);
      for (const [o, [p, q, s]] of was) if (!o.position.equals(p) || !o.quaternion.equals(q) || !o.scale.equals(s)) live.add(o);
    }
    for (const [o, [p, q, s, v]] of was) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); o.visible = v; }
  });
  for (const o of live) o.userData.moves = true;
  obj.updateMatrixWorld(true);
  const underLive = (o) => { for (; o && o !== obj.parent; o = o.parent) if (live.has(o) || !o.visible || o.userData.demo) return true; return false; };
  const keep = new Set();
  obj.traverse((o) => {
    if (o.isMesh && (underLive(o) || !batchable(o.material))) for (let p = o; p; p = p.parent) keep.add(p);
  });
  const parts = [], lines = [];
  obj.traverse((o) => {
    if (!o.isMesh || keep.has(o)) return;
    parts.push({ geo: o.geometry, matrix: o.matrixWorld.clone(), mat: o.material, key: matKey(o.material, o), color: o.material.color.clone() });
    for (const e of o.children) if (e.userData.edge) lines.push({ geo: e.geometry, matrix: e.matrixWorld.clone(), color: e.material.color.clone() });
  });
  const gone = [];
  obj.traverse((o) => { if (o.isMesh && !keep.has(o)) gone.push(o); });
  if (gone.includes(obj)) return { parts, lines, rest: null };
  for (const o of gone) o.removeFromParent();
  // Each moving part turns as one: its own static pieces become one mesh per material.
  for (const L of live) {
    if (!L.visible || L.userData.demo) continue;
    L.updateMatrixWorld(true);
    const inv = L.matrixWorld.clone().invert(), byKey = new Map(), own = [];
    L.traverse((o) => {
      if (!o.isMesh || o === L || !batchable(o.material) || o.children.some((c) => !c.userData.edge)) return;
      for (let p = o.parent; p !== L; p = p.parent) if (live.has(p)) return;
      own.push(o);
    });
    for (const o of own) {
      const key = matKey(o.material, o);
      if (!byKey.has(key)) byKey.set(key, { mat: o.material, items: [], lines: [] });
      const k = byKey.get(key), m = inv.clone().multiply(o.matrixWorld);
      k.items.push({ step: 0, label: '', geo: o.geometry, matrix: m, color: o.material.color });
      for (const e of o.children) k.lines.push({ step: 0, label: '', geo: e.geometry, matrix: inv.clone().multiply(e.matrixWorld), color: e.material.color });
      o.removeFromParent();
    }
    for (const [key, { mat, items, lines: ls }] of byKey) {
      const solid = mat.clone(); solid.color.setRGB(1, 1, 1); solid.vertexColors = true;
      const m = new THREE.Mesh(packBatch(items, false).geo, solid);
      [m.castShadow, m.receiveShadow] = key.split('|').slice(-2).map((f) => f === 'true');
      L.add(m);
      if (ls.length) {
        const e = new THREE.LineSegments(packBatch(ls, true).geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7 }));
        e.raycast = () => {}; e.userData.edge = true; m.add(e);
      }
    }
  }
  let rest = false;
  obj.traverse((o) => { if (o.isMesh) rest = true; });
  return { parts, lines, rest: rest ? obj : null };
}

// Copies parts into one buffer, in the order given. items: {step, label, geo, matrix, color}.
function packBatch(items, lines) {
  let nv = 0, ni = 0;
  for (const it of items) { nv += it.geo.attributes.position.count; ni += lines ? 0 : (it.geo.index ? it.geo.index.count : it.geo.attributes.position.count); }
  const pos = new Float32Array(nv * 3), col = new Float32Array(nv * 3), nor = lines ? null : new Float32Array(nv * 3);
  const idx = lines ? null : new Uint32Array(ni);
  const v = new THREE.Vector3(), nm = new THREE.Matrix3(), steps = [], starts = [], labels = [];
  let vo = 0, io = 0;
  for (const it of items) {
    const P = it.geo.attributes.position, N = it.geo.attributes.normal, n = P.count;
    nm.getNormalMatrix(it.matrix);
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(it.matrix); v.toArray(pos, (vo + i) * 3);
      if (nor) { v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); v.toArray(nor, (vo + i) * 3); }
      it.color.toArray(col, (vo + i) * 3);
    }
    const at = lines ? vo : io;
    if (steps.at(-1) !== it.step) steps.push(it.step), starts.push(at);
    labels.push([at, it.label]);
    if (!lines) {
      const src = it.geo.index, flip = it.matrix.determinant() < 0, m = src ? src.count : n;
      for (let k = 0; k < m; k += 3) {
        const a = src ? src.getX(k) : k, b = src ? src.getX(k + 1) : k + 1, c = src ? src.getX(k + 2) : k + 2;
        idx[io + k] = vo + a; idx[io + k + 1] = vo + (flip ? c : b); idx[io + k + 2] = vo + (flip ? b : c);
      }
      io += m;
    }
    vo += n;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (nor) g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (idx) g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere(); g.computeBoundingBox();
  const end = lines ? vo : io;
  // Index range of a build step: from its first element to the first of a later step.
  const range = (step) => {
    let a = end, b = end;
    for (let i = 0; i < steps.length; i++) if (steps[i] >= step) { a = starts[i]; b = steps[i] === step ? (starts[i + 1] ?? end) : a; break; }
    return [a, b];
  };
  const starts3 = labels.map(([s]) => s / (lines ? 1 : 3));
  const labelAt = (face) => { let lo = 0, hi = starts3.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts3[m] <= face) lo = m; else hi = m - 1; } return labels[lo][1]; };
  return { geo: g, end, range, labelAt };
}

// The two views of one batch: solid (all, or the current step) and faded (earlier steps).
class Batch {
  constructor(parent, packed, solidMat, ghostMat, lines, shadows) {
    this.p = packed;
    const make = (mat) => {
      const g = new THREE.BufferGeometry();
      for (const [k, a] of Object.entries(packed.geo.attributes)) g.setAttribute(k, a);
      g.setIndex(packed.geo.index);
      g.boundingSphere = packed.geo.boundingSphere; g.boundingBox = packed.geo.boundingBox;
      const o = lines ? new THREE.LineSegments(g, mat) : new THREE.Mesh(g, mat);
      if (lines) o.raycast = () => {}; else o.userData.labelAt = packed.labelAt;
      parent.add(o); return o;
    };
    this.solid = make(solidMat); this.ghost = make(ghostMat);
    if (!lines) { this.solid.castShadow = shadows[0]; this.solid.receiveShadow = this.ghost.receiveShadow = shadows[1]; }
    this.solid.userData.solid = true;
  }

  stage(step) {
    const [a, b] = step === null ? [0, this.p.end] : this.p.range(step), [ga, gb] = step === null ? [0, 0] : [0, a];
    this.solid.geometry.setDrawRange(a, b - a); this.solid.visible = b > a;
    this.ghost.geometry.setDrawRange(ga, gb - ga); this.ghost.visible = gb > ga;
  }

  dispose() { this.p.geo.dispose(); for (const o of [this.solid, this.ghost]) { o.geometry.dispose(); o.material.dispose(); } }
}

// One piece on its own, for the library. Null means no honest model exists yet.
export const pieceObject = (code, color, set) => modelFor(code, color, set);

export class PieceViewer {
  constructor(canvas) {
    // The library copies each preview off this canvas, so it must keep what it drew.
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 0.72; r.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.scene.environment = new THREE.PMREMGenerator(r).fromScene(new RoomEnvironment(), 0.03).texture;
    const d = new THREE.DirectionalLight(0xffffff, 1.8); d.position.set(1, 2, 1.5); this.scene.add(d);
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.005, 20);
    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, { enableDamping: true, autoRotate: true, autoRotateSpeed: 1.6 });
    r.setAnimationLoop(() => {
      this.controls.update();
      const t = performance.now() / 1000;
      this.obj?.traverse((o) => o.userData.animate?.(t));
      r.render(this.scene, this.camera);
    });
  }

  show(obj, w, h) {
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    if (this.obj) this.scene.remove(this.obj);
    this.obj = obj; this.scene.add(obj);
    const box = new THREE.Box3().setFromObject(obj), c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2;
    this.controls.target.copy(c);
    this.camera.position.copy(c).add(new THREE.Vector3(0.7, 0.6, 1).normalize().multiplyScalar((r / Math.sin(0.245)) * 1.02));
  }
}

export class World {
  constructor(canvas) {
    this.canvas = canvas;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    // Phones: fewer pixels and a smaller shadow map; nobody sees the difference at arm's length.
    const small = Math.min(screen.width, screen.height) < 500, phone = small || matchMedia('(pointer: coarse)').matches;
    r.setPixelRatio(Math.min(devicePixelRatio, small ? 1.5 : 2));
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 0.72;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY);
    // Plastic reads as plastic only when it has a room to reflect.
    const pm = new THREE.PMREMGenerator(r);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.03).texture;
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.01, 30);
    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.08, maxPolarAngle: 1.5, minPolarAngle: 0.15, enablePan: false, autoRotate: true, autoRotateSpeed: 0.55 });
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb9dcf0, 0.55));
    const sun = this.sun = new THREE.DirectionalLight(0xfff4e0, 1.7);
    sun.castShadow = true; sun.shadow.mapSize.setScalar(phone ? 1024 : 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.002; sun.shadow.radius = 6;
    this.scene.add(sun, sun.target);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(12, 48), new THREE.ShadowMaterial({ opacity: 0.2 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.0005; ground.receiveShadow = true;
    this.scene.add(ground);
    this.root = new THREE.Group(); this.scene.add(this.root);
    this.kinds = new Map(); this.batches = []; this.groups = [];
    // One marble of each type a run uses (D5): a plain one and a magnet one look different.
    this.marbles = new Map(['plain', 'metal'].map((type) => [type, makeMarble(type)]));
    for (const m of this.marbles.values()) this.scene.add(m);
    this.marble = this.marbles.get('plain');
    this.rain = [];
    this.thumbs = new Map();
    addEventListener('resize', () => this.resize());
    this.resize();
    this.clock = new THREE.Clock();
    // Frames are drawn only when something changed or moves.
    this.controls.addEventListener('change', () => this.requestRender());
    r.setAnimationLoop(() => this.frame());
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender() { this.dirty = true; }

  clear() {
    // Shared piece kinds keep their geometry for the next track; one-off parts do not.
    const shared = new Set([...this.kinds.values()].flatMap((k) => [...k.parts, ...k.lines].map((x) => x.geo)));
    for (const b of this.batches) b.dispose();
    this.root.traverse((o) => { if (o.geometry && !shared.has(o.geometry)) o.geometry.dispose(); if (o.material?.dispose) o.material.dispose(); });
    this.root.clear(); this.steps = []; this.groups = []; this.batches = []; this.pending = []; this.oneOff = [];
  }

  // One model's batchable parts. A model with no moving or see-through parts is built
  // once per kind and reused; others are built fresh and keep their live remainder.
  kind(code, color, set) {
    const key = `${code}|${color}|${set}`;
    if (this.kinds.has(key)) return this.kinds.get(key);
    const obj = modelFor(code, color, set);
    if (!obj) return null;
    const path = obj.userData.path;
    const k = splitModel(obj);
    k.path = path;
    if (!k.rest) { k.shared = true; this.kinds.set(key, k); }
    return k;
  }

  // A Blender track or spiral is swept along the engine's own path in its record frame
  // (models.js userData.path). This finds the quarter turn and mirror that lay that path
  // on the game's path for one piece; null when no pose fits within 1.5 mm, and the
  // piece is then swept along the game's path as before.
  fitted(code, color, pts) {
    const k = this.kind(code, color, null);
    // A kind with moving parts (a paddle wheel) is built fresh for each piece, so it fits too.
    if (!k?.path) return null;
    const f = fitPath(k.path, pts);
    if (!f) return null;
    const at = new THREE.Object3D();
    at.position.set(f.t.x, f.t.z, f.t.y); at.rotation.set(0, -f.r * (Math.PI / 2), 0); at.scale.set(1, 1, f.m);
    return { k, at };
  }

  // Queues a model's parts for batching at pose `at` (an Object3D giving position and
  // rotation) in build-step group g; its live remainder joins the group.
  place(g, k, at, label) {
    at.updateMatrix();
    this.pending.push({ step: g.userData.step, label, k, matrix: at.matrix.clone() });
    if (!k.shared) this.oneOff.push(...[...k.parts, ...k.lines].map((x) => x.geo));
    if (k.rest) { k.rest.position.copy(at.position); k.rest.quaternion.copy(at.quaternion); k.rest.scale.copy(at.scale); k.rest.userData.label = label; g.add(k.rest); }
  }

  // Builds the batches from everything queued, in build-step order.
  batch() {
    const meshes = new Map(), lines = [], box = new THREE.Box3(), b = new THREE.Box3();
    const order = this.pending.map((p, i) => [p, i]).sort((x, y) => x[0].step - y[0].step || x[1] - y[1]).map(([p]) => p);
    for (const p of order) {
      for (const part of p.k.parts) {
        const matrix = p.matrix.clone().multiply(part.matrix);
        if (!meshes.has(part.key)) meshes.set(part.key, { mat: part.mat, items: [] });
        meshes.get(part.key).items.push({ step: p.step, label: p.label, geo: part.geo, matrix, color: part.color });
      }
      for (const l of p.k.lines) lines.push({ step: p.step, label: p.label, geo: l.geo, matrix: p.matrix.clone().multiply(l.matrix), color: l.color });
    }
    // The same box Box3.setFromObject would give for the unbatched parts.
    for (const it of [...[...meshes.values()].flatMap((m) => m.items), ...lines]) {
      if (!it.geo.boundingBox) it.geo.computeBoundingBox();
      box.union(b.copy(it.geo.boundingBox).applyMatrix4(it.matrix));
    }
    this.root.updateMatrixWorld(true);
    for (const g of this.groups) box.union(b.setFromObject(g));
    for (const [key, { mat, items }] of meshes) {
      const solid = mat.clone(); solid.color.setRGB(1, 1, 1); solid.vertexColors = true;
      const ghost = solid.clone(); Object.assign(ghost, { transparent: true, opacity: 0.32, depthWrite: false });
      const flags = key.split('|').slice(-2).map((f) => f === 'true');
      this.batches.push(new Batch(this.root, packBatch(items, false), solid, ghost, false, flags));
    }
    if (lines.length) {
      const lm = (opacity) => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity });
      this.batches.push(new Batch(this.root, packBatch(lines, true), lm(0.75), lm(0.2), true));
    }
    // One-off parts now live in the batches; free their own copies unless a live part shares one.
    const used = new Set();
    this.root.traverse((o) => { if (o.geometry) used.add(o.geometry); });
    for (const g of new Set(this.oneOff)) if (!used.has(g)) g.dispose();
    this.pending = []; this.oneOff = [];
    return box;
  }

  group(step) {
    const g = new THREE.Group(); g.userData.step = step; this.root.add(g); this.groups.push(g);
    return g;
  }

  mesh(geo, color, parent, own = false, extra, label) {
    const m = new THREE.Mesh(geo, plastic(color, extra));
    m.userData.label = label;
    m.castShadow = true; m.receiveShadow = true; m.userData.own = own; m.userData.color = color;
    parent.add(m);
    return m;
  }

  // layout: {track, floor, placed, points}. Everything drawn comes from the placed list.
  show({ track, floor, placed, points }) {
    this.clear();
    this.layout = { track, floor, placed, points };
    const floorG = this.group(0), at = new THREE.Object3D();
    const pose = (x, y, z, ry = 0) => { at.position.set(x, y, z); at.rotation.set(0, ry, 0); return at; };
    for (const p of floor.plates) {
      // A plate model's origin is its centre (the record's frame).
      const k = this.kind(p.code, p.color), cx = (p.c + (p.w - 1) / 2) * DIM.cell, cz = (p.r + (p.d - 1) / 2) * DIM.cell;
      pose(cx, 0, cz, p.w < p.d ? -Math.PI / 2 : 0);
      this.place(floorG, k, at, `${p.code} floor plate`);
    }
    const groups = new Map();
    const groupOf = (i) => { if (!groups.has(i)) groups.set(i, this.group(i + 2)); return groups.get(i); };
    for (const p of placed) {
      const g = groupOf(p.group);
      if (p.seg !== undefined) {
        const pts = points.filter((q) => q.piece === `t${p.seg}`);
        if (pts.length < 3) continue;
        const hangs = byKey(p.key)?.physics?.marbleHangs;
        // A Blender model built on the engine's path (a hanging piece's beam rides above it).
        const fit = this.fitted(p.code, p.color ?? '#b9bdc2', pts);
        if (fit) { this.place(g, fit.k, fit.at, `${p.code} ${TRACKS[p.code].name}`); continue; }
        // Otherwise a piece the marble hangs under (a magnet beam) is drawn above the path, not under it.
        const m = hangs
          ? hangingBeam(pts[0], pts.at(-1), p.color ?? '#f2a81d')
          : trackModel(pts, p.color ?? '#b9bdc2', trackOpts(p.code));
        this.place(g, splitModel(m), pose(0, 0, 0), `${p.code} ${TRACKS[p.code].name}`);
        continue;
      }
      if (p.spiral) {
        // The Blender band when it lies on the marble's path, else swept along that path.
        const fit = this.fitted(p.code, p.color ?? '#a9adb2', points.filter((q) => q.piece === p.spiral));
        if (fit) { this.place(g, fit.k, fit.at, `${p.code} ${spokenName(p.code)}`); continue; }
        const m = trackModel(points.filter((q) => q.piece === p.spiral), p.color ?? '#a9adb2', { ...SPIRAL_OPTS, mirror: (p.spiralSide ?? 1) > 0 });
        this.place(g, splitModel(m), pose(0, 0, 0), `${p.code} ${spokenName(p.code)}`);
        continue;
      }
      if (p.c === null || p.c === undefined) continue; // clip-ons riding a track have no spot of their own
      const k = this.kind(p.code, p.color ?? '#9aa3ad', p.set);
      if (!k) continue;
      this.place(g, k, pose(p.c * DIM.cell, p.y * DIM.slot, p.r * DIM.cell, -(p.rot ?? 0) * (Math.PI / 2)), `${p.code} ${spokenName(p.code)}`);
    }
    const b = this.batch();
    // Moving parts (scoop wheels, flaps) turn in the game too; demonstration marbles stay out.
    this.animated = [];
    this.root.traverse((o) => { if (o.userData.demo) o.visible = false; if (o.userData.animate) this.animated.push(o); });
    this.movers = [];
    this.root.traverse((o) => { if (o.userData.moves) this.movers.push({ o, was: [] }); });
    const c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
    this.bounds = { c, s };
    const radius = Math.max(s.x, s.z, s.y * 1.3);
    const sc = this.sun.shadow.camera, e = radius * 1.1;
    Object.assign(sc, { left: -e, right: e, top: e, bottom: -e, near: 0.05, far: 8 }); sc.updateProjectionMatrix();
    this.sun.position.set(c.x + radius * 0.8, radius * 2.2, c.z + radius * 0.5); this.sun.target.position.copy(c);
    this.frameAll();
    this.setStage(null);
  }

  frameAll() {
    const { c, s } = this.bounds, radius = Math.hypot(s.x, s.z) * 0.5 + s.y * 0.4;
    const fov = (this.camera.fov * Math.PI) / 180, dist = (radius / Math.sin(fov / 2)) * Math.max(1, 1.25 / this.camera.aspect) * 0.8;
    const dir = new THREE.Vector3(0.62, 0.62, 0.9).normalize();
    // Look from the side that puts the rocket in front of the towers.
    const rocket = this.layout?.placed.find((p) => p.code === 'M-13');
    if (rocket) {
      const rx = rocket.c * DIM.cell - c.x, rz = rocket.r * DIM.cell - c.z;
      if (rx * dir.x + rz * dir.z < 0) { dir.x *= -1; dir.z *= -1; }
    }
    this.controls.target.set(c.x, s.y * 0.3, c.z);
    this.controls.target.y += radius * -0.12;
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.controls.minDistance = radius * 0.5; this.controls.maxDistance = dist * 2;
  }

  // Fixed views for grown-ups reporting what looks wrong.
  look(name) {
    const { c, s } = this.bounds, d = this.camera.position.distanceTo(this.controls.target), t = this.controls.target;
    const dirs = { front: [0, 0.18, 1], back: [0, 0.18, -1], left: [-1, 0.18, 0], right: [1, 0.18, 0], top: [0.001, 1, 0.001] };
    if (name === 'home') { this.frameAll(); return; }
    t.set(c.x, s.y * 0.4, c.z);
    this.camera.position.copy(t).addScaledVector(new THREE.Vector3(...dirs[name]).normalize(), d);
    this.controls.maxPolarAngle = name === 'top' ? 1.5 : 1.5; this.controls.minPolarAngle = 0;
  }

  pick(x, y) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1), this.camera);
    for (const hit of ray.intersectObject(this.root, true)) {
      if (hit.object.userData.labelAt) return hit.object.userData.labelAt(hit.faceIndex);
      for (let o = hit.object; o; o = o.parent) if (o.userData.label) return o.userData.label;
    }
    return null;
  }

  // null shows everything; a number shows that build step, as the plans do:
  // finished work faded, the current step solid and glowing.
  setStage(step) {
    this.stage = step;
    for (const b of this.batches) {
      b.stage(step);
      if (b.solid.material.emissive) { b.solid.material.emissive.setHex(0x000000); b.solid.material.emissiveIntensity = 0; }
    }
    this.requestRender();
    for (const g of this.groups) {
      const s = g.userData.step;
      g.visible = step === null || s <= step;
      g.traverse((o) => {
        if (o.userData.edge) { o.material.opacity = step !== null && s < step ? 0.2 : 0.75; return; }
        if (!o.isMesh) return;
        const m = o.material, ghost = step !== null && s < step;
        // The shader drops alpha for opaque materials, so a change of mind needs a recompile.
        if (m.transparent !== ghost) m.needsUpdate = true;
        m.transparent = ghost; m.opacity = ghost ? 0.32 : 1; m.depthWrite = !ghost;
        m.emissive?.setHex(0x000000); m.emissiveIntensity = 0;
        o.castShadow = !ghost;
      });
    }
  }

  // Drops one marble of each type in `types`, one after another down the same run (plain
  // first, a magnet marble last: it is the one that fires a magnet trigger). onPiece
  // hears the first marble; onDone fires when the last one has finished.
  drop(trace, speed, onPiece, onDone, types = ['plain']) {
    const order = ['plain', 'metal'].filter((t) => types.includes(t));
    this.runs = (order.length ? order : ['plain']).map((type, k) => ({ type, mesh: this.marbles.get(type), trace, speed, i: 0, t: -k * MARBLE_GAP, last: null }));
    this.run = { onPiece, onDone };
    this.controls.autoRotate = false;
    for (const m of this.marbles.values()) m.visible = false;
    for (const r of this.runs) r.mesh.quaternion.identity();
  }

  stopRun() { this.run = null; this.runs = []; for (const m of this.marbles.values()) m.visible = false; this.requestRender(); }

  celebrate() {
    const colors = [0xe0262c, 0x1468b8, 0xf7c600, 0x43a93a, 0xf07f1e], { c, s } = this.bounds;
    const geo = new THREE.SphereGeometry(MARBLE * 1.1, 12, 10);
    for (let i = 0; i < 46; i++) {
      const m = new THREE.Mesh(geo, plastic(colors[i % 5]));
      m.position.set(c.x + (Math.random() - 0.5) * s.x, s.y + 0.1 + Math.random() * 0.5, c.z + (Math.random() - 0.5) * s.z);
      m.castShadow = true; m.userData.vy = 0; this.scene.add(m); this.rain.push(m);
    }
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.controls.update();
    const t = performance.now() / 1000;
    let moving = false;
    for (const o of this.animated ?? []) if (shown(o)) o.userData.animate(t);
    // A frame is needed only when a moving part actually moved (a flap rests between flips).
    for (const m of this.movers ?? []) {
      if (!shown(m.o)) continue;
      const now = [...m.o.position.toArray(), ...m.o.quaternion.toArray(), ...m.o.scale.toArray()];
      if (now.some((v, i) => v !== m.was[i])) { m.was = now; moving = true; }
    }
    if (this.stage !== null && this.stage !== undefined) {
      const pulse = 0.14 + 0.14 * Math.sin(t * 4.5);
      for (const b of this.batches) if (b.solid.visible && b.solid.material.emissive) { b.solid.material.emissive.setHex(0xffd400); b.solid.material.emissiveIntensity = pulse; }
      for (const g of this.groups) {
        if (g.userData.step !== this.stage) continue;
        g.traverse((o) => { if (o.isMesh && o.material.emissive) { o.material.emissive.setHex(0xffd400); o.material.emissiveIntensity = pulse; } });
      }
      moving = true;
    }
    if (this.run || this.rain.length) moving = true;
    if (!moving && !this.dirty) return;
    this.dirty = false;
    const run = this.run;
    if (run) {
      for (const [k, m] of (this.runs ?? []).entries()) {
        m.t += dt * m.speed;
        if (m.t < 0) continue;
        const tr = m.trace, mesh = m.mesh, at = marbleAt(tr, m.t, m.i), a = tr[at.i];
        m.i = at.i;
        const p = new THREE.Vector3(at.at[0], at.at[2], at.at[1]);
        const d = p.clone().sub(mesh.position);
        if (mesh.visible && d.length() > 1e-6 && d.length() < 0.2) {
          const axis = new THREE.Vector3(d.z, 0, -d.x);
          if (axis.lengthSq() > 1e-10) mesh.rotateOnWorldAxis(axis.normalize(), d.length() / MARBLE);
        }
        mesh.position.copy(p); mesh.visible = true;
        if (k === 0 && a.piece !== m.last) { m.last = a.piece; run.onPiece?.(a.piece); }
        m.done = m.i >= tr.length - 1;
      }
      if ((this.runs ?? []).every((m) => m.done)) { const done = run.onDone; this.run = null; done?.(); }
    }
    if (this.rain.length) {
      for (const m of this.rain) {
        m.userData.vy -= 2.4 * dt; m.position.y += m.userData.vy * dt;
        if (m.position.y < MARBLE) { m.position.y = MARBLE; m.userData.vy *= -0.55; if (Math.abs(m.userData.vy) < 0.1) m.userData.vy = 0; }
      }
      if (this.rain.every((m) => m.userData.vy === 0)) { this.rain.forEach((m) => this.scene.remove(m)); this.rain = []; }
    }
    this.renderer.render(this.scene, this.camera);
  }

  thumb(code, color, set) {
    const key = `${code}|${color}|${set}`;
    if (this.thumbs.has(key)) return this.thumbs.get(key);
    this.tr ??= new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.tr.setSize(220, 220); this.tr.setPixelRatio(1); this.tr.toneMapping = THREE.ACESFilmicToneMapping; this.tr.toneMappingExposure = 0.8;
    const s = new THREE.Scene(); s.environment = this.scene.environment;
    const d = new THREE.DirectionalLight(0xffffff, 2); d.position.set(1, 2, 1.5); s.add(d);
    const g = modelFor(code, color, set);
    if (!g) return '';
    s.add(g);
    const box = new THREE.Box3().setFromObject(g), c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2;
    const cam = new THREE.PerspectiveCamera(28, 1, 0.01, 10);
    cam.position.copy(c).add(new THREE.Vector3(0.7, 0.7, 1).normalize().multiplyScalar((r / Math.sin(0.245)) * 1.02));
    cam.lookAt(c);
    this.tr.render(s, cam);
    const url = this.tr.domElement.toDataURL('image/png');
    this.thumbs.set(key, url);
    return url;
  }
}
