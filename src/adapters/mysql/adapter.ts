import type { Adapter, AdapterCapabilities, DoctorReport, ExecOpts } from '../types';
import * as rawSql from '../../raw-sql';
import * as execMod from './execute';
import * as compileIr from './compile-from-ir';
import { ForgeEmitter } from '../../events';
import { isDriverInstalled, loadDriver } from '../missing-driver';
import {
  executeMysqlCount,
  executeMysqlDelete,
  executeMysqlGroupBy,
  executeMysqlInsert,
  executeMysqlSelect,
  executeMysqlUpdate,
  planMysqlIncludes,
  type MysqlConn,
  type MysqlExecOpts,
  type MysqlPool,
} from './execute';
import { withMysqlErrors } from './errors';
import { mysql2Driver, type MysqlDriver, type MysqlQueryable } from './driver';
import { bytesForDriver } from '../../bytes';

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

/**
 * A relation loaded as JSON uses a derived table that reads its parent's
 * columns, which MySQL accepts from 8.0.14. MariaDB is left out: its JSON is
 * text, and it has no WEIGHT_STRING ordering guarantee to lean on here.
 */
export function mysqlJsonIncludes(version: string): boolean {
  if (/mariadb/i.test(version)) return false;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return a > 8 || (a === 8 && (b > 0 || c >= 14));
}

/** MariaDB 10.5 added INSERT … RETURNING (DELETE has had it since 10.0). */
export function mariadbReturning(version: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version);
  if (!m || !/mariadb/i.test(version)) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > 10 || (maj === 10 && min >= 5);
}

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
      // supportBigNumbers: a BIGINT past 2^53 comes back as an exact string
      // instead of a rounded number, so f.bigint() can read it; smaller values
      // (every COUNT(*)) are still numbers.
      const rawPool = mysql.createPool({ uri: url, connectionLimit: 50, supportBigNumbers: true });
      this._rawPool = (rawPool.promise ? rawPool.promise() : rawPool) as MysqlPool;
      this._driver = mysql2Driver(this._rawPool);
    }
    // Probe so auth/host errors surface at connect() time. The version says
    // whether this is a MariaDB that takes INSERT / DELETE … RETURNING.
    const res: any = await this._driver.query('SELECT VERSION() AS v', []);
    const rows = Array.isArray(res) ? res[0] : undefined;
    const version = String(Array.isArray(rows) ? rows[0]?.v ?? '' : '');
    this._returning = mariadbReturning(version);
    const dates = (this._driver as MysqlDriver).dates;
    if (mysqlJsonIncludes(version) && dates && !dates.strings) this._json = { timezone: dates.timezone };
  }

  private _returning = false;
  private _json: MysqlExecOpts['json'];

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
    const o: MysqlExecOpts = opts?.session ? { conn: opts.session as MysqlConn } : {};
    if (this._returning) o.returning = true;
    if (this._json) o.json = this._json;
    return o;
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
    const c = compileIr;
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
    // Plan the includes before the statement is logged, so the SQL an event
    // reports is the SQL that runs.
    if (this._json) node = planMysqlIncludes(node, model);
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
    const { compileSelect } = compileIr;
    const { decodeRow } = execMod;
    const a = compileSelect(node, model);
    if (this.driver.stream) {
      for await (const row of this.driver.stream(a.sql, a.params)) yield decodeRow(model, row);
    } else {
      const [rows] = await this.driver.query(a.sql, a.params);
      for (const row of rows as any[]) yield decodeRow(model, row);
    }
  }

  async *streamSelectBatches(node: any, model: any, opts?: ExecOpts & { batchSize?: number }): AsyncIterable<any[]> {
    const { compileSelect } = compileIr;
    const { decodeRow } = execMod;
    const a = compileSelect(node, model);
    const size = opts?.batchSize ?? 1000;
    const dec = (rows: any[]) => { for (let i = 0; i < rows.length; i++) rows[i] = decodeRow(model, rows[i]); return rows; };
    // Inside a transaction the rows must come from its connection, or the
    // stream would not see what the transaction has written.
    if (!opts?.session && this.driver.streamBatches) {
      for await (const rows of this.driver.streamBatches(a.sql, a.params, size)) yield dec(rows);
      return;
    }
    if (!opts?.session && this.driver.stream) {
      let buf: any[] = [];
      for await (const r of this.driver.stream(a.sql, a.params)) {
        buf.push(r);
        if (buf.length >= size) { yield dec(buf); buf = []; }
      }
      if (buf.length) yield dec(buf);
      return;
    }
    const [rows] = await this.handle(opts).query(a.sql, a.params);
    for (let i = 0; i < (rows as any[]).length; i += size) yield dec((rows as any[]).slice(i, i + size));
  }

  async applyProjectionAndHydration(): Promise<void> { /* executor does it */ }

  async $queryRaw(fragment: import('../../raw-sql').SqlFragment, opts?: ExecOpts): Promise<any[]> {
    const { compileSqlFragment } = rawSql;
    const { sql, params } = compileSqlFragment(fragment, 'mysql');
    const exec = this.handle(opts);
    const [rows] = await withMysqlErrors(() => exec.query(sql, params));
    return rows as any[];
  }

  async $executeRaw(fragment: import('../../raw-sql').SqlFragment, opts?: ExecOpts): Promise<number> {
    const { compileSqlFragment } = rawSql;
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
        case 'bytes':
          out[k] = bytesForDriver(model?.collection ?? '?', k, field.maxBytes, v);
          break;
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
