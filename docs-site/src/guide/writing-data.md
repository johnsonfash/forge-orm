---
title: "Writing data"
---

## Writing data

```ts
await db.user.create({ data: { email: 'a@x.co', name: 'A' } });   // id auto-generated

await db.user.createMany({ data: [ /* … */ ] });

await db.user.update({ where: { id: 'u1' }, data: { name: 'A2' } });

await db.user.updateMany({ where: { active: false }, data: { active: true } });

// update if found, otherwise create
await db.user.upsert({
  where:  { email: 'a@x.co' },
  create: { email: 'a@x.co', name: 'A' },
  update: { name: 'A' },
});

await db.user.delete({ where: { id: 'u1' } });
await db.user.deleteMany({ where: { active: false } });
```

Create and update can also return only selected fields or include relations,
the same way reads do, by passing `select` or `include` alongside `data`.

### Atomic number ops

For number columns you can apply an operation instead of setting a value
outright. All four are compiled to a single atomic write per dialect.

```ts
await db.post.update({
  where: { id: 'p1' },
  data: {
    views:      { increment: 1 },    // also: decrement, multiply, divide, set
    score:      { multiply: 2 },
    rank:       { divide: 2 },
    high_score: { max: 9001 },       // clamp: write only if higher (2.18)
    floor:      { min: 3 },          // clamp: write only if lower (2.18)
    tags:       { push: 'urgent' },  // list columns: push / addToSet / pull
    published:  true,
  },
});
```

`max` and `min` clamp in place — "record this if it is the best so far"
without a read-compare-write. The list ops work on `f.stringArray()` and
`f.intArray()`; `addToSet` and `pull` are **not available on SQLite or
MSSQL, and `pull` is not on MySQL**, because those dialects store these
columns as JSON and JSON has no portable value-based remove. An
unsupported combination throws, naming the dialect. Full matrix in
[docs/MUTATIONS.md](/reference/mutations#list-column-ops--push-addtoset-pull).

Pair an atomic op with `col()` in `where` for a single-statement, race-safe
guard (see [Comparing two columns](/guide/reading-data#comparing-two-columns-col)).

`divide` is an exact division since 2.18 — it used to be rewritten as
`multiply: 1 / n`, which drifted on a `decimal` money column and rounded an
`int`. Every SQL dialect now emits `col = col / $n`; Mongo needs an
aggregation-pipeline update (4.2+) to get a real `$divide`, which means a
`divide` cannot be combined with `upsert` there — that combination throws
with instructions to split it. See
[docs/MUTATIONS.md](/reference/mutations#divide-is-an-exact-division-2180).

Operator objects are validated against the column (since 2.7): a typo like
`{ incrment: 5 }`, a numeric op on a string column, or two ops in one
object (`{ set: 1, increment: 2 }`) throws instead of silently writing the
object into the field.

For an atomic **seeded counter**, upsert with an increment — insert applies
`create` only, update applies `update` only (Prisma semantics, race-safe):

```ts
const row = await db.counter.upsert({
  where:  { key: 'invoice-number' },
  create: { key: 'invoice-number', seq: 1000 },   // first call → 1000
  update: { seq: { increment: 1 } },              // later calls → 1001, 1002, …
});
```

### Writing related records in one call

When you create or update a row you can act on its relations at the same time:

```ts
await db.user.create({
  data: {
    email: 'a@x.co', name: 'A',
    posts: {
      create: { title: 'Hello' },     // create a new related post
      connect: { id: 'p2' },          // attach an existing one
    },
  },
});
```

Supported on a relation: `create`, `createMany`, `connect`, `connectOrCreate`
(find one or make it), `disconnect`, `set`, `delete`, `deleteMany`, `update`,
`updateMany`, `upsert`.

### Deletes and cascades

If a relation declares `onDelete: 'Cascade'`, deleting the parent deletes the
children too. On SQL this is enforced by a foreign key. On Mongo, which has no
foreign keys, forge walks the relations and deletes the children for you.

```ts
await db.user.delete({ where: { id: 'u1' } });   // posts with onDelete:'Cascade' go too
```

See more — **[docs/MUTATIONS.md](/reference/mutations)** for create/update/upsert/delete asymmetry, atomic ops, nested writes, batched throughput, and eight worked patterns. **[docs/UPSERT.md](/reference/upsert)** for per-dialect emit (`ON CONFLICT` / `ON DUPLICATE KEY` / `MERGE` / `findOneAndUpdate`) and race semantics. **[docs/BATCH.md](/reference/batch)** for `createMany`/`updateMany`/`deleteMany`, bind-parameter limits, chunking. **[docs/LOCKING.md](/reference/locking)** for SELECT FOR UPDATE / advisory locks / SKIP LOCKED work queues. **[docs/CONCURRENCY.md](/reference/concurrency)** for optimistic vs pessimistic control and ETag/If-Match patterns. **[docs/IDEMPOTENCY.md](/reference/idempotency)** for the Stripe-style Idempotency-Key model.

---
