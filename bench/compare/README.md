# Comparison benchmarks

Two kits live here.

* `compare-bench.ts`: the original four trivial scenarios on one `users` table,
  forge vs Prisma vs Drizzle vs the raw driver. Run through
  `npm run forge:bench:compare[:pg|:mysql|:sqlite|:mongo]`.
* `deep/`: the deep comparison described below. It exists to find forge's weak
  spots on realistic, relational work: deep includes, relation filters,
  many-to-many, aggregates, JSON, full-text, geo, streaming, nested writes,
  transactions and concurrency.

## Running the deep comparison

One dialect per invocation. Never run several at once; the numbers are only
meaningful on a quiet machine.

```sh
npm run forge:bench:deep:gen                       # once: generate the Prisma clients
npm run forge:bench:deep -- --dialect=sqlite
npm run forge:bench:deep -- --dialect=postgres
npm run forge:bench:deep -- --dialect=mysql
npm run forge:bench:deep -- --dialect=mongo
npm run forge:bench:deep -- --dialect=duckdb
npm run forge:bench:deep -- --dialect=mssql        # needs a SQL Server, see below
npm run forge:bench:deep -- --dialect=mssql --capture-only
```

Options:

| flag | meaning |
|---|---|
| `--dialect=` | required: `postgres`, `mysql`, `sqlite`, `mongo`, `duckdb`, `mssql` |
| `--scenario=a,b` | only these scenarios |
| `--engines=forge,raw` | only these engines (default all six: `raw,forge,prisma,drizzle,kysely,knex`) |
| `--capture-only` | no server: record the SQL forge generates for every scenario against a stub driver (SQL dialects only) |

Environment:

| variable | default | meaning |
|---|---|---|
| `BENCH_SEED` | `1000` | users. Posts = 10x, comments = 50x, 50 tags, places = users |
| `BENCH_ITER` | `30` | measured iterations per engine per scenario |
| `BENCH_LATENCY_MS` | `0` | simulated network latency: every Postgres / MySQL round trip waits this long before it is sent, for every engine alike (Postgres only is reliable today: on MySQL the delayed callbacks break mysql2's command ordering inside transactions, so MySQL latency runs error; not SQLite, DuckDB or Mongo) |
| `BENCH_WARMUP` | `max(2, ITER/10)` | warm-up iterations, not measured |
| `BENCH_PG_URL` | `postgres://postgres@127.0.0.1:5432/postgres` | admin connection; a scratch database is created and dropped |
| `BENCH_MYSQL_URL` | `mysql://root@127.0.0.1:3306` | same, for MySQL / MariaDB |
| `BENCH_MONGO_URL` | `mongodb://127.0.0.1:27017` | a scratch database is created and dropped |
| `BENCH_MSSQL_URL` | `mssql://sa:Forge_Bench_1@127.0.0.1:1433/master` | same, for SQL Server |

SQLite and DuckDB use a temp file that is removed at the end. Every run cleans
up in a `finally`, so a failed run still drops its scratch database.

A quick wiring check: `BENCH_SEED=50 BENCH_ITER=3 npm run forge:bench:deep -- --dialect=sqlite`.

The script runs with `TZ=UTC`, so every driver that interprets a naive
`DATETIME` as local time agrees with the others.

Kysely 0.29 is ESM-only and is loaded through `require(esm)`, so Node 22 or
newer is needed for that engine.

## The schema

Defined once with forge in `deep/schema.ts`; forge's DDL creates the tables (and
`$migrate()` builds the Mongo indexes). Prisma (`deep/prisma/*.prisma`) and
Drizzle (`deep/drizzle-schema.ts`) only describe those tables; Kysely and Knex
use them untyped.

* `users`: unique email, role enum, active, created_at, `prefs` JSON
* `profiles`: 1:1 with users (`user_id` unique, cascade)
* `posts`: author FK cascade, title, searchable `body`, status enum, views, version, published_at, `meta` JSON
* `comments`: post FK cascade, author FK set null, self-referencing `parent_id`
* `tags` + `post_tags`: many-to-many through an explicit join table
* `places`: a geo point with a spatial index (SQLite uses forge's fallback mode: JSON + Haversine)

Ids are caller-supplied, zero-padded strings, so every engine can be compared
row for row, Mongo included (stored verbatim as `_id`). The seed is
deterministic.

## Engines

| engine | how it is written |
|---|---|
| `raw` | hand-written SQL through the native driver (or the native Mongo driver). The baseline. |
| `forge` | the forge API, one implementation for every dialect |
| `prisma` | Prisma 7 with its driver adapters (pg, mariadb, better-sqlite3) |
| `drizzle` | core builder for flat work, relational queries (`db.query...with`) for includes |
| `kysely` | builder; includes through the `jsonArrayFrom` / `jsonObjectFrom` helpers |
| `knex` | builder; includes as one `whereIn` query per level |

Each engine is written the way a competent user of it would write the query:
its own idiomatic best, not a translation of another engine's SQL. Where an
engine has no API for something (geo for every ORM, JSON paths and full-text
for the builders) it either uses its `sql` / `raw` escape hatch, if that is
what its users do, or is marked n/a with the reason.

**raw baseline for relations.** Raw loads one level per query with `IN` lists
(window functions where a level is limited per parent) and uses a single join
or correlated subquery where that is clearly best (`m2m_post_tags`,
`count_rel`). That is a careful hand-written data layer, not the theoretical
minimum: a single `json_agg` / `LATERAL` statement is possible on some
dialects, which is what the Drizzle and Kysely engines do.

### Engine support by dialect

| | postgres | mysql | sqlite | mongo | duckdb | mssql |
|---|---|---|---|---|---|---|
| raw | yes | yes | yes | yes | yes | yes |
| forge | yes | yes | yes | yes | yes | yes |
| prisma | yes | yes | yes | n/a: Prisma 7 has no MongoDB | n/a: no provider | n/a: `@prisma/adapter-mssql` not installed |
| drizzle | yes | yes | yes | n/a | n/a: no official driver | n/a: no SQL Server dialect in 0.45 |
| kysely | yes | yes | yes | n/a | n/a: no first-party dialect | yes |
| knex | yes | yes | yes | n/a | n/a: no client | yes |

Scenario-level n/a (each is printed in the report with its reason):

* `geo_near`: forge and raw only.
* `fts`: Prisma has none on SQLite; on MSSQL every engine is n/a because full-text needs a `FULLTEXT CATALOG` created out of band (forge's emitted SQL is still visible with `--capture-only`).
* `json_prefs`, `json_meta`: Prisma has no JSON path filter on SQLite.
* `stream`: Prisma has no streaming read; Drizzle only on mysql2; Kysely and Knex need `pg-cursor` / `pg-query-stream` on Postgres (not installed).
* `tx_*` on Mongo: needs a replica set; detected at start.

## Scenarios

Reads

| scenario | what must come back |
|---|---|
| `pk` | one user by primary key |
| `unique_email` | one user by unique email |
| `filter_offset` | users `role = USER AND active AND created_at` in a range, `ORDER BY created_at DESC, id`, offset 20 limit 20 |
| `cursor` | 20 posts after a cursor id (exclusive), by id |
| `count_filter` | count of published posts with `views >= 500` |
| `exists` | boolean: a user with this email exists |
| `select_cols` | one author's posts, id/title/views only |
| `in_100` | users whose id is in a 100-element list |
| `or_not_like` | `(name ILIKE %alice% OR email LIKE 'bob.%') AND NOT role = ADMIN` |
| `rel_some` / `rel_none` / `rel_every` | users with some / no / only published posts |
| `include_1` | published posts + author |
| `include_2` | users -> posts -> comments |
| `include_3` | active users -> posts (published, newest first, take 5) -> comments (take 3) -> author |
| `m2m_post_tags` | posts with their tags through `post_tags` |
| `m2m_tag_counts` | every tag with its post count |
| `count_rel` | users with `_count` of posts and comments |
| `aggregate` | count / sum / avg / min / max of views over published posts |
| `groupby` | non-draft posts grouped by author, `HAVING count >= 7`, ordered by `sum(views)` |
| `distinct` | distinct authors of low-view posts |
| `json_prefs` | users where `prefs.theme = 'dark' AND prefs.score >= 20` |
| `json_meta` | count of posts where `meta.lang = 'fr' AND meta.score >= 90` |
| `fts` | posts whose body matches a word |
| `geo_near` | places within 5 km of a point, nearest first |
| `large_findmany` | 10 000 posts materialised |
| `stream` | the same 10 000 rows consumed through the engine's streaming API |

Writes (each engine works on its own rows; ids embed the engine name)

| scenario | what is checked |
|---|---|
| `create` | one user, returned |
| `create_many` | 1 000 users in one call, count |
| `nested_create` | user + profile + 3 posts, first post tagged with 2 existing tags and 1 new one via `connectOrCreate`, in one call; checked by reading the tree back |
| `update_by_id` | rename, return the row |
| `update_many` | set `views = 42` on one author's posts, count |
| `increment_concurrent` | 20 concurrent `views += 1` on one row; the final value must be exactly 20 |
| `upsert_insert` / `upsert_update` | both paths of an upsert on the unique email |
| `delete_cascade` | delete a user owning posts, comments and tag links; none may remain |
| `delete_many` | delete 100 users by a filter, count |
| `tx_interactive` | interactive transaction with 5 dependent steps |
| `tx_rollback` | a transaction that throws; nothing may persist |
| `optimistic_update` | update `WHERE id AND version` wins once and loses with the stale version |

Fixtures for writes (rows to delete, rows to increment) are made and removed
through forge with round-trip counting paused, so they never count towards any
engine's time.

## What is measured

For every engine x scenario:

* median and p95 latency, ops/sec, over `BENCH_ITER` iterations after warm-up;
* **round trips**: every driver call is counted at the driver itself
  (`deep/instrument.ts` wraps `pg.Client.query`, mysql2's connection
  `query`/`execute`, better-sqlite3 statements, DuckDB connection methods,
  tedious for SQL Server, and Mongo command monitoring). The one exception is
  Prisma on MySQL, which talks through `mariadb` and is counted with Prisma's
  own query event. `BEGIN` / `COMMIT` count, because they are round trips;
* the SQL (or Mongo command) actually sent, captured on the first run;
* an **N+1 probe** for the relation scenarios: the op runs with two root sizes
  (e.g. 5 and 20 users) and the round-trip counts are compared;
* a **correctness check**: each engine's result is reduced to a canonical form
  (`canon` in `deep/scenarios.ts`, which coerces 0/1 vs boolean, text vs Date,
  JSON text vs object) and compared with raw's. A difference fails the run.

## Reading the report

Each run writes `results/<dialect>-<timestamp>.md` and `.json` (gitignored).

* **Flags** come first: correctness mismatches (the run exits 1), errors, N+1,
  forge using more round trips than raw, forge more than 30% slower than raw,
  and forge more than 20% slower than the best other ORM on that scenario.
* The **Reads** / **Writes** tables: each cell is
  `median / p95 ms (vs raw) · round trips`.
* **Not run** lists every n/a with its reason.
* **What forge and raw sent** shows the statements, so a flag can be traced to
  the SQL behind it.

Microsecond differences on SQLite mostly measure JavaScript overhead; on a
networked server the round-trip count usually matters more than the per-call
cost, which is why it is recorded separately.

## SQL Server

There is no local server. `--capture-only` needs none: it runs forge's side of
every scenario against a recording stub and writes the SQL (and the DDL) to
`results/mssql-capture-*.md`. With a server, e.g.
`docker run -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD=Forge_Bench_1 -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest`,
the normal run works with `raw`, `forge`, `kysely` and `knex` (`mssql` and
`tedious` are dev dependencies).
