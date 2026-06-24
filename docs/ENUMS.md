# Enums

`f.enum(['a', 'b'])` for type-safe choice fields — what forge emits per dialect (Postgres native ENUM type, MySQL inline ENUM, SQLite CHECK constraint, Mongo `$jsonSchema`), TypeScript type inference into literal unions, and the evolution patterns (adding values online, removing via expand/contract, when a lookup table beats an enum).

The [`Enums`](./MODEL.md#enums) section in MODEL.md is the surface — the
`enums(values)` + `f.enumOf(values)` pair, the literal-union TS type, the
add-a-value note. This file goes one level down: every dialect's actual
DDL emission, the `ALTER TYPE` story on Postgres, the rewrite-the-column
story on MySQL, the drop-and-recreate-CHECK story on SQLite/MSSQL,
runtime validation via `$jsonSchema` on Mongo, the expand/contract
pattern for removing a value online, and the "is this really an enum"
question — when a lookup table beats an enum for soft-add / lookup
columns / FK semantics.

Related deep-dives:

* [MODEL.md](./MODEL.md#enums) — the enum surface and the field-type catalogue.
* [TYPES.md](./TYPES.md#rowtypeof-model) — how `f.enumOf(...)` lands as a literal union on `Row`.
* [CHECKS.md](./CHECKS.md) — `f.check(expr)` for predicates that aren't shaped as a fixed set.
* [VERSIONING.md](./VERSIONING.md) — expand/contract schema patterns.
* [MIGRATIONS.md](./MIGRATIONS.md) — what `forge push` does with a schema change.
* [INDEXES.md](./INDEXES.md) — indexing an enum column (a normal scalar index).

---

## Contents

* [The forge enum surface](#the-forge-enum-surface)
* [TypeScript inference](#typescript-inference)
* [Per-dialect emit](#per-dialect-emit)
* [Adding a value](#adding-a-value)
* [Removing a value — expand / contract](#removing-a-value--expand--contract)
* [Reordering values](#reordering-values)
* [Multiple enums on one model](#multiple-enums-on-one-model)
* [Indexing an enum column](#indexing-an-enum-column)
* [Enum vs lookup table](#enum-vs-lookup-table)
* [Sort order across dialects](#sort-order-across-dialects)
* [Storage size](#storage-size)
* [Mongo `$jsonSchema` enforcement](#mongo-jsonschema-enforcement)
* [zod alongside](#zod-alongside)
* [Worked examples](#worked-examples)
* [Common mistakes](#common-mistakes)

---

## The forge enum surface

Two primitives, both exported from the top-level package:

```ts
import { enums, f, model } from 'forge-orm';
```

* **`enums(values)`** — a runtime constant + a TS literal union. The
  values become both keys and values of the returned object, so it
  doubles as a typed namespace (`Role.OWNER === 'OWNER'`).
* **`f.enumOf(values)`** — the field builder. Takes a literal tuple,
  emits a column whose TS type is the union of the literals, and
  carries the tuple onto the FieldDef so DDL knows the legal set.

```ts
const Role = enums(['OWNER', 'ADMIN', 'MEMBER'] as const);
// type Role     = 'OWNER' | 'ADMIN' | 'MEMBER'
// runtime Role  = { values: ['OWNER','ADMIN','MEMBER'], OWNER:'OWNER', ADMIN:'ADMIN', MEMBER:'MEMBER' }

const Membership = model('memberships', {
  id:   f.id(),
  role: f.enumOf(Role.values).default('MEMBER'),
});
```

`as const` on the tuple is required — without it, the tuple widens to
`string[]` and the literal-union inference collapses to plain `string`.
`enums(values)` insists on the `const` shape at the type level
(`<const V extends readonly string[]>`); pass a bare array and TS will
complain at the call site rather than later in the row type.

There is no `f.literal(...)` shorthand. A single-element enum is the
same call — `f.enumOf(['ONLY'] as const)` — and TS infers `'ONLY'` as
a unit type.

`f.enumOf(...)` and `enums(...)` are independent — you can pass any
literal tuple to `f.enumOf` without going through `enums()` first
(`status: f.enumOf(['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const)`).
Route through `enums(...)` when you want `Status.DRAFT` to be both a
value and a member of the union type; otherwise the field builder is
enough.

---

## TypeScript inference

`Row<typeof Model>` returns the literal union for an enum field:

```ts
import type { Row } from 'forge-orm';

const Post = model('posts', {
  id:     f.id(),
  status: f.enumOf(['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const),
});

type PostRow = Row<typeof Post>;
//  ^? { id: string; status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' }
```

`.optional()` widens to a nullable union, the same as every other
scalar:

```ts
status: f.enumOf(['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const).optional(),
//  ^? 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | null
```

`.default('DRAFT')` doesn't change the row type, but it does make the
field optional on `Create`:

```ts
import type { InferCreate } from 'forge-orm';

type CreatePost = InferCreate<typeof Post>;
//  ^? { id?: string; status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' }
```

`Where` filters narrow to the same union — `equals`, `not`, `in`, and
`notIn` all take legal-only values, so a typo like
`{ status: { equals: 'DRRAFT' } }` is a compile error.

```ts
await db.post.findMany({ where: { status: { in: ['PUBLISHED', 'ARCHIVED'] } } });
//                                              ^^^^^^^^^^^ literal-checked
```

Where the inference *can't* save you: dynamic data coming off an HTTP
request. The string is `string` at the boundary, not a literal —
narrow it with a zod schema (or a custom guard) before passing it to
`db.post.update({ data: { status } })`. See
[zod alongside](#zod-alongside).

---

## Per-dialect emit

Forge holds the enum tuple on the `FieldDef` and lets each dialect
decide how to enforce the set. All six dialects agree on the column's
JS-side shape (a string union); they differ on whether the constraint
rides on a typed column, a CHECK clause, or a JSON-schema validator.

| Dialect | Column type | Constraint |
|---|---|---|
| Postgres | `CREATE TYPE "<name>" AS ENUM (...)` + column typed as the enum | enforced by the typed column |
| MySQL | `ENUM('a','b',…)` inline | enforced by the column type |
| SQLite | `TEXT` | `CHECK (col IN ('a','b',…))` |
| DuckDB | `ENUM` type (analogue of PG) | enforced by the typed column |
| MSSQL | `NVARCHAR(64)` | `CHECK (col IN ('a','b',…))` |
| Mongo | string | `$jsonSchema` validator with `enum: [...]` |

Notes on the per-dialect emission:

* **Postgres** uses a real type so the value is stored as a 4-byte OID
  rather than the full string. Enum types are schema-scoped — `\dT+`
  in psql lists them. `forge push --enum-as-check` forces the CHECK
  form everywhere if you have a reason to skip the typed enum.
* **MySQL** stores the value as a 1- or 2-byte index into the legal
  set; reads surface the string. The legacy `SET` type is not
  exposed — for multi-value membership use `f.stringArray()` or a
  join table.
* **SQLite / MSSQL** can't enforce a closed set at the column-type
  level, so the constraint rides on a named CHECK clause. `forge
  diff` reports it as a constraint, not as part of the column.
* **DuckDB**'s `ENUM` is closer to Postgres' than MySQL's: a named
  type in the catalog, stored compactly, queryable as a string.
* **Mongo** emits a `$jsonSchema` validator on `forge push` so
  unauthorised writes fail at the server. The validator is write-time
  only; existing rows are not re-checked. See
  [Mongo `$jsonSchema` enforcement](#mongo-jsonschema-enforcement).

---

## Adding a value

Append to the literal tuple in source, redeploy, run `forge push`.
What each dialect actually does:

**Postgres** — `ALTER TYPE "<name>" ADD VALUE 'NEW'`. Cheap; no
table rewrite. The new value can be placed with `BEFORE` / `AFTER`:

```sql
ALTER TYPE "PostStatus" ADD VALUE 'SCHEDULED' BEFORE 'PUBLISHED';
```

Forge appends by default. If you need a specific ordinal position
(because you're relying on `ORDER BY status` to walk a workflow), pass
`{ before: 'PUBLISHED' }` to the field config in source — `forge
push` reads the existing type, computes the ordinal delta, and emits
the right `ADD VALUE` clause. One Postgres quirk worth noting: `ALTER
TYPE … ADD VALUE` is **not** transactional pre-PG12. On 12+ it runs
inside a transaction, but the new value can't be used in the same
transaction it was added in. Practically, `forge push` runs the
`ALTER TYPE` first, commits, then runs any schema migrations that
reference the new value — that ordering is automatic in the migration
runner; it matters if you're hand-writing SQL.

**MySQL** — `ALTER TABLE <t> MODIFY COLUMN <col> ENUM(…full new
tuple…) NOT NULL`. Online on 8.0 with `algorithm=INSTANT` when the new
value is added at the end of the tuple, in-place rebuild otherwise.
Forge always emits the full tuple — that's how MySQL's `MODIFY COLUMN`
takes an enum redefinition.

```sql
ALTER TABLE posts MODIFY COLUMN status
  ENUM('DRAFT','PUBLISHED','ARCHIVED','SCHEDULED') NOT NULL DEFAULT 'DRAFT';
```

The instant-rebuild story breaks if you re-order, insert in the
middle, or change `NOT NULL` / `DEFAULT`. Append-at-end keeps the
operation cheap.

**SQLite** — the CHECK constraint is rebuilt. SQLite has no `ALTER
CONSTRAINT` so `forge push` issues `ALTER TABLE <t> DROP CONSTRAINT
<name>` followed by `ADD CONSTRAINT <name> CHECK (<col> IN (…))`. The
DROP / ADD pair is fast (no rewrite); the cost is acquiring the table
lock briefly. `forge diff` previews the pair before running.

**DuckDB** — `ALTER TYPE <name> ADD VALUE 'NEW'`, same shape as
Postgres. DuckDB's enum types have been alterable since v0.10; on
older builds `forge push` falls back to "create new type, swap column,
drop old type", surfaced in `forge diff` as a multi-step plan.

**MSSQL** — same DROP / ADD CHECK pair as SQLite.

**Mongo** — `collMod` updates the `$jsonSchema` validator in place.
No rewrite.

In every case the existing rows are unaffected: adding a value widens
the legal set, so every old row still passes. The risk is on the
write path — once the new value lives in the schema, application code
needs to know about it. That's a deploy-ordering question: ship the
new enum value in the DB layer first, then update consumers, then
start producing it.

---

## Removing a value — expand / contract

Removing a value is never safe in a single step. Rows that hold the
old value will fail the new constraint on any subsequent write that
re-validates them — and on Postgres, `DROP VALUE` doesn't exist at
all. The pattern is expand / contract:

1. **Stop producing the value.** Deploy the change that prevents new
   rows from writing the soon-removed value. TypeScript at the API
   layer is the cheapest place to enforce this — narrow the input
   union before it ever reaches `db.x.create({ data })`. zod's
   `.enum([...])` works well here.
2. **Migrate existing rows off the value.** A regular `UPDATE`:

   ```ts
   await db.post.updateMany({
     where: { status: { equals: 'LEGACY_DRAFT' } },
     data:  { status: 'DRAFT' },
   });
   ```

   Audit before you ship the schema change: if the count is non-zero,
   the next step will fail.
3. **Drop the value from the schema.** Remove it from the literal
   tuple, redeploy, `forge push`. Per dialect:
   * Postgres — `DROP VALUE` is unsupported. `forge push` creates a
     *new* type with the contracted set, runs `ALTER TABLE <t>
     ALTER COLUMN <col> TYPE <new_type> USING <col>::text::<new_type>`,
     drops the old type. This rewrites the column on disk; on a
     large table, the migration runner switches to an online-DDL
     strategy (pg-online-schema-change-style) when configured.
     Without that, take the lock.
   * MySQL — `ALTER TABLE <t> MODIFY COLUMN <col> ENUM(…contracted…)`.
     In-place when no row violates the new set.
   * SQLite / MSSQL — rebuild the CHECK.
   * DuckDB — create new type, swap column, drop old type.
   * Mongo — `collMod` updates `$jsonSchema`.

This is the same shape as any expand/contract schema migration — see
[VERSIONING.md](./VERSIONING.md) for the broader pattern (rename a
column, change a type, split a table) where the two-phase deploy
applies.

The shortcut "I'll just drop it, no row uses it anyway" works exactly
until the day a concurrent transaction writes the old value between
your audit and your `forge push`. The disciplined version is: lock
out new writes of the value at the application layer (step 1), drain
existing rows (step 2), only then update the schema (step 3). If the
value was added recently and you control every writer, you can
collapse steps 1 and 3 — but you still want the count check in
between.

---

## Reordering values

Postgres preserves enum-value ordinal order — it's a real type with a
defined sort order, and `ORDER BY status` walks the values in the
order they were declared. Reordering matters when the column is
semantically ordered (a workflow: `DRAFT` < `REVIEW` < `PUBLISHED`).

Forge does not rewrite the type to change ordinal order on `push` —
that would require a table rewrite. The supported moves on Postgres:

* **Rename a value, keep its position.** `ALTER TYPE <name> RENAME
  VALUE 'OLD' TO 'NEW'`. Cheap. Existing rows are reinterpreted as
  the new name without a rewrite (the value lives by OID, not by
  string).
* **Insert a new value at a specific position.** `ALTER TYPE <name>
  ADD VALUE 'NEW' BEFORE 'EXISTING'` / `AFTER 'EXISTING'`. Cheap.

What forge will *not* do automatically:

* Reorder existing values. There's no `ALTER VALUE` ordinal-set
  command, and the work-around (create new type with reordered set,
  swap, drop) is a column rewrite. If you need it, write the
  migration by hand and treat it like a remove (expand/contract).

MySQL `ENUM` is also order-sensitive — `ORDER BY status` uses the
declared order, not the alphabetic order of the strings. Same
constraint applies: re-ordering on MySQL is a column rebuild. SQLite,
MSSQL, DuckDB, and Mongo store the value as the string itself, so
`ORDER BY` is lexicographic — declaration order doesn't matter.

The portable advice: if sort order matters across dialects, don't
rely on enum ordinal sort. Store a second integer column (`status,
status_rank`) and order by the rank. The enum stays for the closed
set; the rank carries the order across dialects.

---

## Multiple enums on one model

Nothing special — every field carries its own FieldDef, so multiple
enums coexist:

```ts
const Ticket = model('tickets', {
  id:       f.id(),
  status:   f.enumOf(['OPEN', 'PENDING', 'CLOSED'] as const).default('OPEN'),
  priority: f.enumOf(['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const).default('NORMAL'),
  channel:  f.enumOf(['EMAIL', 'CHAT', 'PHONE'] as const),
});
```

On Postgres / DuckDB, each enum gets its own type: `Ticket_status`,
`Ticket_priority`, `Ticket_channel`. Forge picks the type name as
`<table>_<column>` by default — it's unambiguous and matches what
schema introspection produces. To share a type across tables, declare
it once and pass it by reference (the runtime tuple is the same):

```ts
const Priority = enums(['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const);

const Ticket = model('tickets', {
  id:       f.id(),
  priority: f.enumOf(Priority.values),
});
const Task = model('tasks', {
  id:       f.id(),
  priority: f.enumOf(Priority.values),
});
```

Even with the shared `Priority.values` tuple, forge still emits two
separate Postgres types by default — `Ticket_priority` and
`Task_priority` — because cross-table type sharing complicates the
"drop the column, drop the type" cleanup. If you genuinely want one
named type used by both tables, pass `{ typeName: 'Priority' }` to
the field config; `forge push` then emits a single `CREATE TYPE
"Priority"` and lets both columns reference it.

On MySQL / SQLite / MSSQL the question doesn't arise — there's no
shared type to share. The enum tuple is just text + a constraint
on each column.

---

## Indexing an enum column

An enum column indexes like any scalar — pass it through `options.indexes`
or chain `.unique()`:

```ts
const Order = model('orders', {
  id:        f.id(),
  org_id:    f.objectId(),
  status:    f.enumOf(['PENDING', 'PAID', 'SHIPPED'] as const),
}, {
  indexes: [
    { keys: { status: 1 }, name: 'idx_orders_status' },
    { keys: { org_id: 1, status: 1 }, name: 'idx_orders_org_status' },
  ],
});
```

Cardinality is the catch. An enum with three values across ten
million rows is a textbook bad B-tree candidate — the planner will
fall back to a seq scan most of the time. The compound index
`(org_id, status)` works because it has a high-cardinality prefix.
Same logic on Mongo. Index a low-cardinality column on its own only
when you've measured a workload that benefits.

On Postgres a partial index is often the right move:

```ts
indexes: [
  {
    keys: { id: 1 },
    name: 'idx_orders_pending',
    where: "status = 'PENDING'",
  },
],
```

The index only contains rows where the predicate matches — perfect
for queue-shaped tables where 95% of rows are `SHIPPED` and you only
ever scan for `PENDING`. See [INDEXES.md](./INDEXES.md#partial-indexes)
for the full story.

---

## Enum vs lookup table

Enums are right when the set is closed, small, and changes rarely
through code (a release-managed value). They're the wrong shape when
the set is operator-managed, the row needs metadata beyond a name,
or you want soft-add without a code deploy.

A lookup table is a separate model with its own primary key, plus
columns for whatever the value needs to carry. The relation is a
foreign key:

```ts
const Status = model('statuses', {
  id:           f.id(),
  code:         f.string().unique(),       // 'PENDING', 'PAID', …
  label:        f.string(),                // human label
  color:        f.string(),                // UI hint
  is_terminal:  f.bool(),                  // can transition further?
  sort_order:   f.int(),
});

const Order = model('orders', {
  id:        f.id(),
  status_id: f.objectId(),
}).relate(() => ({
  status: rel.one('status', { on: 'status_id', refs: 'id' }),
}));
```

Pick a lookup table when:

* **Operators add values without a code deploy.** "We sometimes need a
  new shipping carrier" is a lookup-table sign.
* **Each value carries metadata.** Colours, sort order, "is this a
  terminal state?", "does this trigger an email?" — every field you
  want to attach is a column on the lookup row.
* **You query by attribute.** "All non-terminal statuses" is a query
  on `Status.is_terminal`. With an enum you'd hard-code the list in
  application code.
* **Vertical-specific sets.** "Industry verticals" or "country list"
  are operator data, not closed sets. Don't enum them.

Pick an enum when:

* **The set is closed by code.** `'GET' | 'POST' | 'PUT' | 'DELETE'`.
* **Adding a value is a release event.** Workflow states, log levels.
* **The DB needs to enforce the set.** A lookup table can be
  side-stepped (write a `status_id` that doesn't exist) unless an FK
  constraint is in place — enums enforce membership at the type level.

The middle ground — "closed but might grow occasionally" — is best
served by an enum + the [Adding a value](#adding-a-value) flow. Don't
reach for a lookup table just because the set might grow in 18
months. Lookup tables are denormalisation cost forever; you pay an
FK join on every read.

---

## Sort order across dialects

The dialects don't agree on what `ORDER BY <enum>` does:

| Dialect | Sort order |
|---|---|
| Postgres | Declaration order (enum is a real type with defined ordinality). |
| MySQL | Declaration order (`ENUM` is stored as the ordinal index). |
| SQLite | Lexicographic on the stored string. |
| DuckDB | Declaration order (enum type carries the ordinal). |
| MSSQL | Lexicographic on the stored string. |
| Mongo | Lexicographic on the stored string. |

If you have a workflow enum (`DRAFT < REVIEW < PUBLISHED`) and you
order by it on Postgres / MySQL / DuckDB, you get the right order for
free. The same query on SQLite / MSSQL / Mongo sorts the strings —
`DRAFT < PUBLISHED < REVIEW` alphabetically.

The portable pattern is the same as the
[reordering caveat](#reordering-values): if sort order matters across
dialects, carry a separate `<col>_rank` integer and order by the
rank. Three dialects pay nothing for it; three dialects get the
correct order they wouldn't otherwise have.

A common shortcut for read-only consumers: handle the order in
application code (`statuses.sort((a, b) => ORDER[a.status] -
ORDER[b.status])`) instead of the DB. Works fine for small result
sets; falls over at scale where the DB needs to sort before paginating.

---

## Storage size

Per-row enum storage, for a 32-value enum:

| Dialect | Bytes per row |
|---|---|
| Postgres | 4 (OID, fixed regardless of label length) |
| MySQL | 1 (up to 255 values) or 2 (256–65535 values) |
| DuckDB | 1 (up to 255 values), grows with set size |
| SQLite | the string itself (`'PUBLISHED'` is 9 bytes) |
| MSSQL | NVARCHAR(64) overhead + string bytes |
| Mongo | the string itself |

The "store as text" dialects pay the string size per row plus
text-overhead per column. A 50M-row table with a `status TEXT CHECK …`
column storing 8-byte values costs ~400 MB more than the Postgres
equivalent. Short codes (`'pub'` over `'PUBLISHED'`) and page
compression are the mitigations on those dialects. For most apps the
cost is invisible; worth knowing about for the largest tables.

---

## Mongo `$jsonSchema` enforcement

Mongo has no DDL for "this column must be one of these values", but
it does have collection-level validators. Forge emits a
`$jsonSchema` document on `forge push` that includes every enum
field in the model:

```js
{
  $jsonSchema: {
    bsonType: 'object',
    properties: {
      status: {
        bsonType: 'string',
        enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'],
      },
      role: {
        bsonType: 'string',
        enum: ['OWNER', 'ADMIN', 'MEMBER'],
      },
    },
  },
}
```

The validator is set with `collMod` so it can be updated in place
without dropping the collection. Two important properties:

* **Write-time only.** Mongo does not re-check existing documents
  when the validator changes. Documents that hold a value no longer
  in the enum continue to read; the next *update* to that document
  will fail validation. This is the same shape as adding-and-then-
  removing a value: drain first, contract second.
* **`validationLevel`.** Forge sets it to `moderate` by default —
  validates inserts and updates to documents that already pass.
  Documents that don't pass (legacy ones) can be updated without the
  new validator kicking in, so they stay readable. `forge push
  --validation-strict` switches to `strict` if you want every write
  to be checked.

You can read the validator back via `db.runCommand({ listCollections:
1, filter: { name: 'collection-name' } })` — the `options.validator`
key holds the `$jsonSchema`. Useful for verifying that a `forge push`
landed the change you expected.

The validator does not constrain reads, projection, or aggregation —
it's purely a write-path filter. Application-level zod is still the
right place to catch garbage *before* it hits the database, since the
Mongo error on a validator failure is generic
(`Document failed validation`).

---

## zod alongside

The TypeScript literal union is checked at compile time, but external
input is always `string` until you narrow it. zod is the cheap layer
that runs at the API boundary:

```ts
import { z } from 'zod';

const PostStatus = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
const PostStatusSchema = z.enum(PostStatus);

const Post = model('posts', {
  id:     f.id(),
  status: f.enumOf(PostStatus),
});

// HTTP handler
app.post('/posts', async (req, res) => {
  const data = z.object({
    title:  z.string(),
    status: PostStatusSchema,
  }).parse(req.body);

  await db.post.create({ data });
  // ^ data.status is now the literal union, not `string`
});
```

The pattern that doesn't scale: declaring the legal values twice (once
for forge, once for zod) and letting them drift. Pick one source of
truth:

```ts
// Source of truth.
export const PostStatus = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type PostStatus = typeof PostStatus[number];

// Forge.
status: f.enumOf(PostStatus),

// zod.
const PostStatusSchema = z.enum(PostStatus);
```

For the broader "zod at the boundary, CHECK at the DB" trade-off, see
[CHECKS.md](./CHECKS.md#check-vs-zod). The summary: zod stops bad
input at the HTTP handler; the enum's typed-column / CHECK / validator
stops every other writer that might bypass the API.

---

## Worked examples

### (a) Status workflow

A closed workflow with a deterministic order. The order matters for
sorting on Postgres / MySQL / DuckDB; on the other dialects we carry
a parallel rank column.

```ts
import { enums, f, model } from 'forge-orm';

export const TicketStatus = enums([
  'OPEN', 'PENDING', 'RESOLVED', 'CLOSED',
] as const);

const Ticket = model('tickets', {
  id:          f.id(),
  status:      f.enumOf(TicketStatus.values).default('OPEN'),
  status_rank: f.int().dbGenerated(`
    CASE status
      WHEN 'OPEN'     THEN 0
      WHEN 'PENDING'  THEN 1
      WHEN 'RESOLVED' THEN 2
      WHEN 'CLOSED'   THEN 3
    END
  `),
  // Closed-at is only set when status transitions to terminal — enforce
  // the invariant with a CHECK constraint so no writer can leave it
  // inconsistent. See CHECKS.md.
  closed_at:   f.dateTime().optional(),
}, {
  indexes: [
    { keys: { status: 1, created_at: -1 }, name: 'idx_tickets_status_recent' },
  ],
});
```

The transition logic stays in application code (or a trigger). The
enum keeps the column honest about what status values are allowed.

### (b) Priority levels

Four priority levels, shared across two tables. Single namespace
(`Priority`) but separate Postgres types per table — this is the
default for the reason described in
[Multiple enums on one model](#multiple-enums-on-one-model).

```ts
export const Priority = enums(['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const);

const Ticket = model('tickets', {
  id:       f.id(),
  priority: f.enumOf(Priority.values).default('NORMAL'),
});

const Task = model('tasks', {
  id:       f.id(),
  priority: f.enumOf(Priority.values).default('NORMAL'),
});
```

Helpers that take a `Priority` value can use `Priority.URGENT` as the
constant — both runtime check and TS narrowing land in one place:

```ts
function isHighSeverity(p: typeof Priority.values[number]): boolean {
  return p === Priority.HIGH || p === Priority.URGENT;
}
```

### (c) Industry verticals — lookup table instead

"Industry vertical" looks like an enum but isn't. The set grows as
the product moves into new verticals; each vertical carries metadata
(default tax rate, a logo, "is this regulated?"); the marketing team
adds new ones without a release. This is a lookup table:

```ts
const Industry = model('industries', {
  id:                  f.id(),
  code:                f.string().unique(),    // 'retail', 'wholesale', …
  label:               f.string(),
  default_tax_rate:    f.decimal({ precision: 5, scale: 2 }),
  is_regulated:        f.bool(),
  logo_url:            f.string().optional(),
  sort_order:          f.int(),
});

const Organisation = model('organisations', {
  id:          f.id(),
  industry_id: f.objectId(),
}).relate(() => ({
  industry: rel.one('industry', { on: 'industry_id', refs: 'id' }),
}));
```

The trade-off is real — every read of an organisation that needs the
industry now joins (`include: { industry: true }`). But adding a new
vertical is `db.industry.create({ data: { code: 'logistics', … } })`,
not a code release.

### (d) Adding a new value online

A real online-add against Postgres. The flow assumes you've already
deployed application code that knows about the new value (otherwise
you've added a value the API can't accept — wasted DDL).

```ts
// 1. Source change.
export const PostStatus = ['DRAFT', 'PUBLISHED', 'ARCHIVED', 'SCHEDULED'] as const;
```

```bash
# 2. Plan it.
forge diff
# > ADD VALUE 'SCHEDULED' AFTER 'ARCHIVED' on type "Post_status"

# 3. Apply.
forge push
# > ALTER TYPE "Post_status" ADD VALUE 'SCHEDULED' AFTER 'ARCHIVED';
# > OK
```

On Postgres 12+, `forge push` runs the `ALTER TYPE` and commits before
any subsequent DDL that uses the new value — the value-can't-be-used-
in-the-same-transaction quirk. The migration runner handles this
sequencing automatically; you only need to know about it if you're
hand-writing migrations that combine `ADD VALUE` with table changes.

For MySQL, the equivalent `ALTER TABLE … MODIFY COLUMN` redefines the
enum in one statement and is online (instant) when the new value
lands at the end of the tuple. For SQLite / MSSQL, the CHECK
constraint is dropped and re-added in the same migration —
`forge diff` shows the pair; either both succeed or both roll back.

---

## Common mistakes

* **Forgetting `as const`.** `f.enumOf(['DRAFT', 'PUBLISHED'])` (no
  `as const`) widens to `string[]`. TS will complain at the call
  site; if you see "Argument of type 'string[]' is not assignable to
  parameter of type 'readonly string[]'", add `as const` to the
  tuple.
* **Removing a value with rows still using it.** Drop on Postgres
  fails outright; CHECK-based dialects fail on the next write that
  re-validates the row. Drain first, contract second.
* **Re-ordering values mid-flight on Postgres / MySQL.** The DB stores
  ordinality, so reordering a Postgres enum requires a type swap and
  a column rewrite. If you find yourself wanting to reorder, the
  enum probably should have been a lookup table from the start.
* **Indexing a 3-value enum on its own.** The planner will ignore it.
  Index `(high_cardinality_col, status)` or use a partial index
  filtered on the status value.
* **Trusting zod to enforce the DB.** zod catches one writer; the DB
  catches every writer. Use both — zod at the boundary, the typed
  column / CHECK / validator at rest. The
  [CHECKS.md](./CHECKS.md#check-vs-zod) summary applies word-for-word
  to enums.
* **Sharing a Postgres enum type across many tables without
  `typeName`.** Forge defaults to per-column type names so `DROP
  TABLE` cleanly drops the type. If you set a single shared
  `typeName`, dropping the table no longer drops the type — you own
  the lifecycle.
* **Letting the legal-set tuple drift between forge and zod.** One
  source of truth: declare the tuple once, pass it to both
  `f.enumOf` and `z.enum`. The day the two drift is the day a
  legal-at-the-API value fails at the DB write (or vice versa).
