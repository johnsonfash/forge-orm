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
import { toGeoJson } from '../shared/wkt';

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
      // Mongo has no join in a plain find, so a relation filter cannot be
      // compiled here. Until 2.18.0 this returned {} — match-all — which is
      // the most dangerous answer available: the same compiler builds the
      // filter for reads AND for writes, so
      //
      //   deleteMany({ where: { author: { is: { email: 'x' } } } })
      //
      // compiled to `deleteMany({})` and emptied the collection. A read just
      // returned every row instead of the matching ones, with no error.
      throw new Error(
        `[forge:mongo] a relation filter on '${tree.relation}' (${tree.mode}) cannot be ` +
        'compiled for Mongo — a find has no join. Resolve it in two steps:\n' +
        "  const ids = (await db.author.findMany({ where: { email: 'x' }, " +
        'select: { id: true } })).map(a => a.id);\n' +
        '  await db.post.findMany({ where: { author_id: { in: ids } } });\n' +
        'Or use db.<model>.aggregate([{ $lookup: … }]) for a single round trip.',
      );
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
    case 'jsonPath': {
      // For Mongo, jsonPath is just dot-notation against the column. The IR
      // already separates path + subOp; emit the dotted key with the matching
      // Mongo operator.
      if (!leaf.jsonPath) return out;
      const dotted = [dbKey, ...leaf.jsonPath.path].join('.');
      const op = leaf.jsonPath.subOp;
      const v = leaf.value;
      if (op === 'eq') out[dotted] = v;
      else if (op === 'ne')  out[dotted] = { $ne:  v };
      else if (op === 'lt')  out[dotted] = { $lt:  v };
      else if (op === 'lte') out[dotted] = { $lte: v };
      else if (op === 'gt')  out[dotted] = { $gt:  v };
      else if (op === 'gte') out[dotted] = { $gte: v };
      else if (op === 'in')  out[dotted] = { $in: v as unknown[] };
      else if (op === 'contains') out[dotted] = { $regex: escapeRegex(String(v)) };
      else if (op === 'has') out[dotted] = v;   // array element equality
      return out;
    }
    case 'near': {
      const point = leaf.value as { lng: number; lat: number; withinMeters?: number };
      // Mongo's $near requires a 2dsphere index on the field; the schema
      // declares it via `indexes: [{ keys: { col: 1 }, method: 'spatial' }]`
      // which forge translates to 2dsphere at push.
      const nearQuery: Record<string, any> = {
        $geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
      };
      if (point.withinMeters !== undefined) {
        nearQuery.$maxDistance = point.withinMeters;
      }
      out[dbKey] = { $near: nearQuery };
      return out;
    }
    case 'withinPolygon': {
      // IR-normalised: { multiPolygon: Polygon[] }. Legacy { polygon } also
      // accepted for forward-compat with hand-built IR nodes.
      const v = leaf.value as { multiPolygon?: Array<Array<Array<{ lng: number; lat: number }>>>; polygon?: Array<{ lng: number; lat: number }> };
      const multiPolygon = v.multiPolygon ?? (v.polygon ? [[v.polygon]] : []);
      out[dbKey] = {
        $geoWithin: {
          $geometry: toGeoJson(multiPolygon),
        },
      };
      return out;
    }
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

// Two defects lived here before 2.18.0, and both returned a wrong page
// rather than an error:
//
//   1. `$gt` regardless of sort direction — so `orderBy: { createdAt: 'desc' }`
//      paged backwards into rows it had already served.
//   2. A composite cursor became `{ $and: [ {a: {$gt: x}}, {b: {$gt: y}} ] }`,
//      which is not a tuple comparison. Given rows sorted by (a, b), the row
//      after (5, 9) is (5, 10) — but that row has b=10 > 9 AND a=5, which is
//      NOT > 5, so the $and rejected it. Every row sharing the cursor's
//      leading value was skipped.
function compileCursor(
  model: ModelDef<any>,
  cursor: CursorSpec | undefined,
  orderBy: OrderByEntry[] | undefined,
): Record<string, any> | undefined {
  if (!cursor?.fields) return undefined;
  const keys = Object.keys(cursor.fields);
  if (keys.length === 0) return undefined;

  const op = (k: string) =>
    orderBy?.find((e) => e.field === k)?.direction === 'desc' ? '$lt' : '$gt';
  const val = (k: string) => {
    const def = getFieldDef(model, k);
    return def ? coerceFieldValue(def, cursor.fields[k], { model: model.collection, name: k }) : cursor.fields[k];
  };
  const key = (k: string) => appKeyToDbKey(k);

  if (keys.length === 1) {
    return { [key(keys[0])]: { [op(keys[0])]: val(keys[0]) } };
  }

  // Lexicographic expansion — the same shape the SQL side uses, and correct
  // for mixed sort directions as well as uniform ones.
  const terms = keys.map((k, i) => {
    const clauses: Record<string, any>[] = keys
      .slice(0, i)
      .map((prev) => ({ [key(prev)]: val(prev) }));
    clauses.push({ [key(k)]: { [op(k)]: val(k) } });
    return clauses.length === 1 ? clauses[0] : { $and: clauses };
  });
  return { $or: terms };
}

export function compileSelect(node: SelectNode, modelOverride?: ModelDef<any>): MongoArtifact {
  const m = modelDef(node.model, modelOverride);
  const filter = compileWhere(m, node.where);
  const cursorFilter = compileCursor(m, node.cursor, node.orderBy);
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

// Mongo has no `$div` update operator, so an exact division cannot be
// expressed as an update document at all. Before 2.18.0 the IR quietly
// rewrote `divide: 3` into `$mul: 0.3333333333333333`, which drifts on a
// money column and turns an int field into a double. An aggregation-pipeline
// update (Mongo 4.2+) has a real `$divide`, so that is what a divide compiles
// to — every other op is translated into the equivalent pipeline expression
// so the whole update stays one atomic statement.
//
// Literals go through `$literal`: inside a pipeline a bare string beginning
// with `$` is a field reference, so `{ $set: { note: '$5 off' } }` would
// store the value of a field named `5 off` instead of the text.
function compileUpdateAsPipeline(
  m: ModelDef<any>,
  node: UpdateNode,
): Record<string, any>[] {
  const setStage: Record<string, any> = {};
  const ref = (k: string) => `$${appKeyToDbKey(k)}`;

  for (const [k, v] of Object.entries(remapAndCoerce(m, node.set ?? {}))) {
    setStage[k] = { $literal: v };
  }
  for (const [k, v] of Object.entries(node.increment ?? {})) {
    setStage[appKeyToDbKey(k)] = { $add: [{ $ifNull: [ref(k), 0] }, v] };
  }
  for (const [k, v] of Object.entries(node.multiply ?? {})) {
    setStage[appKeyToDbKey(k)] = { $multiply: [{ $ifNull: [ref(k), 0] }, v] };
  }
  for (const [k, v] of Object.entries(node.divide ?? {})) {
    setStage[appKeyToDbKey(k)] = { $divide: [{ $ifNull: [ref(k), 0] }, v] };
  }
  for (const [k, v] of Object.entries(node.max ?? {})) {
    setStage[appKeyToDbKey(k)] = { $max: [{ $ifNull: [ref(k), v] }, v] };
  }
  for (const [k, v] of Object.entries(node.min ?? {})) {
    setStage[appKeyToDbKey(k)] = { $min: [{ $ifNull: [ref(k), v] }, v] };
  }
  for (const [k, v] of Object.entries(node.push ?? {})) {
    setStage[appKeyToDbKey(k)] = {
      $concatArrays: [{ $ifNull: [ref(k), []] }, Array.isArray(v) ? v : [v]],
    };
  }
  for (const [k, v] of Object.entries(node.addToSet ?? {})) {
    setStage[appKeyToDbKey(k)] = {
      $setUnion: [{ $ifNull: [ref(k), []] }, Array.isArray(v) ? v : [v]],
    };
  }
  for (const [k, v] of Object.entries(node.pull ?? {})) {
    setStage[appKeyToDbKey(k)] = {
      $filter: {
        input: { $ifNull: [ref(k), []] },
        cond: { $ne: ['$$this', v] },
      },
    };
  }

  const stages: Record<string, any>[] = [];
  if (Object.keys(setStage).length) stages.push({ $set: setStage });
  if (node.unset?.length) stages.push({ $unset: node.unset.map(appKeyToDbKey) });
  return stages;
}

export function compileUpdate(node: UpdateNode, modelOverride?: ModelDef<any>): MongoArtifact {
  const m = modelDef(node.model, modelOverride);
  const dividing = !!node.divide && Object.keys(node.divide).length > 0;
  if (dividing) {
    if (node.upsertCreate) {
      // A pipeline update has no insert-only branch ($setOnInsert is an
      // update-document operator), so "divide on conflict, seed on insert"
      // cannot be one statement. Say so instead of silently dropping one half.
      throw new Error(
        '[forge:mongo] upsert cannot combine `create` with a `divide` update. ' +
        'Mongo needs an aggregation-pipeline update for an exact divide, and a ' +
        'pipeline has no $setOnInsert. Split it: upsert the row first, then ' +
        'update with the divide.',
      );
    }
    const pipeline = compileUpdateAsPipeline(m, node);
    const filter = compileWhere(m, node.where);
    return node.many
      ? { kind: 'mongo', collection: m.collection, op: 'updateMany', args: { filter, update: pipeline } }
      : {
          kind: 'mongo',
          collection: m.collection,
          op: 'findOneAndUpdate',
          args: { filter, update: pipeline, options: { returnDocument: 'after' } },
        };
  }
  const update: Record<string, any> = {};
  if (node.set && Object.keys(node.set).length) {
    update.$set = remapAndCoerce(m, node.set);
  }
  if (node.increment && Object.keys(node.increment).length) {
    update.$inc = remapKeys(m, node.increment);
  }
  if (node.multiply && Object.keys(node.multiply).length) {
    update.$mul = remapKeys(m, node.multiply);
  }
  if (node.max && Object.keys(node.max).length) {
    update.$max = remapKeys(m, node.max);
  }
  if (node.min && Object.keys(node.min).length) {
    update.$min = remapKeys(m, node.min);
  }
  if (node.push && Object.keys(node.push).length) {
    // Coerced too: pushing an id string onto an array of objectId would
    // otherwise store a String next to ObjectIds in the same array.
    update.$push = remapAndCoerce(m, node.push);
  }
  if (node.addToSet && Object.keys(node.addToSet).length) {
    update.$addToSet = remapAndCoerce(m, node.addToSet);
  }
  if (node.pull && Object.keys(node.pull).length) {
    update.$pull = remapAndCoerce(m, node.pull);
  }
  if (node.unset?.length) {
    update.$unset = Object.fromEntries(node.unset.map((k) => [appKeyToDbKey(k), '']));
  }
  if (node.upsertCreate) {
    // upsertCreate is pre-coerced (defaults included) by the wrapper's
    // upsert() before being passed via the IR.
    //
    // Mongo rejects the same path appearing in $setOnInsert and another update
    // operator ("Updating the path 'x' would create a conflict at 'x'"), and it
    // treats a path that prefixes another (`a` vs `a.b`) as a conflict too. Any
    // field the update already writes is therefore dropped from $setOnInsert —
    // on insert the update operator ($set/$inc/$mul/$push/$unset) sets it anyway,
    // so create/update overlap (e.g. `create:{ seq:1 }, update:{ seq:{increment:1} }`)
    // and "set the same fields whether inserting or updating" both just work.
    const writtenPaths = [
      ...Object.keys(update.$set || {}),
      ...Object.keys(update.$inc || {}),
      ...Object.keys(update.$mul || {}),
      ...Object.keys(update.$max || {}),
      ...Object.keys(update.$min || {}),
      ...Object.keys(update.$push || {}),
      ...Object.keys(update.$addToSet || {}),
      ...Object.keys(update.$pull || {}),
      ...Object.keys(update.$unset || {}),
    ];
    const conflicts = (a: string, b: string): boolean =>
      a === b || a.startsWith(b + '.') || b.startsWith(a + '.');
    const setOnInsert: Record<string, any> = {};
    for (const [k, v] of Object.entries(node.upsertCreate)) {
      if (!writtenPaths.some((w) => conflicts(k, w))) setOnInsert[k] = v;
    }
    if (Object.keys(setOnInsert).length) update.$setOnInsert = setOnInsert;
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

/**
 * Rename keys AND coerce values to their BSON types.
 *
 * `remapKeys` alone was what the update path used before 2.18.0, and it
 * renamed without coercing. Create coerced (via coerceCreatePayload) and
 * `where` coerced (via compileLeaf) — only update did not. So the same field
 * written two ways ended up with two different BSON types in the same
 * collection:
 *
 *   create({ data: { location_id: '652f…' } })   → ObjectId('652f…')
 *   update({ data: { location_id: '652f…' } })   → "652f…"   (a String!)
 *
 * and because `where` DOES coerce, `findMany({ where: { location_id: id } })`
 * searched for the ObjectId and silently never matched the string rows. The
 * damage is permanent and invisible until something counts the rows — it needs
 * a repair script to undo, which is how this was found.
 *
 * The same applied to dates: an ISO string handed to `update` stayed a string,
 * so range queries on it stopped working.
 */
function remapAndCoerce(m: ModelDef<any>, obj: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of Object.keys(obj)) {
    const def = getFieldDef(m, k);
    out[appKeyToDbKey(k)] = def ? coerceFieldValue(def, obj[k], { model: m.collection, name: k }) : obj[k];
  }
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
      // An aggregate order targets the $group output alias directly.
      const path = e.agg
        ? `__agg_${e.agg.bucket.slice(1)}_${e.agg.field}`
        : node.by.includes(e.field) ? `_id.${e.field}` : appKeyToDbKey(e.field);
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
