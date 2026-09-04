// Postgres Row-Level Security. Each connection sets app.current_org;
// RLS policies enforce that every SELECT/UPDATE/DELETE is scoped to
// the active org. Even a misconfigured app can't leak data.
//
// Local docker: docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16

import { createDb, f, model } from "forge-orm"

const Customer = model("customers", {
  id:    f.id({ type: "uuid" }),
  orgId: f.string(),
  name:  f.string(),
})

const url = process.env.DATABASE_URL
if (!url) {
  console.error("Set DATABASE_URL (postgres://...) in .env")
  process.exit(1)
}

const db = await createDb({ url, schema: { customer: Customer } })
await db.$migrate()

// One-time RLS setup using $executeRaw.
await db.$executeRaw`ALTER TABLE customers ENABLE ROW LEVEL SECURITY`
await db.$executeRaw`DROP POLICY IF EXISTS org_isolation ON customers`
await db.$executeRaw`
  CREATE POLICY org_isolation ON customers
    USING (org_id = current_setting('app.current_org', true))
`

// In a request handler: set the org for the duration of the connection.
async function asOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org', ${orgId}, true)`
    return fn()
  })
}

await asOrg("org-a", () => db.customer.create({ data: { orgId: "org-a", name: "Alice" } }))
await asOrg("org-b", () => db.customer.create({ data: { orgId: "org-b", name: "Bob" } }))

console.log("org-a sees:", await asOrg("org-a", () => db.customer.findMany()))
console.log("org-b sees:", await asOrg("org-b", () => db.customer.findMany()))
