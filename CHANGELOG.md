# Changelog

All notable changes to **forge** (`forge-orm`). Forge is a Prisma-shape
multi-database wrapper for MongoDB, PostgreSQL, MySQL, and SQLite - one code
path, no codegen, no external query engine.

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
