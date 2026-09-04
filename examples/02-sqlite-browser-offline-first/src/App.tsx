import React from "react"
import { bootDb } from "./db"

type DbType = Awaited<ReturnType<typeof bootDb>>
type Note = { id: string; text: string; syncedAt: Date | null; updatedAt: Date }

export function App() {
  const [db, setDb] = React.useState<DbType | null>(null)
  const [bootError, setBootError] = React.useState<string | null>(null)
  const [notes, setNotes] = React.useState<Note[]>([])
  const [pending, setPending] = React.useState(0)
  const [text, setText] = React.useState("")

  React.useEffect(() => {
    bootDb().then(setDb).catch((e: Error) => setBootError(e?.message ?? String(e)))
  }, [])

  const reload = React.useCallback(async () => {
    if (!db) return
    setNotes(await db.note.findMany({ orderBy: { updatedAt: "desc" } }) as Note[])
    setPending((await db.outbox.findMany()).length)
  }, [db])

  React.useEffect(() => { if (db) reload() }, [db, reload])

  // Background drain loop.
  React.useEffect(() => {
    if (!db) return
    const t = setInterval(async () => {
      if (!navigator.onLine) return
      const pending = await db.outbox.findMany({ orderBy: { queuedAt: "asc" }, take: 10 })
      for (const o of pending) {
        // POST to your API here. Demo just marks synced.
        await db.note.update({ where: { id: o.noteId as string }, data: { syncedAt: new Date() } }).catch(() => undefined)
        await db.outbox.delete({ where: { id: o.id as string } })
      }
      reload()
    }, 5000)
    return () => clearInterval(t)
  }, [db, reload])

  if (bootError) return <pre style={{ padding: 40, color: "#c00" }}>{bootError}</pre>
  if (!db) return <p style={{ padding: 40, fontFamily: "system-ui" }}>Booting…</p>

  const add = async () => {
    if (!text.trim()) return
    const note = await db.note.create({ data: { text: text.trim() } })
    await db.outbox.create({ data: { noteId: note.id, op: "create", payload: { text: note.text } } })
    setText("")
    reload()
  }

  return (
    <div style={{ maxWidth: 480, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1>Offline-first notes</h1>
      <p style={{ color: "#666" }}>
        Pending sync: <strong>{pending}</strong> · {navigator.onLine ? "online" : "offline"}
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Note…" style={{ flex: 1, padding: 8 }} />
        <button onClick={add}>Save</button>
      </div>
      <ul style={{ marginTop: 20 }}>
        {notes.map((n) => (
          <li key={n.id} style={{ marginBottom: 8 }}>
            {n.text} {n.syncedAt ? <small style={{ color: "green" }}>✓ synced</small> : <small style={{ color: "#999" }}>(pending)</small>}
          </li>
        ))}
      </ul>
    </div>
  )
}
