# Seeding

forge-orm has no built-in `seed` command — seeding is a userland pattern that uses the same runtime API as your application. This page covers the patterns that work: idempotent upserts, batched throughput, realistic data, and how to split bootstrap from dev/demo data.

The companion docs are [MUTATIONS.md](./MUTATIONS.md) (every write verb, what each compiles to), [TRANSACTIONS.md](./TRANSACTIONS.md) (the `$transaction` shape you'll wrap a seed in), and [MIGRATIONS.md](./MIGRATIONS.md) (how the schema gets into the database before the seed runs). Forward references to FIXTURES.md / TESTING.md / DEPLOYMENT.md land when those docs ship.

## Contents

* [Why seeding is userland](#why-seeding-is-userland)
* [The canonical seed script](#the-canonical-seed-script)
* [Idempotency — never use `create`](#idempotency--never-use-create)
* [Bootstrap vs dev vs demo](#bootstrap-vs-dev-vs-demo)
* [Order, relations and nested writes](#order-relations-and-nested-writes)
* [Embedded and JSON fields](#embedded-and-json-fields)
* [Geo, vector, FTS](#geo-vector-fts)
* [Large seeds — `createMany` and the array form](#large-seeds--createmany-and-the-array-form)
* [Realistic data with faker and Chance](#realistic-data-with-faker-and-chance)
* [Images, blobs, content-addressable keys](#images-blobs-content-addressable-keys)
* [CLI integration — `npm run seed`](#cli-integration--npm-run-seed)
* [Reset patterns](#reset-patterns)
* [Test-suite seeds](#test-suite-seeds)
* [Three worked examples](#three-worked-examples)
* [Cross-references](#cross-references)

---

## Why seeding is userland

Every ORM that ships a `seed` command has the same conversation. The team starts with a thin `seeds/001-users.ts` convention. Six months in there are env flags, transactions, a separate `seed:demo`, a `seed:reset`, and a wiki page nobody reads. The framework's seed-runner grows one feature at a time without a design and ends up the worst part of the codebase.

forge takes the opposite position: **the runtime API is good enough**. `db.user.upsert(...)` is the same call you'd make in a handler, a job, or a seed. There's no separate seeding contract to learn, no plugin system, no opinions about file naming. You write a TypeScript file that imports `db`, runs writes, and exits.

The primitives that make seeding ergonomic are all part of the runtime: atomic `upsert` (one statement on every adapter, no read-then-write race), `createMany` with `skipDuplicates` (bulk insert with conflict tolerance), `$transaction` (wrap the whole seed in `BEGIN`/`COMMIT`), nested writes (parent and children in one call), client-side IDs via `f.id()` (so child rows can reference parent IDs in the same batch without a round-trip).

What forge does *not* provide: a `seed` CLI command, a `seed/` directory convention, a "seeds applied" ledger like `_forge_migrations`, a way to mark a seed as "already run". Re-running a seed is a property of the seed itself, not of the runner. Build it on `upsert` and it can run a thousand times to the same database. Build it on `create` and it's a single-shot data import. Both are valid; this page assumes the first.

---

## The canonical seed script

The shape, top to bottom:

```ts
// scripts/seed.ts
import { db } from '../src/db';

async function main() {
  await db.$transaction(async (tx) => {
    // 1. bootstrap — always-on data (the admin user, the default org, …)
    await tx.org.upsert({
      where:  { slug: 'root' },
      create: { slug: 'root', name: 'Root Org' },
      update: { name: 'Root Org' },
    });

    await tx.user.upsert({
      where:  { email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com' },
      create: {
        email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com',
        name:  'Admin',
        role:  'owner',
        org:   { connect: { slug: 'root' } },
      },
      update: { role: 'owner' },
    });
  });

  console.log('seed: ok');
  await db.$disconnect();
}

main().catch((e) => {
  console.error('seed: failed', e);
  process.exitCode = 1;
  void db.$disconnect();
});
```

Six things to note.

**`db` is the same `db` your app uses.** Imported from the same module — same adapter, same pool, same event listeners. If your app registers `db.$on('query', auditLogger)`, the seed runs through it too. Useful for double-checking seeded writes appear in the audit trail; awkward if you'd rather they didn't. `db.$off('query', auditLogger)` around the seed body mutes it.

**The whole seed is one `$transaction`.** Either the database ends up in the seeded state or it doesn't — partial seeds leave the next run reading rows that don't match what the next idempotent step expects. The exception is large seeds where one tx is impractical; see [Large seeds](#large-seeds--createmany-and-the-array-form).

**Every write is an `upsert`.** Not `create`. See [Idempotency](#idempotency--never-use-create).

**The admin email comes from `process.env`.** Hard-coding the bootstrap admin's email into a script that ships across environments is how you end up with `admin@example.com` owning a production org. Read `SEED_ADMIN_EMAIL`, fail closed when it's missing.

**The script `$disconnect()`s on exit.** A seed that leaves the pool open hangs `npm run seed` for the connection-idle-timeout. The `catch` branch disconnects too — leaked connections are still leaked when the seed fails.

**Exit code, not throw.** A seed run from CI needs `process.exitCode = 1` to signal failure; throwing out of `main()` produces an unhandled-rejection log, exits 1 *eventually*, and is harder to grep.

### File layout

```
scripts/
  seed.ts              # entry point — parses arg, dispatches
  seed/
    bootstrap.ts       # always-on data
    dev.ts             # devbox-only fixtures
    demo.ts            # demo data for sales/marketing
    reset.ts           # drop-and-rebuild for non-prod
    util.ts            # `withFakeData`, `chunk`, `seeded()` helpers
```

`scripts/seed.ts` stays flat-importing the sub-modules — no plugin loader, no glob discovery. New seed file → new `import` in `seed.ts`. The dependency graph stays in the file you can read.

---

## Idempotency — never use `create`

The rule, in one line: **a seed step that uses `create` is a bug waiting to surface on the second run.**

`create` inserts. It throws on unique-constraint violation. The second run of a `create`-based seed hits the constraint and fails — or worse, succeeds, because the unique constraint you assumed was there isn't, and now you have a duplicate row.

`upsert` is the right verb. Three blocks:

```ts
await tx.user.upsert({
  where:  { email: 'admin@x.co' },     // unique selector
  create: { email: 'admin@x.co', name: 'Admin', role: 'owner' },
  update: { role: 'owner' },           // re-run convergence
});
```

* `where` — must be a unique selector. The eq-leaves become the conflict target. On Postgres / SQLite / DuckDB it's `ON CONFLICT (...)`; on MySQL it's `ON DUPLICATE KEY UPDATE`; on MSSQL it's `MERGE ... ON`; on Mongo it's `upsert: true` on `updateOne`. See [MUTATIONS.md](./MUTATIONS.md#upsert) for the full compile table.
* `create` — the row to insert when no match. Should include every required field.
* `update` — the fields to overwrite when a match exists. This is the convergence step: re-running the seed makes the row match the seed's view of the world, not the database's.

### What `update: {}` means

The "no-op upsert" — `update: {}` — is the idiom for "insert this row if missing, leave it alone if present":

```ts
await tx.country.upsert({
  where:  { iso2: 'GB' },
  create: { iso2: 'GB', name: 'United Kingdom' },
  update: {},
});
```

Use this for reference data: countries, currencies, plans, feature flags. Once the row is in the database, re-runs don't touch it. Lets a downstream operator edit the name in the admin UI and have the seed not stomp it back the next day.

### What `update: {...}` means

The "convergence upsert" — `update: { name: 'United Kingdom' }` — is "make sure the row matches my view, overwriting whatever's there." Use this when:

* The seed is the source of truth and any manual edit should be reverted on the next run.
* You changed a field's value in the seed file and want the next run to fix existing rows.
* You're fixing a typo in production data via a seed re-run.

The convergence form is more honest about what a seed is — declared state, applied repeatedly. The no-op form is what you reach for when the field's value is "set once, edit-by-hand later."

### Composite unique keys

The `where` block accepts the composite-unique shape forge generates for `uniques: [['col_a', 'col_b']]`:

```ts
const ProviderEvent = model('provider_events', {
  id:       f.id(),
  provider: f.string(),
  event_id: f.string(),
  payload:  f.json(),
}, {
  uniques: [['provider', 'event_id']],
});

await tx.providerEvent.upsert({
  where:  { provider_event_id: { provider: 'stripe', event_id: 'evt_123' } },
  create: { provider: 'stripe', event_id: 'evt_123', payload: {...} },
  update: {},
});
```

The key name (`provider_event_id`) is the underscore-joined column names — forge generates it. Your IDE knows it.

### The "deleteMany then createMany" anti-pattern

A shortcut that looks idempotent but isn't:

```ts
// DON'T do this.
await tx.country.deleteMany({});
await tx.country.createMany({ data: COUNTRIES });
```

Three problems. Cascades fire — any row with a foreign key to the deleted countries either gets cascade-deleted (data loss) or blocks the delete (restrict). IDs change — even if you specify the IDs in `COUNTRIES`, the delete + insert breaks every external reference (cached queries, log lines, support tickets). It's not race-safe — a concurrent request between the delete and the create sees zero countries.

`upsert` is one statement per row, idempotent and race-safe; the per-row overhead is fine because reference-data seeds are by definition small.

---

## Bootstrap vs dev vs demo

A grown codebase has three flavours of seed data and they want to be separately invokable:

* **Bootstrap** — always-on. The admin user, the default org, currencies, plans, feature flags. Runs in every environment including production. Must be idempotent. Small (<1,000 rows).
* **Dev** — devbox-only. Fixtures for local development: 50 fake users, a hundred orders, a couple of orgs with their own users. Should never run against production. Idempotent so re-running the script doesn't multiply rows by N.
* **Demo** — for sales / marketing / customer trials. A polished dataset: realistic-looking names, a curated set of orders, products with hero images. Lives in a staging or trial environment. Idempotent.

Two patterns that work — pick one and stick with it.

**Separate entry points.** A single dispatch entry that argv-switches:

```ts
// scripts/seed.ts
async function main() {
  const target = process.argv[2] ?? 'bootstrap';
  switch (target) {
    case 'bootstrap': await bootstrap(); break;
    case 'dev':       await bootstrap(); await dev();  break;
    case 'demo':      await bootstrap(); await demo(); break;
    default: throw new Error(`unknown seed target: ${target}`);
  }
}
```

`package.json` maps each `npm run` script to the dispatch — `"seed": "tsx scripts/seed.ts bootstrap"`, `"seed:dev": "tsx scripts/seed.ts dev"`, etc. CI deploy runs `npm run seed` against production; devbox first-run runs `npm run seed:dev`; demo cron runs `npm run seed:demo`. No `NODE_ENV` branching inside the seed files.

**Env-flag fan-out.** One entry point, environment-driven:

```ts
async function main() {
  await db.$transaction(async (tx) => {
    await bootstrap(tx);
    if (process.env.SEED_INCLUDE_DEV  === 'true') await dev(tx);
    if (process.env.SEED_INCLUDE_DEMO === 'true') await demo(tx);
  });
}
```

Reach for this when the seed is invoked from app startup (the "self-seeding service" pattern) rather than a separate CLI step.

### Production safety rail

Whichever pattern you pick, **dev** and **demo** must refuse to run against production:

```ts
export async function dev() {
  if (process.env.NODE_ENV === 'production') throw new Error('no');
  if (/\.prod\.|prod-/.test(process.env.DATABASE_URL ?? '')) throw new Error('no');
  // ...
}
```

The `NODE_ENV` check can be subverted; the URL pattern is the stronger backstop. Pair it with an `--i-know-what-im-doing` flag if a "production-mirror" environment genuinely matches the pattern.

---

## Order, relations and nested writes

The seed runs in the order you write it. The constraints come from the database: a row with a foreign key can't be inserted until the row it references exists. Two ways to satisfy that — sequential parents-first, or nested-write atomic API.

### Parents first

```ts
const org = await tx.org.upsert({
  where:  { slug: 'acme' },
  create: { slug: 'acme', name: 'Acme Co' },
  update: { name: 'Acme Co' },
});

await tx.user.upsert({
  where:  { email: 'a@acme.com' },
  create: { email: 'a@acme.com', name: 'Alice', org_id: org.id },
  update: { name: 'Alice', org_id: org.id },
});
```

The `org.id` is known to forge before the `org.upsert` call returns — `f.id()` generates it client-side. So `org.id` is available for the user's `org_id` immediately. Same pattern at any nesting depth.

### Nested writes

forge accepts a relation key in `create` / `update` that takes a small DSL — `create`, `connect`, `connectOrCreate`, `upsert`. See [MUTATIONS.md](./MUTATIONS.md#nested-writes) for the full table. For seeding, the two useful shapes:

**Connect — when the parent already exists:**

```ts
await tx.user.upsert({
  where:  { email: 'a@acme.com' },
  create: {
    email: 'a@acme.com',
    name:  'Alice',
    org:   { connect: { slug: 'acme' } },
  },
  update: { name: 'Alice' },
});
```

The `org: { connect: { slug: 'acme' } }` resolves the foreign key by looking up the org by its unique `slug` and writing the resulting `org_id`. One round trip on Mongo (which has no FK), two statements wrapped in a transaction on the SQL adapters.

**ConnectOrCreate — when the parent might or might not exist:**

```ts
await tx.user.upsert({
  where: { email: 'a@acme.com' },
  create: {
    email: 'a@acme.com',
    name:  'Alice',
    org: {
      connectOrCreate: {
        where:  { slug: 'acme' },
        create: { slug: 'acme', name: 'Acme Co' },
      },
    },
  },
  update: { name: 'Alice' },
});
```

This is the seed-shaped tool: each user lists its parent inline, and the seed converges regardless of insertion order. The cost is one extra statement per `connectOrCreate` call (the parent lookup) — fine for hundreds of rows, expensive for tens of thousands. For bulk seeds, batch the parents first and use `connect`.

### One-to-many

```ts
await tx.org.upsert({
  where: { slug: 'acme' },
  create: {
    slug: 'acme',
    name: 'Acme Co',
    users: {
      create: [
        { email: 'a@acme.com', name: 'Alice' },
        { email: 'b@acme.com', name: 'Bea'   },
      ],
    },
  },
  update: { name: 'Acme Co' },
});
```

The nested `users.create` array fires after the parent on SQL — same transaction, all-or-nothing. The catch: this is a `create`, not an `upsert`. On the second run, the constraint violation on `email` rolls back the whole transaction.

For idempotent nested children, use `connectOrCreate` per child or split the call:

```ts
const org = await tx.org.upsert({
  where:  { slug: 'acme' },
  create: { slug: 'acme', name: 'Acme Co' },
  update: { name: 'Acme Co' },
});

for (const u of [{ email: 'a@acme.com', name: 'Alice' }, { email: 'b@acme.com', name: 'Bea' }]) {
  await tx.user.upsert({
    where:  { email: u.email },
    create: { ...u, org_id: org.id },
    update: { name: u.name },
  });
}
```

Slightly more verbose, idempotent at every level.

### Many-to-many

Join tables are the same shape — `connect` or `connectOrCreate` on both sides, with the join row implicit:

```ts
await tx.post.upsert({
  where: { slug: 'hello-world' },
  create: {
    slug:  'hello-world',
    title: 'Hello World',
    tags: {
      connectOrCreate: [
        { where: { name: 'release' }, create: { name: 'release' } },
        { where: { name: 'v2' },      create: { name: 'v2' } },
      ],
    },
  },
  update: { title: 'Hello World' },
});
```

The `tags` relation type — declared on `Post` with `rel.many('tag', { joinTable: 'post_tags' })` or the inverse — drives the join-table write. Re-runs are idempotent because both ends use `connectOrCreate`.

For Mongo many-to-many implemented as an array of IDs on one side, the same DSL works — forge writes the IDs into the array instead of a join row. The atomicity story is single-document on Mongo (the array update is atomic on the parent doc) so this happens to be more robust on Mongo than on SQL.

---

## Embedded and JSON fields

`f.embed` and `f.json` round-trip through the seed unchanged. The value you pass is the value forge writes — validated by the embed's field shape on `f.embed`, untouched on `f.json`.

```ts
const User = model('users', {
  id:      f.id(),
  email:   f.string().unique(),
  address: f.embed(AddressEmbed).optional(),     // single embed
  history: f.embedMany(AddressEmbed),            // array of embeds
  prefs:   f.json(),                              // free-form JSON
});

await tx.user.upsert({
  where:  { email: 'a@acme.com' },
  create: {
    email:   'a@acme.com',
    address: { street: '1 High St', city: 'London', zip: 'W1 1AA' },
    history: [
      { street: '1 High St', city: 'London', zip: 'W1 1AA' },
      { street: '2 Low Rd',  city: 'York',   zip: 'YO1 1AA' },
    ],
    prefs:   { theme: 'dark', notifications: { email: true } },
  },
  update: {
    address: { street: '1 High St', city: 'London', zip: 'W1 1AA' },
  },
});
```

The embed's field shape validates on write — a typo like `{ stret: '1 High St' }` is a TypeScript error. Per-dialect storage (jsonb / JSON / TEXT / sub-document) is handled by the adapter; see [EMBED.md](./EMBED.md#embed-declaration-and-per-dialect-storage).

Re-running the seed with a new `prefs` value overwrites the whole JSON blob — it's a column, not a merge. For field-level merge, do it in app code before the upsert.

---

## Geo, vector, FTS

The three "annotated column" features round-trip through the seed the same way regular columns do — pass the right shape and forge writes the right SQL.

### Geo

```ts
const Venue = model('venues', {
  id:   f.id(),
  name: f.string().unique(),
  loc:  f.geoPoint(),
});

await tx.venue.upsert({
  where:  { name: 'BFI Southbank' },
  create: { name: 'BFI Southbank', loc: { lng: -0.1146, lat: 51.5074 } },
  update: { loc: { lng: -0.1146, lat: 51.5074 } },
});
```

The `loc` value is `{ lng, lat }` — the JS shape. forge serialises to `geography(Point, 4326)` on Postgres, `POINT … SRID 4326` on MySQL, GeoJSON on Mongo, `GEOGRAPHY` on MSSQL, etc. The seed doesn't know the dialect; the value is the same.

For 3D points, declare `f.geoPoint({ dims: 3 })` and pass `{ lng, lat, alt }`. For polygons, the value is a `[lng, lat][]` ring; see [GEO.md](./GEO.md) for the full shape.

### Vector

```ts
const Doc = model('docs', {
  id:    f.id(),
  title: f.string().unique(),
  embed: f.vector(1536, { metric: 'cosine' }),
});

await tx.doc.upsert({
  where:  { title: 'Hello' },
  create: { title: 'Hello', embed: await embedText('Hello world') },
  update: { embed: await embedText('Hello world') },
});
```

The vector value is `number[]` of the declared length. forge writes pgvector / DuckDB vss / MSSQL `VECTOR(N)` / Mongo Atlas vector / SQLite sqlite-vec depending on the adapter — see [VECTOR.md](./VECTOR.md).

The slow part of a vector seed is the embedding model, not the database. Three patterns to keep the seed under a minute: cache embeddings to disk keyed on a SHA-256 of the input text (CI persists `.seed-cache/`); batch the embedding API (OpenAI / Voyage / Cohere accept arrays of up to 2,048 inputs per call); or swap to a smaller dev embedder (local Sentence-Transformers, 384-dim) based on `NODE_ENV`. The full pattern is in the [RAG dataset](#c-rag-dataset--chunked-docs--vectors) worked example.

### FTS

`.searchable()` columns are seeded as plain strings — the index update happens at the adapter level (Postgres GIN tsvector, MySQL FULLTEXT, SQLite FTS5 via the trigger forge generates on `forge push`). No special seed handling.

A large initial seed of FTS-indexed rows is slow because the index updates per row. The fix is to drop the index, bulk-insert, and re-create: `$executeRaw`DROP TRIGGER posts_ai` …` etc., then `bulkInsert()`, then `db.$migrate()` to rebuild the FTS shadow + triggers. See [FTS.md](./FTS.md) for the per-dialect commands.

---

## Large seeds — `createMany` and the array form

The three shapes for bulk writes, ranked by throughput, are documented in [MUTATIONS.md — batched throughput](./MUTATIONS.md#batched-throughput). For seeds the picking order is:

1. **`createMany`** — one statement, one round-trip. Best.
2. **`$transaction(async tx => for chunk { tx.x.createMany(chunk) })`** — chunks inside a single commit.
3. **`$transaction([...])`** — N promises, one logical group, no transaction wrap. Use for fan-out reads, not idempotent writes.

The shape for a million-row seed:

```ts
import { CHUNK } from './util';      // 1_000 — matches MUTATIONS.md guidance

async function bulkSeedEvents(rows: EventInput[]) {
  await db.$transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      await tx.event.createMany({
        data:           slice,
        skipDuplicates: true,        // re-runs are no-ops, not failures
      });
      if (i % 50_000 === 0) console.log(`seed: ${i} / ${rows.length}`);
    }
  });
}
```

Three rules.

**`skipDuplicates: true` is what makes a `createMany` seed idempotent.** Re-runs hit the unique-constraint, the conflict is silently dropped, and the seed converges. Without it, the second run fails with a duplicate-key error. See [MUTATIONS.md — `skipDuplicates`](./MUTATIONS.md#createmany--skipduplicates) for the per-adapter compile.

**One big tx vs one tx per chunk.** A million rows in one `$transaction` is one COMMIT and either all-or-nothing rollback. A million rows in 1,000 separate `$transaction`s is 1,000 COMMITs, more network overhead, partial progress on failure. Pick based on whether you can resume — the first wins on speed, the second wins on operational sanity for very large imports.

**Above 5M rows, drop to the dialect's native bulk loader.** `COPY FROM` on Postgres, `LOAD DATA INFILE` on MySQL, `BULK INSERT` on MSSQL. Forge's `$executeRaw` is the bridge. See [RAW-SQL.md](./RAW-SQL.md) for the shapes.

### Memory profile and chunk size

A `createMany` with 10,000 rows holds all rows in memory plus the prepared-statement SQL — ~2 MB at 200 bytes per row, fine. At 100,000 rows the driver's parser starts to degrade. The forge guidance from [MUTATIONS.md — bulk size](./MUTATIONS.md#bulk-size):

| Dialect              | Practical max per `createMany` | Limit hit              |
|----------------------|-------------------------------|------------------------|
| Postgres             | 10,000                         | 65,535 parameters      |
| MySQL                | 1,000–5,000                    | `max_allowed_packet`   |
| SQLite               | 10,000                         | `SQLITE_MAX_VARIABLE_NUMBER` (32,766) |
| DuckDB               | 10,000                         | parameter count        |
| MSSQL                | 1,000                          | 2,100 parameter limit  |
| Mongo                | unlimited                      | driver chunks at 16 MB |

A constant `CHUNK = 1000` works across every adapter for rows under ~20 columns. Drop to 200 for very wide rows.

### Streaming sources

For seeds that read from a file or API too big to hold in memory, chunk on the producer side — open a CSV / NDJSON stream, push rows into a buffer, flush at `buffer.length >= 1000` with `tx.x.createMany({ data: buffer, skipDuplicates: true })`, wrap the whole loop in `$transaction`. On a long-running tx, watch the [Long-running transactions](./TRANSACTIONS.md#long-running-transactions) warnings — VACUUM blocking on Postgres, history-list-length on InnoDB, WAL growth on SQLite.

---

## Realistic data with faker and Chance

The dev / demo seeds want names that look real and dates that fall in plausible ranges. Two libraries, same pattern:

```ts
// scripts/seed/util.ts
import { faker } from '@faker-js/faker';

faker.seed(42);   // deterministic across runs — same data every time

export function fakeUser(i: number) {
  return {
    email: `user-${i}@${faker.internet.domainName()}`,   // `${i}` guarantees uniqueness
    name:  faker.person.fullName(),
    bio:   faker.lorem.sentence(),
  };
}
```

Two things to know.

**Determinism via `faker.seed(N)`.** Without it, every run produces different data, and the dev environment is non-reproducible. With it, every run produces the same fifty users — convergent under the seed's idempotency rule, debuggable when something breaks. Pick `42` and commit it.

**`faker.internet.email()` is not unique across calls.** The email generator's namespace is small enough that you'll hit a collision in a few thousand calls. The `${i}` prefix above sidesteps it.

For distributions ("20% are admins, 80% are members"), reach for Chance — `chance.weighted(['admin', 'member'], [20, 80])`. Combine the two: faker for the field values, Chance for the distribution shape. For non-faker randomness (picking from a curated image list, jittering geo points around a city centre), `seedrandom('42')` gives you a deterministic `Math.random()` you can use anywhere.

---

## Images, blobs, content-addressable keys

A dev/demo seed that uses real-looking images needs a strategy for the binary data — you don't want a 50 MB seed file checked into Git, and you don't want the seed running an HTTP fetch per image on every run.

The pattern:

```ts
import { createHash } from 'node:crypto';
import { rgbaToThumbHash } from 'thumbhash';
import sharp from 'sharp';

const Image = model('images', {
  id:         f.id(),
  key:        f.string().unique(),   // sha256 of the bytes — content-addressable
  thumbhash:  f.string(),            // 25-byte blurry preview, decoded client-side
  width:      f.int(),
  height:     f.int(),
  mime:       f.string(),
});

async function buildImageRow(buf: Buffer) {
  const key = createHash('sha256').update(buf).digest('hex').slice(0, 32);
  if (!(await s3.head({ key }))) {
    await s3.put({ key, body: buf, contentType: 'image/jpeg' });
  }
  const meta = await sharp(buf).metadata();
  const { data, info } = await sharp(buf)
    .resize(100, 100, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  return {
    key,
    thumbhash: Buffer.from(rgbaToThumbHash(info.width, info.height, data)).toString('base64'),
    width:     meta.width!,
    height:    meta.height!,
    mime:      'image/jpeg',
  };
}

// In the seed:
const row = await buildImageRow(buf);
await tx.image.upsert({
  where:  { key: row.key },
  create: row,
  update: {},
});
```

The pipeline is end-to-end idempotent — the S3 `head` check dedupes the upload, the unique `key` dedupes the row, and the `upsert` converges. Two seeds uploading the same image bytes converge on the same row. Run it against a clean database and it re-uploads; against the same database and it's a no-op.

Three places the bytes can live: an external URL (point at Unsplash IDs, fetch on first run, cache locally), a checked-in `scripts/seed/fixtures/images/` directory (fine under ~10 MB), or Git LFS for curated demo hero images. Avoid checking large binaries into regular Git history — they bloat clones forever.

---

## CLI integration — `npm run seed`

The `package.json` `scripts` block is the contract:

```json
{
  "scripts": {
    "seed":         "tsx scripts/seed.ts bootstrap",
    "seed:dev":     "tsx scripts/seed.ts dev",
    "seed:demo":    "tsx scripts/seed.ts demo",
    "seed:reset":   "tsx scripts/seed.ts reset",
    "seed:from-csv": "tsx scripts/seed.ts from-csv"
  }
}
```

Each script is a single-argument dispatch into the same entrypoint. The advantages:

* **Shell-completable.** `npm run seed:` + tab gives every variant.
* **CI-friendly.** `npm run seed` is the production-safe call; everything else is namespaced.
* **Single import graph.** `scripts/seed.ts` imports each sub-module — TypeScript checks them all on every build.

If the seed has its own watch / interactive mode, layer it on top with a flag:

```sh
SEED_INCLUDE_DEV=true npm run seed:dev -- --watch
```

`tsx scripts/seed.ts dev --watch` then re-runs on file changes — useful when iterating on the seed itself.

### Wiring into the lifecycle

The first-run-after-clone sequence: `npm install`, `cp .env.example .env`, fill `DATABASE_URL` + `SEED_ADMIN_EMAIL`, `npx forge push`, `npm run seed:dev`, `npm run dev`. The `seed:dev` step is what populates the empty database with fifty fake users so the dev experience starts loaded.

CI runs `npx forge push && npm run seed && npm test` — `forge push` + bootstrap establishes the same database state every run. Tests that need extra data create it per-test; see [Test-suite seeds](#test-suite-seeds).

### A self-seeding service

For containers that should converge their own database on startup, call the seed from the boot path — `await db.$migrate(); await bootstrap(); startServer();`. Same function the CLI calls; two paths, one implementation. The catch: `bootstrap()` runs on every container start, so a scaled fleet runs the same upserts repeatedly. Fine because upserts are atomic, but for larger seeds gate behind a leader-election lock (Postgres advisory locks; see [TRANSACTIONS.md](./TRANSACTIONS.md#five-worked-patterns)) or only run on the pod with `RUN_SEED=true`.

---

## Reset patterns

A seed that's been running for months has accumulated state — soft-deleted rows, test data, old fixtures. A reset wipes the slate. Three approaches, ranked from cleanest to most surgical.

**Drop and re-apply schema.** The cleanest reset:

```json
"seed:reset": "tsx scripts/seed.ts drop && npx forge push && tsx scripts/seed.ts dev"
```

The `drop` step varies per dialect — Postgres: `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` via `$executeRaw`. MySQL: `DROP DATABASE … ; CREATE DATABASE …`. SQLite/DuckDB: delete the file. MSSQL: `DROP DATABASE [name]; CREATE DATABASE [name];`. Mongo: `db.dropDatabase()` via `$runCommandRaw`. Then `forge push` re-applies the schema, then the seed re-populates.

**`TRUNCATE` via raw SQL.** Keeps the schema, wipes the data — faster than `deleteMany` on Postgres / MySQL:

```ts
const tables = await db.$queryRaw<{ table_name: string }[]>`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
`;
await db.$executeRaw`
  TRUNCATE TABLE ${db.$raw(tables.map(t => `"${t.table_name}"`).join(', '))} RESTART IDENTITY CASCADE
`;
```

`RESTART IDENTITY` resets auto-increment counters; `CASCADE` walks foreign keys. SQLite has no `TRUNCATE` — `DELETE FROM <each table>` is the substitute.

**`deleteMany({})` per model.** The slowest path, but the only one that fires the same listeners as regular deletes (useful when you want audit-log rows for the reset). On Mongo it's the only option — there's no `TRUNCATE` equivalent. Order matters: children before parents, by hand, because forge has no topological sort built in.

| Scenario                           | Pick                                                       |
|------------------------------------|------------------------------------------------------------|
| Devbox "I broke my seed, reset"    | Drop + `forge push` + re-seed                              |
| Reset between integration tests    | `$transaction` + rollback (see [TRANSACTIONS.md](./TRANSACTIONS.md#testing-patterns)) |
| Demo-cluster nightly reset         | `TRUNCATE` + re-seed                                       |
| Production (never)                 | Don't — production seeds are append-only via `upsert`      |

---

## Test-suite seeds

Seeds and tests pair as:

* **Shared snapshot** — the bootstrap seed runs once in a suite-level `beforeAll` against a fresh test database; never modified by tests.
* **Per-test fixture** — each test creates the rows it needs against a `tx` that gets rolled back in `afterEach`.

```ts
import { afterEach, beforeAll, beforeEach } from 'vitest';
import { bootstrap } from '../scripts/seed/bootstrap';

beforeAll(async () => {
  await db.$migrate();
  await bootstrap();
});

let tx: ForgeDb<typeof schema>;
let rollback: () => void;

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    db.$transaction(async (txObj) => {
      tx = txObj;
      resolve();
      await new Promise<void>((_, reject) => {
        rollback = () => reject(new Error('test rollback'));
      });
    }).catch(() => {});
  });
});

afterEach(() => rollback());
```

Tests take `tx`. Bootstrap data persists across the whole suite (the `beforeAll` committed); per-test writes are rolled back. See [TRANSACTIONS.md — testing patterns](./TRANSACTIONS.md#testing-patterns) for the caveats — deferred constraints don't fire, Mongo's `withTransaction` retry can re-fire test bodies, triggers that read committed state see nothing. Run those tests in a parallel suite that doesn't use the rollback pattern. When FIXTURES.md lands, it'll cover the per-test factory pattern (`makeUser({ role: 'admin' })`) that builds on the seed's data without re-seeding.

---

## Three worked examples

### (a) 100-user seed with relations

A devbox seed that populates 100 users across 5 orgs, with each user having 3-10 posts.

```ts
// scripts/seed/dev.ts
import { faker } from '@faker-js/faker';
import { db } from '../../src/db';

faker.seed(42);

const ORG_COUNT = 5;
const USERS_PER_ORG = 20;

export async function dev() {
  if (process.env.NODE_ENV === 'production') throw new Error('no');

  await db.$transaction(async (tx) => {
    // Orgs first — IDs are generated client-side, available immediately.
    const orgs = [];
    for (let i = 0; i < ORG_COUNT; i++) {
      const slug = `org-${i}`;
      const org = await tx.org.upsert({
        where:  { slug },
        create: { slug, name: faker.company.name() },
        update: {},
      });
      orgs.push(org);
    }

    // Users — connect to org by slug, idempotent on email.
    for (let i = 0; i < ORG_COUNT * USERS_PER_ORG; i++) {
      const org = orgs[i % ORG_COUNT];
      const email = `user-${i}@${org.slug}.test`;
      const user = await tx.user.upsert({
        where:  { email },
        create: {
          email,
          name: faker.person.fullName(),
          org_id: org.id,
        },
        update: { name: faker.person.fullName() },
      });

      // 3-10 posts per user, idempotent on (author_id, slug).
      const postCount = 3 + (i % 8);
      for (let p = 0; p < postCount; p++) {
        const slug = `post-${i}-${p}`;
        await tx.post.upsert({
          where:  { author_slug: { author_id: user.id, slug } },
          create: {
            author_id: user.id,
            slug,
            title:     faker.lorem.sentence(),
            body:      faker.lorem.paragraphs(2),
          },
          update: {
            title: faker.lorem.sentence(),
            body:  faker.lorem.paragraphs(2),
          },
        });
      }
    }
  });

  console.log(`seed:dev — ${ORG_COUNT} orgs, ${ORG_COUNT * USERS_PER_ORG} users, posts populated`);
}
```

The seed runs from `for` loops, not `Promise.all` — sequencing matters because later rows reference earlier IDs, and the transaction wraps the whole thing so a constraint failure mid-loop rolls back every prior row. Every level is `upsert`. The post's `where` uses a composite unique `author_slug` declared as `uniques: [['author_id', 'slug']]`. `faker.seed(42)` makes the run deterministic — two devs see the same `org-0` company name.

### (b) Demo store with products + media + orders

A demo seed that populates a complete e-commerce dataset: 50 products with hero images, 10 customers, 30 orders linking them.

```ts
// scripts/seed/demo.ts
import { faker } from '@faker-js/faker';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { db } from '../../src/db';
import { uploadIfMissing, buildImageRow } from './util-media';

faker.seed(43);

const PRODUCT_COUNT = 50;
const CUSTOMER_COUNT = 10;
const ORDER_COUNT = 30;

export async function demo() {
  if (process.env.NODE_ENV === 'production') throw new Error('no');

  // 1. Images — content-addressable, uploaded ahead of the tx.
  // (Tx-wrapping the upload would hold the connection for the network call;
  // see TRANSACTIONS.md "long-running transactions".)
  const fixtureImages = await Promise.all(
    Array.from({ length: 10 }, async (_, i) => {
      const buf = await readFile(`scripts/seed/fixtures/products/${i}.jpg`);
      return buildImageRow(buf);
    }),
  );

  await db.$transaction(async (tx) => {
    // 2. Image rows.
    const imageRows = await Promise.all(
      fixtureImages.map((row) =>
        tx.image.upsert({
          where:  { key: row.key },
          create: row,
          update: {},
        }),
      ),
    );

    // 3. Products — each gets a deterministic hero image.
    for (let i = 0; i < PRODUCT_COUNT; i++) {
      const sku = `demo-sku-${i.toString().padStart(4, '0')}`;
      await tx.product.upsert({
        where:  { sku },
        create: {
          sku,
          name:    faker.commerce.productName(),
          price:   faker.commerce.price({ min: 5, max: 200 }),
          image_id: imageRows[i % imageRows.length].id,
          tags: {
            connectOrCreate: faker.helpers.arrayElements(['new', 'sale', 'staff-pick'], 2)
              .map((name) => ({ where: { name }, create: { name } })),
          },
        },
        update: {
          name:  faker.commerce.productName(),
          price: faker.commerce.price({ min: 5, max: 200 }),
        },
      });
    }

    // 4. Customers.
    const customers = await Promise.all(
      Array.from({ length: CUSTOMER_COUNT }, (_, i) => {
        const email = `customer-${i}@demo.test`;
        return tx.customer.upsert({
          where:  { email },
          create: { email, name: faker.person.fullName() },
          update: { name: faker.person.fullName() },
        });
      }),
    );

    // 5. Orders — each references a customer + 1-5 products.
    for (let o = 0; o < ORDER_COUNT; o++) {
      const orderNo = `demo-ord-${o.toString().padStart(4, '0')}`;
      const customer = customers[o % customers.length];
      const lineCount = 1 + (o % 5);

      const lines = Array.from({ length: lineCount }, (_, l) => ({
        sku:      `demo-sku-${((o + l) % PRODUCT_COUNT).toString().padStart(4, '0')}`,
        quantity: 1 + (l % 3),
      }));

      await tx.order.upsert({
        where:  { order_no: orderNo },
        create: {
          order_no:     orderNo,
          customer_id:  customer.id,
          status:       'fulfilled',
          placed_at:    faker.date.past({ years: 1 }),
          lines:        lines,            // f.embedMany — denormalised onto the order
        },
        update: {
          status:    'fulfilled',
          lines,
        },
      });
    }
  });

  console.log(`seed:demo — ${PRODUCT_COUNT} products, ${CUSTOMER_COUNT} customers, ${ORDER_COUNT} orders`);
}
```

Four shape notes. Image uploads happen *before* the tx opens — the S3 round-trip is slow and shouldn't hold a connection, so `buildImageRow` fans out across the fixtures outside the tx and only the database writes are wrapped. Products `connectOrCreate` their tags — the first run creates the `new` / `sale` / `staff-pick` rows; subsequent runs find them. Order lines are an `f.embedMany('Line', { sku, quantity })` denormalised onto the order itself, not an `OrderLine` table — see [EMBED.md](./EMBED.md) for when embed-vs-relation is the right call. `faker.date.past({ years: 1 })` spreads orders across the last year, deterministically.

### (c) RAG dataset — chunked docs + vectors

A seed that loads a markdown corpus, chunks it, computes embeddings, and writes vector rows.

```ts
// scripts/seed/rag.ts
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { db } from '../../src/db';

const CACHE_DIR = '.seed-cache/embeddings';

async function cachedEmbed(text: string): Promise<number[]> {
  const hash = createHash('sha256').update(text).digest('hex');
  const file = path.join(CACHE_DIR, `${hash}.json`);
  if (existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));

  const vec = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  }).then((r) => r.data[0].embedding);

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(vec));
  return vec;
}

function chunk(text: string, size = 1000, overlap = 100): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size - overlap) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

export async function seedRag() {
  const files = await readdir('docs/');
  const allChunks: { doc: string; idx: number; body: string }[] = [];

  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const body = await readFile(`docs/${f}`, 'utf8');
    for (const [i, c] of chunk(body).entries()) {
      allChunks.push({ doc: f, idx: i, body: c });
    }
  }

  // Compute embeddings outside the tx — slow, cacheable, parallel-safe.
  const withVectors = await Promise.all(
    allChunks.map(async (c) => ({ ...c, embedding: await cachedEmbed(c.body) })),
  );

  // Write in chunks of 100. Each chunk is one INSERT; the tx wraps everything.
  await db.$transaction(async (tx) => {
    const CHUNK = 100;
    for (let i = 0; i < withVectors.length; i += CHUNK) {
      const slice = withVectors.slice(i, i + CHUNK);
      await tx.docChunk.createMany({
        data: slice.map((c) => ({
          doc_id:    c.doc,
          chunk_idx: c.idx,
          body:      c.body,
          embedding: c.embedding,
        })),
        skipDuplicates: true,    // unique on (doc_id, chunk_idx)
      });
    }
  });

  console.log(`seed:rag — ${withVectors.length} chunks across ${files.length} docs`);
}
```

Four shape notes. Embeddings are cached to `.seed-cache/` (SHA-256 of chunk content as the filename) — first run hits the API per chunk, subsequent runs read from disk; the cache directory is `.gitignore`d and CI can persist it. Embeddings compute outside the tx with `Promise.all` because they're network-bound and independent. `createMany` chunks at 100 because vector columns are wide (1,536 floats per row ≈ 6 KB at jsonb encoding) and bigger chunks risk hitting the parameter limit. Idempotency rides on `uniques: [['doc_id', 'chunk_idx']]` plus `skipDuplicates: true` — re-running after editing one doc only writes chunks whose hash changed.

The query side — `findMany({ orderBy: { embedding: { nearTo: queryVector } }, take: 5 })` — is in [VECTOR.md](./VECTOR.md).

---

## Cross-references

* **[MUTATIONS.md](./MUTATIONS.md)** — the `upsert` and `createMany` deep-dives every seed pattern rides on.
* **[TRANSACTIONS.md](./TRANSACTIONS.md)** — `$transaction` mechanics, long-running-tx warnings, the tx-rollback testing pattern.
* **[MIGRATIONS.md](./MIGRATIONS.md)** — `forge push`, the schema apply step that runs before the seed.
* **[EMBED.md](./EMBED.md)** — `f.embed` / `f.embedMany` shape; the order-line denormalisation in the demo example.
* **[RAW-SQL.md](./RAW-SQL.md)** — `$executeRaw` for `TRUNCATE`, `DROP SCHEMA`, dialect-native bulk loaders.
* **[GEO.md](./GEO.md) / [VECTOR.md](./VECTOR.md) / [FTS.md](./FTS.md)** — value shapes for the annotated-column features the seed writes.

When they ship: **FIXTURES.md** (per-test factory pattern), **TESTING.md** (seed-vs-fixture decision matrix), **DEPLOYMENT.md** (where `npm run seed` slots into the deploy pipeline).
