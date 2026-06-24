// DuckDB introspection — reads back tables / columns / indexes / FKs via
// the duckdb_* metadata functions. Used by forge diff to detect drift.

import type {
  DbIntrospection,
  IntrospectedColumn,
  IntrospectedForeignKey,
  IntrospectedIndex,
  IntrospectedTable,
} from '../types';
import type { DuckdbQueryable } from './driver';

export async function introspectDuckdb(driver: DuckdbQueryable): Promise<DbIntrospection> {
  const tables = await driver.query(
    `SELECT table_name FROM duckdb_tables() WHERE schema_name = current_schema()`,
  );

  const cols = await driver.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM duckdb_columns() WHERE schema_name = current_schema()
       ORDER BY table_name, column_index`,
  );

  // DuckDB lists indexes per (table, name); to get the columns we parse the
  // `sql` field (CREATE INDEX … ON tbl (cols)) — duckdb_indexes() doesn't
  // expose a structured column list yet.
  const idx = await driver.query(
    `SELECT table_name, index_name, is_unique, sql
       FROM duckdb_indexes() WHERE schema_name = current_schema()`,
  );

  // FKs come through duckdb_constraints() — type='FOREIGN KEY'.
  const fks = await driver.query(
    `SELECT table_name, constraint_name, constraint_column_names, referenced_table, referenced_column_names
       FROM duckdb_constraints()
      WHERE schema_name = current_schema() AND constraint_type = 'FOREIGN KEY'`,
  );

  const tableMap = new Map<string, IntrospectedTable>();
  const ensure = (name: string): IntrospectedTable => {
    let t = tableMap.get(name);
    if (!t) { t = { name, columns: [], indexes: [], foreignKeys: [] }; tableMap.set(name, t); }
    return t;
  };
  for (const r of tables.rows as any[]) ensure(r.table_name);
  for (const r of cols.rows as any[]) {
    ensure(r.table_name).columns.push(normalizeColumn(r));
  }
  for (const r of idx.rows as any[]) {
    const columns = parseIndexColumns(String(r.sql ?? ''));
    const ix: IntrospectedIndex = {
      name: r.index_name,
      columns,
      unique: !!r.is_unique,
    };
    ensure(r.table_name).indexes.push(ix);
  }
  for (const r of fks.rows as any[]) {
    const onCols: string[] = Array.isArray(r.constraint_column_names)
      ? r.constraint_column_names
      : [];
    const refCols: string[] = Array.isArray(r.referenced_column_names)
      ? r.referenced_column_names
      : [];
    if (onCols.length && refCols.length) {
      ensure(r.table_name).foreignKeys.push({
        name: r.constraint_name,
        column: onCols[0],
        refTable: r.referenced_table,
        refColumn: refCols[0],
      } as IntrospectedForeignKey);
    }
  }

  return {
    kind: 'duckdb',
    tables: [...tableMap.values()],
    views: [], // DuckDB views via duckdb_views() — not surfaced for diff yet.
  };
}

function normalizeColumn(r: any): IntrospectedColumn {
  return {
    name: r.column_name,
    type: String(r.data_type).toLowerCase(),
    nullable: r.is_nullable === true,
    default: r.column_default ?? undefined,
  };
}

// `CREATE [UNIQUE] INDEX name ON table (a, b)` — pull out the column list.
function parseIndexColumns(sql: string): string[] {
  const m = sql.match(/\(([^)]+)\)/);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, '').split(/\s+/)[0])
    .filter(Boolean);
}
