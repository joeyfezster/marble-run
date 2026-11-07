// The grown-up view: what is in the pile, why this track is trusted, what is estimated.
import { DIM, LIB } from '../catalog/parts.js';

const CORNER_NAMES = { nominal: 'Normal', draggy: 'Sticky joints, slow plastic', slick: 'Clean and slippery', 'heavy-magic': 'Metal marble, hard push', 'weak-push': 'Gentle push' };
const REASON = { stuck: 'stops', 'too-fast': 'leaves the track' };

function energyChart(trace) {
  // Two stacked bands of one quantity share one axis: what is left of the start energy.
  const w = 380, h = 170, pad = 28, L = trace[trace.length - 1].s, E0 = Math.max(...trace.map((p) => p.pe + p.ke));
  const x = (s) => pad + (s / L) * (w - pad - 4), y = (e) => h - pad - (e / E0) * (h - pad - 8);
  const pts = trace.filter((_, i) => i % 2 === 0);
  const areaPE = `M${x(0)},${y(0)} ${pts.map((p) => `L${x(p.s).toFixed(1)},${y(p.pe).toFixed(1)}`).join(' ')} L${x(L)},${y(0)} Z`;
  const areaKE = `M${x(0)},${y(trace[0].pe)} ${pts.map((p) => `L${x(p.s).toFixed(1)},${y(p.pe + p.ke).toFixed(1)}`).join(' ')} ${pts.slice().reverse().map((p) => `L${x(p.s).toFixed(1)},${y(p.pe).toFixed(1)}`).join(' ')} Z`;
  const grid = [0, 0.5, 1].map((f) => `<line x1="${pad}" x2="${w - 4}" y1="${y(E0 * f)}" y2="${y(E0 * f)}" stroke="#1c2a78" stroke-opacity=".14"/><text x="${pad - 5}" y="${y(E0 * f) + 4}" text-anchor="end" font-size="11" fill="#1c2a78">${f * 100}%</text>`).join('');
  return `<div class="legend"><span><i style="background:#1d4fa8"></i>Height energy</span><span><i style="background:#e0562c"></i>Speed energy</span></div>
    <div class="chart" data-l="${L}"><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Energy left along the track, as a share of the peak">
    ${grid}<path d="${areaPE}" fill="#1d4fa8"/><path d="${areaKE}" fill="#e0562c"/>
    <text x="${w - 4}" y="${h - 10}" text-anchor="end" font-size="11" fill="#1c2a78">${L.toFixed(1)} m along the track</text>
    <line class="cross" y1="8" y2="${h - pad}" stroke="#1c2a78" visibility="hidden"/></svg><div class="tip" hidden></div></div>`;
}

function hookChart(root, trace) {
  const box = root.querySelector('.chart'), svg = box.querySelector('svg'), line = box.querySelector('.cross'), tip = box.querySelector('.tip');
  const w = 380, pad = 28, L = trace[trace.length - 1].s, E0 = Math.max(...trace.map((p) => p.pe + p.ke));
  svg.onpointermove = (e) => {
    const r = svg.getBoundingClientRect(), vx = ((e.clientX - r.left) / r.width) * w;
    const s = Math.max(0, Math.min(L, ((vx - pad) / (w - pad - 4)) * L));
    const p = trace.reduce((a, b) => (Math.abs(b.s - s) < Math.abs(a.s - s) ? b : a));
    line.setAttribute('x1', vx); line.setAttribute('x2', vx); line.setAttribute('visibility', 'visible');
    tip.hidden = false; tip.style.left = `${Math.min(r.width - 150, Math.max(0, e.clientX - r.left))}px`;
    tip.textContent = `${p.v.toFixed(2)} m/s, ${Math.round(((p.pe + p.ke) / E0) * 100)}% left`;
  };
  svg.onpointerleave = () => { tip.hidden = true; line.setAttribute('visibility', 'hidden'); };
}

export function renderPanel(el, { state, active, refresh }) {
  const cur = state.current;
  const setRows = state.sets.map((s) => `<label><input type="checkbox" data-set="${s.id}" ${state.on.has(s.id) ? 'checked' : ''}> ${s.name}</label>
    <p style="font-size:14px">${Object.values(s.parts).reduce((a, b) => a + b, 0)} pieces. ${s.confidence === 'official' ? 'Counted from VTech\'s parts page.' : 'Worked out from the official build; the total matches the box.'}</p>`).join('');
  let track = '<p>Finding a track.</p>';
  if (cur) {
    const blocks = Object.entries(cur.used).filter(([k]) => LIB.blocks[k]).reduce((a, [, n]) => a + n, 0);
    const pieces = Object.values(cur.used).reduce((a, b) => a + b, 0);
    const rows = cur.check.results.map((r) => `<tr><td>${CORNER_NAMES[r.corner] ?? r.corner}</td><td>${r.ok ? `Finishes, top speed ${r.vMax.toFixed(2)} m/s` : REASON[r.kind]}</td></tr>`).join('');
    const tot = Math.max(...cur.trace.map((p) => p.pe + p.ke)), end = cur.trace[cur.trace.length - 1];
    track = `<p>${cur.track.segs.length} track pieces and ${blocks} blocks, ${pieces} parts in all. The run is ${cur.path.length.toFixed(1)} m long and takes ${cur.trace[cur.trace.length - 1].t.toFixed(1)} s. It starts ${((cur.track.posts[0].hOut ?? cur.track.posts[0].h) * DIM.slot * 100).toFixed(0)} cm up and finishes with ${Math.round(((end.pe + end.ke) / tot) * 100)}% of its peak energy.${cur.trace.length && cur.check.results[0].sources?.length ? ' Jumps in the chart are where a hand or the motor adds energy.' : ''}</p>
      ${energyChart(cur.trace)}
      <h2>Tested five ways</h2>
      <p>Every track must finish in all five before Josh sees it.</p>
      <table><tbody>${rows}</tbody></table>`;
  }
  el.innerHTML = `<h2>Sets in the pile</h2>${setRows}<h2>This track</h2>${track}
    <h2>What is measured and what is estimated</h2>
    <p>From VTech's plans: piece counts, which pieces join, and how far apart they sit.</p>
    <p>Estimated: cell size ${DIM.cell * 100} cm, block height ${DIM.slot * 100} cm, marble size, friction and joint losses. No real run has tuned these yet, so a track can still surprise you.</p>
    <p>Not generated yet: the up-curve (banana), whose way back into a block is not settled in its record.</p>`;
  el.querySelectorAll('input[data-set]').forEach((c) => { c.onchange = () => {
    if (c.checked) state.on.add(c.dataset.set); else state.on.delete(c.dataset.set);
    if (!active().length) { state.on.add(c.dataset.set); c.checked = true; }
    refresh();
  }; });
  if (cur) hookChart(el, cur.trace);
}
