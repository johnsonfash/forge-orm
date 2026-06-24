import type { Adapter, AdapterCapabilities, DoctorReport, ExecOpts } from '../types';
import { ForgeEmitter } from '../../events';
import { isDriverInstalled, loadDriver } from '../missing-driver';
import {
  executeSqliteCount,
  executeSqliteDelete,
  executeSqliteGroupBy,
  executeSqliteInsert,
  executeSqliteSelect,
  executeSqliteUpdate,
  type SqliteExecOpts,
} from './execute';
import { withSqliteErrors } from './errors';
import { SqliteDialect } from './dialect';
import { betterSqlite3Driver, type SqliteDriver } from './driver';

// SQLiteAdapter — drives a SqliteDriver port (driver.ts). By default it opens
// better-sqlite3 from the connection URL; a pre-wrapped driver (expo-sqlite,
// op-sqlite, libsql, …) can be injected via createDb({ driver }) instead, in
// which case the URL is ignored.
//
// Connection-string forms (default driver): sqlite:./app.db | sqlite:/abs.db |
// sqlite::memory: | file:./app.db | ./app.db
//
// Cascade gotcha: ON DELETE CASCADE only fires with `PRAGMA foreign_keys = ON`,
// set per-connection at connect() and re-set by the migrator.

const CAPS: AdapterCapabilities = {
  nativeCascades: true,
  nativeUpsert: true,
  nullsOrdering: true,
  jsonPath: true,
  transactionsRequireReplicaSet: false,
};

export class SqliteAdapter implements Adapter {
  readonly kind = 'sqlite' as const;
  readonly capabilities = CAPS;
  readonly emitter: ForgeEmitter = new ForgeEmitter();
  private _db?: SqliteDriver;
  private _url?: string;

  // An injected driver bypasses better-sqlite3 entirely (React Native / edge).
  constructor(private _injected?: SqliteDriver) {}

  async connect(url: string): Promise<void> {
    this._url = url;
    if (this._injected) {
      this._db = this._injected;
    } else {
      const filename = this._urlToFilename(url);
      const sqlite = loadDriver('sqlite', url);
      const Database = (sqlite as any).default ?? sqlite;
      this._db = betterSqlite3Driver(new Database(filename));
      await this._db.exec('PRAGMA journal_mode = WAL');  // file driver only
    }
    await this._db.exec('PRAGMA foreign_keys = ON');      // required for cascades
    // Best-effort SpatiaLite load — silently skip when unavailable so
    // non-geo schemas keep working. The doctor probe surfaces the absence
    // when geoPoint fields are declared.
    await this._tryLoadSpatialite();
  }

  private async _tryLoadSpatialite(): Promise<void> {
    if (!this._db) return;
    try {
      await this._db.exec("SELECT load_extension('mod_spatialite')");
    } catch {
      // SpatiaLite not available — geo fields fall back to fallback-mode
      // storage and Haversine post-filter.
    }
  }

  async close(): Promise<void> {
    if (this._db) await this._db.close();
    this._db = undefined;
  }

  async doctor(): Promise<DoctorReport> {
    const injected = !!this._injected;
    const driver = injected ? { installed: true, version: undefined } : isDriverInstalled('sqlite');
    return {
      kind: 'sqlite',
      driverPackage: injected ? '(injected driver)' : 'better-sqlite3',
      driverInstalled: driver.installed,
      driverVersion: driver.version,
      connectionString: this._url,
      capabilities: CAPS,
      notes: [
        injected
          ? 'Custom driver injected via createDb({ driver }) — e.g. expo-sqlite, op-sqlite, libsql.'
          : 'Embedded — no server, no port. "Database" is the file you point at.',
        'Queries route through a normalized async driver port, so sync (better-sqlite3) and async (RN/edge) drivers share one code path.',
      ],
    };
  }

  get db(): SqliteDriver {
    if (!this._db) throw new Error('[forge:sqlite] db accessed before connect() resolved');
    return this._db;
  }

  private sqliteOpts(opts?: ExecOpts): SqliteExecOpts {
    return opts?.session ? { db: opts.session as SqliteDriver } : {};
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
      { adapter: 'sqlite', model: node.model ?? '', op, sql: a.sql, params: a.params as unknown[], ...(semanticOp ? { semanticOp } : {}) },
      exec, countRows);
  }

  executeSelect(node: any, model: any, opts?: ExecOpts) {
    return this._track('select', node, model,
      () => executeSqliteSelect(this.db, node, model, this.sqliteOpts(opts)),
      (r) => r.length);
  }
  executeCount(node: any, model: any, opts?: ExecOpts) {
    return this._track('count', node, model,
      () => executeSqliteCount(this.db, node, model, this.sqliteOpts(opts)),
      () => 1);
  }
  executeInsert(node: any, model: any, opts?: ExecOpts) {
    return this._track('insert', node, model,
      () => executeSqliteInsert(this.db, node, model, this.sqliteOpts(opts)),
      (r) => r.count);
  }
  executeUpdate(node: any, model: any, opts?: ExecOpts) {
    return this._track('update', node, model,
      () => executeSqliteUpdate(this.db, node, model, this.sqliteOpts(opts)),
      (r) => r.count, opts?.semanticOp);
  }
  executeDelete(node: any, model: any, opts?: ExecOpts) {
    return this._track('delete', node, model,
      () => executeSqliteDelete(this.db, node, model, this.sqliteOpts(opts)),
      (r) => r.count);
  }
  executeGroupBy(node: any, model: any, opts?: ExecOpts) {
    return this._track('groupBy', node, model,
      () => executeSqliteGroupBy(this.db, node, model, this.sqliteOpts(opts)),
      (r) => r.length);
  }

  // Stream via the driver's native cursor when it exposes one (better-sqlite3
  // stmt.iterate()); otherwise materialise via all() — still one yield per row.
  async *streamSelect(node: any, model: any, _opts?: ExecOpts): AsyncIterable<any> {
    const { compileSelect } = await import('./compile-from-ir');
    const { decodeRow } = await import('./execute');
    const a = compileSelect(node, model);
    if (this.db.iterate) {
      for await (const row of this.db.iterate(a.sql, a.params)) yield decodeRow(model, row);
    } else {
      const rows = await this.db.all(a.sql, a.params);
      for (const row of rows) yield decodeRow(model, row);
    }
  }

  async applyProjectionAndHydration(): Promise<void> { /* no-op; executor does it */ }

  async $queryRaw(fragment: import('../../raw-sql').SqlFragment, opts?: ExecOpts): Promise<any[]> {
    const { compileSqlFragment } = await import('../../raw-sql');
    const { sql, params } = compileSqlFragment(fragment, 'sqlite');
    const exec = (opts?.session as SqliteDriver | undefined) ?? this.db;
    return withSqliteErrors(() => exec.all(sql, params));
  }

  async $executeRaw(fragment: import('../../raw-sql').SqlFragment, opts?: ExecOpts): Promise<number> {
    const { compileSqlFragment } = await import('../../raw-sql');
    const { sql, params } = compileSqlFragment(fragment, 'sqlite');
    const exec = (opts?.session as SqliteDriver | undefined) ?? this.db;
    const r = await withSqliteErrors(() => exec.run(sql, params));
    return r.changes;
  }

  // Drive BEGIN/COMMIT/ROLLBACK explicitly (portable across drivers). The driver
  // handle is passed back via ExecOpts.session so nested calls share the txn.
  async $transaction<T>(fn: (session: unknown) => Promise<T>): Promise<T> {
    await this.db.exec('BEGIN');
    try {
      const result = await fn(this.db);
      await this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { await this.db.exec('ROLLBACK'); } catch { /* swallow */ }
      throw err;
    }
  }

  coerceInbound(model: any, data: any, _opts?: { forCreate?: boolean }) {
    if (!data || typeof data !== 'object') return data;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(data)) {
      const field = model?.fields?.[k];
      if (!field || v == null) { out[k] = v; continue; }
      switch (field.kind) {
        case 'bool':       out[k] = v ? 1 : 0; break;
        case 'dateTime':   out[k] = v instanceof Date ? v.toISOString() : v; break;
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
    return row;   // executor.decodeRow already did it
  }

  async applyCascadesForDelete(): Promise<void> {
    // PRAGMA foreign_keys = ON is set at connect; cascades happen in-engine.
  }

  // Table-backed materialised view refresh: clear + re-populate from the view's
  // SELECT body, in a transaction (portable BEGIN/COMMIT, no driver helper).
  async refreshView(model: any, opts?: ExecOpts): Promise<void> {
    const sql = model?.view?.sql;
    if (!sql) throw new Error(`[forge:sqlite] '${model?.collection}' has no view SQL to refresh`);
    const db = (opts?.session as SqliteDriver | undefined) ?? this.db;
    const q = `"${String(model.collection).replace(/"/g, '""')}"`;
    await db.exec('BEGIN');
    try {
      await db.exec(`DELETE FROM ${q}`);
      await db.exec(`INSERT INTO ${q} ${sql}`);
      await db.exec('COMMIT');
    } catch (err) {
      try { await db.exec('ROLLBACK'); } catch { /* swallow */ }
      throw err;
    }
  }

  async introspect(): Promise<import('../types').DbIntrospection> {
    const { introspectSqlite } = await import('./introspect');
    return introspectSqlite(this.db);
  }

  private _urlToFilename(url: string): string {
    if (url === 'sqlite::memory:' || url === ':memory:') return ':memory:';
    const stripped = url
      .replace(/^sqlite:/, '')
      .replace(/^file:/, '');
    if (stripped === '' || stripped === ':memory:') return ':memory:';
    return stripped;
  }
}

let _default: SqliteAdapter | undefined;
export function getDefaultSqliteAdapter(): SqliteAdapter {
  if (!_default) _default = new SqliteAdapter();
  return _default;
}

void SqliteDialect;
