import type { DDLStatement } from '../postgres/ddl';
import type { SqliteDriver } from './driver';

// SQLite migration runner.
//
// SQLite is single-writer at the file level, so concurrent pushes serialise via
// its own locking — no advisory lock needed. The whole batch runs in one
// transaction; DDL inside a tx is atomic, so any failure rolls back the batch.

export interface ApplyReport {
  applied: string[];
  skipped: string[];
  failures: { name: string; error: string }[];
}

export async function applyMigration(
  db: SqliteDriver,
  ddl: DDLStatement[],
  opts: { logger?: (line: string) => void } = {},
): Promise<ApplyReport> {
  const log = opts.logger ?? (() => {});

  // foreign_keys pragma is session-scoped; re-set here so a freshly-opened DB
  // during migration still enforces ON DELETE CASCADE etc.
  await db.exec('PRAGMA foreign_keys = ON');

  const applied: string[] = [];
  const skipped: string[] = [];
  const failures: ApplyReport['failures'] = [];

  const existingTables = new Set<string>(
    (await db.all(`SELECT name FROM sqlite_master WHERE type = 'table'`, [])).map((r) => r.name),
  );
  const existingIndexes = new Set<string>(
    (await db.all(`SELECT name FROM sqlite_master WHERE type = 'index'`, [])).map((r) => r.name),
  );

  await db.exec('BEGIN');
  try {
    for (const stmt of ddl) {
      const present = stmt.kind === 'table'
        ? existingTables.has(stmt.name)
        : existingIndexes.has(stmt.name);          // unique + index both become indexes in SQLite
      if (present) {
        skipped.push(stmt.name);
        continue;
      }
      try {
        await db.exec(stmt.sql);
        applied.push(stmt.name);
        log(`  ✓ ${stmt.kind.padEnd(11)} ${stmt.name}`);
      } catch (err: any) {
        failures.push({ name: stmt.name, error: err?.message ?? String(err) });
        log(`  ✗ ${stmt.kind.padEnd(11)} ${stmt.name}  →  ${err?.message ?? err}`);
        // No per-statement savepoints — one failure poisons the batch (same
        // conservative default as PG's apply).
      }
    }
    await db.exec('COMMIT');
  } catch (err) {
    try { await db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }

  return { applied, skipped, failures };
}
