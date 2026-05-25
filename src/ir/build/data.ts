import type { ModelDef } from '../../schema/types';
import type { UpdateNode } from '../types';

// Build the UPDATE half of an UpdateNode IR — i.e. the set/increment/multiply/
// push/unset fragments — from a Prisma-shape `data` object.
//
// Owning-side relation FK rewrites (`{ rel: { connect: { id } } }` → set FK)
// are NOT done here; the wrapper splits nested writes BEFORE the IR is built,
// so by the time we see `data` it should contain only scalar fields and
// owning-side FK assignments.

export interface UpdateDataFragment {
  set?: Record<string, any>;
  increment?: Record<string, number>;
  multiply?: Record<string, number>;
  push?: Record<string, any>;
  unset?: string[];
}

export function buildUpdateData(_model: ModelDef<any>, data: any): UpdateDataFragment {
  const out: UpdateDataFragment = {};
  if (!data || typeof data !== 'object') return out;
  for (const key of Object.keys(data)) {
    const v = data[key];
    if (v === undefined) continue;

    // Atomic op forms: { x: { set | increment | decrement | multiply | divide | push | unset } }
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
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
