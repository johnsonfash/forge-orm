import type { DDLStatement } from './ddl';
import type { PgPoolHandle } from './execute';

// Migration runner for Postgres. Each statement is wrapped in a savepoint so a
// single failure rolls back that statement without aborting the whole batch.
//
// Intentionally NOT implemented:
//   • Migration journal / history (Prisma's _prisma_migrations equivalent).
//     We push-on-startup style; for production drift detection, run
//     forge:push against staging first and inspect the plan.
//   • Renaming detection (ALTER TABLE … RENAME). Removing a model and adding
//     another emits DROP + CREATE; data is preserved only when the name is kept.
//   • Column type changes (ALTER TABLE … ALTER COLUMN). Existing columns are
//     left alone; type drift surfaces at first failing query.
//
// ADDING a column IS implemented, and used not to be — a field added to the
// schema never reached a database that already had the table, because the
// planner only ever asked whether the TABLE existed. See buildAddColumns in
// ddl.ts for what that cost and how nullability is handled.

// Stable lock id, frozen so all forge:push invocations share the same lock.
const ADVISORY_LOCK_HI = 0x6f6f7267; // "forg"
const ADVISORY_LOCK_LO = 0x65000001; // "e" + version

export interface MigrationPlan {
  toApply: DDLStatement[];
  toSkip: DDLStatement[];
  summary: string;
}

export interface ApplyReport {
  applied: string[];
  skipped: string[];     // object already existed
  failures: Array<{ name: string; error: string }>;
}

export async function planMigration(
  pool: PgPoolHandle,
  ddl: DDLStatement[],
): Promise<MigrationPlan> {
  const existingTables    = await listTables(pool);
  const existingColumns   = await listColumns(pool);
  const notNullColumns    = await listNotNullColumns(pool);
  const existingConstraints = await listConstraints(pool);
  const existingIndexes   = await listIndexes(pool);

  const toApply: DDLStatement[] = [];
  const toSkip: DDLStatement[] = [];
  for (const stmt of ddl) {
    // A column on a table this batch is about to CREATE is neither applied
    // nor skipped — the CREATE TABLE already carries it, so the ALTER is not
    // a statement about this database at all. Dropping it rather than
    // skipping it keeps a first-time push honest: "0 already in place",
    // instead of several hundred phantom columns.
    if (stmt.kind === 'column' && !existingTables.has(stmt.table)) continue;
    const present = (() => {
      switch (stmt.kind) {
        case 'table':      return existingTables.has(stmt.name);
        // `stmt.name` is "<table>.<column>".
        case 'column':     return existingColumns.has(stmt.name);
        // Already nullable, or not there at all (the ADD COLUMN in this same
        // batch creates it nullable) — either way nothing to alter.
        case 'nullability': return !notNullColumns.has(stmt.name);
        case 'unique':
        case 'foreignKey':
        case 'check':      return existingConstraints.has(stmt.name);
        case 'index':      return existingIndexes.has(stmt.name);
      }
    })();
    if (present) toSkip.push(stmt);
    else toApply.push(stmt);
  }

  const summary =
    `${toApply.length} statement${toApply.length === 1 ? '' : 's'} to apply, ` +
    `${toSkip.length} already in place`;
  return { toApply, toSkip, summary };
}

export async function applyMigration(
  pool: PgPoolHandleWithConnect,
  ddl: DDLStatement[],
  opts: { plan?: MigrationPlan; logger?: (line: string) => void } = {},
): Promise<ApplyReport> {
  const log = opts.logger ?? (() => {});
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  const failures: ApplyReport['failures'] = [];

  try {
    await client.query('BEGIN');
    // Wait up to the connection's lock_timeout. pg_advisory_xact_lock takes
    // a single 64-bit int OR two 32-bit ints. We pass the pair so the value
    // matches across drivers that handle bigint differently.
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [ADVISORY_LOCK_HI, ADVISORY_LOCK_LO]);

    const plan = opts.plan ?? await planMigration(client, ddl);
    for (const stmt of plan.toSkip) skipped.push(stmt.name);

    for (const stmt of plan.toApply) {
      const savepoint = `forge_step_${applied.length + failures.length + 1}`;
      try {
        await client.query(`SAVEPOINT ${savepoint}`);
        await client.query(stmt.sql);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        applied.push(stmt.name);
        log(`  ✓ ${stmt.kind.padEnd(11)} ${stmt.name}`);
        // Only now, because only now is it true: the column really was
        // missing from a table that really did already exist, so it went on
        // nullable while the schema says it is required.
        if (stmt.relaxedNotNull) {
          console.warn(
            `[forge:push:postgres] added '${stmt.name}' NULLABLE even though ` +
            `the schema declares it required — Postgres has nothing to put ` +
            `in the rows that are already there. Backfill it, then run: ` +
            `${stmt.relaxedNotNull.setNotNullSql}`,
          );
        }
      } catch (err: any) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        failures.push({ name: stmt.name, error: err?.message ?? String(err) });
        log(`  ✗ ${stmt.kind.padEnd(11)} ${stmt.name}  →  ${err?.message ?? err}`);
      }
    }

    // We commit even with failures so successful statements stick; the
    // caller decides whether to abort based on the report. This matches
    // `prisma db push --accept-data-loss` semantics — best-effort.
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* swallow */ }
    throw err;
  } finally {
    if (typeof (client as any).release === 'function') (client as any).release();
  }

  return { applied, skipped, failures };
}

export interface PgPoolHandleWithConnect extends PgPoolHandle {
  connect(): Promise<PgPoolHandle & { release?: () => void }>;
}

async function listTables(pool: PgPoolHandle): Promise<Set<string>> {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`,
  );
  return new Set(rows.map((r) => r.table_name));
}

/** Every column in the schema, keyed "<table>.<column>". */
async function listColumns(pool: PgPoolHandle): Promise<Set<string>> {
  const { rows } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema()`,
  );
  return new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
}

/** The columns that are currently NOT NULL, keyed "<table>.<column>". */
async function listNotNullColumns(pool: PgPoolHandle): Promise<Set<string>> {
  const { rows } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND is_nullable = 'NO'`,
  );
  return new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
}

async function listConstraints(pool: PgPoolHandle): Promise<Set<string>> {
  const { rows } = await pool.query(
    `SELECT conname FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = current_schema()`,
  );
  return new Set(rows.map((r) => r.conname));
}

async function listIndexes(pool: PgPoolHandle): Promise<Set<string>> {
  const { rows } = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`,
  );
  return new Set(rows.map((r) => r.indexname));
}
