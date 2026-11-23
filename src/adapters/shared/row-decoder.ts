import type { ModelDef } from '../../schema/types';
import { decodeWideIntegers } from './wide-int';

// Per-model row decoding, worked out once. The old decoders walked every key
// of every row, looked each up in model.fields, switched on its kind, and
// copied the row into a new object, so a 10k-row read did 100k lookups to
// convert the two or three columns that need it. A plan lists only those
// columns, and a driver row (always a fresh object the caller owns) is
// converted in place.

export type Convert = (v: any) => any;
type Plan = { steps: Array<[string, Convert]>; wide: boolean };

export function rowDecoder(
  cache: WeakMap<object, Plan>,
  model: ModelDef<any>,
  convertFor: (kind: string, field: any) => Convert | null,
): (row: any) => any {
  let plan = cache.get(model);
  if (!plan) {
    const steps: Array<[string, Convert]> = [];
    let wide = false;
    for (const [name, fd] of Object.entries(model.fields ?? {})) {
      const f = fd as any;
      const c = convertFor(f.kind, f);
      if (c) steps.push([name, c]);
      if ((f.kind === 'id' && f.idType === 'bigserial') || f.kind === 'bigint') wide = true;
    }
    plan = { steps, wide };
    cache.set(model, plan);
  }
  const { steps, wide } = plan;
  return (row: any) => {
    if (!row || typeof row !== 'object') return row;
    for (let i = 0; i < steps.length; i++) {
      const [k, c] = steps[i];
      const v = row[k];
      if (v != null) row[k] = c(v);
    }
    return wide ? decodeWideIntegers(model, row) : row;
  };
}

export function parseJsonText(v: any): any {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}
