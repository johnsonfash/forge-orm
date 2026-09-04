---
title: "Dropping to raw queries with .compile"
---

## Dropping to raw queries with `.compile`

If you need the exact query forge would run, ask for it instead of running it.
You get the Mongo arguments object or the SQL string with its parameters, ready
to hand to the driver yourself.

```ts
const q = db.user.compile.findMany({ where: { active: true }, take: 20 });
// SQL:   { sql: 'SELECT … WHERE "active" = $1 LIMIT 20', params: [true] }
// Mongo: { collection: 'users', op: 'find', args: { filter: { active: true }, options: { limit: 20 } } }
```

Every runtime method on `db.<model>` is on `.compile` too, including
`softDelete` / `softDeleteMany` / `restore` / `restoreMany`. The compile
variant throws synchronously if the model has no `.softDeleteAt()` field
instead of waiting for the runtime check:

```ts
const c = db.account.compile.softDelete({ where: { id: 'a1' } });
// SQL: UPDATE accounts SET deleted_at = $1 WHERE id = $2 …
```

`compile` returns a `MongoArtifact` on Mongo and a `SQLArtifact` with the
matching `dialect` on Postgres / MySQL / SQLite / DuckDB / MSSQL. If you want
a statically narrowed surface, use `.compileMongo` or `.compileSql`; both
throw at access on the wrong adapter.

---
