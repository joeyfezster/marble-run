// The centreline of a spiral track, in its host block's frame: a cells ahead of the
// host's centre, s cells to the spiral's side, f the share of the drop already fallen.
// The real spiral (reference/pieces IMG_0959-0961, the VTech icon) is one wide band of
// about three quarters of a turn wrapped round the front corner of its host stack: its
// tongue lies on the host's cup end (a 0.5, s 0), the band turns toward the spiral side
// and falls one slot, and its far end lies on the cup end of the block under the host,
// on that side face (a 0, s 0.5), heading back across it. That lower block is turned
// 90 degrees, so the marble crosses it and leaves through the opposite side face.
// The game's marble path and the 3D models both use this, so they always agree.
// Pure arithmetic.
export const SPIRAL_TURNS = 0.75;

export function spiralLocal([fa, fs] = [2, 2], n = 160) {
  // A straight lead of t at each end, then three quarters of a circle of radius 0.5 + t
  // centred on (0.5 + t, 0.5 + t): it starts at the host face heading ahead and ends on
  // the side face heading back toward the host. IMG_0959 puts the band's outer wall about
  // 1.9 block widths across, so a 31 mm band has a centreline radius of about 0.6 cell.
  const t = Math.max(0, Math.min(fa, fs) / 2 - 0.9), R = 0.5 + t, c = 0.5 + t;
  const lead = t, arc = R * SPIRAL_TURNS * 2 * Math.PI, total = 2 * lead + arc;
  const pts = [];
  const at = (len) => len / total;
  for (let i = 0; i <= 6; i++) { const u = (i / 6) * t; pts.push({ a: 0.5 + u, s: 0, f: at(u), part: 'band' }); }
  for (let i = 1; i <= n; i++) {
    const u = i / n, phi = -Math.PI / 2 + u * SPIRAL_TURNS * 2 * Math.PI;
    pts.push({ a: c + R * Math.cos(phi), s: c + R * Math.sin(phi), f: at(lead + u * arc), part: 'band' });
  }
  for (let i = 1; i <= 6; i++) { const u = (i / 6) * t; pts.push({ a: 0, s: c - u, f: at(lead + arc + u), part: 'band' }); }
  pts.at(-1).f = 1;
  return pts.filter((p, i) => i === 0 || Math.hypot(p.a - pts[i - 1].a, p.s - pts[i - 1].s) > 1e-9 || p.f !== pts[i - 1].f);
}
