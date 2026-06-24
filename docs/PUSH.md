# Push

`forge push` makes the database match the schema. It is the primary "apply" command in forge-orm's push-style migration model — there are no numbered migration files; the schema file is the desired state, and push reconciles the live database against it.

Companion to [MIGRATIONS.md](./MIGRATIONS.md), which covers the whole migration story (push + diff + rollback + drift + CI). This file zooms in on `push` itself: every flag, the per-dialect emit, the extension auto-install, fallback mode, idempotency guarantees, and the production rollout patterns built around it. The differ that `push` calls into is covered in [DIFF.md](./DIFF.md); the runtime browser equivalent (`db.$migrate()`) is in [BROWSER.md](./BROWSER.md#dbmigrate--runtime-ddl-apply--drift-detection).

## Contents

* [The push-style model](#the-push-style-model)
* [CLI surface](#cli-surface)
* [What `push` does, in order](#what-push-does-in-order)
* [Flags](#flags)
* [`--enable-extensions`](#--enable-extensions)
* [`--schema=<path>`](#--schemapath)
* [Fallback mode — when the extension isn't there](#fallback-mode--when-the-extension-isnt-there)
* [Idempotency — push is safe to re-run](#idempotency--push-is-safe-to-re-run)
* [Per-dialect emit table](#per-dialect-emit-table)
* [Per-dialect transaction semantics](#per-dialect-transaction-semantics)
* [Statement ordering inside one push](#statement-ordering-inside-one-push)
* [Drift handling — what push reconciles, what it doesn't](#drift-handling--what-push-reconciles-what-it-doesnt)
* [Push vs `db.$migrate()` — runtime equivalent](#push-vs-dbmigrate--runtime-equivalent)
* [Production rollout patterns](#production-rollout-patterns)
* [Common errors and fixes](#common-errors-and-fixes)
* [CI integration](#ci-integration)
* [Exit codes](#exit-codes)
* [See more](#see-more)

---

## The push-style model

The schema file is the source of truth. You write models — fields, indexes, uniques, relations, views, FTS columns, geo columns, vector columns — and `forge push` reads that declaration, introspects the live database, computes what's missing, and emits the DDL needed to bring the database forward. The artefact of "schema at commit X" is the schema file at commit X. There is no `migrations/` folder, no numbered SQL files in version control, no down-files paired with up-files.

The trade-off is symmetric. Round-trip on a schema change is seconds: add a field, save, re-run `npx forge push`, the column lands. New developers clone, set `DATABASE_URL`, run `forge push`, and have a populated schema. The cost is that the database doesn't have an out-of-band record of "the schema as of this Git SHA" — if you revert a branch that added three columns, the columns stay until `forge diff apply` (which generates the destructive DDL) catches up. The migration-file shape exists when you need it; it's not the default flow because additive changes are the 90% case.

Push is the apply command. Diff is the read-only preview. Rollback walks back a `diff apply` (it can't walk back a `push`, because `push` doesn't write to the ledger). The three pieces fit together in [MIGRATIONS.md](./MIGRATIONS.md); this file is the deep reference on `push` alone.

---

## CLI surface

```sh
npx forge push                                 # idempotent sync against $DATABASE_URL
npx forge push --enable-extensions             # also emit CREATE EXTENSION when needed
npx forge push --schema=./src/schema.ts        # explicit schema path (overrides cascade)
npx forge push --enable-extensions --schema=./packages/api/src/schema.ts
```

`DATABASE_URL` is read from `.env` or the environment. There is no `--url` flag. To target a different database, point a different `DATABASE_URL` at the binary:

```sh
DATABASE_URL=postgres://staging:…  npx forge push
DATABASE_URL=postgres://tenant-42:… npx forge push
```

The schema-resolution cascade is the same one used by every CLI subcommand — flag → `FORGE_SCHEMA_PATH` env var → `package.json` `"forge": { "schema": "..." }` → `node_modules/.cache/forge/schema-cache.json` → filesystem scan from `cwd` for files that import `forge-orm` and export a `schema` const. The scan skips `node_modules`, `dist`, build outputs, dotfile dirs, test files, and anything over 1 MB. See [CLI.md](./CLI.md) for the full search order and the failure messages when zero or multiple candidates are found.

---

## What `push` does, in order

1. **Read `DATABASE_URL`.** Missing URL → exit 1 with `[forge:push] DATABASE_URL is not set.`
2. **Detect adapter** from the URL prefix (`postgres:`, `mysql:`, `sqlite:`, `mongodb:`, etc.). Unknown prefix → exit 1 with `[forge:push] Could not infer adapter from URL prefix.`
3. **Load schema** via the resolution cascade. Print `[forge:push] <kind> — schema: <abs path>`.
4. **Spatial extension check.** Scan the schema for any `geoPoint` field that isn't in fallback mode. If found and `--enable-extensions` is set, install the dialect's spatial extension before the DDL apply. If found and the flag isn't set, print a warning and continue (the DDL apply will fail with a clear DB-side error if the extension is missing).
5. **Lock** (per dialect — see [transaction semantics](#per-dialect-transaction-semantics)).
6. **Plan.** Introspect existing tables / constraints / indexes, diff against the schema's generated DDL, produce `{ toApply, toSkip, summary }`. A statement is "to skip" if the database already has an object with that name.
7. **Apply, statement by statement.** Each kind of statement has its own per-dialect error-recovery shape. Postgres uses savepoints; MySQL has none for DDL; SQLite runs everything in one transaction; Mongo retries with drop-and-recreate on spec drift.
8. **Report.** `applied N, skipped M, failures [...]` to stdout. Exit 0 on a clean run; 2 if any statement failed.

For Postgres specifically: `[forge:push] <summary>` prints the planner output before the apply loop runs. Each applied statement logs `  ✓ <kind> <name>`; each failure logs `  ✗ <kind> <name>  →  <error>`. The trailing summary is `[forge:push] applied N, skipped N`.

---

## Flags

`push` ships exactly two flags. The deliberate omissions are spelled out below.

| Flag | Effect |
|---|---|
| `--enable-extensions` | Emit the dialect's `CREATE EXTENSION` (or equivalent) when the schema declares geo / vector / FTS features that need it. See [`--enable-extensions`](#--enable-extensions). |
| `--schema=<path>` | Override the schema-resolution cascade. `--schema=./src/schema.ts` or `--schema ./src/schema.ts`. `FORGE_SCHEMA_PATH=<path>` does the same. |

### What's not a flag, and why

* **No `--dry-run`.** The dry-run is `forge diff` — a separate, read-only command that prints exactly what `push` would apply, in the same kind/direction/detail shape. See [DIFF.md](./DIFF.md).
* **No `--accept-data-loss`.** `push` is additive-only. It never drops columns or tables. The destructive operations live in `forge diff apply`, which shows them in a preview before running.
* **No `--verbose` / `--quiet`.** The output is always one line per statement on apply, plus a summary. Pipe through `jq` or `grep` if you want a quieter view.
* **No `--exclude` / `--ignore`.** Excluding tables on push would let a deploy accidentally drop tables it doesn't own. The way to exclude is to leave the model out of the schema map — see the monorepo partial-schema pattern in [MIGRATIONS.md](./MIGRATIONS.md#migration-in-monorepos).
* **No `--url`.** Override `DATABASE_URL` for the process: `DATABASE_URL=… npx forge push`.

---

## `--enable-extensions`

Several forge features depend on a database extension that isn't loaded by default. Pass `--enable-extensions` and the push will install (or attempt to install) the right one before running the DDL.

The features that need an extension:

* `f.geoPoint()` without `{ fallback: true }` — PostGIS on Postgres, SpatiaLite on SQLite. MySQL spatial is built-in. DuckDB auto-loads on connect. MSSQL `GEOGRAPHY` is built-in. Mongo `2dsphere` is built-in.
* `f.vector(N)` — pgvector on Postgres. MySQL 9+, MSSQL 2025+, and DuckDB (vss) have native vector types. SQLite needs `sqlite-vec` for ANN indexes. Mongo Atlas Vector Search is out-of-band.
* `f.text().searchable()` — Postgres uses `to_tsvector` (no extension). MySQL FULLTEXT is built into InnoDB. SQLite needs FTS5 compiled in. Mongo `text` is built-in.

### What `--enable-extensions` does, per dialect

| Dialect | Behaviour with `--enable-extensions` |
|---|---|
| Postgres | Runs `CREATE EXTENSION IF NOT EXISTS postgis` against the pool before the DDL apply when the schema declares a non-fallback `geoPoint`. Logs `[forge:push:pg] ✓ PostGIS ready`. On failure, prints `[forge:push:pg] ✗ failed to install PostGIS: <err>` followed by `(the role may lack CREATE EXTENSION privilege; ask a superuser to run it once)` and exits 2. |
| MySQL | No-op (spatial is built-in; vector arrived in MySQL 9). The flag is accepted for forward-compat. |
| SQLite | No-op at push time. SpatiaLite, FTS5, and sqlite-vec are loaded by the adapter at `connect()` if compiled in. `forge doctor` reports whether each loaded successfully. |
| DuckDB | No-op. The spatial and vss extensions auto-load on connect. |
| MSSQL | No-op. `GEOGRAPHY` and `VECTOR(N)` are built-in. |
| Mongo | No-op. `2dsphere`, `text`, and Atlas Vector Search are part of the server. |

### Without `--enable-extensions`

The push still proceeds. If the schema declares a non-fallback `geoPoint`, push prints:

```
[forge:push] schema declares geoPoint fields — pass --enable-extensions to auto-install the dialect's spatial extension (PostGIS / SpatiaLite). DuckDB auto-loads always.
```

then continues. If the extension is genuinely missing, the relevant `CREATE TABLE … geography(Point, 4326)` or `CREATE INDEX … USING gist` statement fails with the DB-side error (`type "geography" does not exist` on PG; `unknown column type 'POINT'` on MySQL pre-8; `no such function: AddGeometryColumn` on SpatiaLite-less SQLite). The `failures[]` array catches it and push exits 2.

### When to skip `--enable-extensions`

* The role you push as doesn't have `CREATE EXTENSION` permission and a superuser already ran it once. Postgres extensions are install-once-per-database — re-running `CREATE EXTENSION IF NOT EXISTS` is harmless but unnecessary, and a permission-denied error in CI is noisier than just not asking.
* Your prod database has extensions managed by your infra team (Terraform, Helm chart, etc.). Push should not be the layer that decides which extensions exist on prod.
* The schema only uses `f.geoPoint({ fallback: true })` or `f.vector()` features that don't need an extension — see [fallback mode](#fallback-mode--when-the-extension-isnt-there).

For everything else, including local dev and CI staging, `--enable-extensions` is the right default. Bake it into the npm script:

```json
{ "scripts": { "db:push": "forge push --enable-extensions" } }
```

---

## `--schema=<path>`

Skips the resolution cascade. Useful in three cases:

* **Monorepo, wrong cwd.** Running `forge push` from the repo root when the schema lives in `packages/api/src/schema.ts`. Either `cd` into the package or pass `--schema=packages/api/src/schema.ts`.
* **Multi-schema setup.** A repo with two services that share a database — `apps/users/src/schema.ts` and `apps/billing/src/schema.ts`. The deploy script targets each with an explicit `--schema=…`.
* **Override the cache.** If `node_modules/.cache/forge/schema-cache.json` points at the wrong file (renamed, moved), the flag bypasses the cache and lets you re-cache by running once with the right path.

`--schema=<path>` and `--schema <path>` are both accepted. `FORGE_SCHEMA_PATH=<path>` does the same thing as the flag, useful when the path needs to come from an environment variable. The flag takes precedence over the env var.

A missing file exits 1 with `[forge] --schema=<value> does not exist (resolved to <abs path>)`.

---

## Fallback mode — when the extension isn't there

Three kinds of fields can declare a fallback path that works without an extension. The schema says "I want geo / vector / FTS, but if the extension is missing, store it as plain text and let the app code do the math." This is what you reach for when you don't control the database (managed Postgres without PostGIS access, embedded SQLite without FTS5 compiled in, an old MySQL).

### Geo fallback — `f.geoPoint({ fallback: true })`

| Dialect | Native storage | Fallback storage |
|---|---|---|
| Postgres | `geography(Point, 4326)` | `jsonb` |
| MySQL | `POINT NOT NULL SRID 4326` | `JSON` |
| SQLite | `BLOB` (SpatiaLite) | `TEXT` |
| DuckDB | `GEOMETRY` (spatial extension, always loaded) | (no fallback needed) |
| MSSQL | `GEOGRAPHY` (built-in) | (no fallback needed) |
| Mongo | `2dsphere` (built-in) | (no fallback needed) |

In fallback mode, points are stored as JSON: `{"lng": 3.42, "lat": 6.46}` (3D adds `"alt": 12.0`). Queries that use `near`, `nearTo`, or `withinPolygon` are compiled into two pieces:

1. **SQL bounding-box prefilter** on the JSON-extracted `lng`/`lat` columns, using the degrees-per-meter approximation (1° lat ≈ 111,320 m; 1° lng ≈ 111,320 × cos(lat) m). This is index-friendly — the rough box prunes the candidate rows at the database.
2. **JavaScript haversine post-filter** in the adapter that walks the candidate rows, parses each JSON point, and computes the real great-circle distance. Holes in polygons are handled via ray-casting (even-odd rule). The result rows are annotated with `_distanceMeters`, and `nearTo` sorts by it.

The query API is identical to the native path — `db.Stores.where({ location: near(point, 5000) })` works in both. What changes is the cost shape: native PostGIS is `O(log N)` via the GiST index; fallback is `O(K)` over the bbox-shortlisted rows. Acceptable to ~50k rows in practice.

The push-time emit also changes: fallback geo skips the spatial extension entirely, doesn't emit `USING gist` indexes, and doesn't need `--enable-extensions`. The `schemaNeedsSpatial()` walk in push only flags non-fallback `geoPoint` fields.

### FTS fallback — runtime, not push-time

`.searchable()` doesn't have an explicit `fallback` flag. Instead each dialect picks the best path it has:

| Dialect | Native | Fallback |
|---|---|---|
| Postgres | `to_tsvector('simple', col) @@ plainto_tsquery('simple', q)` + GIN index | n/a (always native) |
| MySQL | `MATCH(col) AGAINST (q IN NATURAL LANGUAGE MODE)` + FULLTEXT | n/a (always native) |
| SQLite | FTS5 virtual table `<col>_fts` + AI/AD/AU triggers, `MATCH ?` queries | LIKE prefilter when FTS5 isn't compiled in |
| DuckDB | `PRAGMA fts_main_*` (FTS extension) | `ILIKE` (no auto-emit) |
| MSSQL | (out-of-band: `FULLTEXT CATALOG` set up manually) | `LIKE` |
| Mongo | combined `text` index across all `.searchable()` fields | n/a (always native) |

The browser doctor at `db.$doctor()` reports each capability as `'native' | 'fallback' | 'unavailable'`. When FTS5 isn't compiled into the sqlite-wasm build, search queries continue to work — they just fall back to `LIKE '%<query>%'` over the searchable column, which is slower on large tables but has the same shape. See [FTS.md](./FTS.md) for the per-dialect FTS reference.

### Vector fallback

There's no `fallback` flag on `f.vector(N)`. Each dialect picks what it has:

| Dialect | Native vector | Behaviour without the extension |
|---|---|---|
| Postgres | pgvector `vector(N)` + HNSW index via `USING hnsw` with `vector_cosine_ops` / `vector_l2_ops` / `vector_ip_ops` | DB-side error — vector type isn't available; install pgvector |
| MySQL | `VECTOR(N)` + `DISTANCE(col, STRING_TO_VECTOR(?), 'COSINE')` | DB-side error — needs MySQL 9+ |
| SQLite | sqlite-vec virtual table (manual; forge doesn't auto-create the vec0 mirror) | Brute-force JSON scan in the adapter; HNSW unavailable |
| DuckDB | `array_cosine_distance` + `USING HNSW` (vss extension) | DuckDB auto-loads vss |
| MSSQL | `VECTOR(N)` + `VECTOR_DISTANCE('cosine', col, vec)` + `USING VECTOR WITH (algorithm = 'HNSW')` | Needs MSSQL 2025+ |
| Mongo | Atlas Vector Search via `$vectorSearch` (out-of-band index) | n/a — Atlas-only |

Push warns when a vector index is declared on a dialect that can't auto-create the index:

```
[forge:push:sqlite] index 'embeddings_v' uses method:'vector' — SQLite vector indexes need
sqlite-vec (CREATE VIRTUAL TABLE … USING vec0). forge-orm doesn't auto-create the vec0 mirror;
do it manually if you need ANN search, or use brute-force JSON-array scans.

[forge:push:mongo] index 'embeddings_v' uses method:'vector' — Mongo vector indexes live in
Atlas Search (createSearchIndex), not the regular createIndex API. Skipped.
```

See [VECTOR.md](./VECTOR.md) for the full vector reference.

---

## Idempotency — push is safe to re-run

Push reads the live database before it writes. Every CREATE statement carries `IF NOT EXISTS` or runs through a planner-side skip check; constraint adds check the `pg_constraint` / `INFORMATION_SCHEMA.TABLE_CONSTRAINTS` / `sqlite_master` set; FK adds check the same constraint set; Mongo `createIndex` is idempotent on the server.

Running push twice against the same DB with the same schema:

```
[forge:push] postgres — schema: /abs/path/src/schema.ts
[forge:push] 0 statements to apply, 47 already in place
[forge:push] applied 0, skipped 47
```

Zero DDL is sent on the second run. Same for a no-op push on a fresh boot — it does one introspection round-trip plus a quick advisory-lock acquire-release, and exits. Safe to put in the app's start command:

```json
{ "scripts": { "start": "forge push && node dist/server.js" } }
```

The Mongo path does ~N round trips on a no-op (one `listIndexes()` per collection plus per-spec fingerprint compare), which is heavier than the SQL `INFORMATION_SCHEMA` lookups. For Mongo-backed services with hundreds of collections, run push out of the request path — typically at deploy time, not at every container start.

### What "idempotent" means here, exactly

Idempotent at the DDL level. Push will not:

* Re-create a table that already exists (named match in `pg_class` / `INFORMATION_SCHEMA.TABLES` / `sqlite_master`).
* Re-create a constraint with the same name (`pg_constraint.conname` / `TABLE_CONSTRAINTS.CONSTRAINT_NAME`).
* Re-create an index with the same name (`pg_indexes.indexname` / `STATISTICS.INDEX_NAME` / `sqlite_master.type='index'`).
* Re-create a Mongo index with the same name + identical key spec + identical options fingerprint.

Push **will** re-emit if the *shape* of an existing object drifted from the schema:

* Mongo: an index name match with a different key spec or options fingerprint triggers `dropIndex` + `createIndex` (`'rebuilt'` in the report). Mongo error codes 85/86 (already exists, IndexOptionsConflict) trigger the same fallback.

For SQL dialects, push **does not** rebuild a drifted index. It logs the existing one as `skipped` (the name matches) and leaves the shape mismatch on the floor. The deep compare lives in `forge diff` — push's planner only checks names. See [DIFF.md](./DIFF.md) for the named-index deep-compare and how to remediate.

---

## Per-dialect emit table

What `forge push` actually sends to each adapter, on first run with an empty database.

| Operation | Postgres | MySQL | SQLite | DuckDB | MSSQL | Mongo |
|---|---|---|---|---|---|---|
| Add table | `CREATE TABLE IF NOT EXISTS` | `CREATE TABLE IF NOT EXISTS … ENGINE=InnoDB DEFAULT CHARSET=utf8mb4` | `CREATE TABLE IF NOT EXISTS` | `CREATE TABLE IF NOT EXISTS` | `CREATE TABLE IF NOT EXISTS` | implicit (first insert creates the collection) |
| Primary key | `PRIMARY KEY ("<id>")` trailing | `PRIMARY KEY` inline (`bigserial` → `BIGINT NOT NULL AUTO_INCREMENT`) | inline for `bigserial` (`INTEGER PRIMARY KEY AUTOINCREMENT`), trailing otherwise | `PRIMARY KEY` trailing | `PRIMARY KEY` trailing | `_id` is automatic |
| Per-field unique | `ALTER TABLE … ADD CONSTRAINT "forge_<t>_unique_<col>" UNIQUE ("<col>")` | `ALTER TABLE … ADD CONSTRAINT \`forge_<t>_unique_<col>\` UNIQUE (\`<col>\`)` | `CREATE UNIQUE INDEX IF NOT EXISTS "forge_<t>_unique_<col>" ON "<t>" ("<col>")` | same as PG | same as PG | `createIndex({col: 1}, { unique: true, sparse: optional })` |
| Composite unique | `ADD CONSTRAINT … UNIQUE (a, b)` | `ADD CONSTRAINT … UNIQUE (a, b)` | `CREATE UNIQUE INDEX … (a, b)` | same as PG | same as PG | `createIndex({a:1, b:1}, { unique: true })` |
| Foreign key | `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY ("<on>") REFERENCES "<t>" ("<refs>") ON DELETE …` | same with backticks | inline inside `CREATE TABLE` (`FOREIGN KEY (…) REFERENCES …`) — SQLite can't `ALTER ADD FK` | `ALTER TABLE … ADD FOREIGN KEY` | `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` | n/a |
| `onDelete` | `CASCADE` / `SET NULL` / `RESTRICT` / `NO ACTION` | same | same | same | same | n/a |
| Enum check | `ADD CONSTRAINT … CHECK ("<col>" IN (…))` | same | inline `CHECK` inside `CREATE TABLE` | same as PG | same as PG | n/a |
| Add index (btree) | `CREATE INDEX IF NOT EXISTS "<name>" ON "<t>" ("col1", "col2" DESC)` | `CREATE INDEX \`<name>\` ON \`<t>\` (…)` | `CREATE INDEX IF NOT EXISTS "<name>" ON "<t>" (…)` | same as PG | same as PG | `createIndex({col1: 1, col2: -1})` |
| Add unique index | `CREATE UNIQUE INDEX IF NOT EXISTS …` | `CREATE UNIQUE INDEX \`<name>\` ON \`<t>\` (…)` | `CREATE UNIQUE INDEX IF NOT EXISTS …` | same as PG | same as PG | `createIndex(…, { unique: true })` |
| Partial-filter index | `CREATE INDEX … WHERE …` (native PG partial index) | rewritten to expression form: `CREATE INDEX … ((CASE WHEN <filter> THEN <key> ELSE NULL END))` — unique-only | `CREATE INDEX … WHERE …` (native SQLite partial index) | `CREATE INDEX … WHERE …` | `CREATE INDEX … WHERE …` (filtered index) | `createIndex(…, { partialFilterExpression })` |
| Expression index | `CREATE INDEX … ((<expr>))` | `CREATE INDEX … ((<expr>))` | `CREATE INDEX … (<expr>)` | `CREATE INDEX … ((<expr>))` | not emitted (use computed column) | not applicable |
| Covering / `include` | `CREATE INDEX … INCLUDE (a, b)` | warned ignored (`MySQL has no INCLUDE`) | warned ignored | warned ignored | `CREATE INDEX … INCLUDE (a, b)` | n/a |
| `method: 'gin' / 'gist' / 'brin' / 'hash'` | `USING gin` / `USING gist` / `USING brin` / `USING hash` | silently ignored — MySQL is BTREE-only | warned ignored — SQLite is BTREE-only | same as PG | same as PG | n/a (use `keys` directions) |
| `method: 'spatial'` | translated to `USING gist` | `SPATIAL ` prefix | warned: at-runtime via SpatiaLite or fallback | spatial extension | `GEOGRAPHY` is built-in | `{ col: '2dsphere' }` |
| `method: 'fulltext'` | warned — use `to_tsvector` + GIN (covered by `.searchable()`) | `FULLTEXT ` prefix | warned — use FTS5 (covered by `.searchable()`) | same as PG | manual `FULLTEXT CATALOG` | `{ col: 'text' }` |
| `method: 'vector'` | `USING hnsw (col vector_cosine_ops)` (or l2 / dot) | not emitted (use `VECTOR` type directly) | warned — sqlite-vec is out-of-band | `USING HNSW (col)` (vss) | `USING VECTOR WITH (algorithm = 'HNSW')` | warned — Atlas Vector Search is out-of-band |
| FTS shadow for `.searchable()` | `CREATE INDEX "forge_<t>_fts_<col>" ON "<t>" USING gin(to_tsvector('simple', "<col>"))` | `ALTER TABLE … ADD FULLTEXT \`forge_<t>_fts_<col>\` (\`<col>\`)` | `CREATE VIRTUAL TABLE "<t>_fts" USING fts5(<cols>, content="<t>", content_rowid='rowid')` + 3 triggers (`<t>_fts_ai`, `<t>_fts_ad`, `<t>_fts_au`) | `PRAGMA fts_main_*` | manual catalog | one combined text index `forge_<t>_fts` mapping every searchable col to `'text'` |
| Geo column with extension | `geography(Point, 4326)` (4326 only — non-4326 uses `geometry(...)`) | `POINT NOT NULL SRID 4326` (lat-first axis order) | `SELECT AddGeometryColumn(…)` (SpatiaLite) | `GEOMETRY` | `GEOGRAPHY` | `createIndex({col: '2dsphere'})` |
| Geo column without extension (fallback) | `jsonb` | `JSON` | `TEXT` | (always available, no fallback) | (always available) | (always available) |
| Vector column | `vector(N)` (pgvector) | `VECTOR(N)` | `TEXT` (JSON-stored, brute-force scan) | `FLOAT[N]` + vss | `VECTOR(N)` | embedded in document, indexed via Atlas Search |
| Plain view | `CREATE OR REPLACE VIEW "<v>" AS <sql>` | `CREATE OR REPLACE VIEW \`<v>\` AS <sql>` | `CREATE VIEW IF NOT EXISTS "<v>" AS <sql>` | same as PG | same as PG | view models via `db.createCollection(c, { viewOn, pipeline })` |
| Materialised view | `CREATE MATERIALIZED VIEW IF NOT EXISTS "<v>" AS <sql>` | `CREATE TABLE IF NOT EXISTS \`<v>\` AS <sql>` (no native matview; `db.<m>.refresh()` clears+repopulates) | same as MySQL — backed by a real table | `CREATE TABLE AS` | same as MySQL | aggregate pipeline with `$out`/`$merge` to populate a real collection |

### What push will not emit

* `ALTER TABLE … DROP COLUMN` — never. Drops live in `forge diff apply`.
* `ALTER TABLE … ALTER COLUMN … TYPE …` — never. Type changes live in `forge diff apply` (and even there, are emitted but conservative).
* `DROP TABLE` — never.
* `ALTER TABLE … RENAME COLUMN` or `RENAME TO` — never. Renames look like drop+add to the differ; preserving data through a rename is the four-step pattern in [MIGRATIONS.md](./MIGRATIONS.md#bluegreen-schema-rollouts).
* `DROP INDEX` (SQL) — never. Mongo `dropIndex` happens only inside the drop-and-recreate fallback when a spec drifted on an existing name.
* `DROP CONSTRAINT` — never.

This is intentional. Push is meant to be safe to put in the app's start command on production. The destructive operations live in `forge diff apply`, where you see them in the preview before they run.

---

## Per-dialect transaction semantics

How the actual apply step is wrapped.

### Postgres — transactional, with savepoints per statement

```
client = await pool.connect()
BEGIN
SELECT pg_advisory_xact_lock(0x6f6f7267, 0x65000001)   -- "forg" + "e\0\0\1"
-- (plan + apply loop, each step inside SAVEPOINT forge_step_N)
COMMIT
client.release()
```

* The advisory lock is **transaction-scoped** (`xact_lock`), so it auto-releases on COMMIT/ROLLBACK. Two concurrent pushes serialise — the second waits on the lock, then re-plans (the plan runs *inside* the locked transaction, after acquire), so it sees the post-first-push state and skips what landed.
* Each statement runs inside a `SAVEPOINT forge_step_N`. On failure: `ROLLBACK TO SAVEPOINT forge_step_N; RELEASE`. The failure is pushed to `report.failures` and the next statement runs. Successful statements stick even when later ones fail.
* `COMMIT` is called even when there are failures. The rationale is `prisma db push` semantic: report what worked, report what didn't, let the caller decide whether to retry. Use `report.failures.length === 0` as your "clean apply" gate.

### MySQL — no transaction, advisory lock only

```
conn = await pool.getConnection()
SELECT GET_LOCK('forge_migrate', 60)
-- (apply loop, no savepoints, no wrapping txn)
SELECT RELEASE_LOCK('forge_migrate')
conn.release()
```

* MySQL DDL implicitly commits any open transaction. There is no all-or-nothing semantic — every `CREATE TABLE` / `ALTER TABLE` / `CREATE INDEX` is its own commit boundary. A mid-batch failure leaves prior successes applied.
* `GET_LOCK('forge_migrate', 60)` is the only race protection. If the lock isn't acquired in 60 seconds, push throws `[forge:mysql] could not acquire migration lock — another push is running`.
* If you need an all-or-nothing semantic on MySQL, split DDL-heavy migrations into smaller schema changes — get the schema-side change, push, verify, then add the next change.

### SQLite — single transaction, single writer

```
PRAGMA foreign_keys = ON
BEGIN
-- (apply loop — db.exec per statement)
COMMIT
```

* SQLite is single-writer at the file level. Concurrent pushes serialise via SQLITE_BUSY (set `PRAGMA busy_timeout = 60000` if a deploy-time push races with an open writer).
* The whole batch runs in one transaction. DDL inside a tx is atomic — if any statement throws and isn't caught, the BEGIN/COMMIT bracket rolls back to pre-push state.
* In practice, each statement's error is caught and logged to `failures[]`; the COMMIT still runs. So the same "best-effort" semantic as PG.
* `PRAGMA foreign_keys = ON` is re-set every push because the pragma is session-scoped, even though the adapter sets it at connect time.

### DuckDB — transactional

DDL is transactional. The spatial and vss extensions auto-load on connect. `--enable-extensions` is a no-op.

### MSSQL — transactional

DDL is transactional within the connection's `BEGIN TRAN` / `COMMIT TRAN`. `GEOGRAPHY` and `VECTOR(N)` are built-in.

### Mongo — no transaction, idempotent per-index

```
client.connect()
for each model: { 
  existing = collection.listIndexes().toArray()
  for each desired spec:
    if name in existing && fingerprint matches → skipped
    elif name in existing && fingerprint drifts → dropIndex + createIndex (rebuilt)
    elif name not in existing → createIndex
                              or on error 85/86/68 → dropIndex + createIndex (rebuilt)
                              or on other error → warned
}
```

* No advisory lock — the server's `createIndex` is idempotent. Two concurrent pushes might race on `dropIndex`/`createIndex` for a drifted index, but Mongo serialises index ops at the collection level.
* View models are handled first, before regular index push, because matviews populate themselves via the aggregation pipeline (`$out` / `$merge`).
* `bigserial` IDs are rejected at the top: `[forge:push:mongo] model '<m>' uses f.id({ type: 'bigserial' }) on field '<f>', which has no Mongo equivalent. Use 'auto' or 'uuid' for Mongo-compatible schemas.`

---

## Statement ordering inside one push

Push emits DDL in three passes over the schema map. The order matters because some statements depend on earlier ones.

**Pass 1 — tables.** One `CREATE TABLE` per non-view model. Inline content: columns, PK, FKs (SQLite only — emitted inline because SQLite can't `ALTER ADD FK`), enum CHECKs (SQLite only — inline). Materialised views skipped here.

**Pass 2 — constraints and indexes.** Per non-view model, in this order:

1. Per-field uniques (`field.unique()`).
2. Composite uniques (`model.uniques: [[a, b]]`).
3. Foreign keys (PG, MySQL, DuckDB, MSSQL — SQLite already inline).
4. Enum CHECKs (PG, MySQL, DuckDB, MSSQL — SQLite already inline).
5. User-declared composite/single indexes (`model.indexes`).
6. FTS shadow tables / triggers / FULLTEXT / GIN-tsvector indexes auto-emitted from `.searchable()`.

**Pass 3 — views.** Plain views and materialised views, in schema order.

A push against an empty DB lands all of Pass 1 before Pass 2 starts, so FK targets exist by the time `ALTER TABLE … ADD FOREIGN KEY` runs. On a partial schema (some tables already exist), the planner skips already-present tables and runs everything else.

The Postgres advisory lock means the introspection-then-apply on a concurrent push is atomic against another push: lock holder finishes (commits or rolls back), then the second push acquires, re-introspects, and sees the post-state.

---

## Drift handling — what push reconciles, what it doesn't

Push is the additive arm of forge's migration system. Diff is the read-only preview that knows about everything, including destructive drift. `diff apply` is the read-write arm that handles the destructive shape.

### What push handles

| Drift item | What push does |
|---|---|
| Missing table | `CREATE TABLE` |
| Missing column | (push will only see this on first emit — the planner won't `ALTER TABLE ADD COLUMN` against an existing table that's missing a column — see below) |
| Missing index | `CREATE INDEX IF NOT EXISTS` (named match in `pg_indexes` / `STATISTICS.INDEX_NAME` / `sqlite_master`) |
| Missing constraint (unique, FK, check) | `ALTER TABLE … ADD CONSTRAINT` (PG, MySQL, DuckDB, MSSQL) |
| Missing FTS shadow | full FTS5 / FULLTEXT / GIN setup |
| Missing Mongo index | `createIndex` |
| Drifted Mongo index (fingerprint mismatch on named match) | `dropIndex` + `createIndex` |

### What push does NOT handle

`forge push` is named-object-shaped. The planner checks "is there an object with this name in the DB?" — if yes, skip; if no, apply. It does *not* deep-compare the shape of objects that already exist by name.

This means:

* **A column added to a model in the schema** — push only emits `CREATE TABLE`. If the table already exists, the missing column stays missing. The path to add it is `forge diff apply`, which emits `ALTER TABLE … ADD COLUMN`. (On the browser, `db.$migrate()` since 2.5.1 does this automatically for safely-additive cases — nullable or with a constant default. See [BROWSER.md](./BROWSER.md#dbmigrate--runtime-ddl-apply--drift-detection).)
* **A column's type changed** — push does nothing. `forge diff` flags it as `kind: 'columnType', direction: 'mismatch'`; `forge diff apply` doesn't currently generate the `ALTER COLUMN TYPE` (it's the conservative gap, because narrowing types loses data).
* **An index's method, where clause, or include list drifted** — the named-match check in push says "exists, skip". The deep-compare lives in `forge diff` (see [DIFF.md](./DIFF.md#deep-field-index-drift)); fixing requires `forge diff apply` (which emits DROP INDEX + CREATE INDEX) or a manual statement.
* **A table or column was removed from the schema** — push does nothing. Drops only happen via `forge diff apply`.

If you want push to "really make the database match the schema", chain it with diff apply:

```sh
npx forge push                # additive: create missing things
npx forge diff apply --dry    # preview the rest (column type, drops, drifted indexes)
npx forge diff apply          # apply if the preview is acceptable
```

For the additive 90% case, `push` alone is the right call. For the destructive 10%, the explicit `diff apply` step is the gate — you see the change list before it runs.

---

## Push vs `db.$migrate()` — runtime equivalent

`forge push` is the CLI server-side path. `db.$migrate()` is the runtime browser path — same intent, different mechanics.

### CLI `forge push`

* All adapters (PG, MySQL, SQLite, DuckDB, MSSQL, Mongo).
* Reads `DATABASE_URL` from `.env` or env.
* Loads the schema via the resolution cascade (ts-node lazy-registered for `.ts` files).
* Spawns a connection pool, runs the introspect + apply loop, prints to stdout, exits.
* Idempotent and safe to run on every deploy.

### Runtime `db.$migrate()`

* SQLite-only — throws on any other adapter: `[forge] $migrate() is only supported on sqlite adapters today. For <kind> use the CLI: 'npx forge push'.`
* Runs inside the Web Worker (browser) or the Tauri/Electron process. No CLI, no file I/O.
* Reuses the SQLite DDL builder and migrator (`buildSchemaDDL` + `applyMigration`) from the same modules the CLI imports.
* Since 2.5.1, runs a drift-apply pass after the create-or-skip loop: walks the schema vs introspection, emits `ALTER TABLE … ADD COLUMN` for safely-additive missing columns (nullable or constant default), and surfaces destructive drift (DROP COLUMN, type changes, extra tables) under `report.pending` instead of applying it.

```ts
const report = await db.$migrate();
// {
//   applied:        ['items', 'forge_items_unique_name'],
//   skipped:        [],
//   failures:       [],
//   alteredColumns: ['items.email'],
//   pending:        [
//     { kind: 'column', direction: 'extra', table: 'items',
//       detail: "column 'legacy_blob' in DB but not in schema" },
//   ],
// }

if (report.pending.length > 0) {
  // Decide app-side: wipe local DB, prompt for export, or live with it.
}
```

### When to use which

| Environment | Use |
|---|---|
| Production server / CI | CLI (`forge push`) |
| Local dev | CLI (`forge push` at app start) |
| Browser / Tauri / Electron / Capacitor | Runtime (`db.$migrate()` at app boot) |
| Ephemeral demo (`:memory:` SQLite) | Runtime — CLI has no path to in-process `:memory:` |
| Mobile (React Native + on-device SQLite) | Runtime |

Both paths share the differ (`diff-core.ts`) and the introspect adapters. What changes is how the result is applied: the CLI generates SQL strings and runs them via a driver pool; the runtime generates SQL strings and runs them via the Worker's prepared-statement API.

For the runtime path's full surface — `pending` shape, chunked rollouts, Safari ITP eviction handling — see [BROWSER.md](./BROWSER.md#dbmigrate--runtime-ddl-apply--drift-detection).

---

## Production rollout patterns

### (a) Dry-run via diff, then push

There's no `--dry-run` on push. The equivalent is `forge diff` (read-only) against the target database:

```sh
DATABASE_URL=$PROD_URL npx forge diff --json | jq '.items'
#   → [{ "kind": "column", "direction": "missing",
#        "table": "users", "detail": "column 'email_verified_at'" }]

DATABASE_URL=$PROD_URL npx forge push
#   → applied 1, skipped 47, failures 0
```

The diff JSON tells you exactly what push will apply, in the same shape the differ uses everywhere else. See [DIFF.md](./DIFF.md) for the full output shape and `--check` exit codes.

### (b) Doctor gate, then push

Before the first push on a new environment, run `forge doctor` to confirm the live database has the capabilities the schema expects (PostGIS installed, FTS5 compiled, SpatiaLite loaded, MySQL ≥ 8.0). See [DOCTOR.md](./DOCTOR.md) for the full check list.

```sh
DATABASE_URL=$NEW_ENV_URL npx forge doctor
#   ✓ pg 16.2 reachable
#   ⚠ PostGIS NOT installed
#     Install: CREATE EXTENSION postgis;

# Either install the extension by hand and re-run, or pass --enable-extensions:
DATABASE_URL=$NEW_ENV_URL npx forge push --enable-extensions
```

### (c) Push on every container start

Push is idempotent. The simplest deploy pattern is to run it as part of the start command:

```json
{
  "scripts": {
    "start": "forge push && node dist/server.js"
  }
}
```

On the first container of a deploy: applies the new DDL. On subsequent containers: no-op (`applied 0, skipped 47`). On a rollback (old image redeployed): no-op — push is additive, so the schema state matches the old code's expectations.

The trade-off is start-time latency. The introspect-and-plan does ~3 catalog queries on PG, ~3 INFORMATION_SCHEMA queries on MySQL, ~2 `sqlite_master` queries on SQLite, and a `listIndexes()` per collection on Mongo. Sub-100ms typically. Bigger schemas (50+ models) push toward 200-500ms.

### (d) Push as a deploy hook, separate from start

For lower start-time latency, run push as a one-shot deploy hook:

```yaml
# fly.toml
[deploy]
  release_command = "npx forge push --enable-extensions"

# vercel.json
{ "buildCommand": "next build && npx forge push" }

# Railway
# Set DEPLOY_COMMAND=npx forge push --enable-extensions
```

Now the deploy fails if push fails — no broken containers come up with the wrong schema shape. The trade-off is that you can't roll back to the previous image without manually un-pushing (which, again, requires `forge diff apply`).

### (e) Push per-tenant on a multi-tenant DB-per-customer setup

```ts
// scripts/push-all-tenants.ts
import { execSync } from 'child_process';

const tenants = await fetch(`${process.env.CONTROL_API}/tenants`, {
  headers: { Authorization: `Bearer ${process.env.CONTROL_TOKEN}` },
}).then(r => r.json());

const failures: string[] = [];
for (const t of tenants) {
  try {
    execSync('npx forge push', {
      env: { ...process.env, DATABASE_URL: t.database_url },
      stdio: 'inherit',
    });
    console.log(`✓ ${t.slug}`);
  } catch (err) {
    failures.push(t.slug);
    console.error(`✗ ${t.slug}: ${(err as Error).message}`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} tenant(s) failed: ${failures.join(', ')}`);
  process.exit(2);
}
```

Run as a deploy step or a scheduled job. Because push is idempotent, re-running against tenants that succeeded is a no-op. For 100+ tenants, parallelise with a worker pool — each push opens its own connection pool, so 8-way concurrency is comfortable on a CI runner.

### (f) Staging push on merge, prod push on manual gate

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  staging:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npx forge doctor
        env: { DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }} }
      - run: npx forge push --enable-extensions
        env: { DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }} }
      - run: npm run test:smoke
        env: { BASE_URL: ${{ vars.STAGING_BASE_URL }} }

  prod:
    needs: staging
    runs-on: ubuntu-latest
    environment: prod    # GitHub environment with required reviewers
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - name: Diff against prod (read-only preview)
        run: npx forge diff --json | tee prod-diff.json
        env: { DATABASE_URL: ${{ secrets.PROD_READONLY_URL }} }
      - run: npx forge push --enable-extensions
        env: { DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }} }
      - run: npm run test:smoke
        env: { BASE_URL: ${{ vars.PROD_BASE_URL }} }
```

The `environment: prod` GitHub environment has `required reviewers` set, so the prod push only runs after a human clicks approve. The preview step uses a read-only `DATABASE_URL` so the diff job never has write access to prod — see [MIGRATIONS.md](./MIGRATIONS.md#ci-workflows) for the read-only role setup.

---

## Common errors and fixes

### `DATABASE_URL is not set`

```
[forge:push] DATABASE_URL is not set.
```

Push couldn't find the URL. Check:

* `.env` file is in the cwd, not a parent dir. Push calls `dotenv.config()` from cwd, no upward search.
* The env var is named exactly `DATABASE_URL` (no `_PROD` suffix, no `DB_URL`).
* For Vercel / Fly / Railway: the env var is set in the right environment. Pull with `vercel env pull` or equivalent for local runs.

### `Could not infer adapter from URL prefix`

```
[forge:push] Could not infer adapter from URL prefix.
```

The URL doesn't start with a recognised prefix. Recognised: `postgres:` / `postgresql:`, `mysql:`, `sqlite:` / `file:`, `mongodb:` / `mongodb+srv:`, `duckdb:`, `mssql:` / `sqlserver:`. Bare `://host/db` doesn't work — add the scheme.

### `failed to install PostGIS`

```
[forge:push:pg] ✗ failed to install PostGIS: permission denied to create extension "postgis"
  (the role may lack CREATE EXTENSION privilege; ask a superuser to run it once)
```

The role you're pushing as doesn't have `CREATE EXTENSION` permission. Two paths:

* Ask a superuser to run `CREATE EXTENSION postgis;` once. Then drop `--enable-extensions` from the push (it's a no-op once the extension exists, but skipping it removes the permission-error noise).
* Use a fallback schema: `f.geoPoint({ fallback: true })` stores points as JSON and does haversine in app code — no PostGIS needed. See [GEO.md](./GEO.md).

### `could not acquire migration lock`

```
[forge:mysql] could not acquire migration lock — another push is running
```

A concurrent push has `forge_migrate` locked. Wait 60 seconds and re-run, or find the other push (`SHOW PROCESSLIST` and look for `GET_LOCK`). The lock auto-releases when the holding connection closes.

### `SQLITE_BUSY`

A push against SQLite hangs and eventually times out. Another writer (the app, a sqlite3 CLI) holds an open transaction. Either close the other writer or raise the timeout:

```ts
db.pragma('busy_timeout = 60000');
```

For deploy-time pushes against a SQLite file that the app is also writing to, stop the app first (or use WAL mode and run the push from a separate process).

### `relation "users" already exists` (PG)

The planner thinks the table is missing but the apply sees it's there. Two causes:

* The introspection runs as a different role than the apply, and the planner role can't see the table (search_path mismatch). Run as a single role with full schema visibility.
* Race: another push created the table between plan and apply. The savepoint catches it; the failure goes to `report.failures` with `relation "users" already exists`. Re-run push — the second run will see the table on the next introspect.

### `cannot drop column` (SQLite < 3.35)

```
near "DROP": syntax error
```

`forge push` itself never emits DROP COLUMN, so this only shows up when `forge diff apply` ran first. SQLite < 3.35 doesn't support `ALTER TABLE … DROP COLUMN`. Upgrade SQLite (3.35 shipped 2021-03), or do the table-rebuild dance — see [MIGRATIONS.md](./MIGRATIONS.md#sqlite--335-column-drop-requires-rebuild).

### Mongo: index name conflicts

```
[forge:push:mongo] index 'forge_users_email_uq' could not be rebuilt: IndexOptionsConflict ...
```

The index name matches but the spec drifted in a way Mongo refuses to rebuild (e.g. you tightened unique on a collection that already has duplicate values). Two fixes:

* Clean the duplicates: query `db.users.aggregate([{ $group: { _id: '$email', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])`. Decide which row wins, delete the others.
* Drop the index manually first: `db.users.dropIndex('forge_users_email_uq')` from the Mongo shell, then push.

### `vector type does not exist` (PG)

You declared `f.vector(N)` and pushed without `--enable-extensions` (and pgvector isn't installed). Either:

* Install pgvector and re-run with `--enable-extensions` (which doesn't auto-install pgvector yet — install it manually: `CREATE EXTENSION vector;`).
* Drop the vector field from the schema if you're not ready for ANN search.

### `Mongo error 67` / `index already exists with different name`

Two indexes with overlapping key specs but different names. Mongo refuses. Drop one and re-push:

```js
db.users.dropIndex('legacy_email_idx')
```

Then push picks up the schema's intended name.

---

## CI integration

### Drift gate on PR

A read-only check that fails the PR if the schema change would push DDL against a main-shaped DB. The pattern is in [MIGRATIONS.md](./MIGRATIONS.md#ci-workflows) under `(a) GitHub Actions PR check — drift gate`.

The short version: spin up an empty Postgres, apply `main`'s schema via `forge push`, then check out the PR's schema and run `forge diff --check --json`. Non-zero exit means the PR adds DDL that needs to land.

### Staging push on merge to main

```yaml
on:
  push:
    branches: [main]

jobs:
  staging-push:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npx forge doctor
        env: { DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }} }
      - run: npx forge push --enable-extensions
        env: { DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }} }
      - run: npm run test:smoke
        env: { BASE_URL: ${{ vars.STAGING_BASE_URL }} }
```

Doctor first (catches missing drivers, missing extensions, ancient MySQL). Push second (idempotent — safe even on no-op merges). Smoke tests third (catches the case where the push succeeded but the schema is shaped wrong for the app code).

### Prod push behind a manual gate

```yaml
on:
  workflow_dispatch:
    inputs:
      sha:
        description: 'Commit SHA to deploy'
        required: true

jobs:
  prod-push:
    runs-on: ubuntu-latest
    environment: prod    # required reviewers
    steps:
      - uses: actions/checkout@v4
        with: { ref: ${{ inputs.sha }} }
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - name: Preview against prod (read-only)
        run: npx forge diff --json | tee prod-diff.json
        env: { DATABASE_URL: ${{ secrets.PROD_READONLY_URL }} }
      - name: Push to prod
        run: npx forge push --enable-extensions
        env: { DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }} }
      - name: Verify in-sync
        run: npx forge diff --check
        env: { DATABASE_URL: ${{ secrets.PROD_READONLY_URL }} }
```

The `prod` environment in GitHub has `required reviewers` set, so this only runs after approval. The preview is read-only (separate read-only DATABASE_URL); the push uses the writable URL; the post-verify confirms the push converged.

### Post-deploy drift metric

Pipe `forge diff --json` to your observability stack as a gauge, so you can alert on "drift > 0 for more than 5 minutes after a deploy" — that means push didn't run, or partially failed. The pattern with a Datadog snippet is in [MIGRATIONS.md](./MIGRATIONS.md#ci-workflows) under `(c) Post-deploy verify`.

---

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Clean run. `applied N, skipped M`, no failures. |
| 1 | Pre-push error: `DATABASE_URL` missing, unrecognised URL prefix, schema couldn't load, top-level uncaught exception. |
| 2 | Apply error: at least one statement failed (`report.failures.length > 0`), or `--enable-extensions` failed to install PostGIS (permission denied, etc). |

Pin CI on exit code `=== 0` for "clean apply needed for the deploy to proceed". Use exit `=== 2` to distinguish "push tried and partially failed" from "push couldn't even start" (`=== 1`). The 1-vs-2 split lets a deploy pipeline retry on transient connection failures (1) but escalate to a human on DDL failures (2).

---

## See more

* [MIGRATIONS.md](./MIGRATIONS.md) — the whole migration story: push + diff + rollback + drift + CI + worked workflows.
* [DIFF.md](./DIFF.md) — `forge diff` and `forge diff apply`: the read-only preview and the destructive sibling of `push`.
* [DOCTOR.md](./DOCTOR.md) — `forge doctor`: the pre-flight check that runs before push to confirm drivers and extensions.
* [ROLLBACK.md](./ROLLBACK.md) — `forge rollback`: walks back the most-recent `diff apply` (does not walk back `push`).
* [CLI.md](./CLI.md) — full CLI reference: every subcommand, every flag, the schema-resolution cascade.
* [DEPLOYMENT.md](./DEPLOYMENT.md) — deploy patterns that wire push into the release pipeline.
* [DRIVERS.md](./DRIVERS.md) — the npm drivers each adapter needs (`pg`, `mysql2`, `better-sqlite3`, `@duckdb/node-api`, `mssql`, `mongodb`).
* [INDEXES.md](./INDEXES.md) — the full `IndexDef` surface that push emits.
* [GEO.md](./GEO.md) — geo fields, the spatial extension picture, and fallback mode in depth.
* [VECTOR.md](./VECTOR.md) — vector fields, pgvector / sqlite-vec / VSS, and the brute-force fallback.
* [FTS.md](./FTS.md) — `.searchable()` per dialect: FTS5 shadow tables, tsvector indexes, FULLTEXT, Mongo text.
* [BROWSER.md](./BROWSER.md#dbmigrate--runtime-ddl-apply--drift-detection) — `db.$migrate()`, the runtime equivalent of push for the browser / Tauri / mobile path.
