import type { ModelDef } from '../../schema/types';
import type { UpdateNode } from '../types';
import { isBytesInput } from '../../bytes';

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
  divide?: Record<string, number>;
  /** Clamp upwards: write the value only when it exceeds what is stored. */
  max?: Record<string, number>;
  /** Clamp downwards. */
  min?: Record<string, number>;
  push?: Record<string, any>;
  /** Append only when the value is not already in the array. */
  addToSet?: Record<string, any>;
  /** Remove every occurrence of the value from the array. */
  pull?: Record<string, any>;
  unset?: string[];
}

const UPDATE_OPS = [
  'set', 'increment', 'decrement', 'multiply', 'divide', 'max', 'min',
  'push', 'addToSet', 'pull', 'unset',
] as const;
const NUMERIC_OPS = new Set(['increment', 'decrement', 'multiply', 'divide', 'max', 'min']);
// Ops that only mean something on a list column.
const ARRAY_OPS = new Set(['push', 'addToSet', 'pull']);
const ARRAY_KINDS = new Set(['stringArray', 'intArray', 'embedMany', 'json']);

// Kinds whose values are never plain objects, so an object in update data
// must be an operator object. json / embed / arrays / geoPoint / vector take
// object (or array) values directly and are exempt.
const SCALAR_KINDS = new Set([
  'id', 'objectId', 'string', 'text', 'int', 'float', 'decimal',
  'uuid', 'bigint', 'bool', 'dateTime', 'enum', 'bytes',
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
      // A typed array is an object, and `Uint8Array.prototype.set` EXISTS —
      // so `'set' in v` was true for every `f.bytes()` value and the IR took
      // the operator branch, storing the `set` METHOD as the column value.
      // The driver then rejected it ("can only bind numbers, strings,
      // bigints, buffers, and null"), so a plain bytes assignment through
      // `update` could not work at all.
      !isBytesInput(v) &&
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

      // An array op on a scalar column is always a mistake, and the scalar
      // guard above cannot catch it (push/addToSet/pull ARE valid operators,
      // just not for this column).
      const arrayOpUsed = (Array.from(ARRAY_OPS) as string[]).find((op) => op in v);
      if (arrayOpUsed && kind !== undefined && !ARRAY_KINDS.has(kind)) {
        throw new Error(
          `[forge] '${arrayOpUsed}' is only valid on list columns — ` +
          `'${model.collection}.${key}' is ${kind}.`,
        );
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
        // Carried as its own op. Folding it into `multiply: 1/x` here — as
        // this did before 2.18.0 — threw the division away before any
        // adapter could see it: `divide: 3` became `* 0.3333333333333333`,
        // so an exact `decimal` money column drifted on every update and an
        // `int` column rounded. Every SQL dialect divides natively; Mongo
        // gets a real $divide via a pipeline update.
        const by = Number(v.divide);
        if (by === 0) {
          throw new Error(`[forge] update.${key}.divide: cannot divide by zero`);
        }
        (out.divide ??= {})[key] = by;
        continue;
      }
      if ('max' in v) {
        (out.max ??= {})[key] = Number(v.max);
        continue;
      }
      if ('min' in v) {
        (out.min ??= {})[key] = Number(v.min);
        continue;
      }
      if ('push' in v) {
        (out.push ??= {})[key] = v.push;
        continue;
      }
      if ('addToSet' in v) {
        (out.addToSet ??= {})[key] = v.addToSet;
        continue;
      }
      if ('pull' in v) {
        (out.pull ??= {})[key] = v.pull;
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
