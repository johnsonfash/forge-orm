/* eslint-disable no-console */
//
// drivers-postgres — findUnique throughput, forge against the driver it runs on.
//
//   npx tsx bench/drivers-postgres.ts
//
// 20 000 lookups by an indexed column, 50 in flight, pool of 10, for:
//   raw postgres.js (prepared, and prepare: false), forge + postgresJsDriver
//   (both settings), raw pg, forge + pgDriver.
//
// forge + postgresJsDriver used to run at the rate of raw postgres.js with
// prepare: false, because sql.unsafe() does not prepare unless asked. The
// prepared rows below should now be close to each other.
//
// Needs `pg` and `postgres` installed and a server at BENCH_PG_URL
// (default postgres://postgres@127.0.0.1:5432/postgres). Creates and drops
// its own database.

import { createDb, f, model } from '../src';
import { pgDriver, postgresJsDriver } from '../src/adapters/postgres/driver';

const ROOT = process.env.BENCH_PG_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres';
const TOTAL = Number(process.env.BENCH_TOTAL ?? 20_000);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 50);
const POOL = Number(process.env.BENCH_POOL ?? 10);
const ROWS = 1_000;
const DB = `forge_bench_drivers_${Date.now()}`;
const URL = ROOT.replace(/\/[^/]*$/, `/${DB}`);

const Account = model('bench_accounts', {
  id: f.id(),
  email: f.string().unique(),
  name: f.string(),
});
const schema = { account: Account };

async function run(label: string, one: (i: number) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < 500; i++) await one(i);
  let next = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < TOTAL) await one(next++);
  }));
  const s = (performance.now() - t0) / 1000;
  console.log(`${label.padEnd(40)} ${Math.round(TOTAL / s).toLocaleString().padStart(8)} q/s`);
}

async function main(): Promise<void> {
  const { Pool } = require('pg');
  const postgres = require('postgres');
  const admin = new Pool({ connectionString: ROOT, max: 1 });
  await admin.query(`CREATE DATABASE "${DB}"`);
  const setup = new Pool({ connectionString: URL, max: 1 });
  try {
    await setup.query(`CREATE TABLE bench_accounts (id text PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL)`);
    await setup.query(
      `INSERT INTO bench_accounts SELECT 'a' || g, 'u' || g || '@x.co', 'User ' || g FROM generate_series(1, ${ROWS}) g`,
    );
    const email = (i: number) => `u${(i % ROWS) + 1}@x.co`;
    const SQL = `SELECT id, email, name FROM bench_accounts WHERE email = $1 LIMIT 1`;

    for (const prepare of [true, false]) {
      const sql = postgres(URL, { max: POOL, prepare, onnotice: () => {} });
      await run(`raw postgres.js prepare:${prepare}`, (i) => sql.unsafe(SQL, [email(i)], { prepare }));
      await sql.end();
    }
    for (const prepare of [true, false]) {
      const sql = postgres(URL, { max: POOL, prepare, onnotice: () => {} });
      const db = await createDb({ schema, driver: postgresJsDriver(sql) });
      await run(`forge + postgresJsDriver prepare:${prepare}`, (i) => db.account.findUnique({ where: { email: email(i) } }));
      await db.$disconnect();
    }

    const pool = new Pool({ connectionString: URL, max: POOL });
    await run('raw pg', (i) => pool.query(SQL, [email(i)]));
    await pool.end();
    const db = await createDb({ schema, driver: pgDriver(new Pool({ connectionString: URL, max: POOL })) });
    await run('forge + pgDriver', (i) => db.account.findUnique({ where: { email: email(i) } }));
    await db.$disconnect();
  } finally {
    await setup.end();
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB]).catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${DB}"`);
    await admin.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
