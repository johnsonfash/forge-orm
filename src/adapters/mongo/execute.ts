import type { ClientSession, Db, Document } from 'mongodb';
import { getDefaultClient } from './client';
import type {
  CountNode,
  DeleteNode,
  GroupByNode,
  InsertNode,
  RelationPlan,
  SelectNode,
  UpdateNode,
  WhereTree,
} from '../../ir/types';
import type { ModelDef } from '../../schema/types';
import { schema } from '../../schema';
import { appKeyToDbKey, coerceFieldValue, decodeRow, getFieldDef } from './coerce';
import {
  compileCount,
  compileDelete,
  compileGroupBy,
  compileInsert,
  compileSelect,
  compileUpdate,
  compileMatchStages,
  compileSelectPipeline,
  hasRelationFilter,
} from './compile-from-ir';
import { notFoundError, rethrowMongoError } from './errors';
import type { ObjectId } from 'mongodb';
import { mongo } from './bson';
import { hydrateManyRelation, hydrateOneRelation, type WindowedPaging } from '../../ir/hydrate-many';
import { softDeleteField } from '../../ir/build/soft-delete';

interface ExecOpts {
  session?: ClientSession;
  db?: Db;
  /**
   * Set on the loads an include makes. They are always read to the end, so
   * the driver's default first batch of 101 documents only adds a getMore
   * round trip to any level with more children than that.
   */
  wholeResult?: boolean;
}

const WHOLE_RESULT_BATCH = 100_000;

/**
 * The `Db` this call runs against.
 *
 * It comes from the adapter that owns the connection. The fallback exists for
 * the CLI scripts, which call the executors without an adapter — it is NOT a
 * convenience for the library path, which always passes `db`, because reaching
 * for a process-wide default is exactly how two databases ended up sharing one
 * connection.
 */
function mongoDb(opts: ExecOpts | undefined): Db {
  return (opts?.db as Db | undefined) ?? getDefaultClient().db;
}

export async function executeSelect(
  node: SelectNode,
  model: ModelDef<any>,
  opts: ExecOpts = {},
): Promise<any[]> {
  if (hasRelationFilter(node.where)) {
    node = { ...node, where: await resolveRelationFilters(model, node.where!, opts) };
  }

  // Geo / vector bridge — `orderBy: { col: { nearTo } }` routes through an
  // aggregation pipeline:
  //   • geoPoint → $geoNear (sphere distances, `_distanceMeters`)
  //   • vector   → $vectorSearch (Atlas only, `_distance`)
  const nearToEntry = node.orderBy?.find((e) => e.nearTo);
  if (nearToEntry) {
    const fld = (model.fields as any)?.[nearToEntry.field];
    if (fld?.kind === 'vector') {
      return executeSelectWithVectorSearch(node, model, nearToEntry, opts);
    }
    return executeSelectWithGeoNear(node, model, nearToEntry, opts);
  }

  if (distinctValuesOnly(node, model)) return executeDistinctValues(node, model, opts);

  if (hasRelationFilter(node.where) || node.distinct?.length || (node.partitionBy && (node.limit != null || node.offset != null))) {
    return executeSelectAsPipeline(node, model, opts);
  }

  const artifact = compileSelect(node, model);
  const coll = mongoDb(opts).collection(artifact.collection);
  const filter = artifact.args.filter ?? {};
  const options = artifact.args.options ?? {};

  // Mongo's findOne ignores `limit`; force a 1-row query through find() so
  // the cardinality-one path stays inside the unified pipeline.
  let rows: Document[];
  if (artifact.op === 'findOne') {
    let cursor = coll.find(filter, opts.session ? { session: opts.session } : undefined);
    if (options.projection) cursor = cursor.project(options.projection);
    if (options.sort) cursor = cursor.sort(options.sort);
    if (options.skip) cursor = cursor.skip(options.skip);
    cursor = cursor.limit(1);
    rows = await cursor.toArray();
  } else {
    let cursor = coll.find(filter, opts.session ? { session: opts.session } : undefined);
    if (options.projection) cursor = cursor.project(options.projection);
    if (options.sort) cursor = cursor.sort(options.sort);
    if (options.skip) cursor = cursor.skip(options.skip);
    if (options.limit) cursor = cursor.limit(options.limit);
    if (opts.wholeResult) cursor = cursor.batchSize(WHOLE_RESULT_BATCH);
    rows = await cursor.toArray();
  }

  let out: any[] = rows.map((r) => decodeRow(model, r));

  if (node.distinct?.length) {
    out = dedupeBy(out, node.distinct);
  }

  await applyProjectionAndHydration(out, model, node, opts);
  return out;
}

// `distinct: [f]` selecting only `f`: the server's own distinct command, which
// returns just the values. Held to one required scalar of a kind whose values
// never spread (an array field would be flattened into its elements) and to
// no paging, which the command cannot do.
const DISTINCT_VALUE_KINDS = new Set(['id', 'objectId', 'string', 'text', 'int', 'float', 'enum', 'bool', 'dateTime', 'uuid']);
function distinctValuesOnly(node: SelectNode, model: ModelDef<any>): boolean {
  if (node.distinct?.length !== 1 || node.limit != null || node.offset != null || node.cursor) return false;
  if (node.hydration?.length || node.projection?.counts?.length || node.partitionBy || hasRelationFilter(node.where)) return false;
  const f = node.distinct[0];
  const p = node.projection;
  if (!p?.exclusive || p.fields.length !== 1 || p.fields[0] !== f) return false;
  if (node.orderBy?.some((e) => e.field !== f || e.nearTo || e.agg)) return false;
  const fd = (model.fields as any)[f];
  return !!fd && !fd.optional && DISTINCT_VALUE_KINDS.has(fd.kind);
}

function compareValues(a: any, b: any): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const x = String(a), y = String(b);
  // Code points, which is the order Mongo's binary string comparison gives.
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    const cx = x.codePointAt(i)!, cy = y.codePointAt(j)!;
    if (cx !== cy) return cx - cy;
    i += cx > 0xffff ? 2 : 1; j += cy > 0xffff ? 2 : 1;
  }
  return (x.length - i) - (y.length - j);
}

async function executeDistinctValues(node: SelectNode, model: ModelDef<any>, opts: ExecOpts): Promise<any[]> {
  const f = node.distinct![0];
  const key = appKeyToDbKey(f);
  const artifact = compileSelect({ ...node, distinct: undefined, orderBy: undefined }, model);
  const values = await mongoDb(opts).collection(artifact.collection)
    .distinct(key, artifact.args.filter ?? {}, opts.session ? { session: opts.session } : {});
  const dir = node.orderBy?.[0]?.direction === 'desc' ? -1 : 1;
  if (node.orderBy?.length) values.sort((a: any, b: any) => dir * compareValues(a, b));
  return values.map((v: any) => decodeRow(model, { [key]: v }));
}

/**
 * The targets of a cascading delete plus, per child relation, whether any
 * child exists: one aggregation with a `$limit: 1` lookup per relation, so the
 * walker does not send a write (or open a transaction) for relations that
 * hold nothing.
 */
export async function executeSelectWithChildPresence(
  node: SelectNode,
  model: ModelDef<any>,
  probes: Array<{ collection: string; on: string; refs: string; scope?: string }>,
  opts: ExecOpts = {},
): Promise<{ rows: any[]; present: boolean[] }> {
  if (hasRelationFilter(node.where)) {
    node = { ...node, where: await resolveRelationFilters(model, node.where!, opts) };
  }
  const pipeline = compileSelectPipeline(node, model);
  const flags = probes.map((_, i) => `__forge_has_${i}`);
  probes.forEach((p, i) => {
    const match: Record<string, any> = { $expr: { $eq: [`$${appKeyToDbKey(p.on)}`, '$$k'] } };
    if (p.scope) match[appKeyToDbKey(p.scope)] = null;
    pipeline.push({
      $lookup: {
        from: p.collection,
        let: { k: `$${appKeyToDbKey(p.refs)}` },
        pipeline: [{ $match: match }, { $limit: 1 }, { $project: { _id: 1 } }],
        as: flags[i],
      },
    });
  });
  const docs = await mongoDb(opts).collection(model.collection)
    .aggregate(pipeline, { ...(opts.session ? { session: opts.session } : {}), batchSize: WHOLE_RESULT_BATCH })
    .toArray();
  const present = probes.map(() => false);
  for (const d of docs) {
    flags.forEach((f, i) => { if ((d[f] as unknown[] | undefined)?.length) present[i] = true; delete d[f]; });
  }
  return { rows: docs.map((r) => decodeRow(model, r)), present };
}

// Relation filters ($lookup) and per-parent pages ($setWindowFields) — the
// two selects a find cannot express — as one aggregation.
async function executeSelectAsPipeline(
  node: SelectNode,
  model: ModelDef<any>,
  opts: ExecOpts,
): Promise<any[]> {
  const pipeline = compileSelectPipeline(node, model);
  const docs = await mongoDb(opts)
    .collection(model.collection)
    .aggregate(pipeline, {
      ...(opts.session ? { session: opts.session } : {}),
      ...(opts.wholeResult || node.distinct?.length ? { batchSize: WHOLE_RESULT_BATCH } : {}),
      ...(node.distinct?.length ? { allowDiskUse: true } : {}),
    })
    .toArray();
  let out: any[] = docs.map((r) => decodeRow(model, r));
  if (node.distinct?.length) out = dedupeBy(out, node.distinct);
  await applyProjectionAndHydration(out, model, node, opts);
  return out;
}

// Above this many distinct parent keys a relation filter is left for $lookup
// rather than inlined as an $in list.
const RELATION_KEYS_INLINE_MAX = 10_000;

/**
 * Turn each relation filter into a plain `$in` / `$nin` on the parent's join
 * key, by asking the child collection which keys qualify — one grouped
 * aggregation per filter, the semi-join a SQL planner would make of the
 * EXISTS:
 *
 *   some / is     parent key IN  { child keys matching the filter }
 *   none / isNot  parent key NIN { child keys matching the filter }
 *   every         parent key NIN { child keys FAILING the filter }
 *
 * `$nin` keeps a parent whose key is null, as NOT EXISTS does. This beats a
 * $lookup per parent whenever matches are sparse: `none` over a thousand users
 * otherwise joins nearly all of them to fill one page. A key set too large to
 * inline is left as a relation filter, which the pipeline path then answers
 * with $lookup, so the result never depends on which way it went.
 */
async function resolveRelationFilters(model: ModelDef<any>, tree: WhereTree, opts: ExecOpts, restrict?: unknown[]): Promise<WhereTree> {
  switch (tree.kind) {
    case 'and': {
      // A `none` / `every` / `isNot` filter is answered by the keys it EXCLUDES,
      // which without a bound means grouping the whole child collection. When
      // the rest of the AND narrows the parents to a few keys, those keys bound
      // the child lookup instead (raw Mongo code does the same by hand).
      const neg = (c: WhereTree) => c.kind === 'relation' && (c.mode === 'none' || c.mode === 'every' || c.mode === 'isNot');
      const rest = await Promise.all(tree.children.filter((c) => !neg(c)).map((c) => resolveRelationFilters(model, c, opts)));
      const negs = tree.children.filter(neg) as Extract<WhereTree, { kind: 'relation' }>[];
      if (negs.length === 0) return { kind: 'and', children: rest };
      const bound = rest.length ? await parentKeys(model, { kind: 'and', children: rest }, negs, opts) : null;
      const resolved = await Promise.all(negs.map((c) => {
        const rel = model.relations()[c.relation];
        const field = rel && model.fields[rel.on] != null ? rel.on : rel?.refs;
        return resolveRelationFilters(model, c, opts, field && bound ? bound.get(field) : undefined);
      }));
      return { kind: 'and', children: [...rest, ...resolved] };
    }
    case 'or':
      return { kind: tree.kind, children: await Promise.all(tree.children.map((c) => resolveRelationFilters(model, c, opts))) };
    case 'not':
      return { kind: 'not', child: await resolveRelationFilters(model, tree.child, opts) };
    case 'leaf':
      return tree;
    case 'relation':
      break;
  }
  const rel = model.relations()[tree.relation];
  const target = rel ? ((schema as any)[rel.target] as ModelDef<any> | undefined) : undefined;
  if (!rel || !target) return tree;
  const owning = model.fields[rel.on] != null;
  const parentField = owning ? rel.on : rel.refs;
  const childKey = appKeyToDbKey(owning ? rel.refs : rel.on);

  const nested = tree.nested ? await resolveRelationFilters(target, tree.nested, opts) : null;
  const negate = tree.mode === 'every' && nested != null;
  const parts: WhereTree[] = [];
  const sd = tree.withDeleted ? undefined : softDeleteField(target);
  if (sd) parts.push({ kind: 'leaf', field: sd, op: 'eq', value: null });
  if (nested) parts.push(negate ? { kind: 'not', child: nested } : nested);
  const keyMatch = restrict ? { $ne: null, $in: restrict } : { $ne: null };
  const { stages } = compileMatchStages(target, { kind: 'and', children: parts }, { [childKey]: keyMatch });
  const keys = await mongoDb(opts)
    .collection(target.collection)
    .aggregate(
      [...stages, { $group: { _id: `$${childKey}` } }, { $limit: RELATION_KEYS_INLINE_MAX + 1 }],
      { ...(opts.session ? { session: opts.session } : {}), batchSize: RELATION_KEYS_INLINE_MAX + 1 },
    )
    .toArray();
  if (keys.length > RELATION_KEYS_INLINE_MAX) return { ...tree, nested };
  const found = tree.mode === 'some' || tree.mode === 'is' || (tree.mode === 'every' && !negate);
  return { kind: 'leaf', field: parentField, op: found ? 'in' : 'nin', value: keys.map((k) => k._id) };
}

// The values of the parent fields the negative relation filters join on, over
// the parents the rest of an AND already selects: null when that is too many
// to inline (or the rest still holds a relation filter).
async function parentKeys(
  model: ModelDef<any>, rest: WhereTree, negs: Extract<WhereTree, { kind: 'relation' }>[], opts: ExecOpts,
): Promise<Map<string, unknown[]> | null> {
  if (hasRelationFilter(rest)) return null;
  const fields = new Set<string>();
  for (const c of negs) {
    const rel = model.relations()[c.relation];
    if (rel) fields.add(model.fields[rel.on] != null ? rel.on : rel.refs);
  }
  if (!fields.size) return null;
  const { stages } = compileMatchStages(model, rest);
  const project: Record<string, 1> = {};
  for (const f of fields) project[appKeyToDbKey(f)] = 1;
  const docs = await mongoDb(opts).collection(model.collection)
    .aggregate([...stages, { $project: project }, { $limit: RELATION_KEYS_INLINE_MAX + 1 }],
      { ...(opts.session ? { session: opts.session } : {}), batchSize: RELATION_KEYS_INLINE_MAX + 1 })
    .toArray();
  if (docs.length > RELATION_KEYS_INLINE_MAX) return null;
  const out = new Map<string, unknown[]>();
  for (const f of fields) {
    const k = appKeyToDbKey(f);
    out.set(f, [...new Set(docs.map((d) => d[k]).filter((v) => v != null))]);
  }
  return out;
}

// $setWindowFields arrived in MongoDB 5.0. An older server rejects the stage
// by name; the first such error sends that database's nested pages back to a
// query per parent.
const windowedByDb = new WeakMap<object, WindowedPaging>();
function windowedFor(db: Db): WindowedPaging {
  let w = windowedByDb.get(db);
  if (!w) {
    w = {
      enabled: true,
      unsupported: (err) => {
        const e = err as { code?: number; message?: string } | null;
        return !!e && (e.code === 40324 || /setWindowFields/.test(e.message ?? ''));
      },
    };
    windowedByDb.set(db, w);
  }
  return w;
}

/**
 * `orderBy: { col: { nearTo } }` is implemented via the $geoNear aggregation
 * stage (which MUST be the first stage). $geoNear emits a per-doc distance
 * field — we ask for `_distanceMeters` so the rows shape matches what the
 * SQL adapters produce.
 *
 * Filter handling:
 *   • If a `near` filter targets the SAME field as nearTo, $maxDistance is
 *     lifted onto the $geoNear stage and the original filter dropped.
 *   • If a `near` filter targets a DIFFERENT field (cross-field), it's
 *     converted to the equivalent `$geoWithin: { $centerSphere: [[lng, lat],
 *     radians] }` form (which IS valid in a $geoNear.query / $match stage,
 *     unlike $near). This lets the same query run both filter and orderBy
 *     against two different geoPoint columns — fixing the limitation noted
 *     in the 2.3 release notes ("Mongo nearTo cross-field" → 2.5.0).
 *   • Any other where clauses go into the $geoNear.query (Mongo accepts an
 *     embedded find-style filter there) so the executor stays single-stage.
 */
async function executeSelectWithGeoNear(
  node: SelectNode,
  model: ModelDef<any>,
  nearToEntry: NonNullable<SelectNode['orderBy']>[number],
  opts: ExecOpts,
): Promise<any[]> {
  const artifact = compileSelect(node, model);
  const coll = mongoDb(opts).collection(artifact.collection);
  const sessOpt = opts.session ? { session: opts.session } : undefined;

  // Walk the artifact filter once. Same-field $near collapses into the
  // stage's maxDistance; cross-field $near gets rewritten to $geoWithin so
  // it survives the $match-style query slot on $geoNear.
  const filter = rewriteNearForGeoNear(artifact.args.filter ?? {}, nearToEntry.field);
  const dbField = nearToEntry.field;
  let maxDistance: number | undefined;
  // Same-field collapse — `near` on the same column as the nearTo orderBy
  // is fully absorbed by the stage's maxDistance.
  if (filter.__sameFieldMaxDistance != null) {
    maxDistance = filter.__sameFieldMaxDistance;
    delete filter.__sameFieldMaxDistance;
  }
  const point = nearToEntry.nearTo as { lng: number; lat: number };
  const geoNearStage: any = {
    $geoNear: {
      near: { type: 'Point', coordinates: [point.lng, point.lat] },
      distanceField: '_distanceMeters',
      spherical: true,
      key: dbField,
    },
  };
  if (maxDistance !== undefined) geoNearStage.$geoNear.maxDistance = maxDistance;
  if (Object.keys(filter).length > 0) geoNearStage.$geoNear.query = filter;

  const options = artifact.args.options ?? {};
  const pipeline: any[] = [geoNearStage];
  if (options.skip) pipeline.push({ $skip: options.skip });
  if (options.limit) pipeline.push({ $limit: options.limit });
  if (options.projection) pipeline.push({ $project: options.projection });

  const docs = await coll.aggregate(pipeline, sessOpt).toArray();
  const ascending = nearToEntry.direction !== 'desc';
  if (!ascending) docs.reverse(); // $geoNear returns ascending; flip for desc

  let out = docs.map((r) => decodeRow(model, r));
  if (node.distinct?.length) out = dedupeBy(out, node.distinct);
  await applyProjectionAndHydration(out, model, node, opts);
  return out;
}

// Earth radius in meters — used to convert $maxDistance (meters) to the
// radian form $centerSphere expects.
const EARTH_RADIUS_METERS = 6_371_008.8;

/**
 * Rewrite `{ field: { $near: { $geometry, $maxDistance } } }` leaves in a
 * Mongo find-style filter so they survive a $geoNear stage:
 *   • Same field as the nearTo orderBy: collapse to a sentinel
 *     `__sameFieldMaxDistance` (caller lifts it onto $geoNear.maxDistance).
 *   • Different field (cross-field): rewrite to
 *     `{ field: { $geoWithin: { $centerSphere: [[lng, lat], r] } } }` —
 *     $near is illegal inside a $geoNear.query / $match, but $centerSphere
 *     is fine. Equivalent semantics (distance ≤ N meters).
 *
 * Other operators on the same field are preserved by mutating a shallow
 * clone of the inner object. Top-level $and / $or trees are walked
 * recursively.
 */
function rewriteNearForGeoNear(filter: Record<string, any>, nearToField: string): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$and' || k === '$or') {
      out[k] = (v as Record<string, any>[]).map((sub) => rewriteNearForGeoNear(sub, nearToField));
      continue;
    }
    if (k === '$nor') {
      out[k] = (v as Record<string, any>[]).map((sub) => rewriteNearForGeoNear(sub, nearToField));
      continue;
    }
    if (v && typeof v === 'object' && '$near' in v) {
      const n = (v as { $near: { $geometry?: { coordinates?: [number, number] }; $maxDistance?: number } }).$near;
      if (k === nearToField) {
        // Same field — collapse into maxDistance on the stage.
        if (typeof n.$maxDistance === 'number') {
          out.__sameFieldMaxDistance = n.$maxDistance;
        }
        // Drop the $near from this field; keep other ops if any.
        const rest: Record<string, any> = { ...(v as Record<string, any>) };
        delete rest.$near;
        if (Object.keys(rest).length > 0) out[k] = rest;
        continue;
      }
      // Cross-field — rewrite to $geoWithin / $centerSphere.
      const coords = n.$geometry?.coordinates;
      const meters = n.$maxDistance;
      if (Array.isArray(coords) && typeof meters === 'number') {
        const rest: Record<string, any> = { ...(v as Record<string, any>) };
        delete rest.$near;
        rest.$geoWithin = { $centerSphere: [[coords[0], coords[1]], meters / EARTH_RADIUS_METERS] };
        out[k] = rest;
        continue;
      }
      // No usable geometry — fall through and let Mongo error explicitly.
    }
    out[k] = v;
  }
  return out;
}

/**
 * `orderBy: { col: { nearTo: [vector] } }` on a vector field — routes to
 * Atlas Vector Search via the $vectorSearch aggregation stage. Atlas-only;
 * on community / self-hosted Mongo this query will error at the server.
 *
 * Required infrastructure (created out-of-band via Atlas):
 *   db.<col>.createSearchIndex({
 *     mappings: { dynamic: false, fields: { embedding: { type: 'knnVector', dimensions, similarity } } }
 *   })
 */
async function executeSelectWithVectorSearch(
  node: SelectNode,
  model: ModelDef<any>,
  nearToEntry: NonNullable<SelectNode['orderBy']>[number],
  opts: ExecOpts,
): Promise<any[]> {
  const artifact = compileSelect(node, model);
  const coll = mongoDb(opts).collection(artifact.collection);
  const sessOpt = opts.session ? { session: opts.session } : undefined;
  const dbField = nearToEntry.field;
  const v = nearToEntry.nearTo as { vector: number[] };
  const limit = (artifact.args.options as any)?.limit ?? 100;

  const stage: any = {
    $vectorSearch: {
      index: `${dbField}_vector_index`,   // Atlas search index name; configurable below
      path: dbField,
      queryVector: v.vector,
      numCandidates: Math.max(limit * 10, 50),
      limit,
    },
  };
  const filter = artifact.args.filter ?? {};
  if (Object.keys(filter).length > 0) stage.$vectorSearch.filter = filter;

  const pipeline: any[] = [
    stage,
    { $set: { _distance: { $meta: 'vectorSearchScore' } } },
  ];
  const options = artifact.args.options ?? {};
  if (options.projection) pipeline.push({ $project: options.projection });

  const docs = await coll.aggregate(pipeline, sessOpt).toArray();
  let out = docs.map((r) => decodeRow(model, r));
  if (node.distinct?.length) out = dedupeBy(out, node.distinct);
  await applyProjectionAndHydration(out, model, node, opts);
  return out;
}

// Shared "post-fetch shaping": _count populates + relation hydration. Used by
// executeSelect (after the find), and by write executors (after insert/update
// to give create/update/upsert the same select/include semantics as reads).
async function applyProjectionAndHydration(
  rows: any[],
  model: ModelDef<any>,
  node: { projection?: SelectNode['projection']; hydration?: RelationPlan[] },
  opts: ExecOpts,
): Promise<void> {
  if (rows.length === 0) return;
  if (node.projection?.counts?.length) {
    await applyRelationCounts(rows, model, node.projection.counts, opts);
  }
  if (node.hydration?.length) {
    await hydrate(rows, model, node.hydration, opts);
  }
}

// Executors return the raw inserted/updated/deleted document(s) so the wrapper
// can layer the same select/include/omit projection + hydration on top via
// applyProjectionAndHydration. Cascade enforcement for deletes lives here so
// adapters stay self-contained.

export async function executeInsert(
  node: InsertNode,
  model: ModelDef<any>,
  opts: ExecOpts = {},
): Promise<{ docs: any[]; count: number }> {
  const artifact = compileInsert(node, model);
  const coll = mongoDb(opts).collection(artifact.collection);
  const sessOpt = opts.session ? { session: opts.session } : undefined;
  try {
    if (artifact.op === 'insertOne') {
      const document = artifact.args.document as Document;
      const r = await coll.insertOne(document, sessOpt);
      document._id = document._id ?? r.insertedId;
      return { docs: [document], count: 1 };
    }
    const documents = artifact.args.documents as Document[];
    const insertManyOpts = { ...(artifact.args.options ?? {}), ...(sessOpt ?? {}) };
    const r = await coll.insertMany(documents, insertManyOpts);
    return { docs: documents, count: r.insertedCount };
  } catch (err: any) {
    if (node.skipDuplicates && err?.writeErrors) {
      const inserted = (err.result?.insertedCount as number) ?? 0;
      return { docs: [], count: inserted };
    }
    rethrowMongoError(err, model.collection);
    throw err; // unreachable
  }
}

export async function executeUpdate(
  node: UpdateNode,
  model: ModelDef<any>,
  opts: ExecOpts = {},
): Promise<{ doc?: any; count: number }> {
  // A relation filter becomes an $in on the join key first, as on reads.
  if (hasRelationFilter(node.where)) node = { ...node, where: await resolveRelationFilters(model, node.where!, opts) };
  const artifact = compileUpdate(node, model);
  const coll = mongoDb(opts).collection(artifact.collection);
  const sessOpt = opts.session ? { session: opts.session } : undefined;
  const filter = artifact.args.filter ?? {};
  const update = artifact.args.update;
  const options = artifact.args.options ?? {};
  try {
    // No scalar changes (an update whose data is only nested relation writes,
    // or an emptied patch): Mongo rejects an empty update document, so read
    // the row the update would have returned.
    const emptyPatch = update && typeof update === 'object' && !Array.isArray(update) && Object.keys(update).length === 0;
    if (emptyPatch && !node.upsertCreate) {
      if (artifact.op === 'findOneAndUpdate') {
        const doc = await coll.findOne(filter, sessOpt);
        return doc ? { doc, count: 1 } : { doc: undefined, count: 0 };
      }
      return { count: await coll.countDocuments(filter, sessOpt) };
    }
    if (artifact.op === 'findOneAndUpdate' && node.noReturn && !options.sort) {
      // `select: false`: the write without the document coming back.
      const { returnDocument: _r, projection: _p, ...rest } = options as any;
      const r = await coll.updateOne(filter, update, { ...rest, ...(sessOpt ?? {}) });
      return { count: r.matchedCount + (r.upsertedCount ?? 0) };
    }
    if (artifact.op === 'findOneAndUpdate') {
      // Force the ModifyResult wrapper so the return shape is deterministic
      // across driver versions: v5 defaults to `{ value, ok, lastErrorObject }`,
      // but v6/v7 default to returning the bare document. Without this, the
      // unwrap below would have to guess — and a document field literally named
      // `value` (e.g. a promo's discount `value`) would be mistaken for the
      // driver's result envelope, silently turning a successful update into a
      // false not-found.
      const raw: any = await coll.findOneAndUpdate(filter, update, {
        ...options,
        ...(sessOpt ?? {}),
        includeResultMetadata: true,
      });
      // `raw` is now always a ModifyResult: `.value` is the document (or null).
      const doc = raw ? raw.value : null;
      if (!doc && !node.upsertCreate) {
        // Wrapper decides whether to throw — return undefined for callers to
        // surface notFoundError with their args.where context.
        return { doc: undefined, count: 0 };
      }
      return { doc, count: 1 };
    }
    const r = await coll.updateMany(filter, update, sessOpt);
    // matchedCount, not modifiedCount: a row already holding the new value is
    // still a row the filter selected, and every SQL dialect counts it.
    return { count: r.matchedCount };
  } catch (err) {
    rethrowMongoError(err, model.collection);
    throw err; // unreachable
  }
}

export async function executeDelete(
  node: DeleteNode,
  model: ModelDef<any>,
  opts: ExecOpts = {},
): Promise<{ doc?: any; count: number }> {
  // A relation filter becomes an $in on the join key first, as on reads.
  if (hasRelationFilter(node.where)) node = { ...node, where: await resolveRelationFilters(model, node.where!, opts) };
  const artifact = compileDelete(node, model);
  const coll = mongoDb(opts).collection(artifact.collection);
  const sessOpt = opts.session ? { session: opts.session } : undefined;
  const filter = artifact.args.filter ?? {};
  // onDelete actions run in the wrapper before this, on the same session, so
  // the delete itself is one round trip.
  try {
    if (artifact.op === 'findOneAndDelete' && node.noReturn) {
      return { count: (await coll.deleteOne(filter, sessOpt)).deletedCount };
    }
    if (artifact.op === 'findOneAndDelete') {
      const raw: any = await coll.findOneAndDelete(filter, { ...(sessOpt ?? {}), includeResultMetadata: true });
      const doc = raw ? raw.value : null;
      return doc ? { doc, count: 1 } : { doc: undefined, count: 0 };
    }
    const r = await coll.deleteMany(filter, sessOpt);
    return { count: r.deletedCount };
  } catch (err) {
    rethrowMongoError(err, model.collection);
    throw err; // unreachable
  }
}

// Re-export for the wrapper's return-one path so it can layer select/include
// /omit + hydration on top of an already-fetched document.
export { applyProjectionAndHydration };

void notFoundError;

// Reshape Mongo's $group output back into Prisma's nested `{ <by>, _count,
// _avg, _sum, _min, _max }` payload. The compiler emits flat `__agg_<bucket>_
// <field>` aliases; we re-bucket them here.
function reshapeMongoGroupByRow(doc: any, byCols: string[]): any {
  const out: any = {};
  const id = doc._id ?? {};
  for (const c of byCols) out[c] = id[c];
  for (const k of Object.keys(doc)) {
    const m = k.match(/^__agg_(count|avg|sum|min|max)_(.+)$/);
    if (!m) continue;
    out[`_${m[1]}`] ??= {};
    out[`_${m[1]}`][m[2]] = doc[k];
  }
  return out;
}

export async function executeGroupBy(
  node: GroupByNode,
  model: ModelDef<any>,
  opts: ExecOpts = {},
): Promise<any[]> {
  if (hasRelationFilter(node.where)) node = { ...node, where: await resolveRelationFilters(model, node.where!, opts) };
  const artifact = compileGroupBy(node, model);
  const coll = mongoDb(opts).collection(artifact.collection);
  const sessOpt = opts.session ? { session: opts.session } : undefined;
  const docs = await coll.aggregate(artifact.args.pipeline, sessOpt).toArray();
  return docs.map((d) => reshapeMongoGroupByRow(d, node.by));
}

export async function executeCount(
  node: CountNode,
  model: ModelDef<any>,
  opts: ExecOpts = {},
): Promise<number> {
  if (hasRelationFilter(node.where)) {
    node = { ...node, where: await resolveRelationFilters(model, node.where!, opts) };
  }
  if (hasRelationFilter(node.where)) {
    const pipeline = compileMatchStages(model, node.where).stages;
    if (node.distinct?.length) {
      const groupId: Record<string, string> = {};
      for (const fieldName of node.distinct) groupId[fieldName] = '$' + appKeyToDbKey(fieldName);
      pipeline.push({ $group: { _id: groupId } });
    }
    pipeline.push({ $count: 'n' });
    const res = await mongoDb(opts)
      .collection(model.collection)
      .aggregate(pipeline, opts.session ? { session: opts.session } : undefined)
      .toArray();
    return res.length ? (res[0] as any).n : 0;
  }
  const artifact = compileCount(node, model);
  const coll = mongoDb(opts).collection(artifact.collection);
  const sessOpt = opts.session ? { session: opts.session } : undefined;
  const filter = artifact.args.filter ?? {};

  // `count({ distinct: [...] })` — count distinct value-combinations of the
  // listed fields. countDocuments() can't do this, so group then count the
  // groups. (The SQL dialects compile this to COUNT(DISTINCT …).)
  if (node.distinct?.length) {
    const groupId: Record<string, string> = {};
    for (const fieldName of node.distinct) groupId[fieldName] = '$' + appKeyToDbKey(fieldName);
    const pipeline: Record<string, any>[] = [];
    if (Object.keys(filter).length) pipeline.push({ $match: filter });
    pipeline.push({ $group: { _id: groupId } }, { $count: 'n' });
    const res = await coll.aggregate(pipeline, sessOpt).toArray();
    return res.length ? (res[0] as any).n : 0;
  }

  return coll.countDocuments(filter, sessOpt);
}

async function hydrate(
  rows: any[],
  parentModel: ModelDef<any>,
  hydration: RelationPlan[],
  opts: ExecOpts,
): Promise<void> {
  for (const rel of hydration) {
    const targetModel = (schema as any)[rel.target] as ModelDef<any> | undefined;
    if (!targetModel) continue;

    // Owning-side one: parent holds FK, fetch one target per parent FK value.
    // Inverse-side one or many: target holds FK pointing at parent.refs.
    const isOwningOne = rel.kind === 'one' && hasField(parentModel, rel.on);
    if (isOwningOne) {
      await hydrateOwningOne(rows, rel, parentModel, targetModel, opts);
    } else if (rel.kind === 'one') {
      await hydrateInverseOne(rows, rel, parentModel, targetModel, opts);
    } else {
      await hydrateMany(rows, rel, parentModel, targetModel, opts);
    }
  }
}

async function hydrateOwningOne(
  rows: any[],
  rel: RelationPlan,
  parentModel: ModelDef<any>,
  targetModel: ModelDef<any>,
  opts: ExecOpts,
): Promise<void> {
  const refDef = getFieldDef(targetModel, rel.refs) ?? targetModel.fields.id;
  await hydrateOneRelation({
    rows, rel,
    parentField: rel.on,
    targetField: rel.refs,
    keyOf: stringKey,
    mapRef: (v) => coerceFieldValue(refDef, v),
    runSelect: (node) => executeSelect(node, targetModel, { ...opts, wholeResult: true }),
  });
}

async function hydrateInverseOne(
  rows: any[],
  rel: RelationPlan,
  parentModel: ModelDef<any>,
  targetModel: ModelDef<any>,
  opts: ExecOpts,
): Promise<void> {
  const fkDef = getFieldDef(targetModel, rel.on)
    ?? targetModel.fields[rel.on]
    ?? ({ kind: 'objectId' } as never);
  await hydrateOneRelation({
    rows, rel,
    parentField: rel.refs,
    targetField: rel.on,
    keyOf: stringKey,
    mapRef: (v) => coerceFieldValue(fkDef, v),
    runSelect: (node) => executeSelect(node, targetModel, { ...opts, wholeResult: true }),
  });
}

async function hydrateMany(
  rows: any[],
  rel: RelationPlan,
  parentModel: ModelDef<any>,
  targetModel: ModelDef<any>,
  opts: ExecOpts,
): Promise<void> {
  const fkDef = getFieldDef(targetModel, rel.on);
  await hydrateManyRelation({
    rows, rel,
    keyOf: stringKey,
    mapRef: (v) =>
      coerceFieldValue(fkDef ?? targetModel.fields[rel.on] ?? ({ kind: 'objectId' } as any), v),
    runSelect: (node) => executeSelect(node, targetModel, { ...opts, wholeResult: true }),
    windowed: windowedFor(mongoDb(opts)),
    keyFirst: true,
  });
}


// _count: { select: { posts: true } } — issue a countDocuments per relation.
async function applyRelationCounts(
  rows: any[],
  parentModel: ModelDef<any>,
  counts: string[],
  opts: ExecOpts,
): Promise<void> {
  if (rows.length === 0) return;
  const relMap = parentModel.relations();
  for (const r of rows) r._count = r._count ?? {};
  for (const relName of counts) {
    const rel = relMap[relName];
    if (!rel) continue;
    const targetModel = (schema as any)[rel.target] as ModelDef<any> | undefined;
    if (!targetModel) continue;
    const coll = mongoDb(opts).collection(targetModel.collection);
    const refs = unique(rows.map((r) => r[rel.refs]).filter(notNull));
    const fkDef = getFieldDef(targetModel, rel.on);
    const coerced = refs.map((v) =>
      coerceFieldValue(fkDef ?? targetModel.fields[rel.on] ?? { kind: 'objectId' } as any, v),
    );
    if (coerced.length === 0) {
      for (const row of rows) row._count[relName] = 0;
      continue;
    }
    // Soft-deleted children are excluded so `_count` agrees with the rows
    // `include` hands back — it used to say 7 where include returned 5.
    const sd = softDeleteField(targetModel);
    const match: Record<string, unknown> = { [appKeyToDbKey(rel.on)]: { $in: coerced } };
    if (sd) match[appKeyToDbKey(sd)] = null;
    const grouped = await coll.aggregate([
      { $match: match },
      { $group: { _id: `$${appKeyToDbKey(rel.on)}`, c: { $sum: 1 } } },
    ], opts.session ? { session: opts.session } : undefined).toArray();
    const byFk = new Map<string, number>();
    for (const g of grouped) byFk.set(stringKey(g._id), g.c);
    for (const row of rows) row._count[relName] = byFk.get(stringKey(row[rel.refs])) ?? 0;
  }
}

function hasField(model: ModelDef<any>, fieldName: string): boolean {
  return model.fields[fieldName] != null;
}

function notNull<T>(v: T | null | undefined): v is T {
  return v != null;
}

function unique<T>(arr: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const v of arr) {
    const k = stringKey(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function stringKey(v: any): string {
  if (v == null) return '\x00';
  if (v instanceof mongo().ObjectId) return v.toHexString();
  if (typeof v === 'object' && v._bsontype === 'ObjectId') return v.toString();
  return String(v);
}

function dedupeBy(rows: any[], fields: string[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const r of rows) {
    const k = fields.map((f) => JSON.stringify(r[f] ?? null)).join('\x1e');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}
