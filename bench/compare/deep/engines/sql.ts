// A thin per-dialect SQL client for the raw baseline: positional `?` in, the
// driver's native placeholder out, rows back as plain objects. Plus the few
// fragments that genuinely differ between dialects. Nothing here is clever;
// it is what a competent hand-written data layer looks like.

import type { Dialect } from "../core";
import type { DialectCtx } from "../dialects";

export interface Sql {
  d: Dialect;
  all(sql: string, p?: unknown[]): Promise<any[]>;
  run(sql: string, p?: unknown[]): Promise<number>;
  tx<T>(fn: (c: Sql) => Promise<T>): Promise<T>;
  stream(sql: string, p: unknown[], onRow: (r: any) => void): Promise<void>;
}

const toDollar = (sql: string) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
const toAt = (sql: string) => { let i = 0; return sql.replace(/\?/g, () => `@p${++i}`); };

export function sqlClient(ctx: DialectCtx): Sql {
  switch (ctx.dialect) {
    case "postgres": return pgClient(ctx.pg);
    case "mysql": return mysqlClient(ctx.mysql);
    case "sqlite": return sqliteClient(ctx.sqlite);
    case "duckdb": return duckClient(ctx.duck!.conn);
    case "mssql": return mssqlClient(ctx.mssql);
    default: throw new Error(`no SQL client for ${ctx.dialect}`);
  }
}

function pgClient(pool: any, client?: any): Sql {
  const q = client ?? pool;
  const self: Sql = {
    d: "postgres",
    all: async (s, p = []) => (await q.query(toDollar(s), p)).rows,
    run: async (s, p = []) => (await q.query(toDollar(s), p)).rowCount ?? 0,
    tx: async (fn) => {
      if (client) return fn(self);
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const out = await fn(pgClient(pool, c));
        await c.query("COMMIT");
        return out;
      } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
      finally { c.release(); }
    },
    // A server-side cursor, fetched 1 000 rows at a time.
    stream: async (s, p, onRow) => {
      const c = client ?? await pool.connect();
      try {
        if (!client) await c.query("BEGIN");
        await c.query(`DECLARE bench_cur NO SCROLL CURSOR FOR ${toDollar(s)}`, p);
        for (;;) {
          const r = await c.query("FETCH 1000 FROM bench_cur");
          for (const row of r.rows) onRow(row);
          if (r.rows.length < 1000) break;
        }
        await c.query("CLOSE bench_cur");
        if (!client) await c.query("COMMIT");
      } finally { if (!client) c.release(); }
    },
  };
  return self;
}

function mysqlClient(pool: any, conn?: any): Sql {
  const q = conn ?? pool;
  const self: Sql = {
    d: "mysql",
    all: async (s, p = []) => (await q.query(s, p))[0],
    run: async (s, p = []) => (await q.query(s, p))[0].affectedRows ?? 0,
    tx: async (fn) => {
      if (conn) return fn(self);
      const c = await pool.getConnection();
      try {
        await c.beginTransaction();
        const out = await fn(mysqlClient(pool, c));
        await c.commit();
        return out;
      } catch (e) { await c.rollback().catch(() => {}); throw e; }
      finally { c.release(); }
    },
    stream: async (s, p, onRow) => {
      const c = conn ?? await pool.getConnection();
      try {
        await new Promise<void>((res, rej) => {
          c.connection.query(s, p).stream().on("data", onRow).on("end", () => res()).on("error", rej);
        });
      } finally { if (!conn) c.release(); }
    },
  };
  return self;
}

function sqliteClient(h: any): Sql {
  const cache = new Map<string, any>();
  const st = (s: string) => { let x = cache.get(s); if (!x) { x = h.prepare(s); cache.set(s, x); } return x; };
  const self: Sql = {
    d: "sqlite",
    all: async (s, p = []) => st(s).all(...p),
    run: async (s, p = []) => st(s).run(...p).changes,
    tx: async (fn) => {
      st("BEGIN").run();
      try { const out = await fn(self); st("COMMIT").run(); return out; }
      catch (e) { if (h.inTransaction) st("ROLLBACK").run(); throw e; }
    },
    stream: async (s, p, onRow) => { for (const r of st(s).iterate(...p)) onRow(r); },
  };
  return self;
}

function duckParams(p: unknown[]) {
  return p.map((v) => v instanceof Date ? v.toISOString() : v && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v);
}

function duckClient(conn: any): Sql {
  const self: Sql = {
    d: "duckdb",
    all: async (s, p = []) => (await conn.runAndReadAll(s, duckParams(p))).getRowObjectsJS(),
    run: async (s, p = []) => Number((await conn.run(s, duckParams(p))).rowsChanged ?? 0),
    tx: async (fn) => {
      await conn.run("BEGIN TRANSACTION");
      try { const out = await fn(self); await conn.run("COMMIT"); return out; }
      catch (e) { await conn.run("ROLLBACK").catch(() => {}); throw e; }
    },
    stream: async (s, p, onRow) => {
      const res = await conn.stream(s, duckParams(p));
      for await (const rows of res.yieldRowObjectJs()) for (const r of rows) onRow(r);
    },
  };
  return self;
}

function mssqlClient(pool: any, tx?: any): Sql {
  const req = (s: string, p: unknown[]) => {
    const r = (tx ?? pool).request();
    p.forEach((v, i) => r.input(`p${i + 1}`, v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v) ? JSON.stringify(v) : v));
    return r.query(toAt(s));
  };
  const self: Sql = {
    d: "mssql",
    all: async (s, p = []) => (await req(s, p)).recordset ?? [],
    run: async (s, p = []) => ((await req(s, p)).rowsAffected ?? []).reduce((a: number, b: number) => a + b, 0),
    tx: async (fn) => {
      if (tx) return fn(self);
      const sql = require("mssql");
      const t = new sql.Transaction(pool);
      await t.begin();
      try { const out = await fn(mssqlClient(pool, t)); await t.commit(); return out; }
      catch (e) { await t.rollback().catch(() => {}); throw e; }
    },
    stream: async (s, p, onRow) => {
      const r = (tx ?? pool).request();
      p.forEach((v, i) => r.input(`p${i + 1}`, v));
      r.stream = true;
      await new Promise<void>((res, rej) => { r.on("row", onRow); r.on("error", rej); r.on("done", () => res()); r.query(toAt(s)); });
    },
  };
  return self;
}

// ─── Fragments ──────────────────────────────────────────────────────────────

export function frag(d: Dialect) {
  const ms = d === "mssql";
  return {
    page: (limit: number, offset = 0) => ms ? `OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY` : `LIMIT ${limit}${offset ? ` OFFSET ${offset}` : ""}`,
    bool: (v: boolean) => (d === "mysql" || d === "sqlite" ? (v ? 1 : 0) : v),
    date: (x: Date) => (d === "sqlite" ? x.toISOString() : x),
    json: (v: unknown) => (d === "postgres" || d === "mysql" || d === "sqlite" || d === "mssql" ? JSON.stringify(v) : v),
    jsonStr: (col: string, key: string) =>
      d === "postgres" ? `${col}->>'${key}'`
      : d === "mysql" ? `${col}->>'$.${key}'`
      : d === "sqlite" ? `json_extract(${col}, '$.${key}')`
      : d === "duckdb" ? `json_extract_string(${col}, '$.${key}')`
      : `JSON_VALUE(${col}, '$.${key}')`,
    jsonNum: (col: string, key: string) =>
      d === "postgres" ? `(${col}->>'${key}')::numeric`
      : d === "mysql" ? `JSON_EXTRACT(${col}, '$.${key}')`
      : d === "sqlite" ? `json_extract(${col}, '$.${key}')`
      : d === "duckdb" ? `CAST(json_extract(${col}, '$.${key}') AS DOUBLE)`
      : `CAST(JSON_VALUE(${col}, '$.${key}') AS FLOAT)`,
    fts: (col: string) =>
      d === "postgres" ? `to_tsvector('simple', ${col}) @@ plainto_tsquery('simple', ?)`
      : d === "mysql" ? `MATCH(${col}) AGAINST (? IN NATURAL LANGUAGE MODE)`
      : d === "sqlite" ? `posts.rowid IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)`
      : d === "duckdb" ? `fts_main_posts.match_bm25(posts.id, ?) IS NOT NULL`
      : `CONTAINS(${col}, ?)`,
    returning: d === "postgres" || d === "sqlite" || d === "duckdb",
    ilike: (col: string) => `LOWER(${col}) LIKE ?`,
  };
}

export const PLACEHOLDERS = (n: number) => Array.from({ length: n }, () => "?").join(", ");
