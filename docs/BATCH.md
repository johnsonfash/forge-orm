# Batch operations

`createMany`, `updateMany`, `deleteMany`, and per-dialect bulk paths — what
forge-orm emits, the per-dialect bind-parameter limits, the chunking
patterns that scale to millions of rows, and the failure-semantics gotchas
(ordered vs unordered, skip-duplicates, RETURNING availability).

[MUTATIONS.md](./MUTATIONS.md) covers the verbs in isolation. This page is
the throughput-and-correctness lens on the same surface: what changes
when `data` is 100,000 rows instead of one, what changes when the network
RTT is 30 ms instead of 0.1 ms, and what changes when half the rows
collide with a unique constraint.

## Contents

* [The batch verbs](#the-batch-verbs)
* [Per-dialect emit](#per-dialect-emit)
* [Bind-parameter caps and chunking](#bind-parameter-caps-and-chunking)
* [`skipDuplicates` per dialect](#skipduplicates-per-dialect)
* [`RETURNING` after a batch](#returning-after-a-batch)
* [Throughput vs per-row latency](#throughput-vs-per-row-latency)
* [Failure semantics](#failure-semantics)
* [Transactions wrapping a batch](#transactions-wrapping-a-batch)
* [Memory profile and streaming](#memory-profile-and-streaming)
* [`updateMany` is uniform — per-row diff is raw SQL](#updatemany-is-uniform--per-row-diff-is-raw-sql)
* [Per-row diff with `CASE WHEN`](#per-row-diff-with-case-when)
* [Mongo `bulkWrite`](#mongo-bulkwrite)
* [Beyond `createMany` — native bulk loaders](#beyond-createmany--native-bulk-loaders)
* [Worked examples](#worked-examples)
* [See also](#see-also)

---

## The batch verbs

Forge exposes three plural-form write verbs on every model, two of which
emit a single statement on every SQL dialect.

| Verb         | Compiles to                | Returns               | Notes                                |
|--------------|----------------------------|-----------------------|--------------------------------------|
| `createMany` | one multi-row INSERT       | `{ count: number }`   | rows back via `RETURNING` on PG/SQLite/DuckDB; count-only on MySQL/MSSQL |
| `updateMany` | one UPDATE with WHERE      | `{ count: number }`   | same `data` shape applies to every matched row |
| `deleteMany` | one DELETE with WHERE      | `{ count: number }`   | hard delete; for soft delete see [SOFT-DELETE](./SOFT-DELETE.md) |

There is no `upsertMany`. The closest shape is `createMany({ skipDuplicates:
true })` when you can tolerate "skip the colliding rows" semantics, or a
per-row loop of `upsert` calls inside a `$transaction` when you need
update-on-conflict per row. The reasons are dialect-asymmetric:

* Postgres / SQLite / DuckDB can in principle do `INSERT … VALUES (…),(…)
  ON CONFLICT … DO UPDATE`, but a single `SET` clause cannot reference
  the conflicting row's per-row values without `EXCLUDED.col` and a
  uniform update target.
* MySQL `INSERT … ON DUPLICATE KEY UPDATE col = VALUES(col)` does work in
  bulk, but with the same uniform-update constraint.
* MSSQL `MERGE` (the upsert path since 2.5.0) accepts a `VALUES` source
  but the `WHEN MATCHED` branch fires per matched row only.
* Mongo `bulkWrite` does compose a batch of `updateOne … upsert: true`
  operations — see [Mongo `bulkWrite`](#mongo-bulkwrite) for the shape.

If you need true per-row upsert across N rows in one call, drop to
[`bulkWrite`](#mongo-bulkwrite) on Mongo, or `$executeRaw` with a CTE
fed from `unnest` on Postgres (see [RAW-SQL](./RAW-SQL.md)).

```ts
const { count } = await db.user.createMany({
  data: incoming,             // array of N rows
  skipDuplicates: true,
});

const { count: archived } = await db.session.updateMany({
  where: { last_seen: { lt: cutoff } },
  data:  { archived: true },
});

const { count: removed } = await db.tempUpload.deleteMany({
  where: { created_at: { lt: ttl } },
});
```

---

## Per-dialect emit

What forge sends to the driver, for each verb, for each adapter.

### `createMany` — multi-row INSERT

| Adapter   | SQL / op                                                             |
|-----------|----------------------------------------------------------------------|
| postgres  | `INSERT INTO "t" (cols) VALUES (?,?,…),(?,?,…),… RETURNING *`        |
| mysql     | ``INSERT INTO `t` (cols) VALUES (?,?,…),(?,?,…),…`` (no RETURNING)   |
| sqlite    | `INSERT INTO "t" (cols) VALUES (?,?,…),(?,?,…),… RETURNING *` (3.35+)|
| duckdb    | `INSERT INTO "t" (cols) VALUES (?,?,…),(?,?,…),… RETURNING *`        |
| mssql     | `INSERT INTO [t] (cols) VALUES (?,?,…),(?,?,…),…`                    |
| mongo     | `db.t.insertMany([…], { ordered: !skipDuplicates })`                 |

The IR carries one `InsertNode` with a `rows: Row[]` field; every adapter
walks `node.rows` once and emits a single statement. The column list is
the union of keys across all rows in schema-declared order — rows
omitting a column get `NULL` (or the field's default, applied client-side
before the IR is built).

Source: `src/adapters/postgres/compile-from-ir.ts` (the canonical
emitter, reused by SQLite / DuckDB / MSSQL / MySQL with dialect
swaps).

### `updateMany` — single UPDATE

| Adapter   | SQL / op                                                             |
|-----------|----------------------------------------------------------------------|
| postgres  | `UPDATE "t" SET col1 = ?, col2 = ? WHERE …` (rowcount)               |
| mysql     | ``UPDATE `t` SET col1 = ?, col2 = ? WHERE …`` (affectedRows)         |
| sqlite    | `UPDATE "t" SET col1 = ?, col2 = ? WHERE …` (changes())              |
| duckdb    | `UPDATE "t" SET col1 = ?, col2 = ? WHERE …` (rowcount)               |
| mssql     | `UPDATE [t] SET col1 = ?, col2 = ? WHERE …` (rowcount)               |
| mongo     | `db.t.updateMany(filter, update)`                                    |

The same `SET` applies to every matched row. Per-row diff is not
possible inside a single `updateMany` — see
[Per-row diff with `CASE WHEN`](#per-row-diff-with-case-when).

### `deleteMany` — single DELETE

| Adapter   | SQL / op                                                             |
|-----------|----------------------------------------------------------------------|
| postgres  | `DELETE FROM "t" WHERE …` (rowcount)                                 |
| mysql     | ``DELETE FROM `t` WHERE …`` (affectedRows)                           |
| sqlite    | `DELETE FROM "t" WHERE …` (changes())                                |
| duckdb    | `DELETE FROM "t" WHERE …` (rowcount)                                 |
| mssql     | `DELETE FROM [t] WHERE …` (rowcount)                                 |
| mongo     | `db.t.deleteMany(filter)`                                            |

On Mongo, `deleteMany` does not cascade — cascading deletes are walked
in TypeScript by the wrapper, issuing per-relation `deleteMany` calls.
See [MUTATIONS.md — Cascading](./MUTATIONS.md#cascading).

---

## Bind-parameter caps and chunking

Every driver has a hard limit on how many bind parameters fit in one
statement. The cap is the number you multiply by row count to get the
practical batch size.

| Dialect              | Cap                                  | Source                                        |
|----------------------|--------------------------------------|-----------------------------------------------|
| Postgres             | 65,535 placeholders per statement    | wire-protocol short for parameter count       |
| MySQL                | `max_allowed_packet` (default 64 MB) | server config — bytes, not parameters         |
| SQLite               | 32,766 (default since 3.32)          | `SQLITE_MAX_VARIABLE_NUMBER` compile-time     |
| DuckDB               | ~65,535                              | driver parameter array                         |
| MSSQL                | 2,100 parameters                     | T-SQL parser hard limit                       |
| Mongo                | 16 MB BSON per command               | wire-protocol document size cap               |

So for a row with 20 columns:

| Dialect              | Theoretical max rows / `createMany` | Practical guidance       |
|----------------------|-------------------------------------|--------------------------|
| Postgres             | 65,535 / 20 = 3,276                 | 1,000 – 3,000             |
| MySQL                | bytes-bound — 5,000-ish               | 1,000 – 5,000             |
| SQLite               | 32,766 / 20 = 1,638                 | 1,000                    |
| DuckDB               | ~3,200                              | 1,000 – 3,000             |
| MSSQL                | 2,100 / 20 = 105                    | 100                      |
| Mongo                | bytes-bound — thousands              | pass any size; driver splits |

These are the numbers that fit in **one statement**. Above them, you
chunk on the application side. Forge does not chunk for you — every
`createMany` becomes exactly one `INSERT INTO … VALUES (…),(…),…`. The
deliberate non-chunking is so the caller controls transaction
boundaries: a 100k-row import split into 100 chunks of 1,000 can sit
inside one `$transaction` (atomic) or 100 separate transactions
(resumable), and forge does not decide for you.

The canonical chunk loop:

```ts
async function bulkInsert(rows: Row[]) {
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

On MSSQL drop `CHUNK` to 100 (the 2,100-parameter ceiling bites at ~20
columns). On Mongo, pass the whole array — the driver pipelines.

For sizing in the other direction — how big a chunk gets you most of
the throughput without paying for a wider parser — see
[Throughput vs per-row latency](#throughput-vs-per-row-latency).

---

## `skipDuplicates` per dialect

Forge's `skipDuplicates: true` flag turns "conflict → throw" into
"conflict → skip and count what landed". The compiled output is
uniform on the SQL side — `ON CONFLICT DO NOTHING` — because forge
reuses the Postgres compiler for SQLite / DuckDB / MySQL / MSSQL and
all four target dialects accept the syntax:

| Adapter   | Emitted clause                                | Notes                                  |
|-----------|-----------------------------------------------|----------------------------------------|
| postgres  | `INSERT … VALUES … ON CONFLICT DO NOTHING`    | native since 9.5                        |
| mysql     | `INSERT … VALUES … ON CONFLICT DO NOTHING`    | MySQL 8.0.19+ / MariaDB 10.5.6+; falls back to a parser error on older servers |
| sqlite    | `INSERT … VALUES … ON CONFLICT DO NOTHING`    | requires 3.24+                          |
| duckdb    | `INSERT … VALUES … ON CONFLICT DO NOTHING`    | DuckDB 0.8+ (PG-compatible)             |
| mssql     | (flag ignored — `INSERT INTO … VALUES …`)     | T-SQL has no equivalent; collisions throw |
| mongo     | `insertMany([…], { ordered: false })` + filter `E11000 duplicate key` from `writeErrors` | partial success returns the count of inserted docs |

Source: `src/adapters/postgres/compile-from-ir.ts` line 529
(`node.skipDuplicates ? ' ON CONFLICT DO NOTHING' : ''`), and
`src/adapters/mongo/compile-from-ir.ts` line 263 (`ordered:
!node.skipDuplicates`), with the duplicate-error filter at
`src/adapters/mongo/execute.ts` line 301.

If you are on a MySQL older than 8.0.19, the `ON CONFLICT DO NOTHING`
clause will fail to parse. Two options: upgrade, or wrap the batch in
a try/catch on duplicate-key errors. Forge does not emit the older
`INSERT IGNORE` syntax, by design — `IGNORE` swallows every error
class (truncation, conversion, missing default) not just duplicate-key,
and the resulting `count` becomes hard to reason about.

MSSQL does not have a single-statement counterpart. If you need
collision-tolerant bulk on MSSQL, two paths:

* Loop `upsert` per row inside a `$transaction` (now lands as `MERGE`
  per row since 2.5.0 — see [MUTATIONS.md — upsert](./MUTATIONS.md#upsert)).
* Stage the rows into a temp table with `BULK INSERT`, then `MERGE` the
  temp table into the real one with `WHEN NOT MATCHED THEN INSERT`.

The Mongo path deserves a closer look. `ordered: false` tells the
driver to continue past write errors instead of stopping at the first
one; `writeErrors` then contains an entry per failed doc, and forge
filters out the `code: 11000` (duplicate key) errors when returning
the count. Any other error class — schema validation, BSON size
overflow — rethrows.

```ts
// 100 docs, 10 of which collide on a unique index
const { count } = await db.event.createMany({
  data: rows,
  skipDuplicates: true,
});
// count === 90; the 10 collisions silently dropped
```

---

## `RETURNING` after a batch

What you can read back differs by dialect, and the difference shapes
how you plan the round-trips.

| Verb / dialect | postgres | mysql | sqlite (3.35+) | duckdb | mssql | mongo                |
|----------------|----------|-------|----------------|--------|-------|----------------------|
| `createMany`   | rows     | count | rows           | rows   | count | inserted ids + count |
| `updateMany`   | count    | count | count          | count  | count | count                |
| `deleteMany`   | count    | count | count          | count  | count | count                |

On Postgres / SQLite 3.35+ / DuckDB the `createMany` emit includes
`RETURNING *`, so the rows come back inline. On MySQL / MSSQL there
is no batch `RETURNING` — the wrapper returns only `{ count }`. If
you need the rows after a MySQL / MSSQL batch insert and you cannot
re-`SELECT` by some natural key, your options shrink to:

1. **Pre-generate the IDs client-side.** Forge already does this for
   `f.id()` columns — every row that omits the id key gets a ULID
   stamped before the insert leaves the process. The IDs are visible
   on the input array. See [MUTATIONS.md — ID generation
   timing](./MUTATIONS.md#id-generation-timing).
2. **Insert in a transaction, then re-SELECT.** Inside one
   `$transaction`, do the `createMany` and a `findMany` keyed by the
   generated IDs — atomic relative to other writers.
3. **Loop `create` per row.** N round-trips, N rows back. Only
   sensible at very small N.

The `updateMany` / `deleteMany` rows-back gap is universal — no
adapter returns the affected rows. Workarounds: `$transaction([
findMany, updateMany ])`, or a `RETURNING *` raw query on Postgres
specifically (``db.$queryRaw`UPDATE … RETURNING *```).

The `select` and `include` keys are not honoured on `createMany` —
the verb returns `{ count }` even on dialects that support
`RETURNING`. To get a shaped row back from a batch, use single-row
`create` calls in a transaction or drop to `$queryRaw`.

---

## Throughput vs per-row latency

The three shapes for writing N rows, in order of throughput, with the
trade-offs.

| Shape                                | Round-trips | Statements parsed | Commits | Memory peak |
|--------------------------------------|-------------|--------------------|---------|-------------|
| `createMany({ data: N rows })`       | 1           | 1                  | 1       | N rows       |
| `$transaction([N creates])`          | 1           | N                  | 1       | N rows       |
| N separate `create` calls            | N           | N                  | N       | 1 row        |

Rough numbers, single client on a local Postgres, 200-byte rows
(reproduced from MUTATIONS.md):

| Shape                              | Rows / second |
|------------------------------------|---------------|
| `createMany({ data: 10_000 rows })`| ~150,000      |
| `$transaction([10_000 creates])`   | ~25,000       |
| 10,000 separate `create` calls     | ~3,000        |

The shape of the difference is the same on every adapter. Exact
numbers shift with network latency (RTT pads the per-round-trip
costs), row width (parser parses each tuple), and index count on the
target table (commits include WAL fsync per index update).

What this means for chunk sizing:

* **Local Postgres / SQLite / DuckDB** — the wire is fast. Chunks of
  500-1,000 already saturate the parser; going to 10,000 buys
  diminishing throughput at the cost of memory and a longer
  failure-rollback window.
* **Remote Postgres / MySQL across the public internet** — RTT
  dominates. Larger chunks (5,000+) amortise the round-trip; the
  bind-parameter cap becomes the real ceiling.
* **MSSQL** — the 2,100-parameter cap forces chunks of ~100 at
  typical row widths, so the round-trip overhead is always paid. The
  win from batching is smaller; consider the native bulk-copy path
  (`bcp` / Tedious `bulkLoad`) once volume exceeds ~50k rows.

Below ~100 rows, the difference between `createMany` and a loop of
`create` is invisible. The per-row latency of `create` is one
round-trip plus per-statement parser cost; that's already in the low
millisecond range. The batch win only starts to matter at hundreds
to thousands of rows.

---

## Failure semantics

The atomicity guarantee on `createMany` differs across SQL and
NoSQL, and changes again when `skipDuplicates` is in play.

### SQL — single statement, atomic

`INSERT INTO … VALUES (…),(…),(…)` is one statement. Either all rows
commit, or none do — the database treats it as one logical write.
A constraint violation on row 47 of a 1,000-row batch rolls back
rows 1-46 along with everything from row 48 onward.

The atomicity is statement-level, not transaction-level. If the
`createMany` is the only statement in its session, a successful
return means all N rows are visible to other readers. If it is
inside a wider `$transaction`, visibility waits for `COMMIT` like
any other write.

With `skipDuplicates: true`, the duplicate-key errors are not
errors — `ON CONFLICT DO NOTHING` succeeds and the conflicting
rows are silently dropped. The returned `count` is the actual
inserted rowcount, not the input array length. Non-duplicate
errors (CHECK violations, foreign-key failures, type-coercion
problems) still throw and roll back the whole statement.

### Postgres — `count` reflects skipped rows

Postgres reports `command-status` as `INSERT 0 N` where `N` is the
inserted count. Forge reads `result.rowCount` — which after a
`DO NOTHING` is exactly the inserted-not-skipped count. So:

```ts
const { count } = await db.event.createMany({
  data: rows,                       // length 1000, 200 duplicates
  skipDuplicates: true,
});
// count === 800
```

### MySQL — `affectedRows` vs duplicates

If you are on MySQL 8.0.19+ and the `ON CONFLICT DO NOTHING`
clause parses, `affectedRows` returns the inserted count. On
older MySQL where the clause errors out, the entire batch fails
with a parse error before any row inserts.

### SQLite — `changes()`

After `ON CONFLICT DO NOTHING`, SQLite's `changes()` returns the
number of rows actually written. Same model as Postgres.

### MSSQL — collisions throw

T-SQL has no native `DO NOTHING`. Forge's `createMany` on MSSQL
ignores `skipDuplicates: true` (the flag is accepted for API
parity but does nothing). A duplicate-key violation rolls back
the entire `INSERT` and rethrows. If you need conflict tolerance
on MSSQL, loop `upsert` per row inside a `$transaction`, or
stage-and-MERGE through a temp table.

### Mongo — ordered vs unordered

Mongo's `insertMany` takes an `ordered` option that controls how
the driver responds to mid-batch errors.

| `ordered`        | Behaviour                                                                    |
|------------------|------------------------------------------------------------------------------|
| `true` (default) | Stop at the first failure. Rows before it inserted; rows after it skipped.   |
| `false`          | Continue past failures. Collect errors in `writeErrors`. Insert as many as possible. |

Forge sets `ordered: !node.skipDuplicates` — so the default
`createMany` runs ordered (and throws on the first failure),
and `skipDuplicates: true` runs unordered (and silently drops
duplicates). For mixed batches where you want unordered insert
but still want to surface non-duplicate errors, drop to the
driver:

```ts
const coll = db.$client.db().collection('events');
try {
  await coll.insertMany(docs, { ordered: false });
} catch (err) {
  const real = err.writeErrors.filter((e) => e.code !== 11000);
  if (real.length) throw new Error(`unexpected: ${real.length} failures`);
}
```

The `ordered: false` path also runs the inserts in parallel batches
on the wire, so it is faster than ordered even when no errors hit.

---

## Transactions wrapping a batch

A `createMany` is one statement; wrapping it in a transaction adds
zero new isolation but does change two things:

* **Commit boundary** — without an explicit transaction, the
  statement auto-commits when it returns. Inside a `$transaction`,
  the commit waits for the outer block to resolve, and any earlier
  failure rolls the batch back.
* **Visibility to other writers** — rows from an auto-committed
  batch are visible immediately. Rows from a batch inside a
  transaction are only visible after the outer commit.

The pattern that matters most: **one transaction wrapping many
chunks**.

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

This buys all-or-nothing semantics across a 1M-row import — if
chunk 743 fails, the previous 742 chunks roll back too. The cost
is that the transaction stays open for the entire ingest, which
on Postgres delays `VACUUM`, on MySQL grows the InnoDB history
list, and on SQLite holds the writer lock against any concurrent
writer. See [TRANSACTIONS.md — Long-running
transactions](./TRANSACTIONS.md#long-running-transactions).

The opposite pattern — **one transaction per chunk** — accepts
partial progress on failure but releases each chunk's locks
immediately:

```ts
async function resumableIngest(rows: Row[]) {
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.$transaction(async (tx) => {
      await tx.event.createMany({
        data: rows.slice(i, i + CHUNK),
        skipDuplicates: true,
      });
    });
  }
}
```

If chunk 743 fails, chunks 0-742 are committed. The caller can
re-run with `skipDuplicates: true` and the conflict-skip dedupes
the already-inserted chunks on the retry. The trade-off is N
COMMITs instead of one — more WAL flush, more network round-trips
on remote databases.

Pick based on resumability: long imports across millions of rows
generally want per-chunk transactions plus idempotent input.

---

## Memory profile and streaming

A `createMany({ data: N rows })` holds all N rows resident in
process memory plus the driver's prepared-statement buffer. At
200 bytes per row that is 2 MB for 10k rows, 200 MB for 1M rows.
The 1M case starts to thrash the V8 heap.

Two patterns avoid that:

### Chunk from an array (eager source)

The standard chunked-import loop above already bounds resident
memory at `CHUNK * row_size` — the input array is held by the
caller, but each `slice(i, i + CHUNK)` is a view that the
GC reclaims after the chunk inserts.

If the input array itself is the problem (1M rows pre-loaded into
JS), null out the consumed prefix after each chunk to let the GC
shrink the array:

```ts
for (let i = 0; i < rows.length; i += CHUNK) {
  await tx.event.createMany({ data: rows.slice(i, i + CHUNK) });
  for (let k = i; k < i + CHUNK && k < rows.length; k++) rows[k] = null as any;
}
```

This is rarely needed below a few hundred MB.

### Stream from a producer (lazy source)

When the rows arrive from a file, an HTTP body, a database
cursor, or any other producer, push them into a fixed-size
buffer and flush at every `CHUNK`:

```ts
async function* parseNDJSON(path: string): AsyncIterable<Row> {
  const stream = fs.createReadStream(path).pipe(split2());
  for await (const line of stream) {
    if (line) yield JSON.parse(line);
  }
}

async function streamingIngest(source: AsyncIterable<Row>) {
  const CHUNK = 1000;
  const buffer: Row[] = [];
  await db.$transaction(async (tx) => {
    for await (const row of source) {
      buffer.push(row);
      if (buffer.length >= CHUNK) {
        await tx.event.createMany({ data: buffer, skipDuplicates: true });
        buffer.length = 0;
      }
    }
    if (buffer.length) {
      await tx.event.createMany({ data: buffer, skipDuplicates: true });
    }
  });
}
```

Resident memory peaks at `CHUNK * row_size` regardless of how many
rows the source produces — a 100M-row file ingests with the same
heap footprint as a 100k-row file.

This pairs naturally with `findManyStream` on the read side — see
[STREAMING.md](./STREAMING.md) — when the producer is itself a
forge query.

---

## `updateMany` is uniform — per-row diff is raw SQL

`updateMany`'s `data` shape applies to every row matched by `where`.
There is no per-row variant inside one call. This is a deliberate
constraint: the SQL emit is one `UPDATE … SET col = ? WHERE …` with
one row of bound parameters, so the same value goes into every
matched row.

```ts
// Every active session gets last_seen = now()
await db.session.updateMany({
  where: { active: true },
  data:  { last_seen: new Date() },
});

// Every product in 'electronics' gets price *= 1.1
await db.product.updateMany({
  where: { category: 'electronics' },
  data:  { price: { multiply: 1.1 } },
});
```

The atomic-op variants (`increment`, `decrement`, `multiply`,
`divide`) compose into the same uniform shape — every row gets the
same delta. The per-row computed update — "set price = price *
tax_rate where tax_rate is per-row" — needs a raw `UPDATE … FROM`
join. See [Per-row diff with `CASE WHEN`](#per-row-diff-with-case-when)
for the SQL pattern.

For the **same-target-many-rows** case (one row's value applied to
N rows by filter), `updateMany` is one statement and runs at the
database's row-update speed — comfortably tens of thousands of rows
per second on a hot index.

---

## Per-row diff with `CASE WHEN`

When N rows need N different updates in one round-trip, the SQL
shape is `UPDATE … SET col = CASE id WHEN ? THEN ? WHEN ? THEN ? …
END WHERE id IN (…)`. Forge does not emit this from `updateMany` —
the data shape would have to encode per-row values, breaking the
uniform-SET contract. Drop to `$executeRaw` instead:

```ts
const updates = [
  { id: 'p1', price: 9.99 },
  { id: 'p2', price: 14.50 },
  { id: 'p3', price: 7.25 },
];

const ids = updates.map((u) => u.id);
const cases = updates.map((u) => sql`WHEN ${u.id} THEN ${u.price}`);

await db.$executeRaw`
  UPDATE products
  SET price = CASE id
    ${sql.join(cases, sql` `)}
  END
  WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
`;
```

The trade-offs vs N separate `update` calls:

* One round-trip vs N. The `CASE WHEN` form wins when N exceeds
  a few dozen and the network has any latency.
* Bind-parameter count is `2N + N = 3N`. The same per-dialect caps
  apply — at 200 rows that is 600 placeholders, fine on Postgres,
  fine on SQLite, breaks MSSQL.
* Statement parse cost grows linearly in N. Above a few thousand
  rows the parser becomes the bottleneck.

The Postgres-specific shape that scales further uses `UPDATE …
FROM` with a `VALUES` source — fewer placeholders per row, no
`CASE`:

```ts
await db.$executeRaw`
  UPDATE products SET price = v.price
  FROM (VALUES ${sql.join(
    updates.map((u) => sql`(${u.id}, ${u.price}::numeric)`),
    sql`, `,
  )}) AS v(id, price)
  WHERE products.id = v.id
`;
```

Postgres and DuckDB accept this. MySQL needs `UPDATE … JOIN
(SELECT … UNION ALL SELECT …)` instead. MSSQL accepts `UPDATE …
FROM` similarly but stays bound by the 2,100-parameter cap.

See [RAW-SQL.md](./RAW-SQL.md) for the full `$executeRaw`
surface, the `sql` tagged-template helpers, and the parameter
safety contract.

---

## Mongo `bulkWrite`

When the operations in a batch are not all the same verb — a mix of
inserts, updates, deletes, and upserts — Mongo's `bulkWrite` is the
single-round-trip path. Forge does not wrap it; reach into the
driver via `db.$client`:

```ts
const coll = db.$client.db().collection('events');

await coll.bulkWrite([
  { insertOne: { document: { _id: 'e1', kind: 'click', at: new Date() } } },
  { updateOne: {
      filter: { _id: 'e2' },
      update: { $set: { kind: 'view' } },
      upsert: true,
  } },
  { deleteOne: { filter: { _id: 'e3' } } },
], { ordered: false });
```

The `ordered` semantics match `insertMany`:

* `ordered: true` — stop at the first failure. Earlier ops
  committed, later ops skipped.
* `ordered: false` — continue past failures. Run independent ops
  in parallel batches; surface all errors in `writeErrors`.

For pure-upsert batches, `bulkWrite` with all-`updateOne` and
`upsert: true` is the Mongo equivalent of an `upsertMany` — one
round-trip, atomic per op (a replica-set session can wrap the
whole batch in a single multi-doc transaction).

The forge `_id` generation rule still applies: `f.id()` columns get
the ULID stamped client-side before the call leaves. For raw
driver calls, you fill `_id` yourself.

For the higher-level Mongo surface — sessions, change streams,
adapter-specific gotchas — see [MONGO.md](./MONGO.md).

---

## Beyond `createMany` — native bulk loaders

`createMany` saturates around ~150,000 rows/s on local Postgres
with a moderate row width and a small number of indexes. Sustained
ingest above that calls for the dialect's native bulk path, which
bypasses the prepared-statement protocol and the typed model
wrapper:

* **Postgres `COPY FROM STDIN`** — the canonical bulk path. Use
  `pg-copy-streams` against the underlying `pg.Pool` exposed by
  `db.$raw().connection`. Streaming-friendly: pipe a CSV / NDJSON
  stream straight into the COPY socket. Typical throughput: 500k-1M
  rows/s on a single client.
* **MySQL `LOAD DATA LOCAL INFILE`** — stream a tempfile through
  the wire. Requires `local_infile=ON` on the server. The mysql2
  driver supports it via the `infileStreamFactory` option.
* **MSSQL `BULK INSERT` / `bcp`** — `BULK INSERT` reads from a
  server-side file path; for client-side ingest use the Tedious
  driver's `bulkLoad` API, which speaks the TDS bulk-copy protocol
  directly. Typical throughput on `bulkLoad`: ~200k rows/s.
* **DuckDB `COPY FROM`** — the canonical analytical-load path.
  Reads CSV, Parquet, or Arrow directly. Drops `INSERT` round-trips
  entirely for analytical ingest.
* **SQLite — single `$transaction` already close to ceiling** — a
  tight loop of `createMany` inside one transaction is already
  near disk-write speed. The remaining tuning is PRAGMA: `journal_mode
  = WAL` and `synchronous = NORMAL`. See [SQLITE.md](./SQLITE.md).
* **Mongo — `insertMany({ ordered: false })`** — already the bulk
  path. The driver pipelines op-msg writes over the same connection.

These paths give up the type-check on the way in (forge's coercion
layer is bypassed) in exchange for 5-10x throughput. Use them when
the ingest pipeline is well-validated upstream and the throughput
matters more than the row-by-row safety net.

For the bridge from forge to these native paths, see
[RAW-SQL.md](./RAW-SQL.md) (for `$executeRaw` and the underlying
driver connection) and [SEED.md](./SEED.md) (which walks through
when to switch).

---

## Worked examples

Three problems that come up regularly.

### (a) 100,000-row CSV import

Stream the CSV, chunk into batches of 1,000, one transaction per
chunk for resumability, `skipDuplicates` so retries converge:

```ts
import fs from 'node:fs';
import { parse } from 'csv-parse';

async function importCSV(path: string) {
  const CHUNK = 1000;
  const stream = fs.createReadStream(path).pipe(parse({ columns: true }));
  let buffer: Row[] = [];
  let inserted = 0;
  let chunks = 0;

  const flush = async () => {
    if (!buffer.length) return;
    await db.$transaction(async (tx) => {
      const { count } = await tx.event.createMany({
        data: buffer,
        skipDuplicates: true,
      });
      inserted += count;
    });
    chunks++;
    if (chunks % 100 === 0) console.log(`import: ${inserted} rows`);
    buffer = [];
  };

  for await (const row of stream) {
    buffer.push(row as Row);
    if (buffer.length >= CHUNK) await flush();
  }
  await flush();

  return { inserted };
}
```

Resident memory: ~1,000 rows × row size. Time on a local Postgres
for 100k rows: ~1.5 seconds. The per-chunk transaction means a mid-
import crash leaves the inserted-so-far rows committed; a retry
with `skipDuplicates: true` resumes from where it stopped because
the duplicates skip.

If atomicity matters more than resumability, move the
`$transaction` outside the loop — one transaction, the whole
import, all-or-nothing.

### (b) Bulk soft-delete

Mark every archived order older than the retention window as
soft-deleted, in one statement:

```ts
const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

const { count } = await db.order.softDeleteMany({
  where: { archived: true, created_at: { lt: cutoff } },
});

log.info('archived', { count });
```

`softDeleteMany` compiles to an `UPDATE … SET deleted_at = now()
WHERE …` — one statement, rowcount-only return. Reads in the rest
of the app filter `deleted_at IS NULL` by default. To hard-delete
the same set later (after the soft-delete-retention window has
also passed), use `deleteMany` with the same filter plus
`deleted_at: { lt: hardCutoff }`. See
[SOFT-DELETE.md](./SOFT-DELETE.md) for the full lifecycle.

### (c) Bulk price update across products

Raise every electronics-category price by 10%, server-side:

```ts
await db.product.updateMany({
  where: { category: 'electronics' },
  data:  { price: { multiply: 1.1 } },
});
```

One statement, no application round-trip per row, no stale-read
window. The arithmetic happens inside the row lock the database
takes for the update — concurrent reads see either the old price
or the new price, never an in-between state.

When the update is **per-row** (each product has its own tax
rate), `updateMany` cannot express it. Drop to `$executeRaw` with
the `UPDATE … FROM (VALUES …)` pattern from
[Per-row diff with `CASE WHEN`](#per-row-diff-with-case-when), or
loop `update` per row inside a `$transaction` if N is small.

---

## See also

* [MUTATIONS.md](./MUTATIONS.md) — the verb reference: per-row
  semantics, atomic ops, nested writes, returning shape.
* [RAW-SQL.md](./RAW-SQL.md) — `$executeRaw`, `$queryRaw`, the
  `sql` tagged-template helpers, the per-row diff pattern.
* [TRANSACTIONS.md](./TRANSACTIONS.md) — `$transaction`,
  isolation levels, long-running-transaction warnings.
* [STREAMING.md](./STREAMING.md) — `findManyStream`, AsyncIterable
  reads, backpressure, the producer side of streaming ingest.
* [SEED.md](./SEED.md) — repeatable seeds, idempotency, chunk
  guidance per dialect, switching to native bulk loaders.
* [MONGO.md](./MONGO.md) — `bulkWrite`, `insertMany` ordered vs
  unordered, sessions and transactions, change streams.
* [SOFT-DELETE.md](./SOFT-DELETE.md) — `softDeleteMany`,
  `restoreMany`, the `deleted_at` lifecycle.
