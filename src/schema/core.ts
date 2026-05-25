import {
  DefaultValue,
  EmbedDef,
  FieldDef,
  FieldKind,
  IndexDef,
  ModelDef,
  OnDeleteAction,
  RelationDef,
} from './types';

// ─── Field builder ──────────────────────────────────────────────────────────
//
// Each builder is an immutable description plus a phantom `_t` carrying the
// resolved JS type. Chain `.optional()`, `.unique()`, `.default(...)`,
// `.updatedAt()` to refine. The resulting `_t` flows through `Row<>` to give
// a fully-typed row shape with no codegen step.

export class Field<T, K extends FieldKind = FieldKind> {
  // Phantom carriers for the JS-side type AND the field-kind literal.
  // Both are essential for input-type narrowing: without `_k`, TypeScript's
  // structural typing collapses Field<X, 'json'> and Field<X, 'dateTime'>
  // into the same shape (since K only appeared in the generic signature,
  // not in any structural property), and conditional checks like
  // `[X] extends [Field<Date, 'dateTime'>]` would match unintentionally.
  readonly _t!: T;
  readonly _k!: K;
  readonly def: FieldDef;

  constructor(def: FieldDef) {
    this.def = def;
  }

  optional(): Field<T | null, K> {
    return new Field<T | null, K>({ ...this.def, optional: true });
  }

  unique(): Field<T, K> {
    return new Field<T, K>({ ...this.def, unique: true });
  }

  default(value: T | 'now' | 'autoId'): Field<T, K> {
    let d: DefaultValue;
    if (value === 'now') d = { kind: 'now' };
    else if (value === 'autoId') d = { kind: 'autoId' };
    else d = { kind: 'literal', value };
    return new Field<T, K>({ ...this.def, default: d });
  }

  updatedAt(): Field<T, K> {
    return new Field<T, K>({ ...this.def, updatedAt: true });
  }

  // Wave 4b — opt the field into auto-FTS-index emission via forge:push.
  // Allowed on string / text fields only. The compiled `where: { col: { search } }`
  // path already works on any column; `.searchable()` just guarantees the
  // backing index exists.
  searchable(): Field<T, K> {
    return new Field<T, K>({ ...this.def, searchable: true });
  }

  // Wave 4b — mark this field as the model's soft-delete column. Only one per
  // model. Forces the field optional (it's null until the row is soft-deleted).
  // The wrapper automatically:
  //   • adds `WHERE <col> IS NULL` to reads (suppress with `where: { _withDeleted: true }`)
  //   • rewrites `.delete()` / `.deleteMany()` to `UPDATE … SET <col> = now()`
  softDeleteAt(): Field<T | null, K> {
    return new Field<T | null, K>({ ...this.def, optional: true, softDeleteAt: true });
  }
}

// ─── f.* — field constructors ───────────────────────────────────────────────

const make = <T, K extends FieldKind>(kind: K): Field<T, K> =>
  new Field<T, K>({
    kind,
    optional: false,
    unique: false,
    updatedAt: false,
  });

export const f = {
  // Primary key. Default behaviour: string in app, ObjectId in db, mapped to/from `_id`,
  // auto-generated at create time when no value is supplied.
  id: () =>
    new Field<string, 'id'>({
      kind: 'id',
      optional: false,
      unique: true,
      updatedAt: false,
      default: { kind: 'autoId' },
    }),

  // Foreign key style — string in app, ObjectId in db.
  objectId: () => make<string, 'objectId'>('objectId'),

  string: () => make<string, 'string'>('string'),
  // f.text() — unbounded string. Identical to f.string() except on MySQL,
  // where `string` compiles to VARCHAR(255) (for indexability) and `text`
  // compiles to TEXT (unbounded, but can't be UNIQUE without a key length).
  text: () => make<string, 'text'>('text'),
  int: () => make<number, 'int'>('int'),
  float: () => make<number, 'float'>('float'),
  bool: () => make<boolean, 'bool'>('bool'),
  dateTime: () => make<Date, 'dateTime'>('dateTime'),
  json: () => make<any, 'json'>('json'),

  enumOf: <const V extends readonly string[]>(values: V) =>
    new Field<V[number], 'enum'>({
      kind: 'enum',
      optional: false,
      unique: false,
      updatedAt: false,
      enumValues: values,
    }),

  // Embedded composite types — Prisma `type Foo {}`. The schema is itself a
  // tiny model; we reuse the same Field map shape.
  embed: <F extends Record<string, Field<any, any>>>(embedDef: () => EmbedDef<MapToFieldDefs<F>>) =>
    new Field<EmbedRow<F>, 'embed'>({
      kind: 'embed',
      optional: false,
      unique: false,
      updatedAt: false,
      embedOf: embedDef as any,
    }),

  embedMany: <F extends Record<string, Field<any, any>>>(
    embedDef: () => EmbedDef<MapToFieldDefs<F>>,
  ) =>
    new Field<EmbedRow<F>[], 'embedMany'>({
      kind: 'embedMany',
      optional: false,
      unique: false,
      updatedAt: false,
      embedOf: embedDef as any,
    }),

  stringArray: () => make<string[], 'stringArray'>('stringArray'),
  intArray: () => make<number[], 'intArray'>('intArray'),
};

// ─── enums() — runtime + type ────────────────────────────────────────────────
//
// Returns an object usable both at runtime (`Role.OWNER === 'OWNER'`) and as
// a type (`Role` ≡ `'OWNER' | 'ADMIN' | ...`). The values tuple is also
// re-exported for `f.enumOf(...)`.

export type EnumDef<V extends readonly string[]> = {
  readonly values: V;
} & { readonly [K in V[number]]: K };

export const enums = <const V extends readonly string[]>(values: V): EnumDef<V> => {
  const out: any = { values };
  for (const v of values) out[v] = v;
  return out as EnumDef<V>;
};

// ─── embed() — composite type declaration ────────────────────────────────────

export const embed = <F extends Record<string, Field<any, any>>>(
  embedName: string,
  fields: F,
): EmbedDef<MapToFieldDefs<F>> => ({
  embedName,
  fields: mapFieldDefs(fields),
});

// ─── model() — collection declaration ────────────────────────────────────────

export interface ModelOptions {
  relations?: () => Record<string, RelationDef>;
  indexes?: IndexDef[];
  // Composite uniques: @@unique([user_email, business_id]) → [['user_email','business_id']]
  uniques?: string[][];
}

// ─── model() — chainable, with .relate() for co-located relations ──────────
//
// Why the chain:
//   const Foo = model('foos', { ... }).relate(() => ({ bar: rel.one(() => Bar, ...) }));
//
// Inline relations in the model() options would force TypeScript to walk the
// type cycle (Business ↔ Subscription ↔ Business, etc.) and give up — every
// cyclic model would collapse to `any`. The chained pattern works because:
//
//   1. `model('name', fields)` infers F leaf-only — no cycles.
//   2. `.relate<R>(rels)` is a generic method that captures R (the relation
//      name → RelationDef record) without forcing TS to evaluate the
//      relation TARGETS. R is just a string-keyed record; the cycle is in
//      target types, not relation names, so capturing R is safe.
//   3. The returned `TypedModel<F, R>` carries both — F drives row types and
//      input types; R drives include/select autocomplete on relation names.

interface ChainableModel<F extends Record<string, Field<any, any>>>
  extends TypedModel<F, {}> {
  relate<R extends Record<string, RelationInfo>>(
    rels: () => R,
  ): TypedModel<F, R>;
  // Wave 4c — declare this model as a read-only view backed by a CREATE VIEW
  // (SQL dialects) or createCollection-as-view (Mongo). The wrapper blocks
  // all write methods; reads work normally.
  asView(spec: { sql?: string; pipeline?: unknown[]; sourceCollection?: string }): TypedModel<F, {}>;
}

export const model = <F extends Record<string, Field<any, any>>>(
  collection: string,
  fields: F,
  options: ModelOptions = {},
): ChainableModel<F> => {
  const def: ModelDef<MapToFieldDefs<F>> & {
    relate?: (rels: () => Record<string, RelationDef>) => any;
  } = {
    collection,
    fields: mapFieldDefs(fields),
    relations: options.relations || (() => ({})),
    indexes: options.indexes || [],
    uniques: options.uniques || [],
  };
  def.relate = function (rels: () => Record<string, RelationDef>) {
    this.relations = rels;
    return this;
  };
  // Wave 4c — declare a model as a read-only view. The wrapper rejects
  // writes (create/update/delete/upsert) with an actionable error, and
  // `forge:push` emits `CREATE VIEW` (SQL dialects) or
  // `createCollection({ viewOn, pipeline })` (Mongo).
  (def as any).asView = function (
    spec: { sql?: string; pipeline?: unknown[]; sourceCollection?: string },
  ) {
    this.view = spec;
    return this;
  };
  return def as unknown as ChainableModel<F>;
};

// ─── rel.* — relation declarations ───────────────────────────────────────────
//
// The `target` parameter is typed as `() => any` (not `() => TypedModel<any>`).
// Reason: the relation graph is mutually recursive (Business ↔ Subscription,
// User ↔ UserProfile, Comment ↔ CommentLike/Mention, etc.). When the target
// parameter's type forces TS to look up the referenced model's type, every
// model in a cycle ends up evaluated transitively — TS gives up at some
// depth and falls back to `any` for the whole declaration, including in IDE
// hover. Using `any` here breaks the cycle: the runtime still gets the
// model thunk, and `Row<>` (which only walks fields) is unaffected.

// Relation declarations use STRING TARGETS — schema keys, not type references.
// This is the key design choice that enables deep include/select resolution
// without TypeScript inference cycles. Each relation carries the target as
// a literal string in its type; at runtime, the string is looked up against
// the schema map.
//
// Trade-off: typos at declaration time aren't caught at compile-time
// (because the schema map isn't fully built when the relation is declared).
// They surface at first runtime use — a fast feedback loop.

export type RelationInfo<
  TargetName extends string = string,
  K extends 'one' | 'many' = 'one' | 'many',
> = {
  kind: K;
  target: TargetName;
  on: string;
  refs: string;
  onDelete?: OnDeleteAction;
  inverse?: boolean;
};

export const rel = {
  one: <T extends string>(
    target: T,
    opts: { on: string; refs: string; onDelete?: OnDeleteAction },
  ): RelationInfo<T, 'one'> => ({
    kind: 'one',
    target,
    on: opts.on,
    refs: opts.refs,
    onDelete: opts.onDelete,
  }),

  many: <T extends string>(
    target: T,
    opts: { on: string; refs: string; onDelete?: OnDeleteAction },
  ): RelationInfo<T, 'many'> => ({
    kind: 'many',
    target,
    on: opts.on,
    refs: opts.refs,
    onDelete: opts.onDelete,
    inverse: true,
  }),
};

// ─── Type plumbing for inference ─────────────────────────────────────────────

export type TypedModel<
  F extends Record<string, Field<any, any>>,
  R extends Record<string, RelationInfo> = {},
> = ModelDef<MapToFieldDefs<F>> & {
  // Phantom carriers — never read at runtime. R is a flat record of
  // RelationInfo values (kind + literal string target), no nested model
  // type references. This keeps cycles broken while still letting
  // resolution types walk relations recursively via `Schema[target]`
  // lookups.
  readonly _fields?: F;
  readonly _relations?: R;
  readonly _row?: ResolvedRow<F>;
};

export type MapToFieldDefs<F extends Record<string, Field<any, any>>> = {
  [K in keyof F]: FieldDef;
};

// Extract the JS-level type from a Field<T>.
export type FieldType<X> = X extends Field<infer T, any> ? T : never;

// Resolve a row of fields → JS object type.
type ResolvedRow<F extends Record<string, Field<any, any>>> = {
  [K in keyof F]: FieldType<F[K]>;
};

// Used by `f.embed`/`f.embedMany`.
type EmbedRow<F extends Record<string, Field<any, any>>> = {
  [K in keyof F]: FieldType<F[K]>;
};

// ============================================================================
// Prisma-shape input types for typed query API.
// ============================================================================
//
// All input types are parameterised over F (fields) and R (relation-name
// record). They DO NOT walk into relation targets — that's where cycles
// originate. Top-level autocomplete (data fields, where operators, include
// relation names, select keys) works fully; nested relation args (e.g.
// args inside `include: { creator: { ... } }`) fall back to `any` to keep
// inference shallow. This is the exact tradeoff Prisma side-steps with
// codegen, and it keeps us cycle-free without one.
// ============================================================================

// Helper: resolve a Field<T, K> to T.
export type _Val<X> = X extends Field<infer T, any> ? T : never;

// Input-side variant — accepts ISO date strings for dateTime fields, loosens
// embedded shapes (Prisma applies defaults at create time, so every embed
// field is effectively optional on write), and falls back to `any` for
// flexible types like `f.json()`.
//
// The `[X] extends [...]` tuple-wrap is essential: it makes the conditional
// non-distributive, so `Field<any, 'json'>` doesn't trigger both branches
// of the conditional via TypeScript's special `any`-flow rules.
type _InputVal<X> = [X] extends [Field<Date, 'dateTime'>]
  ? Date | string
  : [X] extends [Field<infer T, 'embed'>]
    ? Partial<T>
    : [X] extends [Field<infer T, 'embedMany'>]
      ? [T] extends [(infer U)[]]
        ? Partial<U>[]
        : never
      : [X] extends [Field<any, 'json'>]
        ? any
        : _Val<X>;

// Scalar filters — Prisma's `equals/not/in/notIn/lt/lte/gt/gte/contains/...`
type StringFilter = {
  equals?: string;
  not?: string | StringFilter;
  in?: string[];
  notIn?: string[];
  lt?: string;
  lte?: string;
  gt?: string;
  gte?: string;
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  mode?: 'default' | 'insensitive';
};

type NumberFilter = {
  equals?: number;
  not?: number | NumberFilter;
  in?: number[];
  notIn?: number[];
  lt?: number;
  lte?: number;
  gt?: number;
  gte?: number;
};

type DateFilter = {
  equals?: Date | string;
  not?: Date | string | DateFilter;
  in?: (Date | string)[];
  notIn?: (Date | string)[];
  lt?: Date | string;
  lte?: Date | string;
  gt?: Date | string;
  gte?: Date | string;
};

type BoolFilter = {
  equals?: boolean;
  not?: boolean | BoolFilter;
};

type ListFilter<T> = {
  equals?: T[];
  has?: T;
  hasEvery?: T[];
  hasSome?: T[];
  isEmpty?: boolean;
  // Composite-list (embedMany) operators — Prisma uses these for filtering
  // on lists of embedded objects.
  some?: Partial<T> | any;
  every?: Partial<T> | any;
  none?: Partial<T> | any;
};

type ScalarFilterFor<T> = [T] extends [string]
  ? StringFilter
  : [T] extends [number]
    ? NumberFilter
    : [T] extends [boolean]
      ? BoolFilter
      : [T] extends [Date]
        ? DateFilter
        : [T] extends [(infer U)[]]
          ? ListFilter<U>
          : { equals?: T; not?: T; in?: T[]; notIn?: T[] };

// WhereInput — autocompletes scalar field names + AND/OR/NOT.
//
// The `[k: string]: any` fallback accepts:
//   • Composite-unique synthetic keys (e.g. `user_profile_id_comment_id`
//     for `@@unique([user_profile_id, comment_id])` lookups, mirroring
//     Prisma's generated input shape).
//   • Mongo-native operators (`$or`, `$and`, etc.) used in some legacy
//     query sites. Trade-off: typos on field names won't be caught, but
//     real fields still autocomplete cleanly.
export type WhereInput<F extends Record<string, Field<any, any>>> = {
  [K in keyof F]?: _InputVal<F[K]> | ScalarFilterFor<_Val<F[K]>> | null;
} & {
  AND?: WhereInput<F> | WhereInput<F>[];
  OR?: WhereInput<F>[];
  NOT?: WhereInput<F> | WhereInput<F>[];
} & {
  [key: string]: any;
};

// Helpers — extract the relation-name union from a relations record.
type RelKeys<R> = Extract<keyof R, string>;

// CreateInput — scalar fields (all optional, defaults filled in at runtime)
// + relation directives (connect / create / createMany / set).
export type CreateInput<
  F extends Record<string, Field<any, any>>,
  R extends Record<string, RelationInfo>,
> = {
  [K in keyof F]?: _InputVal<F[K]> | null;
} & {
  [K in RelKeys<R>]?: NestedWriteOps;
};

type NestedWriteOps = {
  connect?: { id?: string } & Record<string, any>;
  disconnect?: boolean | { id?: string } & Record<string, any>;
  set?: { id?: string } | { id?: string }[];
  create?: any;
  createMany?: { data: any | any[]; skipDuplicates?: boolean };
  delete?: any;
  deleteMany?: any;
  update?: any;
  updateMany?: any;
  upsert?: any;
};

// UpdateInput — scalar field updates (with operator wrappers for numbers)
// + relation directives.
export type UpdateInput<
  F extends Record<string, Field<any, any>>,
  R extends Record<string, RelationInfo>,
> = {
  [K in keyof F]?: FieldUpdateValue<F[K]>;
} & {
  [K in RelKeys<R>]?: NestedWriteOps;
};

// "Does T include number?" — true for `number`, `number | null`, `number | undefined`.
// Non-distributive via the contravariant test (`number extends T` rather than
// `T extends number`), so optional numeric fields still get the atomic-ops shape.
type IsNumericField<T> = number extends T ? true : false;

// JSON-null markers can be assigned to any field that's NULL-able (optional,
// or json/jsonb). They get unwrapped to SQL NULL / JSON null at compile time.
type ForgeNullMarker =
  | { readonly __forge: 'DbNull' }
  | { readonly __forge: 'JsonNull' }
  | { readonly __forge: 'AnyNull' };

type FieldUpdateValue<X> = X extends Field<infer T, any>
  ?
      | _InputVal<X>
      | null
      | ForgeNullMarker
      | (IsNumericField<T> extends true
          ? {
              increment?: number;
              decrement?: number;
              multiply?: number;
              divide?: number;
              set?: T;
            }
          : { set?: T | null })
  : never;

// OrderByInput — scalar field names with 'asc' | 'desc'.
export type OrderByInput<F extends Record<string, Field<any, any>>> = {
  [K in keyof F]?: 'asc' | 'desc';
};

// SelectInput / IncludeInput — typed against a Schema lookup so nested
// `select` / `include` args on relations get the TARGET model's fields and
// relations recursively. Goes any depth (bounded by TS recursion limit ~50).

// Nested relation args, parameterised by the target's F and R for recursion.
type RelationSelectArgs<
  TF extends Record<string, Field<any, any>>,
  TR extends Record<string, RelationInfo>,
  Schema extends Record<string, TypedModel<any, any>>,
  Depth extends number = 10,
> = {
  select?: SelectInputFor<TF, TR, Schema, Decrement<Depth>>;
  include?: IncludeInputFor<TR, Schema, Decrement<Depth>>;
  omit?: { [K in keyof TF]?: boolean };
  where?: WhereInput<TF>;
  orderBy?: OrderByInput<TF> | OrderByInput<TF>[];
  take?: number;
  limit?: number;
  skip?: number;
  offset?: number;
  cursor?: CursorInput;
  distinct?: Array<keyof TF & string>;
};

// Recursion depth governor — TypeScript can recurse up to ~50 levels deep
// in conditional types before bailing. We cap explicit nesting at 10 (well
// below the limit) so deep includes still resolve cleanly with autocomplete.
type Decrement<N extends number> = N extends 10
  ? 9
  : N extends 9
    ? 8
    : N extends 8
      ? 7
      : N extends 7
        ? 6
        : N extends 6
          ? 5
          : N extends 5
            ? 4
            : N extends 4
              ? 3
              : N extends 3
                ? 2
                : N extends 2
                  ? 1
                  : N extends 1
                    ? 0
                    : 0;

// IncludeInputFor — relation-name autocomplete; nested args resolve via
// schema lookup of the target's F and R. At depth 0, falls back to loose
// args to terminate recursion.
export type IncludeInputFor<
  R extends Record<string, RelationInfo>,
  Schema extends Record<string, TypedModel<any, any>>,
  Depth extends number = 10,
> = [Depth] extends [0]
  ? { [K in RelKeys<R>]?: boolean | LooseRelationArgs }
  : {
      [K in RelKeys<R>]?:
        | boolean
        | (R[K]['target'] extends keyof Schema
            ? RelationSelectArgs<
                ModelFields<Schema[R[K]['target']]>,
                ModelRelations<Schema[R[K]['target']]>,
                Schema,
                Depth
              >
            : LooseRelationArgs);
    } & {
      _count?:
        | boolean
        | { select: { [K in RelKeys<R>]?: boolean | { where?: any } } };
    };

// SelectInputFor — boolean toggles on scalar fields + nested resolution on
// relations.
export type SelectInputFor<
  F extends Record<string, Field<any, any>>,
  R extends Record<string, RelationInfo>,
  Schema extends Record<string, TypedModel<any, any>>,
  Depth extends number = 10,
> = [Depth] extends [0]
  ? { [K in keyof F]?: boolean } & { [K in RelKeys<R>]?: boolean | LooseRelationArgs }
  : {
      [K in keyof F]?: boolean;
    } & {
      [K in RelKeys<R>]?:
        | boolean
        | (R[K]['target'] extends keyof Schema
            ? RelationSelectArgs<
                ModelFields<Schema[R[K]['target']]>,
                ModelRelations<Schema[R[K]['target']]>,
                Schema,
                Depth
              >
            : LooseRelationArgs);
    } & {
      _count?:
        | boolean
        | { select: { [K in RelKeys<R>]?: boolean | { where?: any } } };
    };

// Loose fallback for over-depth relation args — accepts anything.
type LooseRelationArgs = {
  select?: any;
  include?: any;
  omit?: any;
  where?: any;
  orderBy?: any;
  take?: number;
  limit?: number;
  skip?: number;
  offset?: number;
  cursor?: CursorInput;
  distinct?: any;
};

// CursorInput — pagination cursor. Single-field form for id-based paging or
// composite synthetic-key form for @@unique([a, b]) keys.
//   { id: 'x' }
//   { user_id_video_id: { user_id: 'u', video_id: 'v' } }
export type CursorInput =
  | { id?: string }
  | { [compositeKey: string]: any };

// ─── Resolve<> — output-type resolution with included relations ─────────────
//
// Walks the requested include/select args and synthesises the actual return
// shape. For example:
//
//   findMany({ include: { creator: { include: { videos: true } } } })
//     → (Video & { creator: UserProfile & { videos: Video[] } })[]
//
// Recursion is depth-bounded for TS performance.

type ResolveScalars<F extends Record<string, Field<any, any>>> = {
  [K in keyof F]: _Val<F[K]>;
};

// Resolve a row's shape given F, R, and the include/select args.
export type Resolve<
  F extends Record<string, Field<any, any>>,
  R extends Record<string, RelationInfo>,
  Args,
  Schema extends Record<string, TypedModel<any, any>>,
  Depth extends number = 5,
> = [Depth] extends [0]
  ? ResolveScalars<F>
  : Args extends { select: infer S }
    ? ResolveSelect<F, R, S, Schema, Depth>
    : Args extends { include: infer I }
      ? ResolveScalars<F> & ResolveInclude<R, I, Schema, Depth>
      : ResolveScalars<F>;

// Apply select — only listed scalars + relations come back, plus _count.
type ResolveSelect<
  F,
  R,
  S,
  Schema extends Record<string, TypedModel<any, any>>,
  Depth extends number,
> = {
  [K in keyof S as S[K] extends false | undefined
    ? never
    : K extends keyof F | keyof R
      ? K
      : K extends '_count'
        ? '_count'
        : never]: K extends '_count'
    ? ResolveCount<R, S[K]>
    : K extends keyof F
      ? F[K] extends Field<infer T, any>
        ? T
        : never
      : K extends keyof R & string
        ? ResolveRelationField<R[K], S[K], Schema, Depth>
        : never;
};

// Apply include — full scalars + listed relations layered on. Includes
// `_count` resolution: `include: { _count: { select: { likes: true } } }`
// adds `_count: { likes: number }` to the result.
type ResolveInclude<
  R,
  I,
  Schema extends Record<string, TypedModel<any, any>>,
  Depth extends number,
> = {
  [K in keyof I as I[K] extends false | undefined
    ? never
    : K extends keyof R
      ? K
      : K extends '_count'
        ? '_count'
        : never]: K extends '_count'
    ? ResolveCount<R, I[K]>
    : K extends keyof R & string
      ? ResolveRelationField<R[K], I[K], Schema, Depth>
      : never;
};

type ResolveCount<R, CountArg> = CountArg extends { select: infer Sel }
  ? { [K in keyof Sel as Sel[K] extends false | undefined ? never : K extends keyof R ? K : never]: number }
  : { [K in keyof R]: number };

// Resolve a single relation entry given the include/select arg for it.
type ResolveRelationField<
  Rel,
  Arg,
  Schema extends Record<string, TypedModel<any, any>>,
  Depth extends number,
> = Rel extends {
  kind: infer K;
  target: infer T;
}
  ? T extends keyof Schema
    ? Schema[T] extends TypedModel<infer TF, infer TR>
      ? K extends 'one'
        ? Resolve<TF, TR, Arg, Schema, Decrement<Depth>> | null
        : Resolve<TF, TR, Arg, Schema, Decrement<Depth>>[]
      : never
    : never
  : never;

// ─── Internal: convert Field map → FieldDef map at runtime ───────────────────

function mapFieldDefs<F extends Record<string, Field<any, any>>>(fields: F): MapToFieldDefs<F> {
  const out: any = {};
  for (const k of Object.keys(fields)) out[k] = (fields[k] as Field<any, any>).def;
  return out;
}

// ─── Public Row<typeof Model> helper ─────────────────────────────────────────
//
// Usage: `type User = Row<typeof User>` gives the row shape (all fields,
// id as string, dates as Date). Relations are added separately via include.

export type Row<M> = M extends TypedModel<infer F, any> ? ResolvedRow<F> : never;

// Pull the F (fields) and R (relations record) out of a TypedModel for
// downstream input/output-type derivation. Used by CollectionWrapper signatures.
export type ModelFields<M> = M extends TypedModel<infer F, any> ? F : never;
export type ModelRelations<M> =
  M extends TypedModel<any, infer R> ? R : Record<string, never>;
export type ModelRelationNames<M> = Extract<keyof ModelRelations<M>, string>;
