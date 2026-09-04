---
title: "Defining a schema"
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

### Models and automatic values (id, timestamps)

`model(tableName, fields)` declares a table (or a Mongo collection). The first
argument is the real table name in the database; the object key you give it in
the schema (`user`, `post`) is what you type as `db.user`.

forge fills in three kinds of value for you so you don't have to:

**Primary key (`f.id()`).** Every model has one. When you create a row without
passing an `id`, forge generates one automatically on **every** database:

```ts
await db.user.create({ data: { email: 'a@x.co', name: 'A' } });  // id is generated
```

The default id is a **string**: an `ObjectId` on Mongo, and a UUID on
Postgres, MySQL, SQLite, DuckDB, and MSSQL. It's a string (not a sequential
number) so the same model is portable across all six databases. You can
still pass your own `id` if you want to control it, and you can let the
database generate it instead with a UUID default:

```ts
id: f.uuid({ default: 'gen_random_uuid' })   // Postgres/MySQL fill it in server-side
```

**Created-at (`f.dateTime().default('now')`).** Set to the current time when the
row is created. You never pass it.

**Updated-at (`f.dateTime().default('now').updatedAt()`).** Set when the row is
created and **automatically bumped to the current time on every update**, on all
six databases. You never pass it.

```ts
const post = await db.post.create({ data: { title: 'Hi' } });
// post.created_at and post.updated_at are both set

await db.post.update({ where: { id: post.id }, data: { title: 'Hello' } });
// updated_at is now refreshed automatically
```

`f.objectId()` is for a column that holds another row's id (a foreign key). On
Mongo it stores an `ObjectId`; on SQL it is plain text.

### Picking a primary-key strategy

If you want something other than the default, pass `f.id({ type })`:

```ts
id: f.id()                            // default — app-generated string id (string in TS)
id: f.id({ type: 'auto' })            // same as the default; explicit form
id: f.id({ type: 'uuid' })            // DB-typed UUID column (PG `uuid`, MySQL `CHAR(36)`)
id: f.id({ type: 'bigserial' })       // auto-incrementing integer PK — number in TS
id: f.id({ type: 'string' })          // YOU supply it — nothing is generated
```

What each one emits per dialect:

| Strategy     | Postgres                       | MySQL                              | SQLite                                  | DuckDB / MSSQL | Mongo            | JS type  |
| ------------ | ------------------------------ | ---------------------------------- | --------------------------------------- | -------------- | ---------------- | -------- |
| `auto` (default) | `text`                     | `VARCHAR(64)`                      | `TEXT`                                  | `TEXT` / `NVARCHAR(64)` | `ObjectId`       | `string` |
| `uuid`       | `uuid`                         | `CHAR(36)`                         | `TEXT`                                  | (same as `auto`) | (same as `auto`) | `string` |
| `bigserial`  | `BIGSERIAL`                    | `BIGINT NOT NULL AUTO_INCREMENT`   | `INTEGER PRIMARY KEY AUTOINCREMENT`     | `BIGINT … IDENTITY` (MSSQL) | **throws at push** | `number` |
| `string`     | `text`                         | `VARCHAR(255)`                     | `TEXT`                                  | (same as `auto`) | stored verbatim  | `string` |

`string` (2.8.0) is the one you assign yourself. Use it for a **natural
key** — a row whose identity is its content, so one upsert is atomic on
one document:

```ts
// "<orgId>:<series>" — one row per counter, incremented in a single write.
export const NumberSequence = model('number_sequences', {
  id: f.id({ type: 'string' }),
  seq: f.int().default(0),
});
```

On Mongo the value is stored verbatim and never coerced to an ObjectId —
a 24-hex natural key would otherwise be rewritten and every lookup would
miss. See [PRIMARY-KEYS.md](/reference/primary-keys).

`bigserial` is the SQL-only opt-in. Forge runs `forge push` on Mongo with a
clear error if you use it (`'bigserial' has no Mongo equivalent`), so a
schema mistake fails fast instead of half-applying. Use it when you're
running a SQL-only service and you want classic integer keys; stay on
`auto` or `uuid` for cross-DB portability.

With `bigserial`, the DB assigns the id — you don't pass one at create time,
and `Row<typeof Model>['id']` is typed as `number`:

```ts
const Order = model('orders', {
  id:     f.id({ type: 'bigserial' }),
  total:  f.int(),
});

const o = await db.order.create({ data: { total: 5_000 } });
o.id;          // ✓ number — TypeScript knows
await db.order.findFirst({ where: { id: 47 } });
```

Adding `bigserial` to an existing table? `forge diff` shows you the column
change before you push, and `forge diff apply` writes a timestamped
reconciliation migration if you'd rather review the SQL first.

### Field types

Every field builder. Chain modifiers (`.optional()`, `.unique()`, `.default(…)`,
`.searchable()`, `.softDeleteAt()`, `.dbgenerated(…)`, `.updatedAt()`) onto any
of them.

| Builder                              | TS type                          | Storage per dialect / notes                                                                 |
| ------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------- |
| `f.id()`                             | `string`                         | Primary key, auto-generated when omitted. Pass `{ type: 'auto' \| 'uuid' \| 'bigserial' }`. |
| `f.objectId()`                       | `string`                         | Foreign-key style. Mongo `ObjectId`; SQL `TEXT`.                                            |
| `f.string()`                         | `string`                         | Short text. MySQL `VARCHAR(255)` (indexable). PG/SQLite/DuckDB `TEXT`, MSSQL `NVARCHAR(255)`. |
| `f.text()`                           | `string`                         | Long text. MySQL `TEXT`. PG `text`, MSSQL `NVARCHAR(MAX)`, DuckDB `TEXT`.                   |
| `f.int()`                            | `number`                         | 32-bit integer.                                                                             |
| `f.float()`                          | `number`                         | Floating point.                                                                             |
| `f.decimal({ precision, scale })`    | `string`                         | Exact numerics (money). PG `numeric(p,s)` / MySQL `DECIMAL(p,s)` / SQLite `NUMERIC` / Mongo `Decimal128`. Returned as a string to avoid float-precision loss. |
| `f.bigint()`                         | `bigint`                         | 64-bit integer. Use `1n` literals. PG `bigint` / MySQL `BIGINT` / SQLite `INTEGER` / Mongo `Long`. |
| `f.uuid({ default? })`               | `string`                         | UUID. Pass `{ default: 'gen_random_uuid' }` for a server-side default on PG / MySQL.        |
| `f.bool()`                           | `boolean`                        | Stored as 0/1 on MySQL and SQLite, decoded back to a boolean.                               |
| `f.dateTime()`                       | `Date`                           | Timestamp. Accepts a `Date` or an ISO string on input.                                      |
| `f.json()`                           | `any`                            | Arbitrary JSON. `jsonb` on Postgres, `JSON` on MySQL / MSSQL, `TEXT` on SQLite.             |
| `f.enumOf(['A','B'] as const)`       | `'A' \| 'B'`                     | A fixed set of string values, checked by the database where supported.                     |
| `f.embed(Shape)`                     | `Shape`                          | One nested object. Stored as JSON on SQL, sub-document on Mongo.                            |
| `f.embedMany(Shape)`                 | `Shape[]`                        | A list of nested objects. Defaults to `[]`.                                                 |
| `f.stringArray()` / `f.intArray()`   | `string[]` / `number[]`          | A list of scalars. Native array on Postgres, JSON elsewhere.                                |
| **`f.geoPoint({ srid?, fallback? })`** | **`{ lng: number; lat: number }`** | **2D geographic point (WGS84 / SRID 4326). PG `geography(Point, 4326)` (PostGIS) / MySQL `POINT NOT NULL SRID 4326` / SpatiaLite geometry / DuckDB `GEOMETRY` (spatial) / MSSQL `GEOGRAPHY` / Mongo GeoJSON. Pair with `method: 'spatial'`. `fallback: true` stores JSON + Haversine post-filter when no extension is installed.** |
| **`f.vector(dims, { metric? })`**    | **`number[]`**                    | **Dense numeric vector for embeddings / semantic search. PG `vector(N)` (pgvector) / MySQL `VECTOR(N)` (9.0+) / SQLite JSON+`sqlite-vec` / DuckDB `FLOAT[N]` (vss HNSW) / MSSQL `VECTOR(N)` (2025+) / Mongo plain array + Atlas Vector Search. `metric` is `'cosine'` (default), `'l2'`, or `'dot'`. Pair with `method: 'vector'`.** |

### Field modifiers

Chain these onto any field builder. Modifiers are immutable — they return a
new `Field` with the modifier applied.

| Modifier                            | What it does                                                                                          | Notes / dialect quirks                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `.optional()`                       | Allows `null`. The TS type becomes `T \| null`.                                                       | Maps to `NULL` in SQL DDL, no required-presence check on Mongo.                 |
| `.unique()`                         | Adds a unique index on the column.                                                                    | Sparse-on-optional is automatic on Mongo.                                       |
| `.default(value)`                   | Static default applied at create when no value is passed.                                              | The `value` is literal — strings, numbers, booleans, objects, arrays.           |
| `.default('now')`                   | Current timestamp at create. Use on `f.dateTime()`.                                                    | Drives the `created_at` pattern.                                                |
| `.default('autoId')`                | Server-generated id (used internally by `f.id()`).                                                     | Rarely needed by hand.                                                          |
| `.updatedAt()`                      | Auto-bumped to the current time on every update.                                                       | Combine with `.default('now')` for the canonical `updated_at`.                  |
| `.searchable()`                     | Tells `forge push` to build the right full-text index for this column (see [Full-text search](/guide/full-text-search#full-text-search)). | Postgres `GIN` tsvector, MySQL `FULLTEXT`, SQLite `FTS5` shadow table + triggers, Mongo `text`, DuckDB `fts`. MSSQL: out-of-band (manual `FULLTEXT CATALOG`). |
| `.softDeleteAt()`                   | Marks this `f.dateTime()` column as the soft-delete column (see [Soft delete](/guide/soft-delete#soft-delete)).         | Forces optional. Reads auto-filter `WHERE col IS NULL`. One per model.          |
| `.dbgenerated('expr')`              | Database-computed column. The wrapper never writes it; the DB evaluates `<expr>` on every change.     | PG / MySQL emit `GENERATED ALWAYS AS (<expr>) STORED`; SQLite uses the same shape; Mongo warns and skips. |

```ts
f.string().optional()                                       // value can be null
f.string().unique()                                         // unique index on this column
f.string().default('pending')                               // static default
f.bool().default(true)                                      // bool default
f.dateTime().default('now')                                 // created-at
f.dateTime().default('now').updatedAt()                     // updated-at (set on create AND auto-bumped on update)
f.text().searchable()                                       // build a full-text index
f.dateTime().softDeleteAt()                                 // mark as the soft-delete column
f.decimal({ precision: 12, scale: 2 })
  .dbgenerated('"price" * "qty"')                           // computed by the DB
```

### Indexes and unique constraints

Pass an options object as the third argument to `model`. The same `IndexDef`
shape carries every common production index family — partial, expression,
covering, geospatial, vector, hashed, wildcard, full-text, and more. Each
field that doesn't apply on a given dialect is dropped at push with a clear
warning, so one schema can target Mongo and SQL.

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

The full index vocabulary:

```ts
indexes: [
  // Partial index. Mongo uses partialFilterExpression; Postgres and SQLite
  // use `where` with a raw SQL string. The same entry can carry both so
  // the schema works on either side.
  { keys: { sku: 1 }, unique: true,
    where: 'deleted_at IS NULL',
    partialFilterExpression: { deleted_at: { $exists: false } } },

  // TTL (Mongo).
  { keys: { createdAt: 1 }, expireAfterSeconds: 60 * 60 * 24 },

  // Mongo geospatial — `$near` / `$geoWithin` queries need this.
  { keys: { location: '2dsphere' } },

  // Spatial index — portable across dialects. Forge resolves the right
  // native family per dialect (PostGIS GIST, MySQL SPATIAL, DuckDB RTREE,
  // MSSQL CREATE SPATIAL INDEX, Mongo 2dsphere, SQLite virtual rtree).
  // Pair with f.geoPoint().
  { keys: { location: 1 }, method: 'spatial' },

  // Vector index — pgvector HNSW / DuckDB vss HNSW / MSSQL VECTOR HNSW.
  // Mongo and SQLite log a clean warning (their vector index is created
  // out-of-band). Pair with f.vector(N, { metric }).
  { keys: { embedding: 1 }, method: 'vector' },

  // Mongo hashed — required for a hashed shard key.
  { keys: { tenant: 'hashed' } },

  // Mongo case-insensitive unique. strength: 2 = case-insensitive.
  { keys: { email: 1 }, unique: true,
    collation: { locale: 'en', strength: 2 } },

  // Mongo wildcard index — keys: { '$**': 1 } + wildcardProjection.
  { keys: { '$**': 1 } as any, wildcardProjection: { 'data.$**': 1 } },

  // Postgres GIN over a jsonb column — supports @> containment.
  { keys: { tags: 1 }, method: 'gin' },

  // Postgres covering — answers (customer_id) → (status, total) from the index.
  { keys: { customer_id: 1 }, include: ['status', 'total'] },

  // Postgres BRIN for huge append-only tables (logs, analytics).
  { keys: { received_at: 1 }, method: 'brin' },

  // Expression index. Postgres / MySQL 8+ / SQLite. Mongo skips with a warning.
  { keys: {}, expression: 'lower(email)' },

  // MySQL fulltext with parser plugin — `'ngram'` for CJK, `'mecab'` for Japanese.
  { keys: { body: 1 }, method: 'fulltext', parser: 'ngram' },

  // MySQL 8+ invisible index — the optimizer ignores it,
  // useful for canary-testing whether an index is load-bearing before drop.
  { keys: { obsolete: 1 }, visible: false },

  // MySQL 8+ multi-valued index on a JSON array column — index every element
  // of the array. Use `expression` with the CAST that MySQL requires.
  { keys: {}, expression: "(CAST(tags->'$[*]' AS UNSIGNED ARRAY))" },
]
```

What each field does, per dialect:

| Field                              | Mongo                | Postgres            | MySQL               | SQLite              | DuckDB              | MSSQL               |
|------------------------------------|----------------------|---------------------|---------------------|---------------------|---------------------|---------------------|
| `keys: { col: 1 / -1 }`            | yes                  | yes                 | yes                 | yes                 | yes                 | yes                 |
| `keys: { col: 'text' }`            | text index           | `text_pattern_ops`  | column kept         | column kept         | column kept         | column kept         |
| `keys: { col: '2dsphere'/'2d'/'hashed' }` | yes           | ignored             | ignored             | ignored             | ignored             | ignored             |
| `unique` / `sparse`                | yes                  | yes (sparse auto on optional) | yes/n/a   | yes/n/a             | yes/n/a             | yes/n/a             |
| `expireAfterSeconds`               | yes                  | n/a                 | n/a                 | n/a                 | n/a                 | n/a                 |
| `partialFilterExpression`          | yes                  | n/a                 | n/a                 | n/a                 | n/a                 | n/a                 |
| `where` (object)                   | alias of PFE         | translated to SQL   | warn + skip         | translated to SQL   | warn + skip         | translated to SQL   |
| `where` (SQL string)               | n/a                  | `WHERE …`           | warn + skip         | `WHERE …`           | warn + skip         | `WHERE …`           |
| `include: [cols]`                  | n/a                  | `INCLUDE (…)`       | warn + skip         | warn + skip         | warn + skip         | `INCLUDE (…)`       |
| `expression: 'sql'`                | warn + skip          | `((expr))`          | `((expr))`          | `(expr)`            | `((expr))`          | warn + skip         |
| `method: gin/gist/brin/hash`       | n/a                  | `USING …`           | warn (ignored)      | warn (ignored)      | warn (ignored)      | warn (ignored)      |
| `method: 'spatial'`                | resolves to 2dsphere | `USING GIST`        | `SPATIAL INDEX`     | virtual rtree       | `USING RTREE`       | `CREATE SPATIAL INDEX` |
| `method: 'vector'`                 | warn (Atlas search)  | `USING hnsw (... opclass)` | warn (community = exact) | warn (use sqlite-vec) | `USING HNSW`     | `USING VECTOR WITH (algorithm='HNSW')` |
| `method: 'fulltext'`               | n/a                  | DB rejects          | statement prefix    | warn (ignored)      | n/a                 | warn (ignored)      |
| `parser: 'ngram'/'mecab'`          | n/a                  | warn (ignored)      | `WITH PARSER …` (only on fulltext) | warn (ignored) | warn (ignored) | warn (ignored)      |
| `visible: false`                   | n/a                  | warn (ignored)      | `INVISIBLE` (MySQL 8) | warn (ignored)    | warn (ignored)      | warn (ignored)      |
| `collation`                        | yes                  | n/a (use expression)| n/a                 | n/a                 | n/a                 | n/a                 |
| `wildcardProjection`               | yes                  | n/a                 | n/a                 | n/a                 | n/a                 | n/a                 |

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
    posts: rel.many('post', { on: 'author_id', refs: 'id' }),
  }));

const Post = model('posts', { id: f.id(), author_id: f.objectId(), title: f.string() })
  .relate(() => ({
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
[Choosing fields](/guide/reading-data#choosing-fields-select-and-include)) and write related rows
in one call (see [Writing related records](/guide/writing-data#writing-related-records-in-one-call)).

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

You can read into embedded fields with [JSON path queries](/guide/json-path-queries#json-path-queries):

```ts
await db.user.findMany({
  where: { address: { path: 'city', eq: 'SF' } },
});
```

See more — **[docs/MODEL.md](/reference/model)** (full field catalogue + id strategies + views + generated columns), **[docs/EMBED.md](/reference/embed)** (`f.embed`/`f.embedMany`/`f.json` + JSON-null markers + 5 worked patterns), **[docs/RELATIONS.md](/reference/relations)** (relation shapes + cascade + deep includes + 6 worked patterns), **[docs/INDEXES.md](/reference/indexes)** (every `IndexDef` field + per-dialect emit + drift detection), **[docs/PRIMARY-KEYS.md](/reference/primary-keys)** (UUIDv7 / ULID / Snowflake / serial trade-offs), **[docs/FOREIGN-KEYS.md](/reference/foreign-keys)** (onDelete / onUpdate / deferred), **[docs/ENUMS.md](/reference/enums)** (per-dialect emit + evolution), **[docs/CHECKS.md](/reference/checks)** (CHECK constraints + Mongo `$jsonSchema`), **[docs/GENERATED-COLUMNS.md](/reference/generated-columns)** (STORED vs VIRTUAL), **[docs/VIEWS.md](/reference/views)** and **[docs/MATERIALIZED-VIEWS.md](/reference/materialized-views)**, **[docs/TRIGGERS.md](/reference/triggers)** (DB-side procedural code).

---
