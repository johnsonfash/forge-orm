// One scratch database per run: created here, seeded by forge, torn down in
// `close()` even when the run fails. Every engine is pointed at the same
// database; forge is given the very same native client the raw baseline
// uses (through its documented driver factories), so the two differ only by
// what forge does on top of the driver.

import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { createDb, pgDriver, mysql2Driver, betterSqlite3Driver, mongoDriver, duckdbDriver, mssqlDriver } from "../../../src";
import { Dialect } from "./core";
import { instrument, instrumentMongoClient } from "./instrument";
import * as S from "./schema";

export interface Features { geo: boolean; fts: boolean; tx: boolean; json: boolean; geoMode: "native" | "fallback" | "none" }

export interface DialectCtx {
  dialect: Dialect;
  sizes: S.SeedSizes;
  features: Features;
  /**
   * Bring the tables back to a steady state between scenarios (Postgres:
   * VACUUM ANALYZE), so a scenario's numbers do not depend on how many rows
   * the scenarios before it wrote and deleted.
   */
  settle?: () => Promise<void>;
  schema: S.BenchSchema;
  forge: any;
  // Native handles (whichever apply to the dialect).
  pg?: any;            // pg.Pool
  mysql?: any;         // mysql2/promise pool
  sqlite?: any;        // better-sqlite3 Database
  sqliteFile?: string;
  mongo?: { client: any; db: any; name: string };
  duck?: { instance: any; conn: any; file: string };
  mssql?: any;         // mssql ConnectionPool
  url: string;         // connection string to the scratch database (for engines that open their own pool)
  conn: Record<string, any>;  // parsed connection parts for engines that want them
  notes: string[];
  close(): Promise<void>;
}

const STAMP = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
export const POOL = 20;

export async function openDialect(dialect: Dialect, users: number, log: (s: string) => void): Promise<DialectCtx> {
  const sizes = S.sizesFor(users);
  switch (dialect) {
    case "postgres": return openPg(sizes, log);
    case "mysql": return openMysql(sizes, log);
    case "sqlite": return openSqlite(sizes, log);
    case "mongo": return openMongo(sizes, log);
    case "duckdb": return openDuck(sizes, log);
    case "mssql": return openMssql(sizes, log);
  }
}

async function seed(ctx: DialectCtx, log: (s: string) => void): Promise<void> {
  const db = ctx.forge, s = ctx.sizes;
  const chunked = async (model: string, rows: any[]) => {
    for (let i = 0; i < rows.length; i += 1000) await db[model].createMany({ data: rows.slice(i, i + 1000) });
  };
  const t0 = Date.now();
  await chunked("user", S.seedUsers(s));
  await chunked("profile", S.seedProfiles(s));
  await chunked("post", S.seedPosts(s));
  await chunked("comment", S.seedComments(s));
  await chunked("tag", S.seedTags(s));
  await chunked("postTag", S.seedPostTags(s));
  if (ctx.features.geo) await chunked("place", S.seedPlaces(s));
  log(`seeded ${s.users} users, ${s.posts} posts, ${s.comments} comments in ${Date.now() - t0}ms`);
}

// ─── Postgres ───────────────────────────────────────────────────────────────

async function openPg(sizes: S.SeedSizes, log: (s: string) => void): Promise<DialectCtx> {
  instrument("postgres");
  const { Pool } = require("pg");
  const ROOT = process.env.BENCH_PG_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
  const name = `forge_deep_${STAMP}`;
  const url = ROOT.replace(/\/[^/]*$/, `/${name}`);
  const root = new Pool({ connectionString: ROOT, max: 1 });
  await root.query(`CREATE DATABASE "${name}"`);
  await root.end();
  const pool = new Pool({ connectionString: url, max: POOL });
  const notes: string[] = [];
  const drop = async () => {
    await pool.end().catch(() => {});
    const c = new Pool({ connectionString: ROOT, max: 1 });
    await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]).catch(() => {});
    await c.query(`DROP DATABASE IF EXISTS "${name}"`).catch((e: any) => log(`drop failed: ${e.message}`));
    await c.end();
    log(`dropped database ${name}`);
  };
  try {
    let geoMode: Features["geoMode"] = "native";
    try { await pool.query("CREATE EXTENSION IF NOT EXISTS postgis"); }
    catch (e: any) { geoMode = "none"; notes.push(`PostGIS unavailable (${e.message.split("\n")[0]}): geo scenarios n/a`); }
    const schema = S.buildSchema({ geo: geoMode });
    const { buildSchemaDDL } = require("../../../src/adapters/postgres/ddl");
    const { applyMigration } = require("../../../src/adapters/postgres/migrate");
    const rep = await applyMigration(pool, buildSchemaDDL(schema as any));
    if (rep.failures?.length) throw new Error(`DDL failed: ${JSON.stringify(rep.failures)}`);
    const forge = await createDb({ schema, driver: pgDriver(pool) } as any);
    const u = new URL(url);
    const ctx: DialectCtx = {
      dialect: "postgres", sizes, schema, forge, pg: pool, url, notes,
      conn: { host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username) || "postgres", password: u.password ? decodeURIComponent(u.password) : undefined, database: name },
      features: { geo: geoMode !== "none", fts: true, tx: true, json: true, geoMode },
      close: drop,
      settle: async () => { await pool.query("VACUUM ANALYZE"); },
    };
    await seed(ctx, log);
    await pool.query("ANALYZE");
    return ctx;
  } catch (e) { await drop(); throw e; }
}

// ─── MySQL ──────────────────────────────────────────────────────────────────

async function openMysql(sizes: S.SeedSizes, log: (s: string) => void): Promise<DialectCtx> {
  instrument("mysql");
  const mysql = require("mysql2/promise");
  const ROOT = process.env.BENCH_MYSQL_URL ?? "mysql://root@127.0.0.1:3306";
  const name = `forge_deep_${STAMP}`;
  const url = `${ROOT.replace(/\/$/, "")}/${name}`;
  const root = await mysql.createConnection({ uri: ROOT });
  await root.query(`CREATE DATABASE \`${name}\``);
  await root.end();
  const pool = mysql.createPool({ uri: url, connectionLimit: POOL, supportBigNumbers: true });
  const drop = async () => {
    await pool.end().catch(() => {});
    const c = await mysql.createConnection({ uri: ROOT });
    await c.query(`DROP DATABASE IF EXISTS \`${name}\``).catch((e: any) => log(`drop failed: ${e.message}`));
    await c.end();
    log(`dropped database ${name}`);
  };
  try {
    const schema = S.buildSchema({ geo: "native" });
    const { buildSchemaDDL } = require("../../../src/adapters/mysql/ddl");
    const { applyMigration } = require("../../../src/adapters/mysql/migrate");
    const rep = await applyMigration(pool, buildSchemaDDL(schema as any));
    if (rep.failures?.length) throw new Error(`DDL failed: ${JSON.stringify(rep.failures)}`);
    const forge = await createDb({ schema, driver: mysql2Driver(pool) } as any);
    const u = new URL(url);
    const ctx: DialectCtx = {
      dialect: "mysql", sizes, schema, forge, mysql: pool, url, notes: [],
      conn: { host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username) || "root", password: u.password ? decodeURIComponent(u.password) : undefined, database: name },
      features: { geo: true, fts: true, tx: true, json: true, geoMode: "native" },
      close: drop,
    };
    await seed(ctx, log);
    return ctx;
  } catch (e) { await drop(); throw e; }
}

// ─── SQLite ─────────────────────────────────────────────────────────────────

async function openSqlite(sizes: S.SeedSizes, log: (s: string) => void): Promise<DialectCtx> {
  const Database = require("better-sqlite3");
  const file = path.join(os.tmpdir(), `forge_deep_${STAMP}.db`);
  const h = new Database(file);
  h.pragma("journal_mode = WAL");
  h.pragma("foreign_keys = ON");
  instrument("sqlite", { sqliteHandle: h });
  const drop = async () => {
    try { h.close(); } catch { /* already closed */ }
    for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(file + ext); } catch { /* */ } }
    log(`removed ${file}`);
  };
  try {
    // No SpatiaLite in a stock better-sqlite3 build, so geo runs in forge's
    // documented fallback mode (JSON column + Haversine refinement).
    const schema = S.buildSchema({ geo: "fallback" });
    const { buildSchemaDDL } = require("../../../src/adapters/sqlite/ddl");
    const { applyMigration } = require("../../../src/adapters/sqlite/migrate");
    const driver = betterSqlite3Driver(h);
    const rep = await applyMigration(driver, buildSchemaDDL(schema as any));
    if (rep.failures?.length) throw new Error(`DDL failed: ${JSON.stringify(rep.failures)}`);
    const forge = await createDb({ schema, driver } as any);
    const ctx: DialectCtx = {
      dialect: "sqlite", sizes, schema, forge, sqlite: h, sqliteFile: file, url: `file:${file}`, conn: { filename: file },
      notes: ["geo uses forge's fallback mode (no SpatiaLite): JSON column, bbox prefilter + Haversine"],
      features: { geo: true, fts: true, tx: true, json: true, geoMode: "fallback" },
      close: drop,
    };
    await seed(ctx, log);
    h.exec("ANALYZE");
    return ctx;
  } catch (e) { await drop(); throw e; }
}

// ─── MongoDB ────────────────────────────────────────────────────────────────

async function openMongo(sizes: S.SeedSizes, log: (s: string) => void): Promise<DialectCtx> {
  const { MongoClient } = require("mongodb");
  const base = process.env.BENCH_MONGO_URL ?? "mongodb://127.0.0.1:27017";
  const name = `forge_deep_${STAMP}`;
  const client = new MongoClient(base, { monitorCommands: true, maxPoolSize: POOL });
  await client.connect();
  instrumentMongoClient(client);
  const mdb = client.db(name);
  const drop = async () => {
    await mdb.dropDatabase().catch((e: any) => log(`drop failed: ${e.message}`));
    await client.close().catch(() => {});
    log(`dropped database ${name}`);
  };
  try {
    const notes: string[] = [];
    let tx = true;
    try {
      const hello = await client.db("admin").command({ hello: 1 });
      if (!hello.setName) { tx = false; notes.push("mongod is not a replica set: transaction scenarios n/a"); }
    } catch { tx = false; }
    const schema = S.buildSchema({ geo: "native" });
    const forge: any = await createDb({ schema, driver: mongoDriver(client, name) } as any);
    await forge.$migrate();
    const ctx: DialectCtx = {
      dialect: "mongo", sizes, schema, forge, mongo: { client, db: mdb, name }, url: `${base}/${name}`, conn: {}, notes,
      features: { geo: true, fts: true, tx, json: true, geoMode: "native" },
      close: drop,
    };
    await seed(ctx, log);
    return ctx;
  } catch (e) { await drop(); throw e; }
}

// ─── DuckDB ─────────────────────────────────────────────────────────────────

async function openDuck(sizes: S.SeedSizes, log: (s: string) => void): Promise<DialectCtx> {
  instrument("duckdb");
  const { DuckDBInstance } = require("@duckdb/node-api");
  const file = path.join(os.tmpdir(), `forge_deep_${STAMP}.duckdb`);
  const instance = await DuckDBInstance.create(file);
  const conn = await instance.connect();
  const drop = async () => {
    try { conn.closeSync?.(); } catch { /* */ }
    try { instance.closeSync?.(); } catch { /* */ }
    for (const ext of ["", ".wal"]) { try { fs.unlinkSync(file + ext); } catch { /* */ } }
    log(`removed ${file}`);
  };
  try {
    const notes: string[] = [];
    let geoMode: Features["geoMode"] = "native";
    try { await conn.run("INSTALL spatial"); await conn.run("LOAD spatial"); }
    catch (e: any) { geoMode = "none"; notes.push(`spatial extension unavailable (${e.message.split("\n")[0]}): geo n/a`); }
    let fts = true;
    try { await conn.run("INSTALL fts"); await conn.run("LOAD fts"); }
    catch (e: any) { fts = false; notes.push(`fts extension unavailable (${e.message.split("\n")[0]}): full-text n/a`); }
    const schema = S.buildSchema({ geo: geoMode });
    const { buildSchemaDDL } = require("../../../src/adapters/duckdb/ddl");
    const { applyMigration } = require("../../../src/adapters/duckdb/migrate");
    // The instance lets forge open a reader connection for findManyStream.
    const driver = duckdbDriver(conn, { instance });
    const rep = await applyMigration(driver, buildSchemaDDL(schema as any));
    if (rep.failures?.length) notes.push(`DDL failures: ${JSON.stringify(rep.failures).slice(0, 400)}`);
    const forge = await createDb({ schema, driver } as any);
    notes.push("DuckDB has no foreign-key cascades: cascade scenarios measure what each engine does itself");
    const ctx: DialectCtx = {
      dialect: "duckdb", sizes, schema, forge, duck: { instance, conn, file }, url: file, conn: { filename: file }, notes,
      features: { geo: geoMode !== "none", fts, tx: true, json: true, geoMode },
      close: drop,
    };
    await seed(ctx, log);
    // DuckDB's FTS index is a snapshot, built empty by the DDL; rebuild it now
    // that the rows exist.
    if (fts) {
      try { await conn.run(`PRAGMA create_fts_index('posts', 'id', 'body', overwrite = 1)`); }
      catch (e: any) { ctx.features.fts = false; notes.push(`fts index rebuild failed: ${e.message}`); }
    }
    return ctx;
  } catch (e) { await drop(); throw e; }
}

// ─── MSSQL ──────────────────────────────────────────────────────────────────

export function mssqlConfig(url: string): any {
  // mssql://user:password@host:port/database
  const u = new URL(url);
  return {
    server: u.hostname, port: Number(u.port || 1433),
    user: decodeURIComponent(u.username || "sa"), password: decodeURIComponent(u.password || ""),
    database: u.pathname.replace(/^\//, "") || "master",
    options: { encrypt: false, trustServerCertificate: true },
    pool: { max: POOL },
    // The default validates every acquired connection with a `SELECT 1`, an
    // extra round trip per query that no other engine pays.
    validateConnection: false,
  };
}

async function openMssql(sizes: S.SeedSizes, log: (s: string) => void): Promise<DialectCtx> {
  instrument("mssql");
  const sql = require("mssql");
  const ROOT = process.env.BENCH_MSSQL_URL ?? "mssql://sa:Forge_Bench_1@127.0.0.1:1433/master";
  const name = `forge_deep_${STAMP}`;
  const root = await new sql.ConnectionPool(mssqlConfig(ROOT)).connect();
  await root.request().query(`CREATE DATABASE [${name}]`);
  await root.close();
  const url = ROOT.replace(/\/[^/]*$/, `/${name}`);
  const pool = await new sql.ConnectionPool(mssqlConfig(url)).connect();
  const drop = async () => {
    await pool.close().catch(() => {});
    const c = await new sql.ConnectionPool(mssqlConfig(ROOT)).connect();
    await c.request().query(`ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}]`).catch((e: any) => log(`drop failed: ${e.message}`));
    await c.close();
    log(`dropped database ${name}`);
  };
  try {
    const schema = S.buildSchema({ geo: "native" });
    const { buildSchemaDDL } = require("../../../src/adapters/mssql/ddl");
    const { applyMigration } = require("../../../src/adapters/mssql/migrate");
    const driver = mssqlDriver(pool);
    const rep = await applyMigration(driver, buildSchemaDDL(schema as any));
    const notes: string[] = [];
    if (rep.failures?.length) notes.push(`DDL failures: ${JSON.stringify(rep.failures).slice(0, 400)}`);
    const forge = await createDb({ schema, driver } as any);
    const cfg = mssqlConfig(url);
    const ctx: DialectCtx = {
      dialect: "mssql", sizes, schema, forge, mssql: pool, url, conn: cfg,
      notes: [...notes, "MSSQL full-text needs a FULLTEXT CATALOG created out of band; fts runs only if one exists"],
      features: { geo: true, fts: false, tx: true, json: true, geoMode: "native" },
      close: drop,
    };
    await seed(ctx, log);
    return ctx;
  } catch (e) { await drop(); throw e; }
}
