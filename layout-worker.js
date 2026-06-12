/*
 * layout-worker.js
 * Force-directed layout simulation running in a Web Worker.
 *
 * Several classic layout models are implemented; all of them share
 *   - a (weight-capable) Barnes-Hut quadtree for O(N log N) repulsion
 *   - the alpha cooling schedule: the simulation cools down and stops,
 *     interaction / parameter changes reheat it
 *
 * Models (P.model):
 *   spring       d3-force-like: spring links + strength/d repulsion,
 *                velocity integration
 *   eades        Eades (1984) spring embedder: c1*log(d/c2) springs,
 *                c3/d^2 repulsion
 *   fruchterman  Fruchterman-Reingold (1991): d^2/k attraction, k^2/d
 *                repulsion, displacement capped by a cooling temperature
 *   forceatlas2  Jacomy et al. (2014): linear attraction, degree-weighted
 *                (deg+1)(deg+1)/d repulsion
 *   linlog       Noack's LinLog energy model: constant edge attraction,
 *                1/d repulsion -> strong cluster separation
 *
 * Messages in:
 *   {type:'graph', n, edges: Uint32Array(2E)}        set a new graph
 *   {type:'model', model:'eades'}                    switch layout model
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
// Tunable at runtime via the 'params' / 'model' messages.
const P = {
  model: 'spring',
  linkDistance: 30,
  repulsion: -30,         // strength (negative = repel); meaning is per-model
  centerStrength: 0.03,
  velocityDecay: 0.6,
  linkStrength: 1,        // attraction multiplier
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
let deg;                            // Uint32Array(N) node degrees
let wgt;                            // Float32Array(N) repulsion weight (FA2: deg+1)
let lStrength, lBias;               // per-edge link parameters (spring model)

let alpha = 0;
let alphaTarget = 0;
let running = false;

// ---- quadtree (flat typed arrays, rebuilt every tick) ------------------------
// qPoint[c]: -1 empty leaf, -2 internal, >=0 point index stored in leaf
// qMass accumulates node weights (wgt), qCx/qCy weighted coordinate sums.
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
  const x = px[i], y = py[i], w = wgt[i];
  let cell = 0, x0 = rootX, y0 = rootY, size = rootSize;
  for (;;) {
    qMass[cell] += w;
    qCx[cell] += x * w;
    qCy[cell] += y * w;
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
      qMass[c] = wgt[p];
      qCx[c] = px[p] * wgt[p];
      qCy[c] = py[p] * wgt[p];
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

/*
 * Barnes-Hut repulsion pass, adds dx * f into the velocity/force buffers with
 *   f = C * wgt[i] * cellMass / d^2          (pow3 = false)
 *   f = C * wgt[i] * cellMass / d^3          (pow3 = true)
 * i.e. force magnitudes ~ |C| m / d  resp. |C| m / d^2.  C < 0 repels.
 */
function bhRepulsion(C, pow3) {
  buildTree();
  for (let i = 0; i < N; i++) {
    const xi = px[i], yi = py[i];
    const Ci = C * wgt[i];
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
      const f = pow3 ? Ci * m / (d2 * Math.sqrt(d2)) : Ci * m / d2;
      fxi += dx * f;
      fyi += dy * f;
    }
    vx[i] += fxi;
    vy[i] += fyi;
  }
}

// ---- attraction forces (per model) ------------------------------------------
// d3-force-like: spring toward linkDistance, degree-biased, uses velocities
function attractSpring() {
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

// Eades: spring force c1 * log(d / L) (repels adjacent nodes when d < L)
function attractEades(K) {
  const L = P.linkDistance, c1 = 2 * P.linkStrength;
  for (let e = 0; e < E; e++) {
    const s = eSrc[e], t = eDst[e];
    const dx = px[t] - px[s], dy = py[t] - py[s];
    const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
    const g = c1 * Math.log(d / L) * K / d * 0.5;
    vx[s] += dx * g; vy[s] += dy * g;
    vx[t] -= dx * g; vy[t] -= dy * g;
  }
}

// Fruchterman-Reingold: attraction d^2 / k (written into the force buffers)
function attractFR(k, ka) {
  for (let e = 0; e < E; e++) {
    const s = eSrc[e], t = eDst[e];
    const dx = px[t] - px[s], dy = py[t] - py[s];
    const d = Math.sqrt(dx * dx + dy * dy);
    const g = d / k * ka;
    vx[s] += dx * g; vy[s] += dy * g;
    vx[t] -= dx * g; vy[t] -= dy * g;
  }
}

// ForceAtlas2: linear attraction F = d
function attractFA2(c) {
  for (let e = 0; e < E; e++) {
    const s = eSrc[e], t = eDst[e];
    const dx = px[t] - px[s], dy = py[t] - py[s];
    vx[s] += dx * c; vy[s] += dy * c;
    vx[t] -= dx * c; vy[t] -= dy * c;
  }
}

// LinLog: constant attraction along edges
function attractLinLog(c) {
  for (let e = 0; e < E; e++) {
    const s = eSrc[e], t = eDst[e];
    const dx = px[t] - px[s], dy = py[t] - py[s];
    const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
    const g = c / d;
    vx[s] += dx * g; vy[s] += dy * g;
    vx[t] -= dx * g; vy[t] -= dy * g;
  }
}

// ---- integration --------------------------------------------------------------
function centerPull() {
  const g = P.centerStrength * alpha;
  for (let i = 0; i < N; i++) {
    vx[i] -= px[i] * g;
    vy[i] -= py[i] * g;
  }
}

// velocity integration with optional per-tick displacement cap
function integrate(maxDisp) {
  const cap2 = maxDisp * maxDisp;
  for (let i = 0; i < N; i++) {
    if (fx[i] === fx[i]) { // not NaN -> pinned
      px[i] = fx[i]; py[i] = fy[i];
      vx[i] = 0; vy[i] = 0;
      continue;
    }
    vx[i] *= P.velocityDecay;
    vy[i] *= P.velocityDecay;
    const d2 = vx[i] * vx[i] + vy[i] * vy[i];
    if (d2 > cap2) {
      const s = maxDisp / Math.sqrt(d2);
      vx[i] *= s; vy[i] *= s;
    }
    px[i] += vx[i];
    py[i] += vy[i];
  }
}

// FR moves each node along its net force, at most "temperature" t per tick
function integrateFR(t) {
  for (let i = 0; i < N; i++) {
    if (fx[i] === fx[i]) {
      px[i] = fx[i]; py[i] = fy[i];
      vx[i] = 0; vy[i] = 0;
      continue;
    }
    const d2 = vx[i] * vx[i] + vy[i] * vy[i];
    if (d2 > 1e-12) {
      const d = Math.sqrt(d2);
      const m = Math.min(d, t) / d;
      px[i] += vx[i] * m;
      py[i] += vy[i] * m;
    }
    vx[i] = 0; vy[i] = 0;
  }
}

// ---- simulation step -------------------------------------------------------------
function step() {
  alpha += (alphaTarget - alpha) * ALPHA_DECAY;
  const L = P.linkDistance;
  switch (P.model) {
    case 'eades': {
      const K = 0.1 * L * alpha;             // Eades' step constant c4, scaled by L
      attractEades(K);
      bhRepulsion((P.repulsion / 30) * L * L * K, true);  // c3 / d^2
      centerPull();
      integrate(L);
      break;
    }
    case 'fruchterman': {
      const ka = P.linkStrength, kr = P.repulsion / 30;
      vx.fill(0); vy.fill(0);                // force accumulators, no momentum
      attractFR(L, ka);
      bhRepulsion(kr * L * L, false);        // k^2 / d
      const g = P.centerStrength * 5;
      for (let i = 0; i < N; i++) { vx[i] -= px[i] * g; vy[i] -= py[i] * g; }
      integrateFR(3 * L * alpha);            // cooling temperature
      break;
    }
    case 'forceatlas2': {
      const K = 0.05 * alpha;
      attractFA2(P.linkStrength * K);
      bhRepulsion(P.repulsion * K, false);   // kr * (deg+1)(deg+1) / d  via wgt
      centerPull();
      integrate(2 * L * Math.max(alpha, 0.1));
      break;
    }
    case 'linlog': {
      const K = 2 * alpha;
      attractLinLog(P.linkStrength * K);
      bhRepulsion(P.repulsion * K, false);   // repulsion ~ 1/d
      centerPull();
      integrate(L);
      break;
    }
    default: { // spring
      attractSpring();
      bhRepulsion(P.repulsion * alpha, false);
      centerPull();
      integrate(Infinity);
    }
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

// ---- graph / model setup -----------------------------------------------------------
function setWeights() {
  if (!wgt) return;
  if (P.model === 'forceatlas2') {
    for (let i = 0; i < N; i++) wgt[i] = deg[i] + 1;
  } else {
    wgt.fill(1);
  }
}

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

  deg = new Uint32Array(N);
  for (let e = 0; e < E; e++) { deg[eSrc[e]]++; deg[eDst[e]]++; }
  wgt = new Float32Array(N);
  setWeights();

  lStrength = new Float32Array(E);
  lBias = new Float32Array(E);
  for (let e = 0; e < E; e++) {
    const ds = deg[eSrc[e]] || 1, dt = deg[eDst[e]] || 1;
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
    case 'model':
      P.model = m.model;
      if (N > 0) {
        setWeights();
        vx.fill(0); vy.fill(0);
        alpha = Math.max(alpha, 0.8);
        start();
      }
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
        if (k in P && k !== 'model' && Number.isFinite(m.params[k])) P[k] = m.params[k];
      }
      alpha = Math.max(alpha, 0.3); // warm up so changes take effect visibly
      start();
      break;
  }
};
