import type { AdapterKind } from '../types';
import { guardPoolErrors } from '../pool-errors';

// PostgresDriver — the normalized port the Postgres adapter and executor talk
// to. node-postgres (`pg`) is the default; `postgres` (porsager/postgres.js) or
// any other client can be wrapped to the same shape. The executor only ever
// calls `query(sql, params)`, so a session and the pool are interchangeable.

export interface PgQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }>;
  /**
   * Run a script of several statements in one round trip over the simple
   * query protocol, with no parameters. Optional: the migration runner uses
   * it to send a file exactly as written (so `$$` bodies and `BEGIN ATOMIC`
   * need no client-side splitting), and splits the file itself when absent.
   */
  exec?(sql: string): Promise<void>;
}

/** A connection held for the caller alone until `release()`. */
export interface PgReservedSession extends PgQueryable {
  release(): Promise<void> | void;
}

export interface PostgresDriver extends PgQueryable {
  readonly kind: Extract<AdapterKind, 'postgres'>;
  // Run `fn` in a transaction; the session it receives is a queryable bound to
  // the same connection (so every executor call inside lands on the txn).
  transaction<T>(fn: (session: PgQueryable) => Promise<T>): Promise<T>;
  // Optional server-side cursor stream. Absent → adapter materialises via query.
  stream?(sql: string, params: unknown[]): AsyncIterable<any>;
  // The same cursor, FETCHing `size` rows per round trip and yielding each
  // batch whole.
  streamBatches?(sql: string, params: unknown[], size: number): AsyncIterable<any[]>;
  /**
   * Hold one connection outside any transaction. Optional: needed only by
   * work that must span several autocommit statements on ONE connection —
   * a migration marked `-- forge:no-transaction` (for `CREATE INDEX
   * CONCURRENTLY`) holds a session advisory lock across its statements.
   */
  reserve?(): Promise<PgReservedSession>;
  /**
   * How a JSON value must be handed to this driver. `'text'` (node-postgres):
   * forge serialises it first. `'value'` (postgres.js): the driver asks the
   * server for each parameter's type and runs its own JSON.stringify on json
   * and jsonb, so a value forge had already turned into text was encoded a
   * second time and stored as a jsonb STRING. Absent means `'text'`.
   */
  readonly jsonParams?: 'text' | 'value';
  close(): Promise<void>;
}

// Monotonic id for cursor names — avoids Date.now() collisions on concurrent
// streams sharing a connection.
let _cursorSeq = 0;

/**
 * DECLARE / FETCH / CLOSE on a connection that is already in a transaction
 * (a cursor only lives inside one). Used for a stream inside the caller's
 * `$transaction`, so it reads what the transaction has written.
 */
export async function* cursorBatches(
  q: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> },
  sql: string,
  params: unknown[],
  size: number,
): AsyncIterable<any[]> {
  const name = `forge_stream_${(_cursorSeq++).toString(36)}`;
  await q.query(`DECLARE ${name} NO SCROLL CURSOR FOR ${sql}`, params);
  try {
    for (;;) {
      const { rows } = await q.query(`FETCH ${size} FROM ${name}`);
      if (rows.length) yield rows;
      if (rows.length < size) break;
    }
  } finally {
    await q.query(`CLOSE ${name}`).catch(() => {});
  }
}

// ─── node-postgres (pg) — the default driver ────────────────────────────────
export function pgDriver(pool: any): PostgresDriver {
  guardPoolErrors(pool, 'Postgres');
  const norm = (r: any) => ({ rows: r.rows, rowCount: r.rowCount ?? r.rows.length });
  return {
    kind: 'postgres',
    query: async (sql, params) => norm(await pool.query(sql, params)),
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: async (s, p) => norm(await client.query(s, p)),
          // No values → node-postgres uses the simple protocol, which is the
          // one that accepts several statements in one string.
          exec: async (s) => { await client.query(s); },
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* swallow */ }
        throw err;
      } finally {
        if (typeof client.release === 'function') client.release();
      }
    },
    stream: async function* (sql, params) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const name = `forge_stream_${(_cursorSeq++).toString(36)}`;
        await client.query(`DECLARE ${name} CURSOR FOR ${sql}`, params);
        for (;;) {
          const { rows } = await client.query(`FETCH 1000 FROM ${name}`);
          if (rows.length === 0) break;
          for (const r of rows) yield r;
          if (rows.length < 1000) break;
        }
        await client.query(`CLOSE ${name}`);
        await client.query('COMMIT');
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* swallow */ }
        throw err;
      } finally {
        client.release();
      }
    },
    streamBatches: async function* (sql, params, size) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        yield* cursorBatches({ query: (s: string, p?: unknown[]) => client.query(s, p) }, sql, params, size);
        await client.query('COMMIT');
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* swallow */ }
        throw err;
      } finally {
        client.release();
      }
    },
    reserve: async () => {
      const client = await pool.connect();
      return {
        query: async (s, p) => norm(await client.query(s, p)),
        exec: async (s) => { await client.query(s); },
        release: () => client.release(),
      };
    },
    close: async () => { await pool.end(); },
  };
}

// ─── postgres.js (porsager) ─────────────────────────────────────────────────
// Wrap a `postgres(url)` instance. `sql.unsafe(text, params)` runs a
// parameterised query and returns an array-like result carrying `.count`.
//
// unsafe() does not prepare unless asked: without `{ prepare: true }` every
// query was parsed and planned afresh, which ran at less than half the rate
// of postgres.js's own prepared queries. It follows the client's setting, so
// a client created with `prepare: false` (PgBouncer in transaction mode)
// still never prepares.
export function postgresJsDriver(sql: any): PostgresDriver {
  const prepare = sql?.options?.prepare !== false;
  const run = async (q: any, text: string, params?: unknown[]) => {
    const r = await q.unsafe(text, (params ?? []) as any[], { prepare });
    const rows = Array.from(r as any[]);
    return { rows, rowCount: (r.count ?? rows.length) as number };
  };
  // `.simple()` sends the text over the simple protocol, the only one that
  // takes several statements; `unsafe` alone prepares it and refuses them.
  const exec = async (q: any, text: string) => { await q.unsafe(text).simple(); };
  return {
    kind: 'postgres',
    jsonParams: 'value',
    query: (text, params) => run(sql, text, params),
    transaction: (fn) => sql.begin((txSql: any) =>
      fn({
        query: (text: string, params?: unknown[]) => run(txSql, text, params),
        exec: (text: string) => exec(txSql, text),
      })),
    // postgres.js 3.4+. Older releases have no reserve(), and then a
    // no-transaction migration says so instead of running on a pool.
    ...(typeof sql.reserve === 'function'
      ? {
          reserve: async () => {
            const r = await sql.reserve();
            return {
              query: (text: string, params?: unknown[]) => run(r, text, params),
              exec: (text: string) => exec(r, text),
              release: () => r.release(),
            };
          },
        }
      : {}),
    close: async () => { await sql.end({ timeout: 5 }); },
  };
}

export function isPostgresDriver(v: unknown): v is PostgresDriver {
  return !!v && typeof v === 'object' && (v as any).kind === 'postgres' &&
    typeof (v as any).query === 'function' && typeof (v as any).transaction === 'function';
}
