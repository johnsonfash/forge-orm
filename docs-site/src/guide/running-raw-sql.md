---
title: "Running raw SQL"
---

## Running raw SQL

When you need SQL forge does not express, use the tagged template. Values become
bound parameters, never string-interpolated, so it is safe against injection.

```ts
const rows = await db.$queryRaw`SELECT * FROM users WHERE email = ${email}`;
const affected = await db.$executeRaw`UPDATE users SET active = false WHERE last_seen < ${cutoff}`;
```

This is SQL only. On Mongo, use `db.<model>.aggregate({ pipeline })` instead.

See more — **[docs/RAW-SQL.md](/reference/raw-sql)** for `forgeSql` composition, identifier-vs-value safety, per-dialect placeholder styles, `$runCommandRaw`, raw inside `$transaction`, and per-dialect worked patterns (PG `WITH RECURSIVE`, MySQL FULLTEXT, DuckDB Parquet, Mongo `$graphLookup`).

---
