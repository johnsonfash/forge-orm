# Vector similarity search, embeddings, RAG

The README's **[Vector similarity search](../README.md#vector-similarity-search)**
chapter covers the API surface: `f.vector(N, { metric })`, the `near` filter,
the `nearTo` orderBy, the per-dialect column types and operators, the
dimension-check at IR build time. Read it first.

This doc is the long-form companion. It picks a dialect, walks a complete RAG
pipeline (chunk → embed → store → retrieve → rerank → prompt), shows hybrid
BM25 + vector search through forge's `.searchable()` and `nearTo`, covers
embedding versioning when you swap models, tunes HNSW / IVFFlat indexes,
explains halfvec / binary quantization, stores CLIP image vectors next to
text, batches embeddings at scale, and bolts on MRR / nDCG regression tests
that fail CI when recall drops. Numbers are from public benchmarks; treat
them as orientation, not promises for your workload.

## Contents

* [Picking a dialect](#picking-a-dialect)
* [End-to-end RAG with Postgres + pgvector](#end-to-end-rag-with-postgres--pgvector)
* [Hybrid search — BM25 + vector with RRF](#hybrid-search--bm25--vector-with-rrf)
* [Embedding versioning](#embedding-versioning)
* [Index tuning — HNSW and IVFFlat](#index-tuning--hnsw-and-ivfflat)
* [Quantization — halfvec and binary](#quantization--halfvec-and-binary)
* [Multi-modal vectors — text + CLIP](#multi-modal-vectors--text--clip)
* [Streaming insertion at scale](#streaming-insertion-at-scale)
* [Eval and guardrails — MRR, nDCG, embedding cache](#eval-and-guardrails--mrr-ndcg-embedding-cache)
* [Cost model](#cost-model)

---

## Picking a dialect

The same `f.vector(N)` schema works against six engines, but the runtime
behaviour at 100k / 1M / 10M vectors is not the same. Pick by corpus size,
recall target, and where the rest of your data already lives.

| Engine | Index | 100k p95 | 1M p95 | 10M p95 | Recall @ 10 | Write tput | Cost shape |
|---|---|---|---|---|---|---|---|
| pgvector (HNSW) | `USING hnsw (col vector_cosine_ops)` | 3-8 ms | 8-20 ms | 30-80 ms | 0.97-0.99 | 5-10k rows/s | Whatever your PG host charges. Pure storage + CPU. |
| pgvector (IVFFlat) | `USING ivfflat (col vector_cosine_ops) WITH (lists = N)` | 5-15 ms | 15-40 ms | 60-150 ms | 0.90-0.96 (probes=10) | 8-15k rows/s | Same. IVFFlat is half the build time of HNSW. |
| sqlite-vec (vec0) | `CREATE VIRTUAL TABLE … USING vec0(...)` | 2-6 ms | 20-60 ms | not viable | brute-force = 1.0, ANN = 0.95-0.98 | 20-40k rows/s | Local file. Zero infra cost. |
| MongoDB Atlas Vector Search | `createSearchIndex({ type: 'vectorSearch' })` | 10-30 ms | 20-60 ms | 50-150 ms | 0.95-0.98 | 3-8k rows/s | Atlas-only. Search nodes priced per RAM hour. |
| MySQL HeatWave Vector | `SECONDARY_ENGINE = RAPID` | 4-10 ms | 10-25 ms | 40-100 ms | 0.96-0.99 | 5-10k rows/s | OCI HeatWave SKU. Community MySQL = exact only. |
| DuckDB (vss) | `USING HNSW` | 2-5 ms | 8-15 ms | 30-60 ms | 0.96-0.99 | 30-60k rows/s | Local / in-process. Cost = the box it runs on. |
| MSSQL 2025 / Azure SQL | `USING VECTOR WITH (algorithm = 'HNSW')` | 5-12 ms | 15-30 ms | 50-120 ms | 0.96-0.99 | 6-12k rows/s | Azure SQL Hyperscale or 2025 license. |

Decision shortcuts:

- **You already run Postgres.** Stop reading the table. pgvector with HNSW
  is the default. Supabase, Neon, RDS, Crunchy, Aiven all ship it.
- **App-local search (offline, edge, browser).** sqlite-vec via forge's
  wasm adapter ([Browser (sqlite-wasm + OPFS)](../README.md#browser-sqlite-wasm--opfs)).
  Holds up to a few hundred thousand vectors per tab. Beyond that, route to
  a server.
- **Operational data is already in Mongo.** Atlas Vector Search keeps the
  vector next to the document, no second store. forge auto-routes the
  `near` filter to `$vectorSearch`. Off-Atlas Mongo has no native ANN —
  brute-force or move the embeddings out.
- **Analytical / OLAP workload.** DuckDB with the `vss` extension. Great
  if the embeddings are part of an analytics pipeline (parquet ingest,
  windowed aggregates, embedding-as-feature). Not a serving DB.
- **Microsoft stack.** SQL Server 2025 ships HNSW natively. Don't add a
  separate vector DB if the data is already there.

The rule of thumb for "do I need ANN?" is **brute-force is fine up to
roughly 10k vectors at 1536 dim**. Below that, every dialect runs a linear
scan at sub-50 ms and recall is exactly 1.0. ANN starts paying off around
100k.

---

## End-to-end RAG with Postgres + pgvector

The pipeline below is the one you'd put behind a `/chat` endpoint. It
ingests documents, embeds with OpenAI's `text-embedding-3-small`, stores
through forge, retrieves with `nearTo`, re-ranks with a local
cross-encoder, and composes the prompt. All five steps fit in one file.

```ts
// rag.ts
import { createDb, f, model, postgresDriver } from 'forge-orm';

// 1) Schema. The dims must match the embedding model exactly —
//    f.vector(1536) throws an IR error if you hand it a 1024-vector.
const Chunk = model('chunks', {
  id:         f.id(),
  doc_id:     f.string(),
  ord:        f.int(),
  body:       f.text().searchable(),    // also indexed for BM25 / FTS hybrid
  token_count: f.int(),
  embedding:  f.vector(1536, { metric: 'cosine' }),
  model_id:   f.string().default('openai/text-embedding-3-small'),
  created_at: f.dateTime().default('now'),
}, {
  indexes: [
    { keys: { embedding: 1 }, method: 'vector',
      // pgvector HNSW knobs — see "Index tuning" below.
      options: { m: 16, ef_construction: 64 } },
    { keys: { doc_id: 1, ord: 1 } },
  ],
});

export const db = createDb({
  driver: postgresDriver(process.env.PG_URL!),
  schema: { chunk: Chunk },
});

// 2) Chunking. Two strategies — token windows for prose, paragraph splits
//    for structured docs. The token-window version is the safer default.
function chunkByTokens(text: string, target = 400, overlap = 50): string[] {
  // Approximate: 1 token ~= 4 chars for English. Replace with tiktoken
  // for production. The overlap stitches context across chunk boundaries
  // so a sentence split mid-thought is still findable.
  const charSize = target * 4;
  const charOverlap = overlap * 4;
  const out: string[] = [];
  for (let i = 0; i < text.length; i += charSize - charOverlap) {
    out.push(text.slice(i, i + charSize));
  }
  return out;
}

function chunkByParagraph(text: string, maxChars = 1600): string[] {
  // Better for markdown / structured prose. Falls back to token splits
  // when a paragraph blows past `maxChars` (long code blocks, tables).
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of paras) {
    if (p.length <= maxChars) { out.push(p); continue; }
    out.push(...chunkByTokens(p, 400, 50));
  }
  return out;
}

// 3) Embedding. One function, three providers. Pick at runtime so you can
//    A/B them on the same corpus.
type EmbeddingProvider = 'openai' | 'voyage' | 'local';

async function embed(texts: string[], provider: EmbeddingProvider): Promise<number[][]> {
  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
    const json = await res.json() as { data: { embedding: number[] }[] };
    return json.data.map((d) => d.embedding);
  }
  if (provider === 'voyage') {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'voyage-3', input: texts, input_type: 'document' }),
    });
    const json = await res.json() as { data: { embedding: number[] }[] };
    return json.data.map((d) => d.embedding);
  }
  // Local: @xenova/transformers running in-process. ~10x slower than
  // hosted, but no per-token bill and no network hop. Use for offline,
  // cost-sensitive, or PII-restricted workloads.
  const { pipeline } = await import('@xenova/transformers');
  const pipe = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5');
  const out: number[][] = [];
  for (const t of texts) {
    const tensor = await pipe(t, { pooling: 'mean', normalize: true });
    out.push(Array.from(tensor.data as Float32Array));
  }
  return out;
}

// 4) Ingest. Embed in batches of 100 (OpenAI's per-request limit is 2048
//    inputs but smaller batches give better cost-recall tracking).
export async function ingest(docId: string, text: string) {
  const chunks = chunkByParagraph(text);
  const batchSize = 100;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const slice = chunks.slice(i, i + batchSize);
    const vectors = await embed(slice, 'openai');
    await db.chunk.createMany({
      data: slice.map((body, j) => ({
        doc_id: docId,
        ord: i + j,
        body,
        token_count: Math.ceil(body.length / 4),
        embedding: vectors[j],
        model_id: 'openai/text-embedding-3-small',
      })),
    });
  }
}

// 5) Retrieve. `near` does the filter (only return rows within 0.4 cosine
//    distance), `nearTo` does the sort. forge attaches `_distance` to
//    every row in the result.
export async function retrieve(query: string, k = 20) {
  const [qVec] = await embed([query], 'openai');
  return db.chunk.findMany({
    where:   { embedding: { near: { vector: qVec, withinDistance: 0.4 } } },
    orderBy: { embedding: { nearTo: qVec } },
    take: k,
  });
}

// 6) Re-rank with a cross-encoder. Bi-encoders (the embedding model) score
//    query and doc independently; cross-encoders score the pair jointly,
//    so they're 10-30 points more accurate at the top of the list. Use
//    them only on the top-k retrieved set — they're 50-100x slower.
async function rerank(query: string, candidates: { id: string; body: string }[]) {
  const { pipeline } = await import('@xenova/transformers');
  const ce = await pipeline('text-classification', 'Xenova/bge-reranker-base');
  const scored = await Promise.all(candidates.map(async (c) => {
    const out = await ce(`${query} [SEP] ${c.body}`) as { score: number }[];
    return { ...c, score: out[0].score };
  }));
  return scored.sort((a, b) => b.score - a.score);
}

// 7) Compose. Retrieve 20, rerank to top-5, stuff a prompt.
export async function answer(query: string) {
  const raw = await retrieve(query, 20);
  const reranked = await rerank(query, raw);
  const context = reranked.slice(0, 5).map((c, i) => `[${i + 1}] ${c.body}`).join('\n\n');
  return {
    prompt: `Answer using the sources below. Cite as [N].\n\n${context}\n\nQ: ${query}\nA:`,
    sources: reranked.slice(0, 5),
  };
}
```

A few things this skips that production needs:

- **Retry / rate-limit.** OpenAI returns 429s under load. Wrap `embed`
  with an exponential-backoff retry; don't bury that in the ingest loop.
- **Idempotency.** `ingest()` re-embeds every call. The cache pattern in
  [Eval and guardrails](#eval-and-guardrails--mrr-ndcg-embedding-cache)
  fixes that — content-hash key, skip if already embedded.
- **Deletion.** Re-ingesting a document needs a `db.chunk.deleteMany({ where: { doc_id } })`
  upfront, otherwise you stack duplicate chunks every run.

---

## Hybrid search — BM25 + vector with RRF

Pure vector search misses exact-match queries — model numbers, rare tokens,
acronyms. Pure BM25 misses paraphrase — "how do I refund a charge" vs
"reverse a payment". Reciprocal Rank Fusion (RRF) takes the rank from each
search and adds `1 / (k + rank)`, then re-sorts. `k = 60` is the canonical
constant from the original Cormack paper; it's robust across corpora.

Postgres version. `f.text().searchable()` already gives a tsvector column
and a GIN index — see [Full-text search](../README.md#full-text-search).

```ts
async function hybrid(query: string, limit = 20) {
  const [qVec] = await embed([query], 'openai');

  // Lane A — semantic. forge handles this end-to-end.
  const semantic = await db.chunk.findMany({
    orderBy: { embedding: { nearTo: qVec } },
    take: 50,
  });

  // Lane B — lexical. websearch_to_tsquery handles "phrase queries" and
  // -negation naturally. The .searchable() column is `body_tsv` by default.
  const lexical = await db.$queryRaw<{ id: string; rank: number }[]>`
    SELECT id, ts_rank(body_tsv, websearch_to_tsquery('english', ${query})) AS rank
    FROM chunks
    WHERE body_tsv @@ websearch_to_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT 50
  `;

  // RRF — collapse two ranked lists into one. k=60 is the standard.
  const k = 60;
  const score = new Map<string, number>();
  semantic.forEach((r, i) => score.set(r.id, (score.get(r.id) ?? 0) + 1 / (k + i)));
  lexical.forEach((r, i) => score.set(r.id, (score.get(r.id) ?? 0) + 1 / (k + i)));

  const ids = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
  // Hydrate. `in` preserves no order — re-sort with the ids array.
  const rows = await db.chunk.findMany({ where: { id: { in: ids } } });
  return ids.map((id) => rows.find((r) => r.id === id)!).filter(Boolean);
}
```

SQLite version. Pair fts5 (forge's `.searchable()` on sqlite) with
`sqlite-vec`. Same RRF code path on top.

```ts
async function hybridSqlite(query: string, limit = 20) {
  const [qVec] = await embed([query], 'openai');

  // Lane A — sqlite-vec ANN. The `embedding_vec` mirror table is created
  // out-of-band when sqlite-vec is installed; forge writes into it via
  // the trigger pattern described in the README's vector chapter.
  const semantic = await db.$queryRaw<{ id: string; dist: number }[]>`
    SELECT chunks.id AS id, v.distance AS dist
    FROM embedding_vec v
    JOIN chunks ON chunks.id = v.rowid
    WHERE v.embedding MATCH ${JSON.stringify(qVec)}
    ORDER BY v.distance
    LIMIT 50
  `;

  // Lane B — fts5. `chunks_fts` is the contentless mirror forge generates
  // for .searchable() columns on sqlite.
  const lexical = await db.$queryRaw<{ id: string; rank: number }[]>`
    SELECT chunks.id AS id, bm25(chunks_fts) AS rank
    FROM chunks_fts
    JOIN chunks ON chunks.id = chunks_fts.rowid
    WHERE chunks_fts MATCH ${query}
    ORDER BY rank
    LIMIT 50
  `;

  const k = 60;
  const score = new Map<string, number>();
  semantic.forEach((r, i) => score.set(r.id, (score.get(r.id) ?? 0) + 1 / (k + i)));
  lexical.forEach((r, i) => score.set(r.id, (score.get(r.id) ?? 0) + 1 / (k + i)));

  const ids = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
  const rows = await db.chunk.findMany({ where: { id: { in: ids } } });
  return ids.map((id) => rows.find((r) => r.id === id)!).filter(Boolean);
}
```

Typical lift over pure vector: +6 to +12 nDCG@10 on technical corpora
(docs, code), +2 to +4 on conversational. The wins are concentrated on
queries containing identifiers — SKUs, error codes, function names.

---

## Embedding versioning

You will swap models. `text-embedding-3-small` was the answer in 2024;
a year later there's something cheaper, faster, or 4 points more accurate.
Two designs for handling that without a flag-day re-embed.

**Single table, model id column.** The pattern the RAG example above
already uses. Every row records which model produced its vector. Queries
filter by `model_id` before the `nearTo` so you never mix bi-encoders.

```ts
const Chunk = model('chunks', {
  id:         f.id(),
  body:       f.text(),
  // Same column holds vectors from many models — but the dims have to
  // match the widest, and you waste storage on narrower ones. Use a
  // separate column per model if dims differ significantly.
  embedding:  f.vector(1536, { metric: 'cosine' }),
  model_id:   f.string(),
}, {
  indexes: [
    // Partial-filter HNSW: one index per model. The `where` clause
    // (forge spells it `partialFilterExpression`) is critical — without
    // it, the index mixes vectors from incompatible spaces.
    { keys: { embedding: 1 }, method: 'vector', name: 'idx_emb_v3small',
      partialFilterExpression: { model_id: 'openai/text-embedding-3-small' } },
    { keys: { embedding: 1 }, method: 'vector', name: 'idx_emb_cohere_v3',
      partialFilterExpression: { model_id: 'cohere/embed-english-v3' } },
  ],
});

// Retrieval — pin the model.
await db.chunk.findMany({
  where: {
    model_id: 'openai/text-embedding-3-small',
    embedding: { near: { vector: qVec, withinDistance: 0.4 } },
  },
  orderBy: { embedding: { nearTo: qVec } },
  take: 10,
});
```

**Two columns when dims differ.** Cohere embed-v3 is 1024-dim,
text-embedding-3-small is 1536-dim. Storing both in one `f.vector(1536)`
column pads or rejects. Use two columns.

```ts
const Chunk = model('chunks', {
  id:        f.id(),
  body:      f.text(),
  emb_1536:  f.vector(1536, { metric: 'cosine' }).optional(),
  emb_1024:  f.vector(1024, { metric: 'cosine' }).optional(),
}, {
  indexes: [
    { keys: { emb_1536: 1 }, method: 'vector' },
    { keys: { emb_1024: 1 }, method: 'vector' },
  ],
});
```

**Migration plan when you swap.**

1. Add the new column (`emb_1024`) as `.optional()`. Existing rows are
   `NULL`, no rewrite.
2. Backfill in batches — a worker reads `where: { emb_1024: null }`,
   embeds, updates. Throttle by `take: 1000` to avoid OOM on the API
   rate-limit window.
3. Dual-read for a week. Compare hit-rates between the two columns on a
   labelled eval set. If new beats old by your threshold (typically
   +1 nDCG@10), cut over.
4. Drop the old column with a separate migration. Keep it around for at
   least one release cycle — rollback is "switch the column name in one
   place" if you keep both.

Cost of carrying both: storage doubles, write tput halves (two embed
calls per chunk). Cheap insurance for a week.

---

## Index tuning — HNSW and IVFFlat

The two ANN index families on pgvector have different knobs and different
tradeoffs. Picking the wrong defaults is the most common cause of
"my-vector-search-is-slow" tickets.

**HNSW.** Hierarchical Navigable Small World. Graph index. Build is
expensive, query is fast, recall is high. Two parameters:

- `m` — neighbors per node. Default 16. Larger = better recall, more
  memory, slower build. Set 24-32 for high-recall regimes (>0.99). Below
  16 falls apart.
- `ef_construction` — candidate list size at build. Default 64. Larger
  = better graph quality, slower build. 128 is a sane "I want recall but
  not at any cost" setting.
- `ef_search` (runtime) — `SET hnsw.ef_search = 100;`. Default 40.
  Larger = better recall at query time, slower. Tune per query.

```ts
const Chunk = model('chunks', {
  id: f.id(),
  embedding: f.vector(1536, { metric: 'cosine' }),
}, {
  indexes: [
    { keys: { embedding: 1 }, method: 'vector',
      options: { m: 16, ef_construction: 64 } },
  ],
});

// At query time, push ef_search up for high-recall paths.
await db.$queryRaw`SET LOCAL hnsw.ef_search = 100`;
const top = await db.chunk.findMany({
  orderBy: { embedding: { nearTo: qVec } },
  take: 50,
});
```

Memory budget for HNSW: roughly `(dims * 4 + m * 8) * rows` bytes per
index. At 1M rows / 1536 dim / m=16, that's ~6 GB. Plan accordingly.

**IVFFlat.** Inverted-file with flat lists. Cheap to build, smaller in
memory, lower recall ceiling, but the `probes` knob lets you trade quality
for latency live.

- `lists` — number of clusters. **Rule of thumb: `sqrt(N)` for under 1M,
  `N / 1000` for over 1M.** 100k rows ≈ 316 lists. 10M rows ≈ 10000.
- `probes` (runtime) — how many lists to scan per query. Default 1
  (recall ~0.7-0.8). Bump to 10 for recall ~0.95, 20 for ~0.98.

```ts
indexes: [
  { keys: { embedding: 1 }, method: 'vector',
    options: { lists: 316 } },  // 100k rows
];

await db.$queryRaw`SET LOCAL ivfflat.probes = 10`;
```

**HNSW vs IVFFlat.** HNSW wins on recall-latency frontier almost always.
IVFFlat wins when (a) you ingest faster than you query — build is half
HNSW's, and (b) memory is tight — IVFFlat indexes are ~30% smaller.

**sqlite-vec.** ANN support is recent and partial. `vec0` brute-forces
under ~50k rows comfortably. Above that, partition by metadata
(`tenant_id`, `lang`, time window) to keep each shard small. There's no
HNSW yet; if you need it on sqlite, you need to live with brute-force on
the recent slice and offload cold data to a server.

**Brute-force fallback path.** Even with an index, you sometimes want to
guarantee recall = 1.0 — eval runs, regression suites, "what did we
actually retrieve" debugging. Forge gives you the escape hatch through
`$queryRaw`:

```ts
const exact = await db.$queryRaw<{ id: string; dist: number }[]>`
  SELECT id, embedding <=> ${qVec}::vector AS dist
  FROM chunks
  ORDER BY dist
  LIMIT 10
`;
// pgvector picks the seq-scan path when ORDER BY uses the operator
// without the index being eligible — no hint required.
```

---

## Quantization — halfvec and binary

pgvector 0.7 added `halfvec` (fp16, 2 bytes per dim) and `bit` (1 bit per
dim) variants. Storage drops 2x and 32x respectively. Recall drops too.

**halfvec.** Safe on most text embeddings. Recall loss is in the noise —
typically <0.5 points on nDCG@10. Storage halves; index build is 30-40%
faster.

```ts
const Chunk = model('chunks', {
  id:        f.id(),
  embedding: f.vector(1536, { metric: 'cosine', precision: 'half' }),
}, {
  indexes: [{ keys: { embedding: 1 }, method: 'vector' }],
});
```

Forge emits `halfvec(1536)` for Postgres when `precision: 'half'` is set
and falls back to `vector(N)` on dialects that don't support it. The
`near` / `nearTo` API is identical.

**Binary.** Cosine collapses to Hamming distance on a binary vector,
which is a single XOR + popcount per pair. 100x faster scans, 32x smaller.
Recall loss is significant — 3-10 nDCG@10 points depending on the
embedding model. Use as a coarse filter, not as the final answer:

```ts
// Two-stage: binary recall N=1000 candidates, then fp16 rerank N=10.
const candidates = await db.$queryRaw<{ id: string }[]>`
  SELECT id
  FROM chunks
  ORDER BY embedding_bit <~> ${toBinary(qVec)}::bit(1536)
  LIMIT 1000
`;

const ids = candidates.map((c) => c.id);
const rerank = await db.chunk.findMany({
  where: { id: { in: ids } },
  orderBy: { embedding: { nearTo: qVec } },   // fp16 / fp32 column
  take: 10,
});
```

The binary column is a separate `f.string()` (forge stores `bit(N)` via
the raw column escape hatch) — there's no first-class `f.binaryVector()`
yet. Track this with a content-hash so you only rebuild when the source
vector changes.

Rule: **don't run a halfvec experiment on the production index without
an A/B comparison on your eval set.** Most loss numbers in the
pgvector docs are MS MARCO; your corpus probably isn't.

---

## Multi-modal vectors — text + CLIP

CLIP image embeddings are 512-dim (`openai/clip-vit-base-patch32`) or
768-dim (`openai/clip-vit-large-patch14`). Different model, different
space; you can't `nearTo` a CLIP vector against a text-embedding-3 vector
and get sensible results. Two designs.

**Polymorphic table.** Text and image rows in one model, separate columns
per modality, a `modality` enum to discriminate.

```ts
const Asset = model('assets', {
  id:          f.id(),
  modality:    f.string(),       // 'text' | 'image'
  caption:     f.text().searchable(),
  image_url:   f.string().optional(),
  text_emb:    f.vector(1536, { metric: 'cosine' }).optional(),
  image_emb:   f.vector(768, { metric: 'cosine' }).optional(),
}, {
  indexes: [
    { keys: { text_emb: 1 },  method: 'vector',
      partialFilterExpression: { modality: 'text' } },
    { keys: { image_emb: 1 }, method: 'vector',
      partialFilterExpression: { modality: 'image' } },
  ],
});
```

The partial-filter pattern keeps the index dense — without it, every text
row carries a NULL slot in the image index and vice versa.

**Cross-modal retrieval.** CLIP places text and image in the same space
when both are encoded by CLIP's encoders (not the OpenAI text embedding
model). For "find images matching this query":

```ts
async function imageSearch(query: string) {
  // Use CLIP's text encoder, not text-embedding-3.
  const { pipeline } = await import('@xenova/transformers');
  const txtEnc = await pipeline('feature-extraction', 'Xenova/clip-vit-base-patch32');
  const tensor = await txtEnc(query, { pooling: 'mean', normalize: true });
  const qVec = Array.from(tensor.data as Float32Array);

  return db.asset.findMany({
    where: {
      modality: 'image',
      image_emb: { near: { vector: qVec, withinDistance: 0.5 } },
    },
    orderBy: { image_emb: { nearTo: qVec } },
    take: 20,
  });
}
```

Cosine threshold for CLIP runs warmer than text embeddings — 0.5 ≈ "loosely
related" where 0.5 on text-embedding-3 would be near-noise. Calibrate
per model on a labelled set.

---

## Streaming insertion at scale

A million chunks at 1536 dim is ~6 GB raw, ~12 GB after the HNSW index.
You don't insert that with a `for` loop. Two patterns.

**Batched createMany with parallelised embedding.** The embedding API
call is the bottleneck — not the database insert. Pipeline them.

```ts
async function bulkIngest(rows: { doc_id: string; body: string }[]) {
  const batchSize = 100;
  const concurrency = 8;
  const queue = [...rows];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const batch = queue.splice(0, batchSize);
      const vectors = await embed(batch.map((r) => r.body), 'openai');
      await db.chunk.createMany({
        data: batch.map((r, i) => ({
          doc_id: r.doc_id,
          ord: i,
          body: r.body,
          token_count: Math.ceil(r.body.length / 4),
          embedding: vectors[i],
          model_id: 'openai/text-embedding-3-small',
        })),
      });
    }
  });
  await Promise.all(workers);
}
```

Throughput on a `c7g.xlarge`-shaped box with OpenAI as the embedder:
roughly 8-12k rows/min, gated by the embedding API. With a local
`bge-small-en-v1.5` on the same box: 30-50k rows/min.

**Deferred index build.** HNSW build at insert time roughly halves
throughput. For one-shot loads, drop the index first, bulk-load, rebuild
once at the end. Forge exposes the rebuild through `$queryRaw`:

```ts
// 1. Drop the vector index.
await db.$queryRaw`DROP INDEX IF EXISTS chunks_embedding_idx`;

// 2. Bulk insert. Index-free inserts on pgvector run at ~30-50k rows/s
//    per worker on a beefy host.
await bulkIngest(rows);

// 3. Rebuild the index. HNSW build is single-threaded inside pgvector;
//    expect ~5-10 min per million rows at 1536 dim with m=16.
await db.$queryRaw`
  CREATE INDEX chunks_embedding_idx ON chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
`;

// 4. Vacuum to reclaim and update planner stats.
await db.$queryRaw`VACUUM ANALYZE chunks`;
```

For continuous ingest (a few hundred rows/sec), keep the HNSW index
online — the rebuild cost is worse than the per-insert overhead.

---

## Eval and guardrails — MRR, nDCG, embedding cache

Without an eval set, you cannot tell a regression from a feature. The
minimum viable harness is 50-200 labelled `{ query, relevant_chunk_ids }`
pairs and a script that prints MRR and nDCG@10.

```ts
type Label = { query: string; relevant: string[] };

async function evalSet(labels: Label[]) {
  let mrrSum = 0;
  let ndcgSum = 0;

  for (const { query, relevant } of labels) {
    const [qVec] = await embed([query], 'openai');
    const hits = await db.chunk.findMany({
      orderBy: { embedding: { nearTo: qVec } },
      take: 10,
    });
    const rels = hits.map((h) => relevant.includes(h.id) ? 1 : 0);

    // MRR — 1 / rank of first relevant. 0 if not in top-10.
    const firstHit = rels.indexOf(1);
    mrrSum += firstHit === -1 ? 0 : 1 / (firstHit + 1);

    // nDCG@10 — sum of rel / log2(rank+2), normalised by ideal.
    const dcg = rels.reduce((s, r, i) => s + r / Math.log2(i + 2), 0);
    const ideal = relevant.slice(0, 10)
      .reduce((s, _, i) => s + 1 / Math.log2(i + 2), 0);
    ndcgSum += ideal ? dcg / ideal : 0;
  }

  return { mrr: mrrSum / labels.length, ndcg: ndcgSum / labels.length };
}

// CI gate. Fail the build if metrics drop more than 2 points.
test('retrieval quality holds', async () => {
  const { mrr, ndcg } = await evalSet(LABELS);
  expect(mrr).toBeGreaterThan(0.62);     // baseline measured on main
  expect(ndcg).toBeGreaterThan(0.58);
});
```

Run the suite against a frozen embedding set — copy the labelled rows
into a fixture DB so an upstream model change doesn't move the goalposts.

**Embedding cache.** Hashing the chunk body and skipping the API call
when nothing changed is the biggest unit-cost win you can take. forge
expresses the cache as a small table:

```ts
const EmbeddingCache = model('embedding_cache', {
  id:         f.id(),
  content_hash: f.string().unique(),
  model_id:   f.string(),
  embedding:  f.vector(1536, { metric: 'cosine' }),
  created_at: f.dateTime().default('now'),
}, {
  indexes: [{ keys: { content_hash: 1, model_id: 1 } }],
});

async function embedCached(texts: string[], modelId: string): Promise<number[][]> {
  const hashes = texts.map((t) => sha256(t));
  // SAT: select all hits.
  const hits = await db.embeddingCache.findMany({
    where: { content_hash: { in: hashes }, model_id: modelId },
  });
  const map = new Map(hits.map((h) => [h.content_hash, h.embedding]));
  const missingIdx = hashes
    .map((h, i) => map.has(h) ? -1 : i)
    .filter((i) => i >= 0);
  if (missingIdx.length) {
    const fresh = await embed(missingIdx.map((i) => texts[i]), 'openai');
    await db.embeddingCache.createMany({
      data: missingIdx.map((i, j) => ({
        content_hash: hashes[i],
        model_id: modelId,
        embedding: fresh[j],
      })),
    });
    missingIdx.forEach((i, j) => map.set(hashes[i], fresh[j]));
  }
  return hashes.map((h) => map.get(h)!);
}
```

Hit rate on a settled corpus is typically 80-95% after the first ingest
pass — most "ingest" calls are re-ingest of unchanged content. The cache
pays back its storage in a week.

---

## Cost model

Embedding cost per 1M tokens, current at the time of writing:

| Provider | Model | Dims | Cost / 1M tokens |
|---|---|---|---|
| OpenAI | text-embedding-3-small | 1536 | $0.020 |
| OpenAI | text-embedding-3-large | 3072 | $0.130 |
| Voyage | voyage-3 | 1024 | $0.060 |
| Voyage | voyage-3-lite | 512 | $0.020 |
| Cohere | embed-english-v3 | 1024 | $0.100 |
| Mistral | mistral-embed | 1024 | $0.100 |
| Local (Xenova bge-small) | bge-small-en-v1.5 | 384 | $0 + CPU |

A ballpark: 1M chunks of 400 tokens ≈ 400M tokens ≈ $8 on OpenAI small.
The 3-large version is 6.5x the cost for a typical 1-2 nDCG@10 gain;
worth it only above the dimensions-matter threshold (high-precision
search, agents that re-rerank rarely).

Storage cost per vector:

| Dim | Precision | Bytes / row | 1M rows | 100M rows |
|---|---|---|---|---|
| 384 | fp32 | 1536 + overhead | 1.7 GB | 170 GB |
| 768 | fp32 | 3072 + overhead | 3.4 GB | 340 GB |
| 1536 | fp32 | 6144 + overhead | 6.5 GB | 650 GB |
| 1536 | fp16 (halfvec) | 3072 + overhead | 3.4 GB | 340 GB |
| 1536 | binary | 192 + overhead | 220 MB | 22 GB |

Add HNSW index overhead: roughly 25-30% on top of the column itself for
typical `m=16`.

**When to self-host the embedder.** A local `bge-small-en-v1.5` on a
single GPU box (one $1500 RTX 4090, or $0.50/hr cloud) processes 5-10k
texts/sec. Break-even vs OpenAI small at ~50M texts/month. Below that,
hosted wins on operator cost; above, self-hosted wins on unit cost.

The local Ollama path (e.g. `nomic-embed-text` v1.5) is the same shape
but cheaper to set up — `ollama pull nomic-embed-text` and an HTTP call.
Recall is competitive with OpenAI small; tail latency is higher.
