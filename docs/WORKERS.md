# Cloudflare Workers and Vercel Edge

V8 isolates, no TCP sockets, 50ms-30s CPU limit, cold-start sensitive — Workers and Edge runtimes constrain which forge-orm setups work. This page covers what does: D1, Hyperdrive-fronted Postgres, Neon HTTP, Turso, Atlas Data API. Plus the cold-start budget, cache patterns, and observability options.

The high-level framework wiring lives in [BACKEND.md](./BACKEND.md). Pool
sizing per runtime lives in [POOLING.md](./POOLING.md). This doc is the
deeper-than-both story for the edge: the constraints, the working
recipes, the bindings, the four worked examples.

---

## Contents

* [What an isolate is — and isn't](#what-an-isolate-is--and-isnt)
* [Forge under Workers — what works, what doesn't](#forge-under-workers--what-works-what-doesnt)
* [Postgres via Hyperdrive](#postgres-via-hyperdrive)
* [Postgres via HTTP transports — Neon, Supabase, postgres.js](#postgres-via-http-transports--neon-supabase-postgresjs)
* [Cloudflare D1 — the Workers-native SQLite](#cloudflare-d1--the-workers-native-sqlite)
* [Turso / libsql on Workers](#turso--libsql-on-workers)
* [Mongo on Workers via Atlas Data API](#mongo-on-workers-via-atlas-data-api)
* [The fetch-wrapper pattern — when to write your own](#the-fetch-wrapper-pattern--when-to-write-your-own)
* [Pool sizing on the edge](#pool-sizing-on-the-edge)
* [The cold-start budget](#the-cold-start-budget)
* [Wrangler config](#wrangler-config)
* [Edge-vs-region — where the database actually lives](#edge-vs-region--where-the-database-actually-lives)
* [KV, R2, D1 — Workers-native storage alongside forge](#kv-r2-d1--workers-native-storage-alongside-forge)
* [Vercel Edge runtime — the small differences](#vercel-edge-runtime--the-small-differences)
* [Caching at the edge](#caching-at-the-edge)
* [Observability — logs, tail, OTel](#observability--logs-tail-otel)
* [Migrations from a Worker handler — don't](#migrations-from-a-worker-handler--dont)
* [Worked example A — Worker + D1](#worked-example-a--worker--d1)
* [Worked example B — Worker + Postgres via Hyperdrive](#worked-example-b--worker--postgres-via-hyperdrive)
* [Worked example C — Worker + Turso](#worked-example-c--worker--turso)
* [Worked example D — Vercel Edge + Neon HTTP](#worked-example-d--vercel-edge--neon-http)
* [Common failures](#common-failures)
* [Cross-references](#cross-references)

---

## What an isolate is — and isn't

A Workers request runs inside a V8 isolate, not a Node process. That one
difference accounts for every constraint on this page:

* **No raw TCP sockets.** No `node:net`, no `node:tls` unless you enable
  the `nodejs_compat` flag — and even then the socket API is the
  Cloudflare `connect()` shim, not stock Node. Stock `pg.Pool` cannot
  connect to Postgres from a default Worker. It connects to Hyperdrive
  only because Hyperdrive answers on Cloudflare's internal network and
  the Worker uses an HTTP-tunnelled socket the runtime provides.
* **No filesystem.** `fs.readFileSync` of a `.sqlite` file is
  meaningless — there is no disk. SQLite as a *binding* (D1) or
  *remote service* (Turso) works; SQLite as a local file does not.
* **No background threads.** No `worker_threads`, no native addons,
  no FFI. `setTimeout` dies with the request unless you wrap with
  `ctx.waitUntil()`.
* **CPU budget, not wall-clock budget.** 50 ms on the Free plan, 30 s
  on Paid. You can `await fetch()` for minutes; you cannot *compute*
  for minutes. forge query parsing and result hydration count against
  CPU; the round-trip to the database does not.
* **No persistent globals across requests.** You can declare top-level
  constants, and the isolate may reuse them — or it may be killed and
  a fresh isolate starts cold. You cannot rely on a top-level `new
  Pool()` surviving long enough to amortise its handshake.

Code as if every request might be the first request the isolate ever
sees.

---

## Forge under Workers — what works, what doesn't

Forge's runtime is portable: no Node-specific globals, no native
addons, no filesystem reads at import time. The shape that ships to
Node ships to Workers. What changes is the *driver* — the small adapter
between forge's `query(sql, params)` port and the actual client library.

| forge surface | Workers | Vercel Edge | Notes |
|---|---|---|---|
| `createDb` / model definitions | works | works | pure JS, no Node API |
| Query builder | works | works | string-emitting; runtime-neutral |
| `db.$transaction` | driver-dependent | driver-dependent | D1 has its own batch shape; Hyperdrive supports tx |
| `db.$watch` | works | works | poll-based, not LISTEN |
| `db.$migrate` (runtime DDL) | D1 only | n/a | other drivers don't apply DDL from edge |
| `forge push` (CLI) | from CI only | from CI only | not from a request handler |
| `pgDriver` over stock `pg` | broken | broken | needs TCP that Workers won't grant |
| `pgDriver` over `@neondatabase/serverless` | works | works | HTTP transport |
| `pgDriver` over Hyperdrive | works | n/a | Hyperdrive is Cloudflare-only |
| `libsqlDriver` over libsql HTTP | works | works | Turso edge |
| `libsqlDriver` over libsql native | broken | broken | needs sockets/FFI |
| `d1Driver` | works | n/a | binding-driven |
| `mongoDriver` over `mongodb` | broken | broken | needs DNS-SRV + TCP |
| Custom `mongoDriver` over Atlas Data API | works | works | HTTP shim |
| `mssqlDriver` | broken | broken | TDS over TCP |
| `mysqlDriver` over `mysql2` | broken | broken | TCP |
| `mysqlDriver` over `@planetscale/database` | works | works | HTTP transport |
| `duckdbDriver` | broken | broken | native binding |

The "broken" rows are not forge limitations. They are runtime
limitations forge can't paper over: there is no socket to dial.

---

## Postgres via Hyperdrive

Hyperdrive is Cloudflare's first-party Postgres pooler:

```
Worker isolate ── HTTP-tunnelled socket ── Hyperdrive ── TCP+TLS ── your Postgres
   (no pool)         (Cloudflare edge)      (the pool)     (the database)
```

What that buys you:

* The Worker never sees the origin handshake. Hyperdrive holds a warm
  pool against the database; the Worker speaks Postgres wire protocol
  to Hyperdrive, which multiplexes onto the warm pool.
* You can reach a private VPC Postgres from a Worker. Hyperdrive
  terminates on Cloudflare and tunnels to your origin — including IPs
  you would never expose publicly.
* Optional query caching at the Hyperdrive layer for read-heavy
  workloads, per-binding, API or TTL invalidation.

Setup is three steps:

```sh
npx wrangler hyperdrive create my-pg \
  --connection-string='postgres://user:pass@host:5432/db'
# returns hyperdrive-id; paste into wrangler.toml; deploy.
```

In code:

```ts
import { Pool } from '@neondatabase/serverless';
import { createDb, pgDriver } from 'forge-orm';
import { schema } from './schema';

export interface Env { HYPERDRIVE: Hyperdrive }

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
    const db = await createDb({ schema, driver: pgDriver(pool) });
    try { return await handle(req, db); }
    finally { ctx.waitUntil(db.$disconnect()); }
  },
};
```

Note `@neondatabase/serverless`, not stock `pg`. The package is
`pg`-compatible at the surface but uses HTTP/WebSocket under the hood
— which is what Cloudflare's isolate will let you do. It works
against Hyperdrive because Hyperdrive speaks the Postgres wire
protocol over Cloudflare's tunnel. The `nodejs_compat` flag must be
set for the package to import its Node shims.

Tuning the Cloudflare side:

* **Pool size** — dashboard. Size to your origin's `max_connections`
  budget minus headroom for other clients.
* **Per-request connections** — default 4; raise if a single request
  fans out parallel queries.
* **Caching** — enable for read-heavy GETs. Keyed on literal query
  text and parameters; queries embedding timestamps or random tokens
  cache-miss every time.

See [POOLING.md → Workers + Hyperdrive](./POOLING.md#cloudflare-workers--hyperdrive)
for the sizing rationale.

---

## Postgres via HTTP transports — Neon, Supabase, postgres.js

Hyperdrive is one option. The other is HTTP-native Postgres clients
that don't need a pooler:

* **`@neondatabase/serverless`** — Neon's HTTP/WebSocket transport.
  Works on any isolate runtime. `pg`-compatible at the `Pool` and
  `Client` level. HTTP mode is the Workers default; WebSocket is for
  streaming reads.
* **`postgres.js`** — works against Supabase's pg-meta HTTP surface,
  but native `postgres()` over TCP does not. On Workers, prefer the
  Neon transport even for Supabase-hosted databases (Supabase exposes
  a Neon-compatible pooler URL).
* **`@planetscale/database`** — MySQL over HTTP. Pure fetch, works
  natively on Workers. forge's `mysqlDriver` wraps it the same way it
  wraps `mysql2`.

```ts
import { neon } from '@neondatabase/serverless';
import { createDb, pgDriver } from 'forge-orm';

export default {
  async fetch(req: Request, env: { DATABASE_URL: string }): Promise<Response> {
    const sql = neon(env.DATABASE_URL);
    const driver = pgDriver({
      query: async (text, params) => {
        const rows = await sql(text, params ?? []);
        return { rows, rowCount: rows.length };
      },
      end: async () => {},
    } as any);
    const db = await createDb({ schema, driver });
    return Response.json(await db.user.findMany({ take: 10 }));
  },
};
```

The shim is what `pgDriver` expects internally: `query()` returning
`{ rows, rowCount }` and an `end()` no-op. Neon HTTP has no
connection state to close.

Connection string notes:

* Pooled URL (`-pooler`) on Workers — fewer round-trips, Neon handles
  reuse. Unpooled URL only for migrations.
* `?sslmode=require` if your provider expects it; Neon adds it
  implicitly.
* Region matters. Pick a Neon region near your most-used Worker
  region — see [Edge-vs-region](#edge-vs-region--where-the-database-actually-lives).

---

## Cloudflare D1 — the Workers-native SQLite

D1 is SQLite served from Cloudflare's edge — exposed to Workers as a
binding, not a URL. The forge wrapper is the
[`d1Driver`](./DRIVERS.md#c-cloudflare-d1) — eight lines around
`d1.prepare(sql).bind(...params)`:

```ts
import type { SqliteDriver } from 'forge-orm';

export function d1Driver(d1: D1Database): SqliteDriver {
  return {
    kind: 'sqlite',
    all: async (sql, params) =>
      (await d1.prepare(sql).bind(...params).all()).results,
    get: async (sql, params) =>
      (await d1.prepare(sql).bind(...params).first()) ?? undefined,
    run: async (sql, params) => {
      const r = await d1.prepare(sql).bind(...params).run();
      return { changes: r.meta.changes, lastInsertRowid: r.meta.last_row_id };
    },
    exec: async (sql) => { await d1.exec(sql); },
    close: async () => {},
  };
}
```

Binding in `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "myapp"
database_id = "<d1-uuid>"
```

Constraints to plan around:

* **Single writer.** D1 serialises writes through one node, exactly
  like local SQLite under the file lock. For bursty write workloads,
  batch into a single `db.$transaction` — one `BEGIN`/`COMMIT`
  round-trip instead of N.
* **No extensions.** JSON1 is built in; R-Tree, FTS5, sqlite-vec are
  not. Geo and vector queries via forge's typed helpers will not
  compile against D1 — use Postgres + PostGIS/pgvector via Hyperdrive
  instead.
* **No `ATTACH DATABASE`, no `PRAGMA journal_mode`, no `VACUUM` from
  a handler.** D1 owns the engine settings.
* **Time travel.** Cloudflare retains 30-day point-in-time snapshots.
  Restore via the dashboard or `wrangler d1 time-travel`.
* **Read replicas.** Eventually-consistent replicas in nearby
  regions. Reads default to the nearest replica; writes go to
  primary. forge isn't replica-aware — split read-mostly queries onto
  a separate `createDb` and accept staleness.
* **`exec` rejects on first error in a multi-statement script.** The
  forge migrator splits on `;` when it detects D1.

For everything else — DDL, queries, transactions — D1 behaves like
SQLite. forge's `applyDrift({ schema })` and `db.$migrate()` work
against it. See also [SQLITE.md](./SQLITE.md).

---

## Turso / libsql on Workers

Turso is libsql — a SQLite fork with a network protocol — running as a
managed multi-region service. The `@libsql/client` package exposes an
HTTP transport that works on Workers; the WebSocket transport works
too, but HTTP is the default Worker-friendly path:

```ts
import { createClient } from '@libsql/client';
import { createDb, libsqlDriver } from 'forge-orm';
import { schema } from './schema';

export default {
  async fetch(req: Request, env: { TURSO_URL: string; TURSO_TOKEN: string }) {
    const client = createClient({
      url: env.TURSO_URL,        // libsql://… or https://…
      authToken: env.TURSO_TOKEN,
    });
    const db = await createDb({ schema, driver: libsqlDriver(client) });
    return Response.json(await db.user.findMany({ take: 50 }));
  },
};
```

Notes:

* If your Worker runtime can't hold a WebSocket, set `url` to the
  `https://…` form and libsql falls back to plain HTTP. Slightly higher
  per-call overhead, but works in environments where WebSockets are
  flaky.
* Turso replicas are read-only. The client auto-routes writes to the
  primary; read latency depends on which replica the Worker reaches.
  Cloudflare's edge network does not guarantee colocation — pick a
  primary region near your write-heaviest traffic.
* libsql is SQLite under the hood, so the same extension-limitation
  story as D1 applies. Some Turso plans include sqlite-vec and FTS5;
  check before relying on `f.vector(N)` or `f.fts`.

---

## Mongo on Workers via Atlas Data API

Native `mongodb` cannot run on Workers — it needs DNS-SRV lookups, TCP
sockets, and the Node `net` API. The replacement is the Atlas Data API
(or any equivalent HTTP shim against a Mongo cluster).

The forge `MongoDriver` port doesn't care how the client is wired up,
only that it exposes `.db(name).collection(name).insertOne(doc)` etc.
That shape can be faked over HTTP — see
[DRIVERS.md → MongoDB Atlas Data API](./DRIVERS.md#d-mongodb-atlas-data-api-http-only-edge)
for the full shim. The trade-offs:

* **No transactions.** Atlas Data API has no transaction primitive.
  forge will emulate where possible, but multi-document atomicity is
  gone.
* **No change streams.** No `$watch` over HTTP; the API doesn't
  expose the oplog cursor.
* **Aggregation pipelines** are available via the `aggregate` action,
  but verify operator parity against your real cluster.
* **Latency.** Data API is HTTPS per call. Latency-sensitive
  workloads feel it.

The Atlas Data API was deprecated by MongoDB and replaced with the
newer Atlas App Services HTTPS endpoints; the shape is similar — wrap
the same shim, adjust the path/headers, done.

---

## The fetch-wrapper pattern — when to write your own

Three situations push you to write your own:

1. **Your database vendor has its own HTTP API** and the shipped
   driver doesn't fit.
2. **You're proxying through your own service** — a region-local
   HTTP gateway in front of a private database.
3. **You're talking to a stored-procedure surface** — named
   procedures only, not raw SQL.

The forge driver port is a few async functions. Implement them in
terms of `fetch`:

```ts
import type { PostgresDriver } from 'forge-orm';

export function httpPgDriver(opts: { endpoint: string; token: string }): PostgresDriver {
  return {
    kind: 'postgres',
    query: async (text, params) => {
      const r = await fetch(opts.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sql: text, params }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      const { rows, fields } = await r.json();
      return { rows, rowCount: rows.length, fields };
    },
    begin: async () => {}, commit: async () => {}, rollback: async () => {}, end: async () => {},
  };
}
```

Runs on Workers, Vercel Edge, Deno Deploy, Bun, Node — the runtime is
`fetch`, which is universal. Downsides:

* **No transactions** unless the endpoint accepts a whole transaction
  batch in one POST. `BEGIN`/`COMMIT` on separate fetches land on
  different sessions.
* **No `LISTEN`/`NOTIFY`.** Streaming subscriptions need a persistent
  connection.
* **Per-call overhead.** Each query is a fetch — N round-trips where
  a pooled driver pays 1.

See [DRIVERS.md → bring-your-own-driver](./DRIVERS.md#bring-your-own-driver)
for the full port shape.

---

## Pool sizing on the edge

The pool advice for Workers is short: don't have one.

* **Per-request lifecycle.** Build the driver, build the `db`, do the
  work, disconnect. The pool exists for the duration of one request.
* **`max: 1`.** Workers requests are single-flight; extra slots serve
  nothing.
* **Don't put `new Pool()` at module scope.** Module scope is *not*
  process scope on the edge. A top-level pool trades one real bug for
  two intermittent ones: stale connections in idle isolates, and
  unbounded socket growth across colocated isolates that reuse the
  same module.
* **Push pooling to the right layer.** Hyperdrive is the pool for
  Postgres on Workers. PlanetScale's edge is the pool for MySQL.
  Neon's pooled URL is the pool for HTTP Postgres. D1 doesn't need
  one. Turso's HTTP gateway is the pool.

Vercel Functions (Node runtime, not Edge) is the exception — warm
Lambda-style containers, persistent module scope, normal pooling. See
[Vercel Edge runtime](#vercel-edge-runtime--the-small-differences) and
[POOLING.md → Per-runtime patterns](./POOLING.md#per-runtime-patterns).

---

## The cold-start budget

A Workers isolate cold-start is ~5 ms once the bundle is loaded.
Loading the bundle scales with size — 1-10 ms typically. forge's
import is on the cheaper end: schema definitions are pure data, the
runtime is a few hundred lines per adapter.

Cold-start budget allocation:

| Phase | Typical cost | Notes |
|---|---|---|
| Isolate boot | 1-5 ms | Cloudflare's; out of your hands |
| Bundle parse | 1-10 ms | proportional to bundle size |
| forge `createDb` | <1 ms | pure schema processing, no I/O |
| Driver construction | <1 ms | for HTTP transports |
| First query | 5-50 ms | depends on database region distance |

Common bloat sources:

* **Importing adapters you don't use.** Import from
  `'forge-orm/adapters/*'` directly — bundler tree-shaking misses
  some forge surface (doctor, event subscribers) when importing from
  the root.
* **Pulling in `pg` for Hyperdrive.** Use `@neondatabase/serverless`
  — smaller, works without `nodejs_compat` polyfills.
* **Bringing the whole `mongodb` package.** It doesn't run on
  Workers; remove from the bundle, use the Atlas shim.
* **Top-level `await` that hits the network.** Build `db` inside
  the handler instead.

If you're seeing 200 ms cold-starts, it's the bundle. Run `wrangler
deploy --dry-run --outdir dist/` and look. forge alone is comfortably
under 100 KB minified.

---

## Wrangler config

Minimum viable `wrangler.toml` for a forge-on-Workers project:

```toml
name = "my-api"
main = "src/worker.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

# D1 binding
[[d1_databases]]
binding = "DB"
database_name = "myapp"
database_id = "00000000-0000-0000-0000-000000000000"

# Hyperdrive binding
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "00000000000000000000000000000000"

# Plain env vars (use wrangler secret for secrets)
[vars]
LOG_LEVEL = "info"

# Place close to the database where possible
[placement]
mode = "smart"
```

What each flag costs you to skip:

* **`compatibility_flags = ["nodejs_compat"]`** — required for
  `@neondatabase/serverless` (it imports a few Node shims),
  `@planetscale/database` (uses `crypto.randomUUID` polyfill), and
  most HTTP transports that expect Node-shaped streams. D1 alone
  doesn't need it.
* **`compatibility_date`** — pinning recent fixes runtime behaviour
  changes. Older dates may strand you on older `nodejs_compat`
  semantics; pick a date within the last 6 months unless you know why
  you need older.
* **`placement = "smart"`** — Cloudflare's runtime decides whether to
  run the Worker at the edge (closest to user) or at the origin
  (closest to the database) based on observed latency. For
  database-heavy Workers, `smart` placement often beats vanilla edge
  by 20-50 ms.

Secrets via `wrangler secret put TURSO_TOKEN` — never inline in
`wrangler.toml`. They appear at `env.TURSO_TOKEN` at runtime.

---

## Edge-vs-region — where the database actually lives

The seductive idea: code runs at the edge, microseconds from the
user. The boring reality: your database lives in one region, and
that region is rarely the user's.

| Scenario | Round-trip |
|---|---|
| Worker reads D1, same region (replica hit) | 1-5 ms |
| Worker reads D1 primary, cross-continent | 30-100 ms |
| Worker reads Hyperdrive, same region as Postgres | 5-15 ms |
| Worker reads Hyperdrive, different region | 50-200 ms |
| Worker reads Neon HTTP, same region | 10-30 ms |
| Worker reads Neon HTTP, different region | 100-300 ms |
| Worker reads Atlas Data API | 30-200 ms |

A Worker handler that makes 5 sequential queries against a remote
Postgres pays 5 × RTT before any computation runs. Three patterns
that work:

1. **Move the database closer to the user.** D1 is built for this
   (per-region replicas). Turso similarly. For Postgres, Neon's
   `read-replica` URLs route reads to the nearest replica.
2. **Move the Worker closer to the database.** `placement = "smart"`
   in `wrangler.toml`. Cloudflare runs the Worker near the database
   when latency-sensitive — the cost goes from "edge to user times N
   queries" to "edge to database once."
3. **Cache aggressively.** Workers Cache API, KV reads (5-10 ms),
   Hyperdrive's built-in query cache. The cheapest query is the one
   you didn't run.

---

## KV, R2, D1 — Workers-native storage alongside forge

Workers ships four storage products. They cover different shapes than
forge does, and the right architecture often layers them:

| Product | Shape | Latency | When to layer with forge |
|---|---|---|---|
| **KV** | Eventually-consistent key-value | 1-10 ms read, ~60 s write propagation | Hot read cache for forge query results, session blobs, feature flags |
| **R2** | S3-compatible blob storage | 5-50 ms | Media uploads, exported reports, BLOB columns |
| **D1** | SQLite | 1-100 ms | Primary store for small-medium apps; replica for larger ones |
| **Durable Objects** | Strongly-consistent single-writer compute + storage | 5-20 ms | Per-user session state, real-time game state, atomic counters |

Pattern that shows up often: forge + Postgres (via Hyperdrive) as the
system of record, KV as a read-through cache for forge query results,
R2 for blob columns extracted out of relational rows. Cache
invalidation is your problem — forge's event subscribers
([EVENTS.md](./EVENTS.md)) let you hook every mutation and delete the
matching KV key from the same handler that ran the write.

---

## Vercel Edge runtime — the small differences

Vercel Edge is the same Cloudflare-style isolate runtime. The
constraints are identical: no TCP, no filesystem, no persistent
globals. Differences worth knowing:

* **No Hyperdrive equivalent.** Vercel doesn't ship a first-party
  pooler. The recommended path is Neon's HTTP transport, Supabase's
  pgBouncer URL, or PlanetScale's HTTP MySQL.
* **No D1 equivalent.** Vercel Postgres (now Neon under the hood) is
  the closest, but it's HTTP-fronted Postgres, not embedded SQLite.
  If you want SQLite-on-Edge with Vercel, use Turso.
* **`export const runtime = 'edge'`.** This single line in a Next.js
  route or middleware file flips the runtime. The same forge code
  works in either, but only HTTP-capable drivers work under Edge.
* **Vercel Functions (Node runtime) is *not* this.** They run on
  warm Lambda-style containers. Module-scope `new Pool()` is correct
  there. See
  [POOLING.md → Vercel Edge / Vercel Functions](./POOLING.md#vercel-edge--vercel-functions)
  for the difference.

Worked example D below uses Vercel Edge + Neon HTTP — the canonical
setup.

---

## Caching at the edge

Three layers of edge-native cache:

* **Workers Cache API** — `caches.default.match(req)`/`.put(req, resp)`.
  Cloudflare's edge cache. Unit of caching is a `Response`, so you
  cache the handler output, not the database row.
* **KV** — manual key-value cache your handler controls.
* **Hyperdrive query caching** — Cloudflare-side, per-query.
  Configure in the dashboard. Best for high-hit-ratio reads you
  can't rewrite at the application level.

The Cache API recipe:

```ts
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method !== 'GET') return handle(req, env, ctx);
    const cache = caches.default;
    const cached = await cache.match(req);
    if (cached) return cached;
    const resp = await handle(req, env, ctx);
    if (resp.ok) ctx.waitUntil(cache.put(req, resp.clone()));
    return resp;
  },
};
```

Pair with `Cache-Control` on the response — Cloudflare honours
`max-age` and `s-maxage`. Cache invalidation on mutation: subscribe to
forge events and purge from the handler that ran the write. See
[EVENTS.md](./EVENTS.md) for the event shape.

---

## Observability — logs, tail, OTel

* **`console.log`** — captured by Cloudflare. Available via `wrangler
  tail` or the dashboard's logs view. Subject to rate limits; high
  cardinality gets sampled.
* **`wrangler tail <worker-name>`** — streams logs. Filter with
  `--status=error`.
* **Tail Workers** — a Worker that receives logs from another Worker.
  Use for forwarding to Datadog, Logflare, etc. without rate limits.
* **OpenTelemetry** — `@cloudflare/workers-otel` publishes spans to a
  collector. forge's `db.$events` lets you emit a span per query — see
  [TRACING.md](./TRACING.md).
* **Analytics Engine** — append-only metrics store. Cheap, sampled,
  query with SQL. Good for forge query duration histograms.

A reasonable observability hook:

```ts
db.$events.on('query', (e) => {
  if (Math.random() < 0.01) console.log(JSON.stringify({ sql: e.sql, ms: e.durationMs, rows: e.rowCount }));
  env.METRICS.writeDataPoint({
    blobs: [e.model ?? 'raw'],
    doubles: [e.durationMs],
    indexes: [e.semanticOp ?? 'unknown'],
  });
});
```

See [METRICS.md](./METRICS.md) for the event shape.

---

## Migrations from a Worker handler — don't

`forge push` and `db.$migrate()` work against most edge-capable
drivers. But running migrations from a request handler means:

* Cold isolates race to apply the same migration. Without an external
  lock you get partial states and broken indexes.
* Migrations exceed the CPU budget for non-trivial schemas. The
  Worker times out mid-DDL.
* You can't roll back from a handler. The Worker is gone before you
  notice the problem.

The right shape:

* **Run migrations from CI.** A Node script that imports forge,
  applies the migration, exits. Separate pipeline step before deploy.
* **D1 has its own migrate flow.** `wrangler d1 migrations apply` is
  the canonical path; forge emits the SQL via `forge push --dry-run`
  and you commit the file.
* **Hyperdrive doesn't accept DDL specially.** Apply migrations
  against the origin Postgres from CI, with the unpooled connection
  string. Keeps the Worker bundle smaller too.

Exception: `db.$migrate({ alter: false })` against D1 as a read-only
drift probe at handler startup is safe. Anything mutating belongs in
CI. See [MIGRATIONS.md](./MIGRATIONS.md) for the wider story.

---

## Worked example A — Worker + D1

The minimum forge-on-Workers project: D1 binding, a `user` model,
GET + POST routes.

```toml
# wrangler.toml
name = "users-api"
main = "src/worker.ts"
compatibility_date = "2025-01-01"

[[d1_databases]]
binding = "DB"
database_name = "users"
database_id = "<your-d1-id>"
```

```ts
// src/schema.ts
import { f, model } from 'forge-orm';

export const User = model('users', {
  id: f.id(),
  email: f.string().unique(),
  name: f.string(),
  createdAt: f.datetime().now(),
});
export const schema = { user: User };
```

```ts
// src/worker.ts
import { createDb } from 'forge-orm';
import { schema } from './schema';
import { d1Driver } from './driver'; // the eight-line wrapper above

export interface Env { DB: D1Database }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const db = await createDb({ schema, driver: d1Driver(env.DB) });
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/users') {
      return Response.json(await db.user.findMany({ take: 50 }));
    }
    if (req.method === 'POST' && url.pathname === '/users') {
      const user = await db.user.create({ data: await req.json() });
      return Response.json(user, { status: 201 });
    }
    return new Response('not found', { status: 404 });
  },
};
```

Migrations live in `migrations/0001_init.sql`, applied via `wrangler
d1 migrations apply users`. forge emits the SQL via `forge push
--dry-run --driver d1`.

---

## Worked example B — Worker + Postgres via Hyperdrive

Hyperdrive-fronted Postgres, shared schema, event-driven KV cache
invalidation, per-request driver.

```toml
# wrangler.toml
name = "orders-api"
main = "src/worker.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<hyperdrive-id>"

[[kv_namespaces]]
binding = "CACHE"
id = "<kv-namespace-id>"

[placement]
mode = "smart"
```

```ts
// src/worker.ts
import { Pool } from '@neondatabase/serverless';
import { createDb, pgDriver } from 'forge-orm';
import { schema } from './schema';

export interface Env { HYPERDRIVE: Hyperdrive; CACHE: KVNamespace }

async function withDb<T>(env: Env, fn: (db: any) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
  const db = await createDb({ schema, driver: pgDriver(pool) });
  db.$events.on('mutation', async (e: any) => {
    if (e.model === 'order') await env.CACHE.delete(`order:${e.id}`);
  });
  try { return await fn(db); } finally { await db.$disconnect(); }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const match = url.pathname.match(/^\/orders\/([^/]+)$/);
    if (req.method === 'GET' && match) {
      const id = match[1];
      const cached = await env.CACHE.get(`order:${id}`, 'json');
      if (cached) return Response.json(cached, { headers: { 'x-cache': 'hit' } });
      return withDb(env, async (db) => {
        const order = await db.order.findUnique({ where: { id } });
        if (!order) return new Response('not found', { status: 404 });
        ctx.waitUntil(env.CACHE.put(`order:${id}`, JSON.stringify(order), { expirationTtl: 300 }));
        return Response.json(order, { headers: { 'x-cache': 'miss' } });
      });
    }
    if (req.method === 'POST' && url.pathname === '/orders') {
      return withDb(env, async (db) =>
        Response.json(await db.order.create({ data: await req.json() }), { status: 201 }),
      );
    }
    return new Response('not found', { status: 404 });
  },
};
```

The `withDb` helper centralises driver construction, event-handler
wiring, and disconnect. Each request creates its own driver — that's
the Workers cost; Hyperdrive eats the actual handshake.

---

## Worked example C — Worker + Turso

Multi-region SQLite via libsql HTTP, replica URL for reads, primary
URL for writes.

```ts
// src/worker.ts
import { createClient } from '@libsql/client';
import { createDb, libsqlDriver } from 'forge-orm';
import { schema } from './schema';

export interface Env {
  TURSO_PRIMARY_URL: string;     // https://<db>-<org>.turso.io
  TURSO_REPLICA_URL: string;     // https://<db>-<org>-iad.turso.io
  TURSO_TOKEN: string;
}

function makeDb(env: Env, mode: 'read' | 'write') {
  const url = mode === 'read' ? env.TURSO_REPLICA_URL : env.TURSO_PRIMARY_URL;
  return createDb({
    schema,
    driver: libsqlDriver(createClient({ url, authToken: env.TURSO_TOKEN })),
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/posts') {
      const db = await makeDb(env, 'read');
      try { return Response.json(await db.post.findMany({ take: 20 })); }
      finally { await db.$disconnect(); }
    }
    if (req.method === 'POST' && url.pathname === '/posts') {
      const db = await makeDb(env, 'write');
      try {
        const post = await db.post.create({ data: await req.json() });
        return Response.json(post, { status: 201 });
      } finally { await db.$disconnect(); }
    }
    return new Response('not found', { status: 404 });
  },
};
```

The replica URL points at a libsql replica colocated with the
expected Worker region. Writes always hit the primary. The read/write
split lets the read path skip the primary round-trip entirely when
the primary is far from read-heavy traffic.

---

## Worked example D — Vercel Edge + Neon HTTP

Next.js App Router route handler, Edge runtime, Neon HTTP transport.
The forge surface is the same as Workers; the only differences are
the runtime export and the absence of Cloudflare bindings.

```ts
// app/api/users/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';
import { createDb, pgDriver } from 'forge-orm';
import { schema } from '@/lib/schema';

export const runtime = 'edge';

function makeDb() {
  const sql = neon(process.env.DATABASE_URL!);
  const driver = pgDriver({
    query: async (text: string, params: any[]) => {
      const rows = await sql(text, params ?? []);
      return { rows, rowCount: rows.length };
    },
    end: async () => {},
  } as any);
  return createDb({ schema, driver });
}

export async function GET() {
  const db = await makeDb();
  try { return NextResponse.json(await db.user.findMany({ take: 50 })); }
  finally { await db.$disconnect(); }
}

export async function POST(req: NextRequest) {
  const db = await makeDb();
  try {
    return NextResponse.json(await db.user.create({ data: await req.json() }), { status: 201 });
  } finally { await db.$disconnect(); }
}
```

Notes:

* `DATABASE_URL` is the Neon pooled URL (ending in `-pooler`). The
  unpooled URL is for migrations and one-off scripts only.
* `runtime = 'edge'` is the magic line. Without it, Next.js runs the
  handler on Node — where `pg.Pool` works directly, module-scope
  pooling is correct, and Hyperdrive isn't an option.
* Vercel's `region` config pins the Edge function to specific
  regions. Default is multi-region, optimising for user latency over
  database latency.

---

## Common failures

**`Error: connect ECONNREFUSED 10.0.0.1:5432`** — you're using
stock `pg` and trying to dial TCP from a Worker. Switch to
`@neondatabase/serverless` or use Hyperdrive.

**`Error: No such module "node:net"`** — you're using a library that
imports `node:net` and `nodejs_compat` is off. Either enable the flag
or pick a library that doesn't need it.

**`Error: This operation cannot be applied across multiple databases`**
— D1 binding limitation. forge doesn't issue cross-database queries
unless you wired it to; check that you're not constructing two
`createDb` calls against different D1 bindings inside one transaction.

**Cold-start spikes to >500 ms intermittently** — bundle size. Run
`wrangler deploy --dry-run --outdir dist/` and look at the size.
Common bloat sources: `mongodb`, `mysql2`, `pg-native`, `aws-sdk`.

**Hyperdrive returns `Error: too many connections`** — the
Hyperdrive pool size against your origin is sized too small for your
Worker concurrency. Raise it in the dashboard, or raise
`max_connections` on your origin Postgres.

**Atlas Data API returns 401 intermittently** — API keys are
per-request authenticated; if you cache the response of a request that
included a stale key, you'll see this only on cache-miss. Cache misses
of auth-failed responses is a common hidden bug.

**`db.$watch` returns no updates** — most edge drivers don't expose
LISTEN/NOTIFY (or change streams) because the request lifetime is too
short to hold a subscription. Use polling (forge's watch is poll-based
by default) or push notifications via a separate mechanism (Durable
Objects, Pub/Sub).

**Queries time out at 30 s exactly** — Workers Paid plan CPU limit.
If a query takes that long, you're past the budget. Split, paginate,
or move it to a non-edge worker (Queue consumer, scheduled function).

---

## Cross-references

* [BACKEND.md](./BACKEND.md) — framework wiring, request lifecycle,
  the long-running-server patterns this doc is the edge-counterpart of
* [POOLING.md](./POOLING.md) — per-runtime pool sizing, including
  Workers + Hyperdrive and Vercel Edge / Vercel Functions
* [SQLITE.md](./SQLITE.md) — SQLite features, D1 caveats, libsql/Turso
  notes
* [POSTGRES.md](./POSTGRES.md) — Postgres tuning, `max_connections`,
  Hyperdrive origin sizing
* [DRIVERS.md](./DRIVERS.md) — driver port shapes, edge-runtime driver
  matrix, the six worked wrappers (Neon HTTP, Turso, D1, Atlas Data API,
  Bun, decorator)
* [LAMBDA.md](./LAMBDA.md) — AWS Lambda + RDS Proxy, the
  serverless-on-Node counterpart to this doc
* [BROWSER.md](./BROWSER.md) — sqlite-wasm + OPFS for the browser,
  different runtime, similar isolate-style constraints
* [MIGRATIONS.md](./MIGRATIONS.md) — schema rollouts; the right place
  to run them is *not* from a Worker handler
* [METRICS.md](./METRICS.md) — observability hooks, the forge event
  shape used in the Analytics Engine recipe above
* [EVENTS.md](./EVENTS.md) — mutation/query events used for cache
  invalidation
* [CACHING.md](./CACHING.md) — query-result caching strategies
  applicable above forge
