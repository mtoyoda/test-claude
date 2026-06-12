// Smoke test for the graph generators. Usage: node test-generators.mjs
import { readFileSync } from 'fs';

(0, eval)(readFileSync(new URL('./generators.js', import.meta.url), 'utf8'));
const G = globalThis.GraphGen;

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'ok ' : 'NG '} ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) failures++;
}

function degrees(n, edges) {
  const d = new Uint32Array(n);
  for (let e = 0; e < edges.length; e += 2) { d[edges[e]]++; d[edges[e + 1]]++; }
  return d;
}

function validIndices(n, edges) {
  for (const v of edges) if (v >= n) return false;
  return true;
}

// Watts-Strogatz: exact edge count n*k/2, valid indices
{
  const { labels, edges } = G.smallWorld(1000, 6, 0.1);
  check('smallWorld edge count', edges.length / 2 === 3000, `${edges.length / 2}`);
  check('smallWorld indices', validIndices(1000, edges));
  check('smallWorld labels', labels.length === 1000 && labels[5] === 'node-5');
}

// Barabasi-Albert: power-law-ish degrees -> big hubs, avg degree ~ 2m
{
  const n = 3000, m = 3;
  const { edges } = G.barabasiAlbert(n, m);
  const deg = degrees(n, edges);
  const avg = edges.length / n;
  const max = Math.max(...deg);
  const big = deg.filter((d) => d >= 5 * avg).length;
  check('BA indices', validIndices(n, edges));
  check('BA avg degree ~ 2m', avg > 4.5 && avg < 6.5, avg.toFixed(2));
  check('BA has hubs (power-law tail)', max >= 10 * avg && big >= 5,
    `max=${max} avg=${avg.toFixed(1)} nodes>=5*avg: ${big}`);
}

// SBM: most edges inside clusters, colors per cluster
{
  const n = 900, c = 6;
  const { edges, colors, labels } = G.sbm(n, c, 8, 1);
  const blockOf = (i) => Math.min(c - 1, Math.floor(i / (n / c)));
  let inside = 0;
  for (let e = 0; e < edges.length; e += 2) {
    if (blockOf(edges[e]) === blockOf(edges[e + 1])) inside++;
  }
  const frac = inside / (edges.length / 2);
  const avg = edges.length / n;
  check('SBM indices', validIndices(n, edges));
  check('SBM avg degree ~ kin+kout', avg > 7 && avg < 11, avg.toFixed(2));
  check('SBM within-cluster fraction high', frac > 0.7, frac.toFixed(2));
  check('SBM colors present', colors && colors.length === n * 3);
  check('SBM labels carry cluster', labels[0].startsWith('c0-'));
}

// Erdos-Renyi: average degree close to k
{
  const n = 5000, k = 6;
  const { edges } = G.erdosRenyi(n, k);
  const avg = edges.length / n;
  check('ER indices', validIndices(n, edges));
  check('ER avg degree ~ k', avg > 5.4 && avg < 6.6, avg.toFixed(2));
}

// grid: s^2 nodes, 2*s*(s-1) edges
{
  const { labels, edges } = G.grid(100);
  check('grid size', labels.length === 100 && edges.length / 2 === 180,
    `${labels.length} nodes ${edges.length / 2} edges`);
}

console.log(failures === 0 ? 'PASS' : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
