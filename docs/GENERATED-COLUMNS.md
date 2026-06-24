# Generated columns

Derived values computed from other columns — STORED on disk or VIRTUAL on read — useful for indexable JSON extracts, lowercase case-folding, computed totals. This page covers `f.*({ generated: ... })`, the per-dialect STORED/VIRTUAL matrix, the indexability rules, and the patterns for the common use cases.

The README chapter on [model definition](../README.md#defining-a-schema) and the [`.dbgenerated`](./MODEL.md#generated--computed-columns) modifier in MODEL.md introduce the surface. This page is the full reference: every dialect's emit, what `forge diff` does and doesn't catch, and the half-dozen patterns that come up in practice.

Related deep-dives:

* [MODEL.md](./MODEL.md) — every field modifier including `.dbgenerated('expr')`.
* [INDEXES.md](./INDEXES.md) — how to put an index on a generated column.
* [JSON-PATH.md](./JSON-PATH.md) — querying inside `f.json()` / `f.embed()` without a generated column.
* [MIGRATIONS.md](./MIGRATIONS.md) — how `forge push` and `forge diff` see generated columns.
* [INDEXES.md — Postgres tsvector with generated column + GIN](./INDEXES.md#f-postgres-tsvector-with-generated-column--gin) — the canonical full-text pattern.

---

## Contents

* [What generated columns are](#what-generated-columns-are)
* [The forge declaration](#the-forge-declaration)
* [Per-dialect emit](#per-dialect-emit)
  * [Postgres — 12+ GENERATED STORED only](#postgres--12-generated-stored-only)
  * [MySQL — 5.7+ STORED default, VIRTUAL opt-in](#mysql--57-stored-default-virtual-opt-in)
  * [SQLite — 3.31+ STORED default, VIRTUAL opt-in](#sqlite--331-stored-default-virtual-opt-in)
  * [DuckDB — no native generated columns](#duckdb--no-native-generated-columns)
  * [MSSQL — AS (expr) PERSISTED](#mssql--as-expr-persisted)
  * [Mongo — not native](#mongo--not-native)
* [STORED vs VIRTUAL — the trade-off](#stored-vs-virtual--the-trade-off)
* [Indexability](#indexability)
* [JSON-extract → indexed scalar pattern](#json-extract--indexed-scalar-pattern)
* [CHECK constraints and foreign keys on generated columns](#check-constraints-and-foreign-keys-on-generated-columns)
* [Drift detection — what forge diff catches](#drift-detection--what-forge-diff-catches)
* [Writes — never](#writes--never)
* [Replacing an expression](#replacing-an-expression)
* [Use cases](#use-cases)
* [Browser sqlite-wasm support](#browser-sqlite-wasm-support)
* [Worked examples](#worked-examples)
  * [(a) Extract email-host from JSON for indexing](#a-extract-email-host-from-json-for-indexing)
  * [(b) Lowercase username for case-insensitive uniqueness](#b-lowercase-username-for-case-insensitive-uniqueness)
  * [(c) Order total = qty * price](#c-order-total--qty--price)
  * [(d) MSSQL persisted column with index](#d-mssql-persisted-column-with-index)
* [Common mistakes](#common-mistakes)
* [See also](#see-also)

---

## What generated columns are

A generated column is a column whose value is computed from an expression over other columns in the same row. The database evaluates the expression — the application never writes the column directly.

Two storage modes exist in the SQL standard:

* **STORED** — the expression is evaluated on every `INSERT` / `UPDATE` and the result is written to disk like a normal column. Cheaper to read (no recomputation), more expensive to write (extra disk I/O), indexable on every dialect that has them.
* **VIRTUAL** — the expression is evaluated on every read. No disk cost, write is unchanged. Indexability varies by dialect (MySQL yes; SQLite yes via expression indexes; Postgres has no VIRTUAL — use a regular expression index instead).

Forge's `.dbgenerated('expr')` modifier emits `GENERATED ALWAYS AS (<expr>) STORED` on PG/MySQL/SQLite and `AS (<expr>) PERSISTED` on MSSQL. STORED / PERSISTED is the default because it's the only mode that's reliably indexable across every supported dialect. To opt into VIRTUAL on MySQL or SQLite, append the keyword to the expression string — Forge passes it through verbatim.

The "use when" is narrow but very high-value:

* The expression is a derived projection of one or more existing columns (a lowercase copy, a JSON path extracted out, a computed total).
* You want to **index** that projection — and an expression index is awkward (PG B-tree on `LOWER(name)` works but is harder to read; MySQL functional indexes were 8.0.13+; SQLite has them but they're invisible to most tooling).
* Or you want the projection visible to ad-hoc queries / reports.

When you only need to **read** the projection occasionally and never index it, prefer querying the source column directly via the JSON-path operator (`{ meta: { path: 'profile.age', gte: 18 } }`) or a SQL view.

---

## The forge declaration

`.dbgenerated(expr)` is a method on `Field` defined in `src/schema/core.ts`:

```ts
// src/schema/core.ts
dbgenerated(expr: string): Field<T, K> {
  return new Field<T, K>({ ...this.def, dbGenerated: expr });
}
```

The argument is the raw SQL expression. Forge does not parse or validate it — whatever you pass lands inside the parentheses after `AS (`. That means:

* You're responsible for column-name quoting style. The Postgres adapter uses `"col"`, MySQL uses `` `col` ``, SQLite accepts both, MSSQL uses `[col]`. The safest cross-dialect choice is bare identifiers (`amount`, not `"amount"`) when the column names are lowercase ASCII — every dialect tolerates that.
* You're responsible for syntax. PG's `||` for string concat differs from MySQL's `CONCAT()`; a single-dialect schema is the easy case, multi-dialect schemas need to pick functions that exist everywhere or fan out per dialect.

Minimal example, lifted from `src/__tests__/native-types-ddl.spec.ts`:

```ts
import { f, model } from 'forge-orm';

const Money = model('money', {
  id:      f.id(),
  amount:  f.decimal({ precision: 12, scale: 2 }),
  doubled: f.decimal({ precision: 14, scale: 2 }).dbgenerated('amount * 2'),
});
```

The JS-side type of `doubled` is `string` (decimal serialises as string to avoid float-precision loss). The wrapper omits `doubled` on every `create` / `update` — passing it in either ignored or rejected at the type level depending on the inferred input shape.

---

## Per-dialect emit

The DDL emitters live in `src/adapters/<dialect>/ddl.ts`. The three SQL standards all converge on the same syntax; MSSQL and DuckDB diverge.

### Postgres — 12+ GENERATED STORED only

```ts
// src/adapters/postgres/ddl.ts
if (field.dbGenerated) {
  return `${colName} ${type} GENERATED ALWAYS AS (${field.dbGenerated}) STORED`;
}
```

Postgres added `GENERATED ALWAYS AS … STORED` in version 12 (October 2019). Earlier versions don't have generated columns at all — you used `BEFORE INSERT` / `BEFORE UPDATE` triggers or expression indexes instead.

PG **does not implement VIRTUAL** generated columns. The standard reserves the keyword; the implementation does not. For a VIRTUAL-equivalent on PG, drop the generated column entirely and put the expression in an **expression index** (`CREATE INDEX ON users ((LOWER(name)))`) or a **view**. Forge supports both: expression indexes via `IndexDef.expressions` (see [INDEXES.md](./INDEXES.md#expression-indexes)) and views via `.asView(...)` on the model.

```sql
-- forge push output for `f.decimal().dbgenerated('amount * 2')`:
"doubled" numeric(14,2) GENERATED ALWAYS AS (amount * 2) STORED
```

### MySQL — 5.7+ STORED default, VIRTUAL opt-in

```ts
// src/adapters/mysql/ddl.ts
if (field.dbGenerated) {
  return `${colName} ${type} GENERATED ALWAYS AS (${field.dbGenerated}) STORED`;
}
```

MySQL 5.7 introduced both STORED and VIRTUAL. The default MySQL convention when neither is named is VIRTUAL — Forge inverts that by always emitting STORED so the column is unconditionally indexable on InnoDB. (Pre-8.0.13, indexes on VIRTUAL columns required extra ceremony and didn't survive every storage-engine combination. Defaulting to STORED keeps the index path universal.)

To opt into VIRTUAL on MySQL, append the keyword to the expression string:

```ts
total: f.decimal().dbgenerated('price * qty VIRTUAL'),
```

Forge emits the expression verbatim. The DDL becomes:

```sql
`total` DECIMAL GENERATED ALWAYS AS (price * qty VIRTUAL) STORED
```

That's a syntax error — both `VIRTUAL` and `STORED` end up in the statement. The override pattern only works if you understand Forge's emitter appends `STORED` after the closing paren; the cleanest workaround is to drop into raw SQL via `db.$execRaw` and skip `.dbgenerated()` for the VIRTUAL case.

MariaDB 10.2+ accepts the same syntax with the alias `PERSISTENT` for STORED. Forge's MySQL adapter emits the SQL-standard `STORED` keyword, which MariaDB also accepts.

### SQLite — 3.31+ STORED default, VIRTUAL opt-in

```ts
// src/adapters/sqlite/ddl.ts
if (field.dbGenerated) {
  return `${colName} ${type} GENERATED ALWAYS AS (${field.dbGenerated}) STORED`;
}
```

SQLite added generated columns in 3.31.0 (January 2020). The default mode when neither STORED nor VIRTUAL is named is VIRTUAL — Forge again inverts and emits STORED for index symmetry.

SQLite's STORED columns count against the `SQLITE_LIMIT_COLUMN` (default 2000) and add bytes to every row. VIRTUAL columns are computationally free at write but force re-evaluation on every read. For tiny expressions over already-loaded columns the cost is rounding error; for `JSON_EXTRACT` over a 64KB JSON blob it's a meaningful difference.

VIRTUAL is indexable on SQLite via expression indexes: `CREATE INDEX idx ON t(virtual_col)` — the planner treats it as a partial materialisation. Practical tip: if you need to query the projection cheaply, prefer STORED; if you only need it in `SELECT` results, VIRTUAL.

### DuckDB — no native generated columns

DuckDB **does not implement** generated columns at the DDL level. The DuckDB adapter does not emit any GENERATED clause; Forge skips with a warning at compile time and the column is silently absent from the created table.

The recommended substitute is a **view**:

```ts
const Money = model('money', {
  id:     f.id(),
  amount: f.decimal({ precision: 12, scale: 2 }),
});

const MoneyView = model('money_with_doubled', {
  id:      f.id(),
  amount:  f.decimal({ precision: 12, scale: 2 }),
  doubled: f.decimal({ precision: 14, scale: 2 }),
}).asView({ sql: 'SELECT id, amount, amount * 2 AS doubled FROM money' });
```

DuckDB views are materialised lazily; the projection runs on every query. Since DuckDB is column-oriented, the cost is much smaller than the equivalent on a row store.

For a precomputed projection, `CREATE TABLE AS SELECT` into a derived table and refresh on cadence. DuckDB has no `REFRESH MATERIALIZED VIEW` — Forge's `view.refresh()` falls back to `TRUNCATE + INSERT SELECT` in a transaction.

### MSSQL — AS (expr) PERSISTED

MSSQL has had **computed columns** since SQL Server 2000. The syntax differs from the SQL standard: no `GENERATED ALWAYS AS` keyword — just `AS (expression)`. Add `PERSISTED` to materialise on disk; omit it to compute on read.

The MSSQL adapter inherits the Postgres DDL generator and rewrites the output for T-SQL (see `src/adapters/mssql/ddl.ts`). The `GENERATED ALWAYS AS (…) STORED` clause from the PG emitter passes through unchanged, but SQL Server does not accept that syntax — you need to rewrite the schema to use raw SQL via `db.$execRaw` or post-process the migration. The cleanest pattern on MSSQL today is to keep the generated column off the model and add it via a follow-up migration:

```ts
const Order = model('orders', {
  id:    f.id(),
  qty:   f.int(),
  price: f.decimal({ precision: 12, scale: 2 }),
});

// In a migration file, after forge push:
await db.$execRaw`
  ALTER TABLE [orders]
  ADD [total] AS ([qty] * [price]) PERSISTED;
`;
```

PERSISTED is required for indexing on MSSQL — non-persisted computed columns can only be indexed if the expression is deterministic and precise, which excludes most JSON-path or string-function expressions.

For a comparison of MSSQL's restrictions:

| Property | PERSISTED | non-persisted |
|---|---|---|
| On-disk storage | yes | no |
| Index allowed | yes (always) | only if expression is deterministic + precise |
| `WHERE` filter | uses index when present | re-evaluates expression |
| Recompute on column change | recomputed on dependency update | next read |

### Mongo — not native

MongoDB does not have generated columns. The `.dbgenerated()` modifier on a Mongo-targeted model warns at push time and the field is silently dropped from any insert / update path.

The closest Mongo equivalent is one of:

* **Aggregation `$expr`** — compute the projection at query time:
  ```js
  db.users.find({ $expr: { $eq: [{ $toLower: '$name' }, 'alice'] } });
  ```
  Cheap if the result set is small. No index, so full scan.

* **`$addFields` in an aggregation pipeline** — same idea, persisted into the result documents but not the source.

* **Materialised view via `$merge` / `$out`** — run an aggregation, write the projected fields into a sibling collection, refresh on schedule. Forge's `.asView({ pipeline })` builds this.

* **Application-layer mirror** — extract the field in the wrapper before `insertOne` / `updateOne` and store it as a real field. Most common in practice; works with every Mongo index type.

---

## STORED vs VIRTUAL — the trade-off

| | STORED | VIRTUAL |
|---|---|---|
| Disk cost | Adds a real column to every row | None |
| Write cost | Expression evaluated and written on INSERT/UPDATE | None at write |
| Read cost | Plain column read | Expression evaluated on every read |
| Indexable | Yes, every dialect | Postgres no; MySQL yes; SQLite yes (expression index) |
| Recovery after expression change | Recomputed on `ALTER TABLE … DROP/ADD` cycle | Recomputed on next read |
| `forge diff` sees expression changes | No — only column presence and type | Same |

The 80/20 default — **STORED** for indexed columns, **VIRTUAL** for occasional reads. Forge defaults to STORED so the indexability path is universal; override per-column when you have a measured reason.

A worked example: a `name_lc` lowercase mirror on a 50M-row users table. STORED adds about 250MB of disk (assuming a 5-byte average name) but lets a `UNIQUE INDEX (name_lc)` give O(log n) duplicate detection on every insert. VIRTUAL is free at write but the lookup becomes a sequential scan on every signup — at 50M rows, several seconds per check. STORED wins.

The opposite case: a `last_seen_iso` column computed as `to_char(last_seen_at, 'YYYY-MM-DD')` for ad-hoc reports. Never indexed, queried only by the analytics team on a daily cadence. VIRTUAL is free; STORED is wasted bytes.

---

## Indexability

| Dialect | STORED indexable | VIRTUAL indexable |
|---|---|---|
| Postgres 12+ | Yes (B-tree, GIN, GiST, etc.) | n/a — Postgres has no VIRTUAL; use an expression index on the source column |
| MySQL 5.7+ | Yes (B-tree, FULLTEXT) | Yes on InnoDB 5.7+, with caveats pre-8.0.13 |
| SQLite 3.31+ | Yes | Yes via expression-index syntax `CREATE INDEX idx ON t(col)` |
| DuckDB | n/a | n/a |
| MSSQL | Yes (PERSISTED) | Only if deterministic + precise |
| Mongo | n/a | n/a |

Forge's `indexes: [{ keys: { generated_col: 1 } }]` works on every dialect that supports the column. Cross-link: [INDEXES.md — Indexing generated and expression columns](./INDEXES.md#expression-indexes).

For the Postgres tsvector pattern specifically — generated column with `GENERATED ALWAYS AS (to_tsvector(...)) STORED` + a `method: 'gin'` index — see [INDEXES.md § (f)](./INDEXES.md#f-postgres-tsvector-with-generated-column--gin).

---

## JSON-extract → indexed scalar pattern

The single highest-leverage use of generated columns: pulling one path out of a JSON blob into a real, indexable column.

The shape:

```ts
const Event = model('events', {
  id:      f.id(),
  payload: f.json(),
  user_id: f.string().dbgenerated(`("payload" ->> 'user_id')`),
}, {
  indexes: [{ keys: { user_id: 1 } }],
});
```

The `user_id` column is a STORED extract of `payload->>'user_id'`. PG indexes it as a plain text B-tree. Filtering on `user_id` skips the JSON-extraction work entirely; filtering on `payload.user_id` via the path operator (`where: { payload: { path: 'user_id', equals: '…' } }`) still re-extracts and ignores the index.

Per-dialect expressions you'd pass to `.dbgenerated`:

| Dialect | Extract expression for `payload.user_id` (string) |
|---|---|
| Postgres | `("payload" ->> 'user_id')` |
| MySQL | `JSON_UNQUOTE(JSON_EXTRACT(\`payload\`, '$.user_id'))` |
| SQLite | `json_extract("payload", '$.user_id')` |
| MSSQL | `JSON_VALUE([payload], '$.user_id')` |

For numeric paths, the cast matters — `age` from JSON needs `CAST(... AS UNSIGNED)` on MySQL, `(... ->> 'age')::int` on PG. Mismatched casts will compile but the index becomes useless for range queries.

A second worked example from [MYSQL.md § Indexing JSON via generated columns](./MYSQL.md#indexing-json-via-generated-columns):

```ts
const User = model('users', {
  id:   f.id(),
  meta: f.json(),
  age:  f.int().dbgenerated("CAST(JSON_UNQUOTE(JSON_EXTRACT(meta, '$.profile.age')) AS UNSIGNED)"),
}, {
  indexes: [{ keys: { age: 1 }, name: 'idx_users_age' }],
});
```

For the same workload without the projection — query `meta.profile.age` directly via the path operator — see [JSON-PATH.md](./JSON-PATH.md). The path operator is the right tool for occasional queries; the generated-column pattern is the right tool for indexed range scans.

---

## CHECK constraints and foreign keys on generated columns

**CHECK constraints** work the same on generated columns as on regular columns on PG / MySQL / SQLite / MSSQL. The DB validates the constraint after computing the expression. Forge doesn't have a dedicated `.check()` modifier — declare CHECK constraints via `db.$execRaw` after `forge push` or via raw SQL in a migration file.

```sql
-- After forge push:
ALTER TABLE orders ADD CONSTRAINT chk_total_positive CHECK (total > 0);
```

**Foreign keys** referencing a generated column are restricted:

* **Postgres** — a generated column can be referenced as a foreign-key target if it has a unique constraint. Rare in practice (you'd rarely want a derived value to be a FK target).
* **MySQL** — generated columns can be FK targets if STORED + uniquely indexed. VIRTUAL columns cannot.
* **SQLite** — no FK on generated columns.
* **MSSQL** — PERSISTED computed columns can be FK targets; non-persisted cannot.

The common case is the inverse: a regular column references a regular column, and the generated column is a projection used for queries. Don't reach for generated-column FKs unless you have a measured reason.

---

## Drift detection — what forge diff catches

`forge diff` reads back the actual database schema via the dialect's introspect path (`src/adapters/<dialect>/introspect.ts`) and compares it against the model. For generated columns the comparison is **structural, not semantic**:

* **Column presence** — if the model declares `total: f.decimal().dbgenerated('price * qty')` and the table doesn't have a `total` column, that surfaces as `{ kind: 'column', direction: 'missing' }`.
* **Column type** — if the column type drifted (e.g. someone hand-altered `total` from `DECIMAL(14,2)` to `INT`), that's `{ kind: 'columnType', direction: 'mismatch' }`.
* **The expression itself** — **not compared**. If the DB has `total AS (price * qty)` and the model now says `dbgenerated('price * qty * 1.07')`, `forge diff` does not catch the change. The introspect path does not read back generated-column expressions on every dialect.

That's a known limitation. The remediation when an expression changes:

1. Detect the change in code review (the model file diff is the source of truth).
2. Drop and recreate the column in a manual migration:
   ```sql
   ALTER TABLE orders DROP COLUMN total;
   ALTER TABLE orders ADD COLUMN total DECIMAL(14,2) GENERATED ALWAYS AS (price * qty * 1.07) STORED;
   ```
3. STORED columns are recomputed on the `ADD COLUMN` pass — no data backfill needed.

The runtime drift-apply pass (`applyDrift` in `src/wasm/drift-apply.ts`) refuses to ADD a missing generated column:

```ts
// src/wasm/drift-apply.ts
function isSafeAddColumn(field: FieldDef): boolean {
  if (field.kind === 'id') return false;
  if (field.dbGenerated) return false;   // CREATE-TIME only on SQLite
  ...
}
```

Why: SQLite does not implement `ALTER TABLE … ADD COLUMN … GENERATED`. The only path is a full table rebuild. The drift-apply pass refuses to do that unsupervised. Missing generated columns surface in `report.pending` for the caller to handle.

See [DIFF.md § Safe-apply vs pending](./DIFF.md#safe-apply-vs-pending--what-runs-unattended) for the full bucket policy.

---

## Writes — never

The wrapper drops generated-column fields from every write path:

* `db.model.create({ data: { ... } })` — generated columns rejected at the TS level (the input shape inferred from the model omits them).
* `db.model.update({ where, data: { ... } })` — same.
* `db.model.upsert({ where, create, update })` — same on both sides.
* `db.model.createMany({ data: [...] })` — same.

If you try to write one via raw SQL the DB rejects:

```sql
-- PG: ERROR: column "total" can only be updated to DEFAULT
INSERT INTO orders (id, qty, price, total) VALUES ('1', 2, 10.00, 999.99);
```

The DEFAULT shortcut is the only legal write — `INSERT INTO ... (id, qty, price, total) VALUES ('1', 2, 10.00, DEFAULT)`. The wrapper doesn't emit either form; it omits the column entirely.

`db.model.findMany({ select: { total: true } })` includes the generated column in the projection — reads work normally.

---

## Replacing an expression

When the SQL expression changes, the database has no `ALTER COLUMN` path on most dialects. The replacement pattern:

**Postgres / MySQL** — `ALTER TABLE` ADD then DROP:

```sql
ALTER TABLE orders ADD COLUMN total_new DECIMAL(14,2) GENERATED ALWAYS AS (price * qty * 1.07) STORED;
ALTER TABLE orders DROP COLUMN total;
ALTER TABLE orders RENAME COLUMN total_new TO total;
```

This preserves indexes if you DROP + recreate them in the same transaction. STORED columns are recomputed during ADD.

**SQLite** — full table rebuild:

```sql
BEGIN;
CREATE TABLE orders_new (id, qty, price, total DECIMAL GENERATED ALWAYS AS (price * qty * 1.07) STORED);
INSERT INTO orders_new (id, qty, price) SELECT id, qty, price FROM orders;
DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;
COMMIT;
```

The wrapper-generated migration (`forge migrate gen`) does not produce these rewrites automatically for expression changes — that's the limitation above. Hand-write the migration when the expression changes.

**MSSQL** — `DROP COLUMN` then `ADD`:

```sql
ALTER TABLE orders DROP COLUMN total;
ALTER TABLE orders ADD total AS (qty * price * 1.07) PERSISTED;
```

Indexes on the column must be dropped before `DROP COLUMN` succeeds. Recreate them after the ADD.

**DuckDB** — drop the view, recreate. No table-level work.

**Mongo** — n/a, no native concept.

---

## Use cases

The patterns that come up in practice:

* **Lowercase mirrors for case-insensitive matching** — `name_lc: f.string().dbgenerated('LOWER(name)')` + a unique index. Works on PG / MySQL / SQLite. On PG, `citext` is an alternative but isn't auto-emitted by forge.
* **JSON path projections for indexing** — pull one field out of a `f.json()` blob into a typed column with an index. The most common use of the feature.
* **Computed totals** — `total = qty * price`, `subtotal_with_tax = subtotal * (1 + tax_rate)`. Read-side convenience; saves the application from recomputing on every query.
* **Denormalised search columns** — concatenate multiple text columns into a generated `tsvector` for PG GIN search, or a generated `MATCH AGAINST` candidate column for MySQL FULLTEXT.
* **Slug / canonical-form columns** — normalised URL slugs derived from a title.
* **Date bucketing for partition pruning** — `created_date: f.dateTime().dbgenerated("date_trunc('day', created_at)")` as a Postgres partition key.
* **Foreign-key disambiguation** — split a composite identifier into typed parts for joins. Niche, but real when integrating legacy schemas.

What **not** to use generated columns for:

* Dynamic defaults that depend on runtime state — `created_by` (current user), `tenant_id` (request scope). Generated columns can't see request-scoped state; use a wrapper service or set the value at create time.
* Computed values that need backfill control — generated columns recompute on every write, deterministically. If you need to freeze a value at create time (e.g. snapshot of the unit price when the order was placed), use a regular column with a wrapper service.
* Cross-row aggregates (counts, sums over related rows). Generated columns operate per-row only. Use a materialised view (`asView({ sql, materialised: true })`) instead.

---

## Browser sqlite-wasm support

Forge's browser adapter ships sqlite-wasm 3.46+ (well above the 3.31 floor that introduced generated columns). The OPFS / OPFS-SAHPool / `:memory:` drivers all support `.dbgenerated()`.

```ts
import { createBrowserClient, f, model } from 'forge-orm/browser';

const Note = model('notes', {
  id:       f.id(),
  title:    f.string(),
  title_lc: f.string().dbgenerated('LOWER(title)'),
}, {
  indexes: [{ keys: { title_lc: 1 } }],
});

const db = createBrowserClient({ schema: { note: Note }, url: 'opfs:/notes.db' });
await db.$migrate();   // emits CREATE TABLE with the GENERATED column
```

Runtime drift-apply (`db.$migrate()`) refuses to ADD a missing generated column on an existing table — same SQLite limitation as the server adapter. Net effect: schema changes that add a generated column show up as `report.pending` on the browser and require a manual DB rebuild (drop the OPFS file and re-create from server data) or a hand-written migration in `db.$execRaw`.

See [BROWSER.md § `db.$migrate()`](./BROWSER.md#dbmigrate--runtime-ddl-apply--drift-detection) for the full runtime DDL story.

---

## Worked examples

### (a) Extract email-host from JSON for indexing

A `users` table where the email lives inside a `profile` JSON blob. We want to index by host (everything after the `@`) for tenant lookups.

```ts
import { f, model } from 'forge-orm';

const User = model('users', {
  id:      f.id(),
  profile: f.json(),
  email_host: f.string().dbgenerated(
    `SUBSTRING("profile" ->> 'email' FROM POSITION('@' IN "profile" ->> 'email') + 1)`,
  ),
}, {
  indexes: [{ keys: { email_host: 1 }, name: 'idx_users_email_host' }],
});
```

PG emits:

```sql
CREATE TABLE "users" (
  "id" text PRIMARY KEY,
  "profile" jsonb NOT NULL,
  "email_host" text GENERATED ALWAYS AS (
    SUBSTRING("profile" ->> 'email' FROM POSITION('@' IN "profile" ->> 'email') + 1)
  ) STORED
);
CREATE INDEX "idx_users_email_host" ON "users" ("email_host");
```

Query — fully indexed:

```ts
await db.user.findMany({ where: { email_host: 'acme.com' } });
```

The MySQL equivalent uses `SUBSTRING_INDEX`:

```ts
email_host: f.string().dbgenerated(
  "SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(profile, '$.email')), '@', -1)",
),
```

SQLite needs `substr` + `instr`:

```ts
email_host: f.string().dbgenerated(
  `substr(json_extract("profile", '$.email'), instr(json_extract("profile", '$.email'), '@') + 1)`,
),
```

Three dialects, three expressions — the cross-dialect projection has to be hand-tuned per adapter.

### (b) Lowercase username for case-insensitive uniqueness

The classic. Lifted from [MYSQL.md § The `mode: 'insensitive'` flag](./MYSQL.md#the-mode-insensitive-flag):

```ts
const User = model('users', {
  id:       f.id(),
  username: f.string(),
  username_lc: f.string().dbgenerated('LOWER(username)'),
}, {
  indexes: [{ keys: { username_lc: 1 }, unique: true }],
});
```

PG / MySQL / SQLite all accept `LOWER(...)` identically. The unique index guarantees no two users can share the same case-folded username — `Alice` and `alice` collide at insert time, the DB raises `ForgeUniqueViolationError`, and the wrapper surfaces it.

Querying:

```ts
const u = await db.user.findFirst({ where: { username_lc: 'alice' } });
```

The application code never writes `username_lc` — the DB computes it. The TS type of `User.create({ data: { ... } })` omits `username_lc` from the accepted shape.

On Mongo the same shape needs an application-side mirror:

```ts
const User = model('users', {
  id: f.id(),
  username: f.string(),
  username_lc: f.string(),   // app-set
}, {
  indexes: [{ keys: { username_lc: 1 }, unique: true }],
});

// Wrap creates with a service that sets username_lc:
await db.user.create({
  data: { username: 'Alice', username_lc: 'alice' },
});
```

### (c) Order total = qty * price

A line-item table where the row total is derived from quantity and unit price:

```ts
const LineItem = model('line_items', {
  id:    f.id(),
  qty:   f.int(),
  price: f.decimal({ precision: 12, scale: 2 }),
  total: f.decimal({ precision: 14, scale: 2 }).dbgenerated('"price" * "qty"'),
});
```

PG emits:

```sql
CREATE TABLE "line_items" (
  "id" text PRIMARY KEY,
  "qty" integer NOT NULL,
  "price" numeric(12,2) NOT NULL,
  "total" numeric(14,2) GENERATED ALWAYS AS ("price" * "qty") STORED
);
```

Insert — no `total`:

```ts
await db.lineItem.create({
  data: { id: 'li-1', qty: 3, price: '12.50' },
});
// Row: { id: 'li-1', qty: 3, price: '12.50', total: '37.50' }
```

The wider precision on `total` (14,2 vs 12,2 for `price`) leaves headroom for the multiplication — `qty=999, price=99999999.99` overflows the source column but fits in the generated total.

A subtle pitfall: `f.decimal()` is JS-typed as `string` to avoid float-precision loss. The generated `total` is also a string in the JS shape — sum-of-totals across rows still has to go through a decimal library on the client.

### (d) MSSQL persisted column with index

MSSQL's syntax differs. The cleanest pattern is to leave `.dbgenerated` off the model and add the computed column via a follow-up migration:

```ts
const Order = model('orders', {
  id:    f.id(),
  qty:   f.int(),
  price: f.decimal({ precision: 12, scale: 2 }),
});
```

In a migration file (or after `forge push`):

```ts
await db.$execRaw`
  ALTER TABLE [orders]
  ADD [total] AS ([qty] * [price]) PERSISTED;
`;
await db.$execRaw`
  CREATE INDEX [idx_orders_total] ON [orders]([total]);
`;
```

The `PERSISTED` keyword is essential — without it, the index either fails (non-deterministic expressions) or works but re-evaluates on every probe (defeating the index). For decimal arithmetic the expression *is* deterministic + precise, but the PERSISTED guarantee is always cheaper.

Reading back through the wrapper: the `total` column isn't in the model, so `findMany` won't return it. Either add it to the model as a plain (non-generated) field and rely on the DB to never let the application write it (use a CHECK constraint or trigger), or query via `$queryRaw`:

```ts
const rows = await db.$queryRaw<{ id: string; total: string }[]>`
  SELECT [id], [total] FROM [orders] WHERE [id] = ${orderId};
`;
```

The MSSQL story is the rough one — generated columns are usable but not first-class in the model. PG / MySQL / SQLite are the polished path.

---

## Common mistakes

* **Quoting style mismatched to dialect.** `'"price" * "qty"'` works on PG and SQLite, fails on MySQL (the backticks would need to be `` `price` * `qty` ``). For cross-dialect schemas, use bare identifiers if the column names are unambiguous (lowercase, no reserved words): `'price * qty'` parses on every dialect.

* **Trying to write the generated column.** TS prevents this at the type level; raw SQL doesn't. `INSERT INTO ... (total) VALUES (...)` fails with a clear error from every DB. Look for the column in your raw-SQL migration scripts after a schema change.

* **Expecting forge diff to catch expression changes.** It doesn't. The model file is the source of truth; code review is the safety net.

* **Adding a generated column to an existing table on SQLite.** Not supported — SQLite has no `ALTER ADD GENERATED`. The drift-apply pass surfaces it in `report.pending`. The fix is a full table rebuild via raw SQL.

* **Indexing a VIRTUAL column on Postgres.** Postgres has no VIRTUAL. The mistake usually surfaces as a forge-push error on an unknown column property — the expression string was passed through verbatim and PG rejected it.

* **`.dbgenerated()` on Mongo.** Silently dropped at push (with a warn). If the test suite is configured against SQLite and production is Mongo, the column quietly vanishes on production. Catch it in CI by running `forge doctor` against the production adapter.

* **MSSQL `GENERATED ALWAYS AS (…) STORED` syntax.** MSSQL's syntax is `AS (…) PERSISTED`, not the SQL-standard form. Forge's MSSQL adapter inherits the PG emitter — the inherited `GENERATED … STORED` form is rejected by SQL Server. Keep `.dbgenerated()` off MSSQL models and use a follow-up `ALTER TABLE ... ADD ... AS (...) PERSISTED` instead.

* **Append `VIRTUAL` to override the STORED default — emit conflict.** The MySQL / SQLite STORED keyword is appended after the closing paren by the emitter. Passing `'price * qty VIRTUAL'` produces `GENERATED ALWAYS AS (price * qty VIRTUAL) STORED` — a syntax error. To opt into VIRTUAL today, declare the column in raw SQL (`db.$execRaw`) instead.

* **Forgetting the index.** A generated column without an index is rarely worth the disk cost. The pattern is generated-column-PLUS-index — if you're not indexing, prefer the path operator (`where: { meta: { path: 'foo' } }`) or a view.

* **Decimal precision overflow.** `total: f.decimal({ precision: 12, scale: 2 }).dbgenerated('qty * price')` overflows when `qty * price` exceeds 12 digits. Widen the precision on the generated column above the source columns by enough to absorb the multiplication.

---

## See also

* [README — Defining a schema](../README.md#defining-a-schema) — the surface chapter on `f.*` and `model(...)`.
* [MODEL.md — Generated / computed columns](./MODEL.md#generated--computed-columns) — the modifier in the broader field catalogue.
* [INDEXES.md — Postgres tsvector with generated column + GIN](./INDEXES.md#f-postgres-tsvector-with-generated-column--gin) — the canonical full-text pattern.
* [JSON-PATH.md](./JSON-PATH.md) — querying `f.json()` paths without a generated column.
* [MIGRATIONS.md](./MIGRATIONS.md) — `forge push`, `forge diff`, and the drift loop.
* [DIFF.md — Safe-apply vs pending](./DIFF.md#safe-apply-vs-pending--what-runs-unattended) — why runtime drift-apply refuses to ADD a generated column.
* [BROWSER.md — `db.$migrate()`](./BROWSER.md#dbmigrate--runtime-ddl-apply--drift-detection) — runtime DDL apply in the browser.
* [MYSQL.md — Generated columns](./MYSQL.md#generated-columns) — the MySQL-specific story.
* [POSTGRES.md](./POSTGRES.md) — the Postgres deep-dive, including `citext` alternatives.
