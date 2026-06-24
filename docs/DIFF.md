# Diff and drift detection

`forge diff` and `db.$diff()` compare your schema (the source of truth) against what is actually in the database, then emit a structured drift report. `forge diff apply` and the runtime `db.$migrate()` browser path use the same machinery to apply the safe subset automatically.

This file is the deep reference for both the CLI and the runtime path. The README's [Creating tables and migrations](../README.md#creating-tables-and-migrations) chapter is the surface tour and [MIGRATIONS.md](./MIGRATIONS.md) covers the full migration lifecycle (push → diff → apply → rollback) — read those first if you want context for the workflow. This document is about the *differ* itself: the IR-vs-introspect comparator, the `DriftItem` taxonomy, what counts as drift on each dialect, what `diff apply` is willing to emit unattended, and what the 2.5.1 runtime drift-apply pass returns.

Source of truth: `src/scripts/diff-core.ts` (the comparator), `src/scripts/diff.ts` (CLI entry), `src/scripts/diff-apply.ts` (apply entry), `src/scripts/migrate-gen.ts` (SQL generator), `src/wasm/drift-apply.ts` (runtime drift-apply), `src/wasm/migrate.ts` (runtime entry).

## Contents

* [What `diff` does, end-to-end](#what-diff-does-end-to-end)
* [`forge diff` CLI — flags, exit codes, output shapes](#forge-diff-cli--flags-exit-codes-output-shapes)
* [`forge diff apply` — the reconciliation generator](#forge-diff-apply--the-reconciliation-generator)
* [Runtime equivalents — `db.$diff()` and `db.$migrate()`](#runtime-equivalents--dbdiff-and-dbmigrate)
* [The `DriftItem` taxonomy](#the-driftitem-taxonomy)
* [Safe-apply vs pending — what runs unattended](#safe-apply-vs-pending--what-runs-unattended)
* [Per-dialect quirks](#per-dialect-quirks)
* [Ignore patterns](#ignore-patterns)
* [CI integration](#ci-integration)
* [`RuntimeApplyReport` — the 2.5.1 shape](#runtimeapplyreport--the-251-shape)
* [Common scenarios](#common-scenarios)
* [Related](#related)

---

## What `diff` does, end-to-end

The differ is pure — no IO of its own. It takes two inputs and returns a `DriftReport`:

```
   schema.ts                live DB
       │                       │
       ▼                       ▼
expectedFromSchema()    adapter.introspect()
       │                       │
       └──────────┬────────────┘
                  ▼
        diffIntrospection()
                  │
                  ▼
            DriftReport
```

* **`expectedFromSchema(schema)`** — walks every `model(...)` in the schema map, derives the tables, columns, indexes, FK edges, and views forge would emit at `forge push` time. Output is an `ExpectedTable` map keyed by `collection` name plus a separate `views` array.
* **`adapter.introspect()`** — reads the live DB through the same introspect path each adapter uses for `compile.<op>()`. Returns a `DbIntrospection` snapshot — tables with columns, indexes (full 2.2+ shape: `method`, `where`, `include`, `expression`, `partialFilterExpression`, `collation`, `wildcardProjection`, `keySpec`), FKs, views.
* **`diffIntrospection(schema, actual, ignore)`** — produces the `DriftReport`. Items, an `inSync` boolean (true only when items is empty), and an `ignored` list of names that matched an ignore pattern.

The split matters: `expectedFromSchema` is dialect-agnostic — same logic for every adapter. `adapter.introspect()` is per-adapter (the queries against `information_schema`, `pg_catalog`, `sqlite_master`, `listIndexes`). The differ never knows what dialect it's looking at past the comparator's "should I check column types?" branch (SQLite + Mongo are dynamic / schemaless, so type comparison is skipped on those).

The CLI and the runtime call the same `diffIntrospection`. The CLI prints the report; the runtime returns it. The 2.5.1 drift-apply pass takes the report and runs the safe subset.

---

## `forge diff` CLI — flags, exit codes, output shapes

```sh
npx forge diff                              # human-readable report
npx forge diff --json                       # machine-readable
npx forge diff --check                      # exit 3 if drift found (CI gate)
npx forge diff --ignore=logs,/^_atlas_/i    # skip noisy meta-tables
npx forge diff --schema=./src/schema.ts     # override the schema cascade
```

`diff` is read-only — it opens a connection, runs the introspect path, prints the report, disconnects. It never writes DDL, never touches `_forge_migrations`, never modifies a column.

### Flags

| Flag | Effect |
|---|---|
| `--json` | Print `DriftReport` as JSON instead of the bullet-list. CI-friendly; pipe through `jq` to filter by `kind` / `direction`. |
| `--check` | Exit 3 (not 0) when `inSync: false`. Use this in CI to fail the job on drift. |
| `--ignore=<list>` | Comma-separated names or `/regex/flags`. Stacks on top of `FORGE_DIFF_IGNORE` env var (additive — neither overwrites the other). |
| `--schema=<path>` | Override the [schema-resolution cascade](../README.md#pointing-the-cli-at-your-schema). `FORGE_SCHEMA_PATH` env var works the same way. |

### Output shape (`--json`)

```json
{
  "dialect": "postgres",
  "items": [
    { "kind": "column", "direction": "missing", "table": "users",
      "detail": "column 'email_verified_at'" },
    { "kind": "index",  "direction": "extra",
      "table": "users", "detail": "unique index u:legacy_email in DB but not in schema" },
    { "kind": "index",  "direction": "mismatch",
      "table": "users", "detail": "index 'idx_email_active' method: schema=gin db=btree" }
  ],
  "inSync": false,
  "ignored": ["hdb_catalog", "_atlas_meta"]
}
```

* `dialect` — `postgres` / `mysql` / `sqlite` / `duckdb` / `mssql` / `mongo`.
* `items[].kind` — `table` / `column` / `index` / `foreignKey` / `view` / `columnType`.
* `items[].direction` — `missing` (in schema, not in DB), `extra` (in DB, not in schema), `mismatch` (deep-field drift, e.g. wrong index method).
* `items[].table` — the table or collection name. For view drift this is the view name.
* `items[].detail` — a human-readable string. Stable enough to grep on, not stable enough to parse — let `kind`/`direction`/`table` drive any tooling.
* `inSync` — `true` only when `items` is empty. `ignored` doesn't affect this.
* `ignored` — names that matched an ignore pattern. Always surfaced so silent filtering can't hide real drift.

### Human-readable output

```
✗ drift detected on postgres (3 issues):
  − [column] users: column 'email_verified_at'
  + [index] users: unique index u:legacy_email in DB but not in schema
  ≠ [index] users: index 'idx_email_active' method: schema=gin db=btree
  (ignored 2 tables: hdb_catalog, _atlas_meta)
```

The sigils — `−` missing, `+` extra, `≠` mismatch — match the JSON `direction` field. The `(ignored …)` line at the bottom only appears when patterns matched something; absence of the line means the ignore list didn't do anything.

The in-sync form:

```
✓ no drift — live postgres schema matches forge schema
  (ignored 3 tables: hdb_catalog, _atlas_meta, system.profile)
```

### Exit codes

| Exit | Meaning |
|---|---|
| 0 | No drift. `inSync: true`. |
| 3 | Drift detected. Only emitted when `--check` is set; without it, drift exits 0 (the report is the output). |
| 1 | Something went wrong before the diff ran — no `DATABASE_URL`, unreachable DB, schema didn't load, adapter has no `introspect` implementation. |

The 3-vs-1 split lets a CI job distinguish "actual drift" from "couldn't even reach the DB". Pin a job's failure semantics on `exit_code == 3` to catch the former without false-positive on the latter.

---

## `forge diff apply` — the reconciliation generator

```sh
npx forge diff apply              # generate reconciliation migration + apply
npx forge diff apply --dry        # print the SQL only; don't apply, don't write the file
```

`diff apply` is the **read-write** sibling of `forge diff`. It generates a SQL migration file with `up` (bring DB forward) and `down` (inverse) sections, applies it statement-by-statement, and records the row in `_forge_migrations`. Files land in `./migrations/<timestamp>_drift.sql`.

This is the path you take when you want the SQL on disk before running it, or when you need a per-deploy artefact recording "the change applied on this date". For pure additive drift (new columns, new indexes), `forge push` is simpler — it does the same thing without writing a file. For destructive drift (dropping a column, dropping a table), `diff apply` is the only path — `push` is additive-only by design.

### Mongo is unsupported

```
[forge:diff:apply] Mongo uses forge:push for index management, not SQL migrations.
```

Mongo has no DDL — index management is a `createIndex` call against the live database, idempotent on the server. There's no "apply a migration file" path that makes sense. Re-run `forge push` against Mongo; that's the equivalent.

### The change preview

Before applying, `diff apply` prints the change list:

```
[forge:diff:apply] schema: /Users/me/app/src/schema.ts
[forge:diff:apply] 3 change(s):
  • add users.email_verified_at
  • drop sessions.legacy_token
  • drop table audit_old
```

If anything in that list isn't what you want, Ctrl-C. There is no `--accept-data-loss` flag. The way to preview without applying is `--dry`, which prints the full SQL plus does not write the file:

```sql
--- migration (dry run) ---
-- forge migration: 20260624T143052_drift
-- generated: 2026-06-24T14:30:52.413Z

-- up
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMPTZ;
ALTER TABLE "sessions" DROP COLUMN "legacy_token";
DROP TABLE IF EXISTS "audit_old";

-- down
DROP TABLE IF EXISTS "audit_old"; -- cannot auto-restore dropped table
ALTER TABLE "sessions" ADD COLUMN "legacy_token" text;
ALTER TABLE "users" DROP COLUMN "email_verified_at";
```

Notice the down for "extra table" is a comment, not real SQL. `diff apply` never invents a recreate plan for a dropped table because the data is gone — the down side is best-effort, not lossless. The same caveat applies to `DROP COLUMN`: the down ADDs the column back with the *type* the introspect saw at apply time, but not the data.

### What `diff apply` generates per drift item

The full source is `src/scripts/migrate-gen.ts`. Summary table:

| Drift item | What `diff apply` emits | Notes |
|---|---|---|
| `table` missing | Comment ("create table 'x' via forge:push (full DDL)") | The full CREATE TABLE goes through `forge push` because table creation pulls in column DDL, defaults, FK constraints, and FTS shadows — too much to inline in a one-table-per-statement reconciliation. Run `forge push` after. |
| `table` extra | `DROP TABLE IF EXISTS …` | `down` is a comment ("cannot auto-restore"). |
| `column` missing | `ALTER TABLE … ADD COLUMN …` | Nullable unless the schema field has a default; never NOT NULL without a constant default. Generated columns and id columns are skipped (they're CREATE-TABLE-only concerns). |
| `column` extra | `ALTER TABLE … DROP COLUMN …` | `down` is `ADD COLUMN` with the type introspect read back; data is gone. |
| `columnType` mismatch | Not emitted | A type change needs human judgment — narrowing risks truncation, widening can require an INDEX REBUILD on some dialects. `diff apply` surfaces it in the report; you write the DDL by hand. |
| `index` missing | `CREATE INDEX` with the full 2.2+ shape | Method, partial WHERE, INCLUDE columns, expression body — all translated per-dialect. Unique flag preserved. |
| `index` extra (unique) | Not emitted | The differ reports it (someone hand-added a unique constraint). To match it back, fold the unique into the schema. To drop it, write the `DROP INDEX` by hand. |
| `index` mismatch | Not emitted | An index that differs in method / WHERE / INCLUDE / expression needs `DROP INDEX` then `CREATE INDEX` — which `forge push` does via its idempotent recreate path. `diff apply` doesn't try; recreate at push time. |
| `foreignKey` missing | `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` | SQLite emits a comment ("SQLite cannot ALTER ADD FK") because the dialect doesn't support adding FKs after table create. MySQL and PG emit the full DDL. |
| `view` missing | Not emitted (handled by `forge push`) | Views are CREATE-time, like tables. |

### The migration file format

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

The down section reverses the up order — last-up-first-down — so dependent operations stay in lock-step. `forge rollback` reads this file back, runs the down block, and removes the row from `_forge_migrations`. Per-dialect rollback fidelity is in [MIGRATIONS.md](./MIGRATIONS.md#per-dialect-rollback-fidelity).

### Idempotency on re-run

`diff apply` checks `_forge_migrations` before running statements. If the timestamp slug is already there (you re-ran the script), it exits cleanly without re-applying. Same name means same state — a re-run is a no-op, not a double-apply.

### Failure handling

If a statement fails mid-batch, `diff apply` prints the failing SQL and the driver's error, then aborts:

```
[forge:diff:apply] 3 change(s):
  • add users.email_verified_at
  • drop sessions.legacy_token
  • drop table audit_old
  ✗ failed: ALTER TABLE "sessions" DROP COLUMN "legacy_token"
    column "legacy_token" does not exist
```

The prior statements remain applied (PG wraps DDL in a transaction, but `diff apply` runs each statement on its own connection; mid-batch failure leaves the partial state). The migration row is not recorded — re-running will retry, skipping the already-applied parts via dialect-level idempotency (`ADD COLUMN IF NOT EXISTS` doesn't exist on PG/MySQL, so the retry will fail differently; fix the underlying cause first).

For all-or-nothing semantics on a strict-tx dialect (PG / DuckDB / MSSQL), run the migration file by hand inside a `BEGIN; … COMMIT;` wrapper. The `diff apply` flow trades the all-or-nothing property for the ability to record applied state per-statement on dialects where DDL implicitly commits anyway (MySQL / SQLite older than 3.35).

---

## Runtime equivalents — `db.$diff()` and `db.$migrate()`

The browser path doesn't have a CLI. The equivalents live on the `db` handle:

### `db.$diff(opts?)` — drift detection

```ts
const report = await db.$diff();
// {
//   dialect: 'sqlite',
//   items: [
//     { kind: 'column', direction: 'missing', table: 'users',
//       detail: "column 'email_verified_at'" },
//   ],
//   inSync: false,
// }
```

Same `DriftReport` shape as `forge diff --json`. Works on every adapter that implements `introspect` — currently all six (PG, MySQL, SQLite, DuckDB, MSSQL, Mongo). The `ignore` option takes the same `IgnoreSpec` the CLI accepts via `--ignore`:

```ts
const report = await db.$diff({
  ignore: ['logs', /^_atlas_/i, 'external_events'],
});
```

`$diff` never writes. Use it server-side as a programmatic alternative to shelling out to `forge diff --json`, or in the browser to inspect what `$migrate` would skip.

### `db.$migrate(opts?)` — runtime DDL apply + drift-apply

```ts
const report = await db.$migrate();
// {
//   applied:        ['items', 'forge_items_unique_name'],
//   skipped:        [],
//   failures:       [],
//   alteredColumns: ['items.email_verified_at'],
//   pending:        [],
// }
```

`$migrate` is sqlite-only today (the wasm browser path). On other adapters it throws — those go through the CLI. It does, in order:

1. Build full schema DDL from the active schema map (`buildSchemaDDL`).
2. Apply it via the idempotent `CREATE … IF NOT EXISTS` pass — every missing table and index lands; existing ones are skipped.
3. (Since 2.5.1) Run a drift-apply pass: `introspectSqlite` → `diffIntrospection` → `ALTER TABLE … ADD COLUMN` for every missing-column drift item that's safe to add. Destructive drift goes to `pending`.

The drift-apply pass is on by default. Pass `{ alter: false }` to skip it — useful if you're shipping your own migration runner and want `$migrate` to behave like 2.4 / 2.5.0 (strict create-or-skip).

```ts
// 2.5.0 behaviour: don't touch existing tables' shape.
const report = await db.$migrate({ alter: false });
// report.alteredColumns is always [], report.pending is always [].
```

The full `RuntimeApplyReport` shape is documented under [`RuntimeApplyReport` — the 2.5.1 shape](#runtimeapplyreport--the-251-shape).

### `applyDrift` — the drift-apply primitive

```ts
import { applyDrift } from 'forge-orm/wasm';

const driver = (await createDb({ url: 'opfs:/app.sqlite', schema })).adapter.db;
const driftReport = await applyDrift(driver, { schema });
// {
//   alteredColumns: ['items.email_verified_at'],
//   pending:        [{ kind: 'column', direction: 'extra', ... }],
//   failures:       [],
// }
```

Exposed for callers who want to run the drift pass on its own — e.g. after a manual `$executeRaw` schema patch, or against a pre-migrated DB. `$migrate` calls this internally. Source: `src/wasm/drift-apply.ts`.

### Which path on which adapter

| Environment | Use |
|---|---|
| Production server / CI | `forge diff` (read), `forge diff apply` (write) |
| Local dev (Node) | `forge diff` |
| Browser / Electron / Tauri (sqlite-wasm) | `db.$diff()` (read), `db.$migrate()` (read + write) |
| Programmatic on any adapter | `db.$diff()` works server-side too — same comparator, just no CLI wrapper |

The two paths share `diffIntrospection` (the pure comparator in `src/scripts/diff-core.ts`) and the per-adapter `introspect()` calls. What changes is the apply step: the CLI generates a SQL file and runs it via the driver pool; the runtime generates SQL strings and runs them inside the worker's prepared-statement API.

---

## The `DriftItem` taxonomy

Every entry the differ emits matches the same shape:

```ts
export interface DriftItem {
  kind: 'table' | 'column' | 'index' | 'foreignKey' | 'view' | 'columnType';
  direction: 'missing' | 'extra' | 'mismatch';
  table: string;
  detail: string;
}
```

The full classification:

### `table`

| Direction | Trigger | Example | Per-dialect |
|---|---|---|---|
| `missing` | Schema declares `model('orders', …)` but no table `orders` exists. | `{ kind: 'table', direction: 'missing', table: 'orders', detail: "table 'orders' declared in schema but not in DB" }` | Same across SQL. Mongo: same trigger ("collection declared, none in DB"); collections are implicit on first insert so this usually means the collection has truly never been touched. |
| `extra` | Table in DB whose name isn't any model's `collection`. | `{ kind: 'table', direction: 'extra', table: 'audit_old', detail: "table 'audit_old' in DB but not in schema" }` | Filtered: `_forge_migrations`, anything matching `/_fts/i`, matview-backing tables for a declared view. |

### `column`

| Direction | Trigger | Example | Per-dialect |
|---|---|---|---|
| `missing` | Field in schema but no column with that name on the matching table. | `{ kind: 'column', direction: 'missing', table: 'users', detail: "column 'email_verified_at'" }` | Skipped on Mongo (schemaless — no column drift concept). |
| `extra` | Column in DB but no field with that name on the matching model. | `{ kind: 'column', direction: 'extra', table: 'users', detail: "column 'legacy_token' in DB but not in schema" }` | Skipped on Mongo. |

### `columnType`

| Direction | Trigger | Example |
|---|---|---|
| `mismatch` | Field's *category* differs from the DB column's category. | `{ kind: 'columnType', direction: 'mismatch', table: 'orders', detail: "column 'total': schema=decimal db=text" }` |

Skipped on SQLite (dynamic typing) and Mongo (schemaless). The category mapping is intentional — it tolerates dialect-specific spellings without false-positiving:

| Schema kind | Category | DB types that match |
|---|---|---|
| `id`, `objectId`, `string`, `text`, `uuid`, `enum` | `string` | `text`, `varchar*`, `char*`, `uuid`, `citext` |
| `int` | `int` | `smallint`, `integer`, `int`, `int4`, `int2`, `mediumint` |
| `bigint` | `bigint` | `bigint`, `int8` |
| `float` | `float` | `real`, `double*`, `float*` |
| `decimal` | `decimal` | `numeric*`, `decimal*` |
| `bool` | `bool` | `bool*`, `tinyint(1)` |
| `dateTime` | `datetime` | `timestamp*`, `datetime*`, `date`, `time*` |
| `json`, `embed`, `embedMany` | `json` | `json`, `jsonb` |
| arrays, custom types | — | (skipped) |

PG `text` vs `varchar(255)` doesn't drift. MySQL `tinyint(1)` vs `bool` doesn't drift. MSSQL `nvarchar(MAX)` vs `text` doesn't drift. The cost is that genuine narrowings — `bigint` → `int` say — won't be caught if the field falls outside the table. The trade-off is "don't cry wolf" — false negatives are easier to live with than false positives that erode trust in the report.

### `index`

| Direction | Trigger | Example |
|---|---|---|
| `missing` | Index column-set + uniqueness signature in schema but not in DB. | `{ kind: 'index', direction: 'missing', table: 'users', detail: 'index u:email,tenant_id' }` |
| `extra` | **Unique-only** — extra non-unique indexes don't drift (engines create their own constraint-backing indexes). Extra *unique* indexes do. | `{ kind: 'index', direction: 'extra', table: 'users', detail: 'unique index u:legacy_email in DB but not in schema' }` |
| `mismatch` | Named index exists on both sides but `method`, `where`, `include`, `expression`, `partialFilterExpression`, `collation`, `wildcardProjection`, or per-key direction tokens differ. | `{ kind: 'index', direction: 'mismatch', table: 'users', detail: "index 'idx_email_active' method: schema=gin db=btree" }` |

Index `mismatch` only fires when both sides have an index with the same explicit `name`. Unnamed indexes participate in the column-set signature check only — the differ won't try to align a generated name across runs (the names embed the column list, so a column change shifts the name and they look like "missing + extra" rather than "mismatch").

Each deep-field mismatch is its own entry, scoped by index name. An index that drifted in both `method` and `where` produces two `DriftItem`s, not one merged "something changed":

```
≠ [index] users: index 'idx_email_active' method: schema=gin db=btree
≠ [index] users: index 'idx_email_active' where: schema=active = true db=∅
```

### `foreignKey`

| Direction | Trigger | Example |
|---|---|---|
| `missing` | Relation declared in schema with a non-id `on` column, but no FK with matching `column → refTable.refColumn` in DB. | `{ kind: 'foreignKey', direction: 'missing', table: 'invoices', detail: 'user_id->users.id' }` |

`extra` and `mismatch` are not generated for foreign keys today. The differ only knows about FKs the schema declares; an extra FK in the DB stays invisible. Skipped on Mongo (no FKs).

### `view`

| Direction | Trigger | Example |
|---|---|---|
| `missing` | `model('active_users', { … }, { view: { … } })` in schema but neither a view nor a table with that name in DB. | `{ kind: 'view', direction: 'missing', table: 'active_users', detail: "view 'active_users'" }` |

The "either view or table" check is for PG matviews and table-backed views — a matview surfaced via `pg_matviews` may not appear in the regular `pg_views` list, so the differ falls back to "is there *anything* with this name?" before flagging. View `extra` and `mismatch` are not generated.

### What is NOT flagged as drift

| Non-drift | Why |
|---|---|
| Column ordering | Schemas declare order in the IR for DDL emit, but introspect just reads back the names. Reordering a model doesn't generate drift. |
| Default expressions | Each dialect echoes defaults differently — PG normalises `gen_random_uuid()`, MySQL re-spells `CURRENT_TIMESTAMP`. Comparing default-expression strings is high-noise / low-signal; the differ skips it. |
| Nullable / NOT NULL drift on existing columns | The introspect adapters read `nullable`, but the comparator doesn't compare it. Adding nullability via `forge push` is safe; removing it (NOT NULL on a nullable column with NULLs) would fail at apply time. The user-driven path is `diff apply`. |
| `_forge_migrations` | The migration ledger — always filtered. |
| `*_fts` shadow tables | Engine-managed by FTS5 / GIN tsvector / Mongo `text`. Always filtered. |
| Matview backing tables | A PG matview surfaced as a table is matched against the schema view list before being flagged extra. |
| Non-unique extra indexes | DBs add their own (constraint-backing, auto-stat). Only extra *unique* indexes drift. |
| Type comparison on SQLite + Mongo | SQLite types are dynamic; Mongo has no DDL. Column-existence and index drift still apply. |

---

## Safe-apply vs pending — what runs unattended

The 2.5.1 runtime drift-apply pass (`applyDrift` in `src/wasm/drift-apply.ts`) splits every `DriftItem` into three buckets:

* **Safe** — emit DDL inside the transaction. Currently: missing columns that meet the "safe to ADD" criteria below.
* **Pending** — surface in `report.pending` for the caller to handle. Destructive or otherwise unsafe.
* **Failures** — emitted but the DB rejected the statement (e.g. constraint conflict at apply time).

### The safe slice

Currently *only*:

* `{ kind: 'column', direction: 'missing' }` where the field passes `isSafeAddColumn`:
  * Field is **not** `kind: 'id'` (primary key columns can't be added with ADD COLUMN — they're CREATE-TABLE-only).
  * Field is **not** `dbGenerated` (generated columns are CREATE-TIME concerns on SQLite; ALTER ADD GENERATED doesn't exist).
  * Field is either `optional` (nullable, the safest add) **or** has a `default` set (constant default — `literal`, `now`, or `autoId`). SQLite refuses NOT NULL ADD COLUMN without a constant default; the differ obeys that rule.

Everything else lands in `pending`.

### What stays pending

| Drift item | Why it stays pending |
|---|---|
| `{ kind: 'column', direction: 'extra' }` | Drop column. Destructive — data loss. The runtime won't do this unsupervised. |
| `{ kind: 'column', direction: 'missing' }` with a NOT NULL field and no default | Adding NOT NULL without a default fails on a non-empty table. Surface so the caller can backfill first, then re-run. |
| `{ kind: 'column', direction: 'missing' }` with a generated column | ALTER ADD GENERATED isn't supported on SQLite. Pending. |
| `{ kind: 'column', direction: 'missing' }` with an id field | Adding a PK column after CREATE TABLE isn't a supported operation. Almost always means the *table* is missing — which the CREATE pass already handled. |
| `{ kind: 'columnType', direction: 'mismatch' }` | Type changes need ALTER COLUMN, which SQLite doesn't support — the only safe path is a full table rebuild (CREATE NEW, INSERT FROM OLD, DROP OLD, RENAME). Out of scope for a drift fix. |
| `{ kind: 'table', direction: 'extra' }` | Drop table. Destructive — data loss. |
| `{ kind: 'table', direction: 'missing' }` | Should never reach drift-apply — the CREATE pass already handles missing tables. If one does (introspect/diff race), it surfaces in pending. |
| `{ kind: 'index', direction: 'extra' }` (unique) | Dropping an unfamiliar unique index could be deliberate (someone hand-added it because the schema is wrong) — surface, don't drop. |
| `{ kind: 'index', direction: 'mismatch' }` | An index that drifted in method / where / include / expression. The fix is DROP + CREATE; the runtime won't reach for that on its own. |
| `{ kind: 'foreignKey', direction: 'missing' }` | SQLite can't ALTER ADD FK — needs table rebuild. Pending. |
| `{ kind: 'view', direction: 'missing' }` | Views are CREATE-time. Pending if introspect missed it on the create pass. |

### Pending policy on the app side

```ts
const report = await db.$migrate();
if (report.pending.length > 0) {
  // Three common policies:
  //
  //  (a) Soft-fail: log + carry on. The app probably still works against
  //      the existing shape; drift is a hint, not an error.
  console.warn('Schema drift not auto-applied:', report.pending);
  //
  //  (b) Hard-reset: wipe the on-device DB. Common pattern in offline-first
  //      apps where the source of truth is the server.
  await dropDatabase();
  await db.$migrate();   // fresh shape from current schema
  //
  //  (c) Prompt the user: export-then-reset. Last-ditch when the data on
  //      device matters and you don't want to silently nuke it.
  await promptUserToExport();
}
```

The runtime doesn't choose for you. The differ is just the report; what to do with the destructive items is product code.

---

## Per-dialect quirks

The differ is dialect-aware in three places: which check it runs, which fields the introspect adapter populated, and how `migrate-gen` translates a missing index into DDL.

### Postgres

* **Type comparison** runs (PG types are static).
* **Introspect** reads from `pg_class`, `pg_attribute`, `pg_index`, `pg_constraint`. Index `method` is populated (`btree`, `gin`, `gist`, `brin`, `hash`). `include` is the tail of `pg_index.indkey` after `indnatts`. `where` comes from `pg_get_expr(indpred)`.
* **Method drift detection** — a `method: 'gin'` schema-side declaration vs `btree` in DB produces an `index mismatch` entry. Default `btree` is assumed if the schema doesn't specify.
* **`diff apply`** translates a missing index to `CREATE [UNIQUE] INDEX IF NOT EXISTS … [USING <method>] (…) [INCLUDE (…)] [WHERE …]`.
* **Matview backing tables** — when a matview surfaces as both a `pg_matviews` row and a `pg_class` table, the differ matches the schema view list before flagging as extra.

```ts
// Schema declares a GIN index with a partial filter
indexes: [{
  name: 'idx_email_active',
  keys: { email: 1 },
  method: 'gin',
  where: 'active = true',
}],

// DB has a BTREE index without the WHERE clause
// → two drift items:
//   ≠ [index] users: index 'idx_email_active' method: schema=gin db=btree
//   ≠ [index] users: index 'idx_email_active' where: schema=active = true db=∅
```

### MySQL

* **Type comparison** runs.
* **Introspect** reads `information_schema.tables/columns/statistics/key_column_usage`. Index `method` is normalised to `BTREE` / `FULLTEXT` / `SPATIAL`. Pre-8.0 versions can't read expression-index body — the introspect adapter leaves `expression: undefined`, and the differ skips the deep check for that field.
* **No INCLUDE** — covering columns aren't a MySQL concept. A schema-side `include: [...]` is silently ignored at push time; the differ won't false-positive because `actual.indexes[*].include` will be `undefined`.
* **Partial-filter indexes** translate to `CASE WHEN … THEN col END` expression indexes when `unique: true`. The differ deep-compares as `expression`, not `where`.
* **`diff apply`** doesn't emit `USING` for SPATIAL / FULLTEXT — those are statement-prefix keywords (`CREATE SPATIAL INDEX …`).

### SQLite

* **Type comparison** is *skipped* — SQLite has dynamic typing. Schemas can declare `f.string()` and the underlying column will accept any value; comparing storage class to declared kind is high-noise.
* **Introspect** reads `sqlite_master` + `PRAGMA table_info` + `PRAGMA index_list` + `PRAGMA index_info`. `where` is parsed out of the `CREATE INDEX` SQL text in `sqlite_master.sql`.
* **No FK ALTER** — SQLite can't `ALTER TABLE … ADD CONSTRAINT FOREIGN KEY`. A missing FK in the diff produces a comment-only `up`: `-- SQLite cannot ALTER ADD FOREIGN KEY …; recreate the table to add it`.
* **No ALTER COLUMN** — SQLite has no ALTER COLUMN at all. A `columnType` mismatch can't be fixed by `diff apply`; the fix is a full table rebuild.
* **DROP COLUMN** needs SQLite 3.35+ (released 2021-03). `diff apply` emits the bare `ALTER TABLE … DROP COLUMN`; on older versions the statement fails and you do the rebuild dance manually (see [MIGRATIONS.md § SQLite < 3.35](./MIGRATIONS.md#sqlite--335-column-drop-requires-rebuild)).
* The runtime drift-apply pass is sqlite-only — every `pending` decision in `applyDrift` is shaped around SQLite's ALTER restrictions.

### DuckDB

* **Type comparison** runs.
* **Introspect** reads `duckdb_tables` / `duckdb_columns` / `duckdb_indexes`. DuckDB's index introspection is minimal — `method` may be `undefined`, partial `where` may be `undefined`. The differ only flags drift on what it can read.
* **Spatial extension** auto-loads on connect; no `--enable-extensions` needed.
* **`diff apply`** emits the same shape as SQLite — `CREATE INDEX IF NOT EXISTS`, plain `WHERE`, no `INCLUDE` (DuckDB has no covering-index syntax).

### MSSQL

* **Type comparison** runs.
* **Introspect** reads `sys.tables` / `sys.columns` / `sys.indexes`. INCLUDE is supported and populated.
* **`GEOGRAPHY`** and **`VECTOR(N)`** are built-in — no extension to install. Geo and vector drift detection works the same as on PG.
* **`diff apply`** support — MSSQL is supported by `migrate-gen.ts` for the additive cases but FK drops use `DROP CONSTRAINT IF EXISTS` (not `DROP FOREIGN KEY`).

### Mongo

* **Type comparison** is *skipped* — schemaless.
* **Column drift** is *skipped* — there are no columns. The differ checks table (collection) presence and indexes only.
* **Introspect** reads `db.command({ listCollections })` and `collection.listIndexes()`. Mongo populates the richest introspect surface: `partialFilterExpression`, `collation`, `wildcardProjection`, `keySpec` (per-key direction tokens — `1`, `-1`, `'text'`, `'2dsphere'`, `'2d'`, `'hashed'`).
* **`diff apply`** isn't supported. `forge diff apply` against a Mongo URL exits with `[forge:diff:apply] Mongo uses forge:push for index management, not SQL migrations.` Re-run `forge push` instead — `createIndex` is idempotent on the server, and Mongo error 85/86 (index spec drift) triggers a drop-and-recreate at push time.
* **Partial filter / collation / wildcardProjection** comparison uses stable-key JSON so `{ a: 1, b: 2 }` doesn't false-positive against `{ b: 2, a: 1 }`. Collation is projected to user-declared keys before compare so the DB's echoed defaults (`numericOrdering: false`, `strength: 3`, …) don't flood the report.

### Summary table

| Feature | Postgres | MySQL | SQLite | DuckDB | MSSQL | Mongo |
|---|---|---|---|---|---|---|
| Column existence drift | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Column type drift | ✓ | ✓ | — (dynamic) | ✓ | ✓ | — (schemaless) |
| Index existence drift | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Index method drift | ✓ | ✓ | — | partial | ✓ | n/a |
| Index `where` drift | ✓ | as expression | ✓ | partial | ✓ | — |
| Index INCLUDE drift | ✓ | n/a | n/a | n/a | ✓ | n/a |
| Index expression drift | ✓ | ✓ (8.0+) | ✓ | ✓ | n/a | n/a |
| Index collation drift | n/a | n/a | n/a | n/a | n/a | ✓ |
| Index `partialFilterExpression` drift | n/a | n/a | n/a | n/a | n/a | ✓ |
| `wildcardProjection` drift | n/a | n/a | n/a | n/a | n/a | ✓ |
| `keySpec` drift | n/a | n/a | n/a | n/a | n/a | ✓ |
| FK drift | ✓ | ✓ | ✓ (report only — no apply) | ✓ | ✓ | n/a |
| View drift | ✓ | ✓ | ✓ | ✓ | ✓ | n/a |
| Extra-table drift | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (collection) |
| `diff apply` | ✓ | ✓ | ✓ (3.35+ for drops) | ✓ | ✓ | not supported |

---

## Ignore patterns

```sh
npx forge diff --ignore=logs,sessions,/^_atlas_/i,events
export FORGE_DIFF_IGNORE='/^_/i,external_events'
npx forge diff   # CLI flag and env var stack
```

```ts
// Programmatic
const report = await db.$diff({
  ignore: ['logs', /^_atlas_/i, 'events'],
});
```

Two forms:

* **Exact-match string** — `logs` matches the table `logs` and nothing else.
* **`/regex/flags`** — anything wrapped in slashes is parsed as a regex. `/^_atlas_/i` matches any table starting with `_atlas_` case-insensitively.

Items are comma-separated. The CLI flag and `FORGE_DIFF_IGNORE` env var both feed the same list — the CLI flag stacks on top of the env var (additive), so a fleet-wide default can be extended for a single run without overwriting it.

### `parseIgnoreList` — direct use

```ts
import { parseIgnoreList } from 'forge-orm/scripts/diff-core';

parseIgnoreList('logs,/^_atlas_/i,events');
// → ['logs', /^_atlas_/i, 'events']

parseIgnoreList(undefined);
// → []
```

Import this directly when building tooling around the differ — a custom CI step that calls `diffIntrospection` programmatically can take the same `FORGE_DIFF_IGNORE` env var as the CLI by piping it through `parseIgnoreList`.

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
| Sibling-service tables | `users,plans,user_sessions` | Pattern B monorepos — see [MIGRATIONS.md § shared DB](./MIGRATIONS.md#pattern-b--shared-db-partial-schema-files). |

The right answer for any of these is to bake the pattern into `FORGE_DIFF_IGNORE` in the CI env so every diff job picks it up automatically.

### Ignored names are reported

```
✓ no drift — live postgres schema matches forge schema
  (ignored 3 tables: hdb_catalog, _atlas_meta, system.profile)
```

Silent filtering would let a real-drift table slip through if someone accidentally wrote a too-broad regex. The trailing summary lets you verify the ignore list is doing what you meant.

---

## CI integration

The standard shape: a job that fails the PR when drift is introduced. Two flavours.

### (a) Drift gate — fail PRs that introduce drift

The shape: shape a staging DB from `origin/main`, then diff the PR's schema against it. Drift means "the PR adds DDL that needs to land before app code goes live". MIGRATIONS.md has the full GitHub Actions YAML; the heart of it is:

```yaml
- run: git worktree add /tmp/main origin/main
- run: ( cd /tmp/main && npm ci --omit=dev && npx forge push )
- id: diff
  run: npx forge diff --check --json | tee diff.json
  continue-on-error: true
- if: steps.diff.outcome == 'failure'
  run: exit 1
```

`--check` makes the diff exit 3 on drift; pipe the JSON through `actions/github-script` to comment it on the PR. The exit code split (3 = drift, 1 = couldn't reach DB) means an unreachable DB doesn't false-positive as drift.

### (b) Safe-apply on staging

After the gate passes, a follow-up job auto-applies the safe slice to staging. The `jq` gate is the trust boundary — `forge push` is additive-only by design, so this is belt-and-suspenders. Destructive items stop the job before any data is at risk; a human runs `forge diff apply` with the preview in front of them.

```sh
DESTRUCTIVE=$(npx forge diff --json | jq '[.items[] | select(.direction == "extra")] | length')
[ "$DESTRUCTIVE" -gt 0 ] && { echo "manual review required"; exit 2; }
npx forge push
```

### (c) Triage script — auto-apply additive, escalate destructive

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

Run as a CD post-deploy hook. Exit 2 trips an alert; exit 0 means the deploy converged. For Datadog / Prometheus / CloudWatch wiring, see [MIGRATIONS.md § post-deploy verify](./MIGRATIONS.md#c-post-deploy-verify--diff-json-as-a-metric).

---

## `RuntimeApplyReport` — the 2.5.1 shape

`db.$migrate()` returns this:

```ts
export interface RuntimeApplyReport extends ApplyReport {
  applied:        string[];      // names of objects the CREATE pass created (tables, indexes)
  skipped:        string[];      // names the CREATE pass found already in place
  failures:       { name: string; error: string }[];   // CREATE pass + drift-apply failures merged
  alteredColumns: string[];      // 'table.column' for each ADD COLUMN run by drift-apply
  pending:        DriftItem[];   // destructive / unsafe drift left untouched
}
```

`applied` and `skipped` come from the create pass (`buildSchemaDDL` → `applyMigration`). `failures` aggregates both passes — a CREATE failure for `forge_users_unique_email` and an ALTER failure for `users.email_verified_at` both land here. The two new fields in 2.5.1 are:

* **`alteredColumns`** — entries are `<table>.<column>` strings, one per `ALTER TABLE … ADD COLUMN` the drift-apply pass ran. Empty when nothing drifted or when `{ alter: false }` was passed. The whole batch runs inside one transaction; mid-batch failures roll back and surface in `failures`, not `alteredColumns`.

* **`pending`** — every `DriftItem` the drift-apply pass declined to fix. The runtime never auto-applies destructive drift; you decide what to do with `pending`. See [Safe-apply vs pending](#safe-apply-vs-pending--what-runs-unattended).

### Worked examples

#### Clean boot, then a no-op subsequent boot

On first boot the database file is empty. The CREATE pass lays everything down; the drift-apply pass has nothing to do — `applied` lists the table + indexes, every other field is empty.

On the next boot everything is already there. `IF NOT EXISTS` short-circuits the CREATEs (they land in `skipped`); the drift-apply pass introspects, finds no drift, returns empty.

#### New nullable column added to the schema since last boot

```ts
// schema.ts
const Items = model('items', {
  id:    f.id(),
  sku:   f.string().unique(),
  name:  f.string(),
  notes: f.string().optional(),   // ← added in this release
});

const report = await db.$migrate();
// {
//   applied:        [],
//   skipped:        ['items', 'forge_items_pk', 'forge_items_unique_sku'],
//   failures:       [],
//   alteredColumns: ['items.notes'],
//   pending:        [],
// }
```

The CREATE pass skipped the existing table. The drift-apply pass diffed and found `items.notes` missing; `f.string().optional()` is safe to ADD, so it ran `ALTER TABLE "items" ADD COLUMN "notes" TEXT` inside a transaction.

#### Column removed from the schema since last boot

```ts
// schema.ts
const Items = model('items', {
  id:   f.id(),
  sku:  f.string().unique(),
  // name was removed
});

const report = await db.$migrate();
// {
//   applied:        [],
//   skipped:        ['items', 'forge_items_pk', 'forge_items_unique_sku'],
//   failures:       [],
//   alteredColumns: [],
//   pending:        [
//     { kind: 'column', direction: 'extra', table: 'items',
//       detail: "column 'name' in DB but not in schema" },
//   ],
// }
```

`pending` surfaces the extra column. The runtime doesn't drop it. Your app code can `console.warn`, prompt the user, or do nothing — drift on `extra` columns is harmless for reads (the queryer just ignores them).

#### NOT NULL column added without a default

```ts
const Items = model('items', {
  id:    f.id(),
  sku:   f.string().unique(),
  count: f.int(),    // NOT NULL, no default — can't ADD safely
});

const report = await db.$migrate();
// {
//   alteredColumns: [],
//   pending:        [
//     { kind: 'column', direction: 'missing', table: 'items',
//       detail: "column 'count'" },
//   ],
//   ...
// }
```

The drift-apply pass refused — SQLite rejects `ALTER TABLE … ADD COLUMN … NOT NULL` without a constant DEFAULT on a non-empty table. Surface, don't try, don't fail. The fix is either to mark the field `optional` (then backfill via `$executeRaw`) or to add a `default` so the ADD becomes safe.

#### Opt-out: strict 2.5.0 behaviour

```ts
const report = await db.$migrate({ alter: false });
// alteredColumns and pending are always [] when alter is false.
```

`{ alter: false }` skips the drift-apply pass entirely. Use this if you're shipping your own migration runner and want `$migrate` to behave like 2.4 / 2.5.0 — strict create-or-skip, no ALTER touches.

---

## Common scenarios

### (a) Adding a column — the happy path

You added `users.email_verified_at` to the schema. Three steps:

```sh
# Preview the change
DATABASE_URL=$PROD_URL npx forge diff
# ✗ drift detected on postgres (1 issue):
#   − [column] users: column 'email_verified_at'

# Apply
DATABASE_URL=$PROD_URL npx forge push
# applied 1, skipped 47, failures 0

# Verify
DATABASE_URL=$PROD_URL npx forge diff --check
# exit 0
```

If you put `forge push` in the app's start command, the apply step is automatic — `push` is additive-only and idempotent, so it's safe to run on every container start.

### (b) Type widening — `int` → `bigint`

The differ reports the mismatch:

```
≠ [columnType] events: column 'event_id': schema=bigint db=int
```

`diff apply` doesn't emit a type-change ALTER. The fix is per-dialect:

```sql
-- Postgres
ALTER TABLE events ALTER COLUMN event_id TYPE BIGINT;

-- MySQL
ALTER TABLE events MODIFY COLUMN event_id BIGINT NOT NULL;

-- SQLite — no ALTER COLUMN. Full rebuild:
BEGIN;
CREATE TABLE _events_new (event_id BIGINT, …);
INSERT INTO _events_new SELECT * FROM events;
DROP TABLE events;
ALTER TABLE _events_new RENAME TO events;
COMMIT;

-- MSSQL
ALTER TABLE events ALTER COLUMN event_id BIGINT NOT NULL;
```

Wrap the statement in a `db.$executeRaw` migration file (see [MIGRATIONS.md § data migration](./MIGRATIONS.md#data-migration-vs-ddl-migration) for the idempotent ledger-tracked pattern) and run it before re-running `forge diff --check`.

### (c) Type narrowing — `bigint` → `int`

The differ reports the same mismatch as widening. The fix is the same DDL pattern but riskier — values larger than `INT_MAX` will fail the ALTER. The safe order: query for oversized values first, then ALTER, then re-diff to confirm.

```ts
const oversized = await db.$queryRaw<{ event_id: string }>(
  raw`SELECT event_id FROM events WHERE event_id > 2147483647`,
);
if (oversized.length > 0) throw new Error(`${oversized.length} rows exceed INT range`);
await db.$executeRaw(raw`ALTER TABLE events ALTER COLUMN event_id TYPE INTEGER`);
```

Narrowing isn't generated by `diff apply` for the same reason it isn't generated by `forge push` — the safe path requires data inspection, not just DDL emit.

### (d) Renaming a column — the four-step play

The differ has no rename heuristic. A schema change from `email` → `email_address` produces:

```
✗ drift detected on postgres (2 issues):
  − [column] users: column 'email_address'
  + [column] users: column 'email' in DB but not in schema
```

`diff apply` would emit `ADD COLUMN email_address` + `DROP COLUMN email`, which silently loses every row's email. The safe pattern is four deploys — see [MIGRATIONS.md § blue/green schema rollouts](./MIGRATIONS.md#bluegreen-schema-rollouts) for the full walk-through. Compressed:

| Deploy | Schema | DDL emitted | App reads | App writes |
|---|---|---|---|---|
| 1 | both, `email_address` nullable | ADD COLUMN email_address | `email` | `email` |
| 2 (data) | — | `UPDATE users SET email_address = email` via `$executeRaw` | `email` | `email` |
| 3 | both, `email_address` unique | ADD UNIQUE on email_address | `email_address` | `email` + `email_address` |
| 4 | only `email_address` | (via `diff apply`) DROP COLUMN email | `email_address` | `email_address` |

The rule: never let `diff apply` emit both an ADD and a DROP for what's semantically a rename. Stage the change.

### (e) Engine-managed tables show as extra

```
✗ drift detected on postgres (3 issues):
  + [table] hdb_catalog: table 'hdb_catalog' in DB but not in schema
  + [table] hdb_pro_catalog: table 'hdb_pro_catalog' in DB but not in schema
  + [table] auth.users: table 'auth.users' in DB but not in schema
```

These are Hasura + Supabase managed. Fold them into `FORGE_DIFF_IGNORE`:

```sh
export FORGE_DIFF_IGNORE='/^hdb_/i,/^auth\./i'
npx forge diff
# ✓ no drift — live postgres schema matches forge schema
#   (ignored 3 tables: hdb_catalog, hdb_pro_catalog, auth.users)
```

Bake the env var into the CI workflow so every diff job picks it up automatically.

### (f) Drift after an out-of-band fix

Ops added a unique index to handle an incident:

```
✗ drift detected on postgres (1 issue):
  + [index] events: unique index u:idempotency_key in DB but not in schema
```

Two options:

* **Fold it in** — the unique was a real fix; update the schema so it matches reality and the next `forge push` is a no-op:

  ```ts
  const Events = model('events', { … }, {
    uniques: [['idempotency_key']],
  });
  ```

* **Drop it** — the unique was a quick patch and shouldn't be there. Hand-write the `DROP INDEX` since `diff apply` doesn't emit drops for extra uniques (safer to surface than auto-drop):

  ```sh
  psql "$DATABASE_URL" -c 'DROP INDEX events_idempotency_key_unique;'
  ```

Either way, re-run `forge diff --check` to confirm the report's clean.

### (g) Browser app where the device DB drifted

The user shipped on an old app version that created `items` with three columns. The latest release adds two new nullable columns. On boot:

```ts
const report = await db.$migrate();
if (report.alteredColumns.length > 0) {
  console.log(`Schema updated: ${report.alteredColumns.join(', ')}`);
}
if (report.pending.length > 0) {
  // The device's DB has columns the schema doesn't anymore (the old release
  // had them, the new one removed them). Decide policy:
  if (await confirmExport()) await exportDb();
  await dropDb();
  await db.$migrate();
}
```

The drift-apply pass handles the additive case automatically. The destructive case is product-policy — wipe, prompt, or live with the extra columns (they're harmless for reads).

---

## Related

* **[MIGRATIONS.md](./MIGRATIONS.md)** — the full migration lifecycle (`push` / `diff` / `diff apply` / `rollback`), CI workflows, blue/green rollouts, monorepo patterns.
* **[BROWSER.md](./BROWSER.md#dbmigrate--runtime-ddl-apply--drift-detection)** — `db.$migrate()` semantics in the browser, OPFS, multi-tab safety, Safari ITP eviction.
* **[INDEXES.md](./INDEXES.md)** — the full `IndexDef` shape that the deep-field index-drift pass compares against.
* **[DRIVERS.md](./DRIVERS.md)** — the introspect path each adapter takes.
* **README**: [Creating tables and migrations](../README.md#creating-tables-and-migrations) — surface tour of the CLI commands.
* **Source**: `src/scripts/diff-core.ts` (the comparator), `src/scripts/diff.ts` + `src/scripts/diff-apply.ts` (CLI), `src/scripts/migrate-gen.ts` (SQL emit), `src/wasm/drift-apply.ts` + `src/wasm/migrate.ts` (runtime).
