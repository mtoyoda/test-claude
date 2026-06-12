/*
 * generators.js
 * Test graph generators. Loaded as a plain script in the browser
 * (exposes GraphGen) and evaluated directly in the Node smoke tests.
 *
 * Every generator returns:
 *   { labels: string[N], edges: Uint32Array(2E), colors?: Float32Array(3N) }
 */
'use strict';
(function (root) {

  function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60)       { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else              { r = c; b = x; }
    return [r + m, g + m, b + m];
  }

  // visually distinct color for the i-th group (golden-angle hues)
  function palette(i) {
    return hslToRgb((210 + i * 137.508) % 360, 0.62, 0.62);
  }

  function toEdgeArray(src, dst) {
    const edges = new Uint32Array(src.length * 2);
    for (let e = 0; e < src.length; e++) {
      edges[e * 2] = src[e];
      edges[e * 2 + 1] = dst[e];
    }
    return edges;
  }

  function defaultLabels(n, prefix) {
    const labels = new Array(n);
    for (let i = 0; i < n; i++) labels[i] = (prefix || 'node-') + i;
    return labels;
  }

  // G(n,p) sampling with geometric skipping (Batagelj & Brandes),
  // O(n + E) instead of O(n^2). emit(v, w) receives pairs with w < v.
  function sampleER(n, p, emit) {
    if (p <= 0) return;
    if (p >= 1) {
      for (let v = 1; v < n; v++) for (let w = 0; w < v; w++) emit(v, w);
      return;
    }
    const lq = Math.log(1 - p);
    let v = 1, w = -1;
    for (;;) {
      w += 1 + Math.floor(Math.log(1 - Math.random()) / lq);
      while (w >= v) {
        w -= v;
        v++;
        if (v >= n) return;
      }
      emit(v, w);
    }
  }

  // Watts-Strogatz small world: ring lattice of degree k, rewired with prob p
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
    return { labels: defaultLabels(n), edges: toEdgeArray(src, dst) };
  }

  // Barabasi-Albert preferential attachment -> power-law degree distribution.
  // Each new node attaches m edges; targets drawn from the repeated-endpoint
  // list, so the pick probability is proportional to current degree.
  function barabasiAlbert(n, m) {
    m = Math.max(1, Math.min(m, n - 1));
    const src = [], dst = [];
    const repeated = [];
    const picked = new Set();
    for (let v = 1; v < n; v++) {
      const mm = Math.min(m, v);
      picked.clear();
      let attempts = 0;
      while (picked.size < mm) {
        let t;
        if (repeated.length === 0 || attempts++ > 10 * mm) {
          t = Math.floor(Math.random() * v); // uniform fallback
        } else {
          t = repeated[Math.floor(Math.random() * repeated.length)];
        }
        if (t !== v) picked.add(t);
      }
      for (const t of picked) {
        src.push(v);
        dst.push(t);
        repeated.push(v, t);
      }
    }
    return { labels: defaultLabels(n), edges: toEdgeArray(src, dst) };
  }

  // Stochastic block model (planted partition): c clusters, average
  // within-cluster degree kin and between-cluster degree kout.
  // Nodes are colored by cluster.
  function sbm(n, c, kin, kout) {
    c = Math.max(2, Math.min(c, n));
    const blockOf = new Int32Array(n);
    const starts = new Array(c + 1);
    for (let b = 0; b <= c; b++) starts[b] = Math.floor(b * n / c);
    for (let b = 0; b < c; b++) {
      for (let i = starts[b]; i < starts[b + 1]; i++) blockOf[i] = b;
    }

    const src = [], dst = [];
    for (let b = 0; b < c; b++) {
      const start = starts[b], size = starts[b + 1] - start;
      if (size < 2) continue;
      const pIn = Math.min(1, kin / (size - 1));
      sampleER(size, pIn, (v, w) => { src.push(start + v); dst.push(start + w); });
    }
    // cross edges: sample over all pairs, keep only pairs in different blocks
    const pOut = Math.min(1, kout / Math.max(1, n - n / c));
    sampleER(n, pOut, (v, w) => {
      if (blockOf[v] !== blockOf[w]) { src.push(v); dst.push(w); }
    });

    const labels = new Array(n);
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const b = blockOf[i];
      labels[i] = `c${b}-${i}`;
      const [r, g, bl] = palette(b);
      colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = bl;
    }
    return { labels, edges: toEdgeArray(src, dst), colors };
  }

  // Erdos-Renyi random graph with the given average degree
  function erdosRenyi(n, avgK) {
    const p = Math.min(1, avgK / Math.max(1, n - 1));
    const src = [], dst = [];
    sampleER(n, p, (v, w) => { src.push(v); dst.push(w); });
    return { labels: defaultLabels(n), edges: toEdgeArray(src, dst) };
  }

  // 2D square lattice (n is rounded to the nearest square)
  function grid(n) {
    const s = Math.max(2, Math.round(Math.sqrt(n)));
    const labels = new Array(s * s);
    const src = [], dst = [];
    for (let r = 0; r < s; r++) {
      for (let col = 0; col < s; col++) {
        const i = r * s + col;
        labels[i] = `${r},${col}`;
        if (col + 1 < s) { src.push(i); dst.push(i + 1); }
        if (r + 1 < s)   { src.push(i); dst.push(i + s); }
      }
    }
    return { labels, edges: toEdgeArray(src, dst) };
  }

  root.GraphGen = { smallWorld, barabasiAlbert, sbm, erdosRenyi, grid, palette };

})(typeof self !== 'undefined' ? self : globalThis);
