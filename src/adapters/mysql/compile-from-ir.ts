// MySQL IR consumer — runs the PG compiler with MysqlDialect, then patches the
// output: rewrites upsert (ON CONFLICT → ON DUPLICATE KEY UPDATE col=VALUES),
// the ctid single-row idiom → LIMIT 1, and strips RETURNING (unsupported).

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
  // Strip the PG compiler's RETURNING — unsupported; executor re-SELECTs.
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

  // RETURNING unsupported — strip; executor re-SELECTs.
  sql = strip(sql, / RETURNING (?:\*|`[^`]+`(?:,\s*`[^`]+`)*)\s*$/);

  // MySQL has no ctid. PG's ctid-subquery single-row idiom → `UPDATE … LIMIT 1`.
  sql = sql.replace(
    /UPDATE (`[^`]+`) SET (.+?) WHERE ctid = \(SELECT ctid FROM \1 WHERE (.+?) LIMIT 1\)/,
    'UPDATE $1 SET $2 WHERE $3 LIMIT 1',
  );

  // Upsert: rewrite each `col = ?` after ON DUPLICATE KEY UPDATE to
  // `col = VALUES(col)`, reusing the values already supplied in VALUES(...).
  if (node.upsertCreate && sql.includes('ON DUPLICATE KEY UPDATE')) {
    const m = sql.match(/ON DUPLICATE KEY UPDATE (.+?)$/);
    if (m) {
      const rewritten = m[1].split(',').map((assign) => {
        const eq = assign.indexOf('=');
        if (eq < 0) return assign;
        const lhs = assign.slice(0, eq).trim();
        return ` ${lhs} = VALUES(${lhs})`;
      }).join(',').trim();
      sql = sql.replace(/ON DUPLICATE KEY UPDATE .+$/, `ON DUPLICATE KEY UPDATE ${rewritten}`);

      // Params are [values_params..., set_clause_params...]. The SET params are
      // now embedded as VALUES(col), so drop them — keep only the VALUES params.
      const keep = Object.keys(node.upsertCreate).length;
      return post({ ...a, sql, params: a.params.slice(0, keep) });
    }
  }

  return post({ ...a, sql });
}

export function compileDelete(node: DeleteNode, modelOverride?: ModelDef<any>): SQLArtifact {
  const a = pgCompileDelete(node, modelOverride, MysqlDialect);
  let sql = a.sql;
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

export { modelDef };
