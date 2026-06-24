# Queries deep-dive — operators, pagination, aggregation, streams

The README chapter [Reading data](../README.md#reading-data) covers the
surface — `findMany`, `findFirst`, `findUnique`, the operator table,
`select` vs `include`, sort, and pagination. This doc is the companion
that goes one layer down: every operator's per-dialect emit, every
pagination strategy with its failure mode, the `select` / `include`
inference rules, the stream entry points each driver actually uses, and
the bugs that show up in production when those rules are violated.

If you have not read the README chapter yet, start there — this doc
assumes you know the call shape.

## Contents

* [findMany, findFirst, findUnique — and the `OrThrow` variants](#findmany-findfirst-findunique--and-the-orthrow-variants)
* [`where` operator reference, per dialect](#where-operator-reference-per-dialect)
* [Logical operators — AND, OR, NOT, implicit AND](#logical-operators--and-or-not-implicit-and)
* [`col()` — field-to-field comparison](#col--field-to-field-comparison)
* [Filtering by relation — `is`, `isNot`, `some`, `every`, `none`](#filtering-by-relation--is-isnot-some-every-none)
* [`select` and `include` — projection rules and inference](#select-and-include--projection-rules-and-inference)
* [`orderBy` — single, multi, relation, `_count`, nulls](#orderby--single-multi-relation-_count-nulls)
* [Pagination — offset vs cursor](#pagination--offset-vs-cursor)
* [`distinct`](#distinct)
* [`count` and `_count`](#count-and-_count)
* [Aggregates — `_avg`, `_sum`, `_min`, `_max`](#aggregates--_avg-_sum-_min-_max)
* [`groupBy` and `having`](#groupby-and-having)
* [`findManyStream` — cursor-backed streaming](#findmanystream--cursor-backed-streaming)
* [Common bugs](#common-bugs)
* [Eight worked queries](#eight-worked-queries)

---

## findMany, findFirst, findUnique — and the `OrThrow` variants

Five read entry points, picked by what the caller already knows about
the row.

| Method | Returns | Throws on miss | Where shape |
|---|---|---|---|
| `findMany` | `T[]` | no | any filter |
| `findFirst` | `T \| null` | no | any filter |
| `findFirstOrThrow` | `T` | yes — `RecordNotFound` | any filter |
| `findUnique` | `T \| null` | no | **only** unique-by selectors |
| `findUniqueOrThrow` | `T` | yes — `RecordNotFound` | **only** unique-by selectors |

The unique-by-selector rule for `findUnique` is enforced at the wrapper
level. The `where` must address the row through a single unique column
(`id`, anything declared with `.unique()`) or a declared compound unique
(`{ user_id_video_id: { user_id, video_id } }`). Passing a non-unique
filter — `findUnique({ where: { email_domain: 'x.co' } })` against a
non-unique `email_domain` — throws a build-time error before the query
runs. The compiler relies on this to skip the `LIMIT 1` and the
deterministic-order tie-breaker.

`findFirst` does not impose that rule. It will happily run
`findFirst({ where: { active: true } })` and return whichever row the
underlying engine surfaces first. That row is **not** deterministic
unless you also pass `orderBy`. On PG it usually tracks heap order; on
SQLite it tracks rowid; on Mongo it tracks the natural insertion order
of the segment, which is undefined under concurrent writes. Always pair
`findFirst` with `orderBy` if the caller will see the result.

When to reach for each:

- **Already have the unique key** (id from a URL, email from a login
  form) → `findUnique`. The compiler trusts the uniqueness, the result
  type is `T | null`, and the SQL skips ordering.
- **Need exactly one row but don't have a unique key** (first matching
  draft, most recent log line) → `findFirst({ where, orderBy })`.
- **Caller treats "missing" as a programmer error** (load a row I just
  created, hydrate a foreign-key target) → `findUniqueOrThrow` or
  `findFirstOrThrow`. The thrown `RecordNotFound` carries the model
  name and where key, which is the only safe way to bubble a 404 in
  request-scoped code.
- **Anything that yields more than one** → `findMany`.

```ts
// Already-unique — the type is User | null with no LIMIT in the SQL
const u = await db.user.findUnique({ where: { id: 'u_42' } });

// Deterministic first match — orderBy is required to be stable
const draft = await db.post.findFirst({
  where:   { author_id: meId, status: 'DRAFT' },
  orderBy: { updated_at: 'desc' },
});

// "Missing means bug" path — bubbles a RecordNotFound the caller maps to 404
const u = await db.user.findUniqueOrThrow({ where: { id: req.params.id } });
```

`findFirstOrThrow` and `findUniqueOrThrow` throw the same
`RecordNotFound` shape that `update` and `delete` throw for missing
targets. Catch it once in your error middleware and you cover every
read+write miss in one place.

---

## `where` operator reference, per dialect

`where` is built into a dialect-agnostic `WhereTree` IR
(`src/ir/build/where.ts`), then each adapter's `compile-from-ir.ts`
turns the leaves into native SQL fragments or BSON. Every operator
below is listed by its IR name and the emit it produces on each
dialect.

Identifier quoting in the SQL examples follows the dialect: PG and
SQLite use `"col"`, MySQL/MariaDB use `` `col` ``, MSSQL uses `[col]`.
Placeholders are `$1, $2, …` on PG/MSSQL, `?` on MySQL/SQLite. LIKE
metacharacters in the value are escaped at compile time before being
wrapped in `%`.

### `equals`

The user shape `{ status: 'PUBLISHED' }` and `{ status: { equals: 'PUBLISHED' } }`
compile identically.

| Dialect | Emit |
|---|---|
| Postgres | `"t"."status" = $1` |
| MySQL | `` `t`.`status` = ? `` |
| SQLite | `"t"."status" = ?` |
| Mongo | `{ status: 'PUBLISHED' }` |

A `null` value triggers the null-aware path: `IS NULL` on SQL, native
`null` on Mongo.

### `not`

| Dialect | Emit |
|---|---|
| Postgres | `"t"."status" <> $1` (or `IS NOT NULL` if the value is null) |
| MySQL | `` `t`.`status` <> ? `` |
| SQLite | `"t"."status" <> ?` |
| Mongo | `{ status: { $ne: 'DRAFT' } }` |

`not` also accepts a nested filter object: `{ status: { not: { in: ['DRAFT', 'ARCHIVED'] } } }`.
That compiles by inverting the inner sub-tree (`NOT (status IN (…))` /
`{ status: { $not: { $in: [...] } } }`).

### `lt`, `lte`, `gt`, `gte`

Range operators apply to numbers, dates, and strings (lexical compare).

| Dialect | Emit (gte example) |
|---|---|
| Postgres | `"views" >= $1` |
| MySQL | `` `views` >= ? `` |
| SQLite | `"views" >= ?` |
| Mongo | `{ views: { $gte: 100 } }` |

Forge does not synthesise `BETWEEN` from a `{ gte, lte }` pair — the
emit stays as two predicates joined by an implicit `AND`. The
optimiser flattens that on every supported engine, so the planner
behaviour is identical.

### `in`, `notIn`

| Dialect | Emit |
|---|---|
| Postgres | `"id" IN ($1, $2, $3)` |
| MySQL | `` `id` IN (?, ?, ?) `` |
| SQLite | `"id" IN (?, ?, ?)` |
| Mongo | `{ id: { $in: ['u1','u2','u3'] } }` |

**Empty list shortcut.** `in: []` compiles to literal `FALSE` (no
placeholder, no driver round-trip) and `notIn: []` compiles to literal
`TRUE`. This matters because some drivers reject the empty-tuple form
`IN ()` outright, and the shortcut keeps `findMany({ where: { id: { in: ids } } })`
safe even when `ids` is empty after a filter step.

### `contains`, `startsWith`, `endsWith`

Substring, prefix, and suffix matches on `f.string()` / `f.text()`
columns.

| Dialect | Emit (contains) |
|---|---|
| Postgres | `"name" LIKE '%' \|\| $1 \|\| '%'` |
| MySQL | `` `name` LIKE CONCAT('%', ?, '%') `` |
| SQLite | `"name" LIKE '%' \|\| ? \|\| '%'` |
| Mongo | `{ name: { $regex: '<escaped>', $options: undefined } }` |

`startsWith` and `endsWith` adjust the wrapping (`x%` and `%x`). The
escaping of `%`, `_`, and `\` in the value happens at compile time, so
a user input of `50%_off` matches literal `50%_off` rather than
"50 anything off".

### `mode: 'insensitive'`

Set on a text operator: `{ name: { contains: 'ali', mode: 'insensitive' } }`.

| Dialect | Behaviour |
|---|---|
| Postgres | Real — emits `ILIKE`. |
| MySQL | The default collation on most installations is `utf8mb4_0900_ai_ci`, which is already case-insensitive — the flag has no effect because the comparison is already insensitive. On a `_bin` or `_cs` collation the flag is **not** translated; reach for `LOWER()` via `$queryRaw`. |
| SQLite | Not honoured. `LIKE` is case-insensitive for ASCII by default in SQLite and case-sensitive otherwise; the flag does not switch to `COLLATE NOCASE`. |
| Mongo | Adds `$options: 'i'` on the regex. |

If you need portable case-insensitive text matching across all six
dialects, store a normalised lower-case column alongside the original
and filter on that. The browser adapter is the most likely place to
hit this — `name LIKE '%élise%'` on SQLite without ICU will not match
`Élise`.

### `between`

Forge does not expose a dedicated `between` operator. Use
`{ field: { gte: lo, lte: hi } }` for an inclusive range or `{ gt, lt }`
for an exclusive range. The intent is explicit at the call site rather
than hidden in the operator name; the optimiser sees the same plan.

### `regex`

Forge does not expose `regex` as a standalone operator. The closest
portable surface is `contains` / `startsWith` / `endsWith`. For full
regex, drop to `$queryRaw` on SQL or `$runMongo` on Mongo — pattern
dialects (POSIX vs PCRE vs JavaScript regex) diverge enough that a
single portable surface would mislead.

### `has`, `hasSome`, `hasEvery`, `isEmpty`

Set-style operators on `f.stringArray()`, `f.intArray()`, and
`f.embedMany()`.

| Operator | PG emit | Mongo |
|---|---|---|
| `has: 'urgent'` | `$1 = ANY("tags")` | `{ tags: 'urgent' }` |
| `hasSome: ['a','b']` | `"tags" && ARRAY[$1,$2]` | `{ tags: { $in: ['a','b'] } }` |
| `hasEvery: ['a','b']` | `"tags" @> ARRAY[$1,$2]` | `{ tags: { $all: ['a','b'] } }` |
| `isEmpty: true` | `coalesce(array_length("tags",1),0) = 0` | `{ tags: { $size: 0 } }` |

`has` / `hasSome` / `hasEvery` are PostgreSQL-native array operators.
On MySQL/SQLite/DuckDB/MSSQL the array column is backed by JSON, and
the same SQL is emitted today — that is a known gap. Until it lands,
filter array fields on those dialects with `where: { tags: { path: '$[*]', has: 'urgent' } }`,
which routes through the JSON-path compiler.

### `search`

Full-text. See [Full-text search](../README.md#full-text-search) for
how to declare it (`f.text().searchable()`).

| Dialect | Emit |
|---|---|
| Postgres | `to_tsvector('simple', "body") @@ plainto_tsquery('simple', $1)` |
| MySQL | ``MATCH(`body`) AGAINST (? IN NATURAL LANGUAGE MODE)`` |
| SQLite | `"posts".rowid IN (SELECT rowid FROM "posts_fts" WHERE "posts_fts" MATCH ?)` |
| Mongo | Top-level `$text: { $search: '<query>' }` |

The SQLite form uses a shadow `posts_fts` FTS5 virtual table — forge
creates it and the keep-in-sync triggers as part of `forge push`.
Mongo's `$text` is a collection-level operator, not a per-field one;
two `search` filters on the same collection in a single query is an
error on Mongo (it is fine on every SQL dialect).

### `path` (JSON path)

`{ meta: { path: 'profile.age', gte: 18 } }`. See
[JSON path queries](./JSON-PATH.md) for the full table — every
sub-operator (`eq`, `ne`, `lt`/`lte`/`gt`/`gte`, `contains`, `in`,
`has`) maps to the dialect's native JSON read plus the same scalar
comparison the column path uses.

### `near` (geo) and `near` (vector)

`near` switches behaviour based on the field's declared kind. On a
`f.geoPoint()` field the value is `{ lng, lat, withinMeters? }`; on a
`f.vector(N)` field the value is `{ vector: number[], withinDistance? }`.
See [Geo](./GEO.md) and [Vector](./VECTOR.md) for the per-dialect
emit (PostGIS `ST_DWithin`, MySQL `ST_Distance_Sphere`, SpatiaLite
`Distance`, pgvector `<=>`, sqlite-vec, Mongo `$near` / `$vectorSearch`).

### `nearTo` (orderBy only)

`nearTo` is an `orderBy` operator, not a `where` operator. See
[`orderBy`](#orderby--single-multi-relation-_count-nulls).

### `withinPolygon`

Geo-only. Accepts a ring, a `Polygon`, a `MultiPolygon`, or a
`GeometryCollection`; the IR normalises everything to `MultiPolygon`
and the per-dialect compiler picks `ST_Within` / `Within` / fallback
ray-cast accordingly. Holes are excluded via the even-odd rule. See
[Geo](./GEO.md).

### Null markers

`null` on a `f.json()` column is genuinely ambiguous — the user might
mean "the column is NULL" or "the column holds the JSON literal
`null`". Forge exposes three explicit markers in
`src/null-markers.ts`:

| Marker | Means | SQL emit | Mongo |
|---|---|---|---|
| `ForgeDbNull` | column NULL | `"col" IS NULL` | `{ col: null }` |
| `ForgeJsonNull` | JSON literal `null` inside the column | `("col")::jsonb = 'null'::jsonb` | `{ col: null }` (Mongo collapses) |
| `ForgeAnyNull` | either of the above | `("col" IS NULL OR ("col")::jsonb = 'null'::jsonb)` | `{ col: null }` |

Mongo collapses both forms to a single `null`, so the marker matters
on PG / MySQL / SQLite / DuckDB / MSSQL but is a no-op on Mongo.

---

## Logical operators — AND, OR, NOT, implicit AND

Sibling keys at the same level are joined by an implicit `AND`. The
explicit `AND` key is only needed when you want to express two
predicates on the **same** field key in one filter — `Object.keys`
will dedupe them otherwise.

```ts
// implicit AND between sibling keys
await db.post.findMany({
  where: { status: 'PUBLISHED', author_id: 'u_1' },
});

// explicit AND because both branches target `views`
await db.post.findMany({
  where: {
    AND: [
      { views: { gte: 100 } },
      { views: { lt: 1_000 } },
    ],
  },
});
```

`AND`, `OR`, and `NOT` accept either a single filter object or an
array of them. Empty arrays collapse — `OR: []` is dropped from the
tree rather than translated to literal `FALSE`. The IR emits:

| Tree | PG emit | Mongo |
|---|---|---|
| `AND` of `[a, b]` | `(a AND b)` | `{ $and: [a, b] }` (or flattened if children share no keys) |
| `OR` of `[a, b]` | `(a OR b)` | `{ $or: [a, b] }` |
| `NOT` of `a` | `NOT (a)` | `{ $nor: [a] }` |
| `NOT` of `[a, b]` | `NOT (a AND b)` | `{ $nor: [{ $and: [a, b] }] }` |

Worked example mixing all three — "PUBLISHED posts from this week
that are either pinned or have over 100 views, but not in the
archive":

```ts
await db.post.findMany({
  where: {
    status:     'PUBLISHED',                                   // implicit AND with siblings
    created_at: { gte: oneWeekAgo },                           // implicit AND
    OR: [
      { pinned: true },
      { views:  { gt: 100 } },
    ],
    NOT: { archived: true },
  },
});
```

The PG emit:

```sql
WHERE "status" = $1
  AND "created_at" >= $2
  AND ("pinned" = $3 OR "views" > $4)
  AND NOT ("archived" = $5)
```

Mongo gets the equivalent `$and` / `$or` / `$nor`.

---

## `col()` — field-to-field comparison

Sometimes the right-hand side of a comparison is another column on the
same row, not a literal. Without a marker, forge would treat the
string as a literal value. `col('other_field')` is the explicit form.

```ts
import { col } from 'forge-orm';

// stock vs. reorder threshold on the same row
await db.product.findMany({
  where: { stock_level: { lt: col('reorder_threshold') } },
});
```

Per-dialect emit:

| Dialect | Emit |
|---|---|
| Postgres | `"product"."stock_level" < "product"."reorder_threshold"` |
| MySQL | `` `product`.`stock_level` < `product`.`reorder_threshold` `` |
| SQLite | `"product"."stock_level" < "product"."reorder_threshold"` |
| Mongo | `{ $expr: { $lt: ['$stock_level', '$reorder_threshold'] } }` |

`col()` only accepts the six comparison operators — `equals`, `not`,
`lt`, `lte`, `gt`, `gte`. Pairing it with `in`, `contains`, or
`startsWith` throws at build time. The referenced field is checked
against the model — a typo or a relation name throws too. That
strictness is deliberate: the value becomes a SQL identifier or a
Mongo `$field` path downstream, and the validation is the only
identifier-injection surface in the read path.

The canonical use is an atomic, race-safe guarded counter:

```ts
// only if room remains — single atomic write, no read-then-check window
await db.promo.update({
  where: { id, current_usage: { lt: col('global_limit') } },
  data:  { current_usage: { increment: 1 } },
});
```

The `update` here is a single round-trip on every dialect. The
guarded counter pattern is documented in the README under
[Atomic number ops](../README.md#atomic-number-ops).

---

## Filtering by relation — `is`, `isNot`, `some`, `every`, `none`

Five quantified modes for filtering by a related row.

| Mode | Applies to | Meaning |
|---|---|---|
| `is`     | one-to-one / many-to-one | nested filter on the single related row |
| `isNot`  | one-to-one / many-to-one | inverse of `is` |
| `some`   | one-to-many / many-to-many | at least one related row matches |
| `every`  | one-to-many / many-to-many | every related row matches |
| `none`   | one-to-many / many-to-many | no related row matches |

Worked: "posts whose author is verified, that have at least one
unflagged comment".

```ts
await db.post.findMany({
  where: {
    author:   { is:   { verified: true } },
    comments: { some: { flagged: false } },
  },
});
```

SQL emit on PG (MySQL/SQLite differ only in identifier and
placeholder syntax):

```sql
SELECT … FROM "post" WHERE
  EXISTS (SELECT 1 FROM "user"    "t1" WHERE "t1"."id" = "post"."author_id"
                                       AND "t1"."verified" = $1)
  AND
  EXISTS (SELECT 1 FROM "comment" "t2" WHERE "t2"."post_id" = "post"."id"
                                       AND "t2"."flagged"  = $2);
```

`every` is the trickiest — it emits a double negation:

```sql
-- comments: { every: { approved: true } }
NOT EXISTS (
  SELECT 1 FROM "comment" "t1"
  WHERE "t1"."post_id" = "post"."id"
    AND NOT ("t1"."approved" = $1)
)
```

That form correctly returns posts with **zero** comments too —
because there is no row that fails the predicate. If you mean "every
**existing** comment is approved, and there must be at least one",
combine with `some: {}`:

```ts
where: {
  comments: { every: { approved: true }, some: {} },
}
```

On Mongo, relation filters in `where` are **not** supported today —
forge compiles them to `{}` (match-all) rather than emit a `$lookup`
into the filter pipeline. Use `aggregate` with an explicit `$lookup`
+ `$match` for Mongo relation filters until that gap closes.

**N+1 gotcha.** `EXISTS` correlates against the outer table, so the
planner runs the subquery once per outer row in the worst case.
Wherever you join on a relation, make sure the relation's foreign key
column is indexed — `f.string().index()` on the FK, or a compound
index if the inner filter touches more columns. Without an index the
EXISTS becomes a sequential scan inside a sequential scan and the
query collapses on tables over a few thousand rows.

---

## `select` and `include` — projection rules and inference

Default behaviour: every read returns all of the model's own scalar
columns (`Row<typeof User>`). `select` and `include` change that, and
they are mutually exclusive — passing both at the same call throws.

- **`select`** — exclusive list. The result type narrows to the
  selected keys only. No relations come back unless you also select
  them.
- **`include`** — additive. The result still has every scalar column,
  plus the related records you ask for.

```ts
// only id and email come back; the type is { id: string; email: string }[]
const slim = await db.user.findMany({ select: { id: true, email: true } });

// every scalar column on user, plus the posts relation
const full = await db.user.findFirst({
  where:   { id: 'u_1' },
  include: { posts: true },
});
```

### Nested select

Selects nest. A nested `select` under a relation key narrows that
relation's projection too.

```ts
// posts come back as { id, title, author: { name } }[]
await db.post.findMany({
  select: {
    id:     true,
    title:  true,
    author: { select: { name: true } },
  },
});
```

The result type infers all the way down — the projection plumbing in
`src/ir/build/projection.ts` flags the node as `exclusive: true` for a
`select`, `exclusive: false` for an `include`, and the inferred row
type collapses to match.

### Mixing select inside include

`include` can carry a `select` per relation. The outer model gets all
its scalars; the relation is narrowed.

```ts
// user with every column, plus posts narrowed to (id, title) only
await db.user.findFirst({
  include: {
    posts: { select: { id: true, title: true } },
  },
});
```

### Relation-scoped args under include

`include` also accepts `where`, `orderBy`, `take`, and `skip` per
relation. Those run as the relation's own subquery (a JOIN with
filter on SQL, a `$lookup` on Mongo).

```ts
await db.user.findFirst({
  include: {
    posts: {
      where:   { status: 'PUBLISHED' },
      orderBy: { created_at: 'desc' },
      take:    5,
    },
  },
});
```

### `_count`

Drops a `_count` field onto the parent row with relation
cardinalities.

```ts
await db.user.findMany({
  include: { _count: { select: { posts: true, comments: true } } },
});
// → user._count = { posts: 5, comments: 12 }
```

`_count` is the only synthetic-field surface forge exposes today —
sums and averages of related-row columns go through `aggregate`.

### `omit`

`omit: { password_hash: true }` is the inverse of `select` — every
scalar except the listed keys. Useful when only one or two columns
are sensitive and the rest of the row is fine to expose. `omit` is
**not** combinable with `select` (it would be ambiguous); it
**is** combinable with `include` and relation-scoped args.

---

## `orderBy` — single, multi, relation, `_count`, nulls

`orderBy` accepts five shapes.

### Single field

```ts
orderBy: { created_at: 'desc' }
```

| Dialect | Emit |
|---|---|
| Postgres | `ORDER BY "created_at" DESC` |
| MySQL | ``ORDER BY `created_at` DESC`` |
| SQLite | `ORDER BY "created_at" DESC` |
| Mongo | `.sort([['created_at', -1]])` |

### Multi-field

Pass an array. Order matters — the first key is the major sort, the
last is the minor.

```ts
orderBy: [{ pinned: 'desc' }, { created_at: 'desc' }]
```

`ORDER BY "pinned" DESC, "created_at" DESC`.

### Nulls first / last

```ts
orderBy: { last_seen_at: { sort: 'desc', nulls: 'last' } }
```

| Dialect | Emit |
|---|---|
| Postgres | `ORDER BY "last_seen_at" DESC NULLS LAST` |
| SQLite | `ORDER BY "last_seen_at" DESC NULLS LAST` |
| MySQL | Ignored — MySQL has no portable `NULLS LAST` syntax. NULLs sort first under `DESC` and last under `ASC` regardless. Reach for an expression order (`ORDER BY ISNULL(col), col DESC`) via `$queryRaw` if you need the inverse. |
| Mongo | Honoured — Mongo's natural null ordering matches the SQL default. |

### Case-insensitive sort

`mode: 'insensitive'` on an `orderBy` is documented at the surface but
the same caveat applies as for the `where` operator: only Postgres
emits a portable case-folded sort (`ORDER BY LOWER("col")`). On
MySQL the collation usually does it for you. On SQLite the column
needs `COLLATE NOCASE` at DDL time. Reach for an explicit lower-case
column on the row if you need it everywhere.

### Order by a relation field or `_count`

```ts
// most-commented post first
orderBy: { _count: { comments: 'desc' } }

// by the author's display name
orderBy: { author: { name: 'asc' } }
```

These two forms are documented at the README surface but are **not**
yet wired through `buildOrderBy` in the IR — the compiler silently
drops them. Track the gap and use an explicit aggregate + sort
through `groupBy` or `$queryRaw` until that lands.

### Geo and vector `nearTo`

```ts
orderBy: { location:  { nearTo: { lng: 3.39, lat: 6.45 } } }
orderBy: { embedding: { nearTo: [0.1, 0.2, /* … 1534 more */] } }
```

The compiler injects a synthetic `_distanceMeters` (geo) or
`_distance` (vector) expression into the SELECT list and orders on
that alias. See [Geo](./GEO.md) and [Vector](./VECTOR.md) for the
per-dialect distance expression.

---

## Pagination — offset vs cursor

Two strategies, with very different failure modes.

### Offset (`take` + `skip`)

```ts
await db.post.findMany({
  where:   { status: 'PUBLISHED' },
  orderBy: { created_at: 'desc' },
  take:    20,
  skip:    40,                       // page 3 of 20-row pages
});
```

Emits `LIMIT 20 OFFSET 40` on PG / MySQL / SQLite / DuckDB,
`OFFSET 40 ROWS FETCH NEXT 20 ROWS ONLY` on MSSQL, `.limit(20).skip(40)`
on Mongo.

**Failure mode.** Offset is positional in the result set. If anyone
inserts or deletes rows between page loads, the page boundaries
shift — a row that was the last of page 2 reappears as the first of
page 3, or a row gets skipped entirely. On an ordered list of posts
ordered by `created_at desc`, the most likely cause is a new post
arriving between page loads: every offset bumps by one and the user
sees the same row twice.

Use offset when:

- The result set is stable for the duration of the user's session
  (admin reports against historical data).
- You need jump-to-page (page 47, page 1024).
- You can tolerate occasional dupes (logs, audit trails where the
  user is scrolling and not selecting).

### Cursor (`cursor` + `take`)

```ts
const page1 = await db.post.findMany({
  where:   { status: 'PUBLISHED' },
  orderBy: { id: 'asc' },
  take:    20,
});
const lastId = page1[page1.length - 1]?.id;

const page2 = await db.post.findMany({
  where:   { status: 'PUBLISHED' },
  orderBy: { id: 'asc' },
  take:    20,
  cursor:  { id: lastId },
  skip:    1,                        // skip the cursor row itself
});
```

The IR emits a half-open inequality on the cursor key — `"id" > $n` —
which is a sargable index scan on every SQL dialect and a
`{ id: { $gt: lastId } }` filter on Mongo. The page is stable under
concurrent writes because the boundary is a row identity, not a
position.

**Stable-cursor pattern with a tie-breaker.** When the visible sort
key is not unique (e.g. `created_at`), pair it with a unique
tie-breaker so the cursor is monotone.

```ts
await db.post.findMany({
  orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
  take:    20,
  cursor:  { id: lastSeenId },        // single-column cursor is fine even with multi-column orderBy
  skip:    1,
});
```

PG and SQLite support a true row-value tuple cursor —
`("created_at","id") < ($n1,$n2)` — which scales to multi-column
unique compound cursors. The IR emits the tuple form when the
cursor object names a compound unique key. Mongo cannot tuple-compare,
so a compound cursor on Mongo becomes a chained `$and` of
`{ created_at: { $lt: a } } OR ({ created_at: a } AND { id: { $lt: b } })`.

Use cursor when:

- The result set is changing while the user pages (any feed, any
  realtime list).
- You only need forward / backward navigation, not random access.
- The user-perceived sort key has a tie-breaker available.

`take: -20` reverses direction — that compiles to a backward scan
(`< $cursor ORDER BY id DESC` then re-reverses in code) and is the
right shape for "previous page".

### Mongo specifics

Mongo cursor pagination works the same way at the API level. The
emit is `{ filter: { id: { $gt: lastId }, …user filter }, sort: [['id', 1]], limit: 20 }`.
For very large collections, pair the cursor with `hint()` through the
adapter to force the index — the planner sometimes prefers a covered
sort over the cursor index, which kills the latency budget.

---

## `distinct`

`distinct` accepts a single column or an array of columns.

```ts
// one row per email — the rest of the row is the first match per group
await db.user.findMany({ distinct: ['email'] });

// one row per (org, role) pair
await db.member.findMany({ distinct: ['org_id', 'role'] });
```

| Dialect | Emit |
|---|---|
| Postgres | `SELECT DISTINCT ON ("email") … ORDER BY "email"` — PG's native form, picks the first row per group as ordered |
| MySQL | `SELECT DISTINCT …` — operates over the entire selected column list, not a single column |
| SQLite | `SELECT DISTINCT …` — same as MySQL |
| Mongo | `aggregate: [{ $group: { _id: '$email', doc: { $first: '$$ROOT' } } }, { $replaceRoot: { newRoot: '$doc' } }]` |

The DISTINCT ON / DISTINCT semantic difference is the real footgun.

- On **Postgres**, `distinct: ['email']` is one row per unique
  `email`, with the rest of the row coming from whichever row sorts
  first under the query's `orderBy`. The compiler injects `email`
  as the leading sort key automatically if you forget.
- On **MySQL** and **SQLite**, the emitted `SELECT DISTINCT` operates
  over **every** selected column. If you ask for the full row, you
  get distinct *rows*, not distinct *emails*. The compiler rewrites
  the projection to include only the distinct columns plus an
  aggregate over the rest — or, when that is ambiguous, narrows the
  SELECT to just the distinct columns.

If you want the same semantic everywhere, project only the distinct
columns:

```ts
await db.user.findMany({
  select:   { email: true },
  distinct: ['email'],
});
```

That compiles to `SELECT DISTINCT "email" FROM "user"` on every SQL
dialect and to a `$group` with just the `_id` projected on Mongo.

---

## `count` and `_count`

Top-level count:

```ts
const total = await db.user.count({ where: { active: true } });
```

| Dialect | Emit |
|---|---|
| Postgres | `SELECT COUNT(*) FROM "user" WHERE "active" = $1` |
| MySQL | ``SELECT COUNT(*) FROM `user` WHERE `active` = ?`` |
| SQLite | `SELECT COUNT(*) FROM "user" WHERE "active" = ?` |
| Mongo | `coll.countDocuments({ active: true })` |

`count` accepts `where`, `distinct`, `take`, `skip`, `cursor`,
`orderBy`. `take`/`skip` are honoured (`SELECT COUNT(*) FROM (SELECT … LIMIT … OFFSET …)`)
so you can ask "is there a 21st row?" cheaply.

With `distinct`:

```ts
await db.user.count({ distinct: ['email_domain'] });
// PG / MySQL / SQLite: SELECT COUNT(DISTINCT "email_domain") FROM "user"
// (SQLite multi-column distinct gets rewritten as
//  SELECT COUNT(*) FROM (SELECT 1 FROM "user" GROUP BY a, b))
```

Per-row relation counts via `_count`:

```ts
await db.user.findMany({
  include: { _count: { select: { posts: true, comments: true } } },
});
```

Each parent row gets a `_count` field with the relation cardinalities.
On SQL that emits a correlated subquery (`(SELECT COUNT(*) FROM "post" WHERE "post"."author_id" = "user"."id") AS "_count_posts"`)
per relation; on Mongo it emits an aggregation pipeline with `$lookup`
+ `$size`.

Counting with a filter on the relation:

```ts
await db.user.findMany({
  include: {
    _count: { select: { posts: { where: { status: 'PUBLISHED' } } } },
  },
});
```

The `_count` value here is "published posts per user", not "all
posts per user".

---

## Aggregates — `_avg`, `_sum`, `_min`, `_max`

Bucketed scalar aggregates against the model's own columns.

```ts
await db.order.aggregate({
  where: { status: 'PAID', created_at: { gte: monthStart } },
  _avg:  { total: true },
  _sum:  { total: true, items_count: true },
  _min:  { total: true },
  _max:  { total: true },
  _count: true,                        // top-level row count
});
// → { _avg: { total: 432.18 }, _sum: { total: 19_872, items_count: 187 }, … }
```

Per-dialect emit (PG):

```sql
SELECT
  AVG("total")        AS "__agg_avg_total",
  SUM("total")        AS "__agg_sum_total",
  SUM("items_count")  AS "__agg_sum_items_count",
  MIN("total")        AS "__agg_min_total",
  MAX("total")        AS "__agg_max_total",
  COUNT(*)            AS "__agg_count"
FROM "order"
WHERE "status" = $1 AND "created_at" >= $2;
```

MySQL and SQLite emit the same shape with their identifier and
placeholder syntax. Mongo emits a single `$group` stage with
`_id: null` and the same `__agg_*` keys.

**Floating-point caveats.** `_avg` on a `f.number()` column returns a
JavaScript number — on PG that comes back as `numeric` (string in
node-postgres) and gets cast through `Number()` at hydration. Loss of
precision is possible for sums over very large totals (more than ~16
digits of mantissa) or averages with many decimals; for money,
declare the column as `f.decimal()` and pull `_sum` as the typed
decimal string. On Mongo the aggregate runs in `double` precision —
the same caveat applies.

**Wrap them in a filter.** Every aggregate honours the same `where`
as `findMany`. Run an unfiltered aggregate on a big table once, see
the latency, and then put the filter back in.

---

## `groupBy` and `having`

```ts
await db.order.groupBy({
  by:    ['status'],
  where: { created_at: { gte: oneDayAgo } },
  _sum:  { total: true },
  _count: true,
  having: {
    _sum: { total: { gt: 1_000 } },
  },
  orderBy: { _sum: { total: 'desc' } },
});
// → [
//   { status: 'PAID',    _sum: { total: 12_300 }, _count: 17 },
//   { status: 'PENDING', _sum: { total: 4_120  }, _count:  9 },
// ]
```

Per-dialect emit (PG):

```sql
SELECT
  "status",
  SUM("total") AS "__agg_sum_total",
  COUNT(*)     AS "__agg_count"
FROM "order"
WHERE "created_at" >= $1
GROUP BY "status"
HAVING SUM("total") > $2
ORDER BY SUM("total") DESC;
```

`having` accepts the same operator vocabulary as `where` (`equals`,
`not`, `lt`, `lte`, `gt`, `gte`) but the field key is an aggregate
shape — `_count`, `_avg: { col }`, `_sum: { col }`, `_min: { col }`,
`_max: { col }`. Anything else throws at build time.

Multi-column group keys:

```ts
await db.order.groupBy({
  by:    ['status', 'currency'],
  _sum:  { total: true },
});
// → [{ status: 'PAID', currency: 'NGN', _sum: { total: … } }, … ]
```

`GROUP BY "status", "currency"`.

Mongo emit:

```js
[
  { $match: { created_at: { $gte: oneDayAgo } } },
  { $group: {
      _id:                { status: '$status' },
      __agg_sum_total:    { $sum: '$total' },
      __agg_count:        { $sum: 1 },
    } },
  { $match: { __agg_sum_total: { $gt: 1000 } } },        // having
  { $sort:  { __agg_sum_total: -1 } },
]
```

The compiler unwraps `_id.<col>` back into the result rows during
hydration, so the caller sees the same `{ status, _sum, _count }`
shape on Mongo as on SQL.

---

## `findManyStream` — cursor-backed streaming

`findMany` materialises every row into a single `T[]` array. For
large result sets — exports, batch transforms, anything that does not
fit in memory — `findManyStream` yields rows one at a time.

```ts
for await (const order of db.order.findManyStream({
  where:   { created_at: { gte: yearStart } },
  orderBy: { id: 'asc' },
})) {
  await processOne(order);
}
```

The async iterator yields per row. Memory stays flat — only the
driver's read buffer (and the current row) live in heap at any time.

Per-driver behaviour:

| Driver | Mechanism |
|---|---|
| Postgres (`pg`) | Server-side cursor inside a transaction: `BEGIN; DECLARE forge_stream_<n> CURSOR FOR <sql>; FETCH 200 FROM …; … CLOSE; COMMIT;` |
| MySQL (`mysql2`) | `conn.connection.query({ sql, values }).stream({ highWaterMark: 200 })` — `mysql2`'s native row stream |
| SQLite (`better-sqlite3`) | `stmt.iterate(params)` — synchronous prepared-statement iterator wrapped into an async iterable |
| Mongo (`mongodb`) | `coll.find(filter, options).stream()` — the driver's native cursor stream |
| Adapters without native streaming | Falls back to OFFSET/LIMIT chunking (`chunkSize: 1000` default) so the API is uniform; same warning as offset pagination — concurrent writes can shift the boundary |

A note on hydration: per-row hydration runs on each yielded row, but
batched hydration (the kind that `findMany` does for relation
preloads) is **not** done across the stream — the included relation
would need to buffer the whole result set, which defeats the point.
If you stream rows that need a related-record join, plan to look up
the related rows yourself per row, or batch the stream into chunks
and call `findMany` over each chunk's ids.

---

## Common bugs

### `findUnique` strictness

`findUnique({ where: { email_domain: 'x.co' } })` throws at build
time when `email_domain` is not unique. The caller usually meant
`findFirst`. The fix is one of:

1. Switch to `findFirst` (and add an `orderBy` so the first match is
   deterministic).
2. Switch to `findMany` if more than one row can match.
3. Add `.unique()` to the column at the schema level — but only if
   the domain model actually requires uniqueness, not as a way to
   silence the error.

### `mode: 'insensitive'` not portable

Only Postgres compiles `mode: 'insensitive'` to a real case-folded
operator (`ILIKE`). MySQL's default collation makes the comparison
already case-insensitive, so the flag has no visible effect — but a
`_bin` or `_cs` collation will silently keep matching case-sensitively.
SQLite does not honour the flag at all; LIKE is case-insensitive
only for ASCII and only by accident. If the matching has to work on
every dialect (especially for non-ASCII text), store a normalised
lower-case shadow column and filter on that.

### `between` semantics

There is no `between` operator in forge. `{ gte, lte }` is the
inclusive form, `{ gt, lt }` is exclusive. Be explicit at the call
site — readers used to other ORMs sometimes assume `between` is
exclusive on dates and inclusive on integers and get it wrong both
ways.

### Regex flavours differ

Forge does not expose a portable `regex` operator. If you reach for
PG-style `~` or `~*`, MySQL's `REGEXP`, SQLite's optional `REGEXP`,
or Mongo's `$regex`, drop to `$queryRaw` and own the dialect-specific
pattern explicitly. PCRE, POSIX, and JavaScript regex disagree on
enough escape sequences that a single portable surface would mislead
more than it would help.

### `orderBy` by relation or `_count` is silently dropped today

The README documents `orderBy: { author: { name: 'asc' } }` and
`orderBy: { _count: { posts: 'desc' } }`, but the IR builder in
`src/ir/build/orderby.ts` does not translate them. The query runs;
the order is just not applied. Until the gap closes, work around it
with an aggregate query (`groupBy` + `_count` + `orderBy: { _count: … }`)
or `$queryRaw`.

### Empty `in: []` is not a bug

`in: []` compiles to literal `FALSE` and the query returns zero
rows. That looks like a bug from the caller's side ("why did my
filter return nothing?") but it is the correct answer — the user
asked for rows whose value is in the empty set. Guard against it
upstream when the empty case should mean "no filter" rather than
"match nothing".

### `null` on `f.json()` columns is ambiguous

A literal `null` JSON value is **not** the same thing as a NULL
column. Use the explicit `ForgeDbNull`, `ForgeJsonNull`, or
`ForgeAnyNull` marker to spell out which one you mean. Mongo
collapses both — the marker is a no-op there — but on every SQL
dialect the two are distinct and the bug shows up as "I deleted the
field but my filter still matches".

### Relation filters on Mongo are a no-op

`where: { posts: { some: { … } } }` compiles to `{}` on Mongo today.
The query runs and returns every parent row. Use `aggregate` with
`$lookup` + `$match` for Mongo relation filters until the gap closes.

### `_count` filters need the relation key

`_count: { posts: { where: { status: 'PUBLISHED' } } }` counts only
published posts. `_count: { posts: true }` counts every post. The
two forms read similarly and the wrong one will look correct in
testing until a draft post shows up.

---

## Eight worked queries

### (a) Customer search-as-you-type with `contains` + cursor

The classic typeahead. Substring match on a name, case-insensitive
through a lower-case shadow column, cursor pagination so concurrent
inserts do not skip rows.

```ts
const term = req.query.q.trim().toLowerCase();
const lastSeenId = req.query.after as string | undefined;

const matches = await db.customer.findMany({
  where: {
    deleted_at:   null,
    name_lower:   { contains: term },   // shadow column, populated on write
    org_id:       req.org.id,
  },
  orderBy: [{ name: 'asc' }, { id: 'asc' }],
  take:    25,
  ...(lastSeenId ? { cursor: { id: lastSeenId }, skip: 1 } : {}),
  select: { id: true, name: true, email: true },
});
```

The shadow column is the portable case-insensitivity workaround.
Build it with a write-side hook or a generated column at DDL time.

### (b) Last 24h orders, grouped by status, sorted by total

`groupBy` + `having` + `orderBy` on an aggregate key.

```ts
const recent = await db.order.groupBy({
  by:     ['status'],
  where:  { created_at: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  _sum:   { total: true },
  _count: true,
  having: { _count: { gt: 0 } },           // drop empty buckets
  orderBy: { _sum: { total: 'desc' } },
});
```

PG emit:

```sql
SELECT "status", SUM("total") AS "__agg_sum_total", COUNT(*) AS "__agg_count"
FROM "order"
WHERE "created_at" >= $1
GROUP BY "status"
HAVING COUNT(*) > 0
ORDER BY SUM("total") DESC;
```

### (c) Top 10 products by revenue across all orgs

Multi-tenant aggregate. `groupBy` by product, sum the line totals,
order desc, cap at 10.

```ts
const top = await db.order_line.groupBy({
  by:      ['product_id'],
  where:   { order: { is: { status: 'PAID' } } },   // see relation-filter caveat above
  _sum:    { total: true },
  orderBy: { _sum: { total: 'desc' } },
  take:    10,
});
```

If the relation filter is too slow on PG, denormalise `paid` onto
the line at write time and filter directly on `where: { paid: true }`.
On Mongo, run as an `aggregate` with a `$lookup` since relation
filters in `where` are a no-op there.

### (d) Geo proximity with cursor

`near` filter + cursor on `(distance, id)` for stable paging.

```ts
const here = { lng: 3.39, lat: 6.45 };

const nearby = await db.shop.findMany({
  where:   { location: { near: { lng: here.lng, lat: here.lat, withinMeters: 5_000 } } },
  orderBy: [{ location: { nearTo: here } }, { id: 'asc' }],
  take:    20,
  ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
});
```

The synthetic `_distanceMeters` column comes back on the row when
the orderBy uses `nearTo`. Cursor on `id` is portable; cursor on
`_distanceMeters` directly is not supported because the column does
not exist between requests.

### (e) Vector retrieval

`nearTo` orderBy on a `f.vector(N)` column.

```ts
const results = await db.document.findMany({
  where: { embedding: { near: { vector: queryVec, withinDistance: 0.4 } } },
  orderBy: { embedding: { nearTo: queryVec } },
  take:    10,
});
```

The optional `where.near` gives the planner a recall filter (cuts
the candidate set before the ORDER BY scans every row). The
`orderBy.nearTo` does the actual ranking. See [Vector](./VECTOR.md).

### (f) JSON path filter on a tag array

```ts
await db.ticket.findMany({
  where: { meta: { path: 'tags', arrayContains: 'urgent' } },
});
```

The compiler picks the right JSON read per dialect (`->`/`->>` on
PG, `JSON_EXTRACT` on MySQL, `json_extract` on SQLite/DuckDB,
`JSON_VALUE` on MSSQL, dotted key on Mongo) and pairs it with the
sub-operator. See [JSON-PATH.md](./JSON-PATH.md) for the full
operator matrix.

### (g) Soft-delete-aware default

Bake the `deletedAt: null` filter into a helper so every read in the
app skips deleted rows by default.

```ts
// repos/customer.ts
export const customerRepo = {
  findActive: (where: WhereInput) =>
    db.customer.findMany({ where: { deleted_at: null, ...where } }),

  findById:   (id: string) =>
    db.customer.findUnique({ where: { id, deleted_at: null } }),
};
```

Forge has first-class soft-delete (`f.softDelete()` + `db.x.softDelete()`
and the auto-filter on `findMany`), so the helper above is the
escape hatch only when you have non-soft-delete columns to merge in.
For a model declared with `f.softDelete()`, every read already
appends `WHERE "deleted_at" IS NULL` and every write skips
already-deleted rows.

### (h) Recursive WITH — top of the comment tree

Forge does not emit recursive CTEs. The escape hatch is `$queryRaw`.

```ts
const tree = await db.$queryRaw<CommentNode[]>`
  WITH RECURSIVE thread AS (
    SELECT id, parent_id, body, 0 AS depth
    FROM comment
    WHERE id = ${rootId}

    UNION ALL

    SELECT c.id, c.parent_id, c.body, t.depth + 1
    FROM comment c
    JOIN thread  t ON c.parent_id = t.id
    WHERE t.depth < 20
  )
  SELECT * FROM thread ORDER BY depth, id;
`;
```

`$queryRaw` runs through the same prepared-statement plumbing as
the rest of forge — the `${rootId}` interpolation parameterises
cleanly (it does not string-concat). The trade-off is per-dialect
SQL: PG/SQLite/DuckDB support `WITH RECURSIVE` directly, MSSQL uses
`WITH … (anchor UNION ALL recursive) … OPTION (MAXRECURSION 20)`,
MySQL 8 supports `WITH RECURSIVE`, MySQL 5.7 does not. Mongo has no
equivalent — the closest shape is `$graphLookup`, which `$runMongo`
can emit directly.

For self-referential reads up to a known depth, the multi-join
form is portable and avoids the dialect spread:

```ts
await db.comment.findFirst({
  where:   { id: rootId },
  include: {
    replies: {
      include: { replies: { include: { replies: true } } },
    },
  },
});
```

Three levels deep at compile time. Past that, raw SQL is the right
tool.
