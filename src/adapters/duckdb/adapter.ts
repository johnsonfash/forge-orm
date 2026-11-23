import type { Adapter, AdapterCapabilities, DoctorReport, ExecOpts } from '../types';
import * as errorsMod from './errors';
import * as rawSql from '../../raw-sql';
import * as compileIr from './compile-from-ir';
import { TxQueue } from '../shared/tx-queue';
import { ForgeEmitter } from '../../events';
import { isDriverInstalled, loadDriver } from '../missing-driver';
import {
  executeDuckdbCount,
  executeDuckdbDelete,
  executeDuckdbGroupBy,
  executeDuckdbInsert,
  executeDuckdbSelect,
  executeDuckdbUpdate,
  type DuckdbExecOpts,
  executeDuckdbSelectWithChildPresence,
} from './execute';
import { duckdbDriver, type DuckdbDriver, type DuckdbQueryable } from './driver';
import { duckdbFtsDialect } from './dialect';
import type { Dialect } from '../postgres/dialect';
import { searchedFields } from '../shared/search-fields';
import { bytesForDriver } from '../../bytes';

// DuckdbAdapter — drives a DuckdbDriver port (driver.ts). By default it opens
// a `@duckdb/node-api` instance from the URL (file path or `:memory:`); a
// pre-wrapped driver can be injected via createDb({ driver }) instead.
//
// Capabilities note: DuckDB enforces UNIQUE / CHECK / PRIMARY KEY at write
// time, but foreign-key constraints are accepted at CREATE TABLE time and
// NOT enforced (DuckDB is OLAP — relational integrity is documentation,
// not runtime). nativeCascades is therefore reported as false so the
// wrapper's app-side cascade walker takes over.

const CAPS: AdapterCapabilities = {
  nativeCascades: false,
  nativeUpsert: true,
  nullsOrdering: true,
  jsonPath: true,
  transactionsRequireReplicaSet: false,
};

export class DuckdbAdapter implements Adapter {
  readonly kind = 'duckdb' as const;
  readonly capabilities = CAPS;
  readonly emitter = new ForgeEmitter();
  private _driver?: DuckdbDriver;
  private _url?: string;

  constructor(private _injected?: DuckdbDriver) {}

  async connect(url: string): Promise<void> {
    this._url = url;
    if (this._injected) {
      this._driver = this._injected;
    } else {
      const ddb = loadDriver('duckdb', url);
      // @duckdb/node-api shape: DuckDBInstance.create(path) then .connect().
      // The URL parser strips the duckdb:// prefix; treat the remainder as
      // a file path. Empty / ":memory:" → in-process DB.
      const path = url.replace(/^duckdb:(\/\/)?/, '') || ':memory:';
      const instance = await ddb.DuckDBInstance.create(path);
      const connection = await instance.connect();
      this._driver = duckdbDriver(connection);
    }
    await this._driver.query('SELECT 1', []);
    // Auto-load the spatial extension. It's bundled with DuckDB ≥ 0.9, so
    // INSTALL is a no-op if cached; LOAD makes ST_Point / ST_Distance_Sphere
    // available. Failures are non-fatal — non-geo schemas keep working.
    try {
      await this._driver.query('INSTALL spatial', []);
      await this._driver.query('LOAD spatial', []);
    } catch {
      // Extension not available; geo features will fail at query time
      // with a clearer error from DuckDB. Doctor probe surfaces this.
    }
  }

  async close(): Promise<void> {
    if (!this._driver) return;
    await this._driver.close();
    this._driver = undefined;
  }

  async doctor(): Promise<DoctorReport> {
    const injected = !!this._injected;
    const driver = injected ? { installed: true, version: undefined } : isDriverInstalled('duckdb');
    return {
      kind: 'duckdb',
      driverPackage: injected ? '(injected driver)' : '@duckdb/node-api',
      driverInstalled: driver.installed,
      driverVersion: driver.version,
      connectionString: this._url,
      capabilities: CAPS,
      notes: [
        injected
          ? 'Custom driver injected via createDb({ driver }).'
          : 'Driver: @duckdb/node-api. Embedded OLAP — single-writer concurrency model.',
        'Foreign keys are accepted at DDL time but NOT enforced at write time. Cascades go through forge\'s app-side walker.',
        'Full-text search via .searchable() uses the fts extension\'s match_bm25 when the table has an index (PRAGMA create_fts_index(table, pk, column)); otherwise ILIKE. The index is a snapshot: rebuild it after writes.',
      ],
    };
  }

  get driver(): DuckdbDriver {
    if (!this._driver) throw new Error('[forge:duckdb] driver accessed before connect() resolved');
    return this._driver;
  }

  private duckdbOpts(opts?: ExecOpts, dialect?: Dialect): DuckdbExecOpts {
    const o: DuckdbExecOpts = opts?.session ? { client: opts.session as DuckdbQueryable } : {};
    if (dialect) o.dialect = dialect;
    return o;
  }

  // table → columns covered by its full-text index, as last read. A table
  // with none is asked again after a few seconds, so an index built after
  // connect (it is built after loading, being a snapshot) is picked up.
  private readonly _fts = new Map<string, { cols: Set<string>; at: number }>();
  private _ftsDialect?: { key: string; dialect: Dialect };

  /** The dialect for a node: the full-text one when it searches an indexed column. */
  private async dialectFor(node: any, model: any, opts?: ExecOpts): Promise<Dialect | undefined> {
    const fields = searchedFields(node?.where);
    if (!fields.length || !model?.collection) return undefined;
    const table = String(model.collection);
    let e = this._fts.get(table);
    if (!e || (e.cols.size === 0 && Date.now() - e.at > 5000)) {
      const cols = new Set<string>();
      try {
        const ident = `"fts_main_${table.replace(/"/g, '""')}"`;
        const { rows } = await this.handle(opts).query(`SELECT field FROM ${ident}.fields`, []);
        for (const r of rows) cols.add(String((r as any).field));
      } catch { /* no index */ }
      e = { cols, at: Date.now() };
      this._fts.set(table, e);
    }
    if (!fields.some((f) => e!.cols.has(f))) return undefined;
    const key = [...this._fts].map(([t, v]) => `${t}:${[...v.cols].join(',')}`).join(';');
    if (this._ftsDialect?.key !== key) {
      const indexed = new Map([...this._fts].map(([t, v]) => [t, v.cols] as const));
      this._ftsDialect = { key, dialect: duckdbFtsDialect(indexed) };
    }
    return this._ftsDialect.dialect;
  }

  private async _track<T>(
    op: 'select' | 'count' | 'groupBy' | 'insert' | 'update' | 'delete',
    node: any,
    model: any,
    exec: () => Promise<T>,
    countRows: (r: T) => number,
    semanticOp?: ExecOpts['semanticOp'],
    dialect?: Dialect,
  ): Promise<T> {
    if (!this.emitter.hasListeners()) return exec();
    const { compileSelect, compileCount, compileGroupBy, compileInsert, compileUpdate, compileDelete } =
      compileIr;
    const artifact =
      op === 'select'  ? compileSelect(node, model, dialect)  :
      op === 'count'   ? compileCount(node, model, dialect)   :
      op === 'groupBy' ? compileGroupBy(node, model, dialect) :
      op === 'insert'  ? compileInsert(node, model, dialect)  :
      op === 'update'  ? compileUpdate(node, model, dialect)  :
                         compileDelete(node, model, dialect);
    return this.emitter.track(
      { adapter: 'duckdb' as any, model: node.model ?? '', op, sql: artifact.sql, params: artifact.params, ...(semanticOp ? { semanticOp } : {}) },
      exec, countRows,
    );
  }

  async executeSelect(node: any, model: any, opts?: ExecOpts) {
    const d = await this.dialectFor(node, model, opts);
    return this._track('select', node, model,
      () => executeDuckdbSelect(this.handle(opts), node, model, this.duckdbOpts(opts, d)),
      (r) => r.length, undefined, d);
  }
  async selectWithChildPresence(
    node: any, model: any, probes: Array<{ collection: string; on: string; refs: string }>, opts?: ExecOpts,
  ) {
    const d = await this.dialectFor(node, model, opts);
    return executeDuckdbSelectWithChildPresence(this.handle(opts), node, model, probes, this.duckdbOpts(opts, d));
  }
  async executeCount(node: any, model: any, opts?: ExecOpts) {
    const d = await this.dialectFor(node, model, opts);
    return this._track('count', node, model,
      () => executeDuckdbCount(this.handle(opts), node, model, this.duckdbOpts(opts, d)),
      () => 1, undefined, d);
  }
  executeInsert(node: any, model: any, opts?: ExecOpts) {
    return this._track('insert', node, model,
      () => executeDuckdbInsert(this.handle(opts), node, model, this.duckdbOpts(opts)),
      (r) => r.count);
  }
  executeUpdate(node: any, model: any, opts?: ExecOpts) {
    return this._track('update', node, model,
      () => executeDuckdbUpdate(this.handle(opts), node, model, this.duckdbOpts(opts)),
      (r) => r.count, opts?.semanticOp);
  }
  executeDelete(node: any, model: any, opts?: ExecOpts) {
    return this._track('delete', node, model,
      () => executeDuckdbDelete(this.handle(opts), node, model, this.duckdbOpts(opts)),
      (r) => r.count);
  }
  executeGroupBy(node: any, model: any, opts?: ExecOpts) {
    return this._track('groupBy', node, model,
      () => executeDuckdbGroupBy(this.handle(opts), node, model, this.duckdbOpts(opts)),
      (r) => r.length);
  }

  private handle(opts?: ExecOpts): DuckdbQueryable {
    return (opts?.session as DuckdbQueryable | undefined) ?? this.driver;
  }

  async applyProjectionAndHydration(): Promise<void> { /* inline in executeSelect */ }

  coerceInbound(model: any, data: any, _opts?: { forCreate?: boolean }) {
    if (!data || typeof data !== 'object') return data;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(data)) {
      const field = model?.fields?.[k];
      if (field?.kind === 'bytes' && v != null) {
        out[k] = bytesForDriver(model?.collection ?? '?', k, field.maxBytes, v);
      } else if (field && (field.kind === 'json' || field.kind === 'embed' || field.kind === 'embedMany')
          && v != null && typeof v === 'object') {
        out[k] = JSON.stringify(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  decodeOutbound(_model: any, row: any) { return row; }

  async applyCascadesForDelete(): Promise<void> {
    // DuckDB doesn't enforce FK cascades. Forge's wrapper-layer cascade walker
    // handles ON DELETE Cascade / SetNull when nativeCascades = false.
  }

  async introspect(): Promise<import('../types').DbIntrospection> {
    const { introspectDuckdb } = await import('./introspect');
    return introspectDuckdb(this.driver);
  }

  async $queryRaw(fragment: import('../../raw-sql').SqlFragment, opts?: ExecOpts): Promise<any[]> {
    const { compileSqlFragment } = rawSql;
    const { sql, params } = compileSqlFragment(fragment, 'postgres');
    const { withDuckdbErrors } = errorsMod;
    const { rows } = await withDuckdbErrors(() => this.handle(opts).query(sql, params));
    return rows;
  }

  async $executeRaw(fragment: import('../../raw-sql').SqlFragment, opts?: ExecOpts): Promise<number> {
    const { compileSqlFragment } = rawSql;
    const { sql, params } = compileSqlFragment(fragment, 'postgres');
    const { withDuckdbErrors } = errorsMod;
    const { rowCount } = await withDuckdbErrors(() => this.handle(opts).query(sql, params));
    return rowCount ?? 0;
  }

  private readonly _tx = new TxQueue();

  get inTransaction(): boolean {
    return this._tx.active;
  }

  async $transaction<T>(fn: (session: unknown) => Promise<T>): Promise<T> {
    return this._tx.run(() => this.driver.transaction((qc) => fn(qc)));
  }
}
