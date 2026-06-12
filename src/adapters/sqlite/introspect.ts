import type { DbIntrospection, IntrospectedTable } from '../types';
import type { SqliteDriver } from './driver';

// Live-schema introspection via sqlite_master + PRAGMA.

export async function introspectSqlite(db: SqliteDriver): Promise<DbIntrospection> {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const objects = await db.all(
    `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'`,
    [],
  ) as Array<{ name: string; type: string }>;

  const tables: IntrospectedTable[] = [];
  const views: { name: string; materialised?: boolean }[] = [];

  for (const obj of objects) {
    if (obj.type === 'view') { views.push({ name: obj.name, materialised: false }); continue; }
    // Skip FTS shadow/internal tables emitted by .searchable().
    if (/_fts(_data|_idx|_content|_docsize|_config)?$/.test(obj.name)) continue;

    const info = await db.all(`PRAGMA table_info(${q(obj.name)})`, []) as any[];
    const columns = info.map((c) => ({
      name: c.name,
      type: String(c.type || '').toLowerCase(),
      nullable: c.notnull === 0,
      default: c.dflt_value ?? undefined,
    }));

    const indexList = await db.all(`PRAGMA index_list(${q(obj.name)})`, []) as any[];
    const indexes = [];
    for (const ix of indexList) {
      const cols = (await db.all(`PRAGMA index_info(${q(ix.name)})`, []) as any[]).map((c) => c.name);
      indexes.push({ name: ix.name, columns: cols, unique: ix.unique === 1 });
    }

    const fkList = await db.all(`PRAGMA foreign_key_list(${q(obj.name)})`, []) as any[];
    const foreignKeys = fkList.map((fk) => ({
      name: `fk_${obj.name}_${fk.from}`,
      column: fk.from,
      refTable: fk.table,
      refColumn: fk.to,
    }));

    tables.push({ name: obj.name, columns, indexes, foreignKeys });
  }

  return { kind: 'sqlite', tables, views };
}
