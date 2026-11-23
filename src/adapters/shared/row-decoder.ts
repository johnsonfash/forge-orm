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

const two = (s: string, i: number) => (s.charCodeAt(i) - 48) * 10 + (s.charCodeAt(i + 1) - 48);
const isDigits = (s: string, idx: number[]) => idx.every((i) => { const c = s.charCodeAt(i); return c >= 48 && c <= 57; });
const ISO_DIGITS = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22];

/**
 * `new Date(text)` for the exact shape toISOString writes (`2025-01-01T00:00:00.000Z`),
 * which is how SQLite stores every forge timestamp: built from the digits, about
 * twice as fast as the general parser. Anything else (another shape, an
 * impossible date) goes to `new Date`, so the result is always the same.
 */
export function parseIsoDate(v: any): any {
  if (typeof v !== 'string') return v;
  if (v.length === 24 && v.charCodeAt(23) === 90 && v.charCodeAt(10) === 84 && v.charCodeAt(4) === 45
    && v.charCodeAt(7) === 45 && v.charCodeAt(13) === 58 && v.charCodeAt(16) === 58 && v.charCodeAt(19) === 46
    && isDigits(v, ISO_DIGITS)) {
    const y = two(v, 0) * 100 + two(v, 2);
    const mo = two(v, 5), d = two(v, 8), h = two(v, 11), mi = two(v, 14), se = two(v, 17);
    // Date.UTC reads a year below 100 as 19xx; those take the general parser.
    if (y >= 100 && mo >= 1 && mo <= 12 && d >= 1 && h < 24 && mi < 60 && se < 60) {
      const t = new Date(Date.UTC(y, mo - 1, d, h, mi, se, (v.charCodeAt(20) - 48) * 100 + two(v, 21)));
      if (t.getUTCDate() === d) return t;
    }
  }
  return new Date(v);
}
