# Testing

Unit-test forge-orm code without spinning up a real database. Two paths: in-memory better-sqlite3 for server code (`sqlite::memory:`), and FakeWorker for browser code (in-process sqlite-wasm). This page covers harness setup, transaction-rollback reset, event-hook assertions, and the patterns that keep test suites fast.

The companion docs are [INTEGRATION-TESTING.md](./INTEGRATION-TESTING.md) (live Postgres / MySQL / Mongo via Testcontainers, when you do need a real server), [FIXTURES.md](./FIXTURES.md) (factory pattern for typed test data), [TRANSACTIONS.md](./TRANSACTIONS.md#testing-patterns) (the rollback pattern at the source), [BROWSER.md](./BROWSER.md) (sqlite-wasm internals), [REACT.md](./REACT.md) (hook tests on top of the live DB), and [MUTATIONS.md](./MUTATIONS.md) (write-verb assertions).

## Contents

* [Two paths: in-memory SQLite vs FakeWorker](#two-paths-in-memory-sqlite-vs-fakeworker)
* [Why in-memory beats mocks](#why-in-memory-beats-mocks)
* [In-memory SQLite as the unit-test DB](#in-memory-sqlite-as-the-unit-test-db)
* [FakeWorker for browser tests](#fakeworker-for-browser-tests)
* [Vitest setup](#vitest-setup)
* [Jest setup](#jest-setup)
* [Reset strategies — fresh DB, drop-and-recreate, transaction rollback](#reset-strategies--fresh-db-drop-and-recreate-transaction-rollback)
* [Transaction-rollback per test](#transaction-rollback-per-test)
* [Snapshot and seed patterns](#snapshot-and-seed-patterns)
* [Fixture factories](#fixture-factories)
* [Type-safe test data builders](#type-safe-test-data-builders)
* [Mocking forge — don't](#mocking-forge--dont)
* [Testing inside `$transaction`](#testing-inside-transaction)
* [Testing event hooks](#testing-event-hooks)
* [Testing migrations](#testing-migrations)
* [Testing geo, vector, FTS, and JSON path](#testing-geo-vector-fts-and-json-path)
* [Testing browser code with FakeWorker + jsdom](#testing-browser-code-with-fakeworker--jsdom)
* [Asserting emitted SQL](#asserting-emitted-sql)
* [Coverage targets](#coverage-targets)
* [Worked example A — vitest with in-memory + rollback](#worked-example-a--vitest-with-in-memory--rollback)
* [Worked example B — jest with FakeWorker for a React component](#worked-example-b--jest-with-fakeworker-for-a-react-component)
* [Worked example C — asserting an SQL emit](#worked-example-c--asserting-an-sql-emit)
* [Anti-patterns](#anti-patterns)

---

## Two paths: in-memory SQLite vs FakeWorker

Pick by where your code runs.

| Path                    | When to use                                                  | Driver                                | Real SQL? |
|-------------------------|--------------------------------------------------------------|---------------------------------------|-----------|
| In-memory better-sqlite3 | Server code, repository tests, schema tests, query tests     | `betterSqlite3Driver(new Database(':memory:'))` | Yes      |
| FakeWorker              | Browser-bound code that imports `wasmSqliteDriver`, hooks    | `wasmSqliteDriver({ worker: new FakeWorker() })` | Mocked — protocol only |

The in-memory path runs *actual SQL* against an in-process sqlite engine: every clause forge compiles is parsed and executed exactly as it would be in production, just without the file-system or network. Right tool whenever the behaviour under test is "does this query return what I expect."

The FakeWorker path mocks the worker-message protocol the wasm driver speaks (`open`, `exec`, `all`, `get`, `run`, `close`) so the driver thinks it's talking to a real Web Worker. No SQL is executed — you supply the replies. Right tool for browser glue: React hook tests that need a `db` handle, components that read or write through forge, code paths that branch on driver replies. When you need real SQL in the browser, there's a hybrid pattern (covered below) that pipes wasm worker messages into in-process better-sqlite3 — the driver thinks it's wasm; the SQL is really executed.

```
Server-side code? ----------------> in-memory better-sqlite3
Browser code, asserting on UI? ----> FakeWorker with canned replies
Browser code, exercising SQL? -----> FakeWorker piped into in-memory sqlite
Cross-dialect SQL emission? -------> any driver — assert on QueryEvent.sql
Postgres-only feature? ------------> live Testcontainers (INTEGRATION-TESTING.md)
```

---

## Why in-memory beats mocks

The pull toward mocking the database is strong — and the mocks all eventually rot. Two failure modes:

* **The mock's shape drifts from the real shape.** Forge returns soft-deleted rows with `deleted_at: null`, counts as `{ count: number }`, nested writes with the children resolved. The mock written eighteen months ago doesn't, because nobody updated it.
* **The test stops catching the bug.** Mocking `db.user.findFirst` to return `{ id: 'u1' }` also silently asserts that forge accepted your `where` clause. Forge actually rejects malformed `where` clauses at runtime. The mock passes; production fails.

The in-memory path side-steps both. Forge runs end-to-end through its real adapter, its real query compiler, the real SQLite parser. The only thing missing is durability — and durability is exactly what a unit test does not want.

The cost is small. `new Database(':memory:')` opens in under 1 ms. `db.$migrate()` against a 20-table schema applies in 5–15 ms. A 1,000-test suite that opens a fresh DB per test runs in under a minute; with [transaction rollback](#transaction-rollback-per-test) the same suite drops under five seconds.

---

## In-memory SQLite as the unit-test DB

The minimum setup is three lines.

```ts
import Database from 'better-sqlite3';
import { createDb, betterSqlite3Driver } from 'forge-orm';
import { schema } from './schema';

const db = await createDb({
  schema,
  driver: betterSqlite3Driver(new Database(':memory:')),
});
await db.$migrate();   // apply the schema's DDL to the empty DB
```

The DB is process-local and disappears when the handle is collected. Open one per test, per file, or per suite depending on the [reset strategy](#reset-strategies--fresh-db-drop-and-recreate-transaction-rollback) you pick.

A small amount of polish:

```ts
// test/db.ts — shared helper, imported by every test file
import Database from 'better-sqlite3';
import { createDb, betterSqlite3Driver, type ForgeDb } from 'forge-orm';
import { schema } from '../src/schema';

export async function makeTestDb(): Promise<{
  db: ForgeDb<typeof schema>;
  close: () => Promise<void>;
}> {
  const raw = new Database(':memory:');
  raw.pragma('journal_mode = MEMORY');
  raw.pragma('synchronous = OFF');
  raw.pragma('foreign_keys = ON');   // SQLite is OFF by default
  const db = await createDb({ schema, driver: betterSqlite3Driver(raw) });
  await db.$migrate();
  return { db, close: async () => { raw.close(); } };
}
```

Two of those pragmas matter. `foreign_keys = ON` is required for FK assertions to actually fire — SQLite is off-by-default for backward compat and forge does not flip it for you on a raw driver you supplied. `journal_mode = MEMORY` and `synchronous = OFF` are not strictly needed (the file already lives in RAM) but they skip a few internal writes and shave a few percent off setup time.

### Caveats vs. the real production dialect

In-memory SQLite is a real database, but it isn't the same one as production Postgres or MySQL. The gaps that bite:

* **Type coercion is loose.** SQLite stores everything as TEXT / INTEGER / REAL / BLOB. A `varchar(10)` that overflows in Postgres just fits in SQLite.
* **Case-insensitive collation differs.** Postgres `citext` and MySQL `_ci` collations don't reproduce on SQLite.
* **No native `uuid` type.** Forge stores UUIDs as TEXT on SQLite — matches its production codec, but type-introspection tests need to know.
* **JSON functions assume a modern build.** Default better-sqlite3 ships JSON1; some embedded distros don't.

For any feature whose behaviour depends on the target dialect, write a unit test against in-memory SQLite for the shape and an integration test against the real dialect for the semantics. See [INTEGRATION-TESTING.md](./INTEGRATION-TESTING.md).

---

## FakeWorker for browser tests

`wasmSqliteDriver` expects a `Worker`-shaped object: it sends typed messages (`{ type: 'open' | 'exec' | 'all' | 'get' | 'run' | 'close', ... }`) and awaits replies of shape `{ id, ok, rows | row | changes | lastInsertRowid, error? }`. Anything with that protocol satisfies the driver.

A FakeWorker is forge's own test-suite pattern, lifted into yours. The full class lives at `src/__tests__/sqlite-wasm-driver.spec.ts` — copy it verbatim, or import it from a `test/fake-worker.ts` helper. The shape:

```ts
class FakeWorker {
  public sent: any[] = [];
  public replyFor = (msg: any) => /* default replies for open/exec/all/get/run/close */;
  addEventListener(event: string, fn: (ev: any) => void)    { /* push to listener list */ }
  removeEventListener(event: string, fn: (ev: any) => void) { /* drop from list */ }
  postMessage(msg: any) {
    this.sent.push(msg);
    queueMicrotask(() => /* dispatch this.replyFor(msg) back to the message listener */);
  }
  terminate() { /* no-op */ }
}
```

Two modes of use:

**Canned replies.** Override `replyFor` to return whatever you want. Useful for testing error paths, edge replies, and "what happens if the worker is slow":

```ts
const worker = new FakeWorker();
worker.replyFor = (msg) =>
  msg.type === 'all' && /SELECT \* FROM user/.test(msg.sql)
    ? { ok: true, rows: [{ id: 'u1', email: 'a@x.co' }] }
    : { ok: true };

const db = await createDb({
  schema,
  driver: wasmSqliteDriver({ worker: worker as unknown as Worker }),
});

const u = await db.user.findFirst({ where: { id: 'u1' } });
expect(u).toEqual({ id: 'u1', email: 'a@x.co' });
```

**Piped into a real in-memory DB.** For tests that need real SQL semantics through the browser code path, route the worker messages into a better-sqlite3 instance:

```ts
import Database from 'better-sqlite3';

function pipeToBetterSqlite(): FakeWorker {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  const worker = new FakeWorker();
  worker.replyFor = (msg) => {
    try {
      switch (msg.type) {
        case 'open':  return { ok: true };
        case 'exec':  raw.exec(msg.sql); return { ok: true };
        case 'all':   return { ok: true, rows: raw.prepare(msg.sql).all(...(msg.params ?? [])) };
        case 'get':   return { ok: true, row:  raw.prepare(msg.sql).get(...(msg.params ?? [])) };
        case 'run': {
          const r = raw.prepare(msg.sql).run(...(msg.params ?? []));
          return { ok: true, changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
        }
        case 'close': raw.close(); return { ok: true };
      }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
    return { ok: false, error: `unknown: ${msg.type}` };
  };
  return worker;
}
```

This gives you a "browser-shaped" `db` whose SQL is real. React component tests, hook tests, and zustand stores all work against it without spinning up a Worker. The downside: `OPFS`-specific assertions don't apply, because there's no OPFS. Pair this pattern with explicit OPFS mocks if you need to test storage failure modes.

---

## Vitest setup

Vitest is the default in the forge ecosystem because it speaks ESM natively, which the wasm driver requires.

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',             // browser code overrides this per-file
    setupFiles: ['./test/setup.ts'],
    coverage: {
      provider: 'v8',
      exclude: ['src/ir/codegen/**', 'src/**/*.d.ts'],
    },
  },
});
```

Browser tests override the env per-file with `// @vitest-environment jsdom`. For tests that share a handle, `setupFiles` is where `makeTestDb()` from above lives.

---

## Jest setup

Jest works too, with one wrinkle: the wasm driver's worker file is ESM-only — if you import `wasm-driver` in a CJS test, whitelist `forge-orm` under `transformIgnorePatterns`.

```js
// jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFilesAfterEach: ['<rootDir>/test/setup.ts'],
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: true }] },
  transformIgnorePatterns: ['node_modules/(?!(forge-orm)/)'],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.d.ts', '!src/ir/codegen/**'],
};
```

React component tests override the env per-file with `@jest-environment jsdom`. The rest of this doc shows vitest snippets; jest equivalents differ only in the import (`vitest` → `@jest/globals`) and the mock helper (`vi.fn()` → `jest.fn()`).

---

## Reset strategies — fresh DB, drop-and-recreate, transaction rollback

Three options, fastest last.

| Strategy                         | Speed (per test) | Isolation         | Catches                              |
|----------------------------------|------------------|-------------------|--------------------------------------|
| Fresh `new Database(':memory:')` | ~10 ms           | Full              | Everything                           |
| Drop + recreate all tables       | ~5 ms            | Full              | Everything but cached prepared stmts |
| `BEGIN` / `ROLLBACK` per test    | <1 ms            | Strong (but see below) | Most things                     |

Use the first while writing tests, the third when the suite gets slow.

### Fresh DB per test

The easiest and the slowest. Every test gets a clean `db` handle and a freshly-migrated schema:

```ts
import { beforeEach, afterEach } from 'vitest';

let db: ForgeDb<typeof schema>;
let close: () => Promise<void>;

beforeEach(async () => {
  const made = await makeTestDb();
  db = made.db; close = made.close;
});
afterEach(async () => { await close(); });
```

100% isolation, no test can leak state. The cost is ~10 ms per test for `$migrate` on a non-trivial schema, which adds up at 1,000+ tests.

### Drop + recreate per test file

Open one DB per test file and recreate the schema between tests. Saves the driver-init cost on every test but pays the DDL cost:

```ts
let db: ForgeDb<typeof schema>;
let raw: Database.Database;

beforeAll(async () => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  db = await createDb({ schema, driver: betterSqlite3Driver(raw) });
});

beforeEach(async () => {
  // Drop all user tables, then re-migrate.
  const tables = raw.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
  ).all() as { name: string }[];
  for (const { name } of tables) raw.exec(`DROP TABLE IF EXISTS "${name}"`);
  await db.$migrate();
});

afterAll(() => raw.close());
```

Half the latency of the fresh-DB strategy.

### Transaction rollback per test

The fastest. Open one DB per test file. Open a transaction in `beforeEach`. Roll it back in `afterEach`. No DDL between tests at all.

See [Transaction-rollback per test](#transaction-rollback-per-test) below for the full pattern — it's load-bearing enough to deserve its own section.

---

## Transaction-rollback per test

```ts
import { afterEach, beforeAll, beforeEach, afterAll } from 'vitest';
import type { ForgeDb } from 'forge-orm';

let db: ForgeDb<typeof schema>;
let raw: Database.Database;
let tx: ForgeDb<typeof schema>;
let rollback: () => void;

beforeAll(async () => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  db = await createDb({ schema, driver: betterSqlite3Driver(raw) });
  await db.$migrate();
});

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    db.$transaction(async (txObj) => {
      tx = txObj;
      resolve();
      // Suspend until afterEach yanks the chain.
      await new Promise<void>((_, reject) => {
        rollback = () => reject(new Error('test rollback'));
      });
    }).catch(() => { /* expected — we threw */ });
  });
});

afterEach(() => rollback());

afterAll(() => raw.close());
```

Tests then take `tx`, not `db`:

```ts
import { test, expect } from 'vitest';

test('creating a user makes it findable', async () => {
  await tx.user.create({ data: { email: 'a@x.co', name: 'Alice' } });
  const found = await tx.user.findFirst({ where: { email: 'a@x.co' } });
  expect(found?.name).toBe('Alice');
});
```

Why this is fast: zero DDL between tests, the prepared-statement cache stays warm, the page cache stays warm. A 5,000-test suite that took 90 s with drop-recreate runs in 6 s with rollback.

**Caveats — re-read TRANSACTIONS.md for the full list.** The two that bite most:

* **`tx.$transaction(...)` inside a test is a no-op shell.** Forge's nested-tx model maps the inner callback against the same outer session. There's no savepoint by default. Tests that branch on commit-vs-rollback inside a sub-tx need the [Testing inside `$transaction`](#testing-inside-transaction) pattern.
* **Mongo's `withTransaction` retries.** The "throw to roll back" trick fires the test body twice on Mongo. Use lower-level `session.startTransaction()` / `session.abortTransaction()` directly — see [TRANSACTIONS.md § Testing patterns](./TRANSACTIONS.md#testing-patterns).

The rollback pattern works cleanly on SQLite, Postgres, MySQL, DuckDB, and MSSQL. It works on Mongo with the explicit-session variant.

---

## Snapshot and seed patterns

Two ways to get a known dataset in front of each test.

### Seed once, rollback per test

Combine [transaction rollback](#transaction-rollback-per-test) with a seed in `beforeAll`:

```ts
beforeAll(async () => {
  // ... migrate + connect ...
  await db.user.createMany({ data: SEED_USERS });
  await db.product.createMany({ data: SEED_PRODUCTS });
});
```

Every test starts inside a transaction that already sees the seeded rows. Mutations roll back; the seed survives. This is the right pattern for read-heavy test suites.

### Snapshot dump + restore

For larger seeds (a few thousand rows), dump the in-memory DB once and restore between tests:

```ts
let snapshot: Buffer;

beforeAll(async () => {
  raw = new Database(':memory:');
  await db.$migrate();
  await db.user.createMany({ data: BIG_SEED });
  snapshot = raw.serialize();   // better-sqlite3 snapshot API
});

beforeEach(() => {
  raw = new Database(snapshot);   // restore in <1 ms even at 10k rows
  raw.pragma('foreign_keys = ON');
  db = createDb({ schema, driver: betterSqlite3Driver(raw) });
});
```

`raw.serialize()` returns a `Buffer` that's the byte image of the DB. `new Database(buffer)` is a hot-restore — no DDL replay, no row-by-row insert. Cheaper than re-migrating + re-seeding on a per-test basis once the seed is non-trivial.

---

## Fixture factories

Hand-rolled seeds rot. The same five fields show up in every test, with the same five-line `{ id: 'u1', email: 'a@x.co', name: 'Alice', created_at: new Date(0), updated_at: new Date(0) }` boilerplate. Pull that into a factory.

```ts
// test/factories.ts
import { ulid } from 'ulidx';
import type { InferCreate } from 'forge-orm';
import { User, Post } from '../src/schema';

type UserCreate = InferCreate<typeof User>;
type PostCreate = InferCreate<typeof Post>;

export const aUser = (overrides: Partial<UserCreate> = {}): UserCreate => ({
  email: `${ulid()}@x.co`,   // unique per call — avoids unique-constraint collisions
  name:  'Test User',
  ...overrides,
});

export const aPost = (authorId: string, overrides: Partial<PostCreate> = {}): PostCreate => ({
  author_id: authorId,
  title:     'Test Post',
  body:      'Body',
  ...overrides,
});
```

Usage in a test:

```ts
test('a user can have many posts', async () => {
  const u = await tx.user.create({ data: aUser({ name: 'Alice' }) });
  await tx.post.createMany({ data: [aPost(u.id), aPost(u.id, { title: 'Two' })] });
  const found = await tx.user.findFirst({ where: { id: u.id }, include: { posts: true } });
  expect(found?.posts).toHaveLength(2);
});
```

Each factory is **one line of overrides** in the test. The full doc for this pattern, including relation-aware factories, sequence factories, and trait composition, is in [FIXTURES.md](./FIXTURES.md).

---

## Type-safe test data builders

When overrides carry invariants (a paid `Order` must have a `payment_method_id`), a *builder* enforces them at the type-level:

```ts
class OrderBuilder {
  private d: Partial<InferCreate<typeof Order>> = {};
  withCustomer(id: string) { this.d.customer_id = id; return this; }
  paid(method: string)     { this.d.status = 'paid'; this.d.payment_method_id = method; return this; }
  pending()                { this.d.status = 'pending'; this.d.payment_method_id = null; return this; }
  build(): InferCreate<typeof Order> {
    if (this.d.status === 'paid' && !this.d.payment_method_id) throw new Error('paid needs pm');
    return { customer_id: 'c0', total_cents: 0, status: 'pending', ...this.d };
  }
}
export const anOrder = () => new OrderBuilder();

const paid = anOrder().withCustomer(u.id).paid('pm_card').build();
```

Builders are heavier than factories. Use them when the model has a state machine or non-trivial cross-field invariants; for simple "row with overrides" cases, factories win.

---

## Mocking forge — don't

If you came to this page looking for a "how do I mock `db.user.findFirst`?" answer: don't. Use [in-memory SQLite](#in-memory-sqlite-as-the-unit-test-db) for server tests and [FakeWorker](#fakeworker-for-browser-tests) for browser tests. Both run real forge against real (or real-shaped) data, both are fast enough for unit-test budgets, and both stay correct as forge's surface evolves.

Two cases where mocking is the right answer:

* **You're testing code that *calls forge*, and forge isn't the thing under test.** A controller that calls `db.user.findFirst`, formats the result, and returns it. You can `vi.spyOn(db.user, 'findFirst').mockResolvedValue(stub)` — but it's almost always cleaner to run the real query against an in-memory DB with a seeded fixture.
* **You're testing failure paths that the in-memory DB doesn't easily produce.** Network timeouts, lock-contention errors, connection-pool exhaustion. Forge throws typed errors for these; mocking the driver to throw them lets you assert on the error path without spinning up a chaos rig.

If you mock anything, mock at the **driver** layer, not the wrapper layer. The driver port is small (`{ exec, all, get, run, close }`) and stable. The wrapper surface is large and forge changes the shape between minor versions when it makes the typed shape cleaner.

```ts
// Good — mocks the small, stable port.
const driver = {
  kind: 'sqlite' as const,
  exec: vi.fn().mockResolvedValue(undefined),
  all:  vi.fn().mockResolvedValue([]),
  get:  vi.fn().mockResolvedValue(undefined),
  run:  vi.fn().mockResolvedValue({ changes: 0, lastInsertRowid: 0 }),
  close: vi.fn().mockResolvedValue(undefined),
};
const db = await createDb({ schema, driver });
```

```ts
// Bad — mocks the wrapper. Brittle across versions.
vi.mock('../src/db', () => ({
  db: {
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) },
  },
}));
```

---

## Testing inside `$transaction`

A common case: the code under test calls `db.$transaction(async (tx) => ...)`. You want to assert that the right writes happen on the right rows. Three patterns.

**Test the post-state.** Run the code, then read the DB. Works whether the production code committed or not, because at the end you observe the result the application would see.

```ts
test('checkout charges the card and clears the cart', async () => {
  await checkoutOrder(db, { userId: u.id, cartId: c.id, paymentMethodId: 'pm_card' });
  const order = await db.order.findFirst({ where: { customer_id: u.id }, orderBy: { created_at: 'desc' } });
  expect(order?.status).toBe('paid');
  const cart  = await db.cart.findFirst({ where: { id: c.id } });
  expect(cart?.items).toEqual([]);
});
```

**Inject the tx.** Refactor the code-under-test to accept `db` (which can be a `$transaction` proxy). Tests pass `tx`, production passes `db`. Pairs perfectly with the [transaction-rollback pattern](#transaction-rollback-per-test):

```ts
export async function checkoutOrder(
  db: ForgeDb<typeof schema> | ForgeTx<typeof schema>,
  args: CheckoutArgs,
) { /* ... */ }
```

**Assert on emitted events.** See [Testing event hooks](#testing-event-hooks) — every write inside the tx emits a `QueryEvent`. Subscribing tells you what shape the production transaction took without recreating it.

---

## Testing event hooks

Forge emits a `QueryEvent` per query (compiled SQL, params, duration, `semanticOp`, model, op). Tests can subscribe and assert on the captured stream — a clean way to test middleware, audit logs, and observability code.

```ts
import type { QueryEvent } from 'forge-orm';

test('audit middleware records every write', async () => {
  const events: QueryEvent[] = [];
  const off = db.$on('query', (e) => events.push(e));

  await db.user.create({ data: aUser() });
  await db.user.update({ where: { id: u.id }, data: { name: 'Renamed' } });
  await db.user.delete({ where: { id: u.id } });

  off();

  const writes = events.filter((e) => ['create', 'update', 'delete'].includes(e.semanticOp ?? ''));
  expect(writes.map((e) => e.semanticOp)).toEqual(['create', 'update', 'delete']);
  expect(writes.every((e) => e.model === 'user')).toBe(true);
});
```

The `semanticOp` field is the model-level verb (`create`, `update`, `findFirst`, `findMany`, …) — distinct from `op`, which is the lower-level adapter call. See [EVENTS.md § semanticOp taxonomy](./EVENTS.md#semanticop-taxonomy) for the full list.

Order matters for some tests — the event stream is emission-ordered, which matches the order of the awaits in your code, so `events.map((e) => \`${e.model}:${e.semanticOp}\`)` is the cleanest way to assert "this sequence in this order."

For queries that throw, subscribe to `'error'` instead and inspect `e.cause?.constraint` / `e.cause?.code`:

```ts
const errors: ErrorEvent[] = [];
db.$on('error', (e) => errors.push(e));
await expect(/* duplicate insert */).rejects.toThrow();
expect(errors[0]?.cause?.constraint).toBe('user_email_key');
```

---

## Testing migrations

Forge's migration story has three test surfaces.

**`db.$migrate()` is idempotent.** Calling it twice on a fresh DB should make the same DDL changes and the second call should be a no-op:

```ts
test('migrate is idempotent', async () => {
  const r1 = await db.$migrate();
  expect(r1.created.length).toBeGreaterThan(0);
  const r2 = await db.$migrate();
  expect(r2.created).toEqual([]);
  expect(r2.pending).toEqual([]);
});
```

**Drift detection finds intentional drift.** Add a column to the schema after migrate, run again, assert the drift report mentions it. See [MIGRATIONS.md § Drift detection](./MIGRATIONS.md) for the report shape; the relevant test surface is `report.alteredColumns` for safe additions and `report.pending` for destructive items.

```ts
test('adding a nullable column shows up under alteredColumns', async () => {
  await db.$migrate();   // baseline

  // Schema now grows a column out-of-band — re-create the db handle pointing at the new schema.
  const grownSchema = { ...schema, user: User.extend({ phone: f.text().nullable() }) };
  const db2 = await createDb({ schema: grownSchema, driver: betterSqlite3Driver(raw) });
  const r = await db2.$migrate();
  expect(r.alteredColumns).toContainEqual(expect.objectContaining({ table: 'user', column: 'phone' }));
});
```

**Introspection matches the IR.** For libraries that build on top of forge's schema, the introspected shape from the live DB should round-trip back to the IR you fed it. Forge ships an `introspect()` helper on every adapter:

```ts
import { introspect } from 'forge-orm/introspect';

test('the introspected schema matches the IR we pushed', async () => {
  await db.$migrate();
  const live = await introspect(driver);
  expect(live.tables.user.columns.email).toMatchObject({ type: 'text', nullable: false, unique: true });
});
```

For destructive operations (`DROP COLUMN`, type change), see [PUSH.md](./PUSH.md) and [DIFF.md](./DIFF.md) — the test surface is the diff report, not the apply.

---

## Testing geo, vector, FTS, and JSON path

Each of these features has an in-memory equivalent that lets you test without provisioning a real database.

**Geo.** `f.geoPoint()` plus `near` / `nearTo` / `withinPolygon` work against in-memory SQLite via the haversine fallback. Set `geo: { mode: 'haversine' }` in `createDb` opts to bypass the R-Tree extension on builds that don't ship it; results are mathematically identical for points-only datasets.

```ts
const db = await createDb({ schema, driver: betterSqlite3Driver(raw), geo: { mode: 'haversine' } });
const near = await db.cafe.findMany({
  where: { location: { near: { point: { lng: -0.13, lat: 51.51 }, withinMeters: 5_000 } } },
});
```

**Vector.** `f.vector(N)` columns store as TEXT on SQLite and compute cosine distance in JS. Fine for unit tests; for production-shaped tests, swap in DuckDB-in-memory with `vss` for the real index path.

**FTS.** Forge's FTS5 layer compiles to `MATCH` against an SQLite virtual table. better-sqlite3 ships FTS5, so the in-memory test path is identical to production-on-SQLite. For Postgres-shaped FTS (`tsvector`/`tsquery`), use Testcontainers — see [INTEGRATION-TESTING.md](./INTEGRATION-TESTING.md).

**JSON path.** `f.jsonPath('$.address.city')` compiles to SQLite `json_extract`. Modern better-sqlite3 ships JSON1 — no setup needed.

---

## Testing browser code with FakeWorker + jsdom

React component tests, hook tests, zustand store tests — anything that imports `forge-orm/wasm`. Use the [piped FakeWorker](#fakeworker-for-browser-tests) pattern so SQL is real, and run under jsdom.

```ts
// vitest config — per-file env
// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createDb, wasmSqliteDriver } from 'forge-orm';
import { schema } from '../src/schema';
import { UserList } from '../src/components/UserList';

let db: Awaited<ReturnType<typeof createDb<typeof schema>>>;

beforeEach(async () => {
  const worker = pipeToBetterSqlite();   // from FakeWorker section
  db = await createDb({ schema, driver: wasmSqliteDriver({ worker: worker as unknown as Worker }) });
  await db.$migrate();
  await db.user.createMany({ data: [
    { email: 'a@x.co', name: 'Alice' },
    { email: 'b@x.co', name: 'Beth' },
  ]});
});

it('renders every user', async () => {
  render(<UserList db={db} />);
  expect(await screen.findByText('Alice')).toBeInTheDocument();
  expect(await screen.findByText('Beth')).toBeInTheDocument();
});
```

OPFS isn't real under jsdom. Code paths that branch on `navigator.storage.getDirectory()` need a stub:

```ts
beforeEach(() => {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { getDirectory: vi.fn().mockResolvedValue({}) },
  });
});
```

For tests that need to assert the OPFS *capability probe* (`browserDoctor()`) takes a specific branch, mock `navigator.storage.getDirectory` to throw — the probe reports the failure and falls back to `:memory:`.

---

## Asserting emitted SQL

For adapter tests, tests that assert "the compiler emits the right SQL," and tests that catch performance regressions, capture `QueryEvent.sql` directly:

```ts
test('findFirst with select emits only the selected columns', async () => {
  const emitted: { sql: string; params: unknown[] }[] = [];
  const off = db.$on('query', (e) => emitted.push({ sql: e.sql, params: e.params }));

  await db.user.findFirst({ where: { id: 'u1' }, select: { id: true, email: true } });
  off();

  expect(emitted).toHaveLength(1);
  expect(emitted[0].sql).toMatch(/SELECT "id", "email" FROM "user"/);
  expect(emitted[0].sql).not.toMatch(/"name"/);
});
```

For cross-dialect SQL assertions (without spinning up Postgres or MySQL), use the compile-only path — every adapter exposes a `compile` entrypoint that returns the SQL without executing it. See [QUERIES.md § Compile API](./QUERIES.md) for the shape; the unit-test surface looks like:

```ts
import { compileFindMany } from 'forge-orm/compile';

test('Postgres compiles ILIKE for string contains', () => {
  const compiled = compileFindMany(User, { where: { name: { contains: 'al' } } }, { adapter: 'postgres' });
  expect(compiled.sql).toMatch(/ILIKE/);
});
test('MySQL compiles LIKE for string contains', () => {
  const compiled = compileFindMany(User, { where: { name: { contains: 'al' } } }, { adapter: 'mysql' });
  expect(compiled.sql).toMatch(/LIKE/);
  expect(compiled.sql).not.toMatch(/ILIKE/);
});
```

Compile-only tests are cheap and adapter-agnostic. They catch the largest class of regressions in adapter PRs.

---

## Coverage targets

Sensible defaults for a project that builds on top of forge:

* **80% line coverage** on application code (controllers, repos, services).
* **90%+ on data-layer code** — repository functions, mutation services, anything that touches forge directly.
* **100% on type generics** — `Infer*` types should be exercised by at least one type test (see [TYPES.md](./TYPES.md)).
* **Ignore the IR codegen output.** The files under `src/ir/codegen/` are generated; coverage on them is meaningless. Add them to the `exclude` list (vitest) or `coveragePathIgnorePatterns` (jest).

```ts
// vitest.config.ts excerpt
coverage: {
  exclude: [
    'src/ir/codegen/**',
    'src/**/*.d.ts',
    'src/**/*.gen.ts',
    'test/**',
  ],
  thresholds: {
    lines:      80,
    functions:  80,
    branches:   75,
    statements: 80,
  },
},
```

Type tests (assertions on inferred types) don't show up in line coverage — they're compile-time only. Use [`expect-type`](https://github.com/mmkal/expect-type) or `tsd` to assert that `InferRow<typeof User>` has the shape you expect, and check those tests run as part of `tsc --noEmit`.

---

## Worked example A — vitest with in-memory + rollback

Recommended shape for a server-side repository spec file. Setup is the [transaction-rollback](#transaction-rollback-per-test) pattern from above; the new content is the tests themselves.

```ts
// test/repos/user.spec.ts
// ... beforeAll: open Database(':memory:'), $migrate. beforeEach: $transaction → tx. afterEach: rollback() ...

test('findUserByEmail returns the user when present', async () => {
  const created = await tx.user.create({ data: aUser({ email: 'a@x.co' }) });
  expect((await findUserByEmail(tx, 'a@x.co'))?.id).toBe(created.id);
});

test('findUserByEmail returns null when absent', async () => {
  expect(await findUserByEmail(tx, 'nobody@x.co')).toBeNull();
});

test('createUserWithFirstPost writes both atomically', async () => {
  const result = await createUserWithFirstPost(tx, { email: 'b@x.co', name: 'Bob', first_post_title: 'Hello' });
  expect(result.posts).toHaveLength(1);
});

test('rolls back if the post insert violates an FK', async () => {
  await expect(createUserWithFirstPost(tx, {
    email: 'c@x.co', name: 'Cleo', first_post_title: 'X'.repeat(10_000),
  })).rejects.toThrow();
  expect(await tx.user.findFirst({ where: { email: 'c@x.co' } })).toBeNull();
});
```

Real repository code, full transactional isolation between tests, one process-wide DB. On a 2024 MacBook this runs in under 100 ms cold and under 30 ms warm.

---

## Worked example B — jest with FakeWorker for a React component

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import { createDb, wasmSqliteDriver } from 'forge-orm';
import { ForgeProvider } from 'forge-orm/react';
import { schema } from '../src/schema';
import { UserDirectory } from '../src/components/UserDirectory';
import { pipeToBetterSqlite } from '../test/fake-worker';   // FakeWorker class + pipe, from above

describe('<UserDirectory>', () => {
  let db: Awaited<ReturnType<typeof createDb<typeof schema>>>;

  beforeEach(async () => {
    const worker = pipeToBetterSqlite();
    db = await createDb({ schema, driver: wasmSqliteDriver({ worker: worker as unknown as Worker }) });
    await db.$migrate();
  });

  it('renders the rows from the in-memory db', async () => {
    await db.user.createMany({ data: [
      { email: 'a@x.co', name: 'Alice' },
      { email: 'b@x.co', name: 'Bob' },
    ]});

    render(<ForgeProvider db={db}><UserDirectory /></ForgeProvider>);
    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });
  });

  it('shows the empty state when the table is empty', async () => {
    render(<ForgeProvider db={db}><UserDirectory /></ForgeProvider>);
    await waitFor(() => expect(screen.getByText('No users yet.')).toBeInTheDocument());
  });
});
```

The wasm driver thinks it's wired into a real Web Worker. The worker is forwarding to better-sqlite3. The React component sees a real `db` whose SQL has real semantics; React Testing Library asserts on the DOM. No browser, no real worker, no flakiness. For deeper React patterns — Suspense boundaries, mutation hooks, optimistic updates — see [REACT.md](./REACT.md).

---

## Worked example C — asserting an SQL emit

When a regression matters at the SQL level — a soft-delete filter that must be in every query, an index hint that must survive a refactor — assert directly on `QueryEvent.sql`.

```ts
test('every find on Document includes the soft-delete filter', async () => {
  const events: QueryEvent[] = [];
  const off = db.$on('query', (e) => { if (e.model === 'document') events.push(e); });

  await db.document.findFirst({ where: { id: 'd1' } });
  await db.document.findMany({ where: { tag: 'urgent' } });
  await db.document.findMany({ where: { OR: [{ tag: 'a' }, { tag: 'b' }] } });
  off();

  expect(events).toHaveLength(3);
  for (const e of events) expect(e.sql).toMatch(/"deleted_at"\s+IS\s+NULL/);
});
```

For "this aggregate must use the covering index," follow up with `EXPLAIN QUERY PLAN <events[0].sql>` against the in-memory `raw` handle and match on the planner output. `semanticOp` is the right discriminant for "every query of this kind" — it survives query-shape refactors that change the raw SQL.

---

## Anti-patterns

Patterns that look right and quietly aren't.

* **Sharing a `db` handle across test files without isolation.** Vitest and jest run files in parallel; tests that pass alone start failing under `--threads`. Open one DB per file, or use a per-file rollback boundary.
* **Truncating between tests.** `DELETE FROM …` is the slowest reset on a non-trivial schema and leaves the prepared-statement cache pointing at stale plans on some drivers. Drop-recreate or transaction-rollback both win.
* **Asserting on driver-internal details.** `expect(raw.prepare).toHaveBeenCalledWith(...)` ties the test to better-sqlite3's API. Assert on `QueryEvent.sql` or on the database state.
* **Using `findFirst` to assert a `count`.** If the assertion is "n rows match," do `count({ where })`. Cheaper, clearer.
* **Forgetting `foreign_keys = ON`.** SQLite is off by default. Tests silently pass on broken FK relationships.
* **Mixing `db` and `tx` in the test body.** The same bug the production code has — see [TRANSACTIONS.md § Common bugs](./TRANSACTIONS.md#common-bugs). A test that writes through `db` while in a `tx` rollback boundary leaves rows behind for the next test.
* **Re-running `$migrate()` on every test.** Idempotent but not free on a 30-table schema. Run it once per file and let [transaction rollback](#transaction-rollback-per-test) handle the per-test reset.

---

For the next layer up — tests against real Postgres / MySQL / Mongo via Testcontainers — see **[INTEGRATION-TESTING.md](./INTEGRATION-TESTING.md)**. For factory and seed-data patterns in detail, **[FIXTURES.md](./FIXTURES.md)**. For the browser-specific surfaces FakeWorker is approximating, **[BROWSER.md](./BROWSER.md)**. For the React testing hooks story end to end, **[REACT.md](./REACT.md)**. For the write verbs you'll be asserting on, **[MUTATIONS.md](./MUTATIONS.md)**. For the rollback pattern at the source, **[TRANSACTIONS.md § Testing patterns](./TRANSACTIONS.md#testing-patterns)**.
