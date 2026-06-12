import type {
  CountNode,
  CursorSpec,
  DeleteNode,
  GroupByNode,
  InsertNode,
  OrderByEntry,
  ProjectionPlan,
  SelectNode,
  UpdateNode,
  WhereTree,
} from '../../ir/types';
import type { MongoArtifact } from '../../compile';
import { schema } from '../../schema';
import type { ModelDef } from '../../schema/types';
import { appKeyToDbKey, coerceFieldValue, getFieldDef } from './coerce';

// Mongo IR consumer — takes adapter-agnostic IR nodes and emits the exact
// args object you'd pass to the mongodb driver. The IR builders carry values
// uncoerced; this file does the final id→ObjectId, date, and key remap (`id`
// → `_id`).

const ESCAPE_REGEX = /[.*+?^${}()|[\]\\]/g;
const escapeRegex = (s: string) => String(s).replace(ESCAPE_REGEX, '\\$&');

function modelDef(modelKey: string, override?: ModelDef<any>): ModelDef<any> {
  if (override) return override;
  const m = (schema as any)[modelKey] as ModelDef<any> | undefined;
  if (!m) throw new Error(`[forge] unknown model '${modelKey}' in IR`);
  return m;
}

function compileWhere(model: ModelDef<any>, tree: WhereTree | undefined): Record<string, any> {
  if (!tree) return {};
  return compileWhereNode(model, tree);
}

function compileWhereNode(model: ModelDef<any>, tree: WhereTree): Record<string, any> {
  switch (tree.kind) {
    case 'and': {
      const parts = tree.children.map((c) => compileWhereNode(model, c)).filter(nonEmpty);
      if (parts.length === 0) return {};
      if (parts.length === 1) return parts[0];
      return { $and: parts };
    }
    case 'or':
      return { $or: tree.children.map((c) => compileWhereNode(model, c)) };
    case 'not':
      return { $nor: [compileWhereNode(model, tree.child)] };
    case 'relation':
      // Relation filters in `where` are not yet supported on Mongo (no $lookup);
      // return {} (match-all) rather than erroring. Tracked as a known gap.
      return {};
    case 'leaf':
      return compileLeaf(model, tree);
  }
}

// Mongo aggregation-expression operator for each field-to-field comparison op.
const EXPR_OPS: Partial<Record<string, string>> = {
  eq: '$eq', ne: '$ne', lt: '$lt', lte: '$lte', gt: '$gt', gte: '$gte',
};

function compileLeaf(
  model: ModelDef<any>,
  leaf: Extract<WhereTree, { kind: 'leaf' }>,
): Record<string, any> {
  const dbKey = appKeyToDbKey(leaf.field);

  // Field-to-field comparison (`col('rhsField')`) → $expr. No value coercion:
  // both operands are column paths, not literals.
  if (leaf.rhsField !== undefined) {
    const exprOp = EXPR_OPS[leaf.op];
    if (!exprOp) {
      throw new Error(`[forge] col() comparison not supported for op '${leaf.op}'`);
    }
    return {
      $expr: { [exprOp]: ['$' + dbKey, '$' + appKeyToDbKey(leaf.rhsField)] },
    };
  }

  const def = getFieldDef(model, leaf.field);
  const coerce = (v: any) => (def ? coerceFieldValue(def, v) : v);
  const out: Record<string, any> = {};
  switch (leaf.op) {
    case 'eq':       out[dbKey] = coerce(leaf.value); return out;
    case 'ne':       out[dbKey] = { $ne: coerce(leaf.value) }; return out;
    case 'in':       out[dbKey] = { $in: (leaf.value as any[]).map(coerce) }; return out;
    case 'nin':      out[dbKey] = { $nin: (leaf.value as any[]).map(coerce) }; return out;
    case 'lt':       out[dbKey] = { $lt: coerce(leaf.value) }; return out;
    case 'lte':      out[dbKey] = { $lte: coerce(leaf.value) }; return out;
    case 'gt':       out[dbKey] = { $gt: coerce(leaf.value) }; return out;
    case 'gte':      out[dbKey] = { $gte: coerce(leaf.value) }; return out;
    case 'contains': out[dbKey] = leaf.caseInsensitive
      ? { $regex: escapeRegex(leaf.value), $options: 'i' }
      : { $regex: escapeRegex(leaf.value) };
      return out;
    case 'startsWith': out[dbKey] = leaf.caseInsensitive
      ? { $regex: '^' + escapeRegex(leaf.value), $options: 'i' }
      : { $regex: '^' + escapeRegex(leaf.value) };
      return out;
    case 'endsWith':   out[dbKey] = leaf.caseInsensitive
      ? { $regex: escapeRegex(leaf.value) + '$', $options: 'i' }
      : { $regex: escapeRegex(leaf.value) + '$' };
      return out;
    case 'has':       out[dbKey] = coerce(leaf.value); return out;
    case 'hasSome':   out[dbKey] = { $in: (leaf.value as any[]).map(coerce) }; return out;
    case 'hasEvery':  out[dbKey] = { $all: (leaf.value as any[]).map(coerce) }; return out;
    case 'isEmpty':   out[dbKey] = leaf.value ? { $size: 0 } : { $not: { $size: 0 } }; return out;
    case 'search': {
      // Mongo's $text is collection-scoped (not field-scoped). We expose it
      // via field-level `{ col: { search: 'q' } }` for API parity with the SQL
      // dialects, but the query fires across every text-indexed field. Requires
      // `collection.createIndex({ col: 'text' })` beforehand.
      out.$text = { $search: String(leaf.value) };
      return out;
    }
    case 'jsonPath':
      return out;
  }
}

function nonEmpty(o: Record<string, any>): boolean {
  return Object.keys(o).length > 0;
}

function compileProjection(plan: ProjectionPlan | undefined): Record<string, 0 | 1> | undefined {
  if (!plan) return undefined;
  // Omit form: { field: 0, ... } excludes; Mongo can mix 0s with `_id: 0` only.
  if (plan.omit?.length && plan.fields.length === 0) {
    const out: Record<string, 0 | 1> = {};
    for (const f of plan.omit) out[appKeyToDbKey(f)] = 0;
    return out;
  }
  // Select form: only listed scalars (+ _id for round-tripping).
  if (plan.exclusive && plan.fields.length) {
    const out: Record<string, 0 | 1> = {};
    for (const f of plan.fields) out[appKeyToDbKey(f)] = 1;
    out._id = 1;
    return out;
  }
  return undefined;
}

function compileOrderBy(orderBy: OrderByEntry[] | undefined): Array<[string, 1 | -1]> | undefined {
  if (!orderBy?.length) return undefined;
  return orderBy.map((e) => [appKeyToDbKey(e.field), e.direction === 'desc' ? -1 : 1]);
}

function compileCursor(model: ModelDef<any>, cursor: CursorSpec | undefined): Record<string, any> | undefined {
  if (!cursor?.fields) return undefined;
  const out: Record<string, any> = {};
  for (const key of Object.keys(cursor.fields)) {
    const def = getFieldDef(model, key);
    const v = def ? coerceFieldValue(def, cursor.fields[key]) : cursor.fields[key];
    out[appKeyToDbKey(key)] = { $gt: v };
  }
  if (Object.keys(out).length === 1) return out;
  return { $and: Object.entries(out).map(([k, v]) => ({ [k]: v })) };
}

export function compileSelect(node: SelectNode, modelOverride?: ModelDef<any>): MongoArtifact {
  const m = modelDef(node.model, modelOverride);
  const filter = compileWhere(m, node.where);
  const cursorFilter = compileCursor(m, node.cursor);
  const combined = cursorFilter
    ? Object.keys(filter).length ? { $and: [filter, cursorFilter] } : cursorFilter
    : filter;
  const projection = compileProjection(node.projection);
  const sort = compileOrderBy(node.orderBy);
  const op = node.cardinality === 'one' ? 'findOne' : 'find';
  return {
    kind: 'mongo',
    collection: m.collection,
    op,
    args: {
      filter: combined,
      options: {
        projection,
        sort,
        limit: node.cardinality === 'many' ? node.limit : undefined,
        skip: node.offset,
      },
    },
    hydration: node.hydration?.map((r) => ({
      relation: r.name, via: r.kind, target: r.target, on: r.on, refs: r.refs,
    })),
  };
}

export function compileCount(node: CountNode, modelOverride?: ModelDef<any>): MongoArtifact {
  const m = modelDef(node.model, modelOverride);
  return {
    kind: 'mongo',
    collection: m.collection,
    op: 'countDocuments',
    args: { filter: compileWhere(m, node.where) },
  };
}

export function compileInsert(node: InsertNode, modelOverride?: ModelDef<any>): MongoArtifact {
  const m = modelDef(node.model, modelOverride);
  // Documents are expected to be pre-coerced (with defaults applied) by the
  // caller — coerceCreatePayload in the wrapper handles this. Compiling
  // defaults here would double-apply and generate duplicate ObjectIds.
  const documents = node.rows;
  if (documents.length === 1) {
    return {
      kind: 'mongo',
      collection: m.collection,
      op: 'insertOne',
      args: { document: documents[0] },
    };
  }
  return {
    kind: 'mongo',
    collection: m.collection,
    op: 'insertMany',
    args: { documents, options: { ordered: !node.skipDuplicates } },
  };
}

export function compileUpdate(node: UpdateNode, modelOverride?: ModelDef<any>): MongoArtifact {
  const m = modelDef(node.model, modelOverride);
  const update: Record<string, any> = {};
  if (node.set && Object.keys(node.set).length) {
    update.$set = remapKeys(m, node.set);
  }
  if (node.increment && Object.keys(node.increment).length) {
    update.$inc = remapKeys(m, node.increment);
  }
  if (node.multiply && Object.keys(node.multiply).length) {
    update.$mul = remapKeys(m, node.multiply);
  }
  if (node.push && Object.keys(node.push).length) {
    update.$push = remapKeys(m, node.push);
  }
  if (node.unset?.length) {
    update.$unset = Object.fromEntries(node.unset.map((k) => [appKeyToDbKey(k), '']));
  }
  if (node.upsertCreate) {
    // upsertCreate is pre-coerced (defaults included) by the wrapper's
    // upsert() before being passed via the IR. Compile uses it verbatim.
    update.$setOnInsert = node.upsertCreate;
  }
  const filter = compileWhere(m, node.where);
  if (node.upsertCreate) {
    return {
      kind: 'mongo',
      collection: m.collection,
      op: 'findOneAndUpdate',
      args: { filter, update, options: { upsert: true, returnDocument: 'after' } },
    };
  }
  if (node.many) {
    return { kind: 'mongo', collection: m.collection, op: 'updateMany', args: { filter, update } };
  }
  return {
    kind: 'mongo',
    collection: m.collection,
    op: 'findOneAndUpdate',
    args: { filter, update, options: { returnDocument: 'after' } },
  };
}

export function compileDelete(node: DeleteNode, modelOverride?: ModelDef<any>): MongoArtifact {
  const m = modelDef(node.model, modelOverride);
  const filter = compileWhere(m, node.where);
  if (node.many) {
    return { kind: 'mongo', collection: m.collection, op: 'deleteMany', args: { filter } };
  }
  return { kind: 'mongo', collection: m.collection, op: 'findOneAndDelete', args: { filter } };
}

function remapKeys(_m: ModelDef<any>, obj: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of Object.keys(obj)) out[appKeyToDbKey(k)] = obj[k];
  return out;
}

// Same logical op as the PG compiler: pre-filter $match, aggregate $group,
// post-filter $match on aggregate aliases (having), sort/limit/skip. The
// wrapper reshapes the result into Prisma's nested `{ <by-cols>, _count, ... }`.
export function compileGroupBy(node: GroupByNode, modelOverride?: ModelDef<any>): MongoArtifact {
  const m = modelDef(node.model, modelOverride);
  const pipeline: any[] = [];

  if (node.where) {
    const f = compileWhere(m, node.where);
    if (Object.keys(f).length) pipeline.push({ $match: f });
  }

  const groupId: Record<string, any> = {};
  for (const f of node.by) groupId[f] = `$${appKeyToDbKey(f)}`;
  const groupStage: Record<string, any> = { _id: groupId };

  // Flat aliases ($sum/$avg/$min/$max). _count._all → $sum: 1.
  const addAgg =(bucket: '_count' | '_avg' | '_sum' | '_min' | '_max', field: string, mongoOp: string) => {
    const alias = `__agg_${bucket.slice(1)}_${field}`;
    if (field === '_all') groupStage[alias] = { $sum: 1 };
    else groupStage[alias] = { [mongoOp]: `$${appKeyToDbKey(field)}` };
  };
  if (node._count) for (const [k, v] of Object.entries(node._count)) if (v) addAgg('_count', k, '$sum');
  if (node._avg)   for (const [k, v] of Object.entries(node._avg))   if (v) addAgg('_avg',   k, '$avg');
  if (node._sum)   for (const [k, v] of Object.entries(node._sum))   if (v) addAgg('_sum',   k, '$sum');
  if (node._min)   for (const [k, v] of Object.entries(node._min))   if (v) addAgg('_min',   k, '$min');
  if (node._max)   for (const [k, v] of Object.entries(node._max))   if (v) addAgg('_max',   k, '$max');

  pipeline.push({ $group: groupStage });

  if (node.having && typeof node.having === 'object') {
    const havingMatch: Record<string, any> = {};
    for (const [bucket, inner] of Object.entries(node.having)) {
      if (!inner || typeof inner !== 'object') continue;
      for (const [field, opObj] of Object.entries(inner as any)) {
        if (!opObj || typeof opObj !== 'object') continue;
        const alias = `__agg_${bucket.replace(/^_/, '')}_${field}`;
        const cmp: Record<string, any> = {};
        for (const [op, val] of Object.entries(opObj as Record<string, any>)) {
          const mongoOp = (({ gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte', equals: '$eq', not: '$ne' }) as Record<string, string>)[op];
          if (mongoOp) cmp[mongoOp] = val;
        }
        if (Object.keys(cmp).length) havingMatch[alias] = cmp;
      }
    }
    if (Object.keys(havingMatch).length) pipeline.push({ $match: havingMatch });
  }

  if (node.orderBy?.length) {
    const sort: Record<string, 1 | -1> = {};
    for (const e of node.orderBy) {
      // Group columns live under _id.<col>; everything else is an alias.
      const path = node.by.includes(e.field) ? `_id.${e.field}` : appKeyToDbKey(e.field);
      sort[path] = e.direction === 'desc' ? -1 : 1;
    }
    pipeline.push({ $sort: sort });
  }
  if (node.offset != null) pipeline.push({ $skip: node.offset });
  if (node.limit  != null) pipeline.push({ $limit: node.limit });

  return {
    kind: 'mongo',
    collection: m.collection,
    op: 'aggregate',
    args: { pipeline },
  };
}
