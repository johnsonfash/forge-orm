import { createDb, f, model } from "forge-orm"
// Side-effect import registers the IndexedDB adapter with the factory.
import "forge-orm/indexeddb"

const Cafe = model("cafes", {
  id:        f.id({ type: "uuid" }),
  name:      f.string(),
  city:      f.string(),
  location:  f.geoPoint(),
  embedding: f.vector(4, { metric: "cosine" }),
})

export const schema = { cafe: Cafe }

export async function openDb() {
  const db = await createDb({ schema, url: "idb:forge-cafes" })
  await db.$migrate()
  return db
}
