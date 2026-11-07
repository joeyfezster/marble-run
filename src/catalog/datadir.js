// Reads every JSON file in one data folder (pieces, sets or assemblies). Node only:
// the browser asks the server, which uses this same reader.
// MARBLE_EXTRA_DATA may list more data roots (separated like PATH). Their files are
// added after the shipped ones, so a new set can be tried without touching data/.
import { readdir, readFile } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_ROOT = fileURLToPath(new URL('../../data/', import.meta.url));
export const KINDS = Object.freeze(['pieces', 'sets', 'assemblies']);

export const extraRoots = () => (process.env.MARBLE_EXTRA_DATA ?? '').split(delimiter).filter(Boolean);

export async function readJsonDir(kind, roots = [DATA_ROOT, ...extraRoots()]) {
  const out = [];
  for (const root of roots) {
    let names;
    try { names = await readdir(join(root, kind)); } catch { continue; }
    for (const n of names.filter((x) => x.endsWith('.json')).sort()) {
      const body = JSON.parse(await readFile(join(root, kind, n), 'utf8'));
      if (body && typeof body === 'object' && !Array.isArray(body)) out.push({ file: n, ...body });
    }
  }
  return out;
}
