// The centreline of a spiral track, in its host block's frame: a cells ahead of the
// host's centre, s cells to the spiral's side, f the share of the drop already fallen.
// The real spiral (reference/pieces IMG_0959-0961) is one flat band beside its host: a
// short straight tongue out of the host's cup end, about one and a half turns winding
// inward over the footprint while falling gently, then a tail that dips under the band
// and comes back into the block under the host through the same face. The game's
// marble path and the 3D model both use this, so they always agree. Pure arithmetic.
export function spiralLocal([fa, fs] = [2, 2], n = 220) {
  const ca = 0.5 + fa / 2, cs = (fs - 1) / 2 + 0.1, R0 = Math.min(fa, fs) / 2 - 0.28;
  const pts = [], lead = 0.03, wind = 0.4;
  const p0 = [ca, cs - R0];
  // Tongue: straight on from the host's face to where the turn begins.
  for (let i = 0; i <= 8; i++) { const u = i / 8; pts.push({ a: 0.5 + (p0[0] - 0.5) * u, s: p0[1] * u, f: lead * u, part: 'band' }); }
  // Winding: one and a half turns toward the spiral side, the radius closing in.
  const turns = 1.5;
  for (let i = 1; i <= n; i++) {
    const u = i / n, phi = -Math.PI / 2 + u * turns * 2 * Math.PI, r = R0 * (1 - 0.55 * u);
    pts.push({ a: ca + r * Math.cos(phi), s: cs + r * Math.sin(phi), f: lead + wind * u, part: 'band' });
  }
  // Tail: leaves the inner curl heading back toward the host and dips under the band
  // to the host's face (Hermite curve, both ends heading back along the host's axis).
  const e = pts.at(-1), L = Math.hypot(e.a - 0.5, e.s);
  const h = (t) => [2 * t ** 3 - 3 * t ** 2 + 1, t ** 3 - 2 * t ** 2 + t, -2 * t ** 3 + 3 * t ** 2, t ** 3 - t ** 2];
  for (let i = 1; i <= 40; i++) {
    const t = i / 40, [h0, h1, h2, h3] = h(t), k = L * 1.1;
    pts.push({ a: h0 * e.a + h1 * -k + h2 * 0.5 + h3 * -k, s: h0 * e.s + h2 * 0, f: lead + wind + (1 - lead - wind) * (t * t * (3 - 2 * t)), part: 'tail' });
  }
  return pts;
}
