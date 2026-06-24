# Indexes

`IndexDef` is forge's complete index vocabulary. One shape carries every
common index family — plain b-tree, partial, expression, covering,
geospatial, vector, full-text, hashed, wildcard, invisible, multi-valued —
and the per-dialect emitter picks the right native form. The README's
[Indexes and unique constraints](../README.md#indexes-and-unique-constraints)
section is the surface tour; this document is the complete reference for
the shape, the per-dialect translation, and the production patterns that
actually exercise it.

If something here disagrees with the source, the source is right
(`src/schema/types.ts` for the shape; `src/adapters/<dialect>/ddl.ts` for
the emit).

## 1. `IndexDef` shape

The full type lives at `src/schema/types.ts:166`. Every field, what it
does, and which dialects honour it:

| Field | Mongo | Postgres | MySQL | SQLite | DuckDB | MSSQL |
|---|---|---|---|---|---|---|
| `name` | yes | yes | yes | yes | yes | yes |
| `keys` (`1` / `-1`) | yes | ASC/DESC | ASC/DESC | ASC/DESC | ASC/DESC | ASC/DESC |
| `keys` (`'text'`) | text index | `text_pattern_ops` opclass | column kept | column kept | column kept | column kept |
| `keys` (`'2dsphere'` / `'2d'`) | yes | warn + skip | warn + skip | warn + skip | warn + skip | warn + skip |
| `keys` (`'hashed'`) | yes | warn + skip | warn + skip | warn + skip | warn + skip | warn + skip |
| `unique` | yes | yes | yes | yes | yes | yes |
| `sparse` | yes | n/a (auto via optional) | n/a | n/a | n/a | n/a |
| `expireAfterSeconds` | yes (TTL) | n/a | n/a | n/a | n/a | n/a |
| `partialFilterExpression` | yes | translated via `mongoToSqlWhere` | translated (unique only) | translated | translated | translated |
| `where` (string) | n/a | `WHERE …` | rewritten as `CASE … ELSE NULL` if `unique` | `WHERE …` | `WHERE …` | `WHERE …` |
| `where` (object) | alias of PFE | translated via `mongoToSqlWhere` | translated (unique only) | translated | translated | translated |
| `include` | n/a | `INCLUDE (…)` | warn + skip | warn + skip | warn + skip | `INCLUDE (…)` |
| `expression` | warn + skip | `((expr))` | `((expr))` (MySQL 8+) | `(expr)` | `((expr))` | warn + skip |
| `method: 'btree'` | n/a (default) | default | default | default | default | default |
| `method: 'gin' / 'gist' / 'brin' / 'hash'` | n/a | `USING …` | warn + skip | warn + skip | warn + skip | warn + skip |
| `method: 'spatial'` | resolved to `2dsphere` | `USING GIST` | `SPATIAL INDEX` | virtual rtree | `USING RTREE` | `CREATE SPATIAL INDEX` |
| `method: 'vector'` | warn (Atlas vector search) | `USING hnsw (… opclass)` | warn (no native ANN) | warn (sqlite-vec required) | `USING HNSW` | `USING VECTOR WITH (algorithm='HNSW')` |
| `method: 'fulltext'` | n/a | DB rejects (use `searchable()`) | `FULLTEXT INDEX` | warn + skip | n/a | warn + skip |
| `collation` | yes | n/a — use `expression: 'lower(col)'` | n/a | n/a | n/a | n/a |
| `wildcardProjection` | yes | n/a | n/a | n/a | n/a | n/a |
| `visible` | n/a | warn + ignored | `INVISIBLE` (MySQL 8+) | warn + ignored | warn + ignored | warn + ignored |
| `parser` | n/a | warn + ignored | `WITH PARSER …` (only when `method: 'fulltext'`) | warn + ignored | warn + ignored | warn + ignored |

`keys` is `Record<string, IndexKey>` where `IndexKey = 1 | -1 | 'text' |
'2dsphere' | '2d' | 'hashed'`. Wildcard indexes use `{ '$**': 1 }` and pair
with `wildcardProjection` — see section 11.

Anything not in the table above is silently dropped. The emitter never
errors at push time on an unsupported flag; it `console.warn`s with a
`[forge:push:<dialect>]` prefix, ships the index without the flag, and
keeps going. Schemas stay portable across dialects without `if (dialect
=== 'postgres')` branching at the model definition site.

## 2. Plain b-tree

The default. No `method`, no `expression`, no `where`. Direction tokens
`1` (ASC) and `-1` (DESC) per key, composite keys via multiple entries:

```ts
const Post = model('posts', {
  id:        f.id(),
  author_id: f.objectId(),
  status:    f.enumOf(['DRAFT', 'PUBLISHED'] as const),
  created_at: f.dateTime(),
}, {
  indexes: [
    { keys: { author_id: 1, status: 1 } },        // composite
    { keys: { created_at: -1 } },                  // single, descending
  ],
});
```

Per-dialect DDL:

| Dialect | Emitted |
|---|---|
| Postgres | `CREATE INDEX IF NOT EXISTS "forge_posts_idx_author_id_status" ON "posts" ("author_id" ASC, "status" ASC)` |
| MySQL | ``CREATE INDEX `forge_posts_idx_author_id_status` ON `posts` (`author_id` ASC, `status` ASC)`` |
| SQLite | `CREATE INDEX IF NOT EXISTS "forge_posts_idx_author_id_status" ON "posts" ("author_id" ASC, "status" ASC)` |
| DuckDB | same as SQLite |
| MSSQL | `CREATE INDEX [forge_posts_idx_author_id_status] ON [posts] ([author_id] ASC, [status] ASC)` |
| Mongo | `collection.createIndex({ author_id: 1, status: 1 })` |

The `IF NOT EXISTS` clause is unconditional on dialects that support it
(PG, SQLite, DuckDB). MySQL doesn't, so the migrator (`forge push`) checks
`information_schema.statistics` before issuing the `CREATE INDEX`.

Composite key order matters for the optimiser. The leading column is the
one a query can range-scan on without an additional predicate; trailing
columns extend the prefix. `{ author_id: 1, status: 1 }` answers `WHERE
author_id = ?` and `WHERE author_id = ? AND status = ?` but not `WHERE
status = ?` alone — forge doesn't reorder for you.

## 3. Unique constraints

Three shapes that all mean "this column tuple is unique":

```ts
// Per-column shorthand on the field.
const Item = model('items', {
  sku: f.string().unique(),
});

// Composite uniques on the model options.
const OrderLine = model('order_lines', {
  order_id:  f.objectId(),
  position:  f.int(),
}, {
  uniques: [['order_id', 'position']],
});

// IndexDef with unique: true — the long form. Same surface as a unique
// index manually-written in SQL.
const Slug = model('slugs', {
  tenant_id: f.objectId(),
  slug:      f.string(),
}, {
  indexes: [{ keys: { tenant_id: 1, slug: 1 }, unique: true }],
});
```

All three flow through the same emitter at `src/adapters/<dialect>/ddl.ts`
(`buildPerFieldUniques`, `buildCompositeUniques`, `buildIndexes`). On SQL
dialects the per-column form emits an `ALTER TABLE … ADD CONSTRAINT …
UNIQUE (col)`; the composite and IndexDef forms emit `CREATE UNIQUE INDEX
… ON …`. Functionally identical from the optimiser's point of view, but
constraints show up in `information_schema.table_constraints` whereas
indexes only show up in `information_schema.statistics`. Forge's drift
detector knows the difference and won't false-positive.

### Auto-name convention

Auto-generated names follow `forge_<table>_<kind>_<cols>` with the kind
matching the constraint family:

| Family | Kind |
|---|---|
| Per-column unique | `uq` |
| Composite unique | `uq` |
| Plain index | `idx` |
| Foreign key | `fk` |
| Enum check | `chk` |

So `f.string().unique()` on `users.email` becomes `forge_users_uq_email`.
A composite over `(org_id, slug)` becomes `forge_slugs_uq_org_id_slug`.

The naming helper lives at `src/adapters/<dialect>/ddl.ts`
(`tableConstraintName`). Names over 60 bytes collapse to
`forge_<table>_<kind>_<hash>` where `<hash>` is a deterministic base-36 of
the original name. Postgres caps identifier length at 63 bytes; MySQL at
64; SQLite has no cap but the same helper runs everywhere for consistency.

The `forge_` prefix is reserved. The migrator at
`src/__tests__/postgres-migrate.spec.ts:76` filters owned objects by this
prefix so it never drops constraints a human added by hand. If you set a
custom `name:` on an `IndexDef` you can override the auto-name, but never
use the `forge_` prefix on a hand-named index — drift detection treats
it as forge-owned and will try to reconcile.

### Mongo unique + sparse

Mongo's `unique: true` index considers `null` a value and rejects two
documents both missing the field — surprising if the field is optional.
Forge auto-sets `sparse: true` when the schema field is `.optional()` so
the unique only applies to documents where the field is present:

```ts
const User = model('users', {
  external_id: f.string().optional().unique(),    // sparse + unique on Mongo
});
```

That's done at registry-load time, not in the emitter. Sparse is also
exposed directly on `IndexDef.sparse` for hand-written entries.

## 4. Partial-filter indexes

A partial index is an index that only covers rows matching a predicate.
The classic use is "unique slug per tenant, but only on non-deleted rows":
a unique constraint that ignores soft-deleted rows so a recycled slug
isn't blocked by a tombstone.

Forge supports two shapes — pick one or both:

```ts
indexes: [
  // Cross-dialect: Mongo uses partialFilterExpression, SQL uses where.
  {
    keys: { tenant_id: 1, slug: 1 }, unique: true,
    where: 'deleted_at IS NULL',                           // SQL
    partialFilterExpression: { deleted_at: { $exists: false } },  // Mongo
  },
]
```

If both are set, each dialect picks the one it understands. If only
`where:` is set as a string, Mongo skips the index with a warn (it can't
parse the SQL). If only `partialFilterExpression:` is set, SQL dialects
attempt to translate the Mongo-shape object to SQL via
`src/adapters/shared/mongo-to-sql-where.ts` and emit the result.

### Object-form → SQL translation

`mongoToSqlWhere` covers the operators that show up in real partial-filter
expressions. Anything outside the coverage returns `null`, the emitter
warns and ships the index without the WHERE clause:

| Mongo | SQL |
|---|---|
| `{ col: <scalar> }` | `"col" = <literal>` |
| `{ col: null }` | `"col" IS NULL` |
| `{ col: { $eq: x } }` / `{ $ne: x }` | `=` / `<>` (null-aware) |
| `{ col: { $gt / $gte / $lt / $lte: x } }` | `>` / `>=` / `<` / `<=` |
| `{ col: { $in: [...] } }` / `{ $nin: [...] }` | `IN (…)` / `NOT IN (…)` |
| `{ col: { $exists: true } }` / `{ $exists: false }` | `IS NOT NULL` / `IS NULL` |
| `{ col: { $type: 'string' } }` | `IS NOT NULL` (best-effort) |
| `{ col: { $regex: '…' } }` | `~` (PG) / `REGEXP` (MySQL) / null (SQLite) |
| `{ col: { $size: N } }` | `coalesce(array_length(col, 1), 0) = N` (PG only) |
| `{ col: { $not: { … } } }` | `NOT (…)` |
| `{ $and / $or / $nor: [ … ] }` | recursive compose |

Operators outside this list — `$elemMatch`, `$mod`, `$where`, `$jsonSchema`,
`$expr`, `$geoWithin` — return `null`. The emitter warns:

```
[forge:push:postgres] index 'forge_posts_uq_slug' has an object-form
'where' that uses operators outside the translator's coverage. Pass a
raw SQL string in 'where' or simplify the object. Filter omitted.
```

When the predicate is complex enough that the object form can't carry it,
fall back to a raw SQL string in `where:` and accept that Mongo will skip.

### MySQL workaround

MySQL has no native partial indexes, but the most common partial-unique
pattern can be rewritten as a functional unique over a `CASE` expression.
Forge does the rewrite automatically when the index is `unique: true` and
the filter translates cleanly:

```ts
{ keys: { slug: 1 }, unique: true, where: 'deleted_at IS NULL' }
```

becomes, on MySQL:

```sql
CREATE UNIQUE INDEX `forge_posts_uq_slug` ON `posts` (
  (CASE WHEN (`deleted_at` IS NULL) THEN `slug` ELSE NULL END)
)
```

MySQL doesn't consider `NULL` a duplicate in a unique index, so rows that
don't match the filter all collapse to `NULL` and are exempt. Composite
keys use `JSON_ARRAY(col1, col2)` inside the `THEN` for portability +
deterministic comparison.

Non-unique partials on MySQL have no clean workaround. Forge warns and
ships the index without the WHERE:

```
[forge:push:mysql] index 'forge_logs_idx_warn' uses 'where' on a
non-unique index — MySQL has no partial-index equivalent. Either drop
the filter, mark the index unique (forge will rewrite as a functional
index over a CASE expression), or model the partial scope as a
generated column. Filter ignored.
```

### Worked: soft-delete-aware unique slug

```ts
const Post = model('posts', {
  id:         f.id(),
  slug:       f.string(),
  deleted_at: f.dateTime().optional(),
}, {
  indexes: [{
    keys: { slug: 1 }, unique: true,
    where: 'deleted_at IS NULL',
    partialFilterExpression: { deleted_at: null },
  }],
});
```

| Dialect | Emit |
|---|---|
| Postgres | `CREATE UNIQUE INDEX … ON "posts" ("slug" ASC) WHERE deleted_at IS NULL` |
| SQLite | same as Postgres |
| MySQL | `CREATE UNIQUE INDEX … ON posts ((CASE WHEN (deleted_at IS NULL) THEN slug ELSE NULL END))` |
| Mongo | `createIndex({ slug: 1 }, { unique: true, partialFilterExpression: { deleted_at: null } })` |

### Worked: archived rows excluded

```ts
indexes: [{
  keys: { customer_id: 1, status: 1 },
  where: 'archived = false',
}]
```

Postgres: `… WHERE archived = false`. SQLite: same. Mongo: warns (object
form not provided). MySQL: warns + skips (non-unique partial).

## 5. Expression indexes

`expression:` replaces `keys:` for indexing the result of an arbitrary
SQL expression. The most common use is case-insensitive matching:

```ts
const User = model('users', {
  email: f.string(),
}, {
  indexes: [{
    keys: {}, unique: true,
    expression: 'lower(email)',
  }],
});
```

| Dialect | Emit |
|---|---|
| Postgres | `CREATE UNIQUE INDEX … ON "users" ((lower(email)))` |
| MySQL 8+ | ``CREATE UNIQUE INDEX … ON `users` ((lower(`email`)))`` |
| SQLite | `CREATE UNIQUE INDEX … ON "users" (lower(email))` |
| DuckDB | `CREATE UNIQUE INDEX … ON "users" ((lower(email)))` |
| Mongo | warn + skip (use `collation: { locale, strength: 2 }` for case-insensitive — see section 11) |
| MSSQL | warn + skip (use a persisted computed column + unique on the column) |

The expression body is forwarded raw — forge doesn't parse it. You're
responsible for using SQL the target dialect understands. Cross-dialect
schemas usually accept that the expression covers PG/MySQL/SQLite and
that Mongo + MSSQL need a different shape per dialect.

MySQL's functional index syntax requires the extra outer parens
(`((expr))`) on MySQL 8.0.13+ and rejects `(expr)`. SQLite is the only
dialect that takes `(expr)` directly. Forge emits the dialect-correct
form for you.

### Date-bucketed analytics

```ts
indexes: [{
  keys: {},
  expression: "date_trunc('day', created_at)",
  name: 'idx_events_by_day',
}]
```

Lets `WHERE date_trunc('day', created_at) = '2026-06-23'` use the index
without a sequential scan. Combine with `method: 'brin'` on Postgres if
the table is append-only and the bucketed column correlates with physical
row order.

### MySQL multi-valued JSON

MySQL 8.0.17+ supports multi-valued indexes on JSON arrays:

```ts
indexes: [{
  keys: {},
  expression: "(CAST(tags->'$[*]' AS UNSIGNED ARRAY))",
}]
```

Each array element becomes an index entry. Use with `MEMBER OF` or
`JSON_OVERLAPS`/`JSON_CONTAINS` predicates. Not supported on other
dialects — they'd index the JSON blob as a string.

## 6. `INCLUDE` / covering indexes

Postgres and MSSQL only. `INCLUDE (col1, col2)` adds non-key columns to
the index payload so an index-only scan can satisfy a `SELECT` without
touching the heap.

```ts
const Order = model('orders', {
  id:          f.id(),
  customer_id: f.objectId(),
  status:      f.enumOf(['NEW', 'PAID', 'SHIPPED'] as const),
  total:       f.decimal(),
}, {
  indexes: [{
    keys: { customer_id: 1 },
    include: ['status', 'total'],
  }],
});
```

Emit (Postgres):

```sql
CREATE INDEX "forge_orders_idx_customer_id" ON "orders"
  ("customer_id" ASC) INCLUDE ("status", "total")
```

A query of the shape `SELECT status, total FROM orders WHERE customer_id
= $1` reads the answer directly from the index leaves. Validate with
`EXPLAIN`:

```
Index Only Scan using forge_orders_idx_customer_id on orders
  Index Cond: (customer_id = $1)
  Heap Fetches: 0
```

`Heap Fetches: 0` is the confirmation. Anything else and Postgres is
visiting the heap — usually because the visibility map isn't fresh
(`VACUUM` it).

MySQL, SQLite, DuckDB, and Mongo ignore `include` with a warn:

```
[forge:push:mysql] index 'forge_orders_idx_customer_id' uses include —
INCLUDE is a Postgres-only feature. Ignored on MySQL.
```

If the workload demands a covering index on MySQL, the workaround is to
add the include columns to the key list (`{ customer_id: 1, status: 1,
total: 1 }`). That bloats the index but answers the same query without a
heap visit.

## 7. Index methods

`method:` picks the access method. Per-dialect coverage:

| Method | Mongo | Postgres | MySQL | SQLite | DuckDB | MSSQL |
|---|---|---|---|---|---|---|
| `'btree'` (default) | yes | yes | yes | yes | yes | yes |
| `'hash'` | n/a | `USING hash` | n/a | n/a | n/a | n/a |
| `'gin'` | n/a | `USING gin` | n/a | n/a | n/a | n/a |
| `'gist'` | n/a | `USING gist` | n/a | n/a | n/a | n/a |
| `'brin'` | n/a | `USING brin` | n/a | n/a | n/a | n/a |
| `'spatial'` | resolves to `2dsphere` | `USING gist` | `SPATIAL INDEX` | virtual rtree | `USING RTREE` | `CREATE SPATIAL INDEX` |
| `'vector'` | warn (Atlas Search) | `USING hnsw (… opclass)` | warn (no native) | warn (sqlite-vec) | `USING HNSW` | `USING VECTOR WITH (algorithm='HNSW')` |
| `'fulltext'` | n/a (use `searchable()`) | DB rejects (use `searchable()` for tsvector/GIN) | `FULLTEXT INDEX` | warn (use FTS5 shadow via `searchable()`) | warn | warn |

Mismatched methods don't error at compile time — the database itself
raises a clear `access method does not exist` or `unknown index type`
when the DDL hits.

`'gin'` and `'gist'` are the two Postgres access methods worth thinking
about for non-b-tree work. `gin` is the default for `jsonb @> '…'`
containment, full-text search via `tsvector`, and array containment.
`gist` handles geometric types (PostGIS) and exclusion constraints.
`brin` is for huge append-only tables where the indexed column correlates
with physical row order — logs by `received_at`, events by `created_at`.
A `brin` index is two orders of magnitude smaller than the equivalent
`btree` and still narrows the scan to the right block range.

Forge defaults `method:` to `'btree'` (or undefined, which dialects treat
as their default b-tree). The cross-dialect rule: if the method isn't in
the matrix above for the target dialect, the emitter warns and either
ships the index without the method (PG `USING btree`) or skips entirely.

## 8. Geo indexes

`method: 'spatial'` is the portable cross-dialect form. Pair with
`f.geoPoint()` so the column type and the index family resolve together:

```ts
const Place = model('places', {
  id:       f.id(),
  location: f.geoPoint(),
}, {
  indexes: [{ keys: { location: 1 }, method: 'spatial' }],
});
```

For the full geo story — column type, IR, `near` / `nearTo` /
`withinPolygon` operators, 3D coordinates, non-WGS84 SRIDs, MultiPolygon /
GeometryCollection support — see [GEO.md](./GEO.md).

Mongo also accepts the legacy `keys: { location: '2dsphere' }` shape
directly. Forge maps `method: 'spatial'` to `2dsphere` on Mongo so a
single schema works across the matrix.

## 9. Vector indexes

`method: 'vector'` is the portable form for ANN indexes. Pair with
`f.vector(N, { metric })`:

```ts
const Doc = model('docs', {
  id:        f.id(),
  embedding: f.vector(1536, { metric: 'cosine' }),
}, {
  indexes: [{ keys: { embedding: 1 }, method: 'vector' }],
});
```

The opclass / algorithm picks itself per dialect from the column metric:

| Metric | PG opclass | DuckDB | MSSQL |
|---|---|---|---|
| `'cosine'` | `vector_cosine_ops` | `metric = 'cosine'` | `WITH (metric='cosine')` |
| `'l2'` | `vector_l2_ops` | `metric = 'l2sq'` | `WITH (metric='euclidean')` |
| `'ip'` | `vector_ip_ops` | `metric = 'ip'` | `WITH (metric='dot')` |

For the full vector story — column type, drivers, brute-force fallback,
sqlite-vec virtual tables, Atlas Vector Search, ef_search tuning — see
[VECTOR.md](./VECTOR.md).

## 10. FTS shadow tables

`f.text().searchable()` is the typed path for full-text indexing. Forge
picks the right native shape per dialect at `forge push`:

| Dialect | Shape |
|---|---|
| Postgres | `CREATE INDEX … USING gin (to_tsvector('english', col))` |
| MySQL | `FULLTEXT INDEX (col)` |
| SQLite | virtual table `<tbl>_fts USING fts5(…)` + triggers that mirror INSERT/UPDATE/DELETE |
| DuckDB | `PRAGMA create_fts_index('<tbl>', 'id', 'col')` (fts extension) |
| Mongo | `createIndex({ col: 'text' })` |
| MSSQL | out-of-band (manual `FULLTEXT CATALOG`) |

For triggers, snippet highlighting, language analyzers, and the search
query API, see [FTS.md](./FTS.md).

`method: 'fulltext'` on a raw IndexDef is also supported but skips the
shadow-table machinery. Use it only when you want to control the parser
plugin directly:

```ts
indexes: [{
  keys: { body: 1 },
  method: 'fulltext',
  parser: 'ngram',                  // CJK substring matching on MySQL 8+
}]
```

`parser:` is MySQL-only. `'ngram'` covers CJK substring matching;
`'mecab'` is the Japanese morphological parser (requires `mecab` plugin
loaded). On other dialects the parser is ignored with a warn.

## 11. Mongo-specific

Mongo accepts shapes no SQL dialect understands. Forge passes them
through unchanged via the `createIndex` options bag.

### Direction tokens

`IndexKey` covers all Mongo direction tokens: `1`, `-1`, `'text'`,
`'2dsphere'`, `'2d'`, `'hashed'`. Mixing them in a single `keys` map is
fine — Mongo supports compound text indexes:

```ts
indexes: [{ keys: { content: 'text', tags: 1 } }]
```

`'hashed'` is required for a hashed shard key:

```ts
indexes: [{ keys: { tenant: 'hashed' } }]
```

### Wildcard indexes

A wildcard index covers every field at every depth under a path. Useful
for free-form `metadata` columns where the query shape isn't known at
schema-design time:

```ts
indexes: [{
  keys: { '$**': 1 } as Record<string, IndexKey>,
  wildcardProjection: { 'metadata.$**': 1 },
}]
```

`wildcardProjection` scopes the wildcard. `{ 'metadata.$**': 1 }` indexes
only paths under `metadata`; `{ 'private.$**': 0 }` excludes everything
under `private`.

Wildcard indexes carry their own limits: no `unique`, no `expireAfterSeconds`,
no compound keys. Forge doesn't enforce these at compile time — Mongo
rejects them at `createIndex`.

### Collation

`collation:` builds case- or accent-insensitive indexes without an
expression:

```ts
indexes: [{
  keys: { email: 1 }, unique: true,
  collation: { locale: 'en', strength: 2 },
}]
```

`strength: 2` is case-insensitive; `strength: 1` adds accent-insensitivity.
For a query to use the index, the query must specify the same collation
— either inherited from the collection default or explicit on the
`find()`. Forge's Mongo wrapper forwards collation from query options;
collection-default collation is set at `db.createCollection(name,
{ collation })` time.

SQL dialects warn-and-skip on `collation:`. Use `expression: 'lower(col)'`
on the SQL side and accept the dialect divergence at the schema layer.

## 12. Index naming and collisions

The default name is `forge_<table>_<kind>_<cols>` (section 3). The `forge_`
prefix is exposed at `src/adapters/<dialect>/ddl.ts` as
`RESERVED_INDEX_PREFIX = 'forge_'` and is what the migrator uses to tell
forge-owned objects from hand-rolled ones. The drift loop only proposes
DROPs for objects with this prefix.

Override with an explicit `name:`:

```ts
indexes: [{
  keys: { customer_id: 1 },
  include: ['status', 'total'],
  name: 'orders_covering_customer',
}]
```

Two rules:

* **Don't reuse the `forge_` prefix on a hand-named index.** Drift
  detection treats it as forge-owned. If the auto-derived shape doesn't
  match (and it won't, since you're naming it manually), every push will
  propose a DROP-and-recreate.
* **Don't collide with another auto-generated name.** Two indexes that
  hash-collapse to the same name on a long table name will both try to
  CREATE under the same identifier and the second one will fail. The
  collision is rare in practice (only triggers when both the table name
  is long enough to truncate and the column lists hash to the same
  base-36 value) but the workaround is to set `name:` explicitly.

## 13. Drift detection

`forge diff` reads the live schema back via the adapter's `introspect()`
and compares it to the model graph. Since 2.2 every `IndexDef` field above
is read back where the database stores it:

| Field | Postgres source | MySQL source | SQLite source | Mongo source |
|---|---|---|---|---|
| `name` | `pg_class.relname` | `STATISTICS.INDEX_NAME` | `sqlite_master.name` | `listIndexes().name` |
| `unique` | `pg_index.indisunique` | `STATISTICS.NON_UNIQUE = 0` | `pragma index_info` | `listIndexes().unique` |
| `method` | `pg_am.amname` | `STATISTICS.INDEX_TYPE` | always `btree` | n/a (storage engine) |
| `keys` | `pg_index.indkey` + `attname` | `STATISTICS.COLUMN_NAME` | `pragma index_xinfo` | `listIndexes().key` |
| `where` | `pg_index.indpred` (deparsed) | `INFORMATION_SCHEMA` doesn't carry it; forge re-parses the index expression | `sqlite_master.sql` | n/a |
| `expression` | `pg_get_indexdef` | `INDEX_DEF` | `sqlite_master.sql` | n/a |
| `include` | `pg_index.indnkeyatts` vs `indnatts` | n/a | n/a | n/a |
| `partialFilterExpression` | n/a (use `where`) | n/a | n/a | `listIndexes().partialFilterExpression` |
| `collation` | n/a (per-column) | n/a | n/a | `listIndexes().collation` |
| `wildcardProjection` | n/a | n/a | n/a | `listIndexes().wildcardProjection` |

The diff comparator runs in `src/ir/diff.ts`. Each side normalises into
the same `IntrospectedIndex` shape, then a field-by-field compare emits
drift items: `{ kind: 'index', direction: 'missing' | 'extra' | 'changed',
table, name, detail }`.

### False positives

* **Direction tokens not echoed.** Some Mongo client versions don't
  return `direction` in `listIndexes` for `1` (defaults are dropped). The
  diff treats missing direction as `1` to match.
* **Postgres `WHERE` whitespace.** `pg_get_expr` returns canonicalised
  SQL — `deleted_at IS NULL` may come back as `(deleted_at IS NULL)`. The
  comparator normalises both sides through `mongoToSqlWhere` round-trip
  (when the schema-side is a translatable object) or string-trim +
  whitespace-collapse (when it's a raw SQL string) before comparing.
* **MySQL functional `CASE` rewrite.** Section 4 rewrites partial-unique
  filters into a `CASE` expression. Drift re-derives the same rewrite
  from the schema side and compares the rewritten expression, not the
  original `where:`.
* **Method on SQLite.** SQLite has only one access method, so the
  introspector hard-codes `'btree'`. A schema with `method: 'gin'` won't
  drift on SQLite — it'll warn at push and the introspected method
  matches what was actually created.

### Doctor

`forge doctor` runs the drift detector + a few extra portability checks:

* `keys: { col: 'text' }` on a SQL dialect — warns it'll be silently
  dropped to the column name (PG turns into `text_pattern_ops`; others
  keep the column).
* `method: 'vector'` on Mongo / MySQL — warns the index isn't being
  created where you expected and points at the manual path.
* `where:` object form with operators outside the translator coverage —
  warns the filter won't reach SQL dialects.

## 14. Performance

Index strategy is a workload conversation, but a few rules-of-thumb hold
across dialects.

**Index per query, not per column.** A single composite index over
`(tenant_id, created_at)` covers `WHERE tenant_id = ? ORDER BY created_at
DESC LIMIT 50` cleanly; two separate indexes over `tenant_id` and
`created_at` don't. The optimiser can intersect them but the cost is
higher than a single index-scan.

**Partial indexes for high-cardinality nulls.** If `archived_at` is `NULL`
on 99% of rows, `CREATE INDEX … WHERE archived_at IS NOT NULL` is
~100× smaller than the full index and just as selective for the queries
that filter on archived rows. Mirrors a Postgres-specific feature on
SQLite via raw SQL; MySQL needs the `CASE` rewrite (unique-only).

**Cover when reads bottleneck.** `INCLUDE (…)` turns an index lookup +
heap fetch into a single index-only scan — most of the win is on
high-traffic read-mostly tables where the heap fetch is the dominant
cost. `EXPLAIN ANALYZE` and look for `Heap Fetches: 0`. PG and MSSQL only.

**Indexes have a write cost.** Every secondary index is an extra write on
every INSERT/UPDATE that touches an indexed column. On a high-write table
(events, logs, audit), keep the secondary index count low — `brin` over
`received_at` is enough for time-range scans without per-row overhead.

**`gin` for jsonb containment, `btree` for jsonb equality.** A `jsonb`
column queried with `data @> '{"sku": "X"}'` needs `USING gin`. The same
column queried with `data->>'sku' = 'X'` needs an expression index over
`(data->>'sku')` — `gin` won't help.

**`brin` for append-only.** Logs, events, audit trails — the indexed
column correlates with physical row order, so `brin` over `received_at`
covers range scans at ~0.1% the size of the equivalent `btree`. Index
type that pays for itself only at 10M+ rows.

## 15. Six worked patterns

### (a) Case-insensitive unique email

```ts
const User = model('users', {
  email: f.string(),
}, {
  indexes: [{
    keys: {}, unique: true,
    expression: 'lower(email)',
  }],
});
```

PG / MySQL 8+ / SQLite / DuckDB: emits `CREATE UNIQUE INDEX … ON users
((lower(email)))`. Queries that filter on `WHERE lower(email) = ?` hit
the index; queries on `WHERE email = ?` don't.

Mongo: use `collation: { locale: 'en', strength: 2 }` instead:

```ts
indexes: [{
  keys: { email: 1 }, unique: true,
  collation: { locale: 'en', strength: 2 },
}]
```

### (b) Soft-delete-aware unique slug

```ts
const Post = model('posts', {
  slug:       f.string(),
  deleted_at: f.dateTime().optional(),
}, {
  indexes: [{
    keys: { slug: 1 }, unique: true,
    where: 'deleted_at IS NULL',
    partialFilterExpression: { deleted_at: null },
  }],
});
```

PG / SQLite / DuckDB: `WHERE deleted_at IS NULL`. Mongo:
`partialFilterExpression: { deleted_at: null }`. MySQL: rewritten as
`(CASE WHEN (deleted_at IS NULL) THEN slug ELSE NULL END)`. Recycled
slugs are accepted on every dialect.

### (c) Multi-tenant scoped unique

```ts
const Slug = model('slugs', {
  org_id: f.objectId().optional(),
  slug:   f.string(),
}, {
  indexes: [{
    keys: { org_id: 1, slug: 1 }, unique: true,
    where: 'org_id IS NOT NULL',
    partialFilterExpression: { org_id: { $ne: null } },
  }],
});
```

Composite over `(org_id, slug)` with a partial filter that skips
unscoped rows. Two orgs can reuse the same slug; a slug with no org
isn't constrained. Common for SaaS apps where a small subset of records
(invites, public assets) live outside any org.

### (d) Time-bucketed analytics

```ts
const Event = model('events', {
  id:         f.id(),
  created_at: f.dateTime(),
  metric:     f.string(),
  value:      f.decimal(),
}, {
  indexes: [
    {
      keys: {},
      expression: "date_trunc('day', created_at)",
      name: 'idx_events_by_day',
    },
    {
      keys: { received_at: 1 },
      method: 'brin',                       // PG only — tiny, append-only
    },
  ],
});
```

Day-bucketed queries (`WHERE date_trunc('day', created_at) = '2026-06-23'`)
go straight to the expression index. Range scans (`WHERE created_at
BETWEEN … AND …`) use the BRIN at a fraction of the storage cost of an
equivalent btree.

### (e) Mongo wildcard for free-form metadata

```ts
const Doc = model('docs', {
  id:       f.id(),
  metadata: f.json().optional(),
}, {
  indexes: [{
    keys: { '$**': 1 } as Record<string, IndexKey>,
    wildcardProjection: { 'metadata.$**': 1 },
  }],
});
```

Indexes every path under `metadata`. Queries like `{ 'metadata.priority':
'high' }` or `{ 'metadata.source.system': 'crm' }` hit the index without
declaring each path upfront. Useful when the metadata schema is open to
end-users.

SQL dialects warn-and-skip — wildcard indexes don't translate. For the
same workload on SQL, use a `jsonb` column with a `USING gin` index and
query with `@>` containment.

### (f) Postgres tsvector with generated column + GIN

For multi-column full-text search, a generated `tsvector` column with a
GIN index is the canonical Postgres shape. `.dbgenerated(expr)` emits the
column as `GENERATED ALWAYS AS (<expr>) STORED` on PG / MySQL / SQLite;
the DB engine populates the column on every write.

```ts
const Article = model('articles', {
  id:      f.id(),
  title:   f.string(),
  body:    f.text(),
  search_tsv: f.string().dbgenerated(
    "to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,''))",
  ),
}, {
  indexes: [
    { keys: { search_tsv: 1 }, method: 'gin' },
  ],
});
```

`f.text().searchable()` (section 10) is the shorter form for the
single-column case. The generated-column + GIN form gives explicit
control over the language config, weight, and which columns contribute.
Queries: `WHERE search_tsv @@ plainto_tsquery('english', $1)` — uses the
GIN index.

`.dbgenerated()` emits a STORED generated column. STORED is required for
the GIN index — PG can't index a VIRTUAL generated column. Mongo ignores
`.dbgenerated()` with a warn; persist the shadow field at the
application layer there.

---

## See also

* [Indexes and unique constraints (README)](../README.md#indexes-and-unique-constraints) — the surface tour.
* [QUERIES.md](./QUERIES.md) — how the query builder picks an index, and the operators that need one.
* [GEO.md](./GEO.md) — spatial column types, IR, and the `near` / `nearTo` / `withinPolygon` API.
* [VECTOR.md](./VECTOR.md) — `f.vector(N)` column type, ANN drivers, and brute-force fallback.
* [FTS.md](./FTS.md) — `searchable()` shadow tables and the search query API.
* [JSON-PATH.md](./JSON-PATH.md) — typed JSON paths and the dialect operator matrix.
* [MIGRATIONS.md](./MIGRATIONS.md) — `forge push`, `forge diff`, and the drift loop.
