// The twin's catalog. Every dimension, span, drop and name below is read from the
// piece records in data/pieces/, so correcting a record corrects the whole app.
import { RECORDS, PIECES, SETS, ASSEMBLIES, recordOf, byKey, partsOf } from './records.js';
import { LIB, isBlock, mates, names, blockPortsOn } from './behaviours.js';
import { DIRS, SEAT, left, right, back } from './frame.js';

export { RECORDS, PIECES, SETS, ASSEMBLIES, recordOf, byKey, partsOf, LIB, isBlock, mates, names, blockPortsOn, left, right, back };

// The reference block: the plain one-slot block a marble rolls straight across.
const ref = PIECES.find((r) => LIB.blocks[r.key]?.cross === 'straight' && LIB.blocks[r.key].height === 1 && r.shape?.sizeMm);
if (!ref) throw new Error('No straight one-slot block record to measure the grid from');
export const DIM = Object.freeze({
  cell: ref.shape.sizeMm[0] / 1000,
  slot: ref.shape.sizeMm[2] / 1.17 / 1000, // rails stand 0.17 slot above the pitch
  seatDrop: SEAT,
  source: ref.shape.sizeBasis,
});

export const HEADINGS = DIRS;

// Accepts a record key or a plain code.
export const spokenName = (k) => { const r = byKey(k) ?? recordOf(k); return r?.names?.spoken ?? r?.names?.family ?? k; };

export const TRACKS = LIB.tracks;

// Words a parent would use. Spoken in the build guide.
export const COLOR_WORDS = {
  '#1468b8': 'blue', '#c98a3a': 'tan', '#a9adb2': 'gray', '#e0262c': 'red', '#f07f1e': 'orange',
  '#b6dc2c': 'lime', '#4f9d2f': 'green', '#b9bdc2': 'silver', '#f7c600': 'yellow', '#3b3d42': 'black',
  '#35a7e0': 'light blue', '#f4f4f2': 'white', '#1c3fb0': 'dark blue',
};
