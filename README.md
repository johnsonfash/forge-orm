# Forge — Prisma-shape multi-database wrapper

A self-contained TypeScript data-access layer that mirrors Prisma's API and
runs against **MongoDB, PostgreSQL, MySQL, and SQLite** from the **same
code** — no codegen, no Rust query engine, no external CLI. Designed to be
read end-to-end in an afternoon and dropped into any Node project.

> **v1.0** — feature-complete through Wave 5: drift detection (`forge:diff`),
> schema-diff migrations, materialised views, native types
> (`decimal`/`uuid`/`bigint`/`dbgenerated`), `strict` mode, and a forge-vs-
> Prisma-vs-Drizzle comparison bench. **352 tests** green across all four
> dialects. See [Wave 5 — production hardening](#wave-5--production-hardening).

```ts
const db = await createDb({ url: process.env.DATABASE_URL! });

const user = await db.user.create({
  data: { email: 'alice@x.co', name: 'Alice', role: 'EDITOR' },
});

const posts = await db.post.findMany({
  where: { author_id: user.id, status: 'PUBLISHED' },
  include: { comments: true },
  orderBy: { created_at: 'desc' },
  take: 20,
});
```

That exact code works whether `DATABASE_URL` points at `mongodb://…` or
`postgres://…`. Forge picks the right adapter at connect time.

---

## Table of contents

1. [Why forge](#why-forge)
2. [Install](#install)
3. [Quick start](#quick-start)
4. [Schema](#schema)
5. [Adapters & connection strings](#adapters--connection-strings)
6. [Reading data](#reading-data)
7. [Writing data](#writing-data)
8. [Atomic updates](#atomic-updates)
9. [Relations & nested writes](#relations--nested-writes)
10. [`groupBy` and aggregations](#groupby-and-aggregations)
11. [Transactions](#transactions)
12. [Raw SQL escape hatch](#raw-sql-escape-hatch)
13. [Errors](#errors)
14. [Schema sync — `forge:push`](#schema-sync--forgepush)
15. [`forge:doctor`](#forgedoctor)
16. [The `.compile` escape hatch](#the-compile-escape-hatch)
17. [Type safety in detail](#type-safety-in-detail)
18. [Architecture](#architecture)
19. [Running tests](#running-tests)
20. [Comparison with Prisma](#comparison-with-prisma)
21. [Known gaps & roadmap](#known-gaps--roadmap)
22. [Extending forge — writing a new adapter](#extending-forge--writing-a-new-adapter)

---

## Why forge

Reach for forge when you want:

- **One codebase, multiple databases.** A service that ships against Mongo
  today but might run against Postgres tomorrow doesn't have to rewrite its
  query layer. The IR (intermediate representation) is dialect-portable.
- **No codegen step.** The schema is one TypeScript file. Add a model, save
  the file, autocomplete updates. No `prisma generate`, no out-of-sync
  generated client.
- **A library you can read.** ~5,000 lines of pure TypeScript across the
  whole package. `grep` finds field references in one pass. No Rust engine,
  no protocol buffers, no separate binary.
- **Real autocomplete.** Verified programmatically against the TypeScript
  Language Service — see [type safety](#type-safety-in-detail). Atomic ops
  on optional numeric fields, `select`-narrowed return types, enum literal
  unions all work.
- **An escape hatch when you outgrow the wrapper.** `.compile.findMany(...)`
  hands you the exact MongoDB args object or parameterised SQL string +
  params, ready to run through your own driver.

Stay with Prisma if you need: Prisma Studio, the migration history /
shadow-DB drift detection, `$extends` middleware, full feature parity across
6+ dialects, or the ecosystem of Prisma adapters.

The honest pitch: forge is a *thin* wrapper. In a same-machine micro-benchmark
its per-call overhead measured competitive with — and often lower than — Prisma
7.8 and Drizzle (see [the comparison bench](#comparison-bench--forge-vs-prisma-vs-drizzle)),
and there's no Rust engine to spawn. So you don't pay a performance tax for the
one-API-across-four-databases design or the readability. That's the whole claim
— it is **not** "faster"/"better" in any broad sense: it loses on breadth,
ecosystem, tooling maturity, and production track record. Choose it for thinness
and multi-DB reach, not to beat Prisma.

---

## Install

forge is a single package at the repo root. Two ways to consume it:

**(a) Fork-and-own (recommended today).** Clone the repo, edit `src/schema/` to
your domain, import from `src`. You own ~5k lines you can read and change — the
intended model, because forge's schema is a compile-time singleton (see caveat
below), so your models live *inside* the package.

**(b) As a built npm package.** `npm run build` emits `dist/` (compiled JS +
`.d.ts`); `npm pack` produces a publishable tarball (`dist/` + README + CHANGELOG
only — no tests/bench/`.env`). `main`/`types` resolve to `dist`. `npm publish`
once you've set your own package name/scope.

> **Library caveat — bring-your-own-schema is not yet decoupled.** The schema
> registry (`src/schema/index.ts`) is imported as a singleton across the
> factory and adapters, so a published build ships with *that* schema's models
> baked in (`db.user`, `db.post`, …). To use forge for your own domain today
> you replace `src/schema` and rebuild — i.e. fork-and-own. Turning the schema
> into a `createDb({ schema })` parameter (a true drop-in library) is a known
> follow-up refactor, not yet done.

Either way, install whichever drivers you'll use (**optional peer dependencies**
— installing forge pulls zero drivers):

```sh
npm install mongodb          # if you'll use Mongo
npm install pg               # if you'll use Postgres
npm install mysql2           # if you'll use MySQL
npm install better-sqlite3   # if you'll use SQLite
```

Forge's `package.json` declares these as **optional peer dependencies**, so
`npm install forge` itself pulls zero drivers. If you `createDb({ url:
'postgres://…' })` without `pg` installed, you get a clear actionable error:

```
[forge] postgres adapter needs the 'pg' driver, but it's not installed.
  Detected:    DATABASE_URL=postgres://user:****@localhost/db  (inferred adapter: postgres)
  Install:     npm install pg
  Or override: createDb({ type: 'mongo' | 'postgres' | 'mysql' | 'sqlite', url: '...' })
```

---

## Quick start

```ts
import { createDb } from '@forge';

// 1. Connect. The URL prefix picks the adapter.
const db = await createDb({ url: process.env.DATABASE_URL! });

// 2. Use it. Every call is fully typed against your schema.
const alice = await db.user.create({
  data: {
    email: 'alice@example.com',
    name: 'Alice',
    role: 'EDITOR',
    address: { street: '1 Main', city: 'sf', zip: '94110', country: 'us' },
  },
});

const posts = await db.post.findMany({
  where: { author_id: alice.id, status: 'PUBLISHED' },
  include: { comments: { where: { is_deleted: false } } },
  orderBy: { created_at: 'desc' },
  take: 20,
});

// 3. Close (idempotent).
await db.$disconnect();
```

That's it. Everything else is iteration on this shape.

---

## Schema

The shipped sample is a blog/CMS domain at `src/schema/index.ts`.
Replace it with your own models to use forge in another project. Walking
through the patterns:

### Fields

```ts
import { f, model, rel, enums, embed } from './core';

export const User = model('users', {
  id:         f.id(),                                      // primary key
  email:      f.string().unique(),                         // per-field unique
  name:       f.string(),                                  // required string
  role:       f.enumOf(['USER', 'EDITOR', 'ADMIN'] as const).default('USER'),
  age:        f.int().optional(),                          // nullable integer
  active:     f.bool().default(true),                      // default
  created_at: f.dateTime().default('now'),                 // server-side default
  updated_at: f.dateTime().default('now').updatedAt(),     // auto-bumps on write
});
```

Available field kinds:

| Builder | Notes |
|---|---|
| `f.id()` | Primary key. Auto-generated ObjectId on Mongo; app-supplied text on SQL dialects. |
| `f.objectId()` | Foreign-key style ref. |
| `f.string()` | Short string. PG/SQLite: `TEXT`. **MySQL: `VARCHAR(255)`** (indexable/uniqueable without prefix). |
| `f.text()` | Unbounded string. **MySQL: `TEXT`** (can't be `UNIQUE` without a length prefix). Same as `f.string()` on PG/SQLite/Mongo. |
| `f.int()` | 32-bit int. |
| `f.float()` | 64-bit double. |
| `f.bool()` | Boolean. SQLite/MySQL store as `0/1`; forge decodes back to JS `boolean`. |
| `f.dateTime()` | UTC timestamp. PG: `timestamptz`. MySQL: `DATETIME(3)`. SQLite: ISO string. Mongo: `Date`. |
| `f.json()` | Arbitrary JSON. PG: `jsonb`. MySQL: `JSON`. SQLite/Mongo: nested doc / serialized. |
| `f.enumOf([...] as const)` | String literal union + `CHECK` constraint on all SQL dialects. |
| `f.embed(MyEmbed)` | Single embedded composite — JSON-encoded on SQL dialects. |
| `f.embedMany(MyEmbed)` | List of embedded composites — JSON array on SQL dialects (default `'[]'`). |
| `f.stringArray()` | PG: `text[]`. MySQL/SQLite: JSON. Mongo: array. |
| `f.intArray()` | PG: `integer[]`. MySQL/SQLite: JSON. |

Modifiers (chain on any field):

```ts
f.string().optional()             // nullable
f.string().unique()               // creates a UNIQUE index
f.dateTime().default('now')       // server default
f.dateTime().default('now').updatedAt()   // auto-bumps on update
f.string().default('pending')     // literal default
```

### Indexes & composite uniques

```ts
export const Post = model('posts', {
  id:         f.id(),
  author_id:  f.objectId(),
  title:      f.string(),
  slug:       f.string().unique(),
  status:     f.enumOf(['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const),
}, {
  indexes:  [{ keys: { author_id: 1, status: 1 } }],  // multi-column
  uniques:  [['author_id', 'slug']],                  // composite unique
});
```

### Relations

```ts
export const Post = model('posts', { ... }).relate(() => ({
  author:   rel.one('user', { on: 'author_id', refs: 'id', onDelete: 'Cascade' }),
  comments: rel.many('comment', { on: 'post_id', refs: 'id' }),
  tags:     rel.many('postTag', { on: 'post_id', refs: 'id' }),
}));
```

- `rel.one` → owning side (this model holds the FK column)
- `rel.many` → inverse side (the other model holds the FK)
- `on` → field on the owning side that holds the FK
- `refs` → field on the target being referenced (almost always `id`)
- `onDelete: 'Cascade' | 'SetNull' | 'NoAction' | 'Restrict'`
  - PG: emitted as `ON DELETE CASCADE` etc. on the FK constraint
  - Mongo: emulated by a JS cascade walker on delete

### Self-referential

```ts
export const Comment = model('comments', {
  id:        f.id(),
  parent_id: f.objectId().optional(),
}).relate(() => ({
  parent:  rel.one('comment', { on: 'parent_id', refs: 'id' }),
  replies: rel.many('comment', { on: 'parent_id', refs: 'id' }),
}));
```

### Embeds

```ts
export const AddressEmbed = () => embed('Address', {
  street: f.string(), city: f.string(), zip: f.string(), country: f.string(),
});

export const User = model('users', {
  id:      f.id(),
  address: f.embed(AddressEmbed).optional(),  // nested doc on Mongo, jsonb on PG
});
```

### Register the schema

```ts
export const schema = {
  user: User,
  post: Post,
  comment: Comment,
  // …
} as const;
```

The map key (`user`, `post`) is what you'll type at the call site
(`db.user.findMany(...)`). The string is also what `rel.one('user', …)`
references — type-checked at compile time via the `_assertAllTargetsValid`
line at the bottom of `schema/index.ts`.

---

## Adapters & connection strings

Adapter selection from URL prefix:

| Prefix | Adapter |
|---|---|
| `mongodb://`, `mongodb+srv://` | mongo |
| `postgres://`, `postgresql://` | postgres |
| `mysql://`, `mariadb://` | mysql |
| `sqlite:`, `file:`, `.db` / `.sqlite` filename, `sqlite::memory:` | sqlite |

Three call shapes for `createDb`:

```ts
// 1. URL only — adapter inferred
const db = await createDb({ url: process.env.DATABASE_URL! });

// 2. Explicit type override (useful behind proxies / connection poolers
//    that mangle the URL prefix)
const db = await createDb({ type: 'postgres', url: '...' });

// 3. Structured config (no URL string)
const db = await createDb({
  type: 'postgres',
  host: 'localhost', port: 5432, database: 'myapp',
  user: 'postgres', password: '…',
  pool: { min: 5, max: 50 },
});
```

If both `type:` and `url:` are passed and they disagree, forge throws —
typo / wrong-env-loaded caught early.

---

## Reading data

Every read accepts the same arg shape: `where`, `select` OR `include`,
`omit`, `orderBy`, `take`/`limit`, `skip`/`offset`, `cursor`, `distinct`.

```ts
// findFirst — one row or null
const user = await db.user.findFirst({ where: { email: 'a@b.co' } });

// findUnique — by unique field; same shape but `where` is required
const user2 = await db.user.findUnique({ where: { email: 'a@b.co' } });

// findFirstOrThrow / findUniqueOrThrow — throws DbKnownError P2025 on miss
const must = await db.user.findFirstOrThrow({ where: { email: 'a@b.co' } });

// findMany — array (possibly empty)
const recent = await db.post.findMany({
  where: { status: 'PUBLISHED', author: { is: { active: true } } },
  orderBy: [{ created_at: 'desc' }, { title: 'asc' }],
  take: 20,
  skip: 40,    // alias: offset
});

// count
const n = await db.post.count({ where: { author_id: 'u1' } });

// distinct (post-fetch dedupe on Mongo; native DISTINCT ON on PG)
const tags = await db.post.findMany({ distinct: ['status'] });
```

### `where` operators

```ts
{ email: 'a@b.co' }                          // bare equality
{ email: { equals: 'a@b.co' } }              // explicit
{ email: { in: ['a@b.co', 'c@d.co'] } }      // in / notIn
{ email: { contains: 'gmail', mode: 'insensitive' } }   // ILIKE on PG
{ email: { startsWith: 'a' } }
{ age:   { gte: 18, lt: 65 } }               // range
{ tags:  { has: 'forge', hasSome: ['ts', 'pg'], isEmpty: false } }   // arrays

// Logical
{ AND: [{ active: true }, { age: { gte: 18 } }] }
{ OR:  [{ email: { contains: '@x.co' } }, { email: { contains: '@y.co' } }] }
{ NOT: { active: false } }

// Relations
{ posts: { some: { status: 'PUBLISHED' } } }     // EXISTS (...)
{ posts: { every: { status: 'PUBLISHED' } } }    // NOT EXISTS (... WHERE NOT ...)
{ posts: { none: { is_deleted: true } } }
{ author: { is: { active: true } } }
{ author: { isNot: { active: false } } }
```

### `select` vs `include`

```ts
// select — get back ONLY these scalar fields + listed relations
await db.user.findFirst({ select: { id: true, email: true } });
// → { id, email }  — accessing .created_at is a compile error

// include — get back ALL scalars PLUS listed relations
await db.user.findFirst({ include: { posts: true } });
// → User & { posts: Post[] }

// Nested args on the included relation
await db.user.findFirst({
  include: {
    posts: { where: { status: 'PUBLISHED' }, orderBy: { created_at: 'desc' }, take: 5 },
  },
});

// _count for a relation (no hydration, just the count)
await db.user.findFirst({
  include: { _count: { select: { posts: true, comments: true } } },
});
// → User & { _count: { posts: number; comments: number } }

// omit — opposite of select (drop these fields, keep the rest)
await db.user.findFirst({ omit: { created_at: true, updated_at: true } });
```

### Cursor pagination

```ts
// Single-field cursor
const page2 = await db.post.findMany({
  cursor: { id: lastIdFromPage1 },
  orderBy: { id: 'asc' },
  take: 20,
});

// Composite cursor (matches a @@unique([a, b]))
const page2 = await db.like.findMany({
  cursor: { user_id_post_id_kind: { user_id: 'u1', post_id: 'p1', kind: 'LIKE' } },
  take: 20,
});
```

---

## Writing data

```ts
// create — returns the created row
const u = await db.user.create({
  data: { email: 'alice@x.co', name: 'Alice', role: 'EDITOR' },
});

// createMany — returns { count }
const { count } = await db.user.createMany({
  data: [
    { email: 'bob@x.co',   name: 'Bob' },
    { email: 'carol@x.co', name: 'Carol' },
  ],
  skipDuplicates: true,  // ON CONFLICT DO NOTHING on PG; ordered:false on Mongo
});

// update — returns the updated row; throws P2025 if no match
const updated = await db.user.update({
  where: { id: u.id },
  data: { active: false },
});

// updateMany — returns { count }
const { count: n } = await db.user.updateMany({
  where: { active: false },
  data: { active: true },
});

// upsert — atomic find-or-create
await db.user.upsert({
  where: { email: 'alice@x.co' },
  create: { email: 'alice@x.co', name: 'Alice' },
  update: { name: 'Alice (updated)' },
});

// delete — returns the deleted row
await db.user.delete({ where: { id: u.id } });

// deleteMany — returns { count }
await db.user.deleteMany({ where: { active: false } });
```

Reading-shape sugar applies to writes too — `create`/`update`/`upsert`/`delete`
all accept `select`/`include`/`omit` to shape the returned row:

```ts
const userWithProfile = await db.user.create({
  data: { email: 'a@x.co', name: 'A' },
  include: { profile: true },
});
```

---

## Atomic updates

For numeric and array fields, use the atomic operator wrappers — they
translate to native DB ops (`$inc` / `array_append` / `SET col = col + $n`)
rather than fetch-modify-write, so they're concurrency-safe.

```ts
// Numeric atomic ops
await db.post.update({
  where: { id: 'p1' },
  data: {
    view_count: { increment: 1 },
    score:      { decrement: 2 },
    rating:     { multiply: 1.5 },
    factor:     { divide: 4 },
  },
});

// Array push (text[] / integer[] on PG, $push on Mongo)
await db.post.update({
  where: { id: 'p1' },
  data: { tag_names: { push: 'typescript' } },
});

// Set field to NULL (use ForgeDbNull or just null)
import { ForgeDbNull } from '@forge';
await db.profile.update({ where: { id: 'x' }, data: { bio: ForgeDbNull } });
```

The atomic ops also work on **optional numeric fields** — forge's
`IsNumericField<T>` helper handles `number | null | undefined` properly.

---

## Relations & nested writes

### Eager loading via `include`

Forge hydrates relations via post-fetch batched queries (one IN-query per
relation, batched across all parent rows — no N+1).

```ts
const u = await db.user.findFirst({
  where: { id: 'u1' },
  include: {
    profile: true,                                    // one-to-one
    posts: {                                          // one-to-many w/ args
      where:   { status: 'PUBLISHED' },
      orderBy: { created_at: 'desc' },
      take:    10,
    },
    _count: { select: { comments: true, likes: true } },  // counts only
  },
});
// u → User & { profile, posts, _count: { comments, likes } }
```

### Nested writes

```ts
// Create a user with their first post in one call
await db.user.create({
  data: {
    email: 'a@x.co', name: 'A',
    posts: {
      create: { title: 'hi', slug: 'hi', body: '…', status: 'PUBLISHED' },
    },
  },
});

// Create multiple children
await db.user.create({
  data: {
    email: 'b@x.co', name: 'B',
    posts: {
      createMany: { data: [
        { title: 't1', slug: 's1', body: '...', status: 'PUBLISHED' },
        { title: 't2', slug: 's2', body: '...', status: 'DRAFT' },
      ]},
    },
  },
});

// connect: attach to an existing row by id
await db.postTag.create({
  data: {
    post_id: 'p1',
    tag: { connect: { id: 'tag_typescript' } },
  },
});

// connectOrCreate: find-or-create on the target
await db.postTag.create({
  data: {
    post_id: 'p1',
    tag: { connectOrCreate: {
      where:  { name: 'typescript' },
      create: { name: 'typescript' },
    }},
  },
});

// disconnect: clear the FK
await db.postTag.update({
  where: { id: 'pt1' },
  data:  { tag: { disconnect: true } },
});

// delete / deleteMany on the relation
await db.user.update({
  where: { id: 'u1' },
  data:  { comments: { deleteMany: { is_deleted: true } } },
});
```

### Cascades

Set `onDelete: 'Cascade' | 'SetNull' | 'NoAction' | 'Restrict'` on the
relation declaration. Forge emits:

- **PG**: `ON DELETE CASCADE` (etc.) on the FK constraint — enforced by the
  DB engine.
- **Mongo**: a JS walker runs after each delete to fix up child rows.

Either way, `db.user.delete({ where: { id } })` removes related rows
according to the schema's declarations — no explicit cleanup code at call
sites.

---

## `groupBy` and aggregations

```ts
// Count by enum
const byRole = await db.user.groupBy({
  by: ['role'],
  _count: { _all: true },
  orderBy: { role: 'asc' },
});
// → [{ role: 'USER', _count: { _all: 142 } }, { role: 'EDITOR', _count: { _all: 12 } }, …]

// Aggregations: _avg, _sum, _min, _max
const stats = await db.post.groupBy({
  by: ['status'],
  _count: { _all: true },
  _avg:   { view_count: true },
  _sum:   { view_count: true },
  _min:   { view_count: true },
  _max:   { view_count: true },
});
// → [{ status: 'PUBLISHED', _count: {...}, _avg: { view_count: 12.3 }, _sum: {...}, … }, ...]

// `having` — post-aggregate filter
const popular = await db.user.groupBy({
  by: ['role'],
  _count: { _all: true, id: true },
  having: { _count: { id: { gt: 100 } } },   // only roles with >100 users
});
```

On Postgres this compiles to native `SELECT … COUNT(*), AVG(col) FROM …
GROUP BY … HAVING … ORDER BY … LIMIT …`. On Mongo it compiles to an
aggregation pipeline with `$match` + `$group` + `$match` (for having) +
`$sort` + `$limit`. The wrapper reshapes the flat `__agg_count_all` etc.
aliases back into Prisma's nested `_count: {...}` payload on the way out.

---

## Transactions

```ts
// Callback form: every write inside the callback runs in one transaction.
// Throws → automatic rollback. Resolves → automatic commit.
await db.$transaction(async (tx) => {
  const u = await tx.user.create({ data: { email: 'a@x.co', name: 'A' } });
  await tx.profile.create({ data: { user_id: u.id, bio: 'hello' } });
  await tx.auditLog.create({ data: { actor_id: u.id, event: 'signup' } });
});

// Array form: resolves the array; returns the result tuple.
const [users, posts] = await db.$transaction([
  db.user.findMany(),
  db.post.findMany(),
]);
```

- **Postgres**: `BEGIN`/`COMMIT`/`ROLLBACK` via a borrowed `PoolClient`.
- **MySQL**: same — `START TRANSACTION`/`COMMIT`/`ROLLBACK` via a borrowed connection.
- **SQLite**: `BEGIN`/`COMMIT`/`ROLLBACK` on the single in-process connection.
- **Mongo**: `withTransaction` via a `ClientSession`. **Requires a replica
  set or mongos** — single-node Mongo throws on `$transaction`. Same
  limitation Prisma has on its Mongo connector.

> **Gotcha (SQL):** don't `try/catch`-and-continue a constraint violation
> *inside* a `$transaction`. On Postgres a failed statement aborts the whole
> transaction — the swallowed error doesn't let you proceed; the next statement
> fails with *"current transaction is aborted"*. forge maps the violation to
> `P2002` and rolls back cleanly (no partial write), but the catch-and-continue
> pattern won't work. Check-then-write, use `upsert`, or let the transaction
> fail and retry. (Surfaced by the canary — see `canary/README.md`.)

---

## Raw SQL escape hatch

Two call styles, both parameterised (injection-safe by default):

```ts
import { forgeSql } from '@forge';

// Tagged template — values become $1, $2, … placeholders automatically
const id = 'u_42';
const rows = await db.$queryRaw<{ id: string; email: string }>`
  SELECT id, email FROM users WHERE id = ${id} AND active = ${true}
`;
// rows[0].id is typed `string`, not any.

// Composition with forge.sql / forge.join / forge.empty
const filter = active
  ? forgeSql.sql`AND active = ${true}`
  : forgeSql.empty;

await db.$queryRaw`
  SELECT * FROM users
  WHERE org_id = ${orgId}
  ${filter}
`;

// $executeRaw — returns affected row count
const affected = await db.$executeRaw`
  UPDATE users SET active = false WHERE last_login < ${cutoffDate}
`;
```

Mongo's `$queryRaw` throws a clear "SQL-only" error — use the aggregation
pipeline (`db.<model>.aggregate({ pipeline })`) or `$runCommandRaw(cmd)` for
raw Mongo.

---

## Errors

Every recoverable error surfaces as `DbKnownError` with a Prisma-shape code,
identical across adapters:

```ts
import { DbKnownError } from '@forge';

try {
  await db.user.create({ data: { email: existingEmail, name: '...' } });
} catch (e) {
  if (e instanceof DbKnownError && e.code === 'P2002') {
    // unique violation
    console.log('email already taken; meta:', e.meta);
  } else throw e;
}
```

Codes mapped today:

| Code | Meaning | Mongo | PG SQLSTATE | MySQL errno | SQLite code |
|---|---|---|---|---|---|
| `P2002` | Unique constraint failed | dup key (11000) | 23505 | 1062 | SQLITE_CONSTRAINT_UNIQUE / _PRIMARYKEY |
| `P2003` | Foreign key constraint failed | — | 23503 | 1451 / 1452 | SQLITE_CONSTRAINT_FOREIGNKEY |
| `P2004` | Check constraint failed | — | 23514 | 3819 | SQLITE_CONSTRAINT_CHECK |
| `P2011` | Null constraint violation | — | 23502 | 1048 | SQLITE_CONSTRAINT_NOTNULL |
| `P2021` | Table does not exist | — | 42P01 | 1146 | SQLITE_ERROR |
| `P2022` | Column does not exist | — | 42703 | 1054 | — |
| `P2024` | Query timeout | — | 57014 | 1205 / 1317 | — |
| `P2025` | Record not found | findFirstOrThrow miss | — | — | — |
| `P2034` | Transaction deadlock / serialisation | — | 40P01 / 40001 | 1213 / 1205 | SQLITE_BUSY / _LOCKED |
| `P1001` | Connection error | — | 08000 / 08006 | 2002 / 2003 / 2006 | SQLITE_IOERR / _CANTOPEN |
| `P1010` | Authentication failed | — | 28P01 / 28000 | 1045 | — |

`e.meta` carries adapter context: `{ sqlstate, modelName, field_name, target, detail }` on PG; `{ modelName, target }` on Mongo.

---

## Schema sync — `forge:push`

Single command, both adapters:

```sh
# Mongo: creates/updates the indexes declared by `.unique()` / @@unique / @@index
DATABASE_URL="mongodb://…" npm run forge:push

# Postgres: emits CREATE TABLE / FK / UNIQUE / CHECK / INDEX, runs inside a
# transaction with `pg_advisory_xact_lock` to serialise concurrent invocations,
# wraps each statement in a SAVEPOINT so single failures don't abort the batch.
DATABASE_URL="postgres://…" npm run forge:push
```

Sample output:

```
[forge:push] 34 statements to apply, 0 already in place
  ✓ table       users
  ✓ table       profiles
  ✓ unique      forge_users_uq_email
  ✓ check       forge_users_enum_role
  ✓ foreignKey  forge_profiles_fk_user_id
  ✓ index       forge_users_idx_created_at
  …
[forge:push] applied 34, skipped 0
```

Idempotent — re-running against an in-sync DB is a no-op (introspects
`information_schema.tables` + `pg_constraint` + `pg_indexes`, only applies
what's missing).

---

## `forge:doctor`

Environment checker — prints which drivers are installed and what adapter
`DATABASE_URL` would resolve to:

```sh
$ npm run forge:doctor

Forge — environment check

  Drivers installed:
    ✓ mongodb          6.21.0
    ✓ pg               8.21.0
    ✗ mysql2           not installed
    ✗ better-sqlite3   not installed

  DATABASE_URL:
    postgres://forge:****@localhost/myapp  →  postgres adapter  (✓ driver installed)
```

---

## The `.compile` escape hatch

Every model wrapper has a `.compile` namespace mirroring its execute methods
but returning the raw artifact instead of running it. Useful when you want
forge's typed builder but your own driver for execution:

```ts
const c = db.user.compile.findMany({
  where: { active: true, age: { gte: 18 } },
  take: 20,
});

// On Mongo, c is a typed object you pass straight to the driver:
// {
//   kind: 'mongo', collection: 'users', op: 'find',
//   args: { filter: { $and: [...] }, options: { sort: [...], limit: 20 } }
// }
const mongo = require('mongodb');
const client = new mongo.MongoClient(url);
await client.connect();
const docs = await client.db().collection(c.collection)
  .find(c.args.filter, c.args.options).toArray();

// On Postgres (via buildPostgresCompileApi):
// {
//   kind: 'sql', dialect: 'postgres',
//   sql: 'SELECT … FROM "users" WHERE … LIMIT 20',
//   params: [true, 18]
// }
const { Pool } = require('pg');
const pool = new Pool({ connectionString: url });
const { rows } = await pool.query(c.sql, c.params);
```

Use cases:

- Plugging forge's typed query builder into a codebase that owns its own
  connection pool.
- Generating migration / seed scripts from typed queries.
- Capturing every query for replay / audit / fuzz testing.
- Debugging — see exactly what forge would send to the driver.

---

## Type safety in detail

Forge's types were verified programmatically by driving the TypeScript
Language Service directly. See `autocomplete-probe.ts` and
`typesafety-demo.ts` for the full verification harness.

**What's strictly typed** (autocomplete works, bad inputs are compile errors):

- Per-model `WhereInput` / `CreateInput` / `UpdateInput` / `Select` /
  `Include` / `FindManyArgs` / `Payload<Args>` — none collapse to `any`,
  all derive from the schema map via mapped types
- `select: { fieldName: true }` keys autocomplete from the model's scalar
  fields; wrong types (`email: 42`) rejected
- `include: { relName: true }` keys autocomplete from the model's relations;
  scalars are NOT offered
- Atomic ops on numeric fields (incl. **optional numerics** like
  `age?: number | null`) accept `{ increment: 1 }` without `as any`
- `select`-narrowed return types — `db.user.findFirst({ select: { email: true } })`
  returns `{ email: string } | null`; accessing `.created_at` is a compile
  error
- Enum literal unions — `role: 'WIZARD'` rejected when the schema enum is
  `'USER' | 'EDITOR' | 'ADMIN'`
- `groupBy` `by` accepts only real schema fields; `_count`/`_avg`/`_sum`/
  `_min`/`_max` accept only real fields (`_count` additionally accepts
  `_all`)
- Tagged-template `$queryRaw<T>` — return rows typed as `T[]`

**Documented loose surface** (known design trade-offs):

- `where` has a `[k: string]: any` escape hatch to accept composite-unique
  synthetic keys (Prisma convention). Side effect: top-level field-name
  typos in `where` and unknown enum strings slip through. DB-level CHECK
  catches enums at runtime (→ P2004); composite keys would otherwise be
  unreachable without this.
- `CreateInput` marks every field optional — missing-required surfaces at
  runtime as `P2011` (NOT NULL violation) rather than at compile time. The
  schema's "required" notion is fuzzy (DEFAULT clauses, `.optional()`, auto
  timestamps).
- `aggregate({ pipeline: any[] })` is intentionally untyped — BSON
  pipelines aren't domain-typed. Use `groupBy` (typed) for normal cases.

Verify yourself:

```sh
# Probe completions via the Language Service API:
npx ts-node autocomplete-probe.ts

# Assert specific type contracts hold:
npx tsc --noEmit --strict typesafety-demo.ts
```

---

## Architecture

```
                        user calls
                            │
                            ▼
                   ┌─────────────────┐
                   │ CollectionWrapper│   typed Prisma-shape methods
                   │  (db.user.…)    │
                   └────────┬────────┘
                            │
                            ▼ buildSelect / buildInsert / buildUpdate / …
                   ┌─────────────────┐
                   │     Query IR    │   adapter-agnostic intermediate rep
                   │  (ir/types.ts)  │
                   └────┬───────┬────┘
                        │       │
                ┌───────┘       └───────┐
                ▼                       ▼
     ┌──────────────────┐   ┌──────────────────────┐
     │ adapters/mongo/  │   │ adapters/postgres/   │
     │   compile-from-ir│   │   compile-from-ir    │
     │   execute        │   │   execute            │
     │   ddl + migrate  │   │   ddl + migrate      │
     └─────────┬────────┘   └──────────┬───────────┘
               │                        │
               ▼                        ▼
        mongodb driver              pg driver
```

The IR is the keystone — it's what makes "same query, two databases" work.
A `SelectNode` doesn't know about Mongo filters or SQL `WHERE` clauses; it
just describes "fetch rows from model X matching this WhereTree." Each
adapter has its own compiler that turns the IR into a driver-specific call.

When you add a new adapter, you implement the `Adapter` interface — eight
executor methods + lifecycle. The wrapper, the IR builders, and 90% of the
type system stay the same.

---

## Running tests

Every check is an npm script — no raw `ts-node` invocations to remember.

```sh
cd forge/library

# ─── No DB required ──────────────────────────────────────────────

npm run forge:test          # unit tests (177 assertions, jest)
npm run forge:typesafety    # strict TS assertions on typesafety-demo.ts
npm run forge:autocomplete  # prints the actual autocomplete lists per cursor
                            # position via the TypeScript Language Service
npm run forge:check         # all three of the above in sequence

# ─── Requires DATABASE_URL ───────────────────────────────────────

npm run forge:doctor        # shows installed drivers + adapter inferred
                            # from DATABASE_URL
npm run forge:push          # pushes schema (DDL on PG, indexes on Mongo);
                            # picks adapter from DATABASE_URL

# ─── Requires a live local DB ────────────────────────────────────

npm run forge:integration:pg     # 38 scenarios against live Postgres
npm run forge:integration:mongo  # 27 scenarios against live Mongo
npm run forge:integration        # both, in sequence

# ─── Benchmark — forge vs raw driver, side-by-side ───────────────

npm run forge:bench               # default: 500 seed rows, 200 iterations
BENCH_SEED=1000 BENCH_ITER=500 npm run forge:bench
SKIP_MONGO=1 npm run forge:bench  # skip an adapter you don't have running
```

### Configuring connection strings

Every `forge:*` script loads `.env` at startup via dotenv. Copy the example
and edit values to match your local databases:

```sh
cd forge/library
cp .env.example .env
$EDITOR .env
```

`.env` is gitignored. `.env.example` is the canonical list of vars with
defaults documented inline.

| Variable | Default | Used by |
|---|---|---|
| `DATABASE_URL` | — (required at runtime if used) | `forge:doctor`, `forge:push`, application code via `createDb({ url })` |
| `SMOKE_PG_USER` | `johnfash` (OS login) | `forge:integration:pg` |
| `SMOKE_PG_HOST` | `127.0.0.1` | `forge:integration:pg` |
| `SMOKE_PG_PORT` | `5432` | `forge:integration:pg` |
| `SMOKE_PG_ROOT` | `postgres` (bootstrap db for CREATE/DROP) | `forge:integration:pg` |
| `SMOKE_MONGO_URL` | `mongodb://127.0.0.1:27017/<unique>` | `forge:integration:mongo` |
| `BENCH_PG_URL` | `postgres://johnfash@127.0.0.1:5432/postgres` | `forge:bench` |
| `BENCH_MONGO_URL` | `mongodb://127.0.0.1:27017` | `forge:bench` |
| `BENCH_SEED` | `500` | `forge:bench` (rows seeded before reads) |
| `BENCH_ITER` | `200` | `forge:bench` (iterations per scenario) |
| `SKIP_PG=1` / `SKIP_MONGO=1` | — | `forge:bench` (opt out of an adapter you don't run locally) |

Each integration / bench script creates a uniquely-named isolated
database/collection per run and **drops it on exit** — no test data ever
bleeds into existing schemas.

---

## Comparison with Prisma

A feature/architecture map — **not** a verdict. Prisma is a mature, widely
deployed product with a large ecosystem, deep tooling, and a long production
track record; forge is a compact single-author library. Read this as "here's
what each gives you and where they differ," not "forge wins."

| Feature | Forge | Prisma |
|---|---|---|
| Type-safe queries | ✓ derived from schema (no codegen) | ✓ via codegen |
| MongoDB | ✓ | ✓ |
| PostgreSQL | ✓ | ✓ |
| MySQL | ✓ | ✓ |
| SQLite | ✓ (in-process via `better-sqlite3`) | ✓ |
| SQL Server / CockroachDB | — | ✓ |
| Cold start | ~50 ms (Node + driver) | ~70 ms (Node + Rust engine) |
| Bundle size | ~50 KB (library) + driver | ~5 MB (includes Rust engine) |
| Memory per process | ~14 MB (mongodb driver) | ~28 MB (Rust engine + bridge) |
| Atomic ops | ✓ | ✓ |
| groupBy / aggregations | ✓ | ✓ |
| Relation hydration | ✓ batched IN | ✓ batched IN |
| `select`-narrowed return type | ✓ | ✓ |
| `include` with nested args | ✓ | ✓ |
| `connectOrCreate` | ✓ | ✓ |
| Nested `upsert` / `update` / `delete` on writes | Partial | ✓ |
| `$transaction` (callback + array) | ✓ | ✓ |
| `$queryRaw` + tagged template | ✓ | ✓ |
| Migration history + drift detection | ✓ (Wave 5 — `forge:diff` / `diff:apply` / `rollback`) | ✓ |
| Prisma Studio equivalent | — (use TablePlus / Compass) | ✓ |
| `$extends` middleware | — | ✓ |
| Full-text search | Wave 4 | ✓ |
| Streaming reads | Wave 4 | ✓ |
| OpenTelemetry hooks | Wave 4 | ✓ |
| **Inspection** | ~5,000 lines TS, one folder | Rust engine + protocol + client |

> The cold-start / bundle / memory rows describe Prisma's **default Rust query
> engine** (Prisma ≤6, and v7 without driver-adapters). Prisma 7's
> driver-adapter mode drops the Rust engine and narrows those gaps
> considerably. The benchmark above uses Prisma 7.8 driver-adapters, so it does
> **not** reflect the Rust-engine numbers in this table — they're different axes.

---

## Known gaps & roadmap

**Implemented** (Waves 0–4c):

- ✓ IR layer (adapter-agnostic intermediate representation)
- ✓ Mongo adapter (compile + execute + cascade walker + push)
- ✓ Postgres adapter (compile + execute + DDL + migration runner)
- ✓ MySQL adapter (compile + execute + DDL + migration runner with advisory lock)
- ✓ SQLite adapter (compile + execute + DDL + migration runner; in-memory + file)
- ✓ `forge:push` across all four — same command, picks adapter from URL
- ✓ `forge:doctor`
- ✓ `.compile` escape hatch (Mongo + Postgres compile APIs)
- ✓ `$queryRaw` / `$executeRaw` (tagged template + fragment, all SQL dialects)
- ✓ `$transaction` (callback + array)
- ✓ Atomic ops (incl. optional numerics)
- ✓ Relation hydration (all four)
- ✓ `connectOrCreate` (owning + inverse)
- ✓ `groupBy` + `_count` / `_avg` / `_sum` / `_min` / `_max` + `having`
- ✓ Sample schema covering every feature
- ✓ Error code mapping (P1xxx / P2xxx) for all four dialects
- ✓ Type-safety verification harness (Language Service probes)
- ✓ `f.text()` for unbounded strings on MySQL (vs `f.string()` → VARCHAR(255))
- ✓ Side-by-side bench (forge vs raw driver) on all four dialects
- ✓ **Wave 4a — observability**: `db.$on('query', cb)` / `$on('error', cb)`
  event hooks emitting `{ adapter, model, op, sql, params, duration_ms,
  rowCount }` per query. Zero overhead when no listeners subscribed.
- ✓ **Wave 4a — streaming reads**: `db.<model>.findManyStream({ chunkSize })`
  returns `AsyncIterable<Row>` for memory-safe iteration over large result sets.
- ✓ **Wave 4a — full-text search**: `where: { title: { search: 'q' } }`
  compiles to PG `to_tsvector(...) @@ plainto_tsquery(...)`, MySQL
  `MATCH(col) AGAINST (...)`, Mongo `$text: { $search: ... }`. SQLite
  throws an actionable error directing to FTS5 + `$queryRaw`.
- ✓ **Wave 4b — `.searchable()` schema marker**: chained onto any string/text
  field, makes `forge:push` auto-emit the right FTS index per dialect — PG
  `CREATE INDEX … USING gin(to_tsvector('simple', col))`, MySQL `ADD FULLTEXT`,
  Mongo `createIndex({col: 'text'})`, SQLite `CREATE VIRTUAL TABLE … USING fts5(...)`.
- ✓ **Wave 4b — soft delete (`.softDeleteAt()`)**: chained onto a `dateTime`
  field, marks it the soft-delete column. The wrapper then:
    • auto-injects `WHERE <col> IS NULL` on every read,
    • rewrites `.delete()` / `.deleteMany()` to `UPDATE … SET <col> = now()`,
    • opts out via `where: { ..., _withDeleted: true }`.
- ✓ **Wave 4b — native cursor streaming**: `findManyStream` now uses each
  adapter's native cursor (PG `DECLARE … CURSOR`, MySQL `query().stream()`,
  SQLite `stmt.iterate()`, Mongo `cursor.stream()`) instead of OFFSET/LIMIT
  chunking. Constant memory regardless of result size.
- ✓ **Wave 4b — OpenTelemetry helper**: `wireOtel(db, { tracer })` subscribes
  to `$on('query'/'error')` and emits OTel-semconv spans (`db.system`,
  `db.operation`, `db.statement`, `db.collection.name`). Optional peer — the
  helper is structurally typed, so any tracer with `startSpan` works.
- ✓ **Wave 4c — read-only views (`.asView()`)**: declare a model as a view
  (`CREATE VIEW` on SQL, `createCollection({ viewOn, pipeline })` on Mongo);
  the wrapper blocks writes, reads work normally.
- ✓ **Wave 5a — comparison bench**: `forge:bench:compare` runs the same
  scenarios through forge **vs Prisma vs Drizzle vs the raw driver** on every
  dialect, reporting median / p95 / ops·s⁻¹ / overhead-vs-raw.
- ✓ **Wave 5b — drift detection (`forge:diff`)**: introspects the live DB
  (PG `pg_catalog`, MySQL `INFORMATION_SCHEMA`, SQLite `PRAGMA`, Mongo
  `listCollections`) and reports missing/extra tables·columns·indexes·FKs,
  type-category mismatches, and views. Human + `--json`; `--check` gates CI.
- ✓ **Wave 5c — schema-diff migrations**: `forge:diff:apply` generates and
  runs the reconciling SQL (with timestamped `up`/`down` files and a
  `_forge_migrations` history table); `forge:rollback` reverts the latest.
- ✓ **Wave 5d — materialised views**: `.asView({ materialised: true })` →
  PG `CREATE MATERIALIZED VIEW`, MySQL/SQLite table-backed, Mongo `$out`.
  `db.<model>.refresh()` recomputes; `db.<model>.scheduleRefresh('1h')`
  auto-refreshes (caller owns the returned `stop()`, no leaked timers).
- ✓ **Wave 5e — native types**: `f.decimal({ precision, scale })`, `f.uuid({ default })`,
  `f.bigint()`, and `.dbgenerated('<expr>')` generated columns — each
  emits dialect-correct DDL.
- ✓ **Wave 5e — `select`/`include` XOR** enforced at compile time; **`strict: true`**
  factory option rejects unknown `where` keys at runtime.

### Wave 4 — Observability

```ts
const db = await createDb({ url: process.env.DATABASE_URL! });

// Subscribe to every query
const off = db.$on('query', (e) => {
  console.log(`[${e.adapter}] ${e.op} ${e.model} — ${e.duration_ms.toFixed(2)}ms`);
  if (e.duration_ms > 100) console.warn(`SLOW: ${e.sql}`, e.params);
});

const off2 = db.$on('error', (e) => {
  console.error(`[${e.adapter}] ${e.op} failed:`, e.error.message);
});

// Later:
off();   // unsubscribe — returned by $on
off2();
```

The emitter does nothing while there are no subscribers (zero overhead).
The moment a listener attaches, each query also compiles its artifact a
second time to capture sql/params for the event — measured at ~5–15 µs per
query in the bench, vs the ms-scale query itself.

### Wave 4 — Streaming reads

```ts
// Memory-safe iteration over the full users table.
for await (const user of db.user.findManyStream({
  where: { active: true },
  orderBy: { created_at: 'asc' },
  chunkSize: 500,        // fetches in batches of 500, yields one at a time
})) {
  await sendWelcomeEmail(user);    // back-pressure: next batch waits for this
}
```

Internally implemented as OFFSET/LIMIT chunking (works on every adapter)
and one chunk in memory at a time. Native cursor-based streaming for PG
(`pg-cursor`) / MySQL (`stream: true`) is a Wave 4b optimisation.

### Wave 4 — Full-text search

```ts
// All three SQL/Mongo backends translate the same query shape:
const hits = await db.post.findMany({
  where: { title: { search: 'forge AND wrapper' } },
});

//   Postgres:  to_tsvector('simple', title) @@ plainto_tsquery('simple', $1)
//   MySQL:     MATCH(title) AGAINST (? IN NATURAL LANGUAGE MODE)
//   Mongo:     $text: { $search: '...' }  (collection-scoped, not field-scoped)
```

**Index requirements** (Wave 4b's `f.text().searchable()` will emit these
automatically; for now create them once via `$executeRaw`):

```sh
# Postgres — functional index on the tsvector
CREATE INDEX posts_title_fts ON posts USING gin(to_tsvector('simple', title));

# MySQL — FULLTEXT index
ALTER TABLE posts ADD FULLTEXT(title);

# Mongo — text index on the collection (only one per collection)
db.posts.createIndex({ title: 'text' })

# SQLite — needs FTS5 virtual table; forge throws an actionable error
#          pointing you at the $queryRaw escape hatch.
```

### Wave 4b — Soft delete

```ts
// Mark the soft-delete column on the model:
export const AuditLog = model('audit_logs', {
  id: f.id(),
  event: f.string(),
  deleted_at: f.dateTime().softDeleteAt(),   // ← marker
});

// Reads automatically filter out soft-deleted rows:
await db.auditLog.findMany();        // WHERE deleted_at IS NULL (auto)
await db.auditLog.count();           // same — only live rows

// .delete() / .deleteMany() rewrite to UPDATE … SET deleted_at = now()
await db.auditLog.delete({ where: { id } });
// The row still exists, just marked deleted.

// Opt out: see deleted rows too
await db.auditLog.findFirst({ where: { id, _withDeleted: true } });
```

### Wave 4b — OpenTelemetry

```ts
import { trace } from '@opentelemetry/api';
import { wireOtel } from '@guide/forge';

const tracer = trace.getTracer('myapp');
const off = wireOtel(db, { tracer });

// Every query/error now emits an OTel span with:
//   db.system            → 'postgresql' | 'mysql' | 'sqlite' | 'mongodb'
//   db.operation         → 'select' | 'insert' | 'update' | 'delete' | …
//   db.statement         → the compiled SQL (truncated to 1024 chars by default)
//   db.collection.name   → model key
//   forge.adapter        → forge adapter kind
//   forge.row_count      → rows returned/affected
//   forge.duration_ms    → wall-clock duration
```

The helper is **structurally typed** — `OtelTracer` is just `{ startSpan(...) }`
so you don't even need `@opentelemetry/api` installed. Pass any object that
matches the shape and forge will emit spans through it.

- ✓ **Wave 4c — read-only views (`.asView()`)**: declare a model as a view
  backed by `CREATE VIEW` (PG/MySQL/SQLite) or `createCollection({viewOn,pipeline})`
  (Mongo). The wrapper blocks every write method with an actionable error;
  reads work normally.
- ✓ **Wave 4c — SQLite FTS5 read-route rewriting**: `.searchable()` fields
  now Just Work on SQLite. `forge:push` emits the FTS5 virtual table + sync
  triggers (`AFTER INSERT/UPDATE/DELETE`), and `where.search` compiles to
  `rowid IN (SELECT rowid FROM <table>_fts WHERE <table>_fts MATCH ?)` —
  no more `$queryRaw` workaround.

### Wave 4c — Read-only views

```ts
// Declare a view alongside your tables in the schema:
export const PublishedPosts = model('published_posts', {
  id: f.id(),
  title: f.string(),
  slug: f.string(),
  view_count: f.int(),
}).asView({
  // SQL dialects — a parameter-free SELECT body:
  sql: `SELECT id, title, slug, view_count FROM posts WHERE status = 'PUBLISHED'`,
  // Mongo — source collection + aggregation pipeline:
  sourceCollection: 'posts',
  pipeline: [
    { $match: { status: 'PUBLISHED' } },
    { $project: { _id: 1, title: 1, slug: 1, view_count: 1 } },
  ],
});
// Register in the schema map:
export const schema = { …, publishedPosts: PublishedPosts };

// Use:
const live = await db.publishedPosts.findMany();   // ✓ reads from CREATE VIEW
await db.publishedPosts.create({ data: {...} });    // ✗ throws — read-only view
```

`forge:push` emits `CREATE OR REPLACE VIEW` (PG/MySQL) / `CREATE VIEW IF NOT EXISTS`
(SQLite) / `createCollection({viewOn, pipeline})` (Mongo). Every write
method (`create`, `createMany`, `update`, `updateMany`, `upsert`, `delete`,
`deleteMany`) throws a clear error with the actionable workaround. Reads
(`findFirst`, `findMany`, `count`, `groupBy`, hydration) work transparently
because views look like collections/tables to the query layer.

> **Wave 5 shipped in 1.0.** Everything previously planned here — native types,
> `dbgenerated`, `select`/`include` XOR, `strict` mode, the comparison bench,
> drift detection, schema-diff migrations, and materialised views — is
> implemented and live-tested across all four dialects. See the
> [Wave 5 sections](#wave-5--production-hardening) below.

**Documented gaps** (remaining):

- `forge:diff` type-comparison is category-level (string/int/decimal/…); a
  fine-grained `ALTER COLUMN TYPE` is left to a hand-written migration.
- SQLite can't `ALTER TABLE … ADD FOREIGN KEY`; `forge:diff` reports the
  missing FK and `diff:apply` emits a guided no-op (rebuild the table).
- The SQL migration workflow (`forge:diff:apply` / `forge:rollback`) is
  SQL-only; Mongo stays index-managed through `forge:push`.

---

## Wave 5 — production hardening

### Comparison bench — forge vs Prisma vs Drizzle

```bash
npm run forge:bench:compare:gen     # one-time: generate Prisma clients
npm run forge:bench:compare         # all dialects, or :pg / :mysql / :sqlite / :mongo
```

Runs identical scenarios (filtered findMany, indexed findFirst, count, update)
through forge, Prisma 7.8 (via driver-adapters), Drizzle 0.45, and the raw
driver against the **same** table forge created, printing each engine's
median / p95 / ops·s⁻¹ and overhead relative to the raw driver. Representative
Postgres run (200 iterations, 500 rows, localhost):

```
  op           raw driver   forge      prisma     drizzle
  findMany     baseline     +21.5%     +45.7%     +36.9%
  findFirst    baseline     +41.0%     +86.3%     +73.2%
  count        baseline     +31.4%     +73.4%     +43.8%
  update       baseline     +39.6%     +75.3%     +26.5%
```

forge measures as the lowest-overhead wrapper on reads across PG, MySQL, and
SQLite; Drizzle's thinner write path edges it out on `update`. (Drizzle has no
Mongo driver; Prisma's Mongo path needs `@prisma/adapter-mongodb`.)

> **How to read these numbers — and how *not* to.**
>
> This benchmark says exactly one thing: **forge is a thin wrapper — its
> per-call overhead is competitive with, and often lower than, Prisma's and
> Drizzle's.** That's the only claim it supports. It is **not** evidence that
> forge is "better than" or "faster than" the alternatives. Specifically:
>
> - It's a **micro-benchmark of four trivial operations on localhost.** The
>   measured deltas (~0.05–0.3 ms) are dwarfed by network latency, connection
>   pooling, and query complexity in any real deployment — wrapper overhead is
>   effectively noise in production.
> - It's **forge's own harness**, wiring up the competitors. The scenarios were
>   chosen here and each ORM may not be invoked exactly as its authors would.
>   Treat it as "same ballpark," not a leaderboard.
> - **Low overhead ≠ better.** It says nothing about complex-join planning,
>   correctness at the edges, migrations tooling, ecosystem maturity, generated
>   types, serverless/edge support, or production track record — all areas
>   where Prisma and Drizzle are far ahead of a single-author ~5k-line library.
>
> The honest takeaway: **you don't pay a performance tax for forge's thinness
> and its one-API-across-four-databases design.** That — not "beats Prisma" —
> is the point. Reproduce it yourself and judge in your own environment.

### Native types & generated columns

```ts
const Invoice = model('invoices', {
  id: f.id(),
  amount:   f.decimal({ precision: 12, scale: 2 }),   // PG numeric · MySQL DECIMAL · SQLite NUMERIC · Mongo Decimal128
  ref:      f.uuid({ default: 'gen_random_uuid' }),   // PG uuid+default · MySQL CHAR(36)+UUID() · SQLite/Mongo string
  qty:      f.bigint(),                                // PG bigint · MySQL BIGINT · SQLite INTEGER · Mongo Long
  // generated/computed column — DB derives it, never written by the client:
  total:    f.decimal({ precision: 14, scale: 2 }).dbgenerated('amount * qty'),
});
```

### `strict` mode & `select`/`include` exclusivity

```ts
const db = await createDb({ url, strict: true });
await db.user.findMany({ where: { emial: 'x' } });   // throws: unknown where key 'emial'

// select and include are mutually exclusive at compile time:
db.user.findMany({ select: { email: true }, include: { posts: true } });  // ❌ type error
```

### Drift detection — `forge:diff`

```bash
forge:diff            # human-readable report of schema-vs-live drift
forge:diff --json     # machine-readable (CI tooling)
forge:diff --check    # exit non-zero when drift is found (CI gate)
```

```
✗ drift detected on postgres (3 issues):
  − [column] users: column 'name'
  − [index]  tags:  index u:name
  + [table]  stray_table: table 'stray_table' in DB but not in schema
```

### Schema-diff migrations — `forge:diff:apply` / `forge:rollback`

```bash
forge:diff:apply        # generate + run the reconciling migration (writes migrations/<ts>_drift.sql)
forge:diff:apply --dry  # print the SQL without applying
forge:rollback          # run the latest migration's `down` block
```

Applied migrations are tracked idempotently in a `_forge_migrations` table; each
generated file carries matching `-- up` / `-- down` blocks. Bring-DB-up-to-schema
(forward) and bring-DB-back (rollback) are both first-class. SQL dialects only —
Mongo stays on `forge:push`.

### Materialised views

```ts
export const PostStats = model('post_stats', {
  author_id:   f.objectId(),
  post_count:  f.bigint(),
  total_views: f.bigint(),
}).asView({
  materialised: true,
  sql: `SELECT author_id, COUNT(*) AS post_count, COALESCE(SUM(view_count),0) AS total_views
        FROM posts GROUP BY author_id`,
  sourceCollection: 'posts',
  pipeline: [ /* Mongo $group … $out: 'post_stats' */ ],
});

await db.postStats.refresh();              // PG REFRESH MATERIALIZED VIEW · MySQL/SQLite re-populate · Mongo $out
const stop = db.postStats.scheduleRefresh('1h');   // auto-refresh; call stop() to clear
```

---

## Extending forge — writing a new adapter

The `Adapter` interface is the contract. To add (say) MySQL:

```ts
// adapters/mysql/adapter.ts
export class MysqlAdapter implements Adapter {
  readonly kind = 'mysql' as const;
  readonly capabilities = { /* nativeCascades, nativeUpsert, … */ };

  async connect(url: string)  { /* lazy-require mysql2, open pool */ }
  async close()                { /* pool.end() */ }
  async doctor()               { /* report driver + capabilities */ }

  // IR executors — IR in, results out
  executeSelect(node, model, opts?)  { /* ... */ }
  executeCount(node, model, opts?)   { /* ... */ }
  executeInsert(node, model, opts?)  { /* ... */ }
  executeUpdate(node, model, opts?)  { /* ... */ }
  executeDelete(node, model, opts?)  { /* ... */ }
  executeGroupBy(node, model, opts?) { /* ... */ }
  applyProjectionAndHydration(rows, model, plan, opts?) { /* ... */ }

  // Transactions
  $transaction(fn) { /* BEGIN/COMMIT/ROLLBACK */ }

  // Raw escape hatches
  $queryRaw(fragment, opts?)    { /* pool.query(sql, params) */ }
  $executeRaw(fragment, opts?)  { /* pool.query(sql, params).rowCount */ }

  // Coerce / decode / cascade
  coerceInbound(model, data)              { /* identity / jsonb stringify */ }
  decodeOutbound(model, row)              { /* identity / decimal parse */ }
  applyCascadesForDelete(model, docs)     { /* no-op (DB enforces) */ }
}
```

Then add a SQL compiler in `adapters/mysql/compile-from-ir.ts` (most of it
copy-pasted from Postgres, with `?` placeholders instead of `$1, $2, …` and
MySQL's quoting + upsert dialect). Wire it into `factory.ts`. That's it.

The IR + the `Adapter` interface + the dialect-isolated compiler are why
this is mechanical work rather than a redesign.

---

## License & maintenance

Forge ships under the same license as the host project. The codebase is
small enough to fork and own — if you do, file issues upstream when you fix
bugs that affect everyone.

Built as a practical demonstration that "Prisma-shape" doesn't have to mean
"Prisma's stack." Sometimes you want ~5,000 lines of TypeScript you can
read in an afternoon.
