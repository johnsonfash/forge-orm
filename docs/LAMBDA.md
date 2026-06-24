# AWS Lambda

Lambda's "ephemeral container with cold starts" model breaks naive ORM usage — connect-per-request exhausts the DB. This page covers handler-scope connection reuse, RDS Proxy, Aurora Serverless Data API, IAM token refresh, SIGTERM drain, and the cold-start budget for forge-orm setups.

* [The Lambda execution model](#the-lambda-execution-model)
* [The "many short-lived processes" problem](#the-many-short-lived-processes-problem)
* [Handler-scope pool — module-top `createDb`](#handler-scope-pool--module-top-createdb)
* [RDS Proxy — the right shape for Postgres / MySQL](#rds-proxy--the-right-shape-for-postgres--mysql)
* [Pool sizing — one connection per container](#pool-sizing--one-connection-per-container)
* [Cold-start budget](#cold-start-budget)
* [Provisioned concurrency](#provisioned-concurrency)
* [The Init phase — the 10-second warmup window](#the-init-phase--the-10-second-warmup-window)
* [SnapStart and Init Caching](#snapstart-and-init-caching)
* [Connection lifecycle — container death is connection death](#connection-lifecycle--container-death-is-connection-death)
* [SIGTERM handling — Extensions and graceful drain](#sigterm-handling--extensions-and-graceful-drain)
* [IAM auth tokens — 15-minute TTL and in-handler refresh](#iam-auth-tokens--15-minute-ttl-and-in-handler-refresh)
* [Secrets Manager — caching and rotation](#secrets-manager--caching-and-rotation)
* [VPC Lambda — ENI attach latency and Hyperplane](#vpc-lambda--eni-attach-latency-and-hyperplane)
* [Aurora Serverless v2 and the Data API](#aurora-serverless-v2-and-the-data-api)
* [Cost model](#cost-model)
* [Cold-start observability — X-Ray, OTel, EMF](#cold-start-observability--x-ray-otel-emf)
* [Worked example A — Lambda + Postgres + RDS Proxy + IAM](#worked-example-a--lambda--postgres--rds-proxy--iam)
* [Worked example B — Lambda + Aurora Serverless v2 + Data API](#worked-example-b--lambda--aurora-serverless-v2--data-api)
* [Worked example C — Lambda + MongoDB Atlas](#worked-example-c--lambda--mongodb-atlas)
* [Worked example D — BullMQ-on-Lambda pattern](#worked-example-d--bullmq-on-lambda-pattern)
* [Cross-references](#cross-references)

---

## The Lambda execution model

A Lambda function is a container, not a process. AWS keeps it warm
between invocations as long as traffic justifies, freezes it between
requests, and reaps it after some minutes of idleness — the window is
unpublished. Four properties change how you write database code:

* **Ephemeral.** The container can disappear at any time. In-memory
  state has to tolerate vanishing.
* **Single-flight.** One container handles exactly one invocation at
  a time. Concurrent requests spawn *additional* containers, not
  threads.
* **Cold start.** When no warm container exists, AWS spawns one,
  runs your init phase, then runs the handler. You pay handshake
  cost on every cold start.
* **Bounded execution.** Max 15 minutes per invocation. Max ~10 GB
  memory; vCPU scales linearly (1769 MB ≈ one full vCPU). Per region
  — Lambda is regional, the database needs to be too.

The key consequence for forge: **global scope persists across warm
invocations**. A `const db = await createDb(...)` at the top of your
handler module runs once per container — not per request. The same
`db` handle serves thousands of warm invocations between cold starts.
That's the entire optimization. The rest of this page is the discipline
you wrap around that one fact.

For the higher-level pooling rationale see
[POOLING.md → AWS Lambda + RDS Proxy](./POOLING.md#aws-lambda--rds-proxy).

---

## The "many short-lived processes" problem

A long-running Node API has a handful of replicas, each with a tuned
pool. The database sees `replicas × pool.max` connections — bounded.

Lambda fans the same workload across hundreds or thousands of
containers, each a separate Node process. If every container opens
even one connection, you've multiplied. A burst to 500 concurrent
invocations is 500 sockets pointed at a database whose managed tier
typically caps at 100-200 connections.

Three failure shapes:

* **Cold-start handshake spike.** A traffic burst spawns N new
  containers; they all dial at once. The database falls behind on
  auth, new connections queue, cold containers' first request runs
  with `connectionTimeoutMillis` of latency on top.
* **`too many connections for role`.** The database rejects new
  connections outright. Cold containers fail; warm ones are fine —
  the symptom looks like "only some Lambdas fail".
* **Idle socket sprawl.** Warm Lambdas hold sockets across
  invocations. The DB's connection table fills with sockets that
  are 95% idle.

The fix is a pooler in front of the database — RDS Proxy is the right
shape on AWS. Without a pooler the alternatives are reserved
concurrency (503s when exceeded), Aurora Serverless v2 Data API (HTTP
per query, expensive at volume), or an HTTP-native driver like
`@neondatabase/serverless` (Neon only). The discipline below assumes
a pooler.

---

## Handler-scope pool — module-top `createDb`

The single most important pattern. The forge `db` handle goes at
module scope, awaited once during the container's init phase, and
shared across every invocation.

```ts
// handler.ts — module scope. Runs once per container.
import { Pool } from 'pg';
import { createDb, pgDriver } from 'forge-orm';
import { schema } from './schema';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL!, // RDS Proxy endpoint
  max: 1, min: 1,
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 5_000,
  keepAlive: true,
});

const db = await createDb({ schema, driver: pgDriver(pool) });

export const handler = async (event: any) => {
  const user = await db.user.findUnique({ where: { id: event.userId } });
  return { statusCode: 200, body: JSON.stringify(user) };
};
```

What's correct: top-level `await` works in Lambda's Node 18+ when
your function is ESM (`"type": "module"` in `package.json`, or
`.mjs`). `max: 1` matches single-flight. `min: 1` keeps the
connection warm across invocations. `idleTimeoutMillis: 60_000` is
longer than typical warm-invocation gaps.

What kills the pattern: building the pool *inside* the handler
(handshake on every invocation); calling `db.$disconnect()` at the
end of the handler (next warm invocation has no pool); defensive
`try/finally { await db.$disconnect() }` (same bug).

### CommonJS fallback

For CommonJS, the lazy-promise pattern works:

```ts
let dbPromise: Promise<any> | null = null;
function getDb() {
  if (!dbPromise) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 1, min: 1 });
    dbPromise = createDb({ schema, driver: pgDriver(pool) });
  }
  return dbPromise;
}

export const handler = async (event: any) => {
  const db = await getDb();
  return db.user.findUnique({ where: { id: event.userId } });
};
```

First invocation pays the `createDb` cost; every subsequent
invocation hits the cached promise.

---

## RDS Proxy — the right shape for Postgres / MySQL

RDS Proxy is AWS's managed transaction-mode pooler. Lambda connects
to the Proxy endpoint; the Proxy multiplexes those many short-lived
client connections onto a small fixed pool against the real RDS
instance.

```
[ Lambda × 500 containers ]
        │ (500 sockets)
        ▼
[ RDS Proxy ]
        │ (50 sockets, multiplexed)
        ▼
[ RDS Postgres ]
```

The 500-to-50 ratio is the entire point. Without the Proxy, your RDS
instance sees 500 sockets and exhausts `max_connections`. With it,
you size `MaxConnectionsPercent` against RDS and the Lambda fleet's
connection count becomes a property of the Proxy, not the database.

Configuration that matters: **IAM auth** (Lambda's role gets
`rds-db:connect`; the driver calls `signer.getAuthToken()` instead of
a password; no long-lived secret in env vars; token lives 15
minutes); **`MaxConnectionsPercent`** (default 100; set 90 to leave
headroom for migrations, `psql`, metrics exporters);
**`IdleClientTimeout`** (default 30 min; matches typical warm
windows); **VPC placement** (Proxy in your VPC, Lambda same VPC or
peered).

### Pinning — what to avoid

RDS Proxy multiplexes by checking out a backend connection for the
duration of a transaction. Certain statements *pin* the backend for
the rest of the session — multiplication collapses to 1 for that
container until it closes.

Pinning statements (Postgres): `PREPARE`, `SET` (without `LOCAL`),
`LISTEN`/`NOTIFY`, `pg_advisory_lock`, temp tables without
`ON COMMIT DROP`, held cursors outside a transaction.

forge issues none of these by default — same as the
[transaction-mode safety table in POOLING.md](./POOLING.md#transaction-mode-vs-session-mode-poolers--what-breaks).
Traps come from drivers: `postgres.js` prepares any query called more
than once unless you pass `prepare: false`; custom `$executeRaw` with
`SET application_name` should use `SET LOCAL` inside a transaction.

Watch CloudWatch `DatabaseConnectionsCurrentlySessionPinned`. If it's
nonzero in production, something is pinning — find it or your
multiplication factor is gone.

MySQL on RDS Proxy: same shape, fewer pinning footguns. No cross-
statement advisory locks; `PREPARE`/`EXECUTE` round-trips do pin.
`mysql2` doesn't prepare by default unless you call `pool.execute()`
— `pool.query()` is unprepared and safe through the Proxy. Prefer
`query()` on Lambda.

---

## Pool sizing — one connection per container

The right pool size inside one Lambda container is **1**. Lambda is
single-flight; a pool with `max: 10` gives you nine slots that will
never be used — and 500 concurrent containers means 5,000 wasted
sockets.

```ts
const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
  max: 1, min: 1,
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 5_000,
});
```

The arithmetic against the database is `concurrent_containers × 1`.
RDS Proxy sizes its backend pool against `max_connections`; the
Lambda fleet's socket count is bounded by Proxy capacity, not by your
in-process pool.

The only time to raise `max` is parallel queries inside one
invocation — for three concurrent `Promise.all` queries, set `max:
3`. Don't size above your worst-case fan-out.

For `mysql2`: `connectionLimit: 1, queueLimit: 1, idleTimeout:
60_000`. For `mongodb`: `maxPoolSize: 1, minPoolSize: 1,
maxIdleTimeMS: 60_000, serverSelectionTimeoutMS: 5_000`.

---

## Cold-start budget

A cold start is: AWS provisions the container, downloads code, runs
Node, runs top-level module code (including `createDb`), then calls
the handler. Approximate costs on a 1024 MB Lambda in `us-east-1`:

| Phase | Typical cost |
|---|---|
| AWS provisioning | 50-150 ms |
| Node.js runtime boot | 80-120 ms |
| Module imports | 1-3 ms per MB of bundle |
| `await createDb(...)` (pure setup) | 5-15 ms |
| First DB handshake (TCP + TLS + auth) | 30-80 ms |

Levers:

* **Small bundle.** forge is tree-shakeable; import only what you use
  (`createDb, f, model, pgDriver`). Use a bundler (`esbuild`, `tsup`)
  — a bundled handler is 200-400 KB, unbundled can balloon past 5 MB
  with transitive driver deps.
* **ESM and small drivers.** `pg` is CommonJS, ~1 MB unbundled.
  `postgres.js` is ~150 KB bundled and ESM-native.
  `@neondatabase/serverless` is ~50 KB and HTTP-native (no TCP
  handshake).
* **No synchronous deps at module top.** Instantiate AWS SDK v3
  clients eagerly but call them lazily — they return Promises so they
  don't block init unless you `await`.
* **Lazy-load rare branches.** Inline `await import('./report')` for
  paths 90% of invocations don't touch — the cold start doesn't pay
  the import cost.

Ranking for cold-start budget:

1. `@neondatabase/serverless` — HTTP, ~50 KB, smallest cold start.
   Neon only.
2. `postgres.js` with `prepare: false` — small, fast TLS, safe
   through RDS Proxy.
3. `pg` — battle-tested, larger, fine on warm starts.

---

## Provisioned concurrency

Keeps N containers permanently warm at extra cost. Init has already
run; the first request skips the cold-start path entirely.

Worth it for: latency-sensitive user-facing endpoints with cold-start
tails in p95/p99; bursty traffic beyond steady-state warm capacity;
deploy-time spikes (every deploy invalidates warm containers).

Not worth it for: background workers, low-traffic endpoints, anything
where cold-start cost is dominated by the DB handshake rather than
runtime — provisioned concurrency keeps the *container* warm but the
DB connection still needs to open. Pair with `min: 1` to keep both.

Cost: ~$12/month per 1024 MB slot kept warm 24/7. Ten slots ≈
$120/month. Use Auto Scaling to track time-of-day shape.

```yaml
functions:
  api:
    provisionedConcurrency: 10
```

Subtle interaction: provisioned concurrency runs init ahead of time,
so by the time a request arrives, container *and* DB connection are
warm. On-demand cold starts pay both serially on the first request —
typically ~30 ms with both warm vs ~150 ms without either.

---

## The Init phase — the 10-second warmup window

Lambda gives your container a 10-second init phase before the first
invocation. During init, AWS runs your module-top code with **full
vCPU**, regardless of configured memory — a real subsidy for cold-
start work.

Things to do in init: `await createDb(...)`; pre-handshake one
connection (forces TCP + TLS + auth onto the vCPU subsidy);
Secrets Manager / Parameter Store fetches; AWS SDK v3 client
instantiation.

```ts
const pool = new Pool({ /* ... */ });

// Force one handshake during init.
const c = await pool.connect();
await c.query('SELECT 1');
c.release();

const db = await createDb({ schema, driver: pgDriver(pool) });
```

The `SELECT 1` runs on init-phase vCPU — 2-3x faster than the same
query under configured memory — and primes the connection so the
first invocation skips the handshake.

What kills the init subsidy: synchronous filesystem reads of large
files; blocking remote calls past 10 seconds (`Runtime exited with
error: signal: killed` in CloudWatch); imports of modules that
themselves do init work. After init, the function is single-flight at
configured memory.

---

## SnapStart and Init Caching

**SnapStart** is Lambda's "snapshot the container after init" feature
for Java and Python 3.12+ runtimes (as of 2026). Cold-start cost
drops to ~30 ms. **Not available for Node.js**. **Init Caching** is
the cousin SnapStart pattern (`Core.beforeCheckpoint` /
`Core.afterRestore` hooks to close-and-reopen DB connections around
the snapshot boundary, since TCP state doesn't survive snapshotting)
— also not applicable to Node.

For Node Lambda, the cold-start story is provisioned concurrency
(pay-to-skip), init-phase work with the vCPU subsidy, small bundles,
and HTTP-native drivers that skip the TCP handshake. If your latency
budget is sub-100 ms with zero cold-start tail tolerance, Node +
Lambda needs provisioned concurrency — or move to ECS Fargate with a
long-running process.

---

## Connection lifecycle — container death is connection death

When AWS reaps a Lambda container, the process is killed. Sockets
close via OS `RST` to the database; the database reaps its side.
That's fine in steady state. The failure modes:

* **Mid-query reap.** Shouldn't happen during in-flight invocations
  but can during deploys, AZ failover, or memory pressure. Query
  gets `ECONNRESET`. Treat connection-class errors as retriable.
* **Idle reap.** If `idleTimeoutMillis` is shorter than typical idle
  windows, the pool closes the connection. Next invocation
  re-handshakes. Set 60 s+.
* **TCP keepalive mismatch.** Firewalls / NAT close idle TCP after a
  few minutes silently. The pool thinks the socket is valid; next
  query gets `ECONNRESET`. Set `keepAlive: true` with a 30-second
  initial delay.

```ts
const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
  max: 1, min: 1,
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 5_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 30_000,
});
```

One retry on transient errors is right:

```ts
export const handler = async (event: any) => {
  try {
    return await db.user.findUnique({ where: { id: event.userId } });
  } catch (err: any) {
    const transient =
      err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' ||
      err.code === '57P01' /* admin_shutdown */ ||
      err.code === '57P02' /* crash_shutdown */ ||
      err.message?.includes('Connection terminated');
    if (transient) {
      return await db.user.findUnique({ where: { id: event.userId } });
    }
    throw err;
  }
};
```

Multiple retries chew through your timeout. Push real backoff to the
caller (API Gateway, SQS redrive, EventBridge).

---

## SIGTERM handling — Extensions and graceful drain

Lambda gives your function `SIGTERM` ~6 seconds before container
shutdown, but only if a Lambda Extension is registered. Without
Extensions, AWS may kill the container directly.

```ts
process.on('SIGTERM', async () => {
  try { await db.$disconnect(); }
  catch (err) { console.error('[shutdown] drain failed', err); }
});
```

The drain helps the database (clean close, slot released faster). It
does *not* save in-flight work — by the time SIGTERM arrives, the
handler has either completed or AWS is killing it regardless.

To reliably receive SIGTERM, layer an internal extension. The
CloudWatch Lambda Insights extension and the AWS Parameters and
Secrets extension both forward SIGTERM — use either and it works
out of the box. For custom needs, register via the Runtime API
during init (`POST /2020-01-01/extension/register` with `events:
['SHUTDOWN']`, then poll `event/next` until you see the SHUTDOWN
event, drain, and exit).

---

## IAM auth tokens — 15-minute TTL and in-handler refresh

With IAM auth on RDS Proxy, the driver's "password" is a short-lived
token signed with the Lambda's execution role. The token lives 15
minutes; new connections after that need a fresh one.

The naive pattern fails — token generated once at init expires after
15 minutes. A long-warm container holds the pool for hours; its
single connection survives because authenticated once, but if that
connection dies, the next handshake retries with a stale cached token
and fails.

The fix: generate the token **inside `pool.connect()`** so every
handshake gets a fresh one. `pg`'s `password` option accepts an async
function:

```ts
import { Signer } from '@aws-sdk/rds-signer';
import { Pool } from 'pg';

const signer = new Signer({
  hostname: process.env.RDS_PROXY_HOST!,
  port: 5432,
  username: process.env.DB_USER!,
  region: process.env.AWS_REGION!,
});

const pool = new Pool({
  host: process.env.RDS_PROXY_HOST!,
  port: 5432,
  user: process.env.DB_USER!,
  database: process.env.DB_NAME!,
  ssl: { rejectUnauthorized: true },
  max: 1, min: 1,
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 10_000,
  password: async () => signer.getAuthToken(),
});
```

`getAuthToken()` is a fast local signing operation — no remote call —
so it's microseconds per handshake. For `postgres.js`, same shape
with `password: () => signer.getAuthToken()` and `prepare: false`.

The Lambda execution role needs `rds-db:connect` against the proxy
resource — the resource ID is the Proxy ID (`prx-…`), not the
underlying RDS instance ID:

```json
{
  "Effect": "Allow",
  "Action": "rds-db:connect",
  "Resource": "arn:aws:rds-db:us-east-1:123456789012:dbuser:prx-1234abcd/app_user"
}
```

---

## Secrets Manager — caching and rotation

When IAM auth isn't an option (custom auth, Mongo Atlas X.509, MySQL
`mysql_native_password`), credentials live in Secrets Manager. The
naive pattern fetches per cold start (~30 ms each) but breaks on
rotation (long-warm container holds the old password) and throttling
(~5,000 RPS regional limit).

The fix: **AWS Parameters and Secrets Lambda Extension**. Layer it in
and the SDK reads from a local HTTP endpoint that caches per-
container:

```ts
const res = await fetch(
  `http://localhost:2773/secretsmanager/get?secretId=prod/db`,
  { headers: { 'X-Aws-Parameters-Secrets-Token': process.env.AWS_SESSION_TOKEN! } },
);
const { SecretString } = await res.json();
const creds = JSON.parse(SecretString);
```

Fetches once per cold start, caches for the container's lifetime
(default 5-minute TTL), forwards SIGTERM. For rotation, set the TTL
shorter than the rotation interval so cached creds refresh before
old ones expire.

```yaml
functions:
  api:
    layers:
      - arn:aws:lambda:us-east-1:177933569100:layer:AWS-Parameters-and-Secrets-Lambda-Extension:11
    environment:
      SECRETS_MANAGER_TTL: 1800   # 30 minutes
```

---

## VPC Lambda — ENI attach latency and Hyperplane

A Lambda outside a VPC can't reach RDS in a private subnet. Until
~2019, Lambda's VPC integration created a new ENI per cold container;
attach took 10-15 seconds, making VPC cold starts unusable for
latency-sensitive workloads. The Hyperplane architecture (2019+)
reworked this — ENIs are pre-provisioned and shared across
containers; VPC cold-start cost is now ~50-100 ms additional, often
unnoticeable.

```yaml
functions:
  api:
    vpc:
      securityGroupIds: [sg-0a1b2c3d4e5f]
      subnetIds: [subnet-aaa, subnet-bbb, subnet-ccc]  # multi-AZ
```

What still bites: **subnet capacity** (Hyperplane ENIs eat from the
subnet's IP pool — use /24 or larger); **multi-AZ** (list subnets in
3 AZs so a single-AZ outage doesn't take down all Lambda capacity);
**VPC endpoints** (Lambda in VPC can't reach AWS service APIs without
NAT at $0.045/GB or VPC endpoints — Gateway endpoints free for S3 /
DynamoDB, $7/month per Interface endpoint for Secrets Manager, RDS
Proxy management — high-volume fleets pay off in days).

RDS Proxy lives in your VPC, same subnets as RDS. Lambda VPC config
places it in subnets that can reach Proxy subnets. Security groups:
Lambda SG egresses to Proxy SG on 5432; Proxy SG ingresses from
Lambda SG. Lambda doesn't need internet access for the DB path — the
Proxy endpoint is private DNS.

---

## Aurora Serverless v2 and the Data API

Aurora Serverless v2 auto-scales between configured ACU minimum and
maximum based on load. It's a real Postgres/MySQL — same wire
protocol, same `max_connections`, same RDS Proxy compatibility. The
"serverless" part is the autoscaling shape, not the connection model.

**Option 1: Standard TCP + RDS Proxy.** Same shape as the "Lambda +
Postgres + RDS Proxy + IAM" pattern. The only Aurora-specific gotcha
is autoscaling lag — scaling 0.5 → 32 ACU takes seconds, and the
database is sluggish during ramp-up. RDS Proxy queues new connections
in that window; some exceed `connectionTimeoutMillis`. Raise the
function timeout for cold-scale events or pre-warm the cluster.

**Option 2: Data API (no connections).** Aurora's Data API exposes
the database over HTTPS. Each query is an HTTPS POST; the API server
holds the actual database connection. No pool from Lambda's
perspective.

```ts
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { createDb, dataApiDriver } from 'forge-orm';
import { schema } from './schema';

const rds = new RDSDataClient({ region: process.env.AWS_REGION! });
const db = await createDb({
  schema,
  driver: dataApiDriver(rds, {
    resourceArn: process.env.AURORA_CLUSTER_ARN!,
    secretArn: process.env.AURORA_SECRET_ARN!,
    database: process.env.DB_NAME!,
  }),
});
```

When the Data API wins: spiky low-volume workloads (no connection
cost, no `max_connections` ceiling); cross-region Lambda (HTTPS works
anywhere, no VPC peering); heavily parallel fleets (10,000 concurrent
Lambdas would exhaust any RDS Proxy budget).

When it loses: high-frequency queries (20-40 ms HTTPS round-trip vs
sub-millisecond TCP); cost at scale ($0.35/M reads + $0.50/M writes
plus cluster cost; expensive past 100M queries/month); multi-step
transactions (every step is its own HTTPS call).

forge's Data API driver supports `$transaction` via the API's
transaction handle, but per-statement HTTP cost dominates past 2-3
statements. Prefer single-statement upserts over read-then-write
patterns on the Data API.

---

## Cost model

Lambda billing has two axes: invocation count ($0.20/M) and duration
($0.0000166667 per GB-second). At 1024 MB and 100 ms average, one
million invocations costs about $1.85. The pool pattern matters
because the *duration* number is what you actually move.

**Without pool** (handshake on every invocation, +30 ms duration), a
billion invocations/month adds ~$500. **With pool** (handshake
amortized across ~1,000 invocations per warm container), the same
billion costs ~$0.50 in handshake-attributable duration. The 1,000×
reduction is real money — the same reason "right pool shape" matters
for cost, not just latency.

**RDS Proxy** is ~$22/month for a `db.m5.large` (2 vCPU) — trivial
against Lambda savings + connection-budget benefit.

**Provisioned concurrency** is ~$12/month per 1024 MB slot kept warm.
Ten slots ≈ $120/month. Buys sub-100 ms p99 instead of the cold-start
tail. Worth it for user-facing endpoints, brutal for low-traffic
functions.

---

## Cold-start observability — X-Ray, OTel, EMF

You can't optimize cold starts you don't measure.

**X-Ray.** `tracing: Active` on the function. Cold-start spans show
up labeled `Initialization` — init duration is distinct from handler
execution. forge's OTel integration emits per-query spans; pipe them
to X-Ray via the AWS OTel collector layer.

```ts
import { wireOtel } from 'forge-orm';
import { trace } from '@opentelemetry/api';

const offOtel = wireOtel(db, {
  tracer: trace.getTracer('forge', '1.0.0'),
  recordStatement: false,
});

process.on('SIGTERM', () => offOtel());
```

**OpenTelemetry.** ADOT (AWS Distro for OpenTelemetry) ships as a
Lambda layer with a local collector and SDK auto-instrumentation. Add
the layer and set `AWS_LAMBDA_EXEC_WRAPPER: /opt/otel-handler`.

**EMF — Embedded Metric Format.** Structured logs CloudWatch parses
into metrics. Cheap, no SDK:

```ts
function emitMetric(name: string, value: number, unit = 'Milliseconds') {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'Forge',
        Dimensions: [['FunctionName']],
        Metrics: [{ Name: name, Unit: unit }],
      }],
    },
    FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
    [name]: value,
  }));
}

const containerStart = Date.now();
let firstInvocation = true;

export const handler = async (event: any) => {
  if (firstInvocation) {
    emitMetric('ColdStartInitDuration', Date.now() - containerStart);
    firstInvocation = false;
  }
  // …
};
```

Alarm on `ColdStartInitDuration` p99 exceeding your budget. When it
spikes, you'll know something landed in init (a new SDK client, a
synchronous import, a schema regen).

---

## Worked example A — Lambda + Postgres + RDS Proxy + IAM

The canonical shape — Lambda in VPC, RDS Proxy with IAM auth, RDS in
the same VPC.

```ts
// handler.ts
import { Pool } from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import { createDb, pgDriver } from 'forge-orm';
import { schema } from './schema';

const signer = new Signer({
  hostname: process.env.RDS_PROXY_HOST!,
  port: 5432,
  username: process.env.DB_USER!,
  region: process.env.AWS_REGION!,
});

const pool = new Pool({
  host: process.env.RDS_PROXY_HOST!,
  port: 5432,
  user: process.env.DB_USER!,
  database: process.env.DB_NAME!,
  ssl: { rejectUnauthorized: true, ca: process.env.RDS_CA_BUNDLE },
  max: 1, min: 1,
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 30_000,
  statement_timeout: 8_000,
  password: () => signer.getAuthToken(),
});

pool.on('error', (err) => console.error('[pg] idle client error', err.message));

// Force handshake during init's vCPU subsidy.
const c = await pool.connect();
await c.query('SELECT 1');
c.release();

const db = await createDb({ schema, driver: pgDriver(pool) });

process.on('SIGTERM', async () => {
  try { await db.$disconnect(); }
  catch (err) { console.error('[shutdown] drain failed', err); }
});

export const handler = async (event: any) => {
  try {
    const user = await db.user.findUnique({ where: { id: event.userId } });
    return { statusCode: 200, body: JSON.stringify(user) };
  } catch (err: any) {
    const transient =
      err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' ||
      err.code === '57P01' || err.code === '57P02';
    if (transient) {
      const user = await db.user.findUnique({ where: { id: event.userId } });
      return { statusCode: 200, body: JSON.stringify(user) };
    }
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
```

```yaml
# serverless.yml
provider:
  name: aws
  runtime: nodejs20.x
  memorySize: 1024
  timeout: 30
  iam:
    role:
      statements:
        - Effect: Allow
          Action: rds-db:connect
          Resource: arn:aws:rds-db:us-east-1:123456789012:dbuser:prx-abc/${env:DB_USER}
  vpc:
    securityGroupIds: [sg-0a1b2c3d4e5f]
    subnetIds: [subnet-aaa, subnet-bbb, subnet-ccc]

functions:
  api:
    handler: handler.handler
    provisionedConcurrency: 5
    environment:
      RDS_PROXY_HOST: prx-abc.proxy-xyz.us-east-1.rds.amazonaws.com
      DB_USER: app_user
      DB_NAME: app
```

Wired: IAM auth (no env-var password), RDS Proxy (multiplexed
backend), init-phase handshake (vCPU subsidy), `min: 1` (warm across
invocations), SIGTERM drain, transient-error retry, provisioned
concurrency (5 hot containers), multi-AZ VPC.

---

## Worked example B — Lambda + Aurora Serverless v2 + Data API

No TCP. Every query is an HTTPS round-trip. Suits spiky, low-volume,
cross-region workloads.

```ts
// handler.ts
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { createDb, dataApiDriver } from 'forge-orm';
import { schema } from './schema';

const rds = new RDSDataClient({ region: process.env.AWS_REGION! });

const db = await createDb({
  schema,
  driver: dataApiDriver(rds, {
    resourceArn: process.env.AURORA_CLUSTER_ARN!,
    secretArn: process.env.AURORA_SECRET_ARN!,
    database: process.env.DB_NAME!,
  }),
});

export const handler = async (event: any) => {
  // Prefer single-statement ops over multi-step transactions —
  // every step is its own HTTPS call.
  const user = await db.user.upsert({
    where: { id: event.userId },
    create: { id: event.userId, email: event.email },
    update: { last_seen_at: new Date() },
  });
  return { statusCode: 200, body: JSON.stringify(user) };
};
```

```yaml
functions:
  api:
    handler: handler.handler
    timeout: 30
    # No VPC config — Data API is HTTPS.
    iam:
      role:
        statements:
          - Effect: Allow
            Action:
              - rds-data:ExecuteStatement
              - rds-data:BatchExecuteStatement
              - rds-data:BeginTransaction
              - rds-data:CommitTransaction
              - rds-data:RollbackTransaction
            Resource: !Ref AuroraClusterArn
          - Effect: Allow
            Action: secretsmanager:GetSecretValue
            Resource: !Ref AuroraSecretArn
```

Different from A: no VPC; no pool (each query is HTTPS); no IAM
tokens (Data API uses the Lambda role + Secrets Manager internally);
per-query latency higher (~20-40 ms vs sub-millisecond TCP).

---

## Worked example C — Lambda + MongoDB Atlas

Atlas is reachable from Lambda over the public internet (no VPC
peering for most tiers). One-connection-per-container.

```ts
// handler.ts
import { MongoClient } from 'mongodb';
import { createDb, mongoDriver } from 'forge-orm';
import { schema } from './schema';

const client = new MongoClient(process.env.MONGO_URL!, {
  maxPoolSize: 1,
  minPoolSize: 1,
  maxIdleTimeMS: 60_000,
  waitQueueTimeoutMS: 5_000,
  serverSelectionTimeoutMS: 5_000,
  connectTimeoutMS: 5_000,
  socketTimeoutMS: 20_000,
  retryWrites: true,
});

await client.connect();
const db = await createDb({ schema, driver: mongoDriver(client, process.env.DB_NAME!) });

process.on('SIGTERM', async () => {
  try { await client.close(); }
  catch (err) { console.error('[shutdown] mongo close failed', err); }
});

export const handler = async (event: any) => {
  const user = await db.user.findUnique({ where: { id: event.userId } });
  return { statusCode: 200, body: JSON.stringify(user) };
};
```

Atlas-specific: **network access** — IP allowlist needs Lambda's
egress IPs; for non-VPC Lambda that's any AWS IP (practically
`0.0.0.0/0`), so prefer PrivateLink in production. **`maxPoolSize:
1`** — defaults (100) are far too high; concurrent containers × 1 =
total sockets. **Atlas tier limits** — M0 caps at 500 cluster-wide,
M10 at 1500. **Read preference** — for globally distributed reads,
set `readPreference: 'secondaryPreferred'` on the URL; the client
routes reads inside the same pool.

forge's `mongoDriver` is unaware of connection details; `MongoClient`
does pool work, retries, and topology. Handler-scope is identical to
Postgres.

---

## Worked example D — BullMQ-on-Lambda pattern

BullMQ's `Worker` is a long-running polling loop — it `BRPOP`s on the
queue, processes a job, then loops. That doesn't fit Lambda's
invocation model. The polling loop doesn't terminate; Lambda
invocations must. You'd pay full Lambda duration per poll regardless
of whether a job arrived. Two adaptations work.

**Shape 1: SQS as the queue, Lambda as the worker.** Skip BullMQ. SQS
is AWS-native — Lambda consumes messages, automatic retries, DLQs,
batch size control.

```ts
// handler.ts — invoked by SQS.
import { Pool } from 'pg';
import { createDb, pgDriver } from 'forge-orm';
import { schema } from './schema';

const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 1, min: 1 });
const db = await createDb({ schema, driver: pgDriver(pool) });

export const handler = async (event: { Records: { body: string; messageId: string }[] }) => {
  for (const record of event.Records) {
    const job = JSON.parse(record.body);
    await db.$transaction(async (tx) => {
      const order = await tx.order.findUniqueOrThrow({ where: { id: job.orderId } });
      if (order.receipt_sent_at) return;
      await sendReceipt(order);
      await tx.order.update({
        where: { id: order.id },
        data: { receipt_sent_at: new Date() },
      });
    });
  }
};
```

```yaml
functions:
  worker:
    handler: handler.handler
    events:
      - sqs:
          arn: !GetAtt JobsQueue.Arn
          batchSize: 10
          maximumBatchingWindow: 5
```

When SQS+Lambda wins: AWS-native, automatic DLQ, configurable batch
size and visibility timeout. When BullMQ elsewhere wins: cron-
scheduled jobs, rich job state (flows, dependency graphs), existing
BullMQ pipelines you don't want to rewrite.

**Shape 2: BullMQ producer on Lambda, worker on long-running.**
Lambda enqueues; the `Worker` runs on ECS Fargate or EC2. The
producer is fast (Redis HSET) and fits Lambda cleanly:

```ts
// producer.handler.ts
import { Queue } from 'bullmq';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
const queue = new Queue('emails', { connection: redis });

export const handler = async (event: any) => {
  await queue.add('send-receipt', { orderId: event.orderId }, {
    jobId: `receipt:${event.orderId}`, // dedup if Lambda retries
  });
  return { statusCode: 202 };
};

process.on('SIGTERM', async () => {
  await queue.close();
  await redis.quit();
});
```

The Redis connection is held module-scope — same handler-scope-pool
pattern. The actual `Worker` lives elsewhere — see
[BACKEND.md → Background workers with BullMQ](./BACKEND.md#background-workers-with-bullmq).
The fan-out shape (SQS event → Lambda) is the right pattern on AWS.

---

## Cross-references

* [BACKEND.md](./BACKEND.md) — framework wiring, request-scoped
  transactions, BullMQ on long-running processes
* [POOLING.md](./POOLING.md) — pool sizing across runtimes, RDS Proxy
  vs Hyperdrive vs pgbouncer
* [AUTH.md](./AUTH.md) — IAM auth tokens, Secrets Manager rotation,
  Atlas X.509 certs
* [DRIVERS.md](./DRIVERS.md) — driver ports including the Aurora
  Data API driver
* [DEPLOYMENT.md](./DEPLOYMENT.md) — packaging, bundling, environment
  separation
* [WORKERS.md](./WORKERS.md) — Cloudflare Workers + Hyperdrive — the
  edge equivalent of Lambda + RDS Proxy
* [METRICS.md](./METRICS.md) — cold-start observability, EMF, X-Ray
* [POSTGRES.md](./POSTGRES.md) — Postgres-specific tuning,
  `max_connections`
* [MONGO.md](./MONGO.md) — Atlas tier limits, PrivateLink, connection
  options
