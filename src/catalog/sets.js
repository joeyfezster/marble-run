// Owned sets as one pile. Sets are whatever files sit in data/sets/; their parts are
// counted by record key, so a code with a different mould per set stays apart.
// Pieces the household has put aside (data/household.json) are left out of the pile.
import { SETS, recordOf } from './records.js';
import { HOUSEHOLD, notUsed } from './household.js';

export { SETS, HOUSEHOLD, notUsed };

export const keyIn = (code, setId) => recordOf(code, setId)?.key ?? code;

export function pileOf(sets, household = HOUSEHOLD) {
  const stock = {}, left = {};
  for (const s of sets) for (const [code, n] of Object.entries(s.parts)) {
    const k = keyIn(code, s.id), off = notUsed(code, household);
    left[code] ??= off ? off.count ?? Infinity : 0;
    const drop = Math.min(n, left[code]);
    left[code] -= drop;
    if (n - drop > 0) stock[k] = (stock[k] ?? 0) + n - drop;
  }
  return stock;
}

export const marblesOf = (sets) => sets.reduce((m, s) => {
  for (const [k, v] of Object.entries(s.marbles ?? {})) m[k] = (m[k] ?? 0) + v;
  return m;
}, {});

// A metal marble in the pile: the sets call it magic or metal.
export const hasMetalMarble = (sets) => Object.entries(marblesOf(sets)).some(([k, v]) => k !== 'plain' && v > 0);

// The marble types in the pile, as the engine names them: 'plain', and 'metal' for the
// sets' magic or metal marbles (D5: every route must work for each).
export const marbleTypes = (sets) => {
  const m = marblesOf(sets), out = [];
  if ((m.plain ?? 0) > 0) out.push('plain');
  if (Object.entries(m).some(([k, v]) => k !== 'plain' && v > 0)) out.push('metal');
  return out.length ? out : ['plain'];
};
