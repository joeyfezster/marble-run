// Track search runs off the main thread so the marble keeps spinning on screen.
// The catalog loads asynchronously, so messages are accepted before it arrives.
const ready = import('./generator.js');

self.onmessage = async ({ data }) => {
  const { generate } = await ready;
  self.postMessage({ id: data.id, result: generate(data) });
};
