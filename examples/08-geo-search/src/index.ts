// Geo search — "restaurants near me" using f.geoPoint + nearTo.
// Works against Postgres+PostGIS, MySQL, SpatiaLite, DuckDB spatial,
// MSSQL geography, and Mongo GeoJSON without touching this code.
// fallback: true here uses JSON + Haversine when no extension exists.

import { createDb, f, model } from "forge-orm"

const Restaurant = model("restaurants", {
  id:   f.id({ type: "uuid" }),
  name: f.string().unique(),
  // SRID 4326 = WGS84 (standard GPS coordinates). fallback:true means
  // "work even without PostGIS — store JSON, post-filter in app".
  loc:  f.geoPoint({ srid: 4326, fallback: true }),
})

const db = await createDb({
  url: "pglite:./geodata",
  schema: { restaurant: Restaurant },
})
await db.$migrate()

const seeds = [
  { name: "Yellow Chilli",  loc: { lat: 6.6018, lng: 3.3515 } },
  { name: "RSVP Lagos",     loc: { lat: 6.4474, lng: 3.4553 } },
  { name: "Sky Restaurant", loc: { lat: 6.5790, lng: 3.3524 } },
  { name: "Nkoyo",          loc: { lat: 6.4283, lng: 3.4218 } },
  { name: "Mama Cass",      loc: { lat: 6.6125, lng: 3.3416 } },
]
for (const s of seeds) {
  await db.restaurant.upsert({ where: { name: s.name }, create: s, update: {} })
}

// Ikeja City Mall — find spots within 5km, sorted by distance.
const me = { lat: 6.6018, lng: 3.3515 }
const near = await db.restaurant.findMany({
  where:   { loc: { nearTo: { point: me, withinMeters: 5000 } } },
  orderBy: { loc: { nearTo: me } },
})

console.log("Within 5km of Ikeja:")
for (const r of near) console.log(`  · ${r.name}`)
