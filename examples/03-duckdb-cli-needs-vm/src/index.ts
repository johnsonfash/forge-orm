// DuckDB excels at OLAP — columnar storage + vectorised execution.
// Same forge-orm API as every other dialect; the change is one URL.
// Seeds 5,000 sales rows then runs groupBy aggregations across them.

import { createDb, f, model } from "forge-orm"

const Sale = model("sales", {
  id:      f.id({ type: "uuid" }),
  product: f.string(),
  qty:     f.int(),
  price:   f.float(),
  city:    f.string(),
  soldAt:  f.dateTime(),
})

const db = await createDb({
  url: "duckdb::memory:",
  schema: { sale: Sale },
})
await db.$migrate()

const products = ["Coffee", "Donut", "Sandwich", "Smoothie", "Bagel"]
const cities   = ["Lagos", "Abuja", "Accra", "Nairobi"]

const rows = Array.from({ length: 5000 }, (_, i) => ({
  product: products[i % products.length]!,
  qty:     1 + Math.floor(Math.random() * 5),
  price:   2 + Math.random() * 8,
  city:    cities[i % cities.length]!,
  soldAt:  new Date(Date.now() - Math.random() * 30 * 86_400_000),
}))
await db.sale.createMany({ data: rows })

console.log(`Seeded ${rows.length} sales.\n`)

// Top products by units sold.
const top = await db.sale.groupBy({
  by:      ["product"],
  _sum:    { qty: true },
  orderBy: { _sum: { qty: "desc" } },
})
console.log("Top products by units sold:")
for (const r of top) console.log(`  · ${r.product.padEnd(10)} ${r._sum.qty} units`)

// Revenue by city — DuckDB does the SUM(qty * price) in vectorised C++.
const revenue = await db.$queryRaw<{ city: string; revenue: number }>`
  SELECT city, SUM(qty * price)::DOUBLE AS revenue
  FROM sales
  GROUP BY city
  ORDER BY revenue DESC
`
console.log("\nRevenue by city:")
for (const r of revenue) console.log(`  · ${r.city.padEnd(10)} $${r.revenue.toFixed(2)}`)
