// SQL Server migration runner. The DDL emitted by ./ddl.ts is already
// idempotent (each CREATE is wrapped in `IF NOT EXISTS (…) BEGIN … END`),
// so this is straightforward "run each statement, collect failures".

import type { DDLStatement } from './ddl';
import type { MssqlDriver, MssqlQueryable } from './driver';

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
  driver: MssqlQueryable,
  ddl: DDLStatement[],
): Promise<MigrationPlan> {
  // T-SQL DDL is idempotent thanks to the IF-NOT-EXISTS wrappers. We mark
  // everything as toApply; the wrappers no-op when the object exists.
  return {
    toApply: ddl,
    toSkip: [],
    summary: `${ddl.length} statement${ddl.length === 1 ? '' : 's'} to apply (each is idempotent)`,
  };
  // Silence the unused-param diagnostic.
  void driver;
}

export async function applyMigration(
  driver: MssqlDriver,
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
