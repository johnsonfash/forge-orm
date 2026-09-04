---
title: "Full-text search"
---

## Full-text search

Mark a text column `.searchable()`. When you create the tables, forge builds the
right full-text index for each database:

| Dialect  | What forge emits                                                                    |
| -------- | ----------------------------------------------------------------------------------- |
| Postgres | `CREATE INDEX … USING gin(to_tsvector('simple', col))`                              |
| MySQL    | `ALTER TABLE … ADD FULLTEXT(col)` (plus `WITH PARSER ngram` / `mecab` if requested) |
| SQLite   | `CREATE VIRTUAL TABLE <table>_fts USING fts5(...)` + insert/update/delete triggers  |
| DuckDB   | `PRAGMA create_fts_index(...)` (fts extension)                                      |
| Mongo    | `createIndex({ col: 'text' })`                                                      |
| MSSQL    | Manual — requires a full-text catalog (out-of-band). Schema field is kept.          |

Then query it with the `search` operator. The operator is portable; the
ranking and tokenisation behind it is whatever the dialect provides.

```ts
const Post = model('posts', {
  id:   f.id(),
  body: f.text().searchable(),
});

await db.post.findMany({ where: { body: { search: 'database wrapper' } } });
```

On SQLite, queries through the shadow FTS5 table are joined automatically —
you don't have to know it exists. On Postgres, the index is over
`to_tsvector('simple', col)`; you can pass a custom configuration via a raw
`expression:` index for language-specific stemming.

See more — **[docs/FTS.md](/reference/fts)** for every dialect's FTS engine, ranking score retrieval, multi-column composition, languages and analyzers, hybrid BM25 + vector (RRF), highlighting, and six worked patterns.

---
