# Migrations — `forge push`, `forge diff`, `forge rollback`, drift, and CI

Companion to the README's **[Creating tables and migrations](../README.md#creating-tables-and-migrations)** chapter. The README is the one-screen tour: the CLI names, the schema-resolution cascade, the headline flags. This file is the deep reference: every command's exact behaviour, what counts as drift, what gets emitted per dialect, how to wire it into CI, and where the runtime browser path (`db.$migrate()`, since 2.5.1) takes over.

The browser-side equivalents are covered in **[BROWSER.md](./BROWSER.md#dbmigrate--runtime-ddl-apply--drift-detection)**. Don't read this file looking for browser drift-apply — that's the runtime path, and its semantics are different from the CLI.

## Contents

* [The migration model — why there are no migration files](#the-migration-model--why-there-are-no-migration-files)
* [`forge push`](#forge-push)
* [`forge diff`](#forge-diff)
* [`forge diff apply`](#forge-diff-apply)
* [`forge rollback`](#forge-rollback)
* [`forge doctor`](#forge-doctor)
* [Drift detection rules — what counts, what doesn't](#drift-detection-rules--what-counts-what-doesnt)
* [`--ignore` patterns](#--ignore-patterns)
* [Per-dialect emit table](#per-dialect-emit-table)
* [CI workflows](#ci-workflows)
* [Blue/green schema rollouts](#bluegreen-schema-rollouts)
* [Migration in monorepos](#migration-in-monorepos)
* [Data migration vs DDL migration](#data-migration-vs-ddl-migration)
* [Per-dialect rollback fidelity](#per-dialect-rollback-fidelity)
* [Five worked workflows](#five-worked-workflows)
* [Runtime `$migrate()` + `$diff()` — when to use which](#runtime-migrate--diff--when-to-use-which)

---

## The migration model — why there are no migration files

forge is a **declare-and-push** ORM. You write models in TypeScript, and `forge push` reads the schema, introspects the live database, and emits the DDL needed to bring the database forward. There is no `migrations/` folder you hand-edit, no `prisma migrate dev` step, no down-files you wire up by hand. The artefact of "schema at commit X" is the schema file at commit X — nothing else.

The trade-off is symmetric:

* **What you get** — round-trip time on a schema change is seconds, not minutes. Add a field, save, re-run `npx forge push`, the column is there. No file naming conventions, no merge conflicts on `20260601_add_users.sql`, no "I forgot to run `migrate dev`" rebases. New developers clone, set `DATABASE_URL`, run `forge push`, and have a populated schema.
* **What you give up** — there is no out-of-band record of "the schema at this point in time, separate from the code". If you `git revert` a feature branch that added three columns, the columns stay in the database until you run `forge diff apply` (which generates the destructive DDL) or drop them manually. You can't pin a schema state to a build artefact the way a Prisma migrations folder pins it.

The reconciliation path — `forge diff apply` + `_forge_migrations` ledger — gives you the migration-file shape *when you need it*. It's not the default flow because, in practice, additive changes (the 90% case) don't need it.

### When push-style is the right call

* Single-team service with one database, additive changes most of the time.
* Mongo-backed services — index management is idempotent on the server side; there is no DDL to version.
* Browser / mobile / desktop SQLite (Tauri, Capacitor, sqlite-wasm) — the database lives on the user's device, ships fresh on first run, and gets reconciled at app boot. `db.$migrate()` is the runtime equivalent of `forge push` for this case; see [BROWSER.md](./BROWSER.md#dbmigrate--runtime-ddl-apply--drift-detection).
* Read-replica fan-out or DB-per-tenant setups where the same schema needs to land on N URLs — a `for` loop over `forge push` is the entire deploy script.

### When a migration-file ORM is the right call

* You need to ship a complex multi-step rollout (add column, backfill, switch read source, drop old) where each step lands in a separate deploy and needs to be reviewed at a specific Git SHA.
* Compliance requires a signed audit trail of "the schema applied to prod on date X" — a migrations folder under version control gives you that artefact directly.
* A team larger than 4-5 backend engineers committing to the same schema, with code review on the SQL itself, not the schema declaration.
* You need transformational data migrations baked into the same atomic unit as the DDL — a migration file with a `BEGIN; ALTER TABLE …; UPDATE …; COMMIT;` body is the natural shape.

In those cases, reach for Prisma Migrate, Drizzle Kit migrate, or a hand-rolled SQL migrations folder. forge's `compile.<op>()` API still gives you typed query objects you can paste into a SQL migration; the two models compose.

---

## `forge push`

```sh
npx forge push                              # idempotent sync, schema → live DB
npx forge push --enable-extensions          # additionally emit CREATE EXTENSION when needed
npx forge push --schema=./src/schema.ts     # explicit schema path (overrides cascade)
```

`DATABASE_URL` is read from `.env` or the environment. There is no `--url` flag — point a different `DATABASE_URL` at the binary if you need to target another database (`DATABASE_URL=postgres://staging:… npx forge push`). The schema-resolution cascade is documented in the README; this section is about what `push` does after the schema is loaded.

### What `forge push` does, in order

1. **Detect adapter** from the URL prefix (`postgres:`, `mysql:`, `sqlite:`, `duckdb:`, `mssql:`, `mongodb:`).
2. **Lock**, per dialect:
   * Postgres — `pg_advisory_xact_lock(0x6f6f7267, 0x65000001)` inside `BEGIN` so two concurrent pushes serialise instead of racing on DDL.
   * MySQL — `SELECT GET_LOCK('forge_migrate', 60)` (DDL implicitly commits open txns on MySQL, so the lock is the only protection).
   * SQLite — single-writer connection; no extra lock needed.
   * Mongo — no lock; `createIndex` is idempotent on the server.
3. **Plan** — introspect existing tables / constraints / indexes, diff against the schema's generated DDL, produce `{ toApply, toSkip, summary }`. A statement is "to skip" if the database already has an object with that name and shape.
4. **Apply, statement by statement**:
   * Postgres — each statement runs inside a `SAVEPOINT` so one failure rolls back that statement without aborting the whole batch.
   * MySQL — no savepoint for DDL; mid-batch failure leaves prior successes applied (same semantic as `prisma db push`).
   * SQLite — straight execute.
   * Mongo — `createIndex` per index spec; on Mongo error 85 / 86 (spec drift), drop and recreate.
5. **Report** — `applied: N, skipped: M, failures: [...]` to stdout. Exit code 0 on a clean run; 2 if any statement failed.

### `push` is additive-only by design

`forge push` will:

* Create tables, columns, indexes, constraints, foreign keys, views, FTS shadow tables and their triggers.
* Drop and recreate Mongo indexes when their spec drifted (error 85 / 86).
* Auto-install extensions when `--enable-extensions` is set.

`forge push` will *not*:

* Drop columns the schema removed.
* Change a column's type (`ALTER TABLE … ALTER COLUMN …`).
* Drop tables the schema removed.
* Rename columns or tables (renames look like drop + add to the differ).

This is intentional. `push` is meant to be safe to run on production at app start. The destructive operations live in `forge diff apply`, where you see them in the preview before they run.

### Flags

| Flag | Effect |
|---|---|
| `--enable-extensions` | Before the DDL apply, emit `CREATE EXTENSION IF NOT EXISTS postgis;` (or the dialect equivalent) for whatever the schema declares — `f.geoPoint()`, `f.vector()`, `.searchable()`. Without this flag the push proceeds; it'll fail with a clear DB error if the extension's missing. With it, the role must have `CREATE EXTENSION` permission. |
| `--schema=<path>` | Override the [schema-resolution cascade](../README.md#pointing-the-cli-at-your-schema). Useful in monorepos when the cwd isn't the package containing the schema. `FORGE_SCHEMA_PATH=<path>` env var works the same way. |

`push` deliberately does not ship `--dry-run`, `--verbose`, `--accept-data-loss`, `--ignore`, or `--exclude`. The patterns for what those flags would do are covered elsewhere in this doc — dry-run is `forge diff` (read-only), data-loss is the explicit `forge diff apply` workflow, ignoring is on `forge diff`, and exclude in monorepos is the [partial-schema pattern](#migration-in-monorepos).

### Per-dialect quirks

* **Postgres** — `forge push` is transactional. If you're running it as part of a deploy hook and want a hard guarantee that "either every statement applies or none do", check the `failures.length === 0` exit condition; otherwise some statements stuck. The `pg_advisory_xact_lock` means two concurrent pushes (e.g. blue + green pods restarting at the same time) serialise correctly.
* **MySQL** — DDL implicitly commits. There is no all-or-nothing semantic. Split DDL-heavy migrations into smaller pushes if you need that property.
* **SQLite** — single-writer; if another connection holds a write transaction the push will hang on `SQLITE_BUSY`. For a deploy-time push, set `PRAGMA busy_timeout = 60000`.
* **DuckDB** — DDL is transactional. The spatial and vss extensions auto-load on connect; `--enable-extensions` is a no-op for DuckDB.
* **MSSQL** — `GEOGRAPHY` and `VECTOR(N)` are built-in; no extension to install.
* **Mongo** — there's no DDL; `forge push` does idempotent `createIndex` per declared index. Re-running against an in-sync DB does ~N round trips (one per collection). A spec change (e.g. you flipped a partial filter expression) triggers a drop-and-recreate; data that violates a newly-tightened unique constraint is logged, not crashed.

---

## `forge diff`

```sh
npx forge diff                              # human-readable report
npx forge diff --json                       # machine-readable
npx forge diff --check                      # exit 3 if drift found (CI gate)
npx forge diff --ignore=logs,/^_atlas_/i    # skip noisy meta-tables
```

`diff` reads the live database (via the same `introspect` path the adapter uses for `compile`-shape queries), compares it to the schema's expected shape, and prints what's different. It never writes.

### Output shape (`--json`)

```json
{
  "dialect": "postgres",
  "items": [
    { "kind": "column", "direction": "missing", "table": "users",
      "detail": "column 'email_verified_at'" },
    { "kind": "index",  "direction": "extra",
      "table": "users", "detail": "unique index u:legacy_email in DB but not in schema" }
  ],
  "inSync": false,
  "ignored": ["logs", "_atlas_meta"]
}
```

* `dialect` — `postgres` / `mysql` / `sqlite` / `duckdb` / `mssql` / `mongo`.
* `items[].kind` — one of `table` / `column` / `index` / `foreignKey` / `view` / `columnType`.
* `items[].direction` — `missing` (in schema, not in DB), `extra` (in DB, not in schema), `mismatch` (shape drift, e.g. wrong index method).
* `inSync` — `true` only when `items` is empty.
* `ignored` — tables that matched an `--ignore` pattern; surfaced so silent filtering can't hide real drift.

### `--check` exit codes

| Exit | Meaning |
|---|---|
| 0 | No drift. `inSync: true`. |
| 3 | Drift detected. Only emitted when `--check` is set. |
| 1 | Something went wrong before the diff ran (no `DATABASE_URL`, unreachable DB, schema didn't load). |

The 3-vs-1 split lets a CI job distinguish "actual drift" from "couldn't even reach the DB" — pin a job's failure semantics on `exit_code == 3` to catch the former without false-positive on the latter.

### CI gate snippet

```yaml
# .github/workflows/schema-drift.yml
name: Schema drift gate
on: [pull_request]
jobs:
  diff:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: postgres }
        ports: ['5432:5432']
        options: --health-cmd pg_isready
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - name: Seed staging schema from main
        run: |
          git checkout origin/main -- src/schema.ts
          DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
            npx forge push
      - name: Restore PR schema
        run: git checkout HEAD -- src/schema.ts
      - name: Diff against main-shaped DB
        run: |
          DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
            npx forge diff --check --json | tee diff.json
```

A non-zero exit (specifically 3) on the final step means the PR adds drift that `forge push` would resolve — the reviewer sees `diff.json` to know what.

---

## `forge diff apply`

```sh
npx forge diff apply              # generate reconciliation migration + apply
npx forge diff apply --dry        # print the SQL only; don't apply, don't write the file
```

`diff apply` is the **read-write** sibling of `forge diff`. It generates a SQL migration file with `up` (bring DB forward) and `down` (inverse) sections, applies it, and records the row in `_forge_migrations`. Files land in `./migrations/<timestamp>_drift.sql`.

This is the path you take when you'd rather review the SQL before running it, or when you need a record of "the change applied on this date" outside the schema file.

### The safe slice

For every drift item, `diff apply` decides what to emit:

| Drift item | Safe slice (always emitted) | Destructive (emitted, but visible in preview) |
|---|---|---|
| Missing table | DEFER to `forge push` | — |
| Missing column | `ALTER TABLE … ADD COLUMN` (nullable, or with default) | — |
| Missing index | `CREATE INDEX` with full 2.2+ shape (method, where, include, expression) | — |
| Missing FK | `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` | — |
| Extra column | — | `ALTER TABLE … DROP COLUMN` |
| Extra table | — | `DROP TABLE IF EXISTS` |
| Column type mismatch | — (not yet generated) | — |
| Index method mismatch on an existing index | — (drop & recreate via `forge push`) | — |

There is no `--accept-data-loss` gate. `diff apply` shows you the change list before running it:

```
[forge:diff:apply] 3 change(s):
  • add users.email_verified_at
  • drop sessions.legacy_token
  • drop table audit_old
```

If anything in that list isn't what you want, Ctrl-C and use `--dry` instead — `--dry` prints the full SQL without touching the DB or writing the file.

### What ends up in `migrations/`

```sql
-- forge migration: 20260624T143052_drift
-- generated: 2026-06-24T14:30:52.413Z

-- up
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMPTZ;
DROP TABLE IF EXISTS "audit_old";

-- down
DROP TABLE IF EXISTS "audit_old"; -- cannot auto-restore dropped table
ALTER TABLE "users" DROP COLUMN "email_verified_at";
```

Notice the down for "extra table" is a comment, not real SQL. `forge diff apply` never invents a recreate plan for a dropped table because the data is gone — the down side is best-effort, not lossless. The [Per-dialect rollback fidelity](#per-dialect-rollback-fidelity) section spells out exactly what's recoverable.

### Per-dialect ALTER repertoire

| Operation | Postgres | MySQL | SQLite |
|---|---|---|---|
| Add column (nullable) | `ALTER TABLE … ADD COLUMN` | `ALTER TABLE … ADD COLUMN` | `ALTER TABLE … ADD COLUMN` |
| Add column (NOT NULL + default) | `ALTER TABLE … ADD COLUMN … DEFAULT …` | `ALTER TABLE … ADD COLUMN … DEFAULT …` | `ALTER TABLE … ADD COLUMN … DEFAULT …` |
| Add unique index | `CREATE UNIQUE INDEX` | `CREATE UNIQUE INDEX` | `CREATE UNIQUE INDEX IF NOT EXISTS` |
| Add partial index | `CREATE INDEX … WHERE …` | translated to expression-index form | `CREATE INDEX … WHERE …` |
| Add covering index | `CREATE INDEX … INCLUDE (…)` | — (MySQL has no INCLUDE) | — |
| Add expression index | `CREATE INDEX … ((expr))` | `CREATE INDEX … ((expr))` | `CREATE INDEX … (expr)` |
| Add FTS shadow | (`forge push` only) | (`forge push` only) | (`forge push` only) |
| Add FK | `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` | `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` | comment-only ("SQLite cannot ALTER ADD FK") |
| Drop column | `ALTER TABLE … DROP COLUMN` | `ALTER TABLE … DROP COLUMN` | `ALTER TABLE … DROP COLUMN` (SQLite 3.35+) |
| Drop table | `DROP TABLE IF EXISTS` | `DROP TABLE IF EXISTS` | `DROP TABLE IF EXISTS` |
| Rename column | not emitted | not emitted | not emitted |
| Rename table | not emitted | not emitted | not emitted |

FTS shadow tables and their triggers come from `forge push`, not `diff apply`, because they're created together with the parent table's `searchable()` columns rather than as a separate diff item.

Renames are not detected. A schema change that renames `email` → `email_address` looks like "drop `email`, add `email_address`" to the differ. If you need a rename to preserve data, the pattern is the two-deploy plan in [Worked workflow (d)](#five-worked-workflows): add new, copy data via `db.$executeRaw`, switch reads, drop old.

---

## `forge rollback`

```sh
npx forge rollback                # roll back the most-recent applied migration
```

`rollback` reads `_forge_migrations`, picks the most-recently-applied row, reads the matching `migrations/<name>.sql` file, runs its `-- down` block, and deletes the row from the ledger.

### What's recoverable

| Operation in `up` | `down` does | Lossless? |
|---|---|---|
| ADD COLUMN (no data yet) | DROP COLUMN | Yes |
| ADD COLUMN (data backfilled separately) | DROP COLUMN | **No — backfilled data is dropped with the column** |
| CREATE INDEX | DROP INDEX | Yes |
| ADD CONSTRAINT | DROP CONSTRAINT | Yes |
| ADD FK | DROP FK | Yes |
| DROP COLUMN | ADD COLUMN with the *type* the introspect saw at apply time | **No — column shape preserved, data is gone** |
| DROP TABLE | comment ("cannot auto-restore") | **No — best-effort note only** |

The pattern: rollback is reliable for "I just added a thing and want to take it back". It is not a time machine for destructive operations. If you dropped a column on Monday and want it back on Wednesday, the rollback emits the right ALTER but the data was deleted on Monday — restore from a backup, not a rollback.

### The `_forge_migrations` ledger

A two-column table forge creates the first time `diff apply` or `rollback` runs:

```
CREATE TABLE _forge_migrations (
  name        VARCHAR(255) PRIMARY KEY,
  applied_at  VARCHAR(64)
);
```

* Portable across Postgres, MySQL, SQLite, DuckDB, MSSQL.
* `name` is the timestamped slug (`20260624T143052_drift`).
* `applied_at` is an ISO-8601 string.

This table is auto-ignored by `forge diff` so it never shows up as drift. You can read it directly with `db.$queryRaw` if you need to expose "what schema state are we on" to ops dashboards.

### `rollback` only goes back one

There is no `forge rollback --to <slug>`. The CLI applies exactly the most-recent down block. If you need to walk back N migrations, run `forge rollback` N times.

---

## `forge doctor`

```sh
npx forge doctor
```

`doctor` is the pre-flight check. It does four things in order:

1. **Driver inventory** — for every adapter, prints whether its npm driver is installed (`pg`, `mysql2`, `better-sqlite3`, `@duckdb/node-api`, `mssql`, `mongodb`) and the installed version.
2. **`DATABASE_URL` shape check** — redacts the password, detects the adapter from the prefix, and confirms the matching driver is present. If the URL prefix is unknown, gives the user the workaround (pass `type` explicitly to `createDb`).
3. **Schema lint** — if a schema is reachable via the [cascade](../README.md#pointing-the-cli-at-your-schema), walks every model's indexes and flags impossible combinations: Mongo-only fields (`collation`, `wildcardProjection`, `'2dsphere'` keys) on a SQL adapter; SQL-only fields (`method`, `include`, `expression`) on Mongo; method mismatches like `method: 'spatial'` on Postgres; `parser` set on a non-FULLTEXT index; unnamed indexes that'll get a generated name.
4. **Live capability probe** — connects to the database (best-effort; failures are reported, not raised) and reads:
   * Postgres — `server_version`, presence of PostGIS, pg_trgm, btree_gin, btree_gist.
   * MySQL — `SELECT VERSION()`, warns on < 8.0 (no SRID-aware spatial).
   * SQLite — version, attempts `load_extension('mod_spatialite')`.
   * DuckDB — `INSTALL spatial; LOAD spatial; SELECT extension_name FROM duckdb_extensions()`.
   * MSSQL — `SELECT @@VERSION`, notes `GEOGRAPHY` is built-in.
   * Mongo — `buildInfo`, notes `2dsphere` is built-in.

The output ends with a copy-pasteable `Action items` section: which drivers to `npm install`, which extensions to `CREATE EXTENSION`, which database upgrades to plan.

The runtime equivalent for the browser is [`browserDoctor()`](./BROWSER.md#browserdoctor--runtime-capability-probe).

### When to run `doctor`

* **Once after `npm install forge-orm`** to confirm your driver is in.
* **Before the first `forge push` on a new environment** to know if extensions need installing.
* **When a query fails with a "function doesn't exist" or "unknown index method" error** to confirm the live DB has the capability the schema expects.
* **In CI**, as a pre-step before `forge diff --check`. Saves you debugging "why does the diff job fail" — the doctor output points at the missing extension.

---

## Drift detection rules — what counts, what doesn't

The differ is in `src/scripts/diff-core.ts` and is dialect-aware. The rules below match what it actually does — not what it could do.

### What forge considers drift

| Kind | Direction | Detection |
|---|---|---|
| `table` | `missing` | Model declared in schema but no table with that `collection` name in DB. |
| `table` | `extra` | Table in DB whose name isn't any model's `collection` or matview backing. |
| `column` | `missing` | Field in schema but no column with that name on the matching table. |
| `column` | `extra` | Column in DB but no field with that name on the matching model. |
| `columnType` | `mismatch` | Field's category (`string` / `int` / `bigint` / `float` / `decimal` / `bool` / `datetime` / `json`) differs from the DB column's category. Skipped on SQLite (dynamic typing) and Mongo (schemaless). |
| `index` | `missing` | Index column-set + uniqueness signature in the schema but not in the DB. |
| `index` | `extra` | **Unique-only** — extra non-unique indexes don't drift (engines create their own). Extra unique indexes do. |
| `index` | `mismatch` | Named index in both, but `method`, `where`, `include`, `expression`, `partialFilterExpression`, `collation`, `wildcardProjection`, or per-key direction tokens differ. |
| `foreignKey` | `missing` | Relation declared in schema with a non-id `on` column, but no FK with matching `column → refTable.refColumn` in DB. |
| `view` | `missing` | `model('…', { … }, { view: { … } })` in schema but neither a view nor a table with that name in DB. |

### What forge does NOT consider drift

* **Column ordering** — schemas declare order in the IR for DDL emit, but introspect just reads back columns. Reordering a model doesn't generate drift.
* **Default expressions that normalise differently per dialect** — Postgres echoes `gen_random_uuid()` back differently from how it was declared, MySQL stores `CURRENT_TIMESTAMP` in a normalised form. The differ doesn't compare default expressions.
* **`_forge_migrations`** — the migration ledger is always filtered.
* **`*_fts` shadow tables** — engine-managed by the FTS5 / GIN tsvector / Mongo `text` machinery. Always filtered.
* **Matview backing tables** — a PG materialised view that's surfaced as a table is matched against the schema view list before being flagged extra.
* **Non-unique extra indexes** — DBs add their own (constraint-backing, auto-stat). Only extra *unique* indexes drift.
* **Type comparison on SQLite + Mongo** — SQLite types are dynamic; Mongo has no DDL. Column-existence and index drift still apply.

### Category-based type comparison

The differ doesn't compare types as strings — it maps both sides to coarse categories and compares those. This is deliberate: PG `text` vs `varchar(255)` shouldn't drift, MySQL `tinyint(1)` vs `bool` shouldn't drift, MSSQL `nvarchar(MAX)` vs `text` shouldn't drift.

| Schema kind | Category | Matches DB types (normalised) |
|---|---|---|
| `id`, `objectId`, `string`, `text`, `uuid`, `enum` | `string` | `text`, `varchar*`, `char*`, `uuid`, `citext` |
| `int` | `int` | `smallint`, `integer`, `int`, `int4`, `int2`, `mediumint` |
| `bigint` | `bigint` | `bigint`, `int8` |
| `float` | `float` | `real`, `double*`, `float*` |
| `decimal` | `decimal` | `numeric*`, `decimal*` |
| `bool` | `bool` | `bool*`, `tinyint(1)` |
| `dateTime` | `datetime` | `timestamp*`, `datetime*`, `date`, `time*` |
| `json`, `embed`, `embedMany` | `json` | `json`, `jsonb` |
| arrays, custom types | — (skipped) | — |

A category-vs-category mismatch fires; anything `undefined`-categorised is skipped. This biases toward "don't cry wolf" — false negatives (rare type drift the differ misses) are easier to live with than false positives that erode trust in the report.

### Deep-field index drift (2.2+)

Forge tracks the full 2.2+ `IndexDef` surface. When an index is declared with an explicit `name` and the DB has an index with that name, the differ deep-compares:

* `method` — `btree` / `gin` / `gist` / `brin` / `hash` on PG; `spatial` / `fulltext` on MySQL.
* `where` — partial index predicate, normalised (whitespace-collapsed, lowercased, paren-trimmed) before compare to tolerate PG's echo-back form.
* `include` — covering columns (PG).
* `expression` — expression index body, normalised the same way as `where`.
* `partialFilterExpression` — Mongo's partial-filter, compared via stable-key JSON to tolerate key-order differences.
* `collation` — Mongo only, projected to user-declared keys before compare so the DB's echoed defaults don't false-positive.
* `wildcardProjection` — Mongo only, stable-JSON compared.
* `keySpec` — Mongo only, per-key direction tokens (`1` / `-1` / `'text'` / `'2dsphere'` / `'2d'` / `'hashed'`).

Each mismatch becomes its own drift entry scoped by index name, so the report shows you exactly which property drifted instead of just "something changed":

```
≠ [index] users: index 'idx_email_active' method: schema=gin db=btree
≠ [index] users: index 'idx_email_active' where: schema=active = true db=∅
```

Unnamed indexes don't participate in the deep pass — the column-set signature catches "missing entirely", but the differ won't try to align a generated name across runs.

---

## `--ignore` patterns

```sh
npx forge diff --ignore=logs,sessions,/^_atlas_/i,events
export FORGE_DIFF_IGNORE='/^_/i,external_events'
npx forge diff   # CLI flag and env var stack
```

Two forms:

* **Exact-match string** — `logs` matches the table `logs` and nothing else.
* **`/regex/flags`** — anything wrapped in slashes is parsed as a regex with the given flags. `/^_atlas_/i` matches any table starting with `_atlas_` case-insensitively.

Items are comma-separated. The CLI flag and `FORGE_DIFF_IGNORE` env var both feed the same list — the CLI flag stacks on top of the env var (additive), so a fleet-wide default can be extended for a single run without overwriting it.

### Reading `parseIgnoreList`

```ts
import { parseIgnoreList } from 'forge-orm/scripts/diff-core';

parseIgnoreList('logs,/^_atlas_/i,events');
// → ['logs', /^_atlas_/i, 'events']
```

You can import this directly when building tooling around the differ — e.g. a custom CI step that calls `diffIntrospection` programmatically.

### Always-ignored

Regardless of flags:

* `_forge_migrations` — the ledger.
* Any name matching `/_fts/i` — FTS5 shadow tables and triggers.
* PG matview backing tables that match a declared view name.

These are engine-managed; surfacing them as drift would be permanent noise.

### Common ignore patterns by environment

| Environment | Pattern | Why |
|---|---|---|
| MongoDB Atlas | `/^_atlas_/i,/^system\./i` | Atlas inserts metadata collections (`_atlas_system_query_planner_caches`, `system.profile`). |
| PostgREST | `pgrst_watch,/^pgrst_/i` | PostgREST creates trigger-backing tables. |
| Hasura | `hdb_catalog,/^hdb_/i` | Hasura keeps its metadata in a sibling schema, but the catalog leaks through. |
| Supabase | `/^auth\./i,/^storage\./i,/^realtime\./i` | Supabase's managed schemas — your service doesn't own them. |
| TimescaleDB | `/^_timescaledb_/i,/_hyper_/i` | Chunk metadata + hypertable shards. |
| Litestream replica | `/^_litestream_/i` | Replica state. |

The right answer for any of these is to bake the pattern into `FORGE_DIFF_IGNORE` in the CI env so every diff job picks it up automatically.

### Ignored tables are reported

Forge surfaces what was filtered:

```
✓ no drift — live postgres schema matches forge schema
  (ignored 3 tables: hdb_catalog, _atlas_meta, system.profile)
```

This is deliberate — silent filtering would let a real-drift table slip through if someone accidentally wrote a too-broad regex. The trailing summary lets you verify the ignore list is doing what you meant.

---

## Per-dialect emit table

What `forge push` (and `forge diff apply` for new objects) actually sends to each adapter:

| Operation | Postgres | MySQL | SQLite | DuckDB | MSSQL | Mongo |
|---|---|---|---|---|---|---|
| Add table | `CREATE TABLE` | `CREATE TABLE` | `CREATE TABLE` | `CREATE TABLE` | `CREATE TABLE` | implicit (first insert creates the collection) |
| Add column | `ALTER TABLE … ADD COLUMN` | `ALTER TABLE … ADD COLUMN` | `ALTER TABLE … ADD COLUMN` | `ALTER TABLE … ADD COLUMN` | `ALTER TABLE … ADD` | no-op (schemaless) |
| Add unique | `CREATE UNIQUE INDEX` | `CREATE UNIQUE INDEX` | `CREATE UNIQUE INDEX IF NOT EXISTS` | `CREATE UNIQUE INDEX` | `CREATE UNIQUE INDEX` | `createIndex({…}, { unique: true })` |
| Add partial-filter index | `CREATE INDEX … WHERE …` | translated to expression-index form (`CREATE INDEX ((CASE WHEN … THEN col END))`) | `CREATE INDEX … WHERE …` | `CREATE INDEX … WHERE …` | `CREATE INDEX … WHERE …` (filtered index) | `createIndex({…}, { partialFilterExpression })` |
| Add expression index | `CREATE INDEX … ((expr))` | `CREATE INDEX … ((expr))` | `CREATE INDEX … (expr)` | `CREATE INDEX … (expr)` | not emitted (use computed column) | not applicable |
| Add covering index | `CREATE INDEX … INCLUDE (…)` | not emitted | not emitted | not emitted | `CREATE INDEX … INCLUDE (…)` | not applicable |
| Add FTS shadow | tsvector column + `CREATE INDEX … USING gin` | `FULLTEXT INDEX (…)` inside table DDL | `CREATE VIRTUAL TABLE … USING fts5` + after-insert / after-update / after-delete triggers | `PRAGMA fts_main_*` (DuckDB FTS) | manual (out-of-band `FULLTEXT CATALOG`) | `createIndex({ field: 'text' })` |
| Add geo column with extension | `geography(Point, 4326)` | `POINT NOT NULL SRID 4326` | `SELECT AddGeometryColumn(…)` (SpatiaLite) | `GEOMETRY` (spatial) | `GEOGRAPHY` | `createIndex({ field: '2dsphere' })` |
| Add geo column without extension (fallback) | `TEXT` (JSON-stored, app-side Haversine) | `TEXT` | `TEXT` | (always available, no fallback) | (always available) | (always available) |
| Drop column | `ALTER TABLE … DROP COLUMN` (diff apply only) | `ALTER TABLE … DROP COLUMN` (diff apply only) | `ALTER TABLE … DROP COLUMN` on SQLite 3.35+ (diff apply only); older versions need full table rebuild | `ALTER TABLE … DROP COLUMN` | `ALTER TABLE … DROP COLUMN` | no-op |
| Drop table | `DROP TABLE IF EXISTS` (diff apply only) | `DROP TABLE IF EXISTS` | `DROP TABLE IF EXISTS` | `DROP TABLE IF EXISTS` | `DROP TABLE IF EXISTS` | `db.collection.drop()` (manual; not auto-emitted) |
| Rename column | not emitted | not emitted | not emitted | not emitted | not emitted | not emitted |
| Rename table | not emitted | not emitted | not emitted | not emitted | not emitted | not emitted |
| Add FK | `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` | `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` | comment only ("SQLite cannot ALTER ADD FK") | `ALTER TABLE … ADD FOREIGN KEY` | `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` | not applicable |

### SQLite < 3.35: column drop requires rebuild

`forge diff apply` emits a plain `ALTER TABLE … DROP COLUMN`. On a SQLite older than 3.35 (released 2021-03), that statement isn't supported and the migration will fail. The workaround is the SQLite-recommended rebuild:

```sql
BEGIN;
CREATE TABLE _users_new (id TEXT PRIMARY KEY, email TEXT NOT NULL);
INSERT INTO _users_new (id, email) SELECT id, email FROM users;
DROP TABLE users;
ALTER TABLE _users_new RENAME TO users;
COMMIT;
```

Run that as a one-shot `db.$executeRaw` before re-running `forge diff apply`. forge doesn't generate the rebuild because picking which columns to preserve is a judgment call — the schema-side intent is `DROP COLUMN`, the safe execution is rebuild, and the user owns the data.

### Renames are not detected

The differ has no heuristic for "this column was renamed". Renaming `email` → `email_address` in the schema looks like "drop `email`, add `email_address`". `forge diff apply` will happily emit both. The pattern for preserving data through a rename is the two-deploy plan in [Worked workflow (d)](#five-worked-workflows): add the new column, copy data, switch reads, drop the old.

---

## CI workflows

### (a) GitHub Actions PR check — drift gate

```yaml
# .github/workflows/schema.yml
name: Schema drift gate
on:
  pull_request:
    paths: ['src/schema.ts', 'src/schema/**', 'package.json']

jobs:
  drift:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: postgres }
        ports: ['5432:5432']
        options: --health-cmd pg_isready --health-interval 5s
    env:
      DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres
      FORGE_DIFF_IGNORE: /^_atlas_/i,/^hdb_/i

    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci

      - name: Apply main-branch schema to staging DB
        run: |
          git worktree add /tmp/main origin/main
          ( cd /tmp/main && npm ci --omit=dev && npx forge push )

      - name: Diff PR schema against main-shaped DB
        id: diff
        run: npx forge diff --check --json | tee diff.json
        continue-on-error: true

      - name: Comment diff on PR
        if: steps.diff.outcome == 'failure'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const body = '```json\n' + fs.readFileSync('diff.json', 'utf8') + '\n```';
            github.rest.issues.createComment({
              owner: context.repo.owner,
              repo:  context.repo.repo,
              issue_number: context.payload.pull_request.number,
              body: 'Schema drift detected — `forge push` would emit:\n' + body,
            });

      - name: Fail job if drift
        if: steps.diff.outcome == 'failure'
        run: exit 1
```

Two pieces matter: the staging DB is shaped from `origin/main` first, then the PR's schema is diffed against it. Drift means "the PR adds DDL that needs to land before app code goes live". The PR comment surfaces the JSON so the reviewer doesn't have to dig into job logs.

### (b) Pre-deploy gate — dry-run against prod via diff

There's no `forge push --dry-run`. The equivalent is `forge diff` against prod (read-only), which tells you what `forge push` would do without doing it:

```yaml
# .github/workflows/predeploy-schema-check.yml
name: Pre-deploy schema check
on:
  pull_request:
    branches: [main]
    paths: ['src/schema.ts', 'src/schema/**']

jobs:
  prod-drift-preview:
    runs-on: ubuntu-latest
    environment: prod-readonly   # protected env, read-only DATABASE_URL
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci

      - name: Diff PR schema against prod
        run: npx forge diff --json | tee prod-diff.json

      - name: Comment on PR
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const report = JSON.parse(fs.readFileSync('prod-diff.json', 'utf8'));
            const sigil = report.inSync ? 'in sync' : `${report.items.length} drift item(s)`;
            const body = [
              `**Prod schema preview** — ${sigil}`, '',
              '```json', JSON.stringify(report, null, 2), '```',
            ].join('\n');
            github.rest.issues.createComment({
              owner: context.repo.owner, repo: context.repo.repo,
              issue_number: context.payload.pull_request.number, body,
            });
```

The `prod-readonly` GitHub environment holds a `DATABASE_URL` with a role that has `SELECT` on system catalogs (PG: `pg_class`, `pg_index`, `pg_constraint`) but no `INSERT/UPDATE/DELETE/DDL` — `diff` only needs introspection, never writes, so a read-only role is sufficient and gives you a "would this push do anything destructive?" preview without giving CI write access to prod.

### (c) Post-deploy verify — diff JSON as a metric

```ts
// scripts/post-deploy-verify.ts
import { execSync } from 'child_process';

const out = execSync('npx forge diff --json', { env: process.env }).toString();
const report = JSON.parse(out);

const datadog = await fetch('https://api.datadoghq.com/api/v1/series', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'DD-API-KEY': process.env.DATADOG_API_KEY!,
  },
  body: JSON.stringify({
    series: [
      {
        metric: 'forge.drift.items',
        type: 'gauge',
        points: [[Math.floor(Date.now() / 1000), report.items.length]],
        tags: [`dialect:${report.dialect}`, `service:${process.env.SERVICE_NAME}`],
      },
      {
        metric: 'forge.drift.in_sync',
        type: 'gauge',
        points: [[Math.floor(Date.now() / 1000), report.inSync ? 1 : 0]],
        tags: [`dialect:${report.dialect}`, `service:${process.env.SERVICE_NAME}`],
      },
    ],
  }),
});

if (!report.inSync) {
  console.error('Post-deploy drift:', report.items);
  process.exit(1);
}
```

Run this as a post-deploy hook in your CD pipeline. The metric goes to Datadog (or replace with Prometheus pushgateway / CloudWatch / your stack) so you can alert on "drift > 0 for more than 5 minutes after a deploy" — that means `forge push` either didn't run or partially failed.

---

## Blue/green schema rollouts

For schema changes that aren't backward-compatible (renaming a column, narrowing a type, splitting a table), the safe pattern is a multi-step rollout where each step is backward-compatible on its own.

### The four-step pattern

**Goal:** rename `users.username` → `users.handle`.

**Step 1 — add the new column** (one PR, one deploy):

```ts
// src/schema.ts
const Users = model('users', {
  id:       f.id(),
  username: f.string().unique(),
  handle:   f.string().optional(),   // nullable so existing rows pass
});
```

Run `forge push`. App still reads/writes `username`; `handle` is nullable and ignored. This is safe to ship to prod — old app instances don't know about `handle`, new ones do.

**Step 2 — backfill** (data migration, no schema change):

```ts
// scripts/migrate/20260624-backfill-handle.ts
import { createDb, raw } from 'forge-orm';
import { schema } from '../../src/schema';

const db = await createDb({ url: process.env.DATABASE_URL!, schema });
await db.$executeRaw(raw`UPDATE users SET handle = username WHERE handle IS NULL`);
await db.$disconnect();
```

Run once. No code deploy needed.

**Step 3 — switch reads to the new column** (one PR, one deploy):

```ts
const Users = model('users', {
  id:       f.id(),
  username: f.string(),              // still here, drop the unique
  handle:   f.string().unique(),     // now required + unique
});
```

App code now reads `handle` everywhere; writes still set both. `forge push` adds the unique on `handle`. After this deploy, no code reads `username`.

**Step 4 — drop the old column** (one PR, then `forge diff apply`):

```ts
const Users = model('users', {
  id:     f.id(),
  handle: f.string().unique(),
});
```

This adds the destructive item to the diff. Run `npx forge diff apply` (which shows the preview: `drop users.username`), confirm, apply. Or generate the migration file with `--dry`, commit it, and apply during the next deploy window.

### Why four steps and not one

A single-step rename (`username` → `handle`) means there's a window between "DB has both columns" and "app reads new column" where:
* Old app pods still write `username`, which doesn't exist anymore → 500s.
* New app pods read `handle`, which is empty for un-backfilled rows → wrong data.

The four-step pattern guarantees that at every deploy boundary, both the old and new app code work against the current DB shape. This is the same pattern as Stripe's column-additive migrations and GitHub's `gh-ost` workflow.

### When you can skip steps

* **Add-only changes** — adding a column with a default, adding a new model. Single step is fine.
* **Index changes** — adding or dropping an index is online on all dialects (CONCURRENTLY on PG, INPLACE on MySQL 8, single-statement on SQLite). Single step is fine.
* **Type widenings** — `int` → `bigint`, `varchar(50)` → `varchar(255)`. Single step is fine on PG / MySQL, requires rebuild on SQLite.

The four-step pattern is specifically for *renaming* and *splitting* — operations where the old and new shapes can't coexist without code change.

---

## Migration in monorepos

Two patterns, depending on whether services share a database.

### Pattern A — service-per-DB (recommended)

Each service owns its own database. The monorepo holds N schema files, N `DATABASE_URL`s, N deploy steps. `forge push` runs once per service per deploy.

```
packages/
  users-service/    src/schema.ts → DATABASE_URL_USERS
  billing-service/  src/schema.ts → DATABASE_URL_BILLING
  orders-service/   src/schema.ts → DATABASE_URL_ORDERS
```

Deploy script:

```sh
( cd packages/users-service   && DATABASE_URL=$DATABASE_URL_USERS   npx forge push )
( cd packages/billing-service && DATABASE_URL=$DATABASE_URL_BILLING npx forge push )
( cd packages/orders-service  && DATABASE_URL=$DATABASE_URL_ORDERS  npx forge push )
```

Schema-resolution finds the right schema per-service via the [cascade](../README.md#pointing-the-cli-at-your-schema) — each `package.json` has `"forge": { "schema": "./src/schema.ts" }` and `cd` into the package directory takes care of the rest.

### Pattern B — shared DB, partial-schema files

When multiple services share a database, each service should declare only the models it owns. Cross-service tables (read-only references) live in a `@org/db-shared` package that all services depend on.

```ts
// packages/shared/src/schema.ts — read-only model refs
export const Users = model('users', { id: f.id(), email: f.string() }, { readonly: true });
```

```ts
// packages/billing-service/src/schema.ts — own tables + import the shared refs
import { Users } from '@org/db-shared';

export const Invoice = model('invoices', {
  id:     f.id(),
  userId: f.string().refs(() => Users),
  total:  f.decimal(),
});

export const schema = { Invoice } as const;   // does NOT include Users
```

When `billing-service` runs `forge push`, the differ only sees `Invoice`. It won't try to create or drop `users`. The shared `Users` model still gives you typed FKs and join queries; it just doesn't participate in `push`.

There is no `forge push --exclude` flag — the way to exclude tables is to not include them in the schema you pass. This is intentional: an exclude flag on the CLI would let a deploy accidentally drop tables it doesn't own. The schema being the source of truth means the boundary is in code review.

### `forge diff` against the shared DB

Run `forge diff --ignore=` with the names of tables owned by sibling services:

```sh
export FORGE_DIFF_IGNORE='users,user_sessions,plans,plan_features'
npx forge diff --check
```

Bake the ignore list into the per-service CI env. Each service's CI sees only its own tables as drift candidates.

---

## Data migration vs DDL migration

`forge push` and `forge diff apply` handle DDL — table shape, indexes, constraints. Data migrations — backfilling a new column, transforming a JSON blob, splitting one column into two — are app code.

The pattern: a `scripts/migrate/<date>-<name>.ts` file that runs once, idempotently, and records itself in a one-off ledger.

```ts
// scripts/migrate/20260624-backfill-handle.ts
import { createDb, raw } from 'forge-orm';
import { schema } from '../../src/schema';

const MIGRATION_NAME = '20260624-backfill-handle';

const db = await createDb({ url: process.env.DATABASE_URL!, schema });

// Idempotency: skip if already applied. Reuse the forge ledger table.
await db.$executeRaw(raw`
  CREATE TABLE IF NOT EXISTS _forge_migrations (
    name VARCHAR(255) PRIMARY KEY, applied_at VARCHAR(64)
  )
`);
const [{ count }] = await db.$queryRaw<{ count: number }>(
  raw`SELECT COUNT(*)::int AS count FROM _forge_migrations WHERE name = ${MIGRATION_NAME}`,
);
if (count > 0) {
  console.log(`[migrate] ${MIGRATION_NAME} already applied`);
  process.exit(0);
}

await db.$transaction(async (tx) => {
  await tx.$executeRaw(raw`UPDATE users SET handle = username WHERE handle IS NULL`);
  await tx.$executeRaw(raw`
    INSERT INTO _forge_migrations (name, applied_at)
    VALUES (${MIGRATION_NAME}, ${new Date().toISOString()})
  `);
});

console.log(`[migrate] ${MIGRATION_NAME} applied`);
await db.$disconnect();
```

Three properties matter:

1. **Idempotent** — the ledger check at the top means re-running is a no-op. Safe to run on every deploy.
2. **Transactional where it matters** — the data UPDATE and the ledger insert are in the same `$transaction` so a crash mid-update doesn't half-record success. (MySQL DDL is implicitly committing — DML inside a tx is still safe.)
3. **Stored next to the schema** — `scripts/migrate/` files live in version control, get reviewed in the PR that adds the column, get deleted (or moved to `scripts/migrate/archive/`) once every environment has run them.

### Why not just `forge diff apply`

`forge diff apply` is DDL-only. It writes `ALTER TABLE … ADD COLUMN`, never `UPDATE …`. Mixing data migration into `_forge_migrations` files would mean those files contain logic the differ can't generate or reason about — they'd no longer be roundtrippable.

The split is: DDL through forge (generated, reversible-where-possible), data through hand-written `scripts/migrate/*.ts` (idempotent, your responsibility).

---

## Per-dialect rollback fidelity

Not every dialect can roll back DDL the same way. `forge rollback` does what it can; this table is the honest accounting.

| Dialect | DDL inside a transaction? | `forge rollback` recoverable for ADD | `forge rollback` recoverable for DROP |
|---|---|---|---|
| Postgres | Yes — full DDL in a tx, BEGIN/COMMIT brackets the whole migration | Yes (DROP COLUMN / DROP TABLE) | Yes for the *shape*; data is gone |
| MySQL | **No** — DDL implicitly commits any open tx | Yes (DROP COLUMN / DROP TABLE) | Yes for the shape; data is gone |
| SQLite | **No** — DDL is committed even inside BEGIN | Yes for `ADD COLUMN`; `DROP COLUMN` needs 3.35+ | Same as MySQL |
| DuckDB | Yes — DDL is transactional | Yes | Yes for shape |
| MSSQL | Yes — DDL is transactional | Yes | Yes for shape |
| Mongo | N/A — no DDL | Drop the index | Drop the collection (no rollback) |

The practical impact:

* **Postgres + DuckDB + MSSQL** — `forge rollback` is reliable. If the up was applied atomically, the down can be applied atomically. A crash mid-rollback leaves you at the post-up state, not half-rolled-back.
* **MySQL + SQLite** — each DDL statement is its own commit boundary. A crash mid-rollback leaves you at "some statements rolled back, some not". `forge rollback` doesn't detect this; you have to inspect the table state and re-run the rollback (which is idempotent for the DROP-then-ADD case) or fix forward.
* **Mongo** — `forge rollback` exits with an error: "Mongo uses forge:push, not SQL migrations". Roll back a Mongo schema by editing the schema and re-running `forge push`.

### What "data is gone" means for DROP rollback

When `forge rollback` runs the down of a DROP COLUMN migration:

```sql
-- up (the rollback ran this when diff apply originally applied)
ALTER TABLE users DROP COLUMN legacy_token;

-- down (the rollback runs this now)
ALTER TABLE users ADD COLUMN legacy_token TEXT;
```

You get the column back, with the type the introspect saw at apply time. You do not get the data back — the DROP deleted it. The same caveat applies to `DROP TABLE`, where the down is a comment ("cannot auto-restore"); there's no useful down statement at all.

If you need a destructive operation to be reversible, take a backup first and use `db.$executeRaw` to restore. forge does not snapshot data on DROP.

---

## Five worked workflows

### (a) New column added in a PR

You added `users.email_verified_at` to the schema. The PR is approved. The deploy steps:

```sh
# 1. Preview against staging
DATABASE_URL=$STAGING_URL npx forge diff --json | jq '.items'
#   → [{ "kind": "column", "direction": "missing", "table": "users", … }]

# 2. Apply on staging
DATABASE_URL=$STAGING_URL npx forge push
#   → applied 1, skipped 47, failures 0

# 3. Run smoke tests
npm run test:smoke -- --base-url=$STAGING_APP_URL

# 4. Apply on prod (typically wired into the CD pipeline; app start runs forge push)
DATABASE_URL=$PROD_URL npx forge push
#   → applied 1, skipped 47, failures 0
```

If you put `npx forge push` in the app's start command, steps 2 and 4 are automatic — `forge push` is idempotent and additive, so it's safe to run on every container start.

### (b) Drift detected in production

A scheduled `forge diff --check --json` job in CD failed at 3 AM. Triage:

```sh
# 1. Capture the report
DATABASE_URL=$PROD_URL npx forge diff --json > drift.json
jq '.items' drift.json
#   [
#     { "kind": "index", "direction": "extra",
#       "table": "events", "detail": "unique index u:idempotency_key in DB but not in schema" },
#     { "kind": "column", "direction": "missing",
#       "table": "users", "detail": "column 'mfa_secret'" }
#   ]

# 2. Decide: did someone hand-add the unique? (Audit log says yes, ops did it during incident.)
#    Fold it into the schema:
#    (in schema.ts)
#      Events.uniques: [['idempotency_key']]
git commit -am "Add unique on events.idempotency_key (matches prod)"

# 3. The missing column is genuine drift — the new column was deployed
#    but forge push didn't run. Apply it:
DATABASE_URL=$PROD_URL npx forge push

# 4. Verify back in sync
DATABASE_URL=$PROD_URL npx forge diff --check
#   → exit 0
```

A small triage script that auto-applies the safe slice and escalates the rest:

```ts
// scripts/drift-triage.ts
import { execSync } from 'child_process';

const report = JSON.parse(execSync('npx forge diff --json').toString());
const safe   = report.items.filter((i: any) => i.direction === 'missing');
const unsafe = report.items.filter((i: any) => i.direction !== 'missing');

if (safe.length > 0) {
  console.log(`Auto-applying ${safe.length} additive drift item(s) via forge push`);
  execSync('npx forge push', { stdio: 'inherit' });
}

if (unsafe.length > 0) {
  console.error(`Manual review needed for ${unsafe.length} item(s):`);
  console.error(JSON.stringify(unsafe, null, 2));
  process.exit(2);
}
```

### (c) Engine-managed Atlas collections

MongoDB Atlas keeps metadata in `_atlas_*` collections. Bake the ignore list into the CI env so they never show up as drift:

```yaml
# .github/workflows/schema.yml
env:
  FORGE_DIFF_IGNORE: '/^_atlas_/i,/^system\./i,/^enterpriseAdvancedAuth\./i'
```

Locally:

```sh
echo 'FORGE_DIFF_IGNORE=/^_atlas_/i,/^system\./i' >> .env
npx forge diff   # Atlas system collections filtered, surfaced in the trailing summary
```

The trailing `ignored 4 collections: …` line in the report lets you confirm the regex matched what you expected.

### (d) Renaming a column

Rename `users.username` → `users.handle`. Four deploys, each backward-compatible. See [Blue/green schema rollouts](#bluegreen-schema-rollouts) for the full pattern. The compressed version:

| Deploy | Schema | DDL emitted | App reads | App writes |
|---|---|---|---|---|
| 1 | both, `handle` nullable | ADD COLUMN handle | `username` | `username` |
| 2 (data) | — | — (data migration via `db.$executeRaw`) | `username` | `username` |
| 3 | both, `handle` unique | ADD UNIQUE on handle | `handle` | `username` + `handle` |
| 4 | only `handle` | (via `diff apply`) DROP COLUMN username | `handle` | `handle` |

Between deploys 3 and 4 the app instances all have to be on the new code. Forcing a graceful rollout finish before deploy 4 is the operator's job — forge doesn't enforce it.

### (e) Multi-tenant DB-per-tenant

A SaaS that gives each customer their own database. The deploy step loops over tenant URLs and runs `forge push` against each:

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

Run as a deploy step (or a scheduled job that runs daily, after every release). Because `forge push` is idempotent, re-running against tenants that succeeded is a no-op (`applied 0, skipped 47`).

For 100+ tenants, parallelise with a worker pool — each `forge push` opens its own connection pool, so 8-way concurrency is comfortable on a CI runner. Don't run more than the prod database fleet can handle.

---

## Runtime `$migrate()` + `$diff()` — when to use which

forge has two migration paths: the CLI (`forge push`, `forge diff`) for server-side, and the runtime (`db.$migrate()`, `db.$diff()`) for the browser and other constrained environments where shelling out to Node isn't possible.

### CLI — server-side, full power

* All adapters (Postgres, MySQL, SQLite, DuckDB, MSSQL, Mongo).
* Full DDL emit including FTS5 shadows, extension installs, foreign keys, views.
* `forge diff apply` writes migration files to disk.
* `forge rollback` reads them back and applies down blocks.
* Schema-resolution cascade, ts-node loading, all the developer-experience niceties.

This is what you run in CI, in deploy pipelines, and at server start.

### Runtime — browser, mobile, Tauri

* `db.$migrate()` and `db.$diff()` only on the sqlite-wasm browser adapter.
* No CLI, no file I/O — everything happens in a Web Worker against an OPFS database.
* Since 2.5.1, `$migrate()` runs a drift-apply pass too: introspect → diff → safely-additive ALTER COLUMN inside the same transaction. Destructive drift (DROP COLUMN, type changes, extra tables) surfaces under `report.pending` instead of being applied. See [BROWSER.md](./BROWSER.md#dbmigrate--runtime-ddl-apply--drift-detection) for the full shape.
* `db.$diff()` returns a `DriftReport` directly when you want the diff without the apply.

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
  // Decide app-side: wipe the local DB, prompt for export, or just live with it.
}
```

### Which to use

| Environment | Use |
|---|---|
| Production server / CI | CLI (`forge push`, `forge diff --check`) |
| Local dev | CLI (`forge push` at app start) |
| Browser / Electron / Tauri | Runtime (`db.$migrate()` at app boot) |
| Ephemeral demo (`:memory:` SQLite) | Runtime is fine; CLI doesn't have a path to `:memory:` |
| Mobile (React Native, Capacitor) | Runtime when SQLite is on-device |

The two paths share the differ (`diff-core.ts`) and the introspect adapters — drift detection is the same logic in both places. What changes is how the result is applied: the CLI generates SQL files and runs them via the driver pool; the runtime generates SQL strings and runs them inside the Worker's prepared-statement API.

For browsers, that's the whole story — see [BROWSER.md](./BROWSER.md#dbmigrate--runtime-ddl-apply--drift-detection) for the chunked rollout details, the `pending` report shape, and the Safari ITP eviction handling that affects how often `$migrate()` ends up running on a fresh DB.

---

# Snapshots — generating without a database (2.9.0)

```bash
npx forge generate --name add-org-slug
```

No `DATABASE_URL` connection. Nothing is introspected. The command diffs
your schema against the **last committed snapshot** and writes two files:

```
migrations/
  meta/
    _journal.json            ordering, and what each file was called
    0001_snapshot.json       the schema's shape after 0001
    0002_snapshot.json
  0001_initial.sql
  0002_add-org-slug.sql
```

## Why this exists

`forge diff apply` generates by introspecting the live database. That is
the right tool for **adopting** a database somebody else created, and the
wrong one for everyday work:

- **CI cannot check anything.** There is no database in the pipeline, so
  nothing can verify that a schema change arrived with its migration.
- **Two branches generate against two worlds.** Alice adds a column
  against her local database on Monday; Bob adds a different one against
  his on Tuesday. Each file is correct relative to a state that stops
  existing at the merge.
- **The same schema does not reliably produce the same SQL**, so a
  reviewer cannot regenerate the migration to check it matches the schema
  change in the same pull request.

A snapshot is simply **what `introspect()` would return if this schema
were applied**. Once that is a file, the differ does not care that it did
not come from a socket.

## The commands

| | reads | writes | needs a DB |
|---|---|---|---|
| `forge generate` | last snapshot | `.sql` + snapshot | **no** |
| `forge diff apply` | the live database | `.sql`, and applies it | yes |
| `forge push` | the live database | indexes only | yes |
| `forge rollback` | `_forge_migrations` | reverses the last file | yes |

```bash
npx forge generate --name add-orgs        # the usual case
npx forge generate --dialect postgres     # no DATABASE_URL at all
npx forge generate --check                # CI: exit 3 if a migration is missing
npx forge generate --custom --name backfill-slugs   # empty up/down to fill in
```

`--dialect` is only needed when `DATABASE_URL` is absent. When it is set,
the command reads its **scheme** to know the dialect and connects to
nothing.

## The CI gate

```yaml
- run: npx forge generate --check
```

Exit 3 when the schema contains changes that no migration covers, and it
names them:

```
[forge:generate] 1 change(s) are in the schema but not in any migration.
  - add orgs.region
```

This is the check that a database-backed generator cannot perform, and it
is the main reason to adopt snapshots.

## Custom and data migrations

```bash
npx forge generate --custom --name backfill-org-slugs
```

Writes an empty up/down and takes its place in the ordered history. Use
it for a backfill, or for the first half of a two-step change — clean the
NULLs, *then* add `NOT NULL`.

The snapshot it writes is **unchanged from the previous one**, on purpose:
forge cannot know what hand-written SQL does, and guessing would corrupt
every later diff.

## Reviewing the pair

Commit the `.sql` and its snapshot together. The `.sql` says what will
run; the snapshot says what the schema will then be. A reviewer who sees
one without the other is looking at half of the change.

Snapshots are sorted — tables, columns, indexes, keys — so reordering two
models in your schema file produces no diff at all, and the diff you do
see is the change you made.

## What a snapshot is not

**It is a projection, not a recording.** It describes what the schema
says, never what a database contains. It cannot see a column somebody
added by hand at 3am.

For that, `forge diff` against the live database is still the tool, and
still the honest answer to *"is production actually what we think it
is?"* — the two are complementary, and neither replaces the other.

## Adopting an existing database

Snapshots start from empty, so a first `generate` against a database that
already has tables would produce a create-everything migration you must
not run.

```bash
npx forge diff apply    # reconcile against what is really there, once
npx forge generate      # from here on
```

## One dialect per folder

A snapshot describes one dialect — column types and index shapes differ.
Pointing `generate` at a folder created for another one is refused rather
than diffed:

```
[forge] this migrations folder was generated for 'mysql', but DATABASE_URL
points at 'postgres'. Use a separate folder per dialect.
```

## Mongo

`forge generate` refuses on Mongo, and should. There is no DDL to
migrate: indexes are reconciled by `forge push`, which is idempotent and
needs no history.

---

# Column changes (2.10.0)

A column whose **type** or **nullability** changed used to be silently
absent from a generated migration. The schema said `varchar(255)`, the
database kept `varchar(64)`, the file applied cleanly, and nothing said a
word.

Silently omitting a change is the worst of the three options. forge now
picks one of the other two.

## Widening is emitted

Where every existing row still fits, the statement cannot fail on data:

| from | to | |
|---|---|---|
| `varchar(64)` | `varchar(255)` | longer |
| `varchar(255)` | `text` | unbounded |
| `int` | `bigint` | the one safe cross-category change |
| `numeric(10,2)` | `numeric(12,2)` | more precision |
| `NOT NULL` | `NULL` | dropping a constraint always succeeds |

```sql
-- up
ALTER TABLE `orgs` MODIFY COLUMN `hits` BIGINT NOT NULL;

-- down
-- narrowing hits back to int can fail on rows added since;
-- review before rolling back.
ALTER TABLE `orgs` MODIFY COLUMN `hits` int;
```

The `down` carries that warning because the reverse of a widening is a
**narrowing**, and it can fail on rows written since the migration ran.
A file that says "rollback" without saying so is lying to whoever runs
it at 3am.

## Everything else is refused

```
[forge:generate] refusing to generate 1 change(s).
  Each needs a decision forge cannot make for you.

  ✖ orgs.name: text → int
    orgs.name changes from text to int, which is not a widening —
    existing rows may not fit, or may not convert at all.
    → forge will not guess at this. Write it with `forge generate
      --custom`: add the new column, backfill it with whatever conversion
      is correct for YOUR data, verify, then drop the old one and rename.
      Doing it in one ALTER locks the table and fails on the first row
      that will not cast.
```

Exit code **2**. No file is written, no journal entry is made — including
for the safe changes in the same diff, because a migration that applies
cleanly while leaving the schema and the database disagreeing is the
failure this exists to remove, not a smaller version of it.

**The refusal is the feature.** A tool that emits `ALTER COLUMN … TYPE
int` against a column holding text is more dangerous than one that emits
nothing, because the migration *looks reviewed*.

## `NULL` → `NOT NULL`

Refused, always, and the message says why the obvious fix does not work:

> A `DEFAULT` does not help — a default applies to new rows, not to the
> ones already there.

The two-step migration:

```bash
npx forge generate --custom --name backfill-org-note
# UPDATE orgs SET note = '' WHERE note IS NULL;
```

Ship it. Confirm `SELECT count(*) FROM orgs WHERE note IS NULL` is 0.
Then make the column required in the schema and generate again — the
refusal turns into the `ALTER` once the data is clean.

## SQLite

Refused for any type or nullability change, because SQLite has no `ALTER
COLUMN`. The real answer is its documented twelve-step rebuild: create
`x_new`, `INSERT … SELECT`, drop, rename, recreate indexes and triggers.

forge will not generate that blind. Copying the column is the easy part;
the indexes, triggers and views pointing at the old table are the part a
generator cannot see, and getting that wrong drops them silently.

## What is not compared

A type forge cannot categorise — `tsvector`, a domain type, an extension
type — is left alone rather than rewritten. Better to say nothing about a
shape we do not understand than to emit an `ALTER` for it.

Mongo is skipped entirely: introspection reports no column types, so
there is nothing to compare.
