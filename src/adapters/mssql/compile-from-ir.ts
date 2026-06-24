// SQL Server IR consumer — runs the PG compiler with MssqlDialect, then
// rewrites the PG-specific tail into T-SQL:
//
//   * LIMIT n OFFSET m  →  OFFSET m ROWS FETCH NEXT n ROWS ONLY
//                          (with mandatory ORDER BY, which the SELECT
//                          builder already emits)
//   * RETURNING *        →  OUTPUT INSERTED.* / OUTPUT DELETED.* (per op)
//   * ctid               →  the row IN (SELECT TOP 1 …) form, keyed on the
//                          primary-key column we resolve from the model
//   * upsert (Update.upsertCreate)
//                          →  MERGE INTO tgt USING (VALUES (...)) AS src
//                             ON tgt.<unique> = src.<unique>
//                             WHEN MATCHED THEN UPDATE SET …
//                             WHEN NOT MATCHED THEN INSERT (...) VALUES (...)
//                             OUTPUT inserted.*;
//                          The conflict target is derived from the wrapper's
//                          `where` tree (its eq leaves are the unique key).
//                          MERGE requires a trailing semicolon — `mssql` is
//                          tolerant either way; we emit one for explicit
//                          T-SQL conformance.

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
  const a = pgCompileInsert(node, modelOverride, MssqlDialect);
  let sql = a.sql;
  sql = rewriteReturningForInsert(sql);
  return post({ ...a, sql });
}

export function compileUpdate(node: UpdateNode, modelOverride?: ModelDef<any>): SQLArtifact {
  const m = modelDef(node.model, modelOverride);
  if (node.upsertCreate) {
    return post(compileMergeUpsert(node, m));
  }
  const pk = primaryKeyOf(m);
  const a = pgCompileUpdate(node, modelOverride, MssqlDialect);
  let sql = a.sql;
  const tableQ = `[${m.collection}]`;
  sql = rewriteCtidSingleRow(sql, tableQ, pk);
  sql = rewriteReturningForUpdate(sql);
  return post({ ...a, sql });
}

// MERGE upsert — T-SQL's atomic INSERT-or-UPDATE. The PG pipeline uses
// `INSERT … ON CONFLICT (uniques) DO UPDATE`; T-SQL has no equivalent
// single-statement form except MERGE. Behaviour parity with the PG path:
//
//   • Conflict target columns are derived from the wrapper's eq-leaf where
//     tree (`{ where: { sku: 'A' } }` → conflict on `[sku]`). The wrapper
//     enforces that the where tree is a single-column or AND-of-eq tree,
//     so this is reliable.
//   • SET clause includes increments / multiplies / pushes / unsets, like
//     compileUpdate's plain-update path — reuses the PG builder's SET parts
//     by extracting them from a regular compileUpdate (without upsertCreate)
//     and rewriting the column refs to src.<col>.
//   • The OUTPUT clause returns inserted.*, matching PG's RETURNING.
//   • No `skipDuplicates` flag — MERGE always either updates or inserts.
function compileMergeUpsert(node: UpdateNode, m: ModelDef<any>): SQLArtifact {
  const table = `[${m.collection.replace(/]/g, ']]')}]`;
  const params: unknown[] = [];
  const ph = (v: unknown) => MssqlDialect.placeholder(params, v);

  // INSERT side — every field the caller passed in upsertCreate. Final
  // column list + values list are computed at the end (after we've ensured
  // every conflict column appears here too), so we don't pre-emit
  // placeholders that would double-count in `params`.
  const insertCols = Object.keys(node.upsertCreate!);
  if (insertCols.length === 0) {
    throw new Error('[forge:mssql] upsert requires at least one field in create.');
  }

  // UPDATE side — `set`, `increment`, `multiply`, `unset` in that order.
  const updateParts: string[] = [];
  if (node.set) {
    for (const [k, v] of Object.entries(node.set)) {
      updateParts.push(`[${k}] = ${ph(v)}`);
    }
  }
  if (node.increment) {
    for (const [k, v] of Object.entries(node.increment)) {
      updateParts.push(`[${k}] = COALESCE(tgt.[${k}], 0) + ${ph(v)}`);
    }
  }
  if (node.multiply) {
    for (const [k, v] of Object.entries(node.multiply)) {
      updateParts.push(`[${k}] = COALESCE(tgt.[${k}], 0) * ${ph(v)}`);
    }
  }
  if (node.unset?.length) {
    for (const k of node.unset) updateParts.push(`[${k}] = NULL`);
  }
  // If the caller only passed `create` and no update payload, MERGE still
  // needs WHEN MATCHED — fall back to a self-assignment of the conflict
  // columns (no-op) so the statement is valid.
  const conflictCols = whereEqLeafColumns(node.where);
  if (conflictCols.length === 0) {
    throw new Error(
      `[forge:mssql] upsert requires a conflict target. Use { where: { uniqueCol: value } } ` +
      `(or AND of eq leaves) so the MERGE knows which key identifies an existing row.`,
    );
  }
  if (updateParts.length === 0) {
    updateParts.push(`[${conflictCols[0]}] = tgt.[${conflictCols[0]}]`);
  }

  // ON clause — every conflict column matches between tgt and src.
  const onClause = conflictCols.map((c) => `tgt.[${c}] = src.[${c}]`).join(' AND ');

  // Build the source row. Every conflict column MUST be in the VALUES list —
  // pull from the where leaf for any column the caller omitted from create.
  for (const c of conflictCols) {
    if (!insertCols.includes(c)) {
      const v = whereLeafEqValue(node.where, c);
      if (v === undefined) {
        throw new Error(
          `[forge:mssql] upsert conflict column '${c}' is in the where clause but not in create. ` +
          `Add it to create so MERGE can route it to the INSERT branch.`,
        );
      }
      insertCols.push(c);
    }
  }

  const finalCols = insertCols.map((c) => `[${c}]`).join(', ');
  const finalVals = insertCols.map((c) => {
    if (c in node.upsertCreate!) return ph(node.upsertCreate![c]);
    return ph(whereLeafEqValue(node.where, c));
  }).join(', ');

  // INSERT branch values come from src.<col> after USING (VALUES ...) AS src(<cols>).
  const srcInsertValues = insertCols.map((c) => `src.[${c}]`).join(', ');

  const sql =
    `MERGE INTO ${table} AS tgt ` +
    `USING (VALUES (${finalVals})) AS src (${finalCols}) ` +
    `ON ${onClause} ` +
    `WHEN MATCHED THEN UPDATE SET ${updateParts.join(', ')} ` +
    `WHEN NOT MATCHED THEN INSERT (${finalCols}) VALUES (${srcInsertValues}) ` +
    `OUTPUT INSERTED.*;`;

  return { kind: 'sql', dialect: 'mssql', sql, params };
}

function whereEqLeafColumns(tree: UpdateNode['where']): string[] {
  if (!tree) return [];
  if (tree.kind === 'leaf' && tree.op === 'eq') return [tree.field];
  if (tree.kind === 'and') return tree.children.flatMap(whereEqLeafColumns);
  return [];
}

function whereLeafEqValue(tree: UpdateNode['where'], col: string): unknown {
  if (!tree) return undefined;
  if (tree.kind === 'leaf' && tree.op === 'eq' && tree.field === col) return tree.value;
  if (tree.kind === 'and') {
    for (const child of tree.children) {
      const v = whereLeafEqValue(child, col);
      if (v !== undefined) return v;
    }
  }
  return undefined;
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
