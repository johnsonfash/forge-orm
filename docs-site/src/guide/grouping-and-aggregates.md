---
title: "Grouping and aggregates"
---

## Grouping and aggregates

`groupBy` aggregates rows by one or more columns. Each result row carries the
grouped columns plus the aggregate buckets you ask for: `_count`, `_sum`,
`_avg`, `_min`, `_max`. `_count._all` is `COUNT(*)`; per-column counts go in
`_count.<col>`.

```ts
const byStatus = await db.order.groupBy({
  by:      ['status'],
  where:   { channel: 'web' },          // filter rows BEFORE grouping
  _count:  { _all: true },
  _sum:    { total: true },
  _avg:    { total: true },
  _min:    { total: true },
  _max:    { total: true },
  orderBy: { status: 'asc' },
});
// [{ status: 'paid', _count: { _all: 3 }, _sum: { total: 600 }, _avg: { total: 200 }, … }, …]
```

`having` filters the **groups** after aggregation. It accepts both Prisma's
field-first shape and the bucket-first shape — they mean the same thing:

```ts
having: { total: { _sum: { gte: 120 } } }   // field-first (Prisma)
having: { _sum: { total: { gte: 120 } } }   // bucket-first
```

### Distinct

`distinct` on `findMany` returns one row per distinct value-combination of the
listed columns; on `count` it counts those combinations.

```ts
await db.order.findMany({ distinct: ['status'] });    // one row per status
await db.order.count({ distinct: ['channel'] });      // how many distinct channels
```

See more — **[docs/QUERIES.md](/reference/queries#groupby--having)** for the full groupBy / having vocabulary and per-dialect emit.

---
