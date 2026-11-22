/* eslint-disable no-console */
// Real-Postgres proof for row locks through the normal query API:
//   tx.<model>.findFirst / findMany / findUnique({ …, lock })
// over node-postgres AND postgres.js, with two real connections and timing.
//
//   [update]      a FOR UPDATE held by A makes B's FOR UPDATE wait, and
//                 pg_stat_activity shows B waiting on a Lock while it does
//   [skipLocked]  a work-queue claim skips the row A holds, immediately
//   [nowait]      NOWAIT fails at once with lock_not_available (55P03)
//   [share]       two FOR SHAREs coexist; FOR UPDATE waits for both
//   [ambient]     db.<model> inside a $transaction callback locks too
//   [guard]       lock outside a transaction is refused, not silently a no-op
//
// Scratch database created and dropped here. SMOKE_PG_USER etc. as usual.

import pg from 'pg';
import postgres from 'postgres';
import { createDb, postgresJsDriver } from './src';
import { f, model } from './src/schema/core';
import { buildSchemaDDL } from './src/adapters/postgres/ddl';

const USER = process.env.SMOKE_PG_USER ?? 'postgres';
const HOST = process.env.SMOKE_PG_HOST ?? '127.0.0.1';
const PORT = process.env.SMOKE_PG_PORT ?? '5432';
const urlFor = (db: string) => `postgres://${USER}@${HOST}:${PORT}/${db}`;

const Job = model('lock_jobs', {
  id: f.id(),
  status: f.string(),
  n: f.int().default(0),
});
const schema = { job: Job } as const;

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `   << ${detail}`}`);
  ok ? pass++ : fail++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function admin(url: string, sql: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}

async function suite(label: string, db: any, url: string) {
  console.log(`\n── ${label}`);
  await db.job.deleteMany({});
  for (const id of ['a', 'b', 'c']) await db.job.create({ data: { id, status: 'queued' } });

  // ── [update] ────────────────────────────────────────────────────────
  {
    let releaseA!: () => void;
    const hold = new Promise<void>((r) => (releaseA = r));
    let aLocked!: () => void;
    const locked = new Promise<void>((r) => (aLocked = r));
    const A = db.$transaction(async (tx: any) => {
      await tx.job.findFirst({ where: { id: 'a' }, lock: 'update' });
      aLocked();
      await hold;
      await tx.job.update({ where: { id: 'a' }, data: { n: { increment: 1 } } });
    });
    await locked;
    const t0 = Date.now();
    const B = db.$transaction(async (tx: any) => {
      const row = await tx.job.findFirst({ where: { id: 'a' }, lock: 'update' });
      return { waited: Date.now() - t0, n: row.n };
    });
    await sleep(400);
    const waiting = await admin(url,
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE%'`);
    check('[update] B is waiting on a Lock in pg_stat_activity', waiting[0].n === 1, JSON.stringify(waiting));
    await sleep(400);
    releaseA();
    await A;
    const b = await B;
    check('[update] B waited until A committed (>= 750 ms)', b.waited >= 750, `${b.waited} ms`);
    check("[update] B then read A's committed write (n = 1)", b.n === 1, String(b.n));
  }

  // ── [skipLocked] ────────────────────────────────────────────────────
  {
    let releaseA!: () => void;
    const hold = new Promise<void>((r) => (releaseA = r));
    let aLocked!: (id: string) => void;
    const locked = new Promise<string>((r) => (aLocked = r));
    const A = db.$transaction(async (tx: any) => {
      const [row] = await tx.job.findMany({
        where: { status: 'queued' }, orderBy: { id: 'asc' }, take: 1,
        lock: { mode: 'update', skipLocked: true },
      });
      aLocked(row.id);
      await hold;
    });
    const aGot = await locked;
    const t0 = Date.now();
    const bGot = await db.$transaction(async (tx: any) => {
      const rows = await tx.job.findMany({
        where: { status: 'queued' }, orderBy: { id: 'asc' }, take: 1,
        lock: { mode: 'update', skipLocked: true },
      });
      return rows.map((r: any) => r.id);
    });
    const ms = Date.now() - t0;
    releaseA();
    await A;
    check('[skipLocked] A claimed a', aGot === 'a', aGot);
    check('[skipLocked] B claimed b, skipping the row A holds', bGot.join() === 'b', bGot.join());
    check('[skipLocked] ...without waiting (< 300 ms)', ms < 300, `${ms} ms`);
  }

  // ── [nowait] ────────────────────────────────────────────────────────
  {
    let releaseA!: () => void;
    const hold = new Promise<void>((r) => (releaseA = r));
    let aLocked!: () => void;
    const locked = new Promise<void>((r) => (aLocked = r));
    const A = db.$transaction(async (tx: any) => {
      await tx.job.findUnique({ where: { id: 'c' }, lock: 'update' });
      aLocked();
      await hold;
    });
    await locked;
    const t0 = Date.now();
    let err: any = null;
    try {
      await db.$transaction((tx: any) => tx.job.findUnique({ where: { id: 'c' }, lock: { mode: 'update', nowait: true } }));
    } catch (e) { err = e; }
    const ms = Date.now() - t0;
    releaseA();
    await A;
    const code = err?.code ?? err?.cause?.code ?? err?.meta?.code;
    check('[nowait] B fails instead of waiting', !!err && ms < 300, `${ms} ms, ${err?.message}`);
    check('[nowait] with lock_not_available', /could not obtain lock/.test(err?.message ?? '') || code === '55P03',
      `${code} ${err?.message}`);
  }

  // ── [share] ─────────────────────────────────────────────────────────
  {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let readers = 0;
    let bothIn!: () => void;
    const both = new Promise<void>((r) => (bothIn = r));
    const reader = () => db.$transaction(async (tx: any) => {
      await tx.job.findFirst({ where: { id: 'b' }, lock: 'share' });
      if (++readers === 2) bothIn();
      await hold;
    });
    const R1 = reader();
    const R2 = reader();
    const t0 = Date.now();
    await Promise.race([both, sleep(2000)]);
    check('[share] two FOR SHARE locks are held at once', readers === 2 && Date.now() - t0 < 1000, `${readers}`);
    const t1 = Date.now();
    const W = db.$transaction(async (tx: any) => {
      await tx.job.findFirst({ where: { id: 'b' }, lock: 'update' });
      return Date.now() - t1;
    });
    await sleep(500);
    release();
    await Promise.all([R1, R2]);
    const waited = await W;
    check('[share] FOR UPDATE waits for the shared holders (>= 450 ms)', waited >= 450, `${waited} ms`);
  }

  // ── [ambient] ───────────────────────────────────────────────────────
  {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let aLocked!: () => void;
    const locked = new Promise<void>((r) => (aLocked = r));
    const A = db.$transaction(async () => {
      // `db`, not `tx`: the ambient session carries the lock.
      await db.job.findFirst({ where: { id: 'a' }, lock: 'update' });
      aLocked();
      await hold;
    });
    await locked;
    let err: any = null;
    try {
      await db.$transaction((tx: any) => tx.job.findFirst({ where: { id: 'a' }, lock: { mode: 'update', nowait: true } }));
    } catch (e) { err = e; }
    release();
    await A;
    check('[ambient] db.job inside a $transaction callback holds the lock', !!err, 'B got the row');
  }

  // ── [guard] ─────────────────────────────────────────────────────────
  {
    let err: any = null;
    try { await db.job.findFirst({ where: { id: 'a' }, lock: 'update' }); } catch (e) { err = e; }
    check('[guard] lock outside a transaction is refused', /outside a transaction locks nothing/.test(err?.message ?? ''),
      err?.message ?? 'no error');
  }
}

async function main() {
  const name = `forge_test_lock_${Date.now().toString(36)}`;
  await admin(urlFor('postgres'), `CREATE DATABASE ${name}`);
  const url = urlFor(name);
  try {
    const ddl = new pg.Client({ connectionString: url });
    await ddl.connect();
    for (const s of buildSchemaDDL(schema as any)) await ddl.query(s.sql);
    await ddl.end();

    const viaPg = await createDb({ url, schema: schema as any });
    try { await suite('node-postgres (pg)', viaPg, url); } finally { await viaPg.$disconnect(); }

    const sql = postgres(url, { onnotice: () => {} });
    const viaJs = await createDb({ schema: schema as any, driver: postgresJsDriver(sql) });
    try { await suite('postgres.js', viaJs, url); } finally { await viaJs.$disconnect(); }
  } finally {
    await admin(urlFor('postgres'), `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
  console.log(`\n[pg-locking] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
