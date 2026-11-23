import { splitSqlStatements } from '../../scripts/sql-split';
import {
  LEDGER,
  MigrationError,
  checkAppliedRow,
  errMessage,
  readMigrationFiles as readFiles,
  runMigrationFiles,
  runStatements,
  toLedgerMap,
  type LedgerRow,
  type MigrateEngine,
} from '../../scripts/migrate-files-core';
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

export { LEDGER, MigrationError };
export type { MigrationFile, MigrateFilesOptions, MigrateFilesReport } from './migrate-files-types';
import type { MigrationFile, MigrateFilesOptions, MigrateFilesReport } from './migrate-files-types';

/** Read and validate every `.sql` file in `dir`, in the order they apply. */
export function readMigrationFiles(dir: string): MigrationFile[] {
  return readFiles(dir, 'postgres');
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
  return runMigrationFiles(postgresEngine(driver), opts);
}

export function postgresEngine(driver: PostgresDriver): MigrateEngine {
  return {
    dialect: 'postgres',
    hasLedger: () => hasLedger(driver),
    ensureLedger: () => ensureLedger(driver),
    readLedger: (dryRun) => readLedger(driver, dryRun),
    setChecksum: async (raw, checksum) => {
      await driver.query(`UPDATE ${LEDGER} SET checksum = $1 WHERE name = $2`, [checksum, raw]);
    },
    apply: (f) => (f.transactional ? applyInTransaction(driver, f) : applyWithoutTransaction(driver, f)),
  };
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
      try {
        await runStatements(f, statements, (s) => conn.query(s, []), false);
      } catch (err) {
        if (err instanceof MigrationError && /CONCURRENTLY/i.test(err.message)) {
          err.message += ` A failed CREATE INDEX CONCURRENTLY can leave an INVALID index behind: ` +
            `drop it before re-running.`;
        }
        throw err;
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
  await runStatements(f, splitSqlStatements(f.sql, 'postgres'), (s) => tx.query(s, []), true);
}

async function alreadyApplied(q: PgQueryable, f: MigrationFile): Promise<boolean> {
  const { rows } = await q.query(
    `SELECT checksum FROM ${LEDGER} WHERE name = $1 OR name = $2`,
    [f.name, f.file],
  );
  return checkAppliedRow(f, rows);
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
  return toLedgerMap(rows);
}

function lineAt(s: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < s.length; i++) if (s.charCodeAt(i) === 10) line++;
  return line;
}
