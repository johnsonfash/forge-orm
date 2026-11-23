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
import type { SqliteDriver } from './driver';

// `forge migrate` on SQLite. DDL is transactional here, so each file runs in
// one transaction with its ledger row, as on Postgres.
//
// The transaction is BEGIN IMMEDIATE: it takes the database's write lock at
// the start rather than at the first write, so a second runner waits for the
// first to commit, then re-reads the ledger and skips what is already there.
// Runs in one process on the same connection are queued.
//
// The wait is asynchronous. better-sqlite3 waits for a lock by blocking the
// thread (its busy timeout), so two runners in ONE process on two connections
// deadlocked: the waiter froze the thread the holder needed to reach COMMIT,
// and failed with SQLITE_BUSY when the timeout ran out. Lock-taking statements
// now run with busy_timeout 0 and are retried after a timer instead.

const queue = serialiser();

const LOCK_WAIT_MS = 60_000;

const isBusy = (err: unknown) => {
  const e = err as { code?: unknown; message?: unknown };
  return (typeof e?.code === 'string' && e.code.startsWith('SQLITE_BUSY')) ||
    (typeof e?.message === 'string' && /database is locked|SQLITE_BUSY/i.test(e.message));
};

/** Runs `fn` without letting the driver block the thread on a lock: busy is
 *  retried on a timer (with backoff) for up to LOCK_WAIT_MS. */
async function withoutBlocking<T>(db: SqliteDriver, fn: () => Promise<T>): Promise<T> {
  const rows = await db.all('PRAGMA busy_timeout', []) as Array<Record<string, unknown>>;
  const previous = Number(Object.values(rows[0] ?? {})[0] ?? 0);
  await db.exec('PRAGMA busy_timeout = 0');
  try {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (let wait = 5; ; wait = Math.min(wait * 2, 250)) {
      try {
        return await fn();
      } catch (err) {
        if (!isBusy(err) || Date.now() > deadline) throw err;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  } finally {
    await db.exec(`PRAGMA busy_timeout = ${Number.isFinite(previous) ? previous : 0}`);
  }
}

export function applySqliteMigrationFiles(
  db: SqliteDriver,
  opts: MigrateFilesOptions = {},
): Promise<MigrateFilesReport> {
  return runMigrationFiles(sqliteEngine(db), opts);
}

export function sqliteEngine(db: SqliteDriver): MigrateEngine {
  const hasChecksum = async () =>
    (await db.all(`SELECT name FROM pragma_table_info('${LEDGER}') WHERE name = 'checksum'`, [])).length > 0;
  const ensureLedger = () => withoutBlocking(db, async () => {
    await db.run(
      `CREATE TABLE IF NOT EXISTS ${LEDGER} (name VARCHAR(255) PRIMARY KEY, applied_at VARCHAR(64), checksum VARCHAR(64))`,
      [],
    );
    if (!(await hasChecksum())) await db.run(`ALTER TABLE ${LEDGER} ADD COLUMN checksum VARCHAR(64)`, []);
  });
  const alreadyApplied = async (f: MigrationFile) =>
    checkAppliedRow(f, await db.all(`SELECT checksum FROM ${LEDGER} WHERE name = ? OR name = ?`, [f.name, f.file]));
  const record = (f: MigrationFile) =>
    db.run(`INSERT INTO ${LEDGER} (name, applied_at, checksum) VALUES (?, ?, ?)`,
      [f.name, new Date().toISOString(), f.checksum]);
  // One statement per call: not every driver's exec() takes a script
  // (tauri-plugin-sql splits on every `;`, which cuts a trigger body).
  const exec = (sql: string) => db.run(sql, []);

  const inTransaction = async <T>(fn: () => Promise<T>): Promise<T> => {
    await withoutBlocking(db, () => db.exec('BEGIN IMMEDIATE'));
    try {
      const out = await fn();
      await db.exec('COMMIT');
      return out;
    } catch (err) {
      try { await db.exec('ROLLBACK'); } catch { /* the failed statement may have ended it */ }
      throw err;
    }
  };

  return {
    dialect: 'sqlite',
    run: (fn) => queue(db, fn),
    hasLedger: async () =>
      (await db.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [LEDGER])).length > 0,
    ensureLedger,
    readLedger: async (dryRun) => {
      const has = await hasChecksum();
      if (!has && !dryRun) await ensureLedger();
      const sel = has || !dryRun ? 'name, checksum' : 'name, NULL AS checksum';
      return toLedgerMap(await db.all(`SELECT ${sel} FROM ${LEDGER} ORDER BY name`, []));
    },
    setChecksum: async (raw, checksum) => {
      await withoutBlocking(db, () => db.run(`UPDATE ${LEDGER} SET checksum = ? WHERE name = ?`, [checksum, raw]));
    },
    apply: async (f) => {
      const statements = splitSqlStatements(f.sql, 'sqlite');
      if (f.transactional) {
        return inTransaction(async () => {
          if (await alreadyApplied(f)) return false;
          await runStatements(f, statements, exec, true);
          await record(f);
          return true;
        });
      }
      // No transaction: the statements commit one by one, and only the
      // ledger check and row are taken under the write lock.
      if (await alreadyApplied(f)) return false;
      await runStatements(f, statements, exec, false);
      return inTransaction(async () => {
        if (await alreadyApplied(f)) return false;
        await record(f);
        return true;
      });
    },
  };
}
