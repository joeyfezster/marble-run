// Where the app draws the marble's centre at time t of a recorded run (physics.js
// simulate(..., { record: true }).trace), world metres in the engine's axes (x East,
// y South, z up): { i (record index, the next search's hint), piece, at: [x, y, z] }.
// It is physics.js traceAt: the records hold the marble's centre as the rules check it
// (centre.js centreAt) at every drawn path sample and along every flight's arc, so the
// marble the child sees is the marble that is checked (tests/trace.test.js).
export { traceAt as marbleAt } from '../engine/physics.js';
