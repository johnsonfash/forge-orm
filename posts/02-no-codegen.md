---
title: "The afternoon my teammate lost to a stale generated client"
published: false
description: "prisma generate exists for a good reason. Here's what it buys, what it costs, and how forge-orm gets the same autocomplete by inferring types from the schema object instead."
tags: typescript, database, node, webdev
series: "forge-orm: one API, six databases"
cover_image: ""
---

Someone on my team once spent most of a Thursday convinced I had broken the
build.

He'd pulled a branch where I'd renamed a column. Nothing exotic: `phone`
became `phoneNumber`, one line in the schema file, one migration. He pulled,
ran the app, and started wiring up the settings form. Autocomplete offered him
`phone`. He used `phone`. TypeScript was happy. The editor was happy. At
runtime the field came back `undefined`, every time, on a column that was
sitting right there in the database with data in it.

He checked the migration. He checked the connection string. He checked whether
he was pointed at the wrong branch's database. Around five o'clock he asked me
to look, and I said the sentence you say roughly once a fortnight on a Prisma
codebase: *did you run `prisma generate`?*

His generated client was three commits old. It had been describing a database
that no longer existed, confidently, in green squiggle-free TypeScript, for
about four hours.

That is not a Prisma bug. It is the shape of the thing.

## Why the codegen step exists

I want to be fair here, because `prisma generate` is not a mistake and it is
not laziness. It solves a real problem.

Prisma's schema lives in `schema.prisma`, its own DSL file. TypeScript cannot
read that file. The compiler has no idea it exists. So something has to stand
between the two and turn one into the other, and that something is a
generator that writes a concrete `.d.ts` describing your models. Once written,
those types are ordinary declared types. The compiler reads them the way it
reads any other declaration file, which is fast, predictable, and scales to
schemas with three hundred models without your editor going quiet for four
seconds every time you type a dot.

There's a second thing codegen buys. Because the client is generated per
project, Prisma can bake in exactly the operations your schema supports and
nothing else, and it can ship a query engine binary alongside it. That engine
is where a lot of Prisma's correctness and speed lives.

Both of those are genuine wins. I don't think the people who built it were
wrong.

I do think the bill is higher than it looks.

## The bill

You regenerate after every schema change, and after every pull that contains
someone else's schema change, and after `npm ci` wipes `node_modules`. Miss one
and you don't get an error, you get four hours of a colleague's Thursday.

You then choose between two unattractive options for source control. Gitignore
the generated client, and every fresh checkout is broken until a postinstall
hook fixes it. Commit it, and every schema change lands as a pull request with
one meaningful line and forty thousand generated ones, which nobody reviews,
which is exactly where the merge conflicts live.

Then there's the engine binary. It's platform-specific. I've had a deploy fail
because the image built on one libc and ran on another, and the error you get
at the far end of that is not "wrong binary target", it's a stack trace from
inside a Rust process at container start. It's fixable. It's documented. It's
still twenty minutes of your life at a bad moment.

And the part that ended it for me: none of this follows you into a browser tab
or a React Native bundle. A native binary and a generation step don't cross
that boundary. I'll come back to why I cared so much about that.

## The other route

The alternative is not clever. It's the one TypeScript has been offering all
along: don't describe your schema in a foreign language, describe it in
TypeScript, and let inference do the work.

In forge, `f.string()` builds a plain object. So does `f.int().optional()`.
`model()` collects them into an object and hands back a `TypedModel` carrying
the field map as a phantom type property, one that exists for the compiler and
not at runtime. `createDb` captures that map through a generic. Every call site
resolves against it.

```ts
import { createDb, f, model } from 'forge-orm';

const User = model('users', {
  id:        f.id(),
  email:     f.string().unique(),
  name:      f.string().optional(),
  age:       f.int().optional(),
  createdAt: f.dateTime().default('now'),
});

const schema = { user: User } as const;
const db = await createDb({ url: process.env.DATABASE_URL!, schema });

const adults = await db.user.findMany({ where: { age: { gte: 18 } } });
//    ^ { id: string; email: string; name: string | null; age: number | null; createdAt: Date }[]
```

Rename `age` to `ageYears` in that model and the `where` clause goes red
before you've finished typing the `s`. Not on the next build. Not after a
command you have to remember. There is no generated artefact that can be older
than your schema, because there is no generated artefact.

The shapes are exported as type helpers, so you can use them at service
boundaries rather than hand-writing DTOs:

```ts
import type { Row, Infer, InferCreate, InferWhere, InferSchema } from 'forge-orm';

type UserRow    = Row<typeof User>;
//   { id: string; email: string; name: string | null; age: number | null; createdAt: Date }
type UserCreate = InferCreate<typeof User>;
//   every scalar optional — defaults are filled at runtime
type UserWhere  = InferWhere<typeof User>;

// Or the whole bundle for one model:
type UserT = Infer<typeof User>;
UserT['Row']; UserT['Create']; UserT['Update']; UserT['Where']; UserT['Include'];

// Or every model at once — the right shape to export from a shared types.ts:
type Types = InferSchema<typeof schema>;
type UserSelect = Types['user']['Select'];
```

`InferRow`, `InferUpdate`, `InferUpsert`, `InferOrderBy`, `InferSelect`,
`InferInclude` and `InferOmit` are all there too. None of them require you to
register anything or call a build command. One gotcha worth knowing: the schema
map needs `as const`, or `keyof typeof schema` widens to `string` and the
relation walk quietly falls back to a loose shape.

## What this costs, honestly

Inference is not free, and I'd rather say so than have you find out on a large
schema.

Prisma's generated types are concrete. The compiler reads them once and moves
on. forge's are computed: `where` is a mapped type walking your field map,
the return type is a conditional type that looks at the literal type of the
arguments you passed and resolves the row, the projection, or the relation
tree. On a small or medium schema you will not notice. On a very large one,
with deep `include` chains, type-checking has more work to do than reading a
declaration file does, and that shows up in editor responsiveness and cold
`tsc` runs. I have not benchmarked the crossover point and I'm not going to
invent one, but the direction is real and it favours codegen at the top end.
The relation walk is capped at ten levels for exactly this reason; past that
nested args type loosely rather than exploding.

There's a second gap. To support composite-unique keys and raw Mongo
operators, `where` carries a string index signature at the bottom, which means
`where: { nonexistent_field: 'x' }` compiles and then matches nothing.
`createDb({ schema, strict: true })` catches it at runtime with the valid keys
listed. Turn it on in development.

That's the trade. Live types with nothing to regenerate, against slower
type-checking at the large end and one loose escape hatch.

## "But then how do I know what SQL runs?"

This is the fair objection to dropping the generated client, and it's the one
I care most about answering. With Prisma you can at least go and read the
thing. So forge has `db.$explain()`, which takes a call site and gives you the
statement without executing it:

```ts
const r = await db.$explain((q) => q.user.findMany({ where: { age: { gt: 40 } } }));
console.log(r.toString());
```

```
user.findMany  →  users  [sqlite]

  SELECT "users"."id", "users"."name", "users"."age" FROM "users" WHERE "users"."age" > ?

  params: 40

  -- with values inlined (for reading, not for running):
  SELECT "users"."id", "users"."name", "users"."age" FROM "users" WHERE "users"."age" > 40
```

The `q` handed to the callback holds no session and reaches no driver, so
nothing can execute even by accident. You get `artifact.sql` and
`artifact.params` as the pair you'd actually run, plus a `readable` version
with values substituted for pasting into `psql`. Don't execute that one; the
quoting there serves legibility, not safety.

Pass `{ analyze: true }` and it asks the database for its own plan:

```ts
const r = await db.$explain((q) => q.user.findMany({ where: { name: 'u7' } }), {
  analyze: true,
});
```

```
  -- plan:
  SCAN users
```

`SCAN` means every row read. `name` has no index. Add one and the same query
comes back as `SEARCH users USING INDEX users_name (name=?)`. That's a
property of the query rather than of the schema, which is why a schema linter
can't see it.

One deliberate omission: forge never emits `EXPLAIN ANALYZE`. `EXPLAIN` plans
a statement; `EXPLAIN ANALYZE` runs it. On a `SELECT` that difference is
accuracy. On `deleteMany` it's your data, and an API whose entire promise is
"this does not run" must not delete rows because you asked for more detail. If
you want real timings, run the statement yourself through `$queryRaw`, on
something you meant to execute.

---

**Next in this series:** the reason none of this has a build step or a binary
in the first place. The same query code, the same models, running in a browser
tab against SQLite compiled to WebAssembly.

📖 Docs: **[johnsonfash.github.io/forge-orm](https://johnsonfash.github.io/forge-orm/)**
📦 npm: **[forge-orm](https://www.npmjs.com/package/forge-orm)**
⭐ GitHub: **[johnsonfash/forge-orm](https://github.com/johnsonfash/forge-orm)**

What's the longest you've spent debugging something that turned out to be a
stale generated artefact? I'd like to know I'm not alone in this.
