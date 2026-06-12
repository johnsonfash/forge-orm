import type { ModelDef } from '../../schema/types';
import type { MongoArtifact, MongoCompileApi } from '../../compile';
import {
  buildCount,
  buildDelete,
  buildInsert,
  buildSelect,
  buildUpdate,
} from '../../ir/build';
import {
  compileCount,
  compileDelete,
  compileInsert,
  compileSelect,
  compileUpdate,
} from './compile-from-ir';
import { coerceCreatePayload, coerceExtendedJSON } from './coerce';
import { schema } from '../../schema';

// Mongo compile API — args in, MongoArtifact out. Every method routes through
// the IR (args → buildIR → compileFromIR).

function modelKeyFor(model: ModelDef<any>): string {
  for (const key of Object.keys(schema as any)) {
    if ((schema as any)[key] === model) return key;
  }
  // Fall back to collection name for ad-hoc models (tests etc.)
  return model.collection;
}

export function buildMongoCompileApi(model: ModelDef<any>): MongoCompileApi {
  const mk = modelKeyFor(model);
  return {
    findFirst:  (args?: any) => compileSelect(buildSelect(mk, model, args, 'one'), model),
    findUnique: (args: any)  => compileSelect(buildSelect(mk, model, args, 'one'), model),
    findMany:   (args?: any) => compileSelect(buildSelect(mk, model, args, 'many'), model),

    count:      (args?: any) => compileCount(buildCount(mk, model, args), model),

    create:     (args: any) => {
      const row = coerceCreatePayload(model, args.data);
      return compileInsert(buildInsert(mk, model, { rows: [row], returning: args }), model);
    },
    createMany: (args: any) => {
      const rows = (args.data ?? []).map((d: any) => coerceCreatePayload(model, d));
      return compileInsert(buildInsert(mk, model, {
        rows,
        skipDuplicates: !!args.skipDuplicates,
      }), model);
    },

    update:     (args: any) => compileUpdate(buildUpdate(mk, model, {
      where: args.where, data: args.data, many: false, returning: args,
    }), model),
    updateMany: (args: any) => compileUpdate(buildUpdate(mk, model, {
      where: args.where, data: args.data, many: true,
    }), model),
    upsert:     (args: any) => {
      const upsertCreate = coerceCreatePayload(model, args.create);
      return compileUpdate(buildUpdate(mk, model, {
        where: args.where, data: args.update, many: false,
        upsertCreate, returning: args,
      }), model);
    },

    delete:     (args: any) => compileDelete(buildDelete(mk, model, {
      where: args.where, many: false, returning: args,
    }), model),
    deleteMany: (args?: any) => compileDelete(buildDelete(mk, model, {
      where: args?.where, many: true,
    }), model),

    aggregate:  (args: { pipeline: any[]; options?: any }): MongoArtifact => ({
      kind: 'mongo',
      collection: model.collection,
      op: 'aggregate',
      args: { pipeline: coerceExtendedJSON(args.pipeline ?? []), options: args.options },
    }),
  };
}
