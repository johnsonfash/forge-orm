// Per-model ergonomic type aliases — Prisma-shape DX without codegen.
//
// Two access styles, both backed by the same mapped type:
//
//   1) Generic by schema key (works for every model, even custom ones):
//        type W = ForgeOf<'user'>['WhereInput'];
//        type C = ForgeOf<'video'>['CreateInput'];
//        type R = ForgeOf<'comment'>['Payload'];   // dependent on args
//
//   2) Capitalised dotted lookup over the schema map:
//        type W = ForgeModels['User']['WhereInput'];
//        type R = ForgeModels['Video']['Payload'];
//
// Everything derives from the live schema — adding/removing a model or field
// updates these on save. No `prisma generate` step.

import type { SchemaMap } from './schema';
import type {
  CreateInput as CreateInputT,
  IncludeInputFor,
  ModelFields,
  ModelRelations,
  OrderByInput as OrderByInputT,
  Resolve,
  SelectInputFor,
  TypedModel,
  UpdateInput as UpdateInputT,
  WhereInput as WhereInputT,
} from './schema/core';

// Per-model bundle — all the types you'd reach for when building queries.
export type PerModelTypes<M> = M extends TypedModel<infer F, infer R>
  ? {
      WhereInput: WhereInputT<F>;
      WhereUniqueInput: Partial<WhereInputT<F>>;
      ScalarWhereInput: WhereInputT<F>;

      CreateInput: CreateInputT<F, R>;
      UpdateInput: UpdateInputT<F, R>;
      UpsertInput: { create: CreateInputT<F, R>; update: UpdateInputT<F, R> };

      Select: SelectInputFor<F, R, SchemaMap>;
      Include: IncludeInputFor<R, SchemaMap>;
      Omit: { [K in keyof F]?: boolean };

      OrderByInput: OrderByInputT<F>;

      // Args bundles (shape per Prisma's `db.<model>.<op>Args`).
      FindFirstArgs: {
        where?: WhereInputT<F>;
        select?: SelectInputFor<F, R, SchemaMap>;
        include?: IncludeInputFor<R, SchemaMap>;
        omit?: { [K in keyof F]?: boolean };
        orderBy?: OrderByInputT<F> | OrderByInputT<F>[];
        take?: number; limit?: number;
        skip?: number; offset?: number;
        cursor?: { [k: string]: any };
        distinct?: Array<keyof F & string>;
      };
      FindManyArgs: PerModelTypes<M>['FindFirstArgs'];
      FindUniqueArgs: {
        where: WhereInputT<F>;
        select?: SelectInputFor<F, R, SchemaMap>;
        include?: IncludeInputFor<R, SchemaMap>;
        omit?: { [K in keyof F]?: boolean };
      };
      CreateArgs: { data: CreateInputT<F, R>; select?: SelectInputFor<F, R, SchemaMap>; include?: IncludeInputFor<R, SchemaMap> };
      CreateManyArgs: { data: CreateInputT<F, R>[]; skipDuplicates?: boolean };
      UpdateArgs: { where: WhereInputT<F>; data: UpdateInputT<F, R>; select?: SelectInputFor<F, R, SchemaMap>; include?: IncludeInputFor<R, SchemaMap> };
      UpdateManyArgs: { where: WhereInputT<F>; data: UpdateInputT<F, R> };
      UpsertArgs: { where: WhereInputT<F>; create: CreateInputT<F, R>; update: UpdateInputT<F, R> };
      DeleteArgs: { where: WhereInputT<F> };
      DeleteManyArgs: { where?: WhereInputT<F> };
      CountArgs: { where?: WhereInputT<F>; distinct?: Array<keyof F & string> };

      // Resolved return shape for a given args object — `Payload<typeof args>`
      // gives you the exact return type of findFirst/findMany/etc.
      Payload: <Args>(args: Args) => Resolve<F, R, Args, SchemaMap>;
    }
  : never;

// Generic accessor: ForgeOf<'user'>['WhereInput']
export type ForgeOf<K extends keyof SchemaMap> = PerModelTypes<SchemaMap[K]>;

// Capitalised map: ForgeModels['User']['WhereInput']
export type ForgeModels = {
  [K in keyof SchemaMap as Capitalize<K & string>]: PerModelTypes<SchemaMap[K]>;
};
