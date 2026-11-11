import { World } from './ui/scene.js';
import { loadModels } from './ui/models.js';
import { say, blip } from './ui/voice.js';
import { layFloor, makeSteps, cellName } from './ui/guide.js';
import { renderPanel } from './ui/panel.js';
import { pileOf, colourPieces, partsUsed } from './engine/generator.js';
import { SETS, marbleTypes } from './catalog/sets.js';
import { validate, marblesOf } from './engine/validate.js';
import { buildPath } from './engine/geometry.js';
import { samplePath, verify, simulate } from './engine/physics.js';

const $ = (id) => document.getElementById(id);
// Blender models first, so every piece drawn below can use them.
await loadModels();
const world = new World($('world'));
const worker = new Worker('src/engine/worker.js', { type: 'module' });

const SIZES = [{ word: 'Little track' }, { word: 'Big track' }, { word: 'Super long track' }];

const state = { sets: [], on: new Set(), size: 1, current: null, steps: [], step: 0, mode: 'home', job: 0, spin: true };
window.__app = { state, world };

const spinning = () => state.mode === 'home' && state.spin;
const active = () => state.sets.filter((s) => state.on.has(s.id));

function sizeButtons() {
  $('sizes').innerHTML = '';
  SIZES.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'size'; b.setAttribute('aria-label', s.word); b.setAttribute('aria-pressed', i === state.size);
    b.innerHTML = '<i></i>'.repeat([2, 3, 5][i]);
    b.onclick = () => { state.size = i; sizeButtons(); say(s.word); blip(420 + i * 120); newTrack(); };
    $('sizes').append(b);
  });
}

function newTrack() {
  const id = ++state.job;
  $('thinking').hidden = false;
  $('goBtn').disabled = $('buildBtn').disabled = true;
  worker.postMessage({ id, stock: pileOf(active()), marbles: marbleTypes(active()), seed: (Math.random() * 1e9) | 0, size: state.size });
}

worker.onmessage = ({ data }) => {
  if (data.id !== state.job) return;
  const g = data.result;
  if (!g) { newTrack(); return; }
  const points = buildPath(g.track), path = samplePath(points), check = verify(path);
  // The worker's answer is never trusted: the marble is run again here.
  if (!check.ok) { newTrack(); return; }
  const sets = active(), floor = layFloor(g.track, sets, g), placed = colourPieces(g.track, sets);
  // The search's answer is rechecked from scratch; a bad track never reaches the screen.
  if (validate(g.track, floor.cells).length) { newTrack(); return; }
  const steps = makeSteps(g.track, placed, floor);
  const trace = simulate(path, {}, { record: true }).trace;
  state.current = { track: g.track, floor, placed, points, path, check, trace, used: partsUsed(g.track) };
  state.steps = steps;
  world.stopRun();
  world.show(state.current);
  world.controls.autoRotate = spinning();
  $('thinking').hidden = true;
  $('goBtn').disabled = $('buildBtn').disabled = false;
  if (!$('panel').hidden) drawPanel();
};

function dropMarble(after) {
  if (!state.current) return;
  $('goBtn').disabled = true;
  say('Here it goes!');
  world.setStage(null);
  world.drop(state.current.trace, 0.75, (piece) => {
    if (piece.endsWith('l')) { say('Up it goes!'); return; }
    if (piece.endsWith('m')) { say('Chomp!'); return; }
    if (piece.endsWith('w')) { say('Push!'); return; }
    if (piece.endsWith('x')) { blip(180, 300, 'sawtooth', 0.05); return; }
    blip(piece.startsWith('t') ? 660 : 500, 60);
  }, () => {
    blip(880, 200); setTimeout(() => blip(1175, 300), 140);
    say('Hooray!');
    world.celebrate();
    $('goBtn').disabled = false;
    world.controls.autoRotate = spinning();
    after?.();
  }, marblesOf(state.current.track));
}

function setMode(mode) {
  state.mode = mode;
  const build = mode === 'build';
  $('dock').hidden = build; $('stepdock').hidden = !build;
  for (const id of ['tray', 'progress', 'map']) $(id).hidden = !build;
  world.controls.autoRotate = spinning();
}

function miniMap(step) {
  const { floor } = state.current, b = floor.bounds;
  const cols = b.c1 - b.c0 + 1, rows = b.r1 - b.r0 + 1, u = 22, L = 18;
  const has = new Set(floor.cells.map(([c, r]) => `${c},${r}`));
  let s = `<svg viewBox="0 0 ${L + cols * u + 4} ${L + rows * u + 4}" role="img">`;
  for (let c = 0; c < cols; c++) s += `<text x="${L + c * u + u / 2}" y="13" text-anchor="middle" font-size="12" fill="#1c2a78">${c + 1}</text>`;
  for (let r = 0; r < rows; r++) s += `<text x="8" y="${L + r * u + u / 2 + 4}" text-anchor="middle" font-size="12" fill="#1c2a78">${String.fromCharCode(65 + r)}</text>`;
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
    if (!has.has(`${b.c0 + c},${b.r0 + r}`)) continue;
    const here = step.cell && step.cell[0] === b.c0 + c && step.cell[1] === b.r0 + r;
    const built = step.post !== undefined && state.current.placed.some((p) => p.group < step.post && p.seg === undefined && Math.round(p.c) === b.c0 + c && Math.round(p.r) === b.r0 + r);
    s += `<rect x="${L + c * u + 1}" y="${L + r * u + 1}" width="${u - 2}" height="${u - 2}" rx="4" fill="${here ? '#ffd400' : built ? '#8fb9e8' : '#d3edfb'}"${here ? ' stroke="#1c2a78" stroke-width="2"' : ''}/>`;
  }
  $('map').innerHTML = `${s}</svg>`;
}

function showStep(i) {
  state.step = i;
  const step = state.steps[i];
  $('progress').innerHTML = state.steps.map((_, k) => `<b class="${k < i ? 'on' : k === i ? 'now' : ''}"></b>`).join('');
  $('tray').innerHTML = step.items.map((it) => `<div class="row ${it.code[0] === 'B' ? 'block' : ''}"><img alt="${it.code}" src="${world.thumb(it.code, it.color, it.set)}">${it.count > 1 ? `<span class="count">${it.count}</span>` : ''}</div>`).join('');
  $('tray').hidden = !step.items.length;
  miniMap(step);
  $('map').hidden = step.kind === 'done';
  world.setStage(step.kind === 'done' ? null : step.stage);
  $('prevBtn').disabled = i === 0;
  say(step.line);
}

$('newBtn').onclick = () => { blip(520); say('New track!'); newTrack(); };
$('goBtn').onclick = () => dropMarble();
$('buildBtn').onclick = () => { blip(620); setMode('build'); showStep(0); };
$('nextBtn').onclick = () => {
  blip(740);
  if (state.step === state.steps.length - 1) { setMode('home'); dropMarble(); return; }
  showStep(state.step + 1);
};
$('prevBtn').onclick = () => { blip(440); showStep(Math.max(0, state.step - 1)); };
$('repeatBtn').onclick = () => say(state.steps[state.step].line);
$('exitBtn').onclick = () => { world.setStage(null); setMode('home'); };

$('viewBtn').onclick = () => {
  const open = $('viewbar').hidden;
  $('viewbar').hidden = !open; $('viewBtn').setAttribute('aria-expanded', open);
};
document.querySelectorAll('[data-look]').forEach((b) => { b.onclick = () => {
  const name = b.dataset.look;
  if (name === 'spin') state.spin = !state.spin;
  else { state.spin = false; world.look(name); }
  document.querySelector('[data-look=spin]').setAttribute('aria-pressed', state.spin);
  world.controls.autoRotate = spinning();
}; });

// Tap a piece to see what it is, so a screenshot can name it.
let down = null;
$('world').addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
$('world').addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;
  const label = world.pick(e.clientX, e.clientY);
  $('tag').hidden = !label; $('tag').textContent = label ?? '';
});

function drawPanel() {
  renderPanel($('panelBody'), { state, active, refresh: () => { drawPanel(); newTrack(); } });
}
$('gear').onclick = () => { $('panel').hidden = false; drawPanel(); };
$('closePanel').onclick = () => { $('panel').hidden = true; };

// Sets are whatever files sit in data/sets/; the catalog already read them.
state.sets = [...SETS];
state.sets.forEach((s) => state.on.add(s.id));
sizeButtons();
newTrack();
export { cellName };
