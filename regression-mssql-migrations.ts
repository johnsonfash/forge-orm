/* eslint-disable no-console */
// Real-SQL-Server proof for 2.24.0. Needs the `mssql` package and a server.
//
//   [migrate]     GO batches; a CREATE PROCEDURE batch applies and runs
//   [atomic]      a file failing in its second batch leaves nothing, and the
//                 ledger holds only the files before it
//   [concurrent]  five runners on five pools apply each file once
//                 (sp_getapplock)
//   [status]      the ledger table is created on SQL Server (no CREATE TABLE
//                 IF NOT EXISTS there)
//   [locks]       WITH (UPDLOCK, ROWLOCK, READPAST) skips a row another
//                 transaction holds
//   [wide ints]   BIGINT IDENTITY id → number (tedious returns a string)
//
// Env: SMOKE_MSSQL_URL, e.g. mssql://sa:Passw0rd!@127.0.0.1:1433/master?encrypt=false
// Creates and drops its own database.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import sql from 'mssql';
import { createDb, f, model, mssqlDriver } from './src';

const ROOT = process.env.SMOKE_MSSQL_URL;
let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `   << ${detail}`}`);
  ok ? pass++ : fail++;
};
const rejects = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as Error; } };

async function main() {
  if (!ROOT) { console.error('set SMOKE_MSSQL_URL'); process.exit(2); }
  const DB = `forge_mig_${Date.now().toString(36)}`;
  const root = await new sql.ConnectionPool(ROOT).connect();
  await root.request().query(`CREATE DATABASE [${DB}]`);
  const url = ROOT.replace(/\/[^/?]*(\?|$)/, `/${DB}$1`);
  const open = async () => new sql.ConnectionPool(url).connect();
  try {
    const Job = model('jobs', { id: f.id({ type: 'bigserial' }), status: f.string() });
    const db = await createDb({ schema: { job: Job }, driver: mssqlDriver(await open()) });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mssql-mig-'));
    fs.writeFileSync(path.join(dir, '0001_jobs.sql'), `CREATE TABLE jobs (id BIGINT IDENTITY PRIMARY KEY, status NVARCHAR(16));
GO
CREATE PROCEDURE add_job @s NVARCHAR(16) AS
BEGIN
  INSERT INTO jobs (status) VALUES (@s);
  INSERT INTO jobs (status) VALUES (N'it''s; queued');
END
GO
EXEC add_job N'queued';`);
    fs.writeFileSync(path.join(dir, '0002_bad.sql'), 'CREATE TABLE half (id INT);\nGO\nINSERT INTO nope VALUES (1);');

    console.log('── [migrate] [atomic]');
    const err = await rejects(db.$migrateFiles({ dir }));
    check('0002 fails and rolls back', !!err && /0002_bad\.sql/.test(err.message) && /Rolled back/.test(err.message), err?.message);
    const q = async (s: string) => (await root.request().query(`USE [${DB}]; ${s}`)).recordset;
    check('the procedure ran', (await q('SELECT COUNT(*) AS c FROM jobs'))[0].c === 2);
    check('no trace of 0002', (await q(`SELECT OBJECT_ID(N'half') AS t`))[0].t === null);
    check('ledger holds 0001 only', JSON.stringify((await q('SELECT name FROM _forge_migrations')).map((r: any) => r.name)) === '["0001_jobs"]');
    fs.unlinkSync(path.join(dir, '0002_bad.sql'));

    console.log('── [concurrent]');
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mssql-race-'));
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(dir2, `000${i}_t.sql`), `CREATE TABLE c${i} (id INT); WAITFOR DELAY '00:00:00.050';`);
    const dbs = await Promise.all([1, 2, 3, 4, 5].map(async () => createDb({ driver: mssqlDriver(await open()) })));
    const reps = await Promise.all(dbs.map((d) => d.$migrateFiles({ dir: dir2, allowUnknown: true })));
    check('each file applied once', reps.reduce((n, r) => n + r.applied.length, 0) === 6);
    await Promise.all(dbs.map((d) => d.$disconnect()));

    console.log('── [locks] [wide ints]');
    const rows = await db.job.findMany({ orderBy: { id: 'asc' } });
    check('BIGINT IDENTITY id is a number', typeof rows[0]?.id === 'number', typeof rows[0]?.id);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const t1 = db.$transaction(async (tx: any) => { await tx.job.findMany({ where: { id: rows[0].id }, lock: 'update' }); await held; });
    await new Promise((r) => setTimeout(r, 200));
    const db2 = await createDb({ schema: { job: Job }, driver: mssqlDriver(await open()) });
    const claimed = await db2.$transaction((tx: any) => tx.job.findMany({ orderBy: { id: 'asc' }, take: 1, lock: { mode: 'update', skipLocked: true } }));
    check('READPAST claims the second row', (claimed as any[])[0]?.id === rows[1].id, JSON.stringify(claimed));
    release();
    await t1;
    await db2.$disconnect();
    await db.$disconnect();
  } finally {
    await root.request().query(`USE master; ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DB}]`).catch(() => {});
    await root.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
