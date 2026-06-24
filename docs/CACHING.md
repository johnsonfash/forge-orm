# Caching

forge-orm has no built-in query cache — the right caching layer depends on your stack, your invalidation tolerance, and your traffic shape. This page documents the patterns that compose with forge: DataLoader per-request, Redis cache-aside, CDN for read endpoints, and the event-driven invalidation hooks that tie them together.

If you have not read the [QUERIES.md](QUERIES.md) chapter and the
[Observability](BACKEND.md#observability) section of BACKEND.md, start there.
This doc assumes you know how a forge call is dispatched and how `$on('query')`
fires after each one — both are load-bearing for the patterns below.

---

## Contents

- [Why this page exists](#why-this-page-exists)
- [The four caching layers](#the-four-caching-layers)
- [When NOT to cache](#when-not-to-cache)
- [DataLoader-style per-request cache](#dataloader-style-per-request-cache)
- [Redis-backed query cache](#redis-backed-query-cache)
- [Cache-aside pattern](#cache-aside-pattern)
- [Read-through and write-through](#read-through-and-write-through)
- [Invalidation — three strategies](#invalidation--three-strategies)
- [Cache-key design](#cache-key-design)
- [Stale-while-revalidate](#stale-while-revalidate)
- [Negative caching](#negative-caching)
- [CDN and HTTP cache for read endpoints](#cdn-and-http-cache-for-read-endpoints)
- [forge events as invalidation triggers](#forge-events-as-invalidation-triggers)
- [Cache stampede — singleflight and jitter](#cache-stampede--singleflight-and-jitter)
- [Memory limits and eviction](#memory-limits-and-eviction)
- [Worked examples](#worked-examples)
- [Related docs](#related-docs)

---

## Why this page exists

People ask, every few weeks, where the `cache: { ttl: 60 }` option is on
`findMany`. There isn't one, and there will not be one. Caching is the place in
a system where the trade-offs are most application-specific:

- Whether stale data is tolerable, and for how long.
- Whether your traffic is read-heavy enough that a cache moves the needle.
- Whether you have one writer or many (which decides whether explicit
  invalidation is even safe).
- Whether your cache lives in-process, in Redis, or at the edge.
- Whether `Cache-Control` belongs in the response, or whether the cache lookup
  belongs upstream of the handler.

A library that picked one of those for you would be wrong for half its users.
What forge ships instead is the surface that every cache wants — a typed
operator, a stable argument shape, and a post-query event with `model`, `op`,
and `semanticOp` on it. The rest is a few hundred lines of glue, and that glue
is what this doc spells out.

If after reading this you decide you want zero caching — that is also a fine
answer. A correctly-indexed Postgres with sub-10ms p99s does not need a Redis
in front of it. Caching is the optimisation you reach for after you have
exhausted indexes, query rewrites, connection pooling, and replicas. See
[INDEXES.md](INDEXES.md), [QUERIES.md](QUERIES.md), and
[POOLING.md](POOLING.md) before this one.

---

## The four caching layers

Whatever you do, four caches are already in your stack. Knowing which one is
hot for a given query is the difference between caching the right thing and
caching nothing.

| Layer | Where it lives | What it stores | Who manages it |
|---|---|---|---|
| **DB internal** | inside Postgres/MySQL/Mongo | data pages, query plans, prepared statements | the engine |
| **Connection** | inside the driver / pgbouncer | prepared statement handles, server-side cursors | the driver |
| **Application** | your Node process or Redis | rendered query results, computed derivatives | you |
| **CDN / HTTP** | Cloudflare, Fastly, Vercel Edge | response bodies keyed by URL | you, via headers |

The DB and connection layers are not optional and not controllable from forge.
They are the reason a `findUnique({ where: { id } })` against a well-cached
table can run in 200 microseconds — the page is already resident, the plan is
already cached, the prepared statement is already on the wire. Adding a Redis
in front of that call costs more than it saves.

The application and CDN layers are where this doc lives. They are useful when:

- Your read involves a join or aggregate that the DB cannot serve from RAM.
- The same query is fanned out hundreds of times per request (a feed, a list
  page, an N+1).
- The endpoint is global and the response is the same for everyone.

Measure first. The forge `query` event carries `duration_ms` — see
[METRICS.md](METRICS.md). Cache the calls in the p99 bucket, not the ones the
DB is already serving in a millisecond.

---

## When NOT to cache

The cost of getting cache invalidation wrong is paid in support tickets, in
"why am I seeing yesterday's price", in fraud where a stale balance lets a
user double-spend. Before you cache, walk through this checklist:

- **Is the read on the hot path?** If the endpoint is hit ten times a day,
  caching it saves nothing.
- **Is the read slow?** If the p99 is under 10ms, caching does not move the
  needle and you have added a write path (the cache set) to every read.
- **Can the read be made fast?** A missing index, a wrong join order, or a
  full-table scan is almost always cheaper to fix than to cache around. See
  [INDEXES.md](INDEXES.md) and [DOCTOR.md](DOCTOR.md).
- **Can the caller tolerate stale data?** "User profile name" — usually yes.
  "Account balance before a withdrawal" — never.
- **Do you have one writer or many?** A single writer can invalidate on
  every mutation. Many writers means you need TTL or tag-based invalidation,
  because no single process knows the full mutation set.
- **Are the keys bounded?** If the key space is unbounded (`/search?q=...`
  with arbitrary user input), you will fill the cache with one-shot entries
  and evict the actually-hot ones.

The honest rule: cache only after you have measured, and only the queries in
the p99. Random "this might be slow, let me add a cache" guesses make systems
slower on average and harder to reason about always.

---

## DataLoader-style per-request cache

The cheapest and safest cache is the one that lives for the duration of a
single request and is thrown away at the end. It batches identical lookups
and deduplicates within one HTTP handler. There is no invalidation problem
because the cache does not outlive the data it caches.

This is the right answer to a classic N+1: a GraphQL resolver, a feed page
that hydrates 50 author names, a webhook handler that resolves the same
account ten times.

```ts
// src/lib/dataloader.ts
import DataLoader from 'dataloader';
import { db } from '../db';

export const buildLoaders = () => ({
  user: new DataLoader<string, User | null>(async (ids) => {
    const rows = await db.user.findMany({ where: { id: { in: [...ids] } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id) ?? null);
  }),

  productsByOrg: new DataLoader<string, Product[]>(async (orgIds) => {
    const rows = await db.product.findMany({
      where: { org_id: { in: [...orgIds] } },
    });
    const byOrg = new Map<string, Product[]>();
    for (const row of rows) {
      const list = byOrg.get(row.org_id) ?? [];
      list.push(row);
      byOrg.set(row.org_id, list);
    }
    return orgIds.map((id) => byOrg.get(id) ?? []);
  }),
});

export type Loaders = ReturnType<typeof buildLoaders>;
```

Build one set of loaders per request, attach it to the request context,
discard at end of request:

```ts
// src/server.ts
app.use(async (req, res, next) => {
  req.loaders = buildLoaders();
  return next();
});

app.get('/feed', async (req, res) => {
  const posts = await db.post.findMany({ orderBy: { created_at: 'desc' }, take: 50 });
  const authors = await Promise.all(posts.map((p) => req.loaders.user.load(p.author_id)));
  res.json({ data: posts.map((p, i) => ({ ...p, author: authors[i] })) });
});
```

Two things to notice:

1. **Batching.** The 50 `.load()` calls collapse into a single
   `findMany({ where: { id: { in: [...] } } })`. The DataLoader internals defer
   the actual fetch to the next microtask, gather the keys, and dispatch once.
2. **Per-request scope.** Two concurrent requests get two separate loaders.
   One request seeing user `u_42` does not leak that row to another request,
   which avoids every authorization bug that comes with shared caches.

DataLoader is the lowest-risk cache you can add. It has no TTL, no
invalidation, no eviction policy. If you are about to reach for Redis to fix
an N+1, try DataLoader first.

See [QUERIES.md](QUERIES.md) for the `where: { in: [...] }` operator forge
generates the right `WHERE id = ANY($1)` for and avoids the per-dialect
parameter-limit traps (Postgres has none, MySQL has `max_allowed_packet`,
SQLite has `SQLITE_MAX_VARIABLE_NUMBER`).

---

## Redis-backed query cache

Once you have measured and decided a query genuinely needs an out-of-process
cache, Redis is the standard answer. It is fast, it is shared across your
fleet, it has TTL, and it has primitives (`SETEX`, `MGET`, `SCAN`, pub/sub)
that match the patterns you need.

The serialization choice matters more than people think:

| Format | CPU cost | Bytes on the wire | When |
|---|---|---|---|
| `JSON.stringify` | low | largest | default — debuggable, no schema |
| `msgpack` | low-mid | ~30% smaller than JSON | hot keys, where bandwidth matters |
| `cbor` | low-mid | similar to msgpack | binary fields, dates |
| `protobuf` | mid | smallest, but schema-coupled | only when you already have schemas |

Gzip on top buys another 60–80% on text-heavy payloads (product descriptions,
feed bodies). Skip it for small entries — under ~1 KB the header eats the
saving. The `ioredis` and `node-redis` clients both stream into and out of
Buffers, so a compression step is just a `gzipSync` / `gunzipSync` pair.

```ts
// src/lib/redis-cache.ts
import { Redis } from 'ioredis';
import { gzipSync, gunzipSync } from 'node:zlib';

const r = new Redis(process.env.REDIS_URL!);

const COMPRESS_THRESHOLD = 1024;

export const cache = {
  async get<T>(key: string): Promise<T | undefined> {
    const buf = await r.getBuffer(key);
    if (!buf) return undefined;
    const head = buf[0];
    const body = head === 0x1f ? gunzipSync(buf) : buf;  // gzip magic byte
    return JSON.parse(body.toString('utf8'));
  },
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const json = Buffer.from(JSON.stringify(value), 'utf8');
    const body = json.length >= COMPRESS_THRESHOLD ? gzipSync(json) : json;
    await r.set(key, body, 'EX', ttlSeconds);
  },
  async del(...keys: string[]): Promise<void> {
    if (keys.length) await r.del(...keys);
  },
  async invalidatePrefix(prefix: string): Promise<void> {
    let cursor = '0';
    do {
      const [next, batch] = await r.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
      cursor = next;
      if (batch.length) await r.del(...batch);
    } while (cursor !== '0');
  },
};
```

`SCAN` is non-blocking and the right primitive for prefix invalidation. Do
not use `KEYS` on a production Redis — it is O(N) and blocks the single
event loop.

---

## Cache-aside pattern

The shape every other pattern is a variant of. Read path checks the cache;
on miss, runs the query and populates the cache; returns. Write path
mutates the DB; invalidates the cache.

```ts
async function getProduct(id: string): Promise<Product | null> {
  const key = `product:${id}:v1`;
  const hit = await cache.get<Product>(key);
  if (hit !== undefined) return hit;

  const row = await db.product.findUnique({ where: { id } });
  await cache.set(key, row, 300); // 5 min TTL
  return row;
}

async function updateProduct(id: string, patch: Partial<Product>): Promise<Product> {
  const row = await db.product.update({ where: { id }, data: patch });
  await cache.del(`product:${id}:v1`);
  return row;
}
```

Three things this code gets right and two it does not:

**Right:**

- Misses (`null` returns) are cached too. If you change that to
  `if (hit) return hit`, every "does this row exist" check on a missing key
  hits the DB forever.
- The version suffix (`:v1`) lets you bump the key on a schema change
  without writing a migration to flush old entries.
- The TTL is non-zero. Even if your invalidation is correct, multi-writer
  bugs and process crashes mean some keys will be stale; the TTL is the
  backstop.

**Missing — what we cover later:**

- No singleflight. A burst on a cold key triggers the DB query N times
  before the first write completes. See [Cache stampede](#cache-stampede--singleflight-and-jitter).
- No tagging. If `update_org` should also invalidate every product in the
  org, this code does not handle it. See [Tag-based invalidation](#invalidation--three-strategies).

---

## Read-through and write-through

Cache-aside puts the cache logic in your handler. Read-through and
write-through put it inside a cache wrapper that proxies the DB call.

**Read-through** — the cache library itself loads on miss:

```ts
const product = await cache.readThrough(
  `product:${id}:v1`,
  300,
  () => db.product.findUnique({ where: { id } }),
);
```

The wrapper handles the get/miss/set/return loop. Useful when many call
sites cache the same query — you write the loader once.

**Write-through** — every write goes through the wrapper, which writes the
DB and updates the cache in one step:

```ts
async function setCounter(key: string, value: number) {
  await db.counter.upsert({ where: { key }, create: { key, value }, update: { value } });
  await cache.set(`counter:${key}`, value, 3600);
}
```

When write-through makes sense:

- **Single writer.** A worker that owns a counter, a leader-elected job, a
  job queue with idempotency keys. With many writers, two writes race and
  the cache ends up with the loser's value.
- **The cached value is the source of truth.** Session blobs, rate-limit
  counters, ephemeral state.
- **Read-after-write consistency is required.** A user updates their name
  and the next page load must show it. Write-through means the cache is
  fresh before the response leaves the server.

When write-through fails:

- **Many concurrent writers.** Two pods both write the counter; both update
  Redis; the last `SET` wins, but it might not be the last DB `UPDATE`. The
  cache and DB diverge until TTL.
- **Cross-entity invalidation.** Writing the product updates the product
  cache — but does it also bust the "products by category" list? Tags or
  explicit invalidation handle that, not write-through.

For multi-writer scenarios, use cache-aside with explicit `del` on writes,
plus a TTL as the safety net.

---

## Invalidation — three strategies

Cache invalidation, the famous hard problem. There are three real
strategies, each with a different failure mode. Pick by your tolerance for
staleness.

### TTL — the always-stale-window-acceptable strategy

Set a TTL on every key. Stale reads happen for up to that TTL after a
write. Nothing else.

```ts
await cache.set(`product:${id}`, row, 60); // up to 60s stale
```

When this works:

- Read-heavy, write-rare keys. A product catalogue updated once a day.
- The application can tolerate the staleness — "this page is up to a
  minute behind" is acceptable.
- You have many writers and explicit invalidation is fragile.

When this fails:

- Read-after-write consistency requirements ("I just changed my name").
  Pair TTL with explicit invalidation to fix the read-after-write case;
  TTL still backs you up if the invalidation is dropped.

The simplest strategy and the one that fails least catastrophically. Reach
for it first.

### Explicit invalidation — fragile but immediate

On every write that touches a cached entity, delete the cache key:

```ts
const updated = await db.product.update({ where: { id }, data: patch });
await cache.del(`product:${id}`);
```

When this works:

- The set of keys touched by a write is enumerable. Updating a product
  invalidates `product:${id}` and that is the whole list.
- You control every write path. If a SQL migration or a background job
  bypasses your wrapper, the cache and DB diverge silently.

When this fails:

- A write fans out into many cache entries. Updating a product's category
  invalidates the product, the category-list, the search-index, every
  org's products-by-category cache. Maintaining that list in every
  mutation site is a bug factory.
- Writes happen outside your app — a DB admin running `UPDATE`, a SQL
  migration, an event consumer. The cache stays stale until TTL.

Always pair with TTL. Explicit invalidation alone is brittle; explicit
plus a 5-minute TTL is safe.

### Tag-based — what you actually want for non-trivial caches

Every cache write records the tags it is associated with. Invalidation
busts every key bearing a tag.

```ts
await cache.setTagged(
  `feed:org:${orgId}:user:${userId}`,
  rows,
  60,
  [`org:${orgId}`, `user:${userId}`],
);

// On any product update inside the org:
await cache.invalidateTag(`org:${orgId}`);
```

Implementations:

- **Redis sets** — for each tag, a `SADD` of the cache key into a
  `tag:org:${orgId}` set. Invalidation reads the set and `DEL`s every
  member. Cheap; the set grows unbounded if you do not also expire it.
- **CDN surrogate keys** — Fastly's `Surrogate-Key` header and
  Cloudflare's Cache-Tag header are tag-based at the edge. See
  [CDN and HTTP cache](#cdn-and-http-cache-for-read-endpoints).
- **In-memory** — a `Map<tag, Set<key>>` alongside the LRU. Same logic,
  no network hop.

The trade-off:

- Tags give you the right semantic primitive — "everything about org 42"
  is one invalidate call.
- Tags add bookkeeping. Every write tags every entry. Every invalidate
  reads the tag set, walks it, deletes. The cost is small but it is not
  zero.

For non-trivial caches with cross-entity dependencies, tag-based is
correct and explicit invalidation is wrong. Reach for tag-based once you
have more than a single entity in the cache.

---

## Cache-key design

Keys should be:

1. **Stable** — the same query maps to the same key, every time, across
   processes and deploys.
2. **Versioned** — when the cached shape changes, the key changes, and
   stale entries die out of their TTL window without a flush.
3. **Namespaced** — `{tenant}:{model}:{action}:{args-hash}` so prefix
   invalidation is cheap.
4. **Compact** — Redis stores keys in RAM. A 200-byte key on a 50 KB
   value is fine; a 200-byte key on a 100-byte value is wasteful.

```ts
import { createHash } from 'node:crypto';

function cacheKey(model: string, op: string, args: unknown, version = 'v1'): string {
  const canon = canonicalize(args);
  const hash = createHash('sha1').update(canon).digest('base64url').slice(0, 16);
  return `f:${version}:${model}:${op}:${hash}`;
}

function canonicalize(value: unknown): string {
  // Sort object keys recursively so `{a:1,b:2}` and `{b:2,a:1}` map to one key.
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as any)[k])}`).join(',')}}`;
}
```

Why canonicalize:

- `findMany({ where: { a: 1, b: 2 } })` and
  `findMany({ where: { b: 2, a: 1 } })` are semantically identical but
  serialize to different JSON. Without canonicalization you cache two
  copies of the same result.
- Floating-point keys are dangerous — `0.1 + 0.2` is not `0.3`. Either
  refuse to cache queries with float args, or quantize them.
- Date/`BigInt`/regex arguments must be turned into strings explicitly.
  `JSON.stringify` will throw on `BigInt` and silently drop regex.

The version suffix (`v1`) is for cached-shape breaking changes — a new
field in `select`, a renamed column, anything where old cached rows would
mis-deserialize. Bump it, redeploy, and the old keys expire on their TTL.

---

## Stale-while-revalidate

Serve the stale value immediately; refresh the cache in the background.
The next request sees the fresh value; this one is fast.

```ts
async function getProductSWR(id: string): Promise<Product | null> {
  const key = `product:${id}`;
  const meta = await cache.get<{ value: Product | null; refreshAt: number }>(key);

  if (meta && meta.refreshAt > Date.now()) return meta.value;

  if (meta) {
    // Stale but present — return it, refresh in background.
    queueMicrotask(async () => {
      const row = await db.product.findUnique({ where: { id } });
      await cache.set(key, { value: row, refreshAt: Date.now() + 60_000 }, 600);
    });
    return meta.value;
  }

  // Cold miss — block.
  const row = await db.product.findUnique({ where: { id } });
  await cache.set(key, { value: row, refreshAt: Date.now() + 60_000 }, 600);
  return row;
}
```

`refreshAt` is the "this is fresh" deadline; the Redis TTL is the
absolute "discard" deadline. Between those two the value is stale-but-
servable.

When this works:

- The response can tolerate a few seconds of staleness in exchange for
  consistent low latency.
- You have enough request volume that the background refresh runs before
  the value gets too stale.

When this fails:

- Low-traffic keys — the value is stale for hours because no one
  triggered a refresh. TTL takes care of the bottom but the SWR window
  is wasted.
- Coordinated refresh across pods — every pod that sees the stale value
  triggers a refresh. Without singleflight, you get N concurrent
  refreshes for one stale key. See [Cache stampede](#cache-stampede--singleflight-and-jitter).

The HTTP equivalent — `Cache-Control: stale-while-revalidate=60` — is
implemented by browsers and CDNs and is the same idea at the edge layer.
See [CDN and HTTP cache](#cdn-and-http-cache-for-read-endpoints).

---

## Negative caching

Cache misses (`null`, `404`, "no such row") need to be cached too — with
a shorter TTL than positive hits.

```ts
async function getUser(id: string): Promise<User | null> {
  const key = `user:${id}`;
  const hit = await cache.get<User | null>(key);
  if (hit !== undefined) return hit; // includes cached null

  const row = await db.user.findUnique({ where: { id } });
  await cache.set(key, row, row ? 300 : 30);
  return row;
}
```

The bug this prevents: a scraper hitting `/user/<random-id>` ten thousand
times per second. Without negative caching, every miss hits the DB.
`findUnique` on a missing key is cheap — index lookup, no row — but at
scale "cheap" times "infinite" is not cheap.

Shorter TTL on misses, because the cost of a stale miss (briefly serving
"not found" after the row appears) is usually higher than the cost of a
stale hit (briefly serving an old row).

If you cannot afford to cache `null` because the key space is genuinely
unbounded, use a Bloom filter in front of the cache — see
[Memory limits](#memory-limits-and-eviction).

---

## CDN and HTTP cache for read endpoints

For read endpoints serving the same response to many users, the cheapest
cache is the one in front of your origin. Cloudflare, Fastly, Vercel Edge,
Bunny — all of them honour `Cache-Control` and a surrogate-key header for
tag-based invalidation.

```ts
app.get('/v1/products', async (req, res) => {
  const products = await db.product.findMany({
    where: { published: true },
    orderBy: { rank: 'desc' },
    take: 100,
  });
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.setHeader('Surrogate-Key', 'products products-list');
  res.setHeader('Vary', 'Accept-Encoding');
  res.json({ data: products });
});
```

Header-by-header:

- `Cache-Control: public, max-age=60` — every cache in the chain
  (browser, CDN, intermediate proxy) may cache for 60 seconds.
- `stale-while-revalidate=300` — for an additional 5 minutes the cache
  may serve stale while it fetches a fresh copy in the background.
- `Surrogate-Key` (Fastly) / `Cache-Tag` (Cloudflare) — comma-separated
  tags. The CDN's purge API takes a tag and busts every cached response
  bearing it.
- `Vary: Accept-Encoding` — necessary if you serve gzip and brotli. Skip
  `Vary: Authorization` unless you genuinely have per-user cached
  responses; it kills hit rate.

Per-user responses do **not** belong at the CDN unless they are tagged
private and you have personalisation tokens. The right answer is usually
public for the public bits, private for the personalised bits, and a
client-side join.

Purging on writes:

```ts
import { fetch } from 'undici';

async function purgeTag(tag: string) {
  await fetch('https://api.fastly.com/service/SVC/purge/' + tag, {
    method: 'POST',
    headers: { 'Fastly-Key': process.env.FASTLY_KEY! },
  });
}

// In a post-write handler:
await purgeTag('products-list');
```

For Cloudflare, the equivalent is `POST /zones/{zone_id}/purge_cache`
with `{"tags": ["products-list"]}`.

The HTTP cache layer is the highest-leverage cache in the stack — one
hit at the edge is one less round trip to your origin, your DB, and
every layer in between. Tag every cacheable response, purge tags on
writes, and most of your read traffic never touches your origin.

---

## forge events as invalidation triggers

forge emits a `query` event on every successful query (see
[EVENTS.md](EVENTS.md)). The event includes `model`, `op`, `semanticOp`,
and the arguments. This is exactly the surface a cache invalidator wants —
one place to wire "when a write happens, invalidate."

```ts
import { db } from './db';
import { cache } from './lib/redis-cache';
import { purgeTag } from './lib/cdn';

const WRITE_SEMANTIC_OPS = new Set([
  'insert',
  'update',
  'upsert',
  'delete',
  'updateMany',
  'deleteMany',
]);

db.$on('query', async (event) => {
  if (!WRITE_SEMANTIC_OPS.has(event.semanticOp)) return;

  const { model } = event;

  // Application cache — tag-based.
  await cache.invalidateTag(model);

  // CDN — surrogate-key purge.
  await purgeTag(`${model}-list`);

  // Per-row, when the args carry an id.
  const id =
    (event.args as any)?.where?.id ??
    (event.args as any)?.data?.id ??
    undefined;
  if (typeof id === 'string') {
    await cache.del(cacheKey(model, 'findUnique', { where: { id } }));
  }
});
```

Three things to notice:

1. **Centralised.** Every mutation in the codebase, every repository, every
   migration that writes through the ORM — they all flow through this one
   subscriber. No risk of a new endpoint forgetting to bust the cache.
2. **Best-effort.** The invalidator is async and fire-and-forget. If it
   throws, the request that triggered it still succeeds (the write
   already committed). Pair with a TTL so a dropped invalidation
   eventually self-heals.
3. **Out of band.** This runs after `commit`, so a tx that rolls back
   never busts the cache for a write that never happened. The `query`
   event fires on resolve, not on dispatch.

Caveat: writes that bypass the ORM — raw SQL via `db.$raw`, migrations,
DB-side triggers — do not fire this event. Either route them through
forge, or expose a separate "invalidate" RPC and call it from wherever
the write happens. See [RAW-SQL.md](RAW-SQL.md) for the raw-SQL escape
hatch and its trade-offs.

---

## Cache stampede — singleflight and jitter

On a cold cache key with many concurrent readers, the naive cache-aside
triggers N concurrent DB queries: the first reader misses and starts the
query; every other reader misses while it is in flight; all N queries hit
the DB. This is the **cache stampede** (also called dog-piling).

Two defences, both required for hot keys.

### Singleflight — collapse concurrent loads

```ts
const inflight = new Map<string, Promise<unknown>>();

async function singleflight<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = loader().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function getProductSF(id: string): Promise<Product | null> {
  const key = `product:${id}`;
  const hit = await cache.get<Product>(key);
  if (hit !== undefined) return hit;

  return singleflight(key, async () => {
    // Re-check inside the singleflight in case another caller populated.
    const second = await cache.get<Product>(key);
    if (second !== undefined) return second;
    const row = await db.product.findUnique({ where: { id } });
    await cache.set(key, row, 300);
    return row;
  });
}
```

This works inside a single process. Across pods, a Redis-backed lock
(`SET key NX EX 10`) does the same job — first pod to grab the lock
runs the loader, others poll. Acceptable for very hot keys; overkill for
most.

### Jittered TTL — avoid synchronous expiration

If 1000 keys expire at the same wall-clock instant (because they were all
written in a batch loader at boot), 1000 misses happen simultaneously.

```ts
function jittered(base: number, spreadFraction = 0.1): number {
  const spread = base * spreadFraction;
  return Math.floor(base + (Math.random() * 2 - 1) * spread);
}

await cache.set(key, row, jittered(300, 0.1)); // 270..330s
```

Apply jitter to every TTL. The cost is one `Math.random` per write; the
benefit is that expirations spread across a window instead of bursting at
one instant.

Combine: hot keys get singleflight, every key gets jittered TTL. The hot
ones cost the most when they stampede; the cold ones outnumber them
1000:1 and only need the jitter.

---

## Memory limits and eviction

Caches without a memory limit run until the host OOMs. Every cache layer
needs an eviction policy.

| Policy | What it evicts | When |
|---|---|---|
| **LRU** (Least Recently Used) | the entry not accessed for the longest | default, almost always right |
| **LFU** (Least Frequently Used) | the entry accessed fewest times | when access counts are heavy-tailed and a few hot keys carry most traffic |
| **FIFO** | the oldest entry | when access patterns are uniform and recency is uninformative |
| **TTL-only** | nothing — entries die only on expiry | for caches where the working set fits in RAM |

For in-process caches in Node, `lru-cache` is the standard:

```ts
import { LRUCache } from 'lru-cache';

const local = new LRUCache<string, unknown>({
  max: 10_000,
  ttl: 60_000,
  allowStale: true,
  updateAgeOnGet: false,
});
```

`max` is the entry count cap. `ttl` is a per-entry TTL.
`updateAgeOnGet: false` means a read does not refresh the entry's TTL —
otherwise a hot key never expires and you cannot rotate to fresh data.

For Redis, the policy is configured server-side
(`maxmemory-policy allkeys-lru` or `volatile-lru`). `volatile-lru` only
evicts keys with a TTL, which is what you want for shared Redis where
non-cache keys also live.

A Bloom filter in front of the cache is an underused technique for
unbounded key spaces. The filter says "this key has never been written"
fast (no Redis call), so misses on never-existed keys do not even reach
Redis. Useful for negative-caching very hot endpoints that face arbitrary
user input.

---

## Worked examples

Four end-to-end recipes, each independent.

### (a) Redis cache-aside for the home feed

Feed for `userId` is the same for the next 30 seconds. We accept that
window and key by user.

```ts
// src/api/feed.ts
import { db } from '../db';
import { cache } from '../lib/redis-cache';
import { singleflight } from '../lib/singleflight';

const FEED_TTL = 30;

export async function getHomeFeed(userId: string) {
  const key = `feed:home:${userId}:v2`;
  const hit = await cache.get<HomeFeed>(key);
  if (hit) return hit;

  return singleflight(key, async () => {
    const second = await cache.get<HomeFeed>(key);
    if (second) return second;

    const posts = await db.post.findMany({
      where: {
        author: { is: { follower_ids: { has: userId } } },
        published: true,
      },
      orderBy: { rank_score: 'desc' },
      take: 50,
      include: { author: { select: { id: true, name: true, avatar_url: true } } },
    });

    const feed: HomeFeed = { posts, generated_at: Date.now() };
    await cache.set(key, feed, jittered(FEED_TTL));
    return feed;
  });
}

// invalidate on follow/unfollow
db.$on('query', async (event) => {
  if (event.model !== 'follow') return;
  if (!['insert', 'delete'].includes(event.semanticOp)) return;
  const follower = (event.args as any)?.data?.follower_id ?? (event.args as any)?.where?.follower_id;
  if (follower) await cache.del(`feed:home:${follower}:v2`);
});
```

Note the version (`v2`) — when we change the `select` shape, bump it.

### (b) DataLoader per-request

Already shown in [DataLoader-style per-request cache](#dataloader-style-per-request-cache).
The key shape difference from Redis cache-aside: no TTL, no
serialization, no eviction policy. The loader dies with the request.

### (c) Write-through on a hot counter

A view-count counter that is read on every page load and written on
every view. The cache is the source of truth between flushes; a
background job persists to the DB every 10 seconds.

```ts
// src/lib/view-counter.ts
import { Redis } from 'ioredis';
import { db } from '../db';

const r = new Redis(process.env.REDIS_URL!);

export async function bumpView(postId: string) {
  // Write-through — cache is source of truth.
  await r.incr(`views:post:${postId}`);
}

export async function readViews(postId: string): Promise<number> {
  const v = await r.get(`views:post:${postId}`);
  return v ? Number(v) : 0;
}

// Background flusher — every 10s, flush all dirty counters to DB.
async function flush() {
  let cursor = '0';
  do {
    const [next, batch] = await r.scan(cursor, 'MATCH', 'views:post:*', 'COUNT', 500);
    cursor = next;
    if (!batch.length) continue;
    const values = await r.mget(...batch);
    await db.$transaction(async (tx) => {
      for (let i = 0; i < batch.length; i++) {
        const id = batch[i].split(':')[2];
        const v = Number(values[i] ?? '0');
        await tx.post.update({ where: { id }, data: { view_count: v } });
      }
    });
  } while (cursor !== '0');
}

setInterval(() => { void flush().catch(console.error); }, 10_000);
```

Trade-off: a crash between flushes loses up to 10 seconds of view counts.
That is acceptable for analytics; not acceptable for billing. For
billing, do not write-through; do `INCR` on a Redis counter as a
write-ahead log and persist transactionally, or skip Redis entirely.

### (d) HTTP CDN for /v1/products

```ts
// src/api/products.ts
app.get('/v1/products', async (req, res) => {
  const { category, cursor } = req.query as { category?: string; cursor?: string };

  const rows = await db.product.findMany({
    where: { published: true, ...(category ? { category } : {}) },
    orderBy: [{ rank: 'desc' }, { id: 'asc' }],
    take: 50,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  res.setHeader(
    'Cache-Control',
    'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
  );
  res.setHeader(
    'Surrogate-Key',
    ['products', `products:category:${category ?? 'all'}`].join(' '),
  );
  res.setHeader('Vary', 'Accept-Encoding');
  res.json({
    data: rows,
    meta: { next_cursor: rows.length === 50 ? rows[rows.length - 1].id : null },
  });
});

// In the write path:
db.$on('query', async (event) => {
  if (event.model !== 'product') return;
  if (!['insert', 'update', 'upsert', 'delete'].includes(event.semanticOp)) return;
  await purgeTag('products');
  const category = (event.args as any)?.data?.category;
  if (category) await purgeTag(`products:category:${category}`);
});
```

The cursor in the URL is intentional — keyset pagination means every
cursor maps to a stable response that the CDN can cache indefinitely
within its TTL. Offset pagination breaks this: insert one row and every
cached page shifts. See [QUERIES.md](QUERIES.md#pagination--offset-vs-cursor).

---

## Related docs

- [QUERIES.md](QUERIES.md) — the read surface every cache wraps. Pay
  particular attention to keyset pagination (cacheable) vs offset
  (not).
- [EVENTS.md](EVENTS.md) — the `query` event is the invalidation hook
  used throughout this doc.
- [BACKEND.md](BACKEND.md) — request-scoped wiring, where DataLoader
  and per-request caches attach.
- [METRICS.md](METRICS.md) — `duration_ms` from the query event is how
  you find the candidates worth caching.
- [LOGGING.md](LOGGING.md) — log cache hits and misses with a `cache`
  field; the hit rate is the primary KPI.
- [INDEXES.md](INDEXES.md) — read this before reaching for a cache. A
  missing index is almost always cheaper to fix.
- [DOCTOR.md](DOCTOR.md) — measures schema and query health, surfaces
  the slow queries that cache decisions should target.
- [POOLING.md](POOLING.md) — pool exhaustion looks like slowness; a
  cache will not fix it.
- [RAW-SQL.md](RAW-SQL.md) — raw writes bypass the event hook; either
  route through forge or call the invalidator manually.
- [TRANSACTIONS.md](TRANSACTIONS.md) — the `query` event fires on
  commit, not on dispatch. Rollback does not invalidate.
