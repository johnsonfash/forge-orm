# Views

Virtual tables backed by a query — used for security boundaries, denormalized read models, schema-versioning facades, and per-tenant data shaping. This page covers what forge-orm exposes (`f.view`), per-dialect view semantics (updatable rules, SECURITY_BARRIER, indexed views, Mongo collection views), and the patterns that compose with RLS.

The [`Views and materialised views`](./MODEL.md#views-and-materialised-views)
section in `MODEL.md` is the surface — the one-line API and the per-dialect
DDL table. This file goes one level down: where view boundaries earn their
keep, what each dialect actually does under `CREATE VIEW`, how forge
introspects them on `diff`, and the patterns that compose with RLS, schema
versioning, and tenant isolation.

Related deep-dives:

* [MODEL.md](./MODEL.md#views-and-materialised-views) — the `.asView()` surface and the per-dialect DDL table.
* [SECURITY.md](./SECURITY.md) — RLS, row-level policies, column-masking patterns that pair with views.
* [MULTI-TENANT.md](./MULTI-TENANT.md) — tenant-scoped views, per-org filters baked into a view body.
* [MIGRATIONS.md](./MIGRATIONS.md) — how view DDL flows through `push` and `diff`.
* [MONGO.md](./MONGO.md) — Mongo collection views (`createCollection` with `viewOn` + `pipeline`).

---

## Contents

* [What a view is](#what-a-view-is)
* [`f.view` and `.asView()` — the forge API](#fview-and-asview--the-forge-api)
* [Read-only by default](#read-only-by-default)
* [Updatable views — when the DB lets you write](#updatable-views--when-the-db-lets-you-write)
* [Use cases that earn the view](#use-cases-that-earn-the-view)
* [Per-dialect semantics](#per-dialect-semantics)
  * [Postgres](#postgres)
  * [MySQL](#mysql)
  * [SQLite](#sqlite)
  * [DuckDB](#duckdb)
  * [MSSQL](#mssql)
  * [Mongo](#mongo)
* [Materialised views](#materialised-views)
* [Views + RLS](#views--rls)
* [View migrations and drift](#view-migrations-and-drift)
* [View dependencies and cascading drop](#view-dependencies-and-cascading-drop)
* [forge IR for views — the typed read shape](#forge-ir-for-views--the-typed-read-shape)
* [Performance — views are query rewrites](#performance--views-are-query-rewrites)
* [Worked examples](#worked-examples)

---

## What a view is

A view is a named SELECT. When you query a view, the database rewrites the
query at plan time, substituting the view body for the view name, and then
plans the rewritten statement against the underlying tables. There is no
data of its own (with the exception of materialised views and indexed
views, covered below); a view is a saved query with a schema-level name.

Three properties make views worth declaring rather than copy-pasting the
SELECT into every query:

* **A security boundary.** A view can hide columns (don't `SELECT`
  `users.password_hash`), hide rows (`WHERE org_id = current_setting(…)`),
  and be granted to a role that has no access to the underlying tables.
  Combined with column-level GRANT, this is the standard SQL pattern for
  per-role data shaping.
* **Query simplification.** A four-way join with a filter and a few
  computed columns becomes a single name. Consumers don't need to know the
  join keys or the discriminator predicate.
* **A versioning facade.** When you rename `users.legacy_name` to
  `users.display_name`, a view called `users_v1` that exposes the old
  column name keeps the old API working through the migration window.

What a view is **not**:

* Not a cache. A plain view does no work until you query it; each query
  re-executes the underlying SELECT. For caching, see materialised views
  below.
* Not a different data store. The view body runs against the same tables
  in the same database. If the underlying table is slow, the view is slow.

---

## `f.view` and `.asView()` — the forge API

Forge models a view by chaining `.asView()` onto a regular `model()`
declaration. The field map describes the **shape the view returns** (used
for typing reads); the spec describes **how to build the view** (the
SELECT body or aggregation pipeline).

```ts
import { f, model } from 'forge-orm';

const PublishedPosts = model('published_posts', {
  id:           f.id(),
  title:        f.string(),
  slug:         f.string(),
  author_id:    f.objectId(),
  view_count:   f.int(),
  published_at: f.dateTime().optional(),
}).asView({
  sql: `
    SELECT id, title, slug, author_id, view_count, published_at
    FROM posts
    WHERE status = 'PUBLISHED'
  `,
  sourceCollection: 'posts',                       // Mongo: the collection the view reads from
  pipeline: [                                      // Mongo equivalent of the SQL body
    { $match: { status: 'PUBLISHED' } },
    { $project: { _id: 1, title: 1, slug: 1, author_id: 1, view_count: 1, published_at: 1 } },
  ],
});
```

The full signature, from `src/schema/core.ts`:

```ts
asView(spec: {
  sql?: string;                  // SQL dialects: the SELECT body
  pipeline?: unknown[];          // Mongo: the aggregation pipeline (matches sql semantically)
  sourceCollection?: string;     // Mongo: the view's underlying collection
  materialised?: boolean;        // Default false. See "Materialised views".
  refreshEvery?: string;         // '30s' | '5m' | '1h' — auto-refresh for materialised views
}): TypedModel<F, {}>;
```

A few rules of engagement:

* The field map and the SELECT projection must agree. Forge does not
  rewrite your SQL; if the SELECT returns six columns and the model has
  seven, that seventh column reads as `null` on every row.
* `.asView()` returns a `TypedModel`. The wrapper exposes the same read
  surface (`findFirst`, `findMany`, `findUnique`, `count`, `aggregate`),
  and blocks the write surface (see below).
* The model is registered in the schema like any other model. `forge push`
  emits the view DDL after the underlying tables exist (pass 3 in the SQL
  adapters; see `src/adapters/postgres/ddl.ts`).
* `f.view` is not a separate top-level constructor — there is no
  `f.view(...)`. View-ness is a property of a `model()` plus `.asView()`.
  If you grep the code for view detection, it's `model.view` on the
  `ModelDef`.

---

## Read-only by default

Forge treats every `.asView()` model as read-only. The wrapper rejects
`create`, `update`, `delete`, `upsert`, `softDelete`, and `restore` at the
collection layer before any SQL is built:

```ts
await db.publishedPosts.create({ data: { … } });
// Throws:
// [forge] create is not allowed on 'published_posts' — it's a read-only view.
//   Use the underlying source model for writes, or drop .asView() from the schema.
```

The check lives in `_assertWritable` on `CollectionWrapper`
(`src/builder/collection.ts:341`) and runs on every mutating entry point.
This is independent of whether the underlying database considers the view
updatable — the design choice is "if you're routing through a view, route
writes through the source." It keeps the data-flow obvious: reads through
the view, writes through the table the view reads from.

If the application genuinely needs writes through a view (column-masked
update flows, for example), the underlying database may support it via
`INSTEAD OF` triggers or auto-updatable view rules (covered below).
Forge's recommendation: model the write surface as a regular `model()`
against the source table, scope it with relation filters or RLS, and keep
`.asView()` for the read-only projection.

---

## Updatable views — when the DB lets you write

Even though forge blocks writes through the view model, the underlying
database has its own rules for whether a view is updatable. Worth knowing
because the same SELECT body behaves differently across dialects:

| Dialect | Updatable when… | Mechanism |
|---|---|---|
| Postgres | Simple view: single table, no aggregates, no `DISTINCT`, no `GROUP BY`, no set-ops, no window functions, all selected columns are simple references | Auto-updatable. Otherwise: write `CREATE RULE` or `INSTEAD OF` triggers. |
| MySQL | `ALGORITHM=MERGE` view with one base table, no aggregates, no `DISTINCT`, no `UNION`, no subquery in `SELECT` | Auto-updatable. `WITH CHECK OPTION` enforces predicate on writes. |
| SQLite | Never auto-updatable. `INSTEAD OF` triggers required for any write. |
| DuckDB | Never auto-updatable. |
| MSSQL | Simple view: one base table, no aggregates, no `DISTINCT`, no `GROUP BY` | Auto-updatable. `WITH CHECK OPTION` available. `INSTEAD OF` triggers extend this. |
| Mongo | Collection views are read-only. No exceptions. |

When the application's data model genuinely benefits from writes through
a view (a column-masked HR view that exempts salary from updates, for
example), the typical shape is:

1. Declare the SQL view in raw migration SQL with the `INSTEAD OF` trigger.
2. Declare the forge model **without** `.asView()` — point its
   `collection: 'view_name'` at the view name.
3. Accept that the DB might reject writes that violate the trigger logic;
   route them as application errors.

This is a deliberate escape hatch, not the recommended path.

---

## Use cases that earn the view

A view is overhead — DDL to deploy, drift to track, a name to keep in
sync. Reach for it when it earns its weight:

* **Column-masked read per role.** A `customers_csr` view that omits
  `tax_id` and `dob`, granted to the `customer_support` role, with the
  base `customers` table grant revoked from that role. The DB enforces
  the masking; the application can't bypass it.
* **Per-tenant read shaping.** A view whose body filters on
  `current_setting('app.org_id')` (Postgres) returns only the current
  tenant's rows for every query, independent of whether the caller
  remembered to add `where: { orgId }`. Pairs with RLS for defense in
  depth.
* **Denormalised read model.** Pre-joined order summaries
  (`orders + line_items + customers + addresses`) exposed as
  `order_summary`. Consumers don't need to know the join graph.
* **Schema versioning facade.** When a column is renamed or split, the
  old name keeps working through a view that re-aliases. The migration
  becomes "rename the column" in one step and "delete the facade view"
  in a separate step, with consumers cutting over in between.
* **Stable contract over a moving table.** A reporting view exposes a
  curated subset of an OLTP table. The OLTP team can add columns or
  reshape internals without breaking downstream BI tools.

What does **not** earn a view:

* Filters you already write on every query. A view that's
  `SELECT * FROM posts WHERE deleted_at IS NULL` saves no thinking;
  soft-delete already filters that automatically.
* Aggregations queried once per page-load — that's a query, not a saved
  query.
* "Just in case we need it later." Views accumulate drift; every one is
  a maintenance edge.

---

## Per-dialect semantics

`forge push` emits view DDL in a separate pass after tables exist, so
views can reference tables created in the same `push` run. Each adapter
has its own DDL shape:

### Postgres

```sql
CREATE OR REPLACE VIEW "published_posts" AS
  SELECT id, title, slug, author_id, view_count, published_at
  FROM posts WHERE status = 'PUBLISHED';
```

Source: `src/adapters/postgres/ddl.ts` — `CREATE OR REPLACE VIEW` is the
default emit, so re-running `push` after a body change updates in place
without dropping. `CREATE OR REPLACE` requires the new column list to be
a superset of the old one (same names, same order, types compatible); a
true column rename or reorder requires `DROP VIEW` + `CREATE VIEW`,
which forge surfaces in `diff` as a view drift item.

Two Postgres-specific options worth knowing (forge doesn't emit them
itself yet; declare them in raw migration SQL if you need them):

* `WITH (security_barrier=on)` — promises that the view's
  `WHERE` clauses run before any caller-supplied function calls, so a
  leaky predicate in a caller can't be pushed past the view's filter
  and exfiltrate hidden rows. Use when the view's purpose is row
  hiding.
* `WITH (security_invoker=on)` — runs the view body with the caller's
  privileges (Postgres 15+). The default `SECURITY DEFINER`-style
  behaviour uses the view owner's privileges, which can be surprising
  with RLS. `security_invoker=on` makes RLS apply as the caller, which
  is usually what you want.

### MySQL

```sql
CREATE OR REPLACE VIEW post_stats AS …
```

Source: `src/adapters/mysql/ddl.ts`. `ALGORITHM` defaults to `UNDEFINED`,
which lets the optimiser pick `MERGE` (substitute view body into the
outer query) or `TEMPTABLE` (materialise into a hidden temp table per
query). `MERGE` is faster but only works when the view is simple; the
optimiser falls back to `TEMPTABLE` for aggregates or
`UNION`/`DISTINCT`. To force, write the view body in a custom SQL
migration with `ALGORITHM=MERGE` or `ALGORITHM=TEMPTABLE`.

`DEFINER` defaults to the user that ran `CREATE VIEW`. `SQL SECURITY
DEFINER` (default) runs the view as that user; `SQL SECURITY INVOKER`
runs as the caller. Same trade-off as Postgres: invoker is friendlier
to row-level filters keyed on the caller's identity.

### SQLite

```sql
CREATE VIEW IF NOT EXISTS "published_posts" AS …
```

Source: `src/adapters/sqlite/ddl.ts`. SQLite views are always read-only
at the engine level; writes need `INSTEAD OF` triggers. Forge's wrapper
block is consistent with this.

SQLite has no native materialised views. When `materialised: true` is
declared, forge emits a `CREATE TABLE … AS …` (a table populated from
the SELECT body) and `db.<model>.refresh()` runs `DELETE FROM` +
`INSERT … SELECT` inside a transaction. The introspection shows it as a
table; the diff treats it as a matview-backing table and accepts it.

### DuckDB

```sql
CREATE VIEW post_stats AS …
```

Source: `src/adapters/duckdb/`. DuckDB views work like SQLite views —
read-only at the engine level, no `INSTEAD OF` triggers. DuckDB's
introspect surface in forge does not yet list views back (`views: []`
in `src/adapters/duckdb/introspect.ts:78`), so view drift detection is a
no-op on DuckDB — `push` still emits the view, but `diff` won't flag a
view that was manually dropped on the server.

### MSSQL

```sql
CREATE VIEW [post_stats] AS …
```

Source: `src/adapters/mssql/ddl.ts`. MSSQL's distinguishing feature is
**indexed views** — a view with `WITH SCHEMABINDING` and a clustered
unique index on it becomes a materialised view that the engine
maintains automatically as the base tables change. No `refresh()`
needed; the engine keeps the materialised state in sync transactionally.

When forge sees `materialised: true` on MSSQL, the recommended pattern
is to declare the view manually with `WITH SCHEMABINDING` plus an
indexed view in raw migration SQL, then point a regular forge `model()`
at the view name. The `.refresh()` method becomes a no-op on MSSQL
(`adapter.refreshView` is unimplemented on MSSQL by design — the engine
handles it).

`WITH CHECK OPTION` on a non-indexed view enforces that any insert or
update through the view satisfies the view's `WHERE` clause. Useful in
combination with `INSTEAD OF` triggers when you do want a writable view.

### Mongo

Mongo views are real collections in the listing, with `type: 'view'`,
created via:

```js
db.createCollection('published_posts', {
  viewOn: 'posts',
  pipeline: [
    { $match: { status: 'PUBLISHED' } },
    { $project: { … } },
  ],
});
```

Source: `src/adapters/mongo/scripts/push.ts:335`. Mongo views are
strictly read-only — no `INSTEAD OF` equivalent. They support most of
the aggregation pipeline (`$match`, `$project`, `$lookup`, `$group`,
`$addFields`, `$unwind`), and indexes from the source collection are
used when the optimiser can push the predicate down.

The `pipeline` you pass to `.asView()` is exactly what Mongo stores. To
change a Mongo view's pipeline you must `drop` and recreate; forge's
push does this automatically on re-emit so pipeline drift heals
without manual intervention.

---

## Materialised views

A materialised view stores the query result physically and only
recomputes on demand. Trade-off: faster reads, stale data between
refreshes.

```ts
const PostStats = model('post_stats', {
  author_id:   f.objectId(),
  post_count:  f.bigint(),
  total_views: f.bigint(),
}).asView({
  materialised: true,
  sql: `
    SELECT author_id,
           COUNT(*) AS post_count,
           COALESCE(SUM(view_count), 0) AS total_views
    FROM posts
    GROUP BY author_id
  `,
  refreshEvery: '5m',
});

await db.postStats.refresh();                       // manual
const stop = db.postStats.scheduleRefresh('1h');    // auto, call stop() to cancel
```

Per-dialect refresh behaviour, all from the adapter `refreshView`
implementations:

* **Postgres** — `REFRESH MATERIALIZED VIEW [CONCURRENTLY] "post_stats"`.
  `CONCURRENTLY` requires a unique index on the matview and is opt-in
  via `db.postStats.refresh({ concurrently: true })`.
* **MySQL** — no native matviews. Forge emits a regular `CREATE TABLE
  IF NOT EXISTS post_stats AS …` and refreshes by `DELETE FROM` +
  `INSERT … SELECT` inside a transaction.
* **SQLite** — same approach as MySQL: table-backed, transactional
  reload.
* **DuckDB** — table-backed, same shape as SQLite.
* **MSSQL** — engine-maintained indexed views; `.refresh()` is a no-op
  (and forge raises if you try, because `refreshView` is not
  implemented on the MSSQL adapter).
* **Mongo** — re-runs the aggregation pipeline ending in `$out` or
  `$merge`. If you didn't supply one, forge appends
  `{ $out: collection }` automatically.

`refreshEvery` parses as `30s` / `5m` / `1h`. The timer is created with
`unref()` so it doesn't keep the process alive. Errors from the
background refresh swallow into `$on('error')` so a transient DB blip
doesn't crash the application.

See [MATERIALIZED-VIEWS.md](./MATERIALIZED-VIEWS.md) (companion deep
dive — when matviews earn the storage, indexing strategies on the
matview itself, and concurrency considerations under `CONCURRENTLY`).

---

## Views + RLS

The pairing earns its weight in multi-tenant systems. Three layered
strategies, smallest blast radius first:

**Layer 1 — application filter.** Every query has `where: { orgId:
ctx.org }`. One forgotten `where` and the tenant boundary is gone.

**Layer 2 — view-level filter.** A view that bakes the tenant filter
into its body:

```ts
const TenantPosts = model('tenant_posts', { /* same shape as posts */ })
  .asView({
    sql: `
      SELECT id, org_id, title, body, created_at
      FROM posts
      WHERE org_id = current_setting('app.org_id', true)::uuid
    `,
  });
```

The application sets the GUC via `SET LOCAL app.org_id = …` at the
start of each request's transaction. A forgotten `where` on the view
still returns only the current tenant's rows — the filter lives in the
view body, not the caller.

**Layer 3 — RLS on the source table.** A `CREATE POLICY` on `posts`
that enforces the same predicate at the row level. Now even raw SQL
through the connection respects the boundary. The view becomes the
ergonomic surface; RLS is the enforcement.

For Postgres specifically: pair the view with `WITH
(security_barrier=on, security_invoker=on)`. `security_barrier` keeps a
caller's leaky predicate from being pushed past the view filter;
`security_invoker` makes RLS evaluate as the caller, not the view
owner.

See [SECURITY.md](./SECURITY.md) and
[MULTI-TENANT.md](./MULTI-TENANT.md) for the full RLS and tenant
isolation playbook.

---

## View migrations and drift

Forge introspects views on `diff` per dialect:

* **Postgres** — `information_schema.views` for plain views,
  `pg_matviews` for materialised. Both feed back into
  `introspection.views` with a `materialised` flag (see
  `src/adapters/postgres/introspect.ts:74`).
* **MySQL** — `information_schema.tables WHERE table_type = 'VIEW'`.
* **SQLite** — `sqlite_master WHERE type = 'view'`.
* **MSSQL** — currently `views: []` in the introspect output. View
  drift detection on MSSQL is best-effort; declare matviews via raw SQL.
* **Mongo** — `db.listCollections()` returns each view with
  `type: 'view'`.
* **DuckDB** — currently `views: []`. Same caveat as MSSQL.

The diff core (`src/scripts/diff-core.ts`) compares the **set of view
names** between expected (the schema) and actual (introspect). It
flags:

* Missing views in the database that the schema declares.
* Extra views in the database the schema doesn't declare (subject to
  ignore filters; matview-backing tables are accepted under either
  `tables` or `views`).

What it does **not** currently compare: the **body** of a view. Forge
re-emits the body on every `push` (`CREATE OR REPLACE VIEW` on
Postgres/MySQL, drop+create on Mongo, idempotent
`CREATE VIEW IF NOT EXISTS` on SQLite), so push always converges. But
`diff` won't flag "the schema's view body changed since the last push"
— a `push` is the way to apply that.

**When `CREATE OR REPLACE` works:** Postgres and MySQL both allow it
when the new column list is a superset of the old (same names and
order, types compatible). Adding a column to the end of a view body is
safe; renaming or reordering is not, and `push` will surface the
underlying `ERROR: cannot change name of view column …` from the
driver.

**When you need DROP + CREATE:** column rename, column reorder, type
change. Forge does not auto-drop on diff apply; it surfaces the error
and you write a manual migration that drops first.

---

## View dependencies and cascading drop

Views depend on the tables (and other views) they reference. Drop the
underlying table without dropping the view, and you get an error
(Postgres, MySQL, MSSQL) or a silently broken view (SQLite — the view
exists, but querying it fails at runtime).

Per-dialect rules:

* **Postgres** — every view dependency is tracked in `pg_depend`.
  `DROP TABLE posts` errors unless you write `DROP TABLE posts CASCADE`,
  which then drops every dependent view. Same with `DROP VIEW
  parent_view CASCADE` taking out dependent views.
* **MySQL** — view dependencies aren't enforced at drop time; you can
  drop the base table and the view becomes invalid (`view references
  invalid table or column`).
* **SQLite** — same: drop is permitted, view becomes runtime-broken.
* **MSSQL** — when the view is `WITH SCHEMABINDING`, the engine
  prevents the drop. Plain views break at runtime like MySQL.
* **Mongo** — drop the source collection and the view returns empty
  results; no error at definition time.

Forge does not currently track view dependencies in IR. When you
restructure a table that a view depends on, you handle the order
manually: drop the view, run the table migration, recreate the view.
The migration generator (`forge diff apply`) will get the table side
right; the view side surfaces as a missing-view item in the next
`diff`.

---

## forge IR for views — the typed read shape

A view model is a regular `ModelDef` in the IR with an extra `view`
property attached at `.asView()` time
(`src/schema/core.ts:331`). The field map types reads exactly as it
would for a table: `Row<typeof PublishedPosts>` resolves to the same
shape you'd get from a real table with those fields.

What's typed:

* `findFirst`, `findMany`, `findUnique`, `count`, `aggregate` — full
  read surface, identical to a table.
* `where`, `orderBy`, `select`, `include` (when relations are declared
  via `.relate()`).
* `Row<typeof PublishedPosts>` for output types.

What's not exposed on the type:

* `create`, `update`, `delete`, `upsert`, `softDelete`, `restore` —
  forge does not currently surface these as type errors on a view
  model; the wrapper rejects them at runtime with `ForgeViewWriteError`
  (informally — see `_assertWritable` for the exact message). The
  trade-off is that view types stay simple. A future major version
  could narrow the write methods off the view's wrapper type.

Relations declared via `.relate()` work on view models too — handy when
the view is a denormalised projection and you still want to traverse
relations from the view's foreign keys.

---

## Performance — views are query rewrites

A plain view is **not** a cache. When you query a view, the database
substitutes the view body into the outer query and plans the combined
statement. The cost is the cost of the underlying SELECT, every time.

This means:

* Indexes on the base tables matter; the view inherits them via the
  rewrite. There is no separate "view index" except on MSSQL indexed
  views.
* A view that wraps a complex join is exactly as slow as that join.
  The view doesn't make it faster — it makes it more ergonomic.
* `EXPLAIN` on a view query shows the **rewritten** plan against the
  base tables. There is no separate view node.
* Pushing filters down through the view is the optimiser's job. On
  Postgres with `security_barrier=on`, some pushdowns are blocked
  deliberately (the whole point of the barrier is to keep external
  predicates out). On MySQL with `ALGORITHM=TEMPTABLE` (forced or
  fallback), the view materialises to a temp table per query and
  cannot push down at all.

When views matter for performance: a materialised view (compute once,
read many) or an MSSQL indexed view (engine-maintained, near-zero read
cost). Both pay storage and write amplification for read speed.

---

## Worked examples

### (a) Per-tenant view with RLS hint

```ts
import { f, model } from 'forge-orm';

// Source table — direct table model, not a view. Writes go here.
export const Project = model('projects', {
  id:         f.id(),
  org_id:     f.objectId(),
  name:       f.string(),
  archived:   f.boolean().default(false),
  created_at: f.dateTime().createdAt(),
});

// View: only projects for the current tenant, only non-archived ones.
// Reads only. The view body bakes in the tenant filter via a GUC.
export const ActiveProject = model('active_projects', {
  id:         f.id(),
  org_id:     f.objectId(),
  name:       f.string(),
  created_at: f.dateTime(),
}).asView({
  sql: `
    SELECT id, org_id, name, created_at
    FROM projects
    WHERE archived = false
      AND org_id = current_setting('app.org_id', true)::uuid
  `,
});
```

Set `app.org_id` at the start of each request transaction:

```ts
await db.$transaction(async (tx) => {
  await tx.$executeRaw`SET LOCAL app.org_id = ${ctx.org}`;
  const rows = await tx.activeProject.findMany();   // automatically scoped
  // …
});
```

For defense in depth, add an RLS policy on `projects` keyed on the same
GUC. The view becomes the ergonomic surface; RLS is the enforcement.

### (b) Denormalised order-summary view

```ts
export const OrderSummary = model('order_summary', {
  id:          f.id(),
  org_id:      f.objectId(),
  customer:    f.string(),
  item_count:  f.int(),
  total:       f.decimal({ precision: 12, scale: 2 }),
  status:      f.enumOf('DRAFT', 'PLACED', 'PAID', 'SHIPPED', 'CANCELLED'),
  placed_at:   f.dateTime().optional(),
}).asView({
  sql: `
    SELECT o.id,
           o.org_id,
           c.name                        AS customer,
           COUNT(li.id)                  AS item_count,
           COALESCE(SUM(li.line_total), 0) AS total,
           o.status,
           o.placed_at
    FROM orders o
    JOIN customers c   ON c.id = o.customer_id
    LEFT JOIN line_items li ON li.order_id = o.id
    GROUP BY o.id, o.org_id, c.name, o.status, o.placed_at
  `,
});

// Consumers query the view like any other model:
const rows = await db.orderSummary.findMany({
  where: { status: { in: ['PAID', 'SHIPPED'] } },
  orderBy: { placed_at: 'desc' },
  take: 50,
});
```

When the read pattern is hot (dashboard hits this every page), promote
it to materialised:

```ts
export const OrderSummary = model('order_summary', { /* same shape */ })
  .asView({
    materialised: true,
    refreshEvery: '1m',
    sql: `…same SELECT…`,
  });
```

`db.orderSummary.refresh()` runs `REFRESH MATERIALIZED VIEW` on
Postgres; on MySQL/SQLite/DuckDB it reloads the backing table inside a
transaction.

### (c) Mongo view that filters by status

```ts
export const ActiveDevice = model('active_devices', {
  id:        f.objectId(),
  org_id:    f.objectId(),
  name:      f.string(),
  last_seen: f.dateTime(),
}).asView({
  sourceCollection: 'devices',
  pipeline: [
    { $match: { status: 'ACTIVE' } },
    {
      $project: {
        _id: 1, org_id: 1, name: 1, last_seen: 1,
      },
    },
  ],
});
```

`forge push` runs `db.createCollection('active_devices', { viewOn:
'devices', pipeline: [...] })`. If you change the pipeline and re-push,
forge drops and recreates the view collection so the pipeline always
matches the schema.

Reads compile to a `db.active_devices.aggregate(…)` under the hood with
the view's pipeline prepended.

### (d) MSSQL indexed view (raw migration + forge model)

MSSQL indexed views need `WITH SCHEMABINDING` plus a unique clustered
index, none of which forge emits automatically. The pattern is:

1. **Migration SQL (manual):**

   ```sql
   CREATE VIEW [dbo].[post_stats] WITH SCHEMABINDING AS
     SELECT author_id,
            COUNT_BIG(*) AS post_count,
            SUM(view_count) AS total_views,
            COUNT_BIG(view_count) AS _vc_count   -- required for SUM in indexed view
     FROM dbo.posts
     GROUP BY author_id;

   CREATE UNIQUE CLUSTERED INDEX IX_post_stats_author
     ON [dbo].[post_stats] (author_id);
   ```

2. **Forge model — point at the view name, no `.asView()`:**

   ```ts
   export const PostStats = model('post_stats', {
     author_id:   f.objectId(),
     post_count:  f.bigint(),
     total_views: f.bigint(),
   });
   ```

   Add `--ignore=post_stats` to `forge diff` so it doesn't try to
   create a table called `post_stats`.

3. **Reads use the indexed view automatically** when the query
   optimiser picks it (often you need `OPTION (EXPAND VIEWS)` to
   bypass, or a query hint to force use). The engine keeps the
   materialised state in sync transactionally — no `refresh()`.

This is the right shape for hot aggregates on MSSQL when you want
read-time pre-aggregation with transactional consistency. Forge's
own matview machinery doesn't extend to MSSQL because the engine's
indexed views are a strictly better primitive there.

---

## See also

* [MODEL.md](./MODEL.md#views-and-materialised-views) — the `.asView()` API surface and dialect DDL table.
* [MATERIALIZED-VIEWS.md](./MATERIALIZED-VIEWS.md) — matview deep dive (refresh strategies, indexing matviews, `CONCURRENTLY`).
* [SECURITY.md](./SECURITY.md) — RLS policies and column-masking patterns that pair with view boundaries.
* [MULTI-TENANT.md](./MULTI-TENANT.md) — tenant-scoped views and per-org GUCs.
* [MIGRATIONS.md](./MIGRATIONS.md) — how view DDL flows through `push`, `diff`, and `diff apply`.
* [MONGO.md](./MONGO.md) — Mongo collection views and aggregation pipelines.
