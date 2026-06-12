import type { ObjectId } from 'mongodb';
import { mongo } from './bson';
import { dbClient } from './client';
import { RelationInfo } from '../../schema/core';
import { ModelDef, OnDeleteAction } from '../../schema/types';
import { schema } from '../../schema';

// Inverts the schema map (ModelDef → its key) so we can answer "which schema
// key corresponds to this parent model?" when finding child relations that
// point at a given parent.
const schemaKeyByModel = new Map<ModelDef<any>, string>();
for (const [key, model] of Object.entries(schema)) {
  schemaKeyByModel.set(model as ModelDef<any>, key);
}

// Cascade walker — replicates Prisma's onDelete semantics application-side.
// Mongo has no FK enforcement; Prisma did this in its query engine. For each
// row about to be deleted, we walk the schema's *inverse* (one-to-many)
// relations whose owning side has `onDelete: Cascade` or `SetNull`, and either
// delete or null-out the children. The walk recurses (Business → videos →
// likes/comments → replies). The visited set prevents pathological loops.

interface CascadeContext {
  visited: Set<string>;
}

const allModels: ModelDef<any>[] = Object.values(schema) as any[];

// Find every owning relation in the registry whose target is `parentModel`.
// These are the ones the cascade walker needs to follow.
function findChildRelations(
  parentModel: ModelDef<any>,
): Array<{
  childModel: ModelDef<any>;
  rel: RelationInfo;
  childRelName: string;
}> {
  const parentKey = schemaKeyByModel.get(parentModel);
  if (!parentKey) return [];
  const out: Array<{
    childModel: ModelDef<any>;
    rel: RelationInfo;
    childRelName: string;
  }> = [];
  for (const childModel of allModels) {
    const rels = childModel.relations();
    for (const [relName, rel] of Object.entries(rels)) {
      const r = rel as RelationInfo;
      if (r.kind !== 'one' || r.inverse) continue;
      if (r.target !== parentKey) continue;
      out.push({ childModel, rel: r, childRelName: relName });
    }
  }
  return out;
}

export async function applyCascadesForDelete(
  parentModel: ModelDef<any>,
  parentDocs: Array<Record<string, any>>,
  ctx: CascadeContext = { visited: new Set() },
): Promise<void> {
  if (parentDocs.length === 0) return;
  const children = findChildRelations(parentModel);
  if (children.length === 0) return;

  for (const { childModel, rel } of children) {
    const onDelete: OnDeleteAction = rel.onDelete || 'NoAction';
    if (onDelete === 'NoAction' || onDelete === 'Restrict') continue;

    // Resolve parent-side key values (the `refs` field on the parent doc).
    const parentRefValues = unique(
      parentDocs.map((p) => p[rel.refs] ?? p[rel.refs === 'id' ? '_id' : rel.refs]).filter(notNull),
    );
    if (parentRefValues.length === 0) continue;

    // The child's `on` field stores the FK; coerce match values for objectId.
    const childOnDef = childModel.fields[rel.on];
    const isObjectIdField =
      childOnDef?.kind === 'id' || childOnDef?.kind === 'objectId';
    const inValues = isObjectIdField
      ? parentRefValues.map((v) =>
          v instanceof mongo().ObjectId
            ? v
            : typeof v === 'string' && mongo().ObjectId.isValid(v)
              ? new (mongo().ObjectId)(v)
              : v,
        )
      : parentRefValues;

    const childCollection = dbClient.db.collection(childModel.collection);
    const filter = { [rel.on]: { $in: inValues } };

    if (onDelete === 'SetNull') {
      await childCollection.updateMany(filter as any, { $unset: { [rel.on]: '' } });
      continue;
    }

    // Cascade: fetch the child docs first (need their ids for the recursive
    // step), then delete them.
    const childDocs = await childCollection.find(filter as any).toArray();
    if (childDocs.length === 0) continue;

    // Loop guard: track (collection:_id) we've already processed.
    const fresh = childDocs.filter((d) => {
      const key = `${childModel.collection}:${String(d._id)}`;
      if (ctx.visited.has(key)) return false;
      ctx.visited.add(key);
      return true;
    });
    if (fresh.length === 0) continue;

    // Recurse first so we delete leaves before parents — preserves ref
    // integrity if any of the cascading writes are observed mid-flight by
    // a concurrent reader (best-effort; we're not in a transaction by
    // default — Mongo requires a replica set).
    await applyCascadesForDelete(childModel, fresh, ctx);

    const ids = fresh.map((d) => d._id);
    await childCollection.deleteMany({ _id: { $in: ids } } as any);
  }
}

function unique<T>(arr: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const v of arr) {
    const k = v instanceof mongo().ObjectId ? v.toString() : String(v);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

function notNull<T>(v: T | null | undefined): v is T {
  return v != null;
}
