/* eslint-disable no-console */
// Real-SQLite proof for `forge migrate` on a database FILE, with two
// separate connections (as two processes would have) and through the CLI.
//
//   [atomic]      a file failing on statement 3 leaves nothing; ledger clean
//   [trigger]     a CREATE TRIGGER … BEGIN … END body applies and fires
//   [concurrent]  two connections to one file, five runs each: every file
//                 applied once (BEGIN IMMEDIATE serialises them)
//   [cli]         `forge migrate`, `forge migrate status`, `forge rollback`
//                 against DATABASE_URL=file:… (needs `npm run build` first)
//   [wide ints]   bigserial id → number, f.bigint() → bigint
//
// No env needed. Writes only under the OS temp directory.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { createDb, f, model } from './src';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `   << ${detail}`}`);
  ok ? pass++ : fail++;
};
const rejects = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as Error; } };
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sqlite-mig-'));
const CLI = path.resolve(__dirname, 'dist/scripts/forge-cli.js');

async function main() {
  const file = path.join(work, 'app.db');
  const url = `file:${file}`;
  const probe = () => new Database(file);
  const migDir = path.join(work, 'migrations');
  fs.mkdirSync(migDir);
  fs.writeFileSync(path.join(migDir, '0001_base.sql'), `CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT, n INTEGER DEFAULT 0);
CREATE TRIGGER notes_bump AFTER INSERT ON notes
BEGIN
  UPDATE notes SET n = CASE WHEN NEW.body LIKE '%;%' THEN 2 ELSE 1 END WHERE id = NEW.id;
END;`);
  fs.writeFileSync(path.join(migDir, '0002_bad.sql'), `CREATE TABLE half (id INTEGER);\nINSERT INTO notes (body) VALUES ('x');\nINSERT INTO nope VALUES (1);`);

  console.log('── [atomic] [trigger]');
  const db = await createDb({ url });
  const err = await rejects(db.$migrateFiles({ dir: migDir }));
  check('0002 fails, naming line 3, rolled back', !!err && /0002_bad\.sql line 3/.test(err.message) && /Rolled back/.test(err.message), err?.message);
  const p = probe();
  check('no trace of statement 1', !p.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'half'`).get());
  check('no trace of statement 2', (p.prepare('SELECT COUNT(*) c FROM notes').get() as any).c === 0);
  check('ledger holds 0001 only', JSON.stringify(p.prepare('SELECT name FROM _forge_migrations').all().map((r: any) => r.name)) === '["0001_base"]');
  p.prepare(`INSERT INTO notes (body) VALUES ('a;b')`).run();
  check('the trigger fires', (p.prepare('SELECT n FROM notes').get() as any).n === 2);
  p.close();
  fs.unlinkSync(path.join(migDir, '0002_bad.sql'));
  await db.$disconnect();

  console.log('── [concurrent]');
  const dir2 = path.join(work, 'm2');
  fs.mkdirSync(dir2);
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(dir2, `000${i}_t.sql`), `CREATE TABLE c${i} (id INTEGER);`);
  const file2 = path.join(work, 'race.db');
  const a = await createDb({ url: `file:${file2}` });
  const b = await createDb({ url: `file:${file2}` });
  const reports = await Promise.all([...Array(5)].flatMap(() => [a.$migrateFiles({ dir: dir2 }), b.$migrateFiles({ dir: dir2 })]));
  const total = reports.reduce((n, r) => n + r.applied.length, 0);
  check('each file applied once across two connections', total === 6, `applied ${total}`);
  await a.$disconnect();
  await b.$disconnect();

  console.log('── [cli]');
  if (!fs.existsSync(CLI)) {
    console.log('  (skipped: run `npm run build` first)');
  } else {
    const env = { ...process.env, DATABASE_URL: `file:${path.join(work, 'cli.db')}` };
    const cliDir = path.join(work, 'cli');
    fs.mkdirSync(path.join(cliDir, 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(cliDir, 'migrations', '0001_x.sql'), '-- up\nCREATE TABLE x (id INTEGER);\n-- down\nDROP TABLE x;\n');
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: cliDir, env, encoding: 'utf8' });
    const m = run('migrate');
    check('forge migrate applies', m.status === 0 && /applied 0001_x/.test(m.stdout), m.stdout + m.stderr);
    const s = run('migrate', 'status', '--check');
    check('forge migrate status is clean', s.status === 0, s.stdout + s.stderr);
    const r = run('rollback');
    check('forge rollback runs the down', r.status === 0 && /rolled back '0001_x'/.test(r.stdout), r.stdout + r.stderr);
  }

  console.log('── [wide ints]');
  const Job = model('jobs', { id: f.id({ type: 'bigserial' }), weight: f.bigint() });
  const wdb = await createDb({ url: `file:${path.join(work, 'w.db')}`, schema: { job: Job } });
  await wdb.$executeRaw({ __forgeSql: true, strings: ['CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, weight INTEGER)'], values: [] } as any);
  const row = await wdb.job.create({ data: { weight: 5n } });
  check('bigserial id is a number', typeof row.id === 'number', typeof row.id);
  check('f.bigint() is a bigint', (await wdb.job.findUnique({ where: { id: row.id } }))?.weight === 5n);
  await wdb.$disconnect();

  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
