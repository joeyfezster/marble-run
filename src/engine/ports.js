// What a track physically clips to where it leaves or enters a post, read from the
// post's own pieces. Shared by the generator (to propose) and the validator (to judge).
import { TRACKS, LIB, byKey, names } from '../catalog/parts.js';
import { SIDE } from '../catalog/frame.js';

const blockSide = (key) => { const rec = byKey(key); return rec && { rec, ports: rec.ports.filter((p) => SIDE.has(p.type)) }; };
const fitSide = (fit, id) => { const rec = byKey(fit.key); return rec && { rec, ports: [rec.ports.find((p) => p.id === id)].filter(Boolean) }; };

// The piece and ports a track leaving this post meets.
export function exitSide(post) {
  switch (post.kind) {
    case 'station': return fitSide(post.fit, post.fit.to);
    case 'jump': return post.drops ? blockSide(post.stack.at(-1)) : fitSide(post.catcher, post.catcher.to);
    case 'toss': return blockSide(post.stack.at(-1));
    case 'fall': return blockSide(post.stack.find((k) => LIB.blocks[k]?.catcher) ?? post.stack.at(-1));
    case 'spiral': return blockSide(post.stack.at(-2) ?? post.stack.at(-1));
    default: return blockSide(post.stack.at(-1));
  }
}

// The piece and ports a track arriving at this post meets.
export function entrySide(post) {
  switch (post.kind) {
    case 'station': return fitSide(post.fit, post.fit.from);
    case 'jump': return fitSide(post.ramp, post.ramp.from);
    case 'toss': return fitSide(post.fit, post.fit.from);
    case 'fall': return post.fit ? fitSide(post.fit, post.fit.from) : blockSide(post.stack.at(-1));
    case 'end': return post.endCells ? blockSide(post.stack.at(-1)) : fitSide(post.fit, post.fit.from);
    default: return blockSide(post.stack.at(-1));
  }
}

function meets(side, code, portId) {
  const t = TRACKS[code], rec = byKey(code), port = rec?.ports.find((p) => p.id === portId);
  if (!t || !side || !side.ports.length || !port) return false;
  return side.ports.some((p) => names(p.accepts, rec, port)) && names(port.accepts, side.rec, side.ports[0]);
}

export const leaves = (post, code) => meets(exitSide(post), code, TRACKS[code]?.from);
export const enters = (post, code) => meets(entrySide(post), code, TRACKS[code]?.to);
