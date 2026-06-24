# DuckDB

DuckDB is forge-orm's analytical option — embedded, columnar, and natively able to read Parquet/CSV files or ATTACH another database as a catalog. This page documents what DuckDB brings to a forge stack: the type round-trip, the parquet/S3 surface, native geo + JSON + FTS extensions, and the patterns that work for OLAP-next-to-OLTP setups.

The two implementation files to read alongside this doc are
`src/adapters/duckdb/dialect.ts` (column types, placeholder style,
geo/vector/JSON emit) and `src/adapters/duckdb/adapter.ts` (capability
flags, extension autoload, the `$queryRaw` / `$executeRaw` /
`$transaction` plumbing). Both are short and worth a skim before
you reach for the heavier patterns below.

## Contents

* [What DuckDB is for in forge](#what-duckdb-is-for-in-forge)
* [Driver — `@duckdb/node-api`](#driver--duckdbnode-api)
* [URL shape and `:memory:` vs file](#url-shape-and-memory-vs-file)
* [Capability flags](#capability-flags)
* [DDL emit table](#ddl-emit-table)
* [Transactional model](#transactional-model)
* [Reading Parquet and CSV inside a typed query](#reading-parquet-and-csv-inside-a-typed-query)
* [S3 and HTTPFS](#s3-and-httpfs)
* [Vector — `vss` and the `FLOAT[N]` column](#vector--vss-and-the-floatn-column)
* [Geo — the `spatial` extension](#geo--the-spatial-extension)
* [JSON — native type and JSON-path](#json--native-type-and-json-path)
* [Full-text search — `fts` and the ILIKE fallback](#full-text-search--fts-and-the-ilike-fallback)
* [`EXPORT DATABASE` — backup and round-trip](#export-database--backup-and-round-trip)
* [`ATTACH` — Postgres / SQLite / MySQL as a catalog](#attach--postgres--sqlite--mysql-as-a-catalog)
* [Persistent vs in-memory DuckDB](#persistent-vs-in-memory-duckdb)
* [Window functions, aggregations, CTEs](#window-functions-aggregations-ctes)
* [Common errors and limitations](#common-errors-and-limitations)
* [Three worked examples](#three-worked-examples)
* [Cross-links](#cross-links)

---

## What DuckDB is for in forge

DuckDB is an embedded analytical engine — the OLAP counterpart to
SQLite. It runs in-process, stores columnar, vectorises every operator,
and pushes predicates into Parquet / CSV scans. The forge adapter
treats it as a first-class dialect: same IR, same typed call shape, same
`$transaction` semantics. What it adds over Postgres / SQLite is a
short list, and that list is the reason you'd pick DuckDB at all.

- **Columnar analytics next to your OLTP store.** Run a
  `groupBy({ by: ['day', 'segment'], _sum: { revenue: true } })` over a
  hundred million rows without taking the OLTP database down. Aggregations,
  windowed metrics, and `GROUP BY ROLLUP` are first-class — DuckDB plans
  them with vectorised hash aggregation, not the row-at-a-time path that
  Postgres takes for the same query without an aggregate index.
- **Parquet / CSV ingest with no copy step.** `read_parquet('s3://…')`
  inside a `$queryRaw` template lets you `SELECT` directly from object
  storage. Predicate pushdown means you only scan the columns and row
  groups the `WHERE` clause touches. This is the workflow for analytics
  dashboards, ad-hoc reports, and ML feature pipelines that ingest from
  data-lake formats.
- **OLAP next to OLTP.** `ATTACH 'host=… dbname=app' AS app (TYPE postgres)`
  exposes a live Postgres database as a DuckDB catalog. Now a single
  `SELECT` joins the OLTP tables against a Parquet file in S3 and writes
  the result to a local DuckDB table. This is the pattern that replaces
  a 3-system ETL (Postgres → Airflow → Snowflake) with two SQL statements
  inside a Node process.
- **An app-local analytics cache.** A `.duckdb` file on the API node is
  effectively a typed materialised view. Refresh on a cron, query
  through the forge wrapper. Sub-millisecond reads, no network round-trip,
  and you get the typed surface that pgAnalytics-via-views does not give
  you.

What DuckDB is **not** good at, and what forge cannot paper over: it's
a single-writer, single-process store. Concurrent writers serialise
on the file lock. Foreign keys are accepted at DDL time but **not
enforced** at write time (see [Capability flags](#capability-flags)).
There is no PITR. There is no replication. Treat DuckDB as a derived
read store downstream of your OLTP system, not as the system of record
for production transactions.

For the picture-shaped picker between the six dialects, see the
[adapter capability matrix in DRIVERS.md](./DRIVERS.md#adapter-capabilities).
For the backup story see [BACKUP-RESTORE.md → DuckDB](./BACKUP-RESTORE.md#duckdb).

---

## Driver — `@duckdb/node-api`

The peer dependency is **`@duckdb/node-api`** — DuckDB's official Node
bindings. Install it alongside `forge-orm`:

```bash
npm i forge-orm @duckdb/node-api
```

The adapter loads the driver lazily; `@duckdb/node-api` only has to be
present at runtime, not at typecheck or build time. The `loadDriver`
helper throws a clear "package not installed" error if you forget,
with the install string baked into the message.

The two call shapes — URL-driven and driver-injected — both work:

```ts
import { createDb } from 'forge-orm';
import { DuckDBInstance } from '@duckdb/node-api';
import { duckdbDriver } from 'forge-orm/adapters/duckdb';
import { schema } from './schema';

// URL-driven — adapter opens its own DuckDBInstance.
const db = await createDb({
  schema,
  type: 'duckdb',
  url:  'duckdb:./analytics.duckdb',
});

// Driver-injected — useful for MotherDuck, custom config, or shared instances.
const instance = await DuckDBInstance.create('./analytics.duckdb', {
  threads: '8',
  memory_limit: '4GB',
});
const connection = await instance.connect();
const db2 = await createDb({
  schema,
  type: 'duckdb',
  driver: duckdbDriver(connection),
});
```

The injected form is the one you reach for when you need to pass DuckDB
config options (`threads`, `memory_limit`, `temp_directory`) that the
URL parser cannot express, or when you want to share a single DuckDB
instance across multiple forge clients (one per tenant, one per
worker thread).

For the underlying driver-port contract — `query`, `transaction`,
`close`, and the param-coercion rules — see
[DRIVERS.md → DuckdbDriver](./DRIVERS.md#duckdbdriver).

---

## URL shape and `:memory:` vs file

```ts
'duckdb://./reports.duckdb'    // file at ./reports.duckdb
'duckdb:./reports.duckdb'      // same — both prefixes are accepted
'duckdb::memory:'              // in-process, no persistence
'duckdb:'                      // empty body → in-process
'duckdb:/var/lib/forge/db'     // absolute path
'duckdb://md:my_db?token=…'    // MotherDuck (cloud DuckDB) — passes through
```

The adapter strips `duckdb:` (with or without the `//`) and hands the
remainder straight to `DuckDBInstance.create()`. Anything DuckDB itself
accepts as a path will work, including the `md:` prefix that the
`@duckdb/node-api` binding routes to MotherDuck.

For an in-process DB, prefer `:memory:` explicitly — an empty string
also works but is less obvious in logs and stack traces.

---

## Capability flags

`DuckdbAdapter.capabilities` is the source of truth for what the
wrapper expects the driver to do versus what forge does in JS. The
DuckDB values:

| Capability | Value | Meaning |
|---|---|---|
| `nativeCascades` | `false` | DuckDB accepts `ON DELETE CASCADE` syntactically but does not enforce FK constraints at write time. Forge's app-side cascade walker takes over for `Cascade` and `SetNull` rules. |
| `nativeUpsert` | `true` | `ON CONFLICT (cols) DO UPDATE SET …` works since DuckDB 0.8; the typed `upsert()` compiles to that shape directly. |
| `nullsOrdering` | `true` | `ORDER BY … NULLS FIRST / NULLS LAST` is honoured. The wrapper does not have to emulate ordering with `CASE`. |
| `jsonPath` | `true` | `json_extract(col, '$.a.b')` is the JSON path operator, same as SQLite. See [JSON-PATH.md → DuckDB](./JSON-PATH.md#duckdb). |
| `transactionsRequireReplicaSet` | `false` | The Mongo flag is meaningless here; it's `false` for every SQL dialect. |

The `nativeCascades: false` flag is the one that changes runtime
behaviour you might not expect. A `delete()` on a parent row triggers
the wrapper's cascade walker — see
[RELATIONS.md → On-delete behaviour](./RELATIONS.md#on-delete) — which
issues one `DELETE` per dependent collection. This is correct but
slower than a native cascade. If you cascade-delete millions of rows
on DuckDB, batch the IDs and run the deletes yourself, or treat the
parent table as the system of record (delete upstream, re-derive
DuckDB).

---

## DDL emit table

The DuckDB dialect borrows the Postgres DDL generator and overrides
the `columnType()` method. The full table:

| Schema field | DuckDB column type | Notes |
|---|---|---|
| `f.id('cuid' \| 'uuid' \| 'bigserial')` | `VARCHAR` / `UUID` / `BIGINT` | `bigserial` emits a sequence + DEFAULT (no native serial type) |
| `f.objectId()` | `VARCHAR` | 24-char hex, same shape as PG |
| `f.string()` | `VARCHAR` | DuckDB has one variable-length string type |
| `f.text()` | `VARCHAR` | no separate `TEXT` |
| `f.int()` | `INTEGER` | 32-bit signed |
| `f.bigint()` | `BIGINT` | 64-bit signed |
| `f.float()` | `DOUBLE` | 64-bit IEEE |
| `f.decimal({ precision, scale })` | `DECIMAL(p,s)` | fixed-point; DuckDB has `HUGEINT` (128-bit) for arbitrary-precision but forge does not map to it |
| `f.uuid()` | `UUID` | native type; `uuid()` generates one at the SQL layer |
| `f.bool()` | `BOOLEAN` | |
| `f.dateTime()` | `TIMESTAMPTZ` | stored UTC, surfaced as JS `Date` |
| `f.json()` | `JSON` | native logical type — dictionary-encoded on disk, columnar |
| `f.enum(values)` | `VARCHAR` + `CHECK` | DuckDB has a native `ENUM` type but the forge dialect emits a `CHECK` constraint to stay parameter-only |
| `f.embed(shape)` | `JSON` | embedded sub-document; see [EMBED.md](./EMBED.md) |
| `f.embedMany(shape)` | `JSON` | array of embedded sub-documents |
| `f.stringArray()` | `VARCHAR[]` | DuckDB has native list types — no JSON marshalling at read time |
| `f.intArray()` | `INTEGER[]` | same |
| `f.geoPoint()` | `GEOMETRY` | from the `spatial` extension; `JSON` in fallback mode |
| `f.vector({ dims: N })` | `FLOAT[N]` | fixed-size list; `vss` extension uses these |

Three points worth flagging:

- **`VARCHAR` covers strings, text, IDs, enums, objectIds.** DuckDB
  has no length limit on `VARCHAR` and no penalty for not specifying
  one — internally it's dictionary-encoded when the cardinality is
  low. Don't bother declaring `VARCHAR(255)` even where Postgres
  habits push you to.
- **`HUGEINT`, `MAP`, and `STRUCT` are not mapped by forge's schema
  builder.** You can use them via raw SQL (`$queryRaw`) on materialised
  views or staging tables; the typed surface only covers what the
  forge IR can build. The `f.embed()` shape gets close to `STRUCT` —
  it emits to JSON, but you can extract individual fields with the dot
  operator (`location.lat`) inside raw SQL because DuckDB's JSON
  type accepts struct-style access on JSON values.
- **`UUID` is native — no extension required.** The `uuid()` SQL
  function generates a new v4. Forge's `f.id('uuid')` uses the
  application-side `crypto.randomUUID()` by default; if you want
  the DB to generate, drop to raw SQL for the insert.

For the full type list against all six dialects see
[TYPES.md](./TYPES.md). For the embed / embedMany emit see
[EMBED.md → DuckDB](./EMBED.md#duckdb).

---

## Transactional model

DuckDB has BEGIN / COMMIT / ROLLBACK, no SAVEPOINT, single-writer
serialisation. The shipped driver wraps the connection's `run()`
method and pins the queryable inside the transaction callback:

```ts
await db.$transaction(async (tx) => {
  const order = await tx.order.create({ data: { customer_id, total } });
  await tx.orderLine.createMany({ data: lines.map((l) => ({ ...l, order_id: order.id })) });
  return order;
});
```

A throw inside the callback triggers ROLLBACK; otherwise the driver
emits COMMIT. The forge factory's per-tx proxy threads the session
through every wrapper call — every `create` / `findMany` / `update`
inside the callback runs against the transaction-pinned queryable, not
the pool.

What DuckDB does **not** support:

- **No SAVEPOINT.** A nested `db.$transaction(async (inner) => …)`
  inside the outer callback degrades to a single transaction — the
  inner `BEGIN` / `COMMIT` collapses into the outer one, and a throw
  from inside the inner block rolls the whole thing back. See
  [TRANSACTIONS.md → Savepoints and nested `$transaction`](./TRANSACTIONS.md#savepoints-and-nested-transaction)
  for the dialect-by-dialect table.
- **No advisory locks.** Concurrency in DuckDB is "one writer at a
  time on the file". The migration runner does not bother with
  advisory locks because the file lock already serialises pushes.
- **No isolation level knobs.** DuckDB runs at snapshot isolation
  internally. There's no `SET TRANSACTION ISOLATION LEVEL` to twiddle.

The autocommit behaviour matches Postgres: a single statement runs
inside an implicit transaction that commits when the statement
completes. The explicit `BEGIN` / `COMMIT` you get through
`$transaction` is the way to batch multiple statements atomically.

For the deadlock / serialisation-failure retry story (mostly N/A
on DuckDB because of single-writer), see
[TRANSACTIONS.md → Deadlock and serialization-failure retry](./TRANSACTIONS.md#deadlock-and-serialization-failure-retry).

---

## Reading Parquet and CSV inside a typed query

This is where DuckDB stops looking like a normal relational store.
The `read_parquet()` and `read_csv()` table functions let any SELECT
treat a file path (or an S3 URL) as a table. Inside a forge wrapper
the natural seam is `$queryRaw`:

```ts
const rows = await db.$queryRaw<{ org_id: string; revenue: number }>`
  SELECT org_id, SUM(revenue) AS revenue
  FROM read_parquet(${'s3://reports/2026-06-*.parquet'})
  WHERE day >= ${cutoff}
  GROUP BY org_id
`;
```

A few notes on the shape:

- **The path is a value, not an identifier.** Pass it through the
  template interpolation — forge binds it as a parameter. Don't
  string-concat the URL into the SQL.
- **Glob patterns work.** `2026-06-*.parquet` expands at scan time;
  DuckDB lists the bucket and reads matching keys in parallel.
- **Predicate pushdown is automatic.** DuckDB will only read the row
  groups whose Parquet statistics overlap your `WHERE` clause. A
  query that filters by `day >= '2026-06-01'` against a year of
  daily Parquet files reads ~1/12 of the bytes.
- **The row type is yours to declare.** `$queryRaw<T>` doesn't
  introspect Parquet — forge has no schema for the file. Type the
  generic and `select` the columns explicitly.

The mirror operation — write a query result to disk — is `COPY TO`:

```ts
await db.$executeRaw`
  COPY (
    SELECT * FROM events WHERE org_id = ${orgId}
  ) TO ${`/exports/events-${orgId}.parquet`}
  (FORMAT PARQUET, COMPRESSION ZSTD)
`;
```

This writes a Parquet file on the DuckDB process's host. If forge is
running on the API node, that's the API node's disk — keep an eye on
free space. For cloud exports use `s3://` paths in the `TO` target;
DuckDB's HTTPFS extension handles the upload.

To ingest a Parquet file into a forge-managed table, the
`INSERT … SELECT` form works:

```ts
await db.$executeRaw`
  INSERT INTO events (org_id, kind, at)
  SELECT org_id, kind, at
  FROM read_parquet(${'s3://my-bucket/events/2026-06-*.parquet'})
  WHERE at >= ${cutoff}
`;
```

DuckDB casts column types from the Parquet schema to the destination
column types at ingest time. If the source has a `BIGINT` for `org_id`
and the destination is `VARCHAR`, DuckDB applies the cast (or fails
with a `Conversion Error` — forge translates this to `P2007`).

CSV is the same shape with `read_csv`:

```ts
const rows = await db.$queryRaw<{ sku: string; qty: number }>`
  SELECT sku, qty
  FROM read_csv(${`/tmp/inventory.csv`}, header = true)
`;
```

`read_csv_auto` is the variant that infers types and header presence.
For one-shot reads of unknown CSVs that's the right call; for known
schemas the explicit `read_csv(..., columns = { sku: 'VARCHAR', qty: 'INTEGER' })`
is faster and gives a clear error if a file drifts off-spec.

The full Parquet / CSV reference is the DuckDB docs; what matters for
forge is that these are just functions inside a SELECT, and `$queryRaw`
is the seam.

For the full `$queryRaw` / `$executeRaw` reference see
[RAW-SQL.md → DuckDB patterns](./RAW-SQL.md#duckdb-patterns).

---

## S3 and HTTPFS

The `httpfs` extension is the thing that turns `s3://…` URLs into
something DuckDB can read. Install and configure it once per process:

```ts
await db.$executeRaw`INSTALL httpfs`;
await db.$executeRaw`LOAD httpfs`;
```

`INSTALL` is a no-op if the extension is cached locally. `LOAD` makes
the table functions (`read_parquet` / `read_csv`) accept `s3://`,
`https://`, and `gcs://` URLs. The adapter does **not** auto-load
`httpfs` (unlike `spatial`) because S3 credentials are out-of-band —
loading without credentials would defer the error to first read.

Once loaded, set credentials via a SECRET (the modern DuckDB API,
≥ 0.10) or via session settings (the older API):

```ts
// Modern — DuckDB ≥ 0.10. Persists in the database file.
await db.$executeRaw`
  CREATE OR REPLACE SECRET s3_main (
    TYPE S3,
    KEY_ID ${process.env.AWS_ACCESS_KEY_ID},
    SECRET ${process.env.AWS_SECRET_ACCESS_KEY},
    REGION ${process.env.AWS_REGION ?? 'us-east-1'}
  )
`;

// Legacy — session-only settings. Don't persist across reconnect.
await db.$executeRaw`SET s3_region = ${process.env.AWS_REGION}`;
await db.$executeRaw`SET s3_access_key_id = ${process.env.AWS_ACCESS_KEY_ID}`;
await db.$executeRaw`SET s3_secret_access_key = ${process.env.AWS_SECRET_ACCESS_KEY}`;
```

The SECRET form survives a reconnect because DuckDB stores it in the
catalog. The SET form has to be re-issued every time the process
restarts; wrap it in a one-shot init function and call it before the
first S3 read.

`httpfs` also covers plain HTTPS — `read_parquet('https://example.com/data.parquet')`
works without any credentials. For partner data drops over signed URLs
this is the friction-free path. The signature lives in the URL string
which is passed as a parameter through the template, so it's bound
not spliced.

For private S3-compatible stores (Cloudflare R2, Backblaze B2,
MinIO) override the endpoint:

```ts
await db.$executeRaw`
  CREATE OR REPLACE SECRET r2_main (
    TYPE S3,
    KEY_ID ${R2_KEY},
    SECRET ${R2_SECRET},
    ENDPOINT 'r2.cloudflarestorage.com',
    REGION 'auto',
    URL_STYLE 'path'
  )
`;
```

`URL_STYLE path` is the change for non-AWS providers; the default
`vhost` style only works with `bucket.s3.region.amazonaws.com`.

---

## Vector — `vss` and the `FLOAT[N]` column

DuckDB has native fixed-size arrays — `FLOAT[1536]` is a real column
type, not a JSON blob. The `vss` extension adds an HNSW index over
those arrays. Forge's `f.vector(N, { metric })` maps directly:

```ts
const Document = m({
  id:     f.id('cuid'),
  text:   f.text(),
  embedding: f.vector({ dims: 1536, metric: 'cosine' }),
});

await db.document.create({ data: { text, embedding } });

const hits = await db.document.findMany({
  where: { embedding: { near: { vector: q, withinDistance: 0.3 } } },
  orderBy: { embedding: { nearTo: { vector: q } } },
  take: 10,
});
```

The dialect emits:

- **Column type** — `FLOAT[N]` where `N` is the declared dim count.
- **Inline literals** — `[0.1, 0.2, …]::FLOAT[N]` (cast required for
  DuckDB's type inference).
- **Distance functions** — `array_cosine_distance`, `array_distance`
  (L2), or `array_inner_product` (dot) chosen by the field's `metric`.
- **Index** — `CREATE INDEX … USING HNSW (col)`. The `vss` extension
  has to be installed; it doesn't auto-load.

To use HNSW:

```ts
await db.$executeRaw`INSTALL vss`;
await db.$executeRaw`LOAD vss`;
```

Then push the schema. The forge DDL emits `USING HNSW` for any
`indexes: [{ on: 'embedding', method: 'vector' }]` declaration; DuckDB
takes it from there.

A working-set caveat: HNSW indexes in `vss` are in-memory. The
`SET hnsw_enable_experimental_persistence = true` flag persists them
to disk, but as of 1.0 the persistence story is opt-in and slower at
build time. For analytics workloads where the index rebuilds on
process start, leave persistence off and rebuild from the column on
boot.

DuckDB-vss handles the 100k-vector / 1M-vector tier comfortably and
matches sqlite-vec brute-force at the small end. For 10M+ vectors with
a heavy query rate, pgvector + a real Postgres host is the better fit.
The full per-dialect benchmark sits in
[VECTOR.md → Picking a dialect](./VECTOR.md#picking-a-dialect).

---

## Geo — the `spatial` extension

The `spatial` extension ships with DuckDB ≥ 0.9 and is **auto-loaded
by the adapter** on connect:

```ts
await this._driver.query('INSTALL spatial', []);
await this._driver.query('LOAD spatial', []);
```

Failures are non-fatal — non-geo schemas keep working. If you declared
`f.geoPoint()` and the extension is missing at runtime, the first
geo query throws a clear DuckDB error (the adapter does not rewrite
this — see [DOCTOR.md](./DOCTOR.md) for the live probe).

The dialect emits:

| Operation | Emit |
|---|---|
| Column | `GEOMETRY` (native type from the spatial extension) |
| Insert | `ST_Point($lng, $lat)` — 2D; `ST_Point3D($lng, $lat, $alt)` when `dims: 3` |
| `near` filter | `ST_Distance_Sphere(col, ST_Point($lng, $lat)) < $meters` |
| `nearTo` orderBy | `ORDER BY ST_Distance_Sphere(col, ST_Point($lng, $lat))` |
| `withinPolygon` | `ST_Within(col, ST_GeomFromText($wkt::VARCHAR))` |
| Spatial index | `CREATE INDEX … USING RTREE (col)` |

A few DuckDB-specific notes:

- **`ST_Distance_Sphere` is the only distance function the dialect
  uses.** This is a great-circle approximation, accurate to ~0.2%
  for terrestrial distances. For ellipsoid precision (PostGIS-quality)
  there's no DuckDB primitive — drop to raw SQL with
  `ST_Distance(ST_Transform(col, …))` and the relevant SRID.
- **`ST_GeomFromText` rejects untyped parameters.** The dialect casts
  the WKT param to `VARCHAR` explicitly — DuckDB's prepared-statement
  inference defaults to `ANY` and the geometry parser won't accept
  that. If you write raw geo SQL, cast your WKT params.
- **The R-Tree index is the spatial-index family.** Forge's
  `method: 'spatial'` resolves to `USING RTREE`. Range queries against
  bounding boxes use the index; point-in-polygon and distance queries
  use the index for the candidate-set prefilter and then refine in
  the post-filter.
- **Fallback mode is supported.** `f.geoPoint({ fallback: true })`
  stores the point as JSON (`{ lng, lat }`) and runs the filter in
  application JS via the shared Haversine helper. Useful for tests,
  edge runtimes without the spatial extension, or schemas that need
  to portably target a DuckDB instance that hasn't loaded `spatial`.

The 3D coordinate support (`dims: 3`) emits `ST_Point3D` for inserts
but distance calculation is still 2D-on-sphere — DuckDB has no `Z`-aware
sphere distance. If you need true 3D distance (rare outside drone /
aerospace), compute it in JS.

The full geo reference, including the per-dialect feature matrix
(R-Tree vs GiST vs 2dsphere) sits in
[GEO.md → Dialect feature matrix](./GEO.md#dialect-feature-matrix).

---

## JSON — native type and JSON-path

DuckDB has a native `JSON` logical type — it stores as text
internally but presents as a typed column with dedicated functions.
Forge's `f.json()`, `f.embed()`, and `f.embedMany()` all map to it.

The path operator the dialect emits is `json_extract`:

```ts
const adults = await db.user.findMany({
  where: {
    profile: { path: ['age'], gte: 18 },
  },
});

// Compiles to:
// SELECT … FROM "user" WHERE json_extract("profile", '$.age') >= $1
```

The `$.a.b[0].c` path string is built by the dialect's `jsonPathExpr`
— numeric segments become `[N]`, named segments become `.name`. Same
shape as SQLite, which makes the dialect-mux easier when you target
both.

JSON-specific notes for DuckDB:

- **The JSON extension auto-loads.** Since DuckDB 0.9 the `json`
  extension is bundled and loaded on first use — no `INSTALL json`
  call needed.
- **Expression indexes on JSON paths work.** A declaration like
  `indexes: [{ expr: { duckdb: `(json_extract(meta, '$.tier'))` } }]`
  builds a real index, and the planner uses it for equality matches.
  See [JSON-PATH.md → DuckDB — expression indexes](./JSON-PATH.md#duckdb--expression-indexes-analytics-workloads).
- **`STRUCT`-style dot access works on JSON.** `meta.profile.age`
  inside raw SQL is shorthand for `json_extract(meta, '$.profile.age')`.
  Forge's typed query API still emits the function form for clarity
  and parameter binding; if you write raw SQL you can use either.
- **`json_each` for unnesting.** `SELECT … FROM users, json_each(users.tags)`
  flattens a JSON array into rows. Useful for "users with any tag in
  this set" queries that don't fit the typed `embedMany` operator
  vocabulary.

The full JSON-path reference, including the per-dialect operator
table and the index-time tradeoffs, sits in
[JSON-PATH.md → DuckDB](./JSON-PATH.md#duckdb).

For the embed / embedMany API surface and how it maps to JSON on
DuckDB see [EMBED.md → DuckDB](./EMBED.md#duckdb).

---

## Full-text search — `fts` and the ILIKE fallback

DuckDB has an `fts` extension (`INSTALL fts; LOAD fts;`) but the API
shape is opt-in per-table via `PRAGMA create_fts_index`, which doesn't
map cleanly onto forge's `.searchable()` column flag. The DuckDB
dialect's `searchClause` therefore falls back to `ILIKE`:

```ts
const hits = await db.post.findMany({
  where: { title: { contains: q, mode: 'insensitive' } },
});

// Emit:
// SELECT … FROM "post" WHERE "title" ILIKE '%' || $1 || '%'
```

This works without any extensions and is portable to schemas that have
not enabled `fts`. The downside is no index — it's a sequential scan
of every row's `title`. For a thousand-row table that's fine; for a
million-row corpus it isn't.

If you want real FTS on DuckDB, the pattern is to build the index
yourself via `PRAGMA create_fts_index` and query through `$queryRaw`:

```ts
// One-time setup — after `LOAD fts`.
await db.$executeRaw`PRAGMA create_fts_index('post', 'id', 'title', 'body')`;

// Query — uses the match_bm25() scoring function.
const hits = await db.$queryRaw<{ id: string; score: number }>`
  SELECT p.id, fts_main_post.match_bm25(p.id, ${q}) AS score
  FROM post p
  WHERE fts_main_post.match_bm25(p.id, ${q}) IS NOT NULL
  ORDER BY score DESC
  LIMIT 20
`;
```

The `fts_main_post` schema and the `match_bm25` function names come
from `create_fts_index`. Treat this as opt-in per table, re-build
after bulk loads (DuckDB's FTS index is a snapshot — it does not
auto-update on insert).

The full FTS reference, including the per-dialect index-mode table and
the BM25 / TF-IDF scoring story, is in
[FTS.md → DuckDB and MSSQL](./FTS.md#duckdb-and-mssql).

---

## `EXPORT DATABASE` — backup and round-trip

DuckDB's backup format is `EXPORT DATABASE`. It writes every table to
Parquet (or CSV, your choice), plus a `schema.sql` and a `load.sql`:

```ts
await db.$executeRaw`EXPORT DATABASE ${'/backups/2026-06-24'} (FORMAT PARQUET)`;
```

The output directory holds:

```
/backups/2026-06-24/
  schema.sql      # CREATE TABLE / CREATE INDEX statements
  load.sql        # COPY <table> FROM '<file>' (FORMAT PARQUET)
  <table>.parquet # one Parquet per table
```

To restore into a fresh DuckDB:

```ts
const fresh = await createDb({ schema, type: 'duckdb', url: 'duckdb:./restored.duckdb' });
await fresh.$executeRaw`IMPORT DATABASE ${'/backups/2026-06-24'}`;
```

The export is portable — you can move it between machines, store it
in S3 (Parquet files compress well with ZSTD), and reimport into any
DuckDB version that understands the Parquet schema. There is no PITR
(it's a snapshot) and no incremental form (it's a full dump every
time). For backup-cadence guidance and the full per-dialect strategy
see [BACKUP-RESTORE.md → DuckDB](./BACKUP-RESTORE.md#duckdb).

A simpler alternative is to copy the `.duckdb` file:

```bash
# Only safe when the DB is closed — call db.$disconnect() first.
cp ./analytics.duckdb ./backups/analytics-$(date +%F).duckdb
```

While the DB is open the file is mid-write and a copy may be
inconsistent. `EXPORT DATABASE` runs inside an implicit transaction
so the snapshot is consistent even if the DB is hot.

---

## `ATTACH` — Postgres / SQLite / MySQL as a catalog

The headline feature: DuckDB can ATTACH another database — another
DuckDB file, a Postgres server, a SQLite file, a MySQL server, a
DuckDB-over-HTTPS endpoint — as a catalog, and then query it through
the same SQL surface. This is the mechanism for "join the analytics
warehouse against the OLTP store in one query" without moving the data.

### Attach another DuckDB file

```ts
await db.$executeRaw`ATTACH ${'/data/archive.duckdb'} AS archive (READ_ONLY)`;

const merged = await db.$queryRaw`
  SELECT u.id, u.email, a.tier
  FROM main."user" u
  JOIN archive."tier_history" a ON a.user_id = u.id
`;
```

The `READ_ONLY` flag is the safe default for a secondary DuckDB —
attaching read-write requires that no other process holds the file.

### Attach Postgres

```ts
await db.$executeRaw`INSTALL postgres`;
await db.$executeRaw`LOAD postgres`;

await db.$executeRaw`
  ATTACH ${process.env.OLTP_DATABASE_URL} AS app (TYPE postgres, READ_ONLY)
`;

const dashboard = await db.$queryRaw<{ day: string; revenue: number }>`
  SELECT
    date_trunc('day', o.created_at) AS day,
    SUM(o.total) AS revenue
  FROM app.public."order" o
  WHERE o.created_at >= ${cutoff}
  GROUP BY 1
  ORDER BY 1
`;
```

The Postgres extension pushes predicates and projections down to
Postgres — the `WHERE o.created_at >= …` runs server-side, not in
DuckDB. DuckDB receives only the matching rows and computes the
aggregate locally. For dashboard queries that touch a slice of a
large OLTP table, this is dramatically cheaper than dumping the table
to Parquet first.

What it does **not** do: DuckDB's plan visibility into Postgres is
limited. A complex join that crosses the attach boundary may run
slower than the same query running directly inside Postgres. Use
`EXPLAIN` and check what's pushed down before relying on this in a
hot path.

### Attach SQLite

```ts
await db.$executeRaw`INSTALL sqlite`;
await db.$executeRaw`LOAD sqlite`;

await db.$executeRaw`ATTACH ${'./local.sqlite'} AS local (TYPE sqlite, READ_ONLY)`;

const rows = await db.$queryRaw`
  SELECT * FROM local.users WHERE active
`;
```

Same shape. The SQLite extension reads SQLite files directly — useful
for joining an app-local SQLite cache against a Parquet archive.

### Attach MySQL

```ts
await db.$executeRaw`INSTALL mysql`;
await db.$executeRaw`LOAD mysql`;

await db.$executeRaw`
  ATTACH ${process.env.MYSQL_URL} AS mysql_app (TYPE mysql, READ_ONLY)
`;
```

ATTACH is the feature that turns DuckDB from "another database" into
"the join layer between every database you already have". The forge
typed surface doesn't expose ATTACH directly (it's an out-of-IR
operation), but every typed read works against the attached catalogs
through `$queryRaw`.

### Cross-DB joins through forge

A common shape: forge's typed reads against the local DuckDB tables,
mixed with raw cross-catalog joins for the analytical query:

```ts
// Typed: list the local analytics segments.
const segments = await db.segment.findMany({ where: { tenant_id } });

// Raw: join against the attached Postgres OLTP to enrich.
const enriched = await db.$queryRaw<{ id: string; segment_id: string; user_count: number }>`
  SELECT
    s.id          AS segment_id,
    s.tenant_id   AS id,
    COUNT(u.id)   AS user_count
  FROM main."segment" s
  JOIN app.public."user" u ON u.tenant_id = s.tenant_id
  WHERE s.tenant_id = ${tenant_id}
  GROUP BY 1, 2
`;
```

The typed query reads from the DuckDB-native `segment` table. The raw
query reads the same DuckDB-native table and joins it against the
ATTACHed Postgres `user` table. Both calls go through the same forge
client.

---

## Persistent vs in-memory DuckDB

`duckdb::memory:` opens an in-process DB that vanishes on `close()`.
`duckdb:./foo.duckdb` opens a persistent file.

When to use each:

- **In-memory** — tests, ephemeral ETL jobs, request-scoped staging,
  a "query Parquet from S3 and return a result" handler. Fast to
  open (~50 ms), no disk I/O, no cleanup. The whole DB lives in RAM
  so it's bounded by your `memory_limit` config; default is 80% of
  system RAM.
- **Persistent file** — the analytics cache pattern, the materialised
  view pattern, anything where the DB survives the process. A `.duckdb`
  file is one artefact (no WAL, no journal, no segment files) and is
  safe to back up via `EXPORT DATABASE` or — while the process is
  closed — a plain `cp`.

A useful middle ground: open in-memory, ATTACH a persistent file as a
secondary catalog, and write the persistent state to that catalog.

```ts
const db = await createDb({ schema, type: 'duckdb', url: 'duckdb::memory:' });
await db.$executeRaw`ATTACH ${'./cache.duckdb'} AS cache`;
await db.$executeRaw`
  CREATE OR REPLACE TABLE cache.daily_revenue AS
  SELECT day, SUM(revenue) AS revenue
  FROM read_parquet(${'s3://reports/2026-06-*.parquet'})
  GROUP BY 1
`;
```

The in-memory DB is the workspace; the persistent file holds the
cached result. Process restart drops the workspace and keeps the
cache.

---

## Window functions, aggregations, CTEs

DuckDB's planner is built for analytical queries. Three categories
where it pays off and forge's typed surface doesn't fully cover:

### Window functions

Forge's `findMany` does not emit `OVER (…)`. For rank, lag, percentile,
moving-window queries reach for `$queryRaw`:

```ts
const ranked = await db.$queryRaw<{ user_id: string; revenue: number; rank: number }>`
  SELECT
    user_id,
    SUM(amount) AS revenue,
    ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY SUM(amount) DESC) AS rank
  FROM "order"
  WHERE created_at >= ${cutoff}
  GROUP BY tenant_id, user_id
`;
```

DuckDB vectorises window operators. Even an unindexed `ORDER BY …`
window over a million-row table runs in tens of milliseconds.

### Aggregations beyond `_sum` / `_avg`

The typed `groupBy` aggregator vocabulary covers `_count` / `_avg` /
`_sum` / `_min` / `_max`. DuckDB ships much more — `quantile_cont`,
`approx_count_distinct`, `histogram`, `corr`, `regr_slope`, the full
statistical surface. All of those live in raw SQL.

```ts
const distribution = await db.$queryRaw<{ bucket: number; n: number }>`
  SELECT
    quantile_cont(amount, [0.5, 0.9, 0.95, 0.99]) AS quantiles,
    approx_count_distinct(user_id) AS distinct_users
  FROM "order"
  WHERE created_at >= ${cutoff}
`;
```

For analytical dashboards `approx_count_distinct` (HyperLogLog) is
the right call for cardinality — `COUNT(DISTINCT)` is exact and slow,
the approx variant is one pass over the data.

### CTEs and recursive CTEs

CTEs work via raw SQL. DuckDB supports `WITH RECURSIVE` for graph /
tree traversal:

```ts
const tree = await db.$queryRaw<{ id: string; depth: number }>`
  WITH RECURSIVE tree(id, parent_id, depth) AS (
    SELECT id, parent_id, 0 FROM "category" WHERE parent_id IS NULL
    UNION ALL
    SELECT c.id, c.parent_id, t.depth + 1
    FROM "category" c JOIN tree t ON c.parent_id = t.id
  )
  SELECT id, depth FROM tree ORDER BY depth
`;
```

The forge typed surface does not generate recursive CTEs (it's an
explicit out-of-scope feature — see
[RELATIONS.md](./RELATIONS.md) for the parent/child pattern that
forge does cover). Raw SQL is the escape hatch.

---

## Common errors and limitations

The DuckDB adapter's `errors.ts` maps DuckDB's `errorType` and message
patterns to Prisma-style P-codes. The high-frequency cases:

| DuckDB error | Forge code | Cause |
|---|---|---|
| `Constraint Error: duplicate key … UNIQUE constraint` | `P2002` | `nativeUpsert` not used; insert into a unique column. Convert to `upsert()` or catch and handle. |
| `Constraint Error: NOT NULL` | `P2011` | Insert/update with `null` against a `NOT NULL` column. Schema fields without `.nullable()` emit NOT NULL. |
| `Constraint Error: CHECK constraint` | `P2004` | Likely an enum mismatch — forge enums emit `CHECK ("col" IN ('a','b','c'))`. Add the value to the schema's enum and push. |
| `Constraint Error: foreign key` | `P2003` | Rare — DuckDB doesn't enforce FKs at write time. This fires if you wrote a check via raw SQL. |
| `Catalog Error: Table … does not exist` | `P2021` | Schema not pushed, wrong DB attached, or you're querying an `ATTACH`ed catalog without the qualifier. |
| `Catalog Error: column … does not exist` | `P2022` | Column was renamed in schema but the migration didn't run. `npx forge diff` to see the drift. |
| `Conversion Error` | `P2007` | Type mismatch — e.g. inserting a string into an INTEGER column. Check the offending field's schema kind. |

DuckDB-specific limitations the forge adapter handles silently:

- **Partial indexes are not supported.** The DDL emitter strips the
  `WHERE` clause off a `CREATE INDEX` and warns. The unique constraint
  degrades to a plain unique — a row-uniqueness check rebroadcasts at
  the wrapper layer. See [INDEXES.md](./INDEXES.md) for the partial-unique
  rebroadcast detail.
- **Covering indexes (`INCLUDE`) are not supported.** Stripped at DDL
  emit time with a warning. Use a normal index — DuckDB's columnar
  storage means an index lookup followed by row fetch is already
  fast.
- **Foreign keys are not enforced at write time.** Accepted at DDL
  time so introspection sees them. Cascades go through forge's
  app-side walker.
- **No `SAVEPOINT`.** Nested `$transaction` calls collapse into the
  outer transaction.
- **`fts` is opt-in.** `.searchable()` falls back to `ILIKE`.

A foot-gun the adapter cannot prevent: DuckDB is **single-writer**.
If two Node processes open the same `.duckdb` file with write
permissions, the second one's `query()` blocks on the file lock or
fails outright. The typical production layout is one DuckDB-owning
process (a worker, a cron, a long-running API node) and any other
processes read via `ATTACH ' DATABASE … (READ_ONLY)'`. Plan for
this up front — it's the difference between "embedded analytics
that just works" and "the second deploy collides with the first".

---

## Three worked examples

### (a) Ingest a CSV → typed query

Local CSV file dropped by a vendor, want it queryable through the typed
surface for the rest of the request.

```ts
// schema.ts
export const Inventory = m({
  sku:  f.string().unique(),
  name: f.string(),
  qty:  f.int(),
  cost: f.decimal({ precision: 12, scale: 2 }),
});

// load.ts
import { db } from './client';

export async function loadInventory(csvPath: string): Promise<number> {
  // Stage into a forge-managed table via INSERT … SELECT.
  const affected = await db.$executeRaw`
    INSERT INTO "inventory" (sku, name, qty, cost)
    SELECT sku, name, qty, cost
    FROM read_csv(${csvPath},
      header = true,
      columns = { sku: 'VARCHAR', name: 'VARCHAR', qty: 'INTEGER', cost: 'DECIMAL(12,2)' }
    )
    ON CONFLICT (sku) DO UPDATE SET
      name = EXCLUDED.name,
      qty  = EXCLUDED.qty,
      cost = EXCLUDED.cost
  `;
  return affected;
}

// query.ts — typed surface from here on.
const lowStock = await db.inventory.findMany({
  where: { qty: { lt: 10 } },
  orderBy: { sku: 'asc' },
});
```

The `read_csv` declares the column types explicitly so DuckDB doesn't
have to infer. The `ON CONFLICT (sku) DO UPDATE` makes the ingest
idempotent — a re-run with the same CSV returns the same row count
and overwrites changed values.

### (b) Parquet on S3 → join with local Postgres via ATTACH

Analytics dashboard: revenue rollup from a Parquet archive in S3,
joined with the live customer table in the OLTP Postgres.

```ts
import { createDb } from 'forge-orm';
import { schema } from './schema';

const db = await createDb({
  schema,
  type: 'duckdb',
  url:  'duckdb::memory:', // in-process, no persistence
});

// One-time per process: load extensions and credentials.
await db.$executeRaw`INSTALL httpfs; LOAD httpfs`;
await db.$executeRaw`INSTALL postgres; LOAD postgres`;

await db.$executeRaw`
  CREATE OR REPLACE SECRET s3 (
    TYPE S3,
    KEY_ID ${process.env.AWS_ACCESS_KEY_ID},
    SECRET ${process.env.AWS_SECRET_ACCESS_KEY},
    REGION ${process.env.AWS_REGION}
  )
`;

await db.$executeRaw`
  ATTACH ${process.env.OLTP_DATABASE_URL} AS app (TYPE postgres, READ_ONLY)
`;

// The query — one statement that hits S3 and Postgres in parallel.
const rollup = await db.$queryRaw<{
  customer_id: string;
  customer_name: string;
  revenue: number;
}>`
  WITH revenue AS (
    SELECT customer_id, SUM(amount) AS revenue
    FROM read_parquet(${'s3://archive/orders/year=2026/*.parquet'})
    WHERE day >= ${cutoff}
    GROUP BY 1
  )
  SELECT
    c.id   AS customer_id,
    c.name AS customer_name,
    r.revenue
  FROM revenue r
  JOIN app.public."customer" c ON c.id = r.customer_id
  ORDER BY r.revenue DESC
  LIMIT 100
`;
```

Three databases participated: the S3 Parquet archive (read via
HTTPFS), the OLTP Postgres (via ATTACH, predicate-pushed), and the
in-memory DuckDB (the workspace where the join lands). The Node
process holds a single forge client.

### (c) Analytical dashboard backed by an embedded DuckDB cache

API endpoint that serves a dashboard. The cache is a persistent
DuckDB file refreshed nightly; reads are sub-millisecond.

```ts
// nightly-refresh.ts — cron job that rebuilds the cache.
import { createDb } from 'forge-orm';
import { schema } from './schema';

export async function refreshCache() {
  const db = await createDb({
    schema,
    type: 'duckdb',
    url:  'duckdb:./cache.duckdb',
  });

  // Pull yesterday's events from OLTP (via ATTACH) and replace the daily table.
  await db.$executeRaw`INSTALL postgres; LOAD postgres`;
  await db.$executeRaw`
    ATTACH ${process.env.OLTP_DATABASE_URL} AS app (TYPE postgres, READ_ONLY)
  `;

  await db.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM "daily_revenue" WHERE day >= ${dayBefore}`;
    await tx.$executeRaw`
      INSERT INTO "daily_revenue" (day, tenant_id, revenue, orders)
      SELECT
        date_trunc('day', created_at) AS day,
        tenant_id,
        SUM(total) AS revenue,
        COUNT(*)   AS orders
      FROM app.public."order"
      WHERE created_at >= ${dayBefore}
      GROUP BY 1, 2
    `;
  });

  await db.$disconnect();
}

// api.ts — request handler reads the cache through the typed surface.
import { createDb } from 'forge-orm';
import { schema } from './schema';

const dashboardDb = await createDb({
  schema,
  type: 'duckdb',
  url:  'duckdb:./cache.duckdb',
});

export async function dashboardHandler(tenantId: string) {
  return dashboardDb.dailyRevenue.findMany({
    where:   { tenant_id: tenantId },
    orderBy: { day: 'desc' },
    take:    30,
  });
}
```

The cache is a typed forge model (`f.json()` or any other type, defined
in `schema`). Reads use the typed surface — `findMany`, `where`,
`orderBy` — and benefit from the columnar layout for the rollup
operations the dashboard runs. The refresh job rebuilds the rollup
once per day; the API node serves it.

The OLTP Postgres never sees a dashboard query. The DuckDB cache lives
on the API node's local disk. Total cost: zero additional infra.

---

## Cross-links

- [DRIVERS.md](./DRIVERS.md) — the `DuckdbDriver` port shape, param
  coercion, and the bring-your-own-driver story.
- [QUERIES.md](./QUERIES.md) — the typed `findMany` / `where` operator
  surface that the DuckDB executor implements.
- [RAW-SQL.md → DuckDB patterns](./RAW-SQL.md#duckdb-patterns) — the
  `$queryRaw` / `$executeRaw` examples for Parquet, COPY TO, EXPORT
  DATABASE, STRUCT extraction.
- [VECTOR.md](./VECTOR.md) — `f.vector(N)` and the `vss` extension; the
  per-dialect benchmark table.
- [GEO.md](./GEO.md) — `f.geoPoint()`, the spatial extension, R-Tree
  indexes, and the per-dialect feature matrix.
- [JSON-PATH.md → DuckDB](./JSON-PATH.md#duckdb) — `json_extract`,
  expression indexes, the typed `path` operator.
- [FTS.md → DuckDB and MSSQL](./FTS.md#duckdb-and-mssql) — the `fts`
  extension, `match_bm25`, and the ILIKE fallback.
- [EMBED.md → DuckDB](./EMBED.md#duckdb) — `f.embed()` / `f.embedMany()`
  emit to native JSON.
- [TYPES.md](./TYPES.md) — the full type table across all six
  dialects.
- [TRANSACTIONS.md](./TRANSACTIONS.md) — savepoint, isolation, and
  retry semantics (DuckDB row in the per-dialect tables).
- [MIGRATIONS.md](./MIGRATIONS.md) — DDL push, `$migrate()` runtime
  apply, the per-dialect rollback fidelity story.
- [DIFF.md → DuckDB](./DIFF.md#duckdb) — drift detection, introspection
  via `duckdb_*` metadata functions, and the `diff apply` shape.
- [BACKUP-RESTORE.md → DuckDB](./BACKUP-RESTORE.md#duckdb) —
  `EXPORT DATABASE` cadence and the no-PITR story.
- [INDEXES.md](./INDEXES.md) — index method support, the partial-index
  degrade-to-plain rebroadcast.
- [DOCTOR.md](./DOCTOR.md) — the live probe that surfaces missing
  extensions (`spatial`, `vss`, `fts`, `httpfs`).
