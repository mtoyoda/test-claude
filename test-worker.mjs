// Smoke test: run the layout worker in Node with a stubbed worker global scope.
// Usage: node test-worker.mjs
import { readFileSync } from 'fs';

let lastTick = null;
let tickCount = 0;
globalThis.self = {
  postMessage(msg) {
    if (msg.type === 'tick') { lastTick = msg; tickCount++; }
  },
};

// load the worker script (it assigns self.onmessage)
(0, eval)(readFileSync(new URL('./layout-worker.js', import.meta.url), 'utf8'));
const send = (m) => self.onmessage({ data: m });

// build a small Watts-Strogatz-like ring graph: 500 nodes, k=4
const n = 500;
const pairs = [];
for (let i = 0; i < n; i++) {
  pairs.push(i, (i + 1) % n, i, (i + 2) % n);
}
send({ type: 'graph', n, edges: Uint32Array.from(pairs) });

// the worker loop uses setTimeout; wait until it cools down
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 200));
  if (lastTick && lastTick.alpha < 0.0011) break;
}

const pos = lastTick.positions;
let bad = 0, minX = Infinity, maxX = -Infinity;
for (let i = 0; i < n; i++) {
  const x = pos[i * 2], y = pos[i * 2 + 1];
  if (!Number.isFinite(x) || !Number.isFinite(y)) bad++;
  if (x < minX) minX = x;
  if (x > maxX) maxX = x;
}
let sumLen = 0;
for (let e = 0; e < pairs.length; e += 2) {
  const s = pairs[e], t = pairs[e + 1];
  const dx = pos[s * 2] - pos[t * 2], dy = pos[s * 2 + 1] - pos[t * 2 + 1];
  sumLen += Math.hypot(dx, dy);
}
const avgLen = sumLen / (pairs.length / 2);

console.log(`ticks=${tickCount} alpha=${lastTick.alpha.toFixed(4)}`);
console.log(`non-finite positions: ${bad}`);
console.log(`x extent: ${(maxX - minX).toFixed(1)}  avg edge length: ${avgLen.toFixed(1)}`);

// drag test: pin node 0 far away, tick a bit, verify it stays pinned and reheats
send({ type: 'pin', i: 0, x: 5000, y: 5000 });
await new Promise((r) => setTimeout(r, 500));
send({ type: 'drag', i: 0, x: 6000, y: 6000 });
await new Promise((r) => setTimeout(r, 500));
const px0 = lastTick.positions[0], py0 = lastTick.positions[1];
console.log(`pinned node at (${px0.toFixed(0)}, ${py0.toFixed(0)}), alpha=${lastTick.alpha.toFixed(3)}`);
send({ type: 'unpin', i: 0 });

// params test: tuning forces must reheat the simulation and keep it stable
send({ type: 'params', params: { linkDistance: 60, repulsion: -80, velocityDecay: 0.4 } });
await new Promise((r) => setTimeout(r, 500));
let badAfterParams = 0;
for (let i = 0; i < n * 2; i++) {
  if (!Number.isFinite(lastTick.positions[i])) badAfterParams++;
}
console.log(`after params: alpha=${lastTick.alpha.toFixed(3)} non-finite=${badAfterParams}`);
send({ type: 'params', params: { linkDistance: 30, repulsion: -30, velocityDecay: 0.6 } });

// model test: every layout model must keep positions finite and spread out
let badModels = 0;
for (const model of ['eades', 'fruchterman', 'forceatlas2', 'linlog', 'spring']) {
  send({ type: 'model', model });
  await new Promise((r) => setTimeout(r, 1200));
  const p = lastTick.positions;
  let nf = 0, mnX = Infinity, mxX = -Infinity;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(p[i * 2]) || !Number.isFinite(p[i * 2 + 1])) nf++;
    if (p[i * 2] < mnX) mnX = p[i * 2];
    if (p[i * 2] > mxX) mxX = p[i * 2];
  }
  const spread = mxX - mnX;
  const good = nf === 0 && spread > 50 && spread < 1e6;
  if (!good) badModels++;
  console.log(`model ${model.padEnd(12)} non-finite=${nf} x-extent=${spread.toFixed(0)} ${good ? 'ok' : 'NG'}`);
}

const ok = bad === 0
  && badModels === 0
  && badAfterParams === 0
  && lastTick.alpha > 0.05
  && maxX - minX > 50
  && avgLen > 5 && avgLen < 200
  && Math.abs(px0 - 6000) < 1 && Math.abs(py0 - 6000) < 1;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
