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

// A field builder: an immutable description plus a phantom `_t` carrying the
// resolved JS type. Chain `.optional()` / `.unique()` / etc. to refine; `_t`
// flows through `Row<>` for a fully-typed row shape with no codegen step.

export class Field<T, K extends FieldKind = FieldKind> {
  // Phantom carriers for the JS-side type AND the field-kind literal. `_k` is
  // essential for input-type narrowing: without a structural property carrying
  // K, TypeScript collapses Field<X, 'json'> and Field<X, 'dateTime'> into the
  // same shape and checks like `[X] extends [Field<Date, 'dateTime'>]` match
  // unintentionally.
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

  /**
   * This column used to be called something else.
   *
   * A generator comparing two schema states sees only that one name is
   * gone and another has appeared. It cannot tell a rename from a drop
   * and an add — and it guesses wrong in the direction that loses data,
   * silently, on a column somebody meant to keep.
   *
   *     name: f.string().renamedFrom('full_name'),
   *
   * With this, the migration is `ALTER TABLE … RENAME COLUMN`, the rows
   * survive, and the intent is recorded in the schema, in the diff, and
   * in review — where a prompt answered once at 2am is recorded nowhere.
   *
   * Keep it until the migration has shipped everywhere it needs to, then
   * delete it. It affects generation only; nothing reads it at runtime.
   */
  renamedFrom(previous: string): Field<T, K> {
    return new Field<T, K>({ ...this.def, renamedFrom: previous });
  }

  // Opt the field into auto-FTS-index emission via forge:push. Querying works
  // on any column regardless; `.searchable()` just guarantees the backing index
  // exists.
  searchable(): Field<T, K> {
    return new Field<T, K>({ ...this.def, searchable: true });
  }

  // Mark this field as the model's soft-delete column. Only one per model.
  // Forced optional (null until soft-deleted). The wrapper then:
  //   • adds `WHERE <col> IS NULL` to reads (suppress with `where: { _withDeleted: true }`)
  //   • rewrites `.delete()` / `.deleteMany()` to `UPDATE … SET <col> = now()`
  softDeleteAt(): Field<T | null, K> {
    return new Field<T | null, K>({ ...this.def, optional: true, softDeleteAt: true });
  }

  // Mark this column as database-generated. `expr` is the SQL expression (e.g.
  // `"price" * "qty"`). The wrapper never writes it; the DB computes it. Emitted
  // as GENERATED ALWAYS AS (<expr>) STORED on PG/MySQL/SQLite; ignored (warned)
  // on Mongo.
  dbgenerated(expr: string): Field<T, K> {
    return new Field<T, K>({ ...this.def, dbGenerated: expr });
  }
}

const make = <T, K extends FieldKind>(kind: K): Field<T, K> =>
  new Field<T, K>({
    kind,
    optional: false,
    unique: false,
    updatedAt: false,
  });

// Primary-key strategies. `bigserial` is the only one that flips the JS-side
// row type from string → number; the others stay string-shaped so consumers
// can still pass UUIDs around as opaque tokens.
// `string` is an APPLICATION-supplied key: forge generates nothing and
// stores the value exactly as given. It exists for natural keys — a row
// whose identity IS its content, e.g. `"<orgId>:<series>"` for a counter
// that must be updated atomically by a single upsert. Without it such a
// collection cannot be declared at all, so it stays invisible to push,
// diff and doctor.
export type IdTypeName = 'auto' | 'uuid' | 'bigserial' | 'string';
export type IdJsType<T extends IdTypeName> = T extends 'bigserial' ? number : string;
export interface IdFactory {
  (): Field<string, 'id'>;
  <T extends IdTypeName>(opts: { type: T }): Field<IdJsType<T>, 'id'>;
}

export const f = {
  // Primary key. Default: string in app, ObjectId in db, mapped to/from `_id`,
  // auto-generated at create when no value is supplied.
  //   `{ type: 'uuid' }`      → DB-side default (PG gen_random_uuid(), MySQL
  //                             UUID()); SQLite + Mongo fall back to app-side autogen.
  //   `{ type: 'bigserial' }` → auto-incrementing integer key (PG BIGSERIAL,
  //                             MySQL BIGINT AUTO_INCREMENT, SQLite INTEGER PRIMARY
  //                             KEY AUTOINCREMENT). JS type becomes `number`, DB
  //                             assigns on insert. Throws at push on Mongo (no
  //                             auto-incrementing scalar id concept).
  id: (<T extends IdTypeName = 'auto'>(opts?: { type?: T }) => {
    const idType: IdTypeName = opts?.type ?? 'auto';
    return new Field<IdJsType<T>, 'id'>({
      kind: 'id',
      optional: false,
      unique: true,
      updatedAt: false,
      // bigserial is DB-assigned and `string` is caller-assigned — neither
      // gets an app-side generator.
      ...(idType === 'bigserial' || idType === 'string'
        ? {}
        : { default: { kind: 'autoId' as const } }),
      idType,
    });
  }) as IdFactory,

  // Foreign key style — string in app, ObjectId in db.
  objectId: () => make<string, 'objectId'>('objectId'),

  string: () => make<string, 'string'>('string'),
  // Unbounded string. Like f.string() except on MySQL: `string` → VARCHAR(255)
  // (indexable), `text` → TEXT (can't be UNIQUE without a key length).
  text: () => make<string, 'text'>('text'),
  int: () => make<number, 'int'>('int'),
  float: () => make<number, 'float'>('float'),

  // Exact numeric. JS type is `string` to avoid float-precision loss (e.g.
  // money). PG numeric(p,s) / MySQL DECIMAL(p,s) / SQLite NUMERIC / Mongo Decimal128.
  decimal: (opts: { precision?: number; scale?: number } = {}) =>
    new Field<string, 'decimal'>({
      kind: 'decimal',
      optional: false,
      unique: false,
      updatedAt: false,
      precision: opts.precision,
      scale: opts.scale,
    }),

  // UUID. JS type `string`. Pass `{ default: 'gen_random_uuid' }` to emit a
  // DB-side default (PG gen_random_uuid(), MySQL UUID()).
  uuid: (opts: { default?: 'gen_random_uuid' } = {}) =>
    new Field<string, 'uuid'>({
      kind: 'uuid',
      optional: false,
      unique: false,
      updatedAt: false,
      uuidDefault: opts.default === 'gen_random_uuid',
    }),

  // 64-bit integer. JS type `bigint` (use BigInt literals: 1n).
  // PG bigint / MySQL BIGINT / SQLite INTEGER / Mongo Long.
  bigint: () => make<bigint, 'bigint'>('bigint'),

  bool: () => make<boolean, 'bool'>('bool'),
  dateTime: () => make<Date, 'dateTime'>('dateTime'),
  // Typed JSON column. `f.json<Shape>()` carries `Shape` through to the row
  // read type and the create/update input; the default is `unknown` so an
  // un-parameterised `f.json()` forces callers to narrow rather than handing
  // back `any`. Pass `f.json<any>()` to opt back into the pre-2.6.4 behaviour.
  json: <T = unknown>() => make<T, 'json'>('json'),

  enumOf: <const V extends readonly string[]>(values: V) =>
    new Field<V[number], 'enum'>({
      kind: 'enum',
      optional: false,
      unique: false,
      updatedAt: false,
      enumValues: values,
    }),

  // Embedded composite types — Prisma `type Foo {}`. The embed is itself a tiny
  // model reusing the same Field map shape.
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

  /**
   * 2D geographic point — always WGS84 (SRID 4326) unless overridden. The
   * JS-side shape is `{ lng: number; lat: number }`. Per-dialect storage:
   *
   *   • Mongo  — GeoJSON in a JSON field (auto-coerced to/from { lng, lat }).
   *   • PG     — geography(Point, 4326) when PostGIS is installed. With
   *              `{ fallback: true }`, JSON storage + Haversine queries.
   *   • MySQL  — POINT NOT NULL SRID 4326 (8.0+). Built-in, no extension.
   *   • SQLite — SpatiaLite geometry when the extension loads. Otherwise
   *              JSON storage when `{ fallback: true }`.
   *   • DuckDB — GEOMETRY (spatial extension auto-loaded since 0.9).
   *   • MSSQL  — GEOGRAPHY (built-in since SQL Server 2008).
   *
   * Pair with `indexes: [{ keys: { col: 1 }, method: 'spatial' }]` to opt
   * into the dialect's spatial index family.
   */
  geoPoint: (opts: { srid?: number; fallback?: boolean; dims?: 2 | 3 } = {}) => {
    // make<> returns a Field<> whose .def carries the FieldDef; mutate the
    // FieldDef directly so the geo block lands on the shared definition the
    // schema layer reads downstream.
    //
    // `dims: 3` opts into XYZ storage — point becomes { lng, lat, alt }.
    // Per dialect:
    //   PG     → geography(PointZ, srid)             (PostGIS)
    //   MySQL  → POINT — 2D only; altitude stored alongside as raw JSON `alt`
    //            in the same column, surfaced to the user but not indexed by
    //            spatial. Distance ops remain ground-distance (2D-on-sphere).
    //   SQLite → SpatiaLite XYZ via dimension='XYZ' in the geometry constraint
    //   DuckDB → POINT_3D (spatial extension's 3D point)
    //   MSSQL  → GEOGRAPHY accepts Z natively
    //   Mongo  → GeoJSON Point with 3-element coords [lng, lat, alt]
    //
    // Distance semantics: `near` / `nearTo` still compute great-circle
    // distance on the ground (2D-on-sphere). Altitude is preserved on
    // round-trip but doesn't participate in distance — that's a TBD for
    // a future "3D distance" mode (would need a per-dialect choice between
    // 3D Euclidean and ground+vertical).
    const dims = opts.dims ?? 2;
    if (dims !== 2 && dims !== 3) {
      throw new Error(`[forge] f.geoPoint({ dims }): dims must be 2 or 3, got ${dims}`);
    }
    const fld = dims === 3
      ? make<{ lng: number; lat: number; alt: number }, 'geoPoint'>('geoPoint')
      : make<{ lng: number; lat: number }, 'geoPoint'>('geoPoint');
    fld.def.geo = {
      srid: opts.srid ?? 4326,
      fallback: !!opts.fallback,
      dims,
    };
    return fld;
  },

  /**
   * Dense numeric vector — embedding storage. Pair with
   * `indexes: [{ keys: { col: 1 }, method: 'vector' }]` to opt into the
   * dialect's vector index family (HNSW where available).
   *
   *   const Doc = model('docs', {
   *     id: f.id(),
   *     embedding: f.vector(1536, { metric: 'cosine' }),
   *   });
   */
  vector: (dims: number, opts: { metric?: 'cosine' | 'l2' | 'dot' } = {}) => {
    if (!Number.isInteger(dims) || dims <= 0) {
      throw new Error(`[forge] f.vector(dims): dims must be a positive integer, got ${dims}`);
    }
    const fld = make<number[], 'vector'>('vector');
    fld.def.vector = { dims, metric: opts.metric ?? 'cosine' };
    return fld;
  },
};

// Returns an object usable both at runtime (`Role.OWNER === 'OWNER'`) and as a
// type (`Role` ≡ `'OWNER' | 'ADMIN' | ...`). The `values` tuple feeds `f.enumOf(...)`.
export type EnumDef<V extends readonly string[]> = {
  readonly values: V;
} & { readonly [K in V[number]]: K };

export const enums = <const V extends readonly string[]>(values: V): EnumDef<V> => {
  const out: any = { values };
  for (const v of values) out[v] = v;
  return out as EnumDef<V>;
};

export const embed = <F extends Record<string, Field<any, any>>>(
  embedName: string,
  fields: F,
): EmbedDef<MapToFieldDefs<F>> => ({
  embedName,
  fields: mapFieldDefs(fields),
});

export interface ModelOptions {
  relations?: () => Record<string, RelationDef>;
  indexes?: IndexDef[];
  // Composite uniques: @@unique([user_email, business_id]) → [['user_email','business_id']]
  uniques?: string[][];
 /**
  * The field EVERY read of this model is filtered by — a tenant key, an
  * account id, whatever the application scopes on.
  *
  * Purely declarative: forge does not add the filter, because it cannot
  * know where the value comes from. Applications inject it themselves,
  * typically with a proxy around the client. What forge can do is CHECK
  * it, and `doctor` warns when nothing indexes the scope field.
  *
  * That check exists because the failure is silent and expensive. In one
  * multi-tenant schema, 66 collections holding 27,367 rows had no index
  * on their tenant key, so every read scanned the whole collection to
  * find one tenant's rows. It hid because those tables look small in
  * development — they have one row per customer, so they grow with the
  * customer list rather than with usage, and the scan gets slower for
  * everyone at once. Measured after indexing: 6,486 documents examined
  * became 40.
  *
  *   model('appointments', fields, {
  *     scopeBy: 'orgId',
  *     indexes: [{ keys: { orgId: 1, createdAt: -1 } }],
  *   })
  */
  scopeBy?: string;
}

// `.relate()` is a separate chained call (not inline model() options) on
// purpose: inline relations would force TS to walk the model type cycle
// (Business ↔ Subscription ↔ Business, etc.) and collapse every cyclic model to
// `any`. The chain avoids this — `model('name', fields)` infers F leaf-only, and
// `.relate<R>(rels)` captures R (relation name → RelationDef) without evaluating
// relation TARGETS; the cycle lives in target types, not relation names.
interface ChainableModel<F extends Record<string, Field<any, any>>>
  extends TypedModel<F, {}> {
  relate<R extends Record<string, RelationInfo>>(
    rels: () => R,
  ): TypedModel<F, R>;
  // Declare this model as a read-only view, backed by CREATE VIEW (SQL) or
  // createCollection-as-view (Mongo). The wrapper blocks all writes.
  asView(spec: {
    sql?: string;
    pipeline?: unknown[];
    sourceCollection?: string;
    // Materialised view: physical, refreshable via db.<model>.refresh().
    materialised?: boolean;
    // Auto-refresh interval, e.g. '30s', '5m', '1h'.
    refreshEvery?: string;
  }): TypedModel<F, {}>;
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
    ...(options.scopeBy ? { scopeBy: options.scopeBy } : {}),
  };
  def.relate = function (rels: () => Record<string, RelationDef>) {
    this.relations = rels;
    return this;
  };
  (def as any).asView = function (
    spec: { sql?: string; pipeline?: unknown[]; sourceCollection?: string },
  ) {
    this.view = spec;
    return this;
  };
  return def as unknown as ChainableModel<F>;
};

// Relation declarations use STRING TARGETS (schema keys), not type references.
// This is what enables deep include/select resolution without TypeScript
// inference cycles: the relation graph is mutually recursive (User ↔ Profile,
// Comment ↔ Comment, etc.), and forcing TS to look up the target's type would
// collapse every model in a cycle to `any`. The target rides as a literal string
// in the type and is looked up against the schema map at runtime.
//
// Trade-off: declaration-time typos aren't caught at compile time (the schema
// map isn't fully built yet); they surface at first runtime use.
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

export type TypedModel<
  F extends Record<string, Field<any, any>>,
  R extends Record<string, RelationInfo> = {},
> = ModelDef<MapToFieldDefs<F>> & {
  // Phantom carriers — never read at runtime. R is a flat record of RelationInfo
  // (kind + literal string target), no nested model references, so cycles stay
  // broken while resolution types walk relations via `Schema[target]` lookups.
  readonly _fields?: F;
  readonly _relations?: R;
  readonly _row?: ResolvedRow<F>;
};

export type MapToFieldDefs<F extends Record<string, Field<any, any>>> = {
  [K in keyof F]: FieldDef;
};

export type FieldType<X> = X extends Field<infer T, any> ? T : never;

type ResolvedRow<F extends Record<string, Field<any, any>>> = {
  [K in keyof F]: FieldType<F[K]>;
};

// Used by `f.embed`/`f.embedMany`.
type EmbedRow<F extends Record<string, Field<any, any>>> = {
  [K in keyof F]: FieldType<F[K]>;
};

// Prisma-shape input types for the typed query API. All are parameterised over
// F (fields) and R (relation-name record) and DO NOT walk into relation targets
// — that's where cycles originate. Top-level autocomplete works fully; nested
// relation args fall back to `any` to keep inference shallow and cycle-free
// without codegen.

export type _Val<X> = X extends Field<infer T, any> ? T : never;

// Input-side variant — accepts ISO date strings for dateTime, loosens embedded
// shapes (defaults applied at create, so every embed field is optional on
// write), and carries the parameterised type through for json. The `[X]
// extends [...]` tuple-wrap is essential: it makes the conditional
// non-distributive, so `Field<any, 'json'>` doesn't trigger both branches via
// TypeScript's `any`-flow rules.
type _InputVal<X> = [X] extends [Field<Date, 'dateTime'>]
  ? Date | string
  : [X] extends [Field<infer T, 'embed'>]
    ? Partial<T>
    : [X] extends [Field<infer T, 'embedMany'>]
      ? [T] extends [(infer U)[]]
        ? Partial<U>[]
        : never
      : [X] extends [Field<infer T, 'json'>]
        ? T
        : _Val<X>;

// `N` carries the field's nullability into equals/not/in/notIn — an
// `.optional()` column can be compared to null, but the ordering / pattern
// operators still take the bare scalar (comparing against null in `lte` or
// `contains` is never meaningful).
type StringFilter<N = never> = {
  equals?: string | N;
  not?: string | N | StringFilter<N>;
  in?: (string | N)[];
  notIn?: (string | N)[];
  lt?: string;
  lte?: string;
  gt?: string;
  gte?: string;
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  mode?: 'default' | 'insensitive';
};

type NumberFilter<N = never> = {
  equals?: number | N;
  not?: number | N | NumberFilter<N>;
  in?: (number | N)[];
  notIn?: (number | N)[];
  lt?: number;
  lte?: number;
  gt?: number;
  gte?: number;
};

type DateFilter<N = never> = {
  equals?: Date | string | N;
  not?: Date | string | N | DateFilter<N>;
  in?: (Date | string | N)[];
  notIn?: (Date | string | N)[];
  lt?: Date | string;
  lte?: Date | string;
  gt?: Date | string;
  gte?: Date | string;
};

type BoolFilter<N = never> = {
  equals?: boolean | N;
  not?: boolean | N | BoolFilter<N>;
};

type ListFilter<T> = {
  equals?: T[];
  has?: T;
  hasEvery?: T[];
  hasSome?: T[];
  isEmpty?: boolean;
  // Composite-list (embedMany) operators — filtering on lists of embedded objects.
  some?: Partial<T> | any;
  every?: Partial<T> | any;
  none?: Partial<T> | any;
};

// Branch on NonNullable<T>: an `.optional()` column has type `T | null`,
// which does not extend the bare scalar, so it used to fall through every
// branch to the generic equals/not/in/notIn fallback — silently losing
// lt/lte/gt/gte/contains/… on precisely the columns that need casting the
// most. Nullability is preserved separately via the `N` parameter.
type ScalarFilterFor<T, NN = NonNullable<T>, N = [null] extends [T] ? null : never> =
  [NN] extends [string]
    ? StringFilter<N>
    : [NN] extends [number]
      ? NumberFilter<N>
      : [NN] extends [boolean]
        ? BoolFilter<N>
        : [NN] extends [Date]
          ? DateFilter<N>
          : [NN] extends [(infer U)[]]
            ? ListFilter<U>
            : { equals?: T; not?: T; in?: T[]; notIn?: T[] };

// WhereInput — autocompletes scalar field names + AND/OR/NOT. The
// `[k: string]: any` fallback accepts composite-unique synthetic keys (e.g.
// `user_profile_id_comment_id` for `@@unique([...])` lookups) and Mongo-native
// operators (`$or`, `$and`). Trade-off: field-name typos aren't caught, but real
// fields still autocomplete.
export type WhereInput<F extends Record<string, Field<any, any>>> = {
  [K in keyof F]?: _InputVal<F[K]> | ScalarFilterFor<_Val<F[K]>> | null;
} & {
  AND?: WhereInput<F> | WhereInput<F>[];
  OR?: WhereInput<F>[];
  NOT?: WhereInput<F> | WhereInput<F>[];
} & {
  [key: string]: any;
};

type RelKeys<R> = Extract<keyof R, string>;

// Make `select` and `include` mutually exclusive at compile time: intersecting a
// method's args with this turns "both present" into an impossible type
// (select: never), so the call fails to typecheck. One or neither → `unknown`.
export type NoBothSelectInclude<A> = A extends { select: any; include: any }
  ? { select: never; include: 'forge: use either `select` or `include`, not both' }
  : unknown;

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
// relations recursively.

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

// Recursion depth governor — TS bails around ~50 levels of conditional-type
// nesting. We cap explicit relation nesting at 10 so deep includes still
// resolve cleanly with autocomplete.
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

// CursorInput — pagination cursor: single-field `{ id: 'x' }`, or composite
// synthetic-key form `{ user_id_video_id: { user_id: 'u', video_id: 'v' } }`.
export type CursorInput =
  | { id?: string }
  | { [compositeKey: string]: any };

// Resolve<> — output-type resolution. Walks the requested include/select args
// and synthesises the actual return shape, e.g.:
//   findMany({ include: { creator: { include: { videos: true } } } })
//     → (Video & { creator: UserProfile & { videos: Video[] } })[]
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

function mapFieldDefs<F extends Record<string, Field<any, any>>>(fields: F): MapToFieldDefs<F> {
  const out: any = {};
  for (const k of Object.keys(fields)) out[k] = (fields[k] as Field<any, any>).def;
  return out;
}

// `type User = Row<typeof User>` gives the row shape (all fields, id as string,
// dates as Date). Relations are added separately via include.
export type Row<M> = M extends TypedModel<infer F, any> ? ResolvedRow<F> : never;

// Pull F (fields) / R (relations) out of a TypedModel for input/output-type
// derivation. Used by CollectionWrapper signatures.
export type ModelFields<M> = M extends TypedModel<infer F, any> ? F : never;
export type ModelRelations<M> =
  M extends TypedModel<any, infer R> ? R : Record<string, never>;
export type ModelRelationNames<M> = Extract<keyof ModelRelations<M>, string>;
