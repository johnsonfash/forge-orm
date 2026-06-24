# Connection pooling

Sizing rules per dialect, per-runtime constraints (Lambda, Workers, Bun, long-running Node), pgbouncer / RDS Proxy caveats, and the pool failure modes that show up in production.

* [Why pooling matters](#why-pooling-matters)
* [Where the pool lives in forge](#where-the-pool-lives-in-forge)
* [Pool parameters across drivers](#pool-parameters-across-drivers)
* [Sizing — the formula and the floor](#sizing--the-formula-and-the-floor)
* [Per-runtime patterns](#per-runtime-patterns)
  * [Long-running Node server (hyper-express, Fastify, Nest)](#long-running-node-server)
  * [PM2 cluster / Node `cluster` module](#pm2-cluster--node-cluster-module)
  * [AWS Lambda + RDS Proxy](#aws-lambda--rds-proxy)
  * [Cloudflare Workers + Hyperdrive](#cloudflare-workers--hyperdrive)
  * [Vercel Edge / Vercel Functions](#vercel-edge--vercel-functions)
  * [Bun runtime](#bun-runtime)
  * [Deno](#deno)
* [Connection-pool sidecars](#connection-pool-sidecars)
* [Transaction-mode vs session-mode poolers — what breaks](#transaction-mode-vs-session-mode-poolers--what-breaks)
* [SQLite "pooling"](#sqlite-pooling)
* [MongoDB pooling](#mongodb-pooling)
* [Pool exhaustion — symptoms and observability](#pool-exhaustion--symptoms-and-observability)
* [Multi-tenant pools](#multi-tenant-pools)
* [Pool warm-up](#pool-warm-up)
* [Connection lifecycle and SIGTERM drain](#connection-lifecycle-and-sigterm-drain)
* [Health checks and readiness probes](#health-checks-and-readiness-probes)
* [Common errors and what they actually mean](#common-errors-and-what-they-actually-mean)
* [Worked example A — hyper-express + pg pool with metrics](#worked-example-a--hyper-express--pg-pool-with-metrics)
* [Worked example B — Lambda + RDS Proxy](#worked-example-b--lambda--rds-proxy)
* [Worked example C — Workers + Hyperdrive](#worked-example-c--workers--hyperdrive)
* [Cross-references](#cross-references)

---

## Why pooling matters

A connection is not free. The cost is paid in three places, and you eat
all three on every fresh connect.

* **TCP + TLS handshake.** Round-trip for TCP SYN/SYN-ACK/ACK, then 1–2
  round-trips for TLS depending on protocol version and session
  resumption. On managed Postgres in another VPC or another region this
  is the dominant cost — 30–80 ms before a single byte of SQL crosses
  the wire. Cold-path requests under heavy load aren't slow because the
  database is slow; they're slow because they're waiting for a fresh
  handshake to a backend they didn't get to reuse.

* **Postgres backend process.** Each `pg` connection forks a backend
  process on the server. That fork costs CPU and roughly 5–10 MB of
  resident memory on a fresh install — more once you've loaded a
  reasonable schema, extensions, and the planner's stats cache. A 100
  vCPU box is happy serving thousands of in-flight queries; it is
  *unhappy* serving thousands of backend processes that have to be
  context-switched on and off the cores. Past a kernel-defined ceiling
  you start dropping queries before they're even parsed.

* **MySQL thread cost.** MySQL spawns a thread per connection. Threads
  are lighter than processes — but the cost compounds anyway because
  every thread holds InnoDB buffers, MDL locks, and a stack. The
  practical ceiling on a managed MySQL is the same shape as Postgres:
  the box runs out of headroom long before the schedulable workload
  does.

A pool collapses all three. Connections are opened once, kept warm,
shared across requests, and torn down only at shutdown. The numbers
matter — the difference between "pool reuses a warm connection" and
"pool can't grow fast enough so it dials a new one" is the difference
between a 2 ms request and a 60 ms one.

For the higher-level architectural intent see
[BACKEND.md](./BACKEND.md#connection-pooling-and-lifecycle); this doc
goes deeper on what the knobs actually do and why each runtime needs a
different recipe.

---

## Where the pool lives in forge

forge does not own a pool. The pool is owned by your driver wrapper.
The forge executor only ever calls `query(sql, params)` on the
[`PostgresDriver`](./DRIVERS.md#postgresdriver),
[`MysqlDriver`](./DRIVERS.md#mysqldriver), or
[`MongoDriver`](./DRIVERS.md#mongodriver) port — and when you wrote the
driver you constructed the pool. That makes pooling a property of the
client library, not the ORM:

```ts
import { Pool } from 'pg';
import { createDb, pgDriver } from 'forge-orm';

// You own this pool. forge just talks to it.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

const db = await createDb({ schema, driver: pgDriver(pool) });
```

That decoupling is intentional. It means:

* You can swap `pg` for `postgres.js` or `@neondatabase/serverless`
  without changing your schema, queries, or transaction code.
* You can hand the same pool to two `createDb` calls (one with a
  tenant-scoped schema, one without) — both share connections.
* On shutdown, `db.$disconnect()` defers to the pool you gave it. If
  you also call `pool.end()` directly it's a no-op the second time.

The two-call shape lives in
[DRIVERS.md](./DRIVERS.md#the-two-call-shape-url-vs-driver): pass a
`url` and forge constructs a *default* pool with the library's default
knobs, or pass a `driver` you wrapped yourself and you own every knob.
For anything serving real traffic, own the driver.

---

## Pool parameters across drivers

The same five knobs exist almost everywhere; the names differ. This
table is the one to print and put next to your IDE.

| Concept | `pg` | `postgres.js` | `mysql2` | `mariadb` | `mongodb` | `tedious` (MSSQL) |
|---|---|---|---|---|---|---|
| Max connections | `max` | `max` | `connectionLimit` | `connectionLimit` | `maxPoolSize` | `pool.max` |
| Min / warm-pool | `min` | `min` (via `idle_timeout: 0`) | n/a — lazy | n/a — lazy | `minPoolSize` | `pool.min` |
| Idle timeout | `idleTimeoutMillis` | `idle_timeout` (s) | `idleTimeout` (ms) | `idleTimeout` (ms) | `maxIdleTimeMS` | `pool.idleTimeoutMillis` |
| Acquire wait timeout | `connectionTimeoutMillis` (covers both) | `connect_timeout` (s) | `connectTimeout` (ms) for TCP; `waitForConnections` for queueing | `acquireTimeout` (ms) | `waitQueueTimeoutMS` | `pool.acquireTimeoutMillis` |
| Eviction policy | per-connection `idleTimeoutMillis` | sliding `idle_timeout` | `idleTimeout` + `maxIdle` | `idleTimeout` + `maxIdle` | `maxIdleTimeMS` + ping | `pool.evictionRunIntervalMillis` |
| Per-conn lifetime cap | n/a (use `maxLifetimeSeconds` on pool patches) | `max_lifetime` (s) | `maxIdle`; no native lifetime | `maxIdle` | `maxConnecting`, `maxStalenessSeconds` | n/a |
| Statement timeout | `statement_timeout` server option | `statement_timeout` (s) | `connectTimeout`, `enableKeepAlive` | `socketTimeout` | per-op `maxTimeMS` | `requestTimeout` |
| Keep-alive | `keepAlive: true` | `keep_alive` | `enableKeepAlive`, `keepAliveInitialDelay` | same | always on | always on |

A couple of asymmetries to internalise:

* **`pg` collapses two timeouts into one.** `connectionTimeoutMillis`
  governs both "time to open a new socket" and "time to wait for an
  in-pool connection if all are busy". Most other libraries split
  these. The practical consequence: if you raise it to give slow
  handshakes more room, you also raise the time a request stalls
  waiting for an in-use connection.

* **`mysql2` defaults are unbounded.** `queueLimit: 0` means "infinite
  pending acquires". Under traffic this turns pool exhaustion into a
  memory leak instead of a fast 503. Always cap it
  (`queueLimit: 50` for an 8-connection pool is a sane shape).

* **`postgres.js` uses seconds, not milliseconds.** Easy mistake; the
  driver doesn't validate the magnitude, so `idle_timeout: 30000`
  means *thirty thousand seconds*, not thirty seconds.

* **`mongodb` defaults `maxPoolSize` to 100 per `MongoClient`.** A
  10-replica deployment with default settings has 1,000 sockets pointed
  at a 3-node replica set. Bring it down hard.

* **MSSQL `tedious` defaults the *request* timeout to 15 seconds.** Long
  reports silently truncate. Raise `requestTimeout` and set a per-query
  cap with `OPTION (MAXDOP …)` where it matters.

---

## Sizing — the formula and the floor

The Postgres community's working formula, cited often enough that it's
the only one most teams need:

```
connections = ((core_count * 2) + effective_spindle_count)
```

It comes from PgBouncer / pgcat lore, originally documented on the
PostgreSQL wiki. `core_count` is the number of physical cores on the
database server (not vCPUs, not threads); `effective_spindle_count` is
1 for a single disk, ~the disk count for RAID, and 0 for "all the
working set fits in RAM". For a managed Postgres on a 4-core instance
with NVMe storage that's `(4*2) + 1 = 9` — call it 10 — *per replica*
of the application.

That formula is the **upper bound** of useful concurrency. Past it,
adding connections moves work from `pg_stat_activity` queueing to
kernel context-switching, and your p99 gets worse.

The floor is set by something different: how many in-flight queries
you actually have. If a request handler issues four serial queries and
you serve 200 RPS, you need enough pool to absorb the worst case (~all
200 requests happen to be on their slowest query at the same moment).
In practice the queue depth distribution is much narrower than that —
`sqrt(RPS × avg_query_ms / 1000)` is a tighter back-of-envelope.

### Per-replica budgeting

Your pool *per process* and your pool *across the fleet* are different
numbers, and the second is the one that hits the database.

* Single replica, single process: pool = the formula above.
* N replicas, single process each: pool *per process* = formula / N.
* N replicas, M PM2 workers each: pool *per worker* = formula / (N × M).

If your managed Postgres has a 100-connection ceiling, your fleet's
total pool — summed across every container, every PM2 worker, and a
small headroom for migrations and `psql` — needs to fit under that
ceiling. The most common production incident is "we added two more
replicas during a traffic spike and the database fell over because we
quietly went over `max_connections`".

A simple worksheet:

```
pool_per_process × processes_per_pod × pods × replicas_per_AZ + headroom < max_connections

(example)
   pool = 8
×  PM2 workers = 4
×  pods = 12
×  AZs running simultaneously during deploy overlap = 2
+  headroom (admin / migrations / replicas / metrics exporter) = ~10
=  778

max_connections must be ≥ 778. Most managed PG defaults to 100–200.
```

When the worksheet doesn't fit, the fix is a pooler ("[Connection-pool
sidecars](#connection-pool-sidecars)" below), not a bigger pool. You
*never* want to raise the pool past the formula on the box itself.

---

## Per-runtime patterns

The same Postgres pool with `max: 8` behaves completely differently in
each of these runtimes. Pick the recipe that matches yours.

### Long-running Node server

A normal API process — `hyper-express`, Fastify, NestJS, Express. The
pool's lifetime is the process's lifetime. Build it once at module
load and share it across every request.

```ts
// src/db.ts — one module, exported once, lives for the process.
import { Pool } from 'pg';
import { createDb, pgDriver } from 'forge-orm';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
  max: 8,
  min: 2,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  keepAlive: true,
});

// Surface pool events so you can wire them into your metrics layer.
pool.on('error', (err) => console.error('[pg] idle client error', err));

export const db = await createDb({ schema, driver: pgDriver(pool) });
export const dbPool = pool; // for /healthz and shutdown
```

```ts
// src/server.ts
import { db, dbPool } from './db';
import HyperExpress from 'hyper-express';

const app = new HyperExpress.Server();
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, idle: dbPool.idleCount, total: dbPool.totalCount });
});

await app.listen(3000);

// SIGTERM drain.
const drain = async (sig: string) => {
  console.log(`[server] ${sig} — draining`);
  await app.close();
  await db.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => drain('SIGTERM'));
process.on('SIGINT',  () => drain('SIGINT'));
```

What matters here:

* The pool is module-scope, not request-scope. A common mistake is
  building a new `pg.Pool` inside a request handler or per-test
  fixture. The handshake cost is the entire pool benefit.
* `min: 2` keeps two warm sockets so the first request after an
  idle minute doesn't pay handshake latency.
* SIGTERM drain — see
  [Connection lifecycle and SIGTERM drain](#connection-lifecycle-and-sigterm-drain).

### PM2 cluster / Node cluster module

PM2 in `exec_mode: 'cluster'` (or the bare `node:cluster` module)
forks worker processes. **Each worker has its own pool.** PM2 does not
share connections across workers; it can't — they're separate V8 isolates.

The math you need is multiplicative: total connections to the database
= `pool.max × workers × replicas`. With `max: 8`, four PM2 workers,
and ten Kubernetes replicas you've already hit 320 sockets. Drop
`pool.max` accordingly. The Postgres formula gives a *per-box*
ceiling; PM2 makes that the *per-fleet* ceiling because every worker
counts.

```ts
// pm2 ecosystem.config.js
module.exports = {
  apps: [{
    name: 'api',
    script: './dist/server.js',
    exec_mode: 'cluster',
    instances: 4,
    kill_timeout: 30_000, // give SIGTERM drain room to finish
  }],
};
```

```ts
// src/db.ts — same shape as the long-running case, but with worker-aware sizing.
const workersPerHost = Number(process.env.WEB_CONCURRENCY ?? 4);
const replicasPerEnv = Number(process.env.REPLICA_COUNT ?? 1);
const fleetCeiling   = 80; // headroom under PG max_connections

const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
  max: Math.max(2, Math.floor(fleetCeiling / (workersPerHost * replicasPerEnv))),
  min: 0,
  idleTimeoutMillis: 15_000,
  connectionTimeoutMillis: 5_000,
});
```

The `kill_timeout: 30_000` matters. PM2's default is 1.6 seconds, and
on SIGTERM your worker has to finish in-flight requests, then
`db.$disconnect()`, then exit. 1.6 s isn't enough; PM2 force-kills,
and you get leaked sockets stuck on the database side until
`tcp_keepalive` reaps them.

### AWS Lambda + RDS Proxy

Lambda containers are ephemeral but **the global scope persists across
invocations**. A pool you build at module load survives every warm
invocation in the same container — and there can be thousands of
warm invocations between cold starts. So the question is not "should
Lambda pool?" but "how large is the pool inside one container?"

The answer is **1** — at most. A single container handles a single
invocation at a time, so it never needs more than one open connection
to do useful work. If you size `max: 10` per Lambda container and AWS
spins up 200 concurrent containers under load, you've taken 2,000
sockets — and your `max_connections` on RDS is 200.

```ts
// handler.ts — module scope (runs once per container).
import { Pool } from 'pg';
import { createDb, pgDriver } from 'forge-orm';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL!, // points at RDS Proxy
  max: 1,
  min: 1,
  idleTimeoutMillis: 60_000,    // keep the one connection warm across invocations
  connectionTimeoutMillis: 5_000,
});

const db = await createDb({ schema, driver: pgDriver(pool) });

// Lambda handler — uses the warm pool.
export const handler = async (event: any) => {
  const user = await db.user.findUnique({ where: { id: event.userId } });
  return { statusCode: 200, body: JSON.stringify(user) };
};
```

**Put RDS Proxy in front.** Without it, your Lambda fleet's
connection count scales with concurrency: 500 hot containers = 500
sockets, and the database pays the handshake bill on every cold start.
With RDS Proxy in front:

* The Proxy multiplexes Lambda's many short-lived sockets onto a small
  fixed pool against the real database (default 100% of `max_connections`).
* IAM auth means no long-lived password; the proxy injects credentials.
* Idle connections close on the Lambda side fast (you can drop
  `idleTimeoutMillis` to ~5 s); the proxy keeps the real backend warm.

What you do *not* do with Lambda + RDS Proxy:

* Build the pool inside the handler. That re-handshakes every invocation.
* Set `max > 1`. You will never use the extra slots inside one container.
* Skip the Proxy and hit RDS directly. Provisioned IOPS and connection
  limits are what burn first under concurrency.

The trade-off RDS Proxy imposes is the
[transaction-mode vs session-mode](#transaction-mode-vs-session-mode-poolers--what-breaks)
question — it pools in transaction mode by default, which has subtle
implications for `PREPARE`, advisory locks, and `SET LOCAL` outside a
transaction.

### Cloudflare Workers + Hyperdrive

Workers have *no persistent globals between requests*. You can declare
top-level constants, but you cannot rely on a TCP socket surviving
across requests in the same isolate — and you cannot reach a private
VPC from a stock Worker over plain `pg.Pool` at all. There are two
options:

* **Hyperdrive** — Cloudflare's first-party Postgres pooler. The
  Worker connects to Hyperdrive via TCP-over-HTTP, Hyperdrive holds
  the warm connection to your origin Postgres, and you size *its*
  pool against your database. The Worker side has no pool at all;
  the binding is the pool.
* **HTTP transports** — `@neondatabase/serverless` (Neon-flavoured
  HTTP/WebSocket), Supabase's `postgres.js` with `transform`, or
  PlanetScale's `@planetscale/database` for MySQL.

```ts
// worker.ts
import { Pool } from '@neondatabase/serverless';
import { createDb, pgDriver } from 'forge-orm';

export interface Env { HYPERDRIVE: Hyperdrive }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Per-request pool. max:1, lifetime:request. Hyperdrive holds the warm
    // connection on the other side of the binding.
    const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString });
    const db = await createDb({ schema, driver: pgDriver(pool) });
    try {
      const users = await db.user.findMany({ take: 10 });
      return Response.json(users);
    } finally {
      await db.$disconnect();
    }
  },
};
```

What's different:

* The pool is *per request*, not per process. There is no "process" in
  the Workers sense — the isolate's TCP state isn't yours to assume
  about.
* `max: 1` is the only correct value. Workers requests are single-flight.
* Hyperdrive itself has a connection limit per Worker — defaults to 4
  per request; raise via the dashboard if you fan out queries inside a
  single handler.

For Cloudflare D1, the driver is the binding directly — no pool at all,
because D1 *is* SQLite serving HTTP. See
[Six worked wrappers → D1](./DRIVERS.md#c-cloudflare-d1).

### Vercel Edge / Vercel Functions

Vercel Edge runs on the same isolate-style runtime as Workers, with
the same constraints: no persistent TCP, no pooling on the Edge side,
must front with an HTTP transport.

Vercel Functions (the Node.js runtime, not the Edge runtime) behave
like Lambda — global scope persists across warm invocations within a
container. The same rules apply:

* `max: 1` per function instance.
* Front with a managed pooler (Neon's pooled URL, Supabase's pgBouncer
  URL, RDS Proxy, or Hyperdrive if you're calling Cloudflare-side).
* `idleTimeoutMillis` long enough to survive warm-invocation gaps.

The most common Vercel mistake is `export default function handler` at
the top level *and* `new Pool` at the top level, with traffic shaped
such that you have 200 hot containers — each holding 10 sockets — and
a 100-connection Postgres. Cap it.

### Bun runtime

Bun's runtime model is closer to Node than to Workers — long-running
processes with module-scope globals that persist.

* **`bun:sqlite`** — synchronous, in-process, no pool concept. One
  Database handle per process is correct. If you fan out work across
  Bun's `Worker` threads, each Worker needs its own handle; SQLite
  serialises writes at the file lock regardless.
* **Postgres on Bun** — `pg` works under Bun's Node-compat shim, with
  the same pool semantics as Node. `postgres.js` runs natively. Pool
  sizing is the same long-running-server formula.
* **MySQL on Bun** — `mysql2` works under Node-compat, same caveats.

The one Bun-specific concern: Bun's process model can spawn child
processes more cheaply than Node. If you fork child processes for
worker pools, each child gets its own connection pool — same
multiplicative math as PM2.

### Deno

Deno's `deno-postgres` (`https://deno.land/x/postgres`) has its own
`Pool` class with a near-identical surface to `pg`. The
forge driver is a 20-line shim that conforms it to
[`PostgresDriver`](./DRIVERS.md#postgresdriver). All sizing advice
above applies — Deno is long-running, module-scope is your pool's
lifetime, SIGTERM drains via the same handler shape.

Deno Deploy (the managed runtime) behaves like Cloudflare Workers — no
persistent TCP, no native pool, must front with an HTTP transport or
use Deno KV / Deno's own managed PG offering.

---

## Connection-pool sidecars

When your fleet's connection demand exceeds your database's
`max_connections`, the answer is a *pooler in front of the database*,
not a larger pool inside your app. The three to know:

### PgBouncer

The classic. Lightweight C process, three pooling modes (session,
transaction, statement), no query awareness — it just shuttles bytes.

**Session mode.** Each client connection is bound to one backend
connection for the client's lifetime. Behaves identically to direct
Postgres — every session feature works. Pool size = number of *client
sessions*, which is roughly your fleet's pool sum. This is the safe
default; it's also the mode that gives the least multiplication
benefit.

**Transaction mode.** Each transaction borrows a backend for its
duration and returns it to the pool on COMMIT/ROLLBACK. Pool size =
number of *concurrent transactions*, which can be much smaller than
the fleet's pool sum. This is where the multiplication actually
happens — 2,000 client sockets onto 50 backend sockets, easily.

The catch is what breaks in transaction mode:

* **No `PREPARE`** — prepared statements live on the backend
  connection. The next transaction gets a different backend and the
  statement is gone. Disable client-side prepares
  (`?prepare=false` on `postgres.js`, or `pgbouncer=true`).
* **No server-side cursors outside a transaction.** A `DECLARE
  CURSOR` outside `BEGIN` lives on the backend connection, which
  you don't get back. forge's
  [streaming cursor](./DRIVERS.md#postgresdriver) is OK because it
  always wraps the cursor in `BEGIN/COMMIT`.
* **No `LISTEN/NOTIFY`** on the pooled connection. Use a separate
  direct connection (or session-mode port) for pub/sub.
* **No `SET` outside a transaction.** `SET application_name = …`
  on a pooled connection leaks to whichever next client gets that
  backend. Use `SET LOCAL` inside a transaction, or pass session
  parameters via the connection URI options.
* **No advisory locks across statements.** `pg_advisory_lock` taken
  outside a transaction is held by the backend; the next transaction
  on a different backend doesn't see it. Use
  `pg_advisory_xact_lock` inside a `BEGIN`.

**Statement mode** is too restrictive for an ORM — even simple
multi-step interactions (a SELECT then a follow-up UPDATE in the same
JS function) can land on different backends. Don't use it.

### PgCat

A multi-protocol pooler written in Rust; pgbouncer-compatible plus
query-aware features (read/write split, shard routing). Sizing is the
same as pgbouncer. Adds load-balancing across read replicas without
needing the app to know about replicas.

### RDS Proxy

AWS's managed pooler. Transaction-mode by default with
`pinning_filters` for situations that require session affinity
(prepared statements, advisory locks, temp tables — RDS Proxy pins
the connection for the rest of the transaction when it sees one). IAM
auth so secrets live in IAM, not env vars.

The right shape: Lambda → RDS Proxy → RDS. With RDS Proxy, raise your
RDS-side `max_connections` modestly (it's how the Proxy avoids the
pin-then-stall failure mode) but you don't need fleet-wide multiplication —
the Proxy *is* the pool.

### Hyperdrive

Cloudflare's pooler. TCP-over-HTTP transport from Worker to
Hyperdrive; Hyperdrive holds a small warm Postgres pool to your
origin. Sizing is on the Hyperdrive side, not the Worker side.
Caching is offered as a separate layer; transaction-mode applies
the same way.

---

## Transaction-mode vs session-mode poolers — what breaks

The summary table is worth memorising.

| Feature | Session mode | Transaction mode | Statement mode |
|---|---|---|---|
| Pool multiplication factor | low | high | very high |
| Prepared statements (`PREPARE`) | works | breaks — disable in client | breaks |
| Server-side cursors outside `BEGIN` | works | breaks | breaks |
| Server-side cursors inside `BEGIN` | works | works | breaks (statements split) |
| `LISTEN`/`NOTIFY` | works | breaks | breaks |
| `SET` outside `BEGIN` | works | leaks — use `SET LOCAL` | leaks |
| `SET LOCAL` inside `BEGIN` | works | works | breaks |
| Advisory locks via `pg_advisory_lock` | works | breaks | breaks |
| Advisory locks via `pg_advisory_xact_lock` | works | works | breaks |
| Temp tables | works | breaks across transactions | breaks |
| forge `db.$transaction(fn)` | works | works | unsafe |
| forge cursor stream | works | works | breaks |

forge uses no session-bound features by default. It does not issue
client-side `PREPARE`; it does not `LISTEN`; it does not `SET` outside
a transaction; it does not take long-lived advisory locks. So
**transaction mode is safe** for forge's normal query and mutation
surface — which is why
[BACKEND.md](./BACKEND.md#connection-pooling-and-lifecycle) recommends
it as the default in front of managed PG.

The two things you may add that break this:

* **Client-side prepared statements.** `postgres.js` will prepare any
  query you call more than once unless you pass `prepare: false` (or
  `pgbouncer: true`, which is the same flag). Set it.
* **App-level advisory locks.** If you use `pg_advisory_lock` for a
  cross-app mutex (queue leader election, periodic job dedup), it
  has to run on a session-mode port. Open a second small pool against
  the session-mode pooler endpoint for those calls only.

---

## SQLite "pooling"

SQLite has no pool. There is one file, one writer at a time, and
nothing the application can do about it — the lock lives in the file
system, not the driver.

What the runtime *can* do:

* **WAL mode** — `PRAGMA journal_mode = WAL` at connect time lets
  many readers operate concurrently with one writer, instead of the
  default "one operation at a time" rollback journal. This is the
  single setting that moves the throughput needle on SQLite.
* **One handle per process for writes** — `better-sqlite3` is sync;
  the calling code serialises naturally. With `wasmSqliteDriver` the
  handle queues internally through a promise chain. Either way, one
  handle is correct.
* **Many handles for reads** — open additional handles for read-only
  workers. They contend at the file lock for reads but not against
  each other.
* **Connection per worker** — if you fan out across Node `worker_threads`,
  each worker opens its own handle. SQLite serialises through the file
  lock regardless; the parallelism is "decoder + JSON.parse + JS work",
  not raw I/O.

Pragmas worth setting at boot:

```ts
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous  = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA cache_size   = -200000; -- ~200MB
  PRAGMA foreign_keys = ON;
`);
```

`busy_timeout` is the *important* one. The default is 0 — a write that
hits the lock fails immediately with `SQLITE_BUSY`. Setting it to 5
seconds turns those failures into the writer simply waiting its turn,
which is almost always the right behaviour.

For libsql / Turso the story is different: there's a network in
between, and the server pools on the other side. Pool size on the
client is the count of in-flight HTTP requests you allow — practically,
let the HTTP client handle it.

For sqlite-wasm in the browser, see
[BROWSER.md](./BROWSER.md) — there's only ever one writer-tab anyway
because OPFS is exclusive-locked.

---

## MongoDB pooling

`mongodb` ships its own pool, internal to the `MongoClient`. forge
doesn't see it; it just calls operations on the client.

Knobs to set explicitly (all on `MongoClient` options):

* `maxPoolSize` — default 100. Bring it down to your concurrency
  ceiling per process. For a typical Node API, 10–20 is plenty.
* `minPoolSize` — default 0. Set to 2–4 to keep warm sockets and
  avoid handshake-cost spikes on first request after idle.
* `maxIdleTimeMS` — default 0 (never close). Set to 60 s so idle
  sockets get reaped instead of accumulating.
* `waitQueueTimeoutMS` — default 0 (wait forever). Set to 5–10 s so
  pool exhaustion becomes a fast 503 instead of an unbounded hang.
* `serverSelectionTimeoutMS` — default 30 s. Drop to 5 s for fast
  fail under partial cluster outage.
* `connectTimeoutMS` — default 30 s. Drop to 5 s.
* `socketTimeoutMS` — default 0. Set roughly to your slowest expected
  operation (10–30 s for OLTP).
* `heartbeatFrequencyMS` — default 10 s; rarely worth touching.

Sizing for Atlas tiers:

| Tier | Total connection limit | Recommended per-replica pool |
|---|---|---|
| M0 free | 500 cluster | 4 |
| M2 / M5 shared | 500 cluster | 4 |
| M10 | 1,500 cluster | 20 |
| M20 | 3,000 cluster | 30 |
| M30+ | 3,000+ | depends — multiply across fleet |

The cluster-wide cap is the one that bites. You can have unlimited
replicas, but if they each open 100 sockets you hit M0's 500-limit at
5 replicas. Always set `maxPoolSize` explicitly; never let the
default 100 propagate to production.

DocumentDB and Cosmos (Mongo API) shim onto the same client. Their
ceilings differ — DocumentDB caps connections by instance class,
Cosmos by RU/s tier. The connection-shape behaviour is the same.

---

## Pool exhaustion — symptoms and observability

When the pool fails, it fails in one of three shapes.

**1. Acquire timeouts.** Requests wait the full
`connectionTimeoutMillis` for a free connection that never frees,
then throw. Symptoms:

* p99 latency jumps to exactly `connectionTimeoutMillis` (a "wall").
* p50 is unchanged because uncontested requests still go fast.
* `pool.waitingCount` (pg) or `pool.acquiringConnections` (mysql2) > 0
  sustainedly.
* Logs show `timeout exceeded when trying to connect` (pg),
  `acquireTimeout` (mariadb), `MongoWaitQueueTimeoutError` (mongo).

**2. Backend cap exhaustion.** The pool grows past the database's
`max_connections`; the database rejects new connections.

* Logs show `too many connections for role` (PG),
  `ER_CON_COUNT_ERROR` (MySQL), `MongoTopologyClosedError` (Mongo).
* New replicas come up but their pools can't fill — you see "ready"
  health checks while traffic still 503s.
* `pg_stat_activity` shows `usename` slots full.

**3. Stuck connections.** Connections check out and never check back
in — long queries, leaked transactions, deadlocks.

* `pool.idleCount` drops to 0 and stays there.
* `pg_stat_activity` shows queries with `state='active'` and
  `query_start` minutes in the past.
* The fix is *server-side* — `statement_timeout`, idle-in-transaction
  timeout — because the app has already lost track of the connection.

### Observability hooks

Pool stats are not pushed; you have to read them.

```ts
// pg
function snapshot(pool: Pool) {
  return {
    total: pool.totalCount,     // currently open sockets
    idle:  pool.idleCount,      // available for acquire
    waiting: pool.waitingCount, // pending acquires
  };
}
setInterval(() => prom.gauge.set(snapshot(pool)), 10_000);
```

```ts
// mysql2
function snapshot(pool: Pool) {
  // mysql2 doesn't expose stats directly; reach in via the raw pool.
  const raw = (pool as any).pool;
  return {
    total: raw._allConnections.length,
    idle:  raw._freeConnections.length,
    waiting: raw._connectionQueue.length,
  };
}
```

```ts
// mongo
function snapshot(client: MongoClient) {
  const events = client.options.monitorCommands ? /* via CMAP events */ : null;
  // Easier: subscribe to connectionPoolEvents at boot.
}
client.on('connectionPoolReady', e => prom.gauge.set({ available: e.options.maxPoolSize }));
client.on('connectionCheckOutFailed', () => prom.counter.inc());
```

The metric to alert on is **`waiting > 0` sustained for > 30 s**.
That's the queue-depth signal that arrives before the wall does.

See [METRICS.md](./METRICS.md) for the wider observability
recommendation — query latency histograms, error code histograms,
pool gauges side-by-side.

### Mitigations

* Raise the pool — only if you're under the database's ceiling and
  the formula budget.
* Lower the per-request query count — N+1 queries are pool
  multipliers.
* Add a pooler in front (pgbouncer / RDS Proxy / Hyperdrive).
* Add a `statement_timeout` server-side so leaked-but-stuck
  connections get reaped.
* Switch heavy reports to a separate replica + separate pool so
  OLTP isn't starved by analytics. See
  [BACKEND.md → Read replicas](./BACKEND.md#read-replicas-and-split-routing).

---

## Multi-tenant pools

Two shapes, with very different operational characteristics.

### Shared pool, scoped queries

One pool, one `db` handle, every query carries a tenant column /
filter. This is forge's default shape — model definitions are
tenant-agnostic; the application code adds `where: { orgId }` to every
read.

Pros: pool sizing is one number. Cold-tenant cost is nothing. Tenant
churn (new sign-ups, churned customers) costs the pool nothing.

Cons: tenant isolation is application-enforced. A forgotten `orgId`
filter leaks data. The mitigation is the forge query-builder pattern
documented in [MULTI-TENANT.md](./MULTI-TENANT.md): a `scopedDb()`
helper that injects the tenant filter at the model level.

```ts
// One pool, one db, tenant filter via a thin wrapper.
const db = await createDb({ schema, driver: pgDriver(pool) });

export function scopedDb(orgId: string) {
  return {
    user: {
      findMany: (args: any = {}) =>
        db.user.findMany({ ...args, where: { ...args.where, orgId } }),
      // …
    },
  };
}
```

### Pool per tenant

One pool per tenant — usually because each tenant has a separate
database or schema. Common in B2B-vertical SaaS with per-customer DBs
for compliance reasons.

Pros: tenant isolation is *physical*. A query against tenant A
literally cannot reach tenant B's data.

Cons: pool sizing is now `tenants × max_per_pool`. With 1,000 tenants
and `max: 2`, you're at 2,000 sockets per replica. The fix is **LRU
pool eviction** — keep a bounded cache of warm pools, evict the least
recently used.

```ts
// LRU pool cache.
import LRU from 'lru-cache';

const pools = new LRU<string, Pool>({
  max: 50,                  // max warm tenants
  ttl: 5 * 60_000,
  dispose: (pool) => pool.end().catch(() => {}),
});

function tenantPool(orgId: string): Pool {
  let pool = pools.get(orgId);
  if (!pool) {
    pool = new Pool({ connectionString: dsnFor(orgId), max: 2 });
    pools.set(orgId, pool);
  }
  return pool;
}

export async function tenantDb(orgId: string) {
  return createDb({ schema, driver: pgDriver(tenantPool(orgId)) });
}
```

The eviction `dispose` callback closes the pool when an LRU slot is
reclaimed. Set the LRU `ttl` long enough that hot tenants stay
resident but short enough that cold tenants don't pin sockets.

For very large tenant counts (>10k), pool-per-tenant is the wrong
shape regardless of LRU — switch to shared pool + row-level
filtering, and accept the application-enforced isolation cost.

---

## Pool warm-up

On a fresh process, the first N requests pay handshake cost. Two ways
to amortise.

### Configured `min`

Most pools accept a `min`. Setting `min: 2` tells the pool to open
two connections at boot and keep them open even when idle.

```ts
const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
  max: 8,
  min: 2,
  idleTimeoutMillis: 30_000,
});
```

`pg` honours `min` only on first use, not at construction. To force
the connections open *at boot*, do the warm-up explicitly.

### Explicit warm-up at boot

```ts
async function warmPool(pool: Pool, n: number) {
  const clients = await Promise.all(
    Array.from({ length: n }, () => pool.connect()),
  );
  // Each connection is now open; release them back to the pool.
  for (const c of clients) c.release();
}

await warmPool(pool, 2);
```

Run this before your HTTP server starts listening — so the
`/readyz` probe doesn't pass until the pool is warm. The first
request after boot then never pays handshake cost.

For Mongo, `client.connect()` is the warm-up — it opens
`minPoolSize` sockets. For mysql2, do the same explicit acquire-loop
pattern as `pg`.

---

## Connection lifecycle and SIGTERM drain

The lifecycle rule across every dialect:

1. **Connect lazily, then warm.** Build the pool object at boot but
   let the warm-up step decide when sockets actually open. Eager
   connect-at-construction is fine in long-running processes; lazy is
   correct in Lambda.

2. **Open before serving.** The HTTP server starts listening *after*
   the pool is ready. Otherwise the first request races with the
   handshake.

3. **Close after the server drains.** SIGTERM triggers
   `server.close()` (stops accepting new connections, finishes
   in-flight ones), *then* `db.$disconnect()` (drains the pool).

```ts
const shutdown = async (sig: string) => {
  console.log(`[server] received ${sig}`);
  // 1. Stop accepting new connections.
  await app.close();
  // 2. Give in-flight requests a moment to finish (their pool slots will
  //    release naturally on response.end).
  await new Promise(r => setTimeout(r, 1_000));
  // 3. Drain the pool. db.$disconnect() defers to pool.end().
  await db.$disconnect();
  console.log('[server] drain complete');
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM').catch(err => {
  console.error('drain failed', err); process.exit(1);
}));
process.on('SIGINT',  () => shutdown('SIGINT').catch(err => {
  console.error('drain failed', err); process.exit(1);
}));
```

The Kubernetes / PM2 / systemd default kill timeout is short. On
SIGTERM you get a fixed window before SIGKILL. Make sure the drain
fits:

* Kubernetes `terminationGracePeriodSeconds`: default 30 s; raise if
  your slowest request can exceed that.
* PM2 `kill_timeout`: default 1.6 s — **always raise this**, often to
  30 s.
* systemd `TimeoutStopSec`: default 90 s; usually fine.

If SIGKILL hits mid-drain, you leak sockets on the database side. PG
will clean them up via `tcp_keepalive` defaults, but the database can
have ghosts for minutes.

---

## Health checks and readiness probes

Two distinct probes, often confused.

* **Liveness** (`/healthz`) — "is this process alive?" Answer "yes" as
  long as the event loop is responsive. Do **not** touch the database;
  a transient DB outage shouldn't restart your pod.

* **Readiness** (`/readyz`) — "can this process serve traffic right
  now?" Answer "yes" only if the pool is warm and able to acquire a
  connection. A DB outage *should* take the pod out of load balancing.

```ts
app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/readyz', async (_req, res) => {
  try {
    const client = await Promise.race([
      pool.connect(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('acquire timeout')), 1_000)),
    ]);
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
    res.json({ ok: true, idle: pool.idleCount, total: pool.totalCount });
  } catch (err: any) {
    res.status(503).json({ ok: false, error: err.message });
  }
});
```

Tune the probe interval to be longer than the timeout. A `/readyz`
that hits the database every 2 seconds across 20 replicas at 8
connections per replica with a 1-second timeout = 80 RPS of `SELECT 1`
that competes for the same pool slots as your real traffic, plus a
real risk of probes timing out under load and flapping the pod.

Probe every 10–15 s; timeout 1–2 s.

`db.$doctor()` is the deeper diagnostic — runs the adapter's full
self-check (capabilities, extensions, system pragmas). See
[DOCTOR.md](./DOCTOR.md). Don't put it on a hot probe path; run it at
boot and on demand.

---

## Common errors and what they actually mean

| Error message | Real cause | First thing to check |
|---|---|---|
| `timeout exceeded when trying to connect` (pg) | All pool slots are busy *or* TCP handshake stalled | `pool.waitingCount`, network to DB |
| `Connection terminated unexpectedly` (pg) | Backend died, network blip, or `idle_in_transaction_session_timeout` reaped your idle session | Server logs around the same timestamp |
| `Connection terminated due to connection timeout` (pg) | Idle-killed by a pooler or firewall in between | `tcp_keepalive_*`, pooler `idle_timeout` |
| `ER_CON_COUNT_ERROR: Too many connections` (MySQL) | Fleet sum of `connectionLimit` > server `max_connections` | Fleet pool worksheet |
| `PROTOCOL_CONNECTION_LOST` (mysql2) | Server closed the connection (idle, restart, replica failover) — mysql2 will reconnect lazily | Set `enableKeepAlive` to detect deads faster |
| `MongoWaitQueueTimeoutError` | Pool exhausted; all `maxPoolSize` sockets are checked out | Long ops in `db.currentOp()` |
| `MongoNetworkError` | Replica set election in progress, or transient network | Atlas / cluster events around the same time |
| `pool is draining` (any) | A new acquire arrived after `$disconnect()` started | A request handler is racing with shutdown — fix `shutdown()` ordering |
| `RDS Proxy: connection pinned` (CloudWatch) | A statement triggered backend pinning (PREPARE, advisory lock, temp table) | Remove that statement or accept the lower multiplication factor |
| `socket hang up` from Hyperdrive | Worker exited before request completed, or > 30 s query | Check Hyperdrive analytics; raise Worker CPU limit |
| `SQLITE_BUSY` | Another writer holds the file lock and `busy_timeout` is 0 | Set `PRAGMA busy_timeout = 5000` |
| `Pool was closed` (postgres.js) | `sql.end()` ran somewhere it shouldn't have | Audit shutdown order |

The pattern: the error message is rarely the cause. Pool exhaustion
shows up as "timeout connecting"; backend death shows up as "pool was
closed"; pooler eviction shows up as "connection terminated". The
*pool gauges* are the truth — `total`, `idle`, `waiting` at the
moment of the failure.

---

## Worked example A — hyper-express + pg pool with metrics

A long-running API serving a managed Postgres, with pool gauges
exported to Prometheus and a SIGTERM drain.

```ts
// src/db.ts
import { Pool } from 'pg';
import { createDb, pgDriver } from 'forge-orm';
import { Counter, Gauge, Histogram } from 'prom-client';
import { schema } from './schema';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
  max: Number(process.env.PG_POOL_MAX ?? 8),
  min: Number(process.env.PG_POOL_MIN ?? 2),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
  keepAlive: true,
  application_name: 'api',
});

const gTotal   = new Gauge({ name: 'pg_pool_total',   help: 'open sockets in the pool' });
const gIdle    = new Gauge({ name: 'pg_pool_idle',    help: 'idle sockets in the pool' });
const gWaiting = new Gauge({ name: 'pg_pool_waiting', help: 'pending acquires' });
const cAcqFail = new Counter({ name: 'pg_pool_acquire_failed_total', help: 'acquire timeouts' });
const hQuery   = new Histogram({
  name: 'forge_query_duration_seconds',
  help: 'query duration', buckets: [0.001,0.005,0.01,0.05,0.1,0.5,1,5,10],
  labelNames: ['model', 'op'],
});

// Sample the pool gauges every 5 s.
setInterval(() => {
  gTotal.set(pool.totalCount);
  gIdle.set(pool.idleCount);
  gWaiting.set(pool.waitingCount);
}, 5_000).unref();

pool.on('error', (err) => console.error('[pg] idle client error', err));

// Warm the pool before listening.
async function warm(n: number) {
  const cs = await Promise.all(Array.from({ length: n }, () => pool.connect()));
  for (const c of cs) c.release();
}

await warm(Number(process.env.PG_POOL_MIN ?? 2));

export const db = await createDb({
  schema,
  driver: pgDriver(pool),
  events: {
    query: (e) => hQuery.observe({ model: e.model, op: e.op }, e.durationMs / 1000),
  },
});
```

```ts
// src/server.ts
import HyperExpress from 'hyper-express';
import { register } from 'prom-client';
import { db, pool } from './db';

const app = new HyperExpress.Server();

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/readyz', async (_req, res) => {
  try {
    const client = await Promise.race([
      pool.connect(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('acquire timeout')), 1_000)),
    ]);
    try { await client.query('SELECT 1'); } finally { client.release(); }
    res.json({ ok: true, idle: pool.idleCount, total: pool.totalCount });
  } catch (e: any) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

app.get('/metrics', async (_req, res) => {
  res.set('content-type', register.contentType);
  res.send(await register.metrics());
});

app.get('/users/:id', async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.params.id } });
  res.json(user);
});

await app.listen(Number(process.env.PORT ?? 3000));

const shutdown = async (sig: string) => {
  console.log(`[server] ${sig} — draining`);
  await app.close();
  await new Promise(r => setTimeout(r, 1_000));
  await db.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
```

What's wired here:

* Pool gauges (`total`, `idle`, `waiting`) sampled into Prometheus on
  a timer.
* Query latency histogram bucketed by `model` and `op` — alert on
  the right tail moving without throughput changing.
* `/readyz` does a real `SELECT 1` with a 1-second acquire timeout.
* SIGTERM drains the server, sleeps for in-flight responses, then
  closes the pool.
* `statement_timeout` server-side so a runaway query can't pin a pool
  slot indefinitely.

---

## Worked example B — Lambda + RDS Proxy

The pool is *one connection*, module-scope, surviving warm
invocations. RDS Proxy is the actual pooler.

```ts
// handler.ts
import { Pool } from 'pg';
import { createDb, pgDriver } from 'forge-orm';
import { schema } from './schema';

// Built at container init. Survives across every warm invocation.
const pool = new Pool({
  // RDS Proxy endpoint (not the RDS endpoint directly).
  connectionString: process.env.DATABASE_URL!,
  max: 1,
  min: 1,
  // Lambda containers go idle between bursts; keep the one socket warm.
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 5_000,
  // Statements that pin the RDS Proxy connection cost multiplication.
  // Disable client-side prepares if you ever switch to postgres.js.
});

const db = await createDb({ schema, driver: pgDriver(pool) });

export const handler = async (event: any) => {
  // Every invocation reuses the one warm connection if available.
  // Cold starts open it; subsequent invocations skip the handshake.
  try {
    const user = await db.user.findUnique({ where: { id: event.userId } });
    return { statusCode: 200, body: JSON.stringify(user) };
  } catch (err: any) {
    // Distinguish pool/connection errors from query errors for retries.
    if (err.code === '57P01' /* admin_shutdown */ ||
        err.code === '57P02' /* crash_shutdown */ ||
        err.message?.includes('timeout exceeded when trying to connect')) {
      // RDS Proxy rolled the underlying connection; retry once.
      const user = await db.user.findUnique({ where: { id: event.userId } });
      return { statusCode: 200, body: JSON.stringify(user) };
    }
    throw err;
  }
};
```

Configuration to match on the AWS side:

* **RDS Proxy**: enable IAM auth, set `IdleClientTimeout` to ~30 min,
  set `MaxConnectionsPercent` to 90 (leaves 10% for admin / migration
  / `psql`).
* **Lambda**: `ProvisionedConcurrency` if you need predictable cold
  starts (also reduces handshake spike at deploy).
* **VPC**: Lambda in the same VPC as RDS, with VPC endpoints for
  Secrets Manager and IAM. The Proxy itself fronts the RDS endpoint.
* **Timeouts**: Lambda's function timeout > the slowest query +
  buffer. `statement_timeout` server-side as a hard brake.

See [LAMBDA.md](./LAMBDA.md) for the wider deployment story.

---

## Worked example C — Workers + Hyperdrive

The Worker has no pool. Hyperdrive is the pool, lives on Cloudflare's
edge, and connects back to your origin Postgres.

```toml
# wrangler.toml
name = "api"
main = "src/worker.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<hyperdrive-id>"
```

```ts
// src/worker.ts
import { Pool } from '@neondatabase/serverless';
import { createDb, pgDriver } from 'forge-orm';
import { schema } from './schema';

export interface Env { HYPERDRIVE: Hyperdrive }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Per-request pool. max:1; Hyperdrive does the real pooling.
    const pool = new Pool({
      connectionString: env.HYPERDRIVE.connectionString,
      max: 1,
    });
    const db = await createDb({ schema, driver: pgDriver(pool) });
    try {
      const url = new URL(req.url);
      if (url.pathname === '/users') {
        const users = await db.user.findMany({ take: 50 });
        return Response.json(users);
      }
      return new Response('not found', { status: 404 });
    } finally {
      // Always disconnect — the isolate may be reused for any future request.
      await db.$disconnect();
    }
  },
};
```

Configuration to match on the Cloudflare side:

* **Hyperdrive pool size**: configured in the Cloudflare dashboard.
  Default is a small fixed pool; size to your origin's connection
  budget. This is the only pool that matters for connection-counting
  against Postgres.
* **Hyperdrive caching**: optional. Enable for read-heavy workloads;
  invalidate from the Worker via the API.
* **Connections per Worker request**: default 4. If you fan out
  parallel queries inside a single request, raise it.
* **TLS**: Hyperdrive handles TLS to the origin. The Worker sees a
  local-shaped connection.

For MySQL via PlanetScale, the equivalent shape uses
`@planetscale/database` directly — it's HTTP-only with no pool concept
on the Worker side; PlanetScale's edge does the pooling.

See [WORKERS.md](./WORKERS.md) for the full edge-deployment story.

---

## Cross-references

* [DRIVERS.md](./DRIVERS.md) — driver ports, pool knob mappings, edge
  runtime driver matrix
* [METRICS.md](./METRICS.md) — pool gauges, query histograms, error
  counters
* [BACKEND.md](./BACKEND.md) — framework wiring, request-scoped
  transactions, server lifecycle
* [MULTI-TENANT.md](./MULTI-TENANT.md) — shared pool vs pool-per-tenant
  patterns
* [DEPLOYMENT.md](./DEPLOYMENT.md) — packaging, environment, ops
* [POSTGRES.md](./POSTGRES.md) — Postgres-specific tuning, including
  `max_connections` and `statement_timeout`
* [MYSQL.md](./MYSQL.md) — MySQL-specific tuning, `wait_timeout`
* [MONGO.md](./MONGO.md) — Mongo-specific options, Atlas tier ceilings
* [LAMBDA.md](./LAMBDA.md) — AWS Lambda deployment, RDS Proxy
* [WORKERS.md](./WORKERS.md) — Cloudflare Workers deployment,
  Hyperdrive, D1
