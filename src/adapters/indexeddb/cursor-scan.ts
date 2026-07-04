// Cursor scan helpers.
//
// Every read goes through cursorScan — it opens the IDB cursor at the chosen
// index/range, applies the residual predicate, honours limit/offset, and
// returns the collected rows. The one non-obvious detail: for OR queries
// where the planner picked no index, we drive a `store.openCursor()` (the
// primary-key cursor over the entire store) and let the residual filter
// everything. So there's a single execution path for every plan shape.

import type { QueryPlan } from './planner';

export interface ScanOptions {
  storeName: string;
  plan: QueryPlan;
  limit?: number;
  offset?: number;
}

export async function cursorScan(db: IDBDatabase, opts: ScanOptions): Promise<Record<string, unknown>[]> {
  const { plan } = opts;
  const tx = db.transaction(opts.storeName, 'readonly');
  const store = tx.objectStore(opts.storeName);
  const source: IDBObjectStore | IDBIndex = plan.indexName ? store.index(plan.indexName) : store;

  const collected: Record<string, unknown>[] = [];
  const ranges = plan.range?.ranges ?? [plan.range?.range ?? null];
  const direction = plan.range?.direction ?? 'next';

  let skipped = 0;
  const wantLimit = opts.limit ?? Infinity;
  const wantOffset = opts.offset ?? 0;

  for (const range of ranges) {
    await new Promise<void>((resolve, reject) => {
      const req = (source as any).openCursor(range ?? null, direction);
      req.onsuccess = () => {
        const cur: IDBCursorWithValue | null = req.result;
        if (!cur) return resolve();
        if (collected.length >= wantLimit) return resolve();
        const row = cur.value as Record<string, unknown>;
        if (plan.residual(row)) {
          if (skipped < wantOffset) skipped++;
          else collected.push(row);
        }
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
    if (collected.length >= wantLimit) break;
  }

  return collected;
}

export async function cursorScanIds(db: IDBDatabase, storeName: string, ids: readonly IDBValidKey[]): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return [];
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const out: Record<string, unknown>[] = [];
  await Promise.all(ids.map((id) => new Promise<void>((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => { if (req.result !== undefined) out.push(req.result); resolve(); };
    req.onerror = () => reject(req.error);
  })));
  return out;
}
