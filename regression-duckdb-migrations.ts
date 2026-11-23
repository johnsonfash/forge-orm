/* eslint-disable no-console */
// Real-DuckDB proof (in memory) for 2.24.0:
//
//   [generate]    the whole forge test schema, generated for duckdb, applies
//                 with no statement failing (UNIQUE / CHECK inside CREATE
//                 TABLE, no jsonb, no to_tsvector index)
//   [migrate]     one transaction per file: a failing file leaves nothing
//   [locks]       lock: is refused with DuckDB's reason
//   [wide ints]   bigserial id → number, f.bigint() → bigint
//
// Needs @duckdb/node-api. No env.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { createDb, duckdbDriver, f, model } from './src';
import { generateMigration } from './src/scripts/migrate-gen';
import { schema as testSchema } from './src/schema';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `   << ${detail}`}`);
  ok ? pass++ : fail++;
};
const rejects = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as Error; } };

async function main() {
  console.log('── [generate]');
  const conn = await (await DuckDBInstance.create(':memory:')).connect();
  const failures: string[] = [];
  for (const p of generateMigration(testSchema as any, { kind: 'duckdb', tables: [], views: [] } as any)) {
    if (p.up.startsWith('--')) continue;
    try { await conn.run(p.up); } catch (e: any) { failures.push(`${p.note}: ${e.message.split('\n')[0]}`); }
  }
  check('every generated statement applies', failures.length === 0, failures.join(' | '));

  console.log('── [migrate]');
  const c2 = await (await DuckDBInstance.create(':memory:')).connect();
  const Job = model('jobs', { id: f.id({ type: 'bigserial' }), status: f.string(), weight: f.bigint() });
  const db = await createDb({ schema: { job: Job }, driver: duckdbDriver(c2) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-duck-mig-'));
  fs.writeFileSync(path.join(dir, '0001_jobs.sql'), `CREATE SEQUENCE jobs_seq;
CREATE TABLE jobs (id BIGINT PRIMARY KEY DEFAULT nextval('jobs_seq'), status VARCHAR, weight BIGINT);`);
  fs.writeFileSync(path.join(dir, '0002_bad.sql'), 'CREATE TABLE half (id INT);\nINSERT INTO nope VALUES (1);');
  const err = await rejects(db.$migrateFiles({ dir }));
  check('0002 fails and rolls back', !!err && /Rolled back/.test(err.message), err?.message);
  const half = await db.$queryRaw({ __forgeSql: true, strings: [`SELECT 1 FROM information_schema.tables WHERE table_name = 'half'`], values: [] } as any);
  check('no trace of the failed file', half.length === 0);
  fs.unlinkSync(path.join(dir, '0002_bad.sql'));
  check('rerun is clean', (await db.$migrateFiles({ dir })).applied.length === 0);

  console.log('── [locks] [wide ints]');
  const lockErr = await rejects(db.$transaction((tx: any) => tx.job.findMany({ lock: 'update' })));
  check('lock: refused with the reason', /DuckDB has no row locks/.test(lockErr?.message ?? ''), lockErr?.message);
  const row = await db.job.create({ data: { status: 'q', weight: 9007199254740993n } });
  check('bigserial id is a number', typeof row.id === 'number', typeof row.id);
  check('f.bigint() exact', (await db.job.findUnique({ where: { id: row.id } }))?.weight === 9007199254740993n);
  await db.$disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
