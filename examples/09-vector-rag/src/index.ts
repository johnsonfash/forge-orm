// Vector similarity — the storage + query half of a RAG pipeline.
// Pair with any embedding provider (OpenAI, Cohere, local model).
// Same code targets pgvector / MySQL VECTOR / sqlite-vec / DuckDB vss
// / MSSQL VECTOR / Mongo Atlas Vector Search.

import { createDb, f, model } from "forge-orm"

// 1536 = OpenAI text-embedding-3-small dimension. Adjust to your model.
const Doc = model("docs", {
  id:    f.id({ type: "uuid" }),
  text:  f.text().unique(),
  embed: f.vector(1536, { metric: "cosine" }),
})

const db = await createDb({
  url: "pglite:./vecdata",
  schema: { doc: Doc },
})
await db.$migrate()

// Mock embedding — in real life: `await openai.embeddings.create(...)`.
function fakeEmbed(seed: string): number[] {
  const arr = new Array(1536).fill(0)
  for (let i = 0; i < seed.length; i++) arr[i % 1536] = (seed.charCodeAt(i) % 11) / 10
  return arr
}

const corpus = [
  "How do I bake bread?",
  "Sourdough starter feeding ratios",
  "Wiring a Postgres connection in Node",
  "TLS certificate renewal with Let's Encrypt",
  "Knife sharpening with a whetstone",
]
for (const text of corpus) {
  await db.doc.upsert({
    where:  { text },
    create: { text, embed: fakeEmbed(text) },
    update: {},
  })
}

const query = "leavened dough"
const matches = await db.doc.findMany({
  where: { embed: { nearTo: { vector: fakeEmbed(query), topK: 3 } } },
})

console.log(`Top 3 for "${query}":`)
for (const m of matches) console.log(`  · ${m.text}`)
