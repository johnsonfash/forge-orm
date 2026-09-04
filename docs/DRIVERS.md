# Bring-your-own-driver

The complete reference for the driver ports — what every kind looks
like, what forge ships, and how to wrap a new client without forking
the adapter.

* [Why bring-your-own-driver exists](#why-bring-your-own-driver-exists)
* [Per-kind port shape](#per-kind-port-shape) — [`SqliteDriver`](#sqlitedriver), [`PostgresDriver`](#postgresdriver), [`MysqlDriver`](#mysqldriver), [`MongoDriver`](#mongodriver), [`DuckdbDriver`](#duckdbdriver), [`MssqlDriver`](#mssqldriver)
* [The shipped wrappers — quick map](#the-shipped-wrappers--quick-map)
* [Wrapping a new sqlite / postgres / mongo driver](#wrapping-a-new-sqlite-driver)
* [Wire-compatible swaps](#wire-compatible-swaps)
* [Driver detection guards](#driver-detection-guards)
* [The two-call shape: URL vs driver](#the-two-call-shape-url-vs-driver)
* [Edge runtimes](#edge-runtimes)
* [Adapter capabilities](#adapter-capabilities)
* [Driver smoke harness](#driver-smoke-harness)
* [Per-driver perf notes](#per-driver-perf-notes)
* [Connection pooling per driver](#connection-pooling-per-driver)
* [Driver + transaction semantics](#driver--transaction-semantics)
* [Six worked wrappers](#six-worked-wrappers)
* [Common bugs](#common-bugs)

---

## Why bring-your-own-driver exists

Adapters are stable. Engines aren't.

forge has one adapter per database. Each adapter owns its dialect, its IR
compiler, its DDL emitter, and its introspection reader. None of those
change when the underlying client library changes. What changes is the
*driver* — the thin layer that turns "here is a SQL string and an array
of params" into "here are rows".

The driver landscape moves fast: PG-compatible serverless engines (Neon,
CockroachDB, Yugabyte), SQLite forks and hosts (Turso/libsql, Cloudflare
D1), embedded targets (Expo, op-sqlite, Tauri, Bun, sqlite-wasm), HTTP
clients (PlanetScale, RDS Data API), and Mongo-API backends (DocumentDB,
Cosmos, FerretDB) that all implement different subsets of the upstream
surface.

A bring-your-own-driver port keeps adapter and engine independent.
The IR compiles to the same SQL whether you run it through `pg`
against localhost, `@neondatabase/serverless` against Neon, or a
custom shim against RDS Data API. Only the bottom 50 lines change.
Each driver is a small interface (4–6 methods); you implement the
surface the executor talks to and you are done.

For the high-level intro see [Pluggable drivers](../README.md#pluggable-drivers).
For browser-specific concerns see [BROWSER](./BROWSER.md). For mobile
targets see [MOBILE](./MOBILE.md).

---

## Per-kind port shape

Every port is in `src/adapters/<kind>/driver.ts`. Two pieces: the
`<Kind>Driver` interface the executor calls, and a (sometimes empty)
`<Kind>Queryable` interface the transaction callback receives. The
queryable is the narrow view — methods that have to work on a session
as well as on the pool.

### `SqliteDriver`

```ts
// src/adapters/sqlite/driver.ts
export interface SqliteDriver {
  readonly kind: 'sqlite';
  all(sql: string, params: unknown[]): Promise<any[]>;
  get(sql: string, params: unknown[]): Promise<any>;
  run(sql: string, params: unknown[]):
    Promise<{ changes: number; lastInsertRowid?: number | bigint }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  iterate?(sql: string, params: unknown[]):
    AsyncIterable<any> | Iterable<any>;
}
```

Contracts:

* **`all`** — every row as a plain object keyed by column name; empty
  array on no match, never `null`. Clients that return tuples plus a
  `columns` array (libsql) must assemble objects before resolving —
  `decodeRow` walks `Object.keys()` and would pick up numeric indices.
* **`get`** — first row or `undefined`. Never throw on no match.
* **`run`** — DML / DDL with no rows. `{ changes, lastInsertRowid }`;
  `changes` required, `lastInsertRowid` omitted when nothing inserted.
  The id is `number | bigint` because better-sqlite3 hands back bigint
  under safe-integer mode.
* **`exec`** — multi-statement SQL script (`CREATE TABLE …; CREATE INDEX …;`).
* **`close`** — release the handle. Idempotent.
* **`iterate`** — optional. When present the executor streams instead
  of materialising; better-sqlite3 uses `stmt.iterate()`. Async drivers
  can skip it.

Async drivers (libsql, expo-sqlite, the wasm worker) must serialise
calls — SQLite is single-writer at the file level. The wasm driver
queues through a promise chain for this reason.

### `PostgresDriver`

```ts
// src/adapters/postgres/driver.ts
export interface PgQueryable {
  query(sql: string, params?: unknown[]):
    Promise<{ rows: any[]; rowCount: number }>;
}

export interface PostgresDriver extends PgQueryable {
  readonly kind: 'postgres';
  transaction<T>(fn: (session: PgQueryable) => Promise<T>): Promise<T>;
  stream?(sql: string, params: unknown[]): AsyncIterable<any>;
  close(): Promise<void>;
}
```

Contracts:

* **`query`** — `{ rows, rowCount }`. `rowCount` is rows affected for
  DML, rows returned for SELECT. Fall back to `rows.length`.
* **`transaction`** — pin a connection, `BEGIN`, run `fn` with a
  queryable bound to that connection, `COMMIT` on resolve, `ROLLBACK`
  on throw. Release in `finally`. The session is what forge threads
  through `ExecOpts.session`.
* **`stream`** — optional. The default `pg` driver runs a real
  server-side cursor (`DECLARE … CURSOR`, `FETCH 200`, `CLOSE`).
  Skip it and forge falls back to OFFSET/LIMIT chunking.
* **`close`** — `pool.end()` or equivalent. Idempotent.

The `PgQueryable` carve-out matters: both the driver and the
in-transaction session implement `query`, so executor code never has
to branch on "am I in a transaction".

### `MysqlDriver`

```ts
// src/adapters/mysql/driver.ts
export interface MysqlQueryable {
  query(sql: string, params?: unknown[]): Promise<[any, any]>;
  execute(sql: string, params?: unknown[]): Promise<[any, any]>;
}

export interface MysqlDriver extends MysqlQueryable {
  readonly kind: 'mysql';
  transaction<T>(fn: (session: MysqlQueryable) => Promise<T>): Promise<T>;
  stream?(sql: string, params: unknown[]): AsyncIterable<any>;
  close(): Promise<void>;
}
```

The tuple shape is mysql2-native: `query` returns `[rows, fields]`
for SELECT, `[result, fields]` for DML where `result` carries
`affectedRows` and `insertId`. `execute` is the prepared-statement
path. Clients that don't distinguish (PlanetScale) alias both to the
same call.

### `MongoDriver`

```ts
// src/adapters/mongo/driver.ts
export interface MongoDriver {
  readonly kind: 'mongo';
  client: any;       // a MongoClient (or a shim that quacks like one)
  dbName?: string;   // defaults to the URI's default DB
}
```

Mongo has one canonical client library, so the port is "bring your
own configured `MongoClient`". The adapter calls `client.connect()`
(idempotent), `client.db(dbName)`, and the collection methods.
DocumentDB / Cosmos clients qualify if they implement `.db()`,
`.startSession()`, and collection CRUD.

The factory checks for `.db()` and throws if you hand it something
else.

### `DuckdbDriver`

```ts
// src/adapters/duckdb/driver.ts
export interface DuckdbQueryResult {
  rows: any[];
  rowCount?: number;
}

export interface DuckdbDriver {
  readonly kind: 'duckdb';
  query(sql: string, params?: unknown[]): Promise<DuckdbQueryResult>;
  transaction<T>(fn: (qc: DuckdbQueryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

Same shape as Postgres minus stream. `rowCount` is optional —
DuckDB's Node API throws on `getRowObjects()` for DML without
`RETURNING`, so the built-in catches it and returns `{ rows: [] }`.
The other gotcha is param coercion: the wrapper stringifies JSON
objects, ISO-formats `Date`, and leaves `null` alone — DuckDB's
binding layer rejects untyped values.

### `MssqlDriver`

```ts
// src/adapters/mssql/driver.ts
export interface MssqlQueryResult {
  rows: any[];
  rowCount?: number;
}

export interface MssqlDriver {
  readonly kind: 'mssql';
  query(sql: string, params?: unknown[]): Promise<MssqlQueryResult>;
  transaction<T>(fn: (qc: MssqlQueryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

Same shape again. The named-parameter quirk lives inside the wrapper:
the dialect emits `@p1, @p2, …` and the wrapper calls
`request.input('p1', value)` per positional param. A custom driver
must mirror that — the SQL always uses `@p<N>` placeholders, never
`?` or `$1`.

---

## The shipped wrappers — quick map

| Kind | Wrapper | Use when | Install |
|---|---|---|---|
| sqlite | `betterSqlite3Driver` | Node default, fastest local | `npm i better-sqlite3` |
| sqlite | `expoSqliteDriver` | Expo / managed RN (SDK 51+) | `npx expo install expo-sqlite` |
| sqlite | `opSqliteDriver` | Bare React Native, large workloads | `npm i @op-engineering/op-sqlite` |
| sqlite | `libsqlDriver` | Turso, edge, libsql forks | `npm i @libsql/client` |
| sqlite | `wasmSqliteDriver` | Browser + OPFS via Web Worker | `npm i @sqlite.org/sqlite-wasm` |
| postgres | `pgDriver` | Default. Long-lived, real cursors | `npm i pg` |
| postgres | `postgresJsDriver` | Faster simple queries on Node 20+ | `npm i postgres` |
| mysql | `mysql2Driver` | Default. Promise pool | `npm i mysql2` |
| mysql | `mariadbDriver` | Faster on large rowsets | `npm i mariadb` |
| mysql | `planetscaleDriver` | PlanetScale over fetch | `npm i @planetscale/database` |
| mongo | `mongoDriver` | Any `MongoClient` | `npm i mongodb` |
| duckdb | `duckdbDriver` | Embedded analytics, MotherDuck | `npm i @duckdb/node-api` |
| mssql | `mssqlDriver` | SQL Server, Azure SQL, SQL Edge | `npm i mssql` |

Each is a function that takes the underlying client and returns the
port. You own the client's lifecycle — forge doesn't instantiate it.

---

## Wrapping a new sqlite driver

`tauriSqlDriver` (shipped as of 2.6.3) wraps `@tauri-apps/plugin-sql`.
The plugin gives you async `execute(sql, params)` and `select(sql, params)`
against sqlx on the Rust side; the port normalises the return shape to
the SqliteDriver contract and splits multi-statement DDL because tauri's
execute runs one statement at a time.

```ts
import Database from '@tauri-apps/plugin-sql';
import { createDb, tauriSqlDriver } from 'forge-orm';

const sqlite = await Database.load('sqlite:app.db');
export const db = await createDb({ schema, driver: tauriSqlDriver(sqlite) });
await db.$migrate();  // runtime DDL, same as wasm/expo
```

If you'd rather write your own wrapper (older forge, custom auth
plumbing on top of the plugin's execute), the source is intentionally
short — copy from `src/adapters/sqlite/driver.ts` under the
`tauriSqlDriver` block.

Five things any sqlite driver wrapper has to get right:

1. **Async wrapping.** Declare every method `async` even when the
   underlying call is sync (better-sqlite3 is). The executor `await`s.
2. **Parameter binding.** The IR emits `?` placeholders for SQLite;
   pass `params` straight through. Don't coerce strings/booleans/numbers —
   the client handles those. Check whether the client treats `null` or
   `undefined` as "skip parameter".
3. **Error passthrough.** Don't wrap errors. The adapter's `errors.ts`
   parses `err.message` to translate codes into `UniqueViolation`,
   `ForeignKeyViolation`, etc.
4. **BigInt handling.** `lastInsertRowid` may exceed
   `Number.MAX_SAFE_INTEGER`. Return whatever the client gave you;
   the type is `number | bigint`.
5. **Close idempotency.** May be called twice. `db.close?.()` is the
   pattern.

You can run `db.$migrate()` on any sqlite driver — including
`tauriSqlDriver` — to apply the schema at runtime. See
[BROWSER](./BROWSER.md#runtime-migrate).

---

## PGlite — built in, since 2.14.0

PGlite has a URL of its own, so nothing below is needed to use it:

```ts
const db = await createDb({ url: 'pglite:./data', schema })   // on disk
const db = await createDb({ url: 'pglite:', schema })          // ephemeral
```

forge imports `@electric-sql/pglite` lazily — it is never a hard
dependency — and builds the driver itself. PGlite speaks Postgres, so
everything downstream is the postgres adapter unchanged.

`db.$migrate()` works on it too (2.15+), so an embedded database can
create its own schema at boot without a CLI:

```ts
const db = await createDb({ url: 'pglite:./data', schema })
await db.$migrate()
```

Before 2.14.0 there was no `pglite:` prefix, and that URL failed with
*"Could not infer adapter from URL"*. The hand-rolled wrapper below was
the only way, which is why it is still documented: build your own
instance when you need constructor options (extensions, a custom
filesystem, a shared worker), then pass it in.

```ts
import { createDb, pgliteDriver } from 'forge-orm';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';

const pg = await PGlite.create('./data', { extensions: { vector } });
const db = await createDb({ driver: pgliteDriver(pg), schema });
```

---

## Wrapping a new postgres driver

Walk-through: `pglite` (in-browser PG). It exposes async
`query(sql, params)` → `{ rows, affectedRows, fields }`. No pool —
one in-process DB — so the "session" is the same instance.

```ts
import type { PostgresDriver, PgQueryable } from 'forge-orm';
import { PGlite } from '@electric-sql/pglite';

export function pgliteDriver(pg: PGlite): PostgresDriver {
  const queryable: PgQueryable = {
    query: async (sql, params) => {
      const r = await pg.query(sql, params as any[]);
      return {
        rows: r.rows as any[],
        rowCount: (r.affectedRows ?? r.rows.length) as number,
      };
    },
  };
  return {
    kind: 'postgres',
    query: queryable.query,
    transaction: async (fn) => {
      await pg.query('BEGIN');
      try {
        const out = await fn(queryable);
        await pg.query('COMMIT');
        return out;
      } catch (err) {
        try { await pg.query('ROLLBACK'); } catch { /* swallow */ }
        throw err;
      }
    },
    close: async () => { await pg.close(); },
  };
}
```

Notes:

* **Pool emulation.** pglite is single-process; for Neon WebSocket
  the built-in `pgDriver` works directly (Neon's Pool matches
  `pg.Pool`).
* **`RETURNING`.** PG returns rows in `rows` on `RETURNING` — don't
  filter them out. Some clients route DML and SELECT through
  different methods.
* **`rowCount`.** Fall back to `rows.length` when undefined.

---

## Wrapping a new mongo driver

The simplest port — pass an object with `.db()` and `kind: 'mongo'`.
The adapter calls `client.connect()` and
`client.db(dbName).collection(name)`. Anything that quacks like
`MongoClient` fits.

```ts
import type { MongoDriver } from 'forge-orm';

export function cosmosDriver(client: any, dbName: string): MongoDriver {
  return { kind: 'mongo', client, dbName };
}
```

The interesting work is *feature-flag detection*, not the port.
DocumentDB, Cosmos, and FerretDB each implement a subset of the
aggregation pipeline:

| Stage / op | Mongo native | DocumentDB | Cosmos | FerretDB |
|---|---|---|---|---|
| `$expr` | Yes | Partial | Yes | Yes |
| `$lookup` | Yes | Yes | No | Yes |
| `$vectorSearch` | Atlas only | No | No | No |
| `$geoNear` | Yes | Partial | Yes | Partial |
| Change streams | Yes | Yes | No | No |
| Multi-document tx | Replica set | No | Limited | No |

forge's `capabilities` flags are kind-level, not vendor-level — a
swap to Cosmos throws at runtime if app code uses change streams.
Build against native MongoDB in dev, run the same tests against the
target in CI, surface missing features at the application layer.

---

## Wire-compatible swaps

Many databases speak the wire protocol of one of the six. Point the
existing driver at them — no new port needed:

| Database | Adapter | Driver |
|---|---|---|
| CockroachDB, YugabyteDB, Neon, Supabase, TimescaleDB | postgres | `pgDriver` (Neon via `@neondatabase/serverless` Pool) |
| TiDB, Vitess | mysql | `mysql2Driver` |
| AWS DocumentDB, Azure Cosmos (Mongo API), FerretDB | mongo | `mongoDriver(new MongoClient(uri))` |
| Turso | sqlite | `libsqlDriver` |
| MotherDuck | duckdb | `duckdbDriver` against MD token URL |
| Azure SQL, Azure SQL Edge | mssql | `mssqlDriver` (Edge is the ARM-Mac test fallback) |

Worked example — Neon serverless WebSocket:

```ts
import { Pool } from '@neondatabase/serverless';
import { createDb, pgDriver } from 'forge-orm';

// Neon's Pool matches pg.Pool's surface — pgDriver wraps it directly.
const pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL! });
export const db = await createDb({ schema, driver: pgDriver(pool) });
```

Neon also ships an HTTP transport for Workers (`neon(connString)`).
The HTTP surface is ``sql`…``` template-tagged, not pool-shaped, so
it needs a thin wrapper — see the Neon HTTP example below.

---

## Driver detection guards

Each driver file exports a type-guard:

```ts
import {
  isSqliteDriver, isPostgresDriver, isMysqlDriver,
  isMongoDriver, isDuckdbDriver, isMssqlDriver,
} from 'forge-orm';
```

Use them in helper code that takes a `ForgeDriver` union and branches
on kind (logging decorators, multi-driver tooling). The implementation
is a tag check plus a method probe:

```ts
export function isPostgresDriver(v: unknown): v is PostgresDriver {
  return !!v && typeof v === 'object' && (v as any).kind === 'postgres' &&
    typeof (v as any).query === 'function' &&
    typeof (v as any).transaction === 'function';
}
```

Don't reach for them in model or query code — `db` is already typed
by adapter kind; the executor knows which port it's calling.

---

## The two-call shape: URL vs driver

`createDb` takes either a URL or a pre-built driver, sometimes both.

```ts
// (a) URL only — forge picks the default driver from the prefix.
await createDb({ url: process.env.DATABASE_URL!, schema });

// (b) Driver only — you wrapped the client; forge reads driver.kind.
await createDb({ schema, driver: pgDriver(myPool) });

// (c) URL + driver — URL is a label / diagnostic hint, driver runs queries.
await createDb({
  url: 'postgres://neon.tech/app',
  schema,
  driver: pgDriver(new Pool({ connectionString })),
});
```

When each is right:

* **URL only** for the 90% case: long-lived Node, default driver.
  forge picks the package via `DRIVER_PACKAGE_FOR[kind]` and tells
  you what to install if it's missing.
* **Driver only** when you own the client lifecycle — edge (no
  socket pool), React Native (host owns the handle), tests, or any
  config forge doesn't expose (TLS callback, IAM auth).
* **URL + driver** for diagnostics. The URL feeds
  `DoctorReport.connectionString` and error messages; forge never
  opens it.

Detection rules (`src/adapters/detect.ts`):

```
mongodb:// mongodb+srv://    → mongo
postgres:// postgresql://    → postgres
mysql:// mariadb://          → mysql
sqlite: file:                → sqlite
opfs: opfs-sahpool: :memory: → sqlite (wasm)
duckdb:                      → duckdb
mssql:// sqlserver://        → mssql
*.db *.sqlite                → sqlite
*.duckdb                     → duckdb
```

If detection fails, pass `type: 'postgres'` (or similar) explicitly.

---

## Edge runtimes

Cloudflare Workers, Vercel Edge, Deno Deploy, and Bun serverless all
share one constraint: no persistent connection. The pool pattern is
wrong — wrap an HTTP transport and build the driver per-request.

Driver-by-runtime:

| Runtime | Postgres | MySQL | SQLite |
|---|---|---|---|
| Cloudflare Workers | `@neondatabase/serverless` (HTTP) | `@planetscale/database` (HTTP) | D1 binding |
| Vercel Edge | `@neondatabase/serverless` | `@planetscale/database` | n/a |
| Deno Deploy | `@neondatabase/serverless` | `@planetscale/database` | n/a |
| Bun | `pg` or `postgres` | `mysql2` | `bun:sqlite` |
| Browser | n/a | n/a | `wasmSqliteDriver` |

`forge push` / `applyMigration` (DDL) still assume the default driver
and a long-lived process. On the edge, run migrations from CI or a
`node` job, not from the request handler.

---

## Adapter capabilities

`Adapter.capabilities` is the per-kind feature matrix. Defined in
`src/adapters/types.ts`:

```ts
export interface AdapterCapabilities {
  nativeCascades: boolean;
  nativeUpsert: boolean;
  nullsOrdering: boolean;
  jsonPath: boolean;
  transactionsRequireReplicaSet: boolean;
}
```

* **`nativeCascades`** — SQL: yes. Mongo: no (forge emulates).
* **`nativeUpsert`** — all six return true (PG `ON CONFLICT`, MySQL
  `ON DUPLICATE KEY`, MSSQL `MERGE`, Mongo `findOneAndUpdate`).
* **`nullsOrdering`** — `ORDER BY x ASC NULLS FIRST`. PG / SQLite /
  DuckDB / Mongo: yes. MSSQL via `CASE`. MySQL: app-side.
* **`jsonPath`** — all SQL adapters yes; Mongo treats dotted keys natively.
* **`transactionsRequireReplicaSet`** — Mongo only.

Flags are *kind-level*, not driver-level — `mongoDriver(cosmosClient)`
still reports `nativeCascades: false`. For vendor-level detail,
query `adapter.doctor()` and parse `notes`. The probe runs queries
through *your* driver, so its output reflects your client's view of
the database.

Browser drivers also have `browserDoctor()` that probes OPFS, SAB,
and persistent storage in addition to SQLite features. See
[BROWSER](./BROWSER.md#doctor).

---

## Driver smoke harness

`scripts/driver-smoke.mjs` installs every shipped driver into a
fresh tmpdir, runs connect-query-close against each, and tears
everything down. It verifies the underlying *clients* still install
and connect on the current Node / platform — independent of forge.

```sh
npm run smoke:drivers              # everything
npm run smoke:drivers -- --only=pg # filter by substring(s)
npm run smoke:drivers -- --keep    # keep the tmpdir on exit
```

When you write a new wrapper: add a row to the harness's driver list,
run `--only=<yourname>`, then gate CI on it. First run is slow (image
pulls); subsequent runs ~15 seconds on warm Docker.

For wire-compatible swaps (Neon, Cosmos, Turso) the smoke harness
isn't the right gate. Install the swap as a dependency in a side
project and run forge's `integration-*.ts` files against it.

---

## Per-driver perf notes

Numbers move with versions; tradeoff shapes don't:

| Pair | Faster on | Why |
|---|---|---|
| `pg` vs `postgres.js` | `postgres.js` for simple queries; `pg` for batched COPY | tighter result loop on Node 20+; binary protocol amortises bulk inserts |
| `mysql2` vs `mariadb` | `mariadb` on large rowsets; `mysql2` pool | ~20% decoder edge over >10k rows; mysql2 pool is battle-tested under concurrency |
| `better-sqlite3` vs `libsql` | better local; libsql replicated | sync + embedded vs. network + Turso replication |
| `expo-sqlite` vs `op-sqlite` | `op-sqlite` on large workloads | JSI zero-copy vs. RN bridge serialisation |
| `mongodb` vs DocumentDB / Cosmos | native always | 30–50% API-translation overhead |
| `@duckdb/node-api` vs `duckdb` | always `@duckdb/node-api` | the old npm package is unmaintained |

The smoke harness verifies install + connect, not throughput. For
real numbers, `bench/` has the scripts — run them against your
wrapper of choice.

---

## Connection pooling per driver

| Driver | Knob | Default | Override |
|---|---|---|---|
| `pg` | `max` on `new Pool` | 10 | Construct the pool, pass to `pgDriver(pool)` |
| `postgres.js` | `max` on `postgres()` | 10 | Pass via the `postgres()` call |
| `mysql2` | `connectionLimit` on `createPool` | 10 | Own the pool, pass `pool.promise()` |
| `mariadb` | `connectionLimit` on `createPool` | 10 | Own the pool |
| `mongodb` | `maxPoolSize` | 100 | Own the client |
| `mssql` | `pool.max` | 10 | Own the pool |
| `@duckdb/node-api` | n/a — one connection per instance | 1 | Open more connections from the same instance |
| `better-sqlite3` | n/a — single-writer file | 1 | Enable WAL for concurrent readers |

When to override: edge runtimes get pool size 1 (or none); a Node
webserver with 100 concurrent requests needs pool ≥ that floor (the
default-10 head-of-lines under load); long analytics go on a
separate pool so they don't starve OLTP.

Register `db.$disconnect()` from SIGTERM / SIGINT handlers —
`close()` is idempotent.

---

## Driver + transaction semantics

`db.$transaction(fn)` opens an adapter-level transaction and calls
`fn` with whatever the adapter threads back as `ExecOpts.session`:

| Kind | Session type |
|---|---|
| Postgres | `PgQueryable` bound to a pinned `PoolClient` |
| MySQL | `MysqlQueryable` (the `Connection` from `pool.getConnection()`) |
| SQLite | The driver itself — single-writer, no session split |
| Mongo | `ClientSession` from `client.startSession()` |
| DuckDB | `DuckdbQueryable` on the same connection |
| MSSQL | `MssqlQueryable` on a `Transaction` from `pool.transaction()` |

For a bring-your-own driver:

* Client exposes "pin connection, BEGIN, hand back session" → mirror
  the built-in shape.
* Client exposes a higher-level `conn.transaction(fn)` (PlanetScale,
  RDS Data API) → wrap that. The contract is "every call inside `fn`
  lands on the same transaction".
* Client *cannot* pin a session → throw from `transaction`. Don't
  fake it by buffering writes — that breaks read-your-own-writes.

Mongo transactions require a replica set;
`capabilities.transactionsRequireReplicaSet` is the flag.

---

## Six worked wrappers

### (a) Neon over HTTP

`@neondatabase/serverless` ships two surfaces: a `Pool` that mimics
`pg.Pool` (use `pgDriver` directly), and a tagged-template HTTP
transport optimised for Workers. For the HTTP surface:

```ts
import type { PostgresDriver } from 'forge-orm';
import { neon } from '@neondatabase/serverless';

export function neonHttpDriver(sql: ReturnType<typeof neon>): PostgresDriver {
  return {
    kind: 'postgres',
    query: async (text, params) => {
      const r = await sql.unsafe(text, (params ?? []) as any[]);
      return { rows: r as any[], rowCount: (r as any).rowCount ?? (r as any[]).length };
    },
    transaction: async () => {
      // HTTP-only — switch to the WebSocket Pool + pgDriver for transactions.
      throw new Error('[forge] neon HTTP transport does not support transactions');
    },
    close: async () => { /* stateless */ },
  };
}
```

Use it for single-round-trip reads; switch to the WebSocket Pool
(wired through `pgDriver`) the moment you need transactions.

### (b) Turso / libsql

Shipped — `libsqlDriver` is in the box. With auth token:

```ts
import { createClient } from '@libsql/client';
import { createDb, libsqlDriver } from 'forge-orm';

const client = createClient({
  url: process.env.TURSO_URL!,      // libsql://your-db.turso.io
  authToken: process.env.TURSO_TOKEN!,
});
export const db = await createDb({ schema, driver: libsqlDriver(client) });
```

Same driver on Node, Workers, Deno, and Bun. Replicas are read-only;
the client routes writes to the primary. If your edge runtime can't
hold a WebSocket, set `url` to the `https://…` form and libsql falls
back to per-request HTTP.

### (c) Cloudflare D1

D1 hands you a binding, not a socket. Wrap it as a `SqliteDriver`:

```ts
import type { SqliteDriver } from 'forge-orm';

export function d1Driver(d1: any): SqliteDriver {
  return {
    kind: 'sqlite',
    all: async (sql, params) =>
      (await d1.prepare(sql).bind(...params).all()).results,
    get: async (sql, params) =>
      (await d1.prepare(sql).bind(...params).first()) ?? undefined,
    run: async (sql, params) => {
      const r = await d1.prepare(sql).bind(...params).run();
      return { changes: r.meta.changes, lastInsertRowid: r.meta.last_row_id };
    },
    exec: async (sql) => { await d1.exec(sql); },
    close: async () => { /* D1 binding has no close */ },
  };
}

export default {
  async fetch(_req, env: { DB: any }) {
    const db = await createDb({ schema, driver: d1Driver(env.DB) });
    // …
  },
};
```

Caveat: `d1.exec(sql)` rejects on the first error in a multi-statement
script. If the migrator emits batches, split on `;` first.

### (d) MongoDB Atlas Data API (HTTP-only edge)

For Workers / Edge where you can't run native `mongodb`, the REST
surface (or a similar proxy) needs a shim that fakes
`client.db(name).collection(name)`:

```ts
import type { MongoDriver } from 'forge-orm';

function atlasShim(cfg: { endpoint: string; apiKey: string; dataSource: string }) {
  const call = async (action: string, body: object) => {
    const r = await fetch(`${cfg.endpoint}/action/${action}`, {
      method: 'POST',
      headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataSource: cfg.dataSource, ...body }),
    });
    if (!r.ok) throw new Error(`[atlas] ${action} ${r.status}: ${await r.text()}`);
    return r.json();
  };
  return {
    db: (dbName: string) => ({
      collection: (name: string) => ({
        insertOne: (doc: any) => call('insertOne', { database: dbName, collection: name, document: doc }),
        findOne:   (filter: any) => call('findOne',   { database: dbName, collection: name, filter }).then((r: any) => r.document),
        find:      (filter: any) => ({ toArray: async () => (await call('find', { database: dbName, collection: name, filter })).documents }),
        // … updateOne / updateMany / deleteOne / deleteMany / aggregate …
      }),
    }),
    connect: async () => { /* HTTP — no-op */ },
    close:   async () => { /* HTTP — no-op */ },
    startSession: () => { throw new Error('[atlas] no transactions on Data API'); },
  };
}

export function atlasDataDriver(cfg: Parameters<typeof atlasShim>[0], dbName: string): MongoDriver {
  return { kind: 'mongo', client: atlasShim(cfg), dbName };
}
```

Implement only the methods forge calls: `find`, `findOne`, `insertOne`,
`insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`,
`aggregate`, `countDocuments`, `createIndex`, `listIndexes`. Skip
change streams and transactions — surface them as errors.

(Atlas Data API itself was deprecated in 2024. Use the pattern with
a proxy service that holds the Mongo connection and exposes the HTTP
surface, or pick a runtime that can run the native driver.)

### (e) Bun `bun:sqlite`

Functionally identical to `betterSqlite3Driver` — Bun's API matches:

```ts
import type { SqliteDriver } from 'forge-orm';
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
```

Sync calls resolve immediately through the `async` wrapper.

### (f) Logging decorator

Wrap any base driver to add per-query timing without touching the
executor:

```ts
import type { PostgresDriver, PgQueryable } from 'forge-orm';

export function loggingPgDriver(base: PostgresDriver, label = 'pg'): PostgresDriver {
  const wrapQ = (q: PgQueryable, tag: string): PgQueryable => ({
    query: async (sql, params) => {
      const t0 = performance.now();
      try {
        const r = await q.query(sql, params);
        console.log(`[${label}:${tag}] ${(performance.now() - t0).toFixed(1)}ms  ${sql.slice(0, 120)}`);
        return r;
      } catch (err) {
        console.error(`[${label}:${tag}] FAIL ${(performance.now() - t0).toFixed(1)}ms  ${sql.slice(0, 120)}`);
        throw err;
      }
    },
  });
  return {
    kind: 'postgres',
    ...wrapQ(base, 'pool'),
    transaction: (fn) => base.transaction((sess) => fn(wrapQ(sess, 'tx'))),
    stream: base.stream,
    close: () => base.close(),
  };
}
```

Identical pattern for every kind: wrap the queryable, preserve the
tag, delegate `transaction`/`close`/`stream`. For most cases forge's
[`ForgeEmitter`](../README.md#errors) is the better lever — decorator
drivers are for things the emitter doesn't see (`$queryRaw` mid-tx)
or a no-config "log everything" knob.

---

## Common bugs

* **Passing a `Client` to `pgDriver` instead of a `Pool`.**
  `pgDriver` calls `pool.connect()` inside `transaction`; a single
  `Client` doesn't have that method. Symptom:
  `pool.connect is not a function`. Pass `new Pool({...})`.

* **better-sqlite3 `safeIntegers: true`.** Flips every integer
  column to `bigint`. forge doesn't auto-cast — declare `f.bigint()`
  on those columns, leave the flag off, or convert in
  `decodeOutbound`. The default driver does NOT enable it.

* **mysql2 `DECIMAL` returns strings.** mysql2's default preserves
  decimal precision by returning strings; forge's coercion only
  fires on writes. Construct the pool with `decimalNumbers: true`.

* **mariadb returns `BigInt` for `INT UNSIGNED`.** Pass
  `bigIntAsNumber: true, insertIdAsNumber: true` on the pool to
  match mysql2's shape.

* **Mongo driver swap that loses change streams.** Atlas + replica
  sets support `collection.watch()`; DocumentDB and Cosmos don't —
  the cursor returns and never emits. Probe
  `db.admin().serverStatus().repl` at startup and refuse to register
  watchers when it's missing.

* **libsql / Turso row indexing.** libsql rows carry both string
  *and* numeric keys, so `Object.keys(row)` returns
  `['0', '1', …, 'id', 'name', …]`. The built-in `libsqlDriver`
  rebuilds rows from `r.columns` to dodge this — mirror that in any
  custom wrapper.

* **DuckDB param types.** The Node API rejects `Date`, plain objects,
  and bare `null` at certain positions. The built-in wrapper
  stringifies objects, ISO-formats dates, and leaves `null` alone.
  A wrapper that skips this fails on timestamp filters and JSON eq.

* **MSSQL `@p1` placeholders left unbound.** The dialect emits
  `@p1, @p2, …`; you must bind each via `request.input('p1', v)`,
  not pass the array as `request.query(sql, params)`. Symptom:
  `Must declare the scalar variable "@p1"`.

* **`forge push` with a custom driver.** DDL still assumes the
  default driver. Run runtime queries through your custom driver
  and DDL through the default (or separately).

* **Forgetting `await` on `createDb`.** It's `async` regardless —
  the adapter still runs `connect()` and capability probing.
