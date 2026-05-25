/* eslint-disable no-console */
//
// db-bench — side-by-side micro-benchmark of forge vs each underlying
// driver, across all four supported dialects.
//
// Each adapter runs the SAME workload, so you can compare:
//   • forge-over-X vs raw-X driver (per-call overhead of going through forge)
//   • dialect-vs-dialect on the same scenarios
//
// Auto-skips adapters whose driver isn't installed OR whose service isn't
// running. Set SKIP_PG=1 / SKIP_MONGO=1 / SKIP_MYSQL=1 / SKIP_SQLITE=1
// to opt out explicitly.
//
// Each run creates an isolated database, seeds N rows, runs M iterations
// per scenario, and drops everything on exit.

import * as dotenv from 'dotenv';
dotenv.config();

import { createDb } from '../src';
import { schema } from '../src/schema';
import { buildSchemaDDL as buildPgDDL } from '../src/adapters/postgres/ddl';
import { applyMigration as applyPgMigration } from '../src/adapters/postgres/migrate';
import { buildSchemaDDL as buildMysqlDDL } from '../src/adapters/mysql/ddl';
import { applyMigration as applyMysqlMigration } from '../src/adapters/mysql/migrate';
import { buildSchemaDDL as buildSqliteDDL } from '../src/adapters/sqlite/ddl';
import { applyMigration as applySqliteMigration } from '../src/adapters/sqlite/migrate';
import { pushAllIndexes as pushMongoIndexes } from '../src/adapters/mongo/scripts/push';

const BENCH_SEED = Number(process.env.BENCH_SEED ?? 500);
const BENCH_ITER = Number(process.env.BENCH_ITER ?? 200);
const STAMP = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

interface Sample { name: string; median: number; p95: number; opsPerSec: number }
type Result = [Sample, Sample];     // [forge, raw]

function timeit(label: string, runs: number[]): Sample {
  const sorted = [...runs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const opsPerSec = 1000 / median;
  return { name: label, median, p95, opsPerSec };
}

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

// ─── Postgres ───────────────────────────────────────────────────────────────

async function benchPg(): Promise<Result[] | null> {
  if (process.env.SKIP_PG === '1') return null;
  try { require('pg'); } catch { return null; }

  const PG_ROOT = process.env.BENCH_PG_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres';
  const DB = `forge_bench_pg_${STAMP}`;
  const URL = PG_ROOT.replace(/\/[^/]*$/, `/${DB}`);

  const { Pool } = await import('pg');
  const rootPool = new (Pool as any)({ connectionString: PG_ROOT });
  try { await rootPool.query(`CREATE DATABASE "${DB}"`); } catch (e: any) { if (!/already exists/.test(e.message)) throw e; }
  finally { await rootPool.end(); }

  console.log(`[bench:pg] database: ${DB}`);
  const db = await createDb({ url: URL });
  const pool = (db.adapter as any).pool;

  try {
    await applyPgMigration(pool, buildPgDDL(schema as any));
    const seed = Array.from({ length: BENCH_SEED }, (_, i) => ({
      id: `u_${i}`, email: `bench${i}@x.co`, name: `User ${i}`,
      role: i % 3 === 0 ? 'EDITOR' : 'USER',
    }));
    await db.user.createMany({ data: seed });

    const r1: number[] = [], r2: number[] = [], r3: number[] = [], r4: number[] = [];
    const w1: number[] = [], w2: number[] = [], w3: number[] = [], w4: number[] = [];

    for (let i = 0; i < BENCH_ITER; i++) {
      r1.push(await timed(() => db.user.findMany({ where: { role: 'EDITOR' }, orderBy: { email: 'asc' }, take: 20 })));
      w1.push(await timed(async () => { await pool.query(`SELECT * FROM "users" WHERE "role" = $1 ORDER BY "email" ASC LIMIT 20`, ['EDITOR']); }));
      const idx = i % BENCH_SEED;
      r2.push(await timed(() => db.user.findFirst({ where: { email: `bench${idx}@x.co` } })));
      w2.push(await timed(async () => { await pool.query(`SELECT * FROM "users" WHERE "email" = $1 LIMIT 1`, [`bench${idx}@x.co`]); }));
      r3.push(await timed(() => db.user.count({ where: { role: 'USER' } })));
      w3.push(await timed(async () => { await pool.query(`SELECT COUNT(*) FROM "users" WHERE "role" = $1`, ['USER']); }));
      r4.push(await timed(() => db.user.update({ where: { id: `u_${idx}` }, data: { active: false } })));
      w4.push(await timed(async () => { await pool.query(`UPDATE "users" SET "active" = $1 WHERE "id" = $2`, [false, `u_${idx}`]); }));
    }

    return [
      [timeit('findMany', r1), timeit('findMany [raw pg]', w1)],
      [timeit('findFirst', r2), timeit('findFirst [raw pg]', w2)],
      [timeit('count', r3), timeit('count [raw pg]', w3)],
      [timeit('update', r4), timeit('update [raw pg]', w4)],
    ];
  } finally {
    await db.$disconnect();
    const cleanup = new (Pool as any)({ connectionString: PG_ROOT });
    await cleanup.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB]).catch(() => {});
    await cleanup.query(`DROP DATABASE IF EXISTS "${DB}"`).catch(() => {});
    await cleanup.end();
    console.log(`[bench:pg] dropped ${DB}`);
  }
}

// ─── MySQL ──────────────────────────────────────────────────────────────────

async function benchMysql(): Promise<Result[] | null> {
  if (process.env.SKIP_MYSQL === '1') return null;
  try { require('mysql2'); } catch { return null; }

  const ROOT = process.env.BENCH_MYSQL_URL ?? 'mysql://root@127.0.0.1:3306';
  const DB = `forge_bench_mysql_${STAMP}`;
  const URL = `${ROOT}/${DB}`;

  const mysql = require('mysql2/promise');
  const root = await mysql.createConnection({ uri: ROOT });
  try { await root.query(`CREATE DATABASE \`${DB}\``); }
  catch (e: any) { if (!/exists/.test(e.message)) throw e; }
  finally { await root.end(); }

  console.log(`[bench:mysql] database: ${DB}`);
  const db = await createDb({ url: URL });
  const pool = (db.adapter as any).pool;

  try {
    await applyMysqlMigration(pool, buildMysqlDDL(schema as any));
    const seed = Array.from({ length: BENCH_SEED }, (_, i) => ({
      id: `u_${i}`, email: `bench${i}@x.co`, name: `User ${i}`,
      role: i % 3 === 0 ? 'EDITOR' : 'USER',
    }));
    await db.user.createMany({ data: seed });

    const r1: number[] = [], r2: number[] = [], r3: number[] = [], r4: number[] = [];
    const w1: number[] = [], w2: number[] = [], w3: number[] = [], w4: number[] = [];

    for (let i = 0; i < BENCH_ITER; i++) {
      r1.push(await timed(() => db.user.findMany({ where: { role: 'EDITOR' }, orderBy: { email: 'asc' }, take: 20 })));
      w1.push(await timed(async () => { await pool.query('SELECT * FROM `users` WHERE `role` = ? ORDER BY `email` ASC LIMIT 20', ['EDITOR']); }));
      const idx = i % BENCH_SEED;
      r2.push(await timed(() => db.user.findFirst({ where: { email: `bench${idx}@x.co` } })));
      w2.push(await timed(async () => { await pool.query('SELECT * FROM `users` WHERE `email` = ? LIMIT 1', [`bench${idx}@x.co`]); }));
      r3.push(await timed(() => db.user.count({ where: { role: 'USER' } })));
      w3.push(await timed(async () => { await pool.query('SELECT COUNT(*) FROM `users` WHERE `role` = ?', ['USER']); }));
      r4.push(await timed(() => db.user.update({ where: { id: `u_${idx}` }, data: { active: false } })));
      w4.push(await timed(async () => { await pool.execute('UPDATE `users` SET `active` = ? WHERE `id` = ?', [0, `u_${idx}`]); }));
    }

    return [
      [timeit('findMany', r1), timeit('findMany [raw mysql]', w1)],
      [timeit('findFirst', r2), timeit('findFirst [raw mysql]', w2)],
      [timeit('count', r3), timeit('count [raw mysql]', w3)],
      [timeit('update', r4), timeit('update [raw mysql]', w4)],
    ];
  } finally {
    await db.$disconnect();
    const cleanup = await mysql.createConnection({ uri: ROOT });
    await cleanup.query(`DROP DATABASE IF EXISTS \`${DB}\``).catch(() => {});
    await cleanup.end();
    console.log(`[bench:mysql] dropped ${DB}`);
  }
}

// ─── SQLite (in-memory) ─────────────────────────────────────────────────────

async function benchSqlite(): Promise<Result[] | null> {
  if (process.env.SKIP_SQLITE === '1') return null;
  try { require('better-sqlite3'); } catch { return null; }

  console.log(`[bench:sqlite] in-memory database`);
  const db = await createDb({ url: 'sqlite::memory:' });
  const handle = (db.adapter as any).db;

  try {
    await applySqliteMigration(handle, buildSqliteDDL(schema as any));
    const seed = Array.from({ length: BENCH_SEED }, (_, i) => ({
      id: `u_${i}`, email: `bench${i}@x.co`, name: `User ${i}`,
      role: i % 3 === 0 ? 'EDITOR' : 'USER',
    }));
    await db.user.createMany({ data: seed });

    const r1: number[] = [], r2: number[] = [], r3: number[] = [], r4: number[] = [];
    const w1: number[] = [], w2: number[] = [], w3: number[] = [], w4: number[] = [];

    const stmtFindMany = handle.prepare('SELECT * FROM "users" WHERE "role" = ? ORDER BY "email" ASC LIMIT 20');
    const stmtFindFirst = handle.prepare('SELECT * FROM "users" WHERE "email" = ? LIMIT 1');
    const stmtCount = handle.prepare('SELECT COUNT(*) AS c FROM "users" WHERE "role" = ?');
    const stmtUpdate = handle.prepare('UPDATE "users" SET "active" = ? WHERE "id" = ?');

    for (let i = 0; i < BENCH_ITER; i++) {
      r1.push(await timed(() => db.user.findMany({ where: { role: 'EDITOR' }, orderBy: { email: 'asc' }, take: 20 })));
      w1.push(await timed(async () => { stmtFindMany.all('EDITOR'); }));
      const idx = i % BENCH_SEED;
      r2.push(await timed(() => db.user.findFirst({ where: { email: `bench${idx}@x.co` } })));
      w2.push(await timed(async () => { stmtFindFirst.get(`bench${idx}@x.co`); }));
      r3.push(await timed(() => db.user.count({ where: { role: 'USER' } })));
      w3.push(await timed(async () => { stmtCount.get('USER'); }));
      r4.push(await timed(() => db.user.update({ where: { id: `u_${idx}` }, data: { active: false } })));
      w4.push(await timed(async () => { stmtUpdate.run(0, `u_${idx}`); }));
    }

    return [
      [timeit('findMany', r1), timeit('findMany [raw sqlite]', w1)],
      [timeit('findFirst', r2), timeit('findFirst [raw sqlite]', w2)],
      [timeit('count', r3), timeit('count [raw sqlite]', w3)],
      [timeit('update', r4), timeit('update [raw sqlite]', w4)],
    ];
  } finally {
    await db.$disconnect();
    console.log('[bench:sqlite] in-memory dropped');
  }
}

// ─── Mongo ──────────────────────────────────────────────────────────────────

async function benchMongo(): Promise<Result[] | null> {
  if (process.env.SKIP_MONGO === '1') return null;
  try { require('mongodb'); } catch { return null; }

  const DB = `forge_bench_mongo_${STAMP}`;
  const URL = (process.env.BENCH_MONGO_URL ?? 'mongodb://127.0.0.1:27017') + `/${DB}`;
  console.log(`[bench:mongo] database: ${DB}`);

  const db = await createDb({ url: URL });
  const { dbClient } = await import('../src/adapters/mongo/client');
  const usersColl = dbClient.db.collection('users');

  try {
    await pushMongoIndexes();
    const seed = Array.from({ length: BENCH_SEED }, (_, i) => ({
      email: `bench${i}@x.co`, name: `User ${i}`,
      role: i % 3 === 0 ? 'EDITOR' : 'USER',
    }));
    await db.user.createMany({ data: seed });
    const sample: any = await db.user.findFirst({ where: { email: 'bench0@x.co' } });
    const sampleId = sample.id;

    const r1: number[] = [], r2: number[] = [], r3: number[] = [], r4: number[] = [];
    const w1: number[] = [], w2: number[] = [], w3: number[] = [], w4: number[] = [];

    for (let i = 0; i < BENCH_ITER; i++) {
      r1.push(await timed(() => db.user.findMany({ where: { role: 'EDITOR' }, orderBy: { email: 'asc' }, take: 20 })));
      w1.push(await timed(async () => { await usersColl.find({ role: 'EDITOR' }).sort({ email: 1 }).limit(20).toArray(); }));
      const idx = i % BENCH_SEED;
      r2.push(await timed(() => db.user.findFirst({ where: { email: `bench${idx}@x.co` } })));
      w2.push(await timed(async () => { await usersColl.findOne({ email: `bench${idx}@x.co` }); }));
      r3.push(await timed(() => db.user.count({ where: { role: 'USER' } })));
      w3.push(await timed(async () => { await usersColl.countDocuments({ role: 'USER' }); }));
      r4.push(await timed(() => db.user.update({ where: { id: sampleId }, data: { active: false } })));
      w4.push(await timed(async () => {
        const { ObjectId } = await import('mongodb');
        await usersColl.findOneAndUpdate({ _id: ObjectId.createFromHexString(sampleId) }, { $set: { active: false } }, { returnDocument: 'after' });
      }));
    }

    return [
      [timeit('findMany', r1), timeit('findMany [raw mongo]', w1)],
      [timeit('findFirst', r2), timeit('findFirst [raw mongo]', w2)],
      [timeit('count', r3), timeit('count [raw mongo]', w3)],
      [timeit('update', r4), timeit('update [raw mongo]', w4)],
    ];
  } finally {
    try { await dbClient.db.dropDatabase(); } catch { /* */ }
    await db.$disconnect();
    console.log(`[bench:mongo] dropped ${DB}`);
  }
}

// ─── Report ─────────────────────────────────────────────────────────────────

function report(label: string, rows: Result[]) {
  console.log(`\n  ${label.padEnd(10)} — ${BENCH_ITER} iter, ${BENCH_SEED} seed rows`);
  console.log(`  ${'op'.padEnd(28)} ${'median'.padStart(10)} ${'p95'.padStart(10)} ${'ops/s'.padStart(10)} ${'overhead'.padStart(10)}`);
  console.log(`  ${'─'.repeat(28)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);
  for (const [forge, raw] of rows) {
    const overhead = ((forge.median - raw.median) / raw.median) * 100;
    const sign = overhead >= 0 ? '+' : '';
    console.log(`  ${forge.name.padEnd(28)} ${(forge.median.toFixed(2) + 'ms').padStart(10)} ${(forge.p95.toFixed(2) + 'ms').padStart(10)} ${forge.opsPerSec.toFixed(0).padStart(10)} ${(sign + overhead.toFixed(1) + '%').padStart(10)}`);
    console.log(`  ${('  ' + raw.name).padEnd(28)} ${(raw.median.toFixed(2) + 'ms').padStart(10)} ${(raw.p95.toFixed(2) + 'ms').padStart(10)} ${raw.opsPerSec.toFixed(0).padStart(10)}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

(async () => {
  console.log(`forge db-bench  seed=${BENCH_SEED} iter=${BENCH_ITER}`);
  console.log('  forge wraps each driver call — overhead = (forge_median - raw_median) / raw_median');

  const pg     = await benchPg().catch((e) => { console.log(`[bench:pg] skipped: ${e.message}`);     return null; });
  const mysql  = await benchMysql().catch((e) => { console.log(`[bench:mysql] skipped: ${e.message}`); return null; });
  const sqlite = await benchSqlite().catch((e) => { console.log(`[bench:sqlite] skipped: ${e.message}`);return null; });
  const mongo  = await benchMongo().catch((e) => { console.log(`[bench:mongo] skipped: ${e.message}`); return null; });

  console.log('\n════════════════════════════════════════════════════════════════════════════');
  if (sqlite) report('sqlite',   sqlite);
  if (pg)     report('postgres', pg);
  if (mysql)  report('mysql',    mysql);
  if (mongo)  report('mongo',    mongo);
  console.log('════════════════════════════════════════════════════════════════════════════\n');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
