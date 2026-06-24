# Window functions

Aggregations that don't collapse rows — running totals, moving averages, ranks, lag/lead, sessionization. forge-orm doesn't ship a typed builder for windows; you reach them through `forgeSql` raw inside `$queryRaw` (and `$setWindowFields` for Mongo). This page documents the syntax, the per-dialect matrix, and the canonical patterns.

Everything below assumes you're on 2.5.x. The relevant background is in
[docs/RAW-SQL.md](RAW-SQL.md) (the `$queryRaw` / `forgeSql` surface)
and [docs/QUERIES.md](QUERIES.md#aggregates--_avg-_sum-_min-_max) (the
typed aggregate path that windows fall off the end of).

## Contents

* [What a window function is](#what-a-window-function-is)
* [The shared syntax](#the-shared-syntax)
* [Per-dialect support matrix](#per-dialect-support-matrix)
* [Reaching them from forge](#reaching-them-from-forge)
* [Ranking functions](#ranking-functions)
* [Aggregate windows](#aggregate-windows)
* [Value-access functions](#value-access-functions)
* [Distribution functions](#distribution-functions)
* [`PARTITION BY` and `ORDER BY`](#partition-by-and-order-by)
* [Frame clauses — ROWS vs RANGE](#frame-clauses--rows-vs-range)
* [Mongo `$setWindowFields`](#mongo-setwindowfields)
* [Common patterns](#common-patterns)
* [Performance](#performance)
* [Typed results](#typed-results)
* [Four worked examples](#four-worked-examples)
* [Cross-links](#cross-links)

---

## What a window function is

A regular aggregate (`SUM`, `AVG`, `COUNT` with `GROUP BY`) collapses
groups of rows into one row each. A window function applies the same
aggregate over a window of rows but keeps every input row in the
output. The result column shows the aggregate evaluated for the
current row's window.

```sql
-- GROUP BY collapses 100 orders per user → 100 rows.
SELECT user_id, SUM(total) FROM orders GROUP BY user_id;

-- Window keeps every order row, with the running total alongside.
SELECT
  id, user_id, placed_at, total,
  SUM(total) OVER (PARTITION BY user_id ORDER BY placed_at) AS running_total
FROM orders;
```

The second lets the caller draw a per-user spend chart row by row, or
answer "what was this customer's lifetime spend at the moment of this
order?" without a self-join. Same aggregate, kept inline with the
source rows.

Three things the typed forge API doesn't try to express because the
window machinery doesn't fit `groupBy`'s row-collapsing contract:
the same row appears in many windows; the window's frame moves with
the row; functions like `RANK` and `LAG` only make sense inside a
window. When you hit any of those, drop to `$queryRaw`.

---

## The shared syntax

Every SQL dialect that supports windows uses the same skeleton:

```
window_function(args) OVER (
  [PARTITION BY <expr>, <expr>, …]
  [ORDER BY    <expr> [ASC|DESC] [NULLS FIRST|LAST], …]
  [<frame_clause>]
)
```

Three optional sub-clauses. **`PARTITION BY`** divides the rows into
independent windows — like a `GROUP BY` for window functions. Omit
it and the window covers every row. **`ORDER BY`** sorts within each
partition; required for ranking and for running aggregates that need
a direction. The **frame clause** narrows the window further to a
sliding range around the current row.

Three shapes you'll see often:

```sql
-- Whole partition — like a GROUP BY but inline.
SUM(total) OVER (PARTITION BY user_id)

-- Running total — accumulator from the partition start to here.
SUM(total) OVER (PARTITION BY user_id ORDER BY placed_at)

-- 7-day moving sum — sliding frame around the current row.
SUM(total) OVER (
  PARTITION BY user_id
  ORDER BY placed_at
  ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
)
```

The third is the one most people are reaching for when they search
for "moving average forge-orm" — it doesn't fit `aggregate()` or
`groupBy()`, and there isn't a typed builder for it. The raw shape is
straightforward, though.

---

## Per-dialect support matrix

| Dialect | Window support | Notes |
|---|---|---|
| Postgres | Full | First-class since 8.4; everything below works. `WINDOW … AS` named windows supported. |
| MySQL 8.0+ | Full | Added in 8.0. MySQL 5.7 has none — none of this works there. |
| MariaDB 10.2+ | Full | Caught up with MySQL 8 here. |
| SQLite 3.25+ | Full | Added in 3.25 (2018). Every shipped forge SQLite driver is newer. |
| DuckDB | Full | Window functions are a first-class DuckDB feature; the engine is built for OLAP. |
| MSSQL | Full | Ranking since 2012; full frame variants since 2016. The forge wrapper targets 2017+, so you have everything. |
| Mongo | Pipeline only | No SQL-style `OVER` clause. Use the `$setWindowFields` aggregation stage (5.0+). The semantics map cleanly; the syntax doesn't. |

Two surprises hidden in that table:

* **MySQL 5.7 doesn't have windows.** If you target a managed RDS
  instance still on 5.7, the queries on this page raise `ER_PARSE_ERROR`
  at runtime. The right answer is to bump to 8.0.
* **Mongo 4.x doesn't have `$setWindowFields`.** Added in 5.0. If the
  cluster is pre-5.0, the Mongo section below doesn't apply.

---

## Reaching them from forge

There is no `db.<model>.window(...)` builder. The two surfaces are:

```ts
// SQL adapters — tagged template, parameterised values.
const rows = await db.$queryRaw<Row>`
  SELECT
    id,
    user_id,
    RANK() OVER (PARTITION BY user_id ORDER BY placed_at DESC) AS r
  FROM orders
  WHERE org_id = ${orgId}
`;

// Mongo — pipeline aggregation.
const rows = await db.order.aggregate({
  pipeline: [
    { $match: { org_id: orgId } },
    {
      $setWindowFields: {
        partitionBy: '$user_id',
        sortBy: { placed_at: -1 },
        output: { r: { $rank: {} } },
      },
    },
  ],
});
```

Both surfaces are documented in detail in [docs/RAW-SQL.md](RAW-SQL.md).

The pre-built `forgeSql.sql` form is useful when the window clause is
built separately from the projection:

```ts
import { forgeSql } from 'forge-orm';

const window = forgeSql.sql`PARTITION BY user_id ORDER BY placed_at DESC`;
const rows = await db.$queryRaw`
  SELECT id, user_id, RANK() OVER (${window}) AS r
  FROM orders
  WHERE org_id = ${orgId}
`;
```

That keeps the partition definition reusable across queries — handy
when several reports share the same "by user, by recency" cut.

---

## Ranking functions

Four functions. All require `ORDER BY` inside the window — there's no
defined rank without an ordering.

```sql
ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY placed_at DESC)
-- 1, 2, 3, 4, 5 — strict, ties resolved arbitrarily. Top-N regardless of ties.

RANK() OVER (PARTITION BY category ORDER BY views DESC)
-- 1, 2, 2, 4, 5 — ties share, then skip. Classic leaderboard shape.

DENSE_RANK() OVER (PARTITION BY category ORDER BY views DESC)
-- 1, 2, 2, 3, 4 — ties share, no gap. Use when you care about distinct rank counts.

NTILE(4) OVER (ORDER BY revenue DESC)
-- 1 for the top 25%, 2 for the next, … 4 for the bottom. Quartile / decile.
```

---

## Aggregate windows

`SUM`, `AVG`, `COUNT`, `MIN`, `MAX` — every standard aggregate also
works as a window function. The difference is whether `OVER (...)`
follows it.

```sql
-- Standard aggregate — collapses rows.
SELECT user_id, SUM(total) FROM orders GROUP BY user_id;

-- Window aggregate — keeps rows, sum is computed over the window.
SELECT id, user_id, SUM(total) OVER (PARTITION BY user_id) FROM orders;
```

The three shapes you'll reach for most:

### Running total

```sql
SUM(total) OVER (PARTITION BY user_id ORDER BY placed_at) AS running_total
```

`ORDER BY` with no explicit frame defaults to `RANGE BETWEEN
UNBOUNDED PRECEDING AND CURRENT ROW` — accumulator from partition
start.

### Moving sum / average

```sql
AVG(total) OVER (
  PARTITION BY user_id
  ORDER BY placed_at
  ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
) AS avg_7d
```

For a strict 7-day window (not 7 rows), use `RANGE` — see
[Frame clauses](#frame-clauses--rows-vs-range).

### Partition total

```sql
SUM(total) OVER (PARTITION BY user_id) AS lifetime_spend
```

No `ORDER BY` — the window is the entire partition. Every row in the
partition gets the same value. Useful for "this order is X% of the
customer's lifetime spend" calculations.

### `COUNT(*)` as a window

`COUNT(*) OVER ()` counts the whole result set — that's a common
shape for "total rows for pagination" without a second query:

```ts
const page = await db.$queryRaw<{ id: string; title: string; total: number }>`
  SELECT id, title, COUNT(*) OVER () AS total
  FROM posts
  WHERE org_id = ${orgId}
  ORDER BY created_at DESC
  LIMIT ${pageSize} OFFSET ${offset}
`;
// page[0].total is the total row count across all pages.
```

One query for the page plus the total. The cost is that the engine
has to know the full filtered row count, which still requires the
predicate scan — but it skips the second round trip.

---

## Value-access functions

These read a value from another row in the partition. All four take
`ORDER BY`.

* **`LAG(expr, offset, default)`** — the value `offset` rows before
  the current row, or `default` if no such row exists. Day-over-day
  deltas, run-detection, churn calculations.
* **`LEAD(expr, offset, default)`** — the mirror. Gap detection, "time
  until next event", churn windows.
* **`FIRST_VALUE(expr)` / `LAST_VALUE(expr)`** — first or last value
  in the window, subject to the frame clause.
* **`NTH_VALUE(expr, n)`** — the Nth value in the window. Same frame
  caveat as `LAST_VALUE`.

The trap with `LAST_VALUE`: the default frame is `RANGE BETWEEN
UNBOUNDED PRECEDING AND CURRENT ROW`, which means "last value in the
window so far" = the current row. To actually get the partition's
last row, force the frame:

```sql
LAST_VALUE(price) OVER (
  PARTITION BY product_id
  ORDER BY day
  ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
) AS final_price
```

This trips up almost everyone the first time. If `LAST_VALUE` is
returning the current row's value, the frame clause is the reason.

A day-over-day delta with `LAG`:

```ts
type DayRow = { day: string; revenue: number; delta: number | null };

const trend = await db.$queryRaw<DayRow>`
  WITH daily AS (
    SELECT
      date_trunc('day', placed_at)::date AS day,
      SUM(total)                         AS revenue
    FROM orders
    WHERE org_id = ${orgId}
      AND placed_at >= ${since}
    GROUP BY 1
  )
  SELECT
    day,
    revenue,
    revenue - LAG(revenue) OVER (ORDER BY day) AS delta
  FROM daily
  ORDER BY day
`;
```

The first row's `delta` is `NULL` (no prior row); subsequent rows
have "yesterday vs today" deltas.

---

## Distribution functions

Two for when you want to know where a row sits in the distribution
without bucketing.

* **`PERCENT_RANK()`** — `(rank - 1) / (total_rows - 1)`. Lowest row
  is `0`, highest is `1`. Use for "this user is in the top X% by
  spend."
* **`CUME_DIST()`** — fraction of rows with values `<=` the current
  row's value. Lowest row is `1/total_rows`, highest is `1`.

The conceptual difference: `PERCENT_RANK` is rank-as-fraction;
`CUME_DIST` is a cumulative distribution. Practically, both produce
similar shapes; pick `PERCENT_RANK` for "percentile-like" semantics.

---

## `PARTITION BY` and `ORDER BY`

`PARTITION BY` is the inner `GROUP BY` of window functions. Multi-column
keys behave like the cartesian — `PARTITION BY user_id,
date_trunc('month', placed_at)` is per-user, per-month windows. Skip
`PARTITION BY` and the window covers every row (`SUM(total) OVER ()`
gives every row the grand total).

`ORDER BY` inside `OVER (...)` controls the sequence within each
partition. It's a separate sort from the outer query's `ORDER BY`:

```sql
SELECT id, user_id, RANK() OVER (PARTITION BY user_id ORDER BY views DESC) AS r
FROM posts
ORDER BY user_id, r;  -- outer sort decides row output order
```

It's required for every ranking function, every value-access
function, both distribution functions, and any aggregate that should
accumulate rather than report the partition's full aggregate.
Optional for whole-partition aggregates and `COUNT(*) OVER ()`.

`NULLS FIRST` / `NULLS LAST`: Postgres defaults to `NULLS LAST` for
ASC; MySQL and SQLite default to `NULLS FIRST` for ASC. If the result
has to be portable, make the choice explicit
(`ORDER BY at ASC NULLS LAST`).

---

## Frame clauses — ROWS vs RANGE

The frame clause defines a sub-window inside the partition, relative
to the current row. It's how you get moving averages and sliding
sums. The full syntax is `{ROWS | RANGE | GROUPS} BETWEEN <start> AND
<end>`, where start / end is one of `UNBOUNDED PRECEDING`, `<n>
PRECEDING`, `CURRENT ROW`, `<n> FOLLOWING`, `UNBOUNDED FOLLOWING`.

**`ROWS BETWEEN ...`** counts physical rows. `ROWS BETWEEN 6
PRECEDING AND CURRENT ROW` is "the previous six rows plus the current
one" — exactly 7 rows. Use when "the previous N data points" is what
you want, regardless of the time between them.

```sql
AVG(total) OVER (
  PARTITION BY user_id ORDER BY day
  ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
)
```

**`RANGE BETWEEN ...`** counts values of the `ORDER BY` expression.
`RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW` is "every
row where `day` falls in the last 7 days from the current row's
`day`."

```sql
AVG(total) OVER (
  PARTITION BY user_id ORDER BY day
  RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW
)
```

`RANGE` requires `ORDER BY` on a numeric or date type that supports
arithmetic. On Postgres, `INTERVAL` works for timestamps; on MySQL 8+
write `RANGE BETWEEN 6 PRECEDING` and it counts numeric units;
SQLite supports `RANGE` but only on numeric expressions. Use when
"the previous N days / units" is what you want, not "the previous N
rows."

**`GROUPS BETWEEN ...`** counts distinct `ORDER BY` value groups.
Less common; useful when ties should count as a single group rather
than `n` rows. Supported on Postgres 11+, recent SQLite, MySQL 8+.

**Default frame.** When `ORDER BY` is present and the frame is
omitted, the default is `RANGE BETWEEN UNBOUNDED PRECEDING AND
CURRENT ROW` — the running-total shape. When `ORDER BY` is absent,
the default is the whole partition. That's why a `SUM(total) OVER
(PARTITION BY user_id)` returns the same per-user total for every
row.

---

## Mongo `$setWindowFields`

Mongo doesn't speak SQL, but it has the same machinery under a
different name. `$setWindowFields` is the aggregation pipeline stage
that maps to `OVER (...)`. Added in Mongo 5.0.

```js
{
  $setWindowFields: {
    partitionBy: '$user_id',                     // PARTITION BY user_id
    sortBy:      { placed_at: 1 },               // ORDER BY placed_at ASC
    output: {
      running_total: {
        $sum: '$total',                          // SUM(total)
        window: { documents: ['unbounded', 'current'] },
      },
      rank: { $rank: {} },                       // RANK()
    },
  },
}
```

`partitionBy` is the `PARTITION BY` expression (skip for whole
collection); `sortBy` is the `ORDER BY`. `output` is one entry per
computed field. `window` is the frame clause in two flavours:
`documents: [start, end]` is the `ROWS` equivalent (values are
`'unbounded'`, `'current'`, or a signed integer); `range: [start,
end]` is the `RANGE` equivalent, with a `unit` (`'day'`, `'hour'`,
etc.) when `sortBy` is a date.

Accumulators include the obvious aggregates (`$sum`, `$avg`, `$min`,
`$max`, `$count`, `$stdDevPop`, `$stdDevSamp`) plus window-specific
ones:

| SQL | Mongo |
|---|---|
| `ROW_NUMBER()` | `{ $documentNumber: {} }` |
| `RANK()` | `{ $rank: {} }` |
| `DENSE_RANK()` | `{ $denseRank: {} }` |
| `LAG(field, n)` | `{ $shift: { output: '$field', by: -n, default: null } }` |
| `LEAD(field, n)` | `{ $shift: { output: '$field', by: n, default: null } }` |
| `FIRST_VALUE(field)` | `{ $first: '$field' }` with a partition-wide window |
| `LAST_VALUE(field)` | `{ $last: '$field' }` with a partition-wide window |

A 7-day moving sum uses `range` with `unit`:

```js
{
  $setWindowFields: {
    partitionBy: '$user_id', sortBy: { placed_at: 1 },
    output: { revenue_7d: { $sum: '$total', window: { range: [-6, 0], unit: 'day' } } },
  },
}
```

Semantics line up with SQL `RANGE BETWEEN INTERVAL '6 days' PRECEDING
AND CURRENT ROW`. Coverage gap: Mongo doesn't have `PERCENT_RANK` or
`CUME_DIST` as accumulators — emulate with `$documentNumber` and
arithmetic.

`$setWindowFields` runs typed through `db.<model>.aggregate({
pipeline })`, so you get decoded rows back (ObjectId → string,
embedded subdocs hydrated). Use `$runCommandRaw` to bypass the typed
pipeline DSL — same caveats as everywhere else.

---

## Common patterns

### Running total per customer

```ts
const rows = await db.$queryRaw<{ id: string; user_id: string; placed_at: Date; running: number }>`
  SELECT
    id,
    user_id,
    placed_at,
    SUM(total) OVER (PARTITION BY user_id ORDER BY placed_at) AS running
  FROM orders
  WHERE org_id = ${orgId}
    AND placed_at >= ${since}
  ORDER BY user_id, placed_at
`;
```

Each row carries the cumulative spend up to and including itself.
Plot per user → per-customer LTV chart line.

### Top-N per group

The CTE + filter pattern. Window first, filter on the rank in the
outer query:

```ts
const top3 = await db.$queryRaw<{ category_id: string; product_id: string; revenue: number; r: number }>`
  WITH ranked AS (
    SELECT
      category_id,
      id AS product_id,
      revenue,
      ROW_NUMBER() OVER (PARTITION BY category_id ORDER BY revenue DESC) AS r
    FROM products
    WHERE org_id = ${orgId}
  )
  SELECT category_id, product_id, revenue, r
  FROM ranked
  WHERE r <= 3
  ORDER BY category_id, r
`;
```

Use `RANK()` or `DENSE_RANK()` if "tied for 3rd should be included"
is the desired behaviour. The CTE is required because window-function
results aren't filterable in the same `WHERE` they're defined in.

### Moving averages

7-day and 30-day are the same shape, different bound. Plotted on the
same axis they're the canonical "are we trending or just noisy?"
chart. See worked example (b).

### Sessionization — gaps and islands

Split user events into sessions when there's a >30 minute gap. Two
windows stacked: the inner one tags new sessions with `LAG` + a gap
check, the outer one accumulates the flags into a session id. See
worked example (c).

The pattern generalises to "split this ordered sequence wherever the
gap is bigger than X." Same shape works for invoice statement
periods, login streaks, sensor data segmentation.

### Rank within group

A weekly leaderboard per organization:

```ts
const board = await db.$queryRaw<{ org_id: string; user_id: string; pts: number; rank: number }>`
  SELECT
    org_id,
    user_id,
    SUM(points) AS pts,
    RANK() OVER (PARTITION BY org_id ORDER BY SUM(points) DESC) AS rank
  FROM contributions
  WHERE at >= ${weekStart}
  GROUP BY org_id, user_id
  ORDER BY org_id, rank
`;
```

`RANK()` over `SUM(points)` runs after the `GROUP BY` — window
functions evaluate after aggregation, so `SUM(points)` is the
already-aggregated value at the window stage. That's how this query
works without a CTE.

---

## Performance

Windows aren't free. The engine sorts each partition (or scans it for
unordered windows) before computing the function. Two things to do
when a window query is slow:

### Index the partition + order columns

A composite index on `(partition_key, order_key)` lets the engine
avoid the sort:

```ts
// In the model file:
indexes: [
  { fields: { user_id: 1, placed_at: 1 } },
],
```

Postgres' planner will use this index for the sort step in
`SUM(total) OVER (PARTITION BY user_id ORDER BY placed_at)`. Without
it, every partition is sorted in memory or spilled to disk for big
tables. The forge `IndexDef` syntax is documented in
[docs/INDEXES.md](INDEXES.md).

### Bound the work

A naive `RANK() OVER (PARTITION BY user_id ORDER BY at)` on a table
of every event ever recorded does a partition-and-sort over
everything. Filter first:

```sql
WITH recent AS (
  SELECT * FROM events WHERE at >= ${cutoff}
)
SELECT
  user_id,
  id,
  RANK() OVER (PARTITION BY user_id ORDER BY at DESC) AS r
FROM recent
```

Same result, an order of magnitude less sorted data.

### `EXPLAIN ANALYZE` it

Window queries are the kind of SQL where the plan is the only
truth. Wrap the query in `EXPLAIN ANALYZE` (Postgres / MySQL /
SQLite) and look for:

* **Sort node above the WindowAgg.** That's the partition+order sort.
  If the row count is big, this is your hot spot.
* **Materialize node.** The plan is buffering the window's input into
  memory or disk. Add an index or shrink the filter.
* **Index Scan above the partition key.** Good — the engine used the
  composite index and skipped the sort.

**Mongo notes.** The engine sorts in memory by default. For
partitions bigger than 100MB, set `allowDiskUse: true` on the
aggregate. Index the `partitionBy` and `sortBy` fields the same way
as SQL — the planner uses them to avoid the in-memory sort.

---

## Typed results

`$queryRaw<T = any>` is generic; the shape you assert is the shape
TypeScript sees. For window queries that return a known model shape
plus a few computed columns, the cleanest typing is `Row<Model> &
{ extra }`:

```ts
import type { Row } from 'forge-orm';

type RankedOrder = Row<typeof Order> & { rank: number };

const ranked = await db.$queryRaw<RankedOrder>`
  SELECT
    o.*,
    RANK() OVER (PARTITION BY o.user_id ORDER BY o.total DESC) AS rank
  FROM orders o
  WHERE o.org_id = ${orgId}
`;
```

Two caveats covered in [docs/RAW-SQL.md](RAW-SQL.md#returning-shape-and-row-typing):

1. **No `decodeOutbound`.** `Row<typeof Order>` is the post-decode
   shape on Mongo. `$queryRaw` returns the raw driver shape, which on
   Mongo includes the BSON `ObjectId` instances. Hand-decode the rows
   or stick with the typed `aggregate({ pipeline })` surface.
2. **The driver's row shape is the truth.** SQLite booleans come
   back as `0 | 1`; MySQL `BIT(1)` is a `Buffer`. If the raw query
   reads a boolean column, hand-coerce or cast in SQL.

For pure-computed window rows (no model behind them) type the row
shape inline. Full type helper reference is in
[docs/TYPES.md](TYPES.md).

---

## Four worked examples

### (a) Top 3 products per category

```ts
type Top = {
  category_id: string;
  product_id:  string;
  title:       string;
  revenue:     number;
  rank:        number;
};

const top = await db.$queryRaw<Top>`
  WITH ranked AS (
    SELECT
      category_id,
      id    AS product_id,
      title,
      SUM(quantity * unit_price) AS revenue,
      RANK() OVER (
        PARTITION BY category_id
        ORDER BY SUM(quantity * unit_price) DESC
      ) AS rank
    FROM order_lines
    JOIN products ON products.id = order_lines.product_id
    WHERE order_lines.org_id = ${orgId}
      AND order_lines.placed_at >= ${since}
    GROUP BY category_id, products.id, products.title
  )
  SELECT category_id, product_id, title, revenue, rank
  FROM ranked
  WHERE rank <= 3
  ORDER BY category_id, rank
`;
```

The window aggregates over the grouped row's `SUM(quantity *
unit_price)` — that's allowed because window functions run after
`GROUP BY`. The `RANK() <= 3` filter sits in the outer query because
the window result can't appear in the same `WHERE` as the window
definition.

### (b) 7-day moving average revenue

```ts
type Day = { day: string; revenue: number; avg_7d: number };

const trend = await db.$queryRaw<Day>`
  WITH daily AS (
    SELECT
      date_trunc('day', placed_at)::date AS day,
      SUM(total)                         AS revenue
    FROM orders
    WHERE org_id = ${orgId}
      AND placed_at >= ${since}
    GROUP BY 1
  )
  SELECT
    day,
    revenue,
    AVG(revenue) OVER (
      ORDER BY day
      ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    ) AS avg_7d
  FROM daily
  ORDER BY day
`;
```

`ROWS BETWEEN 6 PRECEDING` works because the CTE guarantees one row
per day — so 7 rows is 7 days. For data with gaps (no row for days
with zero revenue), use `RANGE BETWEEN INTERVAL '6 days' PRECEDING`
instead. 30-day is the same shape with `29 PRECEDING`.

MySQL note: replace `date_trunc('day', placed_at)::date` with `DATE(placed_at)`.
SQLite: `date(placed_at)`. The window clause itself is portable.

### (c) Sessionize user events (30-minute gap)

```ts
type Event = {
  user_id:    string;
  event_id:   string;
  at:         Date;
  session_id: number;
};

const sessions = await db.$queryRaw<Event>`
  WITH gaps AS (
    SELECT
      user_id,
      id   AS event_id,
      at,
      CASE
        WHEN LAG(at) OVER (PARTITION BY user_id ORDER BY at) IS NULL
          THEN 1
        WHEN EXTRACT(EPOCH FROM at - LAG(at) OVER (PARTITION BY user_id ORDER BY at)) > 1800
          THEN 1
        ELSE 0
      END AS new_session
    FROM events
    WHERE org_id = ${orgId}
      AND at >= ${since}
  )
  SELECT
    user_id,
    event_id,
    at,
    SUM(new_session) OVER (PARTITION BY user_id ORDER BY at) AS session_id
  FROM gaps
  ORDER BY user_id, at, event_id
`;
```

Two windows. The inner one (`LAG` + gap calculation) tags each row
`new_session = 1` when the gap from the previous event exceeds 30
minutes (1800 seconds), or when it's the first row of the partition
(where `LAG` returns `NULL`). The outer one accumulates those flags
into a per-user session counter. Group by `(user_id, session_id)`
downstream for session-level metrics.

The `EXTRACT(EPOCH FROM ...)` form is Postgres. MySQL:
`TIMESTAMPDIFF(SECOND, LAG(at) OVER (...), at)`. SQLite:
`(julianday(at) - julianday(LAG(at) OVER (...))) * 86400`. The window
definitions are identical in every dialect; only the time-arithmetic
helper differs.

### (d) Mongo `$setWindowFields` equivalent

The running-total + day-over-day delta in one pipeline:

```ts
const rows = await db.order.aggregate({
  pipeline: [
    { $match: { org_id: orgId, placed_at: { $gte: since } } },
    {
      $setWindowFields: {
        partitionBy: '$user_id',
        sortBy:      { placed_at: 1 },
        output: {
          running_total: {
            $sum:   '$total',
            window: { documents: ['unbounded', 'current'] },
          },
          prev_total: {
            $shift: { output: '$total', by: -1, default: null },
          },
        },
      },
    },
    {
      $addFields: {
        delta: {
          $cond: [
            { $eq: ['$prev_total', null] },
            null,
            { $subtract: ['$total', '$prev_total'] },
          ],
        },
      },
    },
    { $sort: { user_id: 1, placed_at: 1 } },
  ],
});
```

Equivalent SQL:

```sql
SELECT
  id,
  user_id,
  placed_at,
  total,
  SUM(total) OVER (PARTITION BY user_id ORDER BY placed_at) AS running_total,
  total - LAG(total) OVER (PARTITION BY user_id ORDER BY placed_at) AS delta
FROM orders
WHERE org_id = $1 AND placed_at >= $2
ORDER BY user_id, placed_at;
```

The shapes match accumulator-for-accumulator. `$shift` is the Mongo
spelling of `LAG`; `$sum` with a partition-wide `window` is the
running-total accumulator. The typed `aggregate({ pipeline })` call
runs the result through `decodeOutbound`, so `_id` comes back as
strings, dates as JS `Date`, embeds hydrated — same shape as
`findMany`.

For pipeline operators Mongo doesn't expose through the typed DSL,
drop to `$runCommandRaw` — see
[docs/RAW-SQL.md](RAW-SQL.md#runcommandraw--the-mongo-bson-channel).

---

## Cross-links

* **[docs/RAW-SQL.md](RAW-SQL.md)** — `$queryRaw`, `forgeSql`,
  per-dialect placeholders, raw inside transactions.
* **[docs/QUERIES.md](QUERIES.md#aggregates--_avg-_sum-_min-_max)** —
  typed `aggregate` and `groupBy`, the row-collapsing surface.
* **[docs/MONGO.md](MONGO.md)** — Mongo pipeline surface, decoded
  rows, replica-set notes.
* **[docs/POSTGRES.md](POSTGRES.md)** / **[docs/MYSQL.md](MYSQL.md)**
  / **[docs/SQLITE.md](SQLITE.md)** — per-driver wiring and version
  notes (MySQL 8.0+, SQLite 3.25+ for window support).
* **[docs/INDEXES.md](INDEXES.md)** — composite indexes for the
  `(partition_key, order_key)` columns.
* **[docs/TYPES.md](TYPES.md)** — `Row<typeof Model>`, `Infer*`
  helpers, the decode-asymmetry rules that bite when you type a raw
  window result as a model shape.

Window functions sit at the edge of forge's typed surface. The typed
builder ends at `groupBy` because the result is one row per group;
windows want one row per source row. The patterns above are what raw
covers — running totals, ranks, moving averages, sessionization,
deltas. If your codebase keeps reaching for windows that aren't on
the list, that's a signal worth filing as an issue with the
window-shaped query you'd want forge to model.
