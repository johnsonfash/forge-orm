import { UpdateFilter } from 'mongodb';
import { ModelDef, RelationDef } from '../../../schema/types';
import {
  applyUpdateTimestamps,
  appKeyToDbKey,
  coerceFieldValue,
  getFieldDef,
} from '../coerce';

// ============================================================================
// Prisma `data` (update path) → Mongo UpdateFilter.
//
// Forms supported per field:
//   • { x: 1 }                                  → $set
//   • { x: { set: 1 } }                         → $set
//   • { x: { increment: 1 } }                   → $inc
//   • { x: { decrement: 1 } }                   → $inc with negate
//   • { x: { multiply: 2 } }                    → $mul
//   • { x: { divide: 2 } }                      → $mul with reciprocal
//   • { tags: { push: 'x' } }                   → $push
//   • { rel: { connect: { id } } }              → $set on FK
//   • { rel: { disconnect: true } }             → $unset on FK
//   • { rel: { create: {...} } }                → not supported in v1; throws
//
// The `@updatedAt` field is set automatically (unless the caller provided it).
// `id` is rewritten to `_id`.
// ============================================================================

export function translateUpdateData(
  model: ModelDef<any>,
  data: any,
): UpdateFilter<any> {
  if (!data || typeof data !== 'object') return {};

  const $set: any = {};
  const $unset: any = {};
  const $inc: any = {};
  const $mul: any = {};
  const $push: any = {};
  const $pull: any = {};
  const $addToSet: any = {};

  // Auto-applied @updatedAt timestamps go into $set unconditionally if the
  // caller didn't supply them.
  const stamped = applyUpdateTimestamps(model, {});
  for (const k of Object.keys(stamped)) {
    if (data[k] === undefined) $set[k] = stamped[k];
  }

  const relations = model.relations();

  for (const key of Object.keys(data)) {
    if (data[key] === undefined) continue;

    // Relation operators (connect/disconnect/set on a one-side rel)
    const rel: RelationDef | undefined = relations[key];
    if (rel && rel.kind === 'one' && !rel.inverse) {
      handleOneRelationUpdate(rel, data[key], $set, $unset);
      continue;
    }

    const dbKey = appKeyToDbKey(key);
    const def = getFieldDef(model, key);
    const value = data[key];

    if (
      value !== null &&
      typeof value === 'object' &&
      !(value instanceof Date) &&
      !Array.isArray(value)
    ) {
      // Operator object on a scalar.
      if ('set' in value) {
        $set[dbKey] = coerceFieldValue(def, (value as any).set);
        continue;
      }
      if ('increment' in value) {
        $inc[dbKey] = (value as any).increment;
        continue;
      }
      if ('decrement' in value) {
        $inc[dbKey] = -(value as any).decrement;
        continue;
      }
      if ('multiply' in value) {
        $mul[dbKey] = (value as any).multiply;
        continue;
      }
      if ('divide' in value) {
        $mul[dbKey] = 1 / (value as any).divide;
        continue;
      }
      if ('push' in value) {
        const v = (value as any).push;
        $push[dbKey] = Array.isArray(v)
          ? { $each: v.map((x: any) => coerceFieldValue(def, x)) }
          : coerceFieldValue(def, v);
        continue;
      }
      if ('unset' in value) {
        $unset[dbKey] = '';
        continue;
      }
      // Embedded subdoc replacement — coerce the whole shape.
      $set[dbKey] = coerceFieldValue(def, value);
      continue;
    }

    // Plain assignment.
    $set[dbKey] = coerceFieldValue(def, value);
  }

  const update: UpdateFilter<any> = {};
  if (Object.keys($set).length) (update as any).$set = $set;
  if (Object.keys($unset).length) (update as any).$unset = $unset;
  if (Object.keys($inc).length) (update as any).$inc = $inc;
  if (Object.keys($mul).length) (update as any).$mul = $mul;
  if (Object.keys($push).length) (update as any).$push = $push;
  if (Object.keys($pull).length) (update as any).$pull = $pull;
  if (Object.keys($addToSet).length) (update as any).$addToSet = $addToSet;
  return update;
}

function handleOneRelationUpdate(
  rel: RelationDef,
  value: any,
  $set: any,
  $unset: any,
) {
  if (value == null) return;
  if ((value as any).connect) {
    // Prisma's connect targets the unique key of the target. We support the
    // common case: { connect: { id } } or { connect: { <refs>: ... } }.
    const target = (value as any).connect;
    const fkValue = target[rel.refs] ?? target.id ?? target._id;
    if (fkValue !== undefined) {
      // Coerce will turn a string id into ObjectId iff this is an objectId fk.
      $set[rel.on] = coerceFieldValue(
        // We don't have access to the model here; assume the FK field is
        // either an objectId or string field. The collection caller handles
        // coercion via getFieldDef on the parent model — pass through raw.
        undefined,
        fkValue,
      );
    }
    return;
  }
  if ((value as any).disconnect === true) {
    $unset[rel.on] = '';
    return;
  }
  if ((value as any).set !== undefined) {
    $set[rel.on] = (value as any).set;
    return;
  }
  if ((value as any).create) {
    throw new Error(
      `[Database] nested create on relation '${rel.on}' is not supported. ` +
        `Create the related row first, then connect by id.`,
    );
  }
}
