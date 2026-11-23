import type { ProjectionPlan, RelationPlan, SelectNode, WhereTree } from './types';
import { COUNT_ALIAS_PREFIX, PARTITION_ROW_ALIAS } from './types';
import type { ModelDef } from '../schema/types';
import { schema } from '../schema';

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
// So the batched query is kept when there is no inner paging, and when there
// is, an adapter that can number rows per parent (`windowed`) still sends ONE
// query: `partitionBy` turns the page into ROW_NUMBER() OVER (PARTITION BY fk)
// on SQL and $setWindowFields on Mongo. Without that the fallback is one query
// per parent — bounded by the outer `take`, and what the caller asked for. The
// alternative, fetching every child row and slicing in memory, is one round
// trip but unbounded: a `take: 3` over ten authors with a hundred thousand
// posts each would pull a million rows to return thirty.

/**
 * Per-adapter switch for the one-query page. `unsupported` recognises the
 * error a server without window functions raises (MySQL 5.7); the loader then
 * turns `enabled` off for that handle and falls back to a query per parent.
 */
export interface WindowedPaging {
  enabled: boolean;
  unsupported?: (err: unknown) => boolean;
}

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
  windowed?: WindowedPaging;
  /**
   * Sort the batched load by the join key before the caller's order. Rows are
   * grouped per parent afterwards, so each parent's list keeps exactly the
   * caller's order either way. Mongo needs it: given `post_id $in [...]` sorted
   * by `_id`, its planner picks the `_id` index (no blocking sort) and walks
   * the whole collection, where the `post_id` index reads only the matches.
   */
  keyFirst?: boolean;
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
  const base = withJoinKeys({ ...nested, kind: 'select', model: rel.target, cardinality: 'many' } as SelectNode, rel.on);
  const paging = nestedPaging(rel);
  if (paging && opts.windowed?.enabled && pageableInOneQuery(base.node)) {
    try {
      const found = await runSelect({
        ...base.node,
        where: andWhere(nestedWhere, { kind: 'leaf', field: rel.on, op: 'in', value: refs.map(mapRef) }),
        partitionBy: rel.on,
      });
      for (const t of found) delete t[PARTITION_ROW_ALIAS];
      assignMany(rows, rel, found, keyOf);
      stripKeys(found, base.added);
      return;
    } catch (err) {
      if (!opts.windowed.unsupported?.(err)) throw err;
      opts.windowed.enabled = false;
    }
  }
  if (paging) {
    // Per-parent paging. One query each, so every parent gets its own page.
    const lists = await Promise.all(
      refs.map((ref) =>
        runSelect({
          ...base.node,
          where: andWhere(nestedWhere, { kind: 'leaf', field: rel.on, op: 'eq', value: mapRef(ref) }),
        }),
      ),
    );
    const byParent = new Map<string, Record<string, any>[]>();
    refs.forEach((ref, i) => byParent.set(keyOf(ref), lists[i]));
    for (const r of rows) r[rel.name] = byParent.get(keyOf(r[rel.refs])) ?? [];
    for (const list of lists) stripKeys(list, base.added);
    return;
  }

  const orderBy = opts.keyFirst && base.node.orderBy?.length && base.node.orderBy[0].field !== rel.on
    ? [{ field: rel.on, direction: 'asc' as const }, ...base.node.orderBy]
    : base.node.orderBy;
  const found = await runSelect({
    ...base.node,
    orderBy,
    where: andWhere(nestedWhere, { kind: 'leaf', field: rel.on, op: 'in', value: refs.map(mapRef) }),
  });
  assignMany(rows, rel, found, keyOf);
  stripKeys(found, base.added);
}

function assignMany(
  rows: Record<string, any>[],
  rel: RelationPlan,
  found: Record<string, any>[],
  keyOf: (v: unknown) => string,
): void {
  const byParent = new Map<string, Record<string, any>[]>();
  for (const t of found) {
    const k = keyOf(t[rel.on]);
    const list = byParent.get(k);
    if (list) list.push(t);
    else byParent.set(k, [t]);
  }
  for (const r of rows) r[rel.name] = byParent.get(keyOf(r[rel.refs])) ?? [];
}

// A page that one statement cannot express the same way as a query per
// parent: a distance sort (its alias is not visible inside a window), DISTINCT
// (it would dedupe across parents), or a geo filter that is refined after the
// fetch (the window would cut the page before the refinement).
function pageableInOneQuery(node: SelectNode): boolean {
  if (node.distinct?.length) return false;
  if (node.orderBy?.some((e) => e.nearTo || e.agg)) return false;
  return !hasGeoLeaf(node.where);
}

function hasGeoLeaf(w: WhereTree | undefined): boolean {
  if (!w) return false;
  switch (w.kind) {
    case 'leaf': return w.op === 'near' || w.op === 'withinPolygon';
    case 'and':
    case 'or': return w.children.some(hasGeoLeaf);
    case 'not': return hasGeoLeaf(w.child);
    case 'relation': return false;
  }
}

/**
 * Make sure an exclusive `select` still fetches the keys the loader joins on:
 * `matchField` (the column rows are grouped by) and whatever the node's own
 * relations read from these rows. Without it `include: { posts: { select:
 * { id: true } } }` grouped every post under `undefined` and each parent got
 * an empty array. Returns the keys it added, for `stripKeys` once the rows
 * have been matched.
 */
export function withJoinKeys(node: SelectNode, matchField?: string): { node: SelectNode; added: string[] } {
  const p = node.projection;
  if (!p || node.distinct?.length) return { node, added: [] };
  const model = (schema as Record<string, ModelDef<any> | undefined>)[node.model];
  const need = new Set<string>();
  if (matchField) need.add(matchField);
  for (const h of node.hydration ?? []) {
    need.add(h.kind === 'one' && model?.fields?.[h.on] != null ? h.on : h.refs);
  }
  for (const c of p.counts ?? []) {
    const r = model?.relations?.()[c];
    if (r) need.add(r.refs);
  }
  const added: string[] = [];
  let next: ProjectionPlan = p;
  if (p.exclusive && p.fields.length) {
    for (const k of need) {
      if (p.fields.includes(k) || (model && model.fields[k] == null)) continue;
      added.push(k);
    }
    if (added.length) next = { ...p, fields: [...p.fields, ...added] };
  } else if (p.omit?.length) {
    const dropped = p.omit.filter((k) => need.has(k));
    if (dropped.length) {
      added.push(...dropped);
      next = { ...p, omit: p.omit.filter((k) => !need.has(k)) };
    }
  }
  return added.length ? { node: { ...node, projection: next }, added } : { node, added };
}

export function stripKeys(rows: Record<string, any>[], keys: string[]): void {
  if (!keys.length) return;
  for (const r of rows) for (const k of keys) delete r[k];
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

  const base = withJoinKeys(
    { ...nested, kind: 'select', model: rel.target, cardinality: 'many' } as SelectNode,
    targetField,
  );
  const found = await runSelect({
    ...base.node,
    where: andWhere(
      nested.where as WhereTree | undefined,
      { kind: 'leaf', field: targetField, op: 'in', value: keys.map(mapRef) },
    ),
  });

  const byKey = new Map<string, Record<string, any>>();
  for (const t of found) byKey.set(keyOf(t[targetField]), t);
  for (const r of rows) {
    const k = r[parentField];
    r[rel.name] = k == null ? null : (byKey.get(keyOf(k)) ?? null);
  }
  stripKeys(found, base.added);
}

/**
 * Move the `__forge_count_<relation>` columns a SQL select carries for
 * `_count` into the row's `_count` object. A relation the compiler could not
 * resolve has no column and is left unset, as before.
 */
export function liftRelationCounts(rows: Record<string, any>[], counts: string[]): void {
  for (const r of rows) {
    const out: Record<string, number> = r._count ?? {};
    for (const name of counts) {
      const key = COUNT_ALIAS_PREFIX + name;
      if (!(key in r)) continue;
      out[name] = r[key] == null ? 0 : Number(r[key]);
      delete r[key];
    }
    r._count = out;
  }
}

/**
 * Whether a SQL `SELECT DISTINCT` over the selected columns already returns
 * one row per `distinct` key: true when exactly the distinct columns are
 * selected, so the executor's dedupe by key would only repeat it.
 */
export function distinctIsExact(node: SelectNode): boolean {
  const p = node.projection;
  if (!node.distinct?.length || !p?.exclusive || !p.fields.length || node.hydration?.length || p.counts?.length) return false;
  return p.fields.length === node.distinct.length && node.distinct.every((f) => p.fields.includes(f));
}
