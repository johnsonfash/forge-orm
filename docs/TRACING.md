# Tracing

OpenTelemetry-based distributed tracing for forge-orm queries — wrap every query in a span, propagate W3C trace context across the stack, export to Jaeger / Tempo / Honeycomb / DataDog. Built on the [EVENTS.md](EVENTS.md) hook surface.

This doc is a companion to the main [README](../README.md). It assumes you have read [Watching queries](../README.md#watching-queries) and the [Observability](BACKEND.md#observability) section of [BACKEND.md](BACKEND.md), and goes deeper on the wiring you need to take forge from "I have a query event" to "I can see this query in a Honeycomb waterfall, with the upstream HTTP request as its parent".

forge does not ship its own tracer. It ships `wireOtel(db, …)`, a thin adapter on top of `db.$on('query')` that takes any OpenTelemetry tracer you hand it and emits one span per query with the right attributes. Everything below — context propagation, sampling, exporters — is OTel SDK work, and the recipes here are the small amount of glue you need around that shape.

---

## Contents

- [Why trace queries](#why-trace-queries)
- [OpenTelemetry primer](#opentelemetry-primer)
- [Wiring the OTel SDK in Node](#wiring-the-otel-sdk-in-node)
- [Wrapping forge queries in spans](#wrapping-forge-queries-in-spans)
- [Semantic conventions](#semantic-conventions)
- [Parameter binding and PII](#parameter-binding-and-pii)
- [Span naming](#span-naming)
- [Trace context propagation from HTTP](#trace-context-propagation-from-http)
- [Sampling](#sampling)
- [Exporters](#exporters)
- [Cost control](#cost-control)
- [Multi-database queries](#multi-database-queries)
- [Async context](#async-context)
- [Common pitfalls](#common-pitfalls)
- [Worked example: hyper-express + Jaeger](#worked-example-hyper-express--jaeger)
- [Worked example: Next.js Route Handlers + Honeycomb](#worked-example-nextjs-route-handlers--honeycomb)
- [Worked example: BullMQ worker tied to a web request](#worked-example-bullmq-worker-tied-to-a-web-request)
- [Cross-links](#cross-links)

---

## Why trace queries

Logs tell you that a query ran. Metrics tell you the p99 of how long it took.
Traces tell you that *this* query, in *that* request, was the reason the
checkout endpoint took 1.8 seconds — and that 1.4 seconds of it was a
single `findMany` walking a missing index on `orders.customer_id`.

The shape of a distributed system makes that question harder than it sounds.
A `POST /checkout` call may fan out to a payments service, an inventory
service, a fraud check, and the database — and each of those may issue more
calls. A traditional "slow query log" line in isolation tells you nothing
about which user, which request, which upstream caller, which retry. By the
time you have grepped enough log files to reconstruct the chain, the next
incident has rolled in.

A trace gives you the chain for free. Every operation gets a span; every
span knows its parent; the result is a waterfall that ties the slow
`findMany` directly to the `POST /checkout` it served, the `userId` baggage
on that request, the queue job that retried it, the worker pod that handled
the retry. The slow service hop stops being a forensic exercise.

forge contributes one span per query to that waterfall. That sounds small,
and it is — but it is the span you can *act* on. SQL latency, row counts,
the operation that fired, the model that owns it; all surface as
attributes you can `WHERE` on in your tracing backend. Combined with
correctly propagated parents, you can answer "show me the slowest
`User.findMany` issued from this org's tenant pool over the last 24 hours"
in one query.

---

## OpenTelemetry primer

forge users do not need to be OpenTelemetry experts, but four concepts are
worth nailing down before the recipes below make sense.

**Span.** One unit of work, with a start time, an end time, a name, and a
bag of attributes. forge produces one span per query. Your HTTP framework
produces one span per request. Your fetch client produces one span per
outbound call. A trace is the tree of those spans linked by parent IDs.

**SpanContext.** The minimum data required to identify a span across a
process boundary: a 128-bit trace ID, a 64-bit span ID, and a few flags
(sampled vs. not, sampling decision). When service A calls service B, A
serialises its SpanContext into the request headers; B deserialises it and
uses it as the parent of its own root span. That is how the waterfall
crosses the network.

**Baggage.** A separate key/value bag that rides alongside SpanContext on
the same propagators. Use it for cross-cutting context you want every
downstream span to see — `tenantId`, `userId`, `featureFlag`. Baggage is
*not* automatically attached to spans as attributes (it can be expensive);
you opt in via a baggage span processor.

**Trace ID propagation.** OTel's default propagator is W3C Trace Context,
which serialises SpanContext into a `traceparent` header and Baggage into
a `baggage` header. Every modern tracing backend understands W3C; the older
B3 (`X-B3-TraceId` etc.) and Jaeger (`uber-trace-id`) formats are still
common in older Java/Go stacks, and OTel supports them via configuration.

```
traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
             │  └──── trace-id ──────────────────┘ └──── span-id ──┘ └─ sampled
             │
             └─ version
```

That single header is the entire wire format that makes cross-service
tracing work. Everything else is your SDK setting it on outgoing requests
and reading it on incoming ones.

---

## Wiring the OTel SDK in Node

The minimum viable Node setup uses two packages: `@opentelemetry/sdk-node`
(the SDK bundle) and `@opentelemetry/auto-instrumentations-node` (the
collection of HTTP / fetch / Postgres / Redis / etc. auto-instrumentations).

```sh
npm i @opentelemetry/api \
      @opentelemetry/sdk-node \
      @opentelemetry/auto-instrumentations-node \
      @opentelemetry/exporter-trace-otlp-http \
      @opentelemetry/resources \
      @opentelemetry/semantic-conventions
```

```ts
// src/otel.ts — must run BEFORE any other module that you want instrumented.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes as Attr } from '@opentelemetry/semantic-conventions';

export const sdk = new NodeSDK({
  resource: new Resource({
    [Attr.SERVICE_NAME]: process.env.SERVICE_NAME ?? 'api',
    [Attr.SERVICE_VERSION]: process.env.GIT_SHA ?? 'dev',
    [Attr.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV ?? 'development',
  }),
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces',
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      // forge owns the DB span — silence the raw-driver layer to avoid double counting.
      '@opentelemetry/instrumentation-pg':    { enabled: false },
      '@opentelemetry/instrumentation-mysql2': { enabled: false },
      '@opentelemetry/instrumentation-mongodb': { enabled: false },
    }),
  ],
});

await sdk.start();
```

Two pieces matter beyond the obvious. **Start order**: the SDK patches
modules as it imports them, so `import './otel'` must be the very first
import in your entrypoint — before `forge-orm`, before your HTTP framework,
before anything else. The clean pattern is `node --import ./otel.js
./dist/server.js`, which guarantees order without relying on import
hoisting.

**Disabling raw-driver instrumentations.** Auto-instrumentations include
`pg`, `mysql2`, `mongodb`, etc. Those produce a span for every wire-level
roundtrip — which means a single `db.user.findMany({ include: { posts: true } })`
will emit two spans from forge and two more from the underlying driver, and
the waterfall becomes noisy. Either disable the driver instrumentations and
let forge own the DB span (recommended), or disable forge's tracer and let
the driver own it (loses the typed `model` / `op` attributes). Don't run
both.

---

## Wrapping forge queries in spans

`wireOtel` is forge's adapter from `$on('query')` to OTel. It takes a
tracer, returns an unsubscribe function, and emits one span per resolved
query.

```ts
import { trace } from '@opentelemetry/api';
import { wireOtel } from 'forge-orm';
import { db } from './db';

const offOtel = wireOtel(db, {
  tracer: trace.getTracer('forge-orm', '1.0.0'),

  // Whether to record the rendered SQL as db.statement. Off in prod by default.
  recordStatement: process.env.NODE_ENV !== 'production',

  // Truncate long statements; the default is 4096.
  maxStatementLen: 1024,

  // Optional: filter which queries get spans (cost control — see below).
  shouldTrace: (e) => e.duration_ms > 5 || e.error != null,
});
```

Internally, `wireOtel` uses the *active* OTel context at the moment the
query event fires as the span's parent. That means if your HTTP framework
has correctly entered a request span (auto-instrumentations do this for
you), the forge span will land under it without any extra wiring. If
there's no active span — say, in a script with no surrounding trace — the
forge span becomes a root span of its own one-span trace, which is usually
the right default.

The hook fires *after* the query resolves. That has two consequences worth
naming. First, the span's duration is set from `e.duration_ms` rather than
from wall-clock subtraction inside the listener, so listener latency
doesn't smear into the recorded span. Second, the parent context at
listener time is what you get — if you `await db.user.findMany()` inside
an async branch that lost its context, the span will land under whatever
context is active when the listener runs, not at the call site. The
[Async context](#async-context) section is the entire fix.

For listeners that fire on errors, forge emits `$on('error')` events with
the same shape plus `e.error`. `wireOtel` subscribes to both: errored
queries get the same span, with `recordException(error)` and a
`StatusCode.ERROR` status set on the span.

---

## Semantic conventions

OpenTelemetry defines a [semantic conventions for database
clients](https://opentelemetry.io/docs/specs/semconv/database/) — a
standard set of attribute names so tracing backends can render DB spans
consistently regardless of which library produced them. forge follows
those conventions for the common attributes and adds forge-specific ones
under the `forge.*` namespace.

| Attribute              | Source           | Example                                    |
| ---------------------- | ---------------- | ------------------------------------------ |
| `db.system`            | OTel semconv     | `postgresql`, `mysql`, `mariadb`, `mssql`, `sqlite`, `duckdb`, `mongodb` |
| `db.operation`         | OTel semconv     | `findMany`, `findUnique`, `update`, `upsert`, `delete`, `aggregate`, `runRaw` |
| `db.statement`         | OTel semconv     | rendered SQL (placeholders only — never params) |
| `db.collection.name`   | OTel semconv     | `users`, `orders`                          |
| `db.namespace`         | OTel semconv     | database name (Postgres / Mongo)           |
| `forge.adapter`        | forge            | `pg`, `mysql2`, `better-sqlite3`, `duckdb`, `mssql`, `mongo` |
| `forge.model`          | forge            | the model name (`User`, `Order`)            |
| `forge.semantic_op`    | forge            | the high-level op the call originated from — `findMany`, `count`, `aggregate` — distinct from the wire op (`select`) when forge splits or rewrites |
| `forge.row_count`      | forge            | rows affected or returned                  |
| `forge.duration_ms`    | forge            | reproduced from the event for sort/filter queries that don't want to parse OTel duration |
| `forge.tx_id`          | forge            | per-transaction correlation id when the call ran inside `$transaction` |
| `forge.batch_size`     | forge            | size of the batch when `createMany` / `updateMany` ran |

`db.system` is derived from `db.adapter.kind`. `db.operation` comes from
`e.op`; `forge.semantic_op` from `e.semanticOp`, which is a forge concept
— it's the call you actually wrote (`db.user.findMany`) vs. the wire op
that ran (`select` on Postgres, `find` on Mongo). For the common case the
two match, and the duplicate attribute is cheap; for the cases where they
diverge (an `upsert` that fans out to `INSERT … ON CONFLICT`, a `count`
that issues `SELECT count(*)`), you can group by either and get the right
answer.

`db.statement` is the rendered SQL with parameter placeholders intact. It
is *not* the SQL with values substituted in — that would put raw user
data into your trace store, and that's the next section's entire topic.

---

## Parameter binding and PII

Never put raw query parameters into a span. They are user data; they are
PII; they are passwords; they are payment tokens. Span attribute stores
are not authorised to hold any of those, and "we'll redact it later" is
not a thing tracing backends do for you.

forge's `wireOtel` enforces this by default. When `recordStatement` is on,
the attribute it writes to `db.statement` is the prepared SQL — the same
string that goes to the driver — with `$1`, `$2`, `?` placeholders intact.
The parameter array is *not* attached as an attribute under any
configuration flag. If you need to correlate a slow query to a specific
parameter value, do it through a custom attribute that you control:

```ts
const offOtel = wireOtel(db, {
  tracer: trace.getTracer('forge-orm'),
  recordStatement: true,
  onSpan: (span, event) => {
    // Allowed: low-cardinality, non-PII identifiers.
    if (event.model === 'Order' && event.where?.tenantId) {
      span.setAttribute('forge.tenant_id', event.where.tenantId);
    }
    // Forbidden: anything the user typed.
    // ❌ span.setAttribute('forge.params', JSON.stringify(event.params));
  },
});
```

The rule of thumb: if a value would belong in a structured log redaction
allow-list, it can be a span attribute. If it would be redacted, it
cannot. When in doubt, tag the *shape* of the query (`forge.where_keys =
'email,deletedAt'`) rather than the contents.

For SQL statements that include user data in the *text* itself — `LIKE`
patterns, full-text search queries — forge already routes those through
parameterised binding by default, so the statement you see in the span is
`WHERE name LIKE $1` and the user's input never appears. The only
exception is `db.$queryRawUnsafe`, which is explicitly named to remind you
that it bypasses the parameter machinery. If you use it, omit the
statement from the span (`recordStatement: false` for that span, or
filter on `e.op === 'queryRawUnsafe'` in `shouldTrace`).

GDPR / SOC2 footnote: tracing backends are usually classified the same
way as logs in your data-classification register. If your logs are not
allowed to hold customer PII, neither are your spans. Your privacy
officer will appreciate the consistency.

---

## Span naming

forge spans are named `forge.<model>.<action>` — e.g. `forge.User.findMany`,
`forge.Order.upsert`, `forge.Post.aggregate`. The pattern is deliberate.

`forge.` as a prefix puts the spans under their own namespace in tracing
UIs that group by name prefix (Honeycomb's "service map" treats this
correctly out of the box; Jaeger displays the prefix in the operation
column). The `<model>` segment is high-cardinality on purpose — being
able to filter to "all `User` queries" without joining attributes is
worth the cost. The `<action>` segment uses forge's high-level op name
(`semanticOp`) rather than the wire op, so a `count` shows up as
`forge.User.count` not `forge.User.select`.

For raw queries, the model is `null` and the name collapses to
`forge.raw.<op>`:

```
forge.raw.queryRaw
forge.raw.executeRaw
forge.raw.runCommandRaw          # Mongo
```

You can override per-span via `onSpan`:

```ts
wireOtel(db, {
  tracer,
  onSpan: (span, event) => {
    if (event.semanticOp === 'count' && event.model === 'AuditLog') {
      span.updateName('forge.AuditLog.count.compliance');
    }
  },
});
```

Don't put high-cardinality values (IDs, emails, paths) in the span name —
that explodes the cardinality of the "operation" dimension in your backend
and most stores will reject it or auto-aggregate it into a useless
`forge.User.<gen>` bucket. IDs go in attributes; names stay shape-stable.

---

## Trace context propagation from HTTP

The single trick that turns "forge queries get spans" into "forge queries
get spans *under their HTTP parent*" is propagating the W3C `traceparent`
header from the incoming request into the OTel context for the request's
async lifetime. Auto-instrumentations handle this for you on Express,
Fastify, Koa, and any framework that runs on the standard Node `http`
module — they wrap the request handler in `context.with(ctxFromHeaders,
…)` before your code runs.

`hyper-express` doesn't go through the standard Node `http` module — it
runs on `uWebSockets.js`. The auto-instrumentation doesn't catch it, so
you propagate manually.

```ts
// src/middleware/trace-context.ts
import { context, propagation, trace, SpanKind } from '@opentelemetry/api';

const tracer = trace.getTracer('http-server');

export const traceMiddleware = (req: any, res: any, next: () => void) => {
  const carrier: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') carrier[k.toLowerCase()] = v;
  }
  const ctx = propagation.extract(context.active(), carrier);

  const span = tracer.startSpan(
    `${req.method} ${req.url.split('?')[0]}`,
    { kind: SpanKind.SERVER, attributes: {
      'http.method': req.method,
      'http.target': req.url,
    } },
    ctx,
  );

  const ctxWithSpan = trace.setSpan(ctx, span);
  context.with(ctxWithSpan, () => {
    res.once('finish', () => {
      span.setAttribute('http.status_code', res.statusCode);
      if (res.statusCode >= 500) span.recordException(new Error(`HTTP ${res.statusCode}`));
      span.end();
    });
    res.once('abort', () => {
      span.setAttribute('http.aborted', true);
      span.end();
    });
    next();
  });
};
```

Fastify, in contrast, plays nicely — install
`@opentelemetry/instrumentation-fastify` from the auto-instrumentations
bundle and the request hooks fire inside the right context. Same for
NestJS via its underlying `http` adapter, and for Hono via either its
Node adapter or its Bun adapter (Bun has shipped OTel context propagation
in `Bun.serve` since 1.1).

For inbound requests *from* a service that doesn't send `traceparent`
(legacy callers, third-party webhooks), `propagation.extract` simply
returns the existing context and the server span becomes a root. That's
the right behaviour — you don't want a webhook's anonymous request to
look like it belongs to an unrelated previous trace.

---

## Sampling

You will not afford to send every span to your tracing backend at
production volume. A 1k-req/sec service with 10 DB spans per request is
10M DB spans per minute; at typical SaaS pricing that's tens of thousands
of dollars per month for traces nobody reads. You sample.

**Head-based sampling** runs at the trace producer (your service) and
decides at the *root span* whether the trace is kept. Every child span
inherits the decision via the sampled flag in `traceparent`, which makes
the choice consistent across services. The OTel default is
`ParentBasedSampler({ root: TraceIdRatioBasedSampler(0.1) })` — 10% of
new traces are kept, and any trace whose parent header arrived sampled is
kept regardless of the local ratio. That last clause is what makes
service-A's sampling decision propagate to service-B without the two
needing to agree.

```ts
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';

new NodeSDK({
  sampler: new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(0.1),
  }),
});
```

The standard recipe layers a few rules on top of the base ratio:

- **Always-on for errors.** If a span errors, you want the trace. Wrap the
  base sampler in a custom `Sampler` that returns `RECORD_AND_SAMPLED` on
  any error span — or use the OTel `AlwaysOnSampler` for a route that
  threw, via `trace.setSpan(ctx, span)`.
- **Always-on for the slow path.** Same idea: if the request's latency
  budget is blown, keep the trace. This needs to happen at the end of the
  span (when latency is known), so it's a *tail* decision in practice.
- **Per-route ratios.** Health checks at 100% are noise; checkout at 100%
  is gold. Route the decision through a sampler that reads the active
  span's `http.target` attribute.

**Tail-based sampling** runs in the collector, after all spans for a
trace have arrived. The collector decides whether to keep the trace based
on the *whole* shape — latency, errors, attributes. That gives you "keep
all traces with at least one error", "keep all traces over 1s", "keep
0.1% of normal traces" without the producer having to predict which
traces are interesting at root time. The cost is collector memory (it
buffers traces until it can decide) and a hard cap on trace duration
(after the buffer window, late spans are dropped).

The `otel-collector` tail sampling config that pairs well with forge:

```yaml
# otel-collector-config.yaml
processors:
  tail_sampling:
    decision_wait: 30s
    num_traces: 100000
    policies:
      - name: errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: slow
        type: latency
        latency: { threshold_ms: 1000 }
      - name: db_slow
        type: numeric_attribute
        numeric_attribute: { key: forge.duration_ms, min_value: 500 }
      - name: baseline
        type: probabilistic
        probabilistic: { sampling_percentage: 1 }
```

The `forge.duration_ms` policy is why forge mirrors the duration into a
forge-specific attribute despite OTel computing it from start/end times
— numeric_attribute policies match on attribute values, not on derived
durations, and the collector needs the raw number to evaluate the rule.

---

## Exporters

The OTel SDK is exporter-agnostic. Switching from Jaeger to Honeycomb is
swapping one import. The list below is the wiring per backend; pick one,
or run two in parallel through the collector if you're mid-migration.

**Jaeger.** Modern Jaeger speaks OTLP natively, so the OTLP exporter is
what you want; the legacy `@opentelemetry/exporter-jaeger` is deprecated
and shouldn't be used in new code.

```ts
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: 'http://jaeger:4318/v1/traces',
  }),
});
```

**Tempo.** Grafana Tempo accepts OTLP over either HTTP or gRPC; HTTP is
simpler, gRPC is faster at high throughput.

```ts
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';

new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: 'grpc://tempo:4317',
  }),
});
```

**Honeycomb.** Honeycomb is OTLP/HTTPS with an `x-honeycomb-team` header
holding the API key.

```ts
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: 'https://api.honeycomb.io/v1/traces',
    headers: {
      'x-honeycomb-team': process.env.HONEYCOMB_API_KEY!,
      'x-honeycomb-dataset': 'forge-api',
    },
  }),
});
```

**DataDog.** DataDog accepts OTLP through the `datadog-agent` running as
a sidecar (recommended) or directly via the OTLP intake. Sidecar:

```ts
new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: 'http://localhost:4318/v1/traces',     // dd-agent in the same pod
  }),
});
```

DataDog also publishes `dd-trace`, a native APM client that does its own
context propagation. Don't run both — pick OTLP for portability or
`dd-trace` for the deepest DataDog feature coverage. If you go OTLP, set
`DD_TRACE_OTEL_ENABLED=true` on the agent so it accepts OTel-formatted
service.name attributes as DataDog services.

**Lightstep / ServiceNow Cloud Observability.** Same as Honeycomb shape:
OTLP/HTTPS with a token header.

```ts
new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: 'https://ingest.lightstep.com:443/traces/otlp/v0.9',
    headers: { 'lightstep-access-token': process.env.LIGHTSTEP_TOKEN! },
  }),
});
```

**New Relic.** OTLP endpoint per region; the API key rides on
`api-key`.

```ts
new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: 'https://otlp.nr-data.net:4318/v1/traces',
    headers: { 'api-key': process.env.NEW_RELIC_LICENSE_KEY! },
  }),
});
```

The pattern across all six: same SDK, same instrumentations, same forge
wiring, different `OTLPTraceExporter` config. In a real deployment the
sensible default is "send to a local `otel-collector` sidecar, let the
collector forward to the actual backend", which means switching backends
is a YAML change, not a code change.

---

## Cost control

Span volume is the cost dimension to watch. The mitigations stack — apply
as many as you need to land within budget, and don't ship more.

**Filter at the producer with `shouldTrace`.** The cheapest span is the
one you never create. `wireOtel` calls `shouldTrace(event)` before
allocating the span; returning `false` drops it.

```ts
wireOtel(db, {
  tracer,
  shouldTrace: (e) => {
    if (e.error) return true;                       // always keep errors
    if (e.duration_ms > 50) return true;            // always keep slow
    if (e.model === 'Session') return false;        // never trace sessions
    if (e.semanticOp === 'count' && e.model === 'Heartbeat') return false;
    return Math.random() < 0.05;                    // 5% baseline
  },
});
```

Note: this is *not* OTel sampling — it bypasses the sampler entirely. The
trade-off is that you lose the parent-based propagation guarantee for the
dropped queries (a parent trace that was sampled won't necessarily see
the dropped child span). That's usually fine for high-volume,
low-information queries (session lookups, heartbeats, polling). It's not
fine for anything you might want to chase a regression on.

**Cap the statement length.** Long SQL is mostly long because of `IN (?,
?, ?, …)` lists with hundreds of values. The first 512 characters tell
you everything; the rest is bytes you're paying to store.

```ts
wireOtel(db, { tracer, maxStatementLen: 512 });
```

**Drop `db.statement` in prod entirely.** If you've never gone back to a
production span to read its SQL, you're paying for an attribute you don't
use. `recordStatement: false` removes the attribute; the operation,
model, and timing are still there.

**Sample aggressively at the root.** A 1% baseline with 100% errors and
100% slow gives you everything you need to debug for ~1% of the cost of
keeping everything. Pair with tail-sampling at the collector and you can
trust the sample is representative without sending the volume.

**Use exemplars for metrics.** If your goal is "see one trace per slow
p99 bucket", you don't need to sample 100% of slow queries — you need
*exemplars*: one or two example traces per bucket, linked from the
metric. OTel metrics support exemplars natively; pair the
`PeriodicExportingMetricReader` with the trace exporter and Honeycomb /
Tempo / Grafana will link metric-line clicks to specific traces.

---

## Multi-database queries

A single forge `db` handle talks to one database. But many real apps use
two — Postgres for transactional data and Mongo for documents, or a
primary and a replica, or a hot and a cold store. Cross-DB requests
produce a trace with multiple `forge.*` spans under one HTTP parent,
each with its own `db.system`.

```ts
const reqSpan = tracer.startSpan('GET /orders/:id');
await context.with(trace.setSpan(context.active(), reqSpan), async () => {
  const order = await pgDb.order.findUnique({ where: { id } });           // forge.Order.findUnique on db.system=postgresql
  const events = await mongoDb.event.find({ orderId: id }).toArray();      // forge.Event.find on db.system=mongodb
  return { order, events };
});
reqSpan.end();
```

The waterfall shows both DB calls as children of the HTTP request, each
tagged with its system. Filtering by `db.system=mongodb` in your trace
backend gives you Mongo-only latency; the absence of a `db.system`
attribute on the request span keeps the system-level grouping unambiguous.

For *transactions* that span two databases — uncommon, but real, and
always a code smell — the only honest representation is two `forge.tx_id`
spans, one per DB, with the same logical correlation id you set yourself
via `onSpan` or baggage. forge doesn't pretend the operation is atomic
(it isn't), and the trace shouldn't either. Tag both spans with
`forge.cross_db = true` and a shared `forge.saga_id` so you can
reconstruct the pair later, and link to the [TRANSACTIONS.md](TRANSACTIONS.md)
saga pattern in your runbook for the rollback flow.

---

## Async context

Every problem in this section reduces to: "the OTel active context is
stored in `AsyncLocalStorage`, and `AsyncLocalStorage` only propagates
through awaits that the runtime knows about". 99% of the time you're
fine. The 1% of the time you're not is the 100% of the time you're
debugging it.

The runtime knows about an await when one of these is true:

- it's a `Promise` chained with `.then` or `await`
- it's a callback inside `setImmediate`, `setTimeout`, `setInterval`,
  `process.nextTick`, or an `EventEmitter` event fired synchronously from
  within the same async context
- it's a worker thread message handler that joined the parent's context
  (rare; manual)

The runtime does *not* know when:

- you store a callback in a long-lived object and invoke it later from
  outside the original context (event emitters fired from a global queue
  loop, observer patterns, custom batchers)
- you cross a worker thread or child process boundary without explicit
  context.with on the receiving side
- you `Promise.resolve().then(…)` from inside a sync callback that the
  runtime entered without context (rare; usually means you're calling
  into native code)

The fix in every case is the same: capture the context at the boundary
where it still exists, and call `context.with(captured, fn)` on the other
side.

```ts
import { context } from '@opentelemetry/api';

class BatchQueue {
  private queue: Array<{ ctx: ReturnType<typeof context.active>; job: () => Promise<void> }> = [];

  push(job: () => Promise<void>) {
    this.queue.push({ ctx: context.active(), job });   // capture at enqueue
  }

  async drain() {
    for (const { ctx, job } of this.queue.splice(0)) {
      await context.with(ctx, job);                     // restore at run
    }
  }
}
```

If you wire your batcher this way, the forge spans produced inside `job`
will land under the trace that *enqueued* them, not under the drain
loop's context. That's almost always what you want for batched work
that's morally still "this request's work".

The pattern composes with forge's own `txStore` (`AsyncLocalStorage`-based
transaction propagation, see [BACKEND.md](BACKEND.md#hyper-express)) —
both stores propagate through the same await graph, so a request handler
that enters a tx and emits an OTel span will be both txed *and* traced
correctly without extra glue.

---

## Common pitfalls

**Missing parent context — server starts a fresh trace.** Symptom:
every DB span is a root, none are children of an HTTP span. Cause: the
incoming request didn't carry a `traceparent` header (or it was stripped
by a proxy), and your server didn't wrap the handler in a
`SpanKind.SERVER` span. Fix: add a server-span middleware (see
[Trace context propagation](#trace-context-propagation-from-http)). Even
when the inbound trace doesn't propagate, you want a server root span so
the DB calls have a parent within your service.

**Promise chains losing context.** Symptom: spans appear under the wrong
parent — usually under whatever the *previous* request was, or under no
parent at all. Cause: `Promise.all` over user-supplied work that
re-enters via a callback, native `EventEmitter`s that you wired before
the context was active, or a `Map` of pending requests keyed by id that
gets resolved by an out-of-band consumer. Fix: capture
`context.active()` at the schedule point, restore with `context.with`
at the run point.

**Forge span fires after the request ended.** Symptom: a trace shows a
`forge.User.findMany` span that starts after the HTTP server-span
ended. Cause: a fire-and-forget query that wasn't awaited — usually a
"do this in the background after responding" pattern. The forge span is
correctly parented (the context is still active when it fires), but the
parent span ended before the child's `endTime`, which most tracing
backends render as a child sticking out past its parent's bar. Fix: end
the parent only after the background work; or move the background work
into a job queue so it's a separate trace with its own root.

**Spans missing entirely under high load.** Symptom: under load tests,
only some DB calls produce spans, and the ones that don't are randomly
distributed. Cause: the exporter's batch span processor dropped them
because the buffer filled up. Fix: increase `BatchSpanProcessor`'s
`maxQueueSize` (default 2048) and `maxExportBatchSize` (default 512),
and / or run a local `otel-collector` sidecar with a larger buffer to
absorb the spike.

```ts
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';

new NodeSDK({
  spanProcessors: [
    new BatchSpanProcessor(exporter, {
      maxQueueSize: 16_384,
      maxExportBatchSize: 2_048,
      scheduledDelayMillis: 1_000,
    }),
  ],
});
```

**`db.statement` shows `?` for every value.** Not a bug — that's the
[parameter binding rule](#parameter-binding-and-pii). The raw values are
never in the span. If you really need to debug a specific failed query,
log it through pino with redaction *off* in a non-prod environment, not
through OTel.

**Two spans per query — one from forge, one from the driver.** Cause:
you have both `wireOtel(db, …)` *and* an auto-instrumentation for the
underlying driver (`pg`, `mysql2`, `mongodb`) enabled. Pick one. The
recipe in [Wiring the OTel SDK](#wiring-the-otel-sdk-in-node) shows how
to disable the driver layer.

**Span counts are wildly off between staging and prod.** Cause: prod is
using `ParentBasedSampler` with a low ratio and staging is using
`AlwaysOnSampler`. Fix: same sampler, same ratio, different exporters.
The sampling decision is part of the wire-level traceparent — if staging
and prod disagree on whether to sample, services downstream see
inconsistent decisions and the waterfalls are unreliable.

---

## Worked example: hyper-express + Jaeger

The full stack: forge + hyper-express + OTel + Jaeger via OTLP.

```ts
// src/otel.ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { SemanticResourceAttributes as Attr } from '@opentelemetry/semantic-conventions';

export const sdk = new NodeSDK({
  resource: new Resource({
    [Attr.SERVICE_NAME]: 'orders-api',
    [Attr.SERVICE_VERSION]: process.env.GIT_SHA ?? 'dev',
  }),
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://jaeger:4318/v1/traces',
  }),
  sampler: new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(0.2),
  }),
});

await sdk.start();
```

```ts
// src/db.ts
import { createDb, f, model, wireOtel } from 'forge-orm';
import { trace } from '@opentelemetry/api';

const User  = model('users',  { id: f.id(), email: f.string().unique(), name: f.string() });
const Order = model('orders', { id: f.id(), userId: f.id(), total: f.int() });

export const db = await createDb({
  url: process.env.DATABASE_URL!,
  schema: { user: User, order: Order },
});

wireOtel(db, {
  tracer: trace.getTracer('forge-orm', '1.0.0'),
  recordStatement: process.env.NODE_ENV !== 'production',
  maxStatementLen: 512,
});
```

```ts
// src/server.ts
import './otel';                                  // first — patches modules
import HyperExpress from 'hyper-express';
import { context, propagation, trace, SpanKind } from '@opentelemetry/api';
import { db } from './db';

const tracer = trace.getTracer('orders-api');
const app = new HyperExpress.Server();

app.use((req, res, next) => {
  const carrier = Object.fromEntries(
    Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
  ) as Record<string, string>;
  const ctx = propagation.extract(context.active(), carrier);
  const span = tracer.startSpan(
    `${req.method} ${req.url.split('?')[0]}`,
    { kind: SpanKind.SERVER, attributes: { 'http.method': req.method, 'http.target': req.url } },
    ctx,
  );
  context.with(trace.setSpan(ctx, span), () => {
    res.once('finish', () => { span.setAttribute('http.status_code', res.statusCode); span.end(); });
    next();
  });
});

app.get('/orders/:id', async (req, res) => {
  const order = await db.order.findUnique({ where: { id: req.path_parameters.id } });
  if (!order) return res.status(404).json({ error: 'not_found' });
  const user = await db.user.findUnique({ where: { id: order.userId } });
  res.json({ order, user });
});

await app.listen(Number(process.env.PORT ?? 3000));
```

Run `jaeger-all-in-one` in Docker, point your browser at the Jaeger UI on
port 16686, hit `GET /orders/:id`, and the waterfall shows the HTTP span,
the two `forge.*` spans, and the `db.statement` attribute on each.

---

## Worked example: Next.js Route Handlers + Honeycomb

Next.js (App Router) runs route handlers in either Node or Edge runtimes.
OTel + forge run in Node only — forge requires a real DB driver and
those don't ship to Edge. Use `export const runtime = 'nodejs'` on any
route you want forge spans from.

```ts
// instrumentation.ts — Next.js calls this once at startup
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes as Attr } from '@opentelemetry/semantic-conventions';

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const sdk = new NodeSDK({
    resource: new Resource({
      [Attr.SERVICE_NAME]: 'storefront',
    }),
    traceExporter: new OTLPTraceExporter({
      url: 'https://api.honeycomb.io/v1/traces',
      headers: {
        'x-honeycomb-team': process.env.HONEYCOMB_API_KEY!,
        'x-honeycomb-dataset': 'storefront',
      },
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-pg': { enabled: false },
      }),
    ],
  });
  await sdk.start();
}
```

```ts
// lib/db.ts
import { createDb, wireOtel } from 'forge-orm';
import { trace } from '@opentelemetry/api';
import { schema } from './schema';

export const db = globalThis.__db ?? (globalThis.__db = await createDb({
  url: process.env.DATABASE_URL!,
  schema,
}));

if (!globalThis.__forgeWired) {
  wireOtel(db, { tracer: trace.getTracer('forge-orm'), recordStatement: false });
  globalThis.__forgeWired = true;
}
```

```ts
// app/api/products/[id]/route.ts
export const runtime = 'nodejs';

import { db } from '@/lib/db';
import { NextResponse } from 'next/server';

export async function GET(req: Request, ctx: { params: { id: string } }) {
  const product = await db.product.findUnique({ where: { id: ctx.params.id } });
  if (!product) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json(product);
}
```

Next.js's `@opentelemetry/instrumentation-undici` and HTTP server
instrumentation create the request span; forge's `wireOtel` lands the DB
span under it. In Honeycomb, group by `forge.model` and you have a
per-model latency dashboard with two minutes of work.

The `globalThis.__db` pattern is the same hot-reload survival trick from
[BACKEND.md](BACKEND.md#hot-reload-and-dev-ergonomics) — Next dev rebuilds
the route module on every save, and without the global cache you would
leak a `db` (and a `wireOtel` listener) per rebuild.

---

## Worked example: BullMQ worker tied to a web request

Background jobs are where traces earn their keep. A `POST /signup` that
enqueues a "send welcome email" job is *two* traces by default — the
HTTP one ends when the job is enqueued, the worker's starts when it's
dequeued. Tying them into one trace via OTel's link mechanism is the
worked fix.

```ts
// producer side (web request)
import { trace, context, propagation } from '@opentelemetry/api';
import { Queue } from 'bullmq';

const queue = new Queue('email', { connection: redis });

app.post('/signup', async (req, res) => {
  const user = await db.user.create({ data: req.body });

  // Serialise the active trace context into the job payload.
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);

  await queue.add('welcome', { userId: user.id, _otel: carrier });
  res.json({ ok: true });
});
```

```ts
// worker side
import { Worker } from 'bullmq';
import { trace, context, propagation, SpanKind } from '@opentelemetry/api';
import { db } from './db';

const tracer = trace.getTracer('email-worker');

new Worker('email', async (job) => {
  const parentCtx = propagation.extract(context.active(), job.data._otel ?? {});
  const span = tracer.startSpan('job.welcome', { kind: SpanKind.CONSUMER }, parentCtx);

  await context.with(trace.setSpan(parentCtx, span), async () => {
    try {
      const user = await db.user.findUnique({ where: { id: job.data.userId } });
      await sendWelcomeEmail(user!);
      span.setStatus({ code: 1 });
    } catch (err: any) {
      span.recordException(err);
      span.setStatus({ code: 2, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}, { connection: redis });
```

Two key choices. **`SpanKind.CONSUMER`** marks the worker span as the
receiving end of an async message — tracing backends render this as a
queue-style waterfall (the producer side is `PRODUCER`, the consumer
side is `CONSUMER`, the queue is the implicit gap). **Carrier in the job
payload** rather than as a separate field keeps the job atomic — the
trace context is serialised once, alongside the user-visible payload,
and BullMQ persists it for free.

The trace that comes out the other side has `POST /signup` as the root,
the BullMQ enqueue as an instrumented child, the worker's `job.welcome`
as a separate root that *links* back to the producer (via the propagated
parent), and the `forge.User.findUnique` from the worker as a child of
`job.welcome`. Click any span in Honeycomb / Jaeger / Tempo and the
whole chain is one trace.

---

## Cross-links

- [README — Watching queries](../README.md#watching-queries) — the
  underlying `db.$on('query')` / `db.$on('error')` surface.
- [docs/EVENTS.md](EVENTS.md) — the full event hook reference; what
  attributes you can read off of an event, what `semanticOp` means, when
  events fire, listener ordering, error propagation.
- [docs/LOGGING.md](LOGGING.md) — structured logging recipes
  (pino, winston, bunyan, redaction patterns) using the same event
  surface.
- [docs/METRICS.md](METRICS.md) — Prometheus / OTel metrics
  (counters, histograms, exemplars) and how to link metrics back to the
  spans this doc produces.
- [docs/BACKEND.md](BACKEND.md) — server framework wiring, connection
  pooling, transaction propagation via `AsyncLocalStorage`, multi-tenant
  patterns. The recipes here assume that wiring is in place.
- [docs/TRANSACTIONS.md](TRANSACTIONS.md) — `$transaction` semantics
  and the saga pattern referenced in [Multi-database queries](#multi-database-queries).
- [docs/DRIVERS.md](DRIVERS.md) — which `db.system` value each adapter
  emits, and which auto-instrumentations conflict with which adapter.
