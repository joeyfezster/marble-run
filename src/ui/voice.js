// Josh does not read yet, so every control and step is spoken.
// Each sentence plays from the recorded voice pack (audio/voice/, made with macOS `say` by
// tools/voice/record.sh) when it has a recording; anything else falls back to the
// device's best built-in voice, natural ones first.
let chosen = null;
const NATURAL = /premium|enhanced|natural|neural|siri/i;
const pick = () => {
  const en = speechSynthesis.getVoices().filter((v) => v.lang?.startsWith('en'));
  chosen = en.find((v) => NATURAL.test(v.name) && v.lang === 'en-US') ?? en.find((v) => NATURAL.test(v.name))
    ?? en.find((v) => /Samantha|Ava|Allison|Google US English/.test(v.name)) ?? en[0] ?? null;
};
if ('speechSynthesis' in window) { pick(); speechSynthesis.onvoiceschanged = pick; }

const tidy = (s) => s.replace(/\s+/g, ' ').trim();
const sentences = (text) => tidy(text).split(/(?<=[.!?])\s+/).filter(Boolean);

const packUrl = new URL('../../audio/voice/', import.meta.url);
let pack = {};
fetch(new URL('index.json', packUrl)).then((r) => (r.ok ? r.json() : {})).then((j) => { pack = j.files ?? {}; }).catch(() => {});

let playing = null, job = 0;
function stop() {
  job++;
  if (playing) { playing.pause(); playing = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

function speak(text) {
  if (!('speechSynthesis' in window)) return Promise.resolve();
  return new Promise((done) => {
    const u = new SpeechSynthesisUtterance(text);
    if (chosen) u.voice = chosen;
    u.rate = 0.95;
    u.onend = u.onerror = done;
    speechSynthesis.speak(u);
  });
}

// One player for every clip: a phone unlocks it on the first tap and keeps it unlocked
// for the sentences that follow. A clip that stalls never holds up the rest of the line.
const player = typeof Audio === 'function' ? new Audio() : null;
function play(file, mine) {
  return new Promise((resolve) => {
    if (mine !== job || !player) return resolve(false);
    let over = false;
    const done = (ok) => { if (over) return; over = true; clearTimeout(cap); player.onended = player.onerror = null; resolve(ok); };
    const cap = setTimeout(() => done(true), 6000);
    player.onended = () => done(true);
    player.onerror = () => done(false);
    player.src = new URL(file, packUrl).href;
    playing = player;
    player.play().catch(() => done(false));
  });
}

export async function say(text) {
  stop();
  const mine = job;
  for (const s of sentences(text)) {
    if (mine !== job) return;
    // A clip the browser will not play (blocked, missing) is spoken instead.
    if (!(pack[s] && await play(pack[s], mine)) && mine === job) await speak(s);
  }
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
