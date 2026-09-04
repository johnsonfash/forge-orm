---
title: "Connecting"
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

Deep dive: **[docs/INDEXEDDB.md](/reference/indexeddb)**.

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
