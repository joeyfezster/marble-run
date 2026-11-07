// Lays real plates. A floor must be built from the plates in the box; plate sizes
// come from the floor records.
import { LIB } from '../catalog/parts.js';

const PLATES = LIB.floors.slice().sort((a, b) => b.w * b.d - a.w * a.d);
const plateOf = (key) => PLATES.find((p) => p.key === key || p.code === key);
export const isPlate = (key) => !!plateOf(key);

export function tile(c0, c1, r0, r1, available) {
  const stock = available.map((p) => ({ ...p })), taken = new Set(), out = [];
  const take = (code) => { const i = stock.findIndex((p) => p.code === code || p.key === code); return i < 0 ? null : stock.splice(i, 1)[0]; };
  const shapes = PLATES.flatMap((p) => (p.w === p.d ? [[p.key, p.w, p.d]] : [[p.key, p.w, p.d], [p.key, p.d, p.w]]));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (taken.has(`${c},${r}`)) continue;
      const fits = (w, d) => { for (let x = 0; x < w; x++) for (let y = 0; y < d; y++) if (c + x > c1 || r + y > r1 || taken.has(`${c + x},${r + y}`)) return false; return true; };
      let p = null, w = 0, d = 0;
      for (const [key, a, b] of shapes) {
        if (fits(a, b) && (p = take(key))) { w = a; d = b; break; }
      }
      if (!p) continue;
      for (let x = 0; x < w; x++) for (let y = 0; y < d; y++) taken.add(`${c + x},${r + y}`);
      out.push({ ...p, c, r, w, d });
    }
  }
  return { plates: out, cells: [...taken].map((k) => k.split(',').map(Number)) };
}

export const platesIn = (stock) => PLATES.flatMap((p) => Array(stock[p.key] ?? 0).fill({ code: p.code, key: p.key }));

// The best rectangle these plates really cover. Modes: near the wanted width (default),
// the roomiest ("room"), or the longest that is still roomy ("long", for long lines of pieces).
export function floorRect(stock, wantWidth = 10, mode = false) {
  const biggest = mode === true || mode === 'room';
  const list = platesIn(stock), area = list.reduce((n, p) => n + plateOf(p.key).w * plateOf(p.key).d, 0), options = [];
  for (let width = 4; width <= 18; width++) for (let depth = 2; depth <= 12; depth++) {
    if (width * depth > area || depth > width) continue;
    if (tile(0, width - 1, 0, depth - 1, list).cells.length === width * depth) options.push({ width, depth });
  }
  const rank = (o) => (mode === 'long' ? o.width * 4 + o.width * o.depth
    : biggest ? o.width * o.depth * 3 - Math.abs(o.width - o.depth * 1.3) * 2
      : o.width * o.depth - Math.abs(o.width - wantWidth) * 2 - Math.abs(o.width - o.depth * 1.4));
  return options.sort((a, b) => rank(b) - rank(a))[0] ?? { width: 8, depth: 6 };
}
