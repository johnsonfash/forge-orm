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

// SQLiteAdapter — wraps better-sqlite3 (synchronous driver) in forge's async
// Adapter contract.
//
// Connection-string forms accepted:
//   sqlite:./app.db                   → ./app.db relative to cwd
//   sqlite:/abs/path/app.db           → absolute path
//   sqlite::memory:                    → in-process, gone on close
//   file:./app.db                      → same as sqlite:
//   ./app.db (bare path ending .db)   → also recognised by detectAdapterKind
//
// Cascade enforcement: the DDL emits FOREIGN KEY ... ON DELETE CASCADE
// inside CREATE TABLE, but SQLite only honours those if
// `PRAGMA foreign_keys = ON` is set on the connection. The adapter sets it
// at connect(); the migrator re-sets it for safety.

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
    // better-sqlite3's default export is the Database constructor.
    const Database = (sqlite as any).default ?? sqlite;
    this._db = new Database(filename) as SqliteDb;
    // Critical for cascades + general correctness:
    this._db.pragma('foreign_keys = ON');
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

  // ─── Executor surface ─────────────────────────────────────────────────

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

  // Wave 4b — native streaming via better-sqlite3's stmt.iterate(). Yields
  // rows from the prepared statement without materialising the result set.
  async *streamSelect(node: any, model: any, _opts?: ExecOpts): AsyncIterable<any> {
    const { compileSelect } = await import('./compile-from-ir');
    const a = compileSelect(node, model);
    const stmt = this.db.prepare(a.sql);
    // better-sqlite3 statements have an `.iterate(...params)` that returns a
    // synchronous iterator. We hand-decode each row via the model.
    const iter = (stmt as any).iterate(...a.params);
    const { decodeRow } = await import('./execute');
    for (const row of iter) yield decodeRow(model, row);
  }

  async applyProjectionAndHydration(): Promise<void> { /* no-op; executor does it */ }

  // ─── Raw SQL ───────────────────────────────────────────────────────────

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

  // ─── $transaction (BEGIN / COMMIT / ROLLBACK) ─────────────────────────
  //
  // better-sqlite3 has its own .transaction() helper, but it expects a sync
  // callback. We need to support async callbacks, so we drive the BEGIN/
  // COMMIT/ROLLBACK directly. The same db handle is passed back via
  // ExecOpts.session so nested calls inside the callback land on the same
  // transactional state.
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

  // ─── coerce / decode / cascade ────────────────────────────────────────

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

  // Wave 5d — table-backed materialised view refresh: clear + re-populate from
  // the view's SELECT body, inside a transaction.
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

  // Wave 5b — live-schema introspection (sqlite_master + PRAGMA).
  async introspect(): Promise<import('../types').DbIntrospection> {
    const { introspectSqlite } = await import('./introspect');
    return introspectSqlite(this.db);
  }

  // ─── URL → filename ────────────────────────────────────────────────────

  private _urlToFilename(url: string): string {
    // `:memory:` is special — better-sqlite3 recognises it as in-RAM.
    if (url === 'sqlite::memory:' || url === ':memory:') return ':memory:';
    const stripped = url
      .replace(/^sqlite:/, '')
      .replace(/^file:/, '');
    // Empty path → in-memory.
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
