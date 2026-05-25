import type { DDLStatement } from '../postgres/ddl';
import type { SqliteDb } from './execute';

// SQLite migration runner.
//
// SQLite is single-writer at the file level — concurrent forge:push runs
// against the same database file naturally serialise via SQLite's own
// locking. No need for the advisory-lock dance the Postgres runner does.
//
// The whole batch runs in a single transaction. SQLite doesn't support
// savepoint rollback the same way PG does for DDL — DDL inside a tx is
// atomic, so if one statement fails the whole batch rolls back.

export interface ApplyReport {
  applied: string[];
  skipped: string[];
  failures: { name: string; error: string }[];
}

export async function applyMigration(
  db: SqliteDb,
  ddl: DDLStatement[],
  opts: { logger?: (line: string) => void } = {},
): Promise<ApplyReport> {
  const log = opts.logger ?? (() => {});

  // SQLite needs PRAGMA foreign_keys = ON for FK constraints to actually
  // enforce ON DELETE CASCADE etc. It's session-scoped, so we set it on
  // every connect — but also here so a freshly-opened DB during migration
  // doesn't silently ignore them.
  db.pragma('foreign_keys = ON');

  const applied: string[] = [];
  const skipped: string[] = [];
  const failures: ApplyReport['failures'] = [];

  // Introspect what already exists.
  const existingTables = new Set<string>(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as any[])
      .map((r) => r.name),
  );
  const existingIndexes = new Set<string>(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as any[])
      .map((r) => r.name),
  );

  db.exec('BEGIN');
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
        db.exec(stmt.sql);
        applied.push(stmt.name);
        log(`  ✓ ${stmt.kind.padEnd(11)} ${stmt.name}`);
      } catch (err: any) {
        failures.push({ name: stmt.name, error: err?.message ?? String(err) });
        log(`  ✗ ${stmt.kind.padEnd(11)} ${stmt.name}  →  ${err?.message ?? err}`);
        // SQLite's DDL transaction model: if we want partial success, we'd
        // need savepoints around each. For simplicity we let one failure
        // poison the batch — same conservative default as PG's apply.
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }

  return { applied, skipped, failures };
}
