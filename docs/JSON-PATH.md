# JSON path queries — deep dive

The README chapter **[JSON path queries](../README.md#json-path-queries)**
covers the `where: { col: { path: '...', equals: ... } }` shape and the
operator set. This doc goes deeper: the exact SQL each dialect emits per
operator, how to index JSON paths so those reads stay fast, when to reach
for `f.json()` vs `f.embed()` vs a flat column, the null markers, and the
audit-log / event-sourcing / interop patterns that JSON columns actually
get used for in production.

If you have not read the README chapter yet, start there — this doc
assumes you know the call shape.

## Contents

* [Dialect translation table](#dialect-translation-table)
* [Per-dialect SQL emit, worked examples](#per-dialect-sql-emit-worked-examples)
* [Indexing JSON paths](#indexing-json-paths)
* [Schema patterns: JSON vs columns](#schema-patterns-json-vs-columns)
* [Embedded objects + JSON paths together](#embedded-objects--json-paths-together)
* [Path expressions reference](#path-expressions-reference)
* [Type coercion gotchas — JSON null vs DB null vs absent](#type-coercion-gotchas--json-null-vs-db-null-vs-absent)
* [Nested aggregation](#nested-aggregation)
* [Audit log pattern](#audit-log-pattern)
* [Webhooks and event sourcing](#webhooks-and-event-sourcing)
* [External tool interop](#external-tool-interop)
* [Common bugs and their fixes](#common-bugs-and-their-fixes)

---

## Dialect translation table

The IR carries the path as a `string[]` plus a sub-operator (one of `eq`
`ne` `lt` `lte` `gt` `gte` `contains` `in` `has`). Each dialect's
`jsonPathExpr` turns the path into a native read; the comparison
operator stays the same scalar SQL each dialect already uses for column
reads.

| Dialect    | Path read                                                | Example: `meta.profile.age`                                 |
|------------|----------------------------------------------------------|-------------------------------------------------------------|
| Postgres   | `(col->'a'->'b'->>'c')::<cast>` — cast picked by operand | `("meta"->'profile'->>'age')::numeric = $1`                  |
| MySQL 8 / MariaDB 10.7+ | `JSON_UNQUOTE(JSON_EXTRACT(col, '$.a.b.c'))` | ``JSON_UNQUOTE(JSON_EXTRACT(`meta`, '$.profile.age'))`` `>= ?` |
| SQLite     | `json_extract(col, '$.a.b.c')` — JSON1, always built-in  | `json_extract("meta", '$.profile.age') >= ?`                |
| DuckDB     | `json_extract(col, '$.a.b.c')`                           | `json_extract("meta", '$.profile.age') >= ?`                |
| MSSQL 2016+| `JSON_VALUE(col, '$.a.b.c')` — scalars only              | `JSON_VALUE([meta], '$.profile.age') >= @p1`                |
| Mongo      | Dotted key — `{ 'col.a.b.c': … }`                        | `{ 'meta.profile.age': { $gte: 18 } }`                      |

Numeric path segments emit native array indexing per dialect:
`addresses[0].city` becomes `"meta"->'addresses'->0->>'city'` on PG,
`$.addresses[0].city` on every JSON-extract dialect, and the dotted
`meta.addresses.0.city` form on Mongo (which Mongo resolves through
array elements correctly).

---

## Per-dialect SQL emit, worked examples

One subsection per dialect with the call site, the literal SQL or
aggregation forge emits, and the per-dialect quirk worth knowing.

### Postgres

PG's `->` returns `jsonb`, `->>` returns `text`. Forge always navigates
with `->` for intermediate segments and switches to `->>` on the last
segment, then casts based on the operand type:

| Operand type | Cast       |
|--------------|------------|
| `number`     | `::numeric`|
| `boolean`    | `::boolean`|
| `Date`       | `::timestamptz` (parameter is the ISO string) |
| anything else| no cast — comparison happens as `text` |

```ts
await db.doc.findMany({
  where: { meta: { path: 'profile.age', gte: 18 } },
});
// → SELECT … FROM "doc" WHERE ("doc"."meta"->'profile'->>'age')::numeric >= $1
```

```ts
await db.doc.findMany({
  where: { meta: { path: 'profile.active', eq: true } },
});
// → WHERE ("doc"."meta"->'profile'->>'active')::boolean = $1
```

```ts
await db.doc.findMany({
  where: { meta: { path: 'profile.tags', contains: 'engineer' } },
});
// → WHERE "doc"."meta"->'profile'->>'tags' LIKE $1  -- $1 = '%engineer%' (LIKE-escaped)
```

`has` (array membership) emits a cheap text containment on the JSON
representation — portable, but not index-friendly. For real array
containment use a separate `f.stringArray()` column with a GIN index, or
write `db.$queryRaw` directly with `@>`.

### MySQL 8 / MariaDB 10.7+

`JSON_EXTRACT` returns the value as JSON-encoded — so strings come back
wrapped in `"…"`. Forge wraps every emit in `JSON_UNQUOTE` so the
text-side equality with a plain string parameter works without surprise.

```ts
await db.doc.findMany({
  where: { meta: { path: 'profile.role', eq: 'admin' } },
});
// → SELECT … FROM `doc` WHERE JSON_UNQUOTE(JSON_EXTRACT(`doc`.`meta`, '$.profile.role')) = ?
```

Numeric comparisons work even though the unquoted left-hand side is a
string — MySQL implicitly converts on `<` / `>` / `=` against a numeric
parameter. If you need strict typing, write `CAST(... AS UNSIGNED)`
through `db.$queryRaw` and skip the path operator.

MariaDB's `JSON` column is an alias for `LONGTEXT` plus a CHECK; the
same `JSON_EXTRACT` form works. Watch `forge diff` for type drift if
you originally pushed against MySQL and later point the same schema
at MariaDB — see [Common bugs](#common-bugs-and-their-fixes).

### SQLite

SQLite has shipped the JSON1 extension built-in since 3.38; forge
assumes it's available on every modern sqlite (including the wasm
adapter — see **[Browser](../README.md#browser-sqlite-wasm--opfs)**).

```ts
await db.doc.findMany({
  where: { meta: { path: 'tags[0]', eq: 'urgent' } },
});
// → SELECT … FROM "doc" WHERE json_extract("doc"."meta", '$.tags[0]') = ?
```

`json_extract` returns the JSON-decoded value directly (text for
strings, number for numbers, `NULL` for SQL null and JSON null both —
SQLite makes no distinction here, see
[gotchas](#type-coercion-gotchas--json-null-vs-db-null-vs-absent)).

### DuckDB

Same surface as SQLite — `json_extract` — over DuckDB's native JSON
type. DuckDB's planner can push the extract into the column scan when
there's an expression index. For analytics columns you can also
restructure with `STRUCT` types ahead of time and skip JSON entirely.

```ts
await db.event.findMany({
  where: { payload: { path: 'order.state', eq: 'paid' } },
});
// → SELECT … FROM "event" WHERE json_extract("event"."payload", '$.order.state') = ?
```

### MSSQL 2016+

`JSON_VALUE` returns the scalar at the path, or `NULL` if the path
targets an object or array. Forge always emits `JSON_VALUE`; for
querying array values use `OPENJSON` through `db.$queryRaw`.

```ts
await db.doc.findMany({
  where: { meta: { path: 'profile.dept', eq: 'eng' } },
});
// → SELECT … FROM [doc] WHERE JSON_VALUE([doc].[meta], '$.profile.dept') = @p1
```

MSSQL stores JSON in an `nvarchar(max)` column. There is no `jsonb`-
style binary form. Indexing happens via computed columns — see below.

### Mongo

Mongo treats every path segment as a dotted key on the document; there
is no extraction function at all. Forge prefixes the column name and
joins with `.`:

```ts
await db.doc.findMany({
  where: { meta: { path: 'profile.age', gte: 18 } },
});
// → db.doc.find({ 'meta.profile.age': { $gte: 18 } })
```

Numeric segments work natively — Mongo resolves `meta.tags.0` against
an array element. `contains` emits a `$regex` with the operand
LIKE-escaped; `has` emits the bare value because Mongo's matcher
applies array-element equality automatically when the field is an
array.

```ts
await db.doc.findMany({ where: { meta: { path: 'tags', has: 'urgent' } } });
// → db.doc.find({ 'meta.tags': 'urgent' })  -- matches docs whose meta.tags includes 'urgent'
```

For richer per-element conditions (e.g. "tag matches name AND
priority"), drop to `db.$queryRaw` or use `$elemMatch` via the Mongo
driver directly; forge's path vocabulary intentionally stays scalar.

---

## Indexing JSON paths

This is the part that is consistently under-documented elsewhere. A
`where: { meta: { path: …, eq: … } }` filter compiles to a
function-style expression on every SQL dialect, and a function on a
column is not indexable by a plain B-tree. You get one of four
solutions per dialect.

### Postgres — GIN, `jsonb_path_ops`, expression index

PG's `jsonb` type supports three different indexable shapes:

```ts
// 1. GIN over the whole column — wide coverage, larger index.
//    Indexes every key and value; supports @>, ?, ?|, ?&.
const Doc = model('docs', {
  id:   f.id(),
  meta: f.json(),
}, {
  indexes: [{ keys: { meta: 1 }, method: 'gin' }],
});
// → CREATE INDEX "doc_meta_gin" ON "doc" USING gin ("meta")

// 2. jsonb_path_ops — half the size of the default opclass, but only
//    supports the @> containment operator. Use when you only do
//    containment queries.
indexes: [{ keys: { meta: 1 }, method: 'gin',
            expression: '"meta" jsonb_path_ops' }],

// 3. Single-path expression index — narrow but B-tree-fast.
//    Best when one hot path drives most reads.
indexes: [{ keys: {}, expression: "((meta->>'role'))" }],
// → CREATE INDEX … ON "doc" (((meta->>'role')))
```

The path operator in forge emits `(... ->> 'role')::numeric` style
expressions; PG's planner matches an expression index only when the
indexed expression is byte-identical to the where clause. So if you
index `((meta->>'role'))` the planner will use it for the text-cast
form; if your filter is numeric (`eq: 42`) you must index
`(((meta->>'count')::numeric))` to match.

For containment queries (`@>`), use `db.$queryRaw`:

```ts
await db.$queryRaw`SELECT id FROM "doc" WHERE meta @> '{"profile":{"role":"admin"}}'::jsonb`;
```

That `@>` will use either GIN opclass.

### MySQL 8 — multi-valued indexes and virtual columns

MySQL has two index shapes for JSON:

```ts
// 1. Multi-valued index over a JSON array — each array element gets
//    its own index entry. Required for indexed `MEMBER OF` queries on
//    a JSON array. The CAST shape is what MySQL recognises.
indexes: [
  { keys: {},
    expression: "(CAST(`meta`->'$.tags' AS CHAR(50) ARRAY))" },
],

// 2. Virtual generated column + B-tree index. Better when the hot
//    path is scalar (a single string, number, or date).
//    Declare the column at DDL time, then index it.
indexes: [
  { keys: {},
    expression: "((CAST(JSON_UNQUOTE(JSON_EXTRACT(`meta`,'$.profile.role')) AS CHAR(64))))" },
],
```

For the virtual-column route you can also push the column into the
schema directly with `f.string()` and a generated-column SQL hook
through a migration (forge does not emit `GENERATED ALWAYS AS ...`
itself; that goes through `db.$queryRaw` or a migration file).

MariaDB only gained multi-valued indexes in 10.7; on older MariaDB
falls back to scanning. Use `EXPLAIN` to confirm the index is picked.

### SQLite — expression indexes

SQLite indexes expressions natively. The index key must be identical
to the JSON-path expression forge emits, including the path string:

```ts
indexes: [
  { keys: {}, expression: "json_extract(meta, '$.kind')" },
],
// → CREATE INDEX "doc_meta_kind" ON "doc" (json_extract(meta, '$.kind'))
```

That index will be picked by:

```ts
await db.doc.findMany({ where: { meta: { path: 'kind', eq: 'note' } } });
```

For nullable paths you usually also want a partial-filter so the
index doesn't bloat with NULL entries:

```ts
indexes: [
  { keys: {},
    expression: "json_extract(meta, '$.kind')",
    where: "json_extract(meta, '$.kind') IS NOT NULL" },
],
```

### DuckDB — expression indexes (analytics workloads)

DuckDB supports expression indexes the same way SQLite does. In
analytics-shaped workloads (the common DuckDB use case) the planner is
often happy to scan because it's columnar; expression indexes pay off
mainly when you're using DuckDB as an OLTP-ish staging store.

### MSSQL — computed column + B-tree

MSSQL indexes JSON paths via a `PERSISTED` computed column (forge does
not emit the column itself — declare it through a migration):

```sql
ALTER TABLE [doc] ADD [meta_role] AS JSON_VALUE([meta], '$.profile.role') PERSISTED;
CREATE INDEX [doc_meta_role] ON [doc] ([meta_role]);
```

Then the forge path filter (`JSON_VALUE([meta], '$.profile.role') = @p1`)
matches the computed column expression and the planner picks the
index.

### Mongo — wildcard, multikey, sparse

```ts
indexes: [
  // 1. Wildcard — indexes every key under `meta`. Good for ad-hoc
  //    queries; large index. Pair with `wildcardProjection` to scope.
  { keys: { 'meta.$**': 1 } as any },

  // 2. Targeted multikey — one key, one index. Same shape as a regular
  //    Mongo index; Mongo treats it as multikey automatically when the
  //    field is an array.
  { keys: { 'meta.tags': 1 } },

  // 3. Sparse on a nullable path — index entry only when the field is
  //    present. Pair with partialFilterExpression for exact semantics.
  { keys: { 'meta.profile.role': 1 },
    partialFilterExpression: { 'meta.profile.role': { $exists: true } } },
],
```

Wildcard indexes do not support sort by the indexed field on multi-
key paths — read the [Mongo docs](https://www.mongodb.com/docs/manual/core/index-wildcard/)
for the full rule set. For most production "filter by a known set of
hot paths" workloads, three or four targeted indexes beat one wildcard.

---

## Schema patterns: JSON vs columns

The rule of thumb forge users land on:

| Use JSON when                                          | Use a column when                                     |
|--------------------------------------------------------|-------------------------------------------------------|
| Heterogeneous metadata (per-tenant settings, plugins)  | The field drives filters, sorts, or joins             |
| Third-party payload you must store verbatim            | Analytics needs aggregation across millions of rows   |
| Audit log `before` / `after` snapshots                 | The field is part of a unique constraint              |
| Webhook payloads pending replay                        | The field has a fixed shape and well-known semantics  |
| Optional fields with low fill-rate                     | The field needs a non-null check or FK                |

### Migrating column → JSON (consolidation)

Common when a model accumulated a dozen optional `string?` columns for
"user preferences" and the pattern is clear in retrospect.

```ts
// before
const User = model('users', {
  id:           f.id(),
  notify_email: f.bool().optional(),
  notify_push:  f.bool().optional(),
  theme:        f.string().optional(),
});

// after
const User = model('users', {
  id:    f.id(),
  prefs: f.embed(() => embed('UserPrefs', {
    notify_email: f.bool().optional(),
    notify_push:  f.bool().optional(),
    theme:        f.string().optional(),
  })),
});
```

Migration steps (apply via a migration runner or `db.$queryRaw`):

1. `ALTER TABLE users ADD COLUMN prefs jsonb` (PG) — `forge push`
   handles this if you bump the schema and run it.
2. Backfill: `UPDATE users SET prefs = jsonb_build_object('notify_email', notify_email, …)`.
3. Drop the old columns once readers are migrated.

Forge's `db.$diff()` reports the new `prefs` column and the dropped
columns at every push so you can stage the backfill.

### Migrating JSON → column (extracting hot fields)

When a path becomes the dominant filter axis, lift it.

```ts
// before — every page hit ran a path filter on meta.kind
const Doc = model('docs', { id: f.id(), meta: f.json() });

// after
const Doc = model('docs', {
  id:   f.id(),
  kind: f.string().optional(),    // lifted out of meta
  meta: f.json(),
});
```

In PG you can do the lift as a generated column with no app-side change:

```sql
ALTER TABLE doc ADD COLUMN kind text GENERATED ALWAYS AS (meta->>'kind') STORED;
CREATE INDEX doc_kind ON doc (kind);
```

Reads using `where: { kind: 'note' }` hit the B-tree directly. Writes
continue going through `meta` only.

---

## Embedded objects + JSON paths together

`f.embed(Shape)` is forge's typed JSON: a fixed object shape stored as
JSON on SQL adapters (jsonb on PG, JSON on MySQL/SQLite/DuckDB,
nvarchar(max) on MSSQL) and as a sub-document on Mongo. `f.json()` is
free-form `unknown`-typed JSON for everything you don't want a schema
for.

The two compose nicely:

```ts
import { embed, f, model } from 'forge-orm';

const Address = () => embed('Address', {
  street: f.string(),
  city:   f.string(),
  geo:    f.embed(() => embed('Coords', {
    lat: f.float(),
    lng: f.float(),
  })).optional(),
});

const User = model('users', {
  id:      f.id(),
  address: f.embed(Address).optional(),   // structural
  extras:  f.json(),                       // free-form, per-tenant plugin payload
});
```

Path queries work the same on both. The TypeScript shape carries
through `address.city` but is `unknown` under `extras`:

```ts
await db.user.findMany({ where: { address: { path: 'city',       eq: 'SF' } } });
await db.user.findMany({ where: { address: { path: 'geo.lat',    gte: 40 } } });
await db.user.findMany({ where: { extras:  { path: 'plugin.kind', eq: 'slack' } } });
```

When both appear in one model, the rule that works:

- Use `embed` / `embedMany` for any field you query, validate, or
  display in a form.
- Use `json` for opaque payloads (webhook bodies, vendor data, AI
  responses) that you'll only ever read for replay / debugging.

The IR is identical for both — `f.embed()` doesn't add a sub-query
hop; it just constrains the TypeScript shape and runs the same
`jsonPathExpr` emit per dialect.

---

## Path expressions reference

Every operator forge's `path:` shape supports, the matching scalar
operator, and the SQL or Mongo each one emits. Operand types drive PG
casting (see the per-dialect section above).

| Operator | Example                                                          | Postgres                                              | MySQL                                                                       | SQLite / DuckDB                                | MSSQL                                                | Mongo                                          |
|----------|------------------------------------------------------------------|-------------------------------------------------------|-----------------------------------------------------------------------------|------------------------------------------------|------------------------------------------------------|------------------------------------------------|
| `eq`     | `{ path: 'role', eq: 'admin' }`                                   | `meta->>'role' = $1`                                  | ``JSON_UNQUOTE(JSON_EXTRACT(`meta`,'$.role'))`` `= ?`                       | `json_extract(meta, '$.role') = ?`             | `JSON_VALUE([meta], '$.role') = @p1`                 | `{ 'meta.role': 'admin' }`                     |
| `ne`     | `{ path: 'role', ne: 'admin' }`                                   | `meta->>'role' <> $1`                                 | ``JSON_UNQUOTE(...)`` `<> ?`                                                | `json_extract(...) <> ?`                       | `JSON_VALUE(...) <> @p1`                             | `{ 'meta.role': { $ne: 'admin' } }`            |
| `lt`     | `{ path: 'age', lt: 18 }`                                         | `(meta->>'age')::numeric < $1`                        | ``JSON_UNQUOTE(...)`` `< ?`                                                 | `json_extract(...) < ?`                        | `JSON_VALUE(...) < @p1`                              | `{ 'meta.age': { $lt: 18 } }`                  |
| `lte`    | `{ path: 'age', lte: 18 }`                                        | `(meta->>'age')::numeric <= $1`                       | ``JSON_UNQUOTE(...)`` `<= ?`                                                | `json_extract(...) <= ?`                       | `JSON_VALUE(...) <= @p1`                             | `{ 'meta.age': { $lte: 18 } }`                 |
| `gt`     | `{ path: 'age', gt: 18 }`                                         | `(meta->>'age')::numeric > $1`                        | ``JSON_UNQUOTE(...)`` `> ?`                                                 | `json_extract(...) > ?`                        | `JSON_VALUE(...) > @p1`                              | `{ 'meta.age': { $gt: 18 } }`                  |
| `gte`    | `{ path: 'age', gte: 18 }`                                        | `(meta->>'age')::numeric >= $1`                       | ``JSON_UNQUOTE(...)`` `>= ?`                                                | `json_extract(...) >= ?`                       | `JSON_VALUE(...) >= @p1`                             | `{ 'meta.age': { $gte: 18 } }`                 |
| `contains` | `{ path: 'bio', contains: 'eng' }`                              | `meta->>'bio' LIKE $1`  (`'%eng%'` escaped)            | ``JSON_UNQUOTE(...)`` `LIKE ?`                                              | `json_extract(...) LIKE ?`                     | `JSON_VALUE(...) LIKE @p1`                           | `{ 'meta.bio': { $regex: 'eng' } }`            |
| `in`     | `{ path: 'role', in: ['a','b'] }`                                | `meta->>'role' IN ($1, $2)`                            | ``JSON_UNQUOTE(...)`` `IN (?, ?)`                                           | `json_extract(...) IN (?, ?)`                  | `JSON_VALUE(...) IN (@p1, @p2)`                      | `{ 'meta.role': { $in: ['a','b'] } }`          |
| `has`    | `{ path: 'tags', has: 'urgent' }`                                | `(meta->'tags')::text LIKE $1`                        | text-form `LIKE` over the unquoted extract                                  | text-form `LIKE` over `json_extract`           | text-form `LIKE`                                     | `{ 'meta.tags': 'urgent' }`                    |

A handful of pseudo-operators round it out via the regular scalar
where vocabulary on a path-extracted column:

| Pseudo-op   | How to express it                                                                 | Notes                                          |
|-------------|-----------------------------------------------------------------------------------|------------------------------------------------|
| `exists`    | `{ path: 'role', ne: null }`                                                       | works on every dialect; Mongo also accepts `$exists` via `db.$queryRaw` |
| `isNull`    | `{ path: 'role', eq: null }`                                                       | SQL emits `IS NULL`; Mongo emits `{ field: null }` (matches both JSON null and absent) |
| `startsWith`| `{ path: 'sku', contains: 'PRE-' }` plus app-side filter, or `db.$queryRaw`        | forge's `contains` is `%v%`, not `v%`           |
| `endsWith`  | same — drop to `db.$queryRaw` for `LIKE 'v%'` / `'%v'` shapes                      |                                                |
| `arrayContains` | `{ path: 'tags', has: 'x' }`                                                   | text-form for SQL; native for Mongo            |
| `arraySize` | `db.$queryRaw` — `jsonb_array_length(meta->'tags')` / `JSON_LENGTH` / `$size`      | not in the typed surface; portable raw form    |
| `regex`     | not in the typed surface — `db.$queryRaw` with `~` (PG) / `REGEXP` / `$regex`      |                                                |

The README's [Operator reference](../README.md#operator-reference) is
the canonical list for scalar where ops; the path form reuses them
once the value is extracted.

---

## Type coercion gotchas — JSON null vs DB null vs absent

There are three distinct "null" states for a JSON column:

| State                                | PG                                          | MySQL                                | SQLite             | Mongo                          |
|--------------------------------------|---------------------------------------------|--------------------------------------|--------------------|--------------------------------|
| Column is SQL `NULL`                 | `meta IS NULL`                              | `meta IS NULL`                       | `meta IS NULL`     | `meta === null` / absent       |
| Column is JSON `null` (the literal)  | `meta = 'null'::jsonb`                      | `JSON_TYPE(meta) = 'NULL'`           | `json_type(meta) = 'null'` | `meta === null` (same as SQL null on Mongo) |
| Path inside JSON is absent           | `meta->>'k' IS NULL`                        | `JSON_EXTRACT(meta, '$.k') IS NULL`  | `json_extract(meta, '$.k') IS NULL` | `'meta.k' field not present`   |

Forge ships three markers — see
[`src/null-markers.ts`](../src/null-markers.ts) — that let you write
the column-level distinction without dropping to raw SQL:

```ts
import { ForgeDbNull, ForgeJsonNull, ForgeAnyNull } from 'forge-orm';

// Set the column itself to SQL NULL.
await db.user.update({
  where: { id }, data: { settings: ForgeDbNull },
});
// → UPDATE … SET "settings" = NULL

// Set the column to the JSON `null` literal — still a non-null column,
// holding the value `null`.
await db.user.update({
  where: { id }, data: { settings: ForgeJsonNull },
});
// → PG: UPDATE … SET "settings" = 'null'::jsonb
// → MySQL: UPDATE … SET `settings` = CAST('null' AS JSON)
// → SQLite: UPDATE … SET "settings" = json('null')

// Match either form in a where filter.
await db.user.findMany({ where: { settings: ForgeAnyNull } });
```

On Mongo, `DbNull` and `JsonNull` collapse to `null` (the protocol
doesn't distinguish), but the markers still serialise correctly so
the call site stays portable.

Path filters take the three states into account naturally:

```ts
// Absent path OR JSON-null value at the path — both match here.
await db.user.findMany({ where: { meta: { path: 'role', eq: null } } });
// PG → WHERE "meta"->>'role' IS NULL
//      (PG's ->> returns NULL for both absent keys and JSON null leaves)

// Present-and-non-null at the path.
await db.user.findMany({ where: { meta: { path: 'role', ne: null } } });
```

The subtle case is "present but JSON-null vs absent" — PG's `->>`
text extraction returns SQL `NULL` for both, so a path filter cannot
distinguish them. If you need the distinction, drop to `db.$queryRaw`:

```ts
await db.$queryRaw`
  SELECT id FROM "user"
   WHERE jsonb_typeof("meta"->'role') = 'null'   -- the literal null, not absent
`;
```

---

## Nested aggregation

Path operators target `where`; for `groupBy` and aggregates the
typical pattern is "lift the path into a synthetic column with
`db.$queryRaw`" or, where forge supports it, pass through `select`
with a computed expression.

### Postgres — count by JSON role

```ts
const counts = await db.$queryRaw<{ role: string; n: number }[]>`
  SELECT "meta"->>'role' AS role, COUNT(*) AS n
    FROM "user"
   WHERE "meta"->>'role' IS NOT NULL
   GROUP BY 1
   ORDER BY 2 DESC
`;
```

For a JSON array (`meta.tags`) cross-joined to one row per tag:

```ts
const tagCounts = await db.$queryRaw`
  SELECT t.tag, COUNT(*) AS n
    FROM "user", LATERAL jsonb_array_elements_text("meta"->'tags') AS t(tag)
   GROUP BY 1
`;
```

### SQLite — `json_each`

```ts
const tagCounts = await db.$queryRaw`
  SELECT t.value AS tag, COUNT(*) AS n
    FROM "user", json_each("user"."meta", '$.tags') AS t
   GROUP BY 1
`;
```

### MySQL — `JSON_TABLE`

```ts
const tagCounts = await db.$queryRaw`
  SELECT jt.tag, COUNT(*) AS n
    FROM \`user\`,
         JSON_TABLE(\`user\`.\`meta\`, '$.tags[*]'
           COLUMNS (tag VARCHAR(64) PATH '$')) AS jt
   GROUP BY 1
`;
```

### Mongo — `$unwind` + `$group`

```ts
const tagCounts = await db.user.collection.aggregate([
  { $unwind: '$meta.tags' },
  { $group: { _id: '$meta.tags', n: { $sum: 1 } } },
  { $sort: { n: -1 } },
]).toArray();
```

Forge does not wrap `$unwind` directly — `db.<model>.collection`
exposes the raw Mongo collection for cases where the typed API stops
helping.

---

## Audit log pattern

A common shape: one row per change, with `before` and `after` JSON
snapshots and a per-table partial index so old rows can age out.

```ts
const AuditLog = model('audit_log', {
  id:         f.id(),
  table_name: f.string(),
  row_id:     f.string(),
  action:     f.enumOf(['create', 'update', 'delete'] as const),
  before:     f.json().optional(),    // null on create
  after:      f.json().optional(),    // null on delete
  actor_id:   f.objectId().optional(),
  at:         f.dateTime().createdAt(),
}, {
  indexes: [
    { keys: { table_name: 1, row_id: 1, at: -1 } },
    { keys: { at: 1 },
      where: "at > NOW() - INTERVAL '90 days'",
      partialFilterExpression: { at: { $gt: ninetyDaysAgo() } } },
  ],
});
```

Reading a diff between `before` and `after` on PG:

```ts
const diffs = await db.$queryRaw<{ key: string; before: unknown; after: unknown }[]>`
  SELECT k AS key,
         "before"->k AS before,
         "after"->k  AS after
    FROM "audit_log",
         jsonb_object_keys(coalesce("before",'{}') || coalesce("after",'{}')) k
   WHERE id = ${auditId}
     AND "before"->k IS DISTINCT FROM "after"->k
`;
```

`IS DISTINCT FROM` treats NULL as a value, so a key that exists on
one side and not the other shows up as a diff.

Retention: the partial-filter index above keeps the index small
(only the last 90 days) while leaving the rows in the table for
forensics. For cold archival, materialise older rows into a
DuckDB-backed Parquet file (see
[External tool interop](#external-tool-interop)) and `DELETE` from
the source table on a cron.

---

## Webhooks and event sourcing

Webhooks fit `f.json()` cleanly — you store the payload verbatim
because you need to replay it bit-exact later, and the schema is
defined by an external party who reserves the right to change it.

```ts
const WebhookEvent = model('webhook_events', {
  id:           f.id(),
  source:       f.string(),                 // 'stripe', 'github', …
  event_type:   f.string(),                 // 'invoice.paid'
  delivery_id:  f.string().unique(),        // dedupe
  payload:      f.json(),
  received_at:  f.dateTime().createdAt(),
  processed_at: f.dateTime().optional(),
  attempts:     f.int().default(0),
}, {
  indexes: [
    { keys: { source: 1, event_type: 1, received_at: -1 } },
    { keys: { processed_at: 1 },
      where: 'processed_at IS NULL',
      partialFilterExpression: { processed_at: { $exists: false } } },
  ],
});
```

Replay query — every Stripe webhook for a given subscription, ordered
deterministically:

```ts
await db.webhookEvent.findMany({
  where: {
    source: 'stripe',
    payload: { path: 'data.object.subscription', eq: subId },
  },
  orderBy: [{ received_at: 'asc' }, { id: 'asc' }],  // tie-break on id
});
```

The `(received_at, id)` tie-break is important: if the upstream
delivers two events with the same timestamp (it happens — Stripe
batches at second granularity), a sort on `received_at` alone yields
an unstable order across pages. Forge's [pagination
helper](../README.md#sorting-and-pagination) builds the tie-break
into the cursor automatically.

For typed events (you control the schema, not a vendor), use
`f.embed()` so the TS shape carries through:

```ts
const OrderPaid = () => embed('OrderPaid', {
  order_id: f.string(),
  amount:   f.int(),
  currency: f.string(),
});

const Event = model('events', {
  id:        f.id(),
  type:      f.string(),
  order_paid: f.embed(OrderPaid).optional(),
  // … one optional embed per event type, exhaustive via the discriminator
});
```

`db.event.findMany({ where: { type: 'order.paid', order_paid: { path: 'amount', gte: 100_00 } } })`
gets you typed access on the way in and full path filtering on the
way out.

---

## External tool interop

JSON columns travel between systems regularly. The patterns that work
without losing fidelity:

### Postgres → Parquet via DuckDB

DuckDB reads a Postgres connection directly and writes JSON columns
to Parquet as a `STRUCT` (if the shape is uniform) or a raw `JSON`
column.

```sql
INSTALL postgres; LOAD postgres;
ATTACH 'host=… dbname=… user=…' AS pg (TYPE POSTGRES);

COPY (SELECT id, meta FROM pg."public"."doc")
  TO 'docs.parquet' (FORMAT PARQUET);
```

In a forge call site, the same export from DuckDB-adapter mode:

```ts
await db.$queryRaw`
  COPY (SELECT id, meta FROM "doc")
    TO 'docs.parquet' (FORMAT PARQUET)
`;
```

### `COPY` round-trip between Postgres instances

```sh
psql src -c "\copy (SELECT id, meta FROM doc) TO 'docs.tsv'"
psql dst -c "\copy doc (id, meta) FROM 'docs.tsv'"
```

`meta` rides through as text-encoded JSON; PG re-parses on insert. No
loss for `jsonb` round-trips. The text representation may differ
(`jsonb` re-canonicalises keys), so don't checksum the raw bytes.

### Mongo BSON edge cases

Mongo's BSON has richer types than JSON: `Date`, `ObjectId`, `Decimal128`,
`Binary`, `Long`. Forge coerces them on read:

| BSON type      | Forge read shape                                | Notes                                                   |
|----------------|--------------------------------------------------|---------------------------------------------------------|
| `Date`         | JS `Date`                                        | Round-trips losslessly.                                 |
| `ObjectId`     | hex string (24 chars)                            | Use `f.objectId()` to declare; forge converts on write. |
| `Decimal128`   | string                                           | Avoids JS number precision loss; cast at the call site. |
| `Long`         | `bigint`                                         | If `f.bigint()` declared; otherwise number with potential precision loss. |
| `Binary`       | `Buffer` (Node) / `Uint8Array` (browser)         |                                                         |

For ad-hoc reads through `f.json()`, the same coercions run on the
extracted value — so a `Date` inside a JSON document becomes a JS
`Date`, not an ISO string. Cross-dialect portability means you
should explicitly stringify dates if you replay the JSON elsewhere.

---

## Common bugs and their fixes

A grab-bag of foot-guns. Each is a symptom you'll see in the wild,
followed by the actual fix.

### PG: silent text vs jsonb coercion

Symptom: `forge push` against an existing PG schema reports the
`meta` column as drift, "expected `jsonb`, found `json`". Path
filters work but the GIN index won't apply.

Fix: PG's `json` type stores the raw text (no parsing, no
deduplication). `jsonb` is what every modern guide assumes.

```sql
ALTER TABLE doc ALTER COLUMN meta TYPE jsonb USING meta::jsonb;
```

Then re-run `forge push` and the drift clears. `forge doctor` will
also flag `json` columns specifically since 2.3.

### MySQL: `JSON_EXTRACT` returns quoted strings

Symptom: `where: { meta: { path: 'role', eq: 'admin' } }` matches
nothing — but you can confirm in `mysql>` that the row is there.

Cause: bare `JSON_EXTRACT` returns `"admin"` (with the quotes).
Forge wraps every emit in `JSON_UNQUOTE`, so this only bites if you
hand-rolled the SQL through `db.$queryRaw`.

Fix: use `JSON_UNQUOTE(JSON_EXTRACT(...))` or the `->>` shortcut
(`meta->>'$.role'`) in your raw SQL.

### MariaDB: longtext vs JSON type drift

Symptom: `forge diff` reports `meta` as drift on MariaDB even when
the schema hasn't changed. MariaDB calls its column type `JSON` but
stores it as `LONGTEXT` with a CHECK constraint. The introspect path
sees `LONGTEXT`.

Fix: forge handles this as a known-equivalent type pair from 2.3+ —
upgrade the runtime if you're seeing the false positive. If you must
stay on an older runtime, add a pattern to `forge diff --ignore`:

```sh
forge diff --ignore 'doc.meta.type'
```

### Mongo: `$exists: true` matches null

Symptom: a query `{ 'meta.role': { $exists: true } }` returns
documents where `meta.role` is the explicit JSON null.

Cause: Mongo's `$exists: true` means "the field exists in the
document" — and `null` is a value, so it counts. Use `$ne: null` to
mean "present and non-null":

```ts
await db.user.findMany({ where: { meta: { path: 'role', ne: null } } });
// → { 'meta.role': { $ne: null } }   -- matches present-and-non-null
```

### SQLite: missing JSON1 on ancient builds

Symptom: `no such function: json_extract` on a pre-3.38 SQLite.

Fix: rebuild SQLite with `-DSQLITE_ENABLE_JSON1`, or upgrade.
`better-sqlite3` and `libsql` ship with JSON1 enabled; only ancient
system-package sqlites are affected. `forge doctor` reports JSON1
status at connect.

### MSSQL: `JSON_VALUE` returns NULL for objects

Symptom: `where: { meta: { path: 'profile', ne: null } }` returns
nothing — even when `meta.profile` is `{ "role": "admin" }`.

Cause: `JSON_VALUE` returns NULL when the target at the path is a
JSON object or array — it's scalar-only by design.

Fix: use `JSON_QUERY` (returns JSON sub-documents) through
`db.$queryRaw` if you need to test for object presence, or
restructure your filter to target a scalar leaf like
`meta.profile.role`.

### PG: expression index not picked by the planner

Symptom: you declared an expression index on
`((meta->>'role'))` but `EXPLAIN ANALYZE` shows a seq scan.

Cause: the index expression must be byte-identical to the where
expression. Forge emits `("doc"."meta"->>'role')` (table-qualified)
or `(meta->>'role')` depending on the join shape, and a numeric cast
changes the expression. Common mismatches:

- Index `((meta->>'count'))` vs query `(meta->>'count')::numeric` —
  add the cast to the index or change the operand to a string.
- Index `((data->>'k'))` on a CTE that aliases the table — the
  planner often refuses to match through the alias.

Fix: run `EXPLAIN ANALYZE` on the actual forge-emitted SQL (use
`db.<model>.findMany.compile(...)` to print it), then build the
index to match exactly.

### Path navigation through an array without an index

Symptom: `{ path: 'addresses.city', eq: 'SF' }` returns nothing even
though some rows have an address with `city = 'SF'`.

Cause: `addresses` is an array. SQL JSON path navigation through an
array without an index targets the array itself, not its elements.
The right shape is either a specific index (`addresses[0].city`) or a
group-aggregate / `JSON_TABLE` / `jsonb_array_elements` query.

Fix for "any element matches":

```ts
// Postgres
await db.$queryRaw`
  SELECT id FROM "user"
   WHERE EXISTS (
     SELECT 1 FROM jsonb_array_elements("meta"->'addresses') AS a
      WHERE a->>'city' = 'SF'
   )
`;
// Mongo — works natively via dotted path
await db.user.findMany({ where: { meta: { path: 'addresses.city', eq: 'SF' } } });
```

Mongo applies the dotted path through array elements automatically;
SQL dialects need the explicit unwind. The Mongo path is a documented
exception — see the [Mongo manual on dot
notation](https://www.mongodb.com/docs/manual/core/document/#std-label-document-dot-notation)
for the matching rules.
