import type { OrderByEntry } from '../types';

// Build orderBy IR from a Prisma-shape orderBy arg.
//
// Accepted shapes:
//   • { field: 'asc' | 'desc' }                          — single
//   • [{ a: 'asc' }, { b: 'desc' }]                      — multi-sort
//   • { field: { sort: 'asc', nulls: 'first' | 'last' } } — SQL-style (Mongo ignores nulls)
//
// Relation-scoped order (`{ profile: { name: 'asc' } }`) is not yet supported;
// those entries are silently dropped.

export function buildOrderBy(orderBy: any): OrderByEntry[] | undefined {
  if (orderBy == null) return undefined;
  const arr = Array.isArray(orderBy) ? orderBy : [orderBy];
  const out: OrderByEntry[] = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    for (const key of Object.keys(entry)) {
      const v = (entry as any)[key];
      if (v == null) continue;
      if (typeof v === 'string') {
        out.push({ field: key, direction: v === 'desc' ? 'desc' : 'asc' });
        continue;
      }
      // Object form: { sort, nulls } — or geo nearTo — or relation order.
      if (typeof v === 'object') {
        // Geo near-to ordering: `{ location: { nearTo: { lng, lat } } }`.
        // Vector near-to ordering: `{ embedding: { nearTo: [0.1, 0.2, ...] } }`.
        // Both produce a synthetic `_distanceMeters` (geo) or `_distance` (vector) field.
        if (v.nearTo) {
          if (Array.isArray(v.nearTo)) {
            // Vector form — store as { vector } so the OrderByEntry stays a
            // single shape; the SELECT compiler resolves by field kind.
            out.push({
              field: key,
              direction: v.direction === 'desc' ? 'desc' : 'asc',
              nearTo: { vector: v.nearTo } as any,
            });
            continue;
          }
          if (typeof v.nearTo === 'object'
              && typeof v.nearTo.lng === 'number' && typeof v.nearTo.lat === 'number') {
            out.push({
              field: key,
              direction: v.direction === 'desc' ? 'desc' : 'asc',
              nearTo: { lng: v.nearTo.lng, lat: v.nearTo.lat },
            });
            continue;
          }
        }
        if (typeof v.sort === 'string') {
          const entry: OrderByEntry = {
            field: key,
            direction: v.sort === 'desc' ? 'desc' : 'asc',
          };
          if (v.nulls === 'first' || v.nulls === 'last') entry.nulls = v.nulls;
          out.push(entry);
        }
        // else: relation-scoped order — dropped (see header).
      }
    }
  }
  return out.length ? out : undefined;
}
