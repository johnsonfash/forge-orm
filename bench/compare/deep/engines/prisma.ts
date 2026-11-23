// Prisma 7 through its driver adapters. One implementation for Postgres, MySQL
// and SQLite; the generated client per dialect comes from
// `npm run forge:bench:deep:gen`.

import { RT } from "../core";
import type { EngineImpl } from "../core";
import { POOL, DialectCtx } from "../dialects";
import { params, postFields, postData, userData, wid } from "../scenarios";
import * as S from "../schema";
import { prismaLadder } from "../ladder";

export async function prismaEngine(ctx: DialectCtx): Promise<EngineImpl | { na: string }> {
  const d = ctx.dialect;
  if (d === "mongo") return { na: "Prisma 7 has no MongoDB support (still Prisma 6 only)" };
  if (d === "duckdb") return { na: "Prisma has no DuckDB provider" };
  if (d === "mssql") return { na: "needs @prisma/adapter-mssql + a sqlserver schema (not installed)" };

  const dir = d === "postgres" ? "pg" : d;
  let PrismaClient: any, adapter: any;
  try { ({ PrismaClient } = require(`../prisma/generated/${dir}`)); }
  catch { return { na: "generated client missing: run `npm run forge:bench:deep:gen`" }; }
  if (d === "postgres") {
    const { PrismaPg } = require("@prisma/adapter-pg");
    adapter = new PrismaPg({ connectionString: ctx.url, max: POOL });
  } else if (d === "mysql") {
    const { PrismaMariaDb } = require("@prisma/adapter-mariadb");
    const c = ctx.conn;
    adapter = new PrismaMariaDb({ host: c.host, port: c.port, user: c.user, password: c.password, database: c.database, connectionLimit: POOL, timezone: "Z" });
  } else {
    const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");
    adapter = new PrismaBetterSqlite3({ url: `file:${ctx.sqliteFile}` });
  }
  // mariadb (Prisma's MySQL adapter) has no prototype instrument.ts can wrap,
  // so on MySQL Prisma's own query event does the counting.
  const viaEvent = d === "mysql";
  const db = new PrismaClient({ adapter, log: viaEvent ? [{ emit: "event", level: "query" }] : [] });
  if (viaEvent) db.$on("query", (e: any) => RT.hit(e.query));
  await db.$connect();

  const P = params(ctx.sizes);
  const T = "prisma";
  const ci = (v: string) => (d === "postgres" ? { contains: v, mode: "insensitive" } : { contains: v });
  const jp = (k: string) => (d === "mysql" ? `$.${k}` : [k]);
  const na: Record<string, string> = {
    geo_near: "Prisma has no geo filters; users drop to $queryRaw",
    stream: "Prisma has no streaming read; findMany materialises the result",
  };
  if (d === "sqlite") {
    na.fts = "Prisma has no full-text filter on SQLite";
    na.json_prefs = na.json_meta = "Prisma has no JSON path filter on SQLite";
  }

  const ops: EngineImpl["ops"] = {
    pk: (i) => db.user.findUnique({ where: { id: P.pkUser(i) } }),
    unique_email: (i) => db.user.findUnique({ where: { email: P.emailUser(i) } }),
    filter_offset: () => db.user.findMany({
      where: { role: P.filterRole, active: true, created_at: { gte: P.filterFrom, lt: P.filterTo } },
      orderBy: [{ created_at: "desc" }, { id: "asc" }], skip: P.filterSkip, take: 20,
    }),
    // Prisma's cursor is inclusive, hence skip: 1.
    cursor: (i) => db.post.findMany({ orderBy: { id: "asc" }, cursor: { id: P.cursorAfter(i) }, skip: 1, take: 20 }),
    count_filter: () => db.post.count({ where: { status: "PUBLISHED", views: { gte: P.countMinViews } } }),
    exists: async (i) => (await db.user.findFirst({ where: { email: P.existsEmail(i) }, select: { id: true } })) !== null,
    select_cols: (i) => db.post.findMany({ where: { author_id: P.selectAuthor(i) }, select: { id: true, title: true, views: true }, orderBy: { id: "asc" } }),
    in_100: () => db.user.findMany({ where: { id: { in: P.in100 } }, select: { id: true, email: true } }),
    or_not_like: () => db.user.findMany({
      where: { OR: [{ name: ci(P.likeName) }, { email: { startsWith: P.likePrefix } }], NOT: { role: "ADMIN" } },
      orderBy: { id: "asc" }, take: 50,
    }),
    rel_some: () => db.user.findMany({ where: { posts: { some: { status: "PUBLISHED" } } }, select: { id: true }, orderBy: { id: "asc" }, take: 50 }),
    rel_none: () => db.user.findMany({ where: { posts: { none: { status: "PUBLISHED" } } }, select: { id: true }, orderBy: { id: "asc" }, take: 50 }),
    rel_every: () => db.user.findMany({ where: { posts: { every: { status: "PUBLISHED" } } }, select: { id: true }, orderBy: { id: "asc" }, take: 50 }),
    include_1: (_i, n) => db.post.findMany({ where: { status: "PUBLISHED" }, orderBy: { id: "asc" }, take: n, include: { author: true } }),
    include_2: (_i, n) => db.user.findMany({ orderBy: { id: "asc" }, take: n, include: { posts: { orderBy: { id: "asc" }, include: { comments: { orderBy: { id: "asc" } } } } } }),
    include_3: (_i, n) => db.user.findMany({
      where: { active: true }, orderBy: { id: "asc" }, take: n,
      include: { posts: {
        where: { status: "PUBLISHED" }, orderBy: [{ published_at: "desc" }, { id: "asc" }], take: 5,
        include: { comments: { orderBy: { id: "asc" }, take: 3, include: { author: { select: { id: true, email: true } } } } },
      } },
    }),
    m2m_post_tags: (_i, n) => db.post.findMany({ orderBy: { id: "asc" }, take: n, include: { post_tags: { include: { tag: true } } } }),
    m2m_tag_counts: () => db.tag.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { post_tags: true } } } }),
    count_rel: (_i, n) => db.user.findMany({ orderBy: { id: "asc" }, take: n, include: { _count: { select: { posts: true, comments: true } } } }),
    aggregate: () => db.post.aggregate({ where: { status: "PUBLISHED" }, _count: { _all: true }, _sum: { views: true }, _avg: { views: true }, _min: { views: true }, _max: { views: true } }),
    groupby: () => db.post.groupBy({
      by: ["author_id"], where: { status: { not: "DRAFT" } }, _count: { _all: true }, _sum: { views: true },
      having: { id: { _count: { gte: P.groupMinCount } } },
      orderBy: [{ _sum: { views: "desc" } }, { author_id: "asc" }], take: 20,
    }),
    distinct: () => db.post.findMany({ where: { views: { lt: P.distinctMaxViews } }, distinct: ["author_id"], select: { author_id: true }, orderBy: { author_id: "asc" } }),
    json_prefs: () => db.user.findMany({
      where: { AND: [{ prefs: { path: jp("theme"), equals: P.jsonTheme } }, { prefs: { path: jp("score"), gte: P.jsonMinScore } }] },
      select: { id: true }, orderBy: { id: "asc" }, take: 100,
    }),
    json_meta: () => db.post.count({ where: { AND: [{ meta: { path: jp("lang"), equals: P.metaLang } }, { meta: { path: jp("score"), gte: P.metaMinScore } }] } }),
    fts: () => db.post.findMany({ where: { body: { search: P.ftsTerm } }, select: { id: true }, orderBy: { id: "asc" }, take: 50 }),
    large_findmany: (_i, n) => db.post.findMany({ orderBy: { id: "asc" }, take: n }),

    create: (i) => db.user.create({ data: userData(wid(T, "create", i)) }),
    create_many: (i) => db.user.createMany({ data: Array.from({ length: 1000 }, (_, k) => ({ ...userData(`${wid(T, "cm", i)}_${k}`, wid(T, "cm", i)), role: "USER" })) }),
    nested_create: (i) => {
      const U = wid(T, "nc", i);
      const names = [...P.connectTags, wid(T, "nctag", i)];
      return db.user.create({ data: {
        ...userData(U),
        profile: { create: { id: `${U}_pr`, bio: "nested bio" } },
        posts: { create: [0, 1, 2].map((k) => ({
          ...postFields(`${U}_p${k}`, k),
          ...(k === 0 ? { post_tags: { create: names.map((name, j) => ({
            id: `${U}_p0_pt${j}`, tag: { connectOrCreate: { where: { name }, create: { id: `t_${U}_${j}`, name } } },
          })) } } : {}),
        })) },
      } });
    },
    update_by_id: (i) => db.user.update({ where: { id: P.updUser(i) }, data: { name: `Renamed ${i}` } }),
    update_many: (i) => db.post.updateMany({ where: { author_id: P.updManyAuthor(i) }, data: { views: 42 } }),
    increment_concurrent: (i) => Promise.all(Array.from({ length: 20 }, () => db.post.update({ where: { id: wid(T, "inc", i) }, data: { views: { increment: 1 } } }))),
    upsert_insert: (i) => { const id = wid(T, "ups", i); return db.user.upsert({ where: { email: `${id}@bench.dev` }, create: userData(id), update: { name: "Upserted" } }); },
    upsert_update: (i) => db.user.upsert({ where: { email: P.upsertUpdateEmail }, create: userData(wid(T, "upu", i)), update: { name: "Upserted 5" } }),
    delete_cascade: (i) => db.user.delete({ where: { id: wid(T, "dc", i) } }),
    delete_many: (i) => db.user.deleteMany({ where: { name: wid(T, "dm", i) } }),
    tx_interactive: (i) => db.$transaction(async (tx: any) => {
      const U = wid(T, "tx", i);
      await tx.user.create({ data: userData(U) });
      const p = await tx.post.create({ data: postData(`${U}_p`, U, 0) });
      const c = await tx.post.count({ where: { author_id: U } });
      await tx.user.update({ where: { id: U }, data: { name: `has ${c} posts` } });
      return tx.comment.create({ data: { id: `${U}_c`, post_id: p.id, author_id: U, parent_id: null, body: "tx", created_at: new Date(S.BASE_TIME) } });
    }),
    tx_rollback: async (i) => {
      try {
        await db.$transaction(async (tx: any) => { await tx.user.create({ data: userData(wid(T, "rb", i)) }); throw new Error("rollback"); });
      } catch (e: any) { if (e.message !== "rollback") throw e; }
      return null;
    },
    optimistic_update: async (i) => {
      const id = wid(T, "occ", i);
      const { version } = await db.post.findUnique({ where: { id }, select: { version: true } });
      const fresh = await db.post.updateMany({ where: { id, version }, data: { version: version + 1, title: "occ" } });
      const stale = await db.post.updateMany({ where: { id, version }, data: { version: version + 1, title: "stale" } });
      return { fresh: fresh.count, stale: stale.count };
    },
  };
  for (const k of Object.keys(na)) delete (ops as any)[k];
  Object.assign(ops, prismaLadder(db, T, d));
  if (d === "sqlite") na.json_fts_rel = "Prisma has no full-text or JSON path filter on SQLite";
  for (const k of Object.keys(na)) delete (ops as any)[k];
  return { ops, na, countsOwnQueries: viaEvent, close: () => db.$disconnect() };
}
