// Single global db instance (Next.js hot-reload safe).

import { createDb, f, model } from "forge-orm"

const Task = model("tasks", {
  id:        f.id({ type: "uuid" }),
  title:     f.string(),
  done:      f.bool().default(false),
  createdAt: f.dateTime().default("now"),
})

const schema = { task: Task }
type DbType = Awaited<ReturnType<typeof createDb<typeof schema>>>
const globalForDb = globalThis as unknown as { db?: DbType }

async function init(): Promise<DbType> {
  const db = await createDb({ url: "pglite:./.pgdata", schema })
  await db.$migrate()
  return db
}

export const db: DbType = globalForDb.db ?? (globalForDb.db = await init())
