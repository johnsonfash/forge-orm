// IndexeddbAdapter — implements forge's Adapter contract for the browser
// (or worker) IndexedDB API.
//
// Connection strings:  `idb:app` or `indexeddb:app` → opens store `app`.
// A pre-wrapped driver (indexedDbDriver({ name }), or an injected shim)
// bypasses the URL parser entirely.
//
// Capabilities:
//   * nativeUpsert     — true. `IDBObjectStore.put` IS upsert.
//   * nativeCascades   — false. JS walker like Mongo.
//   * nullsOrdering    — false. IDB uses structured-clone key order.
//   * jsonPath         — true. Post-scan JS walk. Slow, but portable.
//   * transactionsRequireReplicaSet — false. IDB has native txns.
//
// Raw SQL is a no-op — IDB has no SQL surface. Consumers wanting raw access
// should reach for the IDBDatabase directly via `adapter.db` (dev only —
// not part of the stable API).

import type {
  Adapter, AdapterCapabilities, DbIntrospection, DoctorReport, ExecOpts,
} from '../types';
import type { SchemaShape } from '../../schema/active';
import { getActiveSchema } from '../../schema/active';
import { ForgeEmitter } from '../../events';
import type { ModelDef } from '../../schema/types';
import type {
  CountNode, DeleteNode, GroupByNode, InsertNode, SelectNode, UpdateNode,
} from '../../ir/types';

import { indexedDbDriver, isIdbDriver, type IdbDriver } from './driver';
import {
  executeCount, executeDelete, executeGroupBy, executeInsert, executeSelect, executeUpdate,
} from './execute';
import { coerceInbound, decodeOutbound } from './coerce';
import { cascadeDelete } from './cascade';
import { hydrate, applyRelationCounts } from './hydration';
import { introspect } from './introspect';

const CAPS: AdapterCapabilities = {
  nativeCascades: false,
  nativeUpsert: true,
  nullsOrdering: false,
  jsonPath: true,
  transactionsRequireReplicaSet: false,
};

export class IndexeddbAdapter implements Adapter {
  readonly kind = 'indexeddb' as const;
  readonly capabilities = CAPS;
  readonly emitter: ForgeEmitter = new ForgeEmitter();
  private _driver?: IdbDriver;
  private _db?: IDBDatabase;
  private _url?: string;

  // An injected driver bypasses the URL parser (React Native web / test shims).
  constructor(private _injected?: IdbDriver) {}

  async connect(url: string): Promise<void> {
    this._url = url;
    const schema = getActiveSchema();
    if (this._injected) {
      this._driver = this._injected;
    } else {
      const name = this._urlToName(url);
      this._driver = indexedDbDriver({ name });
    }
    this._db = await this._driver.open(schema);
  }

  async close(): Promise<void> {
    if (this._driver) this._driver.close();
    this._db = undefined;
  }

  async doctor(): Promise<DoctorReport> {
    return {
      kind: 'indexeddb',
      driverPackage: '(host IndexedDB)',
      driverInstalled: typeof indexedDB !== 'undefined',
      connectionString: this._url,
      capabilities: CAPS,
      notes: [
        'Runs against the host browser / worker IndexedDB — no separate driver install.',
        'Full-text search uses a shadow `_tokens_<field>` multiEntry index; auto-emitted for every `.searchable()` field.',
        'Geo `near` / `withinPolygon` and vector similarity are brute-force post-filter — fine for <~1k rows, route larger workloads to forge-orm/wasm/worker-pro (sqlite-vec).',
        'onDelete cascades are enforced by a JS walker (mongo-style); the DB has no FKs of its own.',
      ],
    };
  }

  get db(): IDBDatabase {
    if (!this._db) throw new Error('[forge:indexeddb] db accessed before connect() resolved');
    return this._db;
  }

  private async _track<T>(
    op: 'select' | 'count' | 'groupBy' | 'insert' | 'update' | 'delete',
    node: { model?: string },
    exec: () => Promise<T>,
    countRows: (r: T) => number,
    semanticOp?: ExecOpts['semanticOp'],
  ): Promise<T> {
    if (!this.emitter.hasListeners()) return exec();
    return this.emitter.track(
      {
        adapter: 'indexeddb' as any,
        model: node.model ?? '',
        op,
        sql: `idb.${op}(${node.model ?? ''})`,
        params: [],
        ...(semanticOp ? { semanticOp } : {}),
      },
      exec,
      countRows,
    );
  }

  executeSelect(node: SelectNode, model: ModelDef<any>, opts?: ExecOpts): Promise<any[]> {
    return this._track('select', node,
      () => executeSelect(this.db, node, model, opts ?? {}),
      (r) => r.length);
  }
  executeCount(node: CountNode, model: ModelDef<any>, opts?: ExecOpts): Promise<number> {
    return this._track('count', node,
      () => executeCount(this.db, node, model, opts ?? {}),
      () => 1);
  }
  executeInsert(node: InsertNode, model: ModelDef<any>, opts?: ExecOpts): Promise<{ docs: any[]; count: number }> {
    return this._track('insert', node,
      () => executeInsert(this.db, node, model, opts ?? {}),
      (r) => r.count);
  }
  executeUpdate(node: UpdateNode, model: ModelDef<any>, opts?: ExecOpts): Promise<{ doc?: any; count: number }> {
    return this._track('update', node,
      () => executeUpdate(this.db, node, model, opts ?? {}),
      (r) => r.count, opts?.semanticOp);
  }
  executeDelete(node: DeleteNode, model: ModelDef<any>, opts?: ExecOpts): Promise<{ doc?: any; count: number }> {
    return this._track('delete', node,
      () => executeDelete(this.db, node, model, opts ?? {}),
      (r) => r.count);
  }
  executeGroupBy(node: GroupByNode, model: ModelDef<any>, opts?: ExecOpts): Promise<any[]> {
    return this._track('groupBy', node,
      () => executeGroupBy(this.db, node, model, opts ?? {}),
      (r) => r.length);
  }

  // Write-then-project support for create/update/delete + include/select/omit.
  // Called by the wrapper after an insert/update/delete that returned rows.
  async applyProjectionAndHydration(
    rows: any[],
    model: ModelDef<any>,
    node: { projection?: any; hydration?: any },
    _opts?: ExecOpts,
  ): Promise<void> {
    if (rows.length === 0) return;
    const schema = getActiveSchema();
    // Resolve the model's schema key by matching collection name — that's
    // how hydrate + cascade look up target models by their string key.
    const modelKey = keyForModel(schema, model) ?? '';
    if (!modelKey) return;
    if (node.hydration?.length) await hydrate(this.db, schema, modelKey, rows, node.hydration);
    if (node.projection?.counts?.length) await applyRelationCounts(this.db, schema, modelKey, rows, node.projection.counts);
  }

  // IDB txns auto-commit on task idle — a shared IDBTransaction can't span
  // an await on a non-IDB promise. v0 runs the callback with `undefined`
  // session; per-op txns give the strongest atomicity IDB supports here.
  async $transaction<T>(fn: (session: unknown) => Promise<T>): Promise<T> {
    return fn(undefined);
  }

  coerceInbound(model: ModelDef<any>, data: any, opts?: { forCreate?: boolean }): any {
    return coerceInbound(model, data, opts);
  }

  decodeOutbound(model: ModelDef<any>, row: any): any {
    return decodeOutbound(model, row);
  }

  async applyCascadesForDelete(model: ModelDef<any>, docs: any[], _opts?: ExecOpts): Promise<void> {
    if (docs.length === 0) return;
    const schema = getActiveSchema();
    const modelKey = keyForModel(schema, model);
    if (!modelKey) return;
    await cascadeDelete(this.db, schema, modelKey, docs);
  }

  async $queryRaw(): Promise<any[]> {
    throw new Error('IndexedDB has no SQL query language; use db.<model>.aggregate or model methods.');
  }
  async $executeRaw(): Promise<number> {
    throw new Error('IndexedDB has no SQL query language; use db.<model>.aggregate or model methods.');
  }

  async introspect(): Promise<DbIntrospection> {
    return introspect(this.db);
  }

  private _urlToName(url: string): string {
    // Accept idb:app, indexeddb:app, or a bare name.
    if (url.startsWith('idb:')) return url.slice('idb:'.length) || 'forge';
    if (url.startsWith('indexeddb:')) return url.slice('indexeddb:'.length) || 'forge';
    return url || 'forge';
  }
}

function keyForModel(schema: SchemaShape, model: ModelDef<any>): string | undefined {
  for (const [k, v] of Object.entries(schema)) {
    if ((v as unknown as ModelDef<any>).collection === model.collection) return k;
  }
  return undefined;
}

// Factory + injection guard for parity with `betterSqlite3Driver` on the SQL
// adapters — some frameworks (Next.js "use client" bundle path) prefer a
// constructor call over `new`.
export function createIndexeddbAdapter(driver?: IdbDriver): IndexeddbAdapter {
  return new IndexeddbAdapter(driver && isIdbDriver(driver) ? driver : undefined);
}

let _default: IndexeddbAdapter | undefined;
export function getDefaultIndexeddbAdapter(): IndexeddbAdapter {
  if (!_default) _default = new IndexeddbAdapter();
  return _default;
}
