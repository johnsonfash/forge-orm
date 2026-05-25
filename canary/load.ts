/* eslint-disable no-console */
//
// Forge canary — concurrent load generator. Drives a realistic, weighted mix
// of read/write/search/transaction traffic at the canary service over real
// HTTP, with N concurrent workers for a fixed duration, then reports
// client-side throughput + latency percentiles + error rate, and pulls the
// service's server-side /metrics for the forge view.
//
//   CANARY_URL=http://127.0.0.1:8787  CONCURRENCY=64  DURATION_MS=30000

const BASE = process.env.CANARY_URL ?? 'http://127.0.0.1:8787';
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 64);
const DURATION_MS = Number(process.env.DURATION_MS ?? 30_000);

// Weighted request mix — read-heavy, like most real apps (~80/20 read/write).
type Req = { name: string; weight: number; run: () => Promise<Response> };
const reqs: Req[] = [
  { name: 'GET /posts',               weight: 30, run: () => fetch(`${BASE}/posts?take=20`) },
  { name: 'GET /posts/:id',           weight: 20, run: () => fetch(`${BASE}/posts/x`) },
  { name: 'GET /users/:id',           weight: 15, run: () => fetch(`${BASE}/users/x`) },
  { name: 'GET /search',              weight: 10, run: () => fetch(`${BASE}/search?q=forge`) },
  { name: 'GET /stream/posts',        weight: 3,  run: () => fetch(`${BASE}/stream/posts`) },
  { name: 'POST /posts',              weight: 8,  run: () => fetch(`${BASE}/posts`, { method: 'POST' }) },
  { name: 'POST /posts/:id/comments', weight: 7,  run: () => fetch(`${BASE}/posts/x/comments`, { method: 'POST' }) },
  { name: 'POST /users',              weight: 4,  run: () => fetch(`${BASE}/users`, { method: 'POST' }) },
  { name: 'POST /like (tx)',          weight: 3,  run: () => fetch(`${BASE}/like`, { method: 'POST' }) },
];
const totalWeight = reqs.reduce((s, r) => s + r.weight, 0);
function pick(): Req {
  let n = Math.random() * totalWeight;
  for (const r of reqs) { if ((n -= r.weight) <= 0) return r; }
  return reqs[0];
}

const stats: Record<string, { ok: number; err: number; lat: number[] }> = {};
function rec(name: string, ms: number, ok: boolean) {
  const s = stats[name] ?? (stats[name] = { ok: 0, err: 0, lat: [] });
  ok ? s.ok++ : s.err++;
  if (s.lat.length < 100_000) s.lat.push(ms);
}
function pct(a: number[], p: number) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; }

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`canary not reachable at ${BASE} after 30s`);
}

async function worker(deadline: number) {
  while (Date.now() < deadline) {
    const r = pick();
    const t0 = performance.now();
    try { const resp = await r.run(); rec(r.name, performance.now() - t0, resp.status < 500); }
    catch { rec(r.name, performance.now() - t0, false); }
  }
}

(async () => {
  console.log(`[load] target=${BASE} concurrency=${CONCURRENCY} duration=${DURATION_MS}ms`);
  await waitReady();
  const t0 = Date.now();
  const deadline = t0 + DURATION_MS;
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(deadline)));
  const elapsed = (Date.now() - t0) / 1000;

  let totalOk = 0, totalErr = 0; const allLat: number[] = [];
  for (const s of Object.values(stats)) { totalOk += s.ok; totalErr += s.err; allLat.push(...s.lat); }
  const total = totalOk + totalErr;

  console.log(`\n════ client-side results ════`);
  console.log(`  requests:    ${total}   (${(total / elapsed).toFixed(0)} req/s over ${elapsed.toFixed(1)}s)`);
  console.log(`  errors:      ${totalErr}  (${((totalErr / total) * 100).toFixed(2)}%)`);
  console.log(`  latency ms:  p50=${pct(allLat, 0.5).toFixed(2)}  p95=${pct(allLat, 0.95).toFixed(2)}  p99=${pct(allLat, 0.99).toFixed(2)}  max=${Math.max(...allLat).toFixed(1)}`);
  console.log(`\n  per-endpoint:`);
  console.log(`  ${'endpoint'.padEnd(28)} ${'reqs'.padStart(8)} ${'err'.padStart(6)} ${'p50'.padStart(7)} ${'p95'.padStart(7)} ${'p99'.padStart(7)}`);
  for (const [name, s] of Object.entries(stats).sort((a, b) => (b[1].ok + b[1].err) - (a[1].ok + a[1].err))) {
    console.log(`  ${name.padEnd(28)} ${(s.ok + s.err).toString().padStart(8)} ${s.err.toString().padStart(6)} ${pct(s.lat, 0.5).toFixed(2).padStart(7)} ${pct(s.lat, 0.95).toFixed(2).padStart(7)} ${pct(s.lat, 0.99).toFixed(2).padStart(7)}`);
  }

  try {
    const m = await (await fetch(`${BASE}/metrics`)).json();
    console.log(`\n════ server-side (forge view) ════`);
    console.log(`  rss memory:  ${m.memory_mb} MB`);
    console.log(`  db queries:  ${m.db.queries}   avg=${m.db.avgMs}ms  max=${m.db.maxMs}ms  slow(>50ms)=${m.db.slow}  errors=${m.db.errors}`);
  } catch { /* */ }
})().catch((e) => { console.error('[load]', e); process.exit(1); });
