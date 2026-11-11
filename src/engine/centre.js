// The marble's centre over the drawn path: one function for the rules (physical.js), the
// run the app animates (physics.js simulate's record) and the flights (ballistic.js), so
// the marble the child sees is the marble that is checked. Pure arithmetic, names no piece.
export const MARBLE_RADIUS_M = 0.010; // the marble records: 20 mm across

// The marble's centre over path sample i: the path is the floor line under the marble, so
// a marble rolling on it has its centre a radius along the floor's normal, in the
// vertical plane of travel (a radius straight up would put it 4.6 mm into a 57 degree
// slope). A marble falling, carried or in the air has its centre a radius over the sample.
export function centreAt(path, i, radius = MARBLE_RADIUS_M) {
  const q = path[i], a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
  if (q.fall || q.air || q.flight || q.hang || q.hold !== undefined) return [q.x, q.y, q.z + radius];
  // The floor on either side of the sample, leaving out a vertical stretch (where a roll
  // meets a fall the floor ends at the roll). Each side's upward normal lies in its own
  // vertical plane of travel.
  const side = (p, r) => {
    const dx = r.x - p.x, dy = r.y - p.y, dz = r.z - p.z, h = Math.hypot(dx, dy);
    if (h < 1e-9 || Math.abs(dz) > 3 * h) return null;
    const L = Math.hypot(h, dz);
    return { t: [dx / L, dy / L, dz / L], n: [-(dx / h) * (dz / L), -(dy / h) * (dz / L), h / L] };
  };
  const s1 = a === q ? null : side(a, q), s2 = b === q ? null : side(q, b);
  if (!s1 && !s2) return [q.x, q.y, q.z + radius];
  const one = (n) => [q.x + n[0] * radius, q.y + n[1] * radius, q.z + n[2] * radius];
  if (!s1 || !s2) return one((s1 ?? s2).n);
  const m = [s1.n[0] + s2.n[0], s1.n[1] + s2.n[1], s1.n[2] + s2.n[2]], c = s1.n[0] * s2.n[0] + s1.n[1] * s2.n[1] + s1.n[2] * s2.n[2];
  // In a valley the marble rests on both floors: its centre is a radius from each, on the
  // bisector, (n1 + n2) / (1 + n1.n2) out. Over a crest or on the straight it touches the
  // sample itself: a radius along the mean normal.
  const turn = [s2.t[0] - s1.t[0], s2.t[1] - s1.t[1], s2.t[2] - s1.t[2]], valley = turn[0] * m[0] + turn[1] * m[1] + turn[2] * m[2] > 1e-9;
  if (valley && c > -0.9) return one(m.map((u) => u / (1 + c)));
  const l = Math.hypot(...m) || 1;
  return one(m.map((u) => u / l));
}

// The marble's centre as it leaves a lip: the floor runs from b up to the lip a (path
// samples, metres); the centre stands a radius off the floor's last stretch, along its
// upward normal in the plane of travel, as it does on the ramp just before.
export function lipCentre(a, b, radius = MARBLE_RADIUS_M) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z, h = Math.hypot(dx, dy);
  if (h < 1e-9) return { x: a.x, y: a.y, z: a.z + radius };
  const L = Math.hypot(h, dz);
  return { x: a.x - (dx / h) * (dz / L) * radius, y: a.y - (dy / h) * (dz / L) * radius, z: a.z + (h / L) * radius };
}
