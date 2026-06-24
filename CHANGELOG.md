# Changelog

All notable changes to **forge** (`forge-orm`). Forge is a Prisma-shape
multi-database wrapper for MongoDB, PostgreSQL, MySQL, SQLite, DuckDB and
SQL Server — one code path, no codegen, no external query engine.

## 2.5.0 — MSSQL `MERGE` upsert, Mongo cross-field `nearTo`, browser `$doctor`/`$diff`, MultiPolygon + GeometryCollection, 3D / Z coordinates, non-WGS84 SRIDs

**Feature release.** Closes the entire "Coming soon" list from 2.4, plus a
few items previously marked TBD. Drop-in upgrade — no breaking changes; the
geo IR's `withinPolygon` value shape grew a `multiPolygon` field but the
legacy `polygon` shape is still accepted by every consumer.

### MSSQL upsert via `MERGE`

`compileUpdate` now emits a real T-SQL `MERGE` when `upsertCreate` is set:

```sql
MERGE INTO [items] AS tgt
USING (VALUES (@p1, @p2, @p3)) AS src ([sku], [name], [qty])
ON tgt.[sku] = src.[sku]
WHEN MATCHED THEN UPDATE SET [qty] = @p4
WHEN NOT MATCHED THEN INSERT ([sku], [name], [qty])
VALUES (src.[sku], src.[name], src.[qty])
OUTPUT INSERTED.*;
```

- Conflict target derived from the wrapper's eq-leaf where tree (same
  rule as the PG path: single-column or AND-of-eq).
- Conflict columns missing from `upsertCreate` are pulled from the where
  leaf so the INSERT branch is always complete.
- Supports `set`, `increment` (`COALESCE(tgt.[col], 0) + …`), `multiply`,
  and `unset` (`= NULL`) on the UPDATE branch.
- Returns the row via `OUTPUT INSERTED.*`, matching PG's `RETURNING`.

The previous 2.3 / 2.4 NotImplemented throw is gone. Atomic upsert works
on every dialect now.

### Mongo `near` + `nearTo` cross-field

A `near` filter on field A combined with a `nearTo` orderBy on field B
used to drop A (the `$geoNear` stage's `query` clause can't contain
`$near`). The fix: walk the artifact filter once, and for every cross-
field `$near` rewrite to:

```js
{ A: { $geoWithin: { $centerSphere: [[lng, lat], meters / 6_371_008.8] } } }
```

This is semantically equivalent (`$centerSphere` uses radians on the
sphere) and IS valid inside a `$geoNear.query` clause, so both filter
and orderBy fire in the same aggregation. Same-field `$near` still
collapses to `maxDistance` on the stage as before. Handles `$and` / `$or`
/ `$nor` walks recursively.

### Browser `$doctor()` and `$diff()`

The runtime equivalents of `forge doctor` and `forge diff`:

```ts
const doctor = await db.$doctor();   // BrowserDoctorReport on sqlite, DoctorReport elsewhere
const drift  = await db.$diff();     // DriftReport for every adapter
```

On sqlite adapters (including the wasm one), `$doctor()` routes through
the same `browserDoctor()` introduced in 2.4 — environment probe (OPFS,
SAB, persistent storage) + sqlite probe (FTS5, R-Tree, sqlite-vec) + a
forge-feature → status table. On other adapters it returns the existing
`adapter.doctor()` shape.

`$diff()` reads `adapter.introspect()` and runs the existing
`diffIntrospection` engine, so the same drift detection that backs the
CLI now works in-browser. Accepts the same `ignore` spec (string or
RegExp patterns) the CLI takes via `--ignore`.

### MultiPolygon + GeometryCollection

`where: { col: { withinPolygon: … } }` now accepts:

```ts
// 1. Single ring (legacy — unchanged):
{ withinPolygon: [{lng, lat}, {lng, lat}, …] }

// 2. Polygon with holes:
{ withinPolygon: { type: 'Polygon', rings: [outerRing, hole1, hole2, …] } }

// 3. MultiPolygon (multiple disjoint shapes):
{ withinPolygon: { type: 'MultiPolygon', polygons: [[outer1, …holes], …] } }

// 4. GeometryCollection (flattened to its constituent polygons):
{ withinPolygon: { type: 'GeometryCollection', geometries: [Polygon | MultiPolygon, …] } }
```

The IR normalises all four to a uniform `multiPolygon: Polygon[]` shape
(each Polygon = `Ring[]`, each Ring = closed `Array<{lng,lat}>`). Every
dialect compiler consumes the normalised shape:

- New `src/adapters/shared/wkt.ts` — `toGeoWKT(mp, axis)` emits `POLYGON((…))`
  for a single ring or `MULTIPOLYGON(((…)))` for everything else; handles
  the MySQL lat-first axis-order quirk via the `axis` param.
- `toGeoJson(mp)` emits GeoJSON Polygon / MultiPolygon for the Mongo path.
- `multiPolygonBbox(mp)` computes the union envelope for the SQL fallback
  prefilter.

Fallback ray-cast (`pointInMultiPolygon`) honours holes via the even-odd
rule — a point inside an outer ring AND inside one of its hole rings is
NOT considered inside the polygon. MultiPolygons short-circuit as soon as
any constituent polygon contains the point.

### 3D / Z coordinates

`f.geoPoint({ dims: 3 })` opts into XYZ storage. The TS-side shape becomes
`{ lng, lat, alt }` and the per-dialect emit:

| Dialect | dims = 2 (default) | dims = 3 |
|---|---|---|
| PG | `geography(Point, srid)` | `geography(PointZ, srid)` — PostGIS auto-promotes from `POINT Z(x y z)` WKT |
| MySQL | `POINT NOT NULL SRID srid` | Same column type; altitude stored alongside in a JSON field per app (MySQL 8 has no native 3D) |
| SQLite | `GeomFromText('POINT(x y)', srid)` | `GeomFromText('POINT Z(x y z)', srid)` — SpatiaLite |
| DuckDB | `ST_Point(x, y)` | `ST_Point3D(x, y, z)` — spatial extension's 3D type |
| MSSQL | `STGeomFromText('POINT(x y)', srid)` | `STGeomFromText('POINT(x y z)', srid)` — geography accepts Z |
| Mongo | GeoJSON `coordinates: [lng, lat]` | GeoJSON `coordinates: [lng, lat, alt]` — 3-element form |

Distance semantics: `near` / `nearTo` still compute great-circle ground
distance (2D-on-sphere). Altitude round-trips on read/write but doesn't
participate in distance — see "3D distance mode" under "Coming soon".

### Non-WGS84 SRIDs

`f.geoPoint({ srid: 3857 })` (Web Mercator, OSGB 27700, NAD83, etc.) is
honoured at DDL time across every dialect. The PG path routes non-4326
SRIDs to `geometry(Point, srid)` instead of `geography(Point, srid)`
(geography is 4326-only). MySQL / SQLite / DuckDB / MSSQL accept the
declared SRID directly. Mongo only supports 4326 (2dsphere is WGS84-only)
— non-4326 fields run through fallback mode if `fallback: true`.

User responsibilities:

- Coordinates passed to `create` / `update` / `near` / `withinPolygon`
  must be in the **target SRID's units** — no auto-transformation at
  the IR layer.
- `proj4` (or per-dialect `ST_Transform`) at the call site is the
  recommended way to convert from 4326 to your storage SRID.
- A built-in `proj4`-backed transform is on the roadmap.

### Other changes

- New `src/adapters/shared/wkt.ts` — shared `toGeoWKT` / `toGeoJson` /
  `multiPolygonBbox` so every dialect emits the same WKT/GeoJSON form.
- `pointInPolygon` renamed to `pointInRing` internally + new
  `pointInMultiPolygon` honouring holes via even-odd. Legacy export
  alias preserved.
- `FallbackGeoOps.withinPolygon` shape extended to `multiPolygon` (the
  uniform internal form); old `polygon` shape still recognised for any
  caller building leaves by hand.
- 20 new jest unit tests covering MSSQL MERGE, MultiPolygon IR + WKT,
  point-in-multi-polygon with holes, 3D field shape + DDL, non-4326
  SRID DDL routing. Total: 465 tests, 35 suites, all green.

### Compatibility

- **Drop-in upgrade** for 2.4.x consumers. No schema or API changes for
  any server-side code path. The geo IR's `withinPolygon` value gained
  a `multiPolygon` field; the legacy `polygon` field is still accepted
  by every consumer.
- The MSSQL `MERGE` is a behaviour change for the upsert path (was a
  thrown error in 2.3 / 2.4) — apps that had a `try/catch` workaround
  can remove it.

### Known limitations carried into 2.6

- 3D distance mode — altitude is preserved but doesn't participate in
  `near` / `nearTo`. A 3D Euclidean or ground+vertical distance mode
  is the open question (per-dialect implementation choice).
- Auto SRID reprojection — declared SRID is honoured but coordinates
  are user-provided in target units. A `proj4`-backed transform at the
  IR boundary is on the roadmap.
- Pre-built `@forge-orm/sqlite-wasm-pro` artifact — the custom build is
  one shell command (`scripts/wasm-pro/build.sh`) today; the pre-built
  npm artifact is the next gap.

## 2.4.0 — Browser adapter: sqlite-wasm + OPFS, runtime `$migrate`, Vite/Next/Webpack plugins, browserDoctor, custom-build path for vec0 + R-Tree

**Feature release.** Adds a browser dialect: real SQLite (via
`@sqlite.org/sqlite-wasm`) running in a Web Worker, persisted on the Origin
Private File System (OPFS), with the same forge query surface every other
dialect uses. The IR, dialect emitter, executor, and DDL generator are
reused unchanged — only the connection backend is new.

### New driver — `wasmSqliteDriver`

`createDb({ schema, driver: wasmSqliteDriver({ worker, url }) })` opens a
SQLite database in the browser. Implements the existing `SqliteDriver` port
verbatim — `all` / `get` / `run` / `exec` / `close` — so every adapter call
path (executor, migrator, `$transaction`, `$queryRaw`) routes through it
without code changes. Serialises calls through a tiny promise queue, since
SQLite is single-writer at the file level and OPFS sync handles are
exclusive per origin.

### New URL schemes

`detectAdapterKind()` now recognises three browser-side prefixes, all
resolving to the `sqlite` kind:

| URL | VFS | Persistence | Multi-tab |
|---|---|---|---|
| `opfs-sahpool:<path>` | SAH-pool (recommended) | Full | Safe |
| `opfs:<path>` | Plain OPFS | Full | Single-tab writer |
| `:memory:` | In-memory | None | N/A |

### New worker module — `forge-orm/wasm/worker`

Ships a ready-to-bundle Web Worker that hosts sqlite-wasm. Consumers wire it
in via the standard `new Worker(new URL('forge-orm/wasm/worker', import.meta.url))`
pattern — Vite, Next, Webpack 5, Parcel, Rspack all resolve it natively.
Routes `opfs:` → `oo1.OpfsDb`, `opfs-sahpool:` → `installOpfsSAHPoolVfs() +
OpfsSAHPoolDb`, `:memory:` → `oo1.DB(':memory:')`. Sets `PRAGMA foreign_keys
= ON` at open. Best-effort detects sqlite-vec via `vec_version()`.

### Bundler plugins

Three zero-config helpers that take care of worker resolution + COOP/COEP
headers + the wasm asset rule:

- **`forge-orm/wasm/vite`** — `forgeWasm()` Vite plugin. Adds
  `optimizeDeps.exclude`, sets `worker.format: 'es'`, attaches COOP/COEP
  middleware to the dev server.
- **`forge-orm/wasm/next`** — `withForgeWasm(nextConfig)` wrapper. Enables
  `experiments.asyncWebAssembly` + `topLevelAwait`, adds a `.wasm`
  `asset/resource` rule, sets `experimental.esmExternals: 'loose'`, wraps
  `headers()` to emit COOP/COEP for the matched routes.
- **`forge-orm/wasm/webpack`** — `forgeWasmWebpack(config)` for webpack 5,
  CRA (via craco), Rsbuild. Same experiments + asset rule.

All three accept options to disable individual pieces (COOP/COEP, dep
optimizer exclusion, header injection) if the host app already handles
them.

### Runtime DDL apply — `db.$migrate()`

`forge push` is a Node CLI; the browser needs a runtime equivalent.
`db.$migrate()` reads the active schema, calls the same
`buildSqliteSchemaDDL` emitter `forge push` uses, filters out
already-existing tables/indexes via a `sqlite_master` lookup, and applies
the rest in one `BEGIN/COMMIT` batch.

Idempotent — safe to call on every app boot. Returns
`{ applied, skipped, failures }` matching the CLI report shape exactly.
Verbose mode via `db.$migrate({ logger: console.log })`.

Lower-level pieces are also exported (`buildSqliteSchemaDDL`,
`applySqliteMigration`, `runMigrate`) for apps that want to ship DDL as
a build-time asset.

### Runtime capability probe — `browserDoctor()`

The browser analog of `forge doctor`. Returns a structured
`BrowserDoctorReport` with:

- **environment**: runtime kind, OPFS availability, sync handle support,
  SharedArrayBuffer, persistent-storage state (granted / requestable /
  unavailable), estimated quota + usage.
- **sqlite**: version, json1, fts5, rtree, sqliteVec, foreign-keys state.
- **capabilities**: forge-feature → status table (native / fallback /
  unavailable). Surfaces FTS5 / R-Tree / sqlite-vec presence so apps know
  whether `f.text().searchable()` / `f.geoPoint()` / `f.vector()` run on
  the native code path or in fallback mode.
- **notes**: human-readable remediation hints — including the iOS Safari
  ITP 7-day eviction warning when persistent storage is requestable but
  not granted.

### Custom wasm build — `forge-orm/wasm/worker-pro`

The stock `@sqlite.org/sqlite-wasm` ships FTS5 + json1 but NOT R-Tree or
sqlite-vec, so `f.geoPoint()` and `f.vector()` run in fallback mode there.
This release adds a `scripts/wasm-pro/build.sh` Emscripten pipeline that
compiles a custom wasm bundle with **rtree + GeoPoly + sqlite-vec compiled
in**. The matching `worker-pro.ts` consumes the local artifact instead of
the npm package.

The build script fetches the SQLite amalgamation
(default 3.46.1, override via `SQLITE_VERSION`) and sqlite-vec
(default `v0.1.6`, override via `SQLITE_VEC_VERSION`), then drives `emcc` to
produce `sqlite3.{mjs,wasm}` (~1.6 MB). Output goes to `dist/wasm-pro/` by
default. Host the artifacts under your app and point the worker at them via
`FORGE_WASM_PRO_URL`.

A pre-built `@forge-orm/sqlite-wasm-pro` npm artifact is on the roadmap.

### Other changes

- `encodeParams` in the SQLite executor swaps `Buffer.isBuffer(v)` for a
  guarded check (`typeof Buffer !== 'undefined' && …`) plus a `Uint8Array`
  branch — needed so wasm/browser bundles don't blow up at module-eval
  time when `Buffer` isn't a global.
- `factory.ts` extends `ForgeDb` with `$migrate()` (sqlite-only — throws
  with a clear "use the CLI" message on Mongo / PG / MySQL / DuckDB / MSSQL
  adapters). Lazy-imports the migrator so non-sqlite bundles don't pull
  in the SQLite DDL emitter.
- New peer dependency: `@sqlite.org/sqlite-wasm` (`>=3.45.0`, optional).
- `tsconfig.lib.json` adds `DOM` + `WebWorker` libs so the wasm entrypoints
  can reference `Worker` / `MessageEvent` / `navigator.storage` / OPFS
  types.
- 6 new jest unit tests covering driver round-trips, error mapping, serial
  request queueing, close-during-pending semantics, and driver type-guards.
  Total: 445 tests, 34 suites, all green.

### Compatibility

- Existing 2.3.x consumers: drop-in. No schema changes, no API changes for
  any server-side dialect.
- Server-side SQLite (`sqlite:./app.db`, expo, op-sqlite, libsql) is
  unchanged. The Buffer guard tweak is the only runtime touch.
- Browser builds need the new peer dep `@sqlite.org/sqlite-wasm` and a
  bundler that supports `new Worker(new URL(...))` — modern Vite / Next /
  Webpack 5 / Parcel.

### Known limitations

- `db.$migrate()` doesn't yet do drift detection — it skips existing
  tables/indexes by name but doesn't `ALTER` columns. Hand-roll
  `$executeRaw` for schema evolution until full in-browser `forge diff`
  lands in 2.5.
- COOP/COEP headers are an app-wide concern. If a marketing page or auth
  callback embeds third-party scripts that don't send
  `Cross-Origin-Resource-Policy`, the embed breaks — narrow the matcher
  in `withForgeWasm()` or host the SQLite-using parts on a subdomain.
- The pro wasm build needs Emscripten installed and a one-time
  ~10-minute compile. The pre-built npm artifact will close this gap.

## 2.3.1 — README rewrite: complete field-type + modifier tables, full operator reference

**Docs-only release.** No runtime change. The 2.3.0 README hadn't been
re-syned end-to-end after the new features landed — `f.geoPoint()` and
`f.vector()` were absent from the Field types table, and the modifier
list was a code block rather than a table. This release rewrites the
README from start to finish:

- **Field types** table now lists every builder (`f.id` / `objectId` /
  `string` / `text` / `int` / `float` / `decimal` / `bigint` / `uuid` /
  `bool` / `dateTime` / `json` / `enumOf` / `embed` / `embedMany` /
  `stringArray` / `intArray` / **`geoPoint`** / **`vector`**) with TS
  type + per-dialect storage.
- **Field modifiers** is now a proper table covering all nine
  (`optional` / `unique` / `default(value)` / `default('now')` /
  `default('autoId')` / `updatedAt` / **`searchable`** /
  **`softDeleteAt`** / **`dbgenerated`**) with dialect quirks.
- **New top-level Operator reference table** covering every `where`
  operator (`equals` / `not` / `in` / `notIn` / `lt`-`gte` / `contains` /
  `startsWith` / `endsWith` / `mode` / `has` / `hasEvery` / `hasSome` /
  `isEmpty` / `some` / `every` / `none` / `search` / `path` / `near` /
  `withinPolygon` / `AND` / `OR` / `NOT`) keyed to the field kinds each
  applies to.
- **Geo** section split into proper subsections (per-dialect emit table,
  extensions, fallback mode, coord-order rule, polygon containment).
- **CLI** section now has subsections for `forge doctor` (with the
  per-dialect probe table), `--enable-extensions` (with a schema-feature
  → extension table), schema resolution, and `--ignore`.
- **Testing** picks up a Driver smoke harness subsection covering
  `npm run smoke:drivers`.
- **Wire-compatible databases** table extended with MotherDuck, Azure
  SQL Database, and Azure SQL Edge.
- **Built-in drivers** table extended with the DuckDB + MSSQL rows.
- **Reading data** sample now includes `findFirstOrThrow` /
  `findUniqueOrThrow` / `aggregate()`.
- **Limitations** updated with the DuckDB / MSSQL / Mongo geo
  caveats that landed in 2.3.

The TOC is rebuilt so every heading anchor resolves.

## 2.3.0 — DuckDB + MSSQL adapters, end-to-end geo, JSON path queries, vector search

**Feature release.** Two new dialects, a complete geo layer (schema, index,
typed `where`/`orderBy`, fallback mode, doctor probe, extension auto-install),
typed JSON path queries, and typed vector / similarity search. The wrapper
surface stays the same: every new feature works through `findMany` /
`create` / etc. with the same code on every dialect.

### Two new database adapters

**DuckDB.** Embedded analytical OLAP database — PG-compatible SQL with no
FK enforcement. Bundled `spatial` extension auto-loads at connect; `vss`
extension is available for vector search.

```ts
import { createDb, duckdbDriver } from 'forge-orm';
import { DuckDBInstance } from '@duckdb/node-api';

const instance = await DuckDBInstance.create('analytics.duckdb');
const connection = await instance.connect();
const db = await createDb({ schema, driver: duckdbDriver(connection) });
```

URL prefix: `duckdb:` (e.g. `duckdb:./data.duckdb`, `duckdb::memory:`).
Capabilities: ACID transactions, parallel scans, columnar storage. No
foreign-key enforcement (forge's app-side cascade walker handles it),
no `SAVEPOINT` (migration failures abort the batch).

**SQL Server (MSSQL).** Cross-platform Linux/Windows. On ARM Macs the
`doctor` probe + `smoke:drivers` script default to `azure-sql-edge`
(multi-arch); on x86 the full `mssql/server:2022-latest` image works
natively.

```ts
import { createDb, mssqlDriver } from 'forge-orm';
import sql from 'mssql';

const pool = await sql.connect({ server: 'localhost', user: 'sa', password: '…', database: 'app' });
const db = await createDb({ schema, driver: mssqlDriver(pool) });
```

URL prefix: `mssql:` / `sqlserver:`. Capabilities: ACID, native cascades,
`GEOGRAPHY` built-in, `VECTOR(N)` on SQL Server 2025 / Azure SQL. T-SQL
specifics handled by the compile layer:

- `[brackets]` for identifiers, `@p1,@p2,…` named placeholders
- `LIMIT/OFFSET` → `OFFSET … ROWS FETCH NEXT … ROWS ONLY`
- `RETURNING *` → `OUTPUT INSERTED.*` / `OUTPUT DELETED.*`
- PG's `ctid` single-row trick → `[pk] IN (SELECT TOP 1 [pk] …)`
- `IF NOT EXISTS` wrapped in `IF NOT EXISTS (SELECT 1 FROM sys.tables …) BEGIN … END`
- `CREATE EXTENSION` replaced with the equivalent built-in feature

Upsert (`ON CONFLICT`) is **not** supported in 2.3 — the T-SQL `MERGE`
rewrite lands in 2.4. Until then, do `findFirst → update / create` at the
app layer when targeting MSSQL.

### Driver smoke harness — verify every driver installs + connects in isolation

`scripts/driver-smoke.mjs` creates a throwaway tmpdir, `npm install`s every
driver forge-orm supports plus `testcontainers`, runs a minimal `connect →
SELECT 1 → close` per driver, prints a results table, and tears the tmpdir
and any running containers down. Useful for confirming a Node upgrade or
a published forge-orm release won't break against the underlying clients
in the wild.

```bash
npm run smoke:drivers              # everything
npm run smoke:drivers -- --only=pg # filter by substring(s)
npm run smoke:drivers -- --keep    # leave tmpdir for inspection
npm run smoke:drivers -- --verbose # surface npm install output
```

Covers: `better-sqlite3`, `@libsql/client`, `@duckdb/node-api` (embedded);
`pg`, `postgres` (porsager), `mysql2`, `mariadb`, `mongodb`, `mssql`
(server, via Testcontainers); `expo-sqlite`, `@op-engineering/op-sqlite`
(install-only — exec needs an iOS/Android runtime); `@planetscale/database`
(skipped without `PLANETSCALE_URL`).

ARM Macs: the MSSQL container auto-swaps to `azure-sql-edge` (multi-arch)
instead of the AMD64-only `mssql/server:2022`. First-run cost is dominated
by Docker image pulls (~3-6 min cold, ~15s warm).

### Geo — `f.geoPoint()`, spatial indexes, typed near / nearTo / withinPolygon

Schema-level geo, end-to-end. The same code targets MongoDB, Postgres
(with PostGIS), MySQL 8 spatial, SQLite + SpatiaLite, DuckDB spatial, and
SQL Server's `GEOGRAPHY`.

```ts
const Place = model('places', {
  id: f.id(),
  name: f.string(),
  location: f.geoPoint(),                       // WGS84 / SRID 4326
}, {
  indexes: [{ keys: { location: 1 }, method: 'spatial' }],
});

// Insert — always { lng, lat }. Coord-order quirks handled by the compiler.
await db.place.create({
  data: { id: 'a', name: 'Lekki', location: { lng: 3.4505, lat: 6.4416 } },
});

// "Find places within 5 km of me, closest first, top 20".
const nearby = await db.place.findMany({
  where:   { location: { near: { lng: 3.45, lat: 6.44, withinMeters: 5000 } } },
  orderBy: { location: { nearTo: { lng: 3.45, lat: 6.44 } } },
  take: 20,
});
// nearby[0]._distanceMeters ≈ 0  (meters from the search point)
```

**Per-dialect compile**:

| Dialect | Column | Spatial index | `near` filter | `nearTo` orderBy |
|---|---|---|---|---|
| Mongo | GeoJSON in JSON | `2dsphere` | `$near + $maxDistance` | `$geoNear` aggregate (auto-routed) |
| Postgres | `geography(Point, 4326)` | `USING GIST` (PostGIS) | `ST_DWithin(...)` | `ST_Distance(...) AS _distanceMeters` |
| MySQL 8 | `POINT NOT NULL SRID 4326` | `CREATE SPATIAL INDEX` | `ST_Distance_Sphere(...) < N` | `ST_Distance_Sphere(...) AS _distanceMeters` |
| SQLite | `BLOB` (SpatiaLite) | virtual `idx_<tbl>_<col>` | `Distance(..., 1) < N` | `Distance(..., 1) AS _distanceMeters` |
| DuckDB | `GEOMETRY` (spatial ext) | `USING RTREE` | `ST_Distance_Sphere(...) < N` | `ST_Distance_Sphere(...) AS _distanceMeters` |
| MSSQL | `GEOGRAPHY` | `CREATE SPATIAL INDEX` | `col.STDistance(...) < N` | `col.STDistance(...) AS _distanceMeters` |

**Polygon containment**:

```ts
const inside = await db.place.findMany({
  where: {
    location: {
      withinPolygon: [
        { lng: 3.20, lat: 6.35 },
        { lng: 3.60, lat: 6.35 },
        { lng: 3.40, lat: 6.55 },        // 3+ vertices; ring auto-closes
      ],
    },
  },
});
```

Compiles to `ST_Within` / `Within` / `STContains` / `$geoWithin` per
dialect. Fallback mode emits a bbox prefilter from the polygon's axis-
aligned envelope and runs ray-casting point-in-polygon in app — concave
polygons work correctly.

**Fallback mode** for environments without the spatial extension:

```ts
location: f.geoPoint({ fallback: true }),    // JSON storage + Haversine
```

Column becomes JSON `{lng, lat}`. SQL emits a degrees-radius bbox
prefilter on the JSON-extracted lng/lat, and the adapter runs an exact
Haversine refinement + sort in app. Slower than native (no index on JSON
path; O(n) within bbox), but works without any extension. Fine for
prototypes and small datasets; migrate to native when traffic justifies.

The Haversine post-filter is wired into the Postgres, MySQL, SQLite,
DuckDB, and MSSQL executors. The Mongo executor doesn't have a fallback
mode (Mongo's 2dsphere is built-in).

**`forge doctor` extension probe**:

```bash
$ forge doctor

  Live capability probe:
    ✓ Postgres 16.2 reachable
    ⚠ PostGIS NOT installed
           Install: CREATE EXTENSION postgis;
    ⚠ pg_trgm NOT installed
           Install: CREATE EXTENSION pg_trgm;
```

Per dialect, doctor connects (best-effort), reads the version + extension
list, and prints actionable install commands. Failures don't raise — the
probe stays optional so the env-only output is still useful when the DB
is down.

**`forge push --enable-extensions`**: when the schema declares geoPoint
fields and you pass `--enable-extensions`, push issues
`CREATE EXTENSION IF NOT EXISTS postgis;` before the table DDL. DuckDB
always `LOAD spatial`s at connect time. SQLite tries `load_extension('mod_spatialite')`
silently at connect time.

**Mongo `nearTo` without `near`** auto-routes to a `$geoNear` aggregate
pipeline (which would otherwise be a community-only no-op). Direction
flipping (asc/desc) is honored.

### JSON path queries — typed reads + comparisons on nested JSON

The `jsonPath` op (reserved in the IR since 2.1) is now implemented across
all six dialects. User-facing shape:

```ts
const Doc = model('docs', { id: f.id(), meta: f.json() });

// Dotted-path navigation, with the same scalar comparison vocabulary as
// regular `where`: eq / ne / gt / gte / lt / lte / contains / in / has.
await db.doc.findMany({
  where: { meta: { path: 'profile.age', gte: 18 } },
});

// Array indexing with `[N]` syntax.
await db.doc.findMany({
  where: { meta: { path: 'addresses[0].city', eq: 'Lagos' } },
});

// Pass an explicit segment array if you prefer.
await db.doc.findMany({
  where: { meta: { path: ['tags', '0'], eq: 'urgent' } },
});

// Substring on the extracted value.
await db.doc.findMany({
  where: { meta: { path: 'bio', contains: 'engineer' } },
});
```

Per-dialect compile:

- **PG** — `(col->'a'->'b'->>'c')::numeric` with auto-cast based on
  operand type. Array indexes are emitted as numeric `->N` segments.
- **MySQL** — `JSON_UNQUOTE(JSON_EXTRACT(col, '$.a.b.c'))`. UNQUOTE
  unwraps the JSON-wrapped string so equality against a plain param works.
- **SQLite** — `json_extract(col, '$.a.b.c')` (JSON1 extension; built-in
  in modern builds).
- **DuckDB** — `json_extract(col, '$.a.b.c')`.
- **MSSQL** — `JSON_VALUE(col, '$.a.b.c')`.
- **Mongo** — dotted-key form: `{ 'meta.profile.age': { $gte: 18 } }`.

Works on `f.json()` / `f.embed()` / `f.embedMany()` / `f.stringArray()` /
`f.intArray()` fields. Non-JSON fields raise a clear error.

### Vector — `f.vector(dims)`, vector indexes, typed similarity search

The same `near` / `nearTo` vocabulary as geo, applied to embedding vectors.
Production-grade similarity search across PG (pgvector), MySQL 9.0+,
SQLite (sqlite-vec), DuckDB (vss), MSSQL (SQL Server 2025 / Azure SQL),
and Mongo (Atlas Vector Search).

```ts
const Doc = model('docs', {
  id: f.id(),
  body: f.text(),
  embedding: f.vector(1536, { metric: 'cosine' }),    // OpenAI text-embedding-3-small
}, {
  indexes: [{ keys: { embedding: 1 }, method: 'vector' }],
});

await db.doc.create({
  data: { id: 'a', body: 'cat', embedding: [0.1, 0.2, /* … 1536 floats … */] },
});

// "Top-10 nearest documents to my query vector, within 0.4 cosine distance."
const matches = await db.doc.findMany({
  where:   { embedding: { near: { vector: queryVec, withinDistance: 0.4 } } },
  orderBy: { embedding: { nearTo: queryVec } },
  take: 10,
});
// matches[0]._distance ≈ 0  (cosine distance to the query vector)
```

Metrics: `'cosine'` (default — most embedding models), `'l2'` (Euclidean),
`'dot'` (inner product). Pick to match your embedding model's docs.

**Per-dialect compile**:

| Dialect | Column | Vector index | `near` filter | `nearTo` orderBy |
|---|---|---|---|---|
| Postgres | `vector(N)` (pgvector) | `USING hnsw (col vector_<metric>_ops)` | `(col <=> $vec) < $d` | `col <=> $vec AS _distance` |
| MySQL 9 | `VECTOR(N)` | basic — exact only (community) | `DISTANCE(col, STRING_TO_VECTOR(...), 'COSINE') < $d` | `DISTANCE(...) AS _distance` |
| SQLite | TEXT (JSON) | needs `sqlite-vec` vec0 virtual table (out-of-band) | brute-force / vec0 raw query | not portable |
| DuckDB | `FLOAT[N]` | `USING HNSW` (vss extension) | `array_cosine_distance(col, [...]) < $d` | `array_cosine_distance(...) AS _distance` |
| MSSQL | `VECTOR(N)` | `USING VECTOR WITH (algorithm = 'HNSW')` | `VECTOR_DISTANCE('cosine', col, ...) < $d` | `VECTOR_DISTANCE(...) AS _distance` |
| Mongo | plain array | Atlas Search Index (createSearchIndex) | routed to `$vectorSearch` pipeline | routed to `$vectorSearch` pipeline |

**Dimension validation**: `f.vector(1536)` rejects a 1024-dim query vector
at IR-build time with a clear error — catches embedding-model mismatches
before they hit the DB.

**Extensions**:
- PG: `CREATE EXTENSION vector;` — works on every managed PG host
  (Supabase, Neon, RDS, Crunchy, …)
- DuckDB: `INSTALL vss; LOAD vss;` — adapter auto-loads `spatial`; `vss`
  is one extra `connection.run` away
- SQLite: install `sqlite-vec` extension; the vec0 mirror table is
  created out-of-band (forge doesn't manage it)
- MySQL: 9.0+ has the type built-in; HeatWave Vector Store adds HNSW/IVF
- MSSQL: SQL Server 2025 / Azure SQL only
- Mongo: Atlas Vector Search (Atlas-only, not on-prem)

When a method is unavailable on the target DB, the index emission warns
clearly (e.g. "Mongo vector indexes live in Atlas Search, not createIndex
— create via Atlas UI/CLI").

### Other changes

- **Schema linter (`forge doctor`)** now recognises `'vector'` and
  `'spatial'` as portable methods and points users at the right install
  command when the live DB lacks the extension.
- **`AdapterKind`** widened to include `'duckdb' | 'mssql'`. The `Dialect`
  interface's `name` union and the `SQLDialect` compile union widened to
  match.
- **`Dialect` gains** `valueExpr` (per-field insert/update wrapping for
  geo + vector), `geoNearClause` / `geoDistanceExpr` / `geoWithinPolygonClause`
  (geo compile hooks), `vectorDistanceClause` / `vectorDistanceExpr`
  (vector compile hooks), `jsonPathExpr` (per-dialect JSON extraction).
  All optional — default implementations live in PostgresDialect.
- **Shared cross-adapter helpers** moved to `src/adapters/shared/`:
  `haversine.ts` (great-circle distance + ray-casting point-in-polygon),
  `mongo-to-sql-where.ts` (the where-tree translator from earlier work).
- **`IndexMethod`** gains `'vector'`. `'spatial'` and `'vector'` are
  cross-dialect aliases that resolve per-dialect to the native index
  family.
- **Soft-delete + restore artifacts carry `semanticOp`** (continued from
  2.2.1) so OTel / audit pipelines can filter mutations by intent.
- **MSSQL upsert** returns a clear NotImplemented error pointing at the
  v2.4 MERGE rewrite, instead of silently falling back to a half-baked
  INSERT.

### Test posture

- **439 unit tests** across 33 suites (was 354 in 2.2.1 — +85 new geo /
  JSON path / vector / Phase-1-6 tests).
- **Live regressions on DuckDB** for geo (`regression-geo-duckdb.ts` —
  8/8 incl. polygon) and vector (`regression-vector-duckdb.ts` — 7/7
  through the `vss` extension end-to-end).
- All four existing dialect live integrations (Postgres, MySQL, SQLite,
  Mongo) still green — no regressions from the unioned changes.
- New driver smoke harness verifies every driver installs and connects
  on a clean Node.

### Migration from 2.2.x

Drop-in. No breaking changes. The four new adapters and the new field
kinds are additive; existing schemas keep compiling to the same SQL.
The new `'vector'` index method is a no-op on dialects without vector
support — it warns instead of erroring.

If you're moving to DuckDB or MSSQL, install the driver and add the URL
prefix to your connection string. If you're adopting geo, add the
`f.geoPoint()` fields + `method: 'spatial'` index and run `forge doctor`
to confirm the extensions are available. If you're adopting vector, add
the `f.vector(dims, { metric })` fields + `method: 'vector'` and install
the dialect's vector extension (e.g. `CREATE EXTENSION vector` for PG).



## 2.2.1 — drift detection for the new index shapes, plus a nested-write adapter bug

**Bug fix + completeness.** `forge diff` couldn't see drift on the 2.2.0 index
shapes because the introspect layer wasn't reading method, `where`, `include`,
expression, partial filter, collation, or wildcard projection back from the
DB. The comparator ran on column-set + uniqueness alone, so if someone
manually changed an index's method from `btree` to `gin`, or dropped the
`WHERE` clause, `forge diff` reported "no drift." Fixed across all four
adapters:

- Postgres `introspect` now joins `pg_am` and reads `pg_get_expr(indpred,…)`
  + `pg_get_indexdef`, surfacing method, partial `WHERE`, expression body,
  and INCLUDE columns. The INCLUDE boundary is derived from `pg_index.indnatts`
  so covering columns end up in their own slot instead of mixed with the
  key columns.
- MySQL `introspect` reads `INDEX_TYPE` (BTREE / FULLTEXT / SPATIAL) and
  `EXPRESSION` from `information_schema.STATISTICS`. The `EXPRESSION` column
  doesn't exist on MySQL pre-8.0, so the query falls back when it raises
  Unknown column.
- Mongo `introspect` carries `partialFilterExpression`, `collation`,
  `wildcardProjection`, and the raw `key` map (so `'2dsphere'` / `'hashed'`
  / `1` / `-1` directions survive the round-trip).
- `diff-core` now emits per-property `'mismatch'` items when an index of the
  same name exists on both sides but a tracked property drifted. Whitespace
  + case are normalized for SQL `WHERE` strings, expression bodies tolerate
  PG's extra-paren echo, and Mongo collation is projected down to the keys
  the user declared (so Mongo's filled-in defaults don't read as drift).
- `IntrospectedIndex` gains optional fields for everything above. Adapters
  that can't tell leave them undefined and the diff skips that check.

Also fixed: a nested-write path in the collection wrapper that silently
fell back to the default Mongo singleton on Postgres / MySQL / SQLite.
`_applyNestedWrites` constructed the target wrapper without passing
`this._adapter` or `this._strict`, so a nested `create` or `connect` against
the relation's target model would try to talk to Mongo even when the parent
write was on Postgres. Both sites now propagate both. (This predated 2.2 —
it was exposed while auditing the wrapper for completeness.)

### Soft-delete events

`QueryEvent` gains an optional `semanticOp` field set to `'softDelete'`,
`'softDeleteMany'`, `'restore'`, or `'restoreMany'` whenever the wrapper
dispatches one of those verbs. Up to now they all surfaced as `op: 'update'`,
which made audit pipelines unable to filter soft-deletes from regular updates
without parsing the SQL or the Mongo update doc. The wrapper threads the
hint through `ExecOpts.semanticOp`; each adapter's `_track` copies it onto
the emitted event. `op` is unchanged for back-compat.

### Doc voice

The 2.2.0 entry below was rewritten to match the rest of the changelog —
direct narration of what changed and why, no meta-narrative.

## 2.2.0 — `IndexDef` covers the index shapes `forge push` couldn't model before

**Feature release.** `IndexDef` had `keys` / `unique` / `sparse` / `name` /
`expireAfterSeconds` / `partialFilterExpression` (Mongo only). That covered
plain BTREE compounds, sparse uniques, TTL, and 2.1.0's partial filters, but
left geospatial, hashed shard keys, collation, wildcard projection, SQL
partial indexes, expression indexes, `INCLUDE` covering columns, and PG
access methods (`gin` / `gist` / `brin` / `hash`) outside the schema —
schemas had to fall back to `db.$executeRaw\`CREATE INDEX …\`` or a manual
`collection.createIndex` to express them. This release covers all of those.

### New fields

- `where` — partial index predicate. On Mongo it's an alias of
  `partialFilterExpression` (object form). On Postgres and SQLite it's a raw
  SQL string and compiles to `… WHERE <sql>`. MySQL has no native partial
  index and warns + skips. The same schema can carry both `where: 'sql…'`
  and `partialFilterExpression: { … }` so it works on every dialect.
- `expression` — index the result of a SQL expression instead of a column
  list. Compiles to `CREATE INDEX … ((<expr>))` on Postgres / MySQL 8+ /
  SQLite. Mongo doesn't model expression indexes — `forge push` warns and
  skips. Use this for `lower(email)` case-insensitive lookups, `((data->>'sku'))`
  JSON paths, computed keys.
- `method` — index access method. `btree` (default) / `gin` / `gist` /
  `brin` / `hash` for Postgres, and `spatial` / `fulltext` for MySQL. On
  MySQL `spatial` / `fulltext` are statement-prefix keywords (`CREATE
  SPATIAL INDEX …`), not USING clauses, so they're emitted in that form.
  SQLite and Mongo ignore `method`.
- `include` — Postgres covering columns. Emits `… INCLUDE (col, …)` so the
  index can satisfy a read from the index alone. Other dialects warn + skip.
- `collation` — Mongo only. Build a case- or accent-insensitive index by
  passing the same shape `collection.createIndex` accepts:
  `{ locale: 'en', strength: 2 }`. The push fingerprint includes the
  collation, and the diff projects Mongo's echoed defaults down to the keys
  you declared so an in-sync DB doesn't read as drifted.
- `wildcardProjection` — Mongo only. Pair with `keys: { '$**': 1 }` to
  control which paths the wildcard index covers.

### New `IndexKey` values

`IndexKey` gains `'2dsphere'`, `'2d'`, and `'hashed'`. They pass through
verbatim to `collection.createIndex`, so geospatial `$near` queries and
hashed shard keys work without going around `forge push`. The SQL dialects
ignore these tokens.

### Examples

```ts
indexes: [
  // SQL partial — soft-delete-aware uniqueness on Postgres / SQLite
  { keys: { sku: 1 }, unique: true, where: 'deleted_at IS NULL' },

  // Same intent on Mongo — pass both for cross-dialect schemas
  { keys: { sku: 1 }, unique: true,
    partialFilterExpression: { deleted_at: { $exists: false } } },

  // Mongo geospatial — $near / $geoWithin queries
  { keys: { location: '2dsphere' } },

  // Hashed shard key
  { keys: { tenant: 'hashed' } },

  // Case-insensitive unique email (Mongo)
  { keys: { email: 1 }, unique: true,
    collation: { locale: 'en', strength: 2 } },

  // Postgres GIN on a jsonb column for `@>` containment
  { keys: { tags: 1 }, method: 'gin' },

  // Postgres covering index — index-only scans for (customer_id) → (status, total)
  { keys: { customer_id: 1 }, include: ['status', 'total'] },

  // BRIN for huge append-only tables (Postgres)
  { keys: { received_at: 1 }, method: 'brin' },

  // Case-insensitive email lookup, every SQL dialect
  { keys: {}, expression: 'lower(email)' },

  // MySQL spatial / fulltext
  { keys: { geom: 1 }, method: 'spatial' },
  { keys: { body: 1 }, method: 'fulltext' },
]
```

### Adapter dispatch on `db.<model>.compile`

The `compile` getter on the collection wrapper was hardcoded to the Mongo
compile API regardless of dialect, so a Postgres consumer calling
`compile.findMany(...)` got a `MongoArtifact` back instead of a parameterised
SQL string. The getter now dispatches on `adapter.kind` and returns the
matching artifact. Two narrowed getters were added — `.compileMongo` and
`.compileSql` — that throw at access if the adapter doesn't match, so a
misroute surfaces loudly instead of silently returning the wrong shape.
MySQL and SQLite gain top-level `buildMysqlCompileApi` /
`buildSqliteCompileApi` builders (they had `compile-from-ir` emitters but
no top-level wiring).

### Soft-delete in `compile`

`softDelete` / `softDeleteMany` / `restore` / `restoreMany` have been runtime
methods on the collection wrapper since 2.0, but the typed `compile` surface
only listed find / create / update / upsert / delete. They're now on
`MongoCompileApi` and `SQLCompileApi`; each compiles to the same
update-the-soft-delete-column shape the runtime uses, and throws at compile
time when the model has no `.softDeleteAt()` field.

### `migrate-gen` knows the new shapes

When a missing index is detected via the column-set diff, the generated
migration SQL now carries `method`, `where`, `include`, and (per dialect) the
full statement-prefix for MySQL `SPATIAL` / `FULLTEXT`. Before this, the
generator stripped to a plain `CREATE INDEX (cols)` even when the schema
asked for a GIN or partial index. Expression indexes are skipped from the
column-set diff (they have no columns to compare); `forge push` is the source
of truth for their lifecycle.

### Migration

No breaking changes. Every new field is optional. `partialFilterExpression`
still works exactly as it did in 2.1.0.

### Not yet covered

- SQLite FTS5 virtual tables. `.searchable()` still warns on SQLite.
- MySQL invisible indexes and multi-valued JSON-array indexes.
- MySQL FULLTEXT parser configuration (`WITH PARSER ngram`).
- Generic Mongo query-document → SQL `WHERE` translation. Pass raw SQL on
  SQL dialects; pass Mongo objects on Mongo.

## 2.1.0 — partial indexes on MongoDB (`partialFilterExpression`)

**New feature (MongoDB).** A schema `IndexDef` now accepts
`partialFilterExpression`, so `forge push` can build a [partial index](https://www.mongodb.com/docs/manual/core/index-partial/)
— an index that only covers the documents matching a filter. The canonical use
is a unique index that ignores rows where the field is absent or the wrong type:

```ts
const Payment = model('payments', {
  id:  f.id(),
  txn: f.string().optional(),
}, {
  indexes: [{
    keys: { txn: 1 },
    unique: true,
    name: 'idx_pay_txn',
    partialFilterExpression: { txn: { $type: 'string' } },  // unique only over string txns
  }],
});
```

`forge push` creates it with the filter, and the idempotency fingerprint now
includes the filter (order-independent), so adding/changing a
`partialFilterExpression` triggers a rebuild while an unchanged one is skipped.
The field is **MongoDB-only** and ignored by the SQL dialects. Covered by new
unit tests plus `regression-mongo-partial-index.ts` (creation, idempotency, and
that uniqueness is enforced only over the filtered subset).

## 2.0.1 — upsert: no more `$setOnInsert`/update path conflicts (Mongo)

**Bug fix (MongoDB).** `upsert()` compiled the entire `create` payload into
`$setOnInsert` verbatim while the `update` payload became `$set`/`$inc`/`$mul`/
`$push`/`$unset`. When a field appeared in **both** `create` and `update`, Mongo
rejected the write with *"Updating the path 'x' would create a conflict at
'x'"* — so two natural patterns threw on the insert branch:

```ts
// counter: create seeds 1, update increments
await db.counter.upsert({ where: { id }, create: { id, seq: 1 }, update: { seq: { increment: 1 } } });
// "set these fields whether inserting or updating"
await db.consent.upsert({ where: { user_id }, create: { user_id, categories }, update: { categories } });
```

Now the compiler drops from `$setOnInsert` any path the update operators
already write (exact match **and** prefix conflicts like `a` vs `a.b`). On
insert the update operator sets the value anyway, so both patterns just work;
`$setOnInsert` is omitted entirely when every create field overlaps the update.
Insert-only create fields are still emitted. SQL dialects were unaffected.

## 2.0.0 — `delete()` is now a hard delete; explicit `softDelete()` + `restore()`

**Breaking change.** Deletes now match Prisma's semantics: `delete()` and
`deleteMany()` **always permanently remove the row**, regardless of whether the
model declares a `.softDeleteAt()` column. The recoverable path is a separate,
explicit verb.

In v1, declaring a `.softDeleteAt()` field silently rerouted `delete()` to set
that column instead of removing the row. That made `delete()` mean two different
things depending on the schema, and left no built-in hard-delete or restore. v2
removes the magic and splits the behaviors:

- `delete()` / `deleteMany()` — **always hard delete** (runs cascades). Same as
  on a model with no soft-delete column.
- `softDelete()` / `softDeleteMany()` — **new.** Set the `.softDeleteAt()`
  column to now(); the row is hidden from reads but recoverable. Throws if the
  model has no soft-delete column.
- `restore()` / `restoreMany()` — **new.** Clear the `.softDeleteAt()` column so
  the row is active again. Throws if the model has no soft-delete column.

Read behavior is **unchanged**: `find*` / `count` still auto-exclude
soft-deleted rows, and `where: { _withDeleted: true }` still reveals them.

### Migration from 1.x

This is a **runtime semantic change, not a type error** — code keeps compiling
but behaves differently. Audit every `delete()` / `deleteMany()` call on a model
that has a `.softDeleteAt()` column:

```ts
// v1 (soft-deleted because the model had .softDeleteAt())
await db.account.delete({ where: { id } });

// v2 — pick the intent explicitly:
await db.account.softDelete({ where: { id } });  // recoverable (old behavior)
await db.account.delete({ where: { id } });       // permanent (new default)
```

Models **without** a `.softDeleteAt()` column are unaffected — `delete()` was
already a hard delete for them.

## 1.9.1 — docs: unify the pluggable-drivers README section

No code change. The README's driver docs grew one release at a time and read as
"SQLite plus bolt-ons"; they're now a single **Pluggable drivers** section that
presents all four databases together — one table of every built-in driver, a
per-database example, and the small port interface each one implements.

## 1.9.0 — pluggable MySQL + Mongo drivers (and a MySQL guard fix)

All four databases are now pluggable.

- **MySQL** routes through a `MysqlDriver` port. Built-in wrappers: `mysql2Driver`
  (default), `mariadbDriver` (MariaDB connector), `planetscaleDriver`
  (`@planetscale/database`, serverless). Pass mariadb pools `bigIntAsNumber:true`
  / `insertIdAsNumber:true` for type parity with mysql2.
- **MongoDB** — one canonical driver, so pluggability means bringing your own
  `MongoClient` via `mongoDriver(client, dbName?)`: custom options, a shared
  client, or a Mongo-API backend (Amazon DocumentDB, Azure Cosmos DB, FerretDB).

```ts
const db = await createDb({ schema, driver: mariadbDriver(pool) });
const db = await createDb({ schema, driver: mongoDriver(new MongoClient(uri), 'mydb') });
```

**Bug fix (MySQL):** a `col()` field comparison — or any non-eq predicate — on a
single `update()`/`delete()` made the no-RETURNING follow-up SELECT reference IR
internals as columns (`Unknown column '…kind'`). Guarded writes now extract only
the eq-identity predicates for the follow-up, and use `affectedRows` to surface a
failed guard as not-found (P2025). This affected the default `mysql2` path too;
the integration suite simply never exercised a guarded MySQL update.

Verified: default mysql2 (35/35) + mongo (38/38) unchanged through the ports;
mariadb verified end-to-end on real MySQL (`regression-mariadb-driver.ts`),
injected MongoClient verified on real Mongo (`regression-mongo-driver.ts`).

- Note: `forge push` / `applyMigration` still assume the default `mysql2` pool.

## 1.8.0 — pluggable Postgres drivers (postgres.js)

The Postgres adapter now routes through a normalized `PostgresDriver` port, so
`node-postgres` (`pg`) is no longer the only option. Wrap any client and pass it
to `createDb({ driver })`:

```ts
import postgres from 'postgres';
import { createDb, postgresJsDriver } from 'forge-orm';

const db = await createDb({ schema, driver: postgresJsDriver(postgres(url)) });
```

Built-in wrappers: `pgDriver` (default, node-postgres) and `postgresJsDriver`
(porsager/postgres.js). The port is `query` + `transaction` + `close` (optional
`stream`); any other client fits the same shape.

- The default `pg` path is unchanged and backward compatible (53/53 PG
  integration scenarios pass through the port).
- postgres.js is verified end-to-end against real Postgres
  (`regression-postgresjs-driver.ts`): DDL, RETURNING writes, `col()` guards,
  groupBy/having, `count({ distinct })`, transaction commit AND rollback.
- Note: `forge push` / `applyMigration` still assume the default `pg` pool
  (advisory locks need `pool.connect()`); with an injected driver, run runtime
  queries through forge and manage DDL via `pg` or directly.

## 1.7.0 — pluggable SQLite drivers (React Native, edge, Turso)

The SQLite adapter no longer hard-depends on `better-sqlite3` (a native Node
module that can't run in React Native or edge runtimes). All SQLite access now
goes through a normalized async **driver port** (`SqliteDriver`), and you can
hand forge any driver that implements it:

```ts
import { createDb, libsqlDriver } from 'forge-orm';
import { createClient } from '@libsql/client';

const db = await createDb({ schema, driver: libsqlDriver(createClient({ url })) });
```

Built-in wrappers: `betterSqlite3Driver` (default, Node), `expoSqliteDriver`
(Expo/RN), `opSqliteDriver` (bare RN), `libsqlDriver` (libsql/Turso/edge). The
port is five methods (`all`, `get`, `run`, `exec`, `close`, optional `iterate`),
so any other driver fits too. Pass the driver via `createDb({ driver })` — no
URL needed; you own the driver's lifecycle.

- The synchronous `better-sqlite3` path is unchanged and fully backward
  compatible (all 37 SQLite integration scenarios pass through the port).
- The async path is verified end-to-end against real libsql
  (`regression-libsql-driver.ts`): DDL, RETURNING writes, `col()` guards,
  groupBy/having, `count({ distinct })`, and transactions.
- Note: `adapters/sqlite` `.db` now exposes the `SqliteDriver` port rather than
  the raw `better-sqlite3` handle — pass it to `applyMigration` as before.

(PostgreSQL alternative drivers like `postgres.js` are a planned follow-up.)

## 1.6.1 — housekeeping: trim comments, remove dead legacy code

No behaviour change. A pass over every source file to cut redundant comments
down to the ones that carry real intent (the "why", dialect gotchas, invariants),
plus removal of confirmed-dead code:

- Deleted the legacy pre-IR Mongo query path — `adapters/mongo/relations.ts` and
  `adapters/mongo/translate/{where,orderby,select-include}.ts` (zero importers;
  the IR `compile-from-ir.ts` + `execute.ts` path superseded it) and their two
  unit specs.
- Dropped small dead bits: an unused `REGEX_ESCAPE` const, an unused
  `actualNames` set, and a no-op `.replace('T', 'T')`.

Known gap surfaced by the audit: relation filters inside `where`
(`{ rel: { is: {…} } }`) are not yet supported on Mongo (no `$lookup`) — they
compile to match-all rather than erroring.

## 1.6.0 — groupBy `having` accepts Prisma's field-first shape; fix Mongo `count({ distinct })`

Two correctness items around aggregation, both caught by running groupBy +
distinct against real SQLite and Mongo:

- **`having` now accepts the Prisma field-first shape** in addition to the
  bucket-first shape it already took. Both of these now mean the same thing:

  ```ts
  having: { total: { _sum: { gte: 120 } } }   // field-first (Prisma)
  having: { _sum: { total: { gte: 120 } } }   // bucket-first
  ```

  Normalisation happens once in `buildGroupBy`, so every dialect benefits.

- **Fixed `count({ distinct: [...] })` on MongoDB**, which previously ignored
  `distinct` and returned the total document count. It now groups on the
  distinct field-combination and counts the groups, matching the SQL dialects'
  `COUNT(DISTINCT …)`.

Locked in with `regression-groupby-distinct.ts` (wired into
`forge:integration:mongo`) and a `groupby-having` unit spec.

## 1.5.1 — fix: `update()` false not-found on models with a `value` field

The MongoDB driver v6/v7 returns the bare document from `findOneAndUpdate`,
where v5 returned a `{ value, ok }` envelope. The result-unwrap guessed the
shape with `raw.value` — which collides with any document field literally named
`value`. The effect on `update()` / `upsert()` against such a model:

- when the doc's `value` was falsy (e.g. `0`), a **successful** update was
  reported as a not-found (`P2025`);
- when truthy, the field was returned instead of the document.

No model in the bundled sample schema has a `value` field, so the unit and
integration suites never hit it — promo/discount-style models do. Fixed by
forcing `includeResultMetadata: true` so the envelope is deterministic across
driver versions. Added `regression-mongo-value-field.ts` (wired into
`forge:integration:mongo`) to lock it in.

## 1.5.0 — `col()`: field-to-field comparison in `where`

A new exported helper, `col('otherField')`, lets a `where` condition compare one
column against another column of the same row instead of against a literal:

```ts
import { col } from 'forge-orm';

await db.promo.update({
  where: { id, currentUsage: { lt: col('globalLimit') } },
  data:  { currentUsage: { increment: 1 } },
});
```

Portable across every dialect — one IR, four compilers:

- **Mongo** → `{ $expr: { $lt: ['$currentUsage', '$globalLimit'] } }`
- **Postgres / MySQL / SQLite** → `"t"."currentUsage" < "t"."globalLimit"`

This removes the most common reason callers dropped to the raw driver: an
atomic, race-safe guarded counter (`findOneAndUpdate` with a `$expr` filter) is
now expressible through the portable `update()` API.

Details:

- Accepts only the six comparison operators (`equals`, `not`, `lt`, `lte`,
  `gt`, `gte`); any other operator throws at build time.
- The referenced field is validated against the model — a typo or a relation
  name throws, which also closes the only identifier-injection surface (the
  reference becomes a SQL identifier / Mongo `$field` path downstream).
- The marker is branded with a registered `Symbol`, so it can never collide
  with a real field name or be smuggled in through a JSON request body.
- Both forms work: `{ field: { lt: col('x') } }` and the bare
  `{ field: col('x') }` (equality). Mixed literal + `col()` conditions never
  collide (each `$expr` lands in its own `$and` entry on Mongo).
- Not yet supported inside relation filters — that path throws a clear error
  rather than emitting a wrong query.

## 1.4.1 — docs: surface 1.4's PK strategies at the top of the README

The strategy table + worked example shipped with 1.4.0 but lived deep in the
schema section, four scrolls down from the hero. A new user landing on the
README could easily assume forge was UUID/ObjectId-only and bounce.

Added an explicit "What's new in 1.4" callout right under the pitch:

- All three strategies (`auto`, `uuid`, `bigserial`) shown inline.
- The three `forge` commands you'd actually run to apply it (`push`, `diff`,
  `diff apply`).
- The "Mongo throws — use auto/uuid for portability" caveat surfaced
  alongside, not buried under it.

The detailed strategy table further down stays unchanged — it now has a deep
link from the callout for readers who want the full per-dialect breakdown.

The worked `bigserial` example also got a three-step layout so the
push command appears in context (declare → push → use), making it
obvious nothing new is needed in the CLI.

No code changes.

## 1.4.0 — primary-key strategy: `f.id({ type: 'auto' | 'uuid' | 'bigserial' })`

`f.id()` has always produced a string — ObjectId on Mongo, UUID on SQL —
because that was the only thing portable across all four databases. SQL-only
users who wanted classic auto-incrementing integer keys had to either give up
that wish or work around forge with raw DDL.

`f.id()` now takes an options bag with a `type` argument that picks the
underlying strategy:

```ts
id: f.id()                       // default — string id, ObjectId/UUID per dialect
id: f.id({ type: 'auto' })       // explicit form of the default
id: f.id({ type: 'uuid' })       // PG `uuid`, MySQL `CHAR(36)`, SQLite TEXT
id: f.id({ type: 'bigserial' })  // PG BIGSERIAL, MySQL BIGINT AUTO_INCREMENT,
                                 // SQLite INTEGER PRIMARY KEY AUTOINCREMENT
                                 // — JS type becomes `number`
```

**`bigserial` is the SQL-only opt-in.** Forge throws at `forge push` time on
Mongo with a clear error rather than half-applying — `bigserial` has no Mongo
equivalent, and silently falling back would surprise consumers far more than a
loud failure. Use `auto` or `uuid` if you need cross-DB portability.

Type narrowing:

```ts
const Order = model('orders', {
  id:    f.id({ type: 'bigserial' }),
  total: f.int(),
});
type Row = InferRow<typeof Order>;  // { id: number; total: number }

const o = await db.order.create({ data: { total: 5_000 } });
o.id;          // number — TypeScript knows
await db.order.findFirst({ where: { id: 47 } });
```

Implementation notes:

- DDL emission lives in each dialect's `columnType` + the dialect's
  `renderColumn` for the bigserial-only "no default, no separate NOT NULL"
  rules. PG and MySQL keep the standard table-level `PRIMARY KEY` clause;
  SQLite renders the PK inline on the column (SQLite quirk: `AUTOINCREMENT`
  only works inline).
- App-side autogen is dropped for `bigserial` — `data` never includes the id
  on insert, the DB assigns it, and the existing PG/SQLite `RETURNING *` plus
  MySQL `insertId` paths surface the generated value back to the caller.
- The Mongo push runs a single pre-flight pass over every model's fields and
  throws on the first `bigserial` id it sees.

13 new specs across the four dialects + the schema-level type narrowing.
Total 223 tests pass. Additive non-breaking — the default `f.id()` shape is
unchanged.

## 1.3.3 — docs: clarify when `as const` actually matters on the schema

The README previously told readers to write `as const` on the schema object
"so TypeScript reads the model and field names" — which implied autocomplete
broke without it. That's not true for the recommended pattern (each model
bound to its own `const`, then referenced from the schema literal): TypeScript
already preserves the model types and the literal keys.

The schema-section now spells out the actual situation:

- `SchemaShape = Record<string, TypedModel<…>>` accepts both mutable and
  readonly maps.
- Without `as const`, you still get `db.user.findFirst({ where: { … } })`
  autocomplete, `Row<typeof User>`, `InferCreate<typeof Post>`, all of it.
- `as const` is worth writing anyway — it future-proofs against inlined
  models, string discriminators that would otherwise widen to `string`,
  and downstream `keyof typeof schema` consumers — but it's defensive,
  not load-bearing.

No code changes.

## 1.3.2 — comment trim + tightened README intro

Source-side cleanup pass. No public-API changes, no behaviour changes — the
goal was to delete restated-by-name comments, internal release tags
("Wave N — …") that meant nothing to library users, and section-banner
markers in files small enough to scroll.

Kept: docstrings on every export, "why this looks weird" notes on subtle
correctness paths, and the layered-resolver explainer in `load-consumer-schema.ts`
(genuinely earns its length).

README intro tightened — dropped the redundant "young library with no long
production track record" line; the limitations section already covers it
honestly without prefacing the entire pitch with self-deprecation.

All 210 tests still pass.

## 1.3.1 — `forge diff --ignore` for noisy meta-collections

`forge diff` already filters the migration ledger (`_forge_migrations`) and
engine-generated FTS shadows (`*_fts`). Every project also accumulates a few
collections it doesn't want diff to flag forever — Atlas metadata, cross-service
tables, change-stream tokens — and there was no way to suppress them without
inheriting them into your schema. This release adds a user-supplied ignore list.

**New CLI flag + env var on `forge diff`:**

```sh
# exact names + regex (/.../flags), comma-separated
npx forge diff --ignore=sessions,logs,/^_atlas_/i

# env var works the same; CLI flag stacks on top
export FORGE_DIFF_IGNORE='/^_/i,external_events'
npx forge diff
```

Ignored tables surface at the end of the report (`ignored 2 tables: logs,
sessions`) so silent filtering can't hide real drift. When everything that
*would* be drift is in the ignore list, the report goes back to `✓ no drift`
and exits 0 under `--check`.

**Programmatic API:** `diffIntrospection(schema, introspection, ignore?)`
accepts an `IgnoreSpec` (`Array<string | RegExp>`). `parseIgnoreList(str)`
parses the same comma-separated form the CLI/env take, so callers can mix both.

7 new specs cover literal/regex matching, the ignored-as-only-drift → in-sync
case, malformed-regex fallback, and the report's `ignored` summary. Existing
191 unit + 163 integration tests untouched.

## 1.3.0 — direct-from-model type inference (`Infer*` family)

Take a `typeof MyModel` and pull out any input/output shape you need —
no codegen, no `SchemaMap` registration, no detour through
`ForgeOf<'key'>`. The existing `Row<typeof M>` and `ForgeOf` / `ForgeModels`
APIs still ship; this adds a more direct path for service signatures,
DTOs, validation layers, and anywhere outside `db.*`.

**New exported types:**

| Helper | What it gives you |
| --- | --- |
| `InferRow<typeof M>` | Row shape — field types after defaults/nullability resolve |
| `InferWhere<typeof M>` | `where` input — field filters + AND/OR/NOT |
| `InferWhereUnique<typeof M>` | Partial unique-key lookup |
| `InferCreate<typeof M>` | `create` input — scalars + nested relation directives |
| `InferUpdate<typeof M>` | `update` input — plain values + atomic ops on numbers |
| `InferUpsert<typeof M>` | `{ create, update }` pair |
| `InferOrderBy<typeof M>` | `{ field: 'asc' \| 'desc' }` per scalar |
| `InferSelect<typeof M, S?>` | Field-level select; second generic for relation walking |
| `InferInclude<typeof M, S?>` | Relation include map; second generic for nested args |
| `InferOmit<typeof M>` | Boolean toggles per scalar |
| `Infer<typeof M, S?>` | One bundle of every alias above |
| `InferSchema<typeof schema>` | Mapped bundle across every model in a schema record |

```ts
const User = model('users', { id: f.id(), email: f.string(), age: f.int().optional() });

type UserCreate = InferCreate<typeof User>;            // { email?: string; age?: number | null; … }
type UserUpdate = InferUpdate<typeof User>;            // includes { age: { increment: 1 } } shape
type UserT      = Infer<typeof User>;                  // bundled .Row / .Where / .Create / …

const schema = { user: User, post: Post } as const;
type T = InferSchema<typeof schema>;
type PostSelect = T['post']['Select'];                  // relations resolve via schema map
```

13 new type-level tests cover the family; existing 191 unit + 163 integration
tests untouched.

## 1.2.0 — zero-config schema resolution (layered: flag → env → package.json → cache → scan)

`forge` no longer needs a convention path list. It now resolves the consumer's
schema through a layered cascade: explicit pointers first, then a one-time
filesystem scan that caches its result, with a hard, actionable failure when
nothing turns up.

**Resolution order:**

1. **`--schema=<path>` flag** — zero ms, highest priority.
2. **`FORGE_SCHEMA_PATH=<path>` env var** — zero ms.
3. **`package.json → forge.schema`** — config-in-package, Prettier-style.
4. **`node_modules/.cache/forge/schema-cache.json`** — cached scan result;
   instant for every run after the first.
5. **Filesystem scan** — walks the project tree (one-time cost), finds files
   that both import from `forge-orm` and export a `schema` const. Skips
   `node_modules`, `dist`, `build`, `.git`, `.next`, `coverage`, `.cache`,
   `.turbo`, `.svelte-kit`, `.nuxt`, `.parcel-cache`, `.vercel`, `.netlify`,
   `.serverless`, `out`, `.output`, `.idea`, `.vscode`, test files
   (`*.test.*`, `*.spec.*`), `__tests__/`, `__mocks__/`, `fixtures/`.
   Eliminates ~99% of files with a raw byte-search for the string `forge-orm`
   before doing any deeper work.
6. **Hard fail** — no silent fallback to the bundled sample. Error message
   lists every layer that was searched and gives three concrete ways to fix
   it (add `package.json` entry, pass `--schema`, or check the schema's
   exports).

**Multi-match handling:**

If the scan finds two or more candidates (e.g. a real schema + a test
fixture), forge prints all of them and asks the consumer to pick one via
`package.json` or `--schema`.

**Performance** (measured on a real ~10k-file project / 30-collection
schema):

- Scan (cold): ~300 ms
- Cache hit: ~0 ms overhead
- Total push wall-clock: ~1.1 s (down from ~2.3 s cold) for cache-hit reruns

**Bundled-sample fallback removed.** Forge's own monorepo tests use the
explicit `--schema=` flag in their npm scripts, so the silent fallback path
no longer exists. This makes failure modes loud and obvious.

## 1.1.5 — `npx forge` binary (Prisma-style subcommands)

- **New `forge` CLI binary**, registered via `"bin": { "forge": "..." }` in
  `package.json`. After `npm install forge-orm`, consumers can now run:

  ```sh
  npx forge push           # idempotently sync schema → DB
  npx forge diff           # show drift
  npx forge diff apply     # generate + apply reconciliation migration
  npx forge rollback       # undo last migration
  npx forge doctor         # adapter pre-flight checks
  npx forge --help
  ```

  No env vars, no flags, no glue scripts required. Schema is auto-detected
  from convention paths (`src/schema.ts`, `src/core/database/schema.ts`,
  etc.) or pointed at with `--schema=<path>` / `FORGE_SCHEMA_PATH`.

  The old `forge:push` / `forge:diff` / `forge:diff:apply` / `forge:rollback`
  npm scripts continue to work inside the forge monorepo for our own dev/test
  runs.

## 1.1.4 — `forge:push` exits cleanly when work is done

- **`forge:push` no longer hangs after the push completes.** The top-level CLI
  was relying on Node's natural exit, but `pushAllIndexes()` leaves the Mongo
  client's connection pool open, so the process would sit idle for ~30s
  waiting for the keepalive to time out. The standalone mongo entry point
  (`dist/adapters/mongo/scripts/push.js`) was unaffected — it always called
  `process.exit(0)`. Now the top-level CLI does too.

  Measured on a real ~30-collection / 111-index schema: 1057 ms of actual
  work; previously the process would sit at 1 s of work + 30 s of dangling
  connection before Node figured out it was done.

## 1.1.3 — `forge:push` reads the consumer's schema (was: bundled sample)

This release fixes a real bug consumers were hitting silently:

- **`forge:push`, `forge:diff`, and `forge:diff:apply` were hardwired to
  forge's own bundled sample schema** via a direct relative import. That meant
  running any of them against your own database silently pushed forge's sample
  indexes (which don't exist on your collections) instead of yours — and your
  declared `.unique()` / `@@unique` / `@@index` constraints never landed.

  The bug was caught in production by a consumer whose webhook-idempotency
  event collection had been protected only by an application-level guard for
  weeks; the `_id` index was the only index on the collection in the real
  database, despite the schema declaring `eventId` as unique.

- **New resolution order for the consumer's schema**, used by all three CLI
  commands:
  1. `--schema=<path>` flag
  2. `FORGE_SCHEMA_PATH=<path>` env var
  3. Convention paths (`src/schema.ts`, `schema.ts`,
     `src/core/database/schema.ts`, …) auto-detected from `process.cwd()`
  4. Bundled sample fallback (with a loud warning) — for forge's own monorepo
     dev/test runs only; consumers should never hit this.

- **TypeScript schemas are auto-registered with `ts-node` in transpile-only
  mode** when loaded by the CLI, so `forge:push` runs in milliseconds even on
  schemas with dozens of models. Without this, the default `ts-node` would
  type-check the whole file (~30-60s on a real schema) before producing any
  output, which felt like a hang.

- README updated with the new resolution-order rules.

## 1.1.2 - auto-generated keys and timestamps on every database

- **Auto-generated primary keys on all databases.** When you create a row
  without an `id`, forge now generates one on SQL too (a UUID), not just on
  Mongo (an ObjectId). You no longer assign an id by hand on Postgres, MySQL,
  or SQLite.
- **`.updatedAt()` now works on all databases.** It was applied only on Mongo;
  it now auto-bumps the column on every update for Postgres, MySQL, and SQLite
  as well. `.default('now')` continues to fill created-at columns.
- **Rewrote the README** in plain language, organised by feature rather than by
  internal development phase, with clearer explanations of relations and the
  automatic fields, and the incidental content removed.

## 1.1.1 - standalone & driver-lazy (fixes 1.1.0)

- **Fix (critical):** importing `forge-orm` no longer requires any database
  driver. `mongodb` (`MongoClient`/`ObjectId`) is now lazy-loaded, so a
  SQL-only - or import-only - consumer doesn't need the mongodb driver. (1.1.0
  crashed on import with `Cannot find module 'mongodb'`.)
- **Removed the NestJS integration** (`DatabaseModule`/`DatabaseService`) and the
  `@nestjs/common` dependency. forge is now a **fully standalone,
  framework-agnostic** library - no framework coupling, no bundled driver.
- Drivers (`pg` / `mysql2` / `better-sqlite3` / `mongodb`) are **optional peer
  dependencies**: install only the one(s) you use; each is `require()`d lazily
  on first use against that dialect. Verified: `npm install forge-orm` with zero
  drivers imports cleanly and defines schemas.
- README: explicit "install the driver for your database" table + a no-lock-in note.

## 1.1.0 - drop-in library (schema decoupling)

forge is now a **true drop-in library**: bring your own schema instead of being
tied to the bundled sample. Backward compatible - omit `schema` and the sample
is used. **354 tests** green across all four dialects (191 unit + 163 integration).

### Added

- **`createDb({ schema })`** - pass your own `model(...)` map; the returned `db`
  is typed `ForgeDb<typeof yourSchema>` (fully typed models, where-inputs,
  relations, select/include - no codegen).
- Exported the **schema DSL from the package root**: `f`, `model`, `rel`,
  `enums`, `embed`, plus `SchemaShape`, `sampleSchema`, `setActiveSchema`,
  `getActiveSchema`, and the schema/field types.
- Generic `ForgeDb<S>` and `CollectionWrapper<F, R, SM>` so consumer schemas get
  full nested include/select typing.
- `examples/custom-schema-demo.ts` (`npm run forge:example:custom`) - runnable
  end-to-end proof with a non-sample (e-commerce) schema.
- Canary: `npm run forge:canary` + `forge:canary:load` (real-traffic HTTP service
  on an isolated DB) and the findings in `canary/README.md` / Production notes.

### Changed

- The exported `schema` is now a live view of the *active* schema (a Proxy over
  an active-schema registry), defaulting to `sampleSchema`. The ~14 internal
  consumers are unchanged; consumer schemas flow in via the registry.
- Repo restructured: git root + npm package root moved to `forge/`; builds to
  `dist/` with `.d.ts`; `files` allowlist ships `dist` + README + CHANGELOG only.

### Notes

- One active schema per process (last `createDb({ schema })` wins) - fits the
  one-schema-per-service norm; use separate workers for multiple.

## 1.0.0 - Wave 5 (production hardening)

Feature-complete release. **352 tests** green across all four dialects
(189 unit + PG 53 / SQLite 37 / Mongo 38 / MySQL 35 integration); full
`forge:all` sweep runs in ~13s.

### Added

- **Comparison bench (5a)** - `forge:bench:compare[:pg|:mysql|:sqlite|:mongo]`
  runs identical scenarios through **forge vs Prisma vs Drizzle vs the raw
  driver** against the same table, reporting median / p95 / ops·s⁻¹ / overhead.
  Prisma connects via driver-adapters (`@prisma/adapter-{pg,mariadb,better-sqlite3}`);
  `forge:bench:compare:gen` generates the Prisma clients.
- **Drift detection (5b)** - `forge:diff` introspects the live database
  (PG `pg_catalog`/`information_schema`, MySQL `INFORMATION_SCHEMA`, SQLite
  `PRAGMA`, Mongo `listCollections`/indexes) and reports missing/extra
  tables, columns, indexes, foreign keys, type-category mismatches, and views.
  Human-readable + `--json`; `--check` exits non-zero for CI gating.
- **Schema-diff migrations (5c)** - `forge:diff:apply` generates and runs the
  reconciling SQL (forward), writing timestamped `migrations/<ts>_*.sql` files
  with matching `-- up` / `-- down` blocks and recording them idempotently in a
  `_forge_migrations` history table. `forge:rollback` runs the latest `down`.
  SQL dialects only.
- **Materialised views (5d)** - `.asView({ materialised: true })` emits
  `CREATE MATERIALIZED VIEW` (PG), a repopulated table (MySQL/SQLite), or an
  `$out` collection (Mongo). `db.<model>.refresh()` recomputes;
  `db.<model>.scheduleRefresh('30s'|'5m'|'1h')` auto-refreshes and returns a
  `stop()` (timers are `unref`'d - no leaks).
- **Native types (5e)** - `f.decimal({ precision, scale })`, `f.uuid({ default })`,
  `f.bigint()`, and `.dbgenerated('<expr>')` generated columns, each emitting
  dialect-correct DDL.
- **`strict` mode (5e)** - `createDb({ strict: true })` rejects unknown `where`
  keys at runtime (closes the loose `[key: string]: any` escape hatch).
- **`select`/`include` exclusivity (5e)** - passing both is now a compile-time
  type error.

### Changed

- `Adapter` interface gained optional `introspect()` and `refreshView()`.
- Demo schema grew a `post_stats` materialised view (now 10 registered models).
- `select`/`include` are mutually exclusive at the type level on read + write methods.

### Removed

- Retired the orphaned legacy `adapters/mongo/translate/data.ts`
  (`translateUpdateData`); its coverage moved to the IR path
  (`buildUpdate` → `compileUpdate`) in `mongo-compile-update.spec.ts`.

## 0.x - Waves 0–4c

- **Wave 0** - top-level package, optional peer-dependency drivers, `Adapter` scaffold.
- **Wave 1** - adapter-agnostic query IR; IR-driven read + write paths (Mongo).
- **Wave 2** - Postgres adapter: compile-from-IR, executor, DDL, migration runner,
  `$queryRaw`/`$executeRaw`, P1xxx/P2xxx error mapping.
- **Wave 3** - MySQL and SQLite adapters (compile + execute + DDL + migrate + errors).
- **Wave 4a** - `db.$on('query'|'error')` events, `findManyStream`, `where.search`.
- **Wave 4b** - `.searchable()` auto-FTS indexes, `.softDeleteAt()`, native cursor
  streaming, `wireOtel()` OpenTelemetry helper.
- **Wave 4c** - `.asView()` read-only views; SQLite FTS5 read-route rewriting.
