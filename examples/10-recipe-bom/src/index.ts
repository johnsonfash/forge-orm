// Recursive BOM — a recipe whose components can themselves be recipes
// (sub-recipes). Pattern works for food, cosmetics, manufacturing.

import { createDb, f, model, rel } from "forge-orm"

const Recipe = model("recipes", {
  id:        f.id({ type: "uuid" }),
  parentSku: f.string().unique(),
  name:      f.string(),
  yieldQty:  f.float().default(1),
  yieldUnit: f.string().default("ea"),
}).relate(() => ({
  lines: rel.many("recipeLine", { on: "recipeId", refs: "id" }),
}))

const RecipeLine = model("recipe_lines", {
  // Not uuid: the seed below gives each line a readable natural key
  // ("L-LOAF-FLOUR"), which is what makes the upsert idempotent and the
  // output legible. Declaring uuid here made Postgres reject every one of
  // them (22P02, invalid input syntax for type uuid).
  id:           f.id({ type: "string" }),
  recipeId:     f.string(),
  componentSku: f.string(),
  qty:          f.float(),
  unit:         f.string().default("g"),
  wastage:      f.float().default(0),
}).relate(() => ({
  recipe: rel.one("recipe", { on: "recipeId", refs: "id" }),
}))

const db = await createDb({
  url: "pglite:./bom",
  schema: { recipe: Recipe, recipeLine: RecipeLine },
})
await db.$migrate()

// Seed (idempotent).
const starter = await db.recipe.upsert({
  where:  { parentSku: "REC-STARTER" },
  create: { parentSku: "REC-STARTER", name: "Sourdough starter", yieldQty: 200, yieldUnit: "g" },
  update: {},
})
for (const l of [
  { id: "L-STARTER-FLOUR", recipeId: starter.id, componentSku: "ING-FLOUR", qty: 100, unit: "g" },
  { id: "L-STARTER-WATER", recipeId: starter.id, componentSku: "ING-WATER", qty: 100, unit: "g" },
]) {
  await db.recipeLine.upsert({ where: { id: l.id }, create: l, update: {} })
}

const loaf = await db.recipe.upsert({
  where:  { parentSku: "REC-LOAF" },
  create: { parentSku: "REC-LOAF", name: "Country loaf", yieldQty: 800, yieldUnit: "g" },
  update: {},
})
for (const l of [
  { id: "L-LOAF-STARTER", recipeId: loaf.id, componentSku: "REC-STARTER", qty: 200, unit: "g", wastage: 0 },
  { id: "L-LOAF-FLOUR",   recipeId: loaf.id, componentSku: "ING-FLOUR",   qty: 500, unit: "g", wastage: 0.05 },
  { id: "L-LOAF-WATER",   recipeId: loaf.id, componentSku: "ING-WATER",   qty: 350, unit: "g", wastage: 0 },
]) {
  await db.recipeLine.upsert({ where: { id: l.id }, create: l, update: {} })
}

const prices = new Map<string, number>([
  ["ING-FLOUR", 0.002],
  ["ING-WATER", 0.0001],
  ["ING-SALT",  0.005],
])

async function rollup(parentSku: string, seen = new Set<string>()): Promise<number> {
  // The guard is for CYCLES, so it tracks the current path — not every sku
  // visited anywhere. Sharing one set across sibling branches made any
  // ingredient that also appears in a sub-recipe cost zero everywhere else:
  // the loaf's 500g of flour priced at 0 because the starter had already
  // used flour. It still ran, and still printed a number.
  if (seen.has(parentSku)) return 0
  seen.add(parentSku)
  const recipe = await db.recipe.findUnique({
    where:   { parentSku },
    include: { lines: true },
  })
  if (!recipe) return prices.get(parentSku) ?? 0
  let cost = 0
  for (const l of recipe.lines) {
    const unitCost = await rollup(l.componentSku, new Set(seen))
    cost += unitCost * l.qty * (1 + l.wastage)
  }
  return cost / recipe.yieldQty
}

console.log("Per-gram cost of REC-LOAF:", (await rollup("REC-LOAF")).toFixed(5))

// Close the database before the process ends. On PGlite this is not
// optional: its WASM Postgres reports proc_exit(99) when the instance
// is torn down with the process, so a script that did all its work
// correctly still exits non-zero.
await db.$disconnect()
