import type { AdapterKind } from '../types';

// MysqlDriver — normalized port for the MySQL adapter. The executor speaks
// mysql2's tuple shape (`[rows, fields]` from query, `[result, fields]` from
// execute), so every wrapper returns that shape; the default mysql2 driver is
// essentially pass-through. A session and the driver are interchangeable (both
// implement query/execute).

export interface MysqlQueryable {
  query(sql: string, params?: unknown[]): Promise<[any, any]>;
  execute(sql: string, params?: unknown[]): Promise<[any, any]>;
}

export interface MysqlDriver extends MysqlQueryable {
  readonly kind: Extract<AdapterKind, 'mysql'>;
  transaction<T>(fn: (session: MysqlQueryable) => Promise<T>): Promise<T>;
  stream?(sql: string, params: unknown[]): AsyncIterable<any>;
  close(): Promise<void>;
}

// ─── mysql2 (default) ────────────────────────────────────────────────────────
// `pool` is a mysql2 PROMISE pool (created via createPool(...).promise()).
export function mysql2Driver(pool: any): MysqlDriver {
  return {
    kind: 'mysql',
    query: (sql, params) => pool.query(sql, params),
    execute: (sql, params) => pool.execute(sql, params),
    transaction: async (fn) => {
      const conn = await pool.getConnection();
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
    },
    stream: async function* (sql, params) {
      const conn = await pool.getConnection();
      try {
        const raw = (conn as any).connection ?? conn;
        const s: any = raw.query({ sql, values: params }).stream({ highWaterMark: 200 });
        for await (const row of s) yield row;
      } finally {
        if (typeof (conn as any).release === 'function') (conn as any).release();
      }
    },
    close: async () => { if (pool.end) await pool.end(); },
  };
}

// ─── mariadb (MariaDB Connector/Node) ───────────────────────────────────────
// mariadb's query returns rows directly (SELECT) or a result object
// ({ affectedRows, insertId }) for writes — normalise to mysql2 tuples.
export function mariadbDriver(pool: any): MysqlDriver {
  const asTuple = (r: any): [any, any] => [r, (r && r.meta) ?? undefined];
  const writeTuple = (r: any): [any, any] =>
    [{ affectedRows: r?.affectedRows ?? 0, insertId: r?.insertId != null ? Number(r.insertId) : undefined }, undefined];
  const sess = (conn: any): MysqlQueryable => ({
    query: async (sql, params) => asTuple(await conn.query(sql, params)),
    execute: async (sql, params) => writeTuple(await conn.query(sql, params)),
  });
  return {
    kind: 'mysql',
    query: async (sql, params) => asTuple(await pool.query(sql, params)),
    execute: async (sql, params) => writeTuple(await pool.query(sql, params)),
    transaction: async (fn) => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const result = await fn(sess(conn));
        await conn.commit();
        return result;
      } catch (err) {
        try { await conn.rollback(); } catch { /* swallow */ }
        throw err;
      } finally {
        if (typeof conn.release === 'function') conn.release();
      }
    },
    close: async () => { if (pool.end) await pool.end(); },
  };
}

// ─── PlanetScale serverless (@planetscale/database) ─────────────────────────
// HTTP-based; `conn.execute(sql, params)` → { rows, fields, rowsAffected, insertId }.
export function planetscaleDriver(conn: any): MysqlDriver {
  const readTuple = (r: any): [any, any] => [r.rows ?? [], r.fields];
  const writeTuple = (r: any): [any, any] =>
    [{ affectedRows: Number(r.rowsAffected ?? 0), insertId: r.insertId != null ? Number(r.insertId) : undefined }, r.fields];
  const sess = (tx: any): MysqlQueryable => ({
    query: async (sql, params) => readTuple(await tx.execute(sql, params)),
    execute: async (sql, params) => writeTuple(await tx.execute(sql, params)),
  });
  return {
    kind: 'mysql',
    query: async (sql, params) => readTuple(await conn.execute(sql, params)),
    execute: async (sql, params) => writeTuple(await conn.execute(sql, params)),
    transaction: (fn) => conn.transaction((tx: any) => fn(sess(tx))),
    close: async () => { /* stateless HTTP connection — nothing to close */ },
  };
}

export function isMysqlDriver(v: unknown): v is MysqlDriver {
  return !!v && typeof v === 'object' && (v as any).kind === 'mysql' &&
    typeof (v as any).query === 'function' && typeof (v as any).transaction === 'function';
}
