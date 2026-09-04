---
title: "I picked MongoDB on day one. By month eight I needed Postgres."
published: false
description: "Why I stopped letting the first week of a project decide the next three years — and built a query API that runs on six databases without a codegen step."
tags: typescript, database, node, webdev
series: "forge-orm: one API, six databases"
cover_image: ""
---

The decision took about nine minutes.

It was the start of a new product — Dallio, a business-management app for
small retailers in Lagos. Point of sale, inventory, invoices, the lot. I
needed a database, I had a schema roughly in my head, and MongoDB let me
start writing code that afternoon instead of arguing with migrations. Nine
minutes. `createdb`, connection string, first model, move on.

That decision was fine for about eight months.

Then a client asked a question I couldn't answer: *"Which of my three
branches actually makes money on Tuesdays?"*

It's not an exotic question. It's a `GROUP BY` with a couple of joins and a
window function. On Postgres it's ten lines. On Mongo it was an aggregation
pipeline I rewrote four times, got working, and then couldn't read a week
later. I remember staring at a `$lookup` inside a `$facet` and thinking:
**I chose this in nine minutes, and now I'm stuck with it.**

The obvious move was to add Postgres for reporting. Keep Mongo for the
operational stuff, pipe the analytics somewhere that likes analytics. Sensible.
Boring. Standard.

Except that meant two data layers. Two sets of models. Two mental models. And
every helper I'd written — soft delete, tenant scoping, audit logging — needed
a second implementation that behaved *almost* the same.

## What I actually wanted

I wanted to write this:

```ts
const rows = await db.sale.findMany({
  where: { locationId, postedAt: { gte: start } },
  include: { customer: true },
});
```

…and have it not care which database was underneath.

Not "abstract away SQL." Not "one query language to rule them all." Just:
**the ordinary 90% of queries should be portable, and the other 10% should
drop to raw SQL without ceremony.**

I looked at what existed.

**Prisma** has the API shape I wanted. But it's a code generation step. Every
schema change means `prisma generate`, a regenerated client committed or
gitignored, a Rust query engine binary in your deploy, and a real fight to run
in a browser or on React Native. I've watched a teammate lose an afternoon to a
stale generated client that *looked* fine.

**Drizzle** is excellent and I nearly used it. But it's SQL-shaped by design —
which is the right call for a SQL-only tool, and the wrong one when one of my
six targets is MongoDB.

**TypeORM** and friends: decorators, metadata, a lot of machinery.

None of them ran in a browser tab. That mattered more than I expected, and I'll
come back to it in a later post.

So I did the thing you're not supposed to do. I wrote my own.

## forge-orm

It's a small, Prisma-shaped data layer for **MongoDB, PostgreSQL, MySQL,
SQLite, DuckDB and SQL Server**. You write models once in plain TypeScript and
the same query code runs against any of them.

```sh
npm install forge-orm
npm install pg          # only the driver you actually use
```

```ts
import { createDb, f, model } from 'forge-orm';

const User = model('users', {
  id:    f.id(),
  email: f.string().unique(),
  name:  f.string(),
  age:   f.int().optional(),
});

const db = await createDb({
  url: process.env.DATABASE_URL!,   // postgres:// … | mongodb:// … | sqlite: …
  schema: { user: User },
});

const adults = await db.user.findMany({
  where:   { age: { gte: 18 } },
  orderBy: { name: 'asc' },
  take:    20,
});
```

`adults` is fully typed. There was no build step. There is no generated client
in your repo. Change the model, and the types change on the next keystroke —
because they're inferred from the object you just wrote, not produced by a
tool you have to remember to run.

Point `DATABASE_URL` at Mongo instead and that same `findMany` runs as a Mongo
`find`. Point it at SQLite and it's a `SELECT`. The query code doesn't move.

## The part I didn't expect to matter

forge ships **no database driver of its own**. Each one is an optional peer
dependency, so `npm install forge-orm` pulls nothing extra, and importing forge
needs no driver at all.

| Database | URL starts with | Install |
|---|---|---|
| PostgreSQL | `postgres://` | `npm install pg` |
| MySQL / MariaDB | `mysql://` | `npm install mysql2` |
| SQLite | `sqlite:` or `file:` | `npm install better-sqlite3` |
| MongoDB | `mongodb://` | `npm install mongodb` |
| DuckDB | `duckdb:` | `npm install @duckdb/node-api` |
| SQL Server | `mssql:` | `npm install mssql` |

That sounds like packaging trivia. It turned out to be the thing that let forge
run in places an ORM normally can't — a browser tab, an Expo app, an embedded
Postgres compiled to WebAssembly. Those posts are coming.

## What it is not

I want to be straight about this, because I've been burned by READMEs that
weren't.

forge is **not** a replacement for Prisma or Drizzle in maturity. It has fewer
features, a much smaller ecosystem, and no GUI. Prisma's migration tooling is
more battle-tested than mine. Drizzle's SQL surface is broader. If you need
either of those things, use them — genuinely.

What forge gives you is a small dependency you can read in an afternoon, one
query API across six databases, full autocomplete with nothing to regenerate,
and the ability to drop to raw SQL whenever the abstraction stops helping:

```ts
const rows = await db.$queryRaw`
  SELECT location_id, SUM(total) AS revenue
  FROM sales WHERE posted_at >= ${start}
  GROUP BY location_id
`;
```

That escape hatch is not an admission of failure. It's the point. An ORM that
tries to own every query eventually owns the ones it's bad at.

## Did it actually solve the problem?

Dallio still runs on MongoDB. The analytics moved to a Postgres read model.
Both go through the same `db.<model>.findMany` calls, the same models, the same
soft-delete and tenant-scoping helpers. The report that started all this is
about fifteen lines now.

And the nine-minute decision stopped being permanent, which is really all I
wanted.

---

**Next in this series:** the codegen step — why `prisma generate` exists, what
it's actually solving, and how you get the same autocomplete without it.

📖 Docs: **[johnsonfash.github.io/forge-orm](https://johnsonfash.github.io/forge-orm/)**
📦 npm: **[forge-orm](https://www.npmjs.com/package/forge-orm)**
⭐ GitHub: **[johnsonfash/forge-orm](https://github.com/johnsonfash/forge-orm)**

If you've been stuck with a day-one database decision, I'd genuinely like to
hear what it was. That's half of why I wrote this.
