// forge: one implementation for every dialect, Mongo included. This is the
// code a forge user would write.

import type { EngineImpl } from "../core";
import type { DialectCtx } from "../dialects";
import { params, postData, postFields, userData, wid } from "../scenarios";
import * as S from "../schema";
import { forgeLadder } from "../ladder";

export async function forgeEngine(ctx: DialectCtx, db: any = ctx.forge): Promise<EngineImpl> {
  const P = params(ctx.sizes);
  const T = "forge";
  const na: Record<string, string> = {};
  if (!ctx.features.geo) na.geo_near = "no spatial support on this server";
  if (!ctx.features.fts) na.fts = "no full-text index on this server";
  if (!ctx.features.tx) { na.tx_interactive = na.tx_rollback = "transactions need a replica set"; }

  const ops: EngineImpl["ops"] = {
    pk: (i) => db.user.findUnique({ where: { id: P.pkUser(i) } }),
    unique_email: (i) => db.user.findUnique({ where: { email: P.emailUser(i) } }),
    filter_offset: () => db.user.findMany({
      where: { role: P.filterRole, active: true, created_at: { gte: P.filterFrom, lt: P.filterTo } },
      orderBy: [{ created_at: "desc" }, { id: "asc" }], skip: P.filterSkip, take: 20,
    }),
    cursor: (i) => db.post.findMany({ orderBy: { id: "asc" }, cursor: { id: P.cursorAfter(i) }, take: 20 }),
    count_filter: () => db.post.count({ where: { status: "PUBLISHED", views: { gte: P.countMinViews } } }),
    exists: async (i) => (await db.user.findFirst({ where: { email: P.existsEmail(i) }, select: { id: true } })) !== null,
    select_cols: (i) => db.post.findMany({ where: { author_id: P.selectAuthor(i) }, select: { id: true, title: true, views: true }, orderBy: { id: "asc" } }),
    in_100: () => db.user.findMany({ where: { id: { in: P.in100 } }, select: { id: true, email: true } }),
    or_not_like: () => db.user.findMany({
      where: {
        OR: [{ name: { contains: P.likeName, mode: "insensitive" } }, { email: { startsWith: P.likePrefix } }],
        NOT: { role: "ADMIN" },
      },
      orderBy: { id: "asc" }, take: 50,
    }),
    rel_some: () => db.user.findMany({ where: { posts: { some: { status: "PUBLISHED" } } }, select: { id: true }, orderBy: { id: "asc" }, take: 50 }),
    rel_none: () => db.user.findMany({ where: { posts: { none: { status: "PUBLISHED" } } }, select: { id: true }, orderBy: { id: "asc" }, take: 50 }),
    rel_every: () => db.user.findMany({ where: { posts: { every: { status: "PUBLISHED" } } }, select: { id: true }, orderBy: { id: "asc" }, take: 50 }),
    include_1: (_i, n) => db.post.findMany({ where: { status: "PUBLISHED" }, orderBy: { id: "asc" }, take: n, include: { author: true } }),
    // The include scenarios select the columns Kysely's versions select, so
    // every engine moves the same data.
    include_2: (_i, n) => db.user.findMany({
      orderBy: { id: "asc" }, take: n,
      include: { posts: { orderBy: { id: "asc" }, include: { comments: { orderBy: { id: "asc" }, select: { id: true, post_id: true, body: true } } } } },
    }),
    include_3: (_i, n) => db.user.findMany({
      where: { active: true }, orderBy: { id: "asc" }, take: n,
      include: { posts: {
        where: { status: "PUBLISHED" }, orderBy: [{ published_at: "desc" }, { id: "asc" }], take: 5,
        select: { id: true, title: true, published_at: true,
          comments: { orderBy: { id: "asc" }, take: 3, select: { id: true, author: { select: { id: true, email: true } } } } },
      } },
    }),
    m2m_post_tags: (_i, n) => db.post.findMany({ orderBy: { id: "asc" }, take: n,
      select: { id: true, title: true, post_tags: { select: { id: true, tag: { select: { id: true, name: true } } } } } }),
    m2m_tag_counts: () => db.tag.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { post_tags: true } } } }),
    count_rel: (_i, n) => db.user.findMany({ orderBy: { id: "asc" }, take: n, include: { _count: { select: { posts: true, comments: true } } } }),
    aggregate: () => db.post.aggregate({
      where: { status: "PUBLISHED" },
      _count: { _all: true }, _sum: { views: true }, _avg: { views: true }, _min: { views: true }, _max: { views: true },
    }),
    groupby: () => db.post.groupBy({
      by: ["author_id"], where: { status: { not: "DRAFT" } },
      _count: { _all: true }, _sum: { views: true },
      having: { _count: { _all: { gte: P.groupMinCount } } },
      orderBy: [{ _sum: { views: "desc" } }, { author_id: "asc" }], take: 20,
    }),
    distinct: () => db.post.findMany({ where: { views: { lt: P.distinctMaxViews } }, distinct: ["author_id"], select: { author_id: true }, orderBy: { author_id: "asc" } }),
    json_prefs: () => db.user.findMany({
      where: { AND: [{ prefs: { path: "theme", eq: P.jsonTheme } }, { prefs: { path: "score", gte: P.jsonMinScore } }] },
      select: { id: true }, orderBy: { id: "asc" }, take: 100,
    }),
    json_meta: () => db.post.count({ where: { AND: [{ meta: { path: "lang", eq: P.metaLang } }, { meta: { path: "score", gte: P.metaMinScore } }] } }),
    fts: () => db.post.findMany({ where: { body: { search: P.ftsTerm } }, select: { id: true }, orderBy: { id: "asc" }, take: 50 }),
    geo_near: () => db.place.findMany({
      where: { location: { near: { ...S.GEO_CENTER, withinMeters: P.geoRadius } } },
      orderBy: { location: { nearTo: S.GEO_CENTER } }, take: 20,
    }),
    large_findmany: (_i, n) => db.post.findMany({ orderBy: { id: "asc" }, take: n }),
    stream: async (_i, n) => {
      let count = 0, views = 0, first: string | undefined, last: string | undefined;
      for await (const r of db.post.findManyStream({ orderBy: { id: "asc" }, take: n })) {
        count++; views += Number(r.views); first ??= r.id; last = r.id;
      }
      return { count, first, last, views };
    },

    // Kysely and Knex insert and hand back their own input; so does this.
    create: async (i) => { const u = userData(wid(T, "create", i)); await db.user.create({ data: u, select: false }); return u; },
    create_many: (i) => db.user.createMany({ data: Array.from({ length: 1000 }, (_, k) => ({ ...userData(`${wid(T, "cm", i)}_${k}`, wid(T, "cm", i)), role: "USER" })) }),
    nested_create: (i) => {
      const U = wid(T, "nc", i);
      return db.user.create({ data: {
        ...userData(U),
        profiles: { create: { id: `${U}_pr`, bio: "nested bio" } },
        posts: { create: [0, 1, 2].map((k) => ({
          ...postFields(`${U}_p${k}`, k),
          ...(k === 0 ? { post_tags: { create: [...P.connectTags, wid(T, "nctag", i)].map((name, j) => ({
            id: `${U}_p0_pt${j}`,
            tag: { connectOrCreate: { where: { name }, create: { id: `t_${U}_${j}`, name } } },
          })) } } : {}),
        })) },
      }, select: false });
    },
    // Kysely and Knex hand back id, name and email; so does this.
    update_by_id: (i) => db.user.update({ where: { id: P.updUser(i) }, data: { name: `Renamed ${i}` }, select: { id: true, name: true, email: true } }),
    update_many: (i) => db.post.updateMany({ where: { author_id: P.updManyAuthor(i) }, data: { views: 42 } }),
    increment_concurrent: (i) => Promise.all(Array.from({ length: 20 }, () =>
      db.post.update({ where: { id: wid(T, "inc", i) }, data: { views: { increment: 1 } }, select: false }))),
    upsert_insert: (i) => {
      const id = wid(T, "ups", i);
      return db.user.upsert({ where: { email: `${id}@bench.dev` }, create: userData(id), update: { name: "Upserted" }, select: false });
    },
    upsert_update: (i) => db.user.upsert({ where: { email: P.upsertUpdateEmail }, create: userData(wid(T, "upu", i)), update: { name: "Upserted 5" }, select: false }),
    delete_cascade: (i) => db.user.delete({ where: { id: wid(T, "dc", i) }, select: false }),
    delete_many: (i) => db.user.deleteMany({ where: { name: wid(T, "dm", i) } }),
    tx_interactive: (i) => db.$transaction(async (tx: any) => {
      const U = wid(T, "tx", i);
      await tx.user.create({ data: userData(U), select: false });
      await tx.post.create({ data: postData(`${U}_p`, U, 0), select: false });
      const c = await tx.post.count({ where: { author_id: U } });
      await tx.user.update({ where: { id: U }, data: { name: `has ${c} posts` }, select: false });
      await tx.comment.create({ data: { id: `${U}_c`, post_id: `${U}_p`, author_id: U, parent_id: null, body: "tx", created_at: new Date(S.BASE_TIME) }, select: false });
      return c;
    }),
    tx_rollback: async (i) => {
      try {
        await db.$transaction(async (tx: any) => {
          await tx.user.create({ data: userData(wid(T, "rb", i)), select: false });
          throw new Error("rollback");
        });
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
  Object.assign(ops, forgeLadder(db, T));
  if (!ctx.features.tx) na.tx_mixed = na.tx_interactive;
  for (const k of Object.keys(na)) delete (ops as any)[k];
  return { ops, na, close: async () => {} };
}
