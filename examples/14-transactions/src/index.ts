// Transactions — atomic batch + nested savepoints.

import { createDb, f, model } from "forge-orm"

const Account = model("accounts", {
  id:      f.id({ type: "uuid" }),
  owner:   f.string().unique(),
  balance: f.int().default(0),
})

const db = await createDb({
  url: "pglite:./tx",
  schema: { account: Account },
})
await db.$migrate()

await db.account.upsert({ where: { owner: "alice" }, create: { owner: "alice", balance: 100 }, update: {} })
await db.account.upsert({ where: { owner: "bob" },   create: { owner: "bob",   balance: 100 }, update: {} })

async function transfer(from: string, to: string, amount: number) {
  await db.$transaction(async (tx) => {
    const sender = await tx.account.findUnique({ where: { owner: from } })
    if (!sender || sender.balance < amount) throw new Error("insufficient funds")
    await tx.account.update({ where: { owner: from }, data: { balance: sender.balance - amount } })
    await tx.account.update({ where: { owner: to },   data: { balance: { increment: amount } } })
  })
}

await transfer("alice", "bob", 30)

try {
  await transfer("alice", "bob", 1_000_000) // rolls back
} catch (e) {
  console.log("rolled back:", (e as Error).message)
}

console.log("after:", await db.account.findMany({ orderBy: { owner: "asc" } }))
