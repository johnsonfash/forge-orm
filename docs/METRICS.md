# Metrics

Prometheus-style metrics for forge-orm — latency histograms, error counters, pool gauges, RED/USE dashboards. Built on the [EVENTS.md](EVENTS.md) hook surface. Cardinality discipline is the most important thing on this page.

forge does not ship a metrics package. It ships two events — `query` and
`error` — and a pool whose stats the underlying driver exposes. Wiring those
into `prom-client` (or any OpenMetrics-compatible exporter) is twenty lines of
code, and the choices that matter are which labels you allow, which buckets
you give the histogram, and how you expose the scrape endpoint. Each of those
gets a section below.

The companion docs cover the other two pillars of observability:
[LOGGING.md](LOGGING.md) (text/JSON event stream) and
[TRACING.md](TRACING.md) (per-request spans). Logs answer "what happened on
this request", traces answer "where did the latency come from on this
request", metrics answer "how is the fleet behaving over time". Wire all
three from the same `$on('query')` callback and pay for it once.

---

## Contents

- [Why metrics](#why-metrics)
- [Pick an exporter](#pick-an-exporter)
- [prom-client setup](#prom-client-setup)
- [Metric naming conventions](#metric-naming-conventions)
- [Labels and cardinality](#labels-and-cardinality)
- [Wiring forge events to prom-client](#wiring-forge-events-to-prom-client)
- [Histogram bucket choice](#histogram-bucket-choice)
- [Pool metrics](#pool-metrics)
- [Exposing /metrics](#exposing-metrics)
- [Push gateway for short-lived workloads](#push-gateway-for-short-lived-workloads)
- [Prometheus scrape config](#prometheus-scrape-config)
- [Grafana dashboards](#grafana-dashboards)
- [Alerting rules](#alerting-rules)
- [OpenMetrics format](#openmetrics-format)
- [Multi-process aggregation](#multi-process-aggregation)
- [Cost — sampling and label budgets](#cost--sampling-and-label-budgets)
- [Worked examples](#worked-examples)
- [Related docs](#related-docs)

---

## Why metrics

A single request log line answers "what happened". A trace answers "where did
the time go". Metrics answer the questions logs and traces can't: how is the
fleet behaving over the last hour, the last day, the last release. Three
specific reasons forge installs benefit from a metrics pipeline.

**Aggregate views.** A p99 latency over a million queries cannot be
reconstructed from logs without scanning them all. A histogram records the
distribution once and answers any quantile cheaply at query time. The same
machinery surfaces "queries per second by model", "error rate by op", "pool
saturation by replica" — all in milliseconds, all without touching the
database.

**SLOs and SLIs.** Service level objectives need a numeric indicator over a
time window — "p99 read latency under 50ms over 30 days, 99.9% of the time".
That's a Prometheus query against `histogram_quantile(0.99, …)` over a 30-day
range. Without a histogram you can compute it post-hoc from logs only if you
kept every log line for 30 days, which is expensive and slow.

**Alerting.** A spike in `forge_errors_total` reaches PagerDuty within one
scrape interval; the same signal in a log aggregator is a tail-based search
with minute-scale latency. Pool exhaustion (`forge_pool_in_use` ≥ `max - 1`
for five minutes) is a leading indicator of incident; you want it as a Prom
alert, not a log query someone runs after the page already fired.

The four golden signals — latency, traffic, errors, saturation — are the
default dashboard you want for any forge install. The rest of this doc is how
to wire them with negligible per-query overhead and without blowing up your
Prometheus cardinality budget.

---

## Pick an exporter

Four credible options on Node. All speak OpenMetrics; pick by what the rest of
your platform runs.

- **`prom-client`** — the de-facto Node client. Push or pull. Default
  recommendation for plain Node, hyper-express, Fastify, NestJS.
- **`@opentelemetry/sdk-metrics`** — OTel-native. Use when your traces already
  flow through OTel and you want a single SDK lifecycle. Exposes a
  Prometheus exporter via `@opentelemetry/exporter-prometheus`.
- **`@autotelic/fastify-opentelemetry`** / **`fastify-metrics`** — Fastify
  plugins that wrap `prom-client`. Convenience over control.
- **Datadog / New Relic SDKs** — proprietary protocols. The shape is the
  same; substitute `prom-client.Histogram` for the vendor's distribution
  metric and ship over the vendor's agent.

The rest of this doc uses `prom-client` because the API maps one-to-one onto
`forge`'s event payload, the binary is small, and the OpenMetrics output is
the lingua franca anything else will parse. Translating any recipe to
`@opentelemetry/sdk-metrics` is mechanical — `Histogram.record(value, attrs)`
in OTel reads the same as `histogram.observe(labels, value)` in prom-client.

---

## prom-client setup

`prom-client` ships four metric types and a default registry. Install once at
boot, register your forge metrics, and let the exporter library handle the
scrape format.

```ts
import {
  Counter,
  Histogram,
  Gauge,
  Summary,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

export const registry = new Registry();

// Process-level metrics — CPU, RSS, GC, event-loop lag. Cheap and very useful.
collectDefaultMetrics({ register: registry, prefix: 'node_' });

export const forgeQueryDuration = new Histogram({
  name: 'forge_query_duration_seconds',
  help: 'Duration of forge-orm queries in seconds',
  labelNames: ['adapter', 'model', 'op', 'semantic_op', 'status'],
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const forgeQueryTotal = new Counter({
  name: 'forge_query_total',
  help: 'Total number of forge-orm queries executed',
  labelNames: ['adapter', 'model', 'op', 'semantic_op', 'status'],
  registers: [registry],
});

export const forgeErrorsTotal = new Counter({
  name: 'forge_errors_total',
  help: 'Total number of forge-orm query errors',
  labelNames: ['adapter', 'model', 'op', 'error_class'],
  registers: [registry],
});

export const forgeRowsTotal = new Counter({
  name: 'forge_rows_total',
  help: 'Total rows returned or affected by forge-orm queries',
  labelNames: ['adapter', 'model', 'op'],
  registers: [registry],
});

export const forgePoolInUse = new Gauge({
  name: 'forge_pool_in_use',
  help: 'Connections currently checked out of the pool',
  labelNames: ['adapter', 'role'],
  registers: [registry],
});

export const forgePoolIdle = new Gauge({
  name: 'forge_pool_idle',
  help: 'Connections currently idle in the pool',
  labelNames: ['adapter', 'role'],
  registers: [registry],
});

export const forgePoolWaiting = new Gauge({
  name: 'forge_pool_waiting',
  help: 'Callers waiting for a free pool connection',
  labelNames: ['adapter', 'role'],
  registers: [registry],
});
```

Four metric types and the rules of thumb for each:

- **Counter** — monotonically increasing total. Use for query count, error
  count, rows returned. Never reset in steady state; if you `dec()` one, it's
  the wrong type — use a Gauge.
- **Histogram** — pre-bucketed distribution. Use for latency. Cheap on the
  client; the scrape exposes one time-series per bucket per label
  combination, so cardinality discipline matters double here.
- **Gauge** — point-in-time value. Use for pool stats, queue depth,
  in-flight requests. Set, increment, or decrement freely.
- **Summary** — client-side quantiles. Skip it. Quantiles computed on the
  client cannot be aggregated across processes; Histogram + `histogram_quantile`
  is the right tool. Summary only earns its keep when you cannot afford
  the bucket cost — which forge never hits.

---

## Metric naming conventions

Prometheus's [naming convention](https://prometheus.io/docs/practices/naming/)
is two things — a `<namespace>_<subsystem>_<unit>` prefix and a base-unit
suffix. forge metrics follow it:

- `forge_query_duration_seconds` — Histogram. Base unit is seconds, not
  milliseconds; Prometheus convention insists. `prom-client` accepts seconds
  via `histogram.observe(labels, value)`. Convert from `e.duration_ms / 1000`
  at observation time.
- `forge_query_total` — Counter. The `_total` suffix is mandatory for
  counters under OpenMetrics; without it the exporter relabels at scrape
  time and you get a confusing duplicate metric.
- `forge_errors_total` — Counter. Separate from `forge_query_total` so a
  rate calculation can divide one by the other without a label join.
- `forge_rows_total` — Counter, rows returned or affected. Useful for
  spotting an unintended N+1 (rows shoots up while query count stays flat).
- `forge_pool_in_use` / `forge_pool_idle` / `forge_pool_waiting` — Gauge.
  Three gauges instead of one labelled gauge so a PromQL `sum` over them
  always yields the configured pool size.
- `forge_pool_max` — Gauge, the configured ceiling. Static, but having it
  as a metric makes saturation alerts a self-contained PromQL expression.

Avoid these mistakes:

- `forge_query_duration_ms` — wrong unit suffix. Prometheus operators
  consistently expect seconds; cross-stack dashboards break.
- `forge_query_count` without `_total` — relabelled at scrape, breaks
  recording rules.
- `forgeQueryDuration` — camelCase. Prom-style is snake_case.
- `forge_db_query_duration_seconds` — over-namespaced. `forge` already
  implies "database"; the extra `db_` is noise.

---

## Labels and cardinality

The cardinality of a metric is the product of the cardinalities of its
labels. `forge_query_total{adapter, model, op, semantic_op, status}` with
1 adapter, 50 models, 8 ops, 5 semantic ops (including blank), 2 statuses
is `1 × 50 × 8 × 5 × 2 = 4000` time-series. Add one bad label and you can
multiply by a million.

**Safe labels** (bounded, low cardinality):

- `adapter` — `'postgres' | 'mysql' | 'sqlite' | 'mongo' | 'mssql' | 'duckdb'`.
  Cardinality ≤ 6.
- `model` — the schema model key (`'user'`, `'order'`, …). Bounded by the
  schema, typically tens, rarely hundreds. Acceptable.
- `op` — `'find' | 'findOne' | 'insert' | 'update' | 'delete' | 'count' | 'groupBy' | 'raw'`.
  Cardinality ≤ 10.
- `semantic_op` — `'softDelete' | 'softDeleteMany' | 'restore' | 'restoreMany' | ''`.
  Cardinality 5.
- `status` — `'ok' | 'error'`. Cardinality 2.
- `role` — `'primary' | 'replica'`. Cardinality 2.
- `error_class` — the *class* of error, not the message. Cardinality bounded
  by your error taxonomy. See below.

**Danger labels** (unbounded, never use):

- `user_id`, `tenant_id`, `org_id`, `account_id` — every one of these can
  grow without bound. A small SaaS at 10k tenants × 50 models × 8 ops =
  4M time-series **per metric**. Prometheus will OOM; vendor APMs will bill
  you for the cardinality.
- `request_id` — unique per request by definition. Catastrophic.
- `sql` or `query` — the raw statement text. Every literal makes a new
  series.
- `error_message` — natural-language errors include row ids, timestamps,
  table names from raw SQL. Always unbounded.
- `path` or `route` if it includes route parameters (`/users/:id` is fine;
  the rendered `/users/4f3a…` is not).
- `host` from a request header. Spoofable, unbounded.

**The error_class trick.** Errors carry a useful taxonomy if you bucket them
manually. The two forge error types — `DbKnownError` (unique violation, FK
conflict) and the dialect's native error — both expose a `code`. Map the
codes to a fixed string set at the listener and label by that:

```ts
function classifyError(err: any): string {
  const code = err?.code ?? err?.sqlState ?? err?.errno;
  if (code === '23505' || code === 'ER_DUP_ENTRY' || code === 11000) return 'unique';
  if (code === '23503' || code === 'ER_NO_REFERENCED_ROW_2') return 'fk';
  if (code === '40001' || code === '40P01') return 'serialization';
  if (code === '57014' || code === 'ETIMEDOUT') return 'timeout';
  if (code === '53300' || code === '53400') return 'pool_exhausted';
  if (err?.name === 'DbKnownError') return 'known';
  return 'other';
}
```

The string set is hand-picked, finite, and stable — exactly what a label
needs.

**Cardinality budget — back-of-envelope.** Most Prometheus single-replica
deployments tolerate 1–5M active series. Plan to use a *small* fraction of
that for forge. Target: forge metrics under 50k series per process, summed
across all metric names. The defaults in this doc come in around 10k for a
medium schema, well under budget.

If you must label by tenant for a billing-grade view, do it on a *separate*
metric with a much smaller bucket count and shorter retention, e.g.
`forge_query_total_by_tenant` with only `{tenant, status}` and a 7-day
retention via a recording rule that downsamples to per-day.

---

## Wiring forge events to prom-client

One listener, two events, no awaits. The pattern is:

```ts
import type { QueryEvent, ErrorEvent } from 'forge-orm';
import { db } from './db';
import {
  forgeQueryDuration,
  forgeQueryTotal,
  forgeErrorsTotal,
  forgeRowsTotal,
} from './metrics';

const offQuery = db.$on('query', (e: QueryEvent) => {
  const labels = {
    adapter: e.adapter,
    model: e.model || 'raw',
    op: e.op,
    semantic_op: e.semanticOp ?? '',
    status: 'ok' as const,
  };
  forgeQueryDuration.observe(labels, e.duration_ms / 1000);
  forgeQueryTotal.inc(labels);
  if (e.rowCount >= 0) {
    forgeRowsTotal.inc(
      { adapter: e.adapter, model: e.model || 'raw', op: e.op },
      e.rowCount,
    );
  }
});

const offError = db.$on('error', (e: ErrorEvent) => {
  const labels = {
    adapter: e.adapter,
    model: e.model || 'raw',
    op: e.op,
    semantic_op: '',
    status: 'error' as const,
  };
  forgeQueryDuration.observe(labels, e.duration_ms / 1000);
  forgeQueryTotal.inc(labels);
  forgeErrorsTotal.inc({
    adapter: e.adapter,
    model: e.model || 'raw',
    op: e.op,
    error_class: classifyError(e.error),
  });
});

// Tear down on shutdown so reloads don't leak listeners.
process.on('SIGTERM', () => { offQuery(); offError(); });
```

Three rules to keep the listener cheap:

- **No I/O** — listeners run on the query path. A network call here turns
  every query into a tail-latency incident. `prom-client.observe` and
  `.inc` are CPU-only.
- **No allocations in the hot path** — the labels object above is rebuilt
  per event, which is fine at thousands of events per second. If you push
  into the tens of thousands per second per process, pre-construct
  per-(model, op) child labels via `histogram.child(labels)` and cache them
  in a `Map`.
- **No await** — the emitter calls listeners synchronously and discards the
  promise. An async listener that opens a connection per call will leak
  promises and obscure errors.

Per-query overhead with this listener wired is typically under 5µs on Node
20 on commodity hardware — buried in the noise of any real query. With the
listener off (no `$on('query')` callers), the emitter short-circuits via
`hasListeners()` and the overhead is one boolean check.

---

## Histogram bucket choice

Bucket choice is the difference between a useful p99 and a useless one. The
default `prom-client` buckets (`[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5,
1, 2.5, 5, 10]` seconds) are too coarse at the low end for database
queries — most reads land under 5ms and end up in the same bucket as a
slow one.

**Recommended exponential buckets for general queries** (the set in the
setup snippet above):

```
0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5
```

13 buckets, half-decade spacing, covering 500µs to 5s. The lower bound at
500µs is roughly where SQLite-in-process and a warm PG primary land; the
upper bound at 5s is past your statement timeout for any sane service.
13 × N labels = total time-series — keep an eye on N.

**Heavier workloads.** If you run analytic queries that legitimately take
10s+, extend the upper end with one or two more buckets — `7.5, 15` — and
do not blow past 15. Past 15s the value of the histogram is "did this
finish at all", which a Counter answers more cheaply.

**Background workers.** A worker that runs a 30s aggregation per minute
should use a coarser histogram on a separate metric — `forge_job_duration_seconds`
with buckets `[1, 5, 15, 60, 300]` — rather than polluting the API
histogram with rare outliers that push the auto-quantile estimate around.

**Why exponential, not linear.** Prometheus `histogram_quantile` linearly
interpolates *within* a bucket. A query landing at 3ms in a `[1ms, 5ms]`
bucket reports as the bucket midpoint, 3ms. Acceptable. The same query in
a `[0ms, 100ms]` bucket reports as 50ms — a 16x error. Exponential
spacing keeps the relative error roughly constant across the range.

**p99 awareness.** A histogram cannot tell you the exact p99 — it tells
you which two bucket boundaries the p99 sits between. If your SLO is
"p99 under 50ms", you need a bucket boundary at exactly 50ms. The
recommended set has `0.05` for that reason; if your SLO is 75ms, add
`0.075` rather than relying on interpolation between `0.05` and `0.1`.

**Native histograms** (Prometheus 2.40+). The new native histogram type
adaptively buckets at scrape time, removing the choice. `prom-client`
supports it via `enableExemplars` + Prom server config. Worth the effort
on a fresh deployment; mostly noise on an existing one.

---

## Pool metrics

Latency and errors are the RED side. Pool stats are the USE side — the
saturation signal that distinguishes "DB is slow" from "we ran out of
connections to talk to a healthy DB". Always wire both.

The pool stats live on the driver, not on forge. The mapping per dialect:

```ts
// Postgres (pg.Pool)
function pgPoolStats(pool: import('pg').Pool) {
  return {
    total: pool.totalCount,        // connections currently open
    idle:  pool.idleCount,         // …of which idle
    waiting: pool.waitingCount,    // callers blocked waiting
    inUse: pool.totalCount - pool.idleCount,
  };
}

// MySQL (mysql2.Pool)
function mysqlPoolStats(pool: import('mysql2/promise').Pool) {
  // mysql2 exposes _allConnections / _freeConnections on the underlying pool.
  const raw = (pool as any).pool ?? pool;
  return {
    total: raw._allConnections.length,
    idle:  raw._freeConnections.length,
    waiting: raw._connectionQueue.length,
    inUse: raw._allConnections.length - raw._freeConnections.length,
  };
}

// MongoDB (MongoClient)
function mongoPoolStats(client: import('mongodb').MongoClient) {
  // The driver emits poolReady / connectionCheckOut / connectionCheckIn
  // events; track them yourself or read from topology.s.servers.
  return mongoCounters; // hand-maintained — see below
}
```

Sample once per scrape, not per query. A `setInterval(updateGauges, 5000)`
at boot is enough; Prometheus's default scrape interval is 15s and you
want a value newer than the scrape:

```ts
import { forgePoolInUse, forgePoolIdle, forgePoolWaiting } from './metrics';

setInterval(() => {
  const s = pgPoolStats(pool);
  forgePoolInUse .set({ adapter: 'postgres', role: 'primary' }, s.inUse);
  forgePoolIdle  .set({ adapter: 'postgres', role: 'primary' }, s.idle);
  forgePoolWaiting.set({ adapter: 'postgres', role: 'primary' }, s.waiting);
}, 5000).unref();
```

**Mongo's wire-level pool** doesn't expose a synchronous getter. Subscribe
to the connection-pool events on the `MongoClient` and maintain a counter
yourself:

```ts
let inUse = 0;
client.on('connectionCheckedOut', () => inUse++);
client.on('connectionCheckedIn',  () => inUse--);
// Reset on topology change to avoid drift on failover:
client.on('topologyClosed', () => { inUse = 0; });
```

**MSSQL (tedious)** does not expose pool counters at all. If you need
visibility, wrap the connection acquire/release in your own counter or
move to a managed pool (`tedious-connection-pool`).

For driver-specific pool tuning — `max`, `min`, `idleTimeoutMillis`,
PgBouncer transaction mode, replica routing — see
[POOLING.md](POOLING.md) and the
[Connection pooling](BACKEND.md#connection-pooling-and-lifecycle)
section of BACKEND.md.

---

## Exposing /metrics

Prometheus scrapes a plain HTTP endpoint that returns the registry's
contents in OpenMetrics text format. Wire it once per process. Three
constraints: (a) it must be reachable from the Prometheus server,
(b) it must not be on the public-internet path, (c) it must return
within the scrape timeout (5s default).

### hyper-express

```ts
import HyperExpress from 'hyper-express';
import { registry } from './metrics';
import { db } from './db';

const app = new HyperExpress.Server();

app.get('/metrics', async (_req, res) => {
  res.setHeader('content-type', registry.contentType);
  res.end(await registry.metrics());
});

// Bind to an internal interface in production. A LB rule + a SG rule are
// equivalent; the principle is "do not serve /metrics on 0.0.0.0:443".
await app.listen(Number(process.env.PORT ?? 3000));
```

### Express

```ts
import express from 'express';
import { registry } from './metrics';

const app = express();

app.get('/metrics', async (_req, res) => {
  res.set('content-type', registry.contentType);
  res.end(await registry.metrics());
});
```

### Fastify

```ts
import Fastify from 'fastify';
import { registry } from './metrics';

const app = Fastify();

app.get('/metrics', async (_req, reply) => {
  reply.header('content-type', registry.contentType);
  return registry.metrics();
});
```

### Next.js Route Handler (App Router)

```ts
// app/metrics/route.ts
import { registry } from '@/lib/metrics';

export const dynamic = 'force-dynamic';

export async function GET() {
  return new Response(await registry.metrics(), {
    headers: { 'content-type': registry.contentType },
  });
}
```

The Next.js handler runs in the same Node process as your route handlers
when you deploy on a Node runtime; on Vercel's edge runtime this won't
work — Prometheus needs a process-wide registry that survives across
requests, which the edge runtime does not give you. Keep `/metrics` on
your Node deployment, not the edge one.

### NestJS

A `MetricsController` with a single `@Get()` returning `await registry.metrics()`
does the job. Don't add interceptors or guards to the route — Prometheus
won't follow redirects or solve a JWT challenge.

### Separate metrics port (recommended)

In production, expose `/metrics` on a **second** HTTP server bound to an
internal port. This keeps your public LB free of metric traffic, lets you
firewall it independently, and prevents an accidental public scrape of
business data via labels:

```ts
import http from 'node:http';
http.createServer(async (req, res) => {
  if (req.url !== '/metrics') return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': registry.contentType });
  res.end(await registry.metrics());
}).listen(9100, '127.0.0.1');
```

Prometheus scrapes `127.0.0.1:9100/metrics` via a sidecar (Kubernetes
pod) or a direct LAN reach (VM); the main app port stays clean.

---

## Push gateway for short-lived workloads

Prometheus is pull-based. A cron job that runs for 30 seconds and exits
will never get scraped — by the time the scrape window opens, the process
is gone. The Prometheus Push Gateway is the official escape hatch: the
job pushes its metrics on exit; Prometheus scrapes the gateway.

```ts
import { Pushgateway } from 'prom-client';
import { registry } from './metrics';

const gateway = new Pushgateway(process.env.PUSHGATEWAY_URL!, undefined, registry);

async function runJob() {
  try {
    await actualWork();
  } finally {
    await gateway.pushAdd({ jobName: 'nightly_rollup', groupings: { instance: process.env.HOSTNAME ?? 'unknown' } });
  }
}
```

**Use it for:** cron jobs, one-shot scripts, Lambda functions, build
pipelines, data backfills.

**Do not use it for:** long-running services. Pushed metrics are sticky —
they stay on the gateway until explicitly deleted. A long-running service
that pushes will silently lie when it crashes (the last push is still
there). For long-running services, use pull and put up with the 15s
scrape interval.

**Lambda specifics.** Lambda invocations are short and frequent; pushing
on every invocation overwhelms the gateway and wastes invocation time.
Either (a) batch-push at the end of a runtime's lifetime via Lambda
extensions, or (b) skip the push gateway and use a vendor-managed
collector (Datadog Forwarder, CloudWatch EMF) that natively handles
short-lived workloads.

---

## Prometheus scrape config

Three flavours of scrape config — static, file-SD, and Kubernetes-SD. The
shape of the forge-relevant fields is the same.

**Static** — fixed list of targets.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'forge-api'
    scrape_interval: 15s
    scrape_timeout: 5s
    static_configs:
      - targets: ['api-1.internal:9100', 'api-2.internal:9100']
        labels:
          service: 'api'
          env: 'production'
```

**File service discovery** — for autoscaling fleets.

```yaml
scrape_configs:
  - job_name: 'forge-workers'
    file_sd_configs:
      - files: ['/etc/prometheus/sd/workers/*.yaml']
        refresh_interval: 30s
```

**Kubernetes SD** — for k8s deployments. Annotate the pod template:

```yaml
metadata:
  annotations:
    prometheus.io/scrape: 'true'
    prometheus.io/port:   '9100'
    prometheus.io/path:   '/metrics'
```

Add a `kubernetes_sd_configs` block in `prometheus.yml` (or use the
`prometheus-operator` PodMonitor CRD — its YAML is shorter and lives next
to the workload).

**Honor labels.** Prometheus prepends scrape-side labels (`job`,
`instance`) to every series; never let an exporter overwrite them by
setting them client-side. The labels you expose on a metric should only
be the ones that describe the *value*, not the *source*.

---

## Grafana dashboards

A useful dashboard for a forge service starts with the four golden signals
and adds one panel per failure mode you've seen in production.

### Golden 4 panels — PromQL

**Latency (p50/p95/p99 over a 5m window).**

```promql
histogram_quantile(0.50,
  sum by (le) (rate(forge_query_duration_seconds_bucket{job="forge-api"}[5m])))

histogram_quantile(0.95,
  sum by (le) (rate(forge_query_duration_seconds_bucket{job="forge-api"}[5m])))

histogram_quantile(0.99,
  sum by (le) (rate(forge_query_duration_seconds_bucket{job="forge-api"}[5m])))
```

Always `sum by (le)` first, then `histogram_quantile` — quantiles do not
average; you need the bucket counts summed across instances before
estimating.

**Traffic (queries per second by op).**

```promql
sum by (op) (rate(forge_query_total{job="forge-api"}[1m]))
```

A stacked area chart by `op` shows the read/write mix at a glance.

**Errors (error rate by class).**

```promql
sum by (error_class) (rate(forge_errors_total{job="forge-api"}[5m]))
```

Pair with an "error percentage" stat panel:

```promql
sum(rate(forge_errors_total{job="forge-api"}[5m]))
 /
sum(rate(forge_query_total{job="forge-api"}[5m]))
```

**Saturation (pool utilisation).**

```promql
avg by (role) (forge_pool_in_use{job="forge-api"})
 /
avg by (role) (forge_pool_max{job="forge-api"})
```

Add a second panel for `forge_pool_waiting` — any non-zero value means
callers are queueing, which is a precursor to a 503 storm.

### Per-model breakdown

A row per model, with its own latency p99 and qps panel, helps localise a
regression. The `model` label is the join key.

```promql
topk(10,
  histogram_quantile(0.99,
    sum by (model, le) (rate(forge_query_duration_seconds_bucket[5m]))))
```

### Soft-delete watch

If your audit policy requires soft-deletes never to run via the wrong
verb, plot `forge_query_total{op="delete"}` alongside `forge_query_total{semantic_op="softDelete"}`
to verify the ratio is what you expect.

### Dashboard JSON

The full Grafana JSON for the "forge golden 4" dashboard is intentionally
not pinned in this doc — Grafana's JSON format changes with each release
and a copy here ages badly. Build the panels from the queries above; save
the dashboard as code in your infra repo via the `grafana-as-code` CLI or
the `grafonnet` Jsonnet library if you want it versioned.

---

## Alerting rules

Three rules cover the common forge failure modes. Tune the thresholds to
your SLO and your traffic; the shape is universal.

```yaml
# alerts/forge.yaml — Prometheus rule file
groups:
  - name: forge.rules
    interval: 30s
    rules:
      - alert: ForgeSlowQueryRate
        expr: |
          (
            histogram_quantile(0.99,
              sum by (le, job) (rate(forge_query_duration_seconds_bucket[5m])))
            > 0.5
          )
          and on (job)
          (
            sum by (job) (rate(forge_query_total[5m])) > 10
          )
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: 'forge p99 latency above 500ms on {{ $labels.job }}'
          description: 'p99 query latency has been above 500ms for 10 minutes.'

      - alert: ForgeErrorSpike
        expr: |
          sum by (job) (rate(forge_errors_total{error_class!="unique"}[5m]))
            /
          sum by (job) (rate(forge_query_total[5m]))
          > 0.02
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: 'forge non-unique error rate >2% on {{ $labels.job }}'
          description: 'Excluding unique-violation errors (treated as user error), the query error rate has been above 2% for 5 minutes.'

      - alert: ForgePoolExhaustion
        expr: |
          max by (job, role) (forge_pool_waiting) > 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: 'forge pool has callers waiting on {{ $labels.job }} ({{ $labels.role }})'
          description: 'forge_pool_waiting has been non-zero for 5 minutes — pool is saturated. Consider scaling out, raising max, or reducing per-request fan-out.'

      - alert: ForgeDeadlockSurge
        expr: |
          sum by (job) (increase(forge_errors_total{error_class="serialization"}[10m])) > 20
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: 'forge deadlock/serialization errors surging on {{ $labels.job }}'
          description: 'More than 20 serialization failures in the last 10 minutes. Review write patterns and consider raising the retry ceiling.'
```

**Exclude `error_class="unique"` from the error-rate SLO.** A unique
violation is usually a user-driven duplicate, not a server fault.
Counting them as errors burns alert budget on benign 409s.

**`for:` clauses smooth single-scrape flaps.** Don't page on a 30s spike
that resolved by the next scrape; 5-10 minutes is the right floor for
most rules.

**Pool exhaustion is critical, not warning.** A waiting queue means
requests are *already* queued — the next 503 is seconds away.

---

## OpenMetrics format

`prom-client`'s default `registry.metrics()` output is the Prometheus
text exposition format. The OpenMetrics format is a strict superset —
identical for counters and gauges, slightly different for histograms
(an explicit `_count` and `_sum`, an `EOF` terminator). Prometheus 2.5+
accepts both; modern collectors (Vector, OTel collector) prefer
OpenMetrics.

`prom-client` exposes OpenMetrics output via:

```ts
import { register } from 'prom-client';
import { openMetricsContentType } from 'prom-client';

app.get('/metrics', async (req, res) => {
  const acceptsOpenMetrics =
    (req.headers.accept ?? '').includes('application/openmetrics-text');
  res.setHeader('content-type', acceptsOpenMetrics ? openMetricsContentType : registry.contentType);
  res.end(await registry.metrics({ format: acceptsOpenMetrics ? 'openmetrics' : 'prometheus' }));
});
```

Prometheus scrapes with `Accept: application/openmetrics-text` set by
default since 2.5 — the handler above gives both clients what they
asked for without forcing a format choice on the server.

**Exemplars.** OpenMetrics supports exemplars — a single trace id on a
bucket, surfacing in Grafana as a "click to jump to trace" affordance.
`prom-client` records exemplars via `histogram.observe({ value, exemplar })`;
attach the OTel trace id from the current span context. Best used
sparingly; one exemplar per scrape interval per bucket is enough to make
the dashboard useful and won't blow up the cardinality budget.

---

## Multi-process aggregation

`prom-client` keeps its registry in process memory. A Node cluster, pm2
in cluster mode, or a multi-worker setup will have one registry per
worker — Prometheus scrapes one, gets a slice, and the dashboard
under-counts.

Three options, in order of preference:

**1. Scrape each worker directly.** Each worker binds to a distinct port
(`9100 + cluster.worker.id`), Prometheus discovers all of them. Cleanest
model; no aggregator to maintain. Use when you have ≤ 16 workers per host
and a static port range you can register with service discovery.

**2. `AggregatorRegistry`.** `prom-client` ships an aggregator the
primary process uses to fetch and sum metrics from all workers:

```ts
// primary.ts
import cluster from 'node:cluster';
import http from 'node:http';
import { AggregatorRegistry } from 'prom-client';

const aggregator = new AggregatorRegistry();

http.createServer(async (req, res) => {
  if (req.url !== '/metrics') return res.writeHead(404).end();
  try {
    const metrics = await aggregator.clusterMetrics();
    res.writeHead(200, { 'content-type': aggregator.contentType });
    res.end(metrics);
  } catch (err) {
    res.writeHead(500).end((err as Error).message);
  }
}).listen(9100);

for (let i = 0; i < require('node:os').cpus().length; i++) cluster.fork();
```

Counters and gauges sum across workers; histograms add bucket counts
correctly. Quantiles aggregate at query time via `histogram_quantile`.

**3. StatsD relay.** `prom-client` writes to `prom-client-relay` or
`hot-shots` (StatsD client); a host-level Prometheus statsd_exporter
aggregates. Adds an extra process; choose only if you already run
statsd_exporter for other reasons.

**Default metrics, multi-process.** `collectDefaultMetrics` reads from
the calling process only — in cluster mode, the primary's defaults
don't include the workers'. Either move default collection into each
worker, or run a separate "metrics-only" worker that exclusively serves
`/metrics` and reports its own defaults. The aggregator handles the
forge metrics correctly either way.

---

## Cost — sampling and label budgets

A metrics pipeline has three costs: CPU on the emitting process, network
on the scrape, and storage on Prometheus. Forge's defaults sit
comfortably in the cheap zone, but it's easy to drift out.

**CPU.** Per-query overhead with the listener wired and labels
constructed inline is ~2–5µs on Node 20 on x86. At 5k queries per second
that's ≤ 25ms of CPU per process per second — under 3%. At 50k qps per
process it climbs into noticeable territory; pre-construct child labels
via `histogram.child(labels)` and cache them in a `Map<string, Histogram>`
keyed by `model:op:semantic_op:status`. The hit rate is 100% after the
first second of traffic.

**Network.** A `/metrics` response is N time-series × ~150 bytes each.
At 10k series, that's 1.5MB per scrape; at the default 15s scrape
interval, ~100KB/s sustained. A single Prometheus instance scraping 100
processes ingests ~10MB/s, very comfortable on a 1Gbps link.

**Storage.** Prometheus's local storage is ~1–2 bytes per sample after
compression. 10k series × 4 samples/min × 1440 min/day = 57.6M samples/day
per process. ~115MB/day per process. Per-tenant labels turn that into a
storage problem instantly.

**Sampling.** Don't sample query events to save metric cost. The
histogram is the budget mechanism — recording every event is what makes
the quantile accurate. If you have to cut cost, prune labels (drop
`semantic_op` if you don't use it; merge `op="findOne"` into
`op="find"` if your dashboards don't distinguish them) or reduce
retention.

**Per-label cost rule of thumb.** Each *unique combination* of label
values across all your metrics is one time-series. Doubling a label's
cardinality doubles the time-series count for every metric that label
appears on. Treat a label as a 1–10x cost multiplier and only spend it
where the dashboard query benefits.

---

## Worked examples

### (a) hyper-express + prom-client

A complete server with forge metrics, pool gauges, and a `/metrics`
endpoint, ready to wire to Prometheus.

```ts
// metrics.ts
import {
  Counter, Histogram, Gauge, Registry, collectDefaultMetrics,
} from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'node_' });

export const qDur = new Histogram({
  name: 'forge_query_duration_seconds',
  help: 'forge query duration',
  labelNames: ['adapter', 'model', 'op', 'semantic_op', 'status'],
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});
export const qTot = new Counter({
  name: 'forge_query_total', help: 'forge query count',
  labelNames: ['adapter', 'model', 'op', 'semantic_op', 'status'],
  registers: [registry],
});
export const eTot = new Counter({
  name: 'forge_errors_total', help: 'forge errors',
  labelNames: ['adapter', 'model', 'op', 'error_class'],
  registers: [registry],
});
export const poolInUse = new Gauge({
  name: 'forge_pool_in_use', help: 'pool in use',
  labelNames: ['adapter', 'role'], registers: [registry],
});
export const poolWait = new Gauge({
  name: 'forge_pool_waiting', help: 'pool waiters',
  labelNames: ['adapter', 'role'], registers: [registry],
});
```

```ts
// server.ts
import HyperExpress from 'hyper-express';
import { Pool } from 'pg';
import { createDb, pgDriver } from 'forge-orm';
import { schema } from './schema';
import { registry, qDur, qTot, eTot, poolInUse, poolWait } from './metrics';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const db = await createDb({ schema, driver: pgDriver(pool) });

function classifyError(err: any): string {
  const code = err?.code ?? err?.sqlState;
  if (code === '23505') return 'unique';
  if (code === '23503') return 'fk';
  if (code === '40001' || code === '40P01') return 'serialization';
  if (code === '57014') return 'timeout';
  return 'other';
}

db.$on('query', (e) => {
  const l = { adapter: e.adapter, model: e.model || 'raw', op: e.op,
              semantic_op: e.semanticOp ?? '', status: 'ok' };
  qDur.observe(l, e.duration_ms / 1000);
  qTot.inc(l);
});
db.$on('error', (e) => {
  const l = { adapter: e.adapter, model: e.model || 'raw', op: e.op,
              semantic_op: '', status: 'error' };
  qDur.observe(l, e.duration_ms / 1000);
  qTot.inc(l);
  eTot.inc({ adapter: e.adapter, model: e.model || 'raw', op: e.op,
             error_class: classifyError(e.error) });
});

setInterval(() => {
  poolInUse.set({ adapter: 'postgres', role: 'primary' },
                pool.totalCount - pool.idleCount);
  poolWait .set({ adapter: 'postgres', role: 'primary' }, pool.waitingCount);
}, 5000).unref();

const app = new HyperExpress.Server();
app.get('/metrics', async (_, res) => {
  res.setHeader('content-type', registry.contentType);
  res.end(await registry.metrics());
});
app.get('/users/:id', async (req, res) => {
  const u = await db.user.findFirst({ where: { id: req.params.id } });
  res.json(u);
});

await app.listen(3000);
```

Scrape config:

```yaml
scrape_configs:
  - job_name: forge-api
    static_configs:
      - targets: ['localhost:3000']
```

### (b) BullMQ worker metrics

A worker has different operating characteristics: bursty traffic, per-job
latency that's mostly application logic, and a different histogram shape.
Use a separate metric so neither dashboard pollutes the other.

```ts
// worker-metrics.ts
import { Counter, Histogram, Gauge, Registry } from 'prom-client';

export const workerRegistry = new Registry();

export const jobDur = new Histogram({
  name: 'forge_worker_job_duration_seconds',
  help: 'worker job total duration (application + DB)',
  labelNames: ['queue', 'job_name', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60, 300],
  registers: [workerRegistry],
});

export const jobTot = new Counter({
  name: 'forge_worker_jobs_total', help: 'worker jobs processed',
  labelNames: ['queue', 'job_name', 'status'],
  registers: [workerRegistry],
});

export const jobsActive = new Gauge({
  name: 'forge_worker_jobs_active', help: 'in-flight worker jobs',
  labelNames: ['queue'], registers: [workerRegistry],
});
```

```ts
// worker.ts
import { Worker } from 'bullmq';
import { createDb } from 'forge-orm';
import { schema } from './schema';
import { workerRegistry, jobDur, jobTot, jobsActive } from './worker-metrics';
import http from 'node:http';

const db = await createDb({ url: process.env.DATABASE_URL!, schema });

// Wire forge metrics into the *same* registry as the worker metrics — the
// scrape endpoint serves everything in one response.
import { qDur, qTot, eTot } from './metrics'; // reuse from example (a)
[qDur, qTot, eTot].forEach((m) => workerRegistry.registerMetric(m as any));

const worker = new Worker('emails', async (job) => {
  jobsActive.inc({ queue: 'emails' });
  const end = jobDur.startTimer({ queue: 'emails', job_name: job.name });
  try {
    const order = await db.order.findFirstOrThrow({ where: { id: job.data.orderId } });
    await sendReceipt(order);
    end({ status: 'ok' });
    jobTot.inc({ queue: 'emails', job_name: job.name, status: 'ok' });
  } catch (err) {
    end({ status: 'error' });
    jobTot.inc({ queue: 'emails', job_name: job.name, status: 'error' });
    throw err;
  } finally {
    jobsActive.dec({ queue: 'emails' });
  }
}, { connection: { url: process.env.REDIS_URL }, concurrency: 8 });

// /metrics on a sidecar port — the worker has no main HTTP server.
http.createServer(async (req, res) => {
  if (req.url !== '/metrics') return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': workerRegistry.contentType });
  res.end(await workerRegistry.metrics());
}).listen(9100, '127.0.0.1');
```

The `startTimer` helper returns a closure that observes when called — one
call site, no manual subtraction. `jobsActive` is a gauge so a long-running
job shows up immediately rather than at completion.

### (c) Grafana SLO dashboard

A minimum-viable SLO dashboard. One row, four stats panels, an availability
gauge. Save as JSON in your infra repo.

**SLO definition.** Read availability: p99 read latency ≤ 50ms over rolling
30 days, 99.9% of the time. Burn budget: 30 days × 0.1% = ~43m of allowed
slow time per month.

**SLI: fraction of read queries inside the 50ms bucket.**

```promql
sum(rate(forge_query_duration_seconds_bucket{op=~"find|findOne|count",le="0.05"}[5m]))
 /
sum(rate(forge_query_duration_seconds_count{op=~"find|findOne|count"}[5m]))
```

**Burn rate (multiwindow).** Fast-burn (2% of budget in 1h) and slow-burn
(5% in 6h) per Google SRE:

```promql
(
  1 -
  sum(rate(forge_query_duration_seconds_bucket{op=~"find|findOne|count",le="0.05"}[1h]))
   /
  sum(rate(forge_query_duration_seconds_count{op=~"find|findOne|count"}[1h]))
) / 0.001 > 14.4
```

Alert when burn rate × budget exceeds the SLO ratio. The exact constants
(`14.4`, `6`) come from the multiwindow burn-rate paper; copy them rather
than derive them.

**Panels.**

1. Stat — current SLI value (`sum / sum` over 5m).
2. Stat — error budget remaining (`(SLI - 0.999) / (1 - 0.999) * 100%`).
3. Time-series — SLI over the last 30 days.
4. Time-series — burn-rate against the threshold line.
5. Annotation — deploys, from your CI's webhook to Grafana's annotation API.

Five panels are enough. A dashboard with twenty panels is read by nobody.

---

## Related docs

- [EVENTS.md](EVENTS.md) — the `query` and `error` event surface this doc
  is built on.
- [LOGGING.md](LOGGING.md) — pino/winston wiring for the same events.
- [TRACING.md](TRACING.md) — OTel spans via `wireOtel`, exemplars in
  histograms.
- [POOLING.md](POOLING.md) — driver-specific pool tuning and the
  `pool_stats` shape for every adapter.
- [BACKEND.md](BACKEND.md) — server recipes, request-scoped tx, BullMQ
  workers, multi-tenant patterns.
