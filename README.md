# forge-orm

A small, Prisma-shaped data layer for **MongoDB, PostgreSQL, MySQL, and SQLite**.
You write your models once in plain TypeScript and the same query code runs
against any of the four databases. There is no code generation step, no Rust
query engine, and no framework to adopt. It is about 5,000 lines of TypeScript
you can read in an afternoon.

```
npm install forge-orm
```

* **npm:** https://www.npmjs.com/package/forge-orm
* **GitHub:** https://github.com/johnsonfash/forge-orm
* **License:** MIT

```ts
import { createDb, f, model } from 'forge-orm';

const User = model('users', {
  id:    f.id(),
  email: f.string().unique(),
  name:  f.string(),
});

const db = await createDb({ url: process.env.DATABASE_URL!, schema: { user: User } });

const alice = await db.user.create({ data: { email: 'a@x.co', name: 'Alice' } }); // no id needed
const users = await db.user.findMany({ where: { name: { contains: 'Ali' } }, take: 10 });
```

That same code works whether `DATABASE_URL` is a Postgres, MySQL, SQLite, or
Mongo connection string. forge picks the right driver from the URL.

---

## Contents

* [What forge is, and what it is not](#what-forge-is-and-what-it-is-not)
* [Install and pick your driver](#install-and-pick-your-driver)
* [Connecting](#connecting)
* [Defining a schema](#defining-a-schema)
  * [Models and automatic values (id, timestamps)](#models-and-automatic-values-id-timestamps)
  * [Field types](#field-types)
  * [Field modifiers](#field-modifiers)
  * [Indexes and unique constraints](#indexes-and-unique-constraints)
  * [Relations](#relations)
  * [Embedded objects](#embedded-objects)
* [Reading data](#reading-data)
  * [Filtering with `where`](#filtering-with-where)
  * [Choosing fields: `select` and `include`](#choosing-fields-select-and-include)
  * [Sorting and pagination](#sorting-and-pagination)
* [Writing data](#writing-data)
  * [Number and field updates](#number-and-field-updates)
  * [Writing related records in one call](#writing-related-records-in-one-call)
  * [Deletes and cascades](#deletes-and-cascades)
* [Grouping and aggregates](#grouping-and-aggregates)
* [Transactions](#transactions)
* [Running raw SQL](#running-raw-sql)
* [Errors](#errors)
* [Full-text search](#full-text-search)
* [Streaming large results](#streaming-large-results)
* [Soft delete](#soft-delete)
* [Views and materialised views](#views-and-materialised-views)
* [Watching queries](#watching-queries)
* [Creating tables and migrations](#creating-tables-and-migrations)
* [Dropping to raw queries with `.compile`](#dropping-to-raw-queries-with-compile)
* [Type safety](#type-safety)
* [Performance](#performance)
* [Testing](#testing)
* [Limitations and honest notes](#limitations-and-honest-notes)
* [Contributing](#contributing)

---

## What forge is, and what it is not

forge is a thin wrapper. It turns a Prisma-style call such as
`db.user.findMany({ where: { active: true } })` into the right query for your
database and runs it through the official driver (`pg`, `mysql2`,
`better-sqlite3`, or `mongodb`). The drivers do the actual work; forge builds
the queries and shapes the results.

Reach for forge when you want one query API across more than one database, a
dependency small enough to read and fork, full TypeScript autocomplete with no
generated client to keep in sync, and the option to drop down to raw SQL at any
time.

forge is **not** a replacement for Prisma or Drizzle in maturity. It is a young
library with no long production track record. It has fewer features, a smaller
ecosystem, and no GUI. If you need those, use Prisma or Drizzle. The
[honest notes](#limitations-and-honest-notes) at the end spell this out.

---

## Install and pick your driver

forge ships no database driver of its own. You install only the driver for the
database you use. Each one is an optional peer dependency, so `npm install
forge-orm` on its own pulls nothing extra, and importing forge needs no driver
at all.

| Database          | Connection string starts with     | Install                       |
| ----------------- | ---------------------------------- | ----------------------------- |
| PostgreSQL        | `postgres://` or `postgresql://`   | `npm install pg`              |
| MySQL or MariaDB  | `mysql://`                         | `npm install mysql2`          |
| SQLite            | `sqlite:` or `file:`               | `npm install better-sqlite3`  |
| MongoDB           | `mongodb://` or `mongodb+srv://`   | `npm install mongodb`         |

```sh
npm install forge-orm      # the library, no drivers
npm install pg             # add the one you need
```

The driver loads lazily, the first time you actually run a query against that
database. So importing forge, defining a schema, or using one database never
needs the other databases' drivers installed. If a driver is missing when you
connect, you get a clear message telling you what to install rather than a
crash.

There is no lock-in. No generated client to regenerate, no migration state you
cannot leave, no framework module to wire in, and no driver bundled inside. It
is plain TypeScript over the official drivers, and you can always call the
driver directly if you outgrow it.

---

## Connecting

`createDb` takes a connection URL and your schema. It returns a typed `db`
handle whose properties match your model names.

```ts
import { createDb } from 'forge-orm';

const db = await createDb({
  url: process.env.DATABASE_URL!,   // postgres://… | mysql://… | sqlite:… | mongodb://…
  schema: { user: User, post: Post },
});

// later, when shutting down:
await db.$disconnect();
```

Options:

* `url` is the connection string. The prefix selects the database.
* `schema` is your model map. `db.<key>` exists for each key (for example
  `db.user`, `db.post`).
* `type` (optional) forces the database type if the URL is ambiguous:
  `'postgres' | 'mysql' | 'sqlite' | 'mongo'`.
* `strict` (optional, default `false`). When `true`, a query that filters on an
  unknown field name throws instead of silently matching nothing. Useful for
  catching typos.

You can also pass connection parts instead of a URL:

```ts
await createDb({ type: 'postgres', host: 'localhost', database: 'app', user: 'me', schema });
```

---

## Defining a schema

A schema is a plain object mapping a name to a model. You build models with the
helpers exported from `forge-orm`: `f` (fields), `model`, `rel` (relations),
`enums`, and `embed`.

```ts
import { f, model, rel } from 'forge-orm';

const User = model('users', {
  id:         f.id(),
  email:      f.string().unique(),
  name:       f.string(),
  active:     f.bool().default(true),
  created_at: f.dateTime().default('now'),
  updated_at: f.dateTime().default('now').updatedAt(),
}).relate(() => ({
  posts: rel.many('post', { on: 'author_id', refs: 'id' }),
}));

const Post = model('posts', {
  id:        f.id(),
  author_id: f.objectId(),
  title:     f.string(),
  body:      f.text(),
}).relate(() => ({
  author: rel.one('user', { on: 'author_id', refs: 'id', onDelete: 'Cascade' }),
}));

export const schema = { user: User, post: Post } as const;
```

Write `as const` on the schema object. It lets TypeScript read the exact model
and field names, which is what gives you autocomplete and typed results.

### Models and automatic values (id, timestamps)

`model(tableName, fields)` declares a table (or a Mongo collection). The first
argument is the real table name in the database; the object key you give it in
the schema (`user`, `post`) is what you type as `db.user`.

forge fills in three kinds of value for you, so you do not have to:

**Primary key (`f.id()`).** Every model has one. When you create a row without
passing an `id`, forge generates one automatically on **every** database:

```ts
await db.user.create({ data: { email: 'a@x.co', name: 'A' } });  // id is generated
```

The generated id is a **string**: an `ObjectId` on Mongo, and a UUID on
Postgres, MySQL, and SQLite. It is a string (not a sequential number) so the
same model is portable across all four databases. You can still pass your own
`id` if you want to control it, and you can let the database generate it instead
with a UUID default:

```ts
id: f.uuid({ default: 'gen_random_uuid' })   // Postgres/MySQL fill it in server-side
```

(An auto-incrementing integer key is SQL-only and would not work on Mongo, so it
is not built in.)

**Created-at (`f.dateTime().default('now')`).** Set to the current time when the
row is created. You never pass it.

**Updated-at (`f.dateTime().default('now').updatedAt()`).** Set when the row is
created and **automatically bumped to the current time on every update**, on all
four databases. You never pass it.

```ts
const post = await db.post.create({ data: { title: 'Hi' } });
// post.created_at and post.updated_at are both set

await db.post.update({ where: { id: post.id }, data: { title: 'Hello' } });
// updated_at is now refreshed automatically
```

`f.objectId()` is for a column that holds another row's id (a foreign key). On
Mongo it stores an `ObjectId`; on SQL it is plain text.

### Field types

| Builder                              | Type in your code | Notes                                                                 |
| ------------------------------------ | ----------------- | --------------------------------------------------------------------- |
| `f.id()`                             | `string`          | Primary key, auto-generated when omitted (see above).                 |
| `f.objectId()`                       | `string`          | A reference to another row's id (foreign key).                        |
| `f.string()`                         | `string`          | Short text. On MySQL this is `VARCHAR(255)` so it can be indexed.     |
| `f.text()`                           | `string`          | Long text. On MySQL this is `TEXT`.                                   |
| `f.int()`                            | `number`          | 32-bit integer.                                                       |
| `f.float()`                          | `number`          | Floating point number.                                                |
| `f.decimal({ precision, scale })`    | `string`          | Exact numbers like money. Returned as a string so digits are exact.   |
| `f.bigint()`                         | `bigint`          | 64-bit integer.                                                       |
| `f.uuid({ default })`                | `string`          | UUID. Pass `{ default: 'gen_random_uuid' }` for a database default.   |
| `f.bool()`                           | `boolean`         | Stored as 0 or 1 on MySQL and SQLite, decoded back to a boolean.      |
| `f.dateTime()`                       | `Date`            | Timestamp. Accepts a `Date` or an ISO string on input.                |
| `f.json()`                           | `any`             | Arbitrary JSON. `jsonb` on Postgres, `JSON` on MySQL.                 |
| `f.enumOf(['A','B'] as const)`       | `'A' \| 'B'`      | A fixed set of string values, checked by the database.                |
| `f.embed(MyShape)`                   | object            | One nested object. Stored as JSON on SQL, a sub-document on Mongo.    |
| `f.embedMany(MyShape)`               | object[]          | A list of nested objects.                                             |
| `f.stringArray()` / `f.intArray()`   | `string[]` / `number[]` | A list of scalars. A native array on Postgres, JSON elsewhere.  |

### Field modifiers

Chain these onto any field.

```ts
f.string().optional()                 // the value can be null
f.string().unique()                   // a unique index on this column
f.dateTime().default('now')           // default to the current time (created-at)
f.dateTime().default('now').updatedAt()  // set on create and auto-bumped on every update
f.string().default('pending')         // a fixed default value
f.text().searchable()                 // build a full-text index (see Full-text search)
f.dateTime().softDeleteAt()           // mark this as the soft-delete column (see Soft delete)
f.decimal({ precision: 12, scale: 2 }).dbgenerated('price * qty')  // computed by the database
```

### Indexes and unique constraints

Pass an options object as the third argument to `model`.

```ts
const Post = model('posts', {
  id:        f.id(),
  author_id: f.objectId(),
  slug:      f.string().unique(),     // single-column unique
  status:    f.enumOf(['DRAFT', 'PUBLISHED'] as const),
}, {
  indexes: [{ keys: { author_id: 1, status: 1 } }],   // a two-column index
  uniques: [['author_id', 'slug']],                   // a combined unique
});
```

### Relations

A relation says "this model points at that model." You declare it with
`.relate()`, which takes a function returning a map of relation names. There are
two kinds:

* `rel.one(target, { on, refs })` is the side that **holds the foreign key**.
  For example a post has one author, and the post row stores `author_id`.
* `rel.many(target, { on, refs })` is the **other side**, a list. A user has
  many posts. Nothing is stored on the user row; forge looks posts up by their
  `author_id`.

The options mean:

* `target` is the **key in your schema map** of the model you are pointing at
  (`'user'`, not the table name `'users'`).
* `on` is the column that holds the foreign key value.
* `refs` is the column it points to on the other model (usually `'id'`).
* `onDelete` (one-side only) controls what happens to this row when the row it
  points to is deleted: `'Cascade'` (delete this too), `'SetNull'` (clear the
  foreign key), `'Restrict'`, or `'NoAction'`.

```ts
const User = model('users', { id: f.id(), name: f.string() })
  .relate(() => ({
    // a user has many posts; posts find their user via posts.author_id
    posts: rel.many('post', { on: 'author_id', refs: 'id' }),
  }));

const Post = model('posts', { id: f.id(), author_id: f.objectId(), title: f.string() })
  .relate(() => ({
    // a post has one author; the foreign key author_id lives on the post row
    author: rel.one('user', { on: 'author_id', refs: 'id', onDelete: 'Cascade' }),
  }));
```

A model can point at itself, which is how you build trees such as comment
replies:

```ts
const Comment = model('comments', { id: f.id(), parent_id: f.objectId().optional() })
  .relate(() => ({
    parent:  rel.one('comment',  { on: 'parent_id', refs: 'id' }),
    replies: rel.many('comment', { on: 'parent_id', refs: 'id' }),
  }));
```

Once a relation exists you can load it with `include` (see
[Choosing fields](#choosing-fields-select-and-include)) and write related rows
in one call (see [Writing related records](#writing-related-records-in-one-call)).

### Embedded objects

An embedded object is a fixed shape stored inside a row, as JSON on SQL
databases and as a sub-document on Mongo. Use `embed` to declare the shape.

```ts
import { embed, f, model } from 'forge-orm';

const Address = () => embed('Address', {
  street: f.string(),
  city:   f.string(),
  zip:    f.string(),
});

const User = model('users', {
  id:      f.id(),
  name:    f.string(),
  address: f.embed(Address).optional(),       // one address
  history: f.embedMany(Address),              // a list, defaults to []
});

await db.user.create({ data: { name: 'A', address: { street: '1 Main', city: 'SF', zip: '94110' } } });
```

---

## Reading data

Every model has the read methods you expect.

```ts
await db.user.findMany({ where: { active: true }, take: 20 });
await db.user.findFirst({ where: { email: 'a@x.co' } });   // first match or null
await db.user.findUnique({ where: { id: 'u1' } });          // by a unique field
await db.user.count({ where: { active: true } });
await db.user.findFirstOrThrow({ where: { email: 'a@x.co' } });  // throws if missing
```

### Filtering with `where`

`where` accepts either a direct value or an operator object per field, plus
`AND`, `OR`, and `NOT`.

```ts
await db.post.findMany({
  where: {
    status: 'PUBLISHED',                       // equals
    title:  { contains: 'forge' },             // text match
    views:  { gte: 100, lt: 1000 },            // ranges
    author_id: { in: ['u1', 'u2'] },           // any of
    OR: [
      { pinned: true },
      { created_at: { gt: new Date('2024-01-01') } },
    ],
  },
});
```

Available operators:

* All types: `equals`, `not`, `in`, `notIn`.
* Numbers and dates: `lt`, `lte`, `gt`, `gte`.
* Strings: `contains`, `startsWith`, `endsWith`, and `mode: 'insensitive'`.
* List fields: `has`, `hasEvery`, `hasSome`, `isEmpty`.
* Text columns marked `.searchable()`: `search` (see
  [Full-text search](#full-text-search)).

### Choosing fields: `select` and `include`

By default a query returns all of a model's own columns. To change that, use one
of these (you may use one or the other, not both at once):

* `select` returns **only** the fields you list. The result type narrows to match.
* `include` returns all columns **plus** the related records you ask for.

```ts
// only these two fields come back
const slim = await db.user.findMany({ select: { id: true, email: true } });

// the user plus their posts, and each post's comments
const full = await db.user.findFirst({
  where:   { id: 'u1' },
  include: { posts: { include: { comments: true } } },
});

// you can filter and limit an included relation
await db.user.findFirst({
  include: { posts: { where: { status: 'PUBLISHED' }, orderBy: { created_at: 'desc' }, take: 5 } },
});
```

### Sorting and pagination

```ts
await db.post.findMany({
  where:   { status: 'PUBLISHED' },
  orderBy: { created_at: 'desc' },     // or an array for multiple keys
  take:    20,                          // page size
  skip:    40,                          // offset
});

// cursor pagination, for stable paging over large sets
await db.post.findMany({ take: 20, cursor: { id: lastSeenId }, skip: 1 });
```

---

## Writing data

```ts
await db.user.create({ data: { email: 'a@x.co', name: 'A' } });   // id auto-generated

await db.user.createMany({ data: [ /* … */ ] });

await db.user.update({ where: { id: 'u1' }, data: { name: 'A2' } });

await db.user.updateMany({ where: { active: false }, data: { active: true } });

// update if found, otherwise create
await db.user.upsert({
  where:  { email: 'a@x.co' },
  create: { email: 'a@x.co', name: 'A' },
  update: { name: 'A' },
});

await db.user.delete({ where: { id: 'u1' } });
await db.user.deleteMany({ where: { active: false } });
```

Create and update can also return only selected fields or include relations,
the same way reads do, by passing `select` or `include` alongside `data`.

### Number and field updates

For number columns you can apply an operation instead of setting a value
outright:

```ts
await db.post.update({
  where: { id: 'p1' },
  data: {
    views:     { increment: 1 },     // also: decrement, multiply, divide, set
    score:     { multiply: 2 },
    published: true,
  },
});
```

### Writing related records in one call

When you create or update a row you can act on its relations at the same time:

```ts
await db.user.create({
  data: {
    email: 'a@x.co', name: 'A',
    posts: {
      create: { title: 'Hello' },     // create a new related post
      connect: { id: 'p2' },          // attach an existing one
    },
  },
});
```

Supported on a relation: `create`, `createMany`, `connect`, `connectOrCreate`
(find one or make it), `disconnect`, `set`, `delete`, `deleteMany`.

### Deletes and cascades

If a relation declares `onDelete: 'Cascade'`, deleting the parent deletes the
children too. On SQL this is enforced by a foreign key. On Mongo, which has no
foreign keys, forge walks the relations and deletes the children for you.

```ts
await db.user.delete({ where: { id: 'u1' } });   // posts with onDelete:'Cascade' go too
```

---

## Grouping and aggregates

```ts
const byRole = await db.user.groupBy({
  by:     ['role'],
  where:  { active: true },
  _count: { _all: true },
  _avg:   { age: true },
  having: { _count: { id: { gt: 1 } } },
  orderBy:{ role: 'asc' },
});
// [{ role: 'USER', _count: { _all: 42 }, _avg: { age: 31.2 } }, …]
```

---

## Transactions

Run several writes so they all commit together or all roll back.

```ts
await db.$transaction(async (tx) => {
  const user = await tx.user.create({ data: { email: 'a@x.co', name: 'A' } });
  await tx.post.create({ data: { author_id: user.id, title: 'Hi' } });
});
```

If the callback throws, nothing is saved. You can also pass an array of queries
to run together: `await db.$transaction([db.user.findMany(), db.post.count()])`.

On Mongo, transactions need a replica set (a single-node `mongod` cannot run
them), which is the same requirement Prisma has.

**One thing to watch on Postgres:** do not catch a constraint error inside a
transaction and keep going. Postgres marks the whole transaction as failed after
any error, so the next statement fails with "current transaction is aborted."
forge rolls the transaction back cleanly and reports the original error, but the
catch-and-continue pattern will not work. Check first, use `upsert`, or let the
transaction fail and retry it.

---

## Running raw SQL

When you need SQL forge does not express, use the tagged template. Values become
bound parameters, never string-interpolated, so it is safe against injection.

```ts
const rows = await db.$queryRaw`SELECT * FROM users WHERE email = ${email}`;
const affected = await db.$executeRaw`UPDATE users SET active = false WHERE last_seen < ${cutoff}`;
```

This is SQL only. On Mongo, use `db.<model>.aggregate({ pipeline })` instead.

---

## Errors

Constraint and connection failures come back as a `DbKnownError` with a stable
code, so you can branch on the cause regardless of which database you are on.

```ts
import { DbKnownError } from 'forge-orm';

try {
  await db.user.create({ data: { email: 'taken@x.co', name: 'A' } });
} catch (e) {
  if (e instanceof DbKnownError && e.code === 'P2002') {
    // unique constraint violation (here, the email already exists)
  }
}
```

The codes follow Prisma's familiar set (`P2002` unique, `P2003` foreign key,
`P2004` constraint, and so on).

---

## Full-text search

Mark a text column `.searchable()`. When you create the tables, forge builds the
right full-text index for each database (a GIN index on Postgres, a FULLTEXT
index on MySQL, a text index on Mongo, an FTS5 table on SQLite). Then query it
with the `search` operator.

```ts
const Post = model('posts', { id: f.id(), body: f.text().searchable() });

await db.post.findMany({ where: { body: { search: 'database wrapper' } } });
```

---

## Streaming large results

To process a large table without loading it all into memory, use
`findManyStream`. It yields rows one at a time using the driver's native cursor.

```ts
for await (const user of db.user.findManyStream({ where: { active: true } })) {
  await sendEmail(user);   // one row in memory at a time
}
```

---

## Soft delete

Mark a date column `.softDeleteAt()`. After that, `delete` and `deleteMany` do
not remove the row. They set that column to the current time, and reads
automatically skip rows where it is set.

```ts
const Account = model('accounts', { id: f.id(), deleted_at: f.dateTime().softDeleteAt() });

await db.account.delete({ where: { id: 'a1' } });             // sets deleted_at, row stays
await db.account.findMany();                                   // does not return a1
await db.account.findMany({ where: { _withDeleted: true } });  // include soft-deleted rows
```

---

## Views and materialised views

Declare a read-only view with `.asView()`. Writes to it are rejected; reads work
normally.

```ts
const PublishedPosts = model('published_posts', {
  id: f.id(), title: f.string(), author_id: f.objectId(),
}).asView({
  sql: `SELECT id, title, author_id FROM posts WHERE status = 'PUBLISHED'`,
  sourceCollection: 'posts',   // Mongo equivalent
  pipeline: [{ $match: { status: 'PUBLISHED' } }],
});
```

Add `materialised: true` to store the results physically and refresh them on
demand. On Postgres this is a real materialised view; on MySQL and SQLite it is
a table that gets repopulated; on Mongo it is a collection filled by the
pipeline.

```ts
const Stats = model('post_stats', { /* … */ }).asView({ materialised: true, sql, /* … */ });

await db.postStats.refresh();                    // recompute now
const stop = db.postStats.scheduleRefresh('1h'); // recompute hourly; call stop() to cancel
```

---

## Watching queries

Subscribe to every query for logging or metrics. The callback receives the
database, model, operation, SQL, parameters, duration, and row count. There is
no cost when nothing is subscribed.

```ts
const off = db.$on('query', (e) => {
  if (e.duration_ms > 100) console.warn('slow query', e.sql, e.params);
});
db.$on('error', (e) => console.error(e.op, 'failed', e.error.message));
// off();  // stop listening
```

---

## Creating tables and migrations

forge can create your tables from the schema and reconcile changes later. These
run as command-line scripts that read `DATABASE_URL` from the environment:

```sh
forge:push          # create or update tables, indexes, and constraints to match the schema
forge:diff          # report differences between the live database and the schema
forge:diff --json   # the same as machine-readable JSON
forge:diff --check  # exit non-zero if there is drift (useful in CI)
forge:diff:apply    # generate and run a migration that reconciles the difference
forge:rollback      # undo the most recent applied migration
```

### Pointing the CLI at your schema

All four scripts above need to know where your schema module lives. Resolution
order (first hit wins):

1. **`--schema=<path>`** CLI flag — explicit, recommended for CI
2. **`FORGE_SCHEMA_PATH=<path>`** env var — handy when paired with `DATABASE_URL`
3. **Convention paths**, tried in order from `process.cwd()`:
   - `./src/schema.ts`
   - `./src/schema.js`
   - `./schema.ts`
   - `./schema.js`
   - `./src/core/database/schema.ts`
   - `./src/db/schema.ts`
   - `./src/database/schema.ts`

The schema module must export a `schema` constant (or a default export shaped
the same way):

```ts
// src/schema.ts
import { f, model } from 'forge-orm';

export const User = model('users', { … });
export const Post = model('posts', { … });

export const schema = { User, Post } as const;
```

If forge can't find a consumer schema it falls back to its bundled sample with
a loud warning — that path exists so forge's own monorepo tests keep working
and should never trigger in normal consumer use.

TypeScript schemas are loaded with `ts-node` registered in **transpile-only**
mode under the hood, so push runs in milliseconds even on schemas with dozens
of models (no full type-check at push time — the consumer's own build catches
type errors separately).

`forge:diff:apply` writes a timestamped SQL file with an `up` and a `down`
section into a `migrations/` folder and records it in a `_forge_migrations`
table, so applying is repeatable and reversible. Migrations are SQL only; on
Mongo, `forge:push` manages indexes and views.

---

## Dropping to raw queries with `.compile`

If you need the exact query forge would run, ask for it instead of running it.
You get the Mongo arguments object or the SQL string with its parameters, ready
to hand to the driver yourself.

```ts
const q = db.user.compile.findMany({ where: { active: true }, take: 20 });
// SQL:   { sql: 'SELECT … WHERE "active" = $1 LIMIT 20', params: [true] }
// Mongo: { collection: 'users', op: 'find', args: { filter: { active: true }, options: { limit: 20 } } }
```

---

## Type safety

Types come straight from your schema, with no generated client. `db.user` knows
its fields, `where` rejects values of the wrong type, `select` narrows the
result, and `include` returns the related model's shape. Helpers:

```ts
import type { Row, ForgeDb } from 'forge-orm';

type DB   = ForgeDb<typeof schema>;
type User = Row<typeof User>;     // { id: string; email: string; name: string; … }
```

---

## Performance

forge adds a thin layer over the driver. In a local micro-benchmark of simple
operations (find, count, update), its per-call overhead measured similar to,
and often lower than, Prisma and Drizzle, with no separate engine process to
start.

Read that for what it is: a small synthetic test on localhost. The differences
are fractions of a millisecond and disappear next to real network latency and
query complexity. It says nothing about complex joins, correctness, or
maturity. The point is only that the convenience does not cost you measurable
performance. Run `forge:bench` and `forge:bench:compare` to see for yourself.

---

## Testing

The repository's own test suite (run from a clone) has 191 unit tests and 163
live integration tests across all four databases.

```sh
npm run forge:check         # unit tests, type checks, and autocomplete checks (no database needed)
npm run forge:integration   # full CRUD against live Postgres, MySQL, SQLite, and Mongo
npm run forge:bench         # speed against the raw driver
npm run forge:all           # all of the above
```

Each integration run creates a throwaway database and drops it when finished.

---

## Limitations and honest notes

* **It is young.** No long production history, one main author. Treat it as
  early-stage. If a quiet data bug would be costly, test your own queries
  against it thoroughly first.
* **Primary keys are auto-generated strings, not sequential numbers.** forge
  fills in a UUID (or ObjectId on Mongo) when you omit `id`. An
  auto-incrementing integer key is SQL-only and not built in.
* **One schema per process.** `createDb({ schema })` sets the active schema for
  the whole process. That fits one schema per service. For several different
  schemas at once, run them in separate processes.
* **Some nested writes are partial.** Deeply nested `upsert`, `update`, and
  `set` cover the common cases but not every Prisma shape.
* **No GUI, no plugin system.** If you need a data browser or middleware, this
  is not that.

---

## Contributing

The repository is public at https://github.com/johnsonfash/forge-orm. Issues and
pull requests are welcome. To work on it: clone, `npm install`, then
`npm run forge:all` to run the full suite. The code is small and organised by
database adapter under `src/adapters/`, with a shared query layer in `src/ir/`,
so a change to one database rarely touches another.

MIT licensed.
