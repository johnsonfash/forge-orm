# Brand types

TypeScript is structurally typed — a `string` `userId` accepts a `string` `postId` without complaint. Brand types add nominal typing, making each id distinct at compile time. This page covers the brand pattern, the zod `.brand<'UserId'>()` integration, and how branded ids flow through forge-orm's `Row<Model>` inference.

The motivation is the bug nobody catches in code review:

```ts
async function getUserPosts(userId: string, postId: string) { … }

const user = await db.user.findFirst();
const post = await db.post.findFirst();

// Wrong argument order — typechecks because both are `string`.
await getUserPosts(post!.id, user!.id);
```

Both ids are `string` so the compiler can't see the swap. Brand the ids
(`UserId` distinct from `PostId`) and the same call fails to typecheck.
No runtime cost, no codegen, no change to the on-disk shape.

## Contents

* [Why structural typing isn't enough](#why-structural-typing-isnt-enough)
* [The brand pattern](#the-brand-pattern)
* [zod's `.brand<…>()`](#zods-brand)
* [Branded ids on a forge model](#branded-ids-on-a-forge-model)
* [Runtime cost is zero](#runtime-cost-is-zero)
* [Equality and casting](#equality-and-casting)
* [Brand types and `Row<typeof Model>`](#brand-types-and-rowtypeof-model)
* [Brand types for FK relations](#brand-types-for-fk-relations)
* [Multi-brand unions](#multi-brand-unions)
* [Branded numbers — `Cents`, `Milliseconds`](#branded-numbers--cents-milliseconds)
* [Branded dates — `BusinessDay`, `Instant`](#branded-dates--businessday-instant)
* [JSON serialization erases the brand](#json-serialization-erases-the-brand)
* [Branded values in HTTP responses](#branded-values-in-http-responses)
* [Performance](#performance)
* [Four worked examples](#four-worked-examples)
* [Limitations](#limitations)
* [Where to go next](#where-to-go-next)

---

## Why structural typing isn't enough

TypeScript decides type compatibility by shape, not by name. Aliases
with the same underlying type are indistinguishable:

```ts
type UserId = string;
type PostId = string;

function loadUser(id: UserId) { … }

const post: PostId = 'p_xyz';
loadUser(post);   // ✅ typechecks — UserId and PostId are both `string`
```

The aliases are documentation, not safety. The same hole appears on
`number` (cents vs dollars), `Date` (business day vs instant), and
`BigInt` (token amount vs row count). The brand pattern closes it by
adding a phantom property that exists for the type checker only.

---

## The brand pattern

A brand is an intersection with an object that carries a literal tag:

```ts
type UserId = string & { readonly __brand: 'UserId' };
type PostId = string & { readonly __brand: 'PostId' };

const u = 'u_123' as UserId;
const p = 'p_xyz' as PostId;

function loadUser(id: UserId) { … }

loadUser(u);          // ✅
loadUser(p);          // ❌ Argument of type 'PostId' is not assignable to 'UserId'
loadUser('u_123');    // ❌ Type 'string' is not assignable to 'UserId'
```

A few details to get right:

* **`readonly`** keeps the brand from drifting through `Object.assign` or
  spread, and signals "witness, not data."
* **The property name is conventional** — `__brand`, `_brand`, `__tag`,
  pick one and stay consistent across the project.
* **The tag is a string literal.** `'UserId'`, not `string`. Without
  the literal, two brands collapse into the same shape.
* **The brand is not constructible.** `{ __brand: 'UserId' } as UserId`
  fails — the intersection requires the string side too. The only way
  to materialise a brand is to cast a raw value at a trusted boundary.

A common helper to make declarations one-liners:

```ts
type Brand<T, K extends string> = T & { readonly __brand: K };

type UserId  = Brand<string, 'UserId'>;
type PostId  = Brand<string, 'PostId'>;
type Cents   = Brand<number, 'Cents'>;
```

forge does not ship a `Brand<>` helper — consumer projects pick the
name (`Opaque<>`, `Nominal<>`, `Tagged<>`). Whichever you pick, export
it from one module and import everywhere; duplicate declarations
produce distinct types even with identical bodies.

---

## zod's `.brand<…>()`

zod has built-in support that pairs with the brand pattern cleanly:

```ts
import { z } from 'zod';

const UserIdSchema = z.string().uuid().brand<'UserId'>();
const PostIdSchema = z.string().uuid().brand<'PostId'>();

type UserId = z.infer<typeof UserIdSchema>;
// string & z.BRAND<'UserId'>

type PostId = z.infer<typeof PostIdSchema>;
// string & z.BRAND<'PostId'>

const u = UserIdSchema.parse('a1b2c3d4-…');   // UserId — runtime-validated UUID
const p = PostIdSchema.parse('f5e6d7c8-…');   // PostId

function loadUser(id: UserId) { … }
loadUser(u);                                    // ✅
loadUser(p);                                    // ❌ types differ
```

`.brand<K>()` is the same pattern under a different name — zod uses
`z.BRAND<K>` instead of `__brand`, but the structural effect is
identical. Two zod-branded values from different schemas are not
assignable.

The win over a hand-rolled cast: `parse` is a *runtime* check. The
string actually has to be a valid UUID, or `parse` throws. The brand
only appears on values that survived validation — no gap between "I
said this is a UserId" and "this is actually a UserId."

Use zod-branded types as the canonical wire format on every HTTP
boundary — see [Branded values in HTTP responses](#branded-values-in-http-responses).

---

## Branded ids on a forge model

forge field builders return concretely-typed `Field<JsType, Tag>` —
`f.id()` is `Field<string, 'id'>`, `f.string()` is `Field<string, 'string'>`,
etc. They don't accept a TS generic to substitute the JsType (see
[TYPES.md](./TYPES.md#custom-types-on-a-field) on that trade-off). So
branding flows through *after* inference, by casting at the seam where
rows enter your domain. Model the field as the plain scalar; type the
brand on the row.

```ts
import { f, model, rel } from 'forge-orm';
import type { Brand } from './brand';

export type UserId = Brand<string, 'UserId'>;
export type PostId = Brand<string, 'PostId'>;

export const User = model('users', {
  id:    f.id(),              // string at the type layer
  email: f.string(),
});

export const Post = model('posts', {
  id:       f.id(),
  authorId: f.objectId(),     // string at the type layer
  title:    f.string(),
}).relate(() => ({
  author: rel.one('user', { on: 'authorId', refs: 'id' }),
}));
```

At the repository boundary, narrow:

```ts
import type { InferRow } from 'forge-orm';

type RawUser = InferRow<typeof User>;
type RawPost = InferRow<typeof Post>;

export type DomainUser = Omit<RawUser, 'id'> & { id: UserId };
export type DomainPost = Omit<RawPost, 'id' | 'authorId'> & {
  id:       PostId;
  authorId: UserId;
};

export async function findUser(id: UserId): Promise<DomainUser | null> {
  const row = await db.user.findUnique({ where: { id } });
  return row as DomainUser | null;
}
```

The cast is the honest one-time gap. forge's IR doesn't know `users.id`
is the same brand as `posts.authorId`; the repository module asserts
it. Every consumer sees branded ids and the brand travels through the
codebase without further casts.

---

## Runtime cost is zero

The brand exists only at compile time. `tsc` and esbuild strip the
intersection from the emitted JS — the runtime value is the underlying
scalar:

```ts
const u: UserId = 'u_123' as UserId;
console.log(typeof u);              // 'string'
console.log(u + '_suffix');         // 'u_123_suffix'
console.log(u === 'u_123');         // true
```

That means: no serialisation cost (a branded value JSON-encodes the
same as its scalar), no comparison cost (`===` is unchanged), no
memory cost (no wrapper object). The brand is a witness to the type
checker, and that's all it is.

---

## Equality and casting

Cast a raw value into a brand at the boundary where the brand is
justified — and only there. Three canonical cast sites:

**1. The zod parse boundary** (strongest — the runtime check ran):

```ts
const body = userCreateSchema.parse(request.body);
// body.id is UserId — zod did the branding
```

**2. The repository boundary** (forge round-trips the same value we
asked for):

```ts
async function findUser(id: UserId): Promise<DomainUser | null> {
  return db.user.findUnique({ where: { id } }) as DomainUser | null;
}
```

**3. A hand-rolled factory** (same shape as zod, less ergonomic):

```ts
export function userId(raw: string): UserId {
  if (!/^[0-9a-f]{8}-…/.test(raw)) throw new Error(`bad UserId: ${raw}`);
  return raw as UserId;
}
```

The cast you do **not** want is unbranded `as` anywhere outside a
parser, factory, or repository boundary:

```ts
loadUser(p as any);              // ❌ throws the brand away
const u = 'whatever' as UserId;  // ❌ no runtime check
```

These compile, but the brand becomes ceremony. If `as UserId` shows up
in a feature module, it's papering over a real type error.

At runtime a `UserId` compares equal to its raw string (they *are* the
same string). The compiler refuses `userId === postId` directly, which
is the point.

---

## Brand types and `Row<typeof Model>`

forge's `Row<typeof Model>` produces the resolved row shape using the
field builders' declared types. Since `f.id()` returns
`Field<string, 'id'>`, the inferred row's `id` is `string`, not your
brand. The brand has to be layered on top via `Omit + intersection`:

```ts
import type { InferRow } from 'forge-orm';

type RawUser = InferRow<typeof User>;
// { id: string; email: string; … }

type User = Omit<RawUser, 'id'> & { id: UserId };
// { id: UserId; email: string; … }
```

For models with multiple branded ids, spell each out — a generic
`BrandIds<R, 'id' | 'authorId', PostId | UserId>` collapses the brands
to a union, which is rarely what you want:

```ts
type Post = Omit<RawPost, 'id' | 'authorId'> & {
  id:       PostId;
  authorId: UserId;
};
```

`InferCreate` and `InferUpdate` (see [TYPES.md](./TYPES.md#per-helper-reference-infercreate--inferupdate--inferwhere--))
benefit from the same treatment:

```ts
type UserCreate = Omit<InferCreate<typeof User>, 'id'> & { id?: UserId };
type UserUpdate = Omit<InferUpdate<typeof User>, 'id'>;
```

The pattern stays mechanical; the brand travels through every
input/output shape your service layer exports.

---

## Brand types for FK relations

The bug the brand was designed for. Relations have two ends —
`Post.authorId` references `User.id`. Without brands, both are `string`
and you can pass a `Post.id` where a `User.id` was expected. Brand both
ends and the compiler catches it:

```ts
type User = Omit<InferRow<typeof User>, 'id'> & { id: UserId };
type Post = Omit<InferRow<typeof Post>, 'id' | 'authorId'> & {
  id:       PostId;
  authorId: UserId;
};

type PostCreate = Omit<InferCreate<typeof Post>, 'id' | 'authorId'> & {
  id?:      PostId;
  authorId: UserId;
};

async function createPost(data: PostCreate) {
  return db.post.create({ data });
}

const post = await findPost(somePostId);
await createPost({ authorId: post!.id, title: 'oops' });
//                ^^^^^^^^^^^^^^^^^^^ Type 'PostId' is not assignable to 'UserId'
```

The compile error is the entire point. forge's runtime would happily
write a malformed FK; the DB would fail at insert with a FK violation
that takes log-spelunking to diagnose. The brand turns it into a
single squiggle at the call site, and the pattern composes across the
whole graph (`Comment.authorId: UserId`, `Comment.postId: PostId`).

---

## Multi-brand unions

Polymorphic owners, audit-log `targetId` columns, federated identity —
columns that reference more than one table. The brand mirrors as a
union, or as a discriminated union when the kind matters at the call
site:

```ts
type ActorId = UserId | AdminId | ServiceAccountId;

// Plain union when every consumer treats the id opaquely:
type AuditEntry = { id: AuditEntryId; actorId: ActorId; action: string };

// Discriminated when the consumer needs to dispatch:
type Actor =
  | { kind: 'user';    id: UserId }
  | { kind: 'admin';   id: AdminId }
  | { kind: 'service'; id: ServiceAccountId };

function loadActor(a: Actor) {
  switch (a.kind) {
    case 'user':    return db.user.findUnique({ where: { id: a.id } });
    case 'admin':   return db.admin.findUnique({ where: { id: a.id } });
    case 'service': return db.serviceAccount.findUnique({ where: { id: a.id } });
  }
}
```

The discriminated form pays once where the kind is known (parser,
route handler) and carries it through. The plain union is cheaper if
no consumer needs to dispatch on kind.

---

## Branded numbers — `Cents`, `Milliseconds`

The bug repeats on numbers. `amount: number` accepts both dollars and
cents:

```ts
function charge(amount: number) { … }

const priceCents = 1099;     // $10.99
const priceUsd   = 10.99;

charge(priceCents);   // typechecks — but is it cents or dollars?
charge(priceUsd);     // also typechecks
```

Brand the unit:

```ts
type Cents       = Brand<number, 'Cents'>;
type UsdDollars  = Brand<number, 'UsdDollars'>;
type Milliseconds = Brand<number, 'Milliseconds'>;
type Seconds     = Brand<number, 'Seconds'>;

function charge(amount: Cents) { … }

const priceCents = 1099 as Cents;
const priceUsd   = 10.99 as UsdDollars;

charge(priceCents);   // ✅
charge(priceUsd);     // ❌ Type 'UsdDollars' is not assignable to 'Cents'
```

Conversion helpers pay for the brand by making every cross-unit step
explicit:

```ts
export const dollarsToCents = (d: UsdDollars): Cents =>
  Math.round(d * 100) as Cents;

export const centsToDollars = (c: Cents): UsdDollars =>
  (c / 100) as UsdDollars;
```

Without the brand, `* 100` and `/ 100` scatter through the codebase;
a single missed multiplication is a $1.09 charge instead of $1.09 in
cents (or worse).

forge models money as `f.decimal({ precision, scale })`, which lands as
`string` on `Row` (see [DECIMAL.md](./DECIMAL.md) and
[TYPES.md](./TYPES.md#rowtypeof-model)). Brand the decimal-string the
same way:

```ts
type Money = Brand<string, 'Money'>;     // "1099.00", precision preserved

type Invoice = Omit<InferRow<typeof Invoice>, 'amount'> & { amount: Money };
```

This composes with a runtime decimal library — `new Decimal(invoice.amount)`
still works because at runtime `invoice.amount` is a string. The brand
only enforces "don't pass a plain string here."

---

## Branded dates — `BusinessDay`, `Instant`

`Date` is JS's most-overloaded type — a single class carries calendar
dates, wall clocks, instants, and durations as ad-hoc arithmetic.
Brand the intent:

```ts
type Instant     = Brand<Date,   'Instant'>;       // UTC point in time
type BusinessDay = Brand<string, 'BusinessDay'>;   // 'YYYY-MM-DD'
type WallClock   = Brand<Date,   'WallClock'>;     // local, no zone

type RawInvoice = InferRow<typeof Invoice>;
type Invoice = Omit<RawInvoice, 'createdAt' | 'dueDate'> & {
  createdAt: Instant;
  dueDate:   BusinessDay;
};

export function businessDay(s: string): BusinessDay {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`bad BusinessDay: ${s}`);
  return s as BusinessDay;
}
```

The win shows up the first time someone subtracts a `BusinessDay` from
an `Instant` — the compiler catches `Date - string`. Or when a function
expects a calendar day and someone passes `new Date()`, the brand
mismatch surfaces the question "what timezone is this in?" before it
ships. See [DATES.md](./DATES.md) for the wider date story; the brand
layer sits on top of whatever date library the project chooses.

---

## JSON serialization erases the brand

The brand is a TypeScript fiction. The moment you serialize, it's gone:

```ts
const u: UserId = 'u_123' as UserId;
const json = JSON.stringify({ id: u });   // '{"id":"u_123"}'

const back = JSON.parse(json);
// back.id has type `any`; UserId requires a cast
```

Every deserialization boundary needs a re-brand step. The reliable way
is a zod schema at the parse site:

```ts
const UserSchema = z.object({
  id:    z.string().uuid().brand<'UserId'>(),
  email: z.string().email().brand<'Email'>(),
});

const parsed = UserSchema.parse(JSON.parse(json));
// parsed.id is UserId; parsed.email is Email
```

zod runs the validation; the brand follows. forge itself doesn't
serialize — query results come back as the driver's already-decoded
shape. The places to worry about JSON round-trips are HTTP bodies,
message queue payloads, fixture loaders, and `f.json()` column values
(which `Row` types as `any` — see [TYPES.md](./TYPES.md#rowtypeof-model)).
Re-brand via zod at each.

---

## Branded values in HTTP responses

Narrow at the handler boundary. Every body wrapped in a zod-branded
schema, route handlers hand branded values to the service layer:

```ts
const PathSchema = z.object({
  userId: z.string().uuid().brand<'UserId'>(),
});

app.get('/users/:userId/posts', async (req, res) => {
  const { userId } = PathSchema.parse(req.params);
  const posts = await postService.findByAuthor(userId);   // (id: UserId)
  res.json(posts);
});
```

If a route forgets the parse and forwards `req.params.userId` (typed
`string`), the service refuses it at compile time — the brand surfaces
the untyped path that would otherwise look fine.

For monorepos, export the zod-branded primitives from one package and
import them frontend/backend/mobile — brand identity stays stable
across the wire. See [TYPES.md](./TYPES.md#sharing-inferred-types-across-the-monorepo)
for the layered-export pattern.

```ts
// packages/types/src/ids.ts
export const UserIdSchema = z.string().uuid().brand<'UserId'>();
export const EmailSchema  = z.string().email().brand<'Email'>();

export type UserId = z.infer<typeof UserIdSchema>;
export type Email  = z.infer<typeof EmailSchema>;
```

---

## Performance

No runtime overhead. After `tsc` runs the intersection is gone, the
runtime value is the underlying scalar, `typeof` reports the scalar's
type, JSON sees only the scalar, `Map`/`Set` key by scalar, `===`
compares scalars. The only cost is the type checker doing slightly
more work to resolve intersections — not measurable in practice;
projects with thousands of branded types compile in the same
wall-clock time as projects without.

The zod variant adds runtime cost only at the `parse` boundary, and
that cost is the validation (regex, range checks). The `.brand`
suffix is free — it tags the already-validated value, no extra check.

---

## Four worked examples

### (a) UserId vs PostId — the canonical bug

```ts
import type { InferRow, InferCreate } from 'forge-orm';

type Brand<T, K extends string> = T & { readonly __brand: K };
type UserId = Brand<string, 'UserId'>;
type PostId = Brand<string, 'PostId'>;

export type User = Omit<InferRow<typeof _User>, 'id'> & { id: UserId };
export type Post = Omit<InferRow<typeof _Post>, 'id' | 'authorId'> & {
  id:       PostId;
  authorId: UserId;
};

export type PostCreate = Omit<InferCreate<typeof _Post>, 'id' | 'authorId'> & {
  id?:      PostId;
  authorId: UserId;
};

async function createPost(data: PostCreate) {
  return db.post.create({ data }) as Promise<Post>;
}

const post = await findPost(somePostId);
await createPost({ authorId: post.id, title: 'duplicate' });
//                ^^^^^^^^^^^^^^^^^^^ ❌ Type 'PostId' is not assignable to 'UserId'

const user = await findUser(someUserId);
await createPost({ authorId: user.id, title: 'reply' });   // ✅
```

Without the brand both lines compile and the bug ships. With the
brand, the first line stops the build.

### (b) Cents as a money brand

```ts
type Cents = Brand<number, 'Cents'>;

export function cents(n: number): Cents {
  if (!Number.isInteger(n)) throw new Error(`cents must be int: ${n}`);
  return n as Cents;
}

export function dollarsToCents(d: number): Cents {
  return Math.round(d * 100) as Cents;
}

async function chargeUser(userId: UserId, amount: Cents) {
  await stripe.charges.create({ amount, customer: userId });
}

await chargeUser(someUserId, cents(1099));   // ✅
await chargeUser(someUserId, 10.99);
// ❌ Type 'number' is not assignable to 'Cents'.
```

The bug class this kills: "we charged $10.99 instead of $1.09." Every
dollars-to-cents boundary now has an explicit `dollarsToCents` call
that the reviewer sees and the compiler verifies.

### (c) zod schema producing a branded type

The boundary where untyped input becomes branded:

```ts
import { z } from 'zod';

export const UserIdSchema = z.string().uuid().brand<'UserId'>();
export const EmailSchema  = z.string().email().brand<'Email'>();
export const CentsSchema  = z.number().int().nonnegative().brand<'Cents'>();

export type UserId = z.infer<typeof UserIdSchema>;
export type Email  = z.infer<typeof EmailSchema>;
export type Cents  = z.infer<typeof CentsSchema>;

export const ChargeRequestSchema = z.object({
  userId: UserIdSchema,
  email:  EmailSchema,
  amount: CentsSchema,
});

export type ChargeRequest = z.infer<typeof ChargeRequestSchema>;
// { userId: UserId; email: Email; amount: Cents }

// At the HTTP boundary:
app.post('/charges', async (req, res) => {
  const charge = ChargeRequestSchema.parse(req.body);
  // charge.userId: UserId  (UUID-validated)
  // charge.email:  Email   (email-validated)
  // charge.amount: Cents   (int + nonnegative)

  await chargeService.run(charge);
});
```

`parse` does the runtime check; the brand is the receipt. The route
handler hands fully-branded values to the service, and every function
in the call chain takes branded parameters from here on.

For drift detection against the forge model, use `satisfies`:

```ts
import type { InferCreate } from 'forge-orm';

const UserCreateSchema = z.object({
  id:    UserIdSchema.optional(),
  email: EmailSchema,
}) satisfies z.ZodType<InferCreate<typeof User>>;
```

Drift the model — add a required column — and the zod stops satisfying
the constraint. See [RUNTIME-VALIDATION.md](./RUNTIME-VALIDATION.md)
for the wider pattern of zod alongside forge models, and
[TYPES.md → Five worked patterns (b)](./TYPES.md#five-worked-patterns)
for the bare zod-with-forge story without brands.

### (d) Decimal as a branded BigNumber

forge's `f.decimal({ precision, scale })` lands as `string` on `Row` —
JS numbers can't represent every decimal, so the wire format preserves
precision and arithmetic goes through a decimal library:

```ts
import Decimal from 'decimal.js';

type Money = Brand<string, 'Money'>;

export function money(d: Decimal | string): Money {
  return new Decimal(d).toFixed(2) as Money;
}

export function moneyToDecimal(m: Money): Decimal {
  return new Decimal(m);
}

type Invoice = Omit<InferRow<typeof Invoice>, 'amount'> & { amount: Money };

const invoice = await findInvoice(invoiceId);
if (invoice) {
  const subtotal = moneyToDecimal(invoice.amount);
  const tax      = subtotal.times('0.075');
  const total    = money(subtotal.plus(tax));   // re-brand at the seam
}
```

The brand stops two bug classes: passing a raw `'10.99 USD'` or `'10.9'`
where `Money` is expected (the `money()` factory normalises to two
decimal places), and arithmetic on the raw string (`invoice.amount + 100`
is a concat bug — the brand forces the explicit `moneyToDecimal` unwrap).

---

## Limitations

Calling out the gaps so the brand earns honest trust:

* **forge doesn't surface the brand on field builders.** `f.id()` is
  `Field<string, 'id'>` — the brand lives outside the schema, layered
  via `Omit + intersection`. The cast lives in the repository module,
  once.
* **`as` casts past the boundary are silent.** Anywhere outside a
  parser, factory, or repository seam, an `as UserId` is the developer
  asserting an unchecked invariant. Code review can find these; the
  compiler cannot.
* **Brand identity depends on declaration site.** Two files each
  declaring `type Brand<T, K> = T & { __brand: K }` produce two
  structurally-identical-but-not-equal `Brand<>` aliases — TS treats
  them as the same shape only because the body matches exactly. Export
  the helper from one module to keep brand identity stable.
* **JSON erases the brand.** Every deserialization step needs a
  re-brand. zod schemas at the parse site are the standard answer.
* **The brand is a witness, not a runtime check.** The runtime value is
  still the raw scalar. If a value got cast to `UserId` without the
  zod check, the brand says "I trust this is a UserId" but the runtime
  has no idea. Bind the cast to a validating boundary.
* **No exhaustiveness check on brand unions.** `ActorId = UserId | AdminId`
  doesn't tell TypeScript which one a given value is; you need a
  discriminated union (`{ kind: 'user'; id: UserId } | …`) to narrow.
* **Brand doesn't compose with forge's relation walker.** `include`
  on a relation returns the unbranded `Row`. The repository layer
  re-brands the included relation — the brand doesn't propagate
  automatically through `Resolve<F, R, Args, S>`.

These are honest costs. Each one is a fixed-shape, declare-once gap
you accept at the repository boundary and forget about. The branded
domain types make every other line in the codebase precise.

---

## Where to go next

* **[TYPES.md](./TYPES.md)** — the full inference surface that branded
  types layer on top of. `InferRow`, `InferCreate`, `Row<typeof M>`,
  and the `Omit + intersection` pattern this doc relies on.
* **[RUNTIME-VALIDATION.md](./RUNTIME-VALIDATION.md)** — zod alongside
  forge models; the parse boundary where brands originate.
* **[DECIMAL.md](./DECIMAL.md)** — the precision story for `f.decimal()`,
  the natural home for a `Money` brand on top of a BigNumber library.
* **[DATES.md](./DATES.md)** — `Instant` vs `BusinessDay` vs wall-clock,
  where the brand kills the timezone-arithmetic class of bugs.
* **[MODEL.md](./MODEL.md)** — the `model('users', { … })` declaration
  surface that brand types attach to via `InferRow`.
* **[RELATIONS.md](./RELATIONS.md)** — the FK columns that brand types
  protect against accidental cross-model swap.
