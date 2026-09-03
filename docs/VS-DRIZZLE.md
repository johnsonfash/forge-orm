# forge vs drizzle — where the gap actually is

Written 2026-09-03, prompted by a critique of forge that was partly
right, partly wrong, and wrong in an interesting way.

The critique said:

> Migrations. This is the big one. drizzle-kit generates real, readable
> SQL migration files with a history you can review, edit and roll back.
> forge's push only reconciles indexes — it doesn't create, alter or drop
> tables.

**Half of that is false.** `forge push` reconciles indexes only — true,
and deliberately so. But `push` is not forge's migration command.
`forge diff apply` is, and it already:

- generates timestamped `up` / `down` `.sql` files into `migrations/`
- records applied migrations in a portable `_forge_migrations` table
- emits `CREATE TABLE`, `DROP TABLE`, `ADD COLUMN`, `DROP COLUMN`,
  `ADD/DROP CONSTRAINT … FOREIGN KEY`, and index DDL
- rolls back the most recent migration with `forge rollback`

So "readable SQL files with a history you can review and roll back" is a
description of something forge already has. Repeating the critique
unchecked would have sent us building it twice.

What is *actually* missing is narrower, and more important than the list
above. It is one architectural decision and three consequences.

---

## The real gap: forge diffs the DATABASE, drizzle diffs the LAST SNAPSHOT

`drizzle-kit generate` reads your schema, builds a JSON snapshot, compares
it to the snapshot stored beside the previous migration, and writes the
difference as SQL. Two artifacts come out: a numbered `.sql` and a
`meta/000N_snapshot.json`. A `meta/_journal.json` orders them.

`forge diff apply` connects to `DATABASE_URL`, introspects the live
database, and diffs the schema against **what is there right now**.

That single difference produces everything else:

### 1. Forge cannot generate a migration without a database

`diff-apply.ts` exits immediately without `DATABASE_URL`. So:

- CI cannot produce or verify a migration
- a developer on a plane cannot add a column
- a reviewer cannot regenerate the migration to check it matches the
  schema change in the same PR

Drizzle generates offline, deterministically. The same schema always
yields the same SQL.

### 2. Two developers on two branches generate against different worlds

Alice adds a column on Monday against her local DB. Bob adds a different
one on Tuesday against his. Each migration is correct relative to the
database it was generated from and neither is correct relative to the
merge. With snapshots, both diff against the *same committed ancestor*,
so the conflict shows up in the snapshot file — in review, as a merge
conflict, which is where you want it.

Drizzle has its own version of this failure and it is worth knowing
about: if a migration generated Monday reaches production *after* one
generated Friday, `migrate` skips the Monday file silently, because its
journal entry is behind what the database already recorded. Snapshots fix
generation, not ordering. **Neither tool solves ordering.**

### 3. A rename is indistinguishable from a drop and an add

With no prior schema to compare intent against, `oldName` gone +
`newName` present is a `DROP COLUMN` and an `ADD COLUMN` — which is data
loss, silently, on a column somebody renamed.

Drizzle prompts interactively: *"is `full_name` a rename of `name`, or a
new column?"* It gets this wrong in known ways — renaming **and**
changing a type in one step emits only the rename ([#5499][5499],
[#3826][3826]) — but the prompt is the right shape, and forge does not
ask at all.

---

## The other genuine gaps

### `ALTER COLUMN` — type and nullability changes

`migrate-gen.ts` handles add, drop, tables, FKs and indexes. It does
**not** emit a type change or a nullability change. On Mongo that is
nothing; on SQL it is one of the three things you actually need. Today
such a change is silently absent from the generated migration, which is
worse than refusing.

### No custom / data migrations

Drizzle has `drizzle-kit generate --custom` for an empty file you fill in
yourself — backfills, a `NOT NULL` that needs its NULLs cleaned first,
anything the differ cannot infer. Forge has no equivalent, so the moment
a schema change needs a data step, the whole workflow is abandoned and
someone writes SQL by hand outside the ledger.

### Battle-testing

This is real and there is no clever answer to it. The two bugs found in
forge on 2026-09-03 — an index key that indexed a field that does not
exist, and `--help` executing the command — are what a library looks like
before thousands of users have hit it. Both were silent. That is the
category that matters: not "it crashed", but "it reported success and did
nothing".

The mitigation is not "get more users". It is to make the silent classes
impossible, which is what §"Rules" below is for.

### SQL transparency

Fair, and partly a deliberate trade. Drizzle is SQL-shaped, so what you
write maps to what runs. Forge is Prisma-shaped across six dialects,
which is the entire point of it — and the cost is a layer between the
query and the SQL. The answer is not to become SQL-shaped. It is to make
the generated SQL trivially visible (see R5).

---

## What forge has that drizzle does not

Worth stating, because a plan that only closes gaps ends up building a
worse drizzle.

- **Six dialects from one schema** — Mongo, Postgres, MySQL, SQLite,
  DuckDB, MSSQL. Drizzle is SQL-only. Mongo support is not a rounding
  error here: it is the reason a schema can move between a document store
  and a relational one without rewriting the data layer.
- **One code path, no codegen.** No generate step to forget, no
  `.drizzle` directory drift, no stale client.
- **`doctor`** — nothing comparable in drizzle-kit. Schema linting,
  live capability probes, dialect-mismatch warnings.
- **A Prisma-shaped API** that people already know.
- **Runtime concerns in the box** — soft delete, audit, encryption,
  multi-tenancy, caching, streaming, geo, vectors. Drizzle sends you to
  the ecosystem for most of these.

---

## The plan

Ordered by (damage prevented) ÷ (effort). Each stage stands alone —
none of them requires the next.

### Stage 1 — snapshots (the foundation)

**Write a JSON snapshot beside every generated migration**, and generate
against the previous snapshot instead of the live database.

```
migrations/
  meta/
    _journal.json           ordering + applied state
    0001_snapshot.json      full schema shape at that point
    0002_snapshot.json
  0001_add_appointments.sql
  0002_add_org_index.sql
```

Forge already builds the structure this needs: `diff-core.ts` compares an
`ExpectedSchema` (from the schema file) against a `DbIntrospection` (from
the database). A snapshot is simply a **serialised `DbIntrospection`**, so
the comparison code does not change at all — only where the "actual" side
comes from.

That is the whole trick, and it is why this is a smaller job than it
looks. Keep `--from-db` as an escape hatch for adopting an existing
database.

*Unlocks:* offline generation, CI verification, reviewable diffs,
deterministic output. Everything below depends on it.

### Stage 2 — `ALTER COLUMN`

Type changes and nullability, per dialect, with the unsafe ones refused
rather than emitted:

- widening (`VARCHAR(64)` → `VARCHAR(255)`, `int` → `bigint`) — emit
- narrowing, or a type change that can lose data — **refuse**, and print
  the two-step migration to write by hand
- `NULL` → `NOT NULL` — refuse unless a `DEFAULT` is supplied or the
  column is provably empty, because it fails on live data anyway

Refusing loudly is the whole feature. The current behaviour — silently
omitting the change — is the worst of the three options.

### Stage 3 — rename detection

With snapshots this becomes possible: a column present in the old
snapshot and absent from the new, alongside a new column of the same
type, is a rename candidate.

- **Ask**, in an interactive terminal
- **Refuse** in CI (`--no-interactive`), with the fix printed:
  `f.string().renamedFrom('old_name')`
- Prefer the **explicit annotation** over the prompt. A prompt answered
  once at 2am is not a record; the annotation is in the schema, in the
  diff, in review.

Learn from drizzle's bug here: when a column is renamed **and** changed,
emit both statements or refuse. Never silently emit one.

### Stage 4 — custom and data migrations

```bash
npx forge migrate new backfill-org-slugs   # empty up/down, in the ledger
```

Nothing more is needed. The value is that the file lives in the same
ordered history as the generated ones, so a backfill cannot get lost
between two schema changes.

### Stage 5 — `forge migrate status` and a CI gate

```bash
npx forge migrate status   # applied, pending, and any file the DB has
                           # but this checkout does not
npx forge diff --check     # already exists — exit 3 on drift
```

The third case is the one that bites: a migration applied to the database
from a branch that was never merged. Neither drizzle nor forge reports it
today.

### Stage 6 — a SQL preview for queries

Not a migration feature, but the honest answer to "SQL transparency":

```ts
db.$explain(() => db.user.findMany({ where: { … } }));
// → the SQL and parameters, without running it
```

Cheaper than becoming SQL-shaped and answers the same need — reason about
it, optimise it, hand it to a DBA.

---

## Rules — how forge stays better than drizzle while staying simple

The gaps above are a to-do list. These are the constraints that keep
closing them from turning forge into a worse copy of something else.

**R1. Simple by default, explicit when it matters.**
`push` for local iteration, `diff apply` for anything a second person
will see. A beginner should not meet snapshots on day one; a team should
not be able to avoid them. Drizzle gets this right with push/generate and
so should we.

**R2. A silent success is a bug of the highest severity.**
Both 2.8.0 bugs were silent. An index that indexes nothing while
reporting `created`. A `--help` that performs the action. Every code path
that can do nothing must either do the thing or say it did not. When in
doubt, refuse — an error costs a minute, a silent no-op costs a quarter.

**R3. Refuse rather than guess, and print the fix.**
Narrowing a type, dropping a column with data, a rename in CI. The
message must contain the correction, not just the complaint. `forge`
already does this well (`Did you mean 'lte'? forge uses bare operator
names`); hold that bar everywhere.

**R4. The schema is the source of truth; the database is an observation.**
This is Stage 1 restated as a principle. Anything that requires a live
database to produce a *reviewable artifact* is a design smell.

**R5. Every generated statement must be readable before it runs.**
`diff apply` should print the SQL and require confirmation outside CI.
Transparency is a property of the output, not of the API shape — which is
how forge keeps a Prisma-shaped surface without being a black box.

**R6. One schema, six dialects — never fork the mental model.**
If a feature cannot be expressed portably, it takes a dialect-specific
option with a doctor warning on the others (as `bigserial` and
`partialFilterExpression` already do). It never becomes a second way to
write a schema.

**R7. Every bug found in the wild becomes a test that would have caught
it, in the same commit.**
Not a note, not a changelog line. `mongo-id-index-key.spec.ts` and
`doctor-lint-accuracy.spec.ts` exist because of this rule. It is the only
substitute for a thousand users that actually works.

**R8. No codegen, ever.**
It is forge's clearest advantage over Prisma and a real one over
drizzle-kit's generate step. Snapshots are build *artifacts*, not
generated *source* — nothing imports them.

---

## Honest summary

| | forge | drizzle |
|---|---|---|
| Migration files with up/down | ✅ | ✅ |
| Applied-migration ledger | ✅ | ✅ |
| Rollback | ✅ | ⚠️ manual reverse |
| Generate offline / in CI | ❌ **needs a live DB** | ✅ |
| Deterministic, reviewable diff | ❌ | ✅ |
| Rename detection | ❌ | ⚠️ prompt, buggy with type changes |
| `ALTER COLUMN` type / nullability | ❌ | ✅ |
| Custom / data migrations | ❌ | ✅ |
| Mongo | ✅ | ❌ |
| Six dialects, one schema | ✅ | SQL only |
| Schema linting (`doctor`) | ✅ | ❌ |
| No codegen step | ✅ | ❌ |
| Battle-tested | ❌ | ✅ |

**Stage 1 closes four of the five red rows.** It is the only one that
matters this quarter.

[5499]: https://github.com/drizzle-team/drizzle-orm/issues/5499
[3826]: https://github.com/drizzle-team/drizzle-orm/issues/3826
