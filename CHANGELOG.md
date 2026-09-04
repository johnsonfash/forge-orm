# Changelog

All notable changes to **forge** (`forge-orm`). Forge is a Prisma-shape
multi-database wrapper for MongoDB, PostgreSQL, MySQL, SQLite, DuckDB and
SQL Server — one code path, no codegen, no external query engine.

## 2.17.0 — per-dialect entry points

**Minor.** A third way to connect, for the case the other two handle
badly.

```ts
import { createDb, f, model } from 'forge-orm/postgres';

const db = await createDb({ url: process.env.DATABASE_URL!, schema });
```

Also `forge-orm/mysql`, `/sqlite`, `/pglite`, `/mongo`, `/duckdb` and
`/mssql` — one per **package**, not per dialect.

### Why

`createDb({ url })` resolves the driver by calling `require(pkg)` with a
package name computed at runtime. That reads well and lets one env var
swap the database — and a bundler cannot see through it. webpack, rollup,
esbuild and Vite all lose the dependency, so on a bundled target
(Cloudflare Workers, Vercel Edge, a bundled Lambda) the driver is dropped
or fails at runtime, a long way from the cause. Nothing can be
tree-shaken either, because nothing proves which of the six adapters you
use.

The `driver` option already solved this — you import the client yourself,
so the import is static — but it means constructing the pool by hand at
every call site that only wanted a URL.

These entries import one driver statically and build it for you. The
bundler sees it, the other five adapters fall away, and the call site
stays as short as the URL form. What you give up is the env-var swap:
that call site is a Postgres call site now, which is the right way round
for a deploy target whose bundle is fixed anyway.

### Notes

- Each entry re-exports everything the main one does — `f`, `model`,
  `rel`, the types, the driver factories — so one import line is enough.
- They take a `url`. If the client itself needs configuring (pool size,
  SSL, PGlite extensions, Neon or PlanetScale over HTTP), that is still
  the `driver` option, and still the only correct answer.
- One entry per package, because a static import pins a package. PGlite is
  the clearest case: it *is* Postgres, and forge runs it on the postgres
  adapter — same compiler, same executors — but `pg` and
  `@electric-sql/pglite` are different packages, and a single
  `forge-orm/postgres` importing both would put a WASM Postgres in every
  bundle that wanted only `pg`. SQLite says it louder still: seven
  packages behind one dialect.
- No entry for the alternative drivers (postgres.js, MariaDB, PlanetScale,
  libSQL, Expo, OP-SQLite, Tauri, sqlite-wasm). Choosing one of those means
  importing it yourself, so the import is already static and the bundler —
  Metro included — already sees it. An entry point would save a line and
  add a module to keep in step with someone else's releases.
- `forge-orm/sqlite` pulls in a native Node addon, so it belongs on a
  server. React Native and the browser have their own paths, and the
  README now carries a table mapping every target to its import and
  driver.

### Also

The library finally has CI of its own. Until now only the examples and
the docs site were gated, so 677 tests and the typecheck ran on a laptop
and nowhere else — and the README carried a build badge pointing at a
workflow that lives in a different repository. `ci.yml` runs the
typecheck, the suite, the build, and a check that every path in the
`exports` map resolves to a file that exists.

## 2.16.0 — three bugs the examples found

**Minor.** Every one of these came from running an example rather than
reading it, and every one has the same shape: a path that handled
`geoPoint` and `vector` in one place and forgot them in another, so the
feature worked right up until you used it the second way.

### `orderBy: { loc: { nearTo } }` ignored `fallback: true`

`f.geoPoint({ fallback: true })` stores JSON and post-filters in the app
— that is the documented point of it, and `where.near` honoured it,
emitting a bounding-box prefilter. `orderBy` did not: it asked Postgres
for `ST_GeogFromText` against a `jsonb` column and got

```
function st_geogfromtext(unknown) does not exist
```

The executor was already computing `_distanceMeters` by haversine and
sorting on it, so the correct SQL for a fallback column is none at all.
It now emits neither the distance column nor an `ORDER BY` over an alias
that was never selected — which was the same bug's other half.

Fixed in the shared SQL compiler, so sqlite, mysql and duckdb fallback
columns are fixed with it.

### `upsert` sent raw values for `vector` and `geoPoint`

`create()` wrapped them through the dialect's value emitter. So did the
`SET` clause. Upsert's `VALUES` list used a bare placeholder, so an
upsert carrying a vector sent the JS array and Postgres answered
`Vector contents must start with "["`. A native `geoPoint` had it too —
it reached the driver as an object instead of `ST_GeogFromText(…)`.

### `pglite:` could not register extensions

The URL form builds the PGlite instance internally, so there was no way
to pass one — and a schema with `f.vector()` failed at CREATE TABLE with
`type "vector" does not exist`. forge now loads pgvector from the PGlite
package when that build ships it (`@electric-sql/pglite/vector` on
0.2.x), registers it, and issues `CREATE EXTENSION IF NOT EXISTS vector`.
Absent from the build, nothing is registered and the failure surfaces
where it means something.

PGlite is embedded and single-user, so none of the reasons
`--enable-extensions` is opt-in on a real server — superuser rights, a
shared database — apply here.

677 tests passing.

## 2.15.0 — `$migrate()` works on postgres

**Minor.** The other half of making `pglite:` actually usable.

2.14.0 gave PGlite a URL, and the examples got one step further before
stopping at:

```
[forge] $migrate() is only supported on sqlite + indexeddb adapters
today. For postgres use the CLI: 'npx forge push'.
```

Which is no help when the database is PGlite. There is no server to
point `forge push` at — it is a WASM module in the same process — and
the places PGlite is used (StackBlitz, a browser tab, a serverless
function) have no shell to run a CLI from either. sqlite-wasm has had a
runtime path since 2.4 for exactly this reason; postgres needed the
same one.

```ts
const db = await createDb({ url: 'pglite:./data', schema })
await db.$migrate()      // creates tables, constraints and indexes
```

No new migration logic: this is the same `planMigration` / `applyMigration`
the CLI already uses, driven in-process instead of from a pool. So it
keeps the properties that matter — it asks the database what exists
before deciding what to run, which is what makes it safe to call at
every boot (`ADD CONSTRAINT` has no `IF NOT EXISTS`), and it reports
`applied` / `skipped` / `failures` in the shape the sqlite path already
returned.

A driver with no `connect()` — PGlite, Neon over HTTP, anything
single-session — is adapted to the pool interface the migrator expects.
It *is* the session, so the client is itself.

`$migrate()` still refuses on mysql, mssql, duckdb and mongo, and now
names the three adapters that do work.

667 tests passing.

## 2.14.0 — an empty upsert, and a `pglite:` URL

**Minor.** Two bugs, both found by running the examples repo rather than
by reading it.

### `update: {}` emitted invalid SQL

```ts
db.user.upsert({ where, create, update: {} })
```

is the ordinary "insert if it isn't there, otherwise leave it alone"
idiom — the first thing anyone writes for an idempotent seed, and the
entire body of `examples/04-node-cli`. It compiled to:

```sql
INSERT INTO "users" (…) VALUES (…) ON CONFLICT ("email") DO UPDATE SET  RETURNING *
```

`SET` with nothing after it. Because a parser blames the token *after*
an empty clause, every dialect reported `near "RETURNING": syntax
error` — pointing at the one part of the statement that was fine.

`update({ data: {} })` and `updateMany({ data: {} })` had it too.

An empty set now emits a column assigned to its own stored value:
valid SQL, provably no change, and `RETURNING` still yields the row —
which upsert's contract requires, since it must hand back the record
whether it inserted or not. `DO NOTHING` would have parsed and is the
shorter fix, but it returns **no** row on conflict, so upsert would
have resolved to `undefined` exactly when the record already existed: a
silent wrong answer in place of a loud syntax error.

**MySQL needed its own form, and this is the part that mattered.** MySQL
rewrites each upsert assignment to `col = VALUES(col)` so the update
reuses the INSERT's values — right for a real update, catastrophic for
the no-op, because ``VALUES(`id`)`` is the id the INSERT *proposed*. On
conflict that would have silently replaced the existing row's primary
key with a freshly generated uuid, taking every foreign key that
referenced it along with it. MySQL now emits its own self-assignment
no-op instead, and real assignments still rewrite to `VALUES(col)`.

Fixed on postgres, sqlite, mysql, duckdb and mssql.

### `pglite:` is a real URL now

```ts
const db = await createDb({ url: 'pglite:./data', schema })   // on disk
const db = await createDb({ url: 'pglite:', schema })          // ephemeral
```

PGlite is Postgres compiled to WASM. `DRIVERS.md` had always documented
how to hand-wrap it and pass `createDb({ driver })`, but there was no
URL prefix — so the form above failed with *"Could not infer adapter
from URL"*. That included eight examples, two of which the README links
as one-click StackBlitz demos.

It resolves to the postgres adapter (same compiler, executors and
dialect — only the driver differs), and `@electric-sql/pglite` is
imported lazily, so it is never a hard dependency. Missing package, and
you get the install line rather than a module-resolution stack.

- New exports: `pgliteDriver` (wrap an instance you built yourself, for
  extensions or a custom filesystem) and `pgliteDataDir`.
- `pglite://./x` and `pglite:` both work; a bare scheme means ephemeral.
- `postgres://` is untouched — the new prefix does not shadow it.

659 tests passing.

## 2.13.0 — see the query without running it

**Minor.** Stage 6, and the last item on the drizzle plan.

The standing complaint about a Prisma-shaped ORM is that you cannot see
what it sends. `.compile.<op>()` answered that for one op, but you had to
know the op's name and rebuild the call by hand — which is the moment
most people stop bothering. `$explain` takes the call site instead:

```ts
const r = await db.$explain((q) => q.User.findMany({ where: { age: { gt: 40 } } }));
console.log(r.toString());
```

```
User.findMany  →  users  [sqlite]

  SELECT "users"."id", "users"."name", "users"."age" FROM "users" WHERE "users"."age" > ?

  params: 40

  -- with values inlined (for reading, not for running):
  SELECT "users"."id", "users"."name", "users"."age" FROM "users" WHERE "users"."age" > 40
```

### `{ analyze: true }` — the database's own plan

```
  -- plan:
  SCAN users          ← every row read; that column has no index
```

`forge doctor` catches an index that was declared and never created. This
catches the one that was never declared, which nothing else can see
because it is a property of the query rather than of the schema.

### forge never emits `EXPLAIN ANALYZE`

`EXPLAIN` plans a statement. `EXPLAIN ANALYZE` **runs** it — which on
`deleteMany` deletes the rows. An API whose entire promise is "this does
not run" must not delete data because you asked for more detail, so
ANALYZE is not offered at all and the docs say why rather than leaving
the distinction to be found in a postmortem. Explaining a `deleteMany`
against 500 rows leaves 500 rows.

### Two callback forms, and an honest failure

`db.$explain((q) => q.User.findMany(…))` — `q` holds no session and
reaches no driver, so nothing can execute and an `async` callback is
safe. This is the one to reach for.

`db.$explain(() => db.User.findMany(…))` also works, by intercepting for
the duration of the synchronous call. That window shuts at the first
`await`, so a query issued after one runs for real. forge detects the
case — an empty capture from a callback that returned a promise — and
throws saying the query ran, rather than handing back an empty report it
cannot honour.

### Notes

- Placeholder splitting is a tokenizer, not a regex. `?` and `$1` both
  occur inside string literals, quoted identifiers and comments, and
  Postgres `$tag$…$tag$` dollar-quoting means `$1` can be either a
  parameter or text. A regex gets these wrong silently, producing SQL
  that still parses.
- `readable` (values inlined) is for reading and for handing to a DBA.
  Never execute it — that quoting serves legibility, not safety.
- Refusals name the case: `groupBy` / `aggregate` / `findManyStream` have
  no single compiled statement; `analyze` on a Mongo write would ask the
  server to plan a change to your data; `analyze` on SQL Server needs a
  connection-state change forge will not make behind your back on a
  pooled connection. `findFirstOrThrow` and `findUniqueOrThrow` are not
  refused — they differ only after the statement.
- New exports: `formatExplain`, `inlineParams`, `splitSql`,
  `fragmentFromSql`, and the `ExplainReport` / `ExplainedQuery` types.
- Docs: **[docs/EXPLAIN.md](docs/EXPLAIN.md)**, a README chapter, and the
  contents entry.

621 tests passing.

## 2.12.0 — `forge migrate status`

**Minor.** Stage 5. Every other command compares **intent** — the schema
against a snapshot, or against what a database reports. This one compares
**reality**: the `.sql` files in `migrations/` against the rows in
`_forge_migrations`.

```bash
npx forge migrate status
npx forge migrate status --check    # CI: exit 4 if anything needs attention
```

```
  ✓ 0002_add-org-slug.sql       2026-08-19T16:40:55Z
  ! 0003_alice-adds-note.sql    OUT OF ORDER — sorts before
                                0004_bob-adds-tier.sql, which is already applied
  · 0005_add-index.sql          pending
  ? 0006_from-a-branch.sql      NOT IN THIS CHECKOUT   applied 2026-09-02
```

### The two states nobody reports

Applied and pending every migration tool shows. The other two are where
production goes wrong, and no tool — drizzle-kit included — reports
either.

**NOT IN THIS CHECKOUT.** The database has applied a migration that is
not in your folder: somebody ran a branch against it. This matters more
than it looks — the schema in front of you is not the schema that
database has, so every migration you generate from here is built on a
state you cannot see. The next `forge generate` produces a file that is
correct against your snapshot and wrong against that database.

**OUT OF ORDER.** Alice generates `0007` on Monday, Bob generates `0008`
on Tuesday, Bob's ships first. When Alice's merges, a migrator walking
forward from the highest applied entry skips `0007` in silence — it is
never applied at all, and nothing says so. drizzle-kit has this exact
failure with journal timestamps. forge would too; the difference is that
forge tells you, and says to regenerate on top of the current state
rather than leaving you to find out in staging.

### Exit codes

`--check` exits 4, distinct from `generate --check`'s 2 and 3, so a
pipeline can tell which gate refused it.

| exit | command | meaning |
|---|---|---|
| 2 | `generate --check` | the schema has unsafe changes |
| 3 | `generate --check` | a schema change has no migration |
| 4 | `migrate status --check` | the database and the folder disagree |

### Notes

- This is the one command that genuinely needs `DATABASE_URL`. A database
  is the only thing that knows what it has actually run.
- `buildStatus()` takes the ledger as an argument rather than reading it,
  so the state machine is tested without a database — the four states and
  both dangerous ones are covered by unit tests, not by an integration
  suite somebody skips locally.
- Point the CI gate at staging. An empty per-PR database has nothing to
  disagree about, and the check only earns its place against one with
  history.
- New: `listAppliedWithDates()` in `migrate-runtime.ts`, so the report can
  show when each migration ran.
- An applied migration missing from this checkout does **not** mark the
  others out of order. It would otherwise set the high-water mark and
  flag every ordinary pending file, under guidance that does not address
  the real cause. `OUT OF ORDER` means *behind a migration this checkout
  also has*; the ordering risk from an unknown one is reported under the
  unknown one. Found by running the command against a real database, not
  by unit test — and now covered by both.

## 2.11.0 — a rename is not a drop and an add

**Minor.** Stage 3, and the last silent-data-loss case in the generator.

Comparing two schema states shows only that one column name is gone and
another has appeared. A RENAME and a DROP-plus-ADD look identical from
there, and they do opposite things to the data: one keeps every row, the
other deletes a column's worth of it.

Guessing "drop and add" loses data on a column somebody meant to keep.
Guessing "rename" is worse — it keeps a column somebody meant to delete
and quietly moves its data under a new name. So forge takes the answer
from the schema:

```ts
name: f.string().renamedFrom('full_name'),
```

```sql
-- up
ALTER TABLE "orgs" RENAME COLUMN "full_name" TO "name";
-- down
ALTER TABLE "orgs" RENAME COLUMN "name" TO "full_name";
```

### Without it, forge asks

A same-typed drop and add on one table is refused, naming both columns
and printing the line to add. `--allow-drop` confirms a column really is
going.

Only SAME-TYPED pairs are suspected — a dropped `text` beside a new
`integer` is not a candidate, because a check that fires on every genuine
drop is one people learn to skip past, and then it protects nothing.

### Why an annotation and not a prompt

drizzle-kit asks the same question interactively. Right question, wrong
medium: a prompt answered once at 2am is recorded nowhere, cannot run in
CI — exactly where a pipeline would apply the migration — is invisible in
review, and has to be answered again by the next person who regenerates.
An annotation is in the schema, the diff and the pull request.

### Rename AND type change

Both statements are emitted, in order, with a correctly reversed `down`.
That combination is a known drizzle-kit bug
([#5499](https://github.com/drizzle-team/drizzle-orm/issues/5499),
[#3826](https://github.com/drizzle-team/drizzle-orm/issues/3826)) where
only the rename is emitted and the type change is silently lost.

Renames run before every other column pass, which is not cosmetic: a
rename after the ADD finds the new column already there, and one after
the DROP has nothing left to rename.

567 tests (was 553).

## 2.10.0 — a column change is emitted, or refused with the fix

**Minor.** Stage 2 of the migration plan. A column whose **type** or
**nullability** changed used to be silently absent from a generated
migration: the schema said `varchar(255)`, the database kept
`varchar(64)`, the file applied cleanly, and nothing said a word.

Silently omitting a change is the worst of the three options. It is now
one of the other two.

### Widening is emitted

`varchar(64)` → `varchar(255)`, `varchar` → `text`, `int` → `bigint`,
`numeric(10,2)` → `numeric(12,2)`, and dropping `NOT NULL`. Every
existing row still fits, so the statement cannot fail on data.

The `down` carries a warning, because the reverse of a widening is a
narrowing and it can fail on rows written since:

```sql
-- narrowing hits back to int can fail on rows added since;
-- review before rolling back.
ALTER TABLE `orgs` MODIFY COLUMN `hits` int;
```

A file that says "rollback" without saying that is lying to whoever runs
it at 3am.

### Everything else is refused, with the migration to write instead

```
✖ orgs.name: text → int
  orgs.name changes from text to int, which is not a widening — existing
  rows may not fit, or may not convert at all.
  → forge will not guess at this. Write it with `forge generate
    --custom`: add the new column, backfill it with whatever conversion
    is correct for YOUR data, verify, then drop the old one and rename.
```

Exit **2**, and nothing is written — including the safe changes in the
same diff. A migration that applies cleanly while leaving the schema and
the database disagreeing is the failure this removes, not a smaller
version of it.

**The refusal is the feature.** A tool that emits `ALTER COLUMN … TYPE
int` against a column holding text is more dangerous than one that emits
nothing, because the migration *looks reviewed*.

### `NULL` → `NOT NULL` is always refused

…and the message says why the obvious fix does not work: **a `DEFAULT`
applies to new rows, not to the NULLs already there.** The guidance is
the two-step migration — backfill with `--custom`, confirm the count is
zero, then make the column required and generate again, at which point
the refusal turns into the `ALTER`.

### SQLite

Refused for any type or nullability change. SQLite has no `ALTER COLUMN`;
the answer is its documented twelve-step rebuild, and forge will not
generate that blind. Copying the column is the easy part — the indexes,
triggers and views pointing at the old table are what a generator cannot
see, and getting that wrong drops them silently.

### Not compared

A type forge cannot categorise (`tsvector`, a domain or extension type)
is left alone rather than rewritten. Mongo is skipped entirely —
introspection reports no column types, so there is nothing to compare.

`fieldCategory` and `dbTypeCategory` are shared with the drift report
rather than copied, so the migration generator and `forge diff` can never
disagree about what two types are.

553 tests (was 538).

## 2.9.0 — a migration you can generate without a database

**Minor.** `forge generate` writes a migration by diffing the schema
against the **last committed snapshot** instead of against a live
database.

```bash
npx forge generate --name add-org-slug
```

```
migrations/
  meta/_journal.json          ordering
  meta/0002_snapshot.json     the schema's shape after 0002
  0002_add-org-slug.sql
```

### Why

`forge diff apply` generates by introspecting `DATABASE_URL`. That is
right for **adopting** a database somebody else created and wrong for
everything else:

- CI has no database, so nothing could verify that a schema change
  shipped with its migration
- two developers on two branches each generated against their own local
  state, so each file was correct only relative to a world that stops
  existing at the merge
- the same schema did not reliably produce the same SQL, so a reviewer
  could not regenerate a migration to check it against the schema change
  in the same pull request

A snapshot is simply **what `introspect()` would return if this schema
were applied**. `diffIntrospection` already takes a `DbIntrospection` as
its "actual" side and cannot tell where it came from — so the change is
about supplying that from a committed file rather than a socket, and the
comparison code did not move at all.

### The CI gate this unlocks

```bash
npx forge generate --check     # exit 3, and names what is missing
```

```
[forge:generate] 1 change(s) are in the schema but not in any migration.
  - add orgs.region
```

That check is impossible for a database-backed generator, and it is the
main reason to adopt snapshots.

### Also

**`--custom`** writes an empty up/down that takes its place in the
ordered history — for a backfill, or the first half of a two-step change
(clean the NULLs, *then* add `NOT NULL`). Its snapshot is deliberately
unchanged: forge cannot know what hand-written SQL does, and guessing
would corrupt every later diff.

**A create-table migration now contains the `CREATE TABLE`.** It emitted
`-- create table 'x' via forge:push` on the assumption push had just run.
Survivable when generating against a live database; not when the file is
the only record — a migration whose `up` is a comment applies cleanly and
creates nothing.

**Snapshots are sorted** — tables, columns, indexes, keys — so reordering
two models in the schema file produces no diff, and the diff you see in
review is the change you made.

**One dialect per folder**, refused rather than diffed. Column types and
index shapes differ, so diffing a postgres schema against a mysql
snapshot would emit an `ALTER` for every column in the schema.

**Mongo refuses**, and should: there is no DDL to migrate, indexes are
reconciled by `forge push`, which is idempotent and needs no history.

`forge diff apply` is unchanged and remains the tool for adopting an
existing database. See [MIGRATIONS.md](./docs/MIGRATIONS.md) and
[VS-DRIZZLE.md](./docs/VS-DRIZZLE.md).

538 tests (was 524).

## 2.8.1 — the 2.8.0 changes, written down

**Patch.** No code change. 2.8.0 shipped six fixes and two additions and
documented them only in this file, which is the wrong place to look them
up from. They are now in the docs that cover each subject — see the
Documentation note under 2.8.0 — along with a new
[VS-DRIZZLE.md](./docs/VS-DRIZZLE.md).

## 2.8.0 — an index key called `id` was a real index on nothing

**Minor.** Six fixes and one addition, all found by indexing a
multi-tenant Mongo schema and then asking why nothing got faster.

### An index key written as `id` silently did nothing

The schema calls the primary key `id`; Mongo stores it as `_id`. Reads
and writes have always translated between the two — `coerce.ts` maps
`id` → `_id` on every query. **Index keys did not.** They were handed to
`createIndex` verbatim, so this:

```ts
indexes: [{ keys: { threadId: 1, createdAt: -1, id: -1 } }]
```

created a real Mongo index on a field literally called `id`, which no
document has. The index was useless and nothing said so: push reported
`created`, doctor reported nothing, and it appeared in `getIndexes()`.
Only `explain()` gave it away — the sort the index existed for was still
performed in memory (`SORT` rather than an index-served fetch). `diff`
then reported permanent drift, comparing the declared `id` against the
stored `_id`.

The rule was already half-applied: single-field uniques skip
`kind === 'id'` because "`_id` is automatic". It just never reached
compound keys.

Index keys are now translated on the Mongo adapter, in declared indexes,
composite uniques and text indexes alike, and `diff` compares like for
like. Existing schemas that wrote `_id` keep working unchanged; schemas
that wrote `id` get the index they meant, and push rebuilds it once.

### `doctor` called working indexes "ignored at push"

A *portable* index carries both dialects on purpose — a Mongo
`partialFilterExpression` and a SQL `where` string. Doctor saw the SQL
half and declared the whole index ignored, including UNIQUE ones. It was
not true: dropping such an index and re-running push recreated it with
`unique: true` and its filter intact. Acting on that warning meant
deleting a working duplicate guard.

Doctor now warns only when Mongo genuinely gets nothing — a string
`where` with no `partialFilterExpression` beside it, which really does
produce an index without the filter.

### `forge push --help` ran the push

Only `argv[2]` was checked for `--help`, so the flag fell through to the
subcommand, which ignored it. Asking a schema tool what a command does
should never be how you find out. `--help` is now honoured anywhere in
the arguments, and each subcommand has its own usage — including an
explicit note that `push` touches indexes only, never tables or rows.

### An equivalent index under an older name warned forever

`⚠ could not be created: Index already exists with a different name` on
every push, for an index whose keys and options already match. Nothing
was wrong and nothing could be done about it short of dropping an index
on live data. It is now a quiet one-line note, with
`FORGE_RENAME_INDEXES=1` to adopt the schema's name deliberately.

### `diff` described unmanaged tables like a deletion plan

`table 'x' in DB but not in schema` reads as though push will drop it.
Push only reconciles indexes and has never dropped a table — but at
least one team wrote a "do not run `forge push`" warning into their own
docs on the strength of that line. It now says what push will actually
do: *is not managed by forge — push will leave it alone*.

### `f.id({ type: 'string' })` — an application-supplied key

New. `auto`, `uuid` and `bigserial` all generate the value; there was no
way to declare a key the application supplies. That left natural keys
undeclarable — a counter whose `_id` is `"<orgId>:<series>"`, so that a
single `findOneAndUpdate` with `$inc` and `upsert` is atomic on one
document. Such a collection could not be described at all, so push, diff
and doctor could not see it.

`string` generates nothing and stores the value exactly as given; on
Mongo it is never coerced to an ObjectId, which would have rewritten a
24-hex natural key into something else and broken every lookup. MySQL
widens to `VARCHAR(255)` for it, since a natural key runs past 64 easily.

### `scopeBy` — and a lint for the class of bug that started this

New. Multi-tenant applications filter every read by a tenant key, usually
by wrapping the client in a proxy that injects it. Forge cannot add that
filter — it does not know where the value comes from — but it can check
that something indexes it:

```ts
model('appointments', fields, {
  scopeBy: 'orgId',
  indexes: [{ keys: { orgId: 1, createdAt: -1 } }],
})
```

`doctor` warns when nothing does. The check earns its place because the
failure is invisible in development: a scoped table holds one row per
tenant, so it looks tiny while the schema is young and grows with the
customer list rather than with usage — the scan gets slower for everyone
at once. In the schema that prompted this, 66 collections holding 27,367
rows had no index on their tenant key. After indexing, one hot query went
from 6,486 documents examined to 40.

An index whose first key is a more selective foreign key satisfies the
rule too: a thread id already implies its tenant, and indexing the tenant
instead would be the worse index.

### Documentation

Every change above is written up where it belongs, not only here:
`PRIMARY-KEYS.md` (the new id type), `MULTI-TENANT.md` (`scopeBy`, with
the measurements), `INDEXES.md` (`id` vs `_id`, and what to expect on the
first push), `CLI.md` (per-subcommand help), `PUSH.md`
(`FORGE_RENAME_INDEXES`), `DOCTOR.md` (both lint changes), and the README.

New: **[VS-DRIZZLE.md](./docs/VS-DRIZZLE.md)** — where forge actually
stands against drizzle-kit on migrations, what is genuinely missing, a
six-stage plan, and the rules that keep closing those gaps from turning
forge into a worse copy of something else. It starts by correcting a
common claim: `push` reconciles indexes only, but `diff apply` already
writes reviewable up/down SQL files with a `_forge_migrations` ledger and
a rollback. The real gap is that forge generates by introspecting a
**live database** where drizzle diffs the **last snapshot** — which is
why forge cannot generate a migration in CI, on a plane, or
deterministically.

### Also

`doctor` no longer runs on import — it self-executes only when invoked
directly, so its lint rules can be reused without launching a full
environment check and a database connection.

## 2.7.1 — you can ask the db what it has

**Patch.** 2.7.0 made reading an unregistered model throw, which is right —
a typo'd model name should be loud. But there was no way to *ask* first:
`'User' in db` returned `false` even for a model that was registered,
because the proxy never defined a `has` trap and `in` fell through to its
empty target. The one idiom that should have let you check before reading
was quietly wrong, so the only pattern that worked was `try`/`catch`
around a property access.

That combination bit a consumer at boot. A module wrote:

```ts
const db = getDb() as unknown as { orgIndustryMixView?: ViewLike };
return db.orgIndustryMixView ?? null;   // "use the view if it's registered"
```

The key was mis-cased (`OrgIndustryMixView`), so the read threw, the `??`
never ran, and an unhandled throw took down the process at startup. The
intent — degrade when the model isn't there — was reasonable. Forge just
gave it no way to express that.

**`in` now answers honestly**, and never throws:

```ts
'User'   in db   // true  — registered
'user'   in db   // false — case matters
'Typo'   in db   // false — no throw
'$transaction' in db  // true — the $ helpers are reported too

const view = 'OrgIndustryMixView' in db ? db.OrgIndustryMixView : null;
```

**New `db.$models`** — the registered model names, sorted. Handy for
tooling, diagnostics, and asserting a schema reached `createDb`:

```ts
db.$models   // ['Gadget', 'Widget']
```

Both work inside `$transaction` too; the tx handle reports only the
helpers it actually serves, so `'$migrate' in tx` is `false` rather than
claiming a key whose access would throw.

Unchanged on purpose: reading an unknown model still throws, and
`Object.keys(db)` still returns `[]`. Making model keys enumerable would
have made `JSON.stringify(db)` walk every collection wrapper — a worse
regression than the gap it closed. `$models` covers that need without it.

## 2.7.0 — a filter that doesn't filter is worse than an error

**Minor, deliberately stricter.** Five places used to swallow a malformed
query and run something else instead. All five now throw with the
correction in the message. Found in production: a filter written
Mongo-style matched **every row in the collection** and nothing flagged
it — twice.

**Unknown `where` operators throw.** Strict mode always rejected an
unknown *field*, but an unknown *operator* on a real field was dropped
from the tree — the condition vanished and the query matched everything:

```ts
await db.bill.findMany({ where: { postedAt: { lte: cutoff } } });   // 198 rows
await db.bill.findMany({ where: { postedAt: { $lte: cutoff } } });  // ALL 240 rows, silently
```

Now, in every mode (this is IR-level, so it covers all six dialects):

```
[forge] unknown operator '$lte' on 'bills.postedAt'. Valid: equals, not, in, …
  Did you mean 'lte'? forge uses bare operator names, not Mongo's $-prefixed ones.
```

Typos get a closest-match suggestion (`contians` → "Did you mean
'contains'?"), and container columns are pointed at `path` filters.

**Update operators are validated against the column.** A typo in an
atomic-op object used to be written through `$set`, replacing the number
with the object — silent data corruption on a schemaless store:

```ts
await db.post.update({ data: { view_count: { incrment: 5 } } });
// before: view_count is now the OBJECT { incrment: 5 }
// after:  [forge] invalid update for 'posts.view_count': object { incrment }
//         is not a valid operator form for a int column …
```

`increment` on a string column and ambiguous multi-op objects
(`{ set: 1, increment: 2 }`) throw too. json / embed / geo columns are
exempt — objects are their values.

**`not: { filter }` actually negates.** The typed surface always
advertised `not?: value | Filter`, and the README documents it, but the
object form compiled to a literal `$ne: { contains: 'x' }` — which
matches every row. It now builds the inner filter and wraps it in a
real NOT, on every dialect. `not: null` and `not: <value>` are untouched.

**Strict mode recurses.** `{ AND: [{ bogusField: 1 }] }` used to pass the
strict check (top-level keys only) and then silently match nothing.
Strict now walks AND/OR/NOT and relation filters (`author: { is: … }` is
validated against the *target* model's fields).

**`upsert` no longer loses the create value under an atomic op.** On
Mongo, a field seeded by `create` and incremented by `update` conflicts
with `$setOnInsert`, and the old resolution dropped the seed:

```ts
await db.counter.upsert({
  where: { key }, create: { key, seq: 100 }, update: { seq: { increment: 1 } },
});
// before: first call returns seq 1 (create's 100 vanished)
// after:  first call returns 100; second returns 101
```

That case now runs update-then-create with a duplicate-key retry, which
is exactly Prisma's semantics: insert applies `create` only, update
applies `update` only. Plain `$set` overlap keeps the single atomic op.
SQL dialects (`INSERT … ON CONFLICT`) and IndexedDB were already correct
and are unchanged.

**`aggregate` accepts both call shapes.** `aggregate([...])` (positional
array, the natural way to write it) used to read as an *empty* pipeline
— a silent full-collection scan. Both `aggregate({ pipeline })` and
`aggregate([...])` now work; anything else throws.

**Dotted container paths, typed and portable.**
`{ 'address.city': 'sf' }` and `{ 'meta.stats.views': { gte: 10 } }`
compile through the same IR leaf as `path` filters — Mongo emits dot
notation, SQL dialects emit native JSON paths — instead of only working
by accident on Mongo. Strict mode accepts them and validates embed
sub-fields against the embed's declared fields:

```
[forge:strict] unknown embed field 'bogus' in where key 'address.bogus'
on 'users'. Fields of 'address': street, city, zip, country.
```

**Optional columns get their operators back (types).** An `.optional()`
column's type is `T | null`, which failed every `[T] extends [string]`
branch in the filter types, so nullable columns silently fell back to
`equals/not/in/notIn` only — no `lte`, no `contains`, on exactly the
columns that pushed people to `as never` (and from there into the silent
drops above). The branch is on `NonNullable<T>` now; `equals: null` /
`not: null` stay typed.

Verified by the new `regression-where-op-safety.ts` live suite (19
scenarios, wired into `forge:regression:mongo`),
`src/__tests__/where-op-validation.spec.ts` (15 unit tests), and
`type-probe-nullable-filters.ts` (compile-time probe with negative
assertions). All 482 pre-existing jest tests and the Mongo + SQLite
integration suites pass unchanged.

**Upgrade note:** code that was accidentally shipping `$gte`-style
operators, typoed update ops, or object-form `not` was already broken —
it just failed silently. After this release those queries throw at the
call site instead. That is the point.

## 2.6.5 — a schema belongs to its db, not to the process

**Patch.** Two `createDb({ schema })` calls in one process fought over a
single global registry. The schema was stored in a module-level slot on
a last-write-wins basis, so opening a second connection moved the
pointer and every model on the first handle resolved to `undefined`:

```ts
const app = await createDb({ schema: appSchema, url: 'idb:app' });
const sync = await createDb({ schema: syncSchema, url: 'idb:sync' });

app.invoice.findMany();   // TypeError: Cannot read properties of
                          // undefined (reading 'findMany')
```

A db now binds the map its own `createDb` received, so several
connections with different schemas coexist. `$migrate` and `$diff` read
that bound map too, instead of whichever schema happened to be active.
Handles created without a `schema` keep reading the global registry, so
single-schema code behaves exactly as before.

The bundled sample also stopped overwriting consumer schemas.
`schema/index.ts` installs it at module load; under Node's CJS that
always evaluates before `createDb` runs, but bundlers that defer CJS
initialisation give no such guarantee — esbuild wraps a CJS module in a
lazy `__commonJS` whose body runs on first property access, which in a
Vite dev graph can land after `createDb`. It now installs through an
internal `setDefaultSchema` that declines to replace a schema a consumer
already set. `setActiveSchema` keeps last-write-wins for explicit calls.

A missing model no longer resolves to `undefined`. `db.<name>` for a key
the bound schema does not have throws, naming the key and listing what
IS available — the old failure surfaced as `Cannot read properties of
undefined (reading 'findMany')` several frames from the cause:

```
[forge] unknown model "outbox". Active schema exposes: syncEvent.
Pass your model map as createDb({ schema }) and check the key spelling.
```

## 2.6.4 — typed JSON columns

**Patch.** `f.json()` now takes an optional type parameter that flows
through to the row read type and the create/update input:

```ts
type Prefs = { theme: 'light' | 'dark'; density: number };

const Account = model('accounts', {
  id: f.id(),
  prefs: f.json<Prefs>(),   // row.prefs is Prefs; writes are checked
  meta: f.json(),           // no parameter -> unknown (was any)
});
```

The bare `f.json()` default changed from `any` to `unknown`, so a column
you haven't typed forces a narrow at the read site instead of silently
handing back `any`. This is the only behavioural change and it is
read-only — writes still accept any JSON value, and every existing
schema keeps compiling. Pass `f.json<any>()` to restore the old
per-column behaviour. `InferRow` / `InferCreate` / `InferUpdate` carry
the parameter through; `WhereInput` is unchanged.

## 2.6.3 — @tauri-apps/plugin-sql driver

**Patch.** New `tauriSqlDriver` wraps a `Database` opened via
`@tauri-apps/plugin-sql` and exposes the standard `SqliteDriver` port.
Tauri 2 apps now get a real SQLite backend via sqlx on the Rust side
without leaving the forge query API — one schema runs the same on
Node (better-sqlite3), browser (sqlite-wasm+OPFS), and Tauri (native
sqlx).

```ts
import Database from '@tauri-apps/plugin-sql';
import { createDb, tauriSqlDriver } from 'forge-orm';

const sqlite = await Database.load('sqlite:app.db');
export const db = await createDb({ schema, driver: tauriSqlDriver(sqlite) });
await db.$migrate();  // runtime DDL — same seam as the wasm/expo drivers
```

The port handles the plugin's one-statement-per-execute constraint by
splitting DDL batches on `;`, so the migrator's multi-statement output
runs unchanged. Prior versions treated Tauri as an unshipped driver
in the docs' walk-through — it's now `import { tauriSqlDriver } from
'forge-orm'` with a passing regression covering DDL, CRUD, atomic
guards, groupBy, transactions, and multi-statement exec.

No other changes. Drop-in for 2.6.2.

## 2.6.2 — IDB pagination + orderBy double-slice fix

**Patch.** `findMany({ take, skip, orderBy })` on the IndexedDB adapter
returned wrong pages when the `orderBy` field wasn't natively covered by
an IDB index. `cursorScan` sliced the stream in index order first, the
executor sorted the survivors in JS, then applied `take`/`skip` a
second time on the already-sliced result. On a 4-row store, page 2
(`{ take: 2, skip: 2 }`) came back empty.

Fix: defer `cursorScan`'s slice whenever `orderBy` needs a JS post-sort
(same condition already used for `nearTo` orderings and cursor
pagination). One slice, applied after the sort.

No other changes. Drop-in for 2.6.1.

## 2.6.1 — `$migrate()` on indexeddb

**Patch.** `db.$migrate()` now dispatches to the IndexedDB adapter's
`runMigrate` alongside the existing sqlite path. Under 2.6.0 the call threw
`$migrate() is only supported on sqlite adapters today`, which contradicted
`docs/INDEXEDDB.md` — the adapter shipped the machinery but the factory
didn't wire it up. Fixed.

Behaviour: on IDB, `createDb()` already runs the schema upgrade inside
`indexedDB.open()`'s native `onupgradeneeded`, so `$migrate()` is a
second, idempotent open — a metadata check that returns the standard
`RuntimeApplyReport { applied, skipped, failures, alteredColumns: [],
pending, version }`. Same signature as the sqlite path.

```ts
const db = await createDb({ url: 'idb:app', schema });
const r = await db.$migrate();
// { applied: [...], pending: [...], version: 2, ... }
```

No other changes. Drop-in for 2.6.0.

## 2.6.0 — IndexedDB adapter: zero-install browser tier

**Feature release.** Adds a native IndexedDB adapter alongside the sqlite-wasm
adapter shipped in 2.4. Every modern browser has IndexedDB natively, so the new
tier has no wasm blob to download, no worker file to bundle, no COOP/COEP
headers to set, no bundler plugin. Drop-in upgrade — the URL prefix `idb:` /
`indexeddb:` is new; no other prefix behaviour shifted.

### New URL schemes

`detectAdapterKind()` now recognises two browser-side prefixes that resolve
to the new `indexeddb` kind:

| URL | Backend | Persistence | Multi-tab |
|---|---|---|---|
| `idb:<name>` | IndexedDB | Full | **Native** — IDB coordinates writers |
| `indexeddb:<name>` | IndexedDB (alias of `idb:`) | Full | Native |

```ts
import { createDb } from 'forge-orm';

const db = await createDb({ url: 'idb:appname', schema });
await db.user.create({ data: { email: 'a@x.co', name: 'Alice' } });
```

The string after the colon is the IndexedDB database name — the same name you
would pass to `indexedDB.open(name)` by hand.

### New adapter — `forge-orm/indexeddb`

The Prisma-shape surface is identical to every other adapter — reads, writes,
relations, sorts, paging, aggregations, JSON path queries, geo `near` /
`withinPolygon`, vector `near` / `nearTo`, full-text `search`, atomic update
ops, upsert, soft-delete + restore, `.compile` escape hatch, `$transaction`,
`$migrate`, `$doctor`, `$diff`.

The adapter is exported at the `forge-orm/indexeddb` subpath so bundlers
tree-shake it out of any server bundle that doesn't import it. A driver
factory is exposed alongside the URL form for consumers that want to hand in
a pre-opened `IDBDatabase`:

```ts
import { indexedDbDriver } from 'forge-orm/indexeddb';

const db = await createDb({
  driver: indexedDbDriver({ name: 'appname' }),
  schema,
});
```

### Query planner

Every read runs through the same pipeline: `Args → IR → planner picks ONE
index → cursor scan → JS residual filter → JS sort → limit/offset`. The
planner scores candidate scan strategies 0–100 and picks the highest:

| Score | Strategy |
|---:|---|
| 100 | primary-key `eq` |
| 95 | full compound-index equality (all keys) |
| 90 | unique-index single-column `eq` |
| 85 | non-unique compound equality on all keys |
| 70 | non-unique single-column `eq` |
| 60 | `in` on indexed column |
| 50 | range op (`lt` / `lte` / `gt` / `gte` / `startsWith`) on indexed column |
| 20 | orderBy on indexed column with no `where` match (free sort) |
| 0 | full-table scan (no index applicable) |

Whichever leaves the range didn't absorb become a `(row) => boolean` residual
predicate applied per cursor result. `AND` at the root unlocks index
optimisation; `OR` and `NOT` at the root fall back to a full-table scan +
residual. Every plan carries an `explain` string — feed it through
`$on('query')` to watch which index each request lands on.

### Migrations via native IDB versioning

IndexedDB's `onupgradeneeded` maps cleanly to forge's non-destructive
migration model. `$migrate()` fingerprints the DDL plan (fnv-1a over sorted
store + index metadata) and only bumps the IDB version when the fingerprint
changes:

| Change | Behaviour on IDB |
|---|---|
| Add a field | No-op — IDB is schemaless |
| Add an index | `store.createIndex()` runs inside `onupgradeneeded`; IDB re-scans existing rows and back-populates the index automatically |
| Rename / drop an index | `store.deleteIndex()` (+ create for renames) |
| Add a store | `createObjectStore()` |
| Drop a store | Destructive — surfaces in `report.pending`, opt-in only |
| Change a field's type | No-op at DDL level — coerce at write side |
| Change a `keyPath` | Destructive — not supported natively; surfaced under pending |

Same fingerprint → no version bump → no upgrade cycle at all. `$migrate()`
on an unchanged schema is effectively a boot-time metadata check.

### Full-text search via multiEntry index

Every `.searchable()` field gets a shadow `_tokens_<field>: string[]` column
maintained by the executor at write time, indexed with `multiEntry`. Search
compiles `bio: { search: 'baker cyclist' }` into one `getAll` per token, then
intersects the ID sets — index-backed AND-of-tokens with real per-token
complexity, not a full-table cursor scan. Tokeniser rules: lowercase, split
on non-`\p{L}\p{N}\s`, dedupe, drop tokens longer than 40 chars, single-char
tokens kept (matters for CJK and Greek).

### Geo — Haversine fallback with bbox prefilter

Points are stored as `{ lng, lat }` (or `{ lng, lat, alt }` for 3D) inside
the row — same wire shape the sqlite adapter uses in fallback mode. A `[lng,
lat]` compound index (when declared) cursors just the bounding box; Haversine
JS then post-filters for exact `withinMeters` / `withinPolygon` / `orderBy
nearTo`. `_distanceMeters` annotations match every other dialect.
MultiPolygon with holes uses the same ray-cast + even-odd rule as the 2.5
fallback path.

### Vector — JS brute force

Vectors are plain `number[]` on the row. Filter and sort route through the
same executor pipeline as geo. Metrics: `cosine`, `l2`, `dot`. Dimension
mismatch → `Infinity` distance (silent — the row falls to the back).
Brute force is O(N × dims) per query — fine for lists of ≤ ~1 k vectors
× 100–1500 dims. Route heavier workloads to the sqlite-wasm-pro adapter
(sqlite-vec HNSW compiled in) or to a server tier.

### Transactions

IDB transactions auto-commit as soon as the microtask queue idles — awaiting
a non-IDB promise inside the callback silently commits the txn early. The
adapter's `$transaction(fn)` opens per-op txns and reuses them within the fn
body: best-effort atomicity across the batch, rollback on throw, but **not**
strict serialisability across arbitrary awaits. For strict atomicity of
interleaved reads + writes on the same store, use the batch form —
`$transaction([...ops])` maps to one IDB `readwrite` txn spanning every
store, committed atomically.

### Cascade walker

IDB has no foreign-key enforcement, so the adapter runs a JS cascade walker
before every delete — same pattern the Mongo adapter uses:

| `onDelete` | Behaviour |
|---|---|
| `Cascade` | Recurse (leaves-first) into child rows, then delete parent |
| `SetNull` | `$unset` the FK column on child rows, then delete parent |
| `Restrict` | Throw `[P2003] Restrict: cannot delete X` if children exist |
| `NoAction` / undefined | Skip — orphans allowed |

The walker tracks visited `collection:id` pairs so self-referential schemas
(`comment.parent_id → comment.id`) can't infinite-loop.

### Server-safety guard

The adapter references `indexedDB` and `IDBKeyRange` only inside function
bodies — never at module import time. On Node / edge / SSR runtimes,
`import { indexedDbDriver } from 'forge-orm/indexeddb'` succeeds; only
`openDb()` / `driver.open()` triggers a runtime check. When a server code
path does reach the adapter, the guard throws a specific `[P2010]` message
naming the runtime instead of a cryptic `ReferenceError`.

### Other changes

- `AdapterKind` widened to include `'indexeddb'`. `DRIVER_PACKAGE_FOR` reports
  `(none — browser built-in)` for the new kind so `forge doctor`'s driver
  table stays useful.
- New `docs/INDEXEDDB.md` (deep-dive companion to the README's new Browser
  (zero install) section) covering URL scheme, planner scoring, migration
  semantics, FTS/Geo/Vector/JSON-path behaviour, transactions, cascades,
  quota + Safari ITP, server safety, and the compatibility matrix.
- README gains a "Browser (zero install) — IndexedDB" subsection under
  Connecting (with the tradeoff table vs sqlite-wasm), a StackBlitz row for
  the new `19-indexeddb-zero-install` example, and an `INDEXEDDB.md` row in
  the Deep-dive companions "Runtime targets" table.

### Tests

**113/113** jest tests in the new `test/adapters/indexeddb/` suite via
`fake-indexeddb`. Covers CRUD, every operator, relations, pagination, cursor,
aggregations, planner scoring, migrations (add store / add index / drop
index / no-op field / destructive pending), geo (Haversine correctness,
antipodes, polygon with holes), vector (all three metrics), FTS (Unicode,
punctuation, no-match), JSON path (deep nesting, missing intermediate), soft
delete, transactions, cascades (all four actions), edge cases (limit 0,
offset beyond length, unique constraint, updatedAt stamping), a 1000-row
stress test, and the server-guard. Total across the repo: 585 tests (was
472 in 2.5.3).

### Compatibility

- **Drop-in upgrade** for 2.5.x consumers. No schema or API changes for any
  server-side code path. The URL prefix `idb:` / `indexeddb:` is new; no
  other prefix behaviour shifted.
- Runs in every browser since 2017 (IndexedDB is universal). React Native
  isn't supported — use `opSqliteDriver` there. Server runtimes throw a
  specific message when the adapter is reached by mistake.

## 2.5.3 — Docs expansion to 80 files (no code change)

**Docs-only patch.** No runtime change; the published `dist/` is byte-identical to 2.5.2. The release bumps the npm registry version so the expanded 80-doc tree is the default thing readers land on.

What changed:

- `docs/` grew from 20 files to 80 (~78,500 lines of reference material). The 60 new deep-dives complete the surface coverage:
  - **Schema (8 new):** PRIMARY-KEYS, FOREIGN-KEYS, ENUMS, CHECKS, GENERATED-COLUMNS, VIEWS, MATERIALIZED-VIEWS, TRIGGERS.
  - **Reads/writes (8 new):** UPSERT, BATCH, AGGREGATIONS, WINDOWS, PAGINATION, STREAMING, LOCKING, CONCURRENCY.
  - **CLI and operations (9 new):** CLI, PUSH, DIFF, DOCTOR, ROLLBACK, SEED, DEPLOYMENT, BACKUP-RESTORE, VERSIONING.
  - **Per-dialect deep dives (6 new):** POSTGRES, MYSQL, SQLITE, MONGO, DUCKDB, MSSQL.
  - **Observability and errors (5 new):** EVENTS, LOGGING, TRACING, METRICS, ERRORS.
  - **Performance (4 new):** POOLING, BENCHMARKS, CACHING, N-PLUS-ONE.
  - **Patterns (6 new):** SOFT-DELETE, AUDIT-LOG, MULTI-TENANT, SHARDING, IDEMPOTENCY, WATCH.
  - **Testing (3 new):** TESTING, INTEGRATION-TESTING, FIXTURES.
  - **Security (4 new):** SECURITY, ENCRYPTION, SQLCIPHER, AUTH.
  - **Type-level reference (5 new):** RUNTIME-VALIDATION, BRAND-TYPES, DATES, DECIMAL, UUID.
  - **Runtime targets (2 new):** WORKERS (Cloudflare / Vercel Edge), LAMBDA (AWS).
- README's Deep-dive table at the top expanded into eleven sections covering all 80 files.
- New "See more" pointers added for Errors, Soft delete, Views and materialised views, Watching queries, Performance, and Testing chapters. Existing pointers (Defining a schema / Reading data / Writing data / Migrations) expanded to reference the new docs in their respective surfaces.

Docs live in the GitHub repo only — the published npm tarball still ships `dist/` + README.md + CHANGELOG.md + LICENSE.

### Tests

472/472 jest tests, all green. Same as 2.5.2 — no code changed.

## 2.5.2 — Docs reorganization (no code change)

**Docs-only patch.** No runtime change; the published `dist/` is byte-identical to 2.5.1. The release bumps the npm registry version so the new README + the 20-doc deep-dive tree is the default thing readers land on.

What changed:

- `docs/` grew from 7 files to 20. New deep-dives for MODEL, EMBED, RELATIONS, INDEXES, QUERIES, MUTATIONS, TRANSACTIONS, RAW-SQL, FTS, MIGRATIONS, TYPES, REACT, DRIVERS — plus the BROWSER full reference split out from the README. Existing BACKEND, MOBILE, GEO, VECTOR, JSON-PATH, BROWSER-FRAMEWORKS expanded with consistent voice.
- README's Deep-dive table at the top restructured by section (Schema and data model / Reads, writes, transactions / Cross-cutting / Runtime targets) and grown to cover all 20 docs.
- "See more —" pointer added at the end of every README chapter that has a deep-dive companion: Install, Defining a schema, Reading data, Writing data, Grouping, Transactions, Raw SQL, FTS, Browser, Streaming, Migrations, Type safety. Geo / JSON path / Vector keep their existing "See also" lines.
- Docs filenames are uppercase to match the README.md / CHANGELOG.md convention.

Docs live in the GitHub repo only — the published npm tarball still ships `dist/` + README.md + CHANGELOG.md + LICENSE. Relative links in the README resolve to the repo on npmjs.com and github.com, so the 20-file table works in either viewer.

## 2.5.1 — Browser `$migrate()` applies non-destructive drift

**Patch release.** Closes the last "Coming soon" item carried over from 2.4:
the in-browser equivalent of `forge diff` + a safe slice of `forge push`,
rolled into the existing `$migrate()` call. Drop-in upgrade.

### What changed

`db.$migrate()` now runs a drift-apply pass after the create-pass:

1. CREATE IF NOT EXISTS for tables and indexes (unchanged from 2.5.0).
2. `introspectSqlite` + `diffIntrospection` against the active schema.
3. For every `{ kind: 'column', direction: 'missing' }` drift item that's
   safe — nullable, or has a constant default — emit
   `ALTER TABLE … ADD COLUMN` inside the same transaction.
4. Surface destructive drift (column drops, type changes, extra tables,
   NOT NULL columns with no default) under a new `pending` field. The
   runtime never tries to drop or re-type — those are full table-rebuild
   territory.

```ts
const report = await db.$migrate();
// {
//   applied:        ['items', 'forge_items_unique_name'],
//   skipped:        [],
//   failures:       [],
//   alteredColumns: ['items.email'],          // ADD COLUMN ran for each
//   pending:        [                          // not applied — caller decides
//     { kind: 'column', direction: 'missing', table: 'items', detail: "column 'count'" },
//     { kind: 'column', direction: 'extra',   table: 'items', detail: "column 'legacy_blob' in DB but not in schema" },
//   ],
// }
```

Opt out with `await db.$migrate({ alter: false })` if you want the strict
2.5.0 create-or-skip behaviour back. `db.$diff()` still returns the
`DriftReport` directly when you only want the diff without the apply.

### Why "non-destructive" is the only auto-applied slice

SQLite `ALTER TABLE … ADD COLUMN` is the one drift fix that survives a
non-empty production table. Adding a `NOT NULL` column without a constant
default would reject; dropping or re-typing a column needs a full table
rebuild (CREATE new table, INSERT … SELECT, DROP old, RENAME). The runtime
won't pick a rebuild strategy on its own — pending entries land in the
report so the caller can decide between wiping the DB, emitting a manual
`$executeRaw` rebuild, or relaxing the schema.

### Files added in 2.5.1

| File | Purpose |
|---|---|
| `src/wasm/drift-apply.ts` | introspect + diff + safe-ALTER pass; exported as `applyDrift()` for direct use |
| `src/__tests__/wasm-drift-apply.spec.ts` | 7 jest tests covering nullable / defaulted / unsafe / extra / opt-out / direct-call paths |

### Tests

472/472 jest tests, all green. Was 465/465 in 2.5.0.

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
schemas had to fall back to ``db.$executeRaw`CREATE INDEX …``` or a manual
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
