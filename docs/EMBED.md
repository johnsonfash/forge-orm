# Embedded objects — deep dive

The README chapter **[Embedded objects](../README.md#embedded-objects)** covers
the `embed('Name', { ... })` declaration, `f.embed(Type)`, `f.embedMany(Type)`
and the JSON-path read shape. This doc is the long-form reference: per-dialect
storage, the read and write paths in full, how embeds interact with validation,
indexes, full-text search, nullability, schema migration and the five patterns
most production callers reach for.

If you have not read the README chapter yet, start there — this doc assumes you
already know the call shape. It also assumes the
[JSON path queries](./JSON-PATH.md) doc, since every embed read uses the same
path-extract engine under the hood.

## Contents

* [`embed()` declaration and per-dialect storage](#embed-declaration-and-per-dialect-storage)
* [`f.embed` vs `f.embedMany` vs `f.json`](#fembed-vs-fembedmany-vs-fjson)
* [Reading embeds](#reading-embeds)
* [Writing embeds](#writing-embeds)
* [Validation — pairing with Zod / Valibot](#validation--pairing-with-zod--valibot)
* [Indexing into embeds](#indexing-into-embeds)
* [Mongo `$elemMatch` on `embedMany`](#mongo-elemmatch-on-embedmany)
* [Embedded join-table pattern](#embedded-join-table-pattern)
* [Five worked patterns](#five-worked-patterns)
* [JSON-null vs DB-null vs absent](#json-null-vs-db-null-vs-absent)
* [Migrating embed shape](#migrating-embed-shape)
* [Embeds + FTS](#embeds--fts)
* [Performance — embed vs relation](#performance--embed-vs-relation)

---

## `embed()` declaration and per-dialect storage

```ts
import { embed, f, model } from 'forge-orm';

const AddressEmbed = () => embed('Address', {
  street: f.string(),
  city:   f.string(),
  zip:    f.string(),
  geo:    f.embed(() => embed('LngLat', {
    lng: f.float(),
    lat: f.float(),
  })).optional(),
});

const User = model('users', {
  id:      f.id(),
  email:   f.string().unique(),
  address: f.embed(AddressEmbed).optional(),
  history: f.embedMany(AddressEmbed),
});
```

`embed(name, fields)` is a tiny model in its own right — same `Field<...>` map
the top-level `model()` uses, same `f.string()` / `f.bool()` / `f.dateTime()`
inside. It does not have its own table; it serialises into whichever column the
parent uses to hold it.

The `name` argument is a label, not a foreign key. Forge does not enforce that
two `embed('Address', ...)` calls with the same name share a shape — that is on
you. Reusing one factory (`AddressEmbed` above) is the convention, and the only
way to keep two columns guaranteed-identical at the type level.

The factory wrapper (`() => embed(...)`) is required: it breaks the TypeScript
inference cycle that would form if an embed referenced itself or a sibling
embed inline. Pass the factory, not the result, into `f.embed(...)`.

### Per-dialect storage

| Dialect    | Column type used         | Notes                                                                  |
|------------|--------------------------|------------------------------------------------------------------------|
| Postgres   | `jsonb`                  | Binary JSON; default for both `f.embed` and `f.embedMany`.             |
| MySQL      | `JSON`                   | Native JSON since 5.7; MariaDB 10.7+ aliases to a `LONGTEXT CHECK`.    |
| SQLite     | `TEXT`                   | Plain text; reads route through `json_extract`. Driver sees a string.  |
| DuckDB     | `JSON`                   | DuckDB's native logical type, dictionary-encoded on disk.              |
| MSSQL      | `NVARCHAR(MAX)`          | T-SQL has no `JSON` type; reads use `JSON_VALUE` / `JSON_QUERY`.       |
| Mongo      | sub-document             | No serialisation step; nested BSON. `embedMany` becomes an array.      |

`embedMany` adds a NOT NULL default at DDL time so the column never holds
literal NULL on a freshly-inserted row that did not specify the field:

* Postgres — `DEFAULT '[]'::jsonb`
* MySQL    — `DEFAULT (JSON_ARRAY())`
* SQLite   — `DEFAULT '[]'`
* DuckDB / MSSQL — applied at insert time by the adapter when the value is
  absent (these dialects don't accept a JSON expression in `DEFAULT`).

`f.embed(...)` without `.optional()` is NOT NULL but has no DDL-side default;
the writer is responsible for sending a value at create-time. Mark it
`.optional()` if you want to allow the column-level NULL.

### TypeScript inference

```ts
type UserRow = NonNullable<typeof User['_row']>;
// {
//   id:      string;
//   email:   string;
//   address: { street: string; city: string; zip: string;
//              geo?: { lng: number; lat: number } } | null;
//   history: { street: string; city: string; zip: string;
//              geo?: { lng: number; lat: number } }[];
// }
```

The embed shape is reachable as a structural type — `Address['_row']` is not
exported (there is no top-level `Address` symbol), so refer to it via the
parent (`UserRow['address']`). On write, forge loosens the shape with
`Partial<...>` because defaults can fill missing fields:

```ts
await db.user.create({
  data: {
    email:   'a@x.co',
    address: { street: '1 Main', city: 'SF', zip: '94110' },  // geo? — fine to omit
    history: [],                                              // explicit empty list
  },
});
```

---

## `f.embed` vs `f.embedMany` vs `f.json`

Pick by the shape and source of the value:

| You have                                  | Use                  | Why                                                      |
|-------------------------------------------|----------------------|----------------------------------------------------------|
| A fixed, known shape — your code authors it | `f.embed(Type)`    | Full row-level type inference; schema-checked at read.  |
| A list of that fixed shape                 | `f.embedMany(Type)` | Same, plus `has` / `some` / `every` / `none` operators. |
| External / opaque payload (webhook, blob)  | `f.json()`           | No shape commitment; `any` on read.                     |
| You sometimes know the shape, sometimes not | `f.json()` + a runtime parser | Avoids painting yourself into a corner.       |

A common mistake is reaching for `f.json()` for "I'll figure it out later"
fields that turn out to be authored by your own code. Six months in, every
read is `meta?.profile?.role ?? 'unknown'`-shaped. Reach for `f.embed(...)` as
soon as the shape stabilises and the same code reads and writes it.

### Type-safety differences

| Surface                     | `f.embed(Type)`               | `f.embedMany(Type)`            | `f.json()`             |
|-----------------------------|-------------------------------|--------------------------------|------------------------|
| Row type on read            | `Embed \| null` (if optional) | `Embed[]` (default `[]`)      | `any`                  |
| Create / update accepts     | `Partial<Embed>`              | `Partial<Embed>[]`            | `any`                  |
| `where: { col: { path } }`  | typed path, scalar sub-op    | typed path, scalar sub-op     | scalar sub-op, untyped |
| `where: { col: { has } }`   | n/a                          | yes — array containment       | n/a                    |
| `where: { col: { some / every / none } }` | n/a              | yes — quantified filter       | n/a                    |
| Index `expression` access   | via `json_extract` etc.       | via `json_extract` etc.        | via `json_extract` etc.|

### Mongo "everything is a document" reality

Inside Mongo, a row IS a document, and any sub-field is already a sub-document.
There is no JSON serialisation, no string round-trip, no `jsonb` cast. The
adapter does still coerce inputs (dates → `Date`, ObjectIds where present), and
on the way out runs the same coercion in reverse so the value matches the
declared embed shape. See `src/adapters/mongo/coerce.ts` for the full table.

The practical difference: `embedMany` on Mongo is just a regular array of
sub-documents. The dotted-key form (`'history.0.city'`) walks into it; Mongo
will also resolve `'history.city'` as the array of all `city` values, which is
why `where: { history: { path: 'city', equals: 'SF' } }` matches "any history
entry with city = SF" on Mongo but matches "the literal value at JSON path
`$[*].city`" on SQL dialects. Use [`some`](#mongo-elemmatch-on-embedmany) when
you want the same "match any element" semantics across all dialects.

---

## Reading embeds

Embed reads use the same [JSON path queries](./JSON-PATH.md) machinery as
`f.json()` — the path expression, the sub-operators, the per-dialect SQL emit,
and the null markers are identical. This section covers the embed-specific
parts: typed paths, sub-field selection, and the lack of `include`.

### Path access (`where`)

```ts
await db.user.findMany({
  where: { address: { path: 'city', equals: 'Lagos' } },
});
```

Path strings are dot-delimited; `path: ['address', 'city']` is the array
equivalent and avoids dotted-key ambiguity for keys that themselves contain
dots. Numeric segments emit native array indexing per dialect — `history[0].city`
becomes:

* PG     — `("history"->0->>'city')`
* MySQL  — `JSON_UNQUOTE(JSON_EXTRACT(history, '$[0].city'))`
* SQLite / DuckDB — `json_extract(history, '$[0].city')`
* MSSQL  — `JSON_VALUE([history], '$[0].city')`
* Mongo  — `{ 'history.0.city': ... }`

Sub-operators (`equals`, `not`, `lt` / `lte` / `gt` / `gte`, `contains`, `in`,
`has`) work on the leaf. The cast / unquote rules from
[JSON path queries](./JSON-PATH.md#dialect-translation-table) apply unchanged.

### `select` projection of sub-fields

Forge's `select` projects top-level columns, not deep paths — `select: { address: true }` returns the whole embed value. Two work-arounds:

```ts
// 1. Project the whole embed and pick in JS — fine when the embed is small.
const rows = await db.user.findMany({ select: { id: true, address: true } });
const cities = rows.map(r => r.address?.city);

// 2. Drop a `$queryRaw` for a hot loop where you can't afford to ship the
//    whole embed across the wire.
const rows = await db.$queryRaw<{ id: string; city: string }[]>`
  SELECT id, address->>'city' AS city FROM users
`;
```

### No `include`

Embeds are not relations — `include` does not apply. There is no join to drive,
no second `SELECT` to run, no eager-loading mode to pick. The embed is already
in the row. This is the upside of embed-shaped data; the downside is that you
can't reach across rows with it.

---

## Writing embeds

Default semantics for both `f.embed` and `f.embedMany`: **full replacement**.

```ts
await db.user.update({
  where: { id },
  data:  { address: { street: '5 New', city: 'Lagos', zip: '101001' } },
});
// The entire `address` column is overwritten. Any previously-stored
// `geo`, or any sibling field not supplied in this object, is lost.
```

`embedMany` works the same way — the entire array is overwritten:

```ts
await db.user.update({
  where: { id },
  data:  { history: [{ street: '5 New', city: 'Lagos', zip: '101001' }] },
});
```

### Partial update patterns

Forge does not ship a deep-merge writer — by design. Deep merge across six
dialects with mixed null semantics produces a lot of edge cases (does `null`
mean "set to null" or "leave alone"?), and the read-modify-write loop is
clearer at the call site than buried inside the ORM. For a partial update:

```ts
const row    = await db.user.findUniqueOrThrow({ where: { id }, select: { address: true } });
const merged = { ...row.address, city: 'Lagos' };
await db.user.update({ where: { id }, data: { address: merged } });
```

Three caveats:

1. **Concurrent updates.** Read-modify-write loses a concurrent writer's
   change. Pair with an optimistic-lock column (`version: f.int()` + `where: { id, version }`) if conflicts matter.
2. **Mongo doc size.** A 5 MB embed makes the read in this loop expensive
   even when you're only changing one byte.
3. **Per-dialect partial update.** When you must avoid the read-modify-write,
   drop to the native path (see below).

### Dialect-native partial update (when read-modify-write isn't acceptable)

```ts
// Postgres — jsonb_set
await db.$executeRaw`
  UPDATE users SET address = jsonb_set(address, '{city}', '"Lagos"'::jsonb)
  WHERE id = ${id}
`;

// MySQL — JSON_SET
await db.$executeRaw`
  UPDATE users SET address = JSON_SET(address, '$.city', 'Lagos')
  WHERE id = ${id}
`;

// SQLite — json_set
await db.$executeRaw`
  UPDATE users SET address = json_set(address, '$.city', 'Lagos')
  WHERE id = ${id}
`;

// MSSQL — JSON_MODIFY
await db.$executeRaw`
  UPDATE [users] SET [address] = JSON_MODIFY([address], '$.city', 'Lagos')
  WHERE [id] = ${id}
`;

// Mongo — dotted-key $set
await db.user.$runCommandRaw({
  update: 'users',
  updates: [{ q: { _id: id }, u: { $set: { 'address.city': 'Lagos' } } }],
});
```

### Removing a key

For "remove the city sub-field entirely" semantics, the per-dialect calls are
`jsonb_set(... , '{}'::jsonb, false)` plus `- 'city'` on PG (`address - 'city'`),
`JSON_REMOVE` on MySQL and SQLite, `JSON_MODIFY(... , NULL)` on MSSQL, and
`$unset` on Mongo. Forge does not surface a `_unset` marker on the typed write
API — drop to `$executeRaw` or `$runCommandRaw` for that surface, and use
`ForgeJsonNull` (see [JSON-null vs DB-null vs absent](#json-null-vs-db-null-vs-absent))
when you mean "set to the JSON null literal" rather than "remove the key".

### `embedMany` appends and removes

```ts
// Append — read-modify-write is the dialect-portable shape
const row = await db.user.findUniqueOrThrow({ where: { id }, select: { history: true } });
await db.user.update({ where: { id }, data: { history: [...row.history, newAddress] } });

// PG only — jsonb concat
await db.$executeRaw`
  UPDATE users SET history = history || ${JSON.stringify([newAddress])}::jsonb
  WHERE id = ${id}
`;

// Mongo — $push
await db.user.$runCommandRaw({
  update: 'users',
  updates: [{ q: { _id: id }, u: { $push: { history: newAddress } } }],
});
```

---

## Validation — pairing with Zod / Valibot

Forge does NOT validate embed contents at write time. The reasoning:

* The embed type lives in the schema; the ORM trusts what TypeScript handed it.
* JSON storage has no per-key check constraint on five of the six dialects.
* Validation belongs at the boundary (HTTP, queue, CSV upload), not inside the
  storage layer — that way bad input fails before it touches the writer, and
  good input doesn't pay a per-write parse cost.

Pair the embed declaration with a parser at the boundary:

```ts
import { z } from 'zod';

const AddressSchema = z.object({
  street: z.string().min(1),
  city:   z.string().min(1),
  zip:    z.string().regex(/^\d{5,6}$/),
  geo:    z.object({ lng: z.number(), lat: z.number() }).optional(),
});

app.post('/users', async (req) => {
  const address = AddressSchema.parse(req.body.address);     // throws on bad input
  return db.user.create({ data: { email: req.body.email, address, history: [] } });
});
```

Where forge stops: invalid shapes hitting the writer through `db.$executeRaw`,
backfills from a CSV, or a previous schema version on disk. The reader will
return whatever the column contains — including keys you no longer expect.
For backfill safety, parse on the way OUT in code paths that can't tolerate
shape drift:

```ts
const row     = await db.user.findUniqueOrThrow({ where: { id } });
const address = row.address ? AddressSchema.parse(row.address) : null;
```

Valibot, Effect/Schema, ArkType, io-ts all work the same way — the embed
declaration is the storage shape, the runtime parser is the contract.

---

## Indexing into embeds

JSON columns are unindexed by default — every read scans. For an embed key
that drives a filter, extract a hot path into an index. The
[JSON path queries — Indexing JSON paths](./JSON-PATH.md#indexing-json-paths)
chapter has the per-dialect grammar; this section narrows to the embed-specific
shapes.

### Generated column + plain index (every SQL dialect)

The cleanest shape: declare the hot path as a `dbGenerated` column on the
model, then put a regular index on it. The generated column is computed by the
database, kept in sync automatically, and indexable like any other.

```ts
const User = model('users', {
  id:      f.id(),
  address: f.embed(AddressEmbed).optional(),
  // Hot path — extracted as a generated column the index can target.
  address_city: f.string().optional()
    .dbGenerated({
      pg:     `("address"->>'city')`,
      mysql:  `(JSON_UNQUOTE(JSON_EXTRACT(address, '$.city')))`,
      sqlite: `(json_extract(address, '$.city'))`,
      mssql:  `JSON_VALUE([address], '$.city')`,
      duckdb: `(json_extract(address, '$.city'))`,
    }),
}, {
  indexes: [{ keys: { address_city: 1 } }],
});
```

Reads against the generated column hit the index even if the user writes the
embed-path form, because the path expression matches the column's generation
expression on PG, MySQL, SQLite and DuckDB. MSSQL needs the column to be
`PERSISTED` for the planner to use it — pass `{ persisted: true }` to
`dbGenerated` on that dialect.

### Partial-filter index on an embed value

Skip the generated column entirely when you only care about one value of one
sub-field:

```ts
// "find admin users by id, fast" — index just the admin rows.
const User = model('users', {
  id:      f.id(),
  profile: f.embed(ProfileEmbed),
}, {
  indexes: [
    {
      keys: { id: 1 },
      // PG / SQLite — WHERE clause on the index
      where: `profile->>'role' = 'admin'`,
      // Mongo — partialFilterExpression
      partialFilterExpression: { 'profile.role': 'admin' },
    },
  ],
});
```

PG, SQLite and Mongo accept this directly. MySQL has no partial indexes;
emulate with a generated column that is non-null only for admins, then index
that. MSSQL uses a filtered index with `WHERE [profile_role] = 'admin'` on a
computed column.

### `embedMany` — multikey index

```ts
// Mongo — index every element's `kind` field
indexes: [{ keys: { 'tags.kind': 1 } }],

// PG — GIN on the whole array
indexes: [{ keys: {}, method: 'gin', expression: `(tags jsonb_path_ops)` }],
```

For a single hot key on a `embedMany` column, Mongo's multikey index is the
cheapest call. PG GIN with `jsonb_path_ops` indexes the entire structure and
supports `@>` containment queries — forge does not surface `@>` as an operator,
but `$queryRaw` with the GIN index will return in milliseconds on millions of
rows.

---

## Mongo `$elemMatch` on `embedMany`

Forge translates the quantified relation operators (`some`, `every`, `none`)
on `embedMany` fields to native Mongo `$elemMatch`:

```ts
await db.user.findMany({
  where: { history: { some: { city: 'SF', zip: { startsWith: '94' } } } },
});
// → { history: { $elemMatch: { city: 'SF', zip: /^94/ } } }
```

The same call on a SQL dialect compiles to a JSON-path scan with a correlated
sub-filter. Forge emits the right shape per dialect:

* PG — `WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(history) e WHERE e->>'city' = $1 AND e->>'zip' LIKE $2)`
* MySQL — `JSON_CONTAINS(JSON_EXTRACT(history, '$[*].city'), '"SF"')` plus a
  `JSON_SEARCH`-shaped term for the prefix
* SQLite / DuckDB — `EXISTS (SELECT 1 FROM json_each(history) WHERE json_extract(value, '$.city') = ?)`

### When forge drops to raw

Three patterns the IR will refuse to compile and require a `$queryRaw` /
`$runCommandRaw`:

1. **Mixed positional operators** — `$elemMatch` with `$[]`, `$elemMatch` with
   `$[<identifier>]`, and Mongo's positional update operators have no SQL
   analogue and no IR equivalent.
2. **Cross-element constraints** — "at least one element where `kind = 'image'`
   AND another element where `kind = 'text'`" can't be expressed as a single
   `some` and the AND across two `some` clauses on Mongo collapses both into
   one `$elemMatch` (matching rows where ONE element has both keys, not what
   you want). For this, drop to two pipelined `$elemMatch` stages or the SQL
   `EXISTS` shape, both as raw.
3. **Aggregations over `embedMany` content** — `SUM(elem.qty)` across the
   array on PG needs `LATERAL jsonb_array_elements`; forge's `aggregate()` does
   not walk into JSON. Drop to `$queryRaw`.

For any of those, prefer the dialect's native surface (`$runCommandRaw` for
the Mongo aggregation pipeline, `$queryRaw` for the SQL `LATERAL` shape) and
keep the typed surface for the cases it covers cleanly.

---

## Embedded join-table pattern

Many-to-many on Mongo is idiomatically an embed; on SQL it is idiomatically a
join table. Forge supports both — the choice is structural, not enforced.

### Mongo — embed the membership

```ts
const User = model('users', {
  id:      f.id(),
  email:   f.string().unique(),
  // Each membership is a sub-document with role + joined-at.
  groups:  f.embedMany(() => embed('Membership', {
    group_id: f.string(),
    role:     f.enumOf(['member', 'admin'] as const),
    joined:   f.dateTime(),
  })),
});

// "All admin groups for this user"
const u = await db.user.findUniqueOrThrow({
  where: { id },
  select: { groups: true },
});
const adminGroups = u.groups.filter(g => g.role === 'admin').map(g => g.group_id);

// "All admins of this group"
await db.user.findMany({
  where: { groups: { some: { group_id: gid, role: 'admin' } } },
  select: { id: true, email: true },
});
```

Indexes:

```ts
indexes: [
  { keys: { 'groups.group_id': 1 } },                                // multikey
  { keys: { 'groups.group_id': 1, 'groups.role': 1 } },              // compound multikey
],
```

### SQL — join table

```ts
const User = model('users', {
  id:    f.id(),
  email: f.string().unique(),
});

const Group = model('groups', { id: f.id(), name: f.string() });

const Membership = model('memberships', {
  user_id:  f.string(),
  group_id: f.string(),
  role:     f.enumOf(['member', 'admin'] as const),
  joined:   f.dateTime().default('now'),
}, {
  uniques: [['user_id', 'group_id']],
  indexes: [{ keys: { group_id: 1, role: 1 } }],
}).relate(() => ({
  user:  rel.one('users',  { on: 'user_id',  refs: 'id' }),
  group: rel.one('groups', { on: 'group_id', refs: 'id' }),
}));
```

### Migrating between the shapes

Embed → join table (typically when memberships grow > 100 per user):

1. Add the join-table model. `forge push` creates it.
2. Backfill: read each user, INSERT one membership row per element of `groups`.
3. Read-path swap: replace `findMany({ where: { groups: { some: ... } } })`
   call sites with `db.membership.findMany({ where: ..., include: { user: true } })`.
4. Drop the embed field once readers are off it.

Join table → embed (typically when memberships are < 20 per user and always
read together with the user):

1. Add the embed field, default `[]`.
2. Backfill: `UPDATE users SET groups = (SELECT jsonb_agg(...) FROM memberships
   WHERE user_id = users.id)`. Mongo equivalent: aggregation pipeline with
   `$lookup` + `$project` + `$out`.
3. Read-path swap.
4. Drop the join table once writers are off it.

---

## Five worked patterns

### (a) Address book — generated `city` column

```ts
const AddressEmbed = () => embed('Address', {
  line1:    f.string(),
  city:     f.string(),
  postcode: f.string(),
  country:  f.string(),
});

const Contact = model('contacts', {
  id:      f.id(),
  name:    f.string(),
  address: f.embed(AddressEmbed),

  // Hot paths extracted for index
  city: f.string().optional().dbGenerated({
    pg:     `("address"->>'city')`,
    mysql:  `(JSON_UNQUOTE(JSON_EXTRACT(address, '$.city')))`,
    sqlite: `(json_extract(address, '$.city'))`,
  }),
  postcode: f.string().optional().dbGenerated({
    pg:     `("address"->>'postcode')`,
    mysql:  `(JSON_UNQUOTE(JSON_EXTRACT(address, '$.postcode')))`,
    sqlite: `(json_extract(address, '$.postcode'))`,
  }),
}, {
  indexes: [
    { keys: { city: 1 } },
    { keys: { postcode: 1 } },
  ],
});

// Indexed read — planner picks `idx_contacts_city`.
await db.contact.findMany({ where: { city: 'Lagos' }, take: 50 });
```

### (b) Audit log — before / after with retention partial index

```ts
const RevisionEmbed = () => embed('Revision', {
  at:     f.dateTime(),
  by:     f.string(),
  before: f.json(),       // shape varies per audited model
  after:  f.json(),
});

const AuditLog = model('audit_log', {
  id:        f.id(),
  table:     f.string(),
  row_id:    f.string(),
  revision:  f.embed(RevisionEmbed),
  retain_until: f.dateTime().optional(),
}, {
  indexes: [
    // Hot-write index — only the rows still under retention. Partial cuts
    // the index by ~80% in long-running deployments.
    {
      keys:  { table: 1, row_id: 1 },
      where: `retain_until > now()`,                       // PG / SQLite syntax
      partialFilterExpression: { retain_until: { $gt: new Date() } }, // Mongo
    },
  ],
});

await db.auditLog.create({
  data: {
    table:    'users',
    row_id:   uid,
    revision: { at: new Date(), by: actor, before: prev, after: next },
    retain_until: new Date(Date.now() + 365 * 86_400_000),
  },
});
```

### (c) i18n localised strings with fallback chain

```ts
const I18nText = () => embed('I18nText', {
  en: f.string().optional(),
  fr: f.string().optional(),
  sw: f.string().optional(),
});

const Product = model('products', {
  id:          f.id(),
  sku:         f.string().unique(),
  description: f.embed(I18nText),
});

function pick(text: { en?: string; fr?: string; sw?: string }, locale: 'en' | 'fr' | 'sw') {
  return text[locale] ?? text.en ?? text.fr ?? text.sw ?? '';
}

const row = await db.product.findUniqueOrThrow({ where: { sku } });
const label = pick(row.description, currentLocale);
```

For locale-specific search:

```ts
// "Match if the French copy contains 'pain'"
await db.product.findMany({
  where: { description: { path: 'fr', contains: 'pain' } },
});
```

### (d) Webhook payload — opaque `f.json()` + typed headers embed

```ts
const WebhookHeaders = () => embed('WebhookHeaders', {
  signature:   f.string(),
  delivery_id: f.string(),
  received_at: f.dateTime(),
});

const Webhook = model('webhooks', {
  id:       f.id(),
  source:   f.string(),
  headers:  f.embed(WebhookHeaders),     // typed — we authored these
  payload:  f.json(),                    // un-typed — comes from a third party
  status:   f.enumOf(['pending', 'processed', 'failed'] as const),
});

await db.webhook.create({
  data: {
    source:   'stripe',
    headers:  { signature: sig, delivery_id: did, received_at: new Date() },
    payload:  rawBodyParsedToJson,         // any shape — we'll deal at replay
    status:   'pending',
  },
});
```

Two different storage stories in one model: `headers` is typed, indexed and
read with `.signature` autocomplete; `payload` is opaque, untyped, and only
parsed by the replay worker that knows the `source` value's schema.

### (e) Polymorphic content blocks — tagged union via `embedMany`

```ts
const ImageBlock = () => embed('ImageBlock', {
  kind: f.enumOf(['image'] as const),
  src:  f.string(),
  alt:  f.string().optional(),
});

const TextBlock = () => embed('TextBlock', {
  kind: f.enumOf(['text'] as const),
  body: f.string(),
});

const VideoBlock = () => embed('VideoBlock', {
  kind:    f.enumOf(['video'] as const),
  src:     f.string(),
  poster:  f.string().optional(),
});

const AnyBlock = () => embed('Block', {
  kind:   f.enumOf(['image', 'text', 'video'] as const),
  src:    f.string().optional(),
  alt:    f.string().optional(),
  body:   f.string().optional(),
  poster: f.string().optional(),
});

const Post = model('posts', {
  id:     f.id(),
  blocks: f.embedMany(AnyBlock),
});
```

Forge does not natively support a `union` field — `AnyBlock` declares the
union of fields with the discriminator (`kind`). The reader narrows in TS:

```ts
const post = await db.post.findUniqueOrThrow({ where: { id } });
for (const b of post.blocks) {
  switch (b.kind) {
    case 'image': render(<Image src={b.src!} alt={b.alt} />); break;
    case 'text':  render(<Text  body={b.body!} />);            break;
    case 'video': render(<Video src={b.src!} poster={b.poster} />); break;
  }
}
```

Filter on the discriminator:

```ts
// Mongo
await db.post.findMany({ where: { blocks: { some: { kind: 'image' } } } });

// Postgres — same call, IR compiles to:
// WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(blocks) e
//               WHERE e->>'kind' = 'image')
```

For stronger validation, parse with Zod on the way out:

```ts
const Block = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), src: z.string(), alt: z.string().optional() }),
  z.object({ kind: z.literal('text'),  body: z.string() }),
  z.object({ kind: z.literal('video'), src: z.string(), poster: z.string().optional() }),
]);
const blocks = post.blocks.map(b => Block.parse(b));
```

---

## JSON-null vs DB-null vs absent

Three different "absent" states exist for a JSON-typed column, and SQL
distinguishes between them while Mongo collapses two of the three. Forge ships
markers from `src/null-markers.ts` so call sites stay explicit and portable.

| Marker          | Semantics                                                              |
|-----------------|------------------------------------------------------------------------|
| `ForgeDbNull`   | Set the column itself to SQL `NULL`. The JSON value is the absence.   |
| `ForgeJsonNull` | Set the column to the JSON `null` literal. The column is non-null.    |
| `ForgeAnyNull`  | Filter operand: "match either SQL NULL or JSON null". Read-side only. |

```ts
import { ForgeDbNull, ForgeJsonNull, ForgeAnyNull } from 'forge-orm';

// Write — SQL column becomes NULL
await db.user.update({ where: { id }, data: { settings: ForgeDbNull } });

// Write — SQL column becomes 'null'::jsonb (PG) / 'null' (MySQL / SQLite) /
//                            NULL (Mongo — collapses to plain null)
await db.user.update({ where: { id }, data: { settings: ForgeJsonNull } });

// Read — match either
await db.user.findMany({ where: { settings: ForgeAnyNull } });
```

### Per-dialect distinction

* **Postgres** — `WHERE settings IS NULL` and `WHERE settings = 'null'::jsonb`
  are different filters. PG returns `NULL` for the first and the literal `null`
  for the second; `ForgeAnyNull` emits `(settings IS NULL OR settings = 'null'::jsonb)`.
* **MySQL** — `JSON_TYPE(settings)` returns `NULL` for both SQL NULL and the
  JSON `null` literal. The distinction is preserved on storage but not
  observable through `JSON_TYPE`; use `WHERE settings IS NULL` for SQL null
  and `WHERE settings = CAST('null' AS JSON)` for JSON null.
* **SQLite / DuckDB** — `json_type(col)` returns `'null'` for the JSON null and
  the column is genuinely SQL NULL for DB null.
* **MSSQL** — `JSON_VALUE` returns `NULL` in both cases; forge emits an
  `ISJSON` + `JSON_QUERY` chain for `ForgeJsonNull` reads.
* **Mongo** — both collapse to `null`. `ForgeDbNull` and `ForgeJsonNull` write
  identically; `ForgeAnyNull` is the same as plain `null` on the filter side.

### Why this matters for embeds

`f.embed(...)` without `.optional()` rejects `ForgeDbNull` at the type level —
you cannot set a NOT NULL column to NULL. The two cases that arise in practice:

```ts
// Optional embed — three legal write states:
await db.user.update({ data: { address: { street: '1', city: 'X', zip: 'Y' } } }); // value
await db.user.update({ data: { address: ForgeDbNull } });                          // SQL null
await db.user.update({ data: { address: ForgeJsonNull } });                        // JSON null
// (Mongo treats the last two identically. PG distinguishes.)

// embedMany — never null; default `[]`. The "no values" state IS the empty array.
await db.user.update({ data: { history: [] } });
```

Reading back: `address` on the JSON-null branch is the JS value `null` on PG
and MySQL (forge parses), and `null` on Mongo. The DB-null branch is `null` on
all dialects. If you need to distinguish the two on read, use `ForgeAnyNull`
to match both or `path: ''` to probe the column directly.

For more, see [JSON path queries — Null markers](./JSON-PATH.md#type-coercion-gotchas--json-null-vs-db-null-vs-absent).

---

## Migrating embed shape

Drift detection sees columns and indexes — it does not see the inside of an
embed. Adding, removing or renaming a sub-field of `AddressEmbed` does not
produce a `forge diff` entry, because the underlying column type is unchanged.
The schema-shape change is your responsibility to backfill.

### Add a sub-field with a default

Adding `country` to `AddressEmbed`:

```ts
const AddressEmbed = () => embed('Address', {
  street:  f.string(),
  city:    f.string(),
  zip:     f.string(),
  country: f.string().default('NG'),    // new
});
```

The default is applied at **create time**, not retroactively. Existing rows
keep their old shape. Three options:

```ts
// 1. Read-time default — cheapest, no backfill
const row     = await db.user.findUniqueOrThrow({ where: { id } });
const country = row.address?.country ?? 'NG';

// 2. PG backfill in place
await db.$executeRaw`
  UPDATE users
  SET    address = jsonb_set(address, '{country}', '"NG"'::jsonb)
  WHERE  address IS NOT NULL AND NOT (address ? 'country')
`;

// 3. Mongo backfill in place
await db.user.$runCommandRaw({
  update: 'users',
  updates: [{
    q: { address: { $exists: true }, 'address.country': { $exists: false } },
    u: { $set: { 'address.country': 'NG' } },
    multi: true,
  }],
});
```

### Remove a sub-field

Drop the declaration. The reader returns whatever the column contains
(including the now-unknown key). Cleanup is a backfill:

```ts
// PG
await db.$executeRaw`UPDATE users SET address = address - 'country' WHERE address ? 'country'`;

// MySQL / SQLite
await db.$executeRaw`UPDATE users SET address = JSON_REMOVE(address, '$.country')`;

// Mongo
await db.user.$runCommandRaw({
  update: 'users',
  updates: [{ q: {}, u: { $unset: { 'address.country': '' } }, multi: true }],
});
```

For SQLite when the JSON1 path you need isn't covered, read the column in JS,
delete the key, and write it back — `db.user.findMany` + map + `db.user.update`
in a batched loop. Slow but portable to every SQLite build, including the
in-browser `wasm` variant.

### Rename a sub-field

Two-step backfill. Step 1 — read both keys with a fallback during the
deprecation window:

```ts
const country = row.address?.country ?? (row.address as any)?.nation;
```

Step 2 — backfill the rename, then drop the fallback:

```sql
-- PG
UPDATE users
SET    address = (address - 'nation') || jsonb_build_object('country', address->>'nation')
WHERE  address ? 'nation';
```

### A drift-probe pattern for embed shape

Drift detection does not flag missing or extra sub-fields. Write a probe job
that samples rows and reports key sets:

```ts
const sample = await db.user.findMany({
  take:   1000,
  select: { id: true, address: true },
});

const keys = new Map<string, number>();
for (const r of sample) {
  if (!r.address) continue;
  for (const k of Object.keys(r.address)) keys.set(k, (keys.get(k) ?? 0) + 1);
}

// Expected: every sub-field declared on AddressEmbed appears in ~100% of
// non-null rows; nothing else does.
const expected = ['street', 'city', 'zip', 'country'];
const unexpected = [...keys.keys()].filter(k => !expected.includes(k));
const missing    = expected.filter(k => (keys.get(k) ?? 0) < sample.length * 0.95);
if (unexpected.length || missing.length) {
  console.warn('[address embed] drift', { unexpected, missing });
}
```

Run nightly. The shape-change signal arrives within a day rather than at the
first failing read on a forgotten production row.

---

## Embeds + FTS

Searching across embed string fields needs a path-aware tokeniser. Forge's
`f.text().searchable()` indexes a single column; for the embed case, point it
at a generated column that concatenates the embed leaves.

### Postgres — `tsvector` over concatenated paths

```ts
const Article = model('articles', {
  id:    f.id(),
  body:  f.embed(() => embed('Body', {
    title:    f.string(),
    summary:  f.string(),
    content:  f.string(),
  })),
  search: f.text().searchable().dbGenerated({
    pg: `(setweight(to_tsvector('english', body->>'title'),   'A') ||
          setweight(to_tsvector('english', body->>'summary'), 'B') ||
          setweight(to_tsvector('english', body->>'content'), 'C'))`,
  }),
}, {
  indexes: [{ keys: { search: 1 }, method: 'gin' }],
});

await db.article.findMany({ where: { search: { search: 'forge migration' } } });
```

### MySQL — `FULLTEXT` over a generated column

```ts
search: f.string().dbGenerated({
  mysql: `(CONCAT_WS(' ',
    JSON_VALUE(body, '$.title'),
    JSON_VALUE(body, '$.summary'),
    JSON_VALUE(body, '$.content')
  ))`,
}),
// In indexes: { keys: { search: 1 }, method: 'fulltext' }
```

### SQLite — FTS5 with a shadow table

`f.text().searchable()` on SQLite emits the FTS5 shadow table and the AFTER
INSERT / UPDATE / DELETE triggers automatically. For the embed case, the
trigger needs to extract from the JSON column — pass the extraction expression
through `searchable({ source: '...' })`:

```ts
search: f.text().searchable({
  source: `json_extract(body, '$.title') || ' ' ||
           json_extract(body, '$.summary') || ' ' ||
           json_extract(body, '$.content')`,
}),
```

The shadow table holds the concatenated text; the `search` operator on the
typed surface queries the FTS5 table directly (forge resolves through the
shadow). For the full grammar see [Full-text search](./FTS.md).

### Mongo — text index over the embed sub-paths

```ts
indexes: [
  { keys: {
      'body.title':   'text',
      'body.summary': 'text',
      'body.content': 'text',
    },
    weights: { 'body.title': 10, 'body.summary': 5, 'body.content': 1 } as any,
  },
],
```

The `search` operator on the typed surface compiles to `{ $text: { $search: ... } }`
against the named index.

---

## Performance — embed vs relation

The rule of thumb: **embed when the data is ≤ 1 KB and always read with the
parent. Use a relation otherwise.**

| Signal                                            | Embed | Relation |
|---------------------------------------------------|-------|----------|
| Always read together with the parent              | yes   |          |
| ≤ ~1 KB per parent row                            | yes   |          |
| Never read or updated independently               | yes   |          |
| Read by 80%+ of queries against the parent        | yes   |          |
| Read by < 10% of queries against the parent       |       | yes      |
| Updated more often than the parent                |       | yes      |
| Grows unboundedly (chat history, audit log, etc.) |       | yes      |
| Needs its own primary key or referential integrity |      | yes      |
| Needs an index on a sub-field across millions of rows | sometimes both | sometimes both |
| Indexed by analytics workloads                    |       | yes      |

### Index hot paths early

The default scan over an unindexed JSON column is fine for tens of thousands
of rows. By a million it is noticeably slow; by ten million it is the table
scan that breaks the page. Move the hot path to a generated column the moment
a filter shows up in the read logs — it is a one-line schema change and a
backfill the database handles.

### When the JSON encoder becomes a bottleneck

Three signs the JSON serialisation cost is now load-bearing:

1. **Wide rows.** A 50 KB embed on every write means 50 KB of `JSON.stringify`
   per call, plus the same again on every read for `JSON.parse`. Profile with
   `node --prof` — `Stringify` and `Parse` showing in the top five is the tell.
2. **`embedMany` with hundreds of entries per row.** Each entry pays the
   encoder cost twice (once on the way in, once on the way out). At ~500
   entries per row the per-call overhead is comparable to a small SELECT
   against a relation.
3. **Hot-loop reads of one sub-field.** A worker that reads `address.city`
   from 100 K rows reads and parses the entire `address` blob for each. The
   generated-column shape avoids the parse — the city comes back as a plain
   string column.

Mitigations, in order:

* Move sub-fields the worker actually needs into generated columns.
* Split the embed: keep the hot fields in `f.embed(SmallEmbed)`, push the
  long-tail into a `f.json()` blob that the worker doesn't `select`.
* Promote `embedMany` to a relation when the cardinality crosses ~50 per row.

### Mongo's 16 MB document limit

Embed data lives inside the parent document on Mongo. The hard limit is 16 MB
per document. `embedMany` with unbounded growth (per-user activity, chat
threads, audit log) will eventually hit it. Plan the migration to a relation
at ~1 MB per document — by 5 MB writes start failing intermittently because
the BSON encoder is doing fragmentation work, and replication latency climbs.

The [embedded join-table pattern](#embedded-join-table-pattern) is the
canonical "we were embedding this, now we aren't" migration.
