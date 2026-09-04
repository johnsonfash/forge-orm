// The smallest possible forge-orm program. Reads + writes against a
// file-based SQLite database via better-sqlite3 — no server, no
// framework, no setup beyond `npm install && npm run dev`.

import { createDb, f, model } from "forge-orm"

const User = model("users", {
  id:    f.id({ type: "uuid" }),
  email: f.string().unique(),
  name:  f.string(),
})

const db = await createDb({
  url: "file:./data.db",
  schema: { user: User },
})

await db.$migrate()

// Idempotent seed — re-running the script is a no-op for the user row.
const alice = await db.user.upsert({
  where:  { email: "alice@example.com" },
  create: { email: "alice@example.com", name: "Alice" },
  update: {},
})
console.log("upserted:", alice)

const all = await db.user.findMany()
console.log("everyone:", all)
