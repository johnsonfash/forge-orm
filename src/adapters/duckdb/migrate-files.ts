import { splitSqlStatements } from '../../scripts/sql-split';
import {
  LEDGER,
  checkAppliedRow,
  runMigrationFiles,
  runStatements,
  serialiser,
  toLedgerMap,
  type MigrateEngine,
} from '../../scripts/migrate-files-core';
import type { MigrationFile, MigrateFilesOptions, MigrateFilesReport } from '../postgres/migrate-files-types';
import type { DuckdbDriver, DuckdbQueryable } from './driver';

// `forge migrate` on DuckDB. DDL is transactional, so each file runs in one
// transaction with its ledger row.
//
// There is no cross-process lock to take, and none is needed: a DuckDB
// database file is opened read-write by one process at a time. Runs inside
// that process on the same connection are queued, because a connection holds
// one transaction at a time.

const queue = serialiser();

export function applyDuckdbMigrationFiles(
  driver: DuckdbDriver,
  opts: MigrateFilesOptions = {},
): Promise<MigrateFilesReport> {
  return runMigrationFiles(duckdbEngine(driver), opts);
}

export function duckdbEngine(driver: DuckdbDriver): MigrateEngine {
  const hasChecksum = async () =>
    (await driver.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'checksum'`,
      [LEDGER],
    )).rows.length > 0;
  const ensureLedger = async () => {
    await driver.query(
      `CREATE TABLE IF NOT EXISTS ${LEDGER} (name VARCHAR(255) PRIMARY KEY, applied_at VARCHAR(64), checksum VARCHAR(64))`,
      [],
    );
    if (!(await hasChecksum())) await driver.query(`ALTER TABLE ${LEDGER} ADD COLUMN checksum VARCHAR(64)`, []);
  };
  const alreadyApplied = async (q: DuckdbQueryable, f: MigrationFile) =>
    checkAppliedRow(f, (await q.query(`SELECT checksum FROM ${LEDGER} WHERE name = $1 OR name = $2`, [f.name, f.file])).rows);
  const record = (q: DuckdbQueryable, f: MigrationFile) =>
    q.query(`INSERT INTO ${LEDGER} (name, applied_at, checksum) VALUES ($1, $2, $3)`,
      [f.name, new Date().toISOString(), f.checksum]);

  return {
    dialect: 'duckdb',
    run: (fn) => queue(driver, fn),
    hasLedger: async () =>
      (await driver.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1`,
        [LEDGER],
      )).rows.length > 0,
    ensureLedger,
    readLedger: async (dryRun) => {
      const has = await hasChecksum();
      if (!has && !dryRun) await ensureLedger();
      const sel = has || !dryRun ? 'name, checksum' : 'name, NULL AS checksum';
      return toLedgerMap((await driver.query(`SELECT ${sel} FROM ${LEDGER} ORDER BY name`, [])).rows);
    },
    setChecksum: async (raw, checksum) => {
      await driver.query(`UPDATE ${LEDGER} SET checksum = $1 WHERE name = $2`, [checksum, raw]);
    },
    apply: async (f) => {
      const statements = splitSqlStatements(f.sql, 'duckdb');
      if (f.transactional) {
        return driver.transaction(async (tx) => {
          if (await alreadyApplied(tx, f)) return false;
          await runStatements(f, statements, (s) => tx.query(s, []), true);
          await record(tx, f);
          return true;
        });
      }
      if (await alreadyApplied(driver, f)) return false;
      await runStatements(f, statements, (s) => driver.query(s, []), false);
      await record(driver, f);
      return true;
    },
  };
}
