// Browser-side forge-orm. Lazy singleton — boots once on first use.
//
// In production you'll want OPFS persistence (`opfs-sahpool:///todo.sqlite`)
// so the data survives reloads. But OPFS sync access handles aren't
// available in some sandboxed iframes (e.g. StackBlitz's WebContainer
// preview), so this example uses `:memory:` to guarantee the demo
// runs everywhere. Switch the `url` line for production.

import { createDb, f, model, wasmSqliteDriver } from "forge-orm"

const Todo = model("todos", {
  id:        f.id({ type: "uuid" }),
  title:     f.string(),
  done:      f.bool().default(false),
  createdAt: f.dateTime().default("now"),
})

export const schema = { todo: Todo }

let dbPromise: ReturnType<typeof open> | null = null
let bootPromise: Promise<Awaited<ReturnType<typeof open>>> | null = null

function open() {
  const worker = new Worker(
    new URL("forge-orm/wasm/worker", import.meta.url),
    { type: "module" },
  )
  return createDb({
    schema,
    driver: wasmSqliteDriver({
      worker,
      // Demo: in-memory so it works everywhere (including sandboxed
      // iframes that block OPFS).
      // Production: `"opfs-sahpool:///todo.sqlite"` to persist.
      url: ":memory:",
    }),
  })
}

export function getDb() {
  if (!dbPromise) dbPromise = open()
  return dbPromise
}

// Boot is its own singleton — protects against React 18 StrictMode's
// double-mount effect firing $migrate twice concurrently (which would
// throw "cannot start a transaction within a transaction").
export function bootDb() {
  if (!bootPromise) {
    bootPromise = (async () => {
      const db = await getDb()
      if (navigator.storage?.persist) await navigator.storage.persist()
      await db.$migrate()
      return db
    })()
  }
  return bootPromise
}
