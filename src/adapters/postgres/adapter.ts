import type { Adapter, AdapterCapabilities, DoctorReport, ExecOpts } from '../types';
import { ForgeEmitter } from '../../events';
import { isDriverInstalled, loadDriver } from '../missing-driver';
import {
  executePgCount,
  executePgDelete,
  executePgGroupBy,
  executePgInsert,
  executePgSelect,
  executePgUpdate,
  type PgExecOpts,
  type PgPoolHandle,
} from './execute';
import { pgDriver, type PostgresDriver, type PgQueryable } from './driver';

// PostgresAdapter — drives a PostgresDriver port (driver.ts). By default it
// opens a node-postgres Pool from the URL; a pre-wrapped driver (postgres.js,
// …) can be injected via createDb({ driver }) instead.

const CAPS: AdapterCapabilities = {
  nativeCascades: true,
  nativeUpsert: true,
  nullsOrdering: true,
  jsonPath: true,
  transactionsRequireReplicaSet: false,
};

export class PostgresAdapter implements Adapter {
  readonly kind = 'postgres' as const;
  readonly capabilities = CAPS;
  readonly emitter = new ForgeEmitter();
  private _driver?: PostgresDriver;
  // The raw node-postgres Pool when we created one (default path) — kept so the
  // migration tooling, which needs pool.connect() for advisory locks, still has
  // a full pg handle via `.pool`. Undefined when a driver is injected.
  private _rawPool?: any;
  private _url?: string;

  constructor(private _injected?: PostgresDriver) {}

  async connect(url: string): Promise<void> {
    this._url = url;
    if (this._injected) {
      this._driver = this._injected;
    } else {
      const pg = loadDriver('postgres', url);
      const pool = new pg.Pool({
        connectionString: url,
        max: 50,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 10_000,
      });
      this._rawPool = pool;
      this._driver = pgDriver(pool);
    }
    // Probe now so auth/host errors surface at connect(), not first query.
    await this._driver.query('SELECT 1', []);
  }

  async close(): Promise<void> {
    if (!this._driver) return;
    await this._driver.close();
    this._driver = undefined;
  }

  async doctor(): Promise<DoctorReport> {
    const injected = !!this._injected;
    const driver = injected ? { installed: true, version: undefined } : isDriverInstalled('postgres');
    return {
      kind: 'postgres',
      driverPackage: injected ? '(injected driver)' : 'pg',
      driverInstalled: driver.installed,
      driverVersion: driver.version,
      connectionString: this._url,
      capabilities: CAPS,
      notes: [
        injected
          ? 'Custom driver injected via createDb({ driver }) — e.g. postgres.js.'
          : 'Driver: node-postgres (pg). Transactions native; cascades enforced by FK clauses.',
        'Queries route through a normalized driver port, so any Postgres client can back the adapter.',
      ],
    };
  }

  get driver(): PostgresDriver {
    if (!this._driver) throw new Error('[forge:postgres] driver accessed before connect() resolved');
    return this._driver;
  }

  // The full node-postgres Pool (with .connect()) when forge created one — used
  // by the migration tooling. Falls back to the queryable port for injected
  // drivers (which don't expose a pool/connect).
  get pool(): PgPoolHandle {
    return this._rawPool ?? (this.driver as unknown as PgPoolHandle);
  }

  private pgOpts(opts?: ExecOpts): PgExecOpts {
    return opts?.session ? { client: opts.session as PgPoolHandle } : {};
  }

  private async _track<T>(
    op: 'select' | 'count' | 'groupBy' | 'insert' | 'update' | 'delete',
    node: any,
    model: any,
    exec: () => Promise<T>,
    countRows: (r: T) => number,
    semanticOp?: ExecOpts['semanticOp'],
  ): Promise<T> {
    if (!this.emitter.hasListeners()) return exec();
    const { compileSelect, compileCount, compileGroupBy, compileInsert, compileUpdate, compileDelete } =
      await import('./compile-from-ir');
    const artifact =
      op === 'select'  ? compileSelect(node, model)  :
      op === 'count'   ? compileCount(node, model)   :
      op === 'groupBy' ? compileGroupBy(node, model) :
      op === 'insert'  ? compileInsert(node, model)  :
      op === 'update'  ? compileUpdate(node, model)  :
                         compileDelete(node, model);
    return this.emitter.track(
      { adapter: 'postgres', model: node.model ?? '', op, sql: artifact.sql, params: artifact.params, ...(semanticOp ? { semanticOp } : {}) },
      exec, countRows,
    );
  }

  executeSelect(node: any, model: any, opts?: ExecOpts) {
    return this._track('select', node, model,
      () => executePgSelect(this.handle(opts), node, model, this.pgOpts(opts)),
      (r) => r.length);
  }
  executeCount(node: any, model: any, opts?: ExecOpts) {
    return this._track('count', node, model,
      () => executePgCount(this.handle(opts), node, model, this.pgOpts(opts)),
      () => 1);
  }
  executeInsert(node: any, model: any, opts?: ExecOpts) {
    return this._track('insert', node, model,
      () => executePgInsert(this.handle(opts), node, model, this.pgOpts(opts)),
      (r) => r.count);
  }
  executeUpdate(node: any, model: any, opts?: ExecOpts) {
    return this._track('update', node, model,
      () => executePgUpdate(this.handle(opts), node, model, this.pgOpts(opts)),
      (r) => r.count, opts?.semanticOp);
  }
  executeDelete(node: any, model: any, opts?: ExecOpts) {
    return this._track('delete', node, model,
      () => executePgDelete(this.handle(opts), node, model, this.pgOpts(opts)),
      (r) => r.count);
  }
  executeGroupBy(node: any, model: any, opts?: ExecOpts) {
    return this._track('groupBy', node, model,
      () => executePgGroupBy(this.handle(opts), node, model, this.pgOpts(opts)),
      (r) => r.length);
  }

  // The queryable the executor should use: the txn session if present, else the
  // driver itself (both implement `query`).
  private handle(opts?: ExecOpts): PgPoolHandle {
    return (opts?.session as PgPoolHandle | undefined) ?? (this.driver as unknown as PgPoolHandle);
  }

  async *streamSelect(node: any, model: any, _opts?: ExecOpts): AsyncIterable<any> {
    const { compileSelect } = await import('./compile-from-ir');
    const a = compileSelect(node, model);
    if (this.driver.stream) {
      yield* this.driver.stream(a.sql, a.params);
    } else {
      const { rows } = await this.driver.query(a.sql, a.params);
      for (const r of rows) yield r;
    }
  }

  async applyProjectionAndHydration(): Promise<void> {
    // No-op: executePgSelect applies projection/hydration inline.
  }

  // jsonb / embed / json columns: pg expects a string for parameterised inserts.
  coerceInbound(model: any, data: any, _opts?: { forCreate?: boolean }) {
    if (!data || typeof data !== 'object') return data;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(data)) {
      const field = model?.fields?.[k];
      if (field && (field.kind === 'json' || field.kind === 'embed' || field.kind === 'embedMany')
          && v != null && typeof v === 'object') {
        out[k] = JSON.stringify(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  decodeOutbound(_model: any, row: any) {
    // pg's type parsers already give proper JS types. Note: numeric returns as string.
    return row;
  }

  async applyCascadesForDelete(): Promise<void> {
    // No-op: PG enforces ON DELETE via FK constraints from buildSchemaDDL.
  }

  // CONCURRENTLY needs a unique index on the matview, so it's opt-in.
  async refreshView(model: any, opts?: ExecOpts & { concurrently?: boolean }): Promise<void> {
    const q = `"${String(model.collection).replace(/"/g, '""')}"`;
    const concurrently = opts?.concurrently ? 'CONCURRENTLY ' : '';
    await this.handle(opts).query(`REFRESH MATERIALIZED VIEW ${concurrently}${q}`, []);
  }

  async introspect(): Promise<import('../types').DbIntrospection> {
    const { introspectPg } = await import('./introspect');
    return introspectPg(this.driver as unknown as PgPoolHandle);
  }

  async $queryRaw(fragment: import('../../raw-sql').SqlFragment, opts?: ExecOpts): Promise<any[]> {
    const { compileSqlFragment } = await import('../../raw-sql');
    const { sql, params } = compileSqlFragment(fragment, 'postgres');
    const { withPgErrors } = await import('./errors');
    const { rows } = await withPgErrors(() => this.handle(opts).query(sql, params));
    return rows;
  }

  async $executeRaw(fragment: import('../../raw-sql').SqlFragment, opts?: ExecOpts): Promise<number> {
    const { compileSqlFragment } = await import('../../raw-sql');
    const { sql, params } = compileSqlFragment(fragment, 'postgres');
    const { withPgErrors } = await import('./errors');
    const { rowCount } = await withPgErrors(() => this.handle(opts).query(sql, params));
    return rowCount ?? 0;
  }

  // Driver owns the transaction model (pg PoolClient / postgres.js sql.begin);
  // the session it yields is threaded back via ExecOpts.session.
  async $transaction<T>(fn: (session: unknown) => Promise<T>): Promise<T> {
    return this.driver.transaction((session: PgQueryable) => fn(session));
  }
}
