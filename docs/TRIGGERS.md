# Triggers

DB-side procedural code that fires on INSERT/UPDATE/DELETE — used for audit logs, denormalized caches, derived columns, and validation. This page covers the per-dialect trigger model (Postgres PL/pgSQL functions, MySQL row-level, SQLite limited, MSSQL INSERTED/DELETED, Mongo change-stream equivalent), when triggers help and when they hurt, and the patterns that compose with forge-orm.

Triggers are not a typed-surface feature in forge. The schema declares tables, fields, indexes, FKs, views, FTS shadows — not procedural code. Triggers live in migration files you write by hand (via `db.$executeRaw` or a hand-rolled SQL file invoked by `forge diff apply`) and are visible to forge's differ only as "extra DB objects" the introspect pass walks past. The pattern is: declare the data, write the procedural code, document the link.

The companion docs you'll cross to: [MIGRATIONS.md](./MIGRATIONS.md) for how trigger DDL ships, [RAW-SQL.md](./RAW-SQL.md) for the `$executeRaw` shape that creates them, and [EVENTS.md](./EVENTS.md) for the app-layer alternative that often subsumes the trigger use case entirely.

## Contents

* [What triggers are](#what-triggers-are)
* [When to use a trigger](#when-to-use-a-trigger)
* [When NOT to use a trigger](#when-not-to-use-a-trigger)
* [Triggers vs forge events](#triggers-vs-forge-events)
* [Per-dialect support matrix](#per-dialect-support-matrix)
* [Postgres triggers](#postgres-triggers)
* [MySQL triggers](#mysql-triggers)
* [SQLite triggers](#sqlite-triggers)
* [DuckDB triggers](#duckdb-triggers)
* [MSSQL triggers](#mssql-triggers)
* [Mongo — change streams as the trigger equivalent](#mongo--change-streams-as-the-trigger-equivalent)
* [Declaring a trigger in a forge project](#declaring-a-trigger-in-a-forge-project)
* [Drift detection on trigger objects](#drift-detection-on-trigger-objects)
* [Maintenance — keeping triggers visible to humans](#maintenance--keeping-triggers-visible-to-humans)
* [Trigger ordering — multiple triggers on the same event](#trigger-ordering--multiple-triggers-on-the-same-event)
* [Recursive triggers](#recursive-triggers)
* [Performance cost — per-row vs per-statement](#performance-cost--per-row-vs-per-statement)
* [Testing triggers](#testing-triggers)
* [Common patterns](#common-patterns)
* [Worked examples](#worked-examples)
* [Cross-links](#cross-links)

---

## What triggers are

A trigger is a named DB object that runs procedural code when a specified DML event fires on a specified table. The event is one of `INSERT`, `UPDATE`, `DELETE` (and `TRUNCATE` on Postgres). The timing is `BEFORE`, `AFTER`, or — on Postgres / SQLite / MSSQL — `INSTEAD OF` (which only makes sense on a view). The granularity is `FOR EACH ROW` (the trigger body runs once per affected row) or `FOR EACH STATEMENT` (once per statement, regardless of how many rows it touched).

The trigger body can:

* Read the row that's being inserted / updated / deleted (`NEW.col`, `OLD.col` on Postgres / MySQL / SQLite; `INSERTED` / `DELETED` pseudo-tables on MSSQL).
* Read other tables (Postgres / MSSQL / MySQL — anything the trigger's role can read).
* Write other tables (audit logs, materialised caches, fan-out tables).
* Mutate `NEW` before it lands (`BEFORE` triggers on Postgres / MySQL — set `NEW.updated_at = NOW()`).
* Abort the operation (`RAISE EXCEPTION` on PG, `SIGNAL SQLSTATE` on MySQL, `RAISERROR` on MSSQL, `RAISE ABORT` on SQLite).
* Fire other triggers (recursive trigger handling — see below).

What the body cannot do, on any dialect, is commit / rollback the surrounding transaction. The trigger is part of whatever transaction wrapped the DML; its writes commit together with the trigger-causing statement, or they roll back together.

---

## When to use a trigger

The list is short on purpose. Reach for a trigger when the alternative is genuinely worse — usually because the alternative would mean trusting every code path to do something the DB can enforce in one place.

1. **Audit logging when "every write" is the requirement.** Compliance regimes (HIPAA, SOX, PCI-DSS, GDPR Article 30) want an immutable record of who did what, when, to which row. An app-layer hook that runs on `db.user.update()` is easy to forget when the next person adds a Mongo aggregation that does an update through `$runCommandRaw`. A trigger on `users` fires regardless of which code path issued the write.
2. **Denormalized cache invalidation where the cache is in the same DB.** A `counters` table that holds `posts_count` per user; a trigger on `posts` after-insert / after-delete increments / decrements the counter atomically with the originating write. The two changes commit together; there's no window where the counter is stale.
3. **Derived columns too complex for `GENERATED ALWAYS AS`.** A column computed from another table (so a generated column can't reach it), or from a function the DB allows in trigger context but not in a column expression. The trigger sets the derived value on `BEFORE INSERT` / `BEFORE UPDATE`.
4. **Fan-out events to a queue table.** A trigger that writes to `_outbox` for every change to `orders`, which a separate worker reads and ships to Kafka / SQS. This is the transactional outbox pattern — the order write and the outbox write are atomic, the worker provides at-least-once delivery, and the app doesn't have to remember to publish.
5. **Constraint logic too complex for `CHECK`.** A constraint that depends on another row in the same table, or on a row in another table. A trigger that fires `RAISE EXCEPTION` if the invariant breaks is the only way to enforce it at the DB level on most dialects (Postgres also has `EXCLUDE` constraints for some of these cases).
6. **Cascading soft-deletes.** When a row is soft-deleted (`deleted_at = NOW()`), all rows in dependent tables also need `deleted_at` set. A trigger on the parent's `UPDATE` checks for the transition and writes the children. Hand-rolling this in app code means every call site has to remember; a trigger means the cascade lives next to the data.

The thread tying these together: the operation must happen for every write, regardless of which app code path issued it. If the requirement is "do X whenever the row changes, no exceptions," that's a trigger's natural job.

---

## When NOT to use a trigger

Triggers are invisible to the app code that fires them. That invisibility is their power and their hazard. The rules below are what we've found keeps a forge project's triggers small and trustworthy.

1. **Don't replace business logic.** If the rule is "an order in state `paid` can transition to `refunded` only if the user has confirmed and the refund window hasn't expired," that's not a trigger. It's a service-layer concern. A trigger that tries to encode this becomes the most-edited part of the schema, the slowest path to deploy, and the hardest to test. App code that names the rule (`refundOrder(orderId, reason)`) is where it goes.
2. **Don't put performance-critical paths in triggers when an app-layer alternative exists.** A trigger that fires `FOR EACH ROW` on a bulk update of a million rows runs a million times. The plan looks the same to the app (one `UPDATE`), but the DB does N function calls. App-layer batching, where you process the million rows in chunks of 1000 with explicit code, is observable, profilable, and tunable. A trigger is none of those.
3. **Don't use a trigger where a forge event suffices.** forge ships a query-event hook ([EVENTS.md](./EVENTS.md)) that fires on every typed write through the ORM. If the only path into a table is through `db.user.create()`, the event sees every write. The event runs in app code, in the app's process, with the app's debugger, profiler, and error reporter. Reach for the trigger only when there's a write path the event can't see — raw SQL, another service writing the same DB, a one-off `psql` script the DBA runs at 3 AM.
4. **Don't trigger off a trigger.** Cascading triggers — A fires B fires C — turn into the kind of mess where a single insert generates an unbounded write pattern that nobody can reason about. Some dialects let you turn recursive triggers off; some don't. The pattern that scales is one trigger per concern, no chains.
5. **Don't use a `BEFORE` trigger to fix bad input.** If the app is writing the wrong value (lowercase email, missing timezone, etc.), fix it where the value is constructed. A `BEFORE INSERT` that silently normalises input hides bugs — the trigger covers the symptom, the bad code stays. The exception is generated infrastructure (audit IDs, monotonic counters) where the right value is by definition the DB's job.
6. **Don't use a trigger to enforce a constraint a unique/check/FK can enforce.** A unique index is faster than a `BEFORE INSERT` trigger that checks for an existing row; a `CHECK` constraint is faster than a trigger that calls `RAISE` on bad data. The DB's declarative constraints have planner support; triggers do not.

The conservative rule: if you can't articulate why the app-layer alternative is worse, the trigger is the wrong tool.

---

## Triggers vs forge events

`forge` exposes a query-event API (`db.$on('query', fn)`) that fires synchronously when a typed call passes through. The signature is in [EVENTS.md](./EVENTS.md). The cases where the two overlap:

| Concern | Trigger | forge event |
|---|---|---|
| Audit-log every typed write | Possible | Yes — direct |
| Audit-log every write including raw SQL | Yes | No — `$queryRaw` bypasses typed-write events |
| Audit-log writes from another service hitting the same DB | Yes | No — events are per-process |
| Update a denormalised counter atomically | Yes — same transaction | Yes — but only if the event-handler write is in the same `$transaction` callback |
| Maintain `updated_at` on every UPDATE | Yes — `BEFORE UPDATE` trigger | Yes — query-event sets the field before send |
| Validate cross-row invariant | Yes — `RAISE EXCEPTION` in `BEFORE` | Maybe — app event throws before commit |
| Fan out to message queue | Yes — outbox trigger + worker | Yes — event-handler publishes, but loses atomicity vs DB write |

The dividing line is the answer to "is there a write path that bypasses the typed surface?" If yes (raw SQL inside the app, scripts run by ops, a separate service on the same DB), use a trigger — its scope is the table, not the process. If no, use the event — it's visible, testable, debuggable, and lives in the same language as the rest of the code.

For most forge projects with a single backend talking to its own database, events cover 90% of the use cases triggers used to. The remaining 10% — multi-service DBs, compliance audit, atomic counter denormalisation — is what triggers are for.

---

## Per-dialect support matrix

| Dialect | Triggers | Granularity | Timing | Per-row syntax for old/new | Notes |
|---|---|---|---|---|---|
| Postgres | Yes (function + trigger) | ROW + STATEMENT | BEFORE, AFTER, INSTEAD OF (view) | `NEW.col`, `OLD.col` inside PL/pgSQL | Deferrable (FOR EACH ROW only); `WHEN (...)` predicate to filter |
| MySQL | Yes | ROW only | BEFORE, AFTER | `NEW.col`, `OLD.col` | No `INSTEAD OF`; no statement-level; one trigger per event/timing/table (5.7) / multiple (8.0+) |
| SQLite | Yes | ROW only | BEFORE, AFTER, INSTEAD OF (view) | `NEW.col`, `OLD.col` | No procedural language — body is a sequence of SQL statements |
| DuckDB | **No** | — | — | — | Triggers not in the language (as of 2026-06). Use app-layer or a scheduled `INSERT INTO audit SELECT … FROM source` |
| MSSQL | Yes | STATEMENT (acts on `INSERTED` / `DELETED` pseudo-tables) | AFTER, INSTEAD OF | `INSERTED.col`, `DELETED.col` | No per-row triggers — body sees set-based pseudo-tables of affected rows |
| Mongo | **No** native | — | — | — | Use change streams as the equivalent (see below) |

The big shape difference to keep in mind: Postgres / MySQL / SQLite triggers fire per-row, MSSQL triggers fire per-statement and the body queries `INSERTED` / `DELETED` to see what changed. Writing an audit-log trigger that "works on every dialect" requires two different bodies — see the [worked examples](#worked-examples) below.

---

## Postgres triggers

Postgres separates the trigger (when to fire) from the function (what to do). You write a `CREATE FUNCTION` that returns `TRIGGER`, then a `CREATE TRIGGER` that calls it.

### Anatomy

```sql
-- The function does the work. Returns NEW (BEFORE) or anything (AFTER).
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END
$$;

-- The trigger wires the function to the event.
CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION fn_set_updated_at();
```

The split is deliberate: one function can back triggers on many tables, and `DROP TRIGGER` leaves the function in place for the next trigger that needs it. The function runs in the role that defined it (`SECURITY DEFINER`) or the role that fired the trigger (`SECURITY INVOKER`, default). For audit triggers that write to a table the app role can't directly touch, `SECURITY DEFINER` is the standard shape.

### Timing — BEFORE, AFTER, INSTEAD OF

* **BEFORE** — runs before the DML applies. The function can modify `NEW` (the row about to be written) and return it, or return `NULL` to skip the write entirely. Use for: setting derived columns, defaulting `updated_at`, validating and aborting.
* **AFTER** — runs after the DML applies. `NEW` is read-only; modifications don't take effect. Use for: writing audit rows, updating other tables, fanning out to outbox.
* **INSTEAD OF** — only valid on views. Replaces the DML with the function's body. Use for: making an updatable view writable. Rare in forge projects; the typed surface deals with tables, not views.

### Granularity — FOR EACH ROW vs FOR EACH STATEMENT

* `FOR EACH ROW` — fires once per row touched. Inside the body, `NEW` and `OLD` are the row being processed.
* `FOR EACH STATEMENT` — fires once per `INSERT` / `UPDATE` / `DELETE` statement, regardless of row count. Inside the body, `NEW` and `OLD` are not available; access the changed rows via transition tables (`REFERENCING NEW TABLE AS new_rows`).

Statement-level is the right shape when the work is fixed-cost per statement (refresh a materialised view, write a single notification). Row-level is what you want for per-row audit / denormalisation. The audit log shape below uses row-level.

### Deferrable triggers

```sql
CREATE CONSTRAINT TRIGGER trg_check_invariant
AFTER INSERT OR UPDATE ON orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION fn_check_order_invariant();
```

A `CONSTRAINT TRIGGER` can be deferred to commit time, like a deferrable FK. Useful when the invariant temporarily breaks mid-transaction — e.g. an order's `total` doesn't match its `line_items.sum()` until both writes have landed. The trigger fires once at COMMIT, by which time everything's consistent. Row-level only.

### `WHEN (...)` predicate

```sql
CREATE TRIGGER trg_users_soft_deleted
AFTER UPDATE ON users
FOR EACH ROW
WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
EXECUTE FUNCTION fn_cascade_soft_delete();
```

The `WHEN` predicate filters whether the trigger fires. Cheaper than running the function and exiting early — the predicate runs in the executor, the function call is skipped entirely if it returns false.

### Performance notes

* Each row-level trigger is a function call. On `INSERT … SELECT` of N rows, the function fires N times, with the planner's row estimate driving any cost estimate.
* Trigger-internal queries see the post-write state (AFTER) or pre-write state (BEFORE). For BEFORE-UPDATE that wants to read other rows, take care — it sees uncommitted writes from earlier statements in the same transaction.
* `SECURITY DEFINER` triggers run as the function owner; the role that fired the trigger sees the effect, but the function's own writes are attributed to the owner. Audit-log triggers that need to record `current_user` should capture it from `session_user` (the role that authenticated) before any `SECURITY DEFINER` switch.

---

## MySQL triggers

MySQL triggers are row-level only, no statement-level option. Syntax:

```sql
CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
SET NEW.updated_at = NOW();
```

The body is a single statement, or a `BEGIN ... END` block. Inside the block you can use control flow (`IF`, `WHILE`), declare local variables, and call other procedures.

### MySQL 5.7 vs 8.0+

* **5.7** — only one trigger per (event, timing, table). If you want both an audit-log trigger and an `updated_at` trigger on `users` BEFORE UPDATE, they have to share a single trigger body.
* **8.0+** — multiple triggers per (event, timing, table) allowed, ordered via `PRECEDES` / `FOLLOWS`:

```sql
CREATE TRIGGER trg_users_audit
AFTER UPDATE ON users
FOR EACH ROW
PRECEDES trg_users_outbox
BEGIN
  INSERT INTO audit_log (table_name, row_id, action, at, who, diff)
  VALUES ('users', OLD.id, 'update', NOW(), CURRENT_USER(), JSON_OBJECT('old', JSON_OBJECT(...), 'new', JSON_OBJECT(...)));
END;
```

If you're on 5.7 in production, the rule is "one trigger per (event, timing, table), pack the concerns into the single body."

### Aborting from a trigger

```sql
CREATE TRIGGER trg_orders_validate
BEFORE INSERT ON orders
FOR EACH ROW
BEGIN
  IF NEW.total < 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'order total cannot be negative';
  END IF;
END;
```

`SIGNAL SQLSTATE '45000'` is the MySQL way to throw from a trigger — the surrounding `INSERT` errors out, the transaction rolls back the statement. State `45000` is the generic user-defined exception class.

### `OLD` / `NEW` rules

* `BEFORE INSERT` — `NEW` is writable, `OLD` is undefined.
* `AFTER INSERT` — `NEW` is read-only, `OLD` is undefined.
* `BEFORE UPDATE` — both writable / readable.
* `AFTER UPDATE` — both read-only.
* `BEFORE DELETE` — `OLD` is readable, `NEW` is undefined.
* `AFTER DELETE` — same.

MySQL's bug history is studded with edge cases around assigning to `NEW.col` of certain types inside a `BEFORE` trigger — particularly `JSON` and spatial types on older 8.x point releases. Test with the version you're shipping against, not the latest dev build.

---

## SQLite triggers

SQLite triggers are minimal and predictable. No procedural language — the body is a sequence of SQL statements (`INSERT`, `UPDATE`, `DELETE`, `SELECT`), nothing else.

```sql
CREATE TRIGGER trg_posts_count_inc
AFTER INSERT ON posts
FOR EACH ROW
BEGIN
  UPDATE counters SET posts_count = posts_count + 1 WHERE user_id = NEW.author_id;
END;
```

The whole language is "what SQL do you want to run when this fires." There's no `IF`, no `WHILE`, no local variables. You can use `CASE WHEN` inside an `UPDATE` to get conditional behaviour:

```sql
CREATE TRIGGER trg_users_updated_at
AFTER UPDATE ON users
FOR EACH ROW
BEGIN
  UPDATE users
  SET updated_at = CASE
    WHEN NEW.updated_at = OLD.updated_at THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ELSE NEW.updated_at
  END
  WHERE id = NEW.id;
END;
```

The catch: an `AFTER UPDATE` trigger that itself updates the same table re-fires the trigger by default. SQLite has `PRAGMA recursive_triggers = ON | OFF` (default ON since 3.7). Turn it off if you're using the pattern above to avoid an infinite loop, or rewrite as `BEFORE UPDATE` and set `NEW.updated_at` via a `SELECT` workaround.

### `BEFORE` triggers and `NEW` assignment

SQLite `BEFORE` triggers cannot assign to `NEW.col` directly — that's a Postgres / MySQL feature SQLite doesn't share. The workaround for `updated_at` is `AFTER UPDATE` + the self-update above, or to set it from app code (the forge query-event handler is the obvious place).

### Aborting from a trigger

```sql
CREATE TRIGGER trg_orders_validate
BEFORE INSERT ON orders
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.total < 0 THEN RAISE(ABORT, 'order total cannot be negative')
  END;
END;
```

`RAISE(ABORT, 'msg')` rolls back the statement; `RAISE(FAIL, 'msg')` rolls back the statement and any open transaction; `RAISE(IGNORE)` skips the row but continues the statement. The `SELECT CASE` wrapper is the SQLite-idiomatic shape because there's no top-level `IF`.

### Triggers on FTS5 shadow tables

forge's `f.text().searchable()` field emits a virtual FTS5 table and three triggers (after-insert / after-update / after-delete) that maintain the index. Those are forge-managed — don't edit them, and don't add your own triggers to the `<table>_fts` shadow. The introspect pass treats `_fts` shadows as engine-managed and won't include them in drift reports; the same goes for the triggers backing them.

---

## DuckDB triggers

DuckDB does not support triggers (as of 2026-06). The use cases triggers cover on other dialects need different shapes on DuckDB:

* **Audit log** — write to the audit table from app code (forge event handler) or as part of an explicit transaction in a service-layer function.
* **Denormalised cache** — recompute as a view or a scheduled `INSERT … SELECT` job. DuckDB's analytical strength is recomputing aggregates from scratch fast enough that incremental maintenance is rarely worth the complexity.
* **Derived columns** — DuckDB supports `GENERATED ALWAYS AS` for simple cases; for cross-table derivations, use a view.
* **Outbox / fan-out** — app code only.

If you find yourself wanting a trigger on DuckDB, the question to ask is whether DuckDB is the right store for that table. DuckDB's design is "compute heavy on read, simple on write" — operational tables that need triggers usually belong on Postgres / MySQL, with DuckDB attached for analytics.

---

## MSSQL triggers

MSSQL triggers are **statement-level**, not row-level. The trigger body sees two pseudo-tables — `INSERTED` (rows after the statement) and `DELETED` (rows before the statement) — and operates on them set-wise.

```sql
CREATE TRIGGER trg_users_audit
ON users
AFTER INSERT, UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;

  INSERT INTO audit_log (table_name, row_id, action, at, who, payload)
  SELECT 'users', i.id, 'insert', SYSUTCDATETIME(), SUSER_SNAME(),
         (SELECT i.* FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)
  FROM INSERTED i
  WHERE NOT EXISTS (SELECT 1 FROM DELETED d WHERE d.id = i.id);

  INSERT INTO audit_log (table_name, row_id, action, at, who, payload)
  SELECT 'users', i.id, 'update', SYSUTCDATETIME(), SUSER_SNAME(),
         (SELECT i.* FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)
  FROM INSERTED i
  JOIN DELETED d ON d.id = i.id;

  INSERT INTO audit_log (table_name, row_id, action, at, who, payload)
  SELECT 'users', d.id, 'delete', SYSUTCDATETIME(), SUSER_SNAME(),
         (SELECT d.* FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)
  FROM DELETED d
  WHERE NOT EXISTS (SELECT 1 FROM INSERTED i WHERE i.id = d.id);
END;
```

Three things to take from this:

1. **One trigger handles all three events** — the body distinguishes insert / update / delete by checking which pseudo-tables have matching rows.
2. **Set-based, not per-row** — even if the firing statement updates a million rows, the trigger body runs once. The `INSERT INTO audit_log SELECT … FROM INSERTED` runs N rows through a single planned query, which is dramatically faster than N row-level trigger calls on PG / MySQL.
3. **`SET NOCOUNT ON`** — required at the top of every trigger body. Without it, the trigger's internal row counts leak back to the client and can confuse drivers expecting `affectedRows` to match the originating statement.

### `INSTEAD OF` triggers

MSSQL supports `INSTEAD OF` on tables, not just views — uncommon among dialects. Useful for "make this read-only table appear writable for legacy code paths":

```sql
CREATE TRIGGER trg_users_no_delete
ON users
INSTEAD OF DELETE
AS
BEGIN
  SET NOCOUNT ON;
  UPDATE users SET deleted_at = SYSUTCDATETIME() WHERE id IN (SELECT id FROM DELETED);
END;
```

Any `DELETE FROM users` becomes a soft-delete, regardless of which client issued it.

### Aborting from a trigger

```sql
IF EXISTS (SELECT 1 FROM INSERTED WHERE total < 0)
BEGIN
  RAISERROR('order total cannot be negative', 16, 1);
  ROLLBACK TRANSACTION;
END
```

`RAISERROR` raises the error; `ROLLBACK TRANSACTION` rolls back the outer transaction (mid-statement). Severity 16 is the convention for user-defined exceptions.

### Recursive trigger control

```sql
ALTER DATABASE current SET RECURSIVE_TRIGGERS OFF;
```

Database-wide setting; turn off if any of your triggers update the same table they fire on and you don't want the cycle.

---

## Mongo — change streams as the trigger equivalent

Mongo doesn't have triggers in the SQL sense. The equivalent is **change streams** — a server-side feed of every `insert` / `update` / `replace` / `delete` / `drop` event on a collection, database, or whole deployment. Code subscribes to the stream and reacts.

The integration shape with forge:

```ts
const session = (db.adapter as any).client.startSession();
const stream = db.adapter.db
  .collection('users')
  .watch([], { fullDocument: 'updateLookup' });

stream.on('change', async (event) => {
  if (event.operationType === 'insert' || event.operationType === 'update') {
    await db.auditLog.create({
      data: {
        table_name: 'users',
        row_id: String(event.documentKey._id),
        action:   event.operationType,
        at:       new Date(),
        who:      event.fullDocument?.last_modified_by ?? 'unknown',
        payload:  event.fullDocument,
      },
    });
  }
  if (event.operationType === 'delete') {
    await db.auditLog.create({
      data: {
        table_name: 'users',
        row_id: String(event.documentKey._id),
        action:   'delete',
        at:       new Date(),
      },
    });
  }
});
```

How this differs from a SQL trigger:

* **Not atomic with the write.** The original `users.update()` commits, then the change-stream consumer sees the event, then it writes the audit row. The consumer can crash between the two. The fix is the [resume-token pattern](#audit-log-trigger) — the consumer stores the last-processed resume token, and on restart resumes from there. The downside is at-least-once delivery (the audit row may be written twice on a crash); idempotency on the audit table covers it.
* **Out of process.** The change-stream listener is a worker, not a server-side hook. It can be killed, restarted, scaled horizontally (one consumer per collection, or partitioned by shard key). The DB doesn't care if you have a listener or not.
* **Requires a replica set.** Standalone `mongod` doesn't support change streams. Atlas and any real production cluster do.
* **No `BEFORE` analogue.** Change streams fire after the write. To enforce a constraint before the write commits, you need app-layer validation — or Mongo's `validator` schema clause, which fires per-document and is the closest Mongo gets to a `BEFORE` trigger.

For "I want every write to a Mongo collection to be audited," the change-stream pattern is the production-grade equivalent of a SQL audit trigger. The fact that it's not atomic with the write is usually fine — at-least-once delivery + idempotent audit rows is the pattern Atlas, Stripe, and Shopify run on internally.

---

## Declaring a trigger in a forge project

forge doesn't have a typed `trigger(...)` declaration on a model. The trigger lives outside the schema, in one of three places.

### Option A — raw migration file (recommended)

Create `migrations/<timestamp>_trg_users_audit.sql` by hand. forge's `_forge_migrations` ledger records the file once applied; `forge rollback` runs the down block:

```sql
-- forge migration: 20260624T143052_trg_users_audit
-- generated: 2026-06-24T14:30:52.413Z

-- up
CREATE OR REPLACE FUNCTION fn_users_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO audit_log (table_name, row_id, action, at, who, diff)
  VALUES (TG_TABLE_NAME, COALESCE(NEW.id, OLD.id), TG_OP, NOW(), current_user,
          jsonb_build_object('old', to_jsonb(OLD), 'new', to_jsonb(NEW)));
  RETURN NULL;
END
$$;

CREATE TRIGGER trg_users_audit
AFTER INSERT OR UPDATE OR DELETE ON users
FOR EACH ROW
EXECUTE FUNCTION fn_users_audit();

-- down
DROP TRIGGER IF EXISTS trg_users_audit ON users;
DROP FUNCTION IF EXISTS fn_users_audit();
```

Apply with `forge diff apply` (which runs any pending migration files in the directory), or run `db.$executeRaw` against the up block from a one-off script and `INSERT INTO _forge_migrations (name, applied_at) VALUES (...)` to record it.

### Option B — runtime apply via `db.$executeRaw`

For triggers that need to exist on a fresh DB before the app serves traffic, run the DDL in app startup:

```ts
async function ensureTriggers(db: Db) {
  const [{ exists }] = await db.$queryRaw<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'trg_users_audit'
    ) AS exists
  `;
  if (exists) return;

  await db.$executeRaw(raw`
    CREATE OR REPLACE FUNCTION fn_users_audit() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN ... END $$
  `);
  await db.$executeRaw(raw`
    CREATE TRIGGER trg_users_audit
    AFTER INSERT OR UPDATE OR DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION fn_users_audit()
  `);
}
```

Pair with `forge push` in start-up so the table exists before the trigger is wired. The existence check makes it idempotent.

### Option C — `forge diff apply --dry` and commit the SQL

If your team uses migration files for everything (Option A's reconciliation flavour), run `forge diff apply --dry`, paste the generated SQL into a hand-edited file alongside the trigger DDL, and commit the combined file. The forge-generated DDL handles the schema; the hand-added section handles the trigger. Both apply atomically when you run `forge diff apply` again.

The pattern across all three: the trigger is named, the SQL is in source control, and a code review can find it. No drift-applies-the-trigger magic, because that's exactly the kind of magic that bites you at 3 AM.

---

## Drift detection on trigger objects

forge's introspect pass walks `pg_trigger`, `information_schema.triggers`, `sqlite_master`, `sys.triggers` per dialect — but the differ does not currently surface triggers as drift items. The introspect cache holds the names; the diff phase filters them out alongside other engine-managed objects (FTS shadows, `_forge_migrations`).

What this means in practice:

* **Adding a trigger via `$executeRaw`** — drift report stays clean. forge doesn't know the trigger should exist.
* **Dropping a trigger by hand** — drift report stays clean. forge doesn't know the trigger is missing.
* **Schema mentions a model that needs a trigger** — there's nowhere in the schema declaration to express it.

The implication: triggers are an out-of-band invariant. The way you guarantee they exist in every environment is the same way you guarantee any out-of-band migration is applied — the migration file is in the repo, the deploy pipeline runs `forge diff apply` (which executes migration files), and CI fails the deploy if it didn't run.

For a stronger guarantee, add a healthcheck endpoint that introspects the trigger and 503s if it's missing:

```ts
import { raw } from 'forge-orm';

export async function checkAuditTrigger(db: Db): Promise<boolean> {
  const [{ exists }] = await db.$queryRaw<{ exists: boolean }>(raw`
    SELECT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'trg_users_audit'
    ) AS exists
  `);
  return exists;
}
```

Wire that into `/healthz`; a missing trigger fails the deploy's readiness check. The pattern works on every dialect (the catalog query changes per dialect).

---

## Maintenance — keeping triggers visible to humans

The hazard with triggers is they're invisible to the code that fires them. A junior dev runs `db.user.update({ where: { id }, data: { ... } })` and sees N audit rows materialise; the cause isn't in any TypeScript file they can grep for.

Three practices that keep the surprise small:

### 1. README the triggers

A `docs/triggers.md` (or a section in your project's main README) that lists every trigger, what it does, and which migration file created it. Keep the descriptions short — a single bullet per trigger is the right scale:

```markdown
## DB triggers

- `trg_users_audit` (users, AFTER INSERT/UPDATE/DELETE) — writes to `audit_log` for every change. See `migrations/20260624T143052_trg_users_audit.sql`.
- `trg_users_updated_at` (users, BEFORE UPDATE) — sets `updated_at = NOW()`. App-layer event also sets it; trigger is the safety net for raw-SQL writes.
- `trg_orders_outbox` (orders, AFTER INSERT/UPDATE) — writes to `_outbox`. Consumed by the `order-events` worker.
```

The list lives in source control next to the schema. New tab opens; a `grep trg_` finds them all.

### 2. Name triggers with a prefix

`trg_<table>_<purpose>` is the convention this doc uses. Anything that starts with `trg_` is a trigger; anything that starts with `fn_` is a trigger function. `psql \d users` shows the trigger list at the bottom of the table description; a consistent prefix makes that list readable.

### 3. Comment the trigger function

PG / MySQL / MSSQL all support `COMMENT ON FUNCTION` / `COMMENT ON TRIGGER`. Use it. The comment shows up in `psql \df+` and in any GUI tool's object browser:

```sql
COMMENT ON TRIGGER trg_users_audit ON users IS
  'Writes to audit_log for HIPAA compliance. See docs/triggers.md and migrations/20260624T143052_trg_users_audit.sql.';
```

A future-you who's just been paged at 3 AM about the audit_log table being full sees that comment and knows where to look.

---

## Trigger ordering — multiple triggers on the same event

When two triggers both fire on `AFTER UPDATE ON users`, the order they run in is dialect-specific.

| Dialect | Default order | How to override |
|---|---|---|
| Postgres | Alphabetical by trigger name | Rename to control order, or pack concerns into one trigger |
| MySQL 5.7 | One trigger only — pack everything | — (5.7 doesn't allow multiple) |
| MySQL 8.0+ | Order of creation | `CREATE TRIGGER … FOR EACH ROW FOLLOWS other_trigger` / `PRECEDES other_trigger` |
| SQLite | Order of creation | Drop and recreate to reorder |
| MSSQL | Defined by `sp_settriggerorder` | `EXEC sp_settriggerorder @triggername=N'trg_x', @order=N'First', @stmttype=N'INSERT';` |

The practical advice: don't rely on ordering. If two triggers must run in a known sequence, pack them into one trigger and write the body in the order you want. The PG alphabetical-by-name fallback is robust but it makes renames load-bearing; the MySQL 8 `PRECEDES` / `FOLLOWS` works but documents the relationship in the wrong place (in the trigger DDL, not in the README that says "these things must happen in this order"). One trigger, one body, one order is the rule.

---

## Recursive triggers

A trigger that fires off another trigger (directly or transitively) creates a recursive chain. Each dialect has different defaults:

| Dialect | Recursive triggers by default? | How to control |
|---|---|---|
| Postgres | Yes — no depth limit beyond `max_stack_depth` (server config) | `pg_trigger_depth()` to read current depth; check inside trigger and exit if too deep |
| MySQL | Yes, but `max_sp_recursion_depth` (default 0) limits stored-procedure recursion; trigger recursion is bounded by stack | Don't rely on the limit; check inside the trigger |
| SQLite | Yes (since 3.7); `PRAGMA recursive_triggers = OFF` to disable | PRAGMA per connection |
| MSSQL | Direct recursion controlled by `RECURSIVE_TRIGGERS` database option (default OFF); indirect always on | `ALTER DATABASE … SET RECURSIVE_TRIGGERS OFF` |

The general rule: design out recursive triggers entirely. If trigger A's body updates table B, and table B has a trigger that updates table A, you've designed an infinite loop. Catching it with a depth guard is duct tape; the better fix is to merge the two triggers into one that writes both tables, or to move one concern to app code.

The case where recursive triggers are sometimes intentional: a trigger that fires on a table and updates the same table (e.g. cascading hierarchy maintenance). For Postgres, the pattern is to check `pg_trigger_depth()` and exit:

```sql
CREATE OR REPLACE FUNCTION fn_hierarchy_maintain()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  -- Recursive work here.
  RETURN NEW;
END $$;
```

For SQLite, the equivalent is `PRAGMA recursive_triggers = OFF` on the connection and explicit `INSERT INTO ... WHERE NOT EXISTS` patterns to avoid the cycle.

---

## Performance cost — per-row vs per-statement

A trigger's cost is dominated by two factors: how often it fires, and what the body does each time.

### Per-row trigger on bulk DML

```sql
UPDATE users SET active = false WHERE last_seen < '2026-01-01';
-- Touches 1.2M rows. Trigger fires 1.2M times.
```

On Postgres / MySQL / SQLite, that's 1.2M function calls. Each call:

* Allocates and binds `NEW` / `OLD`.
* Runs the trigger body's SQL (planned once on PG ≥ 12; re-planned per call on older PG and on MySQL by default).
* Materialises any work the body does (insert into `audit_log`, write to `_outbox`, etc.).

The audit table grows by 1.2M rows in the same transaction. Cost: tens of seconds on Postgres for a body that just inserts; minutes if the body queries other tables.

### Per-statement trigger on the same bulk DML

On MSSQL, the trigger fires once. The body sees `INSERTED` / `DELETED` as set-shaped pseudo-tables of 1.2M rows. The audit insert is a single `INSERT INTO audit_log SELECT … FROM INSERTED` — one planned query, set-based, dramatically faster.

### Implications for forge

* For `f.text().searchable()` FTS triggers, forge already accepts the per-row cost — that's the only way FTS5 stays consistent with the parent table.
* For audit-log triggers on tables that get bulk-updated regularly, consider the MSSQL set-based shape even on PG. PG's transition tables (`REFERENCING NEW TABLE AS new_rows`) let you write a statement-level trigger that does the same set-based insert:

```sql
CREATE TRIGGER trg_users_audit_stmt
AFTER UPDATE ON users
REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION fn_users_audit_stmt();

CREATE FUNCTION fn_users_audit_stmt() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_log (table_name, row_id, action, at, who, diff)
  SELECT 'users', n.id, 'update', NOW(), current_user,
         jsonb_build_object('old', to_jsonb(o), 'new', to_jsonb(n))
  FROM new_rows n
  JOIN old_rows o USING (id);
  RETURN NULL;
END $$;
```

That's a single statement-level trigger with one set-based insert. 1.2M source rows become 1.2M audit rows in one query, not 1.2M trigger calls.

The trade-off: statement-level triggers can't abort individual rows (the unit of failure is the statement). For audit-log, that's fine — the audit is a recording, not a guard.

* For triggers whose body is dominated by per-row work that can't be batched (validating a per-row invariant, computing a per-row derived value), per-row is the only option. Accept the cost and either cap bulk operations from the app layer, or run them in chunks that don't lock the table.

---

## Testing triggers

Triggers do not show up in unit tests that mock the DB. To verify the trigger fires, the test has to hit a real database — that means integration tests, not unit tests.

The basic shape:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDb, raw } from 'forge-orm';
import { schema } from '../src/schema';

let db: Awaited<ReturnType<typeof createDb>>;

beforeAll(async () => {
  db = await createDb({ url: process.env.TEST_DATABASE_URL!, schema });
  // forge push creates tables.
  // The trigger migration must be applied separately:
  await db.$executeRaw(raw`<the trigger DDL>`);
});

afterAll(async () => {
  await db.$disconnect();
});

describe('trg_users_audit', () => {
  it('writes an audit row for every insert', async () => {
    await db.user.create({ data: { email: 'a@x.co', name: 'A' } });
    const audits = await db.auditLog.findMany({ where: { table_name: 'users' } });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('insert');
  });

  it('writes an audit row for every update', async () => {
    const u = await db.user.create({ data: { email: 'b@x.co', name: 'B' } });
    await db.user.update({ where: { id: u.id }, data: { name: 'B2' } });
    const audits = await db.auditLog.findMany({
      where: { table_name: 'users', row_id: u.id },
      orderBy: { at: 'asc' },
    });
    expect(audits).toHaveLength(2);
    expect(audits[1].action).toBe('update');
  });

  it('writes an audit row for raw-SQL updates too', async () => {
    const u = await db.user.create({ data: { email: 'c@x.co', name: 'C' } });
    await db.$executeRaw(raw`UPDATE users SET name = 'C2' WHERE id = ${u.id}`);
    const audits = await db.auditLog.findMany({
      where: { table_name: 'users', row_id: u.id, action: 'update' },
    });
    expect(audits).toHaveLength(1);   // <-- the whole point: the trigger fires, not just the event handler
  });
});
```

The third test is the one that justifies a trigger over a forge event: it exercises a write path that bypasses the typed surface, and verifies the trigger still fires. If the project's invariant is "every write is audited," that's the test that defends it.

For setup, the integration-test harness should:

1. Start a real DB (a `pg`, `mysql`, or `sqlite` container, or a per-test in-memory SQLite).
2. Run `forge push` to create tables.
3. Run the trigger DDL via `$executeRaw` (or, if using Option A from above, run `forge diff apply` to pick up the migration files).
4. Run the tests.
5. Tear down (drop the DB, or wipe tables).

The CI setup is the same shape as the [drift gate workflow in MIGRATIONS.md](./MIGRATIONS.md#a-github-actions-pr-check--drift-gate), with an added step that applies the trigger migrations.

---

## Common patterns

### 1. Audit-log trigger

The canonical use case. Every row change writes to `audit_log` with the table name, row ID, action, timestamp, actor, and old/new payload. The full pattern lives in the dedicated audit-log doc — see [worked example (a)](#worked-examples) below for the Postgres shape and [AUDIT-LOG.md](./AUDIT-LOG.md) if the project ships it.

### 2. `updated_at` auto-set

```sql
-- PG: BEFORE UPDATE that sets NEW.updated_at.
-- MySQL: same shape.
-- SQLite: AFTER UPDATE with a self-update (the workaround for no NEW assignment).
-- MSSQL: AFTER UPDATE with UPDATE … FROM INSERTED.
```

forge's query-event already handles this for typed writes. The trigger is the belt to the suspender — covers raw SQL paths and writes from sibling services.

### 3. Hierarchical cascade (closure table)

For a `categories` table with a self-referencing `parent_id`, the closure table holds the transitive closure of ancestor relationships. A trigger on `categories` AFTER INSERT writes the new node's ancestor rows; AFTER DELETE removes them; AFTER UPDATE of `parent_id` rebuilds the subtree. The pattern is in the [worked examples below](#worked-examples) as the SQLite hierarchical counter, scaled up.

### 4. Validation trigger (CHECK alternative)

When the invariant references another row or another table:

```sql
-- Order can't exceed user's credit limit, which lives on users.
CREATE TRIGGER trg_orders_credit_check
BEFORE INSERT ON orders
FOR EACH ROW
EXECUTE FUNCTION fn_check_credit();

CREATE FUNCTION fn_check_credit() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE limit_amt numeric;
BEGIN
  SELECT credit_limit INTO limit_amt FROM users WHERE id = NEW.user_id;
  IF NEW.total > limit_amt THEN
    RAISE EXCEPTION 'order total % exceeds user credit limit %', NEW.total, limit_amt
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
```

`ERRCODE = '23514'` is the SQL standard's `check_violation` — drivers map it to a `CheckConstraintViolation` error.

### 5. Soft-delete cascade

```sql
-- When a user is soft-deleted, soft-delete their posts and sessions too.
CREATE TRIGGER trg_users_soft_delete_cascade
AFTER UPDATE ON users
FOR EACH ROW
WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
EXECUTE FUNCTION fn_cascade_soft_delete();

CREATE FUNCTION fn_cascade_soft_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE posts SET deleted_at = NEW.deleted_at WHERE author_id = NEW.id AND deleted_at IS NULL;
  UPDATE sessions SET deleted_at = NEW.deleted_at WHERE user_id = NEW.id AND deleted_at IS NULL;
  RETURN NULL;
END $$;
```

The `WHEN` predicate filters to the transition (NULL → non-NULL), so a no-op update of an already-deleted user doesn't re-cascade.

### 6. Transactional outbox

```sql
-- Every order write also appends to _outbox.
-- The worker reads _outbox, ships to Kafka, marks rows as sent.
CREATE TRIGGER trg_orders_outbox
AFTER INSERT OR UPDATE ON orders
FOR EACH ROW
EXECUTE FUNCTION fn_orders_outbox();

CREATE FUNCTION fn_orders_outbox() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO _outbox (topic, key, payload, created_at)
  VALUES ('orders', NEW.id::text,
          jsonb_build_object('op', TG_OP, 'order', to_jsonb(NEW)),
          NOW());
  RETURN NULL;
END $$;
```

The outbox write and the order write commit atomically. A separate worker process polls `_outbox WHERE sent_at IS NULL` and ships to Kafka.

---

## Worked examples

### (a) Postgres audit-log trigger function

A reusable trigger function that audits any table that calls it. The function reads the table name from `TG_TABLE_NAME`, the operation from `TG_OP`, and uses `to_jsonb` to capture old / new state.

```sql
-- Audit table — owned by a role the app can INSERT into but not UPDATE / DELETE.
CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  table_name TEXT      NOT NULL,
  row_id     TEXT      NOT NULL,
  action     TEXT      NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  who        TEXT,
  diff       JSONB     NOT NULL
);
CREATE INDEX idx_audit_log_table_row ON audit_log (table_name, row_id, at DESC);

-- Reusable trigger function.
CREATE OR REPLACE FUNCTION fn_audit_row()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_who TEXT;
BEGIN
  -- The app sets this per-request via `SET LOCAL forge.current_user = '...'`.
  -- Falls back to the DB session user if missing.
  v_who := COALESCE(current_setting('forge.current_user', true), session_user);

  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_log (table_name, row_id, action, who, diff)
    VALUES (TG_TABLE_NAME, NEW.id::text, 'insert', v_who,
            jsonb_build_object('new', to_jsonb(NEW)));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO audit_log (table_name, row_id, action, who, diff)
    VALUES (TG_TABLE_NAME, NEW.id::text, 'update', v_who,
            jsonb_build_object('old', to_jsonb(OLD), 'new', to_jsonb(NEW)));
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO audit_log (table_name, row_id, action, who, diff)
    VALUES (TG_TABLE_NAME, OLD.id::text, 'delete', v_who,
            jsonb_build_object('old', to_jsonb(OLD)));
    RETURN OLD;
  END IF;
  RETURN NULL;
END
$$;

-- Wire to every audited table.
CREATE TRIGGER trg_users_audit
AFTER INSERT OR UPDATE OR DELETE ON users
FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

CREATE TRIGGER trg_orders_audit
AFTER INSERT OR UPDATE OR DELETE ON orders
FOR EACH ROW EXECUTE FUNCTION fn_audit_row();
```

The actor (`v_who`) comes from a session-local GUC the app sets at the start of every request:

```ts
await db.$transaction(async (tx) => {
  await tx.$executeRaw(raw`SELECT set_config('forge.current_user', ${userId}, true)`);
  // The third arg `true` makes it transaction-scoped, so it dies with the tx.
  await tx.user.update({ where: { id: userId }, data: { name } });
});
```

That gives you per-request attribution without changing the trigger function.

### (b) MySQL `updated_at` on every UPDATE

```sql
DELIMITER //

CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
BEGIN
  IF NEW.updated_at = OLD.updated_at THEN
    SET NEW.updated_at = CURRENT_TIMESTAMP(6);
  END IF;
END //

DELIMITER ;
```

The guard `IF NEW.updated_at = OLD.updated_at` distinguishes "app didn't touch the field" from "app explicitly set it." If the app passed an `updated_at` (e.g. for a backdated import), the trigger respects it. If the app left it alone, the trigger sets it.

The `CURRENT_TIMESTAMP(6)` gives microsecond precision, matching forge's `f.dateTime()` default. On older MySQL (5.6.4+) make sure the column is declared `TIMESTAMP(6)` or `DATETIME(6)` — without the precision suffix, you lose the sub-second resolution and concurrent updates can collide.

### (c) SQLite hierarchical counter trigger

A `counters` table maintains `descendant_count` for every node in `categories`. A trigger on `categories` AFTER INSERT / DELETE walks up the parent chain and updates the count.

```sql
CREATE TABLE categories (
  id        TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES categories(id)
);

CREATE TABLE counters (
  category_id     TEXT PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
  descendant_count INT NOT NULL DEFAULT 0
);

-- AFTER INSERT — bump every ancestor's count by 1.
CREATE TRIGGER trg_categories_counter_inc
AFTER INSERT ON categories
FOR EACH ROW
BEGIN
  INSERT INTO counters (category_id, descendant_count)
  VALUES (NEW.id, 0)
  ON CONFLICT (category_id) DO NOTHING;

  WITH RECURSIVE ancestors AS (
    SELECT parent_id FROM categories WHERE id = NEW.id AND parent_id IS NOT NULL
    UNION ALL
    SELECT c.parent_id FROM categories c
    JOIN ancestors a ON c.id = a.parent_id
    WHERE c.parent_id IS NOT NULL
  )
  UPDATE counters
  SET descendant_count = descendant_count + 1
  WHERE category_id IN (SELECT parent_id FROM ancestors);
END;

-- AFTER DELETE — decrement.
CREATE TRIGGER trg_categories_counter_dec
AFTER DELETE ON categories
FOR EACH ROW
BEGIN
  WITH RECURSIVE ancestors AS (
    SELECT parent_id FROM categories WHERE id = OLD.id AND parent_id IS NOT NULL
    UNION ALL
    SELECT c.parent_id FROM categories c
    JOIN ancestors a ON c.id = a.parent_id
    WHERE c.parent_id IS NOT NULL
  )
  UPDATE counters
  SET descendant_count = descendant_count - 1
  WHERE category_id IN (SELECT parent_id FROM ancestors);
END;
```

Three things to note:

* **Recursive CTEs inside a trigger body** — SQLite allows this, and it's the only way to walk a hierarchy without procedural control flow.
* **`ON CONFLICT (category_id) DO NOTHING`** — the counter row may not exist yet when the first child is inserted. Idempotent insert covers the case.
* **`PRAGMA recursive_triggers`** — left at the default (ON). The triggers don't update `categories`, so they don't re-fire themselves.

For Postgres, the same pattern lives in a PL/pgSQL function with `WITH RECURSIVE` and `UPDATE counters … WHERE category_id IN (…)`. The shape is identical; the procedural wrapping is different.

### (d) Mongo change-stream as the trigger alternative

A worker process that subscribes to the `users` collection's change stream and writes audit rows.

```ts
// scripts/workers/audit-stream.ts
import { createDb, raw } from 'forge-orm';
import { schema } from '../../src/schema';

const db = await createDb({ url: process.env.DATABASE_URL!, schema });
const usersColl = (db.adapter as any).db.collection('users');

// Resume token: persisted per-restart so we don't miss events.
const tokenRow = await db.changeStreamToken.findFirst({
  where: { stream: 'users' },
});
const resumeAfter = tokenRow?.resume_token ? JSON.parse(tokenRow.resume_token) : undefined;

const stream = usersColl.watch([], {
  fullDocument: 'updateLookup',
  resumeAfter,
});

stream.on('change', async (event) => {
  const action =
    event.operationType === 'insert' ? 'insert' :
    event.operationType === 'update' ? 'update' :
    event.operationType === 'delete' ? 'delete' : null;
  if (!action) return;

  const row_id = String(event.documentKey._id);
  const payload =
    action === 'delete'
      ? { old: event.fullDocumentBeforeChange ?? null }
      : { new: event.fullDocument };

  await db.$transaction(async (tx) => {
    await tx.auditLog.create({
      data: { table_name: 'users', row_id, action, at: new Date(), payload },
    });
    await tx.changeStreamToken.upsert({
      where: { stream: 'users' },
      create: { stream: 'users', resume_token: JSON.stringify(event._id) },
      update: { resume_token: JSON.stringify(event._id) },
    });
  });
});

stream.on('error', (err) => {
  console.error('[audit-stream] error', err);
  process.exit(1);   // Let the supervisor restart us; resume token picks up where we left off.
});
```

Three points:

1. **Resume token** — stored in `changeStreamToken`. On worker restart, we resume from the last successfully-audited event. Without this, a crash means lost events.
2. **`fullDocument: 'updateLookup'`** — the change stream re-fetches the post-update document. Without it, an update event only has the change description, not the resulting state.
3. **`fullDocumentBeforeChange`** — requires `changeStreamPreAndPostImages: { enabled: true }` set on the collection. If not enabled, deletes will have no payload (Mongo only tells you "this `_id` was deleted").

The worker runs alongside the API server. For HA, run two replicas with a leader-election lock (`db.lock.upsert(...)`) so only one writes audits at a time — change streams are happy with multiple readers but the resume-token write needs to be single-writer.

---

## Cross-links

* [MIGRATIONS.md](./MIGRATIONS.md) — how trigger DDL ships alongside schema changes; the `_forge_migrations` ledger; per-dialect rollback fidelity.
* [RAW-SQL.md](./RAW-SQL.md) — `$executeRaw` and `forgeSql` for the trigger-DDL apply path; the `$runCommandRaw` shape used for Mongo change-stream administration.
* [EVENTS.md](./EVENTS.md) — the app-layer event hook that often replaces triggers when all writes go through the typed surface.
* [WATCH.md](./WATCH.md) — the typed wrapper around Mongo change streams (and SQL polling fallbacks); higher-level than the raw `collection.watch()` in the worker example above.
* [CHECKS.md](./CHECKS.md) — declarative `CHECK` constraints, the simpler alternative when the invariant is single-row.
* [MONGO.md](./MONGO.md) — the Mongo adapter's full surface, including the change-stream prerequisites (replica set, pre-image config).
* [AUDIT-LOG.md](./AUDIT-LOG.md) — the audit-log pattern in full, including the per-dialect trigger shapes, the actor-attribution dance, and the retention strategy.

Triggers are the smallest piece of forge's surface that you write by hand. The reason they stay outside the typed schema is the same reason raw SQL does — there's a long tail of dialect-specific behaviour that's faster to learn once than to chase forever through an abstraction. The patterns above cover the 80%; the per-dialect docs above cover the rest.
