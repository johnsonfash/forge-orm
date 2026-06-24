# SQLite (server-side)

For browser sqlite-wasm + OPFS, see [BROWSER.md](BROWSER.md). This page covers server-side SQLite: choosing a driver (better-sqlite3, libsql/Turso, bun:sqlite, node:sqlite), the PRAGMAs forge sets, ALTER TABLE limitations, extension loading, and operational patterns (WAL, backup, sharding).

## Contents

* [Why SQLite is one adapter and many drivers](#why-sqlite-is-one-adapter-and-many-drivers)
* [Driver matrix](#driver-matrix)
* [PRAGMAs forge sets at connect](#pragmas-forge-sets-at-connect)
* [Other PRAGMAs you usually want](#other-pragmas-you-usually-want)
* [WAL mode in detail](#wal-mode-in-detail)
* [Type affinity and STRICT tables](#type-affinity-and-strict-tables)
* [ALTER TABLE limitations and the rebuild dance](#alter-table-limitations-and-the-rebuild-dance)
* [Extensions — FTS5, R-Tree, sqlite-vec, JSON1, math, regex](#extensions--fts5-r-tree-sqlite-vec-json1-math-regex)
* [VACUUM, auto-vacuum, and `VACUUM INTO`](#vacuum-auto-vacuum-and-vacuum-into)
* [Backups](#backups)
* [Concurrency model — one writer, many readers](#concurrency-model--one-writer-many-readers)
* [UUIDs in SQLite](#uuids-in-sqlite)
* [Turso / libsql specifics](#turso--libsql-specifics)
* [bun:sqlite specifics](#bunsqlite-specifics)
* [node:sqlite specifics (Node 22+)](#nodesqlite-specifics-node-22)
* [better-sqlite3 vs the legacy `sqlite3` package](#better-sqlite3-vs-the-legacy-sqlite3-package)
* [Litestream + forge — a worked example](#litestream--forge--a-worked-example)
* [Sharding patterns — one DB per tenant](#sharding-patterns--one-db-per-tenant)
* [Common errors and fixes](#common-errors-and-fixes)
* [Cross-links](#cross-links)

---

## Why SQLite is one adapter and many drivers

The SQLite adapter at `src/adapters/sqlite/adapter.ts` owns one dialect
(`SqliteDialect`), one DDL emitter (`buildSchemaDDL`), one IR compiler
(`compile-from-ir.ts`), one introspection reader (`introspectSqlite`), and
one error-code map (`errors.ts`). None of those vary across drivers. What
varies is the four-method `SqliteDriver` port (`all`, `get`, `run`, `exec`)
which is what every concrete client — better-sqlite3, libsql, bun:sqlite,
expo-sqlite, op-sqlite, sqlite-wasm — gets wrapped into.

That separation is the reason a Turso DB, a local `app.db`, a Bun process,
a React Native phone, and an in-browser tab can all share one schema file
and one set of queries. The IR compiles to the same SQL string; only the
"send this string and get rows" wire layer changes.

For the cross-driver primer, see [DRIVERS](./DRIVERS.md#sqlitedriver). This
file is the SQLite-specific deep dive: what makes the engine itself
particular, and what forge does to accommodate it.

---

## Driver matrix

| Driver | Sync/async | Where it runs | Install | Notes |
|---|---|---|---|---|
| `betterSqlite3Driver` | **Sync** (fastest local) | Node, Bun (via Node compat) | `npm i better-sqlite3` | Default. Native module. Compiles on install. |
| `libsqlDriver` | Async | Node, edge, Workers, Deno, Bun | `npm i @libsql/client` | Turso + libsql forks. Embedded replicas. HTTP fallback. |
| `bun:sqlite` (`bunSqliteDriver`) | **Sync** (resolved through `async`) | Bun only | bundled | Bun's first-party SQLite — `import { Database } from 'bun:sqlite'`. |
| `node:sqlite` (custom wrapper) | **Sync** (resolved through `async`) | Node 22.5+ | bundled — `node:sqlite` | Built-in. Stable in 22.5, experimental flag in 22.0–22.4. |
| `wasmSqliteDriver` | Async (worker) | Browser | `npm i @sqlite.org/sqlite-wasm` | See [BROWSER.md](./BROWSER.md). |
| `expoSqliteDriver` | Async | Expo SDK 51+ | `npx expo install expo-sqlite` | See [MOBILE.md](./MOBILE.md). |
| `opSqliteDriver` | Async | Bare React Native | `npm i @op-engineering/op-sqlite` | JSI zero-copy, large workloads. |
| `d1Driver` (sample) | Async | Cloudflare Workers | binding | See [DRIVERS.md](./DRIVERS.md#c-cloudflare-d1). |

The default driver is `betterSqlite3Driver`. When you pass a `sqlite:`
URL to `createDb`, the adapter `require()`s the `better-sqlite3` module
and wraps a fresh `new Database(filename)`. To use any other driver,
construct the client yourself and pass it via `createDb({ driver })`.

### `betterSqlite3Driver` — the default

```ts
import { createDb } from 'forge-orm';
import { schema } from './schema';

export const db = await createDb({
  url: 'sqlite:./app.db',
  schema,
});
```

URL forms the adapter accepts:

```
sqlite:./app.db            → relative file
sqlite:/var/lib/app.db     → absolute file
sqlite::memory:            → in-process
file:./app.db              → also accepted
./app.db                   → bare path; the detector resolves to sqlite
:memory:                   → bare
```

The adapter normalises all of those through `_urlToFilename(url)` (strip
`sqlite:` or `file:`; preserve `:memory:`) and hands the result to
`new Database(...)`.

### `libsqlDriver` — Turso, edge, libsql forks

```ts
import { createClient } from '@libsql/client';
import { createDb, libsqlDriver } from 'forge-orm';

const client = createClient({
  url: process.env.TURSO_URL!,      // libsql://your-db.turso.io
  authToken: process.env.TURSO_TOKEN!,
});

export const db = await createDb({ schema, driver: libsqlDriver(client) });
```

libsql rows are tuple-shaped — each row carries both column-named keys
*and* numeric indices, which would leak through `decodeRow`'s
`Object.keys()` walk. The built-in wrapper rebuilds rows from
`r.columns` to dodge this. Mirror that in any custom libsql-flavoured
wrapper.

### `bunSqliteDriver` and `nodeSqliteDriver` — wrap-it-yourself

Both Bun's `bun:sqlite` and Node 22.5+'s `node:sqlite` mirror
better-sqlite3's surface (`prepare(sql).all/get/run`, `db.exec`), so
the wrapper is the same shape — see [bun:sqlite specifics](#bunsqlite-specifics)
and [node:sqlite specifics](#nodesqlite-specifics-node-22) below for
the wrappers and trade-offs.

---

## PRAGMAs forge sets at connect

When the adapter's `connect()` opens a fresh better-sqlite3 file, it
runs three statements before returning the handle to the caller:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
SELECT load_extension('mod_spatialite');   -- best-effort, may fail silently
```

Why each:

* **`journal_mode = WAL`** — switches the file from rollback-journal
  (one writer blocks all readers) to write-ahead-log (writer takes the
  WAL; readers see the last consistent snapshot from the main file).
  Concurrent reads no longer wait for the writer. See [WAL mode in
  detail](#wal-mode-in-detail) below.
* **`foreign_keys = ON`** — SQLite *parses* `FOREIGN KEY` clauses by
  default but does not enforce them at runtime. forge declares cascades
  inline in CREATE TABLE; this PRAGMA is what makes
  `ON DELETE CASCADE` / `SET NULL` / `RESTRICT` actually fire. The
  setting is per-connection, so the migrator re-sets it before applying
  DDL.
* **`load_extension('mod_spatialite')`** — best-effort. Wrapped in
  `try { } catch { }`. If SpatiaLite isn't on disk, the load fails
  silently and any `f.geoPoint()` field falls back to JSON storage +
  Haversine post-filter in JS. The doctor probe surfaces the absence
  when a schema declares geo fields.

For injected drivers (libsql, expo-sqlite, op-sqlite, sqlite-wasm), the
adapter **does not** run `PRAGMA journal_mode = WAL` — those drivers
either run against a non-file backend (HTTP, OPFS) or already control
the journal mode themselves. The `PRAGMA foreign_keys = ON` and
SpatiaLite probe still run.

If you want forge's connect to leave PRAGMAs alone (you're driving the
file yourself, you want a different journal mode for batch loading,
etc.), construct your own better-sqlite3 instance and pass it via
`createDb({ driver: betterSqlite3Driver(db) })` — the adapter only sets
WAL when it opens the file itself.

---

## Other PRAGMAs you usually want

The two forge sets are the minimum. For server workloads, three more
are worth setting once per connection — pick the values that fit your
durability vs. throughput posture:

```sql
PRAGMA synchronous = NORMAL;        -- safer than OFF, ~2× write throughput vs. FULL
PRAGMA busy_timeout = 5000;         -- ms; retry SQLITE_BUSY transparently before raising
PRAGMA cache_size = -64000;         -- KB; negative = absolute KB, positive = pages
PRAGMA mmap_size = 268435456;       -- 256 MB; reads via mmap on Linux/macOS
PRAGMA temp_store = MEMORY;         -- spool large sorts in RAM, not /tmp
PRAGMA wal_autocheckpoint = 1000;   -- pages between auto-checkpoints (1000 default)
```

What each does:

* **`synchronous`** —
  * `FULL` (default in legacy mode): fsync after every write. Crash-safe
    against power loss; slowest.
  * `NORMAL`: fsync at WAL-checkpoint boundaries only. Crash-safe under
    OS crashes; *can* corrupt on power loss in rare edge cases. The
    SQLite docs recommend this for WAL mode.
  * `OFF`: never fsync. Fastest, but a power loss can corrupt the DB.
    Reasonable for ephemeral tests, never production.
* **`busy_timeout`** — when a writer hits a locked file, SQLite
  normally returns `SQLITE_BUSY` immediately. With a busy timeout set,
  it retries internally for that many milliseconds before raising. Five
  seconds is a reasonable default for an HTTP service; ten seconds for a
  job runner; zero (the default) for a CLI that wants the error fast.
* **`cache_size`** — page cache per connection. Negative means absolute
  KB (`-64000` = 64 MB); positive means page count (depends on
  page-size). Bigger = fewer disk reads on hot pages, more RAM per
  connection.
* **`mmap_size`** — memory-map up to N bytes of the DB file into the
  process. Faster reads (no syscall to fetch a page that's already
  mapped). Costs virtual address space. Set to ~half your RSS budget.
* **`temp_store = MEMORY`** — spill `ORDER BY` and `CREATE INDEX`
  temporaries to RAM instead of `/tmp`. Important if `/tmp` is small
  (container) or you want to avoid touching disk during batch jobs.
* **`wal_autocheckpoint`** — pages of WAL between auto-checkpoint
  attempts. Smaller = more frequent merges, smaller WAL on disk,
  briefer checkpoint pauses. Larger = fewer pauses, bigger peak WAL.

Apply them by extending the adapter via a bring-your-own-driver
wrapper:

```ts
import Database from 'better-sqlite3';
import { betterSqlite3Driver, createDb } from 'forge-orm';

const sqlite = new Database('./app.db');
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('busy_timeout = 5000');
sqlite.pragma('cache_size = -64000');
sqlite.pragma('mmap_size = 268435456');
sqlite.pragma('temp_store = MEMORY');
sqlite.pragma('foreign_keys = ON');

export const db = await createDb({
  schema,
  driver: betterSqlite3Driver(sqlite),
});
```

The adapter's own `connect()` is bypassed by `driver:`, so the PRAGMAs
you set on `sqlite` are the ones the file actually has. Re-setting
`foreign_keys = ON` is redundant in this path (the adapter still does
it) but harmless.

---

## WAL mode in detail

What WAL changes: in the default rollback-journal mode, a writer takes
an EXCLUSIVE lock on the file for the duration of the transaction, and
no reader can see in until the lock is released. WAL flips that: the
writer appends to `app.db-wal` (a sidecar file); readers see the last
consistent snapshot from the main file, *not blocked* by the writer.
On commit, the writer's pages become visible to the next reader.

Concretely you get three files instead of one:

```
app.db         the main database
app.db-wal     write-ahead log; grows during writes, shrinks on checkpoint
app.db-shm     shared-memory index over the WAL
```

When a reader copies the file, **all three must move together** — see
[Backups](#backups) below.

### When to use WAL

* **Server processes with concurrent reads.** Default yes. forge sets
  it for you.
* **Single-writer batch jobs** (data import scripts). WAL is still
  fine, but if you're the only client, rollback-journal isn't slower —
  the lock contention WAL avoids isn't there to begin with.
* **Network filesystems** (NFS, SMB). Avoid. WAL needs the shared-memory
  file (`-shm`) to coordinate processes, and shared memory across a
  network filesystem is unreliable. Use a local file or move to a
  client-server DB.
* **`:memory:` databases.** WAL is moot — there's no file. The PRAGMA
  is silently ignored.
* **libsql / Turso.** Server-side; the engine manages journaling. The
  PRAGMA is accepted but the meaningful surface is replication, not
  WAL.

### Multi-process readers

WAL makes multi-process readers safe on a local file. The constraint
is single writer at a time: SQLite serialises writers via the
shared-memory file. A second writer arriving while the first holds the
WAL receives `SQLITE_BUSY` after `busy_timeout` expires.

This is the fundamental ceiling: SQLite tops out at *one writer per
file*. If your write throughput is the bottleneck, that's the signal
to shard ([one DB per tenant](#sharding-patterns--one-db-per-tenant))
or move to Postgres / MySQL.

### Checkpoint behaviour

A checkpoint copies committed pages from the WAL back into the main
file and (optionally) truncates the WAL. Three modes:

* **PASSIVE** — copy what you can without blocking readers / writers.
  Doesn't truncate. The default auto-checkpoint mode.
* **FULL** — wait for readers / writer to release, then copy
  everything. Truncates the WAL on success.
* **RESTART / TRUNCATE** — like FULL, plus the WAL header is rewritten
  so the next write starts at offset 0. TRUNCATE physically shrinks
  the file on disk.

Auto-checkpoint fires every `wal_autocheckpoint` pages (1000 by
default, ~4 MB) and is PASSIVE. For backup or before shipping a file
to S3, run an explicit `PRAGMA wal_checkpoint(TRUNCATE)` to get the WAL
back to zero bytes and ensure all committed data is in the main file.

---

## Type affinity and STRICT tables

SQLite has no strict per-column types in the traditional sense. Pre-3.37,
a column declared `INTEGER` will happily accept the string `"hello"` —
the declared type is an *affinity hint* (a coercion preference), not a
constraint. The `decimal`/`numeric` affinity is the loosest: it'll
accept anything and round-trip it as best it can.

This is why `f.bool()` is emitted as `INTEGER` and `f.dateTime()` as
`TEXT` (ISO 8601) — there's no native type to lean on, and the affinity
system would silently coerce mixed types into something unhelpful.

### STRICT tables (3.37+)

SQLite 3.37 (2021) added `CREATE TABLE … STRICT`. STRICT tables
*enforce* type matching the way the rest of the world does — inserting
a string into an INTEGER column raises `SQLITE_CONSTRAINT_DATATYPE`
instead of silently coercing.

forge currently emits non-STRICT tables. The reason is portability: a
schema written today may be opened against an older engine (some
mobile WebViews, older expo-sqlite versions, old D1 builds) where
STRICT is unknown DDL syntax and the CREATE fails.

If you control the engine version, STRICT is a strict improvement (no
silent coercion bugs). A migration path could land it behind a
schema-builder flag — open an issue if you want it sooner.

### What the columnType helper emits

From `dialect.ts` (`columnType()`):

| forge field kind | SQLite column type | Notes |
|---|---|---|
| `f.id({ idType: 'bigserial' })` | `INTEGER` | rowid-aliased; PK + AUTOINCREMENT inlined |
| `f.id({ idType: 'uuid' })` | `TEXT` | application-generated UUID |
| `f.string()` / `f.text()` | `TEXT` | |
| `f.int()` | `INTEGER` | 64-bit |
| `f.bigint()` | `INTEGER` | better-sqlite3 returns BigInt when `safeIntegers: true` |
| `f.float()` | `REAL` | |
| `f.decimal()` | `NUMERIC` | dynamic-typed; round-trips via strings on libsql |
| `f.bool()` | `INTEGER` | 0 / 1; coerceInbound writes the right value |
| `f.dateTime()` | `TEXT` | ISO 8601 string |
| `f.json()` / `f.embed()` / `f.embedMany()` | `TEXT` | JSON-encoded; `json_extract` for path queries |
| `f.stringArray()` / `f.intArray()` | `TEXT` | JSON array |
| `f.enum(...)` | `TEXT` | + `CHECK (col IN (...))` |
| `f.geoPoint()` (SpatiaLite available) | `BLOB` | binary WKB |
| `f.geoPoint({ fallback: true })` | `TEXT` | JSON `{lng,lat}`; Haversine in JS |
| `f.vector(N)` | `TEXT` | JSON array; sqlite-vec virtual table holds the index |

Inbound coercion (`coerceInbound`) does the bool→0/1, Date→ISO,
object→JSON-string conversions before binding. Decode is handled by
the executor's `decodeRow`, which reads field kinds and reverses each
case.

---

## ALTER TABLE limitations and the rebuild dance

SQLite's `ALTER TABLE` supports a tiny subset of what other engines do:

| Operation | Supported? |
|---|---|
| `ADD COLUMN` | **Yes** (with restrictions — see below) |
| `RENAME COLUMN` | Yes (3.25+) |
| `RENAME TABLE` | Yes |
| `DROP COLUMN` | Yes (3.35+) but limited (no FK reference, no PK, no UNIQUE) |
| `ALTER COLUMN TYPE` | **No** |
| `ALTER COLUMN NULL/NOT NULL` | **No** |
| `ALTER COLUMN DEFAULT` | **No** |
| `ADD CONSTRAINT` | **No** (no inline FK / UNIQUE add-after) |
| `DROP CONSTRAINT` | **No** |

### `ADD COLUMN` restrictions

* The new column must be **nullable** or have a **constant default**.
  `NOT NULL` with no default fails — there's no way to populate
  existing rows.
* No `PRIMARY KEY` clause. The PK was set at CREATE time.
* No `UNIQUE` clause (use a separate `CREATE UNIQUE INDEX` after).
* No `FOREIGN KEY` clause (SQLite can't add FKs after CREATE — the
  whole rebuild dance below is the only path).

### How forge works around this

For **additive drift** (a new field in the schema → a missing column in
the DB), `db.$migrate()` (browser) and `forge push` / `forge diff apply`
(CLI) emit a plain `ALTER TABLE … ADD COLUMN`. Same shape as the live
DDL emitter, just one column at a time. Reported under
`report.alteredColumns` as `'table.column'`. See [BROWSER.md
$migrate()](./BROWSER.md#dbmigrate--runtime-ddl-apply--drift-detection)
for the runtime shape; [MIGRATIONS.md](./MIGRATIONS.md) for the CLI.

For **destructive drift** (column drop, type change, NOT-NULL-without-
default, FK add/remove), the runtime path leaves it under
`report.pending` and the CLI emits a *table rebuild*:

```sql
BEGIN;

-- 1. Build the new shape under a fresh name.
CREATE TABLE "items__new" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "price" NUMERIC NOT NULL                -- the new column
);

-- 2. Copy data, with whatever transform is needed.
INSERT INTO "items__new" ("id", "name", "price")
SELECT "id", "name", COALESCE("price_cents" / 100.0, 0) FROM "items";

-- 3. Swap.
DROP TABLE "items";
ALTER TABLE "items__new" RENAME TO "items";

-- 4. Re-create indexes (they dropped with the table).
CREATE UNIQUE INDEX "forge_items_unique_name" ON "items"("name");

COMMIT;
```

The dance is correct, but the trade-offs cost real money on big tables:

* The copy is O(N rows). A 50M-row table can take minutes.
* The whole thing is one transaction — concurrent writers are blocked.
* You need 2× the table size in free disk during the copy.

For tables past a few million rows, prefer a planned cut-over: build a
new field on the same table when possible (so additive), backfill in
batches outside the migration, then drop the old column in a separate
release.

`forge diff apply --plan-only` emits the SQL without executing it, so
you can read the rebuild before running it.

---

## Extensions — FTS5, R-Tree, sqlite-vec, JSON1, math, regex

SQLite extensions ship in three flavours:

1. **Compiled-in** — part of the build, no `load_extension` needed.
2. **Loadable** — a `.so` / `.dylib` / `.dll` you load at connect via
   `SELECT load_extension('path')` (SQL) or `db.loadExtension('path')`
   (better-sqlite3 API).
3. **Virtual table modules** — a module name registered by the
   extension; you `CREATE VIRTUAL TABLE foo USING mod(...)`.

### What's compiled into each driver

| Extension | better-sqlite3 | libsql | bun:sqlite | node:sqlite |
|---|---|---|---|---|
| JSON1 (`json_extract`, `json_set`, …) | Yes | Yes | Yes | Yes |
| FTS5 | Yes | Yes | Yes | Yes |
| R-Tree | Yes | Yes | Yes | Yes |
| `json_each` / `json_tree` | Yes | Yes | Yes | Yes |
| `printf` / common funcs | Yes | Yes | Yes | Yes |
| Math (`sin`, `cos`, `log`) | Compiled in 3.35+ | Yes | Yes | Yes |
| SpatiaLite (full GIS) | Loadable | No (use built-in geo helpers) | Loadable | Loadable (path varies) |
| sqlite-vec (vec0) | Loadable | Yes (libsql ships it built-in) | Loadable | Loadable |
| ICU (collations) | Loadable | Loadable | Loadable | Loadable |
| `regexp()` | Loadable | Yes | Yes | Loadable |

JSON1, FTS5, and R-Tree are universal — every shipped driver has them
compiled in. You can rely on `f.json()`, `.searchable()` (FTS5),
and `f.geoPoint()` (R-Tree-backed when needed) without loading
anything.

### Loadable extensions and better-sqlite3

better-sqlite3 disables `load_extension()` by default for safety.
Enable it on the instance, then load the module:

```ts
import Database from 'better-sqlite3';

const sqlite = new Database('./app.db');
sqlite.loadExtension('/usr/local/lib/mod_spatialite');     // GIS
sqlite.loadExtension('/usr/local/lib/vec0.dylib');          // sqlite-vec
sqlite.loadExtension('/usr/local/lib/sqlite-regex.dylib');  // ICU regex
```

forge's `connect()` runs `SELECT load_extension('mod_spatialite')` at
the SQL layer, which uses the engine's default search path. If
SpatiaLite is installed via Homebrew (`brew install libspatialite`),
that lookup usually just works on macOS; on Linux, install the system
package (`apt install libspatialite-dev`).

### sqlite-vec

Vectors are stored as JSON in the base table (`TEXT` affinity); the
sqlite-vec virtual table holds the indexed copy:

```sql
CREATE VIRTUAL TABLE embedding_index USING vec0(
  embedding float[1536]
);
```

forge emits the base-table column and the value-encoding logic; it
does **not** auto-create the `vec0` virtual table — the indexing
parameters (dimensions, distance metric, build-time options) are
deployment-specific. App code creates the vec0 table once during
migration, and routes `near` / `nearTo` queries through it via raw SQL
when sub-linear ANN is needed. The IR-level `vectorDistanceClause`
emits `TRUE` (full scan) by default — that's the brute-force fallback.

For the full vector story see [VECTOR.md](./VECTOR.md).

### FTS5

forge auto-emits FTS5 for any field that calls `.searchable()`. The
DDL emitter creates:

* a `<table>_fts` virtual table using `fts5(col1, col2, …,
  content=<base>, content_rowid='rowid')`,
* `AFTER INSERT / DELETE / UPDATE` triggers on the base table that
  mirror writes into the FTS index.

`where: { col: { search: 'term' } }` compiles to a `MATCH` against the
shadow table joined back through `rowid`. For the full surface — phrase
operators, prefix search, ranking — see [FTS.md](./FTS.md).

### `LOAD EXTENSION` vs `CREATE EXTENSION`

`CREATE EXTENSION` is **Postgres**, not SQLite. SQLite uses
`SELECT load_extension('path')` (or the driver's `loadExtension()`
method). There's no `CREATE EXTENSION` syntax; if you see it in a
script tagged "sqlite", it's a misfile.

---

## VACUUM, auto-vacuum, and `VACUUM INTO`

SQLite never reclaims disk space on its own (with one exception, see
auto-vacuum below). A deleted row's pages stay in the file marked
free, available for reuse on future INSERTs. The file grows to high
water mark and stays there. That's fine for steady-state workloads
and disastrous for ones that load-then-delete.

### `VACUUM`

Rebuilds the entire file: walks every page, writes a fresh copy with
no free space, and atomically replaces the original.

```sql
VACUUM;
```

* Reclaims all free pages.
* Defragments the file (sequential pages on disk → faster scans).
* Resets the rowid / sqlite_sequence counters? **No** — it preserves
  them.
* Costs **2× the DB size in free disk** during the rebuild.
* Takes an EXCLUSIVE lock for the duration — no readers, no writers.

Don't run it inside a transaction. Don't run it on a live server during
peak load. Schedule it for off-hours, or use `VACUUM INTO` to take a
clean snapshot to a different file without locking the live one
(below).

### `auto_vacuum`

Two non-default modes can reclaim space incrementally:

```sql
PRAGMA auto_vacuum = FULL;          -- reclaim free pages at every COMMIT
PRAGMA auto_vacuum = INCREMENTAL;   -- mark free, reclaim on PRAGMA incremental_vacuum
```

* Must be set **before any tables are created** — changing it later
  requires a `VACUUM` to take effect.
* Incremental is the practical choice: `PRAGMA incremental_vacuum(N)`
  reclaims up to N pages at a time, runs quickly, doesn't block.
* Costs a small per-transaction overhead (the pointer-map page tracks
  every page's parent).

For high-churn tables (queues, sessions), enabling `incremental` and
running `PRAGMA incremental_vacuum(1000)` periodically keeps the file
size bounded without the locking surprise of full `VACUUM`.

### `VACUUM INTO` — snapshot to a new file

Since 3.27 (2019):

```sql
VACUUM INTO '/backup/app.db.snap';
```

Writes a defragged copy to a new file path. The live DB is
*read-only*-locked for the duration, not write-blocked the way `VACUUM`
is. The destination is a complete, consistent SQLite file — open it,
restore from it, ship it to S3, diff it. This is the cleanest way to
snapshot a busy file without litestream or the `.backup` API.

```ts
import Database from 'better-sqlite3';
const db = new Database('./app.db');
db.exec("VACUUM INTO '/var/backups/app.db.snap'");
```

The output file has `synchronous = FULL` and no WAL — it's the
canonical "snapshot at this LSN" form.

---

## Backups

Four shapes, picked by uptime requirement and cost:

### 1. `.backup` API — online, online-safe

better-sqlite3 exposes the SQLite backup API directly:

```ts
import Database from 'better-sqlite3';

const src = new Database('./app.db');
await src.backup('/var/backups/app.db.bak');
```

Walks pages from source to destination while the live DB takes
writes. Handles WAL transparently. The output file is a complete,
consistent copy at the moment the backup completed. The default copies
in 100-page batches with no progress callback; the API also accepts an
options object for progress + throttling.

Use when: you want a hot backup that doesn't block writers, and you're
OK with a copy that may take a while on a multi-GB file.

### 2. `VACUUM INTO` — online, defragged

Covered above. Same hot-backup property as `.backup`, plus the output
is defragged (no free space). Slower on huge files because every page
is copied vs. only used pages.

Use when: you want both a backup *and* a healthy starting point for a
restore — e.g., a nightly snapshot that doubles as next-week's seed
file.

### 3. File copy — only when checkpoint is stable

The classic mistake: `cp app.db backup.db` while the DB is in WAL
mode. That copies the main file but not `app.db-wal`, so committed
data after the last checkpoint is lost. To do it safely:

```sql
-- 1. Force a full checkpoint so the WAL is empty.
PRAGMA wal_checkpoint(TRUNCATE);

-- 2. Then copy all three files atomically — or just the main file
--    if the WAL is empty and no writes happened since.
```

Better: skip this entirely and use `.backup` or `VACUUM INTO`. The
file-copy path is fragile because you have to guarantee no writes
between the checkpoint and the copy.

Use when: the DB is quiesced (read-only, or you stopped the writer).

### 4. Litestream — streaming-to-S3

For continuous backups, [Litestream](https://litestream.io/)
replicates WAL frames to S3 (or any S3-compatible object store) in
real time. Point-in-time restore down to the second. Runs as a
separate process; doesn't touch your application's SQLite calls.

```yaml
# litestream.yml
dbs:
  - path: /var/lib/app/app.db
    replicas:
      - type: s3
        bucket: my-backups
        path: app-db
        region: us-east-1
        sync-interval: 1s
```

```sh
litestream replicate -config /etc/litestream.yml
```

See [the worked example below](#litestream--forge--a-worked-example)
for full integration with forge.

For the broader backup discussion (Postgres, MySQL, Mongo), see
[BACKUP-RESTORE.md](./BACKUP-RESTORE.md).

---

## Concurrency model — one writer, many readers

The single most important property to internalise: **a SQLite file
supports one writer at a time, and any number of concurrent readers.**

That ceiling is a hard one. There's no clever buffering that lifts
it; SQLite serialises writers at the file-lock level. If two processes
both want to commit at the same instant, the second one waits.

What this means in practice:

* **A single Node webserver with WAL on a local disk** comfortably
  handles thousands of reads/sec and dozens of writes/sec. The writer
  rotates between concurrent requests under the busy-timeout retry.
* **Two Node webservers on the same disk** still hit the same file
  lock. You haven't scaled writers, you've just added contention.
* **A queue worker doing one INSERT per job** is the canonical "SQLite
  is great here" case. The worker is the only writer.
* **A multi-process API where every request might write** is the
  canonical "SQLite isn't enough" case. Either fan all writes through
  one process (worker queue), or move to Postgres / MySQL.
* **Multi-machine writes** are impossible against one file. Either
  shard ([one file per tenant](#sharding-patterns--one-db-per-tenant))
  or replicate at the engine level (Turso / libsql embedded replicas).

### Serialization inside one process

Async drivers (libsql, expo-sqlite, op-sqlite, sqlite-wasm) must
serialise calls — SQLite is single-writer at the file level, and an
interleaved set of `BEGIN` / `INSERT` / `COMMIT` calls from two
concurrent async tasks would race. The wasm driver queues through a
promise chain for this reason; libsql does the same internally; the
sync drivers (better-sqlite3, bun:sqlite, node:sqlite) don't have the
problem because every call returns before the next can start.

When you write a custom async driver, make sure your underlying client
either single-flights internally or wrap it yourself with a queue.

### `SQLITE_BUSY` retry strategy

When two transactions collide, the second receives `SQLITE_BUSY`
(mapped by forge's `errors.ts` to `P2034` "Database busy — please
retry"). The right fix is `PRAGMA busy_timeout = N` at connect time —
SQLite retries internally for N ms before raising. Application-level
retry on top of that is rarely useful unless you have a known
hot-spot.

### IMMEDIATE vs DEFERRED transactions

When forge opens a transaction it issues `BEGIN` (DEFERRED). A
DEFERRED tx upgrades to a write lock the first time it writes; if that
upgrade fails, the whole transaction has to retry from the top.

For known-write transactions, `BEGIN IMMEDIATE` takes the write lock
up-front — slower to acquire but no retry surprise mid-tx. forge
doesn't expose a knob today; if you need IMMEDIATE semantics on a
specific call, drop to `$executeRaw` with the explicit `BEGIN
IMMEDIATE` and `COMMIT`.

---

## UUIDs in SQLite

SQLite has no native UUID type. Options:

* **TEXT, v4** — `crypto.randomUUID()`. Readable, 36 chars, opaque
  order. Standard choice for most apps. Index is fine.
* **TEXT, v7** — UUIDv7 (time-ordered). Sortable by creation time, so
  index inserts append rather than scattering. Better for high-volume
  tables. Use a library (`uuid` package supports v7 since 9.0; or hand-
  roll from `Date.now()` + random tail).
* **BLOB(16)** — the raw 16-byte form. ~2× smaller than TEXT, ~10%
  faster on dense indexes. Less readable in SQL prompts (binary blob).
  Pick when you have hundreds of millions of rows and the storage win
  matters.

forge's `f.id({ idType: 'uuid' })` emits `TEXT`. The application
provides the value (`crypto.randomUUID()`). If you want v7, supply
your own generator:

```ts
import { v7 as uuidv7 } from 'uuid';

await db.User.create({ data: { id: uuidv7(), email, name } });
```

Or wire it via a default at the schema layer (a generator function
that runs on insert) — see [MODEL.md](./MODEL.md) for the `default`
hook.

For binary UUIDs, store as `f.string()` and bind a `Buffer` /
`Uint8Array`; better-sqlite3 binds those as `BLOB` automatically.

---

## Turso / libsql specifics

Turso is libsql in production: a managed, replicated SQLite that
speaks the libsql protocol (HTTP + WebSocket). Pick it when you want
SQLite's developer experience with edge replicas and the
operational story of a managed DB.

```ts
import { createClient } from '@libsql/client';
import { createDb, libsqlDriver } from 'forge-orm';

const client = createClient({
  url: process.env.TURSO_URL!,      // libsql://your-db.turso.io
  authToken: process.env.TURSO_TOKEN!,
});

export const db = await createDb({ schema, driver: libsqlDriver(client) });
```

### Embedded replicas

libsql's killer feature. A local SQLite file syncs with the remote
primary; reads hit the local file (nanosecond latency); writes are
forwarded to the primary and applied locally on commit. The cost of
writes is the round-trip to the primary; the benefit of reads is they
have no network in the loop at all.

```ts
const client = createClient({
  url: 'file:./local-replica.db',
  syncUrl: process.env.TURSO_URL!,
  authToken: process.env.TURSO_TOKEN!,
  syncInterval: 60,        // seconds; or call client.sync() explicitly
});
```

* Long-running Node server → embedded replica beats remote-only on
  every read.
* Worker / Lambda → embedded replica fights the runtime (cold starts,
  ephemeral disk). Use remote-only or HTTP.
* Mobile (Capacitor / RN) → embedded replica is the offline-first
  model; write while offline, sync when online.

### HTTP vs WebSocket

libsql clients pick the transport from the URL:

* `libsql://…` → WebSocket. Persistent connection; lower per-request
  overhead. Best for long-lived servers.
* `https://…` → HTTP. One round-trip per call. Best for edge runtimes
  that can't hold a WebSocket (Workers, Vercel Edge).
* `file:…` → local file. Standard SQLite, no network.

The `libsqlDriver` wrapper is the same in all three cases — only the
client construction changes.

### Replica routing

Reads go to whichever replica is closest; libsql's client routes them.
Writes always go to the primary. You don't pick — Turso decides based
on the URL you gave it. The primary's location is the region you
provisioned the DB in; replicas are wherever you opted into them.

If a write is followed immediately by a read of the same row, you
might read a slightly-stale replica. For read-your-own-writes, the
client sends a sync hint — newer libsql versions wait for the replica
to catch up before reading.

### When *not* to use libsql

* You need full FTS5 ranking customisation that conflicts with the
  primary's compile flags.
* You're on a free tier and you need disk space past the per-DB
  budget — sharding (one DB per tenant) is then bottlenecked by the
  DB-count quota.
* You're running entirely behind a corporate firewall with no
  outbound to `turso.io`. Self-host libsql or use plain
  better-sqlite3.

---

## bun:sqlite specifics

Bun's first-party module mirrors better-sqlite3 — same `prepare(sql)
.all/get/run`, same `exec`, same `loadExtension`. The wrapper:

```ts
import type { SqliteDriver } from 'forge-orm';
import { createDb } from 'forge-orm';
import { Database } from 'bun:sqlite';

export function bunSqliteDriver(db: Database): SqliteDriver {
  return {
    kind: 'sqlite',
    all: async (sql, params) => db.prepare(sql).all(...params),
    get: async (sql, params) => db.prepare(sql).get(...params),
    run: async (sql, params) => {
      const r = db.prepare(sql).run(...params);
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    },
    exec: async (sql) => { db.exec(sql); },
    close: async () => { db.close(); },
  };
}

export const db = await createDb({
  schema,
  driver: bunSqliteDriver(new Database('./app.db')),
});
```

### Performance

In synthetic benchmarks, bun:sqlite and better-sqlite3 are
neck-and-neck. bun:sqlite has the edge on cold start (part of the
runtime, no native module to load) and on tight prepared-statement
loops. better-sqlite3 has the edge on `iterate()` over huge result
sets. The picking criterion is "which runtime is your app on?", not
"which is faster".

Bun's Node-compat layer can also load `better-sqlite3` — it works
but defeats the no-native-build win. Pick bun:sqlite on Bun unless
you need a feature only the native-module driver has.

### Extensions

`db.loadExtension(path)` matches better-sqlite3's API; SpatiaLite,
sqlite-vec, ICU all load the same way:

```ts
db.loadExtension('/opt/homebrew/lib/mod_spatialite');
db.loadExtension('/opt/homebrew/lib/vec0.dylib');
```

---

## node:sqlite specifics (Node 22+)

Stable in 22.5; behind `--experimental-sqlite` in 22.0–22.4. The API
is `DatabaseSync` (synchronous):

```ts
import type { SqliteDriver } from 'forge-orm';
import { DatabaseSync } from 'node:sqlite';

export function nodeSqliteDriver(db: DatabaseSync): SqliteDriver {
  return {
    kind: 'sqlite',
    all: async (sql, params) => db.prepare(sql).all(...params),
    get: async (sql, params) => db.prepare(sql).get(...params),
    run: async (sql, params) => {
      const r = db.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
    exec: async (sql) => { db.exec(sql); },
    close: async () => { db.close(); },
  };
}
```

Trade-offs:

* **Pro** — no native build step on install. Faster `npm i`, nothing
  to gyp-rebuild on Node-version bumps. First-party; tracks Node's
  release schedule.
* **Con** — younger surface, still moves between minor versions.
  better-sqlite3's API is ten years stable.
* **Con** — no built-in iterator on the stable surface yet, so the
  SQLite adapter falls back to materialising `streamSelect` via
  `all()`.
* **Con** — `loadExtension()` is gated behind `--allow-load-extension`
  on the constructor and your Node binary must have been built with
  extension support. Most distro builds do; verify before relying on
  SpatiaLite / sqlite-vec.

When to pick which: prefer better-sqlite3 in production today
(stability + iterator); reach for node:sqlite in greenfield CLIs and
internal tools where avoiding the native-build dependency wins.

---

## better-sqlite3 vs the legacy `sqlite3` package

There are two npm packages with confusingly similar names:

| | `better-sqlite3` | `sqlite3` |
|---|---|---|
| API | **Synchronous** | Callback / Promise |
| Speed | ~10× faster on tight loops | Slower (callback overhead per row) |
| Maintenance | Active | Less active |
| Native module | Yes (prebuilt binaries for major platforms) | Yes |
| `iterate()` | Yes — native cursor | Indirect |
| Extension loading | Yes (must be enabled per-instance) | Yes |
| `safeIntegers` | Yes | No (always Number, lossy past 2^53) |

forge ships and recommends `better-sqlite3`. The legacy `sqlite3`
package can be wrapped too — it just requires going through its
async / callback API and translating to the `SqliteDriver` shape. The
sync model wins on basically every dimension that matters for SQLite
specifically: SQLite is so fast that the per-call callback overhead
of the async model is a meaningful fraction of the total time.

If your project still has `"sqlite3"` in `dependencies` and you're
not sure why, audit it. It's almost always a vestige.

---

## Litestream + forge — a worked example

Setup: a Node webserver on a Fly.io VM with a local SQLite file,
backed up continuously to S3 via Litestream. Total config: about 40
lines.

### 1. App: forge against a local file

```ts
// src/db.ts
import { createDb } from 'forge-orm';
import { schema } from './schema';

export const db = await createDb({
  url: 'sqlite:/data/app.db',          // Fly volume mount
  schema,
});
```

### 2. Litestream config

```yaml
# litestream.yml
addr: ":9090"                          # metrics endpoint
dbs:
  - path: /data/app.db
    replicas:
      - type: s3
        bucket: my-app-backups
        path: prod-app-db
        region: us-east-1
        sync-interval: 1s
        retention: 720h                # 30 days
        snapshot-interval: 24h
```

### 3. Process supervision

`fly.toml`:

```toml
[[mounts]]
  source = "data"
  destination = "/data"

[deploy]
  release_command = "litestream restore -if-replica-exists /data/app.db && node migrate.mjs"

[processes]
  app = "litestream replicate -exec 'node server.mjs' -config /etc/litestream.yml"
```

The trick is `litestream replicate -exec '...'`: litestream starts as
PID 1, *then* forks your app. When your app exits, litestream
catches the signal, flushes the WAL to S3, and shuts down cleanly. No
data loss on rolling deploys.

### 4. Restore on cold start

`release_command` runs before the new VM accepts traffic. If `/data`
is empty (fresh volume), `litestream restore` pulls the latest
snapshot + replays the WAL frames from S3, then `node migrate.mjs`
runs `forge push` to bring schema up to current. Idempotent — if the
file is already there, `restore -if-replica-exists` is a no-op.

### 5. What this gives you

* **RPO ~1 second** (the sync-interval).
* **RTO ~minutes** (S3 pull + replay).
* **Point-in-time restore** to any second in the 30-day retention.
* **Cost** — S3 storage of the WAL frames; on a small DB, dollars per
  month.

### Trade-offs

* SQLite is still single-writer. Litestream replicates *one* DB; it
  doesn't shard for you.
* If the Fly volume dies catastrophically *and* litestream can't reach
  S3 in the window between the last sync and the crash, you lose the
  unsync'd tail. The default 1s sync-interval bounds it tightly.
* Long-running transactions hold the WAL open and stall litestream's
  truncation. Keep transactions short.

For DBs that don't fit on one VM, see
[Sharding patterns](#sharding-patterns--one-db-per-tenant) below.

---

## Sharding patterns — one DB per tenant

The natural SQLite scale-out shape: instead of one big file, one file
per tenant. Each tenant gets a single-writer file; the application
opens the right one based on the request.

### When this works

* **Multi-tenant SaaS** with strong per-tenant isolation. Each
  tenant's data is in its own file; a bug in one tenant's data can't
  scribble over another's.
* **Per-user offline-first apps** where each user has their own DB
  synced to their device.
* **Per-region routing** where each region's data is locally hot
  (combined with libsql replicas for cross-region reads).

### When this doesn't work

* **Cross-tenant joins.** You can't `JOIN` across files. Workarounds
  exist (`ATTACH DATABASE 'other.db' AS other` and `JOIN other.tbl`),
  but they re-introduce a coordination dance and don't scale past a
  handful of attached files.
* **Tenant-count > file-handle budget.** Every open file is an FD.
  10k tenants with all DBs open is too many. Open on demand, close
  when idle.
* **Global queries** ("how many users do we have in total?"). Either
  push the per-tenant count to a separate aggregate DB on commit, or
  walk every file (don't).

### Sketch — a routing layer

```ts
import LRU from 'lru-cache';
import Database from 'better-sqlite3';
import { betterSqlite3Driver, createDb } from 'forge-orm';
import { schema } from './schema';

const cache = new LRU<string, Awaited<ReturnType<typeof createDb>>>({
  max: 200,
  dispose: (db) => db.$disconnect(),
  ttl: 5 * 60_000,
});

export async function tenantDb(tenantId: string) {
  let db = cache.get(tenantId);
  if (db) return db;

  const file = `/data/tenants/${tenantId}.db`;
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  db = await createDb({ schema, driver: betterSqlite3Driver(sqlite) });
  await db.$migrate();                 // bring schema forward on first open

  cache.set(tenantId, db);
  return db;
}
```

Pieces to add for production:

* **Provisioning** — on tenant create, build the file from a seed
  template (faster than running the full migration set).
* **Eviction** — when an LRU entry is evicted, the `dispose` callback
  calls `$disconnect()` so the file handle closes.
* **Backup fan-out** — Litestream supports multi-DB config; point it
  at `/data/tenants/*.db` and it replicates each independently.
* **Migration sweeps** — when the schema changes, run `forge push`
  against every tenant file. The CLI accepts `--url` per call; loop
  in a shell script.

### Resource sharing

Per-tenant files share:

* The same VM's CPU and RAM (each open file has its own cache).
* The same disk's IOPS budget.
* The same backup pipeline (Litestream, S3 traffic).

The win is independence: a slow tenant's heavy write load doesn't
slow the others. The cost is administrative: you have N files to
back up, migrate, monitor.

For the full multi-tenant playbook (DB-per-tenant vs row-level-tenant
vs schema-per-tenant), see [MULTI-TENANT.md](./MULTI-TENANT.md) and
[SHARDING.md](./SHARDING.md).

---

## Common errors and fixes

### `SQLITE_BUSY: database is locked`

A second writer arrived before the first released the file lock.
Most common causes:

* No `busy_timeout` set, so SQLite raises immediately instead of
  retrying. **Fix:** `PRAGMA busy_timeout = 5000` at connect.
* A long-running read transaction holding a snapshot. WAL writers can
  proceed, but checkpoint can't truncate. **Fix:** keep read
  transactions short; close result iterators.
* Two processes writing the same file. SQLite serialises them; if the
  contention is real (not just slow), the right fix is to funnel
  writes through one process.
* A `:memory:` DB shared across two connections. They're actually
  *separate* DBs — you didn't share state, you forked it. **Fix:**
  use `file::memory:?cache=shared` or a file.

Maps to forge's `P2034` error code.

### `SQLITE_BUSY_SNAPSHOT` in WAL mode

A reader started a transaction, and by the time it tries to upgrade
to a writer, the WAL has been checkpointed past the reader's
snapshot. **Fix:** start writes with `BEGIN IMMEDIATE` so the lock
upgrade happens before the read, not after.

### `malformed database schema (X) - near "Y": syntax error`

Almost always a corrupted `sqlite_master` row. Causes:

* Mid-DDL crash (very rare in WAL mode).
* External tooling that wrote into the file (don't).
* SQLite engine version downgrade — the file was written by a newer
  build that emitted DDL the older build can't parse.

**Fix:** restore from backup. `VACUUM INTO 'fresh.db'` against the
corrupted file may rebuild it if the corruption is metadata-only.

### `FOREIGN KEY constraint failed`

* PRAGMA wasn't on. forge sets it at connect; if you're injecting a
  driver, re-set it yourself.
* A cascade chain referenced a row that didn't exist. The cascade was
  trying to do its job. **Fix:** verify the referential graph.
* You set `foreign_keys = ON` mid-transaction. The setting takes
  effect at the *next* tx, not the current one.

Maps to `P2003`.

### `SQLITE_CANTOPEN: unable to open database file`

* File path doesn't exist or isn't writable. **Fix:** check
  permissions / mount.
* Process running as the wrong user.
* Network filesystem refusing the lock (NFS, SMB). **Fix:** move to
  local disk.

Maps to `P1001`.

### `attempt to write a readonly database`

* The OS marked the file read-only (chmod).
* You opened the file with the driver's read-only flag.
* The volume mount is read-only.

### `no such column: X` after a schema change

You added a field to the schema but didn't run migration. **Fix:**
`forge push` (CLI) or `await db.$migrate()` (runtime). See
[MIGRATIONS.md](./MIGRATIONS.md).

### `database disk image is malformed`

Real corruption. Causes: power loss on `synchronous = OFF`, hardware
failure, an external process truncating the file. **Fix:** restore
from backup. `PRAGMA integrity_check` confirms; `.recover` (the
sqlite3 CLI tool) can salvage some rows.

The forge error map (`src/adapters/sqlite/errors.ts`) translates
these into Prisma-style P-codes so `db.User.create(...)` throws a
`DbKnownError` with a stable `code` field — catch on `P2002`
(unique), `P2003` (FK), `P2034` (busy), `P1001` (i/o), and so on,
regardless of the underlying SQLite version's error message wording.

---

## Cross-links

* [DRIVERS.md](./DRIVERS.md) — the cross-driver port reference,
  including `SqliteDriver` and worked wrappers for every shipped
  client.
* [BROWSER.md](./BROWSER.md) — sqlite-wasm + OPFS, multi-tab safety,
  the worker file, `db.$migrate()` semantics, and the pro wasm build.
* [MOBILE.md](./MOBILE.md) — expo-sqlite, op-sqlite, Capacitor, Tauri,
  React Native specifics, on-device migration.
* [MIGRATIONS.md](./MIGRATIONS.md) — `forge push`, `forge diff`,
  per-dialect emit tables (including the SQLite rebuild dance), CI
  workflows.
* [BACKUP-RESTORE.md](./BACKUP-RESTORE.md) — backup story across
  Postgres, MySQL, SQLite, Mongo; PITR pipelines; restore drills.
* [MULTI-TENANT.md](./MULTI-TENANT.md) — DB-per-tenant vs row-level-
  tenant patterns.
* [SHARDING.md](./SHARDING.md) — horizontal partitioning, routing
  layers, cross-shard query patterns.
* [FTS.md](./FTS.md) — full-text search on SQLite (FTS5) and the
  other engines.
* [GEO.md](./GEO.md) — `f.geoPoint()`, R-Tree on SQLite, SpatiaLite
  loading.
* [VECTOR.md](./VECTOR.md) — `f.vector()`, sqlite-vec, the vec0
  virtual table.
* [TRANSACTIONS.md](./TRANSACTIONS.md) — `$transaction` semantics
  across drivers; SQLite's BEGIN / IMMEDIATE / DEFERRED.
* [DOCTOR.md](./DOCTOR.md) — `forge doctor` and `db.$doctor()` for
  SQLite environments.
