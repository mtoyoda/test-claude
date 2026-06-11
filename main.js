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
uniform vec2 uCenter;
uniform float uScale;
uniform vec2 uViewport;
uniform float uPointSize;
void main() {
  vec2 p = (aPos - uCenter) * uScale;
  gl_Position = vec4(2.0 * p.x / uViewport.x, -2.0 * p.y / uViewport.y, 0.0, 1.0);
  gl_PointSize = uPointSize;
}`;

const NODE_FS = `
precision mediump float;
uniform vec4 uColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float a = 1.0 - smoothstep(0.7, 1.0, r2);
  gl_FragColor = vec4(uColor.rgb, uColor.a * a);
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
    gl.uniform4f(nodeProg.uColor, 0.31, 0.63, 1.0, 0.95);
    bindPositions(nodeProg, posBuf);
    gl.drawArrays(gl.POINTS, 0, N);

    // hovered / dragged highlight
    const hi = dragged >= 0 ? dragged : hovered;
    if (hi >= 0 && hi < N) {
      gl.bindBuffer(gl.ARRAY_BUFFER, highlightBuf);
      gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([positions[hi * 2], positions[hi * 2 + 1]]),
        gl.DYNAMIC_DRAW);
      setCommonUniforms(nodeProg, r * 2 + 7);
      gl.uniform4f(nodeProg.uColor, 1.0, 0.83, 0.3, 1.0);
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

  worker.postMessage({ type: 'graph', n: N, edges: g.edges });
}

// Watts-Strogatz small-world network
function smallWorld(n, k, p) {
  const half = Math.max(1, k >> 1);
  const key = (a, b) => (a < b ? a * n + b : b * n + a);
  const edgeSet = new Set();
  const src = [], dst = [];
  for (let i = 0; i < n; i++) {
    for (let j = 1; j <= half; j++) {
      const t = (i + j) % n;
      if (i === t) continue;
      const kk = key(i, t);
      if (!edgeSet.has(kk)) {
        edgeSet.add(kk);
        src.push(i);
        dst.push(t);
      }
    }
  }
  for (let e = 0; e < src.length; e++) {
    if (Math.random() >= p) continue;
    const s = src[e];
    for (let attempt = 0; attempt < 20; attempt++) {
      const t = Math.floor(Math.random() * n);
      const kk = key(s, t);
      if (t === s || edgeSet.has(kk)) continue;
      edgeSet.delete(key(s, dst[e]));
      edgeSet.add(kk);
      dst[e] = t;
      break;
    }
  }
  const edges = new Uint32Array(src.length * 2);
  const labels = new Array(n);
  for (let i = 0; i < n; i++) labels[i] = 'node-' + i;
  for (let e = 0; e < src.length; e++) {
    edges[e * 2] = src[e];
    edges[e * 2 + 1] = dst[e];
  }
  return { labels, edges };
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
  const explicitNodes = nodesIn.length > 0;

  function addNode(id, label) {
    const k = String(id);
    let idx = idToIndex.get(k);
    if (idx === undefined) {
      idx = labels.length;
      idToIndex.set(k, idx);
      labels.push(label != null ? String(label) : k);
    }
    return idx;
  }

  for (const nd of nodesIn) {
    if (nd !== null && typeof nd === 'object') {
      addNode(nd.id != null ? nd.id : labels.length, nd.label);
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
  return { labels, edges };
}

function intParam(name, def, min, max) {
  const v = parseInt(params.get(name), 10);
  if (!Number.isFinite(v)) return def;
  return Math.min(Math.max(v, min), max);
}

function floatParam(name, def, min, max) {
  const v = parseFloat(params.get(name));
  if (!Number.isFinite(v)) return def;
  return Math.min(Math.max(v, min), max);
}

function generateDefault() {
  const n = intParam('n', 1000, 2, 2000000);
  const k = intParam('k', 6, 2, 100);
  const p = floatParam('p', 0.1, 0, 1);
  setStatus(`スモールワールドネットワークを生成 (n=${n}, k=${k}, p=${p})`);
  return smallWorld(n, k, p);
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
      g = generateDefault();
    }
  } else {
    g = generateDefault();
  }
  setGraph(g);
}

init();

})();
