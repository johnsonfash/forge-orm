# Forge — Wave 5 Plan

> ## ✅ COMPLETE — Wave 5 shipped 2026-05-25 (v1.0.0)
> All six sub-waves below (5a–5f) are implemented and live-tested.
> **`npm run forge:all` → 352 tests** green across all 4 dialects in ~13s.
> The library is now a git repo (9 commits, one per wave). See `library/CHANGELOG.md`.
> This document is retained as a historical record of the plan.

> **Original status (2026-05-22 evening):** Waves 0–4c shipped. `npm run forge:all` → 333/333.
>
> This file was the handoff document for the next session.

## First action on resuming

```sh
cd /Users/johnfash/Work/guide/forge/library
npm run forge:doctor    # confirm all 4 drivers detected + DATABASE_URL state
npm run forge:all       # confirm 333/333 baseline before changing anything
```

Then pick a sub-wave from below.

## What's done (don't reimplement)

| Wave | Delivered |
|---|---|
| 0 | Folder lift to top-level, optional peer-dep drivers, Adapter scaffold |
| 1a/b/c | Query IR layer, IR-driven read + write paths through Mongo |
| 2a/b/c-1/c-2/d-1 | Postgres adapter: compile-from-ir, executor, DDL, migrate, $queryRaw, error code mapping |
| 2d-2 | IUpdate type fix, groupBy, connectOrCreate, $queryRaw overload, Mongo forge:push fix |
| 3 | MySQL + SQLite adapters (compile + execute + DDL + migrate + errors) |
| 4a | `db.$on('query'/'error')` events, `findManyStream`, `where.search` operator |
| 4b | `.searchable()` auto-FTS-index, `.softDeleteAt()` auto-rewrite, native cursor streaming, `wireOtel` helper |
| 4c | `.asView()` read-only views, SQLite FTS5 read-route rewriting (no more throw) |

**Schema today (9 models):** User, Profile, Post (with `body.searchable()`), Comment, Tag, PostTag, Like, AuditLog (with `.softDeleteAt()`), PublishedPosts (view).

**Total tests passing:** 177 unit + 36 SQLite + 49 PG + 34 MySQL + 37 Mongo = **333**.

## Wave 5 sub-deliverables (ordered by recommended execution)

Each sub-wave should end with the full `forge:all` sweep green + new live integration scenarios per dialect where applicable.

---

### Wave 5a — Comparison bench: forge vs Prisma vs Drizzle

Extends `library/bench/db-bench.ts` (currently does forge-vs-raw-driver per dialect).

**Add:**
- Prisma side — generate Prisma client from an equivalent schema, run the same scenarios (findMany w/ filter+orderBy+take, findFirst by indexed unique, count, update).
- Drizzle side — `drizzle-orm` + dialect-specific drivers (already installed for forge).
- 3-way per-dialect output: forge / Prisma / Drizzle, median + p95 + ops/s + relative-to-raw-driver.
- npm scripts: `forge:bench:compare`, optionally `forge:bench:compare:{pg,mysql,sqlite,mongo}`.

**Why first:** This is the "trust" play. A public 3-way number is what makes someone choose forge over the alternatives.

**Estimated effort:** ~90 minutes.

---

### Wave 5b — Drift detection (`forge:diff`)

New script `src/scripts/diff.ts` introspecting the live DB and comparing to the forge schema.

**Per dialect:**
- PG → `pg_catalog` + `information_schema`
- MySQL → `INFORMATION_SCHEMA.{TABLES,COLUMNS,STATISTICS,VIEWS,KEY_COLUMN_USAGE}`
- SQLite → `sqlite_master` + `PRAGMA table_info()` / `index_list` / `foreign_key_list`
- Mongo → `listCollections` + `collection.indexes()`

**Reports:**
- Missing tables/columns/indexes/FKs (DB has fewer than schema declares)
- Extra DB objects (DB has more than schema declares)
- Type mismatches (column exists with wrong type)
- Divergent defaults (column default value differs)

**Output:** human-readable diff + machine-readable JSON for CI gating.

**Scripts:** `forge:diff` (read-only report). Adds Wave 5c's apply mode later.

**Estimated effort:** ~60 minutes.

---

### Wave 5c — Schema diff + rollback migrations

Extension of Wave 5b. Instead of just reporting drift, generate the SQL to reconcile.

**Two directions:**
- Bring DB → schema (forward migration)
- Bring schema → DB (rollback)

**Persistence:**
- Save migrations to `migrations/` folder with timestamped filenames (e.g. `20260522T180000_add_user_role.sql`)
- Apply idempotently via a `_forge_migrations` tracking table
- Each migration has a `up` and `down` block

**Scripts:** `forge:diff:apply` (generate + run forward), `forge:rollback` (run latest down).

**Why this matters:** Currently `forge:push` is `prisma db push` style — idempotent but no history. Wave 5c gives forge a real migrations workflow without a separate tool.

**Estimated effort:** ~120 minutes.

---

### Wave 5d — Materialised view refresh + scheduling

Extend `.asView()` to accept `{ materialised: true }`.

**Per dialect:**
- **PG** → emit `CREATE MATERIALIZED VIEW`, provide `db.publishedPosts.refresh()` that runs `REFRESH MATERIALIZED VIEW [CONCURRENTLY]`.
- **MySQL** → no native materialised views. Either emit a regular VIEW + warn, or generate a procedure that does `INSERT INTO target SELECT FROM source` on `.refresh()`.
- **SQLite** → same constraint as MySQL.
- **Mongo** → implement as `$merge` / `$out` aggregation pipeline; `.refresh()` re-runs it.

**Optional scheduling:** accept `{ refreshEvery: '1h' }` and wire a `setInterval` inside the adapter (with a clean `.close()` that clears it).

**Estimated effort:** ~75 minutes.

---

### Wave 5e — Wave 2d-2 polish (carried over)

Deferred from earlier waves; ship alongside Wave 5:

- **Native types** — `f.decimal({ precision, scale })`, `f.uuid({ default: 'gen_random_uuid' })`, `f.bigint()`. Emit dialect-correct: PG `numeric`/`uuid`/`bigint`, MySQL `DECIMAL`/`CHAR(36)`/`BIGINT`, SQLite `NUMERIC`/`TEXT`/`INTEGER`, Mongo `Decimal128`/`UUID`/`Long`.
- **`f.dbgenerated('expr')`** — for generated/computed columns. PG `GENERATED ALWAYS AS (...) STORED`, MySQL same. SQLite/Mongo: warn + ignore.
- **`select` / `include` mutually exclusive** at compile time. Currently both work simultaneously but undocumented.
- **`strict: true`** factory option that rejects loose `WhereInput` keys (catches typos in composite-unique synthetic keys; documented as loose surface in Section B of `typesafety-demo.ts`).
- **Port legacy `adapters/mongo/translate/*` tests** to `compile-from-ir.ts` equivalents, retire orphaned files.

**Estimated effort:** ~90 minutes.

---

### Wave 5f — Final README polish + v1.0 gate

- README expanded with Wave 5 sections + comparison-bench numbers (from 5a) + migrations workflow (from 5c) + deployment patterns.
- Bump `version` in `package.json` from `0.1.0-wave0` → `1.0.0`.
- Write `CHANGELOG.md` from the wave history (source: project memory files + this WAVE5_PLAN.md).
- Verify `forge:all` is still under 30 seconds — document the elapsed-time number.

**Estimated effort:** ~30 minutes.

---

## Operating notes

- DBngin services should be running on macOS: PG :5432 user=postgres, MySQL :3306 user=root no password.
- Local mongod on :27017 (started via Homebrew services).
- `.env` already has `SMOKE_PG_USER=postgres` + `BENCH_PG_URL` overrides — those are the DBngin defaults.
- Total `forge:*` scripts: 18. `forge:all` is the master ("does anything regress?"); `forge:check` is the no-DB-needed subset.
- The user has explicitly said: don't pollute backend with forge deps. Everything stays in `forge/library/node_modules`.
- The user has historically preferred substantive single-turn waves over fragmented per-feature work.
- No Co-Authored-By trailer in commits (per user feedback memory).
