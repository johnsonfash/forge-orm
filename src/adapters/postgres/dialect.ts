// Postgres dialect details — quoting, placeholders, type names.
//
// Kept in one file so the compiler stays dialect-neutral and we can fork
// MySQL / SQLite by swapping just this. The MySQL adapter (Wave 3) will
// export the same shape with `?` placeholders and backtick quoting; SQLite
// with `?` placeholders and double-quote identifiers.

import type { FieldDef } from '../../schema/types';

export interface Dialect {
  readonly name: 'postgres' | 'mysql' | 'sqlite';
  // Quote an identifier (table / column / index name). PG uses double-quotes,
  // case-sensitive when quoted. We always quote.
  quoteIdent(name: string): string;
  // Make a placeholder for a parameterised query. Returns the placeholder
  // string and pushes the value onto `params`. Postgres: $1, $2, $3, ...
  placeholder(params: unknown[], value: unknown): string;
  // Map a FieldDef to the column's SQL type for DDL generation. Wave 2c uses
  // this in CREATE TABLE; the compiler doesn't need it for queries.
  columnType(field: FieldDef): string;
  // ORDER BY direction with optional NULLS FIRST/LAST.
  orderClause(column: string, direction: 'asc' | 'desc', nulls?: 'first' | 'last'): string;
  // ON CONFLICT helper for upsert. PG: ON CONFLICT (cols) DO UPDATE SET ...
  // MySQL: ON DUPLICATE KEY UPDATE ...
  upsertConflictClause(conflictCols: string[], setAssignments: string): string;
  // Wave 4 — full-text search clause. Per-dialect:
  //   PG:     to_tsvector('simple', col) @@ plainto_tsquery('simple', ?)
  //   MySQL:  MATCH(col) AGAINST (? IN NATURAL LANGUAGE MODE)
  //   SQLite: id IN (SELECT rowid FROM <table>_fts WHERE <table>_fts MATCH ?)
  //          — requires the FTS5 virtual table emitted by .searchable().
  // The third arg gives the dialect the unquoted column name + base table
  // name so SQLite can synthesize its FTS5 lookup. PG/MySQL ignore them.
  searchClause(
    quotedColumn: string,
    paramExpr: string,
    ctx: { rawColumn: string; baseTable: string; quoteIdent: (s: string) => string },
  ): string;
}

export const PostgresDialect: Dialect = {
  name: 'postgres',

  quoteIdent(name) {
    // Reject identifiers containing double-quotes or null bytes to prevent
    // injection through schema names; this should never happen with our
    // schema DSL but defence-in-depth costs nothing.
    if (/["\0]/.test(name)) {
      throw new Error(`[forge:postgres] invalid identifier: ${JSON.stringify(name)}`);
    }
    return `"${name}"`;
  },

  placeholder(params, value) {
    params.push(value);
    return `$${params.length}`;
  },

  columnType(field) {
    switch (field.kind) {
      case 'id':         return 'text'; // Wave 2d: switch by f.id({ type }) → uuid / bigserial
      case 'objectId':   return 'text'; // FK to a Mongo-style id is text; pure-PG schemas would use uuid
      case 'string':     return 'text';
      case 'text':       return 'text';
      case 'int':        return 'integer';
      case 'float':      return 'double precision';
      case 'bool':       return 'boolean';
      case 'dateTime':   return 'timestamptz';
      case 'json':       return 'jsonb';
      case 'enum':       return 'text'; // + CHECK constraint applied at DDL time
      case 'embed':      return 'jsonb';
      case 'embedMany':  return 'jsonb';
      case 'stringArray':return 'text[]';
      case 'intArray':   return 'integer[]';
    }
  },

  orderClause(column, direction, nulls) {
    const dir = direction === 'desc' ? 'DESC' : 'ASC';
    const nullsClause = nulls ? ` NULLS ${nulls.toUpperCase()}` : '';
    return `${column} ${dir}${nullsClause}`;
  },

  upsertConflictClause(conflictCols, setAssignments) {
    const cols = conflictCols.join(', ');
    return `ON CONFLICT (${cols}) DO UPDATE SET ${setAssignments}`;
  },

  searchClause(quotedColumn, paramExpr, _ctx) {
    return `to_tsvector('simple', ${quotedColumn}) @@ plainto_tsquery('simple', ${paramExpr})`;
  },
};
