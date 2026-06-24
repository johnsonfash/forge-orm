# Materialized views

Pre-computed views stored as tables — refresh on a schedule, query as if free. This page covers the per-dialect support (Postgres native + CONCURRENTLY, MSSQL indexed views, Mongo `$merge`/`$out`, emulation for MySQL/SQLite), refresh strategies, the freshness window trade-off, and the patterns for dashboards and pre-aggregated reports.

The [`Materialised views`](./VIEWS.md#materialised-views) section in
`VIEWS.md` is the surface — the one-line `.asView({ materialised: true
})` API and the per-dialect refresh table. This file goes one level
down: when a matview earns the storage versus a plain view, a cache, or
a read replica; per-dialect emit and refresh semantics; the staleness
window trade-off; and the patterns for dashboards, leaderboards, and
analytical pre-aggregations.

Related deep-dives:

* [VIEWS.md](./VIEWS.md) — plain views, the `.asView()` API, and the read-only wrapper.
* [AGGREGATIONS.md](./AGGREGATIONS.md) — `groupBy`, `aggregate`, and the live-query equivalents matviews replace.
* [MIGRATIONS.md](./MIGRATIONS.md) — how matview DDL flows through `push` and `diff`.
* [CACHING.md](./CACHING.md) — query-result caching, the in-process alternative when freshness must be tighter.
* [POSTGRES.md](./POSTGRES.md) — `REFRESH MATERIALIZED VIEW CONCURRENTLY`, `pg_cron`, and `pg_ivm`.
* [MONGO.md](./MONGO.md) — `$out` and `$merge` aggregation outputs.

---

## Contents

* [What a materialized view is](#what-a-materialized-view-is)
* [When a matview earns the storage](#when-a-matview-earns-the-storage)
* [Per-dialect support](#per-dialect-support)
  * [Postgres](#postgres)
  * [MySQL](#mysql)
  * [SQLite](#sqlite)
  * [DuckDB](#duckdb)
  * [MSSQL](#mssql)
  * [Mongo](#mongo)
* [forge declaration — `materialised: true`](#forge-declaration--materialised-true)
* [Refresh strategies](#refresh-strategies)
* [Refresh scheduling](#refresh-scheduling)
* [Incremental matviews](#incremental-matviews)
* [Indexing a matview](#indexing-a-matview)
* [Permissions](#permissions)
* [Cost analysis — matview vs live view vs cache vs replica](#cost-analysis--matview-vs-live-view-vs-cache-vs-replica)
* [Staleness window — bound it in the product spec](#staleness-window--bound-it-in-the-product-spec)
* [Drift detection — what `forge diff` sees](#drift-detection--what-forge-diff-sees)
* [Use cases that earn a matview](#use-cases-that-earn-a-matview)
* [Worked examples](#worked-examples)
* [See also](#see-also)

---

## What a materialized view is

A materialised view stores the result of its SELECT physically on disk
and serves reads from the stored copy. It looks like a table at read
time — `forge` issues `SELECT * FROM post_stats` and the engine reads
rows from the matview's heap, not from `posts`. The catch is the stored
rows go stale the moment the source tables change; refreshing the
matview is an explicit operation (manual call, scheduled job, or
engine-maintained on the dialects that support it).

The shape that distinguishes it from a plain view:

* **Plain view** — a saved SELECT. Every query re-executes the body
  against the base tables. Storage cost: zero. Read cost: cost of the
  underlying join/aggregation.
* **Materialised view** — a saved result. Reads are a table scan plus
  whatever indexes you put on the matview. Storage cost: size of the
  result set. Write cost: zero at base-table write time on most
  dialects (the matview lags), or proportional to the change on
  engine-maintained matviews (MSSQL indexed views, `pg_ivm`).

The trade-off is freshness for read speed. A live aggregation that
takes 1.2s per query becomes a 12ms scan against a matview that
refreshes every 5 minutes — at the price of up to 5 minutes of
staleness.

What a matview is **not**:

* Not a cache. A cache evicts on TTL; a matview is authoritative until
  the next refresh.
* Not a snapshot. The data inside a matview is whatever the SELECT
  returned at refresh time, not a point-in-time copy of the source
  tables.
* Not a replication target. The matview lives in the same database as
  its source; cross-database replication is a different problem (see
  [DEPLOYMENT.md](./DEPLOYMENT.md)).

---

## When a matview earns the storage

Reach for a matview when all three are true:

1. **The query is expensive to compute live.** A multi-table aggregate
   that scans millions of rows; a recursive CTE traversing a tree; a
   window function over a year of events. If `EXPLAIN ANALYZE` shows
   the live query in tens or hundreds of milliseconds and the page hits
   it on every load, the storage trade is worth weighing.
2. **The result tolerates staleness.** Dashboards refreshed every five
   minutes. Leaderboards that update on the hour. Daily rollups that
   need yesterday's data, not the last second's. If the product spec
   demands sub-second freshness, a matview is the wrong primitive —
   reach for a cache layer or read-side denormalisation on write.
3. **The read rate beats the refresh rate.** A matview refreshed every
   minute that's queried twice an hour is wasted compute; the live
   query was cheaper. The matview earns when reads per refresh
   interval times their individual cost exceeds the cost of one
   refresh.

If only (1) is true, look at indexes on the base tables first; the
matview is treating the symptom. If only (2) is true, you don't need
the matview — just write the query. If only (3) is true, you don't
have a cost problem worth solving.

---

## Per-dialect support

`forge push` emits matview DDL in the same view pass as plain views,
after table DDL. Each adapter has its own shape.

### Postgres

The native one. `CREATE MATERIALIZED VIEW` stores the SELECT result as
a table; `REFRESH MATERIALIZED VIEW` recomputes it.

```sql
CREATE MATERIALIZED VIEW "post_stats" AS
  SELECT author_id,
         COUNT(*) AS post_count,
         COALESCE(SUM(view_count), 0) AS total_views
  FROM posts
  GROUP BY author_id
WITH DATA;
```

`WITH DATA` (the default) runs the SELECT immediately and populates
the matview on creation. `WITH NO DATA` creates an empty matview that
must be refreshed before it can be queried; useful when you want the
matview to exist but defer the first compute to a cron job.

**Standard refresh:**

```sql
REFRESH MATERIALIZED VIEW "post_stats";
```

Acquires an `ACCESS EXCLUSIVE` lock on the matview for the duration of
the refresh. Reads block. For a small matview this is fine; for a
matview a 30-second refresh takes, reads stall for 30 seconds.

**Concurrent refresh:**

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY "post_stats";
```

Builds a new version alongside the old one and swaps. Reads keep
hitting the old version throughout. **Requires a unique index** on the
matview — Postgres uses it to diff old against new and emit row-level
changes. Without a unique index, the statement errors:

```
ERROR: cannot refresh materialized view "post_stats" concurrently
HINT:  Create a unique index with no WHERE clause on one or more columns of the materialized view.
```

The unique index has to cover columns that uniquely identify a result
row — typically the grouping keys (`author_id` in the example above,
or `(author_id, day)` for a daily rollup). Forge does not auto-emit
this index; declare it via `.indexes` on the model:

```ts
const PostStats = model('post_stats', {
  author_id:   f.objectId(),
  post_count:  f.bigint(),
  total_views: f.bigint(),
})
  .asView({
    materialised: true,
    sql: `SELECT author_id, COUNT(*) AS post_count, …`,
  })
  .indexes(t => [
    t.unique(['author_id']),    // required for REFRESH CONCURRENTLY
  ]);
```

`forge push` emits a `CREATE UNIQUE INDEX` on the matview alongside
the matview itself.

Concurrent refresh is slower than non-concurrent (it has to build the
new copy plus diff plus apply), and writes locks during the swap. The
trade is read availability for refresh time.

Source: `src/adapters/postgres/ddl.ts` — `CREATE MATERIALIZED VIEW` emit
and the `refreshView` implementation that dispatches on
`opts.concurrently`.

### MySQL

No native matviews. Forge emulates with a regular table populated from
the SELECT body:

```sql
CREATE TABLE IF NOT EXISTS post_stats AS
  SELECT author_id, COUNT(*) AS post_count, …
  FROM posts
  GROUP BY author_id;
```

`refresh()` runs as a transaction:

```sql
START TRANSACTION;
DELETE FROM post_stats;
INSERT INTO post_stats SELECT …;
COMMIT;
```

Single transaction so readers either see the old copy or the new copy,
not a half-truncated one. The transaction holds row locks for the
duration of the delete + insert; long refreshes serialise against
writes to the matview backing table itself, but reads are not blocked
(InnoDB MVCC).

No CONCURRENTLY equivalent. The pattern when read availability has to
hold through refresh is **double-buffered tables**: write the new copy
into `post_stats_next`, then `RENAME TABLE post_stats TO
post_stats_old, post_stats_next TO post_stats` (atomic across both),
drop `post_stats_old`. Forge does not emit this pattern itself; write
it as a custom refresh function and override the model's `refresh`.

### SQLite

Same approach as MySQL — a regular table populated from the SELECT,
refreshed inside a transaction:

```sql
BEGIN;
DELETE FROM post_stats;
INSERT INTO post_stats SELECT …;
COMMIT;
```

SQLite serialises writers but readers can proceed against the matview
during the refresh (in WAL mode). The matview is registered as a table
in `sqlite_master`; `forge diff` accepts it under either `tables` or
`views`.

No CONCURRENTLY equivalent. The single-writer model means a long
refresh blocks other writes to the database for the duration; size
matviews accordingly.

### DuckDB

DuckDB views are read-only at the engine level, and there is no native
`MATERIALIZED VIEW`. Forge emulates with `CREATE TABLE AS SELECT`, the
same shape as the MySQL/SQLite emulation:

```sql
CREATE TABLE IF NOT EXISTS post_stats AS
  SELECT author_id, COUNT(*) AS post_count, …
  FROM posts
  GROUP BY author_id;
```

`refresh()` does a `DROP TABLE` + `CREATE TABLE AS SELECT` rather than
DELETE + INSERT — DuckDB's bulk-load path is faster than transactional
row writes for analytical workloads, which is the whole point of using
DuckDB. The trade is a brief window where the matview doesn't exist
between the drop and the create; the operation runs inside a
transaction so concurrent reads either see the old version or the new,
never an absent one.

### MSSQL

The distinguishing feature: **indexed views**. A view declared with
`WITH SCHEMABINDING` and a unique clustered index becomes engine-
maintained — the storage layer keeps the materialised state in sync
transactionally as the base tables change. No refresh call. No
staleness window. Writes to the source tables pay the cost of
maintaining the index.

```sql
CREATE VIEW [dbo].[post_stats] WITH SCHEMABINDING AS
  SELECT author_id,
         COUNT_BIG(*)         AS post_count,
         SUM(view_count)      AS total_views,
         COUNT_BIG(view_count) AS _vc_count
  FROM dbo.posts
  GROUP BY author_id;

CREATE UNIQUE CLUSTERED INDEX IX_post_stats_author
  ON [dbo].[post_stats] (author_id);
```

Restrictions on what can go in an indexed view are strict:

* `WITH SCHEMABINDING` required — the view body must use two-part names
  (`dbo.posts`, not `posts`), and the engine prevents schema changes to
  the base tables that would invalidate the view.
* No outer joins, no `UNION`, no `DISTINCT`, no `TOP`, no subqueries, no
  CTEs, no window functions.
* Aggregates allowed only as `SUM`, `COUNT_BIG`. `AVG` is not allowed;
  compute it as `SUM / COUNT_BIG` in a wrapping view.
* Every aggregate column needs a `COUNT_BIG` companion so the engine
  can maintain the count incrementally.

Forge does not auto-emit indexed views — the SCHEMABINDING constraints
make the DDL bespoke. The pattern is to declare the indexed view in a
raw migration SQL file, then point a regular `model('post_stats', …)`
at the view name (no `.asView()`). The model reads from the indexed
view as if it were a table; writes are blocked at the engine level
because indexed views are read-only.

The matview's `refresh()` is a no-op on MSSQL (and forge raises if you
call it) because the engine handles the maintenance.

### Mongo

Two output stages from the aggregation framework, both useful for
matview-shaped problems:

* `$out` — overwrite a target collection with the pipeline result.
  Total replace, no diff.
* `$merge` — upsert pipeline rows into a target collection, keyed on a
  `on` field. Supports `whenMatched: 'merge' | 'replace' | 'keepExisting'
  | 'fail' | 'pipeline'` and `whenNotMatched: 'insert' | 'discard' |
  'fail'`.

```ts
await db.posts.aggregate([
  { $match: { status: 'PUBLISHED' } },
  { $group: {
      _id: '$author_id',
      post_count: { $sum: 1 },
      total_views: { $sum: '$view_count' },
  }},
  { $merge: {
      into: 'post_stats',
      on: '_id',
      whenMatched: 'replace',
      whenNotMatched: 'insert',
  }},
]);
```

`$merge` is the better default — `$out` drops every read against the
matview during the swap, while `$merge` updates row-by-row and leaves
unchanged rows alone. For partial refreshes (only this hour's
authors), `$merge` lets the pipeline filter on the source side and
only touch the matching keys.

Forge appends `{ $out: collection }` automatically when you declare
`materialised: true` on a Mongo view and don't supply your own
terminal stage. To use `$merge` instead, end your pipeline with it
explicitly:

```ts
const PostStats = model('post_stats', { … }).asView({
  materialised: true,
  sourceCollection: 'posts',
  pipeline: [
    { $match: { status: 'PUBLISHED' } },
    { $group: { _id: '$author_id', post_count: { $sum: 1 } } },
    { $merge: { into: 'post_stats', on: '_id', whenMatched: 'replace', whenNotMatched: 'insert' } },
  ],
});
```

Forge sees the terminal `$merge` and skips its own `$out` append.

---

## forge declaration — `materialised: true`

The same `.asView()` surface as plain views, with `materialised: true`
flipping forge into matview mode:

```ts
import { f, model } from 'forge-orm';

const PostStats = model('post_stats', {
  author_id:   f.objectId(),
  post_count:  f.bigint(),
  total_views: f.bigint(),
})
  .asView({
    materialised: true,
    sql: `
      SELECT author_id,
             COUNT(*)                       AS post_count,
             COALESCE(SUM(view_count), 0)   AS total_views
      FROM posts
      GROUP BY author_id
    `,
    refreshEvery: '5m',
  })
  .indexes(t => [
    t.unique(['author_id']),    // Postgres CONCURRENTLY refresh requirement
  ]);
```

What changes versus a plain view:

* `forge push` emits `CREATE MATERIALIZED VIEW` (Postgres) or `CREATE
  TABLE AS …` (MySQL/SQLite/DuckDB) or a one-shot pipeline with `$out`
  (Mongo) instead of `CREATE VIEW`.
* The model wrapper exposes `db.postStats.refresh(opts?)` —
  synchronous refresh on demand.
* If `refreshEvery` is set, `db.postStats.scheduleRefresh(interval)` is
  called automatically when the db is opened. Returns a `stop()`
  function. Timers are `.unref()`'d so they don't keep the process
  alive.
* The wrapper is still read-only: `create`, `update`, `delete`, etc.
  throw the same `ForgeViewWriteError`. Writes go through the source
  models.

There is no separate `f.materializedView` constructor. It's
`.asView({ materialised: true })` on a regular `model()`.

---

## Refresh strategies

Three shapes, picked by access pattern.

**Full refresh.** Wipe and recompute the entire matview. Simplest, and
the only option on most dialects. Postgres calls this the
non-concurrent refresh; MySQL/SQLite/DuckDB call it the only refresh.

```ts
await db.postStats.refresh();
```

Cost: proportional to the size of the result set. Lock window:
proportional to the refresh time on Postgres non-concurrent and
MySQL/SQLite (transaction holds the matview).

**Concurrent refresh (Postgres).** Build the new version alongside,
swap atomically. Reads keep working throughout.

```ts
await db.postStats.refresh({ concurrently: true });
```

Cost: roughly 2x the non-concurrent refresh (build new + diff + apply
delta). Requires a unique index on the matview. Lock window: brief
exclusive lock at swap time, measured in milliseconds.

**Incremental refresh (manual).** Recompute only the rows whose source
data changed since the last refresh. Forge does not have a built-in
incremental refresh primitive; the pattern is application-level:

1. Track a `_last_refreshed_at` column on the matview, or store a
   last-refresh timestamp in a side table.
2. Refresh by `INSERT … ON CONFLICT DO UPDATE` (Postgres) or `INSERT
   … ON DUPLICATE KEY UPDATE` (MySQL) keyed on the matview's unique
   columns, with a `WHERE source.updated_at > $1` clause filtering the
   source SELECT.
3. Run the partial refresh on a tighter cadence than the full refresh;
   schedule a full refresh nightly to catch deletes (which the
   `updated_at` predicate misses).

Worth it when the matview is large (millions of rows) but only a small
slice changes between refreshes. Not worth it when the result set is
small enough that a full refresh runs in under a second.

---

## Refresh scheduling

Four shapes, smallest blast radius first.

**`refreshEvery` (in-process timer).** Forge schedules a `setInterval`
that calls `refresh()`. Good for single-process services and dev. Bad
for multi-process deployments — every process refreshes, you get N
concurrent refreshes instead of one.

```ts
.asView({ materialised: true, refreshEvery: '5m', sql: … })
```

Suffixes: `s` / `m` / `h`. The timer is `.unref()`'d. Errors are
swallowed into the `$on('error')` channel so a transient DB blip
doesn't kill the process.

**External cron (BullMQ, cron, systemd).** A single scheduled job
calls `db.postStats.refresh()`. The cron orchestrator handles
single-execution semantics (BullMQ's `removeOnComplete`, `cron`'s
`startNow: false`).

```ts
queue.add('refresh-post-stats', null, {
  repeat: { every: 5 * 60 * 1000 },
  removeOnComplete: true,
});

new Worker('refresh-post-stats', async () => {
  await db.postStats.refresh({ concurrently: true });
});
```

The right choice for production. One refresh per interval across the
fleet; failure surfaces in the queue's failure handler.

**Database-side cron (`pg_cron`).** A Postgres extension that runs SQL
on a cron schedule, inside the database. No application process
needed.

```sql
SELECT cron.schedule(
  'refresh-post-stats',
  '*/5 * * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY post_stats$$
);
```

Runs even when no application is connected. Status visible via
`cron.job_run_details`. The right choice when the matview's refresh
shouldn't depend on application liveness — e.g. analytics matviews
that have to refresh through deployments.

**Trigger-based.** A trigger on the source table fires the refresh on
every write. Almost always wrong — a 30-second refresh blocking
every INSERT is a denial-of-service against your own application.
The right shape if you genuinely need write-time matview maintenance
is MSSQL indexed views (engine-maintained, no triggers), Postgres
`pg_ivm` (extension, below), or a Mongo `$merge` on each write
(application-level, costed per write).

---

## Incremental matviews

`pg_ivm` (an extension for Postgres) implements **incremental view
maintenance**: matviews that the engine updates row-by-row as the
source tables change, the same way MSSQL indexed views work.

```sql
CREATE EXTENSION pg_ivm;

SELECT pgivm.create_immv(
  'post_stats',
  $$SELECT author_id, COUNT(*) AS post_count
    FROM posts
    GROUP BY author_id$$
);
```

`pgivm.create_immv` declares the matview and installs triggers on the
source tables. Every INSERT/UPDATE/DELETE on `posts` fires a delta
into `post_stats`. No `REFRESH` needed; no staleness window.

Cost: each source write pays a small overhead to update the matview.
Restrictions: a subset of SELECT is supported — most aggregations,
inner joins, outer joins (with caveats), `DISTINCT`, but not window
functions, recursive CTEs, or `OUTER JOIN` on the inner side. Read the
extension's docs before adopting.

Forge does not currently auto-emit `pg_ivm` matviews; declare them in
raw migration SQL and point a regular `model()` at the matview name.
Add the matview to `forge diff`'s ignore list so it doesn't try to
recreate it as a table.

For dialects without `pg_ivm`: incremental maintenance is application-
level. The pattern is the same as for partial refresh above — track an
`updated_at` watermark, refresh only the slice that changed. Cheaper
than a full refresh, but not as crisp as engine-maintained.

---

## Indexing a matview

A matview is a table — index it like one. Two reasons:

**1. `REFRESH CONCURRENTLY` requirement.** Postgres needs a unique
index covering the row identity columns. Without it, only blocking
refresh is available.

**2. Read performance.** A matview that wraps a `GROUP BY author_id`
aggregation will be queried by `author_id` most of the time; the
unique index doubles as the lookup index. Add additional indexes for
secondary access patterns (e.g. `ORDER BY total_views DESC` for a
top-N query needs an index on `total_views`).

Indexes on a matview are independent of indexes on the source tables.
The source indexes speed up the refresh; the matview indexes speed up
reads off the matview. Both matter.

```ts
.asView({ materialised: true, sql: … })
.indexes(t => [
  t.unique(['author_id']),                     // REFRESH CONCURRENTLY + lookup
  t.index(['total_views'], { sort: 'desc' }),  // ORDER BY total_views DESC
])
```

`forge push` emits the index DDL alongside the matview DDL. On
Postgres, `REINDEX MATERIALIZED VIEW` rebuilds the indexes (useful
after a bloat-heavy period); forge does not call it automatically.

---

## Permissions

A matview is a separate object from its source tables, with its own
GRANTs. The standard pattern:

```sql
-- The role that runs the application reads from the matview, not the
-- source tables. Reduces the blast radius if the connection leaks.
GRANT SELECT ON post_stats TO app_role;

-- The role that runs the refresh job has write on the matview only.
GRANT SELECT, INSERT, UPDATE, DELETE ON post_stats TO refresh_role;
-- Plus REFRESH MATERIALIZED VIEW privilege:
GRANT MAINTAIN ON post_stats TO refresh_role;   -- Postgres 17+
-- On earlier Postgres, MAINTAIN doesn't exist; OWNERSHIP of the
-- matview is required to call REFRESH. Set the refresh role as the
-- owner: ALTER MATERIALIZED VIEW post_stats OWNER TO refresh_role.
```

Two roles avoids the trap of granting the application role permission
to issue refreshes — a runaway request loop that triggers refreshes
will lock the matview and break read availability.

On Mongo, role separation is the same — give the application read on
the matview collection and give the refresh job write. `$merge` and
`$out` require write permission on the target collection.

See [SECURITY.md](./SECURITY.md) for the broader role pattern.

---

## Cost analysis — matview vs live view vs cache vs replica

Four primitives, four sets of trade-offs.

| Primitive | Where it lives | Freshness | Read cost | Write cost | Storage | Best for |
|---|---|---|---|---|---|---|
| Live view | Same DB | Real-time | Cost of query | None | None | Saved query / security boundary |
| Materialised view | Same DB | Refresh window | Table scan | Refresh time | Result size | Pre-aggregated dashboard |
| Engine-maintained matview | Same DB | Real-time | Table scan | Per-row overhead | Result size | Hot aggregate that must be fresh |
| Cache (Redis, in-process) | Separate process | TTL | Network round-trip | Cache write | Result size, per cache | Read-amplified key lookups |
| Read replica | Separate DB | Replication lag | Cost of query, replica load | Replication overhead | Full DB copy | OLAP queries against OLTP shape |

Decision sketch:

* If the query is hot but the staleness window is in minutes/hours,
  matview wins. The storage is small relative to the source tables;
  the refresh cost is paid once and spread across all reads.
* If the query needs sub-second freshness and you can afford the
  per-write cost, engine-maintained matview (MSSQL indexed view or
  `pg_ivm`) wins. Pay at write time, read for free.
* If the same key is read many times with a TTL of seconds to minutes,
  a cache wins. The matview's refresh window is too coarse; a cache's
  TTL matches the access pattern.
* If the workload is "run arbitrary BI queries against the same
  schema as the OLTP database", a read replica wins. Matviews
  pre-aggregate a known query; a replica supports any query the BI
  tool happens to write.

The mistake is reaching for a matview when a covering index would do.
If the live query is slow because of a missing index, the matview
ships the same slow query into the refresh and adds a freshness
window. Diagnose with `EXPLAIN` first.

---

## Staleness window — bound it in the product spec

A matview's freshness window is part of the product contract. Bake it
into the API and the UI:

* **API response.** Every matview-backed endpoint returns
  `last_refreshed_at`. Clients display "Updated 4 minutes ago" so the
  user knows they're not looking at live data.
* **Cache headers.** Set `Cache-Control: max-age=N` on the response,
  where N is the matview's refresh interval. The HTTP cache and the
  matview share a freshness contract.
* **Health check.** If the matview's `last_refreshed_at` falls behind
  by more than 2× the refresh interval, page the on-call. A stuck
  refresh job is the most common silent failure mode — the matview
  keeps returning stale data, reads succeed, no error fires.

Storing `last_refreshed_at` on the matview itself:

```ts
const PostStats = model('post_stats', {
  author_id:          f.objectId(),
  post_count:         f.bigint(),
  total_views:        f.bigint(),
  last_refreshed_at:  f.dateTime(),
}).asView({
  materialised: true,
  sql: `
    SELECT author_id,
           COUNT(*)                AS post_count,
           SUM(view_count)         AS total_views,
           NOW()                   AS last_refreshed_at
    FROM posts
    GROUP BY author_id
  `,
});
```

`NOW()` evaluates at refresh time; every row gets the same timestamp.
Useful for the cache-header pattern: read any row, take its
`last_refreshed_at`, set `Cache-Control` accordingly.

Alternative: store the last-refresh time in a side table, keyed by
matview name. Cleaner if you have many matviews and don't want to add
a column to each.

---

## Drift detection — what `forge diff` sees

Forge introspects materialised views per dialect:

* **Postgres** — `pg_matviews` returns matviews with their definition.
  Forge feeds them into `introspection.views` with `materialised: true`
  set (see `src/adapters/postgres/introspect.ts:74`). `diff` compares
  the set of matview names; a missing one is flagged.
* **MySQL** / **SQLite** / **DuckDB** — the matview backing table
  appears in the table list. Forge's diff accepts a table whose name
  matches a declared matview under either `tables` or `views`.
* **MSSQL** — view introspection is currently best-effort (`views: []`
  in the introspect output). Indexed views are the recommended shape
  on MSSQL; declare them in raw migration SQL and ignore in `diff`.
* **Mongo** — `db.listCollections()` reports the matview collection as
  a regular collection (it's a real collection populated by the
  pipeline). Forge's diff treats it as a table-like collection; the
  pipeline body is not compared.

What `diff` does **not** currently report:

* Whether the matview's SELECT body matches the schema. Forge re-emits
  the body on every `push`, so push always converges; diff doesn't
  flag "the body changed since last push".
* Whether the matview is up to date. Staleness is a runtime concern,
  not a schema concern.
* Whether the matview's indexes match what `.indexes()` declared.
  Index drift on the matview is tracked under the same code path as
  index drift on a table; `diff` reports it normally.

What `push` does on a matview body change:

* **Postgres** — `CREATE OR REPLACE MATERIALIZED VIEW` does not exist;
  body changes require `DROP MATERIALIZED VIEW` + `CREATE MATERIALIZED
  VIEW`. Forge does not auto-drop on push; it surfaces the
  `ERROR: relation "post_stats" already exists` from Postgres. You
  drop manually and re-push.
* **MySQL/SQLite/DuckDB** — same story. The matview is a backing
  table; body changes need a manual drop.
* **Mongo** — drop + recreate is automatic, the same as for plain
  views.

The right pattern for matview body changes is the same as for table
schema changes: explicit migration SQL that drops the matview, runs
the new DDL, and triggers an initial refresh.

---

## Use cases that earn a matview

* **Dashboard tiles.** A homepage that shows "Total revenue", "Active
  users this week", "Orders shipped today". The numbers come from
  aggregations over millions of rows; the page loads N times a second;
  the user accepts a 5-minute lag. Classic matview shape.
* **Leaderboards.** Top-10 contributors by score, top-100 most-played
  songs this week. The aggregation scans the full event log; the
  result is tiny (10 or 100 rows); the freshness window is hourly.
  Index the matview by score for the `ORDER BY score DESC LIMIT 10`
  query.
* **Top-N queries.** Per-tenant top-5 customers by lifetime value.
  Compute once per tenant in the matview, query by `(tenant_id, rank)`
  at read time.
* **Daily/hourly rollups.** Hourly buckets of event counts for a
  time-series chart. The matview holds one row per bucket; the live
  query would scan every event. Rebuild the last few hours on a tight
  cadence, the older buckets nightly.
* **Search facets.** Counts of products by category, brand, price
  band. The faceted-search UI hits these on every page load; the live
  query is multiple `GROUP BY`s over the product catalog.
* **Reports/exports.** A nightly CSV export pulls from a matview that
  pre-joins the underlying tables. The export is a fast table scan;
  the matview refreshes once per day before the export window.

Use cases that do **not** earn a matview:

* **The live result fits in cache.** A single-row lookup keyed on
  `(tenant_id, day)` belongs in Redis, not a matview.
* **Freshness is in seconds.** A matview's refresh window is its
  promise. Sub-second freshness means write-time denormalisation or
  engine-maintained matviews, not refresh-on-cron.
* **The query is run once per page-load and there's only one
  page-load per minute.** The live cost is fine; the matview is
  overhead.

---

## Worked examples

### (a) Postgres dashboard refreshed every 5 minutes via pg_cron

```ts
// schema.ts
import { f, model } from 'forge-orm';

export const DashboardStats = model('dashboard_stats', {
  day:                f.date(),
  org_id:             f.objectId(),
  orders_placed:      f.int(),
  revenue_cents:      f.bigint(),
  unique_customers:   f.int(),
  last_refreshed_at:  f.dateTime(),
})
  .asView({
    materialised: true,
    sql: `
      SELECT date_trunc('day', placed_at)::date AS day,
             org_id,
             COUNT(*)                            AS orders_placed,
             COALESCE(SUM(total_cents), 0)       AS revenue_cents,
             COUNT(DISTINCT customer_id)         AS unique_customers,
             NOW()                               AS last_refreshed_at
      FROM orders
      WHERE status IN ('PAID', 'SHIPPED')
        AND placed_at >= NOW() - INTERVAL '90 days'
      GROUP BY 1, 2
    `,
  })
  .indexes(t => [
    t.unique(['day', 'org_id']),                 // CONCURRENTLY refresh
    t.index(['org_id', 'day'], { sort: 'desc' }),
  ]);
```

Schedule via `pg_cron` (one-time setup, runs in the database):

```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'refresh-dashboard-stats',
  '*/5 * * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY dashboard_stats$$
);
```

Read at request time:

```ts
const rows = await db.dashboardStats.findMany({
  where: { org_id: ctx.org, day: { gte: thirtyDaysAgo } },
  orderBy: { day: 'desc' },
});

const refreshedAt = rows[0]?.last_refreshed_at;
res.setHeader('Cache-Control', 'max-age=300');     // matches the 5-minute refresh
res.setHeader('Last-Modified', refreshedAt.toUTCString());
res.json({ rows, refreshedAt });
```

### (b) MySQL emulation via INSERT INTO … SELECT

```ts
export const PostStats = model('post_stats', {
  author_id:    f.objectId(),
  post_count:   f.bigint(),
  total_views:  f.bigint(),
}).asView({
  materialised: true,
  sql: `
    SELECT author_id,
           COUNT(*) AS post_count,
           COALESCE(SUM(view_count), 0) AS total_views
    FROM posts
    GROUP BY author_id
  `,
}).indexes(t => [
  t.unique(['author_id']),
]);
```

`forge push` emits:

```sql
CREATE TABLE IF NOT EXISTS post_stats (
  author_id   BINARY(12) NOT NULL,
  post_count  BIGINT NOT NULL,
  total_views BIGINT NOT NULL,
  UNIQUE KEY uq_post_stats_author (author_id)
);
```

The first call to `refresh()` populates the table; subsequent calls
reload it:

```ts
await db.postStats.refresh();
// Runs:
//   START TRANSACTION;
//   DELETE FROM post_stats;
//   INSERT INTO post_stats (author_id, post_count, total_views)
//     SELECT author_id, COUNT(*), COALESCE(SUM(view_count), 0)
//     FROM posts GROUP BY author_id;
//   COMMIT;
```

Schedule from a BullMQ worker:

```ts
new Worker('matview-refresh', async (job) => {
  if (job.name === 'post-stats') {
    await db.postStats.refresh();
  }
});

await queue.add('post-stats', null, {
  repeat: { every: 5 * 60 * 1000 },
  removeOnComplete: { count: 100 },
});
```

For read-availability through long refreshes, switch to the
double-buffer pattern (atomic `RENAME TABLE` swap of two tables). Out
of scope for forge's default emit; write as a custom refresh function.

### (c) Mongo `$merge` for daily rollups

```ts
export const DailySales = model('daily_sales', {
  _id:                f.string(),               // composite "YYYY-MM-DD:orgId"
  day:                f.date(),
  org_id:             f.objectId(),
  orders_placed:      f.int(),
  revenue_cents:      f.bigint(),
  last_refreshed_at:  f.dateTime(),
}).asView({
  materialised: true,
  sourceCollection: 'orders',
  pipeline: [
    { $match: { status: { $in: ['PAID', 'SHIPPED'] } } },
    { $group: {
        _id: {
          day: { $dateTrunc: { date: '$placed_at', unit: 'day' } },
          org_id: '$org_id',
        },
        orders_placed: { $sum: 1 },
        revenue_cents: { $sum: '$total_cents' },
    }},
    { $project: {
        _id: { $concat: [
          { $dateToString: { date: '$_id.day', format: '%Y-%m-%d' } },
          ':',
          { $toString: '$_id.org_id' },
        ]},
        day: '$_id.day',
        org_id: '$_id.org_id',
        orders_placed: 1,
        revenue_cents: 1,
        last_refreshed_at: '$$NOW',
    }},
    { $merge: {
        into: 'daily_sales',
        on: '_id',
        whenMatched: 'replace',
        whenNotMatched: 'insert',
    }},
  ],
});
```

The terminal `$merge` is explicit, so forge does not append its
default `$out`. The matview upserts row-by-row; reads against
`daily_sales` are never disrupted by a refresh.

Refresh by running the pipeline:

```ts
await db.dailySales.refresh();   // runs the stored pipeline against the source collection
```

For partial refresh — only today's rows — write a separate refresh
job that re-runs the pipeline with a `$match` on `placed_at >= startOfToday`:

```ts
await db.orders.aggregate([
  { $match: {
      status: { $in: ['PAID', 'SHIPPED'] },
      placed_at: { $gte: startOfToday },
  }},
  // …rest of the pipeline, ending with $merge…
]);
```

`$merge` only touches the rows the pipeline emits, so partial refresh
costs proportional to the changed slice.

### (d) MSSQL indexed view with SCHEMABINDING

The pattern: declare the indexed view in raw migration SQL, point a
regular forge `model()` at it, exclude it from `forge diff`.

**Migration SQL** (`migrations/2026-06-24_post_stats_indexed.sql`):

```sql
CREATE VIEW [dbo].[post_stats] WITH SCHEMABINDING AS
  SELECT author_id,
         COUNT_BIG(*)         AS post_count,
         SUM(view_count)      AS total_views,
         COUNT_BIG(view_count) AS _vc_count    -- required so SUM is maintainable
  FROM dbo.posts
  GROUP BY author_id;

CREATE UNIQUE CLUSTERED INDEX IX_post_stats_author
  ON [dbo].[post_stats] (author_id);
```

**Forge model**:

```ts
export const PostStats = model('post_stats', {
  author_id:   f.objectId(),
  post_count:  f.bigint(),
  total_views: f.bigint(),
});
```

No `.asView()` — the engine is maintaining the view; forge reads from
it as if it were a table. The `_vc_count` companion column doesn't
appear in the model because reads don't need it.

**Exclude from diff**:

```bash
forge diff --ignore=post_stats
```

Otherwise `diff` reports `post_stats` as a missing table (the model
declares it, but introspection won't see it as a table — it's a view
with a clustered index).

**Reads**:

```ts
const stats = await db.postStats.findMany({
  where: { author_id: { in: authorIds } },
});
```

The query planner uses the indexed view automatically when it covers
the query. No `refresh()` call — the engine maintained the index
transactionally as `posts` was written.

The trade: every INSERT/UPDATE/DELETE on `posts` pays a small overhead
to maintain the indexed view. For a hot OLTP table, profile under
write load before adopting; for a cold-write/hot-read table, it's the
right primitive.

---

## See also

* [VIEWS.md](./VIEWS.md) — plain views, the `.asView()` API, read-only wrappers, and the per-dialect view DDL.
* [AGGREGATIONS.md](./AGGREGATIONS.md) — `groupBy`, `aggregate`, and the live-query shapes a matview pre-computes.
* [MIGRATIONS.md](./MIGRATIONS.md) — matview DDL through `push` and `diff`, ignore patterns for engine-maintained matviews.
* [CACHING.md](./CACHING.md) — query-result cache, the tighter-freshness alternative when minutes of staleness is too much.
* [POSTGRES.md](./POSTGRES.md) — `REFRESH MATERIALIZED VIEW CONCURRENTLY`, `pg_cron`, `pg_ivm`, and matview-specific GRANTs.
* [MONGO.md](./MONGO.md) — `$out` vs `$merge`, pipeline-as-matview, and the `last_refreshed_at` field pattern.
* [DEPLOYMENT.md](./DEPLOYMENT.md) — running matview refresh jobs through deploys, single-execution patterns under multi-process fleets.
