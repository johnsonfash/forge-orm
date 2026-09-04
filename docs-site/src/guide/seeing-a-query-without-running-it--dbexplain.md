---
title: "Seeing a query without running it — db.$explain()"
---

## Seeing a query without running it — `db.$explain()`

`.compile` (below) answers this for one op, but you have to know the op's
name and rebuild the call by hand. `$explain` takes the call site itself:

```ts
const r = await db.$explain((q) => q.User.findMany({ where: { age: { gt: 40 } } }));
console.log(r.toString());
```

```
User.findMany  →  users  [sqlite]

  SELECT "users"."id", "users"."name", "users"."age" FROM "users" WHERE "users"."age" > ?

  params: 40

  -- with values inlined (for reading, not for running):
  SELECT "users"."id", "users"."name", "users"."age" FROM "users" WHERE "users"."age" > 40
```

Nothing executed. `q` holds no session and reaches no driver, so an
`async` callback is safe. The zero-argument form — `db.$explain(() =>
db.User.findMany())` — also works, but only while the query is issued
synchronously; forge throws if a callback returned a promise and captured
nothing, because that query really ran.

Add `{ analyze: true }` for the database's own plan — the reason you
reach for this:

```ts
await db.$explain((q) => q.User.findMany({ where: { name: 'u7' } }), { analyze: true });
//   -- plan:
//   SCAN users          ← every row read; `name` has no index
```

**forge never emits `EXPLAIN ANALYZE`.** `EXPLAIN` plans a statement;
`EXPLAIN ANALYZE` runs it — which on `deleteMany` deletes the rows. An
API whose whole promise is "this does not run" must not delete data
because you asked for more detail. Explaining a `deleteMany` leaves every
row where it was.

See **[docs/EXPLAIN.md](/reference/explain)** for both callback forms, the
report shape, what it refuses and why, and the per-dialect table.
