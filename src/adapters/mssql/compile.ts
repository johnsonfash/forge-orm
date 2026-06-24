import type { ModelDef } from '../../schema/types';
import type { SQLArtifact, SQLCompileApi } from '../../compile';
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
import { schema } from '../../schema';

function modelKeyFor(model: ModelDef<any>): string {
  for (const key of Object.keys(schema as any)) {
    if ((schema as any)[key] === model) return key;
  }
  return model.collection;
}

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
      `[forge] compile.${op}() requires a field declared with .softDeleteAt() on model '${model.collection}'.`,
    );
  }
  return sd;
}

export function buildMssqlCompileApi(model: ModelDef<any>): SQLCompileApi {
  const mk = modelKeyFor(model);
  const upsertUnsupported = () => {
    throw new Error(
      `[forge:mssql] upsert / ON CONFLICT is not implemented in 2.3. The T-SQL ` +
      `equivalent (MERGE) lands in v2.4. Until then, use findFirst → update / create.`,
    );
  };
  return {
    findFirst:  (args?: any) => compileSelect(buildSelect(mk, model, args, 'one'), model),
    findUnique: (args: any)  => compileSelect(buildSelect(mk, model, args, 'one'), model),
    findMany:   (args?: any) => compileSelect(buildSelect(mk, model, args, 'many'), model),
    count:      (args?: any) => compileCount(buildCount(mk, model, args), model),

    create:     (args: any) => compileInsert(buildInsert(mk, model, { rows: [args.data], returning: args }), model),
    createMany: (args: any) => {
      const rows = args.data ?? [];
      return compileInsert(buildInsert(mk, model, { rows, skipDuplicates: !!args.skipDuplicates }), model);
    },

    update:     (args: any) => compileUpdate(buildUpdate(mk, model, { where: args.where, data: args.data, many: false, returning: args }), model),
    updateMany: (args: any) => compileUpdate(buildUpdate(mk, model, { where: args.where, data: args.data, many: true }), model),
    upsert:     (_args: any) => upsertUnsupported(),

    delete:     (args: any) => compileDelete(buildDelete(mk, model, { where: args.where, many: false, returning: args }), model),
    deleteMany: (args?: any) => compileDelete(buildDelete(mk, model, { where: args?.where, many: true }), model),

    softDelete: (args: any) => {
      const sd = requireSoftDeleteField(model, 'softDelete');
      const art = compileUpdate(buildUpdate(mk, model, {
        where: args.where, data: { [sd]: new Date() } as any, semantic: "softDelete",
        many: false, returning: args,
      }), model);
      (art as any).semanticOp = "softDelete";
      return art;
    },
    softDeleteMany: (args?: any) => {
      const sd = requireSoftDeleteField(model, 'softDeleteMany');
      const art = compileUpdate(buildUpdate(mk, model, {
        where: args?.where, data: { [sd]: new Date() } as any, semantic: "softDeleteMany", many: true,
      }), model);
      (art as any).semanticOp = "softDeleteMany";
      return art;
    },
    restore: (args: any) => {
      const sd = requireSoftDeleteField(model, 'restore');
      const art = compileUpdate(buildUpdate(mk, model, {
        where: args.where, data: { [sd]: null } as any, semantic: "restore", many: false, returning: args,
      }), model);
      (art as any).semanticOp = "restore";
      return art;
    },
    restoreMany: (args?: any) => {
      const sd = requireSoftDeleteField(model, 'restoreMany');
      const art = compileUpdate(buildUpdate(mk, model, {
        where: args?.where, data: { [sd]: null } as any, semantic: "restoreMany", many: true,
      }), model);
      (art as any).semanticOp = "restoreMany";
      return art;
    },
  };
}

export type _SQLArtifact = SQLArtifact;
