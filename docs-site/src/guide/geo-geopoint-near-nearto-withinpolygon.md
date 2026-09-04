---
title: "Geo (geoPoint, near, nearTo, withinPolygon)"
---

## Geo (geoPoint, near, nearTo, withinPolygon)

Declare a `f.geoPoint()` field and pair it with `method: 'spatial'`. The
column type and the spatial index family come out right per dialect:

```ts
const Place = model('places', {
  id: f.id(),
  name: f.string(),
  location: f.geoPoint(),                       // WGS84 / SRID 4326
}, {
  indexes: [{ keys: { location: 1 }, method: 'spatial', name: 'idx_places_geo' }],
});

// Insert — always { lng, lat }. Forge handles per-dialect coord-order quirks.
await db.place.create({
  data: { id: 'a', name: 'Lekki', location: { lng: 3.4505, lat: 6.4416 } },
});

// "Within 5 km of me", closest first, with a distance annotation.
const nearby = await db.place.findMany({
  where:   { location: { near: { lng: 3.45, lat: 6.44, withinMeters: 5000 } } },
  orderBy: { location: { nearTo: { lng: 3.45, lat: 6.44 } } },
  take: 20,
});
// nearby[0]._distanceMeters ≈ 0  (meters from the search point)
```

### What forge emits per dialect

| | Column | Spatial index | `near` filter | `nearTo` orderBy |
|---|---|---|---|---|
| Mongo | GeoJSON in JSON | `2dsphere` | `$near + $maxDistance` | (sorted by `$near` implicitly) |
| Postgres | `geography(Point, 4326)` | `USING GIST` | `ST_DWithin(...)` | `ST_Distance(...)` AS `_distanceMeters` |
| MySQL 8 | `POINT NOT NULL SRID 4326` | `SPATIAL INDEX` | `ST_Distance_Sphere(...) < N` | `ST_Distance_Sphere(...)` |
| SQLite | `BLOB` (SpatiaLite) | virtual `idx_<tbl>_<col>` table | `Distance(..., 1) < N` | `Distance(..., 1)` |
| DuckDB | `GEOMETRY` (spatial ext) | `USING RTREE` | `ST_Distance_Sphere(...) < N` | `ST_Distance_Sphere(...)` |
| MSSQL | `GEOGRAPHY` | `CREATE SPATIAL INDEX` | `col.STDistance(...) < N` | `col.STDistance(...)` |

### Extensions

- **Postgres** — needs PostGIS. Run `npx forge push --enable-extensions` to
  have forge issue `CREATE EXTENSION IF NOT EXISTS postgis;` before the
  schema push, or install it once by hand.
- **SQLite** — needs SpatiaLite (`brew install libspatialite` /
  `apt install libsqlite3-mod-spatialite`). The adapter calls
  `load_extension('mod_spatialite')` automatically; failures are silent so
  non-geo schemas keep working.
- **DuckDB** — `INSTALL spatial; LOAD spatial;` runs at connect time. Always
  available (bundled since DuckDB 0.9).
- **MSSQL** — `GEOGRAPHY` is built-in. Nothing to install.
- **MySQL 8** — spatial built-in. **5.7 works too** but without the SRID
  metadata. `forge doctor` warns if it detects 5.7.
- **Mongo** — `2dsphere` built-in.

Run `forge doctor` to see which extensions your live DB has and what's
missing, with copy-paste install commands.

### Fallback mode (no extension)

When the dialect's spatial extension is unavailable (a managed PG host
without PostGIS, a stripped-down SQLite, a barebones DuckDB build), opt
into fallback mode:

```ts
const Place = model('places', {
  id: f.id(),
  location: f.geoPoint({ fallback: true }),    // JSON storage + bbox prefilter
});
```

The column is stored as `{lng, lat}` JSON, the SQL emits a bounding-box
prefilter on the JSON-extracted lng/lat, and the adapter post-filters via
Haversine in app to produce the exact distance + circle. Works without
any extension; ~50× slower than the native path on large tables (fine to
~50k rows; migrate to a real extension past 100k).

### Coordinate order — always lng, lat

The forge API is `{ lng, lat }` everywhere. Per-dialect order differences
(MySQL 8 axis-order, GeoJSON order, MSSQL geography ordering) are handled
by the compile layer so you never have to think about them.

### Polygon containment

```ts
const inside = await db.place.findMany({
  where: {
    location: {
      withinPolygon: [
        { lng: 3.20, lat: 6.35 },   // 3+ vertices; ring auto-closes
        { lng: 3.60, lat: 6.35 },
        { lng: 3.40, lat: 6.55 },
      ],
    },
  },
});
```

Per dialect:

| | Compiles to |
|---|---|
| Mongo | `$geoWithin: { $geometry: Polygon }` |
| Postgres | `ST_Within(loc::geometry, ST_GeogFromText(...)::geometry)` |
| MySQL 8 | `ST_Within(loc, ST_GeomFromText('POLYGON((lat lng,…))', 4326))` |
| SQLite | `Within(loc, GeomFromText('POLYGON((…))', 4326))` |
| DuckDB | `ST_Within(loc, ST_GeomFromText('POLYGON((…))'::VARCHAR))` |
| MSSQL | `geography::STGeomFromText('POLYGON((…))', 4326).STContains(loc) = 1` |

Fallback mode emits an axis-aligned bbox prefilter from the polygon's
envelope; the adapter then runs a ray-casting point-in-polygon refinement
in app. Concave polygons work correctly.

**See also:** **[docs/GEO.md](/reference/geo)** — SRID picker, full dialect feature matrix, PostGIS deep-dive, distance models (sphere/ellipsoid/planar), 3D coords, MultiPolygon patterns, GeoJSON round-trip, spatial joins, H3 grids, realtime tracking, testing.

---
