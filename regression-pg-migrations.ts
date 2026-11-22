/* eslint-disable no-console */
// Real-Postgres proof for the migration-file runner (`forge migrate` and
// db.$migrateFiles()), over node-postgres AND postgres.js, and through the
// CLI as separate processes.
//
// Each driver gets its own scratch database, created here and dropped at
// the end. Nothing else on the server is touched.
//
// What it proves:
//   [atomic]      a file that fails on statement 3 leaves no trace of 1–2
//                 and no ledger row; the files before it stay applied
//   [plpgsql]     $$ bodies, DO blocks, ;-in-strings and ;-in-comments run
//                 as written, and the triggers they create really fire
//   [real file]   a production migration (PostGIS geography, GIST, CHECK,
//                 citext, an append-only audit trigger) applies unchanged
//   [drift]       a file edited after it ran stops the run
//   [order]       a pending file numbered behind an applied one is refused
//   [no-tx]       CREATE INDEX CONCURRENTLY runs from a forge:no-transaction
//                 file and produces a VALID index
//   [concurrent]  N runners started together apply every file exactly once
//   [cli]         the same through `forge migrate` / `migrate status` /
//                 `rollback`, two CLI processes racing included
//
// Env: SMOKE_PG_USER (default postgres), SMOKE_PG_HOST, SMOKE_PG_PORT.
// Optional ZIMVO_POSTGRES_JS=<path to postgres.js 4.x src/index.js> adds a
// third pass on that version.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pg from 'pg';
import postgres from 'postgres';
import { createDb, postgresJsDriver } from './src';

const USER = process.env.SMOKE_PG_USER ?? 'postgres';
const HOST = process.env.SMOKE_PG_HOST ?? '127.0.0.1';
const PORT = process.env.SMOKE_PG_PORT ?? '5432';
const urlFor = (db: string) => `postgres://${USER}@${HOST}:${PORT}/${db}`;
const ROOT = urlFor('postgres');
const CLI = path.resolve(__dirname, 'dist/scripts/forge-cli.js');

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `   << ${detail}`}`);
  ok ? pass++ : fail++;
};

async function rejects(p: Promise<unknown>): Promise<Error | null> {
  try { await p; return null; } catch (e) { return e as Error; }
}

function tmpDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-migrations-'));
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
  return dir;
}

async function withScratch<T>(tag: string, fn: (url: string) => Promise<T>): Promise<T> {
  const name = `forge_test_mig_${tag}_${Date.now().toString(36)}`;
  const root = new pg.Client({ connectionString: ROOT });
  await root.connect();
  await root.query(`CREATE DATABASE ${name}`);
  await root.end();
  try {
    return await fn(urlFor(name));
  } finally {
    const r = new pg.Client({ connectionString: ROOT });
    await r.connect();
    await r.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await r.end();
  }
}

async function probe(url: string, sql: string, params: unknown[] = []): Promise<any[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
const tableExists = async (url: string, t: string) =>
  (await probe(url, `SELECT to_regclass($1) AS t`, [t]))[0].t !== null;
const ledger = async (url: string) =>
  (await probe(url, `SELECT name, checksum FROM _forge_migrations ORDER BY name`)).map((r) => r.name);

const TRIGGER_FILE = `-- semicolons everywhere a naive split would cut; none of them end a statement
CREATE TABLE notes (
  id         serial PRIMARY KEY,
  body       text NOT NULL DEFAULT 'a; b',   -- a comment; with a semicolon
  updated_at timestamptz NOT NULL DEFAULT 'epoch'
);
/* block comment;
   /* nested; */ still comment; */
CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER notes_touch BEFORE UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION touch();
CREATE FUNCTION greet(who text) RETURNS text LANGUAGE plpgsql AS $body$
BEGIN
  RETURN format($fmt$hello; %s$fmt$, who);
END;
$body$;
DO $$
BEGIN
  INSERT INTO notes (body) VALUES (E'escaped \\' quote; and more');
  INSERT INTO notes (body) VALUES ('it''s; done');
END $$;
`;

async function suite(label: string, makeDb: (url: string) => Promise<any>, tag: string) {
  console.log(`\n── ${label}`);
  await withScratch(tag, async (url) => {
    // ── [atomic] ────────────────────────────────────────────────────────
    const dir = tmpDir({
      '0001_base.sql': 'CREATE TABLE base (id int PRIMARY KEY);',
      '0002_three.sql': [
        'CREATE TABLE one (id int);',
        'INSERT INTO base VALUES (1);',
        'SELECT * FROM table_that_does_not_exist;',
        'CREATE TABLE four (id int);',
      ].join('\n'),
      '0003_after.sql': 'CREATE TABLE after_ (id int);',
    });
    const db = await makeDb(url);
    try {
    const err = await rejects(db.$migrateFiles({ dir }));
    check('[atomic] the run fails', !!err, 'no error');
    check('[atomic] error names the file and says it rolled back',
      !!err && /0002_three\.sql/.test(err.message) && /Rolled back/.test(err.message), err?.message);
    check('[atomic] statement 1 of the failed file left nothing', !(await tableExists(url, 'one')));
    check('[atomic] statement 2 of the failed file left nothing',
      (await probe(url, 'SELECT count(*)::int AS n FROM base'))[0].n === 0);
    check('[atomic] the file before it is applied', await tableExists(url, 'base'));
    check('[atomic] the file after it was not attempted', !(await tableExists(url, 'after_')));
    check('[atomic] ledger holds only 0001', JSON.stringify(await ledger(url)) === '["0001_base"]',
      JSON.stringify(await ledger(url)));

    // Fix the file and re-run: it now applies, and so does the one after.
    fs.writeFileSync(path.join(dir, '0002_three.sql'),
      'CREATE TABLE one (id int);\nINSERT INTO base VALUES (1);\nCREATE TABLE four (id int);');
    const r2 = await db.$migrateFiles({ dir });
    check('[atomic] after the fix, 0002 and 0003 apply',
      r2.applied.map((a: any) => a.name).join() === '0002_three,0003_after', JSON.stringify(r2));
    const r3 = await db.$migrateFiles({ dir });
    check('[idempotent] a second run applies nothing', r3.applied.length === 0 && r3.skipped.length === 3,
      JSON.stringify(r3));

    // ── [drift] ─────────────────────────────────────────────────────────
    fs.appendFileSync(path.join(dir, '0001_base.sql'), '\n-- edited later');
    const drift = await rejects(db.$migrateFiles({ dir }));
    check('[drift] an edited applied file stops the run',
      !!drift && /edited after it ran/.test(drift.message) && /0001_base\.sql/.test(drift.message), drift?.message);
    fs.writeFileSync(path.join(dir, '0001_base.sql'), 'CREATE TABLE base (id int PRIMARY KEY);');

    // ── [order] ─────────────────────────────────────────────────────────
    fs.writeFileSync(path.join(dir, '0000_early.sql'), 'CREATE TABLE early (id int);');
    const ooo = await rejects(db.$migrateFiles({ dir }));
    check('[order] a file numbered behind an applied one is refused',
      !!ooo && /numbered behind/.test(ooo.message), ooo?.message);
    check('[order] ...and nothing ran', !(await tableExists(url, 'early')));
    const forced = await db.$migrateFiles({ dir, allowOutOfOrder: true });
    check('[order] allowOutOfOrder applies it', forced.applied[0]?.name === '0000_early', JSON.stringify(forced));

    // ── [plpgsql] ───────────────────────────────────────────────────────
    const dir2 = tmpDir({ '0001_trigger.sql': TRIGGER_FILE });
    const t = await db.$migrateFiles({ dir: dir2, allowUnknown: true });
    check('[plpgsql] the file applies', t.applied.length === 1, JSON.stringify(t));
    const notes = await probe(url, 'SELECT body FROM notes ORDER BY id');
    check('[plpgsql] the DO block ran both inserts, escapes intact',
      notes.length === 2 && notes[0].body === "escaped ' quote; and more" && notes[1].body === "it's; done",
      JSON.stringify(notes));
    await probe(url, `UPDATE notes SET body = 'x' WHERE id = 1`);
    const touched = await probe(url, `SELECT updated_at > 'epoch' AS ok FROM notes WHERE id = 1`);
    check('[plpgsql] the trigger function fires', touched[0].ok === true);
    const greet = await probe(url, `SELECT greet('you') AS g`);
    check('[plpgsql] nested dollar quotes survive', greet[0].g === 'hello; you', greet[0].g);

    // ── [real file] ─────────────────────────────────────────────────────
    const coreSrc = path.resolve(__dirname, '../zimvoride/apps/backend/migrations/0001_core.sql');
    if (fs.existsSync(coreSrc)) {
      const dir3 = tmpDir({ '0001_core.sql': fs.readFileSync(coreSrc, 'utf8') });
      const core = await db.$migrateFiles({ dir: dir3, allowUnknown: true });
      check('[real file] a production PostGIS + trigger migration applies as written',
        core.applied.length === 1, JSON.stringify(core));
      const gix = await probe(url, `SELECT indexdef FROM pg_indexes WHERE indexname = 'countries_perimeter_gix'`);
      check('[real file] GIST index on the geography column exists', /USING gist/.test(gix[0]?.indexdef ?? ''));
      const bad = await rejects(probe(url, `INSERT INTO countries (code, name, dial_code, currency, currency_exponent) VALUES ('bf', 'x', '+226', 'XOF', 0)`));
      check('[real file] CHECK constraint enforced', !!bad && /check constraint/i.test(bad.message), bad?.message);
      await probe(url, `INSERT INTO audit_log (actor_kind, action) VALUES ('system', 'boot')`);
      const del = await rejects(probe(url, `DELETE FROM audit_log`));
      check('[real file] audit_log refuses DELETE (append-only trigger)', !!del && /append-only/.test(del.message), del?.message);
      const trunc = await rejects(probe(url, `TRUNCATE audit_log`));
      check('[real file] audit_log refuses TRUNCATE', !!trunc && /append-only/.test(trunc.message), trunc?.message);
    } else {
      console.log('  · [real file] skipped: zimvoride 0001_core.sql not found');
    }

    // ── [no-tx] ─────────────────────────────────────────────────────────
    await probe(url, `CREATE TABLE big (id int, v int); INSERT INTO big SELECT g, g FROM generate_series(1, 5000) g`);
    const dir4 = tmpDir({
      '0001_idx.sql': '-- forge:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS big_v_idx ON big (v);\n' +
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS big_id_idx ON big (id);',
    });
    const nt = await db.$migrateFiles({ dir: dir4, allowUnknown: true });
    check('[no-tx] CREATE INDEX CONCURRENTLY file applies', nt.applied.length === 1, JSON.stringify(nt));
    const valid = await probe(url,
      `SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname IN ('big_v_idx', 'big_id_idx')`);
    check('[no-tx] both indexes exist and are VALID', valid.length === 2 && valid.every((r) => r.indisvalid),
      JSON.stringify(valid));
    check('[no-tx] recorded in the ledger', (await ledger(url)).includes('0001_idx'));
    const refused = await rejects(db.$migrateFiles({
      dir: tmpDir({ '0001_c.sql': 'CREATE INDEX CONCURRENTLY x ON big (v);' }),
      allowUnknown: true,
    }));
    check('[no-tx] without the opt-out it is refused before anything runs',
      !!refused && /forge:no-transaction/.test(refused.message), refused?.message);
    } catch (e) {
      check('suite ran to the end', false, (e as Error).message);
    } finally {
      await db.$disconnect();
    }
  });

  // ── [concurrent] ──────────────────────────────────────────────────────
  await withScratch(`${tag}c`, async (url) => {
    const dir = tmpDir({
      '0001_slow.sql': 'CREATE TABLE hits (file text);\nSELECT pg_sleep(0.4);\nINSERT INTO hits VALUES (\'0001\');',
      '0002_more.sql': 'INSERT INTO hits VALUES (\'0002\');\nSELECT pg_sleep(0.2);',
      '0003_last.sql': 'INSERT INTO hits VALUES (\'0003\');',
    });
    const dbs = await Promise.all(Array.from({ length: 5 }, () => makeDb(url)));
    try {
    const reports = await Promise.all(dbs.map((d) => d.$migrateFiles({ dir })));
    const appliedTotal = reports.reduce((n, r) => n + r.applied.length, 0);
    check('[concurrent] 5 runners at once: 3 files applied in total, not 15', appliedTotal === 3,
      JSON.stringify(reports.map((r) => r.applied.map((a: any) => a.name))));
    const hits = await probe(url, `SELECT file, count(*)::int AS n FROM hits GROUP BY file ORDER BY file`);
    check('[concurrent] each file\'s INSERT ran exactly once',
      JSON.stringify(hits) === JSON.stringify([{ file: '0001', n: 1 }, { file: '0002', n: 1 }, { file: '0003', n: 1 }]),
      JSON.stringify(hits));
    check('[concurrent] ledger has exactly 3 rows', (await ledger(url)).length === 3);
    } catch (e) {
      check('[concurrent] runners finished', false, (e as Error).message);
    } finally {
      await Promise.all(dbs.map((d) => d.$disconnect()));
    }
  });
}

function cli(args: string[], env: Record<string, string>, cwd = __dirname): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env, DATABASE_URL: '' } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

async function cliSuite() {
  console.log('\n── CLI (dist/scripts/forge-cli.js, separate processes)');
  if (!fs.existsSync(CLI)) { check('[cli] dist is built (npm run build)', false, CLI); return; }
  await withScratch('cli', async (url) => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cli-'));
    const mig = path.join(project, 'migrations');
    fs.mkdirSync(mig);
    fs.writeFileSync(path.join(mig, '0001_users.sql'), TRIGGER_FILE);
    fs.writeFileSync(path.join(mig, '0002_slow.sql'),
      'CREATE TABLE races (n int);\nSELECT pg_sleep(0.5);\nINSERT INTO races VALUES (1);');
    // A forge generate file: only its -- up runs, -- down is for rollback.
    fs.writeFileSync(path.join(mig, '0003_gen.sql'),
      '-- forge migration: 0003_gen.sql\n\n-- up\nCREATE TABLE gen_a (id int);\nCREATE TABLE gen_b (id int);\n\n' +
      '-- down\nDROP TABLE gen_b;\nDROP TABLE this_table_is_not_there;\nDROP TABLE gen_a;\n');
    const env = { MIGRATION_DATABASE_URL: url };

    const dry = await cli(['migrate', '--dry-run'], env, project);
    check('[cli] migrate --dry-run lists 3 files', dry.code === 0 && (dry.out.match(/would apply/g) ?? []).length === 3, dry.out);
    check('[cli] ...and wrote nothing, not even the ledger table', !(await tableExists(url, '_forge_migrations')));

    const [a, b] = await Promise.all([cli(['migrate'], env, project), cli(['migrate'], env, project)]);
    check('[cli] two processes racing both exit 0', a.code === 0 && b.code === 0, a.out + '\n' + b.out);
    const appliedLines = (a.out + b.out).match(/applied 000\d/g) ?? [];
    check('[cli] between them each file is applied once', appliedLines.length === 3, appliedLines.join(','));
    check('[cli] races INSERT ran once', (await probe(url, 'SELECT count(*)::int AS n FROM races'))[0].n === 1);
    check('[cli] only the -- up of a generate file ran',
      (await tableExists(url, 'gen_a')) && (await tableExists(url, 'gen_b')));

    const st = await cli(['migrate', 'status', '--check'], env, project);
    check('[cli] migrate status --check is clean', st.code === 0 && /3 applied · 0 pending/.test(st.out), st.out);

    const rb = await cli(['rollback'], env, project);
    check('[cli] a rollback whose 2nd statement fails exits non-zero', rb.code !== 0, rb.out);
    check('[cli] ...and is undone entirely: gen_b still there', await tableExists(url, 'gen_b'));
    check('[cli] ...and the ledger row stays', (await ledger(url)).includes('0003_gen'));

    fs.appendFileSync(path.join(mig, '0001_users.sql'), '\n-- tweak');
    const dr = await cli(['migrate'], env, project);
    check('[cli] an edited applied file exits 1 and says so', dr.code === 1 && /edited after/.test(dr.out), dr.out);
  });
}

async function main() {
  await suite('node-postgres (pg)', (url) => createDb({ url }), 'pg');
  await suite('postgres.js 3.x', async (url) =>
    createDb({ driver: postgresJsDriver(postgres(url, { onnotice: () => {} })) }), 'pgjs');

  const v4 = process.env.ZIMVO_POSTGRES_JS
    ?? path.resolve(__dirname, '../zimvoride/apps/backend/node_modules/.pnpm/postgres@4.1.1/node_modules/postgres/src/index.js');
  if (fs.existsSync(v4)) {
    const esmImport = new Function('p', 'return import(p)') as (p: string) => Promise<any>;
    const pg4 = (await esmImport(v4)).default;
    await suite('postgres.js 4.x (the version the app runs)', async (url) =>
      createDb({ driver: postgresJsDriver(pg4(url, { onnotice: () => {} })) }), 'pgjs4');
  }

  await cliSuite();
  console.log(`\n[pg-migrations] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
