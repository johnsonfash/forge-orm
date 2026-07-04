// runMigrate + applyDrift — mirrors forge's wasm/migrate + wasm/drift-apply.
//
// The IDB path is simpler than sqlite because IDB versioning already does
// non-destructive schema evolution natively. Adding a field is a total no-op
// (IDB is schemaless — start writing it). Adding an index re-scans the
// store automatically. The only work `runMigrate` has is to detect a
// version-change need (fingerprint drift) and drive the reopen.
//
// The report shape mirrors the wasm path's RuntimeApplyReport so consumers
// that already log wasm reports can point their code at the IDB path
// without a shape change. `alteredColumns` is always empty here — IDB has
// no columns; per-row data drift is handled by app-side migration passes.
// `version` carries the resulting IDB store version so callers can log it.

import type { SchemaShape } from '../../schema/active';
import { openDb } from './open';

export interface RuntimeMigrateOptions {
  name: string;
  schema: SchemaShape;
  destructive?: boolean;
  logger?: (line: string) => void;
}

export interface RuntimeApplyReport {
  applied: string[];
  skipped: string[];
  failures: string[];
  /** Always [] on IDB — fields aren't columns. Kept for wasm/sqlite parity. */
  alteredColumns: string[];
  pending: string[];
  version: number;
}

export async function runMigrate(opts: RuntimeMigrateOptions): Promise<RuntimeApplyReport> {
  const log = opts.logger ?? (() => {});
  try {
    const r = await openDb({ name: opts.name, schema: opts.schema, logger: log });
    r.applied.forEach((a) => log(`[migrate] ${a}`));
    r.pending.forEach((p) => log(`[migrate] pending: ${p}`));
    r.db.close();
    return {
      applied: r.applied,
      skipped: r.skipped,
      failures: [],
      alteredColumns: [],
      pending: r.pending,
      version: r.version,
    };
  } catch (e) {
    return {
      applied: [], skipped: [], alteredColumns: [], pending: [],
      failures: [`migrate failed: ${(e as Error).message}`],
      version: 0,
    };
  }
}

// applyDrift — kept as a separate export for parity with the sqlite/wasm
// path, even though on IDB it just delegates to runMigrate. Useful when
// consumers want to distinguish the "post-open drift-apply" step from the
// initial createIfMissing pass in their logs.
export async function applyDrift(opts: RuntimeMigrateOptions): Promise<RuntimeApplyReport> {
  return runMigrate(opts);
}
