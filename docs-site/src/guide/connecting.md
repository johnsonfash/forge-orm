---
title: "Connecting"
---

## Connecting

`createDb` always takes your schema plus something that tells forge how to
reach the database. There are three ways to give it that, and it returns the
same typed `db` handle — properties matching your model names — whichever you
pick. Everything else in this README reads the same afterwards.

The choice between them is about bundling, not taste. A URL is resolved at
runtime, a per-dialect entry point is resolved at build time, and a driver you
construct yourself was never forge's to resolve.

| Situation | Use |
|---|---|
| Node server, script, tests | `url` |
| Bundled Node — Lambda, Next.js/Vite SSR, esbuild | `forge-orm/<dialect>` |
| Cloudflare Workers, Vercel Edge | `driver`, with an HTTP client (Neon, PlanetScale, libSQL) |
| Client needs configuring (pool, SSL, extensions, HTTP driver) | `driver` |
| A client forge has no factory for | `driver` |

### Option 1 — `url` (the default)

```ts
import { createDb } from 'forge-orm';

const db = await createDb({
  url: process.env.DATABASE_URL!,   // postgres://… | mysql://… | sqlite:… | duckdb:… | mssql:… | mongodb://…
  schema: { user: User, post: Post },
});

// later, when shutting down:
await db.$disconnect();
```

forge reads the prefix, works out which adapter that means, and loads it. This
is the shortest call site, and it is the only one where a single environment
variable moves you from SQLite in tests to Postgres in production with no code
change at all.

The mechanism is worth knowing, because it is what limits this option. forge
calls `require(pkg)`, where `pkg` is a string computed at runtime from the URL
prefix. A bundler cannot see through a computed require: webpack, rollup,
esbuild and Vite all lose the dependency at that line. On a bundled target —
Cloudflare Workers, Vercel Edge, a Lambda you bundle — the driver is either
left out of the output or blows up at runtime, a long way from the code that
caused it. The same opacity is why no adapter can be tree-shaken here; the
bundler cannot prove you are not about to ask for the other five.

None of that bites when `node_modules` is still on disk at runtime. Ordinary
Node servers, scripts and test runs are exactly that case, and `url` is the
right answer for them.

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

### Option 2 — a per-dialect entry point (new in 2.17.0)

Import `createDb` from the entry point for the database you are on, then call
it exactly as in option 1:

```ts
import { createDb, f, model } from 'forge-orm/postgres';

const User = model('users', { id: f.id(), email: f.string().unique() });
const db = await createDb({ url: process.env.DATABASE_URL!, schema: { user: User } });
```

Inside that entry, `pg` is brought in with a static `import`. A bundler sees it
the way it sees any other import, keeps it, and drops the adapters you did not
reach for. The call site is no longer than the default.

**This is for bundled Node, not for true edge runtimes.** A bundled Lambda, a
Next.js or Vite server build, a Docker image built with esbuild — those run
`pg` and `better-sqlite3` perfectly well and only ever had a bundler problem.
Cloudflare Workers and Vercel Edge are a different thing: `pg` needs a TCP
socket and `better-sqlite3` is a native addon, so neither runs there at all and
no amount of bundler visibility changes that. On those runtimes you need a
client built for them — Neon or PlanetScale over HTTP, libSQL, postgres.js —
and you reach those through option 3, which was never bundler-hostile in the
first place, because there you write the `import` yourself.

What you give up is the environment-variable swap. `forge-orm/postgres` is a
Postgres call site; pointing `DATABASE_URL` at MySQL changes the connection
string but not the driver the module has already committed to. Swapping
database now means editing the import.

Available entries: `forge-orm/postgres`, `forge-orm/mysql`, `forge-orm/sqlite`,
`forge-orm/pglite`, `forge-orm/mongo`, `forge-orm/duckdb`, `forge-orm/mssql` —
one per **package**, each wrapping that dialect's default driver (`pg`,
`mysql2`, `better-sqlite3`, PGlite, the mongodb client, `@duckdb/node-api`,
`mssql`).

Per package, not per dialect, and `pglite` is why. PGlite *is* Postgres — forge
runs it on the postgres adapter, same compiler, same executors, same dialect;
only the driver differs, because one talks to a server over TCP and the other
is a WebAssembly module in your own process. They are the same database and two
different npm packages, and a static import can only pin one. A single
`forge-orm/postgres` that imported both would put a WASM Postgres into every
bundle that only wanted `pg`, which is the opposite of the point.

SQLite makes the same point louder: one dialect, six packages, all of them the
sqlite adapter with identical queries and identical SQL. No two can share an
entry point, because each would drag in a package the others cannot even load —
`forge-orm/sqlite` is the better-sqlite3 one, which is why it belongs on a
server and nowhere else.

Fifteen driver packages sit behind the six dialects:

| Dialect | Packages | Default (the entry point) | The rest — option 3 |
|---|---|---|---|
| SQLite | 6 | `better-sqlite3` | `expo-sqlite`, OP-SQLite, `@libsql/client`, `@sqlite.org/sqlite-wasm`, `@tauri-apps/plugin-sql` |
| Postgres | 3 | `pg` | `postgres.js`, `@electric-sql/pglite` (its own entry — see below) |
| MySQL | 3 | `mysql2` | `mariadb`, `@planetscale/database` |
| MongoDB | 1 | `mongodb` | your own `MongoClient` — DocumentDB, Cosmos, FerretDB |
| DuckDB | 1 | `@duckdb/node-api` | — |
| SQL Server | 1 | `mssql` | — |
| IndexedDB | 0 | none — `forge-orm/indexeddb`, built into the browser | — |

Nothing in the last column is second-class for being there. `driver:` is how a
React Native app, a Turso deployment or a browser tab was always going to
connect, and it is the only form that lets you configure the client.

The same logic covers the pg-compatible clients that are not here — postgres.js,
Neon, Supabase's pooler. They all speak Postgres and forge treats them as
Postgres, but each is its own package, and you are importing it yourself
anyway, so they go through option 3:

```ts
import postgres from 'postgres';
import { createDb, postgresJsDriver } from 'forge-orm';

const db = await createDb({ schema, driver: postgresJsDriver(postgres(url)) });
```

There is deliberately none for the alternative drivers in the table under
option 3 — postgres.js, MariaDB, PlanetScale, libSQL, Expo, OP-SQLite, Tauri.
That is not an omission. An entry point exists to make a driver visible to a
bundler when *forge* is the one choosing the package; the moment you pick a
non-default client you are importing it yourself, and a static import is what
you already have. `forge-orm/libsql` would save you one line and add a module
to keep in step with somebody else's releases.

Each dialect entry re-exports everything the main entry exports — `f`, `model`,
`rel`, the type helpers, the driver factories — so a single import line covers
a whole file and you never end up pulling forge in from two places.

One caveat: a dialect entry still takes a `url`, so it configures the
connection and nothing else. If the client itself needs options, that is
option 3.

**Do not reach for a dialect entry off the server.** `forge-orm/sqlite` pulls
in `better-sqlite3`, a native Node addon: import it from a React Native app and
Metro fails on a module that cannot exist there, and in a browser bundle it is
the same story. Those targets are not an afterthought — they have entry points
and drivers of their own, and the full map is:

| Target | Import | Driver |
|---|---|---|
| Node, driver chosen at runtime | `forge-orm` | resolved from the URL prefix |
| Bundled Node (Lambda, SSR, esbuild) | `forge-orm/postgres` `/mysql` `/sqlite` `/pglite` `/mongo` | that dialect's default, statically imported |
| Browser — SQLite over OPFS | `forge-orm/wasm` (+ `/wasm/worker`, `/wasm/vite`, `/wasm/next`, `/wasm/webpack`) | `wasmSqliteDriver` |
| Browser — zero install | `forge-orm/indexeddb` | built in, no package |
| React Native (Expo) | `forge-orm` | `driver: expoSqliteDriver(…)` |
| React Native (bare) | `forge-orm` | `driver: opSqliteDriver(…)` |
| Tauri 2 desktop + mobile | `forge-orm` | `driver: tauriSqlDriver(…)` |
| Cloudflare Workers, Vercel Edge | `forge-orm` | `driver:` with an HTTP client — Neon, PlanetScale, libSQL |
| DuckDB, SQL Server | `forge-orm/duckdb`, `forge-orm/mssql` | `@duckdb/node-api`, `mssql`, statically imported |

Everything in the right-hand column of the last five rows goes through option 3,
and none of them wants an entry point: you are importing the client yourself
already, so the import is static and the bundler — Metro included — can see it.
The entry points exist for the one case where forge, not you, picks the
package.

<a id="pluggable-drivers"></a>

### Option 3 — `driver` (bring your own client)

All six databases ship a sensible default driver, and all six let you swap in
another client — for React Native, edge / serverless runtimes, or a managed /
API-compatible backend. Instead of a URL you open the client yourself (you own
its config and lifecycle), wrap it with one of forge's driver factories, and
pass it as `driver`. The query API is identical whichever client backs it.

```ts
const db = await createDb({ schema, driver: someDriver(client) });   // no url needed
```

This is required, not merely preferred, whenever the client needs configuring,
because a connection string has nowhere to put that: pool size, SSL or TLS
settings, statement and connection timeouts, the HTTP drivers Neon and
PlanetScale use over their serverless endpoints, PGlite extensions, or a
`MongoClient` you already share with the rest of the app. It is also how you
use a client forge ships no factory for — you write the construction, so forge
never needs to know the package exists. And because that import is yours and
static, this option bundles as cleanly as option 2 does.

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
