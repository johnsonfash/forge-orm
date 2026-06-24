# Audit log

An audit log is the immutable record of who changed what, when. forge-orm doesn't ship one — but its event surface (QueryEvent) gives you everything needed to wire one in three different shapes: a single polymorphic table, per-model history tables, or an append-only event log.

The [Mutation events](./MUTATIONS.md#mutation-events) section of
MUTATIONS.md is the half-page tour; [EVENTS.md](./EVENTS.md) is the
field-by-field reference for the channel. This page covers the three
architectural choices, how to thread the actor through, how to
capture before/after diffs, the trigger-based alternative on each
dialect, and the tamper-resistance shape that turns a useful log
into a defensible one.

## Contents

* [What an audit log is](#what-an-audit-log-is)
* [Why it matters](#why-it-matters)
* [Three architectural choices](#three-architectural-choices)
* [Implementation A — single polymorphic table](#implementation-a--single-polymorphic-table)
* [Implementation B — table per model](#implementation-b--table-per-model)
* [Implementation C — append-only event log](#implementation-c--append-only-event-log)
* [Capturing the actor](#capturing-the-actor)
* [Capturing changes — before/after diffs](#capturing-changes--beforeafter-diffs)
* [Trigger-based audit](#trigger-based-audit)
* [Application-layer audit via forge events](#application-layer-audit-via-forge-events)
* [Sensitive field redaction](#sensitive-field-redaction)
* [Retention and cold storage](#retention-and-cold-storage)
* [Tamper-resistance — hash chains](#tamper-resistance--hash-chains)
* [Query patterns](#query-patterns)
* [Soft-delete interaction](#soft-delete-interaction)
* [Worked examples](#worked-examples)

---

## What an audit log is

An audit log answers four questions about every state change:

| Question | Field          |
|----------|----------------|
| Who?     | `actor_id`     |
| What?    | `model`, `entity_id`, `action`, `before`, `after` |
| When?    | `at`           |
| Where?   | `request_id`, `ip`, `user_agent` (optional) |

Two properties separate it from an ordinary log file:

1. **Immutable.** Rows are appended, never updated or deleted in
   place. The table is constrained: no `UPDATE` privilege for the
   application role, no `DELETE` at all, retention enforced by a
   job that exports to cold storage and drops by partition.
2. **Trustworthy.** A compromised application that hides its
   tracks defeats the point. The standard defences are write-only
   DB grants, hash chaining, periodic notarisation, and shipping
   rows to a write-once external store (S3 Object Lock) within
   seconds of insert.

forge's job is to feed the log. Immutability and trust are
properties of the schema and the deployment, not of the ORM.

---

## Why it matters

Three drivers:

* **Compliance.** SOC 2 (CC7.2, CC7.3), HIPAA (§164.312(b)),
  PCI-DSS (10.2), GDPR (Art. 30) and ISO 27001 (A.12.4) all
  require a tamper-evident record of who accessed or changed
  regulated data, retained for one to seven years.
* **Production debugging.** An incident at 03:00 — "why is order
  17 showing the wrong total?" — is faster to resolve when the
  audit log can show the four updates that touched the row in the
  last hour, each with the actor and the before/after.
* **Accountability.** Internal mistakes (a support agent deletes
  the wrong tenant) and external attacks (a stolen token issues
  bulk updates) leave the same footprint in application logs. The
  audit log is what lets you tell them apart.

A test for whether your audit log earns its keep: can you answer
"everything actor X did between T1 and T2", "history of entity Y",
and "all deletes in the last 24 hours" — without grepping
application logs?

---

## Three architectural choices

| Shape                       | Schema cost           | Query cost                | Typed reads      | When to pick                  |
|-----------------------------|-----------------------|---------------------------|------------------|-------------------------------|
| Single polymorphic table    | one table             | filter by `model`+`entity_id` | partial (JSON) | starting out, mixed workload  |
| Table per model             | one per audited model | direct                    | yes              | hot per-model history reads   |
| Append-only event log       | one table per aggregate | replay or projection    | derived          | event-sourcing, time-travel   |

Not mutually exclusive. A common end state is shape A as the
default, shape B for one or two hot models, and shape C for
aggregates that need full replay.

* **Pick A** when the access pattern is "history of one entity" or
  "what did actor X do". JSON `before` / `after` keep the schema
  flat at the cost of partial typing.
* **Pick B** when one model has audit-driven reads (a billing
  ledger UI, a compliance dashboard) needing typed columns, joins,
  or per-column indexes.
* **Pick C** when the audited model is genuinely event-shaped —
  order lifecycle, account balance — and the current row is a
  projection of the events.

Whichever you pick, the forge wiring is the same: a `db.$on('query',
…)` listener, or a database trigger, or both.

---

## Implementation A — single polymorphic table

One table, every model writes into it. Columns identify which model
and which row was touched; the change itself goes into two JSON
columns.

```ts
import { model, f } from 'forge-orm';

export const AuditLog = model('audit_log', {
  id:          f.id(),
  at:          f.timestamp().default(() => new Date()),
  model:       f.string(),
  entity_id:   f.string(),
  action:      f.string(),        // insert | update | delete | softDelete | restore
  actor_id:    f.string().nullable(),
  actor_kind:  f.string().nullable(),
  before:      f.json().nullable(),
  after:       f.json().nullable(),
  request_id:  f.string().nullable(),
  ip:          f.string().nullable(),
  user_agent:  f.string().nullable(),
  semantic_op: f.string().nullable(),
}, {
  indexes: [
    ['model', 'entity_id'], ['actor_id', 'at'],
    ['at'],                 ['action', 'at'],
  ],
});
```

The four indexes cover the four read patterns from [Query
patterns](#query-patterns): entity history, actor activity,
global timeline, deletes-in-last-24h.

Costs of the polymorphic shape:

* JSON `before` / `after` are queryable on Postgres, Mongo, and
  DuckDB but indexable usefully only on Postgres (expression
  indexes) and Mongo. Read paths that scan by a JSON field will
  table-scan on MySQL / SQLite — if you need that, pick shape B for
  that model.
* `model` is a string, not a foreign key. Renaming a model breaks
  historical queries; freeze the audit `model` value at the schema
  level.
* The table grows linearly with mutation volume. Plan [retention
  and cold storage](#retention-and-cold-storage) before it reaches
  the size that makes `VACUUM` painful.

Pros: one schema, one listener, every model audited.

---

## Implementation B — table per model

One audit table per audited model, with the same columns as the
source plus the audit metadata.

```ts
export const PostHistory = model('post_history', {
  id:           f.id(),
  post_id:      f.string(),      // entity, not an FK — row must survive parent delete
  at:           f.timestamp().default(() => new Date()),
  action:       f.string(),
  actor_id:     f.string().nullable(),

  // mirrored Post fields, all nullable
  title:        f.string().nullable(),
  body:         f.string().nullable(),
  author_id_v:  f.string().nullable(),
  status:       f.string().nullable(),
  updated_at_v: f.timestamp().nullable(),

  changed:      f.json().nullable(),   // which fields changed
}, {
  indexes: [['post_id', 'at'], ['actor_id', 'at'], ['status', 'at']],
});
```

`author_id_v` / `updated_at_v` — the trailing `_v` avoids the
rename trap when the source model adds a `FOREIGN KEY` or `UNIQUE`
that the history table can't carry (history rows are by definition
non-unique on the original PK).

Pros: typed reads, per-column indexes, joins to the live model.
`edits[0].title` is `string | null` at the call site.

Cons:

* Schema bloat. Twenty models means twenty extra tables and twenty
  migrations per schema change. Worth the cost only for the few
  models where typed history reads are load-bearing.
* The listener needs a registry mapping `Model → HistoryModel`. The
  polymorphic shape does not.
* Adding a column is a two-step migration: add to `Post`, then add a
  matching nullable column to `PostHistory`. Older history rows have
  `NULL` for the new column.

A and B can coexist: write to both.

---

## Implementation C — append-only event log

The model's state is derived from a sequence of events. The events
table is the audit log. Current state is a materialised projection
(or computed on the fly).

```ts
export const OrderEvent = model('order_events', {
  id:        f.id(),
  order_id:  f.string(),           // the aggregate
  seq:       f.int(),              // monotonic per order_id
  at:        f.timestamp().default(() => new Date()),
  type:      f.string(),           // 'placed' | 'paid' | 'shipped' | …
  actor_id:  f.string().nullable(),
  payload:   f.json(),
}, {
  uniques: [['order_id', 'seq']],
  indexes: [['order_id', 'seq', { name: 'order_events_order_seq_idx' }]],
});
```

The unique `(order_id, seq)` is what makes the log a log:
concurrent writers collide on the constraint rather than
interleaving.

A projection reduces events to current state:

```ts
function projectOrder(events: OrderEvent[]): Order {
  return events.reduce<Order>((acc, e) => {
    switch (e.type) {
      case 'placed':    return { ...acc, status: 'placed', ...e.payload };
      case 'paid':      return { ...acc, status: 'paid',  paid_at: e.at };
      case 'shipped':   return { ...acc, status: 'shipped', tracking: e.payload.tracking };
      case 'cancelled': return { ...acc, status: 'cancelled' };
      default:          return acc;
    }
  }, {} as Order);
}
```

Time-travel queries — "what did this order look like at noon
yesterday?" — become a `findMany` filtered on `at` and the same
projection.

Cons:

* The whole codebase has to model state as events. Halfway adoption
  produces two mental models in one database.
* Replay cost grows with event count. Either snapshot periodically
  or denormalise current state into a `current_order` row updated
  in the same `$transaction`.
* No partial updates. Typo-fixes are correction events appended on
  top, not edits to the original.

Event sourcing pays off when the business questions are about
history (accounting, regulatory reporting, dispute resolution),
less when they're about current state.

---

## Capturing the actor

The audit row needs `actor_id`. The mutation runs deep inside a
route handler that has no obvious way to pass the actor to the
forge listener — which fires after the fact with only the
`QueryEvent`.

`AsyncLocalStorage` is the standard fix. The HTTP middleware that
authenticates the request opens a context; everything inside —
handlers, services, the forge listener — reads from the same
context.

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

interface AuditContext {
  actor_id?:   string;
  actor_kind?: 'user' | 'system' | 'service';
  request_id?: string;
  ip?:         string;
  user_agent?: string;
}

export const auditCtx = new AsyncLocalStorage<AuditContext>();

app.use((req, _res, next) => {
  auditCtx.run({
    actor_id:   req.user?.id,
    actor_kind: req.user ? 'user' : 'system',
    request_id: req.headers['x-request-id'] as string,
    ip:         req.ip,
    user_agent: req.headers['user-agent'],
  }, next);
});
```

`AsyncLocalStorage` propagates through `Promise.then`, `await`,
`setTimeout`, and most async hooks; the forge listener stays in
the caller's tree. For workers, the producer attaches the actor to
the job payload; the worker opens `auditCtx.run(payload._audit,
…)` before calling the repository. Cost is small (single-digit
percent in Node 20). The alternatives — a global mutable, or
explicit `actor` params on every call — either race or pollute
every call site.

---

## Capturing changes — before/after diffs

`QueryEvent` carries SQL and params, not the row. To get `before` /
`after`, the application either reads the row before the write,
reads it back after, or moves the diff into a trigger.

### Pre-read inside the same transaction

```ts
async function updatePost(id: string, patch: PostPatch) {
  return db.$transaction(async (tx) => {
    const before = await tx.post.findUnique({ where: { id } });
    const after  = await tx.post.update({ where: { id }, data: patch });
    await tx.auditLog.create({
      data: {
        model: 'post', entity_id: id, action: 'update',
        actor_id: auditCtx.getStore()?.actor_id, before, after,
      },
    });
    return after;
  });
}
```

Two reads + one write per mutation, but the diff is exact and the
transaction makes the audit row commit iff the update does.

### Wrapper repository

Every audited mutation goes through one wrapper that does the
pre-read, the write, and the audit insert inside one
`$transaction`. Call sites change from `tx.post.update(…)` to
`auditedUpdate('post', id, patch)` — see [worked example
(a)](#a-single-auditlog-table-fed-by-forge-event-hook).

### Trigger-based capture

Move the diff into the database. The application calls
`db.post.update(…)` as normal; a trigger writes the diff using
`OLD` / `NEW`. Triggers catch every write (including manual SQL)
but cannot see the application actor unless you stash it into a
session variable. See [Trigger-based audit](#trigger-based-audit).

### Storing the diff

Two shapes:

* **Full before + after.** Storage large, queries simple.
* **Full after + `changed: string[]`.** Storage small. "What
  changed?" is cheap, "what was the value at T?" needs replay.

```ts
const diff = <T extends object>(a: T, b: T) =>
  Object.keys(b).filter((k) => (a as any)[k] !== (b as any)[k]);
```

`changed: ['status', 'shipped_at']` makes "every status change"
a JSON-array query rather than a JSON-diff.

---

## Trigger-based audit

Moving the audit write into the database: catches every write
(including migrations and DBA consoles), runs in the same physical
transaction. The costs: the actor is invisible unless a session
variable is set, and the trigger code is per-dialect.

### Postgres — `AFTER` row trigger + `to_jsonb`

```sql
CREATE OR REPLACE FUNCTION audit_trigger() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log (id, model, entity_id, action, actor_id, before, after, request_id)
  VALUES (
    gen_random_uuid()::text, TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id), lower(TG_OP),
    current_setting('audit.actor_id', true),
    CASE TG_OP WHEN 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE TG_OP WHEN 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
    current_setting('audit.request_id', true)
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER posts_audit AFTER INSERT OR UPDATE OR DELETE ON posts
FOR EACH ROW EXECUTE FUNCTION audit_trigger();
```

The application sets the session variables at the start of each
request transaction:

```ts
app.use(async (_req, _res, next) => {
  const ctx = auditCtx.getStore() ?? {};
  await db.$executeRaw`SET LOCAL audit.actor_id = ${ctx.actor_id ?? ''}`;
  await db.$executeRaw`SET LOCAL audit.request_id = ${ctx.request_id ?? ''}`;
  next();
});
```

`SET LOCAL` lives for the duration of the transaction only — no leak
between requests on a pooled connection.

### MySQL — per-table triggers

MySQL has no `to_jsonb`. Either write per-column `JSON_OBJECT(...)`
in the trigger or generate the trigger from the schema:

```sql
CREATE TRIGGER posts_audit_update AFTER UPDATE ON posts FOR EACH ROW
INSERT INTO audit_log (id, model, entity_id, action, actor_id, before, after)
VALUES (
  UUID(), 'posts', NEW.id, 'update', @audit_actor_id,
  JSON_OBJECT('title', OLD.title, 'body', OLD.body, 'status', OLD.status),
  JSON_OBJECT('title', NEW.title, 'body', NEW.body, 'status', NEW.status)
);
```

The actor goes into `@audit_actor_id` at the start of the request.
The per-table cost of writing one trigger per model is what makes
application-layer audit attractive on MySQL.

### SQLite — `AFTER` row trigger

SQLite has triggers and `json_object` but no session variables. The
workaround is a one-row `audit_session` table written at the start
of each request:

```sql
CREATE TABLE audit_session (id INTEGER PRIMARY KEY CHECK (id = 1), actor_id TEXT);

CREATE TRIGGER posts_audit_update AFTER UPDATE ON posts
BEGIN
  INSERT INTO audit_log (id, model, entity_id, action, actor_id, before, after)
  SELECT lower(hex(randomblob(16))), 'posts', NEW.id, 'update',
         (SELECT actor_id FROM audit_session WHERE id = 1),
         json_object('title', OLD.title, 'body', OLD.body),
         json_object('title', NEW.title, 'body', NEW.body);
END;
```

For multi-connection pools, write the session row on the same
connection that runs the mutation — `$transaction` does this.

### Mongo — change streams

Mongo has no triggers, but replica-set deployments expose change
streams: a tailable cursor over the oplog with `fullDocument` and
`fullDocumentBeforeChange` (MongoDB 6+). The change stream runs
out-of-band, so the audit row commits *after* the mutation — a
crash between leaves the mutation un-audited. Resume tokens
(`event._id`) close the gap to at-least-once.

The actor is the same problem as MySQL — stamp `_audit: {
actor_id, request_id }` into a sub-document on every mutation,
extract it from `fullDocument._audit` in the handler. See [worked
example (c)](#c-mongo-change-stream--audit-collection).

### DuckDB and MSSQL

DuckDB has no triggers — audit lives at the application layer.
MSSQL has full trigger support (`inserted` / `deleted` virtual
tables) and `FOR JSON`; the pattern mirrors Postgres with
`SESSION_CONTEXT()` instead of `current_setting`.

---

## Application-layer audit via forge events

When triggers aren't an option — too many dialects, no `SET LOCAL`
support, or the team doesn't own DB schema migrations — wire the
audit log to `db.$on('query', …)`.

```ts
const AUDITED_OPS = new Set(['insert', 'update', 'delete']);
const SKIP_MODELS = new Set(['audit_log', 'sessions', 'rate_limits']);

db.$on('query', async (e) => {
  if (!AUDITED_OPS.has(e.op)) return;
  if (SKIP_MODELS.has(e.model) || e.model === '') return;  // skip audit + raw SQL

  const ctx = auditCtx.getStore() ?? {};
  try {
    await db.auditLog.create({
      data: {
        at:         e.startedAt,
        model:      e.model,
        entity_id:  extractEntityId(e),
        action:     e.semanticOp ?? e.op,
        actor_id:   ctx.actor_id ?? null,
        request_id: ctx.request_id ?? null,
        ip:         ctx.ip ?? null,
        // before/after blank — see capturing-changes for how to fill
        semantic_op: e.semanticOp ?? null,
      },
    });
  } catch (err) {
    log.error('audit_failed', { err, model: e.model, op: e.op });
  }
});
```

Three properties:

1. **Out-of-transaction.** The listener fires *after* commit. A
   failed mutation never produces an audit row (good); a crash
   between mutation and audit write leaves it un-audited (fix
   with the [wrapper shape](#wrapper-repository), which puts the
   audit write in the same `$transaction`).
2. **No before/after.** `QueryEvent` carries SQL and params, not
   row data. Pair the listener with a per-mutation wrapper if the
   diff matters — or use triggers.
3. **Skip the recursion.** Without `SKIP_MODELS.has('audit_log')`,
   the audit write produces a `QueryEvent`, which the listener
   tries to audit, until the stack blows.

Fan-out semantics — async listeners run in parallel, exceptions
are swallowed — are documented in [EVENTS.md — Multiple
subscribers and fan-out](./EVENTS.md#multiple-subscribers-and-fan-out).
Log audit failures explicitly so you notice when the pipeline
breaks.

---

## Sensitive field redaction

Never write a password hash, an API token, a Stripe secret key, or a
session cookie into the audit log. Two reasons:

* The audit log is a high-value target. If it contains tokens, a DB
  compromise equals a compromise of every token ever rotated.
* GDPR Art. 17 (right to erasure) interacts badly with an immutable
  log full of PII. Better to never write the data than to design a
  carve-out.

The redaction layer is a config on top of the listener:

```ts
const REDACT: Record<string, Set<string>> = {
  user:    new Set(['password_hash', 'totp_secret', 'session_token']),
  apikey:  new Set(['hashed_key', 'plaintext_key']),
  payment: new Set(['stripe_secret', 'card_number', 'cvv']),
};

function redact<T extends object>(model: string, row: T | null): T | null {
  if (!row) return row;
  const fields = REDACT[model];
  if (!fields) return row;
  const out: any = { ...row };
  for (const f of fields) if (f in out) out[f] = '[redacted]';
  return out;
}
```

Three conventions:

* **Field allow-list per model, not a global deny-list.** New
  columns are audited by default. Invert for sensitive-by-default
  models (a `secrets` table — drop the row entirely from audit).
* **Length cap.** Replace `before` / `after` over ~64 KB with
  `{ truncated: true, size: N }`.
* **Diff over full.** Storing only `changed: string[]` keeps PII
  out of the audit row entirely — at the cost of "what was the
  value before?" queries.

Data minimisation (GDPR Art. 5(1)(c)) and immutability are easier
to reconcile when the log is structured around *intent* ("user
changed their email") than around *content* ("email changed from X
to Y").

---

## Retention and cold storage

Audit logs grow. A medium-traffic SaaS at 100 writes/second produces
~8.6M rows/day, ~3.1B/year. The mitigations:

1. **Partition by time.** Postgres `PARTITION BY RANGE (at)` with
   monthly partitions. Dropping a partition is instant; `DELETE`
   from a 3B-row table is not.
2. **Hot retention.** Keep the last 90 days online; ship older
   partitions to S3 Parquet, partitioned by `at` and `model`.
   Athena / DuckDB / ClickHouse read the cold tier for exports.
3. **Statutory retention.** SOC 2 wants 1 year; HIPAA 6; PCI-DSS 1;
   GDPR up to 10; financial/tax records up to 7. Pick the max and
   apply S3 Object Lock in COMPLIANCE mode — write-once-read-many,
   no early delete even by the AWS root.
4. **GDPR erasure.** Either tombstone the row (`actor_id = NULL`,
   `before/after` overwritten with `{ erased: true, erased_at: T }`)
   or rely on the Art. 17(3)(b) "audit log necessary for
   compliance" exemption. The tombstone preserves the [hash
   chain](#tamper-resistance--hash-chains) without preserving PII.

The retention job runs as a forge `$transaction` that exports the
partition to S3, verifies the manifest hash, and then `DROP
PARTITION`s. A crash mid-export leaves the partition in place for
the next run.

---

## Tamper-resistance — hash chains

A useful audit log can also be false. A useful *and* trusted one
uses a hash chain: each row's hash includes the prior row's hash,
so any modification to a historical row invalidates every row
after it.

```ts
import { createHash } from 'node:crypto';

function rowHash(prev_hash: string, row: AuditLogRow): string {
  return createHash('sha256').update(JSON.stringify({
    id: row.id, at: row.at.toISOString(),
    model: row.model, entity_id: row.entity_id, action: row.action,
    actor_id: row.actor_id, before: row.before, after: row.after,
    prev_hash,
  })).digest('hex');
}
```

Add two columns:

```ts
export const AuditLog = model('audit_log', {
  // … existing …
  prev_hash: f.string().nullable(),
  row_hash:  f.string(),
});
```

The write sequence:

```ts
await db.$transaction(async (tx) => {
  const prev = await tx.auditLog.findFirst({
    orderBy: { id: 'desc' },
    select:  { row_hash: true },
  });
  const prev_hash = prev?.row_hash ?? 'GENESIS';
  const row = { id: f.id.next(), at: new Date(), /* … */, prev_hash };
  const row_hash = rowHash(prev_hash, row);
  await tx.auditLog.create({ data: { ...row, row_hash } });
});
```

Three caveats:

* **Single writer per chain.** Two concurrent writers reading the
  same `prev_hash` produce two rows that both claim to follow it.
  Either serialise through an advisory lock
  (`pg_advisory_xact_lock(42)`) or shard by `(model, entity_id)`
  so each entity has its own chain.
* **Verification.** A periodic job walks the chain in order and
  recomputes each hash. Mismatches alert. The job is read-only — a
  repair would mask the tampering.
* **Notarisation.** Publish the tip hash hourly to an external
  write-once store (S3 Object Lock, a transparency log) to extend
  tamper-evidence beyond the DB boundary.

For most teams, the chain plus a write-only DB grant plus daily S3
export is enough.

---

## Query patterns

The four read patterns the audit log has to serve fast, using the
indexes from [Implementation
A](#implementation-a--single-polymorphic-table):

### "Show me everything actor X did, last 24 hours"

```ts
const events = await db.auditLog.findMany({
  where:   { actor_id: 'u_123', at: { gte: new Date(Date.now() - 86_400_000) } },
  orderBy: { at: 'desc' }, take: 100,
});
```

Hits `audit_actor_at_idx`. Sub-millisecond on Postgres for one
actor's day, regardless of total table size.

### "Show me the history of entity Y"

```ts
const history = await db.auditLog.findMany({
  where:   { model: 'order', entity_id: 'o_42' },
  orderBy: { at: 'asc' },
});
```

Hits `audit_entity_idx`. Full lifecycle of the order.

### "Show me all DELETEs in the last 24 hours"

```ts
const deletes = await db.auditLog.findMany({
  where:   { action: { in: ['delete', 'softDelete'] },
             at: { gte: new Date(Date.now() - 86_400_000) } },
  orderBy: { at: 'desc' },
});
```

Hits `audit_action_at_idx`. Useful as a daily "did we delete
anything unexpected" check, paired with an alert.

### "Compliance export — every change to PII fields, last quarter"

```ts
const pii = await db.auditLog.findMany({
  where:   { model: { in: ['user', 'customer', 'patient'] },
             at: { gte: quarterStart, lt: quarterEnd } },
  orderBy: [{ at: 'asc' }],
});
```

For multi-million-row exports, stream with cursor pagination —
see [QUERIES.md](./QUERIES.md#cursor-pagination).

---

## Soft-delete interaction

A soft-delete is an audit event: the row is hidden from reads,
flagged as deleted, still present. The forge soft-delete verbs
(`softDelete`, `softDeleteMany`, `restore`, `restoreMany`) compile
to plain `update`s, but emit a `QueryEvent` with the `semanticOp`
field set so the audit listener records the higher intent:

```ts
db.$on('query', async (e) => {
  if (e.op !== 'update' || !e.semanticOp) return;
  await db.auditLog.create({
    data: {
      at:       e.startedAt,
      model:    e.model,
      action:   e.semanticOp,           // 'softDelete' | 'restore' | …
      actor_id: auditCtx.getStore()?.actor_id,
    },
  });
});
```

The audit `action` reads as `softDelete` rather than `update`, so
the [DELETEs query](#show-me-all-deletes-in-the-last-24-hours)
catches it. `restore` is the inverse — the same query filtered on
`restore` shows undeletes. See [`semanticOp`
taxonomy](./EVENTS.md#semanticop-taxonomy) for the full list of
intent tags forge emits. A dedicated SOFT-DELETE.md is planned and
will carry the audit-side wiring too.

---

## Worked examples

Four end-to-end patterns.

### (a) Single AuditLog table fed by forge event hook

The wrapper shape — captures before/after inside the same
transaction, no triggers, polymorphic table from [Implementation
A](#implementation-a--single-polymorphic-table):

```ts
import { db, auditCtx } from './db';

const REDACT: Record<string, Set<string>> = {
  user:   new Set(['password_hash', 'totp_secret']),
  apikey: new Set(['hashed_key', 'plaintext_key']),
};

const redact = <T extends Record<string, any>>(model: string, row: T | null): T | null => {
  if (!row) return row;
  const fields = REDACT[model]; if (!fields) return row;
  const out = { ...row };
  for (const f of fields) if (f in out) out[f] = '[redacted]';
  return out;
};

export async function auditedUpdate<T extends { id: string }>(
  modelName: string,
  id: string,
  patch: Partial<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    const t = (tx as any)[modelName];
    const before = await t.findUnique({ where: { id } });
    const after  = await t.update({ where: { id }, data: patch });
    const ctx = auditCtx.getStore() ?? {};
    await tx.auditLog.create({
      data: {
        at: new Date(), model: modelName, entity_id: id, action: 'update',
        actor_id:   ctx.actor_id ?? null,
        actor_kind: ctx.actor_kind ?? null,
        request_id: ctx.request_id ?? null,
        before:     redact(modelName, before),
        after:      redact(modelName, after),
      },
    });
    return after;
  });
}

await auditedUpdate('post', postId, { title: 'New title' });
```

For models without a wrapper, add the lightweight listener from
[Application-layer audit](#application-layer-audit-via-forge-events).

### (b) Postgres trigger-based audit

`PostHistory` populated by trigger — no application wiring after
the migration ships, catches every write including manual SQL:

```sql
CREATE TABLE post_history (
  id text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(),
  post_id text NOT NULL, action text NOT NULL, actor_id text,
  title text, body text, status text
);
CREATE INDEX post_history_post_at_idx ON post_history (post_id, at DESC);

CREATE OR REPLACE FUNCTION post_history_trigger() RETURNS trigger AS $$
DECLARE
  r record := COALESCE(NEW, OLD);
BEGIN
  INSERT INTO post_history (id, post_id, action, actor_id, title, body, status)
  VALUES (
    encode(gen_random_bytes(13), 'hex'), r.id, lower(TG_OP),
    current_setting('audit.actor_id', true),
    r.title, r.body, r.status
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER posts_audit AFTER INSERT OR UPDATE OR DELETE ON posts
FOR EACH ROW EXECUTE FUNCTION post_history_trigger();
```

The application sets the actor with `SET LOCAL audit.actor_id = …`
at the start of each request transaction. Triggers catch every
write — including manual SQL, migrations, and replication —
because they live below the application layer.

Read it from forge as a normal model:

```ts
const history = await db.postHistory.findMany({
  where:   { post_id: 'p_42' },
  orderBy: { at: 'desc' },
  take:    100,
});
```

To extend this with the hash chain from [worked example
(d)](#d-hash-chain-for-tamper-detection), add `prev_hash text`,
`row_hash text` columns and compute them in PL/pgSQL using
`pgcrypto`'s `digest()` over a canonical concatenation of the row
fields plus the chain head.

### (c) Mongo change-stream → audit collection

A long-lived worker tails the change stream and writes to the
audit collection. The application stamps `_audit` on every write so
the stream handler can recover the actor:

```ts
function withAudit<T extends object>(data: T) {
  const ctx = auditCtx.getStore();
  return ctx ? { ...data, _audit: { actor_id: ctx.actor_id, request_id: ctx.request_id } } : data;
}

await db.post.create({ data: withAudit({ title: 'Hello', body: 'World' }) });

async function runAuditStream() {
  const client = db.$raw();
  const stream = client.watch(
    [{ $match: { 'ns.coll': { $nin: ['audit_log', 'sessions'] } } }],
    {
      fullDocument:             'updateLookup',
      fullDocumentBeforeChange: 'whenAvailable',
      resumeAfter:              await loadResumeToken(),
    },
  );
  for await (const evt of stream) {
    const a = evt.fullDocument?._audit ?? {};
    await db.auditLog.create({
      data: {
        at:        new Date(),
        model:     evt.ns.coll,
        entity_id: String(evt.documentKey._id),
        action:    evt.operationType,
        actor_id:  a.actor_id ?? null,
        before:    evt.fullDocumentBeforeChange ?? null,
        after:     evt.fullDocument ?? null,
      },
    });
    await saveResumeToken(evt._id);
  }
}
```

The resume token is what makes this at-least-once across worker
restarts — the stream picks back up from the last processed
event. Wrap the body in a retry loop with backoff for production.

### (d) Hash chain for tamper detection

The verification job plus daily notarisation:

```ts
import { createHash } from 'node:crypto';

const GENESIS = 'GENESIS';

const rowHash = (row: AuditLogRow, prev_hash: string) =>
  createHash('sha256').update(JSON.stringify({
    id: row.id, at: row.at.toISOString(),
    model: row.model, entity_id: row.entity_id, action: row.action,
    actor_id: row.actor_id, before: row.before, after: row.after,
    prev_hash,
  })).digest('hex');

export async function verifyChain(): Promise<{ ok: boolean; first_bad?: string }> {
  let prev_hash = GENESIS;
  let cursor: string | undefined;
  for (;;) {
    const batch = await db.auditLog.findMany({
      where:   cursor ? { id: { gt: cursor } } : undefined,
      orderBy: { id: 'asc' },
      take:    1000,
    });
    if (batch.length === 0) return { ok: true };
    for (const row of batch) {
      if (rowHash(row, prev_hash) !== row.row_hash) {
        return { ok: false, first_bad: row.id };
      }
      prev_hash = row.row_hash;
    }
    cursor = batch[batch.length - 1].id;
  }
}

export async function notariseHead() {
  const tip = await db.auditLog.findFirst({
    orderBy: { id: 'desc' },
    select:  { id: true, row_hash: true },
  });
  if (!tip) return;
  await s3.putObject({
    Bucket: 'audit-notary',
    Key:    `${new Date().toISOString().slice(0, 10)}.json`,
    Body:   JSON.stringify({ tip_id: tip.id, tip_hash: tip.row_hash }),
    ObjectLockMode:           'COMPLIANCE',
    ObjectLockRetainUntilDate: new Date(Date.now() + 7 * 365 * 86_400_000),
  });
}
```

Cache the last-good cursor between runs to reduce `verifyChain`
to "new rows since yesterday". `notariseHead` writes the tip to
S3 Object Lock — a future tamper has to alter both the audit DB
and a write-locked S3 object.

---

See [EVENTS.md](./EVENTS.md) for the channel listeners hang off,
[MUTATIONS.md](./MUTATIONS.md) for the verbs that generate
audit-worthy events, [TRANSACTIONS.md](./TRANSACTIONS.md) for the
shape that wraps mutation + audit write atomically, and
[`semanticOp` taxonomy](./EVENTS.md#semanticop-taxonomy) for the
intent tags the audit listener branches on. SOFT-DELETE.md,
SECURITY.md, and COMPLIANCE.md are planned and will cover the
deployment-side controls — write-only DB grants, network
isolation, key management, audit retention by framework.
