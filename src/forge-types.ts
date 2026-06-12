// Per-model ergonomic type aliases — Prisma-shape DX without codegen. Two access
// styles, same underlying mapped type:
//   1) Generic by schema key:  ForgeOf<'user'>['WhereInput']
//   2) Capitalised lookup:     ForgeModels['User']['WhereInput']
// Everything derives from the live schema, so it updates on save with no
// `prisma generate` step.

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

// Per-model bundle — all the query-building types for one model.
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

      // Resolved return shape for a given args object — the exact return type of
      // findFirst/findMany/etc.
      Payload: <Args>(args: Args) => Resolve<F, R, Args, SchemaMap>;
    }
  : never;

export type ForgeOf<K extends keyof SchemaMap> = PerModelTypes<SchemaMap[K]>;

export type ForgeModels = {
  [K in keyof SchemaMap as Capitalize<K & string>]: PerModelTypes<SchemaMap[K]>;
};
