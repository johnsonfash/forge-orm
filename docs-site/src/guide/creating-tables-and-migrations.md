---
title: "Creating tables and migrations"
---

## Creating tables and migrations

forge can create your tables from the schema and reconcile changes later. After
installing `forge-orm`, the `forge` binary is on your `PATH` via `npx`:

```sh
npx forge push                              # create or update tables, indexes, constraints
npx forge push --enable-extensions          # also emits CREATE EXTENSION for the extensions your schema needs
npx forge diff                              # report differences between the live database and the schema
npx forge diff --json                       # the same as machine-readable JSON
npx forge diff --check                      # exit non-zero if there is drift (useful in CI)
npx forge diff --ignore=logs,/^_atlas_/i    # skip noisy meta-collections (see below)
npx forge diff apply                        # generate and run a migration that reconciles the difference
npx forge rollback                          # undo the most recent applied migration
npx forge migrate status                    # what has run, what has not, what should not have
npx forge doctor                            # adapter pre-flight + live capability probe (see below)
npx forge --help
```

`DATABASE_URL` is read from your `.env` or environment.

### `forge generate` — a migration without a database

```bash
npx forge generate --name add-org-slug
```

Diffs your schema against the **last committed snapshot** in
`migrations/meta/` and writes a numbered `.sql` plus a new snapshot.
Nothing connects.

```
migrations/
  meta/_journal.json          ordering
  meta/0002_snapshot.json     the schema's shape after 0002
  0002_add-org-slug.sql
```

`forge diff apply` still generates by introspecting the live database —
that is the right tool for **adopting** a database somebody else created.
For everyday work it is the wrong one: CI has no database, so nothing can
check that a schema change shipped with its migration, and two developers
on two branches each generate against their own local state.

A snapshot is just **what `introspect()` would return if the schema were
applied**, so the differ takes it without knowing it came from a file.

```bash
npx forge generate --check      # CI: exit 3 if a migration is missing
npx forge generate --custom     # empty up/down for a backfill
```

It is a projection, not a recording: it describes the schema, never what
a database contains. `forge diff` against the live database remains the
answer to *"is production actually what we think it is?"* See
[MIGRATIONS.md](/reference/migrations).

### Column changes — widened, or refused with the fix

A column whose type or nullability changed used to be **silently absent**
from a generated migration. Now it is one of two things:

```sql
-- widening: emitted, because every row still fits
ALTER TABLE "orgs" ALTER COLUMN "hits" TYPE bigint;
```

```
-- narrowing, a change of category, or NULL → NOT NULL: refused
✖ orgs.name: text → int
  not a widening — existing rows may not fit, or may not convert at all.
  → write it with `forge generate --custom`: add the new column,
    backfill, verify, drop the old one and rename.
```

Exit 2, nothing written — including the safe changes in the same diff. A
migration that applies cleanly while leaving the schema and the database
disagreeing is the failure this removes, not a smaller version of it.

`NULL` → `NOT NULL` is always refused, and says why the obvious fix does
not work: a `DEFAULT` applies to new rows, not to the NULLs already
there. SQLite is refused for any of it — it has no `ALTER COLUMN`, and
forge will not generate the twelve-step rebuild blind.

### `renamedFrom` — a rename is not a drop and an add

Comparing two schema states shows only that one name is gone and another
appeared. A rename and a drop-plus-add look identical from there, and
they do opposite things to the data.

```ts
name: f.string().renamedFrom('full_name'),
```

```sql
ALTER TABLE "orgs" RENAME COLUMN "full_name" TO "name";
```

Without the annotation, a same-typed drop+add is **refused** with the
line to add printed, and `--allow-drop` is how you confirm a column
really is going.

drizzle-kit asks this with an interactive prompt. Same question, wrong
medium — a prompt answered once at 2am is recorded nowhere, cannot run in
CI, and is invisible in review. An annotation is in the schema, the diff
and the pull request.

Renaming **and** changing a type emits both statements, in order. That
one is a known drizzle-kit bug where the type change is silently lost.
See [MIGRATIONS.md](/reference/migrations).

### `forge migrate status` — what the database has really applied

```bash
npx forge migrate status
npx forge migrate status --check    # CI: exit 4 if anything needs attention
```

Every other command compares **intent** — the schema against a snapshot,
or against what a database reports. This one compares **reality**: the
files in `migrations/` against the rows in `_forge_migrations`.

```
  ✓ 0002_add-org-slug.sql       2026-08-19T16:40:55Z
  ! 0003_alice-adds-note.sql    OUT OF ORDER — sorts before
                                0004_bob-adds-tier.sql, which is already applied
  · 0005_add-index.sql          pending
  ? 0006_from-a-branch.sql      NOT IN THIS CHECKOUT   applied 2026-09-02
```

Applied and pending every tool shows. The other two are where production
goes wrong and no tool reports either:

- **NOT IN THIS CHECKOUT** — somebody ran a branch against this database.
  The schema in front of you is not the schema it has, so every migration
  you generate from here is built on a state you cannot see.
- **OUT OF ORDER** — Alice generates `0007`, Bob generates `0008`, Bob's
  ships first. When Alice's merges, a migrator walking forward from the
  highest applied entry **skips it in silence** and it is never applied at
  all. drizzle-kit has this exact failure with journal timestamps.

This is the one command that genuinely needs `DATABASE_URL` — a database
is the only thing that knows what it has run. Point the CI gate at
staging, not at a throwaway database: an empty one has nothing to
disagree about. See [MIGRATIONS.md](/reference/migrations).

### Asking a command what it does

Every subcommand takes `--help`, anywhere in the arguments:

```bash
npx forge push --help    # says plainly: indexes only, never tables or rows
npx forge diff --help    # flags, and which of them write
```

Before 2.8.0 only the first argument was checked, so `forge push --help`
**ran the push**. Asking a schema tool what a command does should not be
the way you find out.

### Pointing the CLI at your schema

forge resolves the consumer's schema through a layered cascade — explicit
pointers first, with a one-time filesystem scan as the zero-config fallback.
First hit wins:

1. **`--schema=<path>`** CLI flag (zero ms)
2. **`FORGE_SCHEMA_PATH=<path>`** env var (zero ms)
3. **`package.json` config**:
   ```json
   { "forge": { "schema": "./src/your-schema.ts" } }
   ```
4. **Cached scan result** at `node_modules/.cache/forge/schema-cache.json` —
   instant on every run after the first.
5. **Filesystem scan** — walks your project tree, finds the file that imports
   from `forge-orm` and exports a `schema` const. Skips `node_modules`,
   `dist`, `build`, `.git`, `.next`, `coverage`, `.cache`, `.turbo`,
   `.svelte-kit`, `.nuxt`, `.parcel-cache`, `.vercel`, `.netlify`, `out`,
   `.output`, `.idea`, `.vscode`, `*.test.*` files, `__tests__/`, `__mocks__/`,
   and `fixtures/`. Sub-300 ms on a real 10k-file project — a cache write at
   the end makes subsequent runs free.
6. **Hard fail** if nothing matches, with an actionable error message listing
   every layer that was tried.

The schema module must export a `schema` constant (or a default export shaped
the same way):

```ts
// src/schema.ts — name and location are up to you
import { f, model } from 'forge-orm';

export const User = model('users', { … });
export const Post = model('posts', { … });

export const schema = { User, Post } as const;
```

If the scan finds more than one candidate (e.g. a real schema + a fixture
schema in `examples/`), forge prints both paths and asks you to disambiguate
via `package.json` or `--schema=`.

TypeScript schemas are loaded with `ts-node` registered in **transpile-only**
mode under the hood, so push runs in milliseconds even on schemas with dozens
of models (no full type-check at push time — the consumer's own build catches
type errors separately).

`forge:diff:apply` writes a timestamped SQL file with an `up` and a `down`
section into a `migrations/` folder and records it in a `_forge_migrations`
table, so applying is repeatable and reversible. Migrations are SQL only; on
Mongo, `forge:push` manages indexes and views.

### Ignoring drift on `forge diff`

The migration ledger (`_forge_migrations`) and engine-generated FTS shadows
(`*_fts`) are always skipped. Anything else you want hidden from the report —
Atlas metadata, system collections, tables managed by a sibling service — goes
through `--ignore=` or the `FORGE_DIFF_IGNORE` env var:

```sh
# exact names + a regex pattern, comma-separated
npx forge diff --ignore=sessions,logs,/^_atlas_/i

# env var works the same way; CLI flag stacks on top
export FORGE_DIFF_IGNORE='/^_/i,external_events'
npx forge diff
```

Patterns wrapped in `/.../flags` are treated as regex; everything else is an
exact-match string. Ignored tables are summarised at the end of the report
(`ignored 2 tables: logs, sessions`) so silent filtering can't hide real drift.

### `scopeBy` — declare your tenant key, get an index lint

Multi-tenant apps filter every read by a tenant key, usually through a
proxy that injects it. Forge cannot add that filter — it does not know
where the value comes from — but it can check that something **indexes**
it:

```ts
export const Appointment = model('appointments', {
  id: f.id(),
  orgId: f.objectId(),
  createdAt: f.dateTime().default('now'),
}, {
  scopeBy: 'orgId',
  indexes: [{ keys: { orgId: 1, createdAt: -1 }, name: 'idx_appt_org' }],
});
```

`forge doctor` warns when nothing does. The check earns its keep because
the failure is invisible in development: a scoped table holds one row per
tenant, so it looks tiny early and grows with the customer list rather
than with usage — every tenant gets slower at once, and nothing in the
app changed.

Measured on a real 24-tenant schema: 66 collections holding 27,367 rows
had no index on their tenant key. One hot query went from **6,486
documents examined to 40**.

An index whose first key is a more selective foreign key satisfies the
rule too — a `threadId` already implies its tenant. See
[MULTI-TENANT.md](/reference/multi-tenant).

### `id` in an index key means `_id` on Mongo

The schema calls the primary key `id`; Mongo stores it as `_id`. Reads
and writes have always translated. **Index keys did too, from 2.8.0** —
before that they were passed through verbatim, so this:

```ts
indexes: [{ keys: { threadId: 1, createdAt: -1, id: -1 } }]
```

created a real index on a field literally called `id`, which no document
has. Nothing reported it: push said `created`, doctor said nothing, and
it showed in `getIndexes()`. Only `explain()` revealed the sort was still
done in memory. If you have such an index, the first push on 2.8.0
rebuilds it. See [INDEXES.md](/reference/indexes).

### `forge doctor` — live capability probe

`forge doctor` connects to your live database (best-effort), reads version +
extension list, and prints actionable install commands for whatever's
missing. Per-dialect probes:

| Dialect  | Probes                                                                       |
| -------- | ---------------------------------------------------------------------------- |
| Postgres | server version, PostGIS, pgvector, pg_trgm, pg_stat_statements              |
| MySQL    | server version (5.7 vs 8 vs 9), spatial functions, JSON support              |
| SQLite   | library version, FTS5 availability, SpatiaLite load attempt                  |
| DuckDB   | extension list, `spatial` + `vss` availability                              |
| MSSQL    | server version, `GEOGRAPHY` smoke check, `VECTOR(N)` smoke check            |
| Mongo    | `buildInfo` + topology (replica set / sharded / standalone)                 |

The probe never throws — if it can't connect or a probe fails, it reports
"unknown" and moves on. Output ends with a copy-pasteable `Action items`
section for any gaps.

### Extensions and `forge push --enable-extensions`

`--enable-extensions` makes `forge push` emit the right `CREATE EXTENSION`
statements before the table DDL, based on what your schema declares:

| Schema feature              | Extension emitted                                          |
| --------------------------- | ---------------------------------------------------------- |
| any `f.geoPoint()`          | PG: `CREATE EXTENSION IF NOT EXISTS postgis;`              |
| any `f.vector(N)`           | PG: `CREATE EXTENSION IF NOT EXISTS vector;` (pgvector)    |
| any `.searchable()` on PG   | PG: `CREATE EXTENSION IF NOT EXISTS pg_trgm;` (where used) |
| any `f.geoPoint()` on DuckDB | bundled `spatial` auto-loaded at connect                  |
| any `f.vector()` on DuckDB  | requires `INSTALL vss; LOAD vss;` (run at connect)         |
| SpatiaLite (SQLite)         | `SELECT load_extension('mod_spatialite')` at connect       |

`--enable-extensions` is opt-in so a managed host that doesn't allow
extension installs from app code doesn't fail at first push. Without the
flag, the push works as long as the extensions are already installed.

See more — **[docs/MIGRATIONS.md](/reference/migrations)** for the push-style model, drift rules, per-dialect emit table, three CI snippets, blue/green pattern, monorepo workflow. **[docs/CLI.md](/reference/cli)** for every `forge` subcommand and flag. **[docs/VS-DRIZZLE.md](/reference/vs-drizzle)** for the drizzle-kit comparison and what is still open. **[docs/PUSH.md](/reference/push)** (push semantics + `--enable-extensions` + `--fallback`), **[docs/DIFF.md](/reference/diff)** (drift taxonomy + the 2.5.1 auto-apply pass), **[docs/DOCTOR.md](/reference/doctor)** (live capability probe), **[docs/ROLLBACK.md](/reference/rollback)** (snapshot vs forward-only vs blue/green), **[docs/SEED.md](/reference/seed)** (idempotent upserts + bootstrap/dev/demo split), **[docs/DEPLOYMENT.md](/reference/deployment)** (env-per-stage + zero-downtime + RDS Proxy), **[docs/VERSIONING.md](/reference/versioning)** (expand/contract for breaking changes), **[docs/BACKUP-RESTORE.md](/reference/backup-restore)** (per-dialect backup + PITR + restore drills).

---
