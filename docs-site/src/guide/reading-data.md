---
title: "Reading data"
---

## Reading data

Every model has the read methods you expect.

```ts
await db.user.findMany({ where: { active: true }, take: 20 });
await db.user.findFirst({ where: { email: 'a@x.co' } });          // first match or null
await db.user.findUnique({ where: { id: 'u1' } });                 // by a unique field
await db.user.findFirstOrThrow({ where: { email: 'a@x.co' } });    // throws if missing
await db.user.findUniqueOrThrow({ where: { id: 'u1' } });          // throws if missing
await db.user.count({ where: { active: true } });
await db.user.aggregate({                                          // bucketed stats
  where: { active: true },
  _avg:  { age: true },
  _sum:  { credits: true },
});
```

### Filtering with `where`

`where` accepts either a direct value or an operator object per field, plus
`AND`, `OR`, and `NOT`.

```ts
await db.post.findMany({
  where: {
    status: 'PUBLISHED',                       // equals
    title:  { contains: 'forge' },             // text match
    views:  { gte: 100, lt: 1000 },            // ranges
    author_id: { in: ['u1', 'u2'] },           // any of
    OR: [
      { pinned: true },
      { created_at: { gt: new Date('2024-01-01') } },
    ],
  },
});
```

### Operator reference

All operators, with the field kinds they apply to.

| Operator        | Applies to                              | Meaning                                                                 |
| --------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `equals` / `=`  | every field                             | exact match (same as passing a value directly)                          |
| `not`           | every field                             | inverse of `equals` (accepts a value or a nested filter)                |
| `in`            | every field                             | value is one of an array                                                |
| `notIn`         | every field                             | value is not in an array                                                |
| `lt` / `lte` / `gt` / `gte` | numbers, dates, strings    | range comparisons                                                       |
| `contains`      | strings                                 | substring match (`LIKE %x%`)                                            |
| `startsWith`    | strings                                 | prefix match (`LIKE x%`)                                                |
| `endsWith`      | strings                                 | suffix match (`LIKE %x`)                                                |
| `mode: 'insensitive'` | strings                           | case-insensitive variant of the text operators                          |
| `has`           | `stringArray` / `intArray` / `embedMany` | the list contains the given value                                       |
| `hasEvery`      | array fields                             | the list contains all of the given values                               |
| `hasSome`       | array fields                             | the list contains at least one of the given values                      |
| `isEmpty`       | array fields                             | `length === 0`                                                          |
| `some` / `every` / `none` | `embedMany` / relations         | quantified filter on the nested rows                                    |
| `search`        | `f.text().searchable()` columns         | full-text search (see [Full-text search](/guide/full-text-search#full-text-search))            |
| `path` + sub-op | `f.json()` / `f.embed()` / `f.embedMany()` / arrays | typed JSON path read (see [JSON path queries](/guide/json-path-queries#json-path-queries)) |
| dotted key (`'address.city'`) | `f.json()` / `f.embed()` / `f.embedMany()` / arrays | shorthand for a `path` filter — `{ 'address.city': 'sf' }`, `{ 'meta.stats.views': { gte: 10 } }`. Compiles portably on every dialect; strict mode validates embed sub-fields |
| `near`          | `f.geoPoint()` / `f.vector()`            | within distance (see [Geo](/guide/geo-geopoint-near-nearto-withinpolygon#geo-geopoint-near-nearto-withinpolygon) / [Vector](/guide/vector-similarity-search#vector-similarity-search)) |
| `withinPolygon` | `f.geoPoint()`                          | point lies inside a polygon                                             |
| `AND` / `OR` / `NOT` | top level                          | boolean combinators (accept arrays or single objects)                   |

An operator forge doesn't recognise **throws** (since 2.7) rather than being
dropped — a dropped condition means the filter silently matches every row.
The error names the column and suggests the fix, so `$gte` says "use `gte`"
and `contians` says "did you mean `contains`".

### Comparing two columns: `col()`

Use `col('otherField')` on the right-hand side of `equals`/`not`/`lt`/`lte`/
`gt`/`gte` to compare one column against another column **of the same row**,
instead of against a literal. It works the same on every dialect — Mongo
compiles it to `$expr`, SQL to a plain `a <op> b`.

```ts
import { col } from 'forge-orm';

// promos still under their global cap
await db.promo.findMany({
  where: { currentUsage: { lt: col('globalLimit') } },
});

// the canonical use: an atomic, race-safe guarded counter
await db.promo.update({
  where: { id, currentUsage: { lt: col('globalLimit') } },   // only if room remains
  data:  { currentUsage: { increment: 1 } },                 // single atomic write
});
```

`col()` only accepts the six comparison operators, and the referenced field
must be a real scalar column (a typo or relation name throws at build time).

### Choosing fields: `select` and `include`

By default a query returns all of a model's own columns. To change that, use one
of these (you may use one or the other, not both at once):

* `select` returns **only** the fields you list. The result type narrows to match.
* `include` returns all columns **plus** the related records you ask for.

```ts
// only these two fields come back
const slim = await db.user.findMany({ select: { id: true, email: true } });

// the user plus their posts, and each post's comments
const full = await db.user.findFirst({
  where:   { id: 'u1' },
  include: { posts: { include: { comments: true } } },
});

// you can filter and limit an included relation
await db.user.findFirst({
  include: { posts: { where: { status: 'PUBLISHED' }, orderBy: { created_at: 'desc' }, take: 5 } },
});

// _count returns relation cardinalities
await db.user.findMany({ include: { _count: { select: { posts: true, comments: true } } } });
// → user.{_count: { posts: 5, comments: 12 }}
```

### Sorting and pagination

```ts
await db.post.findMany({
  where:   { status: 'PUBLISHED' },
  orderBy: { created_at: 'desc' },     // or an array for multiple keys
  take:    20,                          // page size
  skip:    40,                          // offset
});

// cursor pagination, for stable paging over large sets
await db.post.findMany({ take: 20, cursor: { id: lastSeenId }, skip: 1 });
```

See more — **[docs/QUERIES.md](/reference/queries)** for every operator with per-dialect SQL/Mongo emit, cursor pagination, distinct, streaming internals, common bugs, and eight worked queries. **[docs/AGGREGATIONS.md](/reference/aggregations)** for count/sum/avg/groupBy/having dashboards. **[docs/WINDOWS.md](/reference/windows)** for ROW_NUMBER / LAG / LEAD / moving averages / sessionization. **[docs/PAGINATION.md](/reference/pagination)** for cursor vs offset vs keyset and Relay/REST response shapes. **[docs/STREAMING.md](/reference/streaming)** for `findManyStream` internals per driver. **[docs/N-PLUS-ONE.md](/reference/n-plus-one)** for the canonical query-explosion prevention patterns.

---
