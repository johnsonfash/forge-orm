---
title: "Install and pick your driver"
---

## Install and pick your driver

forge ships no database driver of its own. You install only the driver for the
database you use. Each one is an optional peer dependency, so `npm install
forge-orm` on its own pulls nothing extra, and importing forge needs no driver
at all.

| Database          | Connection string starts with     | Install                       |
| ----------------- | ---------------------------------- | ----------------------------- |
| PostgreSQL        | `postgres://` or `postgresql://`   | `npm install pg`              |
| PGlite (embedded PG) | `pglite:` (e.g. `pglite:./data`)  | `npm install @electric-sql/pglite` |
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

See more — **[docs/DRIVERS.md](/reference/drivers)** for the bring-your-own-driver pattern, every shipped wrapper, six worked wrappers (Neon HTTP, Turso, Cloudflare D1, Atlas Data API, Bun:sqlite, logging decorator), capability flags, and per-driver perf notes.

---
