import React from "react"
import { bootDb } from "./db"

type DbType = Awaited<ReturnType<typeof bootDb>>
type Todo = { id: string; title: string; done: boolean; createdAt: Date }

export function App() {
  const [db, setDb] = React.useState<DbType | null>(null)
  const [bootError, setBootError] = React.useState<string | null>(null)
  const [todos, setTodos] = React.useState<Todo[]>([])
  const [title, setTitle] = React.useState("")

  React.useEffect(() => {
    bootDb()
      .then(setDb)
      .catch((e: Error) => setBootError(e?.message ?? String(e)))
  }, [])

  const reload = React.useCallback(async () => {
    if (!db) return
    setTodos(await db.todo.findMany({ orderBy: { createdAt: "desc" } }) as Todo[])
  }, [db])

  React.useEffect(() => {
    if (db) reload()
  }, [db, reload])

  if (bootError) {
    return (
      <div style={{ maxWidth: 480, margin: "40px auto", fontFamily: "system-ui", color: "#c00" }}>
        <h2>Couldn&rsquo;t boot the database</h2>
        <pre style={{ background: "#fee", padding: 12, fontSize: 12 }}>{bootError}</pre>
        <p style={{ fontSize: 13, color: "#666" }}>
          OPFS may not be available in this environment. Try Chrome / Edge /
          Safari in a top-level window (not an embedded iframe).
        </p>
      </div>
    )
  }
  if (!db) {
    return <p style={{ padding: 40, fontFamily: "system-ui" }}>Booting OPFS database…</p>
  }

  const add = async () => {
    if (!title.trim()) return
    await db.todo.create({ data: { title: title.trim() } })
    setTitle("")
    reload()
  }
  const toggle = async (t: Todo) => {
    await db.todo.update({ where: { id: t.id }, data: { done: !t.done } })
    reload()
  }
  const remove = async (t: Todo) => {
    await db.todo.delete({ where: { id: t.id } })
    reload()
  }

  return (
    <div style={{ maxWidth: 480, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1>forge-orm · SQLite-in-a-tab</h1>
      <p style={{ color: "#666" }}>
        Data persists in OPFS — refresh the page, it&rsquo;s still here.
      </p>
      <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="What needs doing?"
          style={{ flex: 1, padding: "8px 12px", fontSize: 14 }}
        />
        <button onClick={add} style={{ padding: "8px 16px" }}>Add</button>
      </div>
      <ul style={{ listStyle: "none", padding: 0, marginTop: 20 }}>
        {todos.map((t) => (
          <li
            key={t.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 0",
              borderBottom: "1px solid #eee",
            }}
          >
            <input type="checkbox" checked={t.done} onChange={() => toggle(t)} />
            <span
              style={{
                flex: 1,
                textDecoration: t.done ? "line-through" : "none",
                color: t.done ? "#999" : "#000",
              }}
            >
              {t.title}
            </span>
            <button onClick={() => remove(t)} style={{ color: "#c00", border: "none", background: "none", cursor: "pointer" }}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
