# Events and QueryEvent

forge-orm emits a structured `QueryEvent` on every query. Subscribing to these is how you wire forge into pino, Sentry, OpenTelemetry, Prometheus, or any custom observability stack — without modifying application code.

This doc is a companion to [BACKEND.md](BACKEND.md#observability), which shows
the bare minimum. Here we cover the full event surface — every field, every
`semanticOp`, the subscription contract, the cost model, sampling strategies,
and worked sinks for the major logging, tracing, and metrics platforms.

---

## Contents

- [Why events](#why-events)
- [The `QueryEvent` shape](#the-queryevent-shape)
- [The `ErrorEvent` shape](#the-errorevent-shape)
- [`semanticOp` taxonomy](#semanticop-taxonomy)
- [Subscription pattern](#subscription-pattern)
- [Multiple subscribers and fan-out](#multiple-subscribers-and-fan-out)
- [Sampling strategies](#sampling-strategies)
- [pino integration](#pino-integration)
- [Winston integration](#winston-integration)
- [Sentry integration](#sentry-integration)
- [OpenTelemetry](#opentelemetry)
- [Prometheus](#prometheus)
- [Custom sinks](#custom-sinks)
- [Error events in detail](#error-events-in-detail)
- [Cost model](#cost-model)
- [Privacy and redaction](#privacy-and-redaction)
- [Worked examples](#worked-examples)

---

## Why events

The forge event surface exists so the ORM never has to know about your
observability stack. The adapter wraps each driver call, times it, and emits a
single object. Whatever you do with that object — log it, span it, count it,
ignore it — is your decision and lives in your code, not in forge's.

Three jobs it is designed to do well:

1. **Drop-in observability.** Wire pino, OTel, Sentry, or Prometheus on day
   one without rewriting repositories. The subscription site is one line at
   boot; every query already running flows through it.
2. **Perf profiling.** `duration_ms` is the dispatch-to-result wall clock, not
   driver-internal time. Slow-query logs and p99 histograms work without an
   APM agent.
3. **Audit and replay.** `model` + `op` + `semanticOp` lets you reconstruct
   what was attempted at the schema level, not just the compiled SQL. An
   audit log built from these events survives a SQL rewrite that a
   text-based audit log would not.

Events are after-the-fact. The query has already resolved (or thrown) by the
time the listener runs. Subscribers cannot rewrite, block, or cancel a query.
That's intentional — it keeps the hot path identical whether or not anything
is subscribed.

---

## The `QueryEvent` shape

Defined in [`src/events.ts`](../src/events.ts). Every field is present on every
event (no optionals except `semanticOp`).

```ts
export interface QueryEvent {
  adapter: 'mongo' | 'postgres' | 'mysql' | 'sqlite';
  model: string;
  op: string;
  semanticOp?: 'softDelete' | 'softDeleteMany' | 'restore' | 'restoreMany';
  sql: string;
  params: unknown[] | Record<string, unknown>;
  duration_ms: number;
  rowCount: number;
  startedAt: Date;
}
```

Field by field:

- **`adapter`** — the dialect that ran the query. Reported as `'sqlite'` for
  DuckDB and `'mongo'` for the Mongo wire — the adapter identifies the
  family, not the specific driver. (DuckDB and MSSQL are reported under their
  family for backwards compatibility with the published type union; future
  versions may widen the union.)
- **`model`** — the schema key (`'user'`, `'order'`, …) of the model the
  query targets. Empty string `''` for raw SQL (`$queryRaw` / `$executeRaw`)
  and `$runCommandRaw`.
- **`op`** — the driver-level operation name:
  - SQL adapters: `'select'`, `'count'`, `'groupBy'`, `'insert'`, `'update'`,
    `'delete'`, or `'raw'`.
  - Mongo: the driver verb the wire produces — `'find'`, `'count'`,
    `'insertOne'`, `'findOneAndUpdate'`, `'updateMany'`, `'deleteOne'`, etc.

  Treat `op` as the *physical* op. If you need to distinguish a `softDelete`
  from a plain `update`, branch on `semanticOp`.
- **`semanticOp`** — schema-level intent when the runtime caller was one of
  the higher-level verbs that compiles to a plain `update` or `delete`. Set
  by the collection wrapper for `softDelete`, `softDeleteMany`, `restore`,
  and `restoreMany`. Absent for direct `update` / `updateMany` / `delete` /
  `deleteMany` calls. Introduced in 2.2 — see the [taxonomy section](#semanticop-taxonomy)
  for the full list.
- **`sql`** — SQL text on SQL adapters; a human description like
  `'users.findOne'` on Mongo. Truncate before logging — production statements
  can be kilobytes long.
- **`params`** — parameter array on SQL (positional, in declaration order); a
  Mongo args object (`{ node }`) on Mongo. Treat as opaque — both the
  ordering and the shape may evolve across patch releases.
- **`duration_ms`** — wall-clock milliseconds between dispatch and result.
  Measured with `performance.now()`, so it is sub-millisecond accurate on
  modern Node and browsers. Includes driver-internal time, network RTT, and
  any I/O the adapter does (hydration, decode) — it is the latency the
  caller saw.
- **`rowCount`** — rows returned by the driver, or `-1` if the driver
  doesn't expose a count for that op. `count` queries report `1` (the single
  returned scalar); soft-deletes report the number of matched rows.
- **`startedAt`** — server timestamp at dispatch. A `Date` object, not a
  string. The end timestamp is implicit: `startedAt.getTime() + duration_ms`.

A few common questions the shape answers without you needing to recompile or
re-parse anything:

| Question                                              | How                                               |
|-------------------------------------------------------|---------------------------------------------------|
| Was this a write?                                     | `op === 'insert' \|\| 'update' \|\| 'delete'`     |
| Was it a soft-delete vs a normal update?              | `semanticOp === 'softDelete' \|\| 'softDeleteMany'` |
| Which model was touched?                              | `event.model`                                     |
| Did anything come back?                               | `rowCount >= 1`                                   |
| How long did the caller wait?                         | `duration_ms`                                     |

---

## The `ErrorEvent` shape

When a query throws, forge emits an `ErrorEvent` instead of a `QueryEvent`:

```ts
export interface ErrorEvent {
  adapter: 'mongo' | 'postgres' | 'mysql' | 'sqlite';
  model: string;
  op: string;
  sql: string;
  params: unknown[] | Record<string, unknown>;
  error: Error;
  duration_ms: number;
}
```

It is the same as `QueryEvent` minus `rowCount`, `startedAt`, and `semanticOp`,
plus a real `Error` object. The `error` is the underlying driver error,
optionally wrapped by forge's typed error layer — see [ERRORS.md](ERRORS.md)
for the taxonomy and how to branch on it.

Errors fire on the same channel as queries from the adapter's perspective —
the timer starts, the driver throws, the emitter dispatches one event. A
single query either fires `'query'` or `'error'`, never both.

---

## `semanticOp` taxonomy

`semanticOp` is the answer to "what verb did the caller actually invoke",
above the level of the compiled statement. It exists because some
schema-level operations compile to physically identical SQL — a soft-delete
and a `set deleted_at = now()` produce the same `UPDATE`, but the audit log
should distinguish them.

The full taxonomy in 2.5.x:

| `semanticOp`       | Caller                            | Underlying `op`  | Notes                                                |
|--------------------|-----------------------------------|------------------|------------------------------------------------------|
| `softDelete`       | `model.softDelete({ where })`     | `update`         | Sets the `.softDeleteAt()` field to `now()`          |
| `softDeleteMany`   | `model.softDeleteMany({ where })` | `update`         | Bulk soft-delete                                     |
| `restore`          | `model.restore({ where })`        | `update`         | Clears `.softDeleteAt()`                             |
| `restoreMany`      | `model.restoreMany({ where })`    | `update`         | Bulk restore                                         |

When `semanticOp` is absent:

- A direct `model.update()` or `model.updateMany()` — physical update, no
  schema-level rename.
- `create`, `createMany`, `upsert`, `delete`, `deleteMany`, `findFirst`,
  `findMany`, `count`, `groupBy`, `aggregate`, `$queryRaw`, `$executeRaw`,
  `$runCommandRaw` — these all map 1:1 to a physical op and don't need a
  semantic tag.

Forward compatibility: the taxonomy is open-ended. New tags may appear in
future minors (e.g. a future `archive` verb). Always switch with a
fall-through:

```ts
db.$on('query', (e) => {
  switch (e.semanticOp) {
    case 'softDelete':
    case 'softDeleteMany':
      audit.write('soft_delete', e);
      break;
    case 'restore':
    case 'restoreMany':
      audit.write('restore', e);
      break;
    default:
      // No semantic tag — fall back to op.
      if (e.op === 'insert') audit.write('create', e);
  }
});
```

---

## Subscription pattern

`db.$on(event, cb)` registers a listener and returns an unsubscribe function:

```ts
const off = db.$on('query', (e) => { /* ... */ });
// ...later
off();   // detach
```

The same shape works for errors:

```ts
const offErr = db.$on('error', (e) => {
  log.error({ op: e.op, model: e.model, err: e.error.message }, 'query_error');
});
```

There is also a non-returning `$off` for the rare case you want to remove a
listener by reference instead of by handle:

```ts
const listener = (e: QueryEvent) => { /* ... */ };
db.$on('query', listener);
db.$off('query', listener);
```

Most code should use the `off` handle returned from `$on` — it survives
listener wrapping (decorators, sampling shims) where `$off` does not.

Wire listeners **before** any query runs. Subscribers attached after a query
has already started will not see that query — there is no replay buffer.
Doing the wiring in module-init right after `createDb` is the safe pattern:

```ts
export const db = await createDb({ url, schema });

if (process.env.NODE_ENV !== 'test') {
  wireOtel(db, { tracer });
  wirePino(db, log);
  wirePrometheus(db, registry);
}
```

Listener errors are swallowed. The emitter calls each listener in a
try/catch — a throwing subscriber will not break the query, will not surface
to the caller, and will not stop later subscribers. This is deliberate, but
it means you cannot detect a broken subscriber by the next query failing.
Add a try/catch + log inside listeners that do anything non-trivial.

---

## Multiple subscribers and fan-out

There is no listener cap. Every `$on('query', …)` adds a slot in the
emitter's array; events fan out to each slot in registration order:

```ts
db.$on('query', metricsSink);     // 1. Prometheus counters
db.$on('query', otelSink);        // 2. OTel spans
db.$on('query', auditSink);       // 3. Audit log
db.$on('query', slowQuerySink);   // 4. pino slow-query log
```

Each listener runs to completion (or throws and gets swallowed) before the
next one starts. Fan-out is **sequential, not parallel**. If your sink calls
a remote service, that latency accumulates — see [cost model](#cost-model).

Subscribers can be `async` or sync:

```ts
type EventListener<E> = (event: E) => void | Promise<void>;
```

The emitter does `void l(e)` — it kicks off the promise and moves on. It
does **not** `await`. That means:

- A subscriber's awaited work runs concurrently with the next subscriber and
  the next query. Order between subscribers is preserved on the synchronous
  prefix only.
- An unhandled rejection inside an async subscriber will surface as a
  Node `unhandledRejection` event. Wrap async work in `try/catch` if your
  process treats unhandled rejections as fatal (the default since Node 15).

A safe async sink looks like this:

```ts
db.$on('query', async (e) => {
  try {
    await fetch(METRICS_URL, { method: 'POST', body: JSON.stringify(e) });
  } catch {
    /* never propagate — observability must not break the app */
  }
});
```

---

## Sampling strategies

Forge has no built-in sampler — events are cheap when nothing is wired, and
once you're wired, the choice of what to keep is yours. Three patterns cover
99% of needs.

**Head-based sampling.** Decide before doing any work:

```ts
const SAMPLE_RATE = 0.01;  // 1% of queries

db.$on('query', (e) => {
  if (Math.random() >= SAMPLE_RATE) return;
  log.info({ ev: e }, 'sampled_query');
});
```

Use this when the sink is expensive and you only want a representative slice
(general-purpose APM, tracing).

**Tail-based sampling — slow queries only.** Decide based on the event:

```ts
const SLOW_MS = 100;

db.$on('query', (e) => {
  if (e.duration_ms < SLOW_MS) return;
  log.warn({ ev: e }, 'slow_query');
});
```

Use this for slow-query logs, perf alerts, and triage workflows.

**Tail-based sampling — errors and writes only.** Decide based on shape:

```ts
db.$on('query', (e) => {
  if (e.op !== 'insert' && e.op !== 'update' && e.op !== 'delete') return;
  audit.write(e);
});
```

Use this for audit logs and write-only mirroring.

Combine them where useful:

```ts
db.$on('query', (e) => {
  const isWrite = e.op === 'insert' || e.op === 'update' || e.op === 'delete';
  const isSlow = e.duration_ms >= 100;
  if (!isWrite && !isSlow && Math.random() >= 0.001) return;  // 0.1% otherwise
  sink(e);
});
```

For OTel specifically, prefer OTel's own sampler over a head-based filter
inside the listener — the OTel SDK propagates the sampling decision through
the trace context so child spans match the root.

---

## pino integration

[pino](https://github.com/pinojs/pino) is the canonical JSON logger for Node.
The `$on('query')` event drops in directly because the event object is
already a flat structured payload.

```ts
import pino from 'pino';
import { db } from './db';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['ev.params', 'ev.sql'],   // omit raw values + statements
    censor: '[REDACTED]',
  },
});

db.$on('query', (e) => {
  log.info({ ev: e }, 'q');
});

db.$on('error', (e) => {
  log.error({
    ev: {
      adapter: e.adapter, model: e.model, op: e.op,
      duration_ms: e.duration_ms,
    },
    err: { message: e.error.message, name: e.error.name },
  }, 'query_error');
});
```

A more selective slow-query variant — quieter in steady state, loud when
something gets out of band:

```ts
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
```

Pair with pino's redaction for params that might contain PII — see
[Privacy and redaction](#privacy-and-redaction).

---

## Winston integration

Same shape, different transport. Winston's structured-logging API takes a
metadata object as the second argument:

```ts
import winston from 'winston';
import { db } from './db';

const log = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [new winston.transports.Console()],
});

db.$on('query', (e) => {
  log.info('q', {
    adapter: e.adapter,
    model: e.model,
    op: e.op,
    semanticOp: e.semanticOp,
    duration_ms: e.duration_ms,
    rowCount: e.rowCount,
  });
});

db.$on('error', (e) => {
  log.error('query_error', {
    adapter: e.adapter,
    model: e.model,
    op: e.op,
    duration_ms: e.duration_ms,
    err: e.error.message,
    stack: e.error.stack,
  });
});
```

Winston's transports are richer than pino's but synchronously slower —
prefer pino when you're CPU-bound on logging.

---

## Sentry integration

Sentry's transaction API and breadcrumb API both fit the event shape. Use
transactions for slow queries (they show up in performance) and breadcrumbs
for errors (they accompany whatever exception the request handler raises).

```ts
import * as Sentry from '@sentry/node';
import { db } from './db';

Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });

const SLOW_MS = 250;

db.$on('query', (e) => {
  if (e.duration_ms < SLOW_MS) return;
  // Surface slow queries as a synthetic transaction so they show up in the
  // performance dashboard with the same trace correlation as the HTTP req.
  const tx = Sentry.startInactiveSpan({
    name: `forge.${e.semanticOp ?? e.op}`,
    op: 'db.query',
    attributes: {
      'db.system': e.adapter,
      'db.collection.name': e.model,
      'db.operation': e.op,
      'forge.duration_ms': e.duration_ms,
      'forge.row_count': e.rowCount,
    },
    startTime: e.startedAt,
  });
  tx.end(new Date(e.startedAt.getTime() + e.duration_ms));
});

db.$on('error', (e) => {
  Sentry.addBreadcrumb({
    category: 'db',
    message: `${e.adapter}.${e.op} on ${e.model || '<raw>'}`,
    level: 'error',
    data: {
      duration_ms: e.duration_ms,
      sql: typeof e.sql === 'string' ? e.sql.slice(0, 300) : undefined,
    },
  });
  Sentry.captureException(e.error, {
    tags: { adapter: e.adapter, model: e.model, op: e.op },
  });
});
```

If you already have OTel wired to Sentry's OTel bridge, skip the
transaction emit here — `wireOtel` will already produce spans Sentry
ingests.

---

## OpenTelemetry

forge ships a built-in OTel helper: `wireOtel(db, opts)`. It subscribes to
both `'query'` and `'error'` events and emits one span per query named
`forge.<op>` (or `forge.<semanticOp>` when one is present), with OTel db
semantic-convention attributes:

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
  recordStatement: process.env.NODE_ENV !== 'production',
  maxStatementLen: 512,
});

process.on('SIGTERM', async () => { offOtel(); await sdk.shutdown(); });
```

Attributes emitted per span:

| Attribute               | Value                                          |
|-------------------------|------------------------------------------------|
| `db.system`             | `'postgresql'`, `'mysql'`, `'sqlite'`, `'mongodb'` |
| `db.operation`          | `e.op`                                         |
| `db.collection.name`    | `e.model` (omitted if empty)                   |
| `db.statement`          | `e.sql` truncated to `maxStatementLen` (when `recordStatement !== false`) |
| `forge.adapter`         | `e.adapter`                                    |
| `forge.model`           | `e.model`                                      |
| `forge.row_count`       | `e.rowCount`                                   |
| `forge.duration_ms`     | `e.duration_ms`                                |
| `forge.semantic_op`     | `e.semanticOp` (only when set)                 |

Options:

- `tracer` — anything with `startSpan(name, options)`. Structurally typed so
  `@opentelemetry/api` does not need to be a forge peer dep.
- `dbSystem` — override the auto-derived `db.system`. Useful when running
  PgBouncer or CockroachDB and you want a custom value.
- `recordStatement` — when `false`, omit `db.statement`. Many compliance
  regimes disallow raw SQL in traces; flip this off in production.
- `maxStatementLen` — truncation length for `db.statement`. Default 1024.

`wireOtel` returns an `off` function that unsubscribes both query and error
listeners — call it during graceful shutdown.

Trace context propagation: `wireOtel` does not start the span inside the
ORM call site, so the parent context comes from whatever the
caller has on the OTel context stack. Wrap your request handler in a
`trace.with(ctx, …)` block to make forge spans children of the HTTP span.
For deeper context propagation across job queues, see [TRACING.md](TRACING.md).

---

## Prometheus

Convert events to counters and histograms with `prom-client`:

```ts
import client from 'prom-client';
import { db } from './db';

const queryDuration = new client.Histogram({
  name: 'forge_query_duration_ms',
  help: 'forge query duration in milliseconds',
  labelNames: ['adapter', 'model', 'op'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
});

const queryTotal = new client.Counter({
  name: 'forge_query_total',
  help: 'forge query count',
  labelNames: ['adapter', 'model', 'op', 'semantic_op'],
});

const queryErrors = new client.Counter({
  name: 'forge_query_errors_total',
  help: 'forge query error count',
  labelNames: ['adapter', 'model', 'op'],
});

db.$on('query', (e) => {
  queryDuration.observe({ adapter: e.adapter, model: e.model, op: e.op }, e.duration_ms);
  queryTotal.inc({
    adapter: e.adapter,
    model: e.model,
    op: e.op,
    semantic_op: e.semanticOp ?? '',
  });
});

db.$on('error', (e) => {
  queryErrors.inc({ adapter: e.adapter, model: e.model, op: e.op });
});
```

Two production gotchas:

- **Label cardinality.** `model` is bounded by the number of models in your
  schema; `op` is bounded by the taxonomy above. Both are safe. Do **not**
  add `sql` or any per-row identifier as a label — Prometheus will OOM.
- **Histogram buckets.** The default `prom-client` buckets are tuned for
  HTTP latency in seconds. For DB queries in milliseconds, override as
  above. Keep the bucket count under ~12 to avoid blowing up the
  per-series memory.

A deeper recipe with quantiles, p99 alerting, and Grafana dashboards lives
in [METRICS.md](METRICS.md).

---

## Custom sinks

The event object is JSON-safe (after stringifying the `Error` on
`ErrorEvent`), so any sink that takes structured events works.

**ClickHouse.** Buffer events in memory; flush in batches:

```ts
import { createClient } from '@clickhouse/client';

const ch = createClient({ url: process.env.CLICKHOUSE_URL });
const buffer: QueryEvent[] = [];
const FLUSH_SIZE = 1000;
const FLUSH_MS = 5_000;

db.$on('query', (e) => {
  buffer.push(e);
  if (buffer.length >= FLUSH_SIZE) void flush();
});

setInterval(() => { if (buffer.length) void flush(); }, FLUSH_MS).unref();

async function flush() {
  const batch = buffer.splice(0, buffer.length);
  await ch.insert({
    table: 'forge_query_events',
    values: batch.map((e) => ({
      adapter: e.adapter,
      model: e.model,
      op: e.op,
      semantic_op: e.semanticOp ?? null,
      duration_ms: e.duration_ms,
      row_count: e.rowCount,
      started_at: e.startedAt,
    })),
    format: 'JSONEachRow',
  });
}
```

**Honeycomb / generic OTLP.** Use `wireOtel` with an OTLP exporter
pointed at Honeycomb's ingest endpoint — Honeycomb is an OTel-native
backend, no custom sink needed.

**DataDog.** DataDog accepts OTLP too; same recipe. For DD-native
integration, use `dd-trace`'s `tracer.startSpan` as the `wireOtel` tracer:

```ts
import tracer from 'dd-trace';
tracer.init();

wireOtel(db, {
  tracer: {
    startSpan: (name, opts) => {
      const span = tracer.startSpan(name);
      if (opts?.attributes) for (const [k, v] of Object.entries(opts.attributes)) span.setTag(k, v);
      return {
        setAttribute: (k, v) => span.setTag(k, v),
        setAttributes: (attrs) => { for (const [k, v] of Object.entries(attrs)) span.setTag(k, v); },
        recordException: (e) => span.setTag('error', e),
        setStatus: (s) => { if (s.code === 2) span.setTag('error', true); },
        end: () => span.finish(),
      };
    },
  },
});
```

The structural tracer shape makes this kind of adapter ~30 lines.

---

## Error events in detail

`'error'` fires when a query throws — at the driver level (connection lost,
deadlock, constraint violation) or inside forge's coerce/decode pipeline
(rare; usually means a schema/data mismatch). The same `op` taxonomy
applies, plus the original `Error` object.

```ts
db.$on('error', (e) => {
  if (e.error.message.includes('duplicate key')) {
    // application-handled unique-violation — don't alert
    return;
  }
  alertOps(e);
});
```

Forge wraps known driver errors with typed subclasses (`ForgeNotFoundError`,
`ForgeUniqueViolationError`, etc.) before they reach `'error'`. Branch with
`instanceof` rather than string matching:

```ts
import { ForgeUniqueViolationError } from 'forge-orm';

db.$on('error', (e) => {
  if (e.error instanceof ForgeUniqueViolationError) return;
  log.error({ ev: e, err: e.error }, 'query_error');
});
```

The complete error taxonomy and how to handle each class lives in
[ERRORS.md](ERRORS.md).

A query that throws fires `'error'` and **not** `'query'`. If you keep
duration histograms over both channels, count the error event too:

```ts
db.$on('query', (e) => queryDuration.observe(labelsFor(e), e.duration_ms));
db.$on('error', (e) => queryDuration.observe(labelsFor(e), e.duration_ms));
```

---

## Cost model

Three numbers to keep in your head:

1. **Zero-listener cost.** When `emitter.hasListeners()` is false, the
   adapter's `_track` short-circuits before compiling SQL for the event. No
   timer is started, no event is allocated. The cost of the event system
   with no subscribers is one boolean check per query.
2. **One-listener cost.** With at least one listener attached:
   - One `performance.now()` at start, one at end.
   - One `Date` constructor for `startedAt`.
   - One small object allocation per event.
   - One function call per subscriber.

   On a 1ms SQLite query in-process, this measures at roughly 10–30µs of
   added overhead total — well below the noise floor of any external DB
   call.
3. **Sequential fan-out cost.** Each subscriber's synchronous work runs to
   completion before the next subscriber starts. If subscriber A does
   `JSON.stringify(e)` and subscriber B sends an HTTP request synchronously,
   subscriber B blocks the listener chain.

   Subscribers should keep the synchronous prefix tiny:

   ```ts
   db.$on('query', (e) => {
     // Sync prefix: just push to a queue.
     metricsQueue.push(e);
   });
   ```

   …with a background flusher draining the queue.

For very high-throughput services, prefer a single multiplexing listener
over many small ones — closing over the sinks once and dispatching inline
saves the per-listener function-call overhead.

```ts
const sinks = [metricsSink, otelSink, auditSink];
db.$on('query', (e) => {
  for (const s of sinks) try { s(e); } catch { /* swallow */ }
});
```

---

## Privacy and redaction

`QueryEvent.params` contains the literal values bound into the query.
`sql` may contain table or column names that hint at the schema.
Neither should leak unredacted into logs or telemetry that crosses a
compliance boundary.

The cheap, default-safe approach:

```ts
db.$on('query', (e) => {
  log.info({
    adapter: e.adapter,
    model: e.model,
    op: e.op,
    semanticOp: e.semanticOp,
    duration_ms: e.duration_ms,
    rowCount: e.rowCount,
    // Note: sql + params deliberately omitted.
  }, 'q');
});
```

When you do want SQL in dev / staging but not prod, gate it on `NODE_ENV`
(as `wireOtel`'s `recordStatement` does internally).

For model-specific PII redaction — e.g. a `users` table with `email` and
`password_hash` columns — redact at the listener:

```ts
const PII_MODELS = new Set(['user', 'paymentMethod', 'session']);

db.$on('query', (e) => {
  const params = PII_MODELS.has(e.model) ? '[REDACTED]' : e.params;
  log.info({ ev: { ...e, params } }, 'q');
});
```

pino's [`redact`](https://github.com/pinojs/pino/blob/main/docs/redaction.md)
configuration is the production-grade tool — set it on the logger once and
it covers every log line.

See [SECURITY.md](SECURITY.md) for the full PII and audit policy.

---

## Worked examples

### Slow-query log to file

```ts
import { createWriteStream } from 'node:fs';
import { db } from './db';

const slow = createWriteStream('/var/log/forge-slow.jsonl', { flags: 'a' });
const SLOW_MS = 100;

db.$on('query', (e) => {
  if (e.duration_ms < SLOW_MS) return;
  slow.write(JSON.stringify({
    t: e.startedAt.toISOString(),
    adapter: e.adapter,
    model: e.model,
    op: e.op,
    semanticOp: e.semanticOp,
    duration_ms: e.duration_ms,
    rowCount: e.rowCount,
    sql: typeof e.sql === 'string' ? e.sql.slice(0, 1000) : e.sql,
  }) + '\n');
});

process.on('SIGTERM', () => slow.end());
```

Rotate with `logrotate` or `pino-roll`. JSON-lines is grep-friendly and
imports straight into any analysis tool.

### Honeycomb-style trace

Honeycomb ingests OTLP, so `wireOtel` does the work:

```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { trace } from '@opentelemetry/api';
import { wireOtel } from 'forge-orm';
import { db } from './db';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: 'https://api.honeycomb.io/v1/traces',
    headers: { 'x-honeycomb-team': process.env.HONEYCOMB_API_KEY! },
  }),
  serviceName: process.env.SERVICE_NAME,
});

await sdk.start();
wireOtel(db, { tracer: trace.getTracer('forge') });
```

Every forge span will arrive at Honeycomb with its `forge.*` and `db.*`
attributes, queryable by `db.collection.name = "user"`,
`forge.semantic_op = "softDelete"`, or `duration_ms > 500`.

### Audit-log all writes

```ts
import { db, scoped } from './db';

db.$on('query', async (e) => {
  const isWrite = e.op === 'insert' || e.op === 'update' || e.op === 'delete';
  if (!isWrite) return;

  // Drop into the same scoped tx if the caller is inside one.
  try {
    await scoped().auditLog.create({
      data: {
        ts: e.startedAt,
        actor: currentActor() ?? null,
        model: e.model,
        op: e.op,
        semanticOp: e.semanticOp ?? null,
        rowCount: e.rowCount,
        duration_ms: e.duration_ms,
      },
    });
  } catch (err) {
    log.error({ err }, 'audit_write_failed');
  }
});
```

Watch the recursion: writing into `auditLog` itself fires another
`'query'` event. Filter it out at the top of the listener:

```ts
if (e.model === 'auditLog') return;
```

Otherwise you'll log every audit row, then every log of every audit row, and
so on.

---

See also: [BACKEND.md](BACKEND.md) for the broader backend integration story,
[LOGGING.md](LOGGING.md) for log shape and rotation, [TRACING.md](TRACING.md)
for cross-service trace propagation, [METRICS.md](METRICS.md) for the
full Prometheus / Grafana dashboard recipe, [ERRORS.md](ERRORS.md) for the
typed error taxonomy, and [SECURITY.md](SECURITY.md) for PII handling
policy.
