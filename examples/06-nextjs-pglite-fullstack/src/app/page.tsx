import { db } from "@/lib/db"
import { revalidatePath } from "next/cache"

async function addTask(formData: FormData) {
  "use server"
  const title = (formData.get("title") as string)?.trim()
  if (!title) return
  await db.task.create({ data: { title } })
  revalidatePath("/")
}

async function toggleTask(id: string, done: boolean) {
  "use server"
  await db.task.update({ where: { id }, data: { done: !done } })
  revalidatePath("/")
}

export default async function Page() {
  const tasks = await db.task.findMany({ orderBy: { createdAt: "desc" } })

  return (
    <div>
      <h1>Next.js · forge-orm · PGlite</h1>
      <p style={{ color: "#666" }}>Server actions writing to Postgres-in-wasm. No external DB.</p>
      <form action={addTask} style={{ display: "flex", gap: 8 }}>
        <input name="title" placeholder="What needs doing?" style={{ flex: 1, padding: 8 }} />
        <button type="submit">Add</button>
      </form>
      <ul style={{ listStyle: "none", padding: 0, marginTop: 16 }}>
        {tasks.map((t) => (
          <li key={t.id} style={{ padding: "8px 0", borderBottom: "1px solid #eee" }}>
            <form action={toggleTask.bind(null, t.id, t.done)} style={{ display: "inline" }}>
              <button type="submit" style={{ textDecoration: t.done ? "line-through" : "none", background: "none", border: "none", cursor: "pointer", fontSize: 14 }}>
                {t.done ? "✓ " : "○ "}{t.title}
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  )
}
