# Mutations

The [Writing data](../README.md#writing-data) section of the README is the
short tour. This page is the full reference for every write verb forge
exposes, the dialect SQL each one compiles to, and the patterns that keep
those writes correct under load.

The shape is intentionally Prisma-flavoured: `create`, `createMany`,
`update`, `updateMany`, `upsert`, `delete`, `deleteMany`, plus atomic
number ops and nested writes. The mapping to driver-level statements is
adapter-specific and described below.

## Contents

* [`create` vs `createMany`](#create-vs-createmany)
* [`update` vs `updateMany`](#update-vs-updatemany)
* [`upsert`](#upsert)
* [`delete` vs `deleteMany`](#delete-vs-deletemany)
* [Atomic number ops](#atomic-number-ops)
* [`set` vs `unset`](#set-vs-unset)
* [Nested writes](#nested-writes)
* [`createMany` + `skipDuplicates`](#createmany--skipduplicates)
* [Returning shape](#returning-shape)
* [Idempotency](#idempotency)
* [Optimistic concurrency](#optimistic-concurrency)
* [Pessimistic locking](#pessimistic-locking)
* [Batched throughput](#batched-throughput)
* [Mutation events](#mutation-events)
* [Worked patterns](#worked-patterns)

---

## `create` vs `createMany`

The asymmetry between the two is small but load-bearing.

| Verb         | `where` | `data`                | Returns                              | Per-row work |
|--------------|---------|-----------------------|--------------------------------------|--------------|
| `create`     | n/a     | single object         | the inserted row (all columns)       | per-call     |
| `createMany` | n/a     | array of objects      | `{ count: number }`                  | batched      |

```ts
const row = await db.user.create({
  data: { email: 'a@x.co', name: 'Alice' },
});
// → { id: 'u_…', email: 'a@x.co', name: 'Alice', created_at: …, updated_at: … }

const { count } = await db.user.createMany({
  data: [
    { email: 'b@x.co', name: 'Bea' },
    { email: 'c@x.co', name: 'Cleo' },
  ],
});
// → { count: 2 }
```

Choose `createMany` when you do not need the inserted rows back. The
difference is one round-trip vs N, and on Postgres / MySQL one parsed
statement vs N. If you do need the rows back from a bulk insert, see
[Returning shape](#returning-shape) — Postgres can do it in one trip,
SQLite 3.35+ can do it in one trip, MySQL and MSSQL cannot.

### What each adapter compiles to

| Adapter   | `create`                                | `createMany`                                          |
|-----------|------------------------------------------|-------------------------------------------------------|
| postgres  | `INSERT INTO … VALUES (…) RETURNING *`   | `INSERT INTO … VALUES (…),(…),…` (one statement)      |
| mysql     | `INSERT INTO … VALUES (…)` + `SELECT`    | `INSERT INTO … VALUES (…),(…),…`                      |
| sqlite    | `INSERT INTO … VALUES (…) RETURNING *`   | `INSERT INTO … VALUES (…),(…),…` (one statement)      |
| duckdb    | `INSERT INTO … VALUES (…) RETURNING *`   | `INSERT INTO … VALUES (…),(…),…`                      |
| mssql     | `INSERT INTO … OUTPUT INSERTED.* VALUES` | `INSERT INTO … VALUES (…),(…),…` (rowcount only)      |
| mongo     | `insertOne`                              | `insertMany`                                          |

Postgres, SQLite 3.35+, DuckDB and MSSQL all support `RETURNING` / `OUTPUT`
clauses on a single-row insert, so `create` is one round-trip on every SQL
dialect. MySQL has no `RETURNING`, so `create` does an `INSERT` followed by
a `SELECT` keyed on the new row's auto-id / primary key — still one logical
call but two statements on the wire.

### ID generation timing

Identifiers are generated client-side, before the insert leaves the
process. `f.id()` defaults to a sortable 26-character ULID-style ID, and
the value is stamped onto `data` if it is missing. This means:

* The ID is known before the row commits — you can return it from a
  handler, log it, enqueue follow-up work referencing it, all without
  waiting on the database round-trip.
* `createMany` does not need `RETURNING` to learn the IDs — they were
  generated locally and are visible on the input rows.
* Sequential / auto-increment columns (declared with
  `f.int().autoincrement()`) are the exception — those are assigned by the
  database, and `create` reads them back via `RETURNING` / `OUTPUT` / the
  follow-up SELECT.

See [Picking a primary-key strategy](../README.md#picking-a-primary-key-strategy)
for when to use which.

---

## `update` vs `updateMany`

| Verb         | `where`                | Returns               | Notes                                |
|--------------|------------------------|-----------------------|--------------------------------------|
| `update`     | unique selector        | the updated row       | throws if no row matched             |
| `updateMany` | any filter             | `{ count: number }`   | zero matches is a no-op, not an error |

```ts
await db.user.update({
  where: { id: 'u1' },
  data:  { name: 'Alice 2' },
});

const { count } = await db.user.updateMany({
  where: { active: false, last_seen: { lt: cutoff } },
  data:  { archived: true },
});
```

`update`'s `where` is type-narrowed to the model's unique fields (the
`@id`, plus anything marked `.unique()` or part of a unique compound).
Passing a non-unique field there is a TypeScript error. If you genuinely
want a single-row update against a non-unique filter, use `updateMany` and
either rely on the count or guard with `take: 1` in a preceding `findFirst`.

### What each adapter compiles to

| Adapter   | `update`                                       | `updateMany`                                   |
|-----------|------------------------------------------------|------------------------------------------------|
| postgres  | `UPDATE … SET … WHERE … RETURNING *`           | `UPDATE … SET … WHERE …` (rowcount)            |
| mysql     | `UPDATE … SET … WHERE …` + `SELECT`            | `UPDATE … SET … WHERE …` (affectedRows)        |
| sqlite    | `UPDATE … SET … WHERE … RETURNING *`           | `UPDATE … SET … WHERE …` (changes())           |
| duckdb    | `UPDATE … SET … WHERE … RETURNING *`           | `UPDATE … SET … WHERE …` (rowcount)            |
| mssql     | `UPDATE … SET … OUTPUT INSERTED.* WHERE …`     | `UPDATE … SET … WHERE …` (rowcount)            |
| mongo     | `findOneAndUpdate`                             | `updateMany`                                   |

There is no `updateManyAndReturn` on the wrapper. If you need the rows
back after a bulk update, do the `updateMany` and a `findMany` of the same
filter inside one `$transaction` — or, on Postgres only, drop to
`db.$queryRaw` for `UPDATE … RETURNING *` and parse the result yourself.

### Why `update` throws on no match

A typed `update` against a unique key is asserting the row exists. Letting
that silently no-op masks application bugs: the handler thinks it wrote,
the database disagrees, and the next read shows stale data. The
`updateMany` path is the right verb when "match or not" is a valid
outcome.

---

## `upsert`

`upsert` takes three blocks: `where` (must be a unique selector), `create`
(used when no row matches), and `update` (used when one does). Forge
compiles to a single atomic statement on every adapter — there is no
read-then-write that could race.

```ts
await db.user.upsert({
  where:  { email: 'a@x.co' },
  create: { email: 'a@x.co', name: 'A', plan: 'free' },
  update: { last_seen: new Date() },
});
```

The conflict target is inferred from `where`: forge walks the
equality-leaves of the `where` tree and the resulting column set becomes
the `ON CONFLICT (…)` / `ON DUPLICATE KEY UPDATE` / `MERGE … ON` target.
Both single-column and AND-of-eq compound selectors are supported.

| Adapter   | Compiled to                                                |
|-----------|------------------------------------------------------------|
| postgres  | `INSERT … ON CONFLICT (…) DO UPDATE SET … RETURNING *`     |
| mysql     | `INSERT … ON DUPLICATE KEY UPDATE …` + `SELECT`            |
| sqlite    | `INSERT … ON CONFLICT (…) DO UPDATE SET … RETURNING *`     |
| duckdb    | `INSERT … ON CONFLICT (…) DO UPDATE SET … RETURNING *`     |
| mssql     | `MERGE INTO tgt USING (VALUES …) src ON … WHEN MATCHED …`  |
| mongo     | `updateOne(filter, update, { upsert: true })`              |

MSSQL `MERGE` shipped in 2.5.0 (see [CHANGELOG.md](../CHANGELOG.md)); the
previous 2.3 / 2.4 path threw `NotImplemented`. The `MERGE` form supports
`set`, `increment` (via `COALESCE(tgt.col, 0) + N`), `multiply` and
`unset` (`= NULL`) on the `WHEN MATCHED` branch, and returns the row via
`OUTPUT INSERTED.*`.

Mongo's `upsert: true` covers the same semantics, but the rule for what
the upserted document contains is different: Mongo merges `$set` /
`$setOnInsert` against the filter, and forge fills `$setOnInsert` with
any field from `create` not also in `update`. The net effect is the same
"update if found, create if not" — just expressed in Mongo's update doc.

### Constraints on the conflict target

The eq-leaves you pass in `where` must correspond to either the primary
key, a `UNIQUE` constraint, or a unique index. On Postgres / SQLite /
DuckDB this is enforced by the dialect itself (the optimiser will refuse
`ON CONFLICT (col)` for a non-unique `col`). On MySQL the constraint must
exist or `ON DUPLICATE KEY UPDATE` will trigger on the wrong index. On
MSSQL the `MERGE` join can in principle be non-unique, but forge still
requires uniqueness to keep semantics consistent across dialects.

If the `where` includes both an eq-leaf on a unique column and other
non-eq filters (e.g. `active: true`), the non-eq filters are ignored for
the conflict target — they would not be valid in `ON CONFLICT`. Use
`updateMany` when you actually need a compound filter.

---

## `delete` vs `deleteMany`

Same asymmetry as `update`.

| Verb         | `where`         | Returns         | Notes                              |
|--------------|-----------------|-----------------|------------------------------------|
| `delete`     | unique selector | the deleted row | throws if no row matched           |
| `deleteMany` | any filter      | `{ count }`     | zero matches is a no-op            |

```ts
await db.user.delete({ where: { id: 'u1' } });
await db.user.deleteMany({ where: { archived: true, deleted_at: { lt: cutoff } } });
```

On SQL, `delete` uses `DELETE … RETURNING *` (Postgres / SQLite / DuckDB),
`OUTPUT DELETED.*` (MSSQL), or `SELECT` + `DELETE` (MySQL) to return the
row. On Mongo, `delete` is `findOneAndDelete` and `deleteMany` is
`deleteMany`.

### Cascading

Relations declared with `onDelete: 'Cascade'` (see
[Relations](../README.md#relations)) cascade to children when a parent is
deleted. On SQL this is a database-enforced `FOREIGN KEY … ON DELETE
CASCADE`, so the cascade happens inside the statement. On Mongo there are
no foreign keys; forge walks the schema graph at delete time and issues
the child `deleteMany` calls. The Mongo path is best-effort — it cannot
be made transactional outside a replica-set session.

Other `onDelete` modes (`SetNull`, `Restrict`, `NoAction`) behave the
same way: enforced by the database on SQL, simulated by forge on Mongo.

See [docs/RELATIONS.md](./RELATIONS.md) for the full cascade matrix when
the doc lands; until then the README section is the authoritative source.

---

## Atomic number ops

For number columns you can pass an op object instead of a literal value.
Each op compiles to a single in-place arithmetic update — the column is
read and written in one statement, so there is no read-then-write race.

```ts
await db.post.update({
  where: { id: 'p1' },
  data: {
    views: { increment: 1 },
    score: { multiply: 2 },
    rank:  { divide: 2 },
    debt:  { decrement: 100 },
  },
});
```

Supported ops: `increment`, `decrement`, `multiply`, `divide`. Each takes
a number. Mixing an op with a `set` on the same column is rejected at
compile time.

| Adapter   | `increment 5` compiles to       | `multiply 2` compiles to       |
|-----------|---------------------------------|--------------------------------|
| postgres  | `"views" = "views" + 5`         | `"score" = "score" * 2`        |
| mysql     | `` `views` = `views` + 5 ``     | `` `score` = `score` * 2 ``    |
| sqlite    | `"views" = "views" + 5`         | `"score" = "score" * 2`        |
| duckdb    | `"views" = "views" + 5`         | `"score" = "score" * 2`        |
| mssql     | `[views] = [views] + 5`         | `[score] = [score] * 2`        |
| mongo     | `{ $inc: { views: 5 } }`        | `{ $mul: { score: 2 } }`       |

Mongo `decrement N` is `$inc: { col: -N }`, `divide N` is `$mul: { col:
1 / N }`. All SQL dialects compile `decrement` and `divide` to the
obvious `- N` / `/ N`.

### Concurrency safety

Atomic ops are race-safe at the statement level: two concurrent
`increment: 1` calls against the same row will produce a final value
two greater than the starting value, on every adapter, with no risk of
a lost update — because there is no application-side read of the prior
value. This is the property that makes atomic ops the right primitive
for counters, balances, stock levels, and any other quantity touched by
more than one writer at a time.

The guarantee stops at the row. If you need atomicity across multiple
rows or multiple statements, wrap them in a `$transaction` and let the
database serialise.

### Counter example

```ts
async function recordView(postId: string) {
  return db.post.update({
    where: { id: postId },
    data:  { views: { increment: 1 }, last_viewed: new Date() },
  });
}
```

One round-trip, one statement, race-free across any number of callers.
Contrast with the wrong shape — read, add one, write — which loses
updates under any concurrency at all.

---

## `set` vs `unset`

A literal value in `data` is a `set`. To clear a nullable column, pass
`null`. To explicitly remove a Mongo field (so the document has no such
key, rather than the key being present with a `null` value), use the
`unset` op:

```ts
await db.user.update({
  where: { id: 'u1' },
  data: {
    name: 'Alice',           // set
    avatar_url: null,        // set to NULL on SQL, set to null on Mongo
    profile_meta: { unset: true },   // $unset on Mongo, = NULL on SQL
  },
});
```

On SQL there is no observable difference between `null` and `unset` — the
column gets `NULL` either way, and the row still has it. On Mongo:

* `null` writes `{ … profile_meta: null }`. The field is present.
* `{ unset: true }` writes `{ $unset: { profile_meta: '' } }`. The field
  is absent from the document.

The distinction matters when reads filter on `exists` (`where: {
profile_meta: { exists: false } }`) or when other code is doing
type-narrowing on `undefined` vs `null`.

---

## Nested writes

A relation key in `data` accepts a small DSL describing what to do with
the related rows in the same call:

```ts
await db.user.create({
  data: {
    email: 'a@x.co', name: 'Alice',
    posts: {
      create: [
        { title: 'Hello' },
        { title: 'World' },
      ],
      connect: { id: 'p_existing' },
    },
    profile: {
      create: { bio: 'engineer' },
    },
  },
});
```

The supported actions, per relation kind:

| Action            | one-to-one | one-to-many | many-to-many |
|-------------------|------------|-------------|--------------|
| `create`          | yes        | yes (array) | yes          |
| `createMany`      | no         | yes         | yes          |
| `connect`         | yes        | yes         | yes          |
| `connectOrCreate` | yes        | yes         | yes          |
| `disconnect`      | yes        | yes         | yes          |
| `set`             | no         | yes         | yes          |
| `update`          | yes        | yes (where) | yes (where)  |
| `updateMany`      | no         | yes         | yes          |
| `upsert`          | yes        | yes         | yes          |
| `delete`          | yes        | yes (where) | yes (where)  |
| `deleteMany`      | no         | yes         | yes          |

`connect` attaches by unique key, `disconnect` removes the link without
deleting the row, `set` replaces the entire set of linked rows with the
listed ones, `connectOrCreate` is the lookup-or-make pattern in one
shape.

### Write order and transactionality

On SQL adapters the parent and children are issued inside a single
`$transaction`. The order is fixed: parent first when the parent ID is
needed by the children's foreign key (`one-to-many`, `one-to-one` with
the FK on the child), children first when the relationship is owned by
the parent (`one-to-one` with the FK on the parent). All-or-nothing: if
any nested write fails, the whole call rolls back.

On Mongo there is no cross-collection transaction unless the cluster is
a replica set with sessions. Forge issues the writes in the same logical
order, but the guarantee is best-effort — a failed child write after a
successful parent insert leaves the parent in place. For strict cross-
document atomicity on Mongo, open a session yourself and use
`$transaction` (it forwards the session to the driver).

### Worked example: `connectOrCreate`

```ts
await db.post.create({
  data: {
    title: 'Hello',
    tags: {
      connectOrCreate: [
        { where: { name: 'release' }, create: { name: 'release' } },
        { where: { name: 'v2' },      create: { name: 'v2' } },
      ],
    },
  },
});
```

Each item runs as a lookup on the unique `name`, then either attaches
the existing row or inserts a new one and attaches that. On SQL this is
two statements per tag inside the parent's transaction; on Mongo it is
one `findOneAndUpdate` with `upsert: true` per tag plus a join-table
write where applicable.

---

## `createMany` + `skipDuplicates`

Bulk insert with conflict tolerance. Pass `skipDuplicates: true` to skip
rows that violate a unique constraint instead of failing the whole batch.

```ts
const { count } = await db.event.createMany({
  data: incomingEvents,        // any size
  skipDuplicates: true,
});
```

| Adapter   | Compiles to                                            |
|-----------|--------------------------------------------------------|
| postgres  | `INSERT … VALUES (…),(…),… ON CONFLICT DO NOTHING`     |
| mysql     | `INSERT IGNORE INTO … VALUES (…),(…),…`                |
| sqlite    | `INSERT OR IGNORE INTO … VALUES (…),(…),…`             |
| duckdb    | `INSERT … VALUES (…),(…),… ON CONFLICT DO NOTHING`     |
| mssql     | `INSERT INTO … VALUES (…),(…),…` (no flag — MERGE path) |
| mongo     | `insertMany(docs, { ordered: false })` + drop-dup error |

The `count` returned is the number of rows that actually inserted; the
ones that conflicted are silently dropped. On Mongo, `ordered: false`
tells the driver to continue past write errors, and forge filters
`duplicate key` errors out of the result so the batch completes with a
partial success count.

MSSQL does not have a direct counterpart to `INSERT IGNORE` for bulk
inserts — the `MERGE` path is what `upsert` uses, and `createMany` with
`skipDuplicates` falls back to the same batched insert without the flag.
If duplicate tolerance matters on MSSQL, use `upsert` per row (still
one statement each via `MERGE`) inside a `$transaction`.

### Bulk size

Every adapter supports tens of thousands of rows in a single
`createMany`. Forge does not chunk for you — that is a deliberate
choice, because the optimal chunk size depends on the row width, the
driver's parameter limit, and the network. Practical guidance:

* Postgres / SQLite / DuckDB / MSSQL: 10,000 rows in one statement is
  fine for moderate row widths (under ~20 columns). Above that, chunk to
  avoid the parameter limit (Postgres: 65,535 parameters; SQLite:
  `SQLITE_MAX_VARIABLE_NUMBER`, default 32,766 since 3.32).
* MySQL: chunks of 1,000 - 5,000 rows are conservative; the limit is
  `max_allowed_packet`, not a parameter count.
* Mongo: `insertMany` chunks at the driver level (16 MB BSON size).
  Pass any number; the driver splits.

For sustained throughput above a few thousand rows per second, see
[Batched throughput](#batched-throughput).

---

## Returning shape

What you can read back after a write, per dialect:

| Operation         | postgres | mysql | sqlite (3.35+) | duckdb | mssql | mongo                  |
|-------------------|----------|-------|----------------|--------|-------|------------------------|
| `create`          | row      | row*  | row            | row    | row   | row                    |
| `createMany`      | count    | count | count          | count  | count | count                  |
| `update`          | row      | row*  | row            | row    | row   | row (`findOneAndUpdate`) |
| `updateMany`      | count    | count | count          | count  | count | count                  |
| `delete`          | row      | row*  | row            | row    | row   | row (`findOneAndDelete`) |
| `deleteMany`      | count    | count | count          | count  | count | count                  |
| `upsert`          | row      | row*  | row            | row    | row   | row                    |

\* MySQL does the second `SELECT` to materialise the row, so it is one
logical call but two statements.

You can shape the returned row with `select` or `include`, the same way
reads do:

```ts
const { id, email } = await db.user.create({
  data:   { email: 'a@x.co', name: 'A' },
  select: { id: true, email: true },
});

const userWithPosts = await db.user.update({
  where:   { id: 'u1' },
  data:    { name: 'A2' },
  include: { posts: true },
});
```

On Postgres / SQLite / DuckDB the `select` narrows the `RETURNING` list.
On MSSQL it narrows the `OUTPUT INSERTED.*` list. On MySQL it narrows
the follow-up `SELECT`. On Mongo `select` becomes a projection.

`include` always does a second query (or a Mongo `$lookup`) — relations
do not come back through `RETURNING`.

---

## Idempotency

The simplest correct way to make a write idempotent is to give it a
unique key and use `upsert`. Two common shapes:

### Request-id key

```ts
const RequestLog = model('request_logs', {
  id:         f.id(),
  request_id: f.string().unique(),
  payload:    f.json(),
  result:     f.json().nullable(),
});

async function handle(req: Request, body: Body) {
  return db.$transaction(async (tx) => {
    const log = await tx.requestLog.upsert({
      where:  { request_id: req.headers['idempotency-key'] },
      create: { request_id: req.headers['idempotency-key'], payload: body },
      update: {},   // no-op on re-arrival
    });
    if (log.result) return log.result;          // already processed

    const result = await doWork(tx, body);
    await tx.requestLog.update({
      where: { id: log.id },
      data:  { result },
    });
    return result;
  });
}
```

The unique constraint on `request_id` is what makes the upsert atomic
under concurrent re-tries — two requests with the same key cannot both
take the create path.

### HTTP `Idempotency-Key`

The pattern above is the database side of the
[Idempotency-Key](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)
header. Combine it with a stored response body and you have a complete
idempotent endpoint: re-sends return the cached response, first-sends
do the work and cache it.

---

## Optimistic concurrency

Add a `version` column, gate the update on it, and bump it in the same
statement:

```ts
const Doc = model('docs', {
  id:      f.id(),
  body:    f.string(),
  version: f.int().default(0),
});

async function saveDoc(id: string, body: string, expected: number) {
  const { count } = await db.doc.updateMany({
    where: { id, version: expected },
    data:  { body, version: { increment: 1 } },
  });
  if (count === 0) throw new ConflictError('stale version');
}
```

The `where: { id, version: expected }` and the `version: { increment: 1
}` are atomic relative to each other on every adapter — they are one
`UPDATE` statement. A concurrent writer whose `expected` is older than
the current row gets `count === 0` and can refetch and retry.

This is the cheapest form of concurrency control: no locks, no
serializable isolation, no advisory locks. It scales as well as the
underlying row writes do.

---

## Pessimistic locking

When you need to read a row, decide based on its current value, and
write back without another writer interleaving, take a row lock inside
a transaction:

```ts
await db.$transaction(async (tx) => {
  const [row] = await tx.$queryRaw<Account[]>`
    SELECT * FROM accounts WHERE id = ${id} FOR UPDATE
  `;
  if (row.balance < amount) throw new InsufficientFunds();

  await tx.account.update({
    where: { id },
    data:  { balance: { decrement: amount } },
  });
});
```

`FOR UPDATE` is Postgres / MySQL syntax. MSSQL uses `WITH (UPDLOCK,
ROWLOCK)`. SQLite serialises all writes through a single writer lock
already — `BEGIN IMMEDIATE` in a `$transaction` is the closest
equivalent. DuckDB is single-writer per process. Mongo does not have
row-level pessimistic locking outside a transaction with
`{ readConcern: 'snapshot', writeConcern: 'majority' }`.

In practice, atomic ops + optimistic concurrency cover most cases
without needing the explicit lock. Reach for `FOR UPDATE` when the
decision logic between read and write is complex enough that you cannot
encode it as a `where` clause on the update.

See [docs/RAW-SQL.md](./RAW-SQL.md) for the `$queryRaw` shape.

---

## Batched throughput

Three shapes for bulk writes, in order of throughput:

1. **`createMany`** — one statement, one round-trip. Best.
2. **`$transaction([...])`** — N statements, one round-trip, one commit.
3. **N `create` calls** — N statements, N round-trips, N commits. Worst.

Rough numbers, single client on a local Postgres, 200-byte rows:

| Shape                              | Rows / second |
|------------------------------------|---------------|
| `createMany({ data: 10_000 rows })`| ~150,000      |
| `$transaction([10_000 creates])`   | ~25,000       |
| 10,000 separate `create` calls     | ~3,000        |

The shape of the difference is the same on every adapter — exact
numbers shift with network latency, row width, and the index count on
the target table.

When `createMany` is not enough — sustained ingest above ~150k rows/s —
drop to the dialect's native bulk path:

* **Postgres**: `COPY … FROM STDIN`. Use the `pg-copy-streams` package
  and forge's connection via `db.$raw().connection`.
* **MySQL**: `LOAD DATA LOCAL INFILE` from a tempfile. Requires
  `local_infile=ON` on the server.
* **MSSQL**: `BULK INSERT` from a file or the `tedious` bulkLoad API.
* **SQLite**: a single `$transaction` around a tight loop is already
  close to the disk's write ceiling; the next step is `PRAGMA
  journal_mode = WAL` and `PRAGMA synchronous = NORMAL`.
* **DuckDB**: `COPY FROM` a Parquet / CSV file is the fast path.
* **Mongo**: `insertMany` with `ordered: false`. The driver pipelines.

These paths bypass the typed `model.*` wrapper. Use them when the
throughput is worth giving up the type-check.

---

## Mutation events

Subscribe to write traffic via the same `$on('query')` channel reads
use:

```ts
db.$on('query', (e) => {
  if (e.op === 'insert' || e.op === 'update' || e.op === 'delete') {
    log.info('write', { adapter: e.adapter, model: e.model, op: e.op, ms: e.duration_ms });
  }
});
```

The `QueryEvent` fields relevant to mutations:

| Field         | Meaning                                                |
|---------------|--------------------------------------------------------|
| `adapter`     | `'postgres' \| 'mysql' \| 'sqlite' \| 'mongo'` etc.    |
| `model`       | schema key (`'user'`), or `''` for raw SQL             |
| `op`          | `'insert' \| 'update' \| 'delete' \| 'raw'`, plus Mongo verbs |
| `sql`         | SQL text or Mongo op description (`'users.insertOne'`) |
| `params`      | bound params (SQL) or Mongo args object                |
| `duration_ms` | wall clock between dispatch and result                 |
| `rowCount`    | affected rows when the driver reports them, else `-1`  |
| `startedAt`   | server-local timestamp at dispatch                     |
| `semanticOp`  | `'softDelete' \| 'softDeleteMany' \| 'restore' \| 'restoreMany'` when the higher-level verb compiled down to a plain `update` |

`semanticOp` is the field listeners use to tell a soft-delete from a
real update without parsing SQL. It is set only for the four soft-delete
verbs — `create`, `update`, `upsert`, `delete` are not re-labelled,
because the `op` field already carries that.

For the full event-system reference including error events, OTel
spans, and the slow-query alerting recipe, see
[docs/QUERIES.md](./QUERIES.md).

---

## Worked patterns

Eight problems that come up regularly, each solved with the verbs above.

### (a) Idempotent webhook handler

A webhook delivers each event at-least-once. Drop duplicates with a
composite unique on `(provider, event_id)`:

```ts
const ProviderEvent = model('provider_events', {
  id:         f.id(),
  provider:   f.string(),
  event_id:   f.string(),
  payload:    f.json(),
  processed:  f.boolean().default(false),
}, {
  uniques: [['provider', 'event_id']],
});

async function onWebhook(provider: string, body: WebhookBody) {
  const { processed } = await db.providerEvent.upsert({
    where:  { provider_event_id: { provider, event_id: body.id } },
    create: { provider, event_id: body.id, payload: body },
    update: {},      // no-op on duplicate
  });
  if (processed) return;

  await process(body);
  await db.providerEvent.update({
    where: { provider_event_id: { provider, event_id: body.id } },
    data:  { processed: true },
  });
}
```

The composite unique generates a unique index, which the `upsert` uses
as its conflict target. Two duplicate webhooks hit the database in
parallel and only one takes the create path — the other returns the
existing row with `processed: true` and exits.

### (b) Optimistic inventory decrement

Decrement stock only if there is enough, in one statement:

```ts
const { count } = await db.product.updateMany({
  where: { id: productId, stock: { gte: amount } },
  data:  { stock: { decrement: amount } },
});
if (count === 0) throw new OutOfStock();
```

No transaction, no lock, no race. The `stock: { gte: amount }` is part
of the `WHERE` clause; the database evaluates it under the row lock the
update takes anyway. If two concurrent calls fight over the last unit,
exactly one gets `count === 1` and the other gets `count === 0`.

### (c) Atomic counter

The view-counter shape from earlier, this time noting the `_at`
column:

```ts
async function recordView(postId: string) {
  await db.post.update({
    where: { id: postId },
    data:  {
      views:        { increment: 1 },
      last_view_at: new Date(),
    },
  });
}
```

One statement per call, scales linearly with whatever the row-lock
throughput of the underlying database is. Postgres / MySQL / SQLite all
run this comfortably at tens of thousands of calls per second per row
when the row is hot in the buffer cache.

### (d) Bulk ingest — 100,000 rows

Split into 100 batches of 1,000 inside one transaction. Forge does not
chunk for you; the wrapper is a deliberate ten lines:

```ts
async function bulkIngest(rows: Row[]) {
  const CHUNK = 1000;
  await db.$transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      await tx.event.createMany({
        data: rows.slice(i, i + CHUNK),
        skipDuplicates: true,
      });
    }
  });
}
```

The transaction means it is all-or-nothing — partial loads do not
leak. Above a few hundred thousand rows, switch to the dialect's native
bulk path (see [Batched throughput](#batched-throughput)).

### (e) Soft delete + restore

Declare a `deleted_at` column and use `softDelete` / `restore`:

```ts
const Post = model('posts', {
  id:         f.id(),
  title:      f.string(),
  body:       f.string(),
  deleted_at: f.timestamp().nullable(),
});

await db.post.softDelete({ where: { id: 'p1' } });
await db.post.restore({ where: { id: 'p1' } });
```

`softDelete` compiles to an `update` that sets `deleted_at = now()`, and
emits a `QueryEvent` with `semanticOp: 'softDelete'` so listeners can
treat it differently from a regular update (audit trail, replication
filters, etc.). Reads filter `deleted_at IS NULL` by default unless you
opt in with `withDeleted: true`. See
[Soft delete](../README.md#soft-delete) for the full surface.

### (f) Audit trail on every update

Tee writes to an audit table from a single event listener:

```ts
db.$on('query', async (e) => {
  if (e.op !== 'update' && e.op !== 'insert' && e.op !== 'delete') return;
  if (e.model === 'audit_log') return;   // do not audit the audit
  await db.auditLog.create({
    data: {
      at:       e.startedAt,
      model:    e.model,
      op:       e.semanticOp ?? e.op,
      rows:     e.rowCount,
      sql:      e.sql,
      duration: e.duration_ms,
    },
  });
});
```

The listener runs after the write commits, so a failed write does not
produce an audit row. If you need the audit row to be in the same
transaction as the write — strictly atomic audit — use the outbox
pattern below instead, with the audit row written inside the same
`$transaction`.

### (g) Transactional outbox

Write a domain row and an outbox event in one transaction, then a
worker drains the outbox to Kafka / SNS / whatever:

```ts
async function placeOrder(input: OrderInput) {
  return db.$transaction(async (tx) => {
    const order = await tx.order.create({ data: input });
    await tx.outbox.create({
      data: {
        topic:        'order.created',
        aggregate_id: order.id,
        payload:      order,
        status:       'pending',
      },
    });
    return order;
  });
}

// Worker, polled every 100 ms:
async function drainOutbox() {
  const batch = await db.outbox.findMany({
    where:   { status: 'pending' },
    orderBy: { id: 'asc' },
    take:    100,
  });
  for (const evt of batch) {
    await publish(evt.topic, evt.payload);
    await db.outbox.update({
      where: { id: evt.id },
      data:  { status: 'sent', sent_at: new Date() },
    });
  }
}
```

The `$transaction` is what makes this exactly-once-from-the-domain-side:
either the order and the outbox row both commit, or neither does. The
worker side is at-least-once delivery — publishers must dedup downstream
or the outbox event must include an idempotency key that the consumer
respects.

### (h) Bulk update by computed value

Raise all prices by 10% — one statement, server-side arithmetic:

```ts
await db.product.updateMany({
  where: { category: 'electronics' },
  data:  { price: { multiply: 1.1 } },
});
```

No application round-trip per row, no risk of stale reads, no
concurrency window. The same shape works for any monotonic
transformation expressible as `increment` / `decrement` / `multiply` /
`divide`. For non-monotonic transforms (e.g. price = price * tax_rate
where `tax_rate` is per-row), drop to `$executeRaw` with an `UPDATE …
SET … FROM` join — see [docs/RAW-SQL.md](./RAW-SQL.md).

---

For the next layer down — how the where tree compiles, how reads
combine with these writes inside a transaction, and how the IR sees
mutations — see [docs/QUERIES.md](./QUERIES.md) and
[docs/MIGRATIONS.md](./MIGRATIONS.md).
