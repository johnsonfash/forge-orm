# Foreign keys

The DDL forge emits for relations — REFERENCES clauses, onDelete/onUpdate behaviors, deferred checking, and per-dialect quirks (Mongo's app-layer references, SQLite's per-connection PRAGMA, MySQL's InnoDB requirement). This page covers what forge writes to the database when you declare a relation, plus the patterns for self-references, cycles, composite FKs, and online FK changes.

[docs/RELATIONS.md](./RELATIONS.md) is the surface tour of the
relation shapes. This document narrows in on the constraint that
comes out the other end — what the database stores, who enforces
it, and what engine knobs the forge surface doesn't expose. If
something here disagrees with the source, the source is right
(`src/schema/types.ts` for the shape, `src/adapters/<dialect>/ddl.ts`
for the emit, `src/adapters/mongo/cascade.ts` for the app-side
walker).

## Contents

* [Relation surface vs FK emit](#relation-surface-vs-fk-emit) · [Per-dialect FK syntax](#per-dialect-fk-syntax)
* [`onDelete` behaviors](#ondelete-behaviors) · [`onUpdate`](#onupdate-and-why-forge-doesnt-expose-it)
* [Deferred constraint checking](#deferred-constraint-checking) · [SQLite PRAGMA](#sqlite-quirks-the-per-connection-pragma) · [MySQL InnoDB](#mysql-innodb-requirement)
* [Mongo cascade walker](#mongo-no-native-fks-the-cascade-walker) · [Soft-delete](#fk-and-soft-delete)
* [Self-referential](#self-referential-fks) · [Composite](#composite-fks) · [Cross-schema](#cross-schema-fks)
* [FK indexes](#fk-indexes-the-child-column-is-on-you) · [Online FK add](#online-fk-add) · [Dropping a FK](#dropping-a-fk) · [Cycles](#cycles-between-tables)
* [Worked examples](#worked-examples) · [Cross-links](#cross-links)

---

## Relation surface vs FK emit

Forge exposes one relation primitive: `rel.one(target, { on, refs, onDelete })`
on the **owning** side. The DDL is a single FK constraint naming
exactly that triple, plus the cascade action.

```ts
import { f, model, rel } from 'forge-orm';

const Post = model('posts', {
  id:        f.id(),
  author_id: f.objectId(),
  title:     f.string(),
}).relate(() => ({
  author: rel.one('user', { on: 'author_id', refs: 'id', onDelete: 'Cascade' }),
}));
```

On the five SQL dialects, that produces a
`FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE`
constraint named `fk_posts_author_id` as part of `forge push`. The
inverse side (`rel.many`) emits nothing — it's virtual. Two
`rel.one`s pointing at each other create a circular dependency; see
[double-FK bug](./RELATIONS.md#the-double-fk-bug) in RELATIONS.

### What the surface does not cover

The surface is deliberately small. It omits `onUpdate`, `MATCH FULL`,
`DEFERRABLE`, `SET DEFAULT`, and composite multi-column FKs. Each
missing knob has a workaround below. The common shape — "child row
points at parent, kill children when parent dies" — is fully
covered.

---

## Per-dialect FK syntax

Every SQL dialect speaks the same standard FK syntax. The forge
emitters in `src/adapters/<dialect>/ddl.ts` produce one of two shapes:
**inline in `CREATE TABLE`** (SQLite, because adding FKs after the
fact requires a full table rebuild) or **`ALTER TABLE ... ADD
CONSTRAINT`** (Postgres, MySQL, DuckDB, MSSQL — these run after every
table exists, so cyclic schemas can be created in any order).

| Dialect  | Emit shape                                                                                                              | Constraint name                  |
|----------|-------------------------------------------------------------------------------------------------------------------------|----------------------------------|
| Postgres | `ALTER TABLE "posts" ADD CONSTRAINT "fk_posts_author_id" FOREIGN KEY ("author_id") REFERENCES "users" ("id") ON DELETE CASCADE` | `fk_posts_author_id`             |
| MySQL    | ``ALTER TABLE `posts` ADD CONSTRAINT `fk_posts_author_id` FOREIGN KEY (`author_id`) REFERENCES `users` (`id`) ON DELETE CASCADE`` | `fk_posts_author_id`             |
| SQLite   | Inline: `FOREIGN KEY("author_id") REFERENCES "users" ("id") ON DELETE CASCADE`                                          | none (anonymous)                 |
| DuckDB   | `ALTER TABLE "posts" ADD CONSTRAINT "fk_posts_author_id" FOREIGN KEY ("author_id") REFERENCES "users" ("id") ON DELETE CASCADE` (accepted; not enforced) | `fk_posts_author_id`             |
| MSSQL    | `ALTER TABLE [posts] ADD CONSTRAINT [fk_posts_author_id] FOREIGN KEY ([author_id]) REFERENCES [users] ([id]) ON DELETE CASCADE` | `fk_posts_author_id`             |
| Mongo    | No emit. App-side walker handles cascade at delete time.                                                                | n/a                              |

### `MATCH FULL` and deferrable

Forge always emits `MATCH SIMPLE` (the SQL default — any null column
skips the FK check) and `NOT DEFERRABLE` (checks per statement). For
single-column FKs `MATCH SIMPLE` is identical to `MATCH FULL`; the
distinction only matters under composite FKs with partial nulls. If
you need either knob, hand-write the constraint via
[`$executeRaw`](./RAW-SQL.md) after `forge push`. See
[Deferred constraint checking](#deferred-constraint-checking) for the
patterns that need deferral.

---

## `onDelete` behaviors

The four actions forge exposes, what each emits, and what the database
does at delete time.

| Action    | Postgres / MySQL / MSSQL / DuckDB              | SQLite                               | Mongo (app-side walker)              |
|-----------|------------------------------------------------|--------------------------------------|--------------------------------------|
| `Cascade` | `ON DELETE CASCADE` — delete child rows        | same (PRAGMA must be on)             | recursive `deleteMany` on children   |
| `SetNull` | `ON DELETE SET NULL` — null the FK column      | same                                 | `updateMany` with `$unset` on the FK |
| `Restrict`| `ON DELETE RESTRICT` — block the delete        | same                                 | precount; throws if any child found  |
| `NoAction`| `ON DELETE NO ACTION` (default)                | same                                 | no-op; orphans stay                  |

### `Cascade`

Deleting the parent removes every child whose FK points at it, in the
same statement (SQL) or in a recursive walk (Mongo / DuckDB).

```ts
const Post = model('posts', { id: f.id(), author_id: f.objectId() })
  .relate(() => ({
    author: rel.one('user', { on: 'author_id', refs: 'id', onDelete: 'Cascade' }),
  }));

await db.user.delete({ where: { id: 'u1' } });
// Every post with author_id = 'u1' is gone.
```

The cascade is silent. If the parent is a hot target for accidental
deletes, pair `Cascade` with `Restrict` on cross-tenant references and
audit deletes via the [event stream](./EVENTS.md).

### `SetNull`

Keeps the orphan row alive with a null FK — audit-style data where the
historical record matters but the reference shouldn't pin the parent's
lifecycle.

```ts
// FK column MUST be nullable.
const Order = model('orders', {
  id: f.id(),
  buyer_id: f.objectId().optional(),
}).relate(() => ({
  buyer: rel.one('user', { on: 'buyer_id', refs: 'id', onDelete: 'SetNull' }),
}));

await db.user.delete({ where: { id: 'u1' } });
// Orders that pointed at u1 now have buyer_id = NULL; the rows survive.
```

`SetNull` on a `NOT NULL` FK is accepted at schema time and fails at
runtime — Postgres raises `null value … violates not-null constraint`.
Always pair `SetNull` with `.optional()`.

### `Restrict`

Blocks the parent delete if any child still references it.

```ts
const Membership = model('memberships', {
  id: f.id(), user_id: f.objectId(), role_id: f.objectId(),
}).relate(() => ({
  role: rel.one('role', { on: 'role_id', refs: 'id', onDelete: 'Restrict' }),
}));

await db.role.delete({ where: { id: 'admin' } });
// Throws — at least one membership still references this role.
```

Use it for roles, plans, currencies, anything referenced from a lot of
rows and shouldn't quietly mass-cascade.

### `NoAction`

The default when `onDelete` is omitted. On SQL it emits
`ON DELETE NO ACTION` — semantically equivalent to `Restrict` on
non-deferrable constraints (forge's default). The distinction only
matters under deferrable constraints, where `RESTRICT` checks at the
statement and `NO ACTION` checks at commit.

On Mongo, `NoAction` is genuinely "do nothing" — children are left as
orphans pointing at a deleted parent.

---

## `onUpdate` and why forge doesn't expose it

The SQL standard supports the same five actions on `ON UPDATE` as on
`ON DELETE`. Forge does not expose `onUpdate` — `f.id()` produces a
stable identifier (cuid / objectid / ulid) and the PK never changes
in normal operation, so every dialect's default `ON UPDATE NO ACTION`
is the right call.

If you genuinely need `ON UPDATE CASCADE` — you picked a natural key
like `email` as the `refs` column and want renames to propagate — add
it after `forge push` via raw DDL:

```ts
await db.$executeRaw`
  ALTER TABLE invitations
    DROP CONSTRAINT fk_invitations_to,
    ADD  CONSTRAINT fk_invitations_to
         FOREIGN KEY (to) REFERENCES users(email)
         ON DELETE CASCADE
         ON UPDATE CASCADE
`;
```

Drop-and-add is necessary because no dialect has an "alter constraint"
verb — you replace it wholesale. Drift detection will flag the
constraint as "extra" on the next `forge push` unless the raw DDL
lives in a migration script.

### `SET DEFAULT`

The SQL standard also defines `ON DELETE SET DEFAULT`. Forge doesn't
expose it; same workaround. MySQL/InnoDB silently treats `SET DEFAULT`
as `NO ACTION` anyway, and the behaviour is rarely useful (children
now point at a tombstone default rather than the deleted parent).

---

## Deferred constraint checking

Forge emits `NOT DEFERRABLE` constraints — the FK check fires at the
end of each statement. That's fine for typical workloads. The case
that bites is **bulk insert into cyclic relations**: two tables with
FKs pointing at each other, where you'd like to insert a batch of A
then a batch of B without re-ordering by FK direction.

Postgres is the only dialect of the five that supports
`DEFERRABLE INITIALLY DEFERRED` — checks moved to commit time. Opt
in via raw DDL:

```ts
await db.$executeRaw`
  ALTER TABLE comments
    DROP CONSTRAINT fk_comments_parent_id,
    ADD  CONSTRAINT fk_comments_parent_id
         FOREIGN KEY (parent_id) REFERENCES comments(id)
         ON DELETE CASCADE
         DEFERRABLE INITIALLY DEFERRED
`;
```

Then bulk-insert inside a transaction:

```ts
await db.$transaction(async (tx) => {
  await tx.comment.createMany({ data: messages });   // refs may not exist yet
  // At COMMIT the deferred check resolves — every parent_id has a row.
});
```

If any row's FK is still unresolved at commit time the whole
transaction rolls back.

**MySQL** has no deferrable constraints. Toggle
`SET FOREIGN_KEY_CHECKS = 0` for the load via `$executeRaw`, then
`= 1` after — accept that the constraint is un-checked during the gap.

**SQLite** has no deferrable constraints either; toggling
`PRAGMA foreign_keys = OFF` suppresses every FK in the connection.
Insert the parent batch first, then the children.

**MSSQL** supports `WITH NOCHECK ADD CONSTRAINT` to add the FK without
validating existing rows but doesn't defer runtime checks.
`NOCHECK CONSTRAINT all` disables for a load — same caveat as MySQL.

**DuckDB** accepts FK DDL but doesn't enforce it, so deferral is moot.

---

## SQLite quirks — the per-connection PRAGMA

SQLite parses FK constraints as part of `CREATE TABLE` but only
enforces them when `PRAGMA foreign_keys = ON` is set. The pragma is
**session-scoped** — every freshly-opened connection starts with it
OFF.

Forge sets the pragma automatically on every connection it opens —
`src/adapters/sqlite/adapter.ts:57` during connect,
`src/adapters/sqlite/migrate.ts:25` during migrations (the pragma is
session-scoped and a freshly-opened DB starts off), and
`src/wasm/worker.ts:95` plus `worker-pro.ts:76` for the browser WASM
workers.

The browser doctor (`src/wasm/browser-doctor.ts:113`) probes
`PRAGMA foreign_keys` on startup and reports `foreign_keys: 1` when
enforcement is active — useful when injecting a custom WASM build.

### What happens if the pragma is off

The FK constraint sits in the schema and is reported by
`PRAGMA foreign_key_list`, but violating inserts succeed silently and
deletes don't cascade. Drift detection still considers the constraint
present, so `forge push` won't try to recreate it — the shape is
correct, the engine just isn't checking. The symptom is "cascades
don't fire, no error" — run `PRAGMA foreign_keys` against the
connection to confirm.

### Custom drivers

Custom SQLite drivers passed via `createDb({ driver })` set the pragma
themselves; forge's built-in `betterSqlite3Driver` wrapper handles it
in `connect`. The fix for an injected driver is one extra line:

```ts
const driver = {
  async connect(url) {
    await db.exec('PRAGMA journal_mode = WAL');
    await db.exec('PRAGMA foreign_keys = ON');         // mandatory
  },
  // ...
};
```

See [docs/SQLITE.md](./SQLITE.md) for the full driver contract.

---

## MySQL InnoDB requirement

MySQL has two storage engines that matter here: **InnoDB** (the
default since 5.5) enforces FKs; **MyISAM** accepts the FK syntax but
ignores the constraint entirely. Forge does not pin the engine in
its `CREATE TABLE` — it inherits whatever
`default_storage_engine` is set to.

Modern MySQL / MariaDB defaults to InnoDB. For legacy tables, check:

```sql
SHOW TABLE STATUS WHERE Name = 'posts';   -- Engine column
ALTER TABLE posts ENGINE = InnoDB;        -- convert if needed
```

Forge has no auto-conversion path. The [doctor probe](./DOCTOR.md)
flags MyISAM tables with FK constraints declared.

### Other InnoDB gotchas

`SET DEFAULT` is silently downgraded to `NO ACTION`.
`FOREIGN_KEY_CHECKS = 0` is per-session and suppresses every
constraint at once — there's no per-constraint toggle. FKs to virtual
generated columns are rejected; stored generated columns are fine.

---

## Mongo — no native FKs, the cascade walker

Mongo has no FK concept at the storage layer. Forge implements the
same `onDelete` semantics application-side via the walker in
`src/adapters/mongo/cascade.ts`. On every `delete` / `deleteMany`, the
walker:

1. Inspects the schema for every owning relation pointing at the
   model being deleted (`rel.one` with matching `target`; inverse-side
   `rel.many` is skipped).
2. For each owning relation with `onDelete: 'Cascade'`, recursively
   collects child rows and deletes them.
3. For each `onDelete: 'SetNull'`, runs `updateMany` with
   `$unset: { <fk>: '' }`.
4. Carries a `visited` set (collection + `_id`) across the recursion
   to break cycles.
5. Walks leaves first — recursive call before the local `deleteMany`,
   so children are gone before parents.

`Restrict` runs a `countDocuments` precount; > 0 throws.

### Atomicity caveat

On standalone Mongo (no replica set) the walker is **best-effort** —
if the second cascade level fails after the first succeeded, the
partial state is left behind. There's no compensating "uncreate"
pass. On a replica set, `db.$transaction` pins every cascade write to
one session and the whole tree commits or aborts together:

```ts
await db.$transaction(async (tx) => {
  await tx.user.delete({ where: { id: 'u1' } });
});
```

### Raw delete bypass

`db.$runCommandRaw` and direct MongoDB driver calls do **not** run
the walker. Raw `deleteMany` on a parent collection leaves children
orphaned.

### Reads still use `$lookup`

Mongo relation reads hydrate via `$lookup` — the relation surface is
identical to SQL. Only writes differ. See
[docs/MONGO.md](./MONGO.md) for the full adapter surface.

### DuckDB falls in the same bucket

DuckDB accepts FK DDL at `CREATE TABLE` time but doesn't enforce the
constraint at runtime — DuckDB is OLAP-shaped and treats relational
integrity as documentation (`src/adapters/duckdb/adapter.ts:23`). The
`nativeCascades: false` capability flag triggers the same app-side
walker on DuckDB that runs on Mongo.

---

## FK and soft-delete

`softDelete()` rewires the model so `db.x.delete` flips a `deleted_at`
column rather than physically removing the row. Because the row stays
in the table, **the FK constraint never fires** — and neither does
the cascade walker.

```ts
const Order = model('orders', {
  id: f.id(), buyer_id: f.objectId().optional(),
  deleted_at: f.dateTime().optional(),
}).softDelete()
  .relate(() => ({
    buyer: rel.one('user', { on: 'buyer_id', refs: 'id', onDelete: 'Cascade' }),
  }));

await db.order.delete({ where: { id: 'o1' } });       // soft — sets deleted_at
await db.order.deleteHard({ where: { id: 'o1' } });   // hard delete + cascade
```

### Cascading soft-deletes

The cascade walker is hard-delete-only by design. Chain the soft-delete
to children manually:

```ts
await db.$transaction(async (tx) => {
  await tx.orderItem.updateMany({
    where: { order_id: orderId },
    data: { deleted_at: new Date() },
  });
  await tx.order.delete({ where: { id: orderId } });
});
```

`Restrict` on a soft-deleted parent is a no-op — the row never goes
away. If you need "can't soft-delete this if children exist," check
the count in application code before calling `delete`. See
[docs/SOFT-DELETE.md](./SOFT-DELETE.md) for the soft-delete surface.

---

## Self-referential FKs

A model with a relation to itself. The FK column lives on the same
table that's referenced.

```ts
const Category = model('categories', {
  id:        f.id(),
  parent_id: f.objectId().optional(),
  name:      f.string(),
}).relate(() => ({
  parent:   rel.one('category',  { on: 'parent_id', refs: 'id', onDelete: 'SetNull' }),
  children: rel.many('category', { on: 'parent_id', refs: 'id' }),
}));
```

`forge push` emits a single `fk_categories_parent_id` constraint
pointing at `categories(id)` — only the owning `rel.one` produces DDL.

### Cascade choice on a tree

On Postgres / MySQL / MSSQL the cascade chain runs in-engine and depth
is bounded only by the recursion limit (~1000 levels). `SetNull` is
the safer default for trees that represent navigation / content —
deleting a category promotes its children to root rather than wiping
the subtree. `Cascade` is fine for audit trees where the children only
make sense alongside their parent.

The Mongo walker's `visited` set (`src/adapters/mongo/cascade.ts:103`)
tracks `(collection, _id)` pairs and skips already-seen rows, so
self-referential cascades terminate.

### Closure tables for fast ancestor queries

Self-referential FKs give you one level of parent at a time. For
ancestor queries use a closure table or the `WITH RECURSIVE` CTE
pattern from
[Self-referential relations](./RELATIONS.md#self-referential-relations).

---

## Composite FKs

The SQL standard supports multi-column FKs. Forge's surface uses
single-column `on` and `refs` strings, so composite FKs aren't
expressible through `rel.one`. The workarounds:

### Option A — flatten with a generated column

Flatten the composite into a deterministic column on both sides.
The unique on the parent is what makes it a valid FK target:

```ts
const Tenant = model('tenants', {
  id:    f.id(),
  scope: f.string(),
  key:   f.string(),
  // Generated column — concatenation of scope + key, used as the FK target.
  compound: f.string().generated((c) => `${c.scope}|${c.key}`),
}).index({ name: 'tenants_compound_uniq', fields: ['compound'], unique: true });

const Resource = model('resources', {
  id:           f.id(),
  tenant_scope: f.string(),
  tenant_key:   f.string(),
  tenant_ref:   f.string().generated((c) => `${c.tenant_scope}|${c.tenant_key}`),
}).relate(() => ({
  tenant: rel.one('tenant', { on: 'tenant_ref', refs: 'compound', onDelete: 'Cascade' }),
}));
```

See [docs/GENERATED-COLUMNS.md](./GENERATED-COLUMNS.md) for the
generated-column surface.

### Option B — raw composite FK after push

For schemas you don't want to flatten, emit the composite FK via
`$executeRaw` after the tables exist:

```ts
await db.$executeRaw`
  ALTER TABLE resources
    ADD CONSTRAINT fk_resources_tenant
      FOREIGN KEY (tenant_scope, tenant_key)
      REFERENCES tenants(scope, key)
      ON DELETE CASCADE
`;
```

The constraint won't show up in forge's relation graph — `include`,
filters, and the cascade walker don't know about it — but the
database enforces it. `forge push` won't flag this as drift on
Postgres / MySQL / MSSQL; the introspector ignores constraints it
didn't emit. On SQLite, any extra FK shows as drift — see
[docs/SQLITE.md](./SQLITE.md) for the suppression pattern.

### Option C — app-layer validation

Validate at write time inside a transaction — the only option on Mongo,
where the walker is single-column:

```ts
await db.$transaction(async (tx) => {
  const parent = await tx.tenant.findUnique({
    where: { scope_key: { scope: 's', key: 'k' } },
  });
  if (!parent) throw new Error('tenant not found');
  await tx.resource.create({ data: { tenant_scope: 's', tenant_key: 'k', ... } });
});
```

---

## Cross-schema FKs

Postgres supports FKs across schemas of the same database. Forge's
`rel.one` names a target schema key, not a fully qualified table; the
emitter resolves the target via the runtime schema
(`src/adapters/postgres/ddl.ts:263`) and emits an unqualified
reference, which Postgres resolves via the search path.

**Cross-database** FKs — referencing a table in a different database,
even on the same cluster — are not supported by any dialect. FKs are
intra-database only. The workarounds:

* Logical separation (different schemas, same database) — FK works.
* Physical separation (different database, same cluster) — FK
  doesn't work; maintain integrity in application code.
* Different cluster / region — FK doesn't fit; you're in
  eventual-consistency territory.

Mongo's walker calls `dbClient.db.collection(name)` against the
single database the connection points at; splitting schema across
Mongo databases means cascade can't reach across. MSSQL allows
three-part names (`database.schema.table`) but the FK syntax doesn't
support crossing databases.

---

## FK indexes — the child column is on you

The trap that most often shows up as "delete is slow."

Every dialect auto-indexes the **parent column** (the referenced PK
or unique). None of them auto-index the **child column** — the FK
column on the owning side. Without an index there, every parent
delete has to full-scan the child table to find rows to cascade /
restrict / null. For tiny tables you don't notice; for a `posts`
table with millions of rows, deleting a single user fires a
sequential scan against `posts(author_id)`.

### The fix

Declare an explicit index on the FK column:

```ts
const Post = model('posts', {
  id:        f.id(),
  author_id: f.objectId(),
})
  .index({ name: 'posts_author_id_idx', fields: ['author_id'] })
  .relate(() => ({
    author: rel.one('user', { on: 'author_id', refs: 'id', onDelete: 'Cascade' }),
  }));
```

The index name follows the `<table>_<col>_idx` convention. See
[docs/INDEXES.md](./INDEXES.md) for the full index surface.

### Per-dialect specifics

**MySQL InnoDB** is the exception — it auto-creates an index on the FK
column. Postgres / SQLite / MSSQL do not; declare manually. DuckDB
doesn't index for OLTP-style point lookups anyway. **Mongo** — the
walker uses `find({ <fk>: { $in: [...] } })`; declare via
`.index({ keys: { <fk>: 1 } })` on any non-tiny child collection.

The forge doctor surfaces missing FK indexes on Postgres and MySQL —
a FK column with no covering index is flagged. See
[docs/DOCTOR.md](./DOCTOR.md#fk-index-probe).

---

## Online FK add

Adding a FK to an existing table is mostly online on modern dialects,
with one big caveat per dialect.

### Postgres — `NOT VALID` + `VALIDATE`

The two-step pattern. Step 1 takes a short lock to add the
constraint without validating existing rows; new inserts are checked
from now. Step 2 validates existing rows under a `SHARE UPDATE
EXCLUSIVE` lock — concurrent reads and writes continue:

```ts
await db.$executeRaw`
  ALTER TABLE posts
    ADD CONSTRAINT fk_posts_author_id
    FOREIGN KEY (author_id) REFERENCES users(id)
    ON DELETE CASCADE
    NOT VALID
`;
await db.$executeRaw`ALTER TABLE posts VALIDATE CONSTRAINT fk_posts_author_id`;
```

If validation finds an orphan it errors and the constraint stays
`NOT VALID`. Fix the orphans and retry. Forge's standard `forge push`
emits the full constraint at table create — `NOT VALID` is the
online path for existing tables. The constraint name has to match
what forge would emit so drift detection doesn't try to re-add it.

### MySQL — online DDL by default

Adding a FK on InnoDB is online since 5.6 (`ALGORITHM=INPLACE`,
concurrent DML allowed, brief metadata lock at start and end). If
orphan rows exist the `ALTER` errors and rolls back. Backfill /
delete the orphans first; `FOREIGN_KEY_CHECKS = 0` skips validation
but leaves bad data behind.

### SQLite — full rebuild

SQLite's `ALTER TABLE` doesn't support adding constraints. The
official workaround is a full table rebuild:

```sql
BEGIN;
CREATE TABLE posts_new (
  id TEXT PRIMARY KEY,
  author_id TEXT,
  title TEXT,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
);
INSERT INTO posts_new SELECT * FROM posts;
DROP TABLE posts;
ALTER TABLE posts_new RENAME TO posts;
COMMIT;
```

For large databases the `INSERT ... SELECT` blocks writes. Forge does
not auto-orchestrate the rebuild — `forge push` surfaces the missing
FK as drift and asks you to acknowledge it. The rebuild is a manual
migration script.

### MSSQL — `WITH NOCHECK`

Add the constraint without validating existing rows, then validate
out of band:

```sql
ALTER TABLE posts
  WITH NOCHECK ADD CONSTRAINT fk_posts_author_id
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE posts WITH CHECK CHECK CONSTRAINT fk_posts_author_id;
```

Untrusted constraints aren't used by the optimizer for join
elimination, so the trusted state matters for plans even though it
doesn't matter for correctness.

### DuckDB / Mongo

DuckDB accepts the DDL but doesn't enforce — the addition is metadata
only. Mongo has no DDL; the cascade walker reads the schema at
delete time, so a new relation participates as soon as the deploy
ships. Existing orphans are left alone.

---

## Dropping a FK

Mostly safe and online — it's a catalog update only, no data is
touched. Postgres / MSSQL use `DROP CONSTRAINT`; MySQL uses
`DROP FOREIGN KEY`:

```ts
await db.$executeRaw`ALTER TABLE posts DROP CONSTRAINT fk_posts_author_id`;   // pg / mssql
await db.$executeRaw`ALTER TABLE posts DROP FOREIGN KEY fk_posts_author_id`;  // mysql
```

`forge push` will re-add the constraint on the next run if the
relation is still in the schema — drop the relation first. SQLite
needs the same rebuild dance as adding. DuckDB accepts
`DROP CONSTRAINT` with no data effects. On Mongo, remove the
relation from the schema; the walker stops following it on the next
deploy.

---

## Cycles between tables

Two tables where each owns a FK pointing at the other — a `users`
table with `current_org_id` pointing at `orgs`, and an `orgs` table
with `owner_user_id` pointing at `users`. The chicken-and-egg insert
problem: you can't insert a user without an org id, can't insert an
org without an owner user id.

**1. Make one side nullable.** The "true" creator side is null at
insert and filled in by a follow-up update inside a transaction:

```ts
const User = model('users', { id: f.id(), current_org_id: f.objectId().optional() })
  .relate(() => ({
    current_org: rel.one('org', { on: 'current_org_id', refs: 'id', onDelete: 'SetNull' }),
  }));

const Org = model('orgs', { id: f.id(), owner_id: f.objectId() })
  .relate(() => ({
    owner: rel.one('user', { on: 'owner_id', refs: 'id', onDelete: 'Restrict' }),
  }));

await db.$transaction(async (tx) => {
  const user = await tx.user.create({ data: { current_org_id: null } });
  const org  = await tx.org.create({ data: { owner_id: user.id } });
  await tx.user.update({ where: { id: user.id }, data: { current_org_id: org.id } });
});
```

Each statement is individually valid — the null on user is fine
because the FK column is nullable, and the org's owner_id points at
a user that already exists.

**2. Deferred constraints (Postgres only).** Drop the non-deferrable
constraint and re-add as `DEFERRABLE INITIALLY DEFERRED`. The check
runs at commit; both sides can be inserted in any order inside a
transaction. See
[Deferred constraint checking](#deferred-constraint-checking).

**3. Drop the cycle.** Most cycles indicate a domain modeling miss —
"current org" is usually better as a `memberships` table with a
`primary` flag than as a column on `users`. Refactoring is the
long-term fix; the patterns above are short-term unblock.

Cycles plus `Cascade` on both sides would loop forever without the
`visited` set in the Mongo walker
(`src/adapters/mongo/cascade.ts:103`) — it tracks
`(collection, _id)` pairs and terminates after one round each side.

---

## Worked examples

### (a) Post.user_id references User.id ON DELETE CASCADE

The canonical one-to-many with cascade, plus the explicit FK index
that keeps deletes fast at scale.

```ts
import { f, model, rel } from 'forge-orm';

const User = model('users', {
  id: f.id(), email: f.string().unique(), name: f.string(),
}).relate(() => ({
  posts: rel.many('post', { on: 'author_id', refs: 'id' }),
}));

const Post = model('posts', {
  id: f.id(), author_id: f.objectId(),
  title: f.string(), body: f.text(),
  created_at: f.dateTime().default('now'),
})
  .index({ name: 'posts_author_id_idx', fields: ['author_id'] })
  .relate(() => ({
    author: rel.one('user', { on: 'author_id', refs: 'id', onDelete: 'Cascade' }),
  }));
```

`forge push` emits:

```sql
-- Postgres
ALTER TABLE "posts" ADD CONSTRAINT "fk_posts_author_id"
  FOREIGN KEY ("author_id") REFERENCES "users" ("id")
  ON DELETE CASCADE;
CREATE INDEX "posts_author_id_idx" ON "posts" ("author_id");
```

Without the explicit index, `DELETE FROM users WHERE id = ?` has to
scan every row in `posts` to find children to cascade.

### (b) Tree — Category.parent_id

Self-referential with `SetNull` so deleting a category promotes its
children to root rather than wiping the subtree.

```ts
const Category = model('categories', {
  id:        f.id(),
  parent_id: f.objectId().optional(),
  name:      f.string(),
})
  .index({ name: 'categories_parent_id_idx', fields: ['parent_id'] })
  .relate(() => ({
    parent:   rel.one('category',  { on: 'parent_id', refs: 'id', onDelete: 'SetNull' }),
    children: rel.many('category', { on: 'parent_id', refs: 'id' }),
  }));
```

Loading the tree manually (breadth-first) or via `WITH RECURSIVE` —
both patterns covered in the
[Self-referential relations](./RELATIONS.md#self-referential-relations)
section of RELATIONS.

### (c) Composite FK via generated column

Flatten the composite into a deterministic string and FK against
that. The unique on the parent's compound column makes it a valid
FK target. See [Composite FKs](#composite-fks) for the shape; option
B (raw DDL after push) for composites that resist flattening.

### (d) Mongo app-layer reference enforcement

Mongo has no FK enforcement at the storage layer. The cascade walker
handles deletes, but inserts referencing a missing parent succeed
silently. Validate in application code for parent-must-exist
semantics on writes:

```ts
async function createPost(authorId: string, data: PostInput) {
  return db.$transaction(async (tx) => {
    const author = await tx.user.findUnique({ where: { id: authorId } });
    if (!author) throw new Error(`unknown author: ${authorId}`);
    return tx.post.create({ data: { ...data, author_id: authorId } });
  });
}
```

On a replica set the transaction pins both the read and write to one
session. For constant integrity, run a periodic reconciliation:

```ts
const orphans = await db.post.aggregate([
  { $lookup: { from: 'users', localField: 'author_id', foreignField: '_id', as: '_author' } },
  { $match: { _author: { $size: 0 } } },
  { $project: { _id: 1 } },
]);
```

The same shape works on DuckDB — application-layer integrity is the
only guarantee on either adapter.

---

## Cross-links

* [RELATIONS](./RELATIONS.md) — relation shapes, `rel.one` / `rel.many`,
  nested writes, the four cascade actions on the surface.
* [MODEL](./MODEL.md) — `model(...)`, `f.id()` / `f.objectId()`, how
  PKs flow into FK columns.
* [MIGRATIONS](./MIGRATIONS.md) — `forge push`, drift detection, FK
  add / drop / change in the schema vs the live DB.
* [SOFT-DELETE](./SOFT-DELETE.md) — `softDelete()`, the `deleted_at`
  column, why FK cascades don't fire on soft delete, `deleteHard`.
* [INDEXES](./INDEXES.md) — the `index` surface for FK column
  indexes (the child column is on you).
* [SQLITE](./SQLITE.md) — custom drivers, `PRAGMA foreign_keys`, the
  rebuild dance for online FK changes.
* [MONGO](./MONGO.md) — the cascade walker, replica-set requirement
  for atomic cascades, `$lookup` for relation reads.
