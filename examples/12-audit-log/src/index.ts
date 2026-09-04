// Audit log — capture every mutation by listening to the `query`
// event. forge-orm fires QueryEvent for create/update/delete/findMany
// with the op string + duration so we can route mutations into an
// audit table.

import { createDb, f, model } from "forge-orm"

const Invoice = model("invoices", {
  id:     f.id({ type: "uuid" }),
  number: f.string().unique(),
  total:  f.float(),
  paid:   f.bool().default(false),
})

const AuditEntry = model("audit_entries", {
  id:        f.id({ type: "uuid" }),
  model:     f.string(),
  op:        f.string(),
  durationMs: f.float(),
  actorId:   f.string().optional(),
  at:        f.dateTime().default("now"),
})

const db = await createDb({
  url: "pglite:./audit",
  schema: { invoice: Invoice, auditEntry: AuditEntry },
})
await db.$migrate()

let currentActor: string | undefined

// Capture every query — filter to mutations.
const MUTATING_OPS = new Set(["create", "update", "delete", "upsert", "createMany", "updateMany", "deleteMany"])
db.$on("query", async (e) => {
  if (e.model === "auditEntry") return // don't audit the audit
  if (!MUTATING_OPS.has(e.op)) return
  await db.auditEntry.create({
    data: {
      model:      e.model ?? "?",
      op:         e.op,
      durationMs: e.durationMs ?? 0,
      actorId:    currentActor,
    },
  })
})

currentActor = "user-42"
const inv = await db.invoice.create({ data: { number: "INV-1001", total: 250 } })
await db.invoice.update({ where: { id: inv.id }, data: { paid: true } })

console.log("Audit feed:")
for (const a of await db.auditEntry.findMany({ orderBy: { at: "asc" } })) {
  console.log(`  ${a.at.toISOString()} · ${a.actorId ?? "?"} · ${a.model}.${a.op} (${a.durationMs}ms)`)
}
