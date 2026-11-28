// Kysely 0.29. Relations load in one statement through the documented
// jsonArrayFrom / jsonObjectFrom helpers for each dialect; JSON paths and
// full-text use the `sql` template, as Kysely has no operators for them.

import type { EngineImpl } from "../core";
import { POOL, DialectCtx } from "../dialects";
import { params, postData, userData, wid } from "../scenarios";
import * as S from "../schema";
import { frag } from "./sql";
import { knexLadder, kyselyLadder } from "../ladder";
import { USER_COLS, POST_COLS } from "./raw";

export async function kyselyEngine(ctx: DialectCtx): Promise<EngineImpl | { na: string }> {
  const d = ctx.dialect;
  if (d === "mongo") return { na: "Kysely is SQL only" };
  if (d === "duckdb") return { na: "Kysely has no first-party DuckDB dialect" };

  const K: any = await import("kysely");
  const { sql } = K;
  const helperMod = d === "postgres" ? "postgres" : d;
  const { jsonArrayFrom, jsonObjectFrom } = await import(`kysely/helpers/${helperMod}`);
  let dialect: any;
  if (d === "postgres") dialect = new K.PostgresDialect({ pool: ctx.pg });
  else if (d === "mysql") dialect = new K.MysqlDialect({ pool: ctx.mysql.pool });
  else if (d === "sqlite") dialect = new K.SqliteDialect({ database: ctx.sqlite });
  else {
    const tedious = require("tedious"), tarn = require("tarn");
    const c = ctx.conn;
    dialect = new K.MssqlDialect({
      tarn: { ...tarn, options: { min: 0, max: POOL } },
      tedious: { ...tedious, connectionFactory: () => new tedious.Connection({
        server: c.server, options: { port: c.port, database: c.database, encrypt: false, trustServerCertificate: true },
        authentication: { type: "default", options: { userName: c.user, password: c.password } },
      }) },
      validateConnections: false,
    });
  }
  // SQLite and SQL Server hand nested JSON back as text.
  const plugins = d === "sqlite" || d === "mssql" ? [new K.ParseJSONResultsPlugin()] : [];
  const db = new K.Kysely({ dialect, plugins });

  const P = params(ctx.sizes);
  const F = frag(d);
  const T = "kysely";
  const ms = d === "mssql";
  const lim = (qb: any, n: number) => (ms ? qb.top(n) : qb.limit(n));
  // SQL Server rejects ORDER BY in a derived table unless TOP or OFFSET is
  // present, and jsonArrayFrom wraps its argument in one.
  const ordered = (qb: any) => (ms ? qb.offset(0) : qb);
  const frg = (text: string, ...vals: unknown[]) => {
    const parts = text.split("?");
    let out = sql.raw(parts[0]);
    for (let k = 1; k < parts.length; k++) out = sql`${out}${vals[k - 1]}${sql.raw(parts[k])}`;
    return out;
  };
  const cols = (list: string, alias?: string) => list.split(", ").map((c) => (alias ? `${alias}.${c}` : c));
  const uVals = (u: ReturnType<typeof userData>) => ({ ...u, active: F.bool(u.active), created_at: F.date(u.created_at), prefs: F.json(u.prefs) });
  const pVals = (p: ReturnType<typeof postData>) => ({ ...p, created_at: F.date(p.created_at), meta: F.json(p.meta) });
  const n0 = (v: any) => Number(v ?? 0);

  const na: Record<string, string> = { geo_near: "Kysely has no geo operators; it would be the same hand-written SQL as raw" };
  if (d === "postgres") na.stream = "Kysely's Postgres stream needs pg-cursor (not installed)";
  if (!ctx.features.fts) na.fts = "no full-text index on this server";

  const insertUsers = async (q: any, rows: any[]) => {
    const chunk = ms ? 250 : 1000;
    let n = 0;
    for (let i = 0; i < rows.length; i += chunk) {
      const r = await q.insertInto("users").values(rows.slice(i, i + chunk).map(uVals)).executeTakeFirst();
      n += Number(r.numInsertedOrUpdatedRows ?? r.numInsertedRows ?? 0);
    }
    return n;
  };
  const upsert = (u: ReturnType<typeof userData>, name: string) => {
    const v = uVals(u);
    if (d === "mysql") return db.insertInto("users").values(v).onDuplicateKeyUpdate({ name }).execute();
    if (ms) return sql`MERGE users WITH (HOLDLOCK) AS t USING (SELECT ${u.email} AS email) AS s ON t.email = s.email
      WHEN MATCHED THEN UPDATE SET name = ${name}
      WHEN NOT MATCHED THEN INSERT (${sql.raw(USER_COLS)}) VALUES (${v.id}, ${v.email}, ${v.name}, ${v.role}, ${v.active}, ${v.created_at}, ${v.prefs});`.execute(db);
    return db.insertInto("users").values(v).onConflict((oc: any) => oc.column("email").doUpdateSet({ name })).execute();
  };

  const ops: EngineImpl["ops"] = {
    pk: (i) => db.selectFrom("users").selectAll().where("id", "=", P.pkUser(i)).executeTakeFirst().then((r: any) => r ?? null),
    unique_email: (i) => db.selectFrom("users").selectAll().where("email", "=", P.emailUser(i)).executeTakeFirst().then((r: any) => r ?? null),
    filter_offset: () => {
      const q = db.selectFrom("users").selectAll()
        .where("role", "=", P.filterRole).where("active", "=", F.bool(true))
        .where("created_at", ">=", F.date(P.filterFrom)).where("created_at", "<", F.date(P.filterTo))
        .orderBy("created_at", "desc").orderBy("id", "asc");
      return (ms ? q.offset(P.filterSkip).fetch(20) : q.limit(20).offset(P.filterSkip)).execute();
    },
    cursor: (i) => lim(db.selectFrom("posts").selectAll().where("id", ">", P.cursorAfter(i)).orderBy("id"), 20).execute(),
    count_filter: async () => (await db.selectFrom("posts").select((eb: any) => eb.fn.countAll().as("n"))
      .where("status", "=", "PUBLISHED").where("views", ">=", P.countMinViews).executeTakeFirstOrThrow()).n,
    exists: async (i) => (await lim(db.selectFrom("users").select("id").where("email", "=", P.existsEmail(i)), 1).executeTakeFirst()) !== undefined,
    select_cols: (i) => db.selectFrom("posts").select(["id", "title", "views"]).where("author_id", "=", P.selectAuthor(i)).orderBy("id").execute(),
    in_100: () => db.selectFrom("users").select(["id", "email"]).where("id", "in", P.in100).execute(),
    or_not_like: () => lim(db.selectFrom("users").selectAll()
      .where((eb: any) => eb.and([
        eb.or([eb(eb.fn("lower", ["name"]), "like", `%${P.likeName.toLowerCase()}%`), eb("email", "like", `${P.likePrefix}%`)]),
        eb.not(eb("role", "=", "ADMIN")),
      ])).orderBy("id"), 50).execute(),
    rel_some: () => lim(db.selectFrom("users as u").select("u.id")
      .where((eb: any) => eb.exists(eb.selectFrom("posts as p").select(eb.lit(1).as("x")).whereRef("p.author_id", "=", "u.id").where("p.status", "=", "PUBLISHED")))
      .orderBy("u.id"), 50).execute(),
    rel_none: () => lim(db.selectFrom("users as u").select("u.id")
      .where((eb: any) => eb.not(eb.exists(eb.selectFrom("posts as p").select(eb.lit(1).as("x")).whereRef("p.author_id", "=", "u.id").where("p.status", "=", "PUBLISHED"))))
      .orderBy("u.id"), 50).execute(),
    rel_every: () => lim(db.selectFrom("users as u").select("u.id")
      .where((eb: any) => eb.not(eb.exists(eb.selectFrom("posts as p").select(eb.lit(1).as("x")).whereRef("p.author_id", "=", "u.id").where("p.status", "<>", "PUBLISHED"))))
      .orderBy("u.id"), 50).execute(),
    include_1: (_i, n) => lim(db.selectFrom("posts as p").select(cols(POST_COLS, "p"))
      .select((eb: any) => jsonObjectFrom(eb.selectFrom("users as a").select(cols(USER_COLS, "a")).whereRef("a.id", "=", "p.author_id")).as("author"))
      .where("p.status", "=", "PUBLISHED").orderBy("p.id"), n).execute(),
    include_2: (_i, n) => lim(db.selectFrom("users as u").select(cols(USER_COLS, "u"))
      .select((eb: any) => jsonArrayFrom(ordered(eb.selectFrom("posts as p").select(cols(POST_COLS, "p"))
        .select((eb2: any) => jsonArrayFrom(ordered(eb2.selectFrom("comments as c").select(["c.id", "c.post_id", "c.body"]).whereRef("c.post_id", "=", "p.id").orderBy("c.id"))).as("comments"))
        .whereRef("p.author_id", "=", "u.id").orderBy("p.id"))).as("posts"))
      .orderBy("u.id"), n).execute(),
    include_3: (_i, n) => lim(db.selectFrom("users as u").select(cols(USER_COLS, "u"))
      .select((eb: any) => jsonArrayFrom(lim(eb.selectFrom("posts as p").select(["p.id", "p.title", "p.published_at"])
        .select((eb2: any) => jsonArrayFrom(lim(eb2.selectFrom("comments as c").select(["c.id", "c.author_id"])
          .select((eb3: any) => jsonObjectFrom(eb3.selectFrom("users as a").select(["a.id", "a.email"]).whereRef("a.id", "=", "c.author_id")).as("author"))
          .whereRef("c.post_id", "=", "p.id").orderBy("c.id"), 3)).as("comments"))
        .whereRef("p.author_id", "=", "u.id").where("p.status", "=", "PUBLISHED").orderBy("p.published_at", "desc").orderBy("p.id"), 5)).as("posts"))
      .where("u.active", "=", F.bool(true)).orderBy("u.id"), n).execute(),
    m2m_post_tags: (_i, n) => lim(db.selectFrom("posts as p").select(["p.id", "p.title"])
      .select((eb: any) => jsonArrayFrom(eb.selectFrom("post_tags as pt").select(["pt.id"])
        .select((eb2: any) => jsonObjectFrom(eb2.selectFrom("tags as t").select(["t.id", "t.name"]).whereRef("t.id", "=", "pt.tag_id")).as("tag"))
        .whereRef("pt.post_id", "=", "p.id")).as("post_tags"))
      .orderBy("p.id"), n).execute(),
    m2m_tag_counts: async () => (await db.selectFrom("tags as t").leftJoin("post_tags as pt", "pt.tag_id", "t.id")
      .select(["t.id", "t.name", (eb: any) => eb.fn.count("pt.id").as("n")]).groupBy(["t.id", "t.name"]).orderBy("t.name").execute())
      .map((r: any) => ({ ...r, _count: { post_tags: r.n } })),
    count_rel: async (_i, n) => (await lim(db.selectFrom("users as u").select(cols(USER_COLS, "u")).select((eb: any) => [
      eb.selectFrom("posts as p").select(eb.fn.countAll().as("c")).whereRef("p.author_id", "=", "u.id").as("pc"),
      eb.selectFrom("comments as c").select(eb.fn.countAll().as("c")).whereRef("c.author_id", "=", "u.id").as("cc"),
    ]).orderBy("u.id"), n).execute()).map((r: any) => ({ ...r, _count: { posts: r.pc, comments: r.cc } })),
    aggregate: async () => {
      const r = await db.selectFrom("posts").where("status", "=", "PUBLISHED").select((eb: any) => [
        eb.fn.countAll().as("n"), eb.fn.sum("views").as("s"),
        (ms ? eb.fn.avg(sql`CAST(views AS FLOAT)`) : eb.fn.avg("views")).as("a"),
        eb.fn.min("views").as("mn"), eb.fn.max("views").as("mx"),
      ]).executeTakeFirstOrThrow();
      return { _count: { _all: r.n }, _sum: { views: r.s }, _avg: { views: r.a }, _min: { views: r.mn }, _max: { views: r.mx } };
    },
    groupby: async () => (await lim(db.selectFrom("posts").select(["author_id", (eb: any) => eb.fn.countAll().as("n"), (eb: any) => eb.fn.sum("views").as("s")])
      .where("status", "<>", "DRAFT").groupBy("author_id").having((eb: any) => eb.fn.countAll(), ">=", P.groupMinCount)
      .orderBy((eb: any) => eb.fn.sum("views"), "desc").orderBy("author_id"), 20).execute())
      .map((r: any) => ({ author_id: r.author_id, _count: { _all: r.n }, _sum: { views: r.s } })),
    distinct: () => db.selectFrom("posts").select("author_id").distinct().where("views", "<", P.distinctMaxViews).orderBy("author_id").execute(),
    json_prefs: () => lim(db.selectFrom("users").select("id")
      .where(frg(`${F.jsonStr("prefs", "theme")} = ?`, P.jsonTheme)).where(frg(`${F.jsonNum("prefs", "score")} >= ?`, P.jsonMinScore)).orderBy("id"), 100).execute(),
    ci_equals: (i) => lim(db.selectFrom("users").select("id").where(frg(`LOWER(email) = LOWER(?)`, P.ciEmail(i))).orderBy("id"), 1).execute(),
    json_ci: () => lim(db.selectFrom("users").select("id").where(frg(`LOWER(${F.jsonStr("prefs", "theme")}) = LOWER(?)`, P.jsonThemeCi)).orderBy("id"), 100).execute(),
    json_meta: async () => (await db.selectFrom("posts").select((eb: any) => eb.fn.countAll().as("n"))
      .where(frg(`${F.jsonStr("meta", "lang")} = ?`, P.metaLang)).where(frg(`${F.jsonNum("meta", "score")} >= ?`, P.metaMinScore)).executeTakeFirstOrThrow()).n,
    fts: () => lim(db.selectFrom("posts").select("id").where(frg(F.fts("body"), P.ftsTerm)).orderBy("id"), 50).execute(),
    large_findmany: (_i, n) => lim(db.selectFrom("posts").selectAll().orderBy("id"), n).execute(),
    stream: async (_i, n) => {
      let count = 0, views = 0, first: string | undefined, last: string | undefined;
      for await (const r of lim(db.selectFrom("posts").selectAll().orderBy("id"), n).stream(1000)) { count++; views += Number(r.views); first ??= r.id; last = r.id; }
      return { count, first, last, views };
    },

    create: async (i) => { const u = userData(wid(T, "create", i)); await db.insertInto("users").values(uVals(u)).execute(); return u; },
    create_many: async (i) => ({ count: await insertUsers(db, Array.from({ length: 1000 }, (_, k) => ({ ...userData(`${wid(T, "cm", i)}_${k}`, wid(T, "cm", i)), role: "USER" }))) }),
    nested_create: (i) => db.transaction().execute(async (trx: any) => {
      const U = wid(T, "nc", i);
      await trx.insertInto("users").values(uVals(userData(U))).execute();
      await trx.insertInto("profiles").values({ id: `${U}_pr`, user_id: U, bio: "nested bio" }).execute();
      await trx.insertInto("posts").values([0, 1, 2].map((k) => pVals(postData(`${U}_p${k}`, U, k)))).execute();
      const names = [...P.connectTags, wid(T, "nctag", i)];
      const rows = names.map((name, j) => ({ id: `t_${U}_${j}`, name }));
      if (d === "mysql") await trx.insertInto("tags").ignore().values(rows).execute();
      else if (ms) for (const t of rows) await sql`INSERT INTO tags (id, name) SELECT ${t.id}, ${t.name} WHERE NOT EXISTS (SELECT 1 FROM tags WHERE name = ${t.name})`.execute(trx);
      else await trx.insertInto("tags").values(rows).onConflict((oc: any) => oc.column("name").doNothing()).execute();
      const found = await trx.selectFrom("tags").select(["id", "name"]).where("name", "in", names).execute();
      const byName = new Map(found.map((t: any) => [t.name, t.id]));
      await trx.insertInto("post_tags").values(names.map((name, j) => ({ id: `${U}_p0_pt${j}`, post_id: `${U}_p0`, tag_id: byName.get(name) }))).execute();
      return { id: U };
    }),
    update_by_id: async (i) => {
      const id = P.updUser(i);
      const q = db.updateTable("users").set({ name: `Renamed ${i}` }).where("id", "=", id);
      if (F.returning) return q.returning(["id", "name", "email"]).executeTakeFirst();
      if (ms) return q.output(["inserted.id", "inserted.name", "inserted.email"]).executeTakeFirst();
      await q.execute();
      return db.selectFrom("users").select(["id", "name", "email"]).where("id", "=", id).executeTakeFirst();
    },
    update_many: async (i) => ({ count: n0((await db.updateTable("posts").set({ views: 42 }).where("author_id", "=", P.updManyAuthor(i)).executeTakeFirst()).numUpdatedRows) }),
    increment_concurrent: (i) => Promise.all(Array.from({ length: 20 }, () =>
      db.updateTable("posts").set((eb: any) => ({ views: eb("views", "+", 1) })).where("id", "=", wid(T, "inc", i)).execute())),
    upsert_insert: (i) => upsert(userData(wid(T, "ups", i)), "Upserted"),
    upsert_update: (i) => upsert({ ...userData(wid(T, "upu", i)), email: P.upsertUpdateEmail }, "Upserted 5"),
    delete_cascade: (i) => db.deleteFrom("users").where("id", "=", wid(T, "dc", i)).execute(),
    delete_many: async (i) => ({ count: n0((await db.deleteFrom("users").where("name", "=", wid(T, "dm", i)).executeTakeFirst()).numDeletedRows) }),
    tx_interactive: (i) => db.transaction().execute(async (trx: any) => {
      const U = wid(T, "tx", i);
      await trx.insertInto("users").values(uVals(userData(U))).execute();
      await trx.insertInto("posts").values(pVals(postData(`${U}_p`, U, 0))).execute();
      const { n } = await trx.selectFrom("posts").select((eb: any) => eb.fn.countAll().as("n")).where("author_id", "=", U).executeTakeFirstOrThrow();
      await trx.updateTable("users").set({ name: `has ${Number(n)} posts` }).where("id", "=", U).execute();
      await trx.insertInto("comments").values({ id: `${U}_c`, post_id: `${U}_p`, author_id: U, parent_id: null, body: "tx", created_at: F.date(new Date(S.BASE_TIME)) }).execute();
      return n;
    }),
    tx_rollback: async (i) => {
      try {
        await db.transaction().execute(async (trx: any) => {
          await trx.insertInto("users").values(uVals(userData(wid(T, "rb", i)))).execute();
          throw new Error("rollback");
        });
      } catch (e: any) { if (e.message !== "rollback") throw e; }
      return null;
    },
    optimistic_update: async (i) => {
      const id = wid(T, "occ", i);
      const { version } = await db.selectFrom("posts").select("version").where("id", "=", id).executeTakeFirstOrThrow();
      const upd = (title: string) => db.updateTable("posts").set({ version: version + 1, title }).where("id", "=", id).where("version", "=", version).executeTakeFirst();
      const fresh = n0((await upd("occ")).numUpdatedRows);
      const stale = n0((await upd("stale")).numUpdatedRows);
      return { fresh, stale };
    },
  };
  for (const k of Object.keys(na)) delete (ops as any)[k];
  // Kysely's destroy() would end the pg / mysql2 pools it was handed, which
  // belong to the dialect context; only the dialects it owns are torn down.
  Object.assign(ops, kyselyLadder({ db, sql, d, F, T, lim, frg, jsonArrayFrom, jsonObjectFrom, uVals, pVals, n0, upsert, cols, USER_COLS }));
  for (const key of Object.keys(na)) delete (ops as any)[key];
  return { ops, na, close: async () => { if (ms) await db.destroy(); } };
}
