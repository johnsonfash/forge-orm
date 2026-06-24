// SQL Server introspection via sys.* + INFORMATION_SCHEMA. Used by forge
// diff to detect drift.

import type {
  DbIntrospection,
  IntrospectedColumn,
  IntrospectedForeignKey,
  IntrospectedIndex,
  IntrospectedTable,
} from '../types';
import type { MssqlQueryable } from './driver';

export async function introspectMssql(driver: MssqlQueryable): Promise<DbIntrospection> {
  const tables = await driver.query(
    `SELECT t.name AS table_name FROM sys.tables t
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       WHERE s.name = SCHEMA_NAME()`,
  );

  const cols = await driver.query(
    `SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name,
            c.DATA_TYPE AS data_type, c.IS_NULLABLE AS is_nullable,
            c.COLUMN_DEFAULT AS column_default
       FROM INFORMATION_SCHEMA.COLUMNS c
      WHERE c.TABLE_SCHEMA = SCHEMA_NAME()
      ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
  );

  const idx = await driver.query(
    `SELECT t.name AS table_name, i.name AS index_name, i.is_unique AS is_unique,
            STUFF((
              SELECT ',' + c.name FROM sys.index_columns ic
                JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id
                ORDER BY ic.key_ordinal
                FOR XML PATH('')
            ), 1, 1, '') AS cols
       FROM sys.indexes i
       JOIN sys.tables  t ON t.object_id = i.object_id
       JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name = SCHEMA_NAME() AND i.is_primary_key = 0 AND i.name IS NOT NULL`,
  );

  const fks = await driver.query(
    `SELECT fk.name AS constraint_name, t.name AS table_name,
            cpa.name AS column_name, rt.name AS ref_table, cref.name AS ref_column
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.tables  t  ON t.object_id  = fk.parent_object_id
       JOIN sys.tables  rt ON rt.object_id = fk.referenced_object_id
       JOIN sys.columns cpa  ON cpa.object_id = fk.parent_object_id     AND cpa.column_id = fkc.parent_column_id
       JOIN sys.columns cref ON cref.object_id = fk.referenced_object_id AND cref.column_id = fkc.referenced_column_id
       JOIN sys.schemas s  ON s.schema_id = t.schema_id
      WHERE s.name = SCHEMA_NAME()`,
  );

  const tableMap = new Map<string, IntrospectedTable>();
  const ensure = (name: string): IntrospectedTable => {
    let t = tableMap.get(name);
    if (!t) { t = { name, columns: [], indexes: [], foreignKeys: [] }; tableMap.set(name, t); }
    return t;
  };

  for (const r of tables.rows as any[]) ensure(r.table_name);
  for (const r of cols.rows as any[]) ensure(r.table_name).columns.push(normalizeColumn(r));
  for (const r of idx.rows as any[]) {
    const columns = String(r.cols ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const ix: IntrospectedIndex = { name: r.index_name, columns, unique: !!r.is_unique };
    ensure(r.table_name).indexes.push(ix);
  }
  for (const r of fks.rows as any[]) {
    ensure(r.table_name).foreignKeys.push({
      name: r.constraint_name, column: r.column_name,
      refTable: r.ref_table, refColumn: r.ref_column,
    } as IntrospectedForeignKey);
  }

  return { kind: 'mssql', tables: [...tableMap.values()], views: [] };
}

function normalizeColumn(r: any): IntrospectedColumn {
  return {
    name: r.column_name,
    type: String(r.data_type).toLowerCase(),
    nullable: r.is_nullable === 'YES',
    default: r.column_default ?? undefined,
  };
}
