# Runtime validation with zod

forge-orm gives you static types at compile time; zod gives you runtime narrowing at the trust boundary (HTTP, webhook, queue). This page covers the two-schema asymmetry (DB shape vs API input shape), the patterns for keeping zod schemas in sync with forge `Row<Model>`, the transform layer (string → Date, string → Decimal), brand types, and the OpenAPI / form-lib integration.

Related deep-dives:

* [TYPES.md](./TYPES.md) — `Row<typeof Model>`, `Infer*`, the inference surface.
* [MODEL.md](./MODEL.md) — the field catalogue and what `f.*` produces at runtime.
* [BACKEND.md](./BACKEND.md) — wiring forge-orm into a Node service.
* [SECURITY.md](./SECURITY.md) — input handling, secrets, and the threat model.

---

## Contents

* [Why runtime validation](#why-runtime-validation)
* [Where to validate](#where-to-validate)
* [The zod stack in one screen](#the-zod-stack-in-one-screen)
* [forge → zod sync patterns](#forge--zod-sync-patterns)
* [The asymmetry — DB row vs API input](#the-asymmetry--db-row-vs-api-input)
* [Building variants with `.pick` / `.omit` / `.partial`](#building-variants-with-pick--omit--partial)
* [HTTP boundary — `req.body = schema.parse(req.body)`](#http-boundary--reqbody--schemaparsereqbody)
* [Queue boundary — BullMQ job processors](#queue-boundary--bullmq-job-processors)
* [`.transform` — string → Date, string → Decimal](#transform--string--date-string--decimal)
* [Brand types](#brand-types)
* [zod 4 features worth knowing](#zod-4-features-worth-knowing)
* [Error mapping — zod → HTTP 400](#error-mapping--zod--http-400)
* [OpenAPI generation from zod](#openapi-generation-from-zod)
* [Form libraries — react-hook-form + zodResolver](#form-libraries--react-hook-form--zodresolver)
* [Four worked examples](#four-worked-examples)
* [Common mistakes](#common-mistakes)

---

## Why runtime validation

TypeScript types vanish at `tsc` exit. The compiler tells you that `req.body.email` is a `string`; the runtime hands you whatever the client sent — `null`, an object, a number, a 64 KB log line attempting to crash your JSON parser. The cast `req.body as CreateUserInput` is a lie everyone agrees to until the first malformed payload reaches the database.

forge-orm's typed surface (`Row<typeof User>`, `InferCreate<typeof User>`, the per-call narrowing of `db.user.findMany`) covers the path from your schema to your code. It does not cover the path from the network to your code. That edge needs a parse step — a function that takes `unknown`, runs structural and semantic checks, and either throws or returns a value of a known type.

zod is one of several runtime validators in the TypeScript ecosystem. The patterns in this page apply equally to valibot, arktype, io-ts, or `@sinclair/typebox`; zod gets named because it has the largest ecosystem (OpenAPI generators, ORM-zod bridges, form resolvers) and because forge-orm's tests already use it where input parsing is needed. If you've adopted a different validator, the structural advice — separate Create/Update/Read schemas, parse at the trust boundary, transform strings into the runtime types your code uses — still holds.

The mental model is **trust narrowing**. Past the parse call, the variable's TypeScript type is no longer aspirational — the value matches the type because zod just checked it. Before the parse call, treat the input as `unknown`, even if some upstream cast claims otherwise.

You do not need zod for DB output. `db.user.findMany(...)` returns rows that forge-orm's adapter just decoded from the driver's row format; the TS types match because the schema is the source of both the DDL and the inference. Adding a zod re-parse on the way out is wasted CPU and obscures bugs — if a row from the database fails a runtime check, the schema and the data are out of sync, and a 400 response is the wrong tool for that.

---

## Where to validate

Three categories. Each is a place where untyped data crosses into typed code.

**1. HTTP request bodies, query strings, and route params.** Every endpoint that takes input. `req.body`, `req.query`, `req.params` start their lives as `unknown` (and most Express-style frameworks lie about the type). Parse on entry to the handler; pass the parsed value downstream.

**2. Webhook payloads.** Stripe, GitHub, Slack — every webhook is an HTTP request from an outside system you don't control. Verify the signature *first*, then parse the body. Doing it in the other order means an attacker who can guess your endpoint can ship malformed JSON to your zod errors and observe behaviour.

**3. Queue messages.** BullMQ, SQS, RabbitMQ, Kafka. The producer encoded the job payload; the consumer reads it back as JSON. Even if both ends are your own code, you cannot assume the producer's TS types still match — old jobs sit in the queue across deploys, and a schema change between the two halves manifests as a runtime cast that silently wins until a field is actually read.

You **do not** need zod on the way out of the database. The driver gave forge-orm typed values; forge-orm's `Row<typeof Model>` matches. Validating DB output mostly catches bugs in *your migrations*, and you want those caught by the doctor (`db.$doctor()` — see [DOCTOR.md](./DOCTOR.md)) or by tests, not by a 500 in production.

You also don't need it for internal function-to-function calls inside your own service. TypeScript types are sufficient there; adding zod parses on internal boundaries is overhead that adds no safety.

---

## The zod stack in one screen

The pieces you use in 95% of cases:

```ts
import { z } from 'zod';

const Email = z.string().trim().toLowerCase().email();

const CreateUser = z.object({
  email: Email,
  name:  z.string().min(1).max(120),
  age:   z.number().int().min(0).max(150).optional(),
  role:  z.enum(['member', 'admin']).default('member'),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

type CreateUser = z.infer<typeof CreateUser>;
//   ^ { email: string; name: string; age?: number; role: 'member' | 'admin'; metadata?: ... }

const parsed = CreateUser.parse(req.body);   // throws ZodError on failure
const safe   = CreateUser.safeParse(req.body); // { success: true, data } | { success: false, error }
```

Five primitives carry most of the weight:

* `z.object({...})` — the structural unit.
* `z.string()`, `z.number()`, `z.boolean()`, `z.date()` — leaves.
* `.optional()` — *the property may be absent or undefined*.
* `.nullable()` — *the value may be null*.
* `.default(...)` — *if absent, substitute; the type becomes required after parse*.

Three modifiers that change the shape:

* `.refine((v) => v % 2 === 0, 'must be even')` — predicate; rejects without changing the type.
* `.transform((v) => new Date(v))` — runtime conversion; **changes the output type**.
* `.pipe(...)` — chain a parse step (e.g. `z.string().pipe(z.coerce.number())`).

That covers most schemas. The rest of this page is about how to apply them to forge models, where to draw the line between DB shape and API shape, and how to wire them into the boundaries that need them.

---

## forge → zod sync patterns

The hardest part of using zod with an ORM is keeping the two definitions in sync. The forge model is the source of truth for the DB; the zod schema is the source of truth for what HTTP will accept. They overlap but are not identical (see [the asymmetry](#the-asymmetry--db-row-vs-api-input)). Three patterns, in increasing order of how much glue you write.

### Pattern A — hand-write zod, align via TS satisfies

The simplest. Write the zod schema by hand; use TypeScript to assert that its output matches a subset of `Row<typeof Model>`.

```ts
import { z } from 'zod';
import type { Row, InferCreate } from 'forge-orm';
import { User } from './schema';

const CreateUser = z.object({
  email: z.string().email(),
  name:  z.string().min(1),
  age:   z.number().int().optional(),
});

// Compile-time check: the parsed value is a valid InferCreate<typeof User>.
type _CheckShape = z.infer<typeof CreateUser> extends InferCreate<typeof User>
  ? true
  : never;

const _check: _CheckShape = true; // fails to compile if shapes diverge
```

This catches most drift. Add a non-null column to the model — `InferCreate` widens to require it — `_check` fails to compile until the zod schema is updated. It does not catch the reverse case (zod requires a field the model doesn't have); for that, write the dual check:

```ts
type _Mutual = InferCreate<typeof User> extends z.infer<typeof CreateUser>
  ? true : never;
const _check2: _Mutual = true;
```

In practice the first check is the one that matters — the model is the source of truth, so the zod schema must keep up.

### Pattern B — derive from `Row<typeof Model>` with a small mapper

You can write a one-off function that walks the model and produces a zod schema. forge-orm doesn't ship one (intentionally — the API/DB asymmetry below means a generic mapper is wrong half the time), but the pattern is short:

```ts
import { z, ZodTypeAny } from 'zod';
import type { FieldKind, AnyModel } from 'forge-orm';

function zodForField(kind: FieldKind, nullable: boolean): ZodTypeAny {
  let base: ZodTypeAny;
  switch (kind) {
    case 'id': case 'string': case 'text': case 'uuid':
      base = z.string(); break;
    case 'int': case 'bigint':
      base = z.number().int(); break;
    case 'float': case 'decimal':
      base = z.number(); break;
    case 'boolean':
      base = z.boolean(); break;
    case 'dateTime':
      base = z.coerce.date(); break;
    case 'enum':
      base = z.string(); break;            // refine externally with the values list
    case 'json':
      base = z.unknown(); break;
    default:
      base = z.unknown();
  }
  return nullable ? base.nullable() : base;
}

export function irToZod<M extends AnyModel>(model: M) {
  const shape: Record<string, ZodTypeAny> = {};
  for (const [name, field] of Object.entries(model._fields)) {
    shape[name] = zodForField(field.kind, field.nullable ?? false);
  }
  return z.object(shape);
}
```

What this *doesn't* know:

* That `f.id()` is filled in by the wrapper at create time — your `Create` schema should `.omit(['id'])`.
* That `f.dateTime({ default: 'now' })` should be omitted from `Create` (server-set), required on `Read`.
* That `f.enumOf('a', 'b', 'c')` should be `z.enum(['a','b','c'])`, not `z.string()`.
* That `f.objectId()` should be a brand type, not a raw string (see [Brand types](#brand-types)).

So Pattern B gets you 80% of the way to a `Read` schema, and 0% of the way to a `Create` schema. Useful as scaffolding; don't ship it as your only validator.

### Pattern C — third-party ORM-zod bridges

For Prisma there is `zod-prisma`. For Drizzle there is `drizzle-zod`. forge-orm has no first-party equivalent today; the right path if you want one is to generate at build time from the `model()` calls (read `_fields`, write `.ts` files alongside) rather than at runtime.

The lesson from the bridges in other ecosystems is that auto-generation is most useful for the `Read` schema (the wire shape of a row returned by the API) and least useful for the `Create` schema (which has rules — required vs server-set, defaults, refinements — that don't live in the DB schema). Treat any auto-gen as a starting point you hand-edit, not a finished product.

---

## The asymmetry — DB row vs API input

This is the single biggest reason to keep the zod schema separate from the model. The DB and the API have different rules about what is required, what is allowed, and what is server-set.

Consider this model:

```ts
const User = model('users', {
  id:         f.id(),
  email:      f.string().unique(),
  name:       f.string(),
  role:       f.enumOf('member', 'admin', 'owner').default('member'),
  created_at: f.dateTime().default('now'),
  updated_at: f.dateTime().updatedAt(),
  deleted_at: f.dateTime().nullable(),
});
```

What `forge` thinks each field is, in each operation:

| Field | `Create` (forge insert) | `Update` (forge patch) | `Read` (forge select) | **`POST /users` input** | **`PATCH /users/:id` input** |
|---|---|---|---|---|---|
| `id` | Optional (wrapper-set) | Forbidden | Required | Forbidden | Forbidden |
| `email` | Required | Optional | Required | Required, **email format**, **trim/lowercase** | Optional, **email format** |
| `name` | Required | Optional | Required | Required, **min 1**, **max 120** | Optional, **min 1**, **max 120** |
| `role` | Optional (default) | Optional | Required | Forbidden (admin-only) | Forbidden (admin-only) |
| `created_at` | Optional (default) | Forbidden | Required | Forbidden | Forbidden |
| `updated_at` | Forbidden (auto) | Forbidden (auto) | Required | Forbidden | Forbidden |
| `deleted_at` | Optional | Optional | Required | Forbidden | Forbidden |

Three columns matter:

* `forge Create` (column 1) is what `db.user.create({ data })` accepts. Some fields are required, some are server-set; the type is `InferCreate<typeof User>`.
* `POST /users input` (column 4) is what your HTTP handler accepts from a client. The set of allowed keys is *smaller* than `InferCreate` (no `role` from a self-signup endpoint), and the per-field rules are *stricter* (the DB takes any non-null string for email; HTTP requires a valid address).
* `PATCH /users/:id input` (column 5) is different again. Most fields are now optional; some are still forbidden (admin-only, server-set, soft-delete-flag).

A single zod schema cannot serve all three. You write at least two — usually three — per resource:

```ts
const UserCreate = z.object({
  email: z.string().trim().toLowerCase().email(),
  name:  z.string().trim().min(1).max(120),
});

const UserUpdate = UserCreate.partial();

const UserRead = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  role: z.enum(['member', 'admin', 'owner']),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  deleted_at: z.coerce.date().nullable(),
});

const UserAdminCreate = UserCreate.extend({
  role: z.enum(['member', 'admin', 'owner']).default('member'),
});
```

`UserCreate` and `UserUpdate` are for HTTP. `UserRead` is for OpenAPI documentation (and, if you must, for parsing responses on the *client* side — not on the server). `UserAdminCreate` is the admin variant with the `role` field unlocked.

The point: don't ask "what's the zod schema for `User`?" Ask "what's the zod schema for `POST /users` from an unauthenticated signup form?" Each endpoint gets the schema that matches its trust boundary.

---

## Building variants with `.pick` / `.omit` / `.partial`

zod's combinators let you derive variants without re-writing fields. The common operations:

```ts
const Base = z.object({
  id:       z.string(),
  email:    z.string().email(),
  name:     z.string(),
  role:     z.enum(['member', 'admin', 'owner']),
  password: z.string().min(8),
});

// Drop fields
const Public = Base.omit({ password: true });

// Keep only some fields
const Identity = Base.pick({ id: true, email: true });

// All fields optional
const Patch = Base.partial();

// Some fields optional, others required
const PatchEmailOnly = Base.partial().required({ email: true });

// Add fields
const WithToken = Base.extend({ token: z.string() });

// Merge two schemas
const Combined = Public.merge(WithToken);
```

A common pipeline: define the "everything" schema, then derive Create / Update / Public by combinator:

```ts
const _UserFields = z.object({
  id:        z.string(),
  email:     z.string().email(),
  name:      z.string().min(1).max(120),
  password:  z.string().min(8),
  role:      z.enum(['member', 'admin', 'owner']),
  created_at: z.coerce.date(),
});

export const UserCreate = _UserFields.omit({ id: true, created_at: true, role: true });
export const UserUpdate = UserCreate.partial();
export const UserPublic = _UserFields.omit({ password: true });
```

`UserCreate` is what the signup endpoint accepts. `UserUpdate` is what the PATCH endpoint accepts. `UserPublic` is what gets sent back over the wire (and into the OpenAPI doc). The internal field `password` never leaks out.

---

## HTTP boundary — `req.body = schema.parse(req.body)`

The pattern is identical across hyper-express, Express, Fastify, Hono, Koa. Three steps: parse, narrow, hand off.

```ts
import { z } from 'zod';
import { HyperExpress } from 'hyper-express';

const app = new HyperExpress.Server();

const CreateUserBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  name:  z.string().min(1).max(120),
});

app.post('/v1/users', async (req, res) => {
  const body = CreateUserBody.parse(await req.json()); // throws ZodError on bad input
  const user = await db.user.create({ data: body });
  res.status(201).json({ data: user });
});
```

A few refinements for production use:

**Wrap parse in a helper**. Every endpoint will do the same thing; centralise the catch:

```ts
async function parseBody<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
  const raw = await req.json();
  const result = schema.safeParse(raw);
  if (!result.success) throw new HttpError(400, 'invalid_input', result.error.format());
  return result.data;
}
```

Then handlers stay short:

```ts
app.post('/v1/users', async (req, res) => {
  const body = await parseBody(req, CreateUserBody);
  const user = await db.user.create({ data: body });
  res.status(201).json({ data: user });
});
```

**Parse `req.query` and `req.params` too**. Query strings are always `string | string[]`; if your endpoint takes `?limit=20`, you need to coerce:

```ts
const ListQuery = z.object({
  limit:  z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  status: z.enum(['active', 'archived']).optional(),
});
```

`z.coerce.number()` runs `Number(input)` before validating. It's the right tool for query strings and form-encoded bodies; it's the *wrong* tool for JSON bodies (where a number that arrives as a string is usually a client bug you want to surface).

**One parse per endpoint, not per middleware**. Some frameworks suggest validation middleware that runs before the handler. It works, but it scatters the schema definition across files. Keep the schema next to the handler; it's documentation for the handler.

---

## Queue boundary — BullMQ job processors

The producer wrote a job payload; the consumer reads it back as JSON. Both ends are your code, but they may not be the same version of your code — old jobs sit in the queue across deploys, and a field rename between v1 and v2 of the producer breaks v2 of the consumer if you skip validation.

```ts
import { Queue, Worker } from 'bullmq';
import { z } from 'zod';

const SendEmailJob = z.object({
  user_id: z.string(),
  template: z.enum(['welcome', 'password_reset', 'invoice']),
  variables: z.record(z.string(), z.string()).default({}),
  scheduled_for: z.coerce.date().optional(),
});

type SendEmailJob = z.infer<typeof SendEmailJob>;

const queue = new Queue<SendEmailJob>('emails');

new Worker<unknown>('emails', async (job) => {
  const payload = SendEmailJob.parse(job.data); // narrow from unknown
  const user = await db.user.findUnique({ where: { id: payload.user_id } });
  if (!user) return;
  await sendTemplate(user, payload.template, payload.variables);
});
```

Two practical notes:

**Type the queue, untype the worker.** The producer is yours, so `Queue<SendEmailJob>` keeps the producer's `queue.add('send', data)` calls type-checked. The worker reads back from Redis where types are gone; declare `Worker<unknown>` so the body of the worker has to prove the shape, not assume it.

**Version your job payloads if they're long-lived.** If a job can sit in the queue for hours, a deploy can change the schema underneath it. Either include a `version: z.literal(1)` discriminator and branch in the worker, or do the migration in the producer (re-enqueue old-shape jobs with the new shape, drain).

---

## `.transform` — string → Date, string → Decimal

JSON has six types. Your forge model has more. The bridge is `.transform`:

```ts
const Money = z.string().regex(/^\d+\.\d{2}$/).transform((s) => new Decimal(s));
//                  ^ input type: string                     ^ output type: Decimal

const When = z.string().datetime().transform((s) => new Date(s));
//                  ^ input type: string (ISO-8601)          ^ output type: Date

const Bigint = z.string().regex(/^\d+$/).transform((s) => BigInt(s));
```

Use these in your schema and the parsed type carries the runtime type forward:

```ts
const CreateInvoice = z.object({
  amount: Money,
  due_on: When,
});

const body = CreateInvoice.parse(req.body);
//    ^ { amount: Decimal; due_on: Date }

await db.invoice.create({ data: body });
```

A subtlety: `z.coerce.date()` is a shorter but more permissive alternative. It accepts strings, numbers, and existing `Date` objects, running `new Date(input)`. The transform-with-regex version above rejects anything that isn't ISO-8601 — which is what you want for an API where the contract says ISO-8601. Pick based on whether the upstream is trusted.

For Mongo's `ObjectId`:

```ts
import { ObjectId } from 'mongodb';

const Oid = z.string()
  .regex(/^[0-9a-f]{24}$/)
  .transform((s) => new ObjectId(s));
```

For UUIDs (no transform, the string *is* the runtime type):

```ts
const Uuid = z.string().uuid();
```

For `f.decimal()` — depending on which Decimal library you use, the transform target differs (`decimal.js`, `bignumber.js`, the driver's native type). Pick one and standardise; mixing them across the codebase will cost you an afternoon.

---

## Brand types

A brand type is a `string` (or `number`) that TypeScript knows is *not interchangeable* with other strings. The classic example: `UserId` and `OrgId` are both strings at runtime, but you don't want to accidentally pass an `OrgId` where a `UserId` is required.

```ts
const UserId = z.string().uuid().brand<'UserId'>();
const OrgId  = z.string().uuid().brand<'OrgId'>();

type UserId = z.infer<typeof UserId>; // string & { [brand]: 'UserId' }
type OrgId  = z.infer<typeof OrgId>;

declare function loadUser(id: UserId): Promise<User>;

const oid = OrgId.parse('...');
loadUser(oid);
//       ^ Type 'OrgId' is not assignable to parameter of type 'UserId'.
```

zod's `.brand<T>()` modifier adds a phantom property to the inferred type. At runtime it's still a string; at compile time it's `string & { [brand]: 'UserId' }`, which the structural subtype rules treat as distinct from raw `string` and from other brands.

Where this pays off:

* Repository methods (`userRepo.findById(id: UserId)`) — passing an `OrgId` is a compile error.
* Request handlers — `req.params.id` is a raw string until you `UserId.parse(req.params.id)`; after that, you can hand it to downstream functions that require the brand.
* Cross-table FKs — the column type `author_id: f.objectId()` is `string` in the inferred row, but you can hand-narrow to `UserId` at the repository boundary.

A short cross-link: a dedicated **BRAND-TYPES.md** doc covers the heavier patterns (centralising brand definitions, brand-aware serialisation, the trade-off vs nominal types via `tagged-union` libraries). The takeaway here: brands are an ergonomic way to make `Row<typeof User>['id']` distinct from `Row<typeof Org>['id']`, and zod's `.brand` is the lowest-friction way to introduce them at the parse boundary.

---

## zod 4 features worth knowing

zod 4 (released late 2024) is faster and tighter than zod 3, and a few of its features change the patterns above.

**Performance.** Parser construction is one order of magnitude faster than zod 3 for typical schemas; parse-time throughput is 2–3x in the benchmarks. If you were caching parsed schemas in module scope to avoid construction cost, the cache may now be unnecessary.

**Async refinements.** `refine((v) => isUnique(v), 'taken')` accepts an async predicate; `parse` becomes `parseAsync`. Useful for DB-backed validations (email-not-taken) inside the schema rather than after parse:

```ts
const SignupEmail = z.string().email().refine(
  async (email) => {
    const existing = await db.user.findFirst({ where: { email } });
    return !existing;
  },
  { message: 'Email is already registered' },
);

const body = await SignupSchema.parseAsync(req.body);
```

Two cautions. Async refinements run the DB query on every parse — fine for a signup endpoint, expensive in tight loops. And the timing reveals whether an email exists; for security-sensitive flows, keep the "is this taken" check out of validation and inside the create transaction with a unique-constraint catch.

**Error format.** `.format()` and `.flatten()` produce more predictable shapes in zod 4; the field-error tree is easier to walk and easier to render in forms.

**Discriminated unions.** Better inference for discriminated unions — `z.discriminatedUnion('type', [A, B, C])` no longer requires the type tag to be a literal in every leaf, and the parsed type narrows on the discriminator.

**`z.iso.datetime()`, `z.iso.date()`, `z.iso.time()`** — replace ad-hoc datetime regex with the structured ISO-8601 parsers from `z.iso.*`.

Stick on zod 3 only if a dependency (a form lib, an OpenAPI generator) hasn't shipped zod 4 support yet — those gaps have been closing through 2025.

---

## Error mapping — zod → HTTP 400

`ZodError` carries the structured failure. The conversion to an HTTP response is the same every time:

```ts
import { ZodError } from 'zod';

function zodErrorToResponse(err: ZodError) {
  return {
    error: 'invalid_input',
    fields: err.flatten().fieldErrors,
    // { email: ['Invalid email'], name: ['String must contain at least 1 character'] }
  };
}

app.use((err, req, res, next) => {
  if (err instanceof ZodError) {
    return res.status(400).json(zodErrorToResponse(err));
  }
  next(err);
});
```

Two flavours to pick from:

* **`.flatten()`** — returns `{ formErrors: string[], fieldErrors: Record<string, string[]> }`. Flat, easy for form UIs that map field name → first error.
* **`.format()`** — returns a tree mirroring the schema shape. Nested fields produce nested errors. Use this when you have nested objects and want the UI to map errors to nested form fields.

**Don't echo the entire error object.** zod errors include the path, the message, and the *received value*. Echoing the received value is fine for trusted clients (your own frontend); for public APIs, drop `received` so you don't accidentally bounce a fragment of the attacker's payload back at them.

**Translate the messages.** zod's default messages are English. For multi-locale APIs, either set `z.setErrorMap(localisedErrorMap)` globally or pass `{ message: 'fields.email.invalid' }` per refinement and look the key up on the client side.

For a unified `error` envelope across the API (the convention used by Dallio's API standard — error codes, request id, field details) the wrap above is the right shape; just align the property names with the rest of the envelope.

---

## OpenAPI generation from zod

`@asteasolutions/zod-to-openapi` is the canonical bridge. Annotate schemas with `.openapi(...)`; register them in a registry; emit a Swagger document.

```ts
import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

const UserCreate = z.object({
  email: z.string().email().openapi({ example: 'a@b.com' }),
  name:  z.string().min(1).openapi({ example: 'Ada Lovelace' }),
}).openapi('UserCreate');

const registry = new OpenAPIRegistry();
registry.register('UserCreate', UserCreate);

registry.registerPath({
  method: 'post',
  path: '/v1/users',
  request: { body: { content: { 'application/json': { schema: UserCreate } } } },
  responses: {
    201: { description: 'Created', content: { 'application/json': { schema: UserPublic } } },
    400: { description: 'Invalid input' },
  },
});

const doc = new OpenApiGeneratorV3(registry.definitions).generateDocument({
  openapi: '3.0.0',
  info: { title: 'API', version: '1.0.0' },
});
```

The doc you emit is the contract clients code-gen against. Two things to keep aligned:

* **Every endpoint registered**. Easy to forget when adding a new route; the test suite should walk the route table and assert each path has a `registerPath` call.
* **`.openapi('UserCreate')` names match**. The string you pass becomes `$ref: '#/components/schemas/UserCreate'`. Renaming a zod schema without updating the OpenAPI name produces a broken ref.

For the `Read` side, the schema you register is `UserPublic` (the wire shape), not `UserRow` (the DB shape). They differ on `password`, `deleted_at`, and any internal-only columns.

---

## Form libraries — react-hook-form + zodResolver

The web side of the same schema. `@hookform/resolvers/zod` wraps a zod schema as a react-hook-form resolver:

```tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

const SignupForm = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

type SignupForm = z.infer<typeof SignupForm>;

function Signup() {
  const { register, handleSubmit, formState: { errors } } = useForm<SignupForm>({
    resolver: zodResolver(SignupForm),
  });

  return (
    <form onSubmit={handleSubmit(async (data) => {
      await fetch('/v1/users', { method: 'POST', body: JSON.stringify(data) });
    })}>
      <input {...register('email')} />
      {errors.email && <span>{errors.email.message}</span>}
      <input type="password" {...register('password')} />
      {errors.password && <span>{errors.password.message}</span>}
      <button>Sign up</button>
    </form>
  );
}
```

Same schema on both ends of the wire: the client validates with `SignupForm` before posting; the server validates the body with the same schema (imported from a shared package, or duplicated and kept in sync via a CI check). Symmetry isn't required — the server *must* re-validate even if the client did — but sharing keeps the messages and field rules aligned.

For more advanced form libraries (TanStack Form, Conform, formkit) the wrapper API differs but the principle is the same: the zod schema is the validation rule, the resolver is the adapter to the form library's per-field error contract.

---

## Four worked examples

### A — hyper-express POST /users with zod validation + transform

```ts
import { HyperExpress } from 'hyper-express';
import { z, ZodError } from 'zod';
import { Decimal } from 'decimal.js';
import { db } from './db';

const Money = z.string().regex(/^\d+\.\d{2}$/).transform((s) => new Decimal(s));

const CreateUser = z.object({
  email:        z.string().trim().toLowerCase().email(),
  name:         z.string().trim().min(1).max(120),
  signup_bonus: Money.optional(),
  consent_at:   z.iso.datetime().transform((s) => new Date(s)),
});

const app = new HyperExpress.Server();

app.post('/v1/users', async (req, res) => {
  try {
    const body = CreateUser.parse(await req.json());
    //    ^ { email: string; name: string; signup_bonus?: Decimal; consent_at: Date }

    const user = await db.user.create({
      data: {
        email: body.email,
        name:  body.name,
        bonus_cents: body.signup_bonus?.times(100).toFixed(0) ?? null,
        consented_at: body.consent_at,
      },
    });

    res.status(201).json({ data: user });
  } catch (err) {
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: 'invalid_input',
        fields: err.flatten().fieldErrors,
      });
    }
    throw err;
  }
});

app.listen(3000);
```

What this gets you:

* The body arrives as `unknown`; after parse, every property is the runtime type your handler expects.
* `signup_bonus` is a `Decimal` instance in `body` even though it crossed the wire as `"19.99"`.
* `consent_at` is a `Date` instance even though it arrived as `"2026-06-24T12:00:00Z"`.
* The 400 response has per-field error details a frontend can render.

### B — zod schema derived from `Row<typeof User>` via Pattern A

```ts
import { z } from 'zod';
import type { Row, InferCreate } from 'forge-orm';
import { f, model } from 'forge-orm';

const User = model('users', {
  id:    f.id(),
  email: f.string().unique(),
  name:  f.string(),
  age:   f.int().nullable(),
});

// Hand-write the API input schema:
const CreateUserInput = z.object({
  email: z.string().email(),
  name:  z.string().min(1),
  age:   z.number().int().optional().nullable(),
});

// Compile-time alignment check:
type _CheckCreate = z.infer<typeof CreateUserInput> extends InferCreate<typeof User>
  ? true : never;
const _checkCreate: _CheckCreate = true;

// And for reads:
const UserRow = z.object({
  id:    z.string(),
  email: z.string(),
  name:  z.string(),
  age:   z.number().int().nullable(),
}) satisfies z.ZodType<Row<typeof User>>;
```

The `satisfies z.ZodType<Row<typeof User>>` clause makes the zod schema's output type *be* `Row<typeof User>`. If you add a column to `User`, the satisfies clause fails to compile until you add it to the zod schema.

This is the lightest-weight sync pattern that actually catches drift. Pattern B (the `irToZod` builder) does more work and catches less.

### C — webhook signature + zod payload

Webhook handlers have to do two things in order. Verify the signature first; if and only if the signature is valid, parse the body.

```ts
import { z, ZodError } from 'zod';
import crypto from 'node:crypto';

const StripeChargeSucceeded = z.object({
  id:       z.string().regex(/^evt_/),
  type:     z.literal('charge.succeeded'),
  created:  z.number().int(),
  data: z.object({
    object: z.object({
      id:       z.string().regex(/^ch_/),
      amount:   z.number().int().positive(),
      currency: z.string().length(3),
      metadata: z.record(z.string(), z.string()).default({}),
    }),
  }),
});

function verifyStripeSignature(rawBody: string, header: string, secret: string): boolean {
  const [tPart, vPart] = header.split(',');
  const t = tPart.split('=')[1];
  const v = vPart.split('=')[1];
  const signed = `${t}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected));
}

app.post('/v1/webhooks/stripe', async (req, res) => {
  const rawBody = await req.text();
  const header  = req.headers['stripe-signature'] as string;

  if (!verifyStripeSignature(rawBody, header, process.env.STRIPE_SECRET!)) {
    return res.status(401).send('bad signature');
  }

  try {
    const event = StripeChargeSucceeded.parse(JSON.parse(rawBody));
    await db.charge.create({
      data: {
        stripe_id: event.data.object.id,
        amount_cents: event.data.object.amount,
        currency: event.data.object.currency,
        received_at: new Date(event.created * 1000),
      },
    });
    res.status(200).send('ok');
  } catch (err) {
    if (err instanceof ZodError) {
      // Stripe's event shape doesn't match our schema — log, return 200 so it doesn't retry.
      console.error('Unhandled webhook shape', err.flatten());
      return res.status(200).send('unhandled');
    }
    throw err;
  }
});
```

Three points worth calling out:

* **Signature verification reads the raw body, not the parsed JSON.** Most frameworks parse JSON for you; you have to ask for the raw text first or the signature won't match.
* **Different event types want different schemas.** Use a discriminated union on `type` so each branch validates its own `data.object` shape.
* **Return 200 for unhandled-but-known events.** If you 400, Stripe retries; if the shape is new, you'll DOS yourself with retries.

### D — generate OpenAPI document from zod schemas

```ts
import { z } from 'zod';
import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { writeFileSync } from 'node:fs';

extendZodWithOpenApi(z);

const UserCreate = z.object({
  email: z.string().email().openapi({ example: 'ada@example.com' }),
  name:  z.string().min(1).max(120).openapi({ example: 'Ada Lovelace' }),
}).openapi('UserCreate');

const UserPublic = z.object({
  id:    z.string().openapi({ example: 'usr_01H...' }),
  email: z.string(),
  name:  z.string(),
  created_at: z.string().datetime(),
}).openapi('UserPublic');

const ErrorResponse = z.object({
  error:  z.string().openapi({ example: 'invalid_input' }),
  fields: z.record(z.string(), z.array(z.string())).optional(),
}).openapi('ErrorResponse');

const registry = new OpenAPIRegistry();
registry.register('UserCreate',    UserCreate);
registry.register('UserPublic',    UserPublic);
registry.register('ErrorResponse', ErrorResponse);

registry.registerPath({
  method: 'post',
  path: '/v1/users',
  tags: ['users'],
  request: {
    body: { content: { 'application/json': { schema: UserCreate } } },
  },
  responses: {
    201: {
      description: 'Created',
      content: { 'application/json': { schema: z.object({ data: UserPublic }) } },
    },
    400: {
      description: 'Invalid input',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const doc = new OpenApiGeneratorV3(registry.definitions).generateDocument({
  openapi: '3.0.0',
  info: { title: 'Example API', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com' }],
});

writeFileSync('./openapi.json', JSON.stringify(doc, null, 2));
```

Run this script in CI and commit `openapi.json`. Downstream — client codegen, API explorer, contract tests — all read it.

Pattern: keep the registry and the path registrations adjacent to the handlers, not in one central file. A `registerRoutes(app, registry)` per resource keeps the source of truth co-located.

---

## Common mistakes

**Re-validating DB output with zod.** The driver already typed it; forge-orm's inference matches the DDL. Adding zod parse on the way out is wasted CPU, and when it fails the right tool is a migration fix, not a 400.

**One mega-schema per resource.** A single `UserSchema` that tries to serve Create, Update, Read, and Admin variants will be wrong for at least three of them. Split early; combine with `.pick` / `.omit` / `.extend`.

**Parsing `req.body` twice.** Once in middleware, again in the handler. Pick one. The handler is closer to the business logic — keep it there.

**`z.any()` for JSON columns.** `z.unknown()` is almost always what you want — `z.any()` disables type-checking for the property in downstream code. Reserve `z.any()` for cases where downstream code legitimately accepts any shape.

**Forgetting `.parseAsync` for async refinements.** `.parse` on a schema that contains an async refinement throws *because of* the async refinement, not because of the input. Either await `parseAsync`, or pull the async check out of the schema and run it after a synchronous parse.

**Trusting `z.coerce.number()` for JSON bodies.** A number that arrives as a string in JSON is a client bug. Use plain `z.number()` for JSON, `z.coerce.number()` for query strings and form-encoded payloads.

**Validating signatures after parsing webhook bodies.** Verify the signature on the raw bytes first. If you parse JSON before checking the signature, an attacker who can guess your endpoint can ship malformed input to your zod errors and shape their next attack from the responses.

**Echoing `received` in error responses.** zod's `.format()` includes the value that failed validation. For public APIs, strip it before sending the response — you don't want to reflect an attacker's payload back at them inside an error envelope.

**Letting brand types decay to plain strings.** A brand survives `.parse`, but it doesn't survive `JSON.stringify` → `JSON.parse` round-trip across a process boundary. Re-brand at every parse on the receiving side.

**Hand-syncing without a `satisfies` clause.** Pattern A above only catches drift if the compile-time assertion is in place. Add a `_check` constant per schema; CI's `tsc --noEmit` will fail when the model and the zod schema diverge.

---

See also:

* [TYPES.md](./TYPES.md) — the compile-time half of the story.
* [MODEL.md](./MODEL.md) — what `f.*` produces and what `Row<typeof Model>` resolves to.
* [BACKEND.md](./BACKEND.md) — wiring this into a real service.
* [SECURITY.md](./SECURITY.md) — threat-model context for the input boundary.
