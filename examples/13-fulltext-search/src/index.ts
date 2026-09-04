// Full-text search — same API across Postgres tsvector, MySQL FULLTEXT,
// SQLite FTS5, MSSQL CONTAINS, Mongo text index.

import { createDb, f, model } from "forge-orm"

const Article = model("articles", {
  id:    f.id({ type: "uuid" }),
  title: f.string().unique(),
  body:  f.text().searchable(), // marks the column FTS-indexed
})

const db = await createDb({
  url: "pglite:./fts",
  schema: { article: Article },
})
await db.$migrate()

const seeds = [
  { title: "Sourdough basics",  body: "Hydration ratios, bulk fermentation, shaping a country loaf." },
  { title: "TLS renewal",       body: "Automating Let's Encrypt cert renewal with cron + acme.sh." },
  { title: "Postgres tuning",   body: "Connection pooling, prepared statements, work_mem sizing." },
  { title: "Knife sharpening",  body: "Whetstone grit progression — 400 / 1000 / 4000." },
]
for (const s of seeds) await db.article.upsert({ where: { title: s.title }, create: s, update: {} })

const hits = await db.article.findMany({
  where: { body: { search: "fermentation OR cert" } },
})

console.log("Hits:")
for (const a of hits) console.log(`  · ${a.title}`)
