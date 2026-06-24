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

// Walk the model's fields and return the name of the field flagged with
// `.softDeleteAt()`. Used by the compile-side softDelete/restore — same gate
// the runtime collection wrapper uses, just thrown at compile() time.
function softDeleteField(model: ModelDef<any>): string | undefined {
  for (const [name, fdef] of Object.entries(model.fields)) {
    if ((fdef as any)?.softDeleteAt) return name;
  }
  return undefined;
}

function requireSoftDeleteField(model: ModelDef<any>, op: string): string {
  const sd = softDeleteField(model);
  if (!sd) {
    throw new Error(
      `[forge] compile.${op}() requires a field declared with .softDeleteAt() ` +
      `on model '${model.collection}'. Use compile.delete()/compile.deleteMany() ` +
      `for hard deletes.`,
    );
  }
  return sd;
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

    // Soft delete / restore compile to update IRs that set/clear the
    // `.softDeleteAt()` column. Same shape as the runtime collection
    // wrapper (collection.softDelete → this.update with data:{<sd>: new Date()}),
    // just compiled instead of executed.
    softDelete: (args: any) => {
      const sd = requireSoftDeleteField(model, 'softDelete');
      const art = compileUpdate(buildUpdate(mk, model, {
        where: args.where,
        data: { [sd]: new Date() } as any,
        semantic: "softDelete",
        many: false,
        returning: args,
      }), model);
      (art as any).semanticOp = "softDelete";
      return art;
    },
    softDeleteMany: (args?: any) => {
      const sd = requireSoftDeleteField(model, 'softDeleteMany');
      const art = compileUpdate(buildUpdate(mk, model, {
        where: args?.where,
        data: { [sd]: new Date() } as any,
        semantic: "softDeleteMany",
        many: true,
      }), model);
      (art as any).semanticOp = "softDeleteMany";
      return art;
    },
    restore: (args: any) => {
      const sd = requireSoftDeleteField(model, 'restore');
      const art = compileUpdate(buildUpdate(mk, model, {
        where: args.where,
        data: { [sd]: null } as any,
        semantic: "restore",
        many: false,
        returning: args,
      }), model);
      (art as any).semanticOp = "restore";
      return art;
    },
    restoreMany: (args?: any) => {
      const sd = requireSoftDeleteField(model, 'restoreMany');
      const art = compileUpdate(buildUpdate(mk, model, {
        where: args?.where,
        data: { [sd]: null } as any,
        semantic: "restoreMany",
        many: true,
      }), model);
      (art as any).semanticOp = "restoreMany";
      return art;
    },

    aggregate:  (args: { pipeline: any[]; options?: any }): MongoArtifact => ({
      kind: 'mongo',
      collection: model.collection,
      op: 'aggregate',
      args: { pipeline: coerceExtendedJSON(args.pipeline ?? []), options: args.options },
    }),
  };
}
