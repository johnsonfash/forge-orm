// Cascade walker — mirrors adapters/mongo/cascade.ts.
//
// IDB has no foreign-key enforcement — the executor runs this walker in JS
// before deleting a parent. For each child relation whose target points at
// the parent (inverse side), we either:
//   * onDelete: 'Cascade' → recurse-delete children (leaves first)
//   * onDelete: 'SetNull' → $unset the FK on children
//   * onDelete: 'Restrict' → throw if children exist
//   * onDelete: 'NoAction' | undefined → skip (orphans allowed)

import type { ModelDef, RelationDef } from '../../schema/types';
import type { SchemaShape } from '../../schema/active';
import { primaryKeyField } from './planner';
import { executeDelete } from './execute';

interface CascadeCtx {
  db: IDBDatabase;
  schema: SchemaShape;
  visited: Set<string>; // "collection:id" to break cycles
}

export async function cascadeDelete(
  db: IDBDatabase,
  schema: SchemaShape,
  modelKey: string,
  parents: Record<string, unknown>[],
): Promise<void> {
  const ctx: CascadeCtx = { db, schema, visited: new Set() };
  await walk(ctx, modelKey, parents);
}

async function walk(ctx: CascadeCtx, modelKey: string, parents: Record<string, unknown>[]): Promise<void> {
  const model = ctx.schema[modelKey] as unknown as ModelDef<any>;
  const pk = primaryKeyField(model);
  const parentIds = parents.map((p) => p[pk] as IDBValidKey);

  // Find every child relation (any model whose relations point at this one).
  for (const [childKey, childModelRaw] of Object.entries(ctx.schema)) {
    const childModel = childModelRaw as unknown as ModelDef<any>;
    const rels = (childModel.relations?.() ?? {}) as Record<string, RelationDef>;
    for (const rel of Object.values(rels)) {
      if (rel.target !== modelKey) continue;
      if (rel.kind !== 'one') continue; // "child holds FK" is `one` on the child.
      if (rel.inverse) continue;
      const action = rel.onDelete;
      if (!action || action === 'NoAction') continue;

      // Load matching children.
      const tx = ctx.db.transaction(childModel.collection, 'readonly');
      const store = tx.objectStore(childModel.collection);
      const idx = findIdx(store, rel.on);
      const children: Record<string, unknown>[] = [];
      for (const pid of parentIds) {
        const key = `${childKey}:${String(pid)}`;
        if (ctx.visited.has(key)) continue;
        ctx.visited.add(key);
        await new Promise<void>((resolve, reject) => {
          const req = idx ? idx.openCursor(IDBKeyRange.only(pid)) : store.openCursor();
          req.onsuccess = () => {
            const cur = req.result;
            if (!cur) return resolve();
            const row = cur.value as Record<string, unknown>;
            if (!idx && row[rel.on] !== pid) { cur.continue(); return; }
            children.push(row);
            cur.continue();
          };
          req.onerror = () => reject(req.error);
        });
      }

      if (children.length === 0) continue;

      if (action === 'Restrict') {
        throw new Error(`onDelete Restrict: cannot delete ${modelKey} — ${children.length} child ${childKey} row(s) exist`);
      }

      if (action === 'Cascade') {
        await walk(ctx, childKey, children); // recurse first (leaves-first)
        const childPk = primaryKeyField(childModel);
        await executeDelete(ctx.db, {
          kind: 'delete', model: childKey, many: true,
          where: {
            kind: 'leaf', field: childPk, op: 'in',
            value: children.map((c) => c[childPk]),
          },
        }, childModel, {}, ctx.schema);
      } else if (action === 'SetNull') {
        // Wipe FK on children — write directly through a readwrite txn.
        const wx = ctx.db.transaction(childModel.collection, 'readwrite');
        const wstore = wx.objectStore(childModel.collection);
        for (const c of children) {
          const patched = { ...c };
          delete patched[rel.on];
          await new Promise<void>((resolve, reject) => {
            const req = wstore.put(patched);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
          });
        }
      }
    }
  }
}

function findIdx(store: IDBObjectStore, keyPath: string): IDBIndex | null {
  for (const n of Array.from(store.indexNames)) {
    const i = store.index(n);
    if (typeof i.keyPath === 'string' && i.keyPath === keyPath) return i;
  }
  return null;
}
