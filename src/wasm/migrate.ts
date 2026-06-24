import type { SqliteDriver } from '../adapters/sqlite/driver';
import { buildSchemaDDL } from '../adapters/sqlite/ddl';
import { applyMigration, type ApplyReport } from '../adapters/sqlite/migrate';
import { getActiveSchema } from '../schema/active';
import type { SchemaMap } from '../schema';

// $migrate — runtime DDL apply for the browser/wasm path.
//
// `forge push` is the Node CLI for server-side schemas; it can't run in a
// browser tab. This is the equivalent at runtime: read the active schema map
// (the one passed to createDb({ schema })), emit DDL, and apply only what's
// missing inside a transaction. Safe to call on every app boot — already-
// existing tables and indexes are skipped via the migrator's idempotency check
// (CREATE … IF NOT EXISTS + sqlite_master lookup).
//
//   const db = await createDb({ url: 'opfs-sahpool:///dallio.sqlite',
//     schema, driver: wasmSqliteDriver({ worker }) });
//   await runMigrate(db);   // first call creates tables; subsequent calls no-op

export interface RuntimeMigrateOptions {
  // Override the schema being migrated. Defaults to the active schema set by
  // createDb({ schema }) — almost always what you want.
  schema?: SchemaMap;
  // Per-statement progress hook. Mirrors `forge push --verbose`.
  logger?: (line: string) => void;
}

export async function runMigrate(
  driver: SqliteDriver,
  opts: RuntimeMigrateOptions = {},
): Promise<ApplyReport> {
  const schema = (opts.schema ?? getActiveSchema()) as SchemaMap;
  if (!schema) {
    throw new Error(
      '[forge:wasm] $migrate(): no active schema. Pass createDb({ schema }) ' +
      'or runMigrate(driver, { schema }).',
    );
  }
  const ddl = buildSchemaDDL(schema);
  return applyMigration(driver, ddl, opts.logger ? { logger: opts.logger } : {});
}
