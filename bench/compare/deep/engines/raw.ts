// The baseline: hand-written SQL straight to the driver. Relations are loaded
// the way a careful hand-rolled data layer does it: one query per level with
// IN lists (window functions where a level is limited per parent), or a single
// join/subquery where that is clearly best. See README "raw baseline".

import { EngineImpl, groupInto, haversine, indexBy } from "../core";
import type { DialectCtx } from "../dialects";
import { params, postData, userData, wid } from "../scenarios";
import * as S from "../schema";
import { frag, PLACEHOLDERS as Q, sqlClient, Sql } from "./sql";
import { rawLadder } from "../ladder";

export const USER_COLS = "id, email, name, role, active, created_at, prefs";
export const POST_COLS = "id, author_id, title, body, status, views, version, published_at, created_at, meta";
const COMMENT_COLS = "id, post_id, author_id, parent_id, body, created_at";

export async function rawEngine(ctx: DialectCtx): Promise<EngineImpl> {
  if (ctx.dialect === "mongo") return (await import("./raw-mongo")).rawMongoEngine(ctx);
  const c = sqlClient(ctx);
  const d = ctx.dialect;
  const F = frag(d);
  const P = params(ctx.sizes);
  const T = "raw";
  const na: Record<string, string> = {};
  if (!ctx.features.geo) na.geo_near = "no spatial support on this server";
  if (!ctx.features.fts) na.fts = "no full-text index on this server";

  const userVals = (u: ReturnType<typeof userData>) => [u.id, u.email, u.name, u.role, F.bool(u.active), F.date(u.created_at), F.json(u.prefs)];
  const postVals = (p: ReturnType<typeof postData>) => [p.id, p.author_id, p.title, p.body, p.status, p.views, p.version, p.published_at, F.date(p.created_at), F.json(p.meta)];
  const insertUsers = async (cl: Sql, rows: ReturnType<typeof userData>[]) => {
    const chunk = d === "mssql" ? 250 : 1000;
    let n = 0;
    for (let i = 0; i < rows.length; i += chunk) {
      const part = rows.slice(i, i + chunk);
      n += await cl.run(`INSERT INTO users (${USER_COLS}) VALUES ${part.map(() => `(${Q(7)})`).join(", ")}`, part.flatMap(userVals));
    }
    return n;
  };
  const ids = (rows: any[], k = "id") => [...new Set(rows.map((r) => r[k]).filter((v) => v != null))];

  const geo = async () => {
    const { lng, lat } = S.GEO_CENTER;
    const r = P.geoRadius;
    switch (d) {
      case "postgres":
        return c.all(`SELECT id, name FROM places WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?) ORDER BY ST_Distance(location, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography), id LIMIT 20`, [lng, lat, r, lng, lat]);
      case "mysql":
        return c.all(`SELECT id, name, ST_Distance_Sphere(location, ST_GeomFromText(?, 4326)) AS dist FROM places HAVING dist < ? ORDER BY dist, id LIMIT 20`, [`POINT(${lat} ${lng})`, r]);
      case "duckdb":
        return c.all(`SELECT id, name FROM places WHERE ST_Distance_Sphere(location, ST_Point(?, ?)) < ? ORDER BY ST_Distance_Sphere(location, ST_Point(?, ?)), id LIMIT 20`, [lng, lat, r, lng, lat]);
      case "mssql":
        return c.all(`SELECT id, name FROM places WHERE location.STDistance(geography::Point(?, ?, 4326)) < ? ORDER BY location.STDistance(geography::Point(?, ?, 4326)), id ${F.page(20)}`, [lat, lng, r, lat, lng]);
      case "sqlite": {
        // JSON point column (forge's fallback storage): bounding-box prefilter in SQL, exact distance in JS.
        const dLat = r / 111_320, dLng = r / (111_320 * Math.cos(lat * Math.PI / 180));
        const rows = await c.all(`SELECT id, name, location FROM places WHERE json_extract(location, '$.lng') BETWEEN ? AND ? AND json_extract(location, '$.lat') BETWEEN ? AND ?`, [lng - dLng, lng + dLng, lat - dLat, lat + dLat]);
        return rows.map((x: any) => ({ ...x, dist: haversine(JSON.parse(x.location), S.GEO_CENTER) }))
          .filter((x: any) => x.dist < r).sort((a: any, b: any) => a.dist - b.dist || a.id.localeCompare(b.id)).slice(0, 20);
      }
    }
    return [];
  };

  const insertTags = async (tx: Sql, rows: { id: string; name: string }[]) => {
    if (d === "mssql") {
      for (const t of rows) await tx.run(`INSERT INTO tags (id, name) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM tags WHERE name = ?)`, [t.id, t.name, t.name]);
    } else if (d === "mysql") {
      await tx.run(`INSERT IGNORE INTO tags (id, name) VALUES ${rows.map(() => "(?, ?)").join(", ")}`, rows.flatMap((t) => [t.id, t.name]));
    } else {
      await tx.run(`INSERT INTO tags (id, name) VALUES ${rows.map(() => "(?, ?)").join(", ")} ON CONFLICT (name) DO NOTHING`, rows.flatMap((t) => [t.id, t.name]));
    }
  };

  const upsert = (id: string, email: string, newName: string) => {
    const u = userData(id);
    const v = [u.id, email, u.name, u.role, F.bool(u.active), F.date(u.created_at), F.json(u.prefs)];
    if (d === "mysql") return c.run(`INSERT INTO users (${USER_COLS}) VALUES (${Q(7)}) ON DUPLICATE KEY UPDATE name = ?`, [...v, newName]);
    if (d === "mssql") return c.run(
      `MERGE users WITH (HOLDLOCK) AS t USING (SELECT ? AS email) AS s ON t.email = s.email
       WHEN MATCHED THEN UPDATE SET name = ?
       WHEN NOT MATCHED THEN INSERT (${USER_COLS}) VALUES (${Q(7)});`, [email, newName, ...v]);
    return c.run(`INSERT INTO users (${USER_COLS}) VALUES (${Q(7)}) ON CONFLICT (email) DO UPDATE SET name = ?`, [...v, newName]);
  };

  const ops: EngineImpl["ops"] = {
    pk: async (i) => (await c.all(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [P.pkUser(i)]))[0] ?? null,
    unique_email: async (i) => (await c.all(`SELECT ${USER_COLS} FROM users WHERE email = ?`, [P.emailUser(i)]))[0] ?? null,
    filter_offset: () => c.all(`SELECT ${USER_COLS} FROM users WHERE role = ? AND active = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC, id ASC ${F.page(20, P.filterSkip)}`,
      [P.filterRole, F.bool(true), F.date(P.filterFrom), F.date(P.filterTo)]),
    cursor: (i) => c.all(`SELECT ${POST_COLS} FROM posts WHERE id > ? ORDER BY id ${F.page(20)}`, [P.cursorAfter(i)]),
    count_filter: async () => (await c.all(`SELECT COUNT(*) AS n FROM posts WHERE status = ? AND views >= ?`, ["PUBLISHED", P.countMinViews]))[0].n,
    exists: async (i) => d === "mssql"
      ? (await c.all(`SELECT CASE WHEN EXISTS (SELECT 1 FROM users WHERE email = ?) THEN 1 ELSE 0 END AS e`, [P.existsEmail(i)]))[0].e
      : (await c.all(`SELECT 1 AS e FROM users WHERE email = ? ${F.page(1)}`, [P.existsEmail(i)])).length > 0,
    select_cols: (i) => c.all(`SELECT id, title, views FROM posts WHERE author_id = ? ORDER BY id`, [P.selectAuthor(i)]),
    in_100: () => c.all(`SELECT id, email FROM users WHERE id IN (${Q(P.in100.length)})`, P.in100),
    or_not_like: () => c.all(`SELECT ${USER_COLS} FROM users WHERE (${F.ilike("name")} OR email LIKE ?) AND NOT (role = ?) ORDER BY id ${F.page(50)}`,
      [`%${P.likeName.toLowerCase()}%`, `${P.likePrefix}%`, "ADMIN"]),
    rel_some: () => c.all(`SELECT u.id FROM users u WHERE EXISTS (SELECT 1 FROM posts p WHERE p.author_id = u.id AND p.status = ?) ORDER BY u.id ${F.page(50)}`, ["PUBLISHED"]),
    rel_none: () => c.all(`SELECT u.id FROM users u WHERE NOT EXISTS (SELECT 1 FROM posts p WHERE p.author_id = u.id AND p.status = ?) ORDER BY u.id ${F.page(50)}`, ["PUBLISHED"]),
    rel_every: () => c.all(`SELECT u.id FROM users u WHERE NOT EXISTS (SELECT 1 FROM posts p WHERE p.author_id = u.id AND p.status <> ?) ORDER BY u.id ${F.page(50)}`, ["PUBLISHED"]),

    include_1: async (_i, n) => {
      const posts = await c.all(`SELECT ${POST_COLS} FROM posts WHERE status = ? ORDER BY id ${F.page(n)}`, ["PUBLISHED"]);
      const a = ids(posts, "author_id");
      const authors = a.length ? indexBy(await c.all(`SELECT ${USER_COLS} FROM users WHERE id IN (${Q(a.length)})`, a), (u: any) => u.id) : new Map();
      for (const p of posts) p.author = authors.get(p.author_id) ?? null;
      return posts;
    },
    include_2: async (_i, n) => {
      const users = await c.all(`SELECT ${USER_COLS} FROM users ORDER BY id ${F.page(n)}`);
      const u = ids(users);
      const posts = u.length ? await c.all(`SELECT ${POST_COLS} FROM posts WHERE author_id IN (${Q(u.length)}) ORDER BY id`, u) : [];
      const p = ids(posts);
      const comments = p.length ? await c.all(`SELECT ${COMMENT_COLS} FROM comments WHERE post_id IN (${Q(p.length)}) ORDER BY id`, p) : [];
      groupInto(posts, comments, (x: any) => x.id, (x: any) => x.post_id, "comments");
      return groupInto(users, posts, (x: any) => x.id, (x: any) => x.author_id, "posts");
    },
    include_3: async (_i, n) => {
      const users = await c.all(`SELECT ${USER_COLS} FROM users WHERE active = ? ORDER BY id ${F.page(n)}`, [F.bool(true)]);
      const u = ids(users);
      const posts = u.length ? await c.all(
        `SELECT ${POST_COLS} FROM (SELECT ${POST_COLS}, ROW_NUMBER() OVER (PARTITION BY author_id ORDER BY published_at DESC, id ASC) AS rn
           FROM posts WHERE author_id IN (${Q(u.length)}) AND status = ?) x WHERE rn <= 5 ORDER BY author_id, published_at DESC, id`, [...u, "PUBLISHED"]) : [];
      const p = ids(posts);
      const comments = p.length ? await c.all(
        `SELECT ${COMMENT_COLS} FROM (SELECT ${COMMENT_COLS}, ROW_NUMBER() OVER (PARTITION BY post_id ORDER BY id) AS rn
           FROM comments WHERE post_id IN (${Q(p.length)})) x WHERE rn <= 3 ORDER BY post_id, id`, p) : [];
      const a = ids(comments, "author_id");
      const authors = a.length ? indexBy(await c.all(`SELECT id, email FROM users WHERE id IN (${Q(a.length)})`, a), (x: any) => x.id) : new Map();
      for (const cm of comments) cm.author = cm.author_id ? authors.get(cm.author_id) ?? null : null;
      groupInto(posts, comments, (x: any) => x.id, (x: any) => x.post_id, "comments");
      return groupInto(users, posts, (x: any) => x.id, (x: any) => x.author_id, "posts");
    },
    m2m_post_tags: async (_i, n) => {
      const rows = await c.all(
        `SELECT p.id, p.title, pt.id AS pt_id, t.id AS tag_id, t.name AS tag_name
           FROM (SELECT id, title FROM posts ORDER BY id ${F.page(n)}) p
           LEFT JOIN post_tags pt ON pt.post_id = p.id LEFT JOIN tags t ON t.id = pt.tag_id ORDER BY p.id`);
      const out: any[] = [];
      let cur: any;
      for (const r of rows) {
        if (!cur || cur.id !== r.id) { cur = { id: r.id, title: r.title, post_tags: [] }; out.push(cur); }
        if (r.pt_id) cur.post_tags.push({ id: r.pt_id, tag: { id: r.tag_id, name: r.tag_name } });
      }
      return out;
    },
    m2m_tag_counts: async () => (await c.all(
      `SELECT t.id, t.name, COUNT(pt.id) AS n FROM tags t LEFT JOIN post_tags pt ON pt.tag_id = t.id GROUP BY t.id, t.name ORDER BY t.name`))
      .map((r: any) => ({ ...r, _count: { post_tags: r.n } })),
    count_rel: async (_i, n) => (await c.all(
      `SELECT ${USER_COLS}, (SELECT COUNT(*) FROM posts p WHERE p.author_id = u.id) AS pc, (SELECT COUNT(*) FROM comments c WHERE c.author_id = u.id) AS cc
         FROM users u ORDER BY id ${F.page(n)}`)).map((r: any) => ({ ...r, _count: { posts: r.pc, comments: r.cc } })),
    aggregate: async () => {
      const avg = d === "mssql" ? "AVG(CAST(views AS FLOAT))" : "AVG(views)";
      const r = (await c.all(`SELECT COUNT(*) AS n, SUM(views) AS s, ${avg} AS a, MIN(views) AS mn, MAX(views) AS mx FROM posts WHERE status = ?`, ["PUBLISHED"]))[0];
      return { _count: { _all: r.n }, _sum: { views: r.s }, _avg: { views: r.a }, _min: { views: r.mn }, _max: { views: r.mx } };
    },
    groupby: async () => (await c.all(
      `SELECT author_id, COUNT(*) AS n, SUM(views) AS s FROM posts WHERE status <> ? GROUP BY author_id HAVING COUNT(*) >= ? ORDER BY SUM(views) DESC, author_id ${F.page(20)}`,
      ["DRAFT", P.groupMinCount])).map((r: any) => ({ author_id: r.author_id, _count: { _all: r.n }, _sum: { views: r.s } })),
    distinct: () => c.all(`SELECT DISTINCT author_id FROM posts WHERE views < ? ORDER BY author_id`, [P.distinctMaxViews]),
    json_prefs: () => c.all(`SELECT id FROM users WHERE ${F.jsonStr("prefs", "theme")} = ? AND ${F.jsonNum("prefs", "score")} >= ? ORDER BY id ${F.page(100)}`, [P.jsonTheme, P.jsonMinScore]),
    json_meta: async () => (await c.all(`SELECT COUNT(*) AS n FROM posts WHERE ${F.jsonStr("meta", "lang")} = ? AND ${F.jsonNum("meta", "score")} >= ?`, [P.metaLang, P.metaMinScore]))[0].n,
    fts: () => c.all(`SELECT id FROM posts WHERE ${F.fts("body")} ORDER BY id ${F.page(50)}`, [P.ftsTerm]),
    geo_near: geo,
    large_findmany: (_i, n) => c.all(`SELECT ${POST_COLS} FROM posts ORDER BY id ${F.page(n)}`),
    stream: async (_i, n) => {
      let count = 0, views = 0, first: string | undefined, last: string | undefined;
      await c.stream(`SELECT ${POST_COLS} FROM posts ORDER BY id ${F.page(n)}`, [], (r) => { count++; views += Number(r.views); first ??= r.id; last = r.id; });
      return { count, first, last, views };
    },

    create: async (i) => { const u = userData(wid(T, "create", i)); await c.run(`INSERT INTO users (${USER_COLS}) VALUES (${Q(7)})`, userVals(u)); return u; },
    create_many: async (i) => ({ count: await insertUsers(c, Array.from({ length: 1000 }, (_, k) => ({ ...userData(`${wid(T, "cm", i)}_${k}`, wid(T, "cm", i)), role: "USER" as any }))) }),
    nested_create: (i) => c.tx(async (tx) => {
      const U = wid(T, "nc", i);
      await tx.run(`INSERT INTO users (${USER_COLS}) VALUES (${Q(7)})`, userVals(userData(U)));
      await tx.run(`INSERT INTO profiles (id, user_id, bio) VALUES (?, ?, ?)`, [`${U}_pr`, U, "nested bio"]);
      const posts = [0, 1, 2].map((k) => postData(`${U}_p${k}`, U, k));
      await tx.run(`INSERT INTO posts (${POST_COLS}) VALUES ${posts.map(() => `(${Q(10)})`).join(", ")}`, posts.flatMap(postVals));
      const names = [...P.connectTags, wid(T, "nctag", i)];
      await insertTags(tx, names.map((name, j) => ({ id: `t_${U}_${j}`, name })));
      const tags = await tx.all(`SELECT id, name FROM tags WHERE name IN (${Q(names.length)})`, names);
      const byName = indexBy(tags, (t: any) => t.name);
      await tx.run(`INSERT INTO post_tags (id, post_id, tag_id) VALUES ${names.map(() => "(?, ?, ?)").join(", ")}`,
        names.flatMap((name, j) => [`${U}_p0_pt${j}`, `${U}_p0`, byName.get(name).id]));
      return { id: U };
    }),
    update_by_id: async (i) => {
      const id = P.updUser(i), name = `Renamed ${i}`;
      if (F.returning) return (await c.all(`UPDATE users SET name = ? WHERE id = ? RETURNING id, name, email`, [name, id]))[0];
      if (d === "mssql") return (await c.all(`UPDATE users SET name = ? OUTPUT INSERTED.id, INSERTED.name, INSERTED.email WHERE id = ?`, [name, id]))[0];
      await c.run(`UPDATE users SET name = ? WHERE id = ?`, [name, id]);
      return (await c.all(`SELECT id, name, email FROM users WHERE id = ?`, [id]))[0];
    },
    update_many: async (i) => ({ count: await c.run(`UPDATE posts SET views = ? WHERE author_id = ?`, [42, P.updManyAuthor(i)]) }),
    increment_concurrent: (i) => Promise.all(Array.from({ length: 20 }, () => c.run(`UPDATE posts SET views = views + 1 WHERE id = ?`, [wid(T, "inc", i)]))),
    upsert_insert: (i) => { const id = wid(T, "ups", i); return upsert(id, `${id}@bench.dev`, "Upserted"); },
    upsert_update: (i) => upsert(wid(T, "upu", i), P.upsertUpdateEmail, "Upserted 5"),
    delete_cascade: async (i) => {
      const id = wid(T, "dc", i);
      if (d !== "duckdb") return c.run(`DELETE FROM users WHERE id = ?`, [id]);
      return c.tx(async (tx) => {
        await tx.run(`DELETE FROM post_tags WHERE post_id IN (SELECT id FROM posts WHERE author_id = ?)`, [id]);
        await tx.run(`DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE author_id = ?)`, [id]);
        await tx.run(`UPDATE comments SET author_id = NULL WHERE author_id = ?`, [id]);
        await tx.run(`DELETE FROM posts WHERE author_id = ?`, [id]);
        await tx.run(`DELETE FROM profiles WHERE user_id = ?`, [id]);
        return tx.run(`DELETE FROM users WHERE id = ?`, [id]);
      });
    },
    delete_many: async (i) => ({ count: await c.run(`DELETE FROM users WHERE name = ?`, [wid(T, "dm", i)]) }),
    tx_interactive: (i) => c.tx(async (tx) => {
      const U = wid(T, "tx", i);
      await tx.run(`INSERT INTO users (${USER_COLS}) VALUES (${Q(7)})`, userVals(userData(U)));
      await tx.run(`INSERT INTO posts (${POST_COLS}) VALUES (${Q(10)})`, postVals(postData(`${U}_p`, U, 0)));
      const n = Number((await tx.all(`SELECT COUNT(*) AS n FROM posts WHERE author_id = ?`, [U]))[0].n);
      await tx.run(`UPDATE users SET name = ? WHERE id = ?`, [`has ${n} posts`, U]);
      await tx.run(`INSERT INTO comments (${COMMENT_COLS}) VALUES (${Q(6)})`, [`${U}_c`, `${U}_p`, U, null, "tx", F.date(new Date(S.BASE_TIME))]);
      return n;
    }),
    tx_rollback: async (i) => {
      try {
        await c.tx(async (tx) => {
          await tx.run(`INSERT INTO users (${USER_COLS}) VALUES (${Q(7)})`, userVals(userData(wid(T, "rb", i))));
          throw new Error("rollback");
        });
      } catch (e: any) { if (e.message !== "rollback") throw e; }
      return null;
    },
    optimistic_update: async (i) => {
      const id = wid(T, "occ", i);
      const v = Number((await c.all(`SELECT version FROM posts WHERE id = ?`, [id]))[0].version);
      const fresh = await c.run(`UPDATE posts SET version = ?, title = ? WHERE id = ? AND version = ?`, [v + 1, "occ", id, v]);
      const stale = await c.run(`UPDATE posts SET version = ?, title = ? WHERE id = ? AND version = ?`, [v + 1, "stale", id, v]);
      return { fresh, stale };
    },
  };
  Object.assign(ops, rawLadder({ c, d, F, Q, T, USER_COLS, POST_COLS, userVals, postVals }));
  if (!ctx.features.tx) { na.tx_interactive = na.tx_rollback = na.tx_mixed = "no transactions on this server"; }
  for (const k of Object.keys(na)) delete (ops as any)[k];
  return { ops, na, close: async () => {} };
}
