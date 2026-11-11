// Lays a model's stored engine path (its record frame) on a game path: the quarter turn r
// (E to S per step), mirror m (1, or -1 across the record's x axis) and shift t that put
// the model's path end on the game path's end, accepted only when every game point lies
// within tol of the model's path. Both paths in record axes (x E, y S, z up), metres.
// Returns { r, m, t } or null. Pure arithmetic, shared by scene.js and the tests.
const turn = ([x, y], r) => { for (let i = 0; i < r; i++) [x, y] = [-y, x]; return [x, y]; };
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

export function fitPath(local, world, tol = 0.0015) {
  if (!local?.length || world.length < 2) return null;
  const e = world.at(-1), le = local.at(-1);
  for (const m of [1, -1]) for (let r = 0; r < 4; r++) {
    const [ex, ey] = turn([le.x, le.y * m], r);
    const t = { x: e.x - ex, y: e.y - ey, z: e.z - le.z };
    const M = local.map((q) => { const [x, y] = turn([q.x, q.y * m], r); return { x: x + t.x, y: y + t.y, z: q.z + t.z }; });
    // Whether p lies within d of any of the first n points of M.
    const near = (p, d, n = M.length) => { for (let k = 0; k < n; k++) if (dist(p, M[k]) <= d) return true; return false; };
    // The game may drop a piece's first point (it joins the previous piece's last).
    if (!near(world[0], tol + 0.003, 3)) continue;
    if (world.some((p) => !near(p, tol))) continue;
    return { r, m, t };
  }
  return null;
}
