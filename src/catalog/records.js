// The shared piece library, the owned sets and the multi-piece assemblies, read from
// data/. A record's key is its file name; the same code may have one record per set.
import { FOOT } from './frame.js';

const inNode = typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined';

async function load(kind) {
  if (inNode) return (await import('./datadir.js')).readJsonDir(kind);
  return (await fetch(new URL(`../../api/${kind}.json`, import.meta.url))).json();
}

const keyOf = (file) => file.replace(/\.json$/, '');
const byLastFile = (rows) => [...new Map(rows.map((r) => [keyOf(r.file), { ...r, key: keyOf(r.file) }])).values()];

const [pieceRows, setRows, assemblyRows] = await Promise.all(['pieces', 'sets', 'assemblies'].map(load));

export const PIECES = Object.freeze(byLastFile(pieceRows).filter((r) => r.code && Array.isArray(r.ports)));

// A set file lists piece codes, counts, colours and marbles. Folder order is the set order.
export const SETS = Object.freeze(byLastFile(setRows).filter((s) => s.id && s.parts));

export function recordOf(code, set) {
  const all = PIECES.filter((r) => r.code === code);
  return all.find((r) => r.key === `${code}__${set}`) ?? all.find((r) => r.key === code)
    ?? all.find((r) => set && r.sets?.[set]) ?? all[0] ?? null;
}

// An assembly is several pieces that only work together. It behaves as its lead
// piece, standing on the feet of all its parts.
function compose(a) {
  const parts = a.parts.map((p) => ({ ...p, rec: recordOf(p.piece, p.set) }));
  if (parts.some((p) => !p.rec)) return null;
  const lead = parts.find((p) => p.piece === a.acts) ?? parts[0];
  const shift = (q, p) => [q.at[0] + p.at[0], q.at[1] + p.at[1], q.at[2] + (p.at[2] ?? 0)];
  const ports = parts.flatMap((p, i) => p.rec.ports
    .filter((q) => p === lead || FOOT.has(q.type))
    .map((q) => ({ ...q, id: p === lead ? q.id : `${i}.${q.id}`, at: shift(q, p) })));
  return {
    ...lead.rec, key: a.key, file: a.file, assembly: true, names: a.names ?? lead.rec.names,
    shape: { ...lead.rec.shape, heightSlots: Math.max(...parts.map((p) => (p.rec.shape?.heightSlots ?? 0) + (p.at[2] ?? 0))) },
    ports, parts: parts.map((p) => ({ key: p.rec.key, code: p.rec.code, at: p.at, rot: p.rot ?? 0 })),
    evidence: a.evidence ?? lead.rec.evidence, assumptions: a.assumptions ?? [],
  };
}

export const ASSEMBLIES = Object.freeze(byLastFile(assemblyRows).map(compose).filter(Boolean));

const INDEX = new Map([...PIECES, ...ASSEMBLIES].map((r) => [r.key, r]));
export const byKey = (key) => INDEX.get(key) ?? null;

// Parts a placed record consumes from the pile.
export const partsOf = (rec) => rec.parts?.map((p) => p.key) ?? [rec.key];

// Kept for the UI: every piece record, as before.
export const RECORDS = PIECES;
