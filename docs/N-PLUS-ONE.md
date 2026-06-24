# Preventing N+1

The classic N+1 query (one query for the list, one per item) is the most common performance bug in any ORM. forge-orm gives you three tools to avoid it: `include`, the per-request DataLoader pattern, and the event surface to detect it. This page shows the patterns and what forge actually emits to the database for each.

If you have not read [docs/RELATIONS.md](./RELATIONS.md) — especially the
[Deep includes](./RELATIONS.md#deep-includes) section — start there. This
doc assumes you know what `include` and `select` do; the focus here is on
the planner's behaviour under load and the workarounds when `include`
isn't the right shape.

## Contents

* [What N+1 actually is](#what-n1-actually-is)
* [How `include` solves it](#how-include-solves-it)
* [`select` for projection — avoiding over-fetch](#select-for-projection--avoiding-over-fetch)
* [Nested `include` — N depth, perf curve, denormalisation](#nested-include--n-depth-perf-curve-denormalisation)
* [The DataLoader pattern](#the-dataloader-pattern)
* [forge + DataLoader integration](#forge--dataloader-integration)
* [When `include` is the wrong shape](#when-include-is-the-wrong-shape)
* [Aggregate N+1 — counting children per parent](#aggregate-n1--counting-children-per-parent)
* [Streaming N+1](#streaming-n1)
* [GraphQL resolvers — the classic source](#graphql-resolvers--the-classic-source)
* [Detection — counting queries per request](#detection--counting-queries-per-request)
* [Profiling tools](#profiling-tools)
* [Per-dialect quirks](#per-dialect-quirks)
* [Worked examples](#worked-examples)
* [Anti-patterns](#anti-patterns)
* [See also](#see-also)

---

## What N+1 actually is

The shape is always the same: one query returns a list, then the caller
loops the list and runs a follow-up query per element. The "1" is the
list query; the "N" is one query per row in the list.

The canonical example is a blog feed that shows each post with its
author's name:

```ts
// 1 + N queries — N is the size of the posts array
const posts = await db.post.findMany({ where: { status: 'PUBLISHED' } });
for (const post of posts) {
  const author = await db.user.findUnique({ where: { id: post.author_id } });
  console.log(`${post.title} by ${author.name}`);
}
```

For ten posts that runs eleven queries. For a hundred posts it runs a
hundred and one. The page latency tracks the row count linearly — every
new post adds a round trip to the database. On a local Postgres the cost
hides; on a cross-AZ connection with 2 ms RTT, a hundred posts is two
hundred milliseconds of waiting on the wire.

The bug is invisible at small data sizes. It hits production the moment a
single user has more than a handful of rows, and it's the first thing to
look at when a previously-fast endpoint suddenly slows down.

A different way of seeing the same shape: any loop body that calls a
forge method is a candidate. Whether the loop iterates posts and looks up
authors, iterates users and looks up posts, or iterates orders and looks
up items, the planner can't help — each call is its own statement, the
driver opens its own round trip, and the loop multiplies the cost.

---

## How `include` solves it

`include` tells forge to load the relation alongside the parent. The
single line of code maps to a fixed number of queries (one per included
relation, regardless of how many parents matched) rather than one per
parent row.

```ts
// 2 queries, total — regardless of how many posts come back
const posts = await db.post.findMany({
  where:   { status: 'PUBLISHED' },
  include: { author: true },
});
for (const post of posts) {
  console.log(`${post.title} by ${post.author.name}`);
}
```

### What forge actually emits

The dataloader plan is built into the IR (`src/ir/build/relations.ts`).
Each `include` level becomes a **separate** query that uses `IN (...)` to
fetch all matching children across every parent in the batch. forge does
not collapse the include into a single SQL JOIN by default — splitting
keeps the per-row hydration cheap and avoids the cross-product blow-up
covered in [When `include` is the wrong shape](#when-include-is-the-wrong-shape).

The two queries forge runs for the example above:

```sql
-- Query 1: parents
SELECT "id", "title", "body", "author_id", "status", "created_at"
  FROM "posts"
 WHERE "status" = $1;

-- Query 2: included relation (one round trip, regardless of parent count)
SELECT "id", "name", "email"
  FROM "users"
 WHERE "id" IN ($1, $2, $3, …);
```

Forge then walks the second result set, attaches each user to its
matching post by id, and returns the hydrated array. The number of
queries equals the **depth** of the include tree, not the breadth.

### Per-dialect emit

| Dialect    | Parent query | Included relation                                                                       |
|------------|--------------|-----------------------------------------------------------------------------------------|
| Postgres   | `SELECT …`   | `SELECT … FROM "users" WHERE "id" IN ($1, $2, …)`                                       |
| MySQL      | `SELECT …`   | `` SELECT … FROM `users` WHERE `id` IN (?, ?, …) ``                                     |
| SQLite     | `SELECT …`   | `SELECT … FROM "users" WHERE "id" IN (?, ?, …)`                                         |
| DuckDB     | `SELECT …`   | `SELECT … FROM "users" WHERE "id" IN (?, ?, …)`                                         |
| MSSQL      | `SELECT …`   | `SELECT … FROM [users] WHERE [id] IN (@p1, @p2, …)`                                     |
| Mongo      | `find(...)`  | `$lookup` against the related collection, unwound into the parent shape during hydration |

On Mongo the related fetch happens inside the aggregation pipeline as a
`$lookup` rather than a second round trip. The cost model is similar —
one extra pipeline stage, not one extra query per parent — but the
profile looks different in the slow-query log.

### Why not a single JOIN?

Other ORMs collapse the include into a SQL JOIN and hydrate the result
into a nested shape client-side. That works fine for one-to-one and
shallow many-to-one, but for **many-to-many** or **two-deep many**
relations the JOIN produces a cross product:

* 10 posts × 5 tags per post → 50 rows on the wire from the JOIN
* 10 posts × 5 tags × 10 comments per post → 500 rows, most of them
  duplicating the parent post columns

The IN-clause plan sends 10 + 5 = 15 rows, not 50. The cost scales with
`sum(children)` rather than `product(children)`. For deep includes the
difference compounds dramatically — see
[Nested `include`](#nested-include--n-depth-perf-curve-denormalisation).

The trade-off is one extra round trip per relation. On a hot connection
that's usually well under a millisecond; on a slow link it becomes
visible at five or six levels deep. If you're certain the cross product
won't blow up — flat one-to-one shapes, a single shallow many — you can
drop to `$queryRaw` and write the JOIN yourself; see
[docs/RAW-SQL.md](./RAW-SQL.md).

---

## `select` for projection — avoiding over-fetch

Even with `include` collapsing N+1, the **shape** of what you fetch still
matters. `findMany` without `select` returns every column. For a `posts`
table with a 200 KB `body` column, the over-fetch dwarfs the query
overhead.

`select` narrows the projection to exactly the columns you need:

```ts
// Without select — pulls every column including the 200 KB body
const posts = await db.post.findMany({
  where:   { status: 'PUBLISHED' },
  include: { author: true },
});

// With select — pulls 4 columns total, body stays in the database
const posts = await db.post.findMany({
  where:  { status: 'PUBLISHED' },
  select: {
    id:     true,
    title:  true,
    author: { select: { id: true, name: true } },
  },
});
```

The result type follows the selection: `posts[0]` has exactly `{ id,
title, author: { id, name } }`. No `body`, no `created_at`. See
[docs/RELATIONS.md — select inside include](./RELATIONS.md#select-inside-include)
for how nested projection types flow.

### Emit

`select` compiles to a column-listed `SELECT` on every SQL dialect. On
Mongo it compiles to a `$project` stage.

```sql
-- forge emits exactly the columns you asked for
SELECT "id", "title", "author_id"
  FROM "posts"
 WHERE "status" = $1;
SELECT "id", "name"
  FROM "users"
 WHERE "id" IN ($1, $2, …);
```

`author_id` sneaks into the parent projection because forge needs the
FK to wire the included relation up to the right parent during
hydration. The IR adds it back even if the caller didn't list it; the
return type still hides it from the inferred shape.

### When over-fetch matters more than N+1

For a list endpoint that returns 1 000 rows of a 10-column model with
two small text columns, `select` doesn't move the needle. For a 100 000
row export of rows with a 50 KB JSON blob each, over-fetch is the
dominant cost — the query is fast but the network is saturated, the
hydration step is allocating 5 GB of JS strings, and the GC is the
bottleneck. `select` cuts both.

A rule of thumb: if the endpoint shows up in slow-query logs *because of
duration* but the database planner says the query was cheap, you're
shovelling too many bytes. Project narrower.

---

## Nested `include` — N depth, perf curve, denormalisation

Each level of `include` adds one query. A four-level include like

```ts
await db.post.findMany({
  include: {
    author:   { include: { profile: true } },
    comments: { include: { author: true } },
  },
});
```

runs five queries: posts, post authors, post-author profiles, comments,
comment authors. Five round trips per request, regardless of how many
posts matched the where.

### The perf curve

The cost of an include tree is roughly `depth * round_trip + sum(rows_at_each_level)`.
For a depth of 5 on a 1 ms RTT link, that's 5 ms of cumulative wire time
on top of the rows themselves. For a depth of 5 on a 30 ms RTT link
(cross-region), it's 150 ms — and now `include` is no longer free.

There are three things to do when the depth itself is the cost:

1. **Cap the depth.** Most read endpoints don't actually need five-deep
   nested data. A blog post probably needs comments and their author,
   not the author's profile's preferences. Cut the deepest level and
   render the absent data client-side on demand.
2. **Run the leaves in parallel.** If two `include` branches don't
   depend on each other, forge already runs them concurrently — the
   round-trip cost is `max(branch_depth)`, not `sum`. This is automatic;
   nothing to configure.
3. **Denormalise.** When the deepest field is something stable like an
   author's display name, duplicate it onto the parent row at write time
   so the read path doesn't have to traverse the relation at all.

### When to denormalise

Denormalisation is the deliberate breaking of the third normal form so
the read path collapses. Two common forms:

```ts
// Form 1 — copy a hot field onto the child at write time
const Post = model('posts', {
  id: f.id(),
  author_id: f.objectId(),
  author_name: f.string(),                       // denormalised from User.name
  title: f.string(),
}).relate(() => ({
  author: rel.one('user', { on: 'author_id', refs: 'id' }),
}));

// Now the post-list read path doesn't include the author at all
await db.post.findMany({ select: { id: true, title: true, author_name: true } });
```

```ts
// Form 2 — store a precomputed aggregate (cached count)
const User = model('users', {
  id: f.id(),
  post_count: f.int().default(0),                // updated by a trigger or app code on write
});

await db.user.findMany({ select: { id: true, name: true, post_count: true } });
// One query, no _count subquery, no included relation
```

The cost is write-time work to keep the denormalised column in sync — a
post create now also updates the user's `post_count`, and a name change
on the user has to propagate to every post they've written. Pick this
shape when the read traffic dwarfs the write traffic and the denormalised
field changes rarely. A user's display name typically does; their email
typically does too. Their post-count changes every time they post.

For BOM-style trees and other recursive shapes where the depth is
unbounded, the right answer is `WITH RECURSIVE` via `$queryRaw` — see
[docs/RELATIONS.md — Self-referential relations](./RELATIONS.md#self-referential-relations).
A six-level `include` on a four-level-deep tree returns the same data;
a recursive CTE returns it in one query.

---

## The DataLoader pattern

`include` is the right tool when the call site that loads parents also
knows which relations to preload. Sometimes the call site doesn't — a
GraphQL resolver loads the parent, then a separate field resolver loads
the child without ever seeing the parent batch. You can't reach back and
add `include` to the parent query because the parent resolver returned
before the field resolver runs.

The DataLoader pattern solves the same problem from the other side:
**collect lookups during a single tick of the event loop, batch them
into one query, and cache the results for the lifetime of the request**.

The shape (independent of forge):

```ts
class Loader<K, V> {
  private queue: { key: K; resolve: (v: V) => void; reject: (e: Error) => void }[] = [];
  private cache = new Map<K, Promise<V>>();
  private scheduled = false;

  constructor(private batchFn: (keys: K[]) => Promise<V[]>) {}

  load(key: K): Promise<V> {
    if (this.cache.has(key)) return this.cache.get(key)!;
    const p = new Promise<V>((resolve, reject) => {
      this.queue.push({ key, resolve, reject });
      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => this.flush());
      }
    });
    this.cache.set(key, p);
    return p;
  }

  private async flush() {
    const batch = this.queue;
    this.queue = [];
    this.scheduled = false;
    const keys = batch.map(b => b.key);
    try {
      const values = await this.batchFn(keys);
      const byKey = new Map(keys.map((k, i) => [k, values[i]]));
      for (const { key, resolve } of batch) resolve(byKey.get(key) as V);
    } catch (e) {
      for (const { reject } of batch) reject(e as Error);
    }
  }
}
```

Two ideas in one class: **batching** (collect lookups until the
microtask flushes, then resolve them in one call) and **caching**
(remember the result of each lookup so the second call for the same key
hits memory).

The official `dataloader` package on npm is the canonical implementation.
The class above is the minimum useful surface to understand what's
happening.

---

## forge + DataLoader integration

A request-scoped loader for users wraps forge's `findMany`:

```ts
import DataLoader from 'dataloader';
import { db } from './db';

export function makeUserLoader() {
  return new DataLoader<string, User | null>(async (ids) => {
    const users = await db.user.findMany({ where: { id: { in: [...ids] } } });
    const byId = new Map(users.map(u => [u.id, u]));
    // Critical: return values in the same order as the input keys
    return ids.map(id => byId.get(id) ?? null);
  });
}
```

The contract dataloader enforces: the batch function returns one value
per input key, in the same order. A miss (no row with that id) becomes a
`null` at that slot. Returning fewer items, or in a different order,
silently mis-attributes rows to keys and produces a hard-to-debug data
mismatch.

### Wiring a loader to a request

A loader's cache lives for the lifetime of the request — if it lived
longer, it would serve stale data on the next request; if it lived
shorter, it would lose the batching benefit. The conventional shape on a
Node HTTP server:

```ts
// loaders.ts
export function makeLoaders() {
  return {
    user:  makeUserLoader(),
    post:  makePostLoader(),
    org:   makeOrgLoader(),
  };
}

// server.ts (Express or fastify shape — your framework's middleware surface)
app.use((req, res, next) => {
  (req as any).loaders = makeLoaders();
  next();
});

// handler.ts
async function handler(req: Request) {
  const { user: userLoader } = req.loaders;
  const post = await db.post.findUnique({ where: { id: req.params.id } });
  const author = await userLoader.load(post.author_id);
  // ... renders post + author. If 50 different code paths in this
  // request also called userLoader.load(...), they share one batched query.
}
```

The `next()` wrapper creates fresh loaders per request. Two requests
arriving at the same time get separate loader instances with separate
caches; nothing leaks between them.

### Loaders for relation lists

A user has many posts. Loading "all posts by user X" through a loader
means the batch function fetches all posts for every user-id in the
batch:

```ts
function makePostsByUserLoader() {
  return new DataLoader<string, Post[]>(async (userIds) => {
    const posts = await db.post.findMany({
      where:   { author_id: { in: [...userIds] } },
      orderBy: { created_at: 'desc' },
    });
    const byUser = new Map<string, Post[]>();
    for (const p of posts) {
      const list = byUser.get(p.author_id) ?? [];
      list.push(p);
      byUser.set(p.author_id, list);
    }
    return userIds.map(id => byUser.get(id) ?? []);
  });
}

// Usage
const posts = await loaders.postsByUser.load('u1');
```

The same loader, called from fifty different points in the request, runs
**one** `posts WHERE author_id IN (...)` query.

### When to reach for a loader vs `include`

| Situation                                                           | Reach for         |
|---------------------------------------------------------------------|-------------------|
| Caller knows the relations to preload at the top-level query        | `include`         |
| Caller is a GraphQL field resolver (no access to the parent batch)  | DataLoader        |
| Same id looked up from many code paths in one request               | DataLoader        |
| Streaming rows that each need a related lookup                      | DataLoader        |
| Shape is many-to-many with high cardinality (cross-product blowup)  | DataLoader        |
| One-shot read endpoint with a clear preload tree                    | `include`         |

The two tools don't conflict. A REST handler can use `include` for the
primary read path and a DataLoader for ad-hoc lookups during
serialisation. A GraphQL handler can use loaders throughout and still
use `include` inside the resolver that owns the root query.

---

## When `include` is the wrong shape

`include` is the default and the right answer most of the time, but
three shapes break it.

### Many-to-many with high cardinality

A post has tags. Tags have many posts. Loading "every post tagged
`forge`" via `include` works fine, but loading "every post and every
tag for those posts" with `include: { tags: { include: { tag: true } } }`
on a list of a thousand posts loads however many `post_tags` join rows
those posts have — typically several per post — then loads the tag rows
once per unique tag id.

The IN-clause plan handles this reasonably (the tag fetch dedupes to the
distinct set of tag ids), but the join-row layer is still
`sum(tags_per_post)` rows on the wire. If the average post has 10 tags
and you load 1 000 posts, that's 10 000 join rows passing through the
hydrator.

When the many-to-many cardinality is high and you only need a flat list
of tag names per post, denormalise:

```ts
const Post = model('posts', {
  id: f.id(),
  title: f.string(),
  tag_names: f.string().array().default([]),    // PG/SQLite/DuckDB native array;
                                                // JSON on MySQL/MSSQL/Mongo
});
```

The read shrinks to one query and the over-fetch disappears. The trade-off
is write-time complexity — adding a tag becomes a two-step operation on
both the join table and the denormalised array.

### Sibling relations are sometimes better as parallel queries

```ts
await db.user.findFirst({
  where:   { id: 'u1' },
  include: {
    posts:    { take: 5, orderBy: { created_at: 'desc' } },
    comments: { take: 5, orderBy: { created_at: 'desc' } },
    likes:    { take: 5, orderBy: { created_at: 'desc' } },
    follows:  { take: 5, orderBy: { created_at: 'desc' } },
  },
});
```

Four sibling relations off one user is four round trips after the parent
query. forge runs them in parallel — the wall clock is `max(rtt)`, not
`sum(rtt)` — but the planner has to do four separate prepared-statement
lookups with their own `ROW_NUMBER() OVER` windowing. On a busy database
that's four contention points.

If the four lists are independent and the caller can render them
asynchronously, run them as four explicit `findMany` calls in parallel
from your handler:

```ts
const [posts, comments, likes, follows] = await Promise.all([
  db.post.findMany({ where: { author_id: 'u1' }, take: 5, orderBy: { created_at: 'desc' } }),
  db.comment.findMany({ where: { author_id: 'u1' }, take: 5, orderBy: { created_at: 'desc' } }),
  db.like.findMany({ where: { user_id: 'u1' }, take: 5, orderBy: { created_at: 'desc' } }),
  db.follow.findMany({ where: { follower_id: 'u1' }, take: 5, orderBy: { created_at: 'desc' } }),
]);
```

Same wall clock, fewer cross-table dependencies for the planner, and
each lookup hits its own index without the windowing wrapper. This is a
shape-of-call-site choice rather than a forge feature — both call shapes
are valid.

### Filtering parents by an aggregate

`include` doesn't help when the filter on the parent depends on an
aggregate over the children — "users with more than 10 published
posts" or "orders whose item total is over $500". For those you reach
for `groupBy` plus a second query (see
[docs/RELATIONS.md — Performance and the `.compile` escape hatch](./RELATIONS.md#performance-and-the-compile-escape-hatch))
or drop to `$queryRaw` for a one-shot join with `HAVING`.

---

## Aggregate N+1 — counting children per parent

A subtle N+1: rendering a "count of comments" badge next to each post.
The naive shape is exactly the canonical N+1, just with `count` in place
of `findUnique`:

```ts
// WRONG — runs N count queries
const posts = await db.post.findMany({ where: { status: 'PUBLISHED' } });
for (const post of posts) {
  const comments = await db.comment.count({ where: { post_id: post.id } });
  console.log(`${post.title}: ${comments} comments`);
}
```

The right shape uses `_count` inside `include`:

```ts
const posts = await db.post.findMany({
  where:   { status: 'PUBLISHED' },
  include: { _count: { select: { comments: true } } },
});
for (const post of posts) {
  console.log(`${post.title}: ${post._count.comments} comments`);
}
```

forge emits a correlated subquery — one query, one round trip, the count
arrives alongside the row:

```sql
SELECT "posts".*,
       (SELECT COUNT(*) FROM "comments" WHERE "comments"."post_id" = "posts"."id") AS "_count_comments"
  FROM "posts"
 WHERE "status" = $1;
```

For more flexible aggregates (sum, average, min, max — not just count)
the planner can't synthesise the correlated subquery and you reach for
`groupBy` instead:

```ts
// Two queries — parents + a single groupBy keyed by parent id
const posts = await db.post.findMany({ where: { status: 'PUBLISHED' } });
const sums  = await db.orderItem.groupBy({
  by:    ['order_id'],
  where: { order_id: { in: posts.map(p => p.id) } },
  _sum:  { total: true },
});
const byPost = new Map(sums.map(s => [s.order_id, s._sum.total]));
for (const post of posts) {
  console.log(`${post.title}: $${byPost.get(post.id) ?? 0}`);
}
```

The shape is "fetch parents → groupBy children with `in: parent_ids` →
join in memory." Two queries total, regardless of how many parents
matched. See [docs/QUERIES.md — groupBy and having](./QUERIES.md#groupby-and-having).

---

## Streaming N+1

A naive stream that does per-row lookups is still N+1 — the stream
saves memory but spends the same number of round trips:

```ts
// WRONG — N+1 over the stream
for await (const order of db.order.findManyStream({ where: { ... } })) {
  const buyer = await db.user.findUnique({ where: { id: order.buyer_id } });
  // ... do something with order + buyer
}
```

`findManyStream` does not run included-relation hydration across the
stream — buffering the related rows would defeat the point of streaming.
See [docs/QUERIES.md — findManyStream](./QUERIES.md#findmanystream--cursor-backed-streaming)
for the reasoning.

The two workable shapes:

### Chunked batching

Buffer the stream into chunks, then `findMany` the related rows once per
chunk:

```ts
const CHUNK = 200;
let buffer: Order[] = [];

async function flush() {
  if (!buffer.length) return;
  const ids   = buffer.map(o => o.buyer_id);
  const users = await db.user.findMany({ where: { id: { in: ids } } });
  const byId  = new Map(users.map(u => [u.id, u]));
  for (const order of buffer) {
    await process(order, byId.get(order.buyer_id));
  }
  buffer = [];
}

for await (const order of db.order.findManyStream({ where: { ... } })) {
  buffer.push(order);
  if (buffer.length >= CHUNK) await flush();
}
await flush();
```

For a million orders that's 5 000 batched user queries instead of a
million per-row lookups.

### DataLoader inside a stream

If the lookups are sparse (most orders share buyers, or the related rows
are read repeatedly), a DataLoader scoped to the stream collapses the
duplicates:

```ts
const loader = new DataLoader<string, User | null>(async (ids) => {
  const users = await db.user.findMany({ where: { id: { in: [...ids] } } });
  const byId  = new Map(users.map(u => [u.id, u]));
  return ids.map(id => byId.get(id) ?? null);
}, { maxBatchSize: 200 });

for await (const order of db.order.findManyStream({ where: { ... } })) {
  const buyer = await loader.load(order.buyer_id);
  await process(order, buyer);
}
```

The loader's microtask batching collapses concurrent `load()` calls. In
a sequential stream the batching has nothing to batch — the chunked
shape above is more reliable for sequential consumers.

---

## GraphQL resolvers — the classic source

GraphQL is the language where N+1 is most likely to appear. The schema
encourages field resolvers — small functions that each load one piece of
data, called per object — and the resolver author rarely sees the parent
batch. The default shape, written without thought, is the worst case:

```ts
// WRONG — runs one user query per post
const resolvers = {
  Post: {
    author: (post: Post) => db.user.findUnique({ where: { id: post.author_id } }),
  },
};
```

A query for `posts(limit: 50) { author { name } }` triggers fifty user
lookups, one per resolved post.

DataLoader is the canonical fix. The resolver becomes:

```ts
const resolvers = {
  Post: {
    author: (post: Post, _args, ctx: Context) => ctx.loaders.user.load(post.author_id),
  },
};
```

Context construction creates fresh loaders per request:

```ts
function createContext(req: Request): Context {
  return {
    loaders: {
      user:  makeUserLoader(),
      tag:   makeTagLoader(),
      post:  makePostLoader(),
    },
  };
}
```

The same query now runs one user lookup with `IN (id1, id2, …, id50)`.

### Per-parent lists

A field resolver that returns a list — `User.posts` — needs a loader
keyed by the parent's id:

```ts
const resolvers = {
  User: {
    posts: (user: User, _args, ctx: Context) => ctx.loaders.postsByUser.load(user.id),
  },
};
```

Inside the loader, the batch function fetches every post for every
user-id in the batch — see the `makePostsByUserLoader` example above.

### Reachable through `include` too

If the GraphQL root resolver knows it'll need posts under every user, it
can pre-include them and pass the hydrated tree to the field resolver:

```ts
const resolvers = {
  Query: {
    users: () => db.user.findMany({ include: { posts: true } }),
  },
  User: {
    posts: (user: User & { posts: Post[] }) => user.posts,    // already populated
  },
};
```

The trick is the resolver no longer queries — it reads off the parent.
But this works only when the root resolver can predict the field tree.
The query analyser libraries (`graphql-fields`, `graphql-parse-resolve-info`)
read the incoming `info` argument to compute the include map, but at
that point you've reinvented half of dataloader. The cleanest split is:
**resolvers always use loaders; root queries can additionally use
`include` as an optimisation when the field tree is known.**

---

## Detection — counting queries per request

forge emits a `query` event for every executed statement. The simplest
N+1 detector counts events per request and flags any request that
crosses a threshold:

```ts
// Express-style middleware shape
app.use((req, res, next) => {
  let count = 0;
  const off = db.$on('query', () => count++);
  res.on('finish', () => {
    off();
    if (count > 10) {
      console.warn(`[N+1?] ${req.method} ${req.path}: ${count} queries`);
    }
  });
  next();
});
```

Ten queries per request is the suggested threshold but it's
application-specific. A REST list endpoint with one `findMany` and two
`include` levels runs three queries; a dashboard that pulls eight panels
in parallel might run fifteen as a healthy steady state. Find the floor
for your app and set the threshold above it.

For deeper diagnostics, log the offending queries:

```ts
app.use((req, res, next) => {
  const events: QueryEvent[] = [];
  const off = db.$on('query', (e) => events.push(e));
  res.on('finish', () => {
    off();
    if (events.length > 10) {
      const byModel = new Map<string, number>();
      for (const e of events) byModel.set(e.model, (byModel.get(e.model) ?? 0) + 1);
      console.warn(
        `[N+1?] ${req.method} ${req.path}: ${events.length} queries (${
          [...byModel.entries()].map(([m, n]) => `${m}×${n}`).join(', ')
        })`,
      );
    }
  });
  next();
});
```

If `user×47` shows up next to a list endpoint, you've found the loop.
See [docs/EVENTS.md](./EVENTS.md) for the full `QueryEvent` shape —
`model`, `op`, `sql`, `params`, `duration_ms` — and
[docs/METRICS.md](./METRICS.md) for histogram and counter wiring to
Prometheus / OTel.

### Production gating

In production the per-request log is noisy. Two ways to keep it useful:

* **Sample.** Wrap the listener in `if (Math.random() < 0.01) { ... }`
  so 1% of requests are inspected. Enough to catch a regression, not
  enough to drown stdout.
* **Threshold the dashboard, not the log.** Push the `count` per
  request to a metrics histogram; alert on the 99th percentile crossing
  a threshold. The slow requests stand out without per-request log
  spam. See [docs/METRICS.md](./METRICS.md).

---

## Profiling tools

The forge event surface tells you "how many queries ran." The database
tells you "what each one cost." Pair them.

### Postgres — pg_stat_statements

The `pg_stat_statements` extension records every query the server has
executed, deduplicated by normalised SQL text, with total time, mean
time, and call count:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

SELECT calls, mean_exec_time, total_exec_time, query
  FROM pg_stat_statements
 ORDER BY calls DESC
 LIMIT 20;
```

A row with `calls = 50_000` and `mean_exec_time = 1 ms` is your N+1 —
each call is cheap but the total is 50 seconds of cumulative work. The
fix lifts the loop into a single `IN`-clause query.

### MySQL — slow query log + performance_schema

```sql
SET GLOBAL slow_query_log = 'ON';
SET GLOBAL long_query_time = 0.05;                  -- log anything over 50 ms

-- Per-statement view
SELECT digest_text, count_star, avg_timer_wait/1e9 AS avg_ms
  FROM performance_schema.events_statements_summary_by_digest
 ORDER BY count_star DESC
 LIMIT 20;
```

### SQLite — query plan and timer wrappers

SQLite has no built-in slow log. The portable approach is the forge
event listener — log every query with `duration_ms > threshold`:

```ts
db.$on('query', (e) => {
  if (e.duration_ms > 50) console.warn(`slow: ${e.duration_ms}ms ${e.sql}`);
});
```

For plan inspection, `EXPLAIN QUERY PLAN <statement>` returns the
table-scan / index-scan plan SQLite picked.

### MSSQL — Query Store

```sql
ALTER DATABASE forge_demo SET QUERY_STORE = ON;

SELECT TOP 20 t.query_sql_text, rs.count_executions, rs.avg_duration / 1000.0 AS avg_ms
  FROM sys.query_store_query_text t
  JOIN sys.query_store_query q  ON q.query_text_id = t.query_text_id
  JOIN sys.query_store_runtime_stats rs ON rs.plan_id = (SELECT TOP 1 plan_id FROM sys.query_store_plan WHERE query_id = q.query_id)
 ORDER BY rs.count_executions DESC;
```

### Mongo — profiler

```js
db.setProfilingLevel(1, { slowms: 50 });
db.system.profile.find().sort({ ts: -1 }).limit(20);
```

The profiler captures every operation over the slowms threshold. Pair
it with [docs/TRACING.md](./TRACING.md) — forge's OTel integration
labels each span with `model` and `op` so the trace lines up with the
profile.

---

## Per-dialect quirks

### Mongo `$lookup` explosion on deep includes

Mongo's `$lookup` aggregation stage doesn't index-scan the way SQL's
`IN (...)` does on the foreign collection. A deep include — three levels
of nested `$lookup` — runs each lookup against the working set of the
previous stage, and the working set grows by the cross product of the
join.

forge mitigates this by re-batching deep includes into separate top-level
queries when the include depth crosses two levels — the deeper relation
runs as a follow-up `find` with `IN` rather than a nested pipeline stage.
The behaviour is automatic and matches the SQL planner's shape.

When you write a `$queryRaw` aggregation that includes manual `$lookup`
stages, the same caution applies — flatten to separate queries past two
levels of nesting. See [docs/MONGO.md](./MONGO.md) for the indexing notes.

### SQLite plan-by-rowid

SQLite's planner prefers row-id scans for small tables. A
`WHERE id IN (...)` lookup with three values on a thousand-row table is
faster than the equivalent indexed lookup on Postgres because SQLite
keeps the whole table in OS page cache and walks it. The implication for
N+1 detection: SQLite hides the bug at small scales. A loop that runs
fifty queries on a hundred-row test database runs fast enough that the
test passes. The same code on Postgres at production scale falls over.

Always run the N+1 detector on dev databases that match production
shape, not just on the SQLite test database. See
[docs/SQLITE.md](./SQLITE.md) for the rowid mechanics.

### MySQL `IN (...)` size limits

`mysql2` accepts up to `max_allowed_packet` bytes in a single
statement. The default of 64 MB allows several hundred thousand
parameters in a single `IN (?)` list, but the planner switches strategy
above a few thousand values — it stops index-scanning and starts
hash-joining. If you batch a million ids through dataloader,
`maxBatchSize: 500` keeps the planner inside its happy path. The
mongo / pg planners have the same shape at different thresholds; 500 is
a portable default. See [docs/MYSQL.md](./MYSQL.md).

### Postgres prepared-statement cache

Postgres caches a query plan per prepared statement per connection. A
loop that issues a thousand `IN (?)` lookups with varying list sizes
each generates its own plan-cache entry — at a few thousand variants the
cache fills and starts evicting. forge's IN-list quantises the
parameter count (rounding up to the next power of two and padding with
`NULL`) on Postgres to keep the cache happy. The behaviour is automatic;
the only visible effect is occasional `NULL` padding in the
`pg_stat_statements` output. See [docs/POSTGRES.md](./POSTGRES.md).

---

## Worked examples

### (a) Blog feed without N+1 via `include`

```ts
async function blogFeed(orgId: string, limit = 20) {
  return db.post.findMany({
    where:   { org_id: orgId, status: 'PUBLISHED' },
    orderBy: { published_at: 'desc' },
    take:    limit,
    select: {
      id: true,
      title: true,
      published_at: true,
      author: { select: { id: true, name: true, avatar_url: true } },
      _count: { select: { comments: true, likes: true } },
    },
  });
}
```

Three queries total — `posts` parent, `users` for authors,
plus two correlated subqueries for the counts that ride along on the
parent. Twenty posts or two thousand: same query count. The `select`
restricts column width so the wire transfer is bounded by the cardinality
of the result set, not the schema.

### (b) GraphQL resolver with DataLoader

```ts
// loaders.ts
import DataLoader from 'dataloader';

export function makeLoaders() {
  return {
    user: new DataLoader<string, User | null>(async (ids) => {
      const users = await db.user.findMany({ where: { id: { in: [...ids] } } });
      const byId  = new Map(users.map(u => [u.id, u]));
      return ids.map(id => byId.get(id) ?? null);
    }),
    commentsByPost: new DataLoader<string, Comment[]>(async (postIds) => {
      const comments = await db.comment.findMany({
        where:   { post_id: { in: [...postIds] } },
        orderBy: { created_at: 'desc' },
      });
      const byPost = new Map<string, Comment[]>();
      for (const c of comments) {
        const list = byPost.get(c.post_id) ?? [];
        list.push(c);
        byPost.set(c.post_id, list);
      }
      return postIds.map(id => byPost.get(id) ?? []);
    }),
  };
}

// resolvers.ts
export const resolvers = {
  Query: {
    posts: () => db.post.findMany({ where: { status: 'PUBLISHED' }, take: 50 }),
  },
  Post: {
    author:   (post: Post, _a, ctx) => ctx.loaders.user.load(post.author_id),
    comments: (post: Post, _a, ctx) => ctx.loaders.commentsByPost.load(post.id),
  },
  Comment: {
    author: (c: Comment, _a, ctx) => ctx.loaders.user.load(c.author_id),
  },
};

// server.ts
import { ApolloServer } from '@apollo/server';
const server = new ApolloServer({ typeDefs, resolvers });

const { url } = await startStandaloneServer(server, {
  context: async () => ({ loaders: makeLoaders() }),
});
```

A query for `posts { author { name } comments { author { name } } }`
runs exactly four queries regardless of post count: posts, users (for
post authors), comments (one batched fetch keyed by post ids), users
(for comment authors — sharing the cache with the post-author lookups if
authors overlap).

### (c) Finder-loop converted to an `IN`-clause batch

The original loop:

```ts
async function recentPostsForUsers(userIds: string[]) {
  const results: Record<string, Post[]> = {};
  for (const userId of userIds) {                  // N queries
    results[userId] = await db.post.findMany({
      where:   { author_id: userId },
      orderBy: { created_at: 'desc' },
      take:    5,
    });
  }
  return results;
}
```

Converted to a single batched fetch with a windowed query:

```ts
async function recentPostsForUsers(userIds: string[]) {
  // One query — IN (...) pulls candidates for every user
  const candidates = await db.post.findMany({
    where:   { author_id: { in: userIds } },
    orderBy: { created_at: 'desc' },
  });

  // Group + cap in memory
  const byUser: Record<string, Post[]> = Object.fromEntries(userIds.map(id => [id, []]));
  for (const post of candidates) {
    if (byUser[post.author_id].length < 5) byUser[post.author_id].push(post);
  }
  return byUser;
}
```

The trade-off: the single query pulls more rows than strictly needed
(every post for every user, not just the top 5). For users with ten or
fifty posts the over-fetch is small; for users with thousands it isn't.
The per-parent windowed form using `take` inside `include` does the
windowing at the database:

```ts
async function recentPostsForUsers(userIds: string[]) {
  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    include: { posts: { orderBy: { created_at: 'desc' }, take: 5 } },
  });
  return Object.fromEntries(users.map(u => [u.id, u.posts]));
}
```

`take: 5` inside `include` compiles to `ROW_NUMBER() OVER (PARTITION BY
author_id ORDER BY created_at DESC) <= 5` on SQL, so the database does
the windowing — at most five rows per user come back. See
[docs/RELATIONS.md — Bounded children per parent](./RELATIONS.md#bounded-children-per-parent).

---

## Anti-patterns

### Disabling caching to "force refresh"

A common pattern: turn off a DataLoader cache because a stale read was
served once, and now every lookup hits the database. That's a 1-to-N
amplification — the loader was batching them, and without the cache the
duplicates inside the request all become separate queries.

The fix is almost never "disable the cache." It's:

1. Scope the cache narrower — per-request, not per-process.
2. Invalidate the cache key on the write path that produced the staleness.
3. If the cache must be off, the data is too volatile for batching at
   all — fall back to one explicit query at the call site that needs the
   freshest read.

### Loops that fetch one row at a time

The shape is so familiar it's worth calling out separately. Any code
that looks like

```ts
const results = [];
for (const id of ids) {
  results.push(await db.user.findUnique({ where: { id } }));
}
```

is wrong. The fix is

```ts
const rows = await db.user.findMany({ where: { id: { in: ids } } });
const byId = new Map(rows.map(r => [r.id, r]));
const results = ids.map(id => byId.get(id) ?? null);
```

One query, same shape.

### `include` everything "just in case"

The opposite failure mode of forgetting to include: including every
relation forge knows about, in case some caller might need it. A six-way
include with no `select` on a large schema fans out six queries per
request and pulls megabytes of unused data.

Each `include` is a decision: "this caller will read this field on every
row of the result." If the caller might not read it, leave it out and
let the next layer choose. A DataLoader at the resolver boundary handles
the on-demand case without forcing the cost on every read.

### Disabling the event surface in production "for performance"

The `query` event is fire-and-forget — the event loop schedules
listeners after the query resolves, off the hot path. Turning it off to
chase microseconds removes the only tool you have to detect N+1 in
production. Sample the listener (1% of requests) if the log volume is
the concern; don't turn the emitter off.

---

## See also

* [docs/RELATIONS.md](./RELATIONS.md) — `include`, `select`, deep
  relations, and the dataloader plan inside the IR
* [docs/QUERIES.md](./QUERIES.md) — `findMany`, `groupBy`,
  `findManyStream`, and the full operator surface
* [docs/EVENTS.md](./EVENTS.md) — the `QueryEvent` shape every query
  emits; the detection sink is built on this
* [docs/METRICS.md](./METRICS.md) — Prometheus / OTel histograms for
  per-request query counts and slow-query thresholds
* [docs/CACHING.md](./CACHING.md) — when results live longer than a
  request and can be cached across requests
* [docs/BACKEND.md](./BACKEND.md) — request-scoped patterns, including
  the loader-per-request middleware shape
* [docs/RAW-SQL.md](./RAW-SQL.md) — for the cases where `include` can't
  express the shape and a hand-written JOIN with `HAVING` is the right
  answer
* [docs/TRACING.md](./TRACING.md) — OTel spans per query, pairs with
  database-side profilers for end-to-end attribution
