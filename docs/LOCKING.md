# Locking

Explicit pessimistic locking — row locks (SELECT FOR UPDATE), shared locks, advisory locks, SKIP LOCKED for work queues. This page documents what each dialect supports, what forge exposes, and the lock-ordering / lock-timeout / deadlock-retry patterns that keep systems live under contention.

The [Transactions deep-dive](./TRANSACTIONS.md) covers `$transaction` itself; this doc is the layer above — what happens *inside* the tx callback when two writers want the same row. The README never mentions row locks because the wrapper has no first-class API for them: every example below is forge's raw-SQL escape hatch (`tx.$executeRaw`, `tx.$queryRaw`) issuing the dialect's locking statement, with the wrapper layer used for the rest of the tx body.

Everything below assumes 2.5.x. The implementation files worth knowing about are `src/factory.ts` (where the `tx` proxy hands a `session` to every wrapped call), `src/adapters/<dialect>/adapter.ts` for the per-dialect raw paths, and `src/adapters/postgres/migrate.ts` — the one place inside forge itself that takes a lock (a transaction-scoped advisory lock around `forge push` so two concurrent CI deploys don't race the DDL plan).

## Contents

* [What forge exposes](#what-forge-exposes)
* [The lock matrix](#the-lock-matrix)
* [Per-dialect locking](#per-dialect-locking)
  * [Postgres](#postgres)
  * [MySQL](#mysql)
  * [SQLite](#sqlite)
  * [DuckDB](#duckdb)
  * [MSSQL](#mssql)
  * [Mongo](#mongo)
* [Advisory locks](#advisory-locks)
* [`SKIP LOCKED` — the work-queue pattern](#skip-locked--the-work-queue-pattern)
* [`NOWAIT` — fail fast](#nowait--fail-fast)
* [Lock timeout](#lock-timeout)
* [Gap locks and phantom-read prevention](#gap-locks-and-phantom-read-prevention)
* [Deadlocks — what causes them, how to detect, how to retry](#deadlocks--what-causes-them-how-to-detect-how-to-retry)
* [Lock-ordering convention](#lock-ordering-convention)
* [Long-held locks in HTTP requests](#long-held-locks-in-http-requests)
* [Optimistic alternative](#optimistic-alternative)
* [Monitoring](#monitoring)
* [Worked examples](#worked-examples)
  * [(a) Deduct inventory with `SELECT FOR UPDATE`](#a-deduct-inventory-with-select-for-update)
  * [(b) Job queue with `SKIP LOCKED`](#b-job-queue-with-skip-locked)
  * [(c) Cron singleton with an advisory lock](#c-cron-singleton-with-an-advisory-lock)
  * [(d) MSSQL `UPDLOCK` pattern](#d-mssql-updlock-pattern)
* [Cross-references](#cross-references)

---

## What forge exposes

Forge does not have a `{ lock: 'forUpdate' }` option on `findFirst` / `findMany`. There is no `tx.user.findFirst({ where: { id }, lock: 'forUpdate' })`. There is no `tx.account.lock(...)` helper, no `lockMode` field in the query IR, no per-dialect lock translator. The thinking is the same one behind isolation levels (see [TRANSACTIONS.md › Isolation levels](./TRANSACTIONS.md#isolation-levels)) — every dialect spells row locking differently enough (`FOR UPDATE` vs `WITH (UPDLOCK)` vs raw findOneAndUpdate semantics on Mongo) that a single typed surface would either be a lowest-common-denominator pretence at portability or a sprawling discriminated union nobody uses. Both are worse than "drop to raw SQL inside the tx," so that's what forge does.

What you do get:

* **`tx.$queryRaw` / `tx.$executeRaw`** — issue the dialect's locking statement directly against the tx session. The lock is held for the rest of the tx; the row(s) it returned are typed `unknown[]` from the `$queryRaw` tag, but you usually only need the ids and you already know them.
* **The tx session itself.** Forge guarantees every wrapped call on `tx.x` runs against the same connection / `ClientSession` that `tx.$executeRaw` runs against — there's no risk of "the lock is on connection A and the update is on connection B" the way you'd see with naive pool reuse. See [TRANSACTIONS.md › Per-dialect tx semantics](./TRANSACTIONS.md#per-dialect-tx-semantics) for the underlying handle types.
* **The `pg_advisory_xact_lock` precedent.** Forge itself takes an advisory lock during `forge push` (`src/adapters/postgres/migrate.ts:78`) so two concurrent migration runs serialise instead of racing the DDL plan. That's the same pattern your application code uses for cross-row coordination.

What you don't get:

* A typed "find this row and lock it" wrapper. You write `await tx.$queryRaw` ... `FOR UPDATE` and you read the rows back as `unknown[]`.
* Cross-dialect lock translation. `FOR UPDATE` works on Postgres and MySQL; on MSSQL you write `WITH (UPDLOCK, HOLDLOCK)`; on Mongo you don't lock at all, you use `findOneAndUpdate` or optimistic versioning. There's no shared vocab.
* Automatic retry on lock timeout or deadlock. Forge maps the error codes (`P2034` — see [ERRORS.md › Retry classes](./ERRORS.md#retry-classes--transient-vs-permanent)) but the `for` loop around `db.$transaction(...)` is yours to write. The pattern is at [TRANSACTIONS.md › Deadlock and serialization-failure retry](./TRANSACTIONS.md#deadlock-and-serialization-failure-retry).

The doc below shows what to write per-dialect. The mental model is consistent: open a `$transaction`, issue a raw locking statement against `tx`, do the work with the wrapped API, let the tx commit to release.

---

## The lock matrix

The four categories, what each is for, and which dialects support them.

| Category        | What it does                                                                                  | Postgres | MySQL  | SQLite | DuckDB | MSSQL  | Mongo |
| --------------- | --------------------------------------------------------------------------------------------- | -------- | ------ | ------ | ------ | ------ | ----- |
| Row lock (exclusive) | Lock a specific row(s) for update; concurrent writers wait or fail                       | `SELECT … FOR UPDATE` | `SELECT … FOR UPDATE` | n/a (db-level) | n/a (process-level) | `WITH (UPDLOCK, HOLDLOCK)` | `findOneAndUpdate` |
| Row lock (shared)    | Allow concurrent shared readers; block exclusive writers                                  | `SELECT … FOR SHARE` | `SELECT … LOCK IN SHARE MODE` / `FOR SHARE` (8.0+) | n/a | n/a | `WITH (HOLDLOCK)` | n/a   |
| Advisory lock        | Lock a named integer / string; no row associated; cross-row coordination                  | `pg_advisory_lock` | `GET_LOCK` | n/a | n/a | `sp_getapplock` | model as `_leases` row |
| Table lock           | Lock entire table; rarely justifiable in OLTP                                             | `LOCK TABLE` | `LOCK TABLES` | implicit via `BEGIN EXCLUSIVE` | implicit via tx | `WITH (TABLOCKX)` | n/a   |

A row lock taken inside `$transaction` is released at commit or rollback — never sooner. An advisory lock has two scopes (transaction or session) and the choice matters: the transaction-scoped variants release at commit/rollback (you get cleanup for free); the session-scoped variants outlive the tx and you have to release them by hand (easy to leak under panic / process kill). Prefer transaction-scoped for everything except a long-lived holder process that explicitly wants the lock to outlast a single tx (leader election, cron singleton when the worker plans to drive multiple txs under the same lock).

SQLite and DuckDB don't have row-level locks because they don't need them — both are single-writer (DuckDB per-process, SQLite via the reserved-lock state machine). Concurrent writers serialise at the database level. The lock you take is implicit: `BEGIN IMMEDIATE` on SQLite acquires the reserved lock up front (see [TRANSACTIONS.md › SQLite](./TRANSACTIONS.md#sqlite)); DuckDB serialises writes per-process with no API to influence it. Both are "first writer wins, second writer waits or fails." That's typically what you want.

Mongo doesn't have any of these. Mongo's atomicity guarantee is at the single-document level — you don't lock the document, you write a `findOneAndUpdate` that conditionally mutates and returns the new state. Multi-document atomicity needs `withTransaction` (see [TRANSACTIONS.md › Mongo](./TRANSACTIONS.md#mongo)), and even there the model is "the tx aborts and retries on conflict," not "the tx takes a lock and others wait." This is closer to optimistic locking than pessimistic — see [Optimistic alternative](#optimistic-alternative).

---

## Per-dialect locking

The actual statements you'll write, per dialect, inside a forge `$transaction` callback.

### Postgres

Postgres exposes the richest lock vocabulary. Five row-lock modes, two wait modifiers, and the cleanest advisory-lock API of any SQL dialect.

| Mode                | Effect                                                                                          | Used for                                  |
| ------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `FOR UPDATE`        | Exclusive lock. Blocks every other `FOR UPDATE` / `FOR NO KEY UPDATE` / `FOR SHARE` / `FOR KEY SHARE`. Standard "I'm about to update this row" lock. | The default. Deduct inventory, update balance, mark job claimed. |
| `FOR NO KEY UPDATE` | Weaker exclusive. Doesn't block `FOR KEY SHARE`. Used implicitly by `UPDATE` on non-key columns. | Updating a non-PK / non-FK column while letting FK validation from other txs proceed. |
| `FOR SHARE`         | Shared lock. Multiple readers can hold simultaneously; blocks `FOR UPDATE` / `FOR NO KEY UPDATE`. | "I'm reading this row and I need it to stay stable until commit, but I'm not going to update it." |
| `FOR KEY SHARE`     | Weakest shared. Only blocks `FOR UPDATE`. Used implicitly by FK references.                     | Rarely written explicitly; FK validation takes this lock automatically. |

The forge shape — issue the locking `SELECT` first, then do the work with the wrapped API:

```ts
await db.$transaction(async (tx) => {
  // Lock the row.
  const rows = await tx.$queryRaw<{ id: string; balance: number }[]>`
    SELECT id, balance FROM account WHERE id = ${acctId} FOR UPDATE
  `;
  if (rows.length === 0) throw new Error('account missing');
  const acct = rows[0];
  if (acct.balance < amount) throw new Error('insufficient');

  // Now safe to update. The lock prevents concurrent writers from sneaking
  // between the SELECT and the UPDATE.
  await tx.account.update({
    where: { id: acctId },
    data: { balance: { decrement: amount } },
  });
});
```

The two wait modifiers — `NOWAIT` and `SKIP LOCKED` — both go at the end of the locking clause:

```sql
SELECT … FOR UPDATE NOWAIT       -- fail immediately if row is locked
SELECT … FOR UPDATE SKIP LOCKED  -- silently drop locked rows from the result
```

`NOWAIT` raises `55P03 / lock_not_available` (mapped to nothing in forge — bubbles as the underlying `pg.DatabaseError`). `SKIP LOCKED` raises nothing; locked rows are simply absent from the returned set. The work-queue pattern uses `SKIP LOCKED`; the user-facing "this resource is busy" UI uses `NOWAIT`.

### MySQL

MySQL's vocabulary is narrower:

| Mode                  | Effect                                                                                  | Used for                          |
| --------------------- | --------------------------------------------------------------------------------------- | --------------------------------- |
| `FOR UPDATE`          | Exclusive lock. Same semantics as Postgres `FOR UPDATE`.                                | The default.                      |
| `LOCK IN SHARE MODE`  | Shared lock. MySQL 5.7 / 8.0 compatible.                                                | Read-stable-then-write.           |
| `FOR SHARE`           | MySQL 8.0+ synonym for `LOCK IN SHARE MODE`. Same behaviour.                            | Same.                             |

```ts
await db.$transaction(async (tx) => {
  const rows = await tx.$queryRaw<{ id: number; qty: number }[]>`
    SELECT id, qty FROM inventory WHERE sku = ${sku} FOR UPDATE
  `;
  if (!rows[0] || rows[0].qty < requested) throw new Error('out of stock');
  await tx.inventory.update({
    where: { sku }, data: { qty: { decrement: requested } },
  });
});
```

`NOWAIT` and `SKIP LOCKED` are MySQL 8.0+. Same placement, same semantics:

```sql
SELECT … FOR UPDATE NOWAIT
SELECT … FOR UPDATE SKIP LOCKED
```

On 5.7 you don't have either — you can simulate `NOWAIT` by setting a short `innodb_lock_wait_timeout` (see [Lock timeout](#lock-timeout)) and catching the resulting `ER_LOCK_WAIT_TIMEOUT` (mapped to `P2034`). There's no equivalent for `SKIP LOCKED` on 5.7; if you need a work queue and you're stuck on 5.7, claim rows with a `UPDATE … LIMIT 1` that flips a `claimed_by` column and check `affectedRows` — see [(b) Job queue with `SKIP LOCKED`](#b-job-queue-with-skip-locked) for the 8.0+ pattern and the 5.7 fallback.

MySQL's default isolation is `REPEATABLE READ` (see [TRANSACTIONS.md › MySQL](./TRANSACTIONS.md#mysql)). The interaction with row locking is that range reads inside a tx take **next-key locks** — see [Gap locks](#gap-locks-and-phantom-read-prevention).

### SQLite

SQLite has no row-level locking. The database has a state machine — UNLOCKED → SHARED → RESERVED → PENDING → EXCLUSIVE — and the lock is on the database file, not on rows. The grain you control is "is this transaction in write mode yet."

The pattern is `BEGIN IMMEDIATE` to acquire the reserved lock at the start of the tx instead of letting it promote lazily on first write. Forge emits plain `BEGIN`, which is deferred (see [TRANSACTIONS.md › SQLite](./TRANSACTIONS.md#sqlite)), so you upgrade it inside the callback:

```ts
await db.$transaction(async (tx) => {
  await tx.$executeRaw`BEGIN IMMEDIATE`;   // no-op SQLite tolerates inside an existing tx; promotes the lock
  const row = await tx.account.findFirst({ where: { id: acctId } });
  if (!row || row.balance < amount) throw new Error('insufficient');
  await tx.account.update({
    where: { id: acctId }, data: { balance: { decrement: amount } },
  });
});
```

Concurrent writers serialise. The second writer sees `SQLITE_BUSY` (forge code `P2034` via `src/adapters/sqlite/errors.ts`) until the first one commits. With WAL mode (`PRAGMA journal_mode = WAL`, which forge sets by default — see [DRIVERS.md](./DRIVERS.md)), readers never block writers and vice versa, but writers still block writers.

What you don't get on SQLite: row-level granularity, `FOR UPDATE` semantics across rows in different tables, shared locks (every SQLite write tx is exclusive), `NOWAIT`. The closest to `NOWAIT` is `PRAGMA busy_timeout = 0`, which makes the busy-handler give up immediately — the default is 0, so `SQLITE_BUSY` is already the fail-fast path. The closest to a wait is `PRAGMA busy_timeout = 5000` to wait up to 5s before giving up. Set it per-connection at adapter construction time, not inside a tx.

### DuckDB

DuckDB has no row-level locking and no advisory locks. Every write tx is implicitly exclusive — DuckDB serialises writes per-process and you can't influence it. The same `BEGIN` → `COMMIT` shape applies, and the second writer in another process / connection waits for the first to commit.

```ts
await db.$transaction(async (tx) => {
  // No locking statement to issue. DuckDB serialises writes.
  const rows = await tx.$queryRaw<{ id: number; qty: number }[]>`
    SELECT id, qty FROM inventory WHERE sku = ${sku}
  `;
  if (rows[0].qty < requested) throw new Error('out of stock');
  await tx.inventory.update({
    where: { sku }, data: { qty: { decrement: requested } },
  });
});
```

DuckDB is a poor fit for high-contention OLTP workloads precisely because of this — every concurrent writer is queued globally. The right call on DuckDB is "use it for analytics, use Postgres / MySQL / SQLite for transactional work." If you're already paying that price knowingly, the wrapper above does what you'd expect.

### MSSQL

MSSQL exposes locking through **table hints** rather than a separate `FOR UPDATE` clause. The hints attach to the `FROM` clause of the `SELECT` and influence the locks the planner takes:

| Hint                | Effect                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `UPDLOCK`           | Take an *update lock* on the rows read. Update locks are exclusive against other update / exclusive locks but compatible with shared locks taken before. The "I intend to update these rows" pre-marker. |
| `HOLDLOCK`          | Hold locks until end of transaction (equivalent to `SERIALIZABLE` for that read). Without it, shared locks are released as soon as the read finishes. |
| `ROWLOCK`           | Force row-grain (prevent the planner escalating to page/table). Useful for high-concurrency tables. |
| `READPAST`          | The `SKIP LOCKED` equivalent — skip locked rows instead of waiting. Use for work-queue dequeues. |
| `NOWAIT`            | The `NOWAIT` equivalent — raise error 1222 (lock request timed out) immediately if the row is locked. Apply via `SET LOCK_TIMEOUT 0` per-session rather than as a hint. |
| `TABLOCKX`          | Exclusive table lock. Use only when you mean it.                                                |

The canonical "read for update" hint combination is `WITH (UPDLOCK, HOLDLOCK)` — pre-marks the row exclusive and holds the lock to commit:

```ts
await db.$transaction(async (tx) => {
  const rows = await tx.$queryRaw<{ id: string; balance: number }[]>`
    SELECT id, balance FROM account WITH (UPDLOCK, HOLDLOCK) WHERE id = ${acctId}
  `;
  if (rows.length === 0) throw new Error('account missing');
  if (rows[0].balance < amount) throw new Error('insufficient');
  await tx.account.update({
    where: { id: acctId }, data: { balance: { decrement: amount } },
  });
});
```

For the work-queue pattern, combine `READPAST` with `UPDLOCK`:

```sql
SELECT TOP (1) id FROM job WITH (UPDLOCK, READPAST)
WHERE status = 'pending' ORDER BY created_at
```

— picks one pending job, locks it for update, skips anything another worker has already locked. See [(b) Job queue with `SKIP LOCKED`](#b-job-queue-with-skip-locked).

For `NOWAIT` semantics, set `LOCK_TIMEOUT` to 0 at the start of the tx:

```ts
await tx.$executeRaw`SET LOCK_TIMEOUT 0`;
```

The session keeps that setting for the rest of the tx (and beyond, on most driver pools — you'll want to reset it before commit if your driver reuses connections without resetting).

Default isolation on MSSQL is `READ COMMITTED` (see [TRANSACTIONS.md › MSSQL](./TRANSACTIONS.md#mssql)). Lock escalation kicks in around 5,000 locks per object — when you're locking many rows at once and want to stay at row grain, add `ROWLOCK` to the hint list.

### Mongo

Mongo doesn't expose row locks. The atomicity model is:

1. **Single-document operations are atomic always.** `updateOne`, `findOneAndUpdate`, `insertOne`, `deleteOne` either commit fully or not at all. No tx needed.
2. **Multi-document atomicity uses `withTransaction`.** Forge's `$transaction` on the Mongo adapter calls `session.withTransaction(...)` (see [TRANSACTIONS.md › Mongo](./TRANSACTIONS.md#mongo)). The driver automatically retries on `TransientTransactionError`.
3. **There is no `FOR UPDATE`.** The Mongo idiom is `findOneAndUpdate` with a conditional `filter` — the operation either matches and updates, or doesn't match. Concurrent writers see the post-update state on retry.

The pessimistic pattern, where you'd reach for `FOR UPDATE` on SQL, becomes:

```ts
const updated = await db.account.findOneAndUpdate({
  where: { id: acctId, balance: { gte: amount } },   // condition baked into filter
  update: { $inc: { balance: -amount } },
});
if (!updated) throw new Error('insufficient or missing');
```

— the `balance: { gte: amount }` is the atomicity guarantee. Concurrent writers see whichever update wins; the loser's filter doesn't match and `findOneAndUpdate` returns `null`.

For multi-document scenarios where you'd take row locks on multiple tables, use `withTransaction` and rely on Mongo's optimistic conflict-detection. The pattern at [(a) Deduct inventory](#a-deduct-inventory-with-select-for-update) has a Mongo flavour where the SQL `SELECT FOR UPDATE` is replaced with a conditional `findOneAndUpdate`:

```ts
await db.$transaction(async (tx) => {
  const inv = await tx.inventory.findOneAndUpdate({
    where: { sku, qty: { gte: requested } },
    update: { $inc: { qty: -requested } },
  });
  if (!inv) throw new Error('out of stock');
  await tx.order.create({ data: { sku, qty: requested } });
});
```

The `findOneAndUpdate` is the entire pessimistic story — it's the closest Mongo has to a lock-and-update primitive. The `withTransaction` retry covers the multi-document case where the second statement (`order.create`) might race something else.

`$isolated`, the historical "no-other-write-can-interleave" flag, is removed in 4.0+. Don't use it; use `withTransaction` instead.

---

## Advisory locks

Advisory locks are named integer locks the database holds for you but doesn't tie to any row. Use them when the natural row to lock doesn't exist yet (coalescing concurrent provisioning), when you want one process at a time to do something (leader election, cron singleton), or when the lock spans rows / tables / schemas (running a backfill that touches everything).

### Postgres

The most flexible advisory-lock surface of any dialect. Two scopes, two acquisition modes, and either a single bigint key or two int4 keys.

| Function                        | Scope          | Blocking?      |
| ------------------------------- | -------------- | -------------- |
| `pg_advisory_lock(key)`         | Session        | Blocks         |
| `pg_advisory_xact_lock(key)`    | Transaction    | Blocks         |
| `pg_try_advisory_lock(key)`     | Session        | Non-blocking; returns `true` / `false` |
| `pg_try_advisory_xact_lock(key)` | Transaction   | Non-blocking; returns `true` / `false` |
| `pg_advisory_unlock(key)`       | Session        | Releases (session-scoped only)         |

The transaction-scoped variants release at commit/rollback automatically — prefer them unless you need the lock to outlast the tx. The session-scoped variants outlive the tx and you have to release them by hand; if the process dies, the lock dies with the session, but if the process is fine and you forgot to unlock, the lock leaks until the connection is closed (which in a long-lived pool means "until the next pool churn," potentially never).

The forge shape:

```ts
await db.$transaction(async (tx) => {
  // Non-blocking attempt. The hashToInt8 function takes a domain string
  // like "provision:org_123" and hashes it to a stable int8 — the two-int4
  // pattern that forge's own migrate.ts uses is also fine.
  const key = hashToInt8(`provision:${orgId}`);
  const got = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(${key}) AS ok
  `;
  if (!got[0].ok) throw new Error('busy');

  // Do the work. The lock is held for the rest of the tx and released
  // automatically at commit/rollback.
  await tx.org.create({ data: { id: orgId, ... } });
});
```

The two-int4 form is what `src/adapters/postgres/migrate.ts:78` uses for the `forge push` lock:

```sql
SELECT pg_advisory_xact_lock(0x6f6f7267, 0x65000001)
```

— the high half spells "forg" in ASCII, the low half is "e" + a version byte. Two int4s sidestep the `bigint` JS marshalling annoyance some drivers have, and the namespace is wide enough that domain-prefixed hashes don't collide.

### MySQL

`GET_LOCK(name, timeout)` and `RELEASE_LOCK(name)`. Named string keys (up to 64 chars), session-scoped only (MySQL doesn't have a tx-scoped variant). `timeout` is in seconds; pass `0` for "non-blocking, fail fast" and negative for "wait forever."

```ts
await db.$transaction(async (tx) => {
  const got = await tx.$queryRaw<{ ok: number | null }[]>`
    SELECT GET_LOCK(${`provision:${orgId}`}, 0) AS ok
  `;
  if (got[0].ok !== 1) throw new Error('busy');
  try {
    await tx.org.create({ data: { id: orgId, ... } });
  } finally {
    await tx.$executeRaw`SELECT RELEASE_LOCK(${`provision:${orgId}`})`;
  }
});
```

Since the lock is session-scoped, the `try/finally` is mandatory — if the tx callback throws and you don't release, the lock is held until the session closes. Worse, if you reuse the same pool connection on the next request, the lock is still held and the next caller can't acquire it. The `RELEASE_LOCK` in `finally` is the only protection.

### MSSQL

`sp_getapplock` is the MSSQL equivalent. Configurable scope (session or transaction) via the `@LockOwner` parameter; configurable mode (Shared / Update / Exclusive / IntentShared / IntentExclusive) via `@LockMode`; named string keys.

```ts
await db.$transaction(async (tx) => {
  const result = await tx.$queryRaw<{ status: number }[]>`
    DECLARE @s INT
    EXEC @s = sp_getapplock
      @Resource = ${`provision:${orgId}`},
      @LockMode = 'Exclusive',
      @LockOwner = 'Transaction',
      @LockTimeout = 0
    SELECT @s AS status
  `;
  if (result[0].status < 0) throw new Error('busy');
  await tx.org.create({ data: { id: orgId, ... } });
});
```

`@LockOwner = 'Transaction'` is the tx-scoped variant (released at commit/rollback). Status codes: 0 = granted, 1 = granted after wait, -1 = timeout, -2 = cancelled, -3 = deadlock victim. The `< 0` check covers all three failure modes.

### SQLite, DuckDB, Mongo

None of the three have a native advisory-lock primitive. Model the lock as a row in a `_leases` table with a TTL:

```ts
const Lease = model('_leases', {
  key:        f.string().id(),
  holder:     f.string(),
  expires_at: f.dateTime(),
}, {
  indexes: [{ keys: { expires_at: 1 }, name: 'idx_leases_expires' }],
});

async function withLease<T>(key: string, holderId: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const expiresAt = new Date(Date.now() + ttlMs);
  const taken = await db._leases.upsert({
    where:  { key, expires_at: { lt: new Date() } },   // only takes if expired
    update: { holder: holderId, expires_at: expiresAt },
    create: { key, holder: holderId, expires_at: expiresAt },
  });
  if (taken.holder !== holderId) throw new Error('busy');

  try { return await fn(); }
  finally {
    await db._leases.delete({ where: { key, holder: holderId } }).catch(() => {});
  }
}
```

The TTL is the safety rail — if the holder process dies without releasing, the lease expires and the next caller can take it. The cost is that you have to pick a TTL longer than the worst-case work duration; pick too short and the lock can be stolen out from under a slow worker; too long and a crashed holder blocks others longer than necessary.

For Mongo, the same shape works with the Mongo adapter — `findOneAndUpdate` is the atomic take, and a TTL index on `expires_at` (`indexes: [{ keys: { expires_at: 1 }, expireAfterSeconds: 0 }]`) garbage-collects expired leases.

This is strictly weaker than `pg_advisory_lock` — there's no instantaneous "wait for the holder to release" notification, just polling. For SQLite, DuckDB, and Mongo it's the only option short of an external coordinator (Redis `SETNX`, etcd, Zookeeper).

---

## `SKIP LOCKED` — the work-queue pattern

The classic shape: N workers want to claim work from a job table without any two workers claiming the same row. The naive pattern — `findFirst({ where: { status: 'pending' } })` followed by `update({ where: { id }, data: { status: 'claimed' } })` — races every other worker; you get duplicate processing the moment concurrency rises.

`SELECT … FOR UPDATE SKIP LOCKED` is the fix. The first worker takes the lock; subsequent workers see the row as locked and silently skip it, picking the next eligible row instead. The result set returned to each worker is disjoint — no claim-race.

Postgres:

```ts
async function claimJob(workerId: string): Promise<Job | null> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM job
      WHERE status = 'pending'
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) return null;

    const job = await tx.job.update({
      where: { id: rows[0].id },
      data:  { status: 'claimed', claimed_by: workerId, claimed_at: new Date() },
    });
    return job;
  });
}
```

The tx commits, the lock releases, the row is now `claimed` and the index condition filters it out of every other worker's `SELECT`. The next call to `claimJob` from any worker sees the next pending row.

MySQL 8.0+: identical syntax, identical semantics.

MSSQL: `WITH (UPDLOCK, READPAST)` instead of `FOR UPDATE SKIP LOCKED`:

```sql
SELECT TOP (1) id FROM job WITH (UPDLOCK, READPAST)
WHERE status = 'pending' ORDER BY created_at
```

— see [(b) Job queue with `SKIP LOCKED`](#b-job-queue-with-skip-locked) for the full worked version including the 5.7 fallback (no `SKIP LOCKED` available — use `UPDATE … LIMIT 1` and read `affectedRows`).

Two correctness rules.

**Order the candidates.** `ORDER BY created_at` (or whatever your fairness rule is) inside the locking `SELECT`. Without it, the planner picks rows in storage order, which on Postgres looks like "newest first when there's churn" and you starve the oldest pending jobs.

**Index the claim predicate.** `WHERE status = 'pending'` needs an index that lets the planner scan only pending rows. A partial index — `CREATE INDEX idx_job_pending ON job (created_at) WHERE status = 'pending'` — is ideal, because completed jobs (the vast majority over time) aren't in the index and the scan is bounded by the queue depth, not the table size. See [INDEXES.md › Partial indexes](./INDEXES.md) for the partial-filter shape forge supports.

The pattern scales horizontally — N workers each running `claimJob` will partition the work cleanly. The throughput ceiling is the lock contention on the single index, which in practice is in the tens of thousands of claims/second per Postgres instance; for higher rates, partition by a hash column and have each worker claim from one partition.

---

## `NOWAIT` — fail fast

Use `NOWAIT` when the right answer to "the row is locked" is "tell the user immediately, don't sit on the request for 30 seconds while we wait." The classic case is the UI "edit this resource" button — if someone else is already editing it, you want a "busy, try again" message in 100ms, not a 30-second spinner.

Postgres / MySQL 8.0+:

```ts
try {
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM document WHERE id = ${docId} FOR UPDATE NOWAIT
    `;
    // ...edit...
  });
} catch (err) {
  // PG: SQLSTATE 55P03 (lock_not_available).
  // MySQL 8.0: errno 3572 (ER_LOCK_NOWAIT).
  // Neither is mapped to a forge P-code — they bubble as the underlying driver error.
  if (looksLikeLockNotAvailable(err)) return { status: 'busy' };
  throw err;
}
```

`NOWAIT` errors are *not* mapped to `P2034` because they aren't retryable in the same sense — retrying immediately just produces another `NOWAIT` failure. The right response is to surface "busy" to the caller and let them decide whether to retry with a backoff or give up.

MSSQL doesn't have a per-statement `NOWAIT`. Use `SET LOCK_TIMEOUT 0` at the start of the tx to make every lock acquisition non-blocking:

```ts
await db.$transaction(async (tx) => {
  await tx.$executeRaw`SET LOCK_TIMEOUT 0`;
  const rows = await tx.$queryRaw`
    SELECT id FROM document WITH (UPDLOCK, HOLDLOCK) WHERE id = ${docId}
  `;
  // ...
});
```

A `LOCK_TIMEOUT 0` failure surfaces as error 1222 ("lock request timed out"), distinct from the deadlock-victim 1205 — only 1205 is mapped to `P2034`, the 1222 bubbles. SQLite's equivalent is the default — `PRAGMA busy_timeout = 0` means `SQLITE_BUSY` surfaces immediately, which is the same behaviour without any per-tx setup.

---

## Lock timeout

The default wait time when one tx tries to acquire a lock another tx holds, before the second tx gives up with a lock-timeout error.

| Dialect  | Setting                                      | Default   | Where to set                                                     |
| -------- | -------------------------------------------- | --------- | ---------------------------------------------------------------- |
| Postgres | `SET lock_timeout = '1s'`                    | 0 (unlimited) | At role / DB level for cluster-wide, or per-tx via `SET LOCAL` |
| MySQL    | `SET SESSION innodb_lock_wait_timeout = 1`   | 50 seconds | Per session; bake into the pool's `connectionLimit` config       |
| SQLite   | `PRAGMA busy_timeout = 1000`                 | 0 (immediate `SQLITE_BUSY`) | Per connection                                       |
| DuckDB   | n/a — no row-level locks                     | n/a       | n/a                                                             |
| MSSQL    | `SET LOCK_TIMEOUT 1000`                      | -1 (unlimited) | Per session                                                  |
| Mongo    | `transactionLifetimeLimitSeconds` (server config) | 60      | Server-wide; the tx is killed past this, no per-tx override     |

The recommendation: **set it to something finite at the role / session level**, low enough that hung waits surface quickly, high enough that healthy contention completes in time. 1–5 seconds is a reasonable starting point for OLTP; latency-sensitive paths use shorter values and retry the whole tx on timeout (the `P2034` code covers MySQL `1205` and PG can be matched via SQLSTATE `55P03`).

Per-tx overrides:

```ts
await db.$transaction(async (tx) => {
  await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;   // PG; SET LOCAL scopes to this tx
  // ...
});
```

On Postgres `SET LOCAL` is the safe form — the setting reverts at commit/rollback. Plain `SET` outlives the tx and pollutes the next request that reuses the connection.

On MySQL there's no `SET LOCAL` equivalent for `innodb_lock_wait_timeout`. The session-level `SET SESSION` change sticks for the connection's lifetime; if you change it inside a tx and the pool reuses the connection, the next caller inherits your value. Reset it explicitly at the end of the tx or set it at pool connection-init time.

---

## Gap locks and phantom-read prevention

MySQL InnoDB's default isolation is `REPEATABLE READ`, and it implements phantom-read prevention via **next-key locks** — a row lock plus a lock on the gap immediately preceding the row in index order. Range scans take next-key locks on every row in the range *and* the gaps before them, so an `INSERT` into the gap is blocked.

This is mostly invisible until it isn't. The symptom is `ER_LOCK_DEADLOCK` (1213, mapped to `P2034`) at higher rates than you'd expect, often between two transactions that don't appear to touch the same rows at all. The cause is two range-locking range scans that hit each other on the gap.

The fix, in decreasing order of cost-to-change:

1. **Use single-row lookups when you can.** `WHERE id = ?` takes a row lock with no gap. `WHERE created_at > ?` takes a range lock with gap.
2. **Add the indexes the planner needs to use single-row lookups.** If `WHERE email = ?` is doing a table scan because there's no `email` index, it takes the implicit gap lock on every row scanned.
3. **Drop isolation to `READ COMMITTED` for hot paths.** PG ships with `READ COMMITTED` by default and most of these problems don't exist there; MySQL inherits `REPEATABLE READ` and the gap-locking story. `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` per-tx (see [TRANSACTIONS.md › Isolation levels](./TRANSACTIONS.md#isolation-levels)) keeps reads cheaper at the cost of phantom-read protection.

The PG equivalent is `Serializable Snapshot Isolation` (SERIALIZABLE), which detects conflicts and aborts losers rather than locking gaps. The conflict surface is narrower and the aborts come back as `40001` (also `P2034`), so the retry pattern at [Deadlocks](#deadlocks--what-causes-them-how-to-detect-how-to-retry) catches both.

MSSQL takes range locks under `SERIALIZABLE` and shared locks under `READ COMMITTED`. The MSSQL story is closer to MySQL's — escalation and lock-mode interactions can produce surprising contention under load. The hint vocabulary (`ROWLOCK`, `READPAST`, `UPDLOCK`) gives you per-statement control that PG and MySQL don't.

---

## Deadlocks — what causes them, how to detect, how to retry

A deadlock happens when two (or more) txs each hold a lock the other wants. The textbook two-tx case:

```
T1: UPDATE account WHERE id = 1   -- takes lock on row 1
T2: UPDATE account WHERE id = 2   -- takes lock on row 2
T1: UPDATE account WHERE id = 2   -- waits for T2
T2: UPDATE account WHERE id = 1   -- waits for T1  →  DEADLOCK
```

The database detects the cycle (every modern engine has a wait-for-graph detector running every few hundred ms) and picks a victim — usually the tx that's done less work. The victim's writes are rolled back and an error is raised. The other tx commits normally.

The error codes:

| Dialect  | Code                       | Forge `DbKnownError.code` |
| -------- | -------------------------- | ------------------------- |
| Postgres | SQLSTATE `40P01`           | `P2034`                   |
| Postgres | SQLSTATE `40001` (serialization failure under SERIALIZABLE) | `P2034`  |
| MySQL    | errno `1213`               | `P2034`                   |
| MySQL    | errno `1205` (lock-wait timeout — counts as transient) | `P2034`     |
| MSSQL    | error `1205` (deadlock victim) | `P2034`               |

`P2034` is the universal "retry the whole transaction" signal. See [TRANSACTIONS.md › Deadlock and serialization-failure retry](./TRANSACTIONS.md#deadlock-and-serialization-failure-retry) for the full retry-with-jitter implementation. The short version:

```ts
import { DbKnownError } from 'forge-orm';

async function withTxRetry<T>(body: (tx: any) => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await db.$transaction(body);
    } catch (err) {
      const retryable = err instanceof DbKnownError && err.code === 'P2034';
      if (!retryable || i === attempts - 1) throw err;
      const ceil = 25 * 2 ** i;
      await new Promise(r => setTimeout(r, ceil + Math.random() * ceil * 0.5));
    }
  }
  throw new Error('unreachable');
}
```

The rules from [TRANSACTIONS.md](./TRANSACTIONS.md#deadlock-and-serialization-failure-retry) apply unchanged here:

* **Bound the attempts.** Five is a reasonable default; ten is a code smell. > 3 average retries on a hot path means redesign the contention, not retry harder.
* **Back off with jitter.** Linear or no-jitter exponential causes thundering herds.
* **Recreate the tx.** The session has been rolled back and released. Re-entering `db.$transaction` is non-negotiable.

The hard part isn't the retry loop — it's preventing the deadlock in the first place. The next section covers the only general-purpose technique that works.

---

## Lock-ordering convention

Deadlocks happen when two txs acquire the same locks in different orders. They don't happen if every tx in the system acquires locks in the **same canonical order**. The convention is: sort the things you're about to lock by a stable key (id, name, hash), then take locks in that order.

The bank-transfer example shows the shape (it's also at [TRANSACTIONS.md › Five worked patterns › Bank transfer](./TRANSACTIONS.md#a-bank-transfer)):

```ts
async function transfer(fromId: string, toId: string, amount: number) {
  return db.$transaction(async (tx) => {
    // Lock both accounts in id order — not in transfer direction.
    const [firstId, secondId] = fromId < toId ? [fromId, toId] : [toId, fromId];

    const rows = await tx.$queryRaw<{ id: string; balance: number }[]>`
      SELECT id, balance FROM account WHERE id IN (${firstId}, ${secondId})
      ORDER BY id
      FOR UPDATE
    `;
    const from = rows.find(r => r.id === fromId)!;
    if (from.balance < amount) throw new Error('insufficient');

    await tx.account.update({ where: { id: fromId }, data: { balance: { decrement: amount } } });
    await tx.account.update({ where: { id: toId },   data: { balance: { increment: amount } } });
    await tx.ledger.create({ data: { from_id: fromId, to_id: toId, amount } });
  });
}
```

A `transfer(A, B, 10)` and a concurrent `transfer(B, A, 5)` both lock A first, then B — they serialise instead of deadlocking. The mirror-image deadlock window is gone.

This works because the locking `SELECT` takes both locks atomically in id order. Without the canonical sort, `transfer(A, B)` would lock A then try to lock B, and `transfer(B, A)` would lock B then try to lock A — the classic deadlock pattern.

Apply this everywhere you take more than one lock in a single tx. Pick a stable key (the primary key is the obvious one; sometimes you need a derived key like `min(table_name, id)`-as-string), sort by it, lock in sorted order. The cost is a `sort` and a slightly less natural query shape; the benefit is no deadlocks from same-shape txs running concurrently.

The pattern doesn't fix deadlocks between different-shape txs that touch the same rows from different access paths — those still need the retry loop. But it dramatically reduces the rate, often by 10x on contended hot paths.

---

## Long-held locks in HTTP requests

A row lock taken inside a `$transaction` is held until commit. If the tx body does an external HTTP call between taking the lock and committing, the lock is held for the duration of the HTTP call. Under load, that's a queue: every concurrent request that wants the same row stacks up waiting for the external call to return.

The anti-pattern:

```ts
await db.$transaction(async (tx) => {
  const rows = await tx.$queryRaw`SELECT * FROM user WHERE id = ${id} FOR UPDATE`;
  const score = await fraudService.check(rows[0]);   // 800ms HTTP call holding the lock
  if (score.ok) {
    await tx.user.update({ where: { id }, data: { ... } });
  } else {
    throw new Error('blocked');
  }
});
```

A 20-connection pool caps you at 25 transactions per second per worker on this user if the external call is 800ms — every concurrent transfer queues behind the lock. Restructure so the external call happens before the lock is taken:

```ts
// 1. Read the relevant state without locking.
const user = await db.user.findFirst({ where: { id } });
const score = await fraudService.check(user);
if (!score.ok) throw new Error('blocked');

// 2. Re-enter the tx for the actual mutation. The lock is held for milliseconds.
await db.$transaction(async (tx) => {
  const rows = await tx.$queryRaw`SELECT * FROM user WHERE id = ${id} FOR UPDATE`;
  // Optional: re-check the precondition under the lock to handle the read-then-write race.
  if (rows[0].version !== user.version) throw new Error('stale');
  await tx.user.update({ where: { id }, data: { ... } });
});
```

The cost is that you have to handle the read-then-write race — the state might have changed between the unlocked read and the locked re-read. The standard fix is a version column (see [Optimistic alternative](#optimistic-alternative)) — include the version in the locked re-read and bail if it changed.

The rule of thumb from [TRANSACTIONS.md › Long-running transactions](./TRANSACTIONS.md#long-running-transactions) applies to locks specifically: **a transaction that holds a lock for more than 100ms is suspect, and one that holds a lock for more than 1 second is broken.** The 100ms threshold catches the "we accidentally held the lock across an external call" bug; the 1 second threshold catches the "we accidentally held the lock across a slow query inside the tx" bug.

---

## Optimistic alternative

For workloads where conflicts are rare, optimistic locking is dramatically cheaper than pessimistic. You don't take a lock; you read the row with a version number, do your work, and on the way out you `UPDATE … WHERE id = ? AND version = ?` — if the row's version changed in the meantime, the `UPDATE` affects zero rows and you retry or surface a conflict error.

The full pattern is in [VERSIONING.md](./VERSIONING.md), but the shape is:

```ts
// Models with a `version` column:
const Account = model('account', {
  id:      f.id(),
  balance: f.int(),
  version: f.int().default(0),
});

async function debit(id: string, amount: number) {
  for (let i = 0; i < 5; i++) {
    const acct = await db.account.findFirst({ where: { id } });
    if (!acct || acct.balance < amount) throw new Error('insufficient');

    const updated = await db.account.updateMany({
      where: { id, version: acct.version },
      data:  { balance: acct.balance - amount, version: acct.version + 1 },
    });
    if (updated.count === 1) return;
    // Lost the race. Re-read and retry.
  }
  throw new Error('contention');
}
```

When to choose optimistic over pessimistic:

| Choose pessimistic (`FOR UPDATE`) when                                   | Choose optimistic (`version` + retry) when                                |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Conflicts are common (every concurrent caller touches the same row)      | Conflicts are rare (most callers touch different rows)                    |
| The work after the lock is fast (< 100ms) and known-bounded              | The work is variable-length or includes external calls                    |
| You need cross-row consistency (lock multiple rows in a stable order)    | You're updating a single row and re-reading is cheap                      |
| The retry cost is high (large reads, complex computation)                | The retry cost is low (a few field updates)                               |

The Mongo-style `findOneAndUpdate` with a conditional filter (see [Mongo](#mongo) above) is a degenerate case of optimistic locking — the filter is the version check, and the retry is built into the application logic on `null` return. On SQL, the same conceptual move is `updateMany` with a `version` predicate and a `count === 1` check.

---

## Monitoring

You can't fix lock contention you can't see. Each dialect has a "what's holding what" view; the relevant queries:

**Postgres** — `pg_locks` joined with `pg_stat_activity`:

```sql
SELECT pid, locktype, relation::regclass, mode, granted, query
FROM pg_locks l JOIN pg_stat_activity a USING (pid)
WHERE relation IS NOT NULL
ORDER BY pid;
```

Add `WHERE granted = false` to see only waiters. The `query` column shows what the holder / waiter is doing. For lock-wait diagnostics over time, enable `log_lock_waits = on` (the slow-query log will include lock waits > `deadlock_timeout`, which defaults to 1 second).

**MySQL** — `INFORMATION_SCHEMA.INNODB_TRX` and the deadlock log:

```sql
SELECT trx_id, trx_state, trx_started, trx_query, trx_rows_locked, trx_lock_structs
FROM INFORMATION_SCHEMA.INNODB_TRX
WHERE trx_state != 'RUNNING' OR trx_rows_locked > 0
ORDER BY trx_started;
```

`SHOW ENGINE INNODB STATUS\G` prints the last deadlock the engine detected, including the two txs and what they were doing. Persistent deadlock logging needs `innodb_print_all_deadlocks = ON` — without it, only the last one is kept in memory.

**MSSQL** — `sys.dm_tran_locks` and the deadlock trace:

```sql
SELECT request_session_id, resource_type, resource_database_id, resource_associated_entity_id,
       request_mode, request_status
FROM sys.dm_tran_locks
WHERE request_status = 'WAIT';
```

For historical deadlocks, enable trace flag 1222 (`DBCC TRACEON (1222, -1)`) and check the error log, or use Extended Events to capture `xml_deadlock_report`.

**SQLite / DuckDB** — limited. SQLite has no lock-introspection view; `sqlite3_busy_handler` callbacks tell you when a wait happens but there's no aggregate view of who's holding what. DuckDB has no such surface — write contention manifests as elevated wait time on the global writer, not as visible locks.

**Mongo** — `db.currentOp({ "waitingForLock": true })` shows operations stuck behind a lock; `db.serverStatus().locks` aggregates per-lock-type acquisition counts and times. Use the Mongo profiler (set to `1` for slow operations) and the `lockStats` field on profiled ops.

The forge event stream (`$on('query', ...)` — see [EVENTS.md](./EVENTS.md)) doesn't include lock-wait information directly, but slow-query events correlate well with lock waits: if `query.durationMs` for an `UPDATE` jumps and the rest of the workload is unchanged, it's usually a lock wait.

---

## Worked examples

### (a) Deduct inventory with `SELECT FOR UPDATE`

The textbook case. An order comes in; we need to atomically check inventory has enough stock, decrement it, and create the order. Two concurrent orders for the same SKU must not both succeed when only one unit is left.

The naive shape (broken):

```ts
// DON'T — racy.
const inv = await db.inventory.findFirst({ where: { sku } });
if (inv.qty < requested) throw new Error('out of stock');
await db.inventory.update({ where: { sku }, data: { qty: { decrement: requested } } });
await db.order.create({ data: { sku, qty: requested } });
```

Between the read and the update, another order can decrement `qty` to below `requested` and you'll oversell.

The pessimistic fix:

```ts
async function placeOrder(sku: string, requested: number) {
  return db.$transaction(async (tx) => {
    // Postgres / MySQL.
    const rows = await tx.$queryRaw<{ id: number; qty: number }[]>`
      SELECT id, qty FROM inventory WHERE sku = ${sku} FOR UPDATE
    `;
    if (rows.length === 0) throw new Error('unknown sku');
    if (rows[0].qty < requested) throw new Error('out of stock');

    await tx.inventory.update({
      where: { sku }, data: { qty: { decrement: requested } },
    });
    return tx.order.create({ data: { sku, qty: requested } });
  });
}
```

The `FOR UPDATE` is held until the tx commits. A concurrent `placeOrder` for the same SKU sits on the `SELECT FOR UPDATE` until the first one commits, then re-reads the post-decrement `qty` and either succeeds with what's left or fails with "out of stock." No oversell.

The optimistic alternative for the same problem is `updateMany` with a `qty >= requested` predicate — atomic at the row-lock level the database takes for the UPDATE, no explicit `FOR UPDATE` needed:

```ts
async function placeOrder(sku: string, requested: number) {
  return db.$transaction(async (tx) => {
    const result = await tx.inventory.updateMany({
      where: { sku, qty: { gte: requested } },
      data:  { qty: { decrement: requested } },
    });
    if (result.count === 0) throw new Error('out of stock or unknown sku');

    return tx.order.create({ data: { sku, qty: requested } });
  });
}
```

For single-row inventory updates this is usually the better choice — fewer round trips, no explicit lock, the database does the right thing. Reach for `FOR UPDATE` when you need to read multiple fields, do non-trivial computation on them, then write — the pessimistic shape lets you split the read and write phases without losing atomicity.

### (b) Job queue with `SKIP LOCKED`

N worker processes drain a `job` table. Every worker calls `claimJob()` in a loop; each call should return a distinct row or `null` if the queue is empty.

```ts
const Job = model('job', {
  id:           f.id(),
  status:       f.enum(['pending', 'claimed', 'done', 'failed']).default('pending'),
  payload:      f.json(),
  claimed_by:   f.string().nullable(),
  claimed_at:   f.dateTime().nullable(),
  created_at:   f.dateTime().now(),
}, {
  indexes: [
    // Partial index so the pending-scan only touches pending rows.
    { keys: { created_at: 1 }, name: 'idx_job_pending',
      partialFilter: { status: 'pending' } },
  ],
});

async function claimJob(workerId: string): Promise<Job | null> {
  return db.$transaction(async (tx) => {
    // Postgres / MySQL 8.0+.
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM job
      WHERE status = 'pending'
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) return null;

    return tx.job.update({
      where: { id: rows[0].id },
      data:  { status: 'claimed', claimed_by: workerId, claimed_at: new Date() },
    });
  });
}
```

Two workers calling `claimJob` simultaneously see disjoint result sets — worker A's `SELECT` returns the oldest pending row and locks it; worker B's `SELECT` sees A's lock, skips that row, and returns the next one. Neither waits.

For MSSQL the equivalent is `WITH (UPDLOCK, READPAST)`:

```ts
const rows = await tx.$queryRaw<{ id: string }[]>`
  SELECT TOP (1) id FROM job WITH (UPDLOCK, READPAST)
  WHERE status = 'pending' ORDER BY created_at
`;
```

For MySQL 5.7 (no `SKIP LOCKED`), use an `UPDATE … LIMIT 1` and check `affectedRows`:

```ts
const result = await tx.$executeRaw`
  UPDATE job SET status = 'claimed', claimed_by = ${workerId}, claimed_at = NOW()
  WHERE status = 'pending'
  ORDER BY created_at
  LIMIT 1
`;
if (result.count === 0) return null;
// Re-read the row we just claimed.
return tx.job.findFirst({ where: { claimed_by: workerId, status: 'claimed' } });
```

— atomic at the row-lock level the UPDATE takes, but you can't read the claimed row's id in the same statement on 5.7. The re-read is fine because the `claimed_by` predicate uniquely identifies the row.

The job-claimed row needs an "I died holding this" recovery path: a separate sweep query that re-pendings rows where `status = 'claimed' AND claimed_at < NOW() - INTERVAL '5 minutes' AND claimed_by NOT IN (active_workers)`. Without it, a worker crash strands the job in `claimed` state indefinitely.

### (c) Cron singleton with an advisory lock

A cron job runs every minute on every web worker. You want exactly one of them to actually do the work — the rest should no-op. Database advisory locks are perfect for this.

Postgres:

```ts
const SINGLETON_KEY = 0xC0FFEE01;   // any stable int4 / int8 you like

async function nightlyReport() {
  await db.$transaction(async (tx) => {
    const got = await tx.$queryRaw<{ ok: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${SINGLETON_KEY}) AS ok
    `;
    if (!got[0].ok) {
      log.info('nightlyReport: another worker is running it, skipping');
      return;
    }

    // We're the chosen one for this minute.
    await generateReport(tx);
    await emailReport(tx);
  });
  // Lock auto-released at COMMIT.
}

// Cron loop on every worker:
setInterval(() => nightlyReport().catch(err => log.error(err)), 60_000);
```

Every minute, N workers call `nightlyReport`. Exactly one acquires the advisory lock; the rest see `ok: false` and return. The work happens once. There's no leader election protocol to maintain — Postgres is the coordinator.

The tx-scoped lock auto-releases at commit, which means each minute's invocation is independent. The session-scoped variant (`pg_advisory_lock`) would hold the lock across multiple invocations, which is what you want if the lock-holder needs to drive multiple txs as part of "running the job" (release at the end of the job, not the end of each tx) — but you have to release it explicitly and the leak window is wider.

MySQL equivalent uses `GET_LOCK`:

```ts
async function nightlyReport() {
  const got = await db.$queryRaw<{ ok: number | null }[]>`
    SELECT GET_LOCK('nightly_report', 0) AS ok
  `;
  if (got[0].ok !== 1) return;
  try { await generateReport(db); await emailReport(db); }
  finally { await db.$executeRaw`SELECT RELEASE_LOCK('nightly_report')`; }
}
```

— note the `try/finally` because MySQL's lock is session-scoped, not tx-scoped, and the lock stays held on the pool connection if you don't release. If the JS process dies between `GET_LOCK` and `RELEASE_LOCK`, the lock is released when the connection closes — but if the JS process dies and the connection is healthy (because the pool kept it warm), the lock can be stranded. Use a TTL'd `_leases` row instead if that's a real concern.

For SQLite / DuckDB / Mongo, model the singleton with a `_leases` row as shown at [Advisory locks › SQLite, DuckDB, Mongo](#sqlite-duckdb-mongo).

### (d) MSSQL `UPDLOCK` pattern

The MSSQL-flavoured deduct-inventory. The hint vocabulary is `WITH (UPDLOCK, HOLDLOCK, ROWLOCK)` — update lock + held to commit + force row grain.

```ts
async function placeOrder(sku: string, requested: number) {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: number; qty: number }[]>`
      SELECT id, qty FROM inventory WITH (UPDLOCK, HOLDLOCK, ROWLOCK)
      WHERE sku = ${sku}
    `;
    if (rows.length === 0) throw new Error('unknown sku');
    if (rows[0].qty < requested) throw new Error('out of stock');

    await tx.inventory.update({
      where: { sku }, data: { qty: { decrement: requested } },
    });
    return tx.order.create({ data: { sku, qty: requested } });
  });
}
```

The three-hint combination:

* `UPDLOCK` — pre-mark the row as "I intend to update it." Update locks are exclusive against other update / exclusive locks but compatible with already-taken shared locks, so they don't immediately escalate a read-mostly workload.
* `HOLDLOCK` — hold the lock until commit. Without it, shared/update locks are released as soon as the read finishes, which loses the atomicity guarantee.
* `ROWLOCK` — force the planner to stay at row grain instead of escalating to page or table. Useful when many concurrent orders are hitting the same SKU range and you'd rather absorb the row-lock overhead than pay the page-lock false-sharing penalty.

For the work-queue dequeue on MSSQL:

```ts
const rows = await tx.$queryRaw<{ id: string }[]>`
  SELECT TOP (1) id FROM job WITH (UPDLOCK, READPAST, ROWLOCK)
  WHERE status = 'pending' ORDER BY created_at
`;
```

— `READPAST` is the `SKIP LOCKED` equivalent; same semantics, same use case. Combine with `UPDLOCK` and `ROWLOCK` for the classic worker-claim pattern.

For the `NOWAIT` flavour, add `SET LOCK_TIMEOUT 0` at the start of the tx (see [`NOWAIT`](#nowait--fail-fast)) — the per-tx setting makes every lock acquisition fail-fast with error 1222.

The error code mapping on MSSQL: 1205 (deadlock victim) → `P2034`; 1222 (lock timeout) bubbles as raw mssql error. Catch and branch as needed.

---

## Cross-references

* [TRANSACTIONS.md](./TRANSACTIONS.md) — the parent doc; `$transaction` mechanics, isolation, deadlock retry, long-tx pitfalls. Read first if you're new to forge transactions.
* [VERSIONING.md](./VERSIONING.md) — optimistic concurrency control with a `version` column; the alternative to pessimistic locking for low-conflict workloads.
* [ERRORS.md](./ERRORS.md) — the `DbKnownError` taxonomy, including `P2034` (deadlock / serialization failure / lock timeout) and the retry-class mapping.
* [MUTATIONS.md](./MUTATIONS.md) — `update`, `updateMany`, `upsert`, conditional-where predicates that underpin the optimistic-locking pattern.
* [POSTGRES.md](./POSTGRES.md) — Postgres-specific config (`lock_timeout`, `idle_in_transaction_session_timeout`), `pg_locks` monitoring, isolation levels.
* [MYSQL.md](./MYSQL.md) — InnoDB lock model, gap locks under `REPEATABLE READ`, `innodb_lock_wait_timeout`, deadlock log configuration.
* [MSSQL.md](./MSSQL.md) — table hints (`UPDLOCK`, `HOLDLOCK`, `ROWLOCK`, `READPAST`, `TABLOCKX`), `sp_getapplock` advisory locks, lock escalation thresholds.
* [INDEXES.md](./INDEXES.md) — partial-filter indexes for the `WHERE status = 'pending'` work-queue pattern; covering indexes that let `FOR UPDATE` lock fewer rows.
* [EVENTS.md](./EVENTS.md) — the `query` event stream that correlates with lock waits (slow `UPDATE` durations under contention).
* [RAW-SQL.md](./RAW-SQL.md) — the `$queryRaw` / `$executeRaw` API every example here uses to issue dialect-specific locking statements.
