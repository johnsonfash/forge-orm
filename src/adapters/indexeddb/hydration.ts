// Relation hydration + relation-count materialisation.
//
// Same pattern the SQL adapters use, but sourced from IDB indexes instead
// of SQL joins. For each RelationPlan on the SelectNode.hydration array we
// collect parent keys once, do a single index scan on the target store, and
// attach results in-place. That's O(1) query per relation, not O(N).
//
// Hydrated shape:
//   * rel.kind === 'many' — child holds the FK; group children by rel.on and
//     attach to `parent[rel.name]` as an array.
//   * rel.kind === 'one'  — parent holds the FK; look up child by primary key
//     and attach to `parent[rel.name]` as a single object (or null).
//
// Relation counts (SelectNode.projection.counts: string[]) are handled by
// a separate pass — for each relation name we count children matching the
// parent's ref key and stamp `_count[relName]` on every parent row.

import type { ModelDef, RelationDef } from '../../schema/types';
import type { RelationPlan } from '../../ir/types';
import type { SchemaShape } from '../../schema/active';
import { primaryKeyField } from './planner';
import { cursorScanIds } from './cursor-scan';

export async function hydrate(
  db: IDBDatabase,
  schema: SchemaShape,
  parentModelKey: string,
  parents: Record<string, unknown>[],
  hydration: RelationPlan[] | undefined,
): Promise<Record<string, unknown>[]> {
  if (!hydration || hydration.length === 0 || parents.length === 0) return parents;
  const parentModel = schema[parentModelKey] as unknown as ModelDef<any>;

  for (const rel of hydration) {
    const targetModel = schema[rel.target] as unknown as ModelDef<any> | undefined;
    if (!targetModel) continue;
    if (rel.kind === 'many') {
      const parentKeys = uniqueKeys(parents.map((p) => p[rel.refs]));
      const rows = await getByIndex(db, targetModel.collection, rel.on, parentKeys);
      const grouped = new Map<string, Record<string, unknown>[]>();
      for (const r of rows) {
        const key = String(r[rel.on]);
        const arr = grouped.get(key) ?? [];
        arr.push(r);
        grouped.set(key, arr);
      }
      // Recurse for nested include.
      for (const [k, group] of grouped) {
        if (rel.nested?.hydration) {
          grouped.set(k, await hydrate(db, schema, rel.target, group, rel.nested.hydration));
        }
      }
      for (const p of parents) {
        p[rel.name] = grouped.get(String(p[rel.refs])) ?? [];
      }
    } else {
      const childIds = uniqueKeys(parents.map((p) => p[rel.on]));
      let rows = await cursorScanIds(db, targetModel.collection, childIds);
      if (rel.nested?.hydration) rows = await hydrate(db, schema, rel.target, rows, rel.nested.hydration);
      const targetPk = primaryKeyField(targetModel);
      const byId = new Map(rows.map((r) => [String(r[targetPk]), r] as const));
      for (const p of parents) {
        const key = p[rel.on];
        p[rel.name] = key == null ? null : (byId.get(String(key)) ?? null);
      }
    }
  }

  // Untouched by this pass — _count is handled separately in applyRelationCounts.
  void parentModel;
  return parents;
}

export async function applyRelationCounts(
  db: IDBDatabase,
  schema: SchemaShape,
  parentModelKey: string,
  parents: Record<string, unknown>[],
  counts: string[] | undefined,
): Promise<void> {
  if (!counts || counts.length === 0 || parents.length === 0) return;
  const parentModel = schema[parentModelKey] as unknown as ModelDef<any>;
  const rels = (parentModel.relations?.() ?? {}) as Record<string, RelationDef>;

  for (const p of parents) {
    if (typeof p._count !== 'object' || p._count === null) p._count = {};
  }

  for (const relName of counts) {
    const rel = rels[relName];
    if (!rel) {
      for (const p of parents) (p._count as Record<string, number>)[relName] = 0;
      continue;
    }
    const targetModel = schema[rel.target] as unknown as ModelDef<any> | undefined;
    if (!targetModel) {
      for (const p of parents) (p._count as Record<string, number>)[relName] = 0;
      continue;
    }
    const parentKeys = uniqueKeys(parents.map((p) => p[rel.refs]));
    const rows = await getByIndex(db, targetModel.collection, rel.on, parentKeys);
    const byFk = new Map<string, number>();
    for (const r of rows) {
      const k = String(r[rel.on]);
      byFk.set(k, (byFk.get(k) ?? 0) + 1);
    }
    for (const p of parents) {
      (p._count as Record<string, number>)[relName] = byFk.get(String(p[rel.refs])) ?? 0;
    }
  }
}

async function getByIndex(
  db: IDBDatabase,
  storeName: string,
  keyPath: string,
  keys: IDBValidKey[],
): Promise<Record<string, unknown>[]> {
  if (keys.length === 0) return [];
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const idx = tryIndex(store, keyPath);
  const results: Record<string, unknown>[] = [];
  await Promise.all(keys.map((k) => new Promise<void>((resolve, reject) => {
    const req = idx ? idx.openCursor(IDBKeyRange.only(k)) : store.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      const row = cur.value as Record<string, unknown>;
      if (!idx) {
        if (row[keyPath] === k) results.push(row);
      } else {
        results.push(row);
      }
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  })));
  return results;
}

function tryIndex(store: IDBObjectStore, keyPath: string): IDBIndex | null {
  for (const n of Array.from(store.indexNames)) {
    const i = store.index(n);
    if (typeof i.keyPath === 'string' && i.keyPath === keyPath) return i;
  }
  return null;
}

function uniqueKeys(vs: unknown[]): IDBValidKey[] {
  const seen = new Set<string>();
  const out: IDBValidKey[] = [];
  for (const v of vs) {
    if (v === null || v === undefined) continue;
    const k = String(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v as IDBValidKey);
  }
  return out;
}
