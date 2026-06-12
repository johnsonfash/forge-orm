// SQLite IR consumer — runs the PG compiler with SqliteDialect (same IR), then
// applies SQLite-specific rewrites that the dialect can't express:
//   • No DISTINCT ON — single-col distinct → DISTINCT, multi-col → GROUP BY.
//   • PG's `ctid` single-row idiom → SQLite's hidden `rowid`.
// Bools→0/1 coercion and `?` placeholders are handled by the dialect; inserts
// use RETURNING * (SQLite 3.35+, 2021).

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

// SQLite has no bool — coerce to 0/1; dates → ISO strings.
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

export function compileSelect(node: SelectNode, modelOverride?: ModelDef<any>): SQLArtifact {
  // SQLite has no DISTINCT ON — rewrite the prefix to plain DISTINCT.
  const a = pgCompileSelect(node, modelOverride, SqliteDialect);
  let sql = a.sql;
  if (node.distinct?.length) {
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
