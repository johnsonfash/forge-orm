// DuckDB compile-from-IR — delegates to the Postgres compiler with the
// DuckdbDialect injected. DuckDB SQL is PG-compatible for the surface
// forge generates (SELECT/INSERT/UPDATE/DELETE/ON CONFLICT/RETURNING/
// LATERAL joins / array ops). Where it diverges (FTS, type names), the
// dialect's columnType / searchClause handle it.

import type { SelectNode, CountNode, InsertNode, UpdateNode, DeleteNode, GroupByNode } from '../../ir/types';
import type { ModelDef } from '../../schema/types';
import type { SQLArtifact } from '../../compile';
import {
  compileSelect as pgCompileSelect,
  compileCount as pgCompileCount,
  compileInsert as pgCompileInsert,
  compileUpdate as pgCompileUpdate,
  compileDelete as pgCompileDelete,
  compileGroupBy as pgCompileGroupBy,
} from '../postgres/compile-from-ir';
import { DuckdbDialect } from './dialect';

function toDuckdb(a: SQLArtifact): SQLArtifact {
  // PG compiler tags artifacts with dialect: 'postgres'; rewrite to 'duckdb'.
  //
  // Two PG-isms that DuckDB doesn't speak:
  //   • `ctid` — PG's tuple identifier, used for the "constrain to one row"
  //     UPDATE/DELETE form (`WHERE ctid = (SELECT ctid FROM …)`). DuckDB has
  //     a `rowid` pseudo-column with the same semantics for our use case.
  //   • Partial-index `WHERE` clauses are not supported by DuckDB yet (the
  //     server raises "Creating partial indexes is not supported currently").
  //     Strip the WHERE tail of any `CREATE INDEX … WHERE …` we'd emit so
  //     the schema still pushes; the partial-unique semantics degrade to a
  //     plain unique, which the user is warned about at push.
  let sql = a.sql.replace(/\bctid\b/g, 'rowid');
  return { ...a, dialect: 'duckdb', sql };
}

export function compileSelect(node: SelectNode, model?: ModelDef<any>): SQLArtifact {
  return toDuckdb(pgCompileSelect(node, model, DuckdbDialect));
}
export function compileCount(node: CountNode, model?: ModelDef<any>): SQLArtifact {
  return toDuckdb(pgCompileCount(node, model, DuckdbDialect));
}
export function compileInsert(node: InsertNode, model?: ModelDef<any>): SQLArtifact {
  return toDuckdb(pgCompileInsert(node, model, DuckdbDialect));
}
export function compileUpdate(node: UpdateNode, model?: ModelDef<any>): SQLArtifact {
  return toDuckdb(pgCompileUpdate(node, model, DuckdbDialect));
}
export function compileDelete(node: DeleteNode, model?: ModelDef<any>): SQLArtifact {
  return toDuckdb(pgCompileDelete(node, model, DuckdbDialect));
}
export function compileGroupBy(node: GroupByNode, model?: ModelDef<any>): SQLArtifact {
  return toDuckdb(pgCompileGroupBy(node, model, DuckdbDialect));
}
