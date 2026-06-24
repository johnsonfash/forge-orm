# Idempotency keys

Retries are inevitable — clients time out, networks fail, mobile apps re-send. Idempotency keys let the same request be sent multiple times and produce one effect. This page documents the Stripe-style model, how to wire it on top of forge-orm's atomic upsert primitive, and how it composes with sagas, webhooks, and job queues.

The [Idempotency](./MUTATIONS.md#idempotency) section in `docs/MUTATIONS.md`
is the two-paragraph summary. The [Idempotency-Key
interaction](./ERRORS.md#idempotency-key-interaction) section in
`docs/ERRORS.md` explains why retrying without a key is unsafe. This page is
the full reference — the table schema, the middleware, the dialect race
characteristics, the BullMQ binding, and the four worked examples.

Everything below assumes 2.5.x.

## Contents

* [Why idempotency keys](#why-idempotency-keys)
* [The Stripe / Square model](#the-stripe--square-model)
* [Storing keys with forge-orm](#storing-keys-with-forge-orm)
* [Atomic check-and-insert via upsert](#atomic-check-and-insert-via-upsert)
* [Replay safety — same body returns, different body conflicts](#replay-safety--same-body-returns-different-body-conflicts)
* [TTL and pruning](#ttl-and-pruning)
* [Storage choices — DB vs Redis](#storage-choices--db-vs-redis)
* [Sagas and compensation](#sagas-and-compensation)
* [Webhook receivers](#webhook-receivers)
* [BullMQ and job queues](#bullmq-and-job-queues)
* [Transaction-level retry](#transaction-level-retry)
* [Composing with upsert](#composing-with-upsert)
* [Idempotency vs unique constraint](#idempotency-vs-unique-constraint)
* [HTTP middleware](#http-middleware)
* [Per-dialect race characteristics](#per-dialect-race-characteristics)
* [Worked examples](#worked-examples)
* [Cross-references](#cross-references)

---

## Why idempotency keys

A `POST /payments` call with a $20 body charges the customer $20. A retried
`POST /payments` call with the same body charges the customer $40. That is
the bug. The customer's app saw a timeout and tapped again; the first call
had already cleared the gateway, the second one cleared a second time.

Every layer between the user and the database can drop or duplicate a
request — the user's network, the HTTP client (`fetch` retries in some
runtimes, the AWS SDK on connection errors, gRPC on `UNAVAILABLE`), the
load balancer's health-check failover, the application's own retry
harness (see
[docs/ERRORS.md#exponential-backoff-with-jitter](./ERRORS.md#exponential-backoff-with-jitter)),
the driver's socket-error reconnect. No single layer where you can say
"retries don't happen here." The only way to make a write safe under
retries is to make the write itself recognise the retry — same key,
same result.

The HTTP `Idempotency-Key` header is the contract that carries the
recognition signal across every layer. Stripe established it in 2015 and
it is now an IETF draft
([draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)).
Square, GitHub, Adyen, PayPal, and dozens of other APIs use the same
shape. The cost of doing it right is one table and one middleware. The
cost of not doing it is a double-charge bug that surfaces only under
network weather — precisely when you cannot reproduce it.

---

## The Stripe / Square model

Three rules.

1. **The client picks the key.** A UUIDv4 per logical operation. The client
   reuses the same key when retrying the same operation, picks a new key
   for a new operation. The server never picks the key — it would not know
   which retries belong to which logical request.
2. **The server caches the response.** First request: do the work, store
   the key alongside the response body and status. Subsequent requests with
   the same key: return the stored response without re-running the work.
3. **Same key + different body = conflict.** If the same key arrives with a
   different body, return 422 / 400 — the client has reused a key for two
   different operations, which is a client bug.

```
POST /payments        Idempotency-Key: 7a2c5e1d-...
→ 1st  — do work, cache 201 { id: "ch_...", amount: 2000 }
→ 2nd  — same key, same body — replay 201 { id: "ch_...", amount: 2000 }
→ 3rd  — same key, different body — reject 422 { error: "idempotency_key_reused" }
```

Stripe ([stripe.com/docs/api/idempotent_requests](https://stripe.com/docs/api/idempotent_requests))
and Square ([developer.squareup.com/docs/working-with-apis/idempotency](https://developer.squareup.com/docs/working-with-apis/idempotency))
differ on the conflict status code (Stripe 400, Square 409) and the
default TTL (both ~24h). The core model is identical.

* **Key scope.** Globally unique within your service. Stripe scopes
  per-account; you typically scope per-tenant or per-API-key. The
  storage row's unique is `(scope, idempotency_key)` — see
  [Storing keys with forge-orm](#storing-keys-with-forge-orm).
* **Cached response includes the status code.** A 422 from the first
  request is also cached — the rejection is the result.
* **Only mutating verbs.** `POST`, `PUT`, `PATCH`, `DELETE`. `GET` is
  idempotent by HTTP definition.
* **Only on the request side.** Webhooks are a different shape — the
  receiver dedupes. See [Webhook receivers](#webhook-receivers).

---

## Storing keys with forge-orm

The storage model is one table:

```ts
import { f, model } from 'forge-orm';

export const IdempotencyRecord = model('idempotency_records', {
  id:              f.id(),
  scope:           f.string(),       // tenant id, api key id, account id
  idempotency_key: f.string(),
  request_hash:    f.string(),       // sha256 of canonicalised body
  response_status: f.int(),
  response_body:   f.json().nullable(),
  state:           f.string().default('pending'),  // 'pending' | 'completed' | 'failed'
  created_at:      f.timestamp().default('now'),
  completed_at:    f.timestamp().nullable(),
  expires_at:      f.timestamp(),
}, {
  uniques: [['scope', 'idempotency_key']],
  indexes: [
    { fields: ['expires_at'] },           // TTL pruner
    { fields: ['state', 'created_at'] },  // stuck-pending sweeper
  ],
});
```

* **`scope`** — multi-tenant safety. Two tenants can pick the same UUIDv4
  by collision (vanishingly unlikely) or by deliberate replay (much more
  likely if a key leaks across a trust boundary). The compound unique
  enforces the boundary at the DB layer.
* **`request_hash`** — sha256 of the canonicalised body (keys sorted,
  JSON-stable). Detects same-key / different-body retries. See
  [Replay safety](#replay-safety--same-body-returns-different-body-conflicts).
* **`response_status` separate from `response_body`** — cached replays
  return the original status (201, 422, 503) without parsing a wrapper.
* **`state`** — `pending` while a worker is mid-flight; `completed` on
  cache hit; `failed` for permanent failures the client shouldn't keep
  retrying. Concurrent retries that hit `pending` park rather than
  re-execute (see [Pending state](#pending-state-and-concurrent-retries)).
* **`expires_at`** — 24h default. See [TTL and pruning](#ttl-and-pruning).
* **The compound unique** is the load-bearing constraint. Without it,
  two parallel retries that race past the lookup both reach the create
  path and you double-execute. Every dialect enforces it under
  contention — see [Per-dialect race characteristics](#per-dialect-race-characteristics).

The two secondary indexes pull their weight: `(expires_at)` for the
pruner, `(state, created_at)` for the stuck-pending sweeper. Past ~10M
keys, partition per-tenant and drop the compound to a single unique on
`idempotency_key`.

---

## Atomic check-and-insert via upsert

The wrong shape — `findFirst` then `create` — has a race window between
the two calls where a second retry can win and the create throws
`P2002`. The right shape is `upsert`, which forge compiles to a single
atomic statement on every adapter (see
[docs/MUTATIONS.md#upsert](./MUTATIONS.md#upsert)):

```ts
const record = await db.idempotencyRecord.upsert({
  where:  { scope_idempotency_key: { scope, idempotency_key: key } },
  create: {
    scope, idempotency_key: key, request_hash: hash,
    response_status: 0, state: 'pending',
    expires_at: new Date(Date.now() + 24 * 3600 * 1000),
  },
  update: {},   // no-op on re-arrival
});
```

The unique on `(scope, idempotency_key)` is the conflict target. Per
adapter: `INSERT … ON CONFLICT … DO UPDATE` (Postgres / SQLite / DuckDB),
`INSERT … ON DUPLICATE KEY UPDATE` + `SELECT` (MySQL), `MERGE` (MSSQL),
`updateOne({ upsert: true })` (Mongo). One round-trip, race-safe against
any number of concurrent retries.

The returned row is either the freshly-inserted `pending` record (first
arrival) or the existing record (any subsequent arrival). The caller
branches on `state`:

```ts
if (record.state === 'completed') return replay(record);   // cache hit
// pending → either we just inserted, or a parallel worker is mid-flight.
//           See "Pending state" below.
```

The decision of "execute or replay" is one DB round-trip, not two — that
is the property worth preserving.

### Pending state and concurrent retries

Two retries arriving inside the same 100ms window both call the `upsert`.
One wins the create; the other sees the `pending` row. Three reasonable
responses for the loser:

* **Park and re-read.** Poll the row every 100-200ms until `state` flips
  to `completed` or `failed`. Stripe and Square both do this for ~30s
  before falling back to 409. The DB-only version is one indexed lookup
  per poll — 150 round-trips on the contention path, zero on the
  no-contention path.
* **Return 409 immediately.** Cheaper for the server, more chatter on
  the wire. Reasonable for routes where the client can transparently
  retry.
* **Pubsub on Redis.** Winning worker publishes `completed:<key>`; loser
  subscribes. Lowest latency, requires Redis.

---

## Replay safety — same body returns, different body conflicts

The `request_hash` column on `IdempotencyRecord` is what closes the
second hole in the model. Two requests with the same key but different
bodies cannot both be honoured — one of them is a client bug.

```ts
import { createHash } from 'node:crypto';

function hashBody(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalise(body)))
    .digest('hex');
}

function canonicalise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalise);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort()
      .reduce((acc, k) => { acc[k] = canonicalise((v as any)[k]); return acc; },
              {} as Record<string, unknown>);
  }
  return v;
}
```

`canonicalise` puts keys in sorted order so that
`{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` hash to the same value. JSON's
property order is unspecified — without canonicalisation, two clients
sending semantically-identical bodies can hash differently and trigger
spurious 422s.

The check, against the `upsert` result:

```ts
if (record.request_hash !== hash) {
  return {
    status: 422,
    body: { error: 'idempotency_key_reused', message: 'Key was used for a different request body.' },
  };
}
```

Note that the check runs after the `upsert`. On first arrival the
`request_hash` on the row is the one we just wrote, so the check trivially
passes. On a duplicate arrival, the row's `request_hash` is from the
original request — if the new body hashes the same, we proceed to the
replay path; if it hashes differently, we return 422.

Stripe returns 400 here; Square returns 409. Both are defensible — the
client did something wrong but recovering is possible (pick a new key,
re-send). 422 ("unprocessable entity") is the most precise but the field
is small. Pick one for your service and stick with it.

---

## TTL and pruning

24 hours is the Stripe default and a sensible starting point. After the
TTL, the same key can be used again for a new operation.

```ts
async function pruneExpiredKeys() {
  const { count } = await db.idempotencyRecord.deleteMany({
    where: { expires_at: { lt: new Date() } },
  });
  return count;
}

async function sweepStuckPending() {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);   // 5 minutes
  await db.idempotencyRecord.updateMany({
    where: { state: 'pending', created_at: { lt: cutoff } },
    data:  { state: 'failed', response_status: 500 },
  });
}
```

The `(expires_at)` index makes the prune O(deleted); `(state, created_at)`
makes the sweep O(stuck). Run both from a cron at one-minute intervals.
Pick the sweep cutoff larger than your slowest legitimate request — five
minutes covers most APIs. Marking stuck rows `failed` rather than
deleting lets a retry see the failure and decide whether to generate a
fresh key.

Use a longer TTL for long-running operations (a 6-hour payout wants 48h
of retry window), async webhooks that ACK the loop after the initial
response, and mobile clients on flaky networks (Stripe uses 7 days for
some APIs because a phone on a flight may retry a day later). Use a
shorter TTL only when the storage cost dominates — most teams never
need to.

---

## Storage choices — DB vs Redis

DB is durable and consistent; Redis is fast and ephemeral.

| Property                  | DB (forge-orm)                       | Redis                               |
|---------------------------|--------------------------------------|-------------------------------------|
| Durability                | Survives process crash and restart   | Lost on flush / restart (unless AOF)|
| Read latency              | 1-5 ms uncached, 0.1-1 ms hot row    | 0.1-1 ms                            |
| Atomic check-and-insert   | `upsert` on unique index             | `SET NX EX`                         |
| TTL                       | column + cron                        | `EXPIRE` / `SET EX`                 |
| Schema / migration        | one model, one migration             | none                                |

Decision factors. Payments and other money-touching writes belong in the
DB — losing the idempotency record because Redis OOM'd is a
customer-visible problem. Rate limiting belongs in Redis — a few seconds
of slack on a rate-limit window after a restart is fine. High-throughput
webhook dedup (50k/s+) belongs in Redis — DB writes cap out lower than
that. If your DB and Redis are in different failure domains, the more
critical primitive goes in the more durable one.

The common hybrid: Redis as the hot cache, DB as source of truth. Check
Redis with a `GET`. On a hit, replay. On a miss, upsert into the DB and
promote the completed record to Redis with a matching TTL.

```ts
async function lookupOrInsert(scope: string, key: string, hash: string) {
  const cached = await redis.get(`idem:${scope}:${key}`);
  if (cached) return JSON.parse(cached);

  const record = await db.idempotencyRecord.upsert({
    where:  { scope_idempotency_key: { scope, idempotency_key: key } },
    create: { scope, idempotency_key: key, request_hash: hash, /* … */ },
    update: {},
  });
  if (record.state === 'completed') {
    await redis.set(`idem:${scope}:${key}`, JSON.stringify(record), 'EX', 86400);
  }
  return record;
}
```

The race between the Redis `GET` and the `upsert` is benign — a retry
that slips past the Redis cache hits the DB unique constraint and
collapses correctly.

---

## Sagas and compensation

A saga is a sequence of local transactions with a compensating action
for each. If step 3 fails, run the compensations for steps 1 and 2.

Every step takes an idempotency key, deterministically derived from the
saga id (`${sagaId}:reserve`, `${sagaId}:charge`, `${sagaId}:ship`).
Compensations get their own derived keys (`${sagaId}:refund`,
`${sagaId}:release`). This is what makes the saga crash-safe: if the
orchestrator dies mid-saga, restarting with the same saga id retries
each step or compensation against the same idempotency key, and the
completed ones short-circuit.

```ts
async function placeOrder(input: OrderInput) {
  const sagaId = ulid();
  try {
    const reservation = await reserveStock(input, `${sagaId}:reserve`);
    const charge      = await chargeCard(input, `${sagaId}:charge`);
    const shipment    = await scheduleShipment(input, reservation, `${sagaId}:ship`);
    return { reservation, charge, shipment };
  } catch (err) {
    await refundCard(input, `${sagaId}:refund`).catch(logger.error);
    await releaseStock(input, `${sagaId}:release`).catch(logger.error);
    throw err;
  }
}
```

The compensation path is catch-and-continue — a failed compensation logs
and the next compensation still runs. Permanent compensation failures
land in a dead-letter queue for human review.

The storage shape is the same `IdempotencyRecord` table, with the saga
id baked into the key. For long-running sagas drop the cached response
body and keep only the `state` field — the saga needs to know whether
the step ran, not what it returned. For multi-day workflows, the saga
orchestration belongs in a durable runtime (Vercel Workflow,
Temporal, the BullMQ recipe below); forge's role is the per-step
idempotency storage.

---

## Webhook receivers

Webhook senders deliver at-least-once; receivers dedupe. The idempotency
key is in the body, not a header — Stripe's `event.id` (`evt_...`),
GitHub's `X-GitHub-Delivery`, Shopify's `X-Shopify-Webhook-Id`,
Slack's timestamp + body.

The receiver pattern, applied to Stripe:

```ts
async function onStripeWebhook(req: Request) {
  const event = await verifyAndParseStripeSignature(req);   // reject invalid sigs first

  const { processed } = await db.providerEvent.upsert({
    where:  { provider_event_id: { provider: 'stripe', event_id: event.id } },
    create: { provider: 'stripe', event_id: event.id, payload: event, processed: false },
    update: {},
  });
  if (processed) return new Response(null, { status: 200 });

  await handleEvent(event);   // throws → sender retries → upsert collapses
  await db.providerEvent.update({
    where: { provider_event_id: { provider: 'stripe', event_id: event.id } },
    data:  { processed: true, processed_at: new Date() },
  });
  return new Response(null, { status: 200 });
}
```

This is the [worked example](./MUTATIONS.md#a-idempotent-webhook-handler)
from `docs/MUTATIONS.md` with the receive-and-process loop spelled out.

* **Compound unique on `(provider, event_id)`.** Different webhook
  senders can pick the same id by collision; the per-provider scope
  prevents one sender's `evt_1234` from masking another's.
* **Re-arrivals before completion.** A retry that lands while the first
  handler is mid-flight sees `processed: false` and re-runs. Webhook
  handlers must themselves be idempotent at the work layer, or gate the
  inner work on an advisory lock.
* **No outer transaction.** Holding a transaction across `handleEvent`
  blocks other webhooks on the connection — mark processed with a
  separate `update` after the work commits.
* **Block 2xx until the work commits.** Stripe re-delivers on any 5xx
  and on no-response. A premature 200 before `handleEvent` turns the
  webhook into fire-and-forget; a mid-handler crash loses the event.

---

## BullMQ and job queues

BullMQ has native idempotency via the `jobId` option: an enqueue with
an explicit `jobId` matching an existing job is silently dropped. The
dedup is at the *queue* level — two enqueues produce one job, which the
worker runs once.

```ts
await charges.add('charge-card', { customerId, amount }, {
  jobId: idempotencyKey,
  removeOnComplete: { age: 24 * 3600 },   // keep completed jobs 24h
  removeOnFail:     { age: 24 * 3600 },
});
```

If the upstream HTTP handler is keyed too, the chain is end-to-end
idempotent: same HTTP request → same DB row → same `jobId` → one worker
execution.

What BullMQ does *not* do for you:

* **Persist the result across `jobId` collisions.** A retry that hits a
  completed job gets back a `Job` reference, not the result. If the
  caller needs the result, look it up via your own storage (an
  `idempotency_key`-unique row) or `job.waitUntilFinished()` (throws if
  the job failed).
* **Catch retries after `removeOnComplete`.** A `jobId` for a deleted
  completed job is a fresh job, which re-runs. Set `age: 24 * 3600` or
  match your HTTP TTL.
* **Cross-queue idempotency.** `jobId` is scoped per queue.

The worker that combines BullMQ's queue-level dedup with a DB-level
fence:

```ts
new Worker('charges', async (job) => {
  return db.$transaction(async (tx) => {
    const existing = await tx.charge.findFirst({ where: { idempotency_key: job.id! } });
    if (existing) return existing;
    const charge = await callPaymentGateway(job.data);
    return tx.charge.create({ data: { idempotency_key: job.id!, ...charge } });
  });
});
```

Two layers — BullMQ drops the enqueue if `jobId` exists; the worker's
`findFirst` + `create` drops the work if the row exists. The inner
check catches the gap after `removeOnComplete` ran. For saga steps, the
`jobId` is `${sagaId}:${stepName}` — crash recovery is "re-enqueue every
step's `jobId`," and BullMQ drops the ones that already ran.

---

## Transaction-level retry

The retry harness in
[docs/ERRORS.md#transaction--retry](./ERRORS.md#transaction--retry)
retries the *whole* `$transaction` body on `P2034`. When that body is
idempotency-keyed, the outer retry must use the same key — otherwise
the inner upsert sees a fresh key on each attempt and writes a new row.

```ts
async function processWithRetry(req: Request, idemKey: string) {
  return withTxRetry(async (tx) => {
    const record = await tx.idempotencyRecord.upsert({
      where:  { scope_idempotency_key: { scope: req.tenantId, idempotency_key: idemKey } },
      create: { scope: req.tenantId, idempotency_key: idemKey, request_hash: hash, /* … */ },
      update: {},
    });
    if (record.state === 'completed') return record.response_body;

    const result = await doWork(tx, req);
    await tx.idempotencyRecord.update({
      where: { id: record.id },
      data:  { state: 'completed', response_body: result, completed_at: new Date() },
    });
    return result;
  });
}
```

`idemKey` is captured in the outer closure, so every retry attempt sees
the same value. The closure-state caveat in
[docs/ERRORS.md#transaction--retry](./ERRORS.md#transaction--retry)
applies — the key must be read-only across attempts.

`P2002` should never surface from the upsert itself — it would mean the
`where` clause does not correspond to a unique constraint and the
conflict target is missing. See
[docs/MUTATIONS.md#constraints-on-the-conflict-target](./MUTATIONS.md#constraints-on-the-conflict-target).

---

## Composing with upsert

The `upsert({ where: { idempotencyKey: k }, create: {...}, update: {} })`
shape is the load-bearing primitive. It composes in three useful ways.

### Single-table idempotency

The domain entity itself carries the key. Best when there is exactly one
mutation per key and the entity has a natural identity:

```ts
const Payment = model('payments', {
  id:              f.id(),
  idempotency_key: f.string().unique(),
  amount_cents:    f.int(),
  status:          f.string(),
});

async function createPayment(input: PaymentInput, idemKey: string) {
  return db.payment.upsert({
    where:  { idempotency_key: idemKey },
    create: { idempotency_key: idemKey, ...input, status: 'pending' },
    update: {},
  });
}
```

One row, one statement, fully race-safe. The replay returns the original
payment record — same status, same id. No separate `IdempotencyRecord`
table. Downside: every domain entity needs the column. Past two or three
endpoints, the separate-table shape from
[Storing keys with forge-orm](#storing-keys-with-forge-orm) wins.

### Two-step: lookup, then work

When the cache-hit path needs to be cheaper than a write:

```ts
const cached = await db.idempotencyRecord.findFirst({
  where: { scope, idempotency_key: key, state: 'completed' },
});
if (cached) return cached.response_body;
return doFirstArrivalWork(req, key);   // contains the atomic upsert
```

`findFirst` is read-only — no write lock, no INSERT attempt. On the hot
retry path (where most requests hit the cache) this saves a write. The
race between `findFirst` and the inner `upsert` is benign: the upsert
catches the parallel completion. Net cost is one extra round-trip on the
racy first arrival.

### Nested writes

Combine the idempotency upsert with a nested write on the domain entity
(see [docs/MUTATIONS.md#nested-writes](./MUTATIONS.md#nested-writes)):

```ts
await db.idempotencyRecord.upsert({
  where:  { scope_idempotency_key: { scope, idempotency_key: key } },
  create: {
    scope, idempotency_key: key, request_hash: hash, state: 'pending',
    payment: { create: { amount_cents, currency, status: 'pending' } },
  },
  update: {},
});
```

On SQL adapters this is one transaction, two statements. Useful when the
domain entity is born with the idempotency row; less useful when the
entity is created later in the work path.

---

## Idempotency vs unique constraint

Both deduplicate; they differ in what they do on the duplicate.

| Shape                                   | On duplicate                                  |
|-----------------------------------------|-----------------------------------------------|
| `unique()` on a column                  | Throws `P2002` — caller catches and decides   |
| `upsert({ …, update: {} })`             | Returns existing row — caller branches on a column |
| `upsert({ …, update: {...} })`          | Returns the row after applying the update     |

The unique is the lower-level primitive — necessary under all three
because the upsert uses it as the conflict target. On its own, the
unique surfaces duplicates as errors. Fine for "this email is taken,"
wrong for idempotency replay where the duplicate is the expected case.

`upsert + no-op update` is the idempotency primitive: collapses
duplicates to one row at the DB layer and gives the application a
uniform "here is the row, look at its state." `upsert + real update` is
last-write-wins — a different semantic, not idempotency in the Stripe
sense. The same unique index serves all three; the branching lives at
the verb level. For the catch-P2002 fallback when refactoring to upsert
isn't possible, see
[docs/ERRORS.md#b-unique-violation-as-upsert-race](./ERRORS.md#b-unique-violation-as-upsert-race).

---

## HTTP middleware

The middleware that wraps every mutating route. The shared helpers, then
two flavours — Express-family (hyper-express, Express, Fastify) and
Next.js Route Handler.

```ts
import { createHash } from 'node:crypto';

const TTL_MS = 24 * 3600 * 1000;

function canonicalise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalise);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((acc, k) => {
      acc[k] = canonicalise((v as any)[k]); return acc;
    }, {} as Record<string, unknown>);
  }
  return v;
}

function hashBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalise(body))).digest('hex');
}

async function lookupOrInsert(scope: string, key: string, hash: string) {
  return db.idempotencyRecord.upsert({
    where:  { scope_idempotency_key: { scope, idempotency_key: key } },
    create: {
      scope, idempotency_key: key, request_hash: hash,
      response_status: 0, state: 'pending',
      expires_at: new Date(Date.now() + TTL_MS),
    },
    update: {},
  });
}

async function complete(id: string, status: number, body: unknown) {
  await db.idempotencyRecord.update({
    where: { id },
    data:  { state: 'completed', response_status: status, response_body: body, completed_at: new Date() },
  });
}
```

### Express / hyper-express / Fastify

```ts
import type { RequestHandler } from 'express';

export function idempotency(scopeFromReq: (req: any) => string): RequestHandler {
  return async (req, res, next) => {
    const key = req.header('Idempotency-Key');
    if (!key || req.method === 'GET' || req.method === 'HEAD') return next();

    const scope = scopeFromReq(req);
    const hash  = hashBody(req.body);
    const record = await lookupOrInsert(scope, key, hash);

    if (record.request_hash !== hash) {
      return res.status(422).json({ error: 'idempotency_key_reused' });
    }
    if (record.state === 'completed') {
      return res.status(record.response_status).json(record.response_body);
    }

    // Wrap res.json so the middleware records the completion.
    const origJson = res.json.bind(res);
    res.json = ((body: any) => {
      complete(record.id, res.statusCode, body).catch(() => {});
      return origJson(body);
    }) as any;
    return next();
  };
}
```

The `res.json` wrap is the price of not changing every route handler.
The fire-and-forget `complete()` is acceptable because the `pending` row
is a no-op on a later replay — the worst case is a client retry that
runs the work twice in flight, and the second worker's upsert collides
with the eventually-arriving `state: completed` row.

For hyper-express the shape is identical (it ships an Express-compatible
API). For Fastify, replace the wrap with the `onSend` hook — it runs
after the handler and is the natural complete-on-success point:

```ts
fastify.addHook('onSend', async (req, reply, payload) => {
  const id = (req as any).idempotencyId;
  if (id) await complete(id, reply.statusCode,
    typeof payload === 'string' ? JSON.parse(payload) : payload);
  return payload;
});
```

### Next.js Route Handler

Route Handlers don't have a middleware chain that sees the response
body, so the wrap is per-handler:

```ts
import { NextRequest, NextResponse } from 'next/server';

export async function withIdempotency<T>(
  req: NextRequest,
  scopeFromReq: (req: NextRequest) => string,
  handler: (body: any) => Promise<{ status: number; body: T }>,
): Promise<NextResponse> {
  const key = req.headers.get('idempotency-key');
  if (!key || req.method === 'GET' || req.method === 'HEAD') {
    const result = await handler(await req.json());
    return NextResponse.json(result.body, { status: result.status });
  }

  const scope = scopeFromReq(req);
  const body  = await req.json();
  const hash  = hashBody(body);
  const record = await lookupOrInsert(scope, key, hash);

  if (record.request_hash !== hash) {
    return NextResponse.json({ error: 'idempotency_key_reused' }, { status: 422 });
  }
  if (record.state === 'completed') {
    return NextResponse.json(record.response_body, { status: record.response_status });
  }

  const result = await handler(body);
  await complete(record.id, result.status, result.body);
  return NextResponse.json(result.body, { status: result.status });
}

// app/api/payments/route.ts
export async function POST(req: NextRequest) {
  return withIdempotency(req, (r) => r.headers.get('x-tenant-id') ?? 'default',
    async (body) => ({ status: 201, body: await createPayment(body) }));
}
```

`middleware.ts` at the framework level can gate by header but cannot see
the response body, so per-handler wrap is what most teams land on.

---

## Per-dialect race characteristics

The `upsert` collapses two simultaneous calls into one row on every
adapter. The underlying mechanism differs per dialect.

| Adapter   | Mechanism                                    | Edge case                                  |
|-----------|----------------------------------------------|--------------------------------------------|
| postgres  | `INSERT … ON CONFLICT … DO UPDATE`. Loser blocks on the unique-index lock, then takes the `DO UPDATE` branch when the winner commits. | Under `SERIALIZABLE`, the loser can surface `P2034` (`40001`) — the retry harness handles it. |
| mysql     | `INSERT … ON DUPLICATE KEY UPDATE` followed by `SELECT`. Under `REPEATABLE READ`, gap locking serialises the two writers on the index gap covering the missing key. | The follow-up `SELECT` reads back the row (MySQL has no `RETURNING`). |
| sqlite    | Single writer at any time. The second writer waits on the file-lock (or `SQLITE_BUSY` if the timeout expires), then runs against the post-insert state. | In the browser worker via OPFS, a second tab can trigger `SQLITE_BUSY` more often — forge maps it to `P2034`. See [docs/BROWSER.md](./BROWSER.md). |
| duckdb    | `INSERT … ON CONFLICT … DO UPDATE` on a single-writer process. | Designed for analytical workloads, not high-write concurrency — using it for high-volume idempotency is the wrong tool. |
| mssql     | `MERGE INTO tgt USING (VALUES …) src ON …`, atomic per target row, serialised on the unique index. | Known SQL Server bug where `MERGE` can throw `2601` under concurrent inserts — forge emits the `(HOLDLOCK)` hint to defeat it. |
| mongo     | `updateOne(filter, update, { upsert: true })`. The loser's `$setOnInsert` is silently dropped; the no-op `$set` is harmless. | Under heavy contention on the same `_id`, Mongo throws `WriteConflict` (server 112). Forge maps that to `P2034`. |

The common shape: under contention, one writer wins, the other either
takes the update branch (no-op for us) or surfaces a `P2034` that the
[retry harness](./ERRORS.md#transaction--retry) absorbs. `P2002` should
never surface from the upsert itself — if it does, the `where` clause
does not correspond to a unique constraint and the conflict target is
falling through. See
[docs/MUTATIONS.md#constraints-on-the-conflict-target](./MUTATIONS.md#constraints-on-the-conflict-target).

---

## Worked examples

Four end-to-end examples that compose the pieces above.

### (a) Stripe-style payments endpoint

Wraps the [Next.js middleware](#nextjs-route-handler) and forwards the
key to the upstream gateway:

```ts
export async function POST(req: NextRequest) {
  return withIdempotency(req, (r) => r.headers.get('x-tenant-id') ?? 'default',
    async (body) => {
      const key = req.headers.get('idempotency-key')!;
      try {
        const charge = await stripe.charges.create(
          { amount: body.amount, currency: body.currency, source: body.source },
          { idempotencyKey: `inner:${key}` },   // Stripe's own idempotency
        );
        const payment = await db.payment.create({
          data: { idempotency_key: key, gateway_id: charge.id, amount_cents: body.amount, status: 'paid' },
        });
        return { status: 201, body: payment };
      } catch (err: any) {
        return { status: err.statusCode ?? 502, body: { error: 'gateway', message: err.message } };
      }
    });
}
```

The `inner:${key}` passed to Stripe's own `idempotencyKey` is what makes
the gateway side also idempotent — if our handler crashes between the
Stripe call and the local DB write, the next retry's Stripe call returns
the original charge instead of creating a second one. The `inner:`
prefix distinguishes the two idempotency layers in case the same key
shows up in two accounting systems.

### (b) Webhook receiver — Stripe events

```ts
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET!);

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature')!;
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  const record = await db.providerEvent.upsert({
    where:  { provider_event_id: { provider: 'stripe', event_id: event.id } },
    create: { provider: 'stripe', event_id: event.id, payload: event, processed: false },
    update: {},
  });
  if (record.processed) return new NextResponse(null, { status: 200 });

  try {
    await handleStripeEvent(event);
    await db.providerEvent.update({
      where: { provider_event_id: { provider: 'stripe', event_id: event.id } },
      data:  { processed: true, processed_at: new Date() },
    });
  } catch (err) {
    // Don't mark processed; let Stripe retry. Re-throw so we send a 5xx.
    throw err;
  }
  return new NextResponse(null, { status: 200 });
}
```

Stripe redelivers on any non-2xx response and on timeouts. The 200 is
sent only after `handleStripeEvent` completes — a crash mid-handler
leaves `processed: false` and Stripe retries.

### (c) BullMQ worker — saga step

```ts
import { Queue, Worker } from 'bullmq';

const shipments = new Queue('shipments', { connection: redis });

// Enqueue from the saga orchestrator:
async function scheduleShipment(orderId: string, sagaId: string) {
  await shipments.add('ship', { orderId }, {
    jobId: `${sagaId}:ship`,
    removeOnComplete: { age: 24 * 3600 },
    removeOnFail: { age: 7 * 24 * 3600 },
  });
}

// Worker — DB-layer dedup as well as queue-layer:
new Worker('shipments', async (job) => {
  return db.$transaction(async (tx) => {
    const existing = await tx.shipment.findFirst({
      where: { idempotency_key: job.id },
    });
    if (existing) return existing;

    const tracking = await carrier.createShipment(job.data);
    return tx.shipment.create({
      data: {
        idempotency_key: job.id!,
        order_id:        job.data.orderId,
        tracking_id:     tracking.id,
        status:          tracking.status,
      },
    });
  });
}, { connection: redis });
```

Two idempotency layers — BullMQ's `jobId` and forge's `idempotency_key`
unique. If BullMQ's `removeOnComplete` retains the job, the duplicate
enqueue is silently dropped. If the job was removed and a re-enqueue
creates a fresh `Job` instance, the worker still finds the existing
shipment via `findFirst` and short-circuits.

### (d) Saga with compensation

```ts
async function placeOrder(input: OrderInput) {
  const sagaId = ulid();
  let stage = 'init';
  try {
    stage = 'reserve'; const reservation = await reserveStock(input, `${sagaId}:reserve`);
    stage = 'charge';  const charge      = await chargeCard(input, `${sagaId}:charge`);
    stage = 'ship';    const shipment    = await scheduleShipment(input, reservation, `${sagaId}:ship`);
    return { sagaId, reservation, charge, shipment };
  } catch (err) {
    if (stage === 'ship' || stage === 'charge')  await refundCard(input, `${sagaId}:refund`).catch(logger.error);
    if (stage !== 'init' && stage !== 'reserve') await releaseStock(input, `${sagaId}:release`).catch(logger.error);
    throw err;
  }
}

async function reserveStock(input: OrderInput, key: string) {
  const record = await db.idempotencyRecord.upsert({
    where:  { scope_idempotency_key: { scope: 'inventory', idempotency_key: key } },
    create: { scope: 'inventory', idempotency_key: key, request_hash: hashBody(input),
              state: 'pending', expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000) },
    update: {},
  });
  if (record.state === 'completed') return record.response_body;

  const result = await db.product.updateMany({
    where: { id: input.productId, stock: { gte: input.qty } },
    data:  { stock: { decrement: input.qty } },
  });
  if (result.count === 0) throw new Error('out_of_stock');

  await db.idempotencyRecord.update({
    where: { id: record.id },
    data:  { state: 'completed', response_body: { reserved: input.qty }, completed_at: new Date() },
  });
  return { reserved: input.qty };
}

// chargeCard, scheduleShipment, refundCard, releaseStock follow the same shape —
// upsert the idempotency row, branch on state, run the side effect on first arrival.
```

Restarting the orchestrator with the same `sagaId` re-runs each step's
`upsert`. Steps that completed return their cached result and skip the
side effect; steps that didn't run take the first-arrival path. The
7-day TTL is wider than the saga's normal lifetime — a saga that hangs
for 8 days is a separate alert, not a TTL boundary.

---

## Cross-references

* [docs/MUTATIONS.md](./MUTATIONS.md) — the `upsert` shape that turns
  duplicate writes into one round-trip, atomic number ops, nested writes,
  the
  [Idempotency](./MUTATIONS.md#idempotency) and
  [Worked patterns](./MUTATIONS.md#worked-patterns) sections.
* [docs/ERRORS.md](./ERRORS.md) — `DbKnownError`, `P2002` race handling,
  the
  [Idempotency-Key interaction](./ERRORS.md#idempotency-key-interaction)
  section, retry classes.
* [docs/TRANSACTIONS.md](./TRANSACTIONS.md) — `$transaction` semantics,
  `P2034` retry, isolation levels, how the inner tx body interacts with
  an outer idempotency key.
* [docs/EVENTS.md](./EVENTS.md) — `query` and `error` events, how to log
  every idempotency upsert and every cache hit, slow-query alerting.
* [docs/BACKEND.md](./BACKEND.md) — multi-process worker layout, how the
  idempotency table is shared, when to partition.
