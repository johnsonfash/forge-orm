# Multi-tenant patterns

The four shapes — shared-schema, schema-per-tenant, DB-per-tenant, sharded — their trade-offs, and how forge-orm composes with each. This page covers the implementation patterns (`scopedDb`, AsyncLocalStorage middleware, RLS, per-tenant pools) plus the operational rails (per-tenant migrations, cross-tenant analytics, onboarding/offboarding).

The companion read is [BACKEND.md](./BACKEND.md), which sketches the row-level, schema-per-tenant, and DB-per-tenant cases in 60 lines. This file is the long form: every shape with its failure modes, the wrapper code in production-shaped form, the migration orchestration that holds the whole thing together when the tenant count is large enough that "do it by hand" stops working.

## Contents

- [The four shapes](#the-four-shapes)
- [Trade-off matrix](#trade-off-matrix)
- [Shared-schema — `tenant_id` everywhere](#shared-schema--tenant_id-everywhere)
  - [The model rule](#the-model-rule)
  - [`scopedDb` — the wrapper pattern](#scopeddb--the-wrapper-pattern)
  - [AsyncLocalStorage middleware](#asynclocalstorage-middleware)
  - [Compile-time guard against missing scopes](#compile-time-guard-against-missing-scopes)
- [Row-level security (Postgres)](#row-level-security-postgres)
  - [Enabling RLS on a forge-managed table](#enabling-rls-on-a-forge-managed-table)
  - [`SET LOCAL` per transaction](#set-local-per-transaction)
  - [RLS and PgBouncer transaction mode](#rls-and-pgbouncer-transaction-mode)
- [Schema-per-tenant (Postgres `search_path`)](#schema-per-tenant-postgres-search_path)
- [DB-per-tenant](#db-per-tenant)
  - [The pool-of-pools pattern](#the-pool-of-pools-pattern)
  - [Lazy connect and idle eviction](#lazy-connect-and-idle-eviction)
  - [Mongo: one client, many databases](#mongo-one-client-many-databases)
- [Schema synchronisation across tenants](#schema-synchronisation-across-tenants)
  - [Per-tenant `forge push`](#per-tenant-forge-push)
  - [Runtime `db.$migrate()` per tenant](#runtime-dbmigrate-per-tenant)
  - [Shadow tenants for staging changes](#shadow-tenants-for-staging-changes)
- [Cross-tenant analytics and admin queries](#cross-tenant-analytics-and-admin-queries)
- [Tenant onboarding](#tenant-onboarding)
- [Tenant offboarding and deletion](#tenant-offboarding-and-deletion)
- [Sharding interaction](#sharding-interaction)
- [Auth and RBAC interaction](#auth-and-rbac-interaction)
- [Cost model — DB count vs row count](#cost-model--db-count-vs-row-count)
- [Worked examples](#worked-examples)
  - [SaaS with shared-schema + RLS](#worked-example-a--saas-with-shared-schema--rls)
  - [Regulated industry with DB-per-tenant](#worked-example-b--regulated-industry-with-db-per-tenant)
  - [Mid-size with schema-per-tenant on Postgres](#worked-example-c--mid-size-with-schema-per-tenant-on-postgres)
- [Cross-references](#cross-references)

---

## The four shapes

There is no fifth. Every multi-tenant system, from a side-project SaaS to a regulated bank, picks one of these — or a combination across modules.

1. **Shared schema, shared database.** One database. One set of tables. Every tenant-owned row carries a `tenant_id` column. Every query the application issues filters by `tenant_id`. This is the cheapest shape to run and the easiest to get wrong; a single forgotten `WHERE` clause leaks rows across tenants.

2. **Schema-per-tenant.** One database. One named schema per tenant (`tenant_acme.users`, `tenant_globex.users`). Same DDL inside each schema. Application code switches `search_path` (Postgres) or its equivalent before issuing queries. Isolation is at the schema boundary; a query that omits a tenant identifier hits whichever schema the connection is currently pointed at, not "everyone".

3. **Database-per-tenant.** One process per tenant inside the database, or one logical database inside a shared cluster. A separate connection string per tenant. Pool-of-pools on the application side. Strongest isolation short of separate hardware; the most expensive to operate because backup, migration, monitoring, and failover all multiply by the tenant count.

4. **Sharded.** Shared schema, but the dataset is partitioned across N physical databases by `hash(tenant_id) → shard_id`. Each shard hosts thousands of tenants. The application routes each query to the right shard. This is what shape 1 grows into when one box runs out of headroom; it is shape 1 plus a routing layer. See [SHARDING](./SHARDING.md) (when this file is added) and [POOLING.md](./POOLING.md#multi-tenant-pools).

The decision is rarely "which shape is best" in the abstract. It's "given my isolation requirement, my expected tenant count, and the size of the largest tenant relative to the median, which trade-off matrix entry am I willing to pay for?"

---

## Trade-off matrix

| Dimension | Shared schema | Schema-per-tenant | DB-per-tenant | Sharded |
|---|---|---|---|---|
| **Per-tenant cost** | $0 marginal | low (one schema) | high (one DB) | medium (one row of routing metadata) |
| **Strongest tenant count seen in practice** | 1M+ | ~5k before pg_catalog bloat hurts | ~hundreds (Postgres) / ~thousands (Mongo) | unbounded |
| **Cross-tenant query** | trivial (no `tenant_id` filter) | UNION ALL across schemas, expensive | impossible without ETL into a warehouse | fan-out + merge |
| **Per-tenant backup/restore** | hard (row-filter restore is custom code) | medium (`pg_dump --schema=`) | trivial (`pg_dump` the whole DB) | per-shard |
| **Blast radius of one bad query** | every tenant | one tenant if the schema switch is correct, every tenant if the wrapper leaks | one tenant | one shard's worth of tenants |
| **Blast radius of one bad migration** | every tenant simultaneously | one tenant if you migrate serially; every tenant if you migrate in parallel and the migration is destructive | one tenant per push if serial | one shard |
| **Noisy-neighbour risk** | high — one tenant's slow query starves everyone | medium — schemas share the buffer cache and the WAL writer | low — separate processes, separate buffer caches | low (within a shard, same as shared) |
| **Per-tenant data residency (GDPR EU vs US)** | impossible | impossible | trivial — separate DB per region | trivial — pin shard to region |
| **Operational complexity** | low | medium — migration orchestration | high — pool fleet, connection registry, per-tenant monitoring | very high |
| **Cost when one tenant is 100× the size of the median** | the big tenant eats the buffer cache | same as shared at the DB level | isolated — big tenant gets its own DB tier | isolated to its shard |
| **Time to onboard a new tenant** | ms (insert a row) | seconds (`CREATE SCHEMA` + DDL replay) | minutes (provision DB, migrate, warm) | seconds (insert routing row, run on existing shard) |
| **Cost when killing a tenant for GDPR** | hours of `DELETE` with sane batching | one `DROP SCHEMA CASCADE` | one `DROP DATABASE` | per-shard `DELETE` |
| **Compatibility with PgBouncer transaction mode** | full | partial — `SET search_path` doesn't survive a checkout | full | full |
| **Compatibility with serverless cold-start** | full | full | poor — first request pays a cold-connect to a per-tenant DB | full (with Hyperdrive / RDS Proxy) |

The bottom three rows are why most teams who start at shape 1 stay there longer than they planned to. Shape 1 composes cleanly with everything in the platform; shapes 2 and 3 add operational rails that don't pay rent until you have the isolation requirement that demands them.

---

## Shared-schema — `tenant_id` everywhere

### The model rule

Every table that holds tenant-owned data carries a `tenant_id` column. The column is non-null, indexed, and participates in every unique constraint that previously had only a per-tenant meaning.

```ts
import { f, model } from 'forge-orm';

const Org = model('orgs', {
  id: f.id(),
  name: f.string(),
  created_at: f.dateTime().defaultNow(),
});

const User = model('users', {
  id: f.id(),
  tenant_id: f.string(),
  email: f.string(),
  name: f.string(),
}, {
  indexes: [
    // Tenant-scoped uniqueness — two tenants can each have alice@example.com.
    { keys: { tenant_id: 1, email: 1 }, unique: true, name: 'uq_users_tenant_email' },
    // Cover the common access pattern.
    { keys: { tenant_id: 1, id: 1 }, name: 'idx_users_tenant_id' },
  ],
});

const Order = model('orders', {
  id: f.id(),
  tenant_id: f.string(),
  user_id: f.string(),
  total: f.float(),
  created_at: f.dateTime().defaultNow(),
}, {
  indexes: [
    { keys: { tenant_id: 1, created_at: -1 }, name: 'idx_orders_tenant_recent' },
    { keys: { tenant_id: 1, user_id: 1 }, name: 'idx_orders_tenant_user' },
  ],
});
```

Three rules to internalise once and never break:

1. **Every unique constraint must lead with `tenant_id`.** A unique on `email` alone makes the schema globally unique-by-email; the second tenant to onboard a user with the same email gets a conflict error. The unique key is `(tenant_id, email)`. Same applies to slugs, external IDs, idempotency keys, anything.

2. **Every index used by a hot query path must lead with `tenant_id`.** The planner can't prune to one tenant's rows if `tenant_id` is the third or fourth column. Composite `(tenant_id, created_at)` is the canonical "recent orders" index, not `(created_at)` with `tenant_id` as a filter.

3. **Foreign keys point at composite keys.** An order's `user_id` is only meaningful in the context of `(tenant_id, user_id)`. If you enforce FKs at the database level, the FK target is `(tenant_id, id)` on `users`, not `id` alone. forge does not generate composite FKs automatically — add them in raw DDL (`ALTER TABLE orders ADD CONSTRAINT fk_orders_user FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)`) or rely on the application-level invariant if you're prepared to defend it.

### `scopedDb` — the wrapper pattern

The `scopedDb` shape wraps a `db` handle in an object that auto-injects `tenant_id` into every query and mutation. The wrapper is the only thing routes are allowed to touch.

```ts
// src/db/scoped.ts
import type { ForgeDb } from 'forge-orm';
import { db } from './db';

export function scopedDb(tenantId: string) {
  if (!tenantId) throw new Error('scopedDb: tenantId required');
  return {
    user: {
      findMany: (a: any = {}) =>
        db.user.findMany({ ...a, where: { ...a.where, tenant_id: tenantId } }),
      findFirst: (a: any = {}) =>
        db.user.findFirst({ ...a, where: { ...a.where, tenant_id: tenantId } }),
      findUnique: (a: any) =>
        // findUnique by id is unsafe — id is globally unique; scope the equivalent
        // call through findFirst so we can attach tenant_id.
        db.user.findFirst({ where: { ...a.where, tenant_id: tenantId } }),
      count: (a: any = {}) =>
        db.user.count({ ...a, where: { ...a.where, tenant_id: tenantId } }),
      create: (a: any) =>
        db.user.create({ ...a, data: { ...a.data, tenant_id: tenantId } }),
      createMany: (a: any) =>
        db.user.createMany({
          ...a,
          data: (a.data as any[]).map((row) => ({ ...row, tenant_id: tenantId })),
        }),
      update: (a: any) =>
        db.user.update({
          ...a,
          where: { ...a.where, tenant_id: tenantId },
        }),
      updateMany: (a: any) =>
        db.user.updateMany({
          ...a,
          where: { ...a.where, tenant_id: tenantId },
        }),
      upsert: (a: any) =>
        db.user.upsert({
          ...a,
          where: { ...a.where, tenant_id: tenantId },
          create: { ...a.create, tenant_id: tenantId },
          update: { ...a.update },
        }),
      delete: (a: any) =>
        db.user.delete({
          ...a,
          where: { ...a.where, tenant_id: tenantId },
        }),
      deleteMany: (a: any) =>
        db.user.deleteMany({
          ...a,
          where: { ...a.where, tenant_id: tenantId },
        }),
    },
    // Repeat for every tenant-scoped model. Generate this file from the
    // schema — see "Compile-time guard" below.
  };
}

export type ScopedDb = ReturnType<typeof scopedDb>;
```

The shape mirrors the forge `db` surface but only exposes the tenant-safe verbs. It does **not** expose `$transaction`, `$executeRaw`, `$queryRaw`, or the unscoped models. Those are admin-only — see the cross-tenant analytics section.

`upsert` is the trickiest verb. The `where` clause filters by tenant. The `create` branch needs `tenant_id` injected, because forge will use the data as-is. The `update` branch does not need `tenant_id` injected (the row matched by `where` already has the right one). If you forget to inject `tenant_id` into `create`, the row inserts with whatever the user passed — possibly nothing, possibly another tenant's id.

### AsyncLocalStorage middleware

Threading `tenantId` through every function argument is the kind of code that breaks under refactor. Use `AsyncLocalStorage` to bind it once per request.

```ts
// src/db/tenant-context.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { scopedDb, type ScopedDb } from './scoped';

type Ctx = { tenantId: string; scoped: ScopedDb };
const tenantStore = new AsyncLocalStorage<Ctx>();

export function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantStore.run({ tenantId, scoped: scopedDb(tenantId) }, fn);
}

export function tenantId(): string {
  const ctx = tenantStore.getStore();
  if (!ctx) throw new Error('tenantId(): no tenant in scope. Wrap the call in withTenant().');
  return ctx.tenantId;
}

export function scoped(): ScopedDb {
  const ctx = tenantStore.getStore();
  if (!ctx) throw new Error('scoped(): no tenant in scope. Wrap the call in withTenant().');
  return ctx.scoped;
}
```

Wire it once at the request edge, after auth:

```ts
// src/server.ts
import HyperExpress from 'hyper-express';
import { withTenant } from './db/tenant-context';
import { verifyJwt } from './auth';

const app = new HyperExpress.Server();

app.use(async (req, res, next) => {
  const token = req.headers['authorization']?.replace(/^Bearer /, '');
  if (!token) return res.status(401).end();
  const claims = await verifyJwt(token);
  // Tenant id MUST come from the verified token, not from a header or a URL.
  // See the auth section below.
  await withTenant(claims.tenant_id, () => new Promise<void>((resolve, reject) => {
    res.once('finish', resolve);
    res.once('abort', () => reject(new Error('client aborted')));
    next();
  }));
});

app.get('/me', async (req, res) => {
  const { scoped, tenantId } = await import('./db/tenant-context');
  const user = await scoped().user.findFirst({ where: { id: tenantId() /* example */ } });
  res.json(user);
});
```

Compose with the request-scoped transaction store from [BACKEND.md — Production server recipes](./BACKEND.md#production-server-recipes): the outer middleware binds tenant, the inner middleware binds tx, the handler calls `scoped()` and gets a tenant-safe handle inside a transaction.

### Compile-time guard against missing scopes

The `scopedDb` wrapper above is correct by inspection but it isn't enforced. Two ways to make it harder to bypass:

1. **Generate `scopedDb` from the schema map.** Run a `forge generate scoped` codegen step (or write one in 30 lines) that iterates the `schema` argument to `createDb` and emits a wrapper for every model. Re-run on every schema change. The generator is the single source of truth for which models are tenant-scoped — flag models that lack a `tenant_id` field as "global" (e.g. the `Org` table itself) and skip them.

2. **Lint against direct `db.<model>` access in route files.** A repo-level ESLint rule that bans `db.user`, `db.order`, etc. inside `src/routes/**` and forces `scoped().user` instead. Allow it only inside `src/admin/**` and `src/jobs/**`. This is the rule that actually catches regressions — code-review can't.

The combination of `scopedDb` + ALS + lint is what keeps shape 1 honest at scale. None of the three alone is sufficient.

---

## Row-level security (Postgres)

RLS pushes the tenant filter from application code into the database. Every query Postgres sees gets an implicit `AND tenant_id = current_setting('forge.tenant_id')` added by the planner. A query that forgets the filter returns zero rows, not "every tenant's data".

### Enabling RLS on a forge-managed table

forge doesn't emit RLS policies — it doesn't model them. Apply them out-of-band, alongside the schema, in a `setup.sql` that runs after `forge push`:

```sql
-- Enable RLS on every tenant-scoped table.
ALTER TABLE users   ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders  ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

-- Policy: a session can see only rows whose tenant_id matches
-- the value set in the custom GUC forge.tenant_id.
CREATE POLICY tenant_isolation ON users
  USING (tenant_id = current_setting('forge.tenant_id', true));

CREATE POLICY tenant_isolation ON orders
  USING (tenant_id = current_setting('forge.tenant_id', true));

-- For INSERT, also require the row being inserted matches the GUC.
CREATE POLICY tenant_isolation_insert ON users
  FOR INSERT WITH CHECK (tenant_id = current_setting('forge.tenant_id', true));
```

The `true` second argument to `current_setting` returns NULL instead of erroring when the GUC is unset. That's the safe default — an unset GUC means "no tenant in scope" and the policy yields zero rows.

Critically, the application connection must **not** be `superuser` or `BYPASSRLS`. Create a separate role for app traffic:

```sql
CREATE ROLE forge_app LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO forge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO forge_app;
```

Reserve a separate `forge_admin` role with `BYPASSRLS` for the analytics and migration paths. See the cross-tenant analytics section.

### `SET LOCAL` per transaction

Before every query, the application sets the GUC for the current transaction:

```ts
await db.$transaction(async (tx) => {
  await tx.$executeRaw`SET LOCAL forge.tenant_id = ${tenantId}`;
  // Every query inside this tx is now filtered to the tenant.
  return tx.order.findMany({ where: { user_id: userId } });
});
```

`SET LOCAL` lasts until `COMMIT` / `ROLLBACK`. Without `LOCAL`, the setting leaks to the next query that reuses the connection — which under pooling means it leaks to the next tenant's request. `SET LOCAL` is mandatory; a code review that approves a bare `SET` in a pooled setup is wrong.

Wire it into the middleware so route handlers don't think about it:

```ts
app.use(async (req, res, next) => {
  const tenantId = req.tenant; // from auth middleware
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL forge.tenant_id = ${tenantId}`;
    await new Promise<void>((resolve, reject) => {
      txStore.run(tx, () => {
        res.once('finish', resolve);
        res.once('abort', reject);
        next();
      });
    });
  });
});
```

### RLS and PgBouncer transaction mode

`SET LOCAL` inside a transaction is the **only** way to use RLS through PgBouncer in transaction mode. `SET` (without `LOCAL`) sticks to the backend, and PgBouncer hands the backend to the next client mid-session — the next client sees the wrong tenant. `SET LOCAL` is scoped to the tx; PgBouncer releases the backend at `COMMIT` and the next checkout re-runs `SET LOCAL` with its own tenant id.

Disable client-side prepared statements (`prepare=false` on `pg`, `pgbouncer=true` on `postgres.js`) — they're independent of RLS but the same PgBouncer transaction-mode constraint applies, and a prepared-statement leak is a worse symptom than an RLS leak.

The trade-offs vs application-level `scopedDb`:

* **RLS pro** — the database is the boundary. A junior dev who writes `db.user.findMany()` without `tenant_id` gets zero rows; with `scopedDb` they get a NullPointerException or, worse, every tenant's rows.
* **RLS con** — every query goes through the policy evaluator. On a Postgres instance with 100+ policies and complex `USING` clauses you can see 5–10% planner overhead. Most teams don't measure this; the ones who do tend to be running on smaller instances where the overhead matters.
* **RLS con** — debugging "why does this query return zero rows?" requires checking `SHOW forge.tenant_id` inside the session. Add it to your error logging.
* **RLS pro** — a compromised app credential leaks one tenant's data, not all tenants'. The `BYPASSRLS` role is separately credentialed.

A common pattern: ship `scopedDb` first (covers the common case, easy to reason about), add RLS as defence in depth once the tenant count justifies the policy maintenance overhead.

---

## Schema-per-tenant (Postgres `search_path`)

One database. Each tenant gets a Postgres schema named after them (`tenant_acme`, `tenant_globex`). The DDL inside each schema is identical. Application queries are unqualified (`SELECT * FROM users`); Postgres resolves the name through `search_path`, which is set per session.

```ts
import { Pool } from 'pg';
import { createDb, pgDriver } from 'forge-orm';
import { schema } from './schema';

const tenantDbs = new Map<string, ForgeDb>();

export async function getTenantDb(tenantId: string) {
  let db = tenantDbs.get(tenantId);
  if (db) return db;

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,                              // small per-tenant
    idleTimeoutMillis: 60_000,
    options: `-c search_path=tenant_${tenantId},public`,
  });

  db = await createDb({ schema, driver: pgDriver(pool) });
  tenantDbs.set(tenantId, db);
  return db;
}
```

The `options` argument passes `-c search_path=…` to the Postgres startup packet — every connection in the pool boots with the right schema in scope. forge's compiled SQL is schema-unqualified, so it resolves against the tenant's schema first and falls back to `public` for shared lookup tables.

Three operational constraints to understand:

1. **PgBouncer transaction-mode breaks `search_path` startup options.** PgBouncer multiplexes startup params and doesn't reliably propagate `-c search_path=` to the backend it hands you. If you must run behind PgBouncer in transaction mode, switch to `SET LOCAL search_path = …` inside a tx — same constraint as RLS — and accept the per-tx overhead. Session-mode poolers (PgBouncer session mode, RDS Proxy in session mode) preserve the startup option.

2. **`pg_catalog` grows linearly with tenant count.** Each schema lives in the catalog. At ~5,000 schemas the catalog cache pressure starts to dominate; queries that touch `information_schema` (introspection, `forge diff`, `forge push`) get slow. Past 5k you should be on shape 3 (DB-per-tenant) or 4 (sharded).

3. **One forge `db` per tenant, cached in an LRU.** Don't create the `db` per request — `createDb` triggers schema introspection. Cache it; if you have more tenants than fit in memory, use an LRU with a tenant-eviction hook that calls `db.$disconnect()`.

```ts
import { LRUCache } from 'lru-cache';
const tenantDbCache = new LRUCache<string, ForgeDb>({
  max: 200,
  dispose: async (db) => { await db.$disconnect(); },
});
```

For shape 2, the `db` *is* the tenant scope. There's no `scopedDb` wrapper because there's no `tenant_id` column to inject. The trade-off is a `db` per tenant on the application side, paid for in memory and pool count.

---

## DB-per-tenant

One database server, many logical databases. Or one database server per tenant, for regulated environments where data physically lives on a per-tenant cluster.

### The pool-of-pools pattern

```ts
import { Pool } from 'pg';
import { createDb, pgDriver, type ForgeDb } from 'forge-orm';
import { LRUCache } from 'lru-cache';
import { schema } from './schema';

type TenantHandle = { db: ForgeDb; pool: Pool; touched: number };

const cache = new LRUCache<string, TenantHandle>({
  max: 500,
  ttl: 15 * 60_000,           // evict after 15 min idle
  dispose: async (h) => {
    await h.db.$disconnect();
    // h.pool.end() is called by db.$disconnect() via pgDriver.
  },
});

async function lookupConnectionString(tenantId: string): Promise<string> {
  // Replace with your own — a metadata DB, a config service, a KMS lookup.
  const row = await metadataDb.tenant.findFirst({ where: { id: tenantId } });
  if (!row) throw new Error(`unknown tenant: ${tenantId}`);
  return row.connection_string;
}

export async function getTenantDb(tenantId: string): Promise<ForgeDb> {
  const cached = cache.get(tenantId);
  if (cached) { cached.touched = Date.now(); return cached.db; }

  const connectionString = await lookupConnectionString(tenantId);
  const pool = new Pool({
    connectionString,
    max: 4,                    // small per tenant; multiply by tenants in-flight
    min: 0,                    // do not keep idle connections — the tenant may sleep for hours
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  const db = await createDb({ schema, driver: pgDriver(pool) });
  cache.set(tenantId, { db, pool, touched: Date.now() });
  return db;
}
```

The metadata DB (the "connection registry") is the central piece. It holds:

* `tenant_id` (PK)
* `connection_string` (or the shard id + DB name to compose one)
* `region` (for residency)
* `status` (`active`, `suspended`, `migrating`, `archived`)
* `schema_version` (last version `forge push` was run against, for fleet-wide migration tracking)
* `created_at`, `last_active_at`

The metadata DB is itself a regular forge database. Use shape 1 on it. It's small, slowly mutating, and read-heavy — perfect for shape 1 plus a long-TTL in-process cache.

### Lazy connect and idle eviction

Connecting to a per-tenant DB takes 30–80 ms (TLS handshake + Postgres startup). With 10,000 tenants you can't keep them all warm. The pattern:

* **Lazy connect.** First request for a tenant triggers `createDb`. Subsequent requests hit the LRU and skip the handshake.
* **Idle eviction.** A tenant not seen in 15 minutes is evicted from the LRU. Eviction calls `db.$disconnect()` which drains and ends the pool.
* **Pre-warm the top N.** Cron job every 5 minutes that touches the 100 most-active tenants from the metadata DB; keeps their handles warm and their pools healthy.

The eviction TTL is a budget knob, not a correctness knob. Lower TTL → fewer concurrent open pools → smaller fleet memory footprint, but more cold-connect tax on the long tail of tenants. Higher TTL → more memory, less tax.

Watch the LRU `size` as a gauge. If it's pegged at `max`, you've sized the LRU too small for your active tenant set and you're paying cold-connect on every eviction.

### Mongo: one client, many databases

MongoDB has a unique property among the dialects: a `MongoClient` is one socket pool, but the wire protocol is database-scoped. The same pool can serve queries against `tenant_acme`, `tenant_globex`, and `tenant_admin` without any per-database state.

```ts
import { MongoClient } from 'mongodb';
import { createDb, mongoDriver } from 'forge-orm';
import { schema } from './schema';

const client = new MongoClient(process.env.MONGO_URL!, {
  maxPoolSize: 50,
  minPoolSize: 2,
  maxIdleTimeMS: 60_000,
});
await client.connect();

const cache = new LRUCache<string, ForgeDb>({
  max: 5_000,
  dispose: async (db) => { await db.$disconnect(); /* doesn't close the shared client */ },
});

export async function getTenantDb(tenantId: string) {
  const cached = cache.get(tenantId);
  if (cached) return cached;
  const db = await createDb({
    schema,
    driver: mongoDriver(client, `tenant_${tenantId}`),
  });
  cache.set(tenantId, db);
  return db;
}
```

The forge `mongoDriver(client, dbName)` form is the entire story. There's no per-tenant connect cost; the same TCP connection multiplexes commands across databases. This is why Mongo is the cheapest dialect to operate shape 3 on. Cap the cache at "how many tenants you want forge metadata in memory for"; the underlying connection pool is shared.

---

## Schema synchronisation across tenants

When the schema changes — a new column, a new index — every tenant database (shape 3) or every tenant schema (shape 2) needs the change applied. Shape 1 is trivial: one `forge push`, one ledger, done.

### Per-tenant `forge push`

The simplest orchestration is a script that iterates the metadata DB:

```ts
// scripts/migrate-all-tenants.ts
import { execSync } from 'node:child_process';
import { metadataDb } from './metadata';

const tenants = await metadataDb.tenant.findMany({
  where: { status: { in: ['active', 'migrating'] } },
});

for (const t of tenants) {
  process.env.DATABASE_URL = t.connection_string;
  try {
    execSync('npx forge push --yes', { stdio: 'inherit' });
    await metadataDb.tenant.update({
      where: { id: t.id },
      data: { schema_version: process.env.SCHEMA_VERSION, migrated_at: new Date() },
    });
  } catch (err) {
    await metadataDb.tenant.update({
      where: { id: t.id },
      data: { status: 'migration_failed', migration_error: String(err) },
    });
    console.error(`tenant ${t.id} failed:`, err);
  }
}
```

Run it serially in the early days. Once tenant count is over ~50, run with a small concurrency cap (`p-limit` of 5–10) — too much parallelism and the metadata DB or the shared cluster gets DDL-thrashed. Past a few hundred tenants, run it as a job queue with retry, backoff, and per-tenant timeout.

The orchestrator records, per tenant, the version it last migrated to. A tenant whose `schema_version` is behind the deployed code version is read-only or gated until it catches up — your application middleware should check.

### Runtime `db.$migrate()` per tenant

For the browser path and for embedded SQLite-per-tenant, `db.$migrate()` (since forge 2.5.1) is the runtime equivalent of `forge push`. It introspects the live database against the schema you passed to `createDb`, emits the DDL, and applies the non-destructive items (`CREATE TABLE`, `ALTER TABLE ADD COLUMN`, `CREATE INDEX`). Destructive items surface in `report.pending` for explicit handling.

```ts
async function ensureTenantSchema(tenantId: string) {
  const db = await getTenantDb(tenantId);
  const report = await db.$migrate();
  if (report.pending.length > 0) {
    // Destructive drift — surface to ops, do not auto-apply.
    await notifySchemaDriftPending(tenantId, report);
  }
  return db;
}
```

Wire it into the lazy-connect path (shape 3) and you get JIT migration: a tenant who reconnects after a deploy gets their schema synced on first use. Pair with a cron sweep that touches every tenant weekly to catch tenants who haven't been active.

See [MIGRATIONS.md — Runtime `$migrate()` + `$diff()`](./MIGRATIONS.md#runtime-migrate--diff--when-to-use-which) for the full semantics.

### Shadow tenants for staging changes

Before a risky migration hits production tenants, run it against a **shadow tenant** — a tenant database that mirrors the production schema and a representative sample of data, but is never served live traffic. The shadow tenant is created the same way real ones are (same metadata row, status = `shadow`), seeded from a recent dump of a representative real tenant, and migrated as part of the deploy pipeline.

The migration is considered "validated" when:

1. `forge push` against the shadow runs to completion in under N seconds (your SLO).
2. `forge diff` against the shadow afterwards returns clean (no drift left).
3. The application smoke-test suite passes against the shadow's `db`.

Production migration only proceeds if the shadow run is green. This catches the "this migration locks the orders table for 90 seconds" class of bug before the lock hits a tenant who's running a Black Friday sale.

---

## Cross-tenant analytics and admin queries

The shape that makes `scopedDb` safe — "the wrapper is the only thing routes touch" — is the same shape that makes admin queries inconvenient. Analytics, support tools, and platform ops need to count rows across all tenants, look up "which tenant has user X with email Y", and run aggregate reports the application code can't.

Two patterns, one for each shape.

**Shape 1 (shared schema).** Keep the unscoped `db` handle exported, but reserved for an admin path. Lint rules forbid `db.*` outside `src/admin/**`. The admin handle uses the `forge_admin` Postgres role which has `BYPASSRLS` (if RLS is on); the application handle uses `forge_app` which doesn't.

```ts
// src/db/admin.ts — IMPORTED ONLY FROM src/admin/**
import { createDb, pgDriver } from 'forge-orm';
import { Pool } from 'pg';
import { schema } from '../schema';

const adminPool = new Pool({
  connectionString: process.env.DATABASE_URL_ADMIN!, // role: forge_admin, BYPASSRLS
  max: 4,
});

export const adminDb = await createDb({ schema, driver: pgDriver(adminPool) });

// Now admin code can do:
//   const all = await adminDb.user.findMany({ where: { email: 'leak@…' } });
// without a tenant filter, intentionally.
```

The split-role trick is the cleanest way to enforce "admin queries are explicitly admin": the application credential physically can't see across tenants because the database refuses. Application bugs become zero-row queries, not data leaks.

**Shape 2/3 (schema- or DB-per-tenant).** Cross-tenant queries can't happen in the live transactional database without a fan-out across N schemas or N databases. Don't try. Instead, ETL each tenant's data into a warehouse (BigQuery, Snowflake, ClickHouse, DuckDB on parquet — DuckDB on parquet is a forge-supported analytics path, see [DUCKDB.md](./DUCKDB.md)) with `tenant_id` injected into every row at extract time. All cross-tenant reporting hits the warehouse, not the production DBs. The application database stays single-tenant.

Operationally this means you spend extra on ETL infrastructure to buy isolation. That's the trade-off shape 2/3 was supposed to give you in the first place.

---

## Tenant onboarding

The onboarding flow has the same shape regardless of which deployment shape you're on:

1. Allocate the tenant — generate the id, write a row to the metadata DB.
2. Provision storage — for shape 1, nothing; for shape 2, `CREATE SCHEMA tenant_xxx`; for shape 3, provision a logical database or call the cluster API.
3. Run the schema — `forge push` against the new schema/DB; for shape 1, skipped.
4. Seed bootstrap data — admin user, default roles, default settings, sample data.
5. Mark the tenant `active`.
6. Run a smoke test — a synthetic request that exercises a write and a read; if it fails, mark `setup_failed` and alert.

The whole flow must be **idempotent**. If step 4 fails halfway, the re-run must complete cleanly — not double-insert seed rows. Use `upsert` for every seed write, keyed on `(tenant_id, kind, name)`:

```ts
async function seedTenant(tenantId: string) {
  const scoped = scopedDb(tenantId);
  await scoped.role.upsert({
    where: { tenant_id_name: { tenant_id: tenantId, name: 'admin' } },
    create: { tenant_id: tenantId, name: 'admin', permissions: ['*'] },
    update: {},
  });
  await scoped.role.upsert({
    where: { tenant_id_name: { tenant_id: tenantId, name: 'member' } },
    create: { tenant_id: tenantId, name: 'member', permissions: ['read'] },
    update: {},
  });
  // …
}
```

For shape 3, the provisioning step is the expensive one — cluster API calls take seconds to minutes. Front the whole onboarding flow with a job queue (BullMQ — see [BACKEND.md — Background workers](./BACKEND.md#background-workers-with-bullmq)). The HTTP call that triggers onboarding returns "pending" immediately; the user's account becomes usable when the worker marks it `active`.

---

## Tenant offboarding and deletion

Offboarding has two flavours — **suspend** and **delete**. The first is reversible (tenant pays late, comes back); the second is forced by GDPR or contract termination and is irreversible.

**Suspend.** Set `status = suspended` in the metadata DB. Application middleware short-circuits requests for suspended tenants with a 402 or 403. No data is touched. Reversible by flipping the status back.

**Soft-delete then hard-delete.** A 30-day grace period in `status = pending_deletion` during which the data is invisible to the application but recoverable. After 30 days, hard-delete runs. The 30-day window is your safety net against accidental cancellations and your compliance with GDPR's "right to be forgotten" 30-day SLA.

Hard-delete by shape:

* **Shape 1.** `DELETE FROM <table> WHERE tenant_id = $1` for every tenant-scoped table, in dependency order, in batches of 10k rows with a small commit between batches to avoid one giant tx. Mongo: `db.collection.deleteMany({ tenant_id })`. Don't bother optimising — it's a one-time job, and the cost of getting it wrong (deleting too much, deleting too little, leaving the tx open and blocking everyone else) is higher than the cost of the delete itself.

* **Shape 2.** `DROP SCHEMA tenant_xxx CASCADE`. Sub-second on Postgres regardless of data size. Followed by `DELETE FROM metadata.tenants WHERE id = $1`.

* **Shape 3.** `DROP DATABASE tenant_xxx` (or call the cluster API to delete the logical database). Followed by metadata cleanup and pool eviction from the LRU.

**Export then delete.** GDPR Article 20 (data portability) often comes paired with Article 17 (right to erasure). The compliant flow is:

1. Generate an export — JSON or CSV of every table belonging to the tenant. forge's `db.<model>.findMany({ where: { tenant_id } })` is the building block; pipe it through `JSON.stringify` per row to a file or to S3.
2. Deliver the export to the tenant (signed URL, email link).
3. Wait for acknowledgement, or wait out the grace period.
4. Hard-delete.

Record the export and the deletion in an audit log — see [AUDIT-LOG.md](./AUDIT-LOG.md). The auditor wants the evidence; "we deleted them" without a record doesn't pass.

---

## Sharding interaction

Shape 1 grows into shape 4 (sharded). The mechanics:

1. A **shard map** — `tenant_id → shard_id` — replaces the single connection string with a routing table. Tiny (one row per tenant), heavily cached, rarely mutated.
2. Each shard is an independent Postgres / MySQL / Mongo instance running shape 1 over a subset of tenants.
3. The application's `scopedDb(tenantId)` wrapper first looks up the shard, then routes to the per-shard `db` handle.

```ts
const shardDbs = new Map<number, ForgeDb>(); // shard_id → db

async function scopedDb(tenantId: string) {
  const shardId = await shardMap.lookup(tenantId);   // cached
  let db = shardDbs.get(shardId);
  if (!db) {
    const url = shardConfig[shardId].url;
    db = await createDb({ schema, driver: pgDriver(new Pool({ connectionString: url })) });
    shardDbs.set(shardId, db);
  }
  return wrap(db, tenantId); // same scopedDb wrapper from above
}
```

Shape 4 inherits shape 1's invariants — every table has `tenant_id`, every unique constraint leads with it. The shard map adds:

* **No cross-shard transactions.** A tx scoped to one shard is fine; a tx spanning two is two-phase commit, which forge doesn't model and most teams don't run in practice. Design tenant-scoped writes so they live entirely on the tenant's shard.
* **Rebalancing.** A shard fills up; move tenants to a new shard. Online tenant migration is its own discipline — copy + dual-write + cutover + delete. See `SHARDING.md` (forthcoming) for the long version.
* **Per-shard migrations.** Same fleet orchestration as shape 3, but parallelised by shard rather than by tenant.

Don't shard preemptively. Shape 1 on a single Postgres instance is good for low-hundreds-of-millions of rows; for many SaaS workloads, that's "forever". Shard when one of: (a) your largest single tenant exceeds what one box can hold, (b) cross-region residency requires it, (c) the buffer cache pressure between tenants is killing the p99.

---

## Auth and RBAC interaction

The `tenant_id` value used by `scopedDb` and the RLS `SET LOCAL` clause **must come from a verified token**, never from a request header or URL parameter.

* The login flow issues a JWT (or session token) signed by the auth service. The token's claims include `sub` (user id) and `tenant_id` (the tenant the user belongs to, or the tenant they're currently acting on for users who belong to multiple).
* The HTTP middleware verifies the token signature and extracts the claims. Only after verification does it call `withTenant(claims.tenant_id, …)`.
* Routes never read `req.query.tenant_id`, `req.headers['x-tenant-id']`, or anything from the URL path that could be tampered with. The URL might *contain* a tenant id (e.g. `/orgs/:orgId/users`), but the request is rejected unless that id matches `claims.tenant_id` — never the other way around.

RBAC and tenant isolation are independent axes. RBAC restricts *what* a user can do within their tenant (read vs write, billing vs ops). Tenant isolation restricts *which rows* exist for that user at all. A user who is admin within their tenant still cannot see another tenant's rows; the `scopedDb` wrapper or the RLS policy enforces that before RBAC even runs.

For users who belong to multiple tenants (typical of agency / consultant accounts), the JWT contains a list of tenant ids and an "active" one. Switching the active tenant is a re-issue of the JWT, not a header change. Never let the client claim "I'm acting on behalf of tenant X" without the auth service backing it.

---

## Cost model — DB count vs row count

The cost dimensions to track:

| Cost | Shape 1 | Shape 2 | Shape 3 | Shape 4 |
|---|---|---|---|---|
| **Storage** | row count × bytes | row count × bytes + ~10MB per schema | row count × bytes + per-DB overhead | row count × bytes + per-shard overhead |
| **Compute (per query)** | shared buffer cache | shared buffer cache | per-tenant buffer cache | per-shard buffer cache |
| **Connections** | one pool | one pool, complex `search_path` | one pool per active tenant | one pool per shard |
| **Backup** | one DB | one DB, slow logical dumps | N DBs | N shards |
| **Monitoring** | one set of dashboards | one set | N sets (or one with tenant_id dimension) | N sets |
| **Migration runtime** | seconds | minutes (sequential schemas) | hours (sequential DBs) | per-shard parallelism |

The crossover from shape 1 to shape 3 isn't really about row count — it's about *concentration*. If your top 10 tenants account for 90% of your rows and your QPS, shape 1 forces them to share a buffer cache with each other. Shape 3 lets each big tenant get its own instance tier. The threshold isn't a row count; it's "the top tenant's working set exceeds 30% of the box's memory and we're seeing buffer-cache evictions".

Conversely, if your tenants are uniform (every tenant is roughly the same size, no one is 100× the median), shape 1 stays cost-optimal well past a million tenants. Slack famously ran shape 1 for years on a sharded MySQL.

---

## Worked examples

### Worked example A — SaaS with shared-schema + RLS

A B2B project-management tool. Tens of thousands of small-team tenants, one large enterprise customer at ~5% of total volume. Postgres on RDS, hyper-express on Fargate, PgBouncer in transaction mode.

```ts
// src/db.ts
import { createDb, pgDriver } from 'forge-orm';
import { Pool } from 'pg';
import { schema } from './schema';

const appPool = new Pool({
  connectionString: process.env.DATABASE_URL_APP,     // role: forge_app, NOBYPASSRLS
  max: 16,
  statement_timeout: 10_000,
});
const adminPool = new Pool({
  connectionString: process.env.DATABASE_URL_ADMIN,   // role: forge_admin, BYPASSRLS
  max: 2,
});

export const db = await createDb({ schema, driver: pgDriver(appPool) });
export const adminDb = await createDb({ schema, driver: pgDriver(adminPool) });
```

```sql
-- ddl/rls.sql, applied after `forge push`.
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE users    ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_iso ON projects
  USING (tenant_id = current_setting('forge.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('forge.tenant_id', true));

-- Repeat for tasks, users, comments, attachments…
```

```ts
// src/server.ts
import HyperExpress from 'hyper-express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { db } from './db';
import { verifyJwt } from './auth';

const txStore = new AsyncLocalStorage<typeof db>();
const scoped = () => txStore.getStore() ?? db;
const app = new HyperExpress.Server();

app.use(async (req, res, next) => {
  const token = req.headers['authorization']?.replace(/^Bearer /, '');
  const claims = token ? await verifyJwt(token) : null;
  if (!claims) return res.status(401).end();

  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL forge.tenant_id = ${claims.tenant_id}`;
    await new Promise<void>((resolve, reject) => {
      txStore.run(tx, () => {
        res.once('finish', resolve);
        res.once('abort', reject);
        next();
      });
    });
  });
});

app.get('/projects', async (req, res) => {
  // No tenant filter here. RLS injects it. If `forge.tenant_id` were unset
  // the policy would return zero rows; in this code path it's set above.
  res.json(await scoped().project.findMany());
});

app.listen(3000);
```

Properties:

* The application credential physically cannot see across tenants. A SQL injection that bypasses the ORM filter still hits RLS.
* Admin queries use `adminDb` from `src/admin/**`. Lint forbids `adminDb` outside that path.
* Migrations are one `forge push` against a single DB. Per-tenant orchestration is N/A.
* The big enterprise customer shares the cluster but is the largest workload; if their query patterns start dominating the buffer cache, the migration path to shape 3 is to provision them a dedicated cluster and add a per-tenant-routing layer that sends their requests to a different `db` handle. The schema travels unchanged.

### Worked example B — Regulated industry with DB-per-tenant

A clinical-records platform serving hospitals. HIPAA + national health regulations require that one hospital's data cannot share an instance with another's. Postgres on dedicated tier per tenant, encrypted at rest with a per-tenant KMS key.

```ts
// src/db/tenant-registry.ts
import { createDb, pgDriver, type ForgeDb } from 'forge-orm';
import { Pool } from 'pg';
import { LRUCache } from 'lru-cache';
import { decryptConnectionString } from './kms';
import { metadataDb } from './metadata';
import { schema } from '../schema';

type Handle = { db: ForgeDb; pool: Pool };

const cache = new LRUCache<string, Handle>({
  max: 200,
  ttl: 10 * 60_000,
  dispose: async (h) => { await h.db.$disconnect(); },
});

export async function getTenantDb(tenantId: string): Promise<ForgeDb> {
  const hit = cache.get(tenantId);
  if (hit) return hit.db;

  const row = await metadataDb.tenant.findFirst({
    where: { id: tenantId, status: 'active' },
  });
  if (!row) throw new TenantNotFoundError(tenantId);

  const url = await decryptConnectionString(row.connection_string_encrypted, row.kms_key_id);
  const pool = new Pool({
    connectionString: url,
    max: 4,
    min: 0,
    idleTimeoutMillis: 30_000,
    ssl: { rejectUnauthorized: true },
  });
  const db = await createDb({ schema, driver: pgDriver(pool) });
  cache.set(tenantId, { db, pool });
  return db;
}

// Pre-warm the top tenants every 5 minutes.
setInterval(async () => {
  const top = await metadataDb.tenant.findMany({
    where: { status: 'active' },
    orderBy: { last_active_at: 'desc' },
    take: 50,
  });
  for (const t of top) await getTenantDb(t.id).catch(() => {});
}, 5 * 60_000);
```

```ts
// scripts/migrate-fleet.ts
import pLimit from 'p-limit';
import { execSync } from 'node:child_process';
import { metadataDb } from '../src/db/metadata';
import { decryptConnectionString } from '../src/db/kms';

const limit = pLimit(8);
const tenants = await metadataDb.tenant.findMany({ where: { status: 'active' } });

await Promise.all(tenants.map((t) => limit(async () => {
  const url = await decryptConnectionString(t.connection_string_encrypted, t.kms_key_id);
  try {
    execSync('npx forge push --yes', {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'inherit',
      timeout: 5 * 60_000,
    });
    await metadataDb.tenant.update({
      where: { id: t.id },
      data: { schema_version: process.env.GIT_SHA, migrated_at: new Date() },
    });
  } catch (err) {
    await metadataDb.tenant.update({
      where: { id: t.id },
      data: { status: 'migration_failed', migration_error: String(err) },
    });
  }
})));
```

Properties:

* Each tenant's data lives on its own database. A breach of one tenant's app credential leaks one tenant, not many.
* Connection strings are encrypted in the metadata DB and decrypted at request time via a per-tenant KMS key. The platform operator can revoke a tenant's key to render their data inaccessible without touching the data itself.
* Migrations run against the fleet via the orchestration script. The schema version each tenant is on is tracked in the metadata DB; gated rollouts (1%, 10%, 100%) are a `WHERE status = 'canary'` filter on the script.
* Cross-tenant analytics is done by ETL into a HIPAA-compliant warehouse, never against the live tenant databases.

### Worked example C — Mid-size with schema-per-tenant on Postgres

A vertical SaaS for accounting firms. ~500 tenants, growing slowly. Each tenant gets a Postgres schema in a shared cluster. Session-mode PgBouncer (not transaction mode) because `search_path` is the routing mechanism.

```ts
// src/db/tenant.ts
import { createDb, pgDriver, type ForgeDb } from 'forge-orm';
import { Pool } from 'pg';
import { LRUCache } from 'lru-cache';
import { schema } from '../schema';

const cache = new LRUCache<string, ForgeDb>({
  max: 500,                             // == tenant count, fits in memory
  dispose: async (db) => { await db.$disconnect(); },
});

export async function getTenantDb(tenantId: string) {
  const hit = cache.get(tenantId);
  if (hit) return hit;

  const schemaName = `tenant_${tenantId.replace(/-/g, '_')}`;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    idleTimeoutMillis: 60_000,
    options: `-c search_path=${schemaName},public`,
  });
  const db = await createDb({ schema, driver: pgDriver(pool) });
  cache.set(tenantId, db);
  return db;
}
```

Onboarding creates the schema before forge runs:

```ts
import { Client } from 'pg';

export async function provisionTenant(tenantId: string) {
  const admin = new Client({ connectionString: process.env.DATABASE_URL_ADMIN });
  await admin.connect();
  try {
    const schemaName = `tenant_${tenantId.replace(/-/g, '_')}`;
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schemaName} TO forge_app`);
    await admin.query(`GRANT ALL ON SCHEMA ${schemaName} TO forge_app`);
  } finally {
    await admin.end();
  }

  // Now point forge at the new schema and push.
  const tenantUrl = `${process.env.DATABASE_URL}?options=-csearch_path=tenant_${tenantId.replace(/-/g, '_')},public`;
  execSync('npx forge push --yes', { env: { ...process.env, DATABASE_URL: tenantUrl } });

  await metadataDb.tenant.create({ data: { id: tenantId, status: 'active' } });
}
```

Properties:

* One Postgres cluster to operate, monitor, and back up.
* Hard isolation between tenants at the schema boundary; no `tenant_id` columns.
* `pg_dump --schema=tenant_xxx` is the one-line per-tenant backup.
* Per-tenant migration is `forge push` with `search_path` set; the orchestration script iterates the metadata DB.
* Capped at ~5,000 tenants before catalog pressure becomes painful. Past that, the migration path is to split tenants across multiple clusters (shape 2 + shape 4).

---

## Cross-references

* [BACKEND.md — Multi-tenant patterns](./BACKEND.md#multi-tenant-patterns) — the 60-line summary this file expands on.
* [BACKEND.md — Transactions in HTTP and job contexts](./BACKEND.md#transactions-in-http-and-job-contexts) — the request-scoped tx middleware that composes with the tenant middleware here.
* [POOLING.md — Multi-tenant pools](./POOLING.md#multi-tenant-pools) — pool sizing for the pool-of-pools pattern.
* [POOLING.md — Transaction-mode vs session-mode poolers](./POOLING.md#transaction-mode-vs-session-mode-poolers--what-breaks) — why RLS and `SET LOCAL` work, and `SET search_path` doesn't, behind PgBouncer transaction mode.
* [MIGRATIONS.md](./MIGRATIONS.md) — the `forge push` / `forge diff` / `forge rollback` semantics that the fleet orchestrator wraps.
* [MIGRATIONS.md — Runtime `$migrate()` + `$diff()`](./MIGRATIONS.md#runtime-migrate--diff--when-to-use-which) — the per-tenant lazy migration path.
* [AUDIT-LOG.md](./AUDIT-LOG.md) — the audit trail required for GDPR exports and deletions.
* [DUCKDB.md](./DUCKDB.md) — using DuckDB on parquet for cross-tenant analytics offloaded from the live databases.
* [POSTGRES.md](./POSTGRES.md) — adapter-specific notes, including the `options` startup parameter for `search_path`.
* [MONGO.md](./MONGO.md) — `mongoDriver(client, dbName)` and the shared-client / many-databases pattern.
* `SHARDING.md` (forthcoming) — the shape-4 routing layer and online tenant rebalancing.
* `SECURITY.md` (forthcoming) — credential hygiene, role separation, KMS for connection strings, and the threat model that justifies shape 3.
* `AUTH.md` (forthcoming) — JWT claims, tenant id verification, and the rule that `tenant_id` always comes from a verified token.
