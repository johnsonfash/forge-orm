# Geo deep-dive — SRIDs, distance models, dialect behaviour

The [Geo chapter](../README.md#geo-geopoint-near-nearto-withinpolygon) in
the README covers the surface API — `f.geoPoint()`, the `near` filter,
the `nearTo` orderBy, `withinPolygon` containment. This doc is the
companion that goes one layer down: which SRID to pick for which
workload, how each dialect actually implements the IR, when fallback
mode is acceptable, how the Mongo cross-field rewrite works, error
budgets per distance model, MultiPolygon hole semantics, GeoJSON
plumbing, spatial joins, H3 clustering, realtime tracking patterns,
and how to test geo code without flaky lat/lng comparisons.

The [2.5.0 CHANGELOG entry](../CHANGELOG.md#250--mssql-merge-upsert-mongo-cross-field-nearto-browser-doctordiff-multipolygon--geometrycollection-3d--z-coordinates-non-wgs84-srids)
documents the underlying additions — MultiPolygon + GeometryCollection
inputs, 3D / Z coordinates, non-WGS84 SRIDs, Mongo cross-field
`nearTo`. Everything below assumes you're on 2.5.x.

## Contents

* [Pick an SRID](#pick-an-srid)
* [Dialect feature matrix](#dialect-feature-matrix)
* [Fallback mode in detail](#fallback-mode-in-detail)
* [PostGIS deep-dive](#postgis-deep-dive)
* [Mongo 2dsphere and the $geoNear rewrite](#mongo-2dsphere-and-the-geonear-rewrite)
* [Distance modes — sphere, ellipsoid, planar](#distance-modes--sphere-ellipsoid-planar)
* [3D coordinates](#3d-coordinates)
* [MultiPolygon + GeometryCollection patterns](#multipolygon--geometrycollection-patterns)
* [GeoJSON pipeline](#geojson-pipeline)
* [Spatial joins](#spatial-joins)
* [Heatmaps and H3](#heatmaps-and-h3)
* [Realtime tracking](#realtime-tracking)
* [Testing geo](#testing-geo)

---

## Pick an SRID

Forge defaults to **SRID 4326** (WGS84 lat/lng). That's the right
default for app code that takes coordinates from a phone GPS, a
geocoder, or a `navigator.geolocation` call — every consumer-grade
source emits WGS84.

Pick a different SRID with `f.geoPoint({ srid: 3857 })`. Coordinates
passed to `create` / `update` / `near` / `withinPolygon` must already
be in the target SRID's units — forge does not auto-transform.

| SRID | Name | Units | When it wins |
|---|---|---|---|
| 4326 | WGS84 | degrees | Default. Anything taking GPS / GeoJSON input. Sphere/ellipsoid distance via the dialect's geography type. |
| 3857 | Web Mercator | metres (planar at the equator) | Tile maps (Google, Mapbox, Leaflet). Renders pixel-perfect because the projection matches the tile pyramid. Distance is heavily distorted near the poles — don't measure with it, just render. |
| 27700 | OSGB 36 | metres | Surveying / cadastral data in Great Britain. Sub-metre accuracy for UK national datasets (OS MasterMap, postcode polygons from ONS). |
| 2154 | Lambert-93 | metres | Mainland France. Used by IGN, BANO, INSEE. The legal projection for French public data. |
| 32601-32660 | UTM north zones | metres | On-device proximity inside a single zone. Treat coordinates as planar within ~500 km of the central meridian; distortion < 1 in 2500. |
| 32701-32760 | UTM south zones | metres | Same, southern hemisphere. |
| 4269 | NAD83 | degrees | US federal datasets (Census TIGER, USGS). Visually identical to 4326 at app zoom; algebraically distinct. |

Workload picks:

- **Route planning** — store 4326 (geography), measure with the
  ellipsoid (PG `geography` does this automatically for distances
  under a few hundred km). Bigger trips: switch to a real routing
  engine (OSRM, Valhalla) and use forge only for the start/end points.
- **Isochrones** — same as routing. Compute the polygon in OSRM /
  GraphHopper, store the result polygon in forge as
  `f.geoPoint()` for the centre and a `withinPolygon`-style boundary
  in a JSON column.
- **Choropleth tiles** — store geometry in 3857. Tile-level rendering
  is then a passthrough.
- **Surveying / cadastral** — store in the local national grid
  (27700 / 2154 / SP coords). Convert to 4326 only at the API
  boundary if a consumer asks for GeoJSON.
- **On-device proximity** under ~50 km — pick the right UTM zone for
  the device's region and store planar. `near` filters become a
  cheap bbox + distance check with no trigonometry.

Cross-SRID equality is undefined behaviour — every dialect rejects it
at the SQL layer. If you mix SRIDs, normalise at write time with
`proj4` or the dialect's `ST_Transform`.

---

## Dialect feature matrix

What each dialect actually does for geo. Read in parallel with the
[per-dialect emit table](../README.md#what-forge-emits-per-dialect)
in the README.

| | Types | Spatial index | Distance | Polygon | MultiPolygon | 3D Z | Cartesian + ellipsoidal |
|---|---|---|---|---|---|---|---|
| PostgreSQL + PostGIS | `geography(Point, srid)` (4326), `geometry(Point, srid)` (other) | GiST, SP-GiST, BRIN | ellipsoid (geography), planar (geometry) | yes (with holes) | yes | yes (`PointZ`) | both |
| MySQL 8 | `POINT NOT NULL SRID srid` | `SPATIAL INDEX` (R-Tree) | `ST_Distance_Sphere` (sphere) | yes (no holes natively — emulated via diff) | partial — flatten to UNION | no native — alt stored side-by-side | sphere subset |
| SQLite + SpatiaLite | `BLOB` geom, R-Tree virtual table | R-Tree via virtual table | `Distance(g, g, 1)` (ellipsoid mode) | yes (with holes) | yes | yes (`POINT Z`) | both |
| SQLite (fallback) | JSON `{lng, lat}` | none (bbox scan) | haversine in JS | even-odd ray-cast in JS | yes (per-polygon ray-cast) | alt round-trip, not measured | sphere only |
| DuckDB + spatial | `GEOMETRY` | R-Tree | `ST_Distance_Sphere` | yes (with holes) | yes | yes (`ST_Point3D`) | both |
| MongoDB | GeoJSON in BSON | `2dsphere` | sphere ($near / $geoNear) | yes (with holes) | yes (GeoJSON MultiPolygon) | alt round-trip, not measured | sphere only |
| MSSQL | `GEOGRAPHY` (4326), `GEOMETRY` (other SRIDs via app) | `CREATE SPATIAL INDEX` (quadtree grid) | ellipsoid (`STDistance`) | yes (with holes) | yes (MultiPolygon WKT) | yes (`POINT(x y z)`) | both |

Notes:

- **MySQL 8** axis order is lat-first for SRID 4326 geographic. Forge
  swaps coords at compile time via the `axis` param on
  `toGeoWKT` (see [`src/adapters/shared/wkt.ts`](../src/adapters/shared/wkt.ts)),
  so app code always passes `{lng, lat}`.
- **MySQL 5.7** works but has no SRID metadata — `forge doctor` flags
  this. Treat 5.7 as "planar without a coordinate system".
- **MongoDB** is 4326-only at the index level. Non-4326 fields force
  fallback (`fallback: true`).
- **MSSQL** geography rejects geometries that span more than a
  hemisphere. Forge does not partition large polygons — feed it
  continent-scale or smaller.

---

## Fallback mode in detail

`orderBy: { loc: { nearTo: point } }` works on a fallback column as well
as `where.near` does. Neither emits spatial SQL: the WHERE becomes a
bounding-box prefilter, no distance column is selected, and no `ORDER BY`
is emitted — the executor computes `_distanceMeters` by haversine and
sorts on it after the rows come back. Before 2.16.0 the ordering path
asked for `ST_GeogFromText` against the JSON column and failed.

Set `f.geoPoint({ fallback: true })` when the dialect's spatial
extension isn't available. Three common reasons:

- Managed PG without PostGIS (some lower tiers of Neon, Supabase,
  RDS).
- Stripped SQLite — Expo SQLite, op-sqlite default builds, the stock
  `@sqlite.org/sqlite-wasm` (no R-Tree). The
  [custom wasm build](../README.md#custom-wasm-build-vec0--r-tree)
  flips this on for browser.
- DuckDB without `INSTALL spatial` — uncommon since DuckDB bundles it
  from 0.9, but possible in restricted environments.

What changes:

- **Storage** — column type drops to JSON / TEXT containing
  `{"lng": …, "lat": …}` (or `{"lng", "lat", "alt"}` for 3D).
- **Insert** — same `{ lng, lat }` shape, JSON-encoded.
- **`near` filter** — compiles to two stages:
  1. A bbox prefilter on the JSON-extracted lng/lat using the
     dialect's JSON operators (`->>'lng'`, `JSON_EXTRACT(...)`).
     The bbox is sized to enclose the search circle on the sphere
     plus a 5% margin for the cos(lat) compression at the boundary.
  2. App-side haversine refinement that drops false positives from
     the bbox.
- **`nearTo` orderBy** — works the same, but with no spatial index
  the database can't push down the sort. Forge fetches the bbox set,
  refines, sorts in app.
- **`withinPolygon`** — bbox prefilter from the polygon's envelope,
  then even-odd ray-cast in `pointInMultiPolygon` (see
  [`src/geo/fallback.ts`](../src/geo/fallback.ts)). Holes work via
  parity — a point inside an outer ring and inside a hole flips
  twice and falls out, which is correct.

Performance ceiling — roughly **50k rows** for interactive (< 100 ms)
queries with a single-column index on `(active = true)`-style filter,
and up to 100k for tolerant background jobs. Past that:

- A `near` filter scans the whole bbox-matched set every query — no
  index push-down can shrink it.
- Compound filters (`near` AND another predicate) help, because the
  other predicate's index runs first and the geo bbox runs over the
  smaller candidate set.

Migrate to a real extension before the table crosses 100k rows. The
schema move is one-way safe: turn `fallback: false`, run `forge push
--enable-extensions`, and forge re-emits the column as the dialect's
native geo type. Data round-trips through `ST_GeomFromText` /
`GeomFromGeoJSON`.

---

## PostGIS deep-dive

Forge emits `geography(Point, 4326)` by default and switches to
`geometry(Point, srid)` for non-4326 SRIDs. That covers 90% of app
code. The remaining 10% — the cases where you reach for raw SQL —
benefits from a clear mental model of the two PostGIS types.

### `geography` vs `geometry`

| | `geography` | `geometry` |
|---|---|---|
| Coordinate system | WGS84 only (SRID 4326) | Any SRID |
| Units | always metres for distance functions | the SRID's units (metres, degrees, feet) |
| Distance math | ellipsoidal (Vincenty) for points < some km, falls back to sphere | planar |
| Index | GiST | GiST, SP-GiST, BRIN |
| When to pick | sphere distance "just works", small areas, polygons that don't cross the antimeridian badly | non-4326 SRIDs, planar maths, ST functions PostGIS only ships for `geometry` |

Practical rules:

- App code with GPS-shaped data and "what's within N metres" queries:
  `geography(Point, 4326)`. Forge's default.
- App code that joins with cadastral data in a national grid:
  `geometry(Point, 27700)` etc. Set `f.geoPoint({ srid: 27700 })`.
- One model can mix both — give a Place its lat/lng `geoPoint` AND
  a polygon column you write through `$executeRaw` as
  `geometry(MultiPolygon, 27700)`.

### KNN with `<->`

PostGIS's killer index feature is the `<->` operator: index-supported
KNN with a B-tree-style ORDER BY. Forge's `nearTo` emits
`ST_Distance(...)`, which **doesn't use the GiST index for sorting**
because the index can't sort on an arbitrary function output. Reach
for `<->` via `$queryRaw` when you need top-K by distance on a big
table:

```ts
type Row = { id: string; name: string; meters: number };

const point = `SRID=4326;POINT(${lng} ${lat})`;
const rows = await db.$queryRaw<Row[]>`
  SELECT id, name,
         ST_Distance(location, ${point}::geography) AS meters
  FROM places
  WHERE org_id = ${orgId}
  ORDER BY location <-> ${point}::geography
  LIMIT 50
`;
```

Two notes:

- The `<->` operator for `geography` uses the **bounding box centroid**,
  not the true ellipsoidal distance. Top-K is approximate at the edges
  — fine for "find me nearby" UI, wrong for billing. Refine with
  `ST_Distance` after the LIMIT if exact ordering matters.
- The `<<->>` operator gives "centroid distance" between geometries,
  not points. Useful for "nearest polygon" queries.

### GiST vs SP-GiST

`USING GIST` (forge default) is right for most data — points,
polygons, mixed types. Switch to SP-GiST manually when:

- All your geometries are points and there are > 10M of them.
  SP-GiST builds smaller indexes.
- Read patterns are heavily skewed (one hot region) — SP-GiST's
  k-d-tree variant degrades more gracefully than GiST's R-Tree on
  hotspots.

Set this via a raw migration; forge's IR doesn't expose the index
algorithm yet:

```ts
await db.$executeRaw`
  DROP INDEX IF EXISTS idx_places_geo;
  CREATE INDEX idx_places_geo ON places USING SPGIST (location);
`;
```

`forge diff` will warn about the manual divergence — add the index
to your schema's `indexes` array with `method: 'spatial'` to silence
it (forge ignores the algorithm; it just needs to see a spatial
index of some kind on the column).

### `ST_DWithin` vs `ST_Distance`

Forge's `near` filter compiles to `ST_DWithin`, not
`ST_Distance(...) < N`. The difference is index usage:

- `ST_DWithin(a, b, N)` is pushed into the GiST index — runs in
  log(rows) on the bounded set.
- `ST_Distance(a, b) < N` calls the function for every row — full
  table scan.

If you ever write this by hand, always reach for `ST_DWithin`. The
forge IR does it for you.

### Centroid distance trick

When you need "what's nearest to this polygon", computing
`ST_Distance` polygon-to-polygon is expensive (PostGIS walks the
boundaries). Approximate with centroids first:

```ts
const candidates = await db.$queryRaw`
  WITH target AS (SELECT ST_Centroid($1::geometry) AS c)
  SELECT id, ST_Distance(ST_Centroid(boundary), target.c) AS d
  FROM districts, target
  ORDER BY ST_Centroid(boundary) <<->> target.c
  LIMIT 100
`;
```

Then refine the top-K with the real polygon distance. The
`<<->>` operator does the centroid sort using the index.

---

## Mongo 2dsphere and the $geoNear rewrite

MongoDB's spatial story has one footgun: `$geoNear` must be the
**first stage** of an aggregation, can only appear **once** per
pipeline, and its `query` clause **cannot contain another `$near`**.

That's fine when filter and orderBy reference the same field. It
breaks when you do this:

```ts
// "Customers within 5 km of warehouse W, ordered by distance to depot D."
const rows = await db.customer.findMany({
  where:   { warehouse: { near:   { lng: 3.30, lat: 6.50, withinMeters: 5000 } } },
  orderBy: { depot:     { nearTo: { lng: 3.45, lat: 6.44 } } },
});
```

Before 2.5, forge dropped the `near` filter silently and you got
"all customers ordered by depot distance" — wrong. 2.5 rewrites
the cross-field `$near` to `$centerSphere`:

```js
{
  $geoNear: {
    near: { type: 'Point', coordinates: [3.45, 6.44] },
    key: 'depot',
    distanceField: '_distanceMeters',
    spherical: true,
    query: {
      warehouse: {
        $geoWithin: {
          $centerSphere: [[3.30, 6.50], 5000 / 6_371_008.8],
        },
      },
    },
  },
}
```

`$centerSphere` measures the same great-circle distance as `$near`
(radians on a sphere of radius 6,371,008.8 m, WGS84 mean), and IS
allowed inside a `$geoNear.query`. The rewrite walks the filter
tree recursively — handles `$and` / `$or` / `$nor` mixes.

### What the rewrite costs

`$centerSphere` is a **bounding query**, not an indexed `$near`. The
2dsphere index still helps (it can prune by spherical caps), but
you lose the ordered streaming `$near` does on the same key. In
practice:

- Same-field `near` + `nearTo`: forge collapses to a single `$geoNear`
  with `maxDistance` set. Fast.
- Cross-field: forge rewrites the cross-field leaf to `$centerSphere`.
  Slightly slower than two separate index-backed queries but
  correct in one round-trip.

If profiling shows the rewrite is the bottleneck, split into two
queries — one to fetch the candidate ids near the warehouse, one
to sort the survivors near the depot — and join in app.

### Pipeline ordering rules

When forge composes a Mongo pipeline:

1. `$geoNear` first (if any `near` / `nearTo` is present).
2. `$match` stages for non-geo filters.
3. `$lookup` for relations selected via `include`.
4. `$sort` for non-distance orderBys.
5. `$skip`, `$limit`.
6. `$project` for `select`.

The non-negotiable is step 1. If you reach for `$queryRaw`-equivalent
(Mongo doesn't have it, but `db.$session.collection(...).aggregate(...)`
gives you the same), keep `$geoNear` first.

---

## Distance modes — sphere, ellipsoid, planar

Three models, three error budgets.

### Spherical (haversine, great-circle)

Treats Earth as a sphere of radius R = 6,371,008.8 m.

- Error vs the real ellipsoid: **up to 0.5%** worst case
  (equator-to-pole), typically **0.1–0.2%**.
- 500 m route: ±2.5 m worst case.
- 50 km route: ±250 m.
- 5,000 km transatlantic: ±25 km.

Forge's fallback mode, Mongo `$near`, MySQL `ST_Distance_Sphere`,
DuckDB `ST_Distance_Sphere`, and SpatiaLite default mode all use
this.

### Ellipsoidal (Vincenty / Karney)

Treats Earth as a WGS84 ellipsoid (a = 6,378,137 m,
f = 1 / 298.257_223_563).

- Error vs reality: **sub-millimetre** anywhere on Earth.
- The cost: each distance call solves an iterative formula —
  3–5× slower than haversine in CPU. Negligible in app-DB
  round-trip terms but matters for million-row scans.

PG `geography` distances, MSSQL `STDistance` on `GEOGRAPHY`, and
SpatiaLite's `Distance(g, g, 1)` (the `1` flag) use this.

### Planar (Cartesian)

Treats coordinates as Euclidean. Fine inside a single UTM zone or
for very short distances on a sufficiently local projection.

- 25 km in 3857 at the equator: ~0.1% error vs WGS84.
- 25 km in 3857 at 60° latitude: 100% error (Mercator stretches).
- 25 km in a matching UTM zone: < 0.005% error.

### Picking the mode

| Use case | Recommended | Why |
|---|---|---|
| "Within 5 km of me" | sphere (haversine) | Fast, 25 cm error, good enough for nearby search. |
| Driver-route distance estimate | ellipsoid | Compounds over the route. 0.2% on 50 km = 100 m off — borderline. |
| Aviation / shipping leg lengths | ellipsoid | Mandatory. Sub-metre matters. |
| Tile-pixel proximity | planar in 3857 | Matches the rendering coords. |
| "Inside the city limits" | sphere or planar | The polygon boundary is fuzzier than either error. |
| Billing-grade route distance | ellipsoid + real routing engine | Forge gets you to the polyline; OSRM/Valhalla gives you the road. |

---

## 3D coordinates

`f.geoPoint({ dims: 3 })` opts into XYZ storage. App-side shape
becomes `{ lng, lat, alt }`. The
[2.5 CHANGELOG table](../CHANGELOG.md#3d--z-coordinates)
shows the per-dialect column type.

### What `near` / `nearTo` actually compute

**Ground distance only.** Forge treats Z as a passive attribute —
it round-trips on read/write but doesn't enter the distance
formula. A drone at 100 m altitude over the same spot as a car on
the ground sees `_distanceMeters = 0` from the car.

This is intentional. Per-dialect 3D distance behaviour is wildly
inconsistent (PostGIS `ST_3DDistance` is true 3D Euclidean,
MongoDB has no 3D distance, MSSQL geography ignores Z, MySQL has
no native Z), so forge picks the most useful common denominator —
2D-on-sphere — and lets you opt into true 3D when you need it.

### When you actually need 3D Euclidean

True 3D Euclidean (sqrt((dx)² + (dy)² + (dz)²) over metres):

```ts
const Place = model('places', {
  id: f.id(),
  location: f.geoPoint(),
  vec3:     f.vector(3),   // x_m, y_m, z_m in a local frame
});

// Insert both — vec3 in a local ENU (East-North-Up) frame.
await db.place.create({
  data: {
    id: 'a',
    location: { lng: 3.45, lat: 6.44 },
    vec3:     [0, 0, 100],   // 100 m up from the origin
  },
});

// 3D nearest neighbour — true Euclidean via the vector index.
const near3d = await db.place.findMany({
  where: { vec3: { nearTo: [0, 0, 50], withinDistance: 75 } },
});
```

The [Vector chapter](../README.md#vector-similarity-search) covers
the rest. Vector indexes (HNSW on PG, M-Tree on DuckDB, sqlite-vec
on SQLite) give you index-supported KNN that geo can't.

### Aviation / drone use cases

A reasonable layout for drone telemetry:

- `f.geoPoint({ dims: 3 })` for the position record. Lets map UIs
  consume the lat/lng/alt directly.
- `f.vector(3)` in a UTM-local ENU frame for distance queries.
- A `f.geoPoint()` (2D) for the operator's geofence centre, with
  `withinPolygon` for the no-fly zone.

Update both fields on each tick. The 2D field drives the map; the
vector drives proximity alerts.

---

## MultiPolygon + GeometryCollection patterns

2.5 accepts four shapes for `withinPolygon`. They normalise to a
uniform `multiPolygon: Polygon[]` internally (each Polygon = `Ring[]`,
each Ring = `Array<{lng, lat}>`). See
[`src/adapters/shared/wkt.ts`](../src/adapters/shared/wkt.ts) for
the WKT emit and
[`src/geo/fallback.ts`](../src/geo/fallback.ts) for
`pointInMultiPolygon`.

### Admin boundaries with holes

Vatican-in-Italy, San Marino-in-Italy, Lesotho-in-South Africa —
real admin boundaries have holes. The legacy single-ring shape
can't represent them. Use the Polygon form:

```ts
const italy = {
  type: 'Polygon' as const,
  rings: [
    outerItalyRing,            // closed ring around Italy
    vaticanCityHole,           // closed ring of the Vatican
    sanMarinoHole,             // closed ring of San Marino
  ],
};

const inside = await db.address.findMany({
  where: { location: { withinPolygon: italy } },
});
```

The fallback ray-cast walks each ring with parity flipping — a
point inside the outer AND inside a hole flips twice and is
correctly classified as outside. The same query on PG/MSSQL emits
a WKT polygon with multiple rings and `ST_Contains` / `STContains`
handles holes natively.

### Service-area unions

Multiple disjoint shapes — a delivery service with three regions
that aren't contiguous:

```ts
const serviceArea = {
  type: 'MultiPolygon' as const,
  polygons: [
    [eastZoneOuter, eastZoneHole],
    [westZoneOuter],
    [northSatelliteOuter],
  ],
};

const candidates = await db.customer.findMany({
  where: { location: { withinPolygon: serviceArea } },
});
```

`MULTIPOLYGON(((…)),((…)),((…)))` on the SQL dialects; GeoJSON
`MultiPolygon` on Mongo. The fallback short-circuits as soon as a
point matches any constituent polygon.

### Postal code polygons

UK postcode districts (`SW1A`, `EC1V`) are typically loaded as
MultiPolygons — a single postcode can include offshore islands
or detached fragments. Workflow:

1. Ingest the ONS postcode polygon dataset (GeoJSON) into a
   reference table:

   ```ts
   const Postcode = model('postcodes', {
     code:    f.string().primaryKey(),
     polygon: f.json(),   // raw GeoJSON MultiPolygon
   });
   ```

2. Resolve incoming address points by looping the codes the
   address's bbox overlaps and refining:

   ```ts
   const candidates = await db.postcode.findMany({
     where: { /* spatial bbox prefilter via JSON expression */ },
   });
   for (const c of candidates) {
     const hit = await db.address.findMany({
       where: { location: { withinPolygon: c.polygon } },
       take: 1,
     });
     if (hit.length) return c.code;
   }
   ```

In practice you want to store the polygon in the dialect's native
geo type (not JSON) so PostGIS's `ST_Contains` can use the GiST
index. Forge models don't yet declare polygon columns natively —
use `$executeRaw` for the DDL and `$queryRaw` for the lookup; the
forge model handles only the points.

### Point-in-polygon perf cliffs

PG / MSSQL handle 10k-vertex polygons fine on a single query.
When you query the same polygon 10k times in a batch (one address
batch against one service-area MultiPolygon), the per-call
geometry parse adds up.

PostGIS-only trick — `ST_PreparedGeometry`:

```ts
await db.$queryRaw`
  WITH area AS (
    SELECT ST_GeomFromGeoJSON(${JSON.stringify(serviceArea)}) AS g
  )
  SELECT addresses.id
  FROM addresses, area
  WHERE ST_Contains(area.g, addresses.location::geometry);
`;
```

The CTE materialises the polygon once. PostGIS internally builds
a `PreparedGeometry` for the join and reuses the indexed edge tree
across all rows. 10–50× faster than a literal subquery per row.

---

## GeoJSON pipeline

GeoJSON is the lingua franca for geo data — Mapbox, Leaflet,
ogr2ogr, Natural Earth, OpenStreetMap export tools all speak it.
Forge's geo IR is **not** GeoJSON — it's `{lng, lat}` for points
and the normalised polygon shape above. The boundary is at the
adapter layer.

### FeatureCollection to forge create

```ts
import { readFile } from 'node:fs/promises';

const fc: FeatureCollection = JSON.parse(
  await readFile('./places.geojson', 'utf8'),
);

await db.$transaction(async (tx) => {
  for (const feature of fc.features) {
    if (feature.geometry.type !== 'Point') continue;
    const [lng, lat, alt] = feature.geometry.coordinates;
    await tx.place.create({
      data: {
        id:       feature.properties!.id,
        name:     feature.properties!.name,
        location: alt != null ? { lng, lat, alt } : { lng, lat },
      },
    });
  }
});
```

GeoJSON's coordinate order is `[lng, lat, alt?]` — same as forge's
`{lng, lat, alt}`. No reordering needed.

### Simplification before insert

Polygons exported from OSM commonly have one vertex per metre.
Inserting unmodified eats index space and slows queries. Run
Douglas–Peucker before insert:

```ts
import simplify from 'simplify-js';

function simplifyRing(ring: Array<{lng: number; lat: number}>) {
  const pts = ring.map((p) => ({ x: p.lng, y: p.lat }));
  // tolerance in degrees — 0.0001 ≈ 11 m at the equator.
  return simplify(pts, 0.0001, true).map((p) => ({ lng: p.x, lat: p.y }));
}
```

Pick the tolerance to match your render zoom. For city-level
polygons displayed at zoom 12 (web tile pixel ≈ 38 m), 0.0001°
is overkill; 0.001° (~110 m) renders identically.

### `ST_GeomFromGeoJSON` round-trip

When the polygon's source of truth is GeoJSON (a CMS, a Mapbox
draw control, a feature from an external API), don't unpack to
`{lng, lat}` arrays — go straight through PostGIS:

```ts
await db.$executeRaw`
  UPDATE service_areas
  SET boundary = ST_GeomFromGeoJSON(${JSON.stringify(feature.geometry)})
  WHERE id = ${areaId};
`;
```

PostGIS validates the GeoJSON, fixes ring winding (RFC 7946 vs PG
conventions differ), and stores natively. Read back as GeoJSON
with `ST_AsGeoJSON`:

```ts
const rows = await db.$queryRaw<{id: string; geojson: string}[]>`
  SELECT id, ST_AsGeoJSON(boundary) AS geojson
  FROM service_areas
  WHERE id = ${areaId};
`;
const geometry = JSON.parse(rows[0].geojson);
```

---

## Spatial joins

"Find every store within 5 km of every customer" — the classic
spatial join. Naïvely it's O(stores × customers); spatially-indexed
it's much closer to linear in the result size.

### PostGIS via `LATERAL` + `ST_DWithin`

```ts
type Pair = {
  customer_id: string;
  store_id: string;
  meters: number;
};

const pairs = await db.$queryRaw<Pair[]>`
  SELECT c.id AS customer_id,
         s.id AS store_id,
         ST_Distance(c.location, s.location) AS meters
  FROM customers c
  CROSS JOIN LATERAL (
    SELECT id, location
    FROM stores
    WHERE org_id = c.org_id
      AND ST_DWithin(location, c.location, 5000)
  ) s
  ORDER BY c.id, meters;
`;
```

The lateral subquery runs the GiST index on `stores.location` once
per customer — so for 10k customers × 1M stores it's 10k log(1M)
index probes, not 10^10 distance calls.

### Mongo $geoNear inside $lookup

Mongo's analog. `$lookup` can host a sub-pipeline; that sub-pipeline
can have its own `$geoNear` as the first stage. Reach for the
underlying collection — forge doesn't expose this in the
high-level surface yet:

```ts
const pairs = await db.$session.collection('customers').aggregate([
  { $match: { org_id: orgId } },
  {
    $lookup: {
      from: 'stores',
      let: { c_loc: '$location' },
      pipeline: [
        {
          $geoNear: {
            near: '$$c_loc',
            distanceField: 'meters',
            maxDistance: 5000,
            spherical: true,
          },
        },
        { $match: { $expr: { $eq: ['$org_id', orgId] } } },
      ],
      as: 'stores_nearby',
    },
  },
]).toArray();
```

Caveat — `$geoNear` doesn't actually accept a variable reference
in pre-7.0 Mongo. Workable on 7.0+; on older versions, denormalise
the join into the app layer (fetch customers, then `$geoNear` per
batch).

### What forge gives you, what falls back to raw

| Pattern | Forge surface? | Fallback |
|---|---|---|
| Single-side `near` + scalar predicate | Yes | n/a |
| Single-side `near` + `include` relation | Yes (relation join after the geo filter) | n/a |
| Two-side spatial join | No | Raw SQL on PG / MySQL / SQLite / DuckDB / MSSQL; raw aggregation on Mongo |
| K-nearest per row | No | PG `<->` operator inside `LATERAL`; Mongo `$geoNear` inside `$lookup` |

The trade-off is deliberate. Spatial joins aren't a Prisma-shape
operation; forcing them into a typed surface gives you something
brittle. Forge ships you the typed setup (declarations, `near`
single-side, GeoJSON round-trip) and gets out of the way for the
joins.

---

## Heatmaps and H3

Visualising a million points as raw markers is unworkable. Two
patterns:

- **Polygon overlay** — bucket points into admin polygons,
  colour by count. Requires a polygon dataset.
- **H3 grid** — Uber's hexagonal hierarchical index. Tile-free,
  uniform cell size globally, multiple resolutions.

H3 plays well with forge: store the index alongside the point and
query by index when you want aggregation, by point when you want
precision.

### Storing H3 indexes

```ts
import { latLngToCell } from 'h3-js';

const Event = model('events', {
  id:       f.id(),
  org_id:   f.string(),
  location: f.geoPoint(),
  h3_r7:    f.string(),   // resolution 7 — ~5 km² cells
  h3_r9:    f.string(),   // resolution 9 — ~0.1 km² cells
}, {
  indexes: [
    { keys: { location: 1 }, method: 'spatial', name: 'idx_events_geo' },
    { keys: { org_id: 1, h3_r7: 1 }, name: 'idx_events_h3_r7' },
    { keys: { org_id: 1, h3_r9: 1 }, name: 'idx_events_h3_r9' },
  ],
});

// At write time:
async function insertEvent(input: { id: string; orgId: string; lng: number; lat: number }) {
  await db.event.create({
    data: {
      id:       input.id,
      org_id:   input.orgId,
      location: { lng: input.lng, lat: input.lat },
      h3_r7:    latLngToCell(input.lat, input.lng, 7),
      h3_r9:    latLngToCell(input.lat, input.lng, 9),
    },
  });
}
```

### Aggregation

```ts
// Heatmap at city zoom.
const cells = await db.event.groupBy({
  by: ['h3_r7'],
  where: { org_id: orgId, ts: { gte: since } },
  _count: { _all: true },
});
// Resolve h3_r7 cell to centroid lat/lng in app via cellToLatLng().
```

H3 wins over spatial-index aggregation because grouping by a
string column is what every SQL engine is fastest at. PostGIS can
compute hex grids via `ST_HexagonGrid`, but the join is more
expensive than a string GROUP BY.

### Retrieval

For "show me every event within 5 km of here":

- If the query is rare and exact: use the `location` field with
  `near`.
- If the query is the hot path: precompute a `kRing(centerCell, k)`
  in app, query by `h3_r9: { in: cells }`. Skips the spatial index
  entirely and hits the B-tree on `h3_r9`. Up to 100× faster on
  > 1M-row tables.

---

## Realtime tracking

Vehicle / driver / asset position updates — high write rate, small
result reads, fast staleness. Three concrete recommendations.

### Partial index on `active = true`

A fleet of 1M vehicles where only 5k are active at any moment
shouldn't have a spatial index covering inactive rows. Partial
indexes:

```ts
const Vehicle = model('vehicles', {
  id:       f.id(),
  org_id:   f.string(),
  location: f.geoPoint(),
  active:   f.boolean(),
  ts:       f.dateTime(),
}, {
  indexes: [
    {
      keys: { location: 1 },
      method: 'spatial',
      name: 'idx_vehicles_active_geo',
      where: { active: { eq: true } },
    },
  ],
});
```

The 2.2 release added partial-filter indexes
([CHANGELOG 2.2.0](../CHANGELOG.md#220--indexdef-coverage-compile-api-softdelete-on-compile-semanticop)).
On PG the SQL is `CREATE INDEX … WHERE active = true`; on Mongo
it's `partialFilterExpression`; on MySQL it emulates via a
generated column. Spatial index size scales with active rows, not
total rows.

### Throughput at 1k updates/sec

Spatial indexes are write-amplifying — every update touches the
geo index plus the row. At 1k updates/sec on PG:

- `UPDATE vehicles SET location = …, ts = …` is fine on a single
  primary up to ~5k/sec — the GiST rebalance is cheap on a small
  active set.
- The pattern that breaks first is the `ts` index, not the
  `location` index, if you're sorting by recency.
- For > 5k/sec, batch updates per device with a 250 ms window in
  app — most location updates compress to "last known position
  per vehicle" anyway.

### Mongo TTL collection for trailing positions

The "where is vehicle V in the last 5 minutes" pattern wants
recent positions, not the full history. Mongo's TTL index keeps
the collection small without app-side pruning:

```ts
const Position = model('positions', {
  id:       f.id(),
  veh_id:   f.string(),
  location: f.geoPoint(),
  ts:       f.dateTime(),
}, {
  indexes: [
    { keys: { veh_id: 1, ts: -1 }, name: 'idx_positions_veh_ts' },
    { keys: { location: 1 }, method: 'spatial', name: 'idx_positions_geo' },
    {
      keys: { ts: 1 },
      name: 'ttl_positions_ts',
      expireAfterSeconds: 300,   // 5 minutes
    },
  ],
});
```

The TTL index — a [Mongo-only feature](../README.md#indexes-and-unique-constraints)
on the IR — drops old rows in the background. Spatial index stays
small; query latency stays flat under sustained 1k/sec.

PG analog: a daily partition + drop. Forge's IR doesn't generate
table partitions, but a cron-managed `DROP TABLE positions_2026_06_22`
combined with a view over `UNION ALL` of the recent partitions is
the standard pattern.

---

## Testing geo

Geo tests fail in the worst way — they pass on your machine,
they fail in CI when the floating-point library is off by 2 ULPs,
they pass again when you re-run. Three rules.

### Deterministic lat/lng fixtures

Don't randomise. Pick reference coordinates and stick to them:

```ts
const REF = {
  lekki:        { lng: 3.4505, lat: 6.4416 },   // Lagos
  ikoyi:        { lng: 3.4350, lat: 6.4500 },   // ~1.6 km from lekki
  vi:           { lng: 3.4225, lat: 6.4275 },   // ~3.5 km from lekki
  ikeja:        { lng: 3.3500, lat: 6.6000 },   // ~22 km from lekki
} as const;
```

Reuse the same set across tests. Distances are stable to 0.1 m
across haversine / Vincenty implementations, so assertions that
target ±10 m are safe.

### Distance assertions with epsilon

Never `expect(distance).toBe(1600)`. Always:

```ts
expect(distance).toBeCloseTo(1600, -2);   // within ±50 m (precision = -2 → tolerance 5×10^2)
```

Or define an explicit helper:

```ts
function expectMeters(actual: number, expected: number, epsilonM = 10) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(epsilonM);
}
```

The epsilon should reflect the model: 1 m for ellipsoidal, 10 m
for spherical at city distances, 100 m for planar over 50 km.

### What to mock, what to hit real

Mock — forge's `db.*.findMany({...})` surface in pure-IR tests.
The compile layer is unit-tested already in the forge repo.

Hit a real DB — anything that exercises:

- The dialect's spatial index choosing the right plan.
- WKT round-trips through `ST_GeomFromText`.
- The fallback ray-cast against a non-trivial polygon (a
  C-shape, a polygon with a hole).
- Mongo's `$geoNear` rewrite (the [2.5 cross-field fix](../CHANGELOG.md#mongo-near--nearto-cross-field)).

The forge repo's `regression-geo-duckdb.ts` and the geo cases in
`integration-pg.ts` / `integration-mongo.ts` show the pattern: a
Docker-Compose-managed PG + PostGIS, a Mongo replica set, a DuckDB
in-memory adapter. Adopt the same shape — `docker compose up`
in CI, real engine, fixtures from the deterministic set above.

For browser testing, the
[custom wasm build](../README.md#custom-wasm-build-vec0--r-tree) with
R-Tree compiled in is the only way to test the native code path
in jest-environment-jsdom; without it you're testing the fallback
mode regardless of intent. Set `FORGE_WASM_PRO_URL` to point at
the local artifact and the jest worker picks it up.
