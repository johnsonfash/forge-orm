import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { splitSqlStatements } from '../../scripts/sql-split';
import { hasUpDownSections, parseMigrationFile } from '../../scripts/migrate-runtime';
import type { PgQueryable, PostgresDriver } from './driver';
import { ADVISORY_LOCK_HI, ADVISORY_LOCK_LO } from './migrate';

// The migrations-folder runner for Postgres: `forge migrate` and
// `db.$migrateFiles()`.
//
// Each file is all-or-nothing. It runs in its own transaction together with
// the ledger row that records it, so a file that fails on its third statement
// leaves no trace of the first two and no row saying it ran. Postgres DDL is
// transactional, so this costs nothing — the one exception is the handful of
// statements Postgres refuses inside a transaction block (CREATE INDEX
// CONCURRENTLY and friends), which a file opts out for explicitly with a
// `-- forge:no-transaction` line. Nothing is ever downgraded silently.
//
// Two app instances booting at once serialise on the same advisory lock
// `forge push` takes, and each re-reads the ledger after acquiring it, so a
// file is applied exactly once however many runners start together.

export const LEDGER = '_forge_migrations';

const NO_TX_DIRECTIVE = /^--[ \t]*forge:no-transaction[ \t]*\r?$/im;

// Statements Postgres will not run inside a transaction block. Caught before
// anything runs, so the message can name the file and the fix.
const CANNOT_RUN_IN_TX: Array<[RegExp, string]> = [
  [/^CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i, 'CREATE INDEX CONCURRENTLY'],
  [/^DROP\s+INDEX\s+CONCURRENTLY\b/i, 'DROP INDEX CONCURRENTLY'],
  [/^REINDEX\b[\s\S]*\bCONCURRENTLY\b/i, 'REINDEX … CONCURRENTLY'],
  [/^ALTER\s+TABLE\b[\s\S]*\bDETACH\s+PARTITION\b[\s\S]*\bCONCURRENTLY\b/i, 'DETACH PARTITION … CONCURRENTLY'],
  [/^VACUUM\b/i, 'VACUUM'],
  [/^(CREATE|DROP)\s+DATABASE\b/i, 'CREATE/DROP DATABASE'],
  [/^(CREATE|DROP)\s+TABLESPACE\b/i, 'CREATE/DROP TABLESPACE'],
  [/^ALTER\s+SYSTEM\b/i, 'ALTER SYSTEM'],
  [/^CREATE\s+SUBSCRIPTION\b/i, 'CREATE SUBSCRIPTION'],
];

// A file's own BEGIN/COMMIT would end the runner's transaction early and
// commit the file without its ledger row — the exact half-state this runner
// exists to prevent — so it is refused rather than tolerated.
const TX_CONTROL = /^(BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT)\b|^ROLLBACK\b(?!\s+(TO|PREPARED)\b)/i;

export type { MigrationFile, MigrateFilesOptions, MigrateFilesReport } from './migrate-files-types';
import type { MigrationFile, MigrateFilesOptions, MigrateFilesReport } from './migrate-files-types';

export class MigrationError extends Error {
  constructor(message: string, readonly migration?: string, readonly cause?: unknown) {
    super(message);
    this.name = 'MigrationError';
  }
}

const normalise = (s: string) => s.replace(/\r\n/g, '\n');
const sha256 = (s: string) => createHash('sha256').update(normalise(s)).digest('hex');
const ledgerName = (s: string) => s.replace(/\.sql$/i, '');

/** Read and validate every `.sql` file in `dir`, in the order they apply. */
export function readMigrationFiles(dir: string): MigrationFile[] {
  if (!fs.existsSync(dir)) return [];
  const names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.sql')).sort();
  return names.map((file) => {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const sql = hasUpDownSections(text) ? parseMigrationFile(text).up : text;
    const transactional = !NO_TX_DIRECTIVE.test(text);
    const m: MigrationFile = { name: ledgerName(file), file, sql, checksum: sha256(sql), transactional };
    validate(m);
    return m;
  });
}

function validate(m: MigrationFile): void {
  const statements = splitSqlStatements(m.sql, 'postgres');
  if (statements.length === 0) {
    throw new MigrationError(
      `[forge:migrate] ${m.file} has no SQL to run. Recording it as applied would ` +
        `make the ledger say something happened that did not. Write the statements, ` +
        `or delete the file.`,
      m.name,
    );
  }
  for (const s of statements) {
    if (TX_CONTROL.test(s.sql)) {
      throw new MigrationError(
        `[forge:migrate] ${m.file} line ${s.line}: '${s.sql}'. Each file already runs in ` +
          `its own transaction, together with its ledger row; a COMMIT inside it would ` +
          `commit the file without the row. Remove the BEGIN/COMMIT lines.`,
        m.name,
      );
    }
    if (!m.transactional) continue;
    const hit = CANNOT_RUN_IN_TX.find(([re]) => re.test(s.sql));
    if (hit) {
      throw new MigrationError(
        `[forge:migrate] ${m.file} line ${s.line}: ${hit[1]} cannot run inside a ` +
          `transaction. Put it in a file of its own that starts with the line\n` +
          `  -- forge:no-transaction\n` +
          `Such a file runs one statement at a time and is NOT all-or-nothing, so ` +
          `write it to be safe to re-run (IF NOT EXISTS).`,
        m.name,
      );
    }
  }
}

/**
 * Apply every pending migration file in order. Throws on the first failure,
 * after which nothing from that file is in the database and later files have
 * not been touched.
 */
export async function applyMigrationFiles(
  driver: PostgresDriver,
  opts: MigrateFilesOptions = {},
): Promise<MigrateFilesReport> {
  const log = opts.logger ?? (() => {});
  const dir = path.resolve(opts.dir ?? path.join(process.cwd(), 'migrations'));
  const files = readMigrationFiles(dir);
  const report: MigrateFilesReport = { applied: [], skipped: [], pending: [] };

  const ledgerExists = await hasLedger(driver);
  if (!opts.dryRun && !ledgerExists) await ensureLedger(driver);
  const ledger = ledgerExists || !opts.dryRun
    ? await readLedger(driver, !!opts.dryRun)
    : new Map<string, LedgerRow>();

  const byName = new Map(files.map((f) => [f.name, f]));
  const changed = files.filter((f) => {
    const sum = ledger.get(f.name)?.checksum;
    return sum != null && sum !== f.checksum;
  });
  if (changed.length) {
    throw new MigrationError(
      `[forge:migrate] ${changed.length} migration${changed.length === 1 ? ' was' : 's were'} ` +
        `edited after ${changed.length === 1 ? 'it' : 'they'} ran:\n` +
        changed.map((f) => `  ${f.file}`).join('\n') +
        `\nThe database has the old version. Put the file back as it was and add a new ` +
        `migration for the change.`,
      changed[0]!.name,
    );
  }

  const unknown = [...ledger.keys()].filter((n) => !byName.has(n));
  if (unknown.length && !opts.allowUnknown) {
    throw new MigrationError(
      `[forge:migrate] the database has applied migrations that are not in ${dir}:\n` +
        unknown.map((n) => `  ${n}`).join('\n') +
        `\nSomebody ran another branch against it. Find that branch, or pass ` +
        `--allow-unknown (allowUnknown: true) if you know why.`,
    );
  }

  const pending = files.filter((f) => !ledger.has(f.name));
  const applied = files.filter((f) => ledger.has(f.name));
  const highest = applied.length ? applied[applied.length - 1]!.name : null;
  const behind = highest ? pending.filter((f) => f.name < highest) : [];
  if (behind.length && !opts.allowOutOfOrder) {
    throw new MigrationError(
      `[forge:migrate] pending migration${behind.length === 1 ? '' : 's'} numbered behind ` +
        `${highest}, which is already applied:\n` +
        behind.map((f) => `  ${f.file}`).join('\n') +
        `\nRenumber ${behind.length === 1 ? 'it' : 'them'} after ${highest}, or pass ` +
        `--allow-out-of-order (allowOutOfOrder: true) to apply as they stand.`,
    );
  }

  // A row from before checksums were recorded is adopted now, once, rather
  // than left unverified forever.
  for (const f of applied) {
    const row = ledger.get(f.name)!;
    if (row.checksum === null && !opts.dryRun) {
      await driver.query(`UPDATE ${LEDGER} SET checksum = $1 WHERE name = $2`, [f.checksum, row.raw]);
      log(`recorded checksum for ${f.file} (it had none)`);
    }
    report.skipped.push(f.name);
  }

  if (opts.dryRun) {
    report.pending = pending.map((f) => f.name);
    for (const f of pending) log(`would apply ${f.file}${f.transactional ? '' : ' (no transaction)'}`);
    if (!pending.length) log('nothing to apply');
    return report;
  }

  for (let k = 0; k < pending.length; k++) {
    const f = pending[k]!;
    const t0 = Date.now();
    let ran: boolean;
    try {
      ran = f.transactional ? await applyInTransaction(driver, f) : await applyWithoutTransaction(driver, f);
    } catch (err) {
      report.pending = pending.slice(k).map((p) => p.name);
      throw err;
    }
    if (ran) {
      const ms = Date.now() - t0;
      report.applied.push({ name: f.name, ms });
      log(`applied ${f.file} (${ms} ms)`);
    } else {
      report.skipped.push(f.name);
      log(`${f.file} was applied by another runner`);
    }
  }
  if (!report.applied.length) log('nothing to apply');
  return report;
}

async function applyInTransaction(driver: PostgresDriver, f: MigrationFile): Promise<boolean> {
  return driver.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1, $2)', [ADVISORY_LOCK_HI, ADVISORY_LOCK_LO]);
    if (await alreadyApplied(tx, f)) return false;
    await runScript(tx, f);
    await record(tx, f);
    return true;
  });
}

async function applyWithoutTransaction(driver: PostgresDriver, f: MigrationFile): Promise<boolean> {
  if (typeof driver.reserve !== 'function') {
    throw new MigrationError(
      `[forge:migrate] ${f.file} is marked forge:no-transaction, which needs one ` +
        `connection held across its statements, and this driver cannot reserve one. ` +
        `Use pgDriver or postgresJsDriver (postgres.js 3.4+).`,
      f.name,
    );
  }
  const conn = await driver.reserve();
  try {
    await conn.query('SELECT pg_advisory_lock($1, $2)', [ADVISORY_LOCK_HI, ADVISORY_LOCK_LO]);
    try {
      if (await alreadyApplied(conn, f)) return false;
      const statements = splitSqlStatements(f.sql, 'postgres');
      for (let i = 0; i < statements.length; i++) {
        const s = statements[i]!;
        try {
          await conn.query(s.sql, []);
        } catch (err) {
          throw new MigrationError(
            `[forge:migrate] ${f.file} line ${s.line} (statement ${i + 1} of ${statements.length}): ` +
              `${errMessage(err)}\n` +
              (i > 0
                ? `This file is forge:no-transaction, so the ${i} statement${i === 1 ? '' : 's'} ` +
                  `before it stayed applied. It is not recorded; fix it and re-run.`
                : `Nothing from this file was applied, and it is not recorded.`) +
              (/CONCURRENTLY/i.test(s.sql)
                ? ` A failed CREATE INDEX CONCURRENTLY can leave an INVALID index behind: ` +
                  `drop it before re-running.`
                : ''),
            f.name,
            err,
          );
        }
      }
      await record(conn, f);
      return true;
    } finally {
      await conn.query('SELECT pg_advisory_unlock($1, $2)', [ADVISORY_LOCK_HI, ADVISORY_LOCK_LO]);
    }
  } finally {
    await conn.release();
  }
}

/**
 * Send the file as written when the session can take a multi-statement
 * script, which leaves every quoting rule to the server. Otherwise split it
 * with the lexer and send one statement at a time — same transaction either
 * way, so the result is the same all-or-nothing.
 */
async function runScript(tx: PgQueryable, f: MigrationFile): Promise<void> {
  if (typeof tx.exec === 'function') {
    try {
      await tx.exec(f.sql);
    } catch (err) {
      const pos = Number((err as { position?: unknown })?.position);
      const where = Number.isFinite(pos) && pos > 0 ? ` line ${lineAt(f.sql, pos - 1)}` : '';
      throw new MigrationError(
        `[forge:migrate] ${f.file}${where}: ${errMessage(err)}\n` +
          `Rolled back: nothing from this file is in the database, and it is not recorded.`,
        f.name,
        err,
      );
    }
    return;
  }
  const statements = splitSqlStatements(f.sql, 'postgres');
  for (let i = 0; i < statements.length; i++) {
    const s = statements[i]!;
    try {
      await tx.query(s.sql, []);
    } catch (err) {
      throw new MigrationError(
        `[forge:migrate] ${f.file} line ${s.line} (statement ${i + 1} of ${statements.length}): ` +
          `${errMessage(err)}\nRolled back: nothing from this file is in the database, ` +
          `and it is not recorded.`,
        f.name,
        err,
      );
    }
  }
}

async function alreadyApplied(q: PgQueryable, f: MigrationFile): Promise<boolean> {
  const { rows } = await q.query(
    `SELECT checksum FROM ${LEDGER} WHERE name = $1 OR name = $2`,
    [f.name, f.file],
  );
  if (!rows.length) return false;
  const sum = rows[0].checksum as string | null;
  if (sum != null && sum !== f.checksum) {
    throw new MigrationError(
      `[forge:migrate] ${f.file} was edited after it ran. Put it back and add a new migration.`,
      f.name,
    );
  }
  return true;
}

async function record(q: PgQueryable, f: MigrationFile): Promise<void> {
  await q.query(
    `INSERT INTO ${LEDGER} (name, applied_at, checksum) VALUES ($1, $2, $3)`,
    [f.name, new Date().toISOString(), f.checksum],
  );
}

async function hasLedger(driver: PostgresDriver): Promise<boolean> {
  const { rows } = await driver.query(`SELECT to_regclass($1) AS t`, [LEDGER]);
  return rows[0]?.t != null;
}

// The table is the portable one `forge diff apply` and `forge rollback` have
// always used, plus a checksum column. Created under the lock, because two
// concurrent CREATE TABLE IF NOT EXISTS can still collide on the catalog.
async function ensureLedger(driver: PostgresDriver): Promise<void> {
  await driver.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1, $2)', [ADVISORY_LOCK_HI, ADVISORY_LOCK_LO]);
    await tx.query(`SET LOCAL client_min_messages = warning`, []);
    await tx.query(
      `CREATE TABLE IF NOT EXISTS ${LEDGER} (name VARCHAR(255) PRIMARY KEY, applied_at VARCHAR(64))`,
      [],
    );
    await tx.query(`ALTER TABLE ${LEDGER} ADD COLUMN IF NOT EXISTS checksum VARCHAR(64)`, []);
  });
}

interface LedgerRow { raw: string; checksum: string | null }

async function readLedger(driver: PostgresDriver, dryRun: boolean): Promise<Map<string, LedgerRow>> {
  const { rows: cols } = await driver.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'checksum'`,
    [LEDGER],
  );
  // A ledger written by `forge diff apply` before checksums existed.
  if (!cols.length && !dryRun) await ensureLedger(driver);
  const sel = cols.length || !dryRun ? 'name, checksum' : 'name, NULL AS checksum';
  const { rows } = await driver.query(`SELECT ${sel} FROM ${LEDGER} ORDER BY name`, []);
  return new Map(rows.map((r) => [
    ledgerName(String(r.name)),
    { raw: String(r.name), checksum: (r.checksum as string | null) ?? null },
  ]));
}

function lineAt(s: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < s.length; i++) if (s.charCodeAt(i) === 10) line++;
  return line;
}

function errMessage(err: unknown): string {
  return (err as { message?: string })?.message ?? String(err);
}
