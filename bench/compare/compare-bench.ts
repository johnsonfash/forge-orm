/* eslint-disable no-console */
//
// compare-bench - Wave 5a 3-way comparison: forge vs Prisma vs Drizzle,
// per dialect, on the SAME four scenarios as bench/db-bench.ts:
//
//   1. findMany  (where role=EDITOR, orderBy email asc, take 20)
//   2. findFirst (by indexed unique email)
//   3. count     (where role=USER)
//   4. update    (set active=false by id)
//
// forge owns the schema: its DDL/migrate creates the physical users table and
// seeds it. Prisma and Drizzle are then pointed at the SAME database/table and
// run the identical scenario loops. The raw driver baseline is included too so
// every engine gets an overhead-relative-to-raw number.
//
// Auto-skips any dialect whose service/driver is down. Drizzle has no Mongo
// driver (n/a). Prisma 7 requires a driver-adapter package to connect; when
// none is installed the Prisma column is reported n/a with the reason.
//
// Invoked by bench/db-bench.ts when COMPARE=1 (see runCompare()).

import { createDb } from "../../src";
import { schema } from "../../src/schema";
import { buildSchemaDDL as buildPgDDL } from "../../src/adapters/postgres/ddl";
import { applyMigration as applyPgMigration } from "../../src/adapters/postgres/migrate";
import { buildSchemaDDL as buildMysqlDDL } from "../../src/adapters/mysql/ddl";
import { applyMigration as applyMysqlMigration } from "../../src/adapters/mysql/migrate";
import { buildSchemaDDL as buildSqliteDDL } from "../../src/adapters/sqlite/ddl";
import { applyMigration as applySqliteMigration } from "../../src/adapters/sqlite/migrate";
import { eq, asc, count as drizzleCount } from "drizzle-orm";
import { pgUsers, mysqlUsers, sqliteUsers } from "./drizzle-schema";

const BENCH_SEED = Number(process.env.BENCH_SEED ?? 500);
const BENCH_ITER = Number(process.env.BENCH_ITER ?? 200);
const STAMP = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

// ─── Sample / timing helpers (same maths as db-bench.ts) ────────────────────

export interface Sample { name: string; median: number; p95: number; opsPerSec: number }
// One engine column. `na` marks an engine that could not run (with a reason).
export interface Engine { label: string; samples?: Sample[]; na?: string }
// A dialect-level comparison result: the four scenario names plus one Engine
// per column (raw is always present as the baseline).
export interface CompareResult {
  dialect: string;
  scenarios: string[];
  raw: Engine;
  forge: Engine;
  prisma: Engine;
  drizzle: Engine;
}

function timeit(label: string, runs: number[]): Sample {
  const sorted = [...runs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const opsPerSec = 1000 / (median || Number.EPSILON);
  return { name: label, median, p95, opsPerSec };
}

async function timed(fn: () => Promise<unknown> | unknown): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

// Run the four scenarios `BENCH_ITER` times against a set of callables and
// return one Sample per scenario. `ops` maps scenario index -> async thunk;
// the per-iteration `idx` is supplied so each engine hits the same rows.
interface Ops {
  findMany: (idx: number) => Promise<unknown> | unknown;
  findFirst: (idx: number) => Promise<unknown> | unknown;
  count: (idx: number) => Promise<unknown> | unknown;
  update: (idx: number) => Promise<unknown> | unknown;
}

async function runOps(label: string, ops: Ops): Promise<Sample[]> {
  const a: number[] = [], b: number[] = [], c: number[] = [], d: number[] = [];
  for (let i = 0; i < BENCH_ITER; i++) {
    const idx = i % BENCH_SEED;
    a.push(await timed(() => ops.findMany(idx)));
    b.push(await timed(() => ops.findFirst(idx)));
    c.push(await timed(() => ops.count(idx)));
    d.push(await timed(() => ops.update(idx)));
  }
  return [
    timeit(`findMany [${label}]`, a),
    timeit(`findFirst [${label}]`, b),
    timeit(`count [${label}]`, c),
    timeit(`update [${label}]`, d),
  ];
}

const SCENARIOS = ["findMany", "findFirst", "count", "update"];

// forge scenario thunks are identical across dialects.
function forgeOps(db: any, sampleId: (idx: number) => string): Ops {
  return {
    findMany: () => db.user.findMany({ where: { role: "EDITOR" }, orderBy: { email: "asc" }, take: 20 }),
    findFirst: (idx) => db.user.findFirst({ where: { email: `bench${idx}@x.co` } }),
    count: () => db.user.count({ where: { role: "USER" } }),
    update: (idx) => db.user.update({ where: { id: sampleId(idx) }, data: { active: false } }),
  };
}
// ─── Prisma adapter availability ────────────────────────────────────────────
// Prisma 7 connects only via a driver-adapter package (or Accelerate). If the
// matching @prisma/adapter-* is not installed we cannot construct a client, so
// we surface a clear n/a reason instead of crashing the whole bench.
function prismaAdapterStatus(pkg: string): { ok: boolean; reason?: string } {
  try {
    require.resolve(pkg);
    require.resolve(`./generated/${pkg.includes("pg") ? "pg" : pkg.includes("sqlite") ? "sqlite" : "mysql"}`);
    return { ok: true };
  } catch {
    return { ok: false, reason: `driver-adapter ${pkg} or generated client not installed` };
  }
}

// ─── Postgres ───────────────────────────────────────────────────────────────

async function comparePg(): Promise<CompareResult | null> {
  if (process.env.SKIP_PG === "1") return null;
  try { require("pg"); } catch { return null; }

  const PG_ROOT = process.env.BENCH_PG_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
  const DB = `forge_bench_cmp_pg_${STAMP}`;
  const URL = PG_ROOT.replace(/\/[^/]*$/, `/${DB}`);

  const { Pool } = await import("pg");
  const rootPool = new (Pool as any)({ connectionString: PG_ROOT });
  try { await rootPool.query(`CREATE DATABASE "${DB}"`); } catch (e: any) { if (!/already exists/.test(e.message)) throw e; }
  finally { await rootPool.end(); }

  console.log(`[cmp:pg] database: ${DB}`);
  const db = await createDb({ url: URL });
  const pool = (db.adapter as any).pool;

  try {
    await applyPgMigration(pool, buildPgDDL(schema as any));
    const seed = Array.from({ length: BENCH_SEED }, (_, i) => ({
      id: `u_${i}`, email: `bench${i}@x.co`, name: `User ${i}`,
      role: i % 3 === 0 ? "EDITOR" : "USER",
    }));
    await db.user.createMany({ data: seed });

    const sampleId = (idx: number) => `u_${idx}`;

    // forge
    const forge = await runOps("forge", forgeOps(db, sampleId));

    // raw pg
    const raw = await runOps("raw pg", {
      findMany: () => pool.query(`SELECT * FROM "users" WHERE "role" = $1 ORDER BY "email" ASC LIMIT 20`, ["EDITOR"]),
      findFirst: (idx) => pool.query(`SELECT * FROM "users" WHERE "email" = $1 LIMIT 1`, [`bench${idx}@x.co`]),
      count: () => pool.query(`SELECT COUNT(*) FROM "users" WHERE "role" = $1`, ["USER"]),
      update: (idx) => pool.query(`UPDATE "users" SET "active" = $1 WHERE "id" = $2`, [false, `u_${idx}`]),
    });

    // drizzle (wraps forge pg pool - same connection pool, fairest baseline)
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const dz = drizzle(pool as any);
    const drizzleSamples = await runOps("drizzle", {
      findMany: () => dz.select().from(pgUsers).where(eq(pgUsers.role, "EDITOR")).orderBy(asc(pgUsers.email)).limit(20),
      findFirst: (idx) => dz.select().from(pgUsers).where(eq(pgUsers.email, `bench${idx}@x.co`)).limit(1),
      count: () => dz.select({ c: drizzleCount() }).from(pgUsers).where(eq(pgUsers.role, "USER")),
      update: (idx) => dz.update(pgUsers).set({ active: false }).where(eq(pgUsers.id, `u_${idx}`)),
    });

    // prisma
    const prismaEngine = await runPrismaPg(URL, sampleId);

    return {
      dialect: "postgres", scenarios: SCENARIOS,
      raw: { label: "raw pg", samples: raw },
      forge: { label: "forge", samples: forge },
      drizzle: { label: "drizzle", samples: drizzleSamples },
      prisma: prismaEngine,
    };
  } finally {
    await db.$disconnect();
    const cleanup = new (Pool as any)({ connectionString: PG_ROOT });
    await cleanup.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB]).catch(() => {});
    await cleanup.query(`DROP DATABASE IF EXISTS "${DB}"`).catch(() => {});
    await cleanup.end();
    console.log(`[cmp:pg] dropped ${DB}`);
  }
}

async function runPrismaPg(url: string, sampleId: (idx: number) => string): Promise<Engine> {
  let PrismaClient: any, PrismaPg: any;
  try {
    ({ PrismaClient } = require("./generated/pg"));
    ({ PrismaPg } = require("@prisma/adapter-pg"));
  } catch {
    return { label: "prisma", na: "Prisma 7 needs @prisma/adapter-pg + generated client (not installed)" };
  }
  try {
    const adapter = new PrismaPg({ connectionString: url });
    const prisma = new PrismaClient({ adapter });
    const samples = await runOps("prisma", {
      findMany: () => prisma.user.findMany({ where: { role: "EDITOR" }, orderBy: { email: "asc" }, take: 20 }),
      findFirst: (idx) => prisma.user.findFirst({ where: { email: `bench${idx}@x.co` } }),
      count: () => prisma.user.count({ where: { role: "USER" } }),
      update: (idx) => prisma.user.update({ where: { id: sampleId(idx) }, data: { active: false } }),
    });
    await prisma.$disconnect();
    return { label: "prisma", samples };
  } catch (e: any) {
    return { label: "prisma", na: `prisma error: ${e.message?.split("\n")[0] ?? e}` };
  }
}
// ─── MySQL ──────────────────────────────────────────────────────────────────

async function compareMysql(): Promise<CompareResult | null> {
  if (process.env.SKIP_MYSQL === "1") return null;
  try { require("mysql2"); } catch { return null; }

  const ROOT = process.env.BENCH_MYSQL_URL ?? "mysql://root@127.0.0.1:3306";
  const DB = `forge_bench_cmp_mysql_${STAMP}`;
  const URL = `${ROOT}/${DB}`;

  const mysql = require("mysql2/promise");
  const root = await mysql.createConnection({ uri: ROOT });
  try { await root.query(`CREATE DATABASE \`${DB}\``); }
  catch (e: any) { if (!/exists/.test(e.message)) throw e; }
  finally { await root.end(); }

  console.log(`[cmp:mysql] database: ${DB}`);
  const db = await createDb({ url: URL });
  const pool = (db.adapter as any).pool;

  try {
    await applyMysqlMigration(pool, buildMysqlDDL(schema as any));
    const seed = Array.from({ length: BENCH_SEED }, (_, i) => ({
      id: `u_${i}`, email: `bench${i}@x.co`, name: `User ${i}`,
      role: i % 3 === 0 ? "EDITOR" : "USER",
    }));
    await db.user.createMany({ data: seed });
    const sampleId = (idx: number) => `u_${idx}`;

    const forge = await runOps("forge", forgeOps(db, sampleId));

    const raw = await runOps("raw mysql", {
      findMany: () => pool.query("SELECT * FROM `users` WHERE `role` = ? ORDER BY `email` ASC LIMIT 20", ["EDITOR"]),
      findFirst: (idx) => pool.query("SELECT * FROM `users` WHERE `email` = ? LIMIT 1", [`bench${idx}@x.co`]),
      count: () => pool.query("SELECT COUNT(*) FROM `users` WHERE `role` = ?", ["USER"]),
      update: (idx) => pool.execute("UPDATE `users` SET `active` = ? WHERE `id` = ?", [0, `u_${idx}`]),
    });

    const { drizzle } = await import("drizzle-orm/mysql2");
    const dz = drizzle(pool as any, { mode: "default" } as any);
    const drizzleSamples = await runOps("drizzle", {
      findMany: () => dz.select().from(mysqlUsers).where(eq(mysqlUsers.role, "EDITOR")).orderBy(asc(mysqlUsers.email)).limit(20),
      findFirst: (idx) => dz.select().from(mysqlUsers).where(eq(mysqlUsers.email, `bench${idx}@x.co`)).limit(1),
      count: () => dz.select({ c: drizzleCount() }).from(mysqlUsers).where(eq(mysqlUsers.role, "USER")),
      update: (idx) => dz.update(mysqlUsers).set({ active: false }).where(eq(mysqlUsers.id, `u_${idx}`)),
    });

    const prismaEngine = await runPrismaMysql(URL, sampleId);

    return {
      dialect: "mysql", scenarios: SCENARIOS,
      raw: { label: "raw mysql", samples: raw },
      forge: { label: "forge", samples: forge },
      drizzle: { label: "drizzle", samples: drizzleSamples },
      prisma: prismaEngine,
    };
  } finally {
    await db.$disconnect();
    const cleanup = await mysql.createConnection({ uri: ROOT });
    await cleanup.query(`DROP DATABASE IF EXISTS \`${DB}\``).catch(() => {});
    await cleanup.end();
    console.log(`[cmp:mysql] dropped ${DB}`);
  }
}

async function runPrismaMysql(url: string, sampleId: (idx: number) => string): Promise<Engine> {
  let PrismaClient: any, PrismaMariaDb: any;
  try {
    ({ PrismaClient } = require("./generated/mysql"));
    ({ PrismaMariaDb } = require("@prisma/adapter-mariadb"));
  } catch {
    return { label: "prisma", na: "Prisma 7 needs @prisma/adapter-mariadb + generated client (not installed)" };
  }
  try {
    const adapter = new PrismaMariaDb({ url });
    const prisma = new PrismaClient({ adapter });
    const samples = await runOps("prisma", {
      findMany: () => prisma.user.findMany({ where: { role: "EDITOR" }, orderBy: { email: "asc" }, take: 20 }),
      findFirst: (idx) => prisma.user.findFirst({ where: { email: `bench${idx}@x.co` } }),
      count: () => prisma.user.count({ where: { role: "USER" } }),
      update: (idx) => prisma.user.update({ where: { id: sampleId(idx) }, data: { active: false } }),
    });
    await prisma.$disconnect();
    return { label: "prisma", samples };
  } catch (e: any) {
    return { label: "prisma", na: `prisma error: ${e.message?.split("\n")[0] ?? e}` };
  }
}
// ─── SQLite (shared on-disk file) ───────────────────────────────────────────
//
// Unlike db-bench.ts (which uses :memory:), the comparison uses a temp file so
// forge, Drizzle, and a separate Prisma client can all open the SAME database.
// Drizzle wraps forges already-open better-sqlite3 handle; Prisma (if its
// adapter were installed) would open the file by path.

async function compareSqlite(): Promise<CompareResult | null> {
  if (process.env.SKIP_SQLITE === "1") return null;
  try { require("better-sqlite3"); } catch { return null; }

  const os = require("os"); const path = require("path"); const fsMod = require("fs");
  const file = path.join(os.tmpdir(), `forge_bench_cmp_${STAMP}.db`);
  const URL = `sqlite:${file}`;
  console.log(`[cmp:sqlite] file database: ${file}`);

  const db = await createDb({ url: URL });
  const handle = (db.adapter as any).db;

  try {
    await applySqliteMigration(handle, buildSqliteDDL(schema as any));
    const seed = Array.from({ length: BENCH_SEED }, (_, i) => ({
      id: `u_${i}`, email: `bench${i}@x.co`, name: `User ${i}`,
      role: i % 3 === 0 ? "EDITOR" : "USER",
    }));
    await db.user.createMany({ data: seed });
    const sampleId = (idx: number) => `u_${idx}`;

    const forge = await runOps("forge", forgeOps(db, sampleId));

    const stmtFindMany = handle.prepare(`SELECT * FROM "users" WHERE "role" = ? ORDER BY "email" ASC LIMIT 20`);
    const stmtFindFirst = handle.prepare(`SELECT * FROM "users" WHERE "email" = ? LIMIT 1`);
    const stmtCount = handle.prepare(`SELECT COUNT(*) AS c FROM "users" WHERE "role" = ?`);
    const stmtUpdate = handle.prepare(`UPDATE "users" SET "active" = ? WHERE "id" = ?`);
    const raw = await runOps("raw sqlite", {
      findMany: () => stmtFindMany.all("EDITOR"),
      findFirst: (idx) => stmtFindFirst.get(`bench${idx}@x.co`),
      count: () => stmtCount.get("USER"),
      update: (idx) => stmtUpdate.run(0, `u_${idx}`),
    });

    const { drizzle } = await import("drizzle-orm/better-sqlite3");
    const dz = drizzle(handle as any);
    const drizzleSamples = await runOps("drizzle", {
      findMany: () => dz.select().from(sqliteUsers).where(eq(sqliteUsers.role, "EDITOR")).orderBy(asc(sqliteUsers.email)).limit(20).all(),
      findFirst: (idx) => dz.select().from(sqliteUsers).where(eq(sqliteUsers.email, `bench${idx}@x.co`)).limit(1).get(),
      count: () => dz.select({ c: drizzleCount() }).from(sqliteUsers).where(eq(sqliteUsers.role, "USER")).get(),
      update: (idx) => dz.update(sqliteUsers).set({ active: false }).where(eq(sqliteUsers.id, `u_${idx}`)).run(),
    });

    const prismaEngine = await runPrismaSqlite(file, sampleId);

    return {
      dialect: "sqlite", scenarios: SCENARIOS,
      raw: { label: "raw sqlite", samples: raw },
      forge: { label: "forge", samples: forge },
      drizzle: { label: "drizzle", samples: drizzleSamples },
      prisma: prismaEngine,
    };
  } finally {
    await db.$disconnect();
    for (const ext of ["", "-wal", "-shm"]) { try { fsMod.unlinkSync(file + ext); } catch { /* */ } }
    console.log(`[cmp:sqlite] dropped ${file}`);
  }
}

async function runPrismaSqlite(file: string, sampleId: (idx: number) => string): Promise<Engine> {
  let PrismaClient: any, PrismaBetterSQLite3: any;
  try {
    ({ PrismaClient } = require("./generated/sqlite"));
    ({ PrismaBetterSQLite3 } = require("@prisma/adapter-better-sqlite3"));
  } catch {
    return { label: "prisma", na: "Prisma 7 needs @prisma/adapter-better-sqlite3 + generated client (not installed)" };
  }
  try {
    const adapter = new PrismaBetterSQLite3({ url: `file:${file}` });
    const prisma = new PrismaClient({ adapter });
    const samples = await runOps("prisma", {
      findMany: () => prisma.user.findMany({ where: { role: "EDITOR" }, orderBy: { email: "asc" }, take: 20 }),
      findFirst: (idx) => prisma.user.findFirst({ where: { email: `bench${idx}@x.co` } }),
      count: () => prisma.user.count({ where: { role: "USER" } }),
      update: (idx) => prisma.user.update({ where: { id: sampleId(idx) }, data: { active: false } }),
    });
    await prisma.$disconnect();
    return { label: "prisma", samples };
  } catch (e: any) {
    return { label: "prisma", na: `prisma error: ${e.message?.split("\n")[0] ?? e}` };
  }
}
// ─── Mongo (forge + raw; drizzle n/a, prisma best-effort) ───────────────────

async function compareMongo(): Promise<CompareResult | null> {
  if (process.env.SKIP_MONGO === "1") return null;
  try { require("mongodb"); } catch { return null; }

  const DB = `forge_bench_cmp_mongo_${STAMP}`;
  const URL = (process.env.BENCH_MONGO_URL ?? "mongodb://127.0.0.1:27017") + `/${DB}`;
  console.log(`[cmp:mongo] database: ${DB}`);

  const db = await createDb({ url: URL });
  const { dbClient } = await import("../../src/adapters/mongo/client");
  const { pushAllIndexes } = await import("../../src/adapters/mongo/scripts/push");
  const usersColl = dbClient.db.collection("users");

  try {
    await pushAllIndexes();
    const seed = Array.from({ length: BENCH_SEED }, (_, i) => ({
      email: `bench${i}@x.co`, name: `User ${i}`, role: i % 3 === 0 ? "EDITOR" : "USER",
    }));
    await db.user.createMany({ data: seed });
    const sample: any = await db.user.findFirst({ where: { email: "bench0@x.co" } });
    const sampleObjId = sample.id;
    const sampleId = () => sampleObjId;

    const forge = await runOps("forge", forgeOps(db, sampleId));

    const { ObjectId } = await import("mongodb");
    const raw = await runOps("raw mongo", {
      findMany: () => usersColl.find({ role: "EDITOR" }).sort({ email: 1 }).limit(20).toArray(),
      findFirst: (idx) => usersColl.findOne({ email: `bench${idx}@x.co` }),
      count: () => usersColl.countDocuments({ role: "USER" }),
      update: () => usersColl.findOneAndUpdate({ _id: ObjectId.createFromHexString(sampleObjId) }, { $set: { active: false } }, { returnDocument: "after" }),
    });

    return {
      dialect: "mongo", scenarios: SCENARIOS,
      raw: { label: "raw mongo", samples: raw },
      forge: { label: "forge", samples: forge },
      drizzle: { label: "drizzle", na: "Drizzle has no MongoDB driver" },
      prisma: { label: "prisma", na: "Prisma 7 needs @prisma/adapter-mongodb (not installed)" },
    };
  } finally {
    try { await dbClient.db.dropDatabase(); } catch { /* */ }
    await db.$disconnect();
    console.log(`[cmp:mongo] dropped ${DB}`);
  }
}

// ─── Report ─────────────────────────────────────────────────────────────────

function fmtMs(n: number): string { return n.toFixed(2) + "ms"; }

function reportCompare(r: CompareResult): void {
  console.log(`\n  ${r.dialect.padEnd(10)} - ${BENCH_ITER} iter, ${BENCH_SEED} seed rows  (overhead = vs raw driver)`);
  const cols: Engine[] = [r.raw, r.forge, r.prisma, r.drizzle];
  // Header line per scenario block.
  for (let s = 0; s < r.scenarios.length; s++) {
    console.log(`  ${r.scenarios[s]}`);
    console.log(`  ${"engine".padEnd(12)} ${"median".padStart(10)} ${"p95".padStart(10)} ${"ops/s".padStart(10)} ${"overhead".padStart(10)}`);
    const rawMedian = r.raw.samples ? r.raw.samples[s].median : undefined;
    for (const eng of cols) {
      if (eng.na) {
        console.log(`  ${eng.label.padEnd(12)} ${"n/a".padStart(10)}   ${eng.na}`);
        continue;
      }
      const smp = eng.samples![s];
      let overhead = "";
      if (rawMedian != null && eng !== r.raw) {
        const ov = ((smp.median - rawMedian) / (rawMedian || Number.EPSILON)) * 100;
        overhead = (ov >= 0 ? "+" : "") + ov.toFixed(1) + "%";
      } else if (eng === r.raw) {
        overhead = "baseline";
      }
      console.log(`  ${eng.label.padEnd(12)} ${fmtMs(smp.median).padStart(10)} ${fmtMs(smp.p95).padStart(10)} ${smp.opsPerSec.toFixed(0).padStart(10)} ${overhead.padStart(10)}`);
    }
    console.log("");
  }
}

// ─── Entry ──────────────────────────────────────────────────────────────────

export async function runCompare(): Promise<void> {
  console.log(`forge compare-bench  seed=${BENCH_SEED} iter=${BENCH_ITER}`);
  console.log("  3-way: forge vs Prisma vs Drizzle, each vs the raw driver baseline");

  const pg = await comparePg().catch((e) => { console.log(`[cmp:pg] skipped: ${e.message}`); return null; });
  const mysql = await compareMysql().catch((e) => { console.log(`[cmp:mysql] skipped: ${e.message}`); return null; });
  const sqlite = await compareSqlite().catch((e) => { console.log(`[cmp:sqlite] skipped: ${e.message}`); return null; });
  const mongo = await compareMongo().catch((e) => { console.log(`[cmp:mongo] skipped: ${e.message}`); return null; });

  console.log("\n════════════════════════════════════════════════════════════════════════════");
  if (sqlite) reportCompare(sqlite);
  if (pg) reportCompare(pg);
  if (mysql) reportCompare(mysql);
  if (mongo) reportCompare(mongo);
  console.log("════════════════════════════════════════════════════════════════════════════\n");
}

// Allow running this file directly (node -r ts-node ... compare-bench.ts).
if (require.main === module) {
  runCompare().catch((err) => { console.error(err); process.exit(1); });
}
