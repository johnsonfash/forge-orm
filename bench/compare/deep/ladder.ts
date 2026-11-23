// The difficulty ladder: the rungs the original catalogue was missing, from a
// nested relation filter to a transaction that mixes every kind of write and
// rolls back. Each scenario fixes the semantics here; every engine expresses
// it in its own idiomatic way below. Same rules as scenarios.ts: write
// scenarios own their rows (ids embed the engine tag) and their before /
// after / check hooks run through forge with counting paused.
//
//   reads   rel_deep          AND / OR / NOT over relation filters two levels deep
//           include_count     3-level include, per-level where / orderBy / take, _count at two levels
//           groupby_rel       groupBy with having, three aggregates and a relation filter
//           json_fts_rel      full-text AND a JSON path AND a JSON path on the related row
//                             (geo cannot join them: no table here carries all three)
//   writes  delete_by_id      delete one childless row by id, return it
//           update_many_rel   updateMany through a relation filter
//           delete_many_rel   deleteMany through two relation filters (is + none)
//           nested_update     one call: rename the parent, update one child, upsert two
//                             (update path + create path), delete the rest by a filter
//           upsert_loop       10 sequential upserts, half updates, half inserts
//           tx_mixed          create, createMany, updateMany, upsert, delete and a count in
//                             one interactive transaction that then rolls back

import { C } from "./core";
import { groupInto, indexBy } from "./core";
import type { DialectCtx } from "./dialects";
import type { Scenario } from "./scenarios";
import { postFields, userData, wid } from "./scenarios";
import * as S from "./schema";

const ids = (rows: any[]) => rows.map((r) => C.s(r.id ?? r._id));
const fixUser = (id: string, extra: any = {}) => ({
  id, email: `${id}@bench.dev`, name: `Fixture ${id}`, role: "USER", active: true,
  created_at: new Date(S.BASE_TIME), prefs: { theme: "light", lang: "en", notify: false, score: 1 }, ...extra,
});
const fixPost = (id: string, author: string, views: number) => ({
  id, author_id: author, title: `Fixture ${id}`, body: "fixture body", status: "DRAFT", views, version: 0,
  published_at: null, created_at: new Date(S.BASE_TIME), meta: { lang: "en", score: 1, flags: [] },
});
async function rmTree(ctx: DialectCtx, userIds: string[]) {
  const db = ctx.forge;
  const pids = (await db.post.findMany({ where: { author_id: { in: userIds } }, select: { id: true } })).map((p: any) => p.id);
  if (pids.length) {
    await db.postTag.deleteMany({ where: { post_id: { in: pids } } });
    await db.comment.deleteMany({ where: { post_id: { in: pids } } });
    await db.post.deleteMany({ where: { id: { in: pids } } });
  }
  await db.comment.deleteMany({ where: { author_id: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

export const DEEP = { minGroup: 5, theme: "dark", lang: "fr", term: "kilo" };
export const NU = (tag: string, i: number) => {
  const U = wid(tag, "nu", i);
  return { U, p: [0, 1, 2, 3].map((k) => `${U}_p${k}`), pNew: `${U}_pn` };
};
export const UL = (tag: string, i: number) => Array.from({ length: 10 }, (_, k) => `${wid(tag, "ul", i)}_${k}`);
export const TXM = (tag: string, i: number) => {
  const U = wid(tag, "txm", i);
  return { U, posts: [0, 1, 2].map((k) => `${U}_p${k}`), tag: `t_${U}` };
};

export const LADDER: Scenario[] = [
  { name: "rel_deep", kind: "read", desc: "active users with (a published post that has an anonymous comment OR role ADMIN) AND NOT every post a draft, ORDER BY id LIMIT 50", canon: ids },
  { name: "include_count", kind: "read", n: 10, probe: [5, 20],
    desc: "active users LIMIT n + _count posts -> posts(published, most viewed first, take 3) + _count comments -> comments(by id, take 2, id + author email)",
    canon: (rows: any[]) => rows.map((u) => ({
      id: C.s(u.id ?? u._id), n: C.n(u._count?.posts),
      posts: (u.posts ?? []).map((p: any) => ({
        id: C.s(p.id ?? p._id), n: C.n(p._count?.comments),
        comments: (p.comments ?? []).map((c: any) => ({ id: C.s(c.id ?? c._id), author: c.author ? C.s(c.author.email) : null })),
      })),
    })) },
  { name: "groupby_rel", kind: "read",
    desc: "non-draft posts of active USER authors GROUP BY author HAVING count >= 5: count, sum, avg views, ORDER BY sum DESC, author LIMIT 20",
    canon: (rows: any[]) => rows.map((r) => ({ author_id: C.s(r.author_id), count: C.n(r._count?._all), sum: C.n(r._sum?.views), avg: C.r(r._avg?.views, 2) })) },
  { name: "json_fts_rel", kind: "read", needs: ["fts", "json"],
    desc: "posts matching 'kilo' AND meta.lang = 'fr' AND the author's prefs.theme = 'dark', ORDER BY id LIMIT 50", canon: ids },

  { name: "delete_by_id", kind: "write", desc: "delete one user with no children by id, return it",
    before: (ctx, tag, i) => ctx.forge.user.create({ data: fixUser(wid(tag, "dbi", i)) }),
    after: (ctx, tag, i) => ctx.forge.user.deleteMany({ where: { id: wid(tag, "dbi", i) } }),
    canon: (r: any) => ({ id: C.s(r?.id ?? r?._id), email: C.s(r?.email) }) },
  { name: "update_many_rel", kind: "write", desc: "updateMany the posts whose author has a given email (5 rows), return the count",
    before: async (ctx, tag, i) => {
      const U = wid(tag, "umr", i);
      await ctx.forge.user.create({ data: fixUser(U) });
      await ctx.forge.post.createMany({ data: [0, 1, 2, 3, 4].map((k) => fixPost(`${U}_p${k}`, U, k)) });
    },
    check: async (ctx, tag, i) => ctx.forge.post.count({ where: { author_id: wid(tag, "umr", i), views: 7 } }),
    after: (ctx, tag, i) => rmTree(ctx, [wid(tag, "umr", i)]),
    canon: C.n },
  { name: "delete_many_rel", kind: "write", desc: "deleteMany the posts whose author has a given email AND that have no comments (2 of 4), return the count",
    before: async (ctx, tag, i) => {
      const U = wid(tag, "dmr", i);
      await ctx.forge.user.create({ data: fixUser(U) });
      await ctx.forge.post.createMany({ data: [0, 1, 2, 3].map((k) => fixPost(`${U}_p${k}`, U, k)) });
      await ctx.forge.comment.createMany({ data: [0, 1].map((k) => ({ id: `${U}_c${k}`, post_id: `${U}_p${k}`, author_id: null, parent_id: null, body: "x", created_at: new Date(S.BASE_TIME) })) });
    },
    check: async (ctx, tag, i) => ctx.forge.post.count({ where: { author_id: wid(tag, "dmr", i) } }),
    after: (ctx, tag, i) => rmTree(ctx, [wid(tag, "dmr", i)]),
    canon: C.n },
  { name: "nested_update", kind: "write",
    desc: "one call: rename a user, update one post, upsert one existing post and one new one, delete the posts with views >= 3",
    before: async (ctx, tag, i) => {
      const n = NU(tag, i);
      await ctx.forge.user.create({ data: fixUser(n.U) });
      await ctx.forge.post.createMany({ data: n.p.map((id, k) => fixPost(id, n.U, k)) });
    },
    check: async (ctx, tag, i) => {
      const n = NU(tag, i);
      const u = await ctx.forge.user.findUnique({ where: { id: n.U } });
      const posts = await ctx.forge.post.findMany({ where: { author_id: n.U }, orderBy: { id: "asc" } });
      return { name: u?.name, posts: posts.map((p: any) => ({ id: p.id.slice(n.U.length), title: p.title, views: p.views })) };
    },
    after: (ctx, tag, i) => rmTree(ctx, [NU(tag, i).U]),
    canon: (v: any) => v },
  { name: "upsert_loop", kind: "write", desc: "10 sequential upserts by email: 5 hit existing users (update), 5 insert",
    before: (ctx, tag, i) => ctx.forge.user.createMany({ data: UL(tag, i).slice(0, 5).map((id) => fixUser(id)) }),
    check: async (ctx, tag, i) => (await ctx.forge.user.findMany({ where: { id: { in: UL(tag, i) } }, orderBy: { id: "asc" } }))
      .map((u: any) => u.name),
    after: (ctx, tag, i) => ctx.forge.user.deleteMany({ where: { id: { in: UL(tag, i) } } }),
    canon: (v: any) => v },
  { name: "tx_mixed", kind: "write", needs: ["tx"],
    desc: "one transaction: create a user, createMany 3 posts, updateMany them, upsert a tag, delete a post, count; then throw: nothing may remain",
    check: async (ctx, tag, i) => {
      const t = TXM(tag, i);
      return {
        users: await ctx.forge.user.count({ where: { id: t.U } }),
        posts: await ctx.forge.post.count({ where: { id: { in: t.posts } } }),
        tags: await ctx.forge.tag.count({ where: { name: t.tag } }),
      };
    },
    after: async (ctx, tag, i) => { const t = TXM(tag, i); await rmTree(ctx, [t.U]); await ctx.forge.tag.deleteMany({ where: { name: t.tag } }); },
    canon: (v: any) => v },
];

// ─── forge ──────────────────────────────────────────────────────────────────

export function forgeLadder(db: any, T: string): Record<string, (i: number, n: number) => Promise<unknown>> {
  return {
    rel_deep: () => db.user.findMany({
      where: {
        active: true,
        OR: [{ posts: { some: { status: "PUBLISHED", comments: { some: { author_id: null } } } } }, { role: "ADMIN" }],
        NOT: { posts: { every: { status: "DRAFT" } } },
      },
      select: { id: true }, orderBy: { id: "asc" }, take: 50,
    }),
    include_count: (_i, n) => db.user.findMany({
      where: { active: true }, orderBy: { id: "asc" }, take: n,
      include: {
        _count: { select: { posts: true } },
        posts: {
          where: { status: "PUBLISHED" }, orderBy: [{ views: "desc" }, { id: "asc" }], take: 3,
          include: {
            _count: { select: { comments: true } },
            comments: { orderBy: { id: "asc" }, take: 2, select: { id: true, author: { select: { id: true, email: true } } } },
          },
        },
      },
    }),
    groupby_rel: () => db.post.groupBy({
      by: ["author_id"], where: { status: { not: "DRAFT" }, author: { is: { active: true, role: "USER" } } },
      _count: { _all: true }, _sum: { views: true }, _avg: { views: true },
      having: { _count: { _all: { gte: DEEP.minGroup } } },
      orderBy: [{ _sum: { views: "desc" } }, { author_id: "asc" }], take: 20,
    }),
    json_fts_rel: () => db.post.findMany({
      where: { body: { search: DEEP.term }, meta: { path: "lang", eq: DEEP.lang }, author: { is: { prefs: { path: "theme", eq: DEEP.theme } } } },
      select: { id: true }, orderBy: { id: "asc" }, take: 50,
    }),
    delete_by_id: (i) => db.user.delete({ where: { id: wid(T, "dbi", i) } }),
    update_many_rel: (i) => db.post.updateMany({ where: { author: { is: { email: `${wid(T, "umr", i)}@bench.dev` } } }, data: { views: 7 } }),
    delete_many_rel: (i) => db.post.deleteMany({ where: { author: { is: { email: `${wid(T, "dmr", i)}@bench.dev` } }, comments: { none: {} } } }),
    nested_update: (i) => {
      const n = NU(T, i);
      return db.user.update({ where: { id: n.U }, data: {
        name: "Nested update",
        posts: {
          update: [{ where: { id: n.p[0] }, data: { title: "Updated 0" } }],
          upsert: [
            { where: { id: n.p[1] }, create: postFields(n.p[1], 1), update: { views: 11 } },
            { where: { id: n.pNew }, create: postFields(n.pNew, 9), update: { views: 0 } },
          ],
          deleteMany: { views: { gte: 3 } },
        },
      } });
    },
    upsert_loop: async (i) => {
      let k = 0;
      for (const id of UL(T, i)) {
        await db.user.upsert({ where: { email: `${id}@bench.dev` }, create: { ...fixUser(id), name: `Loop ${k}` }, update: { name: `Loop ${k}` } });
        k++;
      }
      return k;
    },
    tx_mixed: async (i) => {
      const t = TXM(T, i);
      try {
        await db.$transaction(async (tx: any) => {
          await tx.user.create({ data: userData(t.U) });
          await tx.post.createMany({ data: t.posts.map((id, k) => fixPost(id, t.U, k)) });
          await tx.post.updateMany({ where: { author_id: t.U }, data: { views: 5 } });
          await tx.tag.upsert({ where: { name: t.tag }, create: { id: t.tag, name: t.tag }, update: {} });
          await tx.post.delete({ where: { id: t.posts[2] } });
          await tx.post.count({ where: { author_id: t.U } });
          throw new Error("rollback");
        });
      } catch (e: any) { if (e.message !== "rollback") throw e; }
      return null;
    },
  };
}

// ─── raw SQL ────────────────────────────────────────────────────────────────

export function rawLadder(o: {
  c: any; d: string; F: any; Q: (n: number) => string; T: string;
  USER_COLS: string; POST_COLS: string; userVals: (u: any) => unknown[]; postVals: (p: any) => unknown[];
}): Record<string, (i: number, n: number) => Promise<unknown>> {
  const { c, d, F, Q, T, USER_COLS, POST_COLS, userVals, postVals } = o;
  const avg = d === "mssql" ? "AVG(CAST(p.views AS FLOAT))" : "AVG(p.views)";
  const idList = (rows: any[], k = "id") => [...new Set(rows.map((r) => r[k]).filter((v) => v != null))];
  const upsertUser = (u: any, name: string) => {
    const v = userVals(u);
    if (d === "mysql") return c.run(`INSERT INTO users (${USER_COLS}) VALUES (${Q(7)}) ON DUPLICATE KEY UPDATE name = ?`, [...v, name]);
    return c.run(`INSERT INTO users (${USER_COLS}) VALUES (${Q(7)}) ON CONFLICT (email) DO UPDATE SET name = ?`, [...v, name]);
  };
  const upsertPost = (cl: any, p: any, views: number) => d === "mysql"
    ? cl.run(`INSERT INTO posts (${POST_COLS}) VALUES (${Q(10)}) ON DUPLICATE KEY UPDATE views = ?`, [...postVals(p), views])
    : cl.run(`INSERT INTO posts (${POST_COLS}) VALUES (${Q(10)}) ON CONFLICT (id) DO UPDATE SET views = ?`, [...postVals(p), views]);
  const fpost = (id: string, author: string, views: number) => ({ ...fixPost(id, author, views) });
  return {
    rel_deep: () => c.all(
      `SELECT u.id FROM users u WHERE u.active = ?
         AND (EXISTS (SELECT 1 FROM posts p WHERE p.author_id = u.id AND p.status = ?
                        AND EXISTS (SELECT 1 FROM comments c WHERE c.post_id = p.id AND c.author_id IS NULL))
              OR u.role = ?)
         AND EXISTS (SELECT 1 FROM posts p2 WHERE p2.author_id = u.id AND p2.status <> ?)
       ORDER BY u.id ${F.page(50)}`, [F.bool(true), "PUBLISHED", "ADMIN", "DRAFT"]),
    include_count: async (_i, n) => {
      const users = await c.all(`SELECT ${USER_COLS.split(", ").map((x) => `u.${x}`).join(", ")}, (SELECT COUNT(*) FROM posts p WHERE p.author_id = u.id) AS pc
        FROM users u WHERE u.active = ? ORDER BY u.id ${F.page(n)}`, [F.bool(true)]);
      for (const u of users) u._count = { posts: u.pc };
      const uid = idList(users);
      const posts = uid.length ? await c.all(
        `SELECT ${POST_COLS}, cc FROM (SELECT ${POST_COLS.split(", ").map((x) => `p.${x}`).join(", ")},
            (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS cc,
            ROW_NUMBER() OVER (PARTITION BY p.author_id ORDER BY p.views DESC, p.id ASC) AS rn
          FROM posts p WHERE p.author_id IN (${Q(uid.length)}) AND p.status = ?) x WHERE rn <= 3 ORDER BY author_id, rn`, [...uid, "PUBLISHED"]) : [];
      for (const p of posts) p._count = { comments: p.cc };
      const pid = idList(posts);
      const comments = pid.length ? await c.all(
        `SELECT id, post_id, author_id FROM (SELECT id, post_id, author_id, ROW_NUMBER() OVER (PARTITION BY post_id ORDER BY id) AS rn
           FROM comments WHERE post_id IN (${Q(pid.length)})) x WHERE rn <= 2 ORDER BY post_id, id`, pid) : [];
      const aid = idList(comments, "author_id");
      const authors = aid.length ? indexBy(await c.all(`SELECT id, email FROM users WHERE id IN (${Q(aid.length)})`, aid), (x: any) => x.id) : new Map();
      for (const cm of comments) cm.author = cm.author_id ? authors.get(cm.author_id) ?? null : null;
      groupInto(posts, comments, (x: any) => x.id, (x: any) => x.post_id, "comments");
      return groupInto(users, posts, (x: any) => x.id, (x: any) => x.author_id, "posts");
    },
    groupby_rel: async () => (await c.all(
      `SELECT p.author_id, COUNT(*) AS n, SUM(p.views) AS s, ${avg} AS a FROM posts p
        WHERE p.status <> ? AND EXISTS (SELECT 1 FROM users u WHERE u.id = p.author_id AND u.active = ? AND u.role = ?)
        GROUP BY p.author_id HAVING COUNT(*) >= ? ORDER BY SUM(p.views) DESC, p.author_id ${F.page(20)}`,
      ["DRAFT", F.bool(true), "USER", DEEP.minGroup]))
      .map((r: any) => ({ author_id: r.author_id, _count: { _all: r.n }, _sum: { views: r.s }, _avg: { views: r.a } })),
    json_fts_rel: () => c.all(
      `SELECT posts.id FROM posts WHERE ${F.fts("body")} AND ${F.jsonStr("posts.meta", "lang")} = ?
         AND EXISTS (SELECT 1 FROM users u WHERE u.id = posts.author_id AND ${F.jsonStr("u.prefs", "theme")} = ?)
       ORDER BY posts.id ${F.page(50)}`, [DEEP.term, DEEP.lang, DEEP.theme]),
    delete_by_id: async (i) => {
      const id = wid(T, "dbi", i);
      if (F.returning) return (await c.all(`DELETE FROM users WHERE id = ? RETURNING id, email`, [id]))[0];
      if (d === "mssql") return (await c.all(`DELETE FROM users OUTPUT DELETED.id, DELETED.email WHERE id = ?`, [id]))[0];
      const row = (await c.all(`SELECT id, email FROM users WHERE id = ?`, [id]))[0];
      await c.run(`DELETE FROM users WHERE id = ?`, [id]);
      return row;
    },
    update_many_rel: async (i) => ({ count: await c.run(
      `UPDATE posts SET views = ? WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = posts.author_id AND u.email = ?)`,
      [7, `${wid(T, "umr", i)}@bench.dev`]) }),
    delete_many_rel: async (i) => {
      const email = `${wid(T, "dmr", i)}@bench.dev`;
      const where = `EXISTS (SELECT 1 FROM users u WHERE u.id = posts.author_id AND u.email = ?) AND NOT EXISTS (SELECT 1 FROM comments c WHERE c.post_id = posts.id)`;
      // DuckDB has no ON DELETE CASCADE, so the children go first.
      if (d === "duckdb") return c.tx(async (tx: any) => {
        await tx.run(`DELETE FROM post_tags WHERE post_id IN (SELECT id FROM posts WHERE ${where})`, [email]);
        return { count: await tx.run(`DELETE FROM posts WHERE ${where}`, [email]) };
      });
      return { count: await c.run(`DELETE FROM posts WHERE ${where}`, [email]) };
    },
    nested_update: (i) => c.tx(async (tx: any) => {
      const n = NU(T, i);
      await tx.run(`UPDATE users SET name = ? WHERE id = ?`, ["Nested update", n.U]);
      await tx.run(`UPDATE posts SET title = ? WHERE id = ? AND author_id = ?`, ["Updated 0", n.p[0], n.U]);
      await upsertPost(tx, { ...postFields(n.p[1], 1), author_id: n.U }, 11);
      await upsertPost(tx, { ...postFields(n.pNew, 9), author_id: n.U }, 0);
      if (d === "duckdb") await tx.run(`DELETE FROM post_tags WHERE post_id IN (SELECT id FROM posts WHERE author_id = ? AND views >= ?)`, [n.U, 3]);
      await tx.run(`DELETE FROM posts WHERE author_id = ? AND views >= ?`, [n.U, 3]);
      return { id: n.U };
    }),
    upsert_loop: async (i) => {
      let k = 0;
      for (const id of UL(T, i)) { await upsertUser({ ...fixUser(id), name: `Loop ${k}` }, `Loop ${k}`); k++; }
      return k;
    },
    tx_mixed: async (i) => {
      const t = TXM(T, i);
      try {
        await c.tx(async (tx: any) => {
          await tx.run(`INSERT INTO users (${USER_COLS}) VALUES (${Q(7)})`, userVals(userData(t.U)));
          const ps = t.posts.map((id, k) => fpost(id, t.U, k));
          await tx.run(`INSERT INTO posts (${POST_COLS}) VALUES ${ps.map(() => `(${Q(10)})`).join(", ")}`, ps.flatMap(postVals));
          await tx.run(`UPDATE posts SET views = ? WHERE author_id = ?`, [5, t.U]);
          if (d === "mysql") await tx.run(`INSERT IGNORE INTO tags (id, name) VALUES (?, ?)`, [t.tag, t.tag]);
          else await tx.run(`INSERT INTO tags (id, name) VALUES (?, ?) ON CONFLICT (name) DO NOTHING`, [t.tag, t.tag]);
          await tx.run(`DELETE FROM posts WHERE id = ?`, [t.posts[2]]);
          await tx.all(`SELECT COUNT(*) AS n FROM posts WHERE author_id = ?`, [t.U]);
          throw new Error("rollback");
        });
      } catch (e: any) { if (e.message !== "rollback") throw e; }
      return null;
    },
  };
}

// ─── raw Mongo ──────────────────────────────────────────────────────────────

export function rawMongoLadder(o: { db: any; client: any; T: string; doc: (x: any) => any; tx: boolean }): Record<string, (i: number, n: number) => Promise<unknown>> {
  const { db, client, T, doc } = o;
  const users = db.collection("users"), posts = db.collection("posts"), comments = db.collection("comments"), tags = db.collection("tags");
  const withTx = async <R>(fn: (s: any) => Promise<R>): Promise<R> => {
    if (!o.tx) return fn(undefined);
    const s = client.startSession();
    try { let out!: R; await s.withTransaction(async () => { out = await fn(s); }); return out; } finally { await s.endSession(); }
  };
  return {
    rel_deep: async () => {
      const anonPosts = await comments.distinct("post_id", { author_id: null });
      const [withAnon, notAllDraft] = await Promise.all([
        posts.distinct("author_id", { status: "PUBLISHED", _id: { $in: anonPosts } }),
        posts.distinct("author_id", { status: { $ne: "DRAFT" } }),
      ]);
      return users.find({ active: true, $or: [{ _id: { $in: withAnon } }, { role: "ADMIN" }], $and: [{ _id: { $in: notAllDraft } }] },
        { projection: { _id: 1 } }).sort({ _id: 1 }).limit(50).toArray();
    },
    include_count: (_i, n) => users.aggregate([
      { $match: { active: true } }, { $sort: { _id: 1 } }, { $limit: n },
      { $lookup: { from: "posts", localField: "_id", foreignField: "author_id", as: "pc", pipeline: [{ $count: "n" }] } },
      { $lookup: { from: "posts", localField: "_id", foreignField: "author_id", as: "posts", pipeline: [
        { $match: { status: "PUBLISHED" } }, { $sort: { views: -1, _id: 1 } }, { $limit: 3 },
        { $lookup: { from: "comments", localField: "_id", foreignField: "post_id", as: "cc", pipeline: [{ $count: "n" }] } },
        { $lookup: { from: "comments", localField: "_id", foreignField: "post_id", as: "comments", pipeline: [
          { $sort: { _id: 1 } }, { $limit: 2 },
          { $lookup: { from: "users", localField: "author_id", foreignField: "_id", as: "author", pipeline: [{ $project: { email: 1 } }] } },
          { $project: { author_id: 1, author: { $first: "$author" } } },
        ] } },
        { $set: { _count: { comments: { $ifNull: [{ $first: "$cc.n" }, 0] } } } }, { $unset: "cc" },
      ] } },
      { $set: { _count: { posts: { $ifNull: [{ $first: "$pc.n" }, 0] } } } }, { $unset: "pc" },
    ]).toArray(),
    groupby_rel: async () => {
      const authors = await users.distinct("_id", { active: true, role: "USER" });
      return (await posts.aggregate([
        { $match: { status: { $ne: "DRAFT" }, author_id: { $in: authors } } },
        { $group: { _id: "$author_id", n: { $sum: 1 }, s: { $sum: "$views" }, a: { $avg: "$views" } } },
        { $match: { n: { $gte: DEEP.minGroup } } }, { $sort: { s: -1, _id: 1 } }, { $limit: 20 },
      ]).toArray()).map((r: any) => ({ author_id: r._id, _count: { _all: r.n }, _sum: { views: r.s }, _avg: { views: r.a } }));
    },
    json_fts_rel: async () => {
      const dark = await users.distinct("_id", { "prefs.theme": DEEP.theme });
      return posts.find({ $text: { $search: DEEP.term }, "meta.lang": DEEP.lang, author_id: { $in: dark } }, { projection: { _id: 1 } })
        .sort({ _id: 1 }).limit(50).toArray();
    },
    delete_by_id: async (i) => users.findOneAndDelete({ _id: wid(T, "dbi", i) }),
    update_many_rel: async (i) => {
      const a = await users.distinct("_id", { email: `${wid(T, "umr", i)}@bench.dev` });
      return { count: (await posts.updateMany({ author_id: { $in: a } }, { $set: { views: 7 } })).modifiedCount };
    },
    delete_many_rel: async (i) => {
      const a = await users.distinct("_id", { email: `${wid(T, "dmr", i)}@bench.dev` });
      const mine = await posts.distinct("_id", { author_id: { $in: a } });
      const commented = await comments.distinct("post_id", { post_id: { $in: mine } });
      return { count: (await posts.deleteMany({ _id: { $in: mine.filter((p: string) => !commented.includes(p)) } })).deletedCount };
    },
    nested_update: (i) => withTx(async (s) => {
      const n = NU(T, i);
      const opt = s ? { session: s } : {};
      await users.updateOne({ _id: n.U }, { $set: { name: "Nested update" } }, opt);
      await posts.updateOne({ _id: n.p[0], author_id: n.U }, { $set: { title: "Updated 0" } }, opt);
      for (const [id, k, views] of [[n.p[1], 1, 11], [n.pNew, 9, 0]] as const) {
        const { id: _drop, views: _v, ...fields } = { ...postFields(id, k), author_id: n.U };
        await posts.updateOne({ _id: id }, { $set: { views }, $setOnInsert: fields }, { ...opt, upsert: true });
      }
      await posts.deleteMany({ author_id: n.U, views: { $gte: 3 } }, opt);
      return { id: n.U };
    }),
    upsert_loop: async (i) => {
      let k = 0;
      for (const id of UL(T, i)) {
        const { name: _n, ...rest } = doc(fixUser(id));
        await users.updateOne({ email: `${id}@bench.dev` }, { $set: { name: `Loop ${k}` }, $setOnInsert: rest }, { upsert: true });
        k++;
      }
      return k;
    },
    tx_mixed: async (i) => {
      const t = TXM(T, i);
      const s = client.startSession();
      try {
        s.startTransaction();
        const opt = { session: s };
        await users.insertOne(doc(userData(t.U)), opt);
        await posts.insertMany(t.posts.map((id, k) => doc(fixPost(id, t.U, k))), opt);
        await posts.updateMany({ author_id: t.U }, { $set: { views: 5 } }, opt);
        await tags.updateOne({ name: t.tag }, { $setOnInsert: { _id: t.tag, name: t.tag } }, { ...opt, upsert: true });
        await posts.deleteOne({ _id: t.posts[2] }, opt);
        await posts.countDocuments({ author_id: t.U }, opt);
        await s.abortTransaction();
      } finally { await s.endSession(); }
      return null;
    },
  };
}

// ─── Prisma ─────────────────────────────────────────────────────────────────

export function prismaLadder(db: any, T: string, d: string): Record<string, (i: number, n: number) => Promise<unknown>> {
  const jp = (k: string) => (d === "mysql" ? `$.${k}` : [k]);
  const ops: Record<string, (i: number, n: number) => Promise<unknown>> = {
    rel_deep: () => db.user.findMany({
      where: {
        active: true,
        OR: [{ posts: { some: { status: "PUBLISHED", comments: { some: { author_id: null } } } } }, { role: "ADMIN" }],
        NOT: { posts: { every: { status: "DRAFT" } } },
      },
      select: { id: true }, orderBy: { id: "asc" }, take: 50,
    }),
    include_count: (_i, n) => db.user.findMany({
      where: { active: true }, orderBy: { id: "asc" }, take: n,
      include: {
        _count: { select: { posts: true } },
        posts: {
          where: { status: "PUBLISHED" }, orderBy: [{ views: "desc" }, { id: "asc" }], take: 3,
          include: {
            _count: { select: { comments: true } },
            comments: { orderBy: { id: "asc" }, take: 2, select: { id: true, author: { select: { id: true, email: true } } } },
          },
        },
      },
    }),
    groupby_rel: () => db.post.groupBy({
      by: ["author_id"], where: { status: { not: "DRAFT" }, author: { is: { active: true, role: "USER" } } },
      _count: { _all: true }, _sum: { views: true }, _avg: { views: true },
      having: { id: { _count: { gte: DEEP.minGroup } } },
      orderBy: [{ _sum: { views: "desc" } }, { author_id: "asc" }], take: 20,
    }),
    json_fts_rel: () => db.post.findMany({
      where: { body: { search: DEEP.term }, meta: { path: jp("lang"), equals: DEEP.lang }, author: { is: { prefs: { path: jp("theme"), equals: DEEP.theme } } } },
      select: { id: true }, orderBy: { id: "asc" }, take: 50,
    }),
    delete_by_id: (i) => db.user.delete({ where: { id: wid(T, "dbi", i) } }),
    update_many_rel: (i) => db.post.updateMany({ where: { author: { is: { email: `${wid(T, "umr", i)}@bench.dev` } } }, data: { views: 7 } }),
    delete_many_rel: (i) => db.post.deleteMany({ where: { author: { is: { email: `${wid(T, "dmr", i)}@bench.dev` } }, comments: { none: {} } } }),
    nested_update: (i) => {
      const n = NU(T, i);
      return db.user.update({ where: { id: n.U }, data: {
        name: "Nested update",
        posts: {
          update: [{ where: { id: n.p[0] }, data: { title: "Updated 0" } }],
          upsert: [
            { where: { id: n.p[1] }, create: postFields(n.p[1], 1), update: { views: 11 } },
            { where: { id: n.pNew }, create: postFields(n.pNew, 9), update: { views: 0 } },
          ],
          deleteMany: { views: { gte: 3 } },
        },
      } });
    },
    upsert_loop: async (i) => {
      let k = 0;
      for (const id of UL(T, i)) {
        await db.user.upsert({ where: { email: `${id}@bench.dev` }, create: { ...fixUser(id), name: `Loop ${k}` }, update: { name: `Loop ${k}` } });
        k++;
      }
      return k;
    },
    tx_mixed: async (i) => {
      const t = TXM(T, i);
      try {
        await db.$transaction(async (tx: any) => {
          await tx.user.create({ data: userData(t.U) });
          await tx.post.createMany({ data: t.posts.map((id, k) => fixPost(id, t.U, k)) });
          await tx.post.updateMany({ where: { author_id: t.U }, data: { views: 5 } });
          await tx.tag.upsert({ where: { name: t.tag }, create: { id: t.tag, name: t.tag }, update: {} });
          await tx.post.delete({ where: { id: t.posts[2] } });
          await tx.post.count({ where: { author_id: t.U } });
          throw new Error("rollback");
        });
      } catch (e: any) { if (e.message !== "rollback") throw e; }
      return null;
    },
  };
  return ops;
}

// ─── Knex ───────────────────────────────────────────────────────────────────

export function knexLadder(o: { k: any; d: string; F: any; T: string; U: string[]; uVals: (u: any) => any; pVals: (p: any) => any; affected: (r: any) => number; upsert: (u: any, name: string) => any }):
  Record<string, (i: number, n: number) => Promise<unknown>> {
  const { k, d, F, T, U, uVals, pVals, affected, upsert } = o;
  const idList = (rows: any[], key = "id") => [...new Set(rows.map((r) => r[key]).filter((v) => v != null))];
  const avg = d === "mssql" ? k.raw("AVG(CAST(views AS FLOAT)) AS a") : k.raw("AVG(views) AS a");
  const upsertPost = (q: any, p: any, views: number) => q("posts").insert(pVals(p)).onConflict("id").merge({ views });
  return {
    rel_deep: () => k("users as u").select("u.id").where("u.active", F.bool(true))
      .where((q: any) => q.whereExists(k("posts as p").select(k.raw("1")).whereRaw("p.author_id = u.id").where("p.status", "PUBLISHED")
        .whereExists(k("comments as c").select(k.raw("1")).whereRaw("c.post_id = p.id").whereNull("c.author_id")))
        .orWhere("u.role", "ADMIN"))
      .whereExists(k("posts as p2").select(k.raw("1")).whereRaw("p2.author_id = u.id").whereNot("p2.status", "DRAFT"))
      .orderBy("u.id").limit(50),
    include_count: async (_i, n) => {
      const users = await k("users as u").select([...U.map((c) => `u.${c}`), k.raw("(SELECT COUNT(*) FROM posts p WHERE p.author_id = u.id) AS pc")])
        .where("u.active", F.bool(true)).orderBy("u.id").limit(n);
      for (const u of users) u._count = { posts: u.pc };
      const uid = idList(users);
      const posts = uid.length ? await k.select("*").from(
        k("posts as p").select(["p.id", "p.author_id", "p.title", "p.views",
          k.raw("(SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS cc"),
          k.raw("ROW_NUMBER() OVER (PARTITION BY p.author_id ORDER BY p.views DESC, p.id ASC) AS rn")])
          .whereIn("p.author_id", uid).where("p.status", "PUBLISHED").as("x"))
        .where("rn", "<=", 3).orderBy(["author_id", "rn"]) : [];
      for (const p of posts) p._count = { comments: p.cc };
      const pid = idList(posts);
      const comments = pid.length ? await k.select(["id", "post_id", "author_id"]).from(
        k("comments").select(["id", "post_id", "author_id", k.raw("ROW_NUMBER() OVER (PARTITION BY post_id ORDER BY id) AS rn")]).whereIn("post_id", pid).as("x"))
        .where("rn", "<=", 2).orderBy(["post_id", "id"]) : [];
      const aid = idList(comments, "author_id");
      const authors = indexBy(aid.length ? await k("users").select(["id", "email"]).whereIn("id", aid) : [], (x: any) => x.id);
      for (const cm of comments) cm.author = cm.author_id ? authors.get(cm.author_id) ?? null : null;
      groupInto(posts, comments, (x: any) => x.id, (x: any) => x.post_id, "comments");
      return groupInto(users, posts, (x: any) => x.id, (x: any) => x.author_id, "posts");
    },
    groupby_rel: async () => (await k("posts").select("author_id").count({ n: "*" }).sum({ s: "views" }).select(avg)
      .whereNot("status", "DRAFT")
      .whereExists(k("users as u").select(k.raw("1")).whereRaw("u.id = posts.author_id").where("u.active", F.bool(true)).where("u.role", "USER"))
      .groupBy("author_id").havingRaw("COUNT(*) >= ?", [DEEP.minGroup]).orderByRaw("SUM(views) DESC, author_id").limit(20))
      .map((r: any) => ({ author_id: r.author_id, _count: { _all: r.n }, _sum: { views: r.s }, _avg: { views: r.a } })),
    json_fts_rel: () => k("posts").select("posts.id").whereRaw(F.fts("body"), [DEEP.term])
      .whereRaw(`${F.jsonStr("posts.meta", "lang")} = ?`, [DEEP.lang])
      .whereExists(k("users as u").select(k.raw("1")).whereRaw("u.id = posts.author_id").whereRaw(`${F.jsonStr("u.prefs", "theme")} = ?`, [DEEP.theme]))
      .orderBy("posts.id").limit(50),
    delete_by_id: async (i) => {
      const id = wid(T, "dbi", i);
      // Knex has no RETURNING on a SQLite delete.
      if (d === "mysql" || d === "sqlite") {
        const row = await k("users").select(["id", "email"]).where("id", id).first();
        await k("users").where("id", id).del();
        return row;
      }
      return (await k("users").where("id", id).returning(["id", "email"]).del())[0];
    },
    update_many_rel: async (i) => ({ count: affected(await k("posts").update({ views: 7 })
      .whereExists(k("users as u").select(k.raw("1")).whereRaw("u.id = posts.author_id").where("u.email", `${wid(T, "umr", i)}@bench.dev`))) }),
    delete_many_rel: async (i) => ({ count: affected(await k("posts")
      .whereExists(k("users as u").select(k.raw("1")).whereRaw("u.id = posts.author_id").where("u.email", `${wid(T, "dmr", i)}@bench.dev`))
      .whereNotExists(k("comments as c").select(k.raw("1")).whereRaw("c.post_id = posts.id")).del()) }),
    nested_update: (i) => k.transaction(async (trx: any) => {
      const n = NU(T, i);
      await trx("users").update({ name: "Nested update" }).where("id", n.U);
      await trx("posts").update({ title: "Updated 0" }).where({ id: n.p[0], author_id: n.U });
      await upsertPost(trx, { ...postFields(n.p[1], 1), author_id: n.U }, 11);
      await upsertPost(trx, { ...postFields(n.pNew, 9), author_id: n.U }, 0);
      await trx("posts").where("author_id", n.U).where("views", ">=", 3).del();
      return { id: n.U };
    }),
    upsert_loop: async (i) => {
      let c = 0;
      for (const id of UL(T, i)) { await upsert({ ...fixUser(id), name: `Loop ${c}` }, `Loop ${c}`); c++; }
      return c;
    },
    tx_mixed: async (i) => {
      const t = TXM(T, i);
      try {
        await k.transaction(async (trx: any) => {
          await trx("users").insert(uVals(userData(t.U)));
          await trx("posts").insert(t.posts.map((id, j) => pVals(fixPost(id, t.U, j))));
          await trx("posts").update({ views: 5 }).where("author_id", t.U);
          await trx("tags").insert({ id: t.tag, name: t.tag }).onConflict("name").ignore();
          await trx("posts").where("id", t.posts[2]).del();
          await trx("posts").count({ n: "*" }).where("author_id", t.U).first();
          throw new Error("rollback");
        });
      } catch (e: any) { if (e.message !== "rollback") throw e; }
      return null;
    },
  };
}

// ─── Kysely ─────────────────────────────────────────────────────────────────

export function kyselyLadder(o: {
  db: any; sql: any; d: string; F: any; T: string; lim: (qb: any, n: number) => any; frg: (t: string, ...v: unknown[]) => any;
  jsonArrayFrom: any; jsonObjectFrom: any; uVals: (u: any) => any; pVals: (p: any) => any; n0: (v: any) => number;
  upsert: (u: any, name: string) => any; cols: (list: string, alias?: string) => string[]; USER_COLS: string;
}): Record<string, (i: number, n: number) => Promise<unknown>> {
  const { db, sql, d, F, T, lim, frg, jsonArrayFrom, jsonObjectFrom, uVals, pVals, n0, upsert, cols, USER_COLS } = o;
  const one = sql`1`;
  const upsertPost = (q: any, p: any, views: number) => d === "mysql"
    ? q.insertInto("posts").values(pVals(p)).onDuplicateKeyUpdate({ views }).execute()
    : q.insertInto("posts").values(pVals(p)).onConflict((oc: any) => oc.column("id").doUpdateSet({ views })).execute();
  return {
    rel_deep: () => lim(db.selectFrom("users as u").select("u.id").where((eb: any) => eb.and([
      eb("u.active", "=", F.bool(true)),
      eb.or([
        eb.exists(eb.selectFrom("posts as p").select(one.as("x")).whereRef("p.author_id", "=", "u.id").where("p.status", "=", "PUBLISHED")
          .where((eb2: any) => eb2.exists(eb2.selectFrom("comments as c").select(one.as("x")).whereRef("c.post_id", "=", "p.id").where("c.author_id", "is", null)))),
        eb("u.role", "=", "ADMIN"),
      ]),
      eb.exists(eb.selectFrom("posts as p2").select(one.as("x")).whereRef("p2.author_id", "=", "u.id").where("p2.status", "<>", "DRAFT")),
    ])).orderBy("u.id"), 50).execute(),
    include_count: async (_i, n) => (await lim(db.selectFrom("users as u").select(cols(USER_COLS, "u"))
      .select((eb: any) => eb.selectFrom("posts as pc").select(eb.fn.countAll().as("n")).whereRef("pc.author_id", "=", "u.id").as("pc"))
      .select((eb: any) => jsonArrayFrom(lim(eb.selectFrom("posts as p").select(["p.id", "p.views"])
        .select((eb2: any) => eb2.selectFrom("comments as cc").select(eb2.fn.countAll().as("n")).whereRef("cc.post_id", "=", "p.id").as("cc"))
        .select((eb2: any) => jsonArrayFrom(lim(eb2.selectFrom("comments as c").select(["c.id"])
          .select((eb3: any) => jsonObjectFrom(eb3.selectFrom("users as a").select(["a.id", "a.email"]).whereRef("a.id", "=", "c.author_id")).as("author"))
          .whereRef("c.post_id", "=", "p.id").orderBy("c.id"), 2)).as("comments"))
        .whereRef("p.author_id", "=", "u.id").where("p.status", "=", "PUBLISHED").orderBy("p.views", "desc").orderBy("p.id"), 3)).as("posts"))
      .where("u.active", "=", F.bool(true)).orderBy("u.id"), n).execute())
      .map((u: any) => {
        const posts = typeof u.posts === "string" ? JSON.parse(u.posts) : u.posts;
        return { ...u, _count: { posts: u.pc }, posts: (posts ?? []).map((p: any) => ({ ...p, _count: { comments: p.cc } })) };
      }),
    groupby_rel: async () => (await lim(db.selectFrom("posts").select("author_id")
      .select((eb: any) => [eb.fn.countAll().as("n"), eb.fn.sum("views").as("s"), (d === "mssql" ? sql`AVG(CAST(views AS FLOAT))` : eb.fn.avg("views")).as("a")])
      .where("status", "<>", "DRAFT")
      .where((eb: any) => eb.exists(eb.selectFrom("users as u").select(one.as("x")).whereRef("u.id", "=", "posts.author_id").where("u.active", "=", F.bool(true)).where("u.role", "=", "USER")))
      .groupBy("author_id").having((eb: any) => eb.fn.countAll(), ">=", DEEP.minGroup)
      .orderBy((eb: any) => eb.fn.sum("views"), "desc").orderBy("author_id"), 20).execute())
      .map((r: any) => ({ author_id: r.author_id, _count: { _all: r.n }, _sum: { views: r.s }, _avg: { views: r.a } })),
    json_fts_rel: () => lim(db.selectFrom("posts").select("posts.id").where(frg(F.fts("body"), DEEP.term))
      .where(frg(`${F.jsonStr("posts.meta", "lang")} = ?`, DEEP.lang))
      .where((eb: any) => eb.exists(eb.selectFrom("users as u").select(one.as("x")).whereRef("u.id", "=", "posts.author_id").where(frg(`${F.jsonStr("u.prefs", "theme")} = ?`, DEEP.theme))))
      .orderBy("posts.id"), 50).execute(),
    delete_by_id: async (i) => {
      const id = wid(T, "dbi", i);
      const q = db.deleteFrom("users").where("id", "=", id);
      if (F.returning) return q.returning(["id", "email"]).executeTakeFirst();
      if (d === "mssql") return q.output(["deleted.id", "deleted.email"]).executeTakeFirst();
      const row = await db.selectFrom("users").select(["id", "email"]).where("id", "=", id).executeTakeFirst();
      await q.execute();
      return row;
    },
    update_many_rel: async (i) => ({ count: n0((await db.updateTable("posts").set({ views: 7 })
      .where((eb: any) => eb.exists(eb.selectFrom("users as u").select(one.as("x")).whereRef("u.id", "=", "posts.author_id").where("u.email", "=", `${wid(T, "umr", i)}@bench.dev`)))
      .executeTakeFirst()).numUpdatedRows) }),
    delete_many_rel: async (i) => ({ count: n0((await db.deleteFrom("posts")
      .where((eb: any) => eb.and([
        eb.exists(eb.selectFrom("users as u").select(one.as("x")).whereRef("u.id", "=", "posts.author_id").where("u.email", "=", `${wid(T, "dmr", i)}@bench.dev`)),
        eb.not(eb.exists(eb.selectFrom("comments as c").select(one.as("x")).whereRef("c.post_id", "=", "posts.id"))),
      ])).executeTakeFirst()).numDeletedRows) }),
    nested_update: (i) => db.transaction().execute(async (trx: any) => {
      const n = NU(T, i);
      await trx.updateTable("users").set({ name: "Nested update" }).where("id", "=", n.U).execute();
      await trx.updateTable("posts").set({ title: "Updated 0" }).where("id", "=", n.p[0]).where("author_id", "=", n.U).execute();
      await upsertPost(trx, { ...postFields(n.p[1], 1), author_id: n.U }, 11);
      await upsertPost(trx, { ...postFields(n.pNew, 9), author_id: n.U }, 0);
      await trx.deleteFrom("posts").where("author_id", "=", n.U).where("views", ">=", 3).execute();
      return { id: n.U };
    }),
    upsert_loop: async (i) => {
      let c = 0;
      for (const id of UL(T, i)) { await upsert({ ...fixUser(id), name: `Loop ${c}` }, `Loop ${c}`); c++; }
      return c;
    },
    tx_mixed: async (i) => {
      const t = TXM(T, i);
      try {
        await db.transaction().execute(async (trx: any) => {
          await trx.insertInto("users").values(uVals(userData(t.U))).execute();
          await trx.insertInto("posts").values(t.posts.map((id, j) => pVals(fixPost(id, t.U, j)))).execute();
          await trx.updateTable("posts").set({ views: 5 }).where("author_id", "=", t.U).execute();
          if (d === "mysql") await trx.insertInto("tags").ignore().values({ id: t.tag, name: t.tag }).execute();
          else await trx.insertInto("tags").values({ id: t.tag, name: t.tag }).onConflict((oc: any) => oc.column("name").doNothing()).execute();
          await trx.deleteFrom("posts").where("id", "=", t.posts[2]).execute();
          await trx.selectFrom("posts").select((eb: any) => eb.fn.countAll().as("n")).where("author_id", "=", t.U).executeTakeFirst();
          throw new Error("rollback");
        });
      } catch (e: any) { if (e.message !== "rollback") throw e; }
      return null;
    },
  };
}

// ─── Drizzle ────────────────────────────────────────────────────────────────

export function drizzleLadder(o: {
  db: any; d: string; F: any; T: string; schema: any; ops: any; frg: (t: string, ...v: unknown[]) => any; affected: (r: any) => number;
}): Record<string, (i: number, n: number) => Promise<unknown>> {
  const { db, d, F, T, frg, affected } = o;
  const { users, posts, comments, tags } = o.schema;
  const { and, asc, avg, count, desc, eq, exists, gte, isNull, ne, not, or, sql, sum } = o.ops;
  const sqlite = d === "sqlite";
  const hasReturning = d !== "mysql";
  const one = sql`1`;
  const upsertUser = (u: any, name: string) => d === "mysql"
    ? db.insert(users).values(u).onDuplicateKeyUpdate({ set: { name } })
    : db.insert(users).values(u).onConflictDoUpdate({ target: users.email, set: { name } });
  const upsertPost = (q: any, p: any, views: number) => d === "mysql"
    ? q.insert(posts).values(p).onDuplicateKeyUpdate({ set: { views } })
    : q.insert(posts).values(p).onConflictDoUpdate({ target: posts.id, set: { views } });
  const run = (q: any) => (sqlite ? q.run() : q);
  return {
    rel_deep: () => db.select({ id: users.id }).from(users).where(and(
      eq(users.active, true),
      or(
        exists(db.select({ x: one }).from(posts).where(and(eq(posts.author_id, users.id), eq(posts.status, "PUBLISHED"),
          exists(db.select({ x: one }).from(comments).where(and(eq(comments.post_id, posts.id), isNull(comments.author_id))))))),
        eq(users.role, "ADMIN"),
      ),
      exists(db.select({ x: one }).from(posts).where(and(eq(posts.author_id, users.id), ne(posts.status, "DRAFT")))),
    )).orderBy(asc(users.id)).limit(50),
    include_count: (_i, n) => db.query.users.findMany({
      where: eq(users.active, true), orderBy: [asc(users.id)], limit: n,
      // The root table renders unqualified in an extra, so the outer key is spelled out.
      extras: { pc: sql`(select count(*) from posts pc where pc.author_id = ${sql.raw(d === "mysql" ? "`users`.`id`" : `"users"."id"`)})`.as("pc") },
      with: { posts: {
        where: eq(posts.status, "PUBLISHED"), orderBy: [desc(posts.views), asc(posts.id)], limit: 3,
        columns: { id: true, views: true },
        extras: (t: any) => ({ cc: sql`(select count(*) from comments cc where cc.post_id = ${t.id})`.as("cc") }),
        with: { comments: { orderBy: [asc(comments.id)], limit: 2, columns: { id: true }, with: { author: { columns: { id: true, email: true } } } } },
      } },
    }).then((rows: any[]) => rows.map((u) => ({ ...u, _count: { posts: u.pc }, posts: u.posts.map((p: any) => ({ ...p, _count: { comments: p.cc } })) }))),
    groupby_rel: async () => (await db.select({ author_id: posts.author_id, n: count(), s: sum(posts.views), a: avg(posts.views) }).from(posts)
      .where(and(ne(posts.status, "DRAFT"), exists(db.select({ x: one }).from(users).where(and(eq(users.id, posts.author_id), eq(users.active, true), eq(users.role, "USER"))))))
      .groupBy(posts.author_id).having(gte(count(), DEEP.minGroup)).orderBy(desc(sum(posts.views)), asc(posts.author_id)).limit(20))
      .map((r: any) => ({ author_id: r.author_id, _count: { _all: r.n }, _sum: { views: r.s }, _avg: { views: r.a } })),
    json_fts_rel: () => db.select({ id: posts.id }).from(posts).where(and(
      frg(F.fts("body"), DEEP.term),
      frg(`${F.jsonStr(d === "mysql" ? "`posts`.`meta`" : `"posts"."meta"`, "lang")} = ?`, DEEP.lang),
      exists(db.select({ x: one }).from(users).where(and(eq(users.id, posts.author_id), frg(`${F.jsonStr("prefs", "theme")} = ?`, DEEP.theme)))),
    )).orderBy(asc(posts.id)).limit(50),
    delete_by_id: async (i) => {
      const id = wid(T, "dbi", i);
      if (hasReturning) return (await db.delete(users).where(eq(users.id, id)).returning({ id: users.id, email: users.email }))[0];
      const row = (await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, id)))[0];
      await db.delete(users).where(eq(users.id, id));
      return row;
    },
    update_many_rel: async (i) => ({ count: affected(await db.update(posts).set({ views: 7 })
      .where(exists(db.select({ x: one }).from(users).where(and(eq(users.id, posts.author_id), eq(users.email, `${wid(T, "umr", i)}@bench.dev`)))))) }),
    delete_many_rel: async (i) => ({ count: affected(await db.delete(posts).where(and(
      exists(db.select({ x: one }).from(users).where(and(eq(users.id, posts.author_id), eq(users.email, `${wid(T, "dmr", i)}@bench.dev`)))),
      not(exists(db.select({ x: one }).from(comments).where(eq(comments.post_id, posts.id)))),
    ))) }),
    nested_update: (i) => {
      const n = NU(T, i);
      const steps = (tx: any) => [
        tx.update(users).set({ name: "Nested update" }).where(eq(users.id, n.U)),
        tx.update(posts).set({ title: "Updated 0" }).where(and(eq(posts.id, n.p[0]), eq(posts.author_id, n.U))),
        upsertPost(tx, { ...postFields(n.p[1], 1), author_id: n.U }, 11),
        upsertPost(tx, { ...postFields(n.pNew, 9), author_id: n.U }, 0),
        tx.delete(posts).where(and(eq(posts.author_id, n.U), gte(posts.views, 3))),
      ];
      if (sqlite) return db.transaction((tx: any) => { for (const q of steps(tx)) q.run(); return { id: n.U }; });
      return db.transaction(async (tx: any) => { for (const q of steps(tx)) await q; return { id: n.U }; });
    },
    upsert_loop: async (i) => {
      let c = 0;
      for (const id of UL(T, i)) { await run(upsertUser({ ...fixUser(id), name: `Loop ${c}` }, `Loop ${c}`)); c++; }
      return c;
    },
    tx_mixed: async (i) => {
      const t = TXM(T, i);
      const steps = (tx: any) => [
        tx.insert(users).values(userData(t.U)),
        tx.insert(posts).values(t.posts.map((id, j) => fixPost(id, t.U, j))),
        tx.update(posts).set({ views: 5 }).where(eq(posts.author_id, t.U)),
        d === "mysql" ? tx.insert(tags).ignore().values({ id: t.tag, name: t.tag }) : tx.insert(tags).values({ id: t.tag, name: t.tag }).onConflictDoNothing({ target: tags.name }),
        tx.delete(posts).where(eq(posts.id, t.posts[2])),
      ];
      try {
        if (sqlite) db.transaction((tx: any) => {
          for (const q of steps(tx)) q.run();
          tx.select({ n: count() }).from(posts).where(eq(posts.author_id, t.U)).all();
          throw new Error("rollback");
        });
        else await db.transaction(async (tx: any) => {
          for (const q of steps(tx)) await q;
          await tx.select({ n: count() }).from(posts).where(eq(posts.author_id, t.U));
          throw new Error("rollback");
        });
      } catch (e: any) { if (e.message !== "rollback") throw e; }
      return null;
    },
  };
}
