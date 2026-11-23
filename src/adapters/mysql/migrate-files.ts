import { splitSqlStatements } from '../../scripts/sql-split';
import {
  LEDGER,
  MigrationError,
  checkAppliedRow,
  runMigrationFiles,
  runStatements,
  toLedgerMap,
  type MigrateEngine,
} from '../../scripts/migrate-files-core';
import type { MigrationFile, MigrateFilesOptions, MigrateFilesReport } from '../postgres/migrate-files-types';
import type { MysqlDriver, MysqlQueryable } from './driver';

// `forge migrate` on MySQL and MariaDB.
//
// A file here is NOT all-or-nothing. MySQL commits every DDL statement the
// moment it runs (an "implicit commit"), so there is no transaction that
// could hold a file's CREATE TABLE and its ledger row together. Each file
// runs one statement at a time and its ledger row is written after the
// last; a file that fails on statement three leaves one and two applied and
// is not recorded. Write files to be safe to re-run (IF NOT EXISTS), the
// same contract as a Postgres `-- forge:no-transaction` file. A file may
// wrap its data changes in START TRANSACTION … COMMIT itself.
//
// The whole run holds GET_LOCK('forge_migrate') on one connection, so two
// runners started together apply each file once.

export const LOCK_NAME = 'forge_migrate';
const LOCK_TIMEOUT_S = 3600;

export function applyMysqlMigrationFiles(
  driver: MysqlDriver,
  opts: MigrateFilesOptions = {},
): Promise<MigrateFilesReport> {
  return runMigrationFiles(mysqlEngine(driver), opts);
}

const rowsOf = (r: [any, any]): any[] => (Array.isArray(r[0]) ? r[0] : []);

export function mysqlEngine(driver: MysqlDriver): MigrateEngine {
  let q: MysqlQueryable = driver;
  const hasChecksum = async () =>
    rowsOf(await q.query(
      `SELECT 1 AS x FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'checksum'`,
      [LEDGER],
    )).length > 0;
  const ensureLedger = async () => {
    await q.query(
      `CREATE TABLE IF NOT EXISTS ${LEDGER} (name VARCHAR(255) PRIMARY KEY, applied_at VARCHAR(64), checksum VARCHAR(64))`,
      [],
    );
    if (!(await hasChecksum())) await q.query(`ALTER TABLE ${LEDGER} ADD COLUMN checksum VARCHAR(64)`, []);
  };
  const alreadyApplied = async (f: MigrationFile) =>
    checkAppliedRow(f, rowsOf(await q.query(`SELECT checksum FROM ${LEDGER} WHERE name = ? OR name = ?`, [f.name, f.file])));

  return {
    dialect: 'mysql',
    run: async (fn) => {
      if (typeof driver.reserve !== 'function') {
        throw new MigrationError(
          `[forge:migrate] this MySQL driver cannot hold a connection, and the migration ` +
            `lock (GET_LOCK) belongs to one connection. Run migrations through mysql2Driver ` +
            `or mariadbDriver (a PlanetScale HTTP connection cannot do this; point ` +
            `MIGRATION_DATABASE_URL at a direct mysql:// URL instead).`,
        );
      }
      const conn = await driver.reserve();
      try {
        const got = rowsOf(await conn.query(`SELECT GET_LOCK(?, ?) AS l`, [LOCK_NAME, LOCK_TIMEOUT_S]))[0]?.l;
        if (Number(got) !== 1) {
          throw new MigrationError(
            `[forge:migrate] could not take the migration lock '${LOCK_NAME}' within ` +
              `${LOCK_TIMEOUT_S}s (GET_LOCK returned ${got}). Another runner is holding it.`,
          );
        }
        q = conn;
        try {
          return await fn();
        } finally {
          q = driver;
          await conn.query(`SELECT RELEASE_LOCK(?)`, [LOCK_NAME]);
        }
      } finally {
        await conn.release();
      }
    },
    hasLedger: async () =>
      rowsOf(await q.query(
        `SELECT 1 AS x FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
        [LEDGER],
      )).length > 0,
    ensureLedger,
    readLedger: async (dryRun) => {
      const has = await hasChecksum();
      if (!has && !dryRun) await ensureLedger();
      const sel = has || !dryRun ? 'name, checksum' : 'name, NULL AS checksum';
      return toLedgerMap(rowsOf(await q.query(`SELECT ${sel} FROM ${LEDGER} ORDER BY name`, [])));
    },
    setChecksum: async (raw, checksum) => {
      await q.query(`UPDATE ${LEDGER} SET checksum = ? WHERE name = ?`, [checksum, raw]);
    },
    apply: async (f) => {
      if (await alreadyApplied(f)) return false;
      await runStatements(
        f,
        splitSqlStatements(f.sql, 'mysql'),
        // No parameters: mysql2 would read a `?` inside a string literal as a placeholder.
        (s) => q.query(s),
        false,
        'MySQL commits each statement as it runs',
      );
      await q.query(`INSERT INTO ${LEDGER} (name, applied_at, checksum) VALUES (?, ?, ?)`,
        [f.name, new Date().toISOString(), f.checksum]);
      return true;
    },
  };
}
