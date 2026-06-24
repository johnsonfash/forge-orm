import type { Adapter, AdapterCapabilities, DoctorReport, ExecOpts } from '../types';
import { ForgeEmitter } from '../../events';
import { isDriverInstalled, loadDriver } from '../missing-driver';
import {
  executeMysqlCount,
  executeMysqlDelete,
  executeMysqlGroupBy,
  executeMysqlInsert,
  executeMysqlSelect,
  executeMysqlUpdate,
  type MysqlConn,
  type MysqlExecOpts,
  type MysqlPool,
} from './execute';
import { withMysqlErrors } from './errors';
import { mysql2Driver, type MysqlDriver, type MysqlQueryable } from './driver';

// MysqlAdapter — drives a MysqlDriver port (driver.ts). By default it opens a
// mysql2 promise pool from the URL; a pre-wrapped driver (mariadb, PlanetScale,
// …) can be injected via createDb({ driver }).

const CAPS: AdapterCapabilities = {
  nativeCascades: true,
  nativeUpsert: true,
  nullsOrdering: false,
  jsonPath: true,
  transactionsRequireReplicaSet: false,
};

export class MysqlAdapter implements Adapter {
  readonly kind = 'mysql' as const;
  readonly capabilities = CAPS;
  readonly emitter = new ForgeEmitter();
  private _driver?: MysqlDriver;
  // Raw mysql2 promise pool when we created one — kept so the migration tooling
  // (which calls getConnection) still has a full handle via `.pool`.
  private _rawPool?: MysqlPool;
  private _url?: string;

  constructor(private _injected?: MysqlDriver) {}

  async connect(url: string): Promise<void> {
    this._url = url;
    if (this._injected) {
      this._driver = this._injected;
    } else {
      const mysql = loadDriver('mysql', url);
      const rawPool = mysql.createPool({ uri: url, connectionLimit: 50 });
      this._rawPool = (rawPool.promise ? rawPool.promise() : rawPool) as MysqlPool;
      this._driver = mysql2Driver(this._rawPool);
    }
    // Probe so auth/host errors surface at connect() time.
    await this._driver.query('SELECT 1', []);
  }

  async close(): Promise<void> {
    if (this._driver) await this._driver.close();
    this._driver = undefined;
  }

  async doctor(): Promise<DoctorReport> {
    const injected = !!this._injected;
    const driver = injected ? { installed: true, version: undefined } : isDriverInstalled('mysql');
    return {
      kind: 'mysql',
      driverPackage: injected ? '(injected driver)' : 'mysql2',
      driverInstalled: driver.installed,
      driverVersion: driver.version,
      connectionString: this._url,
      capabilities: CAPS,
      notes: [
        injected
          ? 'Custom driver injected via createDb({ driver }) — e.g. mariadb, PlanetScale.'
          : 'Driver: mysql2. No RETURNING — writes that return rows do a follow-up SELECT.',
        'Queries route through a normalized driver port.',
      ],
    };
  }

  get driver(): MysqlDriver {
    if (!this._driver) throw new Error('[forge:mysql] driver accessed before connect() resolved');
    return this._driver;
  }

  // The full mysql2 pool (with getConnection) when forge created one — used by
  // the migration tooling. Falls back to the queryable port for injected drivers.
  get pool(): MysqlPool {
    return this._rawPool ?? (this.driver as unknown as MysqlPool);
  }

  private mysqlOpts(opts?: ExecOpts): MysqlExecOpts {
    return opts?.session ? { conn: opts.session as MysqlConn } : {};
  }

  // Handle the executor should use: the txn session if present, else the driver.
  private handle(opts?: ExecOpts): MysqlPool {
    return (opts?.session as MysqlPool | undefined) ?? (this.driver as unknown as MysqlPool);
  }

  private async _track<T>(
    op: 'select' | 'count' | 'groupBy' | 'insert' | 'update' | 'delete',
    node: any, model: any,
    exec: () => Promise<T>,
    countRows: (r: T) => number,
    semanticOp?: ExecOpts['semanticOp'],
  ): Promise<T> {
    if (!this.emitter.hasListeners()) return exec();
    const c = await import('./compile-from-ir');
    const a =
      op === 'select'  ? c.compileSelect(node, model)  :
      op === 'count'   ? c.compileCount(node, model)   :
      op === 'groupBy' ? c.compileGroupBy(node, model) :
      op === 'insert'  ? c.compileInsert(node, model)  :
      op === 'update'  ? c.compileUpdate(node, model)  :
                         c.compileDelete(node, model);
    return this.emitter.track(
      { adapter: 'mysql', model: node.model ?? '', op, sql: a.sql, params: a.params, ...(semanticOp ? { semanticOp } : {}) },
      exec, countRows);
  }

  executeSelect(node: any, model: any, opts?: ExecOpts) {
    return this._track('select', node, model,
      () => executeMysqlSelect(this.handle(opts), node, model, this.mysqlOpts(opts)),
      (r) => r.length);
  }
  executeCount(node: any, model: any, opts?: ExecOpts) {
    return this._track('count', node, model,
      () => executeMysqlCount(this.handle(opts), node, model, this.mysqlOpts(opts)),
      () => 1);
  }
  executeInsert(node: any, model: any, opts?: ExecOpts) {
    return this._track('insert', node, model,
      () => executeMysqlInsert(this.handle(opts), node, model, this.mysqlOpts(opts)),
      (r) => r.count);
  }
  executeUpdate(node: any, model: any, opts?: ExecOpts) {
    return this._track('update', node, model,
      () => executeMysqlUpdate(this.handle(opts), node, model, this.mysqlOpts(opts)),
      (r) => r.count, opts?.semanticOp);
  }
  executeDelete(node: any, model: any, opts?: ExecOpts) {
    return this._track('delete', node, model,
      () => executeMysqlDelete(this.handle(opts), node, model, this.mysqlOpts(opts)),
      (r) => r.count);
  }
  executeGroupBy(node: any, model: any, opts?: ExecOpts) {
    return this._track('groupBy', node, model,
      () => executeMysqlGroupBy(this.handle(opts), node, model, this.mysqlOpts(opts)),
      (r) => r.length);
  }

  async *streamSelect(node: any, model: any, _opts?: ExecOpts): AsyncIterable<any> {
    const { compileSelect } = await import('./compile-from-ir');
    const a = compileSelect(node, model);
    if (this.driver.stream) {
      yield* this.driver.stream(a.sql, a.params);
    } else {
      const [rows] = await this.driver.query(a.sql, a.params);
      for (const row of rows as any[]) yield row;
    }
  }

  async applyProjectionAndHydration(): Promise<void> { /* executor does it */ }

  async $queryRaw(fragment: import('../../raw-sql').SqlFragment, opts?: ExecOpts): Promise<any[]> {
    const { compileSqlFragment } = await import('../../raw-sql');
    const { sql, params } = compileSqlFragment(fragment, 'mysql');
    const exec = this.handle(opts);
    const [rows] = await withMysqlErrors(() => exec.query(sql, params));
    return rows as any[];
  }

  async $executeRaw(fragment: import('../../raw-sql').SqlFragment, opts?: ExecOpts): Promise<number> {
    const { compileSqlFragment } = await import('../../raw-sql');
    const { sql, params } = compileSqlFragment(fragment, 'mysql');
    const exec = this.handle(opts);
    const [result]: any = await withMysqlErrors(() => exec.execute(sql, params));
    return result.affectedRows ?? 0;
  }

  async $transaction<T>(fn: (session: unknown) => Promise<T>): Promise<T> {
    return this.driver.transaction((session: MysqlQueryable) => fn(session));
  }

  coerceInbound(model: any, data: any, _opts?: { forCreate?: boolean }) {
    if (!data || typeof data !== 'object') return data;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(data)) {
      const field = model?.fields?.[k];
      if (!field || v == null) { out[k] = v; continue; }
      switch (field.kind) {
        case 'bool':       out[k] = v ? 1 : 0; break;
        case 'json':
        case 'embed':
        case 'embedMany':
        case 'stringArray':
        case 'intArray':
          out[k] = typeof v === 'object' ? JSON.stringify(v) : v;
          break;
        default:           out[k] = v;
      }
    }
    return out;
  }

  decodeOutbound(_model: any, row: any) {
    return row;
  }

  async applyCascadesForDelete(): Promise<void> { /* DB-enforced */ }

  async refreshView(model: any, opts?: ExecOpts): Promise<void> {
    const sql = model?.view?.sql;
    if (!sql) throw new Error(`[forge:mysql] '${model?.collection}' has no view SQL to refresh`);
    const q = '`' + String(model.collection).replace(/`/g, '``') + '`';
    const run = async (c: MysqlQueryable) => {
      await c.query(`DELETE FROM ${q}`);
      await c.query(`INSERT INTO ${q} ${sql}`);
    };
    if (opts?.session) { await run(opts.session as MysqlQueryable); return; }
    await this.$transaction((s) => run(s as MysqlQueryable));
  }

  async introspect(): Promise<import('../types').DbIntrospection> {
    const { introspectMysql } = await import('./introspect');
    return introspectMysql(this.pool);
  }
}
