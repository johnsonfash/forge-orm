import type { AdapterKind } from '../types';

// PostgresDriver — the normalized port the Postgres adapter and executor talk
// to. node-postgres (`pg`) is the default; `postgres` (porsager/postgres.js) or
// any other client can be wrapped to the same shape. The executor only ever
// calls `query(sql, params)`, so a session and the pool are interchangeable.

export interface PgQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }>;
}

export interface PostgresDriver extends PgQueryable {
  readonly kind: Extract<AdapterKind, 'postgres'>;
  // Run `fn` in a transaction; the session it receives is a queryable bound to
  // the same connection (so every executor call inside lands on the txn).
  transaction<T>(fn: (session: PgQueryable) => Promise<T>): Promise<T>;
  // Optional server-side cursor stream. Absent → adapter materialises via query.
  stream?(sql: string, params: unknown[]): AsyncIterable<any>;
  close(): Promise<void>;
}

// Monotonic id for cursor names — avoids Date.now() collisions on concurrent
// streams sharing a connection.
let _cursorSeq = 0;

// ─── node-postgres (pg) — the default driver ────────────────────────────────
export function pgDriver(pool: any): PostgresDriver {
  const norm = (r: any) => ({ rows: r.rows, rowCount: r.rowCount ?? r.rows.length });
  return {
    kind: 'postgres',
    query: async (sql, params) => norm(await pool.query(sql, params)),
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: async (s, p) => norm(await client.query(s, p)) });
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
          const { rows } = await client.query(`FETCH 200 FROM ${name}`);
          if (rows.length === 0) break;
          for (const r of rows) yield r;
          if (rows.length < 200) break;
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
    close: async () => { await pool.end(); },
  };
}

// ─── postgres.js (porsager) ─────────────────────────────────────────────────
// Wrap a `postgres(url)` instance. `sql.unsafe(text, params)` runs a
// parameterised query and returns an array-like result carrying `.count`.
export function postgresJsDriver(sql: any): PostgresDriver {
  const run = async (q: any, text: string, params?: unknown[]) => {
    const r = await q.unsafe(text, (params ?? []) as any[]);
    const rows = Array.from(r as any[]);
    return { rows, rowCount: (r.count ?? rows.length) as number };
  };
  return {
    kind: 'postgres',
    query: (text, params) => run(sql, text, params),
    transaction: (fn) => sql.begin((txSql: any) =>
      fn({ query: (text: string, params?: unknown[]) => run(txSql, text, params) })),
    close: async () => { await sql.end({ timeout: 5 }); },
  };
}

export function isPostgresDriver(v: unknown): v is PostgresDriver {
  return !!v && typeof v === 'object' && (v as any).kind === 'postgres' &&
    typeof (v as any).query === 'function' && typeof (v as any).transaction === 'function';
}
