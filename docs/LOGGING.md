# Logging

Application-level logging in a forge stack — pino, winston, bunyan, redaction, sampling, request correlation. For platform metrics see [METRICS.md](METRICS.md); for distributed tracing see [TRACING.md](TRACING.md); for the underlying event surface see [EVENTS.md](EVENTS.md).

forge does not own your logger. It owns two events — `query` and `error` — and
expects you to attach them to whichever structured logger your stack already
runs. Every recipe in this doc is a thin adapter between `$on('query', …)` and
your sink: a pino transport, a winston format, a Loki push, a Datadog agent.
The wiring is small enough to fit in one file; the choices that matter are
levels, redaction, sampling, and correlation, and those are the same shape
across loggers.

---

## Contents

- [Scope](#scope)
- [Pick a logger](#pick-a-logger)
- [Pino — recommended default](#pino--recommended-default)
- [Pino setup](#pino-setup)
- [Wiring forge events into pino](#wiring-forge-events-into-pino)
- [Winston](#winston)
- [Bunyan — legacy](#bunyan--legacy)
- [Log levels for forge](#log-levels-for-forge)
- [Redaction](#redaction)
- [Sampling](#sampling)
- [Stack traces and error serializers](#stack-traces-and-error-serializers)
- [Request correlation](#request-correlation)
- [Sensitive query suppression](#sensitive-query-suppression)
- [Production rotation](#production-rotation)
- [Log volume and backpressure](#log-volume-and-backpressure)
- [Per-query overhead](#per-query-overhead)
- [Worked examples](#worked-examples)
- [Related docs](#related-docs)

---

## Scope

This doc is application logging — text and JSON events your code emits about
work the database did, written through a structured logger and shipped to a
log aggregator (Loki, Elasticsearch, Datadog, CloudWatch). Two adjacent
surfaces have their own docs:

- **Metrics** (counters, histograms, gauges) — high-cardinality time-series for
  dashboards and alerts. Same `$on('query')` event powers them. See
  [METRICS.md](METRICS.md).
- **Tracing** (spans, parent/child causal chains) — distributed flows across
  services. forge ships `wireOtel` for this; the span surface is detailed in
  [TRACING.md](TRACING.md).

The three overlap. A slow query should appear as a span in the trace, a bump
in the `forge_query_duration_ms` histogram, and a `warn` log line tying the
two together via the request id. This doc covers the third.

---

## Pick a logger

forge works with anything that accepts an object. The three loggers in active
use across the Node ecosystem:

- **pino** — fastest, JSON-first, transport-based. Default recommendation.
- **winston** — older, format-based, plugin-heavy. Stay on it if a workspace
  is already there; the wiring is identical in shape.
- **bunyan** — also JSON-first, less actively maintained. Legacy stacks only.

Console.log and `debug` are fine for scripts and dev REPLs; they do not belong
in a server that ships logs to an aggregator. The rest of this doc assumes you
want one or more of the three above.

---

## Pino — recommended default

Three reasons pino is the default for forge stacks:

- **Per-call overhead is in the single-digit microseconds** when serializing a
  shallow object. forge emits one event per query — at a few thousand queries
  per second per process, the logger budget has to be near zero. Winston's
  format pipeline is roughly an order of magnitude more expensive per call.
- **JSON-first.** forge's `QueryEvent` is already an object with stable keys
  (`op`, `model`, `duration_ms`, `rowCount`, `semanticOp`). pino preserves
  that shape end-to-end; downstream pipelines (Loki LogQL, Datadog facets,
  ES queries) work without a parser.
- **Transport-based architecture.** Pretty-print, file rotation, and shipping
  to Loki / Elasticsearch / Datadog all run on a worker thread via
  `pino.transport`. The main thread writes to a pipe and never blocks on the
  network.

The cost: pino's API is less forgiving than winston's. There is one log object
shape (level, time, msg, plus your fields). There are no "transports" in the
winston sense — every sink is a separate worker process.

---

## Pino setup

A production-grade pino instance looks like this:

```ts
// src/log.ts
import pino, { stdSerializers } from 'pino';

const isProd = process.env.NODE_ENV === 'production';

export const log = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  base: {
    service: 'api',
    region: process.env.AWS_REGION ?? 'local',
    version: process.env.GIT_SHA ?? 'dev',
  },
  // Top-level redactions — pino walks the path and replaces with '[Redacted]'.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'params.password',
      'params.token',
      'data.password',
      'data.ssn',
      'data.credit_card',
      'where.email',
    ],
    censor: '[Redacted]',
    remove: false,
  },
  serializers: {
    err: stdSerializers.err,
    req: stdSerializers.req,
    res: stdSerializers.res,
  },
  // Stable timestamp for downstream correlation.
  timestamp: pino.stdTimeFunctions.isoTime,
  // Transport runs in a worker — main thread never blocks on the sink.
  transport: isProd
    ? {
        targets: [
          {
            target: 'pino-loki',
            level: 'info',
            options: {
              host: process.env.LOKI_URL!,
              labels: { app: 'api', env: process.env.NODE_ENV },
              batching: true,
              interval: 5,
            },
          },
          // Always keep a stderr stream so kubectl logs still works.
          { target: 'pino/file', level: 'warn', options: { destination: 2 } },
        ],
      }
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
});
```

A few details worth not skipping:

- **`base`** attaches service / region / git-sha to every line, which is what
  makes a global "find all `query_error` from `version=abc123`" query work.
  Don't push these onto each call — `base` writes them once per logger.
- **`pino-pretty` is a dev-only transport.** It allocates per line and forks
  string concatenation paths. Never run it in prod, even via a CLI flag.
- **`pino-elasticsearch`** is the alternative to `pino-loki`. Both ship JSON
  in batches over HTTPS and back off on 429s. Pick whichever your aggregator
  already runs; the wiring stays identical.
- **Stderr fallback.** Even with a remote transport, keep a file/stderr target
  for `warn` and above. If the transport's worker dies you'll still see why.

---

## Wiring forge events into pino

The complete bridge between `$on('query')` and pino. This is the file every
service ends up writing once:

```ts
// src/db-logging.ts
import type { QueryEvent, ErrorEvent } from 'forge-orm';
import { log } from './log';
import { db } from './db';

const SLOW_MS = Number(process.env.FORGE_SLOW_MS ?? 100);
const SAMPLE_RATE = Number(process.env.FORGE_LOG_SAMPLE ?? 0.01);

/** Trim large SQL strings before they hit the log pipeline. */
function clipSql(sql: unknown, max = 1024): string | undefined {
  if (typeof sql !== 'string') return undefined;
  return sql.length > max ? `${sql.slice(0, max)}…` : sql;
}

/** Strip values from params before logging — keeps shape, drops PII. */
function redactParams(p: unknown): unknown {
  if (Array.isArray(p)) return p.map(() => '?');
  if (p && typeof p === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(p)) out[k] = '?';
    return out;
  }
  return undefined;
}

export function wireDbLogging() {
  const offQuery = db.$on('query', (e: QueryEvent) => {
    // Slow queries always — full detail.
    if (e.duration_ms >= SLOW_MS) {
      log.warn(
        {
          forge: {
            adapter: e.adapter,
            op: e.op,
            semanticOp: e.semanticOp,
            model: e.model,
            duration_ms: Math.round(e.duration_ms),
            rows: e.rowCount,
            sql: clipSql(e.sql),
            params: redactParams(e.params),
          },
        },
        'forge.slow_query',
      );
      return;
    }

    // Fast queries — sample at SAMPLE_RATE for a representative trace.
    if (Math.random() < SAMPLE_RATE && log.isLevelEnabled('debug')) {
      log.debug(
        {
          forge: {
            adapter: e.adapter,
            op: e.op,
            model: e.model,
            duration_ms: Math.round(e.duration_ms),
            rows: e.rowCount,
          },
        },
        'forge.query',
      );
    }
  });

  const offError = db.$on('error', (e: ErrorEvent) => {
    log.error(
      {
        forge: {
          adapter: e.adapter,
          op: e.op,
          model: e.model,
          duration_ms: Math.round(e.duration_ms),
          sql: clipSql(e.sql),
          params: redactParams(e.params),
        },
        err: e.error,
      },
      'forge.query_error',
    );
  });

  return () => { offQuery(); offError(); };
}
```

Then `wireDbLogging()` once at boot, right after `createDb` resolves. The
returned thunk is your shutdown hook; call it before `db.$disconnect()` so
the last in-flight error has a chance to publish.

A handful of choices baked in here are deliberate:

- **Slow queries log at `warn`, sampled fast queries at `debug`.** Production
  log level is `info`, so the steady state is "errors plus slow queries".
  Sampled debug lines appear only when an on-call dials the level down — they
  exist so the structure is already there when you need it, not so they ship
  every day.
- **`params` is shape-only by default.** Even with field-level redaction
  upstream, the bind values can still hold customer data forge has no schema
  visibility into. Replacing them with `?` keeps the SQL diagnosable without
  the payload risk. Override for staging if you need full fidelity.
- **`semanticOp` rides on slow-query lines.** A `softDelete` that times out
  reads as `op=update` in the raw event — `semanticOp=softDelete` is the
  signal that lets a dashboard split "user deleted a row" from "row updated".
- **`Math.round(duration_ms)`** — `performance.now()` gives sub-microsecond
  precision; nothing downstream consumes that, and the float trips
  `Number.isSafeInteger` checks in some log shippers.

---

## Winston

If you're already on winston, the wiring is the same shape with three
substitutions: the logger is a singleton, the format pipeline replaces
serializers, and transports are inline.

```ts
// src/log.ts
import { createLogger, format, transports } from 'winston';

export const log = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  defaultMeta: { service: 'api', version: process.env.GIT_SHA },
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    // Field-level redaction — winston doesn't ship redact, so do it in a custom format.
    format((info) => {
      const f = (info.forge ?? {}) as Record<string, unknown>;
      if (f.params) f.params = Array.isArray(f.params) ? f.params.map(() => '?') : '?';
      return info;
    })(),
    format.json(),
  ),
  transports: [
    new transports.Console({ level: 'warn' }),
    // Most teams ship via an agent (fluent-bit / vector) reading the console — keep it simple.
  ],
});
```

The forge bridge is line-for-line the same as the pino version above, with
`log.warn(meta, msg)` calls swapped for winston's `log.warn(msg, meta)`
argument order. Winston's per-line cost is higher than pino's; if you're at
~10k queries/sec/process consider moving the structured log handler to a
worker thread.

---

## Bunyan — legacy

Bunyan is fine for read-side. New writes go to pino; legacy services keep
bunyan until they need a feature it doesn't support. The wiring:

```ts
import bunyan from 'bunyan';

export const log = bunyan.createLogger({
  name: 'api',
  streams: [{ level: 'info', stream: process.stdout }],
  serializers: bunyan.stdSerializers,
});
```

The forge bridge calls `log.warn({ forge: {…}, err }, 'forge.slow_query')` with
the same payload. Bunyan does not have a redact equivalent; do it in your
bridge function as shown above and never log raw `params`.

---

## Log levels for forge

A consistent level scheme keeps the prod log volume predictable.

| Level   | When forge emits | Examples |
|---------|------------------|----------|
| `trace` | Never on its own. Tooling only. | `forge push` step-by-step DDL execution; doctor probe internals. |
| `debug` | Sampled per-query in dev, opt-in in prod. | A single `findMany` line with op/model/duration/rows. |
| `info`  | Lifecycle. | `forge.connected`, `forge.migrated`, `forge.disconnected`. |
| `warn`  | Slow queries, retries, drift on boot. | `forge.slow_query`, `forge.deadlock_retry`, `forge.drift_detected`. |
| `error` | Driver errors that escape the call. | `forge.query_error`, `forge.connection_lost`. |
| `fatal` | Unrecoverable boot. | `forge.bootstrap_failed` before the server takes traffic. |

Two rules that prevent the log from turning into noise:

- **Don't log success at `info`.** A handler that successfully created a row
  doesn't need a forge log line — the HTTP access log already records it. The
  forge log is for "the database did something interesting" only.
- **Use `warn` for things that completed but shouldn't have happened.** A
  deadlock that retried and succeeded is a `warn`, not an `error`. An on-call
  who sees `error` should always have a user-visible failure to investigate.

---

## Redaction

forge events carry two payloads that can leak user data:

- **`params`** — the bind values for SQL, or the Mongo args object. These can
  hold emails, hashed-but-still-sensitive tokens, personal names, prices.
- **`sql`** — for `$queryRaw` calls the SQL itself can contain literals you'd
  rather not ship to a log aggregator.

Three layers of defence, all of which you want:

**1. Field-level redact in the bridge.** The example above replaces `params`
   with a shape-only placeholder. This is the only layer that doesn't
   require knowing every field name in advance.

**2. Path-based redact in pino.** For HTTP request bodies and headers that
   transit the same logger, pino's `redact.paths` censors known keys before
   serialization:

```ts
redact: {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.body.password',
    'forge.params',         // belt + braces with the bridge-side redact
    '*.email',              // wildcard hits deeply nested email fields
    '*.ssn',
    '*.credit_card',
  ],
  censor: (val, path) => `[Redacted ${path.join('.')}]`,
}
```

   Wildcards (`*`) traverse one level at a time — `*.email` will catch
   `{ user: { email: 'x' } }` but not `{ data: { user: { email: 'x' } } }`. Use
   explicit paths when the depth is known.

**3. Schema-level scrubbing.** For models known to hold PII, scrub at the
   row-emit site. The cleanest pattern is to attach a `toLog()` method on the
   model output via a small helper:

```ts
function safe(user: User) {
  return { id: user.id, role: user.role, created_at: user.created_at };
}

log.info({ user: safe(u) }, 'user.created');
```

The bridge's shape-only `params` is the only one of the three that catches the
unknown-unknown — a new column added without updating the redact list. Keep it
on even when the upstream lists look complete.

---

## Sampling

A 1k-rps endpoint that logs every query produces ~86M lines/day per replica.
The slow-query + sampled-debug pattern in the bridge above cuts that to
~hundreds of slow lines plus 1% of the rest — typically <1M lines/day.

Three sampling strategies, mix as needed:

**Sample by rate.** `Math.random() < SAMPLE_RATE` — cheapest, statistically
correct in aggregate. Use for the "trace 1% of fast queries" case. Misses
anything that happens once.

**Sample by intent.** Always log mutations, sample reads.

```ts
const isWrite = e.op === 'insert' || e.op === 'update' || e.op === 'delete'
  || (e.adapter === 'mongo' && /insert|update|delete|findOneAnd/i.test(e.op));
if (isWrite || Math.random() < SAMPLE_RATE) { /* log */ }
```

**Sample by tail.** Always log slow + always log errors + sample the rest.
This is the default in the bridge above; it's the only strategy that catches
the rare-but-bad event without burning quota on the common case.

Don't sample `error` events. Errors are already rare; sampling drops the
signal you need to debug.

---

## Stack traces and error serializers

pino's `stdSerializers.err` is the only serializer you should attach by
default. It walks the prototype chain, captures the message, the stack, and
any `cause`, and produces a JSON-safe object with the stack as a single newline-
separated string.

```ts
import pino, { stdSerializers } from 'pino';

const log = pino({ serializers: { err: stdSerializers.err } });

try { throw new Error('boom'); }
catch (e) { log.error({ err: e }, 'boom'); }
```

The key has to be `err` (not `error`) for `stdSerializers.err` to fire — the
serializer keys off the field name. Inside the forge bridge use `err: e.error`,
not `error: e.error`, or the stack will arrive in your aggregator as the
default Node `inspect()` output.

For driver errors that wrap a SQLSTATE code, the stack is rarely useful but the
code is. Pull it onto the top level:

```ts
db.$on('error', (e) => {
  const code = (e.error as any)?.code ?? (e.error as any)?.sqlState;
  log.error({ forge: { op: e.op, model: e.model, code }, err: e.error }, 'forge.query_error');
});
```

Multi-line stacks render fine through pino-pretty in dev and survive every
JSON-aware aggregator. Avoid `JSON.stringify(err)` — it produces `{}` for a
plain `Error` because the relevant fields are non-enumerable.

---

## Request correlation

Every log line forge emits needs the request id of the caller. Without it the
slow-query log is unsearchable — you see the SQL, but you can't find the user
who hit it.

The pattern is `AsyncLocalStorage`. Capture the request id at the middleware
boundary, then read it inside the forge listener. pino's `child` logger
attaches it to every line in scope.

```ts
// src/request-ctx.ts
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestCtx { req_id: string; user_id?: string; tenant_id?: string }
export const ctx = new AsyncLocalStorage<RequestCtx>();
export const currentCtx = () => ctx.getStore();
```

```ts
// src/log.ts (extension)
import { log as baseLog } from './log';
import { currentCtx } from './request-ctx';

/** Inside a forge listener we don't have access to the per-request child logger,
 *  so we synthesize the fields from the ALS store on demand. */
export function logWithCtx() {
  const c = currentCtx();
  return c ? baseLog.child({ req_id: c.req_id, user_id: c.user_id, tenant_id: c.tenant_id }) : baseLog;
}
```

```ts
// src/db-logging.ts (replace `log` with `logWithCtx()` inside the listeners)
db.$on('query', (e) => {
  if (e.duration_ms < SLOW_MS) return;
  logWithCtx().warn({ forge: {…} }, 'forge.slow_query');
});
```

The middleware that seeds `ctx`:

```ts
// hyper-express
app.use((req, res, next) => {
  const req_id = (req.header('x-request-id') ?? crypto.randomUUID()) as string;
  res.header('x-request-id', req_id);
  ctx.run({ req_id }, () => next());
});
```

Two correctness rules:

- **Propagate `x-request-id` on the response.** Downstream services and the
  user's browser need to be able to quote it back to support. The aggregator
  cross-links the same id across services.
- **Set the ALS store inside the same scope as the tx.** The `txStore.run(tx,
  …)` in [BACKEND.md](BACKEND.md#hyper-express) and the `ctx.run(…)` in this
  doc need to nest under the same async chain or the inner store won't see
  the outer. The easiest fix is to combine them in one middleware.

---

## Sensitive query suppression

A subset of queries should never reach the structured log at full fidelity.

**DDL via `$executeRaw`.** A `DROP TABLE` or `TRUNCATE` should log that it
happened, not the table. Most aggregators index every value; a leaked
production table name in a search corpus is its own incident class.

```ts
db.$on('query', (e) => {
  const sqlText = typeof e.sql === 'string' ? e.sql : '';
  if (/^\s*(drop|truncate|alter)\s/i.test(sqlText)) {
    log.warn({ forge: { op: e.op, model: e.model, duration_ms: e.duration_ms } }, 'forge.ddl_executed');
    return;
  }
  // …normal slow-query branch…
});
```

**Raw SQL with literals.** `forge` parameterises every generated statement,
but `db.$queryRaw\`SELECT * FROM users WHERE email = ${email}\`` substitutes
the literal at compile time. Treat `op === 'raw'` as "I cannot redact this
without a SQL parser" and either log shape only or skip it entirely.

```ts
if (e.op === 'raw') {
  log.warn({ forge: { op: 'raw', duration_ms: e.duration_ms, rows: e.rowCount } }, 'forge.raw_query');
  return;
}
```

**Admin / impersonation queries.** Tag the call site via the ALS store and
elevate the log level so they're always retained:

```ts
ctx.run({ ...currentCtx()!, admin: true }, () => admin.user.update({ where, data }));
```

The listener checks `currentCtx()?.admin` and logs at `info` (not sampled,
not redacted shape-only) with the operator's `user_id` attached. Audit lives
in the database; this is the "who did what when" mirror in the aggregator.

---

## Production rotation

Two strategies, picked by where the log is written.

**Process writes to stdout, OS rotates the file.** This is the default in
every container platform. pino writes to fd 1; Docker/Kubernetes/systemd
catch it; logrotate (or the platform's equivalent) handles the file. forge
doesn't see this layer at all.

**Process writes to a file, pino's transport rotates.** For the rare bare-VM
deploy without a log shipper, use `pino.transport` with `pino-roll`:

```ts
transport: {
  target: 'pino-roll',
  options: {
    file: '/var/log/api/app.log',
    frequency: 'daily',
    mkdir: true,
    size: '500m',
  },
},
```

OS-level `logrotate` against the same file path conflicts — pick one.
`pino-roll` rotates on size or schedule whichever hits first; `logrotate`
will SIGHUP the wrong process if pino's transport runs in a worker.

For Kubernetes: never write to the container's local disk. Let stdout flow,
and let the platform's log aggregator (`fluent-bit` → Loki, `vector` → ES,
the Datadog daemonset) ship it. The transport-on-worker pattern in
[Pino setup](#pino-setup) is for the rare case where you want pino to push
directly without an agent in the path.

---

## Log volume and backpressure

Pino's worker transports buffer in memory. Default buffer size is small and
the worker flushes on every write — fine for steady traffic. Under a burst:

- **`pino.destination({ sync: false, minLength: 4096 })`** batches the
  internal buffer; calls return after a memcpy, not after the write syscall.
- **`pino.transport({ ... worker: { autoEnd: false } })`** prevents pino from
  ending the worker when the parent exits, so an in-flight buffer isn't
  dropped on SIGTERM.

The combination keeps the steady-state cost low and the burst tail bounded.
If the transport falls behind, pino does not drop lines silently — it emits
on `process.on('warning')` once the worker queue passes `highWaterMark`.
Surface that warning to your metrics layer:

```ts
process.on('warning', (w) => {
  if (w.name === 'PinoTransportWarning') {
    metric('forge.log.dropped', 1, { transport: 'pino' });
  }
});
```

For winston, the equivalent backpressure signal is `transport.on('drop', …)`.
Bunyan has no such hook — its sole defence is `dropBufferedMsgs: true`, which
prefers to drop rather than block.

The "logs blocking the request thread" failure mode shows up as p99 latency
growing in lockstep with log volume. The fix is always one of three: cut log
volume (raise the slow threshold, drop the sample rate), move the transport
to a worker, or buffer more aggressively. Solving it with "more log shipper
replicas" treats the symptom downstream.

---

## Per-query overhead

The cost of `$on('query', …)` is:

- Zero when no listeners are registered. forge's `emitQuery` early-returns on
  an empty listener array; the `track` helper short-circuits the `Date.now()`
  and `performance.now()` calls.
- ~1-2µs per listener call when one is registered (a function call plus the
  object pass-through).
- The cost of your handler. For pino with no transport on the hot path, the
  handler itself is ~1-3µs per line.

At 1k queries per second per replica with the bridge above:

- Slow queries (>100ms): ~10/s in steady state — negligible.
- Sampled debug (1%): ~10/s in dev — negligible.
- The branch deciding which path to take: ~10µs/s per replica.

The first thing that becomes load-bearing is your log aggregator's ingest
quota, not pino. If you're CPU-bound on the logging path, the culprits in
descending order are: `pino-pretty` in production (don't), unsampled debug
(don't), and a synchronous transport (move it to a worker).

---

## Worked examples

### hyper-express + pino + forge

The full file. `db.ts`, `log.ts`, and `db-logging.ts` from earlier sections
plus the server wiring:

```ts
// src/server.ts
import HyperExpress from 'hyper-express';
import { randomUUID } from 'node:crypto';
import { db, scoped } from './db';
import { log } from './log';
import { ctx } from './request-ctx';
import { wireDbLogging } from './db-logging';

const offDbLog = wireDbLogging();
const app = new HyperExpress.Server();

app.use((req, res, next) => {
  const req_id = (req.header('x-request-id') ?? randomUUID()) as string;
  res.header('x-request-id', req_id);
  ctx.run({ req_id }, () => next());
});

app.post('/users', async (req, res) => {
  const body = await req.json();
  const start = performance.now();
  try {
    const user = await scoped().user.create({ data: body });
    res.json(user);
    log.info({ req_id: ctx.getStore()?.req_id, route: 'POST /users', status: 200, ms: Math.round(performance.now() - start) }, 'http.request');
  } catch (err) {
    log.error({ req_id: ctx.getStore()?.req_id, route: 'POST /users', err }, 'http.error');
    res.status(500).json({ error: 'internal' });
  }
});

await app.listen(Number(process.env.PORT ?? 3000));

process.on('SIGTERM', async () => {
  log.info('shutdown_started');
  offDbLog();
  await app.close();
  await db.$disconnect();
  log.info('shutdown_complete');
  process.exit(0);
});
```

What ships to the aggregator under load:

- `http.request` per successful request, with `req_id`, route, status, ms.
- `http.error` per 5xx, with `err` (full stack via `stdSerializers.err`).
- `forge.slow_query` per query >100ms, with `req_id` from the ALS store.
- `forge.query_error` per driver error, with code and stack.

You can search the aggregator for any `req_id` and reconstruct the request
end-to-end, including which queries ran slowly and which raised.

### Next.js Route Handlers + structured log

In an App Router project, the request id comes off the headers helper; the
ALS store is the same shape.

```ts
// app/api/orders/route.ts
import { headers } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { db, scoped } from '@/lib/db';
import { log } from '@/lib/log';
import { ctx } from '@/lib/request-ctx';

export async function POST(req: Request) {
  const h = await headers();
  const req_id = h.get('x-request-id') ?? randomUUID();
  return ctx.run({ req_id }, async () => {
    const body = await req.json();
    try {
      const order = await scoped().order.create({ data: body });
      log.info({ req_id, route: 'POST /api/orders', status: 200 }, 'http.request');
      return Response.json(order);
    } catch (err) {
      log.error({ req_id, route: 'POST /api/orders', err }, 'http.error');
      return Response.json({ error: 'internal' }, { status: 500 });
    }
  });
}
```

Two Next-specific notes. **Edge runtime cannot run pino-loki** — its transport
worker uses `worker_threads`, which the Edge sandbox doesn't expose. Pin the
route to the Node runtime (`export const runtime = 'nodejs'`) or write to
`console.log` and let Vercel's log drains pick up the JSON. **A single
`AsyncLocalStorage` is safe across requests on Node**, including under
Next's RSC concurrency model — the `.run(store, fn)` scope is what isolates.

### Cron job with run-id

A scheduled job is one logical operation that fans out into hundreds of
queries. Give it a `run_id` so all of them correlate:

```ts
// jobs/nightly-rollup.ts
import { randomUUID } from 'node:crypto';
import { db } from './db';
import { log } from './log';
import { ctx } from './request-ctx';

async function run() {
  const run_id = randomUUID();
  await ctx.run({ req_id: `cron:nightly-rollup:${run_id}` }, async () => {
    const start = performance.now();
    log.info({ run_id, job: 'nightly-rollup' }, 'cron.started');

    try {
      let processed = 0;
      for await (const order of db.order.findManyStream({ where: { rolled_up: false } })) {
        await db.report.upsert({
          where: { day: order.day },
          create: { day: order.day, total: order.total, count: 1 },
          update: { total: { increment: order.total }, count: { increment: 1 } },
        });
        await db.order.update({ where: { id: order.id }, data: { rolled_up: true } });
        if (++processed % 1000 === 0) log.info({ run_id, processed }, 'cron.progress');
      }

      log.info({ run_id, processed, ms: Math.round(performance.now() - start) }, 'cron.completed');
    } catch (err) {
      log.error({ run_id, err }, 'cron.failed');
      throw err;
    }
  });
}

run().finally(() => db.$disconnect());
```

The forge bridge picks up `req_id = cron:nightly-rollup:<uuid>` from the ALS
store and stamps it on every `forge.slow_query` line the job emits. The
aggregator's "find slow queries from last night's rollup" search becomes a
single filter.

For BullMQ workers, the equivalent shape lives in the job processor:

```ts
const worker = new Worker('emails', async (job) => {
  await ctx.run({ req_id: `bullmq:emails:${job.id}` }, async () => {
    // …job body — every forge query inside picks up the req_id…
  });
});
```

The cost is one extra `AsyncLocalStorage.run` per job — negligible — and the
benefit is that a stuck job's queries can be found by quoting the BullMQ id
the dashboard already shows.

---

## Related docs

- [EVENTS.md](EVENTS.md) — the `$on('query')` and `$on('error')` event
  surface this doc consumes. Listener semantics, ordering, and the full
  `QueryEvent` shape live there.
- [TRACING.md](TRACING.md) — `wireOtel`, span attributes, and how to keep
  logs / traces / metrics correlated by the same `req_id`.
- [METRICS.md](METRICS.md) — counters and histograms off the same event
  surface, plus the Prometheus / OTel metric exporters forge ships.
- [BACKEND.md](BACKEND.md) — framework wiring, `AsyncLocalStorage` for
  request-scoped tx, and the slow-query pino snippet this doc expands on.
- [SECURITY.md](SECURITY.md) — full redaction surface (request bodies, auth
  headers, audit-log payloads), not just the forge-event slice.
