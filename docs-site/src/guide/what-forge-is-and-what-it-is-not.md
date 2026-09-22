---
title: "What forge is, and what it is not"
---

## What forge is, and what it is not

forge is a thin wrapper. It turns a Prisma-style call such as
`db.user.findMany({ where: { active: true } })` into the right query for your
database and runs it through the official driver (`pg`, `mysql2`,
`better-sqlite3`, `mongodb`, `@duckdb/node-api`, `mssql`). The drivers do the
actual work; forge builds the queries and shapes the results.

Reach for forge when you want one query API across more than one database, a
dependency small enough to read and fork, full TypeScript autocomplete with no
generated client to keep in sync, and the option to drop down to raw SQL at any
time.

forge is **not** a replacement for Prisma or Drizzle in maturity. It has fewer
features, a smaller ecosystem, and no GUI. If you need those, use Prisma or
Drizzle. The [honest notes](/guide/limitations-and-honest-notes#limitations-and-honest-notes) at the end spell
this out.

### What's new

Full release history is in [CHANGELOG.md](/reference/changelog). Recent highlights:

- **2.20.3 — a one-column `uniques` found nothing on IndexedDB.**
  `{ uniques: [['pendingId']] }` compiled to a *compound* IDB index, whose
  keys are arrays — while the planner looked it up with a scalar. The row
  was written and readable by primary key, but every `where` on that column
  returned `null`/`[]` with no error. Writing it as `f.string().unique()`,
  or with two or more columns, was never affected. Index migration now
  compares key *shape* rather than just the index name, so a database that
  already has the broken index gets it rebuilt. Browser-only: Postgres,
  MySQL, SQLite and Mongo were all verified unaffected. The adapter had no
  execution coverage at all until now — `regression-indexeddb.ts` closes
  that.

- **2.20.2 — an `ObjectId` in a `where` threw.**
  `where: { author_id: new ObjectId(id) }` — the most ordinary query you
  can write against MongoDB, and the shape [docs/MONGO.md](/reference/mongo)
  promises works — failed with `unknown operator 'buffer'`. Deciding
  whether a value was a value or an operator container like `{ gte: 5 }`
  used "object, not array, not Date", so every class instance was walked
  for operators, and `Object.keys()` on an ObjectId returns `['buffer']`.
  `Decimal128`, `Long`, `Binary`, `UUID` and a raw `Buffer` all broke the
  same way. Only a *plain* object is parsed for operators now. Worth
  re-checking if you `try/catch` around forge queries: the throw is loud,
  but a `catch` turns it into a query that quietly does nothing.
  See [CHANGELOG.md](/reference/changelog#2202--an-objectid-in-a-where-threw).
- **2.20 — `updateFirst` / `deleteFirst`: one round trip instead of two.**
  `update` and `delete` return the written row but **throw** when the
  filter matched nothing, so "update it and hand it back, or tell me it
  is not there" was written as `updateMany` plus a re-read of the same
  row — two queries on essentially every write path (measured in one
  consumer codebase: 330 `updateMany` call sites, 123 of them followed by
  that re-read). The new verbs are the same write returning `null` on a
  miss. On a model with a `.softDeleteAt()` column the old shape was
  *three* trips and still wrong, because a read is soft-delete filtered
  and cannot see a row the patch just soft-deleted; `updateFirst` is not
  filtered and returns the row from the write itself. See
  [CHANGELOG.md](/reference/changelog#2200--updatefirst-and-deletefirst-the-doubled-round-trip-on-every-write-path).
- **2.19 — four things forge only looked like it did.** Each ran without
  complaint while doing something other than what it said.
  [`$transaction` did not reach a repository layer](/reference/changelog#transaction-did-not-reach-a-repository-layer) —
  a callback that called a repository discarded the `tx`, so neither leg
  was in the transaction and the throw meant to undo them undid nothing;
  the session now lives in an `AsyncLocalStorage` and a repository joins
  without being threaded a handle.
  [The array form gave no atomicity at all](/reference/changelog#behaviour-change-transaction-takes-thunks-now) —
  it was `Promise.all` over writes that had already dispatched; it takes
  **thunks** now and refuses already-running promises, which is the one
  behaviour change in the release.
  [The Mongo client was one per process, not one per `createDb()`](/reference/changelog#the-mongo-client-was-one-per-process-not-one-per-createdb) —
  a second `createDb({ url: B })` silently kept writing to **A**, and
  `$disconnect()` on either closed the connection under both.
  [Soft-deleted rows came back through every `include`](/reference/changelog#soft-deleted-rows-came-back-through-every-include) —
  the filter was applied at the top level only, so a "deleted" post still
  listed under its author; relation sub-selects are now scoped at every
  depth, along with `groupBy`, relation `_count` and relation filters,
  which had all disagreed with it. See
  [CHANGELOG.md](/reference/changelog#2190--a-transaction-that-did-not-reach-your-repositories-and-three-more-things-forge-only-looked-like-it-did).
- **2.18 — three things that silently returned or wrote wrong data.** A
  keyset cursor ignored the sort direction, so `orderBy: { createdAt:
  'desc' }` with a cursor asked for rows *greater* than the last row
  seen and page 2 re-served page 1. Mongo `update` never coerced its
  values, so an id string written through `update` was stored as a
  BSON `String` where `create` would have stored an `ObjectId` — and
  because `where` does coerce, those rows became invisible to every
  later query. Nested `take` / `skip` applied to the whole batch
  instead of per parent, so `include: { posts: { take: 3 } }` over ten
  users returned three posts *in total*. Also: `divide` is an exact
  division rather than a multiply-by-reciprocal, a Mongo relation
  filter throws instead of matching every row in the collection, and
  `f.bytes()` is a real binary field kind — see
  [docs/BINARY.md](/reference/binary).
- **2.7 — malformed queries throw instead of silently doing something
  else.** Unknown `where` operators (`$gte`, `contians`) used to be
  dropped from the tree, so the filter matched **every row**; typoed
  update operators (`{ incrment: 5 }`) were written through `$set`,
  replacing a number with an object. Both throw now, with the correction
  in the message ("Did you mean 'gte'? forge uses bare operator names").
  `not: { contains: … }` actually negates, strict mode recurses into
  AND/OR/NOT and relation filters, `upsert` keeps the `create` seed when
  `update` increments the same field, `aggregate([...])` works
  positionally, dotted container paths (`'address.city'`) compile
  portably on every dialect, and `.optional()` columns get their full
  operator set back in the types.
- **2.6 — IndexedDB adapter: zero-install browser tier.** A second browser
  adapter alongside sqlite-wasm — no wasm download, no worker file, no
  bundler plugin. URL prefix `idb:` / `indexeddb:` selects the adapter and
  the string after the colon is the IDB database name. The Prisma-shape
  surface is identical to every other dialect; the executor pipeline runs
  `Args → IR → planner picks ONE index → cursor scan → JS residual filter
  → JS sort → limit/offset`. Selectivity-scored index selection (primary-key
  eq > compound eq > unique eq > compound eq > single-column eq > `in` >
  range > free sort > full scan), every plan carries an `explain` string.
  Non-destructive migrations via native IDB versioning (add-field is a
  no-op, `createIndex` back-populates existing rows automatically,
  destructive changes go under `pending`). FTS via multiEntry token index
  (index-backed AND-of-tokens, not a full scan). Geo via Haversine JS +
  bbox prefilter (MultiPolygon with holes, `_distanceMeters` annotation).
  Vector via JS brute-force cosine / l2 / dot (fine ≤ 1 k rows). Cascade
  walker matches the Mongo pattern. Server-safety guard throws a specific
  `[P2010]` message on Node / SSR instead of a cryptic `ReferenceError`.
  Ships at the `forge-orm/indexeddb` subpath export. See
  [Browser (zero install) — IndexedDB](/guide/connecting#browser-zero-install--indexeddb).
- **2.5 — MSSQL `MERGE` upsert, Mongo cross-field `nearTo`, browser `$doctor`/`$diff`, MultiPolygon + GeometryCollection, 3D / Z coordinates, non-WGS84 SRIDs.**
  Closes the entire "Coming soon" list from 2.4. MSSQL upsert now compiles
  to a proper `MERGE INTO … USING (VALUES) … WHEN MATCHED THEN UPDATE …
  WHEN NOT MATCHED THEN INSERT OUTPUT inserted.*` (atomic, returns the row).
  Mongo `near` filter on field A + `nearTo` orderBy on field B now both
  fire — cross-field rewrite emits `$geoWithin: { $centerSphere }` for A
  inside the `$geoNear.query` so the single-stage limit doesn't drop A.
  `db.$doctor()` and `db.$diff()` are the browser equivalents of the
  `forge doctor` / `forge diff` CLIs — returns structured reports your app
  can render. `withinPolygon` accepts Polygon-with-holes, MultiPolygon, and
  GeometryCollection (normalised through every dialect's WKT and the
  fallback ray-cast — holes correctly excluded via even-odd rule).
  `f.geoPoint({ dims: 3 })` opts into XYZ storage (PG `geography(PointZ)`,
  SQLite `POINT Z`, DuckDB `ST_Point3D`, MSSQL `POINT(x y z)`); distance
  ops remain ground-distance (2D-on-sphere) — altitude round-trips.
  `f.geoPoint({ srid: 3857 })` (or any non-4326) routes PG to
  `geometry(Point, srid)` (geography is 4326-only); MySQL / SQLite / DuckDB
  / MSSQL accept the declared SRID at DDL time. Coordinates are
  user-provided in the target SRID — no auto-reprojection.
- **2.4 — Browser adapter: sqlite-wasm + OPFS, runtime `$migrate`, bundler plugins.**
  Real SQLite in the browser via `@sqlite.org/sqlite-wasm` running in a Web
  Worker, persisted on the Origin Private File System. New URL schemes
  `opfs:`, `opfs-sahpool:`, and `:memory:`; a new `wasmSqliteDriver()` factory;
  ready-to-import bundler plugins for **Vite** (`forge-orm/wasm/vite`),
  **Next.js** (`forge-orm/wasm/next`), and **Webpack 5** (`forge-orm/wasm/webpack`);
  `db.$migrate()` runtime DDL apply (the browser replacement for `forge push`);
  `browserDoctor()` feature-detection (OPFS, FTS5, R-Tree, sqlite-vec, persistent
  storage); and an opt-in custom wasm build path (`forge-orm/wasm/worker-pro`)
  with **R-Tree + sqlite-vec** compiled in for native geo + vector search. See
  [Browser (sqlite-wasm + OPFS)](/guide/browser-sqlite-wasm--opfs#browser-sqlite-wasm--opfs).
- **2.3 — DuckDB + MSSQL adapters, end-to-end geo, JSON path queries, vector search.**
  Two new dialects (`duckdb:` and `mssql:` URL prefixes); typed geo
  (`f.geoPoint()` + `near` / `nearTo` / `withinPolygon` across all 6 dialects,
  plus a fallback mode for envs without the spatial extension); typed JSON
  path reads (`where: { meta: { path: 'profile.age', gte: 18 } }`); typed
  vector similarity (`f.vector(1536, { metric: 'cosine' })` + the same
  `near` / `nearTo` vocabulary, compiling to pgvector / DuckDB vss / MSSQL
  `VECTOR_DISTANCE` / Mongo `$vectorSearch`); `forge doctor` live
  capability probe; `forge push --enable-extensions`; a throwaway driver
  smoke harness (`npm run smoke:drivers`).
- **2.2 — `IndexDef` covers the shapes `forge push` couldn't model.** SQL
  partial indexes (`where: 'deleted_at IS NULL'`), expression indexes
  (`expression: 'lower(email)'`), Postgres access methods (`gin` / `gist` /
  `brin` / `hash`) plus `INCLUDE` covering columns, MySQL `FULLTEXT` parser
  plugins / invisible indexes / multi-valued JSON indexes, and Mongo
  geospatial (`'2dsphere'` / `'2d'`), hashed shard keys, collation, and
  wildcard projection.
- **2.1 — partial indexes on MongoDB.** A schema `IndexDef` now accepts
  `partialFilterExpression`, so `forge push` can build a partial index — e.g. a
  unique index that only covers documents where the field is a string.
- **2.0 — `delete()` is always a hard delete.** Breaking change: `delete()` /
  `deleteMany()` permanently remove rows on every model; the recoverable path is
  the explicit `softDelete()` / `restore()` verbs. See [Soft delete](/guide/soft-delete#soft-delete).
- **1.9 — pluggable MySQL + Mongo.** MySQL adds `mariadbDriver` and
  `planetscaleDriver` alongside the default `mysql2`; Mongo lets you bring your
  own `MongoClient` (`mongoDriver`) for DocumentDB / Cosmos / FerretDB / custom
  options.
- **1.8 — pluggable Postgres drivers.** Use `postgres.js` (porsager) instead of
  `node-postgres`, or any client you wrap, via `createDb({ driver: postgresJsDriver(...) })`.
- **1.7 — pluggable SQLite drivers.** Run forge in React Native (`expo-sqlite`,
  `op-sqlite`), on the edge / Turso (`libsql`), or over any driver you wrap.
- **1.6 — richer aggregates.** `groupBy`'s `having` accepts both Prisma's
  field-first shape and the bucket-first shape; `count({ distinct: [...] })`
  is fixed on MongoDB.
- **1.5 — `col()` for field-to-field comparison.** Compare one column against
  another inside a `where` (`{ currentUsage: { lt: col('globalLimit') } }`),
  portable across every dialect.
- **1.4 — primary-key strategies on `f.id()`** (`auto` / `uuid` / `bigserial` / `string`).

---
