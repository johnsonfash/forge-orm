# Fixtures and factories

Test data patterns for forge-orm — static fixture files, type-safe factories, deterministic-random builders, snapshot fixtures, and the reset strategies that keep tests isolated. This page sits between [TESTING.md](TESTING.md) (unit setup) and [SEED.md](SEED.md) (production-shape data) — fixtures live in the middle.

The companion docs are [TESTING.md](./TESTING.md) (the harness fixtures plug into), [INTEGRATION-TESTING.md](./INTEGRATION-TESTING.md) (Testcontainers + live drivers — fixture files load the same way), [SEED.md](./SEED.md) (bootstrap data — distinct from fixtures), [TYPES.md](./TYPES.md) (`Infer*` and `ForgeOf` — the type aliases factories ride on), [MUTATIONS.md](./MUTATIONS.md) (the verbs factories pass data to), and [TRANSACTIONS.md § Testing patterns](./TRANSACTIONS.md#testing-patterns) (the per-test rollback boundary fixtures reset inside).

## Contents

* [Fixtures vs seeds vs factories](#fixtures-vs-seeds-vs-factories)
* [Static fixture files — JSON, YAML, TS](#static-fixture-files--json-yaml-ts)
* [The factory pattern — `build` vs `create`](#the-factory-pattern--build-vs-create)
* [Relationship factories — nested writes](#relationship-factories--nested-writes)
* [Deterministic randomness — seeded faker](#deterministic-randomness--seeded-faker)
* [Snapshot fixtures — load a known DB state](#snapshot-fixtures--load-a-known-db-state)
* [Community options — fishery, @mswjs/data](#community-options--fishery-mswjsdata)
* [Resetting between tests](#resetting-between-tests)
* [Sharing factories across tests](#sharing-factories-across-tests)
* [Type-safety — `ForgeOf` and `Infer*`](#type-safety--forgeof-and-infer)
* [Snapshot testing of query results](#snapshot-testing-of-query-results)
* [Time and clock fixtures](#time-and-clock-fixtures)
* [Geo, vector, JSON fixtures](#geo-vector-json-fixtures)
* [Browser fixtures — pre-populated sqlite-wasm OPFS](#browser-fixtures--pre-populated-sqlite-wasm-opfs)
* [Worked examples](#worked-examples)
* [Cross-references](#cross-references)

---

## Fixtures vs seeds vs factories

Three words for three things. The codebase that gets them confused ends up with a `fixtures/` folder full of seed data, a `seed.ts` that generates random fakes, and a factory called `create()` that talks to the wrong database. Untangle them up front.

**Seed** — bootstrap data. Always-on rows the application needs to function. The default org, the admin user, the currency table, the plan list. Lives in `scripts/seed/`, runs against production, must be idempotent on every adapter. Full coverage in [SEED.md](./SEED.md).

**Fixture** — a static, known state. A specific row or set of rows that a test reads or asserts against. "User Alice with id `u_alice`, email `a@x.co`, role `admin`." The values are picked once and never change between runs — a test that says `expect(user.email).toBe('a@x.co')` requires a fixture, not a randomly-generated row.

**Factory** — a generator. A function that takes overrides and returns an insertable shape: `aUser({ role: 'admin' })`. The defaults are sensible, the overrides are sparse, the same factory powers a hundred tests that each need a slightly different user. Factories don't *touch* the database — they return data; a sibling helper does the insert.

| Concept   | Static or generated? | Where it lives        | Lifecycle                     |
|-----------|----------------------|----------------------|-------------------------------|
| Seed      | Static               | `scripts/seed/`      | Boots the app                 |
| Fixture   | Static               | `test/fixtures/`     | Loaded per test or per suite  |
| Factory   | Generated            | `test/factories/`    | Called per test               |

The three compose. The bootstrap seed runs in `beforeAll` to give the test suite the rows the application code expects. A snapshot fixture loads a known dataset for a particular spec file. Factories build the per-test data that exercises the behaviour under test. None of these is "the way to do it" — they're a layered toolkit and the choice depends on what the test is asserting.

The shortcut for picking the right tool: **if your test asserts on a specific value (`expect(x).toBe('a@x.co')`), the value came from a fixture; if it asserts on a shape (`expect(x).toMatchObject({ role: 'admin' })`), the value came from a factory.**

---

## Static fixture files — JSON, YAML, TS

Static fixtures live on disk. The test loads them, inserts them, asserts against them. Three formats with three different trade-offs.

**TypeScript fixtures** — the default for new forge codebases:

```ts
// test/fixtures/users.ts
import type { InferCreate } from 'forge-orm';
import type { User } from '../../src/schema';

export const USER_ALICE: InferCreate<typeof User> = {
  id:    'u_alice',
  email: 'alice@x.co',
  name:  'Alice',
  role:  'admin',
};

export const USER_BOB: InferCreate<typeof User> = {
  id:    'u_bob',
  email: 'bob@x.co',
  name:  'Bob',
  role:  'member',
};

export const FIXTURE_USERS = [USER_ALICE, USER_BOB] as const;
```

The fixture is typechecked against the schema. Add a required field to `User` and `tsc` flags every fixture file. Rename `name` to `full_name` and the same. The cost is that the file is code — diff reviewers read TS keys instead of YAML scalars, but the file ships through the normal build pipeline.

**JSON fixtures** — for data exported from another system:

```ts
import users from './fixtures/users.json' assert { type: 'json' };
const typed = users as InferCreate<typeof User>[];   // runtime trust, compile-time cast
await tx.user.createMany({ data: typed });
```

Right call when the fixture file is generated upstream — exported from a spreadsheet, dumped from another database, fetched from a fixture-generator tool. The downside is no compile-time check: the cast on import is a `trust me`. Pair it with a zod schema if the file is large or comes from outside the team.

**YAML fixtures** — for review-friendly long-form data:

```ts
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
const users = parse(readFileSync('test/fixtures/users.yaml', 'utf8'));
```

YAML reviews better than JSON for multi-paragraph strings, embedded comments, and human-curated data. Wrong call when the fixture has booleans (`yes` / `no` legacy coercion), null markers, or complex types — the YAML parser's choices and the JS runtime's choices don't always agree.

### Loading per test setup

```ts
beforeEach(async () => { await tx.user.createMany({ data: FIXTURE_USERS }); });
```

`createMany` is the right verb — one statement on every adapter. For 20-row fixtures it's negligible; for 2,000-row fixtures see [Snapshot fixtures](#snapshot-fixtures--load-a-known-db-state) — bytes-on-disk restore beats row-by-row insert at that size. For fixtures with relations, see [Relationship factories](#relationship-factories--nested-writes) — the static fixture grows nested `posts: { create: [...] }` keys and the insert handles the whole graph in one call.

---

## The factory pattern — `build` vs `create`

A factory is a function. Defaults plus overrides, in plus out. The shape that wears well across thousands of tests:

```ts
// test/factories/user.ts
import { ulid } from 'ulidx';
import type { InferCreate } from 'forge-orm';
import { User } from '../../src/schema';

export type UserOverrides = Partial<InferCreate<typeof User>>;

export function buildUser(overrides: UserOverrides = {}): InferCreate<typeof User> {
  return {
    email: `${ulid()}@x.test`,    // unique per call — sidesteps unique constraint
    name:  'Test User',
    role:  'member',
    ...overrides,
  };
}
```

`buildUser` returns the *shape*. It doesn't touch the database, doesn't depend on a `db` or `tx` handle, doesn't await anything. Pure function — calls are cheap, results compose. Use it when the test wants to inspect the shape, pass it to a non-DB function, or hand it to a verb of its own choosing.

The sibling that *does* insert:

```ts
import type { ForgeTx } from 'forge-orm';

export async function createUser(tx: ForgeTx<typeof schema>, overrides: UserOverrides = {}) {
  return tx.user.create({ data: buildUser(overrides) });
}
```

`createUser` takes a `tx`, hands the built shape to `tx.user.create`, returns the resolved row (with `id`, `created_at`, defaults applied). This is the one tests usually want — `const alice = await createUser(tx, { role: 'admin' });` and Alice is in the database with her server-side fields populated.

The split is load-bearing:

| Variant         | Returns                       | Touches DB? | Use for                                  |
|-----------------|------------------------------|-------------|------------------------------------------|
| `buildUser(o)`  | `InferCreate<typeof User>`    | No          | Asserting on input shape, batch inserts, snapshots |
| `createUser(o)` | `Promise<Row<typeof User>>`   | Yes         | The 90% case — the test needs a row in the DB |

Both share the same defaults block. Adding a required field to the model is one edit to `buildUser`; everything else picks it up.

### Why a factory beats a fixture for most cases

A fixture is a value — fixed, known, asserted-against. A factory is a generator — same defaults, different overrides each time. Tests that hit unique constraints (every test creates a "user", and `email` is unique) need the factory's generated-per-call value. Tests that assert on a specific id (`expect(user.id).toBe('u_alice')`) need the fixture's pinned value. Most tests want the first.

Factories also tolerate schema growth. Add a required `terms_accepted_at: f.dateTime()` column, every static fixture file goes red until each row gets the new field. Update `buildUser` once and every call site picks it up.

---

## Relationship factories — nested writes

Forge's nested-write DSL takes the relation key inline. Factories layer on top:

```ts
// test/factories/post.ts
import type { InferCreate } from 'forge-orm';
import { Post } from '../../src/schema';

export type PostOverrides = Partial<InferCreate<typeof Post>>;

export function buildPost(overrides: PostOverrides = {}): InferCreate<typeof Post> {
  return {
    title: 'Test Post',
    body:  'Body.',
    ...overrides,
  };
}
```

`buildPost` on its own doesn't reference an author — the relation goes through forge's nested-write keys. The composition lives in `buildUser`:

```ts
// test/factories/user.ts (extended)
export type UserWithPosts = UserOverrides & {
  posts?: InferCreate<typeof Post>[];
};

export function buildUser(overrides: UserWithPosts = {}): InferCreate<typeof User> {
  const { posts, ...userFields } = overrides;
  return {
    email: `${ulid()}@x.test`,
    name:  'Test User',
    role:  'member',
    ...userFields,
    ...(posts ? { posts: { create: posts } } : {}),
  };
}
```

Now `buildUser` accepts a `posts` array that's `buildPost`-shaped:

```ts
const u = await tx.user.create({
  data: buildUser({
    name: 'Alice',
    posts: [buildPost({ title: 'One' }), buildPost({ title: 'Two' })],
  }),
});
expect(u.posts).toHaveLength(2);
```

Forge writes the user *and* both posts in one logical operation — the same nested-write path covered in [MUTATIONS.md § Nested writes](./MUTATIONS.md#nested-writes). The factory layer is purely a defaulting / type-narrowing convenience.

### `connect` and `connectOrCreate` from factories

For models that reference existing rows, the nested-write DSL uses `connect`. For the "create if missing, else reference" case, `connectOrCreate`:

```ts
export const buildUserInOrg = (orgId: string, o: UserOverrides = {}) =>
  buildUser({ ...o, org: { connect: { id: orgId } } });

export const buildUserAtOrg = (orgSlug: string, o: UserOverrides = {}) =>
  buildUser({
    ...o,
    org: { connectOrCreate: { where: { slug: orgSlug }, create: { slug: orgSlug, name: `Org ${orgSlug}` } } },
  });
```

The seed pattern from [SEED.md § Order, relations and nested writes](./SEED.md#order-relations-and-nested-writes) carries straight across — fixtures and seeds compose with the same DSL.

### Many-to-many

Join tables write through `connectOrCreate` on the relation key:

```ts
export function buildPostWithTags(tagNames: string[], overrides: PostOverrides = {}) {
  return buildPost({
    ...overrides,
    tags: {
      connectOrCreate: tagNames.map((name) => ({
        where:  { name },
        create: { name },
      })),
    },
  });
}
```

Re-runnable from inside test factories — every nested `connectOrCreate` is atomic on the SQL adapters, document-atomic on Mongo.

---

## Deterministic randomness — seeded faker

The first instinct for "fake users with realistic-looking names" is faker. The second instinct, the load-bearing one, is **seed it**.

```ts
// test/factories/_faker.ts
import { faker } from '@faker-js/faker';

faker.seed(42);

export { faker };
```

Every factory imports from `_faker.ts`. Every run produces the same sequence of "random" values. A test that picks the third faker-generated email gets the same email every time — no flaky test that passes on Monday and fails on Tuesday because the random distribution happened to hit a boundary case.

The factory:

```ts
import { faker } from './_faker';

export function buildFakeUser(overrides: UserOverrides = {}): InferCreate<typeof User> {
  return {
    email: faker.internet.email().toLowerCase(),
    name:  faker.person.fullName(),
    bio:   faker.lorem.sentence(),
    ...overrides,
  };
}
```

### When the seed isn't enough

`faker.seed(42)` makes the *order* of calls deterministic — call #1, call #2, call #3 always produce the same triple. Tests that run in `--shuffle` mode change the call order and the determinism breaks. Two fixes:

**Per-test seed reset.** `beforeEach(() => faker.seed(42))` — every test starts from the same seed. Test order doesn't matter; one test calling the factory N times still gets the same N values.

**Per-call seed via index.** `faker.seed(42 + i)` inside the loop. Each call is its own deterministic source. Slightly lower-quality distribution at small N; total independence from test ordering.

### `faker.internet.email()` collisions

The email generator's namespace is finite. At a few thousand calls you'll hit a duplicate and the unique constraint trips. The factory pattern that survives:

```ts
export const buildFakeUser = (o: UserOverrides = {}): InferCreate<typeof User> => ({
  email: `${ulid()}@${faker.internet.domainName()}`,   // ulid prefix — unique
  name:  faker.person.fullName(),
  ...o,
});
```

Realistic-looking domain from faker; uniqueness from `ulidx`. Same fix as [SEED.md § Realistic data](./SEED.md#realistic-data-with-faker-and-chance).

---

## Snapshot fixtures — load a known DB state

For tests that exercise complex multi-table queries — analytics, reports, search ranking — assembling the dataset row-by-row in `beforeEach` is slow and clutters the test body. The cleaner shape is to dump the DB once and restore it before each test.

Better-sqlite3 ships a `serialize()` API that returns the raw page bytes:

```ts
import Database from 'better-sqlite3';

let snapshot: Buffer;
let raw: Database.Database;
let db: ForgeDb<typeof schema>;

beforeAll(async () => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  db = await createDb({ schema, driver: betterSqlite3Driver(raw) });
  await db.$migrate();

  // Build a rich dataset once.
  await db.$transaction(async (tx) => {
    await tx.org.createMany({ data: FIXTURE_ORGS });
    await tx.user.createMany({ data: FIXTURE_USERS });
    await tx.post.createMany({ data: FIXTURE_POSTS });
    await tx.comment.createMany({ data: FIXTURE_COMMENTS });
  });

  snapshot = raw.serialize();
});

beforeEach(() => {
  raw = new Database(snapshot);    // restore from bytes — <1 ms even at 10k rows
  raw.pragma('foreign_keys = ON');
  db = createDb({ schema, driver: betterSqlite3Driver(raw) });
});

afterEach(() => raw.close());
```

The snapshot is the byte image of the in-memory DB. `new Database(buffer)` rehydrates it without replaying DDL or re-inserting rows. At 10,000 fixture rows the restore takes under a millisecond — cheaper than re-migrating + re-seeding per test.

### When to reach for snapshots

| Strategy                            | Setup cost (per test) | Maintainability                 |
|-------------------------------------|------------------------|---------------------------------|
| Per-test factory inserts            | ~1 ms / 10 rows        | Best — fixtures live in code    |
| Per-suite seed + per-test rollback  | ~0.1 ms                | Good — seed file is the source  |
| Snapshot restore                    | ~1 ms / 10k rows       | Worst — snapshot is opaque bytes |

Snapshots win at large datasets where the *content* doesn't change between tests but the cost of building it does. They lose when the content evolves — a snapshot built last sprint doesn't reflect the model added this sprint, and you only find out at test time. For Postgres / MySQL, the equivalent is a per-suite database template (`CREATE DATABASE testdb_X TEMPLATE testdb_seed`) — see [INTEGRATION-TESTING.md](./INTEGRATION-TESTING.md).

---

## Community options — fishery, @mswjs/data

The factory pattern in this doc is hand-rolled — 10 lines of TypeScript per model, no library required. For larger codebases, three off-the-shelf options reduce the boilerplate:

* **[fishery](https://github.com/thoughtbot/fishery)** — the original JS port of `factory_bot`. Factory chaining, sequences, traits, transient params. Pairs cleanly with forge: `Factory.define<InferCreate<typeof User>>(...)` — the type system carries through. Adds ~5 KB to the test-time bundle; nothing in production.
* **[@mswjs/data](https://github.com/mswjs/data)** — fixture-style in-memory store with a query API. Useful for component tests that want a "fake DB" without spinning up sqlite. Not a forge replacement; complement when you're not exercising forge in the test.
* **forge-fixtures** — at the time of writing there's no first-party fixtures package in `forge-orm`. If a community one ships, it'll be linked from this section. Until then, the hand-rolled pattern in [The factory pattern](#the-factory-pattern--build-vs-create) is the recommended shape.

The decision tree: hand-rolled factories for small projects (one factory file per model, ~10 lines each). Reach for fishery when the project has ten-plus models with non-trivial composition. Reach for `@mswjs/data` only for browser tests that don't touch forge at all.

---

## Resetting between tests

Three reset strategies — same three as [TESTING.md § Reset strategies](./TESTING.md#reset-strategies--fresh-db-drop-and-recreate-transaction-rollback), repeated here with the fixture-loading angle.

**Transaction rollback per test.** The default. Open a `$transaction` in `beforeEach`, throw to roll back in `afterEach`. Per-test factory inserts disappear at the boundary; per-suite seed survives because it committed in `beforeAll`. The full pattern is at [TESTING.md § Transaction-rollback per test](./TESTING.md#transaction-rollback-per-test). It's the right reset for ~95% of suites.

**Truncate per test.** Faster than `deleteMany`, slower than rollback. Wipes data, keeps schema. Use when the test needs to assert on triggers / defaults / serial-id reset, which rollback doesn't fire correctly. On Postgres / MySQL use `TRUNCATE ... RESTART IDENTITY CASCADE`; on SQLite `DELETE FROM <each table>` children-first, then re-insert the fixtures.

**Drop and re-migrate per test.** The slowest. Tear the schema down, push it back up. Use when the test changes the schema (DDL tests, drift-detection tests) — see [TESTING.md § Testing migrations](./TESTING.md#testing-migrations).

The strategy and the fixture layer are decoupled. Rollback + per-test factory inserts gives full isolation at the lowest cost. Snapshot restore + zero factory work gives the same isolation at a similar cost on large datasets. Pick by what the fixture *is*, not by what the reset is.

---

## Sharing factories across tests

The pull is to put one factory next to one test. Resist it. The factory shapes spread: every test file that needs a "user with a post" rolls its own and they drift. Centralise:

```
test/
  factories/
    index.ts         # re-exports
    user.ts          # buildUser, createUser
    post.ts          # buildPost, createPost
    org.ts           # buildOrg, createOrg
    _faker.ts        # faker.seed(42)
  fixtures/
    users.ts         # USER_ALICE, USER_BOB
    posts.ts         # POST_HELLO, POST_WORLD
  setup.ts
  helpers.ts
```

`test/factories/index.ts` re-exports every factory:

```ts
export * from './user';
export * from './post';
export * from './org';
```

Tests import from one place:

```ts
import { createUser, createPost, buildOrg } from '../factories';
```

The factory file owns the defaults for its model. The fixture file owns the named static rows. A new test gets composed from these atoms, not from cut-and-paste.

### The "scenario" helper

When the same test setup keeps repeating ("a user with three posts and a comment on each"), pull it into a *scenario* — a higher-level helper that composes the per-model factories:

```ts
// test/scenarios/blog.ts
export async function aBlogWithComments(tx: ForgeTx<typeof schema>) {
  const author  = await createUser(tx, { name: 'Author' });
  const post    = await createPost(tx, { author_id: author.id, title: 'Hi' });
  const reader  = await createUser(tx, { name: 'Reader' });
  const comment = await createComment(tx, { post_id: post.id, author_id: reader.id, body: 'cool' });
  return { author, post, reader, comment };
}
```

Scenarios are *composed of factories*, not parallel to them. They live in `test/scenarios/`, they call the factory layer, they return the rows the test needs to assert on.

---

## Type-safety — `ForgeOf` and `Infer*`

A factory that drifts from its model is a class of bug forge prevents at compile time — if the factory's return type is bound to the model. Two anchor points: `InferCreate<typeof Model>` and `ForgeOf<'modelKey'>`. The deep dive is [TYPES.md](./TYPES.md); the fixture-side recap:

**`InferCreate<typeof User>`** — the exact `data` shape `db.user.create({ data })` accepts. Required vs. optional fields are resolved; defaults are optional; relation directives are inferred. Return type for `buildUser`:

```ts
import type { InferCreate } from 'forge-orm';
export function buildUser(o: Partial<InferCreate<typeof User>> = {}): InferCreate<typeof User> { /* ... */ }
```

Add a required field to `User`, `tsc` flags `buildUser` immediately. Add an optional field, the existing factory keeps compiling — the override just opts in when the test wants to set it.

**`ForgeOf<'user'>`** — the resolved row shape for the schema key `'user'`. Useful when the factory returns the *server-side* row (after `id` / `created_at` / defaults are filled):

```ts
import type { ForgeOf } from 'forge-orm';

export async function createUser(
  tx: ForgeTx<typeof schema>,
  o: Partial<InferCreate<typeof User>> = {},
): Promise<ForgeOf<'user'>> {
  return tx.user.create({ data: buildUser(o) });
}
```

The `Promise<ForgeOf<'user'>>` annotation isn't strictly required — TS infers it — but writing it down catches future drift. The day someone changes `tx.user.create` to return a wrapped object, the factory call site breaks visibly.

### Type tests

For factories that compose deeply, assert the shape at compile time with `expect-type`:

```ts
import { expectTypeOf } from 'expect-type';

expectTypeOf(buildUser()).toEqualTypeOf<InferCreate<typeof User>>();
expectTypeOf(buildUser({ posts: [buildPost()] }).posts)
  .toMatchTypeOf<{ create: InferCreate<typeof Post>[] } | undefined>();
```

These don't show in line coverage — they're compile-time. Run them under `tsc --noEmit` as part of `npm test` so a type regression breaks the build.

---

## Snapshot testing of query results

Vitest and jest both ship `toMatchSnapshot` — a serialised assertion that the value matches a frozen reference. Two patterns for forge-query results.

**Inline snapshot for small results.** When the assertion is "this query returns this object," inline snapshots are reviewable in the test file:

```ts
test('user list returns three users sorted by name', async () => {
  await createUser(tx, { name: 'Alice' });
  await createUser(tx, { name: 'Bob' });
  await createUser(tx, { name: 'Carol' });
  const users = await tx.user.findMany({ orderBy: { name: 'asc' }, select: { name: true } });
  expect(users).toMatchInlineSnapshot(`
    [{ "name": "Alice" }, { "name": "Bob" }, { "name": "Carol" }]
  `);
});
```

The reviewer sees the result in the diff. Updates land in the same commit as the code change.

**External snapshot for large results.** Analytics queries, FTS results, vector search — anything over ~20 lines. The snapshot lands in `__snapshots__/`. CI fails on drift; `--update-snapshots` regenerates after a deliberate change.

### What to snapshot, what not to

Snapshot **shape and content**, not **server-generated values**. A snapshot that includes `created_at: '2026-06-24T10:23:45Z'` updates on every run. Strip volatile fields:

```ts
const strip = (rows: User[]) => rows.map(({ id, created_at, updated_at, ...rest }) => rest);
expect(strip(users)).toMatchSnapshot();
```

Better yet: combine snapshot fixtures with [seeded faker](#deterministic-randomness--seeded-faker) and fake timers so every server-generated value is itself deterministic — see [Time and clock fixtures](#time-and-clock-fixtures).

Don't snapshot SQL strings — assert on `QueryEvent.sql` with `.toMatch(/pattern/)` instead. SQL drifts with refactors; a regex is easier to read than a 50-character diff.

---

## Time and clock fixtures

Defaults like `created_at: f.dateTime().default(() => new Date())` produce a different value every run. Snapshot tests fail. Factories that set `created_at` to a known value get clobbered by the default. Two fixes.

**Fake the clock.** Vitest's `vi.useFakeTimers()` (jest's equivalent: `jest.useFakeTimers()`):

```ts
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  faker.seed(42);
});
afterEach(() => vi.useRealTimers());
```

`new Date()` in factory defaults returns the same value every call. Snapshots stabilise. `Date.now()` returns the same number across the test body.

The wrinkle: fake timers also pause `setTimeout` / `setInterval` / `setImmediate`. Code paths that wait on a timer hang the test. The fix is `vi.useFakeTimers({ shouldAdvanceTime: true })` — clock is fakeable, timers still fire — or `vi.advanceTimersByTime(ms)` to push the clock forward inside the test.

**Combine with seeded faker.** `faker.date.past()` uses `Date.now()` by default. With fake timers active, every "random" past date is reproducible relative to the frozen clock. Pairing the patterns gives a fully deterministic test — clock, faker, factory defaults, query results.

---

## Geo, vector, JSON fixtures

The annotated-column features have specific shapes to generate. Each composes with the factory pattern.

**Geo.** A fixture for "venues around London":

```ts
export function buildVenueNearLondon(o: VenueOverrides = {}) {
  const lng = -0.1276 + faker.number.float({ min: -0.1, max: 0.1 });
  const lat =  51.5074 + faker.number.float({ min: -0.05, max: 0.05 });
  return buildVenue({ loc: { lng, lat }, ...o });
}
```

The jitter is seeded. The shape is the same `{ lng, lat }` forge accepts on every adapter — see [GEO.md](./GEO.md). For polygons, the value is a `[lng, lat][]` ring; the factory generates a square N metres on a side around a centre point with a few lines of math.

**Vector.** Real embeddings are slow to compute. For unit tests, fake vectors of the right dimension are fine:

```ts
export function buildDocVector(dim = 1536, seed = 0): number[] {
  // Deterministic pseudo-random vector — same `seed` always returns the same vector.
  const out: number[] = []; let x = seed + 1;
  for (let i = 0; i < dim; i++) { x = (x * 1664525 + 1013904223) % 2_147_483_647; out.push((x / 2_147_483_647) * 2 - 1); }
  const len = Math.sqrt(out.reduce((s, v) => s + v * v, 0));   // normalise for stable cosine
  return out.map((v) => v / len);
}
```

Reproducible, normalised, matches the column's declared dimension. For tests that need semantic similarity (`X is closer to Y than Z`), fake vectors don't model that — use cached real embeddings or swap to a smaller dev embedder, as covered in [SEED.md § Vector](./SEED.md#vector).

**JSON.** Free-form columns round-trip whatever shape you pass:

```ts
export const buildPrefsJson = (o: Partial<UserPrefs> = {}): UserPrefs => ({
  theme: 'dark', notifications: { email: true, push: false }, locale: 'en-GB', ...o,
});
```

For `f.embed` columns, the embed's field shape validates at the type level — a typo in a key is a `tsc` error. For `f.json` columns, runtime validation is on you; pair with zod if the JSON shape carries invariants.

---

## Browser fixtures — pre-populated sqlite-wasm OPFS

Browser tests run under jsdom against the wasm driver. Pre-populating OPFS with a known DB state takes a slightly different shape than the server snapshot pattern — see [TESTING.md § FakeWorker for browser tests](./TESTING.md#fakeworker-for-browser-tests) for the underlying mechanism.

**Pattern A — load a fixture buffer into the FakeWorker.** Build the fixture in a `beforeAll` against in-memory sqlite, serialise, then feed it to a FakeWorker piped to a fresh restore:

```ts
let snapshot: Buffer;

beforeAll(async () => {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  const db = await createDb({ schema, driver: betterSqlite3Driver(raw) });
  await db.$migrate();
  await db.user.createMany({ data: FIXTURE_USERS });
  snapshot = raw.serialize();
  raw.close();
});

beforeEach(async () => {
  const raw = new Database(snapshot);
  raw.pragma('foreign_keys = ON');
  const worker = pipeToBetterSqlite(raw);   // FakeWorker piped to this restored DB
  db = await createDb({ schema, driver: wasmSqliteDriver({ worker: worker as unknown as Worker }) });
});
```

The wasm driver thinks it's talking to OPFS. The reality is a fresh restore from the snapshot buffer every test. Real SQL, real fixtures, zero per-test setup cost.

**Pattern B — mock OPFS to return the bytes.** When the code under test reads from `navigator.storage.getDirectory()` directly (rare), mock the OPFS API to return a `File` whose contents are the snapshot buffer. The full stub lives in the FakeWorker section of [TESTING.md](./TESTING.md#testing-browser-code-with-fakeworker--jsdom). For Vite / Next / Webpack-served browser tests that boot the real wasm worker, the fixture buffer is loaded via `fetch('/test-fixtures/seed.db')` and passed to the wasm driver's `open` call — see [BROWSER.md § Pre-populating OPFS](./BROWSER.md).

---

## Worked examples

### (a) Typed `userFactory` + `postFactory` with nested writes

```ts
// test/factories/_faker.ts
import { faker } from '@faker-js/faker';
faker.seed(42);
export { faker };

// test/factories/post.ts
export type PostOverrides = Partial<InferCreate<typeof Post>>;
export function buildPost(o: PostOverrides = {}): InferCreate<typeof Post> {
  return { title: faker.lorem.sentence(), body: faker.lorem.paragraphs(2), ...o };
}

// test/factories/user.ts
export type UserOverrides = Partial<InferCreate<typeof User>> & {
  posts?: InferCreate<typeof Post>[];
};
export function buildUser(o: UserOverrides = {}): InferCreate<typeof User> {
  const { posts, ...rest } = o;
  return {
    email: `${ulid()}@${faker.internet.domainName()}`,
    name:  faker.person.fullName(),
    role:  'member',
    ...rest,
    ...(posts ? { posts: { create: posts } } : {}),
  };
}
export async function createUser(tx: ForgeTx<typeof schema>, o: UserOverrides = {}) {
  return tx.user.create({ data: buildUser(o) });
}

// test/repos/user.spec.ts
test('a user with two posts is findable via include', async () => {
  const u = await createUser(tx, {
    name: 'Alice',
    posts: [buildPost({ title: 'One' }), buildPost({ title: 'Two' })],
  });
  const found = await tx.user.findFirst({ where: { id: u.id }, include: { posts: true } });
  expect(found?.posts).toHaveLength(2);
  expect(found?.posts.map((p) => p.title).sort()).toEqual(['One', 'Two']);
});
```

One factory per model. Defaults from seeded faker. Nested writes composed in the `buildUser` wrapper.

### (b) Snapshot fixture for an e-commerce test

```ts
// test/fixtures/storefront-snapshot.ts
let snapshot: Buffer | null = null;

export async function loadStorefrontSnapshot() {
  if (!snapshot) {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = await createDb({ schema, driver: betterSqlite3Driver(raw) });
    await db.$migrate();
    await db.$transaction(async (tx) => {
      const products  = await Promise.all(Array.from({ length: 50 }, (_, i) => createProduct(tx, { sku: `sku-${i}` })));
      const customers = await Promise.all(Array.from({ length: 10 }, (_, i) => createCustomer(tx, { email: `c${i}@x.test` })));
      for (let o = 0; o < 30; o++) {
        await createOrder(tx, {
          customer_id: customers[o % 10].id,
          product_ids: [products[o % 50].id, products[(o + 1) % 50].id],
        });
      }
    });
    snapshot = raw.serialize();
    raw.close();
  }
  const raw = new Database(snapshot);
  raw.pragma('foreign_keys = ON');
  return { db: await createDb({ schema, driver: betterSqlite3Driver(raw) }), raw };
}

// test/storefront/checkout.spec.ts
beforeEach(async () => { ({ db, raw } = await loadStorefrontSnapshot()); });
afterEach(() => raw.close());

test('a customer with orders sees them on the dashboard', async () => {
  const dashboard = await renderDashboard(db, { customer_id: 'c0' });
  expect(dashboard.orders.length).toBeGreaterThan(0);
});
```

The snapshot is built once (per process, lazy), restored per test in under a millisecond.

### (c) Seeded random for deterministic tests

```ts
import { test, expect, beforeEach } from 'vitest';
import { faker } from './factories/_faker';

beforeEach(() => {
  faker.seed(42);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

test('the leaderboard ranks the top three by faker-generated scores', async () => {
  await Promise.all(
    Array.from({ length: 10 }, () =>
      createUser(tx, {
        name:  faker.person.fullName(),
        score: faker.number.int({ min: 0, max: 1000 }),
      }),
    ),
  );

  const top3 = await tx.user.findMany({ orderBy: { score: 'desc' }, take: 3, select: { name: true, score: true } });

  expect(top3).toMatchInlineSnapshot(`
    [
      { "name": "Eldon Hessel",   "score": 972 },
      { "name": "Robyn Wisozk",   "score": 921 },
      { "name": "Jordy Kreiger",  "score": 877 },
    ]
  `);
});
```

Same `faker.seed(42)` every test, same faked clock, same factory defaults. The snapshot is byte-identical run to run.

### (d) Reset via per-test `BEGIN` / `ROLLBACK`

The pattern from [TESTING.md § Transaction-rollback per test](./TESTING.md#transaction-rollback-per-test), specialised for fixture loading. Bootstrap fixtures load once and commit; per-test fixtures load inside the transaction and roll back.

```ts
beforeAll(async () => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  db = await createDb({ schema, driver: betterSqlite3Driver(raw) });
  await db.$migrate();
  // Bootstrap fixtures — commit once, survive every per-test rollback.
  await db.user.createMany({ data: FIXTURE_USERS });
});

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    db.$transaction(async (txObj) => {
      tx = txObj;
      resolve();
      await new Promise<void>((_, reject) => { rollback = () => reject(new Error('test rollback')); });
    }).catch(() => {});
  });
});
afterEach(() => rollback());
afterAll(() => raw.close());

test('alice is visible because the bootstrap fixture committed', async () => {
  expect(await tx.user.findFirst({ where: { email: 'alice@x.co' } })).not.toBeNull();
});

test('per-test factory inserts are isolated', async () => {
  await createUser(tx, { name: 'Ephemeral' });
  // The next test will not see "Ephemeral" — the rollback wiped it.
});
```

Bootstrap fixtures live above the rollback boundary. Per-test factory inserts live inside it. Tests get a known starting state and a clean slate for what they add.

---

## Cross-references

* **[TESTING.md](./TESTING.md)** — harness, in-memory sqlite, FakeWorker, the rollback pattern fixtures reset inside.
* **[INTEGRATION-TESTING.md](./INTEGRATION-TESTING.md)** — Testcontainers shape; fixture files load identically against real Postgres / MySQL / Mongo.
* **[SEED.md](./SEED.md)** — bootstrap data, the production-shape sibling of fixtures.
* **[TYPES.md](./TYPES.md)** — `InferCreate`, `ForgeOf`, the type aliases factories ride on.
* **[MUTATIONS.md](./MUTATIONS.md)** — `create`, `upsert`, `createMany`, the nested-write DSL factories pass data to.
* **[TRANSACTIONS.md § Testing patterns](./TRANSACTIONS.md#testing-patterns)** — the rollback caveats and the Mongo `withTransaction` retry gotcha.
* **[EMBED.md](./EMBED.md) / [GEO.md](./GEO.md) / [VECTOR.md](./VECTOR.md) / [JSON-PATH.md](./JSON-PATH.md)** — value shapes for typed-column fixtures.
* **[BROWSER.md](./BROWSER.md)** — pre-populating OPFS with a fixture buffer; sqlite-wasm specifics.
* **[REACT.md](./REACT.md)** — composing fixtures with `ForgeProvider` for component tests.
