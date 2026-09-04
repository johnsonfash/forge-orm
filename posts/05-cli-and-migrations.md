---
title: "The column that existed on staging and not on production"
published: false
description: "The unglamorous half of an ORM: additive pushes, migrations generated without a database, the two migration states nobody reports, and why refusing to guess about your data is a feature."
tags: typescript, database, devops, node
series: "forge-orm: one API, six databases"
cover_image: ""
---

The deploy was green. Both jobs, both environments, nobody paged.

The column was on staging. It was not on production.

It had gone out in a pull request that also touched nine files of application
code, and the reviewer read the application code, because that's where the
interesting part was. The schema change was three words. The deploy step that
would have applied it never ran on production — somebody had moved that step a
year earlier, and nothing had needed it since.

Production found out at the first write, at eleven at night, and nobody could
tell me whether that invoice had saved.

Nothing about that is exotic. It's the ordinary failure mode of schema work,
and it has nothing to do with how nice your query API is. I spent months on
`findMany`. The thing that costs money is what happens the day you change a
column on a table that already has rows in it.

So: the unglamorous half.

## `forge push` — the boring one

```sh
npx forge push
# → [forge:push] applied 1, skipped 47, failures 0
```

It reads your schema, introspects the live database, brings the database
forward. Run it again and it does nothing — `applied 0, skipped 47`.

The important property is what it refuses to do. `push` will not drop a column
you removed from the schema, will not drop a table, will not change a column's
type, and will not rename anything. It's additive by construction, which is
what makes it safe to wire into a container's start command and stop thinking
about. Destructive operations live somewhere you have to look at them.

## `forge diff --check` — the gate

`diff` is the read-only sibling — introspect, compare, print, never write — so
CI can preview production with a read-only role.

```sh
npx forge diff --json          # a DriftReport for jq
npx forge diff --check         # exit 3 on drift
```

The exit codes matter more than they look. `--check` exits **3** for real drift
and **1** for "couldn't run at all": no `DATABASE_URL`, unreachable database,
schema didn't load. A job that fails identically on both trains everyone to
ignore it.

## `forge generate` — a migration with no database in the room

`forge diff apply` generates by introspecting `DATABASE_URL`. That's right for
adopting a database somebody else created, and wrong for everyday work. CI has
no database, so nothing can verify that a schema change arrived with its
migration. Two developers generate against two local worlds, each file correct
relative to a state that stops existing at the merge. And the same schema
doesn't reliably produce the same SQL, so a reviewer can't regenerate one to
check it against the change in the same pull request.

So `forge generate` diffs the schema against the **last committed snapshot**
and connects to nothing:

```sh
npx forge generate --name add-org-slug
```

```
migrations/
  meta/_journal.json          ordering
  meta/0002_snapshot.json     the schema's shape after 0002
  0002_add-org-slug.sql
```

A snapshot is what `introspect()` would return if this schema were applied.
Once that's a file, the differ doesn't care that it didn't come from a socket.

Which unlocks the check a database-backed generator cannot perform:

```sh
npx forge generate --check
```

```
[forge:generate] 1 change(s) are in the schema but not in any migration.
  - add orgs.region
```

Exit 3, in a pipeline with no database in it. Commit the `.sql` and its
snapshot together: the SQL says what will run, the snapshot says what the
schema will then be. One without the other is half a change.

## `forge migrate status` — the two states nobody reports

Everything above compares *intent* — your schema against a snapshot, or against
what a database reports. `migrate status` compares *reality*: the files in
`migrations/` against the rows in `_forge_migrations`. It's the one command
that genuinely needs `DATABASE_URL`, because a database is the only thing that
knows what it has run.

```
  ✓ 0002_add-org-slug.sql       2026-08-19T16:40:55Z
  ! 0003_alice-adds-note.sql    OUT OF ORDER — sorts before
                                0004_bob-adds-tier.sql, which is already applied
  · 0005_add-index.sql          pending
  ? 0006_from-a-branch.sql      NOT IN THIS CHECKOUT   applied 2026-09-02
```

Applied and pending, every migration tool shows. The other two are where
production goes wrong, and no tool I know of — drizzle-kit included — reports
either.

**OUT OF ORDER.** Alice generates `0007` on Monday. Bob generates `0008` on
Tuesday. Bob's merges first and ships. When Alice's merges, a migrator walking
forward from the highest applied entry steps over `0007` in silence. It is
never applied at all, and nothing ever says so. You find out a fortnight later,
as *"why is this column missing in staging"*. The fix is to delete the file and
its snapshot, pull, and regenerate — which also re-diffs it against the schema
as it now is, because `0007` was written against a world where `0008` hadn't
happened.

**NOT IN THIS CHECKOUT.** The database has applied a migration your folder
doesn't contain: somebody ran a branch against it. The schema in front of you
is not the schema that database has, so everything you generate from here is
built on a state you cannot see — correct against your snapshot, wrong against
that database.

```sh
npx forge migrate status --check   # exit 4
```

Exit 4 is distinct from `generate --check`'s 2 and 3, so a pipeline can say
which gate refused it. Point it at staging; an empty per-PR database has
nothing to disagree about.

## The two refusals

### A rename is not a drop and an add

Comparing two schema states shows only that one name is gone and another has
appeared. A rename and a drop-plus-add look identical from there, and they do
opposite things to the data: one keeps every row, the other deletes a column's
worth of it.

Guessing "drop and add" loses data on a column somebody meant to keep.
Guessing "rename" is worse — it keeps a column somebody meant to delete and
quietly moves its data under a new name. So forge takes the answer from the
schema:

```ts
name: f.string().renamedFrom('full_name'),
```

```sql
-- up
ALTER TABLE "orgs" RENAME COLUMN "full_name" TO "name";
```

Without the annotation, a same-typed drop-and-add on one table is refused,
naming both columns and printing the line to add. `--allow-drop` is how you say
*"it really is a drop, I mean to lose it"* — deliberately a flag and not a
prompt, so it lands in the shell history.

drizzle-kit asks this interactively. Right question, wrong medium: a prompt
answered once at 2am is recorded nowhere, cannot run in CI, and is invisible in
review. An annotation is in the schema, the diff and the pull request.

### A widening is emitted; a narrowing is refused

`varchar(64)` → `varchar(255)`, `int` → `bigint`, dropping `NOT NULL`: every
existing row still fits, so the statement cannot fail on data. Emitted — with a
`down` that says out loud that reversing it can fail on rows written since. A
file that says "rollback" without saying that is lying to whoever runs it at
3am.

Everything else is refused, with the migration to write instead:

```
✖ orgs.name: text → int
  orgs.name changes from text to int, which is not a widening — existing
  rows may not fit, or may not convert at all.
  → forge will not guess at this. Write it with `forge generate
    --custom`: add the new column, backfill it with whatever conversion
    is correct for YOUR data, verify, then drop the old one and rename.
```

Exit 2, and nothing is written — including the safe changes in the same diff.
A migration that applies cleanly while leaving the schema and the database
disagreeing is the failure this exists to remove, not a smaller version of it.
`NULL` → `NOT NULL` is refused too, and the message says why the obvious fix
doesn't work: a `DEFAULT` applies to new rows, not to the NULLs already there.

The refusal is the feature. A tool that emits `ALTER COLUMN … TYPE int`
against a column holding text is more dangerous than one that emits nothing,
because the migration *looks reviewed*.

And before any of it, `npx forge doctor` — driver inventory, a redacted
`DATABASE_URL` check, a schema lint, and a live probe that tells you `pg_trgm`
isn't installed before a GIN index tells you at deploy time.

## Two bugs, and one embarrassment

### The empty upsert

```ts
db.user.upsert({ where, create, update: {} })
```

The ordinary "insert if it isn't there, otherwise leave it alone" idiom — the
first thing anyone writes for an idempotent seed. It compiled to:

```sql
INSERT INTO "users" (…) VALUES (…) ON CONFLICT ("email") DO UPDATE SET  RETURNING *
```

`SET` with nothing after it. And because a parser blames the token *after* an
empty clause, every dialect reported `near "RETURNING": syntax error` —
pointing squarely at the one part of the statement that was fine.

An empty set now emits a column assigned to its own stored value: valid SQL,
provably no change, and `RETURNING` still yields the row, which upsert's
contract requires. `DO NOTHING` would have parsed and is the shorter fix, but it
returns no row on conflict — so `upsert` would have resolved to `undefined`
exactly when the record already existed. A silent wrong answer in place of a
loud syntax error is not a fix.

### The MySQL near-miss

This is the part that stayed with me.

MySQL rewrites each upsert assignment to `col = VALUES(col)` so the update
reuses the INSERT's values. Right for a real update. Catastrophic for the
no-op, because ``VALUES(`id`)`` is the id the INSERT *proposed*. On conflict
that would have silently replaced the existing row's primary key with a freshly
generated uuid, taking every foreign key that referenced it along with it.

No error. No failed statement. A row that still exists, under a new identity,
with its children pointing at nothing. On a table of invoices that isn't a bug
report, it's an incident. Caught before it shipped, by a hair.

### The examples that quietly rotted

Both were found by *running* an example rather than reading one — which is the
embarrassing bit. The examples lived in their own repository, pinned at
`^2.5.6` while the library reached 2.13.0, and three were broken. One by the
empty upsert above: a bug nothing caught for **eight releases**, because the
only code exercising that path sat where no CI was looking. They run against
the working tree now, on every push and pull request.

## The argument

Every refusal here has the same shape. forge is handed two possibilities that
look identical from where it stands, and picks neither.

A rename and a drop-plus-add. A widening and a narrowing. An empty update
clause and one that meant to change something. In each case a differ could have
guessed, been right most of the time, and been catastrophically wrong the rest
— and the wrongness would not surface as an error. It surfaces as an empty
column, a foreign key pointing nowhere, an upsert returning `undefined`, a
migration nothing ever applied.

That's the real measure of a data tool. Not the query API — everyone's is fine
now, they converged on roughly the same shape and it took me a while to admit
it. The measure is what a tool does at the boundary of its own knowledge.

An error costs you a minute. A silent wrong answer costs you a quarter, and you
don't find out which quarter until the accounting doesn't add up.

Refusing to guess is a feature. It's the only one in this post that matters
solely when everything else has already gone wrong — which is exactly when
you'll care about it.

## The series

Five posts, and I'm grateful to everyone who read past the first.

**Part 1** — *"I picked MongoDB on day one. By month eight I needed Postgres."*
The day-one database decision, and one API over six databases.

**Part 2** — *"The afternoon my teammate lost to a stale generated client."*
Inferred types instead of codegen, and `$explain`.

**Part 3** — the browser: the same `findMany` in a tab, against SQLite compiled
to WebAssembly.

**Part 4** — React Native, where every native module is a rebuild.

**Part 5** — this one. The work that keeps a schema honest.

📖 Docs: **[johnsonfash.github.io/forge-orm](https://johnsonfash.github.io/forge-orm/)**
📦 npm: **[forge-orm](https://www.npmjs.com/package/forge-orm)**
⭐ GitHub: **[johnsonfash/forge-orm](https://github.com/johnsonfash/forge-orm)**

Thank you for reading the whole thing — genuinely. One last question, and it's
the one I most want answered: what's the worst thing a migration has ever done
to your data, and did you find out from an error or from a customer?
