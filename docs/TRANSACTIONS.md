# Transactions deep-dive — `$transaction`, savepoints, isolation, deadlock retry, distributed footguns

The [Transactions chapter](../README.md#transactions) in the README is the
tour: callback in, callback out, throw to roll back. This doc is the
companion reference for everything sitting behind that 20-line section —
the callback form vs. the array form, how a transaction reaches code
that never sees `tx`, how each adapter actually drives `BEGIN` /
`COMMIT` / `ROLLBACK`, why nested `$transaction` calls don't emit
`SAVEPOINT` the way you might assume, the isolation level you're
implicitly getting per dialect, deadlock-and-retry patterns, the
long-tx toxicity story, why Mongo needs a replica set, and the
distributed-tx footguns forge does not solve.

Everything below assumes **2.19.0**, which changed two things this page
used to document the other way round: the callback form now reaches a
repository layer on its own, and the array form takes **thunks** and is
atomic. The relevant implementation files are `src/factory.ts` (the
`$transaction` entrypoint, `runBatch`, and the per-tx proxy that hands
`session` to every wrapper call), `src/session-context.ts` (the ambient
session), and `src/adapters/<dialect>/adapter.ts` plus the per-driver
`transaction(fn)` implementations in
`src/adapters/<dialect>/driver.ts` / `src/adapters/mongo/client.ts`.

## Contents

* [Callback form](#callback-form)
* [The ambient session — how a transaction reaches a repository](#the-ambient-session--how-a-transaction-reaches-a-repository)
* [Array form](#array-form)
* [Per-dialect tx semantics](#per-dialect-tx-semantics)
* [Savepoints and nested `$transaction`](#savepoints-and-nested-transaction)
* [Isolation levels](#isolation-levels)
* [Deadlock and serialization-failure retry](#deadlock-and-serialization-failure-retry)
* [Long-running transactions](#long-running-transactions)
* [Mongo replica-set requirement](#mongo-replica-set-requirement)
* [Cross-database transactions](#cross-database-transactions)
* [Transactions in HTTP and job contexts](#transactions-in-http-and-job-contexts)
* [Connection lifecycle](#connection-lifecycle)
* [Read-only transactions](#read-only-transactions)
* [Testing patterns](#testing-patterns)
* [Common bugs](#common-bugs)
* [Five worked patterns](#five-worked-patterns)

---

## Callback form

The shape you'll use 95% of the time:

```ts
const result = await db.$transaction(async (tx) => {
  const user = await tx.user.create({ data: { email: 'a@x.co', name: 'A' } });
  await tx.post.create({ data: { author_id: user.id, title: 'Hi' } });
  return user;
});
```

Three things to know about the callback.

**The `tx` argument is a per-tx proxy, not a new database handle.** It's
built by `makeTx(session)` in `src/factory.ts`. Every model wrapper you
read off it (`tx.user`, `tx.post`) is a `CollectionWrapper` bound to the
same adapter as `db.user` but carrying an opaque `session` that the
adapter injects into every `execute` / `coerce` / `decode` call. The
proxy also exposes `tx.$queryRaw`, `tx.$executeRaw`,
`tx.$runCommandRaw` (Mongo only), `tx.$on`, `tx.$off`, and a nested
`tx.$transaction` that joins the transaction already open rather than
starting a second one (see
[Savepoints](#savepoints-and-nested-transaction) below).

**The session is opaque on purpose.** What `session` actually is depends
on the dialect:

| Dialect    | Session value                                                                          |
| ---------- | -------------------------------------------------------------------------------------- |
| Postgres   | `PgQueryable` — `{ query(text, params) }` bound to a checked-out `PoolClient`          |
| MySQL      | `MysqlQueryable` — same shape, bound to a `PoolConnection` from `mysql2`               |
| SQLite     | `SqliteDriver` — the driver handle itself (better-sqlite3 or wasm)                     |
| DuckDB     | `DuckDbQueryable` — `{ query, run }` bound to a connection                              |
| MSSQL      | A `QueryableConnection` carrying the open `mssql` Request and Transaction              |
| Mongo      | `ClientSession` — the value `client.startSession()` returns                            |

You never type-narrow against these. They're only ever passed through to
the adapter via the `opts.session` parameter on `execute` / `$queryRaw` /
`$executeRaw`. If you reach into the session yourself, you've stepped
outside forge's contract and your code stops being portable across
dialects.

**The callback's return value is the transaction's return value.** If
you forget to `return`, the tx still commits — you just lose the value:

```ts
const user = await db.$transaction(async (tx) => {
  return tx.user.create({ data: { email: 'a@x.co', name: 'A' } });
});

// vs. — commits, but `user` is undefined.
const user = await db.$transaction(async (tx) => {
  tx.user.create({ data: { email: 'a@x.co', name: 'A' } });
});
```

Worse: forgetting the `await` (not the `return`) inside the callback
fires the query but the tx commits before it finishes — see
[Common bugs](#common-bugs).

**Anything awaited beneath the callback is in the transaction too**,
including code that never sees `tx` and calls the root `db`. That is the
ambient session, new in 2.19.0 — the next section. Before it, a callback
that handed the work to a repository layer ran that work outside the
transaction, and a throw rolled back nothing.

**Throwing rolls back.** Any unhandled rejection inside the callback
triggers `ROLLBACK` (or `abortTransaction()` on Mongo) and the rejection
bubbles to your caller. Forge does not swallow tx errors and never
attempts implicit retries — see
[Deadlock retry](#deadlock-and-serialization-failure-retry) for the
pattern you have to write yourself.

---

## The ambient session — how a transaction reaches a repository

Until 2.19.0 the `tx` handle was the only way into the transaction, and
that made the most common shape in a layered codebase a lie:

```ts
await db.$transaction(async () => {           // tx discarded
  await stockRepo.record(orgId, movement);    // the ambient db — no session
  await itemRepo.incrementStock(orgId, sku);  // ditto
});
```

`stockRepo` closes over the root `db`, not over `tx`. Neither leg
carried the session, so neither leg was in the transaction: both writes
went out on their own connection as they were issued, and the throw at
the end rolled back nothing. The code read as atomic and was not, with
no error and no log line. The only fix available was to thread `tx`
through every function between the route and the query.

The session now lives in an `AsyncLocalStorage`
(`src/session-context.ts`). `$transaction` opens the driver session
exactly as before, then runs the callback inside
`runWithSession(adapter, session, …)`. A collection wrapper with no
session of its own falls back to the ambient one, so anything awaited
beneath the callback joins the transaction without knowing it exists —
async context propagates across `await`, which is what puts a
repository three layers down inside the same `BEGIN`.

The snippet above is atomic as written. So is the same work expressed as
thunks in the [array form](#array-form), and so is a nested
`$transaction`.

### The rules, precisely

**Per adapter.** The stored scope carries the adapter that opened the
session, identity-compared, and `currentSession(otherAdapter)` returns
nothing. A session belongs to the connection that created it — hand a
Mongo `ClientSession` to a different client and the driver rejects it —
so in a process with two `createDb()` handles, one database's
transaction is never picked up by the other's queries.

**Resolved per call, not per wrapper.** The wrapper's `session` is a
getter read at dispatch time. A repository built at boot, long before
any transaction existed, still joins whichever transaction is open when
it is called.

**An explicit session still wins.** `tx.user` carries its own session
and ignores the ambient one. Inside a callback on Node, `tx.user` and
`db.user` therefore reach the same transaction — which is the point, but
see [Common bugs](#common-bugs) for the two cases where they still
differ.

**The scope ends with the callback.** Work started after `$transaction`
resolves, and sibling work outside it, sees no ambient session. It is a
scope, not a global flag.

**Node only, deliberately.** `node:async_hooks` is loaded through a
specifier assembled at runtime, because a bundler resolves a literal
`require('node:async_hooks')` at build time even inside a `try` — and
that is a broken browser build, which matters because forge runs in the
browser on sqlite-wasm and IndexedDB. Where there is no async context
there is no ambient session, and that is the right answer rather than a
degradation: IndexedDB's `$transaction` has no interactive transaction
to join in the first place (it runs the callback with no session at all
and each operation opens its own IDB txn), so in the browser `db.x`
inside a callback is exactly as un-transactional as it always was, and
`tx.x` is what you write.

### The three exported helpers

```ts
import { ambientSessionsSupported, currentSession, runWithSession } from 'forge-orm';
```

| Helper | What it is for |
| --- | --- |
| `ambientSessionsSupported()` | `true` where async context exists — Node yes, browser no. Lets a startup check or a test assert that propagation is available instead of finding out from a rollback that did nothing. |
| `currentSession(adapter)` | The session the current call is already inside for that adapter, or `undefined`. `currentSession(db.adapter) !== undefined` is the honest answer to "am I inside a transaction?" |
| `runWithSession(adapter, session, fn)` | Runs `fn` with `session` ambient. This is the primitive `$transaction` itself uses; you need it directly only if you drive a driver session by hand. |

### There is deliberately no `withoutAmbientSession()`

The obvious companion — "run this one write outside the enclosing
transaction, so the audit row survives the rollback" — is missing on
purpose.

Detaching the session only helps on a driver that hands out a separate
connection per transaction. On SQLite, PGlite and DuckDB the
transaction **is** the single connection the process has, so a statement
issued without the session is still physically inside the open `BEGIN`
and rolls back with it. That was measured on PGlite while this was being
built: the row written with the session detached was gone after the
rollback.

An API that works on Postgres and silently does not on SQLite is the
class of difference this library exists to remove, so it is not
offered. The escape hatch is a second `createDb()` — a second
connection, genuinely outside:

```ts
// One extra handle, its own pool, its own $disconnect().
const sideChannel = await createDb({ url: process.env.DATABASE_URL!, schema });

await db.$transaction(async () => {
  await orders.place(input);                            // rolls back on throw
  await sideChannel.attempt.create({ data: { … } });    // survives it
});
```

Two handles in one process share the module-level active schema, so
register the same schema in both — see
[Cross-database transactions](#cross-database-transactions).

---

## Array form

The second call shape is an array, and as of 2.19.0 it holds
**functions**, not promises:

```ts
await db.$transaction([
  () => db.account.update({ where: { id: from }, data: { bal: { decrement: n } } }),
  () => db.account.update({ where: { id: to },   data: { bal: { increment: n } } }),
]);
```

They run **in order, inside one real transaction**: one `BEGIN`, one
connection, one `COMMIT`, and a throw from any of them rolls the
earlier ones back. Note that the thunks call the plain `db` and are
still inside the transaction — that is the
[ambient session](#the-ambient-session--how-a-transaction-reaches-a-repository)
at work, which also means a thunk may call a repository function that
knows nothing about transactions. Each thunk is passed the `tx` handle
as its argument as well, for code that prefers to be explicit:

```ts
await db.$transaction([
  (tx) => tx.account.update({ where: { id: from }, data: { bal: { decrement: n } } }),
  (tx) => tx.ledger.create({ data: { from, to, amount: n } }),
]);
```

The results come back as an array, in the order the thunks were listed,
each typed as its own thunk's resolved value — so `r[0].balance`
typechecks. An empty array opens no transaction at all and resolves to
`[]`.

**Sequential, not concurrent.** The thunks are awaited one at a time
rather than through `Promise.all`. A Mongo `ClientSession` rejects
overlapping operations, and a single PG / MySQL / MSSQL client
serialises statements anyway, so running them concurrently would buy
nothing and break Mongo.

### Behaviour change: an array of promises is refused

This is the break. Before 2.19.0 the array form was one line —
`Promise.all(arg)` — and it gave no atomicity at all, which is not an
oversight so much as the only thing that shape *can* do. By the time
the array reaches `$transaction`, every element is an already-running
promise: `db.account.update(...)` dispatched the moment it was
evaluated, while the array literal was being constructed. `Promise.all`
then waits for writes that have already happened, independently, each
on its own connection, in no transaction. A money transfer written that
way lost atomicity silently — the worst way to lose it.

So the promise form now throws instead of pretending:

```
[forge] $transaction([...]) takes functions, not promises — 2 of 2 items were already running.
  A query starts the moment you write it, so by the time the array gets here the
  writes have already gone to the database, each on its own. Nothing can wrap them
  afterwards — this used to be a Promise.all, which looked atomic and was not.
  Wrap each one in an arrow:
    await db.$transaction([
      () => db.a.create({ ... }),
      () => db.b.update({ ... }),
    ]);
  Or use the callback form, which is equivalent:
    await db.$transaction(async () => { ... });
```

The error counts the offending items, and a mix of thunks and promises
is refused too. Note what the refusal cannot do: the promises had
already started, so their writes may well have landed before the error
was thrown. The exception tells you the code shape is wrong; it does
not undo anything. Upgrading means finding every
`$transaction([ ... ])` call site and adding `() =>` — and every one you
find was not atomic before.

**Upgrading a fan-out read.** The old array form was also used, quite
reasonably, to run independent reads together:

```ts
// Before — a Promise.all in disguise.
const [users, postCount] = await db.$transaction([
  db.user.findMany({ take: 10 }),
  db.post.count(),
]);
```

If you wanted parallelism and not atomicity, `Promise.all` is what that
code always was, so say so:

```ts
const [users, postCount] = await Promise.all([
  db.user.findMany({ take: 10 }),
  db.post.count(),
]);
```

If you wanted both reads on one session inside one transaction, thunks
give you that — sequentially:

```ts
const [users, postCount] = await db.$transaction([
  () => db.user.findMany({ take: 10 }),
  () => db.post.count(),
]);
```

Note that "one transaction" is not by itself "one snapshot": under
Postgres's default READ COMMITTED each statement takes a fresh snapshot,
so a concurrent commit between the two reads is visible to the second.
If the two reads have to agree, raise the isolation level — see
[Isolation levels](#isolation-levels).

### Nesting joins, it does not stack

A `$transaction` called while one is already open — the array form or
the callback form, on `tx` or on the ambient `db` — **joins** the open
transaction instead of starting a second:

```ts
await db.$transaction(async () => {
  await debit(from, n);
  // A repository being defensive: it opens a transaction of its own,
  // from the ambient db, not knowing it is already inside one.
  await db.$transaction(async () => { await credit(to, n); });
  throw new Error('boom');           // rolls BOTH legs back
});
```

This is the common case rather than an exotic one, precisely because a
repository holds `db` and not `tx`. It also has to be the behaviour:
Postgres and Mongo both refuse a nested `BEGIN`, and on a driver that
allows one, the inner commit would publish half of the outer
transaction's work. What it does **not** give you is a savepoint — the
inner block cannot fail and be recovered from independently. See
[Savepoints](#savepoints-and-nested-transaction).

---

## Per-dialect tx semantics

What forge actually emits, dialect by dialect. References are to
`src/adapters/<dialect>/adapter.ts` / `driver.ts` /
`src/adapters/mongo/client.ts`.

### Postgres

`pgDriver.transaction(fn)` checks a client out of the pool, runs
`BEGIN`, calls `fn` with a `PgQueryable` bound to that client,
`COMMIT`s on success or `ROLLBACK`s on throw, and always releases the
client in `finally`. The `postgres.js` driver path delegates to
`sql.begin(fn)` which has the same shape but is implemented by the
porsager library.

Default isolation: **READ COMMITTED**. That's PG's server default and
forge does not override it. To get something stricter, run a
`SET TRANSACTION` as the first statement (see
[Isolation levels](#isolation-levels)).

The "one thing to watch on Postgres" warning in the README is worth
repeating: PG marks the whole tx as failed after any statement error
and the next statement gets `current transaction is aborted, commands
ignored until end of transaction block`. Forge rolls back cleanly and
reports the original error — but catch-and-continue doesn't work. Use
`upsert`, branch before the failing call, or let the tx blow up and
retry it.

### MySQL

`mysql2`'s pool. `mysqlDriver.transaction(fn)` calls
`conn.beginTransaction()`, runs the callback against a `MysqlQueryable`
bound to that `PoolConnection`, commits or rolls back, and releases.

Default isolation: **REPEATABLE READ** (InnoDB's default). InnoDB also
uses next-key locking, so range reads inside a tx lock the gaps — useful
for preventing phantoms, painful when you weren't expecting it. If you
see `ER_LOCK_DEADLOCK` (code 1213) more often after a refactor, it's
usually a gap-locking story. Mapped to `P2034` by forge — see
[Deadlock retry](#deadlock-and-serialization-failure-retry).

MyISAM tables have no tx support. Forge always emits InnoDB (`ENGINE =
InnoDB`) on `forge push`, so the trap only matters if you're sharing a
schema with a legacy app.

### SQLite

`sqliteAdapter.$transaction` is the simplest path — three lines:

```ts
await this.db.exec('BEGIN');
try { ...; await this.db.exec('COMMIT'); }
catch (e) { await this.db.exec('ROLLBACK'); throw e; }
```

The `session` is the driver itself. There's no pool — SQLite has a
single writer.

**What that means for isolation, precisely.** Sequential work inside the
callback is genuinely atomic: `BEGIN`, the statements, `COMMIT` or
`ROLLBACK`, all on the one connection. What the shared connection cannot
give you is isolation from work happening *outside* the callback at the
same time. A write issued concurrently — another request, a timer, an
unawaited promise — goes down the same connection, lands inside the open
`BEGIN`, and rolls back with it if the transaction fails, even though it
was never part of it. Two overlapping `$transaction` calls collide for
the same reason: the second `BEGIN` arrives while the first is open. So
treat a SQLite transaction as correct but not concurrent-safe, and keep
one writer at a time. The same is true of DuckDB and of PGlite, which
are also one connection per process.

This is also why forge's transaction regression suite
(`regression-transactions.ts`) runs on **PGlite** and not on SQLite. A
rollback test on SQLite passes whether or not the session was
propagated, because the transaction is the process's only connection —
a query issued without the session is physically inside it anyway. Only
a dialect with a real per-transaction connection can tell a propagated
session from a shared one, so a new transaction test belongs there. See
[Testing patterns](#testing-patterns).

**Important: forge uses plain `BEGIN`, not `BEGIN IMMEDIATE`.** Plain
`BEGIN` is a deferred tx — SQLite stays in read mode until the first
write, then promotes to a reserved lock. If two concurrent writers race
that promotion you get `SQLITE_BUSY`. For a write-heavy workload you
want `BEGIN IMMEDIATE` (acquires the reserved lock up front). Emit it
yourself before any tx body if you need it:

```ts
await db.$transaction(async (tx) => {
  await tx.$executeRaw`BEGIN IMMEDIATE`;   // upgrades the outer BEGIN
  // ...writes...
});
```

This is a no-op SQLite tolerates inside an existing tx and the lock
upgrade happens. WAL mode (forge sets `PRAGMA journal_mode = WAL` by
default — see [DRIVERS.md](./DRIVERS.md)) makes readers never block
writers and vice versa, which is usually enough.

### DuckDB

`duckdbDriver.transaction(fn)` issues `BEGIN TRANSACTION`, runs the
callback against a `DuckDbQueryable` bound to the connection, commits
or rolls back. DuckDB serialises writes per-process — there's only ever
one writer at a time — so deadlocks don't exist but contention shows up
as wait time, not retry errors.

The connection is the process's one connection, so the SQLite caveat
above applies verbatim: sequential work in the callback is atomic, and
concurrent work outside it joins the same `BEGIN` and rolls back with
it.

DuckDB has **no `SAVEPOINT` support**. See
[Savepoints](#savepoints-and-nested-transaction) for what that means
for nested `$transaction`.

### MSSQL

`mssqlDriver.transaction(fn)` opens an `mssql.Transaction`, calls
`begin()`, runs the callback against a `QueryableConnection`, commits
or rolls back. Default isolation: **READ COMMITTED** (server default),
*not* SERIALIZABLE despite what older Microsoft docs hint at — the
`Transaction` class doesn't override the connection setting.

MSSQL distinguishes between locks taken implicitly by the planner
(row / page / table escalation) and explicit hints (`WITH (UPDLOCK,
HOLDLOCK)`). Forge does not emit hints. If you need them, drop to
`tx.$executeRaw` for the locking statement.

### Mongo

`DatabaseClient.transaction(fn)`, on the client this adapter owns —
since 2.19.0 that is one client per `createDb()` rather than one per
process, so a transaction is scoped to the database its handle is
connected to. See [MONGO.md](./MONGO.md#one-client-per-createdb).

```ts
const session = this.client.startSession();
try {
  await session.withTransaction(async () => {
    result = await fn(session);
  });
  return result;
} finally {
  await session.endSession();
}
```

`session.withTransaction()` is the Mongo driver's built-in retry loop —
it automatically retries on `TransientTransactionError` (the
client-side label for "the server told us to retry") and on
`UnknownTransactionCommitResult` after a commit timeout. You get retry
for free on Mongo; you have to write it yourself on the SQL adapters.

Requires a replica set or a `mongos`. See
[Mongo replica-set requirement](#mongo-replica-set-requirement).

### IndexedDB

`indexeddbAdapter.$transaction(fn)` calls `fn(undefined)` — there is no
session, and each operation underneath opens its own short-lived IDB
transaction.

That is a limitation of the platform, not a gap in the adapter. An
`IDBTransaction` auto-commits as soon as the microtask queue goes idle,
so it cannot survive an `await` on anything that is not an IDB request —
which is to say an interactive transaction, the thing `$transaction`
exposes everywhere else, is not expressible in IndexedDB. Per-operation
transactions are the strongest atomicity available, and forge does not
pretend otherwise: a throw stops later writes from being issued, but
earlier ones are already committed.

It is also why the absence of an ambient session in the browser costs
nothing. There is no open transaction to join, so there is nothing for
async context to carry. If you need all-or-nothing across several
IndexedDB writes, model it as one document, or write a compensating
undo.

See [INDEXEDDB.md](./INDEXEDDB.md#transactions) for the per-op detail.

### The summary table

| Dialect  | What forge does on `$transaction`                                  | Default isolation     | Built-in retry?                   |
| -------- | ------------------------------------------------------------------ | --------------------- | --------------------------------- |
| Postgres | Check out client, `BEGIN`, run, `COMMIT` / `ROLLBACK`, release     | READ COMMITTED        | No                                |
| MySQL    | `pool.getConnection`, `beginTransaction`, run, commit / rollback   | REPEATABLE READ       | No                                |
| SQLite   | `BEGIN`, run, `COMMIT` / `ROLLBACK` on the single driver           | SERIALIZABLE (de facto, single writer) | No              |
| DuckDB   | `BEGIN TRANSACTION`, run, commit / rollback                        | SERIALIZABLE (single writer)           | No              |
| MSSQL    | `mssql.Transaction.begin()`, run, commit / rollback                | READ COMMITTED        | No                                |
| Mongo    | `startSession` → `withTransaction(fn)` → `endSession`              | snapshot (4.2+)       | Yes — driver retries transient    |
| IndexedDB| Nothing — the callback runs with no session; each op gets its own IDB txn | per operation   | No                                |

---

## Savepoints and nested `$transaction`

What you'd expect: calling `$transaction(...)` inside a callback opens
a `SAVEPOINT`, with `ROLLBACK TO SAVEPOINT` if the inner one throws.
What forge actually does is **join** the open transaction — on `tx`,
and (since 2.19.0) on the ambient `db` as well, which is the shape a
defensive repository produces. The inner callback gets a `tx` proxy
bound to the *same* session. There's no `SAVEPOINT`. There's no
`RELEASE`. Any throw from the inner block aborts the outer transaction
once it propagates and the outer `try`/`catch` triggers `ROLLBACK`.

Joining is the only safe answer: Postgres and Mongo both refuse a nested
`BEGIN`, and on a driver that permits one the inner `COMMIT` would
publish half the outer transaction's work.

The practical consequences:

* **You cannot partially recover** from an inner failure. If the inner
  block throws, the whole outer tx rolls back. There's no
  "try-this-step-and-keep-going-if-it-fails" with a nested
  `$transaction`.
* The README's note that "DuckDB doesn't support `SAVEPOINT`, so nested
  transactions degrade to a single outer one" is half the story.
  Nested `$transaction` is *always* a single outer one on every
  dialect. DuckDB is just where you can't fix it even if you wanted to.
* If you genuinely need savepoint semantics on the SQL adapters that
  support them (Postgres, MySQL, SQLite, MSSQL — all four do), emit
  them yourself with raw SQL:

```ts
await db.$transaction(async (tx) => {
  await tx.user.create({ data: { email: 'a@x.co', name: 'A' } });

  // Optional step we're willing to skip on failure.
  await tx.$executeRaw`SAVEPOINT sp_promo`;
  try {
    await tx.promo.create({ data: { user_id: ..., code: 'WELCOME' } });
    await tx.$executeRaw`RELEASE SAVEPOINT sp_promo`;
  } catch (err) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT sp_promo`;
    log.warn('promo failed; user creation kept', err);
  }
});
```

This is exactly the pattern `src/adapters/postgres/migrate.ts` uses
internally to keep going past a failed migration step. DuckDB,
SQLite-without-savepoint builds, and the Mongo adapter all reject
`SAVEPOINT` raw and the outer tx blows up — Postgres / MySQL / MSSQL /
default SQLite all accept it. Test on your target before you ship it.

---

## Isolation levels

Forge does not type-expose isolation. The defaults you get per dialect
are in the [summary table](#the-summary-table) above. To override,
issue the right `SET TRANSACTION` (or per-tx hint) before any data
statement in the callback:

```ts
await db.$transaction(async (tx) => {
  await tx.$executeRaw`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`;   // PG / MySQL
  // ...
});
```

| Dialect  | Raw to issue                                                                | Notes                                                              |
| -------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Postgres | `SET TRANSACTION ISOLATION LEVEL { READ COMMITTED \| REPEATABLE READ \| SERIALIZABLE }` | Must be first statement after `BEGIN`. SERIALIZABLE may raise `40001`. |
| MySQL    | `SET TRANSACTION ISOLATION LEVEL ...` (same four levels)                    | Per-tx only if before any data; session-wide otherwise.            |
| SQLite   | `PRAGMA read_uncommitted = 1` (DIRTY READ only) — no other levels exist     | Defaults to SERIALIZABLE because single-writer.                    |
| DuckDB   | None — only SERIALIZABLE                                                    | No setting required.                                               |
| MSSQL    | `SET TRANSACTION ISOLATION LEVEL { READ UNCOMMITTED \| READ COMMITTED \| REPEATABLE READ \| SNAPSHOT \| SERIALIZABLE }` | `SNAPSHOT` needs `ALLOW_SNAPSHOT_ISOLATION ON` at DB level.        |
| Mongo    | `client.startSession({ defaultTransactionOptions: { readConcern, writeConcern }})` | Forge always uses the client default. Override the client at construction time. |

**When to bump isolation:**

* **READ COMMITTED → REPEATABLE READ** when you read the same row twice
  inside the tx and need both reads to agree. PG default is READ
  COMMITTED; MySQL default is already REPEATABLE READ; MSSQL default
  is READ COMMITTED. The classic example is `SELECT balance` followed
  by `UPDATE SET balance = balance - X` — under READ COMMITTED a
  concurrent writer between the two statements is invisible until the
  `UPDATE` re-reads. Use `WHERE balance >= X` in the `UPDATE` itself
  if you can; bump isolation only if you can't.
* **REPEATABLE READ → SERIALIZABLE** when you need to prevent the
  write-skew anomaly: two txs both read state, both decide the state
  is safe, both write conflicting outcomes. The textbook example is
  "at least one doctor on call." Under SERIALIZABLE one of the two
  txs gets aborted with `40001` and you retry.

PG's SERIALIZABLE is *Serializable Snapshot Isolation* — it doesn't
take more locks than REPEATABLE READ, it watches for conflicts and
aborts losers. Cheap when conflicts are rare; awful when they aren't.

---

## Deadlock and serialization-failure retry

Forge maps the canonical "please retry" SQL states to a single error
code (`src/adapters/postgres/errors.ts`,
`src/adapters/mysql/errors.ts`):

| Server code              | Forge `DbKnownError.code` | Meaning                          |
| ------------------------ | ------------------------- | -------------------------------- |
| PG `40001`               | `P2034`                   | Serialization failure            |
| PG `40P01`               | `P2034`                   | Deadlock                         |
| MySQL `1213`             | `P2034`                   | Deadlock                         |
| MySQL `1205`             | `P2034`                   | Lock wait timeout                |
| MSSQL `1205`             | `P2034`                   | Deadlock victim                  |

`P2034` is the universal "retry the whole transaction" signal. Mongo
handles it transparently via `withTransaction` — no work for you.
SQL adapters do not. The pattern:

```ts
import { DbKnownError } from 'forge-orm';

async function withTxRetry<T>(
  body: (tx: any) => Promise<T>,
  opts: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  const { attempts = 5, baseMs = 25 } = opts;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await db.$transaction(body);
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof DbKnownError && err.code === 'P2034';
      if (!retryable) throw err;

      // Exponential backoff with jitter — 25ms, 50ms, 100ms, 200ms, 400ms ± 50%.
      const ceil = baseMs * 2 ** i;
      const jitter = Math.floor(Math.random() * ceil * 0.5);
      await new Promise(r => setTimeout(r, ceil + jitter));
    }
  }
  throw lastErr;
}

// Use it:
await withTxRetry(async (tx) => {
  const acct = await tx.account.findFirst({ where: { id: acctId } });
  if (!acct || acct.balance < amount) throw new Error('insufficient');
  await tx.account.update({ where: { id: acctId }, data: { balance: { decrement: amount } } });
  await tx.ledger.create({ data: { acct: acctId, amount: -amount } });
});
```

Three rules.

**Bound the attempts.** Five is a reasonable default; ten is a code
smell. If you're seeing > 3 retries on a hot path, the right answer is
usually to redesign the contention (queue the work, partition the key,
denormalise) — not to retry harder.

**Back off with jitter.** Linear backoff causes thundering herds.
Exponential without jitter still herds on the long retries. Add 0–50%
random jitter on top.

**Recreate the tx — don't reuse the callback's `tx`.** The session has
been ROLLBACK'd and released. The whole `db.$transaction(...)` call has
to run again. The pattern above gets this right by re-entering
`db.$transaction` each iteration.

The full worked bank-transfer example is in
[Five worked patterns: bank transfer](#a-bank-transfer).

---

## Long-running transactions

The shortest useful rule: **a transaction that exceeds one second on a
shared database is suspect, and one that exceeds ten seconds is
broken.** Per dialect:

* **Postgres.** Long-running txs hold their `xmin` horizon, which
  blocks `VACUUM` from reclaiming dead tuples elsewhere in the
  database. A 30-minute analytics tx can cause the entire cluster's
  tables to bloat. `pg_stat_activity` will list the tx's
  `xact_start`; `idle in transaction` is the worst variant — the tx is
  open and the client isn't doing anything. Set
  `idle_in_transaction_session_timeout = '60s'` on your role and PG
  will kill those for you.

* **MySQL (InnoDB).** Long-running txs keep undo segments alive,
  inflating the system tablespace, and hold their snapshot indefinitely
  — making subsequent reads slower because they have to skip past
  longer undo chains. `innodb_history_list_length` from
  `SHOW ENGINE INNODB STATUS` tells you how bad it is.

* **SQLite.** A long-running write tx blocks every other writer for
  the duration. Readers proceed in WAL mode but the WAL file grows
  unbounded until commit. Long read txs in WAL mode prevent
  checkpointing.

* **DuckDB.** Single-writer. A long write tx is a global write lock.

* **MSSQL.** Lock escalation kicks in at ~5,000 locks per object,
  escalating row → page → table. A long tx that wants to keep row-level
  locking either explicitly disables escalation per-table or finishes
  before hitting the threshold.

* **Mongo.** `transactionLifetimeLimitSeconds` is 60s by default. The
  server unilaterally kills the tx past that.

The "move work out" pattern: read what you need before the tx, compute
in app, then re-enter the tx for the writes only:

```ts
// Not this.
await db.$transaction(async (tx) => {
  const lines = await tx.invoice.findMany({ where: { ... } });
  const enriched = await someSlowExternalCall(lines);     // tx held for the duration
  for (const line of enriched) await tx.line.update(...);
});

// This.
const lines = await db.invoice.findMany({ where: { ... } });
const enriched = await someSlowExternalCall(lines);
await db.$transaction(async (tx) => {
  for (const line of enriched) await tx.line.update(...);
});
```

The cost is that the read and the writes aren't atomic — you have to
handle the case where state changed between the read and the tx. The
usual answer is optimistic locking: include a version column in the
`where` and check the `count`.

---

## Mongo replica-set requirement

`session.withTransaction()` requires a replica set or a sharded
deployment (`mongos`). A single-node `mongod` started with the default
options will throw `Transaction numbers are only allowed on a replica
set member or mongos` the moment you try to begin one.

Forge surfaces this at adapter construction time —
`src/adapters/mongo/adapter.ts` sets
`transactionsRequireReplicaSet: true` and the doctor reports it. It's
not silent.

The local-dev path is to run `mongod --replSet rs0 --port 27017
--bind_ip localhost` and then `rs.initiate()` in the shell. That's a
one-line config change, not a multi-node setup — a single-node replica
set works.

**Single-document operations are always atomic on Mongo**, regardless
of replica set. `updateOne`, `findOneAndUpdate`, `insertOne`,
`deleteOne` either commit fully or not at all — they don't need a tx.
The reason you'd open a tx is multi-document or multi-collection
atomicity.

**Compatibility footguns** for Mongo-protocol-compatible servers:

* **AWS DocumentDB.** Supports multi-document transactions since 4.0
  but not all operators inside them — the `$lookup` and `$out`
  pipelines are restricted, and the wire protocol differences mean
  some session IDs are rejected. Test the actual statements forge
  emits, don't trust the compatibility matrix.
* **Azure Cosmos DB (Mongo API).** Doesn't support multi-document
  transactions. `withTransaction` will throw at runtime. Use the
  native Cosmos SDK if you need cross-document atomicity on Cosmos.
* **FerretDB.** Transaction support is best-effort and version-gated;
  check the FerretDB release notes for your version.

If you have to target one of these, the safe path is single-document
updates with `$set` / `$inc` / `$push` — they're atomic everywhere and
forge dispatches to them automatically for `update` calls that touch
one document.

---

## Cross-database transactions

**Forge does not do two-phase commit.** There is no XA, no
distributed-tx coordinator, no `prepare` / `commit` handshake between
adapters. Each `db.$transaction(...)` is scoped to exactly one
`createDb` instance.

The two scenarios people ask about:

* **Two forge instances against two databases**
  (`dbA.$transaction(...)` + `dbB.$transaction(...)`). The two txs are
  independent. If the second one fails after the first commits, the
  first is committed and you can't undo it.

  The ambient session does not blur this line, on purpose. The session
  is stored with the adapter that opened it and handed back only for
  that adapter, so `dbB`'s queries inside `dbA.$transaction(...)` run
  outside it. Anything else would mean handing one driver a session
  another driver created, which the driver rejects.

  One thing to watch when you do run two handles in one process: the
  **active schema is module-level**, so relation targets resolve against
  whichever schema was registered last. Register the same schema in both
  handles, or keep the second one to raw statements. On Mongo each
  `createDb()` now owns its own connection (2.19.0 — see
  [MONGO.md](./MONGO.md#one-client-per-createdb)); the schema registry
  is still shared.
* **One forge instance, but writes that should fan out to another
  system** (cache, search index, message queue, third-party API).
  Same story — the external write isn't inside your tx and can succeed
  while the tx rolls back, or vice versa.

The standard fix is the **outbox pattern**: write the cross-system
intent into a local table inside the same tx as the business write,
then process the outbox asynchronously.

```ts
const OutboxEvent = model('outbox_events', {
  id:          f.id(),
  topic:       f.string(),
  payload:     f.json(),
  created_at:  f.dateTime().now(),
  delivered_at: f.dateTime().nullable(),
});

await db.$transaction(async (tx) => {
  const order = await tx.order.create({ data: { ... } });
  await tx.outbox_events.create({
    data: { topic: 'order.created', payload: { id: order.id, total: order.total } },
  });
});

// Separate worker drains the outbox.
setInterval(async () => {
  const pending = await db.outbox_events.findMany({
    where: { delivered_at: null }, take: 100, orderBy: { created_at: 'asc' },
  });
  for (const ev of pending) {
    await externalSystem.publish(ev.topic, ev.payload);
    await db.outbox_events.update({ where: { id: ev.id }, data: { delivered_at: new Date() } });
  }
}, 1000);
```

The outbox row commits with the order. The external publish is
at-least-once (the worker can retry indefinitely until
`delivered_at` is set). Consumers need to be idempotent — `(topic,
id)` is the natural dedupe key. The full worked version is in
[Five worked patterns: outbox](#c-the-outbox).

Don't use the outbox for low-latency synchronous flows (the user is
waiting for the external system's response). Use it when "eventually,
soon" is good enough.

---

## Transactions in HTTP and job contexts

The middleware pattern is "open a transaction for the request, let every
handler and repository underneath it join". Since 2.19.0 that is the
whole of it — the handlers need no parameter and no accessor, because
the [ambient session](#the-ambient-session--how-a-transaction-reaches-a-repository)
is what carries the transaction down the call stack:

```ts
app.use(async (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();   // reads stay auto-commit
  await db.$transaction(async () => {
    await new Promise<void>((resolve, reject) => {
      res.once('finish', resolve);
      res.once('error', reject);
      next();
    });
  });
});

// The handler and everything below it is inside the transaction.
app.post('/orders', async (req, res) => {
  const order = await orderRepo.create(req.body);   // plain `db` inside
  await inventoryRepo.reserve(order);               // plain `db` inside
  res.json(order);
});
```

Background jobs are the same shape without the HTTP coupling:

```ts
worker.process(async (job) => {
  await db.$transaction(async () => {
    await handleJob(job);      // handleJob and its callees use `db`
  });
});
```

Three failure modes to know, and none of them changed:

* **The route forgot to `await`.** Async work that outlives the response
  runs *outside* the transaction — `finish` already fired and the
  transaction already committed. Worse, the ambient scope is gone, so
  that work is not merely late, it is un-transactional. Always `await`
  everything before you respond.
* **A long-running route holds the transaction open.** See
  [Long-running transactions](#long-running-transactions). A 30-second
  handler under this middleware means a 30-second transaction holding a
  pool connection.
* **Streaming responses.** SSE, WebSocket upgrades and chunked
  responses confuse the `finish` event. Either keep streaming routes out
  of this middleware, or finish the transaction before the first chunk.

### You no longer need a `txStore` / `scoped()` pair

Earlier revisions of this page, and the framework recipes in
[BACKEND.md](./BACKEND.md#production-server-recipes), told you to build
your own `AsyncLocalStorage` and give every repository a `scoped()`
accessor:

```ts
// No longer necessary — forge does this internally, per adapter.
export const txStore = new AsyncLocalStorage<ForgeDb<any>>();
export const scoped = () => txStore.getStore() ?? db;
```

That was the only way to get a transaction into a repository that did
not take `tx` as an argument, and it worked. It is now redundant: forge
keeps the session in its own `AsyncLocalStorage`, keyed by adapter, and
a wrapper with no session of its own picks it up.

If you already have the pattern, it keeps working — `txStore.run(tx, …)`
stores a `tx` handle whose wrappers carry an explicit session, and an
explicit session wins over the ambient one. There is no conflict and
nothing to migrate in a hurry. What you can now delete is the
`scoped()` indirection in every repository, along with the ESLint rule
that policed it.

Two reasons to keep a store of your own anyway: you are on the browser
adapters, where there is no async context and so no ambient session
(`ambientSessionsSupported()` returns `false`); or the thing you want
request-scoped is not the transaction but the *tenant* or the *shard*,
which forge knows nothing about — see
[MULTI-TENANT.md](./MULTI-TENANT.md#asynclocalstorage-middleware) and
[SHARDING.md](./SHARDING.md#routing-pattern--asynclocalstorage-and-the-request-scope).

---

## Connection lifecycle

When does forge actually release the connection back to the pool?
Answer per dialect:

| Dialect    | Connection acquired at         | Released at                                  |
| ---------- | ------------------------------ | -------------------------------------------- |
| Postgres   | `pool.connect()` at `BEGIN`    | `client.release()` in the driver's `finally` |
| MySQL      | `pool.getConnection()` at start | `conn.release()` in the driver's `finally`   |
| SQLite     | n/a — single driver handle     | n/a                                          |
| DuckDB     | Connection acquired at start   | Returned after commit / rollback             |
| MSSQL      | Acquired at `Transaction.begin()` | Released after commit / rollback           |
| Mongo      | `client.startSession()`        | `session.endSession()` in `finally`          |

The release happens after your callback returns and after `COMMIT` /
`ROLLBACK` finishes — never before. **This is the source of the
single worst transaction anti-pattern:**

```ts
// Holds a pool connection for the duration of the external call.
await db.$transaction(async (tx) => {
  const user = await tx.user.findFirst({ where: { id } });
  const fraud = await fraudService.check(user);   // 800ms HTTP call
  if (!fraud.ok) throw new Error('blocked');
  await tx.user.update({ where: { id }, data: { ... } });
});
```

Under load, every concurrent request like this takes a connection out
of the pool for the full external call duration. A 20-connection pool
caps you at 25 transfers/second per worker if the external call is
800ms. Restructure to do the external call before or after the tx:

```ts
const user = await db.user.findFirst({ where: { id } });
const fraud = await fraudService.check(user);
if (!fraud.ok) throw new Error('blocked');
await db.$transaction(async (tx) => {
  // Re-read inside the tx if you need to reject on stale state.
  await tx.user.update({ where: { id }, data: { ... } });
});
```

If you must read-then-call-then-write atomically (you genuinely cannot
tolerate the user's state changing in between), use optimistic
locking: include `version` in the update's `where`, throw if the
update affected zero rows.

---

## Read-only transactions

Read-only mode is a Postgres-specific win and a safety rail
everywhere else. The form:

```ts
await db.$transaction(async (tx) => {
  await tx.$executeRaw`SET TRANSACTION READ ONLY`;
  const rows = await tx.user.findMany({ ... });
  // ...
});
```

Per dialect:

* **Postgres.** `READ ONLY` tells the planner it can skip several
  setup steps; in PG 13+ on a streaming replica it routes the tx to
  the replica if the route is hot-standby. Even on the primary it
  blocks any accidental write inside the tx — calling
  `tx.user.create(...)` raises `cannot execute INSERT in a read-only
  transaction`. Useful as a safety rail in services where the same
  function is sometimes called inside a write tx and sometimes inside
  a read-only one.
* **MySQL.** `START TRANSACTION READ ONLY` (forge runs plain
  `START TRANSACTION` so you have to override) opens a tx that the
  optimizer can run with fewer locking semantics. Modest perf win.
* **MSSQL.** `SET TRANSACTION ISOLATION LEVEL SNAPSHOT` + start the
  tx is the equivalent — there's no `READ ONLY` keyword.
* **SQLite / DuckDB.** No effect; the engine doesn't distinguish.
* **Mongo.** `session.withTransaction({ readPreference: 'secondary',
  readConcern: 'majority' })` is the equivalent. Open it via the
  driver's session options, not via forge's tx callback.

If you read once and you're not nesting, skip the tx entirely. Forge
auto-commits reads outside a tx, which is what you want for
single-statement reads.

---

## Testing patterns

The fastest test isolation strategy is "every test runs inside a tx
that's rolled back in `afterEach`." Forge supports this naturally
because `tx` is the entire surface area:

```ts
import { afterEach, beforeAll, beforeEach } from 'vitest';

let db: ForgeDb<typeof schema>;
let tx: ForgeDb<typeof schema>;
let rollback: () => void;

beforeAll(async () => {
  db = await createDb({ url: process.env.TEST_DATABASE_URL!, schema });
  await db.$migrate();   // sqlite; use forge push for the rest in setup
});

beforeEach(async () => {
  // Open a tx that we'll forcibly roll back at the end of the test.
  await new Promise<void>((resolve) => {
    db.$transaction(async (txObj) => {
      tx = txObj;
      resolve();
      await new Promise<void>((_, reject) => {
        rollback = () => reject(new Error('test rollback'));
      });
    }).catch(() => {});
  });
});

afterEach(() => rollback());
```

Tests then take `tx` instead of `db` — and they have to, even on
2.19.0. The ambient session covers work awaited *beneath* the callback;
this pattern deliberately escapes the callback (that is what the
`resolve()` is for) so the test body runs in the async context that
awaited it, outside the scope. A test body that reaches for `db` is
therefore outside the transaction and its rows survive the rollback.
Hand `tx` down, or open the transaction around the test body rather than
around the fixture.

Every test then sees a clean schema, and the suite finishes orders of
magnitude faster than truncate-between-tests.

Two caveats.

**Deferred / cross-tx constraints don't fire.** Postgres `DEFERRABLE
INITIALLY DEFERRED` constraints are only validated at commit, which
never happens. Either don't use deferred constraints (they're rare),
or have a small parallel suite that doesn't use the tx-rollback pattern.

**Triggers that read `pg_xact_committed`, replication slots,
materialised view refresh.** Anything that observes the actual committed
state of the database from outside the tx will see nothing. Run those
tests in a separate suite that commits.

### If you are adding a transaction test to forge itself

Use PGlite. `regression-transactions.ts` (in `forge:check` and in CI) is
in-process, so it needs no service container, and it is the only
available dialect that can actually *prove* session propagation: on
SQLite the transaction is the process's one connection, so a query
issued without the session is inside the transaction regardless and the
test passes either way. A propagation bug is invisible there. PGlite
hands out a real per-transaction connection, so a query that missed the
session goes to a different one and the assertion fails.

For Mongo, the same pattern works with `withTransaction` aborted —
but Mongo's `withTransaction` automatically retries on transient
errors, so a "forcibly throw to roll back" pattern can cause the
driver to retry the test body. Use the lower-level
`session.startTransaction()` / `session.abortTransaction()` directly:

```ts
const session = db.adapter.mongoClient.startSession();
session.startTransaction();
try {
  await testBody(session);
} finally {
  await session.abortTransaction();
  await session.endSession();
}
```

---

## Common bugs

The four bugs that come up over and over.

**Using `db` instead of `tx` inside the callback — fixed on Node, still
a bug in two places.** This used to be the first entry on this list: the
write ran, it was not in the transaction, and a rollback left it behind.
On Node it now joins the transaction through the
[ambient session](#the-ambient-session--how-a-transaction-reaches-a-repository),
which is what makes an untouched repository layer atomic.

```ts
await db.$transaction(async (tx) => {
  await tx.user.create({ data: ... });   // in the tx
  await db.post.create({ data: ... });   // also in the tx, on Node, since 2.19.0
});
```

Two cases where `db` is still outside it:

* **In the browser** (sqlite-wasm, IndexedDB) there is no async context,
  so there is no ambient session and the second line commits on its own.
  `ambientSessionsSupported()` tells you which world you are in.
* **A different `createDb()` handle.** The session is stored with its
  adapter and returned only for that adapter, so `dbB.post.create(...)`
  inside `dbA.$transaction(...)` is not in the transaction and cannot
  be — see [Cross-database transactions](#cross-database-transactions).
  That is deliberate: a driver rejects a session it did not create.

**Forgetting `await` inside the callback.** The callback returns and
the tx commits before the fire-and-forgotten promise resolves.

```ts
await db.$transaction(async (tx) => {
  tx.user.create({ data: ... });        // missing await
});
// commit fires; the unawaited create may or may not have hit the DB yet,
// and if it errors after commit the error is unhandled.
```

This is a generic JS bug, but it's especially painful in a tx
because (a) the error bubbles up *after* commit, which makes the trace
useless, and (b) the write happens against the released-back-to-pool
connection which can confuse the driver.

**Returning the wrong thing.** `$transaction` returns whatever the
callback returns. Forgetting `return` doesn't break the tx — it just
gives you `undefined`:

```ts
const user = await db.$transaction(async (tx) => {
  tx.user.create({ ... });   // no await, no return — user === undefined
});
```

**Running on single-node Mongo and not noticing.** A `mongod` started
without `--replSet` throws on `$transaction` — but if your test setup
silently skips the tx (e.g. uses `db.user.create` directly because
"we don't need a tx in tests"), production becomes the first place
the error surfaces. Forge surfaces `Transactions require a replica set
or mongos. Single-node instances throw on $transaction.` at adapter
construction time when it detects this — but only if the adapter
actually probes. Always run the doctor on first connect in
development:

```ts
console.log(await db.$doctor());
```

---

## Five worked patterns

### (a) Bank transfer

Two account rows mutated atomically with a ledger entry, deadlock-retry
around the whole tx.

```ts
import { DbKnownError } from 'forge-orm';

async function transfer(fromId: string, toId: string, amount: number) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        // Lock both accounts in a stable order to avoid deadlocks between
        // mirror-image transfers (A→B and B→A).
        const [first, second] = fromId < toId ? [fromId, toId] : [toId, fromId];
        const [a, b] = await Promise.all([
          tx.account.findFirst({ where: { id: first } }),
          tx.account.findFirst({ where: { id: second } }),
        ]);
        if (!a || !b) throw new Error('account missing');

        const from = a.id === fromId ? a : b;
        if (from.balance < amount) throw new Error('insufficient funds');

        await tx.account.update({
          where: { id: fromId }, data: { balance: { decrement: amount } },
        });
        await tx.account.update({
          where: { id: toId },   data: { balance: { increment: amount } },
        });
        await tx.ledger.create({
          data: { from: fromId, to: toId, amount, ts: new Date() },
        });
      });
    } catch (err) {
      if (err instanceof DbKnownError && err.code === 'P2034' && attempt < 4) {
        await new Promise(r => setTimeout(r, 25 * 2 ** attempt + Math.random() * 25));
        continue;
      }
      throw err;
    }
  }
}
```

The stable lock order (lower id first) collapses the classic
deadlock window. The retry loop catches the rare `P2034` that
slips through anyway.

The `Promise.all` over two reads is fine on the SQL adapters — one
client serialises them for you — but **not on Mongo**, where a
`ClientSession` rejects overlapping operations. Await the two reads one
at a time if this has to run on Mongo. That is the same reason the
[array form](#array-form) runs its thunks sequentially.

### (b) Bulk import

100k rows. Naive `for (const row of rows) await tx.x.create(row)` is
slow because every statement is a round trip. Batch in chunks of 1k
inside one big tx:

```ts
async function importRows(rows: ItemInput[]) {
  const CHUNK = 1000;
  await db.$transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      await tx.item.createMany({ data: slice });
      if (i % 10000 === 0) console.log(`imported ${i} / ${rows.length}`);
    }
  });
}
```

Two things to know.

* **One big tx vs. one tx per chunk.** Big tx = all-or-nothing
  rollback, single COMMIT, fastest. Per-chunk = partial progress on
  failure, more COMMIT overhead, slower. Pick based on whether you
  can resume a partial import. The first wins on speed; the second
  wins on operational sanity for very large imports.
* **MySQL `max_allowed_packet`.** A `createMany` with 1k rows
  serialises to a single multi-row `INSERT`. Default packet limit is
  64MB. Wide rows (text, json, blob) can hit this in surprisingly
  few rows. Drop the chunk size to 200 if you see
  `ER_NET_PACKET_TOO_LARGE`.

For very large imports (millions of rows) the right answer is the
dialect's native bulk loader — PG `COPY FROM`, MySQL `LOAD DATA
INFILE`, SQLite `INSERT INTO ... SELECT FROM csv` via the
csv extension. Drop to `$executeRaw` for those.

### (c) The outbox

Cross-system consistency without two-phase commit. Order placement
writes both the order and the "publish to Kafka" intent in one tx;
a separate worker drains the outbox:

```ts
const Outbox = model('outbox_events', {
  id:           f.id(),
  topic:        f.string(),
  payload:      f.json(),
  created_at:   f.dateTime().now(),
  delivered_at: f.dateTime().nullable(),
  attempts:     f.int().default(0),
}, {
  indexes: [
    { keys: { delivered_at: 1, created_at: 1 }, name: 'idx_outbox_pending',
      partialFilter: { delivered_at: null } },
  ],
});

// Producer — in the same tx as the business write.
async function placeOrder(input: OrderInput) {
  return db.$transaction(async (tx) => {
    const order = await tx.order.create({ data: input });
    await tx.outbox_events.create({
      data: { topic: 'order.placed', payload: { id: order.id, total: order.total } },
    });
    return order;
  });
}

// Consumer — runs as a separate worker, polls the outbox.
async function drainOutbox() {
  while (true) {
    const batch = await db.outbox_events.findMany({
      where: { delivered_at: null }, take: 100, orderBy: { created_at: 'asc' },
    });
    if (batch.length === 0) { await sleep(500); continue; }

    for (const ev of batch) {
      try {
        await kafka.publish(ev.topic, ev.payload);
        await db.outbox_events.update({
          where: { id: ev.id }, data: { delivered_at: new Date() },
        });
      } catch (err) {
        await db.outbox_events.update({
          where: { id: ev.id }, data: { attempts: { increment: 1 } },
        });
        if (ev.attempts >= 10) await sendToDeadLetter(ev);
      }
    }
  }
}
```

The partial index `delivered_at IS NULL` keeps the pending-poll query
fast even when the outbox has millions of historical rows. Consumers
of the published events need to dedupe on `(topic, payload.id)`
because Kafka publish can succeed without `delivered_at` getting
flipped (the worker crashed in between). At-least-once is the
contract; idempotent consumers are non-negotiable.

### (d) Advisory locks instead of row locks

When the natural row to lock is "no row yet" — coalescing concurrent
provisioning, leader election, or "only one worker at a time can run
this migration." Postgres advisory locks scoped to the tx are the
cleanest tool:

```ts
async function provisionOrgOnce(orgId: string) {
  await db.$transaction(async (tx) => {
    // Two int4s (or one int8) hashed from the org id, namespaced so
    // unrelated lock callers don't collide.
    const key = hashToInt8(`provision:${orgId}`);
    const got = await tx.$queryRaw<{ ok: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${key}) AS ok
    `;
    if (!got[0].ok) {
      // Someone else is provisioning. Either retry, or bail.
      throw new Error('provision-in-flight');
    }

    // Idempotency check — the other holder may already be done.
    const existing = await tx.org.findFirst({ where: { id: orgId } });
    if (existing) return existing;

    return tx.org.create({ data: { id: orgId, ... } });
  });
  // Lock auto-released at COMMIT / ROLLBACK because we used the _xact_ variant.
}
```

`pg_try_advisory_xact_lock` is non-blocking and tx-scoped. Use
`pg_advisory_xact_lock` if you'd rather wait. The session-scoped
variants (`pg_advisory_lock`) outlive the tx and you have to release
them by hand — easy to leak, prefer the xact variant.

MySQL has `GET_LOCK` (session-scoped); MSSQL has `sp_getapplock`
(scoped to session or tx). SQLite, DuckDB, and Mongo don't have an
equivalent — model it as a row in a `_leases` table with a
`(holder, expires_at)` and `UPDATE … WHERE expires_at < NOW()` to
take over.

### (e) Saga compensation on Mongo

Mongo cross-collection update where each step has a compensating undo
step that the caller invokes on failure. Cleaner than nested
`withTransaction` when steps span systems forge can't speak to.

```ts
type Step = { do: () => Promise<void>; undo: () => Promise<void> };

async function runSaga(steps: Step[]) {
  const done: Step[] = [];
  try {
    for (const s of steps) {
      await s.do();
      done.push(s);
    }
  } catch (err) {
    for (const s of done.reverse()) {
      try { await s.undo(); }
      catch (uerr) { log.error('saga undo failed', { err: uerr, stepIndex: done.indexOf(s) }); }
    }
    throw err;
  }
}

await runSaga([
  {
    do:   () => db.$transaction(async (tx) => {
      await tx.order.create({ data: { id: orderId, status: 'reserved' } });
      await tx.inventory.update({
        where: { sku }, data: { reserved: { increment: qty } },
      });
    }),
    undo: () => db.$transaction(async (tx) => {
      await tx.order.delete({ where: { id: orderId } });
      await tx.inventory.update({
        where: { sku }, data: { reserved: { decrement: qty } },
      });
    }),
  },
  {
    do:   () => paymentGateway.charge(custId, total),
    undo: () => paymentGateway.refund(custId, total),
  },
  {
    do:   () => db.order.update({ where: { id: orderId }, data: { status: 'paid' } }),
    undo: () => db.order.update({ where: { id: orderId }, data: { status: 'failed' } }),
  },
]);
```

Each saga step's `do` and `undo` are themselves Mongo txs (or external
calls). If step 2 fails, step 1's undo runs. Undo idempotency is the
hard part — write each `undo` so calling it twice with the same input
leaves the system in the same state as calling it once. Without
idempotent undos a partial-failure retry loop can corrupt state worse
than the original failure.

This is the pattern Mongo users reach for when they actually need
multi-document atomicity but can't put the whole flow in one Mongo
tx — because the flow includes calls to a payment gateway, an
inventory service, or a third-party API that can't enlist in any tx.
