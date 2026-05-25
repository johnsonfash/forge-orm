# Changelog

All notable changes to **forge** (`@guide/forge`). Forge is a Prisma-shape
multi-database wrapper for MongoDB, PostgreSQL, MySQL, and SQLite — one code
path, no codegen, no external query engine.

## 1.1.0 — drop-in library (schema decoupling)

forge is now a **true drop-in library**: bring your own schema instead of being
tied to the bundled sample. Backward compatible — omit `schema` and the sample
is used. **354 tests** green across all four dialects (191 unit + 163 integration).

### Added

- **`createDb({ schema })`** — pass your own `model(...)` map; the returned `db`
  is typed `ForgeDb<typeof yourSchema>` (fully typed models, where-inputs,
  relations, select/include — no codegen).
- Exported the **schema DSL from the package root**: `f`, `model`, `rel`,
  `enums`, `embed`, plus `SchemaShape`, `sampleSchema`, `setActiveSchema`,
  `getActiveSchema`, and the schema/field types.
- Generic `ForgeDb<S>` and `CollectionWrapper<F, R, SM>` so consumer schemas get
  full nested include/select typing.
- `examples/custom-schema-demo.ts` (`npm run forge:example:custom`) — runnable
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

- One active schema per process (last `createDb({ schema })` wins) — fits the
  one-schema-per-service norm; use separate workers for multiple.

## 1.0.0 — Wave 5 (production hardening)

Feature-complete release. **352 tests** green across all four dialects
(189 unit + PG 53 / SQLite 37 / Mongo 38 / MySQL 35 integration); full
`forge:all` sweep runs in ~13s.

### Added

- **Comparison bench (5a)** — `forge:bench:compare[:pg|:mysql|:sqlite|:mongo]`
  runs identical scenarios through **forge vs Prisma vs Drizzle vs the raw
  driver** against the same table, reporting median / p95 / ops·s⁻¹ / overhead.
  Prisma connects via driver-adapters (`@prisma/adapter-{pg,mariadb,better-sqlite3}`);
  `forge:bench:compare:gen` generates the Prisma clients.
- **Drift detection (5b)** — `forge:diff` introspects the live database
  (PG `pg_catalog`/`information_schema`, MySQL `INFORMATION_SCHEMA`, SQLite
  `PRAGMA`, Mongo `listCollections`/indexes) and reports missing/extra
  tables, columns, indexes, foreign keys, type-category mismatches, and views.
  Human-readable + `--json`; `--check` exits non-zero for CI gating.
- **Schema-diff migrations (5c)** — `forge:diff:apply` generates and runs the
  reconciling SQL (forward), writing timestamped `migrations/<ts>_*.sql` files
  with matching `-- up` / `-- down` blocks and recording them idempotently in a
  `_forge_migrations` history table. `forge:rollback` runs the latest `down`.
  SQL dialects only.
- **Materialised views (5d)** — `.asView({ materialised: true })` emits
  `CREATE MATERIALIZED VIEW` (PG), a repopulated table (MySQL/SQLite), or an
  `$out` collection (Mongo). `db.<model>.refresh()` recomputes;
  `db.<model>.scheduleRefresh('30s'|'5m'|'1h')` auto-refreshes and returns a
  `stop()` (timers are `unref`'d — no leaks).
- **Native types (5e)** — `f.decimal({ precision, scale })`, `f.uuid({ default })`,
  `f.bigint()`, and `.dbgenerated('<expr>')` generated columns, each emitting
  dialect-correct DDL.
- **`strict` mode (5e)** — `createDb({ strict: true })` rejects unknown `where`
  keys at runtime (closes the loose `[key: string]: any` escape hatch).
- **`select`/`include` exclusivity (5e)** — passing both is now a compile-time
  type error.

### Changed

- `Adapter` interface gained optional `introspect()` and `refreshView()`.
- Demo schema grew a `post_stats` materialised view (now 10 registered models).
- `select`/`include` are mutually exclusive at the type level on read + write methods.

### Removed

- Retired the orphaned legacy `adapters/mongo/translate/data.ts`
  (`translateUpdateData`); its coverage moved to the IR path
  (`buildUpdate` → `compileUpdate`) in `mongo-compile-update.spec.ts`.

## 0.x — Waves 0–4c

- **Wave 0** — top-level package, optional peer-dependency drivers, `Adapter` scaffold.
- **Wave 1** — adapter-agnostic query IR; IR-driven read + write paths (Mongo).
- **Wave 2** — Postgres adapter: compile-from-IR, executor, DDL, migration runner,
  `$queryRaw`/`$executeRaw`, P1xxx/P2xxx error mapping.
- **Wave 3** — MySQL and SQLite adapters (compile + execute + DDL + migrate + errors).
- **Wave 4a** — `db.$on('query'|'error')` events, `findManyStream`, `where.search`.
- **Wave 4b** — `.searchable()` auto-FTS indexes, `.softDeleteAt()`, native cursor
  streaming, `wireOtel()` OpenTelemetry helper.
- **Wave 4c** — `.asView()` read-only views; SQLite FTS5 read-route rewriting.
