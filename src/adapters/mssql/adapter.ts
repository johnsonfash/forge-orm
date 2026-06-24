import type { Adapter, AdapterCapabilities, DoctorReport, ExecOpts } from '../types';
import { ForgeEmitter } from '../../events';
import { isDriverInstalled, loadDriver } from '../missing-driver';
import {
  executeMssqlCount,
  executeMssqlDelete,
  executeMssqlGroupBy,
  executeMssqlInsert,
  executeMssqlSelect,
  executeMssqlUpdate,
  type MssqlExecOpts,
} from './execute';
import { mssqlDriver, type MssqlDriver, type MssqlQueryable } from './driver';

const CAPS: AdapterCapabilities = {
  nativeCascades: true,
  // upsert is NOT supported in 2.3 — see compile-from-ir.ts. Reporting
  // false here so the wrapper layer can pick a safe fallback strategy if
  // it ever guards on this capability.
  nativeUpsert: false,
  nullsOrdering: false,        // T-SQL needs the CASE-WHEN workaround
  jsonPath: true,              // via JSON_VALUE / OPENJSON
  transactionsRequireReplicaSet: false,
};

export class MssqlAdapter implements Adapter {
  readonly kind = 'mssql' as const;
  readonly capabilities = CAPS;
  readonly emitter = new ForgeEmitter();
  private _driver?: MssqlDriver;
  private _url?: string;

  constructor(private _injected?: MssqlDriver) {}

  async connect(url: string): Promise<void> {
    this._url = url;
    if (this._injected) {
      this._driver = this._injected;
    } else {
      const sql = loadDriver('mssql', url);
      // mssql.connect(connectionStringOrConfig) → returns the pool, which is
      // also the default singleton (sql.pool).
      const pool = await sql.connect(url);
      this._driver = mssqlDriver(pool);
    }
    await this._driver.query('SELECT 1', []);
  }

  async close(): Promise<void> {
    if (!this._driver) return;
    await this._driver.close();
    this._driver = undefined;
  }

  async doctor(): Promise<DoctorReport> {
    const injected = !!this._injected;
    const driver = injected ? { installed: true, version: undefined } : isDriverInstalled('mssql');
    return {
      kind: 'mssql',
      driverPackage: injected ? '(injected driver)' : 'mssql',
      driverInstalled: driver.installed,
      driverVersion: driver.version,
      connectionString: this._url,
      capabilities: CAPS,
      notes: [
        injected
          ? 'Custom driver injected via createDb({ driver }).'
          : 'Driver: mssql (Tedious under the hood). Native cascades via FK clauses.',
        'Upsert / ON CONFLICT is NOT supported in 2.3 — the T-SQL MERGE rewrite lands in v2.4.',
        '.searchable() falls back to LIKE — install full-text catalogs for production search.',
      ],
    };
  }

  get driver(): MssqlDriver {
    if (!this._driver) throw new Error('[forge:mssql] driver accessed before connect() resolved');
    return this._driver;
  }

  private mssqlOpts(opts?: ExecOpts): MssqlExecOpts {
    return opts?.session ? { client: opts.session as MssqlQueryable } : {};
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
      { adapter: 'mssql' as any, model: node.model ?? '', op, sql: artifact.sql, params: artifact.params, ...(semanticOp ? { semanticOp } : {}) },
      exec, countRows,
    );
  }

  executeSelect(node: any, model: any, opts?: ExecOpts) {
    return this._track('select', node, model,
      () => executeMssqlSelect(this.handle(opts), node, model, this.mssqlOpts(opts)),
      (r) => r.length);
  }
  executeCount(node: any, model: any, opts?: ExecOpts) {
    return this._track('count', node, model,
      () => executeMssqlCount(this.handle(opts), node, model, this.mssqlOpts(opts)),
      () => 1);
  }
  executeInsert(node: any, model: any, opts?: ExecOpts) {
    return this._track('insert', node, model,
      () => executeMssqlInsert(this.handle(opts), node, model, this.mssqlOpts(opts)),
      (r) => r.count);
  }
  executeUpdate(node: any, model: any, opts?: ExecOpts) {
    return this._track('update', node, model,
      () => executeMssqlUpdate(this.handle(opts), node, model, this.mssqlOpts(opts)),
      (r) => r.count, opts?.semanticOp);
  }
  executeDelete(node: any, model: any, opts?: ExecOpts) {
    return this._track('delete', node, model,
      () => executeMssqlDelete(this.handle(opts), node, model, this.mssqlOpts(opts)),
      (r) => r.count);
  }
  executeGroupBy(node: any, model: any, opts?: ExecOpts) {
    return this._track('groupBy', node, model,
      () => executeMssqlGroupBy(this.handle(opts), node, model, this.mssqlOpts(opts)),
      (r) => r.length);
  }

  private handle(opts?: ExecOpts): MssqlQueryable {
    return (opts?.session as MssqlQueryable | undefined) ?? this.driver;
  }

  async applyProjectionAndHydration(): Promise<void> { /* inline */ }

  coerceInbound(model: any, data: any, _opts?: { forCreate?: boolean }) {
    if (!data || typeof data !== 'object') return data;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(data)) {
      const field = model?.fields?.[k];
      if (field && (field.kind === 'json' || field.kind === 'embed' || field.kind === 'embedMany'
                  || field.kind === 'stringArray' || field.kind === 'intArray')
          && v != null && typeof v === 'object') {
        out[k] = JSON.stringify(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  decodeOutbound(_model: any, row: any) { return row; }

  async applyCascadesForDelete(): Promise<void> { /* T-SQL enforces via FK clauses */ }

  async introspect(): Promise<import('../types').DbIntrospection> {
    const { introspectMssql } = await import('./introspect');
    return introspectMssql(this.driver);
  }

  async $queryRaw(fragment: import('../../raw-sql').SqlFragment, opts?: ExecOpts): Promise<any[]> {
    const { compileSqlFragment } = await import('../../raw-sql');
    const { sql, params } = compileSqlFragment(fragment, 'postgres');
    const { withMssqlErrors } = await import('./errors');
    const { rows } = await withMssqlErrors(() => this.handle(opts).query(sql, params));
    return rows;
  }

  async $executeRaw(fragment: import('../../raw-sql').SqlFragment, opts?: ExecOpts): Promise<number> {
    const { compileSqlFragment } = await import('../../raw-sql');
    const { sql, params } = compileSqlFragment(fragment, 'postgres');
    const { withMssqlErrors } = await import('./errors');
    const { rowCount } = await withMssqlErrors(() => this.handle(opts).query(sql, params));
    return rowCount ?? 0;
  }

  async $transaction<T>(fn: (session: unknown) => Promise<T>): Promise<T> {
    return this.driver.transaction((qc) => fn(qc));
  }
}
