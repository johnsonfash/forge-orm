/* eslint-disable no-console */
//
// Forge canary — a real HTTP service that uses forge as its only data layer,
// so we can watch how forge behaves under sustained, concurrent, real-network
// traffic before trusting it more widely.
//
// Safety: the canary runs against an ISOLATED throwaway database it creates on
// boot and drops on shutdown. It never touches a production database, so a
// forge bug here cannot corrupt real data. To canary *literal* production
// traffic, mirror/shadow requests at the proxy into this service (read-only) —
// that's an infra step on top of this, intentionally not wired by default.
//
// Endpoints exercise the spread that actually stresses a data layer:
//   POST /users                create (indexed unique email)
//   GET  /users/:id            point lookup
//   GET  /posts?status=&take=  filtered + ordered + limited list
//   POST /posts                create (FK to author)
//   GET  /posts/:id            findFirst + include comments (relation hydration)
//   POST /posts/:id/comments   nested-ish write
//   GET  /search?q=            full-text search
//   POST /like                 $transaction (insert like + increment view_count)
//   GET  /stream/posts         findManyStream (large result, constant memory)
//   GET  /health               liveness
//   GET  /metrics              client-visible server-side stats

import * as dotenv from 'dotenv';
dotenv.config();

import * as http from 'http';
import { randomUUID } from 'crypto';
import { createDb } from '../src';
import { schema } from '../src/schema';
import { buildSchemaDDL } from '../src/adapters/postgres/ddl';
import { applyMigration } from '../src/adapters/postgres/migrate';

const PORT = Number(process.env.CANARY_PORT ?? 8787);
const SEED_USERS = Number(process.env.CANARY_SEED_USERS ?? 200);
const SEED_POSTS = Number(process.env.CANARY_SEED_POSTS ?? 600);
const STAMP = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const PG_USER = process.env.SMOKE_PG_USER ?? 'postgres';
const PG_HOST = process.env.SMOKE_PG_HOST ?? '127.0.0.1';
const PG_PORT = process.env.SMOKE_PG_PORT ?? '5432';
const ROOT_DB = process.env.SMOKE_PG_ROOT ?? 'postgres';
const ROOT_URL = `postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/${ROOT_DB}`;
const DB_NAME = `forge_canary_${STAMP}`;
const DB_URL = `postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/${DB_NAME}`;

// ─── Metrics ──────────────────────────────────────────────────────────────
const startedAt = Date.now();
const ep: Record<string, { count: number; errors: number; lat: number[] }> = {};
function rec(name: string, ms: number, ok: boolean) {
  const m = ep[name] ?? (ep[name] = { count: 0, errors: 0, lat: [] });
  m.count++;
  if (!ok) m.errors++;
  if (m.lat.length < 50_000) m.lat.push(ms);
}
const db_stats = { queries: 0, totalMs: 0, slow: 0, errors: 0, maxMs: 0 };
function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

// ─── Boot ───────────────────────────────────────────────────────────────────
let seedUserIds: string[] = [];
let seedPostIds: string[] = [];

async function boot() {
  const { Pool } = require('pg');
  const root = new Pool({ connectionString: ROOT_URL });
  await root.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
  await root.query(`CREATE DATABASE "${DB_NAME}"`);
  await root.end();

  const db = await createDb({ url: DB_URL });
  const pool = (db.adapter as any).pool;
  await applyMigration(pool, buildSchemaDDL(schema as any));

  // forge's own per-query observability — the canary's server-side view.
  db.$on('query', (e) => {
    db_stats.queries++;
    db_stats.totalMs += e.duration_ms;
    if (e.duration_ms > db_stats.maxMs) db_stats.maxMs = e.duration_ms;
    if (e.duration_ms > 50) db_stats.slow++;
  });
  db.$on('error', () => { db_stats.errors++; });

  // Seed baseline data so reads have something to hit.
  const users = Array.from({ length: SEED_USERS }, (_, i) => ({
    id: `u_${i}`, email: `seed${i}@x.co`, name: `Seed ${i}`,
    role: i % 3 === 0 ? 'EDITOR' : 'USER',
  }));
  await db.user.createMany({ data: users as any });
  seedUserIds = users.map((u) => u.id);

  const posts = Array.from({ length: SEED_POSTS }, (_, i) => ({
    id: `p_${i}`, author_id: seedUserIds[i % seedUserIds.length],
    title: `Post ${i}`, slug: `seed-post-${i}`,
    body: `lorem ipsum ${i % 5 === 0 ? 'postgres database forge' : 'content body text'} number ${i}`,
    status: i % 4 === 0 ? 'DRAFT' : 'PUBLISHED', view_count: i % 100,
  }));
  await db.post.createMany({ data: posts as any });
  seedPostIds = posts.map((p) => p.id);

  return db;
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function send(res: http.ServerResponse, code: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(json);
}
function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}
const rndUser = () => seedUserIds[Math.floor(Math.random() * seedUserIds.length)];
const rndPost = () => seedPostIds[Math.floor(Math.random() * seedPostIds.length)];

// ─── Server ───────────────────────────────────────────────────────────────
(async () => {
  const db = await boot();

  const server = http.createServer(async (req, res) => {
    const t0 = performance.now();
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    let label = `${method} ${path}`;
    let ok = true;
    try {
      if (method === 'GET' && path === '/health') {
        return send(res, 200, { ok: true, uptime_s: ((Date.now() - startedAt) / 1000) | 0, db: DB_NAME });
      }
      if (method === 'GET' && path === '/metrics') {
        const endpoints = Object.fromEntries(Object.entries(ep).map(([k, m]) => [k, {
          count: m.count, errors: m.errors,
          p50: +pct(m.lat, 0.5).toFixed(2), p95: +pct(m.lat, 0.95).toFixed(2), p99: +pct(m.lat, 0.99).toFixed(2),
        }]));
        return send(res, 200, {
          uptime_s: ((Date.now() - startedAt) / 1000) | 0,
          memory_mb: +(process.memoryUsage().rss / 1048576).toFixed(1),
          db: { ...db_stats, avgMs: db_stats.queries ? +(db_stats.totalMs / db_stats.queries).toFixed(3) : 0 },
          endpoints,
        });
      }

      if (method === 'POST' && path === '/users') {
        label = 'POST /users';
        await db.user.create({ data: { id: randomUUID(), email: `${randomUUID()}@x.co`, name: 'Canary', role: 'USER' } as any });
        return send(res, 201, { ok: true });
      }
      if (method === 'GET' && /^\/users\/[^/]+$/.test(path)) {
        label = 'GET /users/:id';
        const u = await db.user.findUnique({ where: { id: rndUser() } as any });
        return send(res, 200, u ?? {});
      }
      if (method === 'GET' && path === '/posts') {
        label = 'GET /posts';
        const take = Math.min(50, Number(url.searchParams.get('take') ?? 20));
        const rows = await db.post.findMany({ where: { status: 'PUBLISHED' } as any, orderBy: { view_count: 'desc' }, take });
        return send(res, 200, { count: rows.length });
      }
      if (method === 'POST' && path === '/posts') {
        label = 'POST /posts';
        const id = randomUUID();
        await db.post.create({ data: { id, author_id: rndUser(), title: 'Canary post', slug: `canary-${id}`, body: 'canary body forge database', status: 'PUBLISHED', view_count: 0 } as any });
        return send(res, 201, { id });
      }
      if (method === 'GET' && /^\/posts\/[^/]+$/.test(path)) {
        label = 'GET /posts/:id';
        const p = await db.post.findFirst({ where: { id: rndPost() } as any, include: { comments: true } as any });
        return send(res, 200, { found: !!p, comments: (p as any)?.comments?.length ?? 0 });
      }
      if (method === 'POST' && /^\/posts\/[^/]+\/comments$/.test(path)) {
        label = 'POST /posts/:id/comments';
        await db.comment.create({ data: { id: randomUUID(), post_id: rndPost(), author_id: rndUser(), body: 'nice post' } as any });
        return send(res, 201, { ok: true });
      }
      if (method === 'GET' && path === '/search') {
        label = 'GET /search';
        const q = url.searchParams.get('q') ?? 'forge';
        const rows = await db.post.findMany({ where: { body: { search: q } } as any, take: 20 });
        return send(res, 200, { count: rows.length });
      }
      if (method === 'POST' && path === '/like') {
        label = 'POST /like (tx)';
        const postId = rndPost(); const userId = rndUser();
        await db.$transaction(async (tx) => {
          await tx.like.create({ data: { id: randomUUID(), user_id: userId, post_id: postId, kind: 'LIKE' } as any }).catch(() => { /* dup composite-unique is fine */ });
          await tx.post.update({ where: { id: postId } as any, data: { view_count: { increment: 1 } } as any });
        });
        return send(res, 200, { ok: true });
      }
      if (method === 'GET' && path === '/stream/posts') {
        label = 'GET /stream/posts';
        let n = 0;
        for await (const _row of db.post.findManyStream({ where: { status: 'PUBLISHED' } as any })) n++;
        return send(res, 200, { streamed: n });
      }

      ok = false;
      return send(res, 404, { error: 'not found' });
    } catch (e: any) {
      ok = false;
      return send(res, 500, { error: e?.message ?? String(e) });
    } finally {
      rec(label, performance.now() - t0, ok && res.statusCode < 500);
    }
  });

  server.listen(PORT, () => {
    console.log(`[canary] listening on http://127.0.0.1:${PORT}  db=${DB_NAME}  seed=${SEED_USERS}u/${SEED_POSTS}p`);
    console.log('[canary] endpoints: /users /posts /posts/:id /search /like /stream/posts  (+ /health /metrics)');
  });

  // Clean shutdown — drop the throwaway DB so nothing leaks.
  const shutdown = async () => {
    console.log('\n[canary] shutting down — final metrics:');
    console.log(JSON.stringify({ db: db_stats, endpoints: Object.fromEntries(Object.entries(ep).map(([k, m]) => [k, { count: m.count, errors: m.errors, p95: +pct(m.lat, 0.95).toFixed(2) }])) }, null, 2));
    server.close();
    try { await db.$disconnect(); } catch { /* */ }
    try {
      const { Pool } = require('pg');
      const root = new Pool({ connectionString: ROOT_URL });
      await root.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB_NAME}' AND pid<>pg_backend_pid()`).catch(() => {});
      await root.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`).catch(() => {});
      await root.end();
      console.log(`[canary] dropped ${DB_NAME}`);
    } catch { /* */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((e) => { console.error('[canary] boot failed:', e); process.exit(1); });
