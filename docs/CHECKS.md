# CHECK constraints

DB-enforced row predicates — declarative, cheap, always-on. Use for invariants you want true regardless of which client wrote the row. This page covers `f.check(expr)`, the per-dialect support matrix (Postgres NOT VALID + VALIDATE, MySQL 8 enforcement, SQLite always, Mongo `$jsonSchema`), NULL semantics, and the patterns that compose with zod / triggers / enums.

Related deep-dives:

* [MODEL.md](./MODEL.md) — `f.enumOf(...)` (the one CHECK forge emits today on its own).
* [MIGRATIONS.md](./MIGRATIONS.md) — `forge diff apply` and the hand-edit migration path, which is how custom CHECK predicates land.
* [INDEXES.md](./INDEXES.md) — partial indexes (`filter`) and the "unique partial index as cross-row check" pattern.
* [MONGO.md](./MONGO.md) — collection validators on Mongo.

---

## Contents

* [What a CHECK is](#what-a-check-is)
* [What forge ships today](#what-forge-ships-today)
* [Custom CHECKs — the migration-file path](#custom-checks--the-migration-file-path)
* [Per-dialect support matrix](#per-dialect-support-matrix)
  * [Postgres](#postgres)
  * [MySQL](#mysql)
  * [SQLite](#sqlite)
  * [DuckDB](#duckdb)
  * [MSSQL](#mssql)
  * [Mongo `$jsonSchema`](#mongo-jsonschema)
* [Common expressions](#common-expressions)
* [NULL semantics — the three-valued-logic trap](#null-semantics--the-three-valued-logic-trap)
* [Cross-row CHECKs don't exist](#cross-row-checks-dont-exist)
* [Adding a CHECK to a populated table](#adding-a-check-to-a-populated-table)
* [Drift detection and CHECK constraints](#drift-detection-and-check-constraints)
* [CHECK vs zod](#check-vs-zod)
* [CHECK vs trigger](#check-vs-trigger)
* [CHECK vs enum](#check-vs-enum)
* [Worked examples](#worked-examples)
* [Common mistakes](#common-mistakes)

---

## What a CHECK is

A CHECK constraint attaches a boolean expression to a table; on every `INSERT` or `UPDATE` the database evaluates the expression against the candidate row and rejects the write if it returns `FALSE`. There is no application-side bypass — the constraint runs on the same code path whether the row came from your app, a one-off `psql` session, an `INSERT … SELECT` from another table, or a logical replication apply.

That's the property worth paying for. zod stops bad rows at your HTTP handler. CHECK stops them at every writer the database has, including the ones you'll add next year.

| Concern | Belongs in zod / app | Belongs in CHECK |
|---|---|---|
| "The HTTP body has the right shape" | yes | no |
| "After parsing, `total >= 0`" | yes | yes |
| "`status` is one of the allowed strings" | yes | yes (and `f.enumOf` handles this for you) |
| "If `kind = 'shipped'` then `tracking_no IS NOT NULL`" | yes | yes |
| "`start_at < end_at`" | yes | yes |
| "Email contains an `@`" | yes (full RFC) | optional sanity check |

The rule of thumb: every row-level invariant that a future writer could violate goes into a CHECK. Anything that depends on context the database doesn't have (the current request, an FK lookup against an unrelated table) stays in the application.

CHECKs are cheaper than triggers — the planner inlines them into the write path. They're more typed than zod in the sense that the DB schema *is* the contract: introspect the table and the constraint is right there.

---

## What forge ships today

Forge's schema DSL doesn't have a `f.check(expr)` builder yet. What it *does* ship is one CHECK family, generated for you, plus three composable paths for everything else.

**(1) Enum CHECKs — automatic.** Every `f.enumOf([...])` field gets a `CHECK (col IN (...))` constraint on the dialects without native enum types. Look at the per-dialect DDL in MODEL.md:

```ts
const Membership = model('memberships', {
  id:   f.id(),
  role: f.enumOf(['OWNER', 'ADMIN', 'MEMBER'] as const),
});
```

| Dialect | What forge emits |
|---|---|
| Postgres | `CREATE TYPE "Role" AS ENUM (...)` + `"role" "Role" NOT NULL` — no CHECK needed, the type *is* the constraint |
| MySQL | `role ENUM('OWNER','ADMIN','MEMBER')` — same |
| SQLite | `role TEXT NOT NULL CHECK (role IN ('OWNER','ADMIN','MEMBER'))` |
| DuckDB | `role TEXT NOT NULL CHECK (role IN ('OWNER','ADMIN','MEMBER'))` |
| MSSQL | `[role] NVARCHAR(64) NOT NULL CHECK ([role] IN ('OWNER','ADMIN','MEMBER'))` |
| Mongo | string field, validation rides on the TS type |

The constraint name is derived deterministically (`<table>_<col>_enum_chk` or the dialect's equivalent), so introspection round-trips it and drift detection notices when the set drifts from the schema. Add a value to the tuple, `forge push`, and the constraint gets dropped and recreated with the new list.

**(2) Partial unique indexes — for "this row is the only one of its kind".** Lots of "CHECK"-shaped invariants are really *uniqueness with a predicate*, and forge expresses these directly via the index `filter`:

```ts
const Subscription = model('subscriptions', {
  id:         f.id(),
  org_id:     f.objectId(),
  status:     f.enumOf(['active', 'canceled', 'past_due'] as const),
}, {
  indexes: [
    // "at most one active subscription per org" — DB-enforced.
    { keys: { org_id: 1 }, unique: true, filter: "status = 'active'" },
  ],
});
```

This is *not* a CHECK in the SQL sense, but it covers the patterns CHECK would otherwise serve when the invariant is "this combination doesn't repeat". See [INDEXES.md](./INDEXES.md) for the full partial-index reference.

**(3) Hand-edited migration — for everything else.** Custom predicate CHECKs go through the `forge diff apply` path. You write `ALTER TABLE … ADD CONSTRAINT … CHECK (…)` into the generated migration file, commit it, and the `_forge_migrations` ledger remembers it forever. The next section walks through this end-to-end.

---

## Custom CHECKs — the migration-file path

`forge push` is declarative — it reflects the schema you wrote. Anything outside the schema language (custom CHECKs, triggers, materialised view refresh hooks) lives in a hand-written migration. The drill:

**1. Run a no-op `diff apply` to bootstrap the migrations folder.**

```sh
npx forge diff apply --dry
```

If there's no drift, no file lands; create one by hand under `./migrations/`:

```sh
mkdir -p migrations
$EDITOR migrations/20260624T000000_add_order_checks.sql
```

Use the file shape `forge diff apply` writes (covered in [MIGRATIONS.md](./MIGRATIONS.md#what-ends-up-in-migrations)): a header, an `-- up` block, a `-- down` block.

**2. Add the CHECKs in `-- up`, the drops in `-- down`.**

```sql
-- forge migration: 20260624T000000_add_order_checks
-- generated: 2026-06-24T00:00:00.000Z

-- up
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_total_nonneg_chk" CHECK ("total" >= 0);
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_window_chk" CHECK ("start_at" < "end_at");

-- down
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_window_chk";
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_total_nonneg_chk";
```

**3. Apply the migration.**

```sh
npx forge diff apply
```

The ledger records the file name, the SHA, and the apply timestamp. `forge rollback` runs the `-- down` block when you ask it to.

**4. Add the schema-side hint as a comment.** The CHECK lives in the migration, not the schema, so the schema file alone doesn't tell the next reader the invariant exists. A short comment on the model fixes that:

```ts
const Order = model('orders', {
  id:       f.id(),
  total:    f.int(),       // CHECK (total >= 0) — orders_total_nonneg_chk
  start_at: f.dateTime(),  // CHECK (start_at < end_at) — orders_window_chk
  end_at:   f.dateTime(),
});
```

**5. Run `forge diff` after.** The differ doesn't know about CHECKs you added by hand; on Postgres it'll see them via `pg_constraint` and ignore them as long as they don't clash with anything forge would emit. On MySQL 8 and MSSQL the same holds.

If you'd rather skip the file and run the SQL directly from a script, `db.$executeRaw` works too — but you give up the ledger and the rollback path, so reserve that for one-offs (e.g. a CHECK that's only present in the dev DB while you're iterating).

---

## Per-dialect support matrix

| Dialect | Enforced | Online add | Subquery in CHECK | Function calls | Notes |
|---|---|---|---|---|---|
| Postgres | yes, always | yes — `NOT VALID` then `VALIDATE CONSTRAINT` | no | yes (must be `IMMUTABLE`) | The reference implementation; everything works. |
| MySQL 8.0+ | yes | online via `ALGORITHM=INPLACE` | no | only deterministic | 5.7 parsed CHECK but silently ignored it — don't ship to 5.7 and assume enforcement. |
| SQLite | yes, always | no — table rebuild via 12-step pattern | no | yes (must be deterministic) | CHECKs are part of `CREATE TABLE`; adding one to a live table needs the SQLite recommended rebuild dance. |
| DuckDB | yes, on write | yes — `ALTER TABLE ADD CONSTRAINT CHECK` | no | yes | Behaves like Postgres for CHECK purposes. |
| MSSQL | yes | `WITH NOCHECK` skips backfill validation; `WITH CHECK` validates existing rows | no | yes (UDF must be deterministic + schema-bound) | `ALTER TABLE … WITH NOCHECK ADD CONSTRAINT` is MSSQL's `NOT VALID` equivalent. |
| Mongo | as part of `validator` on the collection | yes — `db.runCommand({ collMod, validator })` | no | `$expr` predicates only | Not literally a CHECK; the equivalent is a `$jsonSchema` validator or an `$expr` predicate. |

### Postgres

Postgres CHECK constraints are evaluated row-by-row on every insert / update. The constraint name shows up in `pg_constraint` and surfaces back through `adapter.introspect()` as a string the differ can compare.

```sql
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_nonneg_chk" CHECK (total >= 0);
```

The `NOT VALID` clause is the big win on Postgres. It splits the constraint into two phases — *create*, which only enforces the predicate on *new* writes, and *validate*, which scans the existing rows. The create is essentially free; the validate scan happens online and can be backgrounded.

```sql
-- Phase 1: instant. New writes start being checked.
ALTER TABLE orders
  ADD CONSTRAINT orders_total_nonneg_chk CHECK (total >= 0) NOT VALID;

-- Phase 2: backfill scan. Can be deferred to a maintenance window.
ALTER TABLE orders VALIDATE CONSTRAINT orders_total_nonneg_chk;
```

This is the only safe way to add a CHECK to a hot table with millions of rows. The single-statement `ADD CONSTRAINT … CHECK (…)` form takes an `ACCESS EXCLUSIVE` lock for the duration of the full-table scan; `NOT VALID` takes the lock for milliseconds.

Function calls inside CHECK must be `IMMUTABLE`. `CHECK (lower(email) LIKE '%@%')` works (`lower` is immutable); `CHECK (now() > created_at)` doesn't (`now` is volatile, and a row-level "time-must-be-past" check wants a trigger anyway).

### MySQL

MySQL 8.0 added enforced CHECK constraints. 5.7 parsed the syntax and threw it away — if you're targeting both versions, document the invariant in zod *and* CHECK, and don't expect 5.7 to catch anything.

```sql
ALTER TABLE orders ADD CONSTRAINT orders_total_nonneg_chk CHECK (total >= 0);
```

Function calls inside CHECK must be deterministic, the same rule as generated columns. `RAND()`, `NOW()`, `UUID()` all fail at create-constraint time.

Online add: `ALTER TABLE … ALGORITHM=INPLACE, LOCK=NONE` works for `ADD CHECK` on InnoDB 8.0+. Run `EXPLAIN` on the ALTER first if you want to confirm — older 8.0 patch levels occasionally fall back to copy.

The 5.7 silent-ignore behaviour is the trap. If your CI hits a 5.7 container and prod is 8.0, a violating row will pass tests and fail in prod. The fix is to pin the test container to a real 8.0 image and treat 5.7 as out of support; forge's `forge doctor` flags MySQL versions below 8.0 with a warning.

### SQLite

SQLite enforces CHECK constraints always — there's no equivalent of MySQL 5.7's silent-ignore. The trade-off is that CHECKs are written into `CREATE TABLE`; adding one to a populated table needs the SQLite-recommended table-rebuild pattern:

```sql
BEGIN;
PRAGMA foreign_keys=OFF;

CREATE TABLE orders_new (
  id      INTEGER PRIMARY KEY,
  total   INTEGER NOT NULL CHECK (total >= 0),
  ...
);
INSERT INTO orders_new SELECT * FROM orders;
DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;

PRAGMA foreign_keys=ON;
COMMIT;
```

In practice, every browser / mobile / embedded use of forge ships a fresh DB on first run (`db.$migrate()`), so CHECKs you declared in your `migrations/` folder get applied at the same moment the table is created. The "ALTER on a live device" case mostly doesn't come up.

If it does — bumping a phone app from v1.0 to v1.1 and the v1.1 schema adds a CHECK to an existing table — the rebuild block above goes into the v1.1 migration file. Test it under realistic row counts; SQLite's rebuild is fast but it's still a full copy.

### DuckDB

DuckDB enforces CHECK on writes like Postgres. The CHECK violation surfaces through the adapter's error mapper:

```ts
// src/adapters/duckdb/errors.ts
if (/CHECK constraint/i.test(msg)) {
  // mapped to forge's P2004 — "Check constraint failed"
}
```

`ALTER TABLE … ADD CONSTRAINT CHECK (…)` works online and doesn't need a rebuild. DuckDB is the simplest dialect to add CHECKs to after the fact.

### MSSQL

`ALTER TABLE … ADD CONSTRAINT … CHECK (…)` validates existing rows by default. To skip the backfill scan (the MSSQL equivalent of Postgres' `NOT VALID`), use `WITH NOCHECK`:

```sql
ALTER TABLE [orders] WITH NOCHECK
  ADD CONSTRAINT [orders_total_nonneg_chk] CHECK ([total] >= 0);
```

A constraint added `WITH NOCHECK` is "untrusted" — the query planner won't use it for optimisation until you run `ALTER TABLE … WITH CHECK CHECK CONSTRAINT …` to mark it trusted. For CHECKs that exist purely as guardrails (no planner help expected), the `NOCHECK` form is the right default on a populated table.

User-defined functions inside CHECK must be `WITH SCHEMABINDING` and deterministic. Same rules as indexed views.

### Mongo `$jsonSchema`

Mongo doesn't have CHECK constraints in the SQL sense. The equivalent is a *validator* attached to the collection — either a `$jsonSchema` document (for shape) or an `$expr` predicate (for row-level conditions), or both.

Set the validator at `createCollection` time, or modify it later with `collMod`:

```ts
await db.$runCommandRaw({
  collMod: 'orders',
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      properties: {
        total: { bsonType: 'int', minimum: 0 },
        start_at: { bsonType: 'date' },
        end_at: { bsonType: 'date' },
      },
    },
    $expr: { $lt: ['$start_at', '$end_at'] },
  },
  validationLevel: 'strict',
  validationAction: 'error',
});
```

`validationLevel: 'strict'` checks every insert and update. `'moderate'` checks inserts and updates of rows that already pass — useful when you turn on validation on a populated collection without forcing a backfill.

`validationAction: 'error'` rejects writes that fail; `'warn'` lets the write through and logs a warning to the server log. `warn` is for the rollout phase, when you've just added a validator and you want to find out how many existing rows violate it before flipping to `error`.

The forge wrapper doesn't auto-emit collection validators — they go through `db.$runCommandRaw` exactly as above. Wrap the setup in a script that runs alongside your seed step. See [MONGO.md](./MONGO.md) for the validator family in full.

---

## Common expressions

The patterns that come up over and over:

```sql
-- Non-negative number
CHECK (total >= 0)
CHECK (quantity > 0)

-- Sane bounds
CHECK (age BETWEEN 0 AND 150)
CHECK (rating BETWEEN 1 AND 5)

-- Allowed values (when f.enumOf isn't right — see "CHECK vs enum" below)
CHECK (currency IN ('USD', 'EUR', 'GBP', 'NGN'))

-- Cross-field temporal ordering
CHECK (start_at < end_at)
CHECK (created_at <= updated_at)

-- Conditional NOT NULL
CHECK (status <> 'shipped' OR tracking_no IS NOT NULL)
CHECK (kind = 'physical' OR weight_g IS NULL)

-- Length / format sanity (don't try to validate full RFC — that's zod's job)
CHECK (length(email) >= 3 AND email LIKE '%_@_%')
CHECK (length(slug) BETWEEN 1 AND 64)
CHECK (slug ~ '^[a-z0-9-]+$')          -- PG regex

-- One-of pattern (xor across nullable FKs)
CHECK ((user_id IS NULL) <> (org_id IS NULL))

-- JSON shape sanity
CHECK (jsonb_typeof(data->'tags') = 'array')                      -- PG
CHECK (JSON_TYPE(data, '$.tags') = 'ARRAY')                       -- MySQL 8
```

The cross-dialect minimum is `=`, `<>`, `<`, `<=`, `>`, `>=`, `AND`, `OR`, `NOT`, `IN (…)`, `BETWEEN`, `IS NULL`, `IS NOT NULL`, `LIKE`. Regex (`~`, `REGEXP`), JSON path operators, and dialect-specific functions need a per-dialect branch in the migration file.

If your CHECK starts to grow nested CASEs and string-building, you're past CHECK's sweet spot — promote it to a `BEFORE INSERT` / `BEFORE UPDATE` trigger or push the rule up to the application.

---

## NULL semantics — the three-valued-logic trap

This is the single biggest reason hand-written CHECKs ship broken: **CHECK passes when the predicate evaluates to NULL.** Per the SQL standard, the constraint succeeds unless the expression is explicitly `FALSE`.

```sql
-- BROKEN. Rows with status = NULL slip through.
CHECK (status IN ('pending', 'shipped', 'cancelled'))
```

`NULL IN (...)` is `NULL`, not `FALSE`, so a `status = NULL` row passes. If the column is nullable and you don't want NULL to count as valid, spell it out:

```sql
CHECK (status IS NOT NULL AND status IN ('pending', 'shipped', 'cancelled'))
```

Or make the column `NOT NULL` and let the column constraint handle the NULL case, leaving the CHECK to handle the value set.

The same trap shows up in cross-field CHECKs:

```sql
-- Passes when end_at IS NULL.
CHECK (start_at < end_at)

-- Tighter — only allow NULL end_at if you actually want "open-ended".
CHECK (end_at IS NULL OR start_at < end_at)
```

For Mongo `$expr` predicates the same rule applies — a missing field is `null`, and comparisons with `null` resolve to `null`, which `validator` treats as pass. Use `$ifNull` or explicit existence checks:

```ts
$expr: {
  $and: [
    { $ne: ['$end_at', null] },
    { $lt: ['$start_at', '$end_at'] },
  ],
}
```

---

## Cross-row CHECKs don't exist

A CHECK can only reference the row being written. You cannot write `CHECK ((SELECT COUNT(*) FROM …) < 5)` — Postgres and the other dialects all reject subqueries in CHECK at constraint-create time.

What people actually want when they ask for a cross-row CHECK:

| Want | Right tool |
|---|---|
| "At most one active row per group" | Partial unique index — `indexes: [{ keys: { group_id: 1 }, unique: true, filter: "status = 'active'" }]` |
| "FK to a row meeting some condition" | Compose: FK column + plain CHECK on a denormalised column, refreshed by trigger |
| "Total balance across the table is zero" | `BEFORE INSERT/UPDATE` trigger, or an application-side ledger |
| "This is the only row of its kind for this tenant" | Composite unique — `uniques: [['tenant_id', 'kind']]` |
| "Less than N rows of kind X" | Application-side enforcement; the DB-side version needs a counter table + trigger |

The unique-partial-index pattern is the workhorse. See the subscription example in [What forge ships today](#what-forge-ships-today) above, and [INDEXES.md](./INDEXES.md) for the filter syntax across dialects.

---

## Adding a CHECK to a populated table

This is the operation that most often goes wrong, because the constraint's existence-check and its data-validation are the same statement on most dialects, and that statement takes a table-level lock.

The two-phase pattern:

**Postgres** — the textbook case. `NOT VALID` + `VALIDATE CONSTRAINT`.

```sql
-- Phase 1: a few milliseconds. Constraint applies to new writes.
ALTER TABLE orders
  ADD CONSTRAINT orders_total_nonneg_chk CHECK (total >= 0) NOT VALID;

-- Phase 2: scan. Holds SHARE UPDATE EXCLUSIVE — concurrent reads + writes OK.
ALTER TABLE orders VALIDATE CONSTRAINT orders_total_nonneg_chk;
```

Run phase 2 during a quiet window. If the scan finds a row that violates, the statement rolls back and the constraint stays `NOT VALID` until you clean the data and re-run.

**MySQL 8.0+** — `ALGORITHM=INPLACE, LOCK=NONE`.

```sql
ALTER TABLE orders
  ADD CONSTRAINT orders_total_nonneg_chk CHECK (total >= 0),
  ALGORITHM=INPLACE, LOCK=NONE;
```

If MySQL can't do inplace it errors immediately — no silent fallback to copy. That's a feature; you find out before running it.

**MSSQL** — `WITH NOCHECK` to skip the backfill, then optionally `WITH CHECK CHECK CONSTRAINT` to mark it trusted.

```sql
ALTER TABLE [orders] WITH NOCHECK
  ADD CONSTRAINT [orders_total_nonneg_chk] CHECK ([total] >= 0);

-- Later, after you've cleaned data:
ALTER TABLE [orders] WITH CHECK CHECK CONSTRAINT [orders_total_nonneg_chk];
```

**SQLite** — table rebuild (see [SQLite](#sqlite) above). On a device DB this runs on the user's machine at app boot; on a server DB it runs once during the maintenance window.

**Mongo** — set the validator at `validationLevel: 'moderate'` first. `moderate` only validates documents that already match the validator (a tautology that means "documents updated after the validator went on"). After enough churn — or an explicit backfill update — flip to `strict`.

```ts
// Phase 1
await db.$runCommandRaw({
  collMod: 'orders',
  validator: { $jsonSchema: { ... } },
  validationLevel: 'moderate',
  validationAction: 'warn',
});

// Phase 2, after fixing data
await db.$runCommandRaw({
  collMod: 'orders',
  validationLevel: 'strict',
  validationAction: 'error',
});
```

In every case the backfill-find step is the same: query for rows that *would* fail, fix them, then promote the constraint. The find-step query is the same shape as the CHECK predicate, just inverted:

```ts
// "Which orders would violate the new CHECK (total >= 0)?"
const offenders = await db.Order.findMany({ where: { total: { lt: 0 } } });
```

---

## Drift detection and CHECK constraints

`forge diff` introspects CHECK constraints on the SQL dialects via the standard catalog (`information_schema.check_constraints`, `pg_constraint`, `sqlite_master`'s SQL column, MSSQL's `sys.check_constraints`). Today the differ uses this for one purpose:

* It reads back enum CHECKs and compares them to the active schema's `f.enumOf(...)` tuples. If you added a value to the tuple, the differ marks the constraint as "spec drift" and `forge push` drops + recreates it.

Hand-written CHECKs aren't part of the schema, so the differ doesn't try to reconcile them. They show up in the introspection output but get ignored. That means:

* You can add custom CHECKs via the migration-file path without `forge push` ever wanting to drop them.
* If you drop a custom CHECK on the DB by hand, `forge push` won't recreate it — the schema doesn't know it was there.

The trade-off: the migration ledger is the source of truth for hand-written CHECKs, not the schema file. Keep the comment-on-the-model from step 4 above, and rely on the `migrations/` folder for the canonical wording.

---

## CHECK vs zod

| | zod | CHECK |
|---|---|---|
| Where it runs | Request handler | Every writer the DB has |
| What it sees | The whole request, FK lookups, async data | Only the row being written |
| When it fires | Before the write | At the write |
| What you give up if it's missing | Bad data through your API | Bad data through `psql`, replication, future tools |
| Cost of changing it | Edit a `.ts` file, redeploy | Migration |

The two compose. zod expresses richer rules (regex against a full RFC email, async lookups, request-context predicates); CHECK expresses the floor below which no row may sit. Most invariants worth enforcing belong in both:

```ts
// zod — at the boundary
const OrderCreate = z.object({
  total: z.number().int().nonnegative(),
  start_at: z.date(),
  end_at: z.date(),
}).refine(o => o.start_at < o.end_at, { path: ['end_at'] });

// CHECK — in the migration
//   ALTER TABLE orders ADD CONSTRAINT orders_total_nonneg_chk CHECK (total >= 0);
//   ALTER TABLE orders ADD CONSTRAINT orders_window_chk      CHECK (start_at < end_at);
```

The CHECK is the seatbelt. zod gives you a friendlier error (`"total must be non-negative"`); the CHECK guarantees that the rule survives the seed script that bypasses the API, the manual data import six months from now, and the new microservice your colleague writes against the same DB.

---

## CHECK vs trigger

Both are DB-enforced row predicates. The difference is declarative vs procedural.

| | CHECK | Trigger |
|---|---|---|
| Style | One expression | Procedure body, branching, multiple statements |
| Visibility | Inline in DDL; `information_schema.check_constraints` reads it | Hidden in `pg_trigger`; you have to know to look |
| Performance | Inlined by the planner | A function call per row |
| Side effects | None | Can write other tables, raise NOTICE, log |
| What forge supports | Custom CHECKs land via migration files | Triggers also via migration files; not part of the schema DSL |
| Right call when | The rule fits one boolean expression | The rule needs a CASE / lookup / mutation |

Trigger when:

* You need to read another row to validate (CHECK can't subquery).
* You need to *adjust* the row in flight (CHECK can only accept or reject — `BEFORE INSERT` triggers can modify `NEW`).
* You need to update a denormalised summary in another table when the row changes.
* The rule has a few branches that an `AND/OR` chain wouldn't read well.

CHECK when:

* The rule fits on one line and reads obvious six months from now.
* Performance matters — CHECK is roughly free on the write path; triggers add function-call overhead per row.
* You want the rule to be visible in catalog dumps and schema diffs.

The decision tree is: try CHECK first. Promote to trigger when CHECK can't express the rule.

---

## CHECK vs enum

`f.enumOf(values)` is the dedicated tool for "this column is one of N strings". It gives you:

* A typed TS literal union (`Row<typeof X>['status']` is `'a' | 'b' | 'c'`).
* A `CREATE TYPE` on Postgres / `ENUM(...)` on MySQL / `CHECK (col IN (...))` on SQLite/DuckDB/MSSQL — all auto-emitted.
* Drift-aware reconciliation: add a value, `forge push`, the constraint updates.

Reach for a hand-written `CHECK (col IN (...))` only when:

* The set is large enough that you'd rather store it as a lookup table than as a tuple (hundreds of values).
* The set changes through data — `CHECK (country_code IN (SELECT iso2 FROM countries))` doesn't work (subquery in CHECK is rejected), so the answer is FK to the countries table.
* The values aren't strings — `f.enumOf` is string-only.

For a small, stable, string-only set, `f.enumOf` is always the right call. The CHECK happens automatically.

---

## Worked examples

### (a) Order amount > 0 — non-negative invariant

A baseline sanity check that catches inverted-sign bugs, currency-conversion misorders, and refund-records-as-positive bugs.

```ts
// Schema
const Order = model('orders', {
  id:       f.id(),
  total:    f.int(),    // CHECK (total >= 0) — orders_total_nonneg_chk
  currency: f.enumOf(['USD', 'EUR', 'GBP', 'NGN'] as const),
});
```

```sql
-- migrations/20260624T000000_orders_total_nonneg.sql
-- up
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_total_nonneg_chk" CHECK ("total" >= 0) NOT VALID;
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_total_nonneg_chk";

-- down
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_total_nonneg_chk";
```

Pair it with zod at the API:

```ts
const OrderCreate = z.object({ total: z.number().int().nonnegative(), ... });
```

If a refund is "subtract from total elsewhere", model it as a separate `refunds` row with its own non-negative `amount` column — never let `orders.total` go negative, ever.

### (b) Status in allowed set — use enum, not CHECK

This is the case where you do *not* hand-write a CHECK. The right answer is:

```ts
const Order = model('orders', {
  id:     f.id(),
  status: f.enumOf(['pending', 'paid', 'shipped', 'delivered', 'cancelled'] as const),
});
```

Forge emits the constraint for you on the dialects that need it, the TS literal union flows everywhere, and adding a value is `[..., 'returned']` + `forge push`.

Reach for a hand-written `CHECK (status IN (...))` only if the values aren't strings, or if the set is large enough to warrant a lookup table + FK instead.

### (c) Date range valid — `start_at < end_at`

A two-field CHECK is the smallest case CHECK exists for. zod can't enforce it once the row hits the DB (a direct UPDATE bypasses zod), so this is exactly the kind of invariant CHECK was designed for.

```ts
const Booking = model('bookings', {
  id:       f.id(),
  start_at: f.dateTime(),
  end_at:   f.dateTime(),
  // CHECK (start_at < end_at) — bookings_window_chk
});
```

```sql
-- up
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_window_chk" CHECK ("start_at" < "end_at") NOT VALID;
ALTER TABLE "bookings" VALIDATE CONSTRAINT "bookings_window_chk";

-- down
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_window_chk";
```

If `end_at` is nullable (open-ended booking), widen the predicate:

```sql
CHECK ("end_at" IS NULL OR "start_at" < "end_at")
```

Same shape works on every SQL dialect verbatim.

### (d) Mongo `$jsonSchema` invariant

Mongo's equivalent is a collection validator. Shape rules go in `$jsonSchema`; row-level predicates go in `$expr`. They compose under `$and`:

```ts
await db.$runCommandRaw({
  collMod: 'bookings',
  validator: {
    $and: [
      {
        $jsonSchema: {
          bsonType: 'object',
          required: ['start_at', 'end_at'],
          properties: {
            start_at: { bsonType: 'date' },
            end_at:   { bsonType: 'date' },
            guests:   { bsonType: 'int', minimum: 1, maximum: 16 },
            status:   { enum: ['pending', 'confirmed', 'cancelled'] },
          },
        },
      },
      { $expr: { $lt: ['$start_at', '$end_at'] } },
    ],
  },
  validationLevel: 'strict',
  validationAction: 'error',
});
```

Roll it out with `validationLevel: 'moderate'` + `validationAction: 'warn'` first; promote to `'strict'` + `'error'` once the existing collection passes.

Wrap the call in a script you run alongside seeds — forge doesn't auto-apply Mongo validators because they're collection-level, not field-level, and forge's schema language is field-level.

---

## Common mistakes

**Forgetting `IS NOT NULL` on a nullable column.** Covered in [NULL semantics](#null-semantics--the-three-valued-logic-trap). The predicate passes when its inputs are NULL — always.

**Adding a CHECK on a populated table without two-phase apply.** A single `ALTER TABLE … ADD CONSTRAINT … CHECK (…)` on Postgres takes an `ACCESS EXCLUSIVE` lock for the full-table scan. Use `NOT VALID` first; promote to `VALIDATE CONSTRAINT` during a quiet window.

**Trying to subquery in CHECK.** Rejected at create time on every dialect. The cross-row patterns ([Cross-row CHECKs don't exist](#cross-row-checks-dont-exist)) are partial unique indexes, FKs, or triggers — never subqueries.

**Using volatile functions in CHECK.** Postgres errors at create. MySQL errors. SQLite *allows* it but the result is undefined across re-checks. Always pick deterministic / `IMMUTABLE` functions.

**Targeting MySQL 5.7.** 5.7 parses CHECK and silently ignores it. Pin to 8.0+ across dev / CI / prod, and treat `forge doctor`'s version warning as a release-blocker.

**Hand-writing `CHECK (col IN (...))` when `f.enumOf` is right there.** Forge handles the constraint, the drift, and the type all at once. Use `f.enumOf`.

**Forgetting to comment the CHECK on the model.** The CHECK lives in the migration file, not the schema. Without a one-line comment on the field, the next reader of the schema can't tell the invariant exists. Add the comment.

**Putting a CHECK where a trigger belongs.** Five-line `CASE WHEN … THEN … ELSE …` predicates are a smell — the rule has grown past CHECK's sweet spot. Either simplify (often by adding a generated column the CHECK can reference) or promote to a trigger.

**Relying on CHECK in place of zod.** CHECK's error messages are terse (`new row for relation "orders" violates check constraint "orders_total_nonneg_chk"`). The API still wants zod for friendly errors. CHECK is the floor; zod is the doorman.
