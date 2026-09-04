# `db.$explain()` — see the query without running it

The standing complaint about a Prisma-shaped ORM is that you cannot see
what it sends. `.compile.<op>()` has always answered that for one op, but
you had to know the op's name and rebuild the call by hand — which is
exactly the moment most people stop bothering.

```ts
const report = await db.$explain((q) => q.User.findMany({ where: { age: { gt: 40 } } }));
console.log(report.toString());
```

```
User.findMany  →  users  [sqlite]

  SELECT "users"."id", "users"."name", "users"."age" FROM "users" WHERE "users"."age" > ?

  params: 40

  -- with values inlined (for reading, not for running):
  SELECT "users"."id", "users"."name", "users"."age" FROM "users" WHERE "users"."age" > 40
```

Nothing executed. Companion to **[QUERIES.md](./QUERIES.md)** (what the
operators emit) and **[RAW-SQL.md](./RAW-SQL.md)** (running SQL yourself).

## Contents

* [The two callback forms](#the-two-callback-forms)
* [`{ analyze: true }` — the database's own plan](#-analyze-true---the-databases-own-plan)
* [Why forge never emits `EXPLAIN ANALYZE`](#why-forge-never-emits-explain-analyze)
* [The report shape](#the-report-shape)
* [`readable` is for reading](#readable-is-for-reading)
* [What it refuses](#what-it-refuses)
* [Per-dialect support](#per-dialect-support)
* [Worked: finding a missing index](#worked-finding-a-missing-index)
* [`$explain` vs `.compile` vs `$on('query')`](#explain-vs-compile-vs-onquery)

---

## The two callback forms

**Take the capturing db.** Preferred, and the only form that is safe with
an `async` callback:

```ts
await db.$explain((q) => q.User.findMany({ where }));
```

`q` holds no session and reaches no driver. There is no window during
which anything could execute, so `await` inside the callback is fine.

**Take nothing, and close over the real `db`.** More natural to write,
and works — but only while the query is issued *synchronously*:

```ts
await db.$explain(() => db.User.findMany({ where }));
```

The interception is a flag set for the duration of the synchronous call
and cleared before any microtask runs. JavaScript is single-threaded, so
nothing else can slip into that window. But it closes at the first
`await`, and a query issued after one reaches the real driver:

```ts
// ✗ the findMany RUNS
await db.$explain(async () => {
  await somethingElse();
  return db.User.findMany();
});
```

forge detects this — an empty capture from a callback that returned a
promise — and throws saying the query ran for real, rather than handing
back an empty report. It cannot un-run it. Use the `(q) => …` form.

## `{ analyze: true }` — the database's own plan

```ts
const r = await db.$explain((q) => q.User.findMany({ where: { name: 'u7' } }), {
  analyze: true,
});
```

```
  -- plan:
  SCAN users
```

This is the one that needs a connection. `r.analyzed` tells you whether a
plan was actually fetched, and each `query.plan` holds the raw structure
the database returned.

## Why forge never emits `EXPLAIN ANALYZE`

`EXPLAIN` **plans** a statement. `EXPLAIN ANALYZE` **runs** it and reports
what really happened.

On a `SELECT` the difference is accuracy. On `deleteMany` it is your data:

```ts
await db.$explain((q) => q.User.deleteMany({ where: { age: { lt: 100 } } }), {
  analyze: true,
});
// 500 rows before. 500 rows after.
```

An API whose entire promise is "this does not run" must not delete rows
when you pass a flag asking for more detail. So `ANALYZE` is not offered
at all, and this page says why rather than leaving you to find the
distinction in a postmortem. If you want real timings, run the statement
yourself through `$queryRaw` — deliberately, on something you meant to
execute.

## The report shape

```ts
interface ExplainReport {
  dialect: 'postgres' | 'mysql' | 'sqlite' | 'duckdb' | 'mssql' | 'mongo';
  queries: ExplainedQuery[];
  analyzed: boolean;
  toString(): string;
}

interface ExplainedQuery {
  model: string;              // 'User'      — the schema name
  table: string;              // 'users'     — the table/collection
  op: string;                 // 'findMany'
  artifact: CompiledArtifact; // { kind:'sql', sql, params } | { kind:'mongo', … }
  readable?: string;          // SQL with values inlined. Reading only.
  plan?: unknown;             // only with { analyze: true }
}
```

A callback may issue several queries; they are captured in order.

```ts
const r = await db.$explain((q) => {
  q.User.findMany({ where: { age: { gt: 30 } } });
  q.User.count();
});
r.queries.map((x) => x.op);   // ['findMany', 'count']
```

## `readable` is for reading

`readable` is the same statement with its parameters substituted, so it
can be pasted into `psql` or handed to a DBA.

**Do not execute it.** The quoting there serves legibility, not safety —
re-parsing that string is precisely how a parameterised query stops being
one. `artifact.sql` with `artifact.params` is the pair you run.

## What it refuses

Rather than compiling something approximate, `$explain` names the problem:

| | |
|---|---|
| `groupBy`, `aggregate`, `findManyStream` | No single compiled statement — the message says which of the two it is and points at `$on('query')`. |
| A `$`-method on `q` | The capturing db never reaches the driver, so `q.$queryRaw` is refused rather than silently executing. |
| A nested `$explain` | Refused; the capture window is not re-entrant. |
| `analyze` on a Mongo write | Explaining one asks the server to plan a change to your data. Drop `analyze` to see the command. |
| `analyze` on SQL Server | Its plan comes from `SET SHOWPLAN_XML ON`, which must be alone in its batch and changes connection state. forge will not do that behind your back on a pooled connection. |

`findFirstOrThrow` and `findUniqueOrThrow` are **not** refused — they
differ from their plain forms only in what happens to an empty result,
which is after the statement.

## Per-dialect support

| Dialect | SQL + params | `{ analyze: true }` | Emits |
|---|---|---|---|
| Postgres | ✅ | ✅ | `EXPLAIN (FORMAT JSON)` |
| MySQL | ✅ | ✅ | `EXPLAIN FORMAT=JSON` |
| SQLite | ✅ | ✅ | `EXPLAIN QUERY PLAN` |
| DuckDB | ✅ | ✅ | `EXPLAIN` |
| SQL Server | ✅ | ❌ (refused, with the reason) | — |
| Mongo | ✅ (the command bundle) | ✅ reads only | `explain` / `queryPlanner` |
| IndexedDB | ❌ | ❌ | no compiled form — see [BROWSER.md](./BROWSER.md) |

SQLite returns a row per plan step whose `detail` is the sentence you
want; those lines are lifted out for display, and the raw rows stay on
`query.plan`. Postgres and MySQL return structured JSON, left as JSON
because that is what their own tooling reads.

## Worked: finding a missing index

The reason to reach for this at all.

```ts
const r = await db.$explain((q) => q.User.findMany({ where: { name: 'u7' } }), {
  analyze: true,
});
console.log(r.toString());
```

```
  -- plan:
  SCAN users
```

`SCAN` — every row read. Add the index, and the same query:

```ts
const User = model('users', { … }, {
  indexes: [{ fields: { name: 1 } }],
});
```

```
  -- plan:
  SEARCH users USING INDEX users_name (name=?)
```

`forge doctor` catches the declared-but-missing case; this catches the
never-declared one, which nothing else can see because it is a property
of the query rather than of the schema. See
**[INDEXES.md](./INDEXES.md)**.

## `$explain` vs `.compile` vs `$on('query')`

| | needs a DB | runs the query | use it for |
|---|---|---|---|
| `db.$explain(fn)` | no | **no** | reading a query you are about to write |
| `db.$explain(fn, { analyze: true })` | yes | no (plans only) | why it is slow |
| `db.<model>.compile.<op>(args)` | no | no | forwarding one statement to a driver you manage |
| `db.$on('query', …)` | yes | yes — it is a listener | what production actually sent |

`.compile` is the primitive and is not going anywhere; `$explain` is the
one you reach for when you have a call site in front of you rather than
an op name in mind. `$on('query')` is the only one that shows what really
ran, including the ops `$explain` refuses.
