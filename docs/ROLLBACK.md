# Rollback

forge-orm uses a push-style model (current schema → live DB), so rollback semantics differ from version-numbered migrations. This page covers `forge rollback`, the snapshot store, and the three rollback paradigms that work with forge — snapshot rollback, forward-only, and blue/green.

Companion to **[MIGRATIONS.md](./MIGRATIONS.md)** — that file is the deep reference for `forge push`, `forge diff`, `forge diff apply`, and drift detection. This file is the deep reference for what to do *after* the apply went wrong, or after a deploy needs to come back. If you're new, read MIGRATIONS.md first; the rollback paths only make sense once you know how the apply paths work.

## Contents

* [The push-style rollback model — no version-numbered timeline](#the-push-style-rollback-model--no-version-numbered-timeline)
* [`forge rollback` — what it does](#forge-rollback--what-it-does)
* [The snapshot store — `migrations/` + `_forge_migrations`](#the-snapshot-store--migrations--_forge_migrations)
* [Three rollback paradigms](#three-rollback-paradigms)
  * [Snapshot rollback](#snapshot-rollback)
  * [Forward-only](#forward-only)
  * [Blue/green](#bluegreen)
* [Per-dialect rollback gotchas](#per-dialect-rollback-gotchas)
* [Schema rollback vs data rollback](#schema-rollback-vs-data-rollback)
* [CI rollback pattern](#ci-rollback-pattern)
* [Distributed rollback — multi-region and sharded](#distributed-rollback--multi-region-and-sharded)
* [Emergency procedures — full restore from backup](#emergency-procedures--full-restore-from-backup)
* [Three worked rollbacks](#three-worked-rollbacks)
* [Cross-references](#cross-references)

---

## The push-style rollback model — no version-numbered timeline

In a Prisma-Migrate / knex / Rails-style ORM, every schema change has a unique timestamped file. The history of the database is the directory of those files. Rolling back means picking a version and applying `down` blocks until you reach it. The number-in-a-folder is the source of truth for "what shape was the DB at deploy X".

forge does not work that way. The schema declaration *is* the source of truth — the current shape at HEAD. There is no version-numbered timeline. `forge push` reads the schema, introspects the DB, and brings it forward; the additive 90% of changes never produce a file at all.

This shifts what "rollback" can mean:

* **You can't pick a numbered version to roll to** — there are no numbers. There are only schema files at specific git SHAs.
* **You roll back by changing the schema** — `git revert` the offending PR, `forge push` again. The next push will produce no DDL (the additive changes you reverted are already in the DB; push won't drop them) but the schema-side intent is back to the prior state. From there you decide whether to leave the extra columns dormant or run `forge diff apply` to drop them.
* **The destructive operations produce a file** — `forge diff apply` writes a SQL migration with `up` and `down` blocks. Those *are* a snapshot of "what changed and what the inverse is". `forge rollback` reads the down block of the most-recent file and runs it.

So forge has two rollback shapes, and they're orthogonal:

| Shape | Tool | Reverts |
|---|---|---|
| Revert the schema declaration | `git revert` + `forge push` | Additive changes that haven't been applied destructively yet |
| Run the down block of the last applied destructive migration | `forge rollback` | The most-recent `forge diff apply` file |

This page is mostly about the second shape — the destructive case — because additive rollback is "just git revert; push is idempotent". When you read "rollback" below without a qualifier, it means the second shape.

### What rollback is for

Rollback is for the narrow window between "we applied DDL we shouldn't have" and "we noticed". The further past that window you get, the less rollback can recover:

* **Within minutes** — the migration applied, no app code has written data to new columns yet, nothing has read from columns about to be re-added. Rollback is near-lossless.
* **Within hours** — backfills have started writing to the new column. Rolling back drops them. The schema reverts; the data does not come back. You may also have read paths that now break against the rolled-back shape.
* **Within days** — the schema change is load-bearing. Rolling it back means more breakage than the original bug. The realistic move is **forward-only** (patch the bug with a new release) or a full restore from a backup taken before the migration.

Rollback is not a time machine. It's a small lever for a small window. The rest of this page is honest about where that window closes.

---

## `forge rollback` — what it does

```sh
npx forge rollback
```

That's the entire CLI surface. No flags. No `--to <slug>`, no `--dry-run`, no `--keep-data`. The CLI does exactly one thing:

1. Read `DATABASE_URL`, connect.
2. Refuse if the adapter is `mongo` — Mongo has no DDL; rollback there is "edit the schema and re-push".
3. Ensure `_forge_migrations` exists; read the list of applied migrations.
4. Pick the **most recent** row by `name` (ISO-timestamp lexicographic order).
5. Read `migrations/<name>.sql` from disk. If the file is missing, exit with an error — there's nothing to run.
6. Parse the file's `-- down` block, split into statements, run each one.
7. Delete the row from `_forge_migrations`.

That's it. The source is intentionally tiny — `src/scripts/rollback.ts` is under 50 lines.

### Exit codes

| Exit | Meaning |
|---|---|
| 0 | The down block ran and the ledger row was removed. (Also: no migrations to roll back; logged as "nothing to do".) |
| 1 | Setup failure — `DATABASE_URL` unset, can't connect, file missing on disk, statement errored, or Mongo adapter. |

There is no exit-3-on-drift like `forge diff --check`. Rollback either applied cleanly or didn't.

### Logging

```
[forge:rollback] rolling back '20260624T143052_drift' (3 statement(s))
[forge:rollback] rolled back '20260624T143052_drift'.
```

If a statement fails mid-down:

```
[forge:rollback] rolling back '20260624T143052_drift' (3 statement(s))
  ✗ failed: DROP TABLE IF EXISTS audit_old
    relation "audit_old" does not exist
```

The ledger row is **not** removed on partial failure. On PG / DuckDB / MSSQL the transactional DDL means earlier successful statements in the down block also roll back, so the DB is back to the pre-rollback state. On MySQL / SQLite DDL is implicitly committing — earlier statements stuck, the failure is mid-way, and `_forge_migrations` still shows the row as applied. Re-running `forge rollback` will try the whole down block again; the earlier statements that already ran will now be no-ops (`DROP IF EXISTS`) or hard errors (`DROP CONSTRAINT` on something that's gone). Inspect and either fix forward or apply the missing inverse manually with `db.$executeRaw`.

### Rollback only goes back one

The CLI does not walk back N migrations. If you applied three destructive migrations and want to revert all three, run `forge rollback` three times — each invocation reads the new "most recent" row after the prior one was removed. This is deliberate: each step is one transaction, one logged event, one revertable unit. Batching them would hide partial failures behind a single command.

If you want a "rollback to slug X" CLI, build it as a shell wrapper:

```sh
# scripts/rollback-to.sh
target="$1"
[ -z "$target" ] && { echo "usage: rollback-to.sh <migration-slug>"; exit 1; }

while true; do
  current=$(psql "$DATABASE_URL" -tAc "SELECT name FROM _forge_migrations ORDER BY name DESC LIMIT 1")
  [ -z "$current" ] && { echo "no migrations applied"; exit 0; }
  [ "$current" = "$target" ] && { echo "reached target $target"; exit 0; }
  npx forge rollback || { echo "rollback failed at $current"; exit 1; }
done
```

forge doesn't ship this because the policy ("stop at this slug, inclusive or exclusive?") is yours, not the library's.

---

## The snapshot store — `migrations/` + `_forge_migrations`

There is no `.forge/` directory. forge does not maintain a parallel snapshot store of "every schema state we've ever been at". The two pieces that together make rollback possible are:

1. **The `migrations/` directory** — created by `forge diff apply` when a destructive change is applied. One file per applied migration. The file holds the up block (what got run) and the down block (the inverse, computed at apply time from the live DB introspect). This directory **is** the snapshot store — each file is a frozen snapshot of "here's the shape change, and here's how to reverse it".
2. **The `_forge_migrations` ledger** — a two-column table inside your database. Created on first `diff apply` or `rollback`. Tracks which files have been applied to *this* database.

### Migration file layout

```sql
-- forge migration: 20260624T143052_drift
-- generated: 2026-06-24T14:30:52.413Z

-- up
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMPTZ;
DROP TABLE IF EXISTS "audit_old";

-- down
DROP TABLE IF EXISTS "audit_old"; -- cannot auto-restore dropped table
ALTER TABLE "users" DROP COLUMN "email_verified_at";
```

* The filename is `<timestamp>_<slug>.sql` — timestamp is `YYYYMMDDTHHMMSS` (no separators), slug is `drift` for diff-apply output.
* The down block is computed at *apply time*, against the live DB that was being modified. The shape it captures is the shape that existed before the up ran. This is the snapshot — it's not a separate file, it's embedded in the migration.
* Comments survive parsing (`splitStatements` drops them). A `-- cannot auto-restore` line in the down means there's no useful inverse for that statement — the operator has to restore from backup.

### The ledger table

```sql
CREATE TABLE _forge_migrations (
  name        VARCHAR(255) PRIMARY KEY,
  applied_at  VARCHAR(64)
);
```

* Portable across PG / MySQL / SQLite / DuckDB / MSSQL — `VARCHAR(255)` is honored everywhere.
* `name` is the migration filename minus `.sql`.
* `applied_at` is an ISO-8601 string. `forge rollback` doesn't use it; it's there for ops dashboards and audits.
* Always-ignored by `forge diff` — the differ filters this name explicitly so it never shows up as drift.

### What lives where

```
your-project/
├── src/schema.ts                          # source of truth for current shape
├── migrations/
│   ├── 20260620T091200_drift.sql          # snapshot of a prior destructive apply
│   ├── 20260622T143000_drift.sql
│   └── 20260624T143052_drift.sql          # most recent — what `forge rollback` will read
└── (inside the DB)
    └── _forge_migrations
        name                          applied_at
        20260620T091200_drift         2026-06-20T09:12:01.114Z
        20260622T143000_drift         2026-06-22T14:30:01.882Z
        20260624T143052_drift         2026-06-24T14:30:52.413Z
```

### Implications

* **Check `migrations/` into git.** It's the only durable record of destructive history. If you `.gitignore` it, you lose the down blocks across machines and `forge rollback` on a fresh checkout will fail with "file not found".
* **The ledger is per-database.** If you `forge diff apply` against staging, the file is committed to git and rolls forward to prod via the next deploy; on prod the file exists on disk but `_forge_migrations` doesn't have its row yet. The first time `forge diff apply` runs on prod, it'll re-apply that file. (Unless it's already in sync — in which case the differ produces no items and the file is unchanged.) This is the correct behaviour: each environment tracks its own apply state.
* **There is no "current schema snapshot" file.** The schema-at-this-SHA is the schema declaration at that SHA. The migrations directory only records destructive *deltas*; additive deltas leave no file because `forge push` handles them idempotently.

### Inspecting state

```ts
// scripts/migration-status.ts
import { createDb, raw } from 'forge-orm';

const db = await createDb({ url: process.env.DATABASE_URL! });
const rows = await db.$queryRaw<{ name: string; applied_at: string }>(
  raw`SELECT name, applied_at FROM _forge_migrations ORDER BY applied_at DESC`,
);
console.table(rows);
await db.$disconnect();
```

Wire this into an admin endpoint or a Datadog tag so ops can see "what migration is the prod DB on" without shelling onto the box.

---

## Three rollback paradigms

`forge rollback` is one of three approaches you can take when a schema change misbehaves. They are not mutually exclusive — most production systems use a mix — but it helps to know which paradigm a given recovery is using.

### Snapshot rollback

**What:** Run the down block of the most-recent migration file via `forge rollback`. Schema reverts; data in dropped columns is gone.

**When to reach for it:**

* The migration was just applied (minutes ago, not hours).
* The new schema element has no committed user data yet — added column hasn't been written to, new table has no rows, new index is just slow.
* You're in a window where reverting the schema doesn't itself break the app (i.e. the app code that depends on the new shape hasn't been deployed yet, or has been simultaneously rolled back).

**Strengths:**

* Mechanically simple. One CLI command. No coordinated multi-step plan.
* The down block was computed against the live DB at apply time, so the inverse fits the actual state, not a guess.
* The `_forge_migrations` ledger keeps you honest — you can see exactly what's been rolled back, and a re-apply later is the same file.

**Limits:**

* Only goes back one migration per invocation.
* Data in dropped columns / tables is not recovered.
* On MySQL / SQLite, a mid-down crash leaves the DB half-rolled-back (see [per-dialect gotchas](#per-dialect-rollback-gotchas)).
* If the migration file isn't on disk (someone deleted it, fresh CI checkout that doesn't include `migrations/`), rollback fails with "file not found". Keep the directory in git.

### Forward-only

**What:** Never roll the schema back. If a release was bad, patch it with a *new* release that lands forward — add a new column, fix the broken code path, deprecate the misbehaving one. The shape only ever moves in one direction: forward.

**When to reach for it:**

* The migration has been live long enough that user data has been written to new columns. Rolling back would drop real data.
* You're past the deploy window — multiple downstream services already depend on the new shape (replication, read replicas, downstream consumers of CDC).
* The "bug" is in the app code, not the schema. Roll back the app; leave the schema. Future deploys can fix the app to use the new schema correctly.
* You operate at a scale where any DDL is a maintenance event (multi-TB tables, online schema change tooling like `pt-online-schema-change` or `gh-ost` in the loop). Rolling back means another planned maintenance window — not worth it for fixable bugs.

**Strengths:**

* Zero risk of data loss from the rollback itself.
* The deploy pipeline is the recovery pipeline — no separate "rollback" tooling to maintain.
* Composes cleanly with blue/green: each forward release is a small additive step you can ramp traffic against.

**Limits:**

* "Just fix it forward" depends on the fix being possible without more schema change. If the original migration was wrong-shaped (e.g. wrong column type), forward-only means *another* migration to widen the type, then *another* to backfill, then *another* to drop the wrong column.
* The DB carries dead columns and indexes for some time. Periodic `forge diff --check` can flag what's accumulated; `forge diff apply` cleans up.
* Requires the app to be feature-flagged or gradually rolled out enough that "old app, new schema" is a valid combination.

This is the right default for any production system handling user data. Reach for snapshot rollback only when forward-only is provably worse.

### Blue/green

**What:** Run two schema shapes simultaneously and flip traffic between them. The old shape (blue) keeps serving while the new shape (green) is prepared. If green is bad, route back to blue — no DDL rollback needed, because blue still exists. When green is proven good, retire blue.

**When to reach for it:**

* The change is structurally significant — splitting a table, switching primary keys, renaming columns the app reads everywhere.
* You need an instant revert path — a feature-flag flip, not a schema migration.
* The DB layer supports concurrent shapes — separate tables (`users` + `users_v2`) is the simplest; logical replication into a new schema is more powerful but heavier; per-row dual writes are middle ground.

**Strengths:**

* The "rollback" is a routing decision. No DDL runs on the bad-news path.
* You can test green against a fraction of traffic before flipping fully.
* No data loss on revert — blue still has the canonical state.

**Limits:**

* Cost. You run two shapes, two write paths, two read paths, often for days.
* App complexity. The dual-write window is delicate — every mutation has to land in both shapes, every read has to pick the right one. Bugs here cost more than the schema change saved.
* Some changes are hard to blue/green at all — e.g. a global unique constraint that has to be honored across both shapes is its own coordination problem.

The four-step rename pattern in [MIGRATIONS.md → Blue/green schema rollouts](./MIGRATIONS.md#bluegreen-schema-rollouts) is the lite version of blue/green — you run two shapes within one table for a few deploys, then drop the old shape. The heavier version, two separate tables with traffic routing, is the right call when the change is too large for the four-step pattern to absorb.

### Choosing among the three

```
Did the migration just apply? (minutes ago)
├── Yes — is the new column / table empty of user data?
│   ├── Yes — snapshot rollback.
│   └── No — forward-only.
└── No — has the change been live for hours or days?
    ├── Hours — forward-only is the safe default.
    └── Days — forward-only or, if the rollback is structural, blue/green to the prior shape.
```

The decision is rarely "which paradigm is technically best" — it's "which paradigm protects user data and keeps the app available right now". Use the cheapest one that does.

---

## Per-dialect rollback gotchas

| Dialect | DDL in tx? | ADD COLUMN rollback | DROP COLUMN rollback | Crash mid-rollback |
|---|---|---|---|---|
| Postgres | Yes | DROP COLUMN — clean | ADD COLUMN with introspected type — data gone | Atomic; reverts to post-up state |
| MySQL | **No** — DDL implicit commit | DROP COLUMN — clean | ADD COLUMN — data gone | Partial; ledger row still present |
| SQLite | **No** — DDL implicit commit | DROP COLUMN needs 3.35+ | ADD COLUMN — data gone | Partial; ledger row still present |
| DuckDB | Yes | DROP COLUMN — clean | ADD COLUMN — data gone | Atomic |
| MSSQL | Yes | DROP COLUMN — clean | ADD COLUMN — data gone | Atomic |
| Mongo | N/A | `forge rollback` refuses — edit schema, re-push | drop the collection by hand | N/A |

### What gets undone, what doesn't

| Up operation | Down emits | Lossless? |
|---|---|---|
| ADD COLUMN (no data yet) | DROP COLUMN | Yes |
| ADD COLUMN (data backfilled after apply) | DROP COLUMN | **No — the backfilled data is lost on rollback** |
| CREATE INDEX | DROP INDEX | Yes |
| ADD CONSTRAINT | DROP CONSTRAINT | Yes |
| ADD FK | DROP FK | Yes |
| DROP COLUMN | ADD COLUMN with the type the introspect saw at up time | **No — column shape preserved, data is gone** |
| DROP TABLE | comment ("cannot auto-restore") | **No — best-effort note only** |
| Rename column | not emitted | Not detected; appears as drop-then-add |
| Rename table | not emitted | Same |
| Type widening | not emitted | Type changes aren't generated; rollback can't reverse what was never emitted |

### SQLite < 3.35 trap

`forge diff apply` emits a plain `DROP COLUMN`. SQLite added support for that in 3.35 (March 2021). On older versions:

```
[forge:rollback] rolling back '20260624T143052_drift' (1 statement(s))
  ✗ failed: ALTER TABLE users DROP COLUMN legacy_token
    near "DROP": syntax error
```

If you're stuck on an older SQLite, the rollback workaround is the same as the apply workaround — manual table rebuild. Read out the data you want to keep, drop the table, recreate it with the prior schema, copy the data back. forge doesn't generate that rebuild; the operator owns the data preservation decision.

### MySQL / SQLite partial-rollback recovery

On these dialects, a crash mid-down block leaves you with:

* Some down statements applied (the early ones).
* Some down statements not applied (the rest).
* The `_forge_migrations` row still present.

`forge rollback` is **not** transactional on these dialects because the dialect itself isn't. Recovery:

1. Look at the migration file's down block. List the statements in order.
2. Inspect the live DB. Determine which statements were applied and which weren't.
3. Either:
   * Apply the missing statements manually with `db.$executeRaw` and delete the ledger row, or
   * Re-apply the up block to get back to the post-up state, then re-run `forge rollback`. The down block is mostly idempotent (DROP IF EXISTS), but ADD COLUMN of an existing column will fail — you'd have to manually skip those statements.

The realistic move on MySQL / SQLite after a mid-rollback crash is usually "fix forward" — apply the missing inverse statements by hand, sync `_forge_migrations`, and move on. Don't try to make `forge rollback` re-run cleanly.

### Postgres / DuckDB / MSSQL — atomic rollback

These dialects wrap the entire down block in a transaction. A crash mid-down means the partially-applied down rolls back inside the DB, and you're left at the post-up state — same as if rollback never started. `_forge_migrations` is also unchanged because the DELETE happens inside the same transaction. Re-run `forge rollback` and it'll try again from a known state.

### Mongo

`forge rollback` exits with `[forge:rollback] Mongo uses forge:push, not SQL migrations.` Mongo's index management is idempotent server-side; there is no DDL to roll back. To revert a Mongo schema change:

1. Edit the schema back to its prior shape.
2. Re-run `forge push`. Indexes that no longer exist in the schema will *not* be auto-dropped (push is additive); use `db.collection.dropIndex(name)` from the driver if you need to drop one.
3. To drop a collection entirely, use `db.<model>.drop()` or the Mongo shell — forge does not auto-drop collections.

---

## Schema rollback vs data rollback

Forge's rollback is a **schema** rollback. It moves DDL backwards. It does not move data backwards.

If you `forge rollback` a migration that ran for 24 hours, every row inserted into the new column / table during that 24 hours is dropped with the column. The schema reverts; the data does not come back.

This is not a forge limitation — it's the nature of DDL rollback in any ORM. Prisma Migrate, knex, Rails, Flyway, Liquibase: same story. The down block undoes the shape change; it cannot reach back in time for rows that existed only because the shape was there.

### When you need data rollback

The only realistic answer for data rollback is **restore from a backup taken before the migration**. Concretely:

* **Postgres** — `pg_dump` before the migration; `pg_restore` on revert. For point-in-time recovery, WAL archiving + `recovery_target_time` lets you roll the DB back to seconds before the migration ran.
* **MySQL** — `mysqldump` before; `mysql < dump.sql` on revert. Binary logs + `mysqlbinlog` for PITR.
* **SQLite** — copy the file before the migration; restore the copy.
* **DuckDB** — `COPY ... TO 'snapshot.parquet'` then `INSERT INTO ... FROM 'snapshot.parquet'`. Or just snapshot the database file.
* **MSSQL** — `BACKUP DATABASE` before; `RESTORE DATABASE` on revert. Built-in PITR via transaction logs.
* **Mongo** — `mongodump` before; `mongorestore` on revert. Atlas continuous backup gives PITR.

Wire one of those into your migration runbook so the rollback option is "schema rollback OR full restore", not "schema rollback OR live with the bug forever".

### Patterns that make data rollback cheaper

* **Soft-drop instead of hard-drop.** Before running a destructive `forge diff apply`, rename the column / table to a `_deprecated` suffix and leave it for a release cycle. You can read the data back if the rollback needs it; the real drop happens in a later cycle once you're sure.
* **CDC archive.** Stream every change (Debezium, Maxwell, Mongo change streams) into a long-retention store (S3, Kafka with infinite retention). On a bad migration, replay the CDC stream after the schema is reset.
* **Append-only audit table.** For columns where rollback recovery matters, write a mirror row to an audit table on every update. The audit table outlives the column drop and lets you reconstitute.

These are all app-layer patterns; forge doesn't ship them. The right place to choose one is the design review for the destructive migration itself, not the rollback runbook.

### The split, restated

| Concern | forge handles? | The realistic path |
|---|---|---|
| Undo `CREATE TABLE`, `CREATE INDEX`, `ADD COLUMN` | Yes — `forge rollback` | Same |
| Recover data that lived in a dropped column | No | Restore from backup taken before the up |
| Recover a dropped table | No (down is a comment) | Restore from backup; manually re-insert |
| Walk back a multi-step destructive sequence | One at a time | `forge rollback` N times, or restore from backup |
| Undo a botched data backfill (no DDL change) | No — DML isn't in the migration file | App-side compensating update, or restore |

If your rollback story depends on data coming back, the load-bearing tool is your backup. forge gets you the schema; the backup gets you the rows. See **[BACKUP-RESTORE.md](./BACKUP-RESTORE.md)** for per-dialect backup recipes and PITR setup.

---

## CI rollback pattern

The same CD pipeline that ran `forge push` / `forge diff apply` on deploy should have a rollback path. The pattern below is GitHub Actions; the shape ports to GitLab CI, CircleCI, Jenkins.

### Manual-trigger rollback workflow

```yaml
# .github/workflows/rollback.yml
name: Schema rollback
on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [staging, production]
        required: true
      confirm:
        description: 'Type the migration slug you expect to be rolled back'
        required: true

jobs:
  rollback:
    runs-on: ubuntu-latest
    environment: ${{ inputs.environment }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci

      - name: Show what would be rolled back
        id: peek
        run: |
          slug=$(npx tsx -e "
            import { createDb, raw } from 'forge-orm';
            const db = await createDb({ url: process.env.DATABASE_URL });
            const rows = await db.\$queryRaw(raw\`SELECT name FROM _forge_migrations ORDER BY name DESC LIMIT 1\`);
            console.log(rows[0]?.name ?? '');
            await db.\$disconnect();
          ")
          echo "slug=$slug" >> $GITHUB_OUTPUT

      - name: Verify confirmation matches
        run: |
          if [ "${{ inputs.confirm }}" != "${{ steps.peek.outputs.slug }}" ]; then
            echo "Confirmation '${{ inputs.confirm }}' does not match latest migration '${{ steps.peek.outputs.slug }}'"
            echo "Refusing to roll back."
            exit 1
          fi

      - name: Backup before rollback
        run: ./scripts/backup-db.sh $DATABASE_URL ./pre-rollback.dump

      - name: Upload backup artifact
        uses: actions/upload-artifact@v4
        with:
          name: pre-rollback-${{ inputs.environment }}-${{ steps.peek.outputs.slug }}
          path: ./pre-rollback.dump

      - name: Run rollback
        run: npx forge rollback

      - name: Verify back in sync
        run: npx forge diff --check
```

Three properties matter:

1. **Manual trigger.** Schema rollback is consequential — never auto-triggered. The `workflow_dispatch` gate forces an operator to start it.
2. **Confirm-the-slug guard.** The operator has to type the exact migration slug they expect to be rolled back. If a migration has been applied since they decided to roll back (a teammate ran `diff apply` 30 seconds before), the confirmation mismatches and the workflow refuses. Prevents the "wrong migration rolled back" failure mode.
3. **Backup before rollback.** Always. The artifact survives the workflow so you can restore from it if the rollback itself was wrong.

### Auto-rollback on failed deploy

If your deploy pipeline has a post-deploy smoke test and a rollback path for app code (e.g. promote previous container revision), the schema rollback should be wired in *alongside* the app rollback, not after it:

```yaml
# Part of deploy.yml
- name: Deploy app
  id: deploy
  run: ./scripts/deploy.sh

- name: Run smoke tests
  id: smoke
  run: ./scripts/smoke.sh
  continue-on-error: true

- name: Rollback app on smoke failure
  if: steps.smoke.outcome == 'failure'
  run: ./scripts/rollback-app.sh

- name: Rollback schema on smoke failure
  if: steps.smoke.outcome == 'failure'
  run: |
    # Only roll back the schema if the deploy applied a migration
    # (i.e. _forge_migrations has a row whose applied_at is after deploy start)
    deploy_start='${{ steps.deploy.outputs.started_at }}'
    npx tsx scripts/rollback-if-recent.ts "$deploy_start"

- name: Fail the workflow
  if: steps.smoke.outcome == 'failure'
  run: exit 1
```

```ts
// scripts/rollback-if-recent.ts
import { createDb, raw } from 'forge-orm';
import { execSync } from 'child_process';

const since = process.argv[2];
if (!since) { console.error('usage: rollback-if-recent.ts <iso-timestamp>'); process.exit(1); }

const db = await createDb({ url: process.env.DATABASE_URL! });
const rows = await db.$queryRaw<{ name: string; applied_at: string }>(
  raw`SELECT name, applied_at FROM _forge_migrations WHERE applied_at >= ${since} ORDER BY applied_at DESC`,
);
await db.$disconnect();

if (rows.length === 0) {
  console.log('[auto-rollback] no migrations since deploy start; nothing to roll back');
  process.exit(0);
}

console.log(`[auto-rollback] rolling back ${rows.length} migration(s):`, rows.map(r => r.name));
for (let i = 0; i < rows.length; i++) {
  execSync('npx forge rollback', { stdio: 'inherit' });
}
```

The guard ("only roll back migrations applied since deploy start") is what stops auto-rollback from walking history further than intended. Without it, a smoke failure caused by a totally unrelated issue (Redis down, external API timeout) could roll back every migration ever applied. The timestamp guard scopes the rollback to "what *this* deploy did".

Auto-rollback is dangerous; gate it carefully. For most teams, manual rollback with the confirm-the-slug guard is the safer default.

---

## Distributed rollback — multi-region and sharded

Single-DB rollback is `forge rollback`. Distributed rollback is `forge rollback` per shard, with coordination.

### Multi-region (read replicas, fan-out writes)

If you write to one primary and replicate to N read replicas:

* **Roll back the primary.** Replication will pick up the down block as DDL and apply it on replicas in order.
* **Don't roll back replicas independently.** They'll diverge from the primary and the next replicated write will fail. Replicas follow the primary; the primary is the source of truth.
* **Watch the replication lag.** Until lag drains, replicas still have the post-up shape. Reads against replicas during the rollback window see the to-be-removed columns. App code should tolerate that (forward-only fix on the read path: ignore the column gracefully).

### Sharded — DB-per-tenant

If each tenant has its own database, every tenant database has its own `_forge_migrations` table and its own `migrations/` directory (typically the same directory, applied in lockstep). Rollback per tenant:

```ts
// scripts/rollback-all-tenants.ts
import { execSync } from 'child_process';

const tenants = await fetch(`${process.env.CONTROL_API}/tenants`, {
  headers: { Authorization: `Bearer ${process.env.CONTROL_TOKEN}` },
}).then(r => r.json());

const failures: string[] = [];
const skipped: string[] = [];

for (const t of tenants) {
  try {
    const out = execSync('npx forge rollback', {
      env: { ...process.env, DATABASE_URL: t.database_url },
    }).toString();
    if (out.includes('no migrations to roll back')) {
      skipped.push(t.slug);
    } else {
      console.log(`✓ ${t.slug}`);
    }
  } catch (err) {
    failures.push(t.slug);
    console.error(`✗ ${t.slug}: ${(err as Error).message}`);
  }
}

console.log(`\n${tenants.length} tenants total: ${tenants.length - failures.length - skipped.length} rolled back, ${skipped.length} skipped (no migrations), ${failures.length} failed`);
if (failures.length) process.exit(2);
```

Two failure modes to plan for:

* **Partial rollback across the fleet** — some tenants rolled back, some failed mid-down (MySQL / SQLite), some haven't been touched yet. Without recovery tooling you're left in a heterogeneous state. The realistic answer is to fail hard on the first error and surface the failed tenants, not silently continue. Re-run after fixing.
* **The migration was applied to some tenants but not others** — common when the previous deploy was itself partial. `forge rollback` against tenants that don't have the migration in their ledger is a no-op ("no migrations to roll back"); the script above already handles this.

### Sharded — table-sharded (Vitess / Citus)

If the data is sharded across N nodes of one logical database, the DDL is run by the orchestrator (vtctld, Citus coordinator). `forge rollback` runs against the coordinator URL; the orchestrator fans out the down block. forge has no special handling for these systems — it relies on the orchestrator to handle the fan-out correctly.

In practice this means:

* Test the rollback against a staging Vitess / Citus cluster before running it on prod.
* Some operations the orchestrator splits into many sub-operations (DROP COLUMN on a sharded table = DROP COLUMN on each shard, often with lock holds). Account for the wall-clock time.

### Multi-master / Galera / Patroni

Generally one node is the writer (Galera with `wsrep_OSU_method = TOI`, Patroni with leader-only writes). `forge rollback` against the writer. The cluster propagates. If your topology supports multi-writer DDL, don't. Two `forge rollback` invocations against two writers will produce different `_forge_migrations` states and you'll have to reconcile by hand.

---

## Emergency procedures — full restore from backup

When `forge rollback` isn't enough — data is gone, the migration was wrong, replication is diverged, you can't safely roll forward — the answer is full restore from a backup taken before the migration.

### Pre-conditions

* A backup taken *before* the migration was applied. If your backup cadence is daily and the migration ran 6 hours ago, you'll lose 6 hours of writes on restore. Plan backup frequency around your tolerance for that.
* PITR (point-in-time recovery) enabled. Lets you roll forward from the backup to seconds before the migration. PG: WAL archiving + `recovery_target_time`. MySQL: binary logs + `mysqlbinlog`. MSSQL: transaction log backups. Without PITR, restore loses everything since the backup.
* A runbook the on-call has *read* before being paged. Practicing restore on a staging clone every quarter is the cheapest insurance you can buy.

### The shape of a restore

1. **Stop writes.** Route the app away from the prod DB. Read-only mode, maintenance page, or scale the writer to zero. Whatever fits your stack.
2. **Snapshot the bad state.** Before restoring, dump the current DB to a side location. If the restore goes wrong, you have the bad state to inspect or piecewise-extract from.
3. **Restore.** PG: `pg_restore -d new_db backup.dump` then `recovery_target_time = '...'`. MySQL: `mysql < backup.sql` then replay binlog. MSSQL: `RESTORE DATABASE` then `RESTORE LOG`. Mongo: `mongorestore --oplogReplay`.
4. **Reconcile `_forge_migrations`.** If the restore puts you *before* the bad migration was applied, the ledger row for it is gone (good). The migration file is still on disk; if you don't want to re-apply it, *delete the file* or `git revert` the schema change that prompted it. Don't leave a file behind whose up block would re-introduce the problem on the next `forge diff apply`.
5. **Restart writes.** Verify with `forge diff --check`. Should be in sync.
6. **Reconcile data.** Anything written after the backup point and before the restore is gone. If you streamed CDC to a side store, replay the deltas. Otherwise communicate the data-loss window to users and operations.

### When restore is the right call

* `forge rollback` failed mid-down and the DB is in a broken state you can't fix forward.
* The migration corrupted data (e.g. a bad UPDATE in a `forge diff apply` migration that mixed DDL and DML).
* You discovered the bad migration days later, after writes have accumulated against the wrong shape. Rolling back loses real data either way; restore gives you a coherent prior state.
* Cluster has diverged across shards / replicas in a way that's hard to reconcile.

### When restore is wrong

* The migration is fine, the app is bad. Roll the app back; leave the DB alone.
* The data loss from restore (writes between backup and now) is worse than living with the bad migration. Forward-only fix.
* You don't have a backup from before the migration. Restoring an even-older backup loses more, not less.

This is a destructive operation. Two senior engineers in the room, written runbook, recorded session. If you're solo on-call at 3 AM, escalate before restoring.

---

## Three worked rollbacks

### (a) Rolling back a botched column add

You ran `forge diff apply` to add `users.preferences JSONB`. The default expression you set is wrong (`'{}'::json` instead of `'{}'::jsonb`) and every write is failing with a type error. The migration applied 4 minutes ago.

```sh
# 1. Stop the bleeding — turn off the write path that touches preferences.
#    (Feature flag, env var — depends on your stack.)
curl -X POST https://flags.internal/flags/user_preferences -d '{"enabled":false}'

# 2. Look at what's in the ledger
psql $DATABASE_URL -c "SELECT name, applied_at FROM _forge_migrations ORDER BY applied_at DESC LIMIT 3"
#         name              |        applied_at
# --------------------------+--------------------------
#  20260624T143052_drift    | 2026-06-24T14:30:52.413Z
#  20260620T091200_drift    | 2026-06-20T09:12:01.114Z

# 3. Look at the migration file before rolling back
cat migrations/20260624T143052_drift.sql
# -- up
# ALTER TABLE "users" ADD COLUMN "preferences" JSONB DEFAULT '{}'::json;
# -- down
# ALTER TABLE "users" DROP COLUMN "preferences";

# 4. Confirm: nobody wrote real data to preferences yet (write path was failing)
psql $DATABASE_URL -c "SELECT COUNT(*) FROM users WHERE preferences IS NOT NULL"
#  count
# -------
#      0

# 5. Roll back
npx forge rollback
# [forge:rollback] rolling back '20260624T143052_drift' (1 statement(s))
# [forge:rollback] rolled back '20260624T143052_drift'.

# 6. Verify in sync
npx forge diff --check
# ✓ no drift

# 7. Fix the schema, re-apply
#    (in schema.ts: f.json({ default: () => ({}) }))
git add src/schema.ts
git commit -m "Fix users.preferences default cast"
npx forge diff apply
# 1 change: add users.preferences
# [forge:diff:apply] applied.

# 8. Re-enable the write path
curl -X POST https://flags.internal/flags/user_preferences -d '{"enabled":true}'
```

The rollback took 6 minutes door-to-door including the fix. Snapshot rollback is appropriate here because (a) the migration just applied, (b) no real data was written, (c) the write path was already broken so the rollback doesn't make anything worse.

### (b) Rolling back an index that locked the DB

You added a `CREATE INDEX` on a large table without `CONCURRENTLY`. The index build is holding an `AccessExclusiveLock`; reads are queueing; the app is timing out. You need the index gone.

```sh
# 1. The migration is still running — you can see the lock in pg_stat_activity
psql $DATABASE_URL -c "
  SELECT pid, state, query_start, query
  FROM pg_stat_activity
  WHERE query LIKE 'CREATE INDEX%' AND state = 'active'"

# 2. Cancel the running CREATE INDEX
psql $DATABASE_URL -c "SELECT pg_cancel_backend(<pid>);"
#    (or pg_terminate_backend if cancel doesn't take)

# 3. Check what landed in the ledger.
#    forge diff apply records the row at the END of the up block,
#    so a cancelled CREATE INDEX *probably* didn't record. Verify:
psql $DATABASE_URL -c "SELECT name FROM _forge_migrations ORDER BY name DESC LIMIT 1"
#   → if it shows the migration → the row recorded, rollback path applies
#   → if it doesn't → the migration died mid-apply; no rollback needed,
#                     just check if the index partially exists:
#                     SELECT * FROM pg_indexes WHERE indexname = '<name>';
#                     If yes, drop it manually. If no, you're already clean.

# 4. If the row recorded, the down block will drop the index. Run it:
npx forge rollback
# [forge:rollback] rolling back '20260624T144500_drift' (1 statement(s))
# [forge:rollback] rolled back '20260624T144500_drift'.

# 5. Fix the schema to use the right index method, redeploy with CONCURRENTLY-equivalent timing.
#    forge does not emit CONCURRENTLY (it'd break inside the transaction wrapper),
#    so the fix is to deploy off-hours OR run the CREATE INDEX CONCURRENTLY manually
#    and let the next forge push detect-and-skip it.
psql $DATABASE_URL -c "CREATE INDEX CONCURRENTLY idx_events_userid_createdat ON events (user_id, created_at);"
npx forge diff --check
# ✓ no drift — the differ saw the index already exists and recorded it.
```

The pattern here is "rollback removed the bad state; CONCURRENTLY out-of-band created the right state; `forge push` would have done the same thing but with the lock". This is one of the cases where the operator outsmarts the differ — totally fine, the differ will recognise the index next time.

### (c) Blue/green flip — no DDL rollback at all

You renamed `users.username` → `users.handle` using the four-step pattern from [MIGRATIONS.md → Blue/green](./MIGRATIONS.md#bluegreen-schema-rollouts). You're on deploy 3 — app code now reads `handle`. Bug report: a downstream service still depends on `username` and is failing.

There is no schema to roll back. The schema still has `username` (you haven't done deploy 4 yet). The fix is:

```sh
# 1. Roll back the app deploy that flipped the read path
#    (containers, k8s, blue/green CDN — depends on stack)
kubectl rollout undo deployment/app -n prod

# 2. Verify reads are back on username
curl -s https://app/api/users/me | jq '.username'
#   → previous behaviour restored

# 3. Decide: fix downstream to read handle, then redeploy step 3.
#    OR: pause at step 2 indefinitely (both columns present + populated)
#    until downstream is fixed.
```

The blue/green paradigm pays off here — the DB still has both columns, so an app rollback doesn't need a DB rollback. The cost was that you carried both columns for a release cycle; the benefit is the recovery cost was zero DDL.

The four-step pattern is specifically designed so each step is independently rollback-able by reverting only the app deploy. The DB only changes destructively at step 4, and by then steps 1-3 have proved the new shape works.

---

## Cross-references

* **[MIGRATIONS.md](./MIGRATIONS.md)** — the forward path. `forge push`, `forge diff`, `forge diff apply`, drift detection rules. Read first if you haven't.
* **[MIGRATIONS.md → Per-dialect rollback fidelity](./MIGRATIONS.md#per-dialect-rollback-fidelity)** — the canonical table. This file's [Per-dialect rollback gotchas](#per-dialect-rollback-gotchas) cross-cuts the same data with more crash-recovery detail.
* **[MIGRATIONS.md → Blue/green schema rollouts](./MIGRATIONS.md#bluegreen-schema-rollouts)** — the four-step rename pattern. The cheapest rollback is one you don't need to take.
* **[MIGRATIONS.md → Data migration vs DDL migration](./MIGRATIONS.md#data-migration-vs-ddl-migration)** — why `forge diff apply` doesn't mix DML, and how to write idempotent data migrations alongside.
* **[BROWSER.md → `db.$migrate()`](./BROWSER.md#dbmigrate--runtime-ddl-apply--drift-detection)** — runtime rollback equivalent for sqlite-wasm. There is no `db.$rollback()`; rollback in the browser is "wipe the OPFS DB and re-migrate from the schema". The `report.pending` field surfaces destructive drift the runtime declined to apply.
* **[DRIVERS.md](./DRIVERS.md)** — per-driver caveats relevant to transactional DDL behaviour during rollback.
* **BACKUP-RESTORE.md** — per-dialect backup recipes, PITR setup, restore runbooks. The realistic data-rollback path.
* **DEPLOYMENT.md** — CI/CD patterns end to end. The CI rollback section here is the rollback half of the deploy story documented there.

The short version of everything above: forge rollback is a small, sharp tool for a narrow window. Snapshot rollback handles "we just applied and want to take it back". Forward-only handles "we applied a while ago and need to fix it". Blue/green handles "we knew the change was risky and built in a flip switch". For data loss, the load-bearing tool is your backup. Pick the paradigm that fits the situation; the schema declaration plus the migrations directory plus the `_forge_migrations` ledger is everything forge gives you to support that choice.
