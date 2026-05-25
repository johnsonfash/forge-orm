import type { OrderByEntry } from '../types';

// Build orderBy IR from a Prisma-shape orderBy arg.
//
// Accepted shapes:
//   • { field: 'asc' | 'desc' }                          — single
//   • [{ a: 'asc' }, { b: 'desc' }]                      — multi-sort
//   • { field: { sort: 'asc', nulls: 'first' | 'last' } } — SQL-style (Mongo ignores nulls)
//
// Relation-scoped order (`{ profile: { name: 'asc' } }`) is Wave 2 SQL territory;
// for now those entries are silently dropped.

export function buildOrderBy(orderBy: any): OrderByEntry[] | undefined {
  if (orderBy == null) return undefined;
  const arr = Array.isArray(orderBy) ? orderBy : [orderBy];
  const out: OrderByEntry[] = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    for (const key of Object.keys(entry)) {
      const v = (entry as any)[key];
      if (v == null) continue;
      // Plain direction string
      if (typeof v === 'string') {
        out.push({ field: key, direction: v === 'desc' ? 'desc' : 'asc' });
        continue;
      }
      // Object form: { sort, nulls } — or relation order (Wave 2)
      if (typeof v === 'object') {
        if (typeof v.sort === 'string') {
          const entry: OrderByEntry = {
            field: key,
            direction: v.sort === 'desc' ? 'desc' : 'asc',
          };
          if (v.nulls === 'first' || v.nulls === 'last') entry.nulls = v.nulls;
          out.push(entry);
        }
        // else: relation-scoped order — defer to Wave 2
      }
    }
  }
  return out.length ? out : undefined;
}
