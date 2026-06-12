/*
 * main.js
 * WebGL renderer + interaction for the force-directed graph viewer.
 *
 * - Renders nodes as point sprites and edges as GL lines from a single
 *   shared position buffer (scales to 10k+ nodes).
 * - Receives positions from layout-worker.js and uploads them each frame.
 * - Mouse: wheel = zoom, drag background = pan, drag node = move node
 *   (pinned in the simulation while dragging), hover = label tooltip.
 *
 * Graph source:
 *   ?graph=<url>   load a JSON graph (see README / panel for the format)
 *   ?n=&k=&p=      parameters of the generated Watts-Strogatz small world
 *                  (default n=1000, k=6, p=0.1)
 */
'use strict';

(() => {

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('canvas');
const tooltip = document.getElementById('tooltip');
const statsEl = document.getElementById('stats');
const statusEl = document.getElementById('status');

function setStatus(msg, isError) {
  statusEl.textContent = msg || '';
  statusEl.className = isError ? 'error' : '';
}

// ---------------------------------------------------------------- WebGL setup
let gl = canvas.getContext('webgl2', { antialias: true });
let index32 = true;
if (!gl) {
  gl = canvas.getContext('webgl', { antialias: true });
  if (!gl) {
    setStatus('WebGLを初期化できませんでした。', true);
    throw new Error('WebGL unavailable');
  }
  index32 = !!gl.getExtension('OES_element_index_uint');
}

const VS = `
attribute vec2 aPos;
attribute vec3 aColor;
varying vec3 vColor;
uniform vec2 uCenter;
uniform float uScale;
uniform vec2 uViewport;
uniform float uPointSize;
void main() {
  vec2 p = (aPos - uCenter) * uScale;
  gl_Position = vec4(2.0 * p.x / uViewport.x, -2.0 * p.y / uViewport.y, 0.0, 1.0);
  gl_PointSize = uPointSize;
  vColor = aColor;
}`;

const NODE_FS = `
precision mediump float;
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float a = 1.0 - smoothstep(0.7, 1.0, r2);
  gl_FragColor = vec4(vColor, 0.95 * a);
}`;

const EDGE_FS = `
precision mediump float;
uniform vec4 uColor;
void main() { gl_FragColor = uColor; }`;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s));
  }
  return s;
}

function makeProgram(fsSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p));
  }
  return {
    prog: p,
    aPos: gl.getAttribLocation(p, 'aPos'),
    aColor: gl.getAttribLocation(p, 'aColor'),
    uCenter: gl.getUniformLocation(p, 'uCenter'),
    uScale: gl.getUniformLocation(p, 'uScale'),
    uViewport: gl.getUniformLocation(p, 'uViewport'),
    uPointSize: gl.getUniformLocation(p, 'uPointSize'),
    uColor: gl.getUniformLocation(p, 'uColor'),
  };
}

const nodeProg = makeProgram(NODE_FS);
const edgeProg = makeProgram(EDGE_FS);

const posBuf = gl.createBuffer();
const colorBuf = gl.createBuffer();
const edgeIdxBuf = gl.createBuffer();
const highlightBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, highlightBuf);
gl.bufferData(gl.ARRAY_BUFFER, 8, gl.DYNAMIC_DRAW);

gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

// ---------------------------------------------------------------- app state
const NODE_WORLD_RADIUS = 4;

let N = 0, E = 0;
let labels = [];
let positions = null;       // Float32Array(2N), latest from the worker
let posDirty = false;
let simAlpha = 0;
let edgeIdxType = 0;

const camera = { cx: 0, cy: 0, scale: 1 };
let autoFit = true;
let hovered = -1;
let dragged = -1;
let panning = false;
let panLast = null;

let frames = 0, fps = 0, lastFpsTime = performance.now();

// ---------------------------------------------------------------- worker
const worker = new Worker('layout-worker.js');
worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'tick') {
    positions = m.positions;
    simAlpha = m.alpha;
    posDirty = true;
  }
};

// ---------------------------------------------------------------- camera helpers
function viewSize() {
  return [canvas.clientWidth || 1, canvas.clientHeight || 1];
}

function toWorld(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const [vw, vh] = viewSize();
  return [
    (clientX - rect.left - vw / 2) / camera.scale + camera.cx,
    (clientY - rect.top - vh / 2) / camera.scale + camera.cy,
  ];
}

function nodeScreenRadius() {
  return Math.min(Math.max(NODE_WORLD_RADIUS * camera.scale, 2), 13);
}

function fitView(lerp) {
  if (!positions || N === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < N; i++) {
    const x = positions[i * 2], y = positions[i * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const [vw, vh] = viewSize();
  const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
  const tScale = Math.min(vw / w, vh / h) * 0.9;
  const tCx = (minX + maxX) / 2, tCy = (minY + maxY) / 2;
  if (lerp) {
    camera.scale += (tScale - camera.scale) * 0.1;
    camera.cx += (tCx - camera.cx) * 0.1;
    camera.cy += (tCy - camera.cy) * 0.1;
  } else {
    camera.scale = tScale;
    camera.cx = tCx;
    camera.cy = tCy;
  }
}

// ---------------------------------------------------------------- picking
function pickNode(wx, wy) {
  if (!positions) return -1;
  const maxDist = (nodeScreenRadius() + 4) / camera.scale;
  const max2 = maxDist * maxDist;
  let best = -1, bestD2 = max2;
  for (let i = 0; i < N; i++) {
    const dx = positions[i * 2] - wx;
    const dy = positions[i * 2 + 1] - wy;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  return best;
}

// ---------------------------------------------------------------- interaction
function showTooltip(i, clientX, clientY) {
  tooltip.textContent = labels[i] != null ? labels[i] : String(i);
  tooltip.style.display = 'block';
  tooltip.style.left = (clientX + 14) + 'px';
  tooltip.style.top = (clientY + 14) + 'px';
}

function hideTooltip() {
  tooltip.style.display = 'none';
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  autoFit = false;
  const [wx, wy] = toWorld(e.clientX, e.clientY);
  const i = pickNode(wx, wy);
  canvas.setPointerCapture(e.pointerId);
  if (i >= 0) {
    dragged = i;
    hovered = i;
    worker.postMessage({ type: 'pin', i, x: wx, y: wy });
    showTooltip(i, e.clientX, e.clientY);
  } else {
    panning = true;
    panLast = [e.clientX, e.clientY];
    canvas.classList.add('panning');
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (dragged >= 0) {
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    if (positions) {
      positions[dragged * 2] = wx;
      positions[dragged * 2 + 1] = wy;
      posDirty = true;
    }
    worker.postMessage({ type: 'drag', i: dragged, x: wx, y: wy });
    showTooltip(dragged, e.clientX, e.clientY);
    return;
  }
  if (panning) {
    camera.cx -= (e.clientX - panLast[0]) / camera.scale;
    camera.cy -= (e.clientY - panLast[1]) / camera.scale;
    panLast = [e.clientX, e.clientY];
    return;
  }
  const [wx, wy] = toWorld(e.clientX, e.clientY);
  hovered = pickNode(wx, wy);
  if (hovered >= 0) {
    showTooltip(hovered, e.clientX, e.clientY);
    canvas.classList.add('node-hover');
  } else {
    hideTooltip();
    canvas.classList.remove('node-hover');
  }
});

function endPointer(e) {
  if (dragged >= 0) {
    worker.postMessage({ type: 'unpin', i: dragged });
    dragged = -1;
  }
  panning = false;
  panLast = null;
  canvas.classList.remove('panning');
  if (e.type === 'pointercancel' || e.pointerType !== 'mouse') {
    hovered = -1;
    hideTooltip();
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => {
  if (dragged < 0 && !panning) {
    hovered = -1;
    hideTooltip();
    canvas.classList.remove('node-hover');
  }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  autoFit = false;
  const [wx, wy] = toWorld(e.clientX, e.clientY);
  const factor = Math.exp(-e.deltaY * 0.0012);
  camera.scale = Math.min(Math.max(camera.scale * factor, 1e-4), 1e4);
  // keep the world point under the cursor fixed
  const rect = canvas.getBoundingClientRect();
  const [vw, vh] = viewSize();
  camera.cx = wx - (e.clientX - rect.left - vw / 2) / camera.scale;
  camera.cy = wy - (e.clientY - rect.top - vh / 2) / camera.scale;
}, { passive: false });

document.getElementById('reheat').addEventListener('click', () => {
  worker.postMessage({ type: 'reheat' });
});
document.getElementById('fit').addEventListener('click', () => {
  autoFit = true;
});

// ------------------------------------------------------- layout parameter UI
// Slider ids are p-<key>; the repulsion slider holds the magnitude and is
// negated before being sent to the worker.
const PARAM_DEFS = [
  { key: 'linkDistance',   digits: 0 },
  { key: 'repulsion',      digits: 0, toWorker: (v) => -v },
  { key: 'centerStrength', digits: 3 },
  { key: 'velocityDecay',  digits: 2 },
  { key: 'linkStrength',   digits: 2 },
];

function sendParams() {
  const out = {};
  for (const d of PARAM_DEFS) {
    const v = parseFloat(d.input.value);
    d.valueEl.textContent = v.toFixed(d.digits);
    out[d.key] = d.toWorker ? d.toWorker(v) : v;
  }
  worker.postMessage({ type: 'params', params: out });
}

for (const d of PARAM_DEFS) {
  d.input = document.getElementById('p-' + d.key);
  d.valueEl = document.getElementById('v-' + d.key);
  d.valueEl.textContent = parseFloat(d.input.value).toFixed(d.digits);
  d.input.addEventListener('input', sendParams);
}

document.getElementById('resetParams').addEventListener('click', () => {
  for (const d of PARAM_DEFS) d.input.value = d.input.defaultValue;
  sendParams();
});

// ------------------------------------------------------- layout model menu
// Sliders that have no effect in a model are greyed out.
const MODEL_PARAMS = {
  spring:      ['linkDistance', 'repulsion', 'centerStrength', 'velocityDecay', 'linkStrength'],
  eades:       ['linkDistance', 'repulsion', 'centerStrength', 'velocityDecay', 'linkStrength'],
  fruchterman: ['linkDistance', 'repulsion', 'centerStrength', 'linkStrength'],
  forceatlas2: ['repulsion', 'centerStrength', 'velocityDecay', 'linkStrength'],
  linlog:      ['repulsion', 'centerStrength', 'velocityDecay', 'linkStrength'],
};

const modelSel = document.getElementById('model');
{
  const m = params.get('model');
  if (m && MODEL_PARAMS[m]) modelSel.value = m;
}

function applyModel() {
  const used = MODEL_PARAMS[modelSel.value];
  for (const d of PARAM_DEFS) {
    const active = used.includes(d.key);
    d.input.disabled = !active;
    d.input.parentElement.classList.toggle('disabled', !active);
  }
  worker.postMessage({ type: 'model', model: modelSel.value });
}
modelSel.addEventListener('change', applyModel);

// ------------------------------------------------------- graph generator menu
const GEN_DEFS = {
  smallworld: {
    name: 'スモールワールド (Watts–Strogatz)',
    params: [
      { key: 'n', label: 'ノード数 n', def: 1000, min: 2, max: 200000, step: 1 },
      { key: 'k', label: '平均次数 k', def: 6, min: 2, max: 100, step: 2 },
      { key: 'p', label: '再配線率 p', def: 0.1, min: 0, max: 1, step: 0.01 },
    ],
    make: (q) => GraphGen.smallWorld(q.n, q.k, q.p),
  },
  ba: {
    name: 'スケールフリー (Barabási–Albert)',
    params: [
      { key: 'n', label: 'ノード数 n', def: 1000, min: 2, max: 200000, step: 1 },
      { key: 'm', label: '接続エッジ数 m', def: 3, min: 1, max: 20, step: 1 },
    ],
    make: (q) => GraphGen.barabasiAlbert(q.n, q.m),
  },
  sbm: {
    name: 'クラスタ構造 (確率的ブロックモデル)',
    params: [
      { key: 'n', label: 'ノード数 n', def: 1000, min: 4, max: 200000, step: 1 },
      { key: 'c', label: 'クラスタ数 c', def: 8, min: 2, max: 100, step: 1 },
      { key: 'kin', label: 'クラスタ内平均次数', def: 8, min: 0, max: 100, step: 0.5 },
      { key: 'kout', label: 'クラスタ間平均次数', def: 1, min: 0, max: 100, step: 0.1 },
    ],
    make: (q) => GraphGen.sbm(q.n, q.c, q.kin, q.kout),
  },
  er: {
    name: 'ランダム (Erdős–Rényi)',
    params: [
      { key: 'n', label: 'ノード数 n', def: 1000, min: 2, max: 200000, step: 1 },
      { key: 'k', label: '平均次数 k', def: 6, min: 0, max: 100, step: 0.5 },
    ],
    make: (q) => GraphGen.erdosRenyi(q.n, q.k),
  },
  grid: {
    name: '2次元格子',
    params: [
      { key: 'n', label: 'ノード数 n (平方数に丸め)', def: 1024, min: 4, max: 200000, step: 1 },
    ],
    make: (q) => GraphGen.grid(q.n),
  },
};

const genSel = document.getElementById('genType');
const genParamsEl = document.getElementById('genParams');
for (const [id, def] of Object.entries(GEN_DEFS)) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = def.name;
  genSel.appendChild(opt);
}
{
  const g = params.get('gen');
  if (g && GEN_DEFS[g]) genSel.value = g;
}

function urlNum(name) {
  const v = parseFloat(params.get(name));
  return Number.isFinite(v) ? v : null;
}

function buildGenParamInputs() {
  genParamsEl.innerHTML = '';
  for (const p of GEN_DEFS[genSel.value].params) {
    const row = document.createElement('div');
    row.className = 'param';
    const label = document.createElement('label');
    label.textContent = p.label;
    const input = document.createElement('input');
    input.type = 'number';
    input.id = 'g-' + p.key;
    input.min = p.min;
    input.max = p.max;
    input.step = p.step;
    const fromUrl = urlNum(p.key);
    input.value = fromUrl !== null
      ? Math.min(Math.max(fromUrl, p.min), p.max)
      : p.def;
    row.appendChild(label);
    row.appendChild(input);
    genParamsEl.appendChild(row);
  }
}
genSel.addEventListener('change', buildGenParamInputs);
buildGenParamInputs();

function readGenParams() {
  const def = GEN_DEFS[genSel.value];
  const q = {};
  for (const p of def.params) {
    let v = parseFloat(document.getElementById('g-' + p.key).value);
    if (!Number.isFinite(v)) v = p.def;
    v = Math.min(Math.max(v, p.min), p.max);
    if (p.step >= 1) v = Math.round(v);
    q[p.key] = v;
  }
  return q;
}

function generateGraph() {
  const def = GEN_DEFS[genSel.value];
  const q = readGenParams();
  const desc = Object.entries(q).map(([k, v]) => `${k}=${v}`).join(', ');
  setStatus(`${def.name} を生成 (${desc})`);
  return def.make(q);
}

document.getElementById('generate').addEventListener('click', () => {
  setGraph(generateGraph());
  // make the current generator state shareable via the URL
  const sp = new URLSearchParams();
  sp.set('gen', genSel.value);
  for (const [k, v] of Object.entries(readGenParams())) sp.set(k, v);
  if (modelSel.value !== 'spring') sp.set('model', modelSel.value);
  history.replaceState(null, '', '?' + sp.toString());
});

// ---------------------------------------------------------------- rendering
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function setCommonUniforms(p, pointSizeCss) {
  const dpr = window.devicePixelRatio || 1;
  const [vw, vh] = viewSize();
  gl.uniform2f(p.uCenter, camera.cx, camera.cy);
  gl.uniform1f(p.uScale, camera.scale);
  gl.uniform2f(p.uViewport, vw, vh);
  gl.uniform1f(p.uPointSize, pointSizeCss * dpr);
}

function bindPositions(p, buffer) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(p.aPos);
  gl.vertexAttribPointer(p.aPos, 2, gl.FLOAT, false, 0, 0);
}

function render() {
  resize();
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.043, 0.055, 0.078, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  if (positions && N > 0) {
    if (autoFit) fitView(true);
    if (posDirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
      posDirty = false;
    }

    // edges
    if (E > 0) {
      const edgeAlpha = Math.min(0.45, Math.max(0.04, 2500 / E));
      gl.useProgram(edgeProg.prog);
      setCommonUniforms(edgeProg, 1);
      gl.uniform4f(edgeProg.uColor, 0.45, 0.58, 0.85, edgeAlpha);
      bindPositions(edgeProg, posBuf);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, edgeIdxBuf);
      gl.drawElements(gl.LINES, E * 2, edgeIdxType, 0);
    }

    // nodes
    const r = nodeScreenRadius();
    gl.useProgram(nodeProg.prog);
    setCommonUniforms(nodeProg, r * 2);
    bindPositions(nodeProg, posBuf);
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
    gl.enableVertexAttribArray(nodeProg.aColor);
    gl.vertexAttribPointer(nodeProg.aColor, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, N);

    // hovered / dragged highlight (constant yellow via disabled color attrib)
    const hi = dragged >= 0 ? dragged : hovered;
    if (hi >= 0 && hi < N) {
      gl.bindBuffer(gl.ARRAY_BUFFER, highlightBuf);
      gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([positions[hi * 2], positions[hi * 2 + 1]]),
        gl.DYNAMIC_DRAW);
      setCommonUniforms(nodeProg, r * 2 + 7);
      gl.disableVertexAttribArray(nodeProg.aColor);
      gl.vertexAttrib3f(nodeProg.aColor, 1.0, 0.83, 0.3);
      bindPositions(nodeProg, highlightBuf);
      gl.drawArrays(gl.POINTS, 0, 1);
    }
  }

  frames++;
  const now = performance.now();
  if (now - lastFpsTime >= 1000) {
    fps = Math.round(frames * 1000 / (now - lastFpsTime));
    frames = 0;
    lastFpsTime = now;
    statsEl.textContent =
      `ノード: ${N.toLocaleString()}  エッジ: ${E.toLocaleString()}\n` +
      `FPS: ${fps}  シミュレーション温度: ${simAlpha.toFixed(3)}`;
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

// ---------------------------------------------------------------- graph setup
function setGraph(g) {
  N = g.labels.length;
  E = g.edges.length >> 1;
  labels = g.labels;
  positions = null;
  posDirty = false;
  hovered = -1;
  dragged = -1;
  autoFit = true;

  let indices;
  if (index32) {
    indices = g.edges;
    edgeIdxType = gl.UNSIGNED_INT;
  } else {
    if (N > 65535) {
      setStatus('このブラウザでは65535ノードまでしか描画できません。', true);
    }
    indices = new Uint16Array(g.edges);
    edgeIdxType = gl.UNSIGNED_SHORT;
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, edgeIdxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

  // per-node colors (cluster/group coloring); default steel blue
  let colors = g.colors;
  if (!colors || colors.length !== N * 3) {
    colors = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      colors[i * 3] = 0.31; colors[i * 3 + 1] = 0.63; colors[i * 3 + 2] = 1.0;
    }
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
  gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);

  worker.postMessage({ type: 'graph', n: N, edges: g.edges });
}

/*
 * Accepted JSON formats (kept intentionally simple):
 *   nodes: optional array of  "id" | number | {id, label}
 *   edges: array of  [source, target] | {source, target}
 *          (ids refer to node ids; unknown ids are created on the fly
 *           when no node list is given. "links" is accepted as an alias.)
 */
function parseGraph(json) {
  if (typeof json !== 'object' || json === null) {
    throw new Error('JSONオブジェクトではありません');
  }
  const nodesIn = Array.isArray(json.nodes) ? json.nodes : [];
  const edgesIn = Array.isArray(json.edges) ? json.edges
    : Array.isArray(json.links) ? json.links : null;
  if (!edgesIn) throw new Error('"edges" (または "links") がありません');

  const idToIndex = new Map();
  const labels = [];
  const groups = [];
  const explicitNodes = nodesIn.length > 0;

  function addNode(id, label, group) {
    const k = String(id);
    let idx = idToIndex.get(k);
    if (idx === undefined) {
      idx = labels.length;
      idToIndex.set(k, idx);
      labels.push(label != null ? String(label) : k);
      groups.push(group != null ? String(group) : null);
    }
    return idx;
  }

  for (const nd of nodesIn) {
    if (nd !== null && typeof nd === 'object') {
      addNode(nd.id != null ? nd.id : labels.length, nd.label, nd.group);
    } else {
      addNode(nd);
    }
  }

  function resolve(ref) {
    if (ref !== null && typeof ref === 'object' && ref.id != null) ref = ref.id;
    const k = String(ref);
    const idx = idToIndex.get(k);
    if (idx !== undefined) return idx;
    if (explicitNodes) {
      // allow numeric indices into the node list
      if (Number.isInteger(ref) && ref >= 0 && ref < labels.length) return ref;
      throw new Error(`未定義のノードID: ${k}`);
    }
    return addNode(ref);
  }

  const src = [], dst = [];
  for (const ed of edgesIn) {
    let s, t;
    if (Array.isArray(ed) && ed.length >= 2) {
      s = ed[0]; t = ed[1];
    } else if (ed !== null && typeof ed === 'object') {
      s = ed.source; t = ed.target;
    } else {
      continue;
    }
    src.push(resolve(s));
    dst.push(resolve(t));
  }

  if (labels.length === 0) throw new Error('ノードがありません');
  const edges = new Uint32Array(src.length * 2);
  for (let e = 0; e < src.length; e++) {
    edges[e * 2] = src[e];
    edges[e * 2 + 1] = dst[e];
  }

  // optional "group" field on nodes -> cluster coloring
  let colors = null;
  if (groups.some((g) => g !== null)) {
    const groupIdx = new Map();
    colors = new Float32Array(labels.length * 3);
    for (let i = 0; i < labels.length; i++) {
      let rgb = [0.31, 0.63, 1.0];
      if (groups[i] !== null) {
        if (!groupIdx.has(groups[i])) groupIdx.set(groups[i], groupIdx.size);
        rgb = GraphGen.palette(groupIdx.get(groups[i]));
      }
      colors[i * 3] = rgb[0]; colors[i * 3 + 1] = rgb[1]; colors[i * 3 + 2] = rgb[2];
    }
  }
  return { labels, edges, colors };
}

async function init() {
  const url = params.get('graph');
  let g;
  if (url) {
    try {
      setStatus(`読み込み中: ${url}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      g = parseGraph(await res.json());
      setStatus(`読み込み完了: ${url}`);
    } catch (err) {
      setStatus(`グラフを読み込めませんでした (${err.message})。代わりに生成グラフを表示します。`, true);
      g = generateGraph();
    }
  } else {
    g = generateGraph();
  }
  setGraph(g);
  applyModel(); // reflect ?model= and initial slider availability
}

init();

})();
