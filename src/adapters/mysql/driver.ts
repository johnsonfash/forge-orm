import type { AdapterKind } from '../types';
import { guardMysql2Pool, guardPoolErrors } from '../pool-errors';

// MysqlDriver — normalized port for the MySQL adapter. The executor speaks
// mysql2's tuple shape (`[rows, fields]` from query, `[result, fields]` from
// execute), so every wrapper returns that shape; the default mysql2 driver is
// essentially pass-through. A session and the driver are interchangeable (both
// implement query/execute).

export interface MysqlQueryable {
  query(sql: string, params?: unknown[]): Promise<[any, any]>;
  execute(sql: string, params?: unknown[]): Promise<[any, any]>;
}

/** A connection held for the caller alone until `release()`. */
export interface MysqlReservedSession extends MysqlQueryable {
  release(): Promise<void> | void;
}

export interface MysqlDriver extends MysqlQueryable {
  readonly kind: Extract<AdapterKind, 'mysql'>;
  transaction<T>(fn: (session: MysqlQueryable) => Promise<T>): Promise<T>;
  /**
   * Hold one connection outside any transaction. Optional; `forge migrate`
   * needs it, because MySQL's GET_LOCK belongs to the connection that took it.
   */
  reserve?(): Promise<MysqlReservedSession>;
  stream?(sql: string, params: unknown[]): AsyncIterable<any>;
  // The same stream, `size` rows at a time.
  streamBatches?(sql: string, params: unknown[], size: number): AsyncIterable<any[]>;
  close(): Promise<void>;
}

// ─── mysql2 (default) ────────────────────────────────────────────────────────
// `pool` is a mysql2 PROMISE pool (created via createPool(...).promise()).
//
// Every statement asks for `supportBigNumbers`, whatever the pool was built
// with: a BIGINT past 2^53 then arrives as an exact string (smaller ones stay
// numbers), and forge decodes it by field kind. Without it mysql2 rounds the
// value before forge sees it, and a pool the user built themselves could not
// read such a row at all.
const exact = (sql: string, params?: unknown[]) =>
  (params === undefined ? { sql, supportBigNumbers: true } : { sql, values: params, supportBigNumbers: true });

function exactQueryable(target: any): MysqlQueryable {
  return {
    query: (sql, params) => target.query(exact(sql, params)),
    execute: (sql, params) => target.execute(exact(sql, params)),
  };
}

export function mysql2Driver(pool: any): MysqlDriver {
  guardMysql2Pool(pool);
  return {
    kind: 'mysql',
    ...exactQueryable(pool),
    transaction: async (fn) => {
      const conn = await pool.getConnection();
      try {
        await conn.query('START TRANSACTION');
        const result = await fn(exactQueryable(conn));
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
        const s: any = raw.query({ ...exact(sql, params), values: params }).stream({ highWaterMark: 200 });
        for await (const row of s) yield row;
      } finally {
        if (typeof (conn as any).release === 'function') (conn as any).release();
      }
    },
    streamBatches: async function* (sql, params, size) {
      const conn = await pool.getConnection();
      try {
        const raw = (conn as any).connection ?? conn;
        const s: any = raw.query({ ...exact(sql, params), values: params }).stream({ highWaterMark: size });
        // Collected from 'data' events rather than the stream's own async
        // iterator, which costs a promise per row.
        let buf: any[] = [];
        let ended = false;
        let failed: unknown;
        let wake: (() => void) | undefined;
        const poke = () => { const w = wake; wake = undefined; w?.(); };
        s.on('data', (r: any) => { buf.push(r); if (buf.length >= size) { s.pause(); poke(); } });
        s.on('end', () => { ended = true; poke(); });
        s.on('error', (e: unknown) => { failed = e; poke(); });
        for (;;) {
          if (failed) throw failed;
          if (buf.length >= size || (ended && buf.length)) {
            const out = buf;
            buf = [];
            yield out;
            if (!ended) s.resume();
            continue;
          }
          if (ended) return;
          await new Promise<void>((r) => { wake = r; });
        }
      } finally {
        if (typeof (conn as any).release === 'function') (conn as any).release();
      }
    },
    reserve: async () => {
      const conn = await pool.getConnection();
      return { ...exactQueryable(conn), release: () => conn.release() };
    },
    close: async () => { if (pool.end) await pool.end(); },
  };
}

// ─── mariadb (MariaDB Connector/Node) ───────────────────────────────────────
// mariadb's query returns rows directly (SELECT) or a result object
// ({ affectedRows, insertId }) for writes — normalise to mysql2 tuples.
export function mariadbDriver(pool: any): MysqlDriver {
  guardPoolErrors(pool, 'MariaDB');
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
    reserve: async () => {
      const conn = await pool.getConnection();
      return { ...sess(conn), release: () => conn.release() };
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
