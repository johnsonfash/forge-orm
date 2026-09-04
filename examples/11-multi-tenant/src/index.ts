// Multi-tenant — every row carries an `orgId` and every read filters
// on it. The scoped-db wrapper makes the filter automatic so app code
// can never accidentally cross orgs.

import { createDb, f, model } from "forge-orm"

const Customer = model("customers", {
  id:    f.id({ type: "uuid" }),
  orgId: f.string(),
  name:  f.string(),
})

const db = await createDb({
  url: "pglite:./tenant",
  schema: { customer: Customer },
})
await db.$migrate()

// Scoped wrapper — every method gets `orgId` injected. Use this in
// request handlers; never expose `db` directly to app code.
function scoped(orgId: string) {
  return {
    customer: {
      findMany: () => db.customer.findMany({ where: { orgId } }),
      create:   (data: { name: string }) =>
        db.customer.create({ data: { ...data, orgId } }),
    },
  }
}

const orgA = scoped("org-a")
const orgB = scoped("org-b")

await orgA.customer.create({ name: "Alice (org-a)" })
await orgB.customer.create({ name: "Bob   (org-b)" })

console.log("org-a sees:", await orgA.customer.findMany())
console.log("org-b sees:", await orgB.customer.findMany())
// Each org sees ONLY its own customer — the scope is impossible to forget.
