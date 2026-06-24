// DuckDB DDL — delegates to the Postgres DDL generator with the DuckdbDialect
// injected. DuckDB CREATE TABLE / CREATE INDEX / CREATE [UNIQUE] CONSTRAINT
// are Postgres-shaped; the dialect's columnType handles the type renaming
// (text → VARCHAR, jsonb → JSON, double precision → DOUBLE, etc.) and
// searchClause routes .searchable() through ILIKE.
//
// One DuckDB nuance worth knowing: foreign keys are accepted at CREATE TABLE
// time but DuckDB does NOT actually enforce them at write time (DuckDB is an
// OLAP store; relational integrity is an analytics nice-to-have, not a
// transactional invariant). The forge DDL still emits them so introspection
// and diff see them; the runtime contract is "they're documented, not
// enforced."

import type { SchemaMap } from '../../schema';
import { buildSchemaDDL as pgBuildSchemaDDL, type DDLStatement, type BuildDDLOptions } from '../postgres/ddl';
import { DuckdbDialect } from './dialect';

export type { DDLStatement };

export function buildSchemaDDL(
  schema: SchemaMap,
  opts: BuildDDLOptions = {},
): DDLStatement[] {
  const stmts = pgBuildSchemaDDL(schema, { ...opts, dialect: opts.dialect ?? DuckdbDialect });
  // DuckDB raises "Creating partial indexes is not supported currently" when a
  // CREATE INDEX statement carries a WHERE clause. Strip it so the schema
  // still pushes; the partial-unique semantics degrade to a plain unique
  // (an extra rebroadcast lands at the wrapper layer). Also strip INCLUDE
  // — DuckDB doesn't support covering columns yet either.
  return stmts.map((s) => {
    if (s.kind !== 'index') return s;
    let sql = s.sql;
    const beforeWhere = sql;
    sql = sql.replace(/\s+WHERE\s+.+$/i, '');
    sql = sql.replace(/\s+INCLUDE\s+\([^)]*\)\s*/i, ' ');
    if (sql !== beforeWhere) {
      // eslint-disable-next-line no-console
      console.warn(
        `[forge:push:duckdb] index '${s.name}' uses 'where' or 'include' — DuckDB ` +
        `doesn't support partial / covering indexes yet. Emitted as a plain index.`,
      );
    }
    // PG resolves method:'spatial' to USING gist (PostGIS). On DuckDB the
    // spatial index family is R-tree (delivered by the `spatial` extension,
    // auto-loaded at adapter connect). Rewrite USING gist → USING RTREE.
    sql = sql.replace(/\sUSING\s+gist\b/i, ' USING RTREE');
    // method:'vector' on PG resolves to USING hnsw + pgvector opclass.
    // DuckDB's vss extension uses USING HNSW too, but without the opclass.
    sql = sql.replace(/\sUSING\s+hnsw\b/i, ' USING HNSW');
    sql = sql.replace(/\s+vector_(?:cosine|l2|ip)_ops/g, '');
    return { ...s, sql };
  });
}
