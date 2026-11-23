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
import type { MssqlDriver, MssqlQueryable } from './driver';

// `forge migrate` on SQL Server. DDL is transactional, so each file runs in
// one transaction with its ledger row. A file is split into batches on its
// `GO` lines (not on `;`), and each batch is one request — the unit SQL
// Server needs for CREATE PROCEDURE, CREATE VIEW and CREATE TRIGGER.
//
// Concurrent runners serialise on an application lock owned by the
// transaction (sp_getapplock), and re-read the ledger once they hold it.

export const APPLOCK = 'forge_migrate';

export function applyMssqlMigrationFiles(
  driver: MssqlDriver,
  opts: MigrateFilesOptions = {},
): Promise<MigrateFilesReport> {
  return runMigrationFiles(mssqlEngine(driver), opts);
}

/** Take the migration lock for the rest of the transaction `q` is in. */
export async function takeAppLock(q: MssqlQueryable): Promise<void> {
  const { rows } = await q.query(
    `DECLARE @r int; ` +
      `EXEC @r = sp_getapplock @Resource = N'${APPLOCK}', @LockMode = N'Exclusive', ` +
      `@LockOwner = N'Transaction', @LockTimeout = -1; ` +
      `SELECT @r AS r`,
  );
  const r = Number(rows[0]?.r);
  if (!(r >= 0)) {
    throw new MigrationError(`[forge:migrate] could not take the migration lock (sp_getapplock returned ${rows[0]?.r}).`);
  }
}

export function mssqlEngine(driver: MssqlDriver): MigrateEngine {
  const hasChecksum = async () =>
    (await driver.query(`SELECT COL_LENGTH(N'${LEDGER}', N'checksum') AS c`)).rows[0]?.c != null;
  const ensureLedger = async () => {
    await driver.transaction(async (tx) => {
      await takeAppLock(tx);
      await tx.query(
        `IF OBJECT_ID(N'${LEDGER}', N'U') IS NULL ` +
          `CREATE TABLE ${LEDGER} (name NVARCHAR(255) NOT NULL PRIMARY KEY, applied_at NVARCHAR(64), checksum NVARCHAR(64))`,
      );
      await tx.query(
        `IF COL_LENGTH(N'${LEDGER}', N'checksum') IS NULL ALTER TABLE ${LEDGER} ADD checksum NVARCHAR(64)`,
      );
    });
  };
  const alreadyApplied = async (q: MssqlQueryable, f: MigrationFile) =>
    checkAppliedRow(f, (await q.query(`SELECT checksum FROM ${LEDGER} WHERE name = @p1 OR name = @p2`, [f.name, f.file])).rows);
  const record = (q: MssqlQueryable, f: MigrationFile) =>
    q.query(`INSERT INTO ${LEDGER} (name, applied_at, checksum) VALUES (@p1, @p2, @p3)`,
      [f.name, new Date().toISOString(), f.checksum]);

  return {
    dialect: 'mssql',
    hasLedger: async () => (await driver.query(`SELECT OBJECT_ID(N'${LEDGER}', N'U') AS t`)).rows[0]?.t != null,
    ensureLedger,
    readLedger: async (dryRun) => {
      const has = await hasChecksum();
      if (!has && !dryRun) await ensureLedger();
      const sel = has || !dryRun ? 'name, checksum' : 'name, NULL AS checksum';
      return toLedgerMap((await driver.query(`SELECT ${sel} FROM ${LEDGER} ORDER BY name`)).rows);
    },
    setChecksum: async (raw, checksum) => {
      await driver.query(`UPDATE ${LEDGER} SET checksum = @p1 WHERE name = @p2`, [checksum, raw]);
    },
    apply: async (f) => {
      const batches = splitSqlStatements(f.sql, 'mssql');
      if (f.transactional) {
        return driver.transaction(async (tx) => {
          await takeAppLock(tx);
          if (await alreadyApplied(tx, f)) return false;
          await runStatements(f, batches, (s) => tx.query(s), true);
          await record(tx, f);
          return true;
        });
      }
      // No transaction: the batches commit one by one; the lock covers the
      // ledger check and row only, since the mssql pool cannot hold one
      // connection across requests outside a transaction.
      if (await alreadyApplied(driver, f)) return false;
      await runStatements(f, batches, (s) => driver.query(s), false);
      return driver.transaction(async (tx) => {
        await takeAppLock(tx);
        if (await alreadyApplied(tx, f)) return false;
        await record(tx, f);
        return true;
      });
    },
  };
}
