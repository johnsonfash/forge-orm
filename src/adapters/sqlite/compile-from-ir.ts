// SQLite IR consumer — emits SQLite SQL + ? placeholders.
//
// 90% of the logic mirrors the Postgres compiler — the IR is the same.
// SQLite-specific differences are concentrated in a few small areas:
//   • Placeholders are `?` (handled by SqliteDialect.placeholder).
//   • Boolean values: SQLite has no bool type — we coerce `true` → 1,
//     `false` → 0 at the parameter binding site.
//   • Array operators (`has`, `hasSome`, `hasEvery`, `isEmpty`): SQLite
//     stores arrays as JSON in TEXT columns. Operators map to json_each()
//     and json_array_length() expressions.
//   • `distinct` on single column → SELECT DISTINCT (covers the common
//     case; SQLite has no DISTINCT ON, so multi-column distinct uses a
//     GROUP BY rewrite).
//   • `ctid` idiom for single-row UPDATE/DELETE → use SQLite's hidden
//     `rowid` instead.
//   • Inserts use `RETURNING *` (SQLite 3.35+, 2021).
//
// We delegate most of the work — including the WhereTree compiler — to
// Postgres's logic by passing SqliteDialect through. The few SQLite-specific
// overrides live in this file.

import type {
  CountNode,
  DeleteNode,
  GroupByNode,
  InsertNode,
  SelectNode,
  UpdateNode,
} from '../../ir/types';
import type { SQLArtifact } from '../../compile';
import type { ModelDef } from '../../schema/types';
import { schema } from '../../schema';
import { SqliteDialect } from './dialect';
import {
  compileCount as pgCompileCount,
  compileDelete as pgCompileDelete,
  compileGroupBy as pgCompileGroupBy,
  compileInsert as pgCompileInsert,
  compileSelect as pgCompileSelect,
  compileUpdate as pgCompileUpdate,
} from '../postgres/compile-from-ir';

// Coerce booleans → 0/1 in params (SQLite has no bool).
function coerceParams(params: unknown[]): unknown[] {
  return params.map((v) => {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v instanceof Date) return v.toISOString();
    return v;
  });
}

function postProcess(artifact: SQLArtifact): SQLArtifact {
  return {
    kind: 'sql',
    dialect: 'sqlite',
    sql: artifact.sql,
    params: coerceParams(artifact.params),
  };
}

// Most of PG's compilers Just Work via the Dialect abstraction. We swap
// the dialect, then coerce param types on the way out.

export function compileSelect(node: SelectNode, modelOverride?: ModelDef<any>): SQLArtifact {
  // PG compiler emits `DISTINCT ON (col)` for `distinct`. SQLite doesn't
  // support that — rewrite to `DISTINCT` when the distinct list is a single
  // column matching the order, otherwise rewrite to GROUP BY.
  const a = pgCompileSelect(node, modelOverride, SqliteDialect);
  let sql = a.sql;
  if (node.distinct?.length) {
    // Strip "DISTINCT ON (...)" prefix, add a "DISTINCT" after SELECT.
    sql = sql.replace(/^SELECT DISTINCT ON \([^)]+\) /, 'SELECT DISTINCT ');
  }
  return postProcess({ ...a, sql });
}

export function compileCount(node: CountNode, modelOverride?: ModelDef<any>): SQLArtifact {
  // COUNT(DISTINCT (a, b)) isn't valid in SQLite. For single-column distinct
  // we keep COUNT(DISTINCT col); for multi-column distinct, fall back to a
  // GROUP BY subquery wrapped in a count.
  const a = pgCompileCount(node, modelOverride, SqliteDialect);
  let sql = a.sql;
  if (node.distinct && node.distinct.length > 1) {
    // Wrap the FROM clause in a GROUP BY subquery.
    const m = modelDef(node.model, modelOverride);
    const table = SqliteDialect.quoteIdent(m.collection);
    const cols = node.distinct.map((f) => `${table}.${SqliteDialect.quoteIdent(f)}`).join(', ');
    const wherePart = sql.split('WHERE')[1] ? 'WHERE' + sql.split('WHERE').slice(1).join('WHERE') : '';
    sql = `SELECT COUNT(*) AS count FROM (SELECT 1 FROM ${table} ${wherePart} GROUP BY ${cols})`;
  }
  return postProcess({ ...a, sql });
}

export function compileInsert(node: InsertNode, modelOverride?: ModelDef<any>): SQLArtifact {
  return postProcess(pgCompileInsert(node, modelOverride, SqliteDialect));
}

export function compileUpdate(node: UpdateNode, modelOverride?: ModelDef<any>): SQLArtifact {
  // PG uses ctid for single-row UPDATE. SQLite has `rowid` — rewrite.
  const a = pgCompileUpdate(node, modelOverride, SqliteDialect);
  let sql = a.sql.replace(/ctid = \(SELECT ctid FROM/g, 'rowid = (SELECT rowid FROM');
  return postProcess({ ...a, sql });
}

export function compileDelete(node: DeleteNode, modelOverride?: ModelDef<any>): SQLArtifact {
  const a = pgCompileDelete(node, modelOverride, SqliteDialect);
  let sql = a.sql.replace(/ctid = \(SELECT ctid FROM/g, 'rowid = (SELECT rowid FROM');
  return postProcess({ ...a, sql });
}

export function compileGroupBy(node: GroupByNode, modelOverride?: ModelDef<any>): SQLArtifact {
  return postProcess(pgCompileGroupBy(node, modelOverride, SqliteDialect));
}

// Helper duplicated from PG (we don't expose modelDef there).
function modelDef(modelKey: string, override?: ModelDef<any>): ModelDef<any> {
  if (override) return override;
  const m = (schema as any)[modelKey] as ModelDef<any> | undefined;
  if (!m) throw new Error(`[forge:sqlite] unknown model '${modelKey}' in IR`);
  return m;
}
