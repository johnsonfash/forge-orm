# forge-orm

A small, Prisma-shaped data layer for **MongoDB, PostgreSQL, MySQL, and SQLite**.
You write your models once in plain TypeScript and the same query code runs
against any of the four databases. There is no code generation step, no Rust
query engine, and no framework to adopt — just readable TypeScript (around
13,000 lines) over the official drivers, organised one adapter per database.

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
  * [What's new](#whats-new)
* [Install and pick your driver](#install-and-pick-your-driver)
* [Connecting](#connecting)
  * [Pluggable drivers](#pluggable-drivers)
* [Defining a schema](#defining-a-schema)
  * [Models and automatic values (id, timestamps)](#models-and-automatic-values-id-timestamps)
  * [Field types](#field-types)
  * [Field modifiers](#field-modifiers)
  * [Indexes and unique constraints](#indexes-and-unique-constraints)
  * [Relations](#relations)
  * [Embedded objects](#embedded-objects)
* [Reading data](#reading-data)
  * [Filtering with `where`](#filtering-with-where)
    * [Comparing two columns: `col()`](#comparing-two-columns-col)
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
  * [Row + db helpers](#row--db-helpers)
  * [Direct-from-model inference (`Infer*`)](#direct-from-model-inference-infer)
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

forge is **not** a replacement for Prisma or Drizzle in maturity. It has fewer
features, a smaller ecosystem, and no GUI. If you need those, use Prisma or
Drizzle. The [honest notes](#limitations-and-honest-notes) at the end spell
this out.

### What's new

Full release history is in [CHANGELOG.md](./CHANGELOG.md). Recent highlights:

- **1.9 — pluggable MySQL + Mongo.** MySQL adds `mariadbDriver` and
  `planetscaleDriver` alongside the default `mysql2`; Mongo lets you bring your
  own `MongoClient` (`mongoDriver`) for DocumentDB / Cosmos / FerretDB / custom
  options. All four databases are now pluggable. (Also fixed a latent bug: a
  `col()`/non-eq guard on a MySQL `update`/`delete` referenced IR internals as
  columns.) See [Pluggable drivers](#pluggable-drivers).
- **1.8 — pluggable Postgres drivers.** Use `postgres.js` (porsager) instead of
  `node-postgres`, or any client you wrap, via `createDb({ driver: postgresJsDriver(...) })`.
  Same port idea as 1.7. See [Pluggable drivers](#pluggable-drivers).
- **1.7 — pluggable SQLite drivers.** Run forge in React Native (`expo-sqlite`,
  `op-sqlite`), on the edge / Turso (`libsql`), or over any driver you wrap —
  not just Node's `better-sqlite3`. Pass `createDb({ driver })`; everything
  routes through one normalized async port. See
  [Pluggable drivers](#pluggable-drivers).
- **1.6 — richer aggregates.** `groupBy`'s `having` now accepts both Prisma's
  field-first shape (`{ total: { _sum: { gte: 1 } } }`) **and** the bucket-first
  shape (`{ _sum: { total: { gte: 1 } } }`), and `count({ distinct: [...] })` is
  fixed on MongoDB (it now counts distinct combinations, matching the SQL
  dialects). See [Grouping and aggregates](#grouping-and-aggregates).
- **1.5 — `col()` for field-to-field comparison.** Compare one column against
  another inside a `where` (`{ currentUsage: { lt: col('globalLimit') } }`),
  portable across every dialect — Mongo `$expr`, SQL `a <op> b`. This makes an
  atomic, race-safe guarded counter expressible through the normal `update()`
  API. See [Comparing two columns](#comparing-two-columns-col). (1.5.1 also
  fixed a `findOneAndUpdate` result-unwrap bug that affected `update()` on
  models with a field literally named `value`.)
- **1.4 — primary-key strategies on `f.id()`** (`auto` / `uuid` / `bigserial`).
  SQL-only services can pick a classic auto-incrementing integer PK without raw
  DDL; UUIDs and ObjectIds are unchanged. See
  [Picking a primary-key strategy](#picking-a-primary-key-strategy).

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

### Pluggable drivers

All four databases ship a sensible default driver, and all four let you swap in
another client — for React Native, edge/serverless runtimes, or a managed /
API-compatible backend. Instead of a URL you open the client yourself (you own
its config and lifecycle), wrap it with one of forge's driver factories, and
pass it as `driver`. The query API is identical whichever client backs it.

```ts
const db = await createDb({ schema, driver: someDriver(client) });   // no url needed
```

Built-in drivers:

| Database  | Default driver                            | Built-in alternatives                                                                 |
| --------- | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| SQLite    | `betterSqlite3Driver` (`better-sqlite3`)  | `expoSqliteDriver` (Expo/RN), `opSqliteDriver` (bare RN), `libsqlDriver` (libsql/Turso/edge) |
| Postgres  | `pgDriver` (`pg`)                          | `postgresJsDriver` (`postgres.js`)                                                     |
| MySQL     | `mysql2Driver` (`mysql2`)                  | `mariadbDriver` (MariaDB connector), `planetscaleDriver` (`@planetscale/database`)     |
| MongoDB   | built-in `mongodb` client                 | `mongoDriver(client)` — your own `MongoClient` (DocumentDB, Cosmos, FerretDB, custom)  |

```ts
// SQLite on Expo / React Native
import * as SQLite from 'expo-sqlite';
import { createDb, expoSqliteDriver } from 'forge-orm';
const db = await createDb({ schema, driver: expoSqliteDriver(SQLite.openDatabaseSync('app.db')) });

// SQLite on the edge / Turso
import { createClient } from '@libsql/client';
import { createDb, libsqlDriver } from 'forge-orm';
const db = await createDb({ schema, driver: libsqlDriver(createClient({ url: process.env.TURSO_URL! })) });

// Postgres via postgres.js
import postgres from 'postgres';
import { createDb, postgresJsDriver } from 'forge-orm';
const db = await createDb({ schema, driver: postgresJsDriver(postgres(process.env.DATABASE_URL!)) });

// MySQL via the MariaDB connector (pass bigIntAsNumber/insertIdAsNumber for mysql2 parity)
import mariadb from 'mariadb';
import { createDb, mariadbDriver } from 'forge-orm';
const pool = mariadb.createPool({ host, user, database, bigIntAsNumber: true, insertIdAsNumber: true });
const db = await createDb({ schema, driver: mariadbDriver(pool) });

// MongoDB with your own client (custom TLS/auth/pool options, a shared client,
// or a Mongo-API backend: Amazon DocumentDB, Azure Cosmos DB, FerretDB)
import { MongoClient } from 'mongodb';
import { createDb, mongoDriver } from 'forge-orm';
const db = await createDb({ schema, driver: mongoDriver(new MongoClient(uri, { tls: true }), 'mydb') });
```

Each port is a small interface, so any other client fits too:

* **SQLite** (`SqliteDriver`) — `all`, `get`, `run`, `exec`, `close`, optional `iterate`.
* **Postgres** (`PostgresDriver`) / **MySQL** (`MysqlDriver`) — `query` + `transaction` + `close`, optional `stream`.
* **MongoDB** (`MongoDriver`) — a pre-built `MongoClient` (plus an optional database name).

One caveat: `forge push` / `applyMigration` (DDL) still assume each database's
**default** driver. With an injected driver, run runtime queries through forge
and manage schema/DDL with the default client (or separately).

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

`as const` on the schema object is **defensive, not required**. For the
pattern shown above — each model bound to its own `const`, then referenced
from the schema literal — TypeScript already preserves the model types and
the literal keys, so `db.user.findFirst({ where: { … } })` autocompletes
either way.

Why we still suggest writing it:

- It future-proofs the call site if you ever inline a model literal or add a
  string discriminator next to the models (string literals widen to `string`
  without `as const`).
- It keeps the schema readable as a fixed set of keys for downstream tooling
  that does `keyof typeof schema`.
- It costs nothing.

The library's `SchemaShape` accepts both mutable and readonly schemas — so
omitting `as const` won't change what types you get for `db.*` accessors or
for `Row<typeof User>` / `InferCreate<typeof Post>`. It's a habit, not a
load-bearing token.

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

The default id is a **string**: an `ObjectId` on Mongo, and a UUID on
Postgres, MySQL, and SQLite. It's a string (not a sequential number) so the
same model is portable across all four databases. You can still pass your own
`id` if you want to control it, and you can let the database generate it
instead with a UUID default:

```ts
id: f.uuid({ default: 'gen_random_uuid' })   // Postgres/MySQL fill it in server-side
```

#### Picking a primary-key strategy

If you want something other than the default, pass `f.id({ type })`:

```ts
id: f.id()                            // default — app-generated string id (string in TS)
id: f.id({ type: 'auto' })            // same as the default; explicit form
id: f.id({ type: 'uuid' })            // DB-typed UUID column (PG `uuid`, MySQL `CHAR(36)`)
id: f.id({ type: 'bigserial' })       // auto-incrementing integer PK — number in TS
```

What each one emits per dialect:

| Strategy     | Postgres                       | MySQL                              | SQLite                                  | Mongo            | JS type  |
| ------------ | ------------------------------ | ---------------------------------- | --------------------------------------- | ---------------- | -------- |
| `auto` (default) | `text`                     | `VARCHAR(64)`                      | `TEXT`                                  | `ObjectId`       | `string` |
| `uuid`       | `uuid`                         | `CHAR(36)`                         | `TEXT`                                  | (same as `auto`) | `string` |
| `bigserial`  | `BIGSERIAL`                    | `BIGINT NOT NULL AUTO_INCREMENT`   | `INTEGER PRIMARY KEY AUTOINCREMENT`     | **throws at push** | `number` |

`bigserial` is the SQL-only opt-in. Forge runs `forge push` on Mongo with a
clear error if you use it (`'bigserial' has no Mongo equivalent`), so a
schema mistake fails fast instead of half-applying. Use it when you're
running a SQL-only service and you want classic integer keys; stay on
`auto` or `uuid` for cross-DB portability.

With `bigserial`, the DB assigns the id — you don't pass one at create time,
and `Row<typeof Model>['id']` is typed as `number`:

```ts
// 1. declare it in your schema
const Order = model('orders', {
  id:     f.id({ type: 'bigserial' }),    // PG fills with nextval, MySQL with AUTO_INCREMENT, SQLite with the rowid alias
  total:  f.int(),
});
```

```sh
# 2. push the schema to your database
npx forge push
# emits the right DDL per dialect; on Mongo this errors with a clear message
```

```ts
// 3. use it from the typed client
const o = await db.order.create({ data: { total: 5_000 } });
o.id;          // ✓ number — TypeScript knows
await db.order.findFirst({ where: { id: 47 } });
```

Adding `bigserial` to an existing table? `forge diff` shows you the column
change before you push, and `forge diff apply` writes a timestamped
reconciliation migration if you'd rather review the SQL first.

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
| `f.id()`                             | `string`          | Primary key, auto-generated when omitted. Pass `{ type: 'uuid' \| 'bigserial' }` to switch strategy. |
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

#### Comparing two columns: `col()`

Use `col('otherField')` on the right-hand side of `equals`/`not`/`lt`/`lte`/
`gt`/`gte` to compare one column against another column **of the same row**,
instead of against a literal. It works the same on every dialect — Mongo
compiles it to `$expr`, SQL to a plain `a <op> b`.

```ts
import { col } from 'forge-orm';

// promos still under their global cap
await db.promo.findMany({
  where: { currentUsage: { lt: col('globalLimit') } },
});

// the canonical use: an atomic, race-safe guarded counter
await db.promo.update({
  where: { id, currentUsage: { lt: col('globalLimit') } },   // only if room remains
  data:  { currentUsage: { increment: 1 } },                 // single atomic write
});
```

`col()` only accepts the six comparison operators, and the referenced field
must be a real scalar column (a typo or relation name throws at build time).

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

`groupBy` aggregates rows by one or more columns. Each result row carries the
grouped columns plus the aggregate buckets you ask for: `_count`, `_sum`,
`_avg`, `_min`, `_max`. `_count._all` is `COUNT(*)`; per-column counts go in
`_count.<col>`.

```ts
const byStatus = await db.order.groupBy({
  by:      ['status'],
  where:   { channel: 'web' },          // filter rows BEFORE grouping
  _count:  { _all: true },
  _sum:    { total: true },
  _avg:    { total: true },
  _min:    { total: true },
  _max:    { total: true },
  orderBy: { status: 'asc' },
});
// [{ status: 'paid', _count: { _all: 3 }, _sum: { total: 600 }, _avg: { total: 200 }, … }, …]
```

`having` filters the **groups** after aggregation. It accepts both Prisma's
field-first shape and the bucket-first shape — they mean the same thing:

```ts
having: { total: { _sum: { gte: 120 } } }   // field-first (Prisma)
having: { _sum: { total: { gte: 120 } } }   // bucket-first
```

### Distinct

`distinct` on `findMany` returns one row per distinct value-combination of the
listed columns; on `count` it counts those combinations.

```ts
await db.order.findMany({ distinct: ['status'] });    // one row per status
await db.order.count({ distinct: ['channel'] });      // how many distinct channels
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

forge can create your tables from the schema and reconcile changes later. After
installing `forge-orm`, the `forge` binary is on your `PATH` via `npx`:

```sh
npx forge push                              # create or update tables, indexes, and constraints to match the schema
npx forge diff                              # report differences between the live database and the schema
npx forge diff --json                       # the same as machine-readable JSON
npx forge diff --check                      # exit non-zero if there is drift (useful in CI)
npx forge diff --ignore=logs,/^_atlas_/i    # skip noisy meta-collections (see "Ignoring drift" below)
npx forge diff apply                        # generate and run a migration that reconciles the difference
npx forge rollback                          # undo the most recent applied migration
npx forge doctor                            # adapter pre-flight checks
npx forge --help
```

`DATABASE_URL` is read from your `.env` or environment.

### Ignoring drift on `forge diff`

The migration ledger (`_forge_migrations`) and engine-generated FTS shadows
(`*_fts`) are always skipped. Anything else you want hidden from the report —
Atlas metadata, system collections, tables managed by a sibling service — goes
through `--ignore=` or the `FORGE_DIFF_IGNORE` env var:

```sh
# exact names + a regex pattern, comma-separated
npx forge diff --ignore=sessions,logs,/^_atlas_/i

# env var works the same way; CLI flag stacks on top
export FORGE_DIFF_IGNORE='/^_/i,external_events'
npx forge diff
```

Patterns wrapped in `/.../flags` are treated as regex; everything else is an
exact-match string. Ignored tables are summarised at the end of the report
(`ignored 2 tables: logs, sessions`) so silent filtering can't hide real drift.

### Pointing the CLI at your schema

forge resolves the consumer's schema through a layered cascade — explicit
pointers first, with a one-time filesystem scan as the zero-config fallback.
First hit wins:

1. **`--schema=<path>`** CLI flag (zero ms)
2. **`FORGE_SCHEMA_PATH=<path>`** env var (zero ms)
3. **`package.json` config**:
   ```json
   { "forge": { "schema": "./src/your-schema.ts" } }
   ```
4. **Cached scan result** at `node_modules/.cache/forge/schema-cache.json` —
   instant on every run after the first.
5. **Filesystem scan** — walks your project tree, finds the file that imports
   from `forge-orm` and exports a `schema` const. Skips `node_modules`,
   `dist`, `build`, `.git`, `.next`, `coverage`, `.cache`, `.turbo`,
   `.svelte-kit`, `.nuxt`, `.parcel-cache`, `.vercel`, `.netlify`, `out`,
   `.output`, `.idea`, `.vscode`, `*.test.*` files, `__tests__/`, `__mocks__/`,
   and `fixtures/`. Sub-300 ms on a real 10k-file project — a cache write at
   the end makes subsequent runs free.
6. **Hard fail** if nothing matches, with an actionable error message listing
   every layer that was tried.

The schema module must export a `schema` constant (or a default export shaped
the same way):

```ts
// src/schema.ts — name and location are up to you
import { f, model } from 'forge-orm';

export const User = model('users', { … });
export const Post = model('posts', { … });

export const schema = { User, Post } as const;
```

If the scan finds more than one candidate (e.g. a real schema + a fixture
schema in `examples/`), forge prints both paths and asks you to disambiguate
via `package.json` or `--schema=`.

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
result, and `include` returns the related model's shape.

### Row + db helpers

```ts
import type { Row, ForgeDb } from 'forge-orm';

type DB   = ForgeDb<typeof schema>;
type User = Row<typeof User>;     // { id: string; email: string; name: string; … }
```

### Direct-from-model inference (`Infer*`)

When you want a create/update/where shape for a service signature, DTO,
validation layer, or anywhere else outside `db.*`, take it straight from
the model — no codegen, no `SchemaMap` registration, no detour through
`ForgeOf<'key'>`. Pass `typeof MyModel` to any `Infer*` alias:

```ts
import { f, model, rel } from 'forge-orm';
import type {
  Infer, InferCreate, InferUpdate, InferWhere, InferRow,
  InferOrderBy, InferSelect, InferInclude, InferSchema,
} from 'forge-orm';

const User = model('users', {
  id:    f.id(),
  email: f.string().unique(),
  name:  f.string().optional(),
  age:   f.int().optional(),
});

type UserRow    = InferRow<typeof User>;
//   { id: string; email: string; name: string | null; age: number | null }
type UserCreate = InferCreate<typeof User>;
//   { id?: string; email?: string; name?: string | null; age?: number | null; … relations }
type UserUpdate = InferUpdate<typeof User>;
//   plain values + atomic ops on numbers: { age: { increment: 1 } }
type UserWhere  = InferWhere<typeof User>;
//   field filters + AND / OR / NOT
type UserOrder  = InferOrderBy<typeof User>;
//   { createdAt: 'desc' }

// One bundle of everything for a single model:
type UserT = Infer<typeof User>;
//   { Row, Where, WhereUnique, Create, Update, Upsert, OrderBy, Select, Include, Omit }

function createUser(data: UserT['Create']) { /* … */ }
function findUser(where: UserT['Where']):   Promise<UserT['Row'][]> { /* … */ }
```

For relation-aware `Select` / `Include`, pass the schema map as the second
generic so the helper can walk the relation graph:

```ts
const schema = { user: User, post: Post } as const;
type Types = InferSchema<typeof schema>;

type PostSelect = Types['post']['Select'];
// { id?: boolean; title?: boolean; author?: boolean | { select: { … } } }

type UserInclude = Types['user']['Include'];
// { posts?: boolean | { where: …, take: number, … } }
```

`Infer<typeof M>` works on any `TypedModel` returned by `model(...)` — you
don't have to wire it into a schema map first, you don't have to call
`setActiveSchema`, and you don't need a build step. Add a field to the
model and every `Infer*` derived from it updates on save.

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

The repository's own test suite (run from a clone) has 260 unit tests and 164
live integration scenarios across all four databases, plus dedicated regression
scripts (e.g. `regression-mongo-value-field.ts`, `regression-groupby-distinct.ts`)
wired into the Mongo integration run.

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
