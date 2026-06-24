// DuckDB migration runner. Single-writer model; no advisory locks needed
// (DuckDB serialises writes per-process). DuckDB has no SAVEPOINT support,
// so a failure aborts the batch — but consumers get a per-statement
// report so they know exactly where it stopped.

import type { DDLStatement } from './ddl';
import type { DuckdbDriver, DuckdbQueryable } from './driver';

export interface MigrationPlan {
  toApply: DDLStatement[];
  toSkip: DDLStatement[];
  summary: string;
}

export interface ApplyReport {
  applied: string[];
  skipped: string[];
  failures: Array<{ name: string; error: string }>;
}

export async function planMigration(
  driver: DuckdbQueryable,
  ddl: DDLStatement[],
): Promise<MigrationPlan> {
  const existingTables = await listTables(driver);
  const existingIndexes = await listIndexes(driver);
  const existingConstraints = await listConstraints(driver);

  const toApply: DDLStatement[] = [];
  const toSkip: DDLStatement[] = [];
  for (const stmt of ddl) {
    const present = (() => {
      switch (stmt.kind) {
        case 'table':      return existingTables.has(stmt.name);
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
  driver: DuckdbDriver,
  ddl: DDLStatement[],
  opts: { plan?: MigrationPlan; logger?: (line: string) => void } = {},
): Promise<ApplyReport> {
  const log = opts.logger ?? (() => {});
  const applied: string[] = [];
  const skipped: string[] = [];
  const failures: ApplyReport['failures'] = [];

  const plan = opts.plan ?? await planMigration(driver, ddl);
  for (const stmt of plan.toSkip) skipped.push(stmt.name);

  for (const stmt of plan.toApply) {
    try {
      await driver.query(stmt.sql);
      applied.push(stmt.name);
      log(`  ✓ ${stmt.kind.padEnd(11)} ${stmt.name}`);
    } catch (err: any) {
      failures.push({ name: stmt.name, error: err?.message ?? String(err) });
      log(`  ✗ ${stmt.kind.padEnd(11)} ${stmt.name}  →  ${err?.message ?? err}`);
    }
  }

  return { applied, skipped, failures };
}

async function listTables(driver: DuckdbQueryable): Promise<Set<string>> {
  const { rows } = await driver.query(
    `SELECT table_name FROM duckdb_tables() WHERE schema_name = current_schema()`,
  );
  return new Set(rows.map((r) => r.table_name));
}

async function listIndexes(driver: DuckdbQueryable): Promise<Set<string>> {
  const { rows } = await driver.query(
    `SELECT index_name FROM duckdb_indexes() WHERE schema_name = current_schema()`,
  );
  return new Set(rows.map((r) => r.index_name));
}

async function listConstraints(driver: DuckdbQueryable): Promise<Set<string>> {
  // DuckDB exposes constraints via duckdb_constraints(). Names are returned
  // when explicitly given at CREATE TABLE time; system-named constraints
  // appear with NULL constraint_name.
  const { rows } = await driver.query(
    `SELECT constraint_name FROM duckdb_constraints()
      WHERE schema_name = current_schema() AND constraint_name IS NOT NULL`,
  );
  return new Set(rows.map((r) => r.constraint_name));
}
