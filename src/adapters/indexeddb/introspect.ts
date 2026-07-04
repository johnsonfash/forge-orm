// Introspection — enough to power $diff / doctor.
//
// Object stores + their indexes are the whole schema surface on IDB. Fields
// are not part of the schema (IDB is schemaless), so column-level drift
// doesn't exist here. The dialect-agnostic `DbIntrospection` shape has a
// `columns` field per table for parity with SQL adapters — we synthesise
// it from the store's `keyPath` (always present) plus any indexed key paths
// (they're field names on stored objects), so the diff comparator has
// SOMETHING to walk. Type is left as 'unknown' — IDB is untyped storage.

import type { DbIntrospection, IntrospectedTable, IntrospectedIndex, IntrospectedColumn } from '../types';

export async function introspect(db: IDBDatabase): Promise<DbIntrospection> {
  const tables: IntrospectedTable[] = [];
  const names = Array.from(db.objectStoreNames);
  if (names.length === 0) return { kind: 'indexeddb', tables, views: [] };

  const tx = db.transaction(names, 'readonly');
  for (const n of names) {
    const store = tx.objectStore(n);
    const indexes: IntrospectedIndex[] = Array.from(store.indexNames).map((iName) => {
      const i = store.index(iName);
      const columns = Array.isArray(i.keyPath) ? [...i.keyPath] : [String(i.keyPath)];
      return { name: iName, columns, unique: i.unique };
    });

    // Synthesise a column list from the store's keyPath + every index's
    // keyPath. This is not a strict schema view — IDB values can carry any
    // shape — but it's what a diff tool needs to notice missing indexes.
    const seen = new Set<string>();
    const columns: IntrospectedColumn[] = [];
    const push = (name: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      columns.push({ name, type: 'unknown', nullable: true });
    };
    if (typeof store.keyPath === 'string') push(store.keyPath);
    else if (Array.isArray(store.keyPath)) for (const k of store.keyPath) push(String(k));
    for (const idx of indexes) for (const c of idx.columns) push(c);

    tables.push({ name: n, columns, indexes, foreignKeys: [] });
  }

  return { kind: 'indexeddb', tables, views: [] };
}
