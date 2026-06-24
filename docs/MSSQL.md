# SQL Server

forge-orm targets SQL Server 2017+, Azure SQL Database, and Azure SQL Managed Instance. This page documents the MSSQL-specific behavior — the MERGE-based upsert, the snapshot-isolation model, geography vs geometry spatial, OPENJSON-based JSON queries — and the operational concerns when running forge against MSSQL.

## Contents

* [Supported versions and editions](#supported-versions-and-editions)
* [Driver and connection string](#driver-and-connection-string)
* [DDL emit table](#ddl-emit-table)
* [IDENTITY columns and sequences](#identity-columns-and-sequences)
* [Upsert via MERGE](#upsert-via-merge)
* [Transactions and isolation](#transactions-and-isolation)
* [Pagination — OFFSET / FETCH](#pagination--offset--fetch)
* [CTE and window functions](#cte-and-window-functions)
* [Full-text search](#full-text-search)
* [Spatial — geography and geometry](#spatial--geography-and-geometry)
* [JSON path queries](#json-path-queries)
* [Vector — JSON fallback and SQL Server 2025](#vector--json-fallback-and-sql-server-2025)
* [Azure SQL specifics](#azure-sql-specifics)
* [Connection pool sizing](#connection-pool-sizing)
* [Errors and codes](#errors-and-codes)
* [Worked examples](#worked-examples)
* [Cross-links](#cross-links)

---

## Supported versions and editions

| Edition | Tested | Notes |
|---|---|---|
| SQL Server 2017 | yes | Floor — `OPENJSON`, `STRING_AGG`, `OFFSET … FETCH` all present. JSON_PATH index workaround needed (computed column + index). |
| SQL Server 2019 | yes | Adds `STRING_SPLIT(ordinal)`, intelligent query processing, accelerated DB recovery. Doctor flags this as the recommended floor for production. |
| SQL Server 2022 | yes | Native JSON aggregates (`JSON_OBJECT`, `JSON_ARRAY`), system-versioned ledger tables. forge uses none of the new keywords by default — emit stays portable to 2017. |
| SQL Server 2025 (preview) | partial | Native `VECTOR(N)` type and `VECTOR_DISTANCE(...)`. The dialect emits the new syntax when `f.vector()` is declared; the JSON fallback is the documented path until 2025 GA. |
| Azure SQL Database | yes | Always-current. Behaves as 2022 + extras (Always Encrypted with secure enclaves, Hyperscale, serverless tier auto-pause). |
| Azure SQL Managed Instance | yes | Full SQL Server surface inside a VNet. CLR + SQL Agent + cross-DB queries work; no compatibility differences forge cares about. |
| Azure SQL Edge | partial | ARM64-friendly local testing image (M-series macs). Missing: full-text catalogs, Polybase, ML Services. Doctor probes for FTS and reports a degraded `notes` line. |

`SELECT @@VERSION` lands in the doctor report under `notes` so you can
see which edition forge actually connected to. The minimum compatibility
level forge requires is 140 (SQL 2017); earlier levels lack
`OPENJSON` and the `OFFSET … FETCH` pagination shape that the IR
compiler emits.

---

## Driver and connection string

The shipped wrapper is `mssqlDriver` — a thin port over the [`mssql`](https://www.npmjs.com/package/mssql)
package, which itself wraps [`tedious`](https://www.npmjs.com/package/tedious)
on the wire. Install one, you get both:

```sh
npm i mssql
```

`mssql` is a peer-dep. `tedious` ships as a transitive dependency.
forge's `loadDriver('mssql', url)` does the `require` and surfaces a
useful install hint when the package is missing.

```ts
import sql from 'mssql';
import { createDb, mssqlDriver } from 'forge-orm';

const pool = await sql.connect({
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASS,
  server: 'localhost',
  database: 'app',
  port: 1433,
  options: {
    encrypt: true,                  // mandatory on Azure SQL
    trustServerCertificate: false,  // flip to true ONLY for self-signed dev
    enableArithAbort: true,
  },
  pool: { max: 20, min: 0, idleTimeoutMillis: 30_000 },
});

export const db = await createDb({ schema, driver: mssqlDriver(pool) });
```

Or with a URL:

```ts
// mssql:// and sqlserver:// both detect to the mssql adapter.
await createDb({
  url: 'mssql://user:pass@localhost:1433/app?encrypt=true&trustServerCertificate=false',
  schema,
});
```

URL query parameters map directly to the `mssql` package's config keys
(`encrypt`, `trustServerCertificate`, `connectTimeout`, `requestTimeout`).
The detection table in [DRIVERS](./DRIVERS.md#the-two-call-shape-url-vs-driver)
lists every prefix forge recognizes.

### Encrypt and trustServerCertificate

* **`encrypt: true`** — mandatory on Azure SQL. Without it the wire is
  refused with `ELOGIN`. Local SQL Server developer instances accept
  either, but production should always encrypt.
* **`trustServerCertificate: true`** — only for development against a
  self-signed cert (the `mcr.microsoft.com/mssql/server:2022-latest`
  image ships one). In production this should always be `false` so the
  CA chain is verified.
* **Azure SQL Edge** — ARM-Mac local testing. Set `encrypt: true,
  trustServerCertificate: true` because the bundled cert isn't signed.

### Port

1433 is the default. Named instances on Windows use SQL Browser to
resolve `server\instance` to a dynamic port — forge has no opinion
here; pass `server: 'host\\\\instance'` and the `mssql` package figures
it out. For Azure SQL the host is `<name>.database.windows.net` on
port 1433.

### Param binding — `@p1, @p2, …`

The dialect emits T-SQL named-parameter placeholders, never `?` or
`$1`. The driver wrapper binds them positionally via
`request.input('p${i+1}', value)`. A custom driver must mirror that —
see [DRIVERS](./DRIVERS.md#mssqldriver) for the contract and the
"`Must declare the scalar variable "@p1"`" symptom when it's wrong.

---

## DDL emit table

The MssqlDialect column types — what the schema kinds in `f.*` become
when `forge push` runs against MSSQL:

| forge kind | T-SQL type | Notes |
|---|---|---|
| `f.id()` (string PK)     | `NVARCHAR(255)`           | App-generated cuid/ulid/uuid string. No `IDENTITY`. |
| `f.id(\| 'bigserial')`   | `BIGINT IDENTITY(1,1)`    | Auto-increment 64-bit. `IDENTITY_INSERT` needed to override. |
| `f.id(\| 'uuid')`        | `UNIQUEIDENTIFIER`        | Native 16-byte GUID. Default is **not** set; supply with `NEWID()` or `NEWSEQUENTIALID()` on the column default if you want server-side gen. |
| `f.string()`             | `NVARCHAR(255)`           | UTF-16, fixed cap. For UTF-8-only payloads with the `_UTF8` collation you can cut storage by half — set the column collation at DDL time outside forge. |
| `f.text()`               | `NVARCHAR(MAX)`           | `TEXT` is deprecated; `NVARCHAR(MAX)` is the modern equivalent. |
| `f.int()`                | `INT`                     | 32-bit. |
| `f.bigint()`             | `BIGINT`                  | 64-bit. |
| `f.float()`              | `FLOAT`                   | 53-bit double-precision (IEEE 754). |
| `f.decimal(p, s)`        | `DECIMAL(p,s)`            | Up to 38 digits. |
| `f.bool()`               | `BIT`                     | T-SQL has no real boolean. The IR compiler coerces JS `true`/`false` → `1`/`0` at param-bind time. |
| `f.dateTime()`           | `DATETIMEOFFSET`          | Preserves the timezone offset. `DATETIME2` is the no-tz alternative — drop down via `$queryRaw` if you need it. `DATETIME` (the legacy 1900-9999 type) is intentionally not emitted; its 3.33ms precision is a footgun. |
| `f.uuid()`               | `UNIQUEIDENTIFIER`        | Distinct from `id(\|'uuid')` only in that this is a regular column. |
| `f.json()`               | `NVARCHAR(MAX)`           | SQL Server 2025 adds a real `JSON` type — forge stays on `NVARCHAR(MAX)` for portability. `ISJSON()` check constraint not added; declare it via `$executeRaw` if you want write-time validation. |
| `f.embed(...)` / `embedMany(...)` | `NVARCHAR(MAX)` | Adapter `coerceInbound` does `JSON.stringify` on write. Reads come back as text — see [EMBED](./EMBED.md#mssql) for the auto-parse hook. |
| `f.stringArray()` / `intArray()` | `NVARCHAR(MAX)` | T-SQL has no array type. Stored as JSON, read with `OPENJSON` or `JSON_VALUE`. The IR's array operators (`in`, `contains`) compile to `OPENJSON`-backed subqueries. |
| `f.enum(...)`            | `NVARCHAR(255)` + CHECK   | `CHECK ([col] IN ('a', 'b', …))` added at table-create time. Adding a value later means dropping + recreating the CHECK — see [MIGRATIONS](./MIGRATIONS.md#enum-drift). |
| `f.geoPoint()`           | `GEOGRAPHY`               | Default — WGS84. See [Spatial](#spatial--geography-and-geometry). |
| `f.geoPoint({ fallback: true })` | `NVARCHAR(MAX)` | JSON `{lat, lng}` fallback for editions without spatial (Azure SQL Edge). |
| `f.vector(N)`            | `VECTOR(N)`               | SQL Server 2025 only. Earlier targets need a JSON-stored fallback; see [Vector](#vector--json-fallback-and-sql-server-2025). |

Types that forge does **not** emit because they're either legacy or
specialised — drop into `$queryRaw` if you need them:

* `MONEY` / `SMALLMONEY` — fixed 4dp; use `DECIMAL(19,4)` via `f.decimal()` instead.
* `HIERARCHYID` — built-in materialised path. Useful for trees but not modelled by forge's relations layer.
* `XML` — pre-JSON era. Use `NVARCHAR(MAX)` + `OPENXML` if you really need it.
* `SQL_VARIANT` — typed-as-anything. Use `f.json()`.
* `ROWVERSION` / `TIMESTAMP` — auto-incrementing concurrency token. Add it via `$executeRaw('ALTER TABLE … ADD rv ROWVERSION')` and read through introspection.

### `NVARCHAR` vs `VARCHAR`

forge emits `NVARCHAR` everywhere by default. The N-prefix is UTF-16
(every char 2-4 bytes). `VARCHAR` is single-byte / collation-dependent.
Rationale:

* JS strings are UTF-16 internally — `NVARCHAR` is the lossless round
  trip.
* SQL Server 2019+ has the `_UTF8` collations, which let `VARCHAR`
  store UTF-8. That can halve storage on Latin-script text. To opt in,
  set the column / database collation outside forge:
  ```sql
  ALTER DATABASE app SET COLLATION Latin1_General_100_CI_AS_SC_UTF8;
  ```
  The dialect still emits `NVARCHAR` — drop down to `$executeRaw` if
  you want `VARCHAR` columns; forge's introspect reader normalizes
  both back to `string` so reads work either way.

---

## IDENTITY columns and sequences

T-SQL has two paths to monotonic IDs:

**IDENTITY** — the historical approach. `BIGINT IDENTITY(1,1)`
attaches an auto-increment counter to the column. `INSERT` without
that column gets the next value; `SCOPE_IDENTITY()` reads it back.
forge uses IDENTITY for `f.id('bigserial')`:

```sql
CREATE TABLE [orders] (
  [id]    BIGINT IDENTITY(1,1) NOT NULL,
  [total] DECIMAL(19,4) NOT NULL,
  CONSTRAINT [pk_orders] PRIMARY KEY ([id])
);
```

When you need to override the counter (data import, replay), wrap the
load:

```ts
await db.$executeRaw(sql`SET IDENTITY_INSERT [orders] ON`);
await db.Orders.createMany({ data: rows });
await db.$executeRaw(sql`SET IDENTITY_INSERT [orders] OFF`);
```

Only one table per session can have `IDENTITY_INSERT ON`. Forgetting
to flip it back leaks across requests in a pool — keep the toggle
inside `db.$transaction(async (tx) => …)` to scope the lifetime to
the call.

**SEQUENCE** — SQL Server 2012+. A separate object that hands out
values; multiple columns / tables can draw from one sequence. forge
doesn't emit them automatically, but introspect reads them back so you
can mix-and-match. Declare via `$executeRaw` and reference in the
column default:

```ts
await db.$executeRaw(sql`
  CREATE SEQUENCE [order_seq] AS BIGINT START WITH 1000 INCREMENT BY 1
`);
await db.$executeRaw(sql`
  ALTER TABLE [orders]
  ADD CONSTRAINT [df_orders_id] DEFAULT NEXT VALUE FOR [order_seq] FOR [id]
`);
```

Sequences over IDENTITY when:

* Several tables share an ID space (multi-tenant ledger).
* You need to pre-allocate a block (`SELECT NEXT VALUE FOR seq` n
  times before the insert).
* You want a custom cache size to amortise the IDENTITY round-trip
  (`CACHE 1000`).

For app-generated IDs (cuid/ulid), stick with `f.id()` (string) — the
client mints the ID, no round-trip is needed at insert time, and the
ID is sortable + globally unique.

---

## Upsert via MERGE

PG has `INSERT … ON CONFLICT DO UPDATE`. MySQL has `INSERT … ON
DUPLICATE KEY UPDATE`. T-SQL has no equivalent single-statement form
except `MERGE`. As of forge 2.5.0 the MSSQL adapter rewrites
`Model.upsert(...)` into a MERGE statement with the conflict target
derived from the `where` tree.

### The call shape

```ts
await db.Products.upsert({
  where:  { sku: 'WIDGET-A' },
  create: { sku: 'WIDGET-A', name: 'Widget A', stock: 10 },
  update: { stock: { increment: 1 } },
});
```

### What forge emits

```sql
MERGE INTO [products] AS tgt
USING (VALUES (@p1, @p2, @p3)) AS src ([stock], [name], [sku])
ON tgt.[sku] = src.[sku]
WHEN MATCHED THEN UPDATE SET [stock] = COALESCE(tgt.[stock], 0) + @p4
WHEN NOT MATCHED THEN INSERT ([stock], [name], [sku])
                     VALUES (src.[stock], src.[name], src.[sku])
OUTPUT INSERTED.*;
```

The pipeline:

1. **Conflict target** — extracted from the `where` tree. The
   compiler walks `eq` leaves (single column or an AND of eq leaves);
   anything else throws at compile time with the explicit message
   `upsert requires a conflict target. Use { where: { uniqueCol: value } }`.
2. **Source row** — every key in `create`, plus any conflict column
   the caller forgot to mirror into `create` (pulled from the `where`
   leaf value). Missing-from-both throws `upsert conflict column '<c>'
   is in the where clause but not in create`.
3. **UPDATE branch** — `set`, `increment`, `multiply`, `unset` are
   compiled in that order. `increment` and `multiply` wrap the existing
   value in `COALESCE(tgt.<col>, 0)` so they're safe on NULL columns.
   When the caller passes only `create` and no `update` payload the
   branch falls back to a no-op self-assignment of the conflict column
   so the MERGE statement is still legal T-SQL.
4. **OUTPUT** — `INSERTED.*` returns the row that landed (either the
   freshly inserted one or the updated one). Forge's `executeUpdate`
   reads it back, so `upsert()` returns the row like every other
   adapter.

### MERGE caveats

The community has historically cautioned against MERGE — the bugs
caught users in multi-source-row or trigger-laden configurations.
forge's rewrite is the single-source-row form (`USING (VALUES (…))
AS src`) against a single target, with no triggers in the path —
that variant has been stable since 2014. What you should still know:

* **Trailing semicolon is mandatory** — the dialect emits one.
* **HOLDLOCK** is **not** added by default. Under `READ COMMITTED`
  with high-concurrency upsert, two sessions can race and both hit the
  WHEN NOT MATCHED branch, leading to a duplicate-key violation. The
  conflicting INSERT throws `2627` (mapped to `UniqueViolation`) —
  catch and retry the upsert, which now hits WHEN MATCHED. Run under
  SNAPSHOT isolation or `$queryRaw` a `HOLDLOCK` hint into the MERGE
  manually if you want to avoid the retry.
* **No `skipDuplicates`** — MERGE always either updates or inserts.
  Rewrite as a conditional INSERT (`INSERT … WHERE NOT EXISTS (…)`)
  via `$queryRaw` if you need ignore-on-conflict semantics.

### Composite conflict keys

```ts
await db.OrgMembers.upsert({
  where:  { orgId: 'o1', userId: 'u1' },
  create: { orgId: 'o1', userId: 'u1', role: 'member', joinedAt: new Date() },
  update: { role: 'admin' },
});
```

Compiles to a MERGE with `ON tgt.[orgId] = src.[orgId] AND tgt.[userId]
= src.[userId]`. The AND-of-eq detection in `whereEqLeafColumns()`
handles arbitrary depth.

### Why this is the only safe path

The naïve "SELECT then INSERT or UPDATE" alternative races between the
read and the write. Even inside a transaction, `READ COMMITTED` lets
another session insert the same key after your SELECT and before your
INSERT. The MERGE form is atomic — one statement, one lock window —
and combined with the retry-on-`2627` strategy is the documented MSSQL
upsert pattern.

For high-write-rate counters, prefer a plain
`db.Counters.update({ where, increment: { n: 1 } })` — that's a single
`UPDATE … SET n = COALESCE(n,0)+1` with no conflict path. Reserve
`upsert` for first-write-wins semantics.

---

## Transactions and isolation

T-SQL ships four named isolation levels plus snapshot, plus read
committed snapshot. forge's `db.$transaction(fn)` defaults to the
session's current isolation (the default is `READ COMMITTED`). Raise
or lower per-transaction with `SET TRANSACTION ISOLATION LEVEL` inside
the callback.

### The five levels (T-SQL)

| Level | Reads see | Writes block | Use |
|---|---|---|---|
| `READ UNCOMMITTED` | Dirty reads of in-flight writes | No locks taken on read | Avoid. Used to be the "fast reporting" hack; SNAPSHOT replaces it. |
| `READ COMMITTED` (default) | Only committed rows | Shared locks released after each read | OLTP default. Non-repeatable reads possible — re-querying the same row mid-tx can return a different value. |
| `REPEATABLE READ` | Same row, same value for the tx | Holds S-locks for the tx duration | Higher contention than READ COMMITTED; rarely the right answer. |
| `SERIALIZABLE` | Phantom-free | Range locks | Strictest. Use for invariant-protecting workflows (allocate-from-pool). |
| `SNAPSHOT` | Row version at tx start | No reader-vs-writer blocks | Optimistic concurrency control. Update conflicts surface as `3960` at COMMIT. Requires `ALLOW_SNAPSHOT_ISOLATION ON` at the DB level. |

### `READ COMMITTED SNAPSHOT` (RCSI)

A database-level flag that turns `READ COMMITTED` into a row-versioned
read (no shared locks taken). Enable at the database, every
transaction gets snapshot-like read semantics without needing to set
`SNAPSHOT` per-call. **Azure SQL Database has RCSI on by default.**
For self-managed SQL Server, enable explicitly:

```sql
ALTER DATABASE app SET READ_COMMITTED_SNAPSHOT ON
  WITH ROLLBACK IMMEDIATE;
```

`ROLLBACK IMMEDIATE` kills active sessions on the DB — run during a
maintenance window. After RCSI is on, no app code changes; the
default isolation behaves more like Postgres's REPEATABLE READ.

### Raising to SNAPSHOT inside a tx

```ts
await db.$transaction(async (tx) => {
  await tx.query(`SET TRANSACTION ISOLATION LEVEL SNAPSHOT`);
  // every subsequent read in this tx sees the snapshot at tx start
  const balance = await tx.scope(db).Accounts.findFirst({ where: { id } });
  // … check & write
});
```

The driver wrapper's `transaction()` opens a `BEGIN TRAN`; the
`ISOLATION LEVEL SNAPSHOT` statement is per-session. On COMMIT the
update-conflict check fires; conflicts come back as error `3960`
(forge maps it to `DbKnownError` with the original error text).

### DDL implicitly commits

T-SQL allows `CREATE TABLE` / `ALTER TABLE` inside a `BEGIN TRAN`
block, but a uncommitted DDL holds Sch-M locks on the metadata for
the duration. `forge push` and `db.$migrate()` run each statement
outside of any user transaction; if you wrap a DDL call yourself,
expect every other session to block on `sys.objects` until you commit.

### Online DDL

`ALTER INDEX … REBUILD WITH (ONLINE = ON)` lets readers and writers
continue while the index rebuilds. Enterprise / Azure SQL only. forge
doesn't emit `ONLINE=ON` automatically; pass it via `$executeRaw` when
you're rebuilding a large index in production.

---

## Pagination — OFFSET / FETCH

The IR compiler emits `LIMIT n OFFSET m` (PG shape). The MSSQL
compiler's `rewriteLimitOffset()` rewrites that tail into the T-SQL
`OFFSET m ROWS FETCH NEXT n ROWS ONLY` form, which requires an
`ORDER BY` clause to be present. The SELECT builder always emits one
when there's a limit, so the rewrite is safe.

```ts
const page = await db.Posts.findMany({
  orderBy: { createdAt: 'desc' },
  take: 25,
  skip: 75,
});
```

```sql
SELECT [id], [title], [createdAt] FROM [posts]
ORDER BY [createdAt] DESC
OFFSET 75 ROWS FETCH NEXT 25 ROWS ONLY;
```

OFFSET cost grows linearly — page 1000 with `OFFSET 25_000` reads and
discards 25,000 rows. For deep pagination, switch to keyset
(cursor) pagination:

```ts
// First page
const first = await db.Posts.findMany({
  orderBy: { id: 'desc' },
  take: 25,
});
const cursor = first.at(-1)?.id;

// Next page
const next = await db.Posts.findMany({
  where: { id: { lt: cursor } },
  orderBy: { id: 'desc' },
  take: 25,
});
```

Keyset pagination compiles to a clean `WHERE [id] < @p1 ORDER BY [id]
DESC OFFSET 0 ROWS FETCH NEXT 25 ROWS ONLY` — index-perfect. Use it
for infinite-scroll surfaces. OFFSET is fine for "page 1 to 10"
finite UIs.

### `TOP` vs OFFSET / FETCH

`SELECT TOP 25 …` is the older, simpler form — forge uses it only in
the ctid-rewrite path (`WHERE [pk] IN (SELECT TOP 1 [pk] …)`) where
there's no ORDER BY constraint. The IR doesn't compile to `TOP` for
user-facing pagination because `TOP` doesn't support OFFSET.

---

## CTE and window functions

T-SQL has had CTEs since SQL Server 2005 and window functions since
2005 (basic) / 2012 (full LAG/LEAD/percentile). forge's typed query
layer doesn't model CTEs directly — drop to `$queryRaw` for the
recursive cases. The dialect does emit window functions when the IR
groupBy node uses `agg()` projections.

```ts
import { sql } from 'forge-orm';

// Recursive: org hierarchy under a root.
const tree = await db.$queryRaw(sql`
  WITH org_tree AS (
    SELECT [id], [parentId], [name], 0 AS depth
    FROM [organizations]
    WHERE [id] = ${rootId}
    UNION ALL
    SELECT o.[id], o.[parentId], o.[name], t.depth + 1
    FROM [organizations] o
    INNER JOIN org_tree t ON o.[parentId] = t.[id]
  )
  SELECT * FROM org_tree
  OPTION (MAXRECURSION 100);
`);
```

`OPTION (MAXRECURSION 100)` caps the recursion depth — 0 means
unbounded, default is 100. Set it high for deep hierarchies, low for
defensive coding.

Window functions for ranking, running totals:

```ts
const ranked = await db.$queryRaw(sql`
  SELECT
    [id],
    [score],
    RANK() OVER (PARTITION BY [orgId] ORDER BY [score] DESC) AS rank
  FROM [users]
`);
```

The typed `groupBy().agg()` form already emits these for the
documented aggregates (`count`, `sum`, `avg`, `min`, `max`); for
`RANK`, `PERCENT_RANK`, `LAG`, `LEAD`, drop to `$queryRaw`.

---

## Full-text search

SQL Server has a fully-featured FTS engine (`CONTAINS`, `FREETEXT`,
ranked `CONTAINSTABLE` / `FREETEXTTABLE`), but it needs a catalog
created out of band — `CREATE FULLTEXT CATALOG`, `CREATE FULLTEXT
INDEX ON … KEY INDEX <pk>`. forge **does not** emit catalog DDL on
`push`. The `.searchable()` marker is preserved on the schema (doctor
and introspect can see it), but the runtime `searchClause` falls back
to `LIKE '%q%'` so portability holds.

```ts
const Post = model('posts', {
  id:    f.id(),
  title: f.string().searchable(),
  body:  f.text().searchable(),
});

await db.Posts.findMany({ where: { title: { search: 'forge orm' } } });
// LIKE-mode SQL:
//   SELECT … FROM [posts] WHERE [title] LIKE '%' + @p1 + '%'
```

LIKE-mode is fine for low-volume search and gives portable behavior
across the six dialects, but it never uses an index — every query
table-scans. For production, install the FTS catalog and rewrite via
`$queryRaw`:

```sql
CREATE FULLTEXT CATALOG ftCatalog WITH ACCENT_SENSITIVITY = OFF;
CREATE UNIQUE INDEX ux_posts_id ON [posts]([id]);
CREATE FULLTEXT INDEX ON [posts]([title] LANGUAGE 1033, [body] LANGUAGE 1033)
  KEY INDEX ux_posts_id ON ftCatalog
  WITH CHANGE_TRACKING AUTO;
```

Then query with `CONTAINS` or `FREETEXT`:

```ts
import { sql } from 'forge-orm';

// CONTAINS: phrase / AND / OR / proximity, strict syntax.
const phrase = await db.$queryRaw(sql`
  SELECT [id], [title]
  FROM [posts]
  WHERE CONTAINS([title], ${'"forge orm" OR fts'});
`);

// FREETEXT: looser; the engine breaks the query into terms and matches inflections.
const freetext = await db.$queryRaw(sql`
  SELECT [id], [title]
  FROM [posts]
  WHERE FREETEXT(([title], [body]), ${'database search'});
`);

// CONTAINSTABLE / FREETEXTTABLE: same predicates, but return RANK column.
const ranked = await db.$queryRaw(sql`
  SELECT p.[id], p.[title], ft.[RANK]
  FROM [posts] p
  INNER JOIN FREETEXTTABLE([posts], *, ${q}) AS ft ON p.[id] = ft.[KEY]
  ORDER BY ft.[RANK] DESC
  OFFSET 0 ROWS FETCH NEXT 25 ROWS ONLY;
`);
```

The `CHANGE_TRACKING AUTO` mode keeps the index live as the base
table changes. With `OFF`, you populate manually with `ALTER
FULLTEXT INDEX … START FULL POPULATION`.

Azure SQL Database does **not** support full-text search — Azure SQL
Managed Instance does. If you need FTS on Azure SQL, switch to MI or
fall back to `LIKE` / a sidecar (Elasticsearch / Meilisearch). See
[FTS](./FTS.md#mssql) for the long-form companion.

---

## Spatial — geography and geometry

SQL Server has two spatial types:

* **`GEOGRAPHY`** — WGS84-style ellipsoidal coordinates (lat/long on
  a sphere). Distances come back in **meters**. Use this for "real
  world" map data.
* **`GEOMETRY`** — flat-plane Cartesian. Distances in whatever units
  the SRID dictates. Use for floor plans, game maps, anything where
  the Earth's curvature doesn't matter.

forge emits `GEOGRAPHY` by default for `f.geoPoint()`. The dialect
constructs values via `geography::STGeomFromText('POINT(lng lat)',
4326)` — note the **lng lat** order (WKT convention), not lat lng.

```ts
const Store = model('stores', {
  id:       f.id(),
  name:     f.string(),
  location: f.geoPoint(),  // → GEOGRAPHY
});

await db.Stores.create({
  data: {
    name: 'Main St',
    location: { lat: 6.5244, lng: 3.3792 },  // Lagos
  },
});

// near: returns the 10 closest within 5km, sorted by distance ascending.
const near = await db.Stores.findMany({
  where: { location: { near: { lat: 6.5244, lng: 3.3792, withinMeters: 5000 } } },
  orderBy: { location: { distanceFrom: { lat: 6.5244, lng: 3.3792 } } },
  take: 10,
});
```

Compiled:

```sql
SELECT [id], [name], [location],
       [location].STDistance(geography::STGeomFromText(@p1, 4326)) AS _dist
FROM [stores]
WHERE [location].STDistance(geography::STGeomFromText(@p2, 4326)) < @p3
ORDER BY _dist ASC
OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY;
```

The `STDistance` call on `geography` returns meters. On `geometry`
it returns SRID-units (typically the same number, but interpreted
flat). Mixing types in one expression throws — forge always emits
`geography` so this only bites you if you mix in a `$queryRaw`.

### Spatial indexes

`CREATE SPATIAL INDEX` over a geography column needs a bounding-box
spec (geometry) or a default grid (geography). forge's DDL emitter
rewrites `CREATE INDEX … USING gist` (the PG dialect's marker for
spatial method) into `CREATE SPATIAL INDEX [name] ON [table]([col])`.
The default grid (`GRID = (LOW, LOW, LOW, LOW)`) is fine for most
workloads; tune via `$executeRaw` for hot tables.

### MultiPolygon / withinPolygon

The dialect's `geoWithinPolygonClause` builds a `geography::STGeomFromText(<wkt>,
srid).STContains([col]) = 1`. Note the inversion — SQL Server's
`STContains` is "does polygon contain point?", which is what
`withinPolygon` semantically asks.

```ts
await db.Stores.findMany({
  where: {
    location: {
      withinPolygon: {
        type: 'Polygon',
        coordinates: [[[3.3, 6.4], [3.5, 6.4], [3.5, 6.6], [3.3, 6.6], [3.3, 6.4]]],
      },
    },
  },
});
```

The polygon is converted to WKT with `lng lat` ordering (the
`'lng-lat'` axis hint in `toGeoWKT`) to match SQL Server's
expectation. MultiPolygon and GeometryCollection work the same way —
the WKT helper handles both, and SRID defaults to 4326. See
[GEO](./GEO.md#mssql) for the cross-dialect deep dive.

### Azure SQL Edge

Spatial is **not** supported on Azure SQL Edge (the ARM64 testing
image). Use `f.geoPoint({ fallback: true })` for those tests —
fallback stores JSON `{lat, lng}` and runs an in-memory haversine in
forge's JS layer. Doctor reports the missing spatial subsystem.

---

## JSON path queries

JSON support landed in SQL Server 2016 and is stable across every
supported edition. forge stores `f.json()` / `f.embed()` columns as
`NVARCHAR(MAX)` and reaches into them with the three JSON functions:

| T-SQL | Returns | Use |
|---|---|---|
| `JSON_VALUE(col, '$.path')` | scalar (NVARCHAR(4000)) | atoms (string, number, bool). Returns NULL on type mismatch by default; `WITH (LAX)` mode is the default; switch to `STRICT` for error-on-miss. |
| `JSON_QUERY(col, '$.path')` | nested JSON (NVARCHAR(MAX)) | objects / arrays. Returns the JSON-stringified subtree. |
| `OPENJSON(col, '$.path') WITH (...)` | row set | the FROM-clause form; pulls JSON arrays out into derived rows. |

The dialect's `jsonPathExpr` emits `JSON_VALUE`:

```ts
await db.Events.findMany({
  where: { meta: { path: ['source'], eq: 'web' } },
});
```

```sql
SELECT … FROM [events] WHERE JSON_VALUE([meta], '$.source') = @p1;
```

`JSON_VALUE` returns NVARCHAR(4000). For ints/floats wrap with
`CAST`; forge does that automatically for typed `f.json()` access via
the typed-path API (see [JSON-PATH](./JSON-PATH.md#mssql)). Untyped
`{path:[…], eq: 42}` compares against the string `'42'` — equal under
T-SQL implicit conversion but not index-eligible.

### Indexing JSON paths

SQL Server can't index inside a JSON document directly (until 2022's
optimized JSON storage). The standard workaround is a computed +
persisted column, then index that:

```sql
ALTER TABLE [events]
  ADD source_x AS CAST(JSON_VALUE([meta], '$.source') AS NVARCHAR(64)) PERSISTED;
CREATE INDEX ix_events_source_x ON [events](source_x);
```

The IR compiler doesn't auto-generate this — declare via
`$executeRaw` once and forge's introspect reads it back. Without the
index every `JSON_VALUE` predicate is a full scan.

### OPENJSON for array access

When `stringArray` / `intArray` columns are queried with `contains`,
forge emits an `EXISTS (SELECT 1 FROM OPENJSON(col) WHERE value = ?)`:

```ts
await db.Posts.findMany({ where: { tags: { contains: 'forge' } } });
```

```sql
SELECT … FROM [posts]
WHERE EXISTS (SELECT 1 FROM OPENJSON([tags]) WHERE [value] = @p1);
```

`OPENJSON` without a `WITH` clause emits one row per top-level array
element with `[key], [value], [type]` columns. Filter by `[value]`
for the contains check. For typed array reads (json that's actually
`[{name:'…'}, {name:'…'}]`), use the `WITH` form:

```sql
SELECT j.name, j.qty
FROM [orders]
CROSS APPLY OPENJSON([items])
  WITH (name NVARCHAR(255), qty INT) j
WHERE [orders].[id] = @p1;
```

See [JSON-PATH](./JSON-PATH.md#mssql) for the typed JSON access pattern.

---

## Vector — JSON fallback and SQL Server 2025

SQL Server 2025 (currently in preview) adds a native `VECTOR(N)`
type and `VECTOR_DISTANCE('cosine' | 'l2' | 'ip', a, b)`. The
dialect emits the new syntax when `f.vector(N)` is declared, which is
right for Azure SQL Database (which tracks the preview) but **does
not** work on SQL Server 2017 / 2019 / 2022.

For pre-2025 targets, use the JSON-stored fallback:

```ts
const Doc = model('docs', {
  id:        f.id(),
  text:      f.text(),
  embedding: f.json(),  // store as JSON array
});

// On write — pass the array, forge JSON.stringifies it.
await db.Docs.create({ data: { text: '…', embedding: [0.1, 0.2, /* … */] } });

// On read — read back as JSON; compute cosine in the app layer.
const rows = await db.Docs.findMany({ select: { id: true, embedding: true } });
const ranked = rows
  .map((r) => ({ id: r.id, sim: cosine(r.embedding, queryVec) }))
  .sort((a, b) => b.sim - a.sim)
  .slice(0, 10);
```

This is fine for 10K-row corpora; beyond that the round-trip cost
dominates. Options:

* **Hybrid query** — pre-filter with FTS or a metadata index, then
  cosine-rank the small result set in the app.
* **Sidecar** — push the embedding store to a vector DB (Qdrant,
  pgvector via a sidecar Postgres, Pinecone) and keep MSSQL for OLTP.
* **SQL Server 2025 / Azure SQL** — switch to `f.vector(N)` and the
  native `VECTOR_DISTANCE` predicate. The dialect already emits it;
  doctor probes for the version and reports availability.

See [VECTOR](./VECTOR.md#mssql) for the full strategy doc.

---

## Azure SQL specifics

Azure SQL Database and Azure SQL Managed Instance behave like SQL
Server 2022+ at the wire, but the operational model is different:

### DTU vs vCore

* **DTU** — bundled compute + storage + IO units. Simple for small
  apps. `S0` = 10 DTU, `S3` = 100 DTU, `P15` = 4000 DTU. The DTU model
  is a soft cap on everything; the cap doesn't tell you which
  resource is the bottleneck.
* **vCore** — pay per vCore and storage independently. Hyperscale tier
  (vCore-only) supports up to 100TB and instant restore. **Recommended
  for new deployments** — the metrics map directly to what you
  reason about (CPU, memory, IO, log throughput).

Doctor reads `sys.dm_db_resource_stats` and reports the last 60s
average. Sustained CPU > 80% is a sign to scale; sustained log writes
near the limit means batch your writes or switch tier.

### Geo-replication

* **Active geo-replication** — readable secondary in a different region;
  manual or auto failover. The secondary is read-only and lags by
  seconds.
* **Auto-failover groups** — at the server / database level, single
  failover DNS endpoint. The connection string stays stable across
  failover.
* **Geo-restore** — restore from geo-redundant backup to any region.

Forge's read replica detection isn't automatic; pass two `db`
instances (one for writes, one for reads) and route at the app layer.
The MSSQL adapter has no opinion on read/write split.

### Always Encrypted

Column-level encryption with keys held client-side (the SQL Server
never sees plaintext). With Always Encrypted enabled:

* The `mssql` driver needs `columnEncryptionSetting: 'Enabled'` in
  the pool config plus a key store config (Azure Key Vault is the
  typical choice).
* Encrypted columns can only be compared with `=` (deterministic
  encryption) — no LIKE, range, ordering, or join.
* `IDENTITY` columns can't be encrypted; use a string PK + app-side
  ulid.

forge doesn't know about Always Encrypted at the type level — declare
the columns as `f.string()`, set the encryption metadata via
`$executeRaw` ALTER, and queries with `where: { col: value }` still
work. Range queries (`gt`, `lt`) on encrypted columns will fail at
runtime — the driver throws `Operand type clash`.

### Connection limits

| Tier | Concurrent worker threads | Max session count |
|---|---|---|
| Basic | 30 | 300 |
| S0 / S1 | 60 | 600 |
| S2 / S3 | 90 / 200 | 900 / 2400 |
| P1 / P15 | 200 / 6400 | 2400 / 30,000 |
| GP_Gen5_2 / GP_Gen5_16 | 200 / 1600 | 2400 / 19,200 |

The worker count is the hard ceiling on concurrent queries. Hitting it
returns error 10928 (`The resource pool is busy`). Pool the
connection on the app side at well under that — a webserver with
50 concurrent requests should target pool max ~20, not 200.

---

## Connection pool sizing

The `mssql` package owns the pool. forge calls `pool.request()` per
query and `pool.transaction()` per `$transaction`. Defaults are
`min: 0, max: 10, idleTimeoutMillis: 30_000`.

| Workload | Pool max | Why |
|---|---|---|
| Edge (per-request) | 1 | No persistence; one connection per invocation |
| Single-process webserver, 50 RPS | 10–20 | Default usually fine; raise if you see `idleTimeoutMillis` reconnect storms |
| Single-process webserver, 500 RPS | 50–100 | Account for tail latency under load |
| Background worker, batch writes | 5–10 | Long-running tx — too many starves OLTP |
| Long-running analytics | 2–4, separate pool | Don't share a pool with the OLTP path |

```ts
const pool = await sql.connect({
  /* … */
  pool: {
    max: 50,
    min: 2,
    idleTimeoutMillis: 30_000,
    acquireTimeoutMillis: 15_000,  // wait up to 15s for an idle conn before failing
  },
});
```

**Max worker threads** is a server-side knob — `sp_configure 'max
worker threads'`. The default scales with CPU; touch only if you see
SQLSERVER_WAITING_FOR_WORKER waits in `sys.dm_os_wait_stats`.

Register `db.$disconnect()` from `SIGTERM` / `SIGINT` so the pool
drains in flight. `close()` is idempotent — calling it twice on the
same pool is safe.

---

## Errors and codes

The errors module maps SQL Server numeric error codes to forge's
Prisma-style `P` codes via `DbKnownError`. The full table:

| MSSQL number | Forge code | Meaning |
|---|---|---|
| 2627 | `P2002` | PK / UNIQUE violation, named constraint |
| 2601 | `P2002` | UNIQUE index violation (the duplicate-key form, often after MERGE retry) |
| 547  | `P2003` | FOREIGN KEY violation (also fires on CHECK violations historically) |
| 515  | `P2011` | NOT NULL violation on insert/update |
| 208  | `P2021` | Invalid object name — table doesn't exist |
| 207  | `P2022` | Invalid column name |
| 1205 | `P2034` | Deadlock victim — transaction was rolled back, please retry |
| 18456| `P1010` | Login failed for user |

Things that fall through (`P` code not assigned) but you'll meet:

* **3960** — SNAPSHOT isolation update conflict at COMMIT. Catch and retry the tx.
* **10928 / 10929** — Resource governance — out of worker threads or rate limit. Backoff and retry.
* **40197** — Azure SQL service event (failover, software update). Idempotent retry.
* **41302 / 41305 / 41325** — In-Memory OLTP write conflicts. Retry.
* **8645** — Memory grant timeout. Lower the query's parallelism or split it.

```ts
try {
  await db.Products.upsert({ where: { sku }, create, update });
} catch (err) {
  if (err instanceof DbKnownError && err.code === 'P2002') {
    // Race — MERGE saw "no match" twice and the second INSERT lost. Retry.
    return db.Products.upsert({ where: { sku }, create, update });
  }
  throw err;
}
```

The retry-on-deadlock-or-conflict pattern is one place where
`db.$transaction(fn, { retries: 3 })` saves boilerplate — though the
adapter doesn't enforce a max-retry, so build a sane cap in your
wrapper.

---

## Worked examples

### MERGE upsert with composite key

```ts
// Idempotent membership grant: same (orgId, userId) won't double-insert.
await db.OrgMembers.upsert({
  where:  { orgId, userId },
  create: { orgId, userId, role: 'member', joinedAt: new Date() },
  update: { role: 'admin' }, // promote if exists
});
```

```sql
MERGE INTO [org_members] AS tgt
USING (VALUES (@p1, @p2, @p3, @p4)) AS src ([role], [joinedAt], [orgId], [userId])
ON tgt.[orgId] = src.[orgId] AND tgt.[userId] = src.[userId]
WHEN MATCHED THEN UPDATE SET [role] = @p5
WHEN NOT MATCHED THEN INSERT ([role], [joinedAt], [orgId], [userId])
                     VALUES (src.[role], src.[joinedAt], src.[orgId], src.[userId])
OUTPUT INSERTED.*;
```

### OFFSET pagination with stable ORDER BY

```ts
const page = await db.Audit.findMany({
  where: { orgId },
  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // tiebreak so paging is stable
  take: 50,
  skip: (pageNum - 1) * 50,
});
```

```sql
SELECT [id], [orgId], [actor], [event], [createdAt]
FROM [audit]
WHERE [orgId] = @p1
ORDER BY [createdAt] DESC, [id] DESC
OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY;
```

The trailing `[id] DESC` is critical — without it, two rows with the
same `createdAt` ms can flip between pages. Always tiebreak on a
unique column.

### FREETEXT search (CHANGE_TRACKING AUTO)

After provisioning the FTS catalog out-of-band:

```ts
const results = await db.$queryRaw(sql`
  SELECT TOP 25 p.[id], p.[title], ft.[RANK]
  FROM [posts] p
  INNER JOIN FREETEXTTABLE([posts], ([title], [body]), ${query}) AS ft
    ON p.[id] = ft.[KEY]
  WHERE p.[orgId] = ${orgId}
  ORDER BY ft.[RANK] DESC;
`);
```

`FREETEXTTABLE` returns a virtual `{KEY, RANK}` table; `KEY` is the
PK of the matched row. The join binds rank to the base row. `TOP 25`
caps; for paging use a CTE with `ROW_NUMBER() OVER (ORDER BY RANK
DESC)`.

### Geography distance query

```ts
const here = { lat: 6.5244, lng: 3.3792 };

const near = await db.Stores.findMany({
  where: { location: { near: { ...here, withinMeters: 10_000 } } },
  orderBy: { location: { distanceFrom: here } },
  take: 20,
});
```

Each returned row has the original columns. To get the computed
distance alongside, drop to `$queryRaw`:

```ts
const ranked = await db.$queryRaw(sql`
  SELECT
    [id],
    [name],
    [location].STDistance(geography::STGeomFromText(${`POINT(${here.lng} ${here.lat})`}, 4326)) AS meters
  FROM [stores]
  WHERE [location].STDistance(geography::STGeomFromText(${`POINT(${here.lng} ${here.lat})`}, 4326)) < 10000
  ORDER BY meters ASC
  OFFSET 0 ROWS FETCH NEXT 20 ROWS ONLY;
`);
```

`STDistance` on `geography` returns meters; on `geometry` it returns
SRID-units. Mixing the two in one expression throws — the dialect
always emits `geography::STGeomFromText` so this only bites you in
`$queryRaw`.

### Transactional debit-credit with SNAPSHOT

```ts
await db.$transaction(async (tx) => {
  await tx.query(`SET TRANSACTION ISOLATION LEVEL SNAPSHOT`);

  const source = await tx.scope(db).Accounts.findFirst({ where: { id: from } });
  if (!source || source.balance < amount) {
    throw new Error('insufficient funds');
  }

  await tx.scope(db).Accounts.update({
    where: { id: from },
    set:   { balance: { decrement: amount } },
  });
  await tx.scope(db).Accounts.update({
    where: { id: to },
    set:   { balance: { increment: amount } },
  });
});
```

Under SNAPSHOT, the read inside the tx sees the row-version at tx
start. If another tx commits a balance change before this one
commits, the COMMIT throws `3960` and the wrapping retry runs the
whole thing again. The alternative is `SERIALIZABLE` — same
safety, but takes range locks and serializes contending writers,
which throttles throughput.

---

## Cross-links

* [DRIVERS](./DRIVERS.md#mssqldriver) — the `MssqlDriver` port contract, common bugs (`@p1` unbound), wire-compatible swaps (Azure SQL Edge).
* [QUERIES](./QUERIES.md) — `findMany`, `findFirst`, `where`, `orderBy`, `groupBy`, cursor pagination — adapter-agnostic.
* [INDEXES](./INDEXES.md) — `f.index()` / `f.unique()` shape and what the MSSQL DDL writes (partial-filter via `WHERE`, computed-column tricks).
* [FTS](./FTS.md#mssql) — full-text deep dive across all six dialects; MSSQL catalog provisioning recipes.
* [GEO](./GEO.md#mssql) — spatial type / WKT axis conventions / withinPolygon / MultiPolygon.
* [JSON-PATH](./JSON-PATH.md#mssql) — typed JSON path access, OPENJSON projections, computed-column indexing.
* [MUTATIONS](./MUTATIONS.md) — `create`, `update`, `delete`, `upsert` shapes; the MERGE rewrite is the MSSQL specialisation.
* [TRANSACTIONS](./TRANSACTIONS.md) — `db.$transaction(fn)` semantics; per-adapter session shape including `MssqlQueryable`.
* [MIGRATIONS](./MIGRATIONS.md) — `forge push`, plan/apply, idempotent DDL wrappers (`IF NOT EXISTS (sys.tables …) BEGIN … END`).
* [DOCTOR](./DOCTOR.md) — what the MSSQL doctor probe reports — driver, RCSI status, FTS catalog presence, vector availability.
