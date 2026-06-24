# Aggregations

`count`, `sum`, `avg`, `min`, `max`, `groupBy`, `having`, `distinct` — the
aggregation surface, what forge emits per dialect (GROUP BY for SQL,
`$group` pipeline for Mongo), nullable handling, decimal precision, and
the patterns for dashboard-shaped queries.

The README chapter [Grouping and aggregates](../README.md#grouping-and-aggregates)
covers the call shape — `groupBy({ by, where, _count, _sum, _avg, _min, _max, having, orderBy })`.
This doc is the companion that goes one layer down: every aggregate's
per-dialect emit, the way `_count` differs from `count`, how `having`
interleaves with `where`, the nullable and precision gotchas that show
up on big tables, and the dashboard-shaped queries that exercise the
whole surface.

If you have not read [QUERIES.md](./QUERIES.md) yet, start there — this
doc assumes you already know `findMany`, `where`, `select`, and
`orderBy`.

## Contents

* [The aggregation surface](#the-aggregation-surface)
* [`count` vs `_count` vs `countDistinct`](#count-vs-_count-vs-countdistinct)
* [`groupBy` keys — single and composite](#groupby-keys--single-and-composite)
* [`having` — filtering aggregates](#having--filtering-aggregates)
* [`_count` / `_sum` / `_avg` / `_min` / `_max` — the bucket shape](#_count--_sum--_avg--_min--_max--the-bucket-shape)
* [Per-dialect emit table](#per-dialect-emit-table)
* [Nullable handling](#nullable-handling)
* [Decimal precision in `_sum` and `_avg`](#decimal-precision-in-_sum-and-_avg)
* [Date/time aggregation](#datetime-aggregation)
* [Aggregating embedded / JSON fields](#aggregating-embedded--json-fields)
* [`where` vs `having` — input filter vs output filter](#where-vs-having--input-filter-vs-output-filter)
* [`ORDER BY` an aggregate result](#order-by-an-aggregate-result)
* [Pagination of aggregated results](#pagination-of-aggregated-results)
* [Window functions vs aggregations](#window-functions-vs-aggregations)
* [Performance — indexing for `GROUP BY`](#performance--indexing-for-group-by)
* [Mongo aggregation pipeline](#mongo-aggregation-pipeline)
* [Four worked dashboards](#four-worked-dashboards)
* [Cross-links](#cross-links)

---

## The aggregation surface

Five entry points, picked by what the caller wants back.

- **`count({ where, distinct? })`** → `number`. "How many rows match."
- **`aggregate({ where, _avg, _sum, _min, _max, _count })`** → one
  `{ _avg, _sum, _min, _max, _count }` payload. "Overall sum / avg /
  min / max across these rows." Equivalent to `groupBy` with `by: []`.
- **`groupBy({ by, _avg, _sum, _min, _max, _count, where, having, orderBy, take, skip })`**
  → array of `{ <by-col>: value, _count?, _sum?, _avg?, _min?, _max? }`.
  "Per-group aggregates."
- **`findMany({ include: { _count: { select: { <relation>: true } } } })`**
  → rows with `_count.<relation>` attached. "Related-row counts per
  parent."
- **`aggregate({ pipeline })`** (Mongo-only) → raw documents from the
  pipeline. Escape hatch into the native `$lookup` / `$facet` /
  `$bucket` surface.

`count` and `groupBy` are the two real workhorses — the rest is sugar
or escape-hatch. All five honour the same `where` operator vocabulary
`findMany` uses (see
[QUERIES.md → where](./QUERIES.md#where-operator-reference-per-dialect))
and the aggregate body runs **after** the `where` filter narrows the
input — see
[`where` vs `having`](#where-vs-having--input-filter-vs-output-filter).

---

## `count` vs `_count` vs `countDistinct`

Three counting shapes, three different SQL forms.

### Top-level `count({ where })` — `COUNT(*)`

```ts
const n = await db.user.count({ where: { active: true } });
```

Emits `SELECT COUNT(*) FROM "user" WHERE "active" = $1` on PG /
SQLite / DuckDB (with the dialect's quoting and placeholders),
`COUNT_BIG(*)` on MSSQL, and `coll.countDocuments({ active: true })`
on Mongo. `COUNT(*)` includes rows where every column is NULL. The PG
driver returns the count as a string (`bigint`) and forge coerces
through `Number()` at hydration — safe up to 2^53. For tables that
approach that magnitude, switch to a `$queryRaw` `SELECT COUNT(*)::text`
and parse with `BigInt` yourself.

### `count({ distinct: [col] })` — `COUNT(DISTINCT col)`

```ts
await db.user.count({ distinct: ['email_domain'] });
// → SELECT COUNT(DISTINCT "email_domain") FROM "user"
// Mongo: [{ $group: { _id: '$email_domain' } }, { $count: 'count' }]
```

`COUNT(DISTINCT col)` **skips NULL values** on every SQL dialect —
that's the SQL standard. So this over 1,000 rows where 50 have NULL
`email_domain` returns the number of distinct non-null domains. To
count NULL as its own bucket, use `coalesce("email_domain", '')`
through `$queryRaw`.

### Multi-column distinct

```ts
await db.member.count({ distinct: ['org_id', 'role'] });
// → SELECT COUNT(*) FROM (SELECT 1 FROM "member" GROUP BY "org_id","role") s
// Mongo: [{ $group: { _id: { org_id: '$org_id', role: '$role' } } }, { $count: 'count' }]
```

PG also supports `SELECT COUNT(DISTINCT ("org_id","role"))` natively
but forge does not emit the row-value form because MySQL and SQLite
don't. The subquery-then-count form is portable everywhere.

### `_count` on a relation — per-row cardinality

`_count` is the only synthetic-field surface forge exposes on a read.
It drops a cardinality alongside each row.

```ts
await db.user.findMany({
  include: { _count: { select: { posts: true, comments: true } } },
});
// → user[0]._count = { posts: 5, comments: 12 }
```

Per relation, that emits a correlated subquery on SQL
(`(SELECT COUNT(*) FROM "post" WHERE "post"."author_id" = "user"."id") AS "_count_posts"`)
and a `$lookup` + `$size` on Mongo. The subquery form is sargable iff
the relation's foreign-key column is indexed — `f.string().index()` on
`author_id`, or part of a compound. Without that, every parent row
triggers a sequential scan on the child table and the query collapses
past a few thousand parents. See [N+1](./N-PLUS-ONE.md).

A filtered `_count` picks up the inner filter inside the subquery:

```ts
await db.user.findMany({
  include: { _count: { select: { posts: { where: { status: 'PUBLISHED' } } } } },
});
```

`_count: { posts: true }` counts every post; the filtered form counts
only PUBLISHED. The two forms read similarly and the wrong one looks
correct in testing until a draft shows up — be deliberate.

### `count` accepts `take` / `skip` / `cursor`

`count` honours the same pagination args as `findMany`. The common use
is "is there a 21st row?" without materialising the page:

```ts
const more = await db.post.count({ where: { author_id: meId }, take: 21, skip: 20 });
// more === 1 means there's at least one row past page 1 of 20
```

Emits `SELECT COUNT(*) FROM (SELECT 1 FROM "post" WHERE … LIMIT 21 OFFSET 20)`.
Don't reach for it when the answer is "the total" — drop the
pagination args for that.

---

## `groupBy` keys — single and composite

`by` accepts an array of one or more own-scalar column names. Each
distinct combination becomes one result row.

### Single key

```ts
await db.order.groupBy({
  by:     ['status'],
  _count: { _all: true },
  _sum:   { total: true },
});
// → [{ status: 'PAID', _count: { _all: 17 }, _sum: { total: 12_300 } }, … ]
```

PG / SQLite / DuckDB emit:

```sql
SELECT "status", COUNT(*) AS "__agg_count__all", SUM("total") AS "__agg_sum_total"
FROM "order" GROUP BY "status";
```

MySQL emits the same with backtick quoting; MSSQL uses `COUNT_BIG(*)`
and square-bracket quoting; Mongo emits
`[{ $group: { _id: { status: '$status' }, __agg_count__all: { $sum: 1 }, __agg_sum_total: { $sum: '$total' } } }]`.

The `__agg_<bucket>_<field>` aliases are wire-stable — the executor
re-nests them into the `{ _count: { _all }, _sum: { total } }` shape
the caller sees. The aliases are an implementation detail; you never
see them unless you `$queryRaw` the same table.

### Composite keys

Pass more than one column. Each unique tuple is one bucket.

```ts
await db.order.groupBy({
  by:     ['status', 'currency'],
  _sum:   { total: true },
  _count: { _all: true },
});
// → [
//   { status: 'PAID', currency: 'NGN', _sum: { total: 12_300 }, _count: { _all: 17 } },
//   { status: 'PAID', currency: 'USD', _sum: { total:  4_200 }, _count: { _all:  9 } },
//   …
// ]
```

`GROUP BY "status", "currency"` on SQL. On Mongo the `_id` becomes a
nested document `{ status, currency }` and the executor unwraps it back
into top-level keys at hydration.

The number of groups is bounded by the cardinality of the columns.
`(status, currency)` over a few hundred enum values is fine; `(user_id, day)`
over a year of activity is a few hundred thousand groups and is still
fine on a properly-indexed table; `(session_id, …)` over a billion-row
event table is where the planner spills to disk. See
[Performance](#performance--indexing-for-group-by).

### Grouping by a derived value

Forge does not emit `GROUP BY <expression>` — the `by` list takes
column names only. Date-bucket grouping (per day, per week) is the
common case; see [Date/time aggregation](#datetime-aggregation) for the
two portable workarounds (a generated column at DDL time, or
`$queryRaw`).

---

## `having` — filtering aggregates

`having` filters **groups** after the aggregate. Two equivalent shapes
both compile to the same IR — forge's `normalizeHaving` flips
field-first into bucket-first before the dialect compilers see it.

```ts
// field-first (Prisma's surface)
having: { total: { _sum: { gte: 120 } } }

// bucket-first (forge's IR shape)
having: { _sum: { total: { gte: 120 } } }
```

The vocabulary is the same six comparison operators that `where`
exposes: `equals`, `not`, `lt`, `lte`, `gt`, `gte`. Anything richer
(`in`, `contains`, `between`) is not honoured — the IR builder silently
drops unrecognised ops. Use `$queryRaw` for richer HAVING predicates
(`HAVING SUM("total") BETWEEN $1 AND $2`).

### Per-dialect emit

```ts
having: { _sum: { total: { gt: 1_000 } }, _count: { _all: { gte: 5 } } }
```

Emits `HAVING SUM("total") > $1 AND COUNT(*) >= $2` on PG / SQLite /
DuckDB (with dialect quoting and placeholders); `COUNT_BIG(*)` on
MSSQL; `{ $match: { __agg_sum_total: { $gt: 1000 }, __agg_count__all: { $gte: 5 } } }`
on Mongo after the `$group` stage.

Multiple having clauses are joined with `AND` on SQL and a single
`$match` document on Mongo. There is no `having: { OR: [...] }` today —
nest the predicate logic in a `$queryRaw` if you need disjunction
across aggregate buckets.

### `_count._all` in having

```ts
having: { _count: { _all: { gt: 0 } } }
```

`_all` is the magic key that means "all rows in the group", i.e.
`COUNT(*)`. Per-column counts in having target the column directly:
`_count: { email: { gt: 0 } }` → `HAVING COUNT("email") > $1`. Recall
that `COUNT(col)` skips NULLs, so `_count: { email: { gt: 0 } }` is
"at least one non-null email in the group", not "at least one row".

---

## `_count` / `_sum` / `_avg` / `_min` / `_max` — the bucket shape

Each bucket key maps directly to its SQL function — `_count` →
`COUNT(col)` or `COUNT(*)` for `_all`, `_sum` → `SUM`, `_avg` → `AVG`,
`_min` → `MIN`, `_max` → `MAX`. Mongo uses `$sum` / `$avg` / `$min` /
`$max` on the field, with `{ $sum: 1 }` for `_all` and a `$cond`
wrapper that skips NULLs for per-column counts (matching SQL's
NULL-skip behaviour). `_sum` returns NULL on all-null input on SQL but
`0` on Mongo — see [Nullable handling](#nullable-handling). `_avg` is
floating-point — see
[Decimal precision](#decimal-precision-in-_sum-and-_avg).

The call-site shape is the same across every bucket: a record from
column name to `true`. Pass `true` to opt the column in.

```ts
await db.order.groupBy({
  by:    ['status'],
  _count: { _all: true, customer_id: true },   // COUNT(*) AND COUNT("customer_id")
  _sum:   { total: true, tax: true },          // SUM("total"), SUM("tax")
  _avg:   { total: true },
  _min:   { total: true },
  _max:   { total: true },
});
```

Each bucket key surfaces on the return row only if you asked for it.
The shape is **not** flattened — `_sum.total` stays under `_sum`, not
under the bucket name's prefix. Destructure on the caller side:

```ts
for (const row of result) {
  const { status, _sum, _count, _avg } = row;
  console.log(status, _sum.total, _count._all, _avg.total);
}
```

### The unbucketed `aggregate` form

For "what's the overall sum across this filter", pass no `by`:

```ts
await db.order.aggregate({
  where: { status: 'PAID', created_at: { gte: monthStart } },
  _sum:  { total: true, items_count: true },
  _avg:  { total: true },
  _min:  { total: true },
  _max:  { total: true },
  _count: true,                  // top-level row count, no nesting
});
// → { _sum: { total: 19_872, items_count: 187 },
//     _avg: { total: 432.18 },
//     _min: { total: 12 }, _max: { total: 4500 },
//     _count: 46 }
```

Per-dialect emit (PG):

```sql
SELECT
  SUM("total")        AS "__agg_sum_total",
  SUM("items_count")  AS "__agg_sum_items_count",
  AVG("total")        AS "__agg_avg_total",
  MIN("total")        AS "__agg_min_total",
  MAX("total")        AS "__agg_max_total",
  COUNT(*)            AS "__agg_count"
FROM "order"
WHERE "status" = $1 AND "created_at" >= $2;
```

No `GROUP BY` — there is exactly one row in the result. On Mongo the
`$group` stage uses `_id: null` and the executor unwraps the single
document back into the `{ _sum, _avg, … }` payload.

---

## Per-dialect emit table

The query is `groupBy({ by: ['status'], _sum: { total: true }, _count: { _all: true }, having: { _sum: { total: { gt: 1000 } } }, orderBy: { _sum: { total: 'desc' } }, take: 10 })`.

PG / SQLite / DuckDB:

```sql
SELECT "status", SUM("total") AS "__agg_sum_total", COUNT(*) AS "__agg_count__all"
FROM "order"
GROUP BY "status"
HAVING SUM("total") > $1
ORDER BY SUM("total") DESC
LIMIT 10;
```

MySQL emits the same shape with backtick quoting and `?` placeholders.
MSSQL puts the row cap into `TOP 10` at the head and uses `COUNT_BIG(*)`
— `COUNT(*)` on MSSQL returns `int` and overflows at 2.1 billion rows.
MySQL is the one to watch on legacy installs: `ONLY_FULL_GROUP_BY`
became the default in 5.7.5 and older installs allow `SELECT a, b, SUM(c) GROUP BY a`
with `b` undefined. Forge always lists every `by` column in both
clauses, so the legacy footgun is a non-issue at the API layer.

Mongo:

```js
[
  { $group: { _id: { status: '$status' }, __agg_sum_total: { $sum: '$total' }, __agg_count__all: { $sum: 1 } } },
  { $match: { __agg_sum_total: { $gt: 1000 } } },
  { $sort:  { __agg_sum_total: -1 } },
  { $limit: 10 },
]
```

`$group → $match → $sort → $limit` mirrors `WHERE → GROUP BY → HAVING → ORDER BY → LIMIT`
exactly. The Mongo planner cannot push the post-`$group` `$match`
back into the pre-`$group` filter the way SQL planners push HAVING
into WHERE — so the index choice for the `$group` stage is on the
**grouping key**, not the filter columns. See
[Performance](#performance--indexing-for-group-by).

---

## Nullable handling

The single most-asked-about gotcha. SQL aggregate functions and Mongo
aggregate operators handle NULL slightly differently, and the answers
differ from `findMany`'s.

### `COUNT(*)` vs `COUNT(col)`

`COUNT(*)` counts every row (even all-NULL rows). `COUNT(col)` counts
rows where `col` is NOT NULL. `COUNT(DISTINCT col)` counts distinct
non-null values. The forge mapping:

```ts
db.user.count({})                                            // COUNT(*)
db.user.groupBy({ by:['org_id'], _count: { email: true } })  // COUNT("email") — non-null
db.user.count({ distinct: ['email'] })                       // COUNT(DISTINCT "email") — distinct non-null
```

The per-column form is the trap. `_count: { email: true }` returns
the count of rows in the group with a non-null email — if your model
has 100 users in an org and 30 have no email, that bucket reads 70,
which looks wrong when the caller expected the group's row count. For
"every row in the group", use `_count: { _all: true }`.

### `SUM` over all-NULL input

SQL standard: `SUM(col)` returns NULL on all-NULL input, not 0. PG,
MySQL, SQLite, DuckDB, MSSQL all match this. In the forge result, that
surfaces as `_sum: { revenue: null }`. Mongo's `$sum` is the outlier:
empty / all-null input yields `0`, not null.

```ts
const row = await db.order.aggregate({ where: { status: 'CANCELLED' }, _sum: { revenue: true } });
const total = row._sum.revenue ?? 0;       // explicit zero-coerce — portable everywhere
```

This is one of the few places the same forge call returns a different
scalar across dialects. Pin it with the `?? 0` coerce and you get the
SQL-style "I asked for a sum, I got a number" surface everywhere.

### `AVG`, `MIN`, `MAX` over all-NULL input

All three return `null` (SQL) or `null` (Mongo) on empty / all-null
input. There is no `0` divergence here — `AVG` of an empty set is
genuinely undefined and SQL is right to say so. Coerce at the call
site if your dashboard wants a "no data" placeholder.

### `GROUP BY` on a nullable column

Every dialect groups NULL into its own bucket — one row with `_id: null`
on Mongo, one row with the column being NULL on SQL.

```ts
await db.order.groupBy({ by: ['referrer_id'], _count: { _all: true } });
// → [{ referrer_id: null, _count: { _all: 42 } }, { referrer_id: 'u1', ...}, … ]
```

That's standard SQL behaviour and almost always what the caller wants.
If you want to exclude the NULL bucket, add `where: { referrer_id: { not: null } }`.

---

## Decimal precision in `_sum` and `_avg`

Floats are not associative — `(a + b) + c` and `a + (b + c)` can land
on different bits when `a` and `b` are large and `c` is small.
`SUM(col)` accumulates left-to-right and the planner is free to
reorder under a hash aggregate. The visible drift on a sum of a
million floating-point dollar amounts is on the order of cents to
single dollars; on an `_avg` of the same, much smaller.

For money, declare the column as `f.decimal({ precision, scale })`:

```ts
const Order = model('order', {
  id:    f.id(),
  total: f.decimal({ precision: 18, scale: 4 }),
});
```

Per-dialect storage: PG / MySQL / DuckDB store `NUMERIC(18, 4)` /
`DECIMAL(18, 4)` as arbitrary-precision and `SUM` stays exact; MSSQL
widens to `DECIMAL(38, 4)` to avoid overflow; SQLite stores as TEXT
and aggregates promote to float unless you ship the SQLite decimal
extension; Mongo's `Decimal128` is IEEE 754-2008 decimal and `$sum`
widens up to 34 significant digits.

The PG driver returns `NUMERIC` as a string; forge's hydrator coerces
to JavaScript `number` (a double, so precision is lost on the way
out). For exact decimal arithmetic, pull the raw string through
`$queryRaw` and parse with `decimal.js` or `big.js` in the caller.
On Mongo, `Decimal128` survives the round trip if your driver
preserves the BSON type — see [Mongo](./MONGO.md#decimal128).

### `AVG` widening

`AVG` of an integer column returns a float on PG (`numeric`) and a
float on Mongo. SQLite's `AVG` widens to `REAL` — the IEEE 754 double.
For an integer-only running average, do the math yourself:

```ts
const { _sum, _count } = await db.order.aggregate({ _sum: { items_count: true }, _count: true });
const avgItems = _count > 0 ? _sum.items_count / _count : 0;
```

That's exact integer division on the way in and one float divide at
the end — no accumulation error.

---

## Date/time aggregation

The classic dashboard query: revenue per day for the last 30 days.
Forge does not expose a portable date-bucket operator in the `by`
list — `GROUP BY date_trunc('day', "created_at")` is per-dialect SQL.

Three portable workarounds, in order of preference.

### 1. Generated column at DDL time

Declare a stored-generated column for the bucket and group on that.
Works on PG, MySQL 5.7+, SQLite 3.31+, MSSQL, DuckDB. Mongo doesn't
need it — see option 3.

```sql
ALTER TABLE "order"
  ADD COLUMN "created_day" date GENERATED ALWAYS AS (("created_at")::date) STORED;
CREATE INDEX "order_created_day_idx" ON "order"("created_day");
```

Then forge groups portably:

```ts
await db.order.groupBy({
  by:    ['created_day'],
  where: { created_at: { gte: thirtyDaysAgo } },
  _sum:  { total: true },
});
```

The generated column is computed on insert and indexable. Query plans
match a plain integer-keyed dashboard.

### 2. `$queryRaw` with the dialect's truncation function

```ts
// Postgres
const rows = await db.$queryRaw<Array<{ day: Date; total: number }>>`
  SELECT date_trunc('day', "created_at") AS day, SUM("total") AS total
  FROM "order"
  WHERE "created_at" >= ${thirtyDaysAgo}
  GROUP BY day ORDER BY day ASC;
`;
```

Per-dialect day/week/month equivalents: PG and DuckDB use
`date_trunc('day' | 'week' | 'month', col)`; MySQL uses `DATE(col)`,
`YEARWEEK(col, 1)`, `DATE_FORMAT(col, '%Y-%m-01')`; SQLite uses
`date(col)`, `strftime('%Y-W%W', col)`, `strftime('%Y-%m-01', col)`;
MSSQL uses `CAST(col AS date)`, `DATEPART(week, col)` + year,
`DATEFROMPARTS(YEAR(col), MONTH(col), 1)`. Wrap the per-dialect SQL in
a helper if your app targets more than one — the abstraction is yours
to own, not the ORM's.

### 3. Mongo `$dateTrunc`

Mongo 5.0+ has `$dateTrunc`, which fits inside an aggregate pipeline
cleanly. Reach for the raw `db.<model>.aggregate({ pipeline })`
surface:

```ts
await db.order.aggregate({
  pipeline: [
    { $match: { created_at: { $gte: thirtyDaysAgo } } },
    { $group: {
        _id:   { $dateTrunc: { date: '$created_at', unit: 'day' } },
        total: { $sum: '$total' },
      } },
    { $sort: { _id: 1 } },
  ],
});
```

On Mongo 4.x, swap for `$dateToString: { format: '%Y-%m-%d', date: '$created_at' }`
in the `_id` — string buckets sort lexicographically the same as the
underlying dates as long as the format is ISO.

---

## Aggregating embedded / JSON fields

`groupBy`'s `by` list takes own-scalar column names — not JSON paths.
For `GROUP BY data->'tier'`, drop to `$queryRaw` (SQL) or the raw
aggregate pipeline (Mongo). The per-dialect read syntax —
`"data"->>'tier'` on PG, `JSON_UNQUOTE(JSON_EXTRACT(...))` on MySQL,
`json_extract` on SQLite/DuckDB, `JSON_VALUE` on MSSQL — is the same
syntax forge uses for the `path` operator inside `where`; see
[JSON-PATH.md](./JSON-PATH.md) for the full table.

```ts
// Postgres
await db.$queryRaw<Array<{ tier: string; n: number }>>`
  SELECT "data"->>'tier' AS tier, COUNT(*) AS n
  FROM "user" GROUP BY tier;
`;

// Mongo — dotted path inside $group._id
await db.user.aggregate({
  pipeline: [{ $group: { _id: '$data.tier', n: { $sum: 1 } } }],
});
```

When the JSON path is read often, lift it to a top-level scalar column
— a generated column on PG / MySQL, or a write-side hook on every
dialect. The dashboard gets indexed-column performance and the
JSON-path surface stays the escape hatch for ad-hoc queries.

---

## `where` vs `having` — input filter vs output filter

The mental model: `where` is "which rows go into the bucket", `having`
is "which buckets come out the other side".

```ts
await db.order.groupBy({
  by:    ['status'],
  where: { created_at: { gte: monthStart } },       // rows from this month only
  _sum:  { total: true },
  having: { _sum: { total: { gt: 10_000 } } },      // only groups whose monthly sum > 10k
});
```

On SQL that's `WHERE "created_at" >= $1 … GROUP BY "status" HAVING SUM("total") > $2`;
on Mongo, two `$match` stages bracket the `$group`. If the predicate
references a non-aggregate column, put it in `where` — the input
narrows before the group, fewer rows scan, any index on the predicate
column kicks in. If it references an aggregate, it has to be in
`having` because the value doesn't exist until after the group.

A common mistake: `having: { status: { equals: 'PAID' } }` when you
meant `where: { status: 'PAID' }`. The `having` form is silently
dropped (forge's IR ignores unrecognised buckets) and the filter never
applies — every status comes through and the total is wrong. The keys
in `having` must be aggregate buckets (`_count`, `_sum`, `_avg`,
`_min`, `_max`), not column names. Field-first
(`having: { total: { _sum: { gt: 1 } } }`) is accepted because `_sum`
is the inner key; the IR normaliser flips it. Bucket-less
(`having: { total: { gt: 1 } }`) is silently dropped — spell out the
bucket.

---

## `ORDER BY` an aggregate result

Sort by a bucket key with the same `orderBy` shape `findMany` uses,
with the aggregate bucket as the field path.

```ts
orderBy: { _sum: { total: 'desc' } }
// or: orderBy: [{ _sum: { total: 'desc' } }, { status: 'asc' }]
```

Emits `ORDER BY SUM("total") DESC` on SQL (every dialect re-emits the
aggregate function rather than aliasing through the SELECT-list alias,
which is portable enough); `{ $sort: { __agg_sum_total: -1 } }` on the
Mongo alias.

Order on a `by` column directly with `orderBy: { status: 'asc' }`. On
Mongo the `by` columns live under `_id.<name>`, which the executor
resolves automatically. Sorting by a bucket you didn't ask for is
silently dropped on SQL (alias doesn't exist) and an error on Mongo —
always ask for every bucket you intend to sort on.

---

## Pagination of aggregated results

`groupBy` honours `take` (alias `limit`) and `skip` (alias `offset`) —
both compile to `LIMIT`/`OFFSET` on SQL and `$limit`/`$skip` on Mongo.

```ts
await db.order.groupBy({
  by:      ['customer_id'],
  _sum:    { total: true },
  orderBy: [{ _sum: { total: 'desc' } }, { customer_id: 'asc' }],
  take:    20,
  skip:    40,
});
```

The same offset-based caveat from [QUERIES.md → pagination](./QUERIES.md#pagination--offset-vs-cursor)
applies: if a new order arrives between page loads, the group sums
shift and the page boundary moves. For a live dashboard where the
aggregate is changing under you, the right answer is usually to
materialise the aggregate into a snapshot table (or a materialised
view) and paginate over that — see [BACKEND.md](./BACKEND.md) for the
snapshot pattern.

Cursor pagination on a grouped result is harder than on a plain
`findMany` because the visible sort key (the aggregate) is not unique.
Two patterns work: cursor on `(sum, group_key)` with the group key as
a tie-breaker, and implement the cursor advance yourself via
`where: { OR: [ { sum: { lt: lastSum } }, { sum: lastSum, customer_id: { gt: lastKey } } ] }`
— `groupBy` has no built-in cursor surface today. Or cap the result:
if the dashboard only shows the top 100, skip pagination entirely and
let the UI virtualise.

---

## Window functions vs aggregations

`groupBy` collapses to one row per group; window functions keep every
row and attach an aggregate computed across a window. Running totals,
ranks, moving averages, and top-N-per-group are all window-function
shapes. Forge does not emit window functions today — every aggregate
goes through `GROUP BY` — so reach for `$queryRaw`:

```ts
// top 3 most-expensive orders per customer
const rows = await db.$queryRaw<Array<{ id: string; customer_id: string; total: number; rk: number }>>`
  SELECT id, customer_id, total,
         ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY total DESC) AS rk
  FROM "order" WHERE "status" = 'PAID';
`;
const top3 = rows.filter((r) => r.rk <= 3);
```

Per-dialect support: PG, MySQL 8+, SQLite 3.25+, MSSQL, and DuckDB all
support window functions; MySQL 5.7 does not; Mongo's
`$setWindowFields` (5.0+) is the closest analogue through the raw
`aggregate({ pipeline })` surface. See [RAW-SQL.md](./RAW-SQL.md).

---

## Performance — indexing for `GROUP BY`

The single biggest lever on aggregate latency is whether the `by`
column (or the leading edge of a compound index on it) is indexed.

### SQL plans

With a B-tree on the `by` column, the planner uses an index-only scan
(PG) or range scan (MySQL/SQLite) and groups in order — linear in the
number of distinct buckets. Without one, it falls back to a sequential
scan plus a hash aggregate (PG / DuckDB) or sort-then-group (MySQL /
SQLite) — linear in the row count.

For `groupBy({ by: ['status'], _sum: { total: true } })` on PG over 1M
rows: ~120 ms with `Seq Scan → HashAggregate`, ~12 ms with
`Index Only Scan → GroupAggregate`. The 10× gap holds across PG /
MySQL / MSSQL / DuckDB. SQLite uses sort-then-group by default; the
index turns the sort into a no-op.

### Composite indexes and filter-before-group

For composite `by`, the index has to match the leading edge: a
`(status, currency)` index serves `by: ['status']` and
`by: ['status', 'currency']` equally well, but not `by: ['currency']`
alone — same rule as `where`. The combined `(where_col, by_col)` index
is the optimal shape when both clauses are present:

```ts
const Order = model('order', {
  id: f.id(), org_id: f.string().index(), status: f.string(), total: f.int(),
}, {
  indexes: [{ on: ['org_id', 'status'] }],                 // covers per-org GROUP BY status
});
```

`groupBy({ by: ['status'], where: { org_id }, _sum: { total: true } })`
uses the compound index for both the WHERE and the GROUP BY, no sort.

### Mongo

Mongo's `$group` cannot use an index for the grouping itself — the
`$group` stage always scans every document the `$match` lets through.
The index only helps the `$match`. The optimisation lever is:

1. Put the most-selective `$match` first.
2. Index the `$match` filter columns.
3. Cap the result with `$limit` when possible (after `$sort`).

For aggregations that run on every page load, materialise the result
with `$merge` or `$out` into a rollup collection and read that
directly. See [MONGO.md](./MONGO.md#materialised-aggregates).

---

## Mongo aggregation pipeline

`db.<model>.aggregate({ pipeline })` is the escape hatch into Mongo's
native pipeline — every stage the driver supports, with forge's
extended-JSON coercion (`{ $oid: 'abc' }` → native `ObjectId`) and a
post-processor that stringifies `ObjectId` and remaps top-level `_id`
to `id` (see `src/__tests__/aggregate-output.spec.ts`).

### How `groupBy` translates

| forge call | Pipeline stage |
|---|---|
| `where` | `$match` before `$group` |
| `by` | `$group._id` |
| `_count: { _all: true }` | `__agg_count__all: { $sum: 1 }` |
| `_count: { col: true }` | per-column non-null count |
| `_sum`/`_avg`/`_min`/`_max` | `$sum` / `$avg` / `$min` / `$max` on `$col` |
| `having` | `$match` after `$group` on the `__agg_*` aliases |
| `orderBy` / `take` / `skip` | `$sort` / `$limit` / `$skip` |

### When to drop to the raw pipeline

Reach for `aggregate({ pipeline })` directly when you need a `$lookup`
(Mongo's JOIN — `groupBy` cannot pull related-collection columns), a
`$facet` for a multi-panel dashboard (see worked example (d) below), a
`$bucket` / `$bucketAuto` histogram, `$dateTrunc` in the group key, or
a `$setWindowFields` window-function stage.

```ts
// Customers with order count, lifetime value, average order — single round-trip
const rows = await db.user.aggregate({
  pipeline: [
    { $match: { active: true } },
    { $lookup: {
        from: 'order', localField: '_id', foreignField: 'customer_id', as: 'orders',
        pipeline: [{ $match: { status: 'PAID' } }],
      } },
    { $project: {
        name: 1,
        n:              { $size: '$orders' },
        lifetime_value: { $sum:  '$orders.total' },
        avg_order:      { $avg:  '$orders.total' },
      } },
    { $sort: { lifetime_value: -1 } },
    { $limit: 50 },
  ],
});
```

---

## Four worked dashboards

### (a) Revenue per day for the last 30 days

The bread-and-butter dashboard widget. Date-bucketed sum with a stable
sort.

PG / MySQL / SQLite / DuckDB / MSSQL — with a generated `created_day`
column on the table:

```ts
const rows = await db.order.groupBy({
  by:      ['created_day'],
  where:   { created_at: { gte: thirtyDaysAgo }, status: 'PAID' },
  _sum:    { total: true },
  _count:  { _all: true },
  orderBy: { created_day: 'asc' },
});
// → [{ created_day: Date('2026-05-26'), _sum: { total: 12_300 }, _count: { _all: 17 } }, …]
```

Without the generated column, use `$queryRaw` with the dialect's
`date_trunc`:

```ts
const rows = await db.$queryRaw<Array<{ day: Date; total: number; n: number }>>`
  SELECT date_trunc('day', "created_at") AS day,
         SUM("total")                    AS total,
         COUNT(*)                        AS n
  FROM "order"
  WHERE "created_at" >= ${thirtyDaysAgo} AND "status" = 'PAID'
  GROUP BY day
  ORDER BY day ASC;
`;
```

Mongo:

```ts
const rows = await db.order.aggregate({
  pipeline: [
    { $match: { created_at: { $gte: thirtyDaysAgo }, status: 'PAID' } },
    { $group: {
        _id:    { $dateTrunc: { date: '$created_at', unit: 'day' } },
        total:  { $sum: '$total' },
        n:      { $sum: 1 },
      } },
    { $sort: { _id: 1 } },
  ],
});
```

For a zero-fill (days with no orders show up as `total: 0`),
synthesise the missing days in the caller — neither SQL nor Mongo will
emit rows for buckets with zero matching input.

### (b) Top 10 customers by lifetime value

```ts
const top = await db.order.groupBy({
  by:      ['customer_id'],
  where:   { status: 'PAID' },
  _sum:    { total: true },
  _count:  { _all: true },
  orderBy: { _sum: { total: 'desc' } },
  take:    10,
});
// → [{ customer_id: 'u_42', _sum: { total: 89_400 }, _count: { _all: 124 } }, …]
```

To attach the customer name, follow up with a second `findMany`
against `id: { in: top.map(r => r.customer_id) }` and zip into a Map.
The alternative is a `$queryRaw` JOIN on SQL or a `$lookup` on Mongo
— both pay one extra scan to save the second round-trip, which is
rarely worth it for a 10-row top-N dashboard.

### (c) Histogram of order amounts

PG / SQLite / DuckDB ship `width_bucket(value, min, max, count)` —
1-indexed bucket the value falls into, with one extra bucket above
`max`. MySQL doesn't have it; emulate with `FLOOR(total / 500)`.

```ts
const hist = await db.$queryRaw<Array<{ bucket: number; n: number }>>`
  SELECT width_bucket("total", 0, 10000, 20) AS bucket, COUNT(*) AS n
  FROM "order" WHERE "status" = 'PAID'
  GROUP BY bucket ORDER BY bucket;
`;
```

Mongo's `$bucket` (with explicit boundaries) and `$bucketAuto` (forge
picks them) are the native shape:

```ts
const hist = await db.order.aggregate({
  pipeline: [
    { $match: { status: 'PAID' } },
    { $bucket: {
        groupBy: '$total',
        boundaries: [0, 500, 1000, 2500, 5000, 10000, Infinity],
        default:    'over',
        output:     { n: { $sum: 1 } },
      } },
  ],
});
```

### (d) Mongo `$facet` — multi-dimensional admin dashboard

One query, four panels, one shared `$match` scan.

```ts
const dashboard = await db.order.aggregate({
  pipeline: [
    { $match: { created_at: { $gte: monthStart } } },
    { $facet: {
        byStatus: [
          { $group: { _id: '$status', total: { $sum: '$total' }, n: { $sum: 1 } } },
        ],
        topCustomers: [
          { $group: { _id: '$customer_id', total: { $sum: '$total' } } },
          { $sort:  { total: -1 } },
          { $limit: 10 },
        ],
        daily: [
          { $group: { _id: { $dateTrunc: { date: '$created_at', unit: 'day' } }, total: { $sum: '$total' } } },
          { $sort: { _id: 1 } },
        ],
        totals: [
          { $group: { _id: null, n: { $sum: 1 }, gross: { $sum: '$total' }, avg: { $avg: '$total' } } },
        ],
      } },
  ],
});
// → [{ byStatus: [...], topCustomers: [...], daily: [...], totals: [...] }]
```

On SQL the equivalent is four separate `groupBy` calls — or one
`$queryRaw` with four CTEs. For a dashboard that loads on every
navigation the single-round-trip pattern pays off; for one-shot
exports the cost is roughly the same.

---

## Cross-links

* [QUERIES.md](./QUERIES.md) — `findMany`, `where`, `select`, `orderBy`, pagination, `count`, the `_count` synthetic field
* [JSON-PATH.md](./JSON-PATH.md) — JSON path reads, used inside aggregations for grouping on embedded scalars
* [MONGO.md](./MONGO.md) — Mongo adapter specifics, including `Decimal128`, materialised aggregates via `$merge`/`$out`, and the rest of the pipeline surface
* [RAW-SQL.md](./RAW-SQL.md) — `$queryRaw` and `$executeRaw` for window functions, recursive CTEs, dialect-specific aggregate functions
* [N-PLUS-ONE.md](./N-PLUS-ONE.md) — when `_count` on a relation degrades to a per-parent subquery
* [DUCKDB.md](./DUCKDB.md) — DuckDB's columnar planner for analytical aggregates
* [INDEXES.md](./INDEXES.md) — composite indexes that cover both `where` and `by`
* [BACKEND.md](./BACKEND.md) — materialised aggregates and rollup tables for dashboards that read every request
