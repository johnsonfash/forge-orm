# forge-orm

A small, Prisma-shaped data layer for **MongoDB, PostgreSQL, MySQL, SQLite,
DuckDB and SQL Server**. You write your models once in plain TypeScript and
the same query code runs against any of the six databases. There is no code
generation step, no Rust query engine, and no framework to adopt — just
readable TypeScript over the official drivers, organised one adapter per
database.

```
npm install forge-orm
```

* **npm:** https://www.npmjs.com/package/forge-orm
* **GitHub:** https://github.com/johnsonfash/forge-orm
* **License:** MIT

```ts
import { createDb, f, model } from 'forge-orm';

const User = model('users', {
  id:    f.id(),
  email: f.string().unique(),
  name:  f.string(),
});

const db = await createDb({ url: process.env.DATABASE_URL!, schema: { user: User } });

const alice = await db.user.create({ data: { email: 'a@x.co', name: 'Alice' } }); // no id needed
const users = await db.user.findMany({ where: { name: { contains: 'Ali' } }, take: 10 });
```

The same code works whether `DATABASE_URL` is a Postgres, MySQL, SQLite,
DuckDB, SQL Server, or Mongo connection string. forge picks the right
driver from the URL prefix (`postgres:`, `mysql:`, `sqlite:`, `duckdb:`,
`mssql:`, `mongodb:`).

Beyond the basics, forge ships first-class typed support for the things
you usually have to drop to raw SQL for:

* **Geo** — `f.geoPoint()` + `near` / `nearTo` / `withinPolygon`,
  compiling to PostGIS / MySQL spatial / SpatiaLite / DuckDB spatial /
  MSSQL `GEOGRAPHY` / Mongo `2dsphere`. App-side Haversine fallback when
  no spatial extension is installed.
* **Vector similarity** — `f.vector(1536, { metric: 'cosine' })` + the
  same `near` / `nearTo` vocabulary, compiling to pgvector / DuckDB vss
  HNSW / MSSQL `VECTOR_DISTANCE` / MySQL 9 `DISTANCE` / sqlite-vec /
  Mongo Atlas `$vectorSearch`.
* **JSON path queries** — `where: { meta: { path: 'profile.age', gte: 18 } }`
  on any `f.json()` / `f.embed()` / `f.embedMany()` / array column,
  compiling to PG `->/->>`, MySQL `JSON_EXTRACT`, SQLite / DuckDB
  `json_extract`, MSSQL `JSON_VALUE`, Mongo dotted-key form.
* **Full-text search** — `f.text().searchable()` builds the right index
  per dialect (Postgres GIN tsvector, MySQL `FULLTEXT`, SQLite FTS5 with
  shadow-table triggers, Mongo `text`, DuckDB `fts`) and the `search`
  operator queries it.

---

## Sandbox / runnable examples

Try forge-orm without installing anything — every example is one click away on StackBlitz:

| Browser-runnable | One-liner |
|---|---|
| [SQLite browser todo](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/01-sqlite-browser-todo) | OPFS-persisted todo app, no server |
| [Offline-first with sync outbox](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/02-sqlite-browser-offline-first) | Optimistic writes + drain loop |
| [Node CLI (smallest)](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/04-node-cli) | Smallest possible forge-orm program |
| [Hono + PGlite REST API](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/05-hono-pglite-api) | Backend API, zero external DB |
| [Next.js + PGlite full-stack](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/06-nextjs-pglite-fullstack) | App Router + Server Actions |
| [IndexedDB zero-install](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/19-indexeddb-zero-install) | Full CRUD + geo + vector + FTS, no wasm |

| Auto-runs on CodeSandbox | Why |
|---|---|
| [DuckDB analytics](https://codesandbox.io/p/devbox/github/johnsonfash/forge-orm-examples/main/03-duckdb-cli-needs-vm) | `@duckdb/node-api` is a native addon |
| [Bun + SQLite blog](https://codesandbox.io/p/devbox/github/johnsonfash/forge-orm-examples/main/07-bun-cli-needs-vm) | Bun's SQLite is native |

| Feature deep-dives | Pattern |
|---|---|
| [Geo search](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/08-geo-search) | `geoPoint` + `nearTo` (PostGIS / Mongo / wasm fallback) |
| [Vector RAG](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/09-vector-rag) | `f.vector(N)` + cosine similarity |
| [Recipe / BOM](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/10-recipe-bom) | Recursive sub-recipe rollup |
| [Multi-tenant scoping](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/11-multi-tenant) | Soft RLS via app-layer wrapper |
| [Audit log](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/12-audit-log) | `db.$on("query", …)` filtering mutating ops |
| [Full-text search](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/13-fulltext-search) | `.search()` index across dialects |
| [Transactions](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/14-transactions) | Atomic batch + nested savepoints |
| [Migrations + drift](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/15-migrations-drift) | `db.$migrate()` + `db.$diff()` |

| Real DB (point at your own) | Setup |
|---|---|
| [MongoDB Atlas blog](https://github.com/johnsonfash/forge-orm-examples/tree/main/16-mongo-atlas-blog) | Free Atlas tier, paste URI into `.env` |
| [MSSQL ERP / MERGE](https://github.com/johnsonfash/forge-orm-examples/tree/main/17-mssql-merge-erp) | Docker SQL Server, `.env` |
| [Postgres + RLS auth](https://github.com/johnsonfash/forge-orm-examples/tree/main/18-postgres-rls-auth) | Hard multi-tenant via `current_setting` |

All 18 examples live at **[johnsonfash/forge-orm-examples](https://github.com/johnsonfash/forge-orm-examples)**. Clone any folder:

```sh
npx degit johnsonfash/forge-orm-examples/01-sqlite-browser-todo my-app
```

---

## Contents

* [Sandbox / runnable examples](#sandbox--runnable-examples)
* [What forge is, and what it is not](#what-forge-is-and-what-it-is-not)
  * [What's new](#whats-new)
* [Install and pick your driver](#install-and-pick-your-driver)
* [Connecting](#connecting)
  * [Pluggable drivers](#pluggable-drivers)
  * [Browser (zero install) — IndexedDB](#browser-zero-install--indexeddb)
  * [Wire-compatible databases (no new code needed)](#wire-compatible-databases-no-new-code-needed)
  * [Coming soon](#coming-soon)
* [Defining a schema](#defining-a-schema)
  * [Models and automatic values (id, timestamps)](#models-and-automatic-values-id-timestamps)
  * [Picking a primary-key strategy](#picking-a-primary-key-strategy)
  * [Field types](#field-types)
  * [Field modifiers](#field-modifiers)
  * [Indexes and unique constraints](#indexes-and-unique-constraints)
  * [Relations](#relations)
  * [Embedded objects](#embedded-objects)
* [Reading data](#reading-data)
  * [Filtering with `where`](#filtering-with-where)
  * [Operator reference](#operator-reference)
  * [Comparing two columns: `col()`](#comparing-two-columns-col)
  * [Choosing fields: `select` and `include`](#choosing-fields-select-and-include)
  * [Sorting and pagination](#sorting-and-pagination)
* [Writing data](#writing-data)
  * [Atomic number ops](#atomic-number-ops)
  * [Writing related records in one call](#writing-related-records-in-one-call)
  * [Deletes and cascades](#deletes-and-cascades)
* [Grouping and aggregates](#grouping-and-aggregates)
  * [Distinct](#distinct)
* [Transactions](#transactions)
* [Running raw SQL](#running-raw-sql)
* [Errors](#errors)
* [Full-text search](#full-text-search)
* [Geo (geoPoint, near, nearTo, withinPolygon)](#geo-geopoint-near-nearto-withinpolygon)
* [JSON path queries](#json-path-queries)
* [Vector similarity search](#vector-similarity-search)
* [Browser (sqlite-wasm + OPFS)](#browser-sqlite-wasm--opfs)
  * [Quickstart](#quickstart)
  * [URL schemes (`opfs:`, `opfs-sahpool:`, `:memory:`)](#url-schemes-opfs-opfs-sahpool-memory)
  * [The worker file](#the-worker-file)
  * [Vite setup](#vite-setup)
  * [Next.js setup](#nextjs-setup)
  * [Webpack / CRA / Rsbuild setup](#webpack--cra--rsbuild-setup)
  * [`db.$migrate()` — runtime DDL apply](#dbmigrate--runtime-ddl-apply)
  * [`browserDoctor()` — runtime capability probe](#browserdoctor--runtime-capability-probe)
  * [Persistent storage and the Safari 7-day eviction](#persistent-storage-and-the-safari-7-day-eviction)
  * [Multi-tab safety](#multi-tab-safety)
  * [Feature parity matrix](#feature-parity-matrix)
  * [Custom wasm build (vec0 + R-Tree)](#custom-wasm-build-vec0--r-tree)
  * [Troubleshooting](#troubleshooting)
  * [Framework worked examples → docs/BROWSER-FRAMEWORKS.md](docs/BROWSER-FRAMEWORKS.md)
* [Streaming large results](#streaming-large-results)
* [Soft delete](#soft-delete)
* [Views and materialised views](#views-and-materialised-views)
* [Watching queries](#watching-queries)
* [Creating tables and migrations](#creating-tables-and-migrations)
  * [Pointing the CLI at your schema](#pointing-the-cli-at-your-schema)
  * [Ignoring drift on `forge diff`](#ignoring-drift-on-forge-diff)
  * [`forge doctor` — live capability probe](#forge-doctor--live-capability-probe)
  * [Extensions and `forge push --enable-extensions`](#extensions-and-forge-push---enable-extensions)
* [Dropping to raw queries with `.compile`](#dropping-to-raw-queries-with-compile)
* [Type safety](#type-safety)
  * [Row + db helpers](#row--db-helpers)
  * [Direct-from-model inference (`Infer*`)](#direct-from-model-inference-infer)
* [Performance](#performance)
* [Testing](#testing)
  * [Driver smoke harness](#driver-smoke-harness)
* [Limitations and honest notes](#limitations-and-honest-notes)
* [Contributing](#contributing)

### Deep-dive companions (`docs/`)

The README is the surface reference. For more depth — extra examples, edge cases, integration patterns — each major surface has its own companion doc. Eighty files in total, ~80,000 lines of reference material.

**Schema and data model**

| Topic | File |
|---|---|
| Model definition — full field catalogue, id strategies, enums, views, generated columns, schema namespacing, 5 worked schemas | **[docs/MODEL.md](docs/MODEL.md)** |
| Embeds — `f.embed`/`f.embedMany`/`f.json`, indexing into embeds, Mongo `$elemMatch`, JSON-null markers, shape migration, 5 worked patterns | **[docs/EMBED.md](docs/EMBED.md)** |
| Relations — one/many/inverse/cascade, join tables, polymorphic, self-ref, deep includes, 6 worked patterns | **[docs/RELATIONS.md](docs/RELATIONS.md)** |
| Indexes — every `IndexDef` field, partial-filter, expression, INCLUDE, method matrix, drift detection, 6 worked patterns | **[docs/INDEXES.md](docs/INDEXES.md)** |
| Type safety — `Row`, every `Infer*` helper, `ForgeOf` / `ForgeModels`, autocomplete tricks, generics, 5 worked patterns | **[docs/TYPES.md](docs/TYPES.md)** |
| Primary keys — UUIDv4 vs v7 vs ULID vs Snowflake vs serial, fragmentation, per-dialect emit, migration | **[docs/PRIMARY-KEYS.md](docs/PRIMARY-KEYS.md)** |
| Foreign keys — REFERENCES emit, onDelete/onUpdate, deferred checking, composite, online add, per-dialect quirks | **[docs/FOREIGN-KEYS.md](docs/FOREIGN-KEYS.md)** |
| Enums — `f.enum(...)`, per-dialect emit, evolution (adding values online, expand/contract), lookup-table alternative | **[docs/ENUMS.md](docs/ENUMS.md)** |
| CHECK constraints — DB-enforced row invariants, `NOT VALID`+`VALIDATE`, NULL semantics, vs zod, Mongo `$jsonSchema` | **[docs/CHECKS.md](docs/CHECKS.md)** |
| Generated columns — STORED vs VIRTUAL, indexable JSON extracts, per-dialect matrix, common patterns | **[docs/GENERATED-COLUMNS.md](docs/GENERATED-COLUMNS.md)** |
| Views — `CREATE VIEW`, updatable rules, SECURITY_BARRIER, indexed views, Mongo collection views | **[docs/VIEWS.md](docs/VIEWS.md)** |
| Materialized views — refresh strategies, CONCURRENTLY, MSSQL indexed views, Mongo `$merge`/`$out`, MySQL/SQLite emulation | **[docs/MATERIALIZED-VIEWS.md](docs/MATERIALIZED-VIEWS.md)** |
| Triggers — DB-side procedural code, audit-log trigger, per-dialect model, Mongo change-stream alternative | **[docs/TRIGGERS.md](docs/TRIGGERS.md)** |

**Reads, writes, transactions**

| Topic | File |
|---|---|
| Queries — every operator with per-dialect SQL/Mongo emit, cursor pagination, distinct, streaming, common bugs, 8 worked queries | **[docs/QUERIES.md](docs/QUERIES.md)** |
| Mutations — create/update/upsert/delete asymmetry, atomic ops, nested writes, idempotency, optimistic+pessimistic concurrency, 8 worked patterns | **[docs/MUTATIONS.md](docs/MUTATIONS.md)** |
| Transactions — callback vs array, per-dialect mechanics, savepoints, isolation, deadlock retry, Mongo replica-set, outbox, 5 worked patterns | **[docs/TRANSACTIONS.md](docs/TRANSACTIONS.md)** |
| Raw SQL — `forgeSql` composition, identifier-vs-value safety, per-dialect placeholders, `$runCommandRaw`, per-dialect worked patterns | **[docs/RAW-SQL.md](docs/RAW-SQL.md)** |
| Upsert — `ON CONFLICT` / `ON DUPLICATE KEY` / `MERGE` / `findOneAndUpdate` per dialect, partial updates, race semantics | **[docs/UPSERT.md](docs/UPSERT.md)** |
| Batch ops — `createMany`/`updateMany`/`deleteMany`, bind-parameter limits, chunking, ordered vs unordered, RETURNING | **[docs/BATCH.md](docs/BATCH.md)** |
| Aggregations — count/sum/avg/groupBy/having/distinct, per-dialect emit, decimal precision, dashboard patterns | **[docs/AGGREGATIONS.md](docs/AGGREGATIONS.md)** |
| Window functions — ROW_NUMBER/RANK/LAG/LEAD/SUM OVER, per-dialect matrix, top-N per group, moving averages, sessionization | **[docs/WINDOWS.md](docs/WINDOWS.md)** |
| Pagination — cursor / offset / numbered / infinite-scroll, total-count strategies, Relay/REST shapes, per-dialect | **[docs/PAGINATION.md](docs/PAGINATION.md)** |
| Streaming — `findManyStream` per-driver internals, memory profile, backpressure, HTTP streaming, transactions+streaming | **[docs/STREAMING.md](docs/STREAMING.md)** |
| Locking — SELECT FOR UPDATE, advisory locks, SKIP LOCKED work queues, NOWAIT, deadlock prevention | **[docs/LOCKING.md](docs/LOCKING.md)** |
| Concurrency control — optimistic version columns, ETag/If-Match, retry strategies, per-dialect isolation quirks | **[docs/CONCURRENCY.md](docs/CONCURRENCY.md)** |

**Cross-cutting surfaces**

| Topic | File |
|---|---|
| Full-text search — every dialect's FTS engine, ranking, multi-column, languages, hybrid BM25+vector, highlighting, 6 worked patterns | **[docs/FTS.md](docs/FTS.md)** |
| Geo — SRIDs, dialect matrix, PostGIS, distance models, 3D, MultiPolygon, GeoJSON, spatial joins, H3, realtime tracking | **[docs/GEO.md](docs/GEO.md)** |
| Vector / embeddings / RAG — dialect picker, pipeline, hybrid BM25, versioning, HNSW/IVFFlat, quantization, multi-modal, eval | **[docs/VECTOR.md](docs/VECTOR.md)** |
| JSON path queries — per-dialect emit, indexing, migration, operator matrix, null markers, audit/webhook patterns, common bugs | **[docs/JSON-PATH.md](docs/JSON-PATH.md)** |
| Migrations — push-style model, every CLI flag, drift rules, per-dialect emit, three CI snippets, blue/green, monorepo, runtime split | **[docs/MIGRATIONS.md](docs/MIGRATIONS.md)** |
| Drivers — bring-your-own-driver pattern, every shipped wrapper, six worked wrappers (Neon, Turso, D1, Atlas Data API, Bun, decorator) | **[docs/DRIVERS.md](docs/DRIVERS.md)** |

**CLI and operations**

| Topic | File |
|---|---|
| CLI reference — every `forge` subcommand and flag, exit codes, env config, CI snippets, programmatic equivalents | **[docs/CLI.md](docs/CLI.md)** |
| `forge push` — push semantics, `--enable-extensions`, `--fallback`, idempotency, dry-run, per-dialect DDL ordering | **[docs/PUSH.md](docs/PUSH.md)** |
| `forge diff` — drift detection rules, DriftItem taxonomy, drift apply, per-dialect quirks, CI gating, the 2.5.1 auto-apply pass | **[docs/DIFF.md](docs/DIFF.md)** |
| `forge doctor` — live capability probe, per-dialect checks, fix recipes, browserDoctor, K8s readinessProbe | **[docs/DOCTOR.md](docs/DOCTOR.md)** |
| Rollback — snapshot rollback, forward-only, blue/green, per-dialect destructive-DDL limits, emergency restore | **[docs/ROLLBACK.md](docs/ROLLBACK.md)** |
| Seeding — idempotent upserts, bootstrap/dev/demo split, large seeds, faker, deterministic random, 3 worked seed programs | **[docs/SEED.md](docs/SEED.md)** |
| Deployment — env-per-stage, zero-downtime patterns, blue/green, containerized vs serverless, RDS Proxy, multi-region | **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** |
| Backup and restore — per-dialect primitives (`pg_dump`, MariaBackup, litestream, Atlas snapshots), PITR, restore drills, encryption | **[docs/BACKUP-RESTORE.md](docs/BACKUP-RESTORE.md)** |
| Schema versioning — additive-only rules, expand/contract for breaking changes, multi-app coordination, snapshot diffs | **[docs/VERSIONING.md](docs/VERSIONING.md)** |

**Per-dialect deep dives**

| Topic | File |
|---|---|
| PostgreSQL — pg/postgres.js/Neon HTTP matrix, type round-trip, JSONB, arrays, extensions, CONCURRENTLY, RLS, pgbouncer caveats | **[docs/POSTGRES.md](docs/POSTGRES.md)** |
| MySQL / MariaDB — mysql2/mariadb drivers, 5.7 vs 8.x matrix, charset, FULLTEXT, native spatial, online DDL, replication | **[docs/MYSQL.md](docs/MYSQL.md)** |
| SQLite (server) — better-sqlite3/libsql/bun:sqlite, PRAGMAs, WAL, ALTER TABLE limits, extensions, litestream, sharding | **[docs/SQLITE.md](docs/SQLITE.md)** |
| MongoDB — relational-to-document mapping, index types, Atlas Search/Vector, change streams, transactions, sharding | **[docs/MONGO.md](docs/MONGO.md)** |
| DuckDB — analytical workloads, Parquet/CSV ingestion, S3 httpfs, ATTACH cross-DB joins, EXPORT DATABASE, window funcs | **[docs/DUCKDB.md](docs/DUCKDB.md)** |
| SQL Server — `MERGE` upsert, snapshot isolation, geography vs geometry, OPENJSON, Azure SQL specifics | **[docs/MSSQL.md](docs/MSSQL.md)** |

**Observability and errors**

| Topic | File |
|---|---|
| Events — `QueryEvent` shape, `semanticOp`, subscribers, Pino/Sentry/OTel/Prometheus integrations, custom sinks | **[docs/EVENTS.md](docs/EVENTS.md)** |
| Logging — Pino/Winston/Bunyan wiring, redaction, sampling, request correlation, rotation | **[docs/LOGGING.md](docs/LOGGING.md)** |
| Tracing — OpenTelemetry SDK, span propagation, W3C traceparent, exporters (Jaeger, Tempo, Honeycomb, DataDog) | **[docs/TRACING.md](docs/TRACING.md)** |
| Metrics — Prometheus, histogram buckets, cardinality discipline, RED/USE dashboards, alerting rules | **[docs/METRICS.md](docs/METRICS.md)** |
| Errors — every error class, per-dialect code mapping, retry classes, backoff, Sentry/Bugsnag wiring | **[docs/ERRORS.md](docs/ERRORS.md)** |

**Performance**

| Topic | File |
|---|---|
| Connection pooling — sizing per dialect, per-runtime constraints (Lambda, Workers, Bun), pgbouncer/RDS Proxy caveats | **[docs/POOLING.md](docs/POOLING.md)** |
| Benchmarks — `forge:bench` methodology, scenarios, Prisma/Drizzle compare mode, profiling, CI regression gating | **[docs/BENCHMARKS.md](docs/BENCHMARKS.md)** |
| Caching — DataLoader per-request, Redis cache-aside, CDN headers, event-driven invalidation, stampede prevention | **[docs/CACHING.md](docs/CACHING.md)** |
| Preventing N+1 — `include` vs DataLoader, GraphQL resolvers, detection via event hook, per-dialect cross-product gotchas | **[docs/N-PLUS-ONE.md](docs/N-PLUS-ONE.md)** |

**Patterns**

| Topic | File |
|---|---|
| Soft delete — `softDelete`/`restore`, partial-filter uniques, query defaults, retention purge, GDPR caveats | **[docs/SOFT-DELETE.md](docs/SOFT-DELETE.md)** |
| Audit log — three shapes (single table, per-model history, append-only event), actor capture, hash-chain tamper resistance | **[docs/AUDIT-LOG.md](docs/AUDIT-LOG.md)** |
| Multi-tenant — shared-schema/schema-per-tenant/DB-per-tenant trade-offs, `scopedDb`, RLS, per-tenant migration orchestration | **[docs/MULTI-TENANT.md](docs/MULTI-TENANT.md)** |
| Sharding — shard-key choice, routing, cross-shard query patterns, resharding, native helpers (Vitess, Citus, Mongo) | **[docs/SHARDING.md](docs/SHARDING.md)** |
| Idempotency keys — Stripe-style model, atomic upsert primitive, TTL, webhook receivers, BullMQ jobIds, saga compensation | **[docs/IDEMPOTENCY.md](docs/IDEMPOTENCY.md)** |
| Watch / change feeds — Mongo change streams, Postgres LISTEN/NOTIFY + logical replication, MySQL binlog, WebSocket fan-out | **[docs/WATCH.md](docs/WATCH.md)** |

**Testing**

| Topic | File |
|---|---|
| Testing — in-memory better-sqlite3, FakeWorker for browser, transaction-rollback reset, event-hook assertions | **[docs/TESTING.md](docs/TESTING.md)** |
| Integration testing — testcontainers, Docker Compose, `forge:integration:*`, parallel-safe schema reset, GH Actions matrix | **[docs/INTEGRATION-TESTING.md](docs/INTEGRATION-TESTING.md)** |
| Fixtures and factories — static fixtures, typed factories, seeded random, snapshot fixtures, browser OPFS fixtures | **[docs/FIXTURES.md](docs/FIXTURES.md)** |

**Security**

| Topic | File |
|---|---|
| Security — parameterized queries, RLS, column masking, field-level encryption, audit log, GDPR/HIPAA/PCI patterns | **[docs/SECURITY.md](docs/SECURITY.md)** |
| Encryption — at-rest (TDE, native), in-transit (TLS/mTLS), field-level (AES-GCM, CSFLE), KMS-backed key rotation | **[docs/ENCRYPTION.md](docs/ENCRYPTION.md)** |
| SQLCipher — encrypted SQLite, driver matrix, key derivation, rekey, mobile lock-screen patterns | **[docs/SQLCIPHER.md](docs/SQLCIPHER.md)** |
| Database auth — password vs IAM vs mTLS vs SSH-tunnel, IAM token refresh, secret rotation, RDS Proxy / Cloud SQL Auth | **[docs/AUTH.md](docs/AUTH.md)** |

**Type-level reference**

| Topic | File |
|---|---|
| Runtime validation (zod) — boundary parsing, two-schema asymmetry, transforms, OpenAPI gen, form-lib resolvers | **[docs/RUNTIME-VALIDATION.md](docs/RUNTIME-VALIDATION.md)** |
| Brand types — nominal IDs, zod `.brand`, multi-brand unions, money/time invariants, FK propagation | **[docs/BRAND-TYPES.md](docs/BRAND-TYPES.md)** |
| Dates and times — `f.dateTime`/`f.date`/`f.time` per-dialect emit, timezone strategy, Temporal API, DST/calendar pitfalls | **[docs/DATES.md](docs/DATES.md)** |
| Decimal and money — `f.decimal({ precision, scale })`, integer-cents pattern, dinero.js, per-dialect precision quirks | **[docs/DECIMAL.md](docs/DECIMAL.md)** |
| UUID / ULID / Snowflake — bit layouts, DB-side generators, fragmentation, sortability, ObjectId, choice flowchart | **[docs/UUID.md](docs/UUID.md)** |

**Runtime targets**

| Topic | File |
|---|---|
| Backend — server integration (hyper-express, Fastify, NestJS, Bun+Hono, pools, tx, BullMQ, multi-tenant, replicas, OTel, health, CI) | **[docs/BACKEND.md](docs/BACKEND.md)** |
| Browser — full sqlite-wasm + OPFS reference (URL schemes, worker, bundlers, `$migrate`, browserDoctor, ITP, multi-tab, pro build) | **[docs/BROWSER.md](docs/BROWSER.md)** |
| IndexedDB (zero-install browser) — planner scoring, IDB versioning migrations, FTS via multiEntry, Haversine + brute-force fallback, quota + ITP, server-safety guard | **[docs/INDEXEDDB.md](docs/INDEXEDDB.md)** |
| Browser frameworks — React+Vite, Next.js, Vue, Nuxt, SvelteKit, Angular, SolidStart, Astro, Remix, React Native, Tauri (11 recipes) | **[docs/BROWSER-FRAMEWORKS.md](docs/BROWSER-FRAMEWORKS.md)** |
| React — hooks, TanStack Query, Suspense, server vs client components, optimistic updates, sync, code-splitting, testing, 6 worked patterns | **[docs/REACT.md](docs/REACT.md)** |
| Mobile — RN bare, Expo, Capacitor, Tauri, SQLCipher, sync patterns, background tasks, testing, migration cookbooks | **[docs/MOBILE.md](docs/MOBILE.md)** |
| Cloudflare Workers / Vercel Edge — V8 isolate constraints, D1, Hyperdrive-fronted Postgres, Neon HTTP, Turso, cache patterns | **[docs/WORKERS.md](docs/WORKERS.md)** |
| AWS Lambda — handler-scope pool, RDS Proxy, Aurora Serverless Data API, IAM token refresh, SIGTERM drain, cold-start budget | **[docs/LAMBDA.md](docs/LAMBDA.md)** |

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
Drizzle. The [honest notes](#limitations-and-honest-notes) at the end spell
this out.

### What's new

Full release history is in [CHANGELOG.md](./CHANGELOG.md). Recent highlights:

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
  [Browser (zero install) — IndexedDB](#browser-zero-install--indexeddb).
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
  [Browser (sqlite-wasm + OPFS)](#browser-sqlite-wasm--opfs).
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
  the explicit `softDelete()` / `restore()` verbs. See [Soft delete](#soft-delete).
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

## Install and pick your driver

forge ships no database driver of its own. You install only the driver for the
database you use. Each one is an optional peer dependency, so `npm install
forge-orm` on its own pulls nothing extra, and importing forge needs no driver
at all.

| Database          | Connection string starts with     | Install                       |
| ----------------- | ---------------------------------- | ----------------------------- |
| PostgreSQL        | `postgres://` or `postgresql://`   | `npm install pg`              |
| MySQL or MariaDB  | `mysql://`                         | `npm install mysql2`          |
| SQLite            | `sqlite:` or `file:`               | `npm install better-sqlite3`  |
| MongoDB           | `mongodb://` or `mongodb+srv://`   | `npm install mongodb`         |
| DuckDB            | `duckdb:`                          | `npm install @duckdb/node-api`|
| SQL Server (MSSQL)| `mssql:` or `sqlserver:`           | `npm install mssql`           |
| Browser (SQLite)  | `opfs:`, `opfs-sahpool:`, `:memory:` | `npm install @sqlite.org/sqlite-wasm` |
| Browser (IndexedDB) | `idb:` or `indexeddb:`             | none — browser built-in                |

```sh
npm install forge-orm      # the library, no drivers
npm install pg             # add the one you need
```

The driver loads lazily, the first time you actually run a query against that
database. Importing forge, defining a schema, or using one database never
needs the other databases' drivers installed. If a driver is missing when you
connect, you get a clear message telling you what to install rather than a
crash.

There is no lock-in. No generated client to regenerate, no migration state you
cannot leave, no framework module to wire in, and no driver bundled inside. It
is plain TypeScript over the official drivers, and you can always call the
driver directly if you outgrow it.

See more — **[docs/DRIVERS.md](docs/DRIVERS.md)** for the bring-your-own-driver pattern, every shipped wrapper, six worked wrappers (Neon HTTP, Turso, Cloudflare D1, Atlas Data API, Bun:sqlite, logging decorator), capability flags, and per-driver perf notes.

---

## Connecting

`createDb` takes a connection URL and your schema. It returns a typed `db`
handle whose properties match your model names.

```ts
import { createDb } from 'forge-orm';

const db = await createDb({
  url: process.env.DATABASE_URL!,   // postgres://… | mysql://… | sqlite:… | duckdb:… | mssql:… | mongodb://…
  schema: { user: User, post: Post },
});

// later, when shutting down:
await db.$disconnect();
```

Options:

* `url` is the connection string. The prefix selects the database.
* `schema` is your model map. `db.<key>` exists for each key (for example
  `db.user`, `db.post`).
* `type` (optional) forces the database type if the URL is ambiguous:
  `'postgres' | 'mysql' | 'sqlite' | 'mongo' | 'duckdb' | 'mssql'`.
* `strict` (optional, default `false`). When `true`, a query that filters on an
  unknown field name throws instead of silently matching nothing. Useful for
  catching typos.

You can also pass connection parts instead of a URL:

```ts
await createDb({ type: 'postgres', host: 'localhost', database: 'app', user: 'me', schema });
```

### Pluggable drivers

All six databases ship a sensible default driver, and all six let you swap in
another client — for React Native, edge / serverless runtimes, or a managed /
API-compatible backend. Instead of a URL you open the client yourself (you own
its config and lifecycle), wrap it with one of forge's driver factories, and
pass it as `driver`. The query API is identical whichever client backs it.

```ts
const db = await createDb({ schema, driver: someDriver(client) });   // no url needed
```

Built-in drivers:

| Database  | Default driver                            | Built-in alternatives                                                                 |
| --------- | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| SQLite    | `betterSqlite3Driver` (`better-sqlite3`)  | `expoSqliteDriver` (Expo/RN), `opSqliteDriver` (bare RN), `libsqlDriver` (libsql/Turso/edge), `wasmSqliteDriver` (browser + OPFS), `tauriSqlDriver` (`@tauri-apps/plugin-sql` — Tauri 2 desktop + mobile) |
| Postgres  | `pgDriver` (`pg`)                          | `postgresJsDriver` (`postgres.js`)                                                     |
| MySQL     | `mysql2Driver` (`mysql2`)                  | `mariadbDriver` (MariaDB connector), `planetscaleDriver` (`@planetscale/database`)     |
| MongoDB   | built-in `mongodb` client                 | `mongoDriver(client)` — your own `MongoClient` (DocumentDB, Cosmos, FerretDB, custom)  |
| DuckDB    | `duckdbDriver` (`@duckdb/node-api`)       | —                                                                                      |
| MSSQL     | `mssqlDriver` (`mssql`)                   | —                                                                                      |

```ts
// SQLite on Expo / React Native
import * as SQLite from 'expo-sqlite';
import { createDb, expoSqliteDriver } from 'forge-orm';
const db = await createDb({ schema, driver: expoSqliteDriver(SQLite.openDatabaseSync('app.db')) });

// SQLite on the edge / Turso
import { createClient } from '@libsql/client';
import { createDb, libsqlDriver } from 'forge-orm';
const db = await createDb({ schema, driver: libsqlDriver(createClient({ url: process.env.TURSO_URL! })) });

// SQLite in the browser — sqlite-wasm + OPFS in a Web Worker.
// Full chapter at "Browser (sqlite-wasm + OPFS)" below.
import { createDb, wasmSqliteDriver } from 'forge-orm';
const worker = new Worker(new URL('forge-orm/wasm/worker', import.meta.url), { type: 'module' });
const db = await createDb({ schema, driver: wasmSqliteDriver({ worker, url: 'opfs-sahpool:///app.sqlite' }) });

// SQLite in a Tauri 2 app — @tauri-apps/plugin-sql (sqlx on Rust side).
import Database from '@tauri-apps/plugin-sql';
import { createDb, tauriSqlDriver } from 'forge-orm';
const sqlite = await Database.load('sqlite:app.db');
const db = await createDb({ schema, driver: tauriSqlDriver(sqlite) });
await db.$migrate();  // runtime DDL on first boot
await db.$migrate();   // runtime DDL apply (browser replacement for `forge push`)

// Postgres via postgres.js
import postgres from 'postgres';
import { createDb, postgresJsDriver } from 'forge-orm';
const db = await createDb({ schema, driver: postgresJsDriver(postgres(process.env.DATABASE_URL!)) });

// MySQL via the MariaDB connector (pass bigIntAsNumber/insertIdAsNumber for mysql2 parity)
import mariadb from 'mariadb';
import { createDb, mariadbDriver } from 'forge-orm';
const pool = mariadb.createPool({ host, user, database, bigIntAsNumber: true, insertIdAsNumber: true });
const db = await createDb({ schema, driver: mariadbDriver(pool) });

// MongoDB with your own client (custom TLS/auth/pool options, a shared client,
// or a Mongo-API backend: Amazon DocumentDB, Azure Cosmos DB, FerretDB)
import { MongoClient } from 'mongodb';
import { createDb, mongoDriver } from 'forge-orm';
const db = await createDb({ schema, driver: mongoDriver(new MongoClient(uri, { tls: true }), 'mydb') });

// DuckDB (embedded analytics — auto-loads the `spatial` extension at connect)
import { DuckDBInstance } from '@duckdb/node-api';
import { createDb, duckdbDriver } from 'forge-orm';
const instance = await DuckDBInstance.create('analytics.duckdb');
const connection = await instance.connect();
const db = await createDb({ schema, driver: duckdbDriver(connection) });

// SQL Server (Linux / Windows; ARM Macs auto-swap to azure-sql-edge in tests)
import sql from 'mssql';
import { createDb, mssqlDriver } from 'forge-orm';
const pool = await sql.connect({ server: 'localhost', user: 'sa', password: '…', database: 'app' });
const db = await createDb({ schema, driver: mssqlDriver(pool) });
```

Each port is a small interface, so any other client fits too:

* **SQLite** (`SqliteDriver`) — `all`, `get`, `run`, `exec`, `close`, optional `iterate`.
* **Postgres** (`PostgresDriver`) / **MySQL** (`MysqlDriver`) — `query` + `transaction` + `close`, optional `stream`.
* **MongoDB** (`MongoDriver`) — a pre-built `MongoClient` (plus an optional database name).
* **DuckDB** (`DuckdbDriver`) — `run` / `all` over the `@duckdb/node-api` connection.
* **MSSQL** (`MssqlDriver`) — `query` + `transaction` over a `mssql` pool.

One caveat: `forge push` / `applyMigration` (DDL) still assume each database's
**default** driver. With an injected driver, run runtime queries through forge
and manage schema/DDL with the default client (or separately).

### Browser (zero install) — IndexedDB

The IndexedDB adapter is forge's zero-install browser tier. Every browser has
IndexedDB natively, so there's no wasm to download, no worker file to bundle,
no COOP / COEP headers to set. Trade native SQL power for zero install:

```ts
import { createDb } from 'forge-orm';

const db = await createDb({ url: 'idb:appname', schema });
await db.user.create({ data: { email: 'a@x.co', name: 'Alice' } });
```

The full Prisma-shape API works — reads, writes, relations, sorts, paging,
aggregations, JSON path queries, geo `near` / `withinPolygon`, vector `near`
/ `nearTo`, full-text `search`, upsert, soft-delete + restore, `.compile`,
`$transaction`, `$migrate`, `$doctor`, `$diff`.

The tradeoff vs sqlite-wasm:

| | sqlite-wasm | IndexedDB |
|---|---|---|
| Bundle cost | ~1 MB wasm + worker | zero |
| Query engine | real SQL | IR → cursor scan + JS predicate |
| Vector | native (sqlite-vec HNSW) | brute-force JS (< 1 k rows) |
| Geo | native (R-Tree via SpatiaLite) | Haversine JS + bbox prefilter |
| FTS | FTS5 with BM25 | multiEntry token index, AND-of-tokens |
| Multi-tab | needs SAHPool VFS | native |

Both adapters read the same schema and take the same query calls, so swapping
between them is a URL change.

Deep dive: **[docs/INDEXEDDB.md](docs/INDEXEDDB.md)**.

### Wire-compatible databases (no new code needed)

Several databases speak the wire protocol of one of the six forge supports.
They work today through the matching adapter — point the existing driver at
them:

| Database | Adapter | How |
|---|---|---|
| **CockroachDB** | postgres | `pg` or `postgresJsDriver` against the CockroachDB URL |
| **YugabyteDB** | postgres | `pg` or `postgresJsDriver` |
| **Neon** | postgres | `pg` or `@neondatabase/serverless` wrapped in a `PostgresDriver` port |
| **Supabase** | postgres | `pg` against the Supabase URL |
| **TimescaleDB** | postgres | `pg` (TimescaleDB is a Postgres extension) |
| **TiDB** | mysql | `mysql2Driver` |
| **PlanetScale** | mysql | `planetscaleDriver` — built in |
| **AWS DocumentDB** | mongo | `mongoDriver(new MongoClient(documentDbUri), dbName)` |
| **Azure Cosmos DB (Mongo API)** | mongo | `mongoDriver(new MongoClient(cosmosUri), dbName)` |
| **FerretDB** | mongo | `mongoDriver(new MongoClient(ferretUri), dbName)` |
| **Turso** | sqlite | `libsqlDriver` — built in |
| **Cloudflare D1** | sqlite | Wrap the D1 client in a thin `SqliteDriver` port (`all`/`get`/`run`/`exec`) |
| **MotherDuck** | duckdb | `duckdbDriver` against the MotherDuck token URL |
| **Azure SQL Database** | mssql | `mssqlDriver` against the Azure SQL URL |
| **Azure SQL Edge** | mssql | `mssqlDriver` — used as the ARM-Mac test fallback for SQL Server 2022 |

If your database isn't on the list and doesn't speak one of the six wire
protocols, the answer is "implement the matching port interface" — same
~5-method surface every built-in driver implements.

### Coming soon

| Item | Status | Target |
|---|---|---|
| **3D distance mode** | `f.geoPoint({ dims: 3 })` round-trips altitude end-to-end; `near` / `nearTo` still compute ground (2D-on-sphere) distance. A 3D Euclidean or ground+vertical distance mode is the open question. | TBD |
| **Auto SRID reprojection** | Declared SRID is honoured at DDL time; the user provides coordinates in the target SRID's units. A built-in `proj4`-backed transform at the IR boundary is on the roadmap (avoids the per-app coordinate-transform boilerplate). | TBD |
| **Pre-built `@forge-orm/sqlite-wasm-pro`** | The custom wasm bundle (R-Tree + sqlite-vec) is one Emscripten command via `scripts/wasm-pro/build.sh` today; publishing the pre-built artifact as its own npm package is the next gap. | TBD |

If you need another database, file an issue. The bar to add a new adapter is
~10 small files: `dialect`, `driver`, `ddl`, `compile-from-ir`, `execute`,
`introspect`, `migrate`, `adapter`, plus a few registration touches.

---

## Defining a schema

A schema is a plain object mapping a name to a model. You build models with the
helpers exported from `forge-orm`: `f` (fields), `model`, `rel` (relations),
`enums`, and `embed`.

```ts
import { f, model, rel } from 'forge-orm';

const User = model('users', {
  id:         f.id(),
  email:      f.string().unique(),
  name:       f.string(),
  active:     f.bool().default(true),
  created_at: f.dateTime().default('now'),
  updated_at: f.dateTime().default('now').updatedAt(),
}).relate(() => ({
  posts: rel.many('post', { on: 'author_id', refs: 'id' }),
}));

const Post = model('posts', {
  id:        f.id(),
  author_id: f.objectId(),
  title:     f.string(),
  body:      f.text(),
}).relate(() => ({
  author: rel.one('user', { on: 'author_id', refs: 'id', onDelete: 'Cascade' }),
}));

export const schema = { user: User, post: Post } as const;
```

`as const` on the schema object is **defensive, not required**. For the
pattern shown above — each model bound to its own `const`, then referenced
from the schema literal — TypeScript already preserves the model types and
the literal keys, so `db.user.findFirst({ where: { … } })` autocompletes
either way.

### Models and automatic values (id, timestamps)

`model(tableName, fields)` declares a table (or a Mongo collection). The first
argument is the real table name in the database; the object key you give it in
the schema (`user`, `post`) is what you type as `db.user`.

forge fills in three kinds of value for you so you don't have to:

**Primary key (`f.id()`).** Every model has one. When you create a row without
passing an `id`, forge generates one automatically on **every** database:

```ts
await db.user.create({ data: { email: 'a@x.co', name: 'A' } });  // id is generated
```

The default id is a **string**: an `ObjectId` on Mongo, and a UUID on
Postgres, MySQL, SQLite, DuckDB, and MSSQL. It's a string (not a sequential
number) so the same model is portable across all six databases. You can
still pass your own `id` if you want to control it, and you can let the
database generate it instead with a UUID default:

```ts
id: f.uuid({ default: 'gen_random_uuid' })   // Postgres/MySQL fill it in server-side
```

**Created-at (`f.dateTime().default('now')`).** Set to the current time when the
row is created. You never pass it.

**Updated-at (`f.dateTime().default('now').updatedAt()`).** Set when the row is
created and **automatically bumped to the current time on every update**, on all
six databases. You never pass it.

```ts
const post = await db.post.create({ data: { title: 'Hi' } });
// post.created_at and post.updated_at are both set

await db.post.update({ where: { id: post.id }, data: { title: 'Hello' } });
// updated_at is now refreshed automatically
```

`f.objectId()` is for a column that holds another row's id (a foreign key). On
Mongo it stores an `ObjectId`; on SQL it is plain text.

### Picking a primary-key strategy

If you want something other than the default, pass `f.id({ type })`:

```ts
id: f.id()                            // default — app-generated string id (string in TS)
id: f.id({ type: 'auto' })            // same as the default; explicit form
id: f.id({ type: 'uuid' })            // DB-typed UUID column (PG `uuid`, MySQL `CHAR(36)`)
id: f.id({ type: 'bigserial' })       // auto-incrementing integer PK — number in TS
id: f.id({ type: 'string' })          // YOU supply it — nothing is generated
```

What each one emits per dialect:

| Strategy     | Postgres                       | MySQL                              | SQLite                                  | DuckDB / MSSQL | Mongo            | JS type  |
| ------------ | ------------------------------ | ---------------------------------- | --------------------------------------- | -------------- | ---------------- | -------- |
| `auto` (default) | `text`                     | `VARCHAR(64)`                      | `TEXT`                                  | `TEXT` / `NVARCHAR(64)` | `ObjectId`       | `string` |
| `uuid`       | `uuid`                         | `CHAR(36)`                         | `TEXT`                                  | (same as `auto`) | (same as `auto`) | `string` |
| `bigserial`  | `BIGSERIAL`                    | `BIGINT NOT NULL AUTO_INCREMENT`   | `INTEGER PRIMARY KEY AUTOINCREMENT`     | `BIGINT … IDENTITY` (MSSQL) | **throws at push** | `number` |
| `string`     | `text`                         | `VARCHAR(255)`                     | `TEXT`                                  | (same as `auto`) | stored verbatim  | `string` |

`string` (2.8.0) is the one you assign yourself. Use it for a **natural
key** — a row whose identity is its content, so one upsert is atomic on
one document:

```ts
// "<orgId>:<series>" — one row per counter, incremented in a single write.
export const NumberSequence = model('number_sequences', {
  id: f.id({ type: 'string' }),
  seq: f.int().default(0),
});
```

On Mongo the value is stored verbatim and never coerced to an ObjectId —
a 24-hex natural key would otherwise be rewritten and every lookup would
miss. See [PRIMARY-KEYS.md](./docs/PRIMARY-KEYS.md).

`bigserial` is the SQL-only opt-in. Forge runs `forge push` on Mongo with a
clear error if you use it (`'bigserial' has no Mongo equivalent`), so a
schema mistake fails fast instead of half-applying. Use it when you're
running a SQL-only service and you want classic integer keys; stay on
`auto` or `uuid` for cross-DB portability.

With `bigserial`, the DB assigns the id — you don't pass one at create time,
and `Row<typeof Model>['id']` is typed as `number`:

```ts
const Order = model('orders', {
  id:     f.id({ type: 'bigserial' }),
  total:  f.int(),
});

const o = await db.order.create({ data: { total: 5_000 } });
o.id;          // ✓ number — TypeScript knows
await db.order.findFirst({ where: { id: 47 } });
```

Adding `bigserial` to an existing table? `forge diff` shows you the column
change before you push, and `forge diff apply` writes a timestamped
reconciliation migration if you'd rather review the SQL first.

### Field types

Every field builder. Chain modifiers (`.optional()`, `.unique()`, `.default(…)`,
`.searchable()`, `.softDeleteAt()`, `.dbgenerated(…)`, `.updatedAt()`) onto any
of them.

| Builder                              | TS type                          | Storage per dialect / notes                                                                 |
| ------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------- |
| `f.id()`                             | `string`                         | Primary key, auto-generated when omitted. Pass `{ type: 'auto' \| 'uuid' \| 'bigserial' }`. |
| `f.objectId()`                       | `string`                         | Foreign-key style. Mongo `ObjectId`; SQL `TEXT`.                                            |
| `f.string()`                         | `string`                         | Short text. MySQL `VARCHAR(255)` (indexable). PG/SQLite/DuckDB `TEXT`, MSSQL `NVARCHAR(255)`. |
| `f.text()`                           | `string`                         | Long text. MySQL `TEXT`. PG `text`, MSSQL `NVARCHAR(MAX)`, DuckDB `TEXT`.                   |
| `f.int()`                            | `number`                         | 32-bit integer.                                                                             |
| `f.float()`                          | `number`                         | Floating point.                                                                             |
| `f.decimal({ precision, scale })`    | `string`                         | Exact numerics (money). PG `numeric(p,s)` / MySQL `DECIMAL(p,s)` / SQLite `NUMERIC` / Mongo `Decimal128`. Returned as a string to avoid float-precision loss. |
| `f.bigint()`                         | `bigint`                         | 64-bit integer. Use `1n` literals. PG `bigint` / MySQL `BIGINT` / SQLite `INTEGER` / Mongo `Long`. |
| `f.uuid({ default? })`               | `string`                         | UUID. Pass `{ default: 'gen_random_uuid' }` for a server-side default on PG / MySQL.        |
| `f.bool()`                           | `boolean`                        | Stored as 0/1 on MySQL and SQLite, decoded back to a boolean.                               |
| `f.dateTime()`                       | `Date`                           | Timestamp. Accepts a `Date` or an ISO string on input.                                      |
| `f.json()`                           | `any`                            | Arbitrary JSON. `jsonb` on Postgres, `JSON` on MySQL / MSSQL, `TEXT` on SQLite.             |
| `f.enumOf(['A','B'] as const)`       | `'A' \| 'B'`                     | A fixed set of string values, checked by the database where supported.                     |
| `f.embed(Shape)`                     | `Shape`                          | One nested object. Stored as JSON on SQL, sub-document on Mongo.                            |
| `f.embedMany(Shape)`                 | `Shape[]`                        | A list of nested objects. Defaults to `[]`.                                                 |
| `f.stringArray()` / `f.intArray()`   | `string[]` / `number[]`          | A list of scalars. Native array on Postgres, JSON elsewhere.                                |
| **`f.geoPoint({ srid?, fallback? })`** | **`{ lng: number; lat: number }`** | **2D geographic point (WGS84 / SRID 4326). PG `geography(Point, 4326)` (PostGIS) / MySQL `POINT NOT NULL SRID 4326` / SpatiaLite geometry / DuckDB `GEOMETRY` (spatial) / MSSQL `GEOGRAPHY` / Mongo GeoJSON. Pair with `method: 'spatial'`. `fallback: true` stores JSON + Haversine post-filter when no extension is installed.** |
| **`f.vector(dims, { metric? })`**    | **`number[]`**                    | **Dense numeric vector for embeddings / semantic search. PG `vector(N)` (pgvector) / MySQL `VECTOR(N)` (9.0+) / SQLite JSON+`sqlite-vec` / DuckDB `FLOAT[N]` (vss HNSW) / MSSQL `VECTOR(N)` (2025+) / Mongo plain array + Atlas Vector Search. `metric` is `'cosine'` (default), `'l2'`, or `'dot'`. Pair with `method: 'vector'`.** |

### Field modifiers

Chain these onto any field builder. Modifiers are immutable — they return a
new `Field` with the modifier applied.

| Modifier                            | What it does                                                                                          | Notes / dialect quirks                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `.optional()`                       | Allows `null`. The TS type becomes `T \| null`.                                                       | Maps to `NULL` in SQL DDL, no required-presence check on Mongo.                 |
| `.unique()`                         | Adds a unique index on the column.                                                                    | Sparse-on-optional is automatic on Mongo.                                       |
| `.default(value)`                   | Static default applied at create when no value is passed.                                              | The `value` is literal — strings, numbers, booleans, objects, arrays.           |
| `.default('now')`                   | Current timestamp at create. Use on `f.dateTime()`.                                                    | Drives the `created_at` pattern.                                                |
| `.default('autoId')`                | Server-generated id (used internally by `f.id()`).                                                     | Rarely needed by hand.                                                          |
| `.updatedAt()`                      | Auto-bumped to the current time on every update.                                                       | Combine with `.default('now')` for the canonical `updated_at`.                  |
| `.searchable()`                     | Tells `forge push` to build the right full-text index for this column (see [Full-text search](#full-text-search)). | Postgres `GIN` tsvector, MySQL `FULLTEXT`, SQLite `FTS5` shadow table + triggers, Mongo `text`, DuckDB `fts`. MSSQL: out-of-band (manual `FULLTEXT CATALOG`). |
| `.softDeleteAt()`                   | Marks this `f.dateTime()` column as the soft-delete column (see [Soft delete](#soft-delete)).         | Forces optional. Reads auto-filter `WHERE col IS NULL`. One per model.          |
| `.dbgenerated('expr')`              | Database-computed column. The wrapper never writes it; the DB evaluates `<expr>` on every change.     | PG / MySQL emit `GENERATED ALWAYS AS (<expr>) STORED`; SQLite uses the same shape; Mongo warns and skips. |

```ts
f.string().optional()                                       // value can be null
f.string().unique()                                         // unique index on this column
f.string().default('pending')                               // static default
f.bool().default(true)                                      // bool default
f.dateTime().default('now')                                 // created-at
f.dateTime().default('now').updatedAt()                     // updated-at (set on create AND auto-bumped on update)
f.text().searchable()                                       // build a full-text index
f.dateTime().softDeleteAt()                                 // mark as the soft-delete column
f.decimal({ precision: 12, scale: 2 })
  .dbgenerated('"price" * "qty"')                           // computed by the DB
```

### Indexes and unique constraints

Pass an options object as the third argument to `model`. The same `IndexDef`
shape carries every common production index family — partial, expression,
covering, geospatial, vector, hashed, wildcard, full-text, and more. Each
field that doesn't apply on a given dialect is dropped at push with a clear
warning, so one schema can target Mongo and SQL.

```ts
const Post = model('posts', {
  id:        f.id(),
  author_id: f.objectId(),
  slug:      f.string().unique(),     // single-column unique
  status:    f.enumOf(['DRAFT', 'PUBLISHED'] as const),
}, {
  indexes: [{ keys: { author_id: 1, status: 1 } }],   // a two-column index
  uniques: [['author_id', 'slug']],                   // a combined unique
});
```

The full index vocabulary:

```ts
indexes: [
  // Partial index. Mongo uses partialFilterExpression; Postgres and SQLite
  // use `where` with a raw SQL string. The same entry can carry both so
  // the schema works on either side.
  { keys: { sku: 1 }, unique: true,
    where: 'deleted_at IS NULL',
    partialFilterExpression: { deleted_at: { $exists: false } } },

  // TTL (Mongo).
  { keys: { createdAt: 1 }, expireAfterSeconds: 60 * 60 * 24 },

  // Mongo geospatial — `$near` / `$geoWithin` queries need this.
  { keys: { location: '2dsphere' } },

  // Spatial index — portable across dialects. Forge resolves the right
  // native family per dialect (PostGIS GIST, MySQL SPATIAL, DuckDB RTREE,
  // MSSQL CREATE SPATIAL INDEX, Mongo 2dsphere, SQLite virtual rtree).
  // Pair with f.geoPoint().
  { keys: { location: 1 }, method: 'spatial' },

  // Vector index — pgvector HNSW / DuckDB vss HNSW / MSSQL VECTOR HNSW.
  // Mongo and SQLite log a clean warning (their vector index is created
  // out-of-band). Pair with f.vector(N, { metric }).
  { keys: { embedding: 1 }, method: 'vector' },

  // Mongo hashed — required for a hashed shard key.
  { keys: { tenant: 'hashed' } },

  // Mongo case-insensitive unique. strength: 2 = case-insensitive.
  { keys: { email: 1 }, unique: true,
    collation: { locale: 'en', strength: 2 } },

  // Mongo wildcard index — keys: { '$**': 1 } + wildcardProjection.
  { keys: { '$**': 1 } as any, wildcardProjection: { 'data.$**': 1 } },

  // Postgres GIN over a jsonb column — supports @> containment.
  { keys: { tags: 1 }, method: 'gin' },

  // Postgres covering — answers (customer_id) → (status, total) from the index.
  { keys: { customer_id: 1 }, include: ['status', 'total'] },

  // Postgres BRIN for huge append-only tables (logs, analytics).
  { keys: { received_at: 1 }, method: 'brin' },

  // Expression index. Postgres / MySQL 8+ / SQLite. Mongo skips with a warning.
  { keys: {}, expression: 'lower(email)' },

  // MySQL fulltext with parser plugin — `'ngram'` for CJK, `'mecab'` for Japanese.
  { keys: { body: 1 }, method: 'fulltext', parser: 'ngram' },

  // MySQL 8+ invisible index — the optimizer ignores it,
  // useful for canary-testing whether an index is load-bearing before drop.
  { keys: { obsolete: 1 }, visible: false },

  // MySQL 8+ multi-valued index on a JSON array column — index every element
  // of the array. Use `expression` with the CAST that MySQL requires.
  { keys: {}, expression: "(CAST(tags->'$[*]' AS UNSIGNED ARRAY))" },
]
```

What each field does, per dialect:

| Field                              | Mongo                | Postgres            | MySQL               | SQLite              | DuckDB              | MSSQL               |
|------------------------------------|----------------------|---------------------|---------------------|---------------------|---------------------|---------------------|
| `keys: { col: 1 / -1 }`            | yes                  | yes                 | yes                 | yes                 | yes                 | yes                 |
| `keys: { col: 'text' }`            | text index           | `text_pattern_ops`  | column kept         | column kept         | column kept         | column kept         |
| `keys: { col: '2dsphere'/'2d'/'hashed' }` | yes           | ignored             | ignored             | ignored             | ignored             | ignored             |
| `unique` / `sparse`                | yes                  | yes (sparse auto on optional) | yes/n/a   | yes/n/a             | yes/n/a             | yes/n/a             |
| `expireAfterSeconds`               | yes                  | n/a                 | n/a                 | n/a                 | n/a                 | n/a                 |
| `partialFilterExpression`          | yes                  | n/a                 | n/a                 | n/a                 | n/a                 | n/a                 |
| `where` (object)                   | alias of PFE         | translated to SQL   | warn + skip         | translated to SQL   | warn + skip         | translated to SQL   |
| `where` (SQL string)               | n/a                  | `WHERE …`           | warn + skip         | `WHERE …`           | warn + skip         | `WHERE …`           |
| `include: [cols]`                  | n/a                  | `INCLUDE (…)`       | warn + skip         | warn + skip         | warn + skip         | `INCLUDE (…)`       |
| `expression: 'sql'`                | warn + skip          | `((expr))`          | `((expr))`          | `(expr)`            | `((expr))`          | warn + skip         |
| `method: gin/gist/brin/hash`       | n/a                  | `USING …`           | warn (ignored)      | warn (ignored)      | warn (ignored)      | warn (ignored)      |
| `method: 'spatial'`                | resolves to 2dsphere | `USING GIST`        | `SPATIAL INDEX`     | virtual rtree       | `USING RTREE`       | `CREATE SPATIAL INDEX` |
| `method: 'vector'`                 | warn (Atlas search)  | `USING hnsw (... opclass)` | warn (community = exact) | warn (use sqlite-vec) | `USING HNSW`     | `USING VECTOR WITH (algorithm='HNSW')` |
| `method: 'fulltext'`               | n/a                  | DB rejects          | statement prefix    | warn (ignored)      | n/a                 | warn (ignored)      |
| `parser: 'ngram'/'mecab'`          | n/a                  | warn (ignored)      | `WITH PARSER …` (only on fulltext) | warn (ignored) | warn (ignored) | warn (ignored)      |
| `visible: false`                   | n/a                  | warn (ignored)      | `INVISIBLE` (MySQL 8) | warn (ignored)    | warn (ignored)      | warn (ignored)      |
| `collation`                        | yes                  | n/a (use expression)| n/a                 | n/a                 | n/a                 | n/a                 |
| `wildcardProjection`               | yes                  | n/a                 | n/a                 | n/a                 | n/a                 | n/a                 |

### Relations

A relation says "this model points at that model." You declare it with
`.relate()`, which takes a function returning a map of relation names. There are
two kinds:

* `rel.one(target, { on, refs })` is the side that **holds the foreign key**.
  For example a post has one author, and the post row stores `author_id`.
* `rel.many(target, { on, refs })` is the **other side**, a list. A user has
  many posts. Nothing is stored on the user row; forge looks posts up by their
  `author_id`.

The options mean:

* `target` is the **key in your schema map** of the model you are pointing at
  (`'user'`, not the table name `'users'`).
* `on` is the column that holds the foreign key value.
* `refs` is the column it points to on the other model (usually `'id'`).
* `onDelete` (one-side only) controls what happens to this row when the row it
  points to is deleted: `'Cascade'` (delete this too), `'SetNull'` (clear the
  foreign key), `'Restrict'`, or `'NoAction'`.

```ts
const User = model('users', { id: f.id(), name: f.string() })
  .relate(() => ({
    posts: rel.many('post', { on: 'author_id', refs: 'id' }),
  }));

const Post = model('posts', { id: f.id(), author_id: f.objectId(), title: f.string() })
  .relate(() => ({
    author: rel.one('user', { on: 'author_id', refs: 'id', onDelete: 'Cascade' }),
  }));
```

A model can point at itself, which is how you build trees such as comment
replies:

```ts
const Comment = model('comments', { id: f.id(), parent_id: f.objectId().optional() })
  .relate(() => ({
    parent:  rel.one('comment',  { on: 'parent_id', refs: 'id' }),
    replies: rel.many('comment', { on: 'parent_id', refs: 'id' }),
  }));
```

Once a relation exists you can load it with `include` (see
[Choosing fields](#choosing-fields-select-and-include)) and write related rows
in one call (see [Writing related records](#writing-related-records-in-one-call)).

### Embedded objects

An embedded object is a fixed shape stored inside a row, as JSON on SQL
databases and as a sub-document on Mongo. Use `embed` to declare the shape.

```ts
import { embed, f, model } from 'forge-orm';

const Address = () => embed('Address', {
  street: f.string(),
  city:   f.string(),
  zip:    f.string(),
});

const User = model('users', {
  id:      f.id(),
  name:    f.string(),
  address: f.embed(Address).optional(),       // one address
  history: f.embedMany(Address),              // a list, defaults to []
});

await db.user.create({ data: { name: 'A', address: { street: '1 Main', city: 'SF', zip: '94110' } } });
```

You can read into embedded fields with [JSON path queries](#json-path-queries):

```ts
await db.user.findMany({
  where: { address: { path: 'city', eq: 'SF' } },
});
```

See more — **[docs/MODEL.md](docs/MODEL.md)** (full field catalogue + id strategies + views + generated columns), **[docs/EMBED.md](docs/EMBED.md)** (`f.embed`/`f.embedMany`/`f.json` + JSON-null markers + 5 worked patterns), **[docs/RELATIONS.md](docs/RELATIONS.md)** (relation shapes + cascade + deep includes + 6 worked patterns), **[docs/INDEXES.md](docs/INDEXES.md)** (every `IndexDef` field + per-dialect emit + drift detection), **[docs/PRIMARY-KEYS.md](docs/PRIMARY-KEYS.md)** (UUIDv7 / ULID / Snowflake / serial trade-offs), **[docs/FOREIGN-KEYS.md](docs/FOREIGN-KEYS.md)** (onDelete / onUpdate / deferred), **[docs/ENUMS.md](docs/ENUMS.md)** (per-dialect emit + evolution), **[docs/CHECKS.md](docs/CHECKS.md)** (CHECK constraints + Mongo `$jsonSchema`), **[docs/GENERATED-COLUMNS.md](docs/GENERATED-COLUMNS.md)** (STORED vs VIRTUAL), **[docs/VIEWS.md](docs/VIEWS.md)** and **[docs/MATERIALIZED-VIEWS.md](docs/MATERIALIZED-VIEWS.md)**, **[docs/TRIGGERS.md](docs/TRIGGERS.md)** (DB-side procedural code).

---

## Reading data

Every model has the read methods you expect.

```ts
await db.user.findMany({ where: { active: true }, take: 20 });
await db.user.findFirst({ where: { email: 'a@x.co' } });          // first match or null
await db.user.findUnique({ where: { id: 'u1' } });                 // by a unique field
await db.user.findFirstOrThrow({ where: { email: 'a@x.co' } });    // throws if missing
await db.user.findUniqueOrThrow({ where: { id: 'u1' } });          // throws if missing
await db.user.count({ where: { active: true } });
await db.user.aggregate({                                          // bucketed stats
  where: { active: true },
  _avg:  { age: true },
  _sum:  { credits: true },
});
```

### Filtering with `where`

`where` accepts either a direct value or an operator object per field, plus
`AND`, `OR`, and `NOT`.

```ts
await db.post.findMany({
  where: {
    status: 'PUBLISHED',                       // equals
    title:  { contains: 'forge' },             // text match
    views:  { gte: 100, lt: 1000 },            // ranges
    author_id: { in: ['u1', 'u2'] },           // any of
    OR: [
      { pinned: true },
      { created_at: { gt: new Date('2024-01-01') } },
    ],
  },
});
```

### Operator reference

All operators, with the field kinds they apply to.

| Operator        | Applies to                              | Meaning                                                                 |
| --------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `equals` / `=`  | every field                             | exact match (same as passing a value directly)                          |
| `not`           | every field                             | inverse of `equals` (accepts a value or a nested filter)                |
| `in`            | every field                             | value is one of an array                                                |
| `notIn`         | every field                             | value is not in an array                                                |
| `lt` / `lte` / `gt` / `gte` | numbers, dates, strings    | range comparisons                                                       |
| `contains`      | strings                                 | substring match (`LIKE %x%`)                                            |
| `startsWith`    | strings                                 | prefix match (`LIKE x%`)                                                |
| `endsWith`      | strings                                 | suffix match (`LIKE %x`)                                                |
| `mode: 'insensitive'` | strings                           | case-insensitive variant of the text operators                          |
| `has`           | `stringArray` / `intArray` / `embedMany` | the list contains the given value                                       |
| `hasEvery`      | array fields                             | the list contains all of the given values                               |
| `hasSome`       | array fields                             | the list contains at least one of the given values                      |
| `isEmpty`       | array fields                             | `length === 0`                                                          |
| `some` / `every` / `none` | `embedMany` / relations         | quantified filter on the nested rows                                    |
| `search`        | `f.text().searchable()` columns         | full-text search (see [Full-text search](#full-text-search))            |
| `path` + sub-op | `f.json()` / `f.embed()` / `f.embedMany()` / arrays | typed JSON path read (see [JSON path queries](#json-path-queries)) |
| dotted key (`'address.city'`) | `f.json()` / `f.embed()` / `f.embedMany()` / arrays | shorthand for a `path` filter — `{ 'address.city': 'sf' }`, `{ 'meta.stats.views': { gte: 10 } }`. Compiles portably on every dialect; strict mode validates embed sub-fields |
| `near`          | `f.geoPoint()` / `f.vector()`            | within distance (see [Geo](#geo-geopoint-near-nearto-withinpolygon) / [Vector](#vector-similarity-search)) |
| `withinPolygon` | `f.geoPoint()`                          | point lies inside a polygon                                             |
| `AND` / `OR` / `NOT` | top level                          | boolean combinators (accept arrays or single objects)                   |

An operator forge doesn't recognise **throws** (since 2.7) rather than being
dropped — a dropped condition means the filter silently matches every row.
The error names the column and suggests the fix, so `$gte` says "use `gte`"
and `contians` says "did you mean `contains`".

### Comparing two columns: `col()`

Use `col('otherField')` on the right-hand side of `equals`/`not`/`lt`/`lte`/
`gt`/`gte` to compare one column against another column **of the same row**,
instead of against a literal. It works the same on every dialect — Mongo
compiles it to `$expr`, SQL to a plain `a <op> b`.

```ts
import { col } from 'forge-orm';

// promos still under their global cap
await db.promo.findMany({
  where: { currentUsage: { lt: col('globalLimit') } },
});

// the canonical use: an atomic, race-safe guarded counter
await db.promo.update({
  where: { id, currentUsage: { lt: col('globalLimit') } },   // only if room remains
  data:  { currentUsage: { increment: 1 } },                 // single atomic write
});
```

`col()` only accepts the six comparison operators, and the referenced field
must be a real scalar column (a typo or relation name throws at build time).

### Choosing fields: `select` and `include`

By default a query returns all of a model's own columns. To change that, use one
of these (you may use one or the other, not both at once):

* `select` returns **only** the fields you list. The result type narrows to match.
* `include` returns all columns **plus** the related records you ask for.

```ts
// only these two fields come back
const slim = await db.user.findMany({ select: { id: true, email: true } });

// the user plus their posts, and each post's comments
const full = await db.user.findFirst({
  where:   { id: 'u1' },
  include: { posts: { include: { comments: true } } },
});

// you can filter and limit an included relation
await db.user.findFirst({
  include: { posts: { where: { status: 'PUBLISHED' }, orderBy: { created_at: 'desc' }, take: 5 } },
});

// _count returns relation cardinalities
await db.user.findMany({ include: { _count: { select: { posts: true, comments: true } } } });
// → user.{_count: { posts: 5, comments: 12 }}
```

### Sorting and pagination

```ts
await db.post.findMany({
  where:   { status: 'PUBLISHED' },
  orderBy: { created_at: 'desc' },     // or an array for multiple keys
  take:    20,                          // page size
  skip:    40,                          // offset
});

// cursor pagination, for stable paging over large sets
await db.post.findMany({ take: 20, cursor: { id: lastSeenId }, skip: 1 });
```

See more — **[docs/QUERIES.md](docs/QUERIES.md)** for every operator with per-dialect SQL/Mongo emit, cursor pagination, distinct, streaming internals, common bugs, and eight worked queries. **[docs/AGGREGATIONS.md](docs/AGGREGATIONS.md)** for count/sum/avg/groupBy/having dashboards. **[docs/WINDOWS.md](docs/WINDOWS.md)** for ROW_NUMBER / LAG / LEAD / moving averages / sessionization. **[docs/PAGINATION.md](docs/PAGINATION.md)** for cursor vs offset vs keyset and Relay/REST response shapes. **[docs/STREAMING.md](docs/STREAMING.md)** for `findManyStream` internals per driver. **[docs/N-PLUS-ONE.md](docs/N-PLUS-ONE.md)** for the canonical query-explosion prevention patterns.

---

## Writing data

```ts
await db.user.create({ data: { email: 'a@x.co', name: 'A' } });   // id auto-generated

await db.user.createMany({ data: [ /* … */ ] });

await db.user.update({ where: { id: 'u1' }, data: { name: 'A2' } });

await db.user.updateMany({ where: { active: false }, data: { active: true } });

// update if found, otherwise create
await db.user.upsert({
  where:  { email: 'a@x.co' },
  create: { email: 'a@x.co', name: 'A' },
  update: { name: 'A' },
});

await db.user.delete({ where: { id: 'u1' } });
await db.user.deleteMany({ where: { active: false } });
```

Create and update can also return only selected fields or include relations,
the same way reads do, by passing `select` or `include` alongside `data`.

### Atomic number ops

For number columns you can apply an operation instead of setting a value
outright. All four are compiled to a single atomic write per dialect.

```ts
await db.post.update({
  where: { id: 'p1' },
  data: {
    views:     { increment: 1 },     // also: decrement, multiply, divide, set
    score:     { multiply: 2 },
    rank:      { divide: 2 },
    published: true,
  },
});
```

Pair an atomic op with `col()` in `where` for a single-statement, race-safe
guard (see [Comparing two columns](#comparing-two-columns-col)).

Operator objects are validated against the column (since 2.7): a typo like
`{ incrment: 5 }`, a numeric op on a string column, or two ops in one
object (`{ set: 1, increment: 2 }`) throws instead of silently writing the
object into the field.

For an atomic **seeded counter**, upsert with an increment — insert applies
`create` only, update applies `update` only (Prisma semantics, race-safe):

```ts
const row = await db.counter.upsert({
  where:  { key: 'invoice-number' },
  create: { key: 'invoice-number', seq: 1000 },   // first call → 1000
  update: { seq: { increment: 1 } },              // later calls → 1001, 1002, …
});
```

### Writing related records in one call

When you create or update a row you can act on its relations at the same time:

```ts
await db.user.create({
  data: {
    email: 'a@x.co', name: 'A',
    posts: {
      create: { title: 'Hello' },     // create a new related post
      connect: { id: 'p2' },          // attach an existing one
    },
  },
});
```

Supported on a relation: `create`, `createMany`, `connect`, `connectOrCreate`
(find one or make it), `disconnect`, `set`, `delete`, `deleteMany`, `update`,
`updateMany`, `upsert`.

### Deletes and cascades

If a relation declares `onDelete: 'Cascade'`, deleting the parent deletes the
children too. On SQL this is enforced by a foreign key. On Mongo, which has no
foreign keys, forge walks the relations and deletes the children for you.

```ts
await db.user.delete({ where: { id: 'u1' } });   // posts with onDelete:'Cascade' go too
```

See more — **[docs/MUTATIONS.md](docs/MUTATIONS.md)** for create/update/upsert/delete asymmetry, atomic ops, nested writes, batched throughput, and eight worked patterns. **[docs/UPSERT.md](docs/UPSERT.md)** for per-dialect emit (`ON CONFLICT` / `ON DUPLICATE KEY` / `MERGE` / `findOneAndUpdate`) and race semantics. **[docs/BATCH.md](docs/BATCH.md)** for `createMany`/`updateMany`/`deleteMany`, bind-parameter limits, chunking. **[docs/LOCKING.md](docs/LOCKING.md)** for SELECT FOR UPDATE / advisory locks / SKIP LOCKED work queues. **[docs/CONCURRENCY.md](docs/CONCURRENCY.md)** for optimistic vs pessimistic control and ETag/If-Match patterns. **[docs/IDEMPOTENCY.md](docs/IDEMPOTENCY.md)** for the Stripe-style Idempotency-Key model.

---

## Grouping and aggregates

`groupBy` aggregates rows by one or more columns. Each result row carries the
grouped columns plus the aggregate buckets you ask for: `_count`, `_sum`,
`_avg`, `_min`, `_max`. `_count._all` is `COUNT(*)`; per-column counts go in
`_count.<col>`.

```ts
const byStatus = await db.order.groupBy({
  by:      ['status'],
  where:   { channel: 'web' },          // filter rows BEFORE grouping
  _count:  { _all: true },
  _sum:    { total: true },
  _avg:    { total: true },
  _min:    { total: true },
  _max:    { total: true },
  orderBy: { status: 'asc' },
});
// [{ status: 'paid', _count: { _all: 3 }, _sum: { total: 600 }, _avg: { total: 200 }, … }, …]
```

`having` filters the **groups** after aggregation. It accepts both Prisma's
field-first shape and the bucket-first shape — they mean the same thing:

```ts
having: { total: { _sum: { gte: 120 } } }   // field-first (Prisma)
having: { _sum: { total: { gte: 120 } } }   // bucket-first
```

### Distinct

`distinct` on `findMany` returns one row per distinct value-combination of the
listed columns; on `count` it counts those combinations.

```ts
await db.order.findMany({ distinct: ['status'] });    // one row per status
await db.order.count({ distinct: ['channel'] });      // how many distinct channels
```

See more — **[docs/QUERIES.md](docs/QUERIES.md#groupby--having)** for the full groupBy / having vocabulary and per-dialect emit.

---

## Transactions

Run several writes so they all commit together or all roll back.

```ts
await db.$transaction(async (tx) => {
  const user = await tx.user.create({ data: { email: 'a@x.co', name: 'A' } });
  await tx.post.create({ data: { author_id: user.id, title: 'Hi' } });
});
```

If the callback throws, nothing is saved. You can also pass an array of queries
to run together: `await db.$transaction([db.user.findMany(), db.post.count()])`.

On Mongo, transactions need a replica set (a single-node `mongod` cannot run
them), which is the same requirement Prisma has.

**One thing to watch on Postgres:** do not catch a constraint error inside a
transaction and keep going. Postgres marks the whole transaction as failed after
any error, so the next statement fails with "current transaction is aborted."
forge rolls the transaction back cleanly and reports the original error, but the
catch-and-continue pattern will not work. Check first, use `upsert`, or let the
transaction fail and retry it.

**DuckDB** doesn't support `SAVEPOINT`, so nested transactions degrade to a
single outer one. Migration batches that abort can't partially recover.

See more — **[docs/TRANSACTIONS.md](docs/TRANSACTIONS.md)** for callback vs array semantics, per-dialect BEGIN/COMMIT mechanics, savepoint behaviour, isolation levels, deadlock retry, Mongo replica-set rules, AsyncLocalStorage HTTP pattern, and five worked patterns.

---

## Running raw SQL

When you need SQL forge does not express, use the tagged template. Values become
bound parameters, never string-interpolated, so it is safe against injection.

```ts
const rows = await db.$queryRaw`SELECT * FROM users WHERE email = ${email}`;
const affected = await db.$executeRaw`UPDATE users SET active = false WHERE last_seen < ${cutoff}`;
```

This is SQL only. On Mongo, use `db.<model>.aggregate({ pipeline })` instead.

See more — **[docs/RAW-SQL.md](docs/RAW-SQL.md)** for `forgeSql` composition, identifier-vs-value safety, per-dialect placeholder styles, `$runCommandRaw`, raw inside `$transaction`, and per-dialect worked patterns (PG `WITH RECURSIVE`, MySQL FULLTEXT, DuckDB Parquet, Mongo `$graphLookup`).

---

## Errors

Constraint and connection failures come back as a `DbKnownError` with a stable
code, so you can branch on the cause regardless of which database you are on.

```ts
import { DbKnownError } from 'forge-orm';

try {
  await db.user.create({ data: { email: 'taken@x.co', name: 'A' } });
} catch (e) {
  if (e instanceof DbKnownError && e.code === 'P2002') {
    // unique constraint violation (here, the email already exists)
  }
}
```

The codes follow Prisma's familiar set (`P2002` unique, `P2003` foreign key,
`P2004` constraint, and so on).

See more — **[docs/ERRORS.md](docs/ERRORS.md)** for the full error taxonomy, per-dialect code mapping (PG 23505 / MySQL 1062 / Mongo E11000 / MSSQL 2601), retry classes, exponential backoff with jitter, the AsyncLocalStorage retry pattern, and Sentry / Bugsnag wiring.

---

## Full-text search

Mark a text column `.searchable()`. When you create the tables, forge builds the
right full-text index for each database:

| Dialect  | What forge emits                                                                    |
| -------- | ----------------------------------------------------------------------------------- |
| Postgres | `CREATE INDEX … USING gin(to_tsvector('simple', col))`                              |
| MySQL    | `ALTER TABLE … ADD FULLTEXT(col)` (plus `WITH PARSER ngram` / `mecab` if requested) |
| SQLite   | `CREATE VIRTUAL TABLE <table>_fts USING fts5(...)` + insert/update/delete triggers  |
| DuckDB   | `PRAGMA create_fts_index(...)` (fts extension)                                      |
| Mongo    | `createIndex({ col: 'text' })`                                                      |
| MSSQL    | Manual — requires a full-text catalog (out-of-band). Schema field is kept.          |

Then query it with the `search` operator. The operator is portable; the
ranking and tokenisation behind it is whatever the dialect provides.

```ts
const Post = model('posts', {
  id:   f.id(),
  body: f.text().searchable(),
});

await db.post.findMany({ where: { body: { search: 'database wrapper' } } });
```

On SQLite, queries through the shadow FTS5 table are joined automatically —
you don't have to know it exists. On Postgres, the index is over
`to_tsvector('simple', col)`; you can pass a custom configuration via a raw
`expression:` index for language-specific stemming.

See more — **[docs/FTS.md](docs/FTS.md)** for every dialect's FTS engine, ranking score retrieval, multi-column composition, languages and analyzers, hybrid BM25 + vector (RRF), highlighting, and six worked patterns.

---

## Geo (geoPoint, near, nearTo, withinPolygon)

Declare a `f.geoPoint()` field and pair it with `method: 'spatial'`. The
column type and the spatial index family come out right per dialect:

```ts
const Place = model('places', {
  id: f.id(),
  name: f.string(),
  location: f.geoPoint(),                       // WGS84 / SRID 4326
}, {
  indexes: [{ keys: { location: 1 }, method: 'spatial', name: 'idx_places_geo' }],
});

// Insert — always { lng, lat }. Forge handles per-dialect coord-order quirks.
await db.place.create({
  data: { id: 'a', name: 'Lekki', location: { lng: 3.4505, lat: 6.4416 } },
});

// "Within 5 km of me", closest first, with a distance annotation.
const nearby = await db.place.findMany({
  where:   { location: { near: { lng: 3.45, lat: 6.44, withinMeters: 5000 } } },
  orderBy: { location: { nearTo: { lng: 3.45, lat: 6.44 } } },
  take: 20,
});
// nearby[0]._distanceMeters ≈ 0  (meters from the search point)
```

### What forge emits per dialect

| | Column | Spatial index | `near` filter | `nearTo` orderBy |
|---|---|---|---|---|
| Mongo | GeoJSON in JSON | `2dsphere` | `$near + $maxDistance` | (sorted by `$near` implicitly) |
| Postgres | `geography(Point, 4326)` | `USING GIST` | `ST_DWithin(...)` | `ST_Distance(...)` AS `_distanceMeters` |
| MySQL 8 | `POINT NOT NULL SRID 4326` | `SPATIAL INDEX` | `ST_Distance_Sphere(...) < N` | `ST_Distance_Sphere(...)` |
| SQLite | `BLOB` (SpatiaLite) | virtual `idx_<tbl>_<col>` table | `Distance(..., 1) < N` | `Distance(..., 1)` |
| DuckDB | `GEOMETRY` (spatial ext) | `USING RTREE` | `ST_Distance_Sphere(...) < N` | `ST_Distance_Sphere(...)` |
| MSSQL | `GEOGRAPHY` | `CREATE SPATIAL INDEX` | `col.STDistance(...) < N` | `col.STDistance(...)` |

### Extensions

- **Postgres** — needs PostGIS. Run `npx forge push --enable-extensions` to
  have forge issue `CREATE EXTENSION IF NOT EXISTS postgis;` before the
  schema push, or install it once by hand.
- **SQLite** — needs SpatiaLite (`brew install libspatialite` /
  `apt install libsqlite3-mod-spatialite`). The adapter calls
  `load_extension('mod_spatialite')` automatically; failures are silent so
  non-geo schemas keep working.
- **DuckDB** — `INSTALL spatial; LOAD spatial;` runs at connect time. Always
  available (bundled since DuckDB 0.9).
- **MSSQL** — `GEOGRAPHY` is built-in. Nothing to install.
- **MySQL 8** — spatial built-in. **5.7 works too** but without the SRID
  metadata. `forge doctor` warns if it detects 5.7.
- **Mongo** — `2dsphere` built-in.

Run `forge doctor` to see which extensions your live DB has and what's
missing, with copy-paste install commands.

### Fallback mode (no extension)

When the dialect's spatial extension is unavailable (a managed PG host
without PostGIS, a stripped-down SQLite, a barebones DuckDB build), opt
into fallback mode:

```ts
const Place = model('places', {
  id: f.id(),
  location: f.geoPoint({ fallback: true }),    // JSON storage + bbox prefilter
});
```

The column is stored as `{lng, lat}` JSON, the SQL emits a bounding-box
prefilter on the JSON-extracted lng/lat, and the adapter post-filters via
Haversine in app to produce the exact distance + circle. Works without
any extension; ~50× slower than the native path on large tables (fine to
~50k rows; migrate to a real extension past 100k).

### Coordinate order — always lng, lat

The forge API is `{ lng, lat }` everywhere. Per-dialect order differences
(MySQL 8 axis-order, GeoJSON order, MSSQL geography ordering) are handled
by the compile layer so you never have to think about them.

### Polygon containment

```ts
const inside = await db.place.findMany({
  where: {
    location: {
      withinPolygon: [
        { lng: 3.20, lat: 6.35 },   // 3+ vertices; ring auto-closes
        { lng: 3.60, lat: 6.35 },
        { lng: 3.40, lat: 6.55 },
      ],
    },
  },
});
```

Per dialect:

| | Compiles to |
|---|---|
| Mongo | `$geoWithin: { $geometry: Polygon }` |
| Postgres | `ST_Within(loc::geometry, ST_GeogFromText(...)::geometry)` |
| MySQL 8 | `ST_Within(loc, ST_GeomFromText('POLYGON((lat lng,…))', 4326))` |
| SQLite | `Within(loc, GeomFromText('POLYGON((…))', 4326))` |
| DuckDB | `ST_Within(loc, ST_GeomFromText('POLYGON((…))'::VARCHAR))` |
| MSSQL | `geography::STGeomFromText('POLYGON((…))', 4326).STContains(loc) = 1` |

Fallback mode emits an axis-aligned bbox prefilter from the polygon's
envelope; the adapter then runs a ray-casting point-in-polygon refinement
in app. Concave polygons work correctly.

**See also:** **[docs/GEO.md](docs/GEO.md)** — SRID picker, full dialect feature matrix, PostGIS deep-dive, distance models (sphere/ellipsoid/planar), 3D coords, MultiPolygon patterns, GeoJSON round-trip, spatial joins, H3 grids, realtime tracking, testing.

---

## JSON path queries

Read into nested JSON columns directly from `where`. Same scalar comparison
vocabulary as regular fields — `eq` / `ne` / `gt` / `gte` / `lt` / `lte` /
`contains` / `in` / `has`.

```ts
const Doc = model('docs', {
  id: f.id(),
  meta: f.json(),
});

// Dotted-path navigation.
await db.doc.findMany({
  where: { meta: { path: 'profile.age', gte: 18 } },
});

// Array indexing with [N] syntax.
await db.doc.findMany({
  where: { meta: { path: 'addresses[0].city', eq: 'Lagos' } },
});

// Substring search on the extracted value.
await db.doc.findMany({
  where: { meta: { path: 'bio', contains: 'engineer' } },
});

// Explicit array form (skips the dotted-path parser).
await db.doc.findMany({
  where: { meta: { path: ['tags', '0'], eq: 'urgent' } },
});

// Works on embedded objects too.
await db.user.findMany({
  where: { address: { path: 'city', eq: 'SF' } },
});
```

Works on `f.json()` / `f.embed()` / `f.embedMany()` / `f.stringArray()` /
`f.intArray()` fields. Non-JSON fields raise a clear error.

Per dialect:

| Dialect | Compiles to |
|---|---|
| Postgres | `(col->'a'->>'b')::numeric` (cast by operand type — string / numeric / boolean) |
| MySQL | `JSON_UNQUOTE(JSON_EXTRACT(col, '$.a.b'))` |
| SQLite | `json_extract(col, '$.a.b')` (JSON1 — built-in) |
| DuckDB | `json_extract(col, '$.a.b')` |
| MSSQL | `JSON_VALUE(col, '$.a.b')` |
| Mongo | dotted key: `{ 'meta.a.b': … }` |

**See also:** **[docs/JSON-PATH.md](docs/JSON-PATH.md)** — per-dialect SQL emit, GIN/multi-valued/expression indexes, column ↔ JSON migration, full operator-by-dialect matrix, null-marker semantics, audit-log/webhook patterns, common bugs.

---

## Vector similarity search

Embedding fields with native vector indexes per dialect, queried with the
same `near` / `nearTo` vocabulary as geo.

```ts
const Doc = model('docs', {
  id: f.id(),
  body: f.text(),
  // Match the dims to your embedding model
  // (OpenAI text-embedding-3-small = 1536; Cohere embed-v3 = 1024; etc.).
  embedding: f.vector(1536, { metric: 'cosine' }),
}, {
  indexes: [{ keys: { embedding: 1 }, method: 'vector' }],
});

await db.doc.create({
  data: { id: 'a', body: 'cat', embedding: await embedText('cat') },
});

// "Top-10 most semantically similar documents to my query vector,
//  within 0.4 cosine distance."
const matches = await db.doc.findMany({
  where:   { embedding: { near: { vector: queryVec, withinDistance: 0.4 } } },
  orderBy: { embedding: { nearTo: queryVec } },
  take: 10,
});
// matches[0]._distance ≈ 0  (cosine distance to the search vector)
```

Metrics — match to your embedding model's docs:

| Metric             | When                                                                |
| ------------------ | ------------------------------------------------------------------- |
| `'cosine'` (default) | Most text embedding models (OpenAI, Voyage, Cohere)                |
| `'l2'`             | Image embeddings (CLIP), some classical models                      |
| `'dot'`            | Normalized vectors where you want max speed                         |

Per dialect:

| Dialect | Column | Vector index | Query operator |
|---|---|---|---|
| Postgres | `vector(N)` (pgvector) | `USING hnsw (col vector_cosine_ops)` | `col <=> $vec` / `<->` / `<#>` |
| MySQL 9 | `VECTOR(N)` | community = exact only | `DISTANCE(col, STRING_TO_VECTOR(...), 'COSINE')` |
| SQLite | `TEXT` (JSON) | needs `sqlite-vec` vec0 vtab (out-of-band) | brute-force or vec0 |
| DuckDB | `FLOAT[N]` | `USING HNSW` (vss extension) | `array_cosine_distance(col, [...])` |
| MSSQL | `VECTOR(N)` | `USING VECTOR WITH (algorithm = 'HNSW')` | `VECTOR_DISTANCE('cosine', col, ...)` |
| Mongo | plain array | Atlas Search Index (`createSearchIndex`) | `$vectorSearch` (auto-routed) |

**Dimension validation**: `f.vector(1536)` rejects a 1024-dim query vector
at IR build time — catches embedding-model mismatches before they hit the
DB.

**Required setup** per dialect:

- **Postgres** — `CREATE EXTENSION vector;` (pgvector — available on every
  managed PG host: Supabase, Neon, RDS, Crunchy, …).
- **DuckDB** — `INSTALL vss; LOAD vss;` (load explicitly after connect;
  `spatial` auto-loads, `vss` is one extra `connection.run`).
- **SQLite** — install `sqlite-vec` extension; the `vec0` mirror table is
  created out-of-band (forge doesn't manage it). Use brute-force JSON
  scanning for small datasets.
- **MySQL** — built-in since 9.0. HeatWave Vector Store (Oracle Cloud)
  adds HNSW/IVF; community edition is exact-only.
- **MSSQL** — built-in in SQL Server 2025 / Azure SQL Database.
- **Mongo** — Atlas Vector Search (Atlas-only, not on-prem or community).
  Create the search index via the Atlas UI / CLI.

When the dialect can't host a regular vector index (Mongo, SQLite), the
`method: 'vector'` index emission warns clearly instead of silently
emitting a useless btree.

**See also:** **[docs/VECTOR.md](docs/VECTOR.md)** — dialect picker (pgvector / sqlite-vec / Atlas / HeatWave / DuckDB), end-to-end RAG pipeline, hybrid BM25 + vector with RRF, embedding versioning, HNSW/IVFFlat tuning, halfvec/binary quantization, CLIP multi-modal, MRR/nDCG CI gates, cost model.

---

## Browser (sqlite-wasm + OPFS)

forge runs in a browser tab. The wasm adapter wraps the official
[`@sqlite.org/sqlite-wasm`](https://sqlite.org/wasm/doc/trunk/index.md) build
of SQLite — the same C engine that runs on a server, compiled to WebAssembly —
inside a Web Worker, persisted on the **Origin Private File System (OPFS)**.
Every forge feature that compiles to SQLite works here unchanged: relations,
joins, aggregates, transactions, `groupBy`, FTS5 search, JSON path,
`softDelete()`, `partialFilterExpression` indexes, `$queryRaw`. The full IR
is reused; only the connection backend changes.

The browser adapter is sqlite-only by design — it's the one dialect with a
wasm story. PostgreSQL / MySQL / MongoDB / DuckDB / MSSQL stay on the server.

### Quickstart

Three steps, ~10 lines:

```sh
npm install forge-orm @sqlite.org/sqlite-wasm
```

```ts
// db.ts
import { createDb, wasmSqliteDriver, f, model } from 'forge-orm';

const Item = model('items', {
  id:    f.id(),
  name:  f.string(),
  qty:   f.int().default(0),
});
export const schema = { item: Item };

const worker = new Worker(
  new URL('forge-orm/wasm/worker', import.meta.url),
  { type: 'module' },
);

export const db = await createDb({
  schema,
  driver: wasmSqliteDriver({ worker, url: 'opfs-sahpool:///app.sqlite' }),
});

// First boot — apply schema DDL.
await db.$migrate();
```

```tsx
// React component — identical to server-side forge.
import { db } from './db';

export function ItemList() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof load>>>([]);
  useEffect(() => { load().then(setRows); }, []);
  return <ul>{rows.map((r) => <li key={r.id}>{r.name} × {r.qty}</li>)}</ul>;
}

async function load() {
  return db.item.findMany({ where: { qty: { gt: 0 } }, orderBy: { name: 'asc' } });
}
```

That's it. Persistent SQLite in the browser, with the full forge surface.

### URL schemes (`opfs:`, `opfs-sahpool:`, `:memory:`)

| URL | Backend | Persistence | Multi-tab |
|---|---|---|---|
| `opfs-sahpool:///app.sqlite` | OPFS SAH-pool VFS | Full | **Safe (recommended)** |
| `opfs:///app.sqlite` | OPFS VFS | Full | Single-tab writer |
| `:memory:` | In-RAM | None — lost on tab close | N/A |

The path after the prefix is the file name inside OPFS. OPFS files are
sandboxed per origin — `app.example.com` can't see `evil.com`'s files. The
default URL is `opfs-sahpool:///forge.sqlite`.

Pick **`opfs-sahpool:`** unless you have a specific reason not to. The SAH
pool VFS pre-allocates a small pool of synchronous access handles and
coordinates across tabs — opening the same DB in two tabs of your app just
works. The plain `opfs:` VFS gives a slight perf edge but throws if a second
tab tries to open the same file.

`:memory:` is useful for tests, demos, or strictly-ephemeral state.

### The worker file

sqlite-wasm needs OPFS *synchronous* access handles (`FileSystemSyncAccessHandle`),
which the browser only exposes inside a **Web Worker**. forge ships the
worker file at `forge-orm/wasm/worker` — bundlers resolve it via the standard
`new Worker(new URL(...), { type: 'module' })` pattern:

```ts
const worker = new Worker(
  new URL('forge-orm/wasm/worker', import.meta.url),
  { type: 'module' },
);
```

| Bundler | Pattern works? | Extra config |
|---|---|---|
| **Vite 4+** | Yes | `forgeWasm()` plugin (see below) |
| **Next.js 13+ (App Router)** | Yes | `withForgeWasm()` wrapper (see below) |
| **Webpack 5** | Yes | `forgeWasmWebpack(config)` helper (see below) |
| **Parcel 2+** | Yes | None — native worker support |
| **esbuild standalone** | Manual | Mark `@sqlite.org/sqlite-wasm` as external; bundle the worker separately |
| **Rollup** | Manual | Use `@rollup/plugin-web-worker-loader` |

If your bundler isn't listed, the worker pattern above is plain web-standard
syntax — modern bundlers all support it; the plugins below just take care
of the COOP/COEP headers and wasm asset handling.

### Vite setup

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { forgeWasm } from 'forge-orm/wasm/vite';

export default defineConfig({
  plugins: [react(), forgeWasm()],
});
```

What `forgeWasm()` does:

- Adds `optimizeDeps.exclude: ['@sqlite.org/sqlite-wasm']` so Vite's
  pre-bundler doesn't touch the wasm package.
- Sets `worker.format: 'es'` so the worker file is emitted as a real ES module.
- Adds `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` to the dev server (required if
  you use SharedArrayBuffer; harmless otherwise).

Options:

```ts
forgeWasm({
  coopCoep: true,             // default — disable if your dev server hosts
                              // third-party scripts that break under COEP
  excludeSqliteWasm: true,    // default — keeps wasm out of the dep optimizer
});
```

In production (`vite build`), the worker is bundled as a separate chunk. You
need to set the same COOP/COEP headers on your CDN / origin if the threaded
build is used; the stock build doesn't strictly require them.

### Next.js setup

```js
// next.config.js (or next.config.mjs)
import { withForgeWasm } from 'forge-orm/wasm/next';

export default withForgeWasm({
  reactStrictMode: true,
  // ...your existing Next config
});
```

What `withForgeWasm()` does:

- Wraps `webpack` to enable `asyncWebAssembly` + `topLevelAwait` experiments.
- Adds an `asset/resource` rule for `.wasm` files.
- Wraps `headers()` to emit COOP/COEP for the matched routes.
- Sets `experimental.esmExternals: 'loose'` (some Next versions need this for
  the wasm package's ESM-only export).

Options:

```ts
withForgeWasm(nextConfig, {
  coopCoepMatcher: '/(.*)',   // default — every route. Tighten to '/app/(.*)'
                              // if your marketing pages embed third-party widgets.
  noHeaders: false,           // skip COOP/COEP entirely if you set them at the CDN.
});
```

Note: COOP/COEP are app-wide policies. If a marketing page or auth callback
embeds Stripe / Intercom / GA that doesn't send `Cross-Origin-Resource-Policy`
back, the embed will break. Narrow the matcher in that case, or host the
SQLite-using parts on a subdomain.

### Webpack / CRA / Rsbuild setup

```js
// webpack.config.js
const { forgeWasmWebpack } = require('forge-orm/wasm/webpack');

module.exports = forgeWasmWebpack({
  // ...your existing webpack config
});
```

For Create React App, use `craco` to inject the same changes, or eject. For
Rsbuild, the same helper works against the underlying webpack config.

You'll also need to serve COOP/COEP headers from your dev server / CDN.
Express:

```js
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});
```

### `db.$migrate()` — runtime DDL apply

`forge push` is a Node CLI. In the browser you can't shell out to Node, so
forge ships the same emitter and applier as a runtime call:

```ts
const report = await db.$migrate();
// {
//   applied:        ['items', 'forge_items_unique_name'],
//   skipped:        [],                 // tables / indexes already present
//   failures:       [],                 // { name, error }
//   alteredColumns: ['items.email'],    // ALTER TABLE … ADD COLUMN run for these
//   pending:        [],                 // destructive drift left untouched
// }
```

Behind the scenes:

1. Reads the active schema (the one passed to `createDb({ schema })`).
2. Calls `buildSqliteSchemaDDL(schema)` — the same DDL emitter `forge push`
   uses against `better-sqlite3`.
3. Filters out tables / indexes that already exist (via `sqlite_master`).
4. Wraps the remaining batch in `BEGIN / COMMIT` and applies through the
   wasm driver.
5. Runs a drift-apply pass: introspects the live DB, diffs against the
   schema, emits `ALTER TABLE … ADD COLUMN` for every missing column that
   can be added safely (nullable, or with a constant default). Destructive
   drift — column drops, column-type changes, extra tables — is left alone
   and surfaced under `pending` for the caller to decide.

It's **idempotent**. Safe to call on every app boot — already-present tables
and indexes get skipped, columns added since the last boot get patched in,
the rest stays untouched. The shape of the report matches the `forge push`
output exactly (plus the two new fields), so it can be rendered in-app.

For verbose progress:

```ts
await db.$migrate({ logger: (line) => console.log(line) });
// ✓ table       items
// ✓ index       forge_items_unique_name
```

If you'd rather not couple migration to app boot, the lower-level pieces are
also exported — call them manually:

```ts
import { buildSqliteSchemaDDL, applySqliteMigration, runMigrate } from 'forge-orm';

// Build DDL once at build time, ship as a static asset:
const ddl = buildSqliteSchemaDDL(schema);   // DDLStatement[]
// Apply on demand:
const report = await applySqliteMigration(driver, ddl, { logger: console.log });
// Or, equivalent of db.$migrate():
const report2 = await runMigrate(driver);
```

**Drift detection** (since 2.5.1). After the create-pass, `$migrate()`
introspects the live DB and diffs it against the active schema:

* **Missing column, safe to add** (nullable, or has a constant default) →
  `ALTER TABLE … ADD COLUMN` is emitted automatically. Existing rows get
  `NULL` or the declared default. Each one is reported under
  `report.alteredColumns` as `'table.column'`.
* **Missing column, NOT NULL with no default** → surfaced under
  `report.pending`. SQLite would reject the ADD COLUMN against a non-empty
  table, so the runtime won't try; the caller decides whether to wipe the
  DB, hand-write a `$executeRaw` rebuild, or relax the schema.
* **Column-type change / column drop / extra table** → also `pending`.
  These need a full table rebuild, which is more than a runtime drift fix
  should attempt.

If you want the strict 2.5.0 create-or-skip behaviour back (no ALTER pass),
pass `await db.$migrate({ alter: false })`. `db.$diff()` is still
available when you only want the report and not the apply.

### `browserDoctor()` — runtime capability probe

The browser analog of `forge doctor`. Probes the environment and the SQLite
build, returns a structured report:

```ts
import { browserDoctor, wasmSqliteDriver } from 'forge-orm/wasm';

const driver = wasmSqliteDriver({ worker });
const report = await browserDoctor(driver);

console.table(report.capabilities);
// ┌─────────────────────────────────────┬────────────┐
// │ softDelete                          │ 'native'   │
// │ unique                              │ 'native'   │
// │ partialFilterIndex                  │ 'native'   │
// │ relationsAndJoins                   │ 'native'   │
// │ aggregations                        │ 'native'   │
// │ transactions                        │ 'native'   │
// │ json(path)                          │ 'native'   │
// │ text.searchable() / FTS5            │ 'native'   │
// │ geoPoint near / withinPolygon       │ 'fallback' │  ← R-Tree not in stock build
// │ vector near / nearTo                │ 'fallback' │  ← sqlite-vec not in stock build
// │ persistent OPFS storage             │ 'native'   │
// │ multi-tab safe                      │ 'native'   │
// └─────────────────────────────────────┴────────────┘
```

The full `BrowserDoctorReport` shape:

```ts
interface BrowserDoctorReport {
  environment: {
    runtime: 'browser' | 'worker' | 'node' | 'unknown';
    opfs: boolean;
    opfsSyncHandles: boolean;
    sharedArrayBuffer: boolean;
    persistent: 'granted' | 'requestable' | 'unavailable';
    estimatedQuotaMB?: number;
    estimatedUsageMB?: number;
    userAgent?: string;
  };
  sqlite: {
    version?: string;
    json1: boolean;
    fts5: boolean;
    rtree: boolean;
    sqliteVec: boolean;
    foreignKeys: boolean;
  };
  capabilities: Record<string, 'native' | 'fallback' | 'unavailable'>;
  notes: string[];   // human-readable warnings + remediation hints
}
```

### Persistent storage and the Safari 7-day eviction

Browsers grant every origin a storage quota — Chromium typically allows up to
~60% of free disk per origin pool. Two policies decide whether your data
survives:

1. **Disk-pressure eviction** — if the browser runs low on disk space, it can
   wipe any origin's storage. Mitigate by calling `navigator.storage.persist()`.
2. **Safari ITP 7-day eviction (iOS + macOS)** — Apple's Intelligent Tracking
   Prevention deletes IndexedDB + OPFS + LocalStorage after **7 days of no
   foreground visit**. This is the most-cited gotcha for offline-first browser
   apps. Two escapes:

   ```ts
   // 1. Ask for persistent storage at app boot. Once granted, ITP doesn't apply.
   if (navigator.storage?.persist) {
     const granted = await navigator.storage.persist();
     console.log('persistent storage:', granted ? 'granted' : 'not yet');
   }
   // 2. Tell users to "Add to Home Screen". PWAs are exempt from the 7-day timer.
   ```

   Apple grants `persist()` automatically once a site is "engaged with"
   (multiple visits, bookmarked, or installed). The first call may return
   `false`; retry on later visits.

For data you can rebuild from a server (offline cache shape), wiping the OPFS
DB is recoverable — the next online session re-fetches. For data the user
created locally and can't restore, treat persistence as critical: call
`persist()` early, surface a banner if it's not granted, and consider a sync
adapter.

### Multi-tab safety

If a user opens your app in two tabs and both try to write to the same OPFS
file, the rules are VFS-dependent:

| VFS | Two-tab behavior |
|---|---|
| `opfs:` | Second tab's open throws `SQLITE_BUSY`. Single-writer per file. |
| **`opfs-sahpool:`** | **Pool coordinates handles across tabs; multi-tab safe.** |

Default to **`opfs-sahpool:`**. The SAH pool pre-allocates a small set of
file handles (default 6) — your DB is one of them; the rest absorb the
multi-tab arbitration cost. The first tab grabs a handle; subsequent tabs
queue and resume when the first releases. Latency goes up under contention
but no writes are lost.

For tighter control, use a **SharedWorker** as a single owner of one
`opfs:` handle, and have each tab `postMessage` through it. That's outside
forge's scope today — issue a request if you want a built-in SharedWorker
host.

Cross-tab cache invalidation (refetch when another tab writes) is your
concern. The standard `BroadcastChannel` pattern works:

```ts
const bc = new BroadcastChannel('forge-invalidate');
// after a mutation:
bc.postMessage({ model: 'item' });
// in other tabs:
bc.onmessage = (ev) => queryClient.invalidateQueries({ queryKey: [ev.data.model] });
```

### Feature parity matrix

What the **stock** `@sqlite.org/sqlite-wasm` build gives you vs. the **pro**
build (custom-compiled with R-Tree + sqlite-vec, see next section):

| forge feature | Stock wasm | Pro wasm | Server (better-sqlite3 + extensions) |
|---|---|---|---|
| CRUD (findMany/Unique/create/update/delete) | ✓ | ✓ | ✓ |
| where ops (`contains` / `in` / `gt` / `OR` / `AND` / …) | ✓ | ✓ | ✓ |
| Relations (`include`, `select`, joins) | ✓ | ✓ | ✓ |
| Aggregates (`count`, `groupBy`, `having`, `_avg`/`_sum`/…) | ✓ | ✓ | ✓ |
| Transactions (`$transaction`) | ✓ | ✓ | ✓ |
| `softDelete()` / `restore()` | ✓ | ✓ | ✓ |
| `unique()` / partial-filter indexes | ✓ | ✓ | ✓ |
| `f.json()` + JSON path (`{ path: 'a.b', gte: 18 }`) | ✓ | ✓ | ✓ |
| `f.text().searchable()` (FTS5) | ✓ | ✓ | ✓ |
| `f.geoPoint()` + `near` / `withinPolygon` | Fallback (Haversine in JS) | **Native (R-Tree index)** | Native (SpatiaLite) |
| `f.vector()` + `near` / `nearTo` | Fallback (brute-force JS) | **Native (sqlite-vec HNSW)** | Native (sqlite-vec) |
| Atomic upsert (`INSERT … ON CONFLICT`) | ✓ | ✓ | ✓ |
| `$queryRaw` / `$executeRaw` | ✓ | ✓ | ✓ |
| Migrations | `db.$migrate()` (runtime) | `db.$migrate()` (runtime) | `forge push` (CLI) |
| Doctor probe | `browserDoctor()` | `browserDoctor()` | `forge doctor` (CLI) |
| Drift detection (`forge diff`) | Roadmap (2.5) | Roadmap (2.5) | ✓ |

Fallback mode is correct — it works — but slower. Rule of thumb:

- Fallback geo / vector: fine to ~50k rows. Past that, build the pro wasm.
- Stock FTS5 / JSON path: fast at any size — these are native in the stock build.

### Custom wasm build (vec0 + R-Tree)

The stock `@sqlite.org/sqlite-wasm` ships SQLite with FTS5 + json1 but
**without** R-Tree or sqlite-vec. To unlock native `f.geoPoint()` indexes and
native `f.vector()` similarity search, compile your own wasm bundle.

forge ships a build script that does this:

```sh
# 1. Install Emscripten (one-time)
git clone https://github.com/emscripten-core/emsdk
cd emsdk && ./emsdk install latest && ./emsdk activate latest
source ./emsdk_env.sh
cd -

# 2. Run the build (fetches SQLite + sqlite-vec sources, compiles, emits artifacts)
bash node_modules/forge-orm/scripts/wasm-pro/build.sh

# Artifacts land in dist/wasm-pro/sqlite3.{mjs,wasm}
```

What it includes:
- SQLite (configurable via `SQLITE_VERSION` env var, default 3.46.1)
- FTS5, json1, R-Tree, GeoPoly (all `SQLITE_ENABLE_*` flags set)
- sqlite-vec (configurable via `SQLITE_VEC_VERSION`, default `v0.1.6`)
- ES module output (`MODULARIZE=1 EXPORT_ES6=1`)
- Memory growth enabled (32 MB initial, grows as needed)

To use the pro build:

```sh
# 3. Copy the artifacts to your app's public/ folder
cp dist/wasm-pro/sqlite3.{mjs,wasm} public/wasm-pro/
```

```ts
// 4. Point the worker at the pro entry instead of the stock one
const worker = new Worker(
  new URL('forge-orm/wasm/worker-pro', import.meta.url),
  { type: 'module' },
);

// 5. Set the wasm URL on the worker (defaults to /wasm-pro/sqlite3.mjs)
worker.postMessage({ FORGE_WASM_PRO_URL: '/wasm-pro/sqlite3.mjs' });

// 6. Use as normal
const db = await createDb({
  schema,
  driver: wasmSqliteDriver({ worker, url: 'opfs-sahpool:///app.sqlite' }),
});
```

Now `f.geoPoint()` builds a real `USING rtree` index, and `f.vector()`
queries route through `vec_distance_cosine()` instead of JS brute-force.

Trade-offs of the pro build:

| | Stock | Pro |
|---|---|---|
| wasm size | ~1.0 MB | ~1.6 MB |
| Hosting | npm peer dep | You host the artifacts |
| Updates | `npm update` | Re-run `build.sh` |
| Geo / vector | Fallback | Native (10–100× faster on 100k+ rows) |
| Maintenance | None | Rebuild when sqlite-vec ships a fix |

For most apps, **stock + fallback is fine**. Reach for pro when you're doing
serious in-browser geo or vector work and the fallback isn't fast enough.

A pre-built `@forge-orm/sqlite-wasm-pro` npm artifact is on the roadmap —
issue a request if you want it sooner.

### Troubleshooting

**`SecurityError: Cross-Origin-Embedder-Policy: require-corp`**
Your dev server / CDN isn't sending COOP/COEP headers. Add the bundler plugin
above, or set them at your reverse proxy.

**`The operation cannot be performed in the current state` (OPFS)**
You're opening the DB from the main thread instead of a Worker. OPFS sync
handles are worker-only. Verify the `wasmSqliteDriver({ worker })` arg is a
constructed `Worker`, not an inline init.

**`SQLITE_BUSY` when opening in a second tab**
Switch from `opfs:` to `opfs-sahpool:` — the SAH pool VFS is multi-tab safe.

**Storage was empty after 7 days (Safari)**
Apple's ITP wiped it. Call `await navigator.storage.persist()` at app boot,
ideally guarded behind a successful auth (Apple grants persistence after
engagement). For long-lived data, prompt the user to add to Home Screen.

**`Failed to fetch dynamically imported module: ./sqlite3.mjs` (pro build)**
Set the `FORGE_WASM_PRO_URL` on the worker before any message, or hard-code
it inside `worker-pro.ts`. Default is `/wasm-pro/sqlite3.mjs`.

**Bundle size warnings**
`@sqlite.org/sqlite-wasm` is ~1 MB. Code-split it into the part of the app
that needs the DB so the marketing page doesn't pay the cost. Vite + Next
already handle this via the `import()` boundary at the worker URL.

**Slow startup on first visit**
The wasm fetch + compile is one-time and gets cached by the HTTP cache + the
wasm code cache. Subsequent loads are <50 ms. If you need a pre-warm, fire
the worker construction in the root layout instead of waiting for a route.

### Framework worked examples

End-to-end recipes for React + Vite, Next.js App Router, Vue 3, Nuxt 3, SvelteKit, Angular, SolidStart, Astro, Remix, React Native + op-sqlite, and Tauri desktop live in **[docs/BROWSER-FRAMEWORKS.md](docs/BROWSER-FRAMEWORKS.md)**. Each one is the production-shaped install → bundler config → schema → db singleton → component flow.

See more — **[docs/BROWSER.md](docs/BROWSER.md)** for the complete browser reference (URL schemes, worker, every bundler setup, `$migrate` semantics including 2.5.1 drift, browserDoctor, persistent storage, multi-tab, stock-vs-pro matrix, custom build, troubleshooting), **[docs/BROWSER-FRAMEWORKS.md](docs/BROWSER-FRAMEWORKS.md)** for 11 framework recipes, and **[docs/REACT.md](docs/REACT.md)** for React patterns (hooks, TanStack Query, Suspense, server vs client components, optimistic updates, sync).

---

## Streaming large results

To process a large table without loading it all into memory, use
`findManyStream`. It yields rows one at a time using the driver's native cursor.

```ts
for await (const user of db.user.findManyStream({ where: { active: true } })) {
  await sendEmail(user);   // one row in memory at a time
}
```

See more — **[docs/QUERIES.md](docs/QUERIES.md#findmanystream)** for `findManyStream` internals per driver and the memory profile.

---

## Soft delete

Mark a date column `.softDeleteAt()`. Reads then automatically skip rows where
that column is set, and you get a dedicated verb to set it, an inverse to clear
it, and the `_withDeleted` escape hatch to read past the filter.

`delete()` / `deleteMany()` are **always hard deletes** — they remove the row,
exactly like Prisma, regardless of whether the model has a soft-delete column.
The recoverable path is explicit:

```ts
const Account = model('accounts', { id: f.id(), deleted_at: f.dateTime().softDeleteAt() });

// Soft delete — sets deleted_at; the row stays but is hidden from reads.
await db.account.softDelete({ where: { id: 'a1' } });
await db.account.softDeleteMany({ where: { tenantId: 't9' } });

// Reads skip soft-deleted rows by default; opt back in with _withDeleted.
await db.account.findMany();                                   // excludes a1
await db.account.findMany({ where: { _withDeleted: true } });  // includes a1

// Restore — clears deleted_at, row is active again.
await db.account.restore({ where: { id: 'a1' } });
await db.account.restoreMany({ where: { tenantId: 't9' } });

// Hard delete — permanently removes the row (and runs cascades). No going back.
await db.account.delete({ where: { id: 'a1' } });
await db.account.deleteMany({ where: { tenantId: 't9' } });
```

`softDelete`, `softDeleteMany`, `restore`, and `restoreMany` throw if the model
has no `.softDeleteAt()` column — use `delete` for a hard delete in that case.

> **Upgrading from v1.x?** In v1, `delete()` / `deleteMany()` *silently
> soft-deleted* on models with a `.softDeleteAt()` column. **v2 makes `delete()`
> always hard.** Search your codebase for `delete(` / `deleteMany(` calls on
> soft-delete models and switch the ones that expected recoverable behavior to
> `softDelete()` / `softDeleteMany()`. See the [CHANGELOG](./CHANGELOG.md) for
> the full migration note. This is a runtime semantic change — it will not show
> up as a type error.

See more — **[docs/SOFT-DELETE.md](docs/SOFT-DELETE.md)** for partial-filter uniques that ignore soft-deleted rows, cascade restore semantics, retention-purge cron, FTS / vector / search-index interaction, GDPR caveats (soft-delete is not erasure), and 3 worked patterns.

---

## Views and materialised views

Declare a read-only view with `.asView()`. Writes to it are rejected; reads work
normally.

```ts
const PublishedPosts = model('published_posts', {
  id: f.id(), title: f.string(), author_id: f.objectId(),
}).asView({
  sql: `SELECT id, title, author_id FROM posts WHERE status = 'PUBLISHED'`,
  sourceCollection: 'posts',   // Mongo equivalent
  pipeline: [{ $match: { status: 'PUBLISHED' } }],
});
```

Add `materialised: true` to store the results physically and refresh them on
demand. On Postgres this is a real materialised view; on MySQL, SQLite, DuckDB,
and MSSQL it is a table that gets repopulated; on Mongo it is a collection
filled by the pipeline.

```ts
const Stats = model('post_stats', { /* … */ }).asView({ materialised: true, sql, /* … */ });

await db.postStats.refresh();                    // recompute now
const stop = db.postStats.scheduleRefresh('1h'); // recompute hourly; call stop() to cancel
```

See more — **[docs/VIEWS.md](docs/VIEWS.md)** (updatable rules, SECURITY_BARRIER, indexed views, Mongo collection views) and **[docs/MATERIALIZED-VIEWS.md](docs/MATERIALIZED-VIEWS.md)** (refresh strategies, `REFRESH MATERIALIZED VIEW CONCURRENTLY`, MSSQL indexed views, Mongo `$merge`/`$out`, per-dialect emulation for MySQL/SQLite).

---

## Watching queries

Subscribe to every query for logging or metrics. The callback receives the
database, model, operation, SQL, parameters, duration, and row count. There is
no cost when nothing is subscribed.

```ts
const off = db.$on('query', (e) => {
  if (e.duration_ms > 100) console.warn('slow query', e.sql, e.params);
});
db.$on('error', (e) => console.error(e.op, 'failed', e.error.message));
// off();  // stop listening
```

See more — **[docs/EVENTS.md](docs/EVENTS.md)** for the full `QueryEvent` shape with `semanticOp`, custom sinks, sampling and privacy. **[docs/LOGGING.md](docs/LOGGING.md)** for Pino/Winston wiring, redaction, request correlation. **[docs/TRACING.md](docs/TRACING.md)** for OpenTelemetry spans and W3C traceparent propagation. **[docs/METRICS.md](docs/METRICS.md)** for Prometheus histograms with cardinality discipline. **[docs/WATCH.md](docs/WATCH.md)** for Mongo change streams, Postgres LISTEN/NOTIFY, MySQL binlog tailing, and the WebSocket fan-out bridge for realtime UIs.

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
[MIGRATIONS.md](./docs/MIGRATIONS.md).

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
[MULTI-TENANT.md](./docs/MULTI-TENANT.md).

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
rebuilds it. See [INDEXES.md](./docs/INDEXES.md).

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

See more — **[docs/MIGRATIONS.md](docs/MIGRATIONS.md)** for the push-style model, drift rules, per-dialect emit table, three CI snippets, blue/green pattern, monorepo workflow. **[docs/CLI.md](docs/CLI.md)** for every `forge` subcommand and flag. **[docs/PUSH.md](docs/PUSH.md)** (push semantics + `--enable-extensions` + `--fallback`), **[docs/DIFF.md](docs/DIFF.md)** (drift taxonomy + the 2.5.1 auto-apply pass), **[docs/DOCTOR.md](docs/DOCTOR.md)** (live capability probe), **[docs/ROLLBACK.md](docs/ROLLBACK.md)** (snapshot vs forward-only vs blue/green), **[docs/SEED.md](docs/SEED.md)** (idempotent upserts + bootstrap/dev/demo split), **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** (env-per-stage + zero-downtime + RDS Proxy), **[docs/VERSIONING.md](docs/VERSIONING.md)** (expand/contract for breaking changes), **[docs/BACKUP-RESTORE.md](docs/BACKUP-RESTORE.md)** (per-dialect backup + PITR + restore drills).

---

## Dropping to raw queries with `.compile`

If you need the exact query forge would run, ask for it instead of running it.
You get the Mongo arguments object or the SQL string with its parameters, ready
to hand to the driver yourself.

```ts
const q = db.user.compile.findMany({ where: { active: true }, take: 20 });
// SQL:   { sql: 'SELECT … WHERE "active" = $1 LIMIT 20', params: [true] }
// Mongo: { collection: 'users', op: 'find', args: { filter: { active: true }, options: { limit: 20 } } }
```

Every runtime method on `db.<model>` is on `.compile` too, including
`softDelete` / `softDeleteMany` / `restore` / `restoreMany`. The compile
variant throws synchronously if the model has no `.softDeleteAt()` field
instead of waiting for the runtime check:

```ts
const c = db.account.compile.softDelete({ where: { id: 'a1' } });
// SQL: UPDATE accounts SET deleted_at = $1 WHERE id = $2 …
```

`compile` returns a `MongoArtifact` on Mongo and a `SQLArtifact` with the
matching `dialect` on Postgres / MySQL / SQLite / DuckDB / MSSQL. If you want
a statically narrowed surface, use `.compileMongo` or `.compileSql`; both
throw at access on the wrong adapter.

---

## Type safety

Types come straight from your schema, with no generated client. `db.user` knows
its fields, `where` rejects values of the wrong type, `select` narrows the
result, and `include` returns the related model's shape.

### Row + db helpers

```ts
import type { Row, ForgeDb } from 'forge-orm';

type DB   = ForgeDb<typeof schema>;
type User = Row<typeof User>;     // { id: string; email: string; name: string; … }
```

### Checking whether a model exists (`in`, `db.$models`)

Reading a model forge doesn't know about **throws**, on purpose — a typo'd
name should fail at the access, not surface as
`Cannot read properties of undefined` several frames later:

```ts
db.Tpyo   // throws: [forge] unknown model "Tpyo". Active schema exposes: …
```

When a model is genuinely optional, guard with `in`. It never throws:

```ts
const view = 'OrgIndustryMixView' in db ? db.OrgIndustryMixView : null;
if (!view) return;            // not registered — skip, don't crash
await view.refresh();
```

`in` is exact and case-sensitive (`'user' in db` is `false` when the model
is registered as `User`), and it reports the `$` helpers too, so
`'$transaction' in db` is `true`. Do **not** reach for `?.` or `??` to do
this job — the throw happens during the property read, so neither ever
runs.

`db.$models` gives the full sorted list, which is the quickest way to
confirm a schema actually reached `createDb`:

```ts
db.$models   // ['Gadget', 'Widget']
```

Both work inside `$transaction`. The tx handle reports only what it
serves, so `'$migrate' in tx` is `false`.

> `Object.keys(db)` returns `[]` by design. Making model keys enumerable
> would make `JSON.stringify(db)` walk every collection wrapper; use
> `$models`.

### Direct-from-model inference (`Infer*`)

When you want a create/update/where shape for a service signature, DTO,
validation layer, or anywhere else outside `db.*`, take it straight from
the model — no codegen, no `SchemaMap` registration, no detour through
`ForgeOf<'key'>`. Pass `typeof MyModel` to any `Infer*` alias:

```ts
import { f, model, rel } from 'forge-orm';
import type {
  Infer, InferCreate, InferUpdate, InferWhere, InferRow,
  InferOrderBy, InferSelect, InferInclude, InferSchema,
} from 'forge-orm';

const User = model('users', {
  id:    f.id(),
  email: f.string().unique(),
  name:  f.string().optional(),
  age:   f.int().optional(),
});

type UserRow    = InferRow<typeof User>;
//   { id: string; email: string; name: string | null; age: number | null }
type UserCreate = InferCreate<typeof User>;
//   { id?: string; email?: string; name?: string | null; age?: number | null; … relations }
type UserUpdate = InferUpdate<typeof User>;
//   plain values + atomic ops on numbers: { age: { increment: 1 } }
type UserWhere  = InferWhere<typeof User>;
//   field filters + AND / OR / NOT
type UserOrder  = InferOrderBy<typeof User>;
//   { createdAt: 'desc' }

// One bundle of everything for a single model:
type UserT = Infer<typeof User>;
//   { Row, Where, WhereUnique, Create, Update, Upsert, OrderBy, Select, Include, Omit }

function createUser(data: UserT['Create']) { /* … */ }
function findUser(where: UserT['Where']):   Promise<UserT['Row'][]> { /* … */ }
```

For relation-aware `Select` / `Include`, pass the schema map as the second
generic so the helper can walk the relation graph:

```ts
const schema = { user: User, post: Post } as const;
type Types = InferSchema<typeof schema>;

type PostSelect = Types['post']['Select'];
// { id?: boolean; title?: boolean; author?: boolean | { select: { … } } }

type UserInclude = Types['user']['Include'];
// { posts?: boolean | { where: …, take: number, … } }
```

`Infer<typeof M>` works on any `TypedModel` returned by `model(...)` — you
don't have to wire it into a schema map first, you don't have to call
`setActiveSchema`, and you don't need a build step. Add a field to the
model and every `Infer*` derived from it updates on save.

See more — **[docs/TYPES.md](docs/TYPES.md)** for `Row`, every `Infer*` helper, `ForgeOf` / `ForgeModels`, optional-vs-nullable asymmetry, strict mode, generic helpers, autocomplete pitfalls, embed inference, per-dialect type quirks, and five worked patterns.

---

## Performance

forge adds a thin layer over the driver. In a local micro-benchmark of simple
operations (find, count, update), its per-call overhead measured similar to,
and often lower than, Prisma and Drizzle, with no separate engine process to
start.

Read that for what it is: a small synthetic test on localhost. The differences
are fractions of a millisecond and disappear next to real network latency and
query complexity. It says nothing about complex joins, correctness, or
maturity. The point is only that the convenience does not cost you measurable
performance. Run `forge:bench` and `forge:bench:compare` to see for yourself.

See more — **[docs/BENCHMARKS.md](docs/BENCHMARKS.md)** for the bench methodology, every shipped scenario, Prisma/Drizzle compare mode, profiling with clinic.js/0x, microbench traps (JIT warmup, GC pauses), and CI regression gating. **[docs/POOLING.md](docs/POOLING.md)** for connection-pool sizing per dialect and the per-runtime constraints (Lambda, Workers, Bun, pgbouncer). **[docs/CACHING.md](docs/CACHING.md)** for DataLoader / Redis cache-aside / CDN patterns. **[docs/N-PLUS-ONE.md](docs/N-PLUS-ONE.md)** for `include` vs DataLoader and how to detect query explosions via the event hook.

---

## Testing

The repository's own test suite (run from a clone) has **439 unit tests** plus
live integration scenarios across every database, plus dedicated regression
scripts (e.g. `regression-mongo-value-field.ts`, `regression-groupby-distinct.ts`,
`regression-geo-duckdb.ts`, `regression-vector-duckdb.ts`) wired into the
per-dialect integration runs.

```sh
npm run forge:check         # unit tests, type checks, and autocomplete checks (no database needed)
npm run forge:integration   # full CRUD against live Postgres, MySQL, SQLite, and Mongo
npm run forge:integration:duckdb   # DuckDB CRUD + geo + vector through the vss extension
npm run forge:bench         # speed against the raw driver
npm run forge:all           # all of the above
```

Each integration run creates a throwaway database and drops it when finished.

### Driver smoke harness

To verify the drivers themselves install and connect on a fresh machine,
without touching your project's `node_modules`, run the throwaway smoke
harness:

```sh
npm run smoke:drivers              # install every driver + run connect/SELECT 1/close
npm run smoke:drivers -- --only=pg # filter to a single dialect
npm run smoke:drivers -- --keep    # leave the tmpdir + containers around for inspection
```

It creates a throwaway tmpdir, `npm install`s every driver forge-orm supports
plus `testcontainers`, runs `connect → SELECT 1 → close` per driver, then
tears the tmpdir + containers down. Covers `better-sqlite3` / `@libsql/client` /
`@duckdb/node-api` (embedded); `pg` / `postgres` / `mysql2` / `mariadb` /
`mongodb` / `mssql` (server, via Testcontainers); `expo-sqlite` /
`@op-engineering/op-sqlite` (install-only — exec needs the RN runtime).

ARM Macs swap `mssql/server:2022` (AMD64-only) for `azure-sql-edge`
(multi-arch) automatically.

See more — **[docs/TESTING.md](docs/TESTING.md)** (in-memory better-sqlite3, FakeWorker for browser code, transaction-rollback reset, event-hook assertions). **[docs/INTEGRATION-TESTING.md](docs/INTEGRATION-TESTING.md)** (testcontainers, Docker Compose, parallel-safe schema reset, GH Actions matrix across pg/mysql/sqlite/mongo). **[docs/FIXTURES.md](docs/FIXTURES.md)** (typed factories, seeded random, snapshot fixtures, browser OPFS fixtures).

---

## Limitations and honest notes

* **It is young.** No long production history, one main author. Treat it as
  early-stage. If a quiet data bug would be costly, test your own queries
  against it thoroughly first.
* **Primary keys are auto-generated strings, not sequential numbers, by default.**
  forge fills in a UUID (or ObjectId on Mongo) when you omit `id`. An
  auto-incrementing integer key is SQL-only via `f.id({ type: 'bigserial' })`.
* **One schema per process.** `createDb({ schema })` sets the active schema for
  the whole process. That fits one schema per service. For several different
  schemas at once, run them in separate processes.
* **Some nested writes are partial.** Deeply nested `upsert`, `update`, and
  `set` cover the common cases but not every Prisma shape.
* **MSSQL upsert is not implemented in 2.3** — it throws `NotImplemented`
  pointing at v2.4 (`MERGE` rewrite). INSERT / UPDATE / DELETE / SELECT work
  today.
* **Mongo cross-field geo `nearTo`** — a `near` filter on field A combined
  with a `nearTo` orderBy on field B will only honor B (single `$geoNear`
  stage limit). Same field on both sides works fine.
* **MultiPolygon, GeometryCollection, holes** — single-polygon
  `withinPolygon` works. Multi-ring shapes need raw queries.
* **3D / Z coordinates** — not modelled. Store altitude as a separate scalar.
* **SRID reprojection** — WGS84 only. UTM, state-plane, or other CRSes need
  raw queries.
* **MySQL 5.7** — spatial works but without SRID enforcement; `forge doctor`
  warns.
* **DuckDB** — no FK enforcement (forge's app-side cascade walker handles
  it); no `SAVEPOINT` (a failing migration batch can't partially recover);
  no partial indexes / `INCLUDE` columns / `ctid` (replaced with `rowid`
  where needed); unique constraints cover soft-deleted rows since there are
  no partial indexes.
* **No GUI, no plugin system.** If you need a data browser or middleware, this
  is not that.

---

## Contributing

The repository is public at https://github.com/johnsonfash/forge-orm. Issues and
pull requests are welcome. To work on it: clone, `npm install`, then
`npm run forge:all` to run the full suite. The code is small and organised by
database adapter under `src/adapters/`, with a shared query layer in `src/ir/`,
so a change to one database rarely touches another.

MIT licensed.
