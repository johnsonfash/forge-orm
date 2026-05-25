import { Sort } from 'mongodb';
import { appKeyToDbKey } from '../coerce';

// Prisma orderBy → Mongo sort.
//   • { x: 'desc' }                  → { x: -1 }
//   • { x: 'asc' }                   → { x: 1 }
//   • [{ a: 'desc' }, { b: 'asc' }]  → ordered Map preserving insertion order
//   • { x: { sort: 'desc' } }        → same as { x: 'desc' } (Prisma form for
//                                       case-insensitive etc., we treat as plain)
// `id` is remapped to `_id`.

export function translateOrderBy(orderBy: any): Sort | undefined {
  if (!orderBy) return undefined;
  const arr = Array.isArray(orderBy) ? orderBy : [orderBy];
  const out = new Map<string, 1 | -1>();
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    for (const key of Object.keys(entry)) {
      const dbKey = appKeyToDbKey(key);
      const v = (entry as any)[key];
      const dir = typeof v === 'object' && v ? v.sort : v;
      out.set(dbKey, dir === 'desc' ? -1 : 1);
    }
  }
  if (out.size === 0) return undefined;
  return Array.from(out.entries()) as Sort;
}
