# Integration testing

In-memory tests catch logic bugs; integration tests catch driver bugs, concurrency bugs, extension bugs, and "the real database does that?" bugs. This page covers testcontainers, Docker Compose, the `forge:integration:*` scripts, parallel-safe schema reset, and the GitHub Actions patterns that keep integration suites green.

* [When in-memory isn't enough](#when-in-memory-isnt-enough)
* [Testcontainers — per-suite real databases](#testcontainers--per-suite-real-databases)
* [Docker Compose — services up before the test runner](#docker-compose--services-up-before-the-test-runner)
* [The `forge:integration:*` scripts](#the-forgeintegration-scripts)
* [Reset patterns at integration scale](#reset-patterns-at-integration-scale)
* [Test data seeding](#test-data-seeding)
* [Parallel test runs](#parallel-test-runs)
* [Transaction-per-test integration — and where it breaks](#transaction-per-test-integration--and-where-it-breaks)
* [Multi-driver smoke pattern](#multi-driver-smoke-pattern)
* [Testing extensions](#testing-extensions)
* [Network failure injection](#network-failure-injection)
* [Slow query and deadlock simulation](#slow-query-and-deadlock-simulation)
* [CI integration](#ci-integration)
* [Cost — integration suites are slow](#cost--integration-suites-are-slow)
* [Worked examples](#worked-examples)
* [Cross-references](#cross-references)

---

## When in-memory isn't enough

`:memory:` SQLite is the right default for unit tests. It boots in microseconds, every test gets a fresh database for free, and the IR compiler emits the same SQL it would emit against a 4 TB Postgres. For the 90% case — query shape, branching logic, repository contracts — the in-memory dialect is enough, and [TESTING.md](TESTING.md) (parallel) covers that path.

The remaining 10% is where integration tests earn their cost. The buckets, in roughly the order they bite teams in production:

* **Driver quirks.** `pg` returns `BIGINT` as a string; `mysql2` returns it as a JS number that loses precision above 2^53; `better-sqlite3` returns it as `BigInt` only if you ask. The IR doesn't know any of that — the decoder hands you back what the driver produced, and that means tests against the real driver are the only way to know your handler doesn't silently truncate. The same applies to JSON columns (string on MySQL, parsed on Postgres), enums (text on most engines, native on Postgres), and timestamps (UTC ISO on Postgres, local-naive on MySQL by default).
* **Real concurrency.** Two transactions racing for the same row, `SELECT ... FOR UPDATE` waiting on a lock, a deadlock victim getting rolled back. None of these reproduce against `:memory:` SQLite — SQLite serialises writers and would-be deadlocks become `SQLITE_BUSY`. If your code path retries on `40P01` (Postgres deadlock) or `1213` (MySQL deadlock), the only way to test the retry is to provoke a real deadlock against a real engine.
* **Isolation levels.** `READ COMMITTED` vs `REPEATABLE READ` vs `SERIALIZABLE` is a Postgres / MySQL distinction with real semantics. A test that sets `isolationLevel: 'SERIALIZABLE'` and expects a `40001` (serialization failure) on a write-write race needs an engine that actually implements MVCC. SQLite has one isolation level and silently accepts the option.
* **Row-level security.** `CREATE POLICY` on Postgres only fires when the session has set a role. The `RLS off` ergonomics in [SECURITY.md](SECURITY.md) only mean anything against a database that enforces RLS, which is Postgres-only.
* **Extensions.** `pgvector`, `postgis`, `pg_trgm`, FTS5 on SQLite, the `mysql_fdw` family — none of these can be stubbed. If your handler does `nearTo` on a `geoPoint`, the test that proves the index is used has to run against a Postgres with PostGIS installed. See [Testing extensions](#testing-extensions).
* **Replication, logical decoding, foreign data wrappers, materialized views.** All Postgres-side machinery that's present or absent at the engine level. forge's IR doesn't generate any of these directly, but if your migration includes `CREATE MATERIALIZED VIEW`, it'll only execute against a real Postgres.

The rule of thumb: if a behaviour depends on what the database does *after* it receives the SQL — locking, MVCC, planner choice, extension code, replication — write an integration test. If the behaviour is "did we send the right SQL for this input shape", write a unit test.

The bench harness in [BENCHMARKS.md](BENCHMARKS.md) is itself an integration test suite, just one that measures wall-clock instead of correctness. Many of the patterns below (per-run database name, drop-on-exit, seed-once) are taken from the bench code (`bench/db-bench.ts`) because they solve the same problem.

---

## Testcontainers — per-suite real databases

The cleanest pattern is one ephemeral container per test suite (sometimes per test). [Testcontainers](https://node.testcontainers.org/) spins up a Docker container before the suite, waits for the engine's readiness probe to succeed, exposes the mapped port back to the host, and tears the container down when the suite finishes. The container's filesystem is gone the moment the suite exits — there is no "left-over state from last run" to clean up.

`npm i -D testcontainers`

### Postgres

```ts
// tests/integration/postgres.setup.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb } from 'forge-orm';
import { buildSchemaDDL } from 'forge-orm/adapters/postgres/ddl';
import { applyMigration } from 'forge-orm/adapters/postgres/migrate';
import { schema } from '../../src/schema';

let container: StartedPostgreSqlContainer;
let db: Awaited<ReturnType<typeof createDb>>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('forge_test')
    .withUsername('forge')
    .withPassword('forge')
    .start();

  db = await createDb({ url: container.getConnectionUri() });
  const pool = (db.adapter as any).pool;
  const ddl = buildSchemaDDL(schema);
  const report = await applyMigration(pool, ddl);
  if (report.failures.length) {
    throw new Error(`schema apply failed: ${report.failures.map((f) => f.name).join(', ')}`);
  }
}, 60_000); // first pull can be slow

afterAll(async () => {
  await db.$disconnect();
  await container.stop();
});

export { db };
```

Three things to keep an eye on. The `beforeAll` timeout of 60 seconds is for the cold pull on a fresh CI runner. On a warm machine the start is closer to 2 seconds. The `getConnectionUri()` returns a URL with the host-mapped port already baked in — don't try to hard-code `127.0.0.1:5432`, the random port mapping is the whole point. And the `failures.length` check is what catches a regression where a model added a column referencing a type the test database doesn't have (e.g. `vector` without pgvector — see [Testing extensions](#testing-extensions)).

### MySQL, MongoDB, Redis

Same shape, different module per engine. The MySQL probe is slower (10–15 seconds on a warm machine; the init scripts run on first boot); Mongo single-node needs `?directConnection=true` or the driver tries to discover a replica set and times out; Redis is included because most real apps run it adjacent (BullMQ, ioredis cache layer) — forge doesn't talk to Redis but the read-through cache from [CACHING.md](CACHING.md) does.

```ts
import { MySqlContainer } from '@testcontainers/mysql';
const mysql = await new MySqlContainer('mysql:8.4')
  .withDatabase('forge_test').withUsername('forge').withUserPassword('forge').start();
const dbMy = await createDb({ url: mysql.getConnectionUri() });

import { MongoDBContainer } from '@testcontainers/mongodb';
const mongo = await new MongoDBContainer('mongo:7').start();
const dbMongo = await createDb({ url: mongo.getConnectionUri() + '/forge_test?directConnection=true' });

import { GenericContainer } from 'testcontainers';
const redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
```

The `mysql:8.4` image is what forge tests against; 5.7 still works (`mysql:5.7`) but drops JSON path `LAX` and partial-filter indexes.

### Replica-set Mongo for transactions

`db.$transaction` against Mongo needs a replica set — single-node won't serve transactions. Heavier (`+2–3 s` per suite), so only do it if you actually call `$transaction`.

```ts
import { GenericContainer, Wait } from 'testcontainers';

const mongo = await new GenericContainer('mongo:7')
  .withCommand(['mongod', '--replSet', 'rs0', '--bind_ip_all'])
  .withExposedPorts(27017)
  .withWaitStrategy(Wait.forLogMessage(/waiting for connections/i))
  .start();

await mongo.exec(['mongosh', '--eval', 'rs.initiate()']);
await new Promise((r) => setTimeout(r, 1500)); // election beat

const url = `mongodb://${mongo.getHost()}:${mongo.getMappedPort(27017)}/forge_test?replicaSet=rs0&directConnection=true`;
```

### Reusing a container across runs

For the local dev loop, `withReuse()` attaches to a running container with the same configuration hash instead of starting a new one. Combined with [drop-and-recreate per test](#reset-patterns-at-integration-scale) you get fast iteration plus clean state. On CI, leave it off — fresh containers are part of the contract.

```ts
const c = await new PostgreSqlContainer('postgres:16-alpine').withReuse().start();
```

---

## Docker Compose — services up before the test runner

If your team already runs `docker compose up` for local dev, lean on it. The integration suite just connects to the running services; no per-suite container management, no `withReuse()` lifecycle, no test-process Docker socket access (which is what makes testcontainers awkward inside CI containers without DinD).

```yaml
# docker-compose.test.yml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: forge_test
      POSTGRES_USER: forge
      POSTGRES_PASSWORD: forge
    ports: ['127.0.0.1:54329:5432']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U forge -d forge_test']
      interval: 1s
      timeout: 5s
      retries: 30

  mysql:
    image: mysql:8.4
    environment:
      MYSQL_DATABASE: forge_test
      MYSQL_USER: forge
      MYSQL_PASSWORD: forge
      MYSQL_ROOT_PASSWORD: forge
    ports: ['127.0.0.1:33069:3306']
    healthcheck:
      test: ['CMD', 'mysqladmin', 'ping', '-h', '127.0.0.1', '-u', 'forge', '-pforge']
      interval: 1s
      timeout: 5s
      retries: 30

  mongo:
    image: mongo:7
    ports: ['127.0.0.1:27019:27017']
    healthcheck:
      test: ['CMD', 'mongosh', '--quiet', '--eval', 'db.adminCommand({ping:1}).ok']
      interval: 1s
      timeout: 5s
      retries: 30
```

The off-standard ports (`54329`, `33069`, `27019`) are deliberate. Most local dev machines already have a postgres on `5432` and a mongo on `27017` — pinning the test stack to non-conflicting ports means `docker compose up` doesn't fight whatever the developer is already running, and the test code points at the test stack unambiguously.

Wire it to the test runner:

```json
{
  "scripts": {
    "test:integration": "docker compose -f docker-compose.test.yml up -d --wait && vitest run -c vitest.integration.ts && docker compose -f docker-compose.test.yml down -v",
    "test:integration:keep": "docker compose -f docker-compose.test.yml up -d --wait && vitest run -c vitest.integration.ts"
  }
}
```

`--wait` is the flag that makes compose block until every service's healthcheck reports healthy. Without it, the test runner starts immediately and races the container readiness. The `:keep` variant doesn't tear down — useful for the inner-loop where you want to re-run tests against the same stack.

The connection URLs in the test config point at the host-mapped ports:

```ts
// vitest.integration.ts setup
process.env.INTEGRATION_PG_URL    = 'postgres://forge:forge@127.0.0.1:54329/forge_test';
process.env.INTEGRATION_MYSQL_URL = 'mysql://forge:forge@127.0.0.1:33069/forge_test';
process.env.INTEGRATION_MONGO_URL = 'mongodb://127.0.0.1:27019/forge_test';
```

Trade-off vs testcontainers: Docker Compose is faster on the inner loop (containers stay warm across runs) and simpler in CI (the stack is just a `services:` block in the workflow), at the cost of per-suite isolation — you need a [reset pattern](#reset-patterns-at-integration-scale) inside the suite because the container survives the test.

---

## The `forge:integration:*` scripts

The forge repo ships an integration harness that's a useful template even outside the project — it's the same shape you'd write for a downstream app's integration tests.

```sh
npm run forge:integration:pg      # full PG suite + per-driver regressions
npm run forge:integration:mysql   # full MySQL suite + MariaDB driver regression + partial-index regression
npm run forge:integration:mongo   # full Mongo suite + value-field, groupBy, partial-index, driver regressions
npm run forge:integration:sqlite  # full SQLite suite + libsql driver regression + FTS5 regression
npm run forge:integration:duckdb  # DuckDB suite + DuckDB geo regression
npm run forge:integration         # SQLite + PG + MySQL + Mongo, sequentially
```

What each script does, end to end:

1. **Connect to a root URL** read from `SMOKE_PG_USER` / `SMOKE_PG_HOST` / `SMOKE_PG_PORT` / `SMOKE_PG_ROOT` (Postgres), `SMOKE_MYSQL_*` (MySQL), `SMOKE_MONGO_URL` (Mongo), or `SMOKE_SQLITE_URL` (SQLite). All have sensible localhost defaults.
2. **Create a unique database name** of the form `forge_smoke_${Date.now()}_${randomSuffix}`. Two scripts running concurrently won't collide; a script killed mid-run leaves a database named `forge_smoke_*` behind that's easy to grep and drop.
3. **Push the schema** by running `buildSchemaDDL(schema)` + `applyMigration(pool, ddl)` — the same code path `forge push` uses, exercised against a real engine.
4. **Run scenarios** as `pass++` / `fail++` counters, each scenario printed as a labelled line with a `✓` or `✗`. The scenarios cover create chain (User → Profile → Posts → Comments → Tags), embeds, JSON columns, enums, cascades, `$transaction` semantics, `$queryRaw`, error mapping (`DbKnownError`), composite uniques, self-referential queries, atomic ops, soft delete.
5. **Print a summary** (`X scenarios, Y passed, Z failed`) and drop the database. The drop happens in a `finally` block so a panic mid-run still cleans up.

Reading one of the scripts is the fastest way to learn the shape:

```sh
less integration-pg.ts
less integration-mongo.ts
```

The two are deliberately the same scenario list with different adapters underneath — the integration suite doubles as a contract test that the public API is dialect-agnostic.

### Extending the harness

To add a scenario, edit the per-dialect script and follow the existing pattern:

```ts
await scenario('your behaviour under test', async () => {
  const result = await db.user.findFirst({ where: { email: 'alice@x.co' } });
  assert(result?.name === 'Alice', `expected Alice, got ${result?.name}`);
});
```

The `scenario(label, fn)` helper is defined at the top of each script and is intentionally minimal — it's a counter, not a framework. If you need fixtures, factories, or randomised property tests, that's a `vitest` or `jest` suite, not an extension of the smoke harness.

The trade-off is by design. The smoke scripts run from `npm run` with no test-runner overhead, so a CI step that's "did this commit break Postgres at all" finishes in 15 seconds against a localhost engine. The richer scenarios go into the unit test suite where vitest's reporter, retry, and parallelism pay for themselves.

### Regression scripts

The `forge:regression:*` scripts (which `forge:integration:*` chain after the main suite) capture one bug each — `regression-mongo-value-field.ts` reproduces a bug where a field named `value` shadowed Mongo's `$value` operator, `regression-postgresjs-driver.ts` proves the `postgres` driver wrapper is wire-compatible with `pg`. Adding a new regression script is the right move when a downstream bug report needs a permanent "this can't regress" guard outside the main scenario list.

---

## Reset patterns at integration scale

Three patterns, in increasing order of speed and decreasing order of safety. Pick the one whose trade-off matches your suite size.

**1. Drop-and-recreate database per suite.** The forge `integration-*` scripts use this — a unique database name, push the schema, run, drop. Safest because nothing leaks between suites; slowest because DDL is expensive.

```ts
beforeAll(async () => {
  await rootPool.query(`CREATE DATABASE "${dbName}"`);
  db = await createDb({ url: `${baseUrl}/${dbName}` });
  await applyMigration((db.adapter as any).pool, buildSchemaDDL(schema));
});

afterAll(async () => {
  await db.$disconnect();
  await rootPool.query(`DROP DATABASE "${dbName}" WITH (FORCE)`); // PG 13+
});
```

Use this when a suite is closer to a contract test (the full forge smoke shape) and the DDL cost is amortised across dozens of scenarios.

**2. Truncate all tables between tests.** The schema stays put; rows go.

```ts
async function truncateAll(db: any) {
  const pool = (db.adapter as any).pool;
  const rows = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '_forge_%'`,
  );
  const names = rows.rows.map((r: any) => `"${r.tablename}"`).join(', ');
  if (names) await pool.query(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

beforeEach(() => truncateAll(db));
```

`TRUNCATE` is much faster than `DELETE FROM` at scale because it doesn't write per-row WAL entries — it drops the underlying file and recreates it. `RESTART IDENTITY` resets the sequence so test 1's user id 1 isn't test 2's user id 2. `CASCADE` follows foreign keys so you don't have to compute the topological order.

Don't truncate the `_forge_migrations` table — that's the migration ledger from [MIGRATIONS.md](MIGRATIONS.md), and dropping it makes the next `forge diff apply` think the schema is unmigrated.

MySQL equivalent uses `information_schema.tables`:

```ts
const [rows] = await pool.query(
  `SELECT table_name FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name NOT LIKE '_forge_%'`,
);
await pool.query('SET FOREIGN_KEY_CHECKS = 0');
for (const r of rows as any[]) await pool.query(`TRUNCATE TABLE \`${r.table_name}\``);
await pool.query('SET FOREIGN_KEY_CHECKS = 1');
```

MySQL doesn't accept `CASCADE` on `TRUNCATE`; you flip `FOREIGN_KEY_CHECKS` off and back on instead. Don't forget the re-enable — leaving it off in a test pool leaks into the next test and silently lets bad data in.

Mongo equivalent is `collection.deleteMany({})` across the collection list, or `db.dropDatabase()` if you'd rather start clean (cheap on Mongo because the storage engine doesn't pre-allocate). Truncate-all is generally faster on SQL engines and `dropDatabase` is generally faster on Mongo.

**3. Transaction-per-test rollback.** See [Transaction-per-test integration](#transaction-per-test-integration--and-where-it-breaks) — fastest, sharpest trade-offs.

The right default is **truncate-all per test, drop-and-recreate per suite**. The drop-and-recreate clears the schema (catches DDL drift), the truncate-all clears the rows (cheap and predictable).

---

## Test data seeding

The seed patterns from [SEED.md](SEED.md) are what you use inside the test setup. Three differences when seeding from a test, not from `npm run seed`:

* **Smaller bootstraps.** A test wants the minimum row set the scenario needs, not the full demo data. The `seed:bootstrap` (admin + root org) shape is usually the right starting point; `seed:dev` is overkill.
* **Per-test factories, not file-on-disk fixtures.** A `factories/user.ts` that takes overrides and returns a created row is easier to reuse than a JSON fixture. The factory uses the same `db.user.create` your handlers use, so the data is shape-correct by construction.
* **Idempotent `upsert` is less important.** A test that drops or truncates before each run can use `create` — there's no conflict window. Save the `upsert` ergonomics for the production seed.

```ts
// tests/factories/user.ts
import { db } from '../setup';

let seq = 0;
export async function makeUser(overrides: Partial<Parameters<typeof db.user.create>[0]['data']> = {}) {
  const i = ++seq;
  return db.user.create({
    data: { id: `u_${i}`, email: `user${i}@test.local`, name: `User ${i}`, role: 'USER', ...overrides },
  });
}
```

The `seq` counter avoids email collisions in suites that don't reset between tests; suites that do reset see the counter restart naturally. For factories that need related rows (User → Profile → Posts), use the nested-write shape from [MUTATIONS.md](MUTATIONS.md#nested-writes) inside the factory — one round-trip, parent + children, no orchestration bugs.

For larger seed sets — image catalogues, geo data, vector embeddings — load a snapshot once in `beforeAll` and use truncate-all between tests to clear only the per-test rows. When FIXTURES.md ships, this section moves there; for now the patterns live in [SEED.md § Test-suite seeds](SEED.md#test-suite-seeds).

---

## Parallel test runs

The single biggest speedup on an integration suite is running it in parallel. Vitest defaults to one worker per CPU; jest defaults to half the CPUs. Either way, each worker needs a database name that no other worker is using. Three strategies, in roughly the order they scale:

**A. Separate database per worker.** The simplest pattern that works. `VITEST_WORKER_ID` and `JEST_WORKER_ID` are set by the runner.

```ts
// tests/integration/setup.ts
const workerId = process.env.VITEST_WORKER_ID ?? process.env.JEST_WORKER_ID ?? '1';
const dbName = `forge_test_w${workerId}`;

beforeAll(async () => {
  await rootPool.query(`CREATE DATABASE "${dbName}"`);
  db = await createDb({ url: `${process.env.INTEGRATION_PG_URL_BASE}/${dbName}` });
  await applyMigration((db.adapter as any).pool, buildSchemaDDL(schema));
});
afterAll(async () => { await db.$disconnect(); await rootPool.query(`DROP DATABASE "${dbName}"`); });
```

Each worker owns its database for the suite. The cost is one DDL apply per worker on startup — fine for a small schema, expensive for a large one.

**B. Separate schema per worker (Postgres).** Apply DDL once into a per-worker schema, then route each worker via `search_path`.

```ts
const workerId = process.env.VITEST_WORKER_ID ?? '1';
const url = `${process.env.INTEGRATION_PG_URL}?options=-c%20search_path%3Dtest_w${workerId}`;
```

Workers share the database (so they share extensions and roles) but get isolated tables. This is the right pattern for large schemas and the only sane pattern when extensions like pgvector / postgis are installed at the database level.

**C. Per-worker DB names through a pooler.** When per-worker direct connections overwhelm the engine, route through pgbouncer. In transaction mode, set `prepared_statements=false` — see [POOLING.md § Transaction-mode vs session-mode poolers](POOLING.md#transaction-mode-vs-session-mode-poolers--what-breaks). Most suites don't need this.

### Pool sizing per worker

A common mistake: the suite sets `max: 20` on the pool, runs 8 workers in parallel, quietly opens 160 connections to a Postgres configured for 100, and the last 3 workers hang on `connection limit exceeded`. The right number is `min(per_worker_concurrency, engine_capacity / worker_count)`. For an 8-worker laptop against `max_connections = 100`, `max: 5` per worker is plenty; tests inside a file are usually serial and the pool's mostly loaded by `beforeAll`. If tests are heavily parallel within a file, bump it and verify against `pg_stat_activity` / `SHOW STATUS LIKE 'Threads_connected'`.

---

## Transaction-per-test integration — and where it breaks

The shape is irresistible:

```ts
let tx: any;
let savepoint: string;
beforeEach(async () => {
  tx = await db.$beginTx({ isolationLevel: 'READ COMMITTED' });
  savepoint = `sp_${Date.now()}`;
});
afterEach(async () => {
  await tx.$rollback();
});
```

Fast (no row cleanup), parallel-safe (each test's transaction is invisible to the next), and you can run the entire suite inside one database, one schema, one connection. When it works it's the fastest integration pattern — sub-millisecond reset per test on Postgres.

When it doesn't work:

* **DDL inside a test on MySQL.** `CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX` all implicitly commit on MySQL. If a test calls `db.$migrate()` (browser path) or `applyMigration()` to set up a per-test column, the surrounding transaction silently commits and the rollback at the end is a no-op against the rows the test inserted. Use a different reset pattern for any test that touches DDL.
* **Multiple top-level transactions in code under test.** If the handler under test does its own `db.$transaction(async (tx2) => ...)`, that nested transaction commits independently of the outer suite-test wrapper on engines that support savepoints (Postgres, MySQL with InnoDB), and on engines that don't, it errors out (`SQLite` returns `cannot start a transaction within a transaction`). The forge `$transaction` does the right savepoint thing where it can, but the test's outer transaction wrapping has to know it's there.
* **Connection-bound state on Postgres.** `SET LOCAL`, advisory locks, prepared statements created in-test — all scoped to the transaction. Your test sees them; the next test doesn't. Usually a feature, occasionally a bug (a test that warms a prepared statement to measure the second-call cost won't see it warm in the next test).
* **Cross-worker visibility.** Two parallel workers running transaction-per-test against the same database can't see each other's uncommitted data (that's the whole point), but they *can* deadlock on shared rows. If your test data isn't worker-scoped, parallelism reintroduces the row-collision problem you were trying to solve.

The honest advice: use transaction-per-test for a suite where every test is row-only (no schema changes, no advisory locks, no shared global state) and where the seed is small enough to live in each test's setup. For everything else, truncate-all between tests is more robust at a small speed cost.

`forge` doesn't ship a `withRollback(testFn)` helper because the choice is too coupled to the rest of the suite (what's in `beforeAll`, what the factories assume, what isolation level the prod handlers expect). The shape is small enough to write inline in the setup file.

---

## Multi-driver smoke pattern

The forge integration scripts run the same scenario list against each adapter — that's the pattern for downstream apps that want one test file proving a handler works against every dialect they support.

```ts
// tests/integration/multi-driver.test.ts
import { createDb } from 'forge-orm';
import { buildSchemaDDL as buildPgDDL } from 'forge-orm/adapters/postgres/ddl';
import { buildSchemaDDL as buildMyDDL } from 'forge-orm/adapters/mysql/ddl';
import { buildSchemaDDL as buildSqliteDDL } from 'forge-orm/adapters/sqlite/ddl';
import { applyMigration as applyPg } from 'forge-orm/adapters/postgres/migrate';
import { applyMigration as applyMy } from 'forge-orm/adapters/mysql/migrate';
import { applyMigration as applySqlite } from 'forge-orm/adapters/sqlite/migrate';
import { schema } from '../../src/schema';

const cases = [
  { name: 'postgres', url: () => `${process.env.INTEGRATION_PG_URL}/forge_test_${Date.now()}`,    ddl: buildPgDDL,     apply: applyPg },
  { name: 'mysql',    url: () => `${process.env.INTEGRATION_MYSQL_URL}/forge_test_${Date.now()}`, ddl: buildMyDDL,     apply: applyMy },
  { name: 'sqlite',   url: () => `:memory:`,                                                       ddl: buildSqliteDDL, apply: applySqlite },
] as const;

describe.each(cases)('handler works on $name', (engine) => {
  let db: Awaited<ReturnType<typeof createDb>>;
  beforeAll(async () => {
    db = await createDb({ url: engine.url() });
    await engine.apply((db.adapter as any).pool, engine.ddl(schema));
  });
  afterAll(async () => { await db.$disconnect(); });

  test('returns the right shape', async () => {
    await db.user.create({ data: { id: 'u1', email: 'a@x.co', name: 'A' } });
    expect((await db.user.findFirst({ where: { email: 'a@x.co' } }))?.name).toBe('A');
  });
});
```

`describe.each` expands to one describe block per case; the body runs once per engine. The output reads as `handler works on postgres > … ✓`, `handler works on mysql > … ✓` — three signals from one definition. The cases array is the place to short-circuit by env (skip Postgres if `INTEGRATION_PG_URL` isn't set), the same shape `SKIP_*` flags give the bench harness.

Mongo doesn't quite fit because the adapter doesn't have a `buildSchemaDDL`; indexes are pushed via the Mongo adapter's `pushIndexes` path. Replace `ddl/apply` with a `setupDb()` thunk that calls `db.$pushIndexes?.()` and add it to the cases array.

---

## Testing extensions

Extensions are the case where the in-memory dialect can't help even a little. The code path is in the extension's C, not in forge's IR.

### pgvector

```ts
const container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
const db = await createDb({ url: container.getConnectionUri() });
const pool = (db.adapter as any).pool;

// Enable the extension in the test database
await pool.query('CREATE EXTENSION IF NOT EXISTS vector');

await applyMigration(pool, buildSchemaDDL(schema)); // schema can now reference vector(N)
```

The `pgvector/pgvector` image bundles Postgres + the pgvector extension. The `CREATE EXTENSION` call is per-database, so it has to run inside the test's database before the schema apply. If your migration includes `f.vector(384)`, the apply will fail with `type "vector" does not exist` if you skip this step.

`forge doctor` (see [DOCTOR.md](DOCTOR.md)) is the right pre-check: before the suite, run `db.$doctor()` and assert the response says vector is available.

```ts
beforeAll(async () => {
  await db.$doctor().then((r) => {
    if (!r.extensions.vector?.installed) {
      throw new Error('pgvector not installed; cannot run vector test suite');
    }
  });
});
```

This is friendlier than a `CREATE TABLE` failure five steps in — the doctor probe tells you up front.

### PostGIS

```ts
const container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
await pool.query('CREATE EXTENSION IF NOT EXISTS postgis');
```

Same shape, different image. The PostGIS image is much larger than vanilla Postgres (~600 MB vs ~80 MB), so the cold-pull in CI is slower. Cache the image with `actions/cache` or use a pinned digest in your registry. See [GEO.md](GEO.md) for the geo type shapes the suite exercises.

### SQLite FTS5 and `sqlite-vec`

```ts
const db = await createDb({ url: ':memory:' });
// FTS5 ships with the system sqlite on most platforms; verify before relying on it
const probe = await db.$queryRaw`SELECT sqlite_compileoption_used('ENABLE_FTS5') AS fts5`;
if (!probe[0]?.fts5) throw new Error('SQLite was built without FTS5');
```

For `sqlite-vec`, the extension has to be loaded per connection — not per database — and the connection has to allow extension loading (`db.loadExtension` on `better-sqlite3`). The wasm build (see [BROWSER.md](BROWSER.md)) bundles vec into the worker bundle, so the test runs unconditionally in browser-land but needs a load step in Node.

### MySQL spatial

`mysql:8.4` ships with spatial functions out of the box (`ST_Distance_Sphere`, `ST_Within`); 5.7 is partial. Use 8.4 for any geo test against MySQL.

The pattern across all extensions: pin the image (or the apt package list) that has the extension, do `CREATE EXTENSION` / `loadExtension` / probe explicitly in the setup, fail the suite with a clear message if the probe fails. Don't let a missing extension surface as a misleading error six steps into the scenario list.

---

## Network failure injection

`db.$transaction` retries on serialization failures and deadlocks; the pool reconnects on a TCP close. None of those code paths fire against a healthy localhost engine — you need to break the network.

[toxiproxy](https://github.com/Shopify/toxiproxy) is a TCP proxy that injects latency, drops connections, or partitions the network on demand. Put it in front of Postgres:

```ts
const toxi = await new GenericContainer('ghcr.io/shopify/toxiproxy:2.9.0')
  .withExposedPorts(8474, 5433).start();

await fetch(`http://${toxi.getHost()}:${toxi.getMappedPort(8474)}/proxies`, {
  method: 'POST',
  body: JSON.stringify({ name: 'pg', listen: '0.0.0.0:5433', upstream: 'postgres:5432', enabled: true }),
});

const db = await createDb({
  url: `postgres://forge:forge@${toxi.getHost()}:${toxi.getMappedPort(5433)}/forge_test`,
});
```

Tests then `PATCH /proxies/pg` with `{enabled: false}` to drop connections mid-test, or `POST /proxies/pg/toxics` with `{type: 'latency', attributes: {latency: 200}}` to add jitter. The fully runnable shape is [Worked example C](#c-chaos-test-reconnect-under-network-drop).

[pumba](https://github.com/alexei-led/pumba) takes the chaos one level higher — it kills, pauses, or partitions whole containers. Useful for graceful-shutdown / SIGTERM drain tests (see [POOLING.md § Connection lifecycle and SIGTERM drain](POOLING.md#connection-lifecycle-and-sigterm-drain)). `pumba pause --duration 5s docker-compose_postgres_1` freezes the engine without closing TCP; `pumba netem --duration 2s --interface eth0 corrupt --percent 50` corrupts half the packets.

These tests are slow and flaky by nature. Mark them `@chaos` and run them via `npm run test:chaos` nightly — not the inner loop, not the per-PR job.

---

## Slow query and deadlock simulation

Two scenarios that are easy to force and useful to test.

### Slow query — `pg_sleep`

```ts
test('handler times out on slow query', async () => {
  const start = Date.now();
  await expect(
    db.$queryRaw`SELECT pg_sleep(5)` // 5 second sleep
  ).rejects.toThrow(/timeout/);
  expect(Date.now() - start).toBeLessThan(2500); // proves the timeout fired
});
```

MySQL equivalent: `SELECT SLEEP(5)`. SQLite has no built-in sleep but `julianday('now')` polling works. The point isn't the sleep mechanism — it's that the handler's timeout logic fires before the query completes.

### Explicit deadlock

```ts
test('handler retries on deadlock', async () => {
  // Two transactions that lock the same two rows in opposite order
  const t1 = db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: 'u1' }, data: { name: 'A1' } });
    await new Promise((r) => setTimeout(r, 100));
    await tx.user.update({ where: { id: 'u2' }, data: { name: 'B1' } });
  });

  const t2 = db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: 'u2' }, data: { name: 'A2' } });
    await new Promise((r) => setTimeout(r, 100));
    await tx.user.update({ where: { id: 'u1' }, data: { name: 'B2' } });
  });

  const results = await Promise.allSettled([t1, t2]);
  const rejected = results.filter((r) => r.status === 'rejected');
  expect(rejected.length).toBe(1); // exactly one was the deadlock victim
  expect((rejected[0] as PromiseRejectedResult).reason.code).toBe('40P01'); // PG deadlock
});
```

The 100ms delay between updates is what gives both transactions time to grab their first lock before requesting their second — without it, one transaction finishes before the other starts and there's no deadlock. The Postgres deadlock detector runs on a 1-second timer (`deadlock_timeout`), so the test takes ~1 second; tighten the timer with `SET LOCAL deadlock_timeout = '50ms'` if you need faster iteration.

The `code === '40P01'` check is the deadlock SQLSTATE; MySQL uses `ER_LOCK_DEADLOCK` / errno 1213. Forge surfaces these through `DbKnownError`, so `error.code` is portable.

---

## CI integration

Three patterns, depending on how you ship the engine to the runner.

**Service containers** are the cleanest pattern for SQL engines. GH spins the container up alongside the runner, exposes it on localhost, and tears it down when the job finishes. The full per-dialect workflow is in [Worked example B](#b-github-actions-matrix-across-pgmysqlsqlite); the key bit is the `--health-*` options — without them, steps start the moment the container is created, before the engine is accepting connections, and the script fails on the first connect.

**Manual container setup** is what you use when the extension you need isn't in an official image. Run the container as a step, not a service, so you can install the extension between boot and the test run:

```yaml
  postgis:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: start postgres + postgis
        run: |
          docker run -d --name pg \
            -e POSTGRES_USER=forge -e POSTGRES_PASSWORD=forge -e POSTGRES_DB=forge_test \
            -p 5432:5432 postgis/postgis:16-3.4
          until docker exec pg pg_isready -U forge -d forge_test; do sleep 1; done
          docker exec -e PGPASSWORD=forge pg psql -U forge -d forge_test -c 'CREATE EXTENSION postgis'
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci && npm run forge:integration:pg
```

The `until pg_isready; do sleep 1; done` loop is the GH equivalent of `docker compose --wait`. For Mongo, `mongosh --eval 'db.adminCommand("ping")'` instead.

**Retry on flake — at the job level, not the test level.** Real integration suites have a tail of timing-dependent failures (replica election lag, port reuse, container startup races). Retrying inside the test runner (`vitest --retry 3`) papers over real race conditions — a test that passes on retry without investigation is a bug-shaped scar. Retrying the whole job preserves the signal (three job failures is a real bug) while smoothing over the infrastructure noise.

```yaml
      - uses: nick-fields/retry@v3
        with: { timeout_minutes: 10, max_attempts: 3, retry_on: error, command: npm run forge:integration:mongo }
```

Useful instrumentation: log the time-to-ready for each service and alert when the median creeps up. A 3-second-to-ready Postgres becoming 30-second-to-ready usually means the image moved or the runner got slower.

---

## Cost — integration suites are slow

A vitest unit suite of 200 tests finishes in 4 seconds against `:memory:` SQLite. The same 200 tests against Dockerised Postgres with truncate-all-between-tests takes 90 seconds on a warm laptop. That's a 22× tax. The right framing isn't "integration tests are slow" — it's "integration tests cost 22×, so make the count match the value."

The forge-internal split, which works well for downstream projects:

* **Unit tests** (jest, `:memory:` SQLite): every code path. Branch coverage targets, every error case, every input shape. Hundreds to thousands.
* **Integration smoke** (`forge:integration:*` style): one scenario list per adapter, covering the contract. Dozens, not hundreds. Runs on every PR.
* **Integration chaos** (`@chaos` tag, network drop, deadlock, slow query): single-digit count, runs nightly.

Things that are tempting to integration-test and are usually better left to unit tests:

* The query shape compiled by forge's IR. The IR doesn't care which engine you point it at — a unit test against `:memory:` SQLite proves the SQL shape. Save the integration test for "did Postgres actually use the index" (`EXPLAIN ANALYZE`).
* Error mapping for known error codes (`DbKnownError`). The mapping is in forge's adapter layer — one test per error code per dialect is enough; you don't need to test every handler's reaction to every error.
* `findFirst` vs `findMany` vs `findUnique` semantics. The unit suite covers it.

Things that *only* an integration test catches and that usually pay for their own cost:

* Connection pool exhaustion under load (see [POOLING.md § Pool exhaustion](POOLING.md#pool-exhaustion--symptoms-and-observability)).
* `$transaction` rollback on a real engine's deadlock.
* Migrations against drift (an `ALTER TABLE` that fails because a constraint already exists). See [MIGRATIONS.md § Drift detection rules](MIGRATIONS.md#drift-detection-rules--what-counts-what-doesnt).
* RLS policy enforcement.
* Extension queries (`pgvector` `<->`, PostGIS `ST_DWithin`).

A 90-second integration suite that catches a deadlock retry regression once a quarter is paying its rent. A 90-second suite that re-tests query shape forge already covers is paying nothing and slowing every PR.

---

## Worked examples

### A. Testcontainers Postgres + forge happy-path

A minimal, end-to-end shape that boots Postgres, applies the schema, runs a handful of scenarios, and tears down. This is the file you'd copy-paste to start a new integration suite.

```ts
// tests/integration/postgres.happy-path.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, DbKnownError } from 'forge-orm';
import { buildSchemaDDL } from 'forge-orm/adapters/postgres/ddl';
import { applyMigration } from 'forge-orm/adapters/postgres/migrate';
import { schema } from '../../src/schema';

let container: StartedPostgreSqlContainer;
let db: Awaited<ReturnType<typeof createDb>>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('forge_test')
    .withUsername('forge')
    .withPassword('forge')
    .start();

  db = await createDb({ url: container.getConnectionUri() });
  const pool = (db.adapter as any).pool;
  const report = await applyMigration(pool, buildSchemaDDL(schema));
  if (report.failures.length) {
    throw new Error(`schema apply failed: ${report.failures.map((f) => f.name).join(', ')}`);
  }
}, 60_000);

afterAll(async () => {
  await db.$disconnect();
  await container.stop();
});

describe('happy path', () => {
  test('create user with embed', async () => {
    const u = await db.user.create({
      data: {
        id: 'u_alice',
        email: 'alice@x.co',
        name: 'Alice',
        role: 'EDITOR',
        address: { street: '1 main', city: 'sf', zip: '94110', country: 'us' },
      },
    });
    expect(u.address?.city).toBe('sf');
  });

  test('unique violation surfaces as DbKnownError', async () => {
    await expect(
      db.user.create({ data: { id: 'u_alice_dup', email: 'alice@x.co', name: 'A' } }),
    ).rejects.toBeInstanceOf(DbKnownError);
  });

  test('transaction rolls back on throw', async () => {
    await expect(
      db.$transaction(async (tx) => {
        await tx.user.create({ data: { id: 'u_bob', email: 'b@x.co', name: 'B' } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const b = await db.user.findFirst({ where: { id: 'u_bob' } });
    expect(b).toBeNull();
  });
});
```

What's intentional in this shape:

* The schema apply happens once in `beforeAll`, not per test. The container is the slow part; once it's up, DDL is fast and the rest of the suite reuses it.
* No truncate-all between tests, because each test uses a unique id (`u_alice`, `u_bob`). For tests that share rows, add the truncate-all `beforeEach` from earlier.
* The `failures.length` guard turns a silent partial-apply into a loud test failure.

### B. GitHub Actions matrix across pg/mysql/sqlite

The workflow that runs the smoke harness against every dialect in parallel. Each engine gets its own job so the failure signals don't blur, and Mongo lives in a sibling job because its service-container shape is awkward inside `strategy.matrix.include`.

```yaml
# .github/workflows/integration.yml
name: integration
on: [push, pull_request]

jobs:
  postgres:
    runs-on: ubuntu-latest
    services:
      db:
        image: postgres:16-alpine
        env: { POSTGRES_USER: forge, POSTGRES_PASSWORD: forge, POSTGRES_DB: forge_test }
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U forge -d forge_test"
          --health-interval 1s --health-retries 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run forge:integration:pg
        env:
          SMOKE_PG_USER: forge
          SMOKE_PG_HOST: 127.0.0.1
          SMOKE_PG_PORT: '5432'
          SMOKE_PG_ROOT: postgres
          PGPASSWORD: forge

  mysql:
    runs-on: ubuntu-latest
    services:
      db:
        image: mysql:8.4
        env: { MYSQL_DATABASE: forge_test, MYSQL_USER: forge, MYSQL_PASSWORD: forge, MYSQL_ROOT_PASSWORD: forge }
        ports: ['3306:3306']
        options: >-
          --health-cmd "mysqladmin ping -h 127.0.0.1 -u forge -pforge"
          --health-interval 1s --health-retries 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run forge:integration:mysql
        env:
          SMOKE_MYSQL_URL: mysql://forge:forge@127.0.0.1:3306/forge_test

  mongo:
    runs-on: ubuntu-latest
    services:
      db:
        image: mongo:7
        ports: ['27017:27017']
        options: >-
          --health-cmd "mongosh --quiet --eval 'db.adminCommand({ping:1}).ok'"
          --health-interval 1s --health-retries 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run forge:integration:mongo
        env: { SMOKE_MONGO_URL: 'mongodb://127.0.0.1:27017' }

  sqlite:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run forge:integration:sqlite
```

The four jobs run in parallel; the slowest sets the wall-clock. On a warm cache the workflow finishes in 2–3 minutes; cold (first run on a new image tag) it's 5–7.

### C. Chaos-test reconnect under network drop

The shape from [Network failure injection](#network-failure-injection), spelled out as a runnable test. Two containers (Postgres + toxiproxy) sit on a user-defined Docker network so the proxy can reach `postgres:5432` over a stable internal hostname.

```ts
// tests/chaos/reconnect.test.ts
import { GenericContainer, Network } from 'testcontainers';
import { createDb } from 'forge-orm';
import { buildSchemaDDL } from 'forge-orm/adapters/postgres/ddl';
import { applyMigration } from 'forge-orm/adapters/postgres/migrate';
import { schema } from '../../src/schema';

let pg: any, toxi: any, db: any, toxiApi: string;

beforeAll(async () => {
  const net = await new Network().start();

  pg = await new GenericContainer('postgres:16-alpine')
    .withNetwork(net).withNetworkAliases('postgres')
    .withEnvironment({ POSTGRES_USER: 'forge', POSTGRES_PASSWORD: 'forge', POSTGRES_DB: 'forge_test' })
    .withExposedPorts(5432).start();

  toxi = await new GenericContainer('ghcr.io/shopify/toxiproxy:2.9.0')
    .withNetwork(net).withExposedPorts(8474, 5433).start();

  toxiApi = `http://${toxi.getHost()}:${toxi.getMappedPort(8474)}`;
  await fetch(`${toxiApi}/proxies`, {
    method: 'POST',
    body: JSON.stringify({ name: 'pg', listen: '0.0.0.0:5433', upstream: 'postgres:5432', enabled: true }),
  });

  db = await createDb({
    url: `postgres://forge:forge@${toxi.getHost()}:${toxi.getMappedPort(5433)}/forge_test`,
    pool: { max: 5, idleTimeoutMillis: 1000 },
  });
  await applyMigration((db.adapter as any).pool, buildSchemaDDL(schema));
}, 120_000);

afterAll(async () => { await db.$disconnect(); await toxi.stop(); await pg.stop(); });

const setProxy = (enabled: boolean) =>
  fetch(`${toxiApi}/proxies/pg`, { method: 'POST', body: JSON.stringify({ enabled }) });

test('survives a 500ms network drop', async () => {
  await db.user.create({ data: { id: 'u1', email: 'a@x.co', name: 'A' } });

  await setProxy(false);
  await new Promise((r) => setTimeout(r, 500));
  await setProxy(true);
  await new Promise((r) => setTimeout(r, 100)); // pool reconnect beat

  const u = await db.user.findFirst({ where: { id: 'u1' } });
  expect(u?.email).toBe('a@x.co');
});

test('in-flight queries error during the drop', async () => {
  const slow = db.$queryRaw`SELECT pg_sleep(2)`;
  await new Promise((r) => setTimeout(r, 200));
  await setProxy(false);
  await expect(slow).rejects.toThrow();
  await setProxy(true);
});
```

The second test is the more interesting signal: a pool that swallows the error and returns null is a bug; a pool that propagates the disconnect to the in-flight promise is correct.

Chaos tests don't belong in the per-PR job. They go in `npm run test:chaos` and run nightly. The flake rate is high enough that PR-gating them adds noise without adding signal.

---

## Cross-references

* [TESTING](TESTING.md) (parallel) — unit testing patterns against `:memory:` SQLite: factories, snapshot matchers, the IR-shape contract.
* [SEED](SEED.md) — bootstrap / dev / demo split, idempotent upsert, the canonical seed script. The factories pattern in [Test data seeding](#test-data-seeding) builds on top.
* [FIXTURES](FIXTURES.md) (forward reference) — per-test fixture factories and the seed-vs-fixture decision matrix. Lands when the doc ships; the patterns live in [SEED.md § Test-suite seeds](SEED.md#test-suite-seeds) for now.
* [BENCHMARKS](BENCHMARKS.md) — the bench harness uses the same per-run database name + drop-on-exit shape as the integration scripts; many of the parallel patterns above are taken from `bench/db-bench.ts`.
* [DRIVERS](DRIVERS.md) — why driver-specific quirks need real-engine tests, the per-driver port surface, and the `smoke:drivers` harness referenced as a pre-check.
* [MIGRATIONS](MIGRATIONS.md) — `forge push` is what the integration setup calls under the hood; the drift-detection rules are what an integration test against an out-of-date schema exercises.
* [POOLING](POOLING.md) — pool sizing per worker, transaction-mode pgbouncer caveats, and the connection-exhaustion symptoms that integration tests reproduce.
* [DOCTOR](DOCTOR.md) — the `db.$doctor()` probe used as a pre-check for extensions in [Testing extensions](#testing-extensions).
* [SECURITY](SECURITY.md) — RLS policy testing patterns; the `SET ROLE` shape an RLS integration test wraps around its queries.
* [GEO](GEO.md) / [VECTOR](VECTOR.md) / [FTS](FTS.md) — the typed extension surfaces that the extension test suites exercise end to end.
