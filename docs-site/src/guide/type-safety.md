---
title: "Type safety"
---

## Type safety

Types come straight from your schema, with no generated client. `db.user` knows
its fields, `where` rejects values of the wrong type, `select` narrows the
result, and `include` returns the related model's shape.

### Row + db helpers

```ts
import type { Row, ForgeDb } from 'forge-orm';

type DB   = ForgeDb<typeof schema>;
type User = Row<typeof User>;     // { id: string; email: string; name: string; … }
```

### Checking whether a model exists (`in`, `db.$models`)

Reading a model forge doesn't know about **throws**, on purpose — a typo'd
name should fail at the access, not surface as
`Cannot read properties of undefined` several frames later:

```ts
db.Tpyo   // throws: [forge] unknown model "Tpyo". Active schema exposes: …
```

When a model is genuinely optional, guard with `in`. It never throws:

```ts
const view = 'OrgIndustryMixView' in db ? db.OrgIndustryMixView : null;
if (!view) return;            // not registered — skip, don't crash
await view.refresh();
```

`in` is exact and case-sensitive (`'user' in db` is `false` when the model
is registered as `User`), and it reports the `$` helpers too, so
`'$transaction' in db` is `true`. Do **not** reach for `?.` or `??` to do
this job — the throw happens during the property read, so neither ever
runs.

`db.$models` gives the full sorted list, which is the quickest way to
confirm a schema actually reached `createDb`:

```ts
db.$models   // ['Gadget', 'Widget']
```

Both work inside `$transaction`. The tx handle reports only what it
serves, so `'$migrate' in tx` is `false`.

> `Object.keys(db)` returns `[]` by design. Making model keys enumerable
> would make `JSON.stringify(db)` walk every collection wrapper; use
> `$models`.

### Direct-from-model inference (`Infer*`)

When you want a create/update/where shape for a service signature, DTO,
validation layer, or anywhere else outside `db.*`, take it straight from
the model — no codegen, no `SchemaMap` registration, no detour through
`ForgeOf<'key'>`. Pass `typeof MyModel` to any `Infer*` alias:

```ts
import { f, model, rel } from 'forge-orm';
import type {
  Infer, InferCreate, InferUpdate, InferWhere, InferRow,
  InferOrderBy, InferSelect, InferInclude, InferSchema,
} from 'forge-orm';

const User = model('users', {
  id:    f.id(),
  email: f.string().unique(),
  name:  f.string().optional(),
  age:   f.int().optional(),
});

type UserRow    = InferRow<typeof User>;
//   { id: string; email: string; name: string | null; age: number | null }
type UserCreate = InferCreate<typeof User>;
//   { id?: string; email?: string; name?: string | null; age?: number | null; … relations }
type UserUpdate = InferUpdate<typeof User>;
//   plain values + atomic ops on numbers: { age: { increment: 1 } }
type UserWhere  = InferWhere<typeof User>;
//   field filters + AND / OR / NOT
type UserOrder  = InferOrderBy<typeof User>;
//   { createdAt: 'desc' }

// One bundle of everything for a single model:
type UserT = Infer<typeof User>;
//   { Row, Where, WhereUnique, Create, Update, Upsert, OrderBy, Select, Include, Omit }

function createUser(data: UserT['Create']) { /* … */ }
function findUser(where: UserT['Where']):   Promise<UserT['Row'][]> { /* … */ }
```

For relation-aware `Select` / `Include`, pass the schema map as the second
generic so the helper can walk the relation graph:

```ts
const schema = { user: User, post: Post } as const;
type Types = InferSchema<typeof schema>;

type PostSelect = Types['post']['Select'];
// { id?: boolean; title?: boolean; author?: boolean | { select: { … } } }

type UserInclude = Types['user']['Include'];
// { posts?: boolean | { where: …, take: number, … } }
```

`Infer<typeof M>` works on any `TypedModel` returned by `model(...)` — you
don't have to wire it into a schema map first, you don't have to call
`setActiveSchema`, and you don't need a build step. Add a field to the
model and every `Infer*` derived from it updates on save.

See more — **[docs/TYPES.md](/reference/types)** for `Row`, every `Infer*` helper, `ForgeOf` / `ForgeModels`, optional-vs-nullable asymmetry, strict mode, generic helpers, autocomplete pitfalls, embed inference, per-dialect type quirks, and five worked patterns.

---
