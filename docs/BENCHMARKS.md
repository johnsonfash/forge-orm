# Benchmarks

`forge:bench` is the internal regression harness — it measures forge against itself across releases and against Prisma / Drizzle when run in compare mode. This page documents the methodology, every shipped scenario, how to read the output, and how to extend it for your own workloads.

* [What `forge:bench` is for](#what-forgebench-is-for)
* [The shipped scenarios](#the-shipped-scenarios)
* [Per-dialect commands](#per-dialect-commands)
* [Compare mode](#compare-mode)
* [Methodology](#methodology)
* [Reading the output](#reading-the-output)
* [What forge optimises](#what-forge-optimises)
* [Known regressions and honest notes](#known-regressions-and-honest-notes)
* [Adding your own scenarios](#adding-your-own-scenarios)
* [CI integration](#ci-integration)
* [Profiling a bench run](#profiling-a-bench-run)
* [Driver-level vs ORM-level benchmarks](#driver-level-vs-orm-level-benchmarks)
* [Microbench traps](#microbench-traps)
* [Cost of observability layers](#cost-of-observability-layers)
* [Worked examples](#worked-examples)
* [Cross-references](#cross-references)

---

## What `forge:bench` is for

The harness exists for two reasons, in this order:

1. **Internal regression tracking.** Every release runs `forge:bench` against
   itself. If `findFirst` on Postgres jumps from a +6% overhead-vs-raw to a +40%
   overhead between commits, something in the IR or the executor regressed and
   the diff that caused it has to justify itself.
2. **Apples-to-apples comparison.** Compare mode (`forge:bench:compare`) runs
   the same four scenarios against forge, Prisma, and Drizzle on the same
   database, against the same seeded table, with the raw driver baseline next
   to all three. The result is a like-for-like overhead number per engine per
   scenario per dialect.

It is deliberately small. The harness measures four scenarios across four
dialects. It is not a TPC benchmark and does not pretend to be one. The point
is signal, not glamour — a tight loop you can re-run on any laptop in under a
minute that catches per-call regressions before they ship.

A useful corollary: a bench harness that takes ten minutes to run will get run
once a release, find nothing, and rot. The forge bench finishes in seconds
against `:memory:` SQLite and tens of seconds against a local Postgres. It runs
on every PR (see [CI integration](#ci-integration)).

---

## The shipped scenarios

Every dialect runs the same four scenarios, defined inline in `bench/db-bench.ts`.

| Scenario    | What it does                                                              | Why it's in the harness                                  |
|-------------|---------------------------------------------------------------------------|----------------------------------------------------------|
| `findMany`  | `WHERE role = 'EDITOR' ORDER BY email ASC LIMIT 20`                       | Indexed range scan with sort and limit                   |
| `findFirst` | `WHERE email = ? LIMIT 1` (indexed unique column)                         | Indexed point lookup — exercises prepared-stmt reuse     |
| `count`     | `SELECT COUNT(*) WHERE role = 'USER'`                                     | Aggregate without rows in the result set                 |
| `update`    | `UPDATE users SET active = false WHERE id = ?` (indexed primary key)      | DML round-trip — exercises the write path                |

The seed is `BENCH_SEED` rows (default `500`) inserted with `createMany` before
the loop starts. `BENCH_ITER` iterations (default `200`) execute each scenario
back to back. The `i % BENCH_SEED` index lets `findFirst` and `update` rotate
through all 500 rows.

The model used is the project's own `User` schema (`src/schema/user.ts`) — id,
email, name, role enum, active boolean, created/updated timestamps. The same
schema is what powers the integration suite, so the bench exercises the actual
production code paths, not a stripped-down toy model.

What's deliberately **not** in the shipped scenarios:

* **Batch insert.** `createMany` runs once as part of seed, but its timing is
  not reported per-iteration. Bulk insert speed is dominated by network and
  driver buffering, not by the ORM layer; including it produces noisy numbers
  that mask the per-call signal.
* **Joins / `include`.** Forge's relation loader uses a single round-trip with
  `IN (...)` batching; that path is exercised end-to-end by the integration
  suite. Joins are not in the bench because their cost is dominated by query
  planning on the database, not by the ORM.
* **Transactions.** `db.$transaction` is a thin BEGIN / COMMIT wrapper; per-op
  timings are already covered by the four scenarios.

If you need any of these for your workload, see
[Adding your own scenarios](#adding-your-own-scenarios).

---

## Per-dialect commands

Each script sets `SKIP_*=1` for the other dialects so the harness only spins up
the database you care about.

```sh
npm run forge:bench           # all installed dialects
npm run forge:bench:sqlite    # in-memory SQLite only
npm run forge:bench:pg        # Postgres only
npm run forge:bench:mysql     # MySQL only
npm run forge:bench:mongo     # Mongo only
```

The skip flags can be combined manually for ad-hoc runs:

```sh
SKIP_MONGO=1 npm run forge:bench           # everything except Mongo
BENCH_ITER=1000 BENCH_SEED=5000 npm run forge:bench:pg
```

Connection URLs default to localhost on the standard port for each engine and
can be overridden:

```sh
BENCH_PG_URL=postgres://bench@db.local:5432/postgres npm run forge:bench:pg
BENCH_MYSQL_URL=mysql://root@db.local:3306         npm run forge:bench:mysql
BENCH_MONGO_URL=mongodb://db.local:27017            npm run forge:bench:mongo
```

SQLite always uses `:memory:` for the default bench (an isolated handle per
run); the compare bench drops to an on-disk file under `os.tmpdir()` so the
three engines can open the same database. Both modes create the schema, seed,
run, and clean up — there is no leftover state between runs.

If the driver for a given dialect isn't installed (`require('pg')` throws), the
harness logs `[bench:pg] skipped: …` and moves on. The same applies if the
service isn't reachable. You don't have to set `SKIP_*` for missing drivers;
that's only for explicitly opting out when the driver is installed but you
don't want to bench it.

---

## Compare mode

`forge:bench:compare` runs a 3-way comparison: forge vs Prisma vs Drizzle, each
plotted against the raw driver baseline.

```sh
npm run forge:bench:compare:gen   # prisma generate against bench/compare/*.prisma
npm run forge:bench:compare       # 3-way bench across all dialects
npm run forge:bench:compare:pg    # 3-way, Postgres only
npm run forge:bench:compare:mysql # 3-way, MySQL only
npm run forge:bench:compare:sqlite
npm run forge:bench:compare:mongo
```

The `:gen` step is required before the first compare run on a fresh checkout.
It runs `prisma generate` against `bench/compare/pg.prisma`,
`bench/compare/mysql.prisma`, and `bench/compare/sqlite.prisma`, producing
clients under `bench/compare/generated/{pg,mysql,sqlite}/`. Without those
clients, the Prisma column in the report shows
`n/a — driver-adapter or generated client not installed` and the bench keeps
going with forge, Drizzle, and raw.

How the three-engine bench stays apples-to-apples:

* **forge owns the schema.** forge runs DDL and seeds the `users` table; Prisma
  and Drizzle never run their own migrate. Their schemas (`*.prisma`,
  `drizzle-schema.ts`) describe the existing table so their clients can query
  it. There is exactly one physical table.
* **Same connection pool where possible.** On Postgres and MySQL, Drizzle is
  constructed against forge's already-open driver pool. That removes pool size
  and TCP handshake noise from the comparison — both engines hit the same TCP
  connections in the same state.
* **Same iteration loop.** `runOps()` calls each engine's scenario thunks in
  the same order with the same `idx` per iteration, so every engine touches
  the same 500 rows in the same sequence.
* **Same baseline.** The raw driver scenarios use the same hand-written SQL
  for every engine column. Overhead is computed as
  `(engine_median - raw_median) / raw_median`.

Engine availability across dialects:

| Dialect  | forge | raw      | Prisma 7              | Drizzle  |
|----------|-------|----------|-----------------------|----------|
| Postgres | yes   | `pg`     | `@prisma/adapter-pg`         | yes      |
| MySQL    | yes   | `mysql2` | `@prisma/adapter-mariadb`    | yes      |
| SQLite   | yes   | `better-sqlite3` | `@prisma/adapter-better-sqlite3` | yes |
| Mongo    | yes   | `mongodb` | not installed by default     | n/a      |

Drizzle does not ship a Mongo driver, so the Mongo column simply reports `n/a`
for the Drizzle slot. Prisma 7 requires a driver-adapter package per dialect;
if the matching `@prisma/adapter-*` is not installed when the bench runs, the
Prisma column reports `n/a` with the missing package name as the reason.
Neither case fails the run.

---

## Methodology

The measurement loop is intentionally simple. Here is the exact shape, copied
out of `bench/db-bench.ts`:

```ts
async function timed(fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

function timeit(label: string, runs: number[]): Sample {
  const sorted = [...runs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95    = sorted[Math.floor(sorted.length * 0.95)];
  const opsPerSec = 1000 / median;
  return { name: label, median, p95, opsPerSec };
}
```

* **Per-iteration timing** is wall-clock via `performance.now()`. The clock
  starts before the call and stops after the returned promise resolves.
* **Reported statistics** are the median and the 95th percentile of the
  sorted sample. Mean is not reported; medians shrug off the GC pause at
  iteration 47 in a way that means doesn't.
* **`opsPerSec`** is computed from the median, not the mean. It's a derived
  number for skimming the table, not for comparing engines that are within a
  few percent of each other — use the median column for that.

What's measured: round-trip latency from forge's API call to the resolved
promise. That includes the driver's serialisation, the network or IPC
round-trip, the database's actual execution, the driver's deserialisation,
and forge's row decoder. There is no server-time-only mode — splitting the
two is what `EXPLAIN ANALYZE` is for; see
[Profiling a bench run](#profiling-a-bench-run).

What's **not** measured separately: warm-up. The bench does not run an explicit
warm-up loop. Instead, the seed phase (`createMany` of 500 rows) primes the
pool, opens TCP connections, and forces JIT compilation of the hot paths
before the timed loop begins. The first 1–2 iterations of `findMany` still
include some V8 inlining cost; the median absorbs that. If you want a stricter
warm-up, bump `BENCH_ITER` — at 1000 iterations, the first dozen samples are
statistical noise against the rest.

The seed and iteration counts are tunable via env:

```sh
BENCH_SEED=500   # rows inserted before the timed loop (default 500)
BENCH_ITER=200   # iterations per scenario (default 200)
```

For day-to-day regression catching, the defaults are tight enough — `200 ×
4 scenarios × 4 dialects = 3,200` measured calls per run. For finer-grained
comparison work, push iter to 1000+ and seed to 5000+ so the table actually
fills the page-cache.

---

## Reading the output

A default `forge:bench` run produces one block per dialect that ran. Sample
output (Postgres, 200 iterations, 500 seed rows):

```
  postgres   — 200 iter, 500 seed rows
  op                              median        p95      ops/s   overhead
  ──────────────────────────── ────────── ────────── ────────── ──────────
  findMany                       1.42ms     2.18ms        704     +12.7%
    findMany [raw pg]            1.26ms     1.95ms        794
  findFirst                      0.61ms     1.04ms       1639      +8.9%
    findFirst [raw pg]           0.56ms     0.92ms       1786
  count                          0.43ms     0.77ms       2326      +4.9%
    count [raw pg]               0.41ms     0.69ms       2439
  update                         0.81ms     1.42ms       1234      +6.6%
    update [raw pg]              0.76ms     1.31ms       1316
```

Column meanings:

* **`op`** — scenario name. The forge row sits above its raw-driver pair so
  you can read each scenario top-to-bottom.
* **`median`** — median wall-clock per call, in milliseconds. This is the
  primary signal.
* **`p95`** — 95th percentile. A large p95 / median ratio means the dialect
  or scenario is jittery (Mongo and remote Postgres often are). A regression
  that shows up in p95 but not in median usually points at GC or autovacuum.
* **`ops/s`** — derived from median (`1000 / median`). Useful for the "this
  reads roughly N qps" gut-check.
* **`overhead`** — `(forge_median - raw_median) / raw_median × 100`, the
  per-call cost of going through the ORM.

For numbers like the +12.7% above: forge wraps each call with the row decoder,
the IR compile cache lookup, the event emitter, and a couple of property
walks. On a 1.26ms raw call, that is in the noise — but it's a number you can
track release to release.

The **compare** report has a slightly different shape: one block per scenario,
one row per engine, with the raw driver row marked `baseline`:

```
  postgres   - 200 iter, 500 seed rows  (overhead = vs raw driver)
  findMany
  engine           median        p95      ops/s   overhead
  raw pg           1.26ms     1.95ms        794   baseline
  forge            1.42ms     2.18ms        704     +12.7%
  prisma           2.31ms     3.84ms        433     +83.3%
  drizzle          1.39ms     2.21ms        719     +10.3%
  ...
```

The `n/a` row is what shows up when a Prisma adapter is missing or Drizzle is
asked about Mongo:

```
  prisma          n/a    Prisma 7 needs @prisma/adapter-pg + generated client (not installed)
  drizzle         n/a    Drizzle has no MongoDB driver
```

Run-to-run variance on a typical laptop is roughly ±5% on medians for the SQL
dialects against localhost, and ±10–20% for Mongo (which has a chattier wire
protocol). Variance between machines is much larger — never compare numbers
from two machines, only deltas between releases on the same machine.

---

## What forge optimises

The bench number is the proof. The mechanisms behind it are documented for
context:

* **IR compile cache.** Every query is compiled once from the public API
  shape (`findMany({ where: { role: 'EDITOR' } })`) into an IR tree, then
  into dialect-specific SQL plus a params array. The cache key is the IR
  shape, not the parameter values, so 1,000 calls to `findFirst({ email })`
  with 1,000 different emails compile once and reuse the prepared SQL 1,000
  times. The bench loop hits this cache cold on iteration 1 and hot for the
  next 199 — exactly the production pattern.
* **No codegen.** forge has no separate generator step. There is no
  `prisma generate` to run, no client to ship in `node_modules`, no engine
  binary to start. Cold-start is one `import` and one `createDb` call. This
  shows up in CLI tools and Lambda cold-paths far more than in the bench
  itself, where the cost is already amortised.
* **Prepared-statement reuse.** Where the driver supports it (better-sqlite3,
  `pg` extended protocol, `mysql2` `.execute()`), forge reuses prepared
  statements keyed by the compiled SQL string. The bench's `findFirst` and
  `update` rows are where this shows.
* **Row decoder is a single walk.** `decodeRow` walks `Object.keys()` of the
  driver's row once and applies per-column transforms (booleans from 0/1 on
  SQLite, JSON parses on MySQL, etc.). It does not iterate the schema and
  look up columns — that lookup happens at compile time.
* **The event emitter is a no-op when there are no subscribers.** If nothing
  is subscribed, the emit path is one boolean check. See
  [Cost of observability layers](#cost-of-observability-layers).

What forge does **not** do, and why these are not bench wins:

* No connection-pool of its own — it uses the driver's. Pool tuning is in
  [POOLING.md](POOLING.md).
* No client-side query cache. The cache is the IR compile cache, not a result
  cache. Result caching belongs above forge, not inside it.
* No bytecode VM, no separate process. The engine *is* node + driver.

---

## Known regressions and honest notes

Some things forge is measurably slower at than the closest competitor:

* **Drizzle on `count`** — Drizzle's hand-built SQL for `count(*)` skips a row
  decoder pass forge can't (forge unifies count and find through the same IR
  shape). The gap is small (low single-digit percent) and consistent.
* **Prisma on bulk batch inserts** — Prisma's protocol pipelines the insert
  rows through its engine, which can edge out forge's straightforward
  parameterised `INSERT ... VALUES (...), (...)` for very large batches
  (1000+ rows in one call). At the row counts you'd actually run in a request
  handler, the two are within a percent.
* **MySQL `update` with `pool.execute`** — the raw baseline uses `mysql2`'s
  prepared `execute()` path; the forge path uses `query()` for SQL it has
  already compile-cached. On small parameter counts the difference is in
  the noise; on bigger parameter sets (`IN (...)` of 100 ids) prepared
  execution wins by enough to show up in the overhead column.

For the broader honest list — feature gaps, dialect quirks, what's still on
roadmap — see the [Limitations and honest notes](../README.md#limitations-and-honest-notes)
section of the README.

If a regression shows up that you can reproduce, open an issue with the bench
output, the dialect, the BENCH_ITER / BENCH_SEED used, and the forge versions
on either side of it.

---

## Adding your own scenarios

The harness is a single file. To add a scenario, edit
`bench/db-bench.ts` and follow the four-step pattern the existing scenarios
use:

```ts
// 1. Declare per-scenario arrays alongside the existing r1..r4 / w1..w4.
const r5: number[] = [];
const w5: number[] = [];

// 2. Inside the iteration loop, push a forge-call sample and a raw-call sample.
for (let i = 0; i < BENCH_ITER; i++) {
  const idx = i % BENCH_SEED;
  // ... existing scenarios ...
  r5.push(await timed(() => db.user.findMany({
    where: { role: 'EDITOR', active: true },
    orderBy: { created_at: 'desc' },
    take: 50,
  })));
  w5.push(await timed(async () => {
    await pool.query(
      `SELECT * FROM "users" WHERE "role" = $1 AND "active" = $2
         ORDER BY "created_at" DESC LIMIT 50`,
      ['EDITOR', true],
    );
  }));
}

// 3. Add the pair to the returned Result[] tuple.
return [
  // ... existing rows ...
  [timeit('findMany active', r5), timeit('findMany active [raw pg]', w5)],
];
```

The same shape is repeated in each `benchPg / benchMysql / benchSqlite /
benchMongo` function. Add the scenario to each dialect you want to cover and
keep the raw SQL hand-tuned per dialect — that's the whole point of the raw
column. Don't try to build a cross-dialect raw query; you'll measure the
common-denominator path instead of the natural one.

For compare mode, the scenario also has to be added to `runOps()` in
`bench/compare/compare-bench.ts` and to the `Ops` interface — the harness will
then call it across forge, Prisma, Drizzle, and raw with the same `idx`. The
forge thunk goes in `forgeOps`, the raw / Drizzle / Prisma thunks go in their
respective per-dialect helpers.

If a scenario should be a one-off (you're investigating a specific commit, not
extending the suite), copy `bench/db-bench.ts` to `bench/your-bench.ts` and
edit there. The compile / seed / cleanup helpers are exported from the source
files so a side-bench can reuse the same setup.

---

## CI integration

The bench fits into CI in two patterns:

**1. Smoke run on every PR.** The default bench (`BENCH_ITER=200`,
`BENCH_SEED=500`) runs in under a minute end-to-end for the SQL dialects. Wire
it to PR jobs so a regression in `findFirst` overhead from +5% to +50% blocks
the merge.

```yaml
# .github/workflows/bench.yml (sketch)
- run: docker-compose up -d postgres mysql mongo
- run: npm ci
- run: npm run forge:bench:sqlite > bench.txt
- run: npm run forge:bench:pg     >> bench.txt
- run: npm run forge:bench:mysql  >> bench.txt
- uses: actions/upload-artifact@v4
  with: { name: bench, path: bench.txt }
```

For overhead regression gating, parse the `overhead` column out of the bench
output and compare against a baseline file in the repo. A simple awk one-liner
covers it; for fancier regression detection, the percentile output is stable
enough that you can run a small Python script to compare medians with a
two-sample Mann–Whitney check.

A workable threshold for the SQL dialects: fail the job if any scenario's
overhead moves by more than +10 percentage points (e.g. +6% → +17%). Mongo is
jittery enough that +25 is a more honest threshold.

**2. Nightly compare run.** `forge:bench:compare` takes longer and is more
useful as a nightly than a per-PR job. Save the output as an artifact and post
a comment on the relevant tracking issue when forge regresses below Drizzle
on a scenario where it was previously ahead.

The compare run requires `npm run forge:bench:compare:gen` before the first
invocation in a fresh checkout — wire that as a setup step.

---

## Profiling a bench run

The bench is a hot loop with no setup overhead during the measured phase — it
is the ideal target for a profiler.

**Node `--inspect`.** The lowest-friction option:

```sh
node --inspect-brk -r ts-node/register bench/db-bench.ts
```

Open `chrome://inspect`, attach to the process, and grab a CPU profile across
the iteration loop. The seed and cleanup phases will dominate the file
unless you filter; in DevTools, narrow the timeline window to just the bench
loop after `[bench:pg] database: …` has logged.

**clinic.js.** Higher-level, gives flame graphs and a doctor report:

```sh
npx clinic doctor -- node -r ts-node/register bench/db-bench.ts
npx clinic flame  -- node -r ts-node/register bench/db-bench.ts
```

The flame graph is the artifact to read first — the IR compile path and the
row decoder will be the two tallest forge frames, and changes between
releases will show up as their relative width shifting.

**0x.** Fast flame-graph generation without the doctor layer:

```sh
npx 0x -- node -r ts-node/register bench/db-bench.ts
```

Tighten the loop before profiling: bump `BENCH_ITER=2000` so the measured
phase dominates the seed and cleanup phases in the profile. Otherwise the
profiler will mostly be staring at `createMany` and `applyMigration`.

**SQL-side profiling.** If the overhead column is fine but a scenario is
slower than you expected in absolute terms, the bottleneck is downstream of
forge. `EXPLAIN ANALYZE` on the compiled SQL is the right next step; you can
log it with the event subscriber pattern from [EVENTS.md](EVENTS.md).

---

## Driver-level vs ORM-level benchmarks

The two columns in the bench output (`forge`, `raw <driver>`) split the
problem space:

* **The raw column tracks the driver / database / hardware.** If raw
  `findFirst` slows from 0.5ms to 5ms, it's not forge — your Postgres is
  cold, the disk is full, a noisy neighbour is running, or the driver
  shipped a regression. Run the driver smoke harness
  (`npm run smoke:drivers`) to confirm the driver itself is healthy; see the
  Testing section of the [README](../README.md#driver-smoke-harness).
* **The overhead column tracks forge.** If raw is steady but overhead jumps,
  it's the IR, the executor, the row decoder, or the event path. Use the
  profiler pointers above.

When you're picking between drivers (`pg` vs `postgres`, `mysql2` vs
`mariadb`, `better-sqlite3` vs `@libsql/client`), bench the *raw column*. The
forge overhead is essentially the same across drivers of the same kind
(adapters and dialects are stable; only the bottom 50 lines differ — see
[DRIVERS.md](DRIVERS.md#why-bring-your-own-driver-exists)). So the question
is which driver is faster underneath, and that's the raw row.

When you're picking between dialects (Postgres vs MySQL for a workload),
bench end-to-end with whatever workload you actually run — the four shipped
scenarios are useful as a sanity check, but a real workload mix will reorder
the dialects. Use [Adding your own scenarios](#adding-your-own-scenarios) to
shape the bench against your queries.

---

## Microbench traps

Microbenchmarks are easy to read wrong. The traps the forge harness has been
tuned to avoid, and the ones you should still be aware of:

* **JIT warmup.** V8 inlines and re-optimises hot functions across the first
  few hundred invocations. The bench's 500-row seed plus the first ~20
  iterations is enough warmup for the dialects we ship; on a colder workload
  you may need `BENCH_ITER=1000` before the median stabilises. If the p95 /
  median ratio is large *and* shrinking as iterations grow, you're still
  warming up.
* **GC pauses.** A 30ms p95 on a 1ms median is almost certainly a young-gen
  GC. The median absorbs it; don't read into individual spikes. If GC is
  driving variance, run with `--max-old-space-size=2048` and
  `--expose-gc` and inject a manual `global.gc()` between scenarios in a
  fork of the bench.
* **IO buffering and OS page cache.** The first run after a reboot will be
  slower than subsequent runs because the database files aren't in page
  cache. Warm with one throwaway run, then start measuring.
* **CPU frequency scaling.** Laptops on battery throttle to save power and
  produce wildly different numbers from the same laptop on AC. Plug in
  before benching.
* **Network jitter.** Any "Postgres at 127.0.0.1" still goes through the
  loopback stack and `localhost` resolution. `BENCH_PG_URL` pointing at
  Unix-socket Postgres (`postgres:///postgres`) eliminates the TCP overhead;
  the overhead column won't change but the absolute numbers will.
* **Don't compare across machines.** A +6% overhead on one laptop and a
  +14% on another doesn't mean forge regressed — the second laptop is
  probably slower in absolute terms, and the same constant-cost work shows
  up as a bigger percentage of a smaller absolute number.

---

## Cost of observability layers

forge's `QueryEvent` subscribers are a no-op when nothing is subscribed.
Subscribe one, and you've added a per-call cost.

A rough sense of the cost, measured by adding a subscriber to the bench
loop and re-running:

```ts
// Bench loop with a single no-op subscriber attached:
db.$events.on('query', () => { /* noop */ });
// Result: overhead on findFirst climbs from +8.9% to roughly +11–13%
//         on Postgres (single-digit microseconds of added latency).

// Bench loop with a logging subscriber that JSON.stringify's the event:
db.$events.on('query', (e) => { logger.debug(JSON.stringify(e)); });
// Result: overhead on findFirst climbs to roughly +25–35%; most of the
//         cost is JSON.stringify of the params array, not the emit itself.
```

The takeaways:

* The emit itself is cheap. It's the work you do **in the subscriber** that
  costs.
* If you want full query logging in production, sample it. See the
  [Sampling strategies](EVENTS.md#sampling-strategies) section of EVENTS.md.
* If you want metrics, accumulate in memory and flush periodically; don't do
  per-event aggregation that does string work.
* OpenTelemetry spans cost more than logging because the span machinery is
  itself more expensive than a JSON write. The OTel integration in EVENTS.md
  uses the parent-context optimisation for that reason.

The bench does not enable any subscribers by default. If you're benching a
workload that includes your production observability, attach the subscribers
before the timed loop in your fork of `bench/db-bench.ts`.

---

## Worked examples

### A. Bench a custom driver

Suppose you've written a custom Postgres driver wrapper (a Neon adapter, an
RDS Data API shim, a `postgres` driver in place of `pg`). The bench can prove
the wrapper is faithful and measure how it compares to the in-tree driver.

```ts
// bench/my-driver.ts
import { createDb } from '../src';
import { schema } from '../src/schema';
import { buildSchemaDDL as buildPgDDL } from '../src/adapters/postgres/ddl';
import { applyMigration } from '../src/adapters/postgres/migrate';
import { myCustomDriver } from '../src/my-driver'; // your wrapper

const db = await createDb({ driver: myCustomDriver({ url: process.env.URL! }) });
const pool = (db.adapter as any).pool;

await applyMigration(pool, buildPgDDL(schema as any));
await db.user.createMany({
  data: Array.from({ length: 500 }, (_, i) => ({
    id: `u_${i}`, email: `b${i}@x.co`, name: `U${i}`,
    role: i % 3 === 0 ? 'EDITOR' : 'USER',
  })),
});

// then copy the iteration loop from bench/db-bench.ts and report.
```

Diff the resulting medians against the `forge:bench:pg` numbers from the same
machine. If your wrapper is within a few percent on every scenario, ship it —
that's the same shape forge's `pg` and `postgres` drivers have against each
other.

### B. Reproduce vs Drizzle

A user posts a benchmark claiming Drizzle is 3× faster than forge on
`findMany`. Reproduce in compare mode:

```sh
npm run forge:bench:compare:gen   # one-time per checkout
BENCH_ITER=1000 BENCH_SEED=5000 npm run forge:bench:compare:pg
```

Read the compare block for the `findMany` scenario. If the result on your
machine shows forge and Drizzle within 5% (which is the typical outcome on
the shipped scenarios), the disagreement is about a different scenario or a
different setup — ask for the exact query shape and add it via
[Adding your own scenarios](#adding-your-own-scenarios). If forge is actually
3× slower, open an issue with the compare output and the BENCH params.

### C. Regression-gate in CI

A minimal gate that fails CI if forge's `findFirst` overhead on Postgres
regresses by more than 10 percentage points:

```sh
# scripts/bench-gate.sh
set -e

BASELINE_OVERHEAD=8.9   # measured on main; commit this number to the repo

npm run forge:bench:pg | tee bench.txt

CURRENT=$(awk '
  /^  findFirst /          { in_block = 1; next }
  in_block && /\+[0-9.]+%/ { gsub(/%/,""); print $NF; exit }
' bench.txt | tr -d '+')

DELTA=$(echo "$CURRENT - $BASELINE_OVERHEAD" | bc)
echo "findFirst overhead: ${CURRENT}% (baseline ${BASELINE_OVERHEAD}%, delta ${DELTA})"

if (( $(echo "$DELTA > 10" | bc -l) )); then
  echo "regression: findFirst overhead regressed by more than 10pp"
  exit 1
fi
```

Wire that step into the PR job. The baseline number is updated on main with
a separate commit whenever a deliberate change shifts the overhead.

---

## Cross-references

* [DRIVERS](DRIVERS.md) — what the driver port looks like, why
  raw-vs-forge is a meaningful baseline, and the wire-compatible swaps
  available.
* [EVENTS](EVENTS.md) — full cost model for `QueryEvent` subscribers,
  sampling strategies, and the worked sinks for pino / Sentry / OpenTelemetry
  / Prometheus referenced above.
* [POOLING](POOLING.md) — how the pool size and pool kind affect the
  absolute numbers in the bench, and why the compare bench reuses forge's
  pool for Drizzle.
* [Performance](../README.md#performance) — the README's short, honest
  framing of what the bench numbers do and don't say.
* [Limitations and honest notes](../README.md#limitations-and-honest-notes) —
  the broader honest list referenced in
  [Known regressions and honest notes](#known-regressions-and-honest-notes).
* [Driver smoke harness](../README.md#driver-smoke-harness) — the
  install-and-connect harness referenced in
  [Driver-level vs ORM-level benchmarks](#driver-level-vs-orm-level-benchmarks).
