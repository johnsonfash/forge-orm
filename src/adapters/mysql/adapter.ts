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

const CAPS: AdapterCapabilities = {
  nativeCascades: true,            // via FK ON DELETE
  nativeUpsert: true,              // ON DUPLICATE KEY UPDATE
  nullsOrdering: false,            // no NULLS FIRST/LAST
  jsonPath: true,                  // JSON_EXTRACT, ->, ->>
  transactionsRequireReplicaSet: false,
};

export class MysqlAdapter implements Adapter {
  readonly kind = 'mysql' as const;
  readonly capabilities = CAPS;
  readonly emitter = new ForgeEmitter();
  private _pool?: MysqlPool;
  private _url?: string;

  async connect(url: string): Promise<void> {
    this._url = url;
    const mysql = loadDriver('mysql', url);
    // mysql2's `mysql.createPool` returns a callback-style pool; we want the
    // promise interface from `mysql.createPool(...).promise()`.
    const rawPool = mysql.createPool({
      uri: url,
      connectionLimit: 50,
      // Reasonable defaults that match PG adapter behaviour.
      // mysql2 doesn't have idleTimeoutMillis at the pool level by default.
    });
    this._pool = (rawPool.promise ? rawPool.promise() : rawPool) as MysqlPool;
    // Sanity probe so auth/host errors surface at connect() time.
    await this._pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    if (this._pool?.end) await this._pool.end();
    this._pool = undefined;
  }

  async doctor(): Promise<DoctorReport> {
    const driver = isDriverInstalled('mysql');
    return {
      kind: 'mysql',
      driverPackage: 'mysql2',
      driverInstalled: driver.installed,
      driverVersion: driver.version,
      connectionString: this._url,
      capabilities: CAPS,
      notes: [
        'No RETURNING clause — INSERT/UPDATE/DELETE that return rows do a follow-up SELECT.',
        'Cascades enforced by the DB engine via FK ON DELETE clauses (ensure InnoDB engine).',
        'NULLS FIRST/LAST not supported — ordering follows the collation.',
      ],
    };
  }

  get pool(): MysqlPool {
    if (!this._pool) throw new Error('[forge:mysql] pool accessed before connect() resolved');
    return this._pool;
  }

  // ─── Executor surface ─────────────────────────────────────────────────

  private mysqlOpts(opts?: ExecOpts): MysqlExecOpts {
    return opts?.session ? { conn: opts.session as MysqlConn } : {};
  }

  private async _track<T>(
    op: 'select' | 'count' | 'groupBy' | 'insert' | 'update' | 'delete',
    node: any, model: any,
    exec: () => Promise<T>,
    countRows: (r: T) => number,
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
      { adapter: 'mysql', model: node.model ?? '', op, sql: a.sql, params: a.params },
      exec, countRows);
  }

  executeSelect(node: any, model: any, opts?: ExecOpts) {
    return this._track('select', node, model,
      () => executeMysqlSelect(this.pool, node, model, this.mysqlOpts(opts)),
      (r) => r.length);
  }
  executeCount(node: any, model: any, opts?: ExecOpts) {
    return this._track('count', node, model,
      () => executeMysqlCount(this.pool, node, model, this.mysqlOpts(opts)),
      () => 1);
  }
  executeInsert(node: any, model: any, opts?: ExecOpts) {
    return this._track('insert', node, model,
      () => executeMysqlInsert(this.pool, node, model, this.mysqlOpts(opts)),
      (r) => r.count);
  }
  executeUpdate(node: any, model: any, opts?: ExecOpts) {
    return this._track('update', node, model,
      () => executeMysqlUpdate(this.pool, node, model, this.mysqlOpts(opts)),
      (r) => r.count);
  }
  executeDelete(node: any, model: any, opts?: ExecOpts) {
    return this._track('delete', node, model,
      () => executeMysqlDelete(this.pool, node, model, this.mysqlOpts(opts)),
      (r) => r.count);
  }
  executeGroupBy(node: any, model: any, opts?: ExecOpts) {
    return this._track('groupBy', node, model,
      () => executeMysqlGroupBy(this.pool, node, model, this.mysqlOpts(opts)),
      (r) => r.length);
  }

  // Wave 4b — native streaming via mysql2's connection.query(...).stream().
  // The pool's query API doesn't expose streams; we borrow a connection.
  async *streamSelect(node: any, model: any, _opts?: ExecOpts): AsyncIterable<any> {
    const { compileSelect } = await import('./compile-from-ir');
    const a = compileSelect(node, model);
    const conn = await this.pool.getConnection() as any;
    try {
      // mysql2's promise wrapper exposes the underlying connection via `.connection`.
      const raw = conn.connection ?? conn;
      const stream: any = raw.query({ sql: a.sql, values: a.params }).stream({ highWaterMark: 200 });
      for await (const row of stream) yield row;
    } finally {
      if (typeof conn.release === 'function') conn.release();
    }
  }

  async applyProjectionAndHydration(): Promise<void> { /* executor does it */ }

  // ─── Raw SQL ───────────────────────────────────────────────────────────

  async $queryRaw(fragment: import('../../raw-sql').SqlFragment, opts?: ExecOpts): Promise<any[]> {
    const { compileSqlFragment } = await import('../../raw-sql');
    const { sql, params } = compileSqlFragment(fragment, 'mysql');
    const exec = (opts?.session as MysqlConn | undefined) ?? this.pool;
    const [rows] = await withMysqlErrors(() => exec.query(sql, params));
    return rows as any[];
  }

  async $executeRaw(fragment: import('../../raw-sql').SqlFragment, opts?: ExecOpts): Promise<number> {
    const { compileSqlFragment } = await import('../../raw-sql');
    const { sql, params } = compileSqlFragment(fragment, 'mysql');
    const exec = (opts?.session as MysqlConn | undefined) ?? this.pool;
    const [result]: any = await withMysqlErrors(() => exec.execute(sql, params));
    return result.affectedRows ?? 0;
  }

  // ─── $transaction ─────────────────────────────────────────────────────
  // mysql2 promise pool: borrow a connection, BEGIN, COMMIT/ROLLBACK.
  async $transaction<T>(fn: (session: unknown) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    try {
      await conn.query('START TRANSACTION');
      const result = await fn(conn);
      await conn.query('COMMIT');
      return result;
    } catch (err) {
      try { await conn.query('ROLLBACK'); } catch { /* swallow */ }
      throw err;
    } finally {
      if (typeof conn.release === 'function') conn.release();
    }
  }

  // ─── coerce / decode / cascade ────────────────────────────────────────

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
    return row;   // executor decodes
  }

  async applyCascadesForDelete(): Promise<void> { /* DB-enforced */ }

  // Wave 5d — table-backed materialised view refresh: clear + re-populate from
  // the view's SELECT body. Wrapped in a transaction so readers never see an
  // empty table mid-refresh.
  async refreshView(model: any, opts?: ExecOpts): Promise<void> {
    const sql = model?.view?.sql;
    if (!sql) throw new Error(`[forge:mysql] '${model?.collection}' has no view SQL to refresh`);
    const q = '`' + String(model.collection).replace(/`/g, '``') + '`';
    const conn = (opts?.session as MysqlConn | undefined);
    const run = async (c: MysqlConn | MysqlPool) => {
      await c.query(`DELETE FROM ${q}`);
      await c.query(`INSERT INTO ${q} ${sql}`);
    };
    if (conn) { await run(conn); return; }
    await this.$transaction((s) => run(s as MysqlConn));
  }

  // Wave 5b — live-schema introspection (INFORMATION_SCHEMA).
  async introspect(): Promise<import('../types').DbIntrospection> {
    const { introspectMysql } = await import('./introspect');
    return introspectMysql(this.pool);
  }
}
