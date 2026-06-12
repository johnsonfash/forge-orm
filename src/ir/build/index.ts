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
import { buildWhereTree, type SchemaContext } from './where';

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
  const node: SelectNode = {
    kind: 'select',
    model: modelKey,
    cardinality,
    where: buildWhereTree(model, a.where, schema),
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
  return {
    kind: 'count',
    model: modelKey,
    where: buildWhereTree(model, a.where, schema),
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
  return {
    kind: 'update',
    model: modelKey,
    where: buildWhereTree(model, args.where, schema) ?? { kind: 'and', children: [] },
    set: frag.set,
    increment: frag.increment,
    multiply: frag.multiply,
    push: frag.push,
    unset: frag.unset,
    many: !!args.many,
    upsertCreate: args.upsertCreate,
    returning: projection,
    hydration: hydration ? materialiseHydration(hydration, schema) : undefined,
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
  return {
    kind: 'delete',
    model: modelKey,
    where: buildWhereTree(model, args.where, schema) ?? { kind: 'and', children: [] },
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
  return {
    kind: 'groupBy',
    model: modelKey,
    by: args.by,
    where: buildWhereTree(model, args.where, schema),
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
