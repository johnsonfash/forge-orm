import { dbClient } from './client';
import type { Adapter, AdapterCapabilities, DoctorReport, ExecOpts } from '../types';
import { ForgeEmitter } from '../../events';
import { isDriverInstalled } from '../missing-driver';
import {
  applyProjectionAndHydration as applyMongoProjectionAndHydration,
  executeCount,
  executeDelete,
  executeGroupBy,
  executeInsert,
  executeSelect,
  executeUpdate,
} from './execute';
import { coerceCreatePayload, decodeRow } from './coerce';
import { applyCascadesForDelete as mongoCascade } from './cascade';
import type { ClientSession } from 'mongodb';

// Concrete Adapter wrapping dbClient + executor free functions + coerce/cascade
// helpers, so CollectionWrapper can dispatch through `this.adapter` uniformly
// across Mongo and Postgres.

const CAPS: AdapterCapabilities = {
  nativeCascades: false,
  nativeUpsert: true,
  nullsOrdering: false,
  jsonPath: true,
  transactionsRequireReplicaSet: true,
};

export class MongoAdapter implements Adapter {
  readonly kind = 'mongo' as const;
  readonly capabilities = CAPS;
  readonly emitter = new ForgeEmitter();
  private _url?: string;

  constructor(private _injected?: import('./driver').MongoDriver) {}

  async connect(url: string): Promise<void> {
    this._url = url;
    if (this._injected) {
      await dbClient.adopt(this._injected.client, this._injected.dbName);
      return;
    }
    if (!process.env.DATABASE_URL) process.env.DATABASE_URL = url;
    await dbClient.connect();
  }

  async close(): Promise<void> {
    await dbClient.close();
  }

  async doctor(): Promise<DoctorReport> {
    const driver = isDriverInstalled('mongo');
    return {
      kind: 'mongo',
      driverPackage: 'mongodb',
      driverInstalled: driver.installed,
      driverVersion: driver.version,
      connectionString: this._url,
      capabilities: CAPS,
      notes: [
        'Transactions require a replica set or mongos. Single-node instances throw on $transaction.',
        'Cascades enforced by the JS cascade walker, not the DB engine.',
      ],
    };
  }

  private mongoOpts(opts?: ExecOpts): { session?: ClientSession } {
    return opts?.session ? { session: opts.session as ClientSession } : {};
  }

  private _track<T>(
    op: 'select' | 'count' | 'groupBy' | 'insert' | 'update' | 'delete',
    node: any,
    exec: () => Promise<T>,
    countRows: (r: T) => number,
  ): Promise<T> {
    if (!this.emitter.hasListeners()) return exec();
    // Mongo has no SQL — describe the op for the event payload as
    // "<collection>.<op>"; surface the IR node as `params`.
    const collection = (node as any).model ?? '';
    return this.emitter.track(
      { adapter: 'mongo', model: collection, op, sql: `${collection}.${op}`, params: { node } },
      exec, countRows);
  }

  executeSelect(node: any, model: any, opts?: ExecOpts) {
    return this._track('select', node,
      () => executeSelect(node, model, this.mongoOpts(opts)),
      (r) => r.length);
  }
  executeCount(node: any, model: any, opts?: ExecOpts) {
    return this._track('count', node,
      () => executeCount(node, model, this.mongoOpts(opts)),
      () => 1);
  }
  executeInsert(node: any, model: any, opts?: ExecOpts) {
    return this._track('insert', node,
      () => executeInsert(node, model, this.mongoOpts(opts)),
      (r) => r.count);
  }
  executeUpdate(node: any, model: any, opts?: ExecOpts) {
    return this._track('update', node,
      () => executeUpdate(node, model, this.mongoOpts(opts)),
      (r) => r.count);
  }
  executeDelete(node: any, model: any, opts?: ExecOpts) {
    return this._track('delete', node,
      () => executeDelete(node, model, this.mongoOpts(opts)),
      (r) => r.count);
  }
  executeGroupBy(node: any, model: any, opts?: ExecOpts) {
    return this._track('groupBy', node,
      () => executeGroupBy(node, model, this.mongoOpts(opts)),
      (r) => r.length);
  }

  // Native streaming via Mongo's cursor.stream(): compile the IR SelectNode
  // into a cursor and yield each document, decoded via the row decoder.
  async *streamSelect(node: any, model: any, opts?: ExecOpts): AsyncIterable<any> {
    const { compileSelect } = await import('./compile-from-ir');
    const a: any = compileSelect(node, model);
    const coll = dbClient.db.collection(model.collection);
    const cursor = coll.find(a.args.filter, {
      ...a.args.options,
      session: this.mongoOpts(opts).session,
    });
    for await (const raw of cursor.stream()) {
      yield decodeRow(model, raw);
    }
  }
  applyProjectionAndHydration(rows: any[], model: any, node: any, opts?: ExecOpts) {
    return applyMongoProjectionAndHydration(
      rows, model, node, opts?.session as ClientSession | undefined,
    );
  }

  $transaction<T>(fn: (session: unknown) => Promise<T>): Promise<T> {
    // Mongo requires a replica set or mongos for $transaction. Throws there
    // are surfaced verbatim — matches Prisma's behaviour.
    return dbClient.transaction(async (session) => fn(session));
  }

  coerceInbound(model: any, data: any, _opts?: { forCreate?: boolean }) {
    // The Mongo helper applies create defaults (now() / autoId) and does
    // id↔_id remap. Update paths pre-filter to scalar-only data; in either
    // case the helper produces a driver-ready document.
    return coerceCreatePayload(model, data);
  }

  decodeOutbound(model: any, row: any) {
    if (row == null) return row;
    return decodeRow(model, row);
  }

  applyCascadesForDelete(model: any, docs: any[], _opts?: ExecOpts): Promise<void> {
    return mongoCascade(model, docs);
  }

  // A Mongo "matview" is a normal collection populated by an aggregation
  // pipeline whose final stage is $merge or $out into that collection.
  // refresh() re-runs the pipeline.
  async refreshView(model: any, _opts?: ExecOpts): Promise<void> {
    const view = model?.view;
    const pipeline: any[] = Array.isArray(view?.pipeline) ? view.pipeline : [];
    const source = view?.sourceCollection;
    if (!source) {
      throw new Error(`[forge:mongo] materialised view '${model?.collection}' needs a sourceCollection to refresh`);
    }
    const hasOutStage = pipeline.some((s) => s && (s.$merge || s.$out));
    const full = hasOutStage ? pipeline : [...pipeline, { $out: model.collection }];
    await dbClient.db.collection(source).aggregate(full).toArray();
  }

  // Introspection: collections + their indexes. Mongo is schemaless, so there
  // are no columns/FKs to diff — collection + index level only.
  async introspect(): Promise<import('../types').DbIntrospection> {
    const colls = await dbClient.db.listCollections().toArray();
    const tables = [] as import('../types').IntrospectedTable[];
    const views = [] as { name: string; materialised?: boolean }[];
    for (const c of colls as any[]) {
      if (c.type === 'view') { views.push({ name: c.name, materialised: false }); continue; }
      const idxs = await dbClient.db.collection(c.name).indexes().catch(() => [] as any[]);
      tables.push({
        name: c.name,
        columns: [],
        foreignKeys: [],
        indexes: (idxs as any[]).map((i) => ({
          name: i.name,
          columns: Object.keys(i.key ?? {}),
          unique: i.unique === true,
        })),
      });
    }
    return { kind: 'mongo', tables, views };
  }

  // Mongo doesn't speak SQL — its raw channel is the aggregation pipeline
  // (db.<model>.aggregate) or $runCommandRaw on the ForgeDb handle. Throwing
  // here matches Prisma's behavior on its Mongo connector.
  $queryRaw(_fragment: import('../../raw-sql').SqlFragment, _opts?: ExecOpts): Promise<any[]> {
    return Promise.reject(new Error(
      '[forge] $queryRaw is SQL-only. For Mongo, use db.<model>.aggregate({ pipeline }) ' +
      'or db.$runCommandRaw(command).',
    ));
  }

  $executeRaw(_fragment: import('../../raw-sql').SqlFragment, _opts?: ExecOpts): Promise<number> {
    return Promise.reject(new Error(
      '[forge] $executeRaw is SQL-only. For Mongo, use db.$runCommandRaw(command).',
    ));
  }
}

// Lazily-built singleton used by CollectionWrapper when no explicit adapter
// is passed.
let _defaultMongoAdapter: MongoAdapter | undefined;
export function getDefaultMongoAdapter(): MongoAdapter {
  if (!_defaultMongoAdapter) _defaultMongoAdapter = new MongoAdapter();
  return _defaultMongoAdapter;
}
