/*
 * layout-worker.js
 * Force-directed (spring) layout simulation running in a Web Worker.
 *
 * Physics model (similar to d3-force):
 *   - link force      : spring toward a target length, biased by node degree
 *   - many-body force : Coulomb-like repulsion approximated with a
 *                       Barnes-Hut quadtree  -> O(N log N), scales to 10k+ nodes
 *   - centering force : weak pull toward the origin
 *   - alpha decay     : simulation "temperature" cools down and the loop
 *                       stops automatically; interaction reheats it
 *
 * Messages in:
 *   {type:'graph', n, edges: Uint32Array(2E)}        set a new graph
 *   {type:'pin',   i, x, y}                          start dragging node i
 *   {type:'drag',  i, x, y}                          move dragged node
 *   {type:'unpin', i}                                release node
 *   {type:'reheat'}                                  restart cooling from warm
 *   {type:'params', params:{...}}                    tune the forces (see P)
 *
 * Messages out:
 *   {type:'tick', positions: Float32Array(2N), alpha}   (positions transferred)
 */
'use strict';

// ---- simulation parameters -------------------------------------------------
// Tunable at runtime via the 'params' message.
const P = {
  linkDistance: 30,
  repulsion: -30,         // many-body strength (negative = repel)
  centerStrength: 0.03,
  velocityDecay: 0.6,
  linkStrength: 1,        // multiplier on the per-edge degree-based strength
};
const THETA2 = 0.81;            // Barnes-Hut accuracy (theta^2)
const DIST_MIN2 = 1;            // clamp for repulsion singularity
const ALPHA_MIN = 0.001;
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 500);
const TICK_INTERVAL = 16;       // ms, target simulation rate

// ---- graph state -----------------------------------------------------------
let N = 0, E = 0;
let eSrc = null, eDst = null;       // Uint32Array(E)
let px, py, vx, vy;                 // Float32Array(N) positions / velocities
let fx, fy;                         // fixed positions, NaN = free
let lStrength, lBias;               // per-edge link parameters

let alpha = 0;
let alphaTarget = 0;
let running = false;

// ---- quadtree (flat typed arrays, rebuilt every tick) ------------------------
// qPoint[c]: -1 empty leaf, -2 internal, >=0 point index stored in leaf
let qCap = 0, qCount = 0;
let qChild, qPoint, qMass, qCx, qCy;
let rootX = 0, rootY = 0, rootSize = 1;
const stC = new Int32Array(4096);
const stS = new Float32Array(4096);

function qGrow(minCap) {
  const cap = Math.max(minCap, qCap * 2, 1024);
  const nChild = new Int32Array(cap * 4);
  const nPoint = new Int32Array(cap);
  const nMass = new Float32Array(cap);
  const nCx = new Float32Array(cap);
  const nCy = new Float32Array(cap);
  if (qCap > 0) {
    nChild.set(qChild); nPoint.set(qPoint);
    nMass.set(qMass); nCx.set(qCx); nCy.set(qCy);
  }
  qChild = nChild; qPoint = nPoint; qMass = nMass; qCx = nCx; qCy = nCy;
  qCap = cap;
}

function newCell() {
  if (qCount >= qCap) qGrow(qCount + 1);
  const c = qCount++;
  const o = c * 4;
  qChild[o] = qChild[o + 1] = qChild[o + 2] = qChild[o + 3] = -1;
  qPoint[c] = -1;
  qMass[c] = 0; qCx[c] = 0; qCy[c] = 0;
  return c;
}

function buildTree() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < N; i++) {
    const x = px[i], y = py[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  rootX = minX;
  rootY = minY;
  rootSize = (Math.max(maxX - minX, maxY - minY) || 1) * 1.0001 + 1e-6;
  qCount = 0;
  newCell(); // root = 0
  for (let i = 0; i < N; i++) insertPoint(i);
}

function insertPoint(i) {
  const x = px[i], y = py[i];
  let cell = 0, x0 = rootX, y0 = rootY, size = rootSize;
  for (;;) {
    qMass[cell] += 1;
    qCx[cell] += x;
    qCy[cell] += y;
    const p = qPoint[cell];
    if (p === -1) { qPoint[cell] = i; return; }
    if (p >= 0) {
      // occupied leaf: coincident points stay aggregated in the mass sums
      if (size < 1e-9 || (px[p] === x && py[p] === y)) return;
      qPoint[cell] = -2;
      const half = size * 0.5;
      const jx = px[p] >= x0 + half ? 1 : 0;
      const jy = py[p] >= y0 + half ? 1 : 0;
      const c = newCell();
      qChild[cell * 4 + jy * 2 + jx] = c;
      qPoint[c] = p;
      qMass[c] = 1; qCx[c] = px[p]; qCy[c] = py[p];
    }
    const half = size * 0.5;
    const ix = x >= x0 + half ? 1 : 0;
    const iy = y >= y0 + half ? 1 : 0;
    const slot = cell * 4 + iy * 2 + ix;
    let c = qChild[slot];
    if (c === -1) { c = newCell(); qChild[slot] = c; }
    cell = c;
    x0 += ix * half;
    y0 += iy * half;
    size = half;
  }
}

// ---- forces ------------------------------------------------------------------
function applyRepulsion() {
  buildTree();
  const k = P.repulsion * alpha;
  for (let i = 0; i < N; i++) {
    const xi = px[i], yi = py[i];
    let fxi = 0, fyi = 0;
    let sp = 0;
    stC[sp] = 0; stS[sp] = rootSize; sp++;
    while (sp > 0) {
      sp--;
      const cell = stC[sp], size = stS[sp];
      const m = qMass[cell];
      if (m === 0) continue;
      const p = qPoint[cell];
      let dx = qCx[cell] / m - xi;
      let dy = qCy[cell] / m - yi;
      let d2 = dx * dx + dy * dy;
      if (p === -2 && size * size > d2 * THETA2) {
        // cell too close for approximation: descend
        const o = cell * 4, half = size * 0.5;
        for (let q = 0; q < 4; q++) {
          const c = qChild[o + q];
          if (c !== -1) { stC[sp] = c; stS[sp] = half; sp++; }
        }
        continue;
      }
      if (p === i) continue; // self
      if (d2 === 0) {
        dx = (Math.random() - 0.5) * 1e-3;
        dy = (Math.random() - 0.5) * 1e-3;
        d2 = dx * dx + dy * dy;
      }
      if (d2 < DIST_MIN2) d2 = Math.sqrt(d2 * DIST_MIN2);
      const w = k * m / d2;
      fxi += dx * w;
      fyi += dy * w;
    }
    vx[i] += fxi;
    vy[i] += fyi;
  }
}

function applyLinks() {
  for (let e = 0; e < E; e++) {
    const s = eSrc[e], t = eDst[e];
    let dx = px[t] + vx[t] - px[s] - vx[s];
    let dy = py[t] + vy[t] - py[s] - vy[s];
    if (dx === 0 && dy === 0) {
      dx = (Math.random() - 0.5) * 1e-3;
      dy = (Math.random() - 0.5) * 1e-3;
    }
    const d = Math.sqrt(dx * dx + dy * dy);
    const l = (d - P.linkDistance) / d * alpha * lStrength[e] * P.linkStrength;
    dx *= l; dy *= l;
    const b = lBias[e];
    vx[t] -= dx * b;       vy[t] -= dy * b;
    vx[s] += dx * (1 - b); vy[s] += dy * (1 - b);
  }
}

function step() {
  alpha += (alphaTarget - alpha) * ALPHA_DECAY;
  applyLinks();
  applyRepulsion();
  const g = P.centerStrength * alpha;
  for (let i = 0; i < N; i++) {
    vx[i] -= px[i] * g;
    vy[i] -= py[i] * g;
  }
  for (let i = 0; i < N; i++) {
    if (fx[i] === fx[i]) { // not NaN -> pinned
      px[i] = fx[i]; py[i] = fy[i];
      vx[i] = 0; vy[i] = 0;
      continue;
    }
    vx[i] *= P.velocityDecay;
    vy[i] *= P.velocityDecay;
    px[i] += vx[i];
    py[i] += vy[i];
  }
}

// ---- main loop ----------------------------------------------------------------
function postPositions() {
  const buf = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    buf[i * 2] = px[i];
    buf[i * 2 + 1] = py[i];
  }
  self.postMessage({ type: 'tick', positions: buf, alpha }, [buf.buffer]);
}

function start() {
  if (!running && N > 0) {
    running = true;
    loop();
  }
}

function loop() {
  if (!running) return;
  const t0 = performance.now();
  step();
  postPositions();
  if (alpha < ALPHA_MIN && alphaTarget < ALPHA_MIN) {
    running = false;
    return;
  }
  setTimeout(loop, Math.max(0, TICK_INTERVAL - (performance.now() - t0)));
}

// ---- graph setup -----------------------------------------------------------------
function initGraph(m) {
  N = m.n;
  E = m.edges.length >> 1;
  eSrc = new Uint32Array(E);
  eDst = new Uint32Array(E);
  for (let e = 0; e < E; e++) {
    eSrc[e] = m.edges[e * 2];
    eDst[e] = m.edges[e * 2 + 1];
  }

  px = new Float32Array(N); py = new Float32Array(N);
  vx = new Float32Array(N); vy = new Float32Array(N);
  fx = new Float32Array(N).fill(NaN);
  fy = new Float32Array(N).fill(NaN);

  // deterministic phyllotaxis initial placement (as in d3-force)
  const initialRadius = 10, initialAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const r = initialRadius * Math.sqrt(0.5 + i);
    const a = i * initialAngle;
    px[i] = r * Math.cos(a);
    py[i] = r * Math.sin(a);
  }

  const degree = new Uint32Array(N);
  for (let e = 0; e < E; e++) { degree[eSrc[e]]++; degree[eDst[e]]++; }
  lStrength = new Float32Array(E);
  lBias = new Float32Array(E);
  for (let e = 0; e < E; e++) {
    const ds = degree[eSrc[e]] || 1, dt = degree[eDst[e]] || 1;
    lStrength[e] = 1 / Math.min(ds, dt);
    lBias[e] = ds / (ds + dt);
  }

  alpha = 1;
  alphaTarget = 0;
  postPositions();
  start();
}

self.onmessage = (ev) => {
  const m = ev.data;
  switch (m.type) {
    case 'graph':
      initGraph(m);
      break;
    case 'pin':
      if (m.i < N) {
        fx[m.i] = m.x; fy[m.i] = m.y;
        alphaTarget = 0.3;
        if (alpha < 0.1) alpha = 0.1;
        start();
      }
      break;
    case 'drag':
      if (m.i < N) { fx[m.i] = m.x; fy[m.i] = m.y; }
      break;
    case 'unpin':
      if (m.i < N) { fx[m.i] = NaN; fy[m.i] = NaN; }
      alphaTarget = 0;
      break;
    case 'reheat':
      alpha = Math.max(alpha, 0.5);
      start();
      break;
    case 'params':
      for (const k in m.params) {
        if (k in P && Number.isFinite(m.params[k])) P[k] = m.params[k];
      }
      alpha = Math.max(alpha, 0.3); // warm up so changes take effect visibly
      start();
      break;
  }
};
