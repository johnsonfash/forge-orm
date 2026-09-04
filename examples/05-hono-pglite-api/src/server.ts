// REST API on Hono + Postgres-via-PGlite. PGlite is Postgres compiled
// to wasm — runs in-process so this example needs zero external infra.
// To target a real Postgres, swap the URL to `postgres://...`.

import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { createDb, f, model, rel } from "forge-orm"

const Post = model("posts", {
  id:        f.id({ type: "uuid" }),
  title:     f.string(),
  body:      f.text(),
  authorId:  f.string(),
  createdAt: f.dateTime().default("now"),
}).relate(() => ({
  author: rel.one("user", { on: "authorId", refs: "id" }),
}))

const User = model("users", {
  id:    f.id({ type: "uuid" }),
  email: f.string().unique(),
  name:  f.string(),
}).relate(() => ({
  posts: rel.many("post", { on: "authorId", refs: "id" }),
}))

const db = await createDb({
  url: "pglite:./pgdata",
  schema: { user: User, post: Post },
})
await db.$migrate()

const app = new Hono()

app.get("/users", async (c) => c.json(await db.user.findMany({ include: { posts: true } })))
app.post("/users", async (c) => {
  const body = await c.req.json<{ email: string; name: string }>()
  return c.json(await db.user.create({ data: body }))
})

app.get("/posts", async (c) => c.json(await db.post.findMany({ include: { author: true } })))
app.post("/posts", async (c) => {
  const body = await c.req.json<{ title: string; body: string; authorId: string }>()
  return c.json(await db.post.create({ data: body }))
})

app.get("/", (c) =>
  c.text(
    "forge-orm + Hono + PGlite\n\n" +
      "GET  /users\n" +
      "POST /users   { email, name }\n" +
      "GET  /posts\n" +
      "POST /posts   { title, body, authorId }\n",
  ),
)

serve({ fetch: app.fetch, port: 3000 })
console.log("→ http://localhost:3000")
