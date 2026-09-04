---
title: "Sandbox / runnable examples"
---

## Sandbox / runnable examples

Try forge-orm without installing anything — every example is one click away on StackBlitz:

| Browser-runnable | One-liner |
|---|---|
| [SQLite browser todo](https://stackblitz.com/github/johnsonfash/forge-orm/tree/main/examples/01-sqlite-browser-todo) | OPFS-persisted todo app, no server |
| [Offline-first with sync outbox](https://stackblitz.com/github/johnsonfash/forge-orm/tree/main/examples/02-sqlite-browser-offline-first) | Optimistic writes + drain loop |
| [Node CLI (smallest)](https://stackblitz.com/github/johnsonfash/forge-orm/tree/main/examples/04-node-cli) | Smallest possible forge-orm program |
| [Hono + PGlite REST API](https://stackblitz.com/github/johnsonfash/forge-orm/tree/main/examples/05-hono-pglite-api) | Backend API, zero external DB |
| [Next.js + PGlite full-stack](https://stackblitz.com/github/johnsonfash/forge-orm/tree/main/examples/06-nextjs-pglite-fullstack) | App Router + Server Actions |
| [IndexedDB zero-install](https://stackblitz.com/github/johnsonfash/forge-orm/tree/main/examples/19-indexeddb-zero-install) | Full CRUD + geo + vector + FTS, no wasm |

| Auto-runs on CodeSandbox | Why |
|---|---|
| [DuckDB analytics](https://codesandbox.io/p/devbox/github/johnsonfash/forge-orm/examples/main/03-duckdb-cli-needs-vm) | `@duckdb/node-api` is a native addon |
| [Bun + SQLite blog](https://codesandbox.io/p/devbox/github/johnsonfash/forge-orm/examples/main/07-bun-cli-needs-vm) | Bun's SQLite is native |

| Feature deep-dives | Pattern |
|---|---|
| [Geo search](https://stackblitz.com/github/johnsonfash/forge-orm/tree/main/examples/08-geo-search) | `geoPoint` + `nearTo` (PostGIS / Mongo / wasm fallback) |
| [Vector RAG](https://stackblitz.com/github/johnsonfash/forge-orm/tree/main/examples/09-vector-rag) | `f.vector(N)` + cosine similarity |
| [Recipe / BOM](https://stackblitz.com/github/johnsonfash/forge-orm/tree/main/examples/10-recipe-bom) | Recursive sub-recipe rollup |
| [Multi-tenant scoping](https://stackblitz.com/github/johnsonfash/forge-orm/tree/main/examples/11-multi-tenant) | Soft RLS via app-layer wrapper |
| [Audit log](https://stackblitz.com/github/johnsonfash/forge-orm/tree/main/examples/12-audit-log) | `db.$on("query", …)` filtering mutating ops |
| [Full-text search](https://stackblitz.com/github/johnsonfash/forge-orm/tree/main/examples/13-fulltext-search) | `.search()` index across dialects |
| [Transactions](https://stackblitz.com/github/johnsonfash/forge-orm/tree/main/examples/14-transactions) | Atomic batch + nested savepoints |
| [Migrations + drift](https://stackblitz.com/github/johnsonfash/forge-orm/tree/main/examples/15-migrations-drift) | `db.$migrate()` + `db.$diff()` |

| Real DB (point at your own) | Setup |
|---|---|
| [MongoDB Atlas blog](https://github.com/johnsonfash/forge-orm/tree/main/examples/16-mongo-atlas-blog) | Free Atlas tier, paste URI into `.env` |
| [MSSQL ERP / MERGE](https://github.com/johnsonfash/forge-orm/tree/main/examples/17-mssql-merge-erp) | Docker SQL Server, `.env` |
| [Postgres + RLS auth](https://github.com/johnsonfash/forge-orm/tree/main/examples/18-postgres-rls-auth) | Hard multi-tenant via `current_setting` |

All 18 examples live at **[`examples/`](https://github.com/johnsonfash/forge-orm/tree/main/examples)**. Clone any folder:

```sh
npx degit johnsonfash/forge-orm/examples/01-sqlite-browser-todo my-app
```

---
