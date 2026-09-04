---
title: "JSON path queries"
---

## JSON path queries

Read into nested JSON columns directly from `where`. Same scalar comparison
vocabulary as regular fields — `eq` / `ne` / `gt` / `gte` / `lt` / `lte` /
`contains` / `in` / `has`.

```ts
const Doc = model('docs', {
  id: f.id(),
  meta: f.json(),
});

// Dotted-path navigation.
await db.doc.findMany({
  where: { meta: { path: 'profile.age', gte: 18 } },
});

// Array indexing with [N] syntax.
await db.doc.findMany({
  where: { meta: { path: 'addresses[0].city', eq: 'Lagos' } },
});

// Substring search on the extracted value.
await db.doc.findMany({
  where: { meta: { path: 'bio', contains: 'engineer' } },
});

// Explicit array form (skips the dotted-path parser).
await db.doc.findMany({
  where: { meta: { path: ['tags', '0'], eq: 'urgent' } },
});

// Works on embedded objects too.
await db.user.findMany({
  where: { address: { path: 'city', eq: 'SF' } },
});
```

Works on `f.json()` / `f.embed()` / `f.embedMany()` / `f.stringArray()` /
`f.intArray()` fields. Non-JSON fields raise a clear error.

Per dialect:

| Dialect | Compiles to |
|---|---|
| Postgres | `(col->'a'->>'b')::numeric` (cast by operand type — string / numeric / boolean) |
| MySQL | `JSON_UNQUOTE(JSON_EXTRACT(col, '$.a.b'))` |
| SQLite | `json_extract(col, '$.a.b')` (JSON1 — built-in) |
| DuckDB | `json_extract(col, '$.a.b')` |
| MSSQL | `JSON_VALUE(col, '$.a.b')` |
| Mongo | dotted key: `{ 'meta.a.b': … }` |

**See also:** **[docs/JSON-PATH.md](/reference/json-path)** — per-dialect SQL emit, GIN/multi-valued/expression indexes, column ↔ JSON migration, full operator-by-dialect matrix, null-marker semantics, audit-log/webhook patterns, common bugs.

---
