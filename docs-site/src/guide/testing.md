---
title: "Testing"
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

See more — **[docs/TESTING.md](/reference/testing)** (in-memory better-sqlite3, FakeWorker for browser code, transaction-rollback reset, event-hook assertions). **[docs/INTEGRATION-TESTING.md](/reference/integration-testing)** (testcontainers, Docker Compose, parallel-safe schema reset, GH Actions matrix across pg/mysql/sqlite/mongo). **[docs/FIXTURES.md](/reference/fixtures)** (typed factories, seeded random, snapshot fixtures, browser OPFS fixtures).

---
