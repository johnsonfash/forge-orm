# MySQL and MariaDB

forge-orm targets MySQL 5.7+, MySQL 8.x, MariaDB 10.6+, and HeatWave (for vector). This page documents the dialect-specific behavior: driver picks, the InnoDB transaction model, MySQL's idiosyncratic JSON and spatial APIs, FULLTEXT engines, and the operational concerns (charset, online DDL, replication) that touch the forge layer.

## Contents

* [Driver matrix](#driver-matrix)
* [Engine matrix — MySQL 5.7 vs 8.x vs MariaDB 10.6+](#engine-matrix--mysql-57-vs-8x-vs-mariadb-106)
* [Type emit](#type-emit)
* [Charset and collation](#charset-and-collation)
* [JSON columns](#json-columns)
* [FULLTEXT](#fulltext)
* [Spatial](#spatial)
* [HeatWave vector](#heatwave-vector)
* [Transactions and isolation](#transactions-and-isolation)
* [Implicit DDL commit](#implicit-ddl-commit)
* [Online DDL](#online-ddl)
* [`AUTO_INCREMENT` vs UUID](#auto_increment-vs-uuid)
* [Replication](#replication)
* [Connection pool sizing](#connection-pool-sizing)
* [Common errors and fixes](#common-errors-and-fixes)
* [Cross-links](#cross-links)

---

## Driver matrix

Three wrappers ship for the MySQL adapter; all three implement the
same `MysqlDriver` port (`src/adapters/mysql/driver.ts`). The executor
talks to them through mysql2's tuple shape — `[rows, fields]` for
SELECT, `[result, fields]` for DML where `result` carries
`affectedRows` and `insertId`. Non-mysql2 wrappers normalise to that
shape internally; outside `driver.ts`, no executor code branches on
which client is underneath.

| Driver | Best for | Install |
|---|---|---|
| `mysql2Driver` | Long-lived Node, default pool, MySQL or MariaDB over a real socket | `npm i mysql2` |
| `mariadbDriver` | MariaDB Connector/Node — measurable decoder edge on rowsets >10k | `npm i mariadb` |
| `planetscaleDriver` | PlanetScale over fetch — Workers, Edge, Vercel Edge Runtime | `npm i @planetscale/database` |

The URL prefixes routed to the MySQL adapter are
`mysql://` and `mariadb://`. Other Vitess-compatible engines
(TiDB, Vitess in the wild) all speak the MySQL wire protocol — point
`mysql2Driver` at them and the same SQL emit works. PlanetScale is
the exception only because the transport is HTTP, not TCP, so
connection pooling and transaction semantics differ.

```ts
// (a) URL only — forge picks mysql2 by default.
const db = await createDb({ url: process.env.MYSQL_URL!, schema });

// (b) MariaDB over a custom pool — own the lifecycle for TLS callbacks
//     or socket-path connections.
import mariadb from 'mariadb';
const pool = mariadb.createPool({
  host: 'db.internal', user: 'app', password: process.env.DB_PASS!,
  connectionLimit: 50, bigIntAsNumber: true, insertIdAsNumber: true,
});
const db = await createDb({ schema, driver: mariadbDriver(pool) });

// (c) PlanetScale on Vercel Edge — HTTP transport, stateless conn.
import { connect } from '@planetscale/database';
const conn = connect({ url: process.env.DATABASE_URL });
const db = await createDb({ schema, driver: planetscaleDriver(conn) });
```

### Connection-string parity

`mysql://user:pass@host:3306/dbname?ssl=true&timezone=Z` is the
shared shape. mysql2 and mariadb both honour `ssl`, `timezone`,
`connectionLimit`, `dateStrings`, `decimalNumbers`, and
(mariadb-only) `bigIntAsNumber` query params. The forge factory
passes the URL straight through to `createPool({ uri: url })` on
mysql2; for mariadb you build the pool yourself.

### Capability differences

| Capability | `mysql2Driver` | `mariadbDriver` | `planetscaleDriver` |
|---|---|---|---|
| Promise pool | Yes | Yes | n/a — single conn |
| Server-side stream | Yes (real cursor) | No — buffers | No — HTTP buffers |
| `insertId` as JS number | Native | `bigIntAsNumber` opt-in | Coerced via `Number()` |
| Multi-statement | Opt-in | Off by default | Not supported |
| Transactions | `START TRANSACTION` | `beginTransaction()` | `conn.transaction(fn)` |
| Distributed XA | Yes (rarely safe) | Yes | No |

mysql2 is the only wrapper that runs a real server-side cursor for
`findManyStream` — the others fall back to OFFSET/LIMIT chunking.

---

## Engine matrix — MySQL 5.7 vs 8.x vs MariaDB 10.6+

Three engine families share the wire protocol, but the SQL surface
they accept diverges. forge picks the most portable form available
across all three; features that only exist on one are gated behind a
schema flag.

| Feature | MySQL 5.7 | MySQL 8.x | MariaDB 10.6+ | HeatWave |
|---|---|---|---|---|
| `WITH` / CTE | No | Yes | Yes (10.2+) | Yes |
| Recursive CTE | No | Yes | Yes | Yes |
| Window functions | No | Yes | Yes (10.2+) | Yes |
| `JSON` column type | Yes | Yes | Yes (as alias for LONGTEXT) | Yes |
| `JSON_TABLE` | No | Yes | No | Yes |
| `JSON_VALUE` | No | Yes | Yes (10.6+) | Yes |
| Expression / functional indexes | No | Yes | Yes (10.5+) | Yes |
| `INVISIBLE` indexes | No | Yes | Yes (10.6+, called `IGNORED`) | Yes |
| Check constraints (enforced) | Parsed, ignored | Yes | Yes | Yes |
| Native partial indexes | No | No | No | No |
| `CHECK` on `IN(...)` (enum) | Parsed, ignored | Yes | Yes | Yes |
| FULLTEXT on InnoDB | Yes | Yes | Yes | Yes |
| `ngram` parser | Yes | Yes | No — use `mecab` | Yes |
| `SPATIAL` indexes on InnoDB | Yes (8.0.4 backport) | Yes | Yes | Yes |
| `SRID` on spatial columns | No | Yes | Yes | Yes |
| `ST_Distance_Sphere` | Yes | Yes | Yes (10.2+) | Yes |
| `VECTOR(N)` column | No | 9.0+ | No | Yes (HNSW/IVF) |
| `STRING_TO_VECTOR` | No | 9.0+ | No | Yes |
| `GENERATED ALWAYS AS` | Yes | Yes | Yes | Yes |
| `INSTANT` algorithm for `ADD COLUMN` | 5.7 limited | 8.0.12+ wide | 10.3+ | 8.0.12+ |
| `ON DUPLICATE KEY UPDATE` | Yes | Yes | Yes | Yes |
| `INSERT … RETURNING` | No | No | Yes (10.5+) | No |
| `ANALYZE TABLE` durable stats | Yes | Yes (persistent) | Yes (persistent) | Yes |

The forge implications:

* **No CTE on 5.7** — the IR avoids `WITH` for read paths. Cursor
  pagination is always emitted as an outer SELECT with a tuple
  predicate, not as a `WITH … SELECT FROM …` reshape. If you write
  `$queryRaw` against MySQL 5.7 you have to do the same.
* **`JSON_TABLE` is 8.x only** — the JSON-path operator emits
  `JSON_EXTRACT` + `JSON_UNQUOTE` (covered below). It works on every
  supported version. Only reach for `JSON_TABLE` in raw SQL on 8.x.
* **Expression indexes are 8.0+ on MySQL, 10.5+ on MariaDB** —
  `index({ expression: 'LOWER(name)' })` is the schema form
  (see [INDEXES](./INDEXES.md#expression-indexes)). On 5.7 the
  push fails with `ER_PARSE_ERROR`; the doctor probe surfaces this
  during pre-flight.
* **Check constraints are advisory on 5.7** — `forge push` still
  emits the `ADD CONSTRAINT … CHECK` statement (it parses) but the
  server does not enforce it. Enum fields fall back to app-side
  validation on the inbound coerce path.
* **`INSERT … RETURNING` on MariaDB 10.5+** is not yet used by the
  adapter — every `insert` / `update` round-trips a follow-up SELECT
  when the caller needs the inserted row, on every MySQL flavour
  including MariaDB. The doctor note mentions it; the adapter's
  follow-up SELECT path is the only one in the executor.

### Detecting the version at runtime

```ts
const report = await db.$doctor();
console.log(report.notes);
// → "Driver: mysql2 (3.10.0). Server: MySQL 8.4.0 (utf8mb4_0900_ai_ci)."
```

The doctor probe queries `@@version`, `@@version_comment`, and the
default collation. The collation matters — see below.

---

## Type emit

The MySQL dialect's column-type mapping lives in
`src/adapters/mysql/dialect.ts` (`columnType` on `MysqlDialect`). The
defaults err on the safe side for InnoDB row-format limits.

| Schema field | Emit |
|---|---|
| `f.id()` (default) | `VARCHAR(64) NOT NULL` (app-side gen) |
| `f.id({ idType: 'bigserial' })` | `BIGINT NOT NULL AUTO_INCREMENT` |
| `f.id({ idType: 'uuid' })` | `CHAR(36) NOT NULL DEFAULT (UUID())` |
| `f.objectId()` | `VARCHAR(64)` |
| `f.string()` | `VARCHAR(255)` |
| `f.text()` | `TEXT` |
| `f.int()` | `INT` |
| `f.float()` | `DOUBLE PRECISION` |
| `f.decimal(precision, scale)` | `DECIMAL(p,s)` |
| `f.uuid()` | `CHAR(36)` |
| `f.bigint()` | `BIGINT` |
| `f.bool()` | `TINYINT(1)` (`0`/`1`, never `TRUE`/`FALSE`) |
| `f.dateTime()` | `DATETIME(3)` — millisecond precision |
| `f.json()` | `JSON` |
| `f.enum(['A','B'])` | `VARCHAR(64)` + `CHECK (col IN ('A','B'))` |
| `f.embed(M)` | `JSON` |
| `f.embedMany(M)` | `JSON DEFAULT (JSON_ARRAY())` |
| `f.stringArray()` / `f.intArray()` | `JSON` |
| `f.geoPoint()` | `POINT NOT NULL SRID 4326` |
| `f.vector(N)` | `VECTOR(N)` (MySQL 9+ / HeatWave) |

### Why VARCHAR(255), not 191 or 256

The default `f.string()` width is 255 because that is the maximum
that fits a single-column unique index under utf8mb4 on InnoDB without
running into the historical 767-byte index prefix limit. On MySQL 5.7
that limit only relaxes with `innodb_large_prefix=ON` and
`row_format=DYNAMIC` (both defaults on 8.x and on 5.7.7+). 255 chars
× 3 bytes = 765 — under the limit by two bytes; that's the historical
reason the cap is 255 and not 256.

If you need longer keys, override the column with a `.raw('VARCHAR(1024)')`
emit annotation — or move the value to `TEXT` and accept that you cannot
declare a plain `UNIQUE` on it without a key-length prefix (`UNIQUE (col(255))`).

### TEXT, MEDIUMTEXT, LONGTEXT

The default `f.text()` emits `TEXT` (64 KB). Override the emit when
you need the bigger forms:

| Storage class | Bytes | Schema |
|---|---|---|
| `TINYTEXT` | 255 | rare; use `VARCHAR` instead |
| `TEXT` | 64 KB | `f.text()` |
| `MEDIUMTEXT` | 16 MB | `f.text({ raw: 'MEDIUMTEXT' })` |
| `LONGTEXT` | 4 GB | `f.text({ raw: 'LONGTEXT' })` |

Picking the right size matters for `ROW_FORMAT=DYNAMIC` overflow
behaviour: TEXT / BLOB columns get their first 768 bytes stored
inline and the rest on overflow pages. Reads of large columns
incur extra page fetches. If 95% of your rows fit in 64 KB and the
tail spills to multi-MB, model the long tail as a separate table
keyed by `id` and join only when needed.

### `DATETIME(3)` and the timezone trap

forge emits `DATETIME(3)` — millisecond precision. It does **not**
emit `TIMESTAMP`. Three reasons:

1. `TIMESTAMP` is 4 bytes and overflows in 2038 (Y2K38).
2. `TIMESTAMP` is implicitly converted to / from the session
   timezone — meaning the value you store depends on
   `@@session.time_zone`.
3. `DATETIME` is a naive wall-clock time stored in UTC by convention.

Always set the session timezone to `'+00:00'` or `'UTC'` on the
connection options:

```ts
mysql.createPool({ uri: url, timezone: 'Z', dateStrings: false });
```

mysql2 with `timezone: 'Z'` and `dateStrings: false` returns
`Date` objects assumed-UTC. mariadb behaves the same with
`timezone: 'Z'`. PlanetScale always returns UTC strings; the
executor wraps them in `new Date(str)` on the outbound decode path.

### `DECIMAL` returns strings on mysql2

mysql2's default preserves decimal precision by returning strings
instead of `Number`. `f.decimal()` is typed as `string` to match.
If you want JS numbers, pass `decimalNumbers: true` on the pool —
the executor doesn't double-cast, so the wire shape is what you get.

```ts
mysql.createPool({ uri: url, decimalNumbers: true });
```

### `BIGINT` and JS-number safety

mysql2 returns `BIGINT` as JS `number` by default — values above
`Number.MAX_SAFE_INTEGER` (2^53 - 1) silently lose precision.
Either declare `f.bigint()` and accept the string return shape, or
pass `supportBigNumbers: true, bigNumberStrings: true` on the pool.
mariadb returns `BigInt` natively unless you opt out via
`bigIntAsNumber: true, insertIdAsNumber: true` — match mysql2's
shape with that combo, or accept the `BigInt` everywhere.

### Generated columns

`field.dbGenerated` compiles to
`GENERATED ALWAYS AS (<expr>) STORED`. `STORED` is mandatory because
`VIRTUAL` columns cannot be indexed on InnoDB until 8.0.13 and even
then only with extra ceremony. The MySQL adapter emits STORED to keep
the index path universally available — the storage cost of a stored
column is a real column write per row, but the indexable surface is
worth it for most schemas. Override with a `.raw()` annotation if
you specifically want VIRTUAL.

---

## Charset and collation

Every table forge creates emits
`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4` (see `buildCreateTable`).
utf8mb4 is the only safe choice — `utf8` is the historical 3-byte
truncation that drops most emoji and supplementary-plane characters.

The collation is **not** named explicitly in the emit. That means it
falls back to the server's default, which differs by version:

| Server | Default collation |
|---|---|
| MySQL 5.7 | `utf8mb4_general_ci` |
| MySQL 8.0+ | `utf8mb4_0900_ai_ci` |
| MariaDB 10.6+ | `utf8mb4_general_ci` (still) |

The two are not equivalent. `_0900_ai_ci` is accent-insensitive
(matches `é` to `e`) and uses the Unicode 9 sort order;
`_general_ci` is a flat byte comparison with ad-hoc folding rules.
A query that matches "Élise" by name with `LIKE 'el%'` works on 8.x
out of the box, and fails on 5.7 / MariaDB unless you call
`LOWER()` first or upgrade the collation.

### The `mode: 'insensitive'` flag

forge's text-operator flag (see
[QUERIES](./QUERIES.md#mode-insensitive)) is a no-op on MySQL,
deliberately. The reasoning:

* On `_0900_ai_ci` (the 8.x default) every `LIKE` is already
  case-insensitive; flipping a flag would be redundant.
* On `_bin` or `_cs` collations the only honest translation is
  `LOWER(col) LIKE LOWER(?)`, which defeats any index on the column.
* The adapter picks the conservative path: the flag is dropped and
  the query runs with whatever the column's collation says.

If you need predictable case-insensitive search regardless of
collation, store a `name_lc` generated column and filter on that:

```ts
const User = model('users', {
  id:      f.id(),
  name:    f.string(),
  name_lc: f.string().dbGenerated('LOWER(name)'),
});
// CREATE INDEX … ON users (name_lc);
await db.user.findMany({ where: { name_lc: { contains: 'él' } } });
```

The generated column is stored, indexed, and never written by the
app — the trigger fires on every INSERT/UPDATE.

### Switching collations mid-life

Changing the column collation on a non-empty table re-sorts every
index that touches the column. On a 50M-row table that's hours.
Plan for it:

```sql
ALTER TABLE posts
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,
  ALGORITHM=COPY, LOCK=SHARED;
```

The copy is unavoidable — the index keys themselves change. Run it
behind `pt-online-schema-change` or `gh-ost` on production; see
[Online DDL](#online-ddl).

---

## JSON columns

`f.json()` emits a native `JSON` column on every supported MySQL
flavour. MariaDB stores `JSON` as `LONGTEXT` with the `CHECK (JSON_VALID(col))`
constraint applied internally — same surface, slightly different
storage.

### Read path — `JSON_EXTRACT` + `JSON_UNQUOTE`

The IR emits `JSON_UNQUOTE(JSON_EXTRACT(col, '$.path'))`. The
`JSON_UNQUOTE` is required: `JSON_EXTRACT` returns JSON-encoded
values, meaning a string is wrapped in literal quotes (`"foo"` not
`foo`). Comparing that against a plain `?` placeholder always returns
false unless you unwrap it first.

```ts
// User code:
await db.user.findMany({
  where: { meta: { path: 'profile.age', gte: 18 } },
});
```

```sql
-- Emit:
SELECT * FROM `users`
 WHERE CAST(JSON_UNQUOTE(JSON_EXTRACT(`meta`, '$.profile.age')) AS UNSIGNED) >= ?
```

The `CAST` is added by the IR when the path operator is a number
comparator (`lt`, `lte`, `gt`, `gte`). String comparisons skip the
cast.

### Indexing JSON via generated columns

Native expression indexes on JSON paths work on 8.0+, but the
ergonomic pattern is the generated-column trick — promote the JSON
path to a real column, index that column:

```ts
const User = model('users', {
  id:    f.id(),
  meta:  f.json(),
  // age is auto-extracted and indexed for cheap range scans
  age:   f.int().dbGenerated("CAST(JSON_UNQUOTE(JSON_EXTRACT(meta, '$.profile.age')) AS UNSIGNED)"),
}, {
  indexes: [{ keys: { age: 1 }, name: 'idx_users_age' }],
});
```

The generated column is updated on every write — no app code needs
to know it exists. Filtering on `age` uses the index; filtering on
`meta.profile.age` via the path operator still re-extracts.

### `JSON_TABLE` (8.x only)

For un-nesting an embedded array into rows, `JSON_TABLE` is the
right tool. It is 8.x only — MariaDB does not have it. Drop to
`$queryRaw` for that:

```ts
const sql = forge.sql`
  SELECT u.id, jt.tag
    FROM users u,
         JSON_TABLE(u.meta, '$.tags[*]'
           COLUMNS (tag VARCHAR(64) PATH '$')) AS jt
   WHERE u.id = ${id}
`;
const rows = await db.$queryRaw(sql);
```

See [RAW-SQL](./RAW-SQL.md#interpolation-rules) for the safe
interpolation rules.

### `null` in a JSON column

`null` on a JSON column is ambiguous — column NULL vs JSON literal
`null`. forge exposes `ForgeDbNull`, `ForgeJsonNull`, and
`ForgeAnyNull` markers (see
[QUERIES](./QUERIES.md#null-markers)). On MySQL:

| Marker | Emit |
|---|---|
| `ForgeDbNull` | `` `col` IS NULL `` |
| `ForgeJsonNull` | `` JSON_TYPE(`col`) = 'NULL' `` |
| `ForgeAnyNull` | `` (`col` IS NULL OR JSON_TYPE(`col`) = 'NULL') `` |

`JSON_TYPE` is the canonical MySQL discriminator. PostgreSQL uses
`(col::jsonb = 'null'::jsonb)`; same idea, different emit.

---

## FULLTEXT

`f.text().searchable()` (or `f.string().searchable()`) auto-emits a
FULLTEXT index per searchable column:

```sql
ALTER TABLE `posts` ADD FULLTEXT `forge_posts_fts_title` (`title`);
```

The runtime operator is `MATCH() AGAINST()` in `NATURAL LANGUAGE MODE`:

```sql
WHERE MATCH(`body`) AGAINST (? IN NATURAL LANGUAGE MODE)
```

### MyISAM vs InnoDB FULLTEXT

Historical lore says FULLTEXT lives on MyISAM. That stopped being
true with MySQL 5.6. Both engines now support it. Forge always uses
InnoDB (the only engine emitted by `buildCreateTable`); the FULLTEXT
index lives on the same table. The difference for InnoDB FULLTEXT:

* Inverted-index updates are batched in the `FTS_DOC_ID_INDEX`
  auxiliary table; `OPTIMIZE TABLE` flushes them. Heavy write loads
  build up unflushed entries until the next optimise.
* The minimum word length defaults to 3 chars
  (`innodb_ft_min_token_size`); set to 1 for CJK or partial-match
  needs. Requires a server restart.
* Stopwords live in `INFORMATION_SCHEMA.INNODB_FT_DEFAULT_STOPWORD`
  (read-only) or a user table named via
  `innodb_ft_server_stopword_table='db/tbl'`.

### ngram parser for CJK

Default tokenisation splits on whitespace and punctuation — terrible
for Chinese, Japanese, Korean. The `ngram` parser breaks the text
into n-char windows instead:

```ts
const Post = model('posts', {
  id:   f.id(),
  body: f.text().searchable(),
}, {
  indexes: [{
    keys: { body: 'text' },
    method: 'fulltext',
    parser: 'ngram',
    name:   'forge_posts_fts_body_ngram',
  }],
});
```

The dialect renders `WITH PARSER ngram` after the column list.
Window size is server-level (`ngram_token_size`, default 2). On
MariaDB the `mecab` parser is the equivalent for Japanese
morphological tokenisation — same `parser:` field.

### BOOLEAN mode and the syntax leak

`NATURAL LANGUAGE MODE` is the default. Switching to `BOOLEAN MODE`
unlocks `+required -excluded "exact phrase"` syntax — but the
adapter does not expose a flag. Drop to `$queryRaw`:

```ts
const sql = forge.sql`
  SELECT * FROM posts
   WHERE MATCH(body) AGAINST (${query} IN BOOLEAN MODE)
   ORDER BY MATCH(body) AGAINST (${query} IN BOOLEAN MODE) DESC
   LIMIT 20
`;
```

The reason it's a `$queryRaw` is that the same operator surface
needs to mean the same thing across SQLite FTS5 and Postgres tsquery
— BOOLEAN-mode syntax is MySQL-specific. The cross-portable surface
is `search: 'apple banana'` (which on MySQL becomes natural language
mode, on PG becomes `plainto_tsquery`).

See [FTS](./FTS.md) for the deep dive on engines, scoring, and
hybrid BM25+vector.

### Rebuilding FULLTEXT

Mass deletes leave tombstones in the FULLTEXT cache. Schedule
`OPTIMIZE TABLE posts;` weekly on hot search columns. It rebuilds
the auxiliary tables and reclaims space.

---

## Spatial

`f.geoPoint()` emits a typed `POINT` column with an explicit SRID:

```sql
`location` POINT NOT NULL SRID 4326
```

The `SRID 4326` clause is **mandatory on MySQL 8.x for spatial
indexes**. Without it, the index is built against a Cartesian plane
and great-circle queries return wrong distances. forge always emits
the SRID — default 4326 (WGS84). Override per-field:

```ts
const Pickup = model('pickups', {
  id:       f.id(),
  // Web Mercator — for tile-aligned visualisations
  location: f.geoPoint({ srid: 3857 }),
});
```

### The lat-first axis-order quirk

MySQL SRID 4326 stores points as `POINT(lat lng)` — latitude first.
PostGIS stores them as `ST_MakePoint(lng, lat)` — longitude first.
The adapter handles this in `valueExpr`: a `{ lng, lat }` input is
written as `POINT(lat lng)` for MySQL. If you go around the adapter
with raw SQL, mirror it — getting the order wrong puts every point
in the wrong hemisphere.

### `ST_*` function reference

The IR emits these functions for the geo operators:

| Operator | Emit |
|---|---|
| `near: { lng, lat, withinMeters }` | `ST_Distance_Sphere(col, ST_GeomFromText(?, 4326)) < ?` |
| `orderBy nearTo` | Same `ST_Distance_Sphere` expression in the ORDER BY |
| `withinPolygon: poly` | `ST_Within(col, ST_GeomFromText(?, 4326))` |
| `geoDistanceExpr` (select-side projection) | `ST_Distance_Sphere(col, ref)` |

`ST_Distance_Sphere` returns metres on SRID 4326. The function is
faster than `ST_Distance` (which considers full ellipsoidal geodesy)
and accurate to within ~0.1% for typical app distances — good enough
for "stores within 5 km".

### `SPATIAL` indexes

Spatial indexes are R-tree-backed on InnoDB 5.7.5+. They are
required for `ST_Within` and friends to use index lookup rather than
a full table scan. forge declares them via the schema's `indexes`
array with `method: 'spatial'`:

```ts
const Store = model('stores', {
  id:       f.id(),
  location: f.geoPoint(),
}, {
  indexes: [{ keys: { location: 1 }, method: 'spatial', name: 'idx_stores_loc' }],
});
```

That emits `CREATE SPATIAL INDEX idx_stores_loc ON stores(location)`.
SPATIAL is a statement-prefix keyword, not a `USING SPATIAL` clause —
the dialect handles the distinction. See [GEO](./GEO.md) for the
per-dialect catalog.

### Non-WGS84 SRIDs

The `f.geoPoint({ srid: N })` syntax emits the SRID at DDL time so
the index aligns with the projection. forge does **not** call
`ST_Transform` between SRIDs at query time — the input point and the
column must share the SRID, or the query throws
`ER_GIS_DIFFERENT_SRIDS`. Plan one SRID per column.

### 3D points

`f.geoPoint({ dims: 3 })` is a forge convenience for "include the
`alt` scalar in TypeScript". MySQL 8.x does not natively support
`POINT Z` — only the 2D ground point is indexed and stored. The
adapter drops `alt` at the storage layer; the JSON-shape round-trip
happens via a sibling scalar column. See
[GEO](./GEO.md#3d-points-and-altitude) for the round-trip pattern.

---

## HeatWave vector

MySQL 9.0 introduced a native `VECTOR(N)` type and `STRING_TO_VECTOR`
function for parsing JSON-array literals. forge emits both:

```ts
const Doc = model('docs', {
  id:        f.id(),
  embedding: f.vector(1536, { metric: 'cosine' }),
});
```

```sql
`embedding` VECTOR(1536)
-- Insert:
INSERT INTO `docs` (`embedding`) VALUES (STRING_TO_VECTOR(?))
-- Query (orderBy nearTo):
ORDER BY DISTANCE(`embedding`, STRING_TO_VECTOR(?), 'COSINE') ASC
```

The `DISTANCE(col, vec, metric)` function returns the chosen
distance — `'COSINE'`, `'DOT'`, or `'EUCLIDEAN'`. forge's `metric`
field on `f.vector()` is uppercased and passed through.

### Community vs HeatWave

* **Community 9.x** — brute-force scan. No HNSW, no IVF.
  Acceptable up to ~100k rows; above that the unindexed scan
  dominates query latency.
* **HeatWave Vector Store** — the index forms (`HNSW`, `IVF_FLAT`)
  are HeatWave-only. Sub-millisecond at 10M+ vectors. The schema
  surface to declare the index is `method: 'vector'` with an
  `index_kind` option — same `indexes` array, just on the
  HeatWave-aware version.

forge gates the vector path behind a runtime probe: `db.$doctor()`
checks `SHOW VARIABLES LIKE 'innodb_vector_search'` and reports
whether the feature is on. On unsupported versions the field's DDL
fails with `ER_PARSE_ERROR` at push time.

See [VECTOR](./VECTOR.md) for the per-dialect distance reference
(`<=>` on pgvector, `vec_distance_cosine` on sqlite-vec, the same
`DISTANCE` on MySQL/HeatWave).

---

## Transactions and isolation

InnoDB is the only engine forge emits. Transactions are MVCC with
record + gap locks; isolation defaults to `REPEATABLE READ`.

### `$transaction` shape

```ts
await db.$transaction(async (tx) => {
  await tx.user.create({ data: { email } });
  await tx.org.update({ where: { id: orgId }, data: { count_inc: 1 } });
});
```

The adapter opens a real `START TRANSACTION` on a pinned connection
and threads the connection through `ExecOpts.session`. On commit the
connection is released back to the pool; on throw it's rolled back
first. The wrapper code lives in `mysql2Driver.transaction` (and
mirrored shapes in `mariadbDriver` and `planetscaleDriver`).

### Isolation levels

Override per transaction via the session settings:

```ts
await db.$transaction(async (tx) => {
  await tx.$queryRaw(forge.sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
  // … reads inside this txn now see committed snapshots only
}, { isolation: 'READ COMMITTED' });   // pseudo — set via $queryRaw on MySQL
```

The four MySQL levels and what they cost you:

| Level | Reads | Phantom risk | Gap locks |
|---|---|---|---|
| `READ UNCOMMITTED` | Dirty reads allowed | Yes | Yes |
| `READ COMMITTED` | No dirty reads | Yes — re-runs see new rows | **No** — only record locks |
| `REPEATABLE READ` (default) | Snapshot-stable | No — gap locks block inserts | Yes |
| `SERIALIZABLE` | As REPEATABLE READ + range S-locks | No | Yes, more aggressive |

The big practical difference is `READ COMMITTED` vs the default:
under `READ COMMITTED` InnoDB does not take gap locks, which kills
most deadlock cascades on hot write paths. The tradeoff is that
`SELECT … FOR UPDATE` inside a transaction can race with concurrent
inserts. Pick `READ COMMITTED` for high-concurrency OLTP, leave the
default for batch jobs that need a stable snapshot.

### Gap locks and the phantom row problem

The `REPEATABLE READ` default is unusual — most databases use
`READ COMMITTED`. The MySQL choice means a transaction that does
`SELECT … FOR UPDATE WHERE order_id BETWEEN 100 AND 200` locks not
just the rows in that range but also the *gaps* between them.
Concurrent inserts of `order_id = 150` block until the transaction
commits.

This is how InnoDB prevents phantom reads under `REPEATABLE READ`
without doing serial scheduling. It also means a hot range filter
under load becomes a deadlock factory.

The fix is one of three:

1. Drop to `READ COMMITTED` for transactions that don't need
   snapshot stability.
2. Switch the index access pattern so the predicate hits a unique
   key (gap locks degenerate to record locks on uniques).
3. Use `SELECT … LOCK IN SHARE MODE` only when really needed,
   and outside transactions where possible.

### Deadlock retry

`ER_LOCK_DEADLOCK` (1213) is mapped to `P2034 — Transaction deadlock
— please retry`. The adapter does not auto-retry; that's the caller's
job because retrying the same transaction has side-effect implications
the adapter cannot reason about. The pattern:

```ts
async function withRetry<T>(fn: () => Promise<T>, max = 3): Promise<T> {
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (e: any) {
      if (e?.code !== 'P2034' || i === max - 1) throw e;
      await new Promise((r) => setTimeout(r, 50 * 2 ** i));
    }
  }
  throw new Error('unreachable');
}

await withRetry(() => db.$transaction(async (tx) => { /* … */ }));
```

Exponential backoff with three attempts is enough for the common
case. Beyond that the contention is structural — find the hot
write and reshape it.

`ER_LOCK_WAIT_TIMEOUT` (1205) is a different beast — it means a
single lock wait exceeded `innodb_lock_wait_timeout` (default 50s).
Same `P2034` code; same retry approach, but if you see it often the
transaction is just too long. Move read-only work outside the txn.

### Transactions and DDL — read the next section

DDL implicitly commits. This is critical and rarely what callers
expect:

---

## Implicit DDL commit

Every DDL statement on MySQL implicitly commits the current
transaction. There are no savepoints around DDL the way there are on
PostgreSQL. Concretely:

```ts
await db.$transaction(async (tx) => {
  await tx.user.create({ data: { email } });
  await tx.$queryRaw(forge.sql`CREATE TABLE temp_stage (id INT)`);
  // The user.create just got committed. The transaction is now
  // over. A subsequent throw will not roll back the create.
  await tx.user.update({ /* … */ });
});
```

This affects the migration runner (`src/adapters/mysql/migrate.ts`).
Unlike Postgres, forge cannot wrap the entire `forge push` batch in
a single transaction — DDL statements implicitly close any open txn.
Instead, the runner:

1. Acquires a session-level lock via
   `SELECT GET_LOCK('forge_migrate', 60)`. This serialises concurrent
   pushes (CI + local + the human running it ad-hoc).
2. Reads `INFORMATION_SCHEMA.TABLES`, `TABLE_CONSTRAINTS`,
   `STATISTICS` once to know what already exists.
3. Runs each statement in order, outside a transaction. A failed
   statement leaves prior successes applied — the same semantic as
   `prisma db push`. The `ApplyReport` carries `{ applied, skipped,
   failures }` so the caller knows where the break happened.
4. Releases the lock via `SELECT RELEASE_LOCK(?)`.

This means recovering from a half-applied push requires manual
inspection. The doctor probe's `diff` command tells you what's still
missing, and the migration runner is idempotent — re-running it
picks up where the failure left off.

DDL inside `$transaction` is **never safe** on MySQL. If you need
atomic schema changes, take application downtime and run them via
`forge push` outside any application transaction.

See [MIGRATIONS](./MIGRATIONS.md) for the safe-DDL playbook.

---

## Online DDL

MySQL's online DDL framework lets some `ALTER TABLE` operations run
without blocking concurrent reads or writes. The framework picks
between `ALGORITHM=INSTANT`, `INPLACE`, and `COPY`, and between
`LOCK=NONE`, `SHARED`, and `EXCLUSIVE`. forge does not pin these
algorithms — every `ALTER` falls back to whatever MySQL picks by
default. If you need predictability, run the ALTER yourself with
explicit clauses and let forge's introspection pick up the change
on the next push.

### Algorithm matrix

| Operation | INSTANT? | INPLACE? | LOCK=NONE? |
|---|---|---|---|
| `ADD COLUMN` at end with default (8.0.12+) | Yes | Yes | Yes |
| `ADD COLUMN` in the middle | No | Yes | Yes |
| `DROP COLUMN` | 8.0.29+ | Yes | Yes |
| `ADD INDEX` (non-FULLTEXT) | No | Yes | Yes |
| `ADD FULLTEXT INDEX` | No | No (rebuilds table) | No |
| `ADD FOREIGN KEY` | No | Yes | Yes |
| `MODIFY COLUMN` (widen) | 8.0.29+ some | Yes | Yes |
| `CONVERT TO CHARACTER SET` | No | No | No |

Routine schema evolution (`ADD COLUMN`, `ADD INDEX`) is online on
8.0.12+. Anything that touches FULLTEXT, charset, or row format is
offline and copies the whole table.

### `pt-online-schema-change` for the offline cases

On older versions or for offline operations, the standard tool is
`pt-online-schema-change` from Percona Toolkit. It:

1. Creates a shadow table with the new schema.
2. Installs triggers that propagate writes from the old table to
   the shadow.
3. Backfills the old table's rows into the shadow in chunks.
4. `RENAME TABLE` atomically swaps the two.

```sh
pt-online-schema-change \
  --alter "ADD COLUMN dropoff_window TINYINT(1) NOT NULL DEFAULT 0" \
  --execute D=app,t=orders,h=db.internal
```

The forge schema must be updated to match the post-rename state, or
the next `forge push` will try to re-add the column. The introspect
path reads from `INFORMATION_SCHEMA`, so once the rename completes
the next `push` is a no-op.

`gh-ost` (from GitHub) is the same idea without triggers — it
replays from the binlog instead. Pick `gh-ost` when triggers are
forbidden by the app architecture (e.g., binlog replication that
filters trigger output), otherwise `pt-osc` is simpler.

---

## `AUTO_INCREMENT` vs UUID

Three id strategies. The default is app-side string UUID v4.

```ts
const User = model('users', { id: f.id() });
// → VARCHAR(64) NOT NULL, value generated app-side by `cuid()` / `nanoid()` / similar
```

The override matrix:

```ts
// bigserial — BIGINT NOT NULL AUTO_INCREMENT. lastInsertId comes back via insertId.
const Audit = model('audit', { id: f.id({ idType: 'bigserial' }) });

// uuid — CHAR(36) NOT NULL DEFAULT (UUID()). DB-side gen via the UUID() function.
const Doc = model('docs',  { id: f.id({ idType: 'uuid' }) });
```

### When to pick each

| Strategy | Picks for | Avoid when |
|---|---|---|
| `auto` (app-side string) | Distributed inserts, ID known at client, cross-DB joins by string key | High write rate to a single hot table — strings are 2× the index size of bigints |
| `bigserial` | Heavy single-master writes, audit logs, analytics fact tables | Sharded writes, offline-first clients that need a local id pre-sync |
| `uuid` (CHAR(36)) | Cross-shard inserts, predictable string format | Hot append-only tables — random UUIDs are terrible for B-tree locality |

### The UUID-index locality problem

`UUID()` returns random v1-like UUIDs that scatter writes across the
entire B-tree. On a 100M-row table this turns every insert into a
random page write — your buffer pool churns and write throughput
collapses.

The fix is `UUID_TO_BIN(UUID(), 1)` — the `1` flag rearranges the
timestamp components so consecutive UUIDs land on adjacent pages.
forge does not emit this by default because not every workload
benefits; if you need it, override:

```ts
const Order = model('orders', {
  // BINARY(16) instead of CHAR(36) — half the size, ordered inserts.
  id: f.id({ idType: 'uuid' }).raw('BINARY(16) NOT NULL DEFAULT (UUID_TO_BIN(UUID(), 1))'),
});
```

The tradeoff is that the column is now binary — every read needs
`BIN_TO_UUID(id, 1)` to render as a string. Hide that behind a
view or accept that the app sees `Buffer`.

### `bigserial` and the auto-increment cache

InnoDB allocates `AUTO_INCREMENT` values in batches controlled by
`innodb_autoinc_lock_mode`:

| Mode | Behaviour |
|---|---|
| 0 (legacy) | Table-level lock per insert. Serial; safe; slow. |
| 1 (consecutive, default on 5.7) | Bulk inserts pre-allocate a contiguous range; gaps possible on rollback. |
| 2 (interleaved, default on 8.x) | Per-row allocation, fully parallel; gaps and non-monotonic order. |

Mode 2 is fast and the new default but breaks the assumption that
"higher id == later in time". If your code reads sort order from the
id (audit logs, cursor pagination on id), set
`innodb_autoinc_lock_mode=1` or add a real `created_at`.

---

## Replication

MySQL has two replication formats: STATEMENT and ROW. The choice
ripples into how the forge schema is interpreted on replicas.

| Format | Replicated payload | Determinism risk |
|---|---|---|
| STATEMENT (`SBR`) | The SQL statement | `NOW()`, `RAND()`, non-deterministic UDFs drift |
| ROW (`RBR`) | The actual changed rows | None — replicas apply byte-for-byte |
| MIXED | STATEMENT, ROW when needed | Less drift than pure SBR, smaller binlog than pure RBR |

Forge's emits are deterministic enough for either format, but two
gotchas:

* **`UUID()` defaults** — under SBR, the replica re-evaluates
  `UUID()` and gets a different value. If you rely on `id =
  UUID()` on the master, switch the binlog format to `ROW` or pre-compute
  the UUID app-side.
* **`CURRENT_TIMESTAMP(3)` defaults** — `now()` differs by
  microseconds between master and replica under SBR, which can
  break `WHERE created_at = ?` lookups on replicas. Same fix —
  use `ROW` format, or always pass the timestamp from the app.

### Read replicas

The forge driver does not natively split reads to replicas. The
pattern is two adapters:

```ts
const writeDb = await createDb({ url: process.env.MYSQL_PRIMARY!,  schema });
const readDb  = await createDb({ url: process.env.MYSQL_REPLICA!,  schema });

await writeDb.user.create({ data });           // writes go to primary
await readDb.user.findMany({ where: { … } }); // reads go to replica
```

Replication lag is the perennial bug — a read right after a write
might miss the write. The mitigation patterns:

1. **Sticky session** — route reads after a recent write to the
   primary for a short window (e.g., 1 second).
2. **`MASTER_POS_WAIT`** — block on the replica until it catches
   up to a known binlog position before reading.
3. **GTID sync** — wait for the master's GTID set to apply.

forge does not implement any of these — they live above the adapter.
The transactional read inside a `$transaction` always uses the
primary because the session is pinned to one connection.

---

## Connection pool sizing

The pool size question is: how many concurrent queries can the
server handle, divided by how many app processes share it.

| Side | Knob | Typical |
|---|---|---|
| Server | `max_connections` | 151 (default) — bump to 500–1000 for OLTP |
| Server | `wait_timeout` | 28800s (8 hrs) — drop to 600s for idle reaping |
| App | mysql2 `connectionLimit` | 50 (forge default) |
| App | mariadb `connectionLimit` | 50 |
| App | PlanetScale | n/a — HTTP, per-request |

The forge default of 50 is calibrated for a single Node process
serving moderate OLTP. If you run 4 app processes against a single
MySQL server, that's 200 total connections — comfortable under the
default 151 cap once you bump it.

### Two pool patterns

A pattern that scales well:

```ts
// Hot pool — short transactions, small queries
const writePool = mysql.createPool({ uri: url, connectionLimit: 50 });
// Cold pool — long analytics queries
const readPool  = mysql.createPool({ uri: url, connectionLimit: 5 });

const writeDb = await createDb({ schema, driver: mysql2Driver(writePool.promise()) });
const readDb  = await createDb({ schema, driver: mysql2Driver(readPool.promise()) });

// Long report queries never starve the OLTP path
await readDb.$queryRaw(forge.sql`SELECT … with window funcs and joins`);
```

A long analytics query that holds a connection for 60s would
otherwise eat into the 50-connection pool that serves user requests.
Separating them keeps p99 stable.

### `wait_timeout` and stale connections

Pools that hold idle connections beyond `wait_timeout` see them get
silently killed by the server. The next query returns `EHOSTUNREACH`
or `ECONNRESET`. mysql2 reconnects on the next query; mariadb does
the same. PlanetScale is HTTP — no idle connections to lose.

If you see "MySQL server has gone away" (errno 2006), the pool's
idle timeout exceeds the server's `wait_timeout`. Drop the pool's
`idleTimeout` below it:

```ts
mysql.createPool({ uri: url, connectionLimit: 50, idleTimeout: 60_000 });
```

The forge emitter surfaces server-gone errors as `P1001` and
includes the errno in the detail — see below.

### Shutdown handlers

```ts
process.on('SIGTERM', async () => {
  await db.$disconnect();
  process.exit(0);
});
```

`$disconnect` calls `pool.end()` on the underlying client. Without
it, in-flight queries finish but the pool sockets close on FIN,
which can confuse load balancers expecting graceful drains.

---

## Common errors and fixes

The full mapping lives in `src/adapters/mysql/errors.ts` and surfaces
through `withMysqlErrors`. Selected entries:

| errno | code | Symptom | Fix |
|---|---|---|---|
| 1062 | `P2002` | `ER_DUP_ENTRY` — unique constraint failed | Check the index name in the message; on upsert paths reach for `db.X.upsert({ where, create, update })` |
| 1452 | `P2003` | `ER_NO_REFERENCED_ROW_2` — fk insert fails | Parent row missing. Order writes parent-first inside `$transaction` |
| 1451 | `P2003` | `ER_ROW_IS_REFERENCED_2` — fk delete blocked | Declare `relation({ onDelete: 'Cascade' })` or delete children explicitly |
| 1048 | `P2011` | `ER_BAD_NULL_ERROR` — null on NOT NULL | Field is `.optional()`? if not, app forgot to pass it |
| 3819 | `P2004` | `ER_CHECK_CONSTRAINT_VIOLATED` | Enum value not in list. On 5.7 the check is ignored — validation happens app-side |
| 1146 | `P2021` | `ER_NO_SUCH_TABLE` | Forgot `forge push` on the env, or you pointed at the wrong schema |
| 1054 | `P2022` | `ER_BAD_FIELD_ERROR` | Pre-push code referencing a not-yet-applied column. Run `db.$diff()` |
| 1213 | `P2034` | `ER_LOCK_DEADLOCK` | Retry the transaction with backoff (see Transactions) |
| 1205 | `P2034` | `ER_LOCK_WAIT_TIMEOUT` | Long transactions on hot rows. Shorten the txn or drop to `READ COMMITTED` |
| 1317 | `P2024` | Query interrupted (timeout) | The client cancelled — usually upstream HTTP timeout |
| 2002 | `P1001` | Connection refused | Server down or wrong host/port |
| 2003 | `P1001` | Can't connect to MySQL server | Firewall, security group, or TLS handshake fail |
| 2006 | `P1001` | MySQL server has gone away | Pool idle > `wait_timeout`. Drop `idleTimeout` (see above) |
| 1045 | `P1010` | `ER_ACCESS_DENIED_ERROR` | Wrong credentials. Try `mysql -u … -p` to confirm |

### "Specified key was too long; max key length is 3072 bytes"

InnoDB's per-index key limit is 3072 bytes on `ROW_FORMAT=DYNAMIC`
(default on 8.x), 767 on legacy `COMPACT`. A composite unique on
three `VARCHAR(255)` utf8mb4 columns is 3 × 255 × 4 = 3060 bytes —
under the limit but cutting it close. Either drop a prefix length
(`UNIQUE (col1(100), col2(100), col3(100))`), hash the column
(`SHA256(col)` as `BINARY(32)`), or confirm the row format is
`dynamic` with `SELECT @@innodb_default_row_format`.

### "Lost connection to MySQL server during query"

Hit `net_read_timeout` or `net_write_timeout` (default 60s + 60s).
Bump them server-side or chunk via cursor pagination
(see [QUERIES](./QUERIES.md#pagination--offset-vs-cursor)).

### "Too many connections"

`max_connections` exceeded. Bump the server cap, lower the pool size,
or front the server with `ProxySQL` / `mysql-router`. PlanetScale's
HTTP transport sidesteps it entirely.

### "Incorrect string value: '\\xF0\\x9F…' for column"

Column charset is `utf8`, not `utf8mb4`. forge emits utf8mb4 on
every CREATE TABLE; the column predates the upgrade. Convert per-
column with `ALTER TABLE t MODIFY col … CHARACTER SET utf8mb4` or
per-table with `ALTER TABLE t CONVERT TO CHARACTER SET utf8mb4
COLLATE utf8mb4_0900_ai_ci`. Both rebuild the table — run them
under `pt-online-schema-change` on production.

---

## Cross-links

* [DRIVERS](./DRIVERS.md) — `MysqlDriver` port shape, transaction semantics across wrappers
* [QUERIES](./QUERIES.md) — operator emit tables, `MATCH() AGAINST()` for `search`, the `mode: 'insensitive'` notes
* [INDEXES](./INDEXES.md) — `method: 'fulltext'`, `method: 'spatial'`, expression indexes, `INVISIBLE`, partial-unique-via-CASE rewrite
* [FTS](./FTS.md) — FULLTEXT engine deep dive, `ngram` / `mecab` parsers, BOOLEAN mode, hybrid BM25+vector
* [GEO](./GEO.md) — `ST_*` reference, lat-first axis order, 3D point handling, SRID alignment, MultiPolygon emit
* [VECTOR](./VECTOR.md) — `VECTOR(N)`, HeatWave HNSW, `DISTANCE(col, vec, metric)` vs pgvector `<=>`
* [MIGRATIONS](./MIGRATIONS.md) — implicit-DDL-commit constraint, `forge_migrate` advisory lock, `pt-online-schema-change`
* [TYPES](./TYPES.md) — `decimalNumbers`, `bigIntAsNumber`, `dateStrings` and their TypeScript shape effects
* [TRANSACTIONS](./TRANSACTIONS.md) — `$transaction`, isolation overrides, deadlock retry, gap locks under `REPEATABLE READ`
* [JSON-PATH](./JSON-PATH.md) — `JSON_UNQUOTE(JSON_EXTRACT(…))`, `JSON_TYPE` null disambiguation, generated-column indexes
