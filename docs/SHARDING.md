# Sharding

Horizontal sharding splits one logical database into N physical ones for write throughput, dataset size, or geo-locality. This page documents the shard-key choices, routing patterns, cross-shard query gotchas, and the resharding patterns that work with forge-orm — both native (Mongo, Vitess, Citus) and application-layer.

forge does not ship a sharding layer. It doesn't need to: a forge `db` handle is one client against one logical database, so N forge handles plus a routing function is the entire shape. The harder problems — picking the key, surviving a hot shard, online resharding without dropping writes — sit above forge in your application code. This page is the recipe for that layer.

Companion to **[BACKEND.md](./BACKEND.md)** (where the `db` handles live in a server process) and to a forthcoming **MULTI-TENANT.md** (single-DB tenant isolation, which is what most teams should reach for before they sharding). Sharding is the answer when multi-tenant alone is no longer enough.

## Contents

* [When sharding makes sense](#when-sharding-makes-sense)
* [Shard-key choice](#shard-key-choice)
* [Range vs hash sharding](#range-vs-hash-sharding)
* [forge with multiple DB instances](#forge-with-multiple-db-instances)
* [Routing pattern — AsyncLocalStorage and the request scope](#routing-pattern--asynclocalstorage-and-the-request-scope)
* [Cross-shard queries — fan-out and merge](#cross-shard-queries--fan-out-and-merge)
* [Cross-shard transactions — don't](#cross-shard-transactions--dont)
* [Resharding — splitting a hot shard](#resharding--splitting-a-hot-shard)
* [Native sharding helpers — Mongo, Vitess, Citus, Cosmos](#native-sharding-helpers--mongo-vitess-citus-cosmos)
* [SQLite sharding via DB-per-tenant](#sqlite-sharding-via-db-per-tenant)
* [Schema sync across shards](#schema-sync-across-shards)
* [Backup per shard](#backup-per-shard)
* [Monitoring per shard — hot-shard detection](#monitoring-per-shard--hot-shard-detection)
* [Cost model](#cost-model)
* [Worked example A — hash-sharded by user-id (4 Postgres shards)](#worked-example-a--hash-sharded-by-user-id-4-postgres-shards)
* [Worked example B — Citus-managed sharding](#worked-example-b--citus-managed-sharding)
* [Worked example C — Mongo native sharding](#worked-example-c--mongo-native-sharding)
* [Cross-references](#cross-references)

---

## When sharding makes sense

Sharding is the most expensive horizontal scaling move you can make. It doubles your ops surface, it forecloses transactional patterns you used to take for granted, and it pushes failure modes into the application layer that the database used to absorb for you. So the bar is high. The three reasons that justify paying that price:

* **Single-DB write throughput is exhausted.** You've vertically scaled to the largest instance the provider offers, you've moved every read you can to replicas, you've fanned out background work into queues, and the master is still pegged on writes. The symptom is sustained high CPU on the primary, write latency rising under load, and `vacuum`/`compact` falling behind the write rate. Reads come for free from replicas; writes don't. Sharding is the only way to add more write-capable masters.

* **Dataset size has outgrown the largest single instance.** "Largest" here is whichever of three limits bites first: the provider's per-instance disk cap (RDS PG tops out at 64 TiB, Atlas M-series at 4 TiB per node), the operationally tolerable backup/restore window (a 10 TB Postgres takes hours to `pg_basebackup` and a full day to restore — that's your RTO floor), or the planner's working set (once your hot indexes don't fit in RAM, query latency stair-steps up regardless of CPU). Below ~2 TB, sharding is almost never the right answer for size alone; above ~10 TB, it's usually inevitable.

* **Geo-locality is a hard requirement.** A user in Lagos shouldn't pay 180 ms round-trip per query to a US-East primary. Compliance constraints (data-residency clauses in EU GDPR, India DPDP, Nigeria NDPR) can make geographic colocation legally mandatory. Sharding by region — Lagos rows live on `pg-eu`, São Paulo rows on `pg-sa` — is the cleanest way to honour that, with the application-layer router picking the shard from the user's home region.

If none of those three are biting hard, **don't shard yet**. Reach for read replicas (see [BACKEND.md — Read replicas and split routing](./BACKEND.md#read-replicas-and-split-routing)), better indexes (see [INDEXES.md](./INDEXES.md)), connection-pool sizing (see [POOLING.md](./POOLING.md)), or move large blobs to object storage. Sharding adds engineering cost in perpetuity; a well-tuned single-DB Postgres routinely handles 50k writes/s and 10 TB of data.

The honest decision rule: if you can name a specific feature in the next quarter that fails on a single DB, shard. If you're shading "we might need this someday", don't.

---

## Shard-key choice

The shard key is the column the router reads to pick a shard. Every shard-key choice trades off three things: distribution evenness, locality (do related rows live on one shard?), and resharding pain. Once chosen, the key is *hard* to change — every row, every query, every index assumed it. Pick deliberately.

**Tenant-id (natural for SaaS).** Every row already carries a `tenant_id`; every query already filters on it. Hash that to a shard and almost every read becomes single-shard. Locality is perfect: a tenant's orders, users, audit log, all live together. Resharding is per-tenant, so you can migrate the noisy tenant off a hot shard without touching anyone else. The risk is skew — a single huge tenant on a 4-shard cluster eats 25% of capacity even if everyone else is small. Mitigate by giving large tenants their own dedicated shard outside the hash ring (the "VIP shard" pattern).

**Customer-id / user-id.** When there's no natural tenant — consumer apps, social networks, marketplaces — the user is the locality unit. A user's posts, follows, settings live together; cross-user queries (a friend feed) become fan-out. Hash distribution is typically even because user IDs are random (UUIDs, snowflakes), so you don't get the tenant-skew problem. The trade-off is that any "by relationship" query (mutual follows, group membership) crosses shards.

**Geo-region.** Manually pick `eu`, `us`, `apac`, `latam`. Routing is a lookup from `user.home_region`. This is the only choice that gives you data residency. Distribution evenness is whatever your user base looks like — usually uneven (US and EU dominate). Resharding is rare because regions are stable; the painful operation is *moving* a user between regions when they relocate, which means cross-region row migration.

**Time-based (hot/cold).** Recent data on a hot shard with expensive instance types, old data on cold shards with cheap storage. Common in event-logs, audit trails, time-series. Locality is by recency: today's events live together, last year's together. Distribution is skewed *by design* — the hot shard takes all the writes. Resharding is conceptually trivial (just add a new hot shard each month), but cross-period queries (year-over-year reports) fan out across every shard you have.

**Hash-based (no natural key).** When you literally don't have a key — a flat `events` table where every row stands alone — hash the primary key. Distribution is provably even (modulo the hash function), but locality is zero: every multi-row query is a fan-out. Only pick this when locality genuinely doesn't matter.

A common hybrid in practice: **tenant-id at the top, hash inside.** Small tenants share shards via `hash(tenant_id) % N`; tenants above a size threshold (say 100k rows or 1k writes/s) are pinned to a dedicated shard, exempt from the hash. The router checks an "exception map" first, then falls back to the hash. This handles SaaS skew without flipping to "one DB per tenant" too early.

---

## Range vs hash sharding

Once you've picked a key, you pick *how* the key maps to a shard.

**Hash sharding.** Compute `hash(key) % N` (or, better, jump-consistent hash). Pros: distribution is provably even regardless of the key's natural distribution. Cons: every range scan (`created_at BETWEEN x AND y`, `id > N`) fans out across every shard. Resharding is hostile — changing N changes the mapping for almost every row. Mitigate with consistent-hashing (only `1/N` of keys move on a split) or by keeping the modulus and adding a second translation table.

**Range sharding.** Map contiguous key ranges to shards: `tenant_id 1–1000 → shard A`, `1001–2000 → shard B`. Pros: range scans on the shard key are single-shard; resharding is "split this range into two halves", clean and local. Cons: distribution depends on the key's natural distribution. Monotonic keys (`autoincrement`, `created_at`) write to the highest range only — the last shard becomes the hot shard, the others sit idle. Fix by either hashing the key first (which gets you back to hash sharding) or by writing in interleaved ranges, where each shard owns multiple non-contiguous ranges.

**The practical answer.** For tenant-id and user-id keys, hash is almost always right — you want distribution evenness more than range-scan locality, and you're not range-scanning `user_id` anyway. For time-series, range by month is natural and consistent with how the data is queried. For event-logs with a snowflake-style monotonic key, range sharding will burn you; use the high bits of the snowflake (which include the worker-id) and hash those.

A useful sanity check: pick your prospective shard key and write down the three queries you run most often. Are they single-shard with this key? If not, you've picked the wrong key or the wrong sharding strategy.

---

## forge with multiple DB instances

A forge `db` handle is one client against one logical database. To shard, you build N handles, one per shard, and a router that picks among them. forge has nothing to learn — the `db.user.findFirst(...)` call goes to whichever `db` the router returned.

```ts
// src/db/shards.ts
import { createDb, pgDriver } from 'forge-orm';
import { Pool } from 'pg';
import { schema } from '../schema';

const urls = [
  process.env.DATABASE_URL_SHARD_0!,
  process.env.DATABASE_URL_SHARD_1!,
  process.env.DATABASE_URL_SHARD_2!,
  process.env.DATABASE_URL_SHARD_3!,
];

export const shards = await Promise.all(
  urls.map(async (url) => {
    const pool = new Pool({
      connectionString: url,
      max: 8, min: 0,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    return createDb({ schema, driver: pgDriver(pool) });
  }),
);

/** Hash-based routing. Mod N — replace with consistent-hash for safer resharding. */
export function shardFor(key: string) {
  const h = fnv1a(key);
  return shards[h % shards.length];
}

function fnv1a(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h;
}
```

A few invariants:

* **One `createDb` per shard, built at boot.** Don't lazily create — the first request to an un-built shard pays the full handshake cost and times out the cold-start. Build all N in parallel at startup.
* **Pool size is per-shard, not per-cluster.** If your single-DB pool was 16, each shard pool should *also* be sized to its own load, not 16/N. Adding shards means more open connections, not redistributing the same number.
* **Schema is identical across shards.** Every `db` in `shards` is constructed with the same `schema` object. forge has no way to enforce this beyond your code — see [Schema sync across shards](#schema-sync-across-shards) for the operational rule.
* **One `$disconnect` per shard at shutdown.** Drain them in parallel: `await Promise.all(shards.map(s => s.$disconnect()))`.

The router function is the entire abstraction. Everywhere you'd write `db.user.findFirst(...)` you now write `shardFor(tenantId).user.findFirst(...)`. The same shape works for `$transaction` — `shardFor(tenantId).$transaction(async (tx) => { ... })` runs the tx on one shard, just like before, with the understanding that the tx can only touch rows on that shard.

---

## Routing pattern — AsyncLocalStorage and the request scope

Threading `shardFor(tenantId)` through every layer of an app is brittle: any function that forgets it cracks the isolation. The pattern from [BACKEND.md](./BACKEND.md#production-server-recipes) — `AsyncLocalStorage` for the request-scoped `db` — extends naturally to sharding. Stash the shard at request entry, read it from anywhere down the call stack.

```ts
// src/db/shard-scope.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ForgeDb } from 'forge-orm';
import { shardFor } from './shards';

const shardStore = new AsyncLocalStorage<ForgeDb>();

/** Read the shard set for the current request. Throws if no scope is active. */
export function scoped(): ForgeDb {
  const db = shardStore.getStore();
  if (!db) throw new Error('No shard scope active — wrap the call in withShard()');
  return db;
}

export function withShard<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return shardStore.run(shardFor(tenantId), fn);
}
```

Wire it into the request middleware. For hyper-express:

```ts
app.use(async (req, res, next) => {
  const tenantId = req.header('x-tenant-id') ?? req.user?.tenantId;
  if (!tenantId) {
    res.status(400).json({ error: 'tenant_id required' });
    return;
  }
  await withShard(tenantId, async () => {
    await new Promise<void>((resolve, reject) => {
      res.once('finish', resolve);
      res.once('abort', () => reject(new Error('client aborted')));
      next();
    });
  });
});

app.get('/orders', async (req, res) => {
  const orders = await scoped().order.findMany({ where: { tenant_id: req.user.tenantId } });
  res.json(orders);
});
```

A few rules this enforces:

* **The shard is fixed for the request.** If a handler tries to read tenant A and write tenant B, it crashes loud — the scope picked tenant A's shard, and tenant B's rows aren't there. That's the desired failure mode.
* **The tenant_id filter is still required.** Sharding isolates physical storage; it does not exempt you from filtering by `tenant_id` in your `where` clauses. Two tenants can collide on a shard (it's hash-based, after all), so a missing filter still leaks rows. See the row-level pattern in [BACKEND.md — Multi-tenant patterns](./BACKEND.md#multi-tenant-patterns).
* **Background jobs need their own scope.** A BullMQ worker that processes a job for tenant X has to call `withShard(job.data.tenantId, ...)` itself — there's no HTTP middleware. Put the tenant id in the job payload, never look it up.

For an admin endpoint that legitimately needs to touch any shard — say, a cross-tenant search — bypass the scope explicitly and call `shardFor(tenantId)` directly. The explicit call is a code-review signal that says "yes, this crosses tenants, I meant it."

---

## Cross-shard queries — fan-out and merge

You will eventually need to ask a question that spans shards. An admin dashboard listing every overdue invoice, a global search, a billing reconciliation report. The pattern is *fan-out and merge*: run the same query on every shard in parallel, then merge in the application.

```ts
import { shards } from './shards';

export async function findAllOverdueInvoices() {
  const perShard = await Promise.all(
    shards.map((s) => s.invoice.findMany({ where: { status: 'overdue' } })),
  );
  return perShard.flat();
}
```

That works for small result sets. It falls apart in three places:

* **Ordering.** `ORDER BY created_at DESC LIMIT 50` on each shard returns 50 rows per shard, sorted independently. The merged global top-50 is `mergeSort(perShard.flat())` then `.slice(0, 50)`. If your `LIMIT` is small and the orderings are highly correlated (most recent rows on a few shards), you can early-terminate; otherwise read `LIMIT` from every shard and merge in memory.
* **Pagination.** Cursor pagination across shards is much harder than within one. The cursor has to encode "where I am on every shard" — typically the last `(created_at, id)` you read from each. forge's `findManyStream` per shard plus a merge cursor is the cleanest shape; never try to do `OFFSET` across shards (the offset is per-shard, so `OFFSET 100` skips 100 *on each*, which is not what the user asked for).
* **Aggregation.** `COUNT(*)`, `SUM(amount)`, `AVG(...)` need a per-shard reduce step then a final reduce in the app. `AVG` in particular can't be averaged-of-averages; you need `(sum, count)` from each shard and divide at the end.

```ts
export async function totalRevenueByCurrency() {
  const perShard = await Promise.all(
    shards.map((s) =>
      s.$queryRaw<Array<{ currency: string; sum: string; n: string }>>`
        SELECT currency, SUM(amount) AS sum, COUNT(*) AS n
        FROM invoices WHERE paid_at IS NOT NULL
        GROUP BY currency
      `,
    ),
  );

  const totals = new Map<string, { sum: number; n: number }>();
  for (const rows of perShard) {
    for (const r of rows) {
      const t = totals.get(r.currency) ?? { sum: 0, n: 0 };
      t.sum += Number(r.sum);
      t.n   += Number(r.n);
      totals.set(r.currency, t);
    }
  }
  return [...totals].map(([currency, { sum, n }]) => ({ currency, sum, avg: sum / n }));
}
```

Two operational rules for fan-out:

* **Treat fan-out as expensive.** Every cross-shard query costs `O(N)` connections, blocks waiting on the slowest shard, and bypasses every locality benefit of sharding in the first place. Cache aggressively (see [CACHING.md](./CACHING.md)); precompute into a materialised summary table on each shard that a single admin shard reads from.
* **Better: denormalise.** When the cross-shard query is on a stable hot path — a homepage feed, a global leaderboard — keep a denormalised projection on a dedicated "summary" DB outside the shard ring. Write to it asynchronously from each shard via an outbox or change-data-capture. The cross-shard fan-out becomes a single-DB read.

If your top-10 queries by frequency include fan-outs, you chose the wrong shard key. Re-examine.

---

## Cross-shard transactions — don't

You cannot atomically commit across shards with the tools forge gives you. `db.$transaction` is per-`db`; it begins and commits on one shard's connection. Two shards mean two transactions, and the moment shard A commits while shard B fails, you have inconsistent state with no rollback.

**Don't reach for two-phase commit.** Postgres has `PREPARE TRANSACTION` and 2PC across instances works in principle, but in practice it's a footgun — a prepared transaction left open by a crashed coordinator holds locks indefinitely, blocking every write touching the same row. forge does not expose 2PC; if you want it, you're hand-rolling it, and you're owning the recovery story. The handful of teams who do this successfully run a dedicated transaction coordinator service with monitored timeouts. Don't be the team that learns about prepared-transaction lock-hold the hard way.

**Use sagas with idempotent compensation.** The standard pattern for cross-shard state changes is:

1. Write to shard A (the "first" change).
2. Enqueue a job for shard B (with the shard A outcome encoded as a job-id).
3. The worker writes to shard B. If it fails, retry; if it permanently fails, run a compensating write on shard A.

Every step has to be idempotent. The job-id derived from a stable input (e.g. `transfer:${transferId}`) means BullMQ deduplicates retries; the writes themselves use `upsert` or check-then-write guarded by a version column. See [TRANSACTIONS.md](./TRANSACTIONS.md) for the single-DB primitives the saga steps use, and a forthcoming **IDEMPOTENCY.md** for the keying patterns.

```ts
// Example: transfer N units between two tenants on different shards.
import { Queue } from 'bullmq';
import { shardFor } from './db/shards';

const compensations = new Queue('compensate-transfers', { connection: { url: process.env.REDIS_URL } });
const transfers     = new Queue('apply-transfers',      { connection: { url: process.env.REDIS_URL } });

export async function startTransfer(srcTenant: string, dstTenant: string, amount: number) {
  const transferId = crypto.randomUUID();

  // 1. Reserve on source — uses source shard's local tx.
  await shardFor(srcTenant).$transaction(async (tx) => {
    await tx.account.update({
      where: { tenant_id: srcTenant },
      data:  { balance: { decrement: amount } },
    });
    await tx.transfer.create({
      data: { id: transferId, status: 'reserved', amount, src: srcTenant, dst: dstTenant },
    });
  });

  // 2. Enqueue apply-on-destination. Idempotent by transferId.
  await transfers.add('apply', { transferId, dstTenant, amount },
    { jobId: `apply:${transferId}`, attempts: 8, backoff: { type: 'exponential', delay: 1000 } });
}
```

The worker that consumes `apply-transfers` writes to `dstTenant`'s shard, marks the source-shard transfer as `applied`, and on permanent failure enqueues a compensation that re-credits the source. Every write is gated on the current `status` so retries don't double-apply.

The shorter form: **if you want cross-shard atomicity, you don't actually want sharding.** Move that pair of writes to a single shard (co-locate by parent tenant), or split out the cross-cutting data into a small unsharded "global" DB.

---

## Resharding — splitting a hot shard

Eventually one shard becomes too hot. The tenant on it grew, the hash distribution skewed, the natural region kept growing. Resharding is moving rows off the hot shard onto a new one. The variable is whether you do it with downtime or while serving traffic.

**Maintenance-window resharding.** Stop writes to the hot shard (return 503 on its tenants), `pg_dump` the rows you want to migrate, `pg_restore` them into the new shard, update the router config, drop the migrated rows from the old shard, resume writes. This is the simplest pattern and the only honest answer for small teams: an hour of downtime once a year is cheaper than building online resharding correctly.

**Online resharding — dual-write.** When downtime isn't acceptable, the pattern is:

1. **Pre-create the new shard** with the schema (run `forge push` against its URL).
2. **Switch the router into dual-write mode** for the keys being moved. Writes go to both the old shard (authoritative) and the new shard (mirror). Reads stay on the old shard.
3. **Backfill** historical rows from the old shard to the new with a streaming copy. Use `forge`'s `findManyStream` to avoid loading the whole dataset, and write idempotently to the new shard.
4. **Switch reads to the new shard.** A small read-from-new flag, flipped per-tenant, lets you test against the new shard before fully committing.
5. **Stop dual-write.** Writes now go only to the new shard; reads, only to the new shard.
6. **Tombstone or delete** the old rows from the old shard.

The whole process takes hours to days for a large tenant. Every step has to be reversible; every step has to be idempotent. The dual-write window is the dangerous one — if the new shard's write fails and the old shard's succeeds, you've diverged. Mitigate by writing to the *new* shard first and the *old* shard second, so a failure on the new shard short-circuits before the old shard sees the divergent commit.

```ts
// Sketch of the dual-write router during resharding.
export function shardForWrite(tenantId: string) {
  const phase = reshardPhase(tenantId); // null | 'dual-write' | 'cut-over'
  if (phase === null)      return [shardFor(tenantId)];
  if (phase === 'cut-over')return [newShardFor(tenantId)];
  // phase === 'dual-write': write to new first, then old. Fail-fast on new.
  return [newShardFor(tenantId), shardFor(tenantId)];
}

export async function createOrder(tenantId: string, data: OrderInput) {
  const targets = shardForWrite(tenantId);
  let first: Order | undefined;
  for (const db of targets) {
    const row = await db.order.upsert({
      where:  { id: data.id },
      create: data,
      update: data,
    });
    first ??= row;
  }
  return first!;
}
```

The `upsert` matters: under dual-write the backfill copy may race with the live writer for the same row. `upsert` is idempotent. A plain `create` would race-condition into a duplicate-key error half the time, depending on which side won.

**Verifying the cut-over.** Before you stop dual-write, run a checksum pass: for each tenant being moved, compute a per-row hash on both shards and compare. forge has `findManyStream` for the read side; pipe both through the same hash function and assert equality. Until that's green, do not cut over. See [BACKUP-RESTORE.md — Restore drill](./BACKUP-RESTORE.md#restore-drill--a-script-you-can-lift) for the structural pattern; the checksum recipe is the same.

**Why consistent hashing helps.** A vanilla `hash(key) % N` mapping means that going from 4 shards to 5 *moves 4/5 of all rows*. Consistent hashing (Ketama, jump-consistent) moves only `1/N` per added shard — about 20% with the same growth. The router code is fifty lines longer; the resharding effort is two orders of magnitude smaller. If you're going to shard at all, start with consistent hashing.

---

## Native sharding helpers — Mongo, Vitess, Citus, Cosmos

Several databases ship sharding inside the engine. forge composes naturally with all of them — your application sees a single connection, the engine routes internally.

**MongoDB native sharding.** A sharded cluster has `mongos` routers in front of the shards. The connection string points at `mongos`; `MongoClient` and `mongoDriver(client, dbName)` work unchanged. You declare the shard key per-collection via `sh.shardCollection('db.collection', { tenant_id: 'hashed' })` once, ahead of time. Mongo decides which shard a write lands on. The trade-off is that the shard-key field becomes immutable post-write — you can't update `tenant_id` on an existing document. forge has no special handling here; just don't expose `tenant_id` as a mutable field in your zod input schema. See [MONGO.md](./MONGO.md#sharding-considerations) for the per-collection rules and aggregation-pipeline implications.

**Vitess (for MySQL).** Vitess sits in front of N MySQL primaries and presents a single SQL endpoint. Your `mysql2` connection points at `vtgate` (the router); forge talks to it via `mysqlDriver(pool)`. Vitess handles cross-shard reads itself — `SELECT * FROM users WHERE tenant_id = ?` is routed; `SELECT * FROM users` is scatter-gathered. The vschema (per-table shard-key declaration) is configured outside forge. Transactions across vindexes go through 2PC, with the same caveats as application-layer 2PC; prefer single-shard transactions.

**Citus (for Postgres).** Citus extends Postgres with `create_distributed_table('orders', 'tenant_id')`. After that, your forge `pgDriver(pool)` against the Citus coordinator works as if it were a single Postgres — Citus rewrites the query plan to fan out to workers. Distributed transactions across shards work via 2PC; co-located joins (same shard key, same distribution column) avoid the fan-out. The forge schema is identical to single-Postgres; the Citus-specific DDL (`create_distributed_table`, `create_reference_table`) lives outside the forge schema and runs once after `forge push`.

```ts
// After forge push, run Citus DDL once.
await db.$executeRaw`SELECT create_distributed_table('orders',  'tenant_id')`;
await db.$executeRaw`SELECT create_distributed_table('users',   'tenant_id')`;
await db.$executeRaw`SELECT create_reference_table('countries')`;       // small lookup, replicated everywhere
```

**Azure Cosmos DB.** Cosmos shards by partition key. The Mongo API of Cosmos is largely compatible with `mongoDriver`, with the constraint that every query *must* include the partition key in the filter; cross-partition queries are slow and rate-limited. The lesson is the same as everywhere on this page: pick a shard key your queries already use, and pin every query to it.

The pattern in all four: the database does the routing, forge is a single client, and the schema lives in forge as if it were single-instance. What you give up is the freedom to write any query and have it work — engine-level sharding is more transparent than application-level, but it's not magic, and the limits are still real.

---

## SQLite sharding via DB-per-tenant

SQLite cannot serve multiple writers from one file — the WAL serialises writes through a single mutex. The native sharding answer is **one SQLite file per tenant**, mapped from the same forge schema. This pattern doubles as the multi-tenant model for SQLite-on-the-edge (Cloudflare D1, Turso, fly.io LiteFS) and is the simplest sharding strategy in the entire forge surface.

```ts
// src/db/sqlite-shards.ts
import { createDb } from 'forge-orm';
import { schema } from '../schema';

const tenantDbs = new Map<string, Awaited<ReturnType<typeof createDb>>>();

export async function getTenantDb(tenantId: string) {
  let db = tenantDbs.get(tenantId);
  if (db) return db;
  db = await createDb({
    url: `sqlite:./data/tenants/${tenantId}.db`,
    schema,
  });
  await db.$migrate();  // bring the file up to current schema on first open
  tenantDbs.set(tenantId, db);
  return db;
}
```

The properties this gives you:

* **Perfect write isolation.** Two tenants never contend for the same WAL mutex.
* **Per-tenant backup is `cp file.db file.bak`.** See [BACKUP-RESTORE.md — SQLite streaming with litestream](./BACKUP-RESTORE.md#sqlite-streaming-with-litestream).
* **Per-tenant restore is `cp file.bak file.db`** with the app down for that tenant only.
* **Per-tenant `forge push`.** `db.$migrate()` on open is the right shape — every file is at the current schema before the first query runs.

The drawback is file-handle exhaustion at large tenant counts. An LRU on `tenantDbs` with eviction at 200-500 open handles is the usual cap; the cost of re-opening is one file `stat` plus the WAL replay (sub-millisecond on a hot kernel cache). For 10k+ tenants on one process, prefer DB-per-tenant on Mongo or schema-per-tenant on Postgres (see [BACKEND.md — Multi-tenant patterns](./BACKEND.md#multi-tenant-patterns)) — SQLite per-tenant tops out around the open-handle ceiling.

---

## Schema sync across shards

Every shard *must* be at the same schema version at any given time, or a write that the application thinks is well-typed will fail on the shard that hasn't caught up. forge has no built-in coordinator for this — the rule lives in your deploy script.

**Run `forge push` against every shard, in parallel, gated.** The deploy step that pushes the schema iterates every shard URL, runs `forge diff --check` first to fail loud on unexpected drift, then `forge push`. If any shard fails to push, the deploy aborts before the new app code rolls out.

```sh
# deploy/push-all-shards.sh
set -euo pipefail
URLS=(
  "$DATABASE_URL_SHARD_0"
  "$DATABASE_URL_SHARD_1"
  "$DATABASE_URL_SHARD_2"
  "$DATABASE_URL_SHARD_3"
)

# Phase 1: drift-check every shard. Abort if any drifts in a surprising way.
for url in "${URLS[@]}"; do
  DATABASE_URL="$url" npx forge diff --check --ignore=/^_atlas_/i
done

# Phase 2: push to every shard in parallel.
pids=()
for url in "${URLS[@]}"; do
  DATABASE_URL="$url" npx forge push --enable-extensions &
  pids+=($!)
done
fail=0
for pid in "${pids[@]}"; do
  wait "$pid" || fail=1
done
test "$fail" -eq 0 || { echo "schema push failed on a shard — abort"; exit 1; }
```

Two rules this enforces:

* **Schema changes are additive across the deploy boundary.** When you can't tolerate a half-pushed cluster, the change has to be backwards-compatible: add columns with defaults; never drop or rename in a single deploy. Follow the blue/green pattern from [BACKEND.md — Schema versioning in production](./BACKEND.md#schema-versioning-in-production), extended to N shards instead of one.
* **Doctor every shard.** `db.$doctor()` per shard at boot, surfaced through `/readyz`, catches capability skew — a missing extension on one shard, a stale collation. See [DOCTOR.md](./DOCTOR.md) for the report shape.

For the actual migration choreography, [MIGRATIONS.md](./MIGRATIONS.md) is the source of truth; the sharded variant just runs it N times.

---

## Backup per shard

Sharding multiplies the backup surface by N. Each shard has its own backup schedule, its own retention, its own restore drill. The rules from [BACKUP-RESTORE.md](./BACKUP-RESTORE.md) apply per-shard:

* **Backup schedule.** Snapshot every shard on the same schedule, ideally at the same wall-clock minute. A cross-shard query against a partial-restore (shard 0 from 02:00, shard 1 from 02:15) will produce inconsistent results that look like data corruption.
* **Restore drill.** Do the drill against the largest shard, not the smallest. Restore time scales with shard size, not shard count; the largest is what bounds your RTO.
* **PITR per shard.** WAL archiving (Postgres) or oplog tailing (Mongo) is per-instance. A "restore to 14:32:11" across shards means each shard independently replays to the same wall-clock target — which works only if the shards have synchronised clocks (NTP discipline tighter than your minimum WAL flush interval).

For very large clusters, consider a "backup shard" — a logical replica of each shard pointed at cheap storage, kept just-behind realtime, with backups taken from it instead of the primary. Primary CPU isn't burned on the backup, and restore-from-replica is naturally idempotent.

---

## Monitoring per shard — hot-shard detection

You need to see per-shard metrics, not aggregate metrics. The aggregate hides exactly the problem you're trying to find.

**The metrics that matter, per shard:**

* **Queries-per-second.** Drive a stacked-bar chart by shard, by op. A flat skyline means even distribution; a single tall bar means the hot shard.
* **p50/p99 latency.** If one shard's p99 climbs and the others stay flat, the issue is shard-local (slow query, missing index, lock contention).
* **Write throughput.** Writes are the scarce resource — read throughput is mostly free with replicas. Per-shard write rate is the single best signal for resharding.
* **Pool wait time.** From [POOLING.md — Pool exhaustion symptoms](./POOLING.md#pool-exhaustion--symptoms-and-observability). A long wait on one shard but not others is the canonical hot-shard signal.
* **Disk usage and growth rate.** The shard that's filling up first is the shard you reshard next. Project months-to-full from the 30-day growth rate.

forge's `$on('query')` event surfaces all of this. Tag the metric with the shard id from your router:

```ts
import { db_metrics } from './metrics';

shards.forEach((db, idx) => {
  db.$on('query', (e) => {
    db_metrics.observe({
      shard: `shard-${idx}`,
      op: e.op,
      model: e.model ?? 'unknown',
      duration_ms: e.duration_ms,
      row_count: e.rowCount ?? 0,
    });
  });
  db.$on('error', (e) => {
    db_metrics.errors.inc({ shard: `shard-${idx}`, op: e.op });
  });
});
```

See [METRICS.md](./METRICS.md) for the Prometheus / OTel shape; the only sharding-specific note is the `shard` label.

**Alarms that catch hot shards early:**

* `max(write_qps) / avg(write_qps) > 2.0` sustained 10 min — distribution is skewed.
* `max(disk_usage_pct) - min(disk_usage_pct) > 25` — one shard is filling much faster.
* `max(p99_latency) > 3 × avg(p99_latency)` sustained 5 min — one shard is overloaded.

When one of those fires, your next move is usually to (a) move the biggest tenant on that shard onto a dedicated shard ("VIP" pattern), or (b) trigger the resharding drill from above. Don't wait — every week of delay makes the eventual reshard bigger.

---

## Cost model

Sharding multiplies infra cost faster than you expect. The naive math is "N shards × cost per instance", but in practice:

* **You can't run shards at the smallest instance size.** Each shard still needs its own backup capacity, its own monitoring agent, its own connection-pool headroom. The realistic floor per shard is maybe 60% of the size of the single instance it replaced.
* **Replicas multiply too.** A 1-primary-1-replica single DB becomes a 4-primary-4-replica cluster at 4 shards. Eight instances.
* **Operational overhead is `O(N)` in people-hours.** Every incident is now "which shard? all of them?" Every deploy verification is N times. Every audit is N reports to merge.

The sweet spot is the smallest N that buys real headroom — usually 4 or 8 shards, not 2 (too little headroom) and not 16 (too much ops cost). Plan for at least 2x headroom per shard so a hot tenant has somewhere to grow before you reshard. Going from 1 to 4 shards is typically a 3x infra cost increase, not 4x, because each shard is smaller; going from 4 to 8 is closer to 2x.

A reasonable budget rule: if sharding is going to more than triple your DB infra cost without doubling your write capacity, the sharding plan is wrong — usually because the shard key chose badly and you'll still have a hot shard at N=8.

The other cost nobody budgets for is **engineering time on cross-shard queries**. Every report, every admin tool, every "show me everything across the system" feature is now harder. A team that didn't expect this routinely spends 20-30% of their engineering capacity for the first two quarters rewriting features for the sharded shape. Plan for it.

---

## Worked example A — hash-sharded by user-id (4 Postgres shards)

A consumer app with a single `users` table and 200M rows that no longer fits on a single Postgres. The shard key is `user_id`. We split into 4 Postgres shards with hash routing.

**Schema (identical across all shards).**

```ts
// src/schema.ts
import { f, model } from 'forge-orm';

export const User = model('users', {
  id:         f.id(),
  email:      f.string().unique(),
  name:       f.string(),
  created_at: f.dateTime().default(() => new Date()),
}, {
  indexes: [{ keys: { email: 1 }, unique: true, name: 'idx_users_email' }],
});

export const Post = model('posts', {
  id:         f.id(),
  user_id:    f.string(),   // shard key — must match users.id on the same shard
  body:       f.text(),
  created_at: f.dateTime().default(() => new Date()),
}, {
  indexes: [{ keys: { user_id: 1, created_at: -1 }, name: 'idx_posts_user_created' }],
});

export const schema = { user: User, post: Post };
```

**Boot — N shards in parallel.**

```ts
// src/db/index.ts
import { createDb, pgDriver } from 'forge-orm';
import { Pool } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ForgeDb } from 'forge-orm';
import { schema } from '../schema';

const SHARD_URLS = [
  process.env.PG_SHARD_0!, process.env.PG_SHARD_1!,
  process.env.PG_SHARD_2!, process.env.PG_SHARD_3!,
];

export const shards: ForgeDb[] = await Promise.all(
  SHARD_URLS.map(async (url) => {
    const pool = new Pool({ connectionString: url, max: 8, idleTimeoutMillis: 30_000 });
    return createDb({ schema, driver: pgDriver(pool) });
  }),
);

// Jump-consistent hash so adding a shard moves ~1/N of keys, not (N-1)/N.
function jumpHash(key: bigint, buckets: number) {
  let b = -1n, j = 0n;
  while (j < BigInt(buckets)) {
    b = j;
    key = key * 2862933555777941757n + 1n;
    j = ((b + 1n) * (1n << 31n)) / ((key >> 33n) + 1n);
  }
  return Number(b);
}

function keyToBigInt(key: string) {
  let h = 1469598103934665603n;        // FNV-1a 64
  for (let i = 0; i < key.length; i++) {
    h ^= BigInt(key.charCodeAt(i));
    h = (h * 1099511628211n) & 0xFFFFFFFFFFFFFFFFn;
  }
  return h;
}

export function shardForUser(userId: string) {
  return shards[jumpHash(keyToBigInt(userId), shards.length)];
}

const shardStore = new AsyncLocalStorage<ForgeDb>();
export function withUser<T>(userId: string, fn: () => Promise<T>) {
  return shardStore.run(shardForUser(userId), fn);
}
export function scoped() {
  const db = shardStore.getStore();
  if (!db) throw new Error('No user scope active');
  return db;
}
```

**Handler.**

```ts
// src/server.ts
app.post('/users/:userId/posts', async (req, res) => {
  await withUser(req.params.userId, async () => {
    const post = await scoped().post.create({
      data: { user_id: req.params.userId, body: req.body.body },
    });
    res.json(post);
  });
});

app.get('/users/:userId/feed', async (req, res) => {
  await withUser(req.params.userId, async () => {
    const posts = await scoped().post.findMany({
      where:   { user_id: req.params.userId },
      orderBy: { created_at: 'desc' },
      take:    50,
    });
    res.json(posts);
  });
});
```

**Cross-shard endpoint — global trending posts.**

```ts
app.get('/trending', async (_req, res) => {
  const perShard = await Promise.all(
    shards.map((s) =>
      s.post.findMany({
        orderBy: { created_at: 'desc' },
        take:    100,
      }),
    ),
  );
  const merged = perShard.flat()
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
    .slice(0, 50);
  res.json(merged);
});
```

**Schema push.** Run `forge push` against each `PG_SHARD_*` URL in parallel; the `push-all-shards.sh` script from earlier on this page is the exact recipe.

**Resharding from 4 to 5 shards.** With jump-consistent hash, ~1/5 of keys remap on adding shard 4. The dual-write window runs against only those keys: route to old and new in parallel, backfill the moved keys, flip reads, drop the moved keys from old shards.

---

## Worked example B — Citus-managed sharding

The Citus pattern keeps a single forge `db` handle — the coordinator presents one logical Postgres — but the data is physically distributed across worker nodes.

```ts
// src/db/citus.ts
import { createDb, pgDriver } from 'forge-orm';
import { Pool } from 'pg';
import { schema } from '../schema';

const pool = new Pool({
  connectionString: process.env.CITUS_COORDINATOR_URL!,
  max: 16,
  idleTimeoutMillis: 30_000,
});

export const db = await createDb({ schema, driver: pgDriver(pool) });
```

After `forge push`, declare the distribution column once per table. This DDL is one-shot, not idempotent in the forge schema — keep it in a versioned migration script next to your schema:

```ts
// scripts/citus-distribute.ts
import { db } from '../src/db/citus';

await db.$executeRaw`SELECT create_distributed_table('posts', 'user_id', colocate_with => 'users')`;
await db.$executeRaw`SELECT create_distributed_table('users', 'id')`;
await db.$executeRaw`SELECT create_reference_table('countries')`;
```

`colocate_with` is what makes the `posts ⋈ users` join work without fan-out — both tables are sharded by the same logical key so a user's posts always live on the same worker as that user's row.

Handlers look identical to single-Postgres forge code:

```ts
app.get('/users/:userId/feed', async (req, res) => {
  const posts = await db.post.findMany({
    where:   { user_id: req.params.userId },
    orderBy: { created_at: 'desc' },
    take:    50,
  });
  res.json(posts);
});
```

Citus's coordinator routes the query to the right worker. Cross-shard queries (`COUNT(*) FROM posts`) work transparently and become parallel-scatter on the coordinator. Transactions across distribution keys use 2PC inside Citus; prefer single-key transactions.

What Citus gives you over application-layer routing: the engine handles the routing, you keep one connection, ad-hoc admin queries work. What it costs: a Citus license (or self-hosted ops), a different operational profile from vanilla Postgres, and the same shard-key choice still binds you.

---

## Worked example C — Mongo native sharding

A sharded Mongo cluster looks to the application like a single Mongo. The `mongos` router is the connection target; forge's `mongoDriver` doesn't know shards exist.

```ts
// src/db/mongo.ts
import { MongoClient } from 'mongodb';
import { createDb, mongoDriver } from 'forge-orm';
import { schema } from '../schema';

const client = new MongoClient(process.env.MONGOS_URL!, { maxPoolSize: 50 });
await client.connect();

export const db = await createDb({ schema, driver: mongoDriver(client, 'app') });
```

Shard the collection once, ahead of any traffic — `sh.shardCollection` is a cluster-level operation, not a forge concern:

```js
// Run in mongosh against the cluster.
sh.enableSharding('app');
sh.shardCollection('app.posts', { user_id: 'hashed' });
sh.shardCollection('app.users', { _id:     'hashed' });
```

After that, all writes route automatically. Queries on the shard key (`{ user_id: '...' }`) are single-shard; queries without it scatter. Mongo's `$lookup` across sharded collections has historically been a sore spot — for 5.0+ it works but is slow if both sides are sharded and not colocated. Prefer embedded subdocuments or denormalised projections for hot joins; see [MONGO.md](./MONGO.md#schema-design-for-mongo) for the embedding rules.

Transaction guidance is unchanged from a single replica set — `db.$transaction(...)` works across documents on the same shard. Cross-shard transactions in Mongo use the cluster's distributed-transaction support; they're correct but slower (several round-trips for 2PC) and rate-limited on Atlas's smaller tiers. The same advice applies: avoid them.

---

## Cross-references

* **[MULTI-TENANT.md](./MULTI-TENANT.md)** — the patterns to exhaust before sharding (schema-per-tenant, db-per-tenant, row-level). Sharding is what comes after. [BACKEND.md — Multi-tenant patterns](./BACKEND.md#multi-tenant-patterns) is the current canonical reference until MULTI-TENANT.md ships.
* **[BACKEND.md](./BACKEND.md)** — the `db` handle, `AsyncLocalStorage` for request scope, read-replica routing. Sharding extends these.
* **[POOLING.md](./POOLING.md)** — per-shard pool sizing, exhaustion symptoms, sidecar poolers in front of each shard. Applies independently per shard.
* **[MIGRATIONS.md](./MIGRATIONS.md)** — the schema-rollout discipline that has to run N times, additively, across shards.
* **[BACKUP-RESTORE.md](./BACKUP-RESTORE.md)** — backup primitives per dialect; sharded means N parallel schedules and one merged restore drill.
* **IDEMPOTENCY.md** (forthcoming) — the keying patterns for compensating writes in cross-shard sagas. Until then, the BullMQ `jobId` idiom on this page and in [BACKEND.md — Background workers](./BACKEND.md#background-workers-with-bullmq) is the working pattern.
* **[MONGO.md](./MONGO.md)** — native sharding via `sh.shardCollection`, shard-key immutability rules, `$lookup` across sharded collections.
* **[POSTGRES.md](./POSTGRES.md)** — single-Postgres extension surface; the Citus extension above lives on top of this.
* **[MYSQL.md](./MYSQL.md)** — pool and isolation behaviour shared by every Vitess shard.
* **[METRICS.md](./METRICS.md)** / **[TRACING.md](./TRACING.md)** — per-shard labels and the dashboards that surface hot-shard signals.
* **[DOCTOR.md](./DOCTOR.md)** — capability detection per shard; required at boot to catch capability skew across the cluster.

forge's role in all of this is unchanged from the single-DB case: model your schema in TypeScript, get a typed query API, push the schema with `forge push`. Sharding lives one layer above forge, in your routing function. Keep that boundary clean — every shard-aware piece of code on one side, every forge call on the other — and the rest is plain engineering discipline.
