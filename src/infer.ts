// Direct-from-model inference helpers. Unlike `ForgeOf` / `ForgeModels`
// (forge-types.ts), which resolve against the active SchemaMap, these `Infer*`
// aliases take a `typeof MyModel` directly — useful for service signatures, DTOs,
// or before a model is wired into a map. Pass an optional schema map as the
// second arg for relation autocomplete in `Select` / `Include`; omit it for
// scalar fields only.
//
//   type UserRow    = InferRow<typeof User>;
//   type UserCreate = InferCreate<typeof User>;
//   type UserAll    = Infer<typeof User>;
//
//   const schema = { user: User, post: Post } as const;
//   type Article = InferSchema<typeof schema>['post']['Create'];

import type { TypedModel } from './schema/core';
import type {
  CreateInput,
  IncludeInputFor,
  ModelFields,
  ModelRelations,
  OrderByInput,
  Row,
  SelectInputFor,
  UpdateInput,
  WhereInput,
} from './schema/core';

// Empty schema sentinel — used when the caller does not supply one. The
// resulting Select/Include types still autocomplete scalar fields cleanly;
// nested relation walks fall through to the SelectInputFor "loose" branch.
type EmptySchema = Record<string, TypedModel<any, any>>;

/** Row shape — the object returned by find/create after defaults are filled in. */
export type InferRow<M> = Row<M>;

/** `where` input — scalar filters + AND/OR/NOT + permissive index. */
export type InferWhere<M> = WhereInput<ModelFields<M>>;

/** `where` input narrowed to unique-key lookups (Partial — runtime picks the key). */
export type InferWhereUnique<M> = Partial<WhereInput<ModelFields<M>>>;

/** `create` input — scalar values + nested relation directives. */
export type InferCreate<M> = CreateInput<ModelFields<M>, ModelRelations<M>>;

/** `update` input — scalar updates (with atomic ops for numbers) + relation directives. */
export type InferUpdate<M> = UpdateInput<ModelFields<M>, ModelRelations<M>>;

/** `upsert` input — `{ create, update }` pair using the matching shapes. */
export type InferUpsert<M> = { create: InferCreate<M>; update: InferUpdate<M> };

/** `orderBy` input — `{ field: 'asc' | 'desc' }` per scalar field. */
export type InferOrderBy<M> = OrderByInput<ModelFields<M>>;

/** `select` input — boolean toggles on scalars + nested args on relations
 *  (relation walking requires the optional schema-map second generic). */
export type InferSelect<M, S extends EmptySchema = EmptySchema> = SelectInputFor<
  ModelFields<M>,
  ModelRelations<M>,
  S
>;

/** `include` input — relation names to hydrate. Relation walking requires
 *  the optional schema-map second generic. */
export type InferInclude<M, S extends EmptySchema = EmptySchema> = IncludeInputFor<
  ModelRelations<M>,
  S
>;

/** `omit` input — boolean toggles per scalar field. */
export type InferOmit<M> = { [K in keyof ModelFields<M>]?: boolean };

/**
 * One bundle of every input/output type for a single model. Mirrors the
 * shape of `PerModelTypes` but works on any `typeof Model` without
 * requiring registration in the active `SchemaMap`.
 *
 *   type T = Infer<typeof User>;
 *   const data: T['Create'] = { email: 'a@b.co' };
 *   const where: T['Where'] = { id: { in: ['x'] } };
 */
export type Infer<M, S extends EmptySchema = EmptySchema> = {
  Row: InferRow<M>;
  Where: InferWhere<M>;
  WhereUnique: InferWhereUnique<M>;
  Create: InferCreate<M>;
  Update: InferUpdate<M>;
  Upsert: InferUpsert<M>;
  OrderBy: InferOrderBy<M>;
  Select: InferSelect<M, S>;
  Include: InferInclude<M, S>;
  Omit: InferOmit<M>;
};

/**
 * Map every model in a schema record to its inferred bundle. Relations
 * are resolved against the same schema, so `Select` and `Include` walk
 * the full graph with autocomplete.
 *
 *   const schema = { user: User, post: Post } as const;
 *   type T = InferSchema<typeof schema>;
 *   type UserCreate = T['user']['Create'];
 *   type PostInclude = T['post']['Include'];      // { author?: boolean | { ... } }
 */
export type InferSchema<S extends EmptySchema> = {
  [K in keyof S]: Infer<S[K], S>;
};
