# 09 · Vector similarity (RAG storage layer)

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/09-vector-rag)

The storage + retrieval half of a RAG pipeline. Same query targets `pgvector`, MySQL VECTOR, sqlite-vec, DuckDB vss (HNSW), MSSQL VECTOR, and Mongo Atlas Vector Search.

## Highlights

- `f.vector(1536, { metric: "cosine" })` — typed embedding column
- `nearTo: { vector, topK }` — top-K similarity in one call
- Mock embedder in the example; swap in OpenAI/Cohere/local model in prod

## Patterns shown

- **Index-by-text** — upsert ensures dedup on content
- **Sort by relevance** — `findMany` returns ordered results
- **One operator** — no provider-specific SQL leaks into app code
