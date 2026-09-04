# 03 · DuckDB analytics

Seeds 5,000 sales rows into in-process DuckDB and runs aggregations. Demonstrates columnar storage + vectorised execution for OLAP, plus the cross-dialect `groupBy` API and `$queryRaw` escape hatch.

## Run it

DuckDB's Node bindings ship a native `.node` addon, so this needs a real OS — not StackBlitz. Click-and-run on CodeSandbox (`.codesandbox/tasks.json` auto-installs + runs):

- **[Run on CodeSandbox](https://codesandbox.io/p/devbox/github/johnsonfash/forge-orm-examples/main/03-duckdb-cli-needs-vm)**

Or fastest, locally:

```sh
npx degit johnsonfash/forge-orm-examples/03-duckdb-cli-needs-vm my-demo
cd my-demo && npm install && npm run dev
```

Prints two reports: top products by units sold + revenue by city.

## What this shows

- `url: "duckdb::memory:"` — DuckDB embedded
- `db.sale.createMany({ data: [...] })` — bulk insert
- `groupBy({ by, _sum, orderBy })` — typed aggregation API
- ``db.$queryRaw`...` `` — raw SQL escape hatch

## When to pick DuckDB

- Ad-hoc analytics on local data (parquet, CSV, JSON)
- ETL before pushing to a warehouse
- Embedded analytics in desktop / CLI apps
- BI-style queries that would be slow on row-stores

> **Browser DuckDB**: forge-orm currently ships only the Node adapter (`@duckdb/node-api`). For in-browser DuckDB use `@duckdb/duckdb-wasm` directly; a forge-orm browser-DuckDB adapter is on the roadmap.
