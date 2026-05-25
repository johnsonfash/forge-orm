// MySQL IR consumer — emits MySQL SQL + ? placeholders.
//
// Forks the PG compiler's dialect, then patches the upsert path (MySQL's
// `INSERT … ON DUPLICATE KEY UPDATE col = VALUES(col)` looks different
// from PG's `ON CONFLICT (col) DO UPDATE SET col = ?`), and drops PG-only
// idioms (`ctid` → emulated with subquery on PK; `RETURNING *` not emitted
// because MySQL doesn't support it — the executor does a follow-up SELECT).

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
import { MysqlDialect } from './dialect';
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
  if (!m) throw new Error(`[forge:mysql] unknown model '${modelKey}' in IR`);
  return m;
}

function coerceParams(params: unknown[]): unknown[] {
  return params.map((v) => {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v instanceof Date) return v;       // mysql2 handles Date natively
    if (Array.isArray(v) || (typeof v === 'object' && v !== null && !(v instanceof Date))) {
      return JSON.stringify(v);
    }
    return v;
  });
}

function strip(s: string, re: RegExp): string {
  return s.replace(re, '');
}

function post(a: SQLArtifact): SQLArtifact {
  return { kind: 'sql', dialect: 'mysql', sql: a.sql, params: coerceParams(a.params) };
}

export function compileSelect(node: SelectNode, modelOverride?: ModelDef<any>): SQLArtifact {
  const a = pgCompileSelect(node, modelOverride, MysqlDialect);
  // MySQL has no DISTINCT ON — rewrite to plain DISTINCT.
  const sql = a.sql.replace(/^SELECT DISTINCT ON \([^)]+\) /, 'SELECT DISTINCT ');
  return post({ ...a, sql });
}

export function compileCount(node: CountNode, modelOverride?: ModelDef<any>): SQLArtifact {
  return post(pgCompileCount(node, modelOverride, MysqlDialect));
}

export function compileInsert(node: InsertNode, modelOverride?: ModelDef<any>): SQLArtifact {
  // PG compiler appends ` RETURNING *` (or `RETURNING col, col`). MySQL
  // doesn't support RETURNING — strip it. The executor follows up with a
  // SELECT to recover the inserted rows.
  const a = pgCompileInsert(node, modelOverride, MysqlDialect);
  const sql = strip(a.sql, / RETURNING (?:\*|"[^"]+"(?:,\s*"[^"]+")*)\s*$/);
  return post({ ...a, sql });
}

export function compileUpdate(node: UpdateNode, modelOverride?: ModelDef<any>): SQLArtifact {
  // For upsert, PG produces:
  //   INSERT INTO t (cols) VALUES (...) ON CONFLICT (col) DO UPDATE SET ... RETURNING *
  // MySQL needs:
  //   INSERT INTO t (cols) VALUES (...) ON DUPLICATE KEY UPDATE col1 = VALUES(col1), col2 = VALUES(col2)
  // MysqlDialect.upsertConflictClause already swaps the ON CONFLICT bit; we
  // just need to rewrite assignment-side bare `col = ?` into `col = VALUES(col)`.
  let a = pgCompileUpdate(node, modelOverride, MysqlDialect);
  let sql = a.sql;

  // RETURNING * is unsupported — drop it; executor does follow-up SELECT.
  sql = strip(sql, / RETURNING (?:\*|`[^`]+`(?:,\s*`[^`]+`)*)\s*$/);

  // ctid (PG hidden row id) → no equivalent in MySQL; use `LIMIT 1` on the
  // OUTER update for single-row writes. The PG compiler's ctid subquery
  // technique doesn't translate cleanly, so rewrite single-row updates to
  // a plain `UPDATE … WHERE … LIMIT 1` form.
  sql = sql.replace(
    /UPDATE (`[^`]+`) SET (.+?) WHERE ctid = \(SELECT ctid FROM \1 WHERE (.+?) LIMIT 1\)/,
    'UPDATE $1 SET $2 WHERE $3 LIMIT 1',
  );

  // For upsert: rewrite `ON DUPLICATE KEY UPDATE col = ?` (with leftover ?
  // placeholders from PG's SET clause) to `ON DUPLICATE KEY UPDATE col =
  // VALUES(col)`. We use VALUES() instead of repeating placeholders since
  // the VALUES already supplied the new values.
  if (node.upsertCreate && sql.includes('ON DUPLICATE KEY UPDATE')) {
    // Find the SET assignments after ON DUPLICATE KEY UPDATE.
    const m = sql.match(/ON DUPLICATE KEY UPDATE (.+?)$/);
    if (m) {
      // Replace each `col = <expression>` with `col = VALUES(col)`.
      const rewritten = m[1].split(',').map((assign) => {
        const eq = assign.indexOf('=');
        if (eq < 0) return assign;
        const lhs = assign.slice(0, eq).trim();
        return ` ${lhs} = VALUES(${lhs})`;
      }).join(',').trim();
      sql = sql.replace(/ON DUPLICATE KEY UPDATE .+$/, `ON DUPLICATE KEY UPDATE ${rewritten}`);

      // Strip the now-unused placeholders from the params array: PG's
      // compiler pushed VALUES params + SET-clause params. The SET params
      // are now embedded as VALUES(col) — drop them.
      // The params at this point: [values_params..., set_clause_params...].
      // We assume node.set's keys count + node.increment/multiply count
      // matched the SET clause length. Simplest: keep only the first
      // Object.keys(node.upsertCreate).length params.
      const keep = Object.keys(node.upsertCreate).length;
      return post({ ...a, sql, params: a.params.slice(0, keep) });
    }
  }

  return post({ ...a, sql });
}

export function compileDelete(node: DeleteNode, modelOverride?: ModelDef<any>): SQLArtifact {
  const a = pgCompileDelete(node, modelOverride, MysqlDialect);
  let sql = a.sql;
  // RETURNING unsupported.
  sql = strip(sql, / RETURNING (?:\*|`[^`]+`(?:,\s*`[^`]+`)*)\s*$/);
  // Single-row DELETE — rewrite ctid idiom to `LIMIT 1`.
  sql = sql.replace(
    /DELETE FROM (`[^`]+`) WHERE ctid = \(SELECT ctid FROM \1 WHERE (.+?) LIMIT 1\)/,
    'DELETE FROM $1 WHERE $2 LIMIT 1',
  );
  return post({ ...a, sql });
}

export function compileGroupBy(node: GroupByNode, modelOverride?: ModelDef<any>): SQLArtifact {
  return post(pgCompileGroupBy(node, modelOverride, MysqlDialect));
}

// expose modelDef for the executor's follow-up SELECT
export { modelDef };
