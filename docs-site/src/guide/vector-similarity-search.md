---
title: "Vector similarity search"
---

## Vector similarity search

Embedding fields with native vector indexes per dialect, queried with the
same `near` / `nearTo` vocabulary as geo.

```ts
const Doc = model('docs', {
  id: f.id(),
  body: f.text(),
  // Match the dims to your embedding model
  // (OpenAI text-embedding-3-small = 1536; Cohere embed-v3 = 1024; etc.).
  embedding: f.vector(1536, { metric: 'cosine' }),
}, {
  indexes: [{ keys: { embedding: 1 }, method: 'vector' }],
});

await db.doc.create({
  data: { id: 'a', body: 'cat', embedding: await embedText('cat') },
});

// "Top-10 most semantically similar documents to my query vector,
//  within 0.4 cosine distance."
const matches = await db.doc.findMany({
  where:   { embedding: { near: { vector: queryVec, withinDistance: 0.4 } } },
  orderBy: { embedding: { nearTo: queryVec } },
  take: 10,
});
// matches[0]._distance ≈ 0  (cosine distance to the search vector)
```

Metrics — match to your embedding model's docs:

| Metric             | When                                                                |
| ------------------ | ------------------------------------------------------------------- |
| `'cosine'` (default) | Most text embedding models (OpenAI, Voyage, Cohere)                |
| `'l2'`             | Image embeddings (CLIP), some classical models                      |
| `'dot'`            | Normalized vectors where you want max speed                         |

Per dialect:

| Dialect | Column | Vector index | Query operator |
|---|---|---|---|
| Postgres | `vector(N)` (pgvector) | `USING hnsw (col vector_cosine_ops)` | `col <=> $vec` / `<->` / `<#>` |
| MySQL 9 | `VECTOR(N)` | community = exact only | `DISTANCE(col, STRING_TO_VECTOR(...), 'COSINE')` |
| SQLite | `TEXT` (JSON) | needs `sqlite-vec` vec0 vtab (out-of-band) | brute-force or vec0 |
| DuckDB | `FLOAT[N]` | `USING HNSW` (vss extension) | `array_cosine_distance(col, [...])` |
| MSSQL | `VECTOR(N)` | `USING VECTOR WITH (algorithm = 'HNSW')` | `VECTOR_DISTANCE('cosine', col, ...)` |
| Mongo | plain array | Atlas Search Index (`createSearchIndex`) | `$vectorSearch` (auto-routed) |

**Dimension validation**: `f.vector(1536)` rejects a 1024-dim query vector
at IR build time — catches embedding-model mismatches before they hit the
DB.

**Required setup** per dialect:

- **Postgres** — `CREATE EXTENSION vector;` (pgvector — available on every
  managed PG host: Supabase, Neon, RDS, Crunchy, …).
- **DuckDB** — `INSTALL vss; LOAD vss;` (load explicitly after connect;
  `spatial` auto-loads, `vss` is one extra `connection.run`).
- **SQLite** — install `sqlite-vec` extension; the `vec0` mirror table is
  created out-of-band (forge doesn't manage it). Use brute-force JSON
  scanning for small datasets.
- **MySQL** — built-in since 9.0. HeatWave Vector Store (Oracle Cloud)
  adds HNSW/IVF; community edition is exact-only.
- **MSSQL** — built-in in SQL Server 2025 / Azure SQL Database.
- **Mongo** — Atlas Vector Search (Atlas-only, not on-prem or community).
  Create the search index via the Atlas UI / CLI.

When the dialect can't host a regular vector index (Mongo, SQLite), the
`method: 'vector'` index emission warns clearly instead of silently
emitting a useless btree.

**See also:** **[docs/VECTOR.md](/reference/vector)** — dialect picker (pgvector / sqlite-vec / Atlas / HeatWave / DuckDB), end-to-end RAG pipeline, hybrid BM25 + vector with RRF, embedding versioning, HNSW/IVFFlat tuning, halfvec/binary quantization, CLIP multi-modal, MRR/nDCG CI gates, cost model.

---
