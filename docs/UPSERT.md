# Upsert

`Model.upsert({ where, create, update })` is the atomic insert-or-update primitive. This page documents what forge-orm emits to each dialect — `ON CONFLICT` for Postgres/SQLite/DuckDB, `ON DUPLICATE KEY UPDATE` for MySQL, `MERGE` for MSSQL, `findOneAndUpdate` with `upsert: true` for Mongo — plus race semantics, partial updates, batched upserts, and the patterns that compose with idempotency keys.

The [`upsert`](./MUTATIONS.md#upsert) section in `docs/MUTATIONS.md` is the
short-form reference. This page is the deep dive — the conflict-target
resolution, the per-dialect `RETURNING` story, the `DO NOTHING` mapping,
the batched `upsertMany` shape, and the pitfalls that come up when a unique
constraint is not actually unique.

Everything below assumes 2.5.x. MSSQL `MERGE` shipped in 2.5.0; prior
versions threw `NotImplemented` on the MSSQL upsert path.

## Contents

* [What upsert is](#what-upsert-is)
* [The forge API](#the-forge-api)
* [Conflict target — how forge picks it](#conflict-target--how-forge-picks-it)
* [Per-dialect emit](#per-dialect-emit)
  * [Postgres](#postgres)
  * [MySQL](#mysql)
  * [SQLite](#sqlite)
  * [DuckDB](#duckdb)
  * [MSSQL](#mssql)
  * [Mongo](#mongo)
* [Multiple conflict targets](#multiple-conflict-targets)
* [`DO NOTHING` upsert — insert if absent](#do-nothing-upsert--insert-if-absent)
* [Race-free semantics](#race-free-semantics)
* [`EXCLUDED` values and what forge composes](#excluded-values-and-what-forge-composes)
* [`RETURNING` and the upserted row](#returning-and-the-upserted-row)
* [Partial-update upsert](#partial-update-upsert)
* [Atomic ops in the update branch](#atomic-ops-in-the-update-branch)
* [`upsertMany` — batched upserts](#upsertmany--batched-upserts)
* [Common pitfalls](#common-pitfalls)
* [Idempotency interaction](#idempotency-interaction)
* [Repo pattern — atomic upsert is mandatory](#repo-pattern--atomic-upsert-is-mandatory)
* [Worked examples](#worked-examples)
* [Cross-references](#cross-references)

---

## What upsert is

Insert-or-update, in one atomic step. The row either exists, in which
case the `update` block runs against it, or it does not, in which case
the `create` block inserts it. Whichever path runs, the result is one
row visible to the next read.

The wrong way to express this is two statements — a `findFirst` followed
by either `create` or `update`. That shape has a race window between the
two: two concurrent calls can both see "no row," both take the create
path, and either fail with a unique-violation or — worse, if there is no
unique constraint — produce duplicates. Forge's `upsert` is one
statement on every adapter, which closes the window.

The atomicity guarantee is at the row level. The dialect either evaluates
the conflict check and runs `DO UPDATE`, or it inserts a new row, and no
other writer can observe the table in between. Two concurrent upserts
against the same key produce one row, with one final update applied —
whichever statement reached the engine second.

---

## The forge API

```ts
type UpsertArgs<M> = {
  where:   UniqueWhere<M>;
  create:  Create<M>;
  update:  Update<M>;
  select?: SelectShape<M>;
  include?: IncludeShape<M>;
};

await db.user.upsert({
  where:  { email: 'a@x.co' },
  create: { email: 'a@x.co', name: 'A', plan: 'free' },
  update: { last_seen: new Date() },
});
```

The full signature, with every option:

| Field      | Type                  | Required | Notes                                                  |
|------------|-----------------------|----------|--------------------------------------------------------|
| `where`    | unique selector       | yes      | drives the conflict target — see below                 |
| `create`   | full create input     | yes      | runs when no row matched                               |
| `update`   | partial update input  | yes      | runs when a row matched; pass `{}` for "no-op on hit" |
| `select`   | select shape          | no       | narrows the returned column list                       |
| `include`  | include shape         | no       | issues a follow-up read for relations                  |

`where` is type-narrowed at compile time to the model's unique fields —
`@id`, anything marked `.unique()`, and compound uniques declared via
`uniques: [['provider', 'event_id']]`. Passing a non-unique field is a
TypeScript error. This is the same narrowing as `findUnique` and
`update`, and for the same reason: the conflict target must correspond
to a constraint the database can enforce.

The return value is the row after the operation — either freshly inserted
or freshly updated. Shape it with `select` / `include` the same way you
shape a read.

---

## Conflict target — how forge picks it

The conflict target is what goes between the parentheses in `ON CONFLICT
(…)` (Postgres / SQLite / DuckDB), what `ON DUPLICATE KEY UPDATE`
matches on implicitly (MySQL), the `ON` clause of the `MERGE` (MSSQL),
and the filter passed to `findOneAndUpdate` (Mongo). Forge derives it
from the `where` block.

The rule is: walk the equality-leaves of the `where` tree, collect the
column names, and emit those as the conflict target. Both single-column
and compound shapes are supported:

```ts
// Single column → ON CONFLICT (email)
await db.user.upsert({
  where:  { email: 'a@x.co' },
  create: { email: 'a@x.co', name: 'A' },
  update: { name: 'A2' },
});

// Compound → ON CONFLICT (provider, event_id)
await db.providerEvent.upsert({
  where:  { provider_event_id: { provider: 'stripe', event_id: 'evt_1' } },
  create: { provider: 'stripe', event_id: 'evt_1', payload: body },
  update: {},
});
```

The compound form uses the synthesized key name forge generates from
the `uniques: [['provider', 'event_id']]` declaration — `<col1>_<col2>`
joined with an underscore. See
[`docs/INDEXES.md`](./INDEXES.md#compound-unique-keys) for the naming
rules and how to override them.

### Non-eq filters in `where` are rejected

If the `where` block includes anything other than equality on a unique
column — a range filter, a logical `OR`, a `not` — forge throws at
compile time. There is no sane interpretation of `ON CONFLICT (price)
WHERE price > 10`; the conflict target has to be a constant column
list, and the unique constraint has to exist on those columns. Use
`updateMany` when you actually want a compound filter that decides
which rows to touch.

### The unique constraint has to exist

The columns named in `where` must correspond to one of:

* the primary key,
* a column marked `.unique()`,
* a compound unique declared via `uniques: […]`,
* a `UNIQUE INDEX` declared via `indexes: [{ on: […], unique: true }]`.

On Postgres / SQLite / DuckDB the dialect itself enforces this — the
optimiser refuses `ON CONFLICT (col)` if `col` is not part of a unique
constraint, with a clear error. On MySQL the constraint must exist or
`ON DUPLICATE KEY UPDATE` triggers on the wrong index (silently — this
is the pitfall called out in [Common pitfalls](#common-pitfalls)). On
MSSQL the `MERGE` join would in principle work without uniqueness, but
forge still requires it so the cross-dialect behaviour is consistent.

---

## Per-dialect emit

### Postgres

```sql
INSERT INTO users (id, email, name, plan, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (email) DO UPDATE SET
  last_seen = $7,
  updated_at = $8
RETURNING *;
```

One statement, one round-trip. The conflict check runs under the
constraint's index lock, so concurrent inserts against the same email
are serialised by the engine. The row is returned via `RETURNING *` —
shape it with `select` to narrow the column list, or `include` to add
a follow-up join.

The `EXCLUDED` pseudo-table (see [`EXCLUDED` values](#excluded-values-and-what-forge-composes))
holds the values the `INSERT` would have written. Forge does not expose
`EXCLUDED` directly in the `update` block — every value in `update` is
bound as a parameter — but the mechanism is what lets the engine
"see" both the existing row and the incoming row at the conflict
boundary.

### MySQL

```sql
INSERT INTO `users` (`id`, `email`, `name`, `plan`, `created_at`, `updated_at`)
VALUES (?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  `last_seen` = ?,
  `updated_at` = ?;
SELECT * FROM `users` WHERE `email` = ?;
```

Two statements on the wire — MySQL has no `RETURNING` clause, so forge
follows the `INSERT … ON DUPLICATE KEY UPDATE` with a `SELECT` keyed on
the unique columns from `where`. Both statements run inside the same
connection and the same implicit transaction, so the row read back is
the row the upsert produced.

`ON DUPLICATE KEY UPDATE` matches on any unique index, not a specific
one — there is no parenthesised target list. If the table has more than
one unique index, MySQL picks the first one violated, which can produce
surprising results if two different unique keys are both at risk of
conflict. The mitigation is to keep your conflict targets one-per-table
where possible, or to use `INSERT IGNORE` (the `createMany` +
`skipDuplicates` path) when you genuinely do not care which key
conflicted.

### SQLite

```sql
INSERT INTO "users" ("id", "email", "name", "plan", "created_at", "updated_at")
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT ("email") DO UPDATE SET
  "last_seen" = ?,
  "updated_at" = ?
RETURNING *;
```

`ON CONFLICT` is SQLite 3.24+, `RETURNING` is SQLite 3.35+. Forge's
SQLite adapter targets 3.40+ as a floor (see
[`docs/SQLITE.md`](./SQLITE.md)), so both clauses are always available.
On the browser / WASM build (see [`docs/BROWSER.md`](./BROWSER.md)) the
shipped binary is current — same SQL, same one-trip semantics.

SQLite serialises all writes through a single writer lock, so the
`ON CONFLICT` check is naturally race-free against other upserts.
Concurrent calls queue at the writer lock and apply in order.

### DuckDB

```sql
INSERT INTO "users" ("id", "email", "name", "plan", "created_at", "updated_at")
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT ("email") DO UPDATE SET
  "last_seen" = ?,
  "updated_at" = ?
RETURNING *;
```

Same shape as Postgres / SQLite. DuckDB is single-writer per process,
so concurrency above the row level is constrained by the process model
rather than the statement. The `ON CONFLICT` clause is a recent
addition (DuckDB 0.10+); forge requires 0.10.0 or later, see
[`docs/DUCKDB.md`](./DUCKDB.md).

### MSSQL

```sql
MERGE INTO [users] AS tgt
USING (VALUES (@p1, @p2, @p3, @p4, @p5, @p6)) AS src ([id], [email], [name], [plan], [created_at], [updated_at])
ON tgt.[email] = src.[email]
WHEN MATCHED THEN UPDATE SET
  tgt.[last_seen] = @p7,
  tgt.[updated_at] = @p8
WHEN NOT MATCHED THEN INSERT ([id], [email], [name], [plan], [created_at], [updated_at])
  VALUES (src.[id], src.[email], src.[name], src.[plan], src.[created_at], src.[updated_at])
OUTPUT INSERTED.*;
```

T-SQL has no `ON CONFLICT`. The atomic equivalent is `MERGE`, which
forge emits as a one-statement upsert with a `USING (VALUES …)` row
source as the candidate insert, the `ON` clause as the conflict target,
and `OUTPUT INSERTED.*` to return the row. MSSQL `MERGE` shipped in
forge 2.5.0; prior versions threw `NotImplemented` on this path.

The `MERGE` form supports the same `update` ops as the SQL dialects —
`set`, `increment` (via `COALESCE(tgt.col, 0) + N`), `multiply`, and
`unset` (`= NULL`) — on the `WHEN MATCHED THEN UPDATE` branch. See
[`docs/MSSQL.md`](./MSSQL.md) for the version notes and the known
edge cases around `MERGE` and concurrent writers; SQL Server's `MERGE`
has had a long history of subtle bugs, and the forge emit follows the
[Aaron Bertrand
recipe](https://sqlperformance.com/2020/09/locking/upsert-anti-pattern)
for avoiding the worst of them (table hint, conflict target on indexed
columns, single-row USING).

### Mongo

```js
collection.findOneAndUpdate(
  { email: 'a@x.co' },
  {
    $set:        { last_seen: ISODate('…'), updated_at: ISODate('…') },
    $setOnInsert: { _id: 'u_…', email: 'a@x.co', name: 'A', plan: 'free', created_at: ISODate('…') },
  },
  { upsert: true, returnDocument: 'after' },
);
```

Mongo expresses upsert as `findOneAndUpdate` with `upsert: true`. The
update document is split: fields from the `update` block go into `$set`,
and any field from `create` not already in `update` goes into
`$setOnInsert`. This is what makes "create if missing, otherwise apply
update" expressible in one call.

`$setOnInsert` only applies when the upsert actually inserts; on an
existing-document match it is a no-op. The filter (`{ email: '…' }`) is
also a constraint on the inserted document — Mongo guarantees that the
inserted doc satisfies the filter even if the values were not in the
update payload. For uniqueness, the collection must have a unique index
on the filter columns, or two concurrent upserts both taking the
insert path will both succeed (see [Common pitfalls](#common-pitfalls)).

The `returnDocument: 'after'` option asks Mongo for the post-image of
the document, so forge can return it directly — no follow-up read.

---

## Multiple conflict targets

Postgres and SQLite support `ON CONFLICT ON CONSTRAINT cn` as an
alternative to `ON CONFLICT (col)`, naming the constraint by name
rather than column list. Forge does not expose the named-constraint
form in the public API — the `where` block names columns and forge
derives the target from there — but the underlying dialect supports
it and the `compile.ts` hook is extensible. If your schema has two
overlapping uniques on the same column set (rare, but possible with
partial-filter indexes), drop to `$executeRaw` to disambiguate.

| Adapter   | Multiple uniques                                            |
|-----------|-------------------------------------------------------------|
| postgres  | one target per statement; `ON CONSTRAINT cn` for ambiguity  |
| mysql     | implicit — matches any unique violation                     |
| sqlite    | one target per statement; `ON CONFLICT (cols)` or omit      |
| duckdb    | one target per statement                                    |
| mssql     | `MERGE` `ON` clause is explicit; one statement, one target  |
| mongo     | filter columns implicitly target the matching unique index  |

The MySQL "implicit" behaviour is the dangerous one — see the pitfall
about second unique indexes silently catching the conflict.

---

## `DO NOTHING` upsert — insert if absent

Sometimes the right semantics are "insert if missing, otherwise leave
the existing row alone." That is `upsert` with `update: {}`:

```ts
await db.providerEvent.upsert({
  where:  { provider_event_id: { provider: 'stripe', event_id: 'evt_1' } },
  create: { provider: 'stripe', event_id: 'evt_1', payload: body },
  update: {},
});
```

The empty `update` block compiles to an effective no-op on the matching
branch — Postgres emits `ON CONFLICT (…) DO NOTHING`, MySQL emits
`INSERT IGNORE`-equivalent behaviour via `ON DUPLICATE KEY UPDATE
id = id`, SQLite and DuckDB emit `ON CONFLICT DO NOTHING`, MSSQL elides
the `WHEN MATCHED` branch entirely, Mongo passes only `$setOnInsert`.

| Adapter   | `update: {}` compiles to                                      |
|-----------|---------------------------------------------------------------|
| postgres  | `INSERT … ON CONFLICT (…) DO NOTHING RETURNING *`             |
| mysql     | `INSERT … ON DUPLICATE KEY UPDATE id = id` + `SELECT`         |
| sqlite    | `INSERT … ON CONFLICT (…) DO NOTHING RETURNING *`             |
| duckdb    | `INSERT … ON CONFLICT (…) DO NOTHING RETURNING *`             |
| mssql     | `MERGE … WHEN NOT MATCHED THEN INSERT … OUTPUT INSERTED.*`    |
| mongo     | `findOneAndUpdate({…}, { $setOnInsert: … }, { upsert: true })` |

There is one wart in the Postgres and SQLite cases: `ON CONFLICT DO
NOTHING RETURNING *` returns *no row* when the conflict path is taken,
because the conflict path neither inserts nor updates. Forge handles
this by falling back to a `SELECT` keyed on the unique columns when the
`RETURNING` result is empty — so the API always returns a row, but the
no-conflict path costs an extra query. If you do not care about the
returned row, pass `select: { id: true }` and ignore it; if the upsert
fires frequently and the fallback `SELECT` shows up in your traces,
consider `createMany` with `skipDuplicates` for the bulk-insert version
of the same semantics. See
[`createMany` + `skipDuplicates`](./MUTATIONS.md#createmany--skipduplicates).

The MSSQL `MERGE` form does not have this problem — `OUTPUT INSERTED.*`
fires on both the inserted and (effectively no-op) matched branches —
but the `MERGE` itself is more expensive than a plain `INSERT … ON
CONFLICT`, so the trade is per-dialect.

---

## Race-free semantics

The whole point of `upsert` is that there is no read-then-write window.
A naive shape:

```ts
// WRONG — race window between findFirst and create
const existing = await db.user.findFirst({ where: { email } });
if (existing) {
  await db.user.update({ where: { id: existing.id }, data: { last_seen: new Date() } });
} else {
  await db.user.create({ data: { email, name, last_seen: new Date() } });
}
```

Two concurrent calls with the same `email` both see `null` from
`findFirst`, both take the create branch, one wins, the other throws a
unique-constraint violation. With no unique constraint, both succeed
and you have duplicates.

The right shape:

```ts
await db.user.upsert({
  where:  { email },
  create: { email, name, last_seen: new Date() },
  update: { last_seen: new Date() },
});
```

One statement. The dialect serialises the conflict check at the index
level. The result is one row, with exactly one create-or-update applied
based on which writer reached the engine when.

This guarantee depends on the unique constraint existing — without it,
the dialect cannot serialise the conflict check, and the upsert
degenerates to "insert always" (since there is nothing to conflict
with). See the duplicate-row pitfall below.

The memory entry
[`feedback_forge_atomic_and_db_unique`](../README.md#repo-pattern--atomic-upsert-is-mandatory)
captures this rule as a project-level standard — all dallio repos that
do create-or-update must use atomic `upsert`, not `findFirst` + branch.
See [Repo pattern](#repo-pattern--atomic-upsert-is-mandatory) below.

---

## `EXCLUDED` values and what forge composes

Postgres exposes the candidate insert row in the `DO UPDATE` clause as
the pseudo-table `EXCLUDED`. The idiom is:

```sql
INSERT INTO users (email, name, last_seen) VALUES ('a@x.co', 'A', NOW())
ON CONFLICT (email) DO UPDATE SET
  name      = EXCLUDED.name,
  last_seen = EXCLUDED.last_seen;
```

Read as: "on conflict, set the existing row's columns to whatever the
insert would have written." This is useful when the update body is
mostly "use the new values," and tedious to express by repeating every
parameter twice.

Forge does not auto-rewrite `update` references to `EXCLUDED.*`. The
default emit binds every value in `update` as a fresh parameter, which
is more explicit and lets the update body diverge from the create body
(common when the create stamps a `created_at` and the update stamps an
`updated_at`).

When you want the "use the new values" shortcut, write the update body
to mirror the create body:

```ts
await db.user.upsert({
  where:  { email },
  create: { email, name, plan },
  update: { name, plan },
});
```

Or, for a many-column case where the repetition gets ugly, drop to
`$executeRaw` and use `EXCLUDED.*` directly:

```ts
await db.$executeRaw`
  INSERT INTO users (email, name, plan, last_seen)
  VALUES (${email}, ${name}, ${plan}, ${new Date()})
  ON CONFLICT (email) DO UPDATE SET
    name      = EXCLUDED.name,
    plan      = EXCLUDED.plan,
    last_seen = EXCLUDED.last_seen;
`;
```

The trade is type safety — `$executeRaw` does not narrow against the
schema, and a column rename would not propagate. See
[`docs/RAW-SQL.md`](./RAW-SQL.md) for when the trade is worth it.

MySQL has `VALUES(col)` (deprecated in 8.0) and the newer
`alias.col` syntax for the same idea. SQLite has `excluded.col`, same
as Postgres. MSSQL `MERGE` exposes the candidate as `src.col` in the
`MERGE` body. Mongo has no analogue — the update document is what it
is, and `$setOnInsert` is the closest equivalent.

---

## `RETURNING` and the upserted row

Across dialects, the row returned from an upsert is the row after the
operation — either freshly inserted or freshly updated. The mechanism
differs:

| Adapter   | How forge returns the row                                       |
|-----------|-----------------------------------------------------------------|
| postgres  | `RETURNING *` on the same statement                             |
| mysql     | follow-up `SELECT` keyed on the unique columns from `where`     |
| sqlite    | `RETURNING *` on the same statement (3.35+)                     |
| duckdb    | `RETURNING *` on the same statement                             |
| mssql     | `OUTPUT INSERTED.*` on the `MERGE` statement                    |
| mongo     | `returnDocument: 'after'` on `findOneAndUpdate`                 |

`select` narrows the returned columns on every adapter — `RETURNING
col1, col2` on Postgres / SQLite / DuckDB, `OUTPUT INSERTED.col1` on
MSSQL, the `SELECT` column list on MySQL, a projection on Mongo.

`include` is always a follow-up query (or a Mongo `$lookup`):

```ts
const userWithPosts = await db.user.upsert({
  where:   { email },
  create:  { email, name },
  update:  { last_seen: new Date() },
  include: { posts: true },
});
```

The relation read runs after the upsert commits — there is no way to
`RETURNING` joined rows in any dialect — so it costs an extra round
trip. Use `select` when you only need scalar columns.

### Round-trip cost summary

| Adapter   | Statements | Round-trips | Notes                       |
|-----------|------------|-------------|-----------------------------|
| postgres  | 1          | 1           | `RETURNING *` in-line       |
| mysql     | 2          | 1\*         | `INSERT … ; SELECT` pipelined |
| sqlite    | 1          | 1           | local — round-trip is process-internal |
| duckdb    | 1          | 1           | local                       |
| mssql     | 1          | 1           | `OUTPUT INSERTED.*` in-line |
| mongo     | 1          | 1           | `findOneAndUpdate`          |

\* MySQL pipelines the second `SELECT` on the same connection, so it
is one logical client call — but the wire profile shows two statements.

---

## Partial-update upsert

The `update` block is a partial — only the fields you list are touched
on conflict. Everything else on the row keeps its existing value.
Compare:

```ts
// Full overwrite on conflict — set everything to the new payload.
await db.user.upsert({
  where:  { email },
  create: { email, name: incoming.name, plan: incoming.plan, last_seen: new Date() },
  update: { name: incoming.name, plan: incoming.plan, last_seen: new Date() },
});

// Partial update on conflict — only stamp last_seen, keep the existing name/plan.
await db.user.upsert({
  where:  { email },
  create: { email, name: incoming.name, plan: incoming.plan, last_seen: new Date() },
  update: { last_seen: new Date() },
});

// No-op update — used purely for "ensure row exists, return it."
await db.user.upsert({
  where:  { email },
  create: { email, name: incoming.name, plan: incoming.plan, last_seen: new Date() },
  update: {},
});
```

The third form is the [`DO NOTHING`](#do-nothing-upsert--insert-if-absent)
shape. The first is "upsert as a full replace." The second is the most
common — "create with full payload, but on retry only refresh a
specific field." That second shape is what idempotency-key tables use:
the create stamps the full request, the update is `{}` and just returns
the existing row to short-circuit the work. See
[Idempotency interaction](#idempotency-interaction).

---

## Atomic ops in the update branch

Anything you can pass to `update` you can pass to the upsert's `update`
block — including atomic ops:

```ts
await db.pageViewCounter.upsert({
  where:  { url: '/landing' },
  create: { url: '/landing', count: 1 },
  update: { count: { increment: 1 } },
});
```

Read: "if a counter row exists for `/landing`, bump it; otherwise create
one starting at 1." One statement on every dialect. This is the right
shape for any keyed counter — page views, event counts, per-user
quotas, per-tenant balances. See
[Atomic number ops](./MUTATIONS.md#atomic-number-ops) for the full list.

| Adapter   | `count: { increment: 1 }` in upsert update branch     |
|-----------|-------------------------------------------------------|
| postgres  | `"count" = "count" + 1`                               |
| mysql     | `` `count` = `count` + 1 ``                           |
| sqlite    | `"count" = "count" + 1`                               |
| duckdb    | `"count" = "count" + 1`                               |
| mssql     | `tgt.[count] = COALESCE(tgt.[count], 0) + 1`          |
| mongo     | `{ $inc: { count: 1 } }` (plus `$setOnInsert.count = 0`) |

The MSSQL `COALESCE` wrap handles the case where the existing column
value is `NULL` — `NULL + 1` is `NULL`, which would silently drop the
increment, so forge defends against it. The Mongo path needs both
`$setOnInsert.count = 0` (so the document has a `count` to increment
on the next call) and `$inc.count = 1` on this call; forge composes
both into the update document automatically.

The `multiply`, `divide`, and `decrement` ops compose the same way.
Each is one statement, race-free against concurrent upserts on the
same row.

---

## `upsertMany` — batched upserts

There is no `upsertMany` verb on the public API in 2.5.x. The reasons:

* On Postgres / SQLite / DuckDB, `INSERT … VALUES (…),(…),… ON CONFLICT
  (…) DO UPDATE SET col = EXCLUDED.col` is one statement and handles
  the bulk case correctly — but only if every row's update body is
  identical (because the `SET` clause is shared across all conflict
  hits). The whole point of `update` being per-call is that different
  rows can have different update payloads.
* On MySQL, `INSERT … ON DUPLICATE KEY UPDATE col = VALUES(col)` has
  the same constraint.
* On MSSQL, `MERGE` with a multi-row `USING` is supported but the
  per-row update body has to be expressed via `CASE WHEN src.id = …
  THEN …` chains, which scale poorly.
* On Mongo, `bulkWrite` with `updateOne(filter, update, { upsert: true })`
  per row is the right shape — and that is exactly `Promise.all` of
  per-row upserts inside a session.

So forge provides the building blocks rather than a single `upsertMany`:

### Shape 1 — uniform update body (Postgres / SQLite / DuckDB)

When every row gets the same update body, use `createMany` +
`skipDuplicates` for the "insert if missing, skip otherwise" case
(see [Mutations / createMany +
skipDuplicates](./MUTATIONS.md#createmany--skipduplicates)), or drop
to `$executeRaw` for the full upsert:

```ts
await db.$executeRaw`
  INSERT INTO providers_events (provider, event_id, payload, received_at)
  SELECT * FROM UNNEST(
    ${providers}::text[],
    ${eventIds}::text[],
    ${payloads}::jsonb[],
    ${times}::timestamptz[]
  ) AS t(provider, event_id, payload, received_at)
  ON CONFLICT (provider, event_id) DO UPDATE SET
    received_at = EXCLUDED.received_at;
`;
```

One statement, race-free, scales to tens of thousands of rows. Trade is
type safety, same as any other `$executeRaw`.

### Shape 2 — per-row update bodies (any dialect)

Loop with `upsert` inside one `$transaction`. The per-row update body
can vary freely; the cost is N statements rather than 1, but they
share a single commit:

```ts
await db.$transaction(async (tx) => {
  for (const incoming of rows) {
    await tx.product.upsert({
      where:  { sku: incoming.sku },
      create: { sku: incoming.sku, name: incoming.name, price: incoming.price },
      update: { name: incoming.name, price: incoming.price },
    });
  }
});
```

For sustained throughput above a few thousand upserts per second, see
[Batched throughput](./MUTATIONS.md#batched-throughput) — the same
dialect-native bulk paths (Postgres `COPY`, MySQL `LOAD DATA`, etc.)
apply when the size of the import warrants giving up the wrapper.

### Shape 3 — Mongo `bulkWrite`

On Mongo, the driver-native `bulkWrite` operation batches per-row
upserts into one network call:

```ts
await db.providerEvent.$collection.bulkWrite(
  rows.map((r) => ({
    updateOne: {
      filter: { provider: r.provider, event_id: r.event_id },
      update: {
        $set:         { payload: r.payload, received_at: new Date() },
        $setOnInsert: { _id: r._id },
      },
      upsert: true,
    },
  })),
  { ordered: false },
);
```

`db.<model>.$collection` is the escape hatch to the raw driver, see
[`docs/MONGO.md`](./MONGO.md). The `ordered: false` flag tells Mongo to
continue past per-row errors, which matters when one update violates a
different constraint mid-batch.

---

## Common pitfalls

### No unique constraint, no atomicity

The most common upsert bug: declaring `where: { tenant_id, slug }` for
the conflict target, but never creating the matching `UNIQUE (tenant_id,
slug)` index. The first symptom is duplicate rows under concurrent
upserts — every call sees no existing row, every call takes the create
path, and the table fills with copies.

Forge does its best to catch this at validate / push time — the doctor
(see [`docs/DOCTOR.md`](./DOCTOR.md)) flags upsert-style queries whose
`where` columns are not covered by a unique index, and `forge push`
asks for confirmation before applying. The runtime cannot enforce it,
though — a custom-built schema or a hand-edited migration can leave the
constraint off.

The rule is: every upsert `where` column-set must be DB-enforced unique.
Either declare `.unique()` on the column, `uniques: [['col1', 'col2']]`
on the model, or `indexes: [{ on: […], unique: true }]` if the
constraint needs a partial filter. See
[`docs/INDEXES.md`](./INDEXES.md#unique-indexes-and-partial-filters).

### Composite primary key with a `NULL` part

A composite primary key declared as `@@id([a, b])` rejects rows where
either `a` or `b` is `NULL` — `NULL` is not equal to itself in SQL, so
the `ON CONFLICT (a, b)` check cannot match. Two concurrent upserts
with `a = NULL` both take the create path, and on Postgres / MySQL /
MSSQL the second one fails the primary-key constraint anyway (so you
get a noisy error rather than duplicates) but the call still throws,
which is rarely what you want.

The fix is either:

* mark the columns as `NOT NULL` so the issue cannot arise (the
  default for primary-key columns), or
* use a `UNIQUE INDEX` with `NULLS NOT DISTINCT` (Postgres 15+) — see
  [`docs/POSTGRES.md`](./POSTGRES.md#unique-index-with-nulls-not-distinct)
  for the syntax and the cross-dialect simulation forge provides for
  older versions.

### Second unique index on MySQL silently catches the conflict

MySQL's `ON DUPLICATE KEY UPDATE` matches any unique index, not the
specific one named in `where`. If the table has two unique indexes —
say `UNIQUE (email)` and `UNIQUE (username)` — and the incoming row
collides with the second one, the update branch fires anyway, on the
row that owns the colliding `username`, not the row whose `email` was
asked about.

This is rarely what you want. The mitigations:

* Avoid multiple unique indexes on the same table where you can.
* When you cannot, use `INSERT IGNORE` (the `createMany` +
  `skipDuplicates` path, see
  [Mutations](./MUTATIONS.md#createmany--skipduplicates)) instead of
  `ON DUPLICATE KEY UPDATE` when you do not actually need the update
  branch.
* Or, drop to `$executeRaw` and `SELECT FOR UPDATE` the row up front,
  so the eq-check is explicit rather than constraint-driven.

### `update: {}` and stale `updated_at`

A `DO NOTHING`-shape upsert (`update: {}`) does not update the row at
all — including any `@updatedAt` column forge would normally maintain.
This is the intended behaviour (the row was not updated), but it surprises
people who expect "every upsert call to stamp `updated_at`."

If you want "ensure exists, stamp updated_at on every call," use:

```ts
update: { updated_at: new Date() }
```

If you want strict "no write on conflict," accept that `updated_at` will
reflect the original create time.

### MSSQL `MERGE` and the `HOLDLOCK` hint

The forge MSSQL emit does not include `WITH (HOLDLOCK)` on `MERGE`. The
hint is sometimes recommended to avoid a documented race condition
where two concurrent `MERGE` statements with the same source row can
both decide to insert under read-committed isolation. In practice,
forge's `MERGE` is always against a single-row `VALUES` source and a
unique-indexed `ON` clause, so the dialect's row-level locks on the
unique-index B-tree already serialise the conflict check. If your
schema or your isolation level is unusual enough that this matters,
drop to `$executeRaw` and add the hint. See
[`docs/MSSQL.md`](./MSSQL.md#merge-and-concurrency).

### Mongo without a unique index

Same as the SQL case: if the collection has no unique index on the
filter columns, concurrent upserts with the same filter values both
take the insert path. Mongo's `findOneAndUpdate(filter, update, {
upsert: true })` is atomic relative to a single document, but the
"is there a matching document?" check is not race-free without an
index to serialise it.

Declare the unique index on the model:

```ts
const ProviderEvent = model('provider_events', {
  provider: f.string(),
  event_id: f.string(),
}, {
  uniques: [['provider', 'event_id']],
});
```

The unique constraint becomes a unique index in Mongo, which is what
serialises the conflict check.

---

## Idempotency interaction

The atomic upsert is the idempotency primitive. The minimal shape:

```ts
const RequestLog = model('request_logs', {
  id:          f.id(),
  request_id:  f.string().unique(),
  payload:     f.json(),
  result:      f.json().nullable(),
  status:      f.string().default('pending'),
});

async function handle(req: Request, body: Body) {
  return db.$transaction(async (tx) => {
    const log = await tx.requestLog.upsert({
      where:  { request_id: req.headers['idempotency-key'] },
      create: { request_id: req.headers['idempotency-key'], payload: body },
      update: {},   // no-op on re-arrival
    });
    if (log.status === 'done') return log.result;

    const result = await doWork(tx, body);
    await tx.requestLog.update({
      where: { id: log.id },
      data:  { result, status: 'done' },
    });
    return result;
  });
}
```

The `request_id`'s unique constraint is what makes the upsert race-free.
Two concurrent retries with the same idempotency key cannot both take
the create path — one does the work, the other sees `status: 'done'`
and short-circuits with the cached result.

This is one paragraph of the full picture. See
[`docs/IDEMPOTENCY.md`](./IDEMPOTENCY.md) for:

* the Stripe / Square model (key + body hash for replay safety),
* TTL and pruning of expired keys,
* the cross-dialect race characteristics under each isolation level,
* the BullMQ / job-queue binding,
* the HTTP middleware wrapper,
* webhook receivers and the at-least-once delivery story.

The whole subsystem rests on `Model.upsert` having the semantics this
page describes — atomic, race-free, on every adapter.

---

## Repo pattern — atomic upsert is mandatory

Project-level standard for dallio (and any repo cribbing the patterns):
all create-or-update repos must use atomic `Model.upsert`, never
`findFirst` + branch. The rule is captured in the
[`feedback_forge_atomic_and_db_unique`](../README.md) memory entry; the
short version is:

* If a repo method is "create if missing, otherwise update," use
  `db.<model>.upsert({ where, create, update })`. Do not write
  `findFirst → if/else → create/update`.
* If the doc or PR comment says "unique by X" or "enforced at the app
  layer," translate that into a DB constraint — `.unique()`,
  `uniques: [...]`, or a partial-filter unique index. App-layer
  uniqueness does not survive concurrent writers; the database has to
  enforce it.

The 2.1.0 cleanup pass collapsed 18 dallio repos to atomic `upsert` and
added 21 schema constraints (11 plain uniques + 10 partial-filter
uniques) on the back of this rule. See the
[`project_forge_2_1_cleanup`](../README.md) memory for the sweep
summary.

For new repos, the checklist is:

1. The `where` block of every `upsert` must name unique columns.
2. The columns must be DB-enforced — verify with
   `db.$diff()` (see [`docs/DIFF.md`](./DIFF.md)) that the schema and
   the running DB agree.
3. Add a test that issues two concurrent `upsert`s with the same key
   inside one process and asserts exactly one row exists after.

---

## Worked examples

### (a) Bookmark create-or-update

Per-user bookmarks of a URL — at most one per `(user_id, url)` pair.
Save updates the saved-at timestamp; first save creates the row.

```ts
const Bookmark = model('bookmarks', {
  id:       f.id(),
  user_id:  f.string(),
  url:      f.string(),
  title:    f.string().nullable(),
  saved_at: f.timestamp().default('now()'),
}, {
  uniques: [['user_id', 'url']],
});

async function saveBookmark(userId: string, url: string, title?: string) {
  return db.bookmark.upsert({
    where:  { user_id_url: { user_id: userId, url } },
    create: { user_id: userId, url, title, saved_at: new Date() },
    update: { title, saved_at: new Date() },
  });
}
```

The composite unique `(user_id, url)` is what serialises the conflict
check. Two concurrent saves with the same URL produce one row with the
later `saved_at`. The `title` re-applies on every save, which is the
intended "edit by re-save" UX. Drop `title` from the update block if
the intent is "first title sticks."

### (b) Counter increment with upsert

Page-view counter per URL, with the counter created lazily on first
hit:

```ts
const PageView = model('page_views', {
  url:        f.string(),
  count:      f.int().default(0),
  last_view:  f.timestamp(),
}, {
  uniques: [['url']],
});

async function recordView(url: string) {
  return db.pageView.upsert({
    where:  { url },
    create: { url, count: 1, last_view: new Date() },
    update: { count: { increment: 1 }, last_view: new Date() },
  });
}
```

First call to a new URL creates the row with `count: 1`. Every
subsequent call bumps `count` atomically and updates `last_view`. No
race window — `count` is incremented in-place by the dialect, not
read-then-written in user code. See
[Atomic ops](#atomic-ops-in-the-update-branch) for the per-dialect
compile.

### (c) MERGE for MSSQL — concurrent leaderboard

Per-player high score, where the upsert keeps the higher of the
existing and incoming score:

```ts
const HighScore = model('high_scores', {
  player_id: f.string().unique(),
  score:     f.int(),
  set_at:    f.timestamp(),
});

async function reportScore(playerId: string, score: number) {
  // The conditional "keep the higher" is the update body; the create
  // path always inserts the incoming score.
  return db.highScore.upsert({
    where:  { player_id: playerId },
    create: { player_id: playerId, score, set_at: new Date() },
    update: { score, set_at: new Date() },   // always apply incoming
  });
}
```

On MSSQL this compiles to:

```sql
MERGE INTO [high_scores] AS tgt
USING (VALUES (@p1, @p2, @p3)) AS src ([player_id], [score], [set_at])
ON tgt.[player_id] = src.[player_id]
WHEN MATCHED THEN UPDATE SET
  tgt.[score]  = @p4,
  tgt.[set_at] = @p5
WHEN NOT MATCHED THEN INSERT ([player_id], [score], [set_at])
  VALUES (src.[player_id], src.[score], src.[set_at])
OUTPUT INSERTED.*;
```

To keep only the higher score, the `WHEN MATCHED` would need a `WHERE
src.score > tgt.score` clause — which the public API does not expose
directly (the `update` block is unconditional). When you need
conditional updates inside the `MERGE`, drop to `$executeRaw` or use
the optimistic-write shape instead:

```ts
await db.$transaction(async (tx) => {
  const { count } = await tx.highScore.updateMany({
    where: { player_id: playerId, score: { lt: score } },
    data:  { score, set_at: new Date() },
  });
  if (count === 0) {
    await tx.highScore.upsert({
      where:  { player_id: playerId },
      create: { player_id: playerId, score, set_at: new Date() },
      update: {},   // existing row already has a higher score; leave it
    });
  }
});
```

Two writes worst-case, but the conditional is expressed in the SQL the
optimiser can plan, and the semantics are explicit. See
[Optimistic concurrency](./MUTATIONS.md#optimistic-concurrency).

### (d) Mongo `$setOnInsert` + `$set`

User profile that records `first_seen` (set once, never updated) and
`last_seen` (set on every call):

```ts
const Profile = model('profiles', {
  user_id:    f.string().unique(),
  first_seen: f.timestamp(),
  last_seen:  f.timestamp(),
});

async function touchProfile(userId: string) {
  return db.profile.upsert({
    where:  { user_id: userId },
    create: { user_id: userId, first_seen: new Date(), last_seen: new Date() },
    update: { last_seen: new Date() },
  });
}
```

The Mongo emit splits the create body across `$set` and `$setOnInsert`:

```js
collection.findOneAndUpdate(
  { user_id: 'u_1' },
  {
    $set:         { last_seen: ISODate('…') },
    $setOnInsert: { _id: 'p_…', user_id: 'u_1', first_seen: ISODate('…') },
  },
  { upsert: true, returnDocument: 'after' },
);
```

`first_seen` is in `$setOnInsert` because it appears in `create` but
not `update` — so it is written only on the insert path. `last_seen` is
in `$set` because it appears in `update` — so it is written on every
call. Forge does the split automatically; the dev does not write the
Mongo doc.

On SQL the equivalent is to leave `first_seen` out of the `update`
block — the column keeps its existing value on the update branch — so
the API is the same across adapters. The dialect detail is invisible.

### (e) Bulk upsert from an ingest pipeline

A nightly job ingests vendor records and upserts them by external
key. Vendor records can be hundreds of thousands of rows; per-row
upsert is too slow.

```ts
async function ingest(rows: VendorRow[]) {
  const CHUNK = 1000;
  await db.$transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      // One transaction, N upserts. Faster than N transactions, slower
      // than a single bulk-INSERT … ON CONFLICT.
      for (const r of slice) {
        await tx.vendorRecord.upsert({
          where:  { vendor_id_ext_id: { vendor_id: r.vendor_id, ext_id: r.ext_id } },
          create: { ...r },
          update: { ...r },   // full overwrite on conflict
        });
      }
    }
  });
}
```

For sustained throughput above ~5,000 upserts per second, drop to
`$executeRaw` and a single multi-row `INSERT … ON CONFLICT` per chunk
(see [`upsertMany` shape 1](#upsertmany--batched-upserts)). The
trade-off is type safety vs throughput; the line moves with row width
and index count.

### (f) Audit-log upsert (no-op on duplicate)

An audit-log table that records every webhook delivery and dedups
on `(provider, event_id)`. The webhook can fire twice; we want to
record the first delivery and ignore the second:

```ts
const WebhookEvent = model('webhook_events', {
  id:           f.id(),
  provider:     f.string(),
  event_id:     f.string(),
  received_at:  f.timestamp().default('now()'),
  payload:      f.json(),
  processed:    f.boolean().default(false),
}, {
  uniques: [['provider', 'event_id']],
});

async function recordWebhook(provider: string, eventId: string, payload: unknown) {
  const evt = await db.webhookEvent.upsert({
    where:  { provider_event_id: { provider, event_id: eventId } },
    create: { provider, event_id: eventId, payload },
    update: {},   // duplicate: leave the existing row alone
  });
  if (evt.processed) return;
  await process(evt);
  await db.webhookEvent.update({
    where: { id: evt.id },
    data:  { processed: true },
  });
}
```

The `update: {}` is the `DO NOTHING` shape — the duplicate retry sees
the existing row, observes `processed: true`, and exits without doing
the work twice. The unique constraint on `(provider, event_id)` is
what closes the race window; without it, two concurrent deliveries can
both take the create path and both call `process`. See
[Idempotency interaction](#idempotency-interaction) and
[`docs/IDEMPOTENCY.md`](./IDEMPOTENCY.md).

---

## Cross-references

* [`docs/MUTATIONS.md`](./MUTATIONS.md) — the full write surface, of
  which `upsert` is one verb. The `upsert` section there is the short
  form of this page; everything else there (atomic ops, returning
  shape, batched throughput, mutation events) applies inside upsert
  too.
* [`docs/IDEMPOTENCY.md`](./IDEMPOTENCY.md) — the full idempotency-key
  story. Atomic upsert is the primitive; that page is the wrapper.
* [`docs/INDEXES.md`](./INDEXES.md) — unique indexes, compound
  uniques, partial-filter uniques. Every upsert needs a unique
  constraint to enforce its conflict target; this is where you declare
  them.
* [`docs/MONGO.md`](./MONGO.md) — Mongo specifics including the
  `$setOnInsert` / `$set` split forge composes, plus the
  unique-index-vs-replica-set caveats.
* [`docs/MSSQL.md`](./MSSQL.md) — MSSQL `MERGE` notes, including the
  known race-condition recipe and the version requirement (forge 2.5.0+
  for the `MERGE`-based upsert path).
* [`docs/POSTGRES.md`](./POSTGRES.md) — Postgres `ON CONFLICT`
  specifics including `NULLS NOT DISTINCT` (15+), constraint-name
  targets, and the partial-index conflict-target rules.
* [`docs/SQLITE.md`](./SQLITE.md) — SQLite version floor, `ON CONFLICT`
  / `RETURNING` history, and the writer-lock model.
* [`docs/DUCKDB.md`](./DUCKDB.md) — DuckDB version requirements and
  the single-writer-per-process model.
* [`docs/RAW-SQL.md`](./RAW-SQL.md) — the escape hatch when the
  upsert needs `EXCLUDED.*`, conditional `WHEN MATCHED`, or
  named-constraint conflict targets.
* [`docs/DOCTOR.md`](./DOCTOR.md) — the doctor's check for upsert
  `where` columns being covered by a unique index, plus how to wire
  it into CI.
* [`docs/DIFF.md`](./DIFF.md) — runtime drift detection that catches
  the case where the model declares a unique constraint and the live
  database does not have it.
