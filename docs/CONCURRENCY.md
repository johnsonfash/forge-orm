# Concurrency control

Two strategies — pessimistic (lock first) and optimistic (mutate-then-check). This page covers when each is appropriate, the version-column pattern, ETag/If-Match HTTP mapping, retry shapes, and the per-dialect quirks (Postgres SERIALIZABLE retry, MySQL deadlock detection, Mongo optimistic via findOneAndUpdate).

The [Optimistic concurrency](./MUTATIONS.md#optimistic-concurrency) and
[Pessimistic locking](./MUTATIONS.md#pessimistic-locking) sections in
`docs/MUTATIONS.md` are the five-line short forms. This doc is the
companion reference: why "read then write" loses, why the version
column is one column not two, how `updateMany`'s affected-rows count
is the only signal you have on every adapter, what `If-Match` maps to
in the database, and which dialects retry for you vs. which make you
write the retry loop.

Everything below assumes 2.5.x. The relevant implementation files are
`src/factory.ts` (the `updateMany` path that returns `{ count }`) and
`src/adapters/*/adapter.ts` (the per-dialect affected-rows shape).

## Contents

* [The two strategies](#the-two-strategies)
* [When to pick each](#when-to-pick-each)
* [Lost updates — what each strategy prevents](#lost-updates--what-each-strategy-prevents)
* [Optimistic with a version column](#optimistic-with-a-version-column)
* [Optimistic without a version column](#optimistic-without-a-version-column)
* [Compare-and-swap upsert](#compare-and-swap-upsert)
* [ETags and `If-Match` HTTP](#etags-and-if-match-http)
* [Retry shape — bounded, exponential, jittered](#retry-shape--bounded-exponential-jittered)
* [Optimistic vs isolation level](#optimistic-vs-isolation-level)
* [Per-dialect quirks](#per-dialect-quirks)
* [Mongo optimistic via `findOneAndUpdate`](#mongo-optimistic-via-findoneandupdate)
* [CRDTs and offline](#crdts-and-offline)
* [Conflict resolution at the app layer](#conflict-resolution-at-the-app-layer)
* [Browser sqlite-wasm — local-first writes](#browser-sqlite-wasm--local-first-writes)
* [Four worked patterns](#four-worked-patterns)
* [Cross-references](#cross-references)

---

## The two strategies

Two ways to keep concurrent writers from clobbering each other on the
same row. Every variant in the wild is a flavour of one.

**Pessimistic — lock first, then mutate.** Hold a lock on the row from
the moment you read it until COMMIT. Other writers block. The lock is
done by the database — `SELECT … FOR UPDATE` on Postgres / MySQL,
`WITH (UPDLOCK, ROWLOCK)` on MSSQL, the writer lock on SQLite, the
implicit per-document lock on Mongo. The contract: while you hold the
lock, the row cannot change underneath you. The cost: blocked
siblings, and a crash before COMMIT keeps the lock until the
deadlock-detector or lock-timeout fires.

**Optimistic — mutate, then check.** No lock. Compose the update as
`WHERE id = X AND version = N` and bump `N → N+1` in the same
statement. The affected-rows count tells you whether the row was where
you thought. Zero = a concurrent writer won; refetch and retry. The
cost: dropped work on conflict, and a retry loop you write. The
benefit: no locks held across user think-time, no blocked siblings,
no lock-timeout failure mode.

The two compete per-write, not per-service. A service that takes
`FOR UPDATE` on the account balance row during a transfer and uses
optimistic versioning on the user profile is doing the right thing for
each. Pick per write.

The third "strategy" — no concurrency control — is what you get if
you don't think about this. It loses writes silently under load and
is indistinguishable from working code at low traffic. It is not a
strategy.

---

## When to pick each

The decision is about the critical section's length, the read-to-write
ratio, and the retry tolerance.

**Pessimistic when:**

* The critical section between read and write is short —
  milliseconds, server-side, all inside one `$transaction`. A
  bank-transfer step is the canonical case.
* The retry tolerance is low. A reservation system, an inventory
  deduct, a counter that must never go negative. The user's mental
  model is "I clicked, it should have worked."
* The contention is server-side. Two queue workers draining the same
  item; two cron jobs rotating the same secret. The next worker can
  afford to wait.
* The lock disappears at COMMIT and you are not holding it across a
  network call or user think-time. See
  [Connection lifecycle](./TRANSACTIONS.md#connection-lifecycle).

**Optimistic when:**

* It is a web request. The user reads, edits for thirty seconds,
  clicks save. A lock for thirty seconds blocks everyone else.
* The read-to-write ratio is high. A blog post read 10,000 times per
  edit — pay the concurrency cost on writes, not on reads.
* The retry is cheap. The client can prompt "this was edited,
  refresh," or auto-merge non-conflicting fields.
* You are crossing a request boundary. The version travels in the
  response; the client returns it on the next write. No server-side
  state.

**The dividing line — how long is the read-to-write window?** If it
is milliseconds and bounded by your code, pessimistic is cheaper. If
it spans a user, a network, a UI, or a queue, optimistic is the only
safe choice — you cannot hold a database lock across any of those
without falling into the
[connection-lifecycle pit](./TRANSACTIONS.md#connection-lifecycle).

---

## Lost updates — what each strategy prevents

The textbook anomaly. Two clients read the same row, both compute a
new value, both write. The second overwrites the first as if it
never happened.

```ts
// Request A and request B race.
const doc = await db.doc.findFirst({ where: { id } });   // both see body='hello'
const newBody = transform(doc.body);                      // both compute
await db.doc.update({ where: { id }, data: { body: newBody } });
// A writes 'HELLO', B writes 'hello!' — last writer wins, the other is gone.
```

Two reads. Two transforms. Two writes. Only the second survives. The
user who wrote first sees their change vanish on reload.

**Pessimistic prevents it.** Wrap read-decide-write in a tx; take
`FOR UPDATE` on the read:

```ts
await db.$transaction(async (tx) => {
  const [doc] = await tx.$queryRaw<Doc[]>`
    SELECT * FROM docs WHERE id = ${id} FOR UPDATE
  `;
  const newBody = transform(doc.body);
  await tx.doc.update({ where: { id }, data: { body: newBody } });
});
```

B blocks at `FOR UPDATE` until A commits, then reads A's value, then
transforms it. The transforms run sequentially. Neither is lost.

**Optimistic prevents it.** Add a `version` column; gate the update:

```ts
const doc = await db.doc.findFirst({ where: { id } });
const newBody = transform(doc.body);
const { count } = await db.doc.updateMany({
  where: { id, version: doc.version },
  data:  { body: newBody, version: { increment: 1 } },
});
if (count === 0) throw new ConflictError('stale version');
```

A and B both read `version=5`. Both write `WHERE version=5`. One wins,
flipping the version to 6. The other matches zero rows, returns
`count=0`, throws. The caller refetches and retries on the new
version.

**Without either, both writes succeed silently.** The data model has
no signal. The bug surfaces when a user notices their change is gone
— possibly weeks later. This is the default when you call `update`
without a version gate.

---

## Optimistic with a version column

The cheapest concurrency control there is. One `int` per row,
monotonically increasing, gates every write.

```ts
const Doc = model('docs', {
  id:         f.id(),
  title:      f.string(),
  body:       f.string(),
  version:    f.int().default(0),
  updated_at: f.dateTime().now(),
});

async function saveDoc(id: string, body: string, expected: number) {
  const { count } = await db.doc.updateMany({
    where: { id, version: expected },
    data:  { body, version: { increment: 1 }, updated_at: new Date() },
  });
  if (count === 0) throw new ConflictError('stale version');
}
```

Three things to know.

**`updateMany`, not `update`.** Forge's `update` requires a unique
where clause and throws `P2025` on zero matches. The optimistic
pattern depends on a zero-count *result*, not an exception —
`updateMany` returns `{ count }` and lets the where carry the version
gate alongside the id, which is what you want.

**`version: { increment: 1 }` is atomic relative to the where.** The
SQL is `UPDATE … SET version = version + 1 WHERE id = X AND version
= N` — one statement, no race window between the check and the bump.
Every SQL adapter behaves this way. Mongo gets the same property via
`{ $inc: { version: 1 } }` in `findOneAndUpdate`.

**The `where` is `{ id, version }`, not `{ id }`.** That is the
entire trick. A normal update keyed on `id` always matches. The
version gate turns it into a conditional update that matches only
when the row hasn't moved.

The version that returns the current state on conflict — so the
caller can show the user what changed or feed it into a merge:

```ts
async function saveDoc(id: string, body: string, expected: number) {
  const { count } = await db.doc.updateMany({
    where: { id, version: expected },
    data:  { body, version: { increment: 1 }, updated_at: new Date() },
  });
  if (count === 0) {
    const current = await db.doc.findFirst({
      where: { id }, select: { version: true, updated_at: true },
    });
    throw new ConflictError('stale version', { current });
  }
  return db.doc.findFirst({ where: { id } });
}
```

**One column, not two.** Version is monotonic, integer, exclusive to
the optimistic pattern. `updated_at` is timestamp metadata. Teams who
try to overload `updated_at` as the version run into millisecond
collisions (see below). Default the version to `0`, not null — the
first update is `WHERE version = 0`, the arithmetic stays uniform.

---

## Optimistic without a version column

When you can't add a version column — existing schema, migration
blocked, table owned by another team — the fallback is `updated_at`:

```ts
async function saveDoc(id: string, body: string, expected: Date) {
  const { count } = await db.doc.updateMany({
    where: { id, updated_at: expected },
    data:  { body, updated_at: new Date() },
  });
  if (count === 0) throw new ConflictError('stale updated_at');
}
```

Same shape as the version pattern, with `updated_at` standing in for
`version`. The constraint: `updated_at` must change on every write.
A `BEFORE UPDATE` trigger on PG / MySQL enforces it; on the other
adapters you stamp it in app code and every write path has to
remember.

Two problems with the timestamp shape.

**Granularity.** Timestamps store at some resolution — microseconds on
PG, milliseconds on most others, seconds when JSON-serialised. Two
updates within the same resolution unit write the same `updated_at`
and the optimistic check passes for both. Lost update.

**Clock skew.** `new Date()` from two app servers with skewed clocks
can write timestamps out of order. A later write with an earlier
timestamp looks stale on retry.

The version column has neither problem. Use `updated_at` only when
you genuinely can't add a version column.

---

## Compare-and-swap upsert

The optimistic pattern composes with `upsert` for the "create if
absent, gated update if present" case. The naive shape:

```ts
await db.doc.upsert({
  where:  { id },
  create: { id, body, version: 0 },
  update: { body, version: { increment: 1 } },
});
```

This is **not** a compare-and-swap. The update branch runs whenever
the row exists, regardless of version. To gate the update on the
version, do the update first and fall through to a create on miss:

```ts
async function ensureDoc(id: string, body: string, expected: number) {
  const { count } = await db.doc.updateMany({
    where: { id, version: expected },
    data:  { body, version: { increment: 1 } },
  });
  if (count === 1) return;

  // No row matched — either the row doesn't exist, or the version is stale.
  try {
    await db.doc.create({ data: { id, body, version: 0 } });
  } catch (err) {
    if (err instanceof DbKnownError && err.code === 'P2002') {
      throw new ConflictError('stale version');
    }
    throw err;
  }
}
```

Two statements with the right semantics: insert if absent, update
only if the version matches, conflict otherwise. The race window
between the update and the create is closed by the unique constraint
on `id` — a concurrent inserter loses with `P2002`, which the catch
branch surfaces as a conflict.

For the `DO NOTHING` flavour ("create if absent, leave alone if
present"), use `upsert` with an empty update — see
[`docs/UPSERT.md`](./UPSERT.md#do-nothing-upsert--insert-if-absent)
for the per-dialect emit (`ON CONFLICT DO NOTHING`, `INSERT IGNORE`,
etc.).

---

## ETags and `If-Match` HTTP

The HTTP version of optimistic concurrency. The `version` column
serialises as an `ETag` on reads and is asserted as `If-Match` on
writes. The two patterns are 1-to-1.

```ts
// GET — return the version as ETag.
app.get('/docs/:id', async (req, res) => {
  const doc = await db.doc.findFirst({ where: { id: req.params.id } });
  if (!doc) return res.status(404).end();
  res.setHeader('ETag', `"${doc.version}"`);
  res.json(doc);
});

// PUT — assert it with If-Match.
app.put('/docs/:id', async (req, res) => {
  const ifMatch = req.header('If-Match');
  if (!ifMatch) return res.status(428).end();   // Precondition Required
  const expected = Number(ifMatch.replace(/"/g, ''));

  const { count } = await db.doc.updateMany({
    where: { id: req.params.id, version: expected },
    data:  { ...req.body, version: { increment: 1 } },
  });
  if (count === 0) return res.status(412).end();   // Precondition Failed

  const updated = await db.doc.findFirst({ where: { id: req.params.id } });
  res.setHeader('ETag', `"${updated.version}"`);
  res.json(updated);
});
```

Three status codes carry the protocol:

| Code | Meaning                | When                                                          |
| ---- | ---------------------- | ------------------------------------------------------------- |
| 200  | Updated                | `If-Match` matched and the row was updated.                   |
| 412  | Precondition Failed    | `If-Match` was sent but didn't match the current version.     |
| 428  | Precondition Required  | No `If-Match` sent and the endpoint requires it.              |

`428` forces clients to participate in the optimistic protocol rather
than writing without it. The dallio API standards mandate ETag +
If-Match on every write endpoint; the backend issues `428` when the
header is missing.

**Strong vs weak ETags.** `W/"…"` marks a weak ETag — useful for
cache revalidation, not for `If-Match`. The optimistic pattern needs
strong ETags. `"version"` not `W/"version"`.

**ETags from content hashes.** Without a version column,
`ETag: "${sha256(JSON.stringify(row))}"` works as a content-based
fallback, but the gate has to be a content-check in the update,
which forge can't express directly without a read-inside-tx. Prefer
a version column.

**Client retry.** A `412` means refetch (capturing the new ETag),
reapply the user's intent on the new state, resubmit. The client
chooses how — auto-merge non-conflicting fields, prompt the user,
or surface a "this changed, overwrite?" dialog.

---

## Retry shape — bounded, exponential, jittered

Every optimistic write needs a retry policy at some layer. The minimum
is "let the user retry"; the maximum is "auto-retry N times with
exponential backoff and jitter, then surface." The shape:

```ts
async function withOptimisticRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; isConflict?: (e: unknown) => boolean } = {},
): Promise<T> {
  const { attempts = 5, baseMs = 25, isConflict = (e) => e instanceof ConflictError } = opts;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (!isConflict(err)) throw err;
      // 25ms, 50ms, 100ms, 200ms, 400ms ± 50%.
      const ceil = baseMs * 2 ** i;
      const jitter = Math.floor(Math.random() * ceil * 0.5);
      await new Promise(r => setTimeout(r, ceil + jitter));
    }
  }
  throw lastErr;
}
```

Three rules, same as the deadlock-retry pattern in
[`docs/TRANSACTIONS.md`](./TRANSACTIONS.md#deadlock-and-serialization-failure-retry).

**Bound the attempts.** Five is generous. A hot row seeing five
conflicts in a row is a contention signal that retrying harder won't
fix.

**Back off with jitter.** Three concurrent writers retrying on a
fixed 25ms timer pile right back on top of each other. Exponential
plus 0–50% jitter spreads the herd.

**Refetch inside the retry, not outside.** The function passed in
re-reads the current version each attempt:

```ts
await withOptimisticRetry(async () => {
  const doc = await db.doc.findFirst({ where: { id } });   // re-read each attempt
  const newBody = transform(doc.body);
  const { count } = await db.doc.updateMany({
    where: { id, version: doc.version },
    data:  { body: newBody, version: { increment: 1 } },
  });
  if (count === 0) throw new ConflictError('stale version');
});
```

Passing the version in from outside means the retry always sees the
same stale value and never converges. Read fresh.

See [`docs/ERRORS.md`](./ERRORS.md#exponential-backoff-with-jitter)
for the deadlock-retry variant against `P2034` and the wider transient-
vs-permanent split.

---

## Optimistic vs isolation level

Bumping the isolation level can replace the version gate *inside a
tx*, but it doesn't replace versioning at the HTTP layer.

**Postgres SERIALIZABLE** catches the read-modify-write race for you
— the database notices and aborts the loser with `40001` (`P2034`):

```ts
await db.$transaction(async (tx) => {
  await tx.$executeRaw`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`;
  const doc = await tx.doc.findFirst({ where: { id } });
  await tx.doc.update({ where: { id }, data: { body: transform(doc.body) } });
});
```

One commits, the other gets `P2034`, you retry. Advantage: no version
column. Disadvantage: every read-then-write on contended rows pays
the SERIALIZABLE tax, and each retry pays a fresh connection + re-read.

**MySQL REPEATABLE READ + `FOR UPDATE`** — REPEATABLE READ alone
doesn't block writers, so adding `FOR UPDATE` is pessimistic, not
optimistic. SERIALIZABLE on MySQL adds gap-locking — more deadlocks,
not fewer conflicts.

**MSSQL SNAPSHOT** is equivalent to PG SERIALIZABLE for this pattern
(requires `ALLOW_SNAPSHOT_ISOLATION ON`).

**SQLite SERIALIZABLE** is the de facto level (single writer). The
conflict surfaces as `SQLITE_BUSY` → `P2034` — same retry shape.

**The trade.** Isolation-level retry covers cross-row anomalies the
version column can't catch (the "at least one doctor on call"
write-skew). Version-column retry covers single-row updates and
crosses HTTP boundaries — you can put a version in a response, you
cannot put a SERIALIZABLE tx in one. Use both: version at the API
layer, isolation level for tx-internal atomic decisions. See
[`docs/TRANSACTIONS.md#isolation-levels`](./TRANSACTIONS.md#isolation-levels)
for the per-dialect table.

---

## Per-dialect quirks

What's actually different about concurrency on each adapter.

### Postgres

* `SELECT … FOR UPDATE` row-locks for the tx; `FOR UPDATE NOWAIT`
  returns immediately on a held row; `FOR UPDATE SKIP LOCKED` skips
  them (useful for job queues).
* SERIALIZABLE is *Serializable Snapshot Isolation* — no extra
  locks, conflict detection on read-write dependencies. Losers abort
  with `40001` → `P2034`.
* Deadlocks → `40P01` → `P2034`. The detector wakes every
  `deadlock_timeout` (default 1s) and aborts the youngest tx.
* Advisory locks (`pg_advisory_xact_lock`,
  `pg_try_advisory_xact_lock`) when there's no natural row to lock —
  see [`docs/TRANSACTIONS.md`](./TRANSACTIONS.md#d-advisory-locks-instead-of-row-locks).

### MySQL (InnoDB)

* `SELECT … FOR UPDATE` and `FOR SHARE` work. SERIALIZABLE adds
  next-key gap locks — more deadlocks, not fewer conflicts.
* REPEATABLE READ catches lost updates *within a single tx* via the
  snapshot, but a concurrent committed write between your read and
  your update is invisible — you'll write over the top. Use the
  version column.
* Deadlocks → errno `1213` → `P2034`. Lock wait timeout → errno
  `1205` → `P2034`. The wait timeout defaults to 50s — drop it on
  contended workloads.
* FK checks acquire shared locks on the parent row; a high-contention
  parent becomes the bottleneck.

### SQLite

* Single-writer. Writes serialise through the writer lock.
  `BEGIN IMMEDIATE` takes the lock up front, eliminating the
  `SQLITE_BUSY` race on deferred lock promotion.
* Optimistic versioning still matters across *processes* and across
  *the network* — two processes (or browser tabs talking to
  sqlite-wasm) can both read the same version and submit. The
  writer lock serialises who runs first; it does not help with "the
  second one's read is now stale."
* WAL mode (forge's default) lets readers proceed during a write.
  `SQLITE_BUSY` from racing writers maps to `P2034` — pair with the
  retry loop.

### DuckDB

* Single-writer per process — same model as SQLite. No deadlock
  detector. Optimistic versioning is the right pattern when DuckDB
  sits behind a fan-out service. No `SAVEPOINT` — see
  [`docs/TRANSACTIONS.md`](./TRANSACTIONS.md#duckdb).

### MSSQL

* `WITH (UPDLOCK, ROWLOCK)` is the row update lock;
  `WITH (UPDLOCK, HOLDLOCK)` extends it to end-of-tx — rough
  equivalent of `FOR UPDATE`. `READPAST` is MSSQL's `SKIP LOCKED`.
* Deadlock victim → errno `1205` → `P2034`. The detector picks the
  lowest-cost tx, not always the youngest.
* Lock escalation at ~5,000 locks per object goes row → table.
  Bound tx size or `ALTER TABLE … SET (LOCK_ESCALATION = DISABLE)`.

### Mongo

* Single-document operations (`updateOne`, `findOneAndUpdate`,
  `insertOne`) are atomic at the document level. Multi-document
  atomicity requires a tx, which requires a replica set — see
  [`docs/TRANSACTIONS.md`](./TRANSACTIONS.md#mongo-replica-set-requirement).
* `withTransaction` retries `TransientTransactionError` automatically
  — Mongo gets retry-for-free; SQL adapters don't.
* No `$isolated` — removed in 4.2. Use `findOneAndUpdate` with a
  version field in the filter; see below.

---

## Mongo optimistic via `findOneAndUpdate`

The Mongo translation is direct: same version field, same gate-on-
read, bump-on-write, same `{ count: 0 }` signal (mapping to
`matchedCount === 0` from the driver).

```ts
async function saveDoc(id: string, body: string, expected: number) {
  const result = await db.doc.updateMany({
    where: { _id: id, version: expected },
    data:  { body, version: { increment: 1 } },
  });
  if (result.count === 0) throw new ConflictError('stale version');
}
```

Forge emits
`db.docs.updateMany({ _id, version }, { $set: { body }, $inc: { version: 1 } })`.
The `findOneAndUpdate` variant returns the document for free —
forge's `update` accepts the version field alongside `_id` because
Mongo matches by predicate natively, and zero matches throw `P2025`.

**`$isolated` is gone** — removed in Mongo 4.2. The replacement is
multi-document transactions on a replica set. For single-document
optimistic, this doesn't matter; `findOneAndUpdate` is atomic anyway.
`returnDocument: 'after'` is forge's default — no knob.

---

## CRDTs and offline

When the writers aren't on the same database — laptop offline writes,
two browser tabs editing offline, mobile sync after a flight — the
version pattern breaks because there is no shared linearizable
version. Two clients fork from version 5, both write locally
("version 6"), both come back online. The server can't accept both
as version 6.

Three answers:

* **Pessimistic.** Force online before any write. What most web apps
  do. Doesn't scale to truly offline use cases.
* **Optimistic.** First write wins, second client gets a conflict,
  app layer resolves. Works at low collaboration density; breaks
  down when two users routinely edit the same document.
* **CRDT.** Conflict-free Replicated Data Types: data structures
  designed so any two states merge deterministically. Yjs and
  Automerge are the common implementations — every client holds a
  CRDT-typed document, operations commute, sync is "send my ops,
  receive theirs, merge." No version conflict because there is no
  version — there's a partial order of operations.

Forge has no opinions on CRDTs because they aren't a database
concern. The database stores the CRDT state as `bytes` or `json`; the
merge happens in app code:

```ts
const Doc = model('docs', {
  id:        f.id(),
  yjs_state: f.bytes(),                // CRDT state, opaque to the database.
  version:   f.int().default(0),       // Optimistic version on the *envelope*.
});
```

Envelope version on the row, CRDT semantics on the content. Two sync
workers can't clobber each other's writes (envelope versioning); two
users can't clobber each other's edits (CRDT merge). The forge
involvement starts and ends with "store the bytes."

---

## Conflict resolution at the app layer

When the database says "your write lost," what do you do? Three
patterns, increasing complexity.

**Last-write-wins (LWW).** Refetch and retry; the user's intent
overrides whatever changed. Suitable for "stamp my user-id on this
row," "mark this thing as read," "increment my view count." The
optimistic retry loop above is LWW with bounded attempts.

```ts
await withOptimisticRetry(async () => {
  const doc = await db.doc.findFirst({ where: { id } });
  await db.doc.updateMany({
    where: { id, version: doc.version },
    data:  { last_seen_by: userId, version: { increment: 1 } },
  });
});
```

**Field-level merge.** The user edited field A; the concurrent writer
edited field B. Refetch, keep the concurrent's B, write the user's A,
bump the version. Suitable for forms with independent fields,
settings panels, profile editing.

```ts
async function mergeAndRetry(id: string, userChanges: Partial<Doc>, baseVersion: number) {
  const current = await db.doc.findFirst({ where: { id } });
  const merged = mergeDoc(userChanges, current, baseVersion);
  const { count } = await db.doc.updateMany({
    where: { id, version: current.version },
    data:  { ...merged, version: { increment: 1 } },
  });
  if (count === 0) throw new ConflictError('still racing');
}
```

`mergeDoc` is application logic. The forge contract is "give me a
state, I'll write it" — the *what to write* is yours.

**Prompt the user.** The Notion model: surface "this changed, here's
the diff," let the user reconcile, submit the reconciled state with
the new version. Suitable for high-stakes documents and content where
automatic merging would destroy intent.

| Workload                          | Pattern              |
| --------------------------------- | -------------------- |
| Stamp a field, mark as read       | LWW retry            |
| Form with independent fields      | Field-level merge    |
| Document body, code, structured   | Prompt the user      |
| Multi-user simultaneous editing   | CRDT, not optimistic |

Pick per write. A profile-update endpoint that does LWW on
`last_seen_at` and field-level merge on `display_name` is doing the
right thing for each.

---

## Browser sqlite-wasm — local-first writes

When the database is in the browser (forge 2.4+ —
[`docs/BROWSER.md`](./BROWSER.md)), local writes never conflict
because there's one writer per tab (the sqlite-wasm worker), and
multiple tabs serialise through the OPFS leader. The concurrency
story shifts to the sync layer between local and server.

Stamp every local write with a `pending_sync` flag; sync drains them:

```ts
const Doc = model('docs', {
  id:           f.id(),
  body:         f.string(),
  version:      f.int().default(0),
  pending_sync: f.boolean().default(false),    // local-only sync metadata
});

// Local write — save and mark pending.
async function localSave(id: string, body: string) {
  await db.doc.update({
    where: { id }, data: { body, pending_sync: true },
  });
}

// Sync — push pending writes with If-Match, merge on 412.
async function sync() {
  const pending = await db.doc.findMany({ where: { pending_sync: true } });
  for (const local of pending) {
    const res = await fetch(`/docs/${local.id}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': `"${local.version}"` },
      body:    JSON.stringify({ body: local.body }),
    });

    if (res.status === 412) {
      const server = await (await fetch(`/docs/${local.id}`)).json();
      const merged = mergeDoc(local, server);
      await db.doc.update({
        where: { id: local.id },
        data:  { ...merged, pending_sync: true },   // retry next sync
      });
      continue;
    }

    const { version } = await res.json();
    await db.doc.update({
      where: { id: local.id },
      data:  { version, pending_sync: false },
    });
  }
}
```

The local database is the source of truth for the UI. The server is
the source of truth for the canonical state. The sync layer moves
writes between them with optimistic versioning at the network. `412`
from the server surfaces as the app's merge logic.

For high-collaboration editing (multiple users on the same document
offline), graduate to CRDTs. For form-style edits and
single-user-per-document workflows, optimistic + sync is enough.

See [`docs/BROWSER.md`](./BROWSER.md) for multi-tab coordination and
[`docs/MOBILE.md`](./MOBILE.md) for the mobile-app variant.

---

## Four worked patterns

### (a) Edit-doc with ETag / `If-Match`

Standard web edit. The server gates on the version, returns `412` on
conflict, surfaces the current version so the client can refetch.

```ts
// GET /docs/:id
app.get('/docs/:id', async (req, res) => {
  const doc = await db.doc.findFirst({ where: { id: req.params.id } });
  if (!doc) return res.status(404).end();
  res.setHeader('ETag', `"${doc.version}"`);
  res.json(doc);
});

// PUT /docs/:id
app.put('/docs/:id', async (req, res) => {
  const ifMatch = req.header('If-Match');
  if (!ifMatch) return res.status(428).json({ error: 'if_match_required' });
  const expected = Number(ifMatch.replace(/"/g, ''));

  const { count } = await db.doc.updateMany({
    where: { id: req.params.id, version: expected },
    data:  {
      title:      req.body.title,
      body:       req.body.body,
      version:    { increment: 1 },
      updated_at: new Date(),
      updated_by: req.user.id,
    },
  });

  if (count === 0) {
    const current = await db.doc.findFirst({
      where:  { id: req.params.id },
      select: { version: true, updated_at: true, updated_by: true },
    });
    if (!current) return res.status(404).end();
    res.setHeader('ETag', `"${current.version}"`);
    return res.status(412).json({ error: 'version_conflict', current });
  }

  const updated = await db.doc.findFirst({ where: { id: req.params.id } });
  res.setHeader('ETag', `"${updated.version}"`);
  res.json(updated);
});
```

Client-side: refetch on `412`, prompt or auto-merge, resubmit. Cap at
three attempts — past three, surface to the user; the row is mutating
faster than they can keep up with, and silent retries make it look
like the app is fighting them.

### (b) Inventory deduct with optimistic version

The user clicks "buy 2." The server must not go negative, must not
double-deduct, must not hold a lock across user think-time.

```ts
async function deduct(sku: string, qty: number) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const inv = await db.inventory.findFirst({ where: { sku } });
    if (!inv) throw new Error('sku_not_found');
    if (inv.quantity < qty) throw new OutOfStock();

    const { count } = await db.inventory.updateMany({
      where: {
        sku,
        version: inv.version,
        quantity: { gte: qty },       // belt-and-braces invariant
      },
      data: {
        quantity: { decrement: qty },
        version:  { increment: 1 },
      },
    });

    if (count === 1) return;

    // Stale version, or someone deducted enough to push us under.
    const fresh = await db.inventory.findFirst({ where: { sku } });
    if (!fresh) throw new Error('sku_not_found');
    if (fresh.quantity < qty) throw new OutOfStock();

    await new Promise(r => setTimeout(r, 25 * 2 ** attempt + Math.random() * 25));
  }
  throw new StaleVersion();
}
```

Two predicates: `version` for the optimistic gate,
`quantity: { gte: qty }` for the invariant. Both have to hold. If the
quantity went too low, OutOfStock fires; if just the version moved,
the retry catches it.

The atomic-decrement variant without versioning works when the only
invariant is "non-negative" —
`updateMany({ where: { sku, quantity: { gte: qty } }, data: { quantity: { decrement: qty } } })`
plus the zero-count check. Simpler, no retry. Add the version column
when you also need to track who-last-touched-this for audit.

### (c) Counter increment with retry

A page-view counter. The naive read-increment-write shape loses
writes under load. Three right shapes:

**Atomic increment** — no conflict at all:

```ts
await db.counter.update({
  where: { name: 'pageviews' },
  data:  { value: { increment: 1 } },
});
```

The dialect serialises the increment at the row level. No lost
writes. No retry. The default for any "increment this counter" case.

**Atomic increment with cap** — the cap goes in the where:

```ts
const { count } = await db.counter.updateMany({
  where: { name: 'pageviews', value: { lt: 1_000_000 } },
  data:  { value: { increment: 1 } },
});
if (count === 0) throw new Error('counter_capped');
```

**Per-key fan-out** — when one row is too contended, shard into N
rows and write to a random shard; aggregate on read:

```ts
const shard = Math.floor(Math.random() * 16);
await db.counter_shard.update({
  where: { name_shard: { name: 'pageviews', shard } },
  data:  { value: { increment: 1 } },
});
```

16 shards roughly 16x the write throughput at the cost of an
aggregate `SUM(value)` on read.

**The pessimistic shape is always wrong here.** `FOR UPDATE` on a
counter row creates a serial bottleneck and is worse than the atomic
increment in every way. Don't reach for it.

### (d) Collaborative form field with CRDT note

A multi-user form where two users might edit the same field at the
same time. Three escalating shapes.

**Per-field optimistic (low collaboration).** Each field has its own
version; last-write-wins; surface a "refresh and retry" message:

```ts
async function saveField(formId: string, fieldId: string, value: string, expected: number, userId: string) {
  const { count } = await db.form_fields.updateMany({
    where: { form_id: formId, field_id: fieldId, version: expected },
    data:  { value, version: { increment: 1 }, updated_by: userId },
  });
  if (count === 0) throw new ConflictError('field_changed');
}
```

**Per-field with merge prompt (medium collaboration).** Same shape;
on conflict, show the user the other version and let them merge:

```ts
async function saveWithMerge(formId: string, fieldId: string, text: string, expected: number) {
  try { return await saveField(formId, fieldId, text, expected, user.id); }
  catch (err) {
    if (!(err instanceof ConflictError)) throw err;
    const current = await db.form_fields.findFirst({
      where: { form_id: formId, field_id: fieldId },
    });
    const choice = await ui.promptMerge({ yours: text, theirs: current.value });
    return saveField(formId, fieldId, choice, current.version, user.id);
  }
}
```

**Per-field with CRDT (high collaboration — Google Docs case).** The
field value is a CRDT-encoded blob, the version is the envelope:

```ts
const CRDTField = model('crdt_fields', {
  form_id:   f.string(),
  field_id:  f.string(),
  state:     f.bytes(),     // Y.Doc encoded with Y.encodeStateAsUpdate
  version:   f.int().default(0),
}, {
  uniques: [['form_id', 'field_id']],
});

async function syncField(formId: string, fieldId: string, localDoc: Y.Doc) {
  const server = await db.crdt_fields.findFirst({
    where: { form_id: formId, field_id: fieldId },
  });
  if (server) Y.applyUpdate(localDoc, server.state);
  const merged = Y.encodeStateAsUpdate(localDoc);
  await db.crdt_fields.upsert({
    where:  { form_id_field_id: { form_id: formId, field_id: fieldId } },
    create: { form_id: formId, field_id: fieldId, state: merged, version: 0 },
    update: { state: merged, version: { increment: 1 } },
  });
}
```

Envelope version protects the sync layer from losing one client's
state on top of another's. CRDT-level merge protects the content from
clobber. Two layers, independent — envelope versioning is forge's
job, content merge is Yjs's job. See the Yjs / Automerge docs for the
merge semantics; forge has no opinion.

---

## Cross-references

* [docs/MUTATIONS.md](./MUTATIONS.md#optimistic-concurrency) — short-form `updateMany` + version and `FOR UPDATE` patterns.
* [docs/TRANSACTIONS.md](./TRANSACTIONS.md#deadlock-and-serialization-failure-retry) — deadlock retry loop, isolation levels, connection-lifecycle anti-pattern.
* [docs/UPSERT.md](./UPSERT.md) — atomic upsert, `DO NOTHING`, the dallio "atomic upsert is mandatory" repo pattern.
* [docs/ERRORS.md](./ERRORS.md#retry-classes--transient-vs-permanent) — `P2034` retry semantics, exponential backoff with jitter, transient-vs-permanent split.
* [docs/REACT.md](./REACT.md) — TanStack Query's optimistic-update pattern and how it composes with the database-side version column.
* [docs/MOBILE.md](./MOBILE.md) — the mobile-app variant of the local-first / pending-sync / merge-on-conflict pattern.
* [docs/BROWSER.md](./BROWSER.md) — sqlite-wasm, single-writer per tab, OPFS leader lock for multi-tab coordination.
