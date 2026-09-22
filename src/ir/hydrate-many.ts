import type { RelationPlan, SelectNode, WhereTree } from './types';

// Shared "load the many-side of a relation" step, used by every adapter.
//
// It exists because the batched form has one wrong case, and six adapters
// each had their own copy of it. The batched form is:
//
//   SELECT * FROM posts WHERE author_id IN (…10 authors…) LIMIT 3
//
// which is correct for `include: { posts: true }` — one round trip instead of
// one query per parent — but wrong the moment the caller pages the inner
// list. `take: 3` is per parent, not per batch, so
//
//   user.findMany({ take: 10, include: { posts: { take: 3 } } })
//
// returned 3 posts TOTAL and gave the other nine users an empty array. The
// same applied to `skip`, which skipped rows of the combined result.
//
// So: keep the single batched query when there is no inner paging, and fall
// back to one query per parent when there is. That costs N queries for N
// parents — bounded by the outer `take` — and it is what the caller asked
// for. The alternative, fetching every child row and slicing in memory, is
// one round trip but unbounded: a `take: 3` over ten authors with a hundred
// thousand posts each would pull a million rows to return thirty.

export function nestedPaging(rel: RelationPlan): { limit?: number; offset?: number } | null {
  const n = rel.nested as { limit?: number; offset?: number } | undefined;
  if (!n) return null;
  if (n.limit == null && n.offset == null) return null;
  return { limit: n.limit ?? undefined, offset: n.offset ?? undefined };
}

function andWhere(nested: WhereTree | undefined, fk: WhereTree): WhereTree {
  return nested ? { kind: 'and', children: [nested, fk] } : fk;
}

export interface HydrateManyOpts {
  rows: Record<string, any>[];
  rel: RelationPlan;
  /** Run one compiled SelectNode and hand back its rows. */
  runSelect: (node: SelectNode) => Promise<Record<string, any>[]>;
  /** Stringify a key value so Mongo ObjectIds and SQL ints group alike. */
  keyOf: (v: unknown) => string;
  /**
   * Transform a parent's key value before it goes into the child's filter.
   * Mongo uses it to coerce an id string to an ObjectId — a filter holding
   * the string would match nothing.
   */
  mapRef?: (v: unknown) => unknown;
}

export async function hydrateManyRelation(opts: HydrateManyOpts): Promise<void> {
  const { rows, rel, runSelect, keyOf } = opts;
  const nested = (rel.nested ?? {}) as Omit<SelectNode, 'kind' | 'model' | 'cardinality'>;
  const nestedWhere = nested.where as WhereTree | undefined;

  const refs = unique(rows.map((r) => r[rel.refs]).filter((v) => v != null));
  if (refs.length === 0) {
    for (const r of rows) r[rel.name] = [];
    return;
  }

  const mapRef = opts.mapRef ?? ((v: unknown) => v);
  const paging = nestedPaging(rel);
  if (paging) {
    // Per-parent paging. One query each, so every parent gets its own page.
    const lists = await Promise.all(
      refs.map((ref) =>
        runSelect({
          ...nested,
          kind: 'select',
          model: rel.target,
          cardinality: 'many',
          where: andWhere(nestedWhere, { kind: 'leaf', field: rel.on, op: 'eq', value: mapRef(ref) }),
        } as SelectNode),
      ),
    );
    const byParent = new Map<string, Record<string, any>[]>();
    refs.forEach((ref, i) => byParent.set(keyOf(ref), lists[i]));
    for (const r of rows) r[rel.name] = byParent.get(keyOf(r[rel.refs])) ?? [];
    return;
  }

  const found = await runSelect({
    ...nested,
    kind: 'select',
    model: rel.target,
    cardinality: 'many',
    where: andWhere(nestedWhere, { kind: 'leaf', field: rel.on, op: 'in', value: refs.map(mapRef) }),
  } as SelectNode);

  const byParent = new Map<string, Record<string, any>[]>();
  for (const t of found) {
    const k = keyOf(t[rel.on]);
    const list = byParent.get(k);
    if (list) list.push(t);
    else byParent.set(k, [t]);
  }
  for (const r of rows) r[rel.name] = byParent.get(keyOf(r[rel.refs])) ?? [];
}

function unique<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}


export interface HydrateOneOpts {
  rows: Record<string, any>[];
  rel: RelationPlan;
  /** The field on the PARENT holding the value to match. */
  parentField: string;
  /** The field on the TARGET to match it against. */
  targetField: string;
  runSelect: (node: SelectNode) => Promise<Record<string, any>[]>;
  keyOf: (v: unknown) => string;
  mapRef?: (v: unknown) => unknown;
}

/**
 * The to-one side of a relation, for both directions:
 *   owning  — the parent holds the FK, match target.<refs> against parent.<on>
 *   inverse — the target holds the FK, match target.<on> against parent.<refs>
 *
 * Centralised for the same reason the many side was, and to fix the same class
 * of bug in the opposite direction. Every adapter built the sub-node as
 *
 *   { where: <the FK filter>, ...(rel.nested ?? {}) }
 *
 * with `nested` spread LAST, so a caller's `include: { author: { where: … } }`
 * REPLACED the FK filter and the sub-select scanned the whole target table.
 * Results still came out right — the rows are mapped by key afterwards — so
 * the only symptom was reading every row of a table to return one per parent.
 *
 * Mongo had the mirror of it: `mergeNested(...)` then `where: <FK>` last,
 * which DROPPED the caller's nested where instead, so the filter silently did
 * not apply at all.
 */
export async function hydrateOneRelation(opts: HydrateOneOpts): Promise<void> {
  const { rows, rel, parentField, targetField, runSelect, keyOf } = opts;
  const mapRef = opts.mapRef ?? ((v: unknown) => v);
  const nested = (rel.nested ?? {}) as Omit<SelectNode, 'kind' | 'model' | 'cardinality'>;

  const keys = unique(rows.map((r) => r[parentField]).filter((v) => v != null));
  if (keys.length === 0) {
    for (const r of rows) r[rel.name] = null;
    return;
  }

  const found = await runSelect({
    ...nested,
    kind: 'select',
    model: rel.target,
    cardinality: 'many',
    where: andWhere(
      nested.where as WhereTree | undefined,
      { kind: 'leaf', field: targetField, op: 'in', value: keys.map(mapRef) },
    ),
  } as SelectNode);

  const byKey = new Map<string, Record<string, any>>();
  for (const t of found) byKey.set(keyOf(t[targetField]), t);
  for (const r of rows) {
    const k = r[parentField];
    r[rel.name] = k == null ? null : (byKey.get(keyOf(k)) ?? null);
  }
}
