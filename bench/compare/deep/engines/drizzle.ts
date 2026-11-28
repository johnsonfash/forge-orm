// Drizzle ORM 0.45: the core query builder for flat reads and writes, the
// relational query API (`db.query.*.findMany({ with })`) for includes, and the
// `sql` template where Drizzle has no operator (JSON paths, full-text).

import { and, asc, avg, count, desc, eq, exists, getTableColumns, gt, gte, ilike, inArray, isNull, like, lt, max, min, ne, not, notExists, or, sql, sum } from "drizzle-orm";
import { drizzleLadder } from "../ladder";
import type { EngineImpl } from "../core";
import { POOL, DialectCtx } from "../dialects";
import * as DS from "../drizzle-schema";
import { params, postData, userData, wid } from "../scenarios";
import * as S from "../schema";
import { frag } from "./sql";

export async function drizzleEngine(ctx: DialectCtx): Promise<EngineImpl | { na: string }> {
  const d = ctx.dialect;
  if (d === "mongo") return { na: "Drizzle has no MongoDB support" };
  if (d === "duckdb") return { na: "Drizzle has no official DuckDB driver" };
  if (d === "mssql") return { na: "drizzle-orm 0.45 has no SQL Server dialect" };

  const schema: any = d === "postgres" ? DS.pg : d === "mysql" ? DS.mysql : DS.sqlite;
  let db: any;
  if (d === "postgres") db = (await import("drizzle-orm/node-postgres")).drizzle(ctx.pg, { schema });
  else if (d === "mysql") db = (await import("drizzle-orm/mysql2")).drizzle(ctx.mysql, { schema, mode: "default" });
  else db = (await import("drizzle-orm/better-sqlite3")).drizzle(ctx.sqlite, { schema });
  void POOL;

  const { users, profiles, posts, comments, tags, postTags } = schema;
  const P = params(ctx.sizes);
  const F = frag(d);
  const T = "drizzle";
  const sqlite = d === "sqlite";
  const hasReturning = d !== "mysql";
  // A fragment written with `?` placeholders, bound as Drizzle params.
  const frg = (text: string, ...vals: unknown[]) => {
    const parts = text.split("?");
    let out = sql.raw(parts[0]);
    for (let k = 1; k < parts.length; k++) out = sql`${out}${vals[k - 1]}${sql.raw(parts[k])}`;
    return out;
  };
  const affected = (r: any) => Number(r?.rowCount ?? r?.[0]?.affectedRows ?? r?.changes ?? 0);
  const outerUserId = sql.raw(d === "mysql" ? "`users`.`id`" : `"users"."id"`);
  const ci = (col: any, v: string) => (d === "postgres" ? ilike(col, `%${v}%`) : like(col, `%${v}%`));

  const na: Record<string, string> = {
    geo_near: "Drizzle has no geo operators; it would be the same hand-written SQL as raw",
  };
  if (d !== "mysql") na.stream = `Drizzle's ${d === "postgres" ? "node-postgres" : "better-sqlite3"} driver has no row iterator`;
  if (!ctx.features.fts) na.fts = "no full-text index on this server";

  const nestedCreateRows = (i: number) => {
    const U = wid(T, "nc", i);
    const names = [...P.connectTags, wid(T, "nctag", i)];
    return { U, names, user: userData(U), posts: [0, 1, 2].map((k) => postData(`${U}_p${k}`, U, k)), newTags: names.map((name, j) => ({ id: `t_${U}_${j}`, name })) };
  };

  const ops: EngineImpl["ops"] = {
    pk: async (i) => (await db.select().from(users).where(eq(users.id, P.pkUser(i))).limit(1))[0] ?? null,
    unique_email: async (i) => (await db.select().from(users).where(eq(users.email, P.emailUser(i))).limit(1))[0] ?? null,
    filter_offset: () => db.select().from(users)
      .where(and(eq(users.role, P.filterRole), eq(users.active, true), gte(users.created_at, P.filterFrom), lt(users.created_at, P.filterTo)))
      .orderBy(desc(users.created_at), asc(users.id)).limit(20).offset(P.filterSkip),
    cursor: (i) => db.select().from(posts).where(gt(posts.id, P.cursorAfter(i))).orderBy(asc(posts.id)).limit(20),
    count_filter: () => db.$count(posts, and(eq(posts.status, "PUBLISHED"), gte(posts.views, P.countMinViews))),
    exists: async (i) => (await db.select({ id: users.id }).from(users).where(eq(users.email, P.existsEmail(i))).limit(1)).length > 0,
    select_cols: (i) => db.select({ id: posts.id, title: posts.title, views: posts.views }).from(posts).where(eq(posts.author_id, P.selectAuthor(i))).orderBy(asc(posts.id)),
    in_100: () => db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, P.in100)),
    or_not_like: () => db.select().from(users)
      .where(and(or(ci(users.name, P.likeName), like(users.email, `${P.likePrefix}%`)), not(eq(users.role, "ADMIN"))))
      .orderBy(asc(users.id)).limit(50),
    rel_some: () => db.select({ id: users.id }).from(users)
      .where(exists(db.select({ x: sql`1` }).from(posts).where(and(eq(posts.author_id, users.id), eq(posts.status, "PUBLISHED")))))
      .orderBy(asc(users.id)).limit(50),
    rel_none: () => db.select({ id: users.id }).from(users)
      .where(notExists(db.select({ x: sql`1` }).from(posts).where(and(eq(posts.author_id, users.id), eq(posts.status, "PUBLISHED")))))
      .orderBy(asc(users.id)).limit(50),
    rel_every: () => db.select({ id: users.id }).from(users)
      .where(notExists(db.select({ x: sql`1` }).from(posts).where(and(eq(posts.author_id, users.id), ne(posts.status, "PUBLISHED")))))
      .orderBy(asc(users.id)).limit(50),
    include_1: (_i, n) => db.query.posts.findMany({ where: eq(posts.status, "PUBLISHED"), orderBy: [asc(posts.id)], limit: n, with: { author: true } }),
    include_2: (_i, n) => db.query.users.findMany({
      orderBy: [asc(users.id)], limit: n,
      with: { posts: { orderBy: [asc(posts.id)], with: { comments: { orderBy: [asc(comments.id)] } } } },
    }),
    include_3: (_i, n) => db.query.users.findMany({
      where: eq(users.active, true), orderBy: [asc(users.id)], limit: n,
      with: { posts: {
        where: eq(posts.status, "PUBLISHED"), orderBy: [desc(posts.published_at), asc(posts.id)], limit: 5,
        with: { comments: { orderBy: [asc(comments.id)], limit: 3, with: { author: { columns: { id: true, email: true } } } } },
      } },
    }),
    m2m_post_tags: (_i, n) => db.query.posts.findMany({ orderBy: [asc(posts.id)], limit: n, with: { post_tags: { with: { tag: true } } } }),
    m2m_tag_counts: async () => (await db.select({ id: tags.id, name: tags.name, n: count(postTags.id) }).from(tags)
      .leftJoin(postTags, eq(postTags.tag_id, tags.id)).groupBy(tags.id, tags.name).orderBy(asc(tags.name)))
      .map((r: any) => ({ ...r, _count: { post_tags: r.n } })),
    // Drizzle renders a column of the single FROM table unqualified, which
    // inside a correlated subquery binds to the subquery's own table; the outer
    // reference has to be spelled out.
    count_rel: async (_i, n) => (await db.select({
      ...getTableColumns(users),
      pc: sql<number>`(select count(*) from posts p where p.author_id = ${outerUserId})`,
      cc: sql<number>`(select count(*) from comments c where c.author_id = ${outerUserId})`,
    }).from(users).orderBy(asc(users.id)).limit(n)).map((r: any) => ({ ...r, _count: { posts: r.pc, comments: r.cc } })),
    aggregate: async () => {
      const [r] = await db.select({ n: count(), s: sum(posts.views), a: avg(posts.views), mn: min(posts.views), mx: max(posts.views) })
        .from(posts).where(eq(posts.status, "PUBLISHED"));
      return { _count: { _all: r.n }, _sum: { views: r.s }, _avg: { views: r.a }, _min: { views: r.mn }, _max: { views: r.mx } };
    },
    groupby: async () => (await db.select({ author_id: posts.author_id, n: count(), s: sum(posts.views) }).from(posts)
      .where(ne(posts.status, "DRAFT")).groupBy(posts.author_id).having(gte(count(), P.groupMinCount))
      .orderBy(desc(sum(posts.views)), asc(posts.author_id)).limit(20))
      .map((r: any) => ({ author_id: r.author_id, _count: { _all: r.n }, _sum: { views: r.s } })),
    distinct: () => db.selectDistinct({ author_id: posts.author_id }).from(posts).where(lt(posts.views, P.distinctMaxViews)).orderBy(asc(posts.author_id)),
    json_prefs: () => db.select({ id: users.id }).from(users)
      .where(and(frg(`${F.jsonStr("prefs", "theme")} = ?`, P.jsonTheme), frg(`${F.jsonNum("prefs", "score")} >= ?`, P.jsonMinScore)))
      .orderBy(asc(users.id)).limit(100),
    ci_equals: (i) => db.select({ id: users.id }).from(users).where(frg(`LOWER(email) = LOWER(?)`, P.ciEmail(i))).orderBy(asc(users.id)).limit(1),
    json_ci: () => db.select({ id: users.id }).from(users).where(frg(`LOWER(${F.jsonStr("prefs", "theme")}) = LOWER(?)`, P.jsonThemeCi)).orderBy(asc(users.id)).limit(100),
    json_meta: () => db.$count(posts, and(frg(`${F.jsonStr("meta", "lang")} = ?`, P.metaLang), frg(`${F.jsonNum("meta", "score")} >= ?`, P.metaMinScore))),
    fts: () => db.select({ id: posts.id }).from(posts).where(frg(F.fts("body"), P.ftsTerm)).orderBy(asc(posts.id)).limit(50),
    large_findmany: (_i, n) => db.select().from(posts).orderBy(asc(posts.id)).limit(n),
    stream: async (_i, n) => {
      let count = 0, views = 0, first: string | undefined, last: string | undefined;
      const it = db.select().from(posts).orderBy(asc(posts.id)).limit(n).iterator();
      for await (const r of it) { count++; views += Number(r.views); first ??= r.id; last = r.id; }
      return { count, first, last, views };
    },

    create: async (i) => {
      const u = userData(wid(T, "create", i));
      if (hasReturning) return (await db.insert(users).values(u).returning())[0];
      await db.insert(users).values(u);
      return u;
    },
    create_many: async (i) => ({ count: affected(await db.insert(users).values(Array.from({ length: 1000 }, (_, k) => ({ ...userData(`${wid(T, "cm", i)}_${k}`, wid(T, "cm", i)), role: "USER" })))) }),
    nested_create: (i) => {
      const r = nestedCreateRows(i);
      const tagInsert = (tx: any) => d === "mysql" ? tx.insert(tags).ignore().values(r.newTags) : tx.insert(tags).values(r.newTags).onConflictDoNothing({ target: tags.name });
      const link = (found: any[]) => {
        const byName = new Map(found.map((t: any) => [t.name, t.id]));
        return r.names.map((name, j) => ({ id: `${r.U}_p0_pt${j}`, post_id: `${r.U}_p0`, tag_id: byName.get(name) }));
      };
      if (sqlite) {
        // better-sqlite3 transactions are synchronous in Drizzle.
        return db.transaction((tx: any) => {
          tx.insert(users).values(r.user).run();
          tx.insert(profiles).values({ id: `${r.U}_pr`, user_id: r.U, bio: "nested bio" }).run();
          tx.insert(posts).values(r.posts).run();
          tagInsert(tx).run();
          tx.insert(postTags).values(link(tx.select().from(tags).where(inArray(tags.name, r.names)).all())).run();
          return { id: r.U };
        });
      }
      return db.transaction(async (tx: any) => {
        await tx.insert(users).values(r.user);
        await tx.insert(profiles).values({ id: `${r.U}_pr`, user_id: r.U, bio: "nested bio" });
        await tx.insert(posts).values(r.posts);
        await tagInsert(tx);
        await tx.insert(postTags).values(link(await tx.select().from(tags).where(inArray(tags.name, r.names))));
        return { id: r.U };
      });
    },
    update_by_id: async (i) => {
      const id = P.updUser(i);
      const q = db.update(users).set({ name: `Renamed ${i}` }).where(eq(users.id, id));
      if (hasReturning) return (await q.returning({ id: users.id, name: users.name, email: users.email }))[0];
      await q;
      return (await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, id)))[0];
    },
    update_many: async (i) => ({ count: affected(await db.update(posts).set({ views: 42 }).where(eq(posts.author_id, P.updManyAuthor(i)))) }),
    increment_concurrent: (i) => Promise.all(Array.from({ length: 20 }, () =>
      db.update(posts).set({ views: sql`${posts.views} + 1` }).where(eq(posts.id, wid(T, "inc", i))))),
    upsert_insert: (i) => {
      const u = userData(wid(T, "ups", i));
      return d === "mysql" ? db.insert(users).values(u).onDuplicateKeyUpdate({ set: { name: "Upserted" } })
        : db.insert(users).values(u).onConflictDoUpdate({ target: users.email, set: { name: "Upserted" } });
    },
    upsert_update: (i) => {
      const u = { ...userData(wid(T, "upu", i)), email: P.upsertUpdateEmail };
      return d === "mysql" ? db.insert(users).values(u).onDuplicateKeyUpdate({ set: { name: "Upserted 5" } })
        : db.insert(users).values(u).onConflictDoUpdate({ target: users.email, set: { name: "Upserted 5" } });
    },
    delete_cascade: (i) => db.delete(users).where(eq(users.id, wid(T, "dc", i))),
    delete_many: async (i) => ({ count: affected(await db.delete(users).where(eq(users.name, wid(T, "dm", i)))) }),
    tx_interactive: (i) => {
      const U = wid(T, "tx", i);
      const comment = { id: `${U}_c`, post_id: `${U}_p`, author_id: U, parent_id: null, body: "tx", created_at: new Date(S.BASE_TIME) };
      if (sqlite) return db.transaction((tx: any) => {
        tx.insert(users).values(userData(U)).run();
        tx.insert(posts).values(postData(`${U}_p`, U, 0)).run();
        const [{ n }] = tx.select({ n: count() }).from(posts).where(eq(posts.author_id, U)).all();
        tx.update(users).set({ name: `has ${n} posts` }).where(eq(users.id, U)).run();
        tx.insert(comments).values(comment).run();
        return n;
      });
      return db.transaction(async (tx: any) => {
        await tx.insert(users).values(userData(U));
        await tx.insert(posts).values(postData(`${U}_p`, U, 0));
        const n = await tx.$count(posts, eq(posts.author_id, U));
        await tx.update(users).set({ name: `has ${n} posts` }).where(eq(users.id, U));
        await tx.insert(comments).values(comment);
        return n;
      });
    },
    tx_rollback: async (i) => {
      try {
        if (sqlite) db.transaction((tx: any) => { tx.insert(users).values(userData(wid(T, "rb", i))).run(); throw new Error("rollback"); });
        else await db.transaction(async (tx: any) => { await tx.insert(users).values(userData(wid(T, "rb", i))); throw new Error("rollback"); });
      } catch (e: any) { if (e.message !== "rollback") throw e; }
      return null;
    },
    optimistic_update: async (i) => {
      const id = wid(T, "occ", i);
      const [{ version }] = await db.select({ version: posts.version }).from(posts).where(eq(posts.id, id));
      const fresh = affected(await db.update(posts).set({ version: version + 1, title: "occ" }).where(and(eq(posts.id, id), eq(posts.version, version))));
      const stale = affected(await db.update(posts).set({ version: version + 1, title: "stale" }).where(and(eq(posts.id, id), eq(posts.version, version))));
      return { fresh, stale };
    },
  };
  for (const k of Object.keys(na)) delete (ops as any)[k];
  Object.assign(ops, drizzleLadder({ db, d, F, T, schema, frg, affected, ops: { and, asc, avg, count, desc, eq, exists, gte, isNull, ne, not, or, sql, sum } }));
  for (const key of Object.keys(na)) delete (ops as any)[key];
  return { ops, na, close: async () => {} };
}
