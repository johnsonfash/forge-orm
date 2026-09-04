# 08 · Geo search (`f.geoPoint` + `nearTo`)

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/08-geo-search)

"Find me everything within X meters." Same code targets PostGIS, MySQL spatial, SpatiaLite, DuckDB spatial, MSSQL geography, and Mongo GeoJSON.

## Highlights

- `f.geoPoint({ srid: 4326, fallback: true })` — standard WGS84, with a Haversine fallback when no extension is installed
- `nearTo: { point, withinMeters }` — same operator across every dialect
- `orderBy: { loc: { nearTo: me } }` — sort by distance, ascending

## When you'd ship this

- Local-business search ("restaurants near me", "stores within 10km")
- Delivery / driver-routing decisions
- Multi-location footprint analytics
- Geofenced features ("only when inside the warehouse")

To target a real Postgres with PostGIS installed, swap the URL + drop `fallback: true`.
