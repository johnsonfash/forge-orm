import type { ClientSession, Document } from 'mongodb';
import { dbClient } from './client';
import type {
  CountNode,
  DeleteNode,
  GroupByNode,
  InsertNode,
  RelationPlan,
  SelectNode,
  UpdateNode,
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
} from './compile-from-ir';
import { applyCascadesForDelete } from './cascade';
import { notFoundError, rethrowMongoError } from './errors';
import type { ObjectId } from 'mongodb';
import { mongo } from './bson';

interface ExecOpts { session?: ClientSession }

export async function executeSelect(
  node: SelectNode,
  model: ModelDef<any>,
  opts: ExecOpts = {},
): Promise<any[]> {
  const artifact = compileSelect(node, model);
  const coll = dbClient.db.collection(artifact.collection);
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
    rows = await cursor.toArray();
  }

  let out: any[] = rows.map((r) => decodeRow(model, r));

  if (node.distinct?.length) {
    out = dedupeBy(out, node.distinct);
  }

  await applyProjectionAndHydration(out, model, node, opts.session);
  return out;
}

// Shared "post-fetch shaping": _count populates + relation hydration. Used by
// executeSelect (after the find), and by write executors (after insert/update
// to give create/update/upsert the same select/include semantics as reads).
async function applyProjectionAndHydration(
  rows: any[],
  model: ModelDef<any>,
  node: { projection?: SelectNode['projection']; hydration?: RelationPlan[] },
  session?: ClientSession,
): Promise<void> {
  if (rows.length === 0) return;
  if (node.projection?.counts?.length) {
    await applyRelationCounts(rows, model, node.projection.counts, session);
  }
  if (node.hydration?.length) {
    await hydrate(rows, model, node.hydration, session);
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
  const coll = dbClient.db.collection(artifact.collection);
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
  const artifact = compileUpdate(node, model);
  const coll = dbClient.db.collection(artifact.collection);
  const sessOpt = opts.session ? { session: opts.session } : undefined;
  const filter = artifact.args.filter ?? {};
  const update = artifact.args.update;
  const options = artifact.args.options ?? {};
  try {
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
    return { count: r.modifiedCount };
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
  const artifact = compileDelete(node, model);
  const coll = dbClient.db.collection(artifact.collection);
  const sessOpt = opts.session ? { session: opts.session } : undefined;
  const filter = artifact.args.filter ?? {};
  if (artifact.op === 'findOneAndDelete') {
    // Fetch first so we can run cascade enforcement against the pre-delete row.
    const target = await coll.findOne(filter, sessOpt);
    if (!target) return { doc: undefined, count: 0 };
    await coll.deleteOne({ _id: (target as any)._id }, sessOpt);
    await applyCascadesForDelete(model, [target as any]);
    return { doc: target, count: 1 };
  }
  // Fetch first so cascade enforcement runs against the pre-delete rows.
  const targets = await coll.find(filter, sessOpt).toArray();
  if (targets.length === 0) return { count: 0 };
  const ids = targets.map((d) => (d as any)._id);
  const r = await coll.deleteMany({ _id: { $in: ids } }, sessOpt);
  await applyCascadesForDelete(model, targets as any[]);
  return { count: r.deletedCount };
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
  const artifact = compileGroupBy(node, model);
  const coll = dbClient.db.collection(artifact.collection);
  const sessOpt = opts.session ? { session: opts.session } : undefined;
  const docs = await coll.aggregate(artifact.args.pipeline, sessOpt).toArray();
  return docs.map((d) => reshapeMongoGroupByRow(d, node.by));
}

export async function executeCount(
  node: CountNode,
  model: ModelDef<any>,
  opts: ExecOpts = {},
): Promise<number> {
  const artifact = compileCount(node, model);
  const coll = dbClient.db.collection(artifact.collection);
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
  session?: ClientSession,
): Promise<void> {
  for (const rel of hydration) {
    const targetModel = (schema as any)[rel.target] as ModelDef<any> | undefined;
    if (!targetModel) continue;

    // Owning-side one: parent holds FK, fetch one target per parent FK value.
    // Inverse-side one or many: target holds FK pointing at parent.refs.
    const isOwningOne = rel.kind === 'one' && hasField(parentModel, rel.on);
    if (isOwningOne) {
      await hydrateOwningOne(rows, rel, parentModel, targetModel, session);
    } else if (rel.kind === 'one') {
      await hydrateInverseOne(rows, rel, parentModel, targetModel, session);
    } else {
      await hydrateMany(rows, rel, parentModel, targetModel, session);
    }
  }
}

async function hydrateOwningOne(
  rows: any[],
  rel: RelationPlan,
  parentModel: ModelDef<any>,
  targetModel: ModelDef<any>,
  session?: ClientSession,
): Promise<void> {
  const fks = unique(rows.map((r) => r[rel.on]).filter(notNull));
  if (fks.length === 0) {
    for (const r of rows) r[rel.name] = null;
    return;
  }
  const coercedRefs = fks.map((v) =>
    coerceFieldValue(getFieldDef(targetModel, rel.refs) ?? targetModel.fields.id, v),
  );
  const subNode = mergeNested(rel, {
    where: undefined,
    cardinality: 'many',
  });
  const node: SelectNode = {
    ...subNode,
    kind: 'select',
    model: rel.target,
    cardinality: 'many',
    where: { kind: 'leaf', field: rel.refs, op: 'in', value: coercedRefs },
  };
  const found = await executeSelect(node, targetModel, { session });
  const byRef = new Map<string, any>();
  for (const t of found) byRef.set(stringKey(t[rel.refs]), t);
  for (const r of rows) {
    const k = r[rel.on];
    r[rel.name] = k == null ? null : (byRef.get(stringKey(k)) ?? null);
  }
}

async function hydrateInverseOne(
  rows: any[],
  rel: RelationPlan,
  parentModel: ModelDef<any>,
  targetModel: ModelDef<any>,
  session?: ClientSession,
): Promise<void> {
  const parentRefs = unique(rows.map((r) => r[rel.refs]).filter(notNull));
  if (parentRefs.length === 0) {
    for (const r of rows) r[rel.name] = null;
    return;
  }
  const fkDef = getFieldDef(targetModel, rel.on);
  const coerced = parentRefs.map((v) =>
    coerceFieldValue(fkDef ?? targetModel.fields[rel.on] ?? { kind: 'objectId' } as any, v),
  );
  const subNode = mergeNested(rel, { cardinality: 'many' });
  const node: SelectNode = {
    ...subNode,
    kind: 'select',
    model: rel.target,
    cardinality: 'many',
    where: { kind: 'leaf', field: rel.on, op: 'in', value: coerced },
  };
  const found = await executeSelect(node, targetModel, { session });
  const byFk = new Map<string, any>();
  for (const t of found) byFk.set(stringKey(t[rel.on]), t);
  for (const r of rows) {
    const k = r[rel.refs];
    r[rel.name] = k == null ? null : (byFk.get(stringKey(k)) ?? null);
  }
}

async function hydrateMany(
  rows: any[],
  rel: RelationPlan,
  parentModel: ModelDef<any>,
  targetModel: ModelDef<any>,
  session?: ClientSession,
): Promise<void> {
  const parentRefs = unique(rows.map((r) => r[rel.refs]).filter(notNull));
  if (parentRefs.length === 0) {
    for (const r of rows) r[rel.name] = [];
    return;
  }
  const fkDef = getFieldDef(targetModel, rel.on);
  const coerced = parentRefs.map((v) =>
    coerceFieldValue(fkDef ?? targetModel.fields[rel.on] ?? { kind: 'objectId' } as any, v),
  );
  const subNode = mergeNested(rel, { cardinality: 'many' });
  // Combine the nested.where (if any) with our IN-filter via AND.
  const fkLeaf = { kind: 'leaf', field: rel.on, op: 'in', value: coerced } as const;
  const where = subNode.where
    ? { kind: 'and' as const, children: [subNode.where, fkLeaf] }
    : fkLeaf;
  const node: SelectNode = {
    ...subNode,
    kind: 'select',
    model: rel.target,
    cardinality: 'many',
    where,
  };
  const found = await executeSelect(node, targetModel, { session });
  const byParent = new Map<string, any[]>();
  for (const t of found) {
    const k = stringKey(t[rel.on]);
    const list = byParent.get(k);
    if (list) list.push(t);
    else byParent.set(k, [t]);
  }
  for (const r of rows) {
    r[rel.name] = byParent.get(stringKey(r[rel.refs])) ?? [];
  }
}

function mergeNested(rel: RelationPlan, fallback: { where?: any; cardinality: 'one' | 'many' }) {
  const nested = rel.nested ?? {};
  return {
    where: (nested as any).where ?? fallback.where,
    projection: (nested as any).projection,
    hydration: (nested as any).hydration,
    orderBy: (nested as any).orderBy,
    limit: (nested as any).limit,
    offset: (nested as any).offset,
    cursor: (nested as any).cursor,
    distinct: (nested as any).distinct,
  };
}

// _count: { select: { posts: true } } — issue a countDocuments per relation.
async function applyRelationCounts(
  rows: any[],
  parentModel: ModelDef<any>,
  counts: string[],
  session?: ClientSession,
): Promise<void> {
  if (rows.length === 0) return;
  const relMap = parentModel.relations();
  for (const r of rows) r._count = r._count ?? {};
  for (const relName of counts) {
    const rel = relMap[relName];
    if (!rel) continue;
    const targetModel = (schema as any)[rel.target] as ModelDef<any> | undefined;
    if (!targetModel) continue;
    const coll = dbClient.db.collection(targetModel.collection);
    const refs = unique(rows.map((r) => r[rel.refs]).filter(notNull));
    const fkDef = getFieldDef(targetModel, rel.on);
    const coerced = refs.map((v) =>
      coerceFieldValue(fkDef ?? targetModel.fields[rel.on] ?? { kind: 'objectId' } as any, v),
    );
    if (coerced.length === 0) {
      for (const row of rows) row._count[relName] = 0;
      continue;
    }
    const grouped = await coll.aggregate([
      { $match: { [appKeyToDbKey(rel.on)]: { $in: coerced } } },
      { $group: { _id: `$${appKeyToDbKey(rel.on)}`, c: { $sum: 1 } } },
    ], session ? { session } : undefined).toArray();
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
