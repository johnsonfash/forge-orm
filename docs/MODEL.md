# Defining models

The deep-dive on `model()` + `f.*`. The [`Defining a schema`](../README.md#defining-a-schema)
chapter in the README is the surface — the field-type table, the modifier
table, the id-strategy summary. This file goes one level down: every field
kind with its dialect quirks, every modifier, the default-kind matrix, the
id-strategy DDL per dialect, generated columns, views, schema namespacing,
and five fully-worked schemas the README can't fit.

Related deep-dives:

* [QUERIES.md](./QUERIES.md) — `where`, `orderBy`, `select`/`include`.
* [TYPES.md](./TYPES.md) — what `Row<typeof Model>` resolves to.
* [JSON-PATH.md](./JSON-PATH.md) — querying inside `f.json()` / `f.embed()`.
* [GEO.md](./GEO.md) and [VECTOR.md](./VECTOR.md) — the spatial / vector field families in full.
* [FTS.md](./FTS.md) — what `.searchable()` builds.
* [MIGRATIONS.md](./MIGRATIONS.md) — turning a schema into DDL.
* [BROWSER.md](./BROWSER.md#dbmigrate--runtime-ddl-apply--drift-detection) — runtime DDL apply in the browser.

---

## Contents

* [The shape of a model](#the-shape-of-a-model)
* [Full field-type catalogue](#full-field-type-catalogue)
  * [Identifiers — `f.id()` and `f.objectId()`](#identifiers--fid-and-fobjectid)
  * [Strings — `f.string()`, `f.text()`, `f.uuid()`](#strings--fstring-ftext-fuuid)
  * [Numbers — `f.int()`, `f.float()`, `f.bigint()`, `f.decimal()`](#numbers--fint-ffloat-fbigint-fdecimal)
  * [Boolean and dateTime](#boolean-and-datetime)
  * [`f.enumOf(...)`](#fenumof)
  * [`f.json()`](#fjson)
  * [`f.embed()` and `f.embedMany()`](#fembed-and-fembedmany)
  * [`f.stringArray()` and `f.intArray()`](#fstringarray-and-fintarray)
  * [`f.geoPoint()`](#fgeopoint)
  * [`f.vector()`](#fvector)
* [Id strategies](#id-strategies)
* [Field modifiers](#field-modifiers)
* [Default kinds](#default-kinds)
* [Enums](#enums)
* [Composite uniques and named indexes](#composite-uniques-and-named-indexes)
* [Views and materialised views](#views-and-materialised-views)
* [Generated / computed columns](#generated--computed-columns)
* [Schema namespacing](#schema-namespacing)
* [Five complete worked schemas](#five-complete-worked-schemas)
* [Schema evolution](#schema-evolution)
* [Common mistakes](#common-mistakes)

---

## The shape of a model

`model(collection, fields, options?)` is the only entry point. `collection`
is the real table name (or Mongo collection); `fields` is a record of field
builders; relations attach via the chained `.relate(() => …)` call.

```ts
import { f, model, rel } from 'forge-orm';

const User = model('users', {
  id:    f.id(),
  email: f.string().unique(),
  name:  f.string(),
}).relate(() => ({
  posts: rel.many('post', { on: 'author_id', refs: 'id' }),
}));
```

What you can pass in `options`:

| Option | Shape | Meaning |
|---|---|---|
| `relations` | `() => Record<string, RelationDef>` | Same as `.relate(() => …)` — pick one. The chained form composes better when models reference each other. |
| `indexes` | `IndexDef[]` | Named or composite indexes. See [Composite uniques and named indexes](#composite-uniques-and-named-indexes). |
| `uniques` | `string[][]` | Composite uniques — sugar for `indexes` with `unique: true`. |

After construction, three side calls are available:

* `.relate(() => rels)` — declare relations (separate from the field map to break TS inference cycles).
* `.asView({ sql | pipeline, materialised?, refreshEvery? })` — turn the model into a view. See [Views and materialised views](#views-and-materialised-views).

`as const` on the `schema` literal is defensive — TypeScript already preserves
the model types when each model is bound to its own `const` first.

---

## Full field-type catalogue

Every kind in `src/schema/types.ts` (`FieldKind`) and its builder in
`src/schema/core.ts`. For each: the TS shape, the declaration, the storage
per dialect, and a one-line "use when".

### Identifiers — `f.id()` and `f.objectId()`

**`f.id()`** — the primary key. Always present on every model. Default
strategy is `auto`: the wrapper generates an app-side id at create time
(ObjectId on Mongo, UUID on SQL) so the same `db.x.create({ data: { … } })`
call works against every adapter without round-tripping the DB for the id.

```ts
id: f.id()                        // string in TS
id: f.id({ type: 'auto' })        // same — explicit
id: f.id({ type: 'uuid' })        // DB-typed UUID column, server-side default on PG/MySQL
id: f.id({ type: 'bigserial' })   // auto-incrementing integer, JS type becomes number
```

Full per-dialect DDL is in [Id strategies](#id-strategies).

**`f.objectId()`** — foreign-key style. Holds another row's id; the
ergonomics match Prisma's "scalar FK alongside a relation". On Mongo it
stores a real `ObjectId`; on SQL it's plain text (matches what `f.id()`
emits with the default `auto` strategy).

```ts
author_id: f.objectId(),
```

| Dialect | `f.id()` default | `f.objectId()` |
|---|---|---|
| PG | `text` PK | `text` |
| MySQL | `VARCHAR(64)` PK | `VARCHAR(64)` |
| SQLite | `TEXT` PK | `TEXT` |
| DuckDB | `TEXT` PK | `TEXT` |
| MSSQL | `NVARCHAR(64)` PK | `NVARCHAR(64)` |
| Mongo | `_id` (`ObjectId`) | `ObjectId` |

Use `f.objectId()` for FKs in cross-DB code. Use `f.id()` only for the row's
own primary key — there's one per model.

### Strings — `f.string()`, `f.text()`, `f.uuid()`

```ts
name:        f.string(),           // short text — indexable on every dialect
body:        f.text(),             // long text — TEXT/NVARCHAR(MAX); no length cap
external_id: f.uuid(),             // UUID — typed column where the dialect has one
external_id: f.uuid({ default: 'gen_random_uuid' }),  // server-side default on PG/MySQL
```

| Builder | TS | PG | MySQL | SQLite | DuckDB | MSSQL | Mongo |
|---|---|---|---|---|---|---|---|
| `f.string()` | `string` | `text` | `VARCHAR(255)` | `TEXT` | `TEXT` | `NVARCHAR(255)` | string |
| `f.text()` | `string` | `text` | `TEXT` | `TEXT` | `TEXT` | `NVARCHAR(MAX)` | string |
| `f.uuid()` | `string` | `uuid` | `CHAR(36)` | `TEXT` | `TEXT` | `UNIQUEIDENTIFIER` | UUID |

**Use when:**

* `f.string()` — anything you'd index, search, or constrain unique (emails, slugs, SKUs).
* `f.text()` — long unbounded prose; descriptions, comments, article bodies. Can't be `UNIQUE` on MySQL without a key length, so don't pair `.unique()` with `f.text()` on MySQL — use `f.string()` instead.
* `f.uuid()` — a column that genuinely is a UUID (external system id, idempotency key). For the row's own PK use `f.id({ type: 'uuid' })` instead so the wrapper knows it's the primary key.

### Numbers — `f.int()`, `f.float()`, `f.bigint()`, `f.decimal()`

```ts
qty:    f.int(),
weight: f.float(),
views:  f.bigint(),                      // bigint literal: 1n
price:  f.decimal({ precision: 12, scale: 2 }),
```

| Builder | TS | PG | MySQL | SQLite | DuckDB | MSSQL | Mongo |
|---|---|---|---|---|---|---|---|
| `f.int()` | `number` | `integer` | `INT` | `INTEGER` | `INTEGER` | `INT` | `Number` (int32) |
| `f.float()` | `number` | `double precision` | `DOUBLE` | `REAL` | `DOUBLE` | `FLOAT` | `Number` (double) |
| `f.bigint()` | `bigint` | `bigint` | `BIGINT` | `INTEGER` | `BIGINT` | `BIGINT` | `Long` |
| `f.decimal({p,s})` | `string` | `numeric(p,s)` | `DECIMAL(p,s)` | `NUMERIC` | `DECIMAL(p,s)` | `DECIMAL(p,s)` | `Decimal128` |

**Use when:**

* `f.int()` — counts, small numerics, foreign keys that genuinely fit in 32 bits.
* `f.float()` — measurements where rounding is acceptable.
* `f.bigint()` — counters at scale (view counts, byte counts). JS type is `bigint`; use `1n` literals.
* `f.decimal()` — money, exact-numeric. Returned as a string to avoid float-precision loss; pass strings on write too (`{ price: '19.99' }`). SQLite stores `NUMERIC` but ignores precision/scale — exact-numeric on SQLite is best-effort.

### Boolean and dateTime

```ts
active:     f.bool(),
created_at: f.dateTime().default('now'),
updated_at: f.dateTime().default('now').updatedAt(),
```

| Builder | TS | PG | MySQL | SQLite | DuckDB | MSSQL | Mongo |
|---|---|---|---|---|---|---|---|
| `f.bool()` | `boolean` | `boolean` | `TINYINT(1)` (0/1) | `INTEGER` (0/1) | `BOOLEAN` | `BIT` | `Boolean` |
| `f.dateTime()` | `Date` | `timestamptz` | `DATETIME(3)` | `TEXT` (ISO) | `TIMESTAMP` | `DATETIME2` | `Date` (`ISODate`) |

`f.dateTime()` accepts `Date` or an ISO string on input; reads always return
a `Date`. SQLite stores timestamps as ISO text since SQLite has no native
timestamp type. The `.default('now')` form drives `created_at`; chained
`.updatedAt()` is what the wrapper bumps on every update — that bump is
applied in TypeScript before the write, so it's identical across every
adapter rather than relying on dialect-specific `ON UPDATE` triggers.

**Use when:**

* `f.bool()` — anything boolean. Don't roll your own `int` flag.
* `f.dateTime()` — `created_at`, `updated_at`, scheduled-at, soft-delete column.

### `f.enumOf(...)`

A fixed set of string literals. The TS type is the union of the literals.

```ts
status: f.enumOf(['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const),
```

| Dialect | DDL |
|---|---|
| PG | `CREATE TYPE x AS ENUM (...)` + column typed as the enum |
| MySQL | `ENUM('DRAFT','PUBLISHED','ARCHIVED')` |
| SQLite | `TEXT CHECK (col IN ('DRAFT','PUBLISHED','ARCHIVED'))` |
| DuckDB | `TEXT CHECK (...)` |
| MSSQL | `NVARCHAR(64) CHECK (...)` |
| Mongo | string, no constraint (validation rides on the TS type) |

See [Enums](#enums) for the adding-and-removing-values story.

**Use when:** the column's values are a closed set that rarely changes.
Open-ended categorical data is better as a small lookup table with an FK.

### `f.json()`

```ts
meta: f.json(),
```

| Dialect | Storage |
|---|---|
| PG | `jsonb` |
| MySQL | `JSON` |
| SQLite | `TEXT` (parsed as JSON on read) |
| DuckDB | `JSON` |
| MSSQL | `NVARCHAR(MAX)` |
| Mongo | sub-document |

JSON path queries (`where: { meta: { path: 'profile.age', gte: 18 } }`)
work uniformly across all six — see [JSON-PATH.md](./JSON-PATH.md).

**Use when:** the shape is genuinely heterogeneous, the rows have wildly
different keys, or you want to keep extra payload without growing the
column count. If the shape is fixed and known, prefer `f.embed()` —
queries inside it stay typed.

### `f.embed()` and `f.embedMany()`

A nested object whose shape is part of the schema. Embeds are themselves
small models built with the same `Field` map.

```ts
import { f, embed, model } from 'forge-orm';

const Address = () => embed('Address', {
  line1:    f.string(),
  city:     f.string(),
  country:  f.string(),
  postcode: f.string().optional(),
});

const Customer = model('customers', {
  id:       f.id(),
  name:     f.string(),
  shipping: f.embed(Address),         // single nested object
  invoices: f.embedMany(Address),     // list of nested objects, defaults to []
});
```

| Builder | TS | PG / MySQL / SQLite / DuckDB / MSSQL | Mongo |
|---|---|---|---|
| `f.embed(Shape)` | `Shape` | JSON column | sub-document |
| `f.embedMany(Shape)` | `Shape[]` (defaults to `[]`) | JSON column | array of sub-documents |

The embed thunk is lazy: `() => embed('Address', { … })`. That lets two
embeds reference each other and lets the embed live in a separate file.

**Use when:** the shape is fixed and you want path queries to stay typed.
Embedded path queries autocomplete (`where: { shipping: { path: 'country', equals: 'NG' } }`).

### `f.stringArray()` and `f.intArray()`

Lists of scalars.

```ts
tags:    f.stringArray(),
weights: f.intArray(),
```

| Dialect | Storage |
|---|---|
| PG | native `text[]` / `integer[]` |
| MySQL | `JSON` |
| SQLite | `TEXT` (JSON-encoded) |
| DuckDB | `VARCHAR[]` / `INTEGER[]` |
| MSSQL | `NVARCHAR(MAX)` (JSON) |
| Mongo | native array |

`has`, `hasEvery`, `hasSome`, `isEmpty` filters all work cross-dialect.

**Use when:** the list is short, the items are scalars, and you don't need
to join against them. If you need to join (find every product tagged
`'sale'`), model tags as a separate table.

### `f.geoPoint()`

2D (or 3D) geographic point. WGS84 / SRID 4326 by default. JS-side shape
is `{ lng, lat }` (or `{ lng, lat, alt }` when `dims: 3`).

```ts
location: f.geoPoint(),
location: f.geoPoint({ srid: 3857 }),          // non-WGS84, declared at DDL time
location: f.geoPoint({ dims: 3 }),             // XYZ — altitude round-trips
location: f.geoPoint({ fallback: true }),      // JSON storage + Haversine when no extension
```

| Dialect | Storage |
|---|---|
| PG | `geography(Point, 4326)` (PostGIS) |
| MySQL | `POINT NOT NULL SRID 4326` (8.0+) |
| SQLite | SpatiaLite geometry (or JSON with `fallback: true`) |
| DuckDB | `GEOMETRY` (spatial extension; auto-loaded) |
| MSSQL | `GEOGRAPHY` (built-in) |
| Mongo | GeoJSON Point as JSON |

Pair with `indexes: [{ keys: { location: 1 }, method: 'spatial' }]` to opt
into the dialect's spatial index family. Distance ops (`near`, `nearTo`,
`withinPolygon`) are 2D-on-sphere on every dialect. See [GEO.md](./GEO.md).

**Use when:** "find places near here" workloads. Don't store lat/lng as two
floats — you lose the spatial index path.

### `f.vector()`

Dense numeric vector for embeddings / semantic search.

```ts
embedding: f.vector(1536, { metric: 'cosine' }),
```

| Dialect | Storage | Index |
|---|---|---|
| PG | `vector(N)` (pgvector) | HNSW / IVFFlat |
| MySQL | `VECTOR(N)` (9.0+; community = brute-force only) | n/a |
| SQLite | JSON + `sqlite-vec` virtual table | `sqlite-vec` |
| DuckDB | `FLOAT[N]` | vss HNSW |
| MSSQL | `VECTOR(N)` (SQL Server 2025 / Azure SQL) | built-in |
| Mongo | plain array | Atlas Vector Search index |

Pair with `indexes: [{ keys: { embedding: 1 }, method: 'vector' }]` to opt
into the dialect's vector index family. `metric` is `'cosine'` (default),
`'l2'`, or `'dot'`. See [VECTOR.md](./VECTOR.md).

**Use when:** semantic search, retrieval-augmented generation, similarity
nearest-neighbour lookups.

---

## Id strategies

The primary-key matrix in the README is the summary. The full per-dialect
DDL, the JS-side type, and what the wrapper does at create time:

| Strategy | JS type | Generated by | Pass at create? |
|---|---|---|---|
| `auto` (default) | `string` | App (ObjectId on Mongo, UUID on SQL) | Optional |
| `uuid` | `string` | DB on PG/MySQL; app on SQLite/Mongo | Optional |
| `bigserial` | `number` | DB (always) | Never |
| `objectId` (via `f.objectId()` on a non-id column) | `string` | n/a — it's an FK, not a PK | Required for the FK side |
| `custom` (any other column marked `unique`) | whatever the column type is | App | Required |

Four worked id strategies and the DDL they produce:

**(1) Default `auto` — portable across every adapter**

```ts
const User = model('users', { id: f.id(), email: f.string().unique() });
```

* PG: `CREATE TABLE "users" ("id" text PRIMARY KEY, "email" text NOT NULL UNIQUE)`
* MySQL: `CREATE TABLE users (id VARCHAR(64) PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE)`
* SQLite: `CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE)`
* MSSQL: `CREATE TABLE [users] ([id] NVARCHAR(64) NOT NULL PRIMARY KEY, [email] NVARCHAR(255) NOT NULL UNIQUE)`
* Mongo: `_id` is the existing `ObjectId`. `email` gets a unique index.

`db.user.create({ data: { email: 'a@x.co' } })` works without an id — the
wrapper generates a 24-hex ObjectId on Mongo, a UUID v4 elsewhere.

**(2) `type: 'uuid'` — typed UUID column with a server-side default**

```ts
const Token = model('tokens', { id: f.id({ type: 'uuid' }) });
```

* PG: `CREATE TABLE "tokens" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid())`
* MySQL: `CREATE TABLE tokens (id CHAR(36) PRIMARY KEY DEFAULT (UUID()))`
* SQLite: same shape as `auto` — SQLite has no UUID type and no built-in UUID generator. The wrapper still generates the id app-side.
* MSSQL: `CREATE TABLE [tokens] ([id] UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID())`
* Mongo: ignored — still `ObjectId`. Pass `{ idType: 'uuid' }` only for SQL-only services.

**(3) `type: 'bigserial'` — auto-incrementing integer (SQL-only)**

```ts
const Order = model('orders', { id: f.id({ type: 'bigserial' }), total: f.int() });
```

* PG: `CREATE TABLE "orders" ("id" BIGSERIAL PRIMARY KEY, "total" integer NOT NULL)`
* MySQL: `CREATE TABLE orders (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, total INT NOT NULL)`
* SQLite: `CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, total INTEGER NOT NULL)`
* MSSQL: `CREATE TABLE [orders] ([id] BIGINT NOT NULL IDENTITY(1,1) PRIMARY KEY, [total] INT NOT NULL)`
* Mongo: `forge push` throws `'bigserial' has no Mongo equivalent`.

`Row<typeof Order>['id']` is typed `number`. Never pass an `id` at create.

**(4) `objectId`-based custom PK** — when you want to keep the row keyed
on something other than a synthetic id (rare; usually a mistake).

```ts
const Slot = model('slots', {
  // `id` still exists; we just constrain composite uniqueness instead.
  id:      f.id(),
  room_id: f.objectId(),
  starts:  f.dateTime(),
}, {
  uniques: [['room_id', 'starts']],
});
```

This is the right shape 95% of the time: a synthetic `id` plus a composite
unique. A true composite PK isn't directly supported — pin the row by `id`
and DB-enforce the natural key via `uniques`.

---

## Field modifiers

Every modifier is immutable: it returns a new `Field` rather than mutating
in place. From `src/schema/core.ts`:

| Modifier | What it does | Dialect quirks |
|---|---|---|
| `.optional()` | Allows `null`. TS type becomes `T \| null`. | SQL: column emitted without `NOT NULL`. Mongo: presence not enforced. |
| `.unique()` | Single-column unique index. | Mongo: sparse-on-optional automatic. MySQL: don't pair with `f.text()` (no key length). PG: a plain `UNIQUE`; pair with `where: 'col IS NOT NULL'` via `indexes` for partial uniqueness on nullable. |
| `.default(value)` | Literal default at create. | The `value` must be representable as the column type. Objects and arrays default through the wrapper (the DB column itself stays empty until the row is inserted). |
| `.default('now')` | Current timestamp. Use on `f.dateTime()`. | PG/MySQL/MSSQL emit `DEFAULT CURRENT_TIMESTAMP`. SQLite stores ISO text, default is wrapper-applied. |
| `.default('autoId')` | Server-generated id. Used internally by `f.id()`. | Rarely needed by hand. |
| `.updatedAt()` | Bumped to now on every update. | Wrapper-applied across every adapter — no `ON UPDATE` trigger required. Combine with `.default('now')`. |
| `.searchable()` | Build the full-text index at push time. | PG GIN tsvector, MySQL FULLTEXT, SQLite FTS5 + triggers, Mongo `text`, DuckDB `fts`. MSSQL: manual `FULLTEXT CATALOG` out-of-band. |
| `.softDeleteAt()` | Mark this `f.dateTime()` as the soft-delete column. | Forces optional. Reads auto-filter `WHERE col IS NULL`. One per model. |
| `.dbgenerated('expr')` | Database-computed column. The wrapper never writes it. | PG/MySQL/SQLite emit `GENERATED ALWAYS AS (<expr>) STORED`. MSSQL emits `AS (<expr>) PERSISTED`. Mongo warns and skips. |

How modifiers compile per dialect (a single chained string field):

```ts
name: f.string().optional().unique().default('Anonymous'),
```

| Dialect | Emitted DDL |
|---|---|
| PG | `"name" text DEFAULT 'Anonymous' UNIQUE` (nullable → no `NOT NULL`) |
| MySQL | `name VARCHAR(255) DEFAULT 'Anonymous' UNIQUE` |
| SQLite | `name TEXT DEFAULT 'Anonymous' UNIQUE` |
| DuckDB | `name TEXT DEFAULT 'Anonymous' UNIQUE` |
| MSSQL | `[name] NVARCHAR(255) NULL DEFAULT 'Anonymous' UNIQUE` |
| Mongo | unique index, sparse since the field is optional |

---

## Default kinds

Three runtime shapes from `DefaultValue`:

| Kind | Set by | Per-dialect emit |
|---|---|---|
| `{ kind: 'now' }` | `.default('now')` | PG/MySQL/MSSQL: `DEFAULT CURRENT_TIMESTAMP`. SQLite: wrapper-applied at insert. Mongo: wrapper-applied. |
| `{ kind: 'autoId' }` | Internal — used by `f.id()` | App-side ObjectId / UUID generation. Skipped when `idType: 'bigserial'`. |
| `{ kind: 'literal', value }` | `.default(value)` for anything else | PG/MySQL/MSSQL/SQLite/DuckDB: column-level `DEFAULT <quoted-value>` if the value is a primitive; objects and arrays are wrapper-applied at create time. Mongo: wrapper-applied. |

The literal path covers booleans, numbers, strings, arrays, and objects.
Compile rules:

* Booleans on MySQL/SQLite stored as `0`/`1`.
* Strings get single-quoted with SQL escaping.
* Objects/arrays are wrapper-applied — the DB column itself stays empty until insert. That keeps the default consistent across dialects (PG would otherwise store the JSON literal; SQLite couldn't).

For dynamic defaults (current user id, request-scoped tenant), don't use
`.default(…)`. Pass the value at create time, or wrap the model in a
service that fills it in.

---

## Enums

Two pieces: `enums(values)` produces a runtime constant + a TS literal
union; `f.enumOf(values)` produces the column.

```ts
import { enums, f } from 'forge-orm';

const Role = enums(['OWNER', 'ADMIN', 'MEMBER'] as const);
type Role = typeof Role[keyof typeof Role];   // 'OWNER' | 'ADMIN' | 'MEMBER'

const Membership = model('memberships', {
  id:   f.id(),
  role: f.enumOf(Role.values),
});

Role.OWNER;                                    // 'OWNER' — works as a value
```

Per-dialect DDL:

| Dialect | DDL |
|---|---|
| PG | `CREATE TYPE "Role" AS ENUM ('OWNER','ADMIN','MEMBER');` + `"role" "Role" NOT NULL` |
| MySQL | `role ENUM('OWNER','ADMIN','MEMBER') NOT NULL` |
| SQLite | `role TEXT NOT NULL CHECK (role IN ('OWNER','ADMIN','MEMBER'))` |
| DuckDB | `role TEXT NOT NULL CHECK (role IN ('OWNER','ADMIN','MEMBER'))` |
| MSSQL | `[role] NVARCHAR(64) NOT NULL CHECK ([role] IN ('OWNER','ADMIN','MEMBER'))` |
| Mongo | string field, validation rides on the TS type |

**Adding a value.** Append to the literal tuple, redeploy, `forge push`:

* PG: `forge push` emits `ALTER TYPE "Role" ADD VALUE 'GUEST'` (safe on existing rows).
* MySQL: `forge push` emits `ALTER TABLE … MODIFY COLUMN role ENUM(...)` with the new tuple. Online on 8.0+.
* SQLite/DuckDB/MSSQL: the `CHECK` constraint is rebuilt — `forge diff` shows the drop+recreate. Existing rows pass since the constraint is widening.
* Mongo: no DDL change.

**Removing a value.** Always two-step: first migrate rows off the value
(`UPDATE … SET role = '…' WHERE role = 'OLD'`), then drop from the literal
tuple. PG `ALTER TYPE … DROP VALUE` is not supported — `forge push`
recreates the enum type when needed, which is a costly rewrite. Plan the
shrinking enum migration explicitly.

---

## Composite uniques and named indexes

Two routes — single-column uniques via `.unique()`, composite uniques and
custom indexes via `options.uniques` and `options.indexes`.

**Single-column unique** (the common case):

```ts
const User = model('users', {
  id:    f.id(),
  email: f.string().unique(),
});
```

**Composite unique** (orgId + slug must be globally unique):

```ts
const Page = model('pages', {
  id:     f.id(),
  orgId:  f.objectId(),
  slug:   f.string(),
}, {
  uniques: [['orgId', 'slug']],
});
```

`uniques` is sugar for an `IndexDef` with `unique: true` and the column
list. The constraint name is auto-generated: `forge_pages_unique_orgId_slug`.

**Named index with extra options:**

```ts
const Event = model('events', {
  id:        f.id(),
  orgId:     f.objectId(),
  type:      f.string(),
  createdAt: f.dateTime(),
}, {
  indexes: [
    { keys: { orgId: 1, createdAt: -1 }, name: 'org_recent' },
    // Partial unique — uniqueness only enforced for non-deleted rows.
    {
      keys:   { orgId: 1, type: 1 },
      unique: true,
      name:   'org_type_active',
      where:                    'deleted_at IS NULL',           // SQL form
      partialFilterExpression:  { deleted_at: null },           // Mongo form
    },
  ],
});
```

The full `IndexDef` surface (method, expression, include, partial-filter,
collation, wildcard, parser, visible) is in `src/schema/types.ts` — every
field has a doc comment with the per-dialect resolution.

**Composite PK workaround.** There's no `@@id([a, b])` form. The pattern
is: keep the row's synthetic `id`, declare the natural key via `uniques`,
and look up by the composite when needed. The wrapper exposes a synthetic
unique key for composite uniques (`orgId_slug` for the example above):

```ts
await db.page.findFirst({ where: { orgId_slug: { orgId: 'o_1', slug: 'home' } } });
```

---

## Views and materialised views

`.asView({ sql | pipeline, materialised?, refreshEvery? })` declares a
read-only model. Writes (`create`, `update`, `delete`, `upsert`) are
rejected by the wrapper; reads compile against the view like any other
model.

```ts
const PostStats = model('post_stats', {
  author_id:    f.objectId(),
  post_count:   f.int(),
  last_post_at: f.dateTime(),
}).asView({
  sql: `
    SELECT author_id,
           COUNT(*)         AS post_count,
           MAX(created_at)  AS last_post_at
    FROM posts
    GROUP BY author_id
  `,
});
```

| Dialect | Plain view DDL | Materialised view DDL |
|---|---|---|
| PG | `CREATE VIEW "post_stats" AS <sql>` | `CREATE MATERIALIZED VIEW "post_stats" AS <sql>` |
| MySQL | `CREATE VIEW post_stats AS <sql>` | TABLE backed by `<sql>` |
| SQLite | `CREATE VIEW post_stats AS <sql>` | TABLE backed by `<sql>` |
| DuckDB | `CREATE VIEW post_stats AS <sql>` | TABLE backed by `<sql>` |
| MSSQL | `CREATE VIEW [post_stats] AS <sql>` | indexed view (schema-bound) |
| Mongo | `createCollection(name, { viewOn, pipeline })` | `pipeline` ends in `$merge` / `$out` |

**Materialised refresh.**

```ts
const Stats = model('post_stats', { /* … */ }).asView({
  materialised: true,
  sql:          '...',
  refreshEvery: '5m',                 // optional auto-refresh
});

await db.postStats.refresh();         // manual refresh
```

* PG: `REFRESH MATERIALIZED VIEW post_stats`.
* MySQL / SQLite / DuckDB: `TRUNCATE` (or `DELETE FROM`) + `INSERT … SELECT` from the source query, inside a transaction.
* MSSQL: indexed view auto-maintains; `.refresh()` is a no-op.
* Mongo: re-runs the pipeline ending in `$merge` / `$out`.

`refreshEvery: '30s' | '5m' | '1h'` schedules an interval, cleared on
`adapter.close()`.

**Write-block.** Any `create` / `update` / `delete` / `upsert` against a
view throws `ForgeViewWriteError`. Use the source model for writes.

---

## Generated / computed columns

`.dbgenerated('expr')` marks a column whose value is computed by the
database. The wrapper never sends it on `create` or `update` — the DB owns
it.

```ts
const LineItem = model('line_items', {
  id:    f.id(),
  qty:   f.int(),
  price: f.decimal({ precision: 12, scale: 2 }),
  total: f.decimal({ precision: 14, scale: 2 }).dbgenerated('"price" * "qty"'),
});
```

Per-dialect compile:

| Dialect | Emit |
|---|---|
| PG | `"total" numeric(14,2) GENERATED ALWAYS AS ("price" * "qty") STORED` |
| MySQL 5.7+ | `total DECIMAL(14,2) GENERATED ALWAYS AS (`price` * `qty`) STORED` |
| MySQL `VIRTUAL` | not auto-emitted — supply the expression with `VIRTUAL` if you want it: `dbgenerated("price * qty VIRTUAL")`. Forge passes the expression verbatim after the `AS (...)`. |
| SQLite 3.31+ | `total NUMERIC GENERATED ALWAYS AS ("price" * "qty") STORED` |
| DuckDB | warned and skipped (no DDL-time generated columns; compute in views) |
| MSSQL | `[total] AS ([price] * [qty]) PERSISTED` |
| Mongo | warned and skipped — model it via aggregation in a view |

**STORED vs VIRTUAL.** Forge defaults to `STORED` on every SQL dialect that
distinguishes them. `STORED` materialises the value on write (more disk,
indexable on every dialect). `VIRTUAL` recomputes on read (no disk, only
indexable on MySQL). When you need `VIRTUAL`, append it to the expression
string yourself — Forge passes the expression verbatim.

**JSON-extract → indexed scalar pattern.** A common shape: a `jsonb`
column holds the raw payload, a generated column projects one path out for
indexing.

```ts
const Event = model('events', {
  id:      f.id(),
  payload: f.json(),
  user_id: f.string().dbgenerated(`("payload" ->> 'user_id')`),
}, {
  indexes: [{ keys: { user_id: 1 } }],
});
```

PG can then use a B-tree on `user_id` instead of a JSON-path expression
index. On Mongo, model the same shape with an `f.embed()` field and index
the nested path directly.

---

## Schema namespacing

The first argument to `model(...)` is the literal table name. SQL dialects
that support schemas (PG, MSSQL) and Mongo accept dotted names.

**PG schemas:**

```ts
const User = model('auth.users', { id: f.id(), email: f.string().unique() });
```

`forge push` emits `CREATE SCHEMA IF NOT EXISTS "auth"` then `CREATE TABLE
"auth"."users" (...)`. Queries reference `auth.users`. SQLite and DuckDB
ignore the prefix (the dot becomes part of the table name) — pick one
scheme per project.

**MSSQL schemas:**

```ts
const User = model('app.users', { /* ... */ });
```

Compiles to `CREATE TABLE [app].[users] (...)`. The schema is created
ahead of the table.

**Mongo dotted collections.**

Mongo allows `.` in collection names; Forge passes it through. Use this to
group related collections (`billing.invoices`, `billing.subscriptions`).

**Same name, different schema.** When two models share a name but live in
different schemas (`auth.users` vs `tenant.users`), they're distinct
collections in the wrapper too — the wrapper keys by collection string.

---

## Five complete worked schemas

### (a) E-commerce — org → product → variant → inventory

A SaaS storefront: every row scoped to an org, products have variants,
variants are tracked per warehouse. Composite SKU uniqueness inside each
org.

```ts
import { f, model, rel } from 'forge-orm';

const Org = model('orgs', {
  id:   f.id(),
  name: f.string(),
  slug: f.string().unique(),
}).relate(() => ({
  products: rel.many('product', { on: 'org_id', refs: 'id' }),
}));

const Product = model('products', {
  id:         f.id(),
  org_id:     f.objectId(),
  name:       f.string(),
  slug:       f.string(),
  active:     f.bool().default(true),
  created_at: f.dateTime().default('now'),
}, {
  uniques: [['org_id', 'slug']],
}).relate(() => ({
  org:      rel.one('org', { on: 'org_id', refs: 'id', onDelete: 'Cascade' }),
  variants: rel.many('variant', { on: 'product_id', refs: 'id' }),
}));

const Variant = model('variants', {
  id:         f.id(),
  product_id: f.objectId(),
  org_id:     f.objectId(),
  sku:        f.string(),
  price:      f.decimal({ precision: 12, scale: 2 }),
}, {
  uniques: [['org_id', 'sku']],            // SKU unique per org
  indexes: [{ keys: { product_id: 1 } }],
}).relate(() => ({
  product: rel.one('product', { on: 'product_id', refs: 'id', onDelete: 'Cascade' }),
  stock:   rel.many('inventory', { on: 'variant_id', refs: 'id' }),
}));

const Inventory = model('inventory', {
  id:           f.id(),
  variant_id:   f.objectId(),
  warehouse_id: f.objectId(),
  qty_on_hand:  f.int().default(0),
}, {
  uniques: [['variant_id', 'warehouse_id']],
});

export const schema = { org: Org, product: Product, variant: Variant, inventory: Inventory } as const;
```

### (b) Audit log with embedded before/after JSON and retention partial-index

Every mutation logged with a typed shape; old rows tombstoned via a
`retired_at` column with a partial-filter index keeping reads fast.

```ts
import { f, embed, model } from 'forge-orm';

const Diff = () => embed('Diff', {
  field: f.string(),
  before: f.json(),
  after:  f.json(),
});

const AuditEntry = model('audit_log', {
  id:         f.id(),
  org_id:     f.objectId(),
  actor_id:   f.objectId().optional(),
  action:     f.string(),                        // 'create' | 'update' | 'delete' …
  target:     f.string(),                        // 'invoice:inv_123'
  diffs:      f.embedMany(Diff),
  meta:       f.json().optional(),
  created_at: f.dateTime().default('now'),
  retired_at: f.dateTime().optional(),           // set when tombstoned
}, {
  indexes: [
    // Active rows only — keep the hot read path fast
    {
      keys:                    { org_id: 1, created_at: -1 },
      name:                    'recent_active',
      where:                   'retired_at IS NULL',
      partialFilterExpression: { retired_at: null },
    },
    // Path-search inside meta — PG GIN, Mongo wildcard
    { keys: { meta: 1 }, method: 'gin', name: 'audit_meta_gin' },
  ],
});

export const schema = { auditEntry: AuditEntry } as const;
```

### (c) Tagged content with a join table and FTS5 searchable body

Many-to-many tags via an explicit join model; the post body is full-text
indexed so `where: { body: { search: 'forge orm' } }` works on every
dialect.

```ts
const Tag = model('tags', {
  id:   f.id(),
  slug: f.string().unique(),
  name: f.string(),
}).relate(() => ({
  posts: rel.many('postTag', { on: 'tag_id', refs: 'id' }),
}));

const Post = model('posts', {
  id:         f.id(),
  author_id:  f.objectId(),
  title:      f.string().searchable(),
  body:       f.text().searchable(),
  created_at: f.dateTime().default('now'),
}).relate(() => ({
  tags: rel.many('postTag', { on: 'post_id', refs: 'id' }),
}));

const PostTag = model('post_tags', {
  id:      f.id(),
  post_id: f.objectId(),
  tag_id:  f.objectId(),
}, {
  uniques: [['post_id', 'tag_id']],
}).relate(() => ({
  post: rel.one('post', { on: 'post_id', refs: 'id', onDelete: 'Cascade' }),
  tag:  rel.one('tag',  { on: 'tag_id',  refs: 'id', onDelete: 'Cascade' }),
}));

export const schema = { tag: Tag, post: Post, postTag: PostTag } as const;
```

### (d) Multi-tenant SaaS — org_id everywhere, partial-unique by org_id + slug

The canonical multi-tenant shape: every row carries `org_id`; uniqueness
is per-tenant, enforced by a partial-filter index so soft-deleted rows
don't collide.

```ts
const Workspace = model('workspaces', {
  id:         f.id(),
  org_id:     f.objectId(),
  slug:       f.string(),
  name:       f.string(),
  created_at: f.dateTime().default('now'),
  deleted_at: f.dateTime().softDeleteAt(),       // soft-delete marker
}, {
  indexes: [
    {
      keys:                    { org_id: 1, slug: 1 },
      unique:                  true,
      name:                    'org_slug_active',
      where:                   'deleted_at IS NULL',
      partialFilterExpression: { deleted_at: null },
    },
  ],
}).relate(() => ({
  members: rel.many('membership', { on: 'workspace_id', refs: 'id' }),
}));

const Membership = model('memberships', {
  id:           f.id(),
  workspace_id: f.objectId(),
  user_id:      f.objectId(),
  role:         f.enumOf(['OWNER', 'ADMIN', 'MEMBER'] as const),
}, {
  uniques: [['workspace_id', 'user_id']],
}).relate(() => ({
  workspace: rel.one('workspace', { on: 'workspace_id', refs: 'id', onDelete: 'Cascade' }),
}));

export const schema = { workspace: Workspace, membership: Membership } as const;
```

### (e) Geo-tagged inventory with a materialised view of per-region counts

Stock locations carry a `geoPoint`; a materialised view tallies stock per
region for the dashboard, refreshing every five minutes.

```ts
const Store = model('stores', {
  id:       f.id(),
  org_id:   f.objectId(),
  name:     f.string(),
  region:   f.string(),
  location: f.geoPoint(),
}, {
  indexes: [
    { keys: { location: 1 }, method: 'spatial', name: 'stores_loc' },
  ],
});

const StockLevel = model('stock_levels', {
  id:        f.id(),
  store_id:  f.objectId(),
  sku:       f.string(),
  qty:       f.int(),
  updated_at: f.dateTime().default('now').updatedAt(),
}, {
  uniques: [['store_id', 'sku']],
});

const RegionStock = model('region_stock', {
  region:    f.string(),
  sku:       f.string(),
  total_qty: f.int(),
}).asView({
  materialised: true,
  refreshEvery: '5m',
  sql: `
    SELECT s.region,
           l.sku,
           SUM(l.qty) AS total_qty
    FROM stock_levels l
    JOIN stores s ON s.id = l.store_id
    GROUP BY s.region, l.sku
  `,
});

export const schema = { store: Store, stockLevel: StockLevel, regionStock: RegionStock } as const;
```

---

## Schema evolution

`forge push` and `db.$migrate()` cover non-destructive evolution. The
boundary between "safe" and "needs a manual migration" is sharp.

**Adding a column.** Safe if the column is nullable or has a constant
default. Both `forge push` and the in-browser `db.$migrate()` will emit
`ALTER TABLE … ADD COLUMN` — see [MIGRATIONS.md](./MIGRATIONS.md) for the
CLI flow, and [BROWSER.md](./BROWSER.md#dbmigrate--runtime-ddl-apply--drift-detection)
for the runtime equivalent that reads the drift report and applies the
safe slice in-transaction.

```ts
// Was:
const User = model('users', { id: f.id(), email: f.string().unique() });

// Now — both ship safely
const User = model('users', {
  id:    f.id(),
  email: f.string().unique(),
  name:  f.string().optional(),                  // ALTER TABLE users ADD COLUMN name TEXT
  tz:    f.string().default('UTC'),              // ALTER TABLE users ADD COLUMN tz TEXT DEFAULT 'UTC'
});
```

A `NOT NULL` column without a constant default lands in `pending` —
existing rows can't satisfy the constraint. Either supply a default or
write a manual migration that backfills first.

**Renaming a column.** Never auto-applied. `forge diff` shows it as a
drop + add — that loses data. The hand-rolled flow:

1. Add the new column to the schema.
2. `forge push` (or `db.$migrate()`) creates it.
3. Run a one-off backfill: `db.$executeRaw('UPDATE users SET full_name = name')`.
4. Remove the old column from the schema.
5. Manual `ALTER TABLE users DROP COLUMN name` once nothing reads it.

**Splitting a column.** Same shape: add the new columns, backfill, drop
the old. Wrap in a transaction if the dialect supports DDL transactions
(PG yes, MySQL no, SQLite yes, DuckDB yes, MSSQL yes).

**Merging two tables.** Manual every time. Create the merged table, copy
the union of rows in with a `db.$executeRaw('INSERT INTO …')`, repoint FKs
in the schema, drop the old tables. Run on a read-replica first.

**Forge push limits.** `forge push` won't:

* Drop columns automatically.
* Re-type a column (`text` → `integer`).
* Convert a unique index to non-unique or widen a partial filter.
* Rename anything.

All four land as `pending` items in the drift report. The CLI's `forge
diff apply` writes a timestamped migration file you review before
shipping — same destructive operations, just out of the auto path. See
[MIGRATIONS.md](./MIGRATIONS.md).

---

## Common mistakes

**Forgetting `.relate(() => …)` for circular models.** If `A` references
`B` and `B` references `A`, declaring relations inline in `model(...)`
options forces TypeScript to walk the cycle and collapse both models to
`any`. The chained `.relate()` form, with relation targets as string keys
into the schema, breaks the cycle. The TS-cycle reason is documented at
the top of `core.ts` — it's why relations look the shape they do.

```ts
// Wrong — TS collapses A and B to any
const A = model('a', { id: f.id() }, {
  relations: () => ({ b: rel.one('b', { on: 'b_id', refs: 'id' }) }),
});

// Right
const A = model('a', { id: f.id(), b_id: f.objectId() })
  .relate(() => ({ b: rel.one('b', { on: 'b_id', refs: 'id' }) }));
```

**Mixing `f.objectId()` with `f.id()` on PG.** `f.objectId()` emits a
`text` column on SQL — fine for FKs into a default `auto` PK (also `text`).
But if the parent's PK is `f.id({ type: 'bigserial' })`, the FK column has
to be `f.bigint()`, not `f.objectId()`. Mismatched types fail at push with
a foreign-key type error; on a pure migration path they fail at row insert
with a coercion error.

**Unique on a nullable column without a partial filter.** SQL treats every
`NULL` as distinct — `email: f.string().optional().unique()` lets you
insert many rows with `email = NULL`. Mongo handles this with sparse-on-
optional automatically. On SQL, declare a partial-filter index instead:

```ts
indexes: [{
  keys:                    { email: 1 },
  unique:                  true,
  where:                   'email IS NOT NULL',
  partialFilterExpression: { email: { $ne: null } },
}],
```

**Generated column without `STORED` / `VIRTUAL`.** PG defaults to
`STORED`; MySQL defaults to `VIRTUAL`. Forge's `.dbgenerated('expr')`
emits `STORED` on every SQL dialect that distinguishes them. When you
want `VIRTUAL` on MySQL (no disk, recomputes on read), bake it into the
expression string yourself: `.dbgenerated("price * qty VIRTUAL")`. The
expression is passed verbatim after the `GENERATED ALWAYS AS (...)`.

**`f.text().unique()` on MySQL.** MySQL can't `UNIQUE` a `TEXT` column
without a key prefix length. Switch to `f.string()` (which compiles to
`VARCHAR(255)`), or drop the unique and enforce it at the app layer.

**Embed shapes that aren't lazy.** `f.embed(Address)` where `Address` is a
value (not a thunk) blows up on circular embeds and re-evaluates on every
schema build. Always wrap: `() => embed('Address', { … })`.

**Forgetting `softDeleteAt()` flips reads.** Once any field on a model has
`.softDeleteAt()`, every read auto-filters `WHERE col IS NULL`. To read
deleted rows pass `where: { _withDeleted: true }`, and to permanently
delete use `db.x.deleteHard(...)` rather than `db.x.delete(...)`.

**One soft-delete column per model.** The wrapper picks one. A second
`.softDeleteAt()` on the same model throws at schema build.
