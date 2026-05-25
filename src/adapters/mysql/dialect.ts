import type { FieldDef } from '../../schema/types';
import type { Dialect } from '../postgres/dialect';

// MySQL dialect. Diverges from PG/SQLite in three meaningful ways:
//   • Identifier quoting uses backticks (` ` `name` `).
//   • Placeholders are `?` (positional).
//   • Upsert syntax is `ON DUPLICATE KEY UPDATE`, not `ON CONFLICT (col) DO UPDATE`.
//   • No `text[]` — use JSON.
//   • No `NULLS FIRST/LAST` — sort behaviour follows the collation.
//   • Bools stored as TINYINT(1).

export const MysqlDialect: Dialect = {
  name: 'mysql',

  quoteIdent(name) {
    if (/[`\0]/.test(name)) {
      throw new Error(`[forge:mysql] invalid identifier: ${JSON.stringify(name)}`);
    }
    return '`' + name + '`';
  },

  placeholder(params, value) {
    params.push(value);
    return '?';
  },

  columnType(field: FieldDef) {
    switch (field.kind) {
      case 'id':         return 'VARCHAR(64)';
      case 'objectId':   return 'VARCHAR(64)';
      case 'string':     return 'VARCHAR(255)';   // can be UNIQUE / indexed without a key-length prefix
      case 'text':       return 'TEXT';            // unbounded; can't be UNIQUE without a (n) prefix
      case 'int':        return 'INT';
      case 'float':      return 'DOUBLE PRECISION';
      case 'decimal':    return field.precision != null
                           ? `DECIMAL(${field.precision}${field.scale != null ? `,${field.scale}` : ''})`
                           : 'DECIMAL(10,0)';
      case 'uuid':       return 'CHAR(36)';
      case 'bigint':     return 'BIGINT';
      case 'bool':       return 'TINYINT(1)';
      case 'dateTime':   return 'DATETIME(3)';   // millisecond precision
      case 'json':       return 'JSON';
      case 'enum':       return 'VARCHAR(64)';   // + CHECK
      case 'embed':      return 'JSON';
      case 'embedMany':  return 'JSON';
      case 'stringArray':return 'JSON';
      case 'intArray':   return 'JSON';
    }
  },

  orderClause(column, direction, _nulls) {
    // MySQL doesn't support NULLS FIRST/LAST — silently ignored.
    return `${column} ${direction === 'desc' ? 'DESC' : 'ASC'}`;
  },

  upsertConflictClause(_conflictCols, setAssignments) {
    // MySQL ignores conflictCols — the upsert fires on ANY unique-key
    // conflict. The compiler still passes them for parity / future MariaDB.
    return `ON DUPLICATE KEY UPDATE ${setAssignments}`;
  },

  searchClause(quotedColumn, paramExpr, _ctx) {
    // Requires a FULLTEXT index on the column — emitted automatically when
    // the field is declared `.searchable()`. Without it, MySQL throws.
    return `MATCH(${quotedColumn}) AGAINST (${paramExpr} IN NATURAL LANGUAGE MODE)`;
  },
};
