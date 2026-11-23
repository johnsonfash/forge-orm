/* eslint-disable no-console */
// Real-MySQL proof for 2.24.0 on mysql2 (and mariadb when installed):
//
//   [migrate]     files apply in order; DELIMITER procedures and triggers run
//                 and really fire; a `?` inside a string is not a placeholder
//   [not atomic]  a file failing on statement 3 leaves 1–2 applied, is not
//                 recorded, and the error says so
//   [drift]       a file edited after it ran stops the run
//   [concurrent]  five runners on five separate pools apply each file once
//                 (GET_LOCK)
//   [locks]       FOR UPDATE SKIP LOCKED claims the next row while another
//                 transaction holds the first; NOWAIT fails at once
//   [wide ints]   a bigserial id comes back as a number, f.bigint() as bigint
//   [pool]        killing an idle pooled connection does not exit the process
//
// Env: SMOKE_MYSQL_URL (default mysql://root@127.0.0.1:3306). Creates and
// drops its own database.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import mysql from 'mysql2/promise';
import { createDb, f, model, mysql2Driver } from './src';

const ROOT = process.env.SMOKE_MYSQL_URL ?? 'mysql://root@127.0.0.1:3306';
const DB = `forge_mig_${Date.now().toString(36)}`;
const URL = `${ROOT.replace(/\/$/, '')}/${DB}`;

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `   << ${detail}`}`);
  ok ? pass++ : fail++;
};
const rejects = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as Error; } };
const tmpDir = (files: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mysql-mig-'));
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
  return dir;
};

const Job = model('jobs', { id: f.id({ type: 'bigserial' }), status: f.string(), weight: f.bigint() });
const schema = { job: Job };

async function main() {
  const root = await mysql.createConnection({ uri: ROOT });
  await root.query(`CREATE DATABASE \`${DB}\``);
  const probe = await mysql.createConnection({ uri: URL });
  const q = async (sql: string, p: unknown[] = []) => (await probe.query(sql, p))[0] as any[];
  try {
    console.log('── [migrate]');
    const dir = tmpDir({
      '0001_base.sql': `CREATE TABLE notes (id INT AUTO_INCREMENT PRIMARY KEY, body VARCHAR(64), n INT DEFAULT 0);
INSERT INTO notes (body) VALUES ('what? really; yes');`,
      '0002_routines.sql': `DELIMITER $$
CREATE PROCEDURE bump()
BEGIN
  UPDATE notes SET n = n + 1;
  UPDATE notes SET n = n + 1;
END$$
CREATE TRIGGER notes_bi BEFORE INSERT ON notes FOR EACH ROW
BEGIN
  IF NEW.body IS NULL THEN SET NEW.body = 'default; body'; END IF;
END$$
DELIMITER ;
CALL bump();`,
    });
    const db = await createDb({ url: URL });
    const r = await db.$migrateFiles({ dir });
    check('both files applied', r.applied.length === 2, JSON.stringify(r));
    check('the `?` in a string was stored as written', (await q('SELECT body FROM notes'))[0].body === 'what? really; yes');
    check('the procedure ran both statements', (await q('SELECT n FROM notes'))[0].n === 2);
    await q('INSERT INTO notes (n) VALUES (0)');
    check('the trigger fires', (await q('SELECT body FROM notes WHERE id = 2'))[0].body === 'default; body');
    check('rerun applies nothing', (await db.$migrateFiles({ dir })).applied.length === 0);

    console.log('── [not atomic]');
    fs.writeFileSync(path.join(dir, '0003_bad.sql'), 'CREATE TABLE a1 (id INT);\nCREATE TABLE a2 (id INT);\nINSERT INTO nope VALUES (1);');
    const err = await rejects(db.$migrateFiles({ dir }));
    check('fails naming line 3 and what stayed', !!err && /0003_bad\.sql line 3/.test(err.message) && /2 statements before it stayed applied/.test(err.message), err?.message);
    check('statements 1–2 stayed (MySQL commits DDL)', (await q(`SHOW TABLES LIKE 'a2'`)).length === 1);
    check('not recorded', (await q(`SELECT name FROM _forge_migrations WHERE name = '0003_bad'`)).length === 0);
    fs.unlinkSync(path.join(dir, '0003_bad.sql'));

    console.log('── [drift]');
    fs.appendFileSync(path.join(dir, '0001_base.sql'), '\n-- edited');
    check('an edited file stops the run', /edited after it ran/.test((await rejects(db.$migrateFiles({ dir })))?.message ?? ''));
    await db.$disconnect();

    console.log('── [concurrent]');
    const dir2 = tmpDir(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`000${i}_t.sql`, `CREATE TABLE c${i} (id INT); DO SLEEP(0.05);`])));
    const dbs = await Promise.all([1, 2, 3, 4, 5].map(() => createDb({ url: URL })));
    const reports = await Promise.all(dbs.map((d) => d.$migrateFiles({ dir: dir2, allowUnknown: true })));
    const total = reports.reduce((n, rep) => n + rep.applied.length, 0);
    check('each file applied once across five runners', total === 6, `applied ${total}`);
    await Promise.all(dbs.map((d) => d.$disconnect()));

    console.log('── [locks] + [wide ints]');
    await q('CREATE TABLE jobs (id BIGINT AUTO_INCREMENT PRIMARY KEY, status VARCHAR(16), weight BIGINT)');
    const app = await createDb({ url: URL, schema });
    const a = await app.job.create({ data: { status: 'queued', weight: 9007199254740993n } });
    await app.job.create({ data: { status: 'queued', weight: 1n } });
    check('bigserial id is a number', typeof a.id === 'number', typeof a.id);
    const back = await app.job.findUnique({ where: { id: a.id } });
    check('f.bigint() reads back as an exact bigint', back?.weight === 9007199254740993n, String(back?.weight));
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });
    let claimed: any;
    const t1 = app.$transaction(async (tx: any) => {
      await tx.job.findMany({ where: { id: a.id }, lock: 'update' });
      await held;
    });
    await new Promise((res) => setTimeout(res, 200));
    await app.$transaction(async (tx: any) => {
      claimed = await tx.job.findMany({ orderBy: { id: 'asc' }, take: 1, lock: { mode: 'update', skipLocked: true } });
      const nowait = await rejects(tx.job.findMany({ where: { id: a.id }, lock: { mode: 'update', nowait: true } }));
      check('NOWAIT fails at once on the held row', !!nowait, 'no error');
    }).catch(() => {});
    try {
      // Rows carry an f.bigint() (a BigInt), which plain JSON.stringify refuses.
      const shown = JSON.stringify(claimed, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
      check('SKIP LOCKED claims the second row', claimed?.[0]?.id === a.id + 1, shown);
    } finally {
      release();
      await t1;
    }

    console.log('── [pool]');
    const pool = mysql.createPool({ uri: URL, connectionLimit: 2 });
    const pdb = await createDb({ schema, driver: mysql2Driver(pool) });
    await pdb.job.findMany({});
    const [ids] = await probe.query(`SELECT id FROM information_schema.processlist WHERE db = ? AND id <> CONNECTION_ID() AND command = 'Sleep'`, [DB]);
    for (const row of ids as any[]) await probe.query(`KILL ${row.id}`).catch(() => {});
    await new Promise((res) => setTimeout(res, 300));
    check('process still alive after the idle connection was killed', true);
    check('the next query reconnects', Array.isArray(await pdb.job.findMany({})));
    await pdb.$disconnect();
    await app.$disconnect();
  } finally {
    await probe.end();
    await root.query(`DROP DATABASE IF EXISTS \`${DB}\``);
    await root.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
