import { ObjectId } from 'mongodb';
import { dbClient } from './client';
import { schema } from '../../schema';
import { RelationInfo } from '../../schema/core';
import { ModelDef } from '../../schema/types';
import { decodeRow } from './coerce';
import { translateOrderBy } from './translate/orderby';
import { planSelection, pruneRowToSelect, RelationArgs } from './translate/select-include';
import { translateWhere } from './translate/where';

// Look up a relation's target model via the schema registry. Replaces the
// old `rel.target()` thunk pattern — relations now carry a string key into
// the schema map instead of a function.
function resolveTarget(rel: RelationInfo): ModelDef<any> {
  const target = (schema as any)[rel.target];
  if (!target) {
    throw new Error(
      `[Database] relation target '${rel.target}' is not in the schema map`,
    );
  }
  return target as ModelDef<any>;
}

// ============================================================================
// Relation hydration (post-fetch).
//
// Prisma's MongoDB connector issues a query per relation under the hood and
// stitches results in-process — we do the same. Trade-off vs $lookup:
//   + No 16MB pipeline limits, no index-blind aggregations.
//   + Trivial to support arbitrarily nested include/select/where/take.
//   + Each relation is a simple, indexable Mongo find — fast.
//   – Up to 1+N queries for nested graphs. Mitigation: each level batches
//     the parent ids into a single $in query, so it's 1+N levels, not 1+rows.
//
// All FK lookups use the parent's `on` value (after coercing string id ↔
// ObjectId on each side). The relation's owning side stores the FK; for
// inverse (list) relations, we query the child collection by the FK field.
// ============================================================================

// Hydrate `rows` in place with the planned relations. Mutates and returns rows.
export async function hydrateRelations(
  parentModel: ModelDef<any>,
  rows: any[],
  relationsPlan: Record<string, RelationArgs>,
  countsPlan: string[],
  selectForPrune?: any, // when the caller used `select`, prune to listed keys
): Promise<any[]> {
  if (rows.length === 0) return rows;
  const relations = parentModel.relations();

  // ── _count ─────────────────────────────────────────────────────────
  if (countsPlan.length > 0) {
    const counts: Record<string, Record<string, number>> = {};
    for (const rk of countsPlan) {
      const rel = relations[rk];
      if (!rel) continue;
      counts[rk] = await batchCount(parentModel, rel, rows);
    }
    for (const row of rows) {
      const c: any = {};
      for (const rk of countsPlan) c[rk] = counts[rk]?.[String(row.id ?? row._id)] ?? 0;
      row._count = { ...(row._count || {}), ...c };
    }
  }

  // ── relations ──────────────────────────────────────────────────────
  for (const relName of Object.keys(relationsPlan)) {
    const rel = relations[relName];
    if (!rel) continue;
    await batchLoadRelation(parentModel, rel, relName, rows, relationsPlan[relName]);
  }

  // ── select pruning (after hydration so relation keys survive) ──────
  if (selectForPrune) {
    return rows.map((r) => pruneRowToSelect(r, selectForPrune));
  }
  return rows;
}

async function batchLoadRelation(
  parentModel: ModelDef<any>,
  rel: RelationInfo,
  relName: string,
  rows: any[],
  args: RelationArgs,
): Promise<void> {
  const target = resolveTarget(rel);
  const targetCollection = dbClient.db.collection(target.collection);

  // Build the parent-side keys we need to look up. For owning rels (parent
  // holds FK), key is parent[on]. For inverse rels (parent is one, child
  // holds FK), key is parent[refs].
  const parentSideField = rel.inverse ? rel.refs : rel.on;
  const childSideField = rel.inverse ? rel.on : rel.refs;

  const keyValues = unique(rows.map((r) => r[parentSideField]).filter((v) => v != null));
  if (keyValues.length === 0) {
    for (const row of rows) {
      row[relName] = rel.kind === 'many' ? [] : null;
    }
    return;
  }

  // Build a Mongo $in filter on the child collection's join field. Coerce
  // string ids → ObjectId IF the child field is an objectId field.
  const childFieldDef = target.fields[childSideField];
  const childDbKey = childSideField === 'id' ? '_id' : childSideField;
  const isObjectIdField =
    childFieldDef?.kind === 'id' || childFieldDef?.kind === 'objectId';

  const inValues = isObjectIdField
    ? keyValues.map((v) => (typeof v === 'string' && ObjectId.isValid(v) ? new ObjectId(v) : v))
    : keyValues;

  // Compose where: caller's where AND the FK match.
  const childWhere = args.where ? translateWhere(target, args.where) : {};
  const filter = { $and: [childWhere, { [childDbKey]: { $in: inValues } }] };

  // Plan the child's own selection (nested include/select).
  const subPlan = planSelection(target, { select: args.select, include: args.include });

  let cursor = targetCollection.find(filter);
  if (subPlan.projection) cursor = cursor.project(subPlan.projection);
  const sort = translateOrderBy(args.orderBy);
  if (sort) cursor = cursor.sort(sort as any);
  if (args.skip) cursor = cursor.skip(args.skip);
  if (args.take) cursor = cursor.limit(args.take);

  const childDocs = await cursor.toArray();
  let childRows = childDocs.map((d) => decodeRow(target, d));

  // Recurse into nested relations / counts.
  if (Object.keys(subPlan.relations).length > 0 || subPlan.counts.length > 0) {
    childRows = await hydrateRelations(
      target,
      childRows,
      subPlan.relations,
      subPlan.counts,
      subPlan.isSelect ? args.select : undefined,
    );
  } else if (subPlan.isSelect && args.select) {
    childRows = childRows.map((r) => pruneRowToSelect(r, args.select));
  }

  // Group children by parent key.
  if (rel.kind === 'one') {
    const byKey = new Map<string, any>();
    for (const c of childRows) {
      const k = String(c[childSideField] ?? c.id);
      if (!byKey.has(k)) byKey.set(k, c);
    }
    for (const row of rows) {
      const pk = row[parentSideField];
      row[relName] = pk != null ? byKey.get(String(pk)) ?? null : null;
    }
  } else {
    const byKey = new Map<string, any[]>();
    for (const c of childRows) {
      const k = String(c[childSideField]);
      const list = byKey.get(k);
      if (list) list.push(c);
      else byKey.set(k, [c]);
    }
    for (const row of rows) {
      const pk = row[parentSideField];
      row[relName] = pk != null ? byKey.get(String(pk)) ?? [] : [];
    }
  }
}

async function batchCount(
  parentModel: ModelDef<any>,
  rel: RelationInfo,
  rows: any[],
): Promise<Record<string, number>> {
  const target = resolveTarget(rel);
  const collection = dbClient.db.collection(target.collection);
  const parentSideField = rel.inverse ? rel.refs : rel.on;
  const childSideField = rel.inverse ? rel.on : rel.refs;
  const childDbKey = childSideField === 'id' ? '_id' : childSideField;
  const isObjectIdField = target.fields[childSideField]?.kind === 'id' ||
    target.fields[childSideField]?.kind === 'objectId';

  const keys = unique(rows.map((r) => r[parentSideField]).filter((v) => v != null));
  if (keys.length === 0) return {};
  const inValues = isObjectIdField
    ? keys.map((v) => (typeof v === 'string' && ObjectId.isValid(v) ? new ObjectId(v) : v))
    : keys;

  const pipeline = [
    { $match: { [childDbKey]: { $in: inValues } } },
    { $group: { _id: `$${childDbKey}`, count: { $sum: 1 } } },
  ];
  const results = await collection.aggregate(pipeline).toArray();
  const out: Record<string, number> = {};
  for (const r of results) out[String(r._id)] = r.count;
  return out;
}

function unique<T>(arr: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const v of arr) {
    const k = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}
