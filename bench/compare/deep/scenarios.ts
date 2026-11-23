// The scenario catalogue. Each entry fixes the SEMANTICS (what rows must come
// back); every engine expresses it its own idiomatic way in engines/*.ts.
//
// `canon` turns an engine's natural result into a comparable value, coercing
// each field it reads, so engines that disagree only on representation (0/1 vs
// boolean, ISO text vs Date, JSON text vs object) still compare equal.
//
// Write scenarios own their rows: ids and emails embed the engine tag
// (`xforge_…`, `xraw_…`), which stable() masks before comparison. Their
// `before` / `after` / `check` hooks run through forge with counting paused.

import { C } from "./core";
import type { DialectCtx } from "./dialects";
import * as S from "./schema";

export type Need = "geo" | "fts" | "tx" | "json";

export interface Scenario {
  name: string;
  kind: "read" | "write";
  desc: string;
  n?: number;
  probe?: [number, number];
  needs?: Need[];
  before?(ctx: DialectCtx, tag: string, i: number): Promise<void>;
  after?(ctx: DialectCtx, tag: string, i: number): Promise<void>;
  check?(ctx: DialectCtx, tag: string, i: number): Promise<unknown>;
  canon(v: any): unknown;
}

// Every engine reads its parameters from here so all of them hit the same rows.
export function params(s: S.SeedSizes) {
  const U = s.users;
  const uniq = (a: string[]) => [...new Set(a)];
  return {
    pkUser: (i: number) => S.userId(((i * 37) % U) + 1),
    emailUser: (i: number) => S.emailFor(((i * 53) % U) + 1),
    filterRole: "USER" as const,
    filterFrom: S.userCreated(10),
    filterTo: S.userCreated(Math.max(11, U - 10)),
    filterSkip: U >= 200 ? 20 : 2,
    cursorAfter: (i: number) => S.postId(100 + (i % 50)),
    countMinViews: 500,
    existsEmail: (i: number) => S.emailFor(((i * 11) % U) + 1),
    selectAuthor: (i: number) => S.userId(((i * 13) % U) + 1),
    in100: uniq(Array.from({ length: 100 }, (_, k) => S.userId(((k * 3) % U) + 1))),
    likeName: "alice",
    likePrefix: "bob.",
    geoRadius: 5000,
    ftsTerm: "kilo",
    distinctMaxViews: 100,
    groupMinCount: 7,
    jsonTheme: "dark",
    jsonMinScore: 20,
    metaLang: "fr",
    metaMinScore: 90,
    updUser: (i: number) => S.userId(((i * 7) % U) + 1),
    updManyAuthor: (i: number) => S.userId(((i * 17) % U) + 1),
    upsertUpdateEmail: S.emailFor(5),
    connectTags: ["tag-001", "tag-002"],
  };
}
export type Params = ReturnType<typeof params>;

export const wid = (tag: string, scen: string, i: number) => `x${tag}_${scen}_${i}`;

const userRow = (r: any) => r == null ? null : ({
  id: C.s(r.id), email: C.s(r.email), name: C.s(r.name), role: C.s(r.role),
  active: C.b(r.active), created_at: C.d(r.created_at), prefs: C.j(r.prefs),
});
const ids = (rows: any[]) => rows.map((r) => C.s(r.id ?? r._id));

// Fixture rows for the write scenarios, made through forge (counting paused).
async function mkUser(ctx: DialectCtx, id: string, extra: any = {}) {
  await ctx.forge.user.create({ data: {
    id, email: `${id}@bench.dev`, name: `Fixture ${id}`, role: "USER", active: true,
    created_at: new Date(S.BASE_TIME), prefs: { theme: "light", lang: "en", notify: false, score: 1 }, ...extra,
  } });
}
async function mkPost(ctx: DialectCtx, id: string, author: string, extra: any = {}) {
  await ctx.forge.post.create({ data: {
    id, author_id: author, title: `Fixture ${id}`, body: "fixture body", status: "DRAFT", views: 0, version: 0,
    published_at: null, created_at: new Date(S.BASE_TIME), meta: { lang: "en", score: 1, flags: [] }, ...extra,
  } });
}
// Children first, so cleanup works on DuckDB (no FK cascades) as well.
async function rmUserTree(ctx: DialectCtx, userIds: string[]) {
  const db = ctx.forge;
  const posts = await db.post.findMany({ where: { author_id: { in: userIds } }, select: { id: true } });
  const pids = posts.map((p: any) => p.id);
  if (pids.length) {
    await db.postTag.deleteMany({ where: { post_id: { in: pids } } });
    await db.comment.deleteMany({ where: { post_id: { in: pids } } });
    await db.post.deleteMany({ where: { id: { in: pids } } });
  }
  await db.comment.deleteMany({ where: { author_id: { in: userIds } } });
  await db.profile.deleteMany({ where: { user_id: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

export const SCENARIOS: Scenario[] = [
  // ─── Reads ────────────────────────────────────────────────────────────────
  { name: "pk", kind: "read", desc: "findUnique user by primary key", canon: userRow },
  { name: "unique_email", kind: "read", desc: "findUnique user by unique email", canon: userRow },
  { name: "filter_offset", kind: "read", desc: "users role=USER AND active AND created_at in range, ORDER BY created_at DESC, id; OFFSET 20 (2 on tiny seeds) LIMIT 20", canon: ids },
  { name: "cursor", kind: "read", desc: "posts ORDER BY id, 20 after a cursor id (exclusive)", canon: ids },
  { name: "count_filter", kind: "read", desc: "count posts status=PUBLISHED AND views >= 500", canon: C.n },
  { name: "exists", kind: "read", desc: "does a user with this email exist (boolean)", canon: C.b },
  { name: "select_cols", kind: "read", desc: "one author's posts, only id/title/views, ORDER BY id", canon: (rows: any[]) => rows.map((r) => ({ id: C.s(r.id), title: C.s(r.title), views: C.n(r.views) })) },
  { name: "in_100", kind: "read", desc: "users WHERE id IN (100 ids), id/email only", canon: (rows: any[]) => rows.map((r) => ({ id: C.s(r.id), email: C.s(r.email) })).sort((a, b) => a.id!.localeCompare(b.id!)) },
  { name: "or_not_like", kind: "read", desc: "users (name ILIKE %alice% OR email LIKE 'bob.%') AND NOT role=ADMIN, ORDER BY id LIMIT 50", canon: ids },
  { name: "rel_some", kind: "read", desc: "users with SOME published post, ORDER BY id LIMIT 50", canon: ids },
  { name: "rel_none", kind: "read", desc: "users with NO published post, ORDER BY id LIMIT 50", canon: ids },
  { name: "rel_every", kind: "read", desc: "users whose EVERY post is published (vacuous for users with none), ORDER BY id LIMIT 50", canon: ids },
  { name: "include_1", kind: "read", desc: "published posts ORDER BY id LIMIT n + author", n: 50, probe: [10, 40],
    canon: (rows: any[]) => rows.map((r) => ({ id: C.s(r.id), author: r.author ? { id: C.s(r.author.id), email: C.s(r.author.email) } : null })) },
  { name: "include_2", kind: "read", desc: "users ORDER BY id LIMIT n -> posts (by id) -> comments (by id)", n: 10, probe: [5, 20],
    canon: (rows: any[]) => rows.map((u) => ({ id: C.s(u.id), posts: (u.posts ?? []).map((p: any) => ({ id: C.s(p.id), comments: (p.comments ?? []).map((c: any) => C.s(c.id)) })) })) },
  { name: "include_3", kind: "read", desc: "active users LIMIT n -> posts(published, newest first, take 5) -> comments(by id, take 3) -> author(id,email)", n: 10, probe: [5, 20],
    canon: (rows: any[]) => rows.map((u) => ({ id: C.s(u.id), posts: (u.posts ?? []).map((p: any) => ({
      id: C.s(p.id), published_at: C.d(p.published_at),
      comments: (p.comments ?? []).map((c: any) => ({ id: C.s(c.id), author: c.author ? C.s(c.author.email) : null })),
    })) })) },
  { name: "m2m_post_tags", kind: "read", desc: "posts ORDER BY id LIMIT n with their tags (through post_tags)", n: 50, probe: [10, 40],
    canon: (rows: any[]) => rows.map((p) => ({ id: C.s(p.id), tags: (p.post_tags ?? []).map((pt: any) => C.s(pt.tag?.name)).sort() })) },
  { name: "m2m_tag_counts", kind: "read", desc: "every tag ORDER BY name with its post count", canon: (rows: any[]) => rows.map((t) => ({ name: C.s(t.name), count: C.n(t._count?.post_tags) })) },
  { name: "count_rel", kind: "read", desc: "users ORDER BY id LIMIT n with _count of posts and comments", n: 50, probe: [10, 40],
    canon: (rows: any[]) => rows.map((u) => ({ id: C.s(u.id), posts: C.n(u._count?.posts), comments: C.n(u._count?.comments) })) },
  { name: "aggregate", kind: "read", desc: "published posts: count, sum/avg/min/max views",
    canon: (a: any) => ({ count: C.n(a._count?._all ?? a._count), sum: C.n(a._sum?.views), avg: C.r(a._avg?.views), min: C.n(a._min?.views), max: C.n(a._max?.views) }) },
  { name: "groupby", kind: "read", desc: "non-draft posts GROUP BY author HAVING count >= 7, ORDER BY sum(views) DESC, author LIMIT 20",
    canon: (rows: any[]) => rows.map((r) => ({ author_id: C.s(r.author_id), count: C.n(r._count?._all), sum: C.n(r._sum?.views) })) },
  { name: "distinct", kind: "read", desc: "DISTINCT author_id of posts with views < 100, ORDER BY author_id", canon: (rows: any[]) => rows.map((r) => C.s(r.author_id ?? r)) },
  { name: "json_prefs", kind: "read", needs: ["json"], desc: "users WHERE prefs.theme = 'dark' AND prefs.score >= 20, ORDER BY id LIMIT 100", canon: ids },
  { name: "json_meta", kind: "read", needs: ["json"], desc: "count posts WHERE meta.lang = 'fr' AND meta.score >= 90", canon: C.n },
  { name: "fts", kind: "read", needs: ["fts"], desc: "posts whose body matches the word 'kilo', ORDER BY id LIMIT 50", canon: ids },
  { name: "geo_near", kind: "read", needs: ["geo"], desc: "places within 5 km of a point, nearest first, LIMIT 20", canon: ids },
  { name: "large_findmany", kind: "read", desc: "posts ORDER BY id LIMIT n (10k rows materialised)", n: 10000,
    canon: (rows: any[]) => ({ count: rows.length, first: C.s(rows[0]?.id), last: C.s(rows[rows.length - 1]?.id), views: rows.reduce((a, r) => a + Number(r.views), 0) }) },
  { name: "stream", kind: "read", desc: "posts ORDER BY id LIMIT n consumed row by row through the engine's streaming API", n: 10000,
    canon: (v: any) => v },

  // ─── Writes ───────────────────────────────────────────────────────────────
  { name: "create", kind: "write", desc: "create one user, return it",
    after: (ctx, tag, i) => ctx.forge.user.deleteMany({ where: { id: wid(tag, "create", i) } }),
    canon: userRow },
  { name: "create_many", kind: "write", desc: "createMany 1 000 users in one call",
    after: (ctx, tag, i) => ctx.forge.user.deleteMany({ where: { name: wid(tag, "cm", i) } }),
    canon: (v: any) => C.n(v?.count ?? v) },
  { name: "nested_create", kind: "write", desc: "user + profile + 3 posts, first post tagged (2 existing tags connectOrCreate'd + 1 new) in one call",
    check: async (ctx, tag, i) => {
      const u = await ctx.forge.user.findUnique({ where: { id: wid(tag, "nc", i) }, include: {
        profiles: true, posts: { orderBy: { id: "asc" }, include: { post_tags: { include: { tag: true } } } } } });
      const tags = await ctx.forge.tag.count();
      return { u, tags };
    },
    after: async (ctx, tag, i) => {
      await rmUserTree(ctx, [wid(tag, "nc", i)]);
      await ctx.forge.tag.deleteMany({ where: { name: wid(tag, "nctag", i) } });
    },
    canon: ({ u, tags }: any) => u == null ? null : ({
      id: C.s(u.id), profile: (u.profiles ?? []).map((p: any) => C.s(p.bio)),
      posts: (u.posts ?? []).map((p: any) => ({ id: C.s(p.id), tags: (p.post_tags ?? []).map((pt: any) => C.s(pt.tag?.name)).sort() })),
      tagCount: C.n(tags),
    }) },
  { name: "update_by_id", kind: "write", desc: "update one user's name by id, return the row",
    canon: (r: any) => ({ id: C.s(r?.id), name: C.s(r?.name), email: C.s(r?.email) }) },
  { name: "update_many", kind: "write", desc: "updateMany: set views = 42 on one author's posts, return the count",
    canon: (v: any) => C.n(v?.count ?? v) },
  { name: "increment_concurrent", kind: "write", desc: "20 concurrent atomic views += 1 on one row; the final value must be exactly 20",
    before: (ctx, tag, i) => mkPost(ctx, wid(tag, "inc", i), S.userId(1)),
    check: async (ctx, tag, i) => (await ctx.forge.post.findUnique({ where: { id: wid(tag, "inc", i) } }))?.views,
    after: (ctx, tag, i) => ctx.forge.post.deleteMany({ where: { id: wid(tag, "inc", i) } }),
    canon: C.n },
  { name: "upsert_insert", kind: "write", desc: "upsert on a new email (insert path)",
    after: (ctx, tag, i) => ctx.forge.user.deleteMany({ where: { id: wid(tag, "ups", i) } }),
    check: async (ctx, tag, i) => ctx.forge.user.findUnique({ where: { id: wid(tag, "ups", i) } }),
    canon: userRow },
  { name: "upsert_update", kind: "write", desc: "upsert on an existing email (update path)",
    check: async (ctx) => ctx.forge.user.findUnique({ where: { email: params(ctx.sizes).upsertUpdateEmail } }),
    canon: (r: any) => ({ id: C.s(r?.id), name: C.s(r?.name) }) },
  { name: "delete_cascade", kind: "write", desc: "delete a user that owns 3 posts x 2 comments + tags; posts, comments and post_tags must go",
    before: async (ctx, tag, i) => {
      const u = wid(tag, "dc", i);
      await mkUser(ctx, u);
      for (let k = 0; k < 3; k++) {
        const p = `${u}_p${k}`;
        await mkPost(ctx, p, u);
        await ctx.forge.comment.createMany({ data: [0, 1].map((c) => ({ id: `${p}_c${c}`, post_id: p, author_id: S.userId(1), parent_id: null, body: "x", created_at: new Date(S.BASE_TIME) })) });
        await ctx.forge.postTag.create({ data: { id: `${p}_t`, post_id: p, tag_id: S.tagId(1) } });
      }
    },
    check: async (ctx, tag, i) => {
      const u = wid(tag, "dc", i);
      const pids = [0, 1, 2].map((k) => `${u}_p${k}`);
      return {
        user: await ctx.forge.user.count({ where: { id: u } }),
        posts: await ctx.forge.post.count({ where: { id: { in: pids } } }),
        comments: await ctx.forge.comment.count({ where: { post_id: { in: pids } } }),
        tags: await ctx.forge.postTag.count({ where: { post_id: { in: pids } } }),
      };
    },
    after: (ctx, tag, i) => rmUserTree(ctx, [wid(tag, "dc", i)]),
    canon: (v: any) => v },
  { name: "delete_many", kind: "write", desc: "deleteMany 100 users by a filter, return the count",
    before: (ctx, tag, i) => ctx.forge.user.createMany({ data: Array.from({ length: 100 }, (_, k) => ({
      id: `${wid(tag, "dm", i)}_${k}`, email: `${wid(tag, "dm", i)}_${k}@bench.dev`, name: wid(tag, "dm", i), role: "USER", active: true,
      created_at: new Date(S.BASE_TIME), prefs: { theme: "light", lang: "en", notify: false, score: 1 } })) }),
    after: (ctx, tag, i) => ctx.forge.user.deleteMany({ where: { name: wid(tag, "dm", i) } }),
    canon: (v: any) => C.n(v?.count ?? v) },
  { name: "tx_interactive", kind: "write", needs: ["tx"], desc: "interactive transaction, 5 dependent steps: create user, create post, count posts, rename user, create comment",
    after: (ctx, tag, i) => rmUserTree(ctx, [wid(tag, "tx", i)]),
    check: async (ctx, tag, i) => {
      const id = wid(tag, "tx", i);
      return { user: await ctx.forge.user.findUnique({ where: { id } }), comments: await ctx.forge.comment.count({ where: { author_id: id } }) };
    },
    canon: (v: any) => ({ name: C.s(v.user?.name), comments: C.n(v.comments) }) },
  { name: "tx_rollback", kind: "write", needs: ["tx"], desc: "transaction that creates a user then throws; the user must not exist",
    check: async (ctx, tag, i) => ctx.forge.user.count({ where: { id: wid(tag, "rb", i) } }),
    after: (ctx, tag, i) => ctx.forge.user.deleteMany({ where: { id: wid(tag, "rb", i) } }),
    canon: C.n },
  { name: "optimistic_update", kind: "write", desc: "read version, update WHERE id AND version (wins), then retry with the stale version (loses)",
    before: (ctx, tag, i) => mkPost(ctx, wid(tag, "occ", i), S.userId(1)),
    after: (ctx, tag, i) => ctx.forge.post.deleteMany({ where: { id: wid(tag, "occ", i) } }),
    canon: (v: any) => ({ fresh: C.n(v?.fresh), stale: C.n(v?.stale) }) },
];

export const SCENARIO_NAMES = SCENARIOS.map((s) => s.name);

// Values shared by every engine's write implementations.
export function userData(id: string, name?: string) {
  return {
    id, email: `${id}@bench.dev`, name: name ?? `Created ${id}`, role: "EDITOR" as const, active: true,
    created_at: new Date(S.BASE_TIME + 86_400_000), prefs: { theme: "dark" as const, lang: "en" as const, notify: true, score: 7 },
  };
}
export function postData(id: string, author: string, k: number) {
  return { ...postFields(id, k), author_id: author };
}
export function postFields(id: string, k: number) {
  return {
    id, title: `Nested post ${k}`, body: `nested body ${k}`, status: "DRAFT" as const, views: 0, version: 0,
    published_at: null, created_at: new Date(S.BASE_TIME), meta: { lang: "en" as const, score: k, flags: [] as string[] },
  };
}
