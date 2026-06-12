import type { FieldDef } from '../../schema/types';
import type { Dialect } from '../postgres/dialect';

// SQLite dialect. Mostly Postgres-compatible (double-quoted idents, ON CONFLICT
// upsert, NULLS FIRST/LAST since 3.30), but:
//   • `?` positional placeholders, not `$1, $2, …`.
//   • No native bigserial/uuid (→ TEXT/INTEGER), no bool (→ 0/1 INTEGER),
//     no text[] (→ JSON in TEXT; array ops map to json_each / json_array_length).

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
      case 'id':
        // bigserial → INTEGER (rowid-aliased — the ddl builder writes
        // `PRIMARY KEY AUTOINCREMENT` inline on the column rather than as
        // a separate clause, because SQLite only honours autoincrement
        // when the PK is declared on the column itself).
        if (field.idType === 'bigserial') return 'INTEGER';
        return 'TEXT';
      case 'objectId':   return 'TEXT';
      case 'string':     return 'TEXT';
      case 'text':       return 'TEXT';
      case 'int':        return 'INTEGER';
      case 'float':      return 'REAL';
      case 'decimal':    return 'NUMERIC';        // SQLite has dynamic typing; NUMERIC affinity
      case 'uuid':       return 'TEXT';
      case 'bigint':     return 'INTEGER';        // 64-bit; better-sqlite3 returns bigint when safeIntegers
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
    // Route through the `<base>_fts` FTS5 table (content_rowid=rowid) emitted by
    // .searchable(). If the field wasn't marked .searchable() the table is
    // absent and SQLite's "no such table" is the actionable error.
    const ftsTable = ctx.quoteIdent(`${ctx.baseTable}_fts`);
    const baseTable = ctx.quoteIdent(ctx.baseTable);
    return `${baseTable}.rowid IN (SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH ${paramExpr})`;
  },
};
