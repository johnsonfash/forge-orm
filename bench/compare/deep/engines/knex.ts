// Knex 3. Knex is a query builder with no relation loading, so includes are
// what a Knex user writes: one whereIn query per level, with a window function
// where a level is limited per parent.

import { EngineImpl, groupInto, indexBy } from "../core";
import { POOL, DialectCtx } from "../dialects";
import { params, postData, userData, wid } from "../scenarios";
import * as S from "../schema";
import { frag } from "./sql";
import { knexLadder, kyselyLadder } from "../ladder";
import { USER_COLS, POST_COLS } from "./raw";

export async function knexEngine(ctx: DialectCtx): Promise<EngineImpl | { na: string }> {
  const d = ctx.dialect;
  if (d === "mongo") return { na: "Knex is SQL only" };
  if (d === "duckdb") return { na: "Knex has no DuckDB client" };

  const knexLib = require("knex");
  const c = ctx.conn;
  const cfg: any =
    d === "postgres" ? { client: "pg", connection: ctx.url }
    : d === "mysql" ? { client: "mysql2", connection: { host: c.host, port: c.port, user: c.user, password: c.password, database: c.database, supportBigNumbers: true } }
    : d === "sqlite" ? {
      client: "better-sqlite3", connection: { filename: ctx.sqliteFile }, useNullAsDefault: true,
      // Knex opens its own SQLite connection, so it has to switch FK
      // enforcement on itself or ON DELETE CASCADE does nothing.
      pool: { afterCreate: (conn: any, done: any) => { conn.pragma("foreign_keys = ON"); done(null, conn); } },
    }
    : { client: "mssql", connection: { server: c.server, port: c.port, user: c.user, password: c.password, database: c.database, options: { encrypt: false, trustServerCertificate: true } } };
  cfg.pool = { min: 0, max: d === "sqlite" ? 1 : POOL, ...(cfg.pool ?? {}) };
  const k = knexLib(cfg);
  await k.raw("select 1");

  const P = params(ctx.sizes);
  const F = frag(d);
  const T = "knex";
  const ms = d === "mssql";
  const U = USER_COLS.split(", "), PC = POST_COLS.split(", ");
  const uVals = (u: ReturnType<typeof userData>) => ({ ...u, active: F.bool(u.active), created_at: F.date(u.created_at), prefs: F.json(u.prefs) });
  const pVals = (p: ReturnType<typeof postData>) => ({ ...p, created_at: F.date(p.created_at), meta: F.json(p.meta) });
  const ids = (rows: any[], key = "id") => [...new Set(rows.map((r) => r[key]).filter((v) => v != null))];
  const affected = (r: any) => (typeof r === "number" ? r : Array.isArray(r) ? r.length : Number(r ?? 0));

  const na: Record<string, string> = { geo_near: "Knex has no geo operators; it would be the same hand-written SQL as raw" };
  if (d === "postgres") na.stream = "Knex's Postgres stream needs pg-query-stream (not installed)";
  if (!ctx.features.fts) na.fts = "no full-text index on this server";

  const upsert = (u: ReturnType<typeof userData>, name: string) => {
    const v = uVals(u);
    if (ms) return k.raw(`MERGE users WITH (HOLDLOCK) AS t USING (SELECT ? AS email) AS s ON t.email = s.email
      WHEN MATCHED THEN UPDATE SET name = ?
      WHEN NOT MATCHED THEN INSERT (${USER_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?);`, [u.email, name, v.id, v.email, v.name, v.role, v.active, v.created_at, v.prefs]);
    return k("users").insert(v).onConflict("email").merge({ name });
  };

  const ops: EngineImpl["ops"] = {
    pk: async (i) => (await k("users").select(U).where("id", P.pkUser(i)).first()) ?? null,
    unique_email: async (i) => (await k("users").select(U).where("email", P.emailUser(i)).first()) ?? null,
    filter_offset: () => k("users").select(U).where({ role: P.filterRole, active: F.bool(true) })
      .where("created_at", ">=", F.date(P.filterFrom)).where("created_at", "<", F.date(P.filterTo))
      .orderBy([{ column: "created_at", order: "desc" }, { column: "id", order: "asc" }]).limit(20).offset(P.filterSkip),
    cursor: (i) => k("posts").select(PC).where("id", ">", P.cursorAfter(i)).orderBy("id").limit(20),
    count_filter: async () => (await k("posts").count({ n: "*" }).where({ status: "PUBLISHED" }).where("views", ">=", P.countMinViews).first()).n,
    exists: async (i) => (await k("users").select("id").where("email", P.existsEmail(i)).first()) !== undefined,
    select_cols: (i) => k("posts").select(["id", "title", "views"]).where("author_id", P.selectAuthor(i)).orderBy("id"),
    in_100: () => k("users").select(["id", "email"]).whereIn("id", P.in100),
    or_not_like: () => k("users").select(U)
      .where((q: any) => q.whereRaw("LOWER(name) LIKE ?", [`%${P.likeName.toLowerCase()}%`]).orWhere("email", "like", `${P.likePrefix}%`))
      .whereNot("role", "ADMIN").orderBy("id").limit(50),
    rel_some: () => k("users as u").select("u.id")
      .whereExists(k("posts as p").select(k.raw("1")).whereRaw("p.author_id = u.id").where("p.status", "PUBLISHED")).orderBy("u.id").limit(50),
    rel_none: () => k("users as u").select("u.id")
      .whereNotExists(k("posts as p").select(k.raw("1")).whereRaw("p.author_id = u.id").where("p.status", "PUBLISHED")).orderBy("u.id").limit(50),
    rel_every: () => k("users as u").select("u.id")
      .whereNotExists(k("posts as p").select(k.raw("1")).whereRaw("p.author_id = u.id").whereNot("p.status", "PUBLISHED")).orderBy("u.id").limit(50),

    include_1: async (_i, n) => {
      const posts = await k("posts").select(PC).where("status", "PUBLISHED").orderBy("id").limit(n);
      const a = ids(posts, "author_id");
      const authors = indexBy(a.length ? await k("users").select(U).whereIn("id", a) : [], (u: any) => u.id);
      for (const p of posts) p.author = authors.get(p.author_id) ?? null;
      return posts;
    },
    include_2: async (_i, n) => {
      const users = await k("users").select(U).orderBy("id").limit(n);
      const posts = users.length ? await k("posts").select(PC).whereIn("author_id", ids(users)).orderBy("id") : [];
      const comments = posts.length ? await k("comments").select("*").whereIn("post_id", ids(posts)).orderBy("id") : [];
      groupInto(posts, comments, (x: any) => x.id, (x: any) => x.post_id, "comments");
      return groupInto(users, posts, (x: any) => x.id, (x: any) => x.author_id, "posts");
    },
    include_3: async (_i, n) => {
      const users = await k("users").select(U).where("active", F.bool(true)).orderBy("id").limit(n);
      const u = ids(users);
      const posts = u.length ? await k.select(PC).from(
        k("posts").select([...PC, k.raw("ROW_NUMBER() OVER (PARTITION BY author_id ORDER BY published_at DESC, id ASC) AS rn")])
          .whereIn("author_id", u).where("status", "PUBLISHED").as("x"))
        .where("rn", "<=", 5).orderBy([{ column: "author_id" }, { column: "published_at", order: "desc" }, { column: "id" }]) : [];
      const p = ids(posts);
      const comments = p.length ? await k.select(["id", "post_id", "author_id"]).from(
        k("comments").select(["id", "post_id", "author_id", k.raw("ROW_NUMBER() OVER (PARTITION BY post_id ORDER BY id) AS rn")]).whereIn("post_id", p).as("x"))
        .where("rn", "<=", 3).orderBy(["post_id", "id"]) : [];
      const a = ids(comments, "author_id");
      const authors = indexBy(a.length ? await k("users").select(["id", "email"]).whereIn("id", a) : [], (x: any) => x.id);
      for (const cm of comments) cm.author = cm.author_id ? authors.get(cm.author_id) ?? null : null;
      groupInto(posts, comments, (x: any) => x.id, (x: any) => x.post_id, "comments");
      return groupInto(users, posts, (x: any) => x.id, (x: any) => x.author_id, "posts");
    },
    m2m_post_tags: async (_i, n) => {
      const posts = await k("posts").select(["id", "title"]).orderBy("id").limit(n);
      const links = posts.length ? await k("post_tags as pt").join("tags as t", "t.id", "pt.tag_id")
        .select(["pt.id", "pt.post_id", "t.id as tag_id", "t.name as tag_name"]).whereIn("pt.post_id", ids(posts)) : [];
      return groupInto(posts, links.map((l: any) => ({ id: l.id, post_id: l.post_id, tag: { id: l.tag_id, name: l.tag_name } })), (x: any) => x.id, (x: any) => x.post_id, "post_tags");
    },
    m2m_tag_counts: async () => (await k("tags as t").leftJoin("post_tags as pt", "pt.tag_id", "t.id")
      .select(["t.id", "t.name"]).count({ n: "pt.id" }).groupBy(["t.id", "t.name"]).orderBy("t.name"))
      .map((r: any) => ({ ...r, _count: { post_tags: r.n } })),
    count_rel: async (_i, n) => (await k("users as u").select([...U.map((x) => `u.${x}`),
      k("posts as p").count("*").whereRaw("p.author_id = u.id").as("pc"),
      k("comments as c").count("*").whereRaw("c.author_id = u.id").as("cc"),
    ]).orderBy("u.id").limit(n)).map((r: any) => ({ ...r, _count: { posts: r.pc, comments: r.cc } })),
    aggregate: async () => {
      const r = await k("posts").where("status", "PUBLISHED").first(
        k.raw("COUNT(*) AS n"), k.raw("SUM(views) AS s"), k.raw(ms ? "AVG(CAST(views AS FLOAT)) AS a" : "AVG(views) AS a"), k.raw("MIN(views) AS mn"), k.raw("MAX(views) AS mx"));
      return { _count: { _all: r.n }, _sum: { views: r.s }, _avg: { views: r.a }, _min: { views: r.mn }, _max: { views: r.mx } };
    },
    groupby: async () => (await k("posts").select("author_id").count({ n: "*" }).sum({ s: "views" })
      .whereNot("status", "DRAFT").groupBy("author_id").havingRaw("COUNT(*) >= ?", [P.groupMinCount])
      .orderByRaw("SUM(views) DESC, author_id").limit(20))
      .map((r: any) => ({ author_id: r.author_id, _count: { _all: r.n }, _sum: { views: r.s } })),
    distinct: () => k("posts").distinct("author_id").where("views", "<", P.distinctMaxViews).orderBy("author_id"),
    json_prefs: () => k("users").select("id").whereRaw(`${F.jsonStr("prefs", "theme")} = ?`, [P.jsonTheme])
      .whereRaw(`${F.jsonNum("prefs", "score")} >= ?`, [P.jsonMinScore]).orderBy("id").limit(100),
    json_meta: async () => (await k("posts").count({ n: "*" }).whereRaw(`${F.jsonStr("meta", "lang")} = ?`, [P.metaLang])
      .whereRaw(`${F.jsonNum("meta", "score")} >= ?`, [P.metaMinScore]).first()).n,
    fts: () => k("posts").select("id").whereRaw(F.fts("body"), [P.ftsTerm]).orderBy("id").limit(50),
    large_findmany: (_i, n) => k("posts").select(PC).orderBy("id").limit(n),
    stream: async (_i, n) => {
      let count = 0, views = 0, first: string | undefined, last: string | undefined;
      for await (const r of k("posts").select(PC).orderBy("id").limit(n).stream()) { count++; views += Number(r.views); first ??= r.id; last = r.id; }
      return { count, first, last, views };
    },

    create: async (i) => { const u = userData(wid(T, "create", i)); await k("users").insert(uVals(u)); return u; },
    create_many: async (i) => {
      const rows = Array.from({ length: 1000 }, (_, j) => uVals({ ...userData(`${wid(T, "cm", i)}_${j}`, wid(T, "cm", i)), role: "USER" as any }));
      // Knex's SQLite insert is a UNION ALL chain, capped at 500 terms per
      // statement; SQL Server caps a statement at 2 100 parameters.
      await k.batchInsert("users", rows, ms ? 250 : d === "sqlite" ? 400 : 1000);
      return { count: rows.length };
    },
    nested_create: (i) => k.transaction(async (trx: any) => {
      const Uid = wid(T, "nc", i);
      await trx("users").insert(uVals(userData(Uid)));
      await trx("profiles").insert({ id: `${Uid}_pr`, user_id: Uid, bio: "nested bio" });
      await trx("posts").insert([0, 1, 2].map((j) => pVals(postData(`${Uid}_p${j}`, Uid, j))));
      const names = [...P.connectTags, wid(T, "nctag", i)];
      const rows = names.map((name, j) => ({ id: `t_${Uid}_${j}`, name }));
      if (ms) for (const t of rows) await trx.raw(`INSERT INTO tags (id, name) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM tags WHERE name = ?)`, [t.id, t.name, t.name]);
      else await trx("tags").insert(rows).onConflict("name").ignore();
      const byName = new Map((await trx("tags").select(["id", "name"]).whereIn("name", names)).map((t: any) => [t.name, t.id]));
      await trx("post_tags").insert(names.map((name, j) => ({ id: `${Uid}_p0_pt${j}`, post_id: `${Uid}_p0`, tag_id: byName.get(name) })));
      return { id: Uid };
    }),
    update_by_id: async (i) => {
      const id = P.updUser(i);
      if (d === "mysql") {
        await k("users").update({ name: `Renamed ${i}` }).where("id", id);
        return k("users").select(["id", "name", "email"]).where("id", id).first();
      }
      return (await k("users").update({ name: `Renamed ${i}` }, ["id", "name", "email"]).where("id", id))[0];
    },
    update_many: async (i) => ({ count: affected(await k("posts").update({ views: 42 }).where("author_id", P.updManyAuthor(i))) }),
    increment_concurrent: (i) => Promise.all(Array.from({ length: 20 }, () => k("posts").increment("views", 1).where("id", wid(T, "inc", i)))),
    upsert_insert: (i) => upsert(userData(wid(T, "ups", i)), "Upserted"),
    upsert_update: (i) => upsert({ ...userData(wid(T, "upu", i)), email: P.upsertUpdateEmail }, "Upserted 5"),
    delete_cascade: (i) => k("users").where("id", wid(T, "dc", i)).del(),
    delete_many: async (i) => ({ count: affected(await k("users").where("name", wid(T, "dm", i)).del()) }),
    tx_interactive: (i) => k.transaction(async (trx: any) => {
      const Uid = wid(T, "tx", i);
      await trx("users").insert(uVals(userData(Uid)));
      await trx("posts").insert(pVals(postData(`${Uid}_p`, Uid, 0)));
      const { n } = await trx("posts").count({ n: "*" }).where("author_id", Uid).first();
      await trx("users").update({ name: `has ${Number(n)} posts` }).where("id", Uid);
      await trx("comments").insert({ id: `${Uid}_c`, post_id: `${Uid}_p`, author_id: Uid, parent_id: null, body: "tx", created_at: F.date(new Date(S.BASE_TIME)) });
      return n;
    }),
    tx_rollback: async (i) => {
      try {
        await k.transaction(async (trx: any) => { await trx("users").insert(uVals(userData(wid(T, "rb", i)))); throw new Error("rollback"); });
      } catch (e: any) { if (e.message !== "rollback") throw e; }
      return null;
    },
    optimistic_update: async (i) => {
      const id = wid(T, "occ", i);
      const { version } = await k("posts").select("version").where("id", id).first();
      const fresh = affected(await k("posts").update({ version: version + 1, title: "occ" }).where({ id, version }));
      const stale = affected(await k("posts").update({ version: version + 1, title: "stale" }).where({ id, version }));
      return { fresh, stale };
    },
  };
  for (const key of Object.keys(na)) delete (ops as any)[key];
  Object.assign(ops, knexLadder({ k, d, F, T, U, uVals, pVals, affected, upsert }));
  for (const key of Object.keys(na)) delete (ops as any)[key];
  return { ops, na, close: () => k.destroy() };
}
