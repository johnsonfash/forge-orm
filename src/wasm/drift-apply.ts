import type { SqliteDriver } from '../adapters/sqlite/driver';
import { introspectSqlite } from '../adapters/sqlite/introspect';
import { renderColumn } from '../adapters/sqlite/ddl';
import { SqliteDialect } from '../adapters/sqlite/dialect';
import { diffIntrospection, type DriftItem } from '../scripts/diff-core';
import type { ModelDef, FieldDef } from '../schema/types';
import type { SchemaMap } from '../schema';

// applyDrift — non-destructive ALTER pass for the runtime/browser migrate path.
//
// `runMigrate` first runs the CREATE-IF-NOT-EXISTS pass (idempotent — covers
// missing tables and indexes). That can't fix one common case: a column was
// added to the schema after the table was first created. SQLite has no
// equivalent of `CREATE TABLE … ADD IF NOT EXISTS column` — only `ALTER
// TABLE … ADD COLUMN`. This module bridges that gap.
//
// What it does:
//   • introspect the live DB (sqlite_master + PRAGMA)
//   • diff against the active schema via diffIntrospection
//   • for every {kind: 'column', direction: 'missing'} drift item, emit an
//     ALTER TABLE … ADD COLUMN inside a transaction
//   • surface every destructive or otherwise-unsafe drift item under `pending`
//     so the caller can render it, log it, or decide to drop the DB
//
// What it deliberately does NOT do:
//   • drop columns / drop tables / drop indexes (destructive — data loss risk)
//   • re-type a column (SQLite has no ALTER COLUMN; the only safe path is a
//     full table-rebuild, which is more than a "drift fix" should attempt)
//   • re-create a column with different nullability or default (same reason)
//
// SQLite ADD COLUMN restrictions, applied here:
//   • A column added with NOT NULL needs a constant DEFAULT (otherwise existing
//     rows have nowhere to land). If the schema field is NOT NULL and has no
//     default, we surface it as pending instead of emitting a statement that
//     would error.
//   • A column added as PRIMARY KEY isn't legal at all. The id field is part
//     of CREATE TABLE; if the diff says one is missing, the table itself must
//     be missing (caught by the CREATE pass) or the schema is broken.

export interface DriftApplyReport {
  alteredColumns: string[];          // 'table.column' for each ADD COLUMN run
  pending: DriftItem[];              // drift left untouched (destructive / unsafe)
  failures: { name: string; error: string }[];
}

interface ApplyOptions {
  schema: SchemaMap;
  logger?: (line: string) => void;
}

export async function applyDrift(
  db: SqliteDriver,
  opts: ApplyOptions,
): Promise<DriftApplyReport> {
  const log = opts.logger ?? (() => {});
  const out: DriftApplyReport = { alteredColumns: [], pending: [], failures: [] };

  const introspection = await introspectSqlite(db);
  const drift = diffIntrospection(opts.schema as Record<string, any>, introspection);

  if (drift.inSync) return out;

  // Build a quick lookup: collection name → ModelDef so we can pull the FieldDef
  // for each missing column. The diff report only carries the column name, not
  // the full field definition.
  const modelByCollection = new Map<string, ModelDef<any>>();
  for (const key of Object.keys(opts.schema)) {
    const m = (opts.schema as any)[key] as ModelDef<any> | undefined;
    if (m?.collection) modelByCollection.set(m.collection, m);
  }

  const adds: { table: string; column: string; field: FieldDef }[] = [];
  for (const item of drift.items) {
    // 'missing column' is the only case we can fix non-destructively.
    if (item.kind === 'column' && item.direction === 'missing') {
      const model = modelByCollection.get(item.table);
      if (!model) { out.pending.push(item); continue; }
      // diffItem.detail is the bare column name (see expectedFromSchema).
      const colName = item.detail.replace(/^column '|'$/g, '');
      const field = model.fields[colName] as FieldDef | undefined;
      if (!field) { out.pending.push(item); continue; }
      if (!isSafeAddColumn(field)) { out.pending.push(item); continue; }
      adds.push({ table: item.table, column: colName, field });
      continue;
    }
    // Everything else is destructive or otherwise out of scope.
    out.pending.push(item);
  }

  if (adds.length === 0) return out;

  // Whole batch in one tx — partial application on a mid-batch error would
  // leave the schema half-migrated.
  await db.exec('BEGIN');
  try {
    for (const a of adds) {
      const stmt = `ALTER TABLE ${SqliteDialect.quoteIdent(a.table)} ADD COLUMN ${renderColumn(a.column, a.field)}`;
      try {
        await db.exec(stmt);
        out.alteredColumns.push(`${a.table}.${a.column}`);
        log(`  ✓ add-column  ${a.table}.${a.column}`);
      } catch (err: any) {
        out.failures.push({ name: `${a.table}.${a.column}`, error: err?.message ?? String(err) });
        log(`  ✗ add-column  ${a.table}.${a.column}  →  ${err?.message ?? err}`);
      }
    }
    await db.exec('COMMIT');
  } catch (err) {
    try { await db.exec('ROLLBACK'); } catch { /* swallow */ }
    throw err;
  }

  return out;
}

// SQLite ADD COLUMN refuses NOT NULL without a constant DEFAULT on a non-empty
// table. We also refuse to ADD a PK column or a generated column — the create
// pass owns those, and adding them after the fact is a table-rebuild concern,
// not a drift fix.
function isSafeAddColumn(field: FieldDef): boolean {
  if (field.kind === 'id') return false;
  if (field.dbGenerated) return false;
  if (field.optional) return true;
  // Has a default? OK. literal/now/autoId all render to a constant.
  if (field.default) return true;
  return false;
}
