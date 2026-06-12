import type { DbIntrospection, IntrospectedTable } from '../types';
import type { SqliteDb } from './execute';

// Live-schema introspection via sqlite_master + PRAGMA. Sync driver resolved
// into a Promise to satisfy the async Adapter contract.

export async function introspectSqlite(db: SqliteDb): Promise<DbIntrospection> {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const objects = db
    .prepare(`SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'`)
    .all() as Array<{ name: string; type: string }>;

  const tables: IntrospectedTable[] = [];
  const views: { name: string; materialised?: boolean }[] = [];

  for (const obj of objects) {
    if (obj.type === 'view') { views.push({ name: obj.name, materialised: false }); continue; }
    // Skip FTS shadow/internal tables emitted by .searchable().
    if (/_fts(_data|_idx|_content|_docsize|_config)?$/.test(obj.name)) continue;

    const info = db.prepare(`PRAGMA table_info(${q(obj.name)})`).all() as any[];
    const columns = info.map((c) => ({
      name: c.name,
      type: String(c.type || '').toLowerCase(),
      nullable: c.notnull === 0,
      default: c.dflt_value ?? undefined,
    }));

    const indexList = db.prepare(`PRAGMA index_list(${q(obj.name)})`).all() as any[];
    const indexes = indexList.map((ix) => {
      const cols = (db.prepare(`PRAGMA index_info(${q(ix.name)})`).all() as any[]).map((c) => c.name);
      return { name: ix.name, columns: cols, unique: ix.unique === 1 };
    });

    const fkList = db.prepare(`PRAGMA foreign_key_list(${q(obj.name)})`).all() as any[];
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
