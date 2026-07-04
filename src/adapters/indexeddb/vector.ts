// Vector similarity — brute-force JS math.
//
// No ANN structure on IDB. Fine for lists of ≤ ~1 k rows × 100–1500 dims.
// Larger workloads should route to `forge-orm/wasm/worker-pro` (sqlite-vec
// HNSW compiled in) or a hosted vector DB.

export type VectorMetric = 'cosine' | 'l2' | 'dot';

export function vectorDistance(a: number[], b: number[], metric: VectorMetric): number {
  if (a.length !== b.length) return Infinity;
  switch (metric) {
    case 'cosine': return 1 - cosineSim(a, b);
    case 'l2':     return Math.sqrt(l2Squared(a, b));
    case 'dot':    return -dot(a, b);
  }
}
function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function cosineSim(a: number[], b: number[]): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : d / denom;
}
function l2Squared(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}
