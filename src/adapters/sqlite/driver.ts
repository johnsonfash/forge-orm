import type { AdapterKind } from '../types';

// SqliteDriver — the normalized, async-capable port the SQLite adapter and
// executor talk to. Every concrete driver (better-sqlite3, expo-sqlite,
// op-sqlite, libsql/Turso) is wrapped to this shape, so the rest of the SQLite
// code path is driver-agnostic. Methods return promises; a synchronous driver
// (better-sqlite3) simply resolves immediately.
export interface SqliteDriver {
  // Tag so createDb({ driver }) can pick the right adapter without a URL.
  readonly kind: Extract<AdapterKind, 'sqlite'>;
  all(sql: string, params: unknown[]): Promise<any[]>;
  get(sql: string, params: unknown[]): Promise<any>;
  run(sql: string, params: unknown[]): Promise<{ changes: number; lastInsertRowid?: number | bigint }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  // Optional native row-at-a-time cursor (better-sqlite3 stmt.iterate()). When
  // absent, the adapter falls back to materialising via all().
  iterate?(sql: string, params: unknown[]): AsyncIterable<any> | Iterable<any>;
}

// ─── better-sqlite3 (synchronous; the default driver) ───────────────────────
export function betterSqlite3Driver(db: any): SqliteDriver {
  return {
    kind: 'sqlite',
    all: async (sql, params) => db.prepare(sql).all(...params),
    get: async (sql, params) => db.prepare(sql).get(...params),
    run: async (sql, params) => {
      const r = db.prepare(sql).run(...params);
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    },
    exec: async (sql) => { db.exec(sql); },
    close: async () => { db.close?.(); },
    iterate: (sql, params) => db.prepare(sql).iterate(...params),
  };
}

// ─── expo-sqlite (async; Expo / React Native) ──────────────────────────────
// Wrap an opened `SQLiteDatabase` from `expo-sqlite` (SDK 51+ async API).
export function expoSqliteDriver(db: any): SqliteDriver {
  return {
    kind: 'sqlite',
    all: async (sql, params) => db.getAllAsync(sql, params as any[]),
    get: async (sql, params) => db.getFirstAsync(sql, params as any[]),
    run: async (sql, params) => {
      const r = await db.runAsync(sql, params as any[]);
      return { changes: r?.changes ?? 0, lastInsertRowid: r?.lastInsertRowId };
    },
    exec: async (sql) => { await db.execAsync(sql); },
    close: async () => { await db.closeAsync?.(); },
  };
}

// ─── op-sqlite (async; bare React Native, @op-engineering/op-sqlite) ────────
export function opSqliteDriver(db: any): SqliteDriver {
  const exec = async (sql: string, params: unknown[]) => {
    const r = await db.execute(sql, params as any[]);
    // op-sqlite returns { rows: { _array } | rows, rowsAffected, insertId }.
    const rows = r?.rows?._array ?? r?.rows ?? [];
    return { rows, rowsAffected: r?.rowsAffected ?? 0, insertId: r?.insertId };
  };
  return {
    kind: 'sqlite',
    all: async (sql, params) => (await exec(sql, params)).rows,
    get: async (sql, params) => (await exec(sql, params)).rows[0],
    run: async (sql, params) => {
      const r = await exec(sql, params);
      return { changes: r.rowsAffected, lastInsertRowid: r.insertId };
    },
    exec: async (sql) => { await db.execute(sql, []); },
    close: async () => { db.close?.(); },
  };
}

// ─── libsql / Turso (async; @libsql/client — runs in Node + edge) ───────────
// Rebuild each row as a plain { column: value } object: a libsql Row also
// carries numeric indices, which would otherwise leak through decodeRow's
// Object.keys() walk.
function fromColumns(columns: string[], row: any): any {
  if (!columns) return row;
  const out: any = {};
  for (let i = 0; i < columns.length; i++) out[columns[i]] = row[i];
  return out;
}
export function libsqlDriver(client: any): SqliteDriver {
  const run = (sql: string, params: unknown[]) =>
    client.execute(params.length ? { sql, args: params as any[] } : sql);
  return {
    kind: 'sqlite',
    all: async (sql, params) => {
      const r = await run(sql, params);
      return r.rows.map((row: any) => fromColumns(r.columns, row));
    },
    get: async (sql, params) => {
      const r = await run(sql, params);
      return r.rows[0] ? fromColumns(r.columns, r.rows[0]) : undefined;
    },
    run: async (sql, params) => {
      const r = await run(sql, params);
      return { changes: Number(r.rowsAffected ?? 0), lastInsertRowid: r.lastInsertRowid };
    },
    exec: async (sql) => { await client.execute(sql); },
    close: async () => { client.close?.(); },
  };
}

export function isSqliteDriver(v: unknown): v is SqliteDriver {
  return !!v && typeof v === 'object' && (v as any).kind === 'sqlite' &&
    typeof (v as any).all === 'function' && typeof (v as any).run === 'function';
}
