# Backend integration

This doc is a companion to the main [README](../README.md). It assumes you have
read [Connecting](../README.md#connecting), [Transactions](../README.md#transactions),
and [Watching queries](../README.md#watching-queries), and goes deeper on the
patterns you need once forge is running behind an HTTP server, a queue worker,
or a multi-tenant deployment: framework wiring, pool sizing, request-scoped
transactions, background jobs, tenant isolation, replica routing,
observability, health probes, dev-loop ergonomics, and schema rollouts.

forge does not ship a framework integration package. None is needed — a forge
`db` handle is a long-lived object you create once at boot, share across
request handlers, and dispose at shutdown. Every recipe below is a small
amount of glue around that shape.

---

## Contents

- [Production server recipes](#production-server-recipes)
  - [hyper-express](#hyper-express)
  - [Fastify](#fastify)
  - [NestJS](#nestjs)
  - [Bun + Hono](#bun--hono)
- [Connection pooling and lifecycle](#connection-pooling-and-lifecycle)
- [Transactions in HTTP and job contexts](#transactions-in-http-and-job-contexts)
- [Background workers with BullMQ](#background-workers-with-bullmq)
- [Multi-tenant patterns](#multi-tenant-patterns)
- [Read replicas and split routing](#read-replicas-and-split-routing)
- [Observability](#observability)
- [Health checks and readiness probes](#health-checks-and-readiness-probes)
- [Hot reload and dev ergonomics](#hot-reload-and-dev-ergonomics)
- [Schema versioning in production](#schema-versioning-in-production)

---

## Production server recipes

The shape is the same in every framework. You build one `db` at boot, attach it
to the request context, run handlers, and call `db.$disconnect()` on shutdown.
Request-scoped transactions ride on `AsyncLocalStorage` so route handlers can
opt into a tx without threading a parameter through every call.

### hyper-express

`hyper-express` runs on `uWebSockets.js`. Per-request setup overhead is more
visible than on stock Node HTTP, so build `db` once at the module level and
share it via export.

```ts
// src/db.ts
import { createDb, f, model } from 'forge-orm';
import { AsyncLocalStorage } from 'node:async_hooks';

const User = model('users', { id: f.id(), email: f.string().unique(), name: f.string() });

export const db = await createDb({ url: process.env.DATABASE_URL!, schema: { user: User } });
export const txStore = new AsyncLocalStorage<typeof db>();
export const scoped = () => txStore.getStore() ?? db;
```

```ts
// src/server.ts
import HyperExpress from 'hyper-express';
import { db, txStore, scoped } from './db';

const app = new HyperExpress.Server();

// Wrap every mutating route in a tx automatically.
app.use(async (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  await db.$transaction(async (tx) => {
    await new Promise<void>((resolve, reject) => {
      txStore.run(tx, () => {
        res.once('finish', resolve);
        res.once('abort', () => reject(new Error('client aborted')));
        next();
      });
    });
  });
});

app.post('/users', async (req, res) => {
  const body = await req.json();
  const user = await scoped().user.create({ data: body });
  res.json(user);
});

await app.listen(Number(process.env.PORT ?? 3000));

// Graceful shutdown — drain in-flight, then disconnect.
const stop = async () => {
  await app.close();
  await db.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
```

The `scoped()` indirection is the price you pay for not threading `tx` through
every function signature. It costs one `AsyncLocalStorage.getStore()` lookup
per call — cheaper than a Map lookup, and Node optimises it heavily.

### Fastify

Use `fastify-plugin` to expose `db` on the root instance; let Fastify's
`onClose` hook own the disconnect.

```ts
// src/plugins/db.ts
import fp from 'fastify-plugin';
import { createDb } from 'forge-orm';
import { AsyncLocalStorage } from 'node:async_hooks';
import { schema } from '../schema';

export default fp(async (app) => {
  const db = await createDb({ url: process.env.DATABASE_URL!, schema });
  const txStore = new AsyncLocalStorage<typeof db>();
  app.decorate('db', db);
  app.decorate('scoped', () => txStore.getStore() ?? db);

  app.addHook('preHandler', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    await new Promise<void>((resolve, reject) => {
      db.$transaction(async (tx) =>
        new Promise<void>((commit) => {
          txStore.run(tx, () => { req.raw.once('close', commit); resolve(); });
        }),
      ).catch(reject);
    });
  });

  app.addHook('onClose', async () => { await db.$disconnect(); });
});

// src/server.ts
const app = Fastify({ logger: true });
await app.register(dbPlugin);
app.post('/orders', async (req) => app.scoped().order.create({ data: req.body }));
await app.listen({ port: 3000, host: '0.0.0.0' });
```

Validation runs in Fastify's `preValidation` hook — opening the tx in
`preHandler` means a 4xx response never reaches the database.

### NestJS

Wrap forge in a global module so DI stays idiomatic. A repository injects
both the root `db` and the per-request `AsyncLocalStorage`.

```ts
// src/db/db.module.ts
import { Module, Global } from '@nestjs/common';
import { createDb } from 'forge-orm';
import { AsyncLocalStorage } from 'node:async_hooks';
import { schema } from '../schema';

export const DB = Symbol('FORGE_DB');
export const TX_STORE = Symbol('FORGE_TX_STORE');

@Global()
@Module({
  providers: [
    { provide: DB, useFactory: () => createDb({ url: process.env.DATABASE_URL!, schema }) },
    { provide: TX_STORE, useValue: new AsyncLocalStorage() },
  ],
  exports: [DB, TX_STORE],
})
export class DbModule {}

// src/users/users.repository.ts
@Injectable()
export class UsersRepository {
  constructor(@Inject(DB) private db: any, @Inject(TX_STORE) private txs: AsyncLocalStorage<any>) {}
  private scoped() { return this.txs.getStore() ?? this.db; }
  findByEmail(email: string)            { return this.scoped().user.findFirst({ where: { email } }); }
  create(data: { email: string; name: string }) { return this.scoped().user.create({ data }); }
}

// src/db/tx.interceptor.ts
@Injectable()
export class TxInterceptor implements NestInterceptor {
  constructor(@Inject(DB) private db: any, @Inject(TX_STORE) private txs: any) {}
  intercept(ctx: ExecutionContext, next: CallHandler) {
    const req = ctx.switchToHttp().getRequest();
    if (req.method === 'GET' || req.method === 'HEAD') return next.handle();
    return from(this.db.$transaction((tx: any) =>
      new Promise((resolve, reject) =>
        this.txs.run(tx, () => next.handle().subscribe({ next: resolve, error: reject })),
      ),
    ));
  }
}
```

Bind the interceptor globally in `main.ts` and call `app.enableShutdownHooks()`
so Nest's `onModuleDestroy` runs `db.$disconnect()`.

### Bun + Hono

Keep `db` strictly module-level — Bun spawns workers cheaply and per-worker
pools add up fast. On Bun, prefer `postgres.js` to `pg`; the former runs on
Bun's native sockets without a polyfill layer.

```ts
import { Hono } from 'hono';
import { createDb, postgresJsDriver } from 'forge-orm';
import postgres from 'postgres';
import { AsyncLocalStorage } from 'node:async_hooks';
import { schema } from './schema';

const sql = postgres(process.env.DATABASE_URL!, { max: 10, idle_timeout: 20 });
const db = await createDb({ schema, driver: postgresJsDriver(sql) });
const txStore = new AsyncLocalStorage<typeof db>();
const scoped = () => txStore.getStore() ?? db;

const app = new Hono();
app.use('*', async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
  await db.$transaction(async (tx) =>
    new Promise<void>((resolve, reject) =>
      txStore.run(tx, () => next().then(() => resolve(), reject)),
    ),
  );
});

app.post('/items', async (c) => c.json(await scoped().item.create({ data: await c.req.json() })));

const server = Bun.serve({ port: 3000, fetch: app.fetch });
process.on('SIGTERM', async () => { await server.stop(); await db.$disconnect(); process.exit(0); });
```

`postgres.js` has stricter idle-timeout semantics than `pg`; values under 10
seconds will churn connections on a quiet endpoint.

---

## Connection pooling and lifecycle

The defaults shipped by each driver are tuned for development. In production
you size pools against the cores serving your API, not the rows you store.

**Postgres (`pg.Pool`).** Library default is 10. Aim for `vCPUs × 2` per
process; 4 replicas × 8 connections = 32 per role, well under the 100-conn
ceiling on managed PG. Past ~80 you pay kernel context-switching tax for no
gain. Always set both `max` and `idleTimeoutMillis`.

```ts
import { Pool } from 'pg';
import { createDb, pgDriver } from 'forge-orm';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8, min: 0,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,    // hard brake on runaway queries
});
const db = await createDb({ schema, driver: pgDriver(pool) });
```

Over the host's `max_connections`, put **PgBouncer in transaction mode** in
front. forge uses no session-bound features by default (no advisory locks,
no `LISTEN/NOTIFY` on the data connection, no `SET LOCAL` outside a tx) so
transaction pooling is safe. Disable client-side prepares
(`?prepare=false`, or `pgbouncer=true` on `postgres.js`) — they're
incompatible with transaction pooling.

**MySQL (`mysql2`).** Defaults: `connectionLimit: 10`, `queueLimit: 0`
(unbounded). Cap the queue so backpressure becomes a 503 instead of a memory
leak: `connectionLimit: 8, queueLimit: 50, enableKeepAlive: true,
keepAliveInitialDelay: 30_000, idleTimeout: 60_000`.

**MongoDB.** `maxPoolSize` defaults to 100 — too high for most APIs. Size to
concurrency target + small headroom; pair with `minPoolSize: 2` and
`maxIdleTimeMS: 60_000`. Atlas measures connection count against the cluster
tier (M0 caps at 500 cluster-wide).

**MSSQL.** Tedious's pool defaults to `min: 0, max: 10`. Set
`requestTimeout` — the 15s driver default silently truncates long reports.

**SQLite.** No pool. `better-sqlite3` is synchronous and serializes writes on
a single file lock. `PRAGMA journal_mode = WAL` at connect time is the only
setting that materially affects throughput.

The lifecycle rule across all dialects: open the pool **before** you start
accepting requests, and close it **after** the HTTP server has drained.
`db.$disconnect()` defers to the underlying pool's `end()` / `close()`.

---

## Transactions in HTTP and job contexts

The recipes above already wire a request-scoped tx. Two patterns matter beyond
the wiring.

**Savepoints for partial rollback.** A tx callback can `try/catch` inside, but
on Postgres any error inside the outer tx poisons the rest of the transaction
unless you wrap the risky step in a savepoint. forge does not surface
savepoint API directly; drop to raw SQL.

```ts
await db.$transaction(async (tx) => {
  await tx.order.create({ data: order });
  try {
    await tx.$executeRaw`SAVEPOINT before_audit`;
    await tx.audit.create({ data: { kind: 'order.created', orderId: order.id } });
    await tx.$executeRaw`RELEASE SAVEPOINT before_audit`;
  } catch (err) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT before_audit`;
    // Order survives; audit is dropped.
  }
});
```

DuckDB doesn't implement `SAVEPOINT`; the nested step degrades to a single
outer tx and any error aborts the whole thing. SQLite supports savepoints but
the WAL writer is single-threaded so they don't buy concurrency.

**Deadlock retry loop.** Postgres serialization failures raise `40001`
(`could not serialize access`) and `40P01` (deadlock). MySQL raises error
`1213` and `1205` (lock wait timeout). Wrap the tx in a small retry with
jittered backoff. forge surfaces these as `DbKnownError` only for unique /
FK conflicts — for SQLSTATE 40xxx, branch on the driver's error code.

```ts
async function withRetry<T>(fn: () => Promise<T>, max = 3): Promise<T> {
  let attempt = 0;
  while (true) {
    try { return await fn(); }
    catch (e: any) {
      const code = e?.code ?? e?.sqlState ?? e?.errno;
      const retryable =
        code === '40001' || code === '40P01' ||      // PG
        code === 1213    || code === 1205;           // MySQL
      if (!retryable || ++attempt >= max) throw e;
      await new Promise(r => setTimeout(r, 25 * 2 ** attempt + Math.random() * 25));
    }
  }
}

await withRetry(() =>
  db.$transaction(async (tx) => {
    const acct = await tx.account.findFirstOrThrow({ where: { id } });
    await tx.account.update({ where: { id }, data: { balance: acct.balance - 100 } });
  }),
);
```

**Isolation level.** forge's `$transaction` runs at the dialect default (PG
`READ COMMITTED`, MySQL `REPEATABLE READ`, MSSQL `READ COMMITTED`). Raise it
per-tx by issuing the SQL at the top of the callback:

```ts
await db.$transaction(async (tx) => {
  await tx.$executeRaw`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`;
  // …writes that need full serializability…
});
```

On MySQL the equivalent is `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`
issued **before** the implicit `BEGIN`; the `$transaction` callback runs
inside `BEGIN`, so use `SET TRANSACTION ISOLATION LEVEL` (without `SESSION`)
and accept that it only affects the next statement. For repeatable correctness
across statements, raise it at the session level via the pool's `init` hook.

---

## Background workers with BullMQ

Queue producers and consumers share the schema but never the connection pool
sizing. The HTTP API and the worker should each instantiate their own forge
`db` against the same database URL, with pool sizes tuned to their workload.

**Producer (HTTP route).**

```ts
import { Queue } from 'bullmq';
import { db, scoped } from './db';

const queue = new Queue('emails', { connection: { url: process.env.REDIS_URL } });

app.post('/orders', async (req, res) => {
  const order = await scoped().order.create({ data: req.body });
  // Idempotency key = the order id; if the route is retried, BullMQ dedupes.
  await queue.add('send-receipt', { orderId: order.id }, { jobId: `receipt:${order.id}` });
  res.json(order);
});
```

**Consumer (separate process).** The worker owns its own `db`. Pool size 4-8
is plenty for most send/process jobs; bigger only if individual jobs fan out
into many queries.

```ts
// worker.ts
import { Worker } from 'bullmq';
import { createDb } from 'forge-orm';
import { schema } from './schema';

const db = await createDb({ url: process.env.DATABASE_URL!, schema });

const worker = new Worker('emails', async (job) => {
  const order = await db.order.findFirstOrThrow({ where: { id: job.data.orderId } });
  if (order.receipt_sent_at) return;            // idempotency — soft check
  await sendReceipt(order);
  await db.order.update({
    where: { id: order.id },
    data: { receipt_sent_at: new Date() },
  });
}, {
  connection: { url: process.env.REDIS_URL },
  concurrency: 8,
});

worker.on('failed', (job, err) => {
  console.error('job failed', job?.id, err.message);
});

process.on('SIGTERM', async () => {
  await worker.close();
  await db.$disconnect();
  process.exit(0);
});
```

For repeating jobs that touch the DB, treat the schedule as the source of
truth — never store "next run" in the DB and use it as a lock. BullMQ's
`upsertJobScheduler` is idempotent; combine it with `forge`'s atomic upsert
if you need to backfill a row from the schedule:

```ts
await queue.upsertJobScheduler('nightly-rollup', { pattern: '0 3 * * *' }, { name: 'rollup' });
```

The worker handler can then `db.report.upsert({ where: { day }, create: …, update: … })`
without coordinating with the queue.

---

## Multi-tenant patterns

Three deployment shapes, picked by blast radius and noisy-neighbour risk.

**Schema-per-tenant (Postgres).** One database, one schema per tenant. Strong
isolation; works with row-level security policies if you need them. Cost: one
forge `db` per schema, or a connection pool that resets `search_path` per
checkout. The latter is hostile to PgBouncer transaction mode; prefer one
forge instance per tenant, cached in an LRU.

```ts
const tenantDbs = new Map<string, ForgeDb>();
async function getTenantDb(tenantId: string) {
  let db = tenantDbs.get(tenantId);
  if (db) return db;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    options: `-c search_path=${tenantId},public`,
  });
  db = await createDb({ schema, driver: pgDriver(pool) });
  tenantDbs.set(tenantId, db);
  return db;
}
```

**Database-per-tenant (Mongo).** A `MongoClient` is one socket pool; pass a
different db name per tenant via `mongoDriver(client, name)`. This is the
cheapest isolation model on Mongo because the wire protocol is db-scoped.

```ts
import { MongoClient } from 'mongodb';
import { createDb, mongoDriver } from 'forge-orm';

const client = new MongoClient(process.env.MONGO_URL!, { maxPoolSize: 50 });
await client.connect();

async function tenantDb(tenantId: string) {
  return createDb({ schema, driver: mongoDriver(client, `tenant_${tenantId}`) });
}
```

**Row-level (`tenant_id` scope).** Cheapest operationally — one schema, every
table carries `tenant_id`, every query filters on it. Centralise the scope
through a small wrapper and combine with `strict: true` to surface typos.

```ts
const Order = model('orders', {
  id: f.id(), tenant_id: f.string(), total: f.float(),
}, {
  indexes: [{ keys: { tenant_id: 1, id: 1 }, unique: true, name: 'idx_orders_tenant' }],
});

function forTenant(db: ForgeDb, tenantId: string) {
  return {
    order: {
      findMany: (a: any = {}) => db.order.findMany({ ...a, where: { ...a.where, tenant_id: tenantId } }),
      create:   (a: any)       => db.order.create({   ...a, data:  { ...a.data,  tenant_id: tenantId } }),
    },
  };
}
```

Row-level fails open if a query bypasses the wrapper. Combine with Postgres
RLS (or Mongo's `$jsonSchema` validator) when the blast radius of one missing
filter is unacceptable.

---

## Read replicas and split routing

forge does not split reads and writes for you. Build it as two `db` instances
backed by different URLs and a tiny router function. Treat the router as the
public surface; never call the underlying handles directly.

```ts
import { createDb } from 'forge-orm';
import { schema } from './schema';

const primary = await createDb({ url: process.env.DATABASE_URL!,         schema });
const replica = await createDb({ url: process.env.DATABASE_READONLY_URL!, schema });

/** Pick `replica` only for safe reads; everything else goes to `primary`. */
export function pick(intent: 'read' | 'write') {
  return intent === 'read' ? replica : primary;
}

// Usage
await pick('read').product.findMany({ where: { active: true } });
await pick('write').product.update({ where: { id }, data: { stock: 0 } });
```

Two gotchas. **Read-after-write** is not satisfied by an async replica — if a
handler writes then reads, route the follow-up read to `primary` for at least
one replica-lag window (set a request-scoped flag once you've written).
**Transactions must always run on `primary`** — `$transaction` on the replica
will fail on the first write. If you wrap the request in a tx as in the
recipes above, the replica handle is unreachable inside the tx body unless
you explicitly call it; that's the intended trade.

For Mongo, prefer the driver's `readPreference: 'secondaryPreferred'` on a
single client over two `createDb` instances — the driver does the routing
inside the same connection pool.

---

## Observability

forge ships two hooks: `db.$on('query', …)` for per-query events and
`db.$on('error', …)` for failures. Everything else is built on top.

**OpenTelemetry.** `wireOtel` accepts any tracer that implements `startSpan`.
It emits one span per query named `forge.<op>` with OTel db semantic-convention
attributes (`db.system`, `db.statement`, `db.operation`, `db.collection.name`)
plus forge-specific ones (`forge.adapter`, `forge.model`, `forge.row_count`,
`forge.duration_ms`).

```ts
import { trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { wireOtel } from 'forge-orm';
import { db } from './db';

const sdk = new NodeSDK({ traceExporter: new OTLPTraceExporter({ url: process.env.OTLP_URL }) });
await sdk.start();

const offOtel = wireOtel(db, {
  tracer: trace.getTracer('forge', '1.0.0'),
  recordStatement: process.env.NODE_ENV !== 'production',   // omit raw SQL in prod traces
  maxStatementLen: 512,
});

process.on('SIGTERM', async () => { offOtel(); await sdk.shutdown(); });
```

**Structured logging with pino.** The same `$on('query')` event powers a
slow-query log without an OTel stack:

```ts
import pino from 'pino';
import { db } from './db';

const log = pino({ level: 'info' });
const SLOW_MS = Number(process.env.SLOW_QUERY_MS ?? 100);

db.$on('query', (e) => {
  if (e.duration_ms < SLOW_MS) return;
  log.warn({
    op: e.op,
    semanticOp: e.semanticOp,
    model: e.model,
    duration_ms: e.duration_ms,
    rows: e.rowCount,
    sql: typeof e.sql === 'string' ? e.sql.slice(0, 500) : undefined,
  }, 'slow_query');
});

db.$on('error', (e) => {
  log.error({ op: e.op, model: e.model, err: e.error.message }, 'query_error');
});
```

The events fire after the call resolves; subscriber cost is zero when nothing
is wired. Don't `await` inside a listener — it blocks the next query's
listener chain. Push to a queue or fire-and-forget instead.

---

## Health checks and readiness probes

Two endpoints, two different questions.

`/healthz` answers "is the process alive". It must not touch the database. A
liveness probe that depends on the DB will cycle your pods during a DB
hiccup and turn a small outage into a long one.

`/readyz` answers "is this replica ready to serve traffic". It runs the
cheapest possible round-trip and consults `db.$doctor()` once at boot (cached
in memory). Re-running `$doctor()` per probe is wasteful — its job is
capability detection, not heartbeat.

```ts
import { db } from './db';

let doctorReport: any | null = null;
db.$doctor().then((r) => { doctorReport = r; });

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/readyz', async (_req, res) => {
  try {
    // Cheapest round-trip per dialect.
    await db.$queryRaw`SELECT 1`;
    res.status(200).json({
      status: 'ready',
      adapter: db.adapter.kind,
      capabilities: doctorReport?.features ?? null,
    });
  } catch (err: any) {
    res.status(503).json({ status: 'not_ready', error: err.message });
  }
});
```

On Mongo `SELECT 1` is not valid SQL — use `db.$runCommandRaw({ ping: 1 })`.
On DuckDB the `$queryRaw` round-trip is essentially free since it's in-process.

In Kubernetes, give the readiness probe a `failureThreshold` of 3 with a 5s
period and a 10s initial delay. Liveness should be gentler: `failureThreshold`
of 6, `periodSeconds` 10. The asymmetry exists because a stuck pod is rarer
than a transient DB error, and you'd rather drop a pod from the LB than kill
it outright.

---

## Hot reload and dev ergonomics

`tsx watch` and `nodemon` reload your code by killing the child process and
spawning a new one. The new process opens new connections; if your previous
process leaked them (no `SIGTERM` handler), you'll exhaust the DB's max
connections in 10-20 reloads. Wire shutdown unconditionally:

```ts
const stop = async (sig: NodeJS.Signals) => {
  console.log(`[${sig}] draining…`);
  await server.close?.();
  await db.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('SIGHUP', stop);
```

For Vitest, one shared in-memory SQLite `db` per worker plus a per-test tx
that throws to rollback gives savepoint-style isolation without depending on
the dialect's truncate semantics.

```ts
// vitest.setup.ts
import { beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { createDb } from 'forge-orm';
import { schema } from './src/schema';

let db: any, tx: any, rollback: (e: Error) => void;

beforeAll(async () => {
  db = await createDb({ url: 'sqlite::memory:', schema });
  await db.$migrate();                    // sqlite runtime DDL apply
});
beforeEach(async () => {
  await new Promise<void>((resolve) => {
    db.$transaction(async (t: any) => {
      tx = t; resolve();
      await new Promise((_, reject) => { rollback = reject; });
    }).catch(() => {});
  });
  (globalThis as any).db = tx;
});
afterEach(() => rollback?.(new Error('rollback')));
afterAll(() => db.$disconnect());
```

For Postgres-shaped integration tests, run against a real PG via
testcontainers — dialect differences (JSON path syntax, `ON CONFLICT`,
partial indexes) will bite you in CI if you only exercise SQLite locally.

---

## Schema versioning in production

`forge push` is the dev-loop tool. In production, run it from CI against the
target environment, gated on the diff. Two patterns work.

**Push-on-deploy.** Run `forge push` as a deploy step before the new app
version rolls out. Safe for additive changes (new columns with defaults, new
indexes, new tables). It blocks the deploy while DDL runs — fine for small
schemas, risky for large indexes. Pair with `--enable-extensions` so the
deploy is the moment a missing PostGIS or pgvector becomes visible.

```yaml
# .github/workflows/deploy.yml (excerpt)
- name: Schema check
  run: npx forge diff --check --ignore=/^_atlas_/i
- name: Push schema
  run: npx forge push --enable-extensions
- name: Deploy app
  run: ./scripts/deploy.sh
```

`--check` exits non-zero if the live DB drifts from the schema, so a deploy
without a corresponding push fails loud. `forge diff --json` is small and
stable enough to render as a PR-review comment via a 10-line node script.

**Blue/green rollout.** When a column rename or a NOT NULL backfill needs more
care than push-on-deploy can give, run the migration in three steps:

1. Deploy the new app version that **reads both** the old and the new column.
2. Run a backfill (a one-off script using forge `findManyStream` + `update`).
3. Drop the old column with a follow-up `forge push` after every replica has
   converged.

This is plain DB migration discipline; forge's job is to give you a stable
`diff` so you can verify each step touched only what you expected.

**Ignoring engine-managed objects.** Atlas, Logical replication slots, pg_repack
shadow tables, and similar all show up as drift. Use `forge diff --ignore=`
(string or regex) so the report only contains your own intent:

```sh
npx forge diff --ignore=/^_atlas_/i,/^pg_repack_/i,event_logs
```

The ignore list lives in your `forge.config.ts` for repeatability — see
[Ignoring drift on `forge diff`](../README.md#ignoring-drift-on-forge-diff)
for the config shape.

For the CLI surface itself — `push`, `diff`, `diff apply`, `rollback`, and
`doctor` — refer back to [Creating tables and migrations](../README.md#creating-tables-and-migrations).
