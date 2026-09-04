# forge CLI

Full reference for the `forge` command — every subcommand, every flag, every exit code, plus the runtime API equivalents.

The CLI is a thin dispatcher over seven subcommand entry points (`push`, `diff`, `diff apply`, `generate`, `migrate status`, `rollback`, `doctor`). Each one reads `DATABASE_URL` from `.env` or the environment, resolves the schema through a fixed cascade, and shells out to the dialect-specific introspect/emit code. There are no global flags besides `--help`. Every subcommand owns its own flag set, documented below.

The migration-model background — *why* push is additive-only, *why* there are no migration files by default — lives in **[MIGRATIONS.md](./MIGRATIONS.md)**. This file is the flag-by-flag reference for the binary itself.

---

## Installation

```sh
npm i -D forge-orm
# the `forge` binary is shipped by the package — invoke via npx
npx forge --help
```

The package registers a single bin entry in `node_modules/.bin/forge` pointing at `dist/scripts/forge-cli.js`. Calling `npx forge <subcommand>` resolves to that entry. The dispatcher lives at `src/scripts/forge-cli.ts`; each subcommand is its own file in the same directory (`push.ts`, `diff.ts`, `diff-apply.ts`, `generate.ts`, `status.ts`, `rollback.ts`, `doctor.ts`).

You can also install globally if you prefer a bare `forge` on PATH:

```sh
npm i -g forge-orm
forge doctor
forge push
```

Global installs are not recommended for multi-project setups — version-pinning per project is what `npx forge` gives you and what CI relies on.

### Pointing `forge` at your schema via `package.json`

```jsonc
{
  "name": "my-service",
  "scripts": {
    "db:push":   "forge push",
    "db:diff":   "forge diff --check",
    "db:doctor": "forge doctor"
  },
  "forge": {
    "schema": "./src/db/schema.ts"
  }
}
```

The `forge.schema` field is the second step of the schema-resolution cascade (after the `--schema` flag, before the filesystem scan). Once it's set, every `npx forge <cmd>` from anywhere in the package picks up the right schema with no extra arguments. Full cascade order in [Schema discovery](#schema-discovery).

---

## Subcommand index

| Subcommand | One-line | Writes? |
|---|---|---|
| `forge push` | Idempotently sync the schema to the live DB. Additive-only — never drops columns, tables, or non-Mongo indexes. | Yes |
| `forge diff` | Read-only drift report between schema and live DB. `--check` for CI gate, `--json` for tooling. | No |
| `forge diff apply` | Generate a reconciliation migration file (`up`/`down`) for the current drift, apply it forward, record in `_forge_migrations`. | Yes |
| `forge generate` | Write a migration by diffing the schema against the last committed snapshot. **No database.** | Files only |
| `forge migrate status` | Compare `migrations/` against the `_forge_migrations` ledger. Reports applied, pending, out-of-order, and applied-but-absent. | No |
| `forge rollback` | Run the `down` block of the most-recently-applied migration. | Yes |
| `forge doctor` | Driver inventory + URL shape check + schema lint + live capability probe. Pre-flight before anything else. | No |

The `forge` binary with no arguments prints help text and exits 1. With `--help` / `-h` it prints the same text and exits 0.

**`--help` is honoured anywhere in the arguments, and each subcommand has
its own usage** (2.8.0):

```bash
npx forge push --help     # what push does — and does not do
npx forge diff --help     # flags, and which of them write
```

Before 2.8.0 only the FIRST argument was checked, so `forge push --help`
dispatched to `push`, the flag was dropped, and **the push ran**. Asking
a schema tool what a command does should never be the way you find out.
`push --help` now states plainly that it reconciles indexes only — it
does not create, alter or drop tables, and never touches rows.

```sh
npx forge              # help, exit 1
npx forge --help       # help, exit 0
npx forge unknown      # "[forge] unknown command: unknown" + help, exit 1
```

---

## `forge push`

```sh
npx forge push                              # idempotent sync
npx forge push --enable-extensions          # additionally CREATE EXTENSION when needed
npx forge push --schema=./src/schema.ts     # override the schema cascade
FORGE_SCHEMA_PATH=./src/schema.ts npx forge push
DATABASE_URL=postgres://staging:…@… npx forge push
```

The deep semantics — what statements `push` emits per dialect, what it *won't* do, the advisory-lock model — are in [MIGRATIONS.md → `forge push`](./MIGRATIONS.md#forge-push). This section lists every flag.

### Flags

| Flag | Type | Default | What it does |
|---|---|---|---|
| `--enable-extensions` | boolean | `false` | Before DDL apply, emit `CREATE EXTENSION IF NOT EXISTS postgis` on Postgres / `LOAD spatialite` on SQLite if the schema declares non-fallback `geoPoint` fields, `vector(N)` fields, or `searchable()` columns. Requires the role to have `CREATE EXTENSION` privilege on Postgres. No-op on DuckDB (auto-loads), MSSQL (built-in), Mongo (no DDL). |
| `--schema=<path>` | string | — | Override the schema-resolution cascade. Path is resolved relative to cwd. Accepts `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, `.jsx`. Equivalent to `FORGE_SCHEMA_PATH=<path>`. |

There is no `--url` flag. Target a different database by setting `DATABASE_URL` in the environment:

```sh
DATABASE_URL=$STAGING_URL  npx forge push
DATABASE_URL=$PROD_URL     npx forge push
```

There is no `--dry-run`, no `--verbose`, no `--accept-data-loss`, no `--exclude`, no `--ignore`. The patterns each of those flags would solve are covered by other commands (dry-run → `forge diff`, data-loss → `forge diff apply`, exclude → not-including in the schema, ignore → `forge diff --ignore`). Push deliberately keeps a minimal flag surface so it stays safe to run on every app start.

### Examples

```sh
# First push on a fresh DB
DATABASE_URL=postgres://localhost/myapp_dev npx forge push
# → [forge:push] postgres — schema: /Users/me/app/src/schema.ts
# → [forge:push] applied 47, skipped 0

# Re-run after no schema change — fully idempotent
DATABASE_URL=postgres://localhost/myapp_dev npx forge push
# → [forge:push] applied 0, skipped 47

# Add a geoPoint() field, then push with extension auto-install
DATABASE_URL=postgres://localhost/myapp_dev npx forge push --enable-extensions
# → [forge:push] schema requires spatial — will auto-install extension
# → [forge:push:pg] ✓ PostGIS ready
# → [forge:push] applied 1, skipped 47

# Monorepo: push from outside the package containing the schema
npx forge push --schema=./packages/billing-service/src/schema.ts

# Per-tenant push (DB-per-tenant SaaS)
for url in $(cat tenant-urls.txt); do
  DATABASE_URL="$url" npx forge push
done
```

---

## `forge diff`

```sh
npx forge diff                              # human-readable
npx forge diff --json                       # machine-readable
npx forge diff --check                      # exit 3 on drift (CI gate)
npx forge diff --ignore=logs,/^_atlas_/i    # skip noisy meta-tables
npx forge diff --ignore logs --json
```

Read-only — `diff` only reads from `pg_class` / `information_schema` / `sqlite_master` / Mongo's `listIndexes`. It never writes. Safe to run with a read-only DB role.

### Flags

| Flag | Type | Default | What it does |
|---|---|---|---|
| `--json` | boolean | `false` | Print a `DriftReport` JSON object (`{ dialect, items, inSync, ignored }`) instead of the formatted human report. Use this when piping to `jq` or another tool. |
| `--check` | boolean | `false` | Exit with code 3 if `inSync === false`. Exit 0 if in sync. Without this flag, drift exits 0 (the report is still printed). Use this for CI gates. |
| `--ignore=<list>` | string | — | Comma-separated list of table/collection names or `/regex/flags` patterns to skip. Examples: `--ignore=logs,sessions`, `--ignore=/^_atlas_/i`, `--ignore=logs,/^pgrst_/`. Stacks on top of `FORGE_DIFF_IGNORE`. |
| `--ignore <list>` | string | — | Space-separated form of the same flag. `--ignore logs` is equivalent to `--ignore=logs`. |
| `--schema=<path>` | string | — | Same as on `push` — override the cascade. |

### Output shape (`--json`)

```json
{
  "dialect": "postgres",
  "items": [
    {
      "kind": "column",
      "direction": "missing",
      "table": "users",
      "detail": "column 'email_verified_at'"
    },
    {
      "kind": "index",
      "direction": "extra",
      "table": "users",
      "detail": "unique index u:legacy_email in DB but not in schema"
    }
  ],
  "inSync": false,
  "ignored": ["logs", "_atlas_meta"]
}
```

`items[].kind` is one of `table` / `column` / `columnType` / `index` / `foreignKey` / `view`. `direction` is `missing` (in schema, not in DB), `extra` (in DB, not in schema), or `mismatch` (shape drift on a named index). Full rules in [MIGRATIONS.md → Drift detection rules](./MIGRATIONS.md#drift-detection-rules--what-counts-what-doesnt).

### Exit codes

| Exit | Meaning |
|---|---|
| 0 | `inSync: true`, OR drift found without `--check` flag |
| 1 | Pre-flight failure — `DATABASE_URL` unset, DB unreachable, schema didn't load, adapter doesn't support introspect |
| 3 | Drift detected AND `--check` flag set |

The 3-vs-1 split lets CI distinguish "real drift" from "couldn't even run" — pin the failing-job condition on `exit_code == 3` to avoid false-positives on transient network errors.

### Examples

```sh
# Local dev — what would push do?
DATABASE_URL=$LOCAL npx forge diff
# →  3 drift item(s):
# →    + [column] users: column 'email_verified_at'
# →    + [index]  sessions: idx_sessions_token
# →    - [index]  users: u:legacy_email

# CI — fail PR if drift
DATABASE_URL=$CI_DB npx forge diff --check --json > drift.json
# exit 3 → job fails; drift.json captured as artifact

# Pipe through jq for tooling
npx forge diff --json | jq '.items | map(select(.direction == "missing"))'

# Atlas / Hasura / Supabase — bake the ignore list into CI env
FORGE_DIFF_IGNORE='/^_atlas_/i,/^system\./i' npx forge diff --check
```

---

## `forge diff apply`

```sh
npx forge diff apply                # generate migration file + apply forward
npx forge diff apply --dry          # print SQL, do not write file, do not apply
```

Read-write sibling of `forge diff`. Generates an up/down SQL migration in `./migrations/<timestamp>_drift.sql`, applies the `up` block statement-by-statement, and records the row in `_forge_migrations`.

Unlike `push`, `diff apply` *can* emit destructive DDL (`DROP COLUMN`, `DROP TABLE`). The destructive items are listed in the preview the command prints before applying — Ctrl-C if anything in that list shouldn't run.

### Flags

| Flag | Type | Default | What it does |
|---|---|---|---|
| `--dry` | boolean | `false` | Print the migration content to stdout. Do not write `migrations/<…>.sql`. Do not run any DDL. Use this to review the SQL before committing to the migration file path. |
| `--schema=<path>` | string | — | Override the schema cascade. Same as on `push` / `diff`. |

There's no `--accept-data-loss` flag. The preview is the gate:

```
[forge:diff:apply] 3 change(s):
  • add users.email_verified_at
  • drop sessions.legacy_token
  • drop table audit_old
```

If anything in that list isn't what you want, Ctrl-C and re-run with `--dry` to see the SQL.

### Mongo

`forge diff apply` exits with an error on Mongo:

```
[forge:diff:apply] Mongo uses forge:push for index management, not SQL migrations.
```

For Mongo, edit the schema and re-run `forge push` — index management is idempotent on the server side, and `_forge_migrations` is a SQL-only ledger.

### Examples

```sh
# Preview the SQL first
npx forge diff apply --dry
# →  --- migration (dry run) ---
# →  -- forge migration: 20260624T143052_drift
# →  -- up
# →  ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMPTZ;
# →  -- down
# →  ALTER TABLE "users" DROP COLUMN "email_verified_at";

# Apply — writes ./migrations/20260624T143052_drift.sql and runs it
npx forge diff apply
# →  [forge:diff:apply] 1 change(s):
# →    • add users.email_verified_at
# →  [forge:diff:apply] applied 1 statement(s); recorded migration '20260624T143052_drift'.

# Commit the migration file so the next checkout sees the same intent
git add migrations/20260624T143052_drift.sql
git commit -m "Add users.email_verified_at"
```

---

## `forge generate` (2.9.0)

```sh
npx forge generate --name add-org-slug      # the usual case
npx forge generate --dialect postgres       # when DATABASE_URL is not set at all
npx forge generate --check                  # CI gate — exit 3 if a migration is missing
npx forge generate --custom --name backfill # empty up/down to fill in by hand
npx forge generate --allow-drop             # confirm a column really is being deleted
```

Diffs the schema against the **last committed snapshot** in
`migrations/meta/` and writes a numbered `.sql` plus a new snapshot.
**Nothing connects.** This is the everyday generator; `forge diff apply`
is for adopting a database somebody else created.

| Flag | Effect |
|---|---|
| `--name <slug>` | Names the file. Defaults to a timestamp-derived slug. |
| `--dialect <name>` | `postgres` \| `mysql` \| `sqlite` \| `mssql`. Only needed when `DATABASE_URL` is absent — when it is set, the scheme is read and nothing is dialled. |
| `--check` | Writes nothing. Exit 3 if the schema contains changes no migration covers, naming them. |
| `--custom` | Writes an empty `up`/`down` pair plus a snapshot, for a backfill or any data migration. |
| `--allow-drop` | Confirms that a same-typed drop+add really is a drop, not an unannotated rename. |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | A migration was written, or `--check` found nothing missing. |
| 1 | Usage or schema-resolution error. |
| 2 | The diff contains an **unsafe** change (a narrowing `ALTER`, `NULL` → `NOT NULL`, an unannotated rename). Nothing is written — including the safe changes in the same diff. |
| 3 | `--check` only: a schema change has no migration. |

Exit 2 writes nothing at all, deliberately. A migration that applies
cleanly while leaving the schema and the database disagreeing is the
failure this removes, not a smaller version of it.

`forge generate` refuses on Mongo. There is no DDL to generate.

---

## `forge migrate status` (2.12.0)

```sh
npx forge migrate status                    # the report
npx forge migrate status --check            # CI gate — exit 4 if anything disagrees
```

The only command that compares the migration **folder** against the
migration **ledger**. `generate` and `diff --check` compare intent; this
compares what a database has actually run.

```
  ✓ 0002_add-org-slug.sql       2026-08-19T16:40:55Z
  ! 0003_alice-adds-note.sql    OUT OF ORDER — sorts before
                                0004_bob-adds-tier.sql, which is already applied
  · 0005_add-index.sql          pending
  ? 0006_from-a-branch.sql      NOT IN THIS CHECKOUT   applied 2026-09-02
```

| State | Meaning |
|---|---|
| `✓ applied` | In the ledger and in this checkout. |
| `· pending` | A file here that has not run. |
| `! OUT OF ORDER` | Pending, but sorting **behind** one already applied — a migrator walking forward skips it in silence. |
| `? NOT IN THIS CHECKOUT` | The database applied something this checkout does not have. Somebody ran a branch against it. |

The last two are reported by no other migration tool, drizzle-kit
included. Both are cheap to detect and expensive to discover any other
way — usually as *"why is this column missing in staging"* a fortnight
later. Full explanation and the fix for each in
**[MIGRATIONS.md](./MIGRATIONS.md#forge-migrate-status-2120)**.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Clean, or `--check` not passed. |
| 1 | `DATABASE_URL` missing, or a connection/usage error. |
| 4 | `--check` only: something is out of order, unknown, or unapplied. |

4 is distinct from `generate --check`'s 2 and 3 so a pipeline can tell
which gate refused it.

**This is the one command that genuinely needs `DATABASE_URL`** — a
database is the only thing that knows what it has run. `forge generate`
is the offline one. Point the CI gate at staging, not at a per-PR
throwaway: an empty database has nothing to disagree about.

---

## `forge rollback`

```sh
npx forge rollback         # roll back the most-recent applied migration
```

`rollback` reads `_forge_migrations`, picks the most-recently-applied row, reads `migrations/<name>.sql`, runs its `-- down` block statement-by-statement, and removes the row from the ledger.

### Flags

`forge rollback` takes no flags besides `--schema=<path>`. There is no `--to <slug>`, no `--steps N`, no `--dry`. The CLI applies exactly the most-recent down block. To roll back N migrations, run `forge rollback` N times.

### What's recoverable

| Original `up` operation | `down` does | Lossless? |
|---|---|---|
| `ADD COLUMN` (no data yet) | `DROP COLUMN` | Yes |
| `ADD COLUMN` + backfilled data | `DROP COLUMN` | **No — backfilled data is dropped with the column** |
| `CREATE INDEX` | `DROP INDEX` | Yes |
| `ADD CONSTRAINT` | `DROP CONSTRAINT` | Yes |
| `ADD FK` | `DROP FK` | Yes |
| `DROP COLUMN` | `ADD COLUMN` with the type the introspect saw at apply time | **No — column shape preserved, data is gone** |
| `DROP TABLE` | comment ("cannot auto-restore") | **No — best-effort note only** |

Rollback is reliable for "I just added a thing and want to take it back". It is not a time machine for destructive operations — if you dropped a column on Monday and rolled back on Wednesday, the DROP deleted the data on Monday and the rollback emits the right ALTER but not the data. Restore from a backup, not a rollback.

Full per-dialect fidelity table in [MIGRATIONS.md → Per-dialect rollback fidelity](./MIGRATIONS.md#per-dialect-rollback-fidelity).

### Mongo

`forge rollback` exits with an error on Mongo:

```
[forge:rollback] Mongo uses forge:push, not SQL migrations.
```

Roll back a Mongo index change by editing the schema and re-running `forge push`.

### Examples

```sh
# Roll back the most-recent migration
npx forge rollback
# →  [forge:rollback] rolling back '20260624T143052_drift' (1 statement(s))
# →  [forge:rollback] rolled back '20260624T143052_drift'.

# Roll back the last 3
npx forge rollback && npx forge rollback && npx forge rollback

# Re-run to confirm "nothing more to do"
npx forge rollback
# →  [forge:rollback] no migrations to roll back.
```

---

## `forge doctor`

```sh
npx forge doctor
```

Pre-flight check. Four passes in order:

1. **Driver inventory** — checks which of `pg`, `mysql2`, `better-sqlite3`, `@duckdb/node-api`, `mssql`, `mongodb` are installed in `node_modules`, prints the version of each.
2. **`DATABASE_URL` shape check** — redacts the password, infers the adapter from the URL prefix, confirms the matching driver is installed. If the prefix is unknown, advises passing `type` explicitly to `createDb`.
3. **Schema lint** — if a schema is reachable via the cascade, walks every model's indexes and flags impossible combinations (Mongo-only fields on a SQL adapter, SQL-only fields on Mongo, `method: 'spatial'` on Postgres, `method: 'gin'` on MySQL, `parser` set on a non-FULLTEXT index, unnamed indexes that'll get generated names, GIN indexes that may need `pg_trgm`, etc.).
4. **Live capability probe** — connects (best-effort; failures are reported, not raised) and reads version + extension presence:
   * **Postgres** — `SHOW server_version`; checks for `postgis`, `pg_trgm`, `btree_gin`, `btree_gist`.
   * **MySQL** — `SELECT VERSION()`; warns on < 8.0 (no SRID-aware spatial).
   * **SQLite** — attempts `loadExtension('mod_spatialite')`.
   * **DuckDB** — `INSTALL spatial; LOAD spatial`; reads `duckdb_extensions()`.
   * **MSSQL** — `SELECT @@VERSION`.
   * **Mongo** — `db.admin().command({ buildInfo: 1 })`.

The output ends with copy-pasteable `Action:` lines for any missing driver or extension.

### Flags

`forge doctor` takes no flags. The schema-cascade still applies — if you want to lint a specific schema file, set `--schema=<path>` *would* work, but doctor doesn't require a schema to be present (the lint pass is skipped if no schema is reachable).

### Examples

```sh
# After npm install — confirm the driver is in
npx forge doctor

# Before first push on a new env — confirm extensions are present
DATABASE_URL=$STAGING_URL npx forge doctor

# CI pre-step — fail fast before forge diff if the driver is missing
- name: Forge doctor
  run: npx forge doctor
- name: Drift gate
  run: npx forge diff --check
```

Sample output:

```
Forge — environment check

  Drivers installed:
    ✓ pg               8.11.3
    ✓ mongodb          6.5.0
    ✗ mysql2           not installed
    ✗ better-sqlite3   not installed
    ✗ @duckdb/node-api not installed
    ✗ mssql            not installed

  DATABASE_URL:
    postgres://app:****@db.prod:5432/app  →  postgres adapter  (✓ driver installed)

  Schema lint:
    source: /Users/me/app/src/schema.ts
    ⚠ [Users] index 'idx_email_active' uses method='gin' — make sure pg_trgm is installed.

  Live capability probe:
    ✓ Postgres 16.2 reachable
    ✓ PostGIS
    ⚠ pg_trgm NOT installed
           Install: CREATE EXTENSION pg_trgm;
    ⚠ btree_gin NOT installed
           Install: CREATE EXTENSION btree_gin;
    ✓ btree_gist
```

---

## Exit codes

Every subcommand uses the same exit-code conventions where it makes sense:

| Exit | Where | Meaning |
|---|---|---|
| 0 | all | Success. For `diff` without `--check`, drift still exits 0. |
| 1 | all | Pre-flight failure — unset `DATABASE_URL`, unknown URL prefix, missing schema, schema parse error, adapter doesn't support introspect, file not found on `--schema=<path>`, multi-match in schema scan. |
| 2 | `push` | At least one DDL statement failed during apply. The failure list is printed; the rest of the batch may or may not have run depending on dialect transactionality. |
| 2 | `push --enable-extensions` | `CREATE EXTENSION` failed (typically: role lacks `CREATE EXTENSION` privilege). |
| 2 | `diff apply` | A statement in the `up` block failed; the run aborts (whatever applied stays applied; subsequent statements don't). |
| 3 | `diff --check` | Drift detected. Only emitted when `--check` is set. |

CI scripts should gate on the specific exit code, not "non-zero". A `diff --check` job that fails on 1 (DB unreachable) is a different alert than one that fails on 3 (PR adds drift).

---

## Environment variables

| Variable | Read by | What it does |
|---|---|---|
| `DATABASE_URL` | `push`, `diff`, `diff apply`, `rollback`, `doctor` | Live DB connection URL. Prefix selects the adapter: `postgres:` / `postgresql:` / `mysql:` / `sqlite:` / `file:` / `duckdb:` / `mssql:` / `sqlserver:` / `mongodb:` / `mongodb+srv:`. |
| `FORGE_SCHEMA_PATH` | all | Path to the schema module. Step 2 in the schema-resolution cascade. Same effect as `--schema=<path>`. |
| `FORGE_DIFF_IGNORE` | `diff`, `diff apply` | Comma-separated table/collection ignore list. Same syntax as `--ignore` (exact names or `/regex/flags`). The CLI flag stacks on top — fleet-wide defaults in env, single-run extensions on the command line. |

`forge` itself does not honour a log-level env var — every subcommand prints what it prints. The underlying driver libraries respect their own envs (`PG_DEBUG`, `DEBUG=mysql2`, etc.) if you need quieter or louder output.

`forge` calls `dotenv.config()` at the top of every subcommand, so a `.env` file in the cwd is picked up automatically. No need to source it manually.

---

## Schema discovery

Every subcommand resolves the schema through this cascade. First hit wins; a hit failing to load is a hard error (no falling through to the next step).

```
1. --schema=<path>                      CLI flag
2. FORGE_SCHEMA_PATH=<path>             env var
3. package.json → forge.schema          { "forge": { "schema": "..." } }
4. node_modules/.cache/forge/           previously-discovered path (auto-cached)
     schema-cache.json
5. filesystem scan from cwd             files that import 'forge-orm' AND
                                        export `schema` (or default)
```

### Step 1 — `--schema=<path>`

Highest precedence. Path is resolved relative to cwd. Missing file → exit 1.

```sh
npx forge push --schema=./src/schema.ts
npx forge push --schema=/abs/path/to/schema.ts
npx forge push --schema ./src/schema.ts        # space-separated form also works
```

Accepted extensions: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`. TypeScript files load through `ts-node` with `transpileOnly: true` — type errors here aren't the migrator's concern (~20-50ms per schema file vs ~30-60s of type-checking).

### Step 2 — `FORGE_SCHEMA_PATH`

Same semantics as the flag, but set in the environment. Useful when the same schema path is shared across many `npm run db:*` scripts:

```sh
# .env
FORGE_SCHEMA_PATH=./src/db/schema.ts

# CI
- run: FORGE_SCHEMA_PATH=./packages/api/src/schema.ts npx forge diff --check
```

### Step 3 — `package.json → forge.schema`

Most common in real projects. One-time config; every `npx forge <cmd>` from any directory inside the package picks it up.

```jsonc
{
  "forge": {
    "schema": "./src/db/schema.ts"
  }
}
```

### Step 4 — cache

Once a schema is found via step 5 (scan), `forge` writes the resolved path to `node_modules/.cache/forge/schema-cache.json`:

```json
{
  "path": "/abs/path/to/src/schema.ts",
  "discoveredAt": "2026-06-24T14:30:52.413Z"
}
```

Subsequent runs check the cache before scanning — turns a 100-300ms scan into a single `stat` call. The cache is invalidated automatically if the file no longer exists; you can also delete `node_modules/.cache/forge/` to force a re-scan.

### Step 5 — filesystem scan

If no other hint is available, `forge` walks the cwd looking for files that (a) import from `'forge-orm'` AND (b) export a `schema` const (or default). A cheap byte-search rejects 99% of files up front so the scan stays sub-300ms on a 10k-file repo.

* Skips: `node_modules`, `dist`, `build`, `out`, `coverage`, `.git`, `.next`, `.cache`, `.turbo`, `.svelte-kit`, `.nuxt`, `.parcel-cache`, `.vercel`, `.netlify`, `.serverless`, `.output`, `.idea`, `.vscode`, dotfile dirs.
* Skips test files: `*.test.ts`, `*.spec.ts`, `__tests__/`, `__mocks__/`, `fixtures/`.
* Skips files over 1 MB (schemas are small).

Outcomes:

* **0 matches** — exit 1 with the candidate-checklist message.
* **1 match** — that's the schema. Cached for next time.
* **>1 matches** — exit 1 with the candidate list; the user picks one via flag or `package.json`.

### What "schema" means

The loader accepts any of:

* `export const schema = { Users, Posts } as const;`
* `export default { Users, Posts };`
* `export default { schema: { … } };`

If the module loads but doesn't export any of those, the error is:

```
[forge] <path> loaded but no `schema` (or default) export found.
Expected: export const schema = { Users, Posts, … } as const;
```

---

## CI snippets

Three worked examples — drift gate as PR check, capability gate before deploy, generic shell pipeline.

### GitHub Actions — drift gate + doctor pre-step

```yaml
# .github/workflows/schema.yml
name: Schema drift gate
on:
  pull_request:
    paths: ['src/schema.ts', 'src/db/**', 'package.json']

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

      - name: Forge doctor — fail fast on capability gaps
        run: npx forge doctor

      - name: Shape staging DB from main
        run: |
          git worktree add /tmp/main origin/main
          ( cd /tmp/main && npm ci --omit=dev && npx forge push )

      - name: Drift gate against PR schema
        id: diff
        run: npx forge diff --check --json | tee diff.json
        continue-on-error: true

      - name: Comment diff JSON on PR
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

      - name: Fail job on drift
        if: steps.diff.outcome == 'failure'
        run: exit 1
```

### GitLab CI — drift gate as a service

```yaml
# .gitlab-ci.yml
stages: [check]

drift-gate:
  stage: check
  image: node:20
  services:
    - name: postgres:16
      alias: db
  variables:
    POSTGRES_PASSWORD: postgres
    DATABASE_URL: postgres://postgres:postgres@db:5432/postgres
    FORGE_DIFF_IGNORE: /^_atlas_/i,/^hdb_/i
  script:
    - npm ci
    - npx forge doctor          # capability gate
    - git fetch origin main:main
    - git worktree add /tmp/main main
    - ( cd /tmp/main && npm ci --omit=dev && npx forge push )
    - npx forge diff --check --json | tee drift.json
  artifacts:
    when: on_failure
    paths: [drift.json]
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
```

### Generic shell — drift gate inside any CI

```sh
#!/bin/sh
# scripts/ci-schema-check.sh — runs anywhere with node + a DB
set -e

export DATABASE_URL="${DATABASE_URL:?DATABASE_URL must be set}"
export FORGE_DIFF_IGNORE="/^_atlas_/i,/^hdb_/i"

echo "→ forge doctor"
npx forge doctor

echo "→ shape staging DB from main"
git worktree add /tmp/main origin/main
( cd /tmp/main && npm ci --omit=dev && npx forge push )

echo "→ drift gate"
if ! npx forge diff --check --json > drift.json; then
  rc=$?
  if [ "$rc" -eq 3 ]; then
    echo "✗ Drift detected — see drift.json"
    cat drift.json
    exit 3
  fi
  echo "✗ Drift check failed with unexpected exit code $rc"
  exit "$rc"
fi
echo "✓ schema in sync"
```

The drift-gate pattern is always the same: shape a staging DB to match `main`, then `forge diff --check` against the PR's schema. A non-zero exit (specifically 3) means the PR adds DDL that needs to land before app code goes live.

---

## Programmatic equivalents

Every CLI subcommand has a runtime equivalent. Useful inside the app process — at server boot, in a deploy hook, or in the browser where shelling out to Node isn't possible.

| CLI | Runtime API | Where it works |
|---|---|---|
| `forge push` | `db.$migrate()` | sqlite-wasm (2.4+), indexeddb, and postgres — including PGlite (2.15+); other adapters throw |
| `forge diff` | `db.$diff({ ignore? })` | every adapter that supports introspect (all except runtime-mongo) |
| `forge diff apply` | (no direct API) — use `db.$diff()` + `compile.<op>()` + `$executeRaw` | composable in code |
| `forge rollback` | (no direct API) — read `_forge_migrations` via `$queryRaw`, run down SQL via `$executeRaw` | composable in code |
| `forge doctor` | `db.$doctor()` | sqlite-wasm gets the rich `BrowserDoctorReport`; other adapters get the per-adapter `DoctorReport` |
| `forge migrate status` | (no direct API) — read `_forge_migrations` via `$queryRaw` and compare against `migrations/` | composable in code |
| (no CLI) | `db.$explain(fn, { analyze? })` | every adapter with a compile API — see [EXPLAIN.md](./EXPLAIN.md) |

### `db.$migrate()` — runtime DDL apply (browser / sqlite-wasm)

```ts
import { createDb, wasmSqliteDriver } from 'forge-orm/wasm';
import { schema } from './schema';

const driver = await wasmSqliteDriver({ url: 'opfs:/app.db' });
const db = await createDb({ url: 'sqlite:opfs:/app.db', driver, schema });

const report = await db.$migrate();
// {
//   applied:        ['users', 'forge_users_unique_email'],
//   skipped:        [],
//   failures:       [],
//   alteredColumns: ['users.email'],
//   pending:        [
//     { kind: 'column', direction: 'extra', table: 'users',
//       detail: "column 'legacy_blob' in DB but not in schema" },
//   ],
// }

if (report.pending.length > 0) {
  // Destructive drift — decide app-side: wipe DB, prompt for export, etc.
}
```

Since 2.5.1, `$migrate()` runs a drift-apply pass after the initial create-pass: safely-additive `ALTER TABLE ADD COLUMN` lands automatically (under `alteredColumns`), destructive drift (DROP COLUMN, type changes, extra tables) surfaces under `pending` instead. The flag `{ alter: false }` opts out of the drift pass.

Server-side, `db.$migrate()` throws — server-side migration is the CLI's job:

```ts
const db = await createDb({ url: 'postgres://…', schema });
await db.$migrate();
// → Error: $migrate() is only supported on sqlite, postgres and indexeddb adapters today.
//   For postgres use the CLI: 'npx forge push'.
```

### `db.$diff({ ignore? })` — runtime drift detection

Works on every adapter. Reads live introspection, diffs against the active schema, returns a `DriftReport` — the same shape `forge diff --json` prints.

```ts
import { createDb } from 'forge-orm';
import { schema } from './schema';

const db = await createDb({ url: process.env.DATABASE_URL!, schema });

const report = await db.$diff();
// → { dialect: 'postgres', items: [...], inSync: false, ignored: [] }

if (!report.inSync) {
  console.error('Drift:', report.items);
  process.exit(1);
}
```

The `ignore` option takes the same shape as the CLI's `--ignore`:

```ts
const report = await db.$diff({
  ignore: ['logs', /^_atlas_/i, 'system.profile'],
});
```

The `parseIgnoreList(str)` helper exports the same string→array parsing the CLI uses — feed it a comma-separated string and it returns the `IgnoreSpec`:

```ts
import { parseIgnoreList } from 'forge-orm';

const ignore = parseIgnoreList(process.env.FORGE_DIFF_IGNORE);
const report = await db.$diff({ ignore });
```

### `db.$doctor()` — runtime capability probe

```ts
const report = await db.$doctor();
```

* **sqlite-wasm adapter** — returns the rich `BrowserDoctorReport` from `wasm/browser-doctor.ts` (environment + sqlite version + extension presence + remediation notes).
* **every other adapter** — returns the per-adapter `DoctorReport` (`adapter.doctor()`).

```ts
import type { DoctorReport, BrowserDoctorReport } from 'forge-orm';

const report = await db.$doctor();

if ('environment' in report) {
  // BrowserDoctorReport
  console.log(report.environment, report.capabilities);
} else {
  // DoctorReport — { kind, version, extensions, … }
  console.log(report.kind, report.version);
}
```

Useful in-app to surface "your local DB is missing PostGIS — geospatial queries will fall back to JSON" in a settings UI.

### Composing your own `diff apply`

There is no `db.$diffApply()` — the file I/O + ledger semantics of `forge diff apply` are CLI-shaped, not app-shaped. The pieces you need are exposed individually:

```ts
import { createDb, diffIntrospection } from 'forge-orm';
import { schema } from './schema';

const db = await createDb({ url, schema });
const introspection = await (db as any).adapter.introspect();
const report = diffIntrospection(schema, introspection, []);

// Only auto-apply the safe slice; surface the rest to ops.
const safe = report.items.filter(i => i.direction === 'missing');
if (safe.length) {
  // Generate via compile.<op>() or hand-write the ALTERs.
  // Apply via db.$executeRaw inside a $transaction.
}
```

For Postgres + MySQL + SQLite, the `generateMigration(schema, actual)` helper from `forge-orm/scripts/migrate-gen` returns the same `{ up, down, note }` pairs that the CLI writes to the migration file — `npx forge diff apply` is essentially that function + file write + `_forge_migrations` insert.

---

## Common errors and fixes

| Error | Likely cause | Fix |
|---|---|---|
| `[forge:push] DATABASE_URL is not set.` | No `.env` in cwd, or env var unset in CI | Set `DATABASE_URL` in `.env` or in the CI job env |
| `[forge:push] Could not infer adapter from URL prefix.` | URL prefix isn't one of `postgres:` / `mysql:` / `sqlite:` / `duckdb:` / `mssql:` / `mongodb:` | Fix the prefix, or use `createDb({ type, url })` from code |
| `[forge] no schema found.` | Schema cascade missed all 5 steps | Add `package.json` → `forge.schema`, or pass `--schema=<path>` |
| `[forge] multiple schema candidates found` | Filesystem scan matched >1 file with a `schema` export | Disambiguate via `package.json` → `forge.schema` or `--schema=<path>` |
| `[forge] <path> loaded but no schema export found` | Schema file imports `forge-orm` but doesn't export `schema` or `default` | Add `export const schema = { … } as const;` |
| `[forge] --schema=<x> does not exist` | Path resolved relative to wrong cwd | Use an absolute path, or `cd` to the package root first |
| `Cannot find package 'pg'` (or `mysql2`, etc.) | Adapter driver not installed | `npm i pg` / `npm i mysql2` / etc. Run `npx forge doctor` to see which drivers are missing. |
| `[forge:push:pg] ✗ failed to install PostGIS: must be superuser` | DB role lacks `CREATE EXTENSION` privilege | Have a superuser run `CREATE EXTENSION postgis;` once. Then re-run `forge push` (without `--enable-extensions`). |
| `relation "users" does not exist` during diff | DB hasn't been migrated yet — `forge diff` is comparing an empty DB to a populated schema | Run `forge push` first, or this is expected output (everything is "missing"). |
| `[forge:diff:apply] Mongo uses forge:push for index management, not SQL migrations` | Ran `forge diff apply` against a Mongo URL | Use `forge push` for Mongo. The `_forge_migrations` ledger is SQL-only. |
| `[forge:rollback] migration file for '<slug>' not found in migrations/` | Migration file was deleted but the ledger still has the row | Either restore the file from git, or manually `DELETE FROM _forge_migrations WHERE name = '<slug>'` |
| `SQLITE_ERROR: no such column: …` during rollback on SQLite < 3.35 | `DROP COLUMN` rolled-back as `ADD COLUMN` but the original drop used the unsupported pre-3.35 syntax | Upgrade SQLite to 3.35+ or do a full table rebuild manually |
| `Lock wait timeout exceeded` on MySQL during push | Another `forge push` is running, or a long-running transaction is blocking | Wait for the other process, or check `SHOW PROCESSLIST` for the blocker |
| `Connection terminated due to connection timeout` during diff | DB unreachable from CI runner (firewall, DNS, IP allowlist) | Verify the runner can reach the DB; check VPC peering / IP allowlist |
| Drift shows `+ [index] table: idx_…` after every push | Index was created by the engine, not declared in schema (often a unique-constraint backing index, or a foreign-key auto-index) | Add the index to the schema, or `--ignore=idx_name` if it's truly engine-managed |
| `[forge] $migrate() is only supported on sqlite, postgres and indexeddb adapters today.` | Called `db.$migrate()` on a MySQL / MSSQL / DuckDB / Mongo `Db` | Use the CLI: `npx forge push`. Postgres gained a runtime path in 2.15 for PGlite, where there is no server to point a CLI at. |

---

## Cross-links

* **[MIGRATIONS.md](./MIGRATIONS.md)** — the deep guide on the migration model (declare-and-push semantics, drift rules, blue/green rollouts, data-migration patterns, per-dialect rollback fidelity). Read this for *why* the CLI behaves the way it does.
* **[MIGRATIONS.md → Drift detection rules](./MIGRATIONS.md#drift-detection-rules--what-counts-what-doesnt)** — what counts as drift, what doesn't, why category-based type comparison matters.
* **[MIGRATIONS.md → `forge doctor`](./MIGRATIONS.md#forge-doctor)** — capability probe in context with the rest of the migration story.
* **[MIGRATIONS.md → `forge rollback`](./MIGRATIONS.md#forge-rollback)** — what's recoverable, the `_forge_migrations` ledger shape, why rollback only goes back one.
* **[MIGRATIONS.md → Five worked workflows](./MIGRATIONS.md#five-worked-workflows)** — end-to-end examples (new column in a PR, drift detected in prod, multi-tenant push, column rename, Atlas system collections).
* **[BROWSER.md → `db.$migrate()`](./BROWSER.md#dbmigrate--runtime-ddl-apply--drift-detection)** — the runtime path. Same diff logic, different apply mechanics; covers the chunked rollout, the `pending` report, and Safari ITP eviction.
* **[DRIVERS.md](./DRIVERS.md)** — driver-by-driver install matrix that `forge doctor` references.
* **[INDEXES.md](./INDEXES.md)** — every index shape `forge diff` can detect drift on, and the lint rules `forge doctor` runs.
