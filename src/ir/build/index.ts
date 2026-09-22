import type { ModelDef } from '../../schema/types';
import type {
  CountNode,
  DeleteNode,
  GroupByNode,
  InsertNode,
  RelationPlan,
  SelectNode,
  UpdateNode,
} from '../types';
import { buildCursor } from './cursor';
import { buildOrderBy } from './orderby';
import { buildProjection } from './projection';
import { buildUpdateData } from './data';
import { buildWhereTree, vanishedWhereError, whereVanished, type SchemaContext } from './where';

// High-level entrypoints used by CollectionWrapper (and `compile.*` paths) to
// turn user args into IR nodes. Each builder is pure — no driver imports.
//
// Pass `schema` to enable schema-aware recursion (deep relation where, nested
// relation include with where/orderBy/take). Without schema, builders degrade
// to single-level.

export interface BuildSelectArgs {
  where?: any;
  select?: any;
  include?: any;
  omit?: any;
  orderBy?: any;
  take?: number;
  limit?: number;
  skip?: number;
  offset?: number;
  cursor?: any;
  distinct?: string[];
}

export function buildSelect(
  modelKey: string,
  model: ModelDef<any>,
  args: BuildSelectArgs | undefined,
  cardinality: 'one' | 'many',
  schema?: SchemaContext,
): SelectNode {
  const a = args ?? {};
  const { projection, hydration } = buildProjection(model, a, schema);
  const where = buildWhereTree(model, a.where, schema);
  if (whereVanished(a.where, where)) {
    throw vanishedWhereError(
      cardinality === 'one' ? 'findFirst/findUnique' : 'findMany',
      model.collection,
      a.where,
    );
  }
  const node: SelectNode = {
    kind: 'select',
    model: modelKey,
    cardinality,
    where,
    projection,
    hydration: hydration ? materialiseHydration(hydration, schema) : undefined,
    orderBy: buildOrderBy(a.orderBy),
    limit: a.take ?? a.limit,
    offset: a.skip ?? a.offset,
    cursor: buildCursor(a.cursor),
    distinct: a.distinct?.length ? a.distinct : undefined,
  };
  return node;
}

// Turn each RelationPlan's stashed __rawArgs / __target into a full nested
// SelectNode. This is what makes hydration recursive at the IR level: an
// adapter executing a SelectNode can find a fully-resolved sub-SelectNode for
// each related entity to fetch.
function materialiseHydration(
  hydration: RelationPlan[],
  schema?: SchemaContext,
): RelationPlan[] {
  if (!schema) return hydration;
  return hydration.map((rp) => {
    if (!rp.nested) return rp;
    const raw = (rp.nested as any).__rawArgs;
    const target = (rp.nested as any).__target ?? rp.target;
    if (!raw) return rp;
    const targetModel = schema[target];
    if (!targetModel) return rp;
    const sub = buildSelect(target, targetModel, raw, rp.kind === 'one' ? 'one' : 'many', schema);
    // RelationPlan's nested is a SelectNode minus kind/model, plus a cardinality
    // override — strip the former.
    const { kind: _k, model: _m, cardinality, ...rest } = sub;
    return {
      ...rp,
      nested: { ...rest, cardinality },
    };
  });
}

export function buildCount(
  modelKey: string,
  model: ModelDef<any>,
  args: { where?: any; distinct?: string[] } | undefined,
  schema?: SchemaContext,
): CountNode {
  const a = args ?? {};
  const where = buildWhereTree(model, a.where, schema);
  if (whereVanished(a.where, where)) {
    throw vanishedWhereError('count', model.collection, a.where);
  }
  return {
    kind: 'count',
    model: modelKey,
    where,
    distinct: a.distinct?.length ? a.distinct : undefined,
  };
}

export interface BuildInsertArgs {
  rows: Record<string, any>[];    // pre-coerced documents
  skipDuplicates?: boolean;
  returning?: { select?: any; include?: any; omit?: any };
}

export function buildInsert(
  modelKey: string,
  model: ModelDef<any>,
  args: BuildInsertArgs,
  schema?: SchemaContext,
): InsertNode {
  const { projection, hydration } = args.returning
    ? buildProjection(model, args.returning, schema)
    : {};
  return {
    kind: 'insert',
    model: modelKey,
    rows: args.rows,
    skipDuplicates: args.skipDuplicates,
    returning: projection,
    hydration: hydration ? materialiseHydration(hydration, schema) : undefined,
  };
}

export interface BuildUpdateArgs {
  where: any;
  data: any;
  many?: boolean;
  upsertCreate?: Record<string, any>;
  returning?: { select?: any; include?: any; omit?: any };
  /** Schema-level intent set by the wrapper (softDelete / restore call-sites). */
  semantic?: UpdateNode['semantic'];
}

export function buildUpdate(
  modelKey: string,
  model: ModelDef<any>,
  args: BuildUpdateArgs,
  schema?: SchemaContext,
): UpdateNode {
  const frag = buildUpdateData(model, args.data);
  const { projection, hydration } = args.returning
    ? buildProjection(model, args.returning, schema)
    : {};
  const where = buildWhereTree(model, args.where, schema);
  if (whereVanished(args.where, where)) {
    throw vanishedWhereError(args.many ? 'updateMany' : 'update', model.collection, args.where);
  }
  return {
    kind: 'update',
    model: modelKey,
    where: where ?? { kind: 'and', children: [] },
    set: frag.set,
    increment: frag.increment,
    multiply: frag.multiply,
    divide: frag.divide,
    max: frag.max,
    min: frag.min,
    push: frag.push,
    addToSet: frag.addToSet,
    pull: frag.pull,
    unset: frag.unset,
    many: !!args.many,
    upsertCreate: args.upsertCreate,
    returning: projection,
    hydration: hydration ? materialiseHydration(hydration, schema) : undefined,
    semantic: args.semantic,
  };
}

export interface BuildDeleteArgs {
  where: any;
  many?: boolean;
  returning?: { select?: any; include?: any; omit?: any };
}

export function buildDelete(
  modelKey: string,
  model: ModelDef<any>,
  args: BuildDeleteArgs,
  schema?: SchemaContext,
): DeleteNode {
  const { projection } = args.returning
    ? buildProjection(model, args.returning, schema)
    : {};
  const where = buildWhereTree(model, args.where, schema);
  if (whereVanished(args.where, where)) {
    throw vanishedWhereError(args.many ? 'deleteMany' : 'delete', model.collection, args.where);
  }
  return {
    kind: 'delete',
    model: modelKey,
    where: where ?? { kind: 'and', children: [] },
    many: !!args.many,
    returning: projection,
  };
}

export interface BuildGroupByArgs {
  by: string[];
  where?: any;
  having?: any;
  _count?: { _all?: boolean } & Record<string, boolean | undefined>;
  _avg?: Record<string, boolean>;
  _sum?: Record<string, boolean>;
  _min?: Record<string, boolean>;
  _max?: Record<string, boolean>;
  orderBy?: any;
  take?: number;
  limit?: number;
  skip?: number;
  offset?: number;
}

// Aggregate buckets recognised in a `having` clause.
const AGG_BUCKETS = new Set(['_count', '_avg', '_sum', '_min', '_max']);

// Normalise `having` to the canonical bucket-first shape the compilers expect
// (`{ _sum: { total: { gte: 1 } } }`). Prisma's real surface is field-first
// (`{ total: { _sum: { gte: 1 } } }`), so we accept BOTH and flip field-first
// into bucket-first here — one place, both the Mongo and SQL compilers benefit.
function normalizeHaving(having: any): any {
  if (!having || typeof having !== 'object') return having;
  const out: Record<string, any> = {};
  for (const [key, val] of Object.entries(having)) {
    if (!val || typeof val !== 'object') continue;
    if (AGG_BUCKETS.has(key)) {
      out[key] = { ...(out[key] ?? {}), ...(val as Record<string, any>) };
    } else {
      // Field-first `{ field: { _sum: {op} } }` → `{ _sum: { field: {op} } }`.
      for (const [bucket, opObj] of Object.entries(val as Record<string, any>)) {
        if (!AGG_BUCKETS.has(bucket)) continue;
        (out[bucket] ??= {})[key] = opObj;
      }
    }
  }
  return out;
}

export function buildGroupBy(
  modelKey: string,
  model: ModelDef<any>,
  args: BuildGroupByArgs,
  schema?: SchemaContext,
): GroupByNode {
  const where = buildWhereTree(model, args.where, schema);
  if (whereVanished(args.where, where)) {
    throw vanishedWhereError('groupBy', model.collection, args.where);
  }
  // Each bucket is a field→boolean map, not a bare boolean. `_count: true`
  // contributes no SELECT column, so it was silently dropped when another
  // bucket was present and produced `SELECT  FROM …` — a syntax error — when
  // it was the only one. Say what the shape is instead.
  for (const bucket of ['_count', '_avg', '_sum', '_min', '_max'] as const) {
    const v = (args as unknown as Record<string, unknown>)[bucket];
    if (v === undefined || (typeof v === 'object' && v !== null)) continue;
    throw new Error(
      `[forge] groupBy on '${model.collection}': ${bucket} takes a map of fields, ` +
      `not ${JSON.stringify(v)}. Use ` +
      (bucket === '_count'
        ? '`_count: { _all: true }` for the row count, or `_count: { <field>: true }`.'
        : `\`${bucket}: { <field>: true }\`.`),
    );
  }
  return {
    kind: 'groupBy',
    model: modelKey,
    by: args.by,
    where,
    having: normalizeHaving(args.having),
    _count: args._count,
    _avg: args._avg,
    _sum: args._sum,
    _min: args._min,
    _max: args._max,
    orderBy: buildOrderBy(args.orderBy),
    limit: args.take ?? args.limit,
    offset: args.skip ?? args.offset,
  };
}

export { buildWhereTree, buildOrderBy, buildProjection, buildUpdateData, buildCursor };
export type { SchemaContext };
