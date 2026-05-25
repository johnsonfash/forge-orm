import { ModelDef } from '../../../schema/types';
import { appKeyToDbKey } from '../coerce';

// ============================================================================
// Projection + relation traversal.
//
// Prisma's `select` and `include` describe (a) which scalar fields come back
// and (b) which related rows to hydrate. We split the two:
//
//   • Scalar projection → Mongo `projection`. Note: when `include` is used
//     without `select`, Prisma returns ALL scalar fields plus the listed
//     relations. When `select` is used (with or without nested `select`/
//     `include`), only listed scalar fields come back.
//   • Relation hydration → handled outside this module (post-fetch batched
//     queries) by `relations.ts`. This file only emits the projection plan
//     and the list of relations to hydrate.
//
// Mixing `select` and `include` at the same level is an error in Prisma.
// We do the same.
// ============================================================================

export interface SelectionPlan {
  projection?: Record<string, 1 | 0>;
  // Map of relation name → nested args (select/include/where/orderBy/take/skip)
  relations: Record<string, RelationArgs>;
  // _count: { select: { rel: true } } — relations to count (no row fetch).
  counts: string[];
  // True when caller used `select`. Affects whether ALL scalars are returned
  // by default or only listed ones.
  isSelect: boolean;
}

export interface RelationArgs {
  select?: any;
  include?: any;
  where?: any;
  orderBy?: any;
  take?: number;
  skip?: number;
}

export function planSelection(
  model: ModelDef<any>,
  args: { select?: any; include?: any },
): SelectionPlan {
  if (args.select && args.include) {
    throw new Error('[Database] cannot use `select` and `include` at the same level');
  }

  const relations = model.relations();
  const out: SelectionPlan = {
    relations: {},
    counts: [],
    isSelect: !!args.select,
  };

  // ─── include path ────────────────────────────────────────────────
  if (args.include) {
    // No projection — return all scalars.
    for (const key of Object.keys(args.include)) {
      const v = args.include[key];
      if (v === false || v == null) continue;
      if (key === '_count') {
        if (v === true) {
          // include all relations as counts? Prisma requires a select map.
          continue;
        }
        if (v && typeof v === 'object' && v.select) {
          for (const rk of Object.keys(v.select)) {
            if (v.select[rk]) out.counts.push(rk);
          }
        }
        continue;
      }
      if (!relations[key]) continue;
      out.relations[key] = v === true ? {} : (v as RelationArgs);
    }
    return out;
  }

  // ─── select path ─────────────────────────────────────────────────
  if (args.select) {
    const projection: Record<string, 1 | 0> = {};
    let hasScalarKey = false;
    for (const key of Object.keys(args.select)) {
      const v = args.select[key];
      if (v === false || v == null) continue;
      if (key === '_count') {
        if (v && typeof v === 'object' && v.select) {
          for (const rk of Object.keys(v.select)) {
            if (v.select[rk]) out.counts.push(rk);
          }
        }
        continue;
      }
      if (relations[key]) {
        out.relations[key] = v === true ? {} : (v as RelationArgs);
        continue;
      }
      // Scalar projection.
      projection[appKeyToDbKey(key)] = 1;
      hasScalarKey = true;
    }
    // Always include _id so we can hydrate / round-trip; we'll strip if the
    // caller didn't ask for `id`.
    if (hasScalarKey) projection._id = 1;
    if (hasScalarKey) out.projection = projection;
    return out;
  }

  // No select, no include — full scalars, no relations.
  return out;
}

// After decoding, prune fields the caller didn't ask for via select.
export function pruneRowToSelect(row: any, select: any): any {
  if (!select) return row;
  const out: any = {};
  for (const k of Object.keys(select)) {
    const v = select[k];
    if (v === false || v == null) continue;
    if (row[k] !== undefined) out[k] = row[k];
  }
  return out;
}
