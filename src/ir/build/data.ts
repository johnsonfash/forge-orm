import type { ModelDef } from '../../schema/types';
import type { UpdateNode } from '../types';

// Build the UPDATE half of an UpdateNode IR (set/increment/multiply/push/unset
// fragments) from a Prisma-shape `data` object.
//
// INVARIANT: the wrapper splits nested writes BEFORE the IR is built, so by the
// time we see `data` it contains only scalar fields and owning-side FK
// assignments — relation FK rewrites are NOT done here.

export interface UpdateDataFragment {
  set?: Record<string, any>;
  increment?: Record<string, number>;
  multiply?: Record<string, number>;
  push?: Record<string, any>;
  unset?: string[];
}

const UPDATE_OPS = ['set', 'increment', 'decrement', 'multiply', 'divide', 'push', 'unset'] as const;
const NUMERIC_OPS = new Set(['increment', 'decrement', 'multiply', 'divide']);

// Kinds whose values are never plain objects, so an object in update data
// must be an operator object. json / embed / arrays / geoPoint / vector take
// object (or array) values directly and are exempt.
const SCALAR_KINDS = new Set([
  'id', 'objectId', 'string', 'text', 'int', 'float', 'decimal',
  'uuid', 'bigint', 'bool', 'dateTime', 'enum',
]);
const NUMERIC_KINDS = new Set(['int', 'float', 'decimal', 'bigint']);

export function buildUpdateData(model: ModelDef<any>, data: any): UpdateDataFragment {
  const out: UpdateDataFragment = {};
  if (!data || typeof data !== 'object') return out;
  for (const key of Object.keys(data)) {
    const v = data[key];
    if (v === undefined) continue;

    // Atomic op forms: { x: { set | increment | decrement | multiply | divide | push | unset } }
    if (
      v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) &&
      (v as any)._bsontype === undefined && (v as any).__forge === undefined
    ) {
      const kind = (model.fields?.[key] as any)?.kind;
      const scalar = kind !== undefined && SCALAR_KINDS.has(kind);
      const opKeys = UPDATE_OPS.filter((op) => op in v);

      if (scalar) {
        // On a scalar column an object value can only mean an operator, so
        // hold it to that. The old behaviour wrote unrecognised objects
        // straight through $set — a typo like { incrment: 5 } replaced an
        // int with the object `{ incrment: 5 }`. Silent data corruption.
        const strayKeys = Object.keys(v).filter((k) => !(UPDATE_OPS as readonly string[]).includes(k));
        if (opKeys.length === 0 || strayKeys.length > 0) {
          throw new Error(
            `[forge] invalid update for '${model.collection}.${key}': object ` +
            `{ ${Object.keys(v).join(', ')} } is not a valid operator form for a ` +
            `${kind} column. Use one of: ${UPDATE_OPS.join(', ')} — or assign the value directly.`,
          );
        }
        if (opKeys.length > 1) {
          throw new Error(
            `[forge] ambiguous update for '${model.collection}.${key}': ` +
            `{ ${opKeys.join(', ')} } — use exactly one operator per field.`,
          );
        }
        const op = opKeys[0];
        if (NUMERIC_OPS.has(op) && !NUMERIC_KINDS.has(kind)) {
          throw new Error(
            `[forge] '${op}' is only valid on numeric columns — ` +
            `'${model.collection}.${key}' is ${kind}.`,
          );
        }
      }

      if ('set' in v) {
        (out.set ??= {})[key] = v.set;
        continue;
      }
      if ('increment' in v) {
        (out.increment ??= {})[key] = Number(v.increment);
        continue;
      }
      if ('decrement' in v) {
        (out.increment ??= {})[key] = -Number(v.decrement);
        continue;
      }
      if ('multiply' in v) {
        (out.multiply ??= {})[key] = Number(v.multiply);
        continue;
      }
      if ('divide' in v) {
        // 1 / x — SQL adapters native-divide; Mongo $mul with reciprocal.
        (out.multiply ??= {})[key] = 1 / Number(v.divide);
        continue;
      }
      if ('push' in v) {
        (out.push ??= {})[key] = v.push;
        continue;
      }
      if ('unset' in v && v.unset === true) {
        (out.unset ??= []).push(key);
        continue;
      }
    }

    // Bare assignment (covers value === null too, used to clear an FK).
    (out.set ??= {})[key] = v;
  }
  return out;
}
