// What this household owns but has put aside, read from data/household.json. The set
// files stay as VTech counts them; only the pile the app builds from leaves these out.
const inNode = typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined';

async function load() {
  try {
    if (inNode) {
      const [{ readFile }, { DATA_ROOT }, { join }] = await Promise.all([import('node:fs/promises'), import('./datadir.js'), import('node:path')]);
      return JSON.parse(await readFile(join(DATA_ROOT, 'household.json'), 'utf8'));
    }
    const r = await fetch(new URL('../../data/household.json', import.meta.url), { cache: 'no-store' });
    return r.ok ? r.json() : {};
  } catch {
    return {};
  }
}

export const HOUSEHOLD = Object.freeze(await load());

// The entry for a piece code, or null when the household uses it.
export const notUsed = (code, household = HOUSEHOLD) => household?.notUsed?.[code] ?? null;
