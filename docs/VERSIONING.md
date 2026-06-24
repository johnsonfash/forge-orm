# Schema versioning

forge-orm doesn't have numbered migration files — your schema file is the version, and git history is the changelog. This page covers what changes are safe online, the expand/contract pattern for breaking changes, multi-app coordination, and the snapshot/diff workflow that gives you "what changed between releases."

Companion to [MIGRATIONS.md](./MIGRATIONS.md) (the deep reference for every CLI command), [DEPLOYMENT.md](./DEPLOYMENT.md) (how migrations slot into a release pipeline), [DIFF.md](./DIFF.md) (the differ itself), [ROLLBACK.md](./ROLLBACK.md) (the inverse path), and [BACKUP-RESTORE.md](./BACKUP-RESTORE.md) (when versioning isn't enough). The other four docs answer "how do I drive the CLI?"; this one answers "how do I think about schema changes over time?"

## Contents

* [The push-style model recap](#the-push-style-model-recap)
* [Where versioning lives — git, tags, and the schema file](#where-versioning-lives--git-tags-and-the-schema-file)
* [Forward-compatibility windows](#forward-compatibility-windows)
* [Backward-compatibility windows](#backward-compatibility-windows)
* [The expand / contract pattern](#the-expand--contract-pattern)
* [Column rename via expand/contract](#column-rename-via-expandcontract)
* [Type widening — usually safe](#type-widening--usually-safe)
* [Type narrowing — never online](#type-narrowing--never-online)
* [Adding NOT NULL to an existing column](#adding-not-null-to-an-existing-column)
* [Removing a field](#removing-a-field)
* [Enum evolution](#enum-evolution)
* [Index rollout — per-dialect online DDL](#index-rollout--per-dialect-online-ddl)
* [Multi-app coordination](#multi-app-coordination)
* [Snapshot strategy — pinning IR per release](#snapshot-strategy--pinning-ir-per-release)
* [Diff between releases](#diff-between-releases)
* [Worked examples](#worked-examples)
  * [(a) Renaming `email_address` → `email`](#a-renaming-email_address--email)
  * [(b) Tightening a Decimal precision](#b-tightening-a-decimal-precision)
  * [(c) Splitting `name` into `first_name` + `last_name`](#c-splitting-name-into-first_name--last_name)
* [Cross-references](#cross-references)

---

## The push-style model recap

forge is a declare-and-push ORM. You write models in `src/schema.ts`, run `npx forge push`, and the binary introspects the live database and emits the DDL needed to bring it forward. There is no `migrations/` folder of timestamped files you hand-edit, no `prisma migrate dev` step, no down-files wired up by hand. The artefact of "schema at commit X" is the schema file at commit X — nothing else.

What that means for versioning:

* **The schema file is the version.** There is no separate "schema version" field. The Git SHA of `src/schema.ts` is the version. Two deploys at the same SHA describe the same intended database shape.
* **There is no numbered timeline.** A Prisma migration history is a directory of `20260601_add_users.sql`-style files; the directory ordering is the version sequence. forge has no such directory by default. `forge diff apply` produces files for destructive operations only — that's a small minority of changes — and even those files reflect "what changed between the schema and the DB at apply time", not "the schema as of release v1.4.7".
* **The push verb is additive-only.** `forge push` will create tables, columns, indexes, constraints, FKs, FTS shadows. It will not drop columns the schema removed, change types, or drop tables. The destructive operations live in `forge diff apply`, where you see them in the preview before they run. Read [MIGRATIONS.md](./MIGRATIONS.md#forge-push) for the full surface.

The trade-off is symmetric:

* **What you get** — round-trip time on a schema change is seconds. Add a field, save, `npx forge push`, done. No file naming conventions, no merge conflicts on `20260601_add_users.sql`, no "I forgot to run `migrate dev`" rebases. A new developer clones, sets `DATABASE_URL`, runs `forge push`, and has a populated schema.
* **What you give up** — there is no out-of-band record of "the schema at this point in time, separate from the code". Versioning lives in Git and only in Git. If your compliance regime needs a signed artefact of "the schema applied to prod on date X", you either tag the schema file (covered below) or use `forge diff apply` to materialise the change as a file you can sign.

This page is the bridge from "code is the version" to a workflow that survives long-running products with many deploys and overlapping app versions.

---

## Where versioning lives — git, tags, and the schema file

If the schema file is the version, the changelog is the file's git history.

```sh
git log -p src/schema.ts
git log --oneline src/schema.ts
git blame src/schema.ts
```

That history is your full audit trail of "who changed what shape when". The PR that added a column is reviewable; the merge SHA is the deploy boundary; the commit message is the rationale. There is nothing else.

### Tagging schema versions to product versions

For a product on semantic versions, tag the schema file's state at every release. The cheapest version is to tag the whole repository — `v1.4.7` already pins `src/schema.ts` at the SHA of that release. The next step up is a schema-specific tag that lets ops answer "what schema is on prod right now?" without cross-referencing the app version:

```sh
# At release time, after the deploy succeeded:
git tag -a schema/v1.4.7 -m "Schema state for product v1.4.7"
git push origin schema/v1.4.7
```

`schema/v1.4.x` tags live alongside product tags. The pattern doesn't require any forge feature — it's just disciplined tagging. When ops asks "what shape is the database in?", they checkout the matching `schema/*` tag and look.

For a tighter binding, write the product version into a comment at the top of the schema file:

```ts
// src/schema.ts
// Schema version: v1.4.7
// Last breaking change: v1.4.0 (split name → first_name + last_name)
// Forward-compat window: app v1.4.x reads this schema

import { model, f } from 'forge-orm';

export const User = model('users', { /* ... */ });
```

The comment is informational — forge doesn't read it. But it makes `git log -L /Schema version/,+5:src/schema.ts` answer "when did the version comment change?" which is a useful timeline.

### What goes in the schema file, what doesn't

The schema file declares models. Anything else — feature flags, sample data, environment guards — belongs elsewhere. Pollution makes diffs harder to review and breaks the property that "the schema file is the version". The full list of what `model()`, `f.*`, and the index definitions accept is in [MODEL.md](./MODEL.md), [TYPES.md](./TYPES.md), and [INDEXES.md](./INDEXES.md).

### Branching and schema

Long-lived feature branches that touch the schema are dangerous. Two branches that both add a `users.preferences` column with different types will conflict at push time, not at merge time — whoever pushes first wins, the other gets a column-type-mismatch drift item. The mitigation is short branches and PR drift checks: a CI job that runs `forge diff` against the main-shaped DB (see [MIGRATIONS.md](./MIGRATIONS.md#ci-workflows)) catches the conflict at PR time.

---

## Forward-compatibility windows

A forward-compatibility window is the property that **app version N-1 can run successfully against a database whose schema has been pushed to N**.

This is the property that makes a rolling deploy possible. During the rollout, both the old image (N-1) and the new image (N) hit the same database. The new push has already run; the old pods are still serving. If a query in the old pods breaks against the new schema, you have an outage during the rollout window, which can last anywhere from 10 seconds to 15 minutes depending on platform.

### Rules that preserve forward compatibility

| Operation | Forward-safe? | Why |
|---|---|---|
| Add a nullable column | Yes | Old code ignores it; new code reads/writes it. |
| Add a column with a default | Yes | Old code ignores it; new code reads it. |
| Add an index | Yes | Indexes are query-engine-only; no app code refers to them by name. |
| Add a new table | Yes | Old code has no SELECT against it. |
| Add a foreign key | Yes if FK is on a new column; **No** if it's on an existing column with data the FK would reject. |
| Widen a type (`VARCHAR(100)` → `VARCHAR(255)`) | Yes | Old code's writes still fit. |
| Add an enum value | Mostly yes — see [Enum evolution](#enum-evolution). |
| Rename a column | **No** | Old code SELECTs the old name. |
| Drop a column | **No** | Old code SELECTs the dropped name. |
| Narrow a type | **No** | Old code may write values that don't fit. |
| Add NOT NULL to existing column | **No** | Old code may INSERT without setting it. |

The single rule is **additive only, no rename, no narrow**. If the change can't be expressed that way, it's a breaking change and needs the expand/contract pattern below.

### The window's actual length

The forward-compat window starts when the new schema lands on the DB (the `forge push` step in your CD pipeline) and ends when the last N-1 pod drains. On most platforms that's measured in seconds to minutes:

| Platform | Typical drain window |
|---|---|
| Kubernetes rolling update | 30s – 5min (depends on `maxSurge`, readiness probes, app warmup) |
| Fly.io rolling deploy | 10s – 1min per machine × number of machines |
| ECS rolling | 2 – 10min (default `minimumHealthyPercent: 100`) |
| Vercel / Lambda warm pool | 5 – 15min (no platform-driven eviction; waits for traffic) |
| Manual rolling restart | however long you take |

The Vercel / Lambda case is the worst because there's no platform signal that says "drain finished". A warm Lambda execution context from N-1 may serve a request 12 minutes after the new deploy. Forward-compat needs to hold for the full window — assume hours if you can't measure it.

---

## Backward-compatibility windows

A backward-compatibility window is the inverse: **app version N can run successfully against a database that's still at schema version N-1 if a rollback re-points the deploy at the old image**.

This matters because the schema push happens *before* the app deploy. If the app fails after the push, you roll back the app — but the DB is on the new schema. The new code that handled the new schema is gone; you're back to the old code, which expected the old schema.

### Rules that preserve backward compatibility

The mirror image of the forward-compat rules:

| Operation | Backward-safe? | Why |
|---|---|---|
| Add a nullable column | Yes | New code writes it; rolled-back old code ignores it. |
| Add an index | Yes | Old code queries are merely faster or unchanged. |
| Drop a column (after expand/contract) | Yes by construction — old code already stopped using it. |
| Add NOT NULL after a backfill | Yes — old code wasn't writing nulls anyway by the time of the constraint. |
| Rename without expand/contract | **No** — the rolled-back code reads the old name. |
| Narrow a type | **No** — old code may be writing the wider range. |

The window length is whatever your rollback budget is. If you can roll the app back within 10 minutes, the DB must work with the N-1 code for those 10 minutes; after that the rollback is a re-deploy with new code, which can carry its own forward migration. If your rollback budget is "always within an hour, never more", everything in that hour has to be both forward and backward compatible. In practice, that means the same rule: additive only.

### Why the two windows aren't symmetric

Forward-compat is *guaranteed-during-rollout*; backward-compat is *available-if-needed*. The forward window always activates on every deploy (rolling updates are always two-versioned briefly). The backward window only activates if you actually roll back, which most deploys don't. But when it does, you can't have nothing — a rollback against a DB the rolled-back code can't read is an outage.

The team-level rule that handles both: **every schema change is backward-compatible at the moment of push, and stays that way until the next release supersedes it**. Breaking changes happen across multiple releases via expand/contract.

---

## The expand / contract pattern

Every breaking change splits into three phases:

1. **Expand** — add the new shape alongside the old. Both old and new code can run against this state.
2. **Migrate clients** — deploy code that reads/writes the new shape. The old shape may still be present but unused.
3. **Contract** — drop the old shape, leaving only the new.

This is the single pattern that makes breaking changes safe in a push-style model. It's not forge-specific — it's the same pattern as Stripe's column-additive migrations, GitHub's `gh-ost` workflow, and the textbook "Refactoring Databases" expand/contract. forge's contribution is that the diff between each phase is small enough to review.

### Why three phases and not one

A one-shot rename (`username` → `handle`) means there's a window between "DB has both columns" and "app reads new column" where:

* Old app pods still write `username`, which doesn't exist anymore → 500s.
* New app pods read `handle`, which is empty for un-backfilled rows → wrong data.

Three phases guarantee that at every deploy boundary, both the old and new app code work against the current DB shape. No request sees a transient state where the column it expects doesn't exist.

### Phase 1 — expand

The schema declares both the old and the new shape. Both old and new code can run against this DB.

```ts
// Phase 1: schema declares both columns. `handle` is nullable so existing rows pass.
const User = model('users', {
  id:       f.id(),
  username: f.string().unique(),
  handle:   f.string().optional(),
});
```

Run `forge push`. The push emits `ALTER TABLE users ADD COLUMN handle TEXT NULL`. Old app code still reads/writes `username` and ignores the new column; new app code starts dual-writing to both.

The expand phase must be backward-compatible. The expand DDL adds optional columns or indexes only — never drops, never renames, never tightens constraints. The migrations system covers what's expressible at this phase in [MIGRATIONS.md](./MIGRATIONS.md#zero-downtime-change-patterns).

### Phase 2 — migrate clients

App code changes to use the new shape:

* **Dual-write** — when the app creates or updates a row, it writes both old and new columns. This keeps both shapes valid for any code that still reads either one.
* **Backfill** — a one-off script populates the new column for existing rows. Done in batches inside a transaction, idempotent against re-runs, recorded in `_forge_migrations` so a second invocation no-ops. The pattern is detailed in [MIGRATIONS.md](./MIGRATIONS.md#data-migration-vs-ddl-migration).
* **Switch reads** — app code starts reading from the new column. The old column is now write-only.

This phase can be multiple deploys. The order matters: dual-write first (so the new column is being populated for new data), then backfill (so it's populated for old data), then switch reads (so the app doesn't depend on the old column anymore). A single deploy can combine dual-write and switch-reads only if the read switch is gated behind a feature flag with a rollback that goes back to reading the old column.

### Phase 3 — contract

Drop the old shape. The schema removes the old column or constraint:

```ts
// Phase 3: only the new shape remains.
const User = model('users', {
  id:     f.id(),
  handle: f.string().unique(),
});
```

The push won't drop the column on its own — `forge push` is additive-only. Run `forge diff apply` to generate the destructive migration. The CLI shows the preview before running:

```
[forge:diff:apply] 1 change(s):
  • drop users.username
```

Confirm. The DROP executes, the change is recorded in `_forge_migrations`, the column and its data are gone.

The contract phase must follow Phase 2 by at least one full release cycle. Specifically: every app pod from Phase 2 must have drained before Phase 3 runs, because a Phase-2 pod still expects to write to the old column. Once Phase 3 runs, that pod will fail. In practice this means waiting for a full deploy cycle to complete plus a buffer (a day is conservative; an hour is usually enough on Kubernetes; a week is appropriate if you have warm Lambdas that can run forever).

### How forge enforces nothing

forge does not enforce the three-phase discipline. The CLI can't tell that a change is breaking — it sees a smaller schema and dutifully generates the DROP. The discipline is yours, reinforced by code review and the drift gate. The PR that does the contract phase should include a comment with the deploy date of the migrate-clients phase, so the reviewer can confirm the window has elapsed.

---

## Column rename via expand/contract

Renaming is the canonical breaking change. forge's differ has no rename heuristic — a schema change that renames `email` → `email_address` looks like "drop `email`, add `email_address`" to the differ. `forge diff apply` will happily emit both. The data in the renamed column will be deleted unless you preserve it through expand/contract.

The full rename walkthrough:

### Deploy 1 — expand

Add the new column nullable. Keep the old column unchanged.

```ts
const User = model('users', {
  id:       f.id(),
  email:    f.string().unique(),
  newEmail: f.string().optional(),   // future home
});
```

`forge push` runs `ALTER TABLE users ADD COLUMN new_email TEXT NULL`. Old code reads/writes `email`. New code from the next deploy will dual-write.

### Deploy 2 — dual-write

App code writes both columns on every create / update. Reads still come from the old column.

```ts
// app/api/users/route.ts
await db.user.create({
  data: { email: input.email, newEmail: input.email }, // dual-write
});
```

After Deploy 2, every new row has the new column populated. Existing rows still don't.

### Backfill (no schema change)

Run a one-off `scripts/migrate/<date>-backfill-new-email.ts` script that copies `email` → `new_email` for every row where `new_email IS NULL`. Stream the table in batches so the script doesn't lock the whole users table. The pattern is in [MIGRATIONS.md](./MIGRATIONS.md#data-migration-vs-ddl-migration); the shape:

```ts
await db.user
  .findManyStream({ where: { newEmail: null }, select: { id: true, email: true }, batchSize: 1000 })
  .forEach(async (batch) => {
    await db.$transaction(async (tx) => {
      for (const u of batch) {
        await tx.user.update({ where: { id: u.id }, data: { newEmail: u.email } });
      }
    });
  });
```

After the backfill, `new_email` is populated for every row. The script records itself in `_forge_migrations` so re-runs are no-ops.

### Deploy 3 — switch reads, tighten constraint

Code reads from `new_email`. The schema marks the column required and unique. The old column is now write-only but still present.

```ts
const User = model('users', {
  id:       f.id(),
  email:    f.string(),                    // still here, dropped the unique
  newEmail: f.string().unique(),           // now required + unique
});
```

`forge push` adds the unique index on `new_email`. The old column's unique becomes a regular index or is dropped via the next push. Code reads `newEmail` everywhere; writes still set both columns.

### Deploy 4 — contract

The schema drops the old column.

```ts
const User = model('users', {
  id:       f.id(),
  newEmail: f.string().unique(),
});
```

Run `npx forge diff apply`. The diff preview shows `drop users.email`. Confirm. Done.

Now the schema is in its final state. Optionally rename `newEmail` → `email` in the *application code* (the database column is `new_email` — that's a separate concern from the field name, which forge maps via `f.string().column('new_email')` if you want to align them).

### Compressed rename table

The same workflow as a table:

| Deploy | Schema | DDL emitted | App reads | App writes |
|---|---|---|---|---|
| 1 | both, `new_email` nullable | ADD COLUMN new_email | `email` | `email` |
| 2 (code only) | — | — | `email` | `email` + `new_email` |
| backfill | — | — (one-off script) | `email` | `email` + `new_email` |
| 3 | both, `new_email` unique | ADD UNIQUE on new_email | `new_email` | `email` + `new_email` |
| 4 | only `new_email` | (via `diff apply`) DROP COLUMN email | `new_email` | `new_email` |

Five operations across four deploys — the longest path on this page. Most schema changes don't need it; only renames do.

---

## Type widening — usually safe

Widening a column's type — `VARCHAR(100)` → `VARCHAR(255)`, `INT` → `BIGINT`, `NUMERIC(10,2)` → `NUMERIC(12,2)` — is forward-compatible on most dialects. Old code that wrote a 100-character value still writes a valid value to a 255-character column. New code can write up to 255.

forge does not auto-widen. The differ flags a category-level mismatch (`int` vs `bigint`) and `forge diff apply` does not currently emit `ALTER TABLE … ALTER COLUMN TYPE …` — it's in the [drift item taxonomy](./DIFF.md#the-driftitem-taxonomy) as a `columnType` mismatch, but the generator doesn't produce DDL for it. The workaround:

```ts
// scripts/migrate/20260624-widen-bio.ts
import { createDb, raw } from 'forge-orm';
import { schema } from '../../src/schema';

const db = await createDb({ url: process.env.DATABASE_URL!, schema });
await db.$executeRaw(raw`ALTER TABLE users ALTER COLUMN bio TYPE TEXT`);
await db.$disconnect();
```

Then update the schema to declare the wider type. The next `forge push` sees the column shape matches and skips. Same idea as the online-index pattern in [DEPLOYMENT.md](./DEPLOYMENT.md#online-index-creation): hand-rolled DDL upfront, then let push reconcile.

### Per-dialect widening notes

* **Postgres** — `ALTER COLUMN … TYPE …` rewrites the table for some conversions (`text` → `int`), locks-and-rewrites others, runs instantly for compatible widenings (`varchar(50)` → `varchar(255)`, `int4` → `int8` since PG 12). Run during a maintenance window if the conversion isn't instant.
* **MySQL 8** — Most type widenings are INPLACE / non-locking. `VARCHAR` widening within `VARCHAR(<256)` is metadata-only; widening across the 256 boundary is a table rebuild.
* **SQLite** — Types are dynamic. `VARCHAR(100)` and `TEXT` are the same affinity. Widening is a no-op at the storage layer.
* **DuckDB** — `ALTER TABLE … ALTER COLUMN TYPE …` rewrites the column. Online for OLAP-scale tables.
* **MSSQL** — `ALTER COLUMN` is metadata-only when widening within the same family (`NVARCHAR(100)` → `NVARCHAR(255)`). Crossing into `NVARCHAR(MAX)` is a rewrite.
* **Mongo** — schemaless; no widening to do.

### Widening is safe but not free

Even when the operation is metadata-only, the schema declaration changes. That's a code change that goes through review. Don't widen "just in case" — wait until a real use case needs the extra range.

---

## Type narrowing — never online

Narrowing a column's type — `VARCHAR(255)` → `VARCHAR(100)`, `BIGINT` → `INT`, `NUMERIC(12,2)` → `NUMERIC(10,2)` — is **never** forward-compatible. Old code may be writing values that don't fit the narrower type. Every existing row may be over-size and break the conversion.

The pattern is expand/contract on a parallel column:

1. **Add the narrower column** alongside the old, nullable.
2. **Backfill** — copy from old to new, truncating or rejecting values that don't fit. Either silently truncate (data loss; document it) or surface the rejects to a quarantine table for manual review.
3. **Switch writes** to the new column. New writes are constrained to the narrower type.
4. **Wait** for app instances to drain.
5. **Switch reads** to the new column.
6. **Drop the old column**.

This is six steps because the data side is harder than the rename case — you can't just copy, you have to decide what to do with values that don't fit. The shape isn't different from rename; it's the data-validation step that adds a deploy.

For inline narrowing (no parallel column), the only safe path is a maintenance window: stop writes, run the conversion, restart. The downtime is whatever the conversion takes — minutes for small tables, hours for large ones.

### When narrowing is actually needed

Almost never. The reasons people narrow:

* "We made it `VARCHAR(255)` and it should have been `VARCHAR(50)`." → Leave it. The storage is the same; the constraint is the only difference. Add a CHECK constraint at the schema level if you want to enforce the lower bound.
* "Postgres `int8` is heavier than `int4`." → Almost always wrong. The 4 bytes don't matter at any practical scale. Don't narrow.
* "MySQL's `tinyint(1)` is more idiomatic than `int`." → `forge`'s differ sees both as `int`/`bool`; the change is cosmetic. Leave it.

The only real case is "we picked the wrong type and now we're paying for it in indexes" — and even then, the parallel-column path above is the only safe one.

---

## Adding NOT NULL to an existing column

Never add `NOT NULL` to an existing column directly. The push will emit `ALTER TABLE … ALTER COLUMN … SET NOT NULL`, which on every dialect requires that every existing row already has a non-null value in that column. If even one row has `NULL`, the ALTER fails. If old app code is still writing nulls, the constraint will reject the next INSERT.

The three-phase path:

1. **Add the column as nullable** (or, for an existing column, leave it nullable). `forge push` allows this directly.
2. **Backfill** every existing null to a meaningful value. Use the standard one-off migration script pattern; idempotent, runs in the deploy pipeline.
3. **Deploy code that stops writing nulls.** Every code path that creates or updates the row must set a value.
4. **Wait** for old app instances to drain. Any old pod still writing nulls will break the next step.
5. **Tighten to NOT NULL.** Update the schema to drop `.optional()`. `forge push` emits the ALTER. With no nulls in the column, it succeeds.

The forge schema declaration:

```ts
// Phase 1 — nullable
const User = model('users', { id: f.id(), handle: f.string().optional() });

// Phase 5 — tightened
const User = model('users', { id: f.id(), handle: f.string() });
```

Between phases 1 and 5 is the backfill and the drain. Counting deploys: usually 3 (the optional add, the dual-write/backfill release, the required tighten).

### Defaults instead of NOT NULL

When the column can have a sensible default, you can compress the three phases:

```ts
const User = model('users', {
  id:        f.id(),
  is_active: f.bool().default(true),
});
```

`forge push` emits `ALTER TABLE users ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE`. Every existing row gets `TRUE`; the NOT NULL holds because of the default; new code can rely on it from the first deploy. This is the single-step pattern when it applies — and it almost always applies for booleans, status enums, and counter fields.

For columns where there is no sensible default (e.g. a per-user `slug` that must be unique), the three-phase pattern is required.

---

## Removing a field

The mirror image of adding a NOT NULL. The three-phase shape:

1. **Stop writing.** Deploy code that no longer writes to the column. Any INSERT or UPDATE that previously set it now omits it. The column stays in the DB, the value defaults or stays at its prior state.
2. **Stop reading.** Deploy code that no longer SELECTs the column. The column is now dormant — present in the DB, ignored by the app.
3. **Drop the column.** Schema removes the field; `forge diff apply` emits `ALTER TABLE … DROP COLUMN …`. Data is permanently deleted.

The time between phases is the rollback window. If you might roll back to a code version that still reads the column, that version expects the column to be present and full of data. Drop it too early and the rollback is broken. Keep the gap to at least one release cycle for short-rollback shops; more for long-rollback ones.

### Why two phases on the code side

You could combine "stop writing" and "stop reading" into a single deploy if the column is only written by code paths that also read it. In practice, write paths (POST/PUT endpoints) often span multiple services. The two-phase split is conservative: stop writes first, observe for a release that nothing is producing new data, then stop reads.

The single-phase combined approach works fine for in-process columns — a `users.deprecated_score` column read and written only by one service can be dropped from both code paths in one deploy. Two-phase is the conservative default; one-phase is fine for narrow scopes.

### Rollback budget for the contract step

Once `forge diff apply` drops the column, the data is gone. `forge rollback` will emit `ALTER TABLE … ADD COLUMN …` from the down block, but the column comes back empty — see [ROLLBACK.md](./ROLLBACK.md) for the full surface. The rollback restores the *shape*, not the data. If the dropped data is recoverable, restore from a backup ([BACKUP-RESTORE.md](./BACKUP-RESTORE.md)) before re-running app code.

The practical rule: **assume a DROP is one-way.** If you might need to recover, take a backup first.

---

## Enum evolution

Enums are a special case because the dialects treat them differently.

### Adding an enum value

| Dialect | Operation | Safe online? |
|---|---|---|
| Postgres | `ALTER TYPE … ADD VALUE …` | Yes — runs instantly, no table lock |
| MySQL | `ALTER TABLE … MODIFY COLUMN … ENUM(…)` | INPLACE if the new value is added at the end; rewrite if inserted in the middle |
| SQLite | (no native enum; stored as TEXT with CHECK) | Yes — drop and re-add the CHECK constraint |
| DuckDB | `ALTER TYPE … ADD VALUE …` | Yes |
| MSSQL | (no native enum; stored as VARCHAR with CHECK) | Yes — `ALTER TABLE … DROP CONSTRAINT …; ADD CONSTRAINT …` |
| Mongo | no enum at the DB layer — app-side validation only | Trivially safe |

forge's `f.enum([...])` declares values at the schema level. Adding a value to the array and pushing produces the ALTER on each dialect. The differ does not re-order enum values — appending is the safe pattern; inserting in the middle on MySQL forces a table rewrite.

The forward-compat caveat: old app code that has the old enum values hard-coded won't *use* the new value, but it also won't *break* on reading rows whose values are still old. The risk is the reverse — old code reading a row whose value is the new enum that the old code doesn't know about. That's a code-side decision: validate against a known set or accept any string.

### Removing an enum value

Always breaking. Every row whose value is the removed entry violates the new constraint. The path:

1. **Stop writing the value.** Code deploys that no longer write the deprecated value.
2. **Migrate existing rows.** A one-off script updates rows from the old value to a new one (or deletes them, or sets a fallback).
3. **Remove the value from the schema.** `forge push` emits the constraint update.

This is the same three-phase shape as removing a field. The enum value is just a specific case.

### Renaming an enum value

Treat it as remove-old + add-new with a backfill in between. Three deploys, no shortcut.

---

## Index rollout — per-dialect online DDL

Indexes are the most-changed schema element after columns, and the rules for safely rolling them out vary by dialect. Detailed treatment is in [INDEXES.md](./INDEXES.md) and [DEPLOYMENT.md](./DEPLOYMENT.md#online-index-creation); the versioning-specific summary:

### Postgres — `CREATE INDEX CONCURRENTLY`

Forge's `forge push` emits plain `CREATE INDEX` (locking on the write side). For tables with millions of rows, that's an unacceptable write pause. The escape hatch:

```ts
// scripts/migrate/20260624-add-events-idx.ts
await db.$executeRaw(raw`
  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_created_at
  ON events (created_at DESC)
`);
```

Then declare the index in the schema. The next `forge push` sees the index present, skips it. The end state is the schema and the DB agreeing, with the index created online.

CONCURRENTLY can fail and leave the index in an `INVALID` state — `pg_index.indisvalid = false`. Drop and re-run if that happens:

```sql
DROP INDEX CONCURRENTLY idx_events_created_at;
CREATE INDEX CONCURRENTLY idx_events_created_at ON events (created_at DESC);
```

### MySQL — online DDL

MySQL 8 supports online index creation via `ALGORITHM=INPLACE, LOCK=NONE` for most index types:

```ts
await db.$executeRaw(raw`
  ALTER TABLE events ADD INDEX idx_events_created_at (created_at),
  ALGORITHM=INPLACE, LOCK=NONE
`);
```

For older MySQL or schemas incompatible with INPLACE (some FULLTEXT cases on InnoDB before 5.6), Percona's `pt-online-schema-change` copies the table in chunks behind a trigger. Out-of-band; run `pt-osc`, then re-run `forge push` to confirm the diff is clean.

### SQLite — full rebuild for column changes, fast for index changes

Index creation on SQLite locks the database file briefly. Acceptable for any practical table size. No escape hatch needed.

For schema operations that *do* need a rebuild (e.g. `DROP COLUMN` on SQLite < 3.35), the workflow is the table-copy pattern in [MIGRATIONS.md](./MIGRATIONS.md#sqlite--335-column-drop-requires-rebuild). That's a one-time operational concern, not a versioning concern.

### Mongo — `createIndex` is online since 4.2

`db.collection.createIndex({...})` runs in the background on the primary by default since MongoDB 4.2. forge's `forge push` emits the createIndex via the Node driver; no flag needed.

### MSSQL — `WITH (ONLINE = ON)`

```ts
await db.$executeRaw(raw`
  CREATE INDEX idx_events_created_at ON events (created_at) WITH (ONLINE = ON)
`);
```

Available on Enterprise edition. On Standard, indexes lock the table; rolling out a new index requires a maintenance window or table swap.

### Versioning implications

The index escape hatch — hand-rolled DDL upfront, schema declaration after — adds a step to the rollout but doesn't change the schema version. The index is in the DB whether you created it via raw DDL or via `forge push`. The schema-side declaration is what determines whether subsequent pushes will skip or recreate it.

For audit purposes, the raw DDL goes through a normal PR, just like the schema change. The PR title and commit message document the online-create decision; the diff is the SQL.

---

## Multi-app coordination

When two or more apps share a database, schema versioning gets a new dimension: every app must agree on a compatible schema version at the moment of any push.

### Pattern A — service-per-DB (preferred)

Each app owns its own database. The forward-compat / backward-compat windows are between deploys of *that* app, against *that* DB. There is no cross-app coordination beyond the standard rolling-deploy pattern. This is the simple case and covered in [DEPLOYMENT.md](./DEPLOYMENT.md#one-schema-many-stages).

When this fits: most service-oriented architectures, microservice setups, anything where the data model is per-service.

### Pattern B — shared DB, partial schemas

When apps share a DB, each app declares only its own models in its `schema.ts`. Cross-app references are imported from a shared package as read-only. The pattern is in [MIGRATIONS.md](./MIGRATIONS.md#migration-in-monorepos):

```ts
// packages/shared/src/schema.ts — read-only model refs
export const Users = model('users', { id: f.id(), email: f.string() }, { readonly: true });
```

```ts
// packages/billing-service/src/schema.ts — own tables + import the shared refs
import { Users } from '@org/db-shared';

export const Invoice = model('invoices', {
  id:     f.id(),
  userId: f.string().refs(() => Users),
  total:  f.decimal(),
});

export const schema = { Invoice } as const;   // does NOT include Users
```

`billing-service`'s `forge push` only sees `Invoice`; the differ won't touch `users`. The shared `Users` model still gives typed FKs and join queries. The version of `@org/db-shared` is the cross-app contract: when it bumps, every consuming service has to acknowledge the bump (either by upgrading their package version or by pinning to the old one).

### SemVer of the shared schema package

Treat the shared schema package like any other npm dependency. SemVer applies:

| Change in `@org/db-shared` | Bump | Why |
|---|---|---|
| Add a new shared model | minor | Additive; consumers ignore it. |
| Add a column to a shared model | minor | Consumers see the field but old code ignores it. |
| Rename a column on a shared model | **major** | Old consumers break. Run expand/contract across the org. |
| Drop a column from a shared model | **major** | Old consumers break. |
| Tighten a constraint on a shared model | **major** | Old consumers may be writing values that fail. |
| Add a constraint that an old consumer would violate | **major** | Same. |

Major bumps in `@org/db-shared` force a cross-team conversation. The pattern: the team that owns the shared model proposes the change, every consuming team confirms they can migrate, and the change rolls out as expand/contract across services. The shared package is the version-coordination point.

### Versioned tables as an escape hatch

When two apps need incompatible shapes for the same logical entity, the table-versioning escape hatch sidesteps the conflict. Maintain `orders_v1` and `orders_v2` side by side, each app reading and writing the one that matches its expectations. A migration layer (e.g. a database view, an application-level adapter) reconciles. Eventually one version retires.

```ts
const OrderV1 = model('orders_v1', { id: f.id(), customer: f.string(), total: f.decimal() });
const OrderV2 = model('orders_v2', { id: f.id(), customerId: f.string(), totals: f.json() });

// A view bridges the two for read-only consumers:
const OrderRead = model('order_read', { id: f.id(), customer_id: f.string(), total: f.decimal() }, {
  view: { definition: raw`
    SELECT id, customer AS customer_id, total FROM orders_v1
    UNION ALL
    SELECT id, customer_id, CAST(totals->>'subtotal' AS DECIMAL) FROM orders_v2
  ` },
});
```

This is a heavyweight tool. Reach for it only when the schema disagreement is permanent and can't be expanded/contracted in a reasonable time window — e.g. an internal app on a slow upgrade cycle and a customer-facing app that has to ship a feature now. For most teams, expand/contract on a single table is enough.

### Drift checks across apps

In a shared-DB setup, each app's `forge diff` will see "extra tables" — the tables owned by other apps. Add them to `FORGE_DIFF_IGNORE` so the drift check doesn't flag them:

```sh
# In billing-service's CI:
export FORGE_DIFF_IGNORE='users,user_sessions,plans,plan_features'
```

The pattern is detailed in [MIGRATIONS.md](./MIGRATIONS.md#--ignore-patterns). The takeaway: each service's drift gate watches only its own surface, and the cross-app coordination lives in the shared package's version.

---

## Snapshot strategy — pinning IR per release

For audit, rollback planning, and "what changed between releases", save a snapshot of forge's intermediate representation at every release.

The IR is `expectedFromSchema(schema)` — the same function the differ uses internally to compute what the live DB should look like. The IR is dialect-agnostic; it's the canonical form of "what shape would forge push emit".

### Generating a snapshot

```ts
// scripts/snapshot.ts
import { writeFileSync } from 'node:fs';
import { expectedFromSchema } from 'forge-orm/scripts/diff-core';
import { schema } from '../src/schema';

const ir = expectedFromSchema(schema);
const version = process.env.RELEASE_VERSION ?? 'unknown';
writeFileSync(
  `snapshots/schema-${version}.json`,
  JSON.stringify(ir, null, 2),
);
console.log(`Wrote snapshots/schema-${version}.json`);
```

Run at release time, after the version bump:

```sh
RELEASE_VERSION=v1.4.7 npx tsx scripts/snapshot.ts
git add snapshots/schema-v1.4.7.json
git commit -m "Snapshot schema for v1.4.7"
git tag schema/v1.4.7
```

The snapshot file is committed to git alongside the source. It's a JSON document of `{ tables: [...], views: [...] }` — typically a few hundred lines for a real-world schema. The diff between two snapshot files is the schema change between two releases:

```sh
git diff schema/v1.4.6 schema/v1.4.7 -- snapshots/
```

### The shape of the snapshot

The IR captures everything forge needs to emit DDL:

```json
{
  "tables": [
    {
      "name": "users",
      "columns": [
        { "name": "id", "kind": "id", "category": "string" },
        { "name": "email", "kind": "string", "category": "string", "unique": true },
        { "name": "created_at", "kind": "dateTime", "category": "datetime" }
      ],
      "indexes": [
        { "name": "idx_users_email_lower", "method": "btree",
          "expression": "lower(email)", "unique": true }
      ],
      "foreignKeys": []
    }
  ],
  "views": []
}
```

Everything the [drift item taxonomy](./DIFF.md#the-driftitem-taxonomy) compares is in here. A column type widening shows up as a `category` change; a new index shows up as an entry in `indexes`. The snapshot is the schema's machine-readable form.

### Snapshots and compliance

For compliance regimes that require "the schema applied to prod on date X", the snapshot file is your artefact. Sign it (`gpg --detach-sign snapshots/schema-v1.4.7.json`) alongside the build artefact and you have a tamper-evident record. The signature covers the IR, which transitively covers the DDL forge would emit from it.

### Snapshots and rollback

If a release is bad and you need to know "what shape do we need to roll back to?", load the previous snapshot and feed it to `diffIntrospection` as the expected shape against a live introspect. The output is "what the live DB has that v1.4.6 didn't" — your rollback target. Combine with `forge rollback` (the down block of the most-recent applied migration) and you can walk the DB back. Mechanics of the rollback itself are in [ROLLBACK.md](./ROLLBACK.md).

---

## Diff between releases

The combination of tagged snapshots and the differ gives you a "what changed between releases?" query:

```ts
// scripts/diff-releases.ts
import { readFileSync } from 'node:fs';

const from = process.argv[2] ?? 'v1.4.6';
const to   = process.argv[3] ?? 'v1.4.7';

const a = JSON.parse(readFileSync(`snapshots/schema-${from}.json`, 'utf8'));
const b = JSON.parse(readFileSync(`snapshots/schema-${to}.json`, 'utf8'));

// Treat the older snapshot as the "live DB" and the newer as the "schema".
// The differ then reports what the newer release adds.
import { diffIntrospection } from 'forge-orm/scripts/diff-core';
const report = diffIntrospection({ tables: b.tables, views: b.views }, asIntrospection(a), []);

console.log(`${from} → ${to}:`);
for (const item of report.items) {
  console.log(`  ${item.direction === 'missing' ? '+' : '-'} ${item.kind} ${item.detail}`);
}

function asIntrospection(snap: any) {
  return {
    tables: snap.tables.map((t: any) => ({
      name: t.name,
      columns: t.columns,
      indexes: t.indexes,
      foreignKeys: t.foreignKeys ?? [],
    })),
    views: snap.views ?? [],
  };
}
```

Run:

```sh
npx tsx scripts/diff-releases.ts v1.4.6 v1.4.7
# v1.4.6 → v1.4.7:
#   + column users.email_verified_at
#   + index users.idx_users_email_verified
#   - column users.legacy_handle
```

This is the changelog of your schema, generated from the IR. It pairs nicely with a `CHANGELOG.md` entry — paste the output under the release header so the next person who looks at "what shipped in v1.4.7?" sees the schema change too.

### `forge diff` against a saved snapshot

Snapshots can also drive an offline diff against a target version, no DB needed:

```sh
# Pin to v1.4.6's expected shape, compare against current src/schema.ts:
RELEASE_VERSION=v1.4.6 npx tsx scripts/snapshot.ts
git stash             # save the v1.4.7 schema
git checkout schema/v1.4.6 -- src/schema.ts
# Now use the differ against the saved snapshot
```

The forge-side primitive is `expectedFromSchema`, available from `forge-orm/scripts/diff-core`. It's stable across releases — bumping forge versions doesn't change the IR shape — so saved snapshots remain readable. If forge ever bumps the IR shape, snapshot files would need a forward-compat shim; treat the JSON as part of your schema contract.

---

## Worked examples

### (a) Renaming `email_address` → `email`

A long-standing column called `email_address` should have been `email`. We rename it via expand/contract over three deploys.

**Initial schema:**

```ts
const User = model('users', {
  id:            f.id(),
  email_address: f.string().unique(),
});
```

**Deploy 1 — expand:**

```ts
const User = model('users', {
  id:            f.id(),
  email_address: f.string().unique(),
  email:         f.string().optional(),
});
```

`forge push` emits `ALTER TABLE users ADD COLUMN email TEXT`. Code from this deploy starts dual-writing both columns.

**Backfill:**

```ts
// scripts/migrate/20260624-backfill-email.ts
await db.user
  .findManyStream({ where: { email: null }, select: { id: true, email_address: true }, batchSize: 1000 })
  .forEach(async (batch) => {
    await db.$transaction(async (tx) => {
      for (const u of batch) {
        await tx.user.update({ where: { id: u.id }, data: { email: u.email_address } });
      }
    });
  });
```

Idempotent (the `WHERE email IS NULL` filter); records itself in `_forge_migrations`. Run once.

**Deploy 2 — switch reads + tighten:**

```ts
const User = model('users', {
  id:            f.id(),
  email_address: f.string(),          // unique dropped
  email:         f.string().unique(), // now required + unique
});
```

`forge push` emits `ALTER TABLE users DROP CONSTRAINT users_email_address_key` (via diff apply if it's a unique constraint forge emitted; via a raw script if it's a custom index) and `CREATE UNIQUE INDEX … ON users (email)`. Code reads `email` everywhere; writes still set both.

**Wait one release cycle** for all v1 / v2 pods to drain.

**Deploy 3 — contract:**

```ts
const User = model('users', {
  id:    f.id(),
  email: f.string().unique(),
});
```

`npx forge diff apply` previews:

```
[forge:diff:apply] 1 change(s):
  • drop users.email_address
```

Confirm. The DROP runs; the data in `email_address` is permanently deleted (we already copied it). The schema is now in its final shape.

Total deploys: 3 plus a one-off script. Total elapsed time: as long as a release cycle, typically a week. The forge-side cost: a one-line schema edit per deploy plus the backfill script.

### (b) Tightening a Decimal precision

A `payments.amount` column declared as `f.decimal()` (default precision `(38,9)` on most dialects) needs to tighten to `f.decimal({ precision: 12, scale: 2 })` to match financial-statement requirements. Some existing rows may have values that exceed the new precision.

**The problem space:**

| Action | Risk |
|---|---|
| Just tighten the schema and push | The push would emit `ALTER COLUMN … TYPE DECIMAL(12,2)`, which fails on the first row whose value doesn't fit. |
| Truncate values that don't fit | Silent data loss; auditors care. |
| Surface oversize rows for manual review | Slow; needs a quarantine table. |

**The four-deploy path:**

**Deploy 1 — parallel column:**

```ts
const Payment = model('payments', {
  id:           f.id(),
  amount:       f.decimal(),                              // existing, wide
  amount_v2:    f.decimal({ precision: 12, scale: 2 }).optional(), // narrow, nullable
});
```

`forge push` adds the new column.

**Survey + backfill:** a one-off script runs `SELECT id, amount FROM payments WHERE amount > 9999999999.99 OR amount < -9999999999.99`, refuses to proceed if any rows are returned, and surfaces them to a quarantine table for ops review. Resolution might be a write-down, a quarantine, or a regulator filing — that's outside forge's scope. Once the survey passes (zero oversize rows), the script runs `UPDATE payments SET amount_v2 = amount WHERE amount_v2 IS NULL` inside a transaction, idempotent and recorded in `_forge_migrations`.

**Deploy 2 — dual-write:**

App code writes both `amount` and `amount_v2` on every new payment. New payments are constrained at the app layer to fit `DECIMAL(12,2)`.

**Deploy 3 — switch reads:**

App code reads `amount_v2` everywhere. `amount` is write-only.

**Deploy 4 — contract:**

```ts
const Payment = model('payments', {
  id:        f.id(),
  amount_v2: f.decimal({ precision: 12, scale: 2 }),
});
```

`forge diff apply` drops the wide column. Optionally rename `amount_v2` → `amount` in app code (the column name in the DB stays `amount_v2` unless you push a second rename, which is a separate cycle).

The four deploys correspond to the four required transitions: schema expansion, dual-write, read switch, contraction. No request ever sees an inconsistent state.

### (c) Splitting `name` into `first_name` + `last_name`

A combined `users.name` column needs to split into `first_name` + `last_name`. The data is heterogeneous: most rows have a clear "First Last" pattern, some have middle names, some have only one word. The split has to handle the ambiguity.

**Deploy 1 — expand:**

```ts
const User = model('users', {
  id:         f.id(),
  name:       f.string(),
  first_name: f.string().optional(),
  last_name:  f.string().optional(),
});
```

`forge push` adds the two new columns.

**Backfill:**

```ts
// scripts/migrate/20260624-split-name.ts
await db.user
  .findManyStream({ where: { first_name: null }, select: { id: true, name: true }, batchSize: 500 })
  .forEach(async (batch) => {
    await db.$transaction(async (tx) => {
      for (const u of batch) {
        const parts = u.name.trim().split(/\s+/);
        const first = parts[0] ?? '';
        const last  = parts.length > 1 ? parts.slice(-1)[0] : '';
        await tx.user.update({
          where: { id: u.id },
          data:  { first_name: first, last_name: last },
        });
      }
    });
  });
```

The split logic is yours — "First Last" is one heuristic; "Last, First" if the data is in that form is another; surfacing rows that don't match a pattern to a quarantine table for manual review is a third. The forge side is the streaming update inside a transaction, with idempotency via `_forge_migrations`.

**Deploy 2 — dual-write:**

App code writes all three columns. New users supply `first_name` and `last_name` directly; the combined `name` is computed as `${first_name} ${last_name}`.

**Deploy 3 — switch reads + tighten:**

```ts
const User = model('users', {
  id:         f.id(),
  name:       f.string(),
  first_name: f.string(),
  last_name:  f.string(),
});
```

Code reads `first_name` and `last_name`. `name` is dual-written but unused.

**Deploy 4 — contract:**

```ts
const User = model('users', {
  id:         f.id(),
  first_name: f.string(),
  last_name:  f.string(),
});
```

`forge diff apply` drops `name`. The combined column is gone; the two parts remain.

The split case adds a wrinkle the rename case doesn't have: the backfill is lossy. A combined `name` might have data the split can't recover (a middle name dropped on the floor, a hyphen in a surname misparsed). The pattern handles it via the optional quarantine table — surface ambiguous rows, resolve manually, then proceed. The forge cost is the same as the other cases: one schema edit per deploy plus a backfill script.

---

## Cross-references

* [MIGRATIONS.md](./MIGRATIONS.md) — every CLI command's deep reference, drift rules, per-dialect emit table, blue/green schema pattern, monorepo workflows.
* [DEPLOYMENT.md](./DEPLOYMENT.md) — zero-downtime change patterns, rolling-restart specifics, platform worked examples (Vercel + Neon, Fly.io, AWS ECS).
* [DIFF.md](./DIFF.md) — the differ's internals: drift item taxonomy, safe-vs-pending classification, `expectedFromSchema` IR shape.
* [ROLLBACK.md](./ROLLBACK.md) — `forge rollback` semantics, per-dialect fidelity, the three rollback paradigms (snapshot, forward-only, blue/green).
* [BACKUP-RESTORE.md](./BACKUP-RESTORE.md) — when the schema rollback isn't enough and you need point-in-time recovery.
* [INDEXES.md](./INDEXES.md) — the full index surface — partial filters, expression indexes, INCLUDE, per-dialect online-DDL specifics.
* [MODEL.md](./MODEL.md) — the `model()` builder, options, view shape, collection naming.
* [TYPES.md](./TYPES.md) — every `f.*` field type, default precision, dialect mapping.
