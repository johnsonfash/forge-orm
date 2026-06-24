# Types — TypeScript inference, deep dive

The README chapter **[Type safety](../README.md#type-safety)** is the tour:
`Row<typeof Model>`, `ForgeDb<typeof schema>`, the `Infer*` helpers, and how
`db.user.findMany({ where, select, include })` autocompletes without a
codegen step.

This doc is the complete reference for the inference surface. Every
helper exported from `forge-orm/src/infer.ts` and `forge-orm/src/forge-types.ts`,
the model-level type carriers in `forge-orm/src/schema/core.ts`, plus the
advanced generic patterns you reach for when writing typed repositories
or sharing model shapes across a monorepo.

If you have not read the README chapter yet, start there — this doc
assumes you know that `db.<key>` exists and that `Infer<typeof User>` is
the recommended single-import bundle.

## Contents

* [The inference triangle](#the-inference-triangle)
* [`Row<typeof Model>`](#rowtypeof-model)
* [`Infer<typeof Model>`](#infertypeof-model)
* [Per-helper reference: `InferCreate` / `InferUpdate` / `InferWhere` / …](#per-helper-reference-infercreate--inferupdate--inferwhere--)
* [`ForgeOf<'modelKey'>`](#forgeofmodelkey)
* [`ForgeModels` and `Forge`](#forgemodels-and-forge)
* [Optional vs nullable](#optional-vs-nullable)
* [Defaults, `.updatedAt()`, generated columns](#defaults-updatedat-generated-columns)
* [Relations in inference](#relations-in-inference)
* [Discriminated `where` and the loose-key escape hatch](#discriminated-where-and-the-loose-key-escape-hatch)
* [Strict mode](#strict-mode)
* [Generic helpers](#generic-helpers)
* [Autocomplete tricks (and the bugs that break it)](#autocomplete-tricks-and-the-bugs-that-break-it)
* [Custom types on a field](#custom-types-on-a-field)
* [Embed inference](#embed-inference)
* [Per-dialect type quirks](#per-dialect-type-quirks)
* [Sharing inferred types across the monorepo](#sharing-inferred-types-across-the-monorepo)
* [Five worked patterns](#five-worked-patterns)
* [Limitations](#limitations)

---

## The inference triangle

Three things hold the type-safety story together. None of them generate
code; each is a TypeScript-only carrier that flows from your schema into
the per-call argument shapes.

```
        model(...)             ← schema definition (1)
            │
            │ TypedModel<F, R>  phantom carriers _fields / _relations
            ▼
       ForgeDb<typeof schema>  ← createDb({ schema }) returns this (2)
            │
            │ Collections<S>    db.<key> resolved to a CollectionWrapper
            ▼
   db.user.findMany({ where: { … }, select: { … }, include: { … } })   (3)
            │
            │ Resolve<F, R, Args, Schema>
            ▼
        Inferred return shape  ← exact `Promise<…>` per call
```

1. **`model('users', { … })`** returns a `TypedModel<F, R>` (see
   `forge-orm/src/schema/core.ts`). `F` is the field map (`{ id: Field<string,
   'id'>; email: Field<string, 'string'>; … }`), `R` is the relation
   record (`{ posts: RelationInfo<'post', 'many'> }`). Both ride as
   phantom properties (`_fields` / `_relations`) — they exist for the
   type checker, not at runtime.

2. **`createDb<S>({ schema })`** captures the schema map's type via a
   generic and returns `ForgeDb<S>`. `db.<key>` resolves to a
   `CollectionWrapper<F, R, S>` for that model, with the whole schema
   threaded through so nested `include` resolves the *target* model's
   fields against the same map.

3. **Per-call inference.** `db.user.findMany({ where: { … } })` knows the
   shape of `where` because `findMany`'s signature is `(args:
   FindManyArgs<F, R, S>) => Promise<Resolve<F, R, args, S>>`. The
   `where` mapped type walks `F` and produces the right filter per
   field type (`StringFilter`, `NumberFilter`, …). The return type is
   `Resolve<F, R, args, S>` — it sees the literal type of `args` and
   widens scalars to `Row[]`, narrows to a select projection, or
   layers relations on top, depending on what you passed.

The triangle works without a codegen step because all three nodes are
type-only. Add a field to your model, save — `ForgeDb<typeof schema>`
picks it up next type-check.

---

## `Row<typeof Model>`

`Row<M>` is the resolved object shape — what comes back from `findUnique`,
`findFirst`, and `findMany` when no `select` or `include` is in play.

```ts
import type { Row } from 'forge-orm';
import { f, model } from 'forge-orm';

const User = model('users', {
  id:        f.id(),
  email:     f.string().unique(),
  name:      f.string().optional(),
  age:       f.int().optional(),
  active:    f.bool().default(true),
  createdAt: f.dateTime().default('now'),
  meta:      f.json(),
});

type UserRow = Row<typeof User>;
// {
//   id:        string;
//   email:     string;
//   name:      string | null;
//   age:       number | null;
//   active:    boolean;
//   createdAt: Date;
//   meta:      any;
// }
```

The mapping per field builder, with the JS-side type that lands on
`Row`:

| Builder                                       | Row type                                  |
|-----------------------------------------------|-------------------------------------------|
| `f.id()`                                       | `string`                                  |
| `f.id({ type: 'bigserial' })`                 | `number`                                  |
| `f.id({ type: 'uuid' })`                      | `string`                                  |
| `f.objectId()`                                 | `string`                                  |
| `f.string()` / `f.text()`                      | `string`                                  |
| `f.int()` / `f.float()`                        | `number`                                  |
| `f.bigint()`                                   | `bigint`                                  |
| `f.decimal({ precision, scale })`             | `string` (preserves precision)            |
| `f.uuid()`                                     | `string`                                  |
| `f.bool()`                                     | `boolean`                                 |
| `f.dateTime()`                                 | `Date`                                    |
| `f.json()`                                     | `any` (carry-anything escape)             |
| `f.enumOf(['A', 'B'] as const)`               | `'A' \| 'B'`                              |
| `f.embed(() => Type)`                          | the embed's row shape                     |
| `f.embedMany(() => Type)`                      | `Type[]`                                  |
| `f.stringArray()` / `f.intArray()`            | `string[]` / `number[]`                   |
| `f.geoPoint()`                                 | `{ lng: number; lat: number }`            |
| `f.geoPoint({ dims: 3 })`                     | `{ lng: number; lat: number; alt: number }` |
| `f.vector(N)`                                  | `number[]`                                |
| any of the above `.optional()`                | `T \| null`                               |

Two non-obvious ones:

* **`f.json()` is `any`, not `unknown`.** This is a deliberate trade-off.
  forge has no idea what shape lives inside a JSON column, and `unknown`
  would force every consumer to narrow before reading. `any` keeps
  reads ergonomic; pair with `f.embed(() => Type)` when you do know
  the shape and want to keep type safety.
* **`f.decimal()` is `string`, not `number`.** JavaScript numbers can't
  represent every decimal (money is the standard example), so forge
  surfaces decimals as strings on both sides. The DB driver does the
  round-trip; you do the math with a decimal library on top.

The `bigserial` case is the only one that flips the shape based on
options: `f.id({ type: 'bigserial' })` gives back `Field<number, 'id'>`
(see `IdJsType<T extends IdTypeName>` in `src/schema/core.ts`).

---

## `Infer<typeof Model>`

`Infer<typeof M>` is the recommended single-import bundle — one type that
holds every per-model input/output shape, indexed by an obvious key.

```ts
import type { Infer } from 'forge-orm';

type User = Infer<typeof User>;

User['Row']         // findFirst/findMany return shape (without select/include)
User['Where']       // findMany / count / update filter input
User['WhereUnique'] // findUnique input (partial of Where)
User['Create']      // db.user.create({ data: … })
User['Update']      // db.user.update({ data: … }) — includes atomic ops on numbers
User['Upsert']      // { create: User['Create']; update: User['Update'] }
User['OrderBy']     // db.user.findMany({ orderBy: … })
User['Select']      // db.user.findMany({ select: … }) — scalars + relations
User['Include']     // db.user.findMany({ include: … }) — relation names
User['Omit']        // { [field]?: boolean }
```

Use it everywhere you'd otherwise type a DTO by hand:

```ts
function createUser(data: User['Create']) { … }
async function findUsers(where: User['Where']): Promise<User['Row'][]> { … }

const draftMode = (state: User['Update']): User['Update'] => ({
  ...state,
  status: 'DRAFT',
});
```

For relation-aware `Select` and `Include`, pass the schema map as the
second generic. Without it, relation walks still type-check but fall
back to a loose shape on the nested args:

```ts
const schema = { user: User, post: Post } as const;
type T = Infer<typeof User, typeof schema>;

type Args = T['Include'];
// { posts?: boolean | { where?: …; take?: number; include?: …; select?: … } }
```

There's also `InferSchema<typeof schema>` — same bundle, applied to every
key in the schema record. This is the right shape to export from a
shared `types.ts` (see [Sharing inferred types across the monorepo](#sharing-inferred-types-across-the-monorepo)).

```ts
type T = InferSchema<typeof schema>;
type UserCreate  = T['user']['Create'];
type PostInclude = T['post']['Include'];   // walks the relation graph correctly
```

---

## Per-helper reference: `InferCreate` / `InferUpdate` / `InferWhere` / …

`Infer<typeof M>` is the bundle. The single-purpose aliases are useful
when you want one shape only — typically at a function signature where
the `.Row` member of the bundle is irrelevant:

| Helper                          | What it gives you                                                                 |
|---------------------------------|------------------------------------------------------------------------------------|
| `InferRow<typeof M>`            | Same as `Row<typeof M>` — the resolved row object.                                |
| `InferWhere<typeof M>`          | `where` filter shape: scalar filters per field + `AND` / `OR` / `NOT` + loose key. |
| `InferWhereUnique<typeof M>`    | `Partial<Where>` — runtime picks the unique key, you only fill in one.            |
| `InferCreate<typeof M>`         | `db.<m>.create({ data })` input — scalar values + relation directives.            |
| `InferUpdate<typeof M>`         | `db.<m>.update({ data })` input — values + atomic ops on numbers + null markers.  |
| `InferUpsert<typeof M>`         | `{ create: InferCreate<M>; update: InferUpdate<M> }`.                              |
| `InferOrderBy<typeof M>`        | `{ [field]?: 'asc' \| 'desc' }`.                                                  |
| `InferSelect<typeof M, S?>`     | Boolean toggles per scalar + nested args per relation (walk requires `S`).        |
| `InferInclude<typeof M, S?>`    | Relation names with boolean or nested args (walk requires `S`).                   |
| `InferOmit<typeof M>`           | `{ [field]?: boolean }` — symmetric inverse of select for scalars.                |
| `InferSchema<typeof S>`         | Map of all the above, per schema key. The monorepo-export shape.                  |

**`InferCreate` vs `Row` — the difference matters.**

```ts
type UserCreate = InferCreate<typeof User>;
// { id?: string; email?: string; name?: string | null; … }
//   every scalar is OPTIONAL — defaults are filled at runtime.

type UserRow = Row<typeof User>;
// { id: string; email: string; name: string | null; … }
//   every scalar is PRESENT — the row is what came back from the DB.
```

`Create` is the input side: `id?` is optional because `f.id()` has an
`autoId` default; `email?` is optional because forge marks every scalar
optional on `Create` and defers required-field validation to the DB
(NOT NULL on `email` will throw at insert time). `Row` is the output
side: every field is present, with `optional()` fields surfacing as
`T | null`.

The same logic applies to `InferUpdate`: every field is optional (you're
patching, not replacing), and numeric fields gain the atomic-op shape
(`{ increment: 1 }` etc.) on top of the plain value.

---

## `ForgeOf<'modelKey'>`

`ForgeOf<K>` (from `forge-orm/src/forge-types.ts`) is the generic accessor
against the *active* `SchemaMap`. Think of it as the by-key alternative
to `Infer<typeof Model>`:

```ts
import type { ForgeOf } from 'forge-orm';

type UserWhere   = ForgeOf<'user'>['WhereInput'];
type UserCreate  = ForgeOf<'user'>['CreateInput'];
type UserSelect  = ForgeOf<'user'>['Select'];
type PostInclude = ForgeOf<'post'>['Include'];
```

Reach for `ForgeOf` when **the model key is a string parameter** — e.g.
inside a generic helper that doesn't know the model at the call site.
`Infer<typeof M>` needs the model *value* in scope; `ForgeOf<K>` only
needs the *key literal*.

```ts
// A generic typed-repo helper — the key K threads through to every input.
function makeRepo<K extends keyof typeof schema>(key: K) {
  return {
    findOne: (where: ForgeOf<K>['WhereUniqueInput']) =>
      db[key].findUnique({ where }),
    create:  (data:  ForgeOf<K>['CreateInput']) =>
      db[key].create({ data }),
  };
}

const userRepo = makeRepo('user');
userRepo.create({ data: { email: 'a@x.co' } });   // typed against User
```

A subtlety: `ForgeOf<K>` resolves against whatever schema is *active* at
type-check time, which is the consumer's schema once they call
`createDb({ schema })`. It's the same `PerModelTypes<M>` shape under the
hood (see `src/forge-types.ts`); the key-vs-value access is the only
difference.

The full per-model bundle exposed by `PerModelTypes<M>` (so by both
`ForgeOf<K>` and `Forge<K>` below) covers the call-args shapes too:

```ts
ForgeOf<'user'>['FindFirstArgs']
ForgeOf<'user'>['FindManyArgs']
ForgeOf<'user'>['FindUniqueArgs']
ForgeOf<'user'>['CreateArgs']
ForgeOf<'user'>['CreateManyArgs']
ForgeOf<'user'>['UpdateArgs']
ForgeOf<'user'>['UpdateManyArgs']
ForgeOf<'user'>['UpsertArgs']
ForgeOf<'user'>['DeleteArgs']
ForgeOf<'user'>['DeleteManyArgs']
ForgeOf<'user'>['CountArgs']
```

These are the literal `{ where?, select?, include?, orderBy?, take?, … }`
objects you'd pass to each operation. Forwarding the args through a
service layer? Take them straight from `*Args`.

---

## `ForgeModels` and `Forge`

`ForgeModels` is the capitalised-lookup variant. Same `PerModelTypes`
bundle, indexed by the schema key with its first letter uppercased:

```ts
import type { ForgeModels, Forge } from 'forge-orm';

type UserWhere  = ForgeModels['User']['WhereInput'];
type PostCreate = ForgeModels['Post']['CreateInput'];

// `Forge` is exported as an alias for `ForgeModels` — same type, shorter name.
type UserCreate = Forge['User']['CreateInput'];
```

This is mostly a stylistic alternative — `ForgeOf<'user'>`,
`ForgeModels['User']`, and `Forge['User']` all resolve to the same type.
Pick one and stay consistent inside a project; mixing them across a
single file makes the inference triangle harder to follow.

The convention that's worked best in the consumer codebases that ship on
forge: use `ForgeModels['User']` for shared helper modules (a `types.ts`
that exports typed DTOs across services), and `Infer<typeof User>` inside
the file where `User` is defined.

---

## Optional vs nullable

TypeScript has two ways to say "this field might not be there":

* **Optional** — `field?: T` — the key may be absent. `T` is still `T`.
* **Nullable** — `field: T | null` — the key is present, the value might
  be the literal `null`.

forge's `.optional()` modifier means **DB-nullable**: the column accepts
`NULL`. The JS-side type it produces is `T | null` on `Row`, because the
DB might give you back `NULL`. But on `Create` and `Update` it's both
optional *and* nullable: you can omit the field (defer to the default,
or leave it `NULL`) or pass `null` explicitly. The two surfaces are
asymmetric on purpose.

```ts
const User = model('users', {
  id:    f.id(),
  email: f.string(),
  name:  f.string().optional(),    // DB column is NULLABLE
  age:   f.int().optional(),
});

type Row = Row<typeof User>;
// { id: string; email: string; name: string | null; age: number | null }
//   ^ every field PRESENT; nullable ones surface as `T | null`.

type Create = InferCreate<typeof User>;
// { id?: string; email?: string; name?: string | null; age?: number | null }
//   ^ every field OPTIONAL; you can also explicitly pass `null` on nullable ones.
```

The reason for the asymmetry: when you create a row, omitting `name` is
not the same as passing `null` — omitting falls through to whatever the
column default is (NULL here, but could be a literal default), while
passing `null` explicitly writes NULL. On a row that came back from the
DB, there's no "absent" — the column has *some* value, which might be
`null`. So output is `T | null`, input is `T | null | undefined`.

For json/jsonb columns there's a third axis: SQL NULL vs JSON null. See
[the null-markers section](#defaults-updatedat-generated-columns) below
and **[docs/JSON-PATH.md](./JSON-PATH.md)** for the full story.

---

## Defaults, `.updatedAt()`, generated columns

The `Create` and `Update` shapes diverge from `Row` in a few specific
ways tied to field modifiers:

```ts
const Post = model('posts', {
  id:        f.id(),                            // default: autoId
  title:     f.string(),
  slug:      f.string().unique(),
  createdAt: f.dateTime().default('now'),       // default: now()
  updatedAt: f.dateTime().default('now').updatedAt(),
  fullText:  f.text().dbgenerated(`"title" || ' ' || "body"`),
});
```

| Field                                  | On `Row`             | On `Create`              | On `Update`           |
|----------------------------------------|----------------------|--------------------------|-----------------------|
| `f.id()` (autoId default)               | `string` (present)   | `string?` (optional)     | not writable          |
| `f.dateTime().default('now')`          | `Date`               | `Date?`                  | `Date?`               |
| `f.dateTime().updatedAt()`             | `Date`               | `Date?`                  | not writable          |
| `f.text().dbgenerated(expr)`           | `string`             | not writable             | not writable          |

Two of these are enforced at the type level today:

* **Defaults** — forge marks **every** scalar optional on `Create` (and
  on `Update`). Required-vs-defaulted is not currently surfaced in the
  type; missing-required is enforced at the DB layer (NOT NULL → driver
  error). The trade-off is in `typesafety-demo.ts` section B2 — making
  "required" precise at compile time would mean tracking the
  intersection of `optional`, `default`, `updatedAt`, and `dbgenerated`,
  and the current shape (everything optional, DB enforces) wins on
  ergonomics for the common case.
* **Generated columns** — `dbgenerated(expr)` columns are read-only.
  They flow through `Row` and `Select` correctly, but the wrapper
  refuses to write them at runtime. The TS surface doesn't currently
  remove them from `Create` / `Update` — passing one is accepted by the
  type checker and stripped at runtime. A future refinement to thread
  `dbGenerated` through the input mapped type would close this gap.

**Null markers.** For json fields, "I want a SQL NULL" and "I want a JSON
`null` literal" are different things on PG/MySQL with `jsonb`. forge
ships three sentinel values for this:

```ts
import { ForgeDbNull, ForgeJsonNull, ForgeAnyNull } from 'forge-orm';

await db.user.update({ where: { id }, data: { settings: ForgeDbNull   } }); // settings IS NULL
await db.user.update({ where: { id }, data: { settings: ForgeJsonNull } }); // settings = 'null'::jsonb
await db.user.update({ where: { id }, data: { settings: ForgeAnyNull  } }); // matches either on read
```

These types are part of `FieldUpdateValue<X>` — any nullable or json
field accepts them in the `Update` shape (see `src/null-markers.ts`).

---

## Relations in inference

Relations are declared with `.relate(() => ({ … }))`. The relation map
rides on the model as the second phantom (`R`), and `include` / `select`
walk it via a schema lookup.

```ts
const User = model('users', {
  id:    f.id(),
  email: f.string(),
}).relate(() => ({
  posts: rel.many('post', { on: 'id', refs: 'authorId' }),
}));

const Post = model('posts', {
  id:       f.id(),
  authorId: f.objectId(),
  title:    f.string(),
}).relate(() => ({
  author: rel.one('user', { on: 'authorId', refs: 'id' }),
}));

const schema = { user: User, post: Post } as const;
```

**`include` widens the row.**

```ts
const u = await db.user.findFirst({ include: { posts: true } });
// u: ({ id: string; email: string; posts: { id: string; authorId: string; title: string }[] }) | null

const u2 = await db.user.findFirst({
  include: { posts: { include: { author: true } } },
});
// posts: { … ; author: { id, email } | null }[]
```

`Resolve<F, R, Args, S>` (see `src/schema/core.ts`) is the conditional
type that does the walk. It looks at the `args` literal, finds the
`include` shape, and per relation entry:

* relation kind `'one'` → `Resolve<TF, TR, NestedArg, S> | null`
* relation kind `'many'` → `Resolve<TF, TR, NestedArg, S>[]`

The recursion is depth-bounded — explicit relation nesting is capped at
10 levels via the `Decrement<N>` type. Past depth 0 the nested args
fall back to `LooseRelationArgs` (loosely typed) so deep cycles
terminate cleanly without collapsing the outer types to `any`.

**`select` narrows the row.**

```ts
const u = await db.user.findFirst({ select: { email: true } });
// u: { email: string } | null

// Accessing a non-selected field is a compile error:
// @ts-expect-error
u?.id;
```

The narrowing is in `ResolveSelect<F, R, S, Schema, Depth>`: it keeps
only the keys whose value is truthy and maps them to the field's
resolved JS type. The same shape handles `_count: { select: { … } }` —
included counts come back typed as `_count: { posts: number }`.

**`select` and `include` are mutually exclusive.** Pass both and the
type errors:

```ts
// @ts-expect-error — forge rejects passing BOTH select and include
await db.user.findMany({ select: { email: true }, include: { posts: true } });
```

The check sits in `NoBothSelectInclude<A>` — intersecting a method's
args with this turns "both present" into an impossible type so the call
fails to typecheck.

---

## Discriminated `where` and the loose-key escape hatch

Composite uniques (`@@unique([orgId, slug])`) become synthetic where
keys in Prisma's convention: `where: { orgId_slug: { orgId, slug } }`.
forge accepts the same shape:

```ts
const Page = model('pages', {
  id:    f.id(),
  orgId: f.objectId(),
  slug:  f.string(),
}, {
  uniques: [['orgId', 'slug']],
});

await db.page.findUnique({
  where: { orgId_slug: { orgId: 'o1', slug: 'about' } },
});
```

This works because `WhereInput<F>` has a `[key: string]: any` index
signature at the bottom of its definition:

```ts
export type WhereInput<F extends Record<string, Field<any, any>>> = {
  [K in keyof F]?: _InputVal<F[K]> | ScalarFilterFor<_Val<F[K]>> | null;
} & {
  AND?: WhereInput<F> | WhereInput<F>[];
  OR?: WhereInput<F>[];
  NOT?: WhereInput<F> | WhereInput<F>[];
} & {
  [key: string]: any;            // ← composite-unique synthetic keys
};
```

The trade-off — declared honestly in `typesafety-demo.ts` section B1 —
is that the loose-key fallback also accepts arbitrary unknown keys at
compile time. `where: { nonexistent_field: 'x' }` typechecks; it just
silently matches nothing at the DB layer. Real fields still
autocomplete; typos don't error.

That's where strict mode comes in.

---

## Strict mode

`createDb({ schema, strict: true })` adds a runtime check that catches
the loose-key gap:

```ts
const db = await createDb({ url, schema, strict: true });

await db.user.findMany({ where: { nonexistent_field: 'x' } });
// throws:
//   [forge:strict] unknown where key 'nonexistent_field' on 'users'.
//     valid keys: id, email, name, AND, OR, NOT
//   (strict mode is on — disable with createDb({ strict: false }) to allow loose keys.)
```

Notes:

* Strict is **runtime**, not compile-time. The TS surface is identical;
  what changes is the wrapper's `validateWhereKeys()` pass (see
  `src/builder/collection.ts`). The loose-key index signature on
  `WhereInput` stays — strict just intercepts before the IR builder.
* Composite-unique synthetic keys are validated against the
  `uniques: [...]` declarations on the model — `orgId_slug` is
  recognised as the joined form of `['orgId', 'slug']` and accepted.
* `AND` / `OR` / `NOT` and the `_withDeleted` soft-delete escape are
  allowed unconditionally.

Default is `false` because Mongo-native operators (`$or`, `$and`,
`$geoWithin`) need to land on `where` for raw passthrough cases. Strict
catches typos; turn it on in dev, leave it on in prod if you're not
mixing in raw Mongo operators.

---

## Generic helpers

Most of the time you'd write `Infer<typeof User>` and be done. The cases
where you reach for `ForgeOf<K>` are when the model key is a generic
parameter — usually because you're writing a typed helper that handles
multiple models.

The minimal pattern:

```ts
import type { ForgeOf } from 'forge-orm';

async function findOne<K extends keyof typeof schema>(
  key: K,
  where: ForgeOf<K>['WhereUniqueInput'],
): Promise<ForgeOf<K>['Payload'] extends (a: any) => infer R ? R : never> {
  return db[key].findUnique({ where }) as any;
}

const u = await findOne('user', { id: 'u1' });
// u: User row (or null) — inferred from K = 'user'
```

The cast on `db[key]` is unavoidable because TypeScript can't prove
`db[K].findUnique` accepts `ForgeOf<K>['WhereUniqueInput']` without
distributing K over the whole `Collections<S>` mapped type — and
distribution explodes once you have >5 models. The runtime is sound;
the cast is the compile-side cost.

A fuller typed-repo example:

```ts
function makeRepo<K extends keyof typeof schema>(key: K) {
  type T = ForgeOf<K>;
  return {
    findOne:  (where: T['WhereUniqueInput']) => db[key].findUnique({ where }),
    findMany: (args:  T['FindManyArgs'])     => db[key].findMany(args as any),
    create:   (data:  T['CreateInput'])      => db[key].create({ data }),
    update:   (where: T['WhereInput'], data: T['UpdateInput']) =>
      db[key].update({ where, data } as any),
  };
}

const users = makeRepo('user');
users.findMany({ where: { email: { contains: '@' } } });  // typed against User
users.create({ data: { email: 'a@b.co' } });              // typed against User
```

The `as any` on the inner call is the same compile-cost trade-off. The
*outer* surface (the `users.create({ … })` call site) is fully typed.

---

## Autocomplete tricks (and the bugs that break it)

The inference triangle hinges on a few invariants. Break any of them and
your call-site types collapse to `any` — autocomplete dies, and bad
inputs slip through.

**1. The schema map needs `as const`.**

```ts
// ✅ Autocomplete works.
const schema = { user: User, post: Post } as const;

// ❌ schema's type widens to { user: TypedModel<…>, post: TypedModel<…> }
// without the literal key narrowing. ForgeOf<K extends keyof typeof schema>
// then has K ≅ string, and per-call inference falls back to the index
// signature.
const schema = { user: User, post: Post };
```

Without `as const`, `keyof typeof schema` widens to `string`, and the
`Schema[target]` lookups inside `Resolve<>` can't pin a model. The
relation-walk fails open to `LooseRelationArgs`.

**2. Use `type` imports for inference helpers.**

```ts
// ✅
import type { Infer, ForgeOf, ForgeDb } from 'forge-orm';

// ❌ — works, but bloats the runtime bundle with re-exports it doesn't need.
import { Infer, ForgeOf, ForgeDb } from 'forge-orm';
```

The forge runtime exports `createDb`, `f`, `model`, `rel`, and the null
markers as values. Everything in `forge-types.ts` and `infer.ts` is
type-only. `import type` removes them from the JS output.

**3. `satisfies` over annotation when you need both.**

When you want to type-check a literal *and* keep its narrow type for
inference downstream:

```ts
const schema = {
  user: User,
  post: Post,
} as const satisfies Record<string, TypedModel<any, any>>;
```

`satisfies` runs the check without widening. If you'd written
`const schema: Record<string, TypedModel<any, any>> = { … }`, the type
would be the annotation — and `typeof schema` would lose the per-key
shape that `ForgeDb<typeof schema>` needs.

**4. Don't destructure the db.**

```ts
// ❌ — `user`'s type goes to CollectionWrapper<any, any, any>
const { user, post } = db;

// ✅
const user = db.user;
const post = db.post;
```

The `db` proxy's type is `ForgeDb<S>` = `Collections<S> & { … }`, where
`Collections<S>` is a mapped type. Destructuring through a mapped type
loses the per-key narrowing. Property access keeps it.

**5. Keep `relate()` lazy.**

```ts
// ✅ — lazy callback, R captures the relation names without evaluating targets.
.relate(() => ({ posts: rel.many('post', { on: 'id', refs: 'authorId' }) }));

// ❌ inline relations: TS walks Business → Subscription → Business and
// collapses everything to any.
```

This is enforced by the API (there's no non-callback form), but it's
worth knowing *why*: cyclic relations would force TS to evaluate target
types eagerly, hit recursion limits, and fall back to `any`. The lazy
callback + string targets keeps the cycle in *runtime* data, not in
*type* data. The trade-off is that target-name typos surface at first
runtime use, not at compile time.

---

## Custom types on a field

The cleanest way to narrow a string column to a literal set is
`f.enumOf([...] as const)`:

```ts
const Invoice = model('invoices', {
  id:       f.id(),
  currency: f.enumOf(['NGN', 'USD', 'EUR'] as const),
  amount:   f.decimal({ precision: 12, scale: 2 }),
});

type Row = Row<typeof Invoice>;
// { id: string; currency: 'NGN' | 'USD' | 'EUR'; amount: string }
```

The column type at the DB layer is still TEXT (or the dialect's
enum type if you opt in via the index advisor) — the narrowing lives in
TypeScript only. At runtime, forge doesn't validate the value against
the enum tuple unless you wire a check yourself; if you write
`'GBP'` past a cast, the DB will accept it and the type-side guarantee
is gone.

For the same reason, you can `as`-cast at the call site when you have a
narrower domain type:

```ts
type CurrencyCode = 'NGN' | 'USD' | 'EUR';

const code: CurrencyCode = 'NGN';
await db.invoice.create({ data: { currency: code, amount: '100.00' } });
```

forge's exported field factories do not currently accept a TypeScript
generic — `f.string()` always returns `Field<string, 'string'>`. The
`f.enumOf` route covers the common "narrow this string column" case and
has the advantage that the literal tuple is available at runtime too
(useful for forms, validators, switch exhaustiveness).

---

## Embed inference

`f.embed(() => Type)` and `f.embedMany(() => Type)` define composite
columns (Prisma `type Foo {}` shape). The embed itself is a tiny model
with the same field-map shape, and its row type flows through `Row` and
`Create`:

```ts
import { embed, f, model } from 'forge-orm';

const Address = embed('Address', {
  street: f.string(),
  city:   f.string(),
  zip:    f.string().optional(),
});

const User = model('users', {
  id:        f.id(),
  email:     f.string(),
  address:   f.embed(() => Address),
  addresses: f.embedMany(() => Address),
});

type Row = Row<typeof User>;
// {
//   id:        string;
//   email:     string;
//   address:   { street: string; city: string; zip: string | null };
//   addresses: { street: string; city: string; zip: string | null }[];
// }
```

On the `Create` and `Update` side, embed values are accepted as
`Partial<EmbedRow>` — every field inside an embed is treated as
optional, mirroring the wrapper's runtime fill-in behaviour:

```ts
type Create = InferCreate<typeof User>;
//   address?: Partial<{ street: string; city: string; zip: string | null }>;
//   addresses?: Partial<{ street: string; city: string; zip: string | null }>[];
```

**Polymorphic embeds — tagged unions.** Embeds compose with TypeScript's
discriminated unions for content-block-shaped data:

```ts
type TextBlock  = { kind: 'text';  content: string };
type ImageBlock = { kind: 'image'; src: string; alt: string };
type Block      = TextBlock | ImageBlock;

const Block = embed('Block', {
  kind:    f.enumOf(['text', 'image'] as const),
  content: f.string().optional(),
  src:     f.string().optional(),
  alt:     f.string().optional(),
});

const Page = model('pages', {
  id:     f.id(),
  blocks: f.embedMany(() => Block),
});

// At read-time, narrow by `kind` and TS picks the right shape:
for (const b of page.blocks) {
  if (b.kind === 'text')  console.log(b.content);
  if (b.kind === 'image') console.log(b.src, b.alt);
}
```

The on-disk shape is a flat object — there's no way to enforce
"`content` is required only when `kind === 'text'`" at the type level
through the embed builder alone. That's a wider TS pattern (mapped
types over the union); apply it on top of the embed row at the boundary
where you read or write blocks.

---

## Per-dialect type quirks

The Row shape is the same across all six dialects. The driver layer
normalises wire-format quirks before the value lands on `Row`:

* **`f.bigint()`** — PG returns `bigint` as a string by default; forge
  parses it to `bigint`. With `pg`'s `safeIntegers: false` you'd lose
  precision past `Number.MAX_SAFE_INTEGER`, so forge's `pgDriver`
  registers a custom type parser that keeps the wire string and
  rehydrates to `BigInt`. MySQL's `mysql2` driver needs
  `supportBigNumbers: true; bigNumberStrings: true` (forge's default
  driver sets both). SQLite's `better-sqlite3` returns `bigint` via the
  `safeIntegers` flag on the prepared statement (forge enables it for
  bigint columns). Mongo returns a `Long` BSON type → forge converts
  to `bigint`.
* **`f.decimal()`** — `string` on every dialect. PG numeric returns as
  string by default. MySQL DECIMAL same (`mysql2` with
  `decimalNumbers: false`). SQLite NUMERIC: forge stores as TEXT to
  preserve precision. Mongo Decimal128: forge converts to
  string-form on read. DuckDB DECIMAL via the `@duckdb/node-api`
  client lands as `bigint` × scale internally; forge converts to
  string. MSSQL DECIMAL: the `mssql` package returns as string when
  precision > 15, number otherwise — forge forces string on read.
* **`f.bool()`** — SQLite has no boolean type; it stores 0/1 INTEGER.
  forge converts both directions automatically. Mongo, PG, MySQL,
  DuckDB, MSSQL all support boolean natively.
* **MSSQL `UNIQUEIDENTIFIER`** — when `f.id({ type: 'uuid' })` is used
  on MSSQL, the column is `UNIQUEIDENTIFIER`. The driver returns a
  `string` (canonical 8-4-4-4-12 form); forge does not lowercase or
  re-format. The `Row` type is `string`.
* **PG `bigserial` id** — `f.id({ type: 'bigserial' })` is the one
  schema-side knob that flips the JS-side row type from `string` to
  `number` (see `IdJsType<T>` in `src/schema/core.ts`). The DB assigns
  the value on INSERT and forge reads it back into the row. On
  Mongo, this throws at `forge push` time — Mongo has no
  auto-incrementing scalar id concept.
* **Mongo `_id`** — forge maps Mongo's `_id` (ObjectId) to/from a
  `string`-shaped `id` field on every model. Inserts auto-generate an
  ObjectId when no `id` is passed; reads convert to the
  24-char hex string. You never see a raw ObjectId on `Row`.

The cast layer is in each adapter's `coerce.ts` (e.g.
`src/adapters/postgres/coerce.ts`). If you bypass it (raw
`$queryRaw` against bigint or decimal columns), you'll see the driver's
native shape — not the normalised `Row` shape. Use `$queryRaw<T>` with
your own `T` to declare what you expect from the wire.

---

## Sharing inferred types across the monorepo

The single export pattern that scales for monorepos:

```ts
// packages/db/src/models.ts — owned by the data layer
import { f, model, rel } from 'forge-orm';

export const User = model('users', { … }).relate(…);
export const Post = model('posts', { … }).relate(…);
export const schema = { user: User, post: Post } as const;
```

```ts
// packages/db/src/types.ts — owned by the data layer, consumed everywhere
import type { Infer, InferSchema, Row } from 'forge-orm';
import type { schema } from './models';

export type Types  = InferSchema<typeof schema>;

export type UserT  = Types['user'];
export type PostT  = Types['post'];

export type UserRow    = Row<typeof schema['user']>;
export type UserCreate = UserT['Create'];
export type UserWhere  = UserT['Where'];
```

```ts
// apps/api/src/handlers/users.ts — consumes types, never imports models
import type { UserCreate, UserWhere } from '@app/db/types';

export async function createUser(data: UserCreate) { … }
export async function listUsers(where: UserWhere) { … }
```

Three properties of this layout:

1. **Models stay in one place.** `packages/db/src/models.ts` is the
   single source of truth.
2. **Types are exported as a flat surface.** Consumers import
   `UserCreate`, not `Infer<typeof User>['Create']`. The bundle
   is broken up at the data-layer boundary, so consumers don't need
   `forge-orm` in their dependency graph (they only need types).
3. **Frontend can share the same shapes.** `apps/web/src/api/users.ts`
   can import `UserCreate` for its form state — the frontend and the
   API agree on the wire shape because both derive from the same model.

If you go further and ship a generated zod schema alongside the forge
model (see [pattern (b)](#five-worked-patterns)), the same boundary
works for runtime validation.

---

## Five worked patterns

### (a) Typed repository helper

A repo per model is fine; a repo per *family of models* needs the
generic. Here's the shape that holds up:

```ts
import type { ForgeOf } from 'forge-orm';
import { schema } from '@app/db/models';

export function makeRepo<K extends keyof typeof schema>(key: K) {
  type T = ForgeOf<K>;
  return {
    findOne(where: T['WhereUniqueInput']) {
      return db[key].findUnique({ where });
    },
    findMany(args: T['FindManyArgs']) {
      return db[key].findMany(args as any);
    },
    create(data: T['CreateInput']) {
      return db[key].create({ data });
    },
    update(where: T['WhereInput'], data: T['UpdateInput']) {
      return db[key].update({ where, data } as any);
    },
    delete(where: T['WhereInput']) {
      return db[key].delete({ where });
    },
  };
}

export const userRepo = makeRepo('user');
export const postRepo = makeRepo('post');

await userRepo.create({ data: { email: 'a@b.co' } });
//                              ^^^^^^^^^^^^^^^^^^ typed against User
```

### (b) Zod schema paired with the forge model

forge doesn't ship runtime validation — it's a data-layer wrapper, not
a request-validator. At the API boundary you usually want a zod schema
that matches the model. Hand-write the zod once and let TS check that
it matches the forge inferred shape:

```ts
import { z } from 'zod';
import type { InferCreate } from 'forge-orm';
import { User } from '@app/db/models';

export const userCreateSchema = z.object({
  email: z.string().email(),
  name:  z.string().min(1).optional(),
  age:   z.number().int().positive().optional(),
}) satisfies z.ZodType<InferCreate<typeof User>>;

// Inside the route:
const body = userCreateSchema.parse(request.body);
//    ^^^^ now typed as InferCreate<typeof User>
await db.user.create({ data: body });
```

The `satisfies` keeps the zod's own narrow inferred type *and* runs a
compile-time check that `z.infer<typeof userCreateSchema>` is assignable
to `InferCreate<typeof User>`. Drift the model — add a required field —
and the zod will stop satisfying the constraint until you update it.

### (c) Reading shape mismatch — `db.$queryRaw<MyRow>`

Sometimes the raw shape doesn't match the model — joins, projections,
aggregates from the raw side. Declare the wire shape on the call:

```ts
const stats = await db.$queryRaw<{
  user_id:  string;
  posts:    number;
  comments: number;
}>`
  SELECT u.id AS user_id,
         COUNT(DISTINCT p.id)::int AS posts,
         COUNT(DISTINCT c.id)::int AS comments
    FROM users u
    LEFT JOIN posts    p ON p.author_id = u.id
    LEFT JOIN comments c ON c.author_id = u.id
   GROUP BY u.id
`;

stats[0].posts;     // number — typed from the generic
stats[0].user_id;   // string
```

The generic doesn't *validate* — you're declaring what you expect the
driver to hand back. If the SQL is wrong, the runtime shape will not
match the type. For projections that need both a typed wire shape and
runtime check, layer a zod parse over the result.

### (d) Optimistic mutation type — TanStack Query from `InferCreate`

The TanStack Query mutation hook's variables type is exactly the
`Create` shape:

```ts
import type { InferCreate, InferRow } from 'forge-orm';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { User } from '@app/db/models';

type UserCreate = InferCreate<typeof User>;
type UserRow    = InferRow<typeof User>;

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation<UserRow, Error, UserCreate, { previous?: UserRow[] }>({
    mutationFn: (data) => api.users.create(data),
    onMutate: async (data) => {
      await qc.cancelQueries({ queryKey: ['users'] });
      const previous = qc.getQueryData<UserRow[]>(['users']);
      qc.setQueryData<UserRow[]>(['users'], (old = []) => [
        // Optimistic row: synthesise the parts the server fills in.
        { id: `tmp-${crypto.randomUUID()}`, ...data, createdAt: new Date() } as UserRow,
        ...old,
      ]);
      return { previous };
    },
    onError: (_e, _data, ctx) => {
      if (ctx?.previous) qc.setQueryData(['users'], ctx.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
}
```

The `as UserRow` on the optimistic row is the honest gap: you're
synthesising fields the server normally fills (`id`, `createdAt`), and
TS can't prove they match. The cast is local to the optimistic update
and gets replaced on `onSettled`.

### (e) Polymorphic content blocks with discriminant

The embed pattern from above, applied at the read site:

```ts
const Page = model('pages', {
  id:     f.id(),
  blocks: f.embedMany(() => Block),
});

type Block = Row<typeof Page>['blocks'][number];
// { kind: 'text' | 'image'; content: string | null; src: string | null; alt: string | null }

function renderBlock(b: Block): string {
  switch (b.kind) {
    case 'text':  return b.content ?? '';
    case 'image': return `<img src="${b.src}" alt="${b.alt}">`;
  }
}
```

The narrowing works because `kind` is `f.enumOf([...] as const)`, which
gives back a literal union — TypeScript narrows `b` per branch.

The flat-embed cost: `content` / `src` / `alt` are all *optional* on
every variant, because the embed has no way to express
"required-when-`kind === 'text'`" through `f.embed`. Apply that
constraint at the IO boundary (zod again is a good fit) if you need it
runtime-enforced.

---

## Limitations

The honest gaps in the type surface, called out so you know what
forge does and does not catch:

* **No type-level FK correctness.** `userId: f.objectId()` is just a
  `string` to the type system; forge doesn't know it must reference
  `User.id`. The `.relate()` declaration ties them together at runtime
  (cascade, nested writes), but a typo in the FK column value at create
  time will fail with a DB-side FK violation, not at compile time.
* **No type-level unique-combo check beyond `WhereUnique`.** The
  composite-unique synthetic-key form (`orgId_slug: { … }`) is
  recognised, but `where: { orgId_slug: { orgId } }` (missing `slug`)
  typechecks and only fails at runtime.
* **Required fields aren't surfaced on `Create`.** Every scalar is
  marked optional; required-vs-defaulted is enforced at the DB layer
  (NOT NULL → driver error). See section B2 of `typesafety-demo.ts`.
* **Generated columns slip through the input check.** `dbgenerated`
  fields are read-only at runtime but currently land on `Create` and
  `Update` as writable optional. The wrapper strips them before
  executing.
* **Relation-walk recursion is capped at 10.** Past that, nested
  `include` / `select` args fall back to `LooseRelationArgs` (loose).
  This is a TS-perf cap (`Decrement<N>` only counts to 10); deep
  cycles still resolve, they just type loosely past depth 10.
* **`f.json()` is `any`, not `unknown`.** Convenience win at the cost
  of type-checking inside the JSON. Use `f.embed(() => Type)` when you
  know the shape.
* **`f.string()` doesn't take a TypeScript generic.** Narrow string
  columns to a literal set via `f.enumOf([...] as const)`; cast at the
  call site if you have a wider domain type you want to thread through.

These trade-offs are deliberate, not bugs. The companion file
`typesafety-demo.ts` at the repo root enumerates the assertions that
*do* hold (19 strict, plus 5 against a custom consumer schema) — run
`npx tsc --noEmit --strict typesafety-demo.ts` from the repo root and
zero errors means every guarantee in this doc held at the last commit.

---

## Where to go next

* **[README — Type safety](../README.md#type-safety)** — the chapter
  this file expands on.
* **[README — Defining a schema](../README.md#defining-a-schema)** —
  field builders, relations, and the modifiers (`.optional()`,
  `.default()`, `.updatedAt()`) that drive the inferred shapes.
* **[docs/JSON-PATH.md](./JSON-PATH.md)** — type story for `f.json()`
  / `f.embed()` columns and the null markers.
* **[docs/BACKEND.md](./BACKEND.md)** — sharing typed shapes across
  hyper-express / Fastify / NestJS / Bun handlers and pools.
* **`typesafety-demo.ts`** (repo root) — the runnable verification of
  every claim in this file.
