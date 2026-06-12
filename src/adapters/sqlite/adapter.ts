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
  type SqliteDb,
  type SqliteExecOpts,
} from './execute';
import { withSqliteErrors } from './errors';
import { SqliteDialect } from './dialect';

// SQLiteAdapter — wraps better-sqlite3 (sync driver) in forge's async contract.
//
// Connection-string forms accepted:
//   sqlite:./app.db                   → ./app.db relative to cwd
//   sqlite:/abs/path/app.db           → absolute path
//   sqlite::memory:                    → in-process, gone on close
//   file:./app.db                      → same as sqlite:
//   ./app.db (bare path ending .db)   → also recognised by detectAdapterKind
//
// Cascade gotcha: ON DELETE CASCADE is only honoured when
// `PRAGMA foreign_keys = ON` is set per-connection. Set at connect();
// the migrator re-sets it for safety.

const CAPS: AdapterCapabilities = {
  nativeCascades: true,            // via FK ON DELETE clauses, with pragma
  nativeUpsert: true,              // ON CONFLICT (col) DO UPDATE (3.24+)
  nullsOrdering: true,             // NULLS FIRST/LAST (3.30+)
  jsonPath: true,                  // json_*() functions
  transactionsRequireReplicaSet: false,
};

export class SqliteAdapter implements Adapter {
  readonly kind = 'sqlite' as const;
  readonly capabilities = CAPS;
  readonly emitter: ForgeEmitter = new ForgeEmitter();
  private _db?: SqliteDb;
  private _url?: string;

  async connect(url: string): Promise<void> {
    this._url = url;
    const filename = this._urlToFilename(url);
    const sqlite = loadDriver('sqlite', url);
    const Database = (sqlite as any).default ?? sqlite;
    this._db = new Database(filename) as SqliteDb;
    this._db.pragma('foreign_keys = ON');   // required for cascades to fire
    this._db.pragma('journal_mode = WAL');  // better concurrent read perf
  }

  async close(): Promise<void> {
    if (this._db && (this._db as any).close) (this._db as any).close();
    this._db = undefined;
  }

  async doctor(): Promise<DoctorReport> {
    const driver = isDriverInstalled('sqlite');
    return {
      kind: 'sqlite',
      driverPackage: 'better-sqlite3',
      driverInstalled: driver.installed,
      driverVersion: driver.version,
      connectionString: this._url,
      capabilities: CAPS,
      notes: [
        'Embedded — no server, no port. "Database" is the file you point at.',
        'Synchronous driver: forge wraps each call in Promise.resolve() to match the async Adapter contract.',
        'Concurrent writers serialise via SQLite\'s file lock; reads are concurrent under WAL mode.',
      ],
    };
  }

  get db(): SqliteDb {
    if (!this._db) throw new Error('[forge:sqlite] db accessed before connect() resolved');
    return this._db;
  }

  private sqliteOpts(opts?: ExecOpts): SqliteExecOpts {
    return opts?.session ? { db: opts.session as SqliteDb } : {};
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
      { adapter: 'sqlite', model: node.model ?? '', op, sql: a.sql, params: a.params as unknown[] },
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
      (r) => r.count);
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

  // Streaming via better-sqlite3's stmt.iterate() — yields rows without
  // materialising the result set.
  async *streamSelect(node: any, model: any, _opts?: ExecOpts): AsyncIterable<any> {
    const { compileSelect } = await import('./compile-from-ir');
    const a = compileSelect(node, model);
    const stmt = this.db.prepare(a.sql);
    const iter = (stmt as any).iterate(...a.params);
    const { decodeRow } = await import('./execute');
    for (const row of iter) yield decodeRow(model, row);
  }

  async applyProjectionAndHydration(): Promise<void> { /* no-op; executor does it */ }

  async $queryRaw(fragment: import('../../raw-sql').SqlFragment, opts?: ExecOpts): Promise<any[]> {
    const { compileSqlFragment } = await import('../../raw-sql');
    const { sql, params } = compileSqlFragment(fragment, 'sqlite');
    const exec = (opts?.session as SqliteDb | undefined) ?? this.db;
    return withSqliteErrors(() => exec.prepare(sql).all(...params));
  }

  async $executeRaw(fragment: import('../../raw-sql').SqlFragment, opts?: ExecOpts): Promise<number> {
    const { compileSqlFragment } = await import('../../raw-sql');
    const { sql, params } = compileSqlFragment(fragment, 'sqlite');
    const exec = (opts?.session as SqliteDb | undefined) ?? this.db;
    const r = await withSqliteErrors(() => exec.prepare(sql).run(...params));
    return r.changes;
  }

  // better-sqlite3's .transaction() helper only takes sync callbacks, so we
  // drive BEGIN/COMMIT/ROLLBACK directly to support async ones. The db handle
  // is passed back via ExecOpts.session so nested calls share the txn state.
  async $transaction<T>(fn: (session: unknown) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    try {
      const result = await fn(this.db);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* swallow */ }
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

  // Table-backed materialised view refresh: clear + re-populate from the
  // view's SELECT body, in a transaction.
  async refreshView(model: any, opts?: ExecOpts): Promise<void> {
    const sql = model?.view?.sql;
    if (!sql) throw new Error(`[forge:sqlite] '${model?.collection}' has no view SQL to refresh`);
    const db = (opts?.session as SqliteDb | undefined) ?? this.db;
    const q = `"${String(model.collection).replace(/"/g, '""')}"`;
    const tx = (db as any).transaction(() => {
      db.exec(`DELETE FROM ${q}`);
      db.exec(`INSERT INTO ${q} ${sql}`);
    });
    tx();
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

// Lazily-built singleton for callers who don't construct via createDb().
let _default: SqliteAdapter | undefined;
export function getDefaultSqliteAdapter(): SqliteAdapter {
  if (!_default) _default = new SqliteAdapter();
  return _default;
}

void SqliteDialect;
