import type { FieldDef } from '../../schema/types';
import type { Dialect } from '../postgres/dialect';

// SQLite dialect. Mostly Postgres-compatible since SQLite borrows liberally
// from the SQL standard, but:
//   • Placeholders are `?` (positional), not `$1, $2, …`.
//   • No native `bigserial` / `uuid` types — fall back to TEXT or INTEGER.
//   • No `bool` type — store 0 / 1 in INTEGER (we coerce values at insert).
//   • No `text[]` — store JSON in TEXT. Array operators map to json_each(),
//     json_array_length(), etc. in the compiler.
//   • `NULLS FIRST/LAST` supported since 3.30 (2019).
//   • Identifiers are double-quoted (same as PG).
//   • Upsert syntax: `ON CONFLICT (col) DO UPDATE SET ...` (same as PG since 3.24, 2018).

export const SqliteDialect: Dialect = {
  name: 'sqlite',

  quoteIdent(name) {
    if (/["\0]/.test(name)) {
      throw new Error(`[forge:sqlite] invalid identifier: ${JSON.stringify(name)}`);
    }
    return `"${name}"`;
  },

  placeholder(params, value) {
    params.push(value);
    return '?';
  },

  columnType(field: FieldDef) {
    switch (field.kind) {
      case 'id':         return 'TEXT';
      case 'objectId':   return 'TEXT';
      case 'string':     return 'TEXT';
      case 'text':       return 'TEXT';
      case 'int':        return 'INTEGER';
      case 'float':      return 'REAL';
      case 'bool':       return 'INTEGER';       // 0 / 1
      case 'dateTime':   return 'TEXT';           // ISO 8601 string
      case 'json':       return 'TEXT';           // JSON-encoded
      case 'enum':       return 'TEXT';           // + CHECK
      case 'embed':      return 'TEXT';           // JSON
      case 'embedMany':  return 'TEXT';           // JSON array
      case 'stringArray':return 'TEXT';           // JSON array
      case 'intArray':   return 'TEXT';           // JSON array
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

  searchClause(_quotedColumn, paramExpr, ctx) {
    // Wave 4c — route through the FTS5 virtual table emitted by .searchable().
    // The FTS table is named `<base>_fts` and uses content_rowid=rowid, so we
    // rewrite the predicate to: `<base>.rowid IN (SELECT rowid FROM <base>_fts WHERE <base>_fts MATCH ?)`.
    // If the FTS table doesn't exist (field wasn't marked .searchable()),
    // SQLite returns "no such table" — that's the actionable error the user
    // gets, pointing them at the schema marker.
    const ftsTable = ctx.quoteIdent(`${ctx.baseTable}_fts`);
    const baseTable = ctx.quoteIdent(ctx.baseTable);
    return `${baseTable}.rowid IN (SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH ${paramExpr})`;
  },
};
