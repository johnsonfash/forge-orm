// IDB open + upgrade orchestration.
//
// The core dance: an open() request fires `onupgradeneeded` if the requested
// version is greater than the persisted version. That callback receives an
// `IDBVersionChangeEvent` whose `target.transaction` is a `versionchange` txn
// — the ONLY txn on which DDL (`createObjectStore` / `createIndex` /
// `deleteObjectStore` / `deleteIndex`) is legal. The txn commits when the
// callback's task returns.
//
// Because we can't cleanly ALTER an existing store's keyPath, or the fields
// of an existing index, the runtime path only applies additive changes.
// Destructive changes are surfaced in `pending` and require an explicit
// opt-in call via `runMigrate({ destructive: true })`.

import { buildDDLPlan, type DDLPlan, type StoreDDL } from './ddl';
import type { SchemaShape } from '../../schema/active';

export interface OpenOptions {
  name: string;
  schema: SchemaShape;
  /** Existing version override (tests use it to force upgrade). */
  forceVersion?: number;
  logger?: (line: string) => void;
}

export interface OpenResult {
  db: IDBDatabase;
  applied: string[];
  skipped: string[];
  pending: string[];
  version: number;
}

export async function openDb(opts: OpenOptions): Promise<OpenResult> {
  // Server-safety guard. Node/edge/SSR contexts that inadvertently reach
  // this adapter get a clear message instead of a cryptic ReferenceError.
  // Tests + browsers + workers all satisfy the check (fake-indexeddb
  // shims `globalThis.indexedDB` on setup import).
  if (typeof indexedDB === 'undefined') {
    throw new Error(
      'forge-orm IndexedDB adapter requires a browser or worker environment. ' +
      'Detected server-side runtime — use a server adapter (postgres/mysql/sqlite/mongo) ' +
      'or route this code path client-only (Next.js: "use client" or dynamic({ ssr: false })).',
    );
  }
  const plan = buildDDLPlan(opts.schema);
  // Two-phase: open at whatever version exists, inspect, close, then reopen
  // at version+1 with a synchronous onupgradeneeded that applies the diff.
  const first = await rawOpen(opts.name);
  const currentVersion = first.version || 0;
  const diff = diffAgainstLive(plan, first);
  first.close();

  if (diff.hasWork) {
    const nextVersion = currentVersion + 1;
    const upgraded = await rawOpen(opts.name, nextVersion, (db, txn) => {
      // v0: never delete stores here — they'd wipe data. Skipped.
      for (const create of diff.createStores) {
        const store = db.createObjectStore(create.storeName, { keyPath: create.keyPath });
        for (const idx of create.indexes) {
          store.createIndex(idx.name, idx.keyPath, { unique: idx.unique, multiEntry: idx.multiEntry });
        }
      }
      for (const { storeName, add, drop } of diff.alterStores) {
        const store = txn.objectStore(storeName);
        for (const idx of add) {
          store.createIndex(idx.name, idx.keyPath, { unique: idx.unique, multiEntry: idx.multiEntry });
        }
        for (const name of drop) {
          store.deleteIndex(name);
        }
      }
    });
    return {
      db: upgraded,
      applied: [
        ...diff.createStores.map((s) => `create store ${s.storeName}`),
        ...diff.alterStores.flatMap((a) => [
          ...a.add.map((i) => `create index ${a.storeName}.${i.name}`),
          ...a.drop.map((n) => `drop index ${a.storeName}.${n}`),
        ]),
      ],
      skipped: diff.skipped,
      pending: diff.pending,
      version: nextVersion,
    };
  }

  const reopen = await rawOpen(opts.name);
  return { db: reopen, applied: [], skipped: [], pending: diff.pending, version: currentVersion };
}

interface DiffPlan {
  createStores: StoreDDL[];
  alterStores: { storeName: string; add: StoreDDL['indexes']; drop: string[] }[];
  skipped: string[];
  pending: string[];
  hasWork: boolean;
}

function diffAgainstLive(plan: DDLPlan, db: IDBDatabase): DiffPlan {
  const liveStoreNames = new Set(Array.from(db.objectStoreNames));
  const wantStoreNames = new Set(plan.stores.map((s) => s.storeName));

  const createStores: StoreDDL[] = [];
  const alterStores: DiffPlan['alterStores'] = [];
  const skipped: string[] = [];
  const pending: string[] = [];

  // We need a read-only txn on the CURRENT db to inspect existing indexes,
  // but versionchange logic is inside a fresh upgrade cb. So peek here.
  // Guard: empty-scope txns throw InvalidAccessError, so skip peek when
  // the DB has no stores (fresh open — everything will be a create).
  if (liveStoreNames.size > 0) {
    const tx = db.transaction(Array.from(liveStoreNames), 'readonly');
    for (const want of plan.stores) {
      if (!liveStoreNames.has(want.storeName)) {
        createStores.push(want);
        continue;
      }
      const store = tx.objectStore(want.storeName);
      const liveIdxNames = new Set(Array.from(store.indexNames));
      const wantIdxNames = new Set(want.indexes.map((i) => i.name));
      const add = want.indexes.filter((i) => !liveIdxNames.has(i.name));
      const drop = Array.from(liveIdxNames).filter((n) => !wantIdxNames.has(n));
      if (add.length || drop.length) {
        alterStores.push({ storeName: want.storeName, add, drop });
      } else {
        skipped.push(`store ${want.storeName} — no change`);
      }
    }
  } else {
    // Fresh DB — every wanted store is a create.
    for (const want of plan.stores) createStores.push(want);
  }

  for (const live of liveStoreNames) {
    if (!wantStoreNames.has(live)) {
      pending.push(`drop store ${live} — schema no longer declares it (destructive; skipped)`);
    }
  }

  return {
    createStores,
    alterStores,
    skipped,
    pending,
    hasWork: createStores.length > 0 || alterStores.length > 0,
  };
}

function rawOpen(
  name: string,
  version?: number,
  onUpgrade?: (db: IDBDatabase, txn: IDBTransaction) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      const txn = req.transaction!;
      if (onUpgrade) onUpgrade(db, txn);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error(`IDB open blocked — close other tabs holding ${name}`));
  });
}

// Helper for tests — wipes a DB by name.
export function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error(`deleteDatabase blocked on ${name}`));
  });
}
