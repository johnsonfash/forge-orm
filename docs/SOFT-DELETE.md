# Soft delete

`softDelete` and `restore` give you reversible deletes — a `deletedAt` timestamp instead of a destructive DELETE. forge-orm wires partial-filter indexes, query-time defaults, and per-dialect emit to make soft-delete safe across all six adapters.

The [Soft delete](../README.md#soft-delete) section of the README is the
short tour. This page is the full reference for how the column declaration
plumbs through to reads, writes, indexes, events and the compile API, plus
the operational patterns that keep soft-delete from rotting over time.

## Contents

* [What soft delete is](#what-soft-delete-is)
* [Declaring the column](#declaring-the-column)
* [`softDelete` and `restore`](#softdelete-and-restore)
* [Query-time defaults](#query-time-defaults)
* [Partial-filter indexes](#partial-filter-indexes)
* [Cascading soft deletes](#cascading-soft-deletes)
* [Restore semantics](#restore-semantics)
* [Hard delete after retention](#hard-delete-after-retention)
* [Per-dialect emit](#per-dialect-emit)
* [Events and audit interaction](#events-and-audit-interaction)
* [GDPR and right-to-be-forgotten](#gdpr-and-right-to-be-forgotten)
* [Search and vector index interaction](#search-and-vector-index-interaction)
* [Browser sqlite-wasm](#browser-sqlite-wasm)
* [Worked patterns](#worked-patterns)
* [Anti-patterns](#anti-patterns)
* [See also](#see-also)

---

## What soft delete is

A soft delete is a write that *marks* a row as deleted rather than
removing it. Instead of `DELETE FROM posts WHERE id = $1`, the row stays
on disk with a timestamp stamped into one column — usually called
`deleted_at` — and every subsequent read filters that column out.

The properties that fall out:

* **Recoverable.** A soft-deleted row can be restored by clearing the
  timestamp. A hard-deleted row is gone (modulo PITR / backups).
* **Auditable.** The row is still in the table; you can see *what* was
  deleted and *when*, without joining to an audit log.
* **Cascade-aware in app code.** Children of a soft-deleted parent can
  be soft-deleted in the same call, so the graph stays consistent.
* **Not free.** Indexes still cover the tombstones, uniqueness constraints
  still match against them, and every read pays a `WHERE deleted_at IS
  NULL` predicate. The fixes — partial-filter uniques and an index on
  `deleted_at` itself — are below.
* **Not erasure.** A row with `deleted_at` set is still personal data.
  GDPR's right-to-be-forgotten requires hard delete or anonymisation —
  see [GDPR and right-to-be-forgotten](#gdpr-and-right-to-be-forgotten).

forge keeps the model surface explicit: a `delete()` call always hard
deletes; the recoverable verb is named `softDelete()`. The two are
different statements at the wire — there is no "is this soft-delete or
hard-delete?" depending on the model shape.

---

## Declaring the column

One field on the model, marked with `.softDeleteAt()`:

```ts
const Post = model('posts', {
  id:         f.id(),
  title:      f.string(),
  body:       f.string(),
  deleted_at: f.dateTime().softDeleteAt(),
});
```

`.softDeleteAt()` does three things:

1. Forces the column optional (it is `null` until the row is soft-deleted —
   even if you wrote `.dateTime()` without `.optional()`, the chainable
   modifier flips the flag for you).
2. Marks the field on the IR so the wrapper can find it (`(field as any)
   .softDeleteAt === true`).
3. Tags the model as participating in soft-delete: reads filter, the
   `softDelete` / `restore` verbs are valid, and the runtime emits
   `semanticOp` on the resulting `QueryEvent`.

Exactly one per model. The wrapper finds it by iterating
`Object.entries(model.fields)` and picking the first column whose
`softDeleteAt` flag is set — declare it twice and only the first wins,
which is a footgun worth avoiding.

The column name itself is free. `deleted_at`, `deletedAt`,
`removed_at`, `archived_at`, `tombstoned_at` — all valid. The wrapper
doesn't pattern-match the name; it reads the flag.

### Type

Use `f.dateTime()` (timestamp with millisecond precision). A boolean —
`is_active`, `is_deleted` — works for the filter but loses *when*, which
matters for cascade decisions, retention policies, and audit reads. See
[Anti-patterns](#anti-patterns).

---

## `softDelete` and `restore`

Four verbs on every collection wrapper:

| Verb              | `where`         | Returns           | Notes                                  |
|-------------------|-----------------|-------------------|----------------------------------------|
| `softDelete`      | unique selector | the updated row   | throws if no row matched               |
| `softDeleteMany`  | any filter      | `{ count }`       | zero matches is a no-op                |
| `restore`         | unique selector | the updated row   | throws if no row matched               |
| `restoreMany`     | any filter      | `{ count }`       | zero matches is a no-op                |

Same asymmetry as `update` vs `updateMany` — see
[docs/MUTATIONS.md](./MUTATIONS.md#update-vs-updatemany).

```ts
await db.post.softDelete({ where: { id: 'p1' } });
await db.post.softDeleteMany({ where: { author_id: 'u9' } });

await db.post.restore({ where: { id: 'p1' } });
await db.post.restoreMany({ where: { author_id: 'u9' } });
```

Each verb compiles to a regular `update` / `updateMany` against the same
table, with the soft-delete column as the only changed field:

* `softDelete` → `data: { [sd]: new Date() }`
* `restore`    → `data: { [sd]: null }`

The wrapper goes through its own `update` path so `select`, `include`,
`omit`, and the `QueryEvent` plumbing all behave identically. The one
difference is the `semanticOp` field on the event — see
[Events and audit interaction](#events-and-audit-interaction).

### What gets thrown

Calling any of the four soft-delete verbs on a model with **no**
`.softDeleteAt()` column throws synchronously:

```
[forge] softDelete() requires a field declared with .softDeleteAt() on
'audit_logs'. Either add one, or use delete() for a hard delete.
```

This is the gate that keeps you from accidentally writing a soft-delete
to a model that doesn't support it. It triggers before the wire call —
no half-applied update.

### `softDelete` reaches across the read filter

`softDelete` (and `restore`) skip the auto-filter that hides
soft-deleted rows from reads. That's deliberate: restoring a row whose
`deleted_at` is set requires *finding* it, and a strict filter would
make that impossible. So:

* `softDelete({ where: { id } })` works whether or not the row is
  already soft-deleted (idempotent at the row level; re-stamps
  `deleted_at`).
* `restore({ where: { id } })` finds the soft-deleted row directly —
  the read filter is bypassed for these verbs.

If you need to know "was this row already soft-deleted?", do a
`findFirst({ where: { id, _withDeleted: true } })` first.

---

## Query-time defaults

Every read against a model with a `.softDeleteAt()` field has
`WHERE <sd> IS NULL` appended to its `where` clause — by default, you
never see soft-deleted rows.

Affected verbs:

* `findFirst`, `findFirstOrThrow`
* `findUnique`, `findUniqueOrThrow`
* `findMany`
* `findManyStream` (see [docs/QUERIES.md](./QUERIES.md#findmanystream))
* `count`
* `aggregate` (Mongo only — pipeline `$match` is augmented)

The augmentation is suppressed in three cases:

1. **`_withDeleted: true`** — the explicit opt-in:
   ```ts
   await db.post.findMany({ where: { _withDeleted: true } });
   ```
   The wrapper strips `_withDeleted` from the `where` before building the
   IR; the rest of the filter passes through.
2. **You filtered the column yourself.** If the `where` already mentions
   the soft-delete column — e.g. `where: { deleted_at: { not: null } }`
   for an admin "trash" view — the auto-filter is skipped. Your filter
   wins.
3. **The verb is a write that bypasses the read filter.** `softDelete`,
   `restore`, `update`, `delete`, and all the other write verbs do not
   apply the read filter — by design. `update({ where: { id } })` on a
   soft-deleted row still hits the row.

`_withDeleted` is a real key on `WhereInput` (declared in the strict-mode
allow-list alongside `AND`, `OR`, `NOT`). Pass it on any read; the
wrapper strips it before IR build.

### Strict mode and `_withDeleted`

When the database is created with `createDb({ strict: true })`, unknown
`where` keys throw. `_withDeleted` is on the strict allow-list, so it
passes — you can use it on any model. (On a model with no
`.softDeleteAt()` column it's a no-op — the wrapper has nothing to
filter.)

### Including soft-deleted via relations

`include` and nested `select` traverse relations, and the soft-delete
filter applies recursively:

```ts
// User's *active* posts only — soft-deleted posts are hidden.
const user = await db.user.findUnique({
  where:   { id: 'u1' },
  include: { posts: true },
});

// User's *all* posts, including soft-deleted.
const user = await db.user.findUnique({
  where:   { id: 'u1' },
  include: {
    posts: { where: { _withDeleted: true } },
  },
});
```

Each `include` level is treated as its own read for the purpose of
auto-filtering.

---

## Partial-filter indexes

A `UNIQUE` constraint that ignores soft-deleted rows is the canonical
companion to a soft-delete column. Without it, a soft-deleted row's slug
permanently blocks any other row from claiming the same slug — the
tombstone holds the key.

The fix is a partial-filter unique index: unique on `slug`, but only
*where `deleted_at IS NULL`*. Forge supports the cross-dialect form on
the model:

```ts
const Post = model('posts', {
  id:         f.id(),
  slug:       f.string(),
  deleted_at: f.dateTime().softDeleteAt(),
}, {
  indexes: [{
    keys: { slug: 1 }, unique: true,
    where: 'deleted_at IS NULL',                        // SQL dialects
    partialFilterExpression: { deleted_at: null },      // Mongo
  }],
});
```

If both `where:` and `partialFilterExpression:` are set, each dialect
picks the one it understands. If only one is set, forge translates where
it can; see [docs/INDEXES.md](./INDEXES.md#partial-filter-indexes) for
the operator coverage of the object-form-to-SQL translator.

### Per-dialect emit

| Dialect  | DDL                                                                                            |
|----------|------------------------------------------------------------------------------------------------|
| Postgres | `CREATE UNIQUE INDEX … ON "posts" ("slug" ASC) WHERE deleted_at IS NULL`                       |
| SQLite   | same as Postgres                                                                                |
| DuckDB   | same as Postgres                                                                                |
| MSSQL    | `CREATE UNIQUE INDEX … ON [posts] ([slug] ASC) WHERE [deleted_at] IS NULL`                     |
| MySQL    | `CREATE UNIQUE INDEX … ON posts ((CASE WHEN (deleted_at IS NULL) THEN slug ELSE NULL END))`    |
| Mongo    | `createIndex({ slug: 1 }, { unique: true, partialFilterExpression: { deleted_at: null } })`    |

MySQL has no native partial index, so the unique is rewritten as a
functional unique over a `CASE` expression — rows whose `deleted_at` is
**not** null collapse to `NULL` in the indexed expression, and MySQL
treats `NULL`s as non-duplicates. Composite keys use `JSON_ARRAY(col1,
col2)` inside the `THEN` for portability.

Non-unique partials on MySQL warn and ship without the filter (no clean
workaround). See [docs/INDEXES.md](./INDEXES.md#mysql-workaround) for
the full caveat.

### Indexing `deleted_at` itself

The `WHERE deleted_at IS NULL` predicate that the wrapper appends to
every read benefits from a plain index on the soft-delete column when the
table is large and the fraction of soft-deleted rows is small enough to
matter to the optimiser:

```ts
indexes: [
  { keys: { deleted_at: 1 } },  // covers the auto-filter
],
```

On Postgres / SQLite / DuckDB you can go further: an index whose key is
the column you actually filter on, plus a partial filter, often beats a
plain index on `deleted_at`:

```ts
// Index posts you'll actually read — active ones.
indexes: [
  { keys: { author_id: 1, created_at: -1 }, where: 'deleted_at IS NULL' },
],
```

The tombstones don't enter the index at all, so it stays compact even as
deletes accumulate.

---

## Cascading soft deletes

`onDelete: 'Cascade'` on a `rel.one` declaration cascades a **hard
delete** through the foreign key (see
[docs/RELATIONS.md](./RELATIONS.md#cascade-rules)). It does *not* cascade
a soft delete — the database has no idea the parent row was
soft-deleted; it just sees an `UPDATE`.

So cascading soft-delete is application-side. Three shapes:

### 1. Manual cascade

The straightforward version — soft-delete the children explicitly in the
same call:

```ts
async function softDeleteUser(userId: string) {
  await db.$transaction(async (tx) => {
    await tx.post.softDeleteMany({ where: { author_id: userId } });
    await tx.comment.softDeleteMany({ where: { author_id: userId } });
    await tx.user.softDelete({ where: { id: userId } });
  });
}
```

All three writes are inside one transaction, so either everything
soft-deletes or nothing does. Child rows are stamped first, parent last —
the order doesn't matter for soft-delete (no FK is being broken), but
parent-last reads cleanly when you scan back.

### 2. Mongo cascade walker

On Mongo, the same shape, but the `$transaction` requires a replica-set
session. Outside one, the writes are best-effort and forge surfaces a
warning. See [docs/MUTATIONS.md](./MUTATIONS.md#write-order-and-transactionality).

### 3. Trigger-based (Postgres / MSSQL only)

For schemas where the cascade graph is fixed and large, a database
trigger on the parent's `deleted_at` keeps the cascade out of
application code. Pros: enforced at the database, not subject to
forgotten call-sites. Cons: hidden from the application; ORM events
don't fire for the cascaded writes; harder to test. Lift to a trigger
only when the cascade is hot enough that the application-side overhead
matters.

---

## Restore semantics

`restore` sets the column to `null`. The row is active again, indexes
recover it, reads see it.

The semantics worth being deliberate about:

* **Restore does not auto-cascade.** A user soft-deleted with the
  cascade above is restored by a `restore({ where: { id } })` on the
  user — but the children stay soft-deleted unless you restore them too.
  Same shape as the cascade:

  ```ts
  await db.$transaction(async (tx) => {
    await tx.user.restore({ where: { id: userId } });
    await tx.post.restoreMany({ where: { author_id: userId } });
    await tx.comment.restoreMany({ where: { author_id: userId } });
  });
  ```

* **Restore is not idempotent at the value level.** Restoring an
  already-active row sets `deleted_at` from `null` to `null` — a no-op
  in effect, but the `update` still runs, the `updated_at` (if any) is
  bumped, and the event still fires. If "restore only if currently
  soft-deleted" matters, use `restoreMany({ where: { id, deleted_at: {
  not: null } } })` and inspect `count`.

* **Restore on a unique-violation column can fail.** If you restore a
  row whose `slug` now collides with an active row that took its
  place — because the partial-unique only blocked the *active* one —
  the underlying `UPDATE` fails with the dialect's unique-violation
  error. Handle it the same way you'd handle any unique-violation:
  catch, prompt the user for a new slug, retry.

* **Restoring a child without its parent.** If the parent was
  hard-deleted, restoring the child leaves a dangling FK on SQL (which
  the FK constraint will reject) or an orphaned reference on Mongo. Lift
  the parent check above the restore, or refuse the restore.

---

## Hard delete after retention

Soft-deleted rows accumulate. Without a purge, the table grows
forever and the partial-filter indexes carry an ever-bigger tombstone
set. Retention turns soft-delete into a fixed-cost feature.

The pattern is a periodic hard-delete keyed on `deleted_at < cutoff`:

```ts
// Daily cron — purge soft-deleted rows older than 90 days.
async function purgeOldSoftDeletes() {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const { count } = await db.post.deleteMany({
    where: {
      deleted_at: { lt: cutoff },
      _withDeleted: true,                 // bypass the read filter
    },
  });
  log.info('soft-delete purge', { model: 'post', purged: count, cutoff });
}
```

`_withDeleted: true` is required — without it, the auto-filter rewrites
`where` to `deleted_at IS NULL AND deleted_at < cutoff`, which matches
nothing.

### Chunked purge for large tables

For tables with millions of tombstones, a single `deleteMany` holds the
write lock for the duration of the scan. Page by id in chunks of
1,000 — `findMany({ select: { id: true }, take: 1000 })` followed by a
`deleteMany({ where: { id: { in: ids }, _withDeleted: true } })`, looped
until the page returns short. The retention window is your call: 30 /
60 / 90 days are common; longer when regulatory recovery is in play,
shorter for high-churn tables.

### Purge fires cascades

`deleteMany` is a hard delete and runs `onDelete: 'Cascade'` —
children of the purged parent are gone too. If the parent's cascade
targets are also soft-delete tables, this *hard*-deletes them across
their soft-delete column without going through `softDelete`. That's
usually what you want (they were already soft-deleted) but worth
checking against your retention policy per table.

---

## Per-dialect emit

Every soft-delete verb compiles to a regular `update` statement, so the
dialect emit is identical to the regular `update` table in
[docs/MUTATIONS.md](./MUTATIONS.md#update-vs-updatemany) — with the
soft-delete column as the only field in `SET …`.

| Adapter   | `softDelete({ where: { id: 'p1' } })` compiles to                                |
|-----------|----------------------------------------------------------------------------------|
| postgres  | `UPDATE "posts" SET "deleted_at" = $1 WHERE "id" = $2 RETURNING *`               |
| mysql     | `UPDATE \`posts\` SET \`deleted_at\` = ? WHERE \`id\` = ?` + `SELECT`            |
| sqlite    | `UPDATE "posts" SET "deleted_at" = ? WHERE "id" = ? RETURNING *`                 |
| duckdb    | `UPDATE "posts" SET "deleted_at" = ? WHERE "id" = ? RETURNING *`                 |
| mssql     | `UPDATE [posts] SET [deleted_at] = @p1 OUTPUT INSERTED.* WHERE [id] = @p2`       |
| mongo     | `findOneAndUpdate({ _id: 'p1' }, { $set: { deleted_at: <Date> } })`              |

`softDeleteMany` and `restoreMany` follow the same shape as `updateMany`
on every dialect — count-returning, no `RETURNING` / `OUTPUT`.

### Via the compile API

The compile API exposes the same four verbs:

```ts
const c = db.post.compile.softDelete({ where: { id: 'p1' } });
// c.kind === 'sql', c.sql === 'UPDATE "posts" SET "deleted_at" = $1 WHERE "id" = $2 RETURNING *'
// c.params === [<Date>, 'p1']
// c.semanticOp === 'softDelete'
```

`semanticOp` lands on both `SQLArtifact` and `MongoArtifact` for the
four verbs, so downstream tooling (replay, audit, dry-run) can branch on
intent without parsing the SQL or the update document. Plain `update`
artifacts don't have `semanticOp`. See [docs/QUERIES.md](./QUERIES.md)
for the full compile-API reference.

The compile variants throw synchronously when the model has no
`.softDeleteAt()` field — same gate as the runtime wrapper, just at
compile time instead of dispatch time.

---

## Events and audit interaction

Every soft-delete write emits a regular `'update'` `QueryEvent` — the
underlying statement is an `UPDATE`. What sets it apart is the
`semanticOp` field:

```ts
db.$on('query', (e) => {
  if (e.semanticOp === 'softDelete' || e.semanticOp === 'softDeleteMany') {
    auditSoftDelete(e);
    return;
  }
  if (e.semanticOp === 'restore' || e.semanticOp === 'restoreMany') {
    auditRestore(e);
    return;
  }
  // ... regular update logging
});
```

`semanticOp` carries `'softDelete' | 'softDeleteMany' | 'restore' |
'restoreMany'` for the four verbs and is absent on plain `update` /
`upsert`. Listeners that don't care about the intent ignore the field;
listeners that audit deletes branch on it.

The full `QueryEvent` shape is documented in
[docs/MUTATIONS.md](./MUTATIONS.md#mutation-events) — `semanticOp` is one
field on it.

### Audit trail

The audit-trail pattern from
[docs/MUTATIONS.md](./MUTATIONS.md#worked-patterns) — tee writes to an
audit table from a single `$on('query')` listener — handles soft-delete
naturally: the `semanticOp` field is what lets the audit row
distinguish a soft-delete from a regular update, without parsing the SQL
or the update document.

```ts
db.$on('query', async (e) => {
  if (e.op !== 'update') return;
  if (e.model === 'audit_log') return;
  await db.auditLog.create({
    data: {
      at:       e.startedAt,
      model:    e.model,
      op:       e.semanticOp ?? e.op,    // 'softDelete' / 'restore' / 'update'
      rows:     e.rowCount,
      sql:      e.sql,
      duration: e.duration_ms,
    },
  });
});
```

For compliance use-cases that require the audit row to be in the same
transaction as the write, the outbox pattern from
[docs/MUTATIONS.md](./MUTATIONS.md#transactional-outbox) is the shape —
write the audit row inside the same `$transaction` as the soft-delete
verb.

See [docs/EVENTS.md](./EVENTS.md) for the full event-system reference.

---

## GDPR and right-to-be-forgotten

**Soft delete is not erasure.** A row with `deleted_at` set still
contains personal data; it's just hidden from default reads. GDPR
Article 17 (and similar regulations) require *actual* removal — the
data must no longer exist in identifiable form.

Two paths:

### Hard delete

The simplest fulfilment — hard-delete the row, fire the cascade, drop
any associated rows in joined tables:

```ts
async function forgetUser(userId: string) {
  await db.$transaction(async (tx) => {
    await tx.user.delete({ where: { id: userId } });
    // onDelete: 'Cascade' on the FKs purges posts, comments, sessions, etc.
  });
}
```

The cascade graph is your responsibility — every model that holds
identifiable data for the user must either cascade-delete or be
explicitly purged in the same transaction.

### Anonymise in place

When hard delete would break analytics or aggregate counts, replace the
identifiable fields with anonymous placeholders and keep the row:

```ts
async function anonymiseUser(userId: string) {
  await db.user.update({
    where: { id: userId },
    data: {
      email:       `redacted-${userId}@example.invalid`,
      name:        'Redacted User',
      avatar_url:  null,
      phone:       null,
      address:     null,
      deleted_at:  new Date(),
      anonymised:  true,
    },
  });
}
```

The row remains for foreign-key integrity and historical aggregates, but
the personal data is gone. Pair with a flag (`anonymised: true`) so
downstream code can refuse to re-display the row's name / email.

### Soft-delete is the *pre-condition*, not the answer

A typical flow: user requests deletion → soft-delete immediately (UI
stops showing the account) → after the cooling-off period (e.g. 30
days, lets the user reverse the decision) → anonymise or hard-delete to
fulfil the GDPR obligation. The retention purge from
[Hard delete after retention](#hard-delete-after-retention) is the
trigger for the second step.

---

## Search and vector index interaction

Full-text and vector indexes do not know about the auto-filter. Without
guarding, FTS / vector searches return soft-deleted rows.

### FTS

The filter is the same `deleted_at IS NULL` predicate, applied alongside
the FTS match:

```ts
const rows = await db.post.findMany({
  where: {
    AND: [
      { body: { search: 'soft delete' } },   // FTS predicate
      // _withDeleted defaults to false; auto-filter excludes tombstones.
    ],
  },
});
```

The auto-filter handles this for you — every read goes through it,
including FTS. The pitfall is when you drop to `$queryRaw` for a
hand-written `tsquery` / `MATCH` / `$text`; the raw path doesn't
auto-filter:

```ts
const rows = await db.$queryRaw<Post[]>`
  SELECT * FROM posts
  WHERE to_tsvector('english', body) @@ plainto_tsquery($1)
    AND deleted_at IS NULL                            -- add manually
`;
```

See [docs/FTS.md](./FTS.md) for the FTS surface.

### Vector

Same shape — `db.post.findMany({ where: { embedding: { nearestTo:
vec, k: 10 } } })` runs through the auto-filter, so soft-deleted rows
are excluded.

Vector indexes themselves don't have a `WHERE` clause on most engines
(Postgres `pgvector` does; sqlite-vec doesn't), so the index still
covers tombstones. The runtime filter is what gates the results. If
soft-deleted rows dominate the vector space, the recall:precision
trade-off shifts — consider a periodic purge as in
[Hard delete after retention](#hard-delete-after-retention).

See [docs/VECTOR.md](./VECTOR.md) for the vector-search surface.

---

## Browser sqlite-wasm

The browser adapter (sqlite-wasm via OPFS, see
[docs/BROWSER.md](./BROWSER.md)) supports soft-delete with identical
semantics: `.softDeleteAt()` on the column, the four wrapper verbs,
auto-filter on reads, partial-filter indexes via the SQLite syntax,
`_withDeleted` opt-out. The scale differs — a browser SQLite database is
rarely the right home for tables that accumulate millions of
tombstones — but the API is the same. The retention purge from
[Hard delete after retention](#hard-delete-after-retention) applies the
same way; the cron is just `setInterval` instead of a backend job.

---

## Worked patterns

### (a) Blog post: soft-delete, restore, purge

The full lifecycle on one model:

```ts
const Post = model('posts', {
  id:         f.id(),
  author_id:  f.objectId(),
  slug:       f.string(),
  title:      f.string(),
  body:       f.string(),
  created_at: f.dateTime().default('now'),
  deleted_at: f.dateTime().softDeleteAt(),
}, {
  indexes: [
    // Unique slug per active post — recycled after soft-delete.
    {
      keys: { slug: 1 }, unique: true,
      where: 'deleted_at IS NULL',
      partialFilterExpression: { deleted_at: null },
    },
    // Covers the auto-filter on large feeds.
    { keys: { author_id: 1, created_at: -1 }, where: 'deleted_at IS NULL' },
  ],
});

// User trashes a post:
await db.post.softDelete({ where: { id: 'p1' } });
// → row stays; deleted_at set; partial-unique releases the slug.

// User restores within the cooling-off window:
await db.post.restore({ where: { id: 'p1' } });
// → only succeeds if the slug is still available (no one took it).

// Retention cron, daily — purge anything soft-deleted > 90 days ago:
await db.post.deleteMany({
  where: { deleted_at: { lt: cutoff90d }, _withDeleted: true },
});
```

The partial-unique on `slug` is the load-bearing piece. Without it, a
soft-deleted slug holds the key forever and the next post can't reuse it.

### (b) User account: soft-delete with cascade to posts and comments

A user soft-delete that cascades to their content, all in one
transaction:

```ts
async function deactivateUser(userId: string) {
  await db.$transaction(async (tx) => {
    await tx.post.softDeleteMany({ where: { author_id: userId } });
    await tx.comment.softDeleteMany({ where: { author_id: userId } });
    await tx.session.deleteMany({ where: { user_id: userId } });  // hard — sessions are not recoverable
    await tx.user.softDelete({ where: { id: userId } });
  });
}

async function reactivateUser(userId: string) {
  await db.$transaction(async (tx) => {
    await tx.user.restore({ where: { id: userId } });
    await tx.post.restoreMany({ where: { author_id: userId } });
    await tx.comment.restoreMany({ where: { author_id: userId } });
    // sessions stay gone — user re-logs in.
  });
}
```

Sessions are *not* a recoverable resource (you don't restore a logged-out
session), so they're hard-deleted. Posts and comments are; they're
soft-deleted with the user and restored on reactivation.

The transaction guarantees consistency: if the user soft-delete fails,
nothing soft-deletes; if any cascade fails, the user stays active.

### (c) Admin "trash" view — soft-deleted rows only

Inverting the auto-filter for an admin UI that lists what's pending
purge:

```ts
async function listTrash() {
  return db.post.findMany({
    where: {
      deleted_at: { not: null },   // explicit filter — auto-filter is skipped
    },
    orderBy: { deleted_at: 'desc' },
    take: 100,
  });
}
```

The auto-filter only applies when you *don't* filter the soft-delete
column yourself. Filtering with `{ not: null }` is the explicit
"give me only soft-deleted rows" form.

Pair with a restore button that calls `restore({ where: { id } })`, and
a "purge now" button that calls `delete({ where: { id } })` with the
`_withDeleted: true` opt-out so the unique read hits the soft-deleted
row:

```ts
async function purgeOne(id: string) {
  await db.post.delete({ where: { id, _withDeleted: true } });
}
```

`delete` is a hard delete; the `_withDeleted: true` is only needed
because the read filter would otherwise hide the row when the wrapper
loads it for the `RETURNING` clause.

---

## Anti-patterns

### `is_active: bool` instead of a timestamp

The boolean variant — `is_active: false` for soft-deleted, `is_active:
true` for live — appears at first to be the same shape. It isn't:

* **No *when*.** You can't write the retention purge from
  [Hard delete after retention](#hard-delete-after-retention) without
  the timestamp.
* **No audit signal.** "This row was deactivated" doesn't tell you
  when, by whom, in what release.
* **Two-state collapse.** A row that's been deactivated, reactivated,
  and deactivated again looks identical to one deactivated once. With
  a timestamp + audit log, the history is recoverable.

Use `f.dateTime().softDeleteAt()`. The flag falls out: "soft-deleted iff
the timestamp is non-null".

### Soft-deleting embedded children

If a model embeds children as a JSON array — `posts: [{ ... }]` on
Mongo, or a `jsonb` array on Postgres — there is no "child row" to
soft-delete. Soft-delete the parent instead, or model the children as a
separate collection with their own `deleted_at`.

The same applies to fields on a row: soft-deleting a *column* (setting
it to null while keeping the row) isn't soft-delete; it's just a write.
Soft-delete operates on the row.

### Hard-deleting from a soft-delete table without `_withDeleted`

```ts
// Wrong — auto-filter hides the row from the delete's RETURNING read.
await db.post.delete({ where: { id: 'p1' } });
// If post p1 has deleted_at set, this throws "no row matched" because the
// internal read for RETURNING applies the auto-filter and doesn't see it.

// Right — opt out of the filter when hard-deleting a soft-deleted row.
await db.post.delete({ where: { id: 'p1', _withDeleted: true } });
```

This bites during the purge step of the retention pattern if you use
single-row `delete` instead of `deleteMany`. `deleteMany` doesn't have
this problem (no RETURNING) — the `_withDeleted: true` there is to
bypass the filter on the *match*, not the *read-back*.

### Forgetting the partial-unique

If you put a plain `f.string().unique()` on a column in a soft-delete
model, the unique constraint covers tombstones. The first user who
soft-deletes a row with `slug = 'hello'` permanently blocks any other
row from claiming `'hello'`. The user-visible symptom is a unique-violation
error on what looks like an empty slug space.

Fix: replace the column-level `.unique()` with a partial-filter unique
index on the model:

```ts
// Wrong:
slug: f.string().unique(),

// Right:
slug: f.string(),
// + on the model:
indexes: [{
  keys: { slug: 1 }, unique: true,
  where: 'deleted_at IS NULL',
  partialFilterExpression: { deleted_at: null },
}],
```

### Soft-deleting infrastructure tables

Audit logs, outbox events, sessions, rate-limit counters — these tables
*should not* be soft-delete. They have no business logic that benefits
from "recoverable", and the tombstone accumulation hurts the only thing
the tables exist for: throughput.

The model-level question is "is restoring this row a real product
behavior?". If no, hard-delete. Soft-delete is a feature, not a default.

---

## See also

* [docs/MUTATIONS.md](./MUTATIONS.md) — the verb-by-verb write reference,
  including the `update` shape that `softDelete` / `restore` compile down
  to and the `semanticOp` field on `QueryEvent`.
* [docs/INDEXES.md](./INDEXES.md#partial-filter-indexes) — partial-filter
  index emit per dialect, including the MySQL `CASE`-functional rewrite
  and the object-form-to-SQL translator's operator coverage.
* [docs/EVENTS.md](./EVENTS.md) — the event-system reference; `semanticOp`
  is one field on `QueryEvent`.
* [docs/RELATIONS.md](./RELATIONS.md#cascade-rules) — `onDelete` modes
  and the cascade matrix. (Soft-delete cascade is application-side;
  hard-delete cascade is database-enforced.)
* [docs/FTS.md](./FTS.md) — full-text search; the auto-filter applies
  to FTS reads through the wrapper but not through `$queryRaw`.
* [docs/VECTOR.md](./VECTOR.md) — vector search; same caveat as FTS.
* [docs/QUERIES.md](./QUERIES.md) — read verbs and the compile API
  (`db.<model>.compile.softDelete({ ... })`).
* [README — Soft delete](../README.md#soft-delete) — the short tour.
