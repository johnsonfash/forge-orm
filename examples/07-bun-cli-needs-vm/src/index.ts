// Bun's built-in SQLite via better-sqlite3-compatible driver. forge-orm
// auto-detects the file: URL and picks the right adapter.

import { createDb, f, model, rel } from "forge-orm"

const Post = model("posts", {
  id:        f.id({ type: "uuid" }),
  title:     f.string(),
  body:      f.text(),
  authorId:  f.string(),
}).relate(() => ({
  author: rel.one("author", { on: "authorId", refs: "id" }),
}))

const Author = model("authors", {
  id:    f.id({ type: "uuid" }),
  email: f.string().unique(),
  name:  f.string(),
}).relate(() => ({
  posts: rel.many("post", { on: "authorId", refs: "id" }),
}))

const db = await createDb({
  url: "file:./blog.db",
  schema: { author: Author, post: Post },
})
await db.$migrate()

const ada = await db.author.upsert({
  where:  { email: "ada@example.com" },
  create: { email: "ada@example.com", name: "Ada Lovelace" },
  update: {},
})

await db.post.create({
  data: { authorId: ada.id, title: "On loops + mathematics", body: "..." },
})

console.log(await db.author.findMany({ include: { posts: true } }))
