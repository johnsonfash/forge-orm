// SQL Server IR consumer — runs the PG compiler with MssqlDialect, then
// rewrites the PG-specific tail into T-SQL:
//
//   * LIMIT n OFFSET m  →  OFFSET m ROWS FETCH NEXT n ROWS ONLY
//                          (with mandatory ORDER BY, which the SELECT
//                          builder already emits)
//   * RETURNING *        →  OUTPUT INSERTED.* / OUTPUT DELETED.* (per op)
//   * ctid               →  the row IN (SELECT TOP 1 …) form, keyed on the
//                          primary-key column we resolve from the model
//   * ON CONFLICT … DO …  →  NOT IMPLEMENTED in this MVP. The upsert path
//                          throws a clear error pointing at the planned
//                          MERGE-based rewrite.
//
// MVP scope: SELECT / COUNT / INSERT / UPDATE / DELETE / GROUP BY work
// end-to-end. UPSERT throws. The MERGE rewrite lands in v2.4.

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
import { MssqlDialect } from './dialect';
import {
  compileCount as pgCompileCount,
  compileDelete as pgCompileDelete,
  compileGroupBy as pgCompileGroupBy,
  compileInsert as pgCompileInsert,
  compileSelect as pgCompileSelect,
  compileUpdate as pgCompileUpdate,
} from '../postgres/compile-from-ir';

function modelDef(modelKey: string, override?: ModelDef<any>): ModelDef<any> {
  if (override) return override;
  const m = (schema as any)[modelKey] as ModelDef<any> | undefined;
  if (!m) throw new Error(`[forge:mssql] unknown model '${modelKey}' in IR`);
  return m;
}

function primaryKeyOf(model: ModelDef<any>): string {
  for (const [name, fdef] of Object.entries(model.fields)) {
    if ((fdef as any)?.kind === 'id') return name;
  }
  return 'id';
}

function coerceParams(params: unknown[]): unknown[] {
  return params.map((v) => {
    // T-SQL booleans are BIT (0/1). mssql package converts true/false to
    // bit on input automatically, but JSON columns receive strings — make
    // sure objects/arrays land as JSON-stringified text.
    if (v === true || v === false) return v ? 1 : 0;
    if (Array.isArray(v) || (typeof v === 'object' && v !== null && !(v instanceof Date))) {
      return JSON.stringify(v);
    }
    return v;
  });
}

function post(a: SQLArtifact): SQLArtifact {
  return { kind: 'sql', dialect: 'mssql', sql: a.sql, params: coerceParams(a.params) };
}

// PG: `LIMIT n` / `OFFSET m`. T-SQL needs `ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY`
// (and OFFSET/FETCH require an ORDER BY clause — PG's SELECT builder always
// emits one when there's a limit, so this is safe).
function rewriteLimitOffset(sql: string): string {
  // Extract LIMIT n and OFFSET m tokens if present, then replace with the
  // T-SQL OFFSET/FETCH form. Order doesn't matter in PG output (we emit
  // LIMIT first), but we tolerate either ordering.
  const limitMatch = sql.match(/\sLIMIT\s+(\d+)/i);
  const offsetMatch = sql.match(/\sOFFSET\s+(\d+)(?!\s+ROWS)/i); // exclude already-tsql form
  if (!limitMatch && !offsetMatch) return sql;
  let out = sql;
  if (limitMatch) out = out.replace(limitMatch[0], '');
  if (offsetMatch) out = out.replace(offsetMatch[0], '');
  const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
  const limit = limitMatch ? Number(limitMatch[1]) : undefined;
  let tail = ` OFFSET ${offset} ROWS`;
  if (limit !== undefined) tail += ` FETCH NEXT ${limit} ROWS ONLY`;
  return out.trimEnd() + tail;
}

// PG ctid idiom: `WHERE ctid = (SELECT ctid FROM tbl WHERE … LIMIT 1)`.
// T-SQL: `WHERE [pk] IN (SELECT TOP 1 [pk] FROM tbl WHERE …)`.
function rewriteCtidSingleRow(sql: string, table: string, pk: string): string {
  const re = new RegExp(
    `WHERE ctid = \\(SELECT ctid FROM ${escapeReg(table)}(?:\\s+WHERE\\s+(.+?))?\\s+LIMIT\\s+1\\)`,
    'gi',
  );
  return sql.replace(re, (_match, whereExpr) => {
    const whereClause = whereExpr ? `WHERE ${whereExpr}` : '';
    return `WHERE [${pk}] IN (SELECT TOP 1 [${pk}] FROM ${table} ${whereClause})`.trim();
  });
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// PG RETURNING tail → T-SQL OUTPUT clause. For INSERT/UPDATE the OUTPUT clause
// goes BEFORE the VALUES / FROM keyword and references INSERTED.*; for DELETE
// it goes before WHERE and references DELETED.*.
function rewriteReturningForInsert(sql: string): string {
  // Strip the trailing RETURNING, then inject OUTPUT INSERTED.* after the
  // column list.
  const returning = sql.match(/\sRETURNING\s+(?:\*|(?:\[[^\]]+\]|"[^"]+"|`[^`]+`)(?:,\s*(?:\[[^\]]+\]|"[^"]+"|`[^`]+`))*)\s*$/i);
  if (!returning) return sql;
  const head = sql.slice(0, returning.index);
  // INSERT … (cols) VALUES … — inject OUTPUT after the column list.
  const m = head.match(/^(INSERT INTO\s+\[[^\]]+\]\s*\([^)]+\))\s+(VALUES\s+)/i);
  if (m) {
    return `${m[1]} OUTPUT INSERTED.* ${m[2]}${head.slice(m[0].length)}`;
  }
  // Fallback: append OUTPUT at the end (rare path).
  return head;
}

function rewriteReturningForUpdate(sql: string): string {
  const returning = sql.match(/\sRETURNING\s+(?:\*|(?:\[[^\]]+\]|"[^"]+")(?:,\s*(?:\[[^\]]+\]|"[^"]+"))*)\s*$/i);
  if (!returning) return sql;
  const head = sql.slice(0, returning.index);
  // UPDATE table SET col=val WHERE …  →  UPDATE table SET col=val OUTPUT INSERTED.* WHERE …
  // Insert OUTPUT INSERTED.* between SET clause and WHERE / end.
  const setEnd = head.search(/\s+WHERE\s+/i);
  if (setEnd >= 0) {
    return `${head.slice(0, setEnd)} OUTPUT INSERTED.*${head.slice(setEnd)}`;
  }
  return `${head} OUTPUT INSERTED.*`;
}

function rewriteReturningForDelete(sql: string): string {
  const returning = sql.match(/\sRETURNING\s+(?:\*|(?:\[[^\]]+\]|"[^"]+")(?:,\s*(?:\[[^\]]+\]|"[^"]+"))*)\s*$/i);
  if (!returning) return sql;
  const head = sql.slice(0, returning.index);
  // DELETE FROM table WHERE …  →  DELETE FROM table OUTPUT DELETED.* WHERE …
  const whereIdx = head.search(/\s+WHERE\s+/i);
  if (whereIdx >= 0) {
    return `${head.slice(0, whereIdx)} OUTPUT DELETED.*${head.slice(whereIdx)}`;
  }
  return `${head} OUTPUT DELETED.*`;
}

export function compileSelect(node: SelectNode, modelOverride?: ModelDef<any>): SQLArtifact {
  const a = pgCompileSelect(node, modelOverride, MssqlDialect);
  let sql = a.sql;
  // T-SQL has no DISTINCT ON.
  sql = sql.replace(/^SELECT DISTINCT ON \([^)]+\) /, 'SELECT DISTINCT ');
  sql = rewriteLimitOffset(sql);
  return post({ ...a, sql });
}

export function compileCount(node: CountNode, modelOverride?: ModelDef<any>): SQLArtifact {
  const a = pgCompileCount(node, modelOverride, MssqlDialect);
  return post({ ...a, sql: rewriteLimitOffset(a.sql) });
}

export function compileGroupBy(node: GroupByNode, modelOverride?: ModelDef<any>): SQLArtifact {
  const a = pgCompileGroupBy(node, modelOverride, MssqlDialect);
  return post({ ...a, sql: rewriteLimitOffset(a.sql) });
}

export function compileInsert(node: InsertNode, modelOverride?: ModelDef<any>): SQLArtifact {
  const m = modelDef(node.model, modelOverride);
  if ((node as any).upsertCreate || /ON CONFLICT/i.test(pgCompileInsert(node, modelOverride, MssqlDialect).sql)) {
    throw new Error(
      `[forge:mssql] upsert / ON CONFLICT is not implemented in 2.3. The ` +
      `T-SQL equivalent (MERGE) lands in v2.4. Until then, do findFirst → ` +
      `update / create at the app layer for the MSSQL adapter.`,
    );
  }
  const a = pgCompileInsert(node, modelOverride, MssqlDialect);
  let sql = a.sql;
  sql = rewriteReturningForInsert(sql);
  return post({ ...a, sql });
}

export function compileUpdate(node: UpdateNode, modelOverride?: ModelDef<any>): SQLArtifact {
  if (node.upsertCreate) {
    throw new Error(
      `[forge:mssql] upsert is not implemented in 2.3. See compileInsert error for details.`,
    );
  }
  const m = modelDef(node.model, modelOverride);
  const pk = primaryKeyOf(m);
  const a = pgCompileUpdate(node, modelOverride, MssqlDialect);
  let sql = a.sql;
  const tableQ = `[${m.collection}]`;
  sql = rewriteCtidSingleRow(sql, tableQ, pk);
  sql = rewriteReturningForUpdate(sql);
  return post({ ...a, sql });
}

export function compileDelete(node: DeleteNode, modelOverride?: ModelDef<any>): SQLArtifact {
  const m = modelDef(node.model, modelOverride);
  const pk = primaryKeyOf(m);
  const a = pgCompileDelete(node, modelOverride, MssqlDialect);
  let sql = a.sql;
  const tableQ = `[${m.collection}]`;
  sql = rewriteCtidSingleRow(sql, tableQ, pk);
  sql = rewriteReturningForDelete(sql);
  return post({ ...a, sql });
}
