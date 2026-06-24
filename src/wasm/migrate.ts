import type { SqliteDriver } from '../adapters/sqlite/driver';
import { buildSchemaDDL } from '../adapters/sqlite/ddl';
import { applyMigration, type ApplyReport } from '../adapters/sqlite/migrate';
import { applyDrift } from './drift-apply';
import { getActiveSchema } from '../schema/active';
import type { SchemaMap } from '../schema';
import type { DriftItem } from '../scripts/diff-core';

// $migrate — runtime DDL apply for the browser/wasm path.
//
// `forge push` is the Node CLI for server-side schemas; it can't run in a
// browser tab. This is the equivalent at runtime: read the active schema map
// (the one passed to createDb({ schema })), emit DDL, and apply only what's
// missing inside a transaction. Safe to call on every app boot — already-
// existing tables and indexes are skipped via the migrator's idempotency check
// (CREATE … IF NOT EXISTS + sqlite_master lookup).
//
//   const db = await createDb({ url: 'opfs-sahpool:///app.sqlite',
//     schema, driver: wasmSqliteDriver({ worker }) });
//   await runMigrate(db);   // first call creates tables; subsequent calls no-op
//
// Drift detection (since 2.5.1): after the create-pass, $migrate also runs the
// drift differ. Missing columns that can be safely added (nullable, or have a
// constant default) get `ALTER TABLE … ADD COLUMN` applied automatically.
// Destructive drift (column drops, type changes, extra tables) is left alone
// and surfaced in `pending` for the caller to handle.

export interface RuntimeMigrateOptions {
  // Override the schema being migrated. Defaults to the active schema set by
  // createDb({ schema }) — almost always what you want.
  schema?: SchemaMap;
  // Per-statement progress hook. Mirrors `forge push --verbose`.
  logger?: (line: string) => void;
  // Turn off the post-create drift-apply pass. Defaults to true. Set to false
  // when you only want the strict idempotent create-or-skip behaviour from
  // 2.4 / 2.5.0 — e.g. if you're shipping your own migration runner and want
  // $migrate to be a no-op for existing tables.
  alter?: boolean;
}

export interface RuntimeApplyReport extends ApplyReport {
  // Non-destructive drift items that were applied since 2.5.1 — entries are
  // `table.column` strings, one per ADD COLUMN that ran. Empty when nothing
  // drifted or when `alter: false` was passed.
  alteredColumns: string[];
  // Destructive or otherwise-unsafe drift items that the runtime won't apply
  // automatically (column drops, column-type changes, extra tables). Render
  // this to the user / log it / drop the DB — your call.
  pending: DriftItem[];
}

export async function runMigrate(
  driver: SqliteDriver,
  opts: RuntimeMigrateOptions = {},
): Promise<RuntimeApplyReport> {
  const schema = (opts.schema ?? getActiveSchema()) as SchemaMap;
  if (!schema) {
    throw new Error(
      '[forge:wasm] $migrate(): no active schema. Pass createDb({ schema }) ' +
      'or runMigrate(driver, { schema }).',
    );
  }

  const ddl = buildSchemaDDL(schema);
  const createReport = await applyMigration(driver, ddl, opts.logger ? { logger: opts.logger } : {});

  // Drift-apply is on by default since 2.5.1. Skips entirely when the caller
  // opts out, or when the create-pass failed (no point trying ALTERs against
  // a half-migrated schema).
  const wantsDrift = opts.alter !== false;
  if (!wantsDrift || createReport.failures.length > 0) {
    return { ...createReport, alteredColumns: [], pending: [] };
  }

  const driftReport = await applyDrift(driver, opts.logger ? { schema, logger: opts.logger } : { schema });

  // Merge drift-apply failures back into the create-report's failures array
  // so callers that only check `report.failures` still see everything.
  const failures = [...createReport.failures, ...driftReport.failures];

  return {
    applied: createReport.applied,
    skipped: createReport.skipped,
    failures,
    alteredColumns: driftReport.alteredColumns,
    pending: driftReport.pending,
  };
}
