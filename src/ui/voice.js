// Josh does not read yet, so every control and step is spoken.
let chosen = null;
const pick = () => {
  const vs = speechSynthesis.getVoices();
  chosen = vs.find((v) => /Samantha/.test(v.name)) ?? vs.find((v) => v.lang.startsWith('en')) ?? null;
};
if ('speechSynthesis' in window) { pick(); speechSynthesis.onvoiceschanged = pick; }

export function say(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (chosen) u.voice = chosen;
  u.rate = 0.92; u.pitch = 1.1;
  speechSynthesis.speak(u);
}

let ctx = null;
export function blip(freq = 520, ms = 90, type = 'sine', gain = 0.08) {
  ctx ??= new (window.AudioContext || window.webkitAudioContext)();
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(gain, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
  o.connect(g).connect(ctx.destination);
  o.start(); o.stop(ctx.currentTime + ms / 1000);
}
