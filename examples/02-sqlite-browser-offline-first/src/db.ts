// Offline-first pattern. Writes go to the local SQLite DB; a separate
// `outbox` table queues the same op for later server sync.
//
// Uses `:memory:` so it runs in sandboxed iframes (StackBlitz). For real
// offline-first persistence switch to `"opfs-sahpool:///offline.sqlite"`.

import { createDb, f, model, wasmSqliteDriver } from "forge-orm"

const Note = model("notes", {
  id:        f.id({ type: "uuid" }),
  text:      f.text(),
  syncedAt:  f.dateTime().optional(),
  updatedAt: f.dateTime().default("now").updatedAt(),
})

const Outbox = model("outbox", {
  id:        f.id({ type: "uuid" }),
  noteId:    f.string(),
  op:        f.string(),
  payload:   f.json(),
  queuedAt:  f.dateTime().default("now"),
  tries:     f.int().default(0),
})

export const schema = { note: Note, outbox: Outbox }

let dbPromise: ReturnType<typeof open> | null = null
let bootPromise: Promise<Awaited<ReturnType<typeof open>>> | null = null

function open() {
  const worker = new Worker(
    new URL("forge-orm/wasm/worker", import.meta.url),
    { type: "module" },
  )
  return createDb({
    schema,
    driver: wasmSqliteDriver({ worker, url: ":memory:" }),
  })
}
export function getDb() {
  if (!dbPromise) dbPromise = open()
  return dbPromise
}
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
