# Watch and change feeds

Receiving updates when data changes — the primitive realtime UIs are built on. forge-orm composes with each dialect's native change feed: Mongo change streams, Postgres LISTEN/NOTIFY and logical replication, MySQL binlog, SQLite update hooks. This page covers each plus the WebSocket / SSE bridge that fans changes out to clients.

If you have not read the README chapter [Watching queries](../README.md#watching-queries) yet, start there — it covers `db.$on('query', …)`, which is forge's only first-class subscriber surface. Everything below is a layer above that, wiring a dialect-native change feed into forge-shaped code.

## Contents

* [What "watching" means](#what-watching-means)
* [What forge does and does not surface](#what-forge-does-and-does-not-surface)
* [Mongo change streams — first-class](#mongo-change-streams--first-class)
* [Postgres LISTEN / NOTIFY](#postgres-listen--notify)
* [Postgres logical replication and the WAL](#postgres-logical-replication-and-the-wal)
* [MySQL binlog tailing](#mysql-binlog-tailing)
* [SQLite update hooks](#sqlite-update-hooks)
* [Browser sqlite-wasm — local watcher pattern](#browser-sqlite-wasm--local-watcher-pattern)
* [The WebSocket / SSE bridge](#the-websocket--sse-bridge)
* [Filtering changes per subscription](#filtering-changes-per-subscription)
* [Backpressure](#backpressure)
* [Auth — clients only see their own rows](#auth--clients-only-see-their-own-rows)
* [Resume from offset](#resume-from-offset)
* [At-least-once vs exactly-once](#at-least-once-vs-exactly-once)
* [Worked examples](#worked-examples)
* [See also](#see-also)

---

## What "watching" means

"Watching" is the umbrella term for receiving an event every time the underlying data changes. The four shapes the term covers:

| Shape | What it delivers | Typical use |
|---|---|---|
| **Query-event log** | one event per forge call (the call, not the data) | observability, slow-query logs, audit |
| **Change feed** | one event per row insert / update / delete in the database | dashboards, search-index sync, materialised views, webhook fan-out |
| **Triggered notify** | a payload published by application code at the moment of write | pub/sub between services, cache invalidation |
| **Live query** | the *result set* re-evaluated and pushed whenever it changes | realtime tables, presence views |

forge surfaces the first natively — `db.$on('query', …)` (see [EVENTS](./EVENTS.md)) — and gives you typed access to the dialect primitives that power the other three. It does **not** ship a "live query" engine; the standing-result pattern lives one layer up in your sync code (worked example below).

The reason for that line: a live-query engine needs to re-execute the query against every change event, deduplicate, and diff. That's a tier of infrastructure (Materialize, Electric, PowerSync) that competes with forge's "the SQL is the SQL" promise. Building it inside the ORM would mean either dropping back to a subset of the operator surface or shipping a worker per query. The pattern this page documents — change feed → invalidate cache keys → re-query — is the same idea pulled into the application, where you get to pick which queries deserve it.

---

## What forge does and does not surface

| Surface | Status | Notes |
|---|---|---|
| `db.$on('query', cb)` | first-class | every forge call, with `sql`, `params`, `duration_ms`, `rowCount`, `semanticOp` |
| `db.$on('error', cb)` | first-class | every thrown error from the wrapper |
| `db.<Model>.watch(...)` (Mongo) | pass-through | returns the driver's `ChangeStream` cursor; no decoding |
| `db.$listen('channel', cb)` (PG) | **not surfaced** | use a `pg.Client` directly — pattern below |
| `db.$onUpdate(table, cb)` (SQLite) | **not surfaced** | use `better-sqlite3`'s `db.function()` or the WASM binding's `update_hook` — pattern below |
| MySQL binlog reader | **not surfaced** | use `@vlasky/mysql` or a Debezium sink — pattern below |

`forge-orm` deliberately stops at the IR. Change feeds are dialect-specific runtime concerns that don't compose cleanly across adapters (a Mongo change stream is not a Postgres NOTIFY is not a SQLite hook), so the library does not invent a unified `watch` API that would lie about its semantics on three of the four. Instead, each dialect doc tells you which native surface to reach for, and this page assembles them into one place with the application-layer glue.

Source check — searching `src/` confirms only the event-bus surfaces (`events.ts`, the `$on` plumbing) and the Mongo wrapper that re-exposes `collection.watch()`. There is no `watchAll`, `onChange`, or `live` method in the IR or wrapper.

---

## Mongo change streams — first-class

The Mongo wrapper passes `watch()` through unchanged:

```ts
const cursor = db.orders.watch(
  [{ $match: {
      operationType: { $in: ['insert', 'update'] },
      'fullDocument.status': 'PAID',
  } }],
  { fullDocument: 'updateLookup' },
);

for await (const change of cursor) {
  // { operationType, fullDocument, documentKey, ns, clusterTime, _id }
}
```

`db.orders.watch(pipeline, options)` is sugar for `client.db.collection('orders').watch(pipeline, options)` — same return type (`ChangeStream<TSchema>`), same iteration shape. forge does not decode `change.fullDocument` through the model coercer — you get the raw BSON-shaped document the driver returns. If you want forge types in the event payload, call `decodeRow(model, change.fullDocument)` from the cascade walker's coerce module (`src/adapters/mongo/coerce.ts`).

The constraints:

1. **Replica set or sharded cluster.** Standalone `mongod` has no oplog and refuses `watch()`. Atlas, DocumentDB, and self-hosted replica sets all work; Cosmos (Mongo API) and FerretDB do not.
2. **`fullDocument: 'updateLookup'`.** Without it the change carries only the delta (`updateDescription.updatedFields`). With it, the server does a separate read at the current cluster time. That read can race a subsequent delete — guard with `if (!change.fullDocument) continue`.
3. **Resume tokens roll with the oplog.** `change._id` is the resume token. Persist it after the side effect succeeds; pass `{ resumeAfter: token }` on reconnect. The oplog window (default 24h on Atlas M10+) bounds how long a watcher can stay offline.
4. **Filter in the pipeline, not in JavaScript.** A `$match` stage on `fullDocument.status` runs server-side and skips events at the wire; filtering in your loop costs you network + CPU on every write to the collection.

The full reference, including a worked end-to-end watcher with resume-token persistence, lives in [MONGO §Change streams](./MONGO.md#change-streams). The pattern below in [Worked examples](#worked-examples) shows the same watcher fanned out to WebSocket clients.

---

## Postgres LISTEN / NOTIFY

Postgres's pub/sub primitive. `NOTIFY channel, 'payload'` fans the payload out to every session that has issued `LISTEN channel`. The broadcast is in-memory through shared memory — sub-millisecond — but with three sharp edges:

1. **Payloads are 8000 bytes.** Anything larger has to be split or referenced by id (write the row, NOTIFY the id, the listener fetches via forge).
2. **The channel is ephemeral.** A listener that disconnects misses everything published while it was offline. NOTIFY is not a queue.
3. **NOTIFY inside a transaction queues until COMMIT.** This is the right semantics for "tell the world I wrote the row" — a rolled-back transaction publishes nothing.

forge does not surface LISTEN/NOTIFY as a wrapper method, because the listener needs a long-lived, **non-pooled** connection — PgBouncer's transaction-mode pool recycles the connection between queries and the LISTEN registration evaporates. The pattern is a dedicated `pg.Client` outside the forge pool:

```ts
import { Client } from 'pg';

const listener = new Client({ connectionString: process.env.PG_DIRECT_URL });
await listener.connect();
await listener.query('LISTEN row_changes');

listener.on('notification', (msg) => {
  if (msg.channel !== 'row_changes') return;
  const evt = JSON.parse(msg.payload!) as { table: string; id: string; op: 'I'|'U'|'D' };
  void handleChange(evt);
});

// Reconnect on disconnect — LISTEN registrations are session-scoped.
listener.on('error', async () => {
  await listener.end();
  setTimeout(() => startListener(), 1_000);
});
```

The writer side has two shapes — application-emitted or trigger-emitted.

**Application-emitted** lives next to the forge call:

```ts
await db.$transaction(async (tx) => {
  const row = await tx.order.create({ data: { ... } });
  await tx.$executeRaw`SELECT pg_notify('row_changes', ${JSON.stringify({
    table: 'order', id: row.id, op: 'I',
  })})`;
  return row;
});
```

The NOTIFY rides inside the transaction; if the COMMIT fails, no notification is sent. Forge does the SQL escaping via the prepared-statement plumbing — the `${...}` interpolations don't string-concat.

**Trigger-emitted** decouples publish from the application code:

```sql
CREATE OR REPLACE FUNCTION notify_row_changes() RETURNS trigger AS $$
DECLARE
  payload json;
BEGIN
  payload := json_build_object(
    'table', TG_TABLE_NAME,
    'id',    COALESCE(NEW.id, OLD.id),
    'op',    LEFT(TG_OP, 1)
  );
  PERFORM pg_notify('row_changes', payload::text);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_notify
AFTER INSERT OR UPDATE OR DELETE ON "order"
FOR EACH ROW EXECUTE FUNCTION notify_row_changes();
```

Push this DDL after `forge push`. It catches every write to the table, including writes from psql, other services, and the future you-of-six-months who forgets to call NOTIFY in a new code path. The trade-off: triggers fire even on bulk batch writes, which can flood the channel during a backfill. Pair with rate limiting on the listener side.

When LISTEN/NOTIFY is not enough — payload too big, listener offline window too long, replay required — graduate to logical replication (next section) or the outbox pattern (see [worked example (c)](#c-bullmq-outbox-pattern)).

---

## Postgres logical replication and the WAL

Logical replication reads the Write-Ahead Log and decodes per-row INSERT/UPDATE/DELETE events. It's how Debezium, pgstream, Materialize, and the cross-region replicas at the cloud providers work. The benefits over NOTIFY:

| Concern | LISTEN/NOTIFY | Logical replication |
|---|---|---|
| Payload size | 8000 bytes | unbounded |
| Catches non-app writes | no (only NOTIFY callers) | yes — every WAL record |
| Listener offline window | until reconnect (then lost) | until replication slot retention |
| Replay | impossible | from any LSN within the slot |
| Cost | sub-ms broadcast | WAL retention + decoder process |

The wiring is operational. Three pieces:

1. **`wal_level = logical`** in `postgresql.conf`. Default is `replica`; requires restart.
2. **Publication.** The set of tables to publish:
   ```sql
   CREATE PUBLICATION app_changes FOR TABLE "order", customer, invoice;
   -- or FOR ALL TABLES
   ```
3. **Replication slot.** Persistent cursor in the WAL — keeps WAL segments around until the consumer has acked them.
   ```sql
   SELECT pg_create_logical_replication_slot('app_changes', 'wal2json');
   ```

A Node consumer using `pg-logical-replication`:

```ts
import { LogicalReplicationService, Wal2JsonPlugin } from 'pg-logical-replication';

const svc = new LogicalReplicationService({
  connectionString: process.env.PG_DIRECT_URL,
});

svc.on('data', async (lsn, log) => {
  for (const change of log.change) {
    await dispatch({
      table: change.table,
      op: change.kind,                       // 'insert' | 'update' | 'delete'
      row: rowFromChange(change),
    });
  }
  await persistLsn(lsn);                    // ack point — slot will not retain WAL past this
});

await svc.subscribe(new Wal2JsonPlugin(), 'app_changes');
```

The slot retention guarantee is what unlocks at-least-once replay: a consumer that crashes before persisting the LSN will redeliver every change since the last persisted LSN on restart. The trade-off — and it's the one that bites every production deployment — is **a stalled slot pins WAL forever**. If your consumer dies and never restarts, WAL grows until the disk fills. Monitor `pg_replication_slots.confirmed_flush_lsn` against `pg_current_wal_lsn()` and alert past a few GB of lag.

forge plays no role inside the replication stream — the events come from Postgres directly, not from forge calls. But forge is how you bridge the events back into typed code:

```ts
async function dispatch(evt: ChangeEvent) {
  if (evt.table === '"order"') {
    const row = decodeOrder(evt.row);          // your schema-aware coercer
    await broadcastToSubscribers('order', row);
  }
}
```

For a managed alternative, Debezium's Postgres connector does the same thing through Kafka Connect, and AWS DMS does it through Kinesis. The mechanics are identical — replication slot + decoder + at-least-once delivery to a downstream sink.

---

## MySQL binlog tailing

MySQL's equivalent of WAL is the binlog. It's how managed replication, GTID-based replicas, and Debezium's MySQL connector all work. The flow is the same as Postgres logical replication: a consumer reads binlog events, decodes them per-row, and ships them downstream.

Three settings have to be right on the source:

```ini
# my.cnf
log_bin             = mysql-bin
binlog_format       = ROW             # RBR — STATEMENT is too lossy
binlog_row_image    = FULL            # include all column values, not just changed
expire_logs_days    = 7
server_id           = 1
```

`ROW` format and `FULL` row image are non-negotiable for change-feed work — `STATEMENT` only logs the SQL, which means a single `UPDATE orders SET status = 'paid' WHERE created_at < ?` is one row in the binlog and you can't recover which orders changed.

A Node consumer using `@vlasky/mysql` + `zongji`:

```ts
import ZongJi from '@vlasky/zongji';

const zongji = new ZongJi({
  host:     process.env.MYSQL_HOST,
  user:     process.env.MYSQL_REPL_USER,
  password: process.env.MYSQL_REPL_PASSWORD,
});

zongji.on('binlog', (evt) => {
  switch (evt.getEventName()) {
    case 'writerows':  return dispatch({ op: 'I', table: evt.tableMap[evt.tableId].tableName, rows: evt.rows });
    case 'updaterows': return dispatch({ op: 'U', table: evt.tableMap[evt.tableId].tableName, rows: evt.rows });
    case 'deleterows': return dispatch({ op: 'D', table: evt.tableMap[evt.tableId].tableName, rows: evt.rows });
  }
});

zongji.start({
  includeEvents: ['tablemap', 'writerows', 'updaterows', 'deleterows'],
  startAtEnd:    true,                            // or { filename, position } to resume
});
```

The replication user needs `REPLICATION SLAVE` and `REPLICATION CLIENT`. The position cursor is `(binlog_filename, position)` or GTID — persist it on every successful dispatch, the same way you persist a Postgres LSN.

The production-grade option is **Debezium**. It runs in Kafka Connect, handles failover, schema evolution, snapshot-then-tail (so a new consumer sees the existing rows before the tail), and translates the binlog into JSON events that any downstream — including a forge-backed application — can consume. The "Debezium-flavoured" event shape (`before`/`after`/`source`/`op`) is the closest thing the industry has to a standard change-event envelope; everything else in this page maps onto it.

---

## SQLite update hooks

SQLite has no oplog, WAL-shipping protocol, or NOTIFY. Its in-process change feed is the **update hook** — a callback the engine fires on every INSERT/UPDATE/DELETE in the same process.

`better-sqlite3` exposes it via `db.function()` and the lower-level `db.aggregate()` registration paths, but the cleanest surface is the WASM binding's `update_hook` (and `node-sqlite`'s native bridge). The shape:

```ts
import Database from 'better-sqlite3';

const conn = new Database(process.env.SQLITE_PATH);

// Native binding — fires for every row change in this process.
conn.unsafeMode(true);                        // required for the hook in better-sqlite3
conn.exec(`
  CREATE TEMP TRIGGER track_writes AFTER INSERT ON "order"
  BEGIN
    INSERT INTO _watch_queue(table_name, row_id, op, ts)
    VALUES ('order', NEW.id, 'I', strftime('%s', 'now'));
  END;
`);
```

Two pragmatic patterns:

**Triggers-into-a-queue** (above). Every write hits an `AFTER` trigger that pushes a row into a `_watch_queue` table. A poll-and-mark-consumed loop drains the queue. This is the only portable pattern — works on every SQLite build, ships with the database file, and gets backed up alongside your data. The trade-off is poll latency (50–500ms typical) and write amplification (every change costs a queue insert).

**Native `update_hook`** (lower latency, in-process only). Some bindings re-export `sqlite3_update_hook()` directly:

```ts
// Pseudocode for the binding's hook surface.
conn.updateHook((event) => {
  // event: { op: 'INSERT'|'UPDATE'|'DELETE', dbName, tableName, rowid }
  pushToBus({ op: event.op, table: event.tableName, rowid: event.rowid });
});
```

The native hook fires in the writer's call stack — same connection, same process. It does **not** carry the row payload (just `rowid`); the consumer has to read the row back through forge if it needs the values. And it's strictly in-process — it does not cross processes, threads, or replicated copies of the database.

For multi-process SQLite (rare in production — usually means you want Postgres) the canonical pattern is the trigger-into-a-queue plus a poller. For single-process — a desktop app, a CLI, a worker — the native hook is sub-ms and the right tool.

---

## Browser sqlite-wasm — local watcher pattern

In the browser, the forge DB lives in a Web Worker (see [BROWSER](./BROWSER.md)). The "watch a query" pattern is different from the server: you do not have a network change feed, but you do have **deterministic causality** — every write goes through the same worker. The pattern:

```ts
// src/db/watch.ts — one BroadcastChannel per logical event.
const bc = new BroadcastChannel('forge-db-writes');

// Wrap forge's mutation methods to emit on every successful write.
export function watchedCustomerUpsert(input: CustomerInput) {
  return db.customer.upsert(input).then((row) => {
    bc.postMessage({ kind: 'customer.upserted', id: row.id });
    return row;
  });
}

// On the read side, re-query whenever a write of the watched model lands.
bc.onmessage = (evt) => {
  if (evt.data.kind === 'customer.upserted') {
    queryClient.invalidateQueries({ queryKey: qk.customer.all(orgId) });
  }
};
```

The `BroadcastChannel` also crosses tabs — write in tab A invalidates tab B's TanStack Query cache. Same pattern, same code path. [REACT §BroadcastChannel cross-tab invalidation](./REACT.md#broadcastchannel-cross-tab-invalidation) walks through the full setup.

The advanced shape — for an app that wants "a list view re-runs whenever a write *could* affect it" — is a write-set diff. Wrap each mutation to record the keys it touched (`{ model: 'customer', ids: [...] }`); a subscriber re-runs queries whose `where` overlaps the touched ids. The implementation lives one layer above forge: the wrapper records keys, your sync code does the diff. forge does not ship it because the "could affect" predicate is application-specific (a `findMany({ where: { status: 'active' } })` is affected by any status flip, which you can't infer from a typed wrapper without re-evaluating the where).

---

## The WebSocket / SSE bridge

The same pattern across every dialect:

```
write → change feed → server bridge → WebSocket / SSE → client → forge invalidate / re-query
```

The bridge process tails the change feed (Mongo stream, Postgres replication slot, MySQL binlog) and fans events out to connected clients. Two transports:

**WebSocket** — bidirectional, framed, lower per-message overhead, browser-native. The pick for a typical SaaS dashboard where the client also publishes (presence, typing indicators).

**SSE (Server-Sent Events)** — unidirectional server-to-client, plain HTTP, works through every proxy without WebSocket-specific config. The pick when the client never publishes — pure push.

The minimal SSE handler with forge:

```ts
// app/api/stream/route.ts
export async function GET(req: Request) {
  const orgId = await assertOrgFromJwt(req);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const cursor = db.orderEvent.watch([
        { $match: { 'fullDocument.org_id': orgId } },
      ], { fullDocument: 'updateLookup' });

      try {
        for await (const change of cursor) {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({
              op: change.operationType,
              row: change.fullDocument,
            })}\n\n`,
          ));
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    },
  });
}
```

On the client, EventSource:

```ts
const es = new EventSource(`/api/stream`);
es.onmessage = (evt) => {
  const { op, row } = JSON.parse(evt.data);
  queryClient.invalidateQueries({ queryKey: qk.order.all() });
};
```

The WebSocket equivalent is the [REACT §Realtime sync over websockets](./REACT.md#realtime-sync-over-websockets) recipe — same shape, different envelope. Pick SSE first; reach for WebSocket only when the client needs to publish.

---

## Filtering changes per subscription

A change feed produces *every* event on the watched scope (collection, table, database). A connected client is interested in a fraction. Filtering happens in three places, with very different cost models:

| Place | Latency | Cost on the feed | When to use |
|---|---|---|---|
| **In the change feed** (`$match` pipeline, publication FOR TABLE, binlog filter) | lowest | cheapest — events never enter the bridge process | static filters known at startup |
| **In the bridge process** | low | one event in, n events out (per matching subscription) | dynamic filters known per connection (tenant, user role) |
| **In the client** | highest | full event sent over the wire to every client | filters that can't be expressed server-side |

A common shape — tenant scoping at the feed, per-user filter at the bridge, search filter on the client:

```ts
// Stage 1 — collection-level filter at the change-stream pipeline.
const cursor = db.orderEvent.watch([
  { $match: { 'fullDocument.org_id': orgId } },
], { fullDocument: 'updateLookup' });

// Stage 2 — per-subscription filter in the bridge.
for await (const change of cursor) {
  for (const sub of subscriptions) {
    if (sub.userId !== change.fullDocument.assignee_id) continue;
    sub.send(change);
  }
}

// Stage 3 — client-side narrow filter on the live UI.
es.onmessage = (evt) => {
  const change = JSON.parse(evt.data);
  if (!matchesSearchTerm(change.row, searchTerm)) return;
  applyToView(change);
};
```

The rule of thumb: push the filter as far down the stack as the data lets you. Don't ship 10k events/second through the bridge to filter out 9 980 of them on the client.

---

## Backpressure

Change feeds are unbounded. A slow client (mobile on a flaky connection) plus a fast writer (a backfill job) is the canonical recipe for OOM in the bridge process. Three strategies:

**Drop on overflow.** The realtime contract is "you'll see *a* recent state, not every transition." Bound the per-client queue at, say, 256 messages; on overflow, drop the oldest. The client re-queries on reconnect / on idle to reconverge.

```ts
class Subscription {
  private queue: Change[] = [];
  push(c: Change) {
    if (this.queue.length >= 256) this.queue.shift();    // drop oldest
    this.queue.push(c);
    this.flush();
  }
}
```

This is the right default for UI sync.

**Backpressure-aware writes.** WebSocket's `send` does not signal pressure, but the underlying socket's `bufferedAmount` does. Pause the cursor iteration when the buffer crosses a threshold and resume when it drains. Works at the cost of dispatch fairness — one slow client backs up the bridge for everyone unless you per-subscription queue.

**Queue forever, persist to disk.** The "no event lost" pattern. The bridge writes events to a persistent queue (Redis stream, BullMQ, Kafka) and each subscriber consumes from its own offset. Doesn't lose events but turns the bridge into a queueing system — go this route when delivery is contractual (financial events, audit), not for UI sync.

The hybrid most apps want: drop-on-overflow for UI sync (`order.updated`, presence) **and** a separate queue for delivery-required events (`payment.captured`, `email.sent`). The two streams run side by side; forge talks to both via the same `$transaction` block.

---

## Auth — clients only see their own rows

A change feed is a wide pipe. A WebSocket connection is one client. Between them, you have to enforce that a client only receives changes their identity is allowed to see — otherwise the realtime channel becomes a credential-free data exfiltration path.

Three places to enforce it:

**At connection time.** Validate the JWT (or session cookie) and resolve to a tenant + identity:

```ts
const orgId  = await verifyJwt(token);                 // throws if bad
const userId = jwt.sub;
```

Refuse the upgrade if the token is missing, expired, or scoped to a different org.

**In the per-subscription filter.** Every event passes through a predicate that checks `event.org_id === orgId`. Belt and braces — even if the feed-level filter is wrong, this catches it.

**At the feed level when possible.** A Mongo `$match` on `org_id` at the pipeline runs server-side and never returns cross-tenant events. A Postgres logical replication consumer can be one-per-tenant (cheap with multiple slots, expensive past a few hundred tenants), or one-for-all with a tenant filter in the dispatcher. Pick based on tenant count.

Token rotation: realtime connections are long-lived; tokens are short-lived. Refresh the token through the same channel:

```ts
ws.send({ kind: 'auth-refresh', token: newToken });
```

The server re-verifies on receipt and updates the subscription's authz context. A connection whose token expires without refresh is closed. The [vercel:auth] skill and your auth middleware are the right reference for the rotation cadence.

For Postgres specifically, Row-Level Security (RLS) protects forge reads from the bridge process the same way it protects request-scoped reads — the bridge runs in a connection with the session var set to a service identity, and the publication / trigger is the authorisation point. See [POSTGRES §Row-level security](./POSTGRES.md#row-level-security).

---

## Resume from offset

A watcher that crashes after processing event #1000 should resume at #1001 on restart — not at #1, not at #2000. Every dialect has a different cursor type for the offset:

| Dialect | Cursor type | Persistence |
|---|---|---|
| Mongo | resume token (`change._id`) — opaque BSON | one row in a `cursor_state` collection |
| Postgres logical | LSN (`pg_lsn`) — monotonic 64-bit | replication slot tracks server-side; client also persists the last-flushed LSN |
| MySQL binlog | `(filename, position)` or GTID | client persists the last-acked position |
| SQLite trigger queue | autoincrement id on the queue table | the queue itself is the cursor (mark consumed = ack) |
| Browser BroadcastChannel | none — purely in-process | not applicable |

The Mongo persistence pattern, from [MONGO §Worked example 2](./MONGO.md#2-change-stream-watcher):

```ts
async function loadResume(): Promise<ResumeToken | undefined> {
  const state = await db.collection('cursor_state')
    .findOne({ _id: 'paid_orders_watcher' });
  return state?.token;
}

async function saveResume(token: ResumeToken) {
  await db.collection('cursor_state').updateOne(
    { _id: 'paid_orders_watcher' },
    { $set: { token, ts: new Date() } },
    { upsert: true },
  );
}
```

The save-after-side-effect rule is universal — save the offset only after the side effect (webhook delivery, search-index update, downstream publish) has succeeded. If you crash between the side effect and the save, the next restart re-delivers, and the side effect needs to be idempotent. Save before the side effect and a crash *loses* the event entirely.

The retention window bounds offline-watcher duration:

| Dialect | Retention | What you lose past it |
|---|---|---|
| Mongo | oplog size (default 5% of disk; tune via `replSetResizeOplog`) | watcher must re-snapshot the collection — can't catch up |
| Postgres logical | unbounded (slot pins WAL) | nothing — but disk fills |
| MySQL binlog | `expire_logs_days` (default 7d) | watcher must re-snapshot from a backup |
| SQLite queue | unbounded (queue table grows) | nothing — but write amplification |

Monitor the lag and alert before retention runs out.

---

## At-least-once vs exactly-once

The default for every realistic change-feed setup is **at-least-once**. Crashes, retries, network blips, and the save-after-side-effect rule above all produce duplicates under failure. The system delivers each event at least once; the consumer makes it safe to receive the same event twice.

Idempotency keys are how you make duplicate-safe. For a webhook, the order id is the key — receiving `order.paid` twice for the same order is a no-op the second time:

```ts
async function chargeWebhook(order: Order) {
  const result = await db.webhook_delivery.upsert({
    where:  { order_id: order.id },
    create: { order_id: order.id, status: 'sent', sent_at: new Date() },
    update: { /* no-op */ },
  });
  if (result.status === 'sent') return;     // already delivered — duplicate, skip
  await fetch(webhookUrl, { body: JSON.stringify(order) });
}
```

For a search-index write, the upsert is the idempotency:

```ts
await searchClient.index('orders').addDocuments([order]);  // overwrite is idempotent
```

For a downstream queue (BullMQ), the job id is the key — BullMQ dedupes inside its retention window. See [BACKEND §Background workers with BullMQ](./BACKEND.md#background-workers-with-bullmq) for the pattern with forge.

**Exactly-once** is a contract no end-to-end system actually provides without two-phase commit across every participant. The closest you get is at-least-once delivery + idempotent consumers, which is operationally equivalent. Don't design for true exactly-once; design for safe-on-replay.

---

## Worked examples

### (a) Mongo change-stream → WebSocket fan-out

A Node service that tails the `orders` change stream and fans events out to authenticated WebSocket clients, scoped per org.

```ts
// src/realtime/server.ts
import { WebSocketServer, WebSocket } from 'ws';
import type { ChangeStreamDocument } from 'mongodb';
import { db, dbClient } from '@/db';
import { verifyJwt } from '@/auth';

interface Sub {
  ws:     WebSocket;
  orgId:  string;
  queue:  ChangeStreamDocument[];
  flushing: boolean;
}

const subs = new Set<Sub>();
const MAX_QUEUE = 256;

function send(sub: Sub) {
  if (sub.flushing || sub.queue.length === 0) return;
  if (sub.ws.readyState !== WebSocket.OPEN) return;
  sub.flushing = true;
  while (sub.queue.length > 0 && sub.ws.bufferedAmount < 1_000_000) {
    sub.ws.send(JSON.stringify(sub.queue.shift()));
  }
  sub.flushing = false;
  if (sub.queue.length > 0) setTimeout(() => send(sub), 50);  // backoff
}

function push(sub: Sub, change: ChangeStreamDocument) {
  if (sub.queue.length >= MAX_QUEUE) sub.queue.shift();        // drop oldest
  sub.queue.push(change);
  send(sub);
}

async function startWatcher() {
  const cursor = dbClient.db.collection('orders').watch(
    [{ $match: { operationType: { $in: ['insert', 'update', 'delete'] } } }],
    { fullDocument: 'updateLookup' },
  );
  for await (const change of cursor) {
    const orgId = (change as any).fullDocument?.org_id
      ?? (change as any).fullDocumentBeforeChange?.org_id;
    if (!orgId) continue;
    for (const sub of subs) {
      if (sub.orgId === orgId) push(sub, change);
    }
  }
}

const wss = new WebSocketServer({ port: 4000 });
wss.on('connection', async (ws, req) => {
  const token = new URL(req.url!, 'http://x').searchParams.get('t');
  let orgId: string;
  try { ({ orgId } = await verifyJwt(token!)); }
  catch { ws.close(4401, 'unauthorized'); return; }

  const sub: Sub = { ws, orgId, queue: [], flushing: false };
  subs.add(sub);
  ws.on('close', () => subs.delete(sub));
});

void startWatcher();
```

Auth happens on upgrade. The `$match` in the pipeline pre-filters to the operations we care about; the in-process loop filters to the per-client org. Backpressure drops the oldest event when the queue hits the cap, and pauses the flush when the socket's send buffer crosses 1 MB. The watcher does not persist a resume token here — UI sync is the use case, so a restart re-snapshots through the next page's request cycle.

### (b) Postgres LISTEN/NOTIFY → SSE

For a single-process app where you don't want a separate queue infrastructure, LISTEN/NOTIFY + SSE is the lightest realtime setup that works.

```ts
// app/api/stream/route.ts (Next.js App Router)
import { Client } from 'pg';

export async function GET(req: Request) {
  const orgId = await assertOrgFromJwt(req);

  const listener = new Client({ connectionString: process.env.PG_DIRECT_URL });
  await listener.connect();
  await listener.query('LISTEN row_changes');

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      // SSE keepalive every 25s — proxies drop idle connections at 30s+
      const keepalive = setInterval(() => {
        controller.enqueue(encoder.encode(`: keepalive\n\n`));
      }, 25_000);

      listener.on('notification', (msg) => {
        if (msg.channel !== 'row_changes') return;
        const evt = JSON.parse(msg.payload!);
        if (evt.org_id !== orgId) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
      });

      req.signal.addEventListener('abort', async () => {
        clearInterval(keepalive);
        await listener.end();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
    },
  });
}
```

The trigger from the [LISTEN / NOTIFY](#postgres-listen--notify) section publishes the events. One PG connection per SSE client is the trade-off — fine up to a few hundred concurrent clients; past that, move to a single shared listener that broadcasts internally.

### (c) BullMQ outbox pattern

The pattern that subsumes LISTEN/NOTIFY for at-least-once delivery: write to a forge-managed `outbox` table inside the same transaction as the business write, then a worker tails the outbox and dispatches.

```ts
// src/repos/order.ts
export async function createOrder(input: OrderInput) {
  return db.$transaction(async (tx) => {
    const order = await tx.order.create({ data: input });
    await tx.outbox.create({
      data: {
        id:        crypto.randomUUID(),
        topic:     'order.created',
        payload:   { id: order.id, customer_id: order.customer_id },
        status:    'pending',
        created_at: new Date(),
      },
    });
    return order;
  });
}
```

```ts
// src/workers/outbox.ts
import { Worker, Queue } from 'bullmq';

const dispatchQ = new Queue('outbox-dispatch', { connection: redis });

async function drainOutbox() {
  const batch = await db.outbox.findMany({
    where:   { status: 'pending' },
    orderBy: { created_at: 'asc' },
    take:    100,
  });
  for (const row of batch) {
    await dispatchQ.add(row.topic, row.payload, { jobId: row.id });
    await db.outbox.update({ where: { id: row.id }, data: { status: 'sent' } });
  }
}

// Poll every second, or wake on a LISTEN/NOTIFY trigger.
setInterval(drainOutbox, 1_000);

new Worker('outbox-dispatch', async (job) => {
  // job.id is the outbox row id — BullMQ dedupes on it.
  await fetch(webhookUrl, { method: 'POST', body: JSON.stringify(job.data) });
}, { connection: redis });
```

Why the outbox over LISTEN/NOTIFY direct: the business write and the publication are in one transaction. Either both happen or neither — no "row written, world not told" failure mode. BullMQ's `jobId` dedupes the retry, and the `status` column lets a separate sweep catch jobs the worker died holding. Combine with NOTIFY to make `drainOutbox` event-driven instead of polled:

```ts
await tx.$executeRaw`SELECT pg_notify('outbox', '')`;
// listener.on('notification', () => drainOutbox())
```

NOTIFY wakes the drain immediately; polling catches anything NOTIFY lost across a reconnect.

### (d) Browser-side watch on local SQLite

Pure-browser; no server. The pattern that powers offline-first apps once the server has reconverged the local DB.

```ts
// src/db/watch.ts
import { db } from '@/db';
import { queryClient } from '@/query-client';
import { qk } from '@/db/keys';

const bc = new BroadcastChannel('forge-writes');

// Wrap mutations.
export const watched = {
  customer: {
    upsert: async (input: CustomerInput) => {
      const row = await db.customer.upsert({
        where:  { id: input.id },
        create: input,
        update: input,
      });
      bc.postMessage({ model: 'customer', id: row.id, op: 'U' });
      return row;
    },
    delete: async (id: string) => {
      await db.customer.delete({ where: { id } });
      bc.postMessage({ model: 'customer', id, op: 'D' });
    },
  },
};

// One subscriber per tab — invalidates TanStack Query caches on every write.
bc.onmessage = (evt) => {
  const { model } = evt.data as { model: 'customer' };
  queryClient.invalidateQueries({ queryKey: qk[model].all() });
};
```

`BroadcastChannel` crosses tabs of the same origin, so a write in tab A invalidates tab B's cache. The pattern composes with the server-side WebSocket bridge: the WebSocket handler also calls `bc.postMessage(...)` after applying a remote change, and the BroadcastChannel subscriber doesn't care whether the source was local or remote. See [BROWSER §Multi-tab safety](./BROWSER.md#multi-tab-safety) for the OPFS-SAHPool constraints that make the multi-tab story work.

---

## See also

* [README §Watching queries](../README.md#watching-queries) — the `db.$on('query', cb)` event bus, which every section above composes with.
* [EVENTS](./EVENTS.md) — the full `QueryEvent` shape, subscription pattern, sampling, and worked sinks (pino, OTel, Sentry, Prometheus).
* [MONGO §Change streams](./MONGO.md#change-streams) — the full reference for `watch()`, `fullDocument: 'updateLookup'`, resume tokens, and replica-set requirements.
* [POSTGRES §LISTEN / NOTIFY](./POSTGRES.md#listen--notify) — payload limits, the dedicated-connection rule, PgBouncer gotcha.
* [POSTGRES §Replication and read replicas](./POSTGRES.md#replication-and-read-replicas) — operational shape for streaming replication and the read-your-own-writes trap.
* [MYSQL](./MYSQL.md) — binlog formats (`ROW` vs `STATEMENT`), GTID-based replication, the `gh-ost` migration tool that piggybacks on the same plumbing.
* [SQLITE](./SQLITE.md) — `AFTER INSERT/UPDATE/DELETE` triggers, FTS5 shadow-table trigger pattern, the WAL mode that update hooks see.
* [BROWSER](./BROWSER.md) — the sqlite-wasm Web Worker shape, OPFS persistence, multi-tab safety, and `db.$migrate()` at runtime.
* [REACT §Realtime sync over websockets](./REACT.md#realtime-sync-over-websockets) — TanStack Query invalidation, the outbox pattern for offline writes, BroadcastChannel cross-tab invalidation.
* [BACKEND](./BACKEND.md) — the production wiring of forge + Mongo + BullMQ, including the outbox tail loop and the observability sinks.
* [STREAMING](./STREAMING.md) — `findManyStream` for large result sets (a different shape than change-feed watching — bounded scan, not unbounded tail).
* [TRANSACTIONS](./TRANSACTIONS.md) — the `db.$transaction(async (tx) => …)` block that anchors the trigger-emitted-NOTIFY and outbox-write patterns above.
